export interface ExchangeProductCost {
  cost?: unknown;
  limit?: unknown;
}

/** One exchange entry uses one authored payment resource; quantities are purchases. */
export function finiteExchangeCost(products: ReadonlyArray<ExchangeProductCost>) {
  let total = 0;
  let finite = 0;
  let unlimited = 0;
  let unknown = 0;
  for (const product of products) {
    const limit = product.limit;
    const cost = product.cost;
    if (typeof limit !== "number" || !Number.isSafeInteger(limit)) {
      unknown++;
      continue;
    }
    if (limit <= 0) {
      unlimited++;
      continue;
    }
    finite++;
    if (
      typeof cost !== "number" ||
      !Number.isSafeInteger(cost) ||
      cost < 0 ||
      !Number.isSafeInteger(cost * limit) ||
      !Number.isSafeInteger(total + cost * limit)
    ) {
      unknown++;
      continue;
    }
    // Reward.count is the contents of one purchase, not another cost multiplier.
    total += cost * limit;
  }
  return { total: unknown ? undefined : total, finite, unlimited, unknown };
}
