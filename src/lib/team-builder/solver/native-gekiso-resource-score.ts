import type { OptimizationInput, ResolvedSlotProfile, TeamAssignment } from "../contracts.ts";
import type { TeamBuilderData } from "../data.ts";
import type { SearchEvaluationControls } from "../optimizer.ts";
import type { PreparedSong } from "../song-metrics.ts";
import { createNativeGekisoSoloAssignmentValidator } from "./native-gekiso-solo.ts";
import { createNativeNormalScoreResolver, type NativeNormalPlayScoreLaw } from "./native-normal-score.ts";
import { nativeRuleGaps } from "./native-rule-profile.ts";

/** GK personal event rank, EP and CP consume SoloScore. Its AP ledger uses
 * ordinary skills/timing; GK Live/rush/mission-rank points remain separate. */
export function createNativeGekisoResourceScoreResolver(data: TeamBuilderData, input: OptimizationInput) {
  const normal = createNativeNormalScoreResolver(data, input);
  const validate = createNativeGekisoSoloAssignmentValidator(data, input);
  const gaps = [...normal.gaps, ...nativeRuleGaps(data.identity, "personal-solo")];
  if (input.constraints.justRate !== 0)
    gaps.push({ code: "native-resource-perfect-play-required", source: "GK personal Solo score law" });
  return {
    gaps,
    async score(assignment: TeamAssignment, song: PreparedSong,
      profiles: readonly (ResolvedSlotProfile | undefined)[], controls: SearchEvaluationControls,
      onCompleteLaw?: (law: NativeNormalPlayScoreLaw) => void) {
      const local = [...gaps, ...validate(assignment)];
      if (local.length) return { value: null, status: "unavailable" as const, assumptions: [], gaps: local };
      const metric = await normal.score(assignment, song, profiles, controls, onCompleteLaw);
      if (metric.value !== null) {
        metric.scoreDomain = "personal-solo";
        metric.assumptions.push("native-gekiso-personal-solo-perfect-timing", "native-resource-SoloScore-rank");
      }
      return metric;
    },
  };
}
