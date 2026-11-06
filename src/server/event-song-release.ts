import {
  fetchStaticApplicationJson,
  fetchStaticReleaseJson,
  hasLocalStaticCatalog,
  type StaticCatalogRelease,
} from "../lib/static-catalog-source";
import {
  eventSongReleases,
  withEventSongRelease,
  withEventSongReleases,
  needsEventSongRelease,
  type EventSongReleases,
} from "../lib/event-song-release";
import type { EntityPayload } from "../lib/entity-graph";
import type { CatalogCollectionPayload } from "./catalog-collection";

const releases = new Map<string, Promise<EventSongReleases>>();
export async function staticEventSongReleases(identity: StaticCatalogRelease): Promise<EventSongReleases> {
  const key = JSON.stringify(identity);
  let pending = releases.get(key);
  if (!pending) {
    pending = (async () => {
      if (hasLocalStaticCatalog(identity.server)) {
        const [events, challenges] = await Promise.all(
          ["MasterEvent", "MasterChallengeMusic"].map((table) =>
            fetchStaticReleaseJson(`objects/master/${table}.json`, identity.server, identity),
          ),
        );
        return eventSongReleases(events, challenges);
      }
      const data = (await fetchStaticApplicationJson(`/api/v1/team-builder/${identity.server}?v=4`, identity)) as {
        identity: StaticCatalogRelease;
        events: unknown;
        challengeMusicTable?: { rows: unknown[] };
      };
      if (data.identity.releaseId !== identity.releaseId || data.identity.sourceId !== identity.sourceId) return {};
      return eventSongReleases(data.events, data.challengeMusicTable?.rows);
    })().catch(() => ({}));
    releases.set(key, pending);
  }
  return pending;
}

export async function staticEventSongs<T extends Record<string, unknown>>(
  songs: Record<string, T>,
  identity: StaticCatalogRelease,
): Promise<Record<string, T>> {
  if (!Object.values(songs).some(needsEventSongRelease)) return songs;
  return withEventSongReleases(songs, await staticEventSongReleases(identity));
}

export async function eventSongPayload(payload: EntityPayload): Promise<EntityPayload> {
  if (!payload.sourceId) return payload;
  const songs = payload.aux?.songs as Record<string, Record<string, unknown>> | undefined;
  if (
    !(payload.resource === "songs" && needsEventSongRelease(payload.item)) &&
    !Object.values(songs || {}).some(needsEventSongRelease)
  )
    return payload;
  const releases = await staticEventSongReleases({
    server: payload.server,
    releaseId: payload.releaseId,
    sourceId: payload.sourceId,
  });
  return {
    ...payload,
    item: payload.resource === "songs" ? withEventSongRelease(payload.item, releases) : payload.item,
    aux: { ...payload.aux, ...(songs ? { songs: withEventSongReleases(songs, releases) } : {}) },
  };
}

export async function eventSongCollection(payload: CatalogCollectionPayload): Promise<CatalogCollectionPayload> {
  const dto = payload.catalogs?.songs;
  if (!dto) return payload;
  const contexts = Object.fromEntries(
    await Promise.all(
      Object.values(dto.identities)
        .filter(
          (identity) =>
            identity &&
            dto.entries.some((entry) => {
              const row = entry.perServer[identity.server]?.row;
              return row && needsEventSongRelease(row);
            }),
        )
        .map(async (identity) => [identity!.server, await staticEventSongReleases(identity!)] as const),
    ),
  );
  if (!Object.keys(contexts).length) return payload;
  return {
    ...payload,
    catalogs: {
      ...payload.catalogs,
      songs: {
        ...dto,
        entries: dto.entries.map((entry) => ({
          ...entry,
          perServer: Object.fromEntries(
            Object.entries(entry.perServer).map(([server, variant]) => [
              server,
              variant ? { ...variant, row: withEventSongRelease(variant.row, contexts[server] || {}) } : variant,
            ]),
          ),
        })),
      },
    },
  };
}
