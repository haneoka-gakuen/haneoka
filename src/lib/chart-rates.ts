/** Score targets from per-power chart rates: a chart scores power × (base + Σ skill share × weight at each event). */
/** The Great share of the Gekisou Great endpoint. */
export const GREAT_STEP = 0.1;
export interface ChartRates {
  /** [base, weight at each skill event], All Perfect. */
  live: number[];
  /** Gekisou per placement 1–5 in every range, all Perfect with every eligible note Just, and with none Just (absent
   * when the chart has no Just range). */
  gekisou: number[][];
  gekisouNoJust?: number[][];
  /** Gekisou with GREAT_STEP of the notes Great and the rest Perfect, every eligible one Just. */
  gekisouGreat: number[][];
  /** Skip-ticket score per unit of power. */
  skip: number;
  /** Each score rank as [rank, solo score, Gekisou score with five players]. */
  ranks: [number, number, number][];
}
export interface ChartRateTable {
  releaseId: string;
  /** A Great note's score over a Perfect note's. */
  greatFactor: number;
  /** `songId:difficulty` → its rates. */
  charts: Record<string, ChartRates>;
}
export interface Accuracy {
  /** Share of notes hit Great; the rest Perfect. */
  great: number;
  /** Gekisou: share of the Just-eligible Perfect notes hit Just. */
  just: number;
}
/** Rates at an accuracy, by each note's expected judgement. Live: a Great note scores greatFactor of a Perfect one and
 * keeps the combo. Gekisou: a share `great` of the notes is Great and of the rest a share `just` of the eligible ones
 * Just, so R = (1 − great)·(just·R₁ + (1 − just)·R₀) + great·G, where G (every note Great) follows from the engine's
 * GREAT_STEP endpoint: R_g = (1 − GREAT_STEP)·R₁ + GREAT_STEP·G. */
export function playRates(
  rates: ChartRates,
  mode: "live" | "gekisou",
  place: number,
  accuracy: Accuracy,
  greatFactor: number,
): number[] {
  if (mode === "live") return rates.live.map((value) => value * (1 - accuracy.great * (1 - greatFactor)));
  const just = rates.gekisou[place - 1]!,
    none = (rates.gekisouNoJust ?? rates.gekisou)[place - 1]!,
    great = rates.gekisouGreat[place - 1]!;
  return just.map((value, index) => {
    const allGreat = (great[index]! - (1 - GREAT_STEP) * value) / GREAT_STEP;
    const perfect = accuracy.just * value + (1 - accuracy.just) * none[index]!;
    return (1 - accuracy.great) * perfect + accuracy.great * allGreat;
  });
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
/** Score per unit of power at the average of the 120 skill orders. */
export function meanRate(rates: number[], skills: number[]): number {
  const mean = skills.reduce((sum, value) => sum + value, 0) / skills.length / 100;
  return rates[0]! + mean * rates.slice(1).reduce((sum, value) => sum + value, 0);
}
export function requiredPower(target: number, rates: number[], skills: number[]): number {
  return Math.ceil(target / meanRate(rates, skills));
}
/** Share of the 120 skill orders whose score reaches `target`. */
export function reachChance(target: number, power: number, rates: number[], skills: number[]): number {
  let reached = 0;
  for (const order of SKILL_ORDERS) {
    let rate = rates[0]!;
    for (let event = 1; event < rates.length; event++) rate += (skills[order[event - 1]!]! / 100) * rates[event]!;
    if (power * rate >= target) reached++;
  }
  return reached / SKILL_ORDERS.length;
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
