// L3 — GEB
// Input: Regional official payload inventory, live D1 references and retired-payload checkpoints.
// Output: Quarantined orphan objects, compressed retained snapshots and compacted shared batches.
// Pos: [Map](L2.md); bounded official storage maintenance outside game collection queues.
// Effects/Dependencies: Leased D1 work, R2 inventory and conditional rewrites; retained body hashes stay unchanged.
import type { GameRecordsRegion } from "../src/lib/game-records";
import { compressOfficialPayload, type OfficialRankingStoreBindings } from "./official-ranking-store";

const REFERENCE_TABLES = ["official_ranking_catalogs", "official_ranking_observations", "official_arena_ranking_observations",
  "official_arena_population_observations", "official_event_window_observations", "official_ranking_daily",
  "official_ranking_finals", "official_arena_finals", "official_arena_window_metadata", "official_event_window_metadata",
  "official_observation_batches", "official_song_rankings"] as const;
const HASH_TABLES = REFERENCE_TABLES.filter((table) => !["official_ranking_catalogs", "official_observation_batches", "official_song_rankings"].includes(table));
const GRACE_MS = 300_000;
const DAY_MS = 86_400_000;

interface Sweep {
  format_version: number;
  cursor: string | null;
  next_scan_at_ms: number;
}
interface CompressionJob { payload_key: string; size_bytes: number; uploaded_at_ms: number; queued_at_ms: number | null }

function managedObject(object: R2Object, region: GameRecordsRegion): boolean {
  const [root, version, owner, kind, ...path] = object.key.split("/");
  if (root !== "official" || owner !== region) return false;
  if (version === "1" && kind === "catalogs") return path.length === 1 && /^[a-f0-9]{64}\.json$/u.test(path[0]!);
  if (version === "1" && ["observations", "arena", "arena-population", "event-window"].includes(kind!))
    return path.length === 2 && /^[a-f0-9]{32}$/u.test(path[0]!) && /^[a-f0-9]{64}\.json$/u.test(path[1]!);
  return version === "2" && kind === "batches" && path.length === 1
    && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.json$/u.test(path[0]!);
}

async function referencedKeys(db: D1Database, keys: string[]): Promise<Set<string>> {
  const statements: D1PreparedStatement[] = [];
  for (let offset = 0; offset < keys.length; offset += 80) {
    const chunk = keys.slice(offset, offset + 80), parameters = chunk.map(() => "?").join(",");
    for (const table of REFERENCE_TABLES)
      statements.push(db.prepare(`SELECT DISTINCT payload_key FROM ${table} WHERE payload_key IN (${parameters})`).bind(...chunk));
  }
  if (!statements.length) return new Set();
  const rows = await db.batch<{ payload_key: string }>(statements);
  return new Set(rows.flatMap((result) => result.results.map((row) => row.payload_key)));
}

async function sweepPage(env: OfficialRankingStoreBindings, region: GameRecordsRegion, lease: string, state: Sweep): Promise<void> {
  const db = env.DB!, now = Date.now();
  if (state.next_scan_at_ms > now) return;
  const page = await env.OFFICIAL_RANKING_DATA!.list({ prefix: `official/${state.format_version}/${region}/`, limit: 500,
    include: ["httpMetadata"], ...(state.cursor ? { cursor: state.cursor } : {}) });
  const eligible = page.objects.filter((object) => managedObject(object, region) && now - object.uploaded.getTime() > 3_600_000);
  const references = await referencedKeys(db, eligible.map((object) => object.key));
  const statements: D1PreparedStatement[] = [];
  let orphans = 0;
  for (const object of eligible) {
    const orphan = !references.has(object.key) && now - object.uploaded.getTime() > DAY_MS;
    const encoding = object.httpMetadata?.contentEncoding;
    if (!orphan && (!references.has(object.key) || encoding && !(object.key.startsWith("official/2/") && encoding === "gzip"))) continue;
    statements.push(db.prepare(`INSERT INTO official_payload_maintenance
      (payload_key,region,size_bytes,uploaded_at_ms,orphan_at_ms,compressed_at_ms) VALUES (?,?,?,?,?,?)
      ON CONFLICT(payload_key) DO UPDATE SET orphan_at_ms=COALESCE(official_payload_maintenance.orphan_at_ms,excluded.orphan_at_ms),
        size_bytes=excluded.size_bytes WHERE excluded.orphan_at_ms IS NOT NULL`)
      .bind(object.key, region, object.size, object.uploaded.getTime(), orphan ? now : null, encoding === "gzip" ? now : null));
    if (orphan) {
      orphans++;
      statements.push(db.prepare(`INSERT INTO official_observation_payload_gc (payload_key,region,snapshot_id)
        VALUES (?,?,'orphan') ON CONFLICT(payload_key) DO NOTHING`).bind(object.key, region));
    }
  }
  const complete = !page.truncated && state.format_version === 1;
  statements.push(db.prepare(`UPDATE official_storage_sweeps SET cursor=?,format_version=?,next_scan_at_ms=?,
    last_completed_at_ms=CASE WHEN ? THEN ? ELSE last_completed_at_ms END,
    scanned_objects=scanned_objects+?,orphan_candidates=orphan_candidates+? WHERE region=? AND lease_id=?`)
    .bind(page.truncated ? page.cursor : null, page.truncated ? state.format_version : state.format_version === 1 ? 2 : 1,
      complete ? now + DAY_MS : now, Number(complete), now, page.objects.length, orphans, region, lease));
  await db.batch(statements);
}

async function compressDue(env: OfficialRankingStoreBindings, region: GameRecordsRegion): Promise<void> {
  const db = env.DB!, now = Date.now();
  const { results } = await db.prepare(`SELECT m.payload_key,m.size_bytes,m.uploaded_at_ms,g.queued_at_ms
    FROM official_payload_maintenance AS m LEFT JOIN official_observation_payload_gc AS g ON g.payload_key=m.payload_key
    WHERE m.region=? AND m.orphan_at_ms IS NULL AND m.retry_at_ms<=?
      AND (m.compressed_at_ms IS NULL OR m.payload_key LIKE 'official/2/%' AND m.uploaded_at_ms<=?
        AND g.queued_at_ms>m.checked_gc_at_ms AND g.queued_at_ms<=?)
      AND NOT EXISTS (SELECT 1 FROM official_observation_batches WHERE payload_key=m.payload_key)
    ORDER BY m.size_bytes DESC LIMIT 64`).bind(region, now, now - 43_200_000, now - GRACE_MS).all<CompressionJob>();
  let bytes = 0;
  const deadline = Date.now() + 20_000;
  for (const job of results) {
    if (Date.now() >= deadline || bytes && bytes + job.size_bytes > 32 * 1024 * 1024) break;
    bytes += job.size_bytes;
    try {
      let retained: Set<string> | undefined;
      const checkpoint = job.uploaded_at_ms <= now - 43_200_000 && job.queued_at_ms !== null && job.queued_at_ms <= now - GRACE_MS ? job.queued_at_ms : 0;
      if (checkpoint && job.payload_key.startsWith("official/2/")) {
        const hashes = await db.batch<{ payload_hash: string }>(HASH_TABLES.map((table) =>
          db.prepare(`SELECT DISTINCT payload_hash FROM ${table} WHERE payload_key=? AND payload_hash IS NOT NULL`).bind(job.payload_key)));
        retained = new Set(hashes.flatMap((result) => result.results.map((row) => row.payload_hash)));
      }
      const size = await compressOfficialPayload(env, job.payload_key, retained);
      if (size === 0) {
        if ((await referencedKeys(db, [job.payload_key])).has(job.payload_key)) throw new Error("official_payload_unavailable");
        await db.prepare("DELETE FROM official_payload_maintenance WHERE payload_key=?").bind(job.payload_key).run();
        continue;
      }
      await db.batch([
        db.prepare(`UPDATE official_storage_sweeps SET rewritten_objects=rewritten_objects+
          COALESCE((SELECT size_bytes>? FROM official_payload_maintenance WHERE payload_key=?),0),
          saved_bytes=saved_bytes+COALESCE((SELECT MAX(0,size_bytes-?) FROM official_payload_maintenance WHERE payload_key=?),0) WHERE region=?`)
          .bind(size, job.payload_key, size, job.payload_key, region),
        db.prepare(`UPDATE official_payload_maintenance SET size_bytes=?,compressed_at_ms=?,checked_gc_at_ms=MAX(checked_gc_at_ms,?),retry_at_ms=0,last_error=NULL
          WHERE payload_key=?`).bind(size, Date.now(), checkpoint, job.payload_key),
      ]);
    } catch (error) {
      const code = error instanceof Error ? /^official_[a-z_]+$/u.test(error.message) ? error.message : error.name : "Error";
      await db.prepare(`UPDATE official_payload_maintenance SET retry_at_ms=?,last_error=? WHERE payload_key=?
        AND (compressed_at_ms IS NULL OR checked_gc_at_ms<?)`)
        .bind(Date.now() + 3_600_000, code, job.payload_key, job.queued_at_ms ?? 0).run();
      console.warn(JSON.stringify({ event: "official_payload_compression_failed", region, code }));
    }
  }
}

export async function maintainOfficialStorage(env: OfficialRankingStoreBindings, region: GameRecordsRegion): Promise<void> {
  const db = env.DB!, lease = crypto.randomUUID(), now = Date.now();
  const state = await db.prepare(`UPDATE official_storage_sweeps SET lease_id=?,lease_until_ms=?,
    next_scan_at_ms=CASE WHEN first_run_at_ms IS NULL THEN MAX(next_scan_at_ms,?) ELSE next_scan_at_ms END,
    first_run_at_ms=COALESCE(first_run_at_ms,?)
    WHERE region=? AND lease_until_ms<=? RETURNING format_version,cursor,next_scan_at_ms`)
    .bind(lease, now + 90_000, now + GRACE_MS, now, region, now).first<Sweep>();
  if (!state) return;
  try {
    try { await sweepPage(env, region, lease, state); }
    catch (error) { console.warn(JSON.stringify({ event: "official_payload_sweep_failed", region, code: error instanceof Error ? error.name : "Error" })); }
    await compressDue(env, region);
  } finally {
    await db.prepare("UPDATE official_storage_sweeps SET lease_id=NULL,lease_until_ms=0 WHERE region=? AND lease_id=?")
      .bind(region, lease).run();
  }
}
