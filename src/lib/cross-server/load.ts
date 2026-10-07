import {
  mergeCrossServerCatalog, OFFICIAL_CATALOG_SERVERS,
  type CrossCatalogResource, type CrossCatalogIdentity, type CrossCatalogRow, type CrossCatalogSnapshot, type OfficialCatalogServer,
} from "./catalog";

export interface CrossCatalogReader {
  readIdentity(server: OfficialCatalogServer): Promise<CrossCatalogIdentity>;
  readCollection(resource: CrossCatalogResource, identity: CrossCatalogIdentity): Promise<unknown>;
  readEntity?(resource: CrossCatalogResource, identity: CrossCatalogIdentity, id: string): Promise<unknown>;
}
const object = (value: unknown): value is CrossCatalogRow => !!value && typeof value === "object" && !Array.isArray(value);
function collection(resource: CrossCatalogResource, value: unknown): Record<string, CrossCatalogRow> {
  if (!object(value)) throw new Error("Cross-server collection must be an object");
  const rows = resource === "events" ? value.entries : value;
  if (!object(rows) || Object.values(rows).some((row) => !object(row))) throw new Error("Cross-server collection rows malformed");
  return rows as Record<string, CrossCatalogRow>;
}

/** Each server is observed once, then all required collections use that immutable pin. */
export async function loadCrossServerCatalog(
  resource: CrossCatalogResource,
  options: { selectedServer: OfficialCatalogServer; locale: string; reader: CrossCatalogReader },
) {
  const dependencies: CrossCatalogResource[] = resource === "cards" || resource === "support-cards" || resource === "characters"
    ? ["bands", "characters", resource]
    : resource === "songs" ? ["bands", "characters", "songs"] : resource === "events" ? ["bands", "characters", "events"] : [resource];
  const resources = [...new Set(dependencies)];
  const failures: { server: OfficialCatalogServer; resource: CrossCatalogResource | "identity"; message: string }[] = [];
  const sources: CrossCatalogSnapshot[] = [];
  await Promise.all(OFFICIAL_CATALOG_SERVERS.map(async (server) => {
    let identity: CrossCatalogIdentity;
    try {
      identity = await options.reader.readIdentity(server);
      if (identity.server !== server) throw new Error("Cross-server identity mismatch");
    } catch (error) {
      failures.push({ server, resource: "identity", message: error instanceof Error ? error.message : String(error) });
      return;
    }
    const snapshot: CrossCatalogSnapshot = { identity, collections: {} };
    // Every collection is pinned to the same identity: request them together
    // instead of one round trip after another, then record results in order.
    const reads = resources.map((name) => options.reader.readCollection(name, identity).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    ));
    for (const [index, name] of resources.entries()) {
      const read = await reads[index]!;
      try {
        if (!read.ok) throw read.error;
        snapshot.collections[name] = collection(name, read.value);
      } catch (error) { failures.push({ server, resource: name, message: error instanceof Error ? error.message : String(error) }); }
    }
    if (resource === "events" && snapshot.collections.events && options.reader.readEntity) {
      const entries = Object.entries(snapshot.collections.events).filter(([, row]) => row.kind === "game-event");
      if (entries.length > 64) failures.push({ server, resource, message: "Event identity hydration budget exceeded; entries remain independent" });
      else for (let start = 0; start < entries.length; start += 4) {
        await Promise.all(entries.slice(start, start + 4).map(async ([id, summary]) => {
          try {
            const detail = await options.reader.readEntity!(resource, identity, id);
            if (!object(detail) || String(detail.id) !== id || detail.kind !== "game-event") throw new Error("Event entity identity mismatch");
            for (const field of ["title", "image", "backgroundImage", "logo", "startAt", "endAt"])
              if (summary[field] !== undefined && JSON.stringify(summary[field]) !== JSON.stringify(detail[field]))
                throw new Error("Event entity disagrees with its pinned collection summary");
            snapshot.collections.events![id] = detail;
          } catch (error) { failures.push({ server, resource, message: error instanceof Error ? error.message : String(error) }); }
        }));
      }
    }
    sources.push(snapshot);
  }));
  return { ...mergeCrossServerCatalog(sources, resource, options), failures };
}
