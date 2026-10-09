/** Playable Live Boost costs. Reward multipliers still come from the pinned release's tables. */
export const LIVE_BOOST_COSTS = [0, 1, 2, 3, 4, 5, 10] as const;
export const isLiveBoostCost = (value: number): boolean => LIVE_BOOST_COSTS.some((cost) => cost === value);

export function liveBoostRow<T extends { consumed: number; eventPointRate: number; rewardRate: number }>(
  rows: readonly T[],
  cost: number,
) {
  if (!isLiveBoostCost(cost)) return undefined;
  // The unboosted live is already modeled at 1x in eventRoute; public tables begin at one consumed boost.
  return cost === 0 ? { consumed: 0, eventPointRate: 1, rewardRate: 1 } : rows.find((row) => row.consumed === cost);
}
