<!--
  This Source Code Form is subject to the terms of the Mozilla Public
  License, v. 2.0. If a copy of the MPL was not distributed with this
  file, You can obtain one at https://mozilla.org/MPL/2.0/.

  Portions are adapted from OpenWebGAL/WebGAL_Terre's Assets.tsx,
  FileElement.tsx, and FileElement.module.scss at commit 7b7a2159a5ccead80327437b7305b8fdb47a4e5f.
  See THIRD_PARTY_NOTICES.md for attribution and scope.
-->
<script setup lang="ts">
import { MaterialIcon, UiIconButton } from "@haneoka/ui";

export interface StoryEditorProjectSceneFile {
  readonly id: string;
  readonly name: string;
  readonly path: readonly string[];
  readonly commandCount: number;
  readonly isEntry: boolean;
  readonly canDelete: boolean;
}

interface SceneDirectory {
  readonly type: "directory";
  readonly key: string;
  readonly name: string;
  readonly path: readonly string[];
}

interface SceneFile {
  readonly type: "scene";
  readonly key: string;
  readonly name: string;
  readonly path: readonly string[];
  readonly scene: StoryEditorProjectSceneFile;
}

type SceneEntry = SceneDirectory | SceneFile;
type SceneView = "grid" | "list";

const props = defineProps<{
  scenes: readonly StoryEditorProjectSceneFile[];
  folders?: readonly (readonly string[])[];
  activeSceneId?: string;
}>();

const emit = defineEmits<{
  select: [id: string];
  add: [path: string[]];
  "add-folder": [path: string[]];
  rename: [id: string, name: string];
  delete: [id: string];
}>();

const { t, messages } = useLocale();
const copy = messages("storyEditorPage");
const currentPath = ref<readonly string[]>([]);
const query = ref("");
const view = ref<SceneView>("list");
const selectedKey = ref("");
const itemsRoot = ref<HTMLElement>();
const itemsScrollTop = ref(0);
const itemsWidth = ref(320);
const itemsHeight = ref(320);
let itemsObserver: ResizeObserver | undefined;

const pathStartsWith = (path: readonly string[], prefix: readonly string[]) =>
  prefix.length <= path.length && prefix.every((segment, index) => path[index] === segment);

const entries = computed<SceneEntry[]>(() => {
  const result = new Map<string, SceneEntry>();
  const addDirectory = (path: readonly string[]) => {
    if (!pathStartsWith(path, currentPath.value) || path.length <= currentPath.value.length) return;
    const child = path.slice(0, currentPath.value.length + 1);
    const key = `directory:${child.join("/")}`;
    result.set(key, { type: "directory", key, name: child.at(-1) || "/", path: child });
  };
  for (const folder of props.folders ?? []) addDirectory(folder);
  for (const scene of props.scenes) {
    addDirectory(scene.path);
    if (!pathStartsWith(scene.path, currentPath.value) || scene.path.length !== currentPath.value.length) continue;
    result.set(`scene:${scene.id}`, {
      type: "scene",
      key: `scene:${scene.id}`,
      name: scene.name,
      path: [...scene.path, scene.name],
      scene,
    });
  }
  const needle = query.value.normalize("NFKC").trim().toLocaleLowerCase();
  return [...result.values()]
    .filter((entry) => !needle || entry.name.normalize("NFKC").toLocaleLowerCase().includes(needle))
    .sort((left, right) => {
      if (left.type !== right.type) return left.type === "directory" ? -1 : 1;
      return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" });
    });
});

const activate = (entry: SceneEntry) => {
  selectedKey.value = entry.key;
  if (entry.type === "directory") {
    currentPath.value = entry.path;
    query.value = "";
    if (itemsRoot.value) itemsRoot.value.scrollTop = 0;
    return;
  }
  emit("select", entry.scene.id);
};

const setView = (next: SceneView) => {
  view.value = next;
  if (import.meta.client) localStorage.setItem("story-editor-scene-view", next);
  if (itemsRoot.value) itemsRoot.value.scrollTop = 0;
  itemsScrollTop.value = 0;
};

const updateItemsViewport = () => {
  const root = itemsRoot.value;
  if (!root) return;
  const style = getComputedStyle(root);
  itemsScrollTop.value = root.scrollTop;
  itemsWidth.value = Math.max(
    1,
    root.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight),
  );
  itemsHeight.value = Math.max(
    1,
    root.clientHeight - Number.parseFloat(style.paddingTop) - Number.parseFloat(style.paddingBottom),
  );
};
const columnCount = computed(() => Math.max(1, Math.floor(itemsWidth.value / (view.value === "grid" ? 96 : 192))));
const rowHeight = computed(() => (view.value === "grid" ? itemsWidth.value / columnCount.value : 32));
const rowCount = computed(() => Math.ceil(entries.value.length / columnCount.value));
const virtualRange = computed(() => {
  const startRow = Math.max(0, Math.floor(itemsScrollTop.value / Math.max(1, rowHeight.value)) - 2);
  const endRow = Math.min(
    rowCount.value,
    Math.ceil((itemsScrollTop.value + itemsHeight.value) / Math.max(1, rowHeight.value)) + 2,
  );
  return { startRow, endRow };
});
const visibleEntries = computed(() =>
  entries.value.slice(virtualRange.value.startRow * columnCount.value, virtualRange.value.endRow * columnCount.value),
);
const canvasStyle = computed(() => ({ height: `${rowCount.value * rowHeight.value}px` }));
const windowStyle = computed(() => ({
  gridTemplateColumns: `repeat(${columnCount.value}, minmax(0, 1fr))`,
  gridAutoRows: `${rowHeight.value}px`,
  transform: `translateY(${virtualRange.value.startRow * rowHeight.value}px)`,
}));

onMounted(() => {
  const stored = localStorage.getItem("story-editor-scene-view");
  if (stored === "grid" || stored === "list") view.value = stored;
  itemsObserver = new ResizeObserver(updateItemsViewport);
  if (itemsRoot.value) itemsObserver.observe(itemsRoot.value);
  updateItemsViewport();
});

onBeforeUnmount(() => itemsObserver?.disconnect());
</script>

<template>
  <section class="story-scene-library" :aria-label="copy.scenes">
    <div class="story-scene-library__filter">
      <slot name="leading" />
      <SearchField v-model="query" compact :label="copy.scenes" />
    </div>
    <div class="story-scene-library__pathbar">
      <UiIconButton
        v-if="currentPath.length"
        size="compact"
        :label="t('previous')"
        @click="currentPath = currentPath.slice(0, -1)"
      >
        <MaterialIcon name="arrow_back" :size="20" />
      </UiIconButton>
      <code class="story-scene-library__path">{{ currentPath.join("/") || "/" }}</code>
      <UiIconButton size="compact" :label="copy.addScene" @click="emit('add', [...currentPath])">
        <MaterialIcon name="note_add" :size="20" />
      </UiIconButton>
      <UiIconButton size="compact" :label="copy.addFolder" @click="emit('add-folder', [...currentPath])">
        <MaterialIcon name="create_new_folder" :size="20" />
      </UiIconButton>
      <UiIconButton
        size="compact"
        :label="view === 'list' ? t('grid') : t('list')"
        @click="setView(view === 'list' ? 'grid' : 'list')"
      >
        <MaterialIcon :name="view === 'list' ? 'grid_view' : 'view_list'" :size="20" />
      </UiIconButton>
    </div>
    <div ref="itemsRoot" class="story-scene-library__items" @scroll.passive="updateItemsViewport">
      <EmptyState v-if="!entries.length" />
      <div v-else class="story-scene-library__canvas" :style="canvasStyle">
        <div class="story-scene-library__files" :class="`is-${view}`" :style="windowStyle">
          <article
            v-for="entry in visibleEntries"
            :key="entry.key"
            class="story-scene-file"
            :class="{
              'is-selected': selectedKey === entry.key || (entry.type === 'scene' && entry.scene.id === activeSceneId),
            }"
            role="button"
            tabindex="0"
            @click="activate(entry)"
            @keydown.enter.self.prevent="activate(entry)"
            @keydown.space.self.prevent="activate(entry)"
          >
            <MaterialIcon
              class="story-scene-file__icon"
              :name="entry.type === 'directory' ? 'folder' : 'movie'"
              :size="view === 'grid' ? 40 : 20"
            />
            <div class="story-scene-file__name">
              <span>{{ entry.name }}</span>
              <MaterialIcon
                v-if="entry.type === 'scene' && entry.scene.isEntry"
                :title="copy.entryScene"
                name="star"
                :size="16"
                filled
              />
              <small v-if="view === 'list' && entry.type === 'scene'">
                {{ entry.scene.commandCount }}
              </small>
            </div>
            <div v-if="entry.type === 'scene'" class="story-scene-file__actions">
              <UiIconButton
                size="compact"
                :label="copy.renameScene"
                @click.stop="emit('rename', entry.scene.id, entry.scene.name)"
              >
                <MaterialIcon name="edit" :size="18" />
              </UiIconButton>
              <UiIconButton
                size="compact"
                :disabled="!entry.scene.canDelete"
                :label="copy.deleteScene"
                @click.stop="emit('delete', entry.scene.id)"
              >
                <MaterialIcon name="delete" :size="18" />
              </UiIconButton>
            </div>
          </article>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.story-scene-library {
  display: flex;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  flex-direction: column;
  overflow: hidden;
  background: var(--md-sys-color-surface-container-lowest);
}

.story-scene-library__filter,
.story-scene-library__pathbar {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 4px;
  padding: 4px;
}

.story-scene-library__filter :deep(.search-field) {
  height: var(--md-comp-control-height-compact);
  min-width: 0;
  min-height: var(--md-comp-control-height-compact);
  flex: 1;
}

.story-scene-library__pathbar {
  padding-top: 0;
  border-bottom: 1px solid var(--md-sys-color-outline-variant);
}

.story-scene-library__path {
  display: flex;
  min-width: 0;
  height: var(--md-comp-control-height-compact);
  flex: 1;
  align-items: center;
  padding: 0 var(--md-sys-spacing-2);
  overflow: hidden;
  color: var(--md-sys-color-on-surface-variant);
  border-radius: var(--md-sys-shape-corner-small);
  background: var(--md-sys-color-surface-container);
  font-size: var(--md-sys-typescale-label-small-size);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.story-scene-library__items {
  position: relative;
  min-height: 0;
  flex: 1;
  overflow: auto;
  padding: 4px;
  scrollbar-width: thin;
}

.story-scene-library__canvas {
  position: relative;
  width: 100%;
}

.story-scene-library__files {
  position: absolute;
  inset: 0 0 auto;
  display: grid;
  align-content: start;
  width: 100%;
  will-change: transform;
}

.story-scene-file {
  position: relative;
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 4px;
  padding: 0 8px;
  overflow: hidden;
  border-radius: var(--md-sys-shape-corner-small);
  cursor: pointer;
}

.story-scene-file:hover {
  background: color-mix(in srgb, var(--md-sys-color-on-surface) 8%, transparent);
}

.story-scene-file.is-selected {
  color: var(--md-sys-color-on-secondary-container);
  background: var(--md-sys-color-secondary-container);
}

.is-grid .story-scene-file {
  flex-direction: column;
  justify-content: center;
}

.is-list .story-scene-file {
  height: 32px;
}

.story-scene-file__icon {
  color: var(--md-sys-color-primary);
}

.story-scene-file__name {
  display: flex;
  min-width: 0;
  flex: 1;
  align-items: center;
  justify-content: center;
  gap: 4px;
  overflow: hidden;
  font-size: 0.62rem;
}

.story-scene-file__name span,
.story-scene-file__name small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.story-scene-file__name small {
  color: var(--md-sys-color-outline);
}

.story-scene-file__actions {
  position: absolute;
  top: 1px;
  right: 2px;
  display: flex;
  padding: 0 4px;
  border-radius: 4px;
  background: var(--md-sys-color-surface-container-lowest);
  visibility: hidden;
}

.story-scene-file:hover .story-scene-file__actions,
.story-scene-file:focus-within .story-scene-file__actions {
  visibility: visible;
}
</style>
