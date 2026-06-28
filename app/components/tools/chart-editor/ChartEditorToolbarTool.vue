<script setup lang="ts">
import { UiButton, UiIconButton } from "@haneoka/ui";

import type { ChartCanvasSkin } from "@haneoka/chart/overview";
import ChartEditorToolbarIcon from "./ChartEditorToolbarIcon.vue";

defineOptions({ inheritAttrs: false });

const props = withDefaults(
  defineProps<{
    icon: InstanceType<typeof ChartEditorToolbarIcon>["$props"]["icon"];
    iconText?: string;
    skin?: ChartCanvasSkin;
    label: string;
    shortcut?: string;
    showLabel?: boolean;
    playing?: boolean;
    disabled?: boolean;
  }>(),
  {
    iconText: "",
    skin: undefined,
    shortcut: "",
    showLabel: false,
    playing: false,
    disabled: false,
  },
);

const emit = defineEmits<{
  click: [event: MouseEvent];
  pointerover: [event: PointerEvent];
}>();
</script>

<template>
  <UiIconButton
    v-if="!showLabel"
    v-bind="$attrs"
    class="chart-toolbar-tool"
    size="compact"
    :label="label"
    :disabled="disabled"
    @click="emit('click', $event)"
    @pointerover="emit('pointerover', $event)"
  >
    <ChartEditorToolbarIcon :icon="props.icon" :text="iconText" :skin="skin" :playing="playing" />
  </UiIconButton>
  <UiButton
    v-else
    v-bind="$attrs"
    class="chart-toolbar-tool chart-toolbar-tool--label"
    tone="text"
    :disabled="disabled"
    @click="emit('click', $event)"
    @pointerover="emit('pointerover', $event)"
  >
    <template #icon>
      <ChartEditorToolbarIcon :icon="props.icon" :text="iconText" :skin="skin" :playing="playing" />
    </template>
    <span class="chart-toolbar-tool__label">{{ label }}</span>
    <span v-if="shortcut" class="chart-toolbar-tool__shortcut">{{ shortcut }}</span>
  </UiButton>
</template>

<style scoped>
.chart-toolbar-tool {
  --md-comp-icon-button-hit-size: var(--md-comp-control-height-compact);
  --md-comp-icon-button-visual-size: var(--md-comp-control-height-compact);
  --md-icon-button-container-color: var(--md-sys-color-surface-container-high);
  --md-icon-button-icon-color: var(--md-sys-color-on-surface-variant);
  border-radius: var(--md-sys-shape-corner-full);
  background: var(--md-sys-color-surface-container-high);
  box-shadow: var(--md-sys-elevation-level1);
}

.chart-toolbar-tool:disabled,
.chart-toolbar-tool.is-disabled {
  opacity: 0.35;
  cursor: default;
  transform: none;
}

.chart-toolbar-tool--label {
  width: 100%;
  min-width: 176px;
  min-height: var(--md-comp-control-height-compact);
  justify-content: flex-start;
  --md-comp-control-height: var(--md-comp-control-height-compact);
  --md-text-button-container-height: var(--md-comp-control-height-compact);
  --md-text-button-container-shape: var(--md-sys-shape-corner-small);
  --md-text-button-leading-space: var(--md-sys-spacing-2);
  --md-text-button-trailing-space: var(--md-sys-spacing-2);
  --md-text-button-label-text-color: var(--md-sys-color-on-surface-variant);
  background: transparent;
  box-shadow: none;
}

.chart-toolbar-tool--label:hover,
.chart-toolbar-tool--label:focus-visible {
  box-shadow: none;
}

.chart-toolbar-tool__label {
  min-width: 0;
  flex: 1 1 auto;
  margin-left: 7px;
  font-size: var(--md-sys-typescale-label-medium-size);
  text-align: left;
  white-space: nowrap;
}

.chart-toolbar-tool__shortcut {
  margin-left: 14px;
  color: var(--md-sys-color-outline);
  font-family: var(--md-sys-typescale-label-small-font);
  font-size: var(--md-sys-typescale-label-small-size);
  line-height: 1;
  white-space: nowrap;
}
</style>
