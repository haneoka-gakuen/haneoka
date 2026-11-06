import { navigationDocumentUrl } from "./document-url";

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
  return !(timestamp > now) && (!row.catalogMetadata || released(row.catalogMetadata, now));
}

export function isReleasedContent(value: unknown): boolean {
  return showUnreleasedContent() || released(value, Date.now());
}

export function releasedContent<T>(value: T): T {
  if (showUnreleasedContent()) return value;
  const now = Date.now();
  if (Array.isArray(value)) return value.filter((entry) => released(entry, now)) as T;
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).filter(([, entry]) => released(entry, now))) as T;
  return value;
}
