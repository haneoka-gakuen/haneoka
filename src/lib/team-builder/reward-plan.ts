// L3 — GEB
// Input: 活动奖励方案、旧收益设置与挑战演出选择。
// Output: 有序奖励层、折算系数与当前场景的有效方案。
// Pos: [Map](L2-2.md)；活动收益目标与引擎输入之间的纯转换。
// Effects/Dependencies: 不执行计算、联网或持久化。
import type { RewardMetric, RewardRankingPlan, SongRef } from "./engine/api";

export const REWARD_METRICS: readonly RewardMetric[] = ["points", "challenge-points", "items"];
export type RewardMode = "ignore" | "convert" | "tie";
export interface RewardOption {
  mode: RewardMode;
  rate: number | null;
  auto: boolean;
}
export interface RewardPlan {
  criterion?: "mean" | "max" | "min";
  minimumRank?: number;
  primary: RewardMetric;
  options: Record<RewardMetric, RewardOption>;
  tieOrder: RewardMetric[];
}
const RATE_SCALE = 10_000;
export const MAX_REWARD_RATE = 100_000;

export function rewardPlan(primary: RewardMetric = "points"): RewardPlan {
  return {
    primary,
    options: {
      points: { mode: "ignore", rate: null, auto: false },
      "challenge-points": { mode: "ignore", rate: null, auto: false },
      items: { mode: "ignore", rate: null, auto: false },
    },
    tieOrder: [],
  };
}

export function changeRewardMode(plan: RewardPlan, metric: RewardMetric, mode: RewardMode): RewardPlan {
  const order = plan.tieOrder.filter((value) => value !== metric);
  return {
    ...plan,
    options: { ...plan.options, [metric]: { ...plan.options[metric], mode } },
    tieOrder: mode === "tie" ? [...order, metric] : order,
  };
}

export function changePrimaryReward(plan: RewardPlan, primary: RewardMetric): RewardPlan {
  if (primary === plan.primary) return plan;
  let next = changeRewardMode(plan, primary, "ignore");
  if (next.options[plan.primary].mode === "ignore") next = changeRewardMode(next, plan.primary, "tie");
  return {
    ...next,
    primary,
    options: Object.fromEntries(
      REWARD_METRICS.map((metric) => [metric, { ...next.options[metric], rate: null }]),
    ) as RewardPlan["options"],
  };
}

export function rewardFirst(plan: RewardPlan, metric: RewardMetric): RewardPlan {
  return plan.tieOrder.includes(metric)
    ? { ...plan, tieOrder: [metric, ...plan.tieOrder.filter((value) => value !== metric)] }
    : plan;
}

export function legacyRewardPlan(settings: {
  measure: RewardMetric;
  weighted: boolean;
  weightPoints: number;
  weightItems: number;
  weightCp: number;
  ptCycle: boolean;
}): RewardPlan {
  if (!settings.weighted) {
    let plan = rewardPlan(settings.measure);
    if (settings.measure !== "challenge-points")
      plan = changeRewardMode(plan, settings.measure === "points" ? "items" : "points", "tie");
    if (settings.ptCycle && settings.measure !== "challenge-points") {
      plan = changeRewardMode(plan, "challenge-points", "convert");
      plan.options["challenge-points"].auto = true;
    }
    return plan;
  }
  const weights: Record<RewardMetric, number> = {
    points: settings.weightPoints,
    items: settings.weightItems,
    "challenge-points": settings.weightCp,
  };
  const primary = REWARD_METRICS.find((metric) => weights[metric] > 0) ?? settings.measure;
  let plan = rewardPlan(primary);
  for (const metric of REWARD_METRICS)
    if (metric !== primary && weights[metric] > 0) {
      plan = changeRewardMode(plan, metric, "convert");
      plan.options[metric].rate = weights[metric] / weights[primary];
    }
  return plan;
}

export function effectiveRewardPlan(plan: RewardPlan, challenge: boolean): RewardPlan {
  if (!challenge) return plan;
  const effective = plan.primary === "challenge-points" ? changePrimaryReward(plan, "points") : plan;
  return changeRewardMode(effective, "challenge-points", "ignore");
}

export function compileRewardPlan(
  plan: RewardPlan,
  challenge: { songs: SongRef[]; consumption: number },
): RewardRankingPlan | null {
  const first = [{ metric: plan.primary, weight: RATE_SCALE }];
  let auto = false;
  for (const metric of REWARD_METRICS) {
    const option = plan.options[metric];
    if (metric === plan.primary || option.mode !== "convert") continue;
    if (metric === "challenge-points" && option.auto) {
      auto = true;
      continue;
    }
    if (option.rate === null || !Number.isFinite(option.rate) || option.rate < 0 || option.rate > MAX_REWARD_RATE)
      return null;
    const weight = Math.round(option.rate * RATE_SCALE);
    if (weight > 0) first.push({ metric, weight });
  }
  if (auto && (!challenge.songs.length || challenge.consumption <= 0)) return null;
  const ties = plan.tieOrder.filter((metric) => metric !== plan.primary && plan.options[metric].mode === "tie");
  return {
    unit: RATE_SCALE,
    criterion: plan.criterion ?? "mean",
    ...(plan.minimumRank ? { minimumRank: plan.minimumRank } : {}),
    levels: [first, ...ties.map((metric) => [{ metric, weight: 1 }])],
    ...(auto ? { autoCp: { songs: challenge.songs, consumption: challenge.consumption } } : {}),
  };
}
