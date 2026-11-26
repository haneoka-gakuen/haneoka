import { createHash } from "node:crypto";
import { normalizeAuthorLocale } from "@haneoka/i18n";
import { mergeAnnouncements, parseAnnouncementList, parseAnnouncementDetail, selectAnnouncementLocale, type Announcement } from "../lib/announcements";
import type { AnnouncementPageData } from "../lib/announcement-page-data";
import type { ReleaseServer } from "../lib/release-server";
import type { Locale } from "../i18n/locales";
import { fetchStaticReleaseEntry, fetchStaticReleaseJson, staticCatalogRelease } from "../lib/static-catalog-source";
import { staticBuildJson } from "./static-input-store";

const pages = new Map<string, Promise<AnnouncementPageData>>();
const origin = process.env.STATIC_OPERATION_ORIGIN || process.env.STATIC_CATALOG_ORIGIN || "https://haneoka.org";
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
class OperationUnavailable extends Error {}
async function operationJson(path: string) {
  try {
    const signal = AbortSignal.timeout(30_000);
    const request = () => fetch(new URL(path, origin), {
      headers: {
        accept: "application/json",
        ...(process.env.STATIC_CATALOG_TOKEN ? { "x-haneoka-build-token": process.env.STATIC_CATALOG_TOKEN } : {}),
      },
      signal,
    });
    let response = await request();
    if (response.status >= 500) {
      await response.body?.cancel();
      response = await request();
    }
    if (!response.ok) throw new OperationUnavailable(`Announcement HTTP ${response.status}`);
    return { value: await response.json(), fetchedAt: response.headers.get("x-haneoka-announcement-fetched-at") };
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof OperationUnavailable) throw error;
    throw new OperationUnavailable(String(error));
  }
}
export function announcementPageData(server: ReleaseServer, locale: Locale): Promise<AnnouncementPageData> {
  const key = `${server}:${locale}`;
  let pending = pages.get(key);
  if (!pending) {
    pending = staticBuildJson(`announcements:${key}`, "public-data", () => loadData(server, locale));
    pages.set(key, pending);
  }
  return pending;
}
async function loadData(server: ReleaseServer, locale: Locale): Promise<AnnouncementPageData> {
  const release = await staticCatalogRelease(server),
    requestedLocale = normalizeAuthorLocale(locale)!;
  const relative = "assets/operation/announcements.json";
  const declared = await fetchStaticReleaseEntry(relative, server, release);
  let released: AnnouncementPageData | undefined;
  const snapshot = declared
    ? await fetchStaticReleaseJson(relative, server, release) as Record<string, unknown> | null
    : null;
  if (declared && (!snapshot || snapshot.server !== server || typeof snapshot.available !== "boolean" || !Array.isArray(snapshot.announcements)))
    throw new TypeError("Invalid announcement release snapshot");
  const archived = (snapshot?.announcements ?? []) as Announcement[];
  const archivedFetchedAt = (snapshot?.fetchedAt ?? null) as string | null;
  const archivedAvailable = snapshot?.available === true;
  const selectedEntries = (entries: Announcement[], available: boolean, fetchedAt: string | null) => {
    const selection = selectAnnouncementLocale(entries, requestedLocale);
    const list = parseAnnouncementList(
      {
        server, available, fetchedAt,
        requestedLocale,
        actualSourceLocale: selection.actualSourceLocale,
        availableSourceLocales: selection.availableSourceLocales,
        announcements: selection.entries.map((entry) => ({
          ...(entry as object),
          actualSourceLocale: selection.actualSourceLocale,
        })),
      },
      server,
      requestedLocale,
    );
    return list.announcements;
  };
  if (snapshot) {
    const entries = selectedEntries(archived, archivedAvailable, archivedFetchedAt);
    released = {
      schema: "haneoka-announcement-page-v1",
      server,
      locale,
      phase: archivedAvailable ? "ready" : "unavailable",
      entries,
      snapshot: { origin: "release", fetchedAt: archivedFetchedAt, sha256: digest(entries), releaseId: release.releaseId },
    };
  }
  try {
    const query = new URLSearchParams({ server, locale: requestedLocale, include: "body" });
    const { value } = await operationJson(`/api/v1/announcements?${query}`);
    const list = parseAnnouncementList(value, server, requestedLocale);
    const includesBody = (value as { includesBody?: boolean }).includesBody === true;
    const detailErrors: number[] = [];
    const entries = await Promise.all(
      list.announcements.map(async (entry) => {
        if (includesBody || entry.html !== undefined) return entry;
        try {
          const detail = await operationJson(`/api/v1/announcements/${entry.id}?${query}`);
          if (detail.fetchedAt !== list.fetchedAt)
            throw new TypeError("Announcement snapshot changed during static build");
          return parseAnnouncementDetail(detail.value, server, entry.id, requestedLocale);
        } catch (error) {
          if (!(error instanceof OperationUnavailable)) throw error;
          detailErrors.push(entry.id);
          return entry;
        }
      }),
    );
    const available = list.available || archivedAvailable;
    const allEntries = selectedEntries(mergeAnnouncements(entries, archived, list.fetchedAt, archivedFetchedAt), available, list.fetchedAt);
    return {
      schema: "haneoka-announcement-page-v1",
      server,
      locale,
      phase: available ? "ready" : "unavailable",
      entries: allEntries,
      ...(detailErrors.length ? { detailErrors } : {}),
      snapshot: { origin: "operational", fetchedAt: list.fetchedAt, sha256: digest(allEntries) },
    };
  } catch (error) {
    if (!(error instanceof OperationUnavailable)) throw error;
    if (released) return released;
    console.warn(`Static announcement snapshot unavailable: ${server}/${locale}: ${error.message}`);
    return {
      schema: "haneoka-announcement-page-v1",
      server,
      locale,
      phase: "error",
      entries: [],
      snapshot: { origin: "operational", fetchedAt: null, sha256: digest([]) },
    };
  }
}
