// haneoka service worker: repeat visits should not re-pay the network.
//
// Strategy per request class:
// - HTML navigations: network-first with an offline fallback. This prevents a
//   cached document from referencing a previous deployment's hashed assets.
// - Hashed build output (/_astro/*): cache-first. URLs are immutable.
// - Icon sprite: stale-while-revalidate with an HTTP cache validation.
// - Release-pinned media (?release=): images cache-first, everything else is
//   left to the HTTP cache (immutable for a year).
// - Current-release media: images stale-while-revalidate with an entry cap (a
//   release update shows the new artwork on the next view); other media is
//   validated over the network.
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
const MAX_IMAGES = 300;
const MAX_DATA = 200;
const NEVER_CACHE_PREFIXES = ["/api/", "/auth/", "/account/", "/admin/", "/sonolus/", "/game-client/"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(ASSETS_CACHE));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) {
        if (name.startsWith("haneoka.") && !ACTIVE_CACHES.includes(name)) {
          await caches.delete(name);
        }
      }
      await self.clients.claim();
    })(),
  );
});

const isNeverCached = (url) => NEVER_CACHE_PREFIXES.some((prefix) => url.pathname.startsWith(prefix));

const trimCache = async (cacheName, limit) => {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  for (const key of keys.slice(0, Math.max(0, keys.length - limit))) {
    await cache.delete(key);
  }
};

const cacheFirst = async (request, cacheName, limit) => {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) {
    await cache.put(request, response.clone());
    if (limit) await trimCache(cacheName, limit);
  }
  return response;
};

const staleWhileRevalidate = async (event, request, cacheName, limit) => {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const refresh = fetch(request, { cache: "no-cache" })
    .then(async (response) => {
      if (response.ok) {
        await cache.put(request, response.clone());
        if (limit) await trimCache(cacheName, limit);
      }
      return response;
    })
    .catch(() => cached ?? Response.error());
  if (cached) {
    event.waitUntil(refresh);
    return cached;
  }
  return refresh;
};

const networkFirst = async (request, cacheName, limit = MAX_PAGES) => {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request, { cache: "no-cache" });
    if (response.ok) {
      await cache
        .put(request, response.clone())
        .then(() => trimCache(cacheName, limit))
        .catch(() => {});
    }
    return response;
  } catch {
    return (await cache.match(request)) ?? Response.error();
  }
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
    event.respondWith(networkFirst(request, PAGES_CACHE));
    return;
  }
  if (url.pathname === "/icons.svg") {
    event.respondWith(staleWhileRevalidate(event, request, ASSETS_CACHE));
    return;
  }
  if (url.pathname.startsWith("/_astro/") || url.pathname.startsWith("/fonts/")) {
    event.respondWith(cacheFirst(request, ASSETS_CACHE));
    return;
  }
  if (url.pathname.startsWith("/entity-data/v1/")) {
    event.respondWith(cacheFirst(request, DATA_CACHE, MAX_DATA));
    return;
  }
  if (/^\/(?:assets|runtime|objects)\//.test(url.pathname)) {
    // A release-pinned URL can never change: the HTTP cache keeps it as
    // immutable, and range/media requests must reach it untouched.
    if (url.searchParams.has("release")) {
      if (request.destination === "image") event.respondWith(cacheFirst(request, IMAGES_CACHE, MAX_IMAGES));
      return;
    }
    // Current-release artwork paints from the cache at once and refreshes
    // behind it, so a repeat visit never waits on a revalidation per image.
    event.respondWith(
      request.destination === "image"
        ? staleWhileRevalidate(event, request, IMAGES_CACHE, MAX_IMAGES)
        : fetch(request, { cache: "no-cache" }),
    );
    return;
  }
  if (request.destination === "image") {
    event.respondWith(cacheFirst(request, IMAGES_CACHE, MAX_IMAGES));
  }
});
