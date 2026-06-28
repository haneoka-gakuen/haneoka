<script setup lang="ts">
import { resolveLinePointShape, type NoteDirection, type NoteType, type Project } from "@haneoka/chart-editor/model";
import { TempoMap, snapTick } from "@haneoka/chart-editor/timing";
import {
  panVerticalTimeViewport,
  scrollVerticalTimeViewport,
  timeToViewportY,
  viewportYToTime,
  zoomVerticalTimeViewportAtY,
  type VerticalTimeViewport,
} from "@haneoka/chart-editor/viewport";
import type { WaveformBins } from "@haneoka/chart-editor/waveform";
import {
  CHART_CANVAS_OVERVIEW_DEFAULT_PRESENTATION,
  createChartCanvasRibbonStyle,
  drawChartCanvasLanePlane,
  drawChartCanvasRibbon,
  loadChartCanvasSkin,
  type ChartCanvasOverviewPresentation,
  type ChartCanvasRibbonKind,
  type ChartCanvasRibbonSample,
  type ChartCanvasSkin,
  type RenderDirection,
  type RenderNoteKind,
} from "@haneoka/chart/overview";
import type { OurNotesAssetManifest } from "@haneoka/chart/assets";
import { computed, nextTick, onActivated, onBeforeUnmount, onMounted, ref, watch } from "vue";

type EditorTool = "select" | "pan" | "eraser" | "tap" | "flick" | "trace" | "long" | "hold" | "guide" | string;

interface EditorPointDraft {
  tick: number;
  lane: number;
  size: number;
}

interface CreateSinglePayload extends EditorPointDraft {
  type: NoteType;
  critical: boolean;
  direction: NoteDirection;
}

interface CreateHoldPayload {
  kind: "long" | "guide";
  start: EditorPointDraft;
  end: EditorPointDraft;
}

interface MoveItem {
  id: string;
  tick: number;
  lane: number;
  size?: number;
}

interface ViewChangePayload {
  startSeconds: number;
  pixelsPerSecond: number;
}

interface Props {
  project: Project;
  assets?: OurNotesAssetManifest;
  waveform?: WaveformBins | null;
  audioDuration?: number;
  viewStartSeconds?: number;
  pixelsPerSecond?: number;
  minPixelsPerSecond?: number;
  maxPixelsPerSecond?: number;
  presentation?: ChartCanvasOverviewPresentation;
  snapDivision?: number;
  tool?: EditorTool;
  selectedIds?: readonly string[];
  playheadSeconds?: number;
  playing?: boolean;
  draftHoldStart?: EditorPointDraft | null;
  noteSize?: number;
  critical?: boolean;
  direction?: NoteDirection;
  timelineLabel: string;
}

const props = withDefaults(defineProps<Props>(), {
  waveform: null,
  audioDuration: 0,
  viewStartSeconds: 0,
  pixelsPerSecond: CHART_CANVAS_OVERVIEW_DEFAULT_PRESENTATION.heightPerSecond,
  minPixelsPerSecond: 1,
  maxPixelsPerSecond: 10_000,
  presentation: () => CHART_CANVAS_OVERVIEW_DEFAULT_PRESENTATION,
  snapDivision: 4,
  tool: "select",
  selectedIds: () => [],
  playheadSeconds: 0,
  playing: false,
  draftHoldStart: null,
  noteSize: 2,
  critical: false,
  direction: "none",
});

const emit = defineEmits<{
  select: [payload: { ids: string[] }];
  "create-single": [payload: CreateSinglePayload];
  "create-hold": [payload: CreateHoldPayload];
  move: [payload: { items: MoveItem[]; commit: true }];
  delete: [payload: { ids: string[] }];
  seek: [seconds: number];
  "view-change": [payload: ViewChangePayload];
  "draft-hold": [payload: EditorPointDraft | null];
  "request-properties": [];
}>();

const wrapper = ref<HTMLDivElement | null>(null);
const canvas = ref<HTMLCanvasElement | null>(null);
const cssWidth = ref(1);
const cssHeight = ref(1);
const dpr = ref(1);
const transientViewStart = ref<number | null>(null);
const transientPixelsPerSecond = ref<number | null>(null);
const hoverDraft = ref<EditorPointDraft | null>(null);
const hoverSeconds = ref<number | null>(null);
let canvasSkin: ChartCanvasSkin | undefined;
let skinLoadGeneration = 0;
let disposed = false;

const NOTE_POINTER_HIT_HEIGHT = 24;
const NOTE_SELECTION_PADDING = 3;

const laneBasis = computed(() => Math.round(props.project.laneBasis));
const effectiveViewStart = (): number => transientViewStart.value ?? props.viewStartSeconds;
const effectivePixelsPerSecond = (): number => transientPixelsPerSecond.value ?? props.pixelsPerSecond;
const viewScaleBounds = (): { minimum: number; maximum: number } => {
  const first = Math.max(0.001, props.minPixelsPerSecond);
  const second = Math.max(0.001, props.maxPixelsPerSecond);
  return { minimum: Math.min(first, second), maximum: Math.max(first, second) };
};

const projectAudioOffset = computed(() => props.project.audioOffset);

const tempoMap = computed(() => {
  try {
    return new TempoMap(props.project.tempos, {
      resolution: props.project.resolution,
      audioOffset: projectAudioOffset.value,
    });
  } catch {
    return new TempoMap([{ id: "canvas-fallback-tempo", tick: 0, bpm: 120 }], {
      resolution: Math.max(1, Math.round(props.project.resolution || 480)),
      audioOffset: projectAudioOffset.value,
    });
  }
});

const timelineBounds = computed(() => {
  let minimum = Math.min(0, projectAudioOffset.value, props.waveform?.duration ?? 0, props.audioDuration);
  let maximum = Math.max(0, projectAudioOffset.value, props.waveform?.duration ?? 0, props.audioDuration);
  const includeTick = (tick: number): void => {
    const seconds = tempoMap.value.tickToSeconds(tick);
    minimum = Math.min(minimum, seconds);
    maximum = Math.max(maximum, seconds);
  };
  for (const note of props.project.singles) includeTick(note.tick);
  for (const line of props.project.lines) {
    for (const point of line.points) includeTick(point.tick);
  }
  return { minimum: minimum - 4, maximum: maximum + 2 };
});

const stageWidth = (): number => cssWidth.value * 0.75;
const stageLeft = (): number => (cssWidth.value - stageWidth()) / 2;
const stageRight = (): number => stageLeft() + stageWidth();
const trackLeft = stageLeft;
const lanePixels = (): number => stageWidth() / laneBasis.value;
const laneToX = (lane: number): number => stageLeft() + lane * lanePixels();
const xToLane = (x: number): number => (x - stageLeft()) / Math.max(0.001, lanePixels());
const timeViewport = (): VerticalTimeViewport => ({
  startSeconds: effectiveViewStart(),
  pixelsPerSecond: effectivePixelsPerSecond(),
  height: cssHeight.value,
});
const secondsToY = (seconds: number): number => timeToViewportY(seconds, timeViewport());
const yToSeconds = (y: number): number => viewportYToTime(y, timeViewport());

const clamp = (value: number, minimum: number, maximum: number): number => Math.min(maximum, Math.max(minimum, value));
interface DisplayPoint {
  id: string;
  tick: number;
  lane: number;
  size: number;
  type: NoteType;
  critical: boolean;
  direction: NoteDirection;
  visible: boolean;
  ease?: { left: "linear" | "in" | "out"; right: "linear" | "in" | "out" };
}

interface HitRegion {
  id: string;
  x1: number;
  x2: number;
  y1: number;
  y2: number;
}

const hitRegions: HitRegion[] = [];
const selectionRegions: HitRegion[] = [];
const selectedRegions: HitRegion[] = [];
const selectedSet = computed(() => new Set(props.selectedIds));
const dragPreview = ref<Map<string, MoveItem> | null>(null);
const marquee = ref<{ startX: number; startY: number; currentX: number; currentY: number } | null>(null);

const resolveLinePoints = (line: Project["lines"][number]): DisplayPoint[] => {
  const preview = dragPreview.value;
  const hasLinePreview = Boolean(preview && line.points.some((point) => preview.has(point.id)));
  const points = line.points
    .map((point) => {
      const pointPreview = preview?.get(point.id);
      const temporary = {
        ...point,
        tick: pointPreview?.tick ?? point.tick,
        // An explicit anchor moves as part of the temporary authored line.
        // An authored auto point stays auto while resolving its width; its
        // preview lane is applied to the DisplayPoint below.
        lane: pointPreview && typeof point.lane === "number" ? pointPreview.lane : point.lane,
      };
      if (hasLinePreview && temporary.lane === "auto") {
        // Any moved tick or explicit anchor can change every interpolated
        // boundary. Ignore imported caches for this one preview frame.
        delete temporary.resolvedLane;
        delete temporary.resolvedSize;
      }
      return temporary;
    })
    .sort((left, right) => left.tick - right.tick || left.id.localeCompare(right.id));
  return points.map((point, index) => {
    // SS `pos: "auto"` can omit size. Its visible shape interpolates the
    // left and right boundaries independently, so using authored `size` here
    // would collapse all such nodes to a zero-width marker.
    const shape = resolveLinePointShape(points, index);
    const pointPreview = preview?.get(point.id);
    return {
      id: point.id,
      tick: point.tick,
      lane: pointPreview?.lane ?? shape.lane,
      size: shape.size,
      type: point.type,
      critical: point.critical,
      direction: point.direction,
      visible: point.visible,
      ease: point.ease,
    };
  });
};

const allEntityPositions = (): Map<string, MoveItem> => {
  const positions = new Map<string, MoveItem>();
  for (const note of props.project.singles)
    positions.set(note.id, { id: note.id, tick: note.tick, lane: note.lane, size: note.size });
  for (const line of props.project.lines) {
    for (const point of resolveLinePoints(line))
      positions.set(point.id, { id: point.id, tick: point.tick, lane: point.lane, size: point.size });
  }
  return positions;
};

const constrainLaneDelta = (items: readonly MoveItem[], requested: number): number => {
  if (!items.length) return requested;
  const left = Math.min(...items.map((item) => item.lane));
  const right = Math.max(...items.map((item) => item.lane + Math.max(0, item.size ?? 0)));
  const minimum = -left;
  const maximum = laneBasis.value - right;
  return minimum <= maximum ? clamp(requested, minimum, maximum) : requested;
};

const itemDisplayPosition = (id: string, tick: number, lane: number): MoveItem =>
  dragPreview.value?.get(id) ?? { id, tick, lane };

const drawTrack = (context: CanvasRenderingContext2D): void => {
  const presentation = props.presentation;
  context.fillStyle = "#000";
  context.fillRect(0, 0, cssWidth.value, cssHeight.value);
  drawChartCanvasLanePlane(context, {
    centerX: cssWidth.value / 2,
    height: cssHeight.value,
    laneWidth: stageWidth() / presentation.bandCount,
    styleLaneWidth: presentation.laneWidth,
    bandCount: presentation.bandCount,
    spaceCount: presentation.spaceCount,
  });
};

const drawWaveform = (context: CanvasRenderingContext2D): void => {
  const waveform = props.waveform;
  if (!waveform || waveform.length <= 0 || waveform.duration <= 0) return;
  const step = 2;
  const leftPoints: Array<[number, number]> = [];
  const rightPoints: Array<[number, number]> = [];
  const centerX = cssWidth.value / 2;
  const halfWidth = stageWidth() / 3;

  for (let y = 0; y <= cssHeight.value + step; y += step) {
    const firstTime = yToSeconds(y);
    const secondTime = yToSeconds(y + step);
    const timeStart = Math.min(firstTime, secondTime);
    const timeEnd = Math.max(firstTime, secondTime);
    const firstBin = clamp(Math.floor((timeStart / waveform.duration) * waveform.length), 0, waveform.length - 1);
    const lastBin = clamp(Math.ceil((timeEnd / waveform.duration) * waveform.length), 0, waveform.length - 1);
    if (timeEnd < 0 || timeStart > waveform.duration) {
      leftPoints.push([centerX, y]);
      rightPoints.push([centerX, y]);
      continue;
    }
    let amplitude = 0;
    for (let bin = firstBin; bin <= lastBin; bin++) {
      amplitude = Math.max(amplitude, Math.abs(waveform.min[bin] ?? 0), Math.abs(waveform.max[bin] ?? 0));
    }
    amplitude = clamp(amplitude, 0, 1);
    leftPoints.push([centerX - amplitude * halfWidth, y]);
    rightPoints.push([centerX + amplitude * halfWidth, y]);
  }

  context.save();
  context.beginPath();
  const first = leftPoints[0];
  if (!first) {
    context.restore();
    return;
  }
  context.moveTo(first[0], first[1]);
  for (let index = 1; index < leftPoints.length; index++) context.lineTo(leftPoints[index]![0], leftPoints[index]![1]);
  for (let index = rightPoints.length - 1; index >= 0; index--)
    context.lineTo(rightPoints[index]![0], rightPoints[index]![1]);
  context.closePath();
  context.fillStyle = "#fff";
  context.globalAlpha = 0.25;
  context.fill();
  context.restore();
};

const drawGrid = (context: CanvasRenderingContext2D): void => {
  const presentation = props.presentation;
  const map = tempoMap.value;
  const resolution = props.project.resolution;
  const visibleStartSeconds = Math.max(0, Math.min(yToSeconds(cssHeight.value), yToSeconds(0)));
  const visibleEndSeconds = Math.max(yToSeconds(cssHeight.value), yToSeconds(0));
  const division = Math.max(1, Math.round(props.snapDivision));
  const startDivision = Math.max(0, Math.ceil((map.secondsToTick(visibleStartSeconds) * division) / resolution));
  const endDivision = Math.max(
    startDivision,
    Math.floor((map.secondsToTick(visibleEndSeconds) * division) / resolution),
  );
  const markerSize = presentation.laneWidth;
  const markerFont = getComputedStyle(document.documentElement).getPropertyValue("--md-ref-typeface-plain").trim();

  context.save();
  context.lineWidth = presentation.lineWidth;
  if (endDivision - startDivision <= 100) {
    for (let index = startDivision; index <= endDivision; index++) {
      const tick = (index * resolution) / division;
      const y = secondsToY(map.tickToSeconds(tick));
      if (y < -1 || y > cssHeight.value + 1) continue;
      const isBeat = index % division === 0;
      const fraction = ((index % division) + division) % division;
      context.strokeStyle = isBeat
        ? "rgba(128, 255, 255, 0.2)"
        : `hsla(${(360 * fraction) / division}, 100%, 50%, 0.2)`;
      context.setLineDash(isBeat ? [] : [0.25 * presentation.laneWidth]);
      context.lineDashOffset = 0.125 * presentation.laneWidth;
      context.beginPath();
      context.moveTo(stageLeft(), Math.round(y) + 0.5);
      context.lineTo(stageRight(), Math.round(y) + 0.5);
      context.stroke();
    }
  }
  context.setLineDash([]);
  context.lineDashOffset = 0;

  context.fillStyle = "rgb(255 255 255 / 0.5)";
  context.font = `500 ${markerSize}px ${markerFont}`;
  context.textBaseline = "middle";
  context.textAlign = "right";
  for (let second = Math.max(1, Math.ceil(visibleStartSeconds)); second <= Math.floor(visibleEndSeconds); second++) {
    const minute = Math.floor(second / 60);
    const remainder = second % 60;
    context.fillText(
      `${minute}:${String(remainder).padStart(2, "0")}`,
      stageLeft() - markerSize / 2,
      secondsToY(second),
    );
  }

  const startBeat = Math.max(1, Math.ceil(map.secondsToTick(visibleStartSeconds) / resolution));
  const endBeat = Math.floor(map.secondsToTick(visibleEndSeconds) / resolution);
  context.textAlign = "left";
  for (let beat = startBeat; beat <= endBeat; beat++) {
    context.fillText(String(beat), stageRight() + markerSize / 2, secondsToY(map.tickToSeconds(beat * resolution)));
  }

  for (const tempo of props.project.tempos) {
    const y = secondsToY(map.tickToSeconds(tempo.tick));
    if (y < 0 || y > cssHeight.value) continue;
    context.strokeStyle = "rgb(255 0 255 / 0.5)";
    context.beginPath();
    context.moveTo(stageLeft(), Math.round(y) + 0.5);
    context.lineTo(stageRight(), Math.round(y) + 0.5);
    context.stroke();
    context.fillStyle = "#f0f";
    context.font = `500 ${markerSize}px ${markerFont}`;
    context.textAlign = "left";
    context.fillText(String(Number(tempo.bpm.toFixed(3))), stageRight() + markerSize / 2, y);
  }
  context.restore();
};

const flickRenderKind = (direction: NoteDirection): RenderNoteKind => {
  if (direction === "left") return "flick-left";
  if (direction === "right") return "flick-right";
  return "flick";
};

const singleRenderKind = (note: Pick<DisplayPoint, "type" | "direction">): RenderNoteKind => {
  if (note.type === "flick" || (note.type === "trace" && note.direction !== "none")) {
    return flickRenderKind(note.direction);
  }
  if (note.type === "trace") return "trace";
  return "tap";
};

const lineRenderKind = (
  note: Pick<DisplayPoint, "type" | "direction">,
  lineKind: "long" | "guide",
  index: number,
  count: number,
): RenderNoteKind => {
  const first = index === 0;
  const last = index === count - 1;
  if (note.type === "flick" || (note.type === "trace" && note.direction !== "none")) {
    return flickRenderKind(note.direction);
  }
  if (note.type === "trace" && lineKind === "guide") return "trace";
  if (lineKind === "guide") return "guide";
  if (lineKind === "long") {
    if (first) return "slide-start";
    if (last) return "slide-end";
    return "slide-node";
  }
  return "tap";
};

const renderDirection = (direction: NoteDirection, kind: RenderNoteKind): RenderDirection => {
  if (direction !== "none") return direction;
  return kind.startsWith("flick") ? "up" : "none";
};

type LineEase = "linear" | "in" | "out" | undefined;

const easeProgress = (ease: LineEase, progress: number): number => {
  if (ease === "in") return progress * progress;
  if (ease === "out") return (2 - progress) * progress;
  return progress;
};

const interpolateBoundary = (from: number, to: number, progress: number, ease: LineEase): number =>
  from + (to - from) * easeProgress(ease, progress);

type RibbonStyle = ReturnType<typeof createChartCanvasRibbonStyle>;

const drawConnector = (
  context: CanvasRenderingContext2D,
  options: {
    headLeft: number;
    headRight: number;
    headY: number;
    tailLeft: number;
    tailRight: number;
    tailY: number;
    leftEase?: LineEase;
    rightEase?: LineEase;
    style: RibbonStyle;
  },
): void => {
  const steps = Math.max(2, Math.ceil(Math.abs(options.tailY - options.headY) / 8));
  const samples: ChartCanvasRibbonSample[] = [];
  for (let step = 0; step <= steps; step++) {
    const progress = step / steps;
    samples.push({
      left: interpolateBoundary(options.headLeft, options.tailLeft, progress, options.leftEase),
      right: interpolateBoundary(options.headRight, options.tailRight, progress, options.rightEase),
      y: options.headY + (options.tailY - options.headY) * progress,
    });
  }
  drawChartCanvasRibbon(context, samples, options.style, props.presentation.longAlpha);
};

const drawNote = (
  context: CanvasRenderingContext2D,
  note: DisplayPoint,
  options: { kind?: RenderNoteKind; registerHit?: boolean } = {},
): void => {
  const position = itemDisplayPosition(note.id, note.tick, note.lane);
  const y = secondsToY(tempoMap.value.tickToSeconds(position.tick));
  if (y < -28 || y > cssHeight.value + 28) return;
  const kind = options.kind ?? singleRenderKind(note);
  const selected = selectedSet.value.has(note.id);
  const width = Math.max(0, note.size * lanePixels());
  const left = laneToX(position.lane);
  const centerX = left + width / 2;
  const editorStageWidth = Math.max(0.001, stageWidth());
  const presentation = props.presentation;
  const previewBodyHeight = canvasSkin?.flatNoteBodyHeight(kind, presentation.stageWidth, presentation.noteScale);
  const noteScale =
    (previewBodyHeight === undefined
      ? undefined
      : canvasSkin?.scaleForFlatNoteBodyHeight(editorStageWidth, previewBodyHeight, kind)) ??
    (presentation.noteScale * presentation.stageWidth) / editorStageWidth;

  context.save();
  context.globalAlpha *= note.visible ? 1 : 0.25;
  canvasSkin?.drawFlatNote(context, {
    kind,
    direction: renderDirection(note.direction, kind),
    centerX,
    centerY: y,
    width,
    laneSpan: (Math.max(0, note.size) * 24) / laneBasis.value,
    stageWidth: editorStageWidth,
    scale: noteScale,
  });
  context.restore();

  if (options.registerHit !== false) {
    const visualHeight = canvasSkin?.flatNoteBodyHeight(kind, editorStageWidth, noteScale) ?? 0;
    const hitHeight = Math.max(NOTE_POINTER_HIT_HEIGHT, visualHeight);
    const hitWidth = Math.max(width, hitHeight);
    hitRegions.push({
      id: note.id,
      x1: centerX - hitWidth / 2,
      x2: centerX + hitWidth / 2,
      y1: y - hitHeight / 2,
      y2: y + hitHeight / 2,
    });
    const selectionHeight = visualHeight + NOTE_SELECTION_PADDING * 2;
    const selectionWidth = Math.max(6, width) + NOTE_SELECTION_PADDING * 2;
    const selectionRegion = {
      id: note.id,
      x1: centerX - selectionWidth / 2,
      x2: centerX + selectionWidth / 2,
      y1: y - selectionHeight / 2,
      y2: y + selectionHeight / 2,
    };
    selectionRegions.push(selectionRegion);
    if (selected) selectedRegions.push(selectionRegion);
  }
};

const drawLines = (context: CanvasRenderingContext2D): void => {
  const styles: Record<ChartCanvasRibbonKind, RibbonStyle> = {
    guide: createChartCanvasRibbonStyle(context, "guide", cssHeight.value, props.presentation.laneWidth),
    slide: createChartCanvasRibbonStyle(context, "slide", cssHeight.value, props.presentation.laneWidth),
  };
  for (const line of props.project.lines) {
    const allPoints = resolveLinePoints(line)
      .map((point) => {
        const position = itemDisplayPosition(point.id, point.tick, point.lane);
        return { ...point, tick: position.tick, lane: position.lane };
      })
      .sort((left, right) => left.tick - right.tick || left.id.localeCompare(right.id));
    if (!allPoints.length) continue;
    const firstAtOrAboveBottom = allPoints.findIndex(
      (point) => secondsToY(tempoMap.value.tickToSeconds(point.tick)) <= cssHeight.value + 120,
    );
    const lastAtOrBelowTopFromEnd = [...allPoints]
      .reverse()
      .findIndex((point) => secondsToY(tempoMap.value.tickToSeconds(point.tick)) >= -120);
    if (firstAtOrAboveBottom < 0 || lastAtOrBelowTopFromEnd < 0) continue;
    const lastAtOrBelowTop = allPoints.length - 1 - lastAtOrBelowTopFromEnd;
    // A segment can cross the entire viewport with both endpoints outside it.
    // Keeping both bridge points avoids culling that still-visible ribbon.
    const visibleStart = Math.min(firstAtOrAboveBottom, lastAtOrBelowTop);
    const visibleEnd = Math.max(firstAtOrAboveBottom, lastAtOrBelowTop);
    const points = allPoints.slice(Math.max(0, visibleStart - 1), Math.min(allPoints.length, visibleEnd + 2));
    const pointIndices = new Map(allPoints.map((point, index) => [point.id, index]));
    for (let index = 0; index < points.length - 1; index++) {
      const head = points[index];
      const tail = points[index + 1];
      if (!head || !tail) continue;
      drawConnector(context, {
        headLeft: laneToX(head.lane),
        headRight: laneToX(head.lane + head.size),
        headY: secondsToY(tempoMap.value.tickToSeconds(head.tick)),
        tailLeft: laneToX(tail.lane),
        tailRight: laneToX(tail.lane + tail.size),
        tailY: secondsToY(tempoMap.value.tickToSeconds(tail.tick)),
        leftEase: head.ease?.left,
        rightEase: head.ease?.right,
        style: styles[line.kind === "guide" ? "guide" : "slide"],
      });
    }

    for (const point of points) {
      drawNote(context, point, {
        kind: lineRenderKind(point, line.kind, pointIndices.get(point.id) ?? 0, allPoints.length),
      });
    }
  }
};

const drawSingles = (context: CanvasRenderingContext2D): void => {
  for (const note of props.project.singles) {
    const position = itemDisplayPosition(note.id, note.tick, note.lane);
    drawNote(context, {
      id: note.id,
      tick: position.tick,
      lane: position.lane,
      size: note.size,
      type: note.type,
      critical: note.critical,
      direction: note.direction,
      visible: note.visible,
    });
  }
};

const drawDraftHold = (context: CanvasRenderingContext2D): void => {
  const start = props.draftHoldStart;
  if (!start) return;
  const end = hoverDraft.value ?? start;
  const lineKind = normalizedTool().includes("guide") ? "guide" : "long";
  const points = [start, end];
  context.save();
  context.globalAlpha *= 0.5;
  drawConnector(context, {
    headLeft: laneToX(start.lane),
    headRight: laneToX(start.lane + start.size),
    headY: secondsToY(tempoMap.value.tickToSeconds(start.tick)),
    tailLeft: laneToX(end.lane),
    tailRight: laneToX(end.lane + end.size),
    tailY: secondsToY(tempoMap.value.tickToSeconds(end.tick)),
    leftEase: "linear",
    rightEase: "linear",
    style: createChartCanvasRibbonStyle(
      context,
      lineKind === "guide" ? "guide" : "slide",
      cssHeight.value,
      props.presentation.laneWidth,
    ),
  });
  points.forEach((point, index) => {
    const kind = lineRenderKind({ type: "tap", direction: "none" }, lineKind, index, points.length);
    drawNote(
      context,
      {
        id: `canvas-draft-hold-${index}`,
        ...point,
        type: "tap",
        critical: props.critical,
        direction: "none",
        visible: true,
      },
      { kind, registerHit: false },
    );
  });
  context.restore();
};

const drawCursorPreview = (context: CanvasRenderingContext2D): void => {
  const draft = hoverDraft.value;
  if (!draft || !isSingleCreationTool()) return;
  context.save();
  context.globalAlpha = 0.5;
  drawNote(
    context,
    {
      id: "canvas-cursor-preview",
      ...draft,
      type: creationType(),
      critical: props.critical || normalizedTool().includes("critical"),
      direction: creationType() === "flick" ? props.direction : "none",
      visible: true,
    },
    { registerHit: false },
  );
  context.restore();
};

const drawPlayhead = (context: CanvasRenderingContext2D): void => {
  const y = secondsToY(props.playheadSeconds);
  if (y < -10 || y > cssHeight.value + 10) return;
  context.save();
  context.strokeStyle = "#fff";
  context.lineWidth = 2;
  context.beginPath();
  context.moveTo(stageLeft(), Math.round(y) + 0.5);
  context.lineTo(stageRight(), Math.round(y) + 0.5);
  context.stroke();
  context.restore();
};

const drawSelectedHitboxes = (context: CanvasRenderingContext2D): void => {
  context.save();
  context.strokeStyle = "#fff";
  context.globalAlpha = 0.5;
  context.lineWidth = 1;
  context.setLineDash([6, 4]);
  for (const region of selectedRegions) {
    context.strokeRect(region.x1, region.y1, region.x2 - region.x1, region.y2 - region.y1);
  }
  context.restore();
};

const drawMarquee = (context: CanvasRenderingContext2D): void => {
  const value = marquee.value;
  if (!value) return;
  const x = Math.min(value.startX, value.currentX);
  const y = Math.min(value.startY, value.currentY);
  const width = Math.abs(value.currentX - value.startX);
  const height = Math.abs(value.currentY - value.startY);
  context.save();
  context.fillStyle = "#fff";
  context.globalAlpha = 0.25;
  context.fillRect(x, y, width, height);
  context.globalAlpha = 0.5;
  context.strokeStyle = "#fff";
  context.lineWidth = 1;
  context.setLineDash([6, 4]);
  context.strokeRect(x, y, width, height);
  context.restore();
};

const drawHover = (context: CanvasRenderingContext2D): void => {
  if (hoverSeconds.value === null) return;
  const y = secondsToY(hoverSeconds.value);
  if (y < 0 || y > cssHeight.value) return;
  context.save();
  context.strokeStyle = "#fff";
  context.globalAlpha = 0.5;
  context.lineWidth = 1;
  context.setLineDash([6, 4]);
  context.beginPath();
  context.moveTo(stageLeft(), y);
  context.lineTo(stageRight(), y);
  context.stroke();
  context.restore();
};

let drawFrame = 0;
const draw = (): void => {
  drawFrame = 0;
  const element = canvas.value;
  if (!element || cssWidth.value <= 1 || cssHeight.value <= 1) return;
  const context = element.getContext("2d");
  if (!context) return;
  context.setTransform(dpr.value, 0, 0, dpr.value, 0, 0);
  context.clearRect(0, 0, cssWidth.value, cssHeight.value);
  hitRegions.length = 0;
  selectionRegions.length = 0;
  selectedRegions.length = 0;
  drawTrack(context);
  drawWaveform(context);
  drawGrid(context);
  drawPlayhead(context);
  drawLines(context);
  drawSingles(context);
  drawDraftHold(context);
  drawCursorPreview(context);
  drawSelectedHitboxes(context);
  drawMarquee(context);
  drawHover(context);
};

const scheduleDraw = (): void => {
  if (drawFrame || typeof window === "undefined") return;
  drawFrame = window.requestAnimationFrame(draw);
};

const resizeCanvas = (): void => {
  const host = wrapper.value;
  const element = canvas.value;
  if (!host || !element) return;
  const bounds = host.getBoundingClientRect();
  if (bounds.width < 1 || bounds.height < 1) return;
  const nextDpr = clamp(window.devicePixelRatio || 1, 1, 3);
  cssWidth.value = bounds.width;
  cssHeight.value = bounds.height;
  dpr.value = nextDpr;
  element.width = Math.max(1, Math.round(bounds.width * nextDpr));
  element.height = Math.max(1, Math.round(bounds.height * nextDpr));
  element.style.width = `${bounds.width}px`;
  element.style.height = `${bounds.height}px`;
  scheduleDraw();
};

const canvasPoint = (event: PointerEvent | WheelEvent): { x: number; y: number } => {
  const bounds = canvas.value?.getBoundingClientRect();
  if (!bounds) return { x: 0, y: 0 };
  return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
};

const hitTest = (x: number, y: number): HitRegion | undefined => {
  for (let index = hitRegions.length - 1; index >= 0; index--) {
    const region = hitRegions[index]!;
    if (x >= region.x1 && x <= region.x2 && y >= region.y1 && y <= region.y2) return region;
  }
  return undefined;
};

const normalizedTool = (): string => props.tool.trim().toLowerCase();
const isPanTool = (): boolean => normalizedTool() === "pan" || normalizedTool() === "hand";
const isEraserTool = (): boolean => ["erase", "eraser", "delete"].includes(normalizedTool());
const isSelectTool = (): boolean => ["select", "selection", "cursor"].includes(normalizedTool());
const isLineTool = (): boolean => ["long", "hold", "guide"].some((tool) => normalizedTool().includes(tool));
const isSingleCreationTool = (): boolean =>
  ["tap", "flick", "trace", "critical"].some((tool) => normalizedTool().includes(tool));
const creationType = (): NoteType => {
  const tool = normalizedTool();
  if (tool.includes("flick")) return "flick";
  if (tool.includes("trace")) return "trace";
  return "tap";
};

const pointDraft = (x: number, y: number): EditorPointDraft => {
  const size = Math.max(0, Number.isFinite(props.noteSize) ? props.noteSize : 2);
  const rawLane = xToLane(x) - size / 2;
  const minimumLane = 0;
  const maximumLane = Math.floor(laneBasis.value - size);
  const lane = clamp(Math.round(rawLane), minimumLane, Math.max(minimumLane, maximumLane));
  const rawTick = tempoMap.value.secondsToTick(yToSeconds(y));
  return {
    tick: Math.max(
      0,
      snapTick(rawTick, Math.max(1, Math.round(props.snapDivision)), "nearest", props.project.resolution),
    ),
    lane,
    size,
  };
};

const clampViewStart = (start: number, pixelsPerSecond: number): number => {
  const visibleDuration = cssHeight.value / Math.max(1, pixelsPerSecond);
  return clamp(
    start,
    timelineBounds.value.minimum,
    Math.max(timelineBounds.value.minimum, timelineBounds.value.maximum - Math.min(visibleDuration, 1)),
  );
};

const updateView = (startSeconds: number, pixelsPerSecond: number): void => {
  const bounds = viewScaleBounds();
  const safePixels = clamp(pixelsPerSecond, bounds.minimum, bounds.maximum);
  const safeStart = clampViewStart(startSeconds, safePixels);
  transientViewStart.value = safeStart;
  transientPixelsPerSecond.value = safePixels;
  emit("view-change", { startSeconds: safeStart, pixelsPerSecond: safePixels });
  scheduleDraw();
};

type PointerAction =
  | {
      type: "pan";
      pointerId: number;
      startY: number;
      viewStart: number;
    }
  | {
      type: "seek";
      pointerId: number;
    }
  | {
      type: "drag";
      pointerId: number;
      startX: number;
      startY: number;
      originals: MoveItem[];
      moved: boolean;
      requestProperties: boolean;
      movementThreshold: number;
    }
  | {
      type: "marquee";
      pointerId: number;
      startX: number;
      startY: number;
      baseIds: string[];
      moved: boolean;
      movementThreshold: number;
    }
  | {
      type: "create";
      pointerId: number;
      startX: number;
      startY: number;
    }
  | {
      type: "erase";
      pointerId: number;
      erased: Set<string>;
    };

const pointerAction = ref<PointerAction | null>(null);

interface TouchPoint {
  x: number;
  y: number;
}

const touchPoints = new Map<number, TouchPoint>();
let suppressTouchesUntilClear = false;
let pinchStart:
  | {
      distance: number;
      centerY: number;
      pixelsPerSecond: number;
      anchorSeconds: number;
    }
  | undefined;

const touchPair = (): [TouchPoint, TouchPoint] | undefined => {
  const points = [...touchPoints.values()];
  return points.length >= 2 && points[0] && points[1] ? [points[0], points[1]] : undefined;
};

const beginPinch = (): void => {
  const pair = touchPair();
  if (!pair) return;
  const [first, second] = pair;
  const distance = Math.max(8, Math.hypot(second.x - first.x, second.y - first.y));
  const centerY = (first.y + second.y) / 2;
  pinchStart = {
    distance,
    centerY,
    pixelsPerSecond: effectivePixelsPerSecond(),
    anchorSeconds: yToSeconds(centerY),
  };
  pointerAction.value = null;
  dragPreview.value = null;
  marquee.value = null;
  suppressTouchesUntilClear = true;
  scheduleDraw();
};

const updatePinch = (): void => {
  const pair = touchPair();
  if (!pair || !pinchStart) return;
  const [first, second] = pair;
  const distance = Math.max(8, Math.hypot(second.x - first.x, second.y - first.y));
  const centerY = (first.y + second.y) / 2;
  const bounds = viewScaleBounds();
  const pixelsPerSecond = clamp(
    pinchStart.pixelsPerSecond * (distance / pinchStart.distance),
    bounds.minimum,
    bounds.maximum,
  );
  updateView(pinchStart.anchorSeconds - (cssHeight.value - centerY) / pixelsPerSecond, pixelsPerSecond);
};

const deleteAtPoint = (x: number, y: number, erased: Set<string>): void => {
  const region = hitTest(x, y);
  if (!region || erased.has(region.id)) return;
  erased.add(region.id);
  emit("delete", { ids: [region.id] });
};

const seekAtY = (y: number): void => {
  const maximum = Math.max(props.audioDuration, props.waveform?.duration ?? 0, 0);
  const seconds = maximum > 0 ? clamp(yToSeconds(y), 0, maximum) : Math.max(0, yToSeconds(y));
  emit("seek", seconds);
};

const onPointerDown = (event: PointerEvent): void => {
  const element = canvas.value;
  if (!element) return;
  element.focus({ preventScroll: true });
  const point = canvasPoint(event);
  if (event.button !== 0 && event.button !== 1) return;
  if (event.pointerType === "touch") {
    touchPoints.set(event.pointerId, point);
    if (touchPoints.size >= 2) {
      element.setPointerCapture(event.pointerId);
      beginPinch();
      event.preventDefault();
      return;
    }
    if (suppressTouchesUntilClear) return;
  }
  element.setPointerCapture(event.pointerId);
  event.preventDefault();

  if (event.button === 1 || isPanTool()) {
    pointerAction.value = {
      type: "pan",
      pointerId: event.pointerId,
      startY: point.y,
      viewStart: effectiveViewStart(),
    };
    return;
  }

  if (point.x < trackLeft()) {
    pointerAction.value = { type: "seek", pointerId: event.pointerId };
    seekAtY(point.y);
    return;
  }

  if (isEraserTool()) {
    const erased = new Set<string>();
    pointerAction.value = { type: "erase", pointerId: event.pointerId, erased };
    deleteAtPoint(point.x, point.y, erased);
    return;
  }

  const hit = hitTest(point.x, point.y);
  if (isSelectTool()) {
    if (!hit) {
      const modifiesSelection = event.shiftKey || event.metaKey || event.ctrlKey;
      pointerAction.value = {
        type: "marquee",
        pointerId: event.pointerId,
        startX: point.x,
        startY: point.y,
        baseIds: modifiesSelection ? [...props.selectedIds] : [],
        moved: false,
        movementThreshold: event.pointerType === "touch" ? 18 : 4,
      };
      marquee.value = { startX: point.x, startY: point.y, currentX: point.x, currentY: point.y };
      scheduleDraw();
      return;
    }
    const current = new Set(props.selectedIds);
    const modifiesSelection = event.shiftKey || event.metaKey || event.ctrlKey;
    const requestProperties = current.has(hit.id) && !modifiesSelection;
    if (modifiesSelection) {
      if (current.has(hit.id)) current.delete(hit.id);
      else current.add(hit.id);
    } else if (!current.has(hit.id)) {
      current.clear();
      current.add(hit.id);
    }
    const ids = [...current];
    emit("select", { ids });
    if (!current.has(hit.id)) return;
    const positions = allEntityPositions();
    const originals = ids.map((id) => positions.get(id)).filter((item): item is MoveItem => Boolean(item));
    pointerAction.value = {
      type: "drag",
      pointerId: event.pointerId,
      startX: point.x,
      startY: point.y,
      originals,
      moved: false,
      requestProperties,
      movementThreshold: event.pointerType === "touch" ? 18 : 3,
    };
    return;
  }

  if ((isLineTool() || isSingleCreationTool()) && (point.x < stageLeft() || point.x > stageRight())) return;

  pointerAction.value = {
    type: "create",
    pointerId: event.pointerId,
    startX: point.x,
    startY: point.y,
  };
  hoverDraft.value = pointDraft(point.x, point.y);
  scheduleDraw();
};

const onPointerMove = (event: PointerEvent): void => {
  const point = canvasPoint(event);
  hoverSeconds.value = Math.max(0, yToSeconds(point.y));
  scheduleDraw();
  if (event.pointerType === "touch" && touchPoints.has(event.pointerId)) {
    touchPoints.set(event.pointerId, point);
    if (touchPoints.size >= 2) {
      updatePinch();
      event.preventDefault();
      return;
    }
  }
  if ((isLineTool() || isSingleCreationTool()) && point.x >= stageLeft() && point.x <= stageRight()) {
    hoverDraft.value = pointDraft(point.x, point.y);
    scheduleDraw();
  } else if (hoverDraft.value) {
    hoverDraft.value = null;
    scheduleDraw();
  }
  const action = pointerAction.value;
  if (!action || action.pointerId !== event.pointerId) return;
  event.preventDefault();
  if (action.type === "pan") {
    const next = panVerticalTimeViewport(
      {
        startSeconds: action.viewStart,
        pixelsPerSecond: effectivePixelsPerSecond(),
        height: cssHeight.value,
      },
      point.y - action.startY,
    );
    updateView(next.startSeconds, next.pixelsPerSecond);
  } else if (action.type === "seek") {
    seekAtY(point.y);
  } else if (action.type === "erase") {
    deleteAtPoint(point.x, point.y, action.erased);
  } else if (action.type === "marquee") {
    action.moved ||=
      Math.abs(point.x - action.startX) > action.movementThreshold ||
      Math.abs(point.y - action.startY) > action.movementThreshold;
    if (marquee.value) {
      marquee.value = { ...marquee.value, currentX: point.x, currentY: point.y };
      scheduleDraw();
    }
  } else if (action.type === "drag") {
    const laneDelta = constrainLaneDelta(action.originals, Math.round(xToLane(point.x) - xToLane(action.startX)));
    const pointerTick = snapTick(
      tempoMap.value.secondsToTick(yToSeconds(point.y)),
      Math.max(1, Math.round(props.snapDivision)),
      "nearest",
      props.project.resolution,
    );
    const startPointerTick = snapTick(
      tempoMap.value.secondsToTick(yToSeconds(action.startY)),
      Math.max(1, Math.round(props.snapDivision)),
      "nearest",
      props.project.resolution,
    );
    const tickDelta = pointerTick - startPointerTick;
    action.moved ||=
      Math.abs(point.x - action.startX) > action.movementThreshold ||
      Math.abs(point.y - action.startY) > action.movementThreshold;
    if (!action.moved) return;
    const preview = new Map<string, MoveItem>();
    for (const item of action.originals) {
      preview.set(item.id, {
        id: item.id,
        tick: Math.max(0, item.tick + tickDelta),
        lane: item.lane + laneDelta,
      });
    }
    dragPreview.value = preview;
    scheduleDraw();
  }
};

const onPointerLeave = (): void => {
  if (pointerAction.value || props.draftHoldStart) return;
  hoverDraft.value = null;
  hoverSeconds.value = null;
  scheduleDraw();
};

const finishCreate = (point: { x: number; y: number }): void => {
  const draft = pointDraft(point.x, point.y);
  if (isLineTool()) {
    const start = props.draftHoldStart;
    if (!start) {
      emit("draft-hold", draft);
      return;
    }
    if (start.tick === draft.tick) return;
    const ordered = start.tick <= draft.tick ? { start, end: draft } : { start: draft, end: start };
    emit("create-hold", {
      kind: normalizedTool().includes("guide") ? "guide" : "long",
      ...ordered,
    });
    emit("draft-hold", null);
    return;
  }
  emit("create-single", {
    ...draft,
    type: creationType(),
    critical: props.critical || normalizedTool().includes("critical"),
    direction: creationType() === "flick" ? props.direction : "none",
  });
};

const onPointerUp = (event: PointerEvent): void => {
  if (event.pointerType === "touch") {
    touchPoints.delete(event.pointerId);
    if (touchPoints.size < 2) pinchStart = undefined;
    if (touchPoints.size === 0) suppressTouchesUntilClear = false;
    if (suppressTouchesUntilClear) {
      pointerAction.value = null;
      dragPreview.value = null;
      marquee.value = null;
      scheduleDraw();
      return;
    }
  }
  const action = pointerAction.value;
  if (!action || action.pointerId !== event.pointerId) return;
  const point = canvasPoint(event);
  if (action.type === "drag" && action.moved && dragPreview.value?.size) {
    emit("move", { items: [...dragPreview.value.values()], commit: true });
  } else if (action.type === "drag" && action.requestProperties) {
    emit("request-properties");
  } else if (action.type === "marquee") {
    const ids = new Set(action.baseIds);
    if (action.moved) {
      const x1 = Math.min(action.startX, point.x);
      const x2 = Math.max(action.startX, point.x);
      const y1 = Math.min(action.startY, point.y);
      const y2 = Math.max(action.startY, point.y);
      for (const region of selectionRegions) {
        if (region.x2 >= x1 && region.x1 <= x2 && region.y2 >= y1 && region.y1 <= y2) ids.add(region.id);
      }
    }
    emit("select", { ids: [...ids] });
  } else if (action.type === "create") {
    const distance = Math.hypot(point.x - action.startX, point.y - action.startY);
    if (distance <= 8) finishCreate(point);
  }
  pointerAction.value = null;
  dragPreview.value = null;
  marquee.value = null;
  scheduleDraw();
};

const onPointerCancel = (event: PointerEvent): void => {
  touchPoints.delete(event.pointerId);
  if (!touchPoints.size) {
    pinchStart = undefined;
    suppressTouchesUntilClear = false;
  }
  if (pointerAction.value?.pointerId === event.pointerId) pointerAction.value = null;
  dragPreview.value = null;
  marquee.value = null;
  scheduleDraw();
};

const onWheel = (event: WheelEvent): void => {
  event.preventDefault();
  const point = canvasPoint(event);
  const modeScale =
    event.deltaMode === WheelEvent.DOM_DELTA_LINE
      ? 18
      : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
        ? cssHeight.value
        : 1;
  const delta = event.deltaY * modeScale;
  if (event.ctrlKey || event.metaKey) {
    const oldPixels = effectivePixelsPerSecond();
    const bounds = viewScaleBounds();
    const nextPixels = clamp(oldPixels * Math.exp(-delta * 0.002), bounds.minimum, bounds.maximum);
    const next = zoomVerticalTimeViewportAtY(timeViewport(), nextPixels, point.y);
    updateView(next.startSeconds, next.pixelsPerSecond);
  } else {
    const next = scrollVerticalTimeViewport(timeViewport(), delta);
    updateView(next.startSeconds, next.pixelsPerSecond);
  }
};

const moveSelectionByKeyboard = (tickDelta: number, laneDelta: number): void => {
  if (!props.selectedIds.length) return;
  const positions = allEntityPositions();
  const originals = props.selectedIds.map((id) => positions.get(id)).filter((item): item is MoveItem => Boolean(item));
  const boundedLaneDelta = constrainLaneDelta(originals, laneDelta);
  const items = originals.map((item) => ({
    id: item.id,
    tick: Math.max(0, item.tick + tickDelta),
    lane: item.lane + boundedLaneDelta,
  }));
  if (items.length) emit("move", { items, commit: true });
};

const onKeyDown = (event: KeyboardEvent): void => {
  if (event.key === "Delete") {
    if (props.selectedIds.length) emit("delete", { ids: [...props.selectedIds] });
    event.preventDefault();
    return;
  }
  if (event.key === "Escape") {
    if (props.draftHoldStart) emit("draft-hold", null);
    else emit("select", { ids: [] });
    pointerAction.value = null;
    dragPreview.value = null;
    marquee.value = null;
    event.preventDefault();
    return;
  }
  const tickStep = Math.max(1, Math.round(props.project.resolution / Math.max(1, props.snapDivision)));
  const amount = event.shiftKey ? 4 : 1;
  if (event.key === "ArrowUp") moveSelectionByKeyboard(tickStep * amount, 0);
  else if (event.key === "ArrowDown") moveSelectionByKeyboard(-tickStep * amount, 0);
  else if (event.key === "ArrowLeft") moveSelectionByKeyboard(0, -amount);
  else if (event.key === "ArrowRight") moveSelectionByKeyboard(0, amount);
  else return;
  event.preventDefault();
};

const loadCanvasAtlas = async (assets: OurNotesAssetManifest): Promise<void> => {
  const generation = ++skinLoadGeneration;
  canvasSkin?.dispose();
  canvasSkin = undefined;
  scheduleDraw();
  try {
    const loaded = await loadChartCanvasSkin(assets);
    if (disposed || generation !== skinLoadGeneration) {
      loaded.dispose();
      return;
    }
    canvasSkin = loaded;
    scheduleDraw();
  } catch {
    // Fail closed: native artwork that cannot load is never replaced by a box.
  }
};

let resizeObserver: ResizeObserver | undefined;
onMounted(() => {
  resizeObserver = new ResizeObserver(resizeCanvas);
  if (wrapper.value) resizeObserver.observe(wrapper.value);
  window.addEventListener("resize", resizeCanvas, { passive: true });
  document.addEventListener("visibilitychange", resizeCanvas);
  void nextTick(() => {
    resizeCanvas();
    window.requestAnimationFrame(resizeCanvas);
  });
  if (props.assets) void loadCanvasAtlas(props.assets);
});

onActivated(() => {
  void nextTick(() => {
    resizeCanvas();
    window.requestAnimationFrame(resizeCanvas);
  });
});

onBeforeUnmount(() => {
  disposed = true;
  skinLoadGeneration += 1;
  resizeObserver?.disconnect();
  window.removeEventListener("resize", resizeCanvas);
  document.removeEventListener("visibilitychange", resizeCanvas);
  if (drawFrame) window.cancelAnimationFrame(drawFrame);
  canvasSkin?.dispose();
  canvasSkin = undefined;
});

watch(
  () => props.assets,
  (assets, previousAssets) => {
    if (assets && assets !== previousAssets) void loadCanvasAtlas(assets);
    else if (!assets && previousAssets) {
      skinLoadGeneration += 1;
      canvasSkin?.dispose();
      canvasSkin = undefined;
      scheduleDraw();
    }
  },
  { flush: "post" },
);

watch(
  () => props.project,
  () => scheduleDraw(),
  { deep: true, flush: "post" },
);
watch(
  () => [
    props.waveform,
    props.audioDuration,
    props.snapDivision,
    props.tool,
    props.playheadSeconds,
    props.playing,
    props.draftHoldStart,
    props.presentation,
  ],
  () => scheduleDraw(),
  { flush: "post" },
);
watch(
  () => [...props.selectedIds],
  () => scheduleDraw(),
  { flush: "post" },
);
watch(
  () => [props.viewStartSeconds, props.pixelsPerSecond, props.minPixelsPerSecond, props.maxPixelsPerSecond],
  () => {
    if (pointerAction.value?.type !== "pan" && !pinchStart) {
      transientViewStart.value = null;
      transientPixelsPerSecond.value = null;
    }
    scheduleDraw();
  },
  { flush: "post" },
);
</script>

<template>
  <div
    ref="wrapper"
    class="chart-editor-canvas"
    :class="{
      'chart-editor-canvas--pan': isPanTool(),
      'chart-editor-canvas--panning': pointerAction?.type === 'pan',
      'chart-editor-canvas--eraser': isEraserTool(),
    }"
  >
    <canvas
      ref="canvas"
      class="chart-editor-canvas__surface"
      tabindex="0"
      role="application"
      :aria-label="timelineLabel"
      @contextmenu.prevent
      @keydown="onKeyDown"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerleave="onPointerLeave"
      @pointerup="onPointerUp"
      @pointercancel="onPointerCancel"
      @wheel="onWheel"
    />
  </div>
</template>

<style scoped>
.chart-editor-canvas {
  position: relative;
  width: 100%;
  height: 100%;
  min-height: 30rem;
  overflow: hidden;
  background: #000;
  contain: layout paint;
}

.chart-editor-canvas__surface {
  display: block;
  width: 100%;
  height: 100%;
  cursor: crosshair;
  outline: none;
  touch-action: none;
  user-select: none;
  -webkit-user-select: none;
}

.chart-editor-canvas--pan .chart-editor-canvas__surface {
  cursor: grab;
}

.chart-editor-canvas--panning .chart-editor-canvas__surface {
  cursor: grabbing;
}

.chart-editor-canvas--eraser .chart-editor-canvas__surface {
  cursor: cell;
}

@media (max-width: 720px) {
  .chart-editor-canvas {
    min-height: 26rem;
  }
}
</style>
