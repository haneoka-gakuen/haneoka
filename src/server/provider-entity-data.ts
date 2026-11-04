import { providerCollectionData, readProviderCatalog } from "./provider-page-data";
import { providerCatalogBase, providerRegionForLocale, type ProviderCollectionPayload } from "../lib/provider-page-data";
import type { ProviderEntityLocator, ProviderEntityPayload } from "../lib/provider-entity-data";
import { registerProviderStaticData, readProviderStaticData } from "./provider-static-data";
import { BESTDORI_CATALOG_VERSION } from "@haneoka/bestdori/resources";

type Row = Record<string, unknown>;
const reads = new Map<string, Promise<ProviderEntityPayload>>();
export function providerEntityCollectionResource(entry: Pick<ProviderEntityLocator, "resource" | "section">): string {
  return entry.resource === "stories" ? `stories/${entry.section}` : entry.resource === "cards" ? "stories/card" : "songs";
}
export function providerEntityData(entry: ProviderEntityLocator): Promise<ProviderEntityPayload> {
  const key = JSON.stringify(entry);
  let pending = reads.get(key);
  if (!pending) {
    pending = loadEntity(entry);
    reads.set(key, pending);
    pending.then(() => reads.delete(key), () => reads.delete(key));
  }
  return pending;
}
async function loadEntity(entry: ProviderEntityLocator): Promise<ProviderEntityPayload> {
  const collection = await providerCollectionData(entry.provider, entry.locale, providerEntityCollectionResource(entry));
  const summary = collection.document[entry.id];
  if (!summary || typeof summary !== "object" || Array.isArray(summary)) throw new Error(`Provider entity is absent: ${entry.provider}/${entry.resource}/${entry.id}`);
  const detail = entry.provider === "sekai" && entry.resource === "songs"
    ? summary as Row
    : await readProviderCatalog(`${providerCatalogBase(entry.provider, entry.locale)}/${entry.resource}/${encodeURIComponent(entry.id)}?lang=${encodeURIComponent(entry.locale)}&projection=${BESTDORI_CATALOG_VERSION}`);
  return providerEntityPayload(entry, collection, detail);
}
/** The cached raw/projector batch adapter supplies these exact same production records. */
export function providerEntityPayload(entry: ProviderEntityLocator, collection: ProviderCollectionPayload, detail: Row, card?: Row): ProviderEntityPayload {
  const episode = card && (Array.isArray(card.episodes) ? card.episodes as Row[] : []).find(value => `card.${value.resourceSetName || card.resourceSetName}.${value.scenarioId}` === entry.id);
  const summary = collection.document[entry.id] || (episode ? { ...episode, storyId: entry.id } : undefined);
  if (!summary || typeof summary !== "object" || Array.isArray(summary)) throw new Error(`Provider entity is absent: ${entry.id}`);
  const songMeta = collection.songMeta?.[entry.id];
  return {
    schema: "haneoka-provider-entity-v1", ...entry, region: providerRegionForLocale(entry.locale),
    collection: { ...collection, document: { [entry.id]: summary }, ...(collection.songMeta ? { songMeta: songMeta ? { [entry.id]: songMeta as Row } : {} } : {}) },
    detail,
    ...(card ? { card } : {}),
    collectionUrl: registerProviderStaticData(collection),
  };
}
/** Build-time navigation and song documents share the full collection. */
export function providerEntityCollection(payload: ProviderEntityPayload): ProviderCollectionPayload {
  return readProviderStaticData<ProviderCollectionPayload>(payload.collectionUrl);
}
