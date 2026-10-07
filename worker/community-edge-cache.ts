/*
 * Edge cache for anonymous community reads.
 *
 * A request that carries no identity (no auth cookie, no D1 bookmark cookie,
 * no Authorization header) can only ever be answered with the anonymous view,
 * which is identical for every anonymous visitor of the same URL. Those
 * responses are kept in this colo's cache for a few seconds and served
 * stale-while-revalidate, so an anonymous feed, post, forum list, tag list or
 * profile skips every D1 round trip.
 *
 * Privacy: any cookie outside a small allowlist of non-identity cookies
 * bypasses the cache in both directions, a response is stored only when it is
 * 200, has no Set-Cookie, and (for the bootstrap) states an anonymous viewer.
 * The browser still receives "private, no-store"; only the colo cache holds
 * the shared copy, under an internal key.
 *
 * Freshness: entries are fresh for FRESH_MS and may be served up to
 * FRESH_MS + STALE_MS old while one background request refreshes them. Any
 * successful API mutation handled in this colo moves the colo's generation
 * mark, so entries stored before it are ignored here at once; other colos
 * converge within the TTL.
 */

const FRESH_MS = 10_000;
const STALE_MS = 20_000;
const KEY_PREFIX = "/__edge-cache/community/v1";
const GENERATION_PATH = "/__edge-cache/community/generation";
const STORED_AT = "X-Edge-Stored-At";
const CACHEABLE_PATH =
  /^\/api\/v1\/community\/(?:bootstrap|posts(?:\/[0-9a-f-]{36})?|forums(?:\/by-slug\/[^/]{1,128})?|tags|users\/[1-9]\d{0,15}|entity-threads\/[a-z][a-z0-9-]{0,63}\/[^/]{1,256})$/iu;
/** Cookies that never select an identity or a different response. */
const NEUTRAL_COOKIES = new Set(["haneoka.locale", "__cf_bm", "cf_clearance", "_cfuvid", "__cflb"]);

function cookieNames(header: string | null): string[] {
  return (header || "").split(";").map((part) => part.split("=")[0]!.trim()).filter(Boolean);
}

/** Anonymous by construction: nothing in the request can select a viewer. */
export function anonymousRequest(request: Request): boolean {
  if (request.headers.has("Authorization")) return false;
  // The D1 bookmark cookie is not identity, but it means this browser wrote
  // moments ago and must read its own write, so it bypasses the cache too.
  return cookieNames(request.headers.get("Cookie")).every((name) => NEUTRAL_COOKIES.has(name));
}

export function edgeCacheable(request: Request): boolean {
  if (request.method !== "GET") return false;
  const url = new URL(request.url);
  if (!CACHEABLE_PATH.test(url.pathname) || url.searchParams.has("refresh") || url.search.length > 4096) return false;
  // Same rule as the bootstrap's own cross-site refusal: never answer a
  // cross-site read from the cache where the handler would refuse it.
  const origin = request.headers.get("Origin");
  if (request.headers.get("Sec-Fetch-Site") === "cross-site" || (origin && origin !== url.origin)) return false;
  return anonymousRequest(request);
}

const cacheKey = (url: URL) =>
  new Request(`${url.origin}${KEY_PREFIX}?u=${encodeURIComponent(`${url.pathname}${url.search}`)}`, { method: "GET" });
const generationKey = (url: URL) => new Request(`${url.origin}${GENERATION_PATH}`, { method: "GET" });

function edgeCache(): Cache | null {
  try {
    return typeof caches !== "undefined" && caches.default ? caches.default : null;
  } catch {
    return null;
  }
}

async function generation(cache: Cache, url: URL): Promise<number> {
  const mark = await cache.match(generationKey(url)).catch(() => undefined);
  const value = Number(mark ? await mark.text() : 0);
  return Number.isFinite(value) ? value : 0;
}

/** A successful mutation invalidates this colo's anonymous entries immediately. */
export async function markCommunityMutation(origin: string): Promise<void> {
  const cache = edgeCache();
  if (!cache) return;
  await cache.put(
    generationKey(new URL(origin)),
    new Response(String(Date.now()), {
      headers: { "Cache-Control": `public, max-age=${Math.ceil((FRESH_MS + STALE_MS) / 1000) + 5}` },
    }),
  ).catch(() => undefined);
}

async function storable(response: Response, url: URL): Promise<boolean> {
  if (response.status !== 200 || response.headers.has("Set-Cookie") || response.webSocket) return false;
  if (!(response.headers.get("Content-Type") || "").includes("application/json")) return false;
  if (url.pathname !== "/api/v1/community/bootstrap") return true;
  // Defence in depth: the bootstrap names its viewer; only an anonymous one is shared.
  try {
    const body = await response.clone().json<{ viewer?: { userId?: unknown; session?: unknown; staffRole?: unknown } }>();
    return body.viewer?.userId === "" && body.viewer.session === null && body.viewer.staffRole === null;
  } catch {
    return false;
  }
}

async function store(cache: Cache, url: URL, response: Response): Promise<void> {
  if (!(await storable(response, url))) return;
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", `public, max-age=${Math.ceil((FRESH_MS + STALE_MS) / 1000)}`);
  headers.delete("Vary");
  headers.delete("Set-Cookie");
  headers.delete("Server-Timing");
  headers.set(STORED_AT, String(Date.now()));
  await cache.put(cacheKey(url), new Response(response.body, { status: 200, headers })).catch(() => undefined);
}

function present(response: Response, state: "hit" | "stale" | "miss" | "bypass"): Response {
  const result = new Response(response.body, response);
  const storedAt = Number(result.headers.get(STORED_AT));
  result.headers.delete(STORED_AT);
  // Browsers keep treating community reads as uncacheable.
  result.headers.set("Cache-Control", "private, no-store");
  result.headers.set("Vary", "Cookie");
  result.headers.set("X-Community-Cache", state);
  if (Number.isFinite(storedAt) && storedAt > 0)
    result.headers.set("Age", String(Math.max(0, Math.floor((Date.now() - storedAt) / 1000))));
  return result;
}

const refreshing = new Map<string, Promise<void>>();

/** Serve an anonymous community read from the colo cache, refreshing it in the background. */
export async function cachedCommunityRead(
  request: Request,
  ctx: Pick<ExecutionContext, "waitUntil">,
  compute: () => Promise<Response>,
): Promise<Response> {
  const cache = edgeCacheable(request) ? edgeCache() : null;
  if (!cache) return compute();
  const url = new URL(request.url);
  const key = cacheKey(url);
  const [hit, mark] = await Promise.all([cache.match(key).catch(() => undefined), generation(cache, url)]);
  const storedAt = Number(hit?.headers.get(STORED_AT));
  const age = Date.now() - storedAt;
  if (hit && Number.isFinite(storedAt) && storedAt > mark && age >= 0 && age < FRESH_MS + STALE_MS) {
    if (age >= FRESH_MS && !refreshing.has(key.url)) {
      const refresh = compute()
        .then((fresh) => store(cache, url, fresh))
        .catch(() => undefined)
        .finally(() => refreshing.delete(key.url));
      refreshing.set(key.url, refresh);
      ctx.waitUntil(refresh);
    }
    return present(hit, age < FRESH_MS ? "hit" : "stale");
  }
  const response = await compute();
  if (response.status !== 200) return response;
  ctx.waitUntil(store(cache, url, response.clone()));
  return present(response, "miss");
}
