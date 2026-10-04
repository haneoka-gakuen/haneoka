import type { Candidate, EvidenceGap, OptimizationInput, ResolvedSlotProfile, TeamAssignment } from "../contracts.ts";
import { dataRows, nativeRow, type TeamBuilderData } from "../data.ts";
import type { SearchEvaluationControls } from "../optimizer.ts";
import type { PreparedSong } from "../song-metrics.ts";
import { unavailableMetric } from "../score.ts";
import { resolveGekisoSSTargets } from "./gekiso-mission-luck.ts";

interface NormalPrepared {
  input: OptimizationInput;
  resolveSlots?: (assignment: TeamAssignment, song: PreparedSong) =>
    (ResolvedSlotProfile | undefined)[];
  resolveEventBonusBP?: (assignment: TeamAssignment) => NonNullable<Candidate["eventBonusBP"]>;
  evaluate: (
    assignment: TeamAssignment,
    song: PreparedSong,
    controls: SearchEvaluationControls,
  ) => Candidate | Promise<Candidate>;
}
const gap = (code: string, source: string): EvidenceGap => ({ code, source });
// These native Gekiso families affect the Live ledger or Gekiso judgement
// timing. The Solo ledger uses its own PERFECT timing, ordinary combo getter,
// no Gekiso combo getter and allowJustJudgementScore=false.
const liveOnlyFamilies = new Set([
  2000, 2001, 2004, 4004, 11001, 11002, 11003, 11005, 12000, 12004, 12006, 13000, 13002, 13005,
]);

/** Native personal SS consumes SoloScore. For original all-PERFECT timing,
 * its complete play is the shared normal engine; Gekiso fixed/rush/extra combo
 * commands target the separate Live controller. Full Live score stays unknown.
 */
export function createNativeGekisoSoloAssignmentValidator(data: TeamBuilderData, input: OptimizationInput) {
  const memberGaps = new Map<string, EvidenceGap[]>();
  const snapshotGaps = new Map<string, EvidenceGap[]>();
  const skillGaps = (
    kind: "gekiso" | "gekisoSupport",
    id: number,
    level: number | null,
    source: string,
  ): EvidenceGap[] => {
    if (id === 0) return [];
    if (level === null) return [gap("native-gekiso-solo-skill-level-unresolved", source)];
    const key = kind === "gekiso" ? "gekisouSkillID" : "gekisouSupportSkillID";
    const rows = dataRows(data.skills[kind]?.[String(id)]?.effects)
      .map(nativeRow)
      .filter((row) => row.level === level && (row[key] === undefined || row[key] === id));
    if (!rows.length) return [gap("native-gekiso-solo-skill-level-unresolved", source)];
    return rows
      .filter((row) => !liveOnlyFamilies.has(Number(row.skillEffectType)))
      .map((row) =>
        gap("native-gekiso-solo-effect-family-unresolved", `${source}/effect:${row.id}/type:${row.skillEffectType}`),
      );
  };
  for (const member of input.members)
    memberGaps.set(
      member.instanceId,
      skillGaps("gekiso", member.gekisoSkillId, member.gekisoSkillLevel, member.instanceId),
    );
  for (const snapshot of input.snapshots)
    snapshotGaps.set(
      snapshot.instanceId,
      snapshot.gekisoSupportSkills
        ? snapshot.gekisoSupportSkills.flatMap((skill) =>
            skillGaps("gekisoSupport", skill.id, skill.level, snapshot.instanceId),
          )
        : [gap("native-gekiso-solo-support-slots-unresolved", snapshot.instanceId)],
    );
  return (assignment: TeamAssignment): EvidenceGap[] => [
    ...assignment.memberInstanceIds.flatMap((id) => memberGaps.get(id) ?? [gap("native-gekiso-solo-member-unresolved", id)]),
    ...assignment.snapshotInstanceIds.flatMap((id) => id === null ? [] :
      (snapshotGaps.get(id) ?? [gap("native-gekiso-solo-snapshot-unresolved", id)])),
  ];
}

export function createNativeGekisoSoloEvaluator(data: TeamBuilderData, normal: NormalPrepared) {
  const validate = createNativeGekisoSoloAssignmentValidator(data, normal.input);
  const input: OptimizationInput = {
    ...normal.input,
    evaluation: {
      ...normal.input.evaluation,
      mode: "gekiso",
      assumptions: ["native-gekiso-personal-solo-perfect-timing", ...normal.input.evaluation.assumptions],
    },
  };
  return {
    input,
    ...(normal.resolveSlots ? { resolveSlots: normal.resolveSlots } : {}),
    ...(normal.resolveEventBonusBP ? { resolveEventBonusBP: normal.resolveEventBonusBP } : {}),
    async evaluate(
      assignment: TeamAssignment,
      song: PreparedSong,
      controls: SearchEvaluationControls,
    ): Promise<Candidate> {
      const local = validate(assignment);
      const candidate = await normal.evaluate(assignment, song, controls);
      const score = candidate.metrics.score;
      const threshold = normal.input.evaluation.songContexts[song.song.key]?.personalSS ?? null;
      const ss = resolveGekisoSSTargets({
        score: score.perPlayValue ?? score.value,
        scoreDomain: "personal-solo",
        ssThreshold: threshold,
        thresholdDomain: "personal-solo",
      });
      for (const objective of ["ss-ratio", "ss-surplus"] as const) {
        const metric = candidate.metrics[objective];
        if (local.length || !ss.value || metric.value === null) {
          candidate.metrics[objective] = {
            ...unavailableMetric("native-gekiso-solo-runtime-unresolved", song.song.key),
            gaps: [...metric.gaps, ...local, ...ss.gaps],
          };
        } else {
          metric.value = objective === "ss-ratio" ? ss.value.ratio : ss.value.surplus;
          metric.scoreDomain = "personal-solo";
          metric.assumptions.push("native-gekiso-personal-solo-perfect-timing");
          for (const entry of metric.breakdown ?? []) {
            if (entry.key.endsWith("numerator")) entry.source = "native personal-solo ledger";
            if (entry.key.endsWith("threshold")) entry.source = "same-release native personal SoloScore rank7";
          }
        }
      }
      if (input.objectives.includes("event-points")) {
        const metric = candidate.metrics["event-points"];
        if (local.length)
          candidate.metrics["event-points"] = {
            ...unavailableMetric("native-gekiso-solo-event-runtime-unresolved", song.song.key),
            gaps: [...metric.gaps, ...local],
          };
        else metric.assumptions.push("native-gekiso-personal-solo-perfect-timing");
      }
      if (input.scoreDomain === "personal-solo") {
        candidate.metrics.score = local.length
          ? {
              ...unavailableMetric("native-gekiso-solo-runtime-unresolved", song.song.key),
              gaps: [...score.gaps, ...local],
            }
          : {
              ...score,
              scoreDomain: "personal-solo",
              assumptions: [...score.assumptions, "native-gekiso-personal-solo-perfect-timing"],
              breakdown: [
                ...(score.breakdown ?? []),
                {
                  key: "personal-solo-score",
                  value: score.perPlayValue ?? score.value,
                  unit: "score",
                  source: "native personal-solo ledger",
                },
              ],
            };
      } else
        candidate.metrics.score = unavailableMetric(
          "native-gekiso-live-score-runtime-unresolved",
          "Live ledger needs Gekiso frame/skill/Luck/ranking state",
        );
      candidate.vector = input.objectives.map((objective) => candidate.metrics[objective].value ?? NaN);
      return candidate;
    },
  };
}
