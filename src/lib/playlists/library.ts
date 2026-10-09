/**
 * The song library behind every playlist.
 *
 * Both games' catalogues are merged into one list. A song that exists in
 * Our Notes and in GBP (same title, same band) appears once, as the Our Notes
 * entry; the GBP reference stays an alias so playlists that stored it still
 * resolve. Songs are ordered by their first release in either game.
 */
import { loadPlaylistCatalogSource, auditedCryChicPortraits, type PlaylistCatalogSource } from "../playlist-tracks";
import { resolveSongPerformer, type SongPerformer } from "../song-performer";
import { resourcePath, isReleaseServer } from "../resource-route";
import type { Locale } from "../../i18n/locales";

type RecordValue = Record<string, unknown>;

export interface TrackRef {
  provider: "our-notes" | "bestdori";
  server: string;
  musicId: string;
}

export interface LibrarySong {
  key: string;
  ref: TrackRef;
  row: RecordValue;
  title: unknown;
  bandKey: string;
  bandName: unknown;
  jacket: string;
  thumb: string;
  audio: string;
  released: number;
  performer?: SongPerformer;
  /** Other references that name this same song. */
  aliases: string[];
}

export interface LibraryBand {
  key: string;
  name: unknown;
  logo: string;
  songs: LibrarySong[];
  /** Source band ids, `provider:server:bandId`, for older links. */
  sources: string[];
}

export interface SongLibrary {
  songs: LibrarySong[];
  byKey: Map<string, LibrarySong>;
  bands: LibraryBand[];
  /** A catalogue that failed to load; the library holds the other one. */
  partial: string[];
}

export const refKey = (ref: TrackRef) => `${ref.provider}:${ref.server}:${ref.musicId}`;

export function parseRef(value: unknown): TrackRef | null {
  if (!value || typeof value !== "object") return null;
  const row = value as RecordValue;
  const provider = row.provider;
  if (provider !== "our-notes" && provider !== "bestdori") return null;
  const server = String(row.server || "");
  const musicId = String(row.musicId ?? "");
  return server && /^\d+$/u.test(musicId) ? { provider, server, musicId } : null;
}

const first = (value: unknown): string => {
  if (Array.isArray(value)) return String(value.find((entry) => typeof entry === "string" && entry) ?? "");
  return typeof value === "string" ? value : "";
};

const normalize = (value: string) => value.normalize("NFKC").replace(/\s+/gu, "").toLocaleLowerCase("ja");

const releasedAt = (song: RecordValue): number => {
  const values = [...(Array.isArray(song.publishedAt) ? song.publishedAt : []), song.releaseAt]
    .map(Number)
    .filter((value) => Number.isFinite(value) && value > 0);
  return values.length ? Math.min(...values) : Number.POSITIVE_INFINITY;
};

function songsOf(source: PlaylistCatalogSource): LibrarySong[] {
  const bestdori = source.provider === "bestdori";
  return Object.entries(source.songs).map(([id, row]) => {
    const performer = resolveSongPerformer(row, source.registry);
    const bandId = Number(performer.bandIds[0] ?? (Array.isArray(row.bandIds) ? row.bandIds[0] : row.bandId));
    const band = source.registry.bands.get(bandId);
    const official = band ? (bestdori ? band.official === true : band.official !== false) : false;
    const bandName = band?.bandName ?? row.bandName;
    const ref: TrackRef = { provider: source.provider, server: source.server, musicId: String(row.musicId ?? id) };
    return {
      key: refKey(ref),
      ref,
      row,
      title: row.musicTitle ?? row.title,
      bandKey: official ? normalize(first(bandName)) : "",
      bandName,
      jacket: String(row.jacketUrl || row.jacketThumbUrl || ""),
      thumb: String(row.jacketThumbUrl || row.jacketUrl || ""),
      audio: String(row.musicUrl || ""),
      released: releasedAt(row),
      performer,
      aliases: [],
    };
  });
}

const libraries = new Map<string, Promise<SongLibrary>>();

/** Loads both catalogues once per Our Notes server. */
export function loadSongLibrary(server: string): Promise<SongLibrary> {
  let request = libraries.get(server);
  if (!request) {
    request = build(server);
    libraries.set(server, request);
    request.catch(() => libraries.delete(server));
  }
  return request;
}

async function build(server: string): Promise<SongLibrary> {
  const [native, gbp] = await Promise.allSettled([
    loadPlaylistCatalogSource("our-notes", server),
    loadPlaylistCatalogSource("bestdori", "jp"),
  ]);
  if (native.status === "rejected" && gbp.status === "rejected") throw native.reason;
  const partial: string[] = [];
  if (native.status === "rejected") partial.push("our-notes");
  if (gbp.status === "rejected") partial.push("bestdori");
  if (gbp.status === "fulfilled" && native.status === "fulfilled" && !gbp.value.registry.portraitFallbacks) {
    gbp.value.registry = { ...gbp.value.registry, portraitFallbacks: auditedCryChicPortraits(native.value) };
  }
  const primary = native.status === "fulfilled" ? songsOf(native.value) : [];
  const secondary = gbp.status === "fulfilled" ? songsOf(gbp.value) : [];
  const identity = (song: LibrarySong) => `${normalize(first(song.title))}|${normalize(first(song.bandName))}`;
  const byIdentity = new Map(primary.map((song) => [identity(song), song]));
  const byKey = new Map<string, LibrarySong>();
  const songs: LibrarySong[] = [];
  for (const song of primary) {
    songs.push(song);
    byKey.set(song.key, song);
  }
  for (const song of secondary) {
    const twin = byIdentity.get(identity(song));
    if (twin) {
      // Same song in both games: keep the Our Notes entry, at its first release.
      twin.aliases.push(song.key);
      twin.released = Math.min(twin.released, song.released);
      if (!twin.bandKey) twin.bandKey = song.bandKey;
      byKey.set(song.key, twin);
      continue;
    }
    songs.push(song);
    byKey.set(song.key, song);
  }
  songs.sort((left, right) => left.released - right.released || left.key.localeCompare(right.key));

  const bands = new Map<string, LibraryBand>();
  const registries = [native, gbp].flatMap((entry) => (entry.status === "fulfilled" ? [entry.value] : []));
  for (const source of registries) {
    for (const [bandId, band] of source.registry.bands) {
      const official = source.provider === "bestdori" ? band.official === true : band.official !== false;
      if (!official) continue;
      const key = normalize(first(band.bandName ?? band.name));
      if (!key) continue;
      const entry = bands.get(key) ?? { key, name: band.bandName ?? band.name, logo: "", songs: [], sources: [] };
      entry.logo ||= String(band.logo || band.icon || "");
      entry.sources.push(`${source.provider}:${source.server}:${bandId}`);
      bands.set(key, entry);
    }
  }
  for (const song of songs) bands.get(song.bandKey)?.songs.push(song);
  return {
    songs,
    byKey,
    bands: [...bands.values()].filter((band) => band.songs.length),
    partial,
  };
}

export function songDetailPath(song: LibrarySong, locale: Locale): string {
  const { provider, server, musicId } = song.ref;
  if (provider === "bestdori") return `/${locale}/community/songs-bestdori/detail/?song=${encodeURIComponent(musicId)}`;
  return isReleaseServer(server)
    ? resourcePath({ server, locale, kind: "songs", id: musicId })
    : `/catalog/songs?song=${encodeURIComponent(musicId)}`;
}

/* ---------- Playlists ---------- */

export interface PlaylistOwner {
  uid: number;
  name: string | null;
  image: string | null;
}

export interface PlaylistCover {
  kind: "auto" | "song" | "upload" | "band";
  song?: TrackRef | null;
  url?: string | null;
  attachmentId?: string | null;
  pending?: boolean;
  logo?: string;
}

export interface Playlist {
  id: string;
  kind: "official" | "game" | "community";
  /** Official groups: `featured`, `band`, `stage-challenge`, `other`. */
  group?: string;
  title: unknown;
  description?: string | null;
  cover: PlaylistCover;
  refs: TrackRef[];
  trackCount: number;
  preview: TrackRef[];
  owner?: PlaylistOwner;
  likeCount?: number;
  viewerLiked?: boolean;
  viewerOwns?: boolean;
  visibility?: "public" | "private";
  version?: number;
  updatedAt?: number;
  publishedAt?: number | null;
  /** Detail rows were read; summaries only carry a preview. */
  complete: boolean;
  aliases?: string[];
}

const ofSongs = (songs: LibrarySong[]) => songs.map((song) => song.ref);

/** Official playlists derived from the library and the game's own lists. */
export function officialPlaylists(library: SongLibrary, gamePlaylists: RecordValue[], now = Date.now()): Playlist[] {
  const released = library.songs.filter((song) => song.released <= now);
  const latest = [...released].reverse().slice(0, 40);
  const lists: Playlist[] = [];
  if (latest.length)
    lists.push({
      id: "official:new",
      kind: "official",
      group: "featured",
      title: { key: "playlistPage.newReleases" },
      cover: { kind: "song", song: latest[0]!.ref },
      refs: ofSongs(latest),
      trackCount: latest.length,
      preview: ofSongs(latest.slice(0, 4)),
      complete: true,
    });
  for (const band of library.bands) {
    const songs = band.songs;
    const newest = [...songs].reverse().find((song) => song.released <= now) ?? songs[songs.length - 1]!;
    lists.push({
      id: `official:band:${encodeURIComponent(band.key)}`,
      kind: "official",
      group: "band",
      title: band.name,
      cover: { kind: "band", song: newest.ref, logo: band.logo },
      refs: ofSongs(songs),
      trackCount: songs.length,
      preview: ofSongs(songs.slice(-4)),
      complete: true,
      aliases: band.sources.flatMap((source) => {
        const [provider, server, id] = source.split(":");
        return [
          `${provider}:${server}:band:${id}`,
          ...(provider === "bestdori"
            ? [`catalog:${server}:band:${id}`, `${provider}:${id}`, id!]
            : [`${provider}:${id}`]),
        ];
      }),
    });
  }
  if (library.songs.length)
    lists.push({
      id: "official:all",
      kind: "official",
      group: "featured",
      title: { key: "playlistPage.allSongs" },
      cover: { kind: "auto" },
      refs: ofSongs(library.songs),
      trackCount: library.songs.length,
      preview: ofSongs(library.songs.slice(-4).reverse()),
      complete: true,
    });
  for (const item of gamePlaylists) {
    const source = String(item.source || item.type || "");
    if (source === "band") continue;
    const tracks = Array.isArray(item.tracks) ? (item.tracks as RecordValue[]) : [];
    const refs = tracks.flatMap((track) => parseRef(track.assetRef) ?? []);
    const stage = String(item.assetBundleName || "").match(/(\d+)$/u)?.[1] || String(item.sourceId || "");
    lists.push({
      id: String(item.id),
      kind: "game",
      group: source === "stage-challenge" ? "stage-challenge" : "other",
      title: item.title,
      description: typeof item.description === "string" ? item.description : null,
      // The stage banner is a wide strip; the square cover is the jacket mosaic.
      cover: {
        kind: "auto",
        url: stage ? `/api/v1/garupa/bestdori/jp/media/stage-challenge/${encodeURIComponent(stage)}` : null,
      },
      refs,
      trackCount: refs.length,
      preview: refs.slice(0, 4),
      complete: true,
      publishedAt: Number(item.startsAt) || null,
    });
  }
  return lists;
}

export function communityPlaylist(value: RecordValue, complete = false): Playlist {
  const cover = (value.cover as RecordValue | undefined) ?? {};
  const refs = Array.isArray(value.tracks) ? value.tracks.flatMap((track) => parseRef(track) ?? []) : [];
  return {
    id: String(value.id),
    kind: "community",
    title: String(value.title || ""),
    description: typeof value.description === "string" ? value.description : null,
    cover: {
      kind: cover.kind === "song" || cover.kind === "upload" ? cover.kind : "auto",
      song: parseRef(cover.song),
      url: typeof cover.url === "string" ? cover.url : null,
      attachmentId: typeof cover.attachmentId === "string" ? cover.attachmentId : null,
      pending: Boolean(cover.pending),
    },
    refs,
    trackCount: Number(value.trackCount) || refs.length,
    preview: Array.isArray(value.preview) ? value.preview.flatMap((ref) => parseRef(ref) ?? []) : [],
    owner: value.owner as PlaylistOwner,
    likeCount: Number(value.likeCount) || 0,
    viewerLiked: Boolean(value.viewerLiked),
    viewerOwns: Boolean(value.viewerOwns),
    visibility: value.visibility === "private" ? "private" : "public",
    version: Number(value.version) || 1,
    updatedAt: Number(value.updatedAt) || 0,
    publishedAt: Number(value.publishedAt) || null,
    complete,
  };
}

/** Jackets for a cover: the chosen song, else a mosaic of the first four. */
export function coverImages(playlist: Playlist, library: SongLibrary | null): { single?: string; mosaic: string[] } {
  if (playlist.cover.kind === "upload" && playlist.cover.url) return { single: playlist.cover.url, mosaic: [] };
  const jacket = (ref: TrackRef | null | undefined) => (ref && library?.byKey.get(refKey(ref))?.jacket) || "";
  if ((playlist.cover.kind === "song" || playlist.cover.kind === "band") && jacket(playlist.cover.song))
    return { single: jacket(playlist.cover.song), mosaic: [] };
  const mosaic = [
    ...new Set((playlist.preview.length ? playlist.preview : playlist.refs.slice(0, 4)).map(jacket).filter(Boolean)),
  ];
  return mosaic.length >= 4 ? { mosaic: mosaic.slice(0, 4) } : { single: mosaic[0], mosaic: [] };
}

/* ---------- Community API ---------- */

export class PlaylistApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
  }
}

export async function playlistApi<T = RecordValue>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api/v1/community/playlists${path}`, {
    credentials: "same-origin",
    cache: "no-store",
    ...init,
    headers: {
      accept: "application/json",
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });
  const data = (await response.json().catch(() => ({}))) as RecordValue;
  if (!response.ok) {
    const failure = (data.error as RecordValue | undefined) ?? {};
    throw new PlaylistApiError(
      String(failure.message || `HTTP ${response.status}`),
      response.status,
      String(failure.code || ""),
    );
  }
  return data as T;
}
