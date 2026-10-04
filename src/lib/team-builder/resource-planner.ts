import type { EvidenceGap } from "./contracts.ts";
import {
  type FixedPlayRewardOutcome,
} from "./solver/resource-cycle.ts";
import { resolveFixedNormalResourceSummary } from "./solver/resource-cycle-summary";
import { memoizeNormalResourceCycles } from "./resource-normal-cache";
import type {
  ResolvedResourcePlannerInput, ResourceObjectivePlans, ResourcePlan, ResourcePlanObjective,
  ResourcePlannerProgress, ResourcePlannerResult, ResourceStageCandidate,
} from "./resource-plan-contract.ts";

const integer = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 0x7fffffff;
const field = (objective: ResourcePlanObjective) => objective === "event-points" ? "eventPoints" : "eventItems";
const other = (objective: ResourcePlanObjective): ResourcePlanObjective => objective === "event-points" ? "event-items" : "event-points";
const identity = (plan: ResourcePlan) => JSON.stringify([
  plan.normal.songId, plan.challenge.songId, plan.normal.difficulty, plan.challenge.difficulty,
  plan.normal.assignment, plan.challenge.assignment,
]);
export interface ResourcePlannerControls {
  cancelled?: () => boolean;
  now?: () => number;
  yield?: () => Promise<void>;
  progress?: (value: ResourcePlannerProgress) => void;
  summaryStats?: (value: { preparations: number; hits: number; entries: number; bytes: number }) => void;
}

/** Compose only complete, already native-ranked/rounded per-play laws. The
 * existing CP remainder engine stays authoritative. Each objective keeps its
 * own optimized normal/challenge pair and each song keeps its own Top3 entry.
 * Unknown item selection never blocks a complete points law.
 */
export async function optimizeFixedResourcePlans(
  input: ResolvedResourcePlannerInput,
  controls: ResourcePlannerControls = {},
): Promise<ResourcePlannerResult> {
  const parameters = input.parameters, budget = input.budget;
  if (
    input.schema !== "haneoka-resolved-resource-plan-v1" || !input.server || !input.releaseId || !input.sourceId ||
    !integer(input.eventId) || input.eventId < 1 || !["nominal-mean", "worst-ap", "best-ap"].includes(input.skillOrderCriterion) ||
    !input.objectives.length || new Set(input.objectives).size !== input.objectives.length ||
    input.objectives.some(objective => !["event-points", "event-items"].includes(objective)) ||
    !integer(parameters.boostBudget) || parameters.boostBudget > 2000 ||
    !integer(parameters.boostPerNormalPlay) || parameters.boostPerNormalPlay < 1 ||
    !integer(parameters.initialChallengePoints) || !integer(parameters.challengePointCost) || parameters.challengePointCost < 1 ||
    !integer(budget.maxPairs) || budget.maxPairs < 1 || budget.maxPairs > 1000000 ||
    !integer(budget.maxMilliseconds) || budget.maxMilliseconds < 1 || budget.maxMilliseconds > 60000 ||
    !integer(budget.maxCycleStates) || budget.maxCycleStates < 1 || budget.maxCycleStates > 100000 ||
    !integer(budget.maxCycleTransitions) || budget.maxCycleTransitions < 1 || budget.maxCycleTransitions > 2000000 ||
    input.normal.kind !== "normal" || input.challenge.kind !== "challenge" ||
    input.normal.candidates.length > 10000 || input.challenge.candidates.length > 10000
  ) throw new RangeError("resource-plan-input");
  const now = controls.now ?? (() => performance.now()), started = now();
  const elapsed = () => Math.max(0, now() - started);
  const yieldWork = controls.yield ?? (() => new Promise<void>(resolve => setTimeout(resolve, 0)));
  let pairsEvaluated = 0, attempts = 0;
  let stopped: "cancelled" | "budget-limited" | null = null;
  const expired = () => elapsed() >= budget.maxMilliseconds;
  const summaries = memoizeNormalResourceCycles((value, searchControls) => resolveFixedNormalResourceSummary({
    ...value, normal: value.normal.map(row => ({ probability: row.probability, challengePoints: row.challengePoints })),
  }, searchControls));
  const interrupt = (checkPairBudget = true) => {
    if (controls.cancelled?.()) stopped = "cancelled";
    else if (expired() || (checkPairBudget && attempts >= budget.maxPairs)) stopped = "budget-limited";
    return stopped !== null;
  };
  const common = (candidate: ResourceStageCandidate, kind: "normal" | "challenge"): EvidenceGap[] => {
    const errors = [...candidate.gaps];
    if (
      candidate.server !== input.server || candidate.releaseId !== input.releaseId || candidate.sourceId !== input.sourceId ||
      candidate.kind !== kind || candidate.eventId !== input.eventId || candidate.skillOrderCriterion !== input.skillOrderCriterion ||
      candidate.consumedCount !== (kind === "normal" ? parameters.boostPerNormalPlay : parameters.challengePointCost)
    ) errors.push({ code: "resource-stage-law-context-mismatch", source: candidate.key });
    if (
      !candidate.completeLaw || !candidate.key || !candidate.songKey || !integer(candidate.songId) || candidate.songId < 1 ||
      !integer(candidate.difficulty) || !integer(candidate.power) ||
      (kind === "challenge" && (!integer(candidate.challengeMusicId) || candidate.challengeMusicId! < 1)) ||
      !candidate.outcomes.length || candidate.outcomes.length > 10000 ||
      candidate.outcomes.some(row => !Number.isFinite(row.probability) || row.probability < 0) ||
      Math.abs(candidate.outcomes.reduce((sum, row) => sum + row.probability, 0) - 1) > 1e-12
    ) errors.push({ code: "resource-stage-complete-law-required", source: candidate.key });
    const assignment = candidate.assignment;
    if (
      assignment.memberInstanceIds.length !== 5 || assignment.snapshotInstanceIds.length !== 5 ||
      assignment.memberInstanceIds.some(id => !id) || new Set(assignment.memberInstanceIds).size !== 5 ||
      !assignment.memberInstanceIds.includes(assignment.leaderInstanceId) ||
      assignment.snapshotInstanceIds.some(id => id !== null && !id) ||
      new Set(assignment.snapshotInstanceIds.filter(id => id !== null)).size !==
        assignment.snapshotInstanceIds.filter(id => id !== null).length
    ) errors.push({ code: "resource-stage-assignment-invalid", source: candidate.key });
    return errors;
  };
  const axisGaps = (candidate: ResourceStageCandidate, objective: ResourcePlanObjective): EvidenceGap[] => {
    const gaps = [...(candidate.metricGaps[objective] ?? []), ...(candidate.metricGaps["challenge-points"] ?? [])];
    if (candidate.outcomes.some(row => row.probability > 0 && (!integer(row[field(objective)]) || !integer(row.challengePoints))))
      gaps.push({ code: "resource-stage-axis-law-unresolved", source: `${candidate.key}:${objective}` });
    if (objective === "event-items" && (
      !input.itemResource || !candidate.itemResource ||
      !integer(input.itemResource.type) || !integer(input.itemResource.id) ||
      input.itemResource.type !== candidate.itemResource.type || input.itemResource.id !== candidate.itemResource.id
    )) gaps.push({ code: "resource-stage-item-identity-mismatch", source: candidate.key });
    return gaps;
  };
  const byObjective: ResourcePlannerResult["byObjective"] = {};
  for (const objective of input.objectives) {
    const gaps = new Map<string, EvidenceGap>();
    const add = (values: EvidenceGap[]) => values.forEach(gap => gaps.set(`${gap.code}:${gap.source}`, gap));
    add(input.normal.gaps); add(input.challenge.gaps);
    const normal = input.normal.candidates.filter(candidate => {
      const issues = [...common(candidate, "normal"), ...axisGaps(candidate, objective)]; add(issues); return !issues.length;
    });
    const challenge = input.challenge.candidates.filter(candidate => {
      const issues = [...common(candidate, "challenge"), ...axisGaps(candidate, objective)]; add(issues); return !issues.length;
    });
    const secondary = other(objective);
    const secondaryKnown = normal.length === input.normal.candidates.length && challenge.length === input.challenge.candidates.length &&
      [...normal, ...challenge].every(candidate => !axisGaps(candidate, secondary).length);
    const output: ResourceObjectivePlans = {
      best: null, top3: { normal: [], challenge: [] }, status: "candidate", gaps: [], pairsEvaluated: 0,
      secondaryObjective: secondaryKnown ? secondary : null,
    };
    byObjective[objective] = output;
    const ranked = { normal: new Map<number, ResourcePlan>(), challenge: new Map<number, ResourcePlan>() };
    const compare = (a: ResourcePlan, b: ResourcePlan) =>
      b.totals[field(objective)]! - a.totals[field(objective)]! ||
      (secondaryKnown ? b.totals[field(secondary)]! - a.totals[field(secondary)]! : 0) ||
      b.totals.expectedChallengePointsRemaining - a.totals.expectedChallengePointsRemaining ||
      b.normal.power - a.normal.power || b.challenge.power - a.challenge.power ||
      a.normal.songId - b.normal.songId || a.challenge.songId - b.challenge.songId ||
      a.normal.difficulty - b.normal.difficulty || a.challenge.difficulty - b.challenge.difficulty ||
      identity(a).localeCompare(identity(b), "en");
    const law = (candidate: ResourceStageCandidate): FixedPlayRewardOutcome[] => candidate.outcomes
      .filter(row => row.probability > 0)
      .map(row => ({
        probability: row.probability, challengePoints: row.challengePoints!,
        // Internal marginal placeholders only. Unresolved output axes stay null.
        eventPoints: objective === "event-points" || secondaryKnown ? row.eventPoints! : 0,
        eventItems: objective === "event-items" || secondaryKnown ? row.eventItems! : 0,
      }));
    const maximum = (rows: readonly FixedPlayRewardOutcome[], key: "challengePoints" | "eventPoints" | "eventItems") => Math.max(...rows.map(row => row[key]));
    const mean = (rows: readonly FixedPlayRewardOutcome[], key: "eventPoints" | "eventItems") => rows.reduce((sum, row) => sum + row[key] * row.probability, 0);
    // Scalar facts only, scoped to this objective's projection. Do not retain
    // another formation × outcome matrix or change ordered floating reduction.
    const challengeFacts = new WeakMap<ResourceStageCandidate, { reinvests: boolean; maxPoints: number; maxItems: number; points: number; items: number }>();
    for (const n of normal) {
      const normalLaw = law(n);
      const normalPlays = Math.floor(parameters.boostBudget / parameters.boostPerNormalPlay);
      const maximumCP = parameters.initialChallengePoints + normalPlays * maximum(normalLaw, "challengePoints");
      const maximumChallengePlays = Math.floor(maximumCP / parameters.challengePointCost);
      const normalMaxPoints = maximum(normalLaw, "eventPoints"), normalMaxItems = maximum(normalLaw, "eventItems");
      const normalPoints = mean(normalLaw, "eventPoints"), normalItems = mean(normalLaw, "eventItems");
      for (const c of challenge) {
        if (interrupt()) break;
        attempts++;
        if (attempts % 16 === 0) { await yieldWork(); if (interrupt(false)) break; }
        const challengeLaw = law(c);
        let facts = challengeFacts.get(c);
        if (!facts) {
          facts = { reinvests: challengeLaw.some(row => row.challengePoints !== 0),
            maxPoints: maximum(challengeLaw, "eventPoints"), maxItems: maximum(challengeLaw, "eventItems"),
            points: mean(challengeLaw, "eventPoints"), items: mean(challengeLaw, "eventItems") };
          challengeFacts.set(c, facts);
        }
        if (facts.reinvests) {
          add([{ code: "resource-cycle-challenge-reinvestment-unresolved", source: c.key }]); continue;
        }
        if (maximumCP > 0x7fffffff) {
          add([{ code: "resource-cycle-challenge-point-domain-unresolved", source: n.key }]); continue;
        }
        if (normalPlays * normalMaxPoints + maximumChallengePlays * facts.maxPoints > Number.MAX_SAFE_INTEGER ||
            normalPlays * normalMaxItems + maximumChallengePlays * facts.maxItems > Number.MAX_SAFE_INTEGER) {
          add([{ code: "resource-cycle-total-domain-unresolved", source: `${n.key}/${c.key}` }]); continue;
        }
        const cycle = await summaries.prepare(n, {
          normal: normalLaw, ...parameters,
          budget: { maxStates: budget.maxCycleStates, maxTransitions: budget.maxCycleTransitions },
        }, {
          cancelled: () => Boolean(controls.cancelled?.()), expired, yield: yieldWork,
          progress: () => controls.progress?.({ phase: "pairs", pairsEvaluated,
            totalPairs: input.normal.candidates.length * input.challenge.candidates.length * input.objectives.length,
            proofStatus: "candidate" }),
        });
        if (!cycle.value) {
          add(cycle.gaps);
          if (controls.cancelled?.() || expired()) { interrupt(false); break; }
          if (cycle.gaps.some(gap => gap.code === "resource-cycle-state-budget" || gap.code === "resource-cycle-transition-budget")) {
            stopped = "budget-limited";
            break;
          }
          continue;
        }
        const value = cycle.value;
        const plan: ResourcePlan = { normal: n, challenge: c, totals: {
          normalPlays: value.normalPlays, expectedChallengePlays: value.expectedChallengePlays,
          boostSpent: value.boostSpent, boostRemaining: value.boostRemaining,
          expectedChallengePointsGained: value.expectedChallengePointsGained,
          expectedChallengePointsSpent: value.expectedChallengePointsSpent,
          expectedChallengePointsRemaining: value.expectedChallengePointsRemaining,
          remainingChallengePoints: value.remainingChallengePoints,
          eventPoints: objective === "event-points" || secondaryKnown ? value.normalPlays * normalPoints + value.expectedChallengePlays * facts.points : null,
          eventItems: objective === "event-items" || secondaryKnown ? value.normalPlays * normalItems + value.expectedChallengePlays * facts.items : null,
        } };
        pairsEvaluated++; output.pairsEvaluated++;
        if (!output.best || compare(plan, output.best) < 0) output.best = plan;
        for (const kind of ["normal", "challenge"] as const) {
          const id = plan[kind].songId, previous = ranked[kind].get(id);
          if (!previous || compare(plan, previous) < 0) ranked[kind].set(id, plan);
          // The third-place threshold only improves. A discarded song can
          // re-enter with a later better pair; no per-song candidate is pruned.
          if (ranked[kind].size > 3) {
            const worst = [...ranked[kind].values()].sort(compare).at(-1)!;
            ranked[kind].delete(worst[kind].songId);
          }
        }
        if (controls.cancelled?.() || expired()) { interrupt(false); break; }
      }
      if (stopped) break;
    }
    output.top3.normal = [...ranked.normal.values()].sort(compare).slice(0, 3);
    output.top3.challenge = [...ranked.challenge.values()].sort(compare).slice(0, 3);
    output.gaps = [...gaps.values()];
    output.status = !stopped && !gaps.size && input.normal.completeness === "exhaustive" && input.challenge.completeness === "exhaustive"
      ? "proven" : output.best ? "candidate" : "unavailable";
  }
  const outputs = Object.values(byObjective);
  const points = byObjective["event-points"]?.best, items = byObjective["event-items"]?.best;
  const result: ResourcePlannerResult = {
    schema: "haneoka-resource-plan-result-v1", byObjective,
    completeness: stopped ?? (
      input.normal.completeness === "cancelled" || input.challenge.completeness === "cancelled" ? "cancelled" :
      input.normal.completeness === "budget-limited" || input.challenge.completeness === "budget-limited" ? "budget-limited" :
      outputs.every(output => output.status === "proven") ? "exhaustive" : "unavailable"
    ),
    elapsedMs: elapsed(), pairsEvaluated, scope: "fixed-normal-challenge-pair-requested-domain",
    difference: points?.totals.eventItems !== null && items?.totals.eventPoints !== null && points && items
      ? { eventPointsLostWithItemPlan: points.totals.eventPoints! - items.totals.eventPoints!,
          eventItemsLostWithPointPlan: items.totals.eventItems! - points.totals.eventItems! } : null,
  };
  controls.progress?.({ phase: "complete", pairsEvaluated,
    totalPairs: input.normal.candidates.length * input.challenge.candidates.length * input.objectives.length,
    proofStatus: result.completeness === "exhaustive" ? "proven" : outputs.some(output => output.best) ? "candidate" : "unavailable" });
  controls.summaryStats?.(summaries.stats());
  return result;
}
