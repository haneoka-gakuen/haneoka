import type { StoryDiagnostic } from "../diagnostics.js";
import type { JsonObject, JsonValue, StoryProject } from "../model.js";

export type StoryFormat = "project-json" | "adv-json" | "webgal" | (string & {});

export interface StoryImportResult {
  format: StoryFormat;
  project: StoryProject;
  diagnostics: StoryDiagnostic[];
}

const decoder = new TextDecoder();

export const jsonInput = (input: string | Uint8Array | unknown, label: string): unknown => {
  if (typeof input === "string") {
    try {
      return JSON.parse(input) as unknown;
    } catch (error) {
      throw new SyntaxError(`Invalid ${label} JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (input instanceof Uint8Array) return jsonInput(decoder.decode(input), label);
  return input;
};

export const isJsonObject = (value: unknown): value is JsonObject =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** Preserve the valid JSON number `-0`, which native JSON.stringify normalizes to `0`. */
export const stringifyStoryJson = (value: JsonValue, pretty = true): string => {
  let compact: string | undefined;
  try {
    compact = JSON.stringify(value);
  } catch (error) {
    throw new TypeError(`value must contain valid JSON data: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (compact === undefined) throw new TypeError("value must contain valid JSON data");

  let marker = "__haneoka_negative_zero__";
  while (compact.includes(JSON.stringify(marker))) marker += "_";
  const markerJson = JSON.stringify(marker);
  const serialized = JSON.stringify(
    value,
    (_key, item: unknown) => (typeof item === "number" && Object.is(item, -0) ? marker : item),
    pretty ? 2 : undefined,
  );
  if (serialized === undefined) throw new TypeError("value must contain valid JSON data");
  return serialized.split(markerJson).join("-0");
};

export const jsonClone = <T extends JsonValue>(value: T, label = "value"): T => {
  let serialized: string | undefined;
  try {
    serialized = stringifyStoryJson(value, false);
  } catch (error) {
    throw new TypeError(`${label} must contain valid JSON data: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (serialized === undefined) throw new TypeError(`${label} must contain valid JSON data`);
  const cloned = JSON.parse(serialized) as T;
  const originalKeys = value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value) : [];
  const clonedKeys = cloned && typeof cloned === "object" && !Array.isArray(cloned) ? Object.keys(cloned) : [];
  if (originalKeys.length !== clonedKeys.length) throw new TypeError(`${label} contains non-JSON values`);
  return cloned;
};
