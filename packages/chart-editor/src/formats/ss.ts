import {
  importedId,
  resolveLinePointShape,
  structuredCloneValue,
  tickToBeat,
  type EaseType,
  type JsonValue,
  type LineEase,
  type LinePoint,
  type NoteDirection,
  type NoteType,
  type Project,
  type SingleNote,
} from "../model";
import {
  ChartFormatError,
  finishImport,
  finiteNumber,
  importedMeta,
  importedProject,
  isRecord,
  jsonInput,
  type FormatWarning,
  type ImportResult,
} from "./shared";
import { restoreSourceRecord, sourceRecord } from "./source-record";
import { assertValidProject } from "../validation";

export interface SsBpm {
  t: number;
  bpm: number;
}

export interface SsMeter {
  t: number;
  sig: [number, number];
}

export interface SsCall {
  t: number;
  timing: number[];
}

export interface SsNote {
  type?: "tap" | "node" | "flick" | "trace" | "long" | "guide";
  t?: number;
  pos?: number | "auto";
  size?: number;
  crit?: boolean;
  dir?: "left" | "up" | "right" | "down";
  alpha?: "none" | "in" | "out";
  ease?: EaseType | [EaseType, EaseType];
  visible?: boolean;
  node?: SsNote[];
}

export interface SsDocument {
  meta: { version: number };
  score: {
    events: {
      bpm: SsBpm[];
      sig: SsMeter[];
      skill: number[];
      fever: [number, number][];
      call: SsCall[];
    };
    notes: SsNote[];
  };
}

const normalizedTick = (value: unknown, path: string, warnings: FormatWarning[]): number => {
  const raw = finiteNumber(value, 0);
  const result = Math.round(raw);
  if (result !== raw)
    warnings.push({ code: "ss.tick.rounded", path, message: `Fractional tick ${raw} was rounded to ${result}` });
  return result;
};

const noteType = (value: unknown): NoteType => (value === "flick" || value === "trace" ? value : "tap");
const direction = (value: unknown): NoteDirection =>
  value === "left" || value === "up" || value === "right" ? value : "none";
const easeValue = (value: unknown): EaseType => (value === "in" || value === "out" ? value : "linear");
const easePair = (value: unknown, fallback: unknown): LineEase => {
  const source = value ?? fallback;
  if (Array.isArray(source)) return { left: easeValue(source[0]), right: easeValue(source[1] ?? source[0]) };
  const ease = easeValue(source);
  return { left: ease, right: ease };
};

const parseSingle = (value: unknown, index: number, warnings: FormatWarning[]): SingleNote | undefined => {
  const path = `$.score.notes[${index}]`;
  if (!isRecord(value)) {
    warnings.push({ code: "ss.note.skipped", path, message: "Non-object note was skipped" });
    return undefined;
  }
  const lane = finiteNumber(value.pos, 0);
  if (!Number.isFinite(value.pos))
    warnings.push({ code: "ss.note.defaultLane", path: `${path}.pos`, message: "Missing lane defaulted to 0" });
  const dir = direction(value.dir);
  const sourceType = noteType(value.type);
  const type: NoteType = sourceType;
  return {
    id: importedId("ss", "single", index),
    tick: normalizedTick(value.t, `${path}.t`, warnings),
    lane,
    size: finiteNumber(value.size, 6),
    type,
    critical: value.crit === true,
    direction: type === "flick" ? (dir === "none" ? "up" : dir) : "none",
    visible: value.visible !== false,
  };
};

const parseLine = (value: Record<string, unknown>, index: number, warnings: FormatWarning[]) => {
  const path = `$.score.notes[${index}]`;
  if (!Array.isArray(value.node)) {
    warnings.push({ code: "ss.line.skipped", path, message: "Line without node array was skipped" });
    return undefined;
  }
  const points: LinePoint[] = value.node.flatMap((rawPoint, pointIndex) => {
    const pointPath = `${path}.node[${pointIndex}]`;
    if (!isRecord(rawPoint)) {
      warnings.push({ code: "ss.point.skipped", path: pointPath, message: "Non-object line point was skipped" });
      return [];
    }
    const lane = rawPoint.pos === "auto" ? "auto" : finiteNumber(rawPoint.pos, 0);
    const hasAuthoredSize = typeof rawPoint.size === "number" && Number.isFinite(rawPoint.size);
    if (rawPoint.pos !== "auto" && !Number.isFinite(rawPoint.pos)) {
      warnings.push({ code: "ss.point.defaultLane", path: `${pointPath}.pos`, message: "Missing lane defaulted to 0" });
    }
    const dir = direction(rawPoint.dir);
    const sourceType = noteType(rawPoint.type);
    const type: NoteType = sourceType;
    return [
      {
        id: importedId("ss", "line", index, "point", pointIndex),
        tick: normalizedTick(rawPoint.t, `${pointPath}.t`, warnings),
        lane,
        size: finiteNumber(rawPoint.size, 6),
        ...(lane === "auto" && !hasAuthoredSize ? { autoSize: true } : {}),
        type,
        critical: rawPoint.crit === true,
        direction: type === "flick" ? (dir === "none" ? "up" : dir) : "none",
        visible: rawPoint.visible !== false,
        ease: easePair(rawPoint.ease, value.ease),
      } satisfies LinePoint,
    ];
  });
  const sorted = points.sort((a, b) => a.tick - b.tick);
  for (const [pointIndex, point] of sorted.entries()) {
    if (point.lane === "auto") {
      const shape = resolveLinePointShape(sorted, pointIndex);
      point.resolvedLane = shape.lane;
      point.resolvedSize = shape.size;
    }
  }
  return {
    id: importedId("ss", "line", index),
    kind: value.type === "guide" ? ("guide" as const) : ("long" as const),
    ...(typeof value.crit === "boolean" ? { critical: value.crit } : {}),
    points: sorted,
  };
};

const numericArray = (value: unknown): number[] =>
  Array.isArray(value) ? value.filter((item): item is number => typeof item === "number" && Number.isFinite(item)) : [];

export const importSs = (input: string | Uint8Array | unknown): ImportResult => {
  const root = jsonInput(input, "ss");
  if (!isRecord(root)) throw new ChartFormatError("ss", "SS root must be an object");
  const score = isRecord(root.score) ? root.score : root;
  const events = isRecord(score.events) ? score.events : score;
  const rawNotes = Array.isArray(score.notes) ? score.notes : Array.isArray(root.notes) ? root.notes : undefined;
  if (!rawNotes) throw new ChartFormatError("ss", "Missing score.notes", "$.score.notes");
  const warnings: FormatWarning[] = [];
  const singles: SingleNote[] = [];
  const lines = [];
  const sourceOrder: string[] = [];
  for (const [index, rawNote] of rawNotes.entries()) {
    if (isRecord(rawNote) && (rawNote.type === "long" || rawNote.type === "guide")) {
      const line = parseLine(rawNote, index, warnings);
      if (line) {
        lines.push(line);
        sourceOrder.push(line.id);
      }
    } else {
      const single = parseSingle(rawNote, index, warnings);
      if (single) {
        singles.push(single);
        sourceOrder.push(single.id);
      }
    }
  }

  const rawBpms = Array.isArray(events.bpm) ? events.bpm : [];
  const tempos = rawBpms.flatMap((item, index) => {
    if (!isRecord(item) || !Number.isFinite(item.bpm)) {
      warnings.push({
        code: "ss.tempo.skipped",
        path: `$.score.events.bpm[${index}]`,
        message: "Invalid tempo was skipped",
      });
      return [];
    }
    return [
      {
        id: importedId("ss", "tempo", index),
        tick: normalizedTick(item.t, `$.score.events.bpm[${index}].t`, warnings),
        bpm: item.bpm as number,
      },
    ];
  });
  const rawMeters = Array.isArray(events.sig) ? events.sig : [];
  const meters = rawMeters.flatMap((item, index) => {
    if (!isRecord(item) || !Array.isArray(item.sig) || item.sig.length < 2) {
      warnings.push({
        code: "ss.meter.skipped",
        path: `$.score.events.sig[${index}]`,
        message: "Invalid meter was skipped",
      });
      return [];
    }
    return [
      {
        id: importedId("ss", "meter", index),
        tick: normalizedTick(item.t, `$.score.events.sig[${index}].t`, warnings),
        numerator: Math.round(finiteNumber(item.sig[0], 4)),
        denominator: Math.round(finiteNumber(item.sig[1], 4)),
      },
    ];
  });

  const metaRoot = isRecord(root.meta) ? root.meta : {};
  const skill = numericArray(events.skill ?? root.skill);
  const fever = Array.isArray(events.fever)
    ? events.fever.flatMap((item) =>
        Array.isArray(item) && item.length >= 2
          ? [[finiteNumber(item[0], 0), finiteNumber(item[1], 0)] as [number, number]]
          : [],
      )
    : [];
  const call = Array.isArray(events.call)
    ? events.call.flatMap((item) =>
        isRecord(item) ? [{ t: finiteNumber(item.t, 0), timing: numericArray(item.timing) }] : [],
      )
    : [];
  const extra: Record<string, JsonValue> = { ssVersion: finiteNumber(metaRoot.version ?? root.version, 1) };
  const meta = importedMeta("ss", { extra });
  const project = importedProject("ss", {
    meta,
    laneBasis: 24,
    tempos,
    meters,
    singles,
    lines,
    markers: {
      skill: skill.map((item) => Math.round(item)),
      fever: fever.map(([start, end]) => [Math.round(start), Math.round(end)]),
      call: call.map((item) => ({ tick: Math.round(item.t), timing: item.timing })),
    },
    extensions: {},
    sourceOrder,
  });
  const result = finishImport("ss", project, warnings);
  const records: Record<string, ReturnType<typeof sourceRecord>> = {};
  const singlesById = new Map(result.project.singles.map((entry) => [entry.id, entry]));
  const linesById = new Map(result.project.lines.map((entry) => [entry.id, entry]));
  rawNotes.forEach((raw, index) => {
    if (!isRecord(raw)) return;
    const single = singlesById.get(importedId("ss", "single", index));
    if (single) records[single.id] = sourceRecord(raw, encodeSingle(single, 1));
    const connector = linesById.get(importedId("ss", "line", index));
    if (connector) {
      const { node: _nodes, ...header } = raw;
      records[connector.id] = sourceRecord(header, { type: connector.kind, crit: connector.critical });
      const originals = new Map(
        (Array.isArray(raw.node) ? raw.node : []).map((entry, at) => [
          importedId("ss", "line", index, "point", at),
          entry,
        ]),
      );
      connector.points.forEach((point) => {
        const original = originals.get(point.id);
        if (isRecord(original)) records[point.id] = sourceRecord(original, encodePoint(point, 1));
      });
    }
  });
  const originalBpms = new Map(rawBpms.map((entry, index) => [importedId("ss", "tempo", index), entry]));
  result.project.tempos.forEach((event) => {
    const original = originalBpms.get(event.id);
    if (isRecord(original)) records[event.id] = sourceRecord(original, { t: event.tick, bpm: event.bpm });
  });
  const originalMeters = new Map(rawMeters.map((entry, index) => [importedId("ss", "meter", index), entry]));
  result.project.meters.forEach((event) => {
    const original = originalMeters.get(event.id);
    if (isRecord(original))
      records[event.id] = sourceRecord(original, { t: event.tick, sig: [event.numerator, event.denominator] });
  });
  const { score: _score, meta: _meta, ...rootExtras } = root;
  const { notes: _notes, events: _events, ...scoreExtras } = score;
  result.project.extensions.ssSource = {
    schema: "haneoka-ss-source-v1",
    root: structuredCloneValue(rootExtras) as Record<string, JsonValue>,
    score: structuredCloneValue(scoreExtras) as Record<string, JsonValue>,
    meta: sourceRecord(metaRoot, { version: extra.ssVersion }) as unknown as JsonValue,
    records: records as unknown as JsonValue,
    events: sourceRecord(events, ssEvents(result.project, records)) as unknown as JsonValue,
  };
  assertValidProject(result.project);
  return result;
};

const rawType = (type: NoteType): SsNote["type"] => (type === "tap" ? undefined : type);
const rawDirection = (directionValue: NoteDirection, type: NoteType): SsNote["dir"] => {
  if (directionValue === "left" || directionValue === "right") return directionValue;
  // Plain upward flick is SS's direction-less default. `up` is only needed to
  // retain USC's otherwise unrepresentable trace-flick combination.
  return directionValue === "up" && type === "trace" ? "up" : undefined;
};
const rawEase = (ease: LineEase): SsNote["ease"] => (ease.left === ease.right ? ease.left : [ease.left, ease.right]);

const encodeSingle = (note: SingleNote, scale: number): Record<string, unknown> => ({
  type: rawType(note.type),
  t: note.tick,
  pos: note.lane * scale,
  size: note.size * scale,
  crit: note.critical ? true : undefined,
  dir: rawDirection(note.direction, note.type),
  visible: note.visible ? undefined : false,
});
const encodePoint = (point: LinePoint, scale: number): Record<string, unknown> => ({
  ...encodeSingle({ ...point, lane: typeof point.lane === "number" ? point.lane : 0 }, scale),
  pos: point.lane === "auto" ? "auto" : point.lane * scale,
  size: point.autoSize ? undefined : point.size * scale,
  ease: rawEase(point.ease),
});
const restoreNoteSource = (record: unknown, current: Record<string, unknown>): SsNote => {
  const restored = restoreSourceRecord(record, current);
  // Direction is interpreted with note type. A type edit must also clear an
  // old ignored dir when both the new default-up and old tap encode undefined.
  if (
    isRecord(record) &&
    isRecord(record.baseline) &&
    (record.baseline.type !== current.type || record.baseline.dir !== current.dir)
  ) {
    if (current.dir === undefined) delete restored.dir;
    else restored.dir = current.dir as JsonValue;
  }
  return restored as SsNote;
};
const ssEvents = (project: Project, records: Record<string, unknown>) => ({
  bpm: project.tempos.map((tempo) => restoreSourceRecord(records[tempo.id], { t: tempo.tick, bpm: tempo.bpm })),
  sig: project.meters.map((meter) =>
    restoreSourceRecord(records[meter.id], { t: meter.tick, sig: [meter.numerator, meter.denominator] }),
  ),
  skill: [...project.markers.skill],
  fever: project.markers.fever.map((pair) => [...pair]),
  call: project.markers.call.map((item) => ({ t: item.tick, timing: [...item.timing] })),
});

export const projectToSs = (project: Project): SsDocument => {
  const version = finiteNumber(project.meta.extra?.ssVersion, 1);
  const scale = 24 / project.laneBasis;
  const snapshot =
    isRecord(project.extensions.ssSource) && project.extensions.ssSource.schema === "haneoka-ss-source-v1"
      ? project.extensions.ssSource
      : undefined;
  const records = isRecord(snapshot?.records) ? snapshot.records : {};
  const noteById = new Map<string, SsNote>();
  for (const note of project.singles) {
    noteById.set(note.id, restoreNoteSource(records[note.id], encodeSingle(note, scale)));
  }
  for (const line of project.lines) {
    noteById.set(line.id, {
      ...restoreSourceRecord(records[line.id], { type: line.kind, crit: line.critical }),
      node: [...line.points]
        .sort((a, b) => a.tick - b.tick)
        .map((point) => restoreNoteSource(records[point.id], encodePoint(point, scale))),
    } as SsNote);
  }
  const notes: SsNote[] = [];
  for (const id of project.sourceOrder ?? []) {
    const note = noteById.get(id);
    if (!note) continue;
    notes.push(note);
    noteById.delete(id);
  }
  notes.push(...noteById.values());
  return {
    ...(isRecord(snapshot?.root) ? structuredCloneValue(snapshot.root) : {}),
    meta: restoreSourceRecord(snapshot?.meta, { version }) as SsDocument["meta"],
    score: {
      ...(isRecord(snapshot?.score) ? structuredCloneValue(snapshot.score) : {}),
      events: restoreSourceRecord(
        snapshot?.events,
        ssEvents(project, records),
      ) as unknown as SsDocument["score"]["events"],
      notes,
    },
  };
};

export const serializeSs = (project: Project, pretty = true): string =>
  JSON.stringify(projectToSs(project), null, pretty ? 2 : undefined);

export const ssNoteBeat = (note: SsNote): number => tickToBeat(note.t ?? 0);
