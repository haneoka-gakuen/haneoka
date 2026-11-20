// L3 — GEB
// Input: Scoped draw records, executed draw rules and published pool odds.
// Output: Cross-pool SSR+ streak, adjusted overview rates and base per-pool rates.
// Pos: [Map](L2-2.md); recruitment history statistics.
// Effects/Dependencies: Pure calculations using the SDK's same-timestamp hit intervals.
import { gachaHistoryHits, type GachaPoolHits, type GachaPoolRates } from "@haneoka/game-data-exporter/gacha-history-analysis";
import { cardRarityId, cardRarityName } from "./card-rarity";
import { comparableGachaLaw, emptyGachaRates, GACHA_RATE_KEYS, type GachaRateKey } from "./gacha-history-luck";
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
  return gachaHighStreak(draws, timeline);
}

export function gachaHighStreak(
  batches: readonly GachaHistoryBatch[],
  timeline: GachaPoolHits | undefined,
  fromFirstDraw = false,
) {
  const last = timeline?.hits.at(-1);
  const hitPools = new Set<string>();
  let uncertain = false;
  let undatedHit = false;
  let hasHit = Boolean(last);
  const lastTime = Date.parse(last?.pulledAt ?? "");
  for (const batch of batches) {
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
  let trailing = null;
  if (!uncertain && !undatedHit && timeline) {
    if (last) trailing = timeline.trailing;
    else if (fromFirstDraw && !hasHit) trailing = { min: timeline.total, max: timeline.total };
  }
  return { trailing, poolIds: undatedHit ? [] : [...hitPools], hasHit };
}

export interface GachaRateSample {
  draws: number;
  hits: number;
  expected: number;
}

export type GachaRateComparison = Record<GachaRateKey, GachaRateSample>;

function emptyComparison(): GachaRateComparison {
  return Object.fromEntries(GACHA_RATE_KEYS.map((key) => [key, { draws: 0, hits: 0, expected: 0 }])) as GachaRateComparison;
}

export function gachaRateComparisons(
  batches: readonly GachaHistoryBatch[],
  pools: ReadonlyMap<string, GachaHistoryPool>,
) {
  const overall = emptyComparison();
  const byPool = new Map<string, GachaRateComparison>();
  for (const batch of batches) {
    const published = pools.get(batch.poolId)?.rates;
    if (!published || isItemOnlyGacha(published)) continue;
    let comparison = byPool.get(batch.poolId);
    if (!comparison) {
      comparison = emptyComparison();
      byPool.set(batch.poolId, comparison);
    }
    const hits = emptyGachaRates();
    let draws = 0, pickupDraws = 0;
    for (const prize of batch.prizes) {
      if (prize.kind !== "unknown" && typeof prize.pickup === "boolean") {
        pickupDraws++;
        if (prize.pickup) hits.pickup++;
      }
      const rarity = knownRarity(prize);
      if (!rarity) continue;
      draws++;
      if (rarity !== "item") hits[rarity]++;
      if (isHigh(rarity)) {
        hits.high++;
        if (prize.kind === "member") hits.memberHigh++;
        if (prize.kind === "support") hits.supportHigh++;
      }
    }
    const rates = comparableGachaLaw(batch)?.rates;
    for (const key of GACHA_RATE_KEYS) {
      const sampleDraws = key === "pickup" ? pickupDraws : draws;
      comparison[key].draws += sampleDraws;
      comparison[key].hits += hits[key];
      if (!rates || sampleDraws !== batch.prizes.length) continue;
      const row = overall[key];
      row.draws += sampleDraws;
      row.hits += hits[key];
      row.expected += sampleDraws * rates[key];
    }
  }

  for (const [poolId, comparison] of byPool) {
    const { rarities, ...base } = pools.get(poolId)!.rates!;
    const published = { ...rarities, ...base };
    for (const key of GACHA_RATE_KEYS) {
      const row = comparison[key];
      row.expected = row.draws * published[key];
    }
  }
  return { overall, byPool };
}
