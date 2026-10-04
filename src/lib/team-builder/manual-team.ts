import type {
  Candidate, EvidenceGap, Objective, ReleaseIdentity, ResolvedSlotProfile,
  SongOption, TeamAssignment, WorkerPreparationInput, ManualTeamPreparationInput,
  ManualTeamEvaluationResult, ManualTeamProgress,
} from "./contracts.ts";
import { validateAssignment, validateInventory, type InventoryIssue, type MemberEntry, type SnapshotEntry } from "./inventory.ts";
import { prepareSong } from "./song-metrics.ts";
import { unavailableMetric } from "./score.ts";
import { prepareEvaluationForSearch } from "./solver/evaluation.ts";
import { resolveNativeChallengeContext } from "./solver/native-challenge-context.ts";
import { validateNativeEventScene } from "./solver/native-event-scene.ts";
import { loadSongOptions } from "./solver/song-loader.ts";
import { validateSearchBudget } from "./solver/search-budget.ts";

export interface ManualTeamChartRequest extends Omit<WorkerPreparationInput, "selections" | "mode" | "budget"> {
  schema: "haneoka-manual-team-request-v1";
  assignment: TeamAssignment;
  chart: { songId: number; difficulty: number } | { challengeMusicId: number; difficulty: number };
  mode: "normal" | "gekiso";
  budget: { maxMilliseconds: number };
}
export interface PinnedManualTeamSong {
  identity: ReleaseIdentity & { sourceId: string };
  song: SongOption;
}
export interface ManualTeamChartControls {
  cancelled?: () => boolean;
  now?: () => number;
  yield?: () => Promise<void>;
  progress?: (phase: "loading" | "evaluating" | "complete") => void;
  /** Actual converted chart after wrapper key/mission normalization. */
  preparedSong?: (song: PinnedManualTeamSong) => void;
}
export interface ManualTeamChartResult {
  schema: "haneoka-manual-team-result-v1";
  identity: ReleaseIdentity & { sourceId?: string };
  assignment: TeamAssignment;
  chart: ManualTeamChartRequest["chart"];
  status: "complete" | "unavailable" | "invalid" | "cancelled" | "budget-limited";
  candidate: Candidate | null;
  slots: { index: number; member: MemberEntry; snapshot: SnapshotEntry | null;
    power: number | null; gaps: EvidenceGap[] }[];
  issues: InventoryIssue[];
  gaps: EvidenceGap[];
  elapsedMs: number;
}
const int = (value: number) => Number.isSafeInteger(value) && value >= 0 && value <= 0x7fffffff;
const gap = (code: string, source: string): EvidenceGap => ({ code, source });
const unique = (values: EvidenceGap[]) => [...new Map(values.map(row => [`${row.code}:${row.source}`, row])).values()];
const objectives: Objective[] = ["score", "ss-ratio", "ss-surplus", "event-points", "event-items", "base-score"];

/** Validate ownership, exact slot/leader choice and locks before native work.
 * Practice is required only by the selected native mode, after selection.
 */
export function manualTeamChartInputIssues(request: ManualTeamChartRequest): InventoryIssue[] {
  const issues = validateInventory(request.inventory, request.data).issues;
  if (issues.length) return issues;
  const issue = (path: string, code: string) => issues.push({ path, code });
  if (request.schema !== "haneoka-manual-team-request-v1") issue("schema", "unsupported-schema");
  if (!request.data.identity.sourceId) issue("data.identity.sourceId", "source-required");
  if (!["normal", "gekiso"].includes(request.mode)) issue("mode", "invalid-mode");
  if (!int(request.budget.maxMilliseconds) || request.budget.maxMilliseconds < 1 || request.budget.maxMilliseconds > 60000)
    issue("budget", "invalid-manual-budget");
  if (!request.objectives.length || new Set(request.objectives).size !== request.objectives.length ||
      request.objectives.some(value => !objectives.includes(value))) issue("objectives", "invalid-objectives");
  if (request.skillOrderCriterion !== undefined && !["nominal-mean", "worst-ap", "best-ap"].includes(request.skillOrderCriterion))
    issue("skillOrderCriterion", "invalid-criterion");
  if (request.scoreDomain !== undefined && (request.mode !== "gekiso" ||
      !["personal-solo", "personal-live"].includes(request.scoreDomain))) issue("scoreDomain", "invalid-score-domain");
  const assignment = request.assignment, constraints = request.constraints;
  if (assignment.memberInstanceIds.length !== 5 || assignment.snapshotInstanceIds.length !== 5 || constraints.teamSize !== 5)
    issue("assignment", "five-fixed-slots-required");
  if (issues.some(row => row.path === "members" || row.path === "snapshots")) return issues;
  issues.push(...validateAssignment(assignment, request.inventory));
  const characters = assignment.memberInstanceIds.map(id => {
    const member = request.inventory.members.find(row => row.instanceId === id);
    return member && request.data.members[String(member.cardId)]?.characterId;
  });
  if (new Set(characters).size !== characters.length) issue("assignment", "duplicate-character");
  for (const kind of ["Member", "Snapshot"] as const) {
    const selected = new Set(kind === "Member" ? assignment.memberInstanceIds : assignment.snapshotInstanceIds);
    const locked = constraints[`locked${kind}Ids`], excluded = constraints[`excluded${kind}Ids`];
    if (new Set(locked).size !== locked.length) issue(`constraints.locked${kind}Ids`, "duplicate-lock");
    for (const id of locked) if (!selected.has(id)) issue(id, "locked-instance-missing");
    for (const id of excluded) if (selected.has(id)) issue(id, "excluded-instance-selected");
  }
  if (constraints.requiredLeaderId !== undefined && constraints.requiredLeaderId !== null &&
      (typeof constraints.requiredLeaderId !== "string" || !constraints.requiredLeaderId ||
       assignment.leaderInstanceId !== constraints.requiredLeaderId)) issue("constraints.requiredLeaderId", "required-leader-mismatch");
  const boundMembers = new Set<string>(), boundPhotos = new Set<string>();
  for (const binding of constraints.requiredBindings ?? []) {
    const slot = assignment.memberInstanceIds.indexOf(binding.memberInstanceId);
    if (boundMembers.has(binding.memberInstanceId) || (binding.snapshotInstanceId !== null && boundPhotos.has(binding.snapshotInstanceId)))
      issue("constraints.requiredBindings", "duplicate-binding");
    boundMembers.add(binding.memberInstanceId);
    if (binding.snapshotInstanceId !== null) boundPhotos.add(binding.snapshotInstanceId);
    if (slot < 0 || assignment.snapshotInstanceIds[slot] !== binding.snapshotInstanceId)
      issue("constraints.requiredBindings", "required-binding-mismatch");
  }
  for (const [axis,value] of Object.entries(constraints.bonusFloors ?? {}))
    if (!["eventPointsBP", "eventItemsBP"].includes(axis) || (value !== undefined && !int(value))) issue(`constraints.bonusFloors.${axis}`, "invalid-bonus-floor");
  if (constraints.resultDistinctCardSets !== undefined && (!int(constraints.resultDistinctCardSets) ||
      constraints.resultDistinctCardSets < 1 || constraints.resultDistinctCardSets > 15))
    issue("constraints.resultDistinctCardSets", "invalid-distinct-count");
  if (!Number.isFinite(constraints.justRate) || constraints.justRate < 0 || constraints.justRate > 1)
    issue("constraints.justRate", "invalid-just-rate");
  const id = "songId" in request.chart ? request.chart.songId : request.chart.challengeMusicId;
  if (!int(id) || id < 1 || !int(request.chart.difficulty)) issue("chart", "invalid-chart");
  if ("challengeMusicId" in request.chart && request.eventScene?.kind !== "challenge")
    issue("eventScene", "challenge-scene-required");
  if ("songId" in request.chart && request.eventScene?.kind === "challenge")
    issue("chart", "challenge-wrapper-required");
  if (request.challengeMusicId !== undefined && (!("challengeMusicId" in request.chart) ||
      request.challengeMusicId !== request.chart.challengeMusicId))
    issue("challengeMusicId", "challenge-wrapper-selection-mismatch");
  return issues;
}

async function runManualTeam(request: ManualTeamChartRequest, controls: ManualTeamChartControls,
  pinned?: PinnedManualTeamSong, expectedParentSongId?: number): Promise<ManualTeamChartResult> {
  const now = controls.now ?? (() => performance.now()), started = now();
  const elapsed = () => Math.max(0, now() - started);
  const cancelled = () => Boolean(controls.cancelled?.());
  const expired = () => elapsed() >= request.budget.maxMilliseconds;
  const result: ManualTeamChartResult = { schema: "haneoka-manual-team-result-v1", identity: { ...request.data.identity },
    assignment: structuredClone(request.assignment), chart: { ...request.chart }, status: "unavailable",
    candidate: null, slots: [], issues: manualTeamChartInputIssues(request), gaps: [], elapsedMs: 0 };
  const finish = (status: ManualTeamChartResult["status"], gaps: EvidenceGap[] = []) => {
    result.status = status; result.gaps = unique(gaps); result.elapsedMs = elapsed();
    controls.progress?.("complete"); return result;
  };
  if (result.issues.length) return finish("invalid");
  const interrupt = () => cancelled() ? "cancelled" as const : expired() ? "budget-limited" as const : null;
  let stop = interrupt(); if (stop) return finish(stop);
  const data = request.data, scene = request.eventScene;
  if (scene) { const gaps = validateNativeEventScene(data, scene); if (gaps.length) return finish("unavailable", gaps); }
  if ((request.mode === "gekiso" || request.skillOrderCriterion === "worst-ap" ||
      request.skillOrderCriterion === "best-ap") && request.constraints.justRate !== 0)
    return finish("unavailable", [gap("native-manual-perfect-timing-required", "selected native AP evaluation scope")]);
  let context: ReturnType<typeof resolveNativeChallengeContext>["value"] = null;
  if ("challengeMusicId" in request.chart) {
    const resolved = resolveNativeChallengeContext(data, data.challengeMusicTable, {
      challengeMusicId: request.chart.challengeMusicId, eventId: scene!.eventId,
      startTimeMs: scene!.liveStartServerTime.epochMilliseconds, masterTimeSlot: scene!.masterTimeSlot,
    });
    if (!resolved.value) return finish("unavailable", resolved.gaps);
    context = resolved.value;
    if (expectedParentSongId !== undefined && context.underlyingSongId !== expectedParentSongId)
      return finish("unavailable", [gap("native-challenge-parent-chart-mismatch", String(expectedParentSongId))]);
  }
  const songId = context?.underlyingSongId ?? (request.chart as { songId: number }).songId;
  const key = context ? `challenge:${context.challengeMusicId}:${request.chart.difficulty}` : `${songId}:${request.chart.difficulty}`;
  if ((request.constraints.lockedSongKey && request.constraints.lockedSongKey !== key) || request.constraints.excludedSongKeys.includes(key)) {
    result.issues.push({ path: "chart", code: "locked-or-excluded-chart" }); return finish("invalid");
  }
  const scoreDomain = request.mode === "gekiso" ? request.scoreDomain ?? "personal-solo" : undefined;
  if (context && scoreDomain === "personal-live") return finish("unavailable",
    [gap("native-manual-challenge-live-score-unresolved", key)]);
  if (request.nativeGekisoPlans && (request.mode !== "gekiso" || scoreDomain !== "personal-live"))
    return finish("unavailable", [gap("native-manual-gekiso-plan-domain-unresolved", key)]);
  let song: SongOption;
  if (pinned) {
    if (pinned.identity.server !== data.identity.server || pinned.identity.releaseId !== data.identity.releaseId ||
        pinned.identity.sourceId !== data.identity.sourceId || pinned.song.songId !== songId ||
        pinned.song.difficulty !== request.chart.difficulty) return finish("unavailable", [gap("manual-chart-source-mismatch", key)]);
    song = structuredClone(pinned.song);
  } else {
    controls.progress?.("loading");
    const loading = new AbortController();
    const deadline = setTimeout(() => loading.abort(), Math.max(1, request.budget.maxMilliseconds - elapsed()));
    const cancellation = setInterval(() => { if (cancelled()) loading.abort(); }, 250);
    try { [song] = await loadSongOptions(data, [{ songId, difficulty: request.chart.difficulty }], loading.signal,
      { nativeGekisoPerfectPlan: scoreDomain === "personal-live" }); }
    catch { stop = interrupt(); return finish(stop ?? "unavailable", stop ? [] : [gap("manual-chart-load-unresolved", key)]); }
    finally { clearTimeout(deadline); clearInterval(cancellation); }
  }
  song!.key = key;
  if (context && request.mode === "gekiso") song!.segments = song!.segments.map((row,index) =>
    ({ ...row, mission: context!.missionTypes[index]! }));
  if (request.constraints.excludeJustMissions && song!.segments.some(row => row.mission === 3)) {
    result.issues.push({ path: "chart", code: "excluded-just-mission" }); return finish("invalid");
  }
  stop = interrupt(); if (stop) return finish(stop);
  controls.preparedSong?.({ identity: { ...data.identity, sourceId: data.identity.sourceId! },
    song: structuredClone(song!) });
  // Unselected unknown practice cannot block a fixed formation. All player
  // modifiers stay intact; validateAssignment already checked the full locks.
  const memberIds = new Set(request.assignment.memberInstanceIds);
  const photoIds = new Set(request.assignment.snapshotInstanceIds);
  const inventory = { ...request.inventory, members: request.inventory.members.filter(row => memberIds.has(row.instanceId)),
    snapshots: request.inventory.snapshots.filter(row => photoIds.has(row.instanceId)) };
  const activeObjectives = request.objectives.filter(value => value !== "event-items");
  const prepared = prepareEvaluationForSearch({ ...request, inventory, songs: [song!],
    mode: request.mode, scoreDomain, challengeMusicId: context?.challengeMusicId,
    eventScene: scene, objectives: activeObjectives.length ? activeObjectives : ["score"],
    budget: { maxMilliseconds: request.budget.maxMilliseconds, maxEvaluations: 1, maxCandidates: 1 } });
  const input = prepared.input;
  const { resolveSlots, evaluate } = prepared;
  const chart = prepareSong(song!, input.evaluation);
  const bindingGaps: EvidenceGap[] = [];
  for (const [index,id] of request.assignment.snapshotInstanceIds.entries()) if (id !== null) {
    const photo = input.snapshots.find(row => row.instanceId === id);
    const member = input.members.find(row => row.instanceId === request.assignment.memberInstanceIds[index]);
    if (!photo || !member || !photo.allowedCharacterIds?.includes(member.characterId))
      bindingGaps.push(gap("manual-snapshot-binding-unresolved", `${index}:${id}`));
  }
  const profiles: readonly (ResolvedSlotProfile | undefined)[] = resolveSlots?.(request.assignment, chart) ?? [];
  result.slots = request.assignment.memberInstanceIds.map((id,index) => ({ index,
    member: structuredClone(inventory.members.find(row => row.instanceId === id)!),
    snapshot: structuredClone(inventory.snapshots.find(row => row.instanceId === request.assignment.snapshotInstanceIds[index]) ?? null),
    power: profiles[index] && !profiles[index]!.gaps.length ? profiles[index]!.power : null,
    gaps: profiles[index] ? [...profiles[index]!.gaps] : [gap("manual-slot-power-detail-unresolved", id)] }));
  const common = [...input.evaluation.gaps, ...input.inputGaps ?? [], ...bindingGaps];
  if (common.length) return finish("unavailable", common);
  controls.progress?.("evaluating");
  const candidate = await evaluate(request.assignment, chart, { cancelled,
    expired, yield: controls.yield ?? (() => new Promise<void>(resolve => setTimeout(resolve, 0))),
    progress: () => controls.progress?.("evaluating") });
  stop = interrupt(); if (stop) return finish(stop);
  if (request.objectives.includes("event-items")) candidate.metrics["event-items"] =
    unavailableMetric("native-event-server-selection-law-unresolved", "complete joint selected RewardId law");
  candidate.assignment = structuredClone(request.assignment);
  candidate.vector = request.objectives.map(objective => candidate.metrics[objective].value ?? NaN);
  result.candidate = candidate;
  const gaps = request.objectives.flatMap(objective => candidate.metrics[objective].gaps);
  const floors = request.constraints.bonusFloors;
  if (floors && (floors.eventPointsBP !== undefined || floors.eventItemsBP !== undefined)) {
    candidate.eventBonusBP ??= { points: null, items: null,
      gaps: [gap("native-event-scene-required", "manual formation bonus floors")] };
    for (const [axis,floor] of [["points", floors.eventPointsBP], ["items", floors.eventItemsBP]] as const) if (floor !== undefined) {
      const value = candidate.eventBonusBP[axis];
      if (value === null || candidate.eventBonusBP.gaps.length) gaps.push(...candidate.eventBonusBP.gaps,
        gap("manual-event-bonus-floor-unresolved", axis));
      else if (value < floor) gaps.push(gap("manual-event-bonus-below-floor", `${axis}:${value}<${floor}`));
    }
  }
  return finish(request.objectives.every(objective => candidate.metrics[objective].value !== null &&
    !candidate.metrics[objective].gaps.length) && !gaps.length ? "complete" : "unavailable", gaps);
}

/** Fixed choices are never offered to an optimizer or changed by this module. */
export function evaluateManualTeamChart(request: ManualTeamChartRequest, controls: ManualTeamChartControls = {}) {
  return runManualTeam(structuredClone(request), controls);
}
/** Pure worker-local entry for an already loaded same-pin canonical chart. */
export function evaluatePreparedManualTeamChart(request: ManualTeamChartRequest, pinned: PinnedManualTeamSong,
  controls: ManualTeamChartControls = {}) {
  return runManualTeam(structuredClone(request), controls, pinned);
}

export interface ManualTeamControls extends Omit<ManualTeamChartControls, "progress"> {
  progress?: (progress: ManualTeamProgress) => void;
}
export interface ManualTeamDetailedResult extends ManualTeamEvaluationResult {
  /** Physical slot and practice details in requested chart order. */
  charts: ManualTeamChartResult[];
  issues: InventoryIssue[];
}

async function runManualCharts(request: ManualTeamPreparationInput, controls: ManualTeamControls,
  pinned?: readonly PinnedManualTeamSong[]): Promise<ManualTeamDetailedResult> {
  const snapshot = structuredClone(request), now = controls.now ?? (() => performance.now()), started = now();
  const elapsed = () => Math.max(0, now() - started);
  const result: ManualTeamDetailedResult = { ...snapshot.data.identity,
    schema: "haneoka-manual-team-result-v1", sourceId: snapshot.data.identity.sourceId ?? "",
    assignment: structuredClone(snapshot.assignment), status: "unavailable", candidates: [],
    elapsedMs: 0, gaps: [], charts: [], issues: [] };
  const progress = (phase: ManualTeamProgress["phase"]) => controls.progress?.({ phase,
    chartsCompleted: result.charts.length, totalCharts: snapshot.selections.length, elapsedMs: elapsed() });
  const finish = (status: ManualTeamDetailedResult["status"]) => {
    result.status = status; result.gaps = unique(result.gaps); result.elapsedMs = elapsed(); progress("complete"); return result;
  };
  try { validateSearchBudget(snapshot.budget); }
  catch { result.gaps.push(gap("manual-budget-invalid", "request.budget")); return finish("unavailable"); }
  if (!snapshot.selections.length || snapshot.selections.length > 1000 ||
      new Set(snapshot.selections.map(row => `${row.songId}:${row.difficulty}`)).size !== snapshot.selections.length)
    { result.gaps.push(gap("manual-chart-selection-invalid", "requested chart list")); return finish("unavailable"); }
  if (!["normal", "gekiso"].includes(snapshot.mode)) {
    result.gaps.push(gap("native-manual-mode-unresolved", snapshot.mode)); return finish("unavailable");
  }
  if (snapshot.challengeMusicId !== undefined && snapshot.selections.length !== 1) {
    result.gaps.push(gap("native-challenge-parent-chart-mismatch", "one wrapper requires one parent chart")); return finish("unavailable");
  }
  if (pinned && pinned.length !== snapshot.selections.length) {
    result.gaps.push(gap("manual-chart-selection-mismatch", "prepared chart list")); return finish("unavailable");
  }
  for (const [index,selection] of snapshot.selections.entries()) {
    if (controls.cancelled?.()) return finish("cancelled");
    const remaining = Math.floor(snapshot.budget.maxMilliseconds - elapsed());
    if (remaining < 1) return finish("budget-limited");
    const chartRequest: ManualTeamChartRequest = { ...snapshot,
      schema: "haneoka-manual-team-request-v1", chart: snapshot.challengeMusicId !== undefined
        ? { challengeMusicId: snapshot.challengeMusicId, difficulty: selection.difficulty } : selection,
      mode: snapshot.mode as "normal" | "gekiso",
      budget: { maxMilliseconds: remaining } };
    const chart = await runManualTeam(chartRequest, { ...controls, now,
      progress: phase => progress(phase === "loading" ? "loading" : "evaluation"),
    }, pinned?.[index], snapshot.challengeMusicId !== undefined ? selection.songId : undefined);
    if (chart.status === "cancelled" || chart.status === "budget-limited") return finish(chart.status);
    result.charts.push(chart); result.issues.push(...chart.issues); result.gaps.push(...chart.gaps,
      ...chart.issues.map(row => gap(row.code, row.path)));
    if (chart.candidate) result.candidates.push(chart.candidate);
  }
  return finish(result.charts.every(chart => chart.status === "complete") ? "complete" : "unavailable");
}

/** Canonical manual-prepare protocol: fixed assignment, one result per chart.
 * GK defaults to its personal Solo ledger; Live is an explicit request.
 */
export function evaluateManualTeam(request: ManualTeamPreparationInput, controls: ManualTeamControls = {}) {
  return runManualCharts(request, controls);
}
export function evaluatePreparedManualTeam(request: ManualTeamPreparationInput,
  pinned: readonly PinnedManualTeamSong[], controls: ManualTeamControls = {}) {
  return runManualCharts(request, controls, pinned);
}
