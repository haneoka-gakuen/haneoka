import { fetchStaticCatalog, staticCatalogRelease, type StaticCatalogRelease } from "../lib/static-catalog-source";
import { loadStaticCrossServerCatalogs } from "../lib/cross-server/static";
import { isCrossCatalogResource } from "../lib/cross-server/definitions";
import { crossServerDisplayRow, type CrossCatalogDTO, type CrossCatalogResource, type OfficialCatalogServer } from "../lib/cross-server/catalog";
import type { ReleaseServer } from "../lib/release-server";
import type { Locale } from "../i18n/locales";
import { collectionDescription } from "../lib/collection-description";
import type { ChartRateTable } from "../lib/chart-rates";
import { chartRates } from "./chart-rates";

type Row = Record<string, unknown>;
export interface CatalogCollectionPayload {
  schema: "haneoka-collection-payload-v1";
  resource: string;
  identity: StaticCatalogRelease;
  document: unknown;
  characters: unknown;
  bands: unknown;
  gameItems: unknown;
  marks: Record<string, string>;
  catalogs?: Partial<Record<CrossCatalogResource, CrossCatalogDTO>>;
  sourceMarks: Partial<Record<OfficialCatalogServer, Record<string, string>>>;
  songMeta: Partial<Record<OfficialCatalogServer, Row>>;
  /** Song meta only: per-power score rates of every chart. */
  chartRates?: Partial<Record<OfficialCatalogServer, ChartRateTable>>;
}

const collections = new Map<string, Promise<CatalogCollectionPayload>>();
export function catalogCollectionDescription(payload: CatalogCollectionPayload, locale: Locale, title: string): string {
  const resource = payload.resource === "song-meta" ? "songs" : payload.resource;
  const catalog = payload.catalogs?.[resource as CrossCatalogResource];
  const document = payload.document as Row;
  const rows = catalog ? catalog.entries.map(crossServerDisplayRow) : Object.values(document?.entries || document?.items || document || {}) as Row[];
  return collectionDescription(rows, locale, title);
}
export function catalogCollectionData(resource: string, server: ReleaseServer, locale: Locale): Promise<CatalogCollectionPayload> {
  const key = `${server}:${locale}:${resource}`;
  let pending = collections.get(key);
  if (!pending) {
    pending = loadCollection(resource, server, locale);
    collections.set(key, pending);
  }
  return pending;
}

async function loadCollection(resource: string, server: ReleaseServer, locale: Locale): Promise<CatalogCollectionPayload> {
  const identity = await staticCatalogRelease(server);
  const collection = resource === "song-meta" ? "songs" : resource;
  const cross = ["jp", "intl", "intl-test"].includes(server) && isCrossCatalogResource(collection);
  const catalogs = cross
    ? await loadStaticCrossServerCatalogs([collection, "characters", "bands"], server as OfficialCatalogServer, locale)
    : undefined;
  if (catalogs) for (const name of [collection, "characters", "bands"]) {
    const catalog = catalogs[name];
    if (!catalog || !catalog.identities[server as OfficialCatalogServer] || catalog.sourceAvailability[server as OfficialCatalogServer] !== "loaded")
      throw new Error(`Missing static catalog: ${server}/${name}`);
  }
  const [document, characters, bands, gameItems, marks] = await Promise.all([
    fetchStaticCatalog(collection, server, identity),
    fetchStaticCatalog("characters", server, identity),
    fetchStaticCatalog("bands", server, identity),
    ["cards", "support-cards"].includes(resource) ? fetchStaticCatalog("items", server, identity) : {},
    fetchStaticCatalog("ui-marks", server, identity),
  ]);
  const sourceMarks: CatalogCollectionPayload["sourceMarks"] = {};
  const songMeta: CatalogCollectionPayload["songMeta"] = {};
  const chartRateTables: NonNullable<CatalogCollectionPayload["chartRates"]> = {};
  await Promise.all(Object.values(catalogs?.[collection]?.identities || { [server]: identity }).map(async (pin) => {
    sourceMarks[pin.server as OfficialCatalogServer] = await fetchStaticCatalog("ui-marks", pin.server, pin) as Record<string, string>;
    if (collection === "songs") songMeta[pin.server as OfficialCatalogServer] = await fetchStaticCatalog("song-meta", pin.server, pin) as Row;
    if (resource === "song-meta") chartRateTables[pin.server as OfficialCatalogServer] = await chartRates(pin.server as ReleaseServer);
  }));
  return {
    schema: "haneoka-collection-payload-v1", resource, identity, document, characters, bands, gameItems,
    marks: marks as Record<string, string>, catalogs, sourceMarks, songMeta,
    ...(resource === "song-meta" ? { chartRates: chartRateTables } : {}),
  };
}
