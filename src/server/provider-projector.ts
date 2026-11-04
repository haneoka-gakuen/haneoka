import type { Locale } from "../i18n/locales";
import { providerRegionForLocale, type CatalogProvider, type ProviderCollectionPayload } from "../lib/provider-page-data";
import type { ProviderEntityLocator } from "../lib/provider-entity-data";
import { readBestdoriSource, projectBestdoriSong, projectBestdoriCards, projectBestdoriStoryCollection, projectBestdoriStory, projectBestdoriSongs, projectBestdoriBands, projectBestdoriCharacters, projectBestdoriSongMeta, publishedBestdoriRecords, setBestdoriSourceReader, type BestdoriRegion } from "../../worker/bestdori";
import { projectSekaiSongs, projectSekaiBands, projectSekaiEventStories, projectSekaiUnitStories, projectSekaiCharacterStories, projectSekaiCardStories, projectSekaiAreaStories, projectSekaiSpecialStories, projectSekaiMySekaiStories, projectSekaiLiveStories, projectSekaiStory, setSekaiSourceReader, type SekaiRegion } from "../../worker/sekai";
import type { ProviderSourceReader } from "../../worker/provider-source";

type Row = Record<string, unknown>;
export { PROVIDER_STORY_SECTIONS } from "../lib/provider-page-data";

/** The build uses the same projectors and source selection as live provider routes. */
export function createProviderProjector(reader: ProviderSourceReader) {
  setBestdoriSourceReader(reader);
  setSekaiSourceReader(reader);
  const collections = new Map<string, Promise<ProviderCollectionPayload>>();
  const sharedSekaiDetails = new Map<string, Promise<Row>>();
  const raw = async (url: string) => await readBestdoriSource(url) as Row;
  const bestdoriDependencies = async (locale: Locale) => {
    const [bands, characters] = await Promise.all([raw("/api/bands/all.1.json"), raw("/api/characters/all.5.json")]);
    return { bands: projectBestdoriBands(bands, characters, locale), characters: projectBestdoriCharacters(characters, providerRegionForLocale(locale) as BestdoriRegion) };
  };
  async function collection(provider: CatalogProvider, locale: Locale, resource: string): Promise<ProviderCollectionPayload> {
    const key = `${provider}/${locale}/${resource}`;
    let pending = collections.get(key);
    if (!pending) {
      pending = (async () => {
        const region = providerRegionForLocale(locale) as SekaiRegion;
        let document: Row, bands: unknown = {}, characters: unknown = {}, songMeta: Row | undefined;
        if (provider === "bestdori") {
          ({ bands, characters } = await bestdoriDependencies(locale));
          if (resource === "songs") {
            const [songs, meta] = await Promise.all([raw("/api/songs/all.8.json"), raw("/api/songs/meta/all.5.json")]);
            const published = publishedBestdoriRecords(songs, "publishedAt");
            document = projectBestdoriSongs(published, locale);
            songMeta = projectBestdoriSongMeta(published, meta);
          } else if (resource === "stories/card") {
            document = projectBestdoriCards(publishedBestdoriRecords(await raw("/api/cards/all.5.json"), "releasedAt"), locale);
          } else {
            const section = resource.slice("stories/".length);
            if (!["event", "band", "main", "afterlive"].includes(section)) throw new TypeError(`Unknown Bestdori collection ${resource}`);
            document = await projectBestdoriStoryCollection(section as "event" | "band" | "main" | "afterlive", locale);
          }
        } else if (resource === "songs") {
          document = await projectSekaiSongs(); bands = projectSekaiBands(); songMeta = {};
        } else {
          const producers: Record<string, () => Promise<Row>> = {
            event: () => projectSekaiEventStories(region), unit: () => projectSekaiUnitStories(region),
            character: projectSekaiCharacterStories, card: projectSekaiCardStories, area: projectSekaiAreaStories,
            special: projectSekaiSpecialStories, mysekai: projectSekaiMySekaiStories, live: projectSekaiLiveStories,
          };
          const producer = producers[resource.slice("stories/".length)];
          if (!producer) throw new TypeError(`Unknown Sekai collection ${resource}`);
          document = await producer();
        }
        return { schema: "haneoka-provider-collection-v1", provider, locale, resource, document, bands, characters, ...(songMeta ? { songMeta } : {}) };
      })();
      collections.set(key, pending);
      pending.catch(() => collections.delete(key));
    }
    return pending;
  }
  async function detail(entry: ProviderEntityLocator, source: ProviderCollectionPayload): Promise<Row> {
    if (entry.provider === "bestdori") {
      if (entry.resource === "songs") return projectBestdoriSong(Number(entry.id), await raw(`/api/songs/${entry.id}.json`), entry.locale);
      if (entry.resource === "cards") {
        const result = projectBestdoriCards({ [entry.id]: await raw(`/api/cards/${entry.id}.json`) }, entry.locale)[entry.id];
        if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error(`Invalid card detail ${entry.id}`);
        return result as Row;
      }
      return JSON.parse((await projectBestdoriStory(entry.id, providerRegionForLocale(entry.locale), entry.locale)).body) as Row;
    }
    if (entry.resource === "songs") return source.document[entry.id] as Row;
    if (entry.section === "event" || entry.section === "unit") return projectSekaiStory(providerRegionForLocale(entry.locale) as SekaiRegion, entry.id);
    // The existing otherSource resolver is Japan-only for these six sections.
    // Adjacent locale projections reuse its identical converted record.
    let pending = sharedSekaiDetails.get(entry.id);
    if (!pending) {
      pending = projectSekaiStory("jp", entry.id);
      sharedSekaiDetails.set(entry.id, pending);
      pending.catch(() => sharedSekaiDetails.delete(entry.id));
      while (sharedSekaiDetails.size > 16) sharedSekaiDetails.delete(sharedSekaiDetails.keys().next().value!);
    }
    return pending;
  }
  return { collection, detail };
}
