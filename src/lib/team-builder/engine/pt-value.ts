/** One CP's long-run reward value, kept rational so tied teams stay tied. */
export interface CpExchange {
  numerator: number;
  denominator: number;
}

export function cpExchange(rewardSum: number, orders: number, consumption: number): CpExchange {
  if (![rewardSum, orders, consumption].every(Number.isSafeInteger) || rewardSum < 0 || orders < 1 || consumption < 1)
    throw new Error("pt-invalid-cp-value");
  const denominator = orders * consumption;
  if (!Number.isSafeInteger(denominator)) throw new Error("pt-invalid-cp-value");
  let a = rewardSum,
    b = denominator;
  while (b) [a, b] = [b, a % b];
  return { numerator: rewardSum / a, denominator: denominator / a };
}

/** Integer objective before dividing by the shared denominator and order count. */
export const exchangedReward = (direct: number, cp: number, value: CpExchange) =>
  direct * value.denominator + cp * value.numerator;
