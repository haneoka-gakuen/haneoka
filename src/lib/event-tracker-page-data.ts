import type { EventTrackerDto, GameRecordsRegion, RankingCardCatalog, TrackedEventDto } from "./game-records";
import type { ReleaseServer } from "./release-server";
export interface EventTrackerSnapshot {
  phase: "ready" | "error";
  data: EventTrackerDto | null;
  info: Record<string, unknown> | null;
  songs: Record<string, Record<string, unknown>>;
  infoServer: ReleaseServer;
  /** Every event with known boards, newest first. */
  archive?: TrackedEventDto[];
}
/** One event in the rail. */
export interface TrackerRailEvent {
  id: string;
  title: unknown;
  image: string;
  startAtMs: number;
  endAtMs: number;
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
  events?: Partial<Record<"jp" | "intl", TrackerRailEvent[]>>;
};
