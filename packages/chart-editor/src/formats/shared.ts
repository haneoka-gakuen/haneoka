import {
  LANE_COUNT,
  PROJECT_RESOLUTION,
  PROJECT_VERSION,
  importedId,
  sortProject,
  structuredCloneValue,
  type JsonValue,
  type Project,
  type ProjectMeta,
} from "../model";
import { validateProject } from "../validation";

export type ChartFormat = "project" | "ss" | "usc" | "sus" | "sonolus-level-data" | "unknown";

export interface FormatWarning {
  code: string;
  path: string;
  message: string;
}

export interface ImportResult {
  format: Exclude<ChartFormat, "unknown" | "sonolus-level-data">;
  project: Project;
  warnings: FormatWarning[];
}

export class ChartFormatError extends Error {
  readonly format: ChartFormat;
  readonly path?: string;

  constructor(format: ChartFormat, message: string, path?: string) {
    super(path ? `${path}: ${message}` : message);
    this.name = "ChartFormatError";
    this.format = format;
    if (path !== undefined) this.path = path;
  }
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

export const finiteNumber = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

export const textInput = (input: string | Uint8Array): string =>
  (typeof input === "string" ? input : new TextDecoder().decode(input)).replace(/^\uFEFF/, "");

export const jsonInput = (input: string | Uint8Array | unknown, format: ChartFormat): unknown => {
  if (typeof input !== "string" && !(input instanceof Uint8Array)) return input;
  try {
    return JSON.parse(textInput(input));
  } catch (error) {
    throw new ChartFormatError(format, error instanceof Error ? error.message : "Invalid JSON");
  }
};

export const importedMeta = (format: string, input: Partial<ProjectMeta> = {}): ProjectMeta => ({
  title: input.title ?? "",
  artist: input.artist ?? "",
  charter: input.charter ?? "",
  difficulty: input.difficulty ?? "",
  level: input.level ?? "",
  source: input.source ?? format,
  ...(input.tags === undefined ? {} : { tags: [...input.tags] }),
  ...(input.extra === undefined ? {} : { extra: structuredCloneValue(input.extra) }),
});

export const importedProject = (format: string, partial: Partial<Project> = {}): Project => ({
  version: PROJECT_VERSION,
  resolution: PROJECT_RESOLUTION,
  laneBasis: partial.laneBasis ?? LANE_COUNT,
  meta: partial.meta ?? importedMeta(format),
  audioOffset: partial.audioOffset ?? 0,
  tempos: partial.tempos ?? [{ id: importedId(format, "tempo", 0), tick: 0, bpm: 120 }],
  meters: partial.meters ?? [{ id: importedId(format, "meter", 0), tick: 0, numerator: 4, denominator: 4 }],
  timeScales: partial.timeScales ?? [],
  singles: partial.singles ?? [],
  lines: partial.lines ?? [],
  markers: partial.markers ?? { skill: [], fever: [], call: [] },
  extensions: partial.extensions ?? {},
  ...(partial.sourceOrder === undefined ? {} : { sourceOrder: [...partial.sourceOrder] }),
});

const dedupeTimed = <T extends { id: string; tick: number }>(
  items: readonly T[],
  kind: string,
  warnings: FormatWarning[],
): T[] => {
  const byTick = new Map<number, T>();
  for (const item of items) {
    if (byTick.has(item.tick)) {
      warnings.push({
        code: `${kind}.duplicateTick`,
        path: `$.${kind}`,
        message: `Multiple ${kind} events share tick ${item.tick}; the last event was retained`,
      });
    }
    byTick.set(item.tick, item);
  }
  return [...byTick.values()];
};

export const finishImport = (
  format: ImportResult["format"],
  input: Project,
  warnings: FormatWarning[],
): ImportResult => {
  const project = sortProject({
    ...input,
    tempos: dedupeTimed(input.tempos, "tempos", warnings),
    meters: dedupeTimed(input.meters, "meters", warnings),
    timeScales: dedupeTimed(input.timeScales, "timeScales", warnings),
  });
  if (!project.tempos.some((tempo) => tempo.tick === 0)) {
    project.tempos.unshift({ id: importedId(format, "tempo", "default"), tick: 0, bpm: 120 });
    warnings.push({ code: "tempo.defaulted", path: "$.tempos", message: "A 120 BPM event was inserted at tick 0" });
  }
  if (!project.meters.some((meter) => meter.tick === 0)) {
    project.meters.unshift({ id: importedId(format, "meter", "default"), tick: 0, numerator: 4, denominator: 4 });
    warnings.push({ code: "meter.defaulted", path: "$.meters", message: "A 4/4 meter was inserted at tick 0" });
  }
  const validation = validateProject(project);
  if (!validation.valid) {
    throw new ChartFormatError(format, validation.errors.map((issue) => `${issue.path}: ${issue.message}`).join("; "));
  }
  for (const issue of validation.warnings) {
    warnings.push({ code: issue.code, path: issue.path, message: issue.message });
  }
  return { format, project, warnings };
};

export const jsonRecord = (value: unknown): Record<string, JsonValue> | undefined =>
  isRecord(value) ? (structuredCloneValue(value) as Record<string, JsonValue>) : undefined;
