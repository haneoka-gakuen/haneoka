<script setup lang="ts">
import { MaterialIcon } from "@haneoka/ui";

import { ourNotesReleaseOrigin, type CatalogContentOrigin } from "~/features/catalog/contentSource";
import type { SpineCatalog, SpineModel } from "~/types/spine";
import { versionedPreviewImageUrl } from "~/utils/previewImageUrl";

const spineSortKeys = ["id", "source", "family", "version"] as const;
type SpineSort = (typeof spineSortKeys)[number];
type OurNotesCatalogOrigin = Extract<CatalogContentOrigin, { provider: "release" }>;
const SPINE_PREVIEW_SCHEMA = "haneoka-spine-preview-v5";

const { releaseServer } = useReleaseServer();
const { messages, t, compareText } = useLocale();
const copy = messages("spinePage");
const catalogOrigin = computed<OurNotesCatalogOrigin>(() => ourNotesReleaseOrigin(releaseServer.value));
const route = useRoute();
const query = useRouteQueryText("q");
const view = useRouteQueryEnum("view", ["grid", "list"] as const, "grid");
const sort = useRouteQueryEnum("sort", spineSortKeys, "id");
const order = useRouteQueryEnum("order", ["asc", "desc"] as const, "asc");
const selectedKey = useRouteQueryText("model");
const modelLayer = useRouteQueryLayer("model");
const { activeFilterCount, resetFilters } = useCatalogFilterState({ texts: [query] });
const { data: catalog, pending, error, refresh } = useCatalogDocument<SpineCatalog>("spine", catalogOrigin);
const models = computed(() => Object.values(catalog.value?.models || {}));
const {
  data: selectedModel,
  resolvedOrigin: selectedOrigin,
  pending: selectedPending,
  error: selectedError,
  refresh: refreshSelected,
} = useCatalogSelection<SpineModel>("spine", selectedKey, catalogOrigin);
const detailOrigin = computed<OurNotesCatalogOrigin>(() => {
  const resolved = selectedOrigin.value;
  return resolved?.provider === "release" ? resolved : catalogOrigin.value;
});

const normalized = (value: unknown) =>
  String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase();
const sourceLabel = (model: SpineModel) => {
  const source = String(model.sourcePathKey || model.id);
  const leaf = source.split("/").filter(Boolean).at(-1) || source;
  return leaf.replace(/_SkeletonData(?:\.asset)?$/iu, "") || model.id;
};
const isSetupPreview = (model: SpineModel) => {
  const preview = model.preview;
  const pose = preview?.pose;
  return (
    catalog.value?.previewSchema === SPINE_PREVIEW_SCHEMA &&
    preview?.status === "rendered" &&
    preview.schema === SPINE_PREVIEW_SCHEMA &&
    Boolean(preview.url) &&
    pose?.kind === "setup" &&
    pose.animationApplied === false &&
    pose.animationStateAdvanced === false &&
    pose.physics === "none"
  );
};
const previewImageOf = (model: SpineModel) =>
  isSetupPreview(model) && !failedPreviews.value.has(model.id)
    ? versionedPreviewImageUrl(
        model.preview?.url,
        model.preview?.sha256 || `${model.preview?.schema}:${model.preview?.width}x${model.preview?.height}`,
      )
    : undefined;
const failedPreviews = ref<Set<string>>(new Set());
const markPreviewFailed = (model: SpineModel) => {
  failedPreviews.value = new Set(failedPreviews.value).add(model.id);
};
const filteredModels = computed(() => {
  const needle = normalized(query.value.trim());
  const direction = order.value === "asc" ? 1 : -1;
  return [...models.value]
    .filter(
      (model) =>
        !needle ||
        normalized(`${sourceLabel(model)} ${model.id} ${model.family || ""} ${model.spineVersion || ""}`).includes(
          needle,
        ),
    )
    .sort((left, right) => {
      let comparison = left.id.localeCompare(right.id, "en", { numeric: true });
      if (sort.value === "source") comparison = compareText(sourceLabel(left), sourceLabel(right)) || comparison;
      if (sort.value === "family") comparison = compareText(left.family || "", right.family || "") || comparison;
      if (sort.value === "version")
        comparison = compareText(left.spineVersion || "", right.spineVersion || "") || comparison;
      return direction * comparison;
    });
});
const selectedSummary = computed(() => models.value.find((model) => model.id === selectedKey.value));
const selected = computed(() => selectedModel.value || selectedSummary.value);
const selectedTitle = computed(() => (selected.value ? sourceLabel(selected.value) : t("spine")));
const selectedSubtitle = computed(() => selected.value?.family || selected.value?.spineVersion || "");
const modelRoute = (model: SpineModel) => ({
  path: "/catalog/spine",
  query: { ...route.query, model: model.id },
});
const rowFieldsOf = (model: SpineModel) => [
  { key: "family", value: model.family || "", align: "center" as const },
  { key: "version", value: model.spineVersion || "", align: "center" as const },
  { key: "animations", value: model.animationCount ?? model.animations?.length ?? 0, align: "end" as const },
];
const tableColumns = computed(() => [
  { key: "id", label: t("id"), sortable: true },
  { key: "source", label: copy.value.source, sortable: true, semantic: "primary" as const },
  { key: "family", label: copy.value.family, sortable: true },
  { key: "version", label: copy.value.version, sortable: true },
  { key: "animations", label: copy.value.animations, align: "end" as const },
  { key: "open", label: "", kind: "action" as const },
]);
const sortOptions = useCatalogSortOptions<SpineSort>(tableColumns, {
  id: "tag",
  source: "animation",
  family: "category",
  version: "data_object",
});
const setSort = (value: string) => {
  if ((spineSortKeys as readonly string[]).includes(value)) sort.value = value as SpineSort;
};
const closeModel = () => void modelLayer.close();

useHead(() => ({
  title: `${selectedKey.value ? `${selectedTitle.value} · ` : ""}${t("spine")} · haneoka`,
}));
</script>

<template>
  <CatalogCollectionScreen
    v-model:view="view"
    :title="t('spine')"
    :count="selectedKey ? undefined : filteredModels.length"
    :pending="pending"
    :error="error"
    :empty="!models.length || (!selectedKey && !filteredModels.length)"
    :active-filter-count="activeFilterCount"
    :show-view-control="!selectedKey"
    :detail-available="false"
    viewport-mode="stage"
    @retry="refresh()"
    @reset-filters="resetFilters"
  >
    <template v-if="!selectedKey" #filters>
      <SearchField v-model="query" :label="t('search')" />
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

    <template #content="{ view: activeView }">
      <RuntimeColumn
        v-if="selectedKey"
        id="spine-runtime"
        class="spine-window"
        :title="selectedTitle"
        :subtitle="selectedSubtitle"
        kind="stage"
        closeable
        workspace-header
        workspace-header-variant="detail"
        @close="closeModel"
      >
        <LoadingState v-if="selectedPending || (!selected && !selectedError)" />
        <ErrorState v-else-if="selectedError || !selected" @retry="refreshSelected()" />
        <ClientOnly v-else>
          <LazySpineStage :key="selected.id" :entry="selected" :origin="detailOrigin" :title="selectedTitle" />
          <template #fallback><LoadingState /></template>
        </ClientOnly>
      </RuntimeColumn>

      <CatalogCollectionGrid
        v-else-if="activeView === 'grid'"
        :items="filteredModels"
        :item-key="(model) => model.id"
        :label="copy.models"
        :minimum-column-width="148"
        :compact-minimum-column-width="112"
        :selected-key="selectedKey"
        scroll-key="spine-grid"
      >
        <template #item="{ item: model }">
          <CollectionTileSurface
            :label="sourceLabel(model)"
            :secondary-label="model.family || model.spineVersion || model.id"
            aspect-ratio="1 / 1"
            media-fit="contain"
            :to="modelRoute(model)"
            :selected="model.id === selectedKey"
          >
            <template #media>
              <LoadingImage
                v-if="previewImageOf(model)"
                :src="previewImageOf(model)"
                :alt="sourceLabel(model)"
                loading="lazy"
                fit="contain"
                @error="markPreviewFailed(model)"
              />
              <span v-else class="spine-model-fallback" :title="copy.previewUnavailable">
                <MaterialIcon name="animation" :size="28" aria-hidden="true" />
              </span>
            </template>
            <CollectionTileIdentity
              :title="sourceLabel(model)"
              :subtitle="model.family || model.spineVersion || model.id"
            />
          </CollectionTileSurface>
        </template>
      </CatalogCollectionGrid>

      <VirtualCollectionTable
        v-else
        :items="filteredModels"
        :item-key="(model) => model.id"
        :label="copy.models"
        :row-height="64"
        :selected-key="selectedKey"
        :columns="tableColumns"
        :sort="sort"
        :order="order"
        scroll-key="spine-list"
        @update:sort="setSort"
        @update:order="order = $event"
      >
        <template #row="{ item: model, index, style }">
          <ResourceCatalogRow
            :style="style"
            :row-index="index"
            :identifier="model.id"
            :title="sourceLabel(model)"
            :subtitle="model.sourcePathKey || ''"
            :image="previewImageOf(model)"
            image-fit="contain"
            media-icon="animation"
            media-shape="rounded"
            :fields="rowFieldsOf(model)"
            :selected="model.id === selectedKey"
            @select="modelLayer.open(model.id)"
          />
        </template>
      </VirtualCollectionTable>
    </template>
  </CatalogCollectionScreen>
</template>

<style scoped>
.spine-window {
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  background: var(--md-sys-color-surface-container-low);
}

.spine-model-fallback {
  display: grid;
  width: 100%;
  height: 100%;
  place-items: center;
  color: var(--md-sys-color-on-surface-variant);
  background: var(--md-sys-color-surface-container-low);
}
</style>
