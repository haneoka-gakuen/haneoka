<script setup lang="ts">
import type { ChartCanvasSkin, RenderNoteKind } from "@haneoka/chart/overview";
import { MaterialIcon } from "@haneoka/ui";

const utilityIcons = {
  open: "folder_open",
  properties: "tune",
  reset: "note_add",
  save: "save",
  bgm: "music_note",
  speedDown: "fast_rewind",
  speedUp: "fast_forward",
  stop: "check_box_outline_blank",
  play: "play_arrow",
  pause: "pause",
  redo: "redo",
  undo: "undo",
  eraser: "ink_eraser",
  select: "arrow_selector_tool",
  eye: "visibility",
  zoomIn: "zoom_in",
  zoomOut: "zoom_out",
  fullscreen: "fullscreen",
} as const;

type GameNoteIcon = "note-tap" | "note-flick" | "note-trace" | "slide-long" | "slide-guide";

const props = withDefaults(
  defineProps<{
    icon: keyof typeof utilityIcons | GameNoteIcon | "text";
    skin?: ChartCanvasSkin;
    playing?: boolean;
    text?: string;
  }>(),
  {
    skin: undefined,
    playing: false,
    text: "",
  },
);

const noteCanvas = ref<HTMLCanvasElement>();
const utilityIcon = computed(() => {
  if (props.icon === "play" && props.playing) return utilityIcons.pause;
  return props.icon in utilityIcons ? utilityIcons[props.icon as keyof typeof utilityIcons] : undefined;
});
const noteKind = computed<RenderNoteKind | undefined>(() => {
  switch (props.icon) {
    case "note-tap":
      return "tap";
    case "note-flick":
      return "flick";
    case "note-trace":
      return "trace";
    case "slide-long":
      return "slide-start";
    case "slide-guide":
      return "guide";
    default:
      return undefined;
  }
});

const drawGameNote = (): void => {
  const target = noteCanvas.value;
  const kind = noteKind.value;
  if (!target || !kind) return;
  const context = target.getContext("2d");
  if (!context) return;
  target.width = 32;
  target.height = 32;
  context.setTransform(2, 0, 0, 2, 0, 0);
  context.clearRect(0, 0, 16, 16);
  props.skin?.drawFlatNote(context, {
    kind,
    direction: kind === "flick" ? "up" : "none",
    centerX: 8,
    centerY: kind === "flick" ? 10.5 : 8.5,
    width: 12,
    laneSpan: 4,
    stageWidth: 72,
    scale: 1,
  });
};

onMounted(drawGameNote);
watch([() => props.skin, noteKind], () => nextTick(drawGameNote), { flush: "post" });
</script>

<template>
  <MaterialIcon v-if="utilityIcon" class="chart-toolbar-icon" :name="utilityIcon" :size="16" />

  <span v-else-if="icon === 'text'" class="chart-toolbar-icon chart-toolbar-icon--text" aria-hidden="true">
    {{ text }}
  </span>

  <canvas v-else ref="noteCanvas" class="chart-toolbar-icon chart-toolbar-icon--note" aria-hidden="true" />
</template>

<style scoped>
.chart-toolbar-icon {
  display: block;
  width: 16px;
  height: 16px;
  flex: 0 0 16px;
}

.chart-toolbar-icon--text {
  display: flex;
  align-items: center;
  justify-content: center;
  font-family: var(--md-ref-typeface-brand);
  font-size: 0.61rem;
  font-weight: 650;
  line-height: 1;
  white-space: nowrap;
}

.chart-toolbar-icon--note {
  max-width: none;
}
</style>
