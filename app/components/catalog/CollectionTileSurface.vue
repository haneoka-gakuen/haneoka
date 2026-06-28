<script setup lang="ts">
import type { RouteLocationRaw } from "vue-router";
import type { DisplayText } from "~/types/displayText";

const props = withDefaults(
  defineProps<{
    label: DisplayText;
    secondaryLabel?: DisplayText;
    aspectRatio?: string;
    orientation?: "vertical" | "horizontal";
    density?: "comfortable" | "compact";
    selected?: boolean;
    to?: RouteLocationRaw;
  }>(),
  { secondaryLabel: "", orientation: "vertical", density: "comfortable", selected: false, to: undefined },
);

const emit = defineEmits<{ select: [] }>();
const labelId = useId();
const rootComponent = computed(() => (props.to ? resolveComponent("NuxtLink") : "button"));
const rootAttributes = computed(() =>
  props.to
    ? { to: props.to, "aria-current": props.selected ? "true" : undefined }
    : { type: "button", "aria-pressed": props.selected },
);
</script>

<template>
  <md-filled-card
    class="collection-tile-surface"
    :class="{
      'is-horizontal': orientation === 'horizontal',
      'is-compact': density === 'compact',
      'is-selected': selected,
    }"
    :style="props.aspectRatio ? { '--md-comp-collection-tile-aspect-ratio': props.aspectRatio } : undefined"
  >
    <component
      :is="rootComponent"
      v-bind="rootAttributes"
      class="collection-tile-surface__action"
      :aria-labelledby="labelId"
      @click="emit('select')"
    >
      <md-ripple />
      <span :id="labelId" class="sr-only">
        <DisplayText :value="label" />
        <template v-if="secondaryLabel">
          ·
          <DisplayText :value="secondaryLabel" />
        </template>
      </span>
      <span class="collection-tile-surface__media"><slot name="media" /></span>
      <span class="collection-tile-surface__metadata">
        <slot>
          <CollectionTileIdentity :title="label" :subtitle="secondaryLabel" />
        </slot>
      </span>
    </component>
  </md-filled-card>
</template>

<style scoped>
.collection-tile-surface {
  width: 100%;
  border-radius: var(--md-sys-shape-corner-medium);
  content-visibility: auto;
  contain-intrinsic-size: auto 220px 320px;
  --md-filled-card-container-color: var(--md-sys-color-surface-container-lowest);
  --md-filled-card-container-elevation: 0;
}

.collection-tile-surface.is-selected {
  --md-filled-card-container-color: var(--md-sys-color-secondary-container);
}

.collection-tile-surface__action {
  position: relative;
  display: grid;
  width: 100%;
  padding: 0;
  color: inherit;
  border: 0;
  border-radius: inherit;
  background: transparent;
  text-align: left;
  cursor: pointer;
}

.collection-tile-surface__media {
  position: relative;
  display: block;
  width: 100%;
  aspect-ratio: var(--md-comp-collection-tile-aspect-ratio, auto);
  overflow: hidden;
  border-radius: var(--md-sys-shape-corner-medium) var(--md-sys-shape-corner-medium) 0 0;
  background: var(--md-sys-color-surface-container-low);
}

.collection-tile-surface__metadata {
  display: flex;
  min-width: 0;
  align-items: center;
  padding: var(--md-sys-spacing-2);
}

/*
 * The plain media/title/subtitle form is intentionally part of the base
 * surface. It lets artwork, stamps, and other one-image catalog entries use
 * the same native card without introducing a page-specific tile wrapper.
 */
.collection-tile-surface__media > :slotted(img) {
  display: block;
  width: 100%;
  height: auto;
}

.collection-tile-surface__metadata > :slotted(strong) {
  display: -webkit-box;
  min-width: 0;
  min-block-size: calc(
    var(--md-sys-typescale-label-medium-line-height) + var(--md-sys-typescale-label-medium-line-height)
  );
  overflow: hidden;
  overflow-wrap: anywhere;
  color: var(--md-sys-color-on-surface);
  font-family: var(--md-sys-typescale-label-medium-font);
  font-size: var(--md-sys-typescale-label-medium-size);
  font-weight: var(--md-sys-typescale-label-medium-weight);
  line-height: var(--md-sys-typescale-label-medium-line-height);
  text-overflow: ellipsis;
  white-space: normal;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

/*
 * A shared compact-media variant for catalog entities whose image is an
 * identifier, rather than the primary artwork.  It keeps the filled-card
 * semantics while using the same responsive media slot on every caller.
 */
.collection-tile-surface.is-horizontal {
  --md-comp-collection-tile-inline-media-size: 92px;
}

.collection-tile-surface.is-horizontal.is-compact {
  --md-comp-collection-tile-inline-media-size: 72px;
}

.collection-tile-surface.is-horizontal .collection-tile-surface__action {
  min-height: calc(var(--md-comp-collection-tile-inline-media-size) + var(--md-sys-spacing-4));
  grid-template-columns: var(--md-comp-collection-tile-inline-media-size) minmax(0, 1fr);
  align-items: center;
  gap: var(--md-sys-spacing-3);
  padding: var(--md-sys-spacing-2);
}

.collection-tile-surface.is-horizontal .collection-tile-surface__media {
  display: grid;
  width: var(--md-comp-collection-tile-inline-media-size);
  height: var(--md-comp-collection-tile-inline-media-size);
  grid-column: 1;
  grid-row: 1;
  align-self: center;
  place-items: center;
  border-radius: var(--md-sys-shape-corner-medium);
}

.collection-tile-surface.is-horizontal .collection-tile-surface__media > :slotted(img) {
  display: block;
  max-width: 100%;
  max-height: 100%;
  width: auto;
  height: auto;
}

.collection-tile-surface.is-horizontal .collection-tile-surface__metadata {
  min-width: 0;
  grid-column: 2;
  grid-row: 1;
  align-items: stretch;
  padding: 0;
}

.collection-tile-surface md-ripple {
  z-index: 10;
  border-radius: inherit;
  --md-ripple-hover-color: var(--md-sys-color-on-surface);
  --md-ripple-pressed-color: var(--md-sys-color-primary);
}

@media (max-width: 760px) {
  .collection-tile-surface.is-horizontal {
    --md-comp-collection-tile-inline-media-size: 72px;
  }

  .collection-tile-surface.is-horizontal.is-compact {
    --md-comp-collection-tile-inline-media-size: 64px;
  }

  .collection-tile-surface.is-horizontal .collection-tile-surface__action {
    gap: var(--md-sys-spacing-2);
  }
}
</style>
