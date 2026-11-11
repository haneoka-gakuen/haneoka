// L3 — GEB
// Input: Immutable chart, native canvas skin, website fonts, viewport and optional highlighted time range.
// Output: Lane-clipped flat-chart panels, pointer timing/count data or a numbered timing excerpt.
// Pos: [Map](L2-2.md); shared flat rendering for the player and team-builder timing guide.
// Effects/Dependencies: Caches geometry by chart identity and draws the supplied canvas with Cassiopeia primitives.
import {
  interpolateNoteLine,
  isPairNoteOperateType,
  NoteDirection,
  NoteOperateType,
  type ChartDocument,
  type ChartNote,
} from "@haneoka/cassiopeia";
import type { OurNotesAssetManifest } from "@haneoka/cassiopeia-plugin-our-notes";
import {
  OUR_NOTES_LIVE_GEOMETRY,
  type RenderDirection,
  type RenderNoteKind,
} from "@haneoka/cassiopeia-plugin-our-notes";
import {
  createChartCanvasRibbonStyle,
  drawChartCanvasLanePlane,
  drawChartCanvasRibbon,
  loadChartCanvasSkin,
  type ChartCanvasRibbonSample,
  type ChartCanvasSkin,
} from "@haneoka/cassiopeia-ui-vue/overview";
import { chartCanvasOverviewPresentation } from "@haneoka/cassiopeia-ui-vue/overview";

export const loadDetailedOverviewSkin = (assets: OurNotesAssetManifest) => loadChartCanvasSkin(assets);

export function chartCanvasFontFamily(locale = document.documentElement.lang): string {
  const inherited = getComputedStyle(document.documentElement).getPropertyValue("--app-font").trim();
  if (inherited) return inherited;
  const preferred = ({ "zh-CN": "SC", "zh-TW": "TC", ko: "KR", ja: "JP" } as Record<string, string>)[locale] ?? "JP";
  return `"Roboto Variable", "Noto Sans ${preferred} Variable", sans-serif`;
}

export async function loadChartCanvasFonts(locale?: string, sample = "0123456789:. #") {
  const family = chartCanvasFontFamily(locale);
  await Promise.allSettled([400, 500, 700].map(weight => document.fonts.load(`${weight} 12px ${family}`, sample)));
  return family;
}

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

/** Per-kind totals over the judged notes shown in the simple overview. */
export const countNoteKinds = (chart: ChartDocument): { tap: number; flick: number; slide: number } => {
  const counts = { tap: 0, flick: 0, slide: 0 };
  for (const note of chart.notes) {
    if (!note.visible || !note.judged) continue;
    const kind = kindOf(note);
    if (kind === "tap") counts.tap += 1;
    else if (kind === "flick" || kind === "flick-left" || kind === "flick-right") counts.flick += 1;
    else counts.slide += 1;
  }
  return counts;
};

type OverviewGeometry = {
  notes: ChartNote[];
  judged: ChartNote[];
  simultaneous: { timeMs: number; notes: readonly [ChartNote, ChartNote] }[];
  lines: { kind: ChartDocument["lines"][number]["kind"]; nodes: ChartNote[] }[];
};
const overviewGeometry = new WeakMap<ChartDocument, OverviewGeometry>();
function prepareOverviewGeometry(chart: ChartDocument): OverviewGeometry {
  const known = overviewGeometry.get(chart);
  if (known) return known;
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
  const prepared = { notes, judged, simultaneous, lines };
  overviewGeometry.set(chart, prepared);
  return prepared;
}
function firstAtTime(notes: readonly { timeMs: number }[], timeMs: number, inclusive = false): number {
  let low = 0, high = notes.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (notes[middle]!.timeMs < timeMs || inclusive && notes[middle]!.timeMs === timeMs) low = middle + 1;
    else high = middle;
  }
  return low;
}

export function chartOverviewLayout(durationMs: number, viewportHeight: number, chartZoom = 1) {
  const presentation = chartCanvasOverviewPresentation(chartZoom);
  const height = Math.max(360, viewportHeight);
  const panelDuration = (height / presentation.heightPerSecond) * 1000;
  const panelWidth = presentation.laneWidth * 13;
  const panelCount = Math.max(1, Math.ceil(durationMs / panelDuration));
  return { height, panelDuration, panelWidth, panelCount, width: panelCount * panelWidth, stageWidth: presentation.stageWidth };
}

export function chartOverviewPoint(chart: ChartDocument, viewportHeight: number, x: number, y: number) {
  const layout = chartOverviewLayout(chart.durationMs, viewportHeight);
  const panel = Math.max(0, Math.min(layout.panelCount - 1, Math.floor(x / layout.panelWidth)));
  const timeMs = Math.round(Math.max(0, Math.min(chart.durationMs, panel * layout.panelDuration
    + (layout.height - Math.max(0, Math.min(layout.height, y))) / layout.height * layout.panelDuration)));
  return { panel, timeMs, combo: firstAtTime(prepareOverviewGeometry(chart).judged, timeMs, true) };
}

export function drawDetailedChartOverview(
  canvas: HTMLCanvasElement,
  chart: ChartDocument,
  skin: ChartCanvasSkin,
  viewportHeight: number,
  excerpt?: {
    startMs: number;
    endMs: number;
    highlights: readonly { timeMs: number; step: number; targets: readonly { timeMs: number; pos: number; size: number }[]; color?: string; selected?: boolean }[];
    labelEachTarget?: boolean;
    zoom?: number;
    color: string;
  },
  panelRange?: { first: number; count: number },
  fontFamily = chartCanvasFontFamily(),
): void {
  const presentation = chartCanvasOverviewPresentation(excerpt?.zoom);
  const startMs = excerpt?.startMs ?? 0;
  const endMs = excerpt?.endMs ?? chart.durationMs;
  const { height, panelDuration, panelWidth, panelCount } = chartOverviewLayout(endMs - startMs, viewportHeight, excerpt?.zoom);
  const firstPanel = panelRange?.first ?? 0;
  const lastPanel = Math.min(panelCount, firstPanel + (panelRange?.count ?? panelCount));
  const width = (lastPanel - firstPanel) * panelWidth;
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

  const { notes, judged, simultaneous, lines } = prepareOverviewGeometry(chart);
  const localX = (scorePosition: number) =>
    panelWidth / 2 +
    ((scorePosition / 24) * presentation.bandCount - presentation.bandCount / 2) * presentation.laneWidth;
  const bounds = (note: Pick<ChartNote, "pos" | "size">) => {
    const a = localX(note.pos);
    const b = localX(note.pos + note.size);
    return { left: Math.min(a, b), right: Math.max(a, b), center: (a + b) / 2 };
  };
  const yAt = (timeMs: number, panel: number) =>
    height - ((timeMs - startMs - panel * panelDuration) / 1000) * presentation.heightPerSecond;

  for (let panel = firstPanel; panel < lastPanel; panel += 1) {
    const panelStart = startMs + panel * panelDuration;
    const panelEnd = excerpt ? Math.min(endMs, startMs + (panel + 1) * panelDuration) : (panel + 1) * panelDuration;
    context.save();
    context.translate((panel - firstPanel) * panelWidth, 0);
    context.beginPath();
    context.rect(0, 0, panelWidth, height);
    context.clip();
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
    context.font = `400 ${presentation.laneWidth}px ${fontFamily}`;
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
    for (let combo = 50; combo <= judged.length; combo += 50) {
      const note = judged[combo - 1];
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

    context.save();
    context.beginPath();
    context.rect(left, 0, right - left, height);
    context.clip();
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

    lines.forEach((line) => {
      if (line.nodes.length < 2 || line.nodes.at(-1)!.timeMs <= panelStart || line.nodes[0]!.timeMs >= panelEnd) return;
      const top = yAt(line.nodes.at(-1)!.timeMs, panel);
      const lineHeight = yAt(line.nodes[0]!.timeMs, panel) - top;
      const style = createChartCanvasRibbonStyle(
        context,
        line.kind === "guide" ? "guide" : "slide",
        lineHeight,
        presentation.laneWidth,
        top,
        skin.slideLineStyle,
      );
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
        drawChartCanvasRibbon(context, samples, style, presentation.longAlpha);
      }
    });
    const firstNote = firstAtTime(notes, panelStart), lastNote = firstAtTime(notes, panelEnd);
    for (let index = firstNote; index < lastNote; index++) {
      const note = notes[index]!;
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
    }
    context.restore();
    if (excerpt) {
      context.strokeStyle = excerpt.color;
      context.fillStyle = excerpt.color;
      context.lineWidth = 2;
      context.font = `700 ${presentation.laneWidth}px ${fontFamily}`;
      context.textAlign = "center";
      for (const highlight of excerpt.highlights) {
        context.strokeStyle = highlight.color ?? excerpt.color;
        context.fillStyle = highlight.color ?? excerpt.color;
        context.lineWidth = highlight.selected ? 4 : 2;
        const marked = highlight.targets.filter(note => note.timeMs >= panelStart && note.timeMs < panelEnd);
        for (const note of marked) {
          const box = bounds(note);
          const y = yAt(note.timeMs, panel);
          context.save();
          context.beginPath(); context.rect(left, 0, right - left, height); context.clip();
          context.strokeRect(box.left - 4, y - presentation.laneWidth / 2 - 4,
            box.right - box.left + 8, presentation.laneWidth + 8);
          context.restore();
          if (excerpt.labelEachTarget) context.fillText(String(highlight.step), (box.left + box.right) / 2,
            y < presentation.laneWidth * 2 ? y + presentation.laneWidth * 1.5 : y - presentation.laneWidth);
        }
        if (marked.length && !excerpt.labelEachTarget) context.fillText(String(highlight.step), right + 18, yAt(highlight.timeMs, panel));
      }
    }
    context.restore();
  }
}
