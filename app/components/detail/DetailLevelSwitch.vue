<script setup lang="ts">
import { MaterialIcon, UiIconButton, UiRange } from "@haneoka/ui";

const props = defineProps<{
  modelValue: number;
  levels: number[];
  label: string;
}>();

const emit = defineEmits<{
  "update:modelValue": [value: number];
}>();

const sortedLevels = computed(() => [...new Set(props.levels)].sort((left, right) => left - right));
const currentIndex = computed(() => Math.max(0, sortedLevels.value.indexOf(props.modelValue)));

const selectIndex = (index: number) => {
  const next = sortedLevels.value[Math.min(Math.max(index, 0), sortedLevels.value.length - 1)];
  if (next !== undefined) emit("update:modelValue", next);
};
</script>

<template>
  <div v-if="sortedLevels.length" class="detail-level-switch">
    <span class="detail-level-switch__value display-number">
      <small>{{ label }}</small>
      <strong>{{ modelValue }}</strong>
    </span>
    <UiIconButton
      size="compact"
      touch-target
      :label="`${label} ${sortedLevels[Math.max(0, currentIndex - 1)] ?? modelValue}`"
      :disabled="currentIndex === 0"
      @click="selectIndex(currentIndex - 1)"
    >
      <MaterialIcon name="remove" :size="18" />
    </UiIconButton>
    <UiRange
      :model-value="currentIndex"
      :min="0"
      :max="Math.max(0, sortedLevels.length - 1)"
      :step="1"
      :label="label"
      :aria-value-text="String(modelValue)"
      @update:model-value="selectIndex"
    />
    <UiIconButton
      size="compact"
      touch-target
      :label="`${label} ${sortedLevels[Math.min(sortedLevels.length - 1, currentIndex + 1)] ?? modelValue}`"
      :disabled="currentIndex === sortedLevels.length - 1"
      @click="selectIndex(currentIndex + 1)"
    >
      <MaterialIcon name="add" :size="18" />
    </UiIconButton>
  </div>
</template>

<style scoped>
.detail-level-switch {
  display: grid;
  min-height: var(--md-comp-control-height-touch);
  grid-template-columns: auto var(--md-comp-control-height-touch) minmax(80px, 1fr) var(--md-comp-control-height-touch);
  align-items: center;
  gap: var(--md-sys-spacing-1);
  padding: 0 var(--md-sys-spacing-1) 0 var(--md-sys-spacing-3);
  border: 1px solid var(--md-sys-color-outline-variant);
  border-radius: var(--md-sys-shape-corner-small);
  background: var(--md-sys-color-surface-container-lowest);
}

.detail-level-switch__value {
  display: inline-flex;
  min-width: 58px;
  align-items: baseline;
  gap: var(--md-sys-spacing-2);
}

.detail-level-switch__value small {
  color: var(--md-sys-color-outline);
  font-family: var(--md-sys-typescale-label-small-font);
  font-size: var(--md-sys-typescale-label-small-size);
  font-weight: var(--md-sys-typescale-label-small-weight);
  line-height: var(--md-sys-typescale-label-small-line-height);
}

.detail-level-switch__value strong {
  color: var(--md-comp-detail-accent);
  font-family: var(--md-sys-typescale-title-small-font);
  font-size: var(--md-sys-typescale-title-small-size);
  font-weight: var(--md-sys-typescale-title-small-weight);
  line-height: var(--md-sys-typescale-title-small-line-height);
}

.detail-level-switch :deep(.md3-range) {
  width: 100%;
  min-width: 0;
  --md-slider-active-track-color: var(--md-comp-detail-accent);
  --md-slider-handle-color: var(--md-comp-detail-accent);
}
</style>
