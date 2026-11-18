// L3 — GEB
// Input: A card's master rarity value.
// Output: Rarity names and display ranks for sorting and threshold comparisons.
// Pos: [Map](L2-2.md); the single rarity table for cards, rankings, gacha history and search.
// Effects/Dependencies: None.

const RARITIES = [[2, "R"], [3, "SR"], [10, "EX"], [20, "BD"], [4, "SSR"]] as const;
export const CARD_RARITY_ORDER: readonly number[] = RARITIES.map(([id]) => id);
export const CARD_RARITY_NAMES: Readonly<Record<number, string>> = Object.fromEntries(RARITIES);
const RANKS: Readonly<Record<number, number>> = Object.fromEntries(RARITIES.map(([id], index) => [id, index + 1]));
const IDS: Readonly<Record<string, number>> = Object.fromEntries(RARITIES.map(([id, name]) => [name.toLowerCase(), id]));

export function cardRarityName(value: unknown): string {
  return CARD_RARITY_NAMES[Number(value)] || "";
}

export function cardRarityRank(value: unknown): number {
  return RANKS[Number(value)] ?? 0;
}

export function cardRarityId(name: string): number | undefined {
  return IDS[name.toLowerCase()];
}

export function cardRarityAtLeast(value: unknown, minimum: number): boolean {
  const rank = cardRarityRank(minimum);
  return minimum === 0 || rank > 0 && cardRarityRank(value) >= rank;
}
