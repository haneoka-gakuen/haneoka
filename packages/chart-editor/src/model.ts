export const PROJECT_VERSION = 1 as const;
export const PROJECT_RESOLUTION = 480 as const;
export const LANE_COUNT = 24 as const;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type NoteType = "tap" | "flick" | "trace";
export type NoteDirection = "none" | "left" | "up" | "right";
export type LineKind = "long" | "guide";
export type EaseType = "linear" | "in" | "out";

export interface ProjectMeta {
  title: string;
  artist: string;
  charter: string;
  difficulty: string;
  level: string;
  source?: string;
  tags?: string[];
  extra?: Record<string, JsonValue>;
}

export interface TempoEvent {
  id: string;
  tick: number;
  bpm: number;
}

export interface MeterEvent {
  id: string;
  tick: number;
  numerator: number;
  denominator: number;
}

export interface TimeScaleEvent {
  id: string;
  tick: number;
  scale: number;
}

export interface CallMarker {
  tick: number;
  timing: number[];
}

export interface ProjectMarkers {
  skill: number[];
  fever: [number, number][];
  call: CallMarker[];
}

export interface SingleNote {
  id: string;
  tick: number;
  /** Authored left edge in the project's `laneBasis` coordinate system. */
  lane: number;
  /** Authored width. Zero is valid for marker and trace nodes. */
  size: number;
  type: NoteType;
  critical: boolean;
  direction: NoteDirection;
  visible: boolean;
}

export interface LineEase {
  left: EaseType;
  right: EaseType;
}

export interface LinePoint extends Omit<SingleNote, "lane"> {
  /** `auto` is an authored SS interpolation marker and must survive a round trip. */
  lane: number | "auto";
  /** Resolved display position for an automatic point; never serialized back as authored lane. */
  resolvedLane?: number;
  /** SS can omit width for an automatic point; retain that authored omission on export. */
  autoSize?: boolean;
  /** Resolved display width for an automatic point; never replaces the authored width. */
  resolvedSize?: number;
  /** Easing of the segment leaving this point. */
  ease: LineEase;
}

export interface NoteLine {
  id: string;
  kind: LineKind;
  /** USC/Sonolus connector critical state, independent from node criticality. */
  critical?: boolean;
  points: LinePoint[];
}

export interface Project {
  version: typeof PROJECT_VERSION;
  resolution: typeof PROJECT_RESOLUTION;
  /** Width of the authored lane coordinate space. SS uses 24; SUS projects may use 28. */
  laneBasis: number;
  meta: ProjectMeta;
  /** Seconds added to musical time zero. */
  audioOffset: number;
  tempos: TempoEvent[];
  meters: MeterEvent[];
  timeScales: TimeScaleEvent[];
  singles: SingleNote[];
  lines: NoteLine[];
  markers: ProjectMarkers;
  /** Format-specific, browser-neutral JSON retained across project saves. */
  extensions: Record<string, JsonValue>;
  /** Optional source object order for adapters that can preserve it. */
  sourceOrder?: string[];
}

let fallbackIdCounter = 0;

const safeIdPart = (value: string | number): string =>
  String(value)
    .normalize("NFKC")
    .trim()
    .replace(/[^a-zA-Z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "item";

/** Deterministic ID used by importers, stable for the same source order. */
export const importedId = (format: string, ...parts: Array<string | number>): string =>
  [safeIdPart(format), ...parts.map(safeIdPart)].join("-");

/** ID for newly authored objects. The returned string is retained in project JSON. */
export const createProjectId = (prefix = "item"): string => {
  const cryptoValue = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (cryptoValue?.randomUUID) return `${safeIdPart(prefix)}-${cryptoValue.randomUUID()}`;
  fallbackIdCounter += 1;
  return `${safeIdPart(prefix)}-${Date.now().toString(36)}-${fallbackIdCounter.toString(36)}`;
};

export const tickToBeat = (tick: number, resolution = PROJECT_RESOLUTION): number => tick / resolution;

export const beatToTick = (beat: number, resolution = PROJECT_RESOLUTION): number => {
  if (!Number.isFinite(beat)) throw new TypeError("Beat must be finite");
  if (!Number.isSafeInteger(resolution) || resolution <= 0) throw new RangeError("Resolution must be positive");
  return Math.round(beat * resolution);
};

export const createEmptyProject = (meta: Partial<ProjectMeta> = {}): Project => ({
  version: PROJECT_VERSION,
  resolution: PROJECT_RESOLUTION,
  laneBasis: LANE_COUNT,
  meta: {
    title: meta.title ?? "",
    artist: meta.artist ?? "",
    charter: meta.charter ?? "",
    difficulty: meta.difficulty ?? "",
    level: meta.level ?? "",
    ...(meta.source === undefined ? {} : { source: meta.source }),
    ...(meta.tags === undefined ? {} : { tags: [...meta.tags] }),
    ...(meta.extra === undefined ? {} : { extra: structuredCloneValue(meta.extra) }),
  },
  audioOffset: 0,
  tempos: [{ id: "tempo-0", tick: 0, bpm: 120 }],
  meters: [{ id: "meter-0", tick: 0, numerator: 4, denominator: 4 }],
  timeScales: [],
  singles: [],
  lines: [],
  markers: { skill: [], fever: [], call: [] },
  extensions: {},
});

export const structuredCloneValue = <T>(value: T): T => {
  const clone = (globalThis as { structuredClone?: <V>(input: V) => V }).structuredClone;
  if (clone) return clone(value);
  if (Array.isArray(value)) return value.map((item) => structuredCloneValue(item)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, structuredCloneValue(item)]),
    ) as T;
  }
  return value;
};

export const sortProject = (project: Project): Project => ({
  ...structuredCloneValue(project),
  tempos: [...project.tempos].sort((a, b) => a.tick - b.tick || a.id.localeCompare(b.id)),
  meters: [...project.meters].sort((a, b) => a.tick - b.tick || a.id.localeCompare(b.id)),
  timeScales: [...project.timeScales].sort((a, b) => a.tick - b.tick || a.id.localeCompare(b.id)),
  singles: [...project.singles].sort((a, b) => a.tick - b.tick || a.id.localeCompare(b.id)),
  lines: [...project.lines]
    .map((line) => ({
      ...structuredCloneValue(line),
      points: [...line.points].sort((a, b) => a.tick - b.tick || a.id.localeCompare(b.id)),
    }))
    .sort((a, b) => (a.points[0]?.tick ?? 0) - (b.points[0]?.tick ?? 0) || a.id.localeCompare(b.id)),
});

const easeProgress = (ease: EaseType, progress: number): number => {
  if (ease === "in") return progress * progress;
  if (ease === "out") return (2 - progress) * progress;
  return progress;
};

export interface ResolvedLinePointShape {
  lane: number;
  size: number;
}

/** Resolve both boundaries of an automatic point without replacing its authored values. */
export const resolveLinePointShape = (points: readonly LinePoint[], index: number): ResolvedLinePointShape => {
  const point = points[index];
  if (!point) throw new RangeError("Line point index is out of range");
  if (typeof point.lane === "number") return { lane: point.lane, size: point.size };
  if (Number.isFinite(point.resolvedLane) && Number.isFinite(point.resolvedSize)) {
    return { lane: point.resolvedLane as number, size: point.resolvedSize as number };
  }

  let leftIndex = index - 1;
  while (leftIndex >= 0 && typeof points[leftIndex]?.lane !== "number") leftIndex -= 1;
  let rightIndex = index + 1;
  while (rightIndex < points.length && typeof points[rightIndex]?.lane !== "number") rightIndex += 1;
  const left = leftIndex >= 0 ? points[leftIndex] : undefined;
  const right = rightIndex < points.length ? points[rightIndex] : undefined;
  if (!left && !right) return { lane: 0, size: point.size };
  if (!left) {
    return { lane: right!.lane as number, size: point.autoSize ? right!.size : point.size };
  }
  if (!right) {
    return { lane: left.lane as number, size: point.autoSize ? left.size : point.size };
  }
  const duration = right.tick - left.tick;
  const progress = duration === 0 ? 0 : Math.min(1, Math.max(0, (point.tick - left.tick) / duration));
  const leftProgress = easeProgress(left.ease.left, progress);
  const rightProgress = easeProgress(left.ease.right, progress);
  const lane = (left.lane as number) + ((right.lane as number) - (left.lane as number)) * leftProgress;
  const leftRight = (left.lane as number) + left.size;
  const rightRight = (right.lane as number) + right.size;
  const resolvedRight = leftRight + (rightRight - leftRight) * rightProgress;
  return { lane, size: resolvedRight - lane };
};

/** Resolve an authored automatic lane without replacing the authored `auto` marker. */
export const resolveLinePointLane = (points: readonly LinePoint[], index: number): number =>
  resolveLinePointShape(points, index).lane;

/** Resolve the display width of an automatic line point. */
export const resolveLinePointSize = (points: readonly LinePoint[], index: number): number =>
  resolveLinePointShape(points, index).size;

export const withResolvedLineLanes = (line: NoteLine): NoteLine => ({
  ...structuredCloneValue(line),
  points: line.points.map((point, index, points) =>
    point.lane === "auto"
      ? {
          ...structuredCloneValue(point),
          resolvedLane: resolveLinePointLane(points, index),
          resolvedSize: resolveLinePointSize(points, index),
        }
      : structuredCloneValue(point),
  ),
});
