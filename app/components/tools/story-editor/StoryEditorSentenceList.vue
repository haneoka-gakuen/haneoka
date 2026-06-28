<!--
  This Source Code Form is subject to the terms of the Mozilla Public
  License, v. 2.0. If a copy of the MPL was not distributed with this
  file, You can obtain one at https://mozilla.org/MPL/2.0/.

  Portions are adapted from OpenWebGAL/WebGAL_Terre's GraphicalEditor
  and graphicalEditor.module.scss at commit 7b7a2159a5ccead80327437b7305b8fdb47a4e5f.
  See packages/story-editor/NOTICE.webgal.md for complete provenance.
-->
<script setup lang="ts">
import { MaterialIcon, UiButton } from "@haneoka/ui";

import {
  commandFieldDescriptors,
  type CommandFieldDescriptor,
  type JsonObject,
  type JsonValue,
  type StoryProjectCommand,
  type StoryValidationIssue,
} from "@haneoka/story-editor";
import type { StoryEditorResourceTarget } from "./StoryEditorSentenceCard.vue";

const props = defineProps<{
  commands: readonly StoryProjectCommand[];
  selectedId?: string;
  issues?: readonly StoryValidationIssue[];
  sceneIndex: number;
  executableSourceIndexes?: ReadonlySet<number>;
}>();

const emit = defineEmits<{
  select: [id: string];
  patch: [payload: { id: string; key: string; value?: JsonValue }];
  replace: [payload: { id: string; fields: JsonObject }];
  duplicate: [id: string];
  remove: [id: string];
  move: [payload: { id: string; index: number }];
  "request-add": [index: number];
  "pick-resource": [target: StoryEditorResourceTarget];
  "execute-to": [payload: { id: string; sourceIndex: number }];
}>();

const copy = useLocale().messages("storyEditorPage");
const dragId = ref("");
const overIndex = ref<number>();
const scrollRoot = ref<HTMLElement>();
const scrollTop = ref(0);
const viewportHeight = ref(640);
const viewportWidth = ref(960);
const measuredRowHeights = reactive(new Map<string, number>());
const rowElements = new Map<string, HTMLElement>();
const estimatedRowHeightCache = new Map<
  string,
  { command: number | null; fieldSignature: string; width: number; height: number }
>();
const emptyIssues: readonly StoryValidationIssue[] = [];
const fallbackRowHeight = 124;
const lastInsertHeight = 52;
let rowObserver: ResizeObserver | undefined;
let scrollObserver: ResizeObserver | undefined;
let viewportFrame: number | undefined;

const estimatedFieldBox = (
  field: CommandFieldDescriptor,
  availableWidth: number,
  mobile: boolean,
): { width: number; height: number } => {
  if (field.kind === "localized-text") {
    return { width: mobile ? availableWidth : Math.min(availableWidth, 460), height: 73 };
  }
  if (field.kind === "resource" || field.kind === "resource-list") {
    return { width: mobile ? availableWidth : Math.min(availableWidth, 310), height: 49 };
  }
  if (field.kind === "vector3") {
    return { width: mobile ? availableWidth : Math.min(availableWidth, 300), height: 49 };
  }
  if (field.kind === "multi-select") {
    const width = mobile ? availableWidth : Math.min(availableWidth, 400);
    const choicesPerLine = Math.max(1, Math.floor((width + 3) / 88));
    const choiceLines = Math.max(1, Math.ceil((field.choices?.length || 1) / choicesPerLine));
    return { width, height: 49 + Math.max(0, choiceLines - 1) * 27 };
  }
  return { width: Math.min(availableWidth, mobile ? 150 : 190), height: 49 };
};

const estimatedCommandRowHeight = (command: StoryProjectCommand): number => {
  const width = Math.max(220, Math.round(viewportWidth.value / 8) * 8);
  const fieldSignature = Object.keys(command.fields).join("\u0001");
  const cached = estimatedRowHeightCache.get(command.id);
  if (cached?.command === command.command && cached.fieldSignature === fieldSignature && cached.width === width) {
    return cached.height;
  }

  const fields = commandFieldDescriptors(command);
  if (!fields.length) {
    estimatedRowHeightCache.set(command.id, {
      command: command.command,
      fieldSignature,
      width,
      height: 48,
    });
    return 48;
  }

  const availableWidth = Math.max(132, width - 68);
  const mobile = width <= 720;
  let currentWidth = 0;
  let currentHeight = 0;
  let fieldRows = 0;
  let fieldsHeight = 0;
  const finishRow = () => {
    if (!currentHeight) return;
    if (fieldRows) fieldsHeight += 6;
    fieldsHeight += currentHeight;
    fieldRows += 1;
    currentWidth = 0;
    currentHeight = 0;
  };

  for (const field of fields) {
    const box = estimatedFieldBox(field, availableWidth, mobile);
    const nextWidth = currentWidth ? currentWidth + 6 + box.width : box.width;
    if (currentWidth && nextWidth > availableWidth + 1) finishRow();
    currentWidth = currentWidth ? currentWidth + 6 + box.width : box.width;
    currentHeight = Math.max(currentHeight, box.height);
  }
  finishRow();

  // Insert affordance + card border/padding/header + field region.
  const height = Math.max(48, 52 + fieldsHeight);
  estimatedRowHeightCache.set(command.id, {
    command: command.command,
    fieldSignature,
    width,
    height,
  });
  return height;
};

const commandIndexById = computed(() => new Map(props.commands.map((command, index) => [command.id, index] as const)));

const itemLayout = computed(() => {
  const offsets = [0];
  for (const command of props.commands) {
    const estimate = measuredRowHeights.get(command.id) ?? estimatedCommandRowHeight(command);
    offsets.push(offsets[offsets.length - 1]! + estimate);
  }
  offsets.push(offsets[offsets.length - 1]! + lastInsertHeight);
  return { offsets, total: offsets[offsets.length - 1] || lastInsertHeight };
});

const itemIndexAt = (offsets: readonly number[], value: number) => {
  let low = 0;
  let high = Math.max(0, offsets.length - 2);
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (offsets[middle + 1]! <= value) low = middle + 1;
    else high = middle;
  }
  return low;
};

const virtualRange = computed(() => {
  const { offsets } = itemLayout.value;
  const count = props.commands.length + 1;
  const overscan = Math.min(360, Math.max(180, viewportHeight.value * 0.35));
  const top = Math.max(0, scrollTop.value - overscan);
  const bottom = scrollTop.value + viewportHeight.value + overscan;
  const start = Math.min(count - 1, itemIndexAt(offsets, top));
  const end = Math.min(count, itemIndexAt(offsets, bottom) + 1);
  return { start, end };
});

const visibleCommands = computed(() => {
  const end = Math.min(props.commands.length, virtualRange.value.end);
  return props.commands.slice(virtualRange.value.start, end).map((command, offset) => ({
    command,
    index: virtualRange.value.start + offset,
  }));
});

const virtualWindowStyle = computed(() => ({
  transform: `translateY(${(itemLayout.value.offsets[virtualRange.value.start] || 0) + 10}px)`,
}));

const canvasStyle = computed(() => ({ height: `${itemLayout.value.total + 34}px` }));

const updateViewport = () => {
  const root = scrollRoot.value;
  if (!root) return;
  const nextWidth = root.clientWidth;
  if (Math.round(nextWidth / 8) !== Math.round(viewportWidth.value / 8)) measuredRowHeights.clear();
  scrollTop.value = root.scrollTop;
  viewportHeight.value = root.clientHeight;
  viewportWidth.value = nextWidth;
};

const scheduleViewportUpdate = () => {
  if (viewportFrame !== undefined) return;
  viewportFrame = window.requestAnimationFrame(() => {
    viewportFrame = undefined;
    updateViewport();
  });
};

const setRowElement = (element: Element | null, id: string) => {
  const previous = rowElements.get(id);
  if (previous && previous !== element) rowObserver?.unobserve(previous);
  if (!(element instanceof HTMLElement)) {
    rowElements.delete(id);
    return;
  }
  rowElements.set(id, element);
  rowObserver?.observe(element);
};

const scrollCommandIntoView = (id: string) => {
  const root = scrollRoot.value;
  const index = commandIndexById.value.get(id) ?? -1;
  if (!root || index < 0) return;
  const { offsets } = itemLayout.value;
  const top = (offsets[index] || 0) + 10;
  const bottom = (offsets[index + 1] || top + fallbackRowHeight) + 10;
  const padding = 8;
  if (top < root.scrollTop + padding) root.scrollTop = Math.max(0, top - padding);
  else if (bottom > root.scrollTop + root.clientHeight - padding) {
    root.scrollTop = Math.max(
      0,
      bottom - top >= root.clientHeight - padding * 2 ? top - padding : bottom - root.clientHeight + padding,
    );
  }
  updateViewport();
};

const issuesByCommandIndex = computed(() => {
  const result = new Map<number, StoryValidationIssue[]>();
  const prefix = `$.scenes[${props.sceneIndex}].commands[`;
  for (const issue of props.issues || emptyIssues) {
    if (!issue.path.startsWith(prefix)) continue;
    const suffix = issue.path.slice(prefix.length);
    const closingBracket = suffix.indexOf("]");
    if (closingBracket <= 0) continue;
    const remainder = suffix.slice(closingBracket + 1);
    if (remainder && !remainder.startsWith(".") && !remainder.startsWith("[")) continue;
    const index = Number(suffix.slice(0, closingBracket));
    if (!Number.isSafeInteger(index) || index < 0) continue;
    const current = result.get(index);
    if (current) current.push(issue);
    else result.set(index, [issue]);
  }
  return result;
});

const commandIssues = (index: number): readonly StoryValidationIssue[] =>
  issuesByCommandIndex.value.get(index) || emptyIssues;

const commandDragMime = "application/x-haneoka-story-command";
const onDragStart = ({ id, event }: { id: string; event: DragEvent }) => {
  dragId.value = id;
  event.dataTransfer?.setData(commandDragMime, id);
  if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
};

const isCommandDrag = (event: DragEvent) =>
  Boolean(dragId.value || Array.from(event.dataTransfer?.types || []).includes(commandDragMime));
const onDragOver = (index: number, event: DragEvent) => {
  if (!isCommandDrag(event)) return;
  event.preventDefault();
  overIndex.value = index;
};
const onDrop = (index: number, event: DragEvent) => {
  if (!isCommandDrag(event)) return;
  event.preventDefault();
  const id = dragId.value || event.dataTransfer?.getData(commandDragMime) || "";
  const previous = commandIndexById.value.get(id);
  if (previous === undefined) return endDrag();
  const finalIndex = previous < index ? index - 1 : index;
  emit("move", { id, index: finalIndex });
  dragId.value = "";
  overIndex.value = undefined;
};

const endDrag = () => {
  dragId.value = "";
  overIndex.value = undefined;
};

watch(
  () => props.selectedId,
  async (selectedId) => {
    if (!selectedId) return;
    await nextTick();
    scrollCommandIntoView(selectedId);
  },
);

watch(
  () => props.commands,
  (commands) => {
    const current = new Set(commands.map((command) => command.id));
    for (const command of commands) {
      const cached = estimatedRowHeightCache.get(command.id);
      if (
        cached &&
        (cached.command !== command.command || cached.fieldSignature !== Object.keys(command.fields).join("\u0001"))
      ) {
        measuredRowHeights.delete(command.id);
      }
    }
    for (const id of measuredRowHeights.keys()) {
      if (!current.has(id)) measuredRowHeights.delete(id);
    }
    for (const id of estimatedRowHeightCache.keys()) {
      if (!current.has(id)) estimatedRowHeightCache.delete(id);
    }
    nextTick(updateViewport);
  },
);

onMounted(() => {
  rowObserver = new ResizeObserver((entries) => {
    const root = scrollRoot.value;
    const offsets = itemLayout.value.offsets;
    const anchorIndex = itemIndexAt(offsets, root?.scrollTop ?? scrollTop.value);
    let scrollCorrection = 0;
    for (const entry of entries) {
      const element = entry.target as HTMLElement;
      const id = element.dataset.commandRow;
      if (!id) continue;
      const index = commandIndexById.value.get(id);
      if (index === undefined) continue;
      const borderBox = entry.borderBoxSize?.[0];
      const height = Math.max(1, Math.ceil(borderBox?.blockSize ?? entry.contentRect.height));
      const previousHeight = offsets[index + 1]! - offsets[index]!;
      const difference = height - previousHeight;
      if (Math.abs(difference) <= 1) continue;
      measuredRowHeights.set(id, height);
      if (index < anchorIndex) scrollCorrection += difference;
    }
    if (root && scrollCorrection) {
      root.scrollTop += scrollCorrection;
      updateViewport();
    }
  });
  for (const element of rowElements.values()) rowObserver.observe(element);
  if (scrollRoot.value) {
    scrollObserver = new ResizeObserver(scheduleViewportUpdate);
    scrollObserver.observe(scrollRoot.value);
  }
  updateViewport();
  if (props.selectedId) nextTick(() => scrollCommandIntoView(props.selectedId!));
});

onBeforeUnmount(() => {
  rowObserver?.disconnect();
  scrollObserver?.disconnect();
  if (viewportFrame !== undefined) window.cancelAnimationFrame(viewportFrame);
});
</script>

<template>
  <section class="story-sentence-list" :aria-label="copy.commands" @dragend="endDrag">
    <div
      ref="scrollRoot"
      class="story-sentence-list__scroll"
      data-scroll-key="story-editor-sentences"
      @scroll.passive="scheduleViewportUpdate"
    >
      <div class="story-sentence-list__canvas" :style="canvasStyle">
        <div class="story-sentence-list__window" :style="virtualWindowStyle">
          <div
            v-for="entry in visibleCommands"
            :key="entry.command.id"
            :ref="(element) => setRowElement(element as Element | null, entry.command.id)"
            class="story-sentence-list__row"
            :data-command-row="entry.command.id"
          >
            <div
              class="story-sentence-insert"
              :class="{ 'is-over': overIndex === entry.index }"
              @dragover="onDragOver(entry.index, $event)"
              @drop="onDrop(entry.index, $event)"
            >
              <UiButton
                class="story-sentence-insert__button"
                tone="accent"
                :aria-label="copy.addCommand"
                @click="emit('request-add', entry.index)"
              >
                <template #icon><MaterialIcon name="add" :size="18" /></template>
                <span>{{ copy.insertBefore }}</span>
              </UiButton>
            </div>
            <StoryEditorSentenceCard
              :command="entry.command"
              :index="entry.index"
              :selected="entry.command.id === selectedId"
              :first="entry.index === 0"
              :last="entry.index === commands.length - 1"
              :issues="commandIssues(entry.index)"
              :can-execute="executableSourceIndexes?.has(entry.index)"
              @select="emit('select', $event)"
              @patch="emit('patch', $event)"
              @replace="emit('replace', $event)"
              @duplicate="emit('duplicate', $event)"
              @remove="emit('remove', $event)"
              @move="emit('move', $event)"
              @pick-resource="emit('pick-resource', $event)"
              @execute-to="emit('execute-to', { id: $event, sourceIndex: entry.index })"
              @drag-start="onDragStart"
              @dragover="onDragOver(entry.index, $event)"
              @drop.stop="onDrop(entry.index, $event)"
            />
          </div>

          <div
            v-if="virtualRange.end > commands.length"
            class="story-sentence-insert is-last"
            :class="{ 'is-over': overIndex === commands.length }"
            @dragover="onDragOver(commands.length, $event)"
            @drop="onDrop(commands.length, $event)"
          >
            <UiButton class="story-sentence-insert__button" tone="accent" @click="emit('request-add', commands.length)">
              <template #icon><MaterialIcon name="add" :size="18" /></template>
              <span>{{ copy.addCommand }}</span>
            </UiButton>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.story-sentence-list {
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: var(--md-sys-color-surface-container-low);
}

.story-sentence-list__scroll {
  height: 100%;
  min-height: 0;
  overflow: auto;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
}

.story-sentence-list__canvas {
  position: relative;
  width: 100%;
  min-width: 0;
}

.story-sentence-list__window {
  position: absolute;
  top: 0;
  right: 8px;
  left: 8px;
  will-change: transform;
}

.story-sentence-insert {
  position: relative;
  display: grid;
  height: 7px;
  place-items: center;
}

.story-sentence-insert::before {
  position: absolute;
  right: 4px;
  left: 4px;
  height: 2px;
  border-radius: 2px;
  background: var(--md-sys-color-primary);
  content: "";
  opacity: 0;
}

.story-sentence-insert__button {
  position: relative;
  z-index: 1;
  opacity: 0;
  transform: scale(0.94);
  --md-filled-tonal-button-container-height: 28px;
  --md-filled-tonal-button-label-text-size: var(--md-sys-typescale-label-small-size);
  transition:
    opacity var(--md-sys-motion-duration-short2) ease,
    transform var(--md-sys-motion-duration-short2) ease;
}

.story-sentence-insert:hover::before,
.story-sentence-insert:focus-within::before,
.story-sentence-insert.is-over::before {
  opacity: 0.7;
}

.story-sentence-insert:hover .story-sentence-insert__button,
.story-sentence-insert:focus-within .story-sentence-insert__button,
.story-sentence-insert.is-over .story-sentence-insert__button,
.story-sentence-insert.is-last .story-sentence-insert__button {
  opacity: 1;
  transform: scale(1);
}

.story-sentence-insert.is-last {
  height: 52px;
}

.story-sentence-insert.is-last .story-sentence-insert__button {
  min-width: 120px;
  justify-content: center;
}
</style>
