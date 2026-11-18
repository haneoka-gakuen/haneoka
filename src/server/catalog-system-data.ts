import { arenaCatalog } from "./arena-catalog";
import { rankingCardsPageData } from "./tool-page-data";
import { loadStaticCrossServerCatalog } from "../lib/cross-server/static";
import { OFFICIAL_CATALOG_SERVERS, type CrossCatalogResource, type OfficialCatalogServer } from "../lib/cross-server/catalog";
import { isCrossCatalogResource } from "../lib/cross-server/definitions";
import { pinCrossCatalogValue } from "../lib/cross-server/presentation";
import { fetchStaticCatalog, fetchStaticCatalogBatch, staticCatalogRelease } from "../lib/static-catalog-source";
import { tgwCardArtwork, type CatalogSystemKind, type CatalogSystemPayload } from "../lib/catalog-system-data";
import type { ReleaseServer } from "../lib/release-server";
import type { Locale } from "../i18n/locales";

const pages = new Map<string, Promise<CatalogSystemPayload>>();
const entityBatches = new Map<string, Promise<{ pointName: unknown; documents: Map<string, Record<string, unknown>>; release: { releaseId: string; sourceId: string } }>>();
export async function catalogSystemEntityData(kind: "missions" | "tgw-card", server: ReleaseServer, id: string): Promise<CatalogSystemPayload> {
  const key = `${server}:${kind}`;
  let batch = entityBatches.get(key);
  if (!batch) {
    batch = (async () => {
      const release = await staticCatalogRelease(server);
      const index = await fetchStaticCatalog(kind, server, release) as Record<string, unknown>;
      const ids = Object.keys(index.entries as Record<string, unknown>);
      const documents = await fetchStaticCatalogBatch(kind, ids, server, release);
      return { documents, pointName: index.pointName, release: { releaseId: release.releaseId, sourceId: release.sourceId } };
    })();
    entityBatches.set(key, batch);
  }
  const source = await batch;
  const document = source.documents.get(id);
  if (!document) throw new Error(`Missing static entity: ${server}/${kind}/${id}`);
  const data = kind === "tgw-card"
    ? pinCrossCatalogValue({ ...document, artwork: tgwCardArtwork(document.image) }, { ...source.release, server: server as OfficialCatalogServer }) as Record<string, unknown>
    : document;
  return { schema: "haneoka-catalog-system-v1", kind, server, entityId: id,
    release: source.release, document: data, ...(kind === "tgw-card" ? { pointName: source.pointName } : {}) };
}
export function catalogSystemData(kind: CatalogSystemKind, server: ReleaseServer, locale: Locale, mode?: string): Promise<CatalogSystemPayload> {
  const key = `${kind}:${server}:${locale}:${mode || ""}`;
  let pending = pages.get(key);
  if (!pending) {
    pending = loadData(kind, server, locale, mode);
    pages.set(key, pending);
  }
  return pending;
}
async function loadData(kind: CatalogSystemKind, server: ReleaseServer, locale: Locale, mode?: string): Promise<CatalogSystemPayload> {
  const payload: CatalogSystemPayload = { schema: "haneoka-catalog-system-v1", kind, server };
  if (kind === "arena") {
    const release = await staticCatalogRelease(server);
    payload.arena = await arenaCatalog(server, release);
    payload.marks = await fetchStaticCatalog("ui-marks", server, release) as Record<string, string>;
    payload.rankingCards = await rankingCardsPageData();
    return payload;
  }
  if (kind === "studio") {
    const release = await staticCatalogRelease(server);
    payload.release = { releaseId: release.releaseId, sourceId: release.sourceId };
    payload.document = pinCrossCatalogValue(await fetchStaticCatalog("studio", server, release), { ...release, server: server as OfficialCatalogServer }) as Record<string, unknown>;
    return payload;
  }
  const resource = kind === "anon-tokyo" ? `anon-tokyo/${mode || "characters"}` : kind;
  if (!isCrossCatalogResource(resource)) throw new Error(`Unknown catalog system ${resource}`);
  const catalog = await loadStaticCrossServerCatalog(resource as CrossCatalogResource, server as OfficialCatalogServer, locale);
  if (Object.values(catalog.sourceAvailability).every(value => value !== "loaded")) throw new Error(`Static catalog unavailable: ${resource}`);
  payload.catalog = catalog;
  if (kind === "tgw-card") {
    const tierDetails: Record<string, Record<string, unknown>> = {};
    await Promise.all(OFFICIAL_CATALOG_SERVERS.map(async (source) => {
      const identity = catalog.identities[source];
      const selected = catalog.entries.filter(entry => entry.displayServer === source);
      if (!identity || !selected.length) return;
      const details = await fetchStaticCatalogBatch("tgw-card", selected.map(entry => entry.perServer[source]!.id), source, identity);
      for (const entry of selected) {
        const id = entry.perServer[source]!.id;
        const detail = details.get(id);
        if (!detail || String(detail.id) !== id) throw new Error(`T.G.W detail unavailable: ${source}/${id}`);
        const row = { ...entry.perServer[source]!.row, ...detail };
        tierDetails[entry.key] = pinCrossCatalogValue({ ...row, artwork: tgwCardArtwork(row.image) }, identity) as Record<string, unknown>;
      }
    }));
    payload.tierDetails = tierDetails;
  }
  if (kind === "anon-tokyo") {
    payload.mode = mode || "characters";
    if (mode === "fever") {
      const bands = await fetchStaticCatalog("bands", server, await staticCatalogRelease(server));
      payload.bands = Object.values(bands as Record<string, Record<string, unknown>>);
    }
  }
  return payload;
}
