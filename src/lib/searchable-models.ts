import { cubismModelMetadata } from "../server/captured-cubism-model-metadata";
import { LOCALES, type Locale } from "../i18n/locales";
import { resolveLocalizedText } from "./localized-text";
import {
  asRecord,
  fetchOptionalStaticCatalog,
  fetchStaticCatalog,
  fetchStaticCatalogBatch,
  staticCatalogRelease,
  type RecordValue,
} from "./static-catalog-source";
import { disambiguateTitles } from "./title-disambiguation";
import type { ReleaseServer } from "./release-server";
import { modelPreviewSources } from "./model-artwork";

export interface SearchableModelPage {
  kind: "live2d" | "spine";
  id: string;
  route: string;
  titles: Record<Locale, string>;
  subtitles: Record<Locale, string>;
  descriptions: Record<Locale, string>;
  facts: Record<Locale, Array<{ key: string; value: string }>>;
  image: string;
  model: RecordValue;
}

const text = (value: unknown, locale: Locale): string => resolveLocalizedText(value, locale).text.trim();

const localizedAll = (value: unknown): Record<Locale, string> =>
  Object.fromEntries(LOCALES.map((locale) => [locale, text(value, locale)])) as Record<Locale, string>;

const pagesPromises = new Map<ReleaseServer, Promise<SearchableModelPage[]>>();

export function searchableModelPages(server: ReleaseServer = "intl"): Promise<SearchableModelPage[]> {
  const existing = pagesPromises.get(server);
  if (existing) return existing;
  const promise = buildSearchableModelPages(server);
  pagesPromises.set(server, promise);
  return promise;
}

async function buildSearchableModelPages(server: ReleaseServer): Promise<SearchableModelPage[]> {
  const release = await staticCatalogRelease(server);
  const [live2dDocument, spineResult] = await Promise.all([
    fetchStaticCatalog("live2d", server, release),
    fetchOptionalStaticCatalog("spine", server, release),
  ]);
  const spineDocument = spineResult.value;
  const live2dRoot = asRecord(live2dDocument);
  if (!live2dRoot) throw new Error(`Invalid live2d catalog response for ${server}`);
  const spineRoot = asRecord(spineDocument);
  const spineModelsRoot = spineRoot ? asRecord(spineRoot.models) : undefined;
  if (spineDocument !== null && !spineModelsRoot) throw new Error(`Invalid spine catalog response for ${server}`);
  const live2dModels = Object.entries(live2dRoot ?? {}).flatMap(([key, raw]) => {
    const record = asRecord(raw);
    return record ? [[key, record] as [string, RecordValue]] : [];
  });
  const spineModels = Object.entries(spineModelsRoot ?? {}).flatMap(([key, raw]) => {
    const record = asRecord(raw);
    return record ? [[key, record] as [string, RecordValue]] : [];
  });

  // Motion and expression names live in the per-model detail documents.
  const live2dDetails = await fetchStaticCatalogBatch(
    "live2d",
    live2dModels.map(([key]) => key),
    server,
    release,
  );
  const spineDetails = await fetchStaticCatalogBatch(
    "spine",
    spineModels.map(([key]) => key),
    server,
    release,
  );

  const live2dPages: SearchableModelPage[] = [];
  for (const [key, model] of live2dModels) {
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
    const mergedModel = { ...model, ...detail };
    const coreMetadata = await cubismModelMetadata(mergedModel, release);
    if (coreMetadata) mergedModel.coreMetadata = coreMetadata;
    live2dPages.push({
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
      image: modelPreviewSources(mergedModel)[0] || "",
      model: mergedModel,
    });
  }

  const spinePages = spineModels.map(([key, index]) => {
    const model = { ...index, ...spineDetails.get(key) };
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
          rows.push({
            key: "animations",
            value: `${model.animationCount ?? animations.length}（${animations.join("、")}）`,
          });
        return [locale, rows];
      }),
    ) as Record<Locale, Array<{ key: string; value: string }>>;
    const preview = asRecord(model.preview);
    const previewPath =
      typeof preview?.url === "string" ? preview.url : typeof preview?.path === "string" ? preview.path : "";
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
      model,
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

export async function searchableModelUrls(server: ReleaseServer = "intl"): Promise<string[]> {
  return (await searchableModelPages(server)).map(({ route }) => `${route}/`);
}
