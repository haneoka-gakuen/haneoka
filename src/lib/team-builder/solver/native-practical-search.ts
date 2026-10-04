import type { Candidate, EvidenceGap, Objective, SongOption, TeamAssignment, WorkerPreparationInput } from "../contracts.ts";
import { nativeSnapshotEquipRuleKnown } from "../data.ts";
import { inventoryOptions } from "../data/solver-input.ts";
import { validateInventory } from "../inventory.ts";
import { refinePracticalCandidates, type PracticalControls, type PracticalDirection,
  type PracticalTask, type PracticalSearchResult } from "../practical-search.ts";
import { prepareSong } from "../song-metrics.ts";
import { unavailableMetric } from "../score.ts";
import { nativeGrowthPowerResolver, prepareEvaluationForSearch } from "./evaluation.ts";
import { resolveNativeChallengeContext } from "./native-challenge-context.ts";
import { loadSongOptions } from "./song-loader.ts";
import { searchFingerprint } from "./search-checkpoint.ts";
import { validateSearchBudget } from "./search-budget.ts";

export type NativePracticalChart = { songId: number; difficulty: number } | { challengeMusicId: number; difficulty: number };
export interface NativePracticalPreparationInput extends Omit<WorkerPreparationInput,
  "selections" | "mode" | "nativeGekisoPlans" | "challengeMusicId"> {
  schema: "haneoka-native-practical-request-v1";
  selections: NativePracticalChart[];
  modes: ("normal" | "gekiso")[];
  baseline?: TeamAssignment;
  finalistLimit?: number;
}
export interface NativePracticalProgress {
  phase: "loading" | "seeds" | "neighbours" | "screen" | "final";
  taskKey?: string;
  completed: number;
  total: number;
  elapsedMs: number;
}
export interface NativePracticalResult extends PracticalSearchResult {
  schema: "haneoka-native-practical-result-v1";
  server: string;
  releaseId: string;
  sourceId: string;
  elapsedMs: number;
}
export interface NativePracticalControls extends Omit<PracticalControls, "progress" | "expired"> {
  now?: () => number;
  progress?: (progress: NativePracticalProgress) => void;
}
const objectives: Objective[] = ["score", "ss-ratio", "ss-surplus", "event-points", "event-items", "base-score"];
const sum = (stats: { performance: number; technique: number; visual: number }) => stats.performance + stats.technique + stats.visual;

/** Feature priorities choose a bounded heuristic pool. Each published result
 * is evaluated by the native factory over its full member-order domain. */
export async function prepareNativePracticalSearch(input: NativePracticalPreparationInput,
  controls: NativePracticalControls = {}): Promise<NativePracticalResult> {
  const request = structuredClone(input), now = controls.now ?? (() => performance.now()), started = now();
  const elapsed = () => Math.max(0, now() - started);
  validateSearchBudget(request.budget);
  if (request.schema !== "haneoka-native-practical-request-v1" || !request.data.identity.sourceId ||
    !request.modes.length || request.modes.length > 2 || new Set(request.modes).size !== request.modes.length ||
    request.modes.some(mode => !["normal", "gekiso"].includes(mode)) ||
    !request.selections.length || request.selections.length > 1000 || !request.objectives.length ||
    new Set(request.objectives).size !== request.objectives.length || request.objectives.some(goal => !objectives.includes(goal)) ||
    request.selections.length * request.modes.length * request.objectives.length > 1000)
    throw new RangeError("native-practical-domain");
  const validation = validateInventory(request.inventory, request.data);
  if (!validation.valid) throw new RangeError(`native-practical-inventory:${validation.issues[0]?.code}`);
  const cancelled = () => Boolean(controls.cancelled?.()), expired = () => elapsed() >= request.budget.maxMilliseconds;
  let evaluated = 0;
  const progress = (value: Omit<NativePracticalProgress, "elapsedMs">) => controls.progress?.({ ...value, elapsedMs: elapsed() });
  progress({ phase: "loading", completed: 0, total: request.selections.length });
  const charts: { key: string; chart: NativePracticalChart; parent: number; song?: SongOption; gaps: EvidenceGap[] }[] = [];
  for (const chart of request.selections) {
    let parent = "songId" in chart ? chart.songId : 0;
    const key = "songId" in chart ? `${chart.songId}:${chart.difficulty}` : `challenge:${chart.challengeMusicId}:${chart.difficulty}`;
    const gaps: EvidenceGap[] = [];
    if ("challengeMusicId" in chart) {
      const scene = request.eventScene;
      if (scene?.kind !== "challenge") gaps.push({ code: "native-challenge-scenario-required", source: key });
      else {
        const context = resolveNativeChallengeContext(request.data, request.data.challengeMusicTable, {
          challengeMusicId: chart.challengeMusicId, eventId: scene.eventId,
          startTimeMs: scene.liveStartServerTime.epochMilliseconds, masterTimeSlot: scene.masterTimeSlot,
        });
        gaps.push(...context.gaps); if (context.value) parent = context.value.underlyingSongId;
      }
    } else if (request.eventScene?.kind === "challenge")
      gaps.push({ code: "native-challenge-wrapper-required", source: key });
    if (!Number.isSafeInteger(chart.difficulty) || chart.difficulty < 0 || !request.data.songs[String(parent)])
      gaps.push({ code: "native-practical-chart-unresolved", source: key });
    charts.push({ key, chart, parent, gaps });
  }
  if (new Set(charts.map(chart => chart.key)).size !== charts.length) throw new RangeError("native-practical-duplicate-chart");
  const loading = new AbortController();
  const timer = setTimeout(() => loading.abort(), Math.max(1, request.budget.maxMilliseconds - elapsed()));
  const cancellation = setInterval(() => { if (cancelled()) loading.abort(); }, 100);
  try {
    for (const [index, chart] of charts.entries()) {
      if (cancelled() || expired()) break;
      if (!chart.gaps.length) {
        try {
          [chart.song] = await loadSongOptions(request.data, [{ songId: chart.parent, difficulty: chart.chart.difficulty }], loading.signal,
            { nativeGekisoPerfectPlan: "songId" in chart.chart && request.modes.includes("gekiso") &&
              request.scoreDomain !== "personal-solo" && request.objectives.includes("score") && request.constraints.justRate === 0 });
          chart.song!.key = chart.key;
          if ("challengeMusicId" in chart.chart) {
            const scene = request.eventScene!;
            const context = resolveNativeChallengeContext(request.data, request.data.challengeMusicTable, {
              challengeMusicId: chart.chart.challengeMusicId, eventId: scene.eventId,
              startTimeMs: scene.liveStartServerTime.epochMilliseconds, masterTimeSlot: scene.masterTimeSlot,
            });
            if (context.value) chart.song!.segments = chart.song!.segments.map((range, position) =>
              ({ ...range, mission: context.value!.missionTypes[position]! }));
            else chart.gaps.push(...context.gaps);
          }
        } catch { chart.gaps.push({ code: "native-practical-chart-load-unresolved", source: chart.key }); }
      }
      progress({ phase: "loading", completed: index + 1, total: charts.length });
    }
  } finally { clearTimeout(timer); clearInterval(cancellation); }
  const options = inventoryOptions(request.inventory, request.data, nativeGrowthPowerResolver, { requiredMode: "normal" });
  if (!nativeSnapshotEquipRuleKnown(request.data.identity)) options.snapshots.forEach(photo => { delete photo.allowedCharacterIds; });
  const directions: PracticalDirection[] = [];
  const direction = (id: string, preferred: (member: typeof options.members[number]) => boolean) => {
    directions.push({ id, members: Object.fromEntries(options.members.map(member => [member.instanceId,
      sum(member.stats) * (preferred(member) ? 2 : 1)])), snapshots: Object.fromEntries(options.snapshots.map(photo =>
        [photo.instanceId, photo.bonusBP ? sum(photo.bonusBP) : 0])) });
  };
  direction("actual-growth-feature", () => false);
  for (const type of [...new Set(options.members.map(member => member.attribute))].slice(0, 5)) direction(`attribute:${type}`, member => member.attribute === type);
  for (const band of [...new Set(options.members.map(member => member.bandId))].slice(0, 5)) direction(`band:${band}`, member => member.bandId === band);
  const tasks: PracticalTask[] = charts.filter(chart =>
    !request.constraints.excludedSongKeys.includes(chart.key) &&
    (!request.constraints.lockedSongKey || request.constraints.lockedSongKey === chart.key))
    .flatMap(chart => request.modes.filter(mode => !(mode === "gekiso" && request.constraints.excludeJustMissions &&
      chart.song?.segments.some(range => range.mission === 3))).flatMap(mode => request.objectives.map(objective =>
        ({ key: `${mode}:${chart.key}:${objective}`, songKey: chart.key, mode, objective }))));
  if (!tasks.length) throw new RangeError("native-practical-no-eligible-task");
  const { budget: _budget, ...semantic } = request;
  const contextFingerprint = await searchFingerprint({ kind: "native-practical", request: semantic, charts });
  const byChart = new Map(charts.map(chart => [chart.key, chart]));
  const taskGaps = new Map<string, EvidenceGap[]>();
  const failedCandidate = (assignment: TeamAssignment, task: PracticalTask, gaps: EvidenceGap[]): Candidate => ({
    assignment: structuredClone(assignment), songKey: task.songKey,
    metrics: Object.fromEntries(objectives.map(goal => [goal, { ...unavailableMetric("native-practical-task-unavailable", task.key),
      gaps: [...gaps] }])) as Candidate["metrics"], vector: [NaN],
  });
  const result = await refinePracticalCandidates({ contextFingerprint, ...options, constraints: request.constraints,
    tasks, directions, baseline: request.baseline, finalistLimit: request.finalistLimit }, {
    async full(assignment, task) {
      const chart = byChart.get(task.songKey)!;
      let candidate: Candidate;
      if (!chart.song || chart.gaps.length) candidate = failedCandidate(assignment, task, chart.gaps.length ? chart.gaps :
        [{ code: "native-practical-chart-not-loaded", source: task.songKey }]);
      else {
        const memberIds = new Set(assignment.memberInstanceIds), photoIds = new Set(assignment.snapshotInstanceIds);
        const inventory = { ...request.inventory, members: request.inventory.members.filter(member => memberIds.has(member.instanceId)),
          snapshots: request.inventory.snapshots.filter(photo => photoIds.has(photo.instanceId)) };
        try {
          const prepared = prepareEvaluationForSearch({ ...request, inventory, songs: [chart.song], mode: task.mode,
            scoreDomain: task.mode === "gekiso" ? task.objective === "score" ? request.scoreDomain ?? "personal-live" : "personal-solo" : undefined,
            objectives: [task.objective], challengeMusicId: "challengeMusicId" in chart.chart ? chart.chart.challengeMusicId : undefined });
          candidate = await prepared.evaluate(assignment, prepareSong(chart.song, prepared.input.evaluation), {
            cancelled, expired, yield: controls.yield ?? (() => new Promise<void>(resolve => setTimeout(resolve, 0))), progress: () => {},
          });
        } catch (error) { candidate = failedCandidate(assignment, task,
          [{ code: error instanceof Error ? error.message : "native-practical-evaluation-unresolved", source: task.key }]); }
      }
      evaluated++;
      const metric = candidate.metrics[task.objective];
      taskGaps.set(task.key, [...(taskGaps.get(task.key) ?? []), ...metric.gaps]);
      return { contextFingerprint, orders: 120 as const, complete: !cancelled() && !expired() && metric.value !== null && !metric.gaps.length, candidate };
    },
  }, { cancelled, expired: () => expired() || evaluated >= request.budget.maxEvaluations, yield: controls.yield,
    progress: value => progress(value) });
  // Preserve precise per-task unavailable input axes after the scheduler's
  // incomplete-cell marker, without assigning them a zero feature score.
  for (const row of result.tasks) {
    const chart = byChart.get(row.task.songKey)!;
    row.gaps.push(...chart.gaps, ...(taskGaps.get(row.task.key) ?? []));
    row.gaps = [...new Map(row.gaps.map(gap => [`${gap.code}:${gap.source}`, gap])).values()];
  }
  return { ...result, schema: "haneoka-native-practical-result-v1", server: request.data.identity.server,
    releaseId: request.data.identity.releaseId, sourceId: request.data.identity.sourceId!, elapsedMs: elapsed() };
}
