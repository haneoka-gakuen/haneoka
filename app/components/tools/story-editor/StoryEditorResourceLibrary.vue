<!--
  This Source Code Form is subject to the terms of the Mozilla Public
  License, v. 2.0. If a copy of the MPL was not distributed with this
  file, You can obtain one at https://mozilla.org/MPL/2.0/.

  Portions are adapted from OpenWebGAL/WebGAL_Terre's Assets.tsx,
  FileElement.tsx, and FileElement.module.scss at commit 7b7a2159a5ccead80327437b7305b8fdb47a4e5f.
  See THIRD_PARTY_NOTICES.md for attribution and scope.
-->
<script setup lang="ts">
import { MaterialIcon, UiIconButton, UiList, UiListItem, type UiIconButtonHandle } from "@haneoka/ui";

import type {
  ResourceBrowserFile,
  ResourceBrowserInsert,
  ResourceBrowserNode,
  ResourceBrowserPath,
  ResourceBrowserProvider,
  ResourceBrowserRequest,
} from "@haneoka/altair/resource-browser";

type BrowserProvider = ResourceBrowserProvider<unknown, unknown>;
type BrowserFile = ResourceBrowserFile<unknown>;
type ResourceView = "grid" | "list";

interface BrowserEntry {
  readonly key: string;
  readonly provider: BrowserProvider;
  readonly node: ResourceBrowserNode<unknown>;
}

interface BrowserLocation {
  readonly provider?: BrowserProvider;
  readonly path: ResourceBrowserPath;
}

const props = withDefaults(
  defineProps<{
    providers: readonly BrowserProvider[];
    acceptedKinds?: readonly string[];
    preferredKind?: string;
    requestContext?: Readonly<Record<string, unknown>>;
    disabled?: boolean;
  }>(),
  {
    acceptedKinds: () => [],
    preferredKind: undefined,
    requestContext: undefined,
  },
);

const emit = defineEmits<{
  insert: [resource: ResourceBrowserInsert<unknown>];
}>();

const { t, messages } = useLocale();
const copy = messages("storyEditorPage");
const location = shallowRef<BrowserLocation>({ path: [] });
const history = shallowRef<readonly BrowserLocation[]>([]);
const entries = shallowRef<readonly BrowserEntry[]>([]);
const query = ref("");
const view = ref<ResourceView>("list");
const pending = ref(false);
const error = shallowRef<unknown>();
const actionError = shallowRef<unknown>();
const loadingKey = ref("");
const activeAudioKey = ref("");
const selectedEntryKey = ref("");
const sortOrder = ref<"asc" | "desc">("asc");
const audio = shallowRef<HTMLAudioElement>();
const moreButton = shallowRef<UiIconButtonHandle>();
const morePopover = shallowRef<HTMLElement>();
const moreMenuOpen = ref(false);
const moreMenuTop = ref(0);
const moreMenuLeft = ref(0);
const itemsRoot = ref<HTMLElement>();
const itemsScrollTop = ref(0);
const itemsWidth = ref(320);
const itemsHeight = ref(320);
let itemsObserver: ResizeObserver | undefined;
let requestGeneration = 0;
let requestController: AbortController | undefined;
let actionController: AbortController | undefined;

const requestFor = (
  signal: AbortSignal,
  acceptedKinds: readonly string[] = props.acceptedKinds,
): ResourceBrowserRequest => ({
  acceptedKinds,
  ...(props.preferredKind ? { preferredKind: props.preferredKind } : {}),
  ...(props.requestContext ? { context: props.requestContext } : {}),
  signal,
});

const rootEntries = computed<readonly BrowserEntry[]>(() =>
  props.providers.flatMap((provider) =>
    provider.roots.map((node) => ({
      key: `${provider.id}:${node.id}`,
      provider,
      node,
    })),
  ),
);

const filteredEntries = computed(() => {
  const needle = query.value.normalize("NFKC").trim().toLocaleLowerCase();
  const source = location.value.provider ? entries.value : rootEntries.value;
  return [...source]
    .filter(({ node }) => {
      if (!needle) return true;
      return [node.name, node.description, node.type === "file" ? node.detail : undefined]
        .filter(Boolean)
        .some((value) => String(value).normalize("NFKC").toLocaleLowerCase().includes(needle));
    })
    .sort((left, right) => {
      if (left.node.type !== right.node.type) return left.node.type === "directory" ? -1 : 1;
      const compared = left.node.name.localeCompare(right.node.name, undefined, {
        numeric: true,
        sensitivity: "base",
      });
      return sortOrder.value === "asc" ? compared : -compared;
    });
});

const currentPathText = computed(() => {
  const provider = location.value.provider;
  if (!provider) return "/";
  const path = location.value.path.join("/");
  return path ? `${provider.name} / ${path}` : provider.name;
});

const canOpenFile = (file: BrowserFile): boolean => {
  if (props.disabled || loadingKey.value || !file.available) return false;
  return props.acceptedKinds.length === 0 || file.acceptedKinds.some((kind) => props.acceptedKinds.includes(kind));
};

const entryIconName = ({ node }: BrowserEntry): string => {
  if (node.type === "directory") return "folder";
  const icons: Record<string, string> = {
    audio: "audio_file",
    data: "description",
    image: "image",
    model: "view_in_ar",
    scene: "movie",
    video: "video_file",
  };
  return icons[node.displayKind] || "draft";
};

const resetScroll = () => {
  if (itemsRoot.value) itemsRoot.value.scrollTop = 0;
  itemsScrollTop.value = 0;
};

const stopAudio = () => {
  audio.value?.pause();
  activeAudioKey.value = "";
};

const listLocation = async (next: BrowserLocation) => {
  requestController?.abort();
  actionController?.abort();
  actionController = undefined;
  loadingKey.value = "";
  const generation = ++requestGeneration;
  const controller = new AbortController();
  requestController = controller;
  location.value = next;
  entries.value = [];
  query.value = "";
  selectedEntryKey.value = "";
  error.value = undefined;
  actionError.value = undefined;
  stopAudio();
  resetScroll();
  if (!next.provider) {
    pending.value = false;
    return;
  }
  pending.value = true;
  try {
    const nodes = await next.provider.list(next.path, requestFor(controller.signal));
    if (generation !== requestGeneration || controller.signal.aborted) return;
    entries.value = nodes.map((node) => ({
      key: `${next.provider!.id}:${node.id}`,
      provider: next.provider!,
      node,
    }));
  } catch (cause) {
    if (generation === requestGeneration && !controller.signal.aborted) error.value = cause;
  } finally {
    if (generation === requestGeneration) pending.value = false;
  }
};

const openDirectory = (provider: BrowserProvider, path: ResourceBrowserPath) => {
  history.value = [...history.value, location.value];
  void listLocation({ provider, path });
};

const goBack = () => {
  const next = history.value.at(-1) ?? { path: [] };
  history.value = history.value.slice(0, -1);
  void listLocation(next);
};

const openFile = async (entry: BrowserEntry) => {
  if (entry.node.type !== "file") return;
  const { provider, node } = entry;
  if (!canOpenFile(node)) return;
  actionError.value = undefined;
  loadingKey.value = entry.key;
  const controller = new AbortController();
  actionController?.abort();
  actionController = controller;
  try {
    const acceptedKinds = props.acceptedKinds.length ? props.acceptedKinds : node.acceptedKinds;
    const resource = await provider.open(node, requestFor(controller.signal, acceptedKinds));
    if (resource) emit("insert", resource);
  } catch (cause) {
    actionError.value = cause;
  } finally {
    if (actionController === controller) {
      actionController = undefined;
      loadingKey.value = "";
    }
  }
};

const activateEntry = (entry: BrowserEntry) => {
  selectedEntryKey.value = entry.key;
  if (entry.node.type === "directory") {
    openDirectory(entry.provider, entry.node.path);
    return;
  }
  void openFile(entry as BrowserEntry & { node: BrowserFile });
};

const toggleAudio = async (entry: BrowserEntry) => {
  if (entry.node.type !== "file") return;
  const source = entry.node.audioPreviewUrl;
  if (!import.meta.client || props.disabled || !source) return;
  if (!audio.value) {
    audio.value = new Audio();
    audio.value.addEventListener("ended", () => {
      activeAudioKey.value = "";
    });
  }
  if (activeAudioKey.value === entry.key && !audio.value.paused) {
    stopAudio();
    return;
  }
  audio.value.pause();
  audio.value.src = source;
  activeAudioKey.value = entry.key;
  try {
    await audio.value.play();
  } catch (cause) {
    activeAudioKey.value = "";
    actionError.value = cause;
  }
};

const onEntryDragStart = (entry: BrowserEntry, event: DragEvent) => {
  if (entry.node.type !== "file" || !event.dataTransfer || !canOpenFile(entry.node)) return;
  const payload = JSON.stringify({
    providerId: entry.provider.id,
    resourceId: entry.node.id,
    path: [...entry.node.path],
  });
  event.dataTransfer.effectAllowed = "copy";
  event.dataTransfer.setData("application/x-altair-resource", payload);
  event.dataTransfer.setData("text/plain", entry.node.path.join("/"));
};

const refresh = async () => {
  actionError.value = undefined;
  error.value = undefined;
  const provider = location.value.provider;
  try {
    if (provider) await provider.refresh?.(requestFor(new AbortController().signal));
    await listLocation(location.value);
  } catch (cause) {
    error.value = cause;
  }
  moreMenuOpen.value = false;
};

const applyPreferredLocation = async () => {
  history.value = [];
  if (!props.preferredKind) {
    await listLocation({ path: [] });
    return;
  }
  const provider = props.providers[0];
  if (!provider) {
    await listLocation({ path: [] });
    return;
  }
  try {
    const path = provider.preferredPath(requestFor(new AbortController().signal));
    await listLocation({ provider, path });
  } catch {
    await listLocation({ path: [] });
  }
};

watch(
  [() => props.providers, () => props.acceptedKinds, () => props.preferredKind, () => props.requestContext],
  () => void applyPreferredLocation(),
  { immediate: true },
);

const setView = (next: ResourceView) => {
  view.value = next;
  if (import.meta.client) localStorage.setItem("story-editor-resource-view", next);
  resetScroll();
};
const toggleView = () => setView(view.value === "grid" ? "list" : "grid");

const updateItemsViewport = () => {
  const root = itemsRoot.value;
  if (!root) return;
  const style = getComputedStyle(root);
  const horizontalPadding = Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.paddingRight);
  const verticalPadding = Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom);
  itemsScrollTop.value = root.scrollTop;
  itemsWidth.value = Math.max(1, root.clientWidth - horizontalPadding);
  itemsHeight.value = Math.max(1, root.clientHeight - verticalPadding);
};
const resourceColumnCount = computed(() =>
  Math.max(1, Math.floor(itemsWidth.value / (view.value === "grid" ? 96 : 192))),
);
const resourceRowHeight = computed(() => (view.value === "grid" ? itemsWidth.value / resourceColumnCount.value : 32));
const resourceRowCount = computed(() => Math.ceil(filteredEntries.value.length / resourceColumnCount.value));
const resourceVirtualRange = computed(() => {
  const rowHeight = Math.max(1, resourceRowHeight.value);
  const startRow = Math.max(0, Math.floor(itemsScrollTop.value / rowHeight) - 2);
  const endRow = Math.min(
    resourceRowCount.value,
    Math.ceil((itemsScrollTop.value + itemsHeight.value) / rowHeight) + 2,
  );
  return { startRow, endRow };
});
const visibleEntries = computed(() => {
  const start = resourceVirtualRange.value.startRow * resourceColumnCount.value;
  const end = resourceVirtualRange.value.endRow * resourceColumnCount.value;
  return filteredEntries.value.slice(start, end);
});
const resourceCanvasStyle = computed(() => ({ height: `${resourceRowCount.value * resourceRowHeight.value}px` }));
const resourceWindowStyle = computed(() => ({
  gridTemplateColumns: `repeat(${resourceColumnCount.value}, minmax(0, 1fr))`,
  gridAutoRows: `${resourceRowHeight.value}px`,
  transform: `translateY(${resourceVirtualRange.value.startRow * resourceRowHeight.value}px)`,
}));

const moreMenuStyle = computed(() => ({
  top: `${moreMenuTop.value}px`,
  left: `${moreMenuLeft.value}px`,
}));
const updateMoreMenuPosition = () => {
  if (!import.meta.client || !moreMenuOpen.value || !moreButton.value) return;
  const anchor = moreButton.value.getElement()?.getBoundingClientRect();
  if (!anchor) return;
  const width = morePopover.value?.offsetWidth || 160;
  const height = morePopover.value?.offsetHeight || 88;
  const viewportPadding = 4;
  moreMenuLeft.value = Math.max(
    viewportPadding,
    Math.min(anchor.right - width, window.innerWidth - width - viewportPadding),
  );
  const below = anchor.bottom + 3;
  moreMenuTop.value =
    below + height <= window.innerHeight - viewportPadding ? below : Math.max(viewportPadding, anchor.top - height - 3);
};
const toggleMoreMenu = async () => {
  moreMenuOpen.value = !moreMenuOpen.value;
  if (!moreMenuOpen.value) return;
  await nextTick();
  updateMoreMenuPosition();
};
const closeMoreMenuFromOutside = (event: PointerEvent) => {
  const target = event.target as Node | null;
  if (!target || moreButton.value?.getElement()?.contains(target) || morePopover.value?.contains(target)) return;
  moreMenuOpen.value = false;
};
const closeMoreMenuOnEscape = (event: KeyboardEvent) => {
  if (event.key !== "Escape" || !moreMenuOpen.value) return;
  moreMenuOpen.value = false;
  moreButton.value?.focus();
};
const toggleSortOrder = () => {
  sortOrder.value = sortOrder.value === "asc" ? "desc" : "asc";
  if (import.meta.client) localStorage.setItem("story-editor-resource-sort-order", sortOrder.value);
  moreMenuOpen.value = false;
};

onMounted(() => {
  const storedView = localStorage.getItem("story-editor-resource-view");
  if (storedView === "grid" || storedView === "list") view.value = storedView;
  const storedSortOrder = localStorage.getItem("story-editor-resource-sort-order");
  if (storedSortOrder === "asc" || storedSortOrder === "desc") sortOrder.value = storedSortOrder;
  itemsObserver = new ResizeObserver(updateItemsViewport);
  if (itemsRoot.value) itemsObserver.observe(itemsRoot.value);
  updateItemsViewport();
  document.addEventListener("pointerdown", closeMoreMenuFromOutside);
  document.addEventListener("keydown", closeMoreMenuOnEscape);
  window.addEventListener("resize", updateMoreMenuPosition);
  window.addEventListener("scroll", updateMoreMenuPosition, true);
});

onBeforeUnmount(() => {
  requestController?.abort();
  actionController?.abort();
  itemsObserver?.disconnect();
  document.removeEventListener("pointerdown", closeMoreMenuFromOutside);
  document.removeEventListener("keydown", closeMoreMenuOnEscape);
  window.removeEventListener("resize", updateMoreMenuPosition);
  window.removeEventListener("scroll", updateMoreMenuPosition, true);
  stopAudio();
  if (audio.value) audio.value.src = "";
});
</script>

<template>
  <section class="story-resource-library" :aria-label="copy.resources">
    <div class="story-resource-library__filter">
      <slot name="leading" />
      <SearchField v-model="query" compact :label="copy.searchResources" />
    </div>
    <slot name="notice" />

    <div class="story-resource-library__pathbar">
      <UiIconButton
        v-if="location.provider"
        class="story-resource-library__toolbar-button"
        size="compact"
        :label="t('previous')"
        @click="goBack"
      >
        <MaterialIcon name="arrow_back" :size="20" />
      </UiIconButton>
      <code class="story-resource-library__path" :aria-label="copy.resources">{{ currentPathText }}</code>
      <UiIconButton
        class="story-resource-library__toolbar-button"
        size="compact"
        :label="view === 'list' ? t('grid') : t('list')"
        @click="toggleView"
      >
        <MaterialIcon :name="view === 'list' ? 'grid_view' : 'view_list'" :size="20" />
      </UiIconButton>
      <UiIconButton
        ref="moreButton"
        class="story-resource-library__toolbar-button story-resource-library__more-button"
        size="compact"
        :label="copy.resources"
        :pressed="moreMenuOpen"
        aria-haspopup="menu"
        :aria-expanded="moreMenuOpen"
        @click="toggleMoreMenu"
      >
        <MaterialIcon name="more_vert" :size="20" />
      </UiIconButton>
    </div>

    <Teleport to="body">
      <div
        v-if="moreMenuOpen"
        ref="morePopover"
        class="story-resource-library__menu"
        role="menu"
        :style="moreMenuStyle"
      >
        <UiList>
          <UiListItem type="button" role="menuitem" :headline="t('refresh')" @click="refresh">
            <template #start><MaterialIcon name="refresh" :size="20" /></template>
          </UiListItem>
          <UiListItem
            type="button"
            role="menuitem"
            :headline="`${t('sort')} · ${t(sortOrder === 'asc' ? 'ascending' : 'descending')}`"
            @click="toggleSortOrder"
          >
            <template #start>
              <MaterialIcon :name="sortOrder === 'asc' ? 'arrow_upward' : 'arrow_downward'" :size="20" />
            </template>
          </UiListItem>
        </UiList>
      </div>
    </Teleport>

    <div v-if="actionError" class="story-resource-library__notice is-error" role="alert">
      {{ t("error") }}
    </div>

    <div
      ref="itemsRoot"
      class="story-resource-library__items"
      data-scroll-key="story-editor-resources"
      @scroll.passive="updateItemsViewport"
    >
      <LoadingState v-if="pending" />
      <ErrorState v-else-if="error" @retry="refresh" />
      <EmptyState v-else-if="!filteredEntries.length" />
      <div v-else class="story-resource-library__canvas" :style="resourceCanvasStyle">
        <div class="story-resource-library__files" :class="`is-${view}`" :style="resourceWindowStyle">
          <article
            v-for="entry in visibleEntries"
            :key="entry.key"
            class="story-resource-file"
            :class="{
              'is-directory': entry.node.type === 'directory',
              'is-disabled': entry.node.type === 'file' && !canOpenFile(entry.node),
              'is-selected': selectedEntryKey === entry.key,
            }"
            :title="entry.node.path.join('/')"
            role="button"
            tabindex="0"
            :draggable="entry.node.type === 'file' && canOpenFile(entry.node)"
            @click="activateEntry(entry)"
            @dragstart="onEntryDragStart(entry, $event)"
            @keydown.enter.self.prevent="activateEntry(entry)"
            @keydown.space.self.prevent="activateEntry(entry)"
          >
            <div class="story-resource-file__icon">
              <img
                v-if="entry.node.type === 'file' && entry.node.previewUrl"
                class="is-preview"
                :src="entry.node.previewUrl"
                alt=""
                loading="lazy"
                draggable="false"
              />
              <MaterialIcon
                v-else
                class="is-file-icon"
                :name="entryIconName(entry)"
                :size="view === 'grid' ? 40 : 20"
              />
            </div>
            <div class="story-resource-file__name">
              <span>{{ entry.node.name }}</span>
              <small
                v-if="view === 'list' && (entry.node.description || (entry.node.type === 'file' && entry.node.detail))"
              >
                {{ entry.node.description || (entry.node.type === "file" ? entry.node.detail : "") }}
              </small>
            </div>
            <div v-if="entry.node.type === 'file'" class="story-resource-file__actions">
              <UiIconButton
                v-if="entry.node.audioPreviewUrl"
                size="compact"
                :disabled="disabled"
                :label="activeAudioKey === entry.key ? t('pause') : t('play')"
                @click.stop="toggleAudio(entry)"
              >
                <MaterialIcon :name="activeAudioKey === entry.key ? 'pause' : 'play_arrow'" :size="18" />
              </UiIconButton>
              <UiIconButton
                :disabled="!canOpenFile(entry.node)"
                size="compact"
                :label="entry.node.available ? copy.insertResource : copy.resourceUnavailable"
                @click.stop="openFile(entry)"
              >
                <MaterialIcon v-if="loadingKey === entry.key" name="refresh" class="is-spinning" :size="18" />
                <MaterialIcon v-else name="add" :size="18" />
              </UiIconButton>
            </div>
          </article>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.story-resource-library {
  display: flex;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  flex-direction: column;
  overflow: hidden;
  background: var(--md-sys-color-surface-container-lowest);
}

.story-resource-library__filter {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 4px;
  padding: 4px;
}

.story-resource-library__filter :deep(.search-field) {
  height: var(--md-comp-control-height-compact);
  min-width: 0;
  min-height: var(--md-comp-control-height-compact);
  flex: 1;
}

.story-resource-library__pathbar {
  position: relative;
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 3px;
  padding: 0 4px 4px;
  border-bottom: 1px solid var(--md-sys-color-outline-variant);
}

.story-resource-library__toolbar-button,
.story-resource-library__more-button {
  flex: 0 0 var(--md-comp-control-height-compact);
}

.story-resource-library__path {
  display: flex;
  width: 100%;
  min-width: 0;
  height: var(--md-comp-control-height-compact);
  align-items: center;
  padding: 0 var(--md-sys-spacing-2);
  overflow: hidden;
  color: var(--md-sys-color-on-surface-variant);
  border-radius: var(--md-sys-shape-corner-small);
  background: var(--md-sys-color-surface-container);
  font-family: var(--md-ref-typeface-code);
  font-size: var(--md-sys-typescale-label-small-size);
  line-height: 1;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.story-resource-library__menu {
  position: fixed;
  z-index: var(--md-sys-z-index-overlay-popover);
  min-width: 160px;
  padding: var(--md-sys-spacing-1);
  border-radius: var(--md-sys-shape-corner-small);
  box-shadow: var(--md-sys-elevation-level2);
  overflow: hidden;
  --md-list-container-color: var(--md-sys-color-surface-container);
}

.story-resource-library__menu :deep(.md3-list-item) {
  --md-list-item-one-line-container-height: 44px;
}

.story-resource-library__notice {
  padding: 4px 7px;
  color: var(--md-sys-color-on-error-container);
  border-bottom: 1px solid var(--md-sys-color-outline-variant);
  background: var(--md-sys-color-error-container);
  font-size: var(--md-sys-typescale-label-small-size);
}

.story-resource-library__items {
  position: relative;
  min-height: 0;
  flex: 1;
  overflow: auto;
  padding: 4px;
  scrollbar-width: thin;
}

.story-resource-library__canvas {
  position: relative;
  width: 100%;
  min-height: 0;
}

.story-resource-library__files {
  position: absolute;
  inset: 0 0 auto;
  display: grid;
  align-content: start;
  width: 100%;
  will-change: transform;
}

.story-resource-file {
  position: relative;
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 2px;
  width: 100%;
  padding: 0 8px;
  overflow: hidden;
  border-radius: var(--md-sys-shape-corner-small);
  cursor: pointer;
}

.story-resource-file:hover {
  outline: none;
  background: color-mix(in srgb, var(--md-sys-color-on-surface) 8%, transparent);
}

.story-resource-file.is-selected {
  color: var(--md-sys-color-on-secondary-container);
  background: var(--md-sys-color-secondary-container);
}

.story-resource-file.is-disabled:not(.is-directory) {
  opacity: 0.48;
  cursor: default;
}

.is-grid .story-resource-file {
  flex-direction: column;
}

.is-list .story-resource-file {
  height: 32px;
}

.story-resource-file__icon {
  display: flex;
  min-width: 0;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}

.is-grid .story-resource-file__icon {
  width: 100%;
  min-height: 0;
  flex: 1;
  aspect-ratio: 4 / 3;
}

.is-list .story-resource-file__icon {
  width: 22px;
  height: 22px;
  flex: 0 0 22px;
}

.story-resource-file__icon img.is-preview {
  width: 100%;
  height: 100%;
  object-fit: contain;
  background-image:
    linear-gradient(45deg, color-mix(in srgb, var(--md-sys-color-on-surface) 10%, transparent) 25%, transparent 25%),
    linear-gradient(-45deg, color-mix(in srgb, var(--md-sys-color-on-surface) 10%, transparent) 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, color-mix(in srgb, var(--md-sys-color-on-surface) 10%, transparent) 75%),
    linear-gradient(-45deg, transparent 75%, color-mix(in srgb, var(--md-sys-color-on-surface) 10%, transparent) 75%);
  background-position:
    0 0,
    0 10px,
    10px -10px,
    -10px 0;
  background-size: 20px 20px;
}

.is-grid .story-resource-file__icon .is-file-icon {
  color: var(--md-sys-color-primary);
}

.is-list .story-resource-file__icon .is-file-icon {
  color: var(--md-sys-color-on-surface-variant);
}

.is-list .story-resource-file__icon img.is-preview {
  width: 22px;
  height: 22px;
}

.story-resource-file__name {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 4px;
  overflow: hidden;
}

.is-grid .story-resource-file__name {
  width: 100%;
  min-height: 22px;
  flex: 1;
  justify-content: center;
  font-size: 0.62rem;
  text-align: center;
}

.is-list .story-resource-file__name {
  flex: 1;
  font-size: 0.62rem;
}

.story-resource-file__name span,
.story-resource-file__name small {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.story-resource-file__name span {
  color: var(--md-sys-color-on-surface-variant);
}

.story-resource-file__name small {
  color: var(--md-sys-color-outline);
  font-size: 0.56rem;
  font-style: italic;
}

.story-resource-file__actions {
  position: absolute;
  z-index: 2;
  top: 2px;
  right: 2px;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 0 4px;
  border-radius: 4px;
  background: var(--md-sys-color-surface-container-lowest);
  visibility: hidden;
}

.is-list .story-resource-file__actions {
  top: 1px;
}

.story-resource-file:hover .story-resource-file__actions,
.story-resource-file:focus-within .story-resource-file__actions {
  visibility: visible;
}

.story-resource-file__actions :deep(.md3-icon-button) {
  --md-comp-icon-button-visual-size: var(--md-comp-control-height-compact);
}

.is-spinning {
  animation: story-resource-spin 0.75s linear infinite;
}

@keyframes story-resource-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
