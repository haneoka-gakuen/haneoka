<script setup lang="ts">
import { useBestdoriImageSources } from "~/features/community/bestdori/imageSources";
import { useBestdoriStoryChapters } from "~/features/community/bestdori/storyChapters";
import {
  BESTDORI_STORY_SECTION_DEFINITIONS,
  type BestdoriChapterStorySection,
} from "~/features/community/bestdori/stories";
import { langOf, textOf, type DisplayText } from "~/types/displayText";
import type { CompositeEntityVisual } from "~/types/compositeVisual";
import { entityAvatarText } from "~/utils/entityAvatar";
import { bestdoriOrigin } from "~/features/catalog/contentSource";

/**
 * Bestdori event/band/main story catalog rendered through the shared
 * `<StoryChapterBrowser>` — the same layout the encyclopedia band-stories page
 * uses. Only the data source differs (Bestdori proxy + chapter normalizer +
 * language-fallback images). afterlive/card keep `BestdoriStoryCatalog`.
 */
const props = defineProps<{ section: BestdoriChapterStorySection }>();

const { resolveLocalized, t } = useLocale();
const sectionTitle = computed(() =>
  t(BESTDORI_STORY_SECTION_DEFINITIONS.find((entry) => entry.id === props.section)?.messageKey || "stories"),
);
const pageTitle = computed(() => `${t("communityPage.storiesBestDori")} · ${sectionTitle.value}`);
useSeoMeta({ title: () => `${pageTitle.value} · haneoka` });

const { chapters, episodes, bands, characters, pending, error, refresh } = useBestdoriStoryChapters(props.section);
const expandImage = useBestdoriImageSources();

const bandsById = computed(() => new Map(bands.value.map((band) => [band.bandId, band])));
const charactersById = computed(() => new Map(characters.value.map((character) => [character.characterId, character])));
const eventFacetEntries = computed(() => {
  if (props.section !== "event") return [];
  return chapters.value.flatMap((chapter) => {
    const characterIds = [...new Set(chapter.mainCharacterIds || [])].sort((left, right) => left - right);
    if (!characterIds.length) return [];
    const characterBands = characterIds
      .map((id) => charactersById.value.get(id)?.bandId)
      .filter((id): id is number => Boolean(id));
    const sharedBandId =
      characterBands.length === characterIds.length &&
      characterBands.every((id) => id === characterBands[0]) &&
      bandsById.value.get(characterBands[0]!)?.official
        ? characterBands[0]
        : undefined;
    const value = sharedBandId ? `band:${sharedBandId}` : `characters:${characterIds.join("-")}`;
    return [{ chapter, characterIds, sharedBandId, value }];
  });
});
const eventChapterFilterValues = computed<Record<string, string>>(() =>
  Object.fromEntries(eventFacetEntries.value.map((entry) => [entry.chapter.chapterKey, entry.value])),
);
const eventFilterOptions = computed(() => {
  const entries = new Map<
    string,
    {
      value: string;
      label: DisplayText;
      image?: string;
      imageFit?: "contain" | "cover";
      avatarText?: string;
      avatarLang?: string;
      icon?: string;
      color?: string;
      visuals?: CompositeEntityVisual[];
      count: number;
      official: boolean;
      order: number;
    }
  >();
  for (const entry of eventFacetEntries.value) {
    const current = entries.get(entry.value);
    if (current) {
      current.count += 1;
      continue;
    }
    if (entry.sharedBandId) {
      const band = bandsById.value.get(entry.sharedBandId);
      const label =
        resolveLocalized(band?.bandName, { sourceHint: "ja", fallback: String(entry.sharedBandId) }) ||
        String(entry.sharedBandId);
      entries.set(entry.value, {
        value: entry.value,
        label,
        image: band?.icon || band?.logo,
        imageFit: "contain",
        avatarText: entityAvatarText(label),
        avatarLang: langOf(label),
        icon: band?.icon || band?.logo ? undefined : "music_note",
        color: band?.color,
        count: 1,
        official: true,
        order: entry.sharedBandId,
      });
      continue;
    }
    const visuals = entry.characterIds.map((characterId): CompositeEntityVisual => {
      const character = charactersById.value.get(characterId);
      const label =
        resolveLocalized(character?.characterName, { sourceHint: "ja", fallback: String(characterId) }) ||
        String(characterId);
      return {
        image: character?.faceImage || character?.thumbnailImage || character?.profileImage,
        fit: "cover",
        text: entityAvatarText(label),
        lang: langOf(label),
        icon: "person",
        color: character?.colorCode,
      };
    });
    const label =
      entry.characterIds
        .map((characterId) => {
          const character = charactersById.value.get(characterId);
          return textOf(
            resolveLocalized(character?.characterName, { sourceHint: "ja", fallback: String(characterId) }) ||
              String(characterId),
          );
        })
        .join("・") || t("character");
    entries.set(entry.value, {
      value: entry.value,
      label,
      visuals,
      count: 1,
      official: false,
      order: entry.characterIds[0] || Number.MAX_SAFE_INTEGER,
    });
  }
  return [...entries.values()].sort(
    (left, right) => Number(right.official) - Number(left.official) || left.order - right.order,
  );
});
</script>

<template>
  <StoryChapterBrowser
    domain="community"
    :title="pageTitle"
    :catalog-origin="bestdoriOrigin('jp')"
    catalog-adapter="bestdori"
    :enable-band-filter="section === 'band'"
    :chapter-filter-title="section === 'event' ? t('band') : undefined"
    :chapter-filter-options="section === 'event' ? eventFilterOptions : []"
    :chapter-filter-values="section === 'event' ? eventChapterFilterValues : {}"
    :chapters="chapters"
    :episodes="episodes"
    :bands="bands"
    :expand-image="expandImage"
    episode-image-mode="stretch-16x9"
    :allow-list="false"
    :pending="pending"
    :error="error"
    @refresh="refresh()"
  />
</template>
