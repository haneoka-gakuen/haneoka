/**
 * Bestdori reverse-proxy + transformer.
 *
 * Exposes Bestdori's official song/chart/asset data under our existing catalog
 * contract by treating `bestdori` as a pseudo-server. The worker fetches
 * bestdori.com on demand, transforms responses into our `Song`/`Band`/
 * `SongMetaByDifficulty` shapes (see app/types/archive.ts), converts charts to
 * our SS text, and proxies media bytes (jacket /
 * audio / MV with Range passthrough). Cache lifetimes are deliberately bounded
 * by the shared Bestdori policy, and concurrent work is single-flighted to
 * keep upstream concurrency low.
 *
 * Routes (all same-origin under /api/v1, dispatched before handleCatalogApi):
 *   GET /api/v1/servers/bestdori/bands
 *   GET /api/v1/servers/bestdori/songs
 *   GET /api/v1/servers/bestdori/song-meta
 *   GET /api/v1/servers/bestdori/songs/{id}
 *   GET /api/v1/servers/bestdori/cards | /cards/{id}
 *   GET /api/v1/servers/bestdori/stories/{event|band|main|afterlive}
 *   GET /api/v1/servers/bestdori/stories/{canonicalStoryId}
 *   GET /api/v1/servers/bestdori/editor-assets[/{bundlePath}]             -> lazy asset tree / files
 *   GET /api/v1/bestdori/charts/{id}/{easy|normal|hard|expert|special}   -> SS text
 *   GET /api/v1/bestdori/media/jacket/{pkg}/{image}                       -> PNG
 *   GET /api/v1/bestdori/media/jacket-thumb/{pkg}/{image}                 -> PNG
 *   GET /api/v1/bestdori/media/sound/{num}                                -> MP3
 *   GET /api/v1/bestdori/media/mv/{assetBundleName}                       -> MP4
 */

import { bestdoriBuildDataToLive2dEntry, bestdoriBuildDataTransitionPath } from "@haneoka/bestdori/live2d";
import { BESTDORI_CATALOG_VERSION, hasBestdoriCharacterIcon } from "@haneoka/bestdori/resources";
import { convertBestdoriScenario } from "@haneoka/bestdori/scenario";
import { bestdoriChartToSsText } from "@haneoka/bestdori/chart";
import { BESTDORI_CACHE_POLICY, bestdoriCacheControl } from "@haneoka/bestdori/cache-policy";

const DEFAULT_ORIGIN = "https://bestdori.com";
let upstreamOrigin = DEFAULT_ORIGIN;

const JSON_CACHE_CONTROL = bestdoriCacheControl(BESTDORI_CACHE_POLICY.catalog);
const CHART_CACHE_CONTROL = bestdoriCacheControl(BESTDORI_CACHE_POLICY.chart);
const MEDIA_CACHE_CONTROL = bestdoriCacheControl(BESTDORI_CACHE_POLICY.media);

const CORS: Readonly<Record<string, string>> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Range, If-Range, If-None-Match, Content-Type",
  "Access-Control-Expose-Headers": "Accept-Ranges, Content-Length, Content-Range, ETag",
};

const DIFFICULTY_NAMES = ["easy", "normal", "hard", "expert", "special"] as const;
const SCORE_RANK_CODE: Record<string, number> = { c: 3, b: 4, a: 5, s: 6, ss: 7 };
const SCORE_RANK_FIELDS = [
  ["c", "scoreC"],
  ["b", "scoreB"],
  ["a", "scoreA"],
  ["s", "scoreS"],
  ["ss", "scoreSS"],
] as const;
const BESTDORI_COMBO_COUNTS: Record<(typeof DIFFICULTY_NAMES)[number], number> = {
  easy: 50,
  normal: 100,
  hard: 200,
  expert: 200,
  special: 200,
};

/**
 * Matches Bestdori's Song Meta defaults exactly: SCORE +100% at SL5, 100%
 * PERFECT, a 30-second gap between songs, with Fever enabled. The upstream
 * `meta[track][difficulty]["7"]` tuple is
 * `[normalBase, normalSkill, feverBase, feverSkill]` for that seven-second
 * skill duration. Keeping this profile explicit avoids fetching the complete
 * skills catalogue just to rediscover the fixed default multiplier.
 */
const BESTDORI_META_PROFILE = {
  perfectMultiplier: 1.1,
  scoreSkillMultiplier: 2,
  downtimeSeconds: 30,
  fever: true,
  skillDuration: "7",
} as const;

// Per-isolate memo of the shared upstream aggregates so the parallel
// songs/bands/song-meta requests on a cold isolate coalesce into one fetch each.
const upstreamMemo = new Map<string, Promise<unknown>>();
const upstreamTextMemo = new Map<string, Promise<string>>();

const configureUpstreamOrigin = (value: string | undefined): void => {
  if (!value?.trim()) {
    upstreamOrigin = DEFAULT_ORIGIN;
    return;
  }
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/") {
    throw new Error("BESTDORI_ORIGIN must be an HTTP(S) origin without credentials or a path");
  }
  upstreamOrigin = url.origin;
};

type Obj = Record<string, unknown>;

const num = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;
const numOr = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;
const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const asObj = (value: unknown): Obj => (value && typeof value === "object" ? (value as Obj) : {});
const timestamp = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};
const timestamps = (value: unknown): Array<number | null> | undefined => {
  const values = asArray(value);
  return values.length ? values.map(timestamp) : undefined;
};
const numericId = (value: unknown): number | undefined => {
  if (typeof value !== "number" && typeof value !== "string") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};
const decodeRoutePart = (value: string): string | null => {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
};
const invalidPathResponse = (): Response =>
  new Response(JSON.stringify({ error: { code: "invalid_path", message: "Invalid URL encoding" } }), {
    status: 400,
    headers: { ...CORS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });

// Bestdori publishes per-server; publication timelines use [jp, en, tw, cn, kr].
// Prefer the server matching the current UI locale, then the Japanese source,
// then the remaining published servers. Some entries exist only on one server
// (for example CN-only songs), so every regional resource lookup must preserve
// this availability fallback instead of blindly replacing the server segment.
const SERVER_NAMES = ["jp", "en", "tw", "cn", "kr"] as const;
type BestdoriServerName = (typeof SERVER_NAMES)[number];
const isBestdoriServer = (value: string): value is (typeof SERVER_NAMES)[number] =>
  SERVER_NAMES.includes(value as (typeof SERVER_NAMES)[number]);

// Map a UI archive locale to its Bestdori asset-server slot in the [jp,en,tw,cn,kr]
// timeline, then build a server preference chain (locale first, jp source next,
// then the rest) — mirroring the app's `archiveLocaleFallbacks`. Used to load a
// story scenario and every regional media resource in the viewer's actual
// language instead of always JP.
const LOCALE_SERVER_INDEX: Record<string, number> = { ja: 0, en: 1, "zh-TW": 2, "zh-CN": 3, ko: 4 };
const localeServerChain = (lang: string | undefined): readonly BestdoriServerName[] => {
  const index = lang ? LOCALE_SERVER_INDEX[lang] : undefined;
  const preferred = index === undefined ? undefined : SERVER_NAMES[index];
  if (!preferred || preferred === "jp") return SERVER_NAMES;
  return [preferred, "jp", ...SERVER_NAMES.filter((server) => server !== preferred && server !== "jp")];
};
// Release chronology is deliberately distinct from asset-language selection:
// the Japanese schedule is canonical when present. Only when JP is missing do
// we consult the current locale, followed by the normal regional fallback.
// Bestdori also uses dates in 2100 as unpublished card placeholders; treating
// those as real would incorrectly pin undated cards above released content.
const validReleaseTimestamp = (value: unknown): number | undefined => {
  const parsed = timestamp(value);
  if (parsed === null) return undefined;
  return new Date(parsed).getUTCFullYear() === 2100 ? undefined : parsed;
};
const releaseTimestampForTimeline = (
  entry: Obj,
  field: "publishedAt" | "releasedAt" | "startAt",
  lang?: string,
): number | undefined => {
  const timeline = asArray(entry[field]);
  const candidates = ["jp" as const, ...localeServerChain(lang)].filter(
    (server, index, values) => values.indexOf(server) === index,
  );
  for (const server of candidates) {
    const index = SERVER_NAMES.indexOf(server);
    const value = index < 0 ? undefined : validReleaseTimestamp(timeline[index]);
    if (value !== undefined) return value;
  }
  return undefined;
};
const serverForTimeline = (
  entry: Obj,
  field: "publishedAt" | "releasedAt" | "startAt" = "publishedAt",
  lang?: string,
): BestdoriServerName => {
  const timeline = asArray(entry[field]);
  const candidates = localeServerChain(lang);
  if (!timeline.length) return candidates[0] ?? "jp";
  for (const server of candidates) {
    const index = SERVER_NAMES.indexOf(server);
    if (index >= 0 && timeline[index] != null) return server;
  }
  return candidates[0] ?? "jp";
};
const serverFor = (entry: Obj, lang?: string): BestdoriServerName => serverForTimeline(entry, "publishedAt", lang);
const serverForCard = (entry: Obj, lang?: string): BestdoriServerName => serverForTimeline(entry, "releasedAt", lang);
// Metadata is useful for ordering, but it is not authoritative: localized
// scenario files can be missing, stale, malformed, or replaced by Bestdori's
// HTML application fallback. Return a complete retry chain so the actual asset
// response decides whether fallback is needed.
const storyServerCandidates = (
  publishedAt: Array<number | null> | undefined,
  lang: string | undefined,
  fallback: string,
  requested?: string,
): BestdoriServerName[] => {
  const published = localeServerChain(lang).filter((server) => {
    const index = SERVER_NAMES.indexOf(server);
    return !publishedAt?.length || (index >= 0 && publishedAt[index] != null);
  });
  return [requested, ...published, fallback, ...localeServerChain(lang)]
    .filter((server): server is BestdoriServerName => Boolean(server && isBestdoriServer(server)))
    .filter((server, index, values) => values.indexOf(server) === index);
};

const fetchUpstream = async (path: string): Promise<unknown> => {
  const origin = upstreamOrigin;
  const key = `${origin}\u0000${path}`;
  const cached = upstreamMemo.get(key);
  if (cached) return cached;
  const promise = (async () => {
    const response = await fetch(`${origin}${path}`, {
      headers: { Accept: "application/json", "User-Agent": "HaneokaBestdoriProxy/1.0 (+https://haneoka.org/)" },
      cf: { cacheTtl: BESTDORI_CACHE_POLICY.upstream.edgeTtlSeconds, cacheEverything: true },
    });
    if (!response.ok) throw new Error(`bestdori ${path} returned HTTP ${response.status}`);
    return (await response.json()) as unknown;
  })().finally(() => {
    upstreamMemo.delete(key);
  });
  upstreamMemo.set(key, promise);
  return promise;
};

const all8 = (): Promise<Record<string, unknown>> =>
  fetchUpstream("/api/songs/all.8.json") as Promise<Record<string, unknown>>;
const allBands = (): Promise<Record<string, unknown>> =>
  fetchUpstream("/api/bands/all.1.json") as Promise<Record<string, unknown>>;
const allSongMeta = (): Promise<Record<string, unknown>> =>
  fetchUpstream("/api/songs/meta/all.5.json") as Promise<Record<string, unknown>>;
const allCards = (): Promise<Record<string, unknown>> =>
  fetchUpstream("/api/cards/all.5.json") as Promise<Record<string, unknown>>;
const allCharactersFull = (): Promise<Record<string, unknown>> =>
  fetchUpstream("/api/characters/all.5.json") as Promise<Record<string, unknown>>;
const allItemTexts = (): Promise<Record<string, unknown>> =>
  fetchUpstream("/api/misc/itemtexts.2.json") as Promise<Record<string, unknown>>;

type BestdoriExplorerTree = Record<string, unknown>;

const mergeBestdoriExplorerTree = (target: BestdoriExplorerTree, source: BestdoriExplorerTree): void => {
  for (const [name, sourceValue] of Object.entries(source)) {
    const targetValue = target[name];
    if (sourceValue && typeof sourceValue === "object" && !Array.isArray(sourceValue)) {
      const next = targetValue && typeof targetValue === "object" && !Array.isArray(targetValue) ? targetValue : {};
      mergeBestdoriExplorerTree(next as BestdoriExplorerTree, sourceValue as BestdoriExplorerTree);
      target[name] = next;
      continue;
    }
    if (typeof sourceValue === "number" && typeof targetValue === "number") {
      target[name] = Math.max(targetValue, sourceValue);
      continue;
    }
    if (targetValue === undefined) target[name] = sourceValue;
  }
};

const bestdoriExplorerPath = (value: string | null): string[] | null => {
  if (!value) return [];
  if (value.length > 768) return null;
  const segments = value
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean);
  if (
    segments.length > 16 ||
    segments.some(
      (segment) =>
        segment === "." ||
        segment === ".." ||
        segment.length > 160 ||
        segment.includes("\\") ||
        [...segment].some((character) => {
          const codePoint = character.codePointAt(0) ?? 0;
          return codePoint < 0x20 || codePoint === 0x7f;
        }),
    )
  )
    return null;
  return segments;
};

const bestdoriExplorerPayload = async (
  lang: string | undefined,
  path: readonly string[],
): Promise<{ server: BestdoriServerName; tree?: BestdoriExplorerTree; files?: string[]; path?: string }> => {
  const candidates = localeServerChain(lang);
  if (!path.length) {
    const responses = await Promise.allSettled(
      candidates.map(async (server) => ({
        server,
        tree: asObj(await fetchUpstream(`/api/explorer/${server}/assets/_info.json`)),
      })),
    );
    const tree: BestdoriExplorerTree = {};
    let firstServer: BestdoriServerName | undefined;
    for (const response of responses) {
      if (response.status !== "fulfilled" || !Object.keys(response.value.tree).length) continue;
      firstServer ??= response.value.server;
      mergeBestdoriExplorerTree(tree, response.value.tree);
    }
    if (firstServer && Object.keys(tree).length) return { server: firstServer, tree };
    throw new Error(`bestdori resource explorer index failed on ${candidates.join(", ")}`);
  }
  const failures: string[] = [];
  for (const server of candidates) {
    const encodedPath = path.map(encodeURIComponent).join("/");
    const upstreamPath = `/api/explorer/${server}/assets/${encodedPath}.json`;
    try {
      const value = await fetchUpstream(upstreamPath);
      if (!Array.isArray(value)) throw new Error("resource bundle is not a file list");
      const files = value
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter((entry) => Boolean(entry) && !entry.includes("/") && entry !== "." && entry !== "..")
        .slice(0, 4096);
      if (!files.length) throw new Error("empty resource bundle");
      return { server, path: path.join("/"), files };
    } catch (error) {
      failures.push(`${server}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`bestdori resource explorer failed on ${candidates.join(", ")}: ${failures.join("; ")}`);
};

interface CachedBody {
  contentType: string;
  body: string;
}

const inFlight = new Map<string, Promise<CachedBody>>();

// `caches.default` keys by URL and persists across Worker deploys for its TTL,
// so a stale transformed list (e.g. before an image-mapping fix) is served long
// after the code changes. Bump this version whenever a response transform or
// cache policy changes: the cache key gains `?_cv=VERSION`, so the new deploy
// misses previous long-lived entries and recomputes without a manual purge.
const BESTDORI_RESPONSE_VERSION = BESTDORI_CATALOG_VERSION;
const cacheKeyUrl = (value: string): string => {
  const source = new URL(value);
  const canonical = new URL(source.pathname, source.origin);
  if (canonical.pathname === "/api/v1/servers/bestdori/live2d") {
    for (const id of [...new Set(source.searchParams.getAll("id"))].sort()) canonical.searchParams.append("id", id);
  }
  for (const key of ["lang", "server"] as const) {
    const parameter = source.searchParams.get(key);
    if (parameter) canonical.searchParams.set(key, parameter);
  }
  canonical.searchParams.set("_cv", BESTDORI_RESPONSE_VERSION);
  canonical.searchParams.set("_source", upstreamOrigin);
  return canonical.toString();
};

const serveCached = async (
  request: Request,
  ctx: ExecutionContext,
  cacheControl: string,
  producer: () => Promise<CachedBody>,
): Promise<Response> => {
  const key = cacheKeyUrl(request.url);
  if (request.method === "GET") {
    const hit = await caches.default.match(new Request(key));
    if (hit) return hit;
  }
  let pending = inFlight.get(key);
  if (!pending) {
    pending = producer().finally(() => {
      if (inFlight.get(key) === pending) inFlight.delete(key);
    });
    inFlight.set(key, pending);
  }
  let result: CachedBody;
  try {
    result = await pending;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return new Response(JSON.stringify({ error: { code: "bestdori_upstream", message } }), {
      status: 502,
      headers: { ...CORS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
    });
  }
  const response = new Response(request.method === "HEAD" ? null : result.body, {
    status: 200,
    headers: { ...CORS, "Content-Type": result.contentType, "Cache-Control": cacheControl },
  });
  if (request.method === "GET") ctx.waitUntil(caches.default.put(new Request(key), response.clone()));
  return response;
};

const jsonBody = (value: unknown): CachedBody => ({
  contentType: "application/json; charset=utf-8",
  body: JSON.stringify(value),
});

// ---- media proxy (Range passthrough) ----

const proxyMedia = async (request: Request, upstreamPath: string, fallbackContentType: string): Promise<Response> => {
  const upstream = new Request(`${upstreamOrigin}${upstreamPath}`, { method: request.method });
  for (const header of ["range", "if-range", "if-none-match"]) {
    const value = request.headers.get(header);
    if (value) upstream.headers.set(header, value);
  }
  let response: Response;
  try {
    response = await fetch(upstream, {
      cf: { cacheTtl: BESTDORI_CACHE_POLICY.media.maxAgeSeconds, cacheEverything: true },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return new Response(JSON.stringify({ error: { code: "bestdori_upstream", message } }), {
      status: 502,
      headers: { ...CORS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
    });
  }
  // Bestdori's SPA responds with HTTP 200 + HTML for an unknown asset path.
  // Never relay or cache that document as an image/audio/video resource.
  if (response.headers.get("Content-Type")?.includes("text/html")) {
    return new Response(JSON.stringify({ error: { code: "bestdori_asset_missing", path: upstreamPath } }), {
      status: 404,
      headers: { ...CORS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
    });
  }
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(CORS)) headers.set(key, value);
  headers.set("Cache-Control", response.ok ? MEDIA_CACHE_CONTROL : "no-store");
  if (!headers.get("Content-Type")) headers.set("Content-Type", fallbackContentType);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
};

const proxyMediaWithServerFallback = async (
  request: Request,
  servers: readonly BestdoriServerName[],
  upstreamPath: (server: BestdoriServerName) => string,
  fallbackContentType: string,
): Promise<Response> => {
  let lastResponse: Response | undefined;
  for (const server of servers) {
    const response = await proxyMedia(request, upstreamPath(server), fallbackContentType);
    if (response.ok || response.status !== 404) return response;
    lastResponse = response;
  }
  return (
    lastResponse ||
    new Response(JSON.stringify({ error: { code: "bestdori_asset_missing" } }), {
      status: 404,
      headers: { ...CORS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
    })
  );
};

// ---- asset URL helpers (mirror bestdori's asset layout) ----

const jacketUpstream = (server: string, pkg: string, image: string): string =>
  `/assets/${server}/musicjacket/musicjacket${pkg}_rip/assets-star-forassetbundle-startapp-musicjacket-musicjacket${pkg}-${image}-jacket.png`;

const jacketThumbUpstream = (server: string, pkg: string, image: string): string =>
  `/assets/${server}/musicjacket/musicjacket${pkg}_rip/assets-star-forassetbundle-startapp-musicjacket-musicjacket${pkg}-${image}-thumb.png`;

const soundUpstream = (server: string, bgmNum: string): string =>
  `/assets/${server}/sound/bgm${bgmNum}_rip/bgm${bgmNum}.mp3`;

const mvUpstream = (server: string, assetBundleName: string): string =>
  `/assets/${server}/movie/mv/${assetBundleName}_hq_rip/${assetBundleName}_hq.mp4`;

const jacketPackageFor = (musicId: number): string => {
  const index = Math.ceil(musicId / 10) * 10;
  return String(index).padStart(2, "0");
};
const bgmNumberFor = (musicId: number): string => String(musicId).padStart(3, "0");
const pad3 = (value: number | string): string => String(value).padStart(3, "0");

/**
 * These are the only Bestdori band-logo bundles present in the public asset
 * index. Do not manufacture URLs for collaboration/guest `bandId`s: Bestdori
 * answers those missing paths with its HTML app shell and browsers would cache
 * a broken image. The core bands additionally have a dedicated round SVG at
 * `/res/icon/band_{id}.svg`; `logoL` is the full logo used next to song titles.
 */
const BESTDORI_BAND_LOGOS: Record<number, { availableServers: readonly BestdoriServerName[]; roundIcon: boolean }> = {
  1: { availableServers: SERVER_NAMES, roundIcon: true },
  2: { availableServers: SERVER_NAMES, roundIcon: true },
  3: { availableServers: SERVER_NAMES, roundIcon: true },
  4: { availableServers: SERVER_NAMES, roundIcon: true },
  5: { availableServers: SERVER_NAMES, roundIcon: true },
  // Glitter*Green only has a compact logoL asset (84×82) in Bestdori.
  6: { availableServers: ["cn"], roundIcon: false },
  18: { availableServers: SERVER_NAMES, roundIcon: true },
  21: { availableServers: SERVER_NAMES, roundIcon: true },
  // The KR mirror does not publish MyGO!!!!!'s logoL bundle.
  45: { availableServers: ["jp", "en", "tw", "cn"], roundIcon: true },
};

// Bestdori assigns numeric band IDs to formal bands, solo singers, guests,
// and arbitrary collaboration credits alike. Keep source identity separate
// from presentation order: these known formal IDs (plus any band referenced
// by the character catalogue) are the stable first group in song filters.
const BESTDORI_FORMAL_BAND_IDS = new Set([1, 2, 3, 4, 5, 6, 18, 21, 45, 46]);

// ---- story / scenario support ----
//
// Scenario `.asset` files and Live2D `buildData.asset` are served by bestdori
// as JSON (often `application/octet-stream`), so they need a text-returning
// fetcher instead of the JSON-only `fetchUpstream`. All produced asset URLs
// are rewritten to our generic raw proxy below so they pass the story
// runtime canonical-URL gate and bypass bestdori's closed CORS.

const BESTDORI_RAW_PROXY = "/api/v1/bestdori/raw";
/** Rewrite a raw bestdori path (`/assets/jp/...` or `/res/...`) to our proxy URL. */
const proxify = (rawBestdoriPath: string): string => {
  const path = rawBestdoriPath.startsWith("/") ? rawBestdoriPath : `/${rawBestdoriPath}`;
  return `${BESTDORI_RAW_PROXY}${path}`;
};

const bandVisuals = (bandId: number, lang?: string): Obj => {
  const source = BESTDORI_BAND_LOGOS[bandId];
  if (!source) return {};
  const server =
    localeServerChain(lang).find((candidate) => source.availableServers.includes(candidate)) ??
    source.availableServers[0];
  if (!server) return {};
  const directory = `/assets/${server}/band/logo/${pad3(bandId)}_rip`;
  return {
    icon: source.roundIcon ? proxify(`/res/icon/band_${bandId}.svg`) : proxify(`${directory}/logoL.png`),
    logo: proxify(`${directory}/logoL.png`),
  };
};

const fetchUpstreamText = async (path: string): Promise<string> => {
  const origin = upstreamOrigin;
  const key = `${origin}\u0000${path}`;
  const cached = upstreamTextMemo.get(key);
  if (cached) return cached;
  const promise = (async () => {
    const response = await fetch(`${origin}${path}`, {
      headers: { "User-Agent": "HaneokaBestdoriProxy/1.0 (+https://haneoka.org/)" },
      cf: { cacheTtl: BESTDORI_CACHE_POLICY.upstream.edgeTtlSeconds, cacheEverything: true },
    });
    if (!response.ok) throw new Error(`bestdori ${path} returned HTTP ${response.status}`);
    if (response.headers.get("Content-Type")?.includes("text/html")) {
      throw new Error(`bestdori ${path} returned an HTML fallback instead of an asset`);
    }
    return response.text();
  })().finally(() => {
    upstreamTextMemo.delete(key);
  });
  upstreamTextMemo.set(key, promise);
  return promise;
};

const parseUpstreamAssetJson = (path: string, text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`bestdori ${path} returned invalid JSON asset data`);
  }
};

const fetchUpstreamJsonCached = (path: string): Promise<unknown> => fetchUpstream(path);

const allEvents = (): Promise<Record<string, unknown>> =>
  fetchUpstreamJsonCached("/api/events/all.5.json") as Promise<Record<string, unknown>>;
const allEventStories = (): Promise<Record<string, unknown>> =>
  fetchUpstreamJsonCached("/api/events/all.stories.json") as Promise<Record<string, unknown>>;
const mainStoriesIndex = (): Promise<Record<string, unknown>> =>
  fetchUpstreamJsonCached("/api/misc/mainstories.5.json") as Promise<Record<string, unknown>>;
const bandStoriesIndex = (): Promise<Record<string, unknown>> =>
  fetchUpstreamJsonCached("/api/misc/bandstories.5.json") as Promise<Record<string, unknown>>;
const afterLiveIndex = (): Promise<Record<string, unknown>> =>
  fetchUpstreamJsonCached("/api/misc/afterlivetalks.5.json") as Promise<Record<string, unknown>>;

// ---- characters / cards (for filters + card-story selection page) ----
const transformCharacters = (raw: Record<string, unknown>): Obj => {
  const out: Obj = {};
  for (const [key, value] of Object.entries(raw)) {
    const id = Number(key);
    if (!Number.isFinite(id)) continue;
    const entry = asObj(value);
    out[key] = {
      characterId: id,
      characterName: entry.characterName ?? null,
      bandId: num(entry.bandId),
      colorCode: entry.colorCode ?? null,
      ...(hasBestdoriCharacterIcon(id) ? { faceImage: proxify(`/res/icon/chara_icon_${id}.png`) } : {}),
    };
  }
  return out;
};

const transformCards = (raw: Record<string, unknown>, lang?: string): Obj => {
  const out: Obj = {};
  for (const [key, value] of Object.entries(raw)) {
    const id = Number(key);
    if (!Number.isFinite(id)) continue;
    const entry = asObj(value);
    const resourceSetName = String(entry.resourceSetName || "");
    const episodes = Array.isArray(entry.episodes)
      ? asArray(entry.episodes).map((episode) => asObj(episode))
      : asArray(asObj(entry.episodes).entries).map((episode) => asObj(episode));
    const hasStory =
      episodes.some((episode) => Boolean(episode.scenarioId)) || asArray(asObj(entry.stat).episodes).length > 0;
    const assetServer = serverForCard(entry, lang);
    const normalImage = resourceSetName
      ? proxify(`/assets/${assetServer}/characters/resourceset/${resourceSetName}_rip/card_normal.png`)
      : null;
    const hasTraining = Object.keys(asObj(asObj(entry.stat).training)).length > 0;
    const trainedImage =
      resourceSetName && hasTraining
        ? proxify(`/assets/${assetServer}/characters/resourceset/${resourceSetName}_rip/card_after_training.png`)
        : null;
    out[key] = {
      cardId: id,
      characterId: num(entry.characterId),
      prefix: entry.prefix ?? null,
      rarity: num(entry.rarity),
      attribute: entry.attribute ?? entry.attr ?? null,
      cardType: entry.type ?? entry.cardType ?? null,
      releasedAt: timestamps(entry.releasedAt),
      releaseAt: releaseTimestampForTimeline(entry, "releasedAt", lang) ?? null,
      hasStory,
      resourceSetName: resourceSetName || null,
      // Keep the legacy singular field for existing clients while exposing
      // both authored variants to the card-story catalog. Some special cards
      // publish only the trained image; the UI independently retries each URL
      // across locale servers and hides an exhausted variant.
      cardImage: normalImage,
      cardImages: {
        normal: normalImage,
        ...(trainedImage ? { trained: trainedImage } : {}),
      },
      episodes: episodes
        .filter((ep) => ep.scenarioId)
        .map((ep) => ({
          episodeId: ep.episodeId ?? null,
          scenarioId: String(ep.scenarioId),
          resourceSetName: ep.resourceSetName ?? entry.resourceSetName ?? null,
          title: ep.title ?? null,
        })),
    };
  }
  return out;
};

// ---- story collections ----------------------------------------------------
//
// Each collection is deliberately a bare record, just like the primary
// catalog's `/stories` collection. That lets the community routes reuse
// `useCatalogCollection` and the normal StoryCatalogList/StoryPlaybackColumn
// rather than introduce a second `kind` query API and a second UI stack.
interface StoryListItem {
  /** Canonical ID accepted by GET /stories/{storyId}. */
  storyId: string;
  storyKey: string;
  scenarioId?: string;
  episodeNumber?: number;
  chapterId?: number;
  chapterKey?: string;
  chapterName?: unknown;
  storySort?: number;
  /** Chapter-level sort (band: within-band `chapterNumber`; event: eventId). */
  chapterSort?: number;
  title: unknown;
  description?: unknown;
  caption?: unknown;
  publishedAt?: Array<number | null>;
  /** Canonical JP-first date used for chronology and display. */
  releaseAt?: number;
  bandId?: number;
  eventId?: number;
  eventName?: unknown;
  /** Characters in authored speaking order (used by after-live avatars). */
  characterIds?: number[];
  /** Same-origin, cacheable Bestdori asset URL when a source has one. */
  thumbnail?: string;
  image?: string;
  /** Per-episode art (events): `EventStoryScreenImage{id}_{ep}.png`. */
  episodeImage?: string;
}

const storyItemRecord = (stories: StoryListItem[]): Obj =>
  Object.fromEntries(stories.map((story) => [story.storyId, story]));
const whenDefined = <Key extends string, Value>(key: Key, value: Value | undefined): { [K in Key]?: Value } =>
  value === undefined ? {} : ({ [key]: value } as { [K in Key]?: Value });

const eventThumbnail = (event: Obj, lang?: string): string | undefined => {
  const assetBundleName = String(event.assetBundleName || "");
  if (!assetBundleName) return undefined;
  return proxify(`/assets/${serverForTimeline(event, "startAt", lang)}/event/${assetBundleName}/images_rip/logo.png`);
};

// Event art: the wide memorial banner (`banner_memorial_event{id}.png`) drives
// the chapter rail; `logo.png` is the stage's corner title mark (`thumbnail`);
// per-episode `EventStoryScreenImage{id}_{ep}.png` drives the filmstrip and the
// stage's large film frame (`episodeImage`).
const eventMemorialBanner = (eventId: number, event: Obj, lang?: string): string =>
  proxify(
    `/assets/${serverForTimeline(event, "startAt", lang)}/story/banner/memorial_rip/banner_memorial_event${pad3(eventId)}.png`,
  );

const eventScreenImage = (eventId: number, episode: number, event: Obj, lang?: string): string =>
  proxify(
    `/assets/${serverForTimeline(event, "startAt", lang)}/story/bg/event/eventstory${eventId}_${episode}_rip/EventStoryScreenImage${eventId}_${episode}.png`,
  );

const storyListFromEvent = (eventId: number, rawStories: Obj, event: Obj, lang?: string): StoryListItem[] => {
  const eventName = event.eventName ?? rawStories.eventName ?? "";
  const publishedAt = timestamps(event.startAt);
  const releaseAt = releaseTimestampForTimeline(event, "startAt", lang);
  const logo = eventThumbnail(event, lang);
  const memorial = eventMemorialBanner(eventId, event, lang);
  const characterIds = asArray(event.characters)
    .map((value) => num(asObj(value).characterId))
    .filter((value): value is number => value !== undefined)
    .filter((value, index, values) => values.indexOf(value) === index);
  return asArray(rawStories.stories).map((raw, index) => {
    const entry = asObj(raw);
    const episodeNumber = index + 1;
    const storyId = `event.${eventId}-${episodeNumber}`;
    return {
      storyId,
      storyKey: storyId,
      scenarioId: String(entry.scenarioId || `event${eventId}-${pad3(episodeNumber)}`),
      episodeNumber,
      chapterId: eventId,
      chapterKey: `bestdori:event:${eventId}`,
      chapterName: eventName,
      ...whenDefined("chapterSort", releaseAt),
      storySort: eventId * 100 + episodeNumber,
      title: entry.title ?? "",
      ...whenDefined("description", entry.synopsis),
      ...whenDefined("caption", entry.caption),
      ...whenDefined("publishedAt", publishedAt),
      ...whenDefined("releaseAt", releaseAt),
      eventId,
      eventName,
      ...(characterIds.length ? { characterIds } : {}),
      image: memorial,
      episodeImage: eventScreenImage(eventId, index, event, lang),
      ...(logo ? { thumbnail: logo } : {}),
    };
  });
};

// Band art uses the 6-digit `{bandId:03d}{chapterNumber:03d}` resource set
// (the trailing half is the within-band chapter: Story 0→000, 1→001, 2→002):
// the memorial banner (`banner_memorial_band{id}{ch}.png`) drives the chapter
// rail; the logo (`story/band/{id}{ch}/screen_rip/logo.png`) is the stage's
// corner title mark. Per-episode art is `BandStoryScreenImage{N}.png` under
// `bandstory{N}_rip/`, where N is bestdori's global story key.
const bandMemorialBanner = (server: BestdoriServerName, bandId: number, chapterNumber: number): string =>
  proxify(`/assets/${server}/story/banner/band_rip/banner_memorial_band${pad3(bandId)}${pad3(chapterNumber)}.png`);
const bandLogo = (server: BestdoriServerName, bandId: number, chapterNumber: number): string =>
  proxify(`/assets/${server}/story/band/${pad3(bandId)}${pad3(chapterNumber)}/screen_rip/logo.png`);
const bandScreenImage = (server: BestdoriServerName, episodeKey: number): string =>
  proxify(`/assets/${server}/story/bg/band/bandstory${episodeKey}_rip/BandStoryScreenImage${episodeKey}.png`);

const storyListFromBand = (raw: Record<string, unknown>, lang?: string): StoryListItem[] => {
  const out: StoryListItem[] = [];
  // bestdori duplicates each original band's "Story 1" under two chapter keys
  // (e.g. ch1≡ch8 for Poppin'Party) with identical scenarioIds; the duplicate
  // copies also omit `chapterNumber`. Dedup by the chapter's first scenarioId
  // so the canonical first occurrence wins and every survivor has a chapterNumber.
  const seenChapterScenario = new Set<string>();
  for (const [chapterKey, bandValues] of Object.entries(raw)) {
    const chapter = asObj(bandValues);
    const bandId = num(chapter.bandId);
    const chapterNumber = num(chapter.chapterNumber);
    const chapterId = numericId(chapterKey);
    const chapterName = chapter.subTitle ?? chapter.mainTitle ?? "";
    const chapterPublishedAt = timestamps(chapter.publishedAt);
    const chapterServer = serverFor(chapter, lang);
    const stories = Object.entries(asObj(chapter.stories));
    const firstScenario = String(asObj(stories[0]?.[1]).scenarioId || "");
    if (firstScenario) {
      if (seenChapterScenario.has(firstScenario)) continue;
      seenChapterScenario.add(firstScenario);
    }
    // Sort chapters by band, then authored chapter number (Story 0→1→2→3).
    const chapterSort = bandId === undefined ? undefined : bandId * 1000 + (chapterNumber ?? 0);
    stories.forEach(([episodeKey, epRaw], index) => {
      const ep = asObj(epRaw);
      const scenarioId = String(ep.scenarioId || "");
      if (!scenarioId) return;
      // bestdori's episode key is a GLOBAL story index (the screen-image N),
      // not a per-chapter episode number — display the within-chapter position
      // and use the global key only for the screen-image URL.
      const episodeNumber = index + 1;
      const screenKey = numericId(episodeKey);
      const episodeServer = asArray(ep.publishedAt).some((value) => value != null)
        ? serverFor(ep, lang)
        : chapterServer;
      const storyId = `band.${scenarioId}`;
      out.push({
        storyId,
        storyKey: storyId,
        scenarioId,
        episodeNumber,
        ...whenDefined("chapterId", chapterId),
        chapterKey: `bestdori:band:${chapterKey}`,
        chapterName,
        ...whenDefined("chapterSort", chapterSort),
        ...whenDefined("storySort", chapterId === undefined ? undefined : chapterId * 1000 + episodeNumber),
        title: ep.title ?? "",
        ...whenDefined("description", ep.synopsis),
        ...whenDefined("caption", ep.caption),
        ...whenDefined("publishedAt", timestamps(ep.publishedAt) ?? chapterPublishedAt),
        ...whenDefined("bandId", bandId),
        ...(bandId !== undefined && chapterNumber !== undefined
          ? {
              image: bandMemorialBanner(chapterServer, bandId, chapterNumber),
              thumbnail: bandLogo(chapterServer, bandId, chapterNumber),
            }
          : {}),
        ...(screenKey !== undefined ? { episodeImage: bandScreenImage(episodeServer, screenKey) } : {}),
      });
    });
  }
  return out;
};

// Main-story art uses per-episode `MainStoryScreenImage{id}.png` under
// `mainstory{id}_rip/`. The main story has no per-season banner asset, so each
// season chapter reuses its first episode's localized screen image on the rail.
const mainScreenImage = (server: BestdoriServerName, mainId: number): string =>
  proxify(`/assets/${server}/story/bg/main/mainstory${mainId}_rip/MainStoryScreenImage${mainId}.png`);
const mainSeasonName = (season: number): unknown => [
  `シーズン${season}`,
  `Season ${season}`,
  `第${season}季`,
  `第${season}季`,
  `시즌 ${season}`,
];
// A season begins where the caption resets to "Opening 1" (jp "オープニング１").
const isMainSeasonStart = (entry: Obj): boolean => {
  const caption = entry.caption;
  if (!Array.isArray(caption)) return false;
  return caption.some((slot) => typeof slot === "string" && /^(?:Opening\s*1|オープニング１)$/.test(slot.trim()));
};

const storyListFromMain = (raw: Record<string, unknown>, lang?: string): StoryListItem[] => {
  const ids = Object.keys(raw)
    .map(Number)
    .filter((id) => Number.isFinite(id))
    .sort((left, right) => left - right);
  // Bestdori ships 3 main-story seasons (ids 1–25, 26–48, 49–73 at time of
  // writing). Split by the "Opening 1" caption resets so it tracks future
  // episodes instead of hardcoding id ranges.
  const seasonStarts = ids.filter((id) => isMainSeasonStart(asObj(raw[String(id)])));
  const seasonOf = (id: number): number => {
    let season = 0;
    for (const start of seasonStarts) {
      if (id >= start) season += 1;
      else break;
    }
    return Math.max(1, season);
  };
  const seasonFirstId = new Map<number, number>();
  const indexInSeason = new Map<number, number>();
  for (const id of ids) {
    const season = seasonOf(id);
    if (!seasonFirstId.has(season)) seasonFirstId.set(season, id);
    indexInSeason.set(id, id - (seasonFirstId.get(season) ?? id) + 1);
  }
  return ids.flatMap((id) => {
    const entry = asObj(raw[String(id)]);
    const season = seasonOf(id);
    const firstId = seasonFirstId.get(season) ?? id;
    const firstEntry = asObj(raw[String(firstId)]);
    const storyId = `main.${id}`;
    return [
      {
        storyId,
        storyKey: storyId,
        scenarioId: String(entry.scenarioId || `main${pad3(id)}`),
        ...whenDefined("episodeNumber", indexInSeason.get(id)),
        chapterId: season,
        chapterKey: `bestdori:main:season${season}`,
        chapterName: mainSeasonName(season),
        chapterSort: season,
        storySort: id,
        title: entry.title ?? "",
        ...whenDefined("description", entry.synopsis),
        ...whenDefined("caption", entry.caption),
        ...whenDefined("publishedAt", timestamps(entry.publishedAt)),
        image: mainScreenImage(serverFor(firstEntry, lang), firstId),
        episodeImage: mainScreenImage(serverFor(entry, lang), id),
      },
    ];
  });
};

const normalizeAfterLiveCharacterName = (value: string): string =>
  value.normalize("NFKC").replace(/\s+/gu, "").replaceAll("ヴ", "ブ");

const afterLiveCharacterAliases = (characters: Record<string, unknown>): Map<string, number> => {
  const aliases = new Map<string, number>();
  for (const [key, value] of Object.entries(characters)) {
    const characterId = numericId(key);
    if (characterId === undefined) continue;
    const entry = asObj(value);
    // Bestdori models Misaki's uncostumed form as the auxiliary character 601,
    // while story playback and the public round icon use canonical character 15.
    const canonicalId = characterId === 601 ? 15 : characterId;
    for (const field of ["characterName", "firstName", "nickname"] as const) {
      const japaneseName = asArray(entry[field])[0];
      if (typeof japaneseName !== "string" || !japaneseName.trim()) continue;
      aliases.set(normalizeAfterLiveCharacterName(japaneseName), canonicalId);
    }
  }
  return aliases;
};

const afterLiveCharacterIds = (entry: Obj, aliases: ReadonlyMap<string, number>): number[] => {
  const japaneseDescription = asArray(entry.description)[0];
  if (typeof japaneseDescription !== "string") return [];
  const cast = normalizeAfterLiveCharacterName(japaneseDescription).replace(
    /の(?:大成功(?:位)?|成功|失敗)会話\d*$/u,
    "",
  );
  const ids = cast
    .split(/と|×/u)
    .map((name) => aliases.get(name))
    .filter((id): id is number => id !== undefined);
  return ids.filter((id, index) => ids.indexOf(id) === index);
};

const storyListFromAfterLive = (raw: Record<string, unknown>, characters: Record<string, unknown>): StoryListItem[] => {
  const aliases = afterLiveCharacterAliases(characters);
  return Object.entries(raw).flatMap(([id, value]) => {
    const entry = asObj(value);
    const episodeNumber = numericId(id);
    if (episodeNumber === undefined) return [];
    const storyId = `afterlive.${id}`;
    return [
      {
        storyId,
        storyKey: storyId,
        scenarioId: String(entry.scenarioId || `afterLive${pad3(episodeNumber)}`),
        episodeNumber,
        chapterKey: "bestdori:afterlive",
        storySort: episodeNumber,
        title: entry.description ?? "",
        characterIds: afterLiveCharacterIds(entry, aliases),
      },
    ];
  });
};

const buildStoryCollection = async (section: "event" | "band" | "main" | "afterlive", lang?: string): Promise<Obj> => {
  if (section === "event") {
    const [stories, events] = await Promise.all([allEventStories(), allEvents()]);
    return storyItemRecord(
      Object.entries(stories).flatMap(([eventId, value]) => {
        const id = numericId(eventId);
        return id === undefined ? [] : storyListFromEvent(id, asObj(value), asObj(events[eventId]), lang);
      }),
    );
  }
  if (section === "band") return storyItemRecord(storyListFromBand(await bandStoriesIndex(), lang));
  if (section === "main") return storyItemRecord(storyListFromMain(await mainStoriesIndex(), lang));
  const [stories, characters] = await Promise.all([afterLiveIndex(), allCharactersFull()]);
  return storyItemRecord(storyListFromAfterLive(stories, characters));
};

// ---- single story → AdvStory ----
interface ResolvedScenario {
  scenarioPath: string;
  voiceBundle: string;
  storyId: string;
  /** Server that actually publishes this scenario's binary assets. */
  server: string;
  /** Per-server publication timeline [jp, en, tw, cn, kr] (null = not published). */
  publishedAt?: Array<number | null>;
}
const resolveEventScenario = async (eventId: number, chapter: number, lang?: string): Promise<ResolvedScenario> => {
  // The collection's two compact indexes contain both the exact scenario ID
  // and publication timeline, avoiding a third per-click `/events/{id}` fetch.
  const [events, eventStories] = await Promise.all([allEvents(), allEventStories()]);
  const event = asObj(events[String(eventId)]);
  const story = asArray(asObj(eventStories[String(eventId)]).stories)[chapter - 1];
  const scenarioId = String(asObj(story).scenarioId || "");
  if (!scenarioId) throw new Error(`unknown bestdori event story: ${eventId}-${chapter}`);
  const storyId = `event.${eventId}-${chapter}`;
  // ~15 events replay a band-story episode; their `scenarioId` ("event##-##")
  // has no eventstory asset on any server, and the real scenario lives at the
  // band-story path referenced by `bandStoryId` (a global band-story episode key).
  const bandStoryId = numericId(asObj(story).bandStoryId);
  if (bandStoryId !== undefined) {
    const bandEpisode = await resolveBandStoryEpisode(String(bandStoryId), lang);
    if (bandEpisode) return { ...bandEpisode, storyId };
  }
  return {
    server: serverForTimeline(event, "startAt", lang),
    publishedAt: timestamps(event.startAt) ?? [],
    storyId,
    scenarioPath: `/scenario/eventstory/event${eventId}_rip/Scenario${scenarioId}.asset`,
    voiceBundle: `sound/voice/scenario/eventstory${eventId}_${chapter - 1}_rip/`,
  };
};
const resolveBandScenario = async (scenarioId: string, lang?: string): Promise<ResolvedScenario> => {
  const index = await bandStoriesIndex();
  let bandId = "";
  let voiceBundle = "";
  let server: BestdoriServerName = localeServerChain(lang)[0] ?? "jp";
  let publishedAt: Array<number | null> = [];
  for (const bandValues of Object.values(index)) {
    const chapter = asObj(bandValues);
    const stories = asObj(chapter.stories);
    const entry = asObj(
      stories[Object.keys(stories).find((k) => String(asObj(stories[k]).scenarioId) === scenarioId) || ""],
    );
    if (entry.scenarioId) {
      bandId = pad3(Number(chapter.bandId) || 0);
      voiceBundle = `sound/voice/scenario/${entry.voiceAssetBundleName}_rip/`;
      const useEntryTimeline = asArray(entry.publishedAt).some((value) => value != null);
      server = useEntryTimeline ? serverFor(entry, lang) : serverFor(chapter, lang);
      publishedAt = (useEntryTimeline ? timestamps(entry.publishedAt) : timestamps(chapter.publishedAt)) ?? [];
      break;
    }
  }
  if (!bandId || !voiceBundle) throw new Error(`unknown bestdori band story: ${scenarioId}`);
  return {
    server,
    publishedAt,
    storyId: `band.${scenarioId}`,
    scenarioPath: `/scenario/band/${bandId}_rip/Scenario${scenarioId}.asset`,
    voiceBundle,
  };
};
/** Resolve a band-story episode by its global episode key (1–493). Event stories
 *  with a `bandStoryId` field replay one of these, so the event's `scenarioId`
 *  is unused and the real scenario/voice bundle come from this lookup. */
const resolveBandStoryEpisode = async (episodeKey: string, lang?: string): Promise<ResolvedScenario | null> => {
  const index = await bandStoriesIndex();
  for (const bandValues of Object.values(index)) {
    const chapter = asObj(bandValues);
    const entry = asObj(asObj(chapter.stories)[String(episodeKey)] || asObj(chapter.stories)[episodeKey]);
    if (!entry.scenarioId) continue;
    const bandId = pad3(Number(chapter.bandId) || 0);
    const useEntryTimeline = asArray(entry.publishedAt).some((value) => value != null);
    return {
      server: useEntryTimeline ? serverFor(entry, lang) : serverFor(chapter, lang),
      publishedAt: (useEntryTimeline ? timestamps(entry.publishedAt) : timestamps(chapter.publishedAt)) ?? [],
      storyId: `band.${entry.scenarioId}`,
      scenarioPath: `/scenario/band/${bandId}_rip/Scenario${entry.scenarioId}.asset`,
      voiceBundle: `sound/voice/scenario/${entry.voiceAssetBundleName}_rip/`,
    };
  }
  return null;
};
const resolveMainScenario = async (mainId: string, lang?: string): Promise<ResolvedScenario> => {
  const entry = asObj((await mainStoriesIndex())[mainId]);
  const scenarioId = String(entry.scenarioId || "");
  if (!scenarioId) throw new Error(`unknown bestdori main story: ${mainId}`);
  return {
    server: serverFor(entry, lang),
    publishedAt: timestamps(entry.publishedAt) ?? [],
    storyId: `main.${mainId}`,
    scenarioPath: `/scenario/main_rip/Scenario${scenarioId}.asset`,
    voiceBundle: `sound/voice/scenario/mainstory${mainId}_rip/`,
  };
};
const resolveCardScenario = async (
  resourceSetName: string,
  scenarioId: string,
  lang?: string,
): Promise<ResolvedScenario> => {
  // Card story IDs intentionally stay stable (`card.{resourceSet}.{scenario}`)
  // and therefore do not contain a server. Look it up from the compact card
  // index: CN-only cards such as 10027 (`bili_res026001`) otherwise resolve to
  // Bestdori's JP HTML fallback instead of their real scenario asset.
  const card = Object.values(await allCards())
    .map((value) => asObj(value))
    .find((entry) => String(entry.resourceSetName || "") === resourceSetName);
  return {
    server: card ? serverForCard(card, lang) : (localeServerChain(lang)[0] ?? "jp"),
    publishedAt: card ? (timestamps(card.releasedAt) ?? []) : [],
    storyId: `card.${resourceSetName}.${scenarioId}`,
    scenarioPath: `/characters/resourceset/${resourceSetName}_rip/Scenario${scenarioId}.asset`,
    voiceBundle: `sound/voice/scenario/resourceset/${resourceSetName}_rip/`,
  };
};
const resolveAfterLiveScenario = async (id: string, lang?: string): Promise<ResolvedScenario> => {
  const numericId = Number(id);
  if (!Number.isInteger(numericId) || numericId < 1) throw new Error(`invalid bestdori after-live story: ${id}`);
  const entry = asObj((await afterLiveIndex())[id]);
  const scenarioId = String(entry.scenarioId || "");
  if (!scenarioId) throw new Error(`unknown bestdori after-live story: ${id}`);
  return {
    server: serverFor(entry, lang),
    publishedAt: timestamps(entry.publishedAt) ?? [],
    storyId: `afterlive.${id}`,
    scenarioPath: `/scenario/afterlivetalk/group${Math.floor(numericId / 256)}_rip/Scenario${scenarioId}.asset`,
    voiceBundle: `sound/voice/scenario/afterlivetalk/group${Math.floor(numericId / 100)}_rip/`,
  };
};

// The scenario format sometimes uses a season alias instead of a concrete
// Live2D bundle (for example `casual_season1`). Bestdori's own viewer resolves
// those through characters/all.5's seasonCostumeListMap before requesting
// buildData.asset. Preserve that lookup, but load the 509 KB index only when a
// story actually contains one of these aliases.
const SEASON_COSTUME_ALIAS = /^(casual|school)_season(\d*)$/;
interface SeasonCostumeAlias {
  costumeType: "CASUAL" | "UNIFORM";
  seasonType: string;
}
const parseSeasonCostumeAlias = (costumeType: string): SeasonCostumeAlias | null => {
  const match = SEASON_COSTUME_ALIAS.exec(costumeType);
  if (!match) return null;
  return {
    costumeType: match[1] === "casual" ? "CASUAL" : "UNIFORM",
    seasonType: `season_${match[2] || "1"}`,
  };
};
const costumeLookupKey = (characterId: number, costumeType: string): string => `${characterId}\u0000${costumeType}`;

const resolveSeasonCostumeAliases = async (
  scenario: unknown,
): Promise<((characterId: number | undefined, costumeType: string) => string) | undefined> => {
  const base = asObj(asObj(scenario).Base);
  const requests = new Map<string, { characterId: number; costumeType: string; desired: SeasonCostumeAlias }>();
  for (const raw of [...asArray(base.appearCharacters), ...asArray(base.layoutData)]) {
    const entry = asObj(raw);
    const characterId = numericId(entry.characterId);
    const costumeType = typeof entry.costumeType === "string" ? entry.costumeType : "";
    const desired = parseSeasonCostumeAlias(costumeType);
    if (characterId === undefined || !desired) continue;
    requests.set(costumeLookupKey(characterId, costumeType), { characterId, costumeType, desired });
  }
  if (!requests.size) return undefined;

  let characters: Record<string, unknown>;
  try {
    characters = await allCharactersFull();
  } catch {
    // Aliases are an optional visual enhancement. Keep the readable story
    // available if Bestdori's large character index is temporarily unavailable.
    return undefined;
  }

  const resolved = new Map<string, string>();
  for (const request of requests.values()) {
    const character = asObj(characters[String(request.characterId)]);
    const groups = Object.values(asObj(asObj(character.seasonCostumeListMap).entries));
    const choices = groups.flatMap((group) => asArray(asObj(group).entries).map((entry) => asObj(entry)));
    let best: Obj | undefined;
    let bestScore = -1;
    for (const choice of choices) {
      const assetBundleName = typeof choice.live2dAssetBundleName === "string" ? choice.live2dAssetBundleName : "";
      if (!assetBundleName) continue;
      // This is the same priority Bestdori's ToolStoryViewer uses. The worker
      // has no season selector, so it reproduces that viewer's default
      // `season=0`, which means `basicSeasonId===1`.
      const score =
        (choice.costumeType === request.desired.costumeType ? 100 : 0) +
        (choice.seasonType === request.desired.seasonType ? 10 : 0) +
        (numericId(choice.basicSeasonId) === 1 ? 1 : 0);
      if (score > bestScore) {
        best = choice;
        bestScore = score;
      }
    }
    const assetBundleName = typeof best?.live2dAssetBundleName === "string" ? best.live2dAssetBundleName : "";
    if (assetBundleName) resolved.set(costumeLookupKey(request.characterId, request.costumeType), assetBundleName);
  }

  return (characterId, costumeType) => {
    if (characterId === undefined || !parseSeasonCostumeAlias(costumeType)) return costumeType;
    return resolved.get(costumeLookupKey(characterId, costumeType)) || costumeType;
  };
};

const storyDetail = async (storyId: string, requestedServer?: string, lang?: string): Promise<CachedBody> => {
  const dot = storyId.indexOf(".");
  const kind = dot > 0 ? storyId.slice(0, dot) : "";
  const rest = dot > 0 ? storyId.slice(dot + 1) : "";
  let resolved: ResolvedScenario;
  if (kind === "event") {
    const [eid, ch] = rest.split("-");
    resolved = await resolveEventScenario(Number(eid), Number(ch), lang);
  } else if (kind === "band") {
    resolved = await resolveBandScenario(rest, lang);
  } else if (kind === "main") {
    resolved = await resolveMainScenario(rest, lang);
  } else if (kind === "card") {
    const [res, ...scenarioParts] = rest.split(".");
    resolved = await resolveCardScenario(res || "", scenarioParts.join("."), lang);
  } else if (kind === "afterlive") {
    resolved = await resolveAfterLiveScenario(rest, lang);
  } else {
    throw new Error(`unknown bestdori story kind: ${kind}`);
  }
  const candidates = storyServerCandidates(resolved.publishedAt, lang, resolved.server, requestedServer);
  const failures: string[] = [];
  for (const server of candidates) {
    // Normalize legacy leading slashes: Bestdori's CN host treats a double
    // slash as an SPA fallback even where JP happens to accept it.
    const assetPath = `/assets/${server}/${resolved.scenarioPath.replace(/^\/+/, "")}`;
    try {
      const scenario = parseUpstreamAssetJson(assetPath, await fetchUpstreamText(assetPath));
      if (!Object.keys(asObj(asObj(scenario).Base)).length) {
        throw new Error("not a scenario asset");
      }
      const resolveCostume = await resolveSeasonCostumeAliases(scenario);
      const conversion = convertBestdoriScenario(scenario, {
        server,
        voiceBundle: resolved.voiceBundle,
        proxify,
        ...(resolveCostume ? { resolveCostume } : {}),
      });
      return jsonBody({
        ...conversion.story,
        storyId: resolved.storyId,
        sourceServer: server,
        sourceDiagnostics: conversion.diagnostics,
      });
    } catch (error) {
      failures.push(`${server}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`bestdori story ${storyId} failed on ${candidates.join(", ")}: ${failures.join("; ")}`);
};

// ---- live2d entries (buildData.asset -> host-neutral Live2D resources) ----
const live2dEntries = async (ids: string[], serverCandidates: readonly BestdoriServerName[]): Promise<CachedBody> => {
  const items: Record<string, unknown> = {};
  const missing: string[] = [];
  // A scene normally requests fewer than a dozen costumes, but cap parallel
  // buildData/model fetches so an unusually large or hand-crafted query does
  // not fan out into a burst against Bestdori.
  const queue = [...ids];
  const worker = async (): Promise<void> => {
    for (;;) {
      const costumeType = queue.shift();
      if (!costumeType) return;
      let loaded = false;
      for (const server of serverCandidates) {
        try {
          const assetPath = `/assets/${server}/live2d/chara/${costumeType}_rip/buildData.asset`;
          const buildData = parseUpstreamAssetJson(assetPath, await fetchUpstreamText(assetPath));
          const entry = bestdoriBuildDataToLive2dEntry(buildData, {
            server,
            proxify,
          });
          if (!entry) continue;
          // Transition data provides the model's authored idle motion. It is a
          // small optional JSON asset; a transient miss must never discard an
          // otherwise usable model entry.
          const transitionPath = bestdoriBuildDataTransitionPath(buildData, server);
          if (transitionPath) {
            try {
              const transition = parseUpstreamAssetJson(transitionPath, await fetchUpstreamText(transitionPath));
              const defaultMotionName = String(asObj(asObj(transition).Base).defaultMotion || "");
              if (defaultMotionName) entry.profile.defaultMotionName = defaultMotionName;
            } catch {
              // Optional enhancement: the scenario's explicit motion still wins.
            }
          }
          const resourceKey = `bestdori:live2d:${costumeType}`;
          items[costumeType] = {
            ...entry,
            id: costumeType,
            live2dKey: resourceKey,
            resourceRef: resourceKey,
          };
          loaded = true;
          break;
        } catch {
          // Try the next published locale; Bestdori serves an HTML app shell
          // for missing regional bundles and fetchUpstreamText rejects it.
        }
      }
      if (!loaded) missing.push(costumeType);
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, queue.length) }, worker));
  return jsonBody({ items, missing });
};

// ---- transformers (bestdori -> our archive shapes) ----

const rewardName = (rewardType: unknown): string => {
  const text = String(rewardType || "");
  const map: Record<string, string> = {
    coin: "Coin",
    star: "Star",
    practice_ticket: "Practice Ticket",
    gacha_ticket: "Gacha Ticket",
    miracle_ticket: "Miracle Ticket",
  };
  return map[text] || text.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) || "Reward";
};

const REWARD_TYPES_WITH_ITEM_TEXT = new Set([
  "item",
  "practice_ticket",
  "gacha_ticket",
  "miracle_ticket",
  "live_boost_recovery_item",
]);

/**
 * Mirrors Bestdori's own `MyItemParser` paths. Every generated URL goes
 * through the raw proxy, whose HTML-fallback guard prevents a missing asset
 * from becoming a cached bogus image. Item text metadata supplies the true
 * material/ticket resource ID rather than assuming `rewardId` is the asset
 * suffix.
 */
const resolvedReward = (rewardType: string, rewardId: number | undefined, server: string, itemTexts: Obj): Obj => {
  const itemText =
    rewardId === undefined || !REWARD_TYPES_WITH_ITEM_TEXT.has(rewardType)
      ? {}
      : asObj(itemTexts[`${rewardType}_${rewardId}`]);
  const resourceId = numericId(itemText.resourceId) ?? rewardId;
  const name = itemText.name ?? rewardName(rewardType);
  let image: string | undefined;
  switch (rewardType) {
    case "coin":
      image = proxify(`/assets/${server}/thumb/common_rip/coin.png`);
      break;
    case "star":
      image = proxify(`/assets/${server}/thumb/common_rip/star.png`);
      break;
    case "michelle_seal":
      image = proxify(`/assets/${server}/thumb/common_rip/michelle_seal.png`);
      break;
    case "item":
      if (resourceId !== undefined)
        image = proxify(`/assets/${server}/thumb/material_rip/material${pad3(resourceId)}.png`);
      break;
    case "practice_ticket":
      if (resourceId !== undefined) {
        image =
          itemText.type === "skill_practice"
            ? proxify(`/assets/${server}/thumb/common_rip/skillticket_${resourceId}.png`)
            : proxify(`/assets/${server}/thumb/common_rip/practiceTicket${resourceId}.png`);
      }
      break;
    case "gacha_ticket":
      if (rewardId !== undefined) image = proxify(`/assets/${server}/thumb/common_rip/gachaTicket${rewardId}.png`);
      break;
    case "miracle_ticket":
      if (resourceId !== undefined)
        image = proxify(`/assets/${server}/thumb/common_rip/miracleTicket${resourceId}.png`);
      break;
    case "live_boost_recovery_item":
      if (resourceId !== undefined) image = proxify(`/assets/${server}/thumb/common_rip/boostdrink_${resourceId}.png`);
      break;
  }
  return {
    ...(rewardId === undefined ? {} : { rewardId }),
    resourceType: rewardType,
    ...(resourceId === undefined ? {} : { resourceId }),
    resourceTypeName: name,
    resolved: {
      kind: rewardType,
      ...(rewardId === undefined ? {} : { itemId: rewardId }),
      name,
      ...(image ? { image } : {}),
    },
  };
};

const difficultyList = (musicId: number, entry: Obj): Obj[] => {
  const difficulty = asObj(entry.difficulty);
  const notes = asObj(entry.notes);
  return DIFFICULTY_NAMES.flatMap((name, index) => {
    const cell = asObj(difficulty[String(index)]);
    if (!Object.keys(cell).length) return [];
    const noteCount = num(notes[String(index)]);
    return [
      {
        difficulty: name,
        playLevel: num(cell.playLevel),
        noteCount,
        publishedAt: timestamps(cell.publishedAt),
        file: `/api/v1/bestdori/charts/${musicId}/${name}`,
      },
    ];
  });
};

const musicVideosFromKeys = (
  musicVideos: unknown,
  lang?: string,
  titles?: unknown,
  fallbackServer?: BestdoriServerName,
): Obj => {
  const record = asObj(musicVideos);
  const titleMap = asObj(titles);
  const out: Obj = {};
  for (const key of Object.keys(record)) {
    const video = asObj(record[key]);
    const assetBundleName = String(video.assetBundleName || key);
    if (!/^[\w().-]+$/.test(assetBundleName)) continue;
    const titleField = asObj(titleMap[key]).title ?? video.title;
    const server = asArray(video.publishedAt).some((value) => value != null)
      ? serverFor(video, lang)
      : (fallbackServer ?? localeServerChain(lang)[0] ?? "jp");
    out[key] = {
      playableUrl: `/api/v1/bestdori/media/mv/${server}/${encodeURIComponent(assetBundleName)}`,
      type: "video/mp4",
      ...(titleField === undefined ? {} : { title: titleField }),
    };
  }
  return out;
};

const baseSong = (musicId: number, entry: Obj, lang?: string): Obj => {
  const server = serverFor(entry, lang);
  const releaseAt = releaseTimestampForTimeline(entry, "publishedAt", lang);
  const image = asArray(entry.jacketImage)[0];
  const jacketImage = typeof image === "string" ? image : String(musicId);
  const jacketBase = "/api/v1/bestdori/media";
  const jacket = `${jacketBase}/jacket/${server}/${jacketPackageFor(musicId)}/${encodeURIComponent(jacketImage)}`;
  const jacketThumb = `${jacketBase}/jacket-thumb/${server}/${jacketPackageFor(musicId)}/${encodeURIComponent(jacketImage)}`;
  const bgmId = String(entry.bgmId || "");
  const bgmNumber = /^bgm(\d+)$/i.exec(bgmId)?.[1] || bgmNumberFor(musicId);
  return {
    musicId,
    musicTitle: entry.musicTitle ?? null,
    bandId: num(entry.bandId),
    jacketUrl: jacket,
    jacketThumbUrl: jacketThumb,
    musicUrl: `/api/v1/bestdori/media/sound/${server}/${bgmNumber}`,
    composer: entry.composer ?? null,
    lyricist: entry.lyricist ?? null,
    arranger: entry.arranger ?? null,
    publishedAt: timestamps(entry.publishedAt) ?? null,
    releaseAt: releaseAt ?? null,
    difficulty: difficultyList(musicId, entry),
    musicCategories: typeof entry.tag === "string" && entry.tag ? [entry.tag] : [],
    musicType: 0,
    musicVideos: musicVideosFromKeys(entry.musicVideos, lang, undefined, server),
  };
};

const normalizeCreditMember = (value: string): string =>
  value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[’'`]/g, "")
    .replace(/[＊*]/g, "")
    .replace(/[\s・･!！?？._-]/g, "");

type CreditAliasSlots = Map<number, Set<string>>;

const localizedCreditSlots = (value: unknown): Map<number, string[]> => {
  const slots = new Map<number, string[]>();
  if (typeof value === "string") {
    if (value.trim()) slots.set(-1, [value.trim()]);
    return slots;
  }
  const values = Array.isArray(value) ? value : Object.values(asObj(value));
  values.forEach((candidate, index) => {
    if (typeof candidate === "string" && candidate.trim()) slots.set(index, [candidate.trim()]);
  });
  return slots;
};

const creditAliasesBySlot = (values: readonly unknown[], splitMembers = false): CreditAliasSlots => {
  const slots: CreditAliasSlots = new Map();
  for (const value of values) {
    for (const [slot, strings] of localizedCreditSlots(value)) {
      const aliases = slots.get(slot) ?? new Set<string>();
      for (const text of strings) {
        const members = splitMembers ? text.split(/\s*(?:×|＆|&|\/|＋|\+)\s*|\s+(?:x|feat\.?|with|from)\s+/iu) : [text];
        for (const member of members) {
          const alias = normalizeCreditMember(member);
          if (alias) aliases.add(alias);
        }
      }
      if (aliases.size) slots.set(slot, aliases);
    }
  }
  return slots;
};

const localizedCreditMembers = (value: unknown): Map<number, string[]> => {
  const slots = new Map<number, string[]>();
  for (const [slot, strings] of localizedCreditSlots(value)) {
    const members = strings.flatMap((text) =>
      text
        .split(/\s*(?:×|＆|&|\/|＋|\+)\s*|\s+(?:x|feat\.?|with|from)\s+/iu)
        .map((member) => member.trim())
        .filter(Boolean),
    );
    if (members.length) slots.set(slot, members);
  }
  return slots;
};

interface SourceCreditMembers {
  members: Set<string>;
  slot: number;
  displayMembers: string[];
  displaySlot: number;
}

const sourceCreditMembers = (value: unknown, lang?: string): SourceCreditMembers => {
  const rawSlots = localizedCreditMembers(value);
  const slots = creditAliasesBySlot([value], true);
  const localizedSlot = lang ? LOCALE_SERVER_INDEX[lang] : undefined;
  // Identity resolution prefers Bestdori's Japanese source. Localized credits
  // can contain short-name collisions (for example CN `灯` is both Tomori's
  // first name and another character's complete name). If JP is absent, use
  // the requested language and then the first available source slot.
  const slot = slots.has(0)
    ? 0
    : localizedSlot !== undefined && slots.has(localizedSlot)
      ? localizedSlot
      : (slots.keys().next().value ?? -1);
  const displaySlot =
    localizedSlot !== undefined && rawSlots.has(localizedSlot)
      ? localizedSlot
      : rawSlots.has(slot)
        ? slot
        : (rawSlots.keys().next().value ?? -1);
  return {
    members: slots.get(slot) ?? new Set<string>(),
    slot,
    displayMembers: rawSlots.get(displaySlot) ?? [],
    displaySlot,
  };
};

interface CreditIdentityCandidate {
  id: number;
  preferred?: boolean;
  primaryAliases: CreditAliasSlots;
  secondaryAliases?: CreditAliasSlots;
}

interface CreditIdentityResolution {
  ids: number[];
  members: Set<string>;
}

const resolveCreditIdentities = (
  members: ReadonlySet<string>,
  candidates: readonly CreditIdentityCandidate[],
  slot: number,
): CreditIdentityResolution => {
  const resolved = new Set<number>();
  const resolvedMembers = new Set<string>();
  for (const member of members) {
    const primaryMatches = candidates.filter((candidate) => candidate.primaryAliases.get(slot)?.has(member));
    let matches = primaryMatches.length
      ? primaryMatches
      : candidates.filter((candidate) => candidate.secondaryAliases?.get(slot)?.has(member));
    if (matches.length > 1) {
      const preferred = matches.filter((candidate) => candidate.preferred);
      if (preferred.length === 1) matches = preferred;
    }
    // An alias still shared by multiple identities is not enough evidence to
    // invent multiple singers. Preserve the source credit and leave it unresolved.
    if (matches.length === 1) {
      resolved.add(matches[0]!.id);
      resolvedMembers.add(member);
    }
  }
  return { ids: [...resolved], members: resolvedMembers };
};

const transformBands = (raw: Record<string, unknown>, rawCharacters: Record<string, unknown>, lang?: string): Obj => {
  const out: Obj = {};
  const formalIds = new Set(BESTDORI_FORMAL_BAND_IDS);
  for (const value of Object.values(rawCharacters)) {
    const bandId = num(asObj(value).bandId);
    if (bandId && bandId > 0) formalIds.add(bandId);
  }

  const formalBands = Object.entries(raw).flatMap(([key, value]) => {
    const bandId = Number(key);
    if (!formalIds.has(bandId)) return [];
    return [{ id: bandId, primaryAliases: creditAliasesBySlot([asObj(value).bandName], true) }];
  });
  const characters = Object.entries(rawCharacters).flatMap(([key, value]) => {
    const characterId = Number(key);
    if (!Number.isFinite(characterId)) return [];
    const entry = asObj(value);
    const characterBandId = num(entry.bandId);
    return [
      {
        id: characterId,
        preferred: Boolean(characterBandId && formalIds.has(characterBandId)),
        primaryAliases: creditAliasesBySlot([entry.characterName]),
        secondaryAliases: creditAliasesBySlot([entry.firstName, entry.lastName, entry.nickname]),
      },
    ];
  });

  for (const [key, value] of Object.entries(raw)) {
    const bandId = Number(key);
    if (!Number.isFinite(bandId)) continue;
    const entry = asObj(value);
    const official = formalIds.has(bandId);
    const credit = official
      ? { members: new Set<string>(), slot: 0, displayMembers: [], displaySlot: 0 }
      : sourceCreditMembers(entry.bandName, lang);
    const bandResolution = resolveCreditIdentities(credit.members, formalBands, credit.slot);
    const characterResolution = resolveCreditIdentities(credit.members, characters, credit.slot);
    const displayAliases = new Set(credit.displayMembers.map(normalizeCreditMember));
    const displayBandResolution = resolveCreditIdentities(displayAliases, formalBands, credit.displaySlot);
    const displayCharacterResolution = resolveCreditIdentities(displayAliases, characters, credit.displaySlot);
    const resolvedDisplayMembers = new Set([...displayBandResolution.members, ...displayCharacterResolution.members]);
    const memberNames = credit.displayMembers.filter(
      (member) => !resolvedDisplayMembers.has(normalizeCreditMember(member)),
    );
    out[key] = {
      bandId,
      bandName: entry.bandName ?? null,
      official,
      ...(bandResolution.ids.length ? { memberBandIds: bandResolution.ids } : {}),
      ...(characterResolution.ids.length ? { memberCharacterIds: characterResolution.ids } : {}),
      ...(memberNames.length ? { memberNames } : {}),
      ...bandVisuals(bandId, lang),
    };
  }
  return out;
};

const transformSongs = (raw: Record<string, unknown>, lang?: string): Obj => {
  const out: Obj = {};
  for (const [key, value] of Object.entries(raw)) {
    const musicId = Number(key);
    if (!Number.isFinite(musicId)) continue;
    out[key] = baseSong(musicId, asObj(value), lang);
  }
  return out;
};

const transformSongMeta = (raw: Record<string, unknown>, metaRaw: Record<string, unknown>): Obj => {
  const out: Obj = {};
  for (const [key, value] of Object.entries(raw)) {
    const musicId = Number(key);
    if (!Number.isFinite(musicId)) continue;
    const entry = asObj(value);
    const lengthSeconds = numOr(entry.length, 0);
    const notes = asObj(entry.notes);
    const bpmByDiff = asObj(entry.bpm);
    const difficulty = asObj(entry.difficulty);
    const songMeta = asObj(metaRaw[key]);
    const perDifficulty: Obj = {};
    for (const index of ["0", "1", "2", "3", "4"]) {
      const noteCount = num(notes[index]);
      const segments = asArray(bpmByDiff[index]).map((segment) => num(asObj(segment).bpm));
      const bpms = segments.filter((v): v is number => v !== undefined);
      const firstBpm = bpms[0];
      const minBpm = bpms.length ? Math.min(...bpms) : undefined;
      const maxBpm = bpms.length ? Math.max(...bpms) : undefined;
      const nps = noteCount && lengthSeconds ? noteCount / lengthSeconds : undefined;
      const difficultyEntry = asObj(difficulty[index]);
      const metaTuple = asArray(asObj(songMeta[index])[BESTDORI_META_PROFILE.skillDuration]);
      const tupleOffset = BESTDORI_META_PROFILE.fever ? 2 : 0;
      const baseFactor = num(metaTuple[tupleOffset]);
      const skillFactor = num(metaTuple[tupleOffset + 1]);
      const score =
        baseFactor === undefined || skillFactor === undefined
          ? undefined
          : BESTDORI_META_PROFILE.perfectMultiplier *
            (baseFactor + BESTDORI_META_PROFILE.scoreSkillMultiplier * skillFactor);
      const scoreBase = baseFactor === undefined || skillFactor === undefined ? undefined : baseFactor + skillFactor;
      perDifficulty[index] = {
        chart: {
          n: noteCount,
          time: lengthSeconds || undefined,
          nps,
          firstBpm,
          minBpm,
          maxBpm,
          playLevel: num(difficultyEntry.playLevel),
          r: num(difficultyEntry.playLevel),
          score,
          eff:
            score === undefined || !lengthSeconds
              ? undefined
              : (score * 60) / (lengthSeconds + BESTDORI_META_PROFILE.downtimeSeconds),
          sr: scoreBase && skillFactor !== undefined ? skillFactor / scoreBase : undefined,
          metricSources: {
            score: "bestdori: SL5 score +100%, 100% PERFECT, Fever",
            eff: `bestdori: score with ${BESTDORI_META_PROFILE.downtimeSeconds}s downtime`,
            sr: "bestdori: seven-second skill coverage",
          },
        },
      };
    }
    out[key] = perDifficulty;
  }
  return out;
};

const transformSongDetail = async (musicId: number, detail: Obj, lang?: string): Promise<Obj> => {
  const base = baseSong(musicId, detail, lang);
  const assetServer = serverFor(detail, lang);
  const achievements = asArray(detail.achievements).map((a) => asObj(a));
  const needsItemTexts = achievements.some((achievement) =>
    REWARD_TYPES_WITH_ITEM_TEXT.has(String(achievement.rewardType || "")),
  );
  // Icons are an enhancement, not a reason to make a song detail unavailable.
  // Static coin/star paths still work if Bestdori's item-text index is stale.
  let itemTexts: Obj = {};
  if (needsItemTexts) {
    try {
      itemTexts = asObj(await allItemTexts());
    } catch {
      itemTexts = {};
    }
  }
  const comboRewards: Record<string, Obj[]> = {};
  const scoreRewards: Obj[] = [];
  for (const achievement of achievements) {
    const type = String(achievement.achievementType || "");
    const rewardType = String(achievement.rewardType || "");
    const quantity = num(achievement.quantity);
    const reward = {
      ...resolvedReward(rewardType, num(achievement.rewardId), assetServer, itemTexts),
      resourceCount: quantity,
    };
    const comboMatch = type.match(/^(full_combo_|combo_)(easy|normal|hard|expert|special)$/);
    if (comboMatch) {
      const difficultyKey = comboMatch[2]! as (typeof DIFFICULTY_NAMES)[number];
      const isFullCombo = comboMatch[1] === "full_combo_";
      (comboRewards[difficultyKey] ||= []).push({
        ...(isFullCombo ? { comboRateType: 3 } : { comboCount: BESTDORI_COMBO_COUNTS[difficultyKey] }),
        ...reward,
      });
      continue;
    }
    const scoreMatch = type.match(/^score_rank_([a-z]+)/);
    if (scoreMatch) {
      const rank = SCORE_RANK_CODE[scoreMatch[1]!];
      if (rank) {
        scoreRewards.push({
          liveScoreRank: rank,
          ...reward,
        });
      }
    }
  }
  // Bestdori repeats a song's score thresholds in every difficulty object
  // (verified across JP and CN details). Pick the first populated set rather
  // than assuming object key 0 exists, which also handles songs without Easy.
  const scoreRanks = Object.values(asObj(detail.difficulty))
    .map((value) => asObj(value))
    .map((difficulty) =>
      SCORE_RANK_FIELDS.flatMap(([rankName, field]) => {
        const requiredScore = num(difficulty[field]);
        const scoreRank = SCORE_RANK_CODE[rankName];
        return requiredScore && scoreRank ? [{ scoreRank, requiredScore }] : [];
      }),
    )
    .find((ranks) => ranks.length);
  // Prefer the richer musicVideos titles from the detail payload.
  base.musicVideos = musicVideosFromKeys(detail.musicVideos, lang, detail.musicVideos, assetServer);
  if (scoreRanks?.length) base.scoreRanks = scoreRanks;
  if (scoreRewards.length)
    base.scoreRewards = scoreRewards.sort(
      (left, right) =>
        numOr(left.liveScoreRank, Number.MAX_SAFE_INTEGER) - numOr(right.liveScoreRank, Number.MAX_SAFE_INTEGER),
    );
  if (Object.keys(comboRewards).length) base.comboRewards = comboRewards;
  return base;
};

const chartText = async (musicId: number, difficulty: string): Promise<CachedBody> => {
  if (!DIFFICULTY_NAMES.includes(difficulty as (typeof DIFFICULTY_NAMES)[number])) {
    throw new Error(`unknown difficulty ${difficulty}`);
  }
  const chart = await fetchUpstream(`/api/charts/${musicId}/${difficulty}.json`);
  return { contentType: "text/plain; charset=utf-8", body: bestdoriChartToSsText(chart) };
};

// ---- route handler ----

export async function handleBestdoriProxy(
  ctx: ExecutionContext,
  request: Request,
  url: URL,
  configuredOrigin?: string,
): Promise<Response | null> {
  configureUpstreamOrigin(configuredOrigin);
  const path = url.pathname;
  if (!path.startsWith("/api/v1/")) return null;
  const lang = url.searchParams.get("lang") || undefined;

  if (path === "/api/v1/servers/bestdori/bands") {
    return serveCached(request, ctx, JSON_CACHE_CONTROL, async () => {
      const [bands, characters] = await Promise.all([allBands(), allCharactersFull()]);
      return jsonBody(transformBands(bands, characters, lang));
    });
  }
  if (path === "/api/v1/servers/bestdori/songs") {
    return serveCached(request, ctx, JSON_CACHE_CONTROL, async () => jsonBody(transformSongs(await all8(), lang)));
  }
  if (path === "/api/v1/servers/bestdori/song-meta") {
    return serveCached(request, ctx, JSON_CACHE_CONTROL, async () => {
      const [songs, meta] = await Promise.all([all8(), allSongMeta()]);
      return jsonBody(transformSongMeta(songs, meta));
    });
  }
  if (path === "/api/v1/servers/bestdori/characters") {
    return serveCached(request, ctx, JSON_CACHE_CONTROL, async () =>
      jsonBody(transformCharacters(await allCharactersFull())),
    );
  }
  if (path === "/api/v1/servers/bestdori/cards") {
    return serveCached(request, ctx, JSON_CACHE_CONTROL, async () => jsonBody(transformCards(await allCards(), lang)));
  }
  const editorAssets = /^\/api\/v1\/servers\/bestdori\/editor-assets(?:\/(.*))?$/.exec(path);
  if (editorAssets) {
    const encodedResourcePath = editorAssets[1] || "";
    const decodedResourcePath = encodedResourcePath ? decodeRoutePart(encodedResourcePath) : "";
    if (decodedResourcePath === null) return invalidPathResponse();
    const resourcePath = bestdoriExplorerPath(decodedResourcePath);
    if (!resourcePath) return invalidPathResponse();
    return serveCached(request, ctx, JSON_CACHE_CONTROL, async () =>
      jsonBody(await bestdoriExplorerPayload(lang, resourcePath)),
    );
  }
  if (path === "/api/v1/servers/bestdori/live2d") {
    const ids = [
      ...new Set(
        url.searchParams
          .getAll("id")
          .map((id) => id.trim())
          .filter((id) => /^[A-Za-z0-9_-]+$/.test(id)),
      ),
    ].slice(0, 64);
    const requestedServer = url.searchParams.get("server");
    const serverCandidates = [
      ...(requestedServer && isBestdoriServer(requestedServer) ? [requestedServer] : []),
      ...localeServerChain(lang),
    ].filter((server, index, values) => values.indexOf(server) === index);
    if (!ids.length)
      return serveCached(request, ctx, JSON_CACHE_CONTROL, async () => jsonBody({ items: {}, missing: [] }));
    return serveCached(request, ctx, JSON_CACHE_CONTROL, () => live2dEntries(ids, serverCandidates));
  }
  const storyCollection = /^\/api\/v1\/servers\/bestdori\/stories\/(event|band|main|afterlive)$/.exec(path);
  if (storyCollection) {
    const section = storyCollection[1]! as "event" | "band" | "main" | "afterlive";
    return serveCached(request, ctx, JSON_CACHE_CONTROL, async () =>
      jsonBody(await buildStoryCollection(section, lang)),
    );
  }

  let match: RegExpMatchArray | null;
  if ((match = /^\/api\/v1\/servers\/bestdori\/song-meta\/(\d+)$/.exec(path))) {
    const musicId = Number(match[1]);
    return serveCached(request, ctx, JSON_CACHE_CONTROL, async () => {
      const [songs, meta] = await Promise.all([all8(), allSongMeta()]);
      const song = songs[String(musicId)];
      if (!song) throw new Error(`unknown bestdori song: ${musicId}`);
      return jsonBody(
        transformSongMeta({ [String(musicId)]: song }, { [String(musicId)]: meta[String(musicId)] })[String(musicId)],
      );
    });
  }
  if ((match = /^\/api\/v1\/servers\/bestdori\/songs\/(\d+)$/.exec(path))) {
    const musicId = Number(match[1]);
    return serveCached(request, ctx, JSON_CACHE_CONTROL, async () => {
      const detail = (await fetchUpstream(`/api/songs/${musicId}.json`)) as Obj;
      return jsonBody(await transformSongDetail(musicId, detail, lang));
    });
  }
  if ((match = /^\/api\/v1\/servers\/bestdori\/cards\/(\d+)$/.exec(path))) {
    const cardId = Number(match[1]);
    return serveCached(request, ctx, JSON_CACHE_CONTROL, async () => {
      const detail = (await fetchUpstream(`/api/cards/${cardId}.json`)) as Obj;
      const card = transformCards({ [String(cardId)]: detail }, lang)[String(cardId)];
      if (!card) throw new Error(`bestdori card ${cardId} has no usable detail payload`);
      return jsonBody(card);
    });
  }
  if ((match = /^\/api\/v1\/bestdori\/charts\/(\d+)\/([a-z]+)$/.exec(path))) {
    const musicId = Number(match[1]);
    const difficulty = match[2]!;
    return serveCached(request, ctx, CHART_CACHE_CONTROL, () => chartText(musicId, difficulty));
  }
  if ((match = /^\/api\/v1\/bestdori\/media\/(jacket|jacket-thumb|sound|mv)\/([a-z]{2})\/(.+)$/.exec(path))) {
    const kind = match[1]!;
    const server = match[2]!;
    const tail = decodeRoutePart(match[3]!);
    if (tail === null) return invalidPathResponse();
    if (!SERVER_NAMES.includes(server as (typeof SERVER_NAMES)[number])) return null;
    if (kind === "jacket" || kind === "jacket-thumb") {
      const [pkg, image] = tail.split("/");
      if (!pkg || !image) return null;
      return proxyMedia(
        request,
        kind === "jacket" ? jacketUpstream(server, pkg, image) : jacketThumbUpstream(server, pkg, image),
        "image/png",
      );
    }
    if (kind === "sound") {
      if (!/^\d+$/.test(tail)) return null;
      return proxyMedia(request, soundUpstream(server, tail), "audio/mpeg");
    }
    if (!/^[\w().-]+$/.test(tail)) return null;
    return proxyMedia(request, mvUpstream(server, tail), "video/mp4");
  }
  if ((match = /^\/api\/v1\/bestdori\/media\/stage-challenge\/(\d+)$/.exec(path))) {
    const assetId = match[1]!;
    return proxyMediaWithServerFallback(
      request,
      localeServerChain(lang),
      (server) => `/assets/${server}/stage_challenge_${assetId}_rip/image.png`,
      "image/png",
    );
  }
  if ((match = /^\/api\/v1\/servers\/bestdori\/stories\/([^/]*\.[^/]+)$/.exec(path))) {
    const storyId = decodeRoutePart(match[1]!);
    if (storyId === null) return invalidPathResponse();
    const requestedServer = url.searchParams.get("server");
    const server = requestedServer && isBestdoriServer(requestedServer) ? requestedServer : undefined;
    return serveCached(request, ctx, JSON_CACHE_CONTROL, () => storyDetail(storyId, server, lang));
  }
  if ((match = /^\/api\/v1\/bestdori\/raw\/(.+)$/.exec(path))) {
    const decodedPath = decodeRoutePart(match[1]!);
    if (decodedPath === null) return invalidPathResponse();
    const upstreamPath = "/" + decodedPath;
    if (/\.\.|%00/.test(upstreamPath)) return null;
    // Sniff a friendly content type from the extension for bestdori's textless
    // octet-stream responses; proxyMedia keeps the upstream type when present.
    const fallback = /\.(png|jpe?g)$/i.test(upstreamPath)
      ? "image/png"
      : /\.(mp3|wav|aac)$/i.test(upstreamPath)
        ? "audio/mpeg"
        : /\.(mp4)$/i.test(upstreamPath)
          ? "video/mp4"
          : "application/octet-stream";
    return proxyMedia(request, upstreamPath, fallback);
  }

  return null;
}
