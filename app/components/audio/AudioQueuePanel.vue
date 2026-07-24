<script setup lang="ts">
import { MaterialIcon, UiIconButton, UiList, UiListItem } from "@haneoka/ui";

import type { AudioTrack } from "~/composables/useAudioPlayer";
import { contentOriginKey } from "~/features/catalog/contentSource";
import { textOf } from "~/types/displayText";

const props = defineProps<{
  queue: AudioTrack[];
  currentIndex: number;
}>();

const emit = defineEmits<{
  select: [index: number];
  remove: [index: number];
  move: [fromIndex: number, toIndex: number];
  clear: [];
  previous: [];
  next: [];
  close: [];
}>();

const { t } = useLocale();
const playLabelId = useId();
const removeLabelId = useId();
const titleId = useId();
const itemTitleId = (index: number) => `${titleId}-${index}`;
const bandVisualsOf = (item: AudioTrack) =>
  item.bandVisuals?.length
    ? item.bandVisuals
    : item.bandIcon
      ? [{ image: item.bandIcon, fit: "contain" as const }]
      : [];
const draggedIndex = ref<number>();
const dropTargetIndex = ref<number>();
const reorderStatus = ref("");
const queueList = ref<{ $el?: HTMLElement }>();
const currentOccurrence = computed(() => {
  const item = props.queue[props.currentIndex];
  return item
    ? `${props.currentIndex}:${item.queueId || `${contentOriginKey(item.origin)}:${item.id}:${item.source}`}`
    : `${props.currentIndex}:`;
});
let pointerId: number | undefined;
let pointerSourceIndex = -1;
let pointerStartY = 0;
let centerFrame: number | undefined;
let centerAfterDrag = false;
let listResizeObserver: ResizeObserver | undefined;

const listElement = () => queueList.value?.$el;
const currentRow = () => listElement()?.querySelector<HTMLElement>(`[data-queue-index="${props.currentIndex}"]`);

const centerCurrent = () => {
  if (!import.meta.client) return;
  if (pointerId !== undefined || draggedIndex.value !== undefined) {
    centerAfterDrag = true;
    return;
  }
  if (centerFrame !== undefined) cancelAnimationFrame(centerFrame);
  centerFrame = requestAnimationFrame(() => {
    centerFrame = undefined;
    const list = listElement();
    const row = currentRow();
    if (!list || !row) return;

    const listBounds = list.getBoundingClientRect();
    const rowBounds = row.getBoundingClientRect();
    const requested = list.scrollTop + rowBounds.top - listBounds.top + rowBounds.height / 2 - list.clientHeight / 2;
    const maximum = Math.max(0, list.scrollHeight - list.clientHeight);
    list.scrollTop = Math.max(0, Math.min(maximum, requested));
  });
};

defineExpose({ centerCurrent });

const announceMove = (fromIndex: number, toIndex: number) => {
  const item = props.queue[fromIndex];
  if (!item || fromIndex === toIndex) return;
  reorderStatus.value = `${textOf(item.title)} — ${toIndex < fromIndex ? t("moveUp") : t("moveDown")} — ${toIndex + 1}/${props.queue.length}`;
};

const resetPointerDrag = (target?: EventTarget | null) => {
  const shouldCenter = centerAfterDrag || draggedIndex.value !== undefined;
  if (target instanceof Element && pointerId !== undefined && target.hasPointerCapture(pointerId)) {
    target.releasePointerCapture(pointerId);
  }
  pointerId = undefined;
  pointerSourceIndex = -1;
  draggedIndex.value = undefined;
  dropTargetIndex.value = undefined;
  centerAfterDrag = false;
  if (shouldCenter) void nextTick(centerCurrent);
};

const onPointerDown = (event: PointerEvent, index: number) => {
  if (event.button !== 0) return;
  event.stopPropagation();
  pointerId = event.pointerId;
  pointerSourceIndex = index;
  pointerStartY = event.clientY;
  (event.currentTarget as Element).setPointerCapture(event.pointerId);
};

const onPointerMove = (event: PointerEvent) => {
  if (event.pointerId !== pointerId || pointerSourceIndex < 0) return;
  if (draggedIndex.value === undefined && Math.abs(event.clientY - pointerStartY) < 5) return;
  event.preventDefault();
  draggedIndex.value = pointerSourceIndex;
  const list = listElement();
  const row = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-queue-index]");
  let targetIndex = Number(row?.dataset.queueIndex);
  if (!Number.isInteger(targetIndex) && list) {
    const rows = [...list.querySelectorAll<HTMLElement>("[data-queue-index]")];
    const first = rows[0];
    const last = rows.at(-1);
    const listBounds = list.getBoundingClientRect();
    if (event.clientY >= listBounds.top && event.clientY <= listBounds.bottom) {
      if (first && event.clientY < first.getBoundingClientRect().top) targetIndex = 0;
      else if (last && event.clientY > last.getBoundingClientRect().bottom) targetIndex = props.queue.length - 1;
    }
  }
  dropTargetIndex.value = Number.isInteger(targetIndex) ? targetIndex : undefined;
};

const onPointerUp = (event: PointerEvent) => {
  if (event.pointerId !== pointerId) return;
  const fromIndex = pointerSourceIndex;
  const toIndex = dropTargetIndex.value;
  if (draggedIndex.value !== undefined && toIndex !== undefined && fromIndex !== toIndex) {
    announceMove(fromIndex, toIndex);
    emit("move", fromIndex, toIndex);
  }
  resetPointerDrag(event.currentTarget);
};

const onReorderKeydown = (event: KeyboardEvent, index: number) => {
  let targetIndex: number | undefined;
  if (event.key === "ArrowUp") targetIndex = index - 1;
  else if (event.key === "ArrowDown") targetIndex = index + 1;
  else if (event.key === "Home") targetIndex = 0;
  else if (event.key === "End") targetIndex = props.queue.length - 1;
  if (targetIndex === undefined || targetIndex < 0 || targetIndex >= props.queue.length || targetIndex === index)
    return;
  event.preventDefault();
  event.stopPropagation();
  announceMove(index, targetIndex);
  emit("move", index, targetIndex);
};

watch(currentOccurrence, () => void nextTick(centerCurrent), { flush: "post" });

onMounted(async () => {
  await nextTick();
  const list = listElement();
  if (list) {
    listResizeObserver = new ResizeObserver(centerCurrent);
    listResizeObserver.observe(list);
  }
  centerCurrent();
});

onBeforeUnmount(() => {
  listResizeObserver?.disconnect();
  if (centerFrame !== undefined) cancelAnimationFrame(centerFrame);
});
</script>

<template>
  <section
    class="audio-queue-panel"
    role="dialog"
    aria-modal="true"
    :aria-label="t('queue')"
    :style="{ '--audio-queue-content-height': `${56 + queue.length * 56}px` }"
  >
    <span :id="playLabelId" class="sr-only">{{ t("play") }}</span>
    <span :id="removeLabelId" class="sr-only">{{ t("remove") }}</span>
    <header class="audio-queue-panel__header">
      <div class="audio-queue-panel__title">
        <MaterialIcon name="queue_music" :size="17" />
        <strong>{{ t("queue") }}</strong>
        <span class="display-number">{{ queue.length }}</span>
      </div>
      <div class="audio-queue-panel__actions" role="toolbar" :aria-label="t('playback')">
        <UiIconButton
          class="audio-queue-panel__header-action"
          tone="runtime"
          size="compact"
          :label="t('previous')"
          @click="$emit('previous')"
        >
          <MaterialIcon name="skip_previous" :size="16" />
        </UiIconButton>
        <UiIconButton
          class="audio-queue-panel__header-action"
          tone="runtime"
          size="compact"
          :label="t('next')"
          @click="$emit('next')"
        >
          <MaterialIcon name="skip_next" :size="16" />
        </UiIconButton>
        <UiIconButton
          class="audio-queue-panel__header-action"
          tone="runtime"
          size="compact"
          :label="t('clear')"
          @click="$emit('clear')"
        >
          <MaterialIcon name="delete_sweep" :size="17" />
        </UiIconButton>
      </div>
      <UiIconButton
        class="audio-queue-panel__header-action audio-queue-panel__close"
        tone="runtime"
        size="compact"
        :label="t('close')"
        @click="$emit('close')"
      >
        <MaterialIcon name="close" :size="17" />
      </UiIconButton>
    </header>

    <span class="sr-only" aria-live="polite">{{ reorderStatus }}</span>

    <UiList ref="queueList" class="audio-queue-panel__list" :aria-label="t('tracks')">
      <UiListItem
        v-for="(item, index) in queue"
        :key="item.queueId || `${contentOriginKey(item.origin)}:${item.id}:${item.source}`"
        type="button"
        class="audio-queue-panel__track"
        :class="{
          'is-current': index === currentIndex,
          'is-dragging': index === draggedIndex,
          'is-drop-target': index === dropTargetIndex && index !== draggedIndex,
        }"
        :data-queue-index="index"
        :aria-current="index === currentIndex ? 'true' : undefined"
        :aria-labelledby="`${playLabelId} ${itemTitleId(index)}`"
        @click="$emit('select', index)"
      >
        <template #start>
          <UiIconButton
            class="audio-queue-panel__drag"
            tone="runtime"
            size="compact"
            :disabled="queue.length < 2"
            :label="`${t('reorder')} ${textOf(item.title)}`"
            aria-keyshortcuts="ArrowUp ArrowDown Home End"
            @click.stop
            @keydown="onReorderKeydown($event, index)"
            @pointerdown="onPointerDown($event, index)"
            @pointermove="onPointerMove"
            @pointerup="onPointerUp"
            @pointercancel="resetPointerDrag($event.currentTarget)"
            @lostpointercapture="resetPointerDrag($event.currentTarget)"
          >
            <MaterialIcon name="drag_indicator" :size="17" />
          </UiIconButton>
          <img v-if="item.cover" :src="item.cover" alt="" loading="lazy" />
          <span v-else class="audio-queue-panel__placeholder"><MaterialIcon name="queue_music" :size="15" /></span>
        </template>
        <template #headline>
          <strong :id="itemTitleId(index)"><DisplayText :value="item.title" /></strong>
        </template>
        <template v-if="textOf(item.band)" #supporting>
          <span class="audio-queue-panel__band">
            <SongCreditVisual
              v-if="bandVisualsOf(item).length"
              class="audio-queue-panel__band-visual"
              :items="bandVisualsOf(item)"
            />
            <span><DisplayText :value="item.band" /></span>
          </span>
        </template>
        <template #end>
          <span class="display-number">{{ String(index + 1).padStart(2, "0") }}</span>
          <UiIconButton
            class="audio-queue-panel__remove"
            tone="runtime"
            size="compact"
            :label="t('remove')"
            :aria-labelledby="`${removeLabelId} ${itemTitleId(index)}`"
            @click.stop="$emit('remove', index)"
          >
            <MaterialIcon name="delete" :size="15" />
          </UiIconButton>
        </template>
      </UiListItem>
    </UiList>
  </section>
</template>

<style scoped>
.audio-queue-panel {
  --audio-queue-header-control-size: var(--md-comp-runtime-control-size-compact);
  --audio-queue-track-height: 56px;

  display: grid;
  min-height: 0;
  grid-template-rows: auto minmax(0, 1fr);
  overflow: hidden;
  color: var(--md-comp-runtime-on-surface);
  border: 1px solid var(--md-comp-runtime-outline);
  border-radius: var(--md-sys-shape-corner-medium) var(--md-sys-shape-corner-medium) 0 0;
  background: var(--md-comp-runtime-surface-high);
  box-shadow: var(--md-comp-runtime-elevation);
}

.audio-queue-panel__header {
  display: flex;
  height: 56px;
  min-width: 0;
  min-height: 56px;
  max-height: 56px;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 7px 8px 7px 14px;
  overflow: hidden;
  border-bottom: 1px solid var(--md-comp-runtime-outline);
}

.audio-queue-panel__title,
.audio-queue-panel__actions {
  display: flex;
  min-width: 0;
  align-items: center;
}

.audio-queue-panel__title {
  flex: 1 1 auto;
  gap: 8px;
  overflow: hidden;
  font-family: var(--md-sys-typescale-title-small-font);
  font-size: var(--md-sys-typescale-title-small-size);
  line-height: var(--md-sys-typescale-title-small-line-height);
}

.audio-queue-panel__title strong {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.audio-queue-panel__title > span {
  color: var(--md-comp-runtime-on-surface-variant);
  font-size: var(--md-sys-typescale-label-small-size);
}

.audio-queue-panel__actions {
  height: var(--audio-queue-header-control-size);
  max-width: 72%;
  flex: 0 1 auto;
  gap: 3px;
  margin-left: auto;
  overflow: hidden;
}

.audio-queue-panel__header-action {
  width: var(--audio-queue-header-control-size);
  min-width: var(--audio-queue-header-control-size);
  max-width: var(--audio-queue-header-control-size);
  height: var(--audio-queue-header-control-size);
  min-height: var(--audio-queue-header-control-size);
  max-height: var(--audio-queue-header-control-size);
  flex: 0 0 var(--audio-queue-header-control-size);
  align-self: center;
  padding: 0;
  margin: 0;
  overflow: hidden;
  line-height: 0;
  vertical-align: middle;
  --md-comp-icon-button-hit-size: var(--audio-queue-header-control-size);
  --md-comp-icon-button-visual-size: var(--audio-queue-header-control-size);
}

.audio-queue-panel__close {
  flex: 0 0 auto;
}

.audio-queue-panel__list {
  min-height: 0;
  padding: 0;
  margin: 0;
  overflow-y: auto;
  list-style: none;
  overscroll-behavior: contain;
  scrollbar-color: var(--md-comp-runtime-outline) transparent;
  scrollbar-width: thin;
}

.audio-queue-panel__track {
  position: relative;
  height: var(--audio-queue-track-height);
  min-height: var(--audio-queue-track-height);
  max-height: var(--audio-queue-track-height);
  overflow: hidden;
  border-radius: 0;
  box-shadow: inset 0 -1px var(--md-comp-runtime-outline);
  --md-list-item-one-line-container-height: var(--audio-queue-track-height);
  --md-list-item-two-line-container-height: var(--audio-queue-track-height);
  --md-list-item-top-space: var(--md-sys-spacing-2);
  --md-list-item-bottom-space: var(--md-sys-spacing-2);
  --md-list-item-label-text-size: var(--md-sys-typescale-label-medium-size);
  --md-list-item-label-text-line-height: var(--md-sys-typescale-label-medium-line-height);
  --md-list-item-label-text-weight: var(--md-sys-typescale-label-medium-weight);
  --md-list-item-supporting-text-size: var(--md-sys-typescale-label-small-size);
  --md-list-item-supporting-text-line-height: var(--md-sys-typescale-label-small-line-height);
  --md-list-item-supporting-text-weight: var(--md-sys-typescale-label-small-weight);
  --md-list-item-container-color: transparent;
  --md-list-item-label-text-color: var(--md-comp-runtime-on-surface);
  --md-list-item-supporting-text-color: var(--md-comp-runtime-on-surface-variant);
  --md-list-item-hover-state-layer-color: var(--md-comp-runtime-primary);
  --md-list-item-focus-state-layer-color: var(--md-comp-runtime-primary);
  --md-list-item-pressed-state-layer-color: var(--md-comp-runtime-primary);
}

.audio-queue-panel__track::before {
  position: absolute;
  top: 8px;
  bottom: 8px;
  left: 0;
  width: 2px;
  background: var(--md-comp-runtime-primary);
  content: "";
  opacity: 0;
}

.audio-queue-panel__track.is-current {
  --md-list-item-container-color: var(--md-comp-runtime-primary-container);
}

.audio-queue-panel__track.is-current::before {
  opacity: 1;
}

.audio-queue-panel__track.is-dragging {
  opacity: 0.55;
}

.audio-queue-panel__track.is-drop-target {
  box-shadow:
    inset 0 -1px var(--md-comp-runtime-outline),
    inset 0 2px var(--md-comp-runtime-primary);
}

.audio-queue-panel__track :deep([slot="start"]),
.audio-queue-panel__track :deep([slot="end"]) {
  display: flex;
  align-items: center;
  gap: var(--md-sys-spacing-2);
}

.audio-queue-panel__track :deep([slot="start"] > img),
.audio-queue-panel__placeholder {
  width: 40px;
  height: 40px;
  border: 1px solid var(--md-comp-runtime-outline);
  border-radius: var(--md-sys-shape-corner-extra-small);
}

.audio-queue-panel__track :deep([slot="start"] > img) {
  object-fit: cover;
}

.audio-queue-panel__drag {
  cursor: grab;
  touch-action: none;
  user-select: none;
  --md-comp-icon-button-hit-size: 28px;
  --md-comp-icon-button-visual-size: 28px;
}

.audio-queue-panel__drag:active {
  cursor: grabbing;
}

.audio-queue-panel__placeholder {
  display: grid;
  place-items: center;
  color: var(--md-comp-runtime-on-surface-variant);
  background: var(--md-comp-runtime-primary-container);
}

.audio-queue-panel__band {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 5px;
}

.audio-queue-panel__band-visual {
  --song-credit-logo-width: 28px;
  --song-credit-logo-height: 15px;
  --song-credit-avatar-size: 17px;
  --song-credit-gap: 1px;
  --song-credit-avatar-overlap: -4px;
}

.audio-queue-panel__track :deep([slot="headline"]),
.audio-queue-panel__track :deep([slot="supporting-text"]) {
  overflow: hidden;
  line-height: var(--md-sys-typescale-label-small-line-height);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.audio-queue-panel__track :deep([slot="headline"]) {
  line-height: var(--md-sys-typescale-label-medium-line-height);
}

.audio-queue-panel__track :deep([slot="headline"] strong) {
  font-size: var(--md-sys-typescale-label-medium-size);
  font-weight: var(--md-sys-typescale-label-medium-weight);
  line-height: var(--md-sys-typescale-label-medium-line-height);
}

.audio-queue-panel__track :deep([slot="supporting-text"]),
.audio-queue-panel__track :deep([slot="end"] > .display-number) {
  color: var(--md-comp-runtime-on-surface-variant);
  font-size: var(--md-sys-typescale-label-small-size);
  line-height: var(--md-sys-typescale-label-small-line-height);
}

@media (max-width: 540px) {
  .audio-queue-panel__header {
    min-height: 56px;
    gap: 6px;
    padding-left: 10px;
  }

  .audio-queue-panel__title {
    min-width: 0;
  }

  .audio-queue-panel__actions {
    flex: 0 0 auto;
    gap: 1px;
  }

  .audio-queue-panel__drag {
    --md-comp-icon-button-hit-size: var(--md-comp-control-height-touch);
    --md-comp-icon-button-visual-size: 28px;
  }

  .audio-queue-panel__remove {
    --md-comp-icon-button-hit-size: var(--md-comp-control-height-touch);
    --md-comp-icon-button-visual-size: 32px;
  }
}

@media (max-width: 959px) and (max-height: 500px), (hover: none) and (pointer: coarse) {
  .audio-queue-panel {
    --audio-queue-header-control-size: var(--md-comp-control-height-touch);
  }

  .audio-queue-panel__drag {
    --md-comp-icon-button-hit-size: var(--md-comp-control-height-touch);
    --md-comp-icon-button-visual-size: 28px;
  }
}
</style>
