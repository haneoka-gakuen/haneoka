// L3 — GEB
// Input: Real event rank observations and the private R2 archive binding.
// Output: Recent compact scores and confirmed hourly R2 archives.
// Pos: [Map](../../L2.md)；自有采集宿主的活动榜线暂存。
// Effects/Dependencies: Uses local SQLite until a conditional R2 upload succeeds.
import { DatabaseSync } from "node:sqlite";
import {
  compactEventRankPoints, eventRankArchiveKey, EVENT_RANK_DAY_MS, EVENT_RANK_HOUR_MS, EVENT_RANK_SAMPLE_MS, readEventRankArchive,
  type EventRankArchive, type EventRankIdentity, type EventRankPoint,
} from "../../../worker/event-rank-archive";
import type { EventRankMilestoneTimeline } from "../../../src/lib/game-records";

type Row = { slot: number; at: number; scores: string; pin: EventRankPoint[2] | null };
const point = (row: Row): EventRankPoint => [
  row.at, JSON.parse(row.scores) as EventRankPoint[1], ...(row.pin ? [row.pin] as const : []),
];
const SERIES = "region=? AND event=? AND kind=? AND challenge=? AND start=?";

export class EventRankBuffer {
  private readonly db: DatabaseSync;
  private readonly cutover: number;
  private flushing = false;
  private imports = 0;
  private readonly importAfter = new Map<string, number>();

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS samples (
        region TEXT NOT NULL,event TEXT NOT NULL,kind TEXT NOT NULL,challenge TEXT NOT NULL,
        start INTEGER NOT NULL,slot INTEGER NOT NULL,at INTEGER NOT NULL,scores TEXT NOT NULL,pin TEXT,
        PRIMARY KEY (region,event,kind,challenge,start,slot)
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY,value INTEGER NOT NULL) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS cold_compaction (
        region TEXT NOT NULL,event TEXT NOT NULL,kind TEXT NOT NULL,challenge TEXT NOT NULL,start INTEGER NOT NULL,
        due INTEGER NOT NULL, PRIMARY KEY(region,event,kind,challenge,start)
      ) WITHOUT ROWID`);
    this.db.prepare("INSERT OR IGNORE INTO settings VALUES ('cutover',?)").run(Date.now());
    this.cutover = Number(this.db.prepare("SELECT value FROM settings WHERE key='cutover'").get()?.value);
  }

  record(identity: EventRankIdentity, sample: EventRankPoint, endAt?: number, finalAt?: number): void {
    const [at, scores] = sample;
    const body = JSON.stringify(scores);
    const write = this.db.prepare(`INSERT INTO samples(region,event,kind,challenge,start,slot,at,scores,pin)
      VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(region,event,kind,challenge,start,slot) DO UPDATE SET
      at=excluded.at,scores=excluded.scores,pin=excluded.pin
      WHERE (excluded.slot IN (-1,-3) AND excluded.at<samples.at)
        OR (excluded.slot NOT IN (-1,-3) AND excluded.at>samples.at)`);
    this.db.exec("BEGIN");
    try {
      write.run(...identity, Math.floor(at / EVENT_RANK_SAMPLE_MS), at, body, null);
      write.run(...identity, -1, at, body, "opening");
      if (endAt && at < endAt) write.run(...identity, -2, at, body, "closing");
      if (finalAt && at >= finalAt) write.run(...identity, -3, at, body, "final");
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  read(identity: EventRankIdentity, before: number): EventRankPoint[] {
    return (this.db.prepare(`SELECT slot,at,scores,pin FROM samples WHERE ${SERIES} AND at<?
      ORDER BY at DESC LIMIT 260`).all(...identity, before) as Row[]).map(point);
  }

  private async publish(bucket: R2Bucket, identity: EventRankIdentity, archive: EventRankArchive,
    previous: Awaited<ReturnType<typeof readEventRankArchive>>): Promise<boolean> {
    const body = JSON.stringify(archive);
    if (previous && body === JSON.stringify(previous.archive)) return true;
    const compressed = await new Response(new Blob([body]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer();
    return Boolean(await bucket.put(eventRankArchiveKey(identity), compressed, {
      onlyIf: previous ? { etagMatches: previous.etag } : { etagDoesNotMatch: "*" },
      httpMetadata: { contentType: "application/json", contentEncoding: "gzip" },
    }));
  }

  private queueCold(identity: EventRankIdentity, points: EventRankPoint[], now: number): void {
    const latest = points[0]?.[0];
    if (latest === undefined || now - latest > 14 * EVENT_RANK_DAY_MS) return;
    this.db.prepare(`INSERT INTO cold_compaction VALUES(?,?,?,?,?,?)
      ON CONFLICT(region,event,kind,challenge,start) DO UPDATE SET due=excluded.due`)
      .run(...identity, latest + 14 * EVENT_RANK_DAY_MS + 60_000);
  }

  /** Promote retained older payloads a page at a time after a real chart read. */
  async importLegacy(bucket: R2Bucket, identity: EventRankIdentity,
    load: (ranks: number[], before: number) => Promise<EventRankMilestoneTimeline>): Promise<void> {
    const key = eventRankArchiveKey(identity), now = Date.now();
    if (this.imports >= 2 || (this.importAfter.get(key) ?? 0) > now) return;
    this.imports++;
    if (this.importAfter.size >= 256) this.importAfter.delete(this.importAfter.keys().next().value!);
    this.importAfter.set(key, now + 60_000);
    try {
      const previous = await readEventRankArchive(bucket, identity);
      if (previous?.archive.legacyBefore === null) return;
      const initial = previous?.archive.legacyBefore ?? this.cutover;
      const ranks = Array.from({ length: 100 }, (_, index) => identity[4] + index);
      const legacy = await load(ranks, initial);
      const imported = legacy.samples.filter(({ scores }) => scores.some((score) => score !== null))
        .map(({ atMs, scores }): EventRankPoint => [atMs, scores]);
      if (!previous && !imported.length) return;
      const points = compactEventRankPoints([...(previous?.archive.points ?? []), ...imported], now);
      if (await this.publish(bucket, identity, { contract: "haneoka:event-rank-series/1", points, legacyBefore: legacy.nextBefore }, previous))
        this.queueCold(identity, points, now);
    } finally {
      this.imports--;
    }
  }

  async flush(bucket: R2Bucket): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    const now = Date.now(), cutoff = Math.floor((now - 60_000) / EVENT_RANK_HOUR_MS) * EVENT_RANK_HOUR_MS;
    try {
      const boards = this.db.prepare(`SELECT DISTINCT region,event,kind,challenge,start FROM samples
        WHERE at<? ORDER BY region,event,kind,challenge,start LIMIT 24`).all(cutoff) as unknown as {
        region: EventRankIdentity[0]; event: string; kind: EventRankIdentity[2]; challenge: string; start: number;
      }[];
      for (const { region, event, kind, challenge, start } of boards) {
        const identity: EventRankIdentity = [region, event, kind, challenge, start];
        const rows = this.db.prepare(`SELECT slot,at,scores,pin FROM samples WHERE ${SERIES} AND at<?`)
          .all(...identity, cutoff) as Row[];
        const prior = await readEventRankArchive(bucket, identity);
        const points = compactEventRankPoints([...(prior?.archive.points ?? []), ...rows.map(point)], now);
        const saved = await this.publish(bucket, identity, { contract: "haneoka:event-rank-series/1", ...prior?.archive, points }, prior);
        if (!saved) continue;
        this.queueCold(identity, points, now);
        const remove = this.db.prepare(`DELETE FROM samples WHERE ${SERIES} AND slot=? AND at=?`);
        for (const row of rows) remove.run(...identity, row.slot, row.at);
      }
      const cold = this.db.prepare(`SELECT region,event,kind,challenge,start,due FROM cold_compaction
        WHERE due<=? ORDER BY due LIMIT 4`).all(now) as unknown as (typeof boards[number] & { due: number })[];
      for (const { region, event, kind, challenge, start, due } of cold) {
        const identity: EventRankIdentity = [region, event, kind, challenge, start];
        const prior = await readEventRankArchive(bucket, identity);
        if (prior && !await this.publish(bucket, identity,
          { ...prior.archive, points: compactEventRankPoints(prior.archive.points, now) }, prior)) continue;
        this.db.prepare(`DELETE FROM cold_compaction WHERE ${SERIES} AND due=?`).run(...identity, due);
      }
    } finally {
      this.flushing = false;
    }
  }
}
