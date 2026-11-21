// L3 — GEB
// Input: Scoped draw records, executed draw rules and published pool odds.
// Output: Recorded draw timelines, SSR+ streaks and comparable per-pool and overview rates.
// Pos: [Map](L2-2.md); recruitment history statistics.
// Effects/Dependencies: Pure calculations on the supplied draw records.
import type { GachaPoolRates } from "@haneoka/game-data-exporter/gacha-history-analysis";
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

export interface GachaRecordedHit {
  pulledAt: string | null;
  prize: GachaHistoryPrize;
  position: number | null;
  gap: number | null;
  tenPullHits?: number;
}

/** The import preserves prize array order. The service does not attest to animation order. */
export function gachaRecordedHits(batches: readonly GachaHistoryBatch[], target: "high" | "pickup" = "high") {
  const grouped = new Map<string, GachaHistoryBatch[]>();
  for (const batch of batches) {
    const group = grouped.get(batch.poolId);
    if (group) group.push(batch);
    else grouped.set(batch.poolId, [batch]);
  }
  return [...grouped].map(([poolId, rows]) => {
    rows.sort((a, b) => (a.pulledAt ?? "~").localeCompare(b.pulledAt ?? "~"));
    const hasUndated = rows.some(row => !row.pulledAt);
    let total = 0;
    let last = 0;
    let gapKnown = !hasUndated;
    const hits: GachaRecordedHit[] = [];
    for (const batch of rows) {
      const found: GachaRecordedHit[] = [];
      for (const prize of batch.prizes) {
        total++;
        const rarity = knownRarity(prize);
        const result = rarity === "item" ? false
          : target === "high" ? rarity ? isHigh(rarity) : null
            : prize.kind !== "unknown" && typeof prize.pickup === "boolean" ? prize.pickup : null;
        if (result === null) {
          gapKnown = false;
        } else if (result) {
          found.push({
            pulledAt: batch.pulledAt, prize,
            position: hasUndated ? null : total,
            gap: gapKnown ? total - last : null,
          });
          last = total;
          gapKnown = !hasUndated;
        }
      }
      if (batch.prizes.length === 10 && found.length > 1) found[0]!.tenPullHits = found.length;
      for (const hit of found) hits.push(hit);
    }
    return { poolId, total, hits, trailing: gapKnown ? total - last : null };
  });
}

export function latestGachaHigh(
  batches: readonly GachaHistoryBatch[],
  pools: ReadonlyMap<string, GachaHistoryPool>,
) {
  const draws = batches.filter((batch) => batch.prizes.length && !isItemOnlyGacha(pools.get(batch.poolId)?.rates));
  const timeline = gachaRecordedHits(draws.map((batch) => ({ ...batch, poolId: "" })))[0];
  return gachaHighStreak(draws, timeline);
}

export function gachaHighStreak(
  batches: readonly GachaHistoryBatch[],
  timeline: ReturnType<typeof gachaRecordedHits>[number] | undefined,
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
    if (last && timeline.trailing !== null) trailing = { min: timeline.trailing, max: timeline.trailing };
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
