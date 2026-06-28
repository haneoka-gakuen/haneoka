import {
  LANE_COUNT,
  PROJECT_RESOLUTION,
  PROJECT_VERSION,
  type EaseType,
  type NoteDirection,
  type NoteType,
  type Project,
} from "./model";

export type ValidationSeverity = "error" | "warning";

export interface ValidationIssue {
  severity: ValidationSeverity;
  code: string;
  path: string;
  message: string;
}

export interface ProjectValidationResult {
  valid: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

const noteTypes = new Set<NoteType>(["tap", "flick", "trace"]);
const directions = new Set<NoteDirection>(["none", "left", "up", "right"]);
const eases = new Set<EaseType>(["linear", "in", "out"]);

const record = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const tick = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

export const validateProject = (value: unknown): ProjectValidationResult => {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const add = (severity: ValidationSeverity, code: string, path: string, message: string) => {
    (severity === "error" ? errors : warnings).push({ severity, code, path, message });
  };
  if (!record(value)) {
    add("error", "project.type", "$", "Project must be an object");
    return { valid: false, errors, warnings };
  }

  if (value.version !== PROJECT_VERSION) {
    add("error", "project.version", "$.version", `Project version must be ${PROJECT_VERSION}`);
  }
  if (value.resolution !== PROJECT_RESOLUTION) {
    add("error", "project.resolution", "$.resolution", `Project resolution must be ${PROJECT_RESOLUTION}`);
  }
  if (!finite(value.laneBasis) || value.laneBasis <= 0) {
    add("error", "project.laneBasis", "$.laneBasis", "Lane basis must be finite and positive");
  }
  if (!finite(value.audioOffset)) add("error", "project.audioOffset", "$.audioOffset", "Audio offset must be finite");

  if (!record(value.meta)) {
    add("error", "meta.type", "$.meta", "Project metadata must be an object");
  } else {
    for (const key of ["title", "artist", "charter", "difficulty", "level"] as const) {
      if (typeof value.meta[key] !== "string") add("error", "meta.field", `$.meta.${key}`, `${key} must be a string`);
    }
    if (value.meta.source !== undefined && typeof value.meta.source !== "string") {
      add("error", "meta.source", "$.meta.source", "Metadata source must be a string");
    }
    if (
      value.meta.tags !== undefined &&
      (!Array.isArray(value.meta.tags) || value.meta.tags.some((item) => typeof item !== "string"))
    ) {
      add("error", "meta.tags", "$.meta.tags", "Metadata tags must be strings");
    }
    if (value.meta.extra !== undefined && !record(value.meta.extra)) {
      add("error", "meta.extra", "$.meta.extra", "Metadata extra must be a JSON object");
    }
  }

  const usedIds = new Map<string, string>();
  const checkId = (id: unknown, path: string) => {
    if (typeof id !== "string" || !id.trim()) {
      add("error", "id.invalid", path, "ID must be a non-empty string");
      return;
    }
    const previous = usedIds.get(id);
    if (previous) add("error", "id.duplicate", path, `ID is already used at ${previous}`);
    else usedIds.set(id, path);
  };
  const checkTick = (input: unknown, path: string) => {
    if (!tick(input)) add("error", "tick.invalid", path, "Tick must be a non-negative safe integer");
  };
  const checkShape = (lane: unknown, size: unknown, path: string, allowAuto: boolean) => {
    if (!(allowAuto && lane === "auto") && !finite(lane)) {
      add("error", "lane.invalid", `${path}.lane`, "Lane must be finite or an automatic line marker");
    }
    if (!finite(size) || size < 0) add("error", "size.invalid", `${path}.size`, "Size must be finite and non-negative");
    const laneBasis = finite(value.laneBasis) && value.laneBasis > 0 ? value.laneBasis : LANE_COUNT;
    if (finite(lane) && finite(size) && (lane < 0 || lane + size > laneBasis)) {
      add(
        "warning",
        "lane.authoredOutsideStage",
        path,
        `Authored span ${lane}..${lane + size} extends outside the visible 0..${laneBasis} stage`,
      );
    }
  };
  const checkNote = (note: unknown, path: string, allowAuto: boolean) => {
    if (!record(note)) {
      add("error", "note.type", path, "Note must be an object");
      return;
    }
    checkId(note.id, `${path}.id`);
    checkTick(note.tick, `${path}.tick`);
    checkShape(note.lane, note.size, path, allowAuto);
    if (!noteTypes.has(note.type as NoteType)) add("error", "note.noteType", `${path}.type`, "Unknown note type");
    if (typeof note.critical !== "boolean")
      add("error", "note.critical", `${path}.critical`, "Critical must be boolean");
    if (!directions.has(note.direction as NoteDirection)) {
      add("error", "note.direction", `${path}.direction`, "Unknown note direction");
    } else if (note.type === "tap" && note.direction !== "none") {
      add("error", "note.tapDirection", `${path}.direction`, "Tap notes cannot have a flick direction");
    }
    if (typeof note.visible !== "boolean") add("error", "note.visible", `${path}.visible`, "Visible must be boolean");
  };

  const tempos = value.tempos;
  if (!Array.isArray(tempos) || !tempos.length) {
    add("error", "tempo.missing", "$.tempos", "At least one tempo is required");
  } else {
    let previousTick = -1;
    const tempoTicks = new Set<number>();
    for (const [index, tempo] of tempos.entries()) {
      const path = `$.tempos[${index}]`;
      if (!record(tempo)) {
        add("error", "tempo.type", path, "Tempo must be an object");
        continue;
      }
      checkId(tempo.id, `${path}.id`);
      checkTick(tempo.tick, `${path}.tick`);
      if (!finite(tempo.bpm) || tempo.bpm <= 0) add("error", "tempo.bpm", `${path}.bpm`, "BPM must be positive");
      else if (tempo.bpm < 20 || tempo.bpm > 400)
        add("warning", "tempo.unusual", `${path}.bpm`, "BPM is outside the usual editor range");
      if (tick(tempo.tick)) {
        if (tempo.tick < previousTick) add("warning", "tempo.unsorted", path, "Tempo events are not sorted by tick");
        if (tempoTicks.has(tempo.tick)) add("error", "tempo.duplicate", `${path}.tick`, "Tempo ticks must be unique");
        tempoTicks.add(tempo.tick);
        previousTick = tempo.tick;
      }
    }
    if (!tempos.some((tempo) => record(tempo) && tempo.tick === 0)) {
      add("error", "tempo.origin", "$.tempos", "Tempo map must start at tick 0");
    }
  }

  const meters = value.meters;
  if (!Array.isArray(meters) || !meters.length) {
    add("error", "meter.missing", "$.meters", "At least one meter is required");
  } else {
    let previousTick = -1;
    const meterTicks = new Set<number>();
    for (const [index, meter] of meters.entries()) {
      const path = `$.meters[${index}]`;
      if (!record(meter)) {
        add("error", "meter.type", path, "Meter must be an object");
        continue;
      }
      checkId(meter.id, `${path}.id`);
      checkTick(meter.tick, `${path}.tick`);
      if (!Number.isSafeInteger(meter.numerator) || (meter.numerator as number) <= 0) {
        add("error", "meter.numerator", `${path}.numerator`, "Meter numerator must be a positive integer");
      }
      if (
        !Number.isSafeInteger(meter.denominator) ||
        (meter.denominator as number) <= 0 ||
        ((meter.denominator as number) & ((meter.denominator as number) - 1)) !== 0
      ) {
        add("error", "meter.denominator", `${path}.denominator`, "Meter denominator must be a positive power of two");
      }
      if (tick(meter.tick)) {
        if (meter.tick < previousTick) add("warning", "meter.unsorted", path, "Meter events are not sorted by tick");
        if (meterTicks.has(meter.tick)) add("error", "meter.duplicate", `${path}.tick`, "Meter ticks must be unique");
        meterTicks.add(meter.tick);
        previousTick = meter.tick;
      }
    }
    if (!meters.some((meter) => record(meter) && meter.tick === 0)) {
      add("warning", "meter.origin", "$.meters", "Meter map does not start at tick 0");
    }
  }

  if (!Array.isArray(value.timeScales)) {
    add("error", "timeScales.type", "$.timeScales", "Time scales must be an array");
  } else {
    const timeScaleTicks = new Set<number>();
    let previousTick = -1;
    for (const [index, event] of value.timeScales.entries()) {
      const path = `$.timeScales[${index}]`;
      if (!record(event)) {
        add("error", "timeScale.type", path, "Time scale must be an object");
        continue;
      }
      checkId(event.id, `${path}.id`);
      checkTick(event.tick, `${path}.tick`);
      if (tick(event.tick)) {
        if (event.tick < previousTick)
          add("warning", "timeScale.unsorted", path, "Time-scale events are not sorted by tick");
        if (timeScaleTicks.has(event.tick)) {
          add("error", "timeScale.duplicate", `${path}.tick`, "Time-scale ticks must be unique");
        }
        timeScaleTicks.add(event.tick);
        previousTick = event.tick;
      }
      if (!finite(event.scale) || event.scale <= 0) {
        add("error", "timeScale.value", `${path}.scale`, "Time scale must be finite and positive");
      }
    }
  }

  if (!Array.isArray(value.singles)) add("error", "singles.type", "$.singles", "Singles must be an array");
  else value.singles.forEach((note, index) => checkNote(note, `$.singles[${index}]`, false));

  if (!Array.isArray(value.lines)) add("error", "lines.type", "$.lines", "Lines must be an array");
  else {
    for (const [lineIndex, line] of value.lines.entries()) {
      const path = `$.lines[${lineIndex}]`;
      if (!record(line)) {
        add("error", "line.type", path, "Line must be an object");
        continue;
      }
      checkId(line.id, `${path}.id`);
      if (line.kind !== "long" && line.kind !== "guide") add("error", "line.kind", `${path}.kind`, "Unknown line kind");
      if (line.critical !== undefined && typeof line.critical !== "boolean") {
        add("error", "line.critical", `${path}.critical`, "Line critical must be boolean");
      }
      if (!Array.isArray(line.points) || line.points.length < 2) {
        add("error", "line.broken", `${path}.points`, "A line must contain at least two points");
        continue;
      }
      let previousTick = -1;
      for (const [pointIndex, point] of line.points.entries()) {
        const pointPath = `${path}.points[${pointIndex}]`;
        checkNote(point, pointPath, true);
        if (!record(point)) continue;
        if (
          !record(point.ease) ||
          !eases.has(point.ease.left as EaseType) ||
          !eases.has(point.ease.right as EaseType)
        ) {
          add("error", "line.ease", `${pointPath}.ease`, "Line ease must contain valid left and right values");
        }
        if (point.resolvedLane !== undefined && !finite(point.resolvedLane)) {
          add("error", "line.resolvedLane", `${pointPath}.resolvedLane`, "Resolved lane must be finite");
        }
        if (point.autoSize !== undefined && (typeof point.autoSize !== "boolean" || point.lane !== "auto")) {
          add("error", "line.autoSize", `${pointPath}.autoSize`, "Automatic size is only valid on an automatic lane");
        }
        if (point.resolvedSize !== undefined && (!finite(point.resolvedSize) || point.resolvedSize < 0)) {
          add(
            "error",
            "line.resolvedSize",
            `${pointPath}.resolvedSize`,
            "Resolved size must be finite and non-negative",
          );
        }
        if (tick(point.tick)) {
          if (point.tick < previousTick)
            add("error", "line.order", `${pointPath}.tick`, "Line points must not move backwards in time");
          else if (point.tick === previousTick) {
            add("warning", "line.zeroDuration", `${pointPath}.tick`, "Adjacent line points share the same tick");
          }
          previousTick = point.tick;
        }
      }
    }
  }

  if (!record(value.markers)) {
    add("error", "markers.type", "$.markers", "Markers must be an object");
  } else {
    if (!Array.isArray(value.markers.skill) || value.markers.skill.some((item) => !tick(item))) {
      add("error", "markers.skill", "$.markers.skill", "Skill markers must be non-negative integer ticks");
    }
    if (
      !Array.isArray(value.markers.fever) ||
      value.markers.fever.some(
        (item) => !Array.isArray(item) || item.length !== 2 || item.some((entry) => !tick(entry)),
      )
    ) {
      add("error", "markers.fever", "$.markers.fever", "Fever markers must be tick pairs");
    }
    if (
      !Array.isArray(value.markers.call) ||
      value.markers.call.some(
        (item) =>
          !record(item) ||
          !tick(item.tick) ||
          !Array.isArray(item.timing) ||
          item.timing.some((entry) => !finite(entry)),
      )
    ) {
      add("error", "markers.call", "$.markers.call", "Call markers must contain a tick and finite timing values");
    }
  }
  if (!record(value.extensions)) add("error", "extensions.type", "$.extensions", "Extensions must be a JSON object");
  if (
    value.sourceOrder !== undefined &&
    (!Array.isArray(value.sourceOrder) || value.sourceOrder.some((item) => typeof item !== "string"))
  ) {
    add("error", "sourceOrder.type", "$.sourceOrder", "Source order must contain string IDs");
  }

  return { valid: errors.length === 0, errors, warnings };
};

export class ProjectValidationError extends Error {
  readonly result: ProjectValidationResult;

  constructor(result: ProjectValidationResult) {
    super(result.errors.map((issue) => `${issue.path}: ${issue.message}`).join("; ") || "Invalid project");
    this.name = "ProjectValidationError";
    this.result = result;
  }
}

export function assertValidProject(value: unknown): asserts value is Project {
  const result = validateProject(value);
  if (!result.valid) throw new ProjectValidationError(result);
}
