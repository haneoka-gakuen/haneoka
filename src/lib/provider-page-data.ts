export type CatalogProvider = "bestdori" | "sekai";
export const PROVIDER_STORY_SECTIONS = {
  bestdori: ["event", "band", "main", "afterlive", "card"],
  sekai: ["event", "unit", "character", "card", "area", "special", "mysekai", "live"],
} as const;
const regions: Record<string, string> = { "zh-TW": "tw", "zh-CN": "cn", ko: "kr", en: "en" };
export const providerRegionForLocale = (locale: string): string => regions[locale] || "jp";
export const providerCatalogBase = (provider: CatalogProvider, locale: string): string =>
  `/api/v1/${provider === "sekai" ? "sekai" : "garupa/bestdori"}/${providerRegionForLocale(locale)}`;

export interface ProviderCollectionPayload {
  schema: "haneoka-provider-collection-v1";
  provider: CatalogProvider;
  locale: string;
  resource: string;
  document: Record<string, unknown>;
  bands: unknown;
  characters: unknown;
  songMeta?: Record<string, unknown>;
}
