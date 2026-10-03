import type { EvidenceGap } from "../contracts.ts";
import type { SearchEvaluationControls } from "../optimizer.ts";
import { resolveFixedResourceCycle, type FixedResourceCycle, type FixedResourceCycleInput } from "./resource-cycle.ts";

export interface FixedNormalResourceSummaryInput {
  /** Ordered complete CP marginal; never replace it with mean CP. */
  normal: readonly { probability: number; challengePoints: number }[];
  boostBudget: number;
  boostPerNormalPlay: number;
  initialChallengePoints: number;
  challengePointCost: number;
  budget: FixedResourceCycleInput["budget"];
}
export type FixedNormalResourceSummary = Pick<FixedResourceCycle,
  "normalPlays" | "expectedChallengePlays" | "boostSpent" | "boostRemaining" |
  "expectedChallengePointsGained" | "expectedChallengePointsSpent" |
  "expectedChallengePointsRemaining" | "remainingChallengePoints" | "transitions" | "assumptions">;

/** One normal law's convolution, reusable for every zero-CP challenge and
 * requested reward axis in the same immutable stage/parameter generation. */
export async function resolveFixedNormalResourceSummary(input: FixedNormalResourceSummaryInput,
  controls?: SearchEvaluationControls): Promise<{ value: FixedNormalResourceSummary | null; gaps: EvidenceGap[] }> {
  const result = await resolveFixedResourceCycle({ ...input,
    normal: input.normal.map((row) => ({ ...row, eventPoints: 0, eventItems: 0 })),
    challenge: [{ probability: 1, eventPoints: 0, eventItems: 0, challengePoints: 0 }],
  }, controls);
  if (!result.value) return { value: null, gaps: result.gaps };
  const { normalPlays, expectedChallengePlays, boostSpent, boostRemaining,
    expectedChallengePointsGained, expectedChallengePointsSpent, expectedChallengePointsRemaining,
    remainingChallengePoints, transitions, assumptions } = result.value;
  return { value: { normalPlays, expectedChallengePlays, boostSpent, boostRemaining,
    expectedChallengePointsGained, expectedChallengePointsSpent, expectedChallengePointsRemaining,
    remainingChallengePoints, transitions, assumptions }, gaps: [] };
}
