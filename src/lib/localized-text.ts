export const TEXT_LOCALES = ["ja", "en", "zh-TW", "zh-CN", "ko"] as const;
export interface LocalizedValue {
  text: string;
  locale: string;
}

const localeCache = new Map<string, string>();
const canonicalLocale = (locale: string): string => {
  const cached = localeCache.get(locale);
  if (cached) return cached;
  try {
    const value = Intl.getCanonicalLocales(locale.replaceAll("_", "-"))[0] || locale;
    if (localeCache.size > 128) localeCache.clear();
    localeCache.set(locale, value);
    return value;
  } catch {
    return locale;
  }
};

export function localizedFallbacks(locale: string): string[] {
  const requested = canonicalLocale(locale);
  return [
    ...new Set(
      requested === "zh" || /^zh-(?:CN|Hans)(?:-|$)/u.test(requested)
        ? [requested, "zh-CN", "zh-Hans", "zh-TW", "zh-Hant", "ja", "en", "ko"]
        : /^zh-(?:TW|HK|MO|Hant)(?:-|$)/u.test(requested)
          ? [requested, "zh-TW", "zh-Hant", "ja", "en", "zh-CN", "ko"]
          : [requested, requested.split("-")[0]!, "ja", ...TEXT_LOCALES],
    ),
  ];
}

export function resolveLocalizedText(value: unknown, locale: string, sourceLocale?: string): LocalizedValue {
  const requested = canonicalLocale(locale);
  if (typeof value === "string" || typeof value === "number")
    return { text: String(value), locale: sourceLocale || requested };
  if (!value || typeof value !== "object") return { text: "", locale: requested };
  const record = value as Record<string, unknown>;
  const list = Array.isArray(value) ? value : Array.isArray(record.values) ? record.values : null;
  const order = localizedFallbacks(requested);
  if (list) {
    for (const language of new Set(order)) {
      const text = list[TEXT_LOCALES.indexOf(language as (typeof TEXT_LOCALES)[number])];
      if (typeof text === "string" && text.trim()) return { text, locale: language };
    }
    return { text: "", locale: requested };
  }
  const translations = new Map(
    Object.entries(record.variants && typeof record.variants === "object" ? record.variants : record)
      .filter(([key]) => !["id", "raw", "url", "key", "src", "ref"].includes(key))
      .map(([language, text]) => [canonicalLocale(language), text]),
  );
  for (const language of new Set(order)) {
    const text = translations.get(language);
    if (typeof text === "string" && text.trim()) return { text, locale: language };
  }
  if (!list && (record.text != null || record.value != null))
    return resolveLocalizedText(record.text ?? record.value, String(record.lang || record.locale || requested));
  for (const [language, text] of translations) {
    if (/^[a-z]{2,3}(?:-[a-z0-9]+)*$/iu.test(language) && typeof text === "string" && text.trim())
      return { text, locale: language };
  }
  return { text: "", locale: requested };
}
