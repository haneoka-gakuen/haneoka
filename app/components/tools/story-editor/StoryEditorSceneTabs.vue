<!--
  This Source Code Form is subject to the terms of the Mozilla Public
  License, v. 2.0. If a copy of the MPL was not distributed with this
  file, You can obtain one at https://mozilla.org/MPL/2.0/.

  Portions are adapted from OpenWebGAL/WebGAL_Terre's TagsManager
  component at commit 7b7a2159a5ccead80327437b7305b8fdb47a4e5f.
  See packages/story-editor/NOTICE.webgal.md for complete provenance.
-->
<script setup lang="ts">
import { MaterialIcon, UiIconButton } from "@haneoka/ui";

import type { StoryScene } from "@haneoka/story-editor";

const props = defineProps<{
  modelValue: string[];
  scenes: StoryScene[];
  currentId: string;
  entryId: string;
}>();

const emit = defineEmits<{
  "update:modelValue": [ids: string[]];
  select: [id: string];
  add: [];
}>();

const { t, messages } = useLocale();
const copy = messages("storyEditorPage");
const tabArea = ref<HTMLElement>();
const tablist = ref<HTMLElement & { activeTabIndex: number }>();
const closePositions = ref<Record<string, number>>({});
const draggedId = ref("");
const dropTargetId = ref("");
let closePositionFrame: number | undefined;
let tabResizeObserver: ResizeObserver | undefined;

const sameIds = (left: string[], right: string[]) =>
  left.length === right.length && left.every((id, index) => id === right[index]);

const normalizeIds = () => {
  const validIds = new Set(props.scenes.map((scene) => scene.id));
  const ids: string[] = [];
  for (const id of props.modelValue) {
    if (validIds.has(id) && !ids.includes(id)) ids.push(id);
  }

  const fallbackId = validIds.has(props.currentId)
    ? props.currentId
    : validIds.has(props.entryId)
      ? props.entryId
      : props.scenes[0]?.id;
  if (fallbackId && !ids.includes(fallbackId)) ids.push(fallbackId);
  return ids;
};

const openedScenes = computed(() => {
  const sceneById = new Map(props.scenes.map((scene) => [scene.id, scene]));
  return normalizeIds().flatMap((id) => {
    const scene = sceneById.get(id);
    return scene ? [scene] : [];
  });
});

const activeTabIndex = computed(() => openedScenes.value.findIndex((scene) => scene.id === props.currentId));

const reconcile = () => {
  const ids = normalizeIds();
  if (!sameIds(ids, props.modelValue)) emit("update:modelValue", ids);
};

const selectTab = (id: string) => emit("select", id);

const closeTab = (id: string) => {
  const ids = normalizeIds();
  const index = ids.indexOf(id);
  if (index < 0) return;

  const nextIds = ids.filter((item) => item !== id);
  if (id !== props.currentId) {
    emit("update:modelValue", nextIds);
    return;
  }

  let nextId: string | undefined = nextIds[Math.min(index, nextIds.length - 1)];
  if (!nextId) {
    nextId = props.scenes.find((scene) => scene.id === props.entryId && scene.id !== id)?.id;
  }
  if (!nextId) return;

  if (!nextIds.includes(nextId)) nextIds.push(nextId);
  emit("update:modelValue", nextIds);
  emit("select", nextId);
};

const onAuxClick = (event: MouseEvent, id: string) => {
  if (event.button !== 1) return;
  event.preventDefault();
  closeTab(id);
};

const onDragStart = (event: DragEvent, id: string) => {
  draggedId.value = id;
  if (!event.dataTransfer) return;
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", id);
};

const onDragOver = (event: DragEvent, id: string) => {
  if (!draggedId.value || draggedId.value === id) return;
  event.preventDefault();
  dropTargetId.value = id;
  if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
};

const onDrop = (event: DragEvent, targetId: string) => {
  event.preventDefault();
  const sourceId = draggedId.value || event.dataTransfer?.getData("text/plain") || "";
  const ids = normalizeIds();
  const sourceIndex = ids.indexOf(sourceId);
  const targetIndex = ids.indexOf(targetId);
  if (sourceIndex >= 0 && targetIndex >= 0 && sourceIndex !== targetIndex) {
    ids.splice(sourceIndex, 1);
    ids.splice(targetIndex, 0, sourceId);
    emit("update:modelValue", ids);
  }
  draggedId.value = "";
  dropTargetId.value = "";
};

const onDragEnd = () => {
  draggedId.value = "";
  dropTargetId.value = "";
};

const onTabChange = (event: Event) => {
  const index = (event.currentTarget as HTMLElement & { activeTabIndex?: number }).activeTabIndex;
  const scene = typeof index === "number" ? openedScenes.value[index] : undefined;
  if (scene) selectTab(scene.id);
};

const updateClosePositions = () => {
  const area = tabArea.value;
  const tabs = tablist.value;
  if (!area || !tabs) return;

  const areaBounds = area.getBoundingClientRect();
  const positions: Record<string, number> = {};
  for (const tab of tabs.querySelectorAll<HTMLElement>("[data-scene-id]")) {
    const id = tab.dataset.sceneId;
    if (!id) continue;

    const bounds = tab.getBoundingClientRect();
    const closeCenter = bounds.right - 20;
    if (closeCenter < areaBounds.left || closeCenter > areaBounds.right) continue;
    positions[id] = Math.max(0, bounds.right - areaBounds.left - 40);
  }
  closePositions.value = positions;
};

const scheduleClosePositions = () => {
  if (typeof window === "undefined") return;
  if (closePositionFrame !== undefined) window.cancelAnimationFrame(closePositionFrame);
  closePositionFrame = window.requestAnimationFrame(() => {
    closePositionFrame = undefined;
    updateClosePositions();
  });
};

const closeButtonStyle = (id: string) => {
  const left = closePositions.value[id];
  return typeof left === "number" ? { left: `${left}px` } : { visibility: "hidden" };
};

const synchronizeActiveTab = async () => {
  await nextTick();
  const index = activeTabIndex.value;
  if (tablist.value && index >= 0 && tablist.value.activeTabIndex !== index) {
    tablist.value.activeTabIndex = index;
  }
  scheduleClosePositions();
};

watch(
  [
    () => props.currentId,
    () => props.entryId,
    () => props.modelValue.join("\u0000"),
    () => props.scenes.map((scene) => scene.id).join("\u0000"),
  ],
  reconcile,
  { immediate: true },
);

watch(
  () => [props.currentId, ...openedScenes.value.map((scene) => `${scene.id}\u0000${scene.name}`)],
  () => void synchronizeActiveTab(),
  { flush: "post", immediate: true },
);

onMounted(() => {
  if (tabArea.value) {
    tabResizeObserver = new ResizeObserver(scheduleClosePositions);
    tabResizeObserver.observe(tabArea.value);
  }
  scheduleClosePositions();
});

onBeforeUnmount(() => {
  if (closePositionFrame !== undefined) window.cancelAnimationFrame(closePositionFrame);
  tabResizeObserver?.disconnect();
});
</script>

<template>
  <header class="story-editor-scene-tabs">
    <div ref="tabArea" class="story-editor-scene-tabs__area">
      <md-tabs
        ref="tablist"
        class="story-editor-scene-tabs__list"
        :aria-label="copy.scenes"
        @change="onTabChange"
        @scroll.passive="scheduleClosePositions"
      >
        <md-primary-tab
          v-for="scene in openedScenes"
          :key="scene.id"
          class="story-editor-scene-tabs__tab"
          :class="{
            'is-dragging': scene.id === draggedId,
            'is-drop-target': scene.id === dropTargetId,
          }"
          inline-icon
          :data-scene-id="scene.id"
          :draggable="true"
          :title="scene.name"
          @mousedown.middle.prevent
          @auxclick="onAuxClick($event, scene.id)"
          @dragstart="onDragStart($event, scene.id)"
          @dragover="onDragOver($event, scene.id)"
          @dragleave="dropTargetId === scene.id && (dropTargetId = '')"
          @drop="onDrop($event, scene.id)"
          @dragend="onDragEnd"
        >
          <!-- eslint-disable-next-line vue/no-deprecated-slot-attribute -- md-primary-tab uses the native Web Component slot API. -->
          <MaterialIcon slot="icon" name="description" :size="16" aria-hidden="true" />
          <span class="story-editor-scene-tabs__label">{{ scene.name }}</span>
        </md-primary-tab>
      </md-tabs>
      <div class="story-editor-scene-tabs__close-layer">
        <UiIconButton
          v-for="scene in openedScenes"
          :key="scene.id"
          class="story-editor-scene-tabs__close"
          size="compact"
          :label="`${t('close')} ${scene.name}`"
          :style="closeButtonStyle(scene.id)"
          @click.stop="closeTab(scene.id)"
        >
          <MaterialIcon name="close" :size="16" />
        </UiIconButton>
      </div>
    </div>
    <UiIconButton class="story-editor-scene-tabs__add" size="compact" :label="copy.addScene" @click="emit('add')">
      <MaterialIcon name="add" :size="18" />
    </UiIconButton>
  </header>
</template>

<style scoped>
.story-editor-scene-tabs {
  display: flex;
  min-width: 0;
  align-items: stretch;
  border-bottom: 1px solid var(--md-sys-color-outline-variant);
  background: var(--md-sys-color-surface-container-low);
}

.story-editor-scene-tabs__area {
  position: relative;
  min-width: 0;
  flex: 1 1 auto;
}

.story-editor-scene-tabs__list {
  display: block;
  width: 100%;
  min-width: 0;
  flex: 1 1 auto;
  overflow-x: auto;
  overflow-y: hidden;
  --md-primary-tab-active-icon-color: var(--md-sys-color-primary);
  --md-primary-tab-active-indicator-color: var(--md-sys-color-primary);
  --md-primary-tab-active-label-text-color: var(--md-sys-color-primary);
  --md-primary-tab-container-color: var(--md-sys-color-surface-container-low);
  --md-primary-tab-container-height: var(--md-comp-control-height-compact);
  --md-primary-tab-label-text-font: var(--md-sys-typescale-label-large-font);
  --md-primary-tab-label-text-size: var(--md-sys-typescale-label-large-size);
  --md-primary-tab-label-text-weight: var(--md-sys-typescale-label-large-weight);
}

.story-editor-scene-tabs__tab {
  position: relative;
  min-width: 112px;
  max-width: 220px;
  padding-inline: var(--md-sys-spacing-2);
  padding-inline-end: calc(var(--md-comp-control-height-compact) + var(--md-sys-spacing-1));
}

.story-editor-scene-tabs__tab.is-dragging {
  opacity: 0.42;
}

.story-editor-scene-tabs__tab.is-drop-target::before {
  position: absolute;
  z-index: 1;
  top: 3px;
  bottom: 3px;
  left: -1px;
  width: 2px;
  border-radius: 2px;
  background: var(--md-sys-color-primary);
  content: "";
}

.story-editor-scene-tabs__label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.story-editor-scene-tabs__close,
.story-editor-scene-tabs__add {
  align-self: center;
  flex: 0 0 auto;
  --md-comp-icon-button-hit-size: var(--md-comp-control-height-compact);
  --md-comp-icon-button-visual-size: 28px;
  color: inherit;
}

.story-editor-scene-tabs__close-layer {
  position: absolute;
  z-index: 2;
  inset: 0;
  overflow: hidden;
  pointer-events: none;
}

.story-editor-scene-tabs__close {
  position: absolute;
  inset-block: 0;
  pointer-events: auto;
}

.story-editor-scene-tabs__add {
  margin-inline: var(--md-sys-spacing-1);
}
</style>
