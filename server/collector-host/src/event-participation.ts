// L3 — GEB
// Input: Profile identities from successful official event leaderboard reads.
// Output: Deduplicated lower bounds, published as small hourly R2 objects.
// Pos: [Map](../../L2.md)；活动参与人数观测。
// Effects/Dependencies: Temporary local SQLite deduplication; R2 stores aggregate counts only.
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { eventParticipationKey, readEventParticipation, type EventParticipationObservation } from "../../../worker/event-participation";
import type { GameRecordsRegion } from "../../../src/lib/game-records";

type EventRow = {
  region: GameRecordsRegion; event: string; players: number;
  first_at: number; last_at: number; expires_at: number;
};

export class EventParticipationBuffer {
  private readonly db: DatabaseSync;
  private flushing = false;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS seen (
        region TEXT NOT NULL,event TEXT NOT NULL,identity BLOB NOT NULL,
        PRIMARY KEY (region,event,identity)
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS counts (
        region TEXT NOT NULL,event TEXT NOT NULL,players INTEGER NOT NULL,
        first_at INTEGER NOT NULL,last_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,
        published_count INTEGER NOT NULL DEFAULT 0,published_at INTEGER NOT NULL DEFAULT 0,
        published_sample INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (region,event)
      ) WITHOUT ROWID`);
  }

  record(region: GameRecordsRegion, event: string, profiles: string[], at: number, expires: number): void {
    if (!profiles.length || Date.now() >= expires) return;
    const insert = this.db.prepare("INSERT OR IGNORE INTO seen VALUES (?,?,?)");
    this.db.exec("BEGIN");
    try {
      let added = 0;
      for (const profile of new Set(profiles)) {
        const identity = createHash("sha256").update(profile).digest().subarray(0, 16);
        added += Number(insert.run(region, event, identity).changes);
      }
      this.db.prepare(`INSERT INTO counts(region,event,players,first_at,last_at,expires_at) VALUES (?,?,?,?,?,?)
        ON CONFLICT(region,event) DO UPDATE SET players=counts.players+excluded.players,
          first_at=MIN(counts.first_at,excluded.first_at),last_at=MAX(counts.last_at,excluded.last_at),
          expires_at=MAX(counts.expires_at,excluded.expires_at)`)
        .run(region, event, added, at, at, expires);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  async flush(bucket: R2Bucket): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    const now = Date.now();
    try {
      const rows = this.db.prepare(`SELECT region,event,players,first_at,last_at,expires_at FROM counts
        WHERE (players>published_count AND published_at<=?) OR expires_at<=?
        ORDER BY published_at LIMIT 24`).all(now - 3_600_000, now) as EventRow[];
      for (const row of rows) {
        const observation: EventParticipationObservation = {
          contract: "haneoka:event-participation/1", region: row.region, eventId: row.event,
          coverage: "observed-lower-bound", observedPlayers: row.players,
          firstObservedAtMs: row.first_at, lastObservedAtMs: row.last_at,
        };
        const previous = await readEventParticipation(bucket, row.region, row.event);
        if (!previous || previous.observedPlayers < row.players
          || previous.observedPlayers === row.players && previous.lastObservedAtMs < row.last_at) {
          const saved = await bucket.put(eventParticipationKey(row.region, row.event), JSON.stringify(observation), {
            httpMetadata: { contentType: "application/json" },
          });
          if (!saved) continue;
        }
        this.db.exec("BEGIN");
        try {
          this.db.prepare(`UPDATE counts SET published_count=?,published_at=?,published_sample=?
            WHERE region=? AND event=?`).run(row.players, now, row.last_at, row.region, row.event);
          const retired = this.db.prepare(`DELETE FROM counts WHERE region=? AND event=? AND expires_at<=?
            AND players=published_count AND last_at=published_sample`).run(row.region, row.event, now);
          if (retired.changes) this.db.prepare("DELETE FROM seen WHERE region=? AND event=?").run(row.region, row.event);
          this.db.exec("COMMIT");
        } catch (error) {
          this.db.exec("ROLLBACK");
          throw error;
        }
      }
    } finally {
      this.flushing = false;
    }
  }
}
