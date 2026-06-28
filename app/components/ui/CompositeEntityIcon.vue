<script setup lang="ts">
import type { CompositeEntityVisual } from "~/types/compositeVisual";

const props = withDefaults(
  defineProps<{
    items: readonly CompositeEntityVisual[];
    label?: string;
    transparentBackground?: boolean;
  }>(),
  { label: undefined, transparentBackground: false },
);

const displayedItems = computed(() => {
  if (props.items.length <= 4) return props.items;
  return [...props.items.slice(0, 3), { text: `+${props.items.length - 3}` } satisfies CompositeEntityVisual];
});
</script>

<template>
  <span
    class="composite-entity-icon"
    :class="[`has-${displayedItems.length}-items`, { 'has-transparent-background': transparentBackground }]"
    :role="label ? 'img' : undefined"
    :aria-label="label || undefined"
    :aria-hidden="label ? undefined : 'true'"
  >
    <EntityAvatar
      v-for="(item, index) in displayedItems"
      :key="`${item.image || item.text || item.icon || 'fallback'}:${index}`"
      class="composite-entity-icon__item"
      :class="{ 'is-transparent': transparentBackground }"
      :image="item.image"
      :image-candidates="item.imageCandidates"
      :text="item.text"
      :lang="item.lang"
      :icon="item.icon || 'group'"
      :fit="item.fit"
      :color="item.color"
    />
  </span>
</template>

<style scoped>
.composite-entity-icon {
  position: relative;
  display: block;
  width: 100%;
  height: 100%;
  overflow: hidden;
  border-radius: var(--md-sys-shape-corner-full);
  background: var(--md-sys-color-surface-container-highest);
}

.composite-entity-icon.has-transparent-background {
  background: transparent;
}

.composite-entity-icon__item {
  position: absolute;
  border: 1px solid var(--md-sys-color-surface-container-highest);
}

.composite-entity-icon__item.is-transparent {
  border-color: transparent;
  background: transparent;
}

.composite-entity-icon.has-1-items .composite-entity-icon__item {
  inset: 0;
  --entity-avatar-font-size: var(--md-sys-typescale-label-large-size);
}

.composite-entity-icon.has-2-items .composite-entity-icon__item {
  width: 68%;
  height: 68%;
  --entity-avatar-font-size: 9px;
}

.composite-entity-icon.has-2-items .composite-entity-icon__item:first-child {
  top: 0;
  left: 0;
}

.composite-entity-icon.has-2-items .composite-entity-icon__item:last-child {
  right: 0;
  bottom: 0;
}

.composite-entity-icon.has-3-items .composite-entity-icon__item {
  width: 59%;
  height: 59%;
  --entity-avatar-font-size: 8px;
}

.composite-entity-icon.has-3-items .composite-entity-icon__item:nth-child(1) {
  top: 0;
  left: 20.5%;
}

.composite-entity-icon.has-3-items .composite-entity-icon__item:nth-child(2) {
  bottom: 0;
  left: 0;
}

.composite-entity-icon.has-3-items .composite-entity-icon__item:nth-child(3) {
  right: 0;
  bottom: 0;
}

.composite-entity-icon.has-4-items .composite-entity-icon__item {
  width: 52%;
  height: 52%;
  --entity-avatar-font-size: 8px;
}

.composite-entity-icon.has-4-items .composite-entity-icon__item:nth-child(1) {
  top: 0;
  left: 0;
}

.composite-entity-icon.has-4-items .composite-entity-icon__item:nth-child(2) {
  top: 0;
  right: 0;
}

.composite-entity-icon.has-4-items .composite-entity-icon__item:nth-child(3) {
  bottom: 0;
  left: 0;
}

.composite-entity-icon.has-4-items .composite-entity-icon__item:nth-child(4) {
  right: 0;
  bottom: 0;
}
</style>
