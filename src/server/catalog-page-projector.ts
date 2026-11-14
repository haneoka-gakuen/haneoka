// L3 — GEB
// Input: Fixed static input context, entity key, locale and core/full mode.
// Output: Entity payload with cross-server data and optional full chart rates.
// Pos: [Map](L2-2.md); shared final entity projection for SSR and snapshots.
// Effects/Dependencies: Uses pinned static readers; never mutates the base projection.
import { staticCatalogRelease, fetchStaticCatalog } from "../lib/static-catalog-source";
import { catalogEntityData, type EntityPayload } from "../lib/entity-graph";
import { chartRates } from "./chart-rates";
import { loadStaticCrossServerEntry } from "../lib/cross-server/static";
import { loadCrossServerDetail } from "../lib/cross-server/detail";
import type { OfficialCatalogServer } from "../lib/cross-server/catalog";
import { isCrossCatalogResource } from "../lib/cross-server/definitions";
import type { ReleaseServer } from "../lib/release-server";
import type { Locale } from "../i18n/locales";

export async function catalogPageData(
  server: ReleaseServer,
  resource: string,
  id: string,
  locale: Locale,
  mode: "core" | "full",
  coreBase?: EntityPayload,
): Promise<EntityPayload> {
  const base =
    mode === "core" ? coreBase : ((await catalogEntityData(server, resource, id)) as EntityPayload | undefined);
  const payload = base ? { ...base, aux: { ...base.aux } } : undefined;
  if (!payload) throw new Error(`Missing page data: ${server}/${resource}/${id}`);
  const identity = await staticCatalogRelease(server);
  if (
    payload.server !== server ||
    payload.resource !== resource ||
    payload.id !== id ||
    payload.releaseId !== identity.releaseId ||
    payload.sourceId !== identity.sourceId
  )
    throw new Error(`Page projection identity differs: ${server}/${resource}/${id}`);
  if (["jp", "intl"].includes(server) && isCrossCatalogResource(resource)) {
    const pin = await staticCatalogRelease(server);
    if (pin.releaseId === payload.releaseId && pin.server === payload.server && pin.sourceId === payload.sourceId) {
      const union = await loadStaticCrossServerEntry(resource, server as OfficialCatalogServer, locale, id);
      if (
        mode === "core" &&
        ["jp", "intl"].some((source) => union.sourceAvailability[source as OfficialCatalogServer] !== "loaded")
      )
        throw new Error("Core projection requires complete public sources");
      const entry = union.entries.find((entry) => entry.perServer[server as OfficialCatalogServer]?.id === id);
      const own = entry?.perServer[server as OfficialCatalogServer];
      if (
        mode === "core" &&
        (!entry || own?.identity.releaseId !== pin.releaseId || own.identity.sourceId !== pin.sourceId)
      )
        throw new Error("Core entity association is incomplete");
      if (entry && own?.identity.releaseId === pin.releaseId && own.identity.sourceId === pin.sourceId) {
        if (resource === "shop") payload.item = { ...payload.item, starRewards: own.row.starRewards };
        const detail = await loadCrossServerDetail(entry, server as OfficialCatalogServer, {
          readEntity: (resource, identity, id) =>
            fetchStaticCatalog(`${resource}/${encodeURIComponent(id)}`, identity.server, identity),
        });
        if (mode === "core" && detail.failures.length) throw new Error("Core cross-server detail is incomplete");
        payload.aux = { ...(payload.aux || {}), crossServer: { ...detail, exclusive: entry.exclusive } };
      }
    }
  }

  if (mode === "full" && resource === "songs" && ["jp", "intl"].includes(server)) {
    const table = await chartRates(server);
    if (table.releaseId !== payload.releaseId) throw new Error("Chart rates belong to another release");
    const musicId = Number((payload.item as Record<string, unknown>).musicId);
    const charts = Object.fromEntries(
      Object.entries(table.charts)
        .filter(([key]) => Number(key.split(":")[0]) === musicId)
        .map(([key, rates]) => [key.split(":")[1], rates]),
    );
    if (Object.keys(charts).length)
      payload.aux = { ...(payload.aux || {}), chartRates: { greatFactor: table.greatFactor, charts } };
  }
  return payload;
}
