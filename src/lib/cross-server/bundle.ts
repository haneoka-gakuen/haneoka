import { loadCrossServerCatalog, type CrossCatalogReader, type CrossCatalogLoadOptions } from "./load";
import type { CrossCatalogResource, OfficialCatalogServer } from "./catalog";

/** Share the two observed identities and each dependency request across one multi-panel load. */
export async function loadCrossServerCatalogs(
  resources: readonly CrossCatalogResource[],
  options: CrossCatalogLoadOptions,
) {
  const identities = new Map<OfficialCatalogServer, ReturnType<CrossCatalogReader["readIdentity"]>>();
  const collections = new Map<string, ReturnType<CrossCatalogReader["readCollection"]>>();
  const entities = new Map<string, Promise<unknown>>();
  const reader: CrossCatalogReader = {
    readIdentity(server) {
      let pending = identities.get(server);
      if (!pending) { pending = options.reader.readIdentity(server); identities.set(server, pending); }
      return pending;
    },
    readCollection(resource, identity) {
      const key = `${identity.server}\u0000${identity.releaseId}\u0000${identity.sourceId}\u0000${resource}`;
      let pending = collections.get(key);
      if (!pending) { pending = options.reader.readCollection(resource, identity); collections.set(key, pending); }
      return pending;
    },
  };
  if (options.reader.readEntity) reader.readEntity = (resource, identity, id) => {
    const key = `${identity.server}\u0000${identity.releaseId}\u0000${identity.sourceId}\u0000${resource}\u0000${id}`;
    let pending = entities.get(key);
    if (!pending) { pending = options.reader.readEntity!(resource, identity, id); entities.set(key, pending); }
    return pending;
  };
  return Object.fromEntries(await Promise.all([...new Set(resources)].map(async (resource) =>
    [resource, await loadCrossServerCatalog(resource, { ...options, reader })] as const)));
}
