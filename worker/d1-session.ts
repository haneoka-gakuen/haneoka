import { AsyncLocalStorage } from "node:async_hooks";

/*
 * D1 read replication through the Sessions API.
 *
 * Every D1 query from a colo far from the primary costs a long network round
 * trip. With read replication enabled on the database, a session that starts
 * "first-unconstrained" may be served by the nearest replica. Only an explicit
 * allowlist of read-only GET routes opts in; every other request keeps going to
 * the primary exactly as before ("first-primary" for mutations, the plain
 * binding otherwise).
 *
 * Read-your-writes: a mutation returns the session bookmark in a short-lived
 * cookie. A later read from that browser starts its session at that bookmark,
 * so a replica can only answer once it has caught up with the browser's own
 * writes. Without replication enabled, sessions simply run on the primary.
 *
 * The binding handed to handlers is one stable proxy per database (so caches
 * keyed by the binding, like the Better Auth instance, keep hitting); each call
 * resolves the current request's session through async-local storage.
 */

export const D1_BOOKMARK_COOKIE = "haneoka-d1-bookmark";
const BOOKMARK_MAX_AGE_SECONDS = 120;
// D1 bookmarks look like "00000000-00000047-00000000-<32 hex>"; anything else is ignored.
const BOOKMARK_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{8}-[0-9a-f]{8}-[0-9a-f]{32}$/iu;

const scope = new AsyncLocalStorage<D1DatabaseSession>();
const proxies = new WeakMap<D1Database, D1Database>();

/** Read-only routes whose handlers tolerate replica reads (bounded by the bookmark). */
export function replicaReadable(request: Request): boolean {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  const path = new URL(request.url).pathname;
  return (
    path.startsWith("/api/v1/community/") ||
    path === "/api/auth/get-session" ||
    path === "/api/v1/admin/session" ||
    path === "/api/v1/account/profile" ||
    path === "/api/v1/me/preferences"
  );
}

export function bookmarkFromCookie(header: string | null): string | null {
  for (const part of (header || "").split(";")) {
    const index = part.indexOf("=");
    if (index < 0 || part.slice(0, index).trim() !== D1_BOOKMARK_COOKIE) continue;
    const value = part.slice(index + 1).trim();
    return BOOKMARK_PATTERN.test(value) ? value : null;
  }
  return null;
}

function routedDatabase(database: D1Database): D1Database {
  let proxy = proxies.get(database);
  if (!proxy) {
    const current = () => scope.getStore() ?? database;
    proxy = {
      prepare: (query: string) => current().prepare(query),
      batch: <T = unknown>(statements: D1PreparedStatement[]) => current().batch<T>(statements),
      exec: (query: string) => database.exec(query),
      withSession: (constraint?: D1SessionBookmark | D1SessionConstraint) => database.withSession(constraint),
      dump: () => database.dump(),
    } as unknown as D1Database;
    proxies.set(database, proxy);
  }
  return proxy;
}

const environments = new WeakMap<Env, Env>();
/** The same bindings with DB routed; a stable view per environment object, every other binding untouched. */
function routedEnvironment(env: Env, database: D1Database): Env {
  let routed = environments.get(env);
  if (!routed) {
    const proxy = routedDatabase(database);
    routed = new Proxy(env, { get: (target, key, receiver) => key === "DB" ? proxy : Reflect.get(target, key, receiver) });
    environments.set(env, routed);
  }
  return routed;
}

/** Run one fetch invocation with its D1 session; mutations hand the browser their bookmark. */
export async function withD1Session(
  request: Request,
  env: Env,
  handle: (env: Env) => Promise<Response>,
): Promise<Response> {
  const database = env.DB;
  if (!database || typeof database.withSession !== "function") return handle(env);
  const routedEnv = routedEnvironment(env, database);
  const mutation = request.method !== "GET" && request.method !== "HEAD" && request.method !== "OPTIONS";
  const readable = replicaReadable(request);
  if (!mutation && !readable) return handle(routedEnv);
  let session: D1DatabaseSession;
  try {
    session = mutation
      ? database.withSession("first-primary")
      : database.withSession(bookmarkFromCookie(request.headers.get("Cookie")) ?? "first-unconstrained");
  } catch {
    return handle(routedEnv);
  }
  const response = await scope.run(session, () => handle(routedEnv));
  if (!mutation || response.status === 101 || response.webSocket) return response;
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/")) return response;
  const bookmark = session.getBookmark();
  if (!bookmark || !BOOKMARK_PATTERN.test(bookmark)) return response;
  const marked = new Response(response.body, response);
  marked.headers.append(
    "Set-Cookie",
    `${D1_BOOKMARK_COOKIE}=${bookmark}; Path=/; Max-Age=${BOOKMARK_MAX_AGE_SECONDS}; HttpOnly; SameSite=Lax${url.protocol === "https:" ? "; Secure" : ""}`,
  );
  return marked;
}
