import type { ArchiveLocale } from "~/i18n/locales";

/**
 * Anon Tokyo keeps source strings deliberately separate from UI copy.  Unlike
 * the wider archive, this feature is not uniformly localized in every
 * release, so callers must select the requested slot rather than invent a
 * cross-language fallback.
 */
export interface AnonTokyoText {
  textId?: string;
  values?: Array<string | null | undefined>;
  baseLocale?: string | null;
  variants?: Record<string, string | null | undefined>;
}

export interface AnonTokyoAssetVariant {
  url?: string;
  sourcePath?: string;
}

export interface AnonTokyoAsset {
  url?: string;
  sourcePath?: string;
  /** The logical AT atlas key this visual was verified from. */
  assetKey?: string;
  baseLocale?: string | null;
  variants?: Record<string, AnonTokyoAssetVariant | undefined>;
  status?: string;
  reason?: string;
}

export interface AnonTokyoEntity {
  id: string;
  rawId: number | string;
  name?: AnonTokyoText;
  title?: AnonTokyoText;
  description?: AnonTokyoText;
  image?: AnonTokyoAsset;
  icon?: AnonTokyoAsset;
  preview?: AnonTokyoAsset;
  /** The AT character table calls this identity artwork an avatar. */
  avatar?: AnonTokyoAsset;
  [key: string]: unknown;
}

export interface AnonTokyoSpineModel extends AnonTokyoEntity {
  status?: "ready" | "partial" | "unavailable" | string;
  reason?: string;
  preview?: AnonTokyoAsset;
  animationNames?: string[];
  sourcePath?: string;
}

/** Compact recipe projection embedded in the catalog document. */
export interface AnonTokyoRenderRecipe {
  id?: string;
  characterId?: number;
  avatarId?: number;
  nameKey?: string;
  defaultAvatarReloadingIds?: number[];
  outfitReloadingIds?: number[];
  animation?: { name?: string; loop?: boolean };
  scale?: number;
  parts?: Array<{ modelId?: string; order?: number; reloadingId?: number }>;
  preview?: AnonTokyoAsset;
  runtime?: { status?: string; renderer?: string; sort?: string; verification?: string };
}

export interface AnonTokyoSpinePart {
  rawId?: number;
  order?: number;
  pathName?: string;
  sourceAvailable?: boolean;
}

export const anonTokyoPartSlotOf = (pathName: unknown): string | undefined => {
  const stem = String(pathName || "").split("/").pop() || "";
  const trimmed = stem.replace(/_skeletondata(\.asset)?$/i, "");
  const separator = trimmed.indexOf("_");
  return separator < 0 ? undefined : trimmed.slice(separator + 1) || undefined;
};

export interface AnonTokyoDocument {
  schema: string;
  server: string;
  sourceId: string;
  available: boolean;
  reason?: string;
  localization?: {
    localeSlots?: Array<{ locale: string; index: number; masterField?: string }>;
    textFallback?: "none" | string;
    imageFallback?: "none" | string;
  };
  counts?: Record<string, number>;
  sourceTableCounts?: Record<string, number>;
  characters?: Record<string, AnonTokyoEntity>;
  goods?: {
    categories?: Record<string, AnonTokyoEntity>;
    tags?: Record<string, AnonTokyoEntity>;
    items?: Record<string, AnonTokyoEntity>;
    reloading?: Record<string, AnonTokyoEntity>;
    reloadingLinks?: Record<string, AnonTokyoEntity>;
  };
  shop?: {
    mainTypes?: Record<string, AnonTokyoEntity>;
    subTypes?: Record<string, AnonTokyoEntity>;
    decorations?: Record<string, AnonTokyoEntity>;
    staticDecorations?: Record<string, AnonTokyoEntity>;
    stores?: Record<string, AnonTokyoEntity>;
    initialMapObjects?: Record<string, AnonTokyoEntity>;
    warehouse?: Record<string, AnonTokyoEntity>;
    safeDepositBoxes?: Record<string, AnonTokyoEntity>;
    shelves?: Record<string, AnonTokyoEntity>;
  };
  themes?: Record<string, AnonTokyoEntity>;
  stages?: {
    stages?: Record<string, AnonTokyoEntity>;
    music?: Record<string, AnonTokyoEntity>;
    bgm?: Record<string, AnonTokyoEntity>;
  };
  tasks?: {
    tabs?: Record<string, AnonTokyoEntity>;
    main?: Record<string, AnonTokyoEntity>;
    chapter?: Record<string, AnonTokyoEntity>;
    daily?: Record<string, AnonTokyoEntity>;
    achievements?: Record<string, AnonTokyoEntity>;
    achievementTasks?: Record<string, AnonTokyoEntity>;
    timeLimited?: Record<string, AnonTokyoEntity>;
    types?: Record<string, AnonTokyoEntity>;
  };
  progression?: {
    currencies?: Record<string, AnonTokyoEntity>;
    playerLevels?: Record<string, AnonTokyoEntity>;
    attributes?: Record<string, AnonTokyoEntity>;
    global?: Record<string, AnonTokyoEntity>;
    inspirations?: Record<string, AnonTokyoEntity>;
    passiveAbilities?: Record<string, AnonTokyoEntity>;
    rewards?: Record<string, AnonTokyoEntity>;
  };
  staffing?: {
    roles?: Record<string, AnonTokyoEntity>;
    clerks?: Record<string, AnonTokyoEntity>;
    helpers?: Record<string, AnonTokyoEntity>;
    helperSkills?: Record<string, AnonTokyoEntity>;
    deliveries?: Record<string, AnonTokyoEntity>;
    deliverySkills?: Record<string, AnonTokyoEntity>;
    deliverymen?: Record<string, AnonTokyoEntity>;
    customers?: Record<string, AnonTokyoEntity>;
    customerCollections?: Record<string, AnonTokyoEntity>;
  };
  dialogue?: {
    characterChats?: Record<string, AnonTokyoEntity>;
    chatGroups?: Record<string, AnonTokyoEntity>;
    monologues?: Record<string, AnonTokyoEntity>;
  };
  guides?: {
    steps?: Record<string, AnonTokyoEntity>;
    imagePages?: Record<string, AnonTokyoEntity>;
  };
  map?: {
    configs?: Record<string, AnonTokyoEntity>;
  };
  spine?: {
    available?: boolean;
    status?: string;
    reason?: string;
    metadata?: string;
    models?: Record<string, AnonTokyoSpineModel>;
    unavailableModels?: Record<string, AnonTokyoSpineModel>;
    renderRecipes?: Record<string, AnonTokyoRenderRecipe>;
    unavailableRenderRecipes?: Record<string, AnonTokyoRenderRecipe>;
    parts?: Record<string, AnonTokyoSpinePart>;
    defaults?: Record<string, AnonTokyoEntity>;
  };
  sourceTables?: Record<string, unknown>;
}

const localeIndexes: Record<ArchiveLocale, number> = {
  ja: 0,
  en: 1,
  "zh-TW": 2,
  "zh-CN": 3,
  ko: 4,
};

const localeSources: Partial<Record<ArchiveLocale, string>> = { "zh-TW": "zh-Hant", "zh-CN": "zh-Hans" };
const sourceLocaleFor = (locale: ArchiveLocale): string => localeSources[locale] || locale;

/** Returns only the source string authored for the requested UI locale. */
export const anonTokyoText = (value: AnonTokyoText | undefined, locale: ArchiveLocale): string => {
  if (!value) return "";
  const indexed = value.values?.[localeIndexes[locale]];
  if (typeof indexed === "string" && indexed.trim()) return indexed;
  const direct = value.variants?.[sourceLocaleFor(locale)] ?? value.variants?.[locale];
  return typeof direct === "string" && direct.trim() ? direct : "";
};

/**
 * Resolves an authored visual only when that locale actually exists. The AT
 * base asset is not assumed to be Japanese: some original un-suffixed guide
 * images are Simplified Chinese.
 */
export const anonTokyoAsset = (value: AnonTokyoAsset | undefined, locale: ArchiveLocale): string | undefined => {
  if (!value) return undefined;
  const sourceLocale = sourceLocaleFor(locale);
  const variant = value.variants?.[sourceLocale] ?? value.variants?.[locale];
  if (variant?.url) return variant.url;
  // An unlabelled asset with no locale siblings is a language-neutral game
  // visual (for example an avatar or sprite), not an implied Japanese image.
  // Guide pages that are actually zh-Hans are projected with an explicit base.
  if (!value.baseLocale && !Object.keys(value.variants || {}).length) return value.url;
  const baseLocale = value.baseLocale === "zh-CN" ? "zh-Hans" : value.baseLocale;
  return baseLocale === sourceLocale || baseLocale === locale ? value.url : undefined;
};

const uiChromeAssetPrefixes = ["AT_Common_", "AT_UI_", "UI_Common_"];

/**
 * Some master rows point their artwork slot at shared interface chrome (the
 * close button, tag and currency glyphs) instead of real entity art. Those
 * sprites describe game UI, not the entity, so they must never be presented
 * as its preview.
 */
export const isAnonTokyoUiChrome = (value: AnonTokyoAsset | undefined): boolean => {
  const assetKey = typeof value?.assetKey === "string" ? value.assetKey : "";
  return uiChromeAssetPrefixes.some((prefix) => assetKey.startsWith(prefix));
};

/** First authored asset of an entity that is real artwork resolvable for `locale`. */
export const anonTokyoDisplayAsset = (
  entity: Pick<AnonTokyoEntity, "preview" | "avatar" | "image" | "icon"> | undefined,
  locale: ArchiveLocale,
): string | undefined => {
  for (const asset of [entity?.preview, entity?.avatar, entity?.image, entity?.icon]) {
    if (!asset || isAnonTokyoUiChrome(asset)) continue;
    const url = anonTokyoAsset(asset, locale);
    if (url) return url;
  }
  return undefined;
};

export const anonTokyoEntities = <T extends AnonTokyoEntity>(value: Record<string, T> | undefined): T[] =>
  Object.values(value || {}).sort((left, right) =>
    String(left.id).localeCompare(String(right.id), "en", { numeric: true }),
  );

/**
 * Shows a scalar authored by the AT master without pretending that a numeric
 * enum has a human-readable name.  Pages pass known semantic aliases first,
 * then the original master field for releases built with an older projection.
 */
const scalarValue = (value: unknown): string | number | undefined => {
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    const values = value.filter(
      (item): item is string | number => typeof item === "string" || typeof item === "number",
    );
    return values.length ? values.join(" · ") : undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  // Master projections intentionally retain structured values (rewards,
  // requirements, etc.). `raw` is the authored master representation and is
  // the only safe compact display until a feature has an explicit decoder.
  return scalarValue(record.raw);
};

export const anonTokyoField = (entry: AnonTokyoEntity, ...keys: string[]): string | number | undefined => {
  for (const key of keys) {
    const scalar = scalarValue(entry[key]);
    if (scalar !== undefined) return scalar;
  }
  return undefined;
};

/** Resolve an explicitly named nested master field without flattening its meaning. */
export const anonTokyoPath = (entry: AnonTokyoEntity, ...path: string[]): string | number | undefined => {
  let value: unknown = entry;
  for (const key of path) {
    if (!value || typeof value !== "object") return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return scalarValue(value);
};
