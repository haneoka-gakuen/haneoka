<script setup lang="ts" generic="T extends string | number">
import { MaterialIcon, UiIconButton, UiSelect, type UiFieldValue, type UiSelectOption } from "@haneoka/ui";

export interface CatalogSortOption<T> {
  value: T;
  label: string;
  icon?: string;
}

const props = defineProps<{
  modelValue: T;
  order: "asc" | "desc";
  options: CatalogSortOption<T>[];
  label: string;
  ascendingLabel: string;
  descendingLabel: string;
}>();

const emit = defineEmits<{
  "update:modelValue": [value: T];
  "update:order": [value: "asc" | "desc"];
}>();

const { t } = useLocale();
const sortOptions = computed<UiSelectOption[]>(() => props.options);
const orderLabel = computed(() => (props.order === "asc" ? props.ascendingLabel : props.descendingLabel));
const orderIcon = computed(() => (props.order === "asc" ? "arrow_upward" : "arrow_downward"));
const updateSort = (value: UiFieldValue) => emit("update:modelValue", value as T);
const toggleOrder = () => emit("update:order", props.order === "asc" ? "desc" : "asc");
</script>

<template>
  <fieldset class="catalog-sort">
    <legend class="meta-label">{{ label }}</legend>
    <div class="catalog-sort__controls">
      <UiSelect
        :model-value="modelValue"
        :options="sortOptions"
        :label="label"
        class="catalog-sort__key"
        @update:model-value="updateSort"
      />
      <UiIconButton
        class="catalog-sort__order"
        :label="`${t('order')}: ${orderLabel}`"
        size="compact"
        touch-target
        @click="toggleOrder"
      >
        <MaterialIcon :name="orderIcon" :size="22" />
      </UiIconButton>
    </div>
  </fieldset>
</template>

<style scoped>
.catalog-sort {
  min-width: 0;
  padding: 0;
  margin: 0;
  border: 0;
}

.catalog-sort legend {
  width: 100%;
  margin-bottom: 8px;
}

.catalog-sort__controls {
  display: grid;
  min-width: 0;
  grid-template-columns: minmax(0, 1fr) var(--md-comp-control-height-touch);
  align-items: center;
  gap: var(--md-sys-spacing-2);
}

.catalog-sort__key {
  width: 100%;
  min-width: 0;
}

.catalog-sort__order {
  justify-self: end;
}
</style>
