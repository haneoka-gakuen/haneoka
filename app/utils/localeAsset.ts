/**
 * Locale-aware asset path resolution for multi-language resource releases.
 *
 * Reuses {@link contentLocaleFallbacks} from `@haneoka/i18n` for the fallback
 * chain (current → ja → en → zh-TW → zh-CN → ko), matching the MasterText
 * slot order. The only addition is the ArchiveLocale → Unity Addressables
 * locale-tag mapping (`zh-TW → zh-Hant`, `zh-CN → zh-Hans`), because the
 * game's asset filenames use the script-subtag form while the product's
 * locale identifiers use the region-subtag form.
 */

import { contentLocaleFallbacks, type Locale } from "@haneoka/i18n";

/** Map an ArchiveLocale to the locale tag used in Addressables asset filenames. */
const ADDRESSABLES_LOCALE_TAG: Readonly<Record<Locale, string>> = {
  ja: "ja",
  en: "en",
  "zh-TW": "zh-Hant",
  "zh-CN": "zh-Hans",
  ko: "ko",
};

/**
 * Insert `({localeTag})` before the extension of the last path segment.
 *
 * `Assets/.../band_logo.png` → `Assets/.../band_logo(ja).png`.
 * If the path already contains a parenthesised tag, it is returned unchanged
 * (the caller already resolved the locale).
 */
const insertLocaleTag = (path: string, localeTag: string): string => {
  const slash = path.lastIndexOf("/");
  const parent = slash >= 0 ? path.slice(0, slash + 1) : "";
  const leaf = slash >= 0 ? path.slice(slash + 1) : path;
  if (leaf.includes("(")) return path; // already tagged
  const dot = leaf.lastIndexOf(".");
  if (dot > 0) return `${parent}${leaf.slice(0, dot)}(${localeTag})${leaf.slice(dot)}`;
  return `${parent}${leaf}(${localeTag})`;
};

/**
 * Construct the locale-specific variant of an asset path, for the requested
 * locale. If the asset is shared (no locale variant in the release), the
 * caller should fall back to the un-namespaced base path via `<img onerror>`.
 */
export const localizedAssetPath = (basePath: string, locale: Locale): string =>
  insertLocaleTag(basePath, ADDRESSABLES_LOCALE_TAG[locale] ?? "ja");

/**
 * Return the full ordered fallback chain of locale-specific asset paths.
 *
 * Uses {@link contentLocaleFallbacks} so the order matches text fallback:
 * requested locale → ja → en → zh-TW → zh-CN → ko. The caller iterates
 * and uses the first path that resolves (or the last as a final fallback).
 */
export const localizedAssetFallbackChain = (basePath: string, locale: Locale): readonly string[] =>
  contentLocaleFallbacks(locale).map((candidate) => localizedAssetPath(basePath, candidate));
