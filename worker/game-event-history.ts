import type { EventRankingDto, GameRecordsRegion } from "../src/lib/game-records";
import { decodeEventHistory } from "../src/lib/game-event-history";

/** Where an archived ranking lives: summary rows in RECORDS_DB, full payloads
 * in R2. Rows not yet moved are still read from the community database. */
export interface EventHistoryBindings {
  DB?: D1Database;
  RECORDS_DB?: D1Database;
  OFFICIAL_RANKING_DATA?: R2Bucket;
}

type HistoryRow = {
  id: string;
  region: GameRecordsRegion;
  event_id: string;
  challenge_id: string;
  record_kind: "snapshot" | "tier-history";
  source_url: string;
  source_sha256: string;
  first_source_at_ms: number | null;
  last_source_at_ms: number | null;
  last_server_time_ms: number | null;
  first_observed_at_ms: number;
  last_observed_at_ms: number;
  rows_json: string;
};
const COLUMNS = `id,region,event_id,challenge_id,record_kind,source_url,source_sha256,
  first_source_at_ms,last_source_at_ms,last_server_time_ms,first_observed_at_ms,last_observed_at_ms,rows_json`;
const payloadKey = (id: string) => `event-history/${id}.json.gz`;

async function payload(env: EventHistoryBindings, id: string) {
  const object = await env.OFFICIAL_RANKING_DATA?.get(payloadKey(id));
  if (object) return decodeEventHistory([...new Uint8Array(await object.arrayBuffer())]);
  const row = await env.DB?.prepare("SELECT payload_gzip FROM game_event_ranking_history WHERE id=?")
    .bind(id)
    .first<{ payload_gzip: number[] }>();
  return row ? decodeEventHistory(row.payload_gzip) : null;
}

/** The databases holding rows, moved first. */
const sources = (env: EventHistoryBindings) => [env.RECORDS_DB, env.DB].filter((db): db is D1Database => Boolean(db));

export async function latestEventHistory(
  env: EventHistoryBindings,
  region: GameRecordsRegion,
  eventId: string,
  challengeId: string,
): Promise<EventRankingDto | null> {
  const rows = await Promise.all(
    sources(env).map((db) =>
      db
        .prepare(
          `SELECT id,last_source_at_ms,last_server_time_ms,last_observed_at_ms FROM game_event_ranking_history
    WHERE region=? AND event_id=? AND challenge_id=? AND record_kind='snapshot'
    ORDER BY COALESCE(last_source_at_ms,last_observed_at_ms) DESC,last_observed_at_ms DESC LIMIT 1`,
        )
        .bind(region, eventId, challengeId)
        .first<{
          id: string;
          last_source_at_ms: number | null;
          last_server_time_ms: number | null;
          last_observed_at_ms: number;
        }>(),
    ),
  );
  const row = rows
    .filter((value) => value !== null)
    .sort(
      (a, b) =>
        (b.last_source_at_ms ?? b.last_observed_at_ms) - (a.last_source_at_ms ?? a.last_observed_at_ms) ||
        b.last_observed_at_ms - a.last_observed_at_ms,
    )[0];
  if (!row) return null;
  const stored = await payload(env, row.id);
  return stored?.ranking
    ? { ...stored.ranking, fetchedAtMs: row.last_source_at_ms, serverTimeMs: row.last_server_time_ms, stale: true }
    : null;
}

export async function readEventHistory(
  env: EventHistoryBindings,
  region: GameRecordsRegion,
  eventId: string,
  challengeId: string,
  snapshotId?: string,
  before?: string,
): Promise<unknown> {
  const owner = async (id: string) => {
    for (const db of sources(env)) {
      const row = await db
        .prepare(
          `SELECT COALESCE(first_source_at_ms,first_observed_at_ms) AS at,id FROM game_event_ranking_history
      WHERE id=? AND region=? AND event_id=? AND challenge_id=?`,
        )
        .bind(id, region, eventId, challengeId)
        .first<{ at: number; id: string }>();
      if (row) return row;
    }
    return null;
  };
  if (snapshotId) return (await owner(snapshotId)) ? payload(env, snapshotId) : null;
  const cursor = before ? await owner(before) : null;
  if (before && !cursor) return null;
  const pages = await Promise.all(
    sources(env).map((db) =>
      db
        .prepare(
          `SELECT ${COLUMNS} FROM game_event_ranking_history WHERE region=? AND event_id=? AND challenge_id=?
    ${cursor ? "AND (COALESCE(first_source_at_ms,first_observed_at_ms),id)<(?,?)" : ""}
    ORDER BY COALESCE(first_source_at_ms,first_observed_at_ms) DESC,id DESC LIMIT 101`,
        )
        .bind(region, eventId, challengeId, ...(cursor ? [cursor.at, cursor.id] : []))
        .all<HistoryRow>(),
    ),
  );
  const at = (row: HistoryRow) => row.first_source_at_ms ?? row.first_observed_at_ms;
  const merged = pages
    .flatMap((page) => page.results)
    .sort((a, b) => at(b) - at(a) || (b.id < a.id ? -1 : b.id > a.id ? 1 : 0))
    .slice(0, 101);
  const rows = merged.slice(0, 100);
  return {
    region,
    eventId,
    ...(challengeId ? { challengeId } : {}),
    nextBefore: merged.length > 100 ? rows.at(-1)!.id : null,
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

/** Moves one batch out of the community database: payloads to R2, rows to
 * RECORDS_DB, then deletes the originals. Returns how many rows moved. */
export async function moveEventHistory(env: EventHistoryBindings, batch = 150): Promise<number> {
  if (!env.DB || !env.RECORDS_DB || !env.OFFICIAL_RANKING_DATA) return 0;
  const { results } = await env.DB.prepare(`SELECT ${COLUMNS},payload_gzip FROM game_event_ranking_history LIMIT ?`)
    .bind(batch)
    .all<HistoryRow & { payload_gzip: ArrayBuffer | number[] }>();
  if (!results.length) return 0;
  const bucket = env.OFFICIAL_RANKING_DATA;
  for (let i = 0; i < results.length; i += 10)
    await Promise.all(
      results.slice(i, i + 10).map((row) =>
        bucket.put(payloadKey(row.id), new Uint8Array(row.payload_gzip as ArrayBuffer), {
          httpMetadata: { contentType: "application/json", contentEncoding: "gzip" },
        }),
      ),
    );
  const records = env.RECORDS_DB;
  await records.batch(
    results.map((row) =>
      records
        .prepare(`INSERT OR IGNORE INTO game_event_ranking_history (${COLUMNS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(
          row.id,
          row.region,
          row.event_id,
          row.challenge_id,
          row.record_kind,
          row.source_url,
          row.source_sha256,
          row.first_source_at_ms,
          row.last_source_at_ms,
          row.last_server_time_ms,
          row.first_observed_at_ms,
          row.last_observed_at_ms,
          row.rows_json,
        ),
    ),
  );
  const db = env.DB;
  await db.batch(results.map((row) => db.prepare("DELETE FROM game_event_ranking_history WHERE id=?").bind(row.id)));
  return results.length;
}

const KEEP_ALL_MS = 2 * 86_400_000;
const JST_MS = 9 * 3_600_000;

/** Thins moved history: everything from the last two days stays; older
 * snapshots keep the last one of each Japan-time day per board. Deletes the
 * rows and their payloads; returns how many were removed. */
export async function pruneEventHistory(env: EventHistoryBindings, limit = 500): Promise<number> {
  if (!env.RECORDS_DB || !env.OFFICIAL_RANKING_DATA) return 0;
  const { results } = await env.RECORDS_DB.prepare(
    `WITH ranked AS (
      SELECT id, ROW_NUMBER() OVER (
        PARTITION BY region, event_id, challenge_id,
          CAST((COALESCE(first_source_at_ms, first_observed_at_ms) + ?) / 86400000 AS INTEGER)
        ORDER BY COALESCE(first_source_at_ms, first_observed_at_ms) DESC, id DESC) AS position
      FROM game_event_ranking_history
      WHERE record_kind = 'snapshot' AND COALESCE(first_source_at_ms, first_observed_at_ms) < ?)
    SELECT id FROM ranked WHERE position > 1 LIMIT ?`,
  )
    .bind(JST_MS, Date.now() - KEEP_ALL_MS, limit)
    .all<{ id: string }>();
  if (!results.length) return 0;
  const ids = results.map((row) => row.id);
  await env.OFFICIAL_RANKING_DATA.delete(ids.map(payloadKey));
  const records = env.RECORDS_DB;
  await records.batch(ids.map((id) => records.prepare("DELETE FROM game_event_ranking_history WHERE id=?").bind(id)));
  return ids.length;
}
