import type { Announcement } from "./announcements";
import type { ReleaseServer } from "./release-server";

export interface AnnouncementPageData {
  schema: "haneoka-announcement-page-v1";
  server: ReleaseServer;
  locale: string;
  phase: "ready" | "unavailable" | "error";
  entries: Announcement[];
  detailErrors?: number[];
  snapshot: { origin: "release" | "operational"; fetchedAt: string | null; sha256: string; releaseId?: string };
}
