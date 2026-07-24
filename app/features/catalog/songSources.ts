import type { CapabilityDomain } from "~/config/capabilities";
import type { CatalogContentOrigin } from "~/features/catalog/contentSource";
import type { ArchiveMessageKey } from "~/i18n/messages";
import type { Song } from "~/types/archive";

export type SongCatalogSort =
  | "id"
  | "title"
  | "musicType"
  | "band"
  | "level"
  | "time"
  | "score"
  | "eff"
  | "bpm"
  | "n"
  | "nps"
  | "sr"
  | "category"
  | "composer"
  | "lyrics"
  | "arrangement"
  | "release";

export interface SongCatalogSourceProfile {
  readonly id: string;
  /** Explicit non-release catalog origin. Omit to follow the selected release. */
  readonly catalogOrigin?: CatalogContentOrigin;
  readonly titleKey: ArchiveMessageKey;
  readonly domain: CapabilityDomain;
  readonly maxDifficulty: number;
  readonly showMusicTypeFilter: boolean;
  readonly showCategoryFilter: boolean;
  readonly hideSonolus: boolean;
  readonly bandFallbackIcon: string;
  readonly defaultSort?: SongCatalogSort;
  readonly categorySortKey?: (song: Song) => string;
  readonly resolveChartUrl?: (file: string, canonicalize: (file: string) => string) => string;
}

const DEFAULT_PROFILE: SongCatalogSourceProfile = {
  id: "catalog",
  titleKey: "songs",
  domain: "catalog",
  maxDifficulty: 3,
  showMusicTypeFilter: true,
  showCategoryFilter: true,
  hideSonolus: false,
  bandFallbackIcon: "music_note",
  defaultSort: "release",
};

const profiles = new Map<string, SongCatalogSourceProfile>();

export const registerSongCatalogSource = (profile: SongCatalogSourceProfile): void => {
  const id = String(profile.id || "").trim();
  if (!id) throw new TypeError("Song catalog source id must not be empty");
  profiles.set(id, { ...profile, id });
};

export const resolveSongCatalogSource = (id: string | undefined): SongCatalogSourceProfile =>
  (id ? profiles.get(id) : undefined) || DEFAULT_PROFILE;

export const songReleaseTimestamp = (song: Song): number | undefined => {
  if (song.releaseAt !== undefined) {
    const canonical = Number(song.releaseAt);
    return Number.isFinite(canonical) && canonical > 0 ? canonical : undefined;
  }
  if (!Array.isArray(song.publishedAt)) return undefined;
  const japanese = Number(song.publishedAt[0]);
  return Number.isFinite(japanese) && japanese > 0 ? japanese : undefined;
};
