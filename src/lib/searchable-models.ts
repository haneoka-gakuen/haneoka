import { LOCALES, type Locale } from "../i18n/locales";
import { resolveLocalizedText } from "./localized-text";
import { asRecord, fetchStaticCatalog, fetchStaticCatalogBatch, type RecordValue } from "./static-catalog-source";
import { disambiguateTitles } from "./title-disambiguation";

export interface SearchableModelPage {
  kind: "live2d" | "spine";
  id: string;
  route: string;
  titles: Record<Locale, string>;
  subtitles: Record<Locale, string>;
  descriptions: Record<Locale, string>;
  facts: Record<Locale, Array<{ key: string; value: string }>>;
  image: string;
}

const text = (value: unknown, locale: Locale): string => resolveLocalizedText(value, locale).text.trim();

const localizedAll = (value: unknown): Record<Locale, string> =>
  Object.fromEntries(LOCALES.map((locale) => [locale, text(value, locale)])) as Record<Locale, string>;

let pagesPromise: Promise<SearchableModelPage[]> | undefined;

export function searchableModelPages(): Promise<SearchableModelPage[]> {
  pagesPromise ??= buildSearchableModelPages();
  return pagesPromise;
}

async function buildSearchableModelPages(): Promise<SearchableModelPage[]> {
  const [live2dDocument, spineDocument] = await Promise.all([
    fetchStaticCatalog("live2d"),
    fetchStaticCatalog("spine"),
  ]);
  const live2dModels = Object.entries(asRecord(live2dDocument) ?? {}).flatMap(([key, raw]) => {
    const record = asRecord(raw);
    return record ? [[key, record] as [string, RecordValue]] : [];
  });
  const spineModels = Object.entries(asRecord(asRecord(spineDocument)?.models) ?? {}).flatMap(([key, raw]) => {
    const record = asRecord(raw);
    return record ? [[key, record] as [string, RecordValue]] : [];
  });

  // Motion and expression names live in the per-model detail documents.
  const live2dDetails = await fetchStaticCatalogBatch(
    "live2d",
    live2dModels.map(([key]) => key),
  );

  const live2dPages = live2dModels.map(([key, model]) => {
    const detail = live2dDetails.get(key) ?? model;
    const character = localizedAll(model.characterName);
    const costumes = localizedAll(model.title);
    const titles = Object.fromEntries(
      LOCALES.map((locale) => {
        const name = character[locale] || key;
        const costume = costumes[locale];
        return [locale, costume && costume !== character[locale] ? `${name} · ${costume}` : name];
      }),
    ) as Record<Locale, string>;
    const factRows = (source: RecordValue, key: string): string[] =>
      (Array.isArray(source[key]) ? (source[key] as RecordValue[]) : [])
        .map((row) => text(row.name, "ja"))
        .filter(Boolean);
    const facts = Object.fromEntries(
      LOCALES.map((locale) => {
        const rows: Array<{ key: string; value: string }> = [];
        const nickname = text(model.nickname, locale);
        if (nickname && nickname !== character[locale]) rows.push({ key: "nickname", value: nickname });
        rows.push({ key: "model", value: String(model.live2dKey ?? key) });
        if (model.modelType) rows.push({ key: "type", value: String(model.modelType) });
        if (model.quality) rows.push({ key: "quality", value: String(model.quality) });
        const motions = factRows(detail, "motions");
        if (motions.length) rows.push({ key: "motion", value: motions.join("、") });
        const expressions = factRows(detail, "expressions");
        if (expressions.length) rows.push({ key: "expression", value: expressions.join("、") });
        return [locale, rows];
      }),
    ) as Record<Locale, Array<{ key: string; value: string }>>;
    const preview = asRecord(model.preview);
    return {
      kind: "live2d" as const,
      id: key,
      route: `/catalog/live2d/${key}`,
      titles,
      subtitles: character,
      descriptions: Object.fromEntries(
        LOCALES.map((locale) => [
          locale,
          [titles[locale], character[locale], text(model.nickname, locale)]
            .filter(Boolean)
            .filter((value, index, all) => all.indexOf(value) === index)
            .join(" · "),
        ]),
      ) as Record<Locale, string>,
      facts,
      image: typeof preview?.runtime === "string" ? preview.runtime : "",
    };
  });

  const spinePages = spineModels.map(([key, model]) => {
    const id = String(model.id ?? key);
    const animations = (Array.isArray(model.animations) ? model.animations : [])
      .map((name) => text(name, "ja"))
      .filter(Boolean);
    const facts = Object.fromEntries(
      LOCALES.map((locale) => {
        const rows: Array<{ key: string; value: string }> = [];
        if (model.family) rows.push({ key: "family", value: String(model.family) });
        if (model.spineVersion) rows.push({ key: "version", value: String(model.spineVersion) });
        if (model.skinCount != null) rows.push({ key: "costumeId", value: String(model.skinCount) });
        if (animations.length)
          rows.push({ key: "animations", value: `${model.animationCount ?? animations.length}（${animations.join("、")}）` });
        return [locale, rows];
      }),
    ) as Record<Locale, Array<{ key: string; value: string }>>;
    const preview = asRecord(model.preview);
    const previewPath = typeof preview?.url === "string" ? preview.url : typeof preview?.path === "string" ? preview.path : "";
    return {
      kind: "spine" as const,
      id,
      route: `/catalog/spine/${id}`,
      titles: Object.fromEntries(LOCALES.map((locale) => [locale, id])) as Record<Locale, string>,
      subtitles: Object.fromEntries(LOCALES.map((locale) => [locale, String(model.family || "")])) as Record<
        Locale,
        string
      >,
      descriptions: Object.fromEntries(
        LOCALES.map((locale) => [
          locale,
          [id, String(model.family || ""), `${animations.length} animations`].filter(Boolean).join(" · "),
        ]),
      ) as Record<Locale, string>,
      facts,
      image: previewPath.startsWith("/") ? previewPath : previewPath ? `/${previewPath}` : "",
    };
  });

  // Live-mode and stage variants of one costume resolve to the same
  // character + costume title; the internal model name tells them apart.
  disambiguateTitles(
    live2dPages,
    (page, locale) => page.titles[locale],
    (page, locale, title) => {
      page.titles[locale] = title;
    },
    [],
    (page) => page.id,
  );
  for (const page of live2dPages)
    page.descriptions = Object.fromEntries(
      LOCALES.map((locale) => [
        locale,
        [page.titles[locale], page.subtitles[locale]]
          .filter(Boolean)
          .filter((value, index, all) => all.indexOf(value) === index)
          .join(" · "),
      ]),
    ) as Record<Locale, string>;

  return [...live2dPages, ...spinePages];
}

export async function searchableModelUrls(): Promise<string[]> {
  return (await searchableModelPages()).map(({ route }) => `${route}/`);
}
