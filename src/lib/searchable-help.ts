import { publicationFields } from "./content-publication";
import { LOCALES, type Locale } from "../i18n/locales";
import { resolveLocalizedText } from "./localized-text";
import { asRecord, fetchStaticCatalog, staticCatalogRelease, type RecordValue } from "./static-catalog-source";
import type { ReleaseServer } from "./release-server";

export interface SearchableHelpTopic {
  id: string;
  route: string;
  titles: Record<Locale, string>;
  categoryTitles: Record<Locale, string>;
  descriptions: Record<Locale, string>;
  publication: Record<string, unknown>;
}

const text = (value: unknown, locale: Locale): string => resolveLocalizedText(value, locale).text.trim();

const pagesPromises = new Map<ReleaseServer, Promise<SearchableHelpTopic[]>>();

export function searchableHelpPages(server: ReleaseServer = "intl"): Promise<SearchableHelpTopic[]> {
  const existing = pagesPromises.get(server);
  if (existing) return existing;
  const promise = buildSearchableHelpPages(server);
  pagesPromises.set(server, promise);
  return promise;
}

async function buildSearchableHelpPages(server: ReleaseServer): Promise<SearchableHelpTopic[]> {
  const release = await staticCatalogRelease(server);
  const document = asRecord(await fetchStaticCatalog("help", server, release));
  if (!document) throw new Error(`Invalid help catalog response for ${server}`);
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
      const titles = Object.fromEntries(LOCALES.map((locale) => [locale, text(topic.title, locale) || id])) as Record<
        Locale,
        string
      >;
      return {
        id,
        route: `/catalog/help/${id}`,
        titles,
        categoryTitles,
        descriptions,
        publication: publicationFields(topic),
      };
    });
  });
}

export async function searchableHelpUrls(server: ReleaseServer = "intl"): Promise<string[]> {
  return (await searchableHelpPages(server)).map(({ route }) => `${route}/`);
}
