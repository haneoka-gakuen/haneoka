import type { Candidate, ResolvedSlotProfile, TeamAssignment } from "../contracts.ts";
import { dataRows, objectRow, type DataRow, type TeamBuilderData } from "../data.ts";
import type { SearchEvaluationControls } from "../optimizer.ts";
import type { PreparedSong } from "../song-metrics.ts";
import { unavailableMetric } from "../score.ts";
import { applyEvaluationBasis } from "./basis.ts";
import type { PreparedSearchEvaluation } from "./evaluation.ts";
import { prepareGekisoRules } from "./gekiso-mission-luck.ts";
import { createNativeGekisoNoLuckLiveScoreResolver, type NativeGekisoScoreRange } from "./native-gekiso-live-score.ts";
import type { NativeGekisoRuntimeFrame } from "./native-gekiso-runtime.ts";
import { createNativeGekisoSoloEvaluator } from "./native-gekiso-solo.ts";
import { nativeGekisoAllComboDriverSupports } from "./native-gekiso-driver-profile.ts";
import { createNativeGekisoLuckLiveScoreResolver } from "./native-gekiso-luck-live.ts";

/** Same-pin playback context, supplied explicitly or produced from a qualified chart. */
export interface NativeGekisoSongPlan {
  producer?: "native-all-combo-ap-event-reduction-v1" | "native-no-luck-ap-event-reduction-v1" |
    "native-single-luck-ap-event-reduction-v1";
  identity: { server: string; releaseId: string; sourceId: string };
  missionPattern: number;
  frames: readonly NativeGekisoRuntimeFrame[];
  ranges: readonly NativeGekisoScoreRange[];
}
export type NativeGekisoPlans = Readonly<Record<string, NativeGekisoSongPlan>>;

export function nativeGekisoPlanMatchesIdentity(data: TeamBuilderData, plan: NativeGekisoSongPlan): boolean {
  return !!plan?.identity && plan.identity.server === data.identity.server &&
    plan.identity.releaseId === data.identity.releaseId && !!data.identity.sourceId &&
    plan.identity.sourceId === data.identity.sourceId;
}

/** Consume the provider's observed status before legacy rows. An explicit
 * empty/missing current table must never become a stale ready legacy table. */
export function resolveNativeGekisoContextTables(data: TeamBuilderData) {
  const definitions = [
    ["gekisouRankingScoreBonuses", "rankingScoreBonuses", "MasterLiveGekisouRankingScoreBonus"],
    ["gekisouLuckBasePoints", "luckBasePoints", "MasterLiveGekisouLuckBasePoint"],
    ["gekisouLuckBonusLots", "luckBonusLots", "MasterLiveGekisouLuckBonusLot"],
  ] as const;
  const rows: DataRow[][] = [], gaps: { code: string; source: string }[] = [];
  for (const [key, legacy, sourceTable] of definitions) {
    const meta = objectRow(objectRow(data.liveTools.tableAvailability)[key]);
    const observed = data.liveTools[key];
    if (Object.keys(meta).length) {
      const identity = objectRow(meta.identity);
      if (identity.server !== data.identity.server || identity.releaseId !== data.identity.releaseId ||
        !data.identity.sourceId || identity.sourceId !== data.identity.sourceId || meta.sourceTable !== sourceTable) {
        gaps.push({ code: "native-gekiso-context-table-source-mismatch", source: sourceTable });
        rows.push([]); continue;
      }
      if (meta.status === "missing") {
        gaps.push({ code: "native-gekiso-context-table-missing", source: sourceTable });
        rows.push([]); continue;
      }
      if (!["ready", "empty"].includes(String(meta.status)) || !Array.isArray(observed) ||
        meta.rowCount !== observed.length || (meta.status === "ready" ? !observed.length : observed.length !== 0)) {
        gaps.push({ code: "native-gekiso-context-table-status-unresolved", source: sourceTable });
        rows.push([]); continue;
      }
    }
    const value = observed === undefined && !Object.keys(meta).length ? data.gekisoRules[legacy] : observed;
    if (!Array.isArray(value) || value.some((row) => !row || typeof row !== "object" || Array.isArray(row) ||
      (objectRow(row).sourceTable !== undefined && objectRow(row).sourceTable !== sourceTable))) {
      gaps.push({ code: "native-gekiso-context-table-rows-unresolved", source: sourceTable });
      rows.push([]);
    } else rows.push(dataRows(value));
  }
  return { rankingBonuses: rows[0]!, luckBasePoints: rows[1]!, luckBonusLots: rows[2]!, gaps };
}

export function createNativeGekisoContextEvaluation(
  data: TeamBuilderData,
  normal: PreparedSearchEvaluation,
  plans: NativeGekisoPlans,
): PreparedSearchEvaluation {
  const solo = createNativeGekisoSoloEvaluator(data, normal);
  const score = createNativeGekisoNoLuckLiveScoreResolver(data, normal.input);
  const luckScore = createNativeGekisoLuckLiveScoreResolver(data, normal.input);
  const tables = resolveNativeGekisoContextTables(data);
  const prepared = new Map(normal.input.songs.map((song) => {
    const plan = plans[song.key];
    return [song.key, plan ? {
      plan,
      rules: !nativeGekisoPlanMatchesIdentity(data, plan)
        ? { value: null, gaps: [{ code: "native-gekiso-plan-source-mismatch", source: song.key }] }
        : tables.gaps.length ? { value: null, gaps: tables.gaps } : prepareGekisoRules({ identity: data.identity, expectedIdentity: data.identity,
        missionPattern: plan.missionPattern, settings: dataRows(data.liveTools.liveSettings),
        rankingBonuses: tables.rankingBonuses,
        luckBasePoints: tables.luckBasePoints,
        luckBonusLots: tables.luckBonusLots,
      }),
    } : null] as const;
  }));
  const input = { ...solo.input, scoreDomain: "personal-live" as const, evaluation: { ...solo.input.evaluation,
    gaps: [...solo.input.evaluation.gaps],
    assumptions: [...solo.input.evaluation.assumptions, "native-GK-personal-Live-context"],
  } };
  if (!normal.resolveSlots)
    input.evaluation.gaps.push({ code: "native-gekiso-slot-context-unresolved", source: "native normal slot factory" });
  if (![
    "v25-c0b6a1541e45-3a5d2eec9935-n653c6392",
    "v50-e5786b7ddada-79f2f470b3cf-m73807cbb0192-n7ba0928c",
  ].includes(data.identity.sourceId ?? "") && !nativeGekisoAllComboDriverSupports(data.identity))
    input.evaluation.gaps.push({ code: "native-gekiso-context-source-unreviewed", source: data.identity.sourceId ?? "sourceId" });
  return {
    input,
    async evaluate(assignment: TeamAssignment, song: PreparedSong, controls: SearchEvaluationControls): Promise<Candidate> {
      const candidate = await solo.evaluate(assignment, song, controls);
      if (input.objectives.includes("score")) {
        const context = prepared.get(song.song.key);
        let metric = unavailableMetric("native-gekiso-playback-context-missing", song.song.key);
        if (!context && song.song.nativeGekisoPlanGaps?.length)
          metric = { value: null, status: "unavailable", gaps: [...song.song.nativeGekisoPlanGaps], assumptions: [] };
        if (context && !context.rules.value)
          metric = { value: null, status: "unavailable", gaps: [...context.rules.gaps], assumptions: [] };
        if (context?.rules.value && normal.resolveSlots) {
          const profiles: readonly (ResolvedSlotProfile | undefined)[] = normal.resolveSlots(assignment, song);
          const singleLuck = context.plan.producer === "native-single-luck-ap-event-reduction-v1";
          metric = await (singleLuck ? luckScore : score).score(assignment, song, profiles, context.rules.value, {
            expectedIdentity: data.identity, assignment,
            missions: song.song.segments.map((range) => range.mission) as [1 | 2 | 3, 1 | 2 | 3, 1 | 2 | 3],
            frames: context.plan.frames, randomLaw: { kind: "uniform-residue" },
            projection: "expectations-only", budget: { maxStates: 10000, maxTransitions: 100000 },
            requireNoPendingLots: singleLuck,
          }, context.plan.ranges, controls);
          if (context.plan.producer)
            metric.assumptions = [...metric.assumptions.filter((value) => value !== "complete-native-update-frame-tape"),
              singleLuck ? "native-single-luck-ap-event-reduction" : context.plan.producer === "native-no-luck-ap-event-reduction-v1"
                ? "native-no-luck-ap-event-reduction" : "native-all-combo-ap-event-reduction",
              "uninterrupted-native-perfect-playback"];
        }
        candidate.metrics.score = applyEvaluationBasis(metric, "score", song.song.key, input.basis);
      }
      candidate.vector = input.objectives.map((objective) => candidate.metrics[objective].value ?? NaN);
      return candidate;
    },
  };
}
