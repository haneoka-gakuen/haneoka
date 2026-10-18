/** Score targets from per-power chart rates: a chart scores power × (base + Σ skill share × weight at each event). */
export interface ChartRateTable {
  releaseId: string;
  /** `songId:difficulty` → [base, weight at each skill event]; Gekisou per placement 1–5 in every range; and each
   * score rank as [rank, solo score, Gekisou score with five players]. */
  charts: Record<string, { live: number[]; gekisou: number[][]; ranks: [number, number, number][] }>;
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
