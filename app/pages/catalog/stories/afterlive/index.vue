<script setup lang="ts">
import type { Character, StoryEpisode } from "~/types/archive";

const { localize, resolveLocalized, t, compareText } = useLocale();
useSeoMeta({ title: () => `${t("storyNavigation.afterlive")} · haneoka` });
const {
  catalog,
  characters,
  bands,
  characterMap,
  titleOfEpisode,
  durationOf,
  publishedValue,
  releaseOf,
  charactersOf,
  charactersInEpisodeOrder,
  compareCharacterIds,
  pending,
  error,
  refresh,
} = useStoryCatalogArchive();
const { selectedStoryId: selectedEpisodeId, storyTo, closeStory } = useStoryWorkbenchSelection();
const query = useRouteQueryText("q");
const selectedCharacters = useRouteQueryList("characters", true);
const selectedBands = useRouteQueryList("bands", true);
const selectedTiers = useRouteQueryList("tier", true);
const { activeFilterCount, resetFilters } = useCatalogFilterState({
  texts: [query],
  facets: [selectedCharacters, selectedBands, selectedTiers],
});
const storySortKeys = ["id", "release", "title", "characters", "level", "duration"] as const;
const sort = useRouteQueryEnum("sort", storySortKeys, "release");
const order = useRouteQueryEnum("order", ["asc", "desc"] as const, "desc");
const view = useRouteQueryEnum("view", ["grid", "list"] as const, "grid");

const chapter = computed(() =>
  Object.values(catalog.value.chapters).find((item) => item.chapterKey === "asset_afterlive"),
);
const episodes = computed(() =>
  (chapter.value?.episodes || [])
    .map((id) => catalog.value.episodes[id])
    .filter((episode): episode is StoryEpisode => Boolean(episode)),
);
const usedCharacterIds = computed(
  () =>
    new Set(
      episodes.value
        .flatMap((episode) => episode.characterIds || [])
        .map(Number)
        .filter(Boolean),
    ),
);
const usedBandIds = computed(
  () =>
    new Set(
      characters.value
        .filter((character) => usedCharacterIds.value.has(character.characterId))
        .map((character) => Number(character.bandId) || 0)
        .filter(Boolean),
    ),
);
const tierValues = computed(() =>
  [...new Set(episodes.value.map((episode) => Number(episode.unlockCharacterFriendshipLevel) || 0))].sort(
    (left, right) => left - right,
  ),
);
const tierOptions = computed(() =>
  tierValues.value.map((level) => ({
    value: level,
    label: `${t("friendshipLevel")} ${level}`,
    textMark: String(level),
    count: episodes.value.filter((episode) => (Number(episode.unlockCharacterFriendshipLevel) || 0) === level).length,
  })),
);
const sortOptions = computed(() => [
  { value: "id" as const, label: t("id"), icon: "tag" },
  { value: "release" as const, label: t("release"), icon: "format_list_numbered" },
  { value: "title" as const, label: t("title"), icon: "text_fields" },
  { value: "characters" as const, label: t("characters"), icon: "group" },
  { value: "level" as const, label: t("friendshipLevel"), icon: "handshake" },
  { value: "duration" as const, label: t("length"), icon: "schedule" },
]);

const normalize = (value: unknown) =>
  String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase();
const selectedCharacterNumbers = computed(() => selectedCharacters.value.map(Number));
const selectedBandNumbers = computed(() => selectedBands.value.map(Number));
const selectedTierNumbers = computed(() => selectedTiers.value.map(Number));
const visibleEpisodes = computed(() => {
  const needle = normalize(query.value);
  const values = episodes.value.filter((episode) => {
    const ids = (episode.characterIds || []).map(Number);
    if (selectedCharacterNumbers.value.length && !selectedCharacterNumbers.value.some((id) => ids.includes(id)))
      return false;
    if (
      selectedBandNumbers.value.length &&
      !ids.some((id) => selectedBandNumbers.value.includes(Number(characterMap.value.get(id)?.bandId) || 0))
    )
      return false;
    if (
      selectedTierNumbers.value.length &&
      !selectedTierNumbers.value.includes(Number(episode.unlockCharacterFriendshipLevel) || 0)
    )
      return false;
    if (!needle) return true;
    return normalize([titleOfEpisode(episode), ...charactersOf(ids).map(characterName)].join(" ")).includes(needle);
  });
  const direction = order.value === "asc" ? 1 : -1;
  return values.sort((left, right) => {
    let difference = left.storyId.localeCompare(right.storyId, "en", { numeric: true });
    if (sort.value === "release") difference = publishedValue(left) - publishedValue(right);
    if (sort.value === "title") difference = compareText(titleOfEpisode(left), titleOfEpisode(right));
    if (sort.value === "characters") difference = compareCharacterIds(left.characterIds, right.characterIds);
    if (sort.value === "level")
      difference =
        (Number(left.unlockCharacterFriendshipLevel) || 0) - (Number(right.unlockCharacterFriendshipLevel) || 0);
    if (sort.value === "duration") difference = Number(left.playTime || 0) - Number(right.playTime || 0);
    return direction * (difference || Number(left.storySort || 0) - Number(right.storySort || 0));
  });
});
const playerEpisode = computed(() => catalog.value.episodes[selectedEpisodeId.value]);

function characterName(character: Character) {
  return localize(character.characterName) || localize(character.englishName) || String(character.characterId);
}

const displayEpisodeTitle = (episode: StoryEpisode) =>
  resolveLocalized(episode.title, { sourceHint: "ja", fallback: titleOfEpisode(episode) }) || titleOfEpisode(episode);

const listItems = computed(() =>
  visibleEpisodes.value.map((episode) => ({
    id: episode.storyId,
    title: displayEpisodeTitle(episode),
    to: storyTo(episode.storyId),
    level: Number(episode.unlockCharacterFriendshipLevel) || 0,
    duration: durationOf(episode),
    release: releaseOf(episode),
    avatars: charactersInEpisodeOrder(episode).map((character) => ({
      id: character.characterId,
      name:
        resolveLocalized(character.characterName, {
          candidates: [character.englishName],
          sourceHint: "ja",
          fallback: characterName(character),
        }) || characterName(character),
      image: character.faceImage || character.thumbnailImage || character.profileImage,
      color: character.colorCode,
    })),
  })),
);
</script>

<template>
  <CatalogCollectionScreen
    v-model:view="view"
    :title="t('storyNavigation.afterlive')"
    :count="visibleEpisodes.length"
    domain="catalog"
    :filter-title="t('filter')"
    :pending="pending"
    :error="error"
    :empty="!episodes.length && !selectedEpisodeId"
    :active-filter-count="activeFilterCount"
    viewport-mode="stage"
    @retry="refresh()"
    @reset-filters="resetFilters"
  >
    <template #content>
      <StoryColumnWorkbench
        :story-id="selectedEpisodeId"
        :story-title="playerEpisode ? displayEpisodeTitle(playerEpisode) : ''"
        @close="closeStory"
      >
        <StoryCatalogList
          v-if="listItems.length"
          v-model:sort="sort"
          v-model:order="order"
          :items="listItems"
          media="avatars"
          :layout="view"
          :selected-id="selectedEpisodeId"
        />
        <EmptyState v-else />
      </StoryColumnWorkbench>
    </template>

    <template #filters>
      <SearchField v-model="query" />
      <BandCharacterFilters
        v-model:band-ids="selectedBands"
        v-model:character-ids="selectedCharacters"
        :bands="bands"
        :characters="characters"
        :available-band-ids="[...usedBandIds]"
        :available-character-ids="[...usedCharacterIds]"
      />
      <FacetGroup
        :title="t('friendshipLevel')"
        :options="tierOptions"
        :model-value="selectedTiers"
        icon-only
        @update:model-value="selectedTiers = $event"
      />
      <CatalogSortControl
        v-if="view === 'grid'"
        v-model="sort"
        v-model:order="order"
        :options="sortOptions"
        :label="t('sort')"
        :ascending-label="t('ascending')"
        :descending-label="t('descending')"
      />
    </template>
  </CatalogCollectionScreen>
</template>
