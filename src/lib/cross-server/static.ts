import { assertStaticServer, staticCatalogRelease, fetchStaticCatalog, fetchStaticCatalogBatch, primeStaticCatalogBatch, type StaticCatalogRelease } from "../static-catalog-source";
import { loadCrossServerCatalog } from "./load";
import { loadCrossServerCatalogs } from "./bundle";
import type { CrossCatalogResource, OfficialCatalogServer } from "./catalog";
import { crossCatalogApi, crossCatalogDefinition, crossCatalogRows } from "./definitions";
import { shopStarRewards } from "../shop-currency";

const songCollections = new Map<string, Promise<unknown>>();
const shopCollections = new Map<string, Promise<unknown>>();
const entryBatches = new Map<string, Promise<void>>();
async function completeRows(resource: CrossCatalogResource, ids: readonly string[], identity: StaticCatalogRelease) {
  await primeStaticCatalogBatch(resource, ids, identity.server, identity);
  return new Map(await Promise.all(ids.map(async (id) => [id,
    await fetchStaticCatalog(`${resource}/${encodeURIComponent(id)}`, identity.server, identity) as Record<string, unknown>,
  ] as const)));
}
function prepareEntryBatch(resource: CrossCatalogResource, identity: StaticCatalogRelease, document: unknown): Promise<void> {
  if (process.env.STATIC_BUILD_INPUT_MODE === "frozen") return Promise.resolve();
  const key = JSON.stringify([identity.server, identity.releaseId, identity.sourceId, resource]);
  let pending = entryBatches.get(key);
  if (!pending) {
    pending = primeStaticCatalogBatch(crossCatalogApi(resource), Object.keys(crossCatalogRows(resource, document)), identity.server, identity)
      .catch((error) => console.warn(`Static catalog: could not preload ${identity.server}/${resource} details`, error));
    entryBatches.set(key, pending);
  }
  return pending;
}
function collectionWithDerivedFields(resource: CrossCatalogResource, identity: StaticCatalogRelease): Promise<unknown> {
  if (resource === "shop") {
    const key = JSON.stringify(identity);
    let pending = shopCollections.get(key);
    if (!pending) {
      pending = (async () => {
        const document = await fetchStaticCatalog("shop", identity.server, identity) as Record<string, unknown>;
        const rows = crossCatalogRows("shop", document);
        const details = await completeRows("shop", Object.keys(rows), identity);
        const passIds = [...new Set([...details.values()].flatMap((item) =>
          (item.rewards as Array<Record<string, unknown>>).filter((reward) => reward.resourceType === 6)
            .map((reward) => `monthly-${reward.resourceId}`)))];
        const passes = await completeRows("passes", passIds, identity);
        return { ...document, entries: Object.fromEntries(Object.entries(rows).map(([id, row]) => [id, {
          ...row, starRewards: shopStarRewards(details.get(id)!.rewards as Array<Record<string, unknown>>, passes),
        }])) };
      })();
      shopCollections.set(key, pending);
    }
    return pending;
  }
  if (resource !== "songs") return fetchStaticCatalog(crossCatalogApi(resource), identity.server, identity);
  const key = JSON.stringify(identity);
  let pending = songCollections.get(key);
  if (!pending) {
    pending = (async () => {
      const document = await fetchStaticCatalog("songs", identity.server, identity);
      const rows = crossCatalogRows("songs", document);
      const details = await fetchStaticCatalogBatch("songs", Object.keys(rows), identity.server, identity);
      return Object.fromEntries(Object.entries(rows).map(([id, row]) => [id, {
        ...row, gekisou: details.get(id)!.gekisou,
      }]));
    })();
    songCollections.set(key, pending);
  }
  return pending;
}

export function loadStaticCrossServerCatalogs(resources: readonly CrossCatalogResource[], selectedServer: OfficialCatalogServer, locale: string) {
  assertStaticServer(selectedServer);
  return loadCrossServerCatalogs(resources, {
    selectedServer, locale, servers: ["jp", "intl"],
    reader: {
      async readIdentity(server) { return { ...await staticCatalogRelease(server), server }; },
      readCollection: (name, identity) => collectionWithDerivedFields(name, identity),
      readEntity: (name, identity, id) => fetchStaticCatalog(`${crossCatalogApi(name)}/${encodeURIComponent(id)}`, identity.server, identity),
    },
  });
}

/** Build adapter reuses the configured current-release pin and existing collection cache. */
export function loadStaticCrossServerCatalog(resource: CrossCatalogResource, selectedServer: OfficialCatalogServer, locale: string) {
  assertStaticServer(selectedServer);
  return loadCrossServerCatalog(resource, {
    selectedServer, locale,
    servers: ["jp", "intl"],
    reader: {
      async readIdentity(server) {
        const identity = await staticCatalogRelease(server);
        return { ...identity, server };
      },
      readCollection: (name, identity) => name === "shop" ? collectionWithDerivedFields(name, identity)
        : fetchStaticCatalog(crossCatalogApi(name), identity.server, identity),
      readEntity: (name, identity, id) => fetchStaticCatalog(`${crossCatalogApi(name)}/${encodeURIComponent(id)}`, identity.server, identity),
    },
  });
}

/** Entity pages inspect one original ID, rather than rebuilding the entire union per page. */
export function loadStaticCrossServerEntry(resource: CrossCatalogResource, selectedServer: OfficialCatalogServer, locale: string, id: string) {
  assertStaticServer(selectedServer);
  return loadCrossServerCatalog(resource, {
    selectedServer, locale, withDependencies: false, servers: ["jp", "intl"],
    reader: {
      async readIdentity(server) { return { ...await staticCatalogRelease(server), server }; },
      async readCollection(name, identity) {
        const document = name === "shop" ? await collectionWithDerivedFields(name, identity)
          : await fetchStaticCatalog(crossCatalogApi(name), identity.server, identity);
        await prepareEntryBatch(name, identity, document);
        const rows = crossCatalogRows(name, document, id), key = crossCatalogDefinition(name).rows;
        return key ? { [key]: rows } : rows;
      },
      readEntity: (name, identity, key) => fetchStaticCatalog(`${crossCatalogApi(name)}/${encodeURIComponent(key)}`, identity.server, identity),
    },
  });
}
