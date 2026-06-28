<!--
  This Source Code Form is subject to the terms of the Mozilla Public
  License, v. 2.0. If a copy of the MPL was not distributed with this
  file, You can obtain one at https://mozilla.org/MPL/2.0/.

  This original integration uses Vue Flow, distributed under the MIT License.
-->
<script setup lang="ts">
import { MaterialIcon, UiIconButton } from "@haneoka/ui";

import {
  commandDescriptor,
  storyCommandFieldValue,
  storyLocalizedTextForEditor,
  type CommandCategory,
  type CommandFieldDescriptor,
  type JsonValue,
  type StoryProjectCommand,
} from "@haneoka/story-editor";
import { Background } from "@vue-flow/background";
import {
  ConnectionLineType,
  ConnectionMode,
  Handle,
  MarkerType,
  Position,
  VueFlow,
  useVueFlow,
  type Connection,
  type Edge,
  type EdgeUpdateEvent,
  type GraphNode,
  type Node,
  type NodeChange,
  type NodeDragEvent,
  type NodeMouseEvent,
  type XYPosition,
} from "@vue-flow/core";
import { Controls } from "@vue-flow/controls";
import { MiniMap } from "@vue-flow/minimap";
import type { ArchiveLocale } from "~/i18n/locales";

import "@vue-flow/core/dist/style.css";
import "@vue-flow/core/dist/theme-default.css";
import "@vue-flow/controls/dist/style.css";
import "@vue-flow/minimap/dist/style.css";

interface StoryGraphNodeData {
  category: CommandCategory;
  categoryLabel: string;
  commandCode: number | null;
  order: number;
  selected: boolean;
  summary: string;
  title: string;
}

type StoryGraphNode = Node<StoryGraphNodeData> & { selected?: boolean };

const props = defineProps<{
  commands: readonly StoryProjectCommand[];
  selectedId?: string;
}>();

const emit = defineEmits<{
  move: [payload: { id: string; index: number }];
  select: [id: string];
}>();

const { locale, messages, t } = useLocale();
const copy = messages("storyEditorPage");
const { commandLabel } = useStoryEditorLabels();
const flow = useVueFlow("story-editor-command-graph");
const nodes = shallowRef<StoryGraphNode[]>([]);
const positions = new Map<string, XYPosition>();

const localeIndexes: Record<ArchiveLocale, number> = {
  ja: 0,
  en: 1,
  "zh-TW": 2,
  "zh-CN": 3,
  ko: 4,
};

const categoryColors: Record<CommandCategory, string> = {
  dialogue: "var(--md-sys-color-primary)",
  character: "var(--md-sys-color-tertiary)",
  stage: "var(--md-sys-color-secondary)",
  camera: "var(--md-sys-color-primary)",
  audio: "var(--md-sys-color-tertiary)",
  transition: "var(--md-sys-color-error)",
  chat: "var(--md-sys-color-secondary)",
  flow: "var(--md-sys-color-tertiary)",
  timing: "var(--md-sys-color-outline)",
  media: "var(--md-sys-color-primary)",
  system: "var(--md-sys-color-on-surface-variant)",
};
const graphOutline = "var(--md-sys-color-outline)";
const graphSurface = "var(--md-sys-color-surface-container)";
const graphSurfaceMask = "color-mix(in srgb, var(--md-sys-color-surface-container) 68%, transparent)";

const categoryLabels = computed<Record<CommandCategory, string>>(() => ({
  dialogue: copy.value.categoryDialogue,
  character: copy.value.categoryCharacter,
  stage: copy.value.categoryStage,
  camera: copy.value.categoryCamera,
  audio: copy.value.categoryAudio,
  transition: copy.value.categoryTransition,
  chat: copy.value.categoryChat,
  flow: copy.value.categoryFlow,
  timing: copy.value.categoryTiming,
  media: copy.value.categoryMedia,
  system: copy.value.categorySystem,
}));

const defaultPosition = (index: number): XYPosition => ({ x: 96, y: 56 + index * 132 });
const compactText = (value: string): string => value.replace(/\s+/g, " ").trim().slice(0, 92);
const fieldValueText = (value: JsonValue | undefined, field: CommandFieldDescriptor): string => {
  if (value === undefined || value === null || value === "") return "";
  if (field.kind === "localized-text" || field.kind === "localized-list") {
    if (field.kind === "localized-list" && Array.isArray(value)) {
      return compactText(
        value
          .map((entry) => storyLocalizedTextForEditor(entry, localeIndexes[locale.value]))
          .filter(Boolean)
          .join(", "),
      );
    }
    return compactText(storyLocalizedTextForEditor(value, localeIndexes[locale.value]));
  }
  if (Array.isArray(value)) return compactText(value.map(String).filter(Boolean).join(", "));
  if (typeof value === "object") return compactText(JSON.stringify(value));
  return compactText(String(value));
};

const describeCommand = (command: StoryProjectCommand, index: number): StoryGraphNodeData => {
  const descriptor = commandDescriptor(command.command);
  const category = descriptor?.category || "system";
  const fields = descriptor?.primaryField
    ? [
        ...descriptor.fields.filter((field) => field.key === descriptor.primaryField),
        ...descriptor.fields.filter((field) => field.key !== descriptor.primaryField),
      ]
    : descriptor?.fields || [];
  let summary = "";
  for (const field of fields) {
    summary = fieldValueText(storyCommandFieldValue(command, field), field);
    if (summary) break;
  }
  return {
    category,
    categoryLabel: categoryLabels.value[category],
    commandCode: command.command,
    order: index + 1,
    selected: command.id === props.selectedId,
    summary,
    title: descriptor
      ? commandLabel(descriptor.name, descriptor.label)
      : command.source?.command || `#${command.command ?? "?"}`,
  };
};

watchEffect(() => {
  const liveIds = new Set(props.commands.map((command) => command.id));
  for (const id of positions.keys()) {
    if (!liveIds.has(id)) positions.delete(id);
  }
  nodes.value = props.commands.map((command, index) => {
    const data = describeCommand(command, index);
    return {
      id: command.id,
      type: "story-command",
      position: positions.get(command.id) || defaultPosition(index),
      width: 264,
      height: 100,
      data,
      selected: data.selected,
      draggable: true,
      selectable: true,
      connectable: true,
      focusable: true,
      deletable: false,
      dragHandle: ".story-graph-node__header",
      ariaLabel: `${data.order}. ${data.title}${data.summary ? `: ${data.summary}` : ""}`,
    };
  });
});

const edges = computed<Edge[]>(() =>
  props.commands.slice(1).map((command, index) => {
    const source = props.commands[index];
    return {
      id: `sequence:${source?.id || index}:${command.id}`,
      source: source?.id || "",
      target: command.id,
      type: "smoothstep",
      updatable: "target",
      selectable: true,
      focusable: true,
      deletable: false,
      interactionWidth: 18,
      markerEnd: { type: MarkerType.ArrowClosed, color: graphOutline, width: 16, height: 16 },
      style: { stroke: graphOutline, strokeWidth: 1.6 },
      ariaLabel: t("storyEditorPage.graphConnection", { from: index + 1, to: index + 2 }),
    };
  }),
);

const reorderFromConnection = ({ source, target }: Connection) => {
  if (!source || !target || source === target) return;
  const sourceIndex = props.commands.findIndex((command) => command.id === source);
  const targetIndex = props.commands.findIndex((command) => command.id === target);
  if (sourceIndex < 0 || targetIndex < 0 || targetIndex === sourceIndex + 1) return;
  emit("move", { id: target, index: targetIndex < sourceIndex ? sourceIndex : sourceIndex + 1 });
  emit("select", target);
};

const isValidConnection = (connection: Connection): boolean =>
  Boolean(
    connection.source &&
    connection.target &&
    connection.source !== connection.target &&
    props.commands.some((command) => command.id === connection.source) &&
    props.commands.some((command) => command.id === connection.target),
  );

const onEdgeUpdate = ({ connection }: EdgeUpdateEvent) => reorderFromConnection(connection);
const onNodeClick = ({ node }: NodeMouseEvent) => emit("select", node.id);
const onNodeDragStop = ({ node }: NodeDragEvent) => positions.set(node.id, { ...node.position });
const onNodesChange = (changes: NodeChange[]) => {
  for (const change of changes) {
    if (change.type === "position") positions.set(change.id, { ...change.position });
    if (change.type === "select" && change.selected) emit("select", change.id);
  }
};
const categoryColor = (category: unknown): string =>
  typeof category === "string" && Object.hasOwn(categoryColors, category)
    ? categoryColors[category as CommandCategory]
    : categoryColors.system;
const miniMapNodeColor = (node: GraphNode): string =>
  categoryColor((node.data as StoryGraphNodeData | undefined)?.category);
const fitGraph = () => flow.fitView({ padding: 0.16, maxZoom: 1 });
const focusEntry = () => {
  const id = props.commands.some((command) => command.id === props.selectedId)
    ? props.selectedId
    : props.commands[0]?.id;
  if (id) void flow.fitView({ nodes: [id], padding: 0.32, maxZoom: 1, minZoom: 0.72 });
};
</script>

<template>
  <div class="story-editor-graph">
    <VueFlow
      id="story-editor-command-graph"
      v-model:nodes="nodes"
      :edges="edges"
      :connection-line-options="{
        type: ConnectionLineType.SmoothStep,
        style: { stroke: 'var(--md-sys-color-primary)', strokeWidth: 1.8 },
      }"
      :connection-mode="ConnectionMode.Strict"
      :delete-key-code="null"
      :is-valid-connection="isValidConnection"
      :min-zoom="0.12"
      :max-zoom="1.65"
      :only-render-visible-elements="true"
      :snap-grid="[16, 16]"
      :snap-to-grid="true"
      class="story-editor-graph__flow"
      @connect="reorderFromConnection"
      @edge-update="onEdgeUpdate"
      @node-click="onNodeClick"
      @node-drag-stop="onNodeDragStop"
      @nodes-initialized="focusEntry"
      @nodes-change="onNodesChange"
    >
      <Background variant="dots" :gap="20" :size="1.15" color="var(--md-sys-color-outline-variant)" />

      <template #node-story-command="{ data, connectable }">
        <article
          class="story-graph-node"
          :class="{ 'is-selected': data.selected }"
          :style="{ '--story-graph-accent': categoryColor(data.category) }"
        >
          <Handle type="target" :position="Position.Top" :connectable="connectable" :connectable-start="false" />
          <header class="story-graph-node__header">
            <span class="story-graph-node__order">{{ String(data.order).padStart(2, "0") }}</span>
            <strong>{{ data.title }}</strong>
            <code>{{ data.commandCode ?? "?" }}</code>
          </header>
          <p v-if="data.summary">{{ data.summary }}</p>
          <footer>
            <span class="story-graph-node__swatch" aria-hidden="true" />
            <span>{{ data.categoryLabel }}</span>
          </footer>
          <Handle type="source" :position="Position.Bottom" :connectable="connectable" :connectable-end="false" />
        </article>
      </template>

      <Controls :show-zoom="false" :show-fit-view="false" :show-interactive="false" position="bottom-left">
        <UiIconButton class="vue-flow__controls-button" size="compact" :label="copy.graphZoomIn" @click="flow.zoomIn()">
          <MaterialIcon name="add" :size="18" />
        </UiIconButton>
        <UiIconButton
          class="vue-flow__controls-button"
          size="compact"
          :label="copy.graphZoomOut"
          @click="flow.zoomOut()"
        >
          <MaterialIcon name="remove" :size="18" />
        </UiIconButton>
        <UiIconButton class="vue-flow__controls-button" size="compact" :label="copy.graphFitView" @click="fitGraph">
          <MaterialIcon name="fullscreen" :size="18" />
        </UiIconButton>
      </Controls>

      <MiniMap
        :aria-label="copy.graphMiniMap"
        :node-color="miniMapNodeColor"
        :node-stroke-color="graphSurface"
        :node-stroke-width="2"
        :node-border-radius="5"
        :width="150"
        :height="104"
        :mask-color="graphSurfaceMask"
        :mask-stroke-color="graphOutline"
        :mask-stroke-width="1"
        pannable
        zoomable
      />
    </VueFlow>

    <div v-if="!commands.length" class="story-editor-graph__empty">
      {{ copy.noCommand }}
    </div>
  </div>
</template>

<style scoped>
.story-editor-graph {
  position: relative;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: var(--md-sys-color-surface-container-low);
}

.story-editor-graph__flow {
  width: 100%;
  height: 100%;
  color: var(--md-sys-color-on-surface);
  background: var(--md-sys-color-surface-container-low);
}

.story-graph-node {
  position: relative;
  display: grid;
  width: 264px;
  height: 100px;
  grid-template-rows: 34px 40px 24px;
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--story-graph-accent) 42%, var(--md-sys-color-outline-variant));
  border-radius: var(--md-sys-shape-corner-medium);
  color: var(--md-sys-color-on-surface);
  background: var(--md-sys-color-surface-container-lowest);
  box-shadow: var(--md-sys-elevation-level1);
  transition:
    border-color 130ms ease,
    box-shadow 130ms ease,
    transform 130ms ease;
}

.story-graph-node::before {
  position: absolute;
  z-index: 1;
  top: 0;
  bottom: 0;
  left: 0;
  width: 3px;
  background: var(--story-graph-accent);
  content: "";
}

.story-graph-node.is-selected {
  border-color: var(--story-graph-accent);
  box-shadow:
    0 0 0 2px color-mix(in srgb, var(--story-graph-accent) 22%, transparent),
    var(--md-sys-elevation-level2);
}

.story-graph-node__header {
  display: grid;
  min-width: 0;
  grid-row: 1;
  grid-template-columns: 28px minmax(0, 1fr) auto;
  align-items: center;
  gap: 7px;
  padding: 0 10px 0 11px;
  border-bottom: 1px solid var(--md-sys-color-outline-variant);
  background: color-mix(in srgb, var(--story-graph-accent) 7%, var(--md-sys-color-surface-container-lowest));
  cursor: grab;
}

.story-graph-node__header:active {
  cursor: grabbing;
}

.story-graph-node__header strong {
  overflow: hidden;
  font-family: var(--md-sys-typescale-label-large-font);
  font-size: var(--md-sys-typescale-label-large-size);
  font-weight: var(--md-sys-typescale-label-large-weight);
  letter-spacing: 0;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.story-graph-node__header code {
  min-width: 22px;
  color: var(--md-sys-color-outline);
  font-family: var(--md-ref-typeface-code);
  font-size: 0.57rem;
  text-align: right;
}

.story-graph-node__order {
  color: var(--story-graph-accent);
  font-family: var(--md-ref-typeface-code);
  font-size: 0.59rem;
  font-variant-numeric: tabular-nums;
  font-weight: 700;
}

.story-graph-node p {
  display: -webkit-box;
  min-width: 0;
  grid-row: 2;
  margin: 0;
  padding: 7px 11px 5px 12px;
  overflow: hidden;
  color: var(--md-sys-color-on-surface-variant);
  font-size: 0.66rem;
  line-height: 1.35;
  overflow-wrap: anywhere;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.story-graph-node footer {
  display: flex;
  grid-row: 3;
  align-items: center;
  gap: 6px;
  padding: 0 11px 0 12px;
  color: var(--md-sys-color-outline);
  font-size: 0.56rem;
}

.story-graph-node__swatch {
  width: 7px;
  height: 7px;
  border-radius: 2px;
  background: var(--story-graph-accent);
}

.story-editor-graph__empty {
  position: absolute;
  top: 50%;
  left: 50%;
  padding: 8px 11px;
  border: 1px solid var(--md-sys-color-outline-variant);
  border-radius: var(--md-sys-shape-corner-small);
  color: var(--md-sys-color-outline);
  background: var(--md-sys-color-surface-container-high);
  box-shadow: var(--md-sys-elevation-level1);
  font-size: 0.68rem;
  transform: translate(-50%, -50%);
  pointer-events: none;
}

.story-editor-graph :deep(.vue-flow__node-story-command) {
  width: 264px;
  border: 0;
  padding: 0;
  background: transparent;
  box-shadow: none;
}

.story-editor-graph :deep(.vue-flow__handle) {
  z-index: 3;
  width: 10px;
  height: 10px;
  border: 2px solid var(--md-sys-color-surface-container-lowest);
  background: var(--story-graph-accent);
  box-shadow: var(--md-sys-elevation-level1);
}

.story-editor-graph :deep(.vue-flow__edge.selected .vue-flow__edge-path) {
  stroke: var(--md-sys-color-primary);
  stroke-width: 2.2;
}

.story-editor-graph :deep(.vue-flow__controls) {
  overflow: hidden;
  border-radius: var(--md-sys-shape-corner-full);
  background: var(--md-sys-color-surface-container-high);
  box-shadow: var(--md-sys-elevation-level2);
}

.story-editor-graph :deep(.vue-flow__controls-button) {
  width: 30px;
  height: 30px;
  border: 0;
  --md-icon-button-icon-color: var(--md-sys-color-on-surface-variant);
  --md-icon-button-hover-icon-color: var(--md-sys-color-primary);
}

.story-editor-graph :deep(.vue-flow__minimap) {
  overflow: hidden;
  border: 1px solid var(--md-sys-color-outline-variant);
  border-radius: var(--md-sys-shape-corner-medium);
  background: var(--md-sys-color-surface-container);
  box-shadow: var(--md-sys-elevation-level2);
}

@media (prefers-reduced-motion: reduce) {
  .story-graph-node {
    transition: none;
  }
}
</style>
