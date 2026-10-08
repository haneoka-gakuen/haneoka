import { staticCatalogRelease, fetchStaticCatalog } from "../static-catalog-source";
import { loadCrossServerCatalog } from "./load";
import type { CrossCatalogResource, OfficialCatalogServer } from "./catalog";
import { crossCatalogApi, crossCatalogDefinition, crossCatalogRows } from "./definitions";

/** Build adapter reuses the configured current-release pin and existing collection cache. */
export function loadStaticCrossServerCatalog(resource: CrossCatalogResource, selectedServer: OfficialCatalogServer, locale: string) {
  return loadCrossServerCatalog(resource, {
    selectedServer, locale,
    servers: ["jp", "intl"],
    reader: {
      async readIdentity(server) {
        const identity = await staticCatalogRelease(server);
        return { ...identity, server };
      },
      readCollection: (name, identity) => fetchStaticCatalog(crossCatalogApi(name), identity.server, identity),
      readEntity: (name, identity, id) => fetchStaticCatalog(`${crossCatalogApi(name)}/${encodeURIComponent(id)}`, identity.server, identity),
    },
  });
}

/** Entity pages inspect one original ID, rather than rebuilding the entire union per page. */
export function loadStaticCrossServerEntry(resource: CrossCatalogResource, selectedServer: OfficialCatalogServer, locale: string, id: string) {
  return loadCrossServerCatalog(resource, {
    selectedServer, locale, withDependencies: false, servers: ["jp", "intl"],
    reader: {
      async readIdentity(server) { return { ...await staticCatalogRelease(server), server }; },
      async readCollection(name, identity) {
        const document = await fetchStaticCatalog(crossCatalogApi(name), identity.server, identity);
        const rows = crossCatalogRows(name, document, id), key = crossCatalogDefinition(name).rows;
        return key ? { [key]: rows } : rows;
      },
      readEntity: (name, identity, key) => fetchStaticCatalog(`${crossCatalogApi(name)}/${encodeURIComponent(key)}`, identity.server, identity),
    },
  });
}
