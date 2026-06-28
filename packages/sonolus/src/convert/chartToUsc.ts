// Convert our internal chart IR (InternalChart / ResolvedNote) into USC
// (Universal Sekai Chart) — the documented, stable input format consumed by the
// vendored pjsekai engine's `uscToLevelData`. By targeting USC we inherit the
// engine's battle-tested entity generation (notes, slide connectors, sim lines,
// attach/slide refs) instead of re-deriving it.
//
// Coordinate mapping (Our Notes → USC):
//   Our Notes: pos = left-edge in [0,24], size = width in lane units.
//   USC:       lane = CENTER in [-6,6] (12-wide field), size = HALF-width.
//   => uscLane = (pos + size/2) / 24 * 12 - 6  =  (pos + size/2) / 2 - 6
//      uscSize = size / 24 * 12 / 2            =  size / 4
//
// Timing: USC objects are keyed by `beat` (= tick / PPQ). ResolvedNote carries
// `.beat` already.
//
// Note-type mapping is driven by NoteOperateType (RE'd), see enums.ts.

import { NoteOperateType, NoteDirection, NoteLineEaseType } from "../shared/enums.js";
import type { InternalChart, ResolvedNote, NoteLine } from "./types.js";

// ---- USC types (mirror of pjsekai lib/src/usc) ----
export type USC = { offset: number; objects: USCObject[] };
export type USCObject = USCBpmChange | USCTimeScaleChange | USCSingleNote | USCSlideNote;

export type USCBpmChange = { type: "bpm"; beat: number; bpm: number };
export type USCTimeScaleChange = { type: "timeScale"; beat: number; timeScale: number };

type Dir = "left" | "up" | "right";
type Ease = "out" | "linear" | "in";

export type USCSingleNote = {
  type: "single";
  beat: number;
  lane: number;
  size: number;
  trace: boolean;
  critical: boolean;
  direction?: Dir;
};

export type USCConnectionStartNote = {
  type: "start";
  beat: number;
  lane: number;
  size: number;
  trace: boolean;
  critical: boolean;
  ease: Ease;
  easeL?: Ease;
  easeR?: Ease;
};
export type USCConnectionTickNote = {
  type: "tick";
  beat: number;
  lane: number;
  size: number;
  trace: boolean;
  critical: boolean;
  ease: Ease;
  easeL?: Ease;
  easeR?: Ease;
};
export type USCConnectionEndNote = {
  type: "end";
  beat: number;
  lane: number;
  size: number;
  trace: boolean;
  critical: boolean;
  direction?: Dir;
};
// The following connection kinds are part of the USC spec and are handled by
// uscToLevelData, but our chart→USC converter does not currently emit them
// (we emit only start / tick / end). They're included so the vendored
// converter typechecks against the full union.
export type USCConnectionIgnoreNote = {
  type: "ignore";
  beat: number;
  lane: number;
  size: number;
  ease: Ease;
  easeL?: Ease;
  easeR?: Ease;
};
export type USCConnectionHiddenNote = {
  type: "hidden";
  beat: number;
};
export type USCConnectionAttachNote = {
  type: "attach";
  beat: number;
  critical: boolean;
};
export type USCSlideConnection =
  | USCConnectionStartNote
  | USCConnectionTickNote
  | USCConnectionEndNote
  | USCConnectionIgnoreNote
  | USCConnectionHiddenNote
  | USCConnectionAttachNote;

export type USCSlideNote = {
  type: "slide";
  active: boolean;
  critical: boolean;
  connections: USCSlideConnection[];
};

// ---- mapping helpers ----
const LANE_UNITS = 24;

export function posToLane(pos: number, size: number): number {
  return ((pos + size / 2) / LANE_UNITS) * 12 - 6;
}
export function sizeToUscSize(size: number): number {
  // USC size is half-width; a full-lane note (size≈2 units) → ~0.5.
  // Guard a floor so zero-width trace/marker notes still render a sliver.
  return Math.max(size / 4, 0.5);
}

function dirOf(d: NoteDirection): Dir | undefined {
  if (d === NoteDirection.Left) return "left";
  if (d === NoteDirection.Right) return "right";
  return undefined; // Normal → upward flick (USC omits direction for plain flick? no: 'up')
}

function easeOf(e: NoteLineEaseType | null): Ease {
  // Original enum names are misleading at render time:
  // GetNoteLineTypeEasing(1) = (2 - s) * s, GetNoteLineTypeEasing(2) = s * s.
  if (e === NoteLineEaseType.EaseIn) return "out";
  if (e === NoteLineEaseType.EaseOut) return "in";
  return "linear";
}

function toSegmentEase(n: ResolvedNote) {
  const easeR = easeOf(n.easeR);
  return {
    ease: easeR,
    easeL: easeOf(n.easeL),
    easeR,
  };
}

// Classify a standalone (non-line) note from its operateType.
function isFlickOp(op: NoteOperateType): boolean {
  return (
    op === NoteOperateType.Flick ||
    op === NoteOperateType.SlideBeginFlick ||
    op === NoteOperateType.SlideEndFlick ||
    op === NoteOperateType.GuideBeginFlick
  );
}
function isTraceOp(op: NoteOperateType): boolean {
  return (
    op === NoteOperateType.Trace ||
    op === NoteOperateType.SlideBeginTrace ||
    op === NoteOperateType.SlideEndTrace ||
    op === NoteOperateType.SlideConnectionTrace ||
    op === NoteOperateType.GuideBeginTrace ||
    op === NoteOperateType.GuideEndTrace
  );
}

function isLineStartOp(op: NoteOperateType): boolean {
  return (
    op === NoteOperateType.SlideBegin ||
    op === NoteOperateType.SlideBeginFlick ||
    op === NoteOperateType.SlideBeginTrace ||
    op === NoteOperateType.HiddenSlideBegin ||
    op === NoteOperateType.GuideBegin ||
    op === NoteOperateType.GuideBeginNormal ||
    op === NoteOperateType.GuideBeginFlick ||
    op === NoteOperateType.GuideBeginTrace
  );
}

function isLineEndOp(op: NoteOperateType): boolean {
  return (
    op === NoteOperateType.SlideEnd ||
    op === NoteOperateType.SlideEndFlick ||
    op === NoteOperateType.SlideEndTrace ||
    op === NoteOperateType.HiddenSlideEnd ||
    op === NoteOperateType.GuideEnd ||
    op === NoteOperateType.GuideEndTrace
  );
}

function lineSortKey(op: NoteOperateType): number {
  if (isLineStartOp(op)) return 0;
  if (isLineEndOp(op)) return 2;
  return 1;
}

function toLaneConnection(n: ResolvedNote) {
  return {
    beat: n.beat,
    lane: posToLane(n.pos, n.size),
    size: sizeToUscSize(n.size),
  };
}

function toIgnoreConnection(n: ResolvedNote): USCConnectionIgnoreNote {
  return {
    type: "ignore",
    ...toLaneConnection(n),
    ...toSegmentEase(n),
  };
}

function toLineConnection(line: NoteLine, n: ResolvedNote): USCSlideConnection | null {
  if (line.kind === "guide") {
    switch (n.operateType) {
      case NoteOperateType.GuideBegin:
      case NoteOperateType.GuideBeginNormal:
      case NoteOperateType.GuideBeginFlick:
      case NoteOperateType.GuideBeginTrace:
      case NoteOperateType.GuideEnd:
      case NoteOperateType.Hidden:
        return toIgnoreConnection(n);
      case NoteOperateType.GuideEndTrace:
        return {
          type: "end",
          ...toLaneConnection(n),
          trace: true,
          critical: n.critical,
        };
      case NoteOperateType.SlideConnectionTrace:
        return {
          type: "tick",
          ...toLaneConnection(n),
          trace: true,
          critical: n.critical,
          ...toSegmentEase(n),
        };
      default:
        return toIgnoreConnection(n);
    }
  }

  switch (n.operateType) {
    case NoteOperateType.SlideBegin:
    case NoteOperateType.SlideBeginFlick:
    case NoteOperateType.SlideBeginTrace:
      return {
        type: "start",
        ...toLaneConnection(n),
        trace: n.operateType === NoteOperateType.SlideBeginTrace,
        critical: n.critical,
        ...toSegmentEase(n),
      };
    case NoteOperateType.HiddenSlideBegin:
      return toIgnoreConnection(n);
    case NoteOperateType.SlideEnd:
    case NoteOperateType.SlideEndFlick:
    case NoteOperateType.SlideEndTrace: {
      const flick = n.operateType === NoteOperateType.SlideEndFlick;
      return {
        type: "end",
        ...toLaneConnection(n),
        trace: n.operateType === NoteOperateType.SlideEndTrace,
        critical: n.critical,
        direction: flick ? (dirOf(n.direction) ?? "up") : dirOf(n.direction),
      };
    }
    case NoteOperateType.HiddenSlideEnd:
      return toIgnoreConnection(n);
    case NoteOperateType.SlideConnection:
    case NoteOperateType.SlideConnectionTrace:
      return {
        type: "tick",
        ...toLaneConnection(n),
        trace: n.operateType === NoteOperateType.SlideConnectionTrace,
        critical: n.critical,
        ...toSegmentEase(n),
      };
    case NoteOperateType.Combo:
      return {
        type: "hidden",
        beat: n.beat,
      };
    case NoteOperateType.ComboSkip:
    case NoteOperateType.Hidden:
      return toIgnoreConnection(n);
    default:
      return null;
  }
}

export function chartToUsc(chart: InternalChart): USC {
  const objects: USCObject[] = [];

  for (const b of chart.bpmChanges) {
    objects.push({ type: "bpm", beat: b.beat, bpm: b.bpm });
  }

  const byId = new Map<number, ResolvedNote>();
  for (const n of chart.notes) byId.set(n.id, n);

  // Standalone notes (not part of a slide/guide line).
  for (const n of chart.notes) {
    if (n.lineIds.length > 0) continue;
    const flick = isFlickOp(n.operateType);
    objects.push({
      type: "single",
      beat: n.beat,
      lane: posToLane(n.pos, n.size),
      size: sizeToUscSize(n.size),
      trace: isTraceOp(n.operateType),
      critical: n.critical,
      // a flick note gets a direction; plain flick (dir Normal) → "up"
      direction: flick ? (dirOf(n.direction) ?? "up") : dirOf(n.direction),
    });
  }

  // Slide / guide lines → USC slide objects.
  for (const line of chart.lines) {
    const nodes = line.noteIds.map((id) => byId.get(id)!).filter(Boolean);
    if (nodes.length < 2) continue;

    // The chart model resolves original Our Notes operate types before this
    // step. Sort by time, but let explicit begin/end opcodes win ties so hidden
    // helper nodes and generated combo ticks never become artificial endpoints.
    nodes.sort(
      (a, b) =>
        a.beat - b.beat ||
        lineSortKey(a.operateType) - lineSortKey(b.operateType) ||
        (a.indexInLine ?? 0) - (b.indexInLine ?? 0) ||
        a.id - b.id,
    );

    const connections = nodes
      .map((n) => toLineConnection(line, n))
      .filter((connection): connection is USCSlideConnection => connection !== null);
    if (connections.length < 2) continue;

    // A "guide" is a visual-only slide → non-active (no tap needed).
    // A "long" is an active hold.
    const active = line.kind === "long";
    // critical if any node is critical (start typically carries it)
    const critical = nodes.some((n) => n.critical);

    objects.push({ type: "slide", active, critical, connections });
  }

  return { offset: 0, objects };
}
