import type {
  GarupaPlaylist,
  GarupaPlaylistAssetRef,
  GarupaPlaylistCatalog,
  GarupaPlaylistWire,
  GarupaPlaylistWireAssetRef,
  GarupaPlaylistWireCatalog,
  GarupaPlaylistWireTrack,
} from "~/types/playlists";
import { bestdoriOrigin, garupaMasterOrigin } from "~/features/catalog/contentSource";

const normalizeAssetRef = (
  assetRef: GarupaPlaylistWireAssetRef | null | undefined,
): GarupaPlaylistAssetRef | null | undefined => {
  if (assetRef === null || assetRef === undefined) return assetRef;
  if (
    assetRef.provider !== "bestdori" ||
    assetRef.server !== "jp" ||
    assetRef.kind !== "song" ||
    !Number.isSafeInteger(assetRef.musicId) ||
    assetRef.musicId <= 0
  ) {
    throw new TypeError("Invalid Bestdori asset reference in Garupa playlist projection");
  }
  return {
    origin: bestdoriOrigin(assetRef.server),
    kind: assetRef.kind,
    musicId: assetRef.musicId,
  };
};

const normalizeTrack = (track: GarupaPlaylistWireTrack): GarupaPlaylist["tracks"][number] => ({
  ...track,
  assetRef: normalizeAssetRef(track.assetRef),
});

const BAND_PLAYLIST_SLUGS: Readonly<Record<number, string>> = {
  1: "poppin-party",
  2: "afterglow",
  3: "hello-happy-world",
  4: "pastel-palettes",
  5: "roselia",
  18: "raise-a-suilen",
  21: "morfonica",
  45: "mygo",
  46: "ave-mujica",
};

const latinSlug = (value: unknown): string =>
  String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLocaleLowerCase("en")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");

const normalizedPlaylistId = (playlist: GarupaPlaylistWire): string => {
  const sourceId = Number(playlist.sourceId);
  if (!Number.isSafeInteger(sourceId) || sourceId <= 0) {
    throw new TypeError("Invalid Bestdori playlist source ID in Garupa playlist projection");
  }
  // The R2 v1 document predates explicit provider provenance and exposes IDs
  // such as `catalog:jp:band:1`. Keep that wire contract immutable, but never
  // let its legacy `catalog` / regional naming escape into app routes or UI.
  // URLs are stable, human-readable playlist identities rather than source
  // provenance: `/community/playlists/poppin-party` and
  // `/community/playlists/garupa-stage-challenge-184`, for example.
  if (playlist.source === "stage-challenge") return `garupa-stage-challenge-${sourceId}`;
  return BAND_PLAYLIST_SLUGS[sourceId] || latinSlug(playlist.title) || `garupa-band-${sourceId}`;
};

const normalizePlaylist = (playlist: GarupaPlaylistWire): GarupaPlaylist => ({
  ...playlist,
  id: normalizedPlaylistId(playlist),
  tracks: playlist.tracks.map(normalizeTrack),
});

/**
 * Converts the immutable v1 R2 document into the app's explicit origin model.
 * The `server: "jp"` field never crosses this boundary as a generic server or
 * an Our Notes release identifier.
 */
export const normalizeGarupaPlaylistCatalog = (wire: GarupaPlaylistWireCatalog): GarupaPlaylistCatalog => {
  if (wire.format !== "haneoka-garupa-playlists-v1" || wire.server !== "jp" || !Array.isArray(wire.playlists)) {
    throw new TypeError("Unsupported Garupa playlist projection contract");
  }
  return {
    origin: garupaMasterOrigin(),
    projectionSha256: wire.projectionSha256,
    playlists: wire.playlists.map(normalizePlaylist),
  };
};

export const useGarupaPlaylists = () => {
  const config = useRuntimeConfig();
  const url = computed(() => `${String(config.public.apiBase || "/api/v1").replace(/\/+$/u, "")}/garupa/playlists`);
  return useAsyncData<GarupaPlaylistCatalog>(
    "garupa:playlists",
    async () => normalizeGarupaPlaylistCatalog(await $fetch<GarupaPlaylistWireCatalog>(url.value)),
    {
      deep: false,
      server: false,
      watch: [url],
    },
  );
};
