<script setup lang="ts">
import type { Character, StoryEpisode } from "~/types/archive";

const { localize, resolveLocalized, t, compareText } = useLocale();
useSeoMeta({ title: () => `${t("storyNavigation.link")} · haneoka` });
const {
  catalog,
  characters,
  bandMap,
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
const selectedLevels = useRouteQueryList("level", true);
const { activeFilterCount, resetFilters } = useCatalogFilterState({
  texts: [query],
  facets: [selectedLevels],
});
const selectedFirstId = useRouteQueryNumber("first");
const selectedSecondId = useRouteQueryNumber("second");
const storySortKeys = ["id", "release", "title", "characters", "level", "duration"] as const;
const sort = useRouteQueryEnum("sort", storySortKeys, "release");
const order = useRouteQueryEnum("order", ["asc", "desc"] as const, "desc");
const view = ref<"grid" | "list">("grid");

const chapter = computed(() =>
  Object.values(catalog.value.chapters).find((item) => item.chapterKey === "asset_linkstory"),
);
const episodes = computed(() =>
  (chapter.value?.episodes || [])
    .map((id) => catalog.value.episodes[id])
    .filter((episode): episode is StoryEpisode => Boolean(episode)),
);
const levelValues = computed(() =>
  [...new Set(episodes.value.map((episode) => Number(episode.unlockCharacterFriendshipLevel) || 0))].sort(
    (left, right) => left - right,
  ),
);
const levelOptions = computed(() =>
  levelValues.value.map((level) => ({
    value: level,
    label: `${t("friendshipLevel")} ${level}`,
    textMark: String(level),
    count: episodes.value.filter((episode) => (Number(episode.unlockCharacterFriendshipLevel) || 0) === level).length,
  })),
);
const firstCharacters = computed(() =>
  [...characters.value].sort((left, right) => left.characterId - right.characterId),
);
const secondCharacters = computed(() =>
  firstCharacters.value.filter((character) => character.characterId !== selectedFirstId.value),
);

watchEffect(() => {
  if (!firstCharacters.value.length) return;
  if (!firstCharacters.value.some((character) => character.characterId === selectedFirstId.value)) {
    selectedFirstId.value = firstCharacters.value[0]?.characterId;
    selectedSecondId.value = undefined;
  }
  if (!secondCharacters.value.some((character) => character.characterId === selectedSecondId.value)) {
    selectedSecondId.value = undefined;
  }
});

function selectFirstCharacter(characterId: number) {
  selectedFirstId.value = characterId;
  selectedSecondId.value = undefined;
}

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
const selectedLevelNumbers = computed(() => selectedLevels.value.map(Number));
const visibleEpisodes = computed(() => {
  const needle = normalize(query.value);
  const firstId = selectedFirstId.value;
  const secondId = selectedSecondId.value;
  const values = episodes.value.filter((episode) => {
    const ids = (episode.characterIds || []).map(Number);
    if (firstId && !ids.includes(firstId)) return false;
    if (secondId && !ids.includes(secondId)) return false;
    if (
      selectedLevelNumbers.value.length &&
      !selectedLevelNumbers.value.includes(Number(episode.unlockCharacterFriendshipLevel) || 0)
    )
      return false;
    return (
      !needle ||
      normalize([titleOfEpisode(episode), ...charactersOf(ids).map(characterName)].join(" ")).includes(needle)
    );
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

const displayCharacterName = (character: Character) =>
  resolveLocalized(character.characterName, {
    candidates: [character.englishName],
    sourceHint: "ja",
    fallback: String(character.characterId),
  }) || String(character.characterId);

const displayBandName = (bandId: number) =>
  resolveLocalized(bandMap.value.get(bandId)?.bandName, { sourceHint: "ja", fallback: String(bandId) }) ||
  String(bandId);

const displayEpisodeTitle = (episode: StoryEpisode) =>
  resolveLocalized(episode.title, { sourceHint: "ja", fallback: titleOfEpisode(episode) }) || titleOfEpisode(episode);

function swapCharacters() {
  const firstId = selectedFirstId.value;
  const secondId = selectedSecondId.value;
  if (!firstId || !secondId) return;
  selectedFirstId.value = secondId;
  selectedSecondId.value = firstId;
}

const listItems = computed(() =>
  visibleEpisodes.value.map((episode) => ({
    id: episode.storyId,
    title: displayEpisodeTitle(episode),
    to: storyTo(episode.storyId),
    thumbnail: episode.banner || episode.image,
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
    :title="t('storyNavigation.link')"
    :count="visibleEpisodes.length"
    domain="catalog"
    :filter-title="t('filter')"
    :pending="pending"
    :error="error"
    :empty="!episodes.length && !selectedEpisodeId"
    :active-filter-count="activeFilterCount"
    :show-view-control="false"
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
        <div class="link-story-browser">
          <StoryLinkSelector
            :characters="firstCharacters"
            :partners="secondCharacters"
            :first-id="selectedFirstId"
            :second-id="selectedSecondId"
            :name-of="displayCharacterName"
            :band-name-of="displayBandName"
            @first="selectFirstCharacter"
            @second="selectedSecondId = $event"
            @swap="swapCharacters"
          >
            <StoryCatalogList
              v-if="listItems.length"
              v-model:sort="sort"
              v-model:order="order"
              :items="listItems"
              media="thumbnail"
              layout="grid"
              :selected-id="selectedEpisodeId"
            />
            <EmptyState v-else />
          </StoryLinkSelector>
        </div>
      </StoryColumnWorkbench>
    </template>

    <template #filters>
      <SearchField v-model="query" />
      <FacetGroup
        :title="t('friendshipLevel')"
        :options="levelOptions"
        :model-value="selectedLevels"
        icon-only
        @update:model-value="selectedLevels = $event"
      />
      <CatalogSortControl
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

<style scoped>
.link-story-browser {
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: var(--md-sys-color-surface);
}
</style>
