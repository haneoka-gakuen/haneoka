import { LOCALES, type Locale } from "../i18n/locales";
import { resolveLocalizedText } from "./localized-text";
import { asRecord, fetchStaticCatalog, type RecordValue } from "./static-catalog-source";

export interface SearchableHelpTopic {
  id: string;
  route: string;
  titles: Record<Locale, string>;
  categoryTitles: Record<Locale, string>;
  descriptions: Record<Locale, string>;
}

const text = (value: unknown, locale: Locale): string => resolveLocalizedText(value, locale).text.trim();

let pagesPromise: Promise<SearchableHelpTopic[]> | undefined;

export function searchableHelpPages(): Promise<SearchableHelpTopic[]> {
  pagesPromise ??= buildSearchableHelpPages();
  return pagesPromise;
}

async function buildSearchableHelpPages(): Promise<SearchableHelpTopic[]> {
  const document = asRecord(await fetchStaticCatalog("help"));
  const categories = Object.entries(asRecord(document)?.categories ?? {}).flatMap(([, raw]) => {
    const record = asRecord(raw);
    return record ? [record] : [];
  });
  // Categories arrive unordered; the screen sorts by its own order field.
  categories.sort((left, right) => Number(left.order ?? 0) - Number(right.order ?? 0));

  return categories.flatMap((category) => {
    const categoryTitles = Object.fromEntries(
      LOCALES.map((locale) => [locale, text(category.title, locale)]),
    ) as Record<Locale, string>;
    const topics = (Array.isArray(category.subcategories) ? category.subcategories : [])
      .map((topic) => asRecord(topic))
      .filter((topic): topic is RecordValue => !!topic)
      .sort((left, right) => Number(left.order ?? 0) - Number(right.order ?? 0));
    return topics.map((topic) => {
      const id = String(topic.helpSubcategoryId ?? "");
      const descriptions = Object.fromEntries(
        LOCALES.map((locale) => [locale, text(topic.description, locale)]),
      ) as Record<Locale, string>;
      const titles = Object.fromEntries(
        LOCALES.map((locale) => [locale, text(topic.title, locale) || id]),
      ) as Record<Locale, string>;
      return {
        id,
        route: `/catalog/help/${id}`,
        titles,
        categoryTitles,
        descriptions,
      };
    });
  });
}

export async function searchableHelpUrls(): Promise<string[]> {
  return (await searchableHelpPages()).map(({ route }) => `${route}/`);
}
