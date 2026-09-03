export const LOCALES = ["ja", "en", "zh-TW", "zh-CN", "ko"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "ja";
export const isLocale = (value: unknown): value is Locale =>
  typeof value === "string" && (LOCALES as readonly string[]).includes(value);
export const localeTag = (locale: Locale) =>
  ({ ja: "ja-JP", en: "en", "zh-TW": "zh-TW", "zh-CN": "zh-CN", ko: "ko" })[locale];
export const localeFallbacks = (locale: Locale): readonly Locale[] =>
  locale === "zh-CN" ? ["zh-CN", "zh-TW", "ja", "en", "ko"] : [locale, "ja", ...LOCALES];
export const localePath = (route: string, locale: Locale) => {
  const clean = route === "/" ? "/" : `/${route.replace(/^\/+|\/+$/g, "")}`;
  void locale;
  return clean;
};
export function localizeValue(value: unknown, locale: Locale): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  for (const target of localeFallbacks(locale)) {
    const candidate = value[LOCALES.indexOf(target)];
    if (typeof candidate === "string" && candidate.trim()) return candidate;
  }
  for (const candidate of value) if (typeof candidate === "string" && candidate.trim()) return candidate;
  return "";
}
