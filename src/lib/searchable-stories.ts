import { LOCALES, type Locale } from "../i18n/locales";
import { projectHaneokaTranscript } from "@haneoka/vega-plugin-haneoka/transcript";
import { resolveLocalizedText } from "./localized-text";
import { storyCharacterIds } from "./story-characters";
import {
  asRecord,
  fetchStaticCatalog,
  fetchStaticCatalogBatch,
  staticCatalogRelease,
  type RecordValue,
} from "./static-catalog-source";
import { disambiguateTitles } from "./title-disambiguation";
import type { ReleaseServer } from "./release-server";

export type StoryMode = "event" | "band" | "link" | "birthday" | "home" | "afterlive" | "tutorial";

export interface SearchableStoryPage {
  mode: StoryMode;
  storyId: string;
  route: string;
  titles: Record<Locale, string>;
  chapterNames: Record<Locale, string>;
  descriptions: Record<Locale, string>;
  characterNames: Record<Locale, string>;
  episodeNumber: number;
  isAnotherEpisode: boolean;
  isExtraEpisode: boolean;
}

interface EpisodeRecord extends RecordValue {
  storyId?: string;
  storyCategory?: unknown;
  chapterId?: unknown;
  chapterKey?: unknown;
  chapterName?: unknown;
  title?: unknown;
  description?: unknown;
  characterIds?: unknown;
  perspectiveCharacterId?: unknown;
  episodeNumber?: unknown;
  isAnotherEpisode?: unknown;
  isExtraEpisode?: unknown;
  commands?: unknown;
}

const text = (value: unknown, locale: Locale): string => resolveLocalizedText(value, locale).text.trim();

const localizedAll = (value: unknown): Record<Locale, string> =>
  Object.fromEntries(LOCALES.map((locale) => [locale, text(value, locale)])) as Record<Locale, string>;

/**
 * The interactive screen derives the mode from the chapter: event-owned
 * chapters are event stories, native birthday categories come next, other
 * numbered chapters (below the synthetic 900000 range) are band stories,
 * and the rest map by key.
 */
function modeOf(episode: EpisodeRecord, eventChapterIds: ReadonlySet<string>): StoryMode | undefined {
  const chapterId = String(episode.chapterId || "");
  if (eventChapterIds.has(chapterId)) return "event";
  if (episode.storyCategory === "birthday") return "birthday";
  if (Number(episode.chapterId || 0) < 900000) return "band";
  switch (episode.chapterKey) {
    case "asset_linkstory":
      return "link";
    case "asset_home":
      return "home";
    case "asset_afterlive":
      return "afterlive";
    case "asset_tutorial":
      return "tutorial";
    default:
      return undefined;
  }
}

/** First spoken line, kept unlocalised so every locale's meta can resolve it. */
function firstLineValue(episode: EpisodeRecord): unknown {
  for (const entry of projectHaneokaTranscript(episode)) {
    if (["dialogue", "message", "subtitle", "location", "conversation"].includes(entry.kind)) {
      const value = entry.command.text;
      if (text(value, "ja")) return value;
    }
  }
  return undefined;
}

const pagesPromises = new Map<ReleaseServer, Promise<SearchableStoryPage[]>>();

export function searchableStoryPages(server: ReleaseServer = "intl"): Promise<SearchableStoryPage[]> {
  const existing = pagesPromises.get(server);
  if (existing) return existing;
  const promise = buildSearchableStoryPages(server);
  pagesPromises.set(server, promise);
  return promise;
}

async function buildSearchableStoryPages(server: ReleaseServer): Promise<SearchableStoryPage[]> {
  const release = await staticCatalogRelease(server);
  const [document, charactersDocument] = await Promise.all([
    fetchStaticCatalog("stories?projection=4", server, release),
    fetchStaticCatalog("characters", server, release),
  ]);
  const storiesRoot = asRecord(document);
  const episodes = storiesRoot ? asRecord(storiesRoot.episodes) : undefined;
  if (!storiesRoot || !episodes) throw new Error(`Invalid stories catalog response for ${server}`);
  const charactersRoot = asRecord(charactersDocument);
  if (!charactersRoot) throw new Error(`Invalid characters catalog response for ${server}`);
  const characters = new Map(
    Object.entries(charactersRoot).flatMap(([key, raw]) => {
      const record = asRecord(raw);
      return record ? [[Number(record.characterId ?? key), record] as [number, RecordValue]] : [];
    }),
  );
  if (!Object.keys(episodes).length) return [];
  const storyEvents = Array.isArray(storiesRoot.storyEvents) ? storiesRoot.storyEvents : [];
  const eventChapterIds = new Set(
    storyEvents.flatMap((raw) => {
      const record = asRecord(raw);
      return record && record.chapterId ? [String(record.chapterId)] : [];
    }),
  );

  const wanted = Object.entries(episodes).flatMap(([key, raw]) => {
    const episode = asRecord(raw) as EpisodeRecord | undefined;
    const mode = episode ? modeOf(episode, eventChapterIds) : undefined;
    return episode && mode ? [[key, episode, mode] as [string, EpisodeRecord, StoryMode]] : [];
  });
  const details = await fetchStaticCatalogBatch("stories", wanted.map(([key]) => key), server, release);
  console.warn(`Static stories: ${details.size}/${wanted.length} episode scripts available`);

  const built = wanted.flatMap(([key, episode, mode]) => {
    const detail = (details.get(key) as EpisodeRecord | undefined) ?? episode;
    const titles = localizedAll(episode.title);
    const chapterNames = localizedAll(episode.chapterName);
    const characterNames = Object.fromEntries(
      LOCALES.map((locale) => [
        locale,
        storyCharacterIds(episode)
          .map((id) => text(characters.get(id)?.characterName, locale))
          .filter(Boolean)
          .join("、"),
      ]),
    ) as Record<Locale, string>;
    const excerpt = firstLineValue(detail);
    const descriptions = Object.fromEntries(
      LOCALES.map((locale) => {
        const own = text(episode.description, locale);
        if (own) return [locale, own];
        const parts = [titles[locale], chapterNames[locale]].filter(
          (part) => part && part !== titles[locale] && part !== chapterNames[locale],
        );
        const firstLine = text(excerpt, locale);
        if (firstLine) parts.push(firstLine);
        return [locale, [...new Set(parts)].join(" / ").slice(0, 300)];
      }),
    ) as Record<Locale, string>;
    const storyId = String(episode.storyId ?? key);
    return [
      {
        mode,
        storyId,
        route: `/catalog/stories/${mode}/${storyId}`,
        titles,
        chapterNames,
        descriptions,
        characterNames,
        episodeNumber: Number(episode.episodeNumber || 0),
        isAnotherEpisode: Boolean(episode.isAnotherEpisode),
        isExtraEpisode: Boolean(episode.isExtraEpisode),
      },
    ];
  });

  // The game reuses conversation titles across runs (the same home scene per
  // character, identical after-live names in different events); cast names
  // disambiguate most groups, the chapter name the rest, story ids last.
  disambiguateTitles(
    built,
    (page, locale) => page.titles[locale],
    (page, locale, title) => {
      page.titles[locale] = title;
    },
    [
      (page, locale) => page.characterNames[locale],
      (page, locale) => page.chapterNames[locale],
    ],
    (page) => page.storyId,
  );
  return built;
}

export async function searchableStoryUrls(server: ReleaseServer = "intl"): Promise<string[]> {
  return (await searchableStoryPages(server)).map(({ route }) => `${route}/`);
}
