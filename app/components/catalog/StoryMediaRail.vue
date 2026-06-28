<script setup lang="ts">
import { langOf, textOf, type DisplayText } from "~/types/displayText";
import { entityAvatarText } from "~/utils/entityAvatar";

export interface StoryMediaRailItem {
  id: string | number;
  label: DisplayText;
  meta?: string | number;
  image?: string;
  fallbackImage?: string;
  overlayImage?: string;
  imageFit?: "cover" | "contain";
  imageShape?: "square" | "circle";
  color?: string;
}

type ImageExpander = (url: string | null | undefined) => readonly string[];

const props = defineProps<{
  items: StoryMediaRailItem[];
  modelValue?: string | number;
  label: string;
  appearance?: "media" | "identity" | "icon";
  /** Preserve the source cover's intrinsic ratio instead of using the rail's fixed frame. */
  imageMode?: "fixed" | "natural";
  /** When provided, expand each cover image into language-fallback candidates. */
  expandImage?: ImageExpander;
}>();

const emit = defineEmits<{
  "update:modelValue": [value: string | number];
}>();

// Some imported story sources contain hundreds or thousands of chapters. The
// rail is scrollable on both desktop and mobile, so rendering every cover at
// once is needlessly expensive. Keep a bounded window in the active scroll
// axis while retaining the selected chapter for accessibility and state.
const VIRTUALIZE_AFTER = 80;
const VIRTUAL_OVERSCAN = 360;

const rail = ref<HTMLElement>();
const scrollOffset = ref(0);
const viewportExtent = ref(0);
const compact = ref(false);
const measuredExtents = reactive(new Map<number, number>());
const itemElements = new Map<number, HTMLElement>();
let viewportObserver: ResizeObserver | undefined;
let itemObserver: ResizeObserver | undefined;
let viewportFrame: number | undefined;
let compactQuery: MediaQueryList | undefined;

const isIdentity = computed(() => props.appearance === "identity");
const isIcon = computed(() => props.appearance === "icon");
const itemGap = computed(() => {
  if (isIcon.value) return 8;
  if (compact.value) return isIdentity.value ? 4 : 7;
  return isIdentity.value ? 4 : 8;
});
const estimatedExtent = computed(() => {
  if (isIcon.value) return 48;
  if (compact.value) return isIdentity.value ? 166 : 126;
  return isIdentity.value ? 54 : 116;
});
const isVirtualized = computed(() => props.items.length > VIRTUALIZE_AFTER);
const selectedIndex = computed(() => props.items.findIndex((item) => item.id === props.modelValue));

const railLayout = computed(() => {
  const offsets = [0];
  for (let index = 0; index < props.items.length; index += 1) {
    const extent = measuredExtents.get(index) ?? estimatedExtent.value;
    offsets.push(offsets[index]! + extent + (index + 1 < props.items.length ? itemGap.value : 0));
  }
  return { offsets, total: offsets.at(-1) || 0 };
});

const indexAt = (offsets: readonly number[], value: number): number => {
  const count = Math.max(0, offsets.length - 1);
  if (!count) return 0;
  let low = 0;
  let high = count - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (offsets[middle + 1]! <= value) low = middle + 1;
    else high = middle;
  }
  return low;
};

const virtualRange = computed(() => {
  if (!isVirtualized.value) return { start: 0, end: props.items.length };
  const offsets = railLayout.value.offsets;
  const overscan = Math.max(VIRTUAL_OVERSCAN, estimatedExtent.value * 3);
  const start = indexAt(offsets, Math.max(0, scrollOffset.value - overscan));
  const end = Math.min(props.items.length, indexAt(offsets, scrollOffset.value + viewportExtent.value + overscan) + 1);
  return { start, end: Math.max(start + 1, end) };
});

interface RailEntry {
  item: StoryMediaRailItem;
  index: number;
}

const visibleEntries = computed<RailEntry[]>(() => {
  const { start, end } = virtualRange.value;
  const entries = props.items.slice(start, end).map((item, offset) => ({ item, index: start + offset }));
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

const canvasStyle = computed(() => {
  if (!isVirtualized.value) return undefined;
  const total = `${Math.max(1, railLayout.value.total)}px`;
  return compact.value ? { width: total } : { height: total };
});

const virtualItemStyle = (index: number) => {
  if (!isVirtualized.value) return undefined;
  const offset = railLayout.value.offsets[index] || 0;
  if (compact.value) {
    return {
      top: "0px",
      left: `${offset}px`,
      width: `${estimatedExtent.value}px`,
    };
  }
  return { top: `${offset}px`, left: "0px", width: "100%" };
};

const updateViewport = () => {
  const element = rail.value;
  if (!element) return;
  scrollOffset.value = compact.value ? element.scrollLeft : element.scrollTop;
  viewportExtent.value = compact.value ? element.clientWidth : element.clientHeight;
};

const scheduleViewportUpdate = () => {
  if (viewportFrame !== undefined) return;
  viewportFrame = window.requestAnimationFrame(() => {
    viewportFrame = undefined;
    updateViewport();
  });
};

const syncCompact = () => {
  compact.value = compactQuery?.matches ?? false;
};

const scrollToItem = (index: number, behavior: ScrollBehavior = "auto") => {
  const element = rail.value;
  if (!element || index < 0 || index >= props.items.length) return;
  const offsets = railLayout.value.offsets;
  const start = offsets[index] || 0;
  const end = offsets[index + 1] || start + estimatedExtent.value;
  const viewportStart = compact.value ? element.scrollLeft : element.scrollTop;
  const viewportEnd = viewportStart + (compact.value ? element.clientWidth : element.clientHeight);
  if (start >= viewportStart && end <= viewportEnd) return;
  const target =
    start < viewportStart ? start : Math.max(0, end - (compact.value ? element.clientWidth : element.clientHeight));
  if (compact.value) element.scrollTo({ left: target, behavior });
  else element.scrollTo({ top: target, behavior });
};

function setItemElement(element: Element | null, index: number): void {
  const previous = itemElements.get(index);
  if (previous && previous !== element) itemObserver?.unobserve(previous);
  if (!(element instanceof HTMLElement)) {
    itemElements.delete(index);
    return;
  }
  itemElements.set(index, element);
  itemObserver?.observe(element);
}

watch(compact, () => {
  measuredExtents.clear();
  void nextTick(updateViewport);
});
watch(
  () => props.items,
  () => {
    measuredExtents.clear();
    void nextTick(updateViewport);
  },
);
watch(
  () => props.modelValue,
  async () => {
    await nextTick();
    scrollToItem(selectedIndex.value, "smooth");
  },
);

onMounted(() => {
  compactQuery = window.matchMedia("(max-width: 760px)");
  syncCompact();
  compactQuery.addEventListener("change", syncCompact);
  if (rail.value) {
    viewportObserver = new ResizeObserver(scheduleViewportUpdate);
    viewportObserver.observe(rail.value);
  }
  itemObserver = new ResizeObserver((entries) => {
    const root = rail.value;
    const offsets = railLayout.value.offsets;
    const anchor = indexAt(offsets, compact.value ? root?.scrollLeft || 0 : root?.scrollTop || 0);
    let scrollCorrection = 0;
    for (const entry of entries) {
      const element = entry.target as HTMLElement;
      const index = Number(element.dataset.railIndex);
      if (!Number.isSafeInteger(index) || index < 0) continue;
      const borderBox = entry.borderBoxSize?.[0];
      const extent = Math.max(
        1,
        Math.ceil(
          compact.value
            ? (borderBox?.inlineSize ?? entry.contentRect.width)
            : (borderBox?.blockSize ?? entry.contentRect.height),
        ),
      );
      const previousExtent = measuredExtents.get(index) ?? estimatedExtent.value;
      if (Math.abs(extent - previousExtent) <= 1) continue;
      measuredExtents.set(index, extent);
      if (index < anchor) scrollCorrection += extent - previousExtent;
    }
    if (root && scrollCorrection) {
      if (compact.value) root.scrollLeft += scrollCorrection;
      else root.scrollTop += scrollCorrection;
    }
    scheduleViewportUpdate();
  });
  for (const element of itemElements.values()) itemObserver.observe(element);
  updateViewport();
  scrollToItem(selectedIndex.value);
});

onBeforeUnmount(() => {
  compactQuery?.removeEventListener("change", syncCompact);
  viewportObserver?.disconnect();
  itemObserver?.disconnect();
  if (viewportFrame !== undefined) window.cancelAnimationFrame(viewportFrame);
  itemElements.clear();
});

const coverSources = (item: StoryMediaRailItem): readonly string[] => {
  const base = [item.image, item.fallbackImage].filter(
    (entry): entry is string => typeof entry === "string" && Boolean(entry),
  );
  return props.expandImage && base.length ? props.expandImage(base[0]) : base;
};
// Per-item fallback position (composables can't run inside a v-for). When every
// candidate for an item has errored, `hasCover` returns false and the rail
// falls back to the `<i>` initial — identical to the no-image case.
const coverIndex = reactive<Record<string, number>>({});
const hasCover = (item: StoryMediaRailItem): boolean => {
  const sources = coverSources(item);
  return sources.length > 0 && (coverIndex[String(item.id)] ?? 0) < sources.length;
};
const coverSrc = (item: StoryMediaRailItem): string => coverSources(item)[coverIndex[String(item.id)] ?? 0] ?? "";
const onCoverError = (item: StoryMediaRailItem): void => {
  const sources = coverSources(item);
  const id = String(item.id);
  const next = (coverIndex[id] ?? 0) + 1;
  coverIndex[id] = Math.min(next, sources.length);
};
</script>

<template>
  <nav
    ref="rail"
    class="story-media-rail"
    :class="`is-${appearance || 'media'}`"
    :aria-label="label"
    @scroll.passive="scheduleViewportUpdate"
  >
    <div class="story-media-rail__canvas" :class="{ 'is-virtual': isVirtualized }" :style="canvasStyle">
      <button
        v-for="entry in visibleEntries"
        :key="entry.item.id"
        :ref="(element) => setItemElement(element as Element | null, entry.index)"
        class="story-media-rail__item"
        :class="{ 'is-selected': entry.item.id === modelValue }"
        :style="[virtualItemStyle(entry.index), { '--rail-accent': entry.item.color || 'var(--md-sys-color-primary)' }]"
        :data-rail-index="entry.index"
        type="button"
        :aria-label="textOf(entry.item.label)"
        :aria-pressed="entry.item.id === modelValue"
        :title="textOf(entry.item.label)"
        @click="emit('update:modelValue', entry.item.id)"
      >
        <md-ripple />
        <span
          class="story-media-rail__cover"
          :class="[
            `is-${entry.item.imageFit || 'cover'}`,
            `is-${entry.item.imageShape || 'square'}`,
            { 'is-natural': imageMode === 'natural' && hasCover(entry.item) },
          ]"
          aria-hidden="true"
        >
          <img
            v-if="hasCover(entry.item)"
            :src="coverSrc(entry.item)"
            alt=""
            loading="lazy"
            decoding="async"
            @error="onCoverError(entry.item)"
          />
          <EntityAvatar
            v-else
            class="story-media-rail__fallback"
            :text="entityAvatarText(entry.item.label)"
            :lang="langOf(entry.item.label)"
            :color="entry.item.color"
            :shape="entry.item.imageShape === 'circle' || appearance === 'icon' ? 'circle' : 'rounded'"
            icon="auto_stories"
          />
          <StoryThumbnailDecorations :logo="entry.item.overlayImage" />
        </span>
        <span class="story-media-rail__copy">
          <strong><DisplayText :value="entry.item.label" /></strong>
          <small v-if="entry.item.meta !== undefined" class="display-number">{{ entry.item.meta }}</small>
        </span>
      </button>
    </div>
  </nav>
</template>

<style scoped>
.story-media-rail {
  display: flex;
  width: 174px;
  min-width: 0;
  height: 100%;
  flex-direction: column;
  gap: var(--md-sys-spacing-2);
  padding: var(--md-sys-spacing-2);
  overflow-x: hidden;
  overflow-y: auto;
  border-right: 1px solid var(--md-sys-color-outline-variant);
  background: var(--md-sys-color-surface-container-low);
  overscroll-behavior: contain;
  scrollbar-width: thin;
}

.story-media-rail__canvas {
  display: flex;
  width: 100%;
  min-width: 0;
  flex: 0 0 auto;
  flex-direction: column;
  gap: var(--md-sys-spacing-2);
}

.story-media-rail__canvas.is-virtual {
  position: relative;
  display: block;
  min-height: 100%;
}

.story-media-rail__canvas.is-virtual .story-media-rail__item {
  position: absolute;
}

.story-media-rail__item {
  position: relative;
  display: flex;
  width: 100%;
  flex: 0 0 auto;
  flex-direction: column;
  gap: var(--md-sys-spacing-1);
  padding: var(--md-sys-spacing-1);
  color: var(--md-sys-color-on-surface-variant);
  border: 1px solid transparent;
  border-radius: var(--md-sys-shape-corner-large);
  background: transparent;
  text-align: left;
  cursor: pointer;
  transition:
    color var(--md-sys-motion-duration-short2) var(--md-sys-motion-easing-standard),
    border-color var(--md-sys-motion-duration-short2) var(--md-sys-motion-easing-standard),
    background-color var(--md-sys-motion-duration-short2) var(--md-sys-motion-easing-standard);
}

.story-media-rail__item:hover {
  color: var(--md-sys-color-on-surface);
  background: var(--md-sys-color-surface-container-highest);
}

.story-media-rail__item.is-selected {
  color: var(--md-sys-color-on-secondary-container);
  border-color: color-mix(in srgb, var(--rail-accent) 42%, var(--md-sys-color-outline-variant));
  background: var(--md-sys-color-secondary-container);
}

.story-media-rail__cover {
  position: relative;
  display: grid;
  width: 100%;
  aspect-ratio: 2.55 / 1;
  overflow: hidden;
  place-items: center;
  border: 1px solid var(--md-sys-color-outline-variant);
  border-radius: var(--md-sys-shape-corner-medium);
  background: var(--md-sys-color-surface-container-highest);
}

.story-media-rail__cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.story-media-rail__cover.is-natural {
  aspect-ratio: auto;
}

.story-media-rail__cover.is-natural img,
.story-media-rail__cover.is-natural.is-contain img {
  display: block;
  width: 100%;
  height: auto;
  padding: 0;
  object-fit: contain;
}

.story-media-rail__cover.is-contain img {
  padding: 7px;
  object-fit: contain;
}

.story-media-rail__fallback {
  width: 100%;
  height: 100%;
  --entity-avatar-font-size: 10px;
}

.story-media-rail__copy {
  display: grid;
  min-width: 0;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: baseline;
  gap: var(--md-sys-spacing-1);
  padding-inline: 2px;
}

.story-media-rail__copy strong {
  display: -webkit-box;
  overflow: hidden;
  font-family: var(--md-sys-typescale-label-medium-font);
  font-size: var(--md-sys-typescale-label-medium-size);
  font-weight: var(--md-sys-typescale-label-medium-weight);
  letter-spacing: 0;
  line-height: var(--md-sys-typescale-label-medium-line-height);
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.story-media-rail__copy small {
  color: currentColor;
  font-family: var(--md-sys-typescale-label-small-font);
  font-size: var(--md-sys-typescale-label-small-size);
}

.story-media-rail.is-identity {
  gap: var(--md-sys-spacing-1);
  padding: var(--md-sys-spacing-2) var(--md-sys-spacing-2) var(--md-sys-spacing-3);
}

.story-media-rail.is-identity .story-media-rail__canvas {
  gap: var(--md-sys-spacing-1);
}

.story-media-rail.is-identity .story-media-rail__item {
  display: grid;
  min-height: 54px;
  grid-template-columns: 48px minmax(0, 1fr);
  align-items: center;
  gap: var(--md-sys-spacing-2);
  padding: 3px 7px 3px 5px;
  border: 0;
  border-radius: var(--md-sys-shape-corner-large);
}

.story-media-rail.is-identity .story-media-rail__item:hover,
.story-media-rail.is-identity .story-media-rail__item.is-selected {
  border-color: transparent;
}

.story-media-rail.is-identity .story-media-rail__cover {
  width: 48px;
  aspect-ratio: 1;
  overflow: visible;
  border: 0;
  border-radius: 0;
  background: transparent;
  box-shadow: none;
}

.story-media-rail.is-identity .story-media-rail__cover.is-circle {
  overflow: hidden;
  border-radius: 50%;
  background: var(--md-sys-color-surface-container-highest);
}

.story-media-rail.is-identity .story-media-rail__cover.is-circle img,
.story-media-rail.is-identity .story-media-rail__cover.is-circle.is-contain img {
  object-fit: cover;
}

.story-media-rail.is-identity .story-media-rail__cover img,
.story-media-rail.is-identity .story-media-rail__cover.is-contain img {
  padding: 0;
  object-fit: contain;
}

.story-media-rail.is-identity .story-media-rail__copy {
  display: block;
  padding: 0;
}

.story-media-rail.is-identity .story-media-rail__copy strong {
  font-size: var(--md-sys-typescale-label-medium-size);
  line-height: var(--md-sys-typescale-label-medium-line-height);
}

/* Image-only selector rails share the 72dp navigation-rail geometry used by
 * the character catalog. Labels remain available through the button's
 * accessible name and tooltip instead of consuming visual space. */
.story-media-rail.is-icon {
  width: 72px;
  align-items: center;
  gap: var(--md-sys-spacing-2);
  padding: var(--md-sys-spacing-3) var(--md-sys-spacing-2);
  background: var(--md-sys-color-surface-container);
}

.story-media-rail.is-icon .story-media-rail__canvas {
  align-items: center;
  gap: var(--md-sys-spacing-2);
}

.story-media-rail.is-icon .story-media-rail__item {
  display: grid;
  width: 48px;
  height: 48px;
  min-height: 48px;
  flex-basis: 48px;
  padding: 5px;
  place-items: center;
  border: 0;
  border-radius: var(--md-sys-shape-corner-full);
}

.story-media-rail.is-icon .story-media-rail__cover {
  width: 38px;
  aspect-ratio: 1;
  overflow: hidden;
  border: 0;
  border-radius: 50%;
  background: var(--md-sys-color-surface-container-highest);
}

.story-media-rail.is-icon .story-media-rail__cover img,
.story-media-rail.is-icon .story-media-rail__cover.is-contain img {
  padding: 0;
  object-fit: cover;
}

.story-media-rail.is-icon .story-media-rail__copy {
  display: none;
}

.story-media-rail__item md-ripple {
  z-index: 5;
  border-radius: inherit;
  --md-ripple-hover-color: var(--md-sys-color-on-surface);
  --md-ripple-pressed-color: var(--md-sys-color-primary);
}

@media (max-width: 760px) {
  .story-media-rail {
    width: 100%;
    height: 103px;
    flex-direction: row;
    gap: 7px;
    padding: 7px 8px 8px;
    overflow-x: auto;
    overflow-y: hidden;
    border-right: 0;
    border-bottom: 1px solid var(--md-sys-color-outline-variant);
    scroll-padding-inline: 8px;
  }

  .story-media-rail__canvas {
    width: max-content;
    min-width: 100%;
    height: 100%;
    flex-direction: row;
    gap: 7px;
  }

  .story-media-rail__canvas.is-virtual {
    min-width: 0;
    min-height: 0;
  }

  .story-media-rail__item {
    width: 126px;
    flex-basis: 126px;
    gap: 4px;
    padding: 3px 3px 4px;
  }

  .story-media-rail__copy strong {
    font-size: var(--md-sys-typescale-label-small-size);
    line-height: var(--md-sys-typescale-label-small-line-height);
    -webkit-line-clamp: 1;
  }

  .story-media-rail__copy small {
    font-size: var(--md-sys-typescale-label-small-size);
    line-height: var(--md-sys-typescale-label-small-line-height);
  }

  .story-media-rail.is-identity .story-media-rail__item {
    width: 166px;
    min-height: 0;
    flex-basis: 166px;
    grid-template-columns: 42px minmax(0, 1fr);
    padding: 3px 6px 3px 4px;
  }

  .story-media-rail.is-identity .story-media-rail__cover {
    width: 42px;
  }

  .story-media-rail.is-identity .story-media-rail__copy strong {
    font-size: var(--md-sys-typescale-label-small-size);
    line-height: var(--md-sys-typescale-label-small-line-height);
  }

  .story-media-rail.is-icon {
    width: 100%;
    height: 64px;
    padding: var(--md-sys-spacing-2) var(--md-sys-spacing-3);
  }

  .story-media-rail.is-icon .story-media-rail__canvas {
    width: max-content;
    min-width: 100%;
    height: 48px;
    flex-direction: row;
  }

  .story-media-rail.is-icon .story-media-rail__item {
    width: 48px;
    height: 48px;
    flex-basis: 48px;
  }
}
</style>
