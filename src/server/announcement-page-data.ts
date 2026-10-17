import { createHash } from "node:crypto";
import { normalizeAuthorLocale } from "@haneoka/i18n";
import { parseAnnouncementList, parseAnnouncementDetail, selectAnnouncementLocale } from "../lib/announcements";
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
  let response: Response;
  try {
    response = await fetch(new URL(path, origin), {
      headers: {
        accept: "application/json",
        ...(process.env.STATIC_CATALOG_TOKEN ? { "x-haneoka-build-token": process.env.STATIC_CATALOG_TOKEN } : {}),
      },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new OperationUnavailable(String(error));
  }
  if (!response.ok) throw new OperationUnavailable(`Announcement HTTP ${response.status}`);
  return { value: await response.json(), fetchedAt: response.headers.get("x-haneoka-announcement-fetched-at") };
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
  if (declared) {
    const snapshot = (await fetchStaticReleaseJson(relative, server, release)) as Record<string, unknown>;
    if (snapshot.server !== server || typeof snapshot.available !== "boolean" || !Array.isArray(snapshot.announcements))
      throw new TypeError("Invalid announcement snapshot");
    const selection = selectAnnouncementLocale(snapshot.announcements, requestedLocale);
    const list = parseAnnouncementList(
      {
        ...snapshot,
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
    return {
      schema: "haneoka-announcement-page-v1",
      server,
      locale,
      phase: list.available ? "ready" : "unavailable",
      entries: list.announcements,
      snapshot: { origin: "release", fetchedAt: list.fetchedAt, sha256: declared.sha256, releaseId: release.releaseId },
    };
  }
  try {
    const query = new URLSearchParams({ server, locale: requestedLocale });
    const { value } = await operationJson(`/api/v1/announcements?${query}`);
    const list = parseAnnouncementList(value, server, requestedLocale);
    const detailErrors: number[] = [];
    const entries = await Promise.all(
      list.announcements.map(async (entry) => {
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
    return {
      schema: "haneoka-announcement-page-v1",
      server,
      locale,
      phase: list.available ? "ready" : "unavailable",
      entries,
      ...(detailErrors.length ? { detailErrors } : {}),
      snapshot: { origin: "operational", fetchedAt: list.fetchedAt, sha256: digest(entries) },
    };
  } catch (error) {
    if (!(error instanceof OperationUnavailable)) throw error;
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
