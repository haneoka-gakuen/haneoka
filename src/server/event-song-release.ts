import {
  asRecord,
  fetchOptionalStaticCatalog,
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

type ChallengeTrack = { id: number; eventId: number; musicId: number };
function eventTracks(value: unknown): ChallengeTrack[] {
  const rows = Array.isArray(value) ? value : asRecord(value)?._allData;
  if (!Array.isArray(rows)) return [];
  return rows.flatMap(value => {
    const row = asRecord(value);
    if (!row) return [];
    const id = Number(row.id ?? row._id), eventId = Number(row.eventId ?? row._eventId);
    const musicId = Number(row.liveMusicId ?? row._liveMusicId);
    return [id, eventId, musicId].every(value => Number.isSafeInteger(value) && value > 0) ? [{ id, eventId, musicId }] : [];
  });
}

const releases = new Map<string, Promise<{ releases: EventSongReleases; tracks: ChallengeTrack[] }>>();
async function staticEventMusic(identity: StaticCatalogRelease) {
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
        return { releases: eventSongReleases(events, challenges), tracks: eventTracks(challenges) };
      }
      const data = (await fetchStaticApplicationJson(`/api/v1/team-builder/${identity.server}?v=4`, identity)) as {
        identity: StaticCatalogRelease;
        events: unknown;
        challengeMusicTable?: { rows: unknown[] };
      };
      if (data.identity.releaseId !== identity.releaseId || data.identity.sourceId !== identity.sourceId)
        throw new Error("Event music release mismatch");
      const rows = data.challengeMusicTable?.rows;
      return { releases: eventSongReleases(data.events, rows), tracks: eventTracks(rows) };
    })().catch(() => ({ releases: {}, tracks: [] }));
    releases.set(key, pending);
  }
  return pending;
}

export async function staticEventSongReleases(identity: StaticCatalogRelease): Promise<EventSongReleases> {
  return (await staticEventMusic(identity)).releases;
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
  if (payload.resource === "events" && payload.item.kind === "game-event" && !payload.item.challengeTracks) {
    const identity = { server: payload.server, releaseId: payload.releaseId, sourceId: payload.sourceId };
    const music = await staticEventMusic(identity);
    const tracks = music.tracks.filter(row => row.eventId === Number(payload.id));
    const challengeTracks = await Promise.all(tracks.map(async track => {
      const song = await fetchOptionalStaticCatalog(`songs/${track.musicId}`, identity.server, identity);
      const row = asRecord(song.value);
      return { ...track, musicTitle: row?.musicTitle, publishedAt: row?.publishedAt,
        eventPublishedAt: music.releases[String(track.musicId)], jacketThumbUrl: row?.jacketThumbUrl };
    }));
    payload = { ...payload, item: { ...payload.item, challengeTracks, challengeServer: payload.server } };
  }
  const songs = payload.aux?.songs as Record<string, Record<string, unknown>> | undefined;
  // Primary publication metadata remains stable after the song's own release time.
  if (
    !(payload.resource === "songs" && payload.item.eventPublishedAt === undefined) &&
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
