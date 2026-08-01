import type { CapabilityDomain } from "~/config/capabilities";
import type { CatalogContentOrigin } from "~/features/catalog/contentSource";
import type { ArchiveLocale } from "~/i18n/locales";
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
  /** Resolve a locale-sensitive provider origin, such as a Bestdori region. */
  readonly resolveCatalogOrigin?: (context: { readonly locale: ArchiveLocale }) => CatalogContentOrigin;
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

const validReleaseTimestamp = (value: unknown): number | undefined => {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return undefined;
  if (new Date(timestamp).getUTCFullYear() === 2100) return undefined;
  return timestamp;
};

export const songReleaseTimestamp = (song: Song): number | undefined => {
  const canonical = validReleaseTimestamp(song.releaseAt);
  if (canonical !== undefined) return canonical;
  if (!Array.isArray(song.publishedAt)) return undefined;
  for (const timestamp of song.publishedAt) {
    const fallback = validReleaseTimestamp(timestamp);
    if (fallback !== undefined) return fallback;
  }
  return undefined;
};
