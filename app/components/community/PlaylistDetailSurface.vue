<script setup lang="ts">
import { MaterialIcon, UiButton } from "@haneoka/ui";

import type { AudioTrack } from "~/composables/useAudioPlayer";
import type { Song, SongMetaByDifficulty, SongMetaChart } from "~/types/archive";
import type { CatalogContentOrigin, ContentOrigin } from "~/features/catalog/contentSource";
import type { ResolvedPlaylistTrack } from "~/types/playlists";
import {
  bestdoriOrigin,
  contentOriginLabel,
  contentOriginKey,
  isBestdoriOrigin,
  ourNotesReleaseOrigin,
} from "~/features/catalog/contentSource";
import { langOf, textOf } from "~/types/displayText";
import { songReleaseTimestamp, type SongCatalogSort } from "~/features/catalog/songSources";

const props = defineProps<{
  open: boolean;
  playlistId: string;
}>();
const emit = defineEmits<{
  close: [];
  afterLeave: [];
}>();
const { t, formatDate, localize, compareText } = useLocale();
const { releaseServer, fallbackReleaseServers, releases: releaseRegistry } = useReleaseServer();
const { playQueue } = useAudioPlayer();
const { data: playlists, pending, error, refresh } = usePlaylistCatalog();
const layerLink = useRouteQueryLayerLink();
const playlistReleaseOrigins = computed<Extract<ContentOrigin, { provider: "release" }>[]>(() => {
  const seen = new Set<string>();
  return [
    releaseServer.value,
    ...fallbackReleaseServers.value,
    ...releaseRegistry.value.map((release) => release.id),
  ].flatMap((releaseId) => {
    const id = String(releaseId || "").trim();
    if (!id || seen.has(id)) return [];
    seen.add(id);
    return [ourNotesReleaseOrigin(id)];
  });
});
const releaseMeta = useCatalogCollectionSet<SongMetaByDifficulty>(
  "song-meta",
  playlistReleaseOrigins,
  "garupa:playlist-release-song-meta",
);
const releaseMetaByOrigin = computed(
  () => new Map(releaseMeta.data.value.map((source) => [contentOriginKey(source.origin), source.records])),
);
const bestdoriMetaOrigin = bestdoriOrigin("jp");
const { data: bestdoriMeta } = useCatalogCollection<SongMetaByDifficulty>("song-meta", bestdoriMetaOrigin);
const tableColumns = useSongTableColumns({ includeSource: true });
const difficulty = useRouteQueryInteger("difficulty", 3, { min: 0, max: 4 });
const sort = ref<SongCatalogSort | "source">("id");
const order = ref<"asc" | "desc">("asc");
const playlistId = computed(() => props.playlistId);
const playlist = computed(() => playlists.value.find((candidate) => candidate.id === playlistId.value));
const originKey = (origin: CatalogContentOrigin | null): string => (origin ? contentOriginKey(origin) : "");
const pageTitle = computed(() =>
  playlist.value
    ? textOf(playlist.value.titleText)
    : pending.value
      ? t("communityPage.playlistPage.title")
      : t("communityPage.playlistPage.notFound"),
);
const playable = (item: ResolvedPlaylistTrack) => Boolean(item.origin && item.song?.musicUrl);
const queueId = (item: ResolvedPlaylistTrack) =>
  `${playlistId.value}:${item.position}:${originKey(item.origin)}:${item.song?.musicId || item.definition.musicId}`;
const audioTrack = (item: ResolvedPlaylistTrack): AudioTrack | null => {
  if (!item.origin || !item.song?.musicUrl) return null;
  return {
    kind: "song",
    queueId: queueId(item),
    origin: item.origin,
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
    : releaseMetaByOrigin.value.get(contentOriginKey(origin));
  return record?.[String(item.song.musicId)]?.[String(difficulty.value)]?.chart;
};
const openSong = async (item: ResolvedPlaylistTrack, chart = false) => {
  if (!item.origin || !item.song) return;
  const origin = item.origin;
  await navigateTo(
    layerLink(
      {
        path: isBestdoriOrigin(origin) ? "/community/songs-bestdori" : "/catalog/songs",
        query: {
          song: String(item.song.musicId),
          difficulty: difficulty.value === 3 ? undefined : String(difficulty.value),
          chart: chart ? String(difficulty.value) : undefined,
          ...(origin.provider === "release" ? { release: origin.releaseId } : {}),
        },
      },
      "song",
    ),
  );
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
  !item.origin ? t("communityPage.playlistPage.masterUnavailable") : contentOriginLabel(item.origin);
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
