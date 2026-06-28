<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { OUR_NOTES_LIVE_GEOMETRY, type OurNotesAssetManifest } from "../assets/manifest";
import { isPairNoteOperateType, NoteDirection, NoteOperateType } from "../core/enums";
import { interpolateNoteLine } from "../core/geometry";
import type { ChartDocument, ChartNote } from "../core/types";
import type { RenderDirection, RenderNoteKind } from "../render/types";
import {
  createChartCanvasRibbonStyle,
  drawChartCanvasLanePlane,
  drawChartCanvasRibbon,
  loadChartCanvasSkin,
  type ChartCanvasRibbonSample,
} from "./chartCanvasSkin";
import type { ChartCanvasSkin } from "./chartCanvasSkin";
import {
  chartCanvasOverviewPresentation,
  lowerBoundTime,
  overviewViewport,
  upperBoundTime,
  type ChartCanvasOverviewPresentation,
  type OverviewGeometry,
} from "./overviewModel";

const props = withDefaults(
  defineProps<{
    chart: ChartDocument;
    assets: OurNotesAssetManifest;
    scale?: number;
    verticalScale?: number;
    showCombo?: boolean;
    mirror?: boolean;
    noteSize?: number;
    longAlpha?: number;
    showFever?: boolean;
    showBpm?: boolean;
    timeMarkerSeconds?: number;
    beatSubdivision?: number;
    skillMarkerSeconds?: number;
    graphicsQuality?: number;
    presentation?: ChartCanvasOverviewPresentation;
  }>(),
  {
    scale: 1,
    verticalScale: 1,
    showCombo: true,
    mirror: false,
    noteSize: 1,
    longAlpha: 0.8,
    showFever: true,
    showBpm: true,
    timeMarkerSeconds: 5,
    beatSubdivision: 1,
    skillMarkerSeconds: 8,
    graphicsQuality: 1,
  },
);

// Third-party charts are remote, untrusted input.  These limits sit well
// above normal BanG Dream! charts while preventing a single malformed BPM
// event from scheduling an unbounded canvas loop on the UI thread.
const MAX_BEAT_SUBDIVISION = 64;
const MAX_BEAT_LINES_PER_SEGMENT = 2_048;
const MIN_OVERVIEW_VIEWPORT_HEIGHT = 160;

interface HoverMarker {
  panel: number;
  y: number;
  timeMs: number;
  combo: number;
}

const host = ref<HTMLDivElement | null>(null);
const viewportHeight = ref(MIN_OVERVIEW_VIEWPORT_HEIGHT);
const hover = ref<HoverMarker | null>(null);
const visiblePanels = ref<number[]>([0]);
const panelCanvases = new Map<number, HTMLCanvasElement>();
let observer: ResizeObserver | undefined;
let canvasSkin: ChartCanvasSkin | undefined;
let skinLoadGeneration = 0;
let disposed = false;
let drawFrame = 0;
let hoverFrame = 0;
let pendingHover: HoverMarker | null = null;
let visibleFirstPanel = 0;
let visibleLastPanel = 0;
let pendingClientX = 0;
let pendingClientY = 0;
let hoverPending = false;

const presentation = computed(
  () =>
    props.presentation ??
    chartCanvasOverviewPresentation(props.scale, props.verticalScale, props.noteSize, props.longAlpha),
);
const geometry = computed<OverviewGeometry>(() => ({
  laneWidth: presentation.value.laneWidth,
  panelWidth: 13 * presentation.value.laneWidth,
  heightPerSecond: presentation.value.heightPerSecond,
  secondsPerPanel: viewportHeight.value / presentation.value.heightPerSecond,
}));
const laneWidth = computed(() => geometry.value.laneWidth);
const stageWidth = computed(() => presentation.value.stageWidth);
const stageHalfWidth = computed(() => stageWidth.value / 2);
const panelWidth = computed(() => geometry.value.panelWidth);
const heightPerSecond = computed(() => geometry.value.heightPerSecond);
const panelDurationMs = computed(() => geometry.value.secondsPerPanel * 1000);
const panelCount = computed(() => {
  const duration = Number.isFinite(props.chart.durationMs) ? Math.max(0, props.chart.durationMs) : 0;
  return Math.max(1, Math.ceil(duration / panelDurationMs.value));
});
const contentWidth = computed(() => panelCount.value * panelWidth.value);

const chartModel = computed(() => {
  const byId = new Map(props.chart.notes.map((note) => [note.id, note]));
  const byTime = (left: ChartNote, right: ChartNote): number => left.timeMs - right.timeMs || left.id - right.id;
  const notes = props.chart.notes.filter((note) => note.visible && note.judged).sort(byTime);
  const judgedNotes = props.chart.notes.filter((note) => note.judged).sort(byTime);
  const pairGroups = new Map<number, ChartNote[]>();
  for (const note of notes) {
    if (!isPairNoteOperateType(note.operateType)) continue;
    const group = pairGroups.get(note.tick);
    if (group) group.push(note);
    else pairGroups.set(note.tick, [note]);
  }
  const simultaneous: Array<{ timeMs: number; order: number; notes: readonly [ChartNote, ChartNote] }> = [];
  for (const group of pairGroups.values()) {
    group.sort((left, right) => left.id - right.id);
    for (let index = 1; index < group.length; index++) {
      simultaneous.push({
        timeMs: group[index]!.timeMs,
        order: group[index]!.id,
        notes: [group[index - 1]!, group[index]!],
      });
    }
  }
  simultaneous.sort((left, right) => left.timeMs - right.timeMs || left.order - right.order);
  return {
    notes,
    judgedNotes,
    simultaneous,
    lines: props.chart.lines.map((line) => ({
      kind: line.kind,
      // Generated combo ticks have indexInLine=null and do not alter the
      // authored ribbon outline.
      nodes: line.noteIds
        .map((id) => byId.get(id))
        .filter((note): note is ChartNote => Boolean(note) && note!.indexInLine !== null)
        .sort(byTime),
    })),
  };
});

function overviewKind(note: ChartNote): RenderNoteKind {
  switch (note.operateType) {
    case NoteOperateType.Flick:
    case NoteOperateType.SlideBeginFlick:
    case NoteOperateType.SlideEndFlick:
    case NoteOperateType.GuideBeginFlick:
      return note.direction === NoteDirection.Left
        ? "flick-left"
        : note.direction === NoteDirection.Right
          ? "flick-right"
          : "flick";
    case NoteOperateType.SlideBegin:
    case NoteOperateType.SlideBeginTrace:
    case NoteOperateType.HiddenSlideBegin:
      return "slide-start";
    case NoteOperateType.SlideEnd:
    case NoteOperateType.SlideEndTrace:
    case NoteOperateType.HiddenSlideEnd:
      return "slide-end";
    case NoteOperateType.SlideConnection:
    case NoteOperateType.SlideConnectionTrace:
    case NoteOperateType.Combo:
      return "slide-node";
    case NoteOperateType.Trace:
    case NoteOperateType.GuideBeginTrace:
    case NoteOperateType.GuideEndTrace:
      return "trace";
    case NoteOperateType.GuideBegin:
    case NoteOperateType.GuideEnd:
      return "guide";
    default:
      return "tap";
  }
}

function mirroredDirection(note: ChartNote): NoteDirection {
  if (!props.mirror) return note.direction;
  if (note.direction === NoteDirection.Left) return NoteDirection.Right;
  if (note.direction === NoteDirection.Right) return NoteDirection.Left;
  return NoteDirection.Normal;
}

function overviewDirection(note: ChartNote): RenderDirection {
  const direction = mirroredDirection(note);
  if (direction === NoteDirection.Left) return "left";
  if (direction === NoteDirection.Right) return "right";
  return "up";
}

function scoreX(scorePosition: number): number {
  const fromCenter = (scorePosition / 24) * presentation.value.bandCount - presentation.value.bandCount / 2;
  return panelWidth.value / 2 + (props.mirror ? -fromCenter : fromCenter) * laneWidth.value;
}

function noteBounds(note: Pick<ChartNote, "pos" | "size">): { left: number; right: number; center: number } {
  const a = scoreX(note.pos);
  const b = scoreX(note.pos + note.size);
  return { left: Math.min(a, b), right: Math.max(a, b), center: (a + b) / 2 };
}

function yForTime(timeMs: number, panel: number, height: number): number {
  return height - ((timeMs - panel * panelDurationMs.value) / 1000) * heightPerSecond.value;
}

function formatTime(seconds: number): string {
  const minute = Math.floor(seconds / 60);
  const second = Math.floor(seconds % 60);
  return `${minute}:${String(second).padStart(2, "0")}`;
}

function formatTimeAccurate(timeMs: number): string {
  // This intentionally matches production: despite the name, only the
  // seconds field is displayed, including after the first minute.
  return ((timeMs / 1000) % 60).toFixed(2).padStart(5, "0");
}

function setPanelCanvas(panel: number, element: unknown): void {
  if (element instanceof HTMLCanvasElement) panelCanvases.set(panel, element);
  else panelCanvases.delete(panel);
}

function drawBeatLines(
  context: CanvasRenderingContext2D,
  panel: number,
  height: number,
  panelStart: number,
  panelEnd: number,
): void {
  const subdivision = Math.min(MAX_BEAT_SUBDIVISION, Math.max(0, Math.round(props.beatSubdivision)));
  if (!subdivision) return;
  const changes = props.chart.bpmChanges;
  const left = panelWidth.value / 2 - stageHalfWidth.value;
  const right = panelWidth.value / 2 + stageHalfWidth.value;
  for (let index = 0; index < changes.length; index++) {
    const change = changes[index]!;
    const nextTime = changes[index + 1]?.timeMs ?? Number.POSITIVE_INFINITY;
    const segmentStart = Math.max(panelStart, change.timeMs);
    const segmentEnd = Math.min(panelEnd, nextTime);
    if (!Number.isFinite(segmentStart) || !Number.isFinite(segmentEnd) || segmentEnd <= segmentStart) continue;
    if (!Number.isFinite(change.bpm) || change.bpm <= 0) continue;
    const beatMs = 60_000 / change.bpm;
    if (!Number.isFinite(beatMs) || beatMs <= 0) continue;
    let step = Math.ceil((change.beat + (segmentStart - change.timeMs) / beatMs) * subdivision - 1e-8);
    if (!Number.isFinite(step)) continue;
    for (let count = 0; count < MAX_BEAT_LINES_PER_SEGMENT; count++, step++) {
      const beat = step / subdivision;
      const timeMs = change.timeMs + (beat - change.beat) * beatMs;
      if (!Number.isFinite(timeMs) || timeMs >= segmentEnd - 1e-6) break;
      const fraction = ((step % subdivision) + subdivision) % subdivision;
      context.strokeStyle =
        fraction === 0 ? "rgba(128, 255, 255, 0.2)" : `hsla(${(360 * fraction) / subdivision}, 100%, 50%, 0.2)`;
      context.setLineDash(fraction === 0 ? [] : [0.25 * laneWidth.value]);
      context.lineDashOffset = 0.125 * laneWidth.value;
      const y = yForTime(timeMs, panel, height);
      context.beginPath();
      context.moveTo(left, y);
      context.lineTo(right, y);
      context.stroke();
    }
  }
  context.setLineDash([]);
  context.lineDashOffset = 0;
}

function drawDefaultMarkers(
  context: CanvasRenderingContext2D,
  panel: number,
  height: number,
  panelStart: number,
  panelEnd: number,
): void {
  const left = panelWidth.value / 2 - stageHalfWidth.value;
  const right = panelWidth.value / 2 + stageHalfWidth.value;
  const minimumY = laneWidth.value / 2;
  const maximumY = height - laneWidth.value / 2;
  context.font = `${laneWidth.value}px Arial`;
  context.textBaseline = "middle";

  if (props.showCombo) {
    context.fillStyle = "rgba(255, 255, 255, 0.5)";
    context.textAlign = "left";
    for (let combo = 50; combo < chartModel.value.judgedNotes.length; combo += 50) {
      const timeMs = chartModel.value.judgedNotes[combo]!.timeMs;
      if (timeMs >= panelEnd) break;
      if (timeMs >= panelStart) {
        const y = Math.max(minimumY, Math.min(maximumY, yForTime(timeMs, panel, height)));
        context.fillText(String(combo), right + 0.5 * laneWidth.value, y);
      }
    }
  }

  if (props.timeMarkerSeconds > 0) {
    const interval = props.timeMarkerSeconds * 1000;
    context.fillStyle = "rgba(255, 255, 255, 0.5)";
    context.textAlign = "right";
    for (let timeMs = Math.ceil(panelStart / interval) * interval; timeMs < panelEnd; timeMs += interval) {
      const y = Math.max(minimumY, Math.min(maximumY, yForTime(timeMs, panel, height)));
      context.fillText(formatTime(timeMs / 1000), left - 0.5 * laneWidth.value, y);
    }
  }

  if (props.showBpm) {
    context.fillStyle = "rgba(255, 0, 255, 0.5)";
    context.strokeStyle = "rgba(255, 0, 255, 0.5)";
    context.textAlign = "left";
    context.beginPath();
    for (const change of props.chart.bpmChanges) {
      if (change.timeMs >= panelEnd) break;
      if (change.timeMs < panelStart || change.bpm <= 0) continue;
      const y = yForTime(change.timeMs, panel, height);
      context.moveTo(left, y);
      context.lineTo(right, y);
      context.fillText(String(change.bpm), right + 0.5 * laneWidth.value, Math.max(minimumY, Math.min(maximumY, y)));
    }
    context.stroke();
  }

  if (props.showFever) {
    context.strokeStyle = "rgba(255, 0, 0, 0.5)";
    const markerRight = right + 2 * laneWidth.value;
    context.beginPath();
    for (const section of props.chart.timeline.fever) {
      const start = section.startTimeMs;
      const end = section.endTimeMs;
      if (start >= panelEnd) break;
      if (end < panelStart) continue;
      const startY = yForTime(start, panel, height);
      const endY = yForTime(end, panel, height);
      context.moveTo(markerRight, startY);
      context.lineTo(markerRight, endY);
      if (start >= panelStart) {
        context.moveTo(left, startY);
        context.lineTo(markerRight, startY);
      }
      if (end < panelEnd) {
        context.moveTo(left, endY);
        context.lineTo(markerRight, endY);
      }
    }
    context.stroke();
  }

  if (props.skillMarkerSeconds > 0) {
    context.fillStyle = "rgba(255, 255, 0, 0.5)";
    context.strokeStyle = "rgba(255, 255, 0, 0.5)";
    context.textAlign = "left";
    const markerRight = right + laneWidth.value;
    context.beginPath();
    props.chart.timeline.skills.forEach((event) => {
      const start = event.timeMs;
      const end = start + props.skillMarkerSeconds * 1000;
      if (start >= panelEnd || end < panelStart) return;
      const startY = yForTime(start, panel, height);
      const endY = yForTime(end, panel, height);
      context.moveTo(markerRight, startY);
      context.lineTo(markerRight, endY);
      if (start >= panelStart) {
        context.moveTo(left, startY);
        context.lineTo(markerRight, startY);
        context.fillText(
          `#${event.index + 1}`,
          right + 1.5 * laneWidth.value,
          Math.max(minimumY, Math.min(maximumY, startY)),
        );
      }
      if (end < panelEnd) {
        context.moveTo(left, endY);
        context.lineTo(markerRight, endY);
      }
    });
    context.stroke();
  }
}

function drawSimultaneousLines(
  context: CanvasRenderingContext2D,
  panel: number,
  height: number,
  panelStart: number,
  panelEnd: number,
): void {
  const entries = chartModel.value.simultaneous;
  const first = lowerBoundTime(entries, panelStart);
  const last = upperBoundTime(entries, panelEnd - Number.EPSILON);
  // Pair-note lines are an independent white sliced sprite in the original;
  // their serialized 0.025-unit height is not derived from note/lane size.
  const worldToCss = stageWidth.value / OUR_NOTES_LIVE_GEOMETRY.laneWidth;
  const lineHeight = OUR_NOTES_LIVE_GEOMETRY.simultaneousLineSize[1] * worldToCss;
  context.fillStyle = "#ffffff";
  for (let index = first; index < last; index++) {
    const entry = entries[index]!;
    const firstCenter = noteBounds(entry.notes[0]).center;
    const secondCenter = noteBounds(entry.notes[1]).center;
    const left = Math.min(firstCenter, secondCenter);
    const right = Math.max(firstCenter, secondCenter);
    if (right <= left) continue;
    const y = yForTime(entry.timeMs, panel, height);
    context.fillRect(left, y - lineHeight / 2, right - left, lineHeight);
  }
}

function drawRibbons(
  context: CanvasRenderingContext2D,
  panel: number,
  height: number,
  panelStart: number,
  panelEnd: number,
): void {
  const guideStyle = createChartCanvasRibbonStyle(context, "guide", height, laneWidth.value);
  const slideStyle = createChartCanvasRibbonStyle(context, "slide", height, laneWidth.value);
  for (const line of chartModel.value.lines) {
    const style = line.kind === "guide" ? guideStyle : slideStyle;
    const nodes = line.nodes;
    if (nodes.length < 2 || nodes.at(-1)!.timeMs <= panelStart || nodes[0]!.timeMs >= panelEnd) continue;
    for (let index = 0; index < nodes.length - 1; index++) {
      const head = nodes[index]!;
      const tail = nodes[index + 1]!;
      if (tail.timeMs <= panelStart || head.timeMs >= panelEnd) continue;
      const segmentStart = Math.max(head.timeMs, panelStart);
      const segmentEnd = Math.min(tail.timeMs, panelEnd);
      if (segmentEnd <= segmentStart) continue;
      const steps = Math.max(2, Math.ceil((segmentEnd - segmentStart) / 50));
      const samples: ChartCanvasRibbonSample[] = [];
      for (let step = 0; step <= steps; step++) {
        const timeMs = segmentStart + ((segmentEnd - segmentStart) * step) / steps;
        const shape = interpolateNoteLine(head, tail, timeMs);
        samples.push({
          left: scoreX(shape.pos),
          right: scoreX(shape.pos + shape.size),
          y: yForTime(timeMs, panel, height),
        });
      }
      drawChartCanvasRibbon(context, samples, style, presentation.value.longAlpha);
    }
  }
}

function drawNote(context: CanvasRenderingContext2D, note: ChartNote, panel: number, height: number): void {
  const kind = overviewKind(note);
  const bounds = noteBounds(note);
  const noteWidth = Math.max(0.5, (bounds.right - bounds.left) * presentation.value.noteScale);
  canvasSkin?.drawFlatNote(context, {
    kind,
    direction: overviewDirection(note),
    centerX: bounds.center,
    centerY: yForTime(note.timeMs, panel, height),
    width: noteWidth,
    laneSpan: note.size,
    stageWidth: stageWidth.value,
    scale: presentation.value.noteScale,
  });
}

function drawPanel(panel: number): void {
  const target = panelCanvases.get(panel);
  const container = host.value;
  if (!target || !container) return;
  const dpr = Math.max(0.1, (window.devicePixelRatio || 1) * props.graphicsQuality);
  const width = panelWidth.value;
  const height = Math.max(1, container.clientHeight);
  const pixelWidth = Math.max(1, Math.round(width * dpr));
  const pixelHeight = Math.max(1, Math.round(height * dpr));
  if (target.width !== pixelWidth) target.width = pixelWidth;
  if (target.height !== pixelHeight) target.height = pixelHeight;
  const context = target.getContext("2d", { alpha: false });
  if (!context) return;
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.fillStyle = "black";
  context.fillRect(0, 0, width, height);
  context.lineWidth = presentation.value.lineWidth;
  drawChartCanvasLanePlane(context, {
    centerX: width / 2,
    height,
    laneWidth: laneWidth.value,
    styleLaneWidth: presentation.value.laneWidth,
    bandCount: presentation.value.bandCount,
    spaceCount: presentation.value.spaceCount,
  });

  const panelStart = panel * panelDurationMs.value;
  const panelEnd = (panel + 1) * panelDurationMs.value;
  drawBeatLines(context, panel, height, panelStart, panelEnd);
  drawDefaultMarkers(context, panel, height, panelStart, panelEnd);
  drawSimultaneousLines(context, panel, height, panelStart, panelEnd);
  drawRibbons(context, panel, height, panelStart, panelEnd);

  const notes = chartModel.value.notes;
  const first = lowerBoundTime(notes, panelStart);
  const last = upperBoundTime(notes, panelEnd - Number.EPSILON);
  for (let index = first; index < last; index++) drawNote(context, notes[index]!, panel, height);
}

function draw(): void {
  drawFrame = 0;
  for (const panel of visiblePanels.value) drawPanel(panel);
}

function scheduleDraw(): void {
  if (!drawFrame) drawFrame = requestAnimationFrame(draw);
}

function refreshViewport(forceDraw = false): void {
  const container = host.value;
  if (!container) return;
  // ResizeObserver fires once before a routed workspace has a measured
  // height.  Keeping a reasonable provisional panel avoids a multi-million
  // pixel track during that frame; the next resize replaces it exactly.
  viewportHeight.value = Math.max(MIN_OVERVIEW_VIEWPORT_HEIGHT, container.clientHeight);
  const viewport = overviewViewport(
    props.chart.durationMs,
    geometry.value.secondsPerPanel,
    panelWidth.value,
    container.clientWidth,
    container.scrollLeft,
  );
  // One panel of overscan on each side keeps momentum scrolling seamless;
  // canvas count remains proportional to the visible viewport.
  const first = Math.max(0, viewport.firstPanel - 1);
  const last = Math.min(viewport.panelCount - 1, viewport.lastPanel + 1);
  if (first !== visibleFirstPanel || last !== visibleLastPanel) {
    visibleFirstPanel = first;
    visibleLastPanel = last;
    visiblePanels.value = Array.from({ length: last - first + 1 }, (_, index) => first + index);
    nextTick(scheduleDraw);
  } else if (forceDraw) {
    scheduleDraw();
  }
}

function onScroll(): void {
  refreshViewport(false);
}

function onMove(event: MouseEvent): void {
  pendingClientX = event.clientX;
  pendingClientY = event.clientY;
  hoverPending = true;
  if (!hoverFrame) {
    hoverFrame = requestAnimationFrame(() => {
      hoverFrame = 0;
      if (!hoverPending) return;
      const container = host.value;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const x = pendingClientX - rect.left + container.scrollLeft;
      const y = Math.max(0, Math.min(container.clientHeight, pendingClientY - rect.top));
      const panel = Math.floor(x / panelWidth.value);
      if (panel < 0 || panel >= panelCount.value) {
        pendingHover = null;
        hover.value = null;
        return;
      }
      const timeMs = (((panel + 1) * container.clientHeight - y) / heightPerSecond.value) * 1000;
      pendingHover = {
        panel,
        y,
        timeMs,
        combo: upperBoundTime(chartModel.value.judgedNotes, timeMs),
      };
      hover.value = pendingHover;
    });
  }
}

function onLeave(): void {
  hoverPending = false;
  pendingHover = null;
  hover.value = null;
}

async function loadOverviewAtlas(assets: OurNotesAssetManifest): Promise<void> {
  const generation = ++skinLoadGeneration;
  try {
    const loaded = await loadChartCanvasSkin(assets);
    if (disposed || generation !== skinLoadGeneration) {
      loaded.dispose();
      return;
    }
    canvasSkin?.dispose();
    canvasSkin = loaded;
    scheduleDraw();
  } catch {
    // Fail closed: unrelated colored rectangles are not native note sprites.
  }
}

onMounted(() => {
  observer = new ResizeObserver(() => refreshViewport(true));
  if (host.value) observer.observe(host.value);
  nextTick(() => refreshViewport(true));
  void loadOverviewAtlas(props.assets);
});
onBeforeUnmount(() => {
  disposed = true;
  skinLoadGeneration += 1;
  observer?.disconnect();
  cancelAnimationFrame(drawFrame);
  cancelAnimationFrame(hoverFrame);
  canvasSkin?.dispose();
  canvasSkin = undefined;
  panelCanvases.clear();
});
watch(
  () => props.assets,
  (assets, previousAssets) => {
    if (assets !== previousAssets && host.value) void loadOverviewAtlas(assets);
  },
  { flush: "post" },
);
watch(
  [
    () => props.chart,
    () => props.scale,
    () => props.verticalScale,
    () => props.showCombo,
    () => props.mirror,
    () => props.noteSize,
    () => props.longAlpha,
    () => props.showFever,
    () => props.showBpm,
    () => props.timeMarkerSeconds,
    () => props.beatSubdivision,
    () => props.skillMarkerSeconds,
    () => props.graphicsQuality,
    () => props.presentation,
  ],
  () => nextTick(() => refreshViewport(true)),
);
</script>

<template>
  <div ref="host" class="our-chart-overview" @scroll.passive="onScroll" @mousemove="onMove" @mouseleave="onLeave">
    <div class="our-chart-overview__track" :style="{ width: `${contentWidth}px` }">
      <canvas
        v-for="panel in visiblePanels"
        :key="panel"
        :ref="(element) => setPanelCanvas(panel, element)"
        class="is-unselectable"
        :style="{
          left: `${panel * panelWidth}px`,
          width: `${panelWidth}px`,
          height: `${viewportHeight}px`,
        }"
      />
      <template v-if="hover">
        <span
          class="our-chart-overview__marker"
          :style="{
            left: `${hover.panel * panelWidth + panelWidth / 2 - stageHalfWidth}px`,
            top: `${hover.y}px`,
            width: `${stageWidth}px`,
            height: `${presentation.lineWidth}px`,
          }"
        ></span>
        <span
          class="our-chart-overview__hover-time"
          :style="{
            left: `${hover.panel * panelWidth + panelWidth / 2 - 4 * laneWidth}px`,
            top: `${Math.max(laneWidth / 2, Math.min(viewportHeight - laneWidth / 2, hover.y))}px`,
            fontSize: `${laneWidth}px`,
          }"
        >
          {{ formatTimeAccurate(hover.timeMs) }}
        </span>
        <span
          class="our-chart-overview__hover-combo"
          :style="{
            left: `${hover.panel * panelWidth + panelWidth / 2 + 4 * laneWidth}px`,
            top: `${Math.max(laneWidth / 2, Math.min(viewportHeight - laneWidth / 2, hover.y))}px`,
            fontSize: `${laneWidth}px`,
          }"
        >
          {{ hover.combo }}
        </span>
      </template>
    </div>
  </div>
</template>
