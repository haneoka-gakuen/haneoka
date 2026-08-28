<script setup lang="ts">
import { UiRuntimeSurface } from "@haneoka/ui";

withDefaults(
  defineProps<{
    /** Describes both the rendered model and its playback controls. */
    label: string;
    busy?: boolean;
    /** Keep the dock out of loading and error states. */
    showControls?: boolean;
  }>(),
  { busy: false, showControls: true },
);
</script>

<template>
  <section class="runtime-viewer-surface" :aria-label="label" :aria-busy="busy">
    <div class="runtime-viewer-surface__canvas">
      <slot />
    </div>
    <UiRuntimeSurface v-if="showControls" class="runtime-viewer-surface__toolbar" :label="label" variant="toolbar">
      <div class="runtime-viewer-surface__toolbar-content">
        <slot name="controls" />
      </div>
    </UiRuntimeSurface>
  </section>
</template>

<style scoped>
.runtime-viewer-surface {
  position: relative;
  display: grid;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  grid-template-columns: minmax(0, 1fr) auto;
  grid-template-rows: minmax(0, 1fr);
  background: var(--md-sys-color-surface-container-low);
  isolation: isolate;
}

.runtime-viewer-surface__canvas {
  position: relative;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.runtime-viewer-surface__toolbar {
  position: relative;
  z-index: var(--md-sys-z-index-overlay-drawer);
  display: grid;
  align-content: start;
  height: 100%;
  min-width: 0;
  overflow: hidden auto;
  border: 0;
  border-left: 1px solid var(--md-sys-color-outline-variant);
  border-radius: 0;
  background: var(--md-sys-color-surface-container);
  box-shadow: none;
  scrollbar-width: thin;
}

.runtime-viewer-surface__toolbar-content {
  display: flex;
  min-width: 0;
  flex-direction: column;
  align-items: stretch;
  gap: var(--md-sys-spacing-2);
  padding: var(--md-sys-spacing-3);
}

.runtime-viewer-surface__toolbar-content > :deep(.ui-select),
.runtime-viewer-surface__toolbar-content > :deep(*) {
  min-width: 0;
}

@media (max-width: 700px) {
  .runtime-viewer-surface {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: minmax(0, 1fr) auto;
  }

  .runtime-viewer-surface__toolbar {
    max-height: 40%;
    border-left: 0;
    border-top: 1px solid var(--md-sys-color-outline-variant);
  }
}

.runtime-viewer-surface__toolbar-content > :deep(.ui-select) {
  width: min(220px, 40vw);
  min-width: 0;
  flex: 1 1 160px;
}

@container (max-width: 560px) {
  .runtime-viewer-surface {
    grid-template-rows: minmax(0, 1fr) auto;
    border-radius: 0;
  }

  .runtime-viewer-surface__toolbar {
    position: relative;
    right: auto;
    bottom: auto;
    box-sizing: border-box;
    width: 100%;
    max-width: none;
    min-height: calc(var(--md-comp-runtime-toolbar-height-touch) + env(safe-area-inset-bottom));
    padding: var(--md-comp-runtime-toolbar-padding) max(var(--md-sys-spacing-2), env(safe-area-inset-right))
      calc(var(--md-comp-runtime-toolbar-padding) + env(safe-area-inset-bottom))
      max(var(--md-sys-spacing-2), env(safe-area-inset-left));
    border-width: 1px 0 0;
    border-radius: 0;
  }

  .runtime-viewer-surface__toolbar-content {
    width: 100%;
  }

  .runtime-viewer-surface__toolbar-content > :deep(.ui-select) {
    width: auto;
    min-width: 0;
    flex: 1 1 auto;
  }

  .runtime-viewer-surface__toolbar-content > :deep(.md3-icon-button--runtime) {
    --md-comp-icon-button-hit-size: var(--md-comp-control-height-touch);
    --md-comp-icon-button-visual-size: var(--md-comp-runtime-control-size-touch);
  }
}
</style>
