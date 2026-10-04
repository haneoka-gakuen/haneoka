import { crossServerPublicCache } from "./cache";
import { loadCrossServerCatalog } from "./load";
import { loadCrossServerCatalogs } from "./bundle";
import type { CrossCatalogReader } from "./load";
import type { CrossCatalogResource, OfficialCatalogServer } from "./catalog";

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
  return loadCrossServerCatalog(resource, { selectedServer, locale, reader: reader(options) })
    .then((catalog) => { options.signal?.throwIfAborted(); return catalog; });
}
export function fetchCrossServerCatalogs(
  resources: readonly CrossCatalogResource[], selectedServer: OfficialCatalogServer, locale: string,
  options: { signal?: AbortSignal; fetcher?: typeof fetch; revalidate?: boolean } = {},
) {
  return loadCrossServerCatalogs(resources, { selectedServer, locale, reader: reader(options) })
    .then((catalogs) => { options.signal?.throwIfAborted(); return catalogs; });
}
