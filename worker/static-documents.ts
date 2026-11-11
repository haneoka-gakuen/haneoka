// L3 — GEB
// Input: 文档请求、规范路径、Env 与 ExecutionContext。
// Output: 文档重定向、压缩／组合内容流、私有页面数据元数据（不含密钥）或未命中。
// Pos: [Map](L2.md)；静态文档分片在边缘的读取与还原。
// Effects/Dependencies: ASSETS 最终引用摘要隔离可变索引；旧格式不共享索引，SHA 内容缓存复用；读取 ASSET_BUCKET。
import { publishedWebBuildId } from "../src/lib/web-build-id";
import {
  staticPublicationOutputIdentity,
  STATIC_DOCUMENT_SCHEMA,
  STATIC_DOCUMENT_INDEX_ROOT,
  STATIC_DOCUMENT_CONTENT_ROOT,
  STATIC_DOCUMENT_ASSET_ROOT,
  STATIC_DOCUMENT_CONTENT_INDEX_ROOT,
  STATIC_DOCUMENT_CONTENT_INDEX_SCHEMA,
  STATIC_DOCUMENT_PACK_BYTES,
  staticDocumentAssetPath,
  staticDocumentPackPath,
  staticDocumentShard,
  staticDocumentChunks,
  isStaticDocumentRecord,
  joinStaticDocumentStreams,
  acceptsGzip,
  coreStaticDocumentPath,
  type StaticDocumentRecord,
  type StaticDocumentContentLocation,
} from "../src/lib/static-documents";

type DocumentIndex = { schema: string; entries: Record<string, StaticDocumentRecord> };
type PublicationContext = { webBuildId: string; publicationId: string | null };
const publications = new WeakMap<object, Promise<PublicationContext>>();

/** Input identity labels the browser; the final reference seal partitions mutable indices. */
export async function staticPublicationContext(
  request: Request,
  env: Env,
): Promise<PublicationContext> {
  let pending = publications.get(env.ASSETS);
  if (!pending) {
    pending = (async () => {
      const response = await env.ASSETS.fetch(new URL("/build.json", request.url));
      if (!response.ok) throw new Error(`Static publication identity returned ${response.status}`);
      const build = await response.json<{ id?: unknown; web?: unknown; publication?: unknown }>();
      return { webBuildId: publishedWebBuildId(build), publicationId: staticPublicationOutputIdentity(build.publication) };
    })().catch((error: unknown) => { publications.delete(env.ASSETS); throw error; });
    publications.set(env.ASSETS, pending);
  }
  return pending;
}

const indices = new Map<string, DocumentIndex>();
type ContentIndex = { schema: string; entries: Record<string, StaticDocumentContentLocation> };
const contentIndices = new Map<string, ContentIndex | null>();
const packs = new Map<string, Uint8Array>();
let cachedPackBytes = 0;
const packCacheLimit = 4 * STATIC_DOCUMENT_PACK_BYTES;
const pendingPacks = new Map<string, Promise<Uint8Array>>();
const packReaders: Array<() => void> = [];
let activePackReaders = 0;

async function bufferPack(url: string, response: Response, size: number): Promise<Uint8Array> {
  const pending = pendingPacks.get(url);
  if (pending) {
    await response.body?.cancel();
    return pending;
  }
  const reading = (async () => {
    if (activePackReaders === 4) await new Promise<void>((resolve) => packReaders.push(resolve));
    else activePackReaders++;
    try {
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength !== size) throw new Error("Invalid static content pack length");
      const previous = packs.get(url);
      if (previous) cachedPackBytes -= previous.byteLength;
      packs.delete(url);
      packs.set(url, bytes);
      cachedPackBytes += bytes.byteLength;
      while (cachedPackBytes > packCacheLimit) {
        const oldest = packs.keys().next().value!;
        cachedPackBytes -= packs.get(oldest)!.byteLength;
        packs.delete(oldest);
      }
      return bytes;
    } finally {
      const next = packReaders.shift();
      if (next) next();
      else activePackReaders--;
    }
  })();
  pendingPacks.set(url, reading);
  try {
    return await reading;
  } finally {
    pendingPacks.delete(url);
  }
}

async function contentLocation(
  request: Request,
  env: Env,
  sha256: string,
  publicationId: string | null,
): Promise<StaticDocumentContentLocation | null> {
  const url = new URL(`${STATIC_DOCUMENT_CONTENT_INDEX_ROOT}/${sha256.slice(0, 2)}.json`, request.url);
  const cacheKey = publicationId === null ? null : `${publicationId}:${url.href}`;
  let index = cacheKey === null ? undefined : contentIndices.get(cacheKey);
  if (index === undefined) {
    const response = await env.ASSETS.fetch(new Request(url));
    if (response.status === 404) {
      await response.body?.cancel();
      index = null;
    } else {
      if (!response.ok) throw new Error(`Static content index returned ${response.status}`);
      index = await response.json<ContentIndex>();
      if (index.schema !== STATIC_DOCUMENT_CONTENT_INDEX_SCHEMA || !index.entries)
        throw new Error("Invalid static content index");
    }
    if (cacheKey !== null) {
      contentIndices.set(cacheKey, index);
      if (contentIndices.size > 4) contentIndices.delete(contentIndices.keys().next().value!);
    }
  }
  const location = index?.entries[sha256];
  if (!location) return null;
  if (
    !/^[a-f0-9]{64}$/u.test(location.packSha256) ||
    !Number.isSafeInteger(location.offset) ||
    location.offset < 0 ||
    !Number.isSafeInteger(location.gzipBytes) ||
    location.gzipBytes <= 0 ||
    !Number.isSafeInteger(location.packBytes) ||
    location.packBytes <= 0 ||
    location.packBytes > 25 * STATIC_DOCUMENT_PACK_BYTES ||
    location.offset + location.gzipBytes > location.packBytes ||
    (location.packBytes > STATIC_DOCUMENT_PACK_BYTES &&
      (location.offset !== 0 || location.gzipBytes !== location.packBytes))
  )
    throw new Error("Invalid static content location");
  return location;
}

async function packedContent(
  request: Request,
  env: Env,
  location: StaticDocumentContentLocation,
): Promise<{ body: ReadableStream<Uint8Array>; size: number }> {
  const url = new URL(staticDocumentPackPath(location.packSha256), request.url);
  const cached = packs.get(url.href);
  if (cached) {
    packs.delete(url.href);
    packs.set(url.href, cached);
    return {
      body: new Response(cached.slice(location.offset, location.offset + location.gzipBytes)).body!,
      size: location.gzipBytes,
    };
  }
  const end = location.offset + location.gzipBytes - 1;
  const response = await env.ASSETS.fetch(new Request(url, { headers: { Range: `bytes=${location.offset}-${end}` } }));
  if (!response.body || ![200, 206].includes(response.status))
    throw new Error(`Static content pack returned ${response.status}`);
  if (response.status === 206) {
    if (response.headers.get("Content-Range") !== `bytes ${location.offset}-${end}/${location.packBytes}`)
      throw new Error("Invalid static content range");
    return { body: response.body, size: location.gzipBytes };
  }
  const length = response.headers.get("Content-Length");
  if (length !== null && Number(length) !== location.packBytes) throw new Error("Invalid static content pack length");
  // Large packs contain exactly one member and can pass through without buffering.
  if (location.packBytes > STATIC_DOCUMENT_PACK_BYTES) return { body: response.body, size: location.gzipBytes };
  const bytes = await bufferPack(url.href, response, location.packBytes);
  return { body: new Response(bytes.slice(location.offset, end + 1)).body!, size: location.gzipBytes };
}

async function contentStream(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  sha256: string,
  publicationId: string | null,
): Promise<{ body: ReadableStream<Uint8Array>; size: number } | null> {
  const url = new URL(`/provider-static/content/${sha256}.gz`, request.url);
  const cacheKey = new Request(url);
  const cached = await caches.default.match(cacheKey);
  if (cached?.body) return { body: cached.body, size: Number(cached.headers.get("Content-Length")) };
  const location = await contentLocation(request, env, sha256, publicationId);
  if (location) return packedContent(request, env, location);
  const asset = await env.ASSETS.fetch(new Request(new URL(staticDocumentAssetPath(sha256), request.url)));
  if (asset.ok && asset.body) return { body: asset.body, size: Number(asset.headers.get("Content-Length")) };
  if (asset.status !== 404) throw new Error(`Static content asset returned ${asset.status}: ${sha256}`);
  await asset.body?.cancel();
  const object = await env.ASSET_BUCKET.get(`${STATIC_DOCUMENT_CONTENT_ROOT}/${sha256.slice(0, 2)}/${sha256}.gz`);
  if (!object) return null;
  const response = new Response(object.body, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(object.size),
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
  ctx.waitUntil(
    caches.default.put(cacheKey, response.clone()).catch((error: unknown) => {
      console.warn(JSON.stringify({ message: "static content cache write failed", sha256, error: String(error) }));
    }),
  );
  return { body: response.body!, size: object.size };
}

async function documentRecord(
  request: Request,
  env: Env,
  pathname: string,
  publicationId: string | null,
): Promise<StaticDocumentRecord | null> {
  const shard = staticDocumentShard(pathname);
  const indexUrl = new URL(`${STATIC_DOCUMENT_INDEX_ROOT}/${shard}.json`, request.url);
  const key = publicationId === null ? null : `${publicationId}:${indexUrl.href}`;
  let index = key === null ? undefined : indices.get(key);
  if (!index) {
    const response = await env.ASSETS.fetch(new Request(indexUrl));
    if (!response.ok) return null;
    index = await response.json<DocumentIndex>();
    if (index.schema !== STATIC_DOCUMENT_SCHEMA || !index.entries) throw new Error("Invalid static document index");
    if (key !== null) {
      indices.set(key, index);
      if (indices.size > 4) indices.delete(indices.keys().next().value!);
    }
  }
  const record = index.entries[pathname];
  return isStaticDocumentRecord(record) ? record : null;
}

export interface PrivatePageDataScript {
  id: string;
  sha256: string;
  iv: string;
  bytes: number;
  url: string;
}
export interface PrivatePageDataEntry {
  build: string;
  kid: string;
  types: string[];
  scripts: PrivatePageDataScript[];
}
type PrivatePageDataShard = { schema: string; entries: Record<string, PrivatePageDataEntry> };
const privateShards = new Map<string, PrivatePageDataShard | null>();
const PRIVATE_LOCALES = /^(?:en|ja|ko|zh-CN|zh-TW)$/u;

/**
 * Build metadata of a page's encrypted complete page data: payload locations,
 * IVs and the omitted visibility types. It never holds key material.
 */
export async function readPrivatePageData(
  request: Request,
  env: Env,
  pathname: string,
  publicationId: string | null,
): Promise<PrivatePageDataEntry | null> {
  const parts = pathname.split("/").filter(Boolean);
  const locale = parts[0] === "jp" || parts[0] === "intl" ? parts[1] : parts[0];
  if (!locale || !PRIVATE_LOCALES.test(locale)) return null;
  const url = new URL(`${STATIC_DOCUMENT_ASSET_ROOT}/${locale}/page-data/${staticDocumentShard(pathname)}.json`, request.url);
  const key = publicationId === null ? null : `${publicationId}:${url.href}`;
  let shard = key === null ? undefined : privateShards.get(key);
  if (shard === undefined) {
    const response = await env.ASSETS.fetch(new Request(url));
    if (response.ok) {
      shard = await response.json<PrivatePageDataShard>();
      if (shard.schema !== "haneoka-private-page-data-v1" || !shard.entries) shard = null;
    } else {
      await response.body?.cancel();
      shard = null;
    }
    if (key !== null) {
      privateShards.set(key, shard);
      if (privateShards.size > 16) privateShards.delete(privateShards.keys().next().value!);
    }
  }
  return shard?.entries[pathname] ?? null;
}

/** Preserve the static asset server's trailing-slash redirect after packing. */
export async function staticDocumentRedirect(request: Request, env: Env, publicationId: string | null): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname.endsWith("/")) return null;
  const pathname = coreStaticDocumentPath(`${url.pathname}/`);
  if (!pathname || !(await documentRecord(request, env, pathname, publicationId))) return null;
  return new Response(null, {
    status: 308,
    headers: { Location: `${url.pathname}/${url.search}`, "Cache-Control": "public, max-age=86400" },
  });
}

/** Read complete build-produced HTML/JSON. Rendering never runs in the Worker. */
export async function serveStaticDocument(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  pathname: string,
  publicationId?: string | null,
): Promise<Response | null> {
  if (publicationId === undefined) publicationId = (await staticPublicationContext(request, env)).publicationId;
  const shared = /^\/provider-static\/data\/([a-f0-9]{64})\.json$/u.exec(pathname);
  const record = shared ? null : await documentRecord(request, env, pathname, publicationId);
  if (!shared && !record) return null;
  const sha256 = shared?.[1] || record!.sha256;
  const etag = `W/"${sha256}"`;
  const html = record?.contentType.startsWith("text/html") === true;
  const headers = new Headers({
    "Content-Type": record?.contentType || "application/json; charset=utf-8",
    "Cache-Control": shared ? "public, max-age=31536000, immutable" : "public, max-age=0, must-revalidate",
    ETag: etag,
    Vary: "Accept-Encoding",
    "X-Content-Type-Options": "nosniff",
  });
  // HTML receives the existing site-policy rewrite and its versioned ETag.
  if (!html && request.headers.get("If-None-Match") === etag) return new Response(null, { status: 304, headers });
  const chunks = record ? staticDocumentChunks(record) : [{ sha256 }];
  const keys = chunks.map((chunk) => `${STATIC_DOCUMENT_CONTENT_ROOT}/${chunk.sha256.slice(0, 2)}/${chunk.sha256}.gz`);
  if (request.method === "HEAD") {
    const objects = await Promise.all(
      chunks.map(async (chunk, index) => {
        const location = await contentLocation(request, env, chunk.sha256, publicationId);
        const asset = await env.ASSETS.fetch(
          new Request(
            new URL(
              location ? staticDocumentPackPath(location.packSha256) : staticDocumentAssetPath(chunk.sha256),
              request.url,
            ),
            { method: "HEAD" },
          ),
        );
        if (asset.ok) return true;
        if (asset.status !== 404) throw new Error(`Static content asset returned ${asset.status}: ${chunk.sha256}`);
        return env.ASSET_BUCKET.head(keys[index]!);
      }),
    );
    if (objects.some((object) => !object))
      return new Response("Static document unavailable", { status: 503, headers: { "Cache-Control": "no-store" } });
    return new Response(null, { status: 200, headers });
  }
  const loaded = await Promise.allSettled(
    chunks.map((chunk) => contentStream(request, env, ctx, chunk.sha256, publicationId)),
  );
  const objects = loaded.flatMap((result) => (result.status === "fulfilled" ? [result.value] : [null]));
  if (objects.some((object) => !object)) {
    await Promise.allSettled(objects.flatMap((object) => (object ? [object.body.cancel()] : [])));
    return new Response("Static document unavailable", { status: 503, headers: { "Cache-Control": "no-store" } });
  }
  const complete = objects.filter((object) => object !== null);
  if (!html && acceptsGzip(request.headers.get("Accept-Encoding"))) {
    headers.set("Content-Encoding", "gzip");
    if (Number.isSafeInteger(complete[0]!.size) && complete[0]!.size > 0)
      headers.set("Content-Length", String(complete[0]!.size));
    return new Response(complete[0]!.body, { headers, encodeBody: "manual" });
  }
  return new Response(
    joinStaticDocumentStreams(complete.map((object) => object.body.pipeThrough(new DecompressionStream("gzip")))),
    { headers },
  );
}

/**
 * The complete prerendered HTML of a canonical page, read from the packed
 * snapshot even when a public physical file shadows the same address.
 */
export async function readStaticDocumentSnapshot(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  pathname: string,
  publicationId: string | null,
): Promise<Response | null> {
  const lookup = coreStaticDocumentPath(pathname);
  if (!lookup?.endsWith("/index.html")) return null;
  const response = await serveStaticDocument(new Request(new URL(pathname, request.url)), env, ctx, lookup, publicationId);
  if (!response || response.headers.get("Content-Type")?.startsWith("text/html")) return response;
  await response.body?.cancel();
  return null;
}
