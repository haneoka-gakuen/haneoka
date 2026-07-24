import { handleAdminRequest } from "./admin";
import { handleAccountRegistrationRequest, handleAuthRequest } from "./auth";
import { handleAvatarRequest } from "./avatar";
import { handleAppealRequest } from "./appeals";
import {
  bestdoriSonolusRevision,
  handleBestdoriProxy,
  loadBestdoriSonolusCatalog,
  loadBestdoriSonolusChartText,
} from "./bestdori";
import { handleCommunityRequest } from "./community";
import { handleCommunityActivityRequest } from "./community-activity";
import { handleModerationQueue, reconcileModerationState } from "./moderation";
import { handleProfileRequest } from "./profile";
import { handlePublicProfileRequest } from "./public-profile";
import { cleanupCommunityUploads, handleUploadRequest } from "./uploads";
import { projectCatalogCharts, SonolusLevelService } from "@haneoka/sonolus-core";
import {
  releaseAssetPath,
  ReleaseChartCatalogProvider,
  ReleaseLevelTemplateProvider,
  RuntimeChartDataProvider,
} from "@haneoka/sonolus";

type JsonPrimitive = boolean | null | number | string;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

interface Release {
  indexPrefix: string;
  manifestKey: string;
  releaseId: string;
  server: string;
  sourceId: string;
}

interface ReleaseCacheEntry {
  expiresAt: number;
  value: Release;
}

interface ResourceServerRoute {
  resourcePrefix: string;
  slug: string;
}

interface ResourceServerRouteCacheEntry {
  expiresAt: number;
  value: ResourceServerRoute | null;
}

interface ReleaseEntry {
  bytes: number;
  key: string;
  mediaType: string;
}

interface CatalogShardStorage {
  count: number;
  prefix: string;
  shards: ReadonlySet<string>;
}

interface CatalogRelationStorage extends CatalogShardStorage {
  entityCount: number;
  valueMode: "ids" | "records";
}

interface CatalogViewStorage {
  count: number;
  entities: CatalogShardStorage;
  index: string;
  path: readonly string[];
  shape: "array" | "object";
}

interface CatalogResourceStorage {
  count: number;
  entities: CatalogShardStorage | null;
  index: string;
  kind: string;
  relations: Readonly<Record<string, CatalogRelationStorage>>;
  views: Readonly<Record<string, CatalogViewStorage>>;
}

interface CatalogStorageManifest {
  document: JsonObject;
  resources: Readonly<Record<string, CatalogResourceStorage>>;
  summary: string;
}

interface R2ResponseOptions {
  attachment?: boolean;
  cacheControl?: string;
  expectedBytes?: number;
}

interface GameClientManifest {
  addressablesIndexPrefix: string;
  catalogFile: string;
  catalogHashFile: string;
  embeddedCatalogFile: string;
  platform: string;
  sourceId: string;
  systemVersion: string;
}

interface GameClientAddressableEntry {
  bytes: number;
  digest: string;
  role: "catalog" | "catalog-hash" | "embedded-catalog" | "unity-bundle";
}

interface GarupaMasterPointer {
  manifestKey: string;
  snapshotId: string;
}

interface GarupaMasterPointerCacheEntry {
  expiresAt: number;
  value: GarupaMasterPointer;
}

interface GarupaMasterFile {
  bytes: number;
  mediaType: string;
  sha256: string;
}

interface GarupaMasterSnapshot {
  files: ReadonlyMap<string, GarupaMasterFile>;
  playlistPath: string;
  snapshotId: string;
}

type GameClientRoute =
  | { kind: "addressable"; filename: string; platform: string }
  | { kind: "manifest" }
  | { kind: "master"; filename: string };

type ReleaseIndexEntries = Record<string, JsonValue>;
type ByteRange = { end: number; length: number; start: number };
type RangeResult = ByteRange | { invalid: true } | null;

const MIME: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ktx2": "image/ktx2",
  ".gif": "image/gif",
  ".glb": "model/gltf-binary",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".atlas": "text/plain; charset=utf-8",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
};
const INLINE_MEDIA_TYPES: ReadonlySet<string> = new Set([
  "application/gzip",
  "application/json",
  "application/vnd.sqlite3",
  "application/x-ndjson",
  "audio/mpeg",
  "audio/mp4",
  "audio/wav",
  "image/gif",
  "image/jpeg",
  "image/ktx2",
  "image/png",
  "image/webp",
  "model/gltf-binary",
  "text/plain",
  "video/mp4",
  "video/webm",
]);

const CANONICAL_HOST = "haneoka.org";
const POINTER_TTL_MS = 30_000;
const POINTER_CACHE_LIMIT = 128;
const API_CACHE_TTL = 600;
const CATALOG_API_CACHE_CONTROL = "public, max-age=600, stale-while-revalidate=86400";
const SOURCE_CACHE_TTL = 900;
const MEDIA_CACHE_TTL = 7 * 86_400;
const SONOLUS_VERSION = "1.1.2";
const CAS_PREFIX = "cas/v1/sha256";
const DEFAULT_SONOLUS_SERVER = "jp-cbt";
const RESOURCE_SERVER_CACHE_TTL_MS = 15_000;
const RESOURCE_SERVER_CACHE_LIMIT = 128;
const RELEASE_REPRESENTATION_VERSION = "v3-safe-media";
const RELEASE_INDEX_ALGORITHM = "fnv1a32-mod-256";
const RELEASE_INDEX_SHARDS = 256;
const RELEASE_INDEX_CACHE_LIMIT = 64;
const CATALOG_STORAGE_SCHEMA = "haneoka-catalog-storage-v2";
const CATALOG_STORAGE_MANIFEST_PATH = "api/v1/catalog/manifest.json";
const CATALOG_STORAGE_MANIFEST_CACHE_LIMIT = 32;
const CATALOG_RESOURCE_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;
const CATALOG_RELATION_PATTERN = CATALOG_RESOURCE_PATTERN;
const CATALOG_ROUTE_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:~-]{0,255}$/u;
const RESOURCE_SERVER_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/u;
const RESOURCE_PREFIX_PATTERN = /^[a-z0-9](?:[a-z0-9/_-]{0,198}[a-z0-9])?$/u;
const SOURCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

const GAME_CLIENT_SCHEMA = "haneoka-game-client-v1";
const GAME_CLIENT_ADDRESSABLES_INDEX_SCHEMA = "haneoka-game-client-addressables-index-v1";
const GAME_CLIENT_INDEX_CACHE_LIMIT = 64;
const GAME_CLIENT_MANIFEST_CACHE_LIMIT = 4;
const GAME_CLIENT_POINTER_TTL = 30;
const GAME_CLIENT_MASTER_TTL = 600;
const GAME_CLIENT_IMMUTABLE_TTL = 31_536_000;
const GAME_CLIENT_MASTER_FILE_PATTERN = /^Master[A-Za-z0-9_]+\.bin$/u;

const GARUPA_MASTER_POINTER_KEY = "garupa-master/jp/current.json";
const GARUPA_MASTER_POINTER_SCHEMA = "haneoka-garupa-master-pointer-v1";
const GARUPA_MASTER_SNAPSHOT_SCHEMA = "haneoka-garupa-master-snapshot-v1";
const GARUPA_MASTER_SERVER = "jp";
const GARUPA_MASTER_POINTER_TTL = 30;
const GARUPA_MASTER_PLAYLIST_TTL = 600;
const GARUPA_MASTER_SNAPSHOT_CACHE_LIMIT = 8;
const GARUPA_MASTER_FILE_LIMIT = 20_000;
const GARUPA_MASTER_SNAPSHOT_ID_PATTERN = /^m-[a-f0-9]{20}$/u;
const GARUPA_MASTER_ROOTS = ["archive", "projections", "schema"] as const;
const GARUPA_MASTER_WEB_PATHS = {
  bands: "projections/bands.json",
  manifest: "projections/manifest.json",
  playlists: "projections/playlists.json",
  songs: "projections/songs.json",
  stageChallenges: "projections/stage-challenges.json",
} as const;

const CORS: Readonly<Record<string, string>> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Range, If-Range, If-None-Match, Content-Type",
  "Access-Control-Expose-Headers":
    "Accept-Ranges, Content-Length, Content-Range, ETag, X-Haneoka-Garupa-Snapshot-Id, X-Haneoka-Release-Id, X-Haneoka-Source-Id, X-Request-Id",
};
const SONOLUS_JSON_HEADERS: Readonly<Record<string, string>> = {
  ...CORS,
  "Access-Control-Allow-Headers": `${CORS["Access-Control-Allow-Headers"]}, Sonolus-Session`,
  "Access-Control-Expose-Headers": `${CORS["Access-Control-Expose-Headers"]}, Sonolus-Version`,
  "Content-Type": "application/json; charset=utf-8",
  "Sonolus-Version": SONOLUS_VERSION,
};
const SONOLUS_REPOSITORY_HEADERS: Readonly<Record<string, string>> = {
  ...SONOLUS_JSON_HEADERS,
  "Cache-Control": "public, max-age=31536000, immutable",
};
const isJsonValue = (value: unknown): value is JsonValue => {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return true;
  }
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value !== "object") return false;
  return Object.values(value).every(isJsonValue);
};

const isJsonObject = (value: JsonValue | undefined): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const parseJson = (text: string): JsonValue => {
  const value: unknown = JSON.parse(text);
  if (!isJsonValue(value)) throw new Error("JSON contains a value that cannot be represented safely");
  return value;
};

const extension = (key: string): string => {
  const slash = key.lastIndexOf("/");
  const dot = key.lastIndexOf(".");
  return dot > slash ? key.slice(dot).toLowerCase() : "";
};

function decodePathPart(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function cleanRelativePath(value: string): string | null {
  const output: string[] = [];
  for (const raw of value.split("/")) {
    if (!raw) continue;
    const part = decodePathPart(raw);
    if (!part || part === "." || part === ".." || part.includes("/") || part.includes("\\") || part.includes("\0")) {
      return null;
    }
    output.push(part);
  }
  return output.join("/");
}

const validResourcePrefix = (value: string): boolean =>
  RESOURCE_PREFIX_PATTERN.test(value) &&
  !value.includes("..") &&
  !value.includes("//") &&
  value.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..");

function requestId(request: Request): string {
  return request.headers.get("cf-ray") || crypto.randomUUID();
}

function errorResponse(
  request: Request,
  status: number,
  code: string,
  message: string,
  suppliedRequestId: string | null = null,
): Response {
  const id = suppliedRequestId || requestId(request);
  return new Response(request.method === "HEAD" ? null : JSON.stringify({ error: { code, message, requestId: id } }), {
    status,
    headers: {
      ...CORS,
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
      "X-Request-Id": id,
    },
  });
}

function jsonResponse(request: Request, value: JsonValue, cacheControl = "public, max-age=60"): Response {
  return new Response(request.method === "HEAD" ? null : JSON.stringify(value), {
    status: 200,
    headers: { ...CORS, "Cache-Control": cacheControl, "Content-Type": "application/json; charset=utf-8" },
  });
}

const pointerCache = new Map<string, ReleaseCacheEntry>();
const resourceServerRouteCache = new Map<string, ResourceServerRouteCacheEntry>();
const catalogStorageManifestCache = new Map<string, Promise<CatalogStorageManifest | null>>();
const sonolusLevelService = new SonolusLevelService(3);
const gameClientManifestCache = new Map<string, Promise<GameClientManifest>>();
const gameClientAddressablesIndexCache = new Map<string, Promise<Record<string, GameClientAddressableEntry>>>();
let garupaMasterPointerCache: GarupaMasterPointerCacheEntry | null = null;
const garupaMasterSnapshotCache = new Map<string, Promise<GarupaMasterSnapshot>>();

function cacheResourceServerRoute(slug: string, entry: ResourceServerRouteCacheEntry, now: number): void {
  if (!resourceServerRouteCache.has(slug) && resourceServerRouteCache.size >= RESOURCE_SERVER_CACHE_LIMIT) {
    for (const [key, cached] of resourceServerRouteCache) {
      if (cached.expiresAt <= now) resourceServerRouteCache.delete(key);
    }
    if (resourceServerRouteCache.size >= RESOURCE_SERVER_CACHE_LIMIT) {
      const oldest = resourceServerRouteCache.keys().next().value;
      if (oldest) resourceServerRouteCache.delete(oldest);
    }
  }
  resourceServerRouteCache.set(slug, entry);
}

function cacheCurrentRelease(key: string, entry: ReleaseCacheEntry, now: number): void {
  if (!pointerCache.has(key) && pointerCache.size >= POINTER_CACHE_LIMIT) {
    for (const [cachedKey, cached] of pointerCache) {
      if (cached.expiresAt <= now) pointerCache.delete(cachedKey);
    }
    if (pointerCache.size >= POINTER_CACHE_LIMIT) {
      const oldestKey = pointerCache.keys().next().value;
      if (oldestKey) pointerCache.delete(oldestKey);
    }
  }
  pointerCache.delete(key);
  pointerCache.set(key, entry);
}

async function activeResourceServer(env: Env, slug: string): Promise<ResourceServerRoute | null> {
  if (!RESOURCE_SERVER_SLUG_PATTERN.test(slug)) return null;
  const now = Date.now();
  const cached = resourceServerRouteCache.get(slug);
  if (cached && cached.expiresAt > now) return cached.value;
  const row = await env.DB.prepare(
    `SELECT slug, resource_prefix AS resourcePrefix
     FROM resource_server
     WHERE slug = ? AND status = 'active'
     LIMIT 1`,
  )
    .bind(slug)
    .first<{ resourcePrefix: string; slug: string }>();
  const value =
    row?.slug === slug && validResourcePrefix(row.resourcePrefix)
      ? { resourcePrefix: row.resourcePrefix, slug: row.slug }
      : null;
  cacheResourceServerRoute(slug, { expiresAt: now + RESOURCE_SERVER_CACHE_TTL_MS, value }, now);
  return value;
}

async function currentRelease(env: Env, server: ResourceServerRoute): Promise<Release | null> {
  const key = `${server.resourcePrefix}/current.json`;
  const now = Date.now();
  const cached = pointerCache.get(key);
  if (cached && cached.expiresAt > now) {
    pointerCache.delete(key);
    pointerCache.set(key, cached);
    return cached.value;
  }
  const object = await env.ASSET_BUCKET.get(key);
  if (!object?.body) return null;
  const value = parseJson(await new Response(object.body).text());
  if (!isJsonObject(value)) throw new Error(`invalid release pointer: ${key}`);
  const releaseId = typeof value.releaseId === "string" ? value.releaseId : "";
  const sourceId = typeof value.sourceId === "string" ? value.sourceId : "";
  const manifestKey = `${server.resourcePrefix}/releases/${releaseId}/release.json`;
  const indexPrefix = `${server.resourcePrefix}/releases/${releaseId}/index/`;
  const releaseIndex = isJsonObject(value.releaseIndex) ? value.releaseIndex : null;
  if (
    value.server !== server.slug ||
    value.schema !== "haneoka-resource-pointer-v1" ||
    !/^r-[a-f0-9]{20}$/.test(releaseId) ||
    !SOURCE_ID_PATTERN.test(sourceId) ||
    value.releaseManifest !== manifestKey ||
    releaseIndex?.algorithm !== RELEASE_INDEX_ALGORITHM ||
    releaseIndex.shards !== RELEASE_INDEX_SHARDS ||
    releaseIndex.prefix !== indexPrefix
  ) {
    throw new Error(`invalid release pointer: ${key}`);
  }
  const release: Release = { indexPrefix, manifestKey, releaseId, server: server.slug, sourceId };
  cacheCurrentRelease(key, { expiresAt: now + POINTER_TTL_MS, value: release }, now);
  return release;
}

function releaseCacheRequest(request: Request, releaseId: string): Request {
  const url = new URL(request.url);
  url.searchParams.set("__release", releaseId);
  url.searchParams.set("__representation", RELEASE_REPRESENTATION_VERSION);
  return new Request(url, request);
}

function normalizeEtag(value: string): string {
  return value.trim().replace(/^W\//, "");
}

function etagMatches(value: string | null, etag: string | null): boolean {
  if (!value || !etag) return false;
  if (value.trim() === "*") return true;
  return value.split(",").map(normalizeEtag).includes(normalizeEtag(etag));
}

function parseRange(value: string | null, size: number): RangeResult {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2]) || !Number.isSafeInteger(size) || size <= 0) return { invalid: true };
  let start: number;
  let end: number;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return { invalid: true };
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size)
      return { invalid: true };
    end = Math.min(end, size - 1);
  }
  return start <= end ? { start, end, length: end - start + 1 } : { invalid: true };
}

const cacheControlFor = (contentType: string): string =>
  contentType.includes("json")
    ? "public, max-age=300, stale-while-revalidate=3600"
    : "public, max-age=604800, stale-while-revalidate=2592000";

async function serveR2Object(
  env: Env,
  request: Request,
  key: string,
  contentType?: string,
  options: R2ResponseOptions = {},
): Promise<Response | null> {
  const requestedType = contentType || MIME[extension(key)] || "application/octet-stream";
  const mediaType = requestedType.split(";", 1)[0]?.trim().toLocaleLowerCase("en-US") || "";
  const safeInline = INLINE_MEDIA_TYPES.has(mediaType);
  const finalType = safeInline ? requestedType : "application/octet-stream";
  let rangeHeader = request.headers.get("Range");
  const ifNoneMatch = request.headers.get("If-None-Match");
  const ifRange = request.headers.get("If-Range");
  const headersFor = (object: R2Object): Headers => {
    const headers = new Headers(CORS);
    object.writeHttpMetadata(headers);
    headers.set("Content-Type", finalType);
    headers.set("Accept-Ranges", "bytes");
    headers.set("Cache-Control", options.cacheControl || cacheControlFor(finalType));
    headers.set("ETag", object.httpEtag);
    headers.set("Content-Security-Policy", "default-src 'none'; sandbox");
    headers.set("X-Content-Type-Options", "nosniff");
    if (!safeInline && options.attachment !== false) headers.set("Content-Disposition", "attachment");
    return headers;
  };
  const validateSize = (object: R2Object): void => {
    if (options.expectedBytes !== undefined && object.size !== options.expectedBytes) {
      throw new Error(`R2 object size mismatch: ${key}`);
    }
  };

  if (rangeHeader || request.method === "HEAD" || ifNoneMatch) {
    const metadata = await env.ASSET_BUCKET.head(key);
    if (!metadata) return null;
    validateSize(metadata);
    const headers = headersFor(metadata);
    if (ifNoneMatch && etagMatches(ifNoneMatch, metadata.httpEtag)) return new Response(null, { status: 304, headers });
    if (rangeHeader && ifRange && normalizeEtag(ifRange) !== normalizeEtag(metadata.httpEtag)) rangeHeader = null;
    const range = parseRange(rangeHeader, metadata.size);
    if (range && "invalid" in range) {
      headers.set("Content-Range", `bytes */${metadata.size}`);
      return new Response(null, { status: 416, headers });
    }
    if (range) {
      headers.set("Content-Range", `bytes ${range.start}-${range.end}/${metadata.size}`);
      headers.set("Content-Length", String(range.length));
      if (request.method === "HEAD") return new Response(null, { status: 206, headers });
      const object = await env.ASSET_BUCKET.get(key, { range: { offset: range.start, length: range.length } });
      if (object) validateSize(object);
      return object ? new Response(object.body, { status: 206, headers }) : null;
    }
    headers.set("Content-Length", String(metadata.size));
    if (request.method === "HEAD") return new Response(null, { status: 200, headers });
    const object = await env.ASSET_BUCKET.get(key);
    if (object) validateSize(object);
    return object ? new Response(object.body, { status: 200, headers }) : null;
  }

  const object = await env.ASSET_BUCKET.get(key);
  if (!object) return null;
  validateSize(object);
  const headers = headersFor(object);
  headers.set("Content-Length", String(object.size));
  return new Response(object.body, { status: 200, headers });
}

async function edgeCached(
  request: Request,
  ctx: ExecutionContext,
  ttl: number,
  producer: () => Promise<Response>,
  cacheControl?: string,
): Promise<Response> {
  if (request.method !== "GET" || request.headers.has("Range")) return producer();
  const hit = await caches.default.match(request);
  if (hit) {
    const etag = hit.headers.get("ETag");
    if (etag && etagMatches(request.headers.get("If-None-Match"), etag))
      return new Response(null, { status: 304, headers: hit.headers });
    return hit;
  }
  const response = await producer();
  if (response.status === 200) {
    const headers = new Headers(response.headers);
    headers.set("Cache-Control", cacheControl || response.headers.get("Cache-Control") || `public, max-age=${ttl}`);
    const cachedResponse = new Response(response.body, {
      headers,
      status: response.status,
      statusText: response.statusText,
    });
    const stored = cachedResponse.clone();
    ctx.waitUntil(caches.default.put(request, stored));
    return cachedResponse;
  }
  return response;
}

async function readR2Json(env: Env, key: string): Promise<JsonValue | null> {
  const object = await env.ASSET_BUCKET.get(key);
  return object?.body ? parseJson(await new Response(object.body).text()) : null;
}

const releaseIndexCache = new Map<string, Promise<ReleaseIndexEntries>>();

function casKey(digest: string): string {
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error(`invalid release object digest: ${digest}`);
  return `${CAS_PREFIX}/${digest.slice(0, 2)}/${digest}`;
}

function fnv1a32Shard(value: string, shards: number): string {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return (hash % shards).toString(16).padStart(2, "0");
}

function releaseIndexShard(path: string): string {
  return fnv1a32Shard(path, RELEASE_INDEX_SHARDS);
}

async function releaseIndex(env: Env, release: Release, shard: string): Promise<ReleaseIndexEntries> {
  const key = `${release.indexPrefix}${shard}.json`;
  let pending = releaseIndexCache.get(key);
  if (!pending) {
    pending = readR2Json(env, key).then((value) => {
      if (
        !isJsonObject(value) ||
        value.schema !== "haneoka-resource-index-v1" ||
        value.server !== release.server ||
        value.releaseId !== release.releaseId ||
        value.algorithm !== RELEASE_INDEX_ALGORITHM ||
        value.shard !== shard ||
        !isJsonObject(value.entries)
      ) {
        throw new Error(`invalid release index: ${key}`);
      }
      return value.entries;
    });
    releaseIndexCache.set(key, pending);
    while (releaseIndexCache.size > RELEASE_INDEX_CACHE_LIMIT) {
      const oldestKey = releaseIndexCache.keys().next().value;
      if (!oldestKey) break;
      releaseIndexCache.delete(oldestKey);
    }
  }
  try {
    return await pending;
  } catch (error) {
    releaseIndexCache.delete(key);
    throw error;
  }
}

async function releaseEntry(env: Env, release: Release, path: string): Promise<ReleaseEntry | null> {
  const entries = await releaseIndex(env, release, releaseIndexShard(path));
  const value = entries[path];
  if (!Array.isArray(value) || value.length !== 3) return null;
  const [sha256, bytes, mediaType] = value;
  if (
    typeof sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(sha256) ||
    typeof bytes !== "number" ||
    !Number.isSafeInteger(bytes) ||
    bytes < 0 ||
    typeof mediaType !== "string" ||
    !mediaType ||
    mediaType.length > 128 ||
    /[^\x20-\x7e]/u.test(mediaType)
  ) {
    throw new Error(`invalid release index entry: ${path}`);
  }
  return { key: casKey(sha256), bytes, mediaType };
}

async function readReleaseJson(env: Env, release: Release, path: string): Promise<JsonValue | null> {
  const entry = await releaseEntry(env, release, path);
  return entry ? readR2Json(env, entry.key) : null;
}

async function readReleaseBytes(env: Env, release: Release, path: string): Promise<Uint8Array | null> {
  const entry = await releaseEntry(env, release, path);
  if (!entry) return null;
  const object = await env.ASSET_BUCKET.get(entry.key);
  if (!object?.body) return null;
  if (object.size !== entry.bytes) throw new Error(`Release object size mismatch: ${path}`);
  return new Uint8Array(await new Response(object.body).arrayBuffer());
}

async function serveReleaseObject(
  env: Env,
  request: Request,
  release: Release,
  path: string,
  contentType?: string,
  options: R2ResponseOptions = {},
): Promise<Response | null> {
  const entry = await releaseEntry(env, release, path);
  return entry
    ? serveR2Object(env, request, entry.key, contentType || entry.mediaType, {
        ...options,
        expectedBytes: entry.bytes,
      })
    : null;
}

function boundedPromiseCache<T>(cache: Map<string, Promise<T>>, key: string, value: Promise<T>, limit: number): void {
  cache.set(key, value);
  while (cache.size > limit) {
    const oldestKey = cache.keys().next().value;
    if (!oldestKey) break;
    cache.delete(oldestKey);
  }
}

function garupaMasterManifestKey(snapshotId: string): string {
  return `garupa-master/${GARUPA_MASTER_SERVER}/snapshots/${snapshotId}/manifest.json`;
}

function stableJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key] as JsonValue)}`)
    .join(",")}}`;
}

async function garupaSnapshotId(value: JsonObject): Promise<string> {
  const identity: JsonObject = {
    files: value.files as JsonValue,
    roots: value.roots as JsonValue,
    schema: value.schema as JsonValue,
    server: value.server as JsonValue,
    storage: value.storage as JsonValue,
    web: value.web as JsonValue,
  };
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${stableJson(identity)}\n`));
  return `m-${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 20)}`;
}

async function currentGarupaMaster(env: Env): Promise<GarupaMasterPointer | null> {
  const now = Date.now();
  if (garupaMasterPointerCache && garupaMasterPointerCache.expiresAt > now) {
    return garupaMasterPointerCache.value;
  }
  const value = await readR2Json(env, GARUPA_MASTER_POINTER_KEY);
  if (value === null) return null;
  if (!isJsonObject(value)) throw new Error(`invalid Garupa Master pointer: ${GARUPA_MASTER_POINTER_KEY}`);
  const snapshotId = typeof value.snapshotId === "string" ? value.snapshotId : "";
  const manifestKey = typeof value.manifest === "string" ? value.manifest : "";
  if (
    Object.keys(value).sort().join("\0") !== ["manifest", "schema", "server", "snapshotId"].join("\0") ||
    value.schema !== GARUPA_MASTER_POINTER_SCHEMA ||
    value.server !== GARUPA_MASTER_SERVER ||
    !GARUPA_MASTER_SNAPSHOT_ID_PATTERN.test(snapshotId) ||
    manifestKey !== garupaMasterManifestKey(snapshotId)
  ) {
    throw new Error(`invalid Garupa Master pointer: ${GARUPA_MASTER_POINTER_KEY}`);
  }
  const pointer = { manifestKey, snapshotId };
  garupaMasterPointerCache = {
    expiresAt: now + GARUPA_MASTER_POINTER_TTL * 1_000,
    value: pointer,
  };
  return pointer;
}

async function parseGarupaMasterSnapshot(
  value: JsonValue,
  pointer: GarupaMasterPointer,
): Promise<GarupaMasterSnapshot> {
  if (
    !isJsonObject(value) ||
    Object.keys(value).sort().join("\0") !==
      ["entryCount", "files", "roots", "schema", "server", "snapshotId", "storage", "totalBytes", "web"].join("\0") ||
    value.schema !== GARUPA_MASTER_SNAPSHOT_SCHEMA ||
    value.server !== GARUPA_MASTER_SERVER ||
    value.snapshotId !== pointer.snapshotId ||
    !isJsonObject(value.storage) ||
    value.storage.schema !== "haneoka-r2-cas-v1" ||
    value.storage.prefix !== CAS_PREFIX ||
    !isJsonObject(value.roots) ||
    !Array.isArray(value.files) ||
    value.files.length < 1 ||
    value.files.length > GARUPA_MASTER_FILE_LIMIT ||
    !isJsonObject(value.web) ||
    !Number.isSafeInteger(value.entryCount) ||
    value.entryCount !== value.files.length ||
    !Number.isSafeInteger(value.totalBytes) ||
    Number(value.totalBytes) < 0
  ) {
    throw new Error(`invalid Garupa Master snapshot: ${pointer.manifestKey}`);
  }

  const roots = value.roots;
  const web = value.web;
  const files = new Map<string, GarupaMasterFile>();
  const digestSizes = new Map<string, number>();
  const rootCounts = new Map<string, number>(GARUPA_MASTER_ROOTS.map((root) => [root, 0]));
  const rootBytes = new Map<string, number>(GARUPA_MASTER_ROOTS.map((root) => [root, 0]));
  let totalBytes = 0;
  let previousPath = "";
  for (const raw of value.files) {
    if (
      !isJsonObject(raw) ||
      Object.keys(raw).sort().join("\0") !== ["bytes", "mediaType", "path", "root", "sha256"].join("\0") ||
      typeof raw.root !== "string" ||
      !GARUPA_MASTER_ROOTS.includes(raw.root as (typeof GARUPA_MASTER_ROOTS)[number]) ||
      typeof raw.path !== "string" ||
      cleanRelativePath(raw.path) !== raw.path ||
      !raw.path.startsWith(`${raw.root}/`) ||
      raw.path <= previousPath ||
      files.has(raw.path) ||
      typeof raw.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(raw.sha256) ||
      typeof raw.bytes !== "number" ||
      !Number.isSafeInteger(raw.bytes) ||
      raw.bytes < 0 ||
      typeof raw.mediaType !== "string" ||
      !raw.mediaType ||
      raw.mediaType.length > 128 ||
      /[^\x20-\x7e]/u.test(raw.mediaType)
    ) {
      throw new Error(`invalid Garupa Master snapshot file: ${pointer.manifestKey}`);
    }
    const existingSize = digestSizes.get(raw.sha256);
    if (existingSize !== undefined && existingSize !== raw.bytes) {
      throw new Error(`conflicting Garupa Master digest size: ${pointer.manifestKey}`);
    }
    digestSizes.set(raw.sha256, raw.bytes);
    files.set(raw.path, {
      bytes: raw.bytes,
      mediaType: raw.mediaType,
      sha256: raw.sha256,
    });
    previousPath = raw.path;
    rootCounts.set(raw.root, Number(rootCounts.get(raw.root) || 0) + 1);
    rootBytes.set(raw.root, Number(rootBytes.get(raw.root) || 0) + raw.bytes);
    totalBytes += raw.bytes;
  }
  if (totalBytes !== value.totalBytes) {
    throw new Error(`invalid Garupa Master snapshot byte total: ${pointer.manifestKey}`);
  }
  for (const root of GARUPA_MASTER_ROOTS) {
    const descriptor = roots[root];
    if (
      !isJsonObject(descriptor) ||
      Object.keys(descriptor).sort().join("\0") !== ["entryCount", "prefix", "totalBytes"].join("\0") ||
      descriptor.prefix !== `${root}/` ||
      descriptor.entryCount !== rootCounts.get(root) ||
      descriptor.totalBytes !== rootBytes.get(root)
    ) {
      throw new Error(`invalid Garupa Master snapshot root: ${pointer.manifestKey}`);
    }
  }
  if (
    Object.keys(roots).sort().join("\0") !== [...GARUPA_MASTER_ROOTS].sort().join("\0") ||
    Object.keys(web).sort().join("\0") !== Object.keys(GARUPA_MASTER_WEB_PATHS).sort().join("\0") ||
    Object.entries(GARUPA_MASTER_WEB_PATHS).some(([name, path]) => web[name] !== path) ||
    (await garupaSnapshotId(value)) !== pointer.snapshotId
  ) {
    throw new Error(`invalid Garupa Master snapshot identity: ${pointer.manifestKey}`);
  }

  const playlistPath = GARUPA_MASTER_WEB_PATHS.playlists;
  const playlist = files.get(playlistPath);
  if (
    cleanRelativePath(playlistPath) !== playlistPath ||
    !playlistPath.startsWith("projections/") ||
    !playlistPath.endsWith(".json") ||
    !playlist ||
    playlist.mediaType.split(";", 1)[0]?.trim().toLocaleLowerCase("en-US") !== "application/json"
  ) {
    throw new Error(`invalid Garupa Master playlist projection: ${pointer.manifestKey}`);
  }
  return { files, playlistPath, snapshotId: pointer.snapshotId };
}

async function garupaMasterSnapshot(env: Env, pointer: GarupaMasterPointer): Promise<GarupaMasterSnapshot> {
  let pending = garupaMasterSnapshotCache.get(pointer.manifestKey);
  if (!pending) {
    pending = readR2Json(env, pointer.manifestKey).then((value) => {
      if (value === null) throw new Error(`Garupa Master snapshot is missing: ${pointer.manifestKey}`);
      return parseGarupaMasterSnapshot(value, pointer);
    });
    boundedPromiseCache(garupaMasterSnapshotCache, pointer.manifestKey, pending, GARUPA_MASTER_SNAPSHOT_CACHE_LIMIT);
  }
  try {
    return await pending;
  } catch (error) {
    garupaMasterSnapshotCache.delete(pointer.manifestKey);
    throw error;
  }
}

function garupaSnapshotCacheRequest(request: Request, snapshotId: string): Request {
  const url = new URL(request.url);
  url.searchParams.set("__garupa_snapshot", snapshotId);
  return new Request(url, request);
}

function garupaSnapshotResponseHeaders(response: Response, snapshotId: string): Response {
  const headers = new Headers(response.headers);
  headers.set("X-Haneoka-Garupa-Snapshot-Id", snapshotId);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function validCatalogDocumentPath(value: JsonValue | undefined): value is string {
  return (
    typeof value === "string" &&
    value.startsWith("api/v1/catalog/") &&
    value.endsWith(".json") &&
    cleanRelativePath(value) === value
  );
}

function validCatalogShardPrefix(value: JsonValue | undefined): value is string {
  if (typeof value !== "string" || !value.startsWith("api/v1/catalog/") || !value.endsWith("/")) return false;
  const withoutSlash = value.slice(0, -1);
  return cleanRelativePath(withoutSlash) === withoutSlash;
}

function parseCatalogCount(value: JsonValue | undefined, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`invalid catalog storage count: ${label}`);
  }
  return value;
}

function parseCatalogShardStorage(value: JsonValue | undefined, label: string): CatalogShardStorage {
  if (!isJsonObject(value) || !validCatalogShardPrefix(value.prefix) || !Array.isArray(value.shards)) {
    throw new Error(`invalid catalog shard storage: ${label}`);
  }
  const count = parseCatalogCount(value.count, label);
  const shards = new Set<string>();
  for (const shard of value.shards) {
    if (typeof shard !== "string" || !/^[a-f0-9]{2}$/u.test(shard) || shards.has(shard)) {
      throw new Error(`invalid catalog storage shard: ${label}`);
    }
    shards.add(shard);
  }
  if ((count === 0) !== (shards.size === 0)) throw new Error(`invalid empty catalog shard storage: ${label}`);
  return { count, prefix: value.prefix, shards };
}

function parseCatalogStorageManifest(value: JsonValue, release: Release): CatalogStorageManifest {
  if (
    !isJsonObject(value) ||
    value.schema !== CATALOG_STORAGE_SCHEMA ||
    value.server !== release.server ||
    value.sourceId !== release.sourceId ||
    !validCatalogDocumentPath(value.summary) ||
    !isJsonObject(value.partition) ||
    value.partition.algorithm !== RELEASE_INDEX_ALGORITHM ||
    value.partition.shards !== RELEASE_INDEX_SHARDS ||
    !isJsonObject(value.resources)
  ) {
    throw new Error(`invalid catalog storage manifest: ${release.server}:${release.releaseId}`);
  }

  const resources: Record<string, CatalogResourceStorage> = Object.create(null) as Record<
    string,
    CatalogResourceStorage
  >;
  const resourceNames = new Set(Object.keys(value.resources));
  for (const [name, raw] of Object.entries(value.resources)) {
    if (
      ["catalog", "release", "sources"].includes(name) ||
      !CATALOG_RESOURCE_PATTERN.test(name) ||
      !isJsonObject(raw) ||
      typeof raw.kind !== "string" ||
      !/^[a-z0-9-]{1,64}$/u.test(raw.kind) ||
      !validCatalogDocumentPath(raw.index) ||
      !Array.isArray(raw.dependencies)
    ) {
      throw new Error(`invalid catalog storage resource: ${name}`);
    }
    const dependencies = new Set<string>();
    for (const dependency of raw.dependencies) {
      if (
        typeof dependency !== "string" ||
        dependency === name ||
        !resourceNames.has(dependency) ||
        dependencies.has(dependency)
      ) {
        throw new Error(`invalid catalog resource dependency: ${name}`);
      }
      dependencies.add(dependency);
    }
    const relations: Record<string, CatalogRelationStorage> = Object.create(null) as Record<
      string,
      CatalogRelationStorage
    >;
    if (raw.relations !== undefined) {
      if (!isJsonObject(raw.relations)) throw new Error(`invalid catalog resource relations: ${name}`);
      for (const [relation, storage] of Object.entries(raw.relations)) {
        if (
          !CATALOG_RELATION_PATTERN.test(relation) ||
          !isJsonObject(storage) ||
          !["ids", "records"].includes(String(storage.valueMode))
        ) {
          throw new Error(`invalid catalog relation name: ${name}:${relation}`);
        }
        relations[relation] = {
          ...parseCatalogShardStorage(storage, `${name}:relations:${relation}`),
          entityCount: parseCatalogCount(storage.entityCount, `${name}:relations:${relation}:entities`),
          valueMode: storage.valueMode as "ids" | "records",
        };
      }
    }
    const views: Record<string, CatalogViewStorage> = Object.create(null) as Record<string, CatalogViewStorage>;
    if (raw.views !== undefined) {
      if (!isJsonObject(raw.views)) throw new Error(`invalid catalog resource views: ${name}`);
      for (const [view, storage] of Object.entries(raw.views)) {
        if (
          !CATALOG_RESOURCE_PATTERN.test(view) ||
          !isJsonObject(storage) ||
          !validCatalogDocumentPath(storage.index) ||
          !Array.isArray(storage.path) ||
          !storage.path.length ||
          storage.path.some((part) => typeof part !== "string" || !/^[A-Za-z][A-Za-z0-9]*$/u.test(part)) ||
          !["array", "object"].includes(String(storage.shape))
        ) {
          throw new Error(`invalid catalog view: ${name}:${view}`);
        }
        const entities = parseCatalogShardStorage(storage.entities, `${name}:views:${view}:entities`);
        const count = parseCatalogCount(storage.count, `${name}:views:${view}`);
        const root = `api/v1/catalog/${name}/views/${view}/`;
        if (
          storage.index !== `${root}index.json` ||
          entities.prefix !== `${root}entities/` ||
          entities.count !== count
        ) {
          throw new Error(`non-canonical catalog view storage: ${name}:${view}`);
        }
        views[view] = {
          count,
          entities,
          index: storage.index,
          path: storage.path as string[],
          shape: storage.shape as "array" | "object",
        };
      }
    }
    resources[name] = {
      count: parseCatalogCount(raw.count, name),
      entities: raw.entities === undefined ? null : parseCatalogShardStorage(raw.entities, `${name}:entities`),
      index: raw.index,
      kind: raw.kind,
      relations,
      views,
    };
    if (Object.values(relations).some((relation) => relation.valueMode === "ids") && !resources[name]?.entities) {
      throw new Error(`catalog id relation has no entity storage: ${name}`);
    }
  }
  return { document: value, resources, summary: value.summary };
}

async function catalogStorageManifest(env: Env, release: Release): Promise<CatalogStorageManifest | null> {
  const cacheKey = `${release.server}:${release.releaseId}`;
  let pending = catalogStorageManifestCache.get(cacheKey);
  if (!pending) {
    pending = readReleaseJson(env, release, CATALOG_STORAGE_MANIFEST_PATH).then((value) =>
      value === null ? null : parseCatalogStorageManifest(value, release),
    );
    boundedPromiseCache(catalogStorageManifestCache, cacheKey, pending, CATALOG_STORAGE_MANIFEST_CACHE_LIMIT);
  }
  try {
    return await pending;
  } catch (error) {
    catalogStorageManifestCache.delete(cacheKey);
    throw error;
  }
}

async function readCatalogShard(
  env: Env,
  release: Release,
  storage: CatalogShardStorage,
  key: string,
): Promise<JsonObject | null> {
  const shard = fnv1a32Shard(key, RELEASE_INDEX_SHARDS);
  return readCatalogShardAt(env, release, storage, shard);
}

async function readCatalogShardAt(
  env: Env,
  release: Release,
  storage: CatalogShardStorage,
  shard: string,
): Promise<JsonObject | null> {
  if (!storage.shards.has(shard)) return null;
  const path = `${storage.prefix}${shard}.json`;
  const document = await readReleaseJson(env, release, path);
  if (!isJsonObject(document)) throw new Error(`invalid catalog storage shard: ${path}`);
  return document;
}

function validGameClientFilename(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 512 &&
    !value.includes("/") &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    cleanRelativePath(value) === value
  );
}

async function gameClientManifest(env: Env, release: Release): Promise<GameClientManifest> {
  const cacheKey = `${release.server}:${release.releaseId}`;
  let pending = gameClientManifestCache.get(cacheKey);
  if (!pending) {
    pending = readReleaseJson(env, release, "game-client/manifest.json").then((value) => {
      if (
        !isJsonObject(value) ||
        value.schema !== GAME_CLIENT_SCHEMA ||
        value.server !== release.server ||
        value.sourceId !== release.sourceId ||
        !isJsonObject(value.master) ||
        typeof value.master.systemVersion !== "string" ||
        !value.master.systemVersion ||
        !isJsonObject(value.addressables) ||
        typeof value.addressables.platform !== "string" ||
        !/^[A-Za-z0-9_-]{1,32}$/u.test(value.addressables.platform) ||
        typeof value.addressables.catalogFile !== "string" ||
        typeof value.addressables.catalogHashFile !== "string" ||
        typeof value.addressables.embeddedCatalogFile !== "string" ||
        !isJsonObject(value.addressables.index) ||
        value.addressables.index.algorithm !== RELEASE_INDEX_ALGORITHM ||
        value.addressables.index.shards !== RELEASE_INDEX_SHARDS ||
        value.addressables.index.prefix !== "addressables/index/"
      ) {
        throw new Error(`invalid game-client manifest: ${cacheKey}`);
      }
      const filenames = [
        value.addressables.catalogFile,
        value.addressables.catalogHashFile,
        value.addressables.embeddedCatalogFile,
      ];
      if (!filenames.every((filename) => validGameClientFilename(filename))) {
        throw new Error(`invalid game-client catalog filename: ${cacheKey}`);
      }
      return {
        addressablesIndexPrefix: value.addressables.index.prefix,
        catalogFile: value.addressables.catalogFile,
        catalogHashFile: value.addressables.catalogHashFile,
        embeddedCatalogFile: value.addressables.embeddedCatalogFile,
        platform: value.addressables.platform,
        sourceId: release.sourceId,
        systemVersion: value.master.systemVersion,
      };
    });
    boundedPromiseCache(gameClientManifestCache, cacheKey, pending, GAME_CLIENT_MANIFEST_CACHE_LIMIT);
  }
  try {
    return await pending;
  } catch (error) {
    gameClientManifestCache.delete(cacheKey);
    throw error;
  }
}

async function gameClientAddressablesIndex(
  env: Env,
  release: Release,
  manifest: GameClientManifest,
  shard: string,
): Promise<Record<string, GameClientAddressableEntry>> {
  const cacheKey = `${release.server}:${release.releaseId}:${shard}`;
  let pending = gameClientAddressablesIndexCache.get(cacheKey);
  if (!pending) {
    const path = `game-client/${manifest.addressablesIndexPrefix}${shard}.json`;
    pending = readReleaseJson(env, release, path).then((value) => {
      if (
        !isJsonObject(value) ||
        value.schema !== GAME_CLIENT_ADDRESSABLES_INDEX_SCHEMA ||
        value.server !== release.server ||
        value.sourceId !== release.sourceId ||
        value.platform !== manifest.platform ||
        value.algorithm !== RELEASE_INDEX_ALGORITHM ||
        value.shard !== shard ||
        !isJsonObject(value.entries)
      ) {
        throw new Error(`invalid game-client Addressables index: ${cacheKey}`);
      }
      const entries: Record<string, GameClientAddressableEntry> = {};
      for (const [filename, raw] of Object.entries(value.entries)) {
        if (
          !validGameClientFilename(filename) ||
          releaseIndexShard(`asset/${manifest.platform}/${filename}`) !== shard
        ) {
          throw new Error(`invalid game-client Addressables index filename: ${filename}`);
        }
        if (!Array.isArray(raw) || raw.length !== 3) {
          throw new Error(`invalid game-client Addressables index entry: ${filename}`);
        }
        const [digest, bytes, role] = raw;
        if (
          typeof digest !== "string" ||
          !/^[a-f0-9]{64}$/u.test(digest) ||
          typeof bytes !== "number" ||
          !Number.isSafeInteger(bytes) ||
          bytes < 0 ||
          !["catalog", "catalog-hash", "embedded-catalog", "unity-bundle"].includes(String(role))
        ) {
          throw new Error(`invalid game-client Addressables index entry: ${filename}`);
        }
        entries[filename] = {
          bytes,
          digest,
          role: role as GameClientAddressableEntry["role"],
        };
      }
      return entries;
    });
    boundedPromiseCache(gameClientAddressablesIndexCache, cacheKey, pending, GAME_CLIENT_INDEX_CACHE_LIMIT);
  }
  try {
    return await pending;
  } catch (error) {
    gameClientAddressablesIndexCache.delete(cacheKey);
    throw error;
  }
}

function parseGameClientTail(rawTail: string): GameClientRoute | null {
  const tail = cleanRelativePath(rawTail);
  if (tail === null) return null;
  if (!tail || tail === "manifest.json") return { kind: "manifest" };

  const masterTail = tail.startsWith("master/") ? tail.slice("master/".length) : tail;
  if (masterTail === "MasterDataSystemVersion.txt" || GAME_CLIENT_MASTER_FILE_PATTERN.test(masterTail)) {
    return validGameClientFilename(masterTail) ? { kind: "master", filename: masterTail } : null;
  }

  const assetMatch = /^asset\/([^/]+)\/([^/]+)$/u.exec(tail) || /^([^/]+)\/([^/]+)$/u.exec(tail);
  const platform = assetMatch?.[1];
  const filename = assetMatch?.[2];
  return platform && filename && validGameClientFilename(platform) && validGameClientFilename(filename)
    ? { kind: "addressable", filename, platform }
    : null;
}

function releaseResponseHeaders(response: Response, release: Release): Response {
  const headers = new Headers(response.headers);
  headers.set("X-Haneoka-Release-Id", release.releaseId);
  headers.set("X-Haneoka-Source-Id", release.sourceId);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function gameClientError(request: Request, status: number, message: string): Response {
  return new Response(request.method === "HEAD" ? null : message, {
    status,
    headers: { ...CORS, "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" },
  });
}

async function handleGameClient(env: Env, ctx: ExecutionContext, request: Request, url: URL): Promise<Response | null> {
  const canonical = /^\/game-client\/([^/]+)(?:\/(.*))?$/u.exec(url.pathname);
  if (!canonical) return null;

  const rawServer = canonical[1];
  const rawTail = canonical[2] || "";
  const serverSlug = rawServer ? decodePathPart(rawServer) : null;
  const route = parseGameClientTail(rawTail);
  if (!serverSlug || !RESOURCE_SERVER_SLUG_PATTERN.test(serverSlug) || !route) {
    return gameClientError(request, 404, "not found");
  }
  const server = await activeResourceServer(env, serverSlug);
  if (!server) return gameClientError(request, 404, "not found");
  const release = await currentRelease(env, server);
  if (!release) return gameClientError(request, 503, "release unavailable");
  const manifest = await gameClientManifest(env, release);
  const cacheRequest = releaseCacheRequest(request, release.releaseId);

  if (route.kind === "manifest") {
    const cacheControl = `public, max-age=${GAME_CLIENT_POINTER_TTL}, must-revalidate`;
    const response = await edgeCached(
      cacheRequest,
      ctx,
      GAME_CLIENT_POINTER_TTL,
      async () =>
        (await serveReleaseObject(
          env,
          request,
          release,
          "game-client/manifest.json",
          "application/json; charset=utf-8",
          { attachment: false, cacheControl },
        )) || gameClientError(request, 502, "game-client manifest missing"),
      cacheControl,
    );
    return releaseResponseHeaders(response, release);
  }

  if (route.kind === "master") {
    const isVersion = route.filename === "MasterDataSystemVersion.txt";
    const ttl = isVersion ? GAME_CLIENT_POINTER_TTL : GAME_CLIENT_MASTER_TTL;
    const cacheControl = `public, max-age=${ttl}, must-revalidate`;
    const response = await edgeCached(
      cacheRequest,
      ctx,
      ttl,
      async () =>
        (await serveReleaseObject(
          env,
          request,
          release,
          `game-client/master/${route.filename}`,
          isVersion ? "text/plain; charset=utf-8" : "application/octet-stream",
          { attachment: false, cacheControl },
        )) || gameClientError(request, 404, "not found"),
      cacheControl,
    );
    return releaseResponseHeaders(response, release);
  }

  if (route.platform !== manifest.platform) return gameClientError(request, 404, "not found");
  const shard = releaseIndexShard(`asset/${route.platform}/${route.filename}`);
  const index = await gameClientAddressablesIndex(env, release, manifest, shard);
  const entry = index[route.filename];
  if (!entry) return gameClientError(request, 404, "not found");
  const immutable = entry.role === "unity-bundle" || entry.role === "catalog";
  const ttl = immutable ? GAME_CLIENT_IMMUTABLE_TTL : GAME_CLIENT_POINTER_TTL;
  const cacheControl = immutable ? `public, max-age=${ttl}, immutable` : `public, max-age=${ttl}, must-revalidate`;
  const response = await edgeCached(
    cacheRequest,
    ctx,
    ttl,
    async () =>
      (await serveR2Object(env, request, casKey(entry.digest), "application/octet-stream", {
        attachment: false,
        cacheControl,
        expectedBytes: entry.bytes,
      })) || gameClientError(request, 502, "Addressables object missing"),
    cacheControl,
  );
  return releaseResponseHeaders(response, release);
}

async function handleGarupaPlaylistApi(
  env: Env,
  ctx: ExecutionContext,
  request: Request,
  url: URL,
): Promise<Response | null> {
  if (url.pathname !== "/api/v1/garupa/playlists") return null;
  const pointer = await currentGarupaMaster(env);
  if (!pointer) {
    return errorResponse(request, 503, "garupa_master_unavailable", "Garupa Master is not published");
  }
  const snapshot = await garupaMasterSnapshot(env, pointer);
  const playlist = snapshot.files.get(snapshot.playlistPath);
  if (!playlist) throw new Error(`Garupa Master playlist projection is missing: ${pointer.manifestKey}`);

  const cacheRequest = garupaSnapshotCacheRequest(request, snapshot.snapshotId);
  const cacheControl = "public, max-age=60, stale-while-revalidate=600";
  const response = await edgeCached(
    cacheRequest,
    ctx,
    GARUPA_MASTER_PLAYLIST_TTL,
    async () =>
      (await serveR2Object(env, request, casKey(playlist.sha256), playlist.mediaType, {
        attachment: false,
        cacheControl,
        expectedBytes: playlist.bytes,
      })) || errorResponse(request, 502, "garupa_playlist_missing", "Garupa playlist projection is missing"),
    cacheControl,
  );
  return garupaSnapshotResponseHeaders(response, snapshot.snapshotId);
}

function ownJsonValue(document: JsonObject | null, key: string): JsonValue | undefined {
  return document && Object.prototype.hasOwnProperty.call(document, key) ? document[key] : undefined;
}

function canonicalCatalogBatchRequest(request: Request, ids: readonly string[]): Request {
  const url = new URL(request.url);
  url.searchParams.delete("id");
  for (const id of ids) url.searchParams.append("id", id);
  return new Request(url, request);
}

function catalogBatchIds(url: URL): string[] | null {
  const values = url.searchParams.getAll("id");
  if (!values.length || values.some((id) => !CATALOG_ROUTE_KEY_PATTERN.test(id))) return null;
  return [...new Set(values)].sort();
}

async function catalogBatch(
  env: Env,
  request: Request,
  release: Release,
  storage: CatalogShardStorage | null,
  ids: readonly string[],
): Promise<Response> {
  return jsonResponse(request, await catalogBatchValue(env, release, storage, ids));
}

async function catalogBatchValue(
  env: Env,
  release: Release,
  storage: CatalogShardStorage | null,
  ids: readonly string[],
): Promise<{ items: JsonObject; missing: string[] }> {
  const items: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
  if (!storage) return { items, missing: [...ids] };

  const groups = new Map<string, string[]>();
  for (const id of ids) {
    const shard = fnv1a32Shard(id, RELEASE_INDEX_SHARDS);
    if (!storage.shards.has(shard)) continue;
    const values = groups.get(shard) || [];
    values.push(id);
    groups.set(shard, values);
  }
  const documents = new Map<string, JsonObject>();
  await Promise.all(
    [...groups].map(async ([shard]) => {
      const document = await readCatalogShardAt(env, release, storage, shard);
      if (document) documents.set(shard, document);
    }),
  );
  const missing: string[] = [];
  for (const id of ids) {
    const value = ownJsonValue(documents.get(fnv1a32Shard(id, RELEASE_INDEX_SHARDS)) || null, id);
    if (value === undefined) missing.push(id);
    else items[id] = value;
  }
  return { items, missing };
}

async function handleCatalogStorageApi(
  env: Env,
  ctx: ExecutionContext,
  request: Request,
  release: Release,
  manifest: CatalogStorageManifest,
  tail: string,
): Promise<Response> {
  const url = new URL(request.url);
  const parts = tail.split("/");
  let cacheSource = request;
  let producer: () => Promise<Response>;

  if (tail === "catalog") {
    producer = async () => jsonResponse(request, manifest.document);
  } else if (tail === "catalog/summary") {
    producer = async () => {
      const response = await serveReleaseObject(
        env,
        request,
        release,
        manifest.summary,
        "application/json; charset=utf-8",
      );
      return response || errorResponse(request, 502, "catalog_missing", "Catalog summary is missing");
    };
  } else {
    const resourceName = parts[0] || "";
    const resource = manifest.resources[resourceName];
    if (!resource) {
      return releaseResponseHeaders(
        errorResponse(request, 404, "resource_not_found", "Catalog resource not found"),
        release,
      );
    }

    if (parts.length === 1) {
      if (url.searchParams.has("id")) {
        const ids = catalogBatchIds(url);
        if (!ids) {
          return releaseResponseHeaders(
            errorResponse(request, 400, "invalid_batch", "Catalog batch contains an invalid entity id"),
            release,
          );
        }
        cacheSource = canonicalCatalogBatchRequest(request, ids);
        producer = () => catalogBatch(env, request, release, resource.entities, ids);
      } else {
        producer = async () => {
          const response = await serveReleaseObject(
            env,
            request,
            release,
            resource.index,
            "application/json; charset=utf-8",
          );
          return response || errorResponse(request, 502, "catalog_missing", "Catalog index is missing");
        };
      }
    } else if (parts.length === 2) {
      const id = parts[1] || "";
      if (!CATALOG_ROUTE_KEY_PATTERN.test(id)) {
        return releaseResponseHeaders(
          errorResponse(request, 404, "entity_not_found", "Catalog entity not found"),
          release,
        );
      }
      producer = async () => {
        const shard = resource.entities ? await readCatalogShard(env, release, resource.entities, id) : null;
        const entity = ownJsonValue(shard, id);
        return entity === undefined
          ? errorResponse(request, 404, "entity_not_found", "Catalog entity not found")
          : jsonResponse(request, entity);
      };
    } else if (parts.length >= 3 && parts[1] === "views") {
      const viewName = parts[2] || "";
      const view = resource.views[viewName];
      if (!view) {
        return releaseResponseHeaders(errorResponse(request, 404, "view_not_found", "Catalog view not found"), release);
      }
      if (parts.length === 3) {
        if (url.searchParams.has("id")) {
          const ids = catalogBatchIds(url);
          if (!ids) {
            return releaseResponseHeaders(
              errorResponse(request, 400, "invalid_batch", "Catalog batch contains an invalid entity id"),
              release,
            );
          }
          cacheSource = canonicalCatalogBatchRequest(request, ids);
          producer = () => catalogBatch(env, request, release, view.entities, ids);
        } else {
          producer = async () => {
            const response = await serveReleaseObject(
              env,
              request,
              release,
              view.index,
              "application/json; charset=utf-8",
            );
            return response || errorResponse(request, 502, "catalog_missing", "Catalog view index is missing");
          };
        }
      } else if (parts.length === 4) {
        const id = parts[3] || "";
        if (!CATALOG_ROUTE_KEY_PATTERN.test(id)) {
          return releaseResponseHeaders(
            errorResponse(request, 404, "entity_not_found", "Catalog view entity not found"),
            release,
          );
        }
        producer = async () => {
          const shard = await readCatalogShard(env, release, view.entities, id);
          const entity = ownJsonValue(shard, id);
          return entity === undefined
            ? errorResponse(request, 404, "entity_not_found", "Catalog view entity not found")
            : jsonResponse(request, entity);
        };
      } else {
        return releaseResponseHeaders(errorResponse(request, 404, "view_not_found", "Catalog view not found"), release);
      }
    } else if (parts.length === 4 && parts[1] === "relations") {
      const relationName = parts[2] || "";
      const relationKey = parts[3] || "";
      if (!CATALOG_ROUTE_KEY_PATTERN.test(relationKey)) {
        return releaseResponseHeaders(
          errorResponse(request, 404, "relation_not_found", "Catalog relation not found"),
          release,
        );
      }
      const relation = resource.relations[relationName];
      if (!relation) {
        return releaseResponseHeaders(
          errorResponse(request, 404, "relation_not_found", "Catalog relation not found"),
          release,
        );
      }
      producer = async () => {
        const shard = await readCatalogShard(env, release, relation, relationKey);
        const value = ownJsonValue(shard, relationKey);
        if (value === undefined) return jsonResponse(request, {});
        if (relation.valueMode === "records") {
          if (!isJsonObject(value))
            throw new Error(`invalid catalog relation records: ${resourceName}:${relationName}`);
          return jsonResponse(request, value);
        }
        if (
          !Array.isArray(value) ||
          value.some((id) => typeof id !== "string" || !id) ||
          value.join("\0") !== [...new Set(value)].sort().join("\0")
        ) {
          throw new Error(`invalid catalog relation ids: ${resourceName}:${relationName}`);
        }
        const result = await catalogBatchValue(env, release, resource.entities, value as string[]);
        if (result.missing.length) {
          throw new Error(`catalog relation references missing entities: ${resourceName}:${relationName}`);
        }
        return jsonResponse(request, result.items);
      };
    } else {
      return releaseResponseHeaders(
        errorResponse(request, 404, "resource_not_found", "Catalog resource not found"),
        release,
      );
    }
  }

  const cacheRequest = releaseCacheRequest(cacheSource, release.releaseId);
  const response = await edgeCached(cacheRequest, ctx, API_CACHE_TTL, producer, CATALOG_API_CACHE_CONTROL);
  return releaseResponseHeaders(response, release);
}

async function handleCatalogApi(
  env: Env,
  ctx: ExecutionContext,
  request: Request,
  pathname: string,
): Promise<Response | null> {
  const match = /^\/api\/v1\/servers\/([^/]+)\/(.+)$/.exec(pathname);
  if (!match) return null;
  const rawServer = match[1];
  const rawTail = match[2];
  if (!rawServer || !rawTail) return errorResponse(request, 404, "route_not_found", "API route not found");
  const serverSlug = decodePathPart(rawServer);
  if (!serverSlug || !RESOURCE_SERVER_SLUG_PATTERN.test(serverSlug))
    return errorResponse(request, 404, "server_not_found", "Server not found");
  const server = await activeResourceServer(env, serverSlug);
  if (!server) return errorResponse(request, 404, "server_not_found", "Server not found");
  const release = await currentRelease(env, server);
  if (!release) return errorResponse(request, 503, "release_unavailable", "No release is published");
  const tail = cleanRelativePath(rawTail);
  if (!tail) return errorResponse(request, 404, "route_not_found", "API route not found");
  if (tail === "release") {
    const response = await serveR2Object(env, request, release.manifestKey, "application/json; charset=utf-8");
    return releaseResponseHeaders(
      response ? response : errorResponse(request, 502, "release_invalid", "Release manifest is missing"),
      release,
    );
  }
  if (tail === "sources/tree") {
    const cacheRequest = releaseCacheRequest(request, release.releaseId);
    return releaseResponseHeaders(
      await edgeCached(cacheRequest, ctx, SOURCE_CACHE_TTL, async () => {
        const tree = await serveReleaseObject(
          env,
          request,
          release,
          "metadata/source-index/tree.json",
          "application/json; charset=utf-8",
        );
        return tree || errorResponse(request, 502, "source_index_missing", "Source index is missing");
      }),
      release,
    );
  }
  if (tail.startsWith("sources/")) {
    const sourcePath = tail.slice("sources/".length);
    if (!sourcePath.startsWith("Assets/") && !sourcePath.startsWith("Packages/")) {
      return errorResponse(request, 404, "source_not_found", "Unity source not found");
    }
    const cacheRequest = releaseCacheRequest(request, release.releaseId);
    return releaseResponseHeaders(
      await edgeCached(cacheRequest, ctx, SOURCE_CACHE_TTL, async () => {
        const response = await serveReleaseObject(
          env,
          request,
          release,
          `metadata/sources/${sourcePath}.json`,
          "application/json; charset=utf-8",
        );
        return response || errorResponse(request, 404, "source_not_found", "Unity source not found");
      }),
      release,
    );
  }

  const storage = await catalogStorageManifest(env, release);
  if (!storage) {
    return releaseResponseHeaders(
      errorResponse(request, 502, "catalog_manifest_missing", "Catalog storage manifest is missing"),
      release,
    );
  }
  return handleCatalogStorageApi(env, ctx, request, release, storage, tail);
}

async function handleReleaseMedia(
  env: Env,
  ctx: ExecutionContext,
  request: Request,
  pathname: string,
): Promise<Response | null> {
  const match = /^\/(assets|runtime|objects)\/([^/]+)\/(.+)$/.exec(pathname);
  if (!match) return null;
  const [, tree, rawServer, rawPath] = match;
  if (!tree || !rawServer || !rawPath) return new Response("not found", { status: 404, headers: CORS });
  const serverSlug = decodePathPart(rawServer);
  const relative = cleanRelativePath(rawPath);
  if (!serverSlug || !RESOURCE_SERVER_SLUG_PATTERN.test(serverSlug) || !relative)
    return new Response("not found", { status: 404, headers: CORS });
  const server = await activeResourceServer(env, serverSlug);
  if (!server) return new Response("not found", { status: 404, headers: CORS });
  if (tree === "assets" && !relative.startsWith("Assets/") && !relative.startsWith("Packages/")) {
    return new Response("not found", { status: 404, headers: CORS });
  }
  if (tree === "objects" && !relative.startsWith("unity/"))
    return new Response("not found", { status: 404, headers: CORS });
  const release = await currentRelease(env, server);
  if (!release) return new Response("not found", { status: 404, headers: CORS });
  const cacheRequest = releaseCacheRequest(request, release.releaseId);
  return edgeCached(cacheRequest, ctx, MEDIA_CACHE_TTL, async () => {
    const response = await serveReleaseObject(env, request, release, `${tree}/${relative}`);
    return response || new Response("not found", { status: 404, headers: CORS });
  });
}

async function handleArtifact(
  env: Env,
  ctx: ExecutionContext,
  request: Request,
  pathname: string,
): Promise<Response | null> {
  const match = /^\/artifacts\/([^/]+)\/([^/]+)\/android\/bundles\/([^/]+)$/.exec(pathname);
  if (!match) return null;
  const rawServer = match[1];
  const rawSourceId = match[2];
  const rawFilename = match[3];
  if (!rawServer || !rawSourceId || !rawFilename) return new Response("not found", { status: 404, headers: CORS });
  const serverSlug = decodePathPart(rawServer);
  const sourceId = decodePathPart(rawSourceId);
  const filename = decodePathPart(rawFilename);
  if (
    !serverSlug ||
    !RESOURCE_SERVER_SLUG_PATTERN.test(serverSlug) ||
    !sourceId ||
    !filename ||
    !cleanRelativePath(sourceId) ||
    !cleanRelativePath(filename) ||
    sourceId.includes("/") ||
    filename.includes("/")
  ) {
    return new Response("not found", { status: 404, headers: CORS });
  }
  const server = await activeResourceServer(env, serverSlug);
  if (!server) return new Response("not found", { status: 404, headers: CORS });
  const source = await readR2Json(env, `${server.resourcePrefix}/sources/${sourceId}/source.json`);
  if (!isJsonObject(source)) return new Response("not found", { status: 404, headers: CORS });
  const storage = source.storage;
  if (!isJsonObject(storage) || storage.schema !== "haneoka-r2-cas-v1" || storage.prefix !== CAS_PREFIX) {
    return new Response("not found", { status: 404, headers: CORS });
  }
  const files = source.files;
  const artifact = Array.isArray(files)
    ? files.find(
        (value): value is JsonObject =>
          isJsonObject(value) && value.role === "unity-bundle" && value.originalFilename === filename,
      )
    : undefined;
  if (!artifact || typeof artifact.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(artifact.sha256)) {
    return new Response("not found", { status: 404, headers: CORS });
  }
  const digest = artifact.sha256;
  return edgeCached(request, ctx, MEDIA_CACHE_TTL, async () => {
    const response = await serveR2Object(env, request, casKey(digest), "application/octet-stream");
    return response || new Response("not found", { status: 404, headers: CORS });
  });
}

const BESTDORI_SONOLUS_DATA_ID = /^bestdori:(\d+):(easy|normal|hard|expert|special)$/u;
const BESTDORI_SONOLUS_LEVEL_PREFIX = "/sonolus/levels/bestdori-level-";
const BESTDORI_SONOLUS_PLAYLIST_PREFIX = "/sonolus/playlists/bestdori-playlist-";

function isBestdoriSonolusCatalogRequest(url: URL): boolean {
  return (
    url.searchParams.get("type") === "bestdori" ||
    url.searchParams.get("source") === "bestdori" ||
    url.pathname.startsWith(BESTDORI_SONOLUS_LEVEL_PREFIX) ||
    url.pathname.startsWith(BESTDORI_SONOLUS_PLAYLIST_PREFIX)
  );
}

function bestdoriSonolusCatalogProvider(origin: string | undefined, revision: string) {
  return {
    async load() {
      const { bands, songs } = await loadBestdoriSonolusCatalog(origin);
      const projection = projectCatalogCharts(songs, bands, {
        chartDataId: (songId, difficulty) => `bestdori:${songId}:${difficulty}`,
        levelName: (songId, difficulty) => `bestdori-level-${songId}-${difficulty}`,
        mediaBaseUrl: "https://haneoka.org",
      });
      if (projection.invalidChartNames.length) {
        console.warn("Ignoring invalid Bestdori Sonolus charts", projection.invalidChartNames);
      }
      return { charts: projection.charts, revision: { id: revision } };
    },
  };
}

function bestdoriSonolusDataProvider(origin: string | undefined): RuntimeChartDataProvider {
  return new RuntimeChartDataProvider({
    readBytes: async (dataId) => {
      const match = BESTDORI_SONOLUS_DATA_ID.exec(dataId);
      const musicId = Number(match?.[1]);
      const difficulty = match?.[2];
      if (!Number.isSafeInteger(musicId) || musicId < 1 || !difficulty) return null;
      try {
        return new TextEncoder().encode(await loadBestdoriSonolusChartText(musicId, difficulty, origin));
      } catch (error) {
        console.warn(`Unable to load Bestdori Sonolus chart ${musicId}/${difficulty}`, error);
        return null;
      }
    },
    onInvalidChart: (chart, error) => {
      console.warn(`Ignoring invalid Bestdori Sonolus chart ${chart.name}`, error);
    },
  });
}

function sonolusServerBanner(value: unknown): JsonObject | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const banner = (value as Record<string, unknown>).banner;
  if (banner === null || typeof banner !== "object" || Array.isArray(banner)) return undefined;
  const { hash, url } = banner as Record<string, unknown>;
  if (typeof hash !== "string" && typeof url !== "string") return undefined;
  return {
    ...(typeof hash === "string" ? { hash } : {}),
    ...(typeof url === "string" ? { url } : {}),
  };
}

async function handleSonolus(
  env: Env,
  ctx: ExecutionContext,
  request: Request,
  pathname: string,
): Promise<Response | null> {
  if (pathname === "/sonolus") return Response.redirect(new URL("/sonolus/", request.url).toString(), 308);
  if (!pathname.startsWith("/sonolus/")) return null;
  const assetPathname = pathname;
  const assetUrl = new URL(request.url);
  assetUrl.pathname = assetPathname;
  const isCatalogRoute =
    assetUrl.pathname === "/sonolus/levels" ||
    assetUrl.pathname.startsWith("/sonolus/levels/") ||
    assetUrl.pathname === "/sonolus/playlists" ||
    assetUrl.pathname.startsWith("/sonolus/playlists/");
  const isBestdoriCatalog = isBestdoriSonolusCatalogRequest(assetUrl);
  const server = await activeResourceServer(env, DEFAULT_SONOLUS_SERVER);
  const release = server ? await currentRelease(env, server) : null;
  if (!release) {
    return new Response(JSON.stringify({ message: "Not found" }), { status: 404, headers: SONOLUS_JSON_HEADERS });
  }
  const cacheRequest = releaseCacheRequest(request, release.releaseId);
  try {
    const revision = isBestdoriCatalog
      ? `${release.server}:${release.releaseId}:${bestdoriSonolusRevision()}`
      : `${release.server}:${release.releaseId}`;
    const readJson = (releasePath: string) => readReleaseJson(env, release, releasePath);
    const catalogProvider = isBestdoriCatalog
      ? bestdoriSonolusCatalogProvider(env.BESTDORI_ORIGIN, revision)
      : new ReleaseChartCatalogProvider({
          mediaBaseUrl: "https://haneoka.org",
          readJson,
          resolveChartDataId: (_songId, _difficulty, rawDifficulty) =>
            typeof rawDifficulty.file === "string" ? releaseAssetPath(rawDifficulty.file, release.server) : null,
          revision,
        });
    const dataProvider = isBestdoriCatalog
      ? bestdoriSonolusDataProvider(env.BESTDORI_ORIGIN)
      : new RuntimeChartDataProvider({
          readBytes: (releasePath) => readReleaseBytes(env, release, releasePath),
          onInvalidChart: (chart, error) => {
            console.warn(`Ignoring invalid Sonolus chart ${chart.name}`, error);
          },
        });
    const serverBanner =
      assetUrl.pathname === "/sonolus/info" ? sonolusServerBanner(await readJson("runtime/sonolus/info")) : undefined;
    const projected = await sonolusLevelService.handle({
      catalogProvider,
      dataProvider,
      ...(isBestdoriCatalog
        ? {
            levelInfoTitle: "Bestdori Levels",
            playlistInfoTitle: "Bestdori Playlists",
            playlistName: (songId: string) => `bestdori-playlist-${songId}`,
            quickSearchValues: "source=bestdori",
          }
        : {}),
      levelTemplateProvider: new ReleaseLevelTemplateProvider({ readJson }),
      pathname: assetUrl.pathname,
      randomIndex: (length) => {
        const random = new Uint32Array(1);
        crypto.getRandomValues(random);
        const value = random[0];
        if (value === undefined || length < 1) throw new Error("The runtime did not return a random value");
        return value % length;
      },
      revision,
      searchParams: assetUrl.searchParams,
      ...(serverBanner ? { serverBanner } : {}),
    });
    if (projected) {
      const produce = async (): Promise<Response> => {
        const headers = new Headers({
          ...(projected.kind === "document" ? SONOLUS_JSON_HEADERS : SONOLUS_REPOSITORY_HEADERS),
          "Cache-Control": projected.cacheControl,
          "Content-Type": projected.contentType,
        });
        if (projected.kind === "data" && projected.etag) headers.set("ETag", projected.etag);
        return new Response(
          request.method === "HEAD"
            ? null
            : projected.kind === "document"
              ? JSON.stringify(projected.body)
              : projected.body,
          { status: projected.status, headers },
        );
      };
      return projected.cacheControl === "no-store"
        ? produce()
        : edgeCached(cacheRequest, ctx, API_CACHE_TTL, produce, projected.cacheControl);
    }
  } catch (error) {
    console.warn("Unable to project the current Sonolus chart catalog", error);
    if (isCatalogRoute) {
      return new Response(request.method === "HEAD" ? null : JSON.stringify({ message: "Service unavailable" }), {
        status: 503,
        headers: { ...SONOLUS_JSON_HEADERS, "Cache-Control": "no-store" },
      });
    }
  }
  if (isCatalogRoute) {
    return new Response(request.method === "HEAD" ? null : JSON.stringify({ message: "Not found" }), {
      status: 404,
      headers: { ...SONOLUS_JSON_HEADERS, "Cache-Control": "no-store" },
    });
  }
  if (assetUrl.pathname.endsWith("/list")) {
    const page = Math.max(0, Number.parseInt(assetUrl.searchParams.get("page") || "0", 10) || 0);
    assetUrl.pathname = `${assetUrl.pathname}/page-${page}`;
  }
  assetUrl.search = "";
  const relative = cleanRelativePath(assetUrl.pathname.slice(1));
  if (!relative?.startsWith("sonolus/")) {
    return new Response(JSON.stringify({ message: "Not found" }), { status: 404, headers: SONOLUS_JSON_HEADERS });
  }
  const contentType = relative.startsWith("sonolus/repository/")
    ? "application/octet-stream"
    : "application/json; charset=utf-8";
  const response = await edgeCached(
    cacheRequest,
    ctx,
    MEDIA_CACHE_TTL,
    async () =>
      (await serveReleaseObject(env, request, release, `runtime/${relative}`, contentType)) ||
      new Response(JSON.stringify({ message: "Not found" }), { status: 404, headers: SONOLUS_JSON_HEADERS }),
  );
  if (response.status === 404) return response;
  const headers = new Headers(response.headers);
  const extra = assetPathname.startsWith("/sonolus/repository/") ? SONOLUS_REPOSITORY_HEADERS : SONOLUS_JSON_HEADERS;
  for (const [key, value] of Object.entries(extra)) headers.set(key, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function redirectToCanonical(url: URL): Response {
  const target = new URL(url);
  target.protocol = "https:";
  target.hostname = CANONICAL_HOST;
  target.port = "";
  return new Response(null, {
    status: 308,
    headers: { "Cache-Control": "public, max-age=86400", Location: target.toString() },
  });
}

function shouldServeSpaEntry(request: Request, url: URL): boolean {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  if (url.pathname.startsWith("/_nuxt/")) return false;

  const lastSegment = url.pathname.split("/").filter(Boolean).at(-1) || "";
  let decodedLastSegment: string;
  try {
    decodedLastSegment = decodeURIComponent(lastSegment);
  } catch {
    return false;
  }
  if (/\.[^./]+$/u.test(decodedLastSegment)) return false;

  const navigation = request.headers.get("Sec-Fetch-Mode")?.toLocaleLowerCase("und") === "navigate";
  const acceptsHtml = request.headers.get("Accept")?.toLocaleLowerCase("und").includes("text/html") ?? false;
  return navigation || acceptsHtml;
}

function withHomeLcpPreload(response: Response, url: URL): Response {
  if (url.pathname !== "/") return response;
  const headers = new Headers(response.headers);
  return new Response(response.body, { headers, status: response.status, statusText: response.statusText });
}

async function serveStaticAsset(request: Request, env: Env, url: URL): Promise<Response> {
  if (!env.ASSETS) return new Response("not found", { status: 404 });

  const assetResponse = await env.ASSETS.fetch(request);
  if (assetResponse.status !== 404 || !shouldServeSpaEntry(request, url)) return withHomeLcpPreload(assetResponse, url);

  await assetResponse.body?.cancel();
  const indexRequest = new Request(new URL("/index.html", request.url), {
    headers: request.headers,
    method: request.method,
  });
  const indexResponse = await env.ASSETS.fetch(indexRequest);
  if (request.method !== "HEAD" || !indexResponse.body) return withHomeLcpPreload(indexResponse, url);

  await indexResponse.body.cancel();
  return withHomeLcpPreload(
    new Response(null, {
      headers: indexResponse.headers,
      status: indexResponse.status,
      statusText: indexResponse.statusText,
    }),
    url,
  );
}

async function handleRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  if (url.hostname === CANONICAL_HOST && url.protocol !== "https:") return redirectToCanonical(url);
  const dynamicHost =
    url.hostname === CANONICAL_HOST ||
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]";
  if (dynamicHost) {
    const registration = await handleAccountRegistrationRequest(request, env);
    if (registration) return registration;
    const auth = await handleAuthRequest(request, env);
    if (auth) return auth;
    const admin = await handleAdminRequest(request, env);
    if (admin) return admin;
    const profile = await handleProfileRequest(request, env);
    if (profile) return profile;
    const publicProfile = await handlePublicProfileRequest(request, env);
    if (publicProfile) return publicProfile;
    const avatar = await handleAvatarRequest(request, env);
    if (avatar) return avatar;
    const appeal = await handleAppealRequest(request, env);
    if (appeal) return appeal;
    const upload = await handleUploadRequest(request, env);
    if (upload) return upload;
    const communityActivity = await handleCommunityActivityRequest(request, env);
    if (communityActivity) return communityActivity;
    const community = await handleCommunityRequest(request, env);
    if (community) return community;
  }
  const sonolusRequest = url.pathname === "/sonolus" || url.pathname.startsWith("/sonolus/");
  if (request.method === "OPTIONS")
    return new Response(null, { status: 204, headers: sonolusRequest ? SONOLUS_JSON_HEADERS : CORS });
  if (!new Set(["GET", "HEAD"]).has(request.method))
    return new Response("method not allowed", { status: 405, headers: CORS });
  const gameClient = await handleGameClient(env, ctx, request, url);
  if (gameClient) return gameClient;
  const sonolus = await handleSonolus(env, ctx, request, url.pathname);
  if (sonolus) return sonolus;
  const bestdori = await handleBestdoriProxy(ctx, request, url, env.BESTDORI_ORIGIN);
  if (bestdori) return bestdori;
  const garupaPlaylists = await handleGarupaPlaylistApi(env, ctx, request, url);
  if (garupaPlaylists) return garupaPlaylists;
  const api = await handleCatalogApi(env, ctx, request, url.pathname);
  if (api) return api;
  const media = await handleReleaseMedia(env, ctx, request, url.pathname);
  if (media) return media;
  const artifact = await handleArtifact(env, ctx, request, url.pathname);
  if (artifact) return artifact;
  if (url.pathname.startsWith("/api/")) return errorResponse(request, 404, "route_not_found", "API route not found");
  return serveStaticAsset(request, env, url);
}

function errorDetails(error: unknown): { message: string; name: string } {
  if (error instanceof Error) return { message: error.message, name: error.name || "Error" };
  return { message: String(error), name: "UnknownError" };
}

function internalErrorResponse(request: Request, error: unknown): Response {
  const url = new URL(request.url);
  const id = requestId(request);
  const details = errorDetails(error);
  console.error(
    JSON.stringify({
      event: "worker.request.error",
      requestId: id,
      method: request.method,
      pathname: url.pathname,
      error: details,
    }),
  );
  if (url.pathname === "/sonolus" || url.pathname.startsWith("/sonolus/")) {
    return new Response(JSON.stringify({ message: "Internal server error" }), {
      status: 500,
      headers: { ...SONOLUS_JSON_HEADERS, "Cache-Control": "no-store", "X-Request-Id": id },
    });
  }
  return errorResponse(request, 500, "internal_error", "Internal server error", id);
}

const CLEANUP_BATCH_SIZE = 250;
const CLEANUP_MAX_BATCHES = 8;
const MODERATION_RECONCILIATION_CRON = "17 * * * *";
const COMMUNITY_UPLOAD_CLEANUP_CRON = "37 */6 * * *";
const DATABASE_CLEANUP_CRON = "23 3 * * *";

async function cleanupDatabase(env: Env): Promise<void> {
  const now = new Date();
  const rateLimitCutoff = now.getTime() - 7 * 24 * 60 * 60 * 1_000;
  const expiresAt = now.toISOString();
  for (let batch = 0; batch < CLEANUP_MAX_BATCHES; batch += 1) {
    const results = await env.DB.batch([
      env.DB.prepare(
        "DELETE FROM rateLimit WHERE id IN (SELECT id FROM rateLimit WHERE lastRequest < ? ORDER BY lastRequest LIMIT ?)",
      ).bind(rateLimitCutoff, CLEANUP_BATCH_SIZE),
      env.DB.prepare(
        `DELETE FROM "session"
         WHERE id IN (
           SELECT expired.id
           FROM "session" AS expired
           WHERE expired.expiresAt < ?
           ORDER BY expired.expiresAt
           LIMIT ?
         )`,
      ).bind(expiresAt, CLEANUP_BATCH_SIZE),
      env.DB.prepare(
        "DELETE FROM verification WHERE id IN (SELECT id FROM verification WHERE expiresAt < ? ORDER BY expiresAt LIMIT ?)",
      ).bind(expiresAt, CLEANUP_BATCH_SIZE),
    ]);
    if (results.every((result) => Number(result.meta.changes || 0) < CLEANUP_BATCH_SIZE)) return;
  }
}

const worker: ExportedHandler<Env> = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      return await handleRequest(request, env, ctx);
    } catch (error) {
      return internalErrorResponse(request, error);
    }
  },
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    if (!env.DB) return;
    const scheduledTask: readonly [string, () => Promise<void>] | null =
      controller.cron === MODERATION_RECONCILIATION_CRON
        ? ["moderation_reconciliation", () => reconcileModerationState(env)]
        : controller.cron === COMMUNITY_UPLOAD_CLEANUP_CRON
          ? ["community_upload_cleanup", () => cleanupCommunityUploads(env)]
          : controller.cron === DATABASE_CLEANUP_CRON
            ? ["database_cleanup", () => cleanupDatabase(env)]
            : null;
    if (!scheduledTask) {
      console.warn(JSON.stringify({ cron: controller.cron, event: "worker.unknown_scheduled_trigger" }));
      return;
    }
    ctx.waitUntil(
      (async () => {
        const [task, run] = scheduledTask;
        try {
          await run();
        } catch (scheduledError) {
          console.error(
            JSON.stringify({
              errorName: scheduledError instanceof Error ? scheduledError.name : "ScheduledTaskError",
              event: "worker.scheduled_task_failed",
              task,
            }),
          );
        }
      })(),
    );
  },
  async queue(batch: MessageBatch, env: Env): Promise<void> {
    await handleModerationQueue(batch, env);
  },
};

export default worker;
