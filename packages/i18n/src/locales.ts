export const LOCALE_STORAGE_KEY = "haneoka.locale";

export const supportedLocales = [
  { value: "ja", label: "日本語", tag: "ja-JP" },
  { value: "en", label: "English", tag: "en-US" },
  { value: "zh-TW", label: "繁體中文", tag: "zh-TW" },
  { value: "zh-CN", label: "简体中文", tag: "zh-CN" },
  { value: "ko", label: "한국어", tag: "ko-KR" },
] as const;

export type UiLocale = (typeof supportedLocales)[number]["value"];
/** @deprecated Use UiLocale for UI copy and AuthorLocale for authored data. */
export type Locale = UiLocale;
/** Canonical BCP 47 authored-content tags are not restricted to UiLocale. */
export type AuthorLocale = string;
export type LanguageTag = (typeof supportedLocales)[number]["tag"];
export type LocalizedLanguageTag = AuthorLocale | "und";

export const DEFAULT_LOCALE: UiLocale = "ja";

const localeTags = Object.fromEntries(supportedLocales.map(({ value, tag }) => [value, tag])) as Record<
  UiLocale,
  LanguageTag
>;

const normalizeTagInput = (value: unknown): string =>
  typeof value === "string" ? value.trim().replaceAll("_", "-") : "";
const canonicalTags = new Map<string, string | null>();
const scripts = new Map<string, string>();

/** Return the canonical BCP 47 representation, or null for invalid input. */
export const normalizeLanguageTag = (value: unknown): string | null => {
  const input = normalizeTagInput(value);
  if (!input) return null;
  const cached = canonicalTags.get(input);
  if (cached !== undefined) return cached;
  let tag: string | null;
  try {
    tag = Intl.getCanonicalLocales(input)[0] ?? null;
  } catch {
    tag = null;
  }
  if (canonicalTags.size >= 128) canonicalTags.clear();
  canonicalTags.set(input, tag);
  return tag;
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

export const isLocale = (value: unknown): value is UiLocale =>
  typeof value === "string" && supportedLocales.some((locale) => locale.value === value);

export const normalizeLocale = (value: unknown, fallback: UiLocale = DEFAULT_LOCALE): UiLocale =>
  matchLocale(value) ?? fallback;

export const languageTagFor = (locale: UiLocale): LanguageTag => localeTags[locale];

export const normalizeAuthorLocale = (value: unknown): AuthorLocale | null => normalizeLanguageTag(value);

/** Return the resolved ISO 15924 script, retaining explicit BCP 47 scripts. */
export const scriptForLanguageTag = (value: unknown): string => {
  const tag = normalizeLanguageTag(value);
  if (!tag || tag === "und") return "und";
  const cached = scripts.get(tag);
  if (cached) return cached;
  let script: string;
  try {
    script = new Intl.Locale(tag).maximize().script || "und";
  } catch {
    script = "und";
  }
  if (scripts.size >= 128) scripts.clear();
  scripts.set(tag, script);
  return script;
};

/** UI copy falls back only to the Japanese source before exposing its key. */
export const uiLocaleFallbacks = (requested: UiLocale): readonly UiLocale[] =>
  requested === DEFAULT_LOCALE ? [DEFAULT_LOCALE] : [requested, DEFAULT_LOCALE];

/**
 * Build an authored-content chain from the caller's explicit availability.
 * The package does not append the five UI locales implicitly: game content can
 * carry arbitrary BCP 47 tags and its source policy belongs to the caller.
 */
export const contentLocaleFallbacks = (
  requested: AuthorLocale,
  available: readonly AuthorLocale[] = [],
): readonly AuthorLocale[] => {
  const canonical = normalizeAuthorLocale(requested) ?? "und";
  const locale = canonical === "und" ? null : new Intl.Locale(canonical);
  const script = locale?.maximize().script;
  const candidates = [
    canonical,
    script && locale?.language ? `${locale.language}-${script}` : undefined,
    locale?.language,
    ...available,
  ];
  return [
    ...new Set(
      candidates
        .filter((candidate): candidate is string => Boolean(candidate))
        .map((candidate) => normalizeAuthorLocale(candidate) ?? candidate),
    ),
  ];
};
