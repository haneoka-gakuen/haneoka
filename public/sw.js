// L3 — GEB
// Input: 同源 GET 请求、导航／资源类别和浏览器缓存状态。
// Output: 按请求类别选择的网络／缓存响应及离线导航回退；缓存失败仍交付网络响应。
// Pos: [Map](L2.md)；站点 Service Worker 缓存与版本生命周期。
// Effects/Dependencies: 注册 install／activate／fetch 事件、访问网络与 CacheStorage、淘汰旧缓存；缓存写入由 waitUntil 后台完成，读写失败不阻断请求；API／认证等路径不进入通用缓存。
// haneoka service worker: repeat visits should not re-pay the network.
//
// Strategy per request class:
// - HTML navigations: network-first with an offline fallback. This prevents a
//   cached document from referencing a previous deployment's hashed assets.
// - Hashed build output (/_astro/*): cache-first. URLs are immutable.
// - Icon sprite: stale-while-revalidate with an HTTP cache validation.
// - Release-pinned media (?release=): images cache-first, everything else is
//   left to the HTTP cache (immutable for a year).
// - Current-release media: images from the cache for six hours, then
//   stale-while-revalidate, with an entry cap; other media follows the HTTP
//   cache (six hours fresh).
// - Other images: cache-first with an entry cap, evicting the oldest first.
// - Build-time entity payloads (/entity-data/v1/*): content-addressed, cache-first
//   with an entry cap.
// - Everything else (API, auth, worker routes): network only.

const VERSION = "v7";
const PAGES_CACHE = `haneoka.pages.${VERSION}`;
const ASSETS_CACHE = `haneoka.assets.${VERSION}`;
const IMAGES_CACHE = `haneoka.images.${VERSION}`;
const DATA_CACHE = `haneoka.data.${VERSION}`;
const ACTIVE_CACHES = [PAGES_CACHE, ASSETS_CACHE, IMAGES_CACHE, DATA_CACHE];

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

const isNeverCached = (url) => NEVER_CACHE_PREFIXES.some((prefix) => url.pathname.startsWith(prefix));

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
  const { cache, cached } = await readCache(request, cacheName);
  const network = fetch(request, { cache: "no-cache" }).then((response) => {
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
    // A release-pinned URL can never change: the HTTP cache keeps it as
    // immutable, and range/media requests must reach it untouched.
    if (url.searchParams.has("release")) {
      if (request.destination === "image") event.respondWith(cacheFirst(event, request, IMAGES_CACHE, MAX_IMAGES));
      return;
    }
    // Current-release artwork paints from the cache at once; only artwork
    // older than IMAGE_FRESH_MS asks the server again, behind the page.
    if (request.destination === "image")
      event.respondWith(staleWhileRevalidate(event, request, IMAGES_CACHE, MAX_IMAGES, IMAGE_FRESH_MS));
    return;
  }
  if (request.destination === "image") {
    event.respondWith(cacheFirst(event, request, IMAGES_CACHE, MAX_IMAGES));
  }
});
