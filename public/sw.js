// haneoka service worker: repeat visits should not re-pay the network.
//
// Strategy per request class:
// - HTML navigations: network-first with an offline fallback. This prevents a
//   cached document from referencing a previous deployment's hashed assets.
// - Hashed build output (/_astro/*): cache-first. URLs are immutable.
// - Long-lived static assets (icon sprite, locale catalogs): cache-first;
//   their HTTP cache policy already revalidates in the background.
// - Images: cache-first with an entry cap, evicting the oldest first.
// - Everything else (API, auth, worker routes): network only.

const VERSION = "v4";
const PAGES_CACHE = `haneoka.pages.${VERSION}`;
const ASSETS_CACHE = `haneoka.assets.${VERSION}`;
const IMAGES_CACHE = `haneoka.images.${VERSION}`;
const ACTIVE_CACHES = [PAGES_CACHE, ASSETS_CACHE, IMAGES_CACHE];

const MAX_PAGES = 30;
const MAX_IMAGES = 300;
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
  const refresh = fetch(request)
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

const networkFirst = async (request, cacheName) => {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response.ok) {
      await cache.put(request, response.clone());
      await trimCache(cacheName, MAX_PAGES);
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
  if (url.origin !== self.location.origin || isNeverCached(url)) return;

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
  if (request.destination === "image") {
    if (/^\/(?:assets|runtime|objects)\//.test(url.pathname)) {
      event.respondWith(staleWhileRevalidate(event, request, IMAGES_CACHE, MAX_IMAGES));
    } else {
      event.respondWith(cacheFirst(request, IMAGES_CACHE, MAX_IMAGES));
    }
  }
});
