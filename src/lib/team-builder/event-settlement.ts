// L3 — GEB
// Input: Base reward, event bonus, boost rate and additional count as native integers.
// Output: Native Int32 PT settlement and signed 64-bit item settlement with a 32-bit cap.
// Pos: [Map](L2-2.md); shared event settlement for TS objectives and native-rule adapters.
// Effects/Dependencies: Pure; mirrors CalculateEventPoint and LiveItemRewardService.ApplyEventBonus.
const MAX_REWARD = 0x7fffffff;
const MAX_REWARD_BIGINT = BigInt(MAX_REWARD);

export function settleEventReward(baseAmount: number, bonusBP: number, rate: number, extraAmount = 0): number {
  const base = baseAmount | 0;
  const factor = (bonusBP + 10000) | 0;
  const boost = rate | 0;
  const extra = extraAmount | 0;
  const product = base * factor * boost;
  if (Number.isSafeInteger(product)) return Math.min(MAX_REWARD, Math.trunc(product / 10000) + extra) | 0;
  const wide = BigInt.asIntN(64, BigInt(base) * BigInt(factor) * BigInt(boost));
  const amount = wide / 10000n + BigInt(extra);
  return Number(BigInt.asIntN(32, amount < MAX_REWARD_BIGINT ? amount : MAX_REWARD_BIGINT));
}

export function settleEventPoints(baseAmount: number, bonusBP: number, rate: number): number {
  return Math.trunc(Math.imul(Math.imul((bonusBP + 10000) | 0, baseAmount | 0), rate | 0) / 10000);
}
