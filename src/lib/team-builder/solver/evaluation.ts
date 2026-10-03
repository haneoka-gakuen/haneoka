import type {
  Candidate,
  EvidenceGap,
  EvaluationBasisRequest,
  Objective,
  OptimizationInput,
  PlayMode,
  PowerStats,
  SearchBudget,
  SearchConstraints,
  ScoreEvaluationModel,
  SongOption,
  TeamAssignment,
  NativeEventScene,
  MetricValue,
  SkillOrderCriterion,
} from "../contracts.ts";
import { dataRows, nativeRow, type TeamBuilderData } from "../data.ts";
import { inventoryOptions, type PowerResolver } from "../data/solver-input.ts";
import type { InventoryV1 } from "../inventory.ts";
import { addPower, calcMemberLevelOrRankPower, calcMemberTrainingPower, calcSnapshotBonusBP } from "./power.ts";
import { createAssignmentEvaluator } from "./evaluate.ts";
import { reuseAssignmentProfiles } from "../assignment-profile-cache.ts";
import { createNativeNormalSlotResolver } from "./native-normal.ts";
import { createNativeNormalScoreResolver, type NativeNormalPlayScoreLaw } from "./native-normal-score.ts";
import { createNativeGekisoSoloEvaluator } from "./native-gekiso-solo.ts";
import { createNativeEventPayoutResolver } from "./native-event-payout.ts";
import { validateNativeEventScene } from "./native-event-scene.ts";
import { nativeChallengePointTable } from "../data/reward-input.ts";
import { applyEvaluationBasis } from "./basis.ts";
import { unavailableMetric } from "../score.ts";
import type { PreparedSong } from "../song-metrics.ts";
import type { SearchEvaluationControls } from "../optimizer.ts";
import { nativeRuleGaps, nativeRuleSupports } from "./native-rule-profile.ts";
import { createNativeGekisoContextEvaluation, type NativeGekisoPlans } from "./native-gekiso-evaluation.ts";
const zero = (): PowerStats => ({ performance: 0, technique: 0, visual: 0 });
const rates = (row: Record<string, unknown>): PowerStats => ({
  performance: Number(row.performanceRate),
  technique: Number(row.technicRate),
  visual: Number(row.visualRate),
});
const find = (data: TeamBuilderData, table: string, group: number, field: string, value: number | null) =>
  value === null
    ? undefined
    : data.progression[table]?.find((row) => Number(row.group) === group && Number(row[field]) === value);
const gap = (code: string, source: string): EvidenceGap => ({ code, source });

/** Known card-growth components. The returned stats are the actual supplied
 * levels' growth, not final live power; prepareEvaluation gives them their own
 * base-score objective and carries full-score gaps separately.
 */
export const nativeGrowthPowerResolver: PowerResolver = {
  member(card, state, data) {
    const level = find(data, "memberCardLevels", card.levelGroup, "level", state.level);
    const training = find(data, "memberCardAwake", card.trainingGroup, "awakeCount", state.training);
    const rank = find(data, "memberCardRanks", card.awakeningGroup, "rank", state.awakening);
    if (!level || !training || !rank)
      return { stats: null, gaps: [gap("member-growth-row-missing", state.instanceId)] };
    const stats = addPower(
      calcMemberLevelOrRankPower(card.statMax, rates(level)),
      calcMemberTrainingPower(card.statMax, rates(training)),
      calcMemberLevelOrRankPower(card.statMax, rates(rank)),
    );
    return {
      stats,
      bpPower: {
        performance: stats.performance * 10000,
        technique: stats.technique * 10000,
        visual: stats.visual * 10000,
      },
      gaps: [],
    };
  },
  snapshot(card, state, data) {
    const level = find(data, "supportCardLevels", card.levelGroup, "level", state.level);
    if (!level) return { stats: null, gaps: [gap("snapshot-growth-row-missing", state.instanceId)] };
    const bonusBP = calcSnapshotBonusBP(card.statMax, rates(level));
    return { stats: zero(), bonusBP, gaps: [] };
  },
};

export interface EvaluationRequest {
  /** Internal explicit native playback provider, carried in the Worker request fingerprint. */
  nativeGekisoPlans?: NativeGekisoPlans;
  /** Internal: preserve Gekiso requirements while preparing its normal Solo ledger. */
  requireGekisoPractice?: true;
  skillOrderCriterion?: SkillOrderCriterion;
  scoreDomain?: "personal-solo" | "personal-live";
  data: TeamBuilderData;
  inventory: InventoryV1;
  songs: SongOption[];
  mode: PlayMode;
  objectives: Objective[];
  constraints: SearchConstraints;
  budget: SearchBudget;
  /** Native runtime plans are passed only after the full power/skill path is resolved. */
  nativeRuntime?: ScoreEvaluationModel;
  basis?: EvaluationBasisRequest;
  eventScene?: NativeEventScene;
}
/** Real inventory → actual growth rows → canonical chart → native note core.
 * base-score is a named component; full-score/rewards remain unavailable until
 * their runtime context is supplied. No unknown bonus is silently filled in.
 */
export function prepareEvaluation(request: EvaluationRequest): OptimizationInput {
  const { data, inventory, songs } = request;
  if (inventory.server !== data.identity.server || inventory.releaseId !== data.identity.releaseId)
    throw new RangeError("different-inventory-release");
  const requirements = request.nativeRuntime
    ? undefined
    : request.mode === "gekiso" || (request.mode === "normal" && request.requireGekisoPractice)
      ? { requiredMode: "gekiso" as const }
      : request.mode === "normal"
        ? { requiredMode: "normal" as const }
        : undefined;
  const options = inventoryOptions(inventory, data, nativeGrowthPowerResolver, requirements);
  if (request.nativeRuntime) {
    if (
      request.nativeRuntime.server !== data.identity.server ||
      request.nativeRuntime.releaseId !== data.identity.releaseId ||
      request.nativeRuntime.mode !== request.mode
    )
      throw new RangeError("different-runtime-context");
    return {
      ...data.identity,
      skillOrderCriterion: request.skillOrderCriterion,
      scoreDomain: request.scoreDomain,
      ...options,
      inputGaps: options.gaps,
      songs,
      objectives: request.objectives,
      constraints: request.constraints,
      budget: request.budget,
      basis: request.basis,
      evaluation: request.nativeRuntime,
    };
  }
  const tools = data.liveTools;
  const settingRows = dataRows(tools.liveSettings).map(nativeRow);
  const settings = Object.fromEntries(settingRows.map((row) => [String(row.key), Number(row.value)]));
  const noteRows = dataRows(tools.noteParameters).map(nativeRow);
  const judgementRows = dataRows(tools.judgementParameters).map(nativeRow);
  const timingRows = dataRows(tools.judgementTiming).map(nativeRow);
  const comboRows = dataRows(tools.comboScoreBonuses).map(nativeRow);
  const evaluation: ScoreEvaluationModel = {
    ...data.identity,
    mode: request.mode,
    scope: "growth-only",
    noteScorePercents: Object.fromEntries(
      noteRows.map((row) => [Number(row.noteOperateType), Number(row.scorePercent)]),
    ),
    justJudgementTypes: [
      ...new Set(
        timingRows.filter((row) => Number(row.noteSimulateJudgement) === 6).map((row) => Number(row.noteJudgementType)),
      ),
    ],
    comboBonuses: comboRows
      .filter((row) => Number(row.comboBonusType) === 0)
      .map((row) => ({ requiredCombo: Number(row.requiredComboCount), bonus: Number(row.bonusFactor) })),
    adjustmentFactor: settings.note_score_adjustment_factor!,
    lifeOnusFactor: settings.note_score_life_onus_factor!,
    perfectPercent: Number(judgementRows.find((row) => Number(row.noteSimulateJudgement) === 5)?.scorePercent),
    justPercent: Number(judgementRows.find((row) => Number(row.noteSimulateJudgement) === 6)?.scorePercent),
    slots: {},
    defaultSlots: {},
    songContexts: {},
    assumptions: ["growth-only-unboosted-component"],
    gaps: [],
  };
  if (
    ![evaluation.adjustmentFactor, evaluation.lifeOnusFactor, evaluation.perfectPercent, evaluation.justPercent].every(
      Number.isFinite,
    ) ||
    !noteRows.length ||
    !comboRows.length
  )
    evaluation.gaps.push(gap("native-score-master-inputs-incomplete", "same-release live-tools"));
  if (data.identity.server !== "intl")
    evaluation.gaps.push(gap("native-server-rules-unverified", data.identity.server));
  if (request.mode !== "normal")
    evaluation.gaps.push(gap("growth-only-component-requires-normal-mode", "native Gekiso/multi/battle runtime path"));
  if (request.objectives.some((objective) => objective !== "base-score"))
    evaluation.gaps.push(gap("full-runtime-context-required", "power/skill/SS/event native runtime path"));
  if (request.constraints.lockedSnapshotIds.length)
    evaluation.gaps.push(gap("snapshot-full-slot-path-unresolved", "native snapshot equip/power/skill runtime"));
  const growthSlots: NonNullable<ScoreEvaluationModel["defaultSlots"]>[string] = Object.fromEntries(
    options.members.map((member) => [
      member.instanceId,
      {
        "": {
          power: member.stats.performance + member.stats.technique + member.stats.visual,
          windows: [],
          gaps: [...member.gaps],
        },
      },
    ]),
  );
  for (const song of songs) {
    evaluation.defaultSlots![song.key] = growthSlots;
    evaluation.songContexts[song.key] = {
      eventBonusFactor: 1,
      life: 1000,
      assistModeFactor: 1,
      fixedScore: 0,
      personalSS: null,
      gaps: [],
    };
    // Named unboosted component uses positive LIFE and no assist; it does not
    // estimate the omitted player bonuses or skill activations.
  }
  return {
    ...data.identity,
    skillOrderCriterion: request.skillOrderCriterion,
    scoreDomain: request.scoreDomain,
    members: options.members,
    snapshots: options.snapshots,
    inputGaps: options.gaps,
    songs,
    objectives: request.objectives,
    constraints: request.constraints,
    budget: request.budget,
    basis: request.basis,
    evaluation,
  };
}

/** Worker-local formation evaluator. Its closures stay in the worker, so the
 * main thread does not construct a song × leader × member × snapshot matrix.
 */
export interface PreparedSearchEvaluation {
  input: OptimizationInput;
  resolveSlots?: ReturnType<typeof createNativeNormalSlotResolver>["resolveSlots"];
  evaluate: (
    assignment: TeamAssignment,
    song: PreparedSong,
    controls: SearchEvaluationControls,
  ) => Candidate | Promise<Candidate>;
}
export function prepareEvaluationForSearch(request: EvaluationRequest): PreparedSearchEvaluation {
  if (request.scoreDomain !== undefined && !["personal-solo", "personal-live"].includes(request.scoreDomain))
    throw new RangeError("score-domain");
  if (!request.nativeRuntime && request.nativeGekisoPlans === undefined && request.mode === "gekiso" &&
    request.scoreDomain !== "personal-solo" && request.objectives.includes("score") && request.constraints.justRate === 0) {
    return prepareEvaluationForSearch({ ...request, nativeGekisoPlans: Object.fromEntries(request.songs
      .filter((song) => song.nativeGekisoPlan).map((song) => [song.key, song.nativeGekisoPlan!])) });
  }
  if (request.nativeGekisoPlans !== undefined) {
    if (request.nativeRuntime || request.mode !== "gekiso" || request.scoreDomain === "personal-solo" ||
      request.constraints.justRate !== 0)
      throw new RangeError("native-gekiso-context-domain");
    const normal = prepareEvaluationForSearch({ ...request, nativeGekisoPlans: undefined,
      mode: "normal", scoreDomain: undefined, requireGekisoPractice: true });
    return createNativeGekisoContextEvaluation(request.data, normal, request.nativeGekisoPlans);
  }
  if (request.nativeRuntime && request.skillOrderCriterion === "worst-ap")
    throw new RangeError("worst-ap-requires-native-order-factory");
  if (request.skillOrderCriterion !== undefined && !["nominal-mean", "worst-ap"].includes(request.skillOrderCriterion))
    throw new RangeError("skill-order-criterion");
  if (request.skillOrderCriterion === "worst-ap" && request.constraints.justRate !== 0)
    throw new RangeError("worst-ap-requires-perfect-timing");
  if (request.scoreDomain !== undefined && request.scoreDomain !== "personal-solo")
    throw new RangeError("score-domain");
  if (
    !request.nativeRuntime &&
    request.mode === "gekiso" &&
    request.constraints.justRate === 0 &&
    request.objectives.length > 0 &&
    request.objectives.every(
      (objective) =>
        objective === "ss-ratio" ||
        objective === "ss-surplus" ||
        objective === "event-points" ||
        (objective === "score" && request.scoreDomain === "personal-solo"),
    )
  ) {
    const normal = prepareEvaluationForSearch({ ...request, mode: "normal", requireGekisoPractice: true });
    normal.input.evaluation.gaps.push(...nativeRuleGaps(request.data.identity, "personal-solo"));
    return createNativeGekisoSoloEvaluator(request.data, normal);
  }
  if (
    request.nativeRuntime ||
    request.mode !== "normal" ||
    request.objectives.every((objective) => objective === "base-score")
  ) {
    const input = prepareEvaluation(request);
    const evaluate = createAssignmentEvaluator(input);
    return { input, evaluate: (assignment: TeamAssignment, song: PreparedSong) => evaluate(assignment, song) };
  }
  const input = prepareEvaluation({ ...request, objectives: ["base-score"] });
  input.objectives = [...request.objectives];
  input.evaluation.scope = "native-runtime";
  input.evaluation.assumptions = request.eventScene
    ? ["native-explicit-single-held-event", `native-live-start:${request.eventScene.liveStartServerTime?.source}`]
    : ["normal-live-event-power-disabled"];
  input.evaluation.gaps = input.evaluation.gaps.filter((gap) => gap.code !== "snapshot-full-slot-path-unresolved");
  input.evaluation.gaps.push(...nativeRuleGaps(request.data.identity, "normal-score"));
  if (nativeRuleSupports(request.data.identity, "snapshot-equip")) {
    // Native edit/save paths validate owned support IDs and duplicates; the
    // photo's character list does not restrict the member assigned to its slot.
    const characters = [...new Set(input.members.map((member) => member.characterId))];
    for (const snapshot of input.snapshots) {
      snapshot.allowedCharacterIds = characters;
      snapshot.gaps = snapshot.gaps.filter((gap) => gap.code !== "native-snapshot-equip-restriction-unverified");
    }
  }
  const scene = request.eventScene;
  if (scene) input.evaluation.gaps.push(...validateNativeEventScene(request.data, scene));
  if (scene?.kind === "challenge")
    input.evaluation.gaps.push(
      gap("native-challenge-score-boot-context-unresolved", "challenge chart/power/rank overrides"),
    );
  if (request.objectives.includes("event-points") && !scene)
    input.evaluation.gaps.push(gap("native-event-scene-required", "recorded or identified live-start context"));
  if (request.objectives.includes("event-items"))
    input.evaluation.gaps.push(
      gap("native-event-server-selection-law-unresolved", "complete joint server RewardId outcomes"),
    );
  const cp = nativeChallengePointTable(request.data);
  const payouts = new Map<number, ReturnType<typeof createNativeEventPayoutResolver>>();
  const payoutFor = (songId: number) => {
    const cached = payouts.get(songId);
    if (cached) return cached;
    const result = createNativeEventPayoutResolver(request.data, request.inventory, {
      eventId: scene!.eventId,
      songId,
      kind: scene!.kind,
      consumption: scene!.consumedCount,
      ...(cp.table ? { challengePointTable: cp.table } : {}),
    });
    if (payouts.size >= 32) payouts.delete(payouts.keys().next().value!);
    payouts.set(songId, result);
    return result;
  };
  const eventPower = scene && request.songs.length ? payoutFor(request.songs[0]!.songId) : undefined;
  if (scene && !eventPower) input.evaluation.gaps.push(gap("native-event-chart-required", "selected canonical chart"));
  if (eventPower) input.evaluation.gaps.push(...eventPower.powerGaps);
  const native = createNativeNormalSlotResolver(request.data, request.inventory, input, eventPower);
  const score = createNativeNormalScoreResolver(request.data, input);
  input.evaluation.gaps.push(...native.gaps, ...score.gaps);
  const lifeRow = dataRows(request.data.liveTools.liveSettings)
    .map(nativeRow)
    .find((row) => row.key === "life_base");
  const initialLife = Number(lifeRow?.value);
  if (!Number.isSafeInteger(initialLife) || initialLife < 1 || initialLife > 0x7fffffff)
    input.evaluation.gaps.push(gap("native-normal-life-base-unresolved", "MasterLiveSettings/life_base"));
  const usable = new Set(input.members.map((member) => member.instanceId));
  for (const state of request.inventory.members)
    if (
      !state.excluded &&
      !request.constraints.excludedMemberIds.includes(state.instanceId) &&
      !usable.has(state.instanceId)
    )
      input.evaluation.gaps.push(gap("native-normal-incomplete-member-search", state.instanceId));
  const usableSnapshots = new Set(input.snapshots.map((snapshot) => snapshot.instanceId));
  for (const state of request.inventory.snapshots)
    if (
      !state.excluded &&
      !request.constraints.excludedSnapshotIds.includes(state.instanceId) &&
      !usableSnapshots.has(state.instanceId)
    )
      input.evaluation.gaps.push(gap("native-normal-incomplete-snapshot-search", state.instanceId));
  const rankRows = dataRows(request.data.liveTools.scoreRanks).map(nativeRow);
  const ssByGroup = new Map(
    rankRows.filter((row) => row.liveScoreRank === 7).map((row) => [Number(row.group), Number(row.requiredScore)]),
  );
  for (const song of request.songs) {
    const threshold = ssByGroup.get(Number(request.data.songs[String(song.songId)]?.liveScoreRankGroup));
    input.evaluation.songContexts[song.key]!.personalSS =
      threshold !== undefined && threshold > 0 && Number.isSafeInteger(threshold) ? threshold : null;
    if (Number.isSafeInteger(initialLife) && initialLife > 0)
      input.evaluation.songContexts[song.key]!.life = initialLife;
  }
  const profilesCache = reuseAssignmentProfiles(native.resolveSlots, request);
  const evaluate = createAssignmentEvaluator(input, profilesCache.resolve);
  return {
    input,
    resolveSlots: profilesCache.resolve,
    evaluate: async (assignment: TeamAssignment, song: PreparedSong, controls: SearchEvaluationControls) => {
      const profiles = profilesCache.resolve(assignment, song, controls);
      let law: NativeNormalPlayScoreLaw | undefined;
      const metric = await score.score(
        assignment,
        song,
        profiles,
        controls,
        scene && request.objectives.includes("event-points")
          ? (value) => {
              law = value;
            }
          : undefined,
      );
      const candidate = evaluate(assignment, song, metric);
      if (scene && request.objectives.includes("event-points")) {
        let points: MetricValue = unavailableMetric("native-event-complete-play-law-unresolved", song.song.key);
        if (law && metric.value !== null && !controls.cancelled() && !controls.expired()) {
          const payout = payoutFor(song.song.songId);
          const amounts = law.outcomes.map((outcome) => ({
            ...outcome,
            points: payout.resolve(assignment, { nativeLiveMode: 0, soloScore: outcome.score, roomPlayers: [] }, null)
              .eventPoints,
          }));
          const gaps = amounts.flatMap((outcome) => outcome.points.gaps);
          if (!gaps.length && amounts.every((outcome) => outcome.points.value !== null)) {
            const minimum = Math.min(...amounts.map((outcome) => outcome.points.value!));
            const value =
              request.skillOrderCriterion === "worst-ap"
                ? minimum
                : amounts.reduce((sum, outcome) => sum + outcome.points.value! * outcome.multiplicity, 0) /
                  law.nominalOrders;
            points = {
              value,
              skillOrderCriterion: request.skillOrderCriterion ?? "nominal-mean",
              status: "conditional",
              assumptions: [...metric.assumptions, "native-personal-solo-event-rank", "client-event-point-amount"],
              gaps: [],
              range: {
                minimum,
                maximum: Math.max(...amounts.map((outcome) => outcome.points.value!)),
              },
              breakdown: [
                {
                  key: "complete-event-play-orders",
                  value: law.nominalOrders,
                  unit: "count",
                  source: "complete native shuffle plays before rank/rounding",
                },
                { key: "event-consumed-count", value: scene.consumedCount, unit: "count", source: scene.kind },
                { key: "event-points-per-play", value, unit: "count", source: "native client result saver" },
              ],
            };
          } else points.gaps.push(...gaps);
        }
        const basis = request.basis;
        if (
          basis?.kind === "consumption" &&
          (basis.amount !== scene.consumedCount ||
            basis.resource !== (scene.kind === "normal" ? "live-boost" : "challenge-point"))
        )
          points = unavailableMetric("native-event-consumption-basis-mismatch", `${scene.kind}:${scene.consumedCount}`);
        candidate.metrics["event-points"] = applyEvaluationBasis(points, "event-points", song.song.key, request.basis);
        candidate.vector = input.objectives.map((objective) => candidate.metrics[objective].value ?? NaN);
      }
      return candidate;
    },
  };
}
