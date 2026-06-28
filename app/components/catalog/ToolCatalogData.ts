import type { LocalizedValueInput, ResolvedLocalizedText, ResolveArchiveValueOptions } from "~/i18n/locales";
import type { DisplayText } from "~/types/displayText";

export type ToolRecord = Record<string, unknown>;

export type ToolLocaleResolver = (
  value: LocalizedValueInput,
  options?: ResolveArchiveValueOptions,
) => ResolvedLocalizedText | null;

export const isToolRecord = (value: unknown): value is ToolRecord =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

export const toolRecordValues = (value: unknown): ToolRecord[] => {
  if (Array.isArray(value)) return value.filter(isToolRecord);
  if (!isToolRecord(value)) return [];
  return Object.values(value).filter(isToolRecord);
};

export const toolField = (value: unknown, ...keys: string[]): unknown => {
  if (!isToolRecord(value)) return undefined;
  for (const key of keys) {
    if (value[key] !== undefined && value[key] !== null) return value[key];
  }
  const raw = value.raw;
  if (isToolRecord(raw) && raw !== value) {
    for (const key of keys) {
      if (raw[key] !== undefined && raw[key] !== null) return raw[key];
    }
  }
  return undefined;
};

export const toolArray = (value: unknown, ...keys: string[]): unknown[] => {
  const selected = keys.length ? toolField(value, ...keys) : value;
  return Array.isArray(selected) ? selected : [];
};

export const toolNumber = (value: unknown, fallback = 0): number => {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
};

export const toolText = (value: unknown, fallback = ""): string => {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return fallback;
};

export const toolId = (value: unknown, fallback = ""): string =>
  toolText(
    toolField(
      value,
      "id",
      "itemId",
      "missionId",
      "friendshipId",
      "bandItemId",
      "skillId",
      "categoryId",
      "helpSubcategoryId",
      "optionItemType",
      "_id",
    ),
    fallback,
  );

export const toolRaw = (value: unknown): ToolRecord => {
  const raw = toolField(value, "raw");
  return isToolRecord(raw) ? raw : isToolRecord(value) ? value : {};
};

export const toolSourceTable = (value: unknown): string =>
  toolText(toolField(value, "sourceTable", "_sourceTable"), "Master");

export const toolJson = (value: unknown): string => JSON.stringify(value, null, 2);

export const toolSearchText = (...values: unknown[]): string =>
  values
    .flatMap((value) => {
      if (Array.isArray(value)) return value.map((entry) => toolText(entry));
      if (isToolRecord(value)) return Object.values(value).map((entry) => toolText(entry));
      return [toolText(value)];
    })
    .join(" ")
    .normalize("NFKC")
    .toLocaleLowerCase();

/** Flatten localized tool data for search, sorting, and other non-rendering operations. */
export const toolLocaleText = (value: unknown, localize: (value: never) => string, fallback = ""): string => {
  if (typeof value === "string") return value || fallback;
  if (Array.isArray(value) || isToolRecord(value)) return localize(value as never) || fallback;
  return toolText(value, fallback);
};

/** Resolve localized tool data without discarding the language of the selected archive value. */
export const toolLocaleDisplayText = (
  value: unknown,
  resolveLocalized: ToolLocaleResolver,
  options: ResolveArchiveValueOptions = {},
): DisplayText => {
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return resolveLocalized(value as LocalizedValueInput, options) || options.fallback || "";
};

export const toolAssetSource = (value: unknown, assetUrl: (value: unknown) => string): string => {
  const source = toolText(value);
  if (!source) return "";
  return assetUrl(source);
};

export const toolFormatNumber = (value: unknown): string => {
  const number = Number(value);
  return Number.isFinite(number) ? new Intl.NumberFormat().format(number) : toolText(value, "—");
};
