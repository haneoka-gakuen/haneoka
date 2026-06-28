import { archiveLocales, isArchiveLocale, type ArchiveLocale, type ResolvedLocalizedText } from "~/i18n/locales";

export type DisplayText = string | ResolvedLocalizedText;
export type DisplayTextInput = DisplayText | null | undefined;

const localizedLanguageTags = new Set<string>(["und", ...archiveLocales.map((locale) => locale.tag)]);

export const isResolvedDisplayText = (value: unknown): value is ResolvedLocalizedText => {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ResolvedLocalizedText>;
  return (
    typeof candidate.text === "string" &&
    isArchiveLocale(candidate.requestedLocale) &&
    (candidate.sourceLocale === null || isArchiveLocale(candidate.sourceLocale)) &&
    typeof candidate.lang === "string" &&
    localizedLanguageTags.has(candidate.lang) &&
    typeof candidate.isFallback === "boolean"
  );
};

export const textOf = (value: DisplayTextInput, fallback = ""): string => {
  if (typeof value === "string") return value;
  return isResolvedDisplayText(value) ? value.text : fallback;
};

export const langOf = (value: DisplayTextInput): string | undefined =>
  isResolvedDisplayText(value) ? value.lang : undefined;

export const sourceLocaleOf = (value: DisplayTextInput): ArchiveLocale | null =>
  isResolvedDisplayText(value) ? value.sourceLocale : null;

export const resolvedTextOf = (value: DisplayTextInput): ResolvedLocalizedText | null =>
  isResolvedDisplayText(value) ? value : null;

export const displayTextFromUnknown = (value: unknown, fallback = ""): DisplayText => {
  if (isResolvedDisplayText(value)) return value;
  return typeof value === "string" && value ? value : fallback;
};

export const replaceDisplayText = (value: DisplayTextInput, text: string): DisplayText =>
  isResolvedDisplayText(value) ? { ...value, text } : text;

export const sameDisplayText = (left: DisplayTextInput, right: DisplayTextInput): boolean => {
  if (left === right) return true;
  if (!isResolvedDisplayText(left) || !isResolvedDisplayText(right)) return false;
  return (
    left.text === right.text &&
    left.requestedLocale === right.requestedLocale &&
    left.sourceLocale === right.sourceLocale &&
    left.lang === right.lang &&
    left.isFallback === right.isFallback
  );
};
