import type { EvidenceGap, SkillOrderCriterion, TeamAssignment } from "../contracts.ts";
import { optimizeTeams, type SearchEvaluationControls } from "../optimizer.ts";
import type {
  ResolvedResourcePlannerInput, ResolvedResourceStage, ResourcePlannerPreparationInput,
  ResourcePlayOutcome, ResourceStageCandidate,
} from "../resource-plan-contract.ts";
import { resourcePlanInputIssues } from "../resource-plan-input.ts";
import { nativeChallengePointTable } from "../data/reward-input.ts";
import { createAssignmentEvaluator } from "./evaluate.ts";
import { prepareEvaluationForSearch } from "./evaluation.ts";
import { resolveNativeChallengeContext, type NativeChallengeContext } from "./native-challenge-context.ts";
import { createNativeEventPayoutResolver } from "./native-event-payout.ts";
import { validateNativeEventScene } from "./native-event-scene.ts";
import { createNativeNormalSlotResolver } from "./native-normal.ts";
import { createNativeNormalScoreResolver, type NativeNormalPlayScoreLaw } from "./native-normal-score.ts";
import { createNativeGekisoResourceScoreResolver } from "./native-gekiso-resource-score.ts";
import { loadSongOptions } from "./song-loader.ts";

const gap = (code: string, source: string): EvidenceGap => ({ code, source });
const unique = (gaps: readonly EvidenceGap[]): EvidenceGap[] => [...new Map(gaps.map(value =>
  [`${value.code}:${value.source}`, value])).values()];
const integer = (value: number) => Number.isSafeInteger(value) && value >= 0 && value <= 0x7fffffff;
const yieldWork = () => new Promise<void>(resolve => setTimeout(resolve, 0));

type MetricGaps = ResourceStageCandidate["metricGaps"];
export interface ResourceStagePlayLaw {
  outcomes: ResourcePlayOutcome[];
  completeLaw: boolean;
  gaps: EvidenceGap[];
  metricGaps: MetricGaps;
}

/** Consume the factory's complete integer score law, never a scalar mean.
 * AP endpoints select one complete minimum/maximum-score play. Nominal orders are ranked and
 * rounded individually before equal joint reward outcomes are combined.
 * Server-selected item probabilities have their own evidence boundary.
 */
export function resolveResourceStagePlayLaw(
  payout: ReturnType<typeof createNativeEventPayoutResolver>,
  assignment: TeamAssignment,
  law: NativeNormalPlayScoreLaw,
  criterion: SkillOrderCriterion,
  nativeLiveMode: 0 | 3,
): ResourceStagePlayLaw {
  if (!law || law.nominalOrders !== 120 || !law.outcomes.length || law.outcomes.length > 120 ||
      law.outcomes.some(row => !integer(row.score) || !integer(row.multiplicity) || row.multiplicity < 1) ||
      law.outcomes.reduce((sum, row) => sum + row.multiplicity, 0) !== law.nominalOrders ||
      !["nominal-mean", "worst-ap", "best-ap"].includes(criterion))
    return { outcomes: [], completeLaw: false,
      gaps: [gap("native-resource-complete-score-law-required", "120 native member orders")], metricGaps: {} };
  const plays = criterion === "worst-ap"
    ? [{ score: Math.min(...law.outcomes.map(row => row.score)), probability: 1 }]
    : criterion === "best-ap"
      ? [{ score: Math.max(...law.outcomes.map(row => row.score)), probability: 1 }]
    : law.outcomes.map(row => ({ score: row.score, probability: row.multiplicity / law.nominalOrders }));
  const pointGaps: EvidenceGap[] = [], cpGaps: EvidenceGap[] = [];
  const joint = new Map<string, ResourcePlayOutcome>();
  for (const play of plays) {
    const resolved = payout.resolve(assignment,
      { nativeLiveMode, soloScore: play.score, roomPlayers: [] }, null);
    pointGaps.push(...resolved.eventPoints.gaps);
    cpGaps.push(...resolved.challengePoints.gaps);
    const outcome: ResourcePlayOutcome = { probability: play.probability,
      eventPoints: resolved.eventPoints.value, eventItems: null, challengePoints: resolved.challengePoints.value };
    const key = JSON.stringify([outcome.eventPoints, outcome.eventItems, outcome.challengePoints]);
    const previous = joint.get(key);
    if (previous) previous.probability += outcome.probability;
    else joint.set(key, outcome);
  }
  return { outcomes: [...joint.values()], completeLaw: true, gaps: [], metricGaps: {
    "event-points": unique(pointGaps), "challenge-points": unique(cpGaps),
    "event-items": [gap("native-event-server-selection-law-unresolved", "complete joint selected RewardId law")],
  } };
}

export interface ResourceStagePreparationProgress {
  kind: "normal" | "challenge";
  chartsCompleted: number;
  totalCharts: number;
  evaluated: number;
  retainedLaws: number;
}
export interface ResourceStagePreparationControls {
  cancelled?: () => boolean;
  now?: () => number;
  yield?: () => Promise<void>;
  progress?: (progress: ResourceStagePreparationProgress) => void;
  /** Complete formation/chart evaluations per stage, shared across its charts. */
  maxStageEvaluations?: number;
  /** Distinct whole-play laws per stage; reaching this bound limits proof. */
  maxStageCandidates?: number;
}

const unavailable = (kind: "normal" | "challenge", gaps: EvidenceGap[]): ResolvedResourceStage =>
  ({ kind, candidates: [], completeness: "unavailable", gaps: unique(gaps) });
const assignmentKey = (assignment: TeamAssignment) => JSON.stringify([
  assignment.memberInstanceIds, assignment.snapshotInstanceIds, assignment.leaderInstanceId,
]);

/** Prepare both requested legal domains. The optimizer is used only as a legal
 * formation enumerator: every completed reward law is captured inside its
 * evaluator, before score Pareto/Top3 filtering. Only equal joint laws for the
 * same wrapper/chart are coalesced; a scalar score frontier cannot prune CP.
 */
export async function prepareResourcePlanStages(
  request: ResourcePlannerPreparationInput,
  controls: ResourceStagePreparationControls = {},
): Promise<ResolvedResourcePlannerInput> {
  const issues = resourcePlanInputIssues(request);
  if (issues.length) throw new RangeError(`resource-stage-input:${issues[0]!.path}:${issues[0]!.code}`);
  const sourceId = request.data.identity.sourceId ?? "";
  if (!sourceId) throw new RangeError("resource-stage-source-required");
  const maxEvaluations = controls.maxStageEvaluations ?? 10000;
  const maxCandidates = controls.maxStageCandidates ?? 1000;
  if (!integer(maxEvaluations) || maxEvaluations < 1 || maxEvaluations > 2000000 ||
      !integer(maxCandidates) || maxCandidates < 1 || maxCandidates > 10000)
    throw new RangeError("resource-stage-budget");
  const now = controls.now ?? (() => performance.now()), started = now();
  const remaining = () => Math.max(0, request.budget.maxMilliseconds - (now() - started));
  const cancelled = () => Boolean(controls.cancelled?.());
  const cp = nativeChallengePointTable(request.data);
  async function stage(kind: "normal" | "challenge"): Promise<ResolvedResourceStage> {
    // Reserve half the initial preparation window for challenge search. An
    // unfinished ordinary domain must still leave room for a usable pair.
    const deadline = now() + (kind === "normal" ? remaining() / 2 : remaining());
    const stageRemaining = () => Math.max(0, Math.min(remaining(), deadline - now()));
    const selection = request[kind];
    const sceneGaps = validateNativeEventScene(request.data, selection.scene);
    if (sceneGaps.length) return unavailable(kind, sceneGaps);
    if (selection.constraints.justRate !== 0)
      return unavailable(kind, [gap("native-resource-perfect-play-required", kind)]);
    let evaluated = 0, chartsCompleted = 0, stopped: "cancelled" | "budget-limited" | null = null;
    const gaps: EvidenceGap[] = [], candidates = new Map<string, ResourceStageCandidate>();
    const progress = () => controls.progress?.({ kind, chartsCompleted, totalCharts: selection.charts.length,
      evaluated, retainedLaws: candidates.size });
    const interrupt = () => {
      if (cancelled()) stopped = "cancelled";
      else if (stageRemaining() < 1 || evaluated >= maxEvaluations) stopped = "budget-limited";
      return stopped !== null;
    };
    for (const chart of selection.charts) {
      if (interrupt()) break;
      let context: NativeChallengeContext | null = null;
      const data = request.data;
      const difficulty = chart.difficulty;
      let songId: number;
      if ("challengeMusicId" in chart) {
        const resolved = resolveNativeChallengeContext(data, data.challengeMusicTable, {
          challengeMusicId: chart.challengeMusicId, eventId: selection.scene.eventId,
          startTimeMs: selection.scene.liveStartServerTime.epochMilliseconds,
          masterTimeSlot: selection.scene.masterTimeSlot,
        });
        if (!resolved.value) { gaps.push(...resolved.gaps); chartsCompleted++; progress(); continue; }
        context = resolved.value;
        songId = context.underlyingSongId;
      } else songId = chart.songId;
      const songKey = context ? `challenge:${context.challengeMusicId}:${difficulty}` : `${songId}:${difficulty}`;
      if ((selection.constraints.lockedSongKey && selection.constraints.lockedSongKey !== songKey) ||
          selection.constraints.excludedSongKeys.includes(songKey)) { chartsCompleted++; continue; }
      const loading = new AbortController();
      const timer = setTimeout(() => loading.abort(), Math.max(1, Math.floor(stageRemaining())));
      const cancellation = setInterval(() => { if (cancelled()) loading.abort(); }, 250);
      let songs;
      try { songs = await loadSongOptions(data, [{ songId, difficulty }], loading.signal); }
      catch {
        if (!interrupt()) gaps.push(gap("native-resource-chart-load-unresolved", songKey));
        chartsCompleted++; progress();
        if (stopped) break;
        continue;
      } finally { clearTimeout(timer); clearInterval(cancellation); }
      if (interrupt()) break;
      const song = songs[0]!;
      song.key = songKey;
      if (context && selection.mode === "gekiso") song.segments = song.segments.map((segment,index) =>
        ({...segment,mission:context!.missionTypes[index]!}));
      // Normal mode consumes the parent's actual chart skill timestamps. GK
      // wrapper mission overrides are deliberately not interpreted as normal skills.
      const prepared = prepareEvaluationForSearch({ data, inventory: request.inventory, songs: [song],
        mode: "normal", requireGekisoPractice: selection.mode === "gekiso" ? true : undefined,
        objectives: ["score"], skillOrderCriterion: request.skillOrderCriterion,
        constraints: selection.constraints, budget: { maxMilliseconds: Math.max(1, Math.floor(stageRemaining())),
          maxEvaluations: maxEvaluations - evaluated, maxCandidates: 1000 } });
      const input = prepared.input;
      input.evaluation.assumptions = ["native-explicit-single-held-event",
        `native-live-start:${selection.scene.liveStartServerTime.source}`, `native-resource-stage:${kind}`];
      const payout = createNativeEventPayoutResolver(request.data, request.inventory, {
        eventId: selection.scene.eventId, songId, kind, consumption: selection.scene.consumedCount,
        ...(cp.table ? { challengePointTable: cp.table } : {}),
      });
      // The qualified wrapper keeps parameter and skill-target types separate,
      // and supplies its two native base bonuses (both zero). Parent chart,
      // tags and rank stay on the original same-pin data object.
      const musicTypes = context ? new Map([[songId, context]]) : undefined;
      const slots = createNativeNormalSlotResolver(data, request.inventory, input, payout, musicTypes);
      const scorer = selection.mode === "gekiso" ? createNativeGekisoResourceScoreResolver(data,input)
        : createNativeNormalScoreResolver(data, input);
      input.evaluation.gaps.push(...payout.powerGaps, ...slots.gaps, ...scorer.gaps);
      const evaluate = createAssignmentEvaluator(input, slots.resolveSlots);
      let lawBudgetReached = false;
      const result = await optimizeTeams(input, {
        now, cancelled: () => cancelled() || lawBudgetReached, yield: controls.yield ?? yieldWork,
        progress: progress,
        evaluate: async (assignment, chart, searchControls: SearchEvaluationControls) => {
          const profiles = slots.resolveSlots(assignment, chart);
          let scoreLaw: NativeNormalPlayScoreLaw | undefined;
          const metric = await scorer.score(assignment, chart, profiles, {
            ...searchControls, expired: () => searchControls.expired() || stageRemaining() < 1,
          }, law => { scoreLaw = law; });
          evaluated++;
          const value = evaluate(assignment, chart, metric);
          if (scoreLaw && value.metrics.score.value !== null && !cancelled() && stageRemaining() >= 1) {
            const resolved = resolveResourceStagePlayLaw(payout, assignment, scoreLaw,
              request.skillOrderCriterion, kind === "challenge" ? 3 : 0);
            const power = metric.breakdown?.find(row => row.key === "resolved-team-power")?.value;
            if (resolved.completeLaw && power !== undefined && power !== null && integer(power)) {
              const key = JSON.stringify([songKey, resolved.outcomes, resolved.metricGaps]);
              const candidate: ResourceStageCandidate = {
                ...request.data.identity, sourceId,
                kind, eventId: selection.scene.eventId, consumedCount: selection.scene.consumedCount,
                skillOrderCriterion: request.skillOrderCriterion,
                ...(request.itemResource ? { itemResource: { ...request.itemResource } } : {}),
                key: `${kind}:${songKey}:${assignmentKey(assignment)}`, songKey, songId, difficulty,
                ...(context ? { challengeMusicId: context.challengeMusicId } : {}),
                assignment: structuredClone(assignment), power, ...resolved,
              };
              const previous = candidates.get(key);
              if (!previous && candidates.size >= maxCandidates) lawBudgetReached = true;
              else if (!previous || previous.power < candidate.power ||
                  (previous.power === candidate.power && candidate.key.localeCompare(previous.key, "en") < 0)) candidates.set(key, candidate);
            } else gaps.push(...resolved.gaps, gap("native-resource-stage-power-or-law-unresolved", songKey));
          }
          return value;
        },
      });
      gaps.push(...result.gaps);
      chartsCompleted++; progress();
      if (cancelled()) stopped = "cancelled";
      else if (lawBudgetReached || result.completeness === "budget-limited") stopped = "budget-limited";
      if (stopped) break;
      if (result.completeness !== "exhaustive") gaps.push(gap("native-resource-stage-domain-incomplete", songKey));
    }
    if (!candidates.size && !stopped) gaps.push(gap("native-resource-no-complete-stage-candidates", kind));
    return { kind, candidates: [...candidates.values()], completeness: stopped ??
      (gaps.length ? "unavailable" : "exhaustive"), gaps: unique(gaps) };
  }
  const normal = await stage("normal"), challenge = await stage("challenge");
  return { ...request.data.identity, sourceId,
    schema: "haneoka-resolved-resource-plan-v1", eventId: request.normal.scene.eventId,
    skillOrderCriterion: request.skillOrderCriterion, parameters: { ...request.parameters },
    objectives: [...request.objectives], ...(request.itemResource ? { itemResource: { ...request.itemResource } } : {}),
    normal, challenge, budget: { ...request.budget } };
}
