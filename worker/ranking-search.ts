// L3 — GEB
// Input: Saved ranking windows, their current snapshot identities and a player query.
// Output: Direct ID hits, immediately available name matches and bounded leased background indexing.
// Pos: [Map](L2.md); shared search index for Arena and event point windows.
// Effects/Dependencies: Reads/writes compact D1 window indexes and backfill leases; callers load retained payloads and queue missing windows.
import type { RankingPlayerMatchDto } from "../src/lib/game-records";

export interface SearchWindow {
  startRank: number;
  snapshotId: string;
  observedAtMs: number;
}
interface SearchPlayer extends RankingPlayerMatchDto {
  search: string;
}
const object = (value: unknown) => (value && typeof value === "object" ? (value as Record<string, unknown>) : {});
export const normalizeRankingQuery = (value: string) => value.normalize("NFKC").toLowerCase();

export interface RankingProfileWindow extends SearchWindow {
  endRank: number;
  maxRank: number | null;
  playerCount: number;
  payloadKey: string;
  payloadHash: string;
  position: number;
  cachedPlayer: string | null;
}

/** ID lookup uses the existing per-window ID map and loads only its matching payload. */
export async function findRankingProfileWindow(
  db: D1Database,
  region: string,
  board: { seasonId: string; bandId: string } | { eventId: string },
  profileId: string,
): Promise<RankingProfileWindow | null> {
  const arena = "seasonId" in board;
  const table = arena ? "official_arena_window_metadata" : "official_event_window_metadata";
  const identity = arena ? "m.season_id=? AND m.band_id=?" : "m.event_id=?";
  const values = arena ? [board.seasonId, board.bandId] : [board.eventId];
  const boardKey = arena ? `arena/${board.seasonId}/${board.bandId}` : `event/${board.eventId}`;
  const path = `$."${profileId}"`;
  return db
    .prepare(
      `SELECT m.start_rank AS startRank,m.end_rank AS endRank,m.max_rank AS maxRank,
    m.player_count AS playerCount,m.snapshot_id AS snapshotId,m.observed_at_ms AS observedAtMs,
    m.payload_key AS payloadKey,m.payload_hash AS payloadHash,json_extract(m.profile_index,?) AS position,
    json_extract(i.players_json,'$['||(json_extract(m.profile_index,?)-m.start_rank)||']') AS cachedPlayer
    FROM ${table} AS m LEFT JOIN official_ranking_search_windows AS i
      ON i.region=m.region AND i.board_key=? AND i.start_rank=m.start_rank AND i.snapshot_id=m.snapshot_id
    WHERE m.region=? AND ${identity} AND json_type(m.profile_index,?) IS NOT NULL
    ORDER BY m.observed_at_ms DESC,m.start_rank LIMIT 1`,
    )
    .bind(path, path, boardKey, region, ...values, path)
    .first<RankingProfileWindow>();
}

export async function saveRankingSearchWindow(
  db: D1Database,
  region: string,
  board: string,
  window: SearchWindow,
  players: readonly unknown[],
) {
  const rows: SearchPlayer[] = players.map((value, offset) => {
    const entry = object(value),
      profile = object(entry.profile ?? entry.player_data ?? entry.playerData);
    const name = String(profile.name ?? "");
    return {
      rank: Number(entry.rank ?? window.startRank + offset),
      profileId: String(profile.profile_id ?? profile.profileId ?? "") || null,
      name,
      search: normalizeRankingQuery(name),
      point: Number(entry.point ?? entry.score ?? 0),
    };
  });
  await db
    .prepare(
      `INSERT INTO official_ranking_search_windows
    (region,board_key,start_rank,snapshot_id,observed_at_ms,players_json) VALUES (?,?,?,?,?,?)
    ON CONFLICT(region,board_key,start_rank) DO UPDATE SET snapshot_id=excluded.snapshot_id,
      observed_at_ms=excluded.observed_at_ms,players_json=excluded.players_json
    WHERE excluded.observed_at_ms>=official_ranking_search_windows.observed_at_ms`,
    )
    .bind(region, board, window.startRank, window.snapshotId, window.observedAtMs, JSON.stringify(rows))
    .run();
}

/** Old snapshots are indexed in bounded batches; newly collected windows arrive already indexed. */
export async function searchRankingWindows<T extends SearchWindow>(
  db: D1Database,
  region: string,
  board: string,
  windows: T[],
  maximum: number,
  query: string,
  after: number,
  exact: boolean,
  load: (window: T) => Promise<readonly unknown[]>,
  ctx: ExecutionContext,
) {
  const { results: indexed } = await db
    .prepare(
      `SELECT start_rank AS startRank,snapshot_id AS snapshotId,observed_at_ms AS observedAtMs
    FROM official_ranking_search_windows WHERE region=? AND board_key=?`,
    )
    .bind(region, board)
    .all<SearchWindow>();
  const snapshots = new Map(indexed.map((row) => [row.startRank, row.snapshotId]));
  const pending = windows.filter((row) => snapshots.get(row.startRank) !== row.snapshotId);
  if (pending.length)
    ctx.waitUntil(
      (async () => {
        const now = Date.now(),
          lease = crypto.randomUUID();
        const acquired = await db
          .prepare(
            `INSERT INTO official_ranking_search_backfills
      (region,board_key,lease_id,lease_until_ms) VALUES (?,?,?,?)
      ON CONFLICT(region,board_key) DO UPDATE SET lease_id=excluded.lease_id,lease_until_ms=excluded.lease_until_ms
      WHERE official_ranking_search_backfills.lease_until_ms<=? RETURNING lease_id`,
          )
          .bind(region, board, lease, now + 30_000, now)
          .first();
        if (!acquired) return;
        let retryAt = now;
        try {
          const { results: refreshed } = await db
            .prepare(
              `SELECT start_rank AS startRank,snapshot_id AS snapshotId,observed_at_ms AS observedAtMs
          FROM official_ranking_search_windows WHERE region=? AND board_key=?`,
            )
            .bind(region, board)
            .all<SearchWindow>();
          const current = new Map(refreshed.map((row) => [row.startRank, row.observedAtMs]));
          const remaining = pending.filter((row) => (current.get(row.startRank) ?? -1) < row.observedAtMs);
          for (const window of remaining.slice(0, 12)) {
            if (Date.now() - now >= 20_000) break;
            await saveRankingSearchWindow(db, region, board, window, await load(window));
          }
        } catch (error) {
          retryAt = Date.now() + 60_000;
          console.warn(
            JSON.stringify({
              event: "ranking_search_backfill_failed",
              region,
              board,
              error: error instanceof Error ? error.name : "Error",
            }),
          );
        } finally {
          await db
            .prepare(
              `UPDATE official_ranking_search_backfills SET lease_until_ms=?
        WHERE region=? AND board_key=? AND lease_id=?`,
            )
            .bind(retryAt, region, board, lease)
            .run();
        }
      })().catch((error) =>
        console.warn(
          JSON.stringify({
            event: "ranking_search_backfill_failed",
            region,
            board,
            error: error instanceof Error ? error.name : "Error",
          }),
        ),
      ),
    );
  const { results } = await db
    .prepare(
      `SELECT json_extract(p.value,'$.rank') AS rank,
    json_extract(p.value,'$.profileId') AS profileId,json_extract(p.value,'$.name') AS name,
    json_extract(p.value,'$.point') AS point,w.start_rank+CAST(p.key AS INTEGER) AS position,w.observed_at_ms AS sourceObservedAt FROM official_ranking_search_windows AS w,json_each(w.players_json) AS p
    WHERE w.region=? AND w.board_key=? AND w.start_rank<=? AND w.start_rank+CAST(p.key AS INTEGER)<=? AND w.start_rank+CAST(p.key AS INTEGER)>? AND (json_extract(p.value,'$.profileId')=?
      OR (?=0 AND instr(json_extract(p.value,'$.search'),?)>0)) ORDER BY w.start_rank,CAST(p.key AS INTEGER) LIMIT 101`,
    )
    .bind(region, board, maximum, maximum, after, query, exact ? 1 : 0, normalizeRankingQuery(query))
    .all<RankingPlayerMatchDto & { position: number; sourceObservedAt: number }>();
  // A player can move between independently collected windows; keep their best observed rank.
  const seen = new Set<string>();
  const page = results.slice(0, 100);
  const matches = page
    .filter((row) => {
      if (!row.profileId) return true;
      if (seen.has(row.profileId)) return false;
      seen.add(row.profileId);
      return true;
    })
    .map(({ position: _position, sourceObservedAt: _observedAt, ...row }) => row);
  return {
    matches,
    nextCursor: results.length > 100 ? page.at(-1)!.position : null,
    complete: pending.length === 0,
    observedAtMs: results.length
      ? results.reduce((time, row) => Math.min(time, row.sourceObservedAt), Date.now())
      : indexed.length
        ? indexed.reduce((time, row) => Math.min(time, row.observedAtMs), Date.now())
        : 0,
  };
}
