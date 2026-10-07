/** Objective adapters: bounds for the search and exact values for survivors. */
import type { CompiledChart } from "./chart";
import { scoreRank } from "./chart";
import { ORDERS, isAllPerfect, playJudgements, scoreOrdersAP, scoreOrdersPlay, type LiveSettings, type OrderScores, type PlayModel, type PreparedLive } from "./live";
import type { EngineMaster, EventEffectRow, RewardRow } from "./master";
import { conversionWeights, linearChart, linearPlayChart, playBoundsChart, playOrderBounds, skillWeights, type LinearChart, type SkillWeights } from "./model";
import { memberEventPercent, snapEventPercent, type MemberState, type SnapState } from "./power";
import { type ObjectiveAdapter, type Team, type Totals } from "./search";
import { resolveSlotSkill, windowMs, type SlotSkill } from "./skills";

export type Criterion = "mean" | "min" | "max";
export interface LiveDetail {
  scores: OrderScores;
  skills: SlotSkill[];
}
export interface EventDetail extends LiveDetail {
  /** Points (or items) per play for each order. */
  perOrder: Float64Array;
  mean: number;
  bonus: number;
  ranks: Map<number, number>;
  challengePoints: number;
}

interface Shared {
  master: EngineMaster;
  members: readonly MemberState[];
  snaps: readonly SnapState[];
}
const slotSkillCache = (shared: Shared) => {
  const cache = new Map<string, SlotSkill>();
  return (member: number, snap: number) => {
    const key = `${member}:${snap}`;
    let value = cache.get(key);
    if (!value) cache.set(key, (value = resolveSlotSkill(shared.master, shared.members[member]!, snap < 0 ? null : shared.snaps[snap]!)));
    return value;
  };
};

export function powerObjective(): ObjectiveAdapter<null> {
  return {
    skill: () => [0, 0],
    memberBonus: () => 0,
    snapBonus: () => 0,
    bound: (totals) => totals.power,
    interval: (_team, totals) => [totals.power, totals.power],
    exact: (_team, power) => ({ key: power, detail: null }),
  };
}

export interface LiveContext extends Shared {
  live: PreparedLive;
  play: PlayModel;
  settings?: LiveSettings;
}
function liveCore(context: LiveContext) {
  const judgements = isAllPerfect(context.play) ? null : playJudgements(context.live.chart.count, context.play);
  // The all-Perfect play bounds every play from above; the played pattern without conversions or
  // recoveries bounds it from below.
  const slotSkill = slotSkillCache(context);
  // At most five activations convert, each up to its own limit.
  let conversions = 0,
    raise = 0;
  if (judgements)
    for (let member = 0; member < context.members.length; member++)
      for (let snap = -1; snap < context.snaps.length; snap++) {
        const skill = slotSkill(member, snap);
        const limit = skill.convert?.limit ?? 0;
        if (limit > conversions) conversions = Number.isFinite(limit) ? limit : context.live.chart.count;
        raise = Math.max(raise, skill.effects.reduce((total, effect) => total + effect.delta / 100000, 0));
      }
  let maxRecovery = 0;
  if (judgements)
    for (let member = 0; member < context.members.length; member++)
      for (let snap = -1; snap < context.snaps.length; snap++) maxRecovery = Math.max(maxRecovery, slotSkill(member, snap).recovery);
  const high: LinearChart = judgements ? linearPlayChart(context.live, judgements, "high", 0, 1, maxRecovery) : linearChart(context.live);
  void conversions;
  // How many skill windows can cover one note on this chart bounds any note's factor.
  let overlap = 1;
  {
    const times = context.live.chart.skillTimes;
    let longest = 0;
    for (let member = 0; member < context.members.length; member++)
      for (let snap = -1; snap < context.snaps.length; snap++) {
        const skill = slotSkill(member, snap);
        for (const effect of skill.effects) longest = Math.max(longest, windowMs(effect.seconds, skill.extensionMs));
      }
    for (const time of times) overlap = Math.max(overlap, times.filter((other) => other <= time && time < other + longest).length);
  }
  const factorCap = 1 + overlap * raise;
  const low: LinearChart = judgements ? linearPlayChart(context.live, judgements, "low") : high;
  const weights = new Map<string, { high: SkillWeights; low: SkillWeights }>();
  const weightOf = (member: number, snap: number) => {
    const key = `${member}:${snap}`;
    let value = weights.get(key);
    if (!value) {
      const skill = slotSkill(member, snap);
      const upper = skillWeights(high, skill);
      if (judgements && skill.convert) {
        // Conversions are this slot's own upside; fold them into its optimistic weights.
        const extra = conversionWeights(high, judgements, skill, factorCap);
        let total = 0;
        for (let event = 0; event < 5; event++) {
          upper.perEvent[event]! += extra[event]!;
          total += upper.perEvent[event]!;
        }
        upper.mean = total / 5;
        upper.best = Math.max(...upper.perEvent);
      }
      weights.set(key, (value = { high: upper, low: low === high ? upper : skillWeights(low, skill) }));
    }
    return value;
  };
  const divisor = context.live.chart.convertedCount;
  const scoreHigh = (totals: Totals) => ((totals.power * (high.total + totals.skill)) / divisor) * (1 + high.relativeError);
  const scoreLow = (totals: Totals) =>
    Math.max(0, ((totals.power * (low.total + totals.skillLow)) / divisor) * (1 - low.relativeError) - low.absoluteError);
  const evaluate = (team: Team, power: number): LiveDetail => {
    const skills = team.members.map((member, slot) => slotSkill(member, team.snaps[slot]!));
    const scores = judgements
      ? scoreOrdersPlay(context.live, power, skills, judgements, context.settings)
      : scoreOrdersAP(context.live, power, skills, context.settings);
    return { scores, skills };
  };
  const playBounds = judgements ? playBoundsChart(context.live, judgements) : null;
  /** Per-order linear scores of a complete team: [low, high] for each of the 120 orders. */
  const orderBounds = (team: Team, power: number) => {
    const lows = new Float64Array(ORDERS.length),
      highs = new Float64Array(ORDERS.length);
    if (playBounds) {
      const skills = team.members.map((member, slot) => slotSkill(member, team.snaps[slot]!));
      ORDERS.forEach((order, index) => {
        [lows[index], highs[index]] = playOrderBounds(playBounds, skills, order, power);
      });
      return { lows, highs };
    }
    const slots = team.members.map((member, slot) => weightOf(member, team.snaps[slot]!));
    ORDERS.forEach((order, index) => {
      let lowSum = 0,
        highSum = 0;
      for (let event = 0; event < 5; event++) {
        const slot = slots[order[event]!]!;
        lowSum += slot.low.perEvent[event]!;
        highSum += slot.high.perEvent[event]!;
      }
      lows[index] = scoreLow({ power, skill: 0, skillLow: lowSum, bonus: 0 });
      highs[index] = scoreHigh({ power, skill: highSum, skillLow: 0, bonus: 0 });
    });
    return { lows, highs };
  };
  // A complete team recovers at most its own best recovery per activation: its optimistic life
  // (and so the 0-life penalty) is far tighter than the box-wide one.
  const teamModels = new Map<number, { model: LinearChart; weights: Map<string, number> }>();
  const teamHigh = (team: Team, totals: Totals) => {
    if (!judgements) return scoreHigh(totals);
    let recovery = 0;
    team.members.forEach((member, slot) => (recovery = Math.max(recovery, slotSkill(member, team.snaps[slot]!).recovery)));
    if (recovery >= maxRecovery) return scoreHigh(totals);
    let entry = teamModels.get(recovery);
    if (!entry) teamModels.set(recovery, (entry = { model: linearPlayChart(context.live, judgements, "high", 0, 1, recovery), weights: new Map() }));
    let skill = 0;
    team.members.forEach((member, slot) => {
      const key = `${member}:${team.snaps[slot]}`;
      let weight = entry!.weights.get(key);
      if (weight === undefined) {
        const slotSkillValue = slotSkill(member, team.snaps[slot]!);
        const weights = skillWeights(entry!.model, slotSkillValue);
        if (slotSkillValue.convert) {
          const extra = conversionWeights(entry!.model, judgements, slotSkillValue, factorCap);
          for (let event = 0; event < 5; event++) weights.perEvent[event]! += extra[event]!;
        }
        weight = Math.max(...weights.perEvent);
        entry!.weights.set(key, weight);
      }
      skill += weight;
    });
    return ((totals.power * (entry.model.total + skill)) / divisor) * (1 + high.relativeError);
  };
  const drains = !!playBounds && playBounds.damage.reduce((total, row) => total + row.amount, 0) >= context.live.master.live.lifeBase;
  // scoreHigh = power × (productBase + skill) / productScale: what a score threshold needs of that product.
  const productScale = divisor / (1 + high.relativeError);
  return { weightOf, scoreHigh, scoreLow, evaluate, orderBounds, play: !!judgements, teamHigh, drains, slotSkill, productBase: high.total, productScale };
}

export function liveScoreObjective(context: LiveContext, criterion: Criterion): ObjectiveAdapter<LiveDetail> {
  const core = liveCore(context);
  return {
    skill(member, snap) {
      const { high, low } = core.weightOf(member, snap);
      return criterion === "min" ? [low.worst, high.mean] : criterion === "max" ? [low.mean, high.best] : [low.mean, high.mean];
    },
    memberBonus: () => 0,
    snapBonus: () => 0,
    bound: core.scoreHigh,
    productBase: core.productBase,
    leafBound: core.play ? (team, totals) => core.teamHigh(team, totals) : undefined,
    hard: core.drains,
    preferSnap: core.drains ? (member, snap) => core.slotSkill(member, snap).recovery : undefined,
    interval(team, totals) {
      if (criterion === "mean" && !core.play) return [core.scoreLow(totals), core.scoreHigh(totals)];
      // Converting a Miss or Bad also spares its damage and combo: those teams take the exact score.
      if (core.play && team.members.some((member, slot) => core.slotSkill(member, team.snaps[slot]!).convert?.judgements.some((j) => j <= 2))) {
        const scores = core.evaluate(team, totals.power).scores;
        const key = criterion === "min" ? scores.min : criterion === "max" ? scores.max : scores.mean;
        return [key, key];
      }
      const { lows, highs } = core.orderBounds(team, totals.power);
      if (criterion === "mean") return [lows.reduce((a, b) => a + b, 0) / lows.length, highs.reduce((a, b) => a + b, 0) / highs.length];
      const pick = criterion === "min" ? Math.min : Math.max;
      return [pick(...lows), pick(...highs)];
    },
    exact(team, power) {
      const detail = core.evaluate(team, power);
      const key = criterion === "min" ? detail.scores.min : criterion === "max" ? detail.scores.max : detail.scores.mean;
      return { key, detail };
    },
  };
}

/** Event bonus first, power second: a near-instant search whose top teams are strong seeds for event payoffs (the best
 * event teams carry the most bonus that still reaches the top rank). */
export function eventBonusSurrogate(shared: Shared, effects: readonly EventEffectRow[], measure: "points" | "items", bonusWeight = 2 ** 24): ObjectiveAdapter<null> {
  const bonusType = measure === "points" ? 0 : 1;
  // bonusWeight trades bonus (1/10000 units) for power: sweeping it traces the bonus/power front.
  const key = (bonus: number, power: number) => bonus * bonusWeight + power;
  return {
    skill: () => [0, 0],
    memberBonus: (i) => memberEventPercent(effects, shared.members[i]!, bonusType),
    snapBonus: (j) => snapEventPercent(effects, shared.snaps[j]!, bonusType),
    bound: (totals) => key(totals.bonus, totals.power),
    interval: (_team, totals) => [key(totals.bonus, totals.power), key(totals.bonus, totals.power)],
    exact: (team, power) => {
      const bonus =
        team.members.reduce((sum, i) => sum + memberEventPercent(effects, shared.members[i]!, bonusType), 0) +
        team.snaps.reduce((sum, j) => sum + (j < 0 ? 0 : snapEventPercent(effects, shared.snaps[j]!, bonusType)), 0);
      return { key: key(bonus, power), detail: null };
    },
  };
}

/** The largest linear upper bound on any order's score over all teams: a valid global score cap that needs no exact
 * scoring (every team's best-order score is at most its own linear high bound). */
export function scoreCapObjective(context: LiveContext): ObjectiveAdapter<null> {
  const core = liveCore(context);
  return {
    skill(member, snap) {
      const { high } = core.weightOf(member, snap);
      return [high.best, high.best];
    },
    memberBonus: () => 0,
    snapBonus: () => 0,
    bound: core.scoreHigh,
    interval: (_team, totals) => {
      const value = core.scoreHigh(totals);
      return [value, value];
    },
    exact: (team, power) => ({ key: core.scoreHigh({ power, skill: team.members.reduce((sum, member, slot) => sum + core.weightOf(member, team.snaps[slot]!).high.best, 0), skillLow: 0, bonus: 0 }), detail: null }),
  };
}

/** Best total of five rows assigned to five distinct columns (a skill order): bitmask DP, no allocation. */
const order5 = new Float64Array(32);
function bestOrder5(rows: readonly Float64Array[]): number {
  order5.fill(-Infinity);
  order5[0] = 0;
  for (let mask = 0; mask < 31; mask++) {
    const base = order5[mask]!;
    if (base === -Infinity) continue;
    // Row index = number of columns already taken.
    let row = 0;
    for (let m = mask; m; m &= m - 1) row++;
    const weights = rows[row]!;
    for (let column = 0; column < 5; column++) {
      const bit = 1 << column;
      if (mask & bit) continue;
      const value = base + weights[column]!;
      if (value > order5[mask | bit]!) order5[mask | bit] = value;
    }
  }
  return order5[31]!;
}

/** Event point / item rules of one play route. */
export interface EventRoute {
  kind: "live" | "challenge" | "skip";
  /** Event point multiplier of the boost / challenge-point consumption. */
  rate: number;
  /** Reward multiplier for items. */
  rewardRate: number;
  /** rank → points per play at rate 1. */
  points: ReadonlyMap<number, number>;
  rewards: readonly RewardRow[];
  itemId: number;
  /** rank → challenge points at rate 1 (normal lives earn them). */
  challengePoints: ReadonlyMap<number, number>;
  effects: readonly EventEffectRow[];
}
export const eventPoints = (route: EventRoute, bonus: number, rank: number) => {
  const value = route.points.get(rank) ?? 0;
  return route.kind === "challenge"
    ? Math.trunc(Math.imul(Math.imul(value, route.rate), (bonus + 10000) | 0) / 10000)
    : Math.trunc(Math.imul(Math.imul((bonus + 10000) | 0, route.rate), value) / 10000);
};
export const eventItems = (route: EventRoute, bonus: number, rank: number) => {
  let total = 0;
  for (const reward of route.rewards)
    if (reward.scoreRank === rank && (!route.itemId || reward.resourceId === route.itemId))
      total += (Math.trunc(Math.imul(Math.imul(reward.count, (bonus + 10000) | 0), route.rewardRate) / 10000) * reward.probability) / 10000;
  return total;
};
/** Fixed skip rank, or the rank of each played order. */
export function eventObjective(
  context: (LiveContext & { chart: CompiledChart }) | (Shared & { chart: null }),
  route: EventRoute,
  measure: "points" | "items",
  skipRank: number,
  /** Event points worth of one challenge point (resource plans); 0 ignores challenge points. */
  challengePointWeight = 0,
  /** A proven upper bound on any team's score in any order: rank bounds never assume a rank above it. */
  scoreCap = Infinity,
): ObjectiveAdapter<EventDetail | { bonus: number; mean: number }> {
  const bonusType = measure === "points" ? 0 : 1;
  const value = (bonus: number, rank: number) =>
    (measure === "points" ? eventPoints(route, bonus, rank) : eventItems(route, bonus, rank)) +
    challengePointWeight * (route.challengePoints.get(rank) ?? 0) * route.rate;
  const memberBonus = (i: number) => memberEventPercent(route.effects, context.members[i]!, bonusType);
  const snapBonus = (j: number) => snapEventPercent(route.effects, context.snaps[j]!, bonusType);
  // Ties on points prefer the stronger team.
  const TIE = 1 / 2 ** 36;
  /** Search range of the bonus inversion (BP; 10000 = 100 %). */
  const MAX_BONUS = 1_000_000;
  if (route.kind === "skip" || !context.chart) {
    return {
      skill: () => [0, 0],
      memberBonus,
      snapBonus,
      bound: (totals) => value(totals.bonus, skipRank) + TIE * totals.power,
      interval: (_team, totals) => {
        const key = value(totals.bonus, skipRank) + TIE * totals.power;
        return [key, key];
      },
      exact(team, power) {
        const bonus = team.members.reduce((sum, i) => sum + memberBonus(i), 0) + team.snaps.reduce((sum, j) => sum + (j < 0 ? 0 : snapBonus(j)), 0);
        const mean = value(bonus, skipRank);
        return { key: mean + TIE * power, detail: { bonus, mean } };
      },
    };
  }
  const live = context as LiveContext & { chart: CompiledChart };
  const core = liveCore(live);
  const rankOf = (score: number) => scoreRank(live.chart, score);
  /** Least bonus whose payoff at `rank` reaches `target` (payoffs rise with bonus). */
  const bonusFor = (rank: number, target: number) => {
    if (value(MAX_BONUS, rank) < target) return Infinity;
    let low = 0,
      high = MAX_BONUS;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (value(mid, rank) >= target) high = mid;
      else low = mid + 1;
    }
    return low;
  };
  const targetCache = new Map<number, readonly { bonus: number; product: number }[]>();
  // Bounds only: the optimistic score of a partial team easily crosses the next rank's threshold that no team
  // reaches, which would make every node look as good as that rank. The cap is a proven maximum score.
  const rankBound = (score: number) => scoreRank(live.chart, Math.min(score, scoreCap));
  return {
    skill(member, snap) {
      const { high, low } = core.weightOf(member, snap);
      return [low.worst, high.best];
    },
    memberBonus,
    snapBonus,
    productBase: core.productBase,
    jointTargets(limit) {
      // Like `bound`, payoff only: some order must bring the payoff to the limit, at a rank its score reaches.
      let targets = targetCache.get(limit);
      if (!targets) {
        targets = live.chart.ranks
          .filter((row) => row.required <= scoreCap)
          .map((row) => ({ bonus: bonusFor(row.rank, limit), product: row.required * core.productScale }))
          .filter((row) => Number.isFinite(row.bonus));
        if (targetCache.size > 64) targetCache.clear();
        targetCache.set(limit, targets);
      }
      return targets;
    },
    // The best order of a complete team assigns each slot a distinct skill event: a 5×5 assignment over the slots'
    // per-event weights, far below the sum of each slot's best event.
    leafBound(team, totals) {
      if (core.play) return value(totals.bonus, rankBound(core.teamHigh(team, totals)));
      const skill = bestOrder5(team.members.map((member, slot) => core.weightOf(member, team.snaps[slot]!).high.perEvent));
      return value(totals.bonus, rankBound(core.scoreHigh({ ...totals, skill })));
    },
    bound: (totals) => {
      // Points only: equal-point teams are ordered by score among those found, but the bound does not try to
      // prove that order (proving it means enumerating every team tied at the top points).
      return value(totals.bonus, rankBound(core.scoreHigh(totals)));
    },
    interval(team, totals) {
      // The team's worst/best slot weights bound every order's score: when both ends share a rank, every order
      // has that rank and the points need no per-order work.
      const scoreLow = core.scoreLow(totals),
        scoreHigh = core.scoreHigh(totals);
      const rank = rankOf(scoreLow);
      if (rank === rankBound(scoreHigh)) {
        const points = value(totals.bonus, rank);
        return [points + TIE * scoreLow, points + TIE * scoreHigh];
      }
      const { lows, highs } = core.orderBounds(team, totals.power);
      let low = 0,
        high = 0,
        straddles = false;
      for (let index = 0; index < lows.length; index++) {
        const lowRank = rankOf(lows[index]!),
          highRank = rankBound(highs[index]!);
        if (lowRank !== highRank) straddles = true;
        low += value(totals.bonus, lowRank);
        high += value(totals.bonus, highRank);
      }
      // An order whose bounds straddle a rank threshold leaves the points interval wide open; scoring the team
      // exactly (120 orders, well under a millisecond) is far cheaper than the search it would otherwise keep alive.
      if (straddles) {
        const key = this.exact(team, totals.power, []).key;
        return [key, key];
      }
      return [low / lows.length + TIE * core.scoreLow(totals), high / highs.length + TIE * core.scoreHigh(totals)];
    },
    exact(team, power) {
      const detail = core.evaluate(team, power);
      const bonus = team.members.reduce((sum, i) => sum + memberBonus(i), 0) + team.snaps.reduce((sum, j) => sum + (j < 0 ? 0 : snapBonus(j)), 0);
      const perOrder = new Float64Array(ORDERS.length);
      const ranks = new Map<number, number>();
      let total = 0,
        challenge = 0;
      detail.scores.scores.forEach((score, index) => {
        const rank = rankOf(score);
        ranks.set(rank, (ranks.get(rank) ?? 0) + 1);
        perOrder[index] = value(bonus, rank);
        total += perOrder[index]!;
        challenge += (route.challengePoints.get(rank) ?? 0) * route.rate;
      });
      const mean = total / ORDERS.length;
      return {
        key: mean + TIE * detail.scores.mean,
        detail: { ...detail, perOrder, mean, bonus, ranks, challengePoints: route.kind === "live" ? challenge / ORDERS.length : 0 },
      };
    },
  };
}

/** Songless potential P·(1 + A/T): A sums each skill's raise × its window seconds. */
export function potentialObjective(shared: Shared, windowSeconds: number): ObjectiveAdapter<{ potential: number; area: number }> {
  const slotSkill = slotSkillCache(shared);
  const area = (member: number, snap: number) => {
    const skill = slotSkill(member, snap);
    let total = 0;
    for (const effect of skill.effects)
      if (effect.type === 2000 || effect.judgements.includes(5))
        if (effect.gate.kind !== "life-at-least" || (shared.master.live.lifeBase >= effect.gate.value) === effect.gate.positive)
          total += (effect.delta / 100000) * (windowMs(effect.seconds, skill.extensionMs) / 1000);
    return total;
  };
  const key = (power: number, sum: number) => power * (1 + sum / windowSeconds);
  return {
    skill: (member, snap) => {
      const value = area(member, snap);
      return [value, value];
    },
    memberBonus: () => 0,
    snapBonus: () => 0,
    bound: (totals) => key(totals.power, totals.skill) * (1 + 1e-12),
    interval: (_team, totals) => [key(totals.power, totals.skillLow), key(totals.power, totals.skill)],
    exact(team, power) {
      const sum = team.members.reduce((total, member, slot) => total + area(member, team.snaps[slot]!), 0);
      return { key: key(power, sum), detail: { potential: key(power, sum), area: sum } };
    },
  };
}
