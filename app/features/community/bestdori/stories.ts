import type { ArchiveMessageKey } from "~/i18n/messages";
import { bestdoriOrigin, type CatalogContentOrigin } from "~/features/catalog/contentSource";
import { isBestdoriServer } from "@haneoka/bestdori";
import type { StoryEpisode } from "~/types/archive";

export const BESTDORI_STORY_SECTION_DEFINITIONS = [
  { id: "event", messageKey: "storyNavigation.bestdoriEvent" },
  { id: "band", messageKey: "storyNavigation.bestdoriBand" },
  { id: "main", messageKey: "storyNavigation.bestdoriMain" },
  { id: "afterlive", messageKey: "storyNavigation.bestdoriAfterlive" },
  { id: "card", messageKey: "storyNavigation.bestdoriCard" },
] as const satisfies readonly { id: string; messageKey: ArchiveMessageKey }[];

export type BestdoriStorySection = (typeof BESTDORI_STORY_SECTION_DEFINITIONS)[number]["id"];
export type BestdoriChapterStorySection = Extract<BestdoriStorySection, "event" | "band" | "main">;
export type BestdoriFlatStorySection = Exclude<BestdoriStorySection, BestdoriChapterStorySection>;

/** Catalog-shaped record returned by the Bestdori story collection adapter. */
export interface BestdoriStoryListItem {
  storyId: string;
  storyKey?: string;
  scenarioId?: string;
  episodeNumber?: number;
  chapterId?: number;
  chapterKey?: string;
  chapterName?: unknown;
  storySort?: number;
  chapterSort?: number;
  title?: unknown;
  description?: unknown;
  caption?: unknown;
  publishedAt?: Array<number | null>;
  releaseAt?: number;
  sourceServer?: string;
  bandId?: number;
  eventId?: number;
  eventName?: unknown;
  characterIds?: number[];
  thumbnail?: string;
  image?: string;
  episodeImage?: string;
}

export const bestdoriEpisodeCatalogOrigin = (
  episode: Pick<StoryEpisode, "sourceServer"> | undefined,
  fallback: CatalogContentOrigin | undefined,
): CatalogContentOrigin | undefined =>
  isBestdoriServer(episode?.sourceServer) ? bestdoriOrigin(episode.sourceServer) : fallback;

export const bestdoriStoryPath = (section: BestdoriStorySection): string => `/community/stories-bestdori/${section}`;
