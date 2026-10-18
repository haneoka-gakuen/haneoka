import { normalizeAuthorLocale, matchLocale } from "@haneoka/i18n";
import { localizedFallbacks } from "./localized-text";
import { preferredDeviceLocale } from "../i18n/negotiation";
import { isLocale, type Locale } from "../i18n/locales";
import { isReleaseServer, type ReleaseServer } from "./resource-route";

/** Current operational data; timestamps are Unix seconds, independent of releases. */
export interface Announcement {
  id: number;
  category: number;
  title: string;
  startAt: number;
  endAt: number;
  updatedAt: number;
  pinned?: boolean;
  bodyImage?: string;
  banner?: string;
  bodyImageWidth?: number;
  bodyImageHeight?: number;
  bannerWidth?: number;
  bannerHeight?: number;
  sourceLanguage?: string;
  actualSourceLocale?: string;
  sourceRegion?: string;
  sourceId?: number;
  html?: string;
}
export interface AnnouncementList {
  server: ReleaseServer;
  available: boolean;
  fetchedAt: string | null;
  announcements: Announcement[];
  requestedLocale: string;
  actualSourceLocale: string | null;
  availableSourceLocales: string[];
}
export class AnnouncementRequestError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`Announcement request failed: ${status}`);
    this.status = status;
  }
}
export const announcementId = (value: unknown): number | undefined => {
  const id =
    typeof value === "number" ? value : typeof value === "string" && /^[1-9]\d*$/u.test(value) ? Number(value) : NaN;
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
};
export function announcementPath(server: ReleaseServer, locale: Locale, id?: number): string {
  if (!isReleaseServer(server) || !isLocale(locale) || (id !== undefined && !announcementId(id)))
    throw new TypeError("Invalid announcement route");
  return `/${server}/${locale}/announcements/${id === undefined ? "" : `${id}/`}`;
}
export function parseAnnouncementRoute(pathname: string) {
  const parts = pathname.split("/").filter(Boolean);
  if (!isReleaseServer(parts[0]) || !isLocale(parts[1]) || parts[2] !== "announcements") return undefined;
  if (parts.length === 3) return { server: parts[0], locale: parts[1] };
  const id = announcementId(parts[3]);
  return parts.length === 4 && id ? { server: parts[0], locale: parts[1], id } : undefined;
}
/** Select one existing author-language pool before limits or detail lookup. */
export function selectAnnouncementLocale<T extends { sourceLanguage?: unknown }>(entries: readonly T[], locale: string) {
  const groups = new Map<string, T[]>();
  for (const entry of entries) {
    const source = typeof entry.sourceLanguage === "string" ? normalizeAuthorLocale(entry.sourceLanguage) : null;
    if (!source || source === "und") continue;
    const group = groups.get(source) || [];
    group.push(entry);
    groups.set(source, group);
  }
  const availableSourceLocales = [...groups.keys()];
  for (const candidate of localizedFallbacks(locale)) {
    const canonical = normalizeAuthorLocale(candidate);
    if (!canonical) continue;
    const exact = groups.has(canonical) ? canonical : undefined;
    // Central UI matching handles author tags such as zh-Hant vs zh-TW.
    const matched = matchLocale(canonical);
    const source = exact || (matched === canonical ? availableSourceLocales.find((tag) => matchLocale(tag) === matched) : undefined);
    if (source) return { actualSourceLocale: source, availableSourceLocales, entries: groups.get(source)! };
  }
  return { actualSourceLocale: null, availableSourceLocales, entries: [] as T[] };
}

export function announcementLanguage(entry: Announcement, server: ReleaseServer): string {
  try {
    const source = entry.actualSourceLocale || entry.sourceLanguage;
    if (source) return Intl.getCanonicalLocales(source)[0] || "und";
  } catch {
    /* Invalid publisher language metadata uses an explicit unknown language. */
  }
  return "und";
}
export const sortAnnouncements = (entries: readonly Announcement[]): Announcement[] =>
  [...entries].sort(
    (a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.startAt - a.startAt || b.id - a.id,
  );
export function mergeAnnouncements(
  current: readonly Announcement[], saved: readonly Announcement[],
  currentFetchedAt?: string | null, savedFetchedAt?: string | null,
): Announcement[] {
  const newerCapture = (Date.parse(currentFetchedAt || "") || 0) >= (Date.parse(savedFetchedAt || "") || 0);
  const entries = new Map<number, Announcement>(saved.map((entry) => [entry.id, { ...entry, pinned: !newerCapture && Boolean(entry.pinned) }]));
  for (const entry of current) {
    const old = entries.get(entry.id);
    if (!old) {
      entries.set(entry.id, { ...entry, pinned: newerCapture && Boolean(entry.pinned) });
      continue;
    }
    const [newest, older] = entry.updatedAt > old.updatedAt || (entry.updatedAt === old.updatedAt && newerCapture)
      ? [entry, old] : [old, entry];
    const merged = { ...older, ...newest, pinned: Boolean(newerCapture ? entry.pinned : old.pinned) };
    for (const field of ["html", "bodyImage", "banner"] as const) {
      const source = newest[field] ? newest : older;
      if (source[field]) merged[field] = source[field];
      if (field !== "html") {
        for (const dimension of ["Width", "Height"] as const) {
          const key = `${field}${dimension}` as const;
          if (source[key] !== undefined) merged[key] = source[key];
          else delete merged[key];
        }
      }
    }
    entries.set(entry.id, merged);
  }
  return sortAnnouncements([...entries.values()]);
}
export function announcementDate(seconds: number, locale: string, full = false): string {
  const date = new Date(seconds * 1000);
  if (!seconds || !Number.isFinite(date.getTime())) return "—";
  return new Intl.DateTimeFormat(
    locale,
    full
      ? {
          year: "numeric",
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          timeZoneName: "short",
        }
      : { year: "numeric", month: "short", day: "numeric" },
  ).format(date);
}
export const announcementDatetime = (seconds: number): string =>
  seconds > 0 && Number.isFinite(new Date(seconds * 1000).getTime()) ? new Date(seconds * 1000).toISOString() : "";

const record = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));
const validAnnouncement = (value: unknown): value is Announcement =>
  record(value) &&
  announcementId(value.id) !== undefined &&
  typeof value.title === "string" &&
  ["category", "startAt", "endAt", "updatedAt"].every(
    (key) => typeof value[key] === "number" && Number.isSafeInteger(value[key]) && Number(value[key]) >= 0,
  ) &&
  ["bodyImage", "banner", "sourceLanguage", "actualSourceLocale", "html"].every(
    (key) => value[key] === undefined || typeof value[key] === "string",
  ) &&
  ((value.sourceRegion === undefined && value.sourceId === undefined) ||
    (typeof value.sourceRegion === "string" &&
      /^[a-z0-9-]{1,32}$/u.test(value.sourceRegion) &&
      typeof value.sourceId === "number" &&
      Number.isSafeInteger(value.sourceId) &&
      value.sourceId > 0)) &&
  (value.pinned === undefined || typeof value.pinned === "boolean");
async function request(path: string, signal: AbortSignal): Promise<unknown> {
  const controller = new AbortController();
  const cancel = () => controller.abort(signal.reason);
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) cancel();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(path, { signal: controller.signal, headers: { accept: "application/json" } });
    if (!response.ok) throw new AnnouncementRequestError(response.status);
    return await response.json();
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", cancel);
  }
}
export async function fetchAnnouncements(server: ReleaseServer, signal: AbortSignal, locale: string = preferredDeviceLocale()): Promise<AnnouncementList> {
  const requestedLocale = normalizeAuthorLocale(locale);
  if (!requestedLocale) throw new TypeError("Invalid announcement locale");
  const value = await request(`/api/v1/announcements?${new URLSearchParams({ server, locale: requestedLocale })}`, signal);
  return parseAnnouncementList(value, server, requestedLocale);
}
export function parseAnnouncementList(value: unknown, server: ReleaseServer, requestedLocale: string): AnnouncementList {
  if (
    !record(value) ||
    value.server !== server ||
    value.requestedLocale !== requestedLocale ||
    !(value.actualSourceLocale === null || typeof value.actualSourceLocale === "string") ||
    !Array.isArray(value.availableSourceLocales) ||
    typeof value.available !== "boolean" ||
    (value.fetchedAt !== null && typeof value.fetchedAt !== "string") ||
    !Array.isArray(value.announcements) ||
    !value.announcements.every(validAnnouncement) ||
    value.announcements.some((entry) => normalizeAuthorLocale(entry.sourceLanguage || "") !== value.actualSourceLocale)
  )
    throw new TypeError("Invalid announcement list");
  return value as unknown as AnnouncementList;
}
export async function fetchAnnouncement(server: ReleaseServer, id: number, signal: AbortSignal, locale: string = preferredDeviceLocale()): Promise<Announcement> {
  const requestedLocale = normalizeAuthorLocale(locale);
  if (!requestedLocale) throw new TypeError("Invalid announcement locale");
  const value = await request(`/api/v1/announcements/${id}?${new URLSearchParams({ server, locale: requestedLocale })}`, signal);
  return parseAnnouncementDetail(value, server, id, requestedLocale);
}
export function parseAnnouncementDetail(value: unknown, server: ReleaseServer, id: number, requestedLocale: string): Announcement {
  if (!record(value) || value.server !== server || value.requestedLocale !== requestedLocale)
    throw new TypeError("Announcement detail identity mismatch");
  const entry = record(value) && "announcement" in value ? value.announcement : value;
  if (!validAnnouncement(entry) || entry.id !== id || typeof entry.actualSourceLocale !== "string" ||
      normalizeAuthorLocale(entry.sourceLanguage || "") !== entry.actualSourceLocale || (entry.html !== undefined && typeof entry.html !== "string"))
    throw new TypeError("Invalid announcement detail");
  return entry;
}
