<script setup lang="ts" generic="T">
type CollectionKey = string | number;

const props = withDefaults(
  defineProps<{
    items: readonly T[];
    itemKey: (item: T) => CollectionKey;
    label: string;
    rowHeight: number;
    selectedKey?: CollectionKey | null;
    threshold?: number;
    overscanRows?: number;
    headerHeight?: number;
    scrollKey?: string;
    flow?: boolean;
  }>(),
  { threshold: 120, overscanRows: 10, headerHeight: 36, scrollKey: undefined, flow: false },
);

const scrollRoot = ref<HTMLElement>();
const scrollTop = ref(0);
const viewportHeight = ref(640);
let viewportFrame: number | undefined;
let viewportObserver: ResizeObserver | undefined;

const isVirtualized = computed(() => props.items.length > props.threshold);
const selectedIndex = computed(() => props.items.findIndex((item) => props.itemKey(item) === props.selectedKey));
const virtualRange = computed(() => {
  if (!isVirtualized.value) return { start: 0, end: props.items.length };
  const contentTop = Math.max(0, scrollTop.value - props.headerHeight);
  const contentBottom = Math.max(contentTop, scrollTop.value + viewportHeight.value - props.headerHeight);
  const start = Math.max(0, Math.floor(contentTop / props.rowHeight) - props.overscanRows);
  const end = Math.min(props.items.length, Math.ceil(contentBottom / props.rowHeight) + props.overscanRows);
  return { start, end };
});

interface VisibleEntry<TItem> {
  item: TItem;
  index: number;
}

const visibleEntries = computed<VisibleEntry<T>[]>(() => {
  const entries = props.items
    .slice(virtualRange.value.start, virtualRange.value.end)
    .map((item, offset) => ({ item, index: virtualRange.value.start + offset }));
  if (
    isVirtualized.value &&
    selectedIndex.value >= 0 &&
    !entries.some((entry) => entry.index === selectedIndex.value)
  ) {
    entries.push({ item: props.items[selectedIndex.value]!, index: selectedIndex.value });
    entries.sort((left, right) => left.index - right.index);
  }
  return entries;
});

// Short/non-virtual collections remain natural-height rows. This lets the
// same table contract serve admin and detail ledgers without an artificial
// fixed-height canvas; long catalogs still receive the virtual pixel grid.
const canvasStyle = computed(() =>
  isVirtualized.value
    ? { gridTemplateRows: `repeat(${Math.max(1, props.items.length)}, ${Math.max(1, props.rowHeight)}px)` }
    : undefined,
);

const rowStyle = (index: number) => (isVirtualized.value ? { gridColumn: "1 / -1", gridRow: index + 1 } : undefined);

const scrollSelectedIntoView = () => {
  const root = scrollRoot.value;
  const index = selectedIndex.value;
  if (!root || index < 0) return;

  const top = props.headerHeight + index * props.rowHeight;
  const bottom = top + props.rowHeight;
  const visibleTop = root.scrollTop + props.headerHeight;
  const visibleBottom = root.scrollTop + root.clientHeight;
  if (top < visibleTop) root.scrollTop = Math.max(0, top - props.headerHeight - 8);
  else if (bottom > visibleBottom) root.scrollTop = Math.max(0, bottom - root.clientHeight + 8);
};

const updateViewport = () => {
  const root = scrollRoot.value;
  if (!root) return;
  scrollTop.value = root.scrollTop;
  viewportHeight.value = root.clientHeight;
};

const scheduleViewportUpdate = () => {
  if (viewportFrame !== undefined) return;
  viewportFrame = window.requestAnimationFrame(() => {
    viewportFrame = undefined;
    updateViewport();
  });
};

watch(
  [() => props.items, () => props.rowHeight, () => props.selectedKey],
  () =>
    void nextTick(() => {
      updateViewport();
      scrollSelectedIntoView();
    }),
);

onMounted(() => {
  if (scrollRoot.value) {
    viewportObserver = new ResizeObserver(scheduleViewportUpdate);
    viewportObserver.observe(scrollRoot.value);
  }
  updateViewport();
  scrollSelectedIntoView();
});

onBeforeUnmount(() => {
  viewportObserver?.disconnect();
  if (viewportFrame !== undefined) window.cancelAnimationFrame(viewportFrame);
});
</script>

<template>
  <section
    ref="scrollRoot"
    class="virtual-collection-rows collection-table-viewport"
    :class="{ 'is-flow': flow }"
    :data-scroll-key="scrollKey"
    role="grid"
    :aria-label="label"
    :aria-rowcount="items.length + 1"
    @scroll.passive="scheduleViewportUpdate"
  >
    <div class="collection-table-grid">
      <slot name="header" />
      <div class="virtual-collection-rows__canvas collection-table-canvas" :style="canvasStyle" role="rowgroup">
        <template v-for="entry in visibleEntries" :key="itemKey(entry.item)">
          <slot name="row" :item="entry.item" :index="entry.index" :style="rowStyle(entry.index)" />
        </template>
      </div>
    </div>
  </section>
</template>

<style scoped>
.virtual-collection-rows {
  background: var(--md-sys-color-surface);
}

.virtual-collection-rows__canvas {
  min-height: 0;
}
</style>
