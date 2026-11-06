import { navigationDocumentUrl } from "./document-url";
import { currentVisibilityPolicy } from "./content-policy-browser";
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
  if (!value || typeof value !== "object" || Array.isArray(value)) return true;
  const row = value as Record<string, unknown>;
  const time = row.publicStartAt ?? row.releasedAt ?? row.publishedAt ?? row.releaseAt ?? row.startAt;
  const first = Array.isArray(time) ? time.find((entry) => Number(entry) > 0) : time;
  const timestamp = typeof first === "string" && !Number.isFinite(Number(first)) ? Date.parse(first) : Number(first);
  const event = currentVisibilityPolicy().eventChallengeSongs ? Number(row.eventPublishedAt) : 0;
  return (
    (!(timestamp > now) || (event > 0 && event <= now)) && (!row.catalogMetadata || released(row.catalogMetadata, now))
  );
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
  const identity = id ?? (kind ? visibilityId(kind, row) : "");
  if (rule.hide.includes(identity)) return false;
  if (rule.show.includes(identity)) return true;
  if (rule.mode === "hidden") return false;
  if (rule.mode === "visible") return true;
  return (rule.mode === "spoiler" && showUnreleasedContent()) || released(value, Date.now());
}

export function releasedContent<T>(value: T): T {
  if (Array.isArray(value)) return value.filter(isReleasedContent) as T;
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).filter(([, entry]) => isReleasedContent(entry))) as T;
  return value;
}
