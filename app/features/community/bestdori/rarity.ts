import { bestdoriRawResourceUrl } from "~/features/community/bestdori/resources";
import type { DisplayText } from "~/types/displayText";

export const BESTDORI_RARITY_VALUES = [1, 2, 3, 4, 5] as const;

export type BestdoriRarity = (typeof BESTDORI_RARITY_VALUES)[number];

export interface BestdoriRarityOption {
  value: BestdoriRarity;
  label: DisplayText;
  image: string;
  imageFit: "contain";
  avatarText: string;
}

export const normalizeBestdoriRarity = (value: unknown): BestdoriRarity | null => {
  const rarity = Number(value);
  return BESTDORI_RARITY_VALUES.includes(rarity as BestdoriRarity) ? (rarity as BestdoriRarity) : null;
};

export const bestdoriRarityIconUrl = (value: unknown): string => {
  const rarity = normalizeBestdoriRarity(value);
  return rarity === null ? "" : bestdoriRawResourceUrl(`/res/icon/star_${rarity}.png`);
};

/**
 * FacetGroup-compatible rarity options. Callers provide the localized label
 * because the asset itself is decorative and must not become the accessible
 * name of the filter.
 */
export const createBestdoriRarityOptions = (
  labelFor: (rarity: BestdoriRarity) => DisplayText,
): BestdoriRarityOption[] =>
  BESTDORI_RARITY_VALUES.map((rarity) => ({
    value: rarity,
    label: labelFor(rarity),
    image: bestdoriRarityIconUrl(rarity),
    imageFit: "contain",
    avatarText: `${rarity}★`,
  }));
