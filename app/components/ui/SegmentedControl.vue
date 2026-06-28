<script setup lang="ts" generic="T extends string | number">
import { UiSegmentedControl, type UiFieldValue, type UiSegmentOption } from "@haneoka/ui";

export interface SegmentOption<T> {
  value: T;
  label: string;
  ariaLabel?: string;
  icon?: string;
  image?: string;
  imageFit?: "contain" | "cover";
  semanticColor?: string;
  selectedIcon?: string;
}

const props = defineProps<{
  modelValue: T;
  options: readonly SegmentOption<T>[];
  label: string;
  density?: "compact" | "standard";
  iconOnly?: boolean;
  touchTarget?: boolean;
}>();

const emit = defineEmits<{
  "update:modelValue": [value: T];
}>();

const options = computed<readonly UiSegmentOption[]>(() => props.options);
const update = (value: UiFieldValue) => emit("update:modelValue", value as T);
</script>

<template>
  <UiSegmentedControl
    :model-value="modelValue"
    :options="options"
    :label="label"
    :density="density"
    :icon-only="iconOnly"
    :touch-target="touchTarget"
    @update:model-value="update"
  />
</template>
