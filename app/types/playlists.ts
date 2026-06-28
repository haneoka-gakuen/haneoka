export type GarupaPlaylistKind = "game" | "system";
export type GarupaPlaylistSource = "band" | "stage-challenge";
export type PlaylistTrackSource = "catalog" | "bestdori" | "user-upload";

export interface GarupaPlaylistAssetRef {
  provider: "bestdori";
  server: "jp";
  kind: "song";
  musicId: number;
}

export interface GarupaPlaylistTrack {
  position: number;
  musicId: number;
  title: string;
  bandId?: number | null;
  bandName?: string | null;
  jacketImage?: string | null;
  available: boolean;
  missingReason?: string | null;
  assetRef?: GarupaPlaylistAssetRef | null;
  language?: "ja";
}

export interface ResolvedPlaylistTrack {
  position: number;
  source: PlaylistTrackSource;
  sourceServer: "jp-cbt" | "bestdori" | "user-upload";
  sourceId: number | string;
  language: "ja";
  song: import("~/types/archive").Song;
  title: import("~/types/displayText").DisplayText;
  artist: import("~/types/displayText").DisplayText;
  bandVisuals: import("~/types/compositeVisual").CompositeEntityVisual[];
}

export interface GarupaPlaylist {
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
  tracks: GarupaPlaylistTrack[];
  language?: "ja";
}

export interface ResolvedPlaylist extends Omit<GarupaPlaylist, "tracks"> {
  language: "ja";
  titleText: import("~/types/displayText").DisplayText;
  thumbnail?: string;
  filterVisual?: import("~/types/compositeVisual").CompositeEntityVisual;
  bandKeys: string[];
  tracks: ResolvedPlaylistTrack[];
}

export interface GarupaPlaylistCatalog {
  format: "haneoka-garupa-playlists-v1";
  server: "jp";
  projectionSha256: string;
  playlists: GarupaPlaylist[];
}
