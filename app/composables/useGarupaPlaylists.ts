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

const normalizePlaylist = (playlist: GarupaPlaylistWire): GarupaPlaylist => ({
  ...playlist,
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
