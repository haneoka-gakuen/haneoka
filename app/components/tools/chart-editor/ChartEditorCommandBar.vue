<script setup lang="ts">
/**
 * Structure and interaction are adapted from Sonolus Next SEKAI Editor's
 * LevelEditorToolbar.vue and LevelEditorToolbarTool.vue.
 * Copyright (c) 2025 NonSpicyBurrito, MIT licensed; see
 * packages/chart-editor/LICENSE.next-sekai-editor.txt.
 */
import type { ChartEditorTool } from "~/composables/useChartEditorWorkspace";
import type { OurNotesAssetManifest } from "@haneoka/chart/assets";
import { loadChartCanvasSkin, type ChartCanvasSkin } from "@haneoka/chart/overview";
import ChartEditorToolbarTool from "./ChartEditorToolbarTool.vue";

type TimingKind = "timeScale" | "meter" | "bpm";
type CommandIcon = InstanceType<typeof ChartEditorToolbarTool>["$props"]["icon"];
type CommandName =
  | "projectProperties"
  | "newProject"
  | "openCatalog"
  | "importChart"
  | "importAudio"
  | "speedDown"
  | "speedUp"
  | "stop"
  | "play"
  | "redo"
  | "undo"
  | "eraser"
  | "select"
  | "trace"
  | "flick"
  | "tap"
  | "guide"
  | "long"
  | "timeScale"
  | "meter"
  | "bpm"
  | "division16"
  | "division12"
  | "division8"
  | "division6"
  | "division4"
  | "division3"
  | "division2"
  | "division1"
  | "zoomIn"
  | "zoomOut"
  | "fullscreen";

interface Command {
  title: string;
  icon: CommandIcon;
  iconText?: string;
  shortcut?: string;
  disabled?: boolean;
  execute: () => void;
}

const props = withDefaults(
  defineProps<{
    tool: ChartEditorTool;
    snapDivision: number;
    playing: boolean;
    audioAvailable: boolean;
    playbackRate: number;
    canUndo?: boolean;
    canRedo?: boolean;
    dragging?: boolean;
    assets?: OurNotesAssetManifest;
  }>(),
  {
    canUndo: true,
    canRedo: true,
    dragging: false,
    assets: undefined,
  },
);

const emit = defineEmits<{
  "new-project": [];
  "import-chart": [];
  "import-audio": [];
  "open-catalog": [];
  "open-project-properties": [];
  "open-tool-properties": [];
  "open-timing": [kind: TimingKind];
  undo: [];
  redo: [];
  "update:tool": [value: ChartEditorTool];
  "update:snapDivision": [value: number];
  "toggle-playback": [];
  "stop-playback": [];
  "update:playbackRate": [value: number];
  "zoom-in": [];
  "zoom-out": [];
  fullscreen: [];
}>();

const { messages, t } = useLocale();
const copy = messages("chartEditorPage");

// This is the official toolbar order, cropped only where this editor has no
// equivalent command. The final entry of each group is its initial main tool.
const toolbar: CommandName[][] = [
  ["projectProperties", "newProject", "openCatalog", "importChart"],
  ["importAudio", "speedDown", "speedUp", "stop", "play"],
  ["redo", "undo"],
  ["eraser", "select"],
  ["trace", "flick", "tap"],
  ["guide", "long"],
  ["timeScale", "meter", "bpm"],
  ["division16", "division12", "division8", "division6", "division4", "division3", "division2", "division1"],
  ["zoomIn", "zoomOut"],
  ["fullscreen"],
];

const playbackRates = [0.25, 0.5, 0.75, 1, 1.5, 2] as const;
const divisions = [1, 2, 3, 4, 6, 8, 12, 16] as const;
const root = useTemplateRef<HTMLElement>("root");
const activeNames = ref<CommandName[]>(toolbar.map((names) => names.at(-1) ?? "select"));
const activeIndex = ref(-1);
const toolbarSkin = shallowRef<ChartCanvasSkin>();
let skinLoadGeneration = 0;
let disposed = false;

const loadToolbarSkin = async (assets: OurNotesAssetManifest): Promise<void> => {
  const generation = ++skinLoadGeneration;
  toolbarSkin.value?.dispose();
  toolbarSkin.value = undefined;
  try {
    const loaded = await loadChartCanvasSkin(assets);
    if (disposed || generation !== skinLoadGeneration) {
      loaded.dispose();
      return;
    }
    toolbarSkin.value = loaded;
  } catch {
    // Game-note icons fail closed when the decoded atlas is unavailable.
  }
};

onMounted(() => {
  if (props.assets) void loadToolbarSkin(props.assets);
});
onBeforeUnmount(() => {
  disposed = true;
  skinLoadGeneration += 1;
  toolbarSkin.value?.dispose();
  toolbarSkin.value = undefined;
});
watch(
  () => props.assets,
  (assets, previousAssets) => {
    if (assets && assets !== previousAssets) void loadToolbarSkin(assets);
    else if (!assets && previousAssets) {
      skinLoadGeneration += 1;
      toolbarSkin.value?.dispose();
      toolbarSkin.value = undefined;
    }
  },
  { flush: "post" },
);

const changePlaybackRate = (direction: -1 | 1) => {
  const current = props.playbackRate;
  const next =
    direction < 0
      ? [...playbackRates].reverse().find((rate) => rate < current)
      : playbackRates.find((rate) => rate > current);
  if (next !== undefined) emit("update:playbackRate", next);
};

const activateTool = (tool: ChartEditorTool) => {
  if (props.tool === tool && ["tap", "flick", "trace", "long", "guide"].includes(tool)) {
    emit("open-tool-properties");
    return;
  }
  emit("update:tool", tool);
};

const commands = computed<Record<CommandName, Command>>(() => ({
  projectProperties: {
    title: copy.value.inspector,
    icon: "properties",
    execute: () => emit("open-project-properties"),
  },
  newProject: {
    title: copy.value.newProject,
    icon: "reset",
    shortcut: "N",
    execute: () => emit("new-project"),
  },
  openCatalog: {
    title: copy.value.serverLibrary,
    icon: "open",
    execute: () => emit("open-catalog"),
  },
  importChart: {
    title: copy.value.importLocalChart,
    icon: "open",
    shortcut: "O",
    execute: () => emit("import-chart"),
  },
  importAudio: {
    title: copy.value.importLocalAudio,
    icon: "bgm",
    execute: () => emit("import-audio"),
  },
  speedDown: {
    title: `${copy.value.playbackSpeed} − (${props.playbackRate}×)`,
    icon: "speedDown",
    shortcut: ";",
    execute: () => changePlaybackRate(-1),
  },
  speedUp: {
    title: `${copy.value.playbackSpeed} + (${props.playbackRate}×)`,
    icon: "speedUp",
    shortcut: "'",
    execute: () => changePlaybackRate(1),
  },
  stop: {
    title: `${t("reset")} ${t("play")}`,
    icon: "stop",
    shortcut: "Backspace",
    disabled: !props.audioAvailable,
    execute: () => emit("stop-playback"),
  },
  play: {
    title: t(props.playing ? "pause" : "play"),
    icon: "play",
    shortcut: "Space",
    disabled: !props.audioAvailable,
    execute: () => emit("toggle-playback"),
  },
  redo: {
    title: copy.value.redo,
    icon: "redo",
    shortcut: "Y",
    disabled: !props.canRedo,
    execute: () => emit("redo"),
  },
  undo: {
    title: copy.value.undo,
    icon: "undo",
    shortcut: "Z",
    disabled: !props.canUndo,
    execute: () => emit("undo"),
  },
  eraser: {
    title: copy.value.erase,
    icon: "eraser",
    shortcut: "G",
    execute: () => activateTool("eraser"),
  },
  select: {
    title: copy.value.select,
    icon: "select",
    shortcut: "F",
    execute: () => activateTool("select"),
  },
  trace: {
    title: copy.value.trace,
    icon: "note-trace",
    execute: () => activateTool("trace"),
  },
  flick: {
    title: copy.value.flick,
    icon: "note-flick",
    execute: () => activateTool("flick"),
  },
  tap: {
    title: copy.value.tap,
    icon: "note-tap",
    shortcut: "A",
    execute: () => activateTool("tap"),
  },
  guide: {
    title: copy.value.guide,
    icon: "slide-guide",
    execute: () => activateTool("guide"),
  },
  long: {
    title: copy.value.hold,
    icon: "slide-long",
    shortcut: "S",
    execute: () => activateTool("long"),
  },
  timeScale: {
    title: copy.value.timeScale,
    icon: "text",
    iconText: "×",
    shortcut: "W",
    execute: () => emit("open-timing", "timeScale"),
  },
  meter: {
    title: copy.value.meter,
    icon: "text",
    iconText: "4/4",
    execute: () => emit("open-timing", "meter"),
  },
  bpm: {
    title: "BPM",
    icon: "text",
    iconText: "BPM",
    shortcut: "Q",
    execute: () => emit("open-timing", "bpm"),
  },
  division16: divisionCommand(16, "0"),
  division12: divisionCommand(12, "9"),
  division8: divisionCommand(8, "8"),
  division6: divisionCommand(6, "6"),
  division4: divisionCommand(4, "4"),
  division3: divisionCommand(3, "3"),
  division2: divisionCommand(2, "2"),
  division1: divisionCommand(1, "1"),
  zoomIn: {
    title: `${t("zoom")} +`,
    icon: "zoomIn",
    shortcut: "=",
    execute: () => emit("zoom-in"),
  },
  zoomOut: {
    title: `${t("zoom")} −`,
    icon: "zoomOut",
    shortcut: "-",
    execute: () => emit("zoom-out"),
  },
  fullscreen: {
    title: t("fullscreen"),
    icon: "fullscreen",
    execute: () => emit("fullscreen"),
  },
}));

function divisionCommand(division: (typeof divisions)[number], shortcut: string): Command {
  return {
    title: `${copy.value.snap} 1/${division}`,
    icon: "text",
    iconText: `1/${division}`,
    shortcut,
    execute: () => emit("update:snapDivision", division),
  };
}

const setActiveName = (names: readonly CommandName[], name: CommandName) => {
  const index = toolbar.findIndex((group) => group === names);
  if (index >= 0 && names.includes(name)) activeNames.value[index] = name;
};

watch(
  () => props.tool,
  (tool) => {
    const name = tool as CommandName;
    const names = toolbar.find((group) => group.some((candidate) => candidate === name));
    if (names && ["eraser", "select", "trace", "flick", "tap", "guide", "long"].includes(name)) {
      setActiveName(names, name);
    }
  },
  { immediate: true },
);

watch(
  () => props.snapDivision,
  (division) => {
    if (divisions.includes(division as (typeof divisions)[number])) {
      setActiveName(toolbar[7]!, `division${division}` as CommandName);
    }
  },
  { immediate: true },
);

watch(
  () => props.dragging,
  (dragging) => {
    if (dragging) activeIndex.value = -1;
  },
);

const execute = (name: CommandName): boolean => {
  const command = commands.value[name];
  if (command.disabled) return false;
  command.execute();
  return true;
};

const onOverMain = (event: PointerEvent, index: number) => {
  if (event.pointerType !== "mouse") return;
  activeIndex.value = index;
};

const onClickMain = (index: number, name: CommandName) => {
  if (activeIndex.value === -1 && (toolbar[index]?.length ?? 0) > 1) {
    activeIndex.value = index;
    return;
  }
  execute(name);
  activeIndex.value = -1;
};

const onClickSub = (index: number, name: CommandName) => {
  if (!execute(name)) return;
  activeIndex.value = -1;
  activeNames.value[index] = name;
};

const onOverBackdrop = (event: PointerEvent) => {
  if (event.pointerType !== "mouse") return;
  activeIndex.value = -1;
};

const onMainKeydown = (event: KeyboardEvent, index: number) => {
  if (event.key === "Escape") {
    activeIndex.value = -1;
    return;
  }
  if (!["ArrowUp", "ArrowDown"].includes(event.key) || (toolbar[index]?.length ?? 0) <= 1) return;
  event.preventDefault();
  activeIndex.value = index;
  void nextTick(() => root.value?.querySelector<HTMLElement>(`[data-toolbar-menu="${index}"] button`)?.focus());
};

const onMenuKeydown = (event: KeyboardEvent, index: number) => {
  if (event.key === "Escape") {
    event.preventDefault();
    activeIndex.value = -1;
    void nextTick(() => root.value?.querySelector<HTMLElement>(`[data-toolbar-main="${index}"]`)?.focus());
    return;
  }
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  const items = [...(root.value?.querySelectorAll<HTMLButtonElement>(`[data-toolbar-menu="${index}"] button`) ?? [])];
  if (!items.length) return;
  const current = Math.max(0, items.indexOf(document.activeElement as HTMLButtonElement));
  const next =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? items.length - 1
        : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
  event.preventDefault();
  items[next]?.focus();
};
</script>

<template>
  <div v-show="!dragging" ref="root" class="chart-editor-toolbar" role="toolbar" :aria-label="copy.edit">
    <div
      v-for="(activeName, index) in activeNames"
      :key="index"
      class="chart-editor-toolbar__group"
      :class="{ 'is-open': activeIndex === index }"
      :inert="activeIndex !== -1 && activeIndex !== index"
    >
      <ChartEditorToolbarTool
        :icon="commands[activeName].icon"
        :skin="toolbarSkin"
        :icon-text="commands[activeName].iconText"
        :label="commands[activeName].title"
        :playing="activeName === 'play' && playing"
        :disabled="commands[activeName].disabled"
        :aria-haspopup="(toolbar[index]?.length ?? 0) > 1 ? 'menu' : undefined"
        :aria-expanded="(toolbar[index]?.length ?? 0) > 1 ? activeIndex === index : undefined"
        :data-toolbar-main="index"
        @pointerover="onOverMain($event, index)"
        @click="onClickMain(index, activeName)"
        @keydown="onMainKeydown($event, index)"
      />

      <div
        v-if="activeIndex === index"
        class="chart-editor-toolbar__menu"
        role="menu"
        :aria-label="commands[activeName].title"
        :data-toolbar-menu="index"
        @keydown="onMenuKeydown($event, index)"
      >
        <ChartEditorToolbarTool
          v-for="name in toolbar[index]"
          :key="name"
          class="chart-editor-toolbar__menu-item"
          :icon="commands[name].icon"
          :skin="toolbarSkin"
          :icon-text="commands[name].iconText"
          :label="commands[name].title"
          :shortcut="commands[name].shortcut"
          :playing="name === 'play' && playing"
          :disabled="commands[name].disabled"
          show-label
          role="menuitem"
          @click="onClickSub(index, name)"
        />
      </div>
    </div>
  </div>

  <div
    v-if="activeIndex !== -1"
    class="chart-editor-toolbar__backdrop"
    aria-hidden="true"
    @pointerover="onOverBackdrop"
    @click="activeIndex = -1"
  />
</template>

<style scoped>
/* Next-SEKAI interaction grouping, rendered with the haneoka control skin. */
.chart-editor-toolbar {
  pointer-events: none;
  position: absolute;
  inset: 0;
  display: flex;
  flex-wrap: wrap;
  align-content: flex-end;
  justify-content: center;
  padding: 32px;
}

.chart-editor-toolbar__group {
  pointer-events: auto;
}

.chart-editor-toolbar__group.is-open {
  z-index: var(--md-sys-z-index-local-popover);
}

.chart-editor-toolbar__menu {
  position: absolute;
  left: 50%;
  display: grid;
  width: max-content;
  min-width: 186px;
  gap: 2px;
  padding: 5px;
  border: 1px solid var(--md-sys-color-outline);
  border-radius: 6px;
  background: rgb(251 252 255 / 0.98);
  box-shadow: 0 16px 36px rgb(9 14 37 / 0.22);
  transform: translate(-50%, calc(-100% - 32px));
}

.chart-editor-toolbar__menu-item {
  width: 100%;
}

.chart-editor-toolbar__backdrop {
  position: absolute;
  z-index: var(--md-sys-z-index-local-backdrop);
  inset: 0;
  background: rgb(5 9 24 / 0.44);
}

@media (min-width: 1024px) {
  .chart-editor-toolbar {
    padding-right: 128px;
    padding-left: 128px;
  }

  .chart-editor-toolbar__group {
    position: relative;
  }

  .chart-editor-toolbar__menu {
    left: auto;
    transform: translate(0, calc(-100% - 32px));
  }
}
</style>
