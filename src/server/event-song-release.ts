// L3 — GEB
// Input: Release-pinned events, challenge rules and song catalogue rows.
// Output: Song publication dates and the song cards used by event detail pages.
// Pos: [Map](L2-2.md); shared catalogue enrichment for SSR and page snapshots.
// Effects/Dependencies: Reads the pinned release and reuses its performer registry.
import {
  asRecord,
  fetchStaticApplicationJson,
  fetchStaticCatalog,
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
import { publicationFields } from "../lib/content-publication";
import { pinCrossCatalogValue } from "../lib/cross-server/presentation";
import { createPerformerRegistry, resolveSongPerformer } from "../lib/song-performer";
import type { CatalogCollectionPayload } from "./catalog-collection";

type Row = Record<string, unknown>;
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

const eventSongFields = [
  "musicId", "musicTitle", "title", "name", "jacketUrl", "jacketThumbUrl", "musicType", "musicCategories",
  "artistName", "bandName", "bandId", "bandIds", "vocalCharacterIds", "characterId", "characterIds", "characters",
];
const performerBandFields = [
  "bandId", "bandName", "name", "icon", "logo", "official", "memberBandIds", "memberCharacterIds", "memberNames",
];
const performerCharacterFields = [
  "characterId", "bandId", "characterName", "name", "firstName", "nickname", "faceImage", "thumbnailImage",
];
const pick = (row: Row, fields: readonly string[]) =>
  Object.fromEntries(fields.filter(field => field in row).map(field => [field, row[field]]));
const eventSongCatalogs = new Map<string, Promise<{ songs: Row; performers: ReturnType<typeof createPerformerRegistry> }>>();
function eventSongCatalog(identity: StaticCatalogRelease) {
  const key = JSON.stringify(identity);
  let pending = eventSongCatalogs.get(key);
  if (!pending) {
    pending = (async () => {
      const [songs, bands, characters] = await Promise.all(
        ["songs", "bands", "characters"].map(resource => fetchStaticCatalog(resource, identity.server, identity)),
      );
      return { songs: asRecord(songs) ?? {}, performers: createPerformerRegistry({
        game: "our-notes", ...identity, bands, characters,
      }) };
    })();
    eventSongCatalogs.set(key, pending);
    pending.catch(() => eventSongCatalogs.delete(key));
  }
  return pending;
}

async function eventSongCards(payload: EntityPayload, identity: StaticCatalogRelease): Promise<EntityPayload> {
  const music = await staticEventMusic(identity);
  const primary = asRecord(payload.item.song);
  const tracks = music.tracks.filter(row => row.eventId === Number(payload.id));
  const ids = new Set([...(primary?.musicId ? [String(primary.musicId)] : []), ...tracks.map(track => String(track.musicId))]);
  if (!ids.size) return payload;

  const { songs, performers } = await eventSongCatalog(identity);
  const related: Record<string, Row> = {};
  const bandIds = new Set<number>();
  const characterIds = new Set<number>();
  for (const id of ids) {
    const row = asRecord(songs[id]);
    if (!row) continue;
    const song = withEventSongRelease(row, music.releases);
    related[id] = pinCrossCatalogValue({
      ...pick(song, eventSongFields),
      ...publicationFields(song),
    }, identity) as Row;
    const performer = resolveSongPerformer(row, performers);
    for (const id of [...performer.bandIds, ...[row.bandIds ?? row.bandId].flat().map(Number)]) bandIds.add(id);
    performer.participantCharacterIds.forEach(id => characterIds.add(id));
  }
  const withReferences = (rows: Row[], ids: Set<number>, field: string, registry: ReadonlyMap<number, Row>, fields: readonly string[]) => {
    const byId = new Map(rows.map(row => [Number(row[field]), row]));
    for (const id of ids) {
      const row = registry.get(id);
      if (row) byId.set(id, {
        ...byId.get(id),
        ...(pinCrossCatalogValue(pick(row, fields), identity) as Row),
      });
    }
    return [...byId.values()];
  };
  const primaryCard = primary && related[String(primary.musicId)];
  const challengeTracks = tracks.flatMap(track => {
    const song = related[String(track.musicId)];
    return song ? [{ ...track, ...publicationFields(song) }] : [];
  });
  return {
    ...payload,
    item: {
      ...payload.item,
      ...(primaryCard ? { song: { ...primary, ...publicationFields(primaryCard) } } : {}),
      challengeTracks,
      challengeServer: payload.server,
    },
    aux: { ...payload.aux, songs: { ...(payload.aux?.songs as Record<string, Row> | undefined), ...related } },
    characters: withReferences(payload.characters, characterIds, "characterId", performers.characters, performerCharacterFields),
    bands: withReferences(payload.bands, bandIds, "bandId", performers.bands, performerBandFields),
  };
}

export async function eventSongPayload(payload: EntityPayload): Promise<EntityPayload> {
  if (!payload.sourceId) return payload;
  const identity = { server: payload.server, releaseId: payload.releaseId, sourceId: payload.sourceId };
  if (payload.resource === "events" && payload.item.kind === "game-event")
    return payload.item.challengeServer === payload.server && payload.aux?.songs ? payload : eventSongCards(payload, identity);
  const songs = payload.aux?.songs as Record<string, Record<string, unknown>> | undefined;
  // Primary publication metadata remains stable after the song's own release time.
  if (
    !(payload.resource === "songs" && payload.item.eventPublishedAt === undefined) &&
    !Object.values(songs || {}).some(needsEventSongRelease)
  )
    return payload;
  const releases = await staticEventSongReleases(identity);
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
