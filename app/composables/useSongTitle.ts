import {
  localizeArchiveValue,
  resolveArchiveValue,
  type ArchiveLocale,
  type ResolveArchiveValueOptions,
} from "~/i18n/locales";
import type { LocalizedValue } from "~/types/archive";

/**
 * Resolve song titles honoring the "force Japanese song titles" display setting.
 *
 * When the setting is on, song titles always resolve to the Japanese slot
 * (carrying `lang="ja"` so per-locale fonts still load); otherwise they follow
 * the active UI locale. Only the song title is affected — artist, composer,
 * lyricist and arranger keep using the regular locale. Applies equally to Our
 * Notes and Bestdori songs, since both carry `musicTitle` as a LocalizedValue.
 */
export const useSongTitle = () => {
  const { locale } = useLocale();
  const settings = useSongDisplaySettings();
  const forceJapaneseTitles = computed(() => settings.value.forceJapaneseTitles);
  const titleLocale = computed<ArchiveLocale>(() => (forceJapaneseTitles.value ? "ja" : locale.value));

  /** Plain localized title string (for search/sort comparisons). */
  const localizeSongTitle = (value: LocalizedValue | null | undefined): string =>
    localizeArchiveValue(value, titleLocale.value);

  /** Resolved title carrying the correct `lang` for per-locale font loading. */
  const resolveSongTitle = (
    value: LocalizedValue | null | undefined,
    options: ResolveArchiveValueOptions = {},
  ) =>
    resolveArchiveValue(value, titleLocale.value, {
      ...options,
      ...(forceJapaneseTitles.value ? { sourceHint: "ja" } : {}),
    });

  return { forceJapaneseTitles, titleLocale, localizeSongTitle, resolveSongTitle };
};
