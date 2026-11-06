import { fetchStaticCatalog } from "../lib/static-catalog-source";
import type { EntityPayload } from "../lib/entity-graph";
import { withEventStoryVisibility } from "../lib/content-publication";

export async function eventStoryPayload(payload: EntityPayload): Promise<EntityPayload> {
  if (payload.resource !== "events" || !payload.item.story) return payload;
  const catalog = payload.sourceId
    ? await fetchStaticCatalog("stories", payload.server, {
        server: payload.server,
        releaseId: payload.releaseId,
        sourceId: payload.sourceId,
      }).catch(() => ({}))
    : {};
  return { ...payload, item: withEventStoryVisibility(payload.item, catalog, payload.server) };
}
