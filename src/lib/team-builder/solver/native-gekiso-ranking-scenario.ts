import type { EvidenceGap } from "../contracts.ts";
import type { TeamBuilderData } from "../data.ts";
import type { NativeGekisoSongPlan } from "./native-gekiso-evaluation.ts";
import type { NativeGekisoScoreRange } from "./native-gekiso-live-score.ts";
import { nativeGekisoAllComboDriverSupports } from "./native-gekiso-driver-profile.ts";

export interface NativeGekisoRankingScenario {
  /** Ranks already resolved by the time each native range is ready to settle. */
  ranks: readonly [number, number, number];
  availability: "confirmed-at-native-ready";
  source: "observed-native" | "explicit-scenario";
  reference: string;
}

/** Conditional confirmed-rank replay. The supplied ranks select the actual
 * Master range/rank percentages; they do not predict opponents or replace
 * their result-confirmation timing with a frame-rate assumption. */
export function resolveNativeGekisoRankingScenario(data: TeamBuilderData, plan: NativeGekisoSongPlan,
  scenario: NativeGekisoRankingScenario | undefined): {
    ranges: readonly NativeGekisoScoreRange[] | null; assumptions: string[]; gaps: EvidenceGap[];
  } {
  if (scenario === undefined) return { ranges: plan.ranges, assumptions: [], gaps: [] };
  const fail = (code: string, source: string) => ({ ranges: null, assumptions: [], gaps: [{ code, source }] });
  if (!scenario || scenario.availability !== "confirmed-at-native-ready" ||
    !["observed-native", "explicit-scenario"].includes(scenario.source) ||
    typeof scenario.reference !== "string" || !scenario.reference || scenario.reference.length > 1024 ||
    !Array.isArray(scenario.ranks) || scenario.ranks.length !== 3 ||
    Array.from(scenario.ranks).some(rank => !Number.isInteger(rank) || rank < 1 || rank > 5))
    return fail("native-gekiso-confirmed-rank-scenario-unresolved", "three confirmed ranks1..5 and native-ready evidence");
  if (!nativeGekisoAllComboDriverSupports(data.identity) || !plan.identity ||
    plan.identity.server !== data.identity.server || plan.identity.releaseId !== data.identity.releaseId ||
    !data.identity.sourceId || plan.identity.sourceId !== data.identity.sourceId)
    return fail("native-gekiso-rank-scenario-source-mismatch", "qualified same-pin native chart driver");
  if (!plan.producer || !["native-all-combo-ap-event-reduction-v1", "native-no-luck-ap-event-reduction-v1",
    "native-single-luck-ap-event-reduction-v1", "native-three-luck-ap-event-reduction-v1"].includes(plan.producer) ||
    !Array.isArray(plan.ranges) || plan.ranges.length !== 3 || !Array.isArray(plan.frames) ||
    Array.from(plan.ranges).some(range => !range || !Number.isSafeInteger(range.startTimeMs) ||
      !Number.isSafeInteger(range.endTimeMs) || range.startTimeMs < 0 || range.endTimeMs <= range.startTimeMs) ||
    plan.frames.some(frame => !frame || !Array.isArray(frame.rangeUpdates)))
    return fail("native-gekiso-rank-scenario-driver-unresolved", "native-ready event-reduction plan");
  for (const [index, range] of plan.ranges.entries()) {
    const ready = plan.frames.find(frame => frame.rangeUpdates.some(
      (update: NativeGekisoSongPlan["frames"][number]["rangeUpdates"][number]) => update.rangeIndex === index && update.simulateState === 7));
    if (!ready || ready.timeMs < range.endTimeMs || (index < 2 && ready.timeMs > plan.ranges[index + 1]!.startTimeMs))
      return fail("native-gekiso-rank-confirmation-boundary-unresolved", `range:${index}`);
  }
  return { ranges: plan.ranges.map((range, index) => ({ ...range, rank: scenario.ranks[index]! })),
    assumptions: ["native-confirmed-section-ranks-at-ready-boundary", "fixed-personal-note-and-skill-inputs-for-rank-scenario",
      `native-rank-scenario:${scenario.source}`], gaps: [] };
}
