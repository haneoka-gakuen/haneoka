import { LOCALES, type Locale } from "../i18n/locales";

/**
 * Resolves title collisions inside a collection. Game data repeats titles
 * across entities (shop packs share a name, the same home conversation runs
 * per character), and identical titles read as doorway pages to search
 * engines. Candidates are tried in order per locale and only appended when
 * the group is still colliding; the fallback fires last.
 */
export function disambiguateTitles<T>(
  pages: readonly T[],
  titleOf: (page: T, locale: Locale) => string,
  setTitle: (page: T, locale: Locale, title: string) => void,
  candidates: Array<(page: T, locale: Locale) => string>,
  fallback: (page: T, locale: Locale) => string,
): void {
  for (const locale of LOCALES) {
    let colliding = pages;
    for (const candidate of [...candidates, fallback]) {
      const groups = new Map<string, T[]>();
      for (const page of colliding) {
        const key = titleOf(page, locale);
        groups.set(key, [...(groups.get(key) ?? []), page]);
      }
      colliding = [...groups.values()].filter((group) => group.length > 1).flat();
      if (!colliding.length) break;
      for (const page of colliding) {
        const suffix = candidate(page, locale);
        if (suffix) setTitle(page, locale, `${titleOf(page, locale)} · ${suffix}`);
      }
    }
  }
}
