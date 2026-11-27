const BAND_RATING_TIERS = ["D", "C", "B", "A", "S", "SS"];

// App.Master.BandRank assigns four consecutive ranks to each tier.
export function bandRatingName(rank: number): string | undefined {
  if (!Number.isInteger(rank) || rank < 1 || rank > BAND_RATING_TIERS.length * 4) return undefined;
  const index = rank - 1;
  return `${BAND_RATING_TIERS[Math.floor(index / 4)]}${index % 4 + 1}`;
}
