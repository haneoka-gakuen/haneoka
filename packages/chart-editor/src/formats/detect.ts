import { importProjectJson } from "./project-json";
import { ChartFormatError, isRecord, textInput, type ChartFormat, type ImportResult } from "./shared";
import { importSs } from "./ss";
import { importSus } from "./sus";
import { importUsc } from "./usc";

export type ChartInput = string | Uint8Array | unknown;

const parseJsonForDetection = (input: string | Uint8Array | unknown): unknown => {
  if (typeof input !== "string" && !(input instanceof Uint8Array)) return input;
  const text = textInput(input).trim();
  if (!text || text.startsWith("#")) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

export const detectChartFormat = (input: ChartInput): ChartFormat => {
  if (typeof input === "string" || input instanceof Uint8Array) {
    const text = textInput(input).trimStart();
    if (
      /^#(?:(?:REQUEST|TITLE|ARTIST|DESIGNER|WAVEOFFSET|MEASUREBS|BPM)\b|(?:BPM|TIL|HIS)[0-9A-Z]{2}\s*:|\d{3}[0-9A-Z]{2,3}\s*:)/im.test(
        text,
      )
    ) {
      return "sus";
    }
  }

  const value = parseJsonForDetection(input);
  if (!isRecord(value)) return "unknown";

  if (
    value.version === 1 &&
    value.resolution === 480 &&
    typeof value.laneBasis === "number" &&
    Array.isArray(value.tempos) &&
    Array.isArray(value.singles) &&
    Array.isArray(value.lines)
  ) {
    return "project";
  }

  if (
    typeof value.bgmOffset === "number" &&
    Array.isArray(value.entities) &&
    value.entities.every(
      (entity) => isRecord(entity) && typeof entity.archetype === "string" && Array.isArray(entity.data),
    )
  ) {
    return "sonolus-level-data";
  }

  if (
    (isRecord(value.usc) && Array.isArray(value.usc.objects)) ||
    (Array.isArray(value.objects) &&
      (typeof value.offset === "number" || value.objects.some((item) => isRecord(item) && "beat" in item)))
  ) {
    return "usc";
  }

  if (
    (isRecord(value.score) && Array.isArray(value.score.notes)) ||
    (Array.isArray(value.notes) && (Array.isArray(value.bpm) || Array.isArray(value.sig) || isRecord(value.events)))
  ) {
    return "ss";
  }

  return "unknown";
};

/** Import any editable chart format. Sonolus LevelData is deployment-only and is intentionally not reversed. */
export const importChart = (input: ChartInput): ImportResult => {
  const format = detectChartFormat(input);
  if (format === "project") return importProjectJson(input);
  if (format === "ss") return importSs(input);
  if (format === "usc") return importUsc(input);
  if (format === "sus") {
    if (typeof input !== "string" && !(input instanceof Uint8Array)) {
      throw new ChartFormatError("sus", "SUS input must be text");
    }
    return importSus(input);
  }
  if (format === "sonolus-level-data") {
    throw new ChartFormatError(
      format,
      "Sonolus LevelData is a deployment format and cannot be losslessly converted back into an editor project",
    );
  }
  throw new ChartFormatError("unknown", "Unable to detect a supported chart format");
};
