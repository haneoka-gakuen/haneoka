<script setup lang="ts">
import { MaterialIcon } from "@haneoka/ui";

import type { ResourceRowField } from "~/components/catalog/ResourceCatalogRow.vue";
import type { AnonTokyoEntity } from "~/types/anonTokyo";
import { anonTokyoDisplayAsset, anonTokyoText } from "~/types/anonTokyo";

export interface AnonTokyoCatalogField {
  key: string;
  label: string;
  value: (entry: AnonTokyoEntity) => string | number | null | undefined;
  align?: "start" | "center" | "end";
  code?: boolean;
}

const sortKeys = ["id", "title"] as const;
type SortKey = (typeof sortKeys)[number];

const props = withDefaults(
  defineProps<{
    title: string;
    entries: readonly AnonTokyoEntity[];
    pending?: boolean;
    error?: unknown;
    available?: boolean;
    unavailableLabel?: string;
    queryKey: string;
    icon?: string;
    fields?: readonly AnonTokyoCatalogField[];
    minimumColumnWidth?: number;
    imageRatio?: "square" | "member" | "support" | "portrait" | "comic" | "stamp";
    imageFit?: "cover" | "contain";
  }>(),
  {
    pending: false,
    error: undefined,
    available: true,
    unavailableLabel: "",
    icon: "inventory_2",
    fields: () => [],
    minimumColumnWidth: 132,
    imageRatio: "square",
    imageFit: "contain",
  },
);

const emit = defineEmits<{ retry: [] }>();
const { locale, t, compareText } = useLocale();
const query = useRouteQueryText("q");
// Catalogs whose master rows carry no real artwork (task lists, level tables)
// are data tables, not visual galleries: fall back to the dense list view
// until the visitor explicitly picks a layout.
const viewQuery = useRouteQueryText("view");
const mediaCoverage = computed(() => {
  if (!props.entries.length) return 1;
  const withMedia = props.entries.filter((entry) => imageOf(entry)).length;
  return withMedia / props.entries.length;
});
const view = computed<"grid" | "list">({
  get: () => {
    if (viewQuery.value === "grid" || viewQuery.value === "list") return viewQuery.value;
    return mediaCoverage.value < 0.34 ? "list" : "grid";
  },
  set: (value) => {
    viewQuery.value = value;
  },
});
const sort = useRouteQueryEnum("sort", sortKeys, "id");
const order = useRouteQueryEnum("order", ["asc", "desc"] as const, "asc");
const selectedKey = useRouteQueryText(props.queryKey);
const selectionLayer = useRouteQueryLayer(props.queryKey);
const { activeFilterCount, resetFilters } = useCatalogFilterState({ texts: [query] });
const detailOpen = computed({
  get: () => Boolean(selectedKey.value),
  set: (open) => {
    if (!open) void selectionLayer.close();
  },
});

const titleOf = (entry: AnonTokyoEntity) =>
  anonTokyoText(entry.title, locale.value) || anonTokyoText(entry.name, locale.value) || `#${String(entry.rawId)}`;
const descriptionOf = (entry: AnonTokyoEntity) => {
  const description = anonTokyoText(entry.description, locale.value);
  // Some master records repeat their display name in the description slot.
  // Keep the information, but do not render a visually duplicate subtitle.
  return description && description.trim() !== titleOf(entry).trim() ? description : "";
};
const imageOf = (entry: AnonTokyoEntity) => anonTokyoDisplayAsset(entry, locale.value);
// AT image bases have their own locale semantics (some un-suffixed guides are
// zh-Hans), so TextFallbackMedia must not apply the archive-wide ja fallback.
const exactImageSource = (image: string | null | undefined) => (image ? [image] : []);
const normalized = (value: unknown) =>
  String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase();

const filteredEntries = computed(() => {
  const needle = normalized(query.value.trim());
  const direction = order.value === "asc" ? 1 : -1;
  return [...props.entries]
    .filter((entry) => entry.isShow !== false)
    .filter(
      (entry) =>
        !needle || normalized(`${titleOf(entry)} ${descriptionOf(entry)} ${entry.id} ${entry.rawId}`).includes(needle),
    )
    .sort((left, right) => {
      let comparison = String(left.id).localeCompare(String(right.id), "en", { numeric: true });
      if (sort.value === "title") comparison = compareText(titleOf(left), titleOf(right)) || comparison;
      return direction * comparison;
    });
});
const selected = computed(() => props.entries.find((entry) => entry.id === selectedKey.value));
const fieldsOf = (entry: AnonTokyoEntity): ResourceRowField[] =>
  props.fields.map((field) => ({
    key: field.key,
    value: field.value(entry),
    align: field.align,
    code: field.code,
  }));
const factsOf = (entry: AnonTokyoEntity) =>
  props.fields
    .map((field) => ({ label: field.label, value: field.value(entry) }))
    .filter((field) => field.value !== null && field.value !== undefined && String(field.value).trim());
const tableColumns = computed(() => [
  { key: "id", label: t("id"), sortable: true, align: "end" as const },
  { key: "title", label: t("title"), sortable: true, semantic: "primary" as const },
  ...props.fields.map((field) => ({ key: field.key, label: field.label, align: field.align || "center" })),
  { key: "open", label: "", kind: "action" as const },
]);
const sortOptions = useCatalogSortOptions<SortKey>(tableColumns, { id: "tag", title: "text_fields" });
const setSort = (value: string) => {
  if ((sortKeys as readonly string[]).includes(value)) sort.value = value as SortKey;
};
const open = (entry: AnonTokyoEntity) => void selectionLayer.toggle(entry.id);
const close = () => void selectionLayer.close();

useSeoMeta({ title: () => `${props.title} · haneoka` });
</script>

<template>
  <WorkspaceScreen v-if="!available && !pending && !error" :title="title" domain="catalog" :detail-available="false">
    <PageContentSurface max-width="1040px">
      <InlineNotice tone="info" icon="inventory_2">{{ unavailableLabel || t("unavailable") }}</InlineNotice>
    </PageContentSurface>
  </WorkspaceScreen>

  <CatalogCollectionScreen
    v-else
    v-model:view="view"
    v-model:detail-open="detailOpen"
    :title="title"
    :count="selectedKey ? undefined : filteredEntries.length"
    :pending="pending"
    :error="error"
    :empty="!entries.length || (!selectedKey && !filteredEntries.length)"
    :active-filter-count="activeFilterCount"
    viewport-mode="stage"
    @retry="emit('retry')"
    @reset-filters="resetFilters"
  >
    <template v-if="$slots['heading-actions']" #heading-actions>
      <slot name="heading-actions" />
    </template>

    <template #filters>
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

    <template #grid>
      <CatalogCollectionGrid
        :items="filteredEntries"
        :item-key="(entry) => entry.id"
        :label="title"
        :minimum-column-width="minimumColumnWidth"
        :compact-minimum-column-width="Math.min(minimumColumnWidth, 108)"
        :selected-key="selectedKey"
        :scroll-key="`anon-tokyo-${queryKey}-grid`"
      >
        <template #item="{ item: entry }">
          <CollectionTileSurface
            :label="titleOf(entry)"
            :secondary-label="descriptionOf(entry)"
            :aspect-ratio="imageRatio === 'portrait' ? '3 / 4' : imageRatio === 'member' ? '4 / 5' : '1 / 1'"
            :selected="entry.id === selectedKey"
            @select="open(entry)"
          >
            <template #media>
              <TextFallbackMedia
                v-if="imageOf(entry)"
                :image="imageOf(entry)"
                :label="titleOf(entry)"
                :icon="icon"
                :fit="imageFit"
                :expand-image="exactImageSource"
              />
              <span v-else class="anon-tokyo-entity-catalog__empty-media" aria-hidden="true">
                <MaterialIcon :name="icon" :size="32" />
              </span>
            </template>
            <CollectionTileIdentity :title="titleOf(entry)" :subtitle="descriptionOf(entry)" />
          </CollectionTileSurface>
        </template>
      </CatalogCollectionGrid>
    </template>

    <template #list>
      <VirtualCollectionTable
        :items="filteredEntries"
        :item-key="(entry) => entry.id"
        :label="title"
        :row-height="64"
        :selected-key="selectedKey"
        :columns="tableColumns"
        :sort="sort"
        :order="order"
        :scroll-key="`anon-tokyo-${queryKey}-list`"
        @update:sort="setSort"
        @update:order="order = $event"
      >
        <template #row="{ item: entry, index, style }">
          <ResourceCatalogRow
            :style="style"
            :row-index="index"
            :identifier="entry.id"
            :title="titleOf(entry)"
            :subtitle="descriptionOf(entry)"
            :image="imageOf(entry)"
            :image-fit="imageFit"
            :media-icon="icon"
            :image-expander="exactImageSource"
            :fields="fieldsOf(entry)"
            :selected="entry.id === selectedKey"
            @select="open(entry)"
          />
        </template>
      </VirtualCollectionTable>
    </template>

    <template #overlay>
      <ResourceDetailSurface
        :open="Boolean(selected)"
        :title="selected ? titleOf(selected) : title"
        :facts="selected ? factsOf(selected) : []"
        :show-media="false"
        @close="close"
      >
        <template v-if="selected && imageOf(selected)" #media>
          <div class="anon-tokyo-entity-catalog__detail-media">
            <LoadingImage :src="imageOf(selected)" :alt="titleOf(selected)" :fit="imageFit" loading="eager" />
          </div>
        </template>
        <DetailSection v-if="selected && descriptionOf(selected)" :title="t('content')" icon="description">
          <p class="anon-tokyo-entity-catalog__description">{{ descriptionOf(selected) }}</p>
        </DetailSection>
      </ResourceDetailSurface>
    </template>
  </CatalogCollectionScreen>
</template>

<style scoped>
.anon-tokyo-entity-catalog__detail-media {
  display: grid;
  width: 100%;
  height: 100%;
  min-height: 220px;
  place-items: center;
  overflow: hidden;
  background: var(--md-sys-color-surface-container-low);
}

.anon-tokyo-entity-catalog__empty-media {
  display: grid;
  width: 100%;
  height: 100%;
  place-items: center;
  color: var(--md-sys-color-on-secondary-container);
  background: var(--md-sys-color-secondary-container);
}

.anon-tokyo-entity-catalog__detail-media > :deep(.loading-image) {
  display: block;
  width: 100%;
  height: 100%;
}

.anon-tokyo-entity-catalog__description {
  margin: 0;
  color: var(--md-sys-color-on-surface-variant);
  font: var(--md-sys-typescale-body-medium-weight) var(--md-sys-typescale-body-medium-size) /
    var(--md-sys-typescale-body-medium-line-height) var(--md-sys-typescale-body-medium-font);
  white-space: pre-wrap;
}

.anon-tokyo-entity-catalog__id {
  color: var(--md-sys-color-on-surface-variant);
  font: var(--md-sys-typescale-label-medium-weight) var(--md-sys-typescale-label-medium-size) /
    var(--md-sys-typescale-label-medium-line-height) var(--md-sys-typescale-label-medium-font);
}
</style>
