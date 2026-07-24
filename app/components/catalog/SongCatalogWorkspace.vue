<script setup lang="ts">
import { MaterialIcon, UiIconButton } from "@haneoka/ui";

import type { Band, Character, Song, SongDifficulty, SongMetaByDifficulty, SongMetaChart } from "~/types/archive";
import { liveMusicTypeLabel, liveMusicTypeValues } from "~/config/liveMusic";
import { needsSongMeta } from "~/config/songMeta";
import { songTypeDefinition } from "~/config/songTypes";
import { resolveSongCatalogSource, songReleaseTimestamp, type SongCatalogSort } from "~/features/catalog/songSources";
import type { SongCreditVisualVariant } from "~/features/catalog/songCreditVisuals";
import type { CompositeEntityVisual } from "~/types/compositeVisual";

type ChartRuntimeMode = "chart" | "watch" | "play";

const props = withDefaults(defineProps<{ source?: string }>(), { source: "catalog" });

const songSortKeys = [
  "id",
  "title",
  "musicType",
  "band",
  "level",
  "time",
  "score",
  "eff",
  "bpm",
  "n",
  "nps",
  "sr",
  "category",
  "composer",
  "lyrics",
  "arrangement",
  "release",
] as const satisfies readonly SongCatalogSort[];
const sourceProfile = computed(() => resolveSongCatalogSource(props.source));
const catalogServer = computed(() => sourceProfile.value.catalogServer);
const maxDifficulty = computed(() => sourceProfile.value.maxDifficulty);
const screenTitleKey = computed(() => sourceProfile.value.titleKey);
const screenDomain = computed(() => sourceProfile.value.domain);

const { localize, resolveLocalized, locale, t, compareText } = useLocale();
const route = useRoute();
useSeoMeta({ title: () => `${t(screenTitleKey.value)} · haneoka` });
const { assetRoot, assetUrl } = useAssetServer();
const { playQueue, playSong } = useAudioPlayer();
const { ready: coverMemoryReady, rememberScroll, scrollPosition } = useWorkspaceMemory();
const { data: songRecord, pending, error, refresh } = useCatalogCollection<Song>("songs", catalogServer);
const { data: bandRecord } = useCatalogCollection<Band>("bands", catalogServer);
const { data: characterRecord } = useCatalogCollection<Character>("characters", catalogServer);

const query = useRouteQueryText("q");
const bandFilters = useRouteQueryList("band");
const musicTypeFilters = useRouteQueryList("musicType", true);
const categoryFilters = useRouteQueryList("category");
const songFilterFacets = computed(() => [
  bandFilters,
  ...(sourceProfile.value.showMusicTypeFilter ? [musicTypeFilters] : []),
  ...(sourceProfile.value.showCategoryFilter ? [categoryFilters] : []),
]);
const { activeFilterCount, resetFilters } = useCatalogFilterState({
  texts: [query],
  facets: songFilterFacets,
});
const sort = useRouteQueryEnum("sort", songSortKeys, sourceProfile.value.defaultSort ?? "id");
const order = useRouteQueryEnum("order", ["asc", "desc"] as const, "desc");
const view = useRouteQueryEnum("view", ["grid", "list"] as const, "grid");
const levelDifficulty = useRouteQueryEnum("levelDiff", ["easy", "normal", "hard", "expert"] as const, "expert");
const selectedId = useRouteQueryNumber("song");
const songLayer = useRouteQueryLayer("song", { clearOnClose: ["chart", "difficulty", "mv"] });
const chartLayer = useRouteQueryLayer("chart");
interface CatalogCollectionGridInstance {
  element?: HTMLElement;
  scrollToItem: (index: number, behavior?: ScrollBehavior) => void;
}

const coverGrid = ref<CatalogCollectionGridInstance>();
const COVER_GRID_MEMORY_KEY = "song-cover-grid";
let coverMemoryFrame = 0;
let coverScrollRestored = false;
const songMetaActive = computed(() => needsSongMeta(view.value, sort.value, selectedId.value));
const { data: songMetaRecord } = useLazyCatalogCollection<SongMetaByDifficulty>(
  "song-meta",
  songMetaActive,
  catalogServer,
);
const selectedDifficultyValue = useRouteQueryInteger("difficulty", 3, { min: 0, max: 4 });
const selectedDifficulty = computed<number>({
  get: () => Math.min(maxDifficulty.value, selectedDifficultyValue.value),
  set: (value) => {
    selectedDifficultyValue.value = Math.max(0, Math.min(maxDifficulty.value, Math.trunc(value)));
  },
});
const chartDifficultyQuery = useRouteQueryText("chart");
const chartRuntimeMode = ref<ChartRuntimeMode>("chart");
const chartDifficulty = computed<number | undefined>({
  get: () => {
    if (!chartDifficultyQuery.value) return undefined;
    const value = Number(chartDifficultyQuery.value);
    return Number.isInteger(value) && value >= 0 && value <= maxDifficulty.value ? value : undefined;
  },
  set: (value) => {
    chartDifficultyQuery.value = value === undefined ? "" : String(value);
  },
});
const renderedChartDifficulty = ref<number>();
const chartLayerMounted = ref(false);

const songs = computed(() => recordValues(songRecord.value));
const bands = computed(() => recordValues(bandRecord.value));
const characters = computed(() => recordValues(characterRecord.value));
const bandMap = computed(() => new Map(bands.value.map((band) => [band.bandId, band])));
const characterMap = computed(() => new Map(characters.value.map((character) => [character.characterId, character])));
const creditResolver = useSongCreditVisualResolver();
const creditSource = computed(() => catalogServer.value || "jp-cbt");
const creditIdentityOf = (song: Song) => creditResolver.value.identity(song, creditSource.value);
const contributingBandIdsOf = (song: Song): number[] => creditIdentityOf(song).bandIds;
const guestCharacterIdsOf = (song: Song): number[] => creditIdentityOf(song).characterIds;
const creditSignatureOf = (song: Song): string => `credit:${creditResolver.value.songKey(song, creditSource.value)}`;
const isCompositeCredit = (song: Song): boolean =>
  contributingBandIdsOf(song).length > 1 ||
  guestCharacterIdsOf(song).length > 0 ||
  creditIdentityOf(song).memberNames.length > 0;
const creditVisualsOf = (song: Song, variant: SongCreditVisualVariant = "logo"): CompositeEntityVisual[] =>
  creditResolver.value.song(song, creditSource.value, variant);
const creditLabelOf = (song: Song): string => {
  const authored = localize(song.artistName);
  if (authored) return authored;
  const sourceBand = bandMap.value.get(song.bandId || 0);
  // Bestdori stores soloists and collaborations as synthetic bands whose
  // bandName is the source-authored credit. Keep that text verbatim instead
  // of rebuilding it from inferred members and changing its wording.
  if (sourceBand?.official === false) return localize(sourceBand.bandName);
  return [
    ...contributingBandIdsOf(song).map((bandId) => localize(bandMap.value.get(bandId)?.bandName)),
    ...guestCharacterIdsOf(song).map((characterId) => localize(characterMap.value.get(characterId)?.characterName)),
  ]
    .filter(Boolean)
    .join(" × ");
};

const titleOf = (song: Song) => localize(song.musicTitle) || String(song.musicId);
const bandOf = (song: Song) => creditLabelOf(song) || localize(bandMap.value.get(song.bandId || 0)?.bandName);
const displayTitleOf = (song: Song) =>
  resolveLocalized(song.musicTitle, {
    sourceHint: "ja",
    fallback: String(song.musicId),
  }) || titleOf(song);
const displayBandOf = (song: Song) => {
  const authored = resolveLocalized(song.artistName, { sourceHint: "ja", fallback: creditLabelOf(song) });
  if (authored) return authored;
  const band = bandMap.value.get(song.bandId || 0);
  return resolveLocalized(band?.bandName, { sourceHint: "ja", fallback: bandOf(song) }) || bandOf(song);
};
const bandIconOf = (song: Song) => creditVisualsOf(song, "icon")[0]?.image;
const categorySortKey = (song: Song) =>
  sourceProfile.value.categorySortKey?.(song) ?? String(Number(song.musicCategories?.[0] || 99)).padStart(3, "0");
const levelDifficultyIndex = computed(() => ["easy", "normal", "hard", "expert"].indexOf(levelDifficulty.value));
const levelOf = (song: Song, index: number) => {
  const difficulty = song.difficulty?.[index];
  return difficulty ? Number(difficulty.sortLevel ?? difficulty.displayLevel ?? difficulty.playLevel ?? -1) : -1;
};
const chartDifficultyName = difficultyNameOf;
const chartDifficultyLevel = (difficulty: SongDifficulty) =>
  Math.trunc(Number(difficulty.displayLevel ?? difficulty.playLevel ?? 0)) || undefined;
const difficultySemanticColor = (difficulty: SongDifficulty, index: number) => {
  const knownDifficulties = ["easy", "normal", "hard", "expert", "special", "master"] as const;
  const raw = String(difficulty.difficulty || chartDifficultyName(difficulty, index)).toLowerCase();
  const key = knownDifficulties.find((difficultyKey) => difficultyKey === raw) || knownDifficulties[index] || "master";
  return `var(--md-extended-color-difficulty-${key === "special" ? "master" : key})`;
};
const metaOf = (song: Song, index: number): SongMetaChart | undefined =>
  songMetaRecord.value?.[String(song.musicId)]?.[String(index)]?.chart;
const activeSortDifficulty = computed(() =>
  view.value === "list" ? selectedDifficulty.value : levelDifficultyIndex.value,
);

const compareNullable = (left: number | null | undefined, right: number | null | undefined, direction: number) => {
  const leftValid = left != null && Number.isFinite(left);
  const rightValid = right != null && Number.isFinite(right);
  if (!leftValid && !rightValid) return 0;
  if (!leftValid) return 1;
  if (!rightValid) return -1;
  return direction * (left - right);
};

const matchesBandFilter = (song: Song, rawFilter: string | number): boolean => {
  const filter = String(rawFilter);
  if (filter.startsWith("credit:")) return creditSignatureOf(song) === filter;
  if (filter.startsWith("source-credit:")) {
    const sourceBand = bandMap.value.get(song.bandId || 0);
    return (
      sourceBand?.official === false &&
      `source-credit:${creditResolver.value.bandCreditKey(sourceBand, creditSource.value)}` === filter
    );
  }
  const bandId = Number(filter);
  if (!Number.isInteger(bandId) || bandId <= 0) return false;
  const selectedBand = bandMap.value.get(bandId);
  if (selectedBand?.official === false) return song.bandId === bandId;
  return contributingBandIdsOf(song).includes(bandId);
};

const filteredSongs = computed(() => {
  const needle = query.value.trim().toLocaleLowerCase();
  const output = songs.value.filter((song) => {
    if (needle && !`${titleOf(song)} ${bandOf(song)} ${song.musicId}`.toLocaleLowerCase().includes(needle))
      return false;
    if (bandFilters.value.length && !bandFilters.value.some((filter) => matchesBandFilter(song, filter))) return false;
    if (
      sourceProfile.value.showMusicTypeFilter &&
      musicTypeFilters.value.length &&
      !musicTypeFilters.value.includes(song.musicType)
    )
      return false;
    if (
      sourceProfile.value.showCategoryFilter &&
      categoryFilters.value.length &&
      !song.musicCategories?.some((id) => categoryFilters.value.includes(String(id)))
    )
      return false;
    return true;
  });

  return output.sort((left, right) => {
    const direction = order.value === "asc" ? 1 : -1;
    if (sort.value === "title")
      return direction * (compareText(titleOf(left), titleOf(right)) || left.musicId - right.musicId);
    if (sort.value === "musicType") {
      return direction * (left.musicType - right.musicType || left.musicId - right.musicId);
    }
    if (sort.value === "band") {
      return direction * ((left.bandId || 0) - (right.bandId || 0) || left.musicId - right.musicId);
    }
    if (sort.value === "category") {
      return direction * (categorySortKey(left).localeCompare(categorySortKey(right)) || left.musicId - right.musicId);
    }
    if (sort.value === "composer") {
      return (
        direction * (compareText(localize(left.composer), localize(right.composer)) || left.musicId - right.musicId)
      );
    }
    if (sort.value === "lyrics") {
      return (
        direction * (compareText(localize(left.lyricist), localize(right.lyricist)) || left.musicId - right.musicId)
      );
    }
    if (sort.value === "arrangement") {
      return (
        direction * (compareText(localize(left.arranger), localize(right.arranger)) || left.musicId - right.musicId)
      );
    }
    if (sort.value === "release") {
      return (
        compareNullable(songReleaseTimestamp(left), songReleaseTimestamp(right), direction) ||
        direction * (left.musicId - right.musicId)
      );
    }
    if (sort.value === "level") {
      return (
        direction *
        (levelOf(left, activeSortDifficulty.value) - levelOf(right, activeSortDifficulty.value) ||
          left.musicId - right.musicId)
      );
    }
    if (["time", "score", "eff", "bpm", "n", "nps", "sr"].includes(sort.value)) {
      const key = sort.value as "time" | "score" | "eff" | "bpm" | "n" | "nps" | "sr";
      const leftMeta = metaOf(left, activeSortDifficulty.value);
      const rightMeta = metaOf(right, activeSortDifficulty.value);
      return (
        compareNullable(
          key === "bpm" ? songBpmSortValue(leftMeta) : leftMeta?.[key],
          key === "bpm" ? songBpmSortValue(rightMeta) : rightMeta?.[key],
          direction,
        ) || direction * (left.musicId - right.musicId)
      );
    }
    return direction * (left.musicId - right.musicId);
  });
});

const selectedSong = computed(() => filteredSongs.value.find((song) => song.musicId === selectedId.value));
const selectedDetailPath = computed(() => selectedSong.value?.musicId);
const { data: selectedDetail } = useCatalogSelection<Song>("songs", selectedDetailPath, catalogServer);
const activeDetailSong = computed(() => {
  if (!selectedSong.value) return selectedDetail.value;
  return selectedDetail.value?.musicId === selectedSong.value.musicId ? selectedDetail.value : selectedSong.value;
});
const renderedDetailSong = shallowRef<Song>();
const detailLayerMounted = ref(false);
watch(
  activeDetailSong,
  (song) => {
    if (!song || selectedId.value === undefined) return;
    renderedDetailSong.value = song;
    detailLayerMounted.value = true;
  },
  { immediate: true },
);
const detailSong = computed(() => activeDetailSong.value || renderedDetailSong.value);
const detailOpen = computed(() => Boolean(selectedSong.value));
const selectedMeta = computed(() =>
  detailSong.value ? metaOf(detailSong.value, selectedDifficulty.value) : undefined,
);
const chartDifficultyOptions = computed(() =>
  (detailSong.value?.difficulty || []).map((difficulty, index) => {
    const name = chartDifficultyName(difficulty, index);
    const level = chartDifficultyLevel(difficulty);
    return {
      value: index,
      label: level === undefined ? name : String(level),
      ariaLabel: level === undefined ? name : `${name} ${level}`,
      semanticColor: difficultySemanticColor(difficulty, index),
      selectedIcon: "check",
    };
  }),
);
const selectedScoreRankThresholds = computed(() =>
  [...(detailSong.value?.scoreRanks || [])]
    .filter((rank) => Number(rank.scoreRank || 0) >= 3)
    .sort((left, right) => Number(left.scoreRank || 0) - Number(right.scoreRank || 0))
    .map((rank) => Number(rank.requiredScore || 0)),
);
const chartOpen = computed(
  () =>
    Boolean(detailSong.value) &&
    chartDifficulty.value !== undefined &&
    Boolean(detailSong.value?.difficulty?.[chartDifficulty.value]),
);
const chartDifficultyData = computed(() =>
  renderedChartDifficulty.value === undefined
    ? undefined
    : detailSong.value?.difficulty?.[renderedChartDifficulty.value],
);
const chartFile = computed(() => {
  if (!chartLayerMounted.value) return "";
  const file = chartDifficultyData.value?.file;
  if (!file) return "";
  return sourceProfile.value.resolveChartUrl?.(file, assetUrl) ?? assetUrl(file);
});
const {
  chart,
  pending: chartPending,
  error: chartError,
  refresh: loadChart,
  reset: resetChart,
  rotation: chartRotation,
} = useChartPreview(chartFile);

watch(
  [chartOpen, chartDifficulty],
  ([open, difficulty]) => {
    if (!open || difficulty === undefined) return;
    renderedChartDifficulty.value = difficulty;
    chartLayerMounted.value = true;
  },
  { immediate: true },
);
watch(
  [filteredSongs, pending],
  ([value, isPending]) => {
    if (!isPending && selectedId.value !== undefined && !value.some((song) => song.musicId === selectedId.value)) {
      selectedId.value = undefined;
    }
  },
  { immediate: true },
);
watch(
  maxDifficulty,
  (maximum) => {
    if (selectedDifficultyValue.value > maximum) selectedDifficultyValue.value = maximum;
    if (chartDifficulty.value !== undefined && chartDifficulty.value > maximum) chartDifficulty.value = undefined;
  },
  { immediate: true },
);
watch(selectedId, (id) => {
  if (id === undefined && chartDifficulty.value !== undefined) {
    chartDifficulty.value = undefined;
  }
});

const selectSong = (song: Song) => {
  void songLayer.open(song.musicId);
};

const coverSongKey = (song: Song) => song.musicId;
const coverGridRowHeight = (width: number) => width + 66;

const rememberCoverScroll = () => {
  const element = coverGrid.value?.element;
  if (!element || !coverMemoryReady.value) return;
  rememberScroll(route.path, COVER_GRID_MEMORY_KEY, { left: element.scrollLeft, top: element.scrollTop });
};

const scheduleCoverScrollMemory = () => {
  if (coverMemoryFrame) return;
  coverMemoryFrame = requestAnimationFrame(() => {
    coverMemoryFrame = 0;
    rememberCoverScroll();
  });
};

const restoreCoverScroll = async () => {
  if (coverScrollRestored || !coverMemoryReady.value || !filteredSongs.value.length || !coverGrid.value?.element)
    return;
  await nextTick();
  const remembered = scrollPosition(route.path, COVER_GRID_MEMORY_KEY);
  const element = coverGrid.value?.element;
  if (!element) return;
  coverScrollRestored = true;
  if (remembered) element.scrollTo({ left: remembered.left, top: remembered.top });
};

watch([coverMemoryReady, () => filteredSongs.value.length, view], restoreCoverScroll, { immediate: true });
onMounted(() => void restoreCoverScroll());
watch(selectedId, async (id, previousId) => {
  if (id === undefined || id === previousId || view.value !== "grid") return;
  await nextTick();
  coverGrid.value?.scrollToItem(
    filteredSongs.value.findIndex((song) => song.musicId === id),
    "smooth",
  );
});
onBeforeUnmount(() => {
  if (coverMemoryFrame) cancelAnimationFrame(coverMemoryFrame);
  rememberCoverScroll();
});
const closeDetail = () => {
  void songLayer.close();
};
const afterDetailLeave = () => {
  if (detailOpen.value) return;
  detailLayerMounted.value = false;
  renderedDetailSong.value = undefined;
};
const selectSongDifficulty = (difficulty: number) => {
  selectedDifficulty.value = difficulty;
};
const openChart = async (song: Song, difficulty = selectedDifficulty.value) => {
  if (selectedId.value !== song.musicId) return;
  await chartLayer.open(difficulty, {
    song: String(song.musicId),
    difficulty: difficulty === 3 ? undefined : String(difficulty),
  });
  chartRuntimeMode.value = "chart";
};
const closeChart = () => {
  void chartLayer.close();
};
const afterChartLeave = () => {
  if (chartOpen.value) return;
  chartLayerMounted.value = false;
  renderedChartDifficulty.value = undefined;
  chartRuntimeMode.value = "chart";
  resetChart();
};
const selectChartDifficulty = (difficulty: number) => {
  selectedDifficulty.value = difficulty;
  chartDifficulty.value = difficulty;
};
const selectChartDifficultyValue = (value: string | number) => {
  const difficulty = Number(value);
  if (Number.isInteger(difficulty)) selectChartDifficulty(difficulty);
};
const playFromCollection = async (song: Song) => {
  await playSong(
    song,
    displayTitleOf(song),
    displayBandOf(song),
    bandIconOf(song),
    Number(song.bandId || 0),
    creditVisualsOf(song),
    sourceProfile.value.id,
  );
};
const playableQueue = computed(() =>
  filteredSongs.value.flatMap((song) => {
    const track = audioTrackFromSong(
      song,
      displayTitleOf(song),
      displayBandOf(song),
      bandIconOf(song),
      Number(song.bandId || 0),
      creditVisualsOf(song),
      sourceProfile.value.id,
    );
    return track ? [track] : [];
  }),
);
const playAllFromCollection = async () => {
  if (playableQueue.value.length) await playQueue(playableQueue.value);
};

const bandOptions = computed(() => {
  const formalBands = bands.value
    .filter((band) => band.official !== false)
    .sort((left, right) => left.bandId - right.bandId);
  const sourceCredits = bands.value
    .filter((band) => band.official === false)
    .sort((left, right) => left.bandId - right.bandId);
  const formalOptions = formalBands.map((band) => {
    const visuals = creditResolver.value.bandCredit(band, creditSource.value, "icon");
    const label =
      resolveLocalized(band.bandName, { sourceHint: "ja", fallback: String(band.bandId) }) || String(band.bandId);
    return {
      value: String(band.bandId),
      label,
      color: band.color,
      visuals,
      count: songs.value.filter((song) => contributingBandIdsOf(song).includes(band.bandId)).length,
    };
  });
  const sourceOptionMap = new Map<
    string,
    { value: string; label: string; color?: string; visuals: CompositeEntityVisual[]; count: number }
  >();
  for (const band of sourceCredits) {
    const key = creditResolver.value.bandCreditKey(band, creditSource.value);
    const value = `source-credit:${key}`;
    const existing = sourceOptionMap.get(value);
    const count = songs.value.filter((song) => song.bandId === band.bandId).length;
    if (existing) {
      existing.count += count;
      continue;
    }
    sourceOptionMap.set(value, {
      value,
      label: localize(band.bandName) || String(band.bandId),
      color: band.color,
      visuals: creditResolver.value.bandCredit(band, creditSource.value, "icon"),
      count,
    });
  }

  const derivedCredits = new Map<
    string,
    { value: string; label: string; visuals: CompositeEntityVisual[]; count: number; firstMusicId: number }
  >();
  for (const song of songs.value) {
    const sourceBand = bandMap.value.get(song.bandId || 0);
    if (sourceBand?.official === false || !isCompositeCredit(song)) continue;
    const value = creditSignatureOf(song);
    const existing = derivedCredits.get(value);
    if (existing) {
      existing.count += 1;
      existing.firstMusicId = Math.min(existing.firstMusicId, song.musicId);
      continue;
    }
    derivedCredits.set(value, {
      value,
      label: creditLabelOf(song) || String(song.musicId),
      visuals: creditVisualsOf(song, "icon"),
      count: 1,
      firstMusicId: song.musicId,
    });
  }
  return [
    ...formalOptions,
    ...sourceOptionMap.values(),
    ...[...derivedCredits.values()]
      .sort((left, right) => left.firstMusicId - right.firstMusicId || compareText(left.label, right.label))
      .map(({ firstMusicId: _firstMusicId, ...option }) => option),
  ];
});
const musicTypeOptions = computed(() =>
  liveMusicTypeValues.map((musicType) => ({
    value: musicType,
    label: liveMusicTypeLabel(musicType, locale.value),
    count: songs.value.filter((song) => song.musicType === musicType).length,
  })),
);
const categoryOptions = computed(() =>
  [...new Set(songs.value.flatMap((song) => song.musicCategories || []))].map((category) => {
    const definition = songTypeDefinition(category, locale.value);
    return {
      value: String(category),
      label: definition.label,
      color: definition.color,
      icon: definition.icon,
      count: songs.value.filter((song) => song.musicCategories?.includes(category)).length,
    };
  }),
);
const difficultyOptions = computed(() =>
  ["easy", "normal", "hard", "expert"].map((difficulty) => ({
    value: difficulty as "easy" | "normal" | "hard" | "expert",
    label: difficulty.toLocaleUpperCase(),
    image: `${assetRoot.value}/Assets/AddressableResources/UI/Texture/Tmp1/${difficulty.toLocaleUpperCase()}.png`,
    semanticColor: `var(--md-extended-color-difficulty-${difficulty})`,
  })),
);
const tableColumns = useSongTableColumns();
const sortOptions = useCatalogSortOptions<SongCatalogSort>(tableColumns);
const setTableSort = (value: string) => {
  if ((songSortKeys as readonly string[]).includes(value)) sort.value = value as SongCatalogSort;
};
</script>

<template>
  <CatalogCollectionScreen
    v-model:view="view"
    class="song-catalog"
    :domain="screenDomain"
    :title="t(screenTitleKey)"
    :count="filteredSongs.length"
    :pending="pending"
    :error="error"
    :empty="!filteredSongs.length"
    :active-filter-count="activeFilterCount"
    :show-view-control="!chartOpen"
    viewport-mode="stage"
    @retry="refresh()"
    @reset-filters="resetFilters"
  >
    <template v-if="!chartOpen" #before-view-actions>
      <UiIconButton
        :label="t('communityPage.playlistPage.playAll')"
        :disabled="!playableQueue.length"
        @click="playAllFromCollection"
      >
        <MaterialIcon name="playlist_play" :size="20" />
      </UiIconButton>
    </template>

    <template v-if="!chartOpen" #filters>
      <SearchField v-model="query" :label="t('search')" />
      <FacetGroup v-model="bandFilters" :title="t('band')" :options="bandOptions" icon-only />
      <FacetGroup
        v-if="sourceProfile.showMusicTypeFilter"
        v-model="musicTypeFilters"
        :title="t('musicType')"
        :options="musicTypeOptions"
        mark="attribute"
        attribute-variant="live"
        icon-only
      />
      <FacetGroup
        v-if="sourceProfile.showCategoryFilter"
        v-model="categoryFilters"
        :title="t('genre')"
        :options="categoryOptions"
        icon-only
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
      <fieldset v-if="view === 'grid' && sort === 'level'" class="song-level-difficulty">
        <legend class="meta-label">{{ t("difficulty") }}</legend>
        <SegmentedControl v-model="levelDifficulty" :options="difficultyOptions" :label="t('difficulty')" icon-only />
      </fieldset>
    </template>

    <template #content>
      <div class="songs-stage">
        <CatalogCollectionGrid
          v-if="view === 'grid'"
          ref="coverGrid"
          :items="filteredSongs"
          :item-key="coverSongKey"
          :label="t('songs')"
          :minimum-column-width="126"
          :compact-minimum-column-width="108"
          :estimate-row-height="coverGridRowHeight"
          :selected-key="selectedSong?.musicId"
          :scroll-key="COVER_GRID_MEMORY_KEY"
          @scroll="scheduleCoverScrollMemory"
        >
          <template #item="{ item: song }">
            <SongCatalogTile
              :song="song"
              :title="displayTitleOf(song)"
              :band="displayBandOf(song)"
              :image="song.jacketUrl || song.jacketThumbUrl"
              :thumbnail-image="song.jacketThumbUrl || song.jacketUrl"
              :music-type="song.musicType"
              :categories="song.musicCategories"
              :credit-source="catalogServer || 'jp-cbt'"
              :selected="song.musicId === selectedId"
              @select="selectSong(song)"
            />
          </template>
        </CatalogCollectionGrid>
        <VirtualCollectionTable
          v-else
          class="song-list"
          :items="filteredSongs"
          :item-key="coverSongKey"
          :label="t('songs')"
          :columns="tableColumns"
          :sort="sort"
          :order="order"
          :row-height="64"
          :selected-key="selectedSong?.musicId"
          scroll-key="song-list"
          @update:sort="setTableSort"
          @update:order="order = $event"
        >
          <template #row="{ item: song, index, style }">
            <SongRow
              :style="style"
              :song="song"
              :title="displayTitleOf(song)"
              :band="displayBandOf(song)"
              :credit-source="catalogServer || 'jp-cbt'"
              :selected="song.musicId === selectedSong?.musicId"
              :difficulty="selectedDifficulty"
              :meta="metaOf(song, selectedDifficulty)"
              :row-index="index"
              @select="selectSong(song)"
              @difficulty="selectSongDifficulty"
              @play="playFromCollection(song)"
              @chart="openChart(song)"
            />
          </template>
        </VirtualCollectionTable>

        <LazySongDetailPanel
          v-if="detailLayerMounted && detailSong"
          v-model:difficulty="selectedDifficulty"
          :open="detailOpen"
          :song="detailSong"
          :title="displayTitleOf(detailSong)"
          :band-name="displayBandOf(detailSong)"
          :credit-source="creditSource"
          :meta="selectedMeta"
          :hide-sonolus="sourceProfile.hideSonolus"
          :covered="chartLayerMounted"
          @close="closeDetail"
          @after-leave="afterDetailLeave"
          @play="playFromCollection(detailSong)"
          @chart="openChart(detailSong, $event)"
        />
      </div>

      <SongChartWorkbench
        v-if="chartLayerMounted && detailSong && renderedChartDifficulty !== undefined"
        v-model:mode="chartRuntimeMode"
        :open="chartOpen"
        :title="displayTitleOf(detailSong)"
        :difficulty="renderedChartDifficulty"
        :difficulty-options="chartDifficultyOptions"
        @update:difficulty="selectChartDifficultyValue"
        @close="closeChart"
        @after-leave="afterChartLeave"
      >
        <div class="song-chart-window__stage">
          <LoadingState v-if="chartPending" />
          <ErrorState v-else-if="chartError || !chart" @retry="loadChart" />
          <ClientOnly v-else>
            <RotatableViewport v-model:rotation="chartRotation" :controls="false">
              <LazyChartRuntime
                :key="`${detailSong.musicId}:${renderedChartDifficulty}`"
                v-model:mode="chartRuntimeMode"
                v-model:rotation="chartRotation"
                :chart="chart"
                :audio-url="detailSong.musicUrl"
                :score-ranks="selectedScoreRankThresholds"
              />
            </RotatableViewport>
            <template #fallback><LoadingState /></template>
          </ClientOnly>
        </div>
      </SongChartWorkbench>
    </template>
  </CatalogCollectionScreen>
</template>

<style scoped>
.song-chart-window__stage {
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: var(--md-comp-runtime-scene-surface);
}

.song-chart-window__stage > :deep(*) {
  width: 100%;
  height: 100%;
}
</style>
