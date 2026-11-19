// L3 — GEB
// Input: Scoped draw records and published odds by pool.
// Output: Cross-pool SSR+ streak and rate comparisons on matched samples.
// Pos: [Map](L2-2.md); recruitment history statistics.
// Effects/Dependencies: Pure calculations using the SDK's same-timestamp hit intervals.
import { gachaHistoryHits, type GachaPoolRates } from "@haneoka/game-data-exporter/gacha-history-analysis";
import { cardRarityId, cardRarityName } from "./card-rarity";
import type { GachaHistoryBatch, GachaHistoryPool, GachaHistoryPrize } from "./gacha-history-view";

type CardRarity = Exclude<keyof GachaPoolRates["rarities"], "item">;
const isHigh = (rarity: CardRarity | "item" | "") => rarity === "SSR" || rarity === "EX" || rarity === "BD";
function knownRarity(prize: GachaHistoryPrize): CardRarity | "item" | "" {
  if (prize.kind === "item") return "item";
  if (prize.kind === "unknown") return "";
  const rarity = typeof prize.rarity === "number" ? prize.rarity : cardRarityId(prize.rarity.trim()) ?? prize.rarity;
  return cardRarityName(rarity) as CardRarity | "";
}

export const isItemOnlyGacha = (rates?: GachaPoolRates) => (rates?.rarities.item ?? 0) >= 1 - 1e-12;

export function latestGachaHigh(
  batches: readonly GachaHistoryBatch[],
  pools: ReadonlyMap<string, GachaHistoryPool>,
) {
  const draws = batches.filter((batch) => batch.prizes.length && !isItemOnlyGacha(pools.get(batch.poolId)?.rates));
  const timeline = gachaHistoryHits(draws.map((batch) => ({ ...batch, poolId: null })), "high")[0];
  const last = timeline?.hits.at(-1);
  const hitPools = new Set<string>();
  let uncertain = false;
  let undatedHit = false;
  let hasHit = Boolean(last);
  const lastTime = Date.parse(last?.pulledAt ?? "");
  for (const batch of draws) {
    const time = Date.parse(batch.pulledAt ?? "");
    if (time < lastTime) continue;
    for (const prize of batch.prizes) {
      const rarity = knownRarity(prize);
      if (!rarity) uncertain = true;
      if (isHigh(rarity)) {
        hasHit = true;
        if (time === lastTime) hitPools.add(batch.poolId);
        else if (!Number.isFinite(time)) undatedHit = true;
      }
    }
  }
  return {
    trailing: !uncertain && !undatedHit && last ? timeline.trailing : null,
    poolIds: undatedHit ? [] : [...hitPools],
    hasHit,
  };
}

export interface GachaRateSample {
  draws: number;
  hits: number;
  expected: number;
}

const RATE_KEYS = ["high", "memberHigh", "supportHigh", "SSR", "BD", "EX", "SR", "R", "pickup"] as const;
type RateKey = (typeof RATE_KEYS)[number];
export type GachaRateComparison = Record<RateKey, GachaRateSample>;

function emptyComparison(): GachaRateComparison {
  return Object.fromEntries(RATE_KEYS.map((key) => [key, { draws: 0, hits: 0, expected: 0 }])) as GachaRateComparison;
}

export function gachaRateComparisons(
  batches: readonly GachaHistoryBatch[],
  pools: ReadonlyMap<string, GachaHistoryPool>,
) {
  const byPool = new Map<string, GachaRateComparison>();
  for (const batch of batches) {
    const published = pools.get(batch.poolId)?.rates;
    if (!published || isItemOnlyGacha(published)) continue;
    let comparison = byPool.get(batch.poolId);
    if (!comparison) {
      comparison = emptyComparison();
      byPool.set(batch.poolId, comparison);
    }
    let draws = 0;
    for (const prize of batch.prizes) {
      if (prize.kind !== "unknown" && typeof prize.pickup === "boolean") {
        comparison.pickup.draws++;
        if (prize.pickup) comparison.pickup.hits++;
      }
      const rarity = knownRarity(prize);
      if (!rarity) continue;
      draws++;
      if (rarity !== "item") comparison[rarity].hits++;
      if (isHigh(rarity)) {
        comparison.high.hits++;
        if (prize.kind === "member") comparison.memberHigh.hits++;
        if (prize.kind === "support") comparison.supportHigh.hits++;
      }
    }
    for (const key of RATE_KEYS) if (key !== "pickup") comparison[key].draws += draws;
  }

  const overall = emptyComparison();
  for (const [poolId, comparison] of byPool) {
    const { rarities, ...base } = pools.get(poolId)!.rates!;
    const published = { ...rarities, ...base };
    for (const key of RATE_KEYS) {
      const row = comparison[key];
      row.expected = row.draws * published[key];
      overall[key].draws += row.draws;
      overall[key].hits += row.hits;
      overall[key].expected += row.expected;
    }
  }
  return { overall, byPool };
}
