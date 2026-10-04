import type { EvidenceGap, ReleaseIdentity } from "../contracts.ts";
import type { ResolvedResourcePlannerInput, ResourcePlan, ResourcePlanObjective, ResourceStageCandidate } from "../resource-plan-contract.ts";
import { memoizeNormalResourceCycles } from "../resource-normal-cache.ts";
import { resolveFixedNormalResourceSummary } from "./resource-cycle-summary.ts";

export interface ResourcePlayTime {
  seconds: number;
  downtimeSeconds: number;
  source: "observed-duration" | "explicit-scenario";
  reference: string;
}
export interface ResourceCycleTiming extends ReleaseIdentity {
  sourceId: string;
  /** Canonical chart keys, including challenge:<wrapper>:<difficulty>. */
  normal: Readonly<Record<string, ResourcePlayTime>>;
  challenge: Readonly<Record<string, ResourcePlayTime>>;
}
export interface ResourceTimePlan extends ResourcePlan {
  expectedElapsedSeconds: number;
  rewardPerSecond: number;
  timing: { normal?: ResourcePlayTime; challenge?: ResourcePlayTime };
}
export interface ResourceTimePlans {
  best: ResourceTimePlan | null;
  top3: { normal: ResourceTimePlan[]; challenge: ResourceTimePlan[] };
  /** Known cycle rewards remain available when time cannot be resolved. */
  rewardOnlyBest: ResourcePlan | null;
  status: "proven" | "candidate" | "unavailable";
  gaps: EvidenceGap[];
  pairsEvaluated: number;
}
export interface ResourceTimeResult {
  schema: "haneoka-resource-time-result-v1";
  byObjective: Partial<Record<ResourcePlanObjective, ResourceTimePlans>>;
  completeness: "exhaustive" | "budget-limited" | "cancelled" | "unavailable";
  elapsedMs: number;
  pairsEvaluated: number;
  definition: "expected-cycle-reward-divided-by-expected-cycle-seconds";
  scope: "fixed-normal-challenge-pair-requested-domain";
  assumptions: string[];
}
export interface ResourceTimeControls {
  cancelled?: () => boolean;
  now?: () => number;
  yield?: () => Promise<void>;
  progress?: (value: { pairsEvaluated: number; totalPairs: number }) => void;
}
const integer = (value: unknown): value is number => typeof value === "number" &&
  Number.isSafeInteger(value) && value >= 0 && value <= 0x7fffffff;
const gap = (code: string, source: string): EvidenceGap => ({ code, source });
const field = (objective: ResourcePlanObjective) => objective === "event-points" ? "eventPoints" : "eventItems";
const key = (plan: ResourcePlan) => JSON.stringify([plan.normal.key, plan.challenge.key]);
const same = (a: (ReleaseIdentity & { sourceId?: string }) | undefined, b: ReleaseIdentity & { sourceId?: string }) =>
  !!a && a.server === b.server && a.releaseId === b.releaseId && !!a.sourceId && a.sourceId === b.sourceId;
const time = (value: ResourcePlayTime | undefined) => value && Number.isFinite(value.seconds) && value.seconds > 0 &&
  Number.isFinite(value.downtimeSeconds) && value.downtimeSeconds >= 0 &&
  ["observed-duration", "explicit-scenario"].includes(value.source) &&
  typeof value.reference === "string" && value.reference.length > 0 && value.reference.length <= 1024 &&
  Number.isFinite(value.seconds + value.downtimeSeconds) ? value.seconds + value.downtimeSeconds : null;

/** Rank every fixed pair by E[reward]/E[elapsed], inside the joint search.
 * Complete CP laws determine E[challenge plays]; durations are explicit fixed
 * per-play time scenarios. This does not model adaptive actions or a time cap. */
export async function optimizeFixedResourceTime(input: ResolvedResourcePlannerInput, timing: ResourceCycleTiming | undefined,
  controls: ResourceTimeControls = {}): Promise<ResourceTimeResult> {
  const request = structuredClone(input), clock = structuredClone(timing);
  const now = controls.now ?? (() => performance.now()), started = now(), elapsed = () => Math.max(0, now() - started);
  const budget = request.budget, parameters = request.parameters;
  if (request.schema !== "haneoka-resolved-resource-plan-v1" || !request.sourceId ||
    !integer(request.eventId) || request.eventId < 1 || !request.objectives.length ||
    new Set(request.objectives).size !== request.objectives.length ||
    request.objectives.some(value => value !== "event-points" && value !== "event-items") ||
    !["nominal-mean", "worst-ap", "best-ap"].includes(request.skillOrderCriterion) ||
    !integer(parameters.boostBudget) || parameters.boostBudget > 2000 ||
    !integer(parameters.boostPerNormalPlay) || parameters.boostPerNormalPlay < 1 ||
    !integer(parameters.initialChallengePoints) || !integer(parameters.challengePointCost) || parameters.challengePointCost < 1 ||
    !integer(budget.maxPairs) || budget.maxPairs < 1 || budget.maxPairs > 1000000 ||
    !integer(budget.maxMilliseconds) || budget.maxMilliseconds < 1 || budget.maxMilliseconds > 60000 ||
    !integer(budget.maxCycleStates) || budget.maxCycleStates < 1 || budget.maxCycleStates > 100000 ||
    !integer(budget.maxCycleTransitions) || budget.maxCycleTransitions < 1 || budget.maxCycleTransitions > 2000000 ||
    request.normal.kind !== "normal" || request.challenge.kind !== "challenge" ||
    !Array.isArray(request.normal.candidates) || !Array.isArray(request.challenge.candidates) ||
    request.normal.candidates.length > 10000 || request.challenge.candidates.length > 10000)
    throw new RangeError("resource-time-input-unresolved");
  const result: ResourceTimeResult = { schema: "haneoka-resource-time-result-v1", byObjective: {},
    completeness: "unavailable", elapsedMs: 0, pairsEvaluated: 0,
    definition: "expected-cycle-reward-divided-by-expected-cycle-seconds", scope: "fixed-normal-challenge-pair-requested-domain",
    assumptions: ["fixed-normal-and-challenge-pairs", "independent-whole-play-reward-laws",
      "explicit-fixed-per-play-time-scenario", "initial-CP-funded-challenge-plays-included-in-time",
      "resource-cycle-no-cap-expiry-regeneration-or-time-limit"] };
  const summaries = memoizeNormalResourceCycles(resolveFixedNormalResourceSummary);
  const yieldWork = controls.yield ?? (() => new Promise<void>(resolve => setTimeout(resolve, 0)));
  let stopped: "cancelled" | "budget-limited" | null = null, attempts = 0;
  const interrupt = (limit = false) => {
    if (controls.cancelled?.()) stopped = "cancelled";
    else if (elapsed() >= budget.maxMilliseconds || (limit && attempts >= budget.maxPairs)) stopped = "budget-limited";
    return stopped !== null;
  };
  const validate = (candidate: ResourceStageCandidate, kind: "normal" | "challenge", objective: ResourcePlanObjective) => {
    const issues = [...candidate.gaps, ...(candidate.metricGaps[objective] ?? []), ...(candidate.metricGaps["challenge-points"] ?? [])];
    const assignment = candidate.assignment;
    if (!same(candidate, request) || candidate.kind !== kind || candidate.eventId !== request.eventId ||
      candidate.consumedCount !== (kind === "normal" ? parameters.boostPerNormalPlay : parameters.challengePointCost) ||
      candidate.skillOrderCriterion !== request.skillOrderCriterion || !candidate.completeLaw || !candidate.key ||
      !integer(candidate.songId) || candidate.songId < 1 || !integer(candidate.difficulty) || !integer(candidate.power) ||
      candidate.songKey !== (kind === "normal" ? `${candidate.songId}:${candidate.difficulty}` : `challenge:${candidate.challengeMusicId}:${candidate.difficulty}`) ||
      (kind === "challenge" && (!integer(candidate.challengeMusicId) || candidate.challengeMusicId! < 1)) ||
      assignment.memberInstanceIds.length !== 5 || assignment.snapshotInstanceIds.length !== 5 ||
      new Set(assignment.memberInstanceIds).size !== 5 || assignment.memberInstanceIds.some(id => !id) ||
      !assignment.memberInstanceIds.includes(assignment.leaderInstanceId) ||
      new Set(assignment.snapshotInstanceIds.filter(id => id !== null)).size !== assignment.snapshotInstanceIds.filter(id => id !== null).length ||
      assignment.snapshotInstanceIds.some(id => id !== null && !id) ||
      !candidate.outcomes.length || candidate.outcomes.length > 10000 ||
      candidate.outcomes.some(row => !Number.isFinite(row.probability) || row.probability < 0 ||
        (row.probability > 0 && (!integer(row[field(objective)]) || !integer(row.challengePoints)))) ||
      Math.abs(candidate.outcomes.reduce((sum, row) => sum + row.probability, 0) - 1) > 1e-12)
      issues.push(gap("resource-time-complete-stage-law-unresolved", candidate.key));
    if (objective === "event-items" && (!request.itemResource || !candidate.itemResource ||
      !integer(request.itemResource.type) || !integer(request.itemResource.id) ||
      request.itemResource.type !== candidate.itemResource.type || request.itemResource.id !== candidate.itemResource.id))
      issues.push(gap("resource-stage-item-identity-mismatch", candidate.key));
    if (kind === "challenge" && candidate.outcomes.some(row => row.probability > 0 && row.challengePoints !== 0))
      issues.push(gap("resource-cycle-challenge-reinvestment-unresolved", candidate.key));
    return issues;
  };
  const expected = (candidate: ResourceStageCandidate, objective: ResourcePlanObjective) => candidate.outcomes
    .filter(row => row.probability > 0).reduce((sum, row) => sum + row[field(objective)]! * row.probability, 0);
  const maximum = (candidate: ResourceStageCandidate, objective: ResourcePlanObjective) =>
    Math.max(...candidate.outcomes.filter(row => row.probability > 0).map(row => row[field(objective)]!));
  for (const objective of request.objectives) {
    const issues = new Map<string, EvidenceGap>();
    const add = (rows: readonly EvidenceGap[]) => rows.forEach(row => issues.set(`${row.code}:${row.source}`, row));
    add(request.normal.gaps); add(request.challenge.gaps);
    const output: ResourceTimePlans = { best: null, rewardOnlyBest: null, top3: { normal: [], challenge: [] },
      status: "unavailable", gaps: [], pairsEvaluated: 0 };
    result.byObjective[objective] = output;
    const normal: ResourceStageCandidate[] = request.normal.candidates.filter((row: ResourceStageCandidate) =>
      { const gaps = validate(row, "normal", objective); add(gaps); return !gaps.length; });
    const challenge: ResourceStageCandidate[] = request.challenge.candidates.filter((row: ResourceStageCandidate) =>
      { const gaps = validate(row, "challenge", objective); add(gaps); return !gaps.length; });
    const ranked = { normal: new Map<number, ResourceTimePlan>(), challenge: new Map<number, ResourceTimePlan>() };
    const compare = (a: ResourceTimePlan, b: ResourceTimePlan) => b.rewardPerSecond - a.rewardPerSecond ||
      b.totals[field(objective)]! - a.totals[field(objective)]! || key(a).localeCompare(key(b), "en");
    for (const n of normal) {
      if (interrupt(true)) break;
      const normalLaw = n.outcomes.filter(row => row.probability > 0).map(row =>
        ({ probability: row.probability, challengePoints: row.challengePoints!, eventPoints: 0, eventItems: 0 }));
      const cycle = await summaries.prepare(n, { normal: normalLaw, ...parameters,
        budget: { maxStates: budget.maxCycleStates, maxTransitions: budget.maxCycleTransitions } },
      { cancelled: () => Boolean(controls.cancelled?.()), expired: () => elapsed() >= budget.maxMilliseconds,
        yield: yieldWork, progress: () => {} });
      if (!cycle.value) { add(cycle.gaps); interrupt();
        if (cycle.gaps.some(row => row.code.endsWith("state-budget") || row.code.endsWith("transition-budget"))) stopped = "budget-limited";
        continue; }
      const summary = cycle.value;
      for (const ch of challenge) {
        if (interrupt(true)) break;
        attempts++;
        if (summary.normalPlays * maximum(n, objective) +
          Math.floor((parameters.initialChallengePoints + summary.normalPlays * Math.max(...normalLaw.map(row => row.challengePoints))) / parameters.challengePointCost) *
          maximum(ch, objective) > Number.MAX_SAFE_INTEGER) { add([gap("resource-cycle-total-domain-unresolved", `${n.key}/${ch.key}`)]); continue; }
        const reward = summary.normalPlays * expected(n, objective) + summary.expectedChallengePlays * expected(ch, objective);
        const secondary: ResourcePlanObjective = objective === "event-points" ? "event-items" : "event-points";
        const secondaryKnown = !validate(n, "normal", secondary).length && !validate(ch, "challenge", secondary).length &&
          summary.normalPlays * maximum(n, secondary) +
          Math.floor((parameters.initialChallengePoints + summary.normalPlays * Math.max(...normalLaw.map(row => row.challengePoints))) / parameters.challengePointCost) *
          maximum(ch, secondary) <= Number.MAX_SAFE_INTEGER;
        const secondaryReward = secondaryKnown ? summary.normalPlays * expected(n, secondary) +
          summary.expectedChallengePlays * expected(ch, secondary) : null;
        const { transitions: _transitions, assumptions: _assumptions, ...totals } = summary;
        const plan: ResourcePlan = { normal: n, challenge: ch, totals: { ...totals,
          eventPoints: objective === "event-points" ? reward : secondaryReward,
          eventItems: objective === "event-items" ? reward : secondaryReward } };
        if (!output.rewardOnlyBest || reward > output.rewardOnlyBest.totals[field(objective)]!) output.rewardOnlyBest = plan;
        result.pairsEvaluated++; output.pairsEvaluated++;
        const nt = same(clock, request) ? clock?.normal?.[n.songKey] : undefined,
          ct = same(clock, request) ? clock?.challenge?.[ch.songKey] : undefined;
        const ns = summary.normalPlays === 0 ? 0 : time(nt), cs = summary.expectedChallengePlays === 0 ? 0 : time(ct);
        const seconds = ns === null || cs === null ? null : summary.normalPlays * ns + summary.expectedChallengePlays * cs;
        if (seconds === null || !Number.isFinite(seconds) || seconds <= 0 || !Number.isFinite(reward / seconds))
          add([gap(clock && !same(clock, request) ? "resource-cycle-time-source-mismatch" : "resource-cycle-time-unresolved", `${n.songKey}/${ch.songKey}`)]);
        else {
          const timed: ResourceTimePlan = { ...plan, expectedElapsedSeconds: seconds, rewardPerSecond: reward / seconds,
            timing: { ...(nt ? { normal: { ...nt } } : {}), ...(ct ? { challenge: { ...ct } } : {}) } };
          if (!output.best || compare(timed, output.best) < 0) output.best = timed;
          for (const kind of ["normal", "challenge"] as const) {
            const id = timed[kind].songId, previous = ranked[kind].get(id);
            if (!previous || compare(timed, previous) < 0) ranked[kind].set(id, timed);
            if (ranked[kind].size > 3) { const worst = [...ranked[kind].values()].sort(compare).at(-1)!; ranked[kind].delete(worst[kind].songId); }
          }
        }
        controls.progress?.({ pairsEvaluated: result.pairsEvaluated,
          totalPairs: request.normal.candidates.length * request.challenge.candidates.length * request.objectives.length });
        await yieldWork();
        interrupt();
      }
      if (stopped) break;
    }
    if (!normal.length || !challenge.length) add([gap("resource-time-no-complete-stage-pair", objective)]);
    output.gaps = [...issues.values()];
    output.top3.normal = [...ranked.normal.values()].sort(compare); output.top3.challenge = [...ranked.challenge.values()].sort(compare);
    output.status = output.best ? !stopped && !issues.size && request.normal.completeness === "exhaustive" &&
      request.challenge.completeness === "exhaustive" ? "proven" : "candidate" : "unavailable";
  }
  result.completeness = stopped ?? (request.normal.completeness === "cancelled" || request.challenge.completeness === "cancelled" ? "cancelled" :
    request.normal.completeness === "budget-limited" || request.challenge.completeness === "budget-limited" ? "budget-limited" :
    Object.values(result.byObjective).every(row => row.status === "proven") ? "exhaustive" : "unavailable");
  result.elapsedMs = elapsed();
  return result;
}
