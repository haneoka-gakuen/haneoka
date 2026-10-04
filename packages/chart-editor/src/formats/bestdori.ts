import { structuredCloneValue, type JsonValue } from "../model";
import { validateProject, ProjectValidationError } from "../validation";
import { ChartFormatError, jsonInput, type ImportResult } from "./shared";
import { importSs } from "./ss";

/** Supply the existing Bestdori converter; this adapter owns no gameplay rules. */
export type BestdoriSsBridge = (source: unknown) => unknown;
export interface BestdoriImportOptions {
  toSs: BestdoriSsBridge;
  /** Authored coordinate width of the supplied bridge; SS-shaped JSON does not imply a 24-unit source stage. */
  laneBasis: number;
  /** Seconds between chart time zero and the imported audio, supplied by the source adapter. */
  audioOffset?: number;
  /** Public-source identity and file metadata retained by Project JSON. */
  provenance?: Record<string, JsonValue>;
}

export function importBestdoriChart(
  input: string | Uint8Array | unknown,
  options: BestdoriImportOptions,
): ImportResult {
  const source = jsonInput(input, "bestdori");
  if (!Array.isArray(source)) throw new ChartFormatError("bestdori", "Bestdori chart must be an array");
  const imported = importSs(options.toSs(structuredCloneValue(source)));
  imported.project.laneBasis = options.laneBasis;
  if (options.audioOffset !== undefined) imported.project.audioOffset = options.audioOffset;
  imported.project.meta.source = "bestdori";
  imported.project.extensions.bestdoriSource = {
    schema: "haneoka-bestdori-source-v1",
    bridgeLaneBasis: options.laneBasis,
    chart: structuredCloneValue(source) as JsonValue,
    ...(options.provenance ? { provenance: structuredCloneValue(options.provenance) } : {}),
  };
  const validation = validateProject(imported.project);
  if (!validation.valid) throw new ProjectValidationError(validation);
  return {
    ...imported,
    format: "bestdori",
    warnings: [
      ...imported.warnings.filter((issue) => issue.code !== "lane.authoredOutsideStage"),
      ...validation.warnings
        .filter((issue) => issue.code === "lane.authoredOutsideStage")
        .map(({ code, path, message }) => ({ code, path, message })),
      {
        code: "bestdori.ssBridge",
        path: "$.extensions.bestdoriSource",
        message:
          "The supplied converter projects Bestdori into SS geometry; source data is retained and source gameplay rules remain distinct",
      },
    ],
  };
}
