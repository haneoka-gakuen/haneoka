<script setup lang="ts">
import { stripUnityMarkup } from "~/composables/useArchiveText";
import type { CapabilityDomain } from "~/config/capabilities";
import type { Band, StoryChapter, StoryEpisode } from "~/types/archive";
import { langOf, replaceDisplayText, textOf, type DisplayText } from "~/types/displayText";
import { entityAvatarText } from "~/utils/entityAvatar";
import type { FacetOption } from "~/components/ui/FacetGroup.vue";

type ImageExpander = (url: string | null | undefined) => readonly string[];

/** Source-neutral 3-pane chapter, episode stage, and filmstrip browser. */
const props = withDefaults(
  defineProps<{
    chapters: readonly StoryChapter[];
    episodes: Readonly<Record<string, StoryEpisode>>;
    bands?: readonly Band[];
    title: string;
    domain?: CapabilityDomain;
    /** Pass-through source identifiers for `StoryColumnWorkbench`. */
    catalogServer?: string;
    server?: string;
    /** Show the band `FacetGroup` filter (band section only). */
    enableBandFilter?: boolean;
    /** Optional source-defined chapter grouping (for example mixed-character events). */
    chapterFilterTitle?: string;
    chapterFilterOptions?: FacetOption[];
    chapterFilterValues?: Readonly<Record<string, string | number>>;
    pending?: boolean;
    error?: unknown;
    /** Optional source-specific image candidate expansion. */
    expandImage?: ImageExpander;
    /** Chapter covers in the rail preserve their source ratio by default. */
    chapterImageMode?: "fixed" | "natural";
    /** Normalizes source art without coupling the browser to a provider. */
    episodeImageMode?: "natural" | "cover" | "stretch-4x3" | "stretch-16x9";
    /** Some story sections intentionally expose only their staged grid workspace. */
    allowList?: boolean;
  }>(),
  {
    bands: () => [],
    domain: "catalog",
    enableBandFilter: false,
    chapterFilterOptions: () => [],
    chapterFilterValues: () => ({}),
    pending: false,
    chapterImageMode: "natural",
    episodeImageMode: "natural",
    allowList: true,
  },
);

const emit = defineEmits<{ refresh: [] }>();

const { resolveLocalized, localize, formatDate, compareText, t } = useLocale();
const selectedBandId = useRouteQueryNumber("band");
const selectedChapterFilter = useRouteQueryText("group");
const selectedChapterId = useRouteQueryNumber("chapter");
const previewEpisodeId = useRouteQueryText("preview");
const query = useRouteQueryText("q");
const storySortKeys = ["id", "title", "release", "duration"] as const;
const sort = useRouteQueryEnum("sort", storySortKeys, "id");
const order = useRouteQueryEnum("order", ["asc", "desc"] as const, "asc");
const routeView = useRouteQueryEnum("view", ["grid", "list"] as const, "grid");
const view = computed<"grid" | "list">({
  get: () => (props.allowList ? routeView.value : "grid"),
  set: (value) => {
    routeView.value = props.allowList ? value : "grid";
  },
});
const storyFilterSelections = computed(() => [
  ...(props.enableBandFilter ? [{ state: selectedBandId, defaultValue: undefined }] : []),
  ...(props.chapterFilterOptions.length ? [{ state: selectedChapterFilter, defaultValue: "" }] : []),
]);
const { activeFilterCount, resetFilters } = useCatalogFilterState({
  texts: [query],
  selections: storyFilterSelections,
});
const { selectedStoryId: openedEpisodeId, storyTo, closeStory } = useStoryWorkbenchSelection();
const filmstrip = ref<HTMLElement>();

const bandMap = computed(() => new Map(props.bands.map((band) => [band.bandId, band])));
const chapterGroups = computed(() => {
  const groups = new Map<number, StoryChapter[]>();
  for (const chapter of props.chapters) {
    const bandId = Number(chapter.bandId) || 0;
    const values = groups.get(bandId) || [];
    values.push(chapter);
    groups.set(bandId, values);
  }
  return [...groups.entries()]
    .map(([bandId, values]) => ({ bandId, band: bandMap.value.get(bandId), chapters: values }))
    .sort((left, right) => left.bandId - right.bandId);
});
const filteredChapters = computed(() =>
  props.chapters.filter((chapter) => {
    if (props.enableBandFilter && selectedBandId.value && Number(chapter.bandId) !== selectedBandId.value) return false;
    if (
      props.chapterFilterOptions.length &&
      selectedChapterFilter.value &&
      String(props.chapterFilterValues[chapter.chapterKey] ?? "") !== selectedChapterFilter.value
    )
      return false;
    return true;
  }),
);
const selectedChapter = computed(
  () =>
    filteredChapters.value.find((chapter) => chapter.chapterId === selectedChapterId.value) ||
    filteredChapters.value.find((chapter) =>
      chapter.episodes.includes(previewEpisodeId.value || openedEpisodeId.value),
    ) ||
    filteredChapters.value[0],
);
const selectedBand = computed(() => bandMap.value.get(Number(selectedChapter.value?.bandId) || 0));
const chapterEpisodeSource = computed(() =>
  (selectedChapter.value?.episodes || [])
    .map((id) => props.episodes[id])
    .filter((episode): episode is StoryEpisode => Boolean(episode)),
);
const chapterByStoryId = computed(() => {
  const result = new Map<string, StoryChapter>();
  for (const chapter of filteredChapters.value) {
    for (const storyId of chapter.episodes) {
      if (!result.has(storyId)) result.set(storyId, chapter);
    }
  }
  return result;
});
const allEpisodeSource = computed(() =>
  [...chapterByStoryId.value.keys()].flatMap((storyId) => {
    const episode = props.episodes[storyId];
    return episode ? [episode] : [];
  }),
);
const normalize = (value: unknown) =>
  String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase();
const publishedValue = (episode: StoryEpisode) =>
  episode.releaseAt ??
  Math.max(0, ...(episode.publishedAt || []).filter((value): value is number => typeof value === "number"));
const filterAndSortEpisodes = (source: readonly StoryEpisode[]) => {
  const needle = normalize(query.value);
  const direction = order.value === "asc" ? 1 : -1;
  return [...source]
    .filter(
      (episode) =>
        !needle ||
        normalize(
          [displayTitleOfEpisode(episode), displayDescriptionOf(episode), episode.storyId, episode.episodeNumber].join(
            " ",
          ),
        ).includes(needle),
    )
    .sort((left, right) => {
      let difference = left.storyId.localeCompare(right.storyId, "en", { numeric: true });
      if (sort.value === "title") difference = compareText(displayTitleOfEpisode(left), displayTitleOfEpisode(right));
      if (sort.value === "release") difference = publishedValue(left) - publishedValue(right);
      if (sort.value === "duration") difference = Number(left.playTime || 0) - Number(right.playTime || 0);
      return direction * (difference || left.storyId.localeCompare(right.storyId, "en", { numeric: true }));
    });
};
const chapterEpisodes = computed(() => filterAndSortEpisodes(chapterEpisodeSource.value));
const listEpisodes = computed(() => filterAndSortEpisodes(allEpisodeSource.value));
const selectedEpisode = computed(
  () =>
    chapterEpisodes.value.find((episode) => episode.storyId === (previewEpisodeId.value || openedEpisodeId.value)) ||
    chapterEpisodes.value[0],
);
// Filtering only controls the filmstrip. Keep a source episode staged when a
// query has no matches so the chapter workspace and its filters do not vanish.
const stageEpisode = computed(
  () =>
    selectedEpisode.value ||
    chapterEpisodeSource.value.find(
      (episode) => episode.storyId === (previewEpisodeId.value || openedEpisodeId.value),
    ) ||
    chapterEpisodeSource.value[0],
);
const playerEpisode = computed(() => props.episodes[openedEpisodeId.value]);
const isSingleChapter = computed(() => filteredChapters.value.length <= 1);

// Formatters mirror the encyclopedia band-stories page verbatim so the
// encyclopedia renders byte-identically through this shared component.
const titleOfEpisode = (episode: StoryEpisode) => localize(episode.title) || episode.storyId;
const displayTitleOfChapter = (chapter: StoryChapter): DisplayText =>
  resolveLocalized(chapter.chapterName, { sourceHint: "ja", fallback: String(chapter.chapterId) }) ||
  String(chapter.chapterId);
const displayTitleOfEpisode = (episode: StoryEpisode): DisplayText =>
  resolveLocalized(episode.title, { sourceHint: "ja", fallback: titleOfEpisode(episode) }) || titleOfEpisode(episode);
const displayDescriptionOf = (episode: StoryEpisode): DisplayText => {
  const resolved = resolveLocalized(episode.description, { sourceHint: "ja" });
  if (!resolved) return "";
  const value = stripUnityMarkup(textOf(resolved));
  return !value || /^Story_[A-Za-z0-9_]+$/.test(value) ? "" : replaceDisplayText(resolved, value);
};
const durationOf = (episode?: StoryEpisode) => {
  const seconds = Math.max(0, Math.floor(Number(episode?.playTime) || 0));
  return seconds ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}` : "";
};
const releaseOf = (episode?: StoryEpisode) => {
  const value = episode ? publishedValue(episode) : 0;
  return value ? formatDate(value) : "";
};

const sortOptions = computed(() => [
  { value: "id" as const, label: t("id"), icon: "tag" },
  { value: "title" as const, label: t("title"), icon: "text_fields" },
  { value: "release" as const, label: t("release"), icon: "calendar_month" },
  { value: "duration" as const, label: t("length"), icon: "schedule" },
]);
const listItems = computed(() =>
  listEpisodes.value.map((episode) => {
    const chapter = chapterByStoryId.value.get(episode.storyId);
    const band = bandMap.value.get(Number(chapter?.bandId) || 0);
    return {
      id: episode.storyId,
      title: displayTitleOfEpisode(episode),
      subtitle: chapter ? displayTitleOfChapter(chapter) : "",
      to: storyTo(episode.storyId),
      thumbnail: episode.banner || episode.image || chapter?.banner || chapter?.image,
      overlayImage: band?.logo || band?.icon,
      release: releaseOf(episode),
      duration: durationOf(episode),
    };
  }),
);

const bandOptions = computed(() =>
  chapterGroups.value.map((group) => {
    const label =
      resolveLocalized(group.band?.bandName, { sourceHint: "ja", fallback: String(group.bandId) }) ||
      String(group.bandId);
    return {
      value: group.bandId,
      label,
      image: group.band?.icon,
      imageFit: "cover" as const,
      avatarText: entityAvatarText(label),
      avatarLang: langOf(label),
      icon: group.band?.icon ? undefined : "music_note",
      color: group.band?.color,
      count: group.chapters.length,
    };
  }),
);
const selectedBandFacet = computed<Array<string | number>>(() => (selectedBandId.value ? [selectedBandId.value] : []));
const selectedChapterFilterFacet = computed<Array<string | number>>(() =>
  selectedChapterFilter.value ? [selectedChapterFilter.value] : [],
);
const chapterRailItems = computed(() =>
  filteredChapters.value.map((chapter) => {
    const band = bandMap.value.get(Number(chapter.bandId) || 0);
    return {
      id: chapter.chapterId,
      label: displayTitleOfChapter(chapter),
      meta: chapter.episodes.length,
      image: chapter.banner || chapter.image,
      fallbackImage: band?.logo || band?.icon,
      imageFit: chapter.banner || chapter.image ? ("cover" as const) : ("contain" as const),
      color: band?.color,
    };
  }),
);

watch(
  filteredChapters,
  (values) => {
    if (values.length && !values.some((chapter) => chapter.chapterId === selectedChapterId.value))
      selectedChapterId.value = selectedChapter.value?.chapterId;
  },
  { immediate: true },
);
watch(
  chapterEpisodes,
  (values) => {
    if (previewEpisodeId.value && !values.some((episode) => episode.storyId === previewEpisodeId.value))
      previewEpisodeId.value = "";
  },
  { immediate: true },
);
watch(
  () => selectedEpisode.value?.storyId,
  async (storyId) => {
    await nextTick();
    if (!storyId) return;
    const selected = filmstrip.value?.querySelector<HTMLElement>(`[data-story-id="${CSS.escape(storyId)}"]`);
    selected?.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
  },
);

const selectBand = (values: Array<string | number>) => {
  selectedBandId.value = Number(values.at(-1)) || undefined;
};
const selectChapterFilter = (values: Array<string | number>) => {
  selectedChapterFilter.value = String(values.at(-1) || "");
};
const selectChapter = (value: string | number) => {
  const chapter = filteredChapters.value.find((item) => item.chapterId === Number(value));
  if (chapter) selectedChapterId.value = chapter.chapterId;
};
</script>

<template>
  <CatalogCollectionScreen
    v-model:view="view"
    class="story-chapter-browser"
    :class="{ 'is-single-chapter': isSingleChapter }"
    :title="title"
    :count="view === 'list' ? listEpisodes.length : chapterEpisodes.length"
    :domain="domain"
    :filter-title="t('filter')"
    :pending="pending"
    :error="error"
    :empty="!chapters.length && !openedEpisodeId"
    :active-filter-count="activeFilterCount"
    :show-view-control="allowList"
    viewport-mode="stage"
    @retry="emit('refresh')"
    @reset-filters="resetFilters"
  >
    <template #content>
      <StoryColumnWorkbench
        :story-id="openedEpisodeId"
        :story-title="playerEpisode ? displayTitleOfEpisode(playerEpisode) : ''"
        :catalog-server="catalogServer"
        :server="server"
        @close="closeStory"
      >
        <div v-if="view === 'grid'" class="band-story-browser">
          <StoryMediaRail
            v-if="!isSingleChapter"
            class="band-story-browser__chapters"
            :items="chapterRailItems"
            :model-value="selectedChapter?.chapterId"
            :label="t('chapters')"
            :image-mode="chapterImageMode"
            :expand-image="expandImage"
            @update:model-value="selectChapter"
          />

          <StoryEpisodeStage
            v-if="selectedChapter && stageEpisode"
            :chapter="selectedChapter"
            :episode="stageEpisode"
            :band="selectedBand"
            :chapter-title="displayTitleOfChapter(selectedChapter)"
            :episode-title="displayTitleOfEpisode(stageEpisode)"
            :description="displayDescriptionOf(stageEpisode)"
            :release="releaseOf(stageEpisode)"
            :duration="durationOf(stageEpisode)"
            :to="storyTo(stageEpisode.storyId)"
            :expand-image="expandImage"
            :image-mode="episodeImageMode"
          />
          <EmptyState v-else />

          <nav ref="filmstrip" class="band-story-browser__filmstrip" :aria-label="t('episodes')">
            <template v-if="chapterEpisodes.length">
              <StoryEpisodeRow
                v-for="episode in chapterEpisodes"
                :key="episode.storyId"
                :episode="episode"
                :title="displayTitleOfEpisode(episode)"
                :duration="durationOf(episode)"
                :selected="episode.storyId === selectedEpisode?.storyId"
                :image-mode="episodeImageMode"
                :expand-image="expandImage"
                @select="previewEpisodeId = episode.storyId"
              />
            </template>
            <EmptyState v-else class="band-story-browser__filmstrip-empty" />
          </nav>
        </div>
        <StoryCatalogList
          v-else
          v-model:sort="sort"
          v-model:order="order"
          :items="listItems"
          media="thumbnail"
          layout="list"
          :selected-id="openedEpisodeId"
          :sortable-keys="storySortKeys"
          :show-cast="false"
        />
      </StoryColumnWorkbench>
    </template>

    <template #filters>
      <SearchField v-model="query" />
      <FacetGroup
        v-if="enableBandFilter"
        :title="t('band')"
        :options="bandOptions"
        :model-value="selectedBandFacet"
        single
        icon-only
        @update:model-value="selectBand"
      />
      <FacetGroup
        v-if="chapterFilterOptions.length"
        :title="chapterFilterTitle || t('filter')"
        :options="chapterFilterOptions"
        :model-value="selectedChapterFilterFacet"
        single
        icon-only
        @update:model-value="selectChapterFilter"
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

<style scoped>
.band-story-browser {
  display: grid;
  height: 100%;
  min-width: 0;
  min-height: 0;
  grid-template-columns: 174px minmax(0, 1fr);
  grid-template-rows: minmax(0, 1fr) auto;
  overflow: hidden;
  background: var(--md-sys-color-surface);
}

.band-story-browser__chapters {
  grid-row: 1 / 3;
}

.band-story-browser__filmstrip {
  position: relative;
  display: flex;
  min-width: 0;
  align-items: center;
  gap: var(--md-sys-spacing-3);
  padding: var(--md-sys-spacing-3) var(--md-sys-spacing-4);
  overflow-x: auto;
  overflow-y: hidden;
  border-top: 1px solid var(--md-sys-color-outline-variant);
  background: var(--md-sys-color-surface-container-low);
  overscroll-behavior-inline: contain;
  scroll-padding-inline: var(--md-sys-spacing-4);
  scrollbar-width: thin;
}

.band-story-browser__filmstrip :deep(.empty-state) {
  width: 100%;
  min-height: 0;
  flex: 1 1 auto;
  padding: var(--md-sys-spacing-3);
  background: transparent;
}

/* Single-chapter sections do not need a chapter rail. */
.is-single-chapter .band-story-browser {
  grid-template-columns: minmax(0, 1fr);
}

.is-single-chapter .band-story-browser__chapters {
  display: none;
}

@media (max-width: 760px) {
  .band-story-browser {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: 103px minmax(0, 1fr) auto;
  }

  .band-story-browser__chapters {
    grid-row: auto;
  }

  .band-story-browser__filmstrip {
    gap: 8px;
    padding: 10px;
  }

  .band-story-browser__filmstrip :deep(.episode-row) {
    width: 112px;
    flex-basis: 112px;
  }

  .is-single-chapter .band-story-browser {
    grid-template-rows: minmax(0, 1fr) auto;
  }
}
</style>
