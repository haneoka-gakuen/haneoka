// L3 — GEB
// Input: Validated official catalogs, observations and region-scoped read identities.
// Output: Immutable R2 payloads, D1 indexes, numeric history cursors and board health; Arena league windows and complete populations separately.
// Pos: [Map](L2.md); official ranking persistence, separate from legacy provider history.
// Effects/Dependencies: Reads and writes private R2 and D1; reads preserve original observation timestamps.
import type { GameRecordsRegion } from "../src/lib/game-records";
import type { OfficialArenaObservation, OfficialArenaPopulationObservation, OfficialCatalog, OfficialObservation } from "../src/lib/official-ranking";

export interface OfficialRankingStoreBindings {
  DB?: D1Database;
  OFFICIAL_RANKING_DATA?: R2Bucket;
}

export interface StoredOfficialObservation extends OfficialObservation {
  cursor: number;
  payloadHash: string;
}

interface ObservationRow {
  cursor: number;
  payload_key: string;
  payload_hash: string;
}

const MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;
export const OFFICIAL_RANKING_STALE_MS = 600_000;

export async function officialDigest(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function storage(env: OfficialRankingStoreBindings): { db: D1Database; bucket: R2Bucket } {
  if (!env.DB || !env.OFFICIAL_RANKING_DATA) throw new Error("official_storage_unavailable");
  return { db: env.DB, bucket: env.OFFICIAL_RANKING_DATA };
}

async function readPayload<T>(bucket: R2Bucket, key: string, expectedHash: string): Promise<T> {
  const object = await bucket.get(key);
  if (!object || object.size > MAX_PAYLOAD_BYTES) throw new Error("official_payload_unavailable");
  const body = await object.text();
  if (await officialDigest(body) !== expectedHash) throw new Error("official_payload_integrity");
  return JSON.parse(body) as T;
}

export async function saveOfficialCatalog(env: OfficialRankingStoreBindings, catalog: OfficialCatalog): Promise<void> {
  const { db, bucket } = storage(env);
  const previous = await readOfficialCatalog(env, catalog.region);
  if (previous && catalog.catalogObservedAtMs < previous.catalogObservedAtMs) throw new Error("official_catalog_regressed");
  const highest = await db.prepare("SELECT highest_event_id, event_identity FROM official_ranking_catalogs WHERE region = ?")
    .bind(catalog.region).first<{ highest_event_id: string; event_identity: string }>();
  const eventId = catalog.event?.id;
  if (eventId && highest && BigInt(eventId) < BigInt(highest.highest_event_id)) throw new Error("official_event_regressed");
  if (eventId && highest?.highest_event_id === eventId) {
    const identities = new Set(catalog.event!.challenges.map((challenge) => `${challenge.id}:${challenge.musicId}`));
    if ((JSON.parse(highest.event_identity) as string[]).some((identity) => !identities.has(identity))) {
      throw new Error("official_challenge_identity_changed");
    }
  }
  const body = JSON.stringify(catalog);
  if (new TextEncoder().encode(body).byteLength > MAX_PAYLOAD_BYTES) throw new Error("official_catalog_too_large");
  const hash = await officialDigest(body);
  const key = `official/1/${catalog.region}/catalogs/${hash}.json`;
  await bucket.put(key, body, { httpMetadata: { contentType: "application/json" } });
  await db.prepare(`INSERT INTO official_ranking_catalogs
    (region, highest_event_id, event_identity, observed_at_ms, payload_key, payload_hash)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(region) DO UPDATE SET highest_event_id = excluded.highest_event_id,
      event_identity = excluded.event_identity,
      observed_at_ms = excluded.observed_at_ms, payload_key = excluded.payload_key, payload_hash = excluded.payload_hash
    WHERE excluded.observed_at_ms >= official_ranking_catalogs.observed_at_ms`)
    .bind(catalog.region, eventId ?? highest?.highest_event_id ?? "0",
      catalog.event ? JSON.stringify(catalog.event.challenges.map((challenge) => `${challenge.id}:${challenge.musicId}`)) : highest?.event_identity ?? "[]",
      catalog.catalogObservedAtMs, key, hash).run();
}

export async function readOfficialCatalog(env: OfficialRankingStoreBindings, region: GameRecordsRegion): Promise<OfficialCatalog | null> {
  const { db, bucket } = storage(env);
  const row = await db.prepare("SELECT payload_key, payload_hash FROM official_ranking_catalogs WHERE region = ?")
    .bind(region).first<ObservationRow>();
  if (!row) return null;
  const catalog = await readPayload<OfficialCatalog>(bucket, row.payload_key, row.payload_hash);
  if (catalog.region !== region) throw new Error("official_region_mismatch");
  return catalog;
}

export async function saveOfficialObservation(env: OfficialRankingStoreBindings, observation: OfficialObservation): Promise<void> {
  const { db, bucket } = storage(env);
  const body = JSON.stringify(observation);
  if (new TextEncoder().encode(body).byteLength > MAX_PAYLOAD_BYTES) throw new Error("official_observation_too_large");
  const hash = await officialDigest(body);
  const previous = await db.prepare("SELECT payload_hash FROM official_ranking_observations WHERE region = ? AND snapshot_id = ?")
    .bind(observation.region, observation.snapshotId).first<{ payload_hash: string }>();
  if (previous) {
    if (previous.payload_hash !== hash) throw new Error("official_observation_conflict");
    return;
  }
  const key = `official/1/${observation.region}/observations/${observation.snapshotId}/${hash}.json`;
  await bucket.put(key, body, { httpMetadata: { contentType: "application/json" } });
  await db.batch([
    db.prepare(`INSERT INTO official_ranking_observations
      (region, snapshot_id, event_id, board_kind, challenge_id, observed_at_ms, payload_key, payload_hash, error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(region, snapshot_id) DO NOTHING`)
      .bind(observation.region, observation.snapshotId, observation.eventId, observation.kind, observation.challengeId,
        observation.observedAtMs, key, hash, observation.error ?? null),
    db.prepare(`INSERT INTO official_ranking_board_status
      (region, event_id, board_kind, challenge_id, last_attempt_ms, last_success_ms, last_success_cursor, last_cursor, consecutive_failures)
      SELECT region, event_id, board_kind, challenge_id, observed_at_ms,
        CASE WHEN error IS NULL THEN observed_at_ms ELSE NULL END, CASE WHEN error IS NULL THEN cursor ELSE NULL END,
        cursor, CASE WHEN error IS NULL THEN 0 ELSE 1 END
      FROM official_ranking_observations WHERE region = ? AND snapshot_id = ? AND payload_hash = ?
      ON CONFLICT(region, event_id, board_kind, challenge_id) DO UPDATE SET
        last_attempt_ms = MAX(official_ranking_board_status.last_attempt_ms, excluded.last_attempt_ms),
        last_success_ms = CASE WHEN excluded.last_success_ms IS NULL THEN official_ranking_board_status.last_success_ms
          ELSE MAX(COALESCE(official_ranking_board_status.last_success_ms, 0), excluded.last_success_ms) END,
        last_success_cursor = CASE WHEN excluded.last_success_ms IS NOT NULL
          AND (official_ranking_board_status.last_success_ms IS NULL OR excluded.last_success_ms >= official_ranking_board_status.last_success_ms)
          THEN excluded.last_success_cursor ELSE official_ranking_board_status.last_success_cursor END,
        last_cursor = excluded.last_cursor,
        consecutive_failures = CASE WHEN excluded.last_success_ms IS NULL THEN
          CASE WHEN official_ranking_board_status.last_success_ms IS NULL
            OR excluded.last_attempt_ms >= official_ranking_board_status.last_success_ms
            THEN official_ranking_board_status.consecutive_failures + 1 ELSE official_ranking_board_status.consecutive_failures END
          WHEN excluded.last_success_ms < COALESCE(official_ranking_board_status.last_success_ms, 0)
            THEN official_ranking_board_status.consecutive_failures
          WHEN excluded.last_attempt_ms >= official_ranking_board_status.last_attempt_ms THEN 0
          ELSE (SELECT COUNT(*) FROM official_ranking_observations AS later
            WHERE later.region = excluded.region AND later.event_id = excluded.event_id
              AND later.board_kind = excluded.board_kind AND later.challenge_id = excluded.challenge_id
              AND later.error IS NOT NULL AND (later.observed_at_ms > excluded.last_success_ms
                OR (later.observed_at_ms = excluded.last_success_ms AND later.cursor > excluded.last_success_cursor))) END
      WHERE excluded.last_cursor > official_ranking_board_status.last_cursor`).bind(observation.region, observation.snapshotId, hash),
  ]);
  const saved = await db.prepare("SELECT payload_hash FROM official_ranking_observations WHERE region = ? AND snapshot_id = ?")
    .bind(observation.region, observation.snapshotId).first<{ payload_hash: string }>();
  if (saved?.payload_hash !== hash) throw new Error("official_observation_conflict");
}

async function observationPayload(bucket: R2Bucket, row: ObservationRow, region: GameRecordsRegion, eventId: string,
  kind: OfficialObservation["kind"], challengeId: string): Promise<StoredOfficialObservation> {
  const observation = await readPayload<OfficialObservation>(bucket, row.payload_key, row.payload_hash);
  if (observation.region !== region || observation.eventId !== eventId || observation.kind !== kind || observation.challengeId !== challengeId) {
    throw new Error("official_observation_identity_mismatch");
  }
  return { ...observation, cursor: row.cursor, payloadHash: row.payload_hash };
}

export async function readOfficialLatest(env: OfficialRankingStoreBindings, region: GameRecordsRegion, eventId: string,
  kind: OfficialObservation["kind"], challengeId: string): Promise<StoredOfficialObservation | null> {
  const { db, bucket } = storage(env);
  const row = await db.prepare(`SELECT cursor, payload_key, payload_hash FROM official_ranking_observations
    WHERE region = ? AND event_id = ? AND board_kind = ? AND challenge_id = ? AND error IS NULL
    ORDER BY observed_at_ms DESC, cursor DESC LIMIT 1`).bind(region, eventId, kind, challengeId).first<ObservationRow>();
  return row ? observationPayload(bucket, row, region, eventId, kind, challengeId) : null;
}

export async function readOfficialHistory(env: OfficialRankingStoreBindings, region: GameRecordsRegion, eventId: string,
  kind: OfficialObservation["kind"], challengeId: string, after: number): Promise<{ observations: StoredOfficialObservation[]; nextCursor: number }> {
  const { db, bucket } = storage(env);
  const { results } = await db.prepare(`SELECT cursor, payload_key, payload_hash FROM official_ranking_observations
    WHERE region = ? AND event_id = ? AND board_kind = ? AND challenge_id = ? AND cursor > ?
    ORDER BY cursor LIMIT 100`).bind(region, eventId, kind, challengeId, after).all<ObservationRow>();
  const observations: StoredOfficialObservation[] = [];
  let bytes = 0;
  for (const row of results) {
    const observation = await observationPayload(bucket, row, region, eventId, kind, challengeId);
    const size = new TextEncoder().encode(JSON.stringify(observation)).byteLength;
    if (observations.length && bytes + size > MAX_PAYLOAD_BYTES / 2) break;
    observations.push(observation);
    bytes += size;
  }
  return { observations, nextCursor: observations.at(-1)?.cursor ?? after };
}

export interface OfficialBoardStatus {
  kind: OfficialObservation["kind"];
  challengeId: string;
  lastAttemptAtMs: number | null;
  lastSuccessfulObservationAtMs: number | null;
  consecutiveFailures: number;
  ageMs: number | null;
  stale: boolean;
  openGapMs: number | null;
}

export async function readOfficialBoardStatus(env: OfficialRankingStoreBindings, region: GameRecordsRegion, eventId: string): Promise<OfficialBoardStatus[]> {
  const { db } = storage(env);
  const { results } = await db.prepare(`SELECT board_kind, challenge_id, last_attempt_ms, last_success_ms, consecutive_failures
    FROM official_ranking_board_status WHERE region = ? AND event_id = ? ORDER BY board_kind, challenge_id`)
    .bind(region, eventId).all<{ board_kind: OfficialObservation["kind"]; challenge_id: string; last_attempt_ms: number;
      last_success_ms: number | null; consecutive_failures: number }>();
  const now = Date.now();
  const boards: OfficialBoardStatus[] = [];
  for (const row of results) {
    const age = row.last_success_ms === null ? null : now - row.last_success_ms;
    boards.push({ kind: row.board_kind, challengeId: row.challenge_id, lastAttemptAtMs: row.last_attempt_ms,
      lastSuccessfulObservationAtMs: row.last_success_ms, consecutiveFailures: row.consecutive_failures,
      ageMs: age, stale: age === null || age < 0 || age > OFFICIAL_RANKING_STALE_MS,
      openGapMs: age === null ? null : Math.max(0, age - 300_000) });
  }
  return boards;
}

export async function saveOfficialArenaObservation(env: OfficialRankingStoreBindings, observation: OfficialArenaObservation): Promise<void> {
  const { db, bucket } = storage(env);
  const body = JSON.stringify(observation);
  if (new TextEncoder().encode(body).byteLength > MAX_PAYLOAD_BYTES) throw new Error("official_observation_too_large");
  const hash = await officialDigest(body);
  const previous = await db.prepare("SELECT payload_hash FROM official_arena_ranking_observations WHERE region = ? AND snapshot_id = ?")
    .bind(observation.region, observation.snapshotId).first<{ payload_hash: string }>();
  if (previous) {
    if (previous.payload_hash !== hash) throw new Error("official_observation_conflict");
  }
  const key = `official/1/${observation.region}/arena/${observation.snapshotId}/${hash}.json`;
  if (!previous) {
    await bucket.put(key, body, { httpMetadata: { contentType: "application/json" } });
    await db.prepare(`INSERT INTO official_arena_ranking_observations
    (region, snapshot_id, season_id, band_id, start_rank, end_rank, max_rank, observed_at_ms, payload_key, payload_hash, error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(region, snapshot_id) DO NOTHING`)
    .bind(observation.region, observation.snapshotId, observation.seasonId, observation.bandId, observation.startRank,
      observation.endRank, observation.maxRank ?? null, observation.observedAtMs, key, hash, observation.error ?? null).run();
  }
  if (!observation.error && observation.players) {
    const profiles: Record<string, number> = {};
    observation.players.forEach((player, index) => {
      const profile = player.profile as Record<string, unknown> | undefined;
      const id = profile?.profile_id ?? profile?.profileId;
      if (typeof id === "string" && /^[1-9][0-9]{0,18}$/u.test(id)) profiles[id] = observation.startRank + index;
    });
    await db.prepare(`INSERT INTO official_arena_window_metadata
      (region, season_id, band_id, start_rank, end_rank, max_rank, player_count, profile_index, snapshot_id, observed_at_ms, payload_key, payload_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(region, season_id, band_id, start_rank) DO UPDATE SET
      end_rank=excluded.end_rank, max_rank=excluded.max_rank, player_count=excluded.player_count, profile_index=excluded.profile_index,
      snapshot_id=excluded.snapshot_id, observed_at_ms=excluded.observed_at_ms, payload_key=excluded.payload_key, payload_hash=excluded.payload_hash
      WHERE excluded.observed_at_ms >= official_arena_window_metadata.observed_at_ms`)
      .bind(observation.region, observation.seasonId, observation.bandId, observation.startRank, observation.endRank,
        observation.maxRank ?? null, observation.players.length, JSON.stringify(profiles), observation.snapshotId,
        observation.observedAtMs, key, hash).run();
  }
}

export interface OfficialArenaWindowMetadata {
  startRank: number;
  endRank: number;
  maxRank: number | null;
  playerCount: number;
  profileIndex: string;
  snapshotId: string;
  observedAtMs: number;
  payloadKey: string;
  payloadHash: string;
}

export async function readOfficialArenaSearchWindows(env: OfficialRankingStoreBindings, region: GameRecordsRegion,
  seasonId: string, bandId: string, depth: number): Promise<OfficialArenaWindowMetadata[]> {
  const { db } = storage(env);
  const { results } = await db.prepare(`SELECT start_rank AS startRank, end_rank AS endRank, max_rank AS maxRank,
    player_count AS playerCount, profile_index AS profileIndex, snapshot_id AS snapshotId, observed_at_ms AS observedAtMs,
    payload_key AS payloadKey, payload_hash AS payloadHash FROM official_arena_window_metadata
    WHERE region = ? AND season_id = ? AND band_id = ? AND start_rank BETWEEN 1 AND ? ORDER BY start_rank LIMIT 20`)
    .bind(region, seasonId, bandId, depth).all<OfficialArenaWindowMetadata>();
  return results;
}

export async function readOfficialArenaSearchMatch(env: OfficialRankingStoreBindings,
  metadata: OfficialArenaWindowMetadata): Promise<OfficialArenaObservation> {
  const { bucket } = storage(env);
  return readPayload<OfficialArenaObservation>(bucket, metadata.payloadKey, metadata.payloadHash);
}

/** The latest successful aligned window of a league board that contains `rank`. */
export async function readOfficialArenaLatest(env: OfficialRankingStoreBindings, region: GameRecordsRegion, seasonId: string,
  bandId: string, rank: number): Promise<(OfficialArenaObservation & { cursor: number }) | null> {
  const { db, bucket } = storage(env);
  const row = await db.prepare(`SELECT cursor, payload_key, payload_hash FROM official_arena_ranking_observations
    WHERE region = ? AND season_id = ? AND band_id = ? AND start_rank = ? AND end_rank >= ? AND error IS NULL
    ORDER BY observed_at_ms DESC, cursor DESC LIMIT 1`).bind(region, seasonId, bandId, Math.floor((rank - 1) / 100) * 100 + 1, rank).first<ObservationRow>();
  if (!row) return null;
  const observation = await readPayload<OfficialArenaObservation>(bucket, row.payload_key, row.payload_hash);
  if (observation.region !== region || observation.seasonId !== seasonId || observation.bandId !== bandId) {
    throw new Error("official_observation_identity_mismatch");
  }
  return { ...observation, cursor: row.cursor };
}

export async function readOfficialArenaMetadata(env: OfficialRankingStoreBindings, region: GameRecordsRegion,
  seasonId: string, bandId: string): Promise<{ snapshotId: string; observedAtMs: number; maxRank: number | null } | null> {
  const { db } = storage(env);
  return db.prepare(`SELECT snapshot_id AS snapshotId, observed_at_ms AS observedAtMs, max_rank AS maxRank
    FROM official_arena_ranking_observations WHERE region = ? AND season_id = ? AND band_id = ? AND error IS NULL
    ORDER BY observed_at_ms DESC, cursor DESC LIMIT 1`).bind(region, seasonId, bandId)
    .first<{ snapshotId: string; observedAtMs: number; maxRank: number | null }>();
}

export async function saveOfficialArenaPopulation(env: OfficialRankingStoreBindings,
  observation: OfficialArenaPopulationObservation): Promise<void> {
  const { db, bucket } = storage(env);
  const body = JSON.stringify(observation);
  if (new TextEncoder().encode(body).byteLength > MAX_PAYLOAD_BYTES) throw new Error("official_observation_too_large");
  const hash = await officialDigest(body);
  const previous = await db.prepare("SELECT payload_hash FROM official_arena_population_observations WHERE region = ? AND snapshot_id = ?")
    .bind(observation.region, observation.snapshotId).first<{ payload_hash: string }>();
  if (previous) {
    if (previous.payload_hash !== hash) throw new Error("official_observation_conflict");
    return;
  }
  const key = `official/1/${observation.region}/arena-population/${observation.snapshotId}/${hash}.json`;
  await bucket.put(key, body, { httpMetadata: { contentType: "application/json" } });
  await db.prepare(`INSERT INTO official_arena_population_observations
    (region, snapshot_id, season_id, band_id, max_rank, observed_at_ms, payload_key, payload_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(region, snapshot_id) DO NOTHING`)
    .bind(observation.region, observation.snapshotId, observation.seasonId, observation.bandId, observation.maxRank,
      observation.observedAtMs, key, hash).run();
}

export async function readOfficialArenaPopulation(env: OfficialRankingStoreBindings, region: GameRecordsRegion,
  seasonId: string, bandId: string): Promise<OfficialArenaPopulationObservation | null> {
  const { db, bucket } = storage(env);
  const row = await db.prepare(`SELECT cursor, payload_key, payload_hash FROM official_arena_population_observations
    WHERE region = ? AND season_id = ? AND band_id = ? ORDER BY observed_at_ms DESC, cursor DESC LIMIT 1`)
    .bind(region, seasonId, bandId).first<ObservationRow>();
  if (!row) return null;
  const observation = await readPayload<OfficialArenaPopulationObservation>(bucket, row.payload_key, row.payload_hash);
  if (observation.region !== region || observation.seasonId !== seasonId || observation.bandId !== bandId) {
    throw new Error("official_observation_identity_mismatch");
  }
  return observation;
}

export interface OfficialPlayerRecord {
  found: boolean;
  profile: Record<string, unknown> | null;
  totalFavorite: string | null;
  observedAtMs: number;
}
interface OfficialPlayerRow {
  profileId: string;
  found: number;
  profile: string | null;
  totalFavorite: string | null;
  observedAtMs: number;
}
const playerRecord = (row: OfficialPlayerRow): OfficialPlayerRecord => ({
  found: row.found === 1,
  profile: row.profile ? (JSON.parse(row.profile) as Record<string, unknown>) : null,
  totalFavorite: row.totalFavorite,
  observedAtMs: row.observedAtMs,
});
const PLAYER_COLUMNS = `profile_id AS profileId, found, profile_json AS profile, total_favorite AS totalFavorite,
  observed_at_ms AS observedAtMs`;
/** D1 binds at most 100 values per statement. */
const PLAYER_BATCH = 98;

export async function saveOfficialPlayers(env: OfficialRankingStoreBindings, region: GameRecordsRegion,
  players: ReadonlyArray<{ profileId: string; found: boolean; profile: unknown; totalFavorite: string | null; observedAtMs: number }>): Promise<void> {
  const { db } = storage(env);
  const statement = db.prepare(`INSERT INTO official_player_profiles
    (region, profile_id, found, profile_json, total_favorite, observed_at_ms) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(region, profile_id) DO UPDATE SET found = excluded.found, profile_json = excluded.profile_json,
      total_favorite = COALESCE(excluded.total_favorite, official_player_profiles.total_favorite),
      observed_at_ms = excluded.observed_at_ms
    WHERE excluded.observed_at_ms >= official_player_profiles.observed_at_ms`);
  if (players.length)
    await db.batch(players.map((player) => statement.bind(region, player.profileId, player.found ? 1 : 0,
      player.profile ? JSON.stringify(player.profile) : null, player.totalFavorite, player.observedAtMs)));
}

/** Event boards already carry each player's card, so these cost no extra game request. */
export async function harvestOfficialPlayers(env: OfficialRankingStoreBindings, region: GameRecordsRegion,
  rows: readonly unknown[], observedAtMs: number): Promise<void> {
  const players = rows.flatMap((row) => {
    const profile = (row as { player_data?: Record<string, unknown> } | null)?.player_data;
    const id = profile?.profile_id;
    return typeof id === "string" && /^[1-9][0-9]{0,18}$/u.test(id)
      ? [{ profileId: id, found: true, profile, totalFavorite: null, observedAtMs }]
      : [];
  });
  await saveOfficialPlayers(env, region, players);
}

export async function readOfficialPlayer(env: OfficialRankingStoreBindings, region: GameRecordsRegion,
  profileId: string): Promise<OfficialPlayerRecord | null> {
  const row = await storage(env).db.prepare(`SELECT ${PLAYER_COLUMNS} FROM official_player_profiles WHERE region = ? AND profile_id = ?`)
    .bind(region, profileId).first<OfficialPlayerRow>();
  return row ? playerRecord(row) : null;
}

export async function readOfficialPlayers(env: OfficialRankingStoreBindings, region: GameRecordsRegion,
  profileIds: readonly string[]): Promise<Map<string, OfficialPlayerRecord>> {
  const { db } = storage(env);
  const found = new Map<string, OfficialPlayerRecord>();
  for (let index = 0; index < profileIds.length; index += PLAYER_BATCH) {
    const ids = profileIds.slice(index, index + PLAYER_BATCH);
    const { results } = await db.prepare(`SELECT ${PLAYER_COLUMNS} FROM official_player_profiles
      WHERE region = ? AND profile_id IN (${ids.map(() => "?").join(", ")})`).bind(region, ...ids).all<OfficialPlayerRow>();
    for (const row of results) found.set(row.profileId, playerRecord(row));
  }
  return found;
}

export interface OfficialSongRanking {
  region: GameRecordsRegion;
  musicId: string;
  players: unknown[];
  observedAtMs: number;
}

export async function saveOfficialSongRanking(env: OfficialRankingStoreBindings, ranking: OfficialSongRanking): Promise<void> {
  const { db, bucket } = storage(env);
  const key = `official/1/${ranking.region}/songs/${ranking.musicId}.json`;
  await bucket.put(key, JSON.stringify(ranking), { httpMetadata: { contentType: "application/json" } });
  await db.prepare(`INSERT INTO official_song_rankings (region, music_id, payload_key, observed_at_ms) VALUES (?, ?, ?, ?)
    ON CONFLICT(region, music_id) DO UPDATE SET payload_key = excluded.payload_key, observed_at_ms = excluded.observed_at_ms`)
    .bind(ranking.region, ranking.musicId, key, ranking.observedAtMs).run();
}

export async function readOfficialSongRanking(env: OfficialRankingStoreBindings, region: GameRecordsRegion,
  musicId: string): Promise<OfficialSongRanking | null> {
  const { db, bucket } = storage(env);
  const row = await db.prepare("SELECT payload_key AS payloadKey FROM official_song_rankings WHERE region = ? AND music_id = ?")
    .bind(region, musicId).first<{ payloadKey: string }>();
  const body = row ? await bucket.get(row.payloadKey) : null;
  return body ? ((await body.json()) as OfficialSongRanking) : null;
}
