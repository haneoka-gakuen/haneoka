import { crossServerPublicCache } from "./cache";
import { crossCatalogRowId } from "./definitions";
import { withEventStoryVisibility } from "../content-publication";
import {
  crossServerDetail,
  type CrossCatalogEntry,
  type CrossCatalogIdentity,
  type CrossCatalogResource,
  type CrossCatalogRow,
  type OfficialCatalogServer,
} from "./catalog";

export interface CrossDetailReader {
  readEntity(resource: CrossCatalogResource, identity: CrossCatalogIdentity, id: string): Promise<unknown>;
}
const object = (value: unknown): value is CrossCatalogRow =>
  !!value && typeof value === "object" && !Array.isArray(value);
/** Enrich a previously associated entry from each recorded source once.
 * Neither a removed release nor a foreign response may fall back to current.
 */
export async function loadCrossServerDetail(
  original: CrossCatalogEntry,
  activeServer: OfficialCatalogServer,
  reader: CrossDetailReader,
) {
  if (!original.perServer[activeServer]) throw new Error("Requested detail variant is unavailable");
  const entry = structuredClone(original);
  const failures: { server: OfficialCatalogServer; message: string }[] = [];
  const fullSources: OfficialCatalogServer[] = [];
  await Promise.all(
    Object.entries(entry.perServer).map(async ([key, variant]) => {
      const server = key as OfficialCatalogServer;
      if (!variant) return;
      try {
        const value = await reader.readEntity(entry.resource, { ...variant.identity }, variant.id);
        if (!object(value)) throw new Error("Cross-server entity must be an object");
        if (String(crossCatalogRowId(entry.resource, value)) !== variant.id)
          throw new Error("Cross-server entity identity mismatch");
        variant.row = {
          ...structuredClone(value),
          ...(variant.row.eventPublishedAt !== undefined ? { eventPublishedAt: variant.row.eventPublishedAt } : {}),
        };
        const images = value.images;
        if (images !== undefined) variant.assets.images = structuredClone(images);
        fullSources.push(server);
      } catch (error) {
        failures.push({ server, message: error instanceof Error ? error.message : String(error) });
      }
    }),
  );
  return { ...crossServerDetail(entry, activeServer), fullSources, failures };
}

/** Browser detail adapter; the collection entry supplies exact per-server release identities. */
export function fetchCrossServerDetail(
  entry: CrossCatalogEntry,
  activeServer = entry.displayServer,
  options: { signal?: AbortSignal; fetcher?: typeof fetch } = {},
) {
  const cache = crossServerPublicCache(options.fetcher);
  return loadCrossServerDetail(entry, activeServer, {
    readEntity: (resource, identity, id) => cache.readEntity(resource, identity, id, options.signal),
  }).then(async (detail) => {
    options.signal?.throwIfAborted();
    if (entry.resource !== "events" || !detail.row.story) return detail;
    const stories = await cache.readCollection("stories", detail.identity, options.signal).catch(() => ({}));
    options.signal?.throwIfAborted();
    const own = detail.perServer[detail.activeServer]!;
    return {
      ...detail,
      row: withEventStoryVisibility(detail.row, stories, detail.activeServer),
      perServer: {
        ...detail.perServer,
        [detail.activeServer]: { ...own, row: withEventStoryVisibility(own.row, stories, detail.activeServer) },
      },
    };
  });
}
