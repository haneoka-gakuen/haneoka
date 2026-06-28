<script setup lang="ts">
import type { LocationQueryRaw } from "vue-router";

import type { CollectionTableColumn } from "~/components/catalog/CollectionTableHeader.vue";
import type { FacetOption } from "~/components/ui/FacetGroup.vue";
import type { ResolvedPlaylist } from "~/types/playlists";
import { textOf } from "~/types/displayText";

definePageMeta({
  key: "community-playlists",
  scrollToTop: false,
});

const playlistSortKeys = ["order", "id", "title", "type", "songs", "release"] as const;
const playlistCatalogQueryKeys = ["q", "band", "view", "sort", "order"] as const;
type PlaylistSort = (typeof playlistSortKeys)[number];

const route = useRoute();
const router = useRouter();
const { t, compareText, formatDate } = useLocale();
const { data: playlists, pending, error, refresh } = usePlaylistCatalog();
const routePlaylistId = computed(() => String(route.params.id || ""));
const renderedPlaylistId = ref(routePlaylistId.value);
const detailLayerActive = ref(Boolean(routePlaylistId.value));
const query = useRouteQueryText("q");
const bandFilters = useRouteQueryList("band");
const view = useRouteQueryEnum("view", ["grid", "list"] as const, "grid");
const sort = useRouteQueryEnum("sort", playlistSortKeys, "order");
const order = useRouteQueryEnum("order", ["asc", "desc"] as const, "asc");
const { activeFilterCount, resetFilters } = useCatalogFilterState({
  texts: [query],
  facets: [bandFilters],
});

const bands = computed(() => playlists.value.filter((playlist) => playlist.source === "band"));
const challenges = computed(() =>
  playlists.value
    .filter((playlist) => playlist.source === "stage-challenge")
    .sort((left, right) => right.sourceId - left.sourceId),
);
const catalogItems = computed(() => [...bands.value, ...challenges.value]);
const naturalOrder = computed(() => new Map(catalogItems.value.map((playlist, index) => [playlist.id, index + 1])));
const bandOptions = computed<FacetOption[]>(() =>
  bands.value.map((playlist) => ({
    value: playlist.bandKeys[0]!,
    label: playlist.titleText,
    visuals: playlist.filterVisual ? [playlist.filterVisual] : undefined,
    color: playlist.color || undefined,
    count: playlists.value.filter((candidate) => candidate.bandKeys.includes(playlist.bandKeys[0]!)).length,
  })),
);
const typeLabel = (playlist: ResolvedPlaylist) =>
  playlist.source === "band" ? t("communityPage.playlistPage.bands") : t("communityPage.playlistPage.stageChallenges");
const releaseTimestamp = (playlist: ResolvedPlaylist) => Number(playlist.startsAt || 0);
const compareNumber = (left: number, right: number) => left - right;
const visiblePlaylists = computed(() => {
  const needle = query.value.trim().normalize("NFKC").toLocaleLowerCase();
  const direction = order.value === "asc" ? 1 : -1;
  return catalogItems.value
    .filter(
      (playlist) =>
        !bandFilters.value.length || bandFilters.value.some((key) => playlist.bandKeys.includes(String(key))),
    )
    .filter(
      (playlist) =>
        !needle ||
        `${textOf(playlist.titleText)} ${playlist.title} ${playlist.sourceId} ${typeLabel(playlist)}`
          .normalize("NFKC")
          .toLocaleLowerCase()
          .includes(needle),
    )
    .sort((left, right) => {
      let difference = compareNumber(naturalOrder.value.get(left.id) || 0, naturalOrder.value.get(right.id) || 0);
      if (sort.value === "id") difference = compareNumber(left.sourceId, right.sourceId);
      if (sort.value === "title") difference = compareText(textOf(left.titleText), textOf(right.titleText));
      if (sort.value === "type") difference = compareText(typeLabel(left), typeLabel(right));
      if (sort.value === "songs") difference = compareNumber(left.tracks.length, right.tracks.length);
      if (sort.value === "release") difference = compareNumber(releaseTimestamp(left), releaseTimestamp(right));
      return (
        direction * difference ||
        compareNumber(naturalOrder.value.get(left.id) || 0, naturalOrder.value.get(right.id) || 0)
      );
    });
});
const visibleBands = computed(() => visiblePlaylists.value.filter((playlist) => playlist.source === "band"));
const visibleChallenges = computed(() =>
  visiblePlaylists.value.filter((playlist) => playlist.source === "stage-challenge"),
);
const playlistCatalogQuery = (): LocationQueryRaw => {
  const query: LocationQueryRaw = {};
  for (const key of playlistCatalogQueryKeys) {
    const value = route.query[key];
    if (value != null) query[key] = value;
  }
  return query;
};
const playlistPath = (playlist: ResolvedPlaylist) =>
  router.resolve({
    path: `/community/playlists/${encodeURIComponent(playlist.id)}`,
    query: playlistCatalogQuery(),
  }).fullPath;
const playlistKey = (playlist: ResolvedPlaylist) => playlist.id;
const displayOrder = (playlist: ResolvedPlaylist) => naturalOrder.value.get(playlist.id) || 0;
const releaseLabel = (playlist: ResolvedPlaylist) => (playlist.startsAt ? formatDate(playlist.startsAt) : "—");

watch(
  routePlaylistId,
  (id) => {
    if (!id) return;
    renderedPlaylistId.value = id;
    detailLayerActive.value = true;
  },
  { immediate: true },
);

const finishDetailLeave = () => {
  if (!routePlaylistId.value) detailLayerActive.value = false;
};

const closePlaylist = () => {
  if (!routePlaylistId.value) {
    detailLayerActive.value = false;
    return;
  }
  const previousLocation = router.options.history.state.back;
  if (typeof previousLocation === "string" && previousLocation) {
    const previous = router.resolve(previousLocation);
    if (previous.path === "/community/playlists") {
      detailLayerActive.value = false;
      router.back();
      return;
    }
  }
  detailLayerActive.value = false;
  void router.replace({ path: "/community/playlists", query: playlistCatalogQuery() });
};

const tableColumns = computed<CollectionTableColumn[]>(() => [
  { key: "order", label: t("order"), sortable: true, align: "end" },
  { key: "title", label: t("title"), sortable: true, align: "start", semantic: "primary" },
  { key: "type", label: t("type"), sortable: true, align: "center" },
  { key: "songs", label: t("songs"), sortable: true, align: "end" },
  { key: "release", label: t("release"), sortable: true, align: "end" },
]);
const sortOptions = useCatalogSortOptions<PlaylistSort>(tableColumns);
const setTableSort = (value: string) => {
  if ((playlistSortKeys as readonly string[]).includes(value)) sort.value = value as PlaylistSort;
};

useHead(() => ({ title: `${t("communityPage.playlistPage.title")} · ${t("community")} · haneoka` }));
</script>

<template>
  <CatalogCollectionScreen
    v-model:view="view"
    domain="community"
    class="playlist-catalog"
    :inert="detailLayerActive || undefined"
    :aria-hidden="detailLayerActive ? 'true' : undefined"
    :title="t('communityPage.playlistPage.title')"
    :count="visiblePlaylists.length"
    :pending="pending && !playlists.length"
    :error="error && !playlists.length ? error : undefined"
    :active-filter-count="activeFilterCount"
    :detail-available="false"
    viewport-mode="stage"
    @retry="refresh()"
    @reset-filters="resetFilters"
  >
    <template #filters>
      <SearchField v-model="query" :label="t('communityPage.playlistPage.search')" />
      <FacetGroup v-model="bandFilters" :title="t('band')" :options="bandOptions" icon-only />
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

    <template #content>
      <EmptyState v-if="!visiblePlaylists.length" :label="t('communityPage.playlistPage.noResults')" />

      <div v-else-if="view === 'grid'" class="playlist-catalog__grid-scroll">
        <PageContentSurface as="div" max-width="1120px" spacing="compact">
          <PageSection v-if="visibleBands.length" :title="t('communityPage.playlistPage.bands')" icon="groups">
            <CatalogCollectionGrid
              :items="visibleBands"
              :item-key="playlistKey"
              :label="t('communityPage.playlistPage.bands')"
              :minimum-column-width="126"
              :compact-minimum-column-width="108"
              :threshold="999"
              flow
            >
              <template #item="{ item: playlist }">
                <PlaylistCatalogTile
                  :title="playlist.titleText"
                  :subtitle="t('communityPage.playlistPage.songCount', { count: playlist.tracks.length })"
                  :image="playlist.thumbnail"
                  image-fit="contain"
                  :to="playlistPath(playlist)"
                  fallback-icon="groups"
                />
              </template>
            </CatalogCollectionGrid>
          </PageSection>

          <PageSection
            v-if="visibleChallenges.length"
            :divided="visibleBands.length > 0"
            :title="t('communityPage.playlistPage.stageChallenges')"
            icon="emoji_events"
          >
            <CatalogCollectionGrid
              :items="visibleChallenges"
              :item-key="playlistKey"
              :label="t('communityPage.playlistPage.stageChallenges')"
              :minimum-column-width="126"
              :compact-minimum-column-width="108"
              :threshold="999"
              flow
            >
              <template #item="{ item: playlist }">
                <PlaylistCatalogTile
                  :title="playlist.titleText"
                  :subtitle="t('communityPage.playlistPage.songCount', { count: playlist.tracks.length })"
                  :image="playlist.thumbnail"
                  :to="playlistPath(playlist)"
                  fallback-icon="emoji_events"
                />
              </template>
            </CatalogCollectionGrid>
          </PageSection>
        </PageContentSurface>
      </div>

      <VirtualCollectionTable
        v-else
        class="playlist-catalog__list"
        :items="visiblePlaylists"
        :item-key="playlistKey"
        :columns="tableColumns"
        :sort="sort"
        :order="order"
        :label="t('communityPage.playlistPage.title')"
        :row-height="60"
        scroll-key="playlist-list"
        @update:sort="setTableSort"
        @update:order="order = $event"
      >
        <template #row="{ item: playlist, index, style }">
          <ResourceCatalogRow
            :style="style"
            :row-index="index"
            :identifier="displayOrder(playlist)"
            :title="playlist.titleText"
            :image="playlist.thumbnail"
            :image-fit="playlist.source === 'stage-challenge' ? 'cover' : 'contain'"
            :media-text="playlist.titleText"
            :media-color="playlist.color || undefined"
            :media-icon="playlist.source === 'band' ? 'groups' : 'emoji_events'"
            :to="playlistPath(playlist)"
            :action-cell="false"
            :fields="[
              { key: 'type', value: typeLabel(playlist), align: 'center' },
              { key: 'songs', value: playlist.tracks.length, align: 'end' },
              { key: 'release', value: releaseLabel(playlist), align: 'end' },
            ]"
          />
        </template>
      </VirtualCollectionTable>
    </template>
  </CatalogCollectionScreen>

  <PlaylistDetailSurface
    :open="Boolean(routePlaylistId)"
    :playlist-id="renderedPlaylistId"
    @close="closePlaylist"
    @after-leave="finishDetailLeave"
  />
</template>

<style scoped>
.playlist-catalog__grid-scroll {
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: auto;
  overscroll-behavior: contain;
}

.playlist-catalog__list {
  height: 100%;
}
</style>
