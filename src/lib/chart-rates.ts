/** Score targets from per-power chart rates. A Live of power P with member skills s scores, up to each note's
 * truncation, P × (base + Σ over skill events of s.score·W(event, window) + s.perfect·W(event, window)), where the
 * window is five seconds plus the member's snap extension. */

/** Skill window lengths (ms): five seconds plus every snap extension, 0–6 s in 0.25 s steps (stacked support skills
 * reach 5 s). */
export const SKILL_WINDOWS = Array.from({ length: 25 }, (_, index) => 5000 + index * 250);
export interface ChartRates {
  /** Score per unit of power without skills, All Perfect. */
  base: number;
  /** A +100 % score skill's score per unit of power as [window of SKILL_WINDOWS][skill event]. */
  windows: number[][];
  /** Skip-ticket score per unit of power. */
  skip: number;
  /** Judged notes: each truncates its score, so a score is at most this much below power × rate. */
  notes: number;
  /** Each score rank as [rank, solo score, Gekisou score with five players]. */
  ranks: [number, number, number][];
}
export interface ChartRateTable {
  releaseId: string;
  /** A Great note's score over a Perfect note's. */
  greatFactor: number;
  /** Live boosts as [consumed, event point rate, reward rate]; no boost is rate 1. */
  boosts: [number, number, number][];
  /** Events with normal-live points: each score rank as [rank, points], and the event item rewards as
   * [rank, count, probability out of 10000], at rate 1. */
  events: {
    id: number;
    title: unknown;
    startAt: number | null;
    endAt: number | null;
    points: [number, number][];
    items: [number, number, number][];
  }[];
  /** `songId:difficulty` → its rates. */
  charts: Record<string, ChartRates>;
}
export const SKILL_ORDERS: number[][] = (() => {
  const out: number[][] = [];
  const walk = (prefix: number[]) => {
    if (prefix.length === 5) out.push(prefix);
    else for (let slot = 0; slot < 5; slot++) if (!prefix.includes(slot)) walk([...prefix, slot]);
  };
  walk([]);
  return out;
})();
const INT_MAX = 2147483647;
/** BattleLiveScoreRankCalculator.CalcRequiredScore: the room total a rank needs with `players` counted players. */
export function roomRequiredScore(battleRequired: number, players: number): number {
  if (players < 1) return INT_MAX;
  const value = Math.trunc(Math.sqrt(5 / players) * battleRequired * players);
  return value > INT_MAX ? -INT_MAX - 1 : value;
}
/** BattleLiveScoreRankCalculator.Calculate: the rank a room total reaches with `players` counted players, and the next
 * rank's room total. `ranks` is [rank, battleRequired] in ascending rank. */
export function roomRank(ranks: [number, number][], total: number, players: number) {
  let rank = 2;
  for (const [id, battleRequired] of ranks) {
    const required = roomRequiredScore(battleRequired, players);
    if (required > total) return { rank, next: { rank: id, required } };
    rank = id;
  }
  return { rank: Math.max(2, rank), next: null };
}
/** The solo score rank a score reaches; `ranks` is [rank, solo score, …] in ascending rank. */
export function soloRank(ranks: readonly (readonly number[])[], score: number): number {
  let rank = 2;
  for (const row of ranks) if (row[1]! <= score) rank = Math.max(rank, row[0]!);
  return rank;
}
/** One member's live skill: score up and Perfect score up in percent, and its snap's extension. */
export interface DeckSlot {
  score: number;
  perfect: number;
  extensionMs: number;
}
/** A chart's per-power weights at a Great share: base, and [window][event] for score-up and Perfect score-up skills.
 * A Great note scores greatFactor of a Perfect one, keeps the combo, and is no Perfect score-up target. */
export function liveWeights(rates: ChartRates, great: number, greatFactor: number) {
  const general = 1 - great * (1 - greatFactor);
  return {
    base: rates.base * general,
    general: rates.windows.map((row) => row.map((value) => value * general)),
    perfect: rates.windows.map((row) => row.map((value) => value * (1 - great))),
  };
}
/** Score per unit of power of each of the 120 skill orders. */
export function slotOrderRates(weights: ReturnType<typeof liveWeights>, slots: readonly DeckSlot[]): number[] {
  const window = (slot: DeckSlot) =>
    Math.min(SKILL_WINDOWS.length - 1, Math.max(0, Math.round(slot.extensionMs / 250)));
  return SKILL_ORDERS.map((order) => {
    let rate = weights.base;
    for (let event = 0; event < (weights.general[0]?.length ?? 0); event++) {
      const slot = slots[order[event]!];
      if (!slot) continue;
      const w = window(slot);
      rate += (slot.score / 100) * weights.general[w]![event]! + (slot.perfect / 100) * weights.perfect[w]![event]!;
    }
    return rate;
  });
}
/** The certain score of a rate at a power: below power × rate by at most one point per note. */
export const certainScore = (power: number, rate: number, notes: number) => power * rate * (1 - 2e-6) - notes;
/** Power that reaches a target score for certain, each note's truncation included: on the average of the orders, in
 * every order, and in the best order. */
export function slotPowerNeeded(target: number, orderRates: readonly number[], notes: number) {
  if (target <= 0) return { mean: 0, every: 0, best: 0 };
  const power = (rate: number) => Math.ceil((target + notes) / (rate * (1 - 2e-6)));
  return {
    mean: power(orderRates.reduce((sum, rate) => sum + rate, 0) / orderRates.length),
    every: power(Math.min(...orderRates)),
    best: power(Math.max(...orderRates)),
  };
}
/** Share of the orders that reach a target at a power for certain. */
export function slotReach(target: number, power: number, orderRates: readonly number[], notes: number): number {
  return orderRates.filter((rate) => certainScore(power, rate, notes) >= target).length / orderRates.length;
}
/** Event points of one normal live (LiveEventPoint × (1 + bonus) × boost rate, truncated like the game). */
export function eventLivePoints(points: number, bonusPercent: number, rate: number): number {
  return Math.trunc(Math.imul(Math.imul(Math.round(bonusPercent * 100) + 10000, rate), points) / 10000);
}
/** Expected event items of one normal live at a rank: each reward truncated like the game, then weighted. */
export function eventLiveItems(
  items: readonly (readonly number[])[],
  rank: number,
  bonusPercent: number,
  rate: number,
): number {
  let total = 0;
  for (const [id, count, probability] of items)
    if (id === rank)
      total +=
        (Math.trunc(Math.imul(Math.imul(count!, Math.round(bonusPercent * 100) + 10000), rate) / 10000) *
          probability!) /
        10000;
  return total;
}
/** Power per skill order at which a team whose orders score `scores` at `power` reaches `target` for certain
 * (scores scale with power; for Gekisou at the engine's expected luck). */
export function teamPowerNeeded(target: number, scores: readonly number[], power: number, notes: number) {
  return slotPowerNeeded(
    target,
    scores.map((score) => score / power),
    notes,
  );
}
