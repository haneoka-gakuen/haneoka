import { crossServerPublicCache } from "./cache";
import { loadCrossServerCatalog } from "./load";
import { loadCrossServerCatalogs } from "./bundle";
import type { CrossCatalogReader } from "./load";
import { OFFICIAL_CATALOG_SERVERS, type CrossCatalogResource, type OfficialCatalogServer, type CrossCatalogDTO, type CrossCatalogSnapshot } from "./catalog";
import { visibleContentServers } from "../test-server-visibility";

/** Reuse already rendered source rows when adding a new optional source to a home seed. */
export function crossCatalogSeedSources(catalogs: Partial<Record<CrossCatalogResource, CrossCatalogDTO>>): CrossCatalogSnapshot[] {
  const sources = new Map<OfficialCatalogServer, CrossCatalogSnapshot>();
  for (const dto of Object.values(catalogs)) if (dto) {
    for (const server of OFFICIAL_CATALOG_SERVERS) {
      const identity = dto.identities[server];
      if (!identity || dto.sourceAvailability[server] !== "loaded") continue;
      const source = sources.get(server) ?? { identity, collections: {}, documents: {} };
      source.collections[dto.resource] = Object.fromEntries(dto.entries.flatMap((entry) => {
        const variant = entry.perServer[server];
        return variant ? [[variant.id, variant.row]] : [];
      }));
      if (dto.documents[server]) source.documents![dto.resource] = dto.documents[server];
      sources.set(server, source);
    }
  }
  return [...sources.values()];
}

/** Browser adapter: bounded public JSON cache, with short-lived current observations. */
function reader(options: { signal?: AbortSignal; fetcher?: typeof fetch; revalidate?: boolean }): CrossCatalogReader {
  const cache = crossServerPublicCache(options.fetcher);
  return {
    readIdentity: (server) => cache.readIdentity(server, options.signal, options.revalidate),
    readCollection: (resource, identity) => cache.readCollection(resource, identity, options.signal),
    readEntity: (resource, identity, id) => cache.readEntity(resource, identity, id, options.signal),
  };
}
export function fetchCrossServerCatalog(
  resource: CrossCatalogResource, selectedServer: OfficialCatalogServer, locale: string,
  options: { signal?: AbortSignal; fetcher?: typeof fetch; revalidate?: boolean } = {},
) {
  return loadCrossServerCatalog(resource, { selectedServer, locale, reader: reader(options), servers: visibleContentServers(OFFICIAL_CATALOG_SERVERS) })
    .then((catalog) => { options.signal?.throwIfAborted(); return catalog; });
}
export function fetchCrossServerCatalogs(
  resources: readonly CrossCatalogResource[], selectedServer: OfficialCatalogServer, locale: string,
  options: { signal?: AbortSignal; fetcher?: typeof fetch; revalidate?: boolean; servers?: readonly OfficialCatalogServer[]; initialSources?: readonly CrossCatalogSnapshot[] } = {},
) {
  return loadCrossServerCatalogs(resources, { selectedServer, locale, reader: reader(options), servers: visibleContentServers(options.servers ?? OFFICIAL_CATALOG_SERVERS), initialSources: options.initialSources?.filter((source) => visibleContentServers([source.identity.server]).length > 0) })
    .then((catalogs) => { options.signal?.throwIfAborted(); return catalogs; });
}
