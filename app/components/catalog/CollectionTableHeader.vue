<script setup lang="ts">
import { MaterialIcon, UiButton } from "@haneoka/ui";

export interface CollectionTableColumn {
  key: string;
  label: string;
  sortable?: boolean;
  align?: "start" | "center" | "end";
  /** Only true icon/action columns retain their intrinsic width. */
  kind?: "icon" | "action";
  /** The single semantic content column that may absorb spare inline space. */
  semantic?: "primary";
}

const props = defineProps<{
  columns: CollectionTableColumn[];
  modelValue: string;
  order: "asc" | "desc";
}>();

const emit = defineEmits<{
  "update:modelValue": [value: string];
  "update:order": [value: "asc" | "desc"];
}>();

const ariaSort = (column: CollectionTableColumn) => {
  if (!column.sortable) return undefined;
  if (column.key !== props.modelValue) return "none" as const;
  return props.order === "asc" ? ("ascending" as const) : ("descending" as const);
};

const alignmentOf = (column: CollectionTableColumn) => column.align ?? (column.key === "title" ? "start" : "center");

const selectColumn = (column: CollectionTableColumn) => {
  if (!column.sortable) return;
  if (column.key === props.modelValue) {
    emit("update:order", props.order === "asc" ? "desc" : "asc");
    return;
  }
  emit("update:modelValue", column.key);
  emit("update:order", "desc");
};
</script>

<template>
  <div class="collection-table-header collection-table-track" role="row" aria-rowindex="1">
    <div
      v-for="column in columns"
      :key="column.key"
      class="collection-table-header__cell"
      :class="[`is-${alignmentOf(column)}`, { 'is-active': column.key === modelValue }]"
      role="columnheader"
      :aria-sort="ariaSort(column)"
    >
      <UiButton v-if="column.sortable" tone="text" @click="selectColumn(column)">
        <span>{{ column.label }}</span>
        <MaterialIcon name="arrow_upward" v-if="column.key === modelValue && order === 'asc'" aria-hidden="true" />
        <MaterialIcon name="arrow_downward" v-else-if="column.key === modelValue" aria-hidden="true" />
        <MaterialIcon name="unfold_more" v-else aria-hidden="true" />
      </UiButton>
      <span v-else>{{ column.label }}</span>
    </div>
  </div>
</template>

<style scoped>
.collection-table-header {
  position: sticky;
  z-index: 6;
  top: 0;
  display: grid;
  grid-column: 1 / -1;
  grid-template-columns: subgrid;
  min-height: 36px;
  align-items: stretch;
  padding: 0 var(--md-comp-collection-table-inline-inset, 7px);
  border-bottom: 1px solid var(--md-sys-color-outline-variant);
  background: var(--md-sys-color-surface-container);
}

.collection-table-header__cell {
  display: flex;
  min-width: 0;
  align-items: center;
  color: var(--md-sys-color-on-surface-variant);
  font-family: var(--md-sys-typescale-label-small-font);
  font-size: var(--md-sys-typescale-label-small-size);
  font-weight: var(--md-sys-typescale-label-small-weight);
  line-height: var(--md-sys-typescale-label-small-line-height);
}

.collection-table-header__cell.is-center,
.collection-table-header__cell.is-center :deep(.md3-button) {
  justify-content: center;
  text-align: center;
}

.collection-table-header__cell.is-start,
.collection-table-header__cell.is-start :deep(.md3-button) {
  justify-content: flex-start;
  text-align: left;
}

.collection-table-header__cell.is-start :deep(.md3-button) {
  width: auto;
}

.collection-table-header__cell.is-end,
.collection-table-header__cell.is-end :deep(.md3-button) {
  justify-content: flex-end;
  text-align: right;
}

.collection-table-header__cell :deep(.md3-button) {
  display: flex;
  width: 100%;
  min-height: 35px;
  min-width: 0;
  align-items: center;
  gap: 3px;
  --md-text-button-container-height: 35px;
  --md-text-button-leading-space: 0;
  --md-text-button-trailing-space: 0;
  --md-text-button-label-text-color: currentColor;

  color: inherit;
  font: inherit;
  letter-spacing: 0;
  padding: 0;
  text-align: left;
  cursor: pointer;
}

.collection-table-header__cell :deep(.md3-button span) {
  min-width: 0;
  overflow-wrap: anywhere;
}

.collection-table-header__cell :deep(.md3-material-icon) {
  flex: 0 0 auto;
  opacity: 0.48;
}

.collection-table-header__cell.is-active {
  color: var(--md-sys-color-primary);
}

.collection-table-header__cell.is-active :deep(.md3-material-icon) {
  opacity: 0.9;
}

.collection-table-header__cell :deep(.md3-button:hover) {
  color: var(--md-sys-color-primary);
}
</style>
