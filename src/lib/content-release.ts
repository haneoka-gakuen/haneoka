import { navigationDocumentUrl } from "./document-url";
import { spoilerContentEnabled } from "./spoiler-content";
import { contentPublished } from "./content-publication";
import { currentContentGroup, currentVisibilityPolicy } from "./content-policy-browser";
import {
  DEFAULT_VISIBILITY_RULE,
  inferredVisibilityType,
  visibilityId,
  visibilityType,
} from "./content-visibility-policy";

export function showUnreleasedContent(): boolean {
  if (typeof document === "undefined" || !document.documentElement || typeof location === "undefined") return false;
  const value = Number(navigationDocumentUrl().searchParams.get("spoiler"));
  return Number.isFinite(value) && value !== 0;
}

function released(value: unknown, now: number): boolean {
  return contentPublished(value, now);
}

export function isReleasedContent(value: unknown): boolean {
  const row =
    value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  const kind = row && inferredVisibilityType(row);
  return kind ? isContentVisible(kind, row) : showUnreleasedContent() || released(value, Date.now());
}

export function isContentVisible(resource: string, value: unknown, id?: string): boolean {
  const row = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const kind = visibilityType(resource);
  const rule = kind ? (currentVisibilityPolicy().types[kind] ?? DEFAULT_VISIBILITY_RULE) : DEFAULT_VISIBILITY_RULE;
  if (released(value, Date.now())) return true;
  if (showUnreleasedContent()) return true;
  if (!rule.groups.includes(currentContentGroup())) return false;
  const identity = id ?? (kind ? visibilityId(kind, row) : "");
  if (rule.hide.includes(identity)) return false;
  if (rule.show.includes(identity)) return true;
  if (rule.mode === "hidden") return false;
  if (rule.mode === "visible") return true;
  return rule.mode === "spoiler" && spoilerContentEnabled();
}

export function releasedContent<T>(value: T): T {
  if (Array.isArray(value)) return value.filter(isReleasedContent) as T;
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).filter(([, entry]) => isReleasedContent(entry))) as T;
  return value;
}
