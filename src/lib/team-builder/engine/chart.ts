/** Chart compilation: judged notes in chart order with their static score factors. */
import type { EngineMaster, Song, SongDifficulty } from "./master";

const f = Math.fround;
export interface ChartSource {
  durationMs: number;
  /** Runtime notes sorted by time. */
  notes: readonly { timeMs: number; operateType: number; judgementType: number; judged: boolean }[];
  skillTimesMs: readonly number[];
  feverMs: readonly (readonly [number, number])[];
  /** The client's note enumeration order, which decides the skip score's last counted frame. */
  enumeration?: readonly { op: number; timeMs: number; judgementType?: number }[];
}
export interface CompiledChart {
  key: string;
  song: Song;
  difficulty: SongDifficulty;
  count: number;
  times: Int32Array;
  noteTypes: Int32Array;
  judgementTypes: Int32Array;
  /** Note percent / 100, binary32. */
  noteFrac: Float32Array;
  /** Index of the first note at each distinct time (chords share combo state). */
  convertedCount: number;
  difficultyFactor: number;
  skillTimes: readonly number[];
  /** Skill event indices in firing order (time, then index): chart order is not always time order. */
  skillOrder: readonly number[];
  feverMs: readonly (readonly [number, number])[];
  durationMs: number;
  lastNoteMs: number;
  /** Ascending score thresholds of the song's rank group. */
  ranks: readonly { rank: number; required: number; battleRequired: number }[];
  /** Skip: notes scored as Great with combo 0, life full and no skills. */
  skipNoteFrac: Float32Array;
}

export const chartKey = (songId: number, difficulty: number) => `${songId}:${difficulty}`;
/** Gekisou lives use battle thresholds, not solo score thresholds. */
export function battleRank(chart: Pick<CompiledChart, "ranks">, score: number): number {
  let rank = 2;
  for (const row of chart.ranks)
    if (row.battleRequired > 0 && row.battleRequired <= score && row.rank > rank) rank = row.rank;
  return rank;
}
export const difficultyFactor = (playLevel: number) => f(f((playLevel - 5) * f(0.005)) + 1);

/** Keeps only notes that score; skip-valid types exclude combo-only notes (120). */
export function compileChart(master: EngineMaster, song: Song, difficulty: SongDifficulty, source: ChartSource): CompiledChart {
  const judged = source.notes.filter((note) => note.judged);
  const count = judged.length;
  const times = new Int32Array(count);
  const noteTypes = new Int32Array(count);
  const judgementTypes = new Int32Array(count);
  const noteFrac = new Float32Array(count);
  let percentSum = 0;
  judged.forEach((note, index) => {
    times[index] = note.timeMs;
    noteTypes[index] = note.operateType;
    judgementTypes[index] = note.judgementType;
    const percent = master.live.notePercent.get(note.operateType) ?? 0;
    percentSum = (percentSum + percent) | 0;
    noteFrac[index] = f(percent / 100);
  });
  // Skip: valid notes in enumeration order up to the frame of the last one enumerated
  // (frames of 40 ms, capped one frame before the live's end frame).
  const frame = (ms: number) => (ms < 0 ? 0 : Math.ceil(f(f(ms) / 40)));
  const enumeration = source.enumeration ?? source.notes.map((note) => ({ op: note.operateType, timeMs: note.timeMs }));
  const lastTiming = Math.max(0, ...enumeration.map((note) => note.timeMs));
  const maxFrame = frame(lastTiming + 1000) + 50;
  const valid = enumeration.filter((note) => note.op !== 120 && master.live.notePercent.has(note.op));
  const capped = (ms: number) => Math.min(frame(ms), maxFrame - 1);
  const toFrame = valid.length ? Math.max(0, capped(valid[valid.length - 1]!.timeMs)) : -1;
  const skipNoteFrac = Float32Array.from(
    valid.filter((note) => capped(note.timeMs) <= toFrame),
    (note) => f((master.live.notePercent.get(note.op) ?? 0) / 100),
  );
  const lastNoteMs = count ? times[count - 1]! : 0;
  return {
    key: chartKey(song.id, difficulty.difficulty),
    song,
    difficulty,
    count,
    times,
    noteTypes,
    judgementTypes,
    noteFrac,
    convertedCount: Math.max(1, Math.ceil(f(percentSum / 100))),
    difficultyFactor: difficultyFactor(difficulty.playLevel),
    skillTimes: source.skillTimesMs,
    skillOrder: source.skillTimesMs.map((_, i) => i).sort((a, b) => source.skillTimesMs[a]! - source.skillTimesMs[b]! || a - b),
    feverMs: source.feverMs,
    durationMs: source.durationMs,
    lastNoteMs,
    ranks: master.scoreRanks.get(song.rankGroup) ?? [],
    skipNoteFrac,
  };
}

/** Live rank shown in play and used for rewards: the highest rank whose threshold the score reaches. */
export function scoreRank(chart: CompiledChart, score: number): number {
  let rank = 2;
  for (const row of chart.ranks) if (row.required <= score && row.rank > rank) rank = row.rank;
  return rank;
}
export function rankThreshold(chart: CompiledChart, rank: number): number | null {
  const row = chart.ranks.find((item) => item.rank === rank);
  return row ? row.required : null;
}

interface ConvertedChart {
  durationMs: number;
  bpmChanges: readonly { bpm: number; tick: number; timeMs: number }[];
  notes: readonly { timeMs: number; operateType: number; judgementType: number; judged: boolean }[];
  passthrough: { skill: readonly number[]; fever: readonly (readonly [number, number])[] };
}
export function tickToTimeMs(changes: ConvertedChart["bpmChanges"], tick: number): number {
  const first = changes[0];
  if (!first) return Math.floor((tick * 60000) / (120 * 480));
  let segment = first;
  for (const change of changes) {
    if (change.tick <= tick) segment = change;
    else break;
  }
  return Math.floor(segment.timeMs + ((tick - segment.tick) * 60000) / f(segment.bpm * 480));
}
export function chartSourceFromConverted(chart: ConvertedChart): ChartSource {
  return {
    durationMs: chart.durationMs,
    notes: chart.notes,
    skillTimesMs: chart.passthrough.skill.map((tick) => tickToTimeMs(chart.bpmChanges, tick)),
    feverMs: chart.passthrough.fever.map(([start, end]) => [tickToTimeMs(chart.bpmChanges, start), tickToTimeMs(chart.bpmChanges, end)] as const),
  };
}

/** Converts raw `.bytes` chart files exactly as the client builds its runtime notes. */
export async function convertChartBytes(bytes: Uint8Array): Promise<ChartSource> {
  const { runtimeChartFromBytes } = await import("./runtime-chart");
  return runtimeChartFromBytes(bytes);
}
