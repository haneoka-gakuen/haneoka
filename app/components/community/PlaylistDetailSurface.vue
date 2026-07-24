<script setup lang="ts">
import { MaterialIcon, UiButton } from "@haneoka/ui";

import type { AudioTrack } from "~/composables/useAudioPlayer";
import type { Song, SongDifficulty, SongMetaByDifficulty, SongMetaChart } from "~/types/archive";
import type { CatalogContentOrigin } from "~/features/catalog/contentSource";
import type { ResolvedPlaylistTrack } from "~/types/playlists";
import {
  bestdoriOrigin,
  contentOriginKey,
  isBestdoriOrigin,
  ourNotesReleaseOrigin,
  runtimeReleaseForCatalogOrigin,
} from "~/features/catalog/contentSource";
import { langOf, textOf } from "~/types/displayText";
import { resolveSongCatalogSource, songReleaseTimestamp, type SongCatalogSort } from "~/features/catalog/songSources";

type ChartRuntimeMode = "chart" | "watch" | "play";

const props = defineProps<{
  open: boolean;
  playlistId: string;
}>();
const emit = defineEmits<{
  close: [];
  afterLeave: [];
}>();
const { t, formatDate, localize, compareText } = useLocale();
const { assetUrl, releaseServer, fallbackReleaseServers } = useReleaseServer();
const { playQueue } = useAudioPlayer();
const { data: playlists, pending, error, refresh } = usePlaylistCatalog();
const selectedReleaseMetaOrigin = computed(() => ourNotesReleaseOrigin(releaseServer.value));
const selectedReleaseMeta = useCatalogCollection<SongMetaByDifficulty>("song-meta", selectedReleaseMetaOrigin);
const configuredReleaseIds = [
  ...new Set(fallbackReleaseServers.value.map((value) => String(value).trim()).filter(Boolean)),
];
const releaseMetaRequests = configuredReleaseIds.map((releaseId) => {
  const origin = ourNotesReleaseOrigin(releaseId);
  return { origin, request: useCatalogCollection<SongMetaByDifficulty>("song-meta", origin) };
});
const bestdoriMetaOrigin = bestdoriOrigin("jp");
const { data: bestdoriMeta } = useCatalogCollection<SongMetaByDifficulty>("song-meta", bestdoriMetaOrigin);
const tableColumns = useSongTableColumns({ includeSource: true });
const difficulty = useRouteQueryInteger("difficulty", 3, { min: 0, max: 4 });
const selectedSongId = useRouteQueryNumber("song");
const selectedSongSource = useRouteQueryText("songSource");
const chartDifficultyQuery = useRouteQueryText("chart");
const songLayer = useRouteQueryLayer("song", { clearOnClose: ["chart", "difficulty", "songSource"] });
const chartLayer = useRouteQueryLayer("chart");
const sort = ref<SongCatalogSort | "source">("id");
const order = ref<"asc" | "desc">("asc");
const playlistId = computed(() => props.playlistId);
const playlist = computed(() => playlists.value.find((candidate) => candidate.id === playlistId.value));
const originKey = (origin: CatalogContentOrigin | null): string => (origin ? contentOriginKey(origin) : "");
const selectedTrack = computed(() => {
  if (selectedSongId.value === undefined) return undefined;
  return playlist.value?.tracks.find(
    (item) =>
      item.song?.musicId === selectedSongId.value &&
      (!selectedSongSource.value || originKey(item.origin) === selectedSongSource.value),
  );
});
const renderedTrack = shallowRef<ResolvedPlaylistTrack>();
const songLayerMounted = ref(false);
const detailOpen = computed(() => Boolean(props.open && selectedTrack.value));
watch(
  selectedTrack,
  (item) => {
    if (!item || selectedSongId.value === undefined) return;
    renderedTrack.value = item;
    songLayerMounted.value = true;
  },
  { immediate: true },
);
const detailTrack = computed(() => selectedTrack.value || renderedTrack.value);
// Playlist tracks retain their source provenance. Bestdori only provides the
// chart; native renderer artwork deliberately falls back to the selected
// Our Notes release instead of treating its `jp` region as a release slug.
const chartRuntimeRelease = computed(() =>
  runtimeReleaseForCatalogOrigin(detailTrack.value?.origin, releaseServer.value),
);
const pageTitle = computed(() =>
  playlist.value
    ? textOf(playlist.value.titleText)
    : pending.value
      ? t("communityPage.playlistPage.title")
      : t("communityPage.playlistPage.notFound"),
);
const detailPath = computed(() => `/community/playlists/${encodeURIComponent(playlistId.value)}`);
const playable = (item: ResolvedPlaylistTrack) => Boolean(item.origin && item.song?.musicUrl);
const queueId = (item: ResolvedPlaylistTrack) =>
  `${playlistId.value}:${item.position}:${originKey(item.origin)}:${item.song?.musicId || item.definition.musicId}`;
const audioTrack = (item: ResolvedPlaylistTrack): AudioTrack | null => {
  if (!item.origin || !item.song?.musicUrl) return null;
  return {
    kind: "song",
    queueId: queueId(item),
    origin: item.origin,
    detailPath: detailPath.value,
    id: item.song.musicId,
    title: item.title,
    band: item.artist,
    bandId: item.song.bandId,
    bandIcon: item.bandVisuals[0]?.image,
    bandVisuals: item.bandVisuals,
    cover: item.song.jacketUrl || item.song.jacketThumbUrl || "",
    source: item.song.musicUrl,
  };
};
const playableQueue = computed(() =>
  sortedTracks.value.flatMap((item) => {
    const audio = audioTrack(item);
    return audio ? [audio] : [];
  }),
);
const trackKey = (item: ResolvedPlaylistTrack) =>
  `${item.position}:${originKey(item.origin)}:${item.song?.musicId || item.definition.musicId}`;
const metaOf = (item: ResolvedPlaylistTrack): SongMetaChart | undefined => {
  const origin = item.origin;
  if (!origin || !item.song) return undefined;
  const record = isBestdoriOrigin(origin)
    ? bestdoriMeta.value
    : origin.releaseId === selectedReleaseMetaOrigin.value.releaseId
      ? selectedReleaseMeta.data.value
      : releaseMetaRequests.find((request) => request.origin.releaseId === origin.releaseId)?.request.data.value;
  return record?.[String(item.song.musicId)]?.[String(difficulty.value)]?.chart;
};
const openSong = async (item: ResolvedPlaylistTrack, chart = false) => {
  if (!item.origin || !item.song) return;
  const songPatch = {
    songSource: originKey(item.origin),
    difficulty: difficulty.value === 3 ? undefined : String(difficulty.value),
  };
  await songLayer.open(item.song.musicId, songPatch);
  if (chart) {
    await chartLayer.open(difficulty.value, {
      song: String(item.song.musicId),
      ...songPatch,
    });
  }
};
const playFrom = async (item: ResolvedPlaylistTrack) => {
  if (!playable(item)) return;
  const queueIndex = playableQueue.value.findIndex((candidate) => candidate.queueId === queueId(item));
  if (queueIndex >= 0) await playQueue(playableQueue.value, queueIndex);
};
const playAll = async () => {
  if (playableQueue.value.length) await playQueue(playableQueue.value, 0);
};
const sourceLabel = (item: ResolvedPlaylistTrack) =>
  !item.origin
    ? t("communityPage.playlistPage.masterUnavailable")
    : isBestdoriOrigin(item.origin)
      ? t("communityPage.playlistPage.sourceBestdori")
      : t("communityPage.playlistPage.sourceCatalog");
const compareNullable = (left: number | null | undefined, right: number | null | undefined, direction: number) => {
  const leftValid = left != null && Number.isFinite(left);
  const rightValid = right != null && Number.isFinite(right);
  if (!leftValid && !rightValid) return 0;
  if (!leftValid) return 1;
  if (!rightValid) return -1;
  return direction * (left - right);
};
const difficultyLevel = (item: ResolvedPlaylistTrack) => {
  const entry = item.song?.difficulty?.[difficulty.value];
  return Number(entry?.sortLevel ?? entry?.displayLevel ?? entry?.playLevel);
};
const categorySortKey = (item: ResolvedPlaylistTrack) =>
  String(Number(item.song?.musicCategories?.[0] || 99)).padStart(3, "0");
const displaySong = (item: ResolvedPlaylistTrack): Song =>
  item.song || {
    musicId: item.definition.musicId,
    musicTitle: item.definition.title || `Music ${item.definition.musicId}`,
    musicCategories: [],
    musicType: 99,
  };
const releaseTimestamp = (item: ResolvedPlaylistTrack) => (item.song ? songReleaseTimestamp(item.song) : undefined);
const sortedTracks = computed(() =>
  [...(playlist.value?.tracks || [])].sort((left, right) => {
    const direction = order.value === "asc" ? 1 : -1;
    const fallback = direction * (left.position - right.position);
    if (sort.value === "id") return fallback;
    if (sort.value === "title") return direction * compareText(textOf(left.title), textOf(right.title)) || fallback;
    if (sort.value === "musicType")
      return direction * (displaySong(left).musicType - displaySong(right).musicType) || fallback;
    if (sort.value === "band") return direction * compareText(textOf(left.artist), textOf(right.artist)) || fallback;
    if (sort.value === "category")
      return direction * categorySortKey(left).localeCompare(categorySortKey(right)) || fallback;
    if (sort.value === "composer")
      return direction * compareText(localize(left.song?.composer), localize(right.song?.composer)) || fallback;
    if (sort.value === "lyrics")
      return direction * compareText(localize(left.song?.lyricist), localize(right.song?.lyricist)) || fallback;
    if (sort.value === "arrangement")
      return direction * compareText(localize(left.song?.arranger), localize(right.song?.arranger)) || fallback;
    if (sort.value === "release")
      return compareNullable(releaseTimestamp(left), releaseTimestamp(right), direction) || fallback;
    if (sort.value === "level")
      return compareNullable(difficultyLevel(left), difficultyLevel(right), direction) || fallback;
    if (sort.value === "source") return direction * compareText(sourceLabel(left), sourceLabel(right)) || fallback;
    if (["time", "score", "eff", "bpm", "n", "nps", "sr"].includes(sort.value)) {
      const key = sort.value as "time" | "score" | "eff" | "bpm" | "n" | "nps" | "sr";
      const leftMeta = metaOf(left);
      const rightMeta = metaOf(right);
      return (
        compareNullable(
          key === "bpm" ? songBpmSortValue(leftMeta) : leftMeta?.[key],
          key === "bpm" ? songBpmSortValue(rightMeta) : rightMeta?.[key],
          direction,
        ) || fallback
      );
    }
    return fallback;
  }),
);
const setTableSort = (value: string) => {
  if (tableColumns.value.some((column) => column.key === value && column.sortable)) {
    sort.value = value as SongCatalogSort | "source";
  }
};

const chartRuntimeMode = ref<ChartRuntimeMode>("chart");
const chartDifficulty = computed<number | undefined>({
  get: () => {
    if (!chartDifficultyQuery.value) return undefined;
    const value = Number(chartDifficultyQuery.value);
    return Number.isInteger(value) && value >= 0 && value <= 4 ? value : undefined;
  },
  set: (value) => {
    chartDifficultyQuery.value = value === undefined ? "" : String(value);
  },
});
const renderedChartDifficulty = ref<number>();
const chartLayerMounted = ref(false);
const difficultyName = difficultyNameOf;
const difficultyLevelLabel = (entry: SongDifficulty) =>
  Math.trunc(Number(entry.displayLevel ?? entry.playLevel ?? 0)) || undefined;
const difficultySemanticColor = (entry: SongDifficulty, index: number) => {
  const knownDifficulties = ["easy", "normal", "hard", "expert", "special", "master"] as const;
  const raw = String(entry.difficulty || difficultyName(entry, index)).toLowerCase();
  const key = knownDifficulties.find((candidate) => candidate === raw) || knownDifficulties[index] || "master";
  return `var(--md-extended-color-difficulty-${key === "special" ? "master" : key})`;
};
const chartDifficultyOptions = computed(() =>
  (detailTrack.value?.song?.difficulty || []).map((entry, index) => {
    const name = difficultyName(entry, index);
    const level = difficultyLevelLabel(entry);
    return {
      value: index,
      label: level === undefined ? name : String(level),
      ariaLabel: level === undefined ? name : `${name} ${level}`,
      semanticColor: difficultySemanticColor(entry, index),
      selectedIcon: "check",
    };
  }),
);
const selectedMeta = computed(() => (detailTrack.value ? metaOf(detailTrack.value) : undefined));
const chartOpen = computed(
  () =>
    Boolean(detailTrack.value?.song && detailTrack.value.origin) &&
    chartDifficulty.value !== undefined &&
    Boolean(detailTrack.value?.song?.difficulty?.[chartDifficulty.value]),
);
watch(
  [chartOpen, chartDifficulty],
  ([open, selectedDifficulty]) => {
    if (!open || selectedDifficulty === undefined) return;
    renderedChartDifficulty.value = selectedDifficulty;
    chartLayerMounted.value = true;
  },
  { immediate: true },
);
const chartDifficultyData = computed(() =>
  renderedChartDifficulty.value === undefined
    ? undefined
    : detailTrack.value?.song?.difficulty?.[renderedChartDifficulty.value],
);
const chartFile = computed(() => {
  if (!chartLayerMounted.value || !detailTrack.value?.origin || !detailTrack.value.song) return "";
  const file = chartDifficultyData.value?.file;
  if (!file) return "";
  const origin = detailTrack.value.origin;
  const profile = resolveSongCatalogSource(isBestdoriOrigin(origin) ? "bestdori" : "catalog");
  const canonicalize = (value: string) => (origin.provider === "release" ? assetUrl(value, origin.releaseId) : value);
  return profile.resolveChartUrl?.(file, canonicalize) ?? canonicalize(file);
});
const {
  chart,
  pending: chartPending,
  error: chartError,
  refresh: loadChart,
  reset: resetChart,
  rotation: chartRotation,
} = useChartPreview(chartFile);
const selectedScoreRankThresholds = computed(() =>
  [...(detailTrack.value?.song?.scoreRanks || [])]
    .filter((rank) => Number(rank.scoreRank || 0) >= 3)
    .sort((left, right) => Number(left.scoreRank || 0) - Number(right.scoreRank || 0))
    .map((rank) => Number(rank.requiredScore || 0)),
);
const closeSong = () => {
  void songLayer.close();
};
const afterSongLeave = () => {
  if (detailOpen.value) return;
  songLayerMounted.value = false;
  renderedTrack.value = undefined;
};
const selectSongDifficulty = (value: number) => {
  difficulty.value = value;
};
const openChart = async (item: ResolvedPlaylistTrack, selectedDifficulty = difficulty.value) => {
  if (!item.song || !item.origin || selectedSongId.value !== item.song.musicId) return;
  await chartLayer.open(selectedDifficulty, {
    song: String(item.song.musicId),
    songSource: originKey(item.origin),
    difficulty: selectedDifficulty === 3 ? undefined : String(selectedDifficulty),
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
const selectChartDifficulty = (selectedDifficulty: number) => {
  difficulty.value = selectedDifficulty;
  chartDifficulty.value = selectedDifficulty;
};
const selectChartDifficultyValue = (value: string | number) => {
  const selectedDifficulty = Number(value);
  if (Number.isInteger(selectedDifficulty)) selectChartDifficulty(selectedDifficulty);
};

watch(
  [() => props.open, playlist, pending, selectedSongId, selectedSongSource, chartDifficultyQuery, selectedTrack],
  ([open, currentPlaylist, isPending, songId, songSource, chartQuery, currentTrack]) => {
    if (isPending) return;

    const hasSongQuery = songId !== undefined;
    if (!open) {
      if (hasSongQuery) selectedSongId.value = undefined;
      if (songSource) selectedSongSource.value = "";
      if (chartQuery) chartDifficultyQuery.value = "";
      return;
    }

    // A missing playlist can still be a transient request failure. Keep a
    // direct detail URL intact until the owning playlist is known.
    if (!currentPlaylist) return;

    const validTrack = Boolean(hasSongQuery && currentTrack);

    if (hasSongQuery && !validTrack) {
      selectedSongId.value = undefined;
      if (songSource) selectedSongSource.value = "";
      if (chartQuery) chartDifficultyQuery.value = "";
      return;
    }

    if (!hasSongQuery) {
      if (songSource) selectedSongSource.value = "";
      if (chartQuery) chartDifficultyQuery.value = "";
      return;
    }

    if (!chartQuery) return;
    const chartIndex = Number(chartQuery);
    const validChart =
      Number.isInteger(chartIndex) &&
      chartIndex >= 0 &&
      chartIndex <= 4 &&
      Boolean(currentTrack?.song?.difficulty?.[chartIndex]);
    if (!validChart) chartDifficultyQuery.value = "";
  },
  { immediate: true },
);

useHead(() => ({
  title: props.open ? `${pageTitle.value} · ${t("communityPage.playlistPage.title")} · haneoka` : undefined,
}));
</script>

<template>
  <FullscreenDetailSurface
    :open="open"
    :title="pageTitle"
    body-overflow="hidden"
    body-padding="none"
    :covered="songLayerMounted"
    @close="emit('close')"
    @after-leave="emit('afterLeave')"
  >
    <PageContentSurface v-if="pending && !playlists.length" as="div" max-width="720px" :aria-busy="true">
      <LoadingState :label="t('loading')" />
    </PageContentSurface>
    <PageContentSurface v-else-if="error && !playlists.length" as="div" max-width="720px">
      <ErrorState @retry="refresh()" />
    </PageContentSurface>
    <PageContentSurface v-else-if="playlist" as="div" max-width="1040px" spacing="compact">
      <section class="playlist-summary" :aria-labelledby="`playlist-title-${playlist.sourceId}`">
        <div class="playlist-summary__cover" :class="{ 'is-logo': playlist.source === 'band' }">
          <img v-if="playlist.thumbnail" :src="playlist.thumbnail" alt="" />
          <MaterialIcon v-else :name="playlist.source === 'band' ? 'groups' : 'emoji_events'" :size="32" />
        </div>
        <div class="playlist-summary__copy">
          <span class="playlist-summary__source">
            {{
              playlist.kind === "game"
                ? t("communityPage.playlistPage.inGamePlaylist")
                : t("communityPage.playlistPage.systemPlaylist")
            }}
          </span>
          <div
            :id="`playlist-title-${playlist.sourceId}`"
            class="playlist-summary__title"
            :lang="langOf(playlist.titleText)"
          >
            <DisplayText :value="playlist.titleText" />
          </div>
          <div class="playlist-summary__meta">
            <span>{{ t("communityPage.playlistPage.songCount", { count: playlist.tracks.length }) }}</span>
            <span v-if="playlist.startsAt">{{ formatDate(playlist.startsAt) }}</span>
          </div>
        </div>
        <div class="playlist-summary__actions" role="group" :aria-label="t('communityPage.playlistPage.actions')">
          <UiButton tone="primary" :disabled="!playableQueue.length" @click="playAll">
            <template #icon><MaterialIcon name="play_arrow" :size="18" /></template>
            {{ t("communityPage.playlistPage.playAll") }}
          </UiButton>
        </div>
      </section>

      <section class="playlist-tracks" :aria-label="t('communityPage.playlistPage.tracks')">
        <VirtualCollectionTable
          class="playlist-song-table"
          :items="sortedTracks"
          :item-key="trackKey"
          :label="t('communityPage.playlistPage.tracks')"
          :columns="tableColumns"
          :sort="sort"
          :order="order"
          :row-height="64"
          :threshold="0"
          @update:sort="setTableSort"
          @update:order="order = $event"
        >
          <template #row="{ item, index, style }">
            <SongRow
              :style="style"
              :song="displaySong(item)"
              :title="item.title"
              :band="item.artist"
              :display-id="item.position"
              :source-label="sourceLabel(item)"
              :credit-origin="item.origin || undefined"
              :difficulty="difficulty"
              :meta="metaOf(item)"
              :row-index="index"
              @select="openSong(item)"
              @play="playFrom(item)"
              @chart="openSong(item, true)"
              @difficulty="difficulty = $event"
            />
          </template>
        </VirtualCollectionTable>
      </section>
    </PageContentSurface>
    <PageContentSurface v-else as="div" max-width="720px">
      <EmptyState :label="t('communityPage.playlistPage.notFound')" />
    </PageContentSurface>
  </FullscreenDetailSurface>

  <LazySongDetailPanel
    v-if="songLayerMounted && detailTrack?.song && detailTrack.origin"
    :open="detailOpen"
    :song="detailTrack.song"
    :title="detailTrack.title"
    :band-name="detailTrack.artist"
    :origin="detailTrack.origin"
    :difficulty="difficulty"
    :meta="selectedMeta"
    :hide-sonolus="isBestdoriOrigin(detailTrack.origin)"
    :covered="chartLayerMounted"
    @close="closeSong"
    @after-leave="afterSongLeave"
    @play="playFrom(detailTrack)"
    @chart="openChart(detailTrack, $event)"
    @update:difficulty="selectSongDifficulty"
  />

  <SongChartWorkbench
    v-if="chartLayerMounted && detailTrack?.song && detailTrack.origin && renderedChartDifficulty !== undefined"
    v-model:mode="chartRuntimeMode"
    :open="chartOpen"
    :title="detailTrack.title"
    :difficulty="renderedChartDifficulty"
    :difficulty-options="chartDifficultyOptions"
    @update:difficulty="selectChartDifficultyValue"
    @close="closeChart"
    @after-leave="afterChartLeave"
  >
    <div class="playlist-song-chart__stage">
      <LoadingState v-if="chartPending" />
      <ErrorState v-else-if="chartError || !chart" @retry="loadChart" />
      <ClientOnly v-else>
        <RotatableViewport v-model:rotation="chartRotation" :controls="false">
          <LazyChartRuntime
            :key="`${detailTrack.song.musicId}:${renderedChartDifficulty}:${chartRuntimeRelease.releaseId}`"
            v-model:mode="chartRuntimeMode"
            v-model:rotation="chartRotation"
            :chart="chart"
            :audio-url="detailTrack.song.musicUrl"
            :score-ranks="selectedScoreRankThresholds"
            :runtime-release="chartRuntimeRelease"
          />
        </RotatableViewport>
        <template #fallback><LoadingState /></template>
      </ClientOnly>
    </div>
  </SongChartWorkbench>
</template>

<style scoped>
.playlist-summary {
  display: grid;
  grid-template-columns: 112px minmax(0, 1fr) auto;
  align-items: center;
  gap: var(--md-sys-spacing-4);
  padding: var(--md-sys-spacing-4);
  border-radius: var(--md-sys-shape-corner-extra-large);
  background: var(--md-sys-color-surface-container-low);
}

.playlist-summary__cover {
  display: grid;
  width: 112px;
  height: 112px;
  overflow: hidden;
  place-items: center;
  color: var(--md-sys-color-on-secondary-container);
  border-radius: var(--md-sys-shape-corner-large);
  background: var(--md-sys-color-secondary-container);
}

.playlist-summary__cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.playlist-summary__cover.is-logo {
  padding: var(--md-sys-spacing-3);
}

.playlist-summary__cover.is-logo img {
  object-fit: contain;
}

.playlist-summary__copy {
  display: grid;
  min-width: 0;
  gap: var(--md-sys-spacing-1);
}

.playlist-summary__source {
  color: var(--md-sys-color-primary);
  font: var(--md-sys-typescale-label-medium-weight) var(--md-sys-typescale-label-medium-size) /
    var(--md-sys-typescale-label-medium-line-height) var(--md-sys-typescale-label-medium-font);
}

.playlist-summary__title {
  margin: 0;
  font: var(--md-sys-typescale-headline-small-weight) var(--md-sys-typescale-headline-small-size) /
    var(--md-sys-typescale-headline-small-line-height) var(--md-sys-typescale-headline-small-font);
  overflow-wrap: anywhere;
}

.playlist-summary__meta,
.playlist-summary__actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--md-sys-spacing-2);
}

.playlist-summary__meta {
  color: var(--md-sys-color-on-surface-variant);
  font: var(--md-sys-typescale-label-small-weight) var(--md-sys-typescale-label-small-size) /
    var(--md-sys-typescale-label-small-line-height) var(--md-sys-typescale-label-small-font);
}

.playlist-summary__actions {
  justify-content: flex-end;
}

.playlist-tracks {
  min-width: 0;
  overflow: hidden;
  border-radius: var(--md-sys-shape-corner-large);
  background: var(--md-sys-color-surface-container-low);
}

.playlist-song-table {
  width: 100%;
  height: min(calc(68dvh - var(--player-inset)), 720px);
  min-height: 360px;
}

.playlist-song-chart__stage {
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: var(--md-comp-runtime-scene-surface);
}

.playlist-song-chart__stage > :deep(*) {
  width: 100%;
  height: 100%;
}

@media (max-width: 760px) {
  .playlist-summary {
    grid-template-columns: 80px minmax(0, 1fr);
    padding: var(--md-sys-spacing-3);
  }

  .playlist-summary__cover {
    width: 80px;
    height: 80px;
  }

  .playlist-summary__actions {
    grid-column: 1 / -1;
    justify-content: flex-start;
  }

  .playlist-song-table {
    height: clamp(240px, calc(100dvh - 280px - var(--player-inset) - var(--shell-bottom-navigation-height)), 720px);
    min-height: 240px;
  }
}
</style>
