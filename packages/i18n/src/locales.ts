export const LOCALE_STORAGE_KEY = "haneoka.locale";

export const supportedLocales = [
  { value: "ja", label: "日本語", tag: "ja-JP" },
  { value: "en", label: "English", tag: "en-US" },
  { value: "zh-TW", label: "繁體中文", tag: "zh-TW" },
  { value: "zh-CN", label: "简体中文", tag: "zh-CN" },
  { value: "ko", label: "한국어", tag: "ko-KR" },
] as const;

export type Locale = (typeof supportedLocales)[number]["value"];
export type LanguageTag = (typeof supportedLocales)[number]["tag"];
export type LocalizedLanguageTag = LanguageTag | "und";

export const DEFAULT_LOCALE: Locale = "ja";

const localeTags = Object.fromEntries(supportedLocales.map(({ value, tag }) => [value, tag])) as Record<
  Locale,
  LanguageTag
>;

const normalizeTagInput = (value: unknown): string =>
  typeof value === "string" ? value.trim().replaceAll("_", "-") : "";

/** Return the canonical BCP 47 representation, or null for invalid input. */
export const normalizeLanguageTag = (value: unknown): string | null => {
  const input = normalizeTagInput(value);
  if (!input) return null;

  try {
    return Intl.getCanonicalLocales(input)[0] ?? null;
  } catch {
    return null;
  }
};

/** Match a BCP 47 tag to one of the five locales supported by the product. */
export const matchLocale = (value: unknown): Locale | null => {
  const tag = normalizeLanguageTag(value);
  if (!tag) return null;

  const segments = tag.toLowerCase().split("-");
  const language = segments[0];
  if (language === "ja" || language === "en" || language === "ko") return language;
  if (language !== "zh") return null;

  // An explicit ISO 15924 script is more precise than a possibly conflicting
  // region (for example zh-Hans-TW). Use region only when no script is present.
  if (segments.includes("hant")) return "zh-TW";
  if (segments.includes("hans")) return "zh-CN";
  return segments.some((segment) => ["tw", "hk", "mo"].includes(segment)) ? "zh-TW" : "zh-CN";
};

export const isLocale = (value: unknown): value is Locale =>
  typeof value === "string" && supportedLocales.some((locale) => locale.value === value);

export const normalizeLocale = (value: unknown, fallback: Locale = DEFAULT_LOCALE): Locale =>
  matchLocale(value) ?? fallback;

export const languageTagFor = (locale: Locale): LanguageTag => localeTags[locale];

/** UI copy falls back only to the Japanese source before exposing its key. */
export const uiLocaleFallbacks = (requested: Locale): readonly Locale[] =>
  requested === DEFAULT_LOCALE ? [DEFAULT_LOCALE] : [requested, DEFAULT_LOCALE];

/** Content may use every known translation after the requested and source locales. */
export const contentLocaleFallbacks = (requested: Locale): readonly Locale[] => [
  requested,
  ...(requested === DEFAULT_LOCALE ? [] : ([DEFAULT_LOCALE] as const)),
  ...supportedLocales
    .map(({ value }) => value)
    .filter((candidate) => candidate !== requested && candidate !== DEFAULT_LOCALE),
];
