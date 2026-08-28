<script setup lang="ts">
import { MaterialIcon, UiIconButton, UiRuntimeSurface } from "@haneoka/ui";

withDefaults(defineProps<{ label: string; closeLabel?: string }>(), { closeLabel: "Close" });

const open = defineModel<boolean>({ default: false });
</script>

<template>
  <Transition name="runtime-viewer-settings">
    <UiRuntimeSurface v-if="open" as="aside" class="runtime-viewer-settings-panel" :label="label" variant="panel">
      <header class="runtime-viewer-settings-panel__header">
        <strong>{{ label }}</strong>
        <UiIconButton :label="closeLabel" tone="runtime" touch-target @click="open = false">
          <MaterialIcon name="close" :size="20" />
        </UiIconButton>
      </header>
      <div class="runtime-viewer-settings-panel__content">
        <slot />
      </div>
    </UiRuntimeSurface>
  </Transition>
</template>

<style scoped>
.runtime-viewer-settings-panel {
  position: absolute;
  z-index: var(--md-sys-z-index-overlay-sheet);
  top: var(--md-sys-spacing-2);
  right: var(--md-sys-spacing-2);
  bottom: var(--md-sys-spacing-2);
  display: grid;
  width: min(340px, calc(100% - var(--md-sys-spacing-4)));
  min-width: 0;
  min-height: 0;
  max-height: calc(100% - var(--md-sys-spacing-4));
  grid-template-rows: auto minmax(0, 1fr);
  gap: var(--md-sys-spacing-2);
  padding: var(--md-sys-spacing-2);
  overflow: hidden;
  border-radius: var(--md-sys-shape-corner-medium);
}

.runtime-viewer-settings-panel__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--md-sys-spacing-2);
  color: var(--md-comp-runtime-on-surface);
  font-family: var(--md-sys-typescale-title-small-font);
  font-size: var(--md-sys-typescale-title-small-size);
  font-weight: var(--md-sys-typescale-title-small-weight);
  line-height: var(--md-sys-typescale-title-small-line-height);
}

.runtime-viewer-settings-panel__content {
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

@media (max-width: 560px) {
  .runtime-viewer-settings-panel {
    top: var(--md-sys-spacing-1);
    right: var(--md-sys-spacing-1);
    bottom: var(--md-sys-spacing-1);
    left: var(--md-sys-spacing-1);
    width: auto;
    max-height: none;
  }
}

.runtime-viewer-settings-enter-active,
.runtime-viewer-settings-leave-active {
  transition:
    opacity var(--md-sys-motion-duration-medium2) var(--md-sys-motion-easing-emphasized-decelerate),
    transform var(--md-sys-motion-duration-medium2) var(--md-sys-motion-easing-emphasized-decelerate);
}

.runtime-viewer-settings-enter-from,
.runtime-viewer-settings-leave-to {
  opacity: 0;
  transform: translateY(8px) scale(0.98);
}
</style>
