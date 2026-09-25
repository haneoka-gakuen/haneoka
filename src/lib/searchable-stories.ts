import { LOCALES, type Locale } from "../i18n/locales";
import { projectHaneokaTranscript } from "@haneoka/vega-plugin-haneoka/transcript";
import { resolveLocalizedText } from "./localized-text";
import { asRecord, fetchStaticCatalog, fetchStaticCatalogBatch, type RecordValue } from "./static-catalog-source";
import { disambiguateTitles } from "./title-disambiguation";

export type StoryMode = "band" | "link" | "home" | "afterlive" | "tutorial";

export interface StaticStoryLine {
  kind: "chapter" | "line" | "choices";
  name: string;
  text: string;
  choices: string[];
}

export interface SearchableStoryPage {
  mode: StoryMode;
  storyId: string;
  route: string;
  titles: Record<Locale, string>;
  chapterNames: Record<Locale, string>;
  descriptions: Record<Locale, string>;
  characterNames: Record<Locale, string>;
  /** The projected transcript, resolved per locale so every language page carries its own text. */
  lines: Record<Locale, StaticStoryLine[]>;
  episodeNumber: number;
  isAnotherEpisode: boolean;
  isExtraEpisode: boolean;
}

interface EpisodeRecord extends RecordValue {
  storyId?: string;
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
 * The interactive screen derives the mode from the chapter: numbered chapters
 * (below the synthetic 900000 range) are band stories, the rest map by key.
 */
function modeOf(episode: EpisodeRecord): StoryMode | undefined {
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

/** Mirrors the interactive transcript's speaker resolution. */
function speakerOf(command: RecordValue, characters: Map<number, RecordValue>, locale: Locale): string {
  const status = Number(command.targetStatus || 0);
  if (status === 2) return "";
  if (status === 1) return "???";
  const listed = (Array.isArray(command.targetTextNames) ? command.targetTextNames : [])
    .map((value) => text(value, locale))
    .filter(Boolean);
  if (listed.length) return listed.join("、");
  const targets = (Array.isArray(command.targets) ? command.targets : [])
    .map((target) => asRecord(target))
    .filter((target): target is RecordValue => !!target)
    .map((target) => {
      const named = text(target.name, locale);
      if (named) return named;
      const character = characters.get(Number(target.characterId || 0));
      return text(character?.characterName, locale);
    })
    .filter(Boolean);
  if (targets.length) return targets.join("、");
  return text(command.targetName, locale);
}

function storyLines(
  episode: EpisodeRecord,
  characters: Map<number, RecordValue>,
  locale: Locale,
): StaticStoryLine[] {
  const lines: StaticStoryLine[] = [];
  for (const entry of projectHaneokaTranscript(episode)) {
    const command = entry.command;
    if (entry.kind === "location" || entry.kind === "conversation") {
      const heading = text(command.text, locale) || speakerOf(command, characters, locale);
      if (heading) lines.push({ kind: "chapter", name: "", text: heading, choices: [] });
      continue;
    }
    if (entry.kind === "choices") {
      const choices = (Array.isArray(command.choices) ? command.choices : [])
        .map((choice) => text(asRecord(choice)?.text, locale))
        .filter(Boolean);
      if (choices.length) lines.push({ kind: "choices", name: "", text: "", choices });
      continue;
    }
    if (entry.kind === "dialogue" || entry.kind === "message" || entry.kind === "subtitle") {
      const line = text(command.text, locale);
      if (line) lines.push({ kind: "line", name: speakerOf(command, characters, locale), text: line, choices: [] });
    }
  }
  return lines;
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

let pagesPromise: Promise<SearchableStoryPage[]> | undefined;

export function searchableStoryPages(): Promise<SearchableStoryPage[]> {
  pagesPromise ??= buildSearchableStoryPages();
  return pagesPromise;
}

async function buildSearchableStoryPages(): Promise<SearchableStoryPage[]> {
  const [document, charactersDocument] = await Promise.all([
    fetchStaticCatalog("stories?projection=4"),
    fetchStaticCatalog("characters"),
  ]);
  const episodes = asRecord(asRecord(document)?.episodes) ?? {};
  const characters = new Map(
    Object.entries(asRecord(charactersDocument) ?? {}).flatMap(([key, raw]) => {
      const record = asRecord(raw);
      return record ? [[Number(record.characterId ?? key), record] as [number, RecordValue]] : [];
    }),
  );
  if (!Object.keys(episodes).length) return [];

  const wanted = Object.entries(episodes).flatMap(([key, raw]) => {
    const episode = asRecord(raw) as EpisodeRecord | undefined;
    const mode = episode ? modeOf(episode) : undefined;
    return episode && mode ? [[key, episode, mode] as [string, EpisodeRecord, StoryMode]] : [];
  });
  const details = await fetchStaticCatalogBatch("stories", wanted.map(([key]) => key));
  console.warn(`Static stories: ${details.size}/${wanted.length} episode scripts available`);

  const built = wanted.flatMap(([key, episode, mode]) => {
    const detail = (details.get(key) as EpisodeRecord | undefined) ?? episode;
    const titles = localizedAll(episode.title);
    const chapterNames = localizedAll(episode.chapterName);
    const names = (Array.isArray(episode.characterIds) ? episode.characterIds : [])
      .map(Number)
      .map((id) => text(characters.get(id)?.characterName, "ja"))
      .filter(Boolean);
    const characterNames = Object.fromEntries(
      LOCALES.map((locale) => [
        locale,
        (Array.isArray(episode.characterIds) ? episode.characterIds : [])
          .map(Number)
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
        return [locale, [...new Set(parts)].join(" · ").slice(0, 300)];
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
        lines: Object.fromEntries(
          LOCALES.map((locale) => [locale, storyLines(detail, characters, locale)]),
        ) as Record<Locale, StaticStoryLine[]>,
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

export async function searchableStoryUrls(): Promise<string[]> {
  return (await searchableStoryPages()).map(({ route }) => `${route}/`);
}
