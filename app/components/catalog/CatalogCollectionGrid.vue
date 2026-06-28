<script setup lang="ts" generic="T">
/**
 * The shared virtual grid for collection pages.  Callers provide domain data
 * and a CollectionTileSurface-based tile through the item slot; this owns the
 * responsive columns, virtualization, keyboard-visible selection, and the
 * scroll surface.  `mediaHeightRatio` is only a virtual-row estimate so image
 * elements can keep their native proportions instead of being cropped.
 */
type CollectionKey = string | number;

const props = withDefaults(
  defineProps<{
    items: readonly T[];
    itemKey: (item: T) => CollectionKey;
    label: string;
    minimumColumnWidth: number;
    compactMinimumColumnWidth?: number;
    mediaHeightRatio?: number;
    metadataHeight?: number;
    /**
     * Use the shared compact tile estimate when media is an identifier next to
     * its text, rather than full-bleed primary artwork.  The corresponding
     * CollectionTileSurface orientation remains the caller's semantic choice.
     */
    tileDensity?: "media" | "compact";
    estimateRowHeight?: (columnWidth: number, compact: boolean) => number;
    selectedKey?: CollectionKey | null;
    threshold?: number;
    overscanRows?: number;
    gap?: number;
    compactGap?: number;
    padding?: number;
    scrollKey?: string;
    compactBreakpoint?: number;
    /**
     * Let the surrounding detail surface own scrolling while retaining this
     * component's column sizing and tile contract. Catalog pages keep the
     * default self-scrolling virtual viewport.
     */
    flow?: boolean;
  }>(),
  {
    mediaHeightRatio: 1,
    metadataHeight: 66,
    tileDensity: "media",
    selectedKey: undefined,
    threshold: 120,
    overscanRows: 3,
    gap: 12,
    compactGap: 8,
    padding: 8,
    scrollKey: undefined,
    compactBreakpoint: 599,
    flow: false,
  },
);

const emit = defineEmits<{
  scroll: [event: Event];
}>();

interface VirtualCollectionGridInstance {
  element?: HTMLElement;
  scrollToItem: (index: number, behavior?: ScrollBehavior) => void;
}

const stage = ref<VirtualCollectionGridInstance>();

const estimatedRowHeight = (columnWidth: number, compact: boolean) =>
  props.estimateRowHeight?.(columnWidth, compact) ??
  (props.tileDensity === "compact" ? (compact ? 80 : 88) : columnWidth * props.mediaHeightRatio + props.metadataHeight);

const scrollToItem = (index: number, behavior?: ScrollBehavior) => stage.value?.scrollToItem(index, behavior);

// Catalog consumers can keep selection and scroll restoration in their page
// state without introducing another domain-specific grid wrapper.
defineExpose({
  get element() {
    return stage.value?.element;
  },
  scrollToItem,
});
</script>

<template>
  <VirtualCollectionGrid
    ref="stage"
    class="catalog-virtual-collection-grid"
    :items="items"
    :item-key="itemKey"
    :label="label"
    :minimum-column-width="minimumColumnWidth"
    :compact-minimum-column-width="compactMinimumColumnWidth"
    :estimate-row-height="estimatedRowHeight"
    :selected-key="selectedKey"
    :threshold="threshold"
    :overscan-rows="overscanRows"
    :gap="gap"
    :compact-gap="compactGap"
    :padding="padding"
    :scroll-key="scrollKey"
    :compact-breakpoint="compactBreakpoint"
    :flow="flow"
    @scroll="emit('scroll', $event)"
  >
    <template #item="entry">
      <slot name="item" v-bind="entry" />
    </template>
  </VirtualCollectionGrid>
</template>

<style scoped>
.catalog-virtual-collection-grid {
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  background: var(--md-sys-color-surface);
}
</style>
