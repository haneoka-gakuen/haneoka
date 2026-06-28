<script setup lang="ts" generic="T">
import type { CollectionTableColumn } from "~/components/catalog/CollectionTableHeader.vue";

type CollectionKey = string | number;

const props = withDefaults(
  defineProps<{
    items: readonly T[];
    itemKey: (item: T) => CollectionKey;
    label: string;
    rowHeight: number;
    columns: CollectionTableColumn[];
    sort: string;
    order: "asc" | "desc";
    selectedKey?: CollectionKey | null;
    threshold?: number;
    overscanRows?: number;
    scrollKey?: string;
    /** Render in normal document flow instead of a fixed workspace stage. */
    flow?: boolean;
  }>(),
  { threshold: 120, overscanRows: 10, selectedKey: undefined, scrollKey: undefined, flow: false },
);

const emit = defineEmits<{
  "update:sort": [value: string];
  "update:order": [value: "asc" | "desc"];
}>();

// One table owns its geometry. Columns stay at their intrinsic max-content
// width, except for one semantic primary column which absorbs spare stage
// space. Callers never provide widths, weights, or grid strings. `title` is the
// shared default; non-title tables can opt in with `semantic: "primary"`.
const primaryColumnKey = computed(
  () =>
    props.columns.find((column) => column.semantic === "primary")?.key ??
    props.columns.find((column) => column.key === "title")?.key,
);

const gridTemplateColumns = computed(() =>
  props.columns
    .map((column) => (column.key === primaryColumnKey.value ? "minmax(max-content, 1fr)" : "max-content"))
    .join(" "),
);

const tableStyle = computed(() => ({
  "--md-comp-collection-table-columns": gridTemplateColumns.value,
}));
</script>

<template>
  <VirtualCollectionRows
    :items="items"
    :item-key="itemKey"
    :label="label"
    :row-height="rowHeight"
    :selected-key="selectedKey"
    :threshold="threshold"
    :overscan-rows="overscanRows"
    :scroll-key="scrollKey"
    :flow="flow"
    :style="tableStyle"
  >
    <template #header>
      <CollectionTableHeader
        :model-value="sort"
        :order="order"
        :columns="columns"
        @update:model-value="emit('update:sort', $event)"
        @update:order="emit('update:order', $event)"
      />
    </template>

    <template #row="entry">
      <slot name="row" v-bind="entry" />
    </template>
  </VirtualCollectionRows>
</template>
