import type { EvidenceGap } from "../contracts.ts";
import type { SearchEvaluationControls } from "../optimizer.ts";

export interface FixedPlayRewardOutcome {
  probability: number;
  eventPoints: number;
  eventItems: number;
  challengePoints: number;
}
export interface FixedResourceCycleInput {
  /** Complete native per-play outcomes for one fixed normal/challenge pair. */
  normal: readonly FixedPlayRewardOutcome[];
  challenge: readonly FixedPlayRewardOutcome[];
  boostBudget: number;
  boostPerNormalPlay: number;
  initialChallengePoints: number;
  challengePointCost: number;
  budget: { maxStates: number; maxTransitions: number };
}
export interface FixedResourceCycle {
  normalPlays: number;
  expectedChallengePlays: number;
  boostSpent: number;
  boostRemaining: number;
  expectedChallengePointsGained: number;
  expectedChallengePointsSpent: number;
  expectedChallengePointsRemaining: number;
  remainingChallengePoints: readonly { value: number; probability: number }[];
  eventPointExpectation: number;
  eventItemExpectation: number;
  ordinaryEventPointExpectation: number;
  ordinaryEventItemExpectation: number;
  challengeEventPointExpectation: number;
  challengeEventItemExpectation: number;
  transitions: number;
  assumptions: string[];
}
const int = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 0x7fffffff;
const failure = (code: string, source: string): { value: null; gaps: EvidenceGap[] } => ({
  value: null,
  gaps: [{ code, source }],
});

/** Fixed normal/challenge resource loop. Integer CP outcomes are convolved by
 * cost remainder; only the already completed whole-play reward laws are averaged.
 * The selected laws are independent per play. No cap, expiry, regeneration,
 * stage mixing or time limit is included in this explicitly defined scenario.
 */
export async function resolveFixedResourceCycle(
  input: FixedResourceCycleInput,
  controls?: SearchEvaluationControls,
): Promise<{ value: FixedResourceCycle | null; gaps: EvidenceGap[] }> {
  const source = "fixed normal/challenge whole-play resource laws";
  const valid = (outcomes: readonly FixedPlayRewardOutcome[]) =>
    outcomes.length > 0 &&
    outcomes.length <= 10000 &&
    outcomes.every(
      (outcome) =>
        Number.isFinite(outcome.probability) &&
        outcome.probability >= 0 &&
        int(outcome.eventPoints) &&
        int(outcome.eventItems) &&
        int(outcome.challengePoints),
    ) &&
    Math.abs(outcomes.reduce((sum, outcome) => sum + outcome.probability, 0) - 1) <= 1e-12;
  if (
    !valid(input.normal) ||
    !valid(input.challenge) ||
    !int(input.boostBudget) ||
    input.boostBudget > 2000 ||
    !int(input.boostPerNormalPlay) ||
    input.boostPerNormalPlay < 1 ||
    !int(input.initialChallengePoints) ||
    !int(input.challengePointCost) ||
    input.challengePointCost < 1 ||
    !int(input.budget.maxStates) ||
    input.budget.maxStates < 1 ||
    input.budget.maxStates > 100000 ||
    !int(input.budget.maxTransitions) ||
    input.budget.maxTransitions < 1 ||
    input.budget.maxTransitions > 2000000
  )
    return failure("resource-cycle-input-unresolved", source);
  if (input.challenge.some((outcome) => outcome.probability > 0 && outcome.challengePoints !== 0))
    return failure("resource-cycle-challenge-reinvestment-unresolved", source);
  const normalPlays = Math.floor(input.boostBudget / input.boostPerNormalPlay);
  const maximum = (
    outcomes: readonly FixedPlayRewardOutcome[],
    field: keyof Omit<FixedPlayRewardOutcome, "probability">,
  ) => Math.max(...outcomes.filter((outcome) => outcome.probability > 0).map((outcome) => outcome[field]));
  if (input.initialChallengePoints + normalPlays * maximum(input.normal, "challengePoints") > 0x7fffffff)
    return failure("resource-cycle-challenge-point-domain-unresolved", source);
  const maximumChallengePlays = Math.floor(
    (input.initialChallengePoints + normalPlays * maximum(input.normal, "challengePoints")) / input.challengePointCost,
  );
  if (
    (["eventPoints", "eventItems"] as const).some(
      (field) =>
        normalPlays * maximum(input.normal, field) + maximumChallengePlays * maximum(input.challenge, field) >
        Number.MAX_SAFE_INTEGER,
    )
  )
    return failure("resource-cycle-total-domain-unresolved", source);
  const cpLaw = new Map<number, number>();
  for (const outcome of input.normal)
    if (outcome.probability > 0)
      cpLaw.set(outcome.challengePoints, (cpLaw.get(outcome.challengePoints) ?? 0) + outcome.probability);
  let states = new Map([[input.initialChallengePoints % input.challengePointCost, 1]]);
  let expectedChallengePlays = Math.floor(input.initialChallengePoints / input.challengePointCost),
    transitions = 0;
  const interrupted = () => controls?.cancelled() || controls?.expired();
  const deterministic = cpLaw.size === 1 && cpLaw.values().next().value === 1;
  if (deterministic) {
    if (interrupted()) return failure("resource-cycle-interrupted", "worker cancellation/budget");
    if (controls && normalPlays > 0) {
      controls.progress();
      await controls.yield();
      if (interrupted()) return failure("resource-cycle-interrupted", "worker cancellation/budget");
    }
    const amount = input.initialChallengePoints + normalPlays * cpLaw.keys().next().value!;
    expectedChallengePlays = Math.floor(amount / input.challengePointCost);
    states = new Map([[amount % input.challengePointCost, 1]]);
    transitions = normalPlays > 0 ? 1 : 0;
  }
  for (let play = 0; !deterministic && play < normalPlays; play++) {
    if (interrupted()) return failure("resource-cycle-interrupted", "worker cancellation/budget");
    if (controls && play % 8 === 0) {
      controls.progress();
      await controls.yield();
    }
    const next = new Map<number, number>();
    let additionalPlays = 0;
    for (const [remaining, stateProbability] of states)
      for (const [gained, rewardProbability] of cpLaw) {
        if (++transitions > input.budget.maxTransitions) return failure("resource-cycle-transition-budget", source);
        if (controls && transitions % 1024 === 0) {
          if (interrupted()) return failure("resource-cycle-interrupted", "worker cancellation/budget");
          controls.progress();
          await controls.yield();
        }
        const amount = remaining + gained,
          probability = stateProbability * rewardProbability;
        if (probability === 0) continue;
        additionalPlays += probability * Math.floor(amount / input.challengePointCost);
        const remainder = amount % input.challengePointCost;
        next.set(remainder, (next.get(remainder) ?? 0) + probability);
        if (next.size > input.budget.maxStates) return failure("resource-cycle-state-budget", source);
      }
    expectedChallengePlays += additionalPlays;
    states = next;
  }
  if (interrupted()) return failure("resource-cycle-interrupted", "worker cancellation/budget");
  const expected = (
    outcomes: readonly FixedPlayRewardOutcome[],
    field: keyof Omit<FixedPlayRewardOutcome, "probability">,
  ) => outcomes.reduce((sum, outcome) => sum + outcome[field] * outcome.probability, 0);
  const ordinaryEventPointExpectation = normalPlays * expected(input.normal, "eventPoints");
  const ordinaryEventItemExpectation = normalPlays * expected(input.normal, "eventItems");
  const challengeEventPointExpectation = expectedChallengePlays * expected(input.challenge, "eventPoints");
  const challengeEventItemExpectation = expectedChallengePlays * expected(input.challenge, "eventItems");
  return {
    value: {
      normalPlays,
      expectedChallengePlays,
      boostSpent: normalPlays * input.boostPerNormalPlay,
      boostRemaining: input.boostBudget % input.boostPerNormalPlay,
      expectedChallengePointsGained: normalPlays * expected(input.normal, "challengePoints"),
      expectedChallengePointsSpent: expectedChallengePlays * input.challengePointCost,
      expectedChallengePointsRemaining: [...states].reduce((sum, [value, probability]) => sum + value * probability, 0),
      remainingChallengePoints: [...states]
        .sort(([a], [b]) => a - b)
        .map(([value, probability]) => ({ value, probability })),
      eventPointExpectation: ordinaryEventPointExpectation + challengeEventPointExpectation,
      eventItemExpectation: ordinaryEventItemExpectation + challengeEventItemExpectation,
      ordinaryEventPointExpectation,
      ordinaryEventItemExpectation,
      challengeEventPointExpectation,
      challengeEventItemExpectation,
      transitions,
      assumptions: [
        "fixed-normal-and-challenge-pairs",
        "independent-whole-play-reward-laws",
        "resource-cycle-no-cap-expiry-regeneration-or-time-limit",
      ],
    },
    gaps: [],
  };
}
