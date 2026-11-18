import type { UiLocale } from "@haneoka/i18n";
import { providerRegionForLocale, type CatalogProvider, type ProviderCollectionPayload } from "./provider-page-data.ts";

export type ProviderEntityResource = "songs" | "cards" | "stories";
export interface ProviderEntityLocator {
  provider: CatalogProvider;
  locale: UiLocale;
  resource: ProviderEntityResource;
  id: string;
  section?: string;
  cardId?: string;
}
export interface ProviderEntityPayload extends ProviderEntityLocator {
  schema: "haneoka-provider-entity-v1";
  region: string;
  /** Current record and its presentation dependencies; the full index is shared. */
  collection: ProviderCollectionPayload;
  /** Exact full record produced by the existing provider projector. */
  detail: Record<string, unknown>;
  card?: Record<string, unknown>;
  collectionUrl: string;
}
export function providerEntityResourcePath(entry: Pick<ProviderEntityLocator, "resource" | "section">): string {
  if (entry.resource !== "stories") return entry.resource;
  if (!entry.section) throw new TypeError("Story entity section is required");
  return `stories-${entry.section}`;
}
export function providerEntityHtmlPath(entry: ProviderEntityLocator): string {
  return `/provider-static/${entry.provider}/${entry.locale}/${providerEntityResourcePath(entry)}/${encodeURIComponent(entry.id)}.html`;
}
export function providerEntityJsonPath(entry: ProviderEntityLocator): string {
  return providerEntityHtmlPath(entry).replace(/\.html$/u, ".json");
}
export function providerEntityRoute(entry: ProviderEntityLocator): string {
  const { provider, locale, resource, id, section } = entry;
  if (resource === "songs")
    return `/${locale}/community/${provider === "bestdori" ? "gbp/songs" : "sekai/songs"}/detail/?${new URLSearchParams({ song: id })}`;
  if (resource === "cards") {
    if (provider !== "bestdori") throw new TypeError("This provider has no card entity view");
    return `/${locale}/community/gbp/stories/card/${encodeURIComponent(id)}/`;
  }
  if (!section) throw new TypeError("Story entity section is required");
  return `/${locale}/community/${provider === "bestdori" ? "gbp/stories" : "sekai/stories"}/${section}/${encodeURIComponent(id)}/`;
}

const numericId = (value: unknown) => {
  const id = String(value ?? "");
  return /^[1-9]\d*$/u.test(id) ? id : undefined;
};

/** Upstream routes use their source IDs, including the chapter and episode where applicable. */
export function providerDetailHref(entry: ProviderEntityLocator, row: Record<string, unknown> = {}): string | undefined {
  const { provider, locale, resource, section, id } = entry;
  const number = numericId(id);
  const bestdori = "https://bestdori.com";
  const sekai = "https://sekai.best";
  if (resource === "songs" && number) return provider === "bestdori" ? `${bestdori}/info/songs/${number}` : `${sekai}/music/${number}`;
  if (resource === "cards" && number && provider === "bestdori") return `${bestdori}/info/cards/${number}`;
  if (resource !== "stories" || !section) return;

  const chapter = numericId(row.eventId ?? row.chapterId);
  const episode = numericId(row.episodeNumber);
  if (provider === "bestdori") {
    const source = String(row.sourceServer ?? "");
    const region = /^(jp|en|tw|cn|kr)$/u.test(source) ? source : providerRegionForLocale(locale);
    const base = `${bestdori}/tool/storyviewer/${section}/${region}`;
    if (section === "event" && chapter && episode) return `${base}/${chapter}/${episode}`;
    if (section === "band") {
      const scenario = String(row.scenarioId ?? id.slice(5));
      if (/^band[0-9]+-[0-9]+$/u.test(scenario)) return `${base}/${scenario}`;
    }
    if (section === "main" || section === "afterlive") {
      const key = numericId(id.slice(section.length + 1));
      if (key) return `${base}/${key}`;
    }
    if (section === "card") {
      const card = numericId(entry.cardId ?? row.cardId);
      const part = numericId(row.episodeId ?? row.episodeNumber);
      if (card) return part ? `${base}/${card}/${part}` : `${bestdori}/info/cards/${card}`;
    }
    return `${bestdori}/tool/storyviewer`;
  }

  const reader = `${sekai}/storyreader`;
  switch (section) {
    case "event": return chapter && episode ? `${reader}/eventStory/${chapter}/${episode}` : `${reader}/eventStory`;
    case "special": return chapter && episode ? `${reader}/specialStory/${chapter}/${episode}` : `${reader}/specialStory`;
    case "character": return chapter ? `${reader}/charaStory/${chapter}` : `${reader}/charaStory`;
    case "area": return chapter && episode ? `${reader}/areaTalk/${chapter}/${episode}` : `${reader}/areaTalk`;
    case "mysekai": return episode ? `${reader}/mysekaiTalk/${episode}` : `${reader}/mysekaiTalk`;
    case "live": return chapter ? `${sekai}/virtual_live/${chapter}` : `${sekai}/virtual_live`;
    case "card": {
      const character = numericId(row.characterId);
      return chapter && character && episode ? `${reader}/cardStory/${character}/${chapter}/${episode}`
        : chapter ? `${sekai}/card/${chapter}` : `${reader}/cardStory`;
    }
    case "unit": {
      const unit = /^sekai:unit:([a-z_]+)$/u.exec(String(row.chapterKey))?.[1];
      if (!unit) return `${reader}/unitStory`;
      const chapterNo = numericId(Number(/_(\d+)_\d+$/u.exec(String(row.scenarioId))?.[1]));
      return chapterNo && episode ? `${reader}/unitStory/${unit}/${chapterNo}/${episode}` : `${reader}/unitStory/${unit}`;
    }
    default: return reader;
  }
}
