import {
  interpolateNoteLine,
  isPairNoteOperateType,
  NoteDirection,
  NoteOperateType,
  type ChartDocument,
  type ChartNote,
  type RenderDirection,
  type RenderNoteKind,
} from "@haneoka/chart";
import type { OurNotesAssetManifest } from "@haneoka/chart/assets";
import { OUR_NOTES_LIVE_GEOMETRY } from "../../../packages/chart/src/assets/manifest";
import {
  createChartCanvasRibbonStyle,
  drawChartCanvasLanePlane,
  drawChartCanvasRibbon,
  loadChartCanvasSkin,
  type ChartCanvasRibbonSample,
  type ChartCanvasSkin,
} from "../../../packages/chart/src/vue/chartCanvasSkin";
import { chartCanvasOverviewPresentation } from "../../../packages/chart/src/vue/overviewModel";

export const loadDetailedOverviewSkin = (assets: OurNotesAssetManifest) => loadChartCanvasSkin(assets);

const kindOf = (note: ChartNote): RenderNoteKind => {
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
};

const directionOf = (note: ChartNote): RenderDirection => {
  if (note.direction === NoteDirection.Left) return "left";
  if (note.direction === NoteDirection.Right) return "right";
  return "up";
};

export function drawDetailedChartOverview(
  canvas: HTMLCanvasElement,
  chart: ChartDocument,
  skin: ChartCanvasSkin,
  viewportHeight: number,
): void {
  const presentation = chartCanvasOverviewPresentation();
  const height = Math.max(360, viewportHeight);
  const panelDuration = (height / presentation.heightPerSecond) * 1000;
  const panelWidth = presentation.laneWidth * 13;
  const panelCount = Math.max(1, Math.ceil(chart.durationMs / panelDuration));
  const width = panelCount * panelWidth;
  const dpr = Math.max(1, Math.min(1.5, devicePixelRatio || 1));
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) return;
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";

  const byId = new Map(chart.notes.map((note) => [note.id, note]));
  const notes = chart.notes
    .filter((note) => note.visible && note.judged)
    .sort((a, b) => a.timeMs - b.timeMs || a.id - b.id);
  const judged = chart.notes.filter((note) => note.judged).sort((a, b) => a.timeMs - b.timeMs || a.id - b.id);
  const pairs = new Map<number, ChartNote[]>();
  notes.forEach((note) => {
    if (!isPairNoteOperateType(note.operateType)) return;
    const group = pairs.get(note.tick) || [];
    group.push(note);
    pairs.set(note.tick, group);
  });
  const simultaneous = [...pairs.values()].flatMap((group) => {
    group.sort((a, b) => a.id - b.id);
    return group.slice(1).map((note, index) => ({ timeMs: note.timeMs, notes: [group[index]!, note] as const }));
  });
  const lines = chart.lines.map((line) => ({
    kind: line.kind,
    nodes: line.noteIds
      .map((id) => byId.get(id))
      .filter((note): note is ChartNote => Boolean(note) && note!.indexInLine !== null)
      .sort((a, b) => a.timeMs - b.timeMs || a.id - b.id),
  }));
  const localX = (scorePosition: number) =>
    panelWidth / 2 +
    ((scorePosition / 24) * presentation.bandCount - presentation.bandCount / 2) * presentation.laneWidth;
  const bounds = (note: Pick<ChartNote, "pos" | "size">) => {
    const a = localX(note.pos);
    const b = localX(note.pos + note.size);
    return { left: Math.min(a, b), right: Math.max(a, b), center: (a + b) / 2 };
  };
  const yAt = (timeMs: number, panel: number) =>
    height - ((timeMs - panel * panelDuration) / 1000) * presentation.heightPerSecond;

  for (let panel = 0; panel < panelCount; panel += 1) {
    const panelStart = panel * panelDuration;
    const panelEnd = (panel + 1) * panelDuration;
    context.save();
    context.translate(panel * panelWidth, 0);
    context.fillStyle = "#000";
    context.fillRect(0, 0, panelWidth, height);
    context.lineWidth = presentation.lineWidth;
    drawChartCanvasLanePlane(context, {
      centerX: panelWidth / 2,
      height,
      laneWidth: presentation.laneWidth,
      styleLaneWidth: presentation.laneWidth,
      bandCount: presentation.bandCount,
      spaceCount: presentation.spaceCount,
    });

    const left = panelWidth / 2 - presentation.stageWidth / 2;
    const right = panelWidth / 2 + presentation.stageWidth / 2;
    context.font = `${presentation.laneWidth}px Arial`;
    context.textBaseline = "middle";
    for (const change of chart.bpmChanges) {
      const next = chart.bpmChanges[chart.bpmChanges.indexOf(change) + 1];
      const start = Math.max(panelStart, change.timeMs);
      const end = Math.min(panelEnd, next?.timeMs ?? Number.POSITIVE_INFINITY);
      if (change.bpm <= 0 || end <= start) continue;
      const beatMs = 60_000 / change.bpm;
      let beat = Math.ceil((change.beat + (start - change.timeMs) / beatMs) * 2) / 2;
      for (let count = 0; count < 2048; count += 1, beat += 0.5) {
        const time = change.timeMs + (beat - change.beat) * beatMs;
        if (time >= end) break;
        context.strokeStyle = Number.isInteger(beat) ? "rgba(128,255,255,.2)" : "rgba(255,128,255,.16)";
        context.setLineDash(Number.isInteger(beat) ? [] : [2.5]);
        context.beginPath();
        context.moveTo(left, yAt(time, panel));
        context.lineTo(right, yAt(time, panel));
        context.stroke();
      }
    }
    context.setLineDash([]);
    context.fillStyle = "rgba(255,255,255,.5)";
    context.textAlign = "right";
    for (let time = Math.ceil(panelStart / 5000) * 5000; time < panelEnd; time += 5000)
      context.fillText(
        `${Math.floor(time / 60000)}:${String(Math.floor((time / 1000) % 60)).padStart(2, "0")}`,
        left - 5,
        yAt(time, panel),
      );
    context.textAlign = "left";
    for (let combo = 50; combo < judged.length; combo += 50) {
      const note = judged[combo];
      if (note && note.timeMs >= panelStart && note.timeMs < panelEnd)
        context.fillText(String(combo), right + 5, yAt(note.timeMs, panel));
    }
    context.fillStyle = "rgba(255,0,255,.5)";
    context.strokeStyle = "rgba(255,0,255,.5)";
    chart.bpmChanges.forEach((change) => {
      if (change.timeMs < panelStart || change.timeMs >= panelEnd || change.bpm <= 0) return;
      const y = yAt(change.timeMs, panel);
      context.fillText(String(change.bpm), right + 5, y);
      context.beginPath();
      context.moveTo(left, y);
      context.lineTo(right, y);
      context.stroke();
    });
    context.strokeStyle = "rgba(255,0,0,.5)";
    chart.timeline.fever.forEach((section) => {
      if (section.startTimeMs >= panelEnd || section.endTimeMs < panelStart) return;
      context.strokeRect(
        right + 10,
        yAt(section.endTimeMs, panel),
        1,
        yAt(section.startTimeMs, panel) - yAt(section.endTimeMs, panel),
      );
    });
    context.fillStyle = "rgba(255,255,0,.6)";
    chart.timeline.skills.forEach((event) => {
      if (event.timeMs < panelStart || event.timeMs >= panelEnd) return;
      const y = yAt(event.timeMs, panel);
      context.fillText(`#${event.index + 1}`, right + 14, y);
    });

    const worldToCss = presentation.stageWidth / OUR_NOTES_LIVE_GEOMETRY.laneWidth;
    const simultaneousHeight = OUR_NOTES_LIVE_GEOMETRY.simultaneousLineSize[1] * worldToCss;
    context.fillStyle = "#fff";
    simultaneous.forEach((entry) => {
      if (entry.timeMs < panelStart || entry.timeMs >= panelEnd) return;
      const a = bounds(entry.notes[0]).center;
      const b = bounds(entry.notes[1]).center;
      context.fillRect(
        Math.min(a, b),
        yAt(entry.timeMs, panel) - simultaneousHeight / 2,
        Math.abs(a - b),
        simultaneousHeight,
      );
    });

    const slideStyle = createChartCanvasRibbonStyle(context, "slide", height, presentation.laneWidth);
    const guideStyle = createChartCanvasRibbonStyle(context, "guide", height, presentation.laneWidth);
    lines.forEach((line) => {
      for (let index = 0; index < line.nodes.length - 1; index += 1) {
        const head = line.nodes[index]!;
        const tail = line.nodes[index + 1]!;
        if (tail.timeMs <= panelStart || head.timeMs >= panelEnd) continue;
        const start = Math.max(head.timeMs, panelStart);
        const end = Math.min(tail.timeMs, panelEnd);
        const steps = Math.max(2, Math.ceil((end - start) / 50));
        const samples: ChartCanvasRibbonSample[] = [];
        for (let step = 0; step <= steps; step += 1) {
          const time = start + ((end - start) * step) / steps;
          const shape = interpolateNoteLine(head, tail, time);
          samples.push({ left: localX(shape.pos), right: localX(shape.pos + shape.size), y: yAt(time, panel) });
        }
        drawChartCanvasRibbon(
          context,
          samples,
          line.kind === "guide" ? guideStyle : slideStyle,
          presentation.longAlpha,
        );
      }
    });
    notes.forEach((note) => {
      if (note.timeMs < panelStart || note.timeMs >= panelEnd) return;
      const noteBounds = bounds(note);
      skin.drawFlatNote(context, {
        kind: kindOf(note),
        direction: directionOf(note),
        centerX: noteBounds.center,
        centerY: yAt(note.timeMs, panel),
        width: Math.max(0.5, (noteBounds.right - noteBounds.left) * presentation.noteScale),
        laneSpan: note.size,
        stageWidth: presentation.stageWidth,
        scale: presentation.noteScale,
      });
    });
    context.restore();
  }
}
