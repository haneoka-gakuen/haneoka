// L3 — GEB
// Input: 文档请求、规范路径、Env 与 ExecutionContext。
// Output: 文档重定向、压缩／组合内容流或未命中。
// Pos: [Map](L2.md)；静态文档分片在边缘的读取与还原。
// Effects/Dependencies: 读取 ASSETS 索引和 ASSET_BUCKET 对象、检查内容并使用边缘响应缓存。
import {
  STATIC_DOCUMENT_SCHEMA,
  STATIC_DOCUMENT_INDEX_ROOT,
  STATIC_DOCUMENT_CONTENT_ROOT,
  staticDocumentShard,
  staticDocumentChunks,
  isStaticDocumentRecord,
  joinStaticDocumentStreams,
  acceptsGzip,
  coreStaticDocumentPath,
  type StaticDocumentRecord,
} from "../src/lib/static-documents";

type DocumentIndex = { schema: string; entries: Record<string, StaticDocumentRecord> };
const indices = new Map<string, DocumentIndex>();

async function contentStream(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  sha256: string,
): Promise<{ body: ReadableStream<Uint8Array>; size: number } | null> {
  const url = new URL(`/provider-static/content/${sha256}.gz`, request.url);
  const cacheKey = new Request(url);
  const cached = await caches.default.match(cacheKey);
  if (cached?.body) return { body: cached.body, size: Number(cached.headers.get("Content-Length")) };
  const object = await env.ASSET_BUCKET.get(`${STATIC_DOCUMENT_CONTENT_ROOT}/${sha256.slice(0, 2)}/${sha256}.gz`);
  if (!object) return null;
  const response = new Response(object.body, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(object.size),
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
  ctx.waitUntil(caches.default.put(cacheKey, response.clone()).catch((error: unknown) => {
    console.warn(JSON.stringify({ message: "static content cache write failed", sha256, error: String(error) }));
  }));
  return { body: response.body!, size: object.size };
}

async function documentRecord(request: Request, env: Env, pathname: string): Promise<StaticDocumentRecord | null> {
  const shard = staticDocumentShard(pathname);
  const indexUrl = new URL(`${STATIC_DOCUMENT_INDEX_ROOT}/${shard}.json`, request.url);
  const key = indexUrl.href;
  let index = indices.get(key);
  if (!index) {
    const response = await env.ASSETS.fetch(new Request(indexUrl));
    if (!response.ok) return null;
    index = await response.json<DocumentIndex>();
    if (index.schema !== STATIC_DOCUMENT_SCHEMA || !index.entries) throw new Error("Invalid static document index");
    indices.set(key, index);
    if (indices.size > 4) indices.delete(indices.keys().next().value!);
  }
  const record = index.entries[pathname];
  return isStaticDocumentRecord(record) ? record : null;
}

/** Preserve the static asset server's trailing-slash redirect after packing. */
export async function staticDocumentRedirect(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname.endsWith("/")) return null;
  const pathname = coreStaticDocumentPath(`${url.pathname}/`);
  if (!pathname || !(await documentRecord(request, env, pathname))) return null;
  return new Response(null, {
    status: 308,
    headers: { Location: `${url.pathname}/${url.search}`, "Cache-Control": "public, max-age=86400" },
  });
}

/** Read complete build-produced HTML/JSON. Rendering never runs in the Worker. */
export async function serveStaticDocument(request: Request, env: Env, ctx: ExecutionContext, pathname: string): Promise<Response | null> {
  const shared = /^\/provider-static\/data\/([a-f0-9]{64})\.json$/u.exec(pathname);
  const record = shared ? null : await documentRecord(request, env, pathname);
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
    const objects = await Promise.all(keys.map((key) => env.ASSET_BUCKET.head(key)));
    if (objects.some((object) => !object))
      return new Response("Static document unavailable", { status: 503, headers: { "Cache-Control": "no-store" } });
    return new Response(null, { status: 200, headers });
  }
  const loaded = await Promise.allSettled(chunks.map((chunk) => contentStream(request, env, ctx, chunk.sha256)));
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
