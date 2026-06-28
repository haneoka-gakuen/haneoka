import {
  beatToTick,
  importedId,
  resolveLinePointLane,
  resolveLinePointSize,
  tickToBeat,
  type EaseType,
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

export type UscDirection = "left" | "up" | "right";
export type UscEase = "in" | "linear" | "out";

export interface UscBpmChange {
  type: "bpm";
  beat: number;
  bpm: number;
}

export interface UscTimeScaleChange {
  type: "timeScale";
  beat: number;
  timeScale: number;
}

export interface UscSingleNote {
  type: "single";
  beat: number;
  lane: number;
  size: number;
  trace: boolean;
  critical: boolean;
  direction?: UscDirection;
}

interface UscSpatialConnection {
  beat: number;
  lane: number;
  size: number;
}

export interface UscStartConnection extends UscSpatialConnection {
  type: "start";
  trace: boolean;
  critical: boolean;
  ease: UscEase;
  easeL?: UscEase;
  easeR?: UscEase;
}

export interface UscTickConnection extends UscSpatialConnection {
  type: "tick";
  trace: boolean;
  critical: boolean;
  ease: UscEase;
  easeL?: UscEase;
  easeR?: UscEase;
}

export interface UscEndConnection extends UscSpatialConnection {
  type: "end";
  trace: boolean;
  critical: boolean;
  direction?: UscDirection;
}

export interface UscIgnoreConnection extends UscSpatialConnection {
  type: "ignore";
  ease: UscEase;
  easeL?: UscEase;
  easeR?: UscEase;
}

export interface UscHiddenConnection {
  type: "hidden";
  beat: number;
}

export interface UscAttachConnection {
  type: "attach";
  beat: number;
  critical: boolean;
}

export type UscConnection =
  | UscStartConnection
  | UscTickConnection
  | UscEndConnection
  | UscIgnoreConnection
  | UscHiddenConnection
  | UscAttachConnection;

export interface UscSlideNote {
  type: "slide";
  active: boolean;
  critical: boolean;
  connections: UscConnection[];
}

export type UscObject = UscBpmChange | UscTimeScaleChange | UscSingleNote | UscSlideNote;

export interface UscChart {
  offset: number;
  objects: UscObject[];
}

export interface WrappedUscChart {
  version: number;
  usc: UscChart;
}

const direction = (value: unknown): NoteDirection =>
  value === "left" || value === "up" || value === "right" ? value : "none";
const ease = (value: unknown): EaseType => (value === "in" || value === "out" ? value : "linear");
const pointEase = (connection: Record<string, unknown>): LineEase => ({
  left: ease(connection.easeL ?? connection.ease),
  right: ease(connection.easeR ?? connection.ease),
});
const normalizedTick = (beat: unknown, path: string, warnings: FormatWarning[]): number => {
  if (typeof beat !== "number" || !Number.isFinite(beat))
    throw new ChartFormatError("usc", "Beat must be finite", path);
  const tick = beatToTick(beat);
  if (Math.abs(tickToBeat(tick) - beat) > 1e-7) {
    warnings.push({ code: "usc.beat.rounded", path, message: `Beat ${beat} was normalized to tick ${tick}` });
  }
  return tick;
};

const fromUscShape = (lane: number, size: number, laneBasis: number): { lane: number; size: number } => {
  const width = (size * laneBasis) / 6;
  return {
    lane: ((lane + 6) * laneBasis) / 12 - width / 2,
    size: width,
  };
};

const toUscShape = (lane: number, size: number, laneBasis: number): { lane: number; size: number } => ({
  lane: ((lane + size / 2) * 12) / laneBasis - 6,
  size: (size * 6) / laneBasis,
});

const isSpatial = (
  connection: Record<string, unknown>,
): connection is Record<string, unknown> & { lane: number; size: number } =>
  typeof connection.lane === "number" &&
  Number.isFinite(connection.lane) &&
  typeof connection.size === "number" &&
  Number.isFinite(connection.size);

const shapeForNonSpatial = (
  connections: readonly unknown[],
  index: number,
  laneBasis: number,
): { lane: number; size: number } | undefined => {
  const spatialAt = (candidateIndex: number) => {
    const candidate = connections[candidateIndex];
    return isRecord(candidate) && isSpatial(candidate) ? candidate : undefined;
  };
  let leftIndex = index - 1;
  while (leftIndex >= 0 && !spatialAt(leftIndex)) leftIndex -= 1;
  let rightIndex = index + 1;
  while (rightIndex < connections.length && !spatialAt(rightIndex)) rightIndex += 1;
  const left = leftIndex >= 0 ? spatialAt(leftIndex) : undefined;
  const right = rightIndex < connections.length ? spatialAt(rightIndex) : undefined;
  if (!left && !right) return undefined;
  if (!left) return fromUscShape(right!.lane, right!.size, laneBasis);
  if (!right) return fromUscShape(left.lane, left.size, laneBasis);
  const current = isRecord(connections[index]) ? finiteNumber(connections[index].beat, 0) : 0;
  const leftBeat = finiteNumber(left.beat, current);
  const rightBeat = finiteNumber(right.beat, current);
  const progress = rightBeat === leftBeat ? 0 : Math.min(1, Math.max(0, (current - leftBeat) / (rightBeat - leftBeat)));
  return fromUscShape(
    left.lane + (right.lane - left.lane) * progress,
    left.size + (right.size - left.size) * progress,
    laneBasis,
  );
};

const parseSingle = (
  object: Record<string, unknown>,
  index: number,
  laneBasis: number,
  warnings: FormatWarning[],
): SingleNote => {
  if (!isSpatial(object))
    throw new ChartFormatError("usc", "Single note requires finite lane and size", `$.objects[${index}]`);
  const shape = fromUscShape(object.lane, object.size, laneBasis);
  const dir = direction(object.direction);
  const type: NoteType = object.trace === true ? "trace" : dir !== "none" ? "flick" : "tap";
  return {
    id: importedId("usc", "single", index),
    tick: normalizedTick(object.beat, `$.objects[${index}].beat`, warnings),
    ...shape,
    type,
    critical: object.critical === true,
    direction: type === "flick" && dir === "none" ? "up" : dir,
    visible: true,
  };
};

const parseSlide = (
  object: Record<string, unknown>,
  objectIndex: number,
  laneBasis: number,
  warnings: FormatWarning[],
) => {
  if (!Array.isArray(object.connections)) {
    throw new ChartFormatError("usc", "Slide requires a connections array", `$.objects[${objectIndex}].connections`);
  }
  const points: LinePoint[] = [];
  for (const [connectionIndex, raw] of object.connections.entries()) {
    const path = `$.objects[${objectIndex}].connections[${connectionIndex}]`;
    if (!isRecord(raw) || !["start", "tick", "end", "ignore", "hidden", "attach"].includes(String(raw.type))) {
      warnings.push({ code: "usc.connection.skipped", path, message: "Unknown slide connection was skipped" });
      continue;
    }
    let shape: { lane: number; size: number } | undefined;
    if (isSpatial(raw)) shape = fromUscShape(raw.lane, raw.size, laneBasis);
    else {
      shape = shapeForNonSpatial(object.connections, connectionIndex, laneBasis);
      warnings.push({
        code: `usc.${String(raw.type)}.degraded`,
        path,
        message: `${String(raw.type)} has no authored lane; an invisible interpolated point was retained`,
      });
    }
    if (!shape) {
      warnings.push({
        code: "usc.connection.noShape",
        path,
        message: "Connection could not be placed and was skipped",
      });
      continue;
    }
    const dir = direction(raw.direction);
    const trace = raw.trace === true;
    const type: NoteType = trace ? "trace" : dir !== "none" ? "flick" : "tap";
    points.push({
      id: importedId("usc", "line", objectIndex, "point", connectionIndex),
      tick: normalizedTick(raw.beat, `${path}.beat`, warnings),
      ...shape,
      type,
      critical: raw.critical === true,
      direction: type === "flick" && dir === "none" ? "up" : dir,
      visible: raw.type !== "ignore" && raw.type !== "hidden" && raw.type !== "attach",
      ease: pointEase(raw),
    });
  }
  if (points.length < 2) {
    warnings.push({
      code: "usc.slide.skipped",
      path: `$.objects[${objectIndex}]`,
      message: "Slide with fewer than two usable points was skipped",
    });
    return undefined;
  }
  return {
    id: importedId("usc", "line", objectIndex),
    kind: object.active === false ? ("guide" as const) : ("long" as const),
    critical: object.critical === true,
    points: points.sort((a, b) => a.tick - b.tick),
  };
};

export const importUsc = (input: string | Uint8Array | unknown, options: { laneBasis?: number } = {}): ImportResult => {
  const root = jsonInput(input, "usc");
  if (!isRecord(root)) throw new ChartFormatError("usc", "USC root must be an object");
  const wrapped = isRecord(root.usc);
  const usc = wrapped ? (root.usc as Record<string, unknown>) : root;
  if (!Array.isArray(usc.objects)) throw new ChartFormatError("usc", "Missing objects array", "$.objects");
  const laneBasis = options.laneBasis ?? 24;
  if (!Number.isFinite(laneBasis) || laneBasis <= 0) throw new ChartFormatError("usc", "Lane basis must be positive");
  const warnings: FormatWarning[] = [];
  const tempos = [];
  const timeScales = [];
  const singles: SingleNote[] = [];
  const lines = [];
  const sourceOrder: string[] = [];
  for (const [index, rawObject] of usc.objects.entries()) {
    const path = `$.objects[${index}]`;
    if (!isRecord(rawObject)) {
      warnings.push({ code: "usc.object.skipped", path, message: "Non-object entry was skipped" });
      continue;
    }
    if (rawObject.type === "bpm") {
      const id = importedId("usc", "tempo", index);
      tempos.push({
        id,
        tick: normalizedTick(rawObject.beat, `${path}.beat`, warnings),
        bpm: finiteNumber(rawObject.bpm, 0),
      });
      sourceOrder.push(id);
    } else if (rawObject.type === "timeScale") {
      const id = importedId("usc", "timeScale", index);
      timeScales.push({
        id,
        tick: normalizedTick(rawObject.beat, `${path}.beat`, warnings),
        scale: finiteNumber(rawObject.timeScale, 0),
      });
      sourceOrder.push(id);
    } else if (rawObject.type === "single") {
      const single = parseSingle(rawObject, index, laneBasis, warnings);
      singles.push(single);
      sourceOrder.push(single.id);
    } else if (rawObject.type === "slide") {
      const line = parseSlide(rawObject, index, laneBasis, warnings);
      if (line) {
        lines.push(line);
        sourceOrder.push(line.id);
      }
    } else {
      warnings.push({
        code: "usc.object.unknown",
        path,
        message: `Unknown USC object type ${String(rawObject.type)} was skipped`,
      });
    }
  }
  const extra = wrapped && Number.isFinite(root.version) ? { uscVersion: root.version as number } : undefined;
  const project = importedProject("usc", {
    laneBasis,
    meta: importedMeta("usc", extra ? { extra } : {}),
    audioOffset: finiteNumber(usc.offset, 0),
    tempos,
    timeScales,
    singles,
    lines,
    sourceOrder,
  });
  return finishImport("usc", project, warnings);
};

const uscDirection = (value: NoteDirection, force = false): UscDirection | undefined =>
  value === "left" || value === "right" || value === "up" ? value : force ? "up" : undefined;
const uscEase = (value: EaseType): UscEase => value;
const connectionEase = (point: LinePoint) => ({
  ease: uscEase(point.ease.right),
  easeL: uscEase(point.ease.left),
  easeR: uscEase(point.ease.right),
});

export const projectToUsc = (project: Project): UscChart => {
  const objectById = new Map<string, UscObject>();
  for (const tempo of project.tempos) {
    objectById.set(tempo.id, { type: "bpm", beat: tickToBeat(tempo.tick, project.resolution), bpm: tempo.bpm });
  }
  for (const event of project.timeScales) {
    objectById.set(event.id, {
      type: "timeScale",
      beat: tickToBeat(event.tick, project.resolution),
      timeScale: event.scale,
    });
  }
  for (const note of project.singles) {
    const flick = note.type === "flick";
    const direction = uscDirection(note.direction, flick);
    const object: UscSingleNote = {
      type: "single",
      beat: tickToBeat(note.tick, project.resolution),
      ...toUscShape(note.lane, note.size, project.laneBasis),
      trace: note.type === "trace",
      critical: note.critical,
    };
    if (direction !== undefined) object.direction = direction;
    objectById.set(note.id, object);
  }
  for (const line of project.lines) {
    const points = [...line.points].sort((a, b) => a.tick - b.tick || a.id.localeCompare(b.id));
    if (points.length < 2) continue;
    const connections: UscConnection[] = points.map((point, index) => {
      const lane = point.lane === "auto" ? resolveLinePointLane(points, index) : point.lane;
      const size = point.lane === "auto" ? resolveLinePointSize(points, index) : point.size;
      const common = {
        beat: tickToBeat(point.tick, project.resolution),
        ...toUscShape(lane, size, project.laneBasis),
      };
      const first = index === 0;
      const last = index === points.length - 1;
      // Inactive USC slides are represented entirely by ignored joints.
      // Emitting a visible trace as `tick` at either endpoint is invalid for
      // the Sonolus converter, whose endpoint grammar only accepts ignore.
      if (line.kind === "guide" || !point.visible) {
        return { type: "ignore", ...common, ...connectionEase(point) };
      }
      if (last) {
        const flick = point.type === "flick";
        const direction = uscDirection(point.direction, flick);
        const connection: UscEndConnection = {
          type: "end",
          ...common,
          trace: point.type === "trace",
          critical: point.critical,
        };
        if (direction !== undefined) connection.direction = direction;
        return connection;
      }
      if (first && line.kind === "long") {
        return {
          type: "start",
          ...common,
          trace: point.type === "trace",
          critical: point.critical,
          ...connectionEase(point),
        };
      }
      return {
        type: "tick",
        ...common,
        trace: point.type === "trace",
        critical: point.critical,
        ...connectionEase(point),
      } satisfies UscTickConnection;
    });
    objectById.set(line.id, {
      type: "slide",
      active: line.kind === "long",
      critical: line.critical ?? points.some((point) => point.critical),
      connections,
    });
  }
  const objects: UscObject[] = [];
  for (const id of project.sourceOrder ?? []) {
    const object = objectById.get(id);
    if (!object) continue;
    objects.push(object);
    objectById.delete(id);
  }
  objects.push(...objectById.values());
  return { offset: project.audioOffset, objects };
};

export const projectToWrappedUsc = (project: Project, version = 2): WrappedUscChart => ({
  version,
  usc: projectToUsc(project),
});

export const serializeUsc = (
  project: Project,
  options: { wrapped?: boolean; version?: number; pretty?: boolean } = {},
): string => {
  const value = options.wrapped ? projectToWrappedUsc(project, options.version ?? 2) : projectToUsc(project);
  return JSON.stringify(value, null, options.pretty === false ? undefined : 2);
};

export const uscShapeToProject = fromUscShape;
export const projectShapeToUsc = toUscShape;
