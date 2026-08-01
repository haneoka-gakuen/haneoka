<!--
  This Source Code Form is subject to the terms of the Mozilla Public
  License, v. 2.0. If a copy of the MPL was not distributed with this
  file, You can obtain one at https://mozilla.org/MPL/2.0/.

  The canvas interaction follows OpenWebGAL/WebGAL_Terre's FlowchartEditor
  at commit 7b7a2159a5ccead80327437b7305b8fdb47a4e5f.
  This implementation uses Altair's executable control-flow graph and Vue Flow.
  See THIRD_PARTY_NOTICES.md for attribution and scope.
-->
<script setup lang="ts">
import { MaterialIcon, UiIconButton } from "@haneoka/ui";

import type { StoryProject } from "@haneoka/altair";
import {
  type StoryFlowEdge,
  type StoryFlowGraph,
  type StoryFlowNode,
  type StoryFlowNodeKind,
} from "@haneoka/altair-plugin-flow";
import { Background } from "@vue-flow/background";
import {
  Handle,
  MarkerType,
  Position,
  VueFlow,
  useVueFlow,
  type Edge,
  type GraphNode,
  type Node,
  type NodeChange,
  type NodeDragEvent,
  type NodeMouseEvent,
  type XYPosition,
} from "@vue-flow/core";
import { Controls } from "@vue-flow/controls";
import { MiniMap } from "@vue-flow/minimap";

import "@vue-flow/core/dist/style.css";
import "@vue-flow/core/dist/theme-default.css";
import "@vue-flow/controls/dist/style.css";
import "@vue-flow/minimap/dist/style.css";
import type { AltairAuthoringHostPort } from "~/features/story/altairAuthoring";

interface StoryGraphNodeData {
  accent: string;
  commandId?: string;
  detail: string;
  kind: StoryFlowNodeKind;
  kindLabel: string;
  label: string;
  reachable: boolean;
  sceneId?: string;
  sceneName: string;
  selected: boolean;
}

type StoryGraphNode = Node<StoryGraphNodeData> & { selected?: boolean };

const props = defineProps<{
  authoringHost: AltairAuthoringHostPort;
  project: StoryProject;
  currentSceneId?: string;
  selectedCommandId?: string;
}>();

const emit = defineEmits<{
  open: [payload: { sceneId: string; commandId?: string }];
  select: [payload: { sceneId: string; commandId?: string }];
}>();

const { messages } = useLocale();
const copy = messages("storyEditorPage");
const { workspaceCopy } = useStoryEditorLabels();
const flow = useVueFlow("story-editor-project-flow");
const nodes = shallowRef<StoryGraphNode[]>([]);
const positions = new Map<string, XYPosition>();
const STORAGE_KEY = "story-editor-flow-layout-v1";
let persistFrame: number | undefined;
let graphGeneration = 0;
let graphController: AbortController | undefined;

const kindLabels = computed<Record<StoryFlowNodeKind, string>>(() => ({
  "project-entry": workspaceCopy.value.flowStart,
  "project-exit": workspaceCopy.value.flowEnd,
  "scene-entry": copy.value.scene,
  "scene-exit": workspaceCopy.value.flowReturn,
  command: copy.value.command,
  choice: copy.value.categoryFlow,
  jump: workspaceCopy.value.flowJump,
  "scene-call": workspaceCopy.value.flowCall,
  "scene-return": workspaceCopy.value.flowReturn,
  condition: workspaceCopy.value.flowCondition,
  end: workspaceCopy.value.flowEnd,
  "scene-marker": copy.value.scene,
  unresolved: copy.value.unsupported,
}));

const kindColors: Record<StoryFlowNodeKind, string> = {
  "project-entry": "var(--md-sys-color-primary)",
  "project-exit": "var(--md-sys-color-outline)",
  "scene-entry": "var(--md-sys-color-secondary)",
  "scene-exit": "var(--md-sys-color-secondary)",
  command: "var(--md-sys-color-primary)",
  choice: "var(--md-sys-color-tertiary)",
  jump: "var(--md-sys-color-tertiary)",
  "scene-call": "var(--md-sys-color-secondary)",
  "scene-return": "var(--md-sys-color-secondary)",
  condition: "var(--md-sys-color-tertiary)",
  end: "var(--md-sys-color-error)",
  "scene-marker": "var(--md-sys-color-secondary)",
  unresolved: "var(--md-sys-color-error)",
};

const edgeColors: Record<StoryFlowEdge["kind"], string> = {
  entry: "var(--md-sys-color-primary)",
  next: "var(--md-sys-color-outline)",
  exit: "var(--md-sys-color-outline)",
  jump: "var(--md-sys-color-tertiary)",
  choice: "var(--md-sys-color-tertiary)",
  "scene-call": "var(--md-sys-color-secondary)",
  "scene-return": "var(--md-sys-color-secondary)",
};

const fallbackGraph = (project: StoryProject): StoryFlowGraph => ({
  entryNodeId: "",
  exitNodeId: "",
  diagnostics: [],
  nodes: project.scenes.map((scene): StoryFlowNode => ({
    id: `fallback:${scene.id}`,
    kind: "scene-entry",
    label: scene.name,
    reachable: scene.id === project.entrySceneId,
    sceneId: scene.id,
    sceneName: scene.name,
  })),
  edges: [],
});
const executableGraph = shallowRef<StoryFlowGraph>(fallbackGraph(props.project));

const rebuildGraph = async () => {
  const generation = ++graphGeneration;
  graphController?.abort();
  const controller = new AbortController();
  graphController = controller;
  try {
    const graph = await props.authoringHost.buildFlow<StoryFlowGraph>("story-flow", props.project, controller.signal);
    if (!controller.signal.aborted && generation === graphGeneration) executableGraph.value = graph;
  } catch {
    if (!controller.signal.aborted && generation === graphGeneration) {
      executableGraph.value = fallbackGraph(props.project);
    }
  } finally {
    if (graphController === controller) graphController = undefined;
  }
};

watch(
  [() => props.authoringHost, () => props.project],
  () => {
    void rebuildGraph();
  },
  { immediate: true },
);

const defaultPositions = computed(() => {
  const result = new Map<string, XYPosition>();
  const graph = executableGraph.value;
  const sceneIndexes = new Map(props.project.scenes.map((scene, index) => [scene.id, index] as const));
  const sceneRows = new Map<string, number>();
  const columnWidth = 316;
  const rowHeight = 118;
  for (const node of graph.nodes) {
    if (node.kind === "project-entry") {
      result.set(node.id, { x: 48, y: 36 });
      continue;
    }
    if (node.kind === "project-exit") continue;
    const sceneIndex = sceneIndexes.get(node.sceneId || "") ?? props.project.scenes.length;
    const row = sceneRows.get(node.sceneId || "") || 0;
    sceneRows.set(node.sceneId || "", row + 1);
    result.set(node.id, { x: 48 + sceneIndex * columnWidth, y: 160 + row * rowHeight });
  }
  const maxRows = Math.max(1, ...sceneRows.values());
  const exit = graph.nodes.find(({ kind }) => kind === "project-exit");
  if (exit) {
    result.set(exit.id, {
      x: 48 + Math.max(0, props.project.scenes.length - 1) * columnWidth,
      y: 160 + maxRows * rowHeight,
    });
  }
  return result;
});

const nodeDetail = (node: StoryFlowNode): string => {
  if (node.condition) return node.condition;
  if (node.commandIndex !== undefined) {
    const source = node.sourceLine ? `${workspaceCopy.value.line} ${node.sourceLine}` : `#${node.commandIndex + 1}`;
    return node.opcode === undefined ? source : `${source} · ${node.opcode ?? "?"}`;
  }
  return node.sceneName || "";
};

const nodeData = (node: StoryFlowNode): StoryGraphNodeData => ({
  accent: kindColors[node.kind],
  ...(node.commandId ? { commandId: node.commandId } : {}),
  detail: nodeDetail(node),
  kind: node.kind,
  kindLabel: kindLabels.value[node.kind],
  label: node.label.replace(/\s+·\s+(?:start|end)$/i, ""),
  reachable: node.reachable,
  ...(node.sceneId ? { sceneId: node.sceneId } : {}),
  sceneName: node.sceneName || props.project.meta.title || copy.value.project,
  selected:
    Boolean(node.sceneId) &&
    node.sceneId === props.currentSceneId &&
    (props.selectedCommandId ? node.commandId === props.selectedCommandId : node.kind === "scene-entry"),
});

watchEffect(() => {
  const graph = executableGraph.value;
  const liveIds = new Set(graph.nodes.map(({ id }) => id));
  for (const id of positions.keys()) {
    if (!liveIds.has(id)) positions.delete(id);
  }
  nodes.value = graph.nodes.map((node) => {
    const data = nodeData(node);
    const projectBoundary = node.kind === "project-entry" || node.kind === "project-exit";
    return {
      id: node.id,
      type: "story-flow",
      position: positions.get(node.id) || defaultPositions.value.get(node.id) || { x: 48, y: 48 },
      width: 248,
      height: projectBoundary ? 68 : 92,
      data,
      selected: data.selected,
      draggable: true,
      selectable: Boolean(node.sceneId),
      connectable: false,
      focusable: true,
      deletable: false,
      dragHandle: ".story-flow-node__header",
      ariaLabel: `${data.sceneName}: ${data.label}`,
    };
  });
});

const edges = computed<Edge[]>(() =>
  executableGraph.value.edges.map((edge) => {
    const color = edgeColors[edge.kind];
    const label = edge.label || (edge.kind === "choice" ? edge.choiceText : edge.condition?.outcome ? "✓" : "");
    return {
      id: edge.id,
      source: edge.from,
      target: edge.to,
      type: "smoothstep",
      selectable: true,
      focusable: true,
      deletable: false,
      interactionWidth: 18,
      ...(label ? { label } : {}),
      markerEnd: { type: MarkerType.ArrowClosed, color, width: 15, height: 15 },
      style: {
        stroke: color,
        strokeWidth: edge.kind === "next" ? 1.35 : 1.8,
        ...(edge.condition?.outcome === false ? { strokeDasharray: "5 4" } : {}),
      },
    };
  }),
);

const persistPositions = () => {
  if (!import.meta.client) return;
  if (persistFrame !== undefined) window.cancelAnimationFrame(persistFrame);
  persistFrame = window.requestAnimationFrame(() => {
    persistFrame = undefined;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(positions)));
  });
};

const restorePositions = () => {
  if (!import.meta.client) return;
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}") as Record<string, XYPosition>;
    for (const [id, position] of Object.entries(stored)) {
      if (Number.isFinite(position?.x) && Number.isFinite(position?.y)) positions.set(id, position);
    }
  } catch {
    localStorage.removeItem(STORAGE_KEY);
  }
};

const selectNode = (node: { data?: unknown }, open = false) => {
  const data = node.data as StoryGraphNodeData | undefined;
  if (!data?.sceneId) return;
  const payload = { sceneId: data.sceneId, ...(data.commandId ? { commandId: data.commandId } : {}) };
  if (open) emit("open", payload);
  else emit("select", payload);
};

const onNodeClick = ({ node }: NodeMouseEvent) => selectNode(node);
const onNodeDoubleClick = ({ node }: NodeMouseEvent) => selectNode(node, true);
const onNodeDragStop = ({ node }: NodeDragEvent) => {
  positions.set(node.id, { ...node.position });
  persistPositions();
};
const onNodesChange = (changes: NodeChange[]) => {
  for (const change of changes) {
    if (change.type === "position" && change.position) positions.set(change.id, { ...change.position });
    if (change.type === "select" && change.selected) {
      const node = nodes.value.find(({ id }) => id === change.id);
      if (node) selectNode(node);
    }
  }
};

const fitGraph = () => flow.fitView({ padding: 0.12, minZoom: 0.12, maxZoom: 1 });
const focusSelection = () => {
  const id =
    nodes.value.find(({ data }) => data?.selected)?.id ||
    nodes.value.find(({ data }) => data?.sceneId === props.currentSceneId && data?.kind === "scene-entry")?.id ||
    executableGraph.value.entryNodeId;
  if (id) void flow.fitView({ nodes: [id], padding: 0.38, maxZoom: 1.05, minZoom: 0.5 });
};
const resetLayout = () => {
  positions.clear();
  localStorage.removeItem(STORAGE_KEY);
  nodes.value = nodes.value.map((node) => ({
    ...node,
    position: defaultPositions.value.get(node.id) || { x: 48, y: 48 },
  }));
  void nextTick(fitGraph);
};
const miniMapNodeColor = (node: GraphNode): string =>
  String((node.data as StoryGraphNodeData | undefined)?.accent || kindColors.command);

onMounted(() => {
  restorePositions();
  nodes.value = nodes.value.map((node) => ({
    ...node,
    position: positions.get(node.id) ?? node.position,
  }));
});
onBeforeUnmount(() => {
  graphGeneration += 1;
  graphController?.abort();
  if (persistFrame !== undefined) window.cancelAnimationFrame(persistFrame);
});
</script>

<template>
  <div class="story-editor-graph">
    <VueFlow
      id="story-editor-project-flow"
      v-model:nodes="nodes"
      :edges="edges"
      :delete-key-code="null"
      :min-zoom="0.08"
      :max-zoom="2"
      :nodes-connectable="false"
      :nodes-draggable="true"
      :only-render-visible-elements="true"
      :pan-on-drag="[0, 1, 2]"
      :prevent-scrolling="true"
      :snap-grid="[12, 12]"
      :snap-to-grid="true"
      :zoom-on-double-click="true"
      :zoom-on-pinch="true"
      :zoom-on-scroll="true"
      class="story-editor-graph__flow"
      @node-click="onNodeClick"
      @node-double-click="onNodeDoubleClick"
      @node-drag-stop="onNodeDragStop"
      @nodes-initialized="focusSelection"
      @nodes-change="onNodesChange"
    >
      <Background variant="dots" :gap="20" :size="1.1" color="var(--md-sys-color-outline-variant)" />

      <template #node-story-flow="{ data }">
        <article
          class="story-flow-node"
          :class="{
            'is-selected': data.selected,
            'is-unreachable': !data.reachable,
            'is-boundary': data.kind === 'project-entry' || data.kind === 'project-exit',
          }"
          :style="{ '--story-flow-accent': data.accent }"
        >
          <Handle type="target" :position="Position.Top" :connectable="false" />
          <header class="story-flow-node__header">
            <span>{{ data.kindLabel }}</span>
            <strong>{{ data.label }}</strong>
          </header>
          <p v-if="data.detail">{{ data.detail }}</p>
          <footer v-if="data.sceneId">
            <span>{{ data.sceneName }}</span>
            <MaterialIcon v-if="data.reachable" name="check_circle" :size="13" />
          </footer>
          <Handle type="source" :position="Position.Bottom" :connectable="false" />
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
          <MaterialIcon name="fit_screen" :size="18" />
        </UiIconButton>
        <UiIconButton
          class="vue-flow__controls-button"
          size="compact"
          :label="workspaceCopy.flowReset"
          @click="resetLayout"
        >
          <MaterialIcon name="restart_alt" :size="18" />
        </UiIconButton>
      </Controls>

      <MiniMap
        :aria-label="copy.graphMiniMap"
        :node-color="miniMapNodeColor"
        node-stroke-color="var(--md-sys-color-surface-container)"
        :node-stroke-width="2"
        :node-border-radius="4"
        :width="170"
        :height="112"
        mask-color="color-mix(in srgb, var(--md-sys-color-surface-container) 66%, transparent)"
        mask-stroke-color="var(--md-sys-color-outline)"
        :mask-stroke-width="1"
        pannable
        zoomable
      />
    </VueFlow>

    <div v-if="!nodes.length" class="story-editor-graph__empty">{{ copy.noCommand }}</div>
  </div>
</template>

<style scoped>
.story-editor-graph {
  position: relative;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: var(--md-sys-color-surface-container-low);
  touch-action: none;
}

.story-editor-graph__flow {
  width: 100%;
  height: 100%;
  color: var(--md-sys-color-on-surface);
  background: var(--md-sys-color-surface-container-low);
}

.story-flow-node {
  position: relative;
  display: grid;
  width: 248px;
  min-height: 92px;
  grid-template-rows: 38px minmax(26px, auto) 24px;
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--story-flow-accent) 46%, var(--md-sys-color-outline-variant));
  border-radius: var(--md-sys-shape-corner-medium);
  color: var(--md-sys-color-on-surface);
  background: var(--md-sys-color-surface-container-lowest);
  box-shadow: var(--md-sys-elevation-level1);
  transition:
    border-color 130ms ease,
    box-shadow 130ms ease,
    opacity 130ms ease;
}

.story-flow-node::before {
  position: absolute;
  z-index: 1;
  inset: 0 auto 0 0;
  width: 3px;
  background: var(--story-flow-accent);
  content: "";
}

.story-flow-node.is-selected {
  border-color: var(--story-flow-accent);
  box-shadow:
    0 0 0 2px color-mix(in srgb, var(--story-flow-accent) 22%, transparent),
    var(--md-sys-elevation-level2);
}

.story-flow-node.is-unreachable:not(.is-boundary) {
  opacity: 0.58;
}

.story-flow-node.is-boundary {
  min-height: 68px;
  grid-template-rows: 34px 34px;
}

.story-flow-node__header {
  display: grid;
  min-width: 0;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: center;
  gap: 8px;
  padding: 0 10px 0 12px;
  border-bottom: 1px solid var(--md-sys-color-outline-variant);
  background: color-mix(in srgb, var(--story-flow-accent) 7%, var(--md-sys-color-surface-container-lowest));
  cursor: grab;
}

.story-flow-node__header:active {
  cursor: grabbing;
}

.story-flow-node__header > span {
  color: var(--story-flow-accent);
  font-size: 0.56rem;
  font-weight: 700;
  text-transform: uppercase;
}

.story-flow-node__header strong {
  min-width: 0;
  overflow: hidden;
  font-size: 0.7rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.story-flow-node p {
  display: -webkit-box;
  margin: 0;
  padding: 6px 12px 4px;
  overflow: hidden;
  color: var(--md-sys-color-on-surface-variant);
  font: 500 0.61rem/1.35 var(--md-sys-typescale-body-small-font);
  overflow-wrap: anywhere;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.story-flow-node footer {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 5px;
  padding: 0 10px 0 12px;
  color: var(--md-sys-color-outline);
  font-size: 0.55rem;
}

.story-flow-node footer span {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.story-editor-graph__empty {
  position: absolute;
  top: 50%;
  left: 50%;
  color: var(--md-sys-color-outline);
  font-size: 0.7rem;
  transform: translate(-50%, -50%);
  pointer-events: none;
}

.story-editor-graph :deep(.vue-flow__node-story-flow) {
  width: 248px;
  border: 0;
  padding: 0;
  background: transparent;
  box-shadow: none;
}

.story-editor-graph :deep(.vue-flow__handle) {
  width: 9px;
  height: 9px;
  border: 2px solid var(--md-sys-color-surface-container-lowest);
  background: var(--story-flow-accent);
}

.story-editor-graph :deep(.vue-flow__edge-textbg) {
  fill: var(--md-sys-color-surface-container-high);
}

.story-editor-graph :deep(.vue-flow__edge-text) {
  fill: var(--md-sys-color-on-surface-variant);
  font-size: 9px;
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
  .story-flow-node {
    transition: none;
  }
}
</style>
