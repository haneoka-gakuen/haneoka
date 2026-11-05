// L3 — GEB
// Input: Saved ranking windows, their current snapshot identities and a player query.
// Output: Complete-board player matches or bounded missing/indexing work.
// Pos: [Map](L2.md); shared search index for Arena and event point windows.
// Effects/Dependencies: Reads/writes compact D1 window indexes; callers load retained payloads and queue missing windows.
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
) {
  const { results: indexed } = await db
    .prepare(
      `SELECT start_rank AS startRank,snapshot_id AS snapshotId
    FROM official_ranking_search_windows WHERE region=? AND board_key=?`,
    )
    .bind(region, board)
    .all<SearchWindow>();
  const snapshots = new Map(indexed.map((row) => [row.startRank, row.snapshotId]));
  const pending = windows.filter((row) => snapshots.get(row.startRank) !== row.snapshotId);
  for (const window of pending.slice(0, 12))
    await saveRankingSearchWindow(db, region, board, window, await load(window));
  if (pending.length > 12) return null;
  const { results } = await db
    .prepare(
      `SELECT json_extract(p.value,'$.rank') AS rank,
    json_extract(p.value,'$.profileId') AS profileId,json_extract(p.value,'$.name') AS name,
    json_extract(p.value,'$.point') AS point,w.start_rank+CAST(p.key AS INTEGER) AS position FROM official_ranking_search_windows AS w,json_each(w.players_json) AS p
    WHERE w.region=? AND w.board_key=? AND w.start_rank<=? AND w.start_rank+CAST(p.key AS INTEGER)<=? AND w.start_rank+CAST(p.key AS INTEGER)>? AND (json_extract(p.value,'$.profileId')=?
      OR (?=0 AND instr(json_extract(p.value,'$.search'),?)>0)) ORDER BY w.start_rank,CAST(p.key AS INTEGER) LIMIT 101`,
    )
    .bind(region, board, maximum, maximum, after, query, exact ? 1 : 0, normalizeRankingQuery(query))
    .all<RankingPlayerMatchDto & { position: number }>();
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
    .map(({ position: _position, ...row }) => row);
  return { matches, nextCursor: results.length > 100 ? page.at(-1)!.position : null };
}
