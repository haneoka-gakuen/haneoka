import type { Band, Character, LocalizedValue, StoryChapter, StoryEpisode } from "~/types/archive";
import { bestdoriOrigin } from "~/features/catalog/contentSource";
import type { BestdoriChapterStorySection, BestdoriStoryListItem } from "./stories";

const numericChapterId = (value: unknown): number => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
};

export const useBestdoriStoryChapters = (section: BestdoriChapterStorySection) => {
  const isBand = section === "band";
  const isEvent = section === "event";
  const usesEntities = isBand || isEvent;
  const storyCollection = useLazyCatalogCollection<BestdoriStoryListItem>(
    `stories/${section}`,
    () => true,
    bestdoriOrigin("jp"),
  );
  const bandsCollection = useLazyCatalogCollection<Band>("bands", () => usesEntities, bestdoriOrigin("jp"));
  const charactersCollection = useLazyCatalogCollection<Character>("characters", () => isEvent, bestdoriOrigin("jp"));

  const bands = computed(() => recordValues(bandsCollection.data.value));
  const characters = computed(() => recordValues(charactersCollection.data.value));
  const bandMap = computed(() => new Map(bands.value.map((band) => [band.bandId, band])));
  const items = computed(() =>
    recordValues(storyCollection.data.value).sort(
      (left, right) => Number(left.storySort || 0) - Number(right.storySort || 0),
    ),
  );

  const episodes = computed<Record<string, StoryEpisode>>(() => {
    const output: Record<string, StoryEpisode> = {};
    for (const item of items.value) {
      output[item.storyId] = {
        storyId: item.storyId,
        storyKey: item.storyKey || item.storyId,
        episodeNumber: item.episodeNumber,
        chapterId: item.chapterId,
        chapterKey: item.chapterKey,
        chapterName: item.chapterName as LocalizedValue | undefined,
        storySort: item.storySort,
        title: (item.title as LocalizedValue) ?? "",
        description: item.description as LocalizedValue | undefined,
        publishedAt: item.publishedAt,
        releaseAt: item.releaseAt,
        bandId: item.bandId,
        characterIds: item.characterIds,
        ...(item.episodeImage ? { banner: item.episodeImage, image: item.episodeImage } : {}),
      };
    }
    return output;
  });

  const chapters = computed<StoryChapter[]>(() => {
    const byKey = new Map<string, StoryChapter>();
    for (const item of items.value) {
      const key = String(item.chapterId ?? item.chapterKey ?? item.storyId);
      const existing = byKey.get(key);
      if (existing) {
        existing.episodes.push(item.storyId);
        continue;
      }
      const id = item.chapterId ?? numericChapterId(item.chapterKey);
      const band = item.bandId != null ? bandMap.value.get(item.bandId) : undefined;
      byKey.set(key, {
        chapterId: id,
        chapterKey: item.chapterKey || key,
        chapterName: (item.chapterName as LocalizedValue) ?? (item.eventName as LocalizedValue) ?? String(id),
        chapterSort: item.chapterSort ?? id,
        bandId: item.bandId,
        mainCharacterIds: item.characterIds,
        episodes: [item.storyId],
        image: item.image || item.thumbnail || band?.icon,
        icon: item.thumbnail || band?.logo,
      });
    }
    return [...byKey.values()].sort((left, right) => {
      if (section === "event")
        return (
          Number(right.chapterSort || 0) - Number(left.chapterSort || 0) ||
          Number(right.chapterId || 0) - Number(left.chapterId || 0)
        );
      return (
        Number(left.chapterSort || 0) - Number(right.chapterSort || 0) ||
        Number(left.chapterId || 0) - Number(right.chapterId || 0)
      );
    });
  });

  const pending = computed(
    () =>
      storyCollection.pending.value ||
      (usesEntities && bandsCollection.pending.value) ||
      (isEvent && charactersCollection.pending.value),
  );
  const error = computed(
    () =>
      storyCollection.error.value ||
      (usesEntities ? bandsCollection.error.value : null) ||
      (isEvent ? charactersCollection.error.value : null),
  );
  const refresh = async (): Promise<void> => {
    await Promise.all([
      storyCollection.refresh(),
      ...(usesEntities ? [bandsCollection.refresh()] : []),
      ...(isEvent ? [charactersCollection.refresh()] : []),
    ]);
  };

  return { chapters, episodes, bands, characters, pending, error, refresh };
};
