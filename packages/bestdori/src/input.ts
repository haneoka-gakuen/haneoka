import { BestdoriFormatError } from "./diagnostics.js";

export type BestdoriInput = string | Uint8Array | unknown;

const decoder = new TextDecoder("utf-8", { fatal: true });

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** Decode JSON text/bytes while leaving already-parsed values untouched. */
export const parseBestdoriJson = (input: BestdoriInput, label = "Bestdori data"): unknown => {
  let source = input;
  if (input instanceof Uint8Array) {
    try {
      source = decoder.decode(input);
    } catch (error) {
      throw new BestdoriFormatError("input.utf8", "$", `${label} must be valid UTF-8`, { cause: error });
    }
  }
  if (typeof source !== "string") return source;
  try {
    return JSON.parse(source.replace(/^\uFEFF/, "")) as unknown;
  } catch (error) {
    throw new BestdoriFormatError("input.json", "$", `Invalid ${label} JSON`, { cause: error });
  }
};
