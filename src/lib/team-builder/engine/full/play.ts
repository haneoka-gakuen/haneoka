/** Charts and judgement streams of the whole-live simulation: the theoretical best play at 60 fps (Just inside Gekisou
 * Just-count ranges) and stated accuracies spread evenly over it. */
import type { EngineMaster } from "../master";
import type { ChartSource } from "../chart";
import { ceilToI32, f } from "./num";
import type { GekisouSetup, LiveNote, PlayFrame } from "./model";

export const FPS = 60;
export const TAIL_MS = 2000;
export const DT = f(1 / 60);
const MAX_FEVERS = 3;
const NOT_JUDGED = new Set([0, 80, 82, 100, 103, 121, 122, 123]);
export const isJudgementNote = (op: number) => !NOT_JUDGED.has(op);

export interface FullChart {
  /** Every runtime note in enumeration order; ids are 1-based positions. */
  notes: LiveNote[];
  /** Skill events: performer index, time. */
  events: [number, number][];
  fevers: [number, number][];
  convertedCount: number;
  lastTimingMs: number;
  level: number;
}

export function fullChart(master: EngineMaster, source: ChartSource, level: number): FullChart {
  const enumeration = source.enumeration;
  if (!enumeration?.length) throw new Error("chart without runtime enumeration");
  const notes = enumeration.map((n, i) => ({ id: i + 1, timeMs: n.timeMs, op: n.op, judgementType: n.judgementType ?? 0 }));
  let sum = 0;
  for (const n of notes) {
    const p = master.live.notePercent.get(n.op);
    if (p !== undefined) sum = (sum + p) | 0;
  }
  return {
    notes,
    events: source.skillTimesMs.map((t, i) => [i, t]),
    fevers: source.feverMs.map(([s, e]) => [s, e]),
    convertedCount: ceilToI32(f(f(sum) / 100)),
    lastTimingMs: Math.max(...notes.map((n) => n.timeMs)),
    level,
  };
}

function frames(end: number): number[] {
  const out: number[] = [];
  for (let k = 0; ; k++) {
    const t = Math.floor((k * 1000) / FPS);
    if (t > end) return out;
    out.push(t);
  }
}
const partition = (xs: readonly number[], t: number) => {
  let lo = 0;
  let hi = xs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (xs[mid]! < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
};
function chooseEvenly(n: number, count: number, select: (i: number) => void) {
  let remainder = 0;
  for (let i = 0; i < n; i++) {
    remainder += count;
    if (remainder >= n) {
      remainder -= n;
      select(i);
    }
  }
}

export interface Accuracy {
  great: number;
  just: number;
  /** Pattern play: after Great/Just, every Nth judged note (1-based, native stream order) is a Miss. */
  missEvery?: number;
}
export interface LivePlay {
  frames: PlayFrame[];
  dt: number[];
}

/** The play of a stated accuracy built from the theoretical best play (Gekisou off: every note Perfect; on: Just where
 * the Just judgement is enabled). `round(n·great)` notes are Great, spread evenly; of the remaining Just-eligible notes
 * `round(m·just)` are Just and the rest Perfect. */
export function judgementStream(master: EngineMaster, chart: FullChart, gekisou: GekisouSetup | null, accuracy: Accuracy = { great: 0, just: 1 }): LivePlay {
  const judged = chart.notes.filter((n) => isJudgementNote(n.op)).sort((a, b) => a.timeMs - b.timeMs || a.id - b.id);
  let last = Math.max(0, ...chart.notes.map((n) => n.timeMs), ...chart.events.map(([, t]) => t));
  let windows: [number, number][] = [];
  const times = (() => {
    if (gekisou) {
      if (gekisou.fevers.length > MAX_FEVERS) throw new Error("more than three fevers");
      last = Math.max(last, ...gekisou.fevers.map(([, e]) => e));
    }
    return frames(last + TAIL_MS);
  })();
  if (gekisou)
    windows = gekisou.fevers.flatMap(([start, end], i): [number, number][] => {
      if (gekisou.missions[i] === undefined) throw new Error("fewer missions than fevers");
      if (gekisou.missions[i] !== 3) return [];
      const first = times.findIndex((t) => t >= start);
      if (first < 0) return [];
      const rel = times.slice(first + 1).findIndex((t) => t >= end);
      return [[first, rel < 0 ? times.length : first + 1 + rel]];
    });
  const inWindow = (frame: number) => windows.some(([a, b]) => a <= frame && frame < b);
  const rows = judged.map((n) => {
    const frame = partition(times, n.timeMs);
    const just = gekisou !== null && master.live.justTypes.has(n.judgementType) && inWindow(frame);
    return { frame, note: n, best: just ? 6 : 5 };
  });
  const total = rows.length;
  const grade = rows.map(() => 5);
  chooseEvenly(total, Math.round(total * accuracy.great), (i) => (grade[i] = 4));
  const eligible = rows.map((_, i) => i).filter((i) => grade[i] !== 4 && rows[i]!.best === 6);
  chooseEvenly(eligible.length, Math.round(eligible.length * accuracy.just), (k) => (grade[eligible[k]!] = 6));
  const every = Math.floor(accuracy.missEvery ?? 0);
  if (every > 0) for (let i = every - 1; i < total; i += every) grade[i] = 1;
  const out: PlayFrame[] = times.map((timeMs) => ({ timeMs, judged: [] }));
  rows.forEach((r, i) => out[r.frame]!.judged.push({ noteId: r.note.id, judgement: grade[i]!, timeMs: r.note.timeMs }));
  return { frames: out, dt: times.map(() => DT) };
}
