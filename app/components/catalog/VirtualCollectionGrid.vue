<script setup lang="ts" generic="T">
import type { ObjectDirective } from "vue";

type CollectionKey = string | number;

const props = withDefaults(
  defineProps<{
    items: readonly T[];
    itemKey: (item: T) => CollectionKey;
    label: string;
    minimumColumnWidth: number;
    compactMinimumColumnWidth?: number;
    estimateRowHeight?: (columnWidth: number, compact: boolean) => number;
    selectedKey?: CollectionKey | null;
    threshold?: number;
    overscanRows?: number;
    gap?: number;
    compactGap?: number;
    padding?: number;
    scrollKey?: string;
    compactBreakpoint?: number;
    flow?: boolean;
  }>(),
  {
    threshold: 120,
    overscanRows: 3,
    gap: 12,
    compactGap: 8,
    padding: 8,
    compactBreakpoint: 599,
    flow: false,
  },
);

const emit = defineEmits<{
  scroll: [event: Event];
}>();

const scrollRoot = ref<HTMLElement>();
const scrollTop = ref(0);
const viewportHeight = ref(640);
const viewportWidth = ref(0);
const compact = ref(false);
let viewportObserver: ResizeObserver | undefined;
let cellObserver: ResizeObserver | undefined;
let viewportFrame: number | undefined;
let measurementFrame: number | undefined;
let compactQuery: MediaQueryList | undefined;
let anchorRevision = 0;

const cellElements = new Map<number, HTMLElement>();
const cellIndexes = new WeakMap<HTMLElement, number>();
const cellHeights = shallowRef(new Map<number, number>());
const pendingCellHeights = new Map<number, number>();

const activeGap = computed(() => (compact.value ? props.compactGap : props.gap));
const activeMinimumColumnWidth = computed(() =>
  compact.value ? (props.compactMinimumColumnWidth ?? props.minimumColumnWidth) : props.minimumColumnWidth,
);
const contentWidth = computed(() => Math.max(1, viewportWidth.value - props.padding * 2));
const columnCount = computed(() =>
  Math.max(1, Math.floor((contentWidth.value + activeGap.value) / (activeMinimumColumnWidth.value + activeGap.value))),
);
const columnWidth = computed(() =>
  Math.max(1, (contentWidth.value - Math.max(0, columnCount.value - 1) * activeGap.value) / columnCount.value),
);
const estimatedRowHeight = computed(() =>
  Math.max(1, props.estimateRowHeight?.(columnWidth.value, compact.value) ?? columnWidth.value + 48),
);
const rowCount = computed(() => Math.ceil(props.items.length / columnCount.value));
const isVirtualized = computed(() => props.items.length > props.threshold);
const selectedIndex = computed(() => props.items.findIndex((item) => props.itemKey(item) === props.selectedKey));

interface RowLayout {
  heights: number[];
  offsets: number[];
  rowCount: number;
  totalHeight: number;
}

interface ScrollAnchor {
  index: number;
  offset: number;
}

const rowLayout = computed<RowLayout>(() => {
  const measurements = cellHeights.value;
  const rows = rowCount.value;
  const columns = columnCount.value;
  const heights = new Array<number>(rows);
  const offsets = new Array<number>(rows + 1);
  let cursor = props.padding;
  offsets[0] = cursor;

  for (let row = 0; row < rows; row += 1) {
    const start = row * columns;
    const end = Math.min(props.items.length, start + columns);
    let measured = 0;
    let naturalHeight = 0;
    for (let index = start; index < end; index += 1) {
      const height = measurements.get(index);
      if (height === undefined) continue;
      measured += 1;
      naturalHeight = Math.max(naturalHeight, height);
    }

    // Visible ranges always mount a complete row. An isolated off-screen
    // selected cell does not make its row look fully measured, so unknown
    // siblings continue to reserve the caller's estimate until they appear.
    const itemCount = end - start;
    const height =
      measured >= itemCount && itemCount > 0
        ? Math.max(1, naturalHeight)
        : Math.max(estimatedRowHeight.value, naturalHeight);
    heights[row] = height;
    cursor += height;
    if (row < rows - 1) cursor += activeGap.value;
    offsets[row + 1] = cursor;
  }

  return {
    heights,
    offsets,
    rowCount: rows,
    totalHeight: Math.max(1, cursor + props.padding),
  };
});

const rowAtOffset = (layout: RowLayout, offset: number) => {
  if (!layout.rowCount) return 0;
  let low = 0;
  let high = layout.rowCount;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((layout.offsets[middle + 1] ?? layout.totalHeight) <= offset) low = middle + 1;
    else high = middle;
  }
  return Math.min(layout.rowCount - 1, low);
};

const captureScrollAnchor = (
  layout = rowLayout.value,
  columns = columnCount.value,
  itemCount = props.items.length,
  virtualized = isVirtualized.value,
): ScrollAnchor | undefined => {
  const root = scrollRoot.value;
  if (!root || !itemCount || props.flow || !virtualized) return;
  const row = rowAtOffset(layout, root.scrollTop);
  return {
    index: Math.min(itemCount - 1, row * Math.max(1, columns)),
    offset: root.scrollTop - (layout.offsets[row] ?? props.padding),
  };
};

const restoreScrollAnchor = (anchor: ScrollAnchor | undefined) => {
  const root = scrollRoot.value;
  if (!root || !anchor || !props.items.length || props.flow || !isVirtualized.value) return;
  const index = Math.min(props.items.length - 1, Math.max(0, anchor.index));
  const row = Math.floor(index / columnCount.value);
  const top = (rowLayout.value.offsets[row] ?? props.padding) + anchor.offset;
  root.scrollTop = Math.max(0, top);
  scrollTop.value = root.scrollTop;
};

const restoreScrollAnchorAfterLayout = (anchor: ScrollAnchor | undefined) => {
  const revision = ++anchorRevision;
  void nextTick(() => {
    if (revision !== anchorRevision) return;
    restoreScrollAnchor(anchor);
  });
};

interface VisibleEntry<TItem> {
  item: TItem;
  index: number;
}

const virtualRange = computed(() => {
  if (!isVirtualized.value) return { start: 0, end: props.items.length };
  const layout = rowLayout.value;
  if (!layout.rowCount) return { start: 0, end: 0 };
  const top = Math.max(0, scrollTop.value);
  const bottom = Math.max(top, scrollTop.value + viewportHeight.value);
  const startRow = Math.max(0, rowAtOffset(layout, top) - props.overscanRows);
  const endRow = Math.min(layout.rowCount, rowAtOffset(layout, bottom) + props.overscanRows + 1);
  return {
    start: startRow * columnCount.value,
    end: Math.min(props.items.length, endRow * columnCount.value),
  };
});

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

const renderedEntries = computed(() =>
  props.flow ? props.items.map((item, index) => ({ item, index })) : visibleEntries.value,
);

const rootStyle = computed(() => ({
  "--virtual-collection-grid-minimum": `${activeMinimumColumnWidth.value}px`,
  "--virtual-collection-grid-gap": `${activeGap.value}px`,
  "--virtual-collection-grid-padding": `${props.padding}px`,
}));

const canvasStyle = computed(() => ({ height: `${rowLayout.value.totalHeight}px` }));

const cellStyle = (index: number) => {
  const column = index % columnCount.value;
  const row = Math.floor(index / columnCount.value);
  return {
    width: `${columnWidth.value}px`,
    transform: `translate(${props.padding + column * (columnWidth.value + activeGap.value)}px, ${rowLayout.value.offsets[row] ?? props.padding}px)`,
  };
};

const commitCellMeasurements = () => {
  measurementFrame = undefined;
  if (!pendingCellHeights.size || props.flow || !isVirtualized.value) {
    pendingCellHeights.clear();
    return;
  }
  const anchor = captureScrollAnchor();
  let changed = false;
  pendingCellHeights.forEach((height, index) => {
    const previous = cellHeights.value.get(index);
    if (previous !== undefined && Math.abs(previous - height) < 0.5) return;
    cellHeights.value.set(index, height);
    changed = true;
  });
  pendingCellHeights.clear();
  if (!changed) return;
  triggerRef(cellHeights);
  restoreScrollAnchorAfterLayout(anchor);
};

const scheduleMeasurementCommit = () => {
  if (measurementFrame !== undefined) return;
  measurementFrame = window.requestAnimationFrame(commitCellMeasurements);
};

const queueCellMeasurement = (index: number, height: number) => {
  if (index < 0 || index >= props.items.length || !Number.isFinite(height) || height <= 0) return;
  pendingCellHeights.set(index, height);
  scheduleMeasurementCommit();
};

const measureRenderedCells = () => {
  if (props.flow || !isVirtualized.value) return;
  cellElements.forEach((element, index) => queueCellMeasurement(index, element.getBoundingClientRect().height));
};

const observeCell = (element: HTMLElement, index: number) => {
  if (index < 0 || props.flow || !isVirtualized.value) return;
  const previous = cellElements.get(index);
  if (previous && previous !== element) {
    cellObserver?.unobserve(previous);
    cellIndexes.delete(previous);
  }
  cellElements.set(index, element);
  cellIndexes.set(element, index);
  cellObserver?.observe(element);
};

const unobserveCell = (element: HTMLElement, index: number) => {
  cellObserver?.unobserve(element);
  cellIndexes.delete(element);
  if (cellElements.get(index) === element) cellElements.delete(index);
};

const vMeasureCell: ObjectDirective<HTMLElement, number> = {
  mounted(element, binding) {
    observeCell(element, binding.value);
  },
  updated(element, binding) {
    if (binding.oldValue === binding.value) return;
    if (typeof binding.oldValue === "number") unobserveCell(element, binding.oldValue);
    observeCell(element, binding.value);
  },
  beforeUnmount(element, binding) {
    unobserveCell(element, binding.value);
  },
};

const updateViewport = () => {
  const root = scrollRoot.value;
  if (!root) return;
  scrollTop.value = root.scrollTop;
  viewportHeight.value = root.clientHeight;
  viewportWidth.value = root.clientWidth;
};

const scheduleViewportUpdate = () => {
  if (viewportFrame !== undefined) return;
  viewportFrame = window.requestAnimationFrame(() => {
    viewportFrame = undefined;
    updateViewport();
  });
};

const onScroll = (event: Event) => {
  scheduleViewportUpdate();
  emit("scroll", event);
};

const syncCompact = () => {
  compact.value = compactQuery?.matches ?? false;
};

const scrollToItem = (index: number, behavior: ScrollBehavior = "auto") => {
  const root = scrollRoot.value;
  if (!root || index < 0 || index >= props.items.length) return;
  if (props.flow) {
    root.children.item(0)?.children.item(index)?.scrollIntoView({ block: "nearest", behavior });
    return;
  }
  if (!isVirtualized.value) {
    root.children.item(0)?.children.item(index)?.scrollIntoView({ block: "nearest", behavior });
    return;
  }
  const row = Math.floor(index / columnCount.value);
  const top = rowLayout.value.offsets[row] ?? props.padding;
  const bottom = top + (rowLayout.value.heights[row] ?? estimatedRowHeight.value);
  if (top < root.scrollTop) root.scrollTo({ top, behavior });
  else if (bottom > root.scrollTop + root.clientHeight) root.scrollTo({ top: bottom - root.clientHeight, behavior });
};

const resetMeasurements = (anchor?: ScrollAnchor) => {
  if (measurementFrame !== undefined) {
    window.cancelAnimationFrame(measurementFrame);
    measurementFrame = undefined;
  }
  pendingCellHeights.clear();
  cellHeights.value.clear();
  triggerRef(cellHeights);
  restoreScrollAnchorAfterLayout(anchor);
  void nextTick(measureRenderedCells);
};

let stableLayout = rowLayout.value;
const geometry = computed(
  () =>
    [
      columnCount.value,
      Math.round(columnWidth.value * 2) / 2,
      activeGap.value,
      props.padding,
      compact.value,
      isVirtualized.value,
    ] as const,
);

watch(
  geometry,
  (_nextGeometry, previousGeometry) => {
    if (!previousGeometry) return;
    const oldColumns = previousGeometry[0];
    const anchor = captureScrollAnchor(stableLayout, oldColumns, props.items.length, previousGeometry[5]);
    resetMeasurements(anchor);
    void nextTick(updateViewport);
  },
  { flush: "sync" },
);

watch(
  () => props.items,
  (items, previousItems) => {
    const previousAnchor = captureScrollAnchor(
      stableLayout,
      columnCount.value,
      previousItems.length,
      previousItems.length > props.threshold,
    );
    const anchorKey =
      previousAnchor && previousItems[previousAnchor.index] !== undefined
        ? props.itemKey(previousItems[previousAnchor.index]!)
        : undefined;
    const nextIndex = anchorKey === undefined ? -1 : items.findIndex((item) => props.itemKey(item) === anchorKey);
    resetMeasurements(
      previousAnchor
        ? {
            index:
              nextIndex >= 0 ? nextIndex : Math.min(Math.max(0, previousAnchor.index), Math.max(0, items.length - 1)),
            offset: previousAnchor.offset,
          }
        : undefined,
    );
    void nextTick(updateViewport);
  },
  { flush: "sync" },
);

watch(
  rowLayout,
  (layout) => {
    stableLayout = layout;
  },
  { flush: "post" },
);

onMounted(() => {
  compactQuery = window.matchMedia(`(max-width: ${props.compactBreakpoint}px)`);
  syncCompact();
  compactQuery.addEventListener("change", syncCompact);
  if (scrollRoot.value) {
    viewportObserver = new ResizeObserver(scheduleViewportUpdate);
    viewportObserver.observe(scrollRoot.value);
  }
  cellObserver = new ResizeObserver((entries) => {
    entries.forEach((entry) => {
      const element = entry.target as HTMLElement;
      const index = cellIndexes.get(element);
      if (index === undefined) return;
      const borderBox = Array.isArray(entry.borderBoxSize) ? entry.borderBoxSize[0] : entry.borderBoxSize;
      queueCellMeasurement(index, borderBox?.blockSize ?? entry.contentRect.height);
    });
  });
  cellElements.forEach((element) => cellObserver?.observe(element));
  updateViewport();
  measureRenderedCells();
});

onBeforeUnmount(() => {
  compactQuery?.removeEventListener("change", syncCompact);
  viewportObserver?.disconnect();
  cellObserver?.disconnect();
  if (viewportFrame !== undefined) window.cancelAnimationFrame(viewportFrame);
  if (measurementFrame !== undefined) window.cancelAnimationFrame(measurementFrame);
});

defineExpose({ element: scrollRoot, scrollToItem });
</script>

<template>
  <section
    ref="scrollRoot"
    class="virtual-collection-grid"
    :class="{ 'is-flow': flow, 'is-static': !flow && !isVirtualized }"
    :style="rootStyle"
    :data-scroll-key="scrollKey"
    :aria-label="label"
    @scroll.passive="onScroll"
  >
    <div class="virtual-collection-grid__canvas" :style="flow || !isVirtualized ? undefined : canvasStyle">
      <div
        v-for="entry in renderedEntries"
        :key="itemKey(entry.item)"
        v-measure-cell="flow || !isVirtualized ? -1 : entry.index"
        class="virtual-collection-grid__cell"
        :style="flow || !isVirtualized ? undefined : cellStyle(entry.index)"
      >
        <slot name="item" :item="entry.item" :index="entry.index" />
      </div>
    </div>
  </section>
</template>

<style scoped>
.virtual-collection-grid {
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
}

.virtual-collection-grid__canvas {
  position: relative;
  width: 100%;
  min-width: 0;
}

.virtual-collection-grid__cell {
  position: absolute;
  top: 0;
  left: 0;
  min-width: 0;
}

.virtual-collection-grid__cell > :deep(*) {
  width: 100%;
}

.virtual-collection-grid.is-flow {
  height: auto;
  overflow: visible;
}

.virtual-collection-grid.is-flow .virtual-collection-grid__canvas,
.virtual-collection-grid.is-static .virtual-collection-grid__canvas {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, var(--virtual-collection-grid-minimum)), 1fr));
  gap: var(--virtual-collection-grid-gap);
  padding: var(--virtual-collection-grid-padding);
}

.virtual-collection-grid.is-flow .virtual-collection-grid__cell,
.virtual-collection-grid.is-static .virtual-collection-grid__cell {
  position: static;
  min-height: 0;
}
</style>
