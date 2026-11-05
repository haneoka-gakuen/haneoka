import {
  contentLocaleFallbacks,
  normalizeAuthorLocale,
  resolveLocalizedValue,
  scriptForLanguageTag,
  type AuthorLocale,
} from "@haneoka/i18n";

export const TEXT_LOCALES = ["ja", "en", "zh-TW", "zh-CN", "ko"] as const;

export interface LocalizedValue {
  text: string;
  locale: AuthorLocale;
  lang: AuthorLocale | "und";
  script: string;
  isFallback: boolean;
}

const localeCache = new Map<string, string>();
const fallbackCache = new Map<string, readonly string[]>();
const languageIdentities = new Map<string, string>();
const canonicalLocale = (locale: string): string => {
  const cached = localeCache.get(locale);
  if (cached) return cached;
  const value = normalizeAuthorLocale(locale) || locale;
  if (localeCache.size > 128) localeCache.clear();
  localeCache.set(locale, value);
  return value;
};

/**
 * Game-authored fallback is deliberately separate from UI copy. These are the
 * historical content candidates, including cross-script candidates where the
 * authored data policy explicitly permits them.
 */
export function localizedFallbacks(locale: string): string[] {
  const requested = canonicalLocale(locale);
  const cached = fallbackCache.get(requested);
  if (cached) return [...cached];
  const language = normalizeAuthorLocale(requested) ? new Intl.Locale(requested) : undefined;
  const script = language?.maximize().script;
  const fallbacks = [
    ...new Set(
      language?.language === "zh" && script === "Hans"
        ? [requested, "zh-CN", "zh-Hans", "zh-TW", "zh-Hant", "ja", "en", "ko"]
        : language?.language === "zh" && script === "Hant"
          ? [requested, "zh-TW", "zh-Hant", "ja", "en", "zh-CN", "ko"]
          : [...contentLocaleFallbacks(requested), "ja", "en", "zh-TW", "zh-CN", "ko"],
    ),
  ];
  if (fallbackCache.size >= 128) fallbackCache.clear();
  fallbackCache.set(requested, fallbacks);
  return [...fallbacks];
}

export function resolveLocalizedText(value: unknown, locale: string, sourceLocale?: string): LocalizedValue {
  const requested = canonicalLocale(locale);
  const resolved = resolveLocalizedValue((typeof value === "number" ? String(value) : value) as never, requested, {
    fallbackLocales: localizedFallbacks(requested),
    sourceHint: sourceLocale ?? requested,
  });
  if (!resolved) {
    return {
      text: "",
      locale: requested,
      lang: "und",
      script: scriptForLanguageTag("und"),
      isFallback: false,
    };
  }
  const source = resolved.sourceLocale || requested;
  return {
    text: resolved.text,
    locale: source,
    lang: resolved.lang,
    script: resolved.script,
    isFallback: resolved.isFallback,
  };
}

export interface RelationshipTextOptions {
  /** A complete authored relationship name, including localized tuples. */
  readonly authoredText?: unknown;
  /** A resolved catalog message or authored format with indexed {0}, {1} slots. */
  readonly format?: unknown;
  /** An explicitly supplied localized delimiter, such as the authored speaker-name row. */
  readonly separator?: unknown;
  readonly sourceLocale?: string;
}

export interface LocalizedRelationshipValue extends LocalizedValue {
  readonly parts: readonly LocalizedValue[];
  readonly formatSource: "authored" | "pattern" | "separator" | "project-list";
}

const relationshipFormatters = new Map<string, Intl.ListFormat>();
const relationshipFormatter = (locale: string): Intl.ListFormat => {
  const key = canonicalLocale(locale);
  const cached = relationshipFormatters.get(key);
  if (cached) return cached;
  let formatter: Intl.ListFormat;
  try {
    formatter = new Intl.ListFormat(key, { style: "long", type: "conjunction" });
  } catch {
    formatter = new Intl.ListFormat("en", { style: "long", type: "conjunction" });
  }
  if (relationshipFormatters.size >= 32) relationshipFormatters.clear();
  relationshipFormatters.set(key, formatter);
  return formatter;
};

const presentRelationshipValue = (value: unknown): unknown =>
  value && typeof value === "object" && (value as { fallbackReason?: string }).fallbackReason === "missing"
    ? undefined
    : value;

const relationshipLanguageIdentity = (lang: string): string => {
  const cached = languageIdentities.get(lang);
  if (cached) return cached;
  const tag = normalizeAuthorLocale(lang);
  const identity = tag && tag !== "und" ? new Intl.Locale(tag).maximize().toString() : lang;
  if (languageIdentities.size >= 128) languageIdentities.clear();
  languageIdentities.set(lang, identity);
  return identity;
};

const relationshipValue = (
  parts: readonly LocalizedValue[],
  locale: string,
  formatSource: LocalizedRelationshipValue["formatSource"],
): LocalizedRelationshipValue => {
  const first = parts[0];
  const source =
    first && parts.every((part) => relationshipLanguageIdentity(part.lang) === relationshipLanguageIdentity(first.lang))
      ? first
      : resolveLocalizedText(undefined, parts.length ? "und" : locale);
  return {
    ...source,
    text: parts.map((part) => part.text).join(""),
    isFallback: parts.some((part) => part.isFallback),
    parts,
    formatSource,
  };
};

/** Resolve relation copy centrally; project list style carries no native-format claim. */
export function resolveRelationshipText(
  values: readonly unknown[],
  locale: string,
  options: RelationshipTextOptions = {},
): LocalizedRelationshipValue {
  const authored = resolveLocalizedText(presentRelationshipValue(options.authoredText), locale, options.sourceLocale);
  if (authored.text) return relationshipValue([authored], locale, "authored");

  const members = values
    .map((value) => resolveLocalizedText(value, locale, options.sourceLocale))
    .filter((value) => value.text);
  if (!members.length) return relationshipValue([], locale, "project-list");

  const format = resolveLocalizedText(presentRelationshipValue(options.format), locale, options.sourceLocale);
  const slots = [...format.text.matchAll(/\{(\d+)\}/gu)];
  if (
    slots.length &&
    slots.every((slot) => Number(slot[1]) < members.length) &&
    members.every((_, index) => slots.some((slot) => Number(slot[1]) === index)) &&
    !/[{}]/u.test(format.text.replace(/\{\d+\}/gu, ""))
  ) {
    const parts: LocalizedValue[] = [];
    let offset = 0;
    for (const slot of slots) {
      const index = slot.index;
      if (index > offset) parts.push({ ...format, text: format.text.slice(offset, index) });
      parts.push(members[Number(slot[1])]!);
      offset = index + slot[0].length;
    }
    if (offset < format.text.length) parts.push({ ...format, text: format.text.slice(offset) });
    return relationshipValue(parts, locale, "pattern");
  }

  const separator = resolveLocalizedText(presentRelationshipValue(options.separator), locale, options.sourceLocale);
  if (separator.text) {
    return relationshipValue(
      members.flatMap((member, index) => (index ? [separator, member] : [member])),
      locale,
      "separator",
    );
  }

  if (members.length === 1) return relationshipValue(members, locale, "project-list");
  const literal = resolveLocalizedText({ text: "literal", lang: canonicalLocale(locale) }, locale);
  let index = 0;
  const parts = relationshipFormatter(locale)
    .formatToParts(members.map((member) => member.text))
    .map((part) => (part.type === "element" ? members[index++]! : { ...literal, text: part.value }));
  return relationshipValue(parts, locale, "project-list");
}
