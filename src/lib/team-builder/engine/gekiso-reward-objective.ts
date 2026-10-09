/** Reward-first Gekisou search. The reward-table ceiling is safe even where Luck score bounds are not proven. */
import type { CompiledChart } from "./chart";
import type { EngineMaster } from "./master";
import { ORDERS, type OrderScores } from "./live";
import { performer } from "./full/deck";
import { gekisoContext, scoreOrdersGekiso, type GekisoChart } from "./gekiso";
import { gekisoJustSummary, type GekisoJustSummary } from "./gekiso-just";
import {
  settleGekisoRewardsProgressive,
  type GekisoSettlement,
  type GekisoRewardOptions,
  type RewardCutoff,
} from "./gekiso-rewards";
import { eventItems, eventPoints, type EventRoute } from "./objectives";
import { memberEventPercent, snapEventPercent, type MemberState, type SnapState } from "./power";
import { exchangedReward, type CpExchange } from "./pt-value";
import { resolveSlotSkill } from "./skills";
import type { ObjectiveAdapter, Team } from "./search";
import type { GekisoScoreCache } from "./gekiso-score-cache";
import type { GekisoContextCache } from "./gekiso-context-cache";
import { gekisoScoreBound, type GekisoScoreBound } from "./gekiso-score-bound";

export interface GekisoRewardDetail extends GekisoSettlement {
  bonus: number;
  scores: OrderScores;
  just: GekisoJustSummary;
  luckSamples: number;
  sampled: boolean;
}

export function gekisoRewardObjective(input: {
  master: EngineMaster;
  members: readonly MemberState[];
  snaps: readonly SnapState[];
  chart: CompiledChart;
  gekiso: GekisoChart;
  route: EventRoute;
  measure: "points" | "items";
  options: GekisoRewardOptions;
  exchange?: CpExchange;
  scoreCache?: GekisoScoreCache;
  contextCache?: GekisoContextCache;
}): ObjectiveAdapter<GekisoRewardDetail> {
  const { master, members, snaps, chart, gekiso, route, measure, options, exchange } = input;
  const bonusType = measure === "points" ? 0 : 1;
  const memberBonus = (i: number) => memberEventPercent(route.effects, members[i]!, bonusType);
  const snapBonus = (j: number) => snapEventPercent(route.effects, snaps[j]!, bonusType);
  const ranks = [...new Set([2, ...chart.ranks.filter((r) => r.battleRequired > 0).map((r) => r.rank)])];
  const value = (bonus: number, rank: number) => {
    const reward = measure === "points" ? eventPoints(route, bonus, rank) : eventItems(route, bonus, rank);
    const cp = (route.challengePoints.get(rank) ?? 0) * route.rate;
    return exchange ? exchangedReward(reward, cp, exchange) : reward;
  };
  const scoreCeiling = gekisoScoreBound(master, gekiso, members, snaps);
  // A single unsupported card must not disable safe score bounds for teams which do not use it. Bindings also
  // avoid giving a strong live skill a different slot's duration-extending photo. Bounds are leader-independent.
  const localBounds = new Map<string, GekisoScoreBound>();
  const teamBound = (team: Team) => {
    const key = team.members.map((member, slot) => `${member}:${team.snaps[slot]}`).sort().join("|");
    let bound = localBounds.get(key);
    if (bound) {
      localBounds.delete(key);
      localBounds.set(key, bound);
      return bound;
    }
    const chosen = team.members.map((i) => members[i]!);
    const equipped = team.snaps.map((i) => i < 0 ? null : snaps[i]!);
    bound = gekisoScoreBound(master, gekiso, chosen, [], equipped);
    if (localBounds.size >= 256) localBounds.delete(localBounds.keys().next().value!);
    localBounds.set(key, bound);
    return bound;
  };
  const ceiling = (power: number, bonus: number, bound = scoreCeiling) => {
    const upper = bound.score(power);
    const reachable = ranks.filter(
      (rank) =>
        rank === 2 || chart.ranks.some((r) => r.rank === rank && r.battleRequired > 0 && r.battleRequired <= upper),
    );
    return Math.max(...reachable.map((rank) => value(bonus, rank)));
  };
  const work = { sampleComputations: 0, sampleCacheHits: 0, sampleEarlyStops: 0 };
  const evaluate = (
    team: Team,
    power: number,
    cutoff?: RewardCutoff,
  ): { key: number; detail: GekisoRewardDetail } | { pruned: true; upperBound: number } => {
    const deck = team.members.map((i, slot) =>
      performer(master, members[i]!, team.snaps[slot]! < 0 ? null : snaps[team.snaps[slot]!]!),
    );
    const skills = team.members.map((i, slot) =>
      resolveSlotSkill(master, members[i]!, team.snaps[slot]! < 0 ? null : snaps[team.snaps[slot]!]!),
    );
    const cachePrefix = input.scoreCache?.prefix(gekiso, deck, skills, power);
    const contextPrefix = input.contextCache?.prefix(gekiso, deck);
    const bonus =
      team.members.reduce((sum, i) => sum + memberBonus(i), 0) +
      team.snaps.reduce((sum, j) => sum + (j < 0 ? 0 : snapBonus(j)), 0);
    const runs = gekiso.luck ? options.luckSamples : 1;
    if (!Number.isSafeInteger(runs) || runs < 1) throw new Error("gekiso-reward-samples");
    const scores = new Float64Array(ORDERS.length);
    let min = Infinity,
      max = -Infinity,
      minOrder = 0,
      maxOrder = 0;
    let just: GekisoJustSummary | undefined;
    // The generator retains only its current working draw; the optional trace cache has a separate byte budget.
    // Each outcome is settled immediately, before averaging rewards.
    function* samples() {
      for (let seed = 0; seed < runs; seed++) {
        let draw = cachePrefix === undefined ? undefined : input.scoreCache!.get(cachePrefix, seed);
        if (draw) work.sampleCacheHits++;
        else {
          const compute = () => gekisoContext(master, gekiso, deck, [seed]);
          const context = contextPrefix === undefined ? compute() : input.contextCache!.context(contextPrefix, seed, compute);
          draw = {
            just: gekisoJustSummary(gekiso, context),
            scores: scoreOrdersGekiso(master, gekiso, context, power, skills),
          };
          work.sampleComputations++;
          if (cachePrefix !== undefined) input.scoreCache!.put(cachePrefix, seed, draw);
        }
        const current = draw.just;
        if (!just) just = { ...current, effectiveHits: 0, convertedHits: 0 };
        just.effectiveHits += current.effectiveHits / runs;
        just.convertedHits += current.convertedHits / runs;
        const result = draw.scores;
        for (let i = 0; i < scores.length; i++) scores[i]! += result.scores[i]! / runs;
        if (result.min < min) {
          min = result.min;
          minOrder = result.minOrder;
        }
        if (result.max > max) {
          max = result.max;
          maxOrder = result.maxOrder;
        }
        yield result.scores;
      }
    }
    const settlement = settleGekisoRewardsProgressive(
      chart,
      route,
      measure,
      bonus,
      samples(),
      exchange,
      cutoff && Number.isFinite(cutoff.key)
        ? {
            observations: runs * ORDERS.length,
            ceiling: ceiling(power, bonus, teamBound(team)),
            cutoff,
          }
        : undefined,
    );
    if ("pruned" in settlement) {
      work.sampleEarlyStops++;
      return settlement;
    }
    just!.effectiveRate = just!.eligible ? just!.effectiveHits / just!.eligible : null;
    const summary: OrderScores = {
      power,
      scores,
      mean: scores.reduce((a, b) => a + b, 0) / ORDERS.length,
      min,
      max,
      minOrder,
      maxOrder,
    };
    return {
      key: settlement.mean,
      detail: { ...settlement, bonus, scores: summary, just: just!, luckSamples: runs, sampled: gekiso.luck },
    };
  };
  return {
    skill: () => [0, 0],
    memberBonus,
    snapBonus,
    work,
    // No empirical score bound or capped candidate shortlist participates in pruning.
    bound: (totals) => ceiling(totals.power, totals.bonus),
    leafBound: (team, totals) => ceiling(totals.power, totals.bonus, teamBound(team)),
    interval: (team, totals) => [
      Math.min(...ranks.map((rank) => value(totals.bonus, rank))),
      ceiling(totals.power, totals.bonus, teamBound(team)),
    ],
    evaluate: (team, power, _slotPowers, cutoff) => evaluate(team, power, cutoff),
    exact: (team, power) => {
      const result = evaluate(team, power);
      if ("pruned" in result) throw new Error("gekiso-reward-unexpected-cutoff");
      return result;
    },
  };
}
