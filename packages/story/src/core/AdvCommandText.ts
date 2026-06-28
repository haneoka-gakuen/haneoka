import { resolveStoryLocalizedText } from "../runtime";
import type { AdvCommand } from "../types/AdvRuntime";

const hasLocalizedText = (value: unknown): boolean => Boolean(resolveStoryLocalizedText(value).text.trim());
const hasOwn = (value: object, key: PropertyKey): boolean => Object.prototype.hasOwnProperty.call(value, key);

/**
 * Native episodes use AdvTextID as the presence bit for Talk/Location/
 * Subtitles.  Editor imports replace that implementation ID with resolved
 * semantic text. Once that semantic field is present it is authoritative:
 * an explicit empty string is the editor's clear operation and must not fall
 * back to a retained native ID. Native rows without a semantic projection can
 * still use their AdvTextID presence bit.
 */
export const hasSemanticAdvText = (command: AdvCommand): boolean => {
  if (hasOwn(command, "text")) return hasLocalizedText(command.text);
  const sourceId = command.advTextId ?? command.raw?.AdvTextID;
  return Boolean(String(sourceId ?? "").trim());
};

/**
 * Original Episode rows use `・`, while authoring tools commonly use commas.
 * Accept both (plus CJK comma variants) without changing the runtime's display
 * separator or the native export format.
 */
export const splitAdvTargetNames = (value: unknown, configuredSeparator = "・"): string[] => {
  let source = String(value ?? "");
  for (const separator of new Set(["・", ",", "，", "、", configuredSeparator])) {
    if (separator) source = source.replaceAll(separator, "\u0000");
  }
  return source
    .split("\u0000")
    .map((target) => target.trim())
    .filter(Boolean);
};
