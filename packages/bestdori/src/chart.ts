/**
 * Bestdori chart -> Our Notes SS conversion.
 *
 * This module owns knowledge of the Bestdori chart wire format. The generic
 * chart engine intentionally has no dependency on these contracts.
 */

export interface BestdoriChartNote {
  type?: string;
  beat?: number;
  bpm?: number;
  data?: string;
  lane?: number;
  width?: number;
  direction?: string;
  flick?: boolean;
  skill?: boolean;
  hidden?: boolean;
  charge?: boolean;
  connections?: BestdoriChartConnection[];
}

export interface BestdoriChartConnection {
  beat?: number;
  lane?: number;
  flick?: boolean;
  skill?: boolean;
  hidden?: boolean;
  charge?: boolean;
}

export interface BestdoriSsBpm {
  t: number;
  bpm: number;
}

export interface BestdoriSsNote {
  type?: "flick" | "trace" | "long" | "guide";
  t?: number;
  pos?: number | "auto";
  size?: number;
  crit?: boolean;
  dir?: "left" | "up" | "right";
  visible?: boolean;
  node?: BestdoriSsNote[];
}

export interface BestdoriSsDocument {
  meta: { version: number };
  score: {
    events: {
      bpm: BestdoriSsBpm[];
      sig: Array<{ t: number; sig: [number, number] }>;
      skill: number[];
      fever: Array<[number, number]>;
      call: Array<{ t: number; timing: number[] }>;
    };
    notes: BestdoriSsNote[];
  };
}

/**
 * Apply the chart repair pass used by Bestdori's published simulator.
 *
 * The simulator does this before deriving combo/skill metadata: a line with
 * no visible connection is discarded, a line with one visible connection is
 * reduced to a plain Single, and a line with multiple visible connections is
 * sorted by beat and trimmed only at its hidden ends. Hidden interior points
 * remain part of the line so they still shape the interpolation path.
 */
export function repairBestdoriChart(input: unknown): BestdoriChartNote[] {
  if (!Array.isArray(input)) return [];

  const repaired: BestdoriChartNote[] = [];
  for (const raw of input as BestdoriChartNote[]) {
    if (!raw || typeof raw !== "object") continue;
    if (raw.type !== "Long" && raw.type !== "Slide") {
      repaired.push(raw);
      continue;
    }

    const connections = Array.isArray(raw.connections) ? raw.connections : [];
    const visible = connections.filter((point) => !point.hidden);
    if (visible.length === 0) continue;

    if (visible.length === 1) {
      const point = visible[0]!;
      const single: BestdoriChartNote = { type: "Single" };
      if (point.lane !== undefined) single.lane = point.lane;
      if (point.beat !== undefined) single.beat = point.beat;
      if (point.flick !== undefined) single.flick = point.flick;
      repaired.push(single);
      continue;
    }

    // The source uses a shallow copy before sorting; preserve the original
    // point objects and all of their fields, including hidden interior nodes.
    const sorted = connections.slice().sort((left, right) => {
      const leftBeat = left.beat;
      const rightBeat = right.beat;
      if (typeof leftBeat !== "number" || typeof rightBeat !== "number") return 0;
      return leftBeat - rightBeat;
    });
    while (sorted.length > 0 && sorted[0]!.hidden) sorted.shift();
    while (sorted.length > 0 && sorted[sorted.length - 1]!.hidden) sorted.pop();
    repaired.push({ type: "Slide", connections: sorted });
  }
  return repaired;
}

const PPQ = 480;
const LANE_POS_BASE = -2;
const LANE_POS_SCALE = 4;
const NOTE_SIZE = 4;

const finiteNumber = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);
const toTick = (beat: number): number => Math.round(beat * PPQ);
const laneToPos = (lane: number): number => LANE_POS_BASE + lane * LANE_POS_SCALE;

/**
 * Return the SS left edge and width for a Bestdori directional flick.
 *
 * Bestdori's published ToolChartSimulator (ToolChartSimulator.95b33d9b.js)
 * draws tile i at `lane + i * (isLeft ? -1 : 1)`. Therefore `lane` is the
 * rightmost tile centre for Left and the leftmost tile centre for Right. Its
 * arrow formula, `lane + (isLeft ? 1 - width : width - 1)`, confirms the same
 * anchor convention.
 */
export function bestdoriDirectionalGeometry(
  laneValue: unknown,
  widthValue: unknown,
  direction: unknown,
): { pos: number; size: number } {
  const anchorLane = finiteNumber(laneValue);
  const width = Math.max(1, finiteNumber(widthValue));
  const leftmostLane = direction === "Left" ? anchorLane - (width - 1) : anchorLane;
  return {
    pos: laneToPos(leftmostLane),
    size: NOTE_SIZE * width,
  };
}

/** Convert a parsed Bestdori chart array into an SS document object. */
export function bestdoriChartToSs(input: unknown): BestdoriSsDocument {
  const source = repairBestdoriChart(input);
  const bpm: BestdoriSsBpm[] = [];
  const skill: number[] = [];
  const feverRanges: Array<[startTick: number, endTick?: number]> = [];
  const notes: BestdoriSsNote[] = [];

  for (const raw of source) {
    if (!raw || typeof raw !== "object") continue;

    switch (raw.type) {
      case "BPM": {
        const value = finiteNumber(raw.bpm);
        if (value > 0) bpm.push({ t: toTick(finiteNumber(raw.beat)), bpm: value });
        break;
      }
      case "System": {
        // ToolChartSimulator.95b33d9b.js appends on every start and makes every
        // end mutate the latest appended range, even if that range already has
        // an end. Keep that event-order behaviour instead of treating fever as
        // one global open/closed flag. The BGM marker is an audio-host concern.
        if (raw.data === "cmd_fever_start.wav") {
          feverRanges.push([toTick(finiteNumber(raw.beat))]);
        } else if (raw.data === "cmd_fever_end.wav" && feverRanges.length > 0) {
          feverRanges[feverRanges.length - 1]![1] = toTick(finiteNumber(raw.beat));
        }
        break;
      }
      case "Single": {
        const tick = toTick(finiteNumber(raw.beat));
        if (raw.skill) skill.push(tick);
        const note: BestdoriSsNote = {
          t: tick,
          pos: laneToPos(finiteNumber(raw.lane)),
          size: NOTE_SIZE,
        };
        if (raw.flick) note.type = "flick";
        if (raw.hidden) note.visible = false;
        notes.push(note);
        break;
      }
      case "Long":
      case "Slide": {
        const connections = Array.isArray(raw.connections) ? raw.connections : [];
        if (!connections.length) break;
        const node = connections.map((point): BestdoriSsNote => {
          const tick = toTick(finiteNumber(point.beat));
          // The published simulator never derives skills from hidden
          // connections. Hidden interior points are still rendered as part of
          // the repaired line, but they cannot create a skill marker.
          if (!point.hidden && point.skill) skill.push(tick);
          const entry: BestdoriSsNote = {
            t: tick,
            pos: laneToPos(finiteNumber(point.lane)),
            size: NOTE_SIZE,
          };
          if (point.flick) entry.type = "flick";
          if (point.hidden) entry.visible = false;
          return entry;
        });
        notes.push({ type: "long", node });
        break;
      }
      case "Directional": {
        const tick = toTick(finiteNumber(raw.beat));
        if (raw.skill) skill.push(tick);
        const direction = raw.direction === "Left" ? "left" : raw.direction === "Right" ? "right" : "up";
        notes.push({
          type: "flick",
          t: tick,
          ...bestdoriDirectionalGeometry(raw.lane, raw.width, raw.direction),
          dir: direction,
        });
        break;
      }
    }
  }

  if (!bpm.some((entry) => entry.t === 0)) bpm.unshift({ t: 0, bpm: 120 });
  bpm.sort((left, right) => left.t - right.t);
  skill.sort((left, right) => left - right);
  // The published viewer leaves unmatched starts open with Infinity. SS is a
  // JSON format and cannot encode Infinity, so retain every faithfully closed
  // range and omit only malformed, unclosed source events.
  const fever = feverRanges
    .flatMap(([start, end]) => (end === undefined ? [] : ([[start, end]] as Array<[number, number]>)))
    .sort((left, right) => left[0] - right[0]);

  return {
    meta: { version: 1 },
    score: {
      events: {
        bpm,
        sig: [{ t: 0, sig: [4, 4] }],
        skill,
        fever,
        call: [],
      },
      notes,
    },
  };
}

/** Convert a parsed Bestdori chart array into SS JSON text. */
export const bestdoriChartToSsText = (input: unknown): string => JSON.stringify(bestdoriChartToSs(input));
