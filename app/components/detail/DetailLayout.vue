<script setup lang="ts">
withDefaults(
  defineProps<{
    /** Omit the media pane for text-only/resource-only detail surfaces. */
    media?: boolean;
  }>(),
  { media: true },
);
</script>

<template>
  <article class="detail-layout" :class="{ 'has-media': media }">
    <section v-if="media" class="detail-layout__media">
      <slot name="media" />
    </section>
    <main class="detail-layout__content">
      <slot />
    </main>
  </article>
</template>

<style scoped>
/*
 * The single split-detail primitive used by catalog details. Domain
 * components provide media and sections; this component alone owns columns,
 * scrolling, spacing, and the narrow-screen collapse.
 */
.detail-layout {
  display: block;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
}

.detail-layout.has-media {
  display: grid;
  grid-template-columns: minmax(240px, 0.85fr) minmax(0, 1.15fr);
  gap: var(--md-sys-spacing-4);
}

.detail-layout__media,
.detail-layout__content {
  min-width: 0;
  min-height: 0;
}

.detail-layout__media {
  position: relative;
  display: grid;
  place-items: center;
  overflow: hidden;
  border-radius: var(--md-sys-shape-corner-medium);
  background: var(--md-sys-color-surface-container-low);
}

.detail-layout__content {
  display: flex;
  flex-direction: column;
  gap: var(--md-sys-spacing-3);
  padding: var(--md-sys-spacing-1) var(--md-sys-spacing-2) var(--md-sys-spacing-4) 0;
  overflow: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
}

@media (max-width: 760px) {
  .detail-layout,
  .detail-layout.has-media {
    height: auto;
    min-height: 100%;
  }

  .detail-layout.has-media {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: auto auto;
    gap: var(--md-sys-spacing-3);
  }

  .detail-layout__media {
    min-height: min(52dvh, 430px);
    overflow: visible;
  }

  .detail-layout__content {
    padding: 0 2px var(--md-sys-spacing-2);
    overflow: visible;
  }
}
</style>
