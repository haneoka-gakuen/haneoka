import type { Band, Character, HomeSpot, StoryCatalog, StoryEpisode } from "~/types/archive";
import type { CatalogContentOrigin } from "~/features/catalog/contentSource";

const emptyStoryCatalog: StoryCatalog = { chapters: {}, episodes: {}, homeSpots: {} };

const homeSpotLocationNames: Record<string, string> = {
  cafe: "Cafe",
  livehouse: "Live House",
  lobby: "Lobby",
  studio: "Studio",
  vrfloor: "VR Floor",
};

const homeSpotSceneName = (assetName?: string) => {
  const scene = String(assetName || "")
    .replace(/^home_\d+_[a-z0-9]+_\d+_/i, "")
    .split("_")
    .filter((part) => part && !/^\d+$/.test(part))
    .map(
      (part) =>
        homeSpotLocationNames[part.toLocaleLowerCase()] || part.replace(/(^|-)\w/g, (value) => value.toUpperCase()),
    )
    .join(" ");
  return scene;
};

const byCharacterId = (left: Character, right: Character) => left.characterId - right.characterId;

const characterIdSequence = (ids?: number[]) =>
  [...new Set((ids || []).map(Number).filter((id) => Number.isFinite(id) && id > 0))].sort(
    (left, right) => left - right,
  );

const compareCharacterIds = (left?: number[], right?: number[]) => {
  const leftIds = characterIdSequence(left);
  const rightIds = characterIdSequence(right);
  const length = Math.max(leftIds.length, rightIds.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftIds[index] ?? -1) - (rightIds[index] ?? -1);
    if (difference) return difference;
  }
  return 0;
};

const localizedTextValues = (value: unknown): string[] => {
  if (typeof value === "string") return value ? [value] : [];
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string" && Boolean(item));
  if (value && typeof value === "object")
    return Object.values(value).filter((item): item is string => typeof item === "string" && Boolean(item));
  return [];
};

const normalizeStoryText = (value: unknown) =>
  String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase();

/** Load one exact catalog origin; omitted means the selected Our Notes release. */
export const useStoryCatalogArchive = (origin?: MaybeRefOrGetter<CatalogContentOrigin | undefined>) => {
  const { localize, formatDate } = useLocale();
  const storyRequest = useCatalogDocument<StoryCatalog>("stories", origin);
  const characterRequest = useCatalogCollection<Character>("characters", origin);
  const bandRequest = useCatalogCollection<Band>("bands", origin);

  const catalog = computed(() => storyRequest.data.value || emptyStoryCatalog);
  const characters = computed(() => recordValues(characterRequest.data.value).sort(byCharacterId));
  const bands = computed(() => recordValues(bandRequest.data.value).sort((left, right) => left.bandId - right.bandId));
  const characterMap = computed(() => new Map(characters.value.map((character) => [character.characterId, character])));
  const bandMap = computed(() => new Map(bands.value.map((band) => [band.bandId, band])));
  const homeSpotByStoryKey = computed(() => {
    const index = new Map<string, HomeSpot | null>();
    for (const spot of Object.values(catalog.value.homeSpots)) {
      for (const talk of spot.talks || []) {
        const storyKey = String(talk.storyKey || "");
        if (!storyKey) continue;
        if (!index.has(storyKey)) index.set(storyKey, spot);
        else if (index.get(storyKey)?.spotId !== spot.spotId) index.set(storyKey, null);
      }
    }
    return index;
  });

  const titleOfEpisode = (episode: StoryEpisode) => localize(episode.title) || episode.storyId;
  const titleOfSpot = (spot: HomeSpot) =>
    homeSpotSceneName(spot.assetName) || localize(spot.bandName) || String(spot.spotId);
  const durationOf = (episode?: StoryEpisode) => {
    const seconds = Math.max(0, Math.floor(Number(episode?.playTime) || 0));
    return seconds ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}` : "";
  };
  const publishedValue = (episode?: StoryEpisode) =>
    Math.max(0, ...(episode?.publishedAt || []).filter((value): value is number => typeof value === "number"));
  const releaseOf = (episode?: StoryEpisode) => {
    const value = publishedValue(episode);
    return value ? formatDate(value) : "";
  };
  const charactersOf = (ids?: number[]) =>
    (ids || [])
      .map((id) => characterMap.value.get(Number(id)))
      .filter((character): character is Character => Boolean(character))
      .sort(byCharacterId);
  const charactersInOrder = (ids?: number[]) =>
    (ids || [])
      .map((id) => characterMap.value.get(Number(id)))
      .filter((character): character is Character => Boolean(character));
  const charactersInEpisodeOrder = (episode: StoryEpisode) => {
    const title = normalizeStoryText(titleOfEpisode(episode));
    return charactersInOrder(episode.characterIds)
      .map((character, sourceIndex) => {
        const titleIndex = [...localizedTextValues(character.nickname), ...localizedTextValues(character.characterName)]
          .map(normalizeStoryText)
          .filter(Boolean)
          .map((name) => title.indexOf(name))
          .filter((index) => index >= 0)
          .sort((left, right) => left - right)[0];
        return { character, sourceIndex, titleIndex: titleIndex ?? Number.POSITIVE_INFINITY };
      })
      .sort((left, right) => left.titleIndex - right.titleIndex || left.sourceIndex - right.sourceIndex)
      .map(({ character }) => character);
  };
  const homeSpotOfStory = (episode: StoryEpisode | string) => {
    const storyKey = typeof episode === "string" ? episode : episode.storyId || episode.storyKey;
    return homeSpotByStoryKey.value.get(storyKey) || undefined;
  };
  const storyTo = (episode: StoryEpisode) => {
    const storyId = episode.storyId || episode.storyKey;
    const chapter =
      catalog.value.chapters[String(episode.chapterId)] ||
      Object.values(catalog.value.chapters).find((item) => item.episodes.includes(storyId));
    const chapterKey = String(episode.chapterKey || chapter?.chapterKey || "").toLocaleLowerCase();
    const parameters = new URLSearchParams({ episode: storyId });
    let path = "/catalog/stories/band";

    if (chapterKey.includes("linkstory")) {
      path = "/catalog/stories/link";
      const [first, second] = (episode.characterIds || []).map(Number).filter(Boolean);
      if (first) parameters.set("first", String(first));
      if (second) parameters.set("second", String(second));
    } else if (chapterKey.includes("asset_home")) {
      path = "/catalog/stories/home";
      const spot = homeSpotOfStory(storyId);
      if (spot) parameters.set("spot", String(spot.spotId));
    } else if (chapterKey.includes("afterlive")) {
      path = "/catalog/stories/afterlive";
    } else if (chapterKey.includes("tutorial")) {
      path = "/catalog/stories/tutorial";
    } else if (chapter?.chapterId) {
      parameters.set("chapter", String(chapter.chapterId));
    }

    return `${path}?${parameters}`;
  };

  return {
    ...storyRequest,
    catalog,
    characters,
    bands,
    characterMap,
    bandMap,
    titleOfEpisode,
    titleOfSpot,
    durationOf,
    publishedValue,
    releaseOf,
    charactersOf,
    charactersInOrder,
    charactersInEpisodeOrder,
    compareCharacterIds,
    homeSpotOfStory,
    storyTo,
  };
};
