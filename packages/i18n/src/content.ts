import {
  contentLocaleFallbacks,
  languageTagFor,
  matchLocale,
  type Locale,
  type LocalizedLanguageTag,
} from "./locales.js";

export type LocalizedValue =
  string | readonly (string | null | undefined)[] | Readonly<Record<string, string | null | undefined>>;
export type LocalizedValueInput = LocalizedValue | null | undefined;

export interface ResolvedLocalizedText {
  readonly text: string;
  readonly requestedLocale: Locale;
  readonly sourceLocale: Locale | null;
  readonly lang: LocalizedLanguageTag;
  readonly isFallback: boolean;
}

export interface ResolveLocalizedValueOptions {
  readonly candidates?: readonly LocalizedValueInput[];
  readonly fallback?: string | null;
  /** Source language for plain strings that do not carry locale slots or keys. */
  readonly sourceHint?: Locale | null;
  /** Source language for the final plain-text fallback, or null for neutral text. */
  readonly fallbackSourceHint?: Locale | null;
}

const localeIndexes: Record<Locale, number> = {
  ja: 0,
  en: 1,
  "zh-TW": 2,
  "zh-CN": 3,
  ko: 4,
};

const localeObjectAliases: Readonly<Record<string, Locale>> = {
  japanese: "ja",
  english: "en",
  korean: "ko",
  "traditional-chinese": "zh-TW",
  traditionalchinese: "zh-TW",
  "simplified-chinese": "zh-CN",
  simplifiedchinese: "zh-CN",
};

const masterTextPlaceholder =
  /^(?:Music|Story|Character|Card|MemberCard|SupportCard|Stamp|Comic|Band|Chapter|Episode)_(?:Tilte|Title|Name|Text|Description|Desc|Subtitle|CatchCopy|Profile|Lyricist|Composer|Arranger)(?:_[A-Za-z0-9]+)+$/i;

const normalizedObjectKey = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/gu, "-");

const localeForObjectKey = (key: string): Locale | null => {
  const normalized = normalizedObjectKey(key);
  return localeObjectAliases[normalized] ?? matchLocale(normalized);
};

export const isUsableLocalizedText = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  const text = value.trim();
  return Boolean(text) && !masterTextPlaceholder.test(text);
};

const resolvedText = (
  text: string,
  sourceLocale: Locale | null,
  requestedLocale: Locale,
  forceFallback = false,
): ResolvedLocalizedText => ({
  text,
  requestedLocale,
  sourceLocale,
  lang: sourceLocale ? languageTagFor(sourceLocale) : "und",
  isFallback: forceFallback || (sourceLocale !== null && sourceLocale !== requestedLocale),
});

const resolveSingleValue = (
  value: LocalizedValueInput,
  locale: Locale,
  sourceHint: Locale | null = null,
): ResolvedLocalizedText | null => {
  if (typeof value === "string") {
    return isUsableLocalizedText(value) ? resolvedText(value, sourceHint, locale) : null;
  }

  if (Array.isArray(value)) {
    for (const candidateLocale of contentLocaleFallbacks(locale)) {
      const text = value[localeIndexes[candidateLocale]];
      if (isUsableLocalizedText(text)) return resolvedText(text, candidateLocale, locale);
    }
    return null;
  }

  if (!value) return null;

  const localizedEntries = new Map<Locale, string>();
  for (const [key, text] of Object.entries(value)) {
    const entryLocale = localeForObjectKey(key);
    if (entryLocale && !localizedEntries.has(entryLocale) && isUsableLocalizedText(text)) {
      localizedEntries.set(entryLocale, text);
    }
  }

  for (const candidateLocale of contentLocaleFallbacks(locale)) {
    const text = localizedEntries.get(candidateLocale);
    if (text !== undefined) return resolvedText(text, candidateLocale, locale);
  }
  return null;
};

export const resolveLocalizedValue = (
  value: LocalizedValueInput,
  locale: Locale,
  options: ResolveLocalizedValueOptions = {},
): ResolvedLocalizedText | null => {
  const values: readonly LocalizedValueInput[] = [value, ...(options.candidates ?? [])];
  for (const [index, candidate] of values.entries()) {
    const result = resolveSingleValue(candidate, locale, options.sourceHint);
    if (result) return index === 0 ? result : { ...result, isFallback: true };
  }

  if (!isUsableLocalizedText(options.fallback)) return null;
  const result = resolveSingleValue(options.fallback, locale, options.fallbackSourceHint);
  return result ? { ...result, isFallback: true } : null;
};

export const localizeValue = (value: LocalizedValueInput, locale: Locale): string =>
  resolveLocalizedValue(value, locale)?.text ?? "";
