// L3 — GEB
// Input: 同源 GET 请求、显示范围、导航／资源类别和浏览器缓存状态。
// Output: 按请求类别与显示范围选择的网络／缓存响应及离线导航回退。
// Pos: [Map](L2.md)；站点 Service Worker 缓存与版本生命周期。
// Effects/Dependencies: 注册 install／activate／fetch 事件、访问网络与 CacheStorage、淘汰旧缓存；缓存写入由 waitUntil 后台完成，读写失败不阻断请求；API／认证等路径不进入通用缓存。
// haneoka service worker: repeat visits should not re-pay the network.
//
// Strategy per request class:
// - HTML navigations: network-first with a display-scoped offline fallback.
// - Hashed build output (/_astro/*): cache-first. URLs are immutable.
// - Icon sprite: stale-while-revalidate with an HTTP cache validation.
// - Game media: public bytes are shared, restricted bytes use the current
//   display scope. Pinned releases are immutable; current media lasts six hours.
//   Complete audio responses also satisfy subsequent byte-range requests.
// - Other images: cache-first with an entry cap, evicting the oldest first.
// - Build-time entity payloads (/entity-data/v1/*): content-addressed, cache-first
//   with an entry cap.
// - Everything else (API, auth, worker routes): network only.

const VERSION = "v7";
const PAGES_CACHE = "haneoka.pages.v9";
const ASSETS_CACHE = `haneoka.assets.${VERSION}`;
const IMAGES_CACHE = "haneoka.images.v8";
const DATA_CACHE = `haneoka.data.${VERSION}`;
const PUBLIC_MEDIA_CACHE = "haneoka.media.public.v1";
const SCOPED_MEDIA_CACHE = "haneoka.media.scoped.v1";
const ACTIVE_CACHES = [PAGES_CACHE, ASSETS_CACHE, IMAGES_CACHE, DATA_CACHE, PUBLIC_MEDIA_CACHE, SCOPED_MEDIA_CACHE];
const clientScopes = new Map();
const SCOPE_KEY = new Request(new URL("/__haneoka-content-view", self.location.origin));
let lastScope;
let scopeRevision = 0;
let scopeWrites = Promise.resolve();

const rememberScope = (scope) => {
  if (lastScope === scope) return scopeWrites;
  lastScope = scope;
  scopeRevision++;
  scopeWrites = scopeWrites.catch(() => {}).then(async () => {
    const cache = await caches.open(DATA_CACHE);
    if (scope) await cache.put(SCOPE_KEY, new Response(scope));
    else await cache.delete(SCOPE_KEY);
  }).catch(() => {});
  return scopeWrites;
};

const rememberedScope = async () => {
  if (lastScope !== undefined) return lastScope;
  const revision = scopeRevision;
  try {
    const cache = await caches.open(DATA_CACHE);
    const value = await cache.match(SCOPE_KEY);
    const scope = value ? await value.text() : null;
    if (scopeRevision === revision) lastScope = scope;
  } catch {}
  return lastScope;
};

self.addEventListener("message", (event) => {
  if (event.data?.type === "haneoka:content-view-reset") {
    clientScopes.clear();
    event.waitUntil(rememberScope(null));
  }
  else if (event.data?.type === "haneoka:content-view" && event.source?.id && typeof event.data.scope === "string")
    {
      clientScopes.set(event.source.id, event.data.scope);
      if (clientScopes.size > 128) clientScopes.delete(clientScopes.keys().next().value);
      event.waitUntil(rememberScope(event.data.scope));
    }
});

const MAX_PAGES = 30;
const MAX_IMAGES = 2000;
// Current-release artwork younger than this is used without asking the server.
const IMAGE_FRESH_MS = 6 * 60 * 60 * 1000;
const TRIM_EVERY = 64;
const writes = new Map();
const MAX_DATA = 200;
const NEVER_CACHE_PREFIXES = ["/api/", "/auth/", "/account/", "/admin/", "/sonolus/", "/game-client/"];

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      try {
        for (const name of await caches.keys()) {
          if (name.startsWith("haneoka.") && !ACTIVE_CACHES.includes(name)) {
            await caches.delete(name);
          }
        }
      } catch {}
      await self.clients.claim();
    })(),
  );
});

const isNeverCached = (url) => NEVER_CACHE_PREFIXES.some((prefix) => url.pathname.startsWith(prefix)) ||
  /^\/(?:ja|en|ko|zh-CN|zh-TW)\/(?:account|admin|auth|community)(?:\/|$)/.test(url.pathname);

const mediaKey = (url, scope) => {
  const key = new URL(url);
  for (const field of ["__content", "spoiler", "cv"]) key.searchParams.delete(field);
  if (scope) key.searchParams.set("cv", scope);
  key.searchParams.sort();
  return new Request(key);
};

const requestedScope = (url, scope) => {
  if (!scope || !url.searchParams.has("spoiler")) return scope;
  const value = Number(url.searchParams.get("spoiler"));
  return scope.replace(/-[01]$/, `-${Number(Number.isFinite(value) && value !== 0)}`);
};

const mediaRange = async (request, response) => {
  const value = request.headers.get("Range");
  if (!value) return response;
  if (response.headers.has("Content-Encoding")) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2])) return null;
  const validator = request.headers.get("If-Range");
  if (validator && validator !== response.headers.get("ETag") && validator !== response.headers.get("Last-Modified"))
    return response;
  const length = Number(response.headers.get("Content-Length"));
  if (!Number.isSafeInteger(length) || length <= 0 || !response.body) return null;
  const start = match[1] ? Number(match[1]) : Math.max(0, length - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(length - 1, Number(match[2])) : length - 1;
  const headers = new Headers(response.headers);
  headers.delete("Content-Encoding");
  headers.set("Accept-Ranges", "bytes");
  if (!Number.isSafeInteger(start) || start < 0 || start > end || start >= length) {
    headers.set("Content-Range", `bytes */${length}`);
    headers.set("Content-Length", "0");
    return new Response(null, { status: 416, headers });
  }
  headers.set("Content-Range", `bytes ${start}-${end}/${length}`);
  headers.set("Content-Length", String(end - start + 1));
  const reader = response.body.getReader();
  let offset = 0;
  const body = new ReadableStream({
    async pull(controller) {
      for (;;) {
        const result = await reader.read();
        if (result.done) { controller.close(); return; }
        const from = Math.max(0, start - offset);
        const to = Math.min(result.value.byteLength, end + 1 - offset);
        offset += result.value.byteLength;
        if (to > from) controller.enqueue(result.value.subarray(from, to));
        if (offset > end) { controller.close(); await reader.cancel(); return; }
        if (to > from) return;
      }
    },
    cancel(reason) { return reader.cancel(reason); },
  });
  return new Response(body, { status: 206, headers });
};

const gameMedia = async (event, request, url) => {
  const scope = requestedScope(url, url.searchParams.get("cv") || clientScopes.get(event.clientId));
  const publicKey = mediaKey(url);
  const privateKey = scope ? mediaKey(url, scope) : null;
  const shared = await readCache(publicKey, PUBLIC_MEDIA_CACHE);
  if (shared.cached && (url.searchParams.has("release") || fresh(shared.cached, IMAGE_FRESH_MS))) {
    const response = await mediaRange(request, shared.cached);
    if (response) return response;
  }
  const scoped = privateKey ? await readCache(privateKey, SCOPED_MEDIA_CACHE) : {};
  if (scoped.cached && (url.searchParams.has("release") || fresh(scoped.cached, IMAGE_FRESH_MS))) {
    const response = await mediaRange(request, scoped.cached);
    if (response) return response;
  }
  const range = request.headers.get("Range");
  const fullMedia = ["audio", "video"].includes(request.destination) && /^bytes=\d*-\d*$/.test(range || "");
  let source = request;
  if (fullMedia) {
    const headers = new Headers(request.headers);
    for (const field of ["Range", "If-Range", "If-None-Match", "If-Modified-Since"]) headers.delete(field);
    source = new Request(request, { headers, referrer: request.referrer, referrerPolicy: request.referrerPolicy });
  }
  let response;
  try { response = await fetch(source); }
  catch (error) {
    const cached = shared.cached || scoped.cached;
    if (cached) {
      const fallback = await mediaRange(request, cached);
      if (fallback) return fallback;
    }
    throw error;
  }
  if (response.status === 200) {
    const published = /(?:^|,)\s*public(?:\s|,|$)/i.test(response.headers.get("Cache-Control") || "");
    const key = published ? publicKey : privateKey;
    const cache = published ? shared.cache : scoped.cache;
    if (key && cache) {
      const headers = new Headers(response.headers);
      headers.delete("Vary");
      const stored = new Response(response.clone().body, { status: 200, headers });
      const name = published ? PUBLIC_MEDIA_CACHE : SCOPED_MEDIA_CACHE;
      event.waitUntil(cache.put(key, stored).then(() => trimCache(name, MAX_IMAGES)).catch(() => {}));
    }
  }
  return fullMedia && response.status === 200 ? (await mediaRange(request, response)) || response : response;
};

const trimCache = async (cacheName, limit) => {
  // Listing a large cache is costly: trim after every TRIM_EVERY writes.
  const count = (writes.get(cacheName) ?? 0) + 1;
  writes.set(cacheName, count);
  if (count % TRIM_EVERY !== 1) return;
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  for (const key of keys.slice(0, Math.max(0, keys.length - limit))) {
    await cache.delete(key);
  }
};

const readCache = async (request, cacheName) => {
  try {
    const cache = await caches.open(cacheName);
    return { cache, cached: await cache.match(request) };
  } catch {
    return {};
  }
};

const cacheResponse = (event, request, response, cache, cacheName, limit) => {
  if (!cache || !response.ok) return;
  event.waitUntil(
    cache.put(request, response.clone())
      .then(() => { if (limit) return trimCache(cacheName, limit); })
      .catch(() => {}),
  );
};

const cacheFirst = async (event, request, cacheName, limit) => {
  const { cache, cached } = await readCache(request, cacheName);
  if (cached) return cached;
  const response = await fetch(request);
  cacheResponse(event, request, response, cache, cacheName, limit);
  return response;
};

const fresh = (response, ms) => {
  const date = Date.parse(response?.headers.get("date") ?? "");
  return Number.isFinite(date) && Date.now() - date < ms;
};

const staleWhileRevalidate = async (event, request, cacheName, limit, freshMs = 0) => {
  const { cache, cached } = await readCache(request, cacheName);
  if (cached && freshMs && fresh(cached, freshMs)) return cached;
  const refresh = fetch(request, { cache: "no-cache" })
    .then((response) => {
      cacheResponse(event, request, response, cache, cacheName, limit);
      return response;
    })
    .catch(() => cached ?? Response.error());
  if (cached) {
    event.waitUntil(refresh);
    return cached;
  }
  return refresh;
};

// A cached page answers when the network has not within this time; the
// network keeps going and refreshes the copy for next time.
const NETWORK_GRACE_MS = 4000;

const networkFirst = async (event, request, cacheName, limit = MAX_PAGES) => {
  const url = new URL(request.url);
  const previous = clientScopes.get(event.clientId) || await rememberedScope();
  const value = Number(url.searchParams.get("spoiler"));
  const scope = previous?.replace(/-[01]$/, `-${Number(Number.isFinite(value) && value !== 0)}`);
  const lookup = scope ? mediaKey(request.url, scope) : null;
  const entry = lookup ? await readCache(lookup, cacheName) : { cache: await caches.open(cacheName).catch(() => undefined) };
  const cache = entry.cache;
  const shared = await cache?.match(request).catch(() => undefined);
  const stored = entry.cached || (shared && !shared.headers.has("X-Haneoka-Content-View") ? shared : undefined);
  const until = Number(stored?.headers.get("X-Haneoka-Content-Until"));
  const cached = until > 0 && Date.now() >= until ? undefined : stored;
  const network = fetch(request, { cache: "no-cache" }).then((response) => {
    const current = response.headers.get("X-Haneoka-Content-View");
    if (current) {
      event.waitUntil(rememberScope(current));
      cacheResponse(event, mediaKey(request.url, current), response, cache, cacheName, limit);
    }
    else if (/(?:^|,)\s*public(?:\s|,|$)/i.test(response.headers.get("Cache-Control") || ""))
      cacheResponse(event, request, response, cache, cacheName, limit);
    return response;
  });
  if (!cached) return network.catch(() => Response.error());
  event.waitUntil(network.catch(() => {}));
  const late = new Promise((resolve) => setTimeout(() => resolve(null), NETWORK_GRACE_MS));
  const first = await Promise.race([network.catch(() => null), late]);
  return first ?? cached;
};

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Revalidate current catalog URLs even if an earlier deployment gave the
  // browser a fresh response. Explicit release pins keep their cache policy.
  if (url.pathname.startsWith("/api/v1/servers/") && !url.searchParams.has("release")) {
    event.respondWith(fetch(request, { cache: "no-cache" }));
    return;
  }
  if (isNeverCached(url)) return;

  if (request.mode === "navigate") {
    event.respondWith(networkFirst(event, request, PAGES_CACHE));
    return;
  }
  if (url.pathname === "/icons.svg") {
    event.respondWith(staleWhileRevalidate(event, request, ASSETS_CACHE));
    return;
  }
  if (url.pathname.startsWith("/_astro/") || url.pathname.startsWith("/fonts/")) {
    event.respondWith(cacheFirst(event, request, ASSETS_CACHE));
    return;
  }
  if (url.pathname.startsWith("/entity-data/v1/")) {
    event.respondWith(cacheFirst(event, request, DATA_CACHE, MAX_DATA));
    return;
  }
  if (/^\/(?:assets|runtime|objects)\//.test(url.pathname)) {
    event.respondWith(gameMedia(event, request, url));
    return;
  }
  if (request.destination === "image") {
    event.respondWith(cacheFirst(event, request, IMAGES_CACHE, MAX_IMAGES));
  }
});
