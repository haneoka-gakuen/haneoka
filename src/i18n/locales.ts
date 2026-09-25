import { resolveLocalizedText } from "../lib/localized-text";
export const LOCALES = ["ja", "en", "zh-TW", "zh-CN", "ko"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "ja";
export const isLocale = (value: unknown): value is Locale =>
  typeof value === "string" && (LOCALES as readonly string[]).includes(value);
export const localeTag = (locale: Locale) =>
  ({ ja: "ja-JP", en: "en", "zh-TW": "zh-TW", "zh-CN": "zh-CN", ko: "ko" })[locale];
export const localeFallbacks = (locale: Locale): readonly Locale[] =>
  locale === "zh-CN" ? ["zh-CN", "zh-TW", "ja", "en", "ko"] : [locale, "ja", ...LOCALES];
/**
 * Every locale owns a language-prefixed URL (`/ja/…`, `/en/…`, …) so each
 * language can rank on its own canonical address; unprefixed paths are not
 * built and the worker redirects them to the visitor's locale.
 */
export const localePath = (route: string, locale: Locale) =>
  `/${locale}${route === "/" ? "/" : `/${route.replace(/^\/+|\/+$/g, "")}/`}`;

/** The locale baked into a pathname prefix, if any. */
export const localeFromPath = (pathname: string): Locale | undefined => {
  const prefix = pathname.replace(/^\/+/, "").split("/")[0] || "";
  return isLocale(prefix) ? prefix : undefined;
};
export function localizeValue(value: unknown, locale: Locale): string {
  return resolveLocalizedText(value, locale).text;
}
