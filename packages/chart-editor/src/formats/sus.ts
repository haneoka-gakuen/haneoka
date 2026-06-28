/*
 * SUS analysis and conversion semantics are adapted from Next-SEKAI.
 * Copyright (c) 2025 Kyle Chang, MIT License.
 * See ../../LICENSE.next-sekai.txt for the complete attribution and license.
 */

import { importedId, type JsonValue, type MeterEvent, type ProjectMeta } from "../model";
import {
  ChartFormatError,
  finishImport,
  importedMeta,
  textInput,
  type FormatWarning,
  type ImportResult,
} from "./shared";
import {
  importUsc,
  type UscAttachConnection,
  type UscChart,
  type UscConnection,
  type UscDirection,
  type UscIgnoreConnection,
  type UscObject,
  type UscSlideNote,
} from "./usc";

const SUS_DEFAULT_LANE_BASIS = 24;

interface SusLine {
  header: string;
  data: string;
  line: number;
  measureBase: number;
}

interface BarLength {
  measure: number;
  length: number;
  line: number;
}

export interface SusNoteObject {
  tick: number;
  lane: number;
  width: number;
  type: number;
  line: number;
}

export interface SusSlideObject {
  type: number;
  notes: SusNoteObject[];
}

export interface SusAnalysis {
  offset: number;
  ticksPerBeat: number;
  laneCount: number;
  timeScaleChanges: Array<{ tick: number; timeScale: number }>;
  bpmChanges: Array<{ tick: number; bpm: number }>;
  barLengths: BarLength[];
  tapNotes: SusNoteObject[];
  directionalNotes: SusNoteObject[];
  slides: SusSlideObject[];
  meta: Record<string, string>;
  warnings: FormatWarning[];
}

interface ParsedSus {
  lines: SusLine[];
  meta: Map<string, string>;
  requests: string[];
  warnings: FormatWarning[];
}

type ToTick = (measure: number, numerator: number, denominator: number) => number;

const unquote = (value: string | undefined): string => {
  if (!value) return "";
  const trimmed = value.trim();
  return trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"') ? trimmed.slice(1, -1) : trimmed;
};

const parseSus = (input: string): ParsedSus => {
  const lines: SusLine[] = [];
  const meta = new Map<string, string>();
  const requests: string[] = [];
  const warnings: FormatWarning[] = [];
  let measureBase = 0;

  for (const [index, source] of input.split(/\r?\n/).entries()) {
    const text = source.trim();
    if (!text.startsWith("#")) continue;
    const colon = text.indexOf(":");
    const space = text.search(/\s/);
    const hasData = colon >= 0 && (space < 0 || colon < space);
    const separator = hasData ? colon : space;
    if (separator < 0) continue;
    const left = text.slice(1, separator).trim().toUpperCase();
    const right = text.slice(separator + 1).trim();
    if (!left) continue;

    if (hasData) {
      lines.push({ header: left, data: right, line: index + 1, measureBase });
      continue;
    }
    if (left === "MEASUREBS") {
      const next = Number(right);
      if (!Number.isFinite(next)) {
        warnings.push({
          code: "sus.measureBase.invalid",
          path: `line:${index + 1}`,
          message: "Invalid MEASUREBS directive was ignored",
        });
      } else {
        measureBase = next;
      }
      continue;
    }
    if (left === "REQUEST") requests.push(unquote(right));
    // Keep the last directive, matching how SUS authoring tools resolve metadata.
    meta.set(left, right);
  }

  return { lines, meta, requests, warnings };
};

const ticksPerBeatFromMeta = (requests: readonly string[], warnings: FormatWarning[]): number => {
  const request = requests.find((value) => /^\s*ticks_per_beat\b/i.test(value));
  const match = request?.match(/^\s*ticks_per_beat\s+([0-9]+(?:\.[0-9]+)?)\s*$/i);
  const value = match ? Number(match[1]) : Number.NaN;
  if (Number.isFinite(value) && value > 0) return value;
  warnings.push({
    code: "sus.ticksPerBeat.defaulted",
    path: "#REQUEST",
    message: "Missing ticks_per_beat request; 480 ticks per beat was assumed",
  });
  return 480;
};

const laneCountFromMeta = (meta: ReadonlyMap<string, string>, warnings: FormatWarning[]): number => {
  const raw = meta.get("LANECOUNT");
  if (raw === undefined) return SUS_DEFAULT_LANE_BASIS;
  const laneCount = Number(unquote(raw));
  if (Number.isSafeInteger(laneCount) && laneCount > 0) return laneCount;
  warnings.push({
    code: "sus.laneCount.defaulted",
    path: "#LANECOUNT",
    message: `Invalid LANECOUNT directive; ${SUS_DEFAULT_LANE_BASIS} lanes were assumed`,
  });
  return SUS_DEFAULT_LANE_BASIS;
};

const barLengthsFromLines = (lines: readonly SusLine[], warnings: FormatWarning[]): BarLength[] => {
  const byMeasure = new Map<number, BarLength>();
  byMeasure.set(0, { measure: 0, length: 4, line: 0 });
  for (const line of lines) {
    if (line.header.length !== 5 || !line.header.endsWith("02")) continue;
    const localMeasure = Number(line.header.slice(0, 3));
    const length = Number(line.data);
    const measure = localMeasure + line.measureBase;
    if (!Number.isSafeInteger(measure) || measure < 0 || !Number.isFinite(length) || length <= 0) {
      warnings.push({
        code: "sus.barLength.invalid",
        path: `line:${line.line}`,
        message: "Invalid measure length was ignored",
      });
      continue;
    }
    byMeasure.set(measure, { measure, length, line: line.line });
  }
  return [...byMeasure.values()].sort((left, right) => left.measure - right.measure || left.line - right.line);
};

const createToTick = (barLengths: readonly BarLength[], ticksPerBeat: number): ToTick => {
  const segments: Array<{ measure: number; ticks: number; ticksPerMeasure: number }> = [];
  let ticks = 0;
  for (const [index, bar] of barLengths.entries()) {
    const previous = barLengths[index - 1];
    if (previous) ticks += (bar.measure - previous.measure) * previous.length * ticksPerBeat;
    segments.push({ measure: bar.measure, ticks, ticksPerMeasure: bar.length * ticksPerBeat });
  }
  return (measure, numerator, denominator) => {
    if (
      !Number.isFinite(measure) ||
      !Number.isFinite(numerator) ||
      !Number.isFinite(denominator) ||
      denominator === 0
    ) {
      throw new ChartFormatError("sus", "Invalid musical position");
    }
    let segment = segments[0]!;
    for (const candidate of segments) {
      if (candidate.measure > measure) break;
      segment = candidate;
    }
    return (
      segment.ticks +
      (measure - segment.measure) * segment.ticksPerMeasure +
      (numerator * segment.ticksPerMeasure) / denominator
    );
  };
};

const rawPairs = (line: SusLine, toTick: ToTick, warnings: FormatWarning[]): Array<{ tick: number; value: string }> => {
  const localMeasure = Number(line.header.slice(0, 3));
  if (!Number.isSafeInteger(localMeasure)) return [];
  if (line.data.length % 2 !== 0) {
    warnings.push({
      code: "sus.channel.oddLength",
      path: `line:${line.line}`,
      message: "The final unmatched channel character was ignored",
    });
  }
  const values = line.data.match(/.{2}/g) ?? [];
  const measure = localMeasure + line.measureBase;
  return values.flatMap((value, index) =>
    value === "00" ? [] : [{ tick: toTick(measure, index, values.length), value: value.toUpperCase() }],
  );
};

const notesFromLine = (line: SusLine, toTick: ToTick, warnings: FormatWarning[]): SusNoteObject[] => {
  const lane = Number.parseInt(line.header[4] ?? "", 36);
  if (!Number.isFinite(lane)) return [];
  return rawPairs(line, toTick, warnings).flatMap(({ tick, value }) => {
    const type = Number.parseInt(value[0] ?? "", 36);
    const width = Number.parseInt(value[1] ?? "", 36);
    if (!Number.isFinite(type) || !Number.isFinite(width)) {
      warnings.push({
        code: "sus.note.invalid",
        path: `line:${line.line}`,
        message: `Invalid note token ${value} was skipped`,
      });
      return [];
    }
    return [{ tick, lane, width, type, line: line.line }];
  });
};

const timeScalesFromLine = (line: SusLine, toTick: ToTick, warnings: FormatWarning[]) => {
  const data = unquote(line.data);
  return data.split(",").flatMap((rawSegment) => {
    const segment = rawSegment.trim();
    if (!segment) return [];
    const match = segment.match(/^(-?\d+)'(-?\d+(?:\.\d+)?):(-?\d+(?:\.\d+)?)$/);
    if (!match) {
      warnings.push({
        code: "sus.timeScale.invalid",
        path: `line:${line.line}`,
        message: `Invalid time-scale segment ${segment} was skipped`,
      });
      return [];
    }
    const measure = Number(match[1]);
    const tickOffset = Number(match[2]);
    const timeScale = Number(match[3]);
    if (!Number.isFinite(timeScale) || timeScale <= 0) {
      warnings.push({
        code: "sus.timeScale.invalid",
        path: `line:${line.line}`,
        message: `Non-positive time scale ${String(match[3])} was skipped`,
      });
      return [];
    }
    return [{ tick: toTick(measure, 0, 1) + tickOffset, timeScale }];
  });
};

const splitSlides = (stream: SusSlideObject): SusSlideObject[] => {
  const slides: SusSlideObject[] = [];
  let active: SusNoteObject[] | undefined;
  for (const note of [...stream.notes].sort((left, right) => left.tick - right.tick || left.line - right.line)) {
    if (!active) {
      active = [];
      slides.push({ type: stream.type, notes: active });
    }
    active.push(note);
    if (note.type === 2) active = undefined;
  }
  return slides;
};

export const analyzeSus = (input: string | Uint8Array): SusAnalysis => {
  const parsed = parseSus(textInput(input));
  const warnings = [...parsed.warnings];
  const ticksPerBeat = ticksPerBeatFromMeta(parsed.requests, warnings);
  const laneCount = laneCountFromMeta(parsed.meta, warnings);
  const barLengths = barLengthsFromLines(parsed.lines, warnings);
  const toTick = createToTick(barLengths, ticksPerBeat);
  const bpmDefinitions = new Map<string, number>();
  const bpmChanges: SusAnalysis["bpmChanges"] = [];
  const timeScaleChanges: SusAnalysis["timeScaleChanges"] = [];
  const tapNotes: SusNoteObject[] = [];
  const directionalNotes: SusNoteObject[] = [];
  const streams = new Map<string, SusSlideObject>();

  for (const line of parsed.lines) {
    if (line.header.length === 5 && line.header.startsWith("BPM")) {
      const bpm = Number(line.data);
      if (Number.isFinite(bpm) && bpm > 0) bpmDefinitions.set(line.header.slice(3), bpm);
      else
        warnings.push({
          code: "sus.bpm.invalid",
          path: `line:${line.line}`,
          message: "Invalid BPM definition was ignored",
        });
    }
  }

  for (const line of parsed.lines) {
    const header = line.header;
    if (header.length === 5 && (header.startsWith("TIL") || header.startsWith("HIS"))) {
      timeScaleChanges.push(...timeScalesFromLine(line, toTick, warnings));
    } else if (header.length === 5 && header.endsWith("08")) {
      for (const raw of rawPairs(line, toTick, warnings)) {
        const bpm = bpmDefinitions.get(raw.value);
        if (bpm === undefined) {
          warnings.push({
            code: "sus.bpm.undefined",
            path: `line:${line.line}`,
            message: `Undefined BPM reference ${raw.value} was skipped`,
          });
        } else {
          bpmChanges.push({ tick: raw.tick, bpm });
        }
      }
    } else if (header.length === 5 && header.endsWith("03")) {
      // Legacy BMS-compatible direct hexadecimal BPM channel.
      for (const raw of rawPairs(line, toTick, warnings)) {
        const bpm = Number.parseInt(raw.value, 16);
        if (Number.isFinite(bpm) && bpm > 0) bpmChanges.push({ tick: raw.tick, bpm });
      }
    } else if (header.length === 5 && header[3] === "1") {
      tapNotes.push(...notesFromLine(line, toTick, warnings));
    } else if (header.length === 5 && header[3] === "5") {
      directionalNotes.push(...notesFromLine(line, toTick, warnings));
    } else if (header.length === 6 && (header[3] === "3" || header[3] === "9")) {
      const key = `${header[5]}-${header[3]}`;
      const stream = streams.get(key) ?? { type: Number(header[3]), notes: [] };
      stream.notes.push(...notesFromLine(line, toTick, warnings));
      streams.set(key, stream);
    }
  }

  let offset = -Number(parsed.meta.get("WAVEOFFSET") ?? 0);
  if (!Number.isFinite(offset)) {
    offset = 0;
    warnings.push({ code: "sus.offset.invalid", path: "#WAVEOFFSET", message: "Invalid audio offset defaulted to 0" });
  }

  return {
    offset,
    ticksPerBeat,
    laneCount,
    timeScaleChanges: timeScaleChanges.sort((left, right) => left.tick - right.tick),
    bpmChanges: bpmChanges.sort((left, right) => left.tick - right.tick),
    barLengths,
    tapNotes,
    directionalNotes,
    slides: [...streams.values()].flatMap(splitSlides),
    meta: Object.fromEntries(parsed.meta),
    warnings,
  };
};

const noteKey = (note: SusNoteObject): string => `${note.lane}-${note.tick}`;

const analysisToUsc = (score: SusAnalysis): UscChart => {
  const flickMods = new Map<string, UscDirection>();
  const traceMods = new Set<string>();
  const criticalMods = new Set<string>();
  const tickRemoveMods = new Set<string>();
  const slideStartEndRemoveMods = new Set<string>();
  const easeMods = new Map<string, "in" | "out">();
  const preventSingles = new Set<string>();
  const dedupeSingles = new Set<string>();
  const dedupeSlides = new Map<string, UscSlideNote>();

  for (const slide of score.slides) {
    if (slide.type !== 3) continue;
    for (const note of slide.notes) {
      if ([1, 2, 3, 5].includes(note.type)) preventSingles.add(noteKey(note));
    }
  }
  for (const note of score.directionalNotes) {
    const key = noteKey(note);
    if (note.type === 1) flickMods.set(key, "up");
    else if (note.type === 3) flickMods.set(key, "left");
    else if (note.type === 4) flickMods.set(key, "right");
    else if (note.type === 2) easeMods.set(key, "in");
    else if (note.type === 5 || note.type === 6) easeMods.set(key, "out");
  }
  for (const note of score.tapNotes) {
    const key = noteKey(note);
    if (note.type === 2) criticalMods.add(key);
    else if (note.type === 5) traceMods.add(key);
    else if (note.type === 6) {
      traceMods.add(key);
      criticalMods.add(key);
    } else if (note.type === 3) tickRemoveMods.add(key);
    else if (note.type === 7) slideStartEndRemoveMods.add(key);
    else if (note.type === 8) {
      criticalMods.add(key);
      slideStartEndRemoveMods.add(key);
    }
  }

  const objects: UscObject[] = [
    ...score.timeScaleChanges.map((change) => ({
      type: "timeScale" as const,
      beat: change.tick / score.ticksPerBeat,
      timeScale: change.timeScale,
    })),
    ...score.bpmChanges.map((change) => ({
      type: "bpm" as const,
      beat: change.tick / score.ticksPerBeat,
      bpm: change.bpm,
    })),
  ];

  for (const note of score.tapNotes) {
    if (note.lane <= 1 || note.lane >= 14) continue;
    if (![1, 2, 5, 6].includes(note.type)) continue;
    const key = noteKey(note);
    if (preventSingles.has(key) || dedupeSingles.has(key)) continue;
    dedupeSingles.add(key);
    const direction = flickMods.get(key);
    objects.push({
      type: "single",
      beat: note.tick / score.ticksPerBeat,
      lane: note.lane - 8 + note.width / 2,
      size: note.width / 2,
      trace: note.type === 5 || note.type === 6,
      critical: note.type === 2 || note.type === 6,
      ...(direction === undefined ? {} : { direction }),
    });
  }

  for (const slide of score.slides) {
    const start = slide.notes.find((note) => note.type === 1 || note.type === 2);
    if (!start) continue;
    const object: UscSlideNote = {
      type: "slide",
      active: slide.type === 3,
      critical: criticalMods.has(noteKey(start)),
      connections: [],
    };
    for (const note of slide.notes) {
      const key = noteKey(note);
      const common = {
        beat: note.tick / score.ticksPerBeat,
        lane: note.lane - 8 + note.width / 2,
        size: note.width / 2,
      };
      const trace = traceMods.has(key);
      const critical = object.critical || criticalMods.has(key);
      const ease = easeMods.get(key) ?? "linear";
      let connection: UscConnection | undefined;
      if (note.type === 1) {
        connection =
          !object.active || slideStartEndRemoveMods.has(key)
            ? { type: "ignore", ...common, ease }
            : { type: "start", ...common, trace, critical, ease };
      } else if (note.type === 2) {
        const direction = flickMods.get(key);
        connection =
          !object.active || slideStartEndRemoveMods.has(key)
            ? { type: "ignore", ...common, ease }
            : { type: "end", ...common, trace, critical, ...(direction === undefined ? {} : { direction }) };
      } else if (note.type === 3) {
        connection = tickRemoveMods.has(key)
          ? ({ type: "attach", beat: common.beat, critical } satisfies UscAttachConnection)
          : { type: "tick", ...common, trace, critical, ease };
      } else if (note.type === 5 && !tickRemoveMods.has(key)) {
        connection = { type: "ignore", ...common, ease } satisfies UscIgnoreConnection;
      }
      if (connection) object.connections.push(connection);
    }
    if (object.connections.length < 2) continue;
    objects.push(object);
    if (!object.active) continue;
    const key = noteKey(start);
    const duplicate = dedupeSlides.get(key);
    if (duplicate) objects.splice(objects.indexOf(duplicate), 1);
    dedupeSlides.set(key, object);
  }

  return { offset: score.offset, objects };
};

/** Convert SUS using the same note/modifier rules as the MIT-licensed Next-SEKAI converter. */
export const susToUsc = (input: string | Uint8Array): UscChart => analysisToUsc(analyzeSus(input));

const meterSignature = (length: number): Pick<MeterEvent, "numerator" | "denominator"> => {
  for (const denominator of [4, 8, 16, 32, 64, 2, 1]) {
    const numerator = (length * denominator) / 4;
    if (Number.isSafeInteger(numerator) && numerator > 0) return { numerator, denominator };
  }
  return { numerator: Math.max(1, Math.round(length * 16)), denominator: 64 };
};

const susMeta = (meta: Readonly<Record<string, string>>): ProjectMeta => {
  const difficulty = unquote(meta.DIFFICULTY);
  const level = unquote(meta.PLAYLEVEL);
  return importedMeta("sus", {
    title: unquote(meta.TITLE),
    artist: unquote(meta.ARTIST),
    charter: unquote(meta.DESIGNER),
    difficulty,
    level,
    extra: {
      susDifficulty: difficulty,
      susPlayLevel: level,
    },
  });
};

export const importSus = (input: string | Uint8Array): ImportResult => {
  const analysis = analyzeSus(input);
  const usc = analysisToUsc(analysis);
  const imported = importUsc(usc, { laneBasis: analysis.laneCount });
  const toTick = createToTick(analysis.barLengths, analysis.ticksPerBeat);
  const meters = analysis.barLengths.map((bar, index) => ({
    id: importedId("sus", "meter", index),
    tick: Math.round((toTick(bar.measure, 0, 1) * 480) / analysis.ticksPerBeat),
    ...meterSignature(bar.length),
  }));
  const extensions: Record<string, JsonValue> = {
    sus: {
      ticksPerBeat: analysis.ticksPerBeat,
      laneCount: analysis.laneCount,
      meta: { ...analysis.meta },
    },
  };
  return finishImport(
    "sus",
    {
      ...imported.project,
      laneBasis: analysis.laneCount,
      meta: susMeta(analysis.meta),
      meters,
      extensions,
    },
    [...analysis.warnings, ...imported.warnings],
  );
};

export { SUS_DEFAULT_LANE_BASIS };
