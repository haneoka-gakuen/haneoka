import type { ContentOrigin, GarupaMasterOrigin } from "~/features/catalog/contentSource";

export type GarupaPlaylistKind = "game" | "system";
export type GarupaPlaylistSource = "band" | "stage-challenge";

/**
 * The exact asset reference emitted by the immutable
 * `haneoka-garupa-playlists-v1` R2 document.
 *
 * `server` belongs to Bestdori's Garupa API contract. It is intentionally
 * kept at this wire boundary and is never used as an Our Notes release ID.
 */
export interface GarupaPlaylistWireAssetRef {
  provider: "bestdori";
  server: "jp";
  kind: "song";
  musicId: number;
}

export interface GarupaPlaylistWireTrack {
  position: number;
  musicId: number;
  title: string;
  bandId?: number | null;
  bandName?: string | null;
  jacketImage?: string | null;
  available: boolean;
  missingReason?: string | null;
  assetRef?: GarupaPlaylistWireAssetRef | null;
  language?: "ja";
}

export interface GarupaPlaylistWire {
  id: string;
  kind: GarupaPlaylistKind;
  source: GarupaPlaylistSource;
  sourceId: number;
  title: string;
  description?: string | null;
  bandId?: number | null;
  color?: string | null;
  stageChallengeType?: string | null;
  assetBundleName?: string | null;
  startsAt?: number | null;
  endsAt?: number | null;
  tracks: GarupaPlaylistWireTrack[];
  language?: "ja";
}

/** The immutable R2 document contract. Do not version or reshape it in the UI. */
export interface GarupaPlaylistWireCatalog {
  format: "haneoka-garupa-playlists-v1";
  /** Garupa Master JP, not an Our Notes resource release. */
  server: "jp";
  projectionSha256: string;
  playlists: GarupaPlaylistWire[];
}

/** Explicit in-app provenance derived from a Bestdori wire asset reference. */
export interface GarupaPlaylistAssetRef {
  origin: Extract<ContentOrigin, { provider: "bestdori" }>;
  kind: "song";
  musicId: number;
}

export interface GarupaPlaylistTrack extends Omit<GarupaPlaylistWireTrack, "assetRef"> {
  assetRef?: GarupaPlaylistAssetRef | null;
}

export interface GarupaPlaylist extends Omit<GarupaPlaylistWire, "tracks"> {
  tracks: GarupaPlaylistTrack[];
}

/** Normalized in-app model; all playable provenance is namespaced. */
export interface GarupaPlaylistCatalog {
  origin: GarupaMasterOrigin;
  projectionSha256: string;
  playlists: GarupaPlaylist[];
}

export interface ResolvedPlaylistTrack {
  /** Stable display/order position after client-side playlist ordering. */
  position: number;
  /** Original immutable Garupa Master definition record. */
  definition: GarupaPlaylistTrack;
  /** The concrete playable source selected by the release fallback policy. */
  origin: Extract<ContentOrigin, { provider: "release" | "bestdori" }> | null;
  language: "ja";
  song: import("~/types/archive").Song | null;
  title: import("~/types/displayText").DisplayText;
  artist: import("~/types/displayText").DisplayText;
  bandVisuals: import("~/types/compositeVisual").CompositeEntityVisual[];
  available: boolean;
  missingReason?: string | null;
}

export interface ResolvedPlaylist extends Omit<GarupaPlaylist, "tracks"> {
  language: "ja";
  titleText: import("~/types/displayText").DisplayText;
  thumbnail?: string;
  filterVisual?: import("~/types/compositeVisual").CompositeEntityVisual;
  bandKeys: string[];
  tracks: ResolvedPlaylistTrack[];
}
