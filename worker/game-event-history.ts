import type { EventRankingDto, GameRecordsRegion } from "../src/lib/game-records";
import {
  decodeEventHistory,
  eventHistoryIdentity,
  prepareEventHistory,
  type EventHistoryInput,
  type HistoryKind,
} from "../src/lib/game-event-history";

type HistoryRow = {
  id: string;
  region: GameRecordsRegion;
  event_id: string;
  challenge_id: string;
  record_kind: HistoryKind;
  source_url: string;
  source_sha256: string;
  first_source_at_ms: number | null;
  last_source_at_ms: number | null;
  last_server_time_ms: number | null;
  first_observed_at_ms: number;
  last_observed_at_ms: number;
  rows_json: string;
};
export async function saveEventHistory(db: D1Database, input: EventHistoryInput): Promise<void> {
  const observedAtMs = Date.now(),
    { id } = await eventHistoryIdentity(input);
  const update = await db
    .prepare(
      `UPDATE game_event_ranking_history SET
    first_source_at_ms=CASE WHEN ? IS NULL THEN first_source_at_ms
      WHEN first_source_at_ms IS NULL THEN ? ELSE MIN(first_source_at_ms,?) END,
    last_source_at_ms=CASE WHEN ? IS NULL THEN last_source_at_ms
      WHEN last_source_at_ms IS NULL THEN ? ELSE MAX(last_source_at_ms,?) END,
    last_server_time_ms=CASE WHEN ? IS NULL THEN last_server_time_ms
      WHEN last_server_time_ms IS NULL THEN ? ELSE MAX(last_server_time_ms,?) END,
    last_observed_at_ms=MAX(last_observed_at_ms,?) WHERE id=?`,
    )
    .bind(
      input.sourceAtMs,
      input.sourceAtMs,
      input.sourceAtMs,
      input.sourceAtMs,
      input.sourceAtMs,
      input.sourceAtMs,
      input.ranking?.serverTimeMs ?? null,
      input.ranking?.serverTimeMs ?? null,
      input.ranking?.serverTimeMs ?? null,
      observedAtMs,
      id,
    )
    .run();
  if (update.meta.changes) return;
  const prepared = await prepareEventHistory(input, observedAtMs);
  await db
    .prepare(
      `INSERT INTO game_event_ranking_history
    (id,region,event_id,challenge_id,record_kind,source_url,source_sha256,
      first_source_at_ms,last_source_at_ms,last_server_time_ms,first_observed_at_ms,last_observed_at_ms,rows_json,payload_gzip)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET
      first_source_at_ms=CASE WHEN excluded.first_source_at_ms IS NULL THEN first_source_at_ms
        WHEN first_source_at_ms IS NULL THEN excluded.first_source_at_ms ELSE MIN(first_source_at_ms,excluded.first_source_at_ms) END,
      last_source_at_ms=CASE WHEN excluded.last_source_at_ms IS NULL THEN last_source_at_ms
        WHEN last_source_at_ms IS NULL THEN excluded.last_source_at_ms ELSE MAX(last_source_at_ms,excluded.last_source_at_ms) END,
      last_server_time_ms=CASE WHEN excluded.last_server_time_ms IS NULL THEN last_server_time_ms
        WHEN last_server_time_ms IS NULL THEN excluded.last_server_time_ms ELSE MAX(last_server_time_ms,excluded.last_server_time_ms) END,
      last_observed_at_ms=MAX(last_observed_at_ms,excluded.last_observed_at_ms)`,
    )
    .bind(
      prepared.id,
      input.region,
      input.eventId,
      input.challengeId ?? "",
      input.kind,
      input.sourceUrl,
      prepared.sourceSha256,
      input.sourceAtMs,
      input.sourceAtMs,
      input.ranking?.serverTimeMs ?? null,
      prepared.observedAtMs,
      prepared.observedAtMs,
      prepared.rowsJson,
      prepared.payloadGzip,
    )
    .run();
}

export async function latestEventHistory(
  db: D1Database,
  region: GameRecordsRegion,
  eventId: string,
  challengeId: string,
): Promise<EventRankingDto | null> {
  const row = await db
    .prepare(
      `SELECT payload_gzip,last_source_at_ms,last_server_time_ms FROM game_event_ranking_history
    WHERE region=? AND event_id=? AND challenge_id=? AND record_kind='snapshot'
    ORDER BY COALESCE(last_source_at_ms,last_observed_at_ms) DESC,last_observed_at_ms DESC LIMIT 1`,
    )
    .bind(region, eventId, challengeId)
    .first<{ payload_gzip: number[]; last_source_at_ms: number | null; last_server_time_ms: number | null }>();
  if (!row) return null;
  const payload = await decodeEventHistory(row.payload_gzip);
  return payload.ranking
    ? { ...payload.ranking, fetchedAtMs: row.last_source_at_ms, serverTimeMs: row.last_server_time_ms, stale: true }
    : null;
}

export async function cachedEventHistory(
  db: D1Database,
  region: GameRecordsRegion,
  eventId: string,
  challengeId: string,
): Promise<EventRankingDto | null> {
  const row = await db
    .prepare(
      `SELECT h.payload_gzip,h.last_source_at_ms,h.last_server_time_ms,h.last_observed_at_ms,c.finalized_json
    FROM game_event_ranking_history AS h LEFT JOIN game_event_ranking_collection AS c ON c.region=h.region
    WHERE h.region=? AND h.event_id=? AND h.challenge_id=? AND h.record_kind='snapshot'
    ORDER BY COALESCE(h.last_source_at_ms,h.last_observed_at_ms) DESC,h.last_observed_at_ms DESC LIMIT 1`,
    )
    .bind(region, eventId, challengeId)
    .first<{
      payload_gzip: number[];
      last_source_at_ms: number | null;
      last_server_time_ms: number | null;
      last_observed_at_ms: number;
      finalized_json: string | null;
    }>();
  if (!row) return null;
  const finalized = row.finalized_json ? (JSON.parse(row.finalized_json) as string[]) : [];
  if (row.last_observed_at_ms < Date.now() - 60_000 && !finalized.includes(`${eventId}:${challengeId}`)) return null;
  const payload = await decodeEventHistory(row.payload_gzip);
  return payload.ranking
    ? { ...payload.ranking, fetchedAtMs: row.last_source_at_ms, serverTimeMs: row.last_server_time_ms }
    : null;
}

export async function readEventHistory(
  db: D1Database,
  region: GameRecordsRegion,
  eventId: string,
  challengeId: string,
  snapshotId?: string,
  before?: string,
): Promise<unknown> {
  if (snapshotId) {
    const row = await db
      .prepare(
        `SELECT payload_gzip FROM game_event_ranking_history
      WHERE id=? AND region=? AND event_id=? AND challenge_id=?`,
      )
      .bind(snapshotId, region, eventId, challengeId)
      .first<{ payload_gzip: number[] }>();
    return row ? await decodeEventHistory(row.payload_gzip) : null;
  }
  const cursor = before
    ? ` AND (COALESCE(first_source_at_ms,first_observed_at_ms),id)<
    (SELECT COALESCE(first_source_at_ms,first_observed_at_ms),id FROM game_event_ranking_history
      WHERE id=? AND region=? AND event_id=? AND challenge_id=?)`
    : "";
  const statement = db.prepare(`SELECT id,region,event_id,challenge_id,record_kind,source_url,source_sha256,
    first_source_at_ms,last_source_at_ms,last_server_time_ms,first_observed_at_ms,last_observed_at_ms,rows_json
    FROM game_event_ranking_history WHERE region=? AND event_id=? AND challenge_id=?${cursor}
    ORDER BY COALESCE(first_source_at_ms,first_observed_at_ms) DESC,id DESC LIMIT 101`);
  const result = await (
    before
      ? statement.bind(region, eventId, challengeId, before, region, eventId, challengeId)
      : statement.bind(region, eventId, challengeId)
  ).all<HistoryRow>();
  const rows = result.results.slice(0, 100);
  return {
    region,
    eventId,
    ...(challengeId ? { challengeId } : {}),
    nextBefore: result.results.length > 100 ? rows.at(-1)!.id : null,
    snapshots: rows.map((row) => ({
      id: row.id,
      kind: row.record_kind,
      sourceUrl: row.source_url,
      sourceSha256: row.source_sha256,
      firstSourceAtMs: row.first_source_at_ms,
      lastSourceAtMs: row.last_source_at_ms,
      lastServerTimeMs: row.last_server_time_ms,
      firstObservedAtMs: row.first_observed_at_ms,
      lastObservedAtMs: row.last_observed_at_ms,
      rows: JSON.parse(row.rows_json) as unknown[],
    })),
  };
}
