// L3 — GEB
// Input: Validated official catalogs, observations and region-scoped read identities.
// Output: Immediate durable observations, D1 indexes, latest-event final targets, preserved daily/final archives and reference-safe payload cleanup.
// Pos: [Map](L2.md); official ranking persistence, separate from legacy provider history.
// Effects/Dependencies: Reads and writes private R2 and D1; reads preserve original observation timestamps.
import { saveRankingSearchWindow } from "./ranking-search";
import type { GameRecordsRegion } from "../src/lib/game-records";
import type { OfficialArenaObservation, OfficialArenaPopulationObservation, OfficialArenaProgress, OfficialCatalog, OfficialEventWindow, OfficialObservation } from "../src/lib/official-ranking";

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
const BATCH_PAYLOADS = true;
const GZIP_PAYLOADS = true;
const INLINE_PAYLOAD_BYTES = 256 * 1024;
const BATCH_PAYLOAD_BYTES = 2 * 1024 * 1024;
const BATCH_DELAY_MS = 60_000;
const BATCH_CONTRACT = "haneoka:official-observation-batch/1";
export const OFFICIAL_RANKING_STALE_MS = 1_200_000;

export async function officialDigest(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function storage(env: OfficialRankingStoreBindings): { db: D1Database; bucket: R2Bucket } {
  if (!env.DB || !env.OFFICIAL_RANKING_DATA) throw new Error("official_storage_unavailable");
  return { db: env.DB, bucket: env.OFFICIAL_RANKING_DATA };
}

type PayloadBatchCache = Map<string, Record<string, string>>;

async function payloadText(object: R2ObjectBody): Promise<string> {
  if (object.size > MAX_PAYLOAD_BYTES) throw new Error("official_payload_unavailable");
  const stream = object.httpMetadata?.contentEncoding === "gzip" ? object.body.pipeThrough(new DecompressionStream("gzip")) : object.body;
  const reader = stream.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_PAYLOAD_BYTES) { await reader.cancel(); throw new Error("official_payload_too_large"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}

async function putPayload(bucket: R2Bucket, key: string, body: string): Promise<R2Object> {
  if (GZIP_PAYLOADS) {
    const compressed = await new Response(new Blob([body]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer();
    if (compressed.byteLength < new TextEncoder().encode(body).byteLength) {
      return bucket.put(key, compressed, { httpMetadata: { contentType: "application/json", contentEncoding: "gzip" } });
    }
  }
  return bucket.put(key, body, { httpMetadata: { contentType: "application/json" } });
}

export async function compressOfficialPayload(env: OfficialRankingStoreBindings, key: string, retained?: ReadonlySet<string>): Promise<number> {
  const { bucket } = storage(env);
  const object = await bucket.get(key);
  if (!object) return 0;
  if (object.httpMetadata?.contentEncoding && object.httpMetadata.contentEncoding !== "gzip") return object.size;
  if (retained?.size === 0 || object.httpMetadata?.contentEncoding === "gzip" && !retained) return object.size;
  if (object.size > MAX_PAYLOAD_BYTES) throw new Error("official_payload_too_large");
  let body = await payloadText(object), trimmed = false;
  if (key.startsWith("official/2/")) {
    const batch = JSON.parse(body) as { contract: string; payloads: Record<string, string> };
    if (batch.contract !== BATCH_CONTRACT) throw new Error("official_payload_integrity");
    for (const [hash, value] of Object.entries(batch.payloads))
      if (typeof value !== "string" || await officialDigest(value) !== hash) throw new Error("official_payload_integrity");
    if (retained) {
      if ([...retained].some((hash) => !Object.hasOwn(batch.payloads, hash))) throw new Error("official_payload_reference_missing");
      const compact = JSON.stringify({ ...batch, payloads: Object.fromEntries(Object.entries(batch.payloads).filter(([hash]) => retained.has(hash))) });
      if (new TextEncoder().encode(compact).byteLength <= new TextEncoder().encode(body).byteLength * 0.75) { body = compact; trimmed = true; }
    }
  } else {
    const hash = /\/([a-f0-9]{64})\.json$/u.exec(key)?.[1];
    if (hash && await officialDigest(body) !== hash) throw new Error("official_payload_integrity");
  }
  if (object.httpMetadata?.contentEncoding === "gzip" && !trimmed) return object.size;
  const compressed = await new Response(new Blob([body]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer();
  if (compressed.byteLength >= object.size) return object.size;
  if (object.httpMetadata?.contentEncoding === "gzip" && object.size - compressed.byteLength < 65_536) return object.size;
  const saved = await bucket.put(key, compressed, {
    onlyIf: { etagMatches: object.etag },
    httpMetadata: { ...object.httpMetadata, contentEncoding: "gzip" },
    ...(object.customMetadata ? { customMetadata: object.customMetadata } : {}),
  });
  if (!saved) throw new Error("official_payload_changed");
  return compressed.byteLength;
}

async function readPayload<T>(env: OfficialRankingStoreBindings, key: string, expectedHash: string, batches?: PayloadBatchCache): Promise<T> {
  const { db, bucket } = storage(env);
  const batched = key.startsWith("official/2/");
  let body = batches?.get(key)?.[expectedHash] ?? (batched ? await db.prepare("SELECT body_json FROM official_observation_payloads WHERE payload_key=? AND payload_hash=?")
    .bind(key, expectedHash).first<string>("body_json") : null);
  if (body === null) {
    const object = await bucket.get(key);
    if (!object) throw new Error("official_payload_unavailable");
    body = await payloadText(object);
    if (batched) {
      const batch = JSON.parse(body) as { contract: string; payloads: Record<string, string> };
      if (batch.contract !== BATCH_CONTRACT || typeof batch.payloads?.[expectedHash] !== "string") throw new Error("official_payload_integrity");
      batches?.clear();
      batches?.set(key, batch.payloads);
      body = batch.payloads[expectedHash]!;
    }
  }
  if (await officialDigest(body) !== expectedHash) throw new Error("official_payload_integrity");
  return JSON.parse(body) as T;
}

async function prepareObservationPayload(env: OfficialRankingStoreBindings,
  observation: { region: string; snapshotId: string }, kind: string, body: string, hash: string) {
  const { db, bucket } = storage(env);
  if (!BATCH_PAYLOADS || new TextEncoder().encode(body).byteLength > INLINE_PAYLOAD_BYTES) {
    const key = `official/1/${observation.region}/${kind}/${observation.snapshotId}/${hash}.json`;
    await putPayload(bucket, key, body);
    return { key, statements: [] as D1PreparedStatement[] };
  }
  const bytes = new TextEncoder().encode(JSON.stringify({ [hash]: body })).byteLength;
  const now = Date.now();
  const pending = await db.prepare(`SELECT payload_key FROM official_observation_batches
    WHERE region=? AND created_at_ms>? AND byte_size+?<=? ORDER BY created_at_ms LIMIT 1`)
    .bind(observation.region, now - BATCH_DELAY_MS, bytes, BATCH_PAYLOAD_BYTES).first<{ payload_key: string }>();
  if (!pending) {
    const count = await db.prepare("SELECT COUNT(*) AS count FROM official_observation_batches WHERE region=?")
      .bind(observation.region).first<number>("count");
    if ((count ?? 0) >= 64) throw new Error("official_archive_backlog");
  }
  const key = pending?.payload_key ?? `official/2/${observation.region}/batches/${crypto.randomUUID()}.json`;
  return { key, statements: [
    db.prepare(`INSERT INTO official_observation_batches (payload_key,region,created_at_ms,byte_size)
      VALUES (?,?,?,0) ON CONFLICT(payload_key) DO NOTHING`).bind(key, observation.region, now),
    db.prepare("INSERT INTO official_observation_payloads (payload_key,payload_hash,body_json) VALUES (?,?,?)").bind(key, hash, body),
    db.prepare("UPDATE official_observation_batches SET byte_size=byte_size+? WHERE payload_key=?").bind(bytes, key),
  ] };
}

/** Only mature batches are sealed; writers never append after the one-minute window. */
export async function flushOfficialPayloads(env: OfficialRankingStoreBindings, region: GameRecordsRegion): Promise<number> {
  const { db, bucket } = storage(env);
  const { results } = await db.prepare(`SELECT payload_key FROM official_observation_batches
    WHERE region=? AND created_at_ms<=? ORDER BY created_at_ms LIMIT 8`).bind(region, Date.now() - BATCH_DELAY_MS)
    .all<{ payload_key: string }>();
  for (const { payload_key: key } of results) {
    const { results: payloads } = await db.prepare("SELECT payload_hash,body_json FROM official_observation_payloads WHERE payload_key=?")
      .bind(key).all<{ payload_hash: string; body_json: string }>();
    let saved = await bucket.head(key);
    if (!saved) {
      const body = JSON.stringify({ contract: BATCH_CONTRACT, payloads: Object.fromEntries(payloads.map((row) => [row.payload_hash, row.body_json])) });
      saved = await putPayload(bucket, key, body);
    }
    await db.batch([
      db.prepare(`INSERT INTO official_payload_maintenance (payload_key,region,size_bytes,uploaded_at_ms,compressed_at_ms)
        VALUES (?,?,?,?,?) ON CONFLICT(payload_key) DO NOTHING`)
        .bind(key, region, saved.size, saved.uploaded.getTime(), saved.httpMetadata?.contentEncoding === "gzip" ? Date.now() : null),
      db.prepare("DELETE FROM official_observation_payloads WHERE payload_key=?").bind(key),
      db.prepare("DELETE FROM official_observation_batches WHERE payload_key=?").bind(key),
    ]);
  }
  return results.length;
}

export async function saveOfficialCatalog(env: OfficialRankingStoreBindings, catalog: OfficialCatalog): Promise<void> {
  const { db, bucket } = storage(env);
  const previous = await readOfficialCatalog(env, catalog.region);
  if (previous && catalog.catalogObservedAtMs < previous.catalogObservedAtMs) throw new Error("official_catalog_regressed");
  const eventChanged = JSON.stringify(previous?.event) !== JSON.stringify(catalog.event);
  const arenaChanged = JSON.stringify(previous?.arena) !== JSON.stringify(catalog.arena);
  if (previous && eventChanged) await saveEventFinalTargets(db, previous);
  if (previous && arenaChanged) await saveArenaFinalTargets(db, previous);
  const highest = await db.prepare("SELECT highest_event_id, event_identity, payload_key, payload_hash FROM official_ranking_catalogs WHERE region = ?")
    .bind(catalog.region).first<Pick<ObservationRow, "payload_key" | "payload_hash"> & { highest_event_id: string; event_identity: string }>();
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
  let hash: string, key: string;
  if (previous && highest && JSON.stringify({ ...previous, catalogObservedAtMs: 0 }) === JSON.stringify({ ...catalog, catalogObservedAtMs: 0 })) {
    hash = highest.payload_hash;
    key = highest.payload_key;
  } else {
    hash = await officialDigest(body);
    key = `official/1/${catalog.region}/catalogs/${hash}.json`;
    await putPayload(bucket, key, body);
  }
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
  if (highest && highest.payload_key !== key) await db.prepare(`INSERT INTO official_observation_payload_gc
    (payload_key,region,snapshot_id) VALUES (?,?,?) ON CONFLICT(payload_key) DO NOTHING`)
    .bind(highest.payload_key, catalog.region, highest.payload_hash).run();
  if (eventChanged) await saveEventFinalTargets(db, catalog);
  if (arenaChanged) await saveArenaFinalTargets(db, catalog);
}

async function saveArenaFinalTargets(db: D1Database, catalog: OfficialCatalog): Promise<void> {
  const arena = catalog.arena;
  if (!arena) return;
  const keys = new Set(arena.bandIds.map((band) => `arena/${arena.seasonId}/${band}/1`));
  for (const band of arena.bandIds) if (arena.thresholdsByBand?.[band]?.length) keys.add(`population/${arena.seasonId}/${band}`);
  const { results } = await db.prepare(`SELECT 'arena/' || season_id || '/' || band_id || '/' || start_rank AS board_key
    FROM official_arena_window_metadata WHERE region=? AND season_id=? UNION
    SELECT board_key FROM official_arena_finals WHERE region=? AND season_id=?`)
    .bind(catalog.region, arena.seasonId, catalog.region, arena.seasonId).all<{ board_key: string }>();
  for (const row of results) if (arena.bandIds.includes(row.board_key.split("/")[2]!)) keys.add(row.board_key);
  if (!keys.size) return;
  await db.batch([...keys].map((key) => db.prepare(`INSERT INTO official_arena_finals
    (region,board_key,season_id,due_at_ms,arena_json,catalog_observed_at_ms) VALUES (?,?,?,?,?,?)
    ON CONFLICT(region,board_key) DO UPDATE SET due_at_ms=excluded.due_at_ms,
      arena_json=excluded.arena_json,catalog_observed_at_ms=excluded.catalog_observed_at_ms,
      progress_json=CASE WHEN official_arena_finals.arena_json=excluded.arena_json THEN official_arena_finals.progress_json END,
      snapshot_id=CASE WHEN official_arena_finals.observed_at_ms >= excluded.due_at_ms
        AND official_arena_finals.arena_json=excluded.arena_json THEN official_arena_finals.snapshot_id END,
      observed_at_ms=CASE WHEN official_arena_finals.observed_at_ms >= excluded.due_at_ms
        AND official_arena_finals.arena_json=excluded.arena_json THEN official_arena_finals.observed_at_ms END,
      payload_key=CASE WHEN official_arena_finals.observed_at_ms >= excluded.due_at_ms
        AND official_arena_finals.arena_json=excluded.arena_json THEN official_arena_finals.payload_key END,
      payload_hash=CASE WHEN official_arena_finals.observed_at_ms >= excluded.due_at_ms
        AND official_arena_finals.arena_json=excluded.arena_json THEN official_arena_finals.payload_hash END
    WHERE excluded.catalog_observed_at_ms >= official_arena_finals.catalog_observed_at_ms
      AND (excluded.arena_json != official_arena_finals.arena_json OR excluded.due_at_ms != official_arena_finals.due_at_ms)`)
    .bind(catalog.region, key, arena.seasonId, arena.rankingEndAtMs, JSON.stringify(arena), catalog.catalogObservedAtMs)));
}

export async function saveOfficialFinalArenaProgress(env: OfficialRankingStoreBindings, region: GameRecordsRegion, progress: OfficialArenaProgress): Promise<void> {
  const { db } = storage(env);
  await db.prepare(`UPDATE official_arena_finals SET progress_json=? WHERE region=? AND board_key=? AND snapshot_id IS NULL`)
    .bind(JSON.stringify(progress), region, `population/${progress.seasonId}/${progress.bandId}`).run();
}

async function saveEventFinalTargets(db: D1Database, catalog: OfficialCatalog): Promise<void> {
  const event = catalog.event;
  if (!event) return;
  const boards = event.challenges.filter((row) => row.enabled).map((row) => ({ key: `event/${event.id}/challenge/${row.id}`, end: row.endAtMs }));
  if (event.totalRankingEnabled) boards.push({ key: `event/${event.id}/total/`, end: event.endAtMs });
  if (event.pointRankingEnabled) {
    boards.push({ key: `event/${event.id}/point/`, end: event.endAtMs });
    const { results } = await db.prepare(`SELECT 'event-window/' || event_id || '/' || start_rank AS board_key
      FROM official_event_window_metadata WHERE region=? AND event_id=? UNION
      SELECT board_key FROM official_ranking_finals WHERE region=? AND event_id=? AND board_key LIKE 'event-window/%'`)
      .bind(catalog.region, event.id, catalog.region, event.id).all<{ board_key: string }>();
    for (const row of results) boards.push({ key: row.board_key, end: event.endAtMs });
  }
  if (!boards.length) return;
  await db.batch(boards.map((board) => db.prepare(`INSERT INTO official_ranking_finals
    (region,board_key,event_id,due_at_ms,event_json,catalog_observed_at_ms) VALUES (?,?,?,?,?,?)
    ON CONFLICT(region,board_key) DO UPDATE SET due_at_ms=excluded.due_at_ms,
      event_json=excluded.event_json,catalog_observed_at_ms=excluded.catalog_observed_at_ms,
      snapshot_id=CASE WHEN official_ranking_finals.observed_at_ms >= excluded.due_at_ms THEN official_ranking_finals.snapshot_id END,
      observed_at_ms=CASE WHEN official_ranking_finals.observed_at_ms >= excluded.due_at_ms THEN official_ranking_finals.observed_at_ms END,
      payload_key=CASE WHEN official_ranking_finals.observed_at_ms >= excluded.due_at_ms THEN official_ranking_finals.payload_key END,
      payload_hash=CASE WHEN official_ranking_finals.observed_at_ms >= excluded.due_at_ms THEN official_ranking_finals.payload_hash END
    WHERE excluded.catalog_observed_at_ms >= official_ranking_finals.catalog_observed_at_ms
      AND (excluded.event_json != official_ranking_finals.event_json OR excluded.due_at_ms != official_ranking_finals.due_at_ms)`)
    .bind(catalog.region, board.key, event.id,
      board.end + event.aggregationSeconds * 1000, JSON.stringify(event), catalog.catalogObservedAtMs)));
}

export async function takeOfficialFinalTarget(env: OfficialRankingStoreBindings, region: GameRecordsRegion, now: number) {
  const { db } = storage(env);
  const next = await db.prepare(`SELECT kind,id,definition FROM (
    SELECT 'event' AS kind,event_id AS id,event_json AS definition,last_dispatch_at_ms,due_at_ms FROM official_ranking_finals
    WHERE region=? AND snapshot_id IS NULL AND due_at_ms<=?
      AND event_id=(SELECT highest_event_id FROM official_ranking_catalogs WHERE region=?)
    UNION ALL SELECT 'arena',season_id,arena_json,last_dispatch_at_ms,due_at_ms FROM official_arena_finals
    WHERE region=? AND snapshot_id IS NULL AND due_at_ms<=?
    ) ORDER BY last_dispatch_at_ms,due_at_ms,id,kind LIMIT 1`).bind(region, now, region, region, now)
    .first<{ kind: string; id: string; definition: string }>();
  if (!next) return null;
  if (next.kind === "arena") {
    await db.prepare(`UPDATE official_arena_finals SET last_dispatch_at_ms=?
      WHERE region=? AND season_id=? AND arena_json=? AND snapshot_id IS NULL AND due_at_ms<=?`)
      .bind(now, region, next.id, next.definition, now).run();
    const { results } = await db.prepare(`SELECT board_key,progress_json FROM official_arena_finals
      WHERE region=? AND season_id=? AND arena_json=? AND snapshot_id IS NULL AND due_at_ms<=? ORDER BY last_attempt_at_ms,board_key`)
      .bind(region, next.id, next.definition, now).all<{ board_key: string; progress_json: string | null }>();
    const populations = results.filter((row) => row.board_key.startsWith("population/")).slice(0, 1);
    if (populations.length) await db.prepare(`UPDATE official_arena_finals SET last_attempt_at_ms=? WHERE region=? AND board_key=?`)
      .bind(now, region, populations[0]!.board_key).run();
    return { kind: "arena" as const, arena: JSON.parse(next.definition) as NonNullable<OfficialCatalog["arena"]>,
      windows: results.filter((row) => row.board_key.startsWith("arena/")).slice(0, 20).map(({ board_key }) => {
        const [, seasonId, bandId, rank] = board_key.split("/") as [string, string, string, string];
        const startRank = Number(rank);
        return { seasonId, bandId, startRank, endRank: startRank + 99 };
      }), populationBands: populations.map((row) => row.board_key.split("/")[2]!),
      progress: populations.filter((row) => row.progress_json !== null).map((row) => JSON.parse(row.progress_json!) as OfficialArenaProgress) };
  }
  const { results } = await db.prepare(`SELECT board_key FROM official_ranking_finals
    WHERE region=? AND event_id=? AND event_json=? AND snapshot_id IS NULL AND due_at_ms<=? ORDER BY last_attempt_at_ms,board_key`)
    .bind(region, next.id, next.definition, now).all<{ board_key: string }>();
  await db.prepare(`UPDATE official_ranking_finals SET last_dispatch_at_ms=?,
    last_attempt_at_ms=CASE WHEN board_key LIKE 'event/%' THEN ? ELSE last_attempt_at_ms END
    WHERE region=? AND event_id=? AND event_json=? AND snapshot_id IS NULL AND due_at_ms<=?`)
    .bind(now, now, region, next.id, next.definition, now).run();
  return { kind: "event" as const, event: JSON.parse(next.definition) as NonNullable<OfficialCatalog["event"]>,
    boards: results.filter(({ board_key }) => board_key.startsWith("event/")).map(({ board_key }) => {
      const [, , kind, challengeId] = board_key.split("/") as [string, string, OfficialObservation["kind"], string];
      return { kind, challengeId };
    }), windows: results.filter(({ board_key }) => board_key.startsWith("event-window/")).slice(0, 20).map(({ board_key }) => {
      const startRank = Number(board_key.split("/")[2]);
      return { eventId: next.id, startRank, endRank: startRank + 99 };
    }) };
}

export async function readOfficialCatalog(env: OfficialRankingStoreBindings, region: GameRecordsRegion): Promise<OfficialCatalog | null> {
  const { db } = storage(env);
  const row = await db.prepare("SELECT payload_key, payload_hash, observed_at_ms FROM official_ranking_catalogs WHERE region = ?")
    .bind(region).first<Pick<ObservationRow, "payload_key" | "payload_hash"> & { observed_at_ms: number }>();
  if (!row) return null;
  const catalog = await readPayload<OfficialCatalog>(env, row.payload_key, row.payload_hash);
  if (catalog.region !== region) throw new Error("official_region_mismatch");
  return { ...catalog, catalogObservedAtMs: row.observed_at_ms };
}

async function saveDailyObservation(db: D1Database, board: string,
  observation: { region: string; snapshotId: string; observedAtMs: number }, key: string, hash: string): Promise<void> {
  await db.prepare(`INSERT INTO official_ranking_daily
    (region, board_key, day, observed_at_ms, snapshot_id, payload_key, payload_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(region, board_key, day) DO UPDATE SET
    observed_at_ms=excluded.observed_at_ms, snapshot_id=excluded.snapshot_id,
    payload_key=excluded.payload_key, payload_hash=excluded.payload_hash
    WHERE excluded.observed_at_ms >= official_ranking_daily.observed_at_ms`)
    .bind(observation.region, board, Math.floor((observation.observedAtMs + JST_MS) / 86_400_000),
      observation.observedAtMs, observation.snapshotId, key, hash).run();
  const finals = board.startsWith("arena/") || board.startsWith("population/") ? "official_arena_finals" : "official_ranking_finals";
  await db.prepare(`UPDATE ${finals} SET snapshot_id=?,observed_at_ms=?,payload_key=?,payload_hash=?
    WHERE region=? AND board_key=? AND snapshot_id IS NULL AND due_at_ms<=?`)
    .bind(observation.snapshotId, observation.observedAtMs, key, hash, observation.region, board, observation.observedAtMs).run();
}

export async function readOfficialDailyArchives(env: OfficialRankingStoreBindings, region: GameRecordsRegion, day: number) {
  const { db } = storage(env);
  const { results } = await db.prepare(`SELECT board_key AS boardKey, snapshot_id AS snapshotId,
    observed_at_ms AS observedAtMs, payload_hash AS payloadHash FROM official_ranking_daily
    WHERE region = ? AND day = ? ORDER BY board_key`)
    .bind(region, day).all<{ boardKey: string; snapshotId: string; observedAtMs: number; payloadHash: string }>();
  return results;
}

export async function readOfficialFinalArchives(env: OfficialRankingStoreBindings, region: GameRecordsRegion,
  selection?: { kind: "event" | "arena"; id: string }) {
  const { db } = storage(env);
  const { results: targets } = await db.prepare(`SELECT 'event' AS kind,event_id AS id,MAX(due_at_ms) AS dueAtMs,
    COUNT(*) AS total,SUM(snapshot_id IS NOT NULL) AS completed FROM official_ranking_finals WHERE region=? GROUP BY event_id
    UNION ALL SELECT 'arena',season_id,MAX(due_at_ms),COUNT(*),SUM(snapshot_id IS NOT NULL)
    FROM official_arena_finals WHERE region=? GROUP BY season_id ORDER BY dueAtMs DESC,kind,id`)
    .bind(region, region).all<{ kind: "event" | "arena"; id: string; dueAtMs: number; total: number; completed: number }>();
  const target = selection ? targets.find((row) => row.kind === selection.kind && row.id === selection.id) : targets[0];
  if (!target) return selection ? null : { targets, selected: null, snapshots: [] };
  const table = target.kind === "event" ? "official_ranking_finals" : "official_arena_finals";
  const column = target.kind === "event" ? "event_id" : "season_id";
  const { results: snapshots } = await db.prepare(`SELECT board_key AS boardKey,due_at_ms AS dueAtMs,
    snapshot_id AS snapshotId,observed_at_ms AS observedAtMs,payload_hash AS payloadHash,
    CASE WHEN snapshot_id IS NOT NULL THEN 'archived' WHEN due_at_ms<=? THEN 'pending' ELSE 'waiting' END AS state
    FROM ${table} WHERE region=? AND ${column}=? ORDER BY due_at_ms,board_key`)
    .bind(Date.now(), region, target.id).all<{
      boardKey: string; dueAtMs: number; snapshotId: string | null; observedAtMs: number | null; payloadHash: string | null;
      state: "archived" | "pending" | "waiting";
    }>();
  return { targets, selected: { kind: target.kind, id: target.id }, snapshots };
}

export async function saveOfficialObservation(env: OfficialRankingStoreBindings, observation: OfficialObservation): Promise<void> {
  const { db } = storage(env);
  const body = JSON.stringify(observation);
  if (new TextEncoder().encode(body).byteLength > MAX_PAYLOAD_BYTES) throw new Error("official_observation_too_large");
  const hash = await officialDigest(body);
  const previous = await db.prepare("SELECT payload_key,payload_hash FROM official_ranking_observations WHERE region = ? AND snapshot_id = ?")
    .bind(observation.region, observation.snapshotId).first<Pick<ObservationRow, "payload_key" | "payload_hash">>();
  if (previous) {
    if (previous.payload_hash !== hash) throw new Error("official_observation_conflict");
    if (!observation.error) await saveDailyObservation(db, `event/${observation.eventId}/${observation.kind}/${observation.challengeId}`, observation, previous.payload_key, hash);
    return;
  }
  const payload = await prepareObservationPayload(env, observation, "observations", body, hash);
  const key = payload.key;
  await db.batch([
    ...payload.statements,
    db.prepare(`INSERT INTO official_ranking_observations
      (region, snapshot_id, event_id, board_kind, challenge_id, observed_at_ms, payload_key, payload_hash, error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(region, snapshot_id) DO NOTHING`)
      .bind(observation.region, observation.snapshotId, observation.eventId, ...boardKey(observation.kind, observation.challengeId),
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
  if (!observation.error) await saveDailyObservation(db,
    `event/${observation.eventId}/${observation.kind}/${observation.challengeId}`, observation, key, hash);
}

// The board tables predate point boards; their CHECK keeps kinds to challenge and total.
const POINT_BOARD = "point";
const boardKey = (kind: OfficialObservation["kind"], challengeId: string): [string, string] =>
  kind === "point" ? ["challenge", POINT_BOARD] : [kind, challengeId];

async function observationPayload(env: OfficialRankingStoreBindings, row: ObservationRow, region: GameRecordsRegion, eventId: string,
  kind: OfficialObservation["kind"], challengeId: string, batches?: PayloadBatchCache): Promise<StoredOfficialObservation> {
  const observation = await readPayload<OfficialObservation>(env, row.payload_key, row.payload_hash, batches);
  if (observation.region !== region || observation.eventId !== eventId || observation.kind !== kind || observation.challengeId !== challengeId) {
    throw new Error("official_observation_identity_mismatch");
  }
  return { ...observation, cursor: row.cursor, payloadHash: row.payload_hash };
}

export async function readOfficialLatest(env: OfficialRankingStoreBindings, region: GameRecordsRegion, eventId: string,
  kind: OfficialObservation["kind"], challengeId: string): Promise<StoredOfficialObservation | null> {
  const { db } = storage(env);
  const row = await db.prepare(`SELECT cursor, payload_key, payload_hash FROM official_ranking_observations
    WHERE region = ? AND event_id = ? AND board_kind = ? AND challenge_id = ? AND error IS NULL
    ORDER BY observed_at_ms DESC, cursor DESC LIMIT 1`).bind(region, eventId, ...boardKey(kind, challengeId)).first<ObservationRow>();
  return row ? observationPayload(env, row, region, eventId, kind, challengeId) : null;
}

export async function readOfficialHistory(env: OfficialRankingStoreBindings, region: GameRecordsRegion, eventId: string,
  kind: OfficialObservation["kind"], challengeId: string, after: number): Promise<{ observations: StoredOfficialObservation[]; nextCursor: number }> {
  const { db } = storage(env);
  const { results } = await db.prepare(`SELECT cursor, payload_key, payload_hash FROM official_ranking_observations
    WHERE region = ? AND event_id = ? AND board_kind = ? AND challenge_id = ? AND cursor > ?
    ORDER BY cursor LIMIT 100`).bind(region, eventId, ...boardKey(kind, challengeId), after).all<ObservationRow>();
  const observations: StoredOfficialObservation[] = [];
  const batches: PayloadBatchCache = new Map();
  let bytes = 0;
  for (const row of results) {
    const observation = await observationPayload(env, row, region, eventId, kind, challengeId, batches);
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
    const point = row.challenge_id === POINT_BOARD;
    boards.push({ kind: point ? "point" : row.board_kind, challengeId: point ? "" : row.challenge_id, lastAttemptAtMs: row.last_attempt_ms,
      lastSuccessfulObservationAtMs: row.last_success_ms, consecutiveFailures: row.consecutive_failures,
      ageMs: age, stale: age === null || age < 0 || age > OFFICIAL_RANKING_STALE_MS,
      openGapMs: age === null ? null : Math.max(0, age - 300_000) });
  }
  return boards;
}

export async function saveOfficialArenaObservation(env: OfficialRankingStoreBindings, observation: OfficialArenaObservation): Promise<void> {
  const { db } = storage(env);
  const body = JSON.stringify(observation);
  if (new TextEncoder().encode(body).byteLength > MAX_PAYLOAD_BYTES) throw new Error("official_observation_too_large");
  const hash = await officialDigest(body);
  const previous = await db.prepare("SELECT payload_key,payload_hash FROM official_arena_ranking_observations WHERE region = ? AND snapshot_id = ?")
    .bind(observation.region, observation.snapshotId).first<Pick<ObservationRow, "payload_key" | "payload_hash">>();
  if (previous) {
    if (previous.payload_hash !== hash) throw new Error("official_observation_conflict");
  }
  await db.prepare(`INSERT INTO official_arena_finals
    (region,board_key,season_id,due_at_ms,arena_json,catalog_observed_at_ms,last_attempt_at_ms)
    SELECT region,?,season_id,due_at_ms,arena_json,catalog_observed_at_ms,? FROM official_arena_finals
    WHERE region=? AND board_key=? ON CONFLICT(region,board_key) DO UPDATE SET
      last_attempt_at_ms=MAX(official_arena_finals.last_attempt_at_ms,excluded.last_attempt_at_ms)`)
    .bind(`arena/${observation.seasonId}/${observation.bandId}/${observation.startRank}`, observation.observedAtMs,
      observation.region, `arena/${observation.seasonId}/${observation.bandId}/1`).run();
  const payload = previous ? { key: previous.payload_key, statements: [] } : await prepareObservationPayload(env, observation, "arena", body, hash);
  const key = payload.key;
  if (!previous) {
    await db.batch([...payload.statements, db.prepare(`INSERT INTO official_arena_ranking_observations
    (region, snapshot_id, season_id, band_id, start_rank, end_rank, max_rank, observed_at_ms, payload_key, payload_hash, error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(region, snapshot_id) DO NOTHING`)
    .bind(observation.region, observation.snapshotId, observation.seasonId, observation.bandId, observation.startRank,
      observation.endRank, observation.maxRank ?? null, observation.observedAtMs, key, hash, observation.error ?? null)]);
  }
  if (!observation.error && observation.players) {
    const profiles: Record<string, number> = {};
    observation.players.forEach((player, index) => {
      const profile = player.profile as Record<string, unknown> | undefined;
      const id = profile?.profile_id ?? profile?.profileId;
      if (typeof id === "string" && /^[1-9][0-9]{0,18}$/u.test(id)) profiles[id] = observation.startRank + index;
    });
    const replaced = await db.prepare(`SELECT snapshot_id, payload_key, observed_at_ms FROM official_arena_window_metadata
      WHERE region = ? AND season_id = ? AND band_id = ? AND start_rank = ?`)
      .bind(observation.region, observation.seasonId, observation.bandId, observation.startRank).first<ReplacedWindow>();
    await db.prepare(`INSERT INTO official_arena_window_metadata
      (region, season_id, band_id, start_rank, end_rank, max_rank, player_count, profile_index, snapshot_id, observed_at_ms, payload_key, payload_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(region, season_id, band_id, start_rank) DO UPDATE SET
      end_rank=excluded.end_rank, max_rank=excluded.max_rank, player_count=excluded.player_count, profile_index=excluded.profile_index,
      snapshot_id=excluded.snapshot_id, observed_at_ms=excluded.observed_at_ms, payload_key=excluded.payload_key, payload_hash=excluded.payload_hash
      WHERE excluded.observed_at_ms >= official_arena_window_metadata.observed_at_ms`)
      .bind(observation.region, observation.seasonId, observation.bandId, observation.startRank, observation.endRank,
        observation.maxRank ?? null, observation.players.length, JSON.stringify(profiles), observation.snapshotId,
        observation.observedAtMs, key, hash).run();
    await saveRankingSearchWindow(db, observation.region, `arena/${observation.seasonId}/${observation.bandId}`, observation, observation.players);
    await saveDailyObservation(db, `arena/${observation.seasonId}/${observation.bandId}/${observation.startRank}`, observation, key, hash);
    if (replaced) await dropReplaced(env, "official_arena_ranking_observations", observation, replaced);
  }
}

interface ReplacedWindow { snapshot_id: string; payload_key: string; observed_at_ms: number }

/** Daily archives retain their payloads when the live window advances. */
async function dropReplaced(env: OfficialRankingStoreBindings, table: string,
  observation: { region: string; snapshotId: string; observedAtMs: number }, replaced: ReplacedWindow) {
  if (replaced.snapshot_id === observation.snapshotId || replaced.observed_at_ms > observation.observedAtMs) return;
  const { db } = storage(env);
  await db.prepare(`DELETE FROM ${table} WHERE region = ? AND snapshot_id = ?
    AND NOT EXISTS (SELECT 1 FROM official_ranking_daily WHERE region=? AND snapshot_id=?)
    AND NOT EXISTS (SELECT 1 FROM official_ranking_finals WHERE region=? AND snapshot_id=?)
    AND NOT EXISTS (SELECT 1 FROM official_arena_finals WHERE region=? AND snapshot_id=?)`)
    .bind(observation.region, replaced.snapshot_id, observation.region, replaced.snapshot_id,
      observation.region, replaced.snapshot_id, observation.region, replaced.snapshot_id).run();
}

export async function saveOfficialEventWindow(env: OfficialRankingStoreBindings, observation: OfficialEventWindow): Promise<void> {
  const { db } = storage(env);
  const body = JSON.stringify(observation);
  if (new TextEncoder().encode(body).byteLength > MAX_PAYLOAD_BYTES) throw new Error("official_observation_too_large");
  const hash = await officialDigest(body);
  const previous = await db.prepare("SELECT payload_key,payload_hash FROM official_event_window_observations WHERE region = ? AND snapshot_id = ?")
    .bind(observation.region, observation.snapshotId).first<Pick<ObservationRow, "payload_key" | "payload_hash">>();
  if (previous && previous.payload_hash !== hash) throw new Error("official_observation_conflict");
  await db.prepare(`INSERT INTO official_ranking_finals
    (region,board_key,event_id,due_at_ms,event_json,catalog_observed_at_ms,last_attempt_at_ms)
    SELECT region,?,event_id,due_at_ms,event_json,catalog_observed_at_ms,? FROM official_ranking_finals
    WHERE region=? AND board_key=? ON CONFLICT(region,board_key) DO UPDATE SET
      last_attempt_at_ms=MAX(official_ranking_finals.last_attempt_at_ms,excluded.last_attempt_at_ms)`)
    .bind(`event-window/${observation.eventId}/${observation.startRank}`, observation.observedAtMs,
      observation.region, `event/${observation.eventId}/point/`).run();
  const payload = previous ? { key: previous.payload_key, statements: [] } : await prepareObservationPayload(env, observation, "event-window", body, hash);
  const key = payload.key;
  if (!previous) {
    await db.batch([...payload.statements, db.prepare(`INSERT INTO official_event_window_observations
      (region, snapshot_id, event_id, start_rank, end_rank, max_rank, observed_at_ms, payload_key, payload_hash, error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(region, snapshot_id) DO NOTHING`)
      .bind(observation.region, observation.snapshotId, observation.eventId, observation.startRank, observation.endRank,
        observation.maxRank ?? null, observation.observedAtMs, key, hash, observation.error ?? null)]);
  }
  if (observation.error || !observation.players) return;
  const profiles: Record<string, number> = {};
  observation.players.forEach((player, index) => {
    const profile = player.profile as Record<string, unknown> | undefined;
    const id = profile?.profile_id ?? profile?.profileId;
    if (typeof id === "string" && /^[1-9][0-9]{0,18}$/u.test(id)) profiles[id] = observation.startRank + index;
  });
  const replaced = await db.prepare(`SELECT snapshot_id, payload_key, observed_at_ms FROM official_event_window_metadata
    WHERE region = ? AND event_id = ? AND start_rank = ?`)
    .bind(observation.region, observation.eventId, observation.startRank).first<ReplacedWindow>();
  await db.prepare(`INSERT INTO official_event_window_metadata
    (region, event_id, start_rank, end_rank, max_rank, player_count, profile_index, snapshot_id, observed_at_ms, payload_key, payload_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(region, event_id, start_rank) DO UPDATE SET
    end_rank=excluded.end_rank, max_rank=excluded.max_rank, player_count=excluded.player_count, profile_index=excluded.profile_index,
    snapshot_id=excluded.snapshot_id, observed_at_ms=excluded.observed_at_ms, payload_key=excluded.payload_key, payload_hash=excluded.payload_hash
    WHERE excluded.observed_at_ms >= official_event_window_metadata.observed_at_ms`)
    .bind(observation.region, observation.eventId, observation.startRank, observation.endRank, observation.maxRank ?? null,
      observation.players.length, JSON.stringify(profiles), observation.snapshotId, observation.observedAtMs, key, hash).run();
  await saveRankingSearchWindow(db, observation.region, `event/${observation.eventId}`, observation, observation.players);
  await saveDailyObservation(db, `event-window/${observation.eventId}/${observation.startRank}`, observation, key, hash);
  if (replaced) await dropReplaced(env, "official_event_window_observations", observation, replaced);
}

export interface OfficialEventWindowMetadata {
  startRank: number;
  snapshotId: string;
  observedAtMs: number;
  payloadKey: string;
  payloadHash: string;
}

export async function readOfficialEventWindows(env: OfficialRankingStoreBindings, region: GameRecordsRegion, eventId: string,
  depth: number): Promise<OfficialEventWindowMetadata[]> {
  const { db } = storage(env);
  const { results } = await db.prepare(`SELECT start_rank AS startRank, snapshot_id AS snapshotId,
    observed_at_ms AS observedAtMs, payload_key AS payloadKey, payload_hash AS payloadHash FROM official_event_window_metadata
    WHERE region = ? AND event_id = ? AND start_rank BETWEEN 1 AND ? ORDER BY start_rank`)
    .bind(region, eventId, depth).all<OfficialEventWindowMetadata>();
  return results;
}

/** The latest window of an event's point board starting at `start`. */
export async function readOfficialEventWindow(env: OfficialRankingStoreBindings, region: GameRecordsRegion, eventId: string,
  start: number): Promise<OfficialEventWindow | null> {
  const { db } = storage(env);
  const row = await db.prepare(`SELECT payload_key, payload_hash FROM official_event_window_metadata
    WHERE region = ? AND event_id = ? AND start_rank = ?`).bind(region, eventId, start).first<{ payload_key: string; payload_hash: string }>();
  if (!row) return null;
  const observation = await readPayload<OfficialEventWindow>(env, row.payload_key, row.payload_hash);
  if (observation.region !== region || observation.eventId !== eventId) throw new Error("official_observation_identity_mismatch");
  return observation;
}

/** The last rank an event's point board is known to reach, or null while its end is unseen. */
export async function readOfficialEventMaxRank(env: OfficialRankingStoreBindings, region: GameRecordsRegion, eventId: string): Promise<number | null> {
  const { db } = storage(env);
  const row = await db.prepare(`SELECT MIN(max_rank) AS maxRank, MAX(CASE WHEN max_rank IS NULL THEN end_rank END) AS fullEnd
    FROM official_event_window_metadata WHERE region = ? AND event_id = ?`).bind(region, eventId)
    .first<{ maxRank: number | null; fullEnd: number | null }>();
  // A full window past the recorded end means the board has grown since.
  return row?.maxRank != null && (row.fullEnd === null || row.maxRank >= row.fullEnd) ? row.maxRank : null;
}

export async function readOfficialPayload<T>(env: OfficialRankingStoreBindings, key: string, hash: string, batches?: PayloadBatchCache): Promise<T> {
  return readPayload<T>(env, key, hash, batches);
}

export interface OfficialArenaWindowMetadata {
  startRank: number;
  endRank: number;
  maxRank: number | null;
  playerCount: number;
  snapshotId: string;
  observedAtMs: number;
  payloadKey: string;
  payloadHash: string;
}

export async function readOfficialArenaSearchWindows(env: OfficialRankingStoreBindings, region: GameRecordsRegion,
  seasonId: string, bandId: string, depth: number): Promise<OfficialArenaWindowMetadata[]> {
  const { db } = storage(env);
  const { results } = await db.prepare(`SELECT start_rank AS startRank, end_rank AS endRank, max_rank AS maxRank,
    player_count AS playerCount, snapshot_id AS snapshotId, observed_at_ms AS observedAtMs,
    payload_key AS payloadKey, payload_hash AS payloadHash FROM official_arena_window_metadata
    WHERE region = ? AND season_id = ? AND band_id = ? AND start_rank BETWEEN 1 AND ? ORDER BY start_rank`)
    .bind(region, seasonId, bandId, depth).all<OfficialArenaWindowMetadata>();
  return results;
}

export async function readOfficialArenaSearchMatch(env: OfficialRankingStoreBindings,
  metadata: OfficialArenaWindowMetadata, batches?: PayloadBatchCache): Promise<OfficialArenaObservation> {
  return readPayload<OfficialArenaObservation>(env, metadata.payloadKey, metadata.payloadHash, batches);
}

/** The latest successful aligned window of a league board that contains `rank`. */
export async function readOfficialArenaLatest(env: OfficialRankingStoreBindings, region: GameRecordsRegion, seasonId: string,
  bandId: string, rank: number): Promise<(OfficialArenaObservation & { cursor: number }) | null> {
  const { db } = storage(env);
  const row = await db.prepare(`SELECT cursor, payload_key, payload_hash FROM official_arena_ranking_observations
    WHERE region = ? AND season_id = ? AND band_id = ? AND start_rank = ? AND end_rank >= ? AND error IS NULL
    ORDER BY observed_at_ms DESC, cursor DESC LIMIT 1`).bind(region, seasonId, bandId, Math.floor((rank - 1) / 100) * 100 + 1, rank).first<ObservationRow>();
  if (!row) return null;
  const observation = await readPayload<OfficialArenaObservation>(env, row.payload_key, row.payload_hash);
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
  const { db } = storage(env);
  const body = JSON.stringify(observation);
  if (new TextEncoder().encode(body).byteLength > MAX_PAYLOAD_BYTES) throw new Error("official_observation_too_large");
  const hash = await officialDigest(body);
  const previous = await db.prepare("SELECT payload_key,payload_hash FROM official_arena_population_observations WHERE region = ? AND snapshot_id = ?")
    .bind(observation.region, observation.snapshotId).first<Pick<ObservationRow, "payload_key" | "payload_hash">>();
  if (previous) {
    if (previous.payload_hash !== hash) throw new Error("official_observation_conflict");
    await saveDailyObservation(db, `population/${observation.seasonId}/${observation.bandId}`, observation, previous.payload_key, hash);
    return;
  }
  const payload = await prepareObservationPayload(env, observation, "arena-population", body, hash);
  const key = payload.key;
  await db.batch([...payload.statements, db.prepare(`INSERT INTO official_arena_population_observations
    (region, snapshot_id, season_id, band_id, max_rank, observed_at_ms, payload_key, payload_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(region, snapshot_id) DO NOTHING`)
    .bind(observation.region, observation.snapshotId, observation.seasonId, observation.bandId, observation.maxRank,
      observation.observedAtMs, key, hash)]);
  await saveDailyObservation(db, `population/${observation.seasonId}/${observation.bandId}`, observation, key, hash);
}

export async function readOfficialArenaPopulation(env: OfficialRankingStoreBindings, region: GameRecordsRegion,
  seasonId: string, bandId: string): Promise<OfficialArenaPopulationObservation | null> {
  const { db } = storage(env);
  const row = await db.prepare(`SELECT cursor, payload_key, payload_hash FROM official_arena_population_observations
    WHERE region = ? AND season_id = ? AND band_id = ? ORDER BY observed_at_ms DESC, cursor DESC LIMIT 1`)
    .bind(region, seasonId, bandId).first<ObservationRow>();
  if (!row) return null;
  const observation = await readPayload<OfficialArenaPopulationObservation>(env, row.payload_key, row.payload_hash);
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
  players: ReadonlyArray<{ profileId: string; found: boolean; profile: unknown; totalFavorite: string | null; observedAtMs: number }>,
  minimumObservationMs = 0): Promise<void> {
  const { db } = storage(env);
  const statement = db.prepare(`INSERT INTO official_player_profiles
    (region, profile_id, found, profile_json, total_favorite, observed_at_ms) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(region, profile_id) DO UPDATE SET found = excluded.found, profile_json = excluded.profile_json,
      total_favorite = COALESCE(excluded.total_favorite, official_player_profiles.total_favorite),
      observed_at_ms = excluded.observed_at_ms
    WHERE excluded.observed_at_ms >= official_player_profiles.observed_at_ms
      AND (excluded.observed_at_ms-official_player_profiles.observed_at_ms >= ?
        OR excluded.found IS NOT official_player_profiles.found OR excluded.profile_json IS NOT official_player_profiles.profile_json
        OR excluded.total_favorite IS NOT NULL AND excluded.total_favorite IS NOT official_player_profiles.total_favorite)`);
  if (players.length)
    await db.batch(players.map((player) => statement.bind(region, player.profileId, player.found ? 1 : 0,
      player.profile ? JSON.stringify(player.profile) : null, player.totalFavorite, player.observedAtMs, minimumObservationMs)));
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
  await saveOfficialPlayers(env, region, players, 150_000);
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
  await putPayload(bucket, key, JSON.stringify(ranking));
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
  return body ? JSON.parse(await payloadText(body)) as OfficialSongRanking : null;
}

const cardImageKey = (region: GameRecordsRegion, file: string) => `official/1/${region}/cards/${file}`;

/** Card files are named by content, so a stored copy never changes. */
export async function saveOfficialCardImage(env: OfficialRankingStoreBindings, region: GameRecordsRegion, file: string, body: Uint8Array): Promise<void> {
  await storage(env).bucket.put(cardImageKey(region, file), body, { httpMetadata: { contentType: "image/png" } });
}

export const readOfficialCardImage = (env: OfficialRankingStoreBindings, region: GameRecordsRegion, file: string) =>
  storage(env).bucket.get(cardImageKey(region, file));

/** JP card artwork needs the game's CDN credential, so readers use our stored copy; other regions' CDNs are public. */
export function officialCardUrl(region: GameRecordsRegion, source: string): string {
  if (region !== "jp") return source;
  const file = /^https:\/\/static\.bang-dream-on\.jp\/operation\/profilecard\/[0-9]+\/([A-Za-z0-9_.-]+)$/u.exec(source)?.[1];
  return file ? `/api/v1/game/records/jp/cards/${file}` : source;
}

/** Raw observations stay whole for this long; older ones are thinned by {@link pruneOfficialObservations}. */
export const OFFICIAL_KEEP_ALL_MS = 12 * 3_600_000;
const JST_MS = 9 * 3_600_000;
const PAYLOAD_DELETE_GRACE_MS = 300_000;

function archiveObservationUnreferenced(alias: "o"): string {
  return `NOT EXISTS (SELECT 1 FROM official_ranking_daily WHERE region=${alias}.region AND snapshot_id=${alias}.snapshot_id)
    AND NOT EXISTS (SELECT 1 FROM official_ranking_finals WHERE region=${alias}.region AND snapshot_id=${alias}.snapshot_id)
    AND NOT EXISTS (SELECT 1 FROM official_arena_finals WHERE region=${alias}.region AND snapshot_id=${alias}.snapshot_id)
    AND NOT EXISTS (SELECT 1 FROM official_arena_window_metadata WHERE region=${alias}.region AND snapshot_id=${alias}.snapshot_id)
    AND NOT EXISTS (SELECT 1 FROM official_event_window_metadata WHERE region=${alias}.region AND snapshot_id=${alias}.snapshot_id)`;
}

async function deleteRetiredPayloads(env: OfficialRankingStoreBindings, region: GameRecordsRegion, limit: number): Promise<void> {
  const { db, bucket } = storage(env);
  const { results } = await db.prepare(`SELECT g.payload_key,m.size_bytes FROM official_observation_payload_gc AS g
    LEFT JOIN official_payload_maintenance AS m ON m.payload_key=g.payload_key
    WHERE g.region=? AND queued_at_ms<=?
    AND NOT EXISTS (SELECT 1 FROM official_ranking_catalogs WHERE payload_key=g.payload_key)
    AND NOT EXISTS (SELECT 1 FROM official_song_rankings WHERE payload_key=g.payload_key)
    AND NOT EXISTS (SELECT 1 FROM official_ranking_daily WHERE payload_key=g.payload_key)
    AND NOT EXISTS (SELECT 1 FROM official_ranking_finals WHERE payload_key=g.payload_key)
    AND NOT EXISTS (SELECT 1 FROM official_arena_finals WHERE payload_key=g.payload_key)
    AND NOT EXISTS (SELECT 1 FROM official_ranking_observations WHERE payload_key=g.payload_key)
    AND NOT EXISTS (SELECT 1 FROM official_arena_ranking_observations WHERE payload_key=g.payload_key)
    AND NOT EXISTS (SELECT 1 FROM official_event_window_observations WHERE payload_key=g.payload_key)
    AND NOT EXISTS (SELECT 1 FROM official_arena_population_observations WHERE payload_key=g.payload_key)
    AND NOT EXISTS (SELECT 1 FROM official_arena_window_metadata WHERE payload_key=g.payload_key)
    AND NOT EXISTS (SELECT 1 FROM official_event_window_metadata WHERE payload_key=g.payload_key)
    AND NOT EXISTS (SELECT 1 FROM official_observation_batches WHERE payload_key=g.payload_key)
    ORDER BY queued_at_ms,g.payload_key LIMIT ?`).bind(region, Date.now() - PAYLOAD_DELETE_GRACE_MS, limit).all<{ payload_key: string; size_bytes: number | null }>();
  if (!results.length) return;
  await bucket.delete(results.map((row) => row.payload_key));
  const statements: D1PreparedStatement[] = [];
  for (let offset = 0; offset < results.length; offset += 80) {
    const keys = results.slice(offset, offset + 80).map((row) => row.payload_key), placeholders = keys.map(() => "?").join(",");
    statements.push(db.prepare(`DELETE FROM official_observation_payload_gc WHERE payload_key IN (${placeholders})`).bind(...keys),
      db.prepare(`DELETE FROM official_payload_maintenance WHERE payload_key IN (${placeholders})`).bind(...keys));
  }
  statements.push(db.prepare(`UPDATE official_storage_sweeps SET deleted_objects=deleted_objects+?,known_deleted_bytes=known_deleted_bytes+? WHERE region=?`)
    .bind(results.length, results.reduce((sum, row) => sum + (row.size_bytes ?? 0), 0), region));
  await db.batch(statements);
}

/** Thins raw observations older than {@link OFFICIAL_KEEP_ALL_MS}: event boards keep the last successful snapshot and last attempt of each
 * Japan-time day per board; final and daily archive references protect pinned payloads. Arena and event windows also keep their
 * live metadata references; population counts also keep the latest per board. Retires rows atomically into a payload cleanup queue;
 * unreferenced bodies are deleted after a five-minute grace period. Called inside the owning regional collector's serialized queue.
 * Returns the number of retired observation rows. */
export async function pruneOfficialObservations(env: OfficialRankingStoreBindings, region: GameRecordsRegion, limit = 50): Promise<number> {
  const { db } = storage(env);
  const before = Date.now() - OFFICIAL_KEEP_ALL_MS, orphaned = Date.now() - 3_600_000;
  const doomed: { table: string; cursor: number; key: string }[] = [];
  const take = async (table: string, sql: string, ...values: unknown[]) => {
    if (doomed.length >= limit) return;
    const { results } = await db.prepare(sql).bind(...values, limit - doomed.length).all<{ cursor: number; payload_key: string }>();
    for (const row of results) doomed.push({ table, cursor: row.cursor, key: row.payload_key });
  };
  await take("official_ranking_observations", `SELECT o.cursor, o.payload_key FROM official_ranking_observations AS o
    WHERE o.region=? AND o.observed_at_ms < ? AND NOT EXISTS
      (SELECT 1 FROM official_ranking_daily AS d WHERE d.region=o.region AND d.snapshot_id=o.snapshot_id) AND NOT EXISTS
      (SELECT 1 FROM official_ranking_finals AS f WHERE f.region=o.region AND f.snapshot_id=o.snapshot_id) AND EXISTS (SELECT 1 FROM official_ranking_observations AS later
      WHERE later.region = o.region AND later.event_id = o.event_id AND later.board_kind = o.board_kind
        AND later.challenge_id = o.challenge_id AND (later.observed_at_ms, later.cursor) > (o.observed_at_ms, o.cursor)
        AND (o.error IS NOT NULL OR later.error IS NULL)
        AND later.observed_at_ms < (CAST((o.observed_at_ms + ?) / 86400000 AS INTEGER) + 1) * 86400000 - ?)
    ORDER BY o.observed_at_ms LIMIT ?`, region, before, JST_MS, JST_MS);
  await take("official_arena_ranking_observations", `SELECT o.cursor, o.payload_key FROM official_arena_ranking_observations AS o
    WHERE o.region=? AND o.observed_at_ms < ? AND NOT EXISTS
      (SELECT 1 FROM official_ranking_daily AS d WHERE d.region=o.region AND d.snapshot_id=o.snapshot_id) AND NOT EXISTS
      (SELECT 1 FROM official_arena_finals AS f WHERE f.region=o.region AND f.snapshot_id=o.snapshot_id) AND NOT EXISTS (SELECT 1 FROM official_arena_window_metadata AS m
      WHERE m.region = o.region AND m.snapshot_id = o.snapshot_id) ORDER BY o.observed_at_ms LIMIT ?`, region, orphaned);
  await take("official_event_window_observations", `SELECT o.cursor, o.payload_key FROM official_event_window_observations AS o
    WHERE o.region=? AND o.observed_at_ms < ? AND NOT EXISTS
      (SELECT 1 FROM official_ranking_daily AS d WHERE d.region=o.region AND d.snapshot_id=o.snapshot_id) AND NOT EXISTS
      (SELECT 1 FROM official_ranking_finals AS f WHERE f.region=o.region AND f.snapshot_id=o.snapshot_id) AND NOT EXISTS (SELECT 1 FROM official_event_window_metadata AS m
      WHERE m.region = o.region AND m.snapshot_id = o.snapshot_id) ORDER BY o.observed_at_ms LIMIT ?`, region, orphaned);
  await take("official_arena_population_observations", `SELECT o.cursor, o.payload_key FROM official_arena_population_observations AS o
    WHERE o.region=? AND o.observed_at_ms < ? AND NOT EXISTS
      (SELECT 1 FROM official_ranking_daily AS d WHERE d.region=o.region AND d.snapshot_id=o.snapshot_id) AND NOT EXISTS
      (SELECT 1 FROM official_arena_finals AS f WHERE f.region=o.region AND f.snapshot_id=o.snapshot_id) AND EXISTS (SELECT 1 FROM official_arena_population_observations AS later
      WHERE later.region = o.region AND later.season_id = o.season_id AND later.band_id = o.band_id
        AND later.observed_at_ms > o.observed_at_ms) ORDER BY o.observed_at_ms LIMIT ?`, region, before);
  const retired = doomed.length ? await db.batch<{ payload_key: string }>(doomed.map((row) => db.prepare(
    `DELETE FROM ${row.table} AS o WHERE cursor=? AND payload_key=? AND ${archiveObservationUnreferenced("o")} RETURNING payload_key`)
    .bind(row.cursor, row.key))) : [];
  await deleteRetiredPayloads(env, region, Math.max(limit, 500));
  return retired.reduce((count, result) => count + result.results.length, 0);
}
