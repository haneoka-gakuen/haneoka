// L3 — GEB
// Input: Collector calls from the site and admin; the collector host's replicated rows and object operations.
// Output: Calls carried to the collector host; host changes applied to D1 and the official R2 bucket.
// Pos: [Map](L2.md); the boundary between the Worker and the self-hosted collector.
// Effects/Dependencies: HTTPS to OFFICIAL_HOST_ORIGIN; D1 batches and R2 operations on the host's behalf; bearer-token checks.
import type { GameRecordsRegion } from "../src/lib/game-records";
import type { OfficialRankingCollector } from "./official-ranking-collector";
import { AccountVaultUnavailable } from "./official-platform-accounts";

type CollectorCalls = Pick<OfficialRankingCollector, "status" | "requestDemand" | "requestArenaWindows" | "requestEventWindows" | "poolView" | "poolAction" |
  "poolAdd" | "platformAccountView" | "requestPlatformLogin" | "guestAccountView" | "adoptConfiguredGuests" | "requestGuestRegistration" | "requestGuestVerification">;

export class HostCallError extends Error {
  constructor(name: string, message: string) {
    super(message);
    this.name = name;
  }
}

/** The bindings that reach the collector host. */
export interface CollectorBindings {
  OFFICIAL_HOST_ORIGIN?: string;
  OFFICIAL_COLLECTOR_REMOTE_TOKEN?: string;
}

const hostToken = (env: CollectorBindings) => env.OFFICIAL_COLLECTOR_REMOTE_TOKEN && env.OFFICIAL_COLLECTOR_REMOTE_TOKEN.length >= 32 ? env.OFFICIAL_COLLECTOR_REMOTE_TOKEN : null;

async function hostCall<T>(env: CollectorBindings, body: { object?: string; module?: string; method: string; args: unknown[] }): Promise<T> {
  const token = hostToken(env);
  if (!env.OFFICIAL_HOST_ORIGIN || !token) throw new HostCallError("HostUnavailable", "collector_host_unconfigured");
  const response = await fetch(new URL("/rpc", env.OFFICIAL_HOST_ORIGIN), {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  type Reply = { value?: T; error?: { name: string; message: string } };
  const result: Reply = await response.json<Reply>().catch(() => ({ error: { name: "HostUnavailable", message: `collector_host_${response.status}` } }));
  if (!response.ok || result.error) throw new HostCallError(result.error?.name ?? "HostUnavailable", result.error?.message ?? `collector_host_${response.status}`);
  return result.value as T;
}

/** A regional collector on the collector host. */
export function officialCollector(env: CollectorBindings, region: GameRecordsRegion): CollectorCalls {
  return new Proxy({}, {
    get: (_target, method: string) => (...args: unknown[]) => hostCall(env, { object: region, method, args }),
  }) as CollectorCalls;
}

export function collectorFor(env: CollectorBindings, region: GameRecordsRegion): CollectorCalls | null {
  return env.OFFICIAL_HOST_ORIGIN ? officialCollector(env, region) : null;
}

/** Account-store calls the host owns, run there with its own bindings. */
export function officialHostModule<T>(env: CollectorBindings, module: "platform" | "guests", method: string, ...args: unknown[]): Promise<T> {
  return hostCall<T>(env, { module, method, args });
}

// ---------- the host's own calls into the Worker ----------

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/u;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

export function authorizedHost(request: Request, env: CollectorBindings): boolean {
  const token = hostToken(env);
  const given = request.headers.get("Authorization") ?? "";
  if (!token || given.length !== token.length + 7) return false;
  const expected = new TextEncoder().encode(`Bearer ${token}`), actual = new TextEncoder().encode(given);
  let difference = 0;
  for (let index = 0; index < expected.length; index++) difference |= expected[index]! ^ actual[index]!;
  return difference === 0;
}

type Operation = { table: string; upsert?: Record<string, unknown>; remove?: Record<string, unknown> };

/** The host's changed rows, applied in order in one D1 transaction. */
async function applyRows(env: Env, operations: Operation[]): Promise<Response> {
  const db = env.DB!;
  const statements: D1PreparedStatement[] = [db.prepare("PRAGMA defer_foreign_keys = on")];
  for (const operation of operations) {
    const row = operation.upsert ?? operation.remove;
    if (!operation.table.startsWith("official_") || operation.table === "official_ranking_search_backfills" || !IDENTIFIER.test(operation.table)
      || !row || typeof row !== "object") return json({ error: "invalid_operation" }, 400);
    const columns = Object.keys(row);
    if (!columns.length || columns.length > 90 || columns.some((column) => !IDENTIFIER.test(column))) return json({ error: "invalid_operation" }, 400);
    const values = columns.map((column) => row[column] ?? null);
    if (operation.upsert) {
      statements.push(db.prepare(`INSERT INTO "${operation.table}" (${columns.map((c) => `"${c}"`).join(",")}) VALUES (${columns.map(() => "?").join(",")})
        ON CONFLICT DO UPDATE SET ${columns.map((c) => `"${c}"=excluded."${c}"`).join(",")}`).bind(...values));
    } else {
      statements.push(db.prepare(`DELETE FROM "${operation.table}" WHERE ${columns.map((c) => `"${c}" IS ?`).join(" AND ")}`).bind(...values));
    }
  }
  await db.batch(statements);
  return json({ applied: operations.length });
}

const objectMeta = (object: R2Object) => ({
  key: object.key, size: object.size, etag: object.etag, uploaded: object.uploaded.toISOString(),
  httpMetadata: object.httpMetadata, customMetadata: object.customMetadata,
});

async function objectOperation(request: Request, env: Env, operation: string): Promise<Response> {
  const bucket = env.OFFICIAL_RANKING_DATA!;
  const url = new URL(request.url);
  const key = url.searchParams.get("key") ?? "";
  const keyed = ["head", "get", "put"].includes(operation);
  if (keyed && (!key.startsWith("official/") || key.length > 512)) return json({ error: "invalid_key" }, 400);
  switch (operation) {
    case "head": {
      const object = await bucket.head(key);
      return object ? json(objectMeta(object)) : json({ error: "not_found" }, 404);
    }
    case "get": {
      const object = await bucket.get(key);
      if (!object) return json({ error: "not_found" }, 404);
      return new Response(object.body, { headers: { "Content-Type": "application/octet-stream", "Cache-Control": "no-store",
        "X-Object-Meta": encodeURIComponent(JSON.stringify(objectMeta(object))) } });
    }
    case "put": {
      const options = JSON.parse(decodeURIComponent(request.headers.get("X-Put-Options") ?? "%7B%7D")) as {
        httpMetadata?: R2HTTPMetadata; customMetadata?: Record<string, string>; etagMatches?: string };
      const saved = await bucket.put(key, await request.arrayBuffer(), {
        ...(options.httpMetadata ? { httpMetadata: options.httpMetadata } : {}),
        ...(options.customMetadata ? { customMetadata: options.customMetadata } : {}),
        ...(options.etagMatches ? { onlyIf: { etagMatches: options.etagMatches } } : {}),
      });
      return saved ? json(objectMeta(saved)) : json({ error: "precondition_failed" }, 412);
    }
    case "delete": {
      const { keys } = await request.json<{ keys: string[] }>();
      if (!Array.isArray(keys) || keys.length > 1000 || keys.some((one) => typeof one !== "string" || !one.startsWith("official/"))) return json({ error: "invalid_key" }, 400);
      if (keys.length) await bucket.delete(keys);
      return json({ deleted: keys.length });
    }
    case "list": {
      const options = await request.json<{ prefix?: string; limit?: number; cursor?: string; include?: ("httpMetadata" | "customMetadata")[] }>();
      if (!options.prefix?.startsWith("official/")) return json({ error: "invalid_key" }, 400);
      const page = await bucket.list({ prefix: options.prefix, limit: Math.min(options.limit ?? 1000, 1000),
        ...(options.cursor ? { cursor: options.cursor } : {}), ...(options.include ? { include: options.include } : {}) });
      return json({ objects: page.objects.map(objectMeta), truncated: page.truncated, cursor: page.truncated ? page.cursor : undefined, delimitedPrefixes: page.delimitedPrefixes });
    }
  }
  return json({ error: "not_found" }, 404);
}

/** `/api/internal/official-host/…`: the collector host's row sync and object access. */
export async function handleOfficialHost(request: Request, env: Env, path: string): Promise<Response> {
  if (!authorizedHost(request, env)) return json({ error: "unauthorized" }, 401);
  if (path === "sync" && request.method === "POST") {
    const { operations } = await request.json<{ operations: Operation[] }>();
    if (!Array.isArray(operations) || operations.length > 1000) return json({ error: "invalid_operation" }, 400);
    return applyRows(env, operations);
  }
  const object = /^r2\/(head|get|put|delete|list)$/u.exec(path);
  if (object) return objectOperation(request, env, object[1]!);
  return json({ error: "not_found" }, 404);
}

/** An account-store call: on the host when it owns the store, else here. */
export async function hostOr<A extends unknown[], R>(env: Env, module: "platform" | "guests", name: string,
  local: (env: Env, ...args: A) => Promise<R>, ...args: A): Promise<R> {
  if (!env.OFFICIAL_HOST_ORIGIN) return local(env, ...args);
  try {
    return await officialHostModule<R>(env, module, name, ...args);
  } catch (error) {
    if (error instanceof HostCallError && error.name === "AccountVaultUnavailable") throw new AccountVaultUnavailable();
    throw error;
  }
}
