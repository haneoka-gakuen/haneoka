<script setup lang="ts">
import type { CSSProperties } from "vue";

const props = withDefaults(
  defineProps<{
    as?: "div" | "main" | "section";
    maxWidth?: string;
    spacing?: "compact" | "default" | "none";
  }>(),
  {
    as: "main",
    maxWidth: "1280px",
    spacing: "default",
  },
);

const surfaceStyle = computed(
  () =>
    ({
      "--page-content-max-width": props.maxWidth,
    }) as CSSProperties,
);
</script>

<template>
  <component :is="as" class="page-content-surface" :class="`has-${spacing}-spacing`" :style="surfaceStyle">
    <div class="page-content-surface__inner">
      <slot />
    </div>
  </component>
</template>

<style scoped>
.page-content-surface {
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  padding: var(--md-comp-page-block-space) max(var(--md-comp-page-inline-space), var(--md-sys-safe-area-inset-right))
    var(--md-comp-page-block-space) max(var(--md-comp-page-inline-space), var(--md-sys-safe-area-inset-left));
  overflow: auto;
  color: var(--md-sys-color-on-surface);
  background: var(--md-sys-color-surface);
  overscroll-behavior: contain;
  scrollbar-width: thin;
}

.page-content-surface.has-none-spacing {
  padding: 0;
}

.page-content-surface__inner {
  display: grid;
  width: min(100%, var(--page-content-max-width));
  min-width: 0;
  margin-inline: auto;
  align-content: start;
  gap: var(--md-sys-spacing-4);
}

.has-compact-spacing > .page-content-surface__inner {
  gap: var(--md-sys-spacing-3);
}

.has-none-spacing > .page-content-surface__inner {
  width: 100%;
  height: 100%;
  gap: 0;
}
</style>
