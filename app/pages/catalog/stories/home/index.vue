<script setup lang="ts">
import type { Character, HomeSpotTalk, StoryEpisode } from "~/types/archive";
import { langOf } from "~/types/displayText";
import { entityAvatarText } from "~/utils/entityAvatar";

const { localize, resolveLocalized, t, compareText } = useLocale();
useSeoMeta({ title: () => `${t("storyNavigation.home")} · haneoka` });
const {
  catalog,
  bandMap,
  titleOfEpisode,
  durationOf,
  publishedValue,
  charactersOf,
  compareCharacterIds,
  titleOfSpot,
  pending,
  error,
  refresh,
} = useStoryCatalogArchive();
const { selectedStoryId: selectedEpisodeId, storyTo, closeStory } = useStoryWorkbenchSelection();
const selectedSpotId = useRouteQueryNumber("spot");
const selectedCharacters = useRouteQueryList("characters", true);
const selectedBands = useRouteQueryList("bands", true);
const query = useRouteQueryText("q");
const { activeFilterCount, resetFilters } = useCatalogFilterState({
  texts: [query],
  facets: [selectedBands],
});
const homeSortKeys = ["id", "release", "title", "characters", "duration"] as const;
const sort = useRouteQueryEnum("sort", homeSortKeys, "id");
const order = useRouteQueryEnum("order", ["asc", "desc"] as const, "asc");

const allSpots = computed(() =>
  Object.values(catalog.value.homeSpots).sort((left, right) => left.spotId - right.spotId),
);
const spots = computed(() =>
  allSpots.value.filter(
    (spot) => !selectedBands.value.length || selectedBands.value.includes(Number(spot.bandId) || 0),
  ),
);
// A band filter may temporarily remove every rail entry. Keep the last/source
// spot mounted so character filtering only empties the related-story region.
const selectedSpot = computed(
  () =>
    spots.value.find((spot) => spot.spotId === selectedSpotId.value) ||
    allSpots.value.find((spot) => spot.spotId === selectedSpotId.value) ||
    spots.value[0] ||
    allSpots.value[0],
);
const spotItems = computed(() =>
  spots.value.map((spot) => {
    const band = bandMap.value.get(Number(spot.bandId) || 0);
    return {
      id: spot.spotId,
      label: titleOfSpot(spot),
      image: spot.spine?.backgroundPreview,
      overlayImage: band?.logo || band?.icon,
      imageFit: "cover" as const,
      color: band?.color,
    };
  }),
);
const bandOptions = computed(() =>
  [...new Set(allSpots.value.map((spot) => Number(spot.bandId)).filter(Boolean))]
    .sort((left, right) => left - right)
    .map((bandId) => {
      const band = bandMap.value.get(bandId);
      const fallbackName = allSpots.value.find((spot) => Number(spot.bandId) === bandId)?.bandName;
      const label =
        resolveLocalized(band?.bandName, {
          candidates: [fallbackName],
          sourceHint: "ja",
          fallback: String(bandId),
        }) || String(bandId);
      return {
        value: bandId,
        label,
        image: band?.icon,
        imageFit: "cover" as const,
        color: band?.color,
        avatarText: entityAvatarText(label),
        avatarLang: langOf(label),
        icon: band?.icon ? undefined : "music_note",
        count: allSpots.value.filter((spot) => Number(spot.bandId) === bandId).length,
      };
    }),
);
const selectedSpineCharacterId = computed(() => Number(selectedCharacters.value[0]) || 0);
const selectedDialogues = computed(() => {
  const needle = normalize(query.value);
  const selected = selectedCharacters.value.map(Number);
  const values = (selectedSpot.value?.talks || [])
    .map((talk) => ({ talk, episode: catalog.value.episodes[talk.storyKey] }))
    .filter((item): item is { talk: HomeSpotTalk; episode: StoryEpisode } => Boolean(item.episode))
    .filter(({ talk, episode }) => {
      const ids = (
        episode.characterIds?.length ? episode.characterIds : talk.characterId ? [talk.characterId] : []
      ).map(Number);
      if (selected.length && !selected.some((id) => ids.includes(id))) return false;
      return (
        !needle ||
        normalize([titleOfEpisode(episode), ...charactersOf(ids).map(characterName)].join(" ")).includes(needle)
      );
    });
  const direction = order.value === "asc" ? 1 : -1;
  return values.sort((left, right) => {
    const idsOf = ({ talk, episode }: { talk: HomeSpotTalk; episode: StoryEpisode }) =>
      (episode.characterIds?.length ? episode.characterIds : talk.characterId ? [talk.characterId] : []).map(Number);
    const idOf = ({ talk }: { talk: HomeSpotTalk }) => `${selectedSpot.value?.spotId || 0}-${String(talk.id)}`;
    let difference = idOf(left).localeCompare(idOf(right), "en", { numeric: true });
    if (sort.value === "release") difference = publishedValue(left.episode) - publishedValue(right.episode);
    if (sort.value === "title") difference = compareText(titleOfEpisode(left.episode), titleOfEpisode(right.episode));
    if (sort.value === "characters") difference = compareCharacterIds(idsOf(left), idsOf(right));
    if (sort.value === "duration")
      difference = Number(left.episode.playTime || 0) - Number(right.episode.playTime || 0);
    const fallback =
      (Number(left.talk.id) || Number(left.talk.advId) || 0) - (Number(right.talk.id) || Number(right.talk.advId) || 0);
    return direction * (difference || fallback);
  });
});
const playerEpisode = computed(() => catalog.value.episodes[selectedEpisodeId.value]);
const displayEpisodeTitle = (episode: StoryEpisode) =>
  resolveLocalized(episode.title, { sourceHint: "ja", fallback: titleOfEpisode(episode) }) || titleOfEpisode(episode);
const listItems = computed(() =>
  selectedDialogues.value.map(({ talk, episode }) => {
    const ids = episode.characterIds?.length ? episode.characterIds : talk.characterId ? [talk.characterId] : [];
    const spot = selectedSpot.value;
    const band = bandMap.value.get(Number(spot?.bandId) || 0);
    return {
      id: `${selectedSpot.value?.spotId}-${String(talk.id)}`,
      title: displayEpisodeTitle(episode),
      to: storyTo(episode.storyId),
      thumbnail: spot?.spine?.backgroundPreview,
      overlayImage: band?.logo || band?.icon,
      duration: durationOf(episode),
      avatars: charactersOf(ids).map((character) => ({
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
    };
  }),
);
const sortOptions = computed(() => [
  { value: "id" as const, label: t("id"), icon: "tag" },
  { value: "release" as const, label: t("release"), icon: "calendar_month" },
  { value: "title" as const, label: t("title"), icon: "text_fields" },
  { value: "characters" as const, label: t("characters"), icon: "group" },
  { value: "duration" as const, label: t("length"), icon: "schedule" },
]);

function normalize(value: unknown) {
  return String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase();
}

function characterName(character: Character) {
  return localize(character.characterName) || localize(character.englishName) || String(character.characterId);
}

function selectSpot(value: string | number) {
  selectedSpotId.value = Number(value);
}

function selectSpineCharacter(characterId: number) {
  selectedCharacters.value = selectedSpineCharacterId.value === characterId ? [] : [characterId];
}

watch(
  spots,
  (values) => {
    if (values.length && !values.some((spot) => spot.spotId === selectedSpotId.value))
      selectedSpotId.value = values[0]?.spotId;
  },
  { immediate: true },
);
watch(selectedSpotId, () => {
  const available = new Set(selectedSpot.value?.characterIds || []);
  if (selectedCharacters.value.some((id) => !available.has(Number(id)))) selectedCharacters.value = [];
});
</script>

<template>
  <WorkspaceScreen
    :title="t('storyNavigation.home')"
    :count="selectedDialogues.length"
    domain="catalog"
    :filter-title="t('filter')"
    :active-filter-count="activeFilterCount"
    @reset-filters="resetFilters"
  >
    <LoadingState v-if="pending" />
    <ErrorState v-else-if="error" @retry="refresh()" />
    <StoryColumnWorkbench
      v-else-if="selectedSpot || selectedEpisodeId"
      :story-id="selectedEpisodeId"
      :story-title="playerEpisode ? displayEpisodeTitle(playerEpisode) : ''"
      @close="closeStory"
    >
      <div v-if="selectedSpot" class="home-browser">
        <StoryMediaRail
          class="home-browser__spots"
          :items="spotItems"
          :model-value="selectedSpot.spotId"
          :label="t('stage')"
          appearance="media"
          @update:model-value="selectSpot"
        />
        <div class="home-browser__scene">
          <HomeSpotSpineScene
            :spot="selectedSpot"
            :selected-character-id="selectedSpineCharacterId"
            @select-character="selectSpineCharacter"
          />
        </div>
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
      </div>
      <!-- A direct episode URL may resolve in another Our Notes release even
      when this release has no matching home spot. Keep the detail workbench
      mounted; the player performs the release fallback independently. -->
      <EmptyState v-else />
    </StoryColumnWorkbench>
    <EmptyState v-else />

    <template #filters>
      <SearchField v-model="query" />
      <FacetGroup v-model="selectedBands" :title="t('band')" :options="bandOptions" icon-only />
      <CatalogSortControl
        v-model="sort"
        v-model:order="order"
        :options="sortOptions"
        :label="t('sort')"
        :ascending-label="t('ascending')"
        :descending-label="t('descending')"
      />
    </template>
  </WorkspaceScreen>
</template>

<style scoped>
.home-browser {
  display: grid;
  height: 100%;
  min-width: 0;
  min-height: 0;
  grid-template-columns: 174px minmax(0, 1fr);
  grid-template-rows: minmax(230px, 3fr) minmax(150px, 2fr);
  overflow: hidden;
  background: var(--md-sys-color-surface);
}

.home-browser__spots {
  grid-row: 1 / 3;
}

.home-browser__scene {
  position: relative;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

@media (max-width: 760px) {
  .home-browser {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: 103px minmax(170px, 0.9fr) minmax(0, 1.1fr);
  }

  .home-browser__spots {
    grid-row: auto;
  }
}
</style>
