// L3 — GEB
// Input: Explicit immutable release roots and the executing projector's registration.
// Output: Complete core snapshots using the same collection and entity projectors as SSR.
// Pos: [Map](L2-2.md); fixed-input page snapshot production entry.
// Effects/Dependencies: Reads validated local release data; writes through the supplied object store.
import {
  PAGE_CONTRACT,
  PAGE_SCOPE,
  PAGE_SERVERS,
  type PageContext,
  type PageProducer,
  type PageKind,
} from "../lib/catalog-page-contract";
import { crossCatalogRows } from "../lib/cross-server/definitions";
import { fetchStaticCatalog, staticCatalogRelease } from "../lib/static-catalog-source";
import { buildCoreEntityPayloads, type EntityPayload } from "../lib/entity-graph";
import { catalogCollectionData } from "./catalog-collection";
import { catalogPageData } from "./catalog-page-projector";
import { eventSongPayload } from "./event-song-release";
import { buildPageSnapshot, type PageObjectStore } from "./catalog-page-snapshot";

export async function produceCatalogPages(store: PageObjectStore, producer: PageProducer) {
  if (!process.env.CATALOG_PAGE_RELEASE_ROOTS)
    throw new Error("Page production requires explicit immutable release roots");
  const pins = await Promise.all(PAGE_SERVERS.map((server) => staticCatalogRelease(server)));
  const context: PageContext = {
    contract: PAGE_CONTRACT,
    scope: PAGE_SCOPE,
    projectorRevision: producer.projectorRevision,
    resourceVector: pins.map((pin, index) => ({ ...pin, server: PAGE_SERVERS[index]!, state: "published" })),
  };
  const bases = new Map<string, Map<string, EntityPayload>>();
  const pinMedia = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(pinMedia);
    if (value && typeof value === "object")
      return Object.fromEntries(Object.entries(value).map(([key, row]) => [key, pinMedia(row)]));
    if (typeof value !== "string") return value;
    const match = /^\/(?:assets|runtime)\/(jp|intl)\//u.exec(value);
    if (!match) return value;
    const pin = pins.find((row) => row.server === match[1])!;
    const url = new URL(value, "https://page.invalid");
    url.searchParams.set("release", pin.releaseId);
    return `${url.pathname}${url.search}${url.hash}`;
  };
  const ready = await buildPageSnapshot(store, context, {
    ids: async (server, resource) => {
      const document = await fetchStaticCatalog(resource, server);
      const ids = Object.keys(crossCatalogRows(resource, document)).sort();
      bases.set(`${server}/${resource}`, await buildCoreEntityPayloads(server, resource, ids));
      return ids;
    },
    collection: async (selector) => {
      const payload = await catalogCollectionData(selector.resource, selector.server, selector.locale);
      for (const catalog of Object.values(payload.catalogs || {})) {
        if (!catalog) throw new Error("Missing core collection association");
        for (const pin of pins) {
          const identity = catalog.identities[pin.server as (typeof PAGE_SERVERS)[number]];
          if (
            !identity ||
            identity.releaseId !== pin.releaseId ||
            identity.sourceId !== pin.sourceId ||
            catalog.sourceAvailability[pin.server as (typeof PAGE_SERVERS)[number]] !== "loaded"
          )
            throw new Error("Incomplete core collection source vector");
        }
      }
      return pinMedia(payload);
    },
    entity: async (selector) => {
      const payload = await catalogPageData(
        selector.server,
        selector.resource as PageKind,
        selector.id,
        selector.locale,
        "core",
        bases.get(`${selector.server}/${selector.resource}`)?.get(selector.id),
      );
      return pinMedia(selector.resource === "events" ? await eventSongPayload(payload) : payload);
    },
  });
  return { ready, context };
}
