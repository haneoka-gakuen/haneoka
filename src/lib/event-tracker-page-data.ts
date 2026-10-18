import type { EventTrackerDto, GameRecordsRegion, RankingCardCatalog } from "./game-records";
import type { ReleaseServer } from "./release-server";
export interface EventTrackerSnapshot {
  phase: "ready" | "error";
  data: EventTrackerDto | null;
  info: Record<string, unknown> | null;
  songs: Record<string, Record<string, unknown>>;
  infoServer: ReleaseServer;
}
export type TrackerPageData = Partial<Record<"jp" | "intl", RankingCardCatalog>> & {
  schema?: "haneoka-event-tracker-page-v1";
  musicTypeMarks?: Partial<Record<"jp" | "intl", Record<string, string>>>;
  songPerformers?: Partial<
    Record<
      "jp" | "intl",
      { sourceId?: string; bands: Record<string, unknown>[]; characters: Record<string, unknown>[] }
    >
  >;
  snapshots?: Partial<Record<GameRecordsRegion, EventTrackerSnapshot>>;
};
