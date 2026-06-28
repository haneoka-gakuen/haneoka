<script setup lang="ts" generic="T extends string | number">
import type { SegmentOption } from "./SegmentedControl.vue";

defineProps<{
  modelValue: T;
  options: readonly SegmentOption<T>[];
  label: string;
  compact?: boolean;
  iconOnly?: boolean;
  touchTarget?: boolean;
}>();

defineEmits<{
  "update:modelValue": [value: T];
}>();
</script>

<template>
  <SegmentedControl
    class="view-mode-control"
    :model-value="modelValue"
    :options="options"
    :label="label"
    :class="{ 'is-compact': compact }"
    :density="compact ? 'compact' : 'standard'"
    :icon-only="iconOnly"
    :touch-target="touchTarget"
    @update:model-value="$emit('update:modelValue', $event)"
  />
</template>

<style scoped>
.view-mode-control :deep(.md3-segments__option) {
  --md-outlined-segmented-button-outline-color: var(--md-sys-color-outline-variant);
}

@media (max-width: 839px) {
  .view-mode-control.is-compact :deep(.md3-segments__option) {
    width: var(--md-comp-control-height);
    flex: 0 0 var(--md-comp-control-height);
    --md-outlined-segmented-button-label-text-line-height: var(--md-sys-typescale-label-medium-line-height);
    --md-outlined-segmented-button-label-text-size: var(--md-sys-typescale-label-medium-size);
  }
}

@media (max-width: 599px) {
  .view-mode-control.is-compact.is-icon-only :deep(.md3-segments__option) {
    width: 44px;
    flex-basis: 44px;
    --md-outlined-segmented-button-icon-size: 20px;
  }
}
</style>
