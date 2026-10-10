/** Settle every sampled lottery outcome and skill order before taking the reward mean. */
import { battleRank, type CompiledChart } from "./chart";
import { eventItems, eventPoints, type EventRoute } from "./objectives";
import { exchangedReward, type CpExchange } from "./pt-value";

export interface GekisoRewardOptions {
  /** Player's baseline fraction on eligible JUST notes; skills subsequently convert individual notes. */
  just: number;
  /** Fixed native RNG draws, shared by all teams. Never the payout of the expected score. */
  luckSamples: number;
  rank: 1;
}
export const DEFAULT_GEKISO_REWARDS: GekisoRewardOptions = { just: 0.25, luckSamples: 32, rank: 1 };

export interface GekisoSettlement {
  rewardSum: number;
  comparisonSum: number;
  cpSum: number;
  observations: number;
  directMin: number;
  directMax: number;
  mean: number;
  ranks: Map<number, number>;
}

export function settleGekisoRewards(
  chart: Pick<CompiledChart, "ranks">,
  route: EventRoute,
  measure: "points" | "items",
  bonus: number,
  scoreSamples: Iterable<ArrayLike<number>>,
  exchange?: CpExchange,
): GekisoSettlement {
  const result = settleGekisoRewardsProgressive(chart, route, measure, bonus, scoreSamples, exchange);
  if ("pruned" in result) throw new Error("gekiso-reward-unexpected-cutoff");
  return result;
}

export interface RewardCutoff {
  key: number;
  /** True only if an exactly evaluated local team already wins an equality. External floors retain ties. */
  pruneEqual: boolean;
}
export type GekisoPartialSettlement = GekisoSettlement | { pruned: true; upperBound: number; observations: number };

export function settleGekisoRewardsProgressive(
  chart: Pick<CompiledChart, "ranks">,
  route: EventRoute,
  measure: "points" | "items",
  bonus: number,
  scoreSamples: Iterable<ArrayLike<number>>,
  exchange?: CpExchange,
  progress?: { observations: number; ceiling: number; cutoff: RewardCutoff },
): GekisoPartialSettlement {
  if (route.kind !== "live") throw new Error("gekiso-reward-route");
  if (
    progress &&
    (!Number.isSafeInteger(progress.observations) ||
      progress.observations < 1 ||
      !Number.isSafeInteger(progress.ceiling) ||
      progress.ceiling < 0 ||
      !Number.isSafeInteger(progress.observations * progress.ceiling))
  )
    throw new Error("gekiso-reward-precision");
  let rewardSum = 0,
    comparisonSum = 0,
    cpSum = 0,
    observations = 0;
  let directMin = Infinity,
    directMax = -Infinity;
  const ranks = new Map<number, number>();
  for (const scores of scoreSamples) {
    if (!scores.length) throw new Error("gekiso-reward-empty-sample");
    for (let i = 0; i < scores.length; i++) {
      const score = scores[i]!;
      if (!Number.isFinite(score) || score < 0) throw new Error("gekiso-reward-score");
      const rank = battleRank(chart, score);
      if (
        measure === "points"
          ? !route.points.has(rank)
          : !route.rewards.some((r) => r.scoreRank === rank && r.resourceId === route.itemId)
      )
        throw new Error(`gekiso-reward-rank:${rank}`);
      if (exchange && !route.challengePoints.has(rank)) throw new Error(`gekiso-reward-cp:${rank}`);
      const cp = (route.challengePoints.get(rank) ?? 0) * route.rate;
      const reward = measure === "points" ? eventPoints(route, bonus, rank) : eventItems(route, bonus, rank);
      rewardSum += reward;
      cpSum += cp;
      comparisonSum += exchange ? exchangedReward(reward, cp, exchange) : reward;
      observations++;
      if (![rewardSum, cpSum, comparisonSum].every(Number.isSafeInteger) || comparisonSum > Number.MAX_SAFE_INTEGER / 2)
        throw new Error("gekiso-reward-precision");
      directMin = Math.min(directMin, reward);
      directMax = Math.max(directMax, reward);
      ranks.set(rank, (ranks.get(rank) ?? 0) + 1);
    }
    if (progress) {
      if (observations > progress.observations) throw new Error("gekiso-reward-sample-count");
      if (observations < progress.observations) {
        // Every remaining outcome receives the highest reachable table reward. This can overestimate, never
        // underestimate, the requested fixed-sample mean. A partial mean is never emitted as an exact result.
        const numerator = comparisonSum + (progress.observations - observations) * progress.ceiling;
        if (!Number.isSafeInteger(numerator)) throw new Error("gekiso-reward-precision");
        const upperBound = numerator / progress.observations;
        if (upperBound < progress.cutoff.key || (progress.cutoff.pruneEqual && upperBound === progress.cutoff.key))
          return { pruned: true, upperBound, observations };
      }
    }
  }
  if (!observations) throw new Error("gekiso-reward-empty-sample");
  if (progress && observations !== progress.observations) throw new Error("gekiso-reward-sample-count");
  return {
    rewardSum,
    comparisonSum,
    cpSum,
    observations,
    directMin,
    directMax,
    mean: comparisonSum / observations,
    ranks,
  };
}
