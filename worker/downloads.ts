// L3 — GEB
// Input: Haneoka 下载路由、安装包桶与正式服剧情离线清单。
// Output: 安装包、更新清单与剧情内容对象，支持条件读取和断点续传。
// Pos: [Map](L2.md)；复用主域名优选线路的独立下载 Worker。
// Effects/Dependencies: 读取 R2、主服务的可见范围与边缘缓存；完整公开的归档保留长期许可。

import { rejectedResourceClient } from "./resource-clients";

const IMMUTABLE = "public, max-age=31536000, immutable";
const CURRENT = "public, max-age=60, must-revalidate";
const DIGEST = /^[a-f0-9]{64}$/u;
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Range, If-Range, If-None-Match, Authorization",
  "Access-Control-Expose-Headers": "ETag, Content-Length, Content-Range, Accept-Ranges",
  "X-Content-Type-Options": "nosniff",
};

async function document(bucket: R2Bucket, key: string): Promise<Record<string, unknown> | null> {
  const cacheKey = new Request(`https://download-documents.haneoka.internal/${encodeURIComponent(key)}`);
  const cached = await caches.default.match(cacheKey);
  if (cached) return cached.json<Record<string, unknown>>();
  const object = await bucket.get(key);
  if (!object) return null;
  if (object.size > 16 * 1024 * 1024) throw new Error(`Download descriptor exceeds limit: ${key}`);
  const value = await object.json<Record<string, unknown>>();
  await caches.default.put(cacheKey, Response.json(value, { headers: { "Cache-Control": CURRENT } }));
  return value;
}

function matches(value: string | null, etag: string): boolean {
  return value?.split(",").some((part) => part.trim() === "*" || part.trim().replace(/^W\//u, "") === etag) ?? false;
}

async function objectResponse(
  request: Request, bucket: R2Bucket, key: string, immutable: boolean, filename?: string,
): Promise<Response> {
  let range = request.method === "GET" ? request.headers.get("Range") : null;
  const head = range || request.method === "HEAD" || request.headers.has("If-None-Match")
    ? await bucket.head(key) : null;
  if ((range || request.method === "HEAD" || request.headers.has("If-None-Match")) && !head) return missing();
  const headersFor = (object: R2Object) => {
    const headers = new Headers(cors);
    object.writeHttpMetadata(headers);
    headers.set("Cache-Control", immutable ? IMMUTABLE : CURRENT);
    headers.set("ETag", object.httpEtag);
    headers.set("Accept-Ranges", "bytes");
    headers.set("Content-Length", String(object.size));
    headers.set("Content-Type", object.httpMetadata?.contentType ?? "application/octet-stream");
    if (filename && !/\.(json|ya?ml|appinstaller|rb)$/iu.test(filename)) {
      headers.set("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    }
    return headers;
  };
  if (head) {
    const headers = headersFor(head);
    if (matches(request.headers.get("If-None-Match"), head.httpEtag)) return new Response(null, { status: 304, headers });
    const ifRange = request.headers.get("If-Range");
    if (ifRange && ifRange !== head.httpEtag) range = null;
    if (request.method === "HEAD") return new Response(null, { headers });
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/u.exec(range);
      const start = match?.[1] ? Number(match[1]) : Math.max(0, head.size - Number(match?.[2]));
      const end = match?.[1] && match[2] ? Math.min(Number(match[2]), head.size - 1) : head.size - 1;
      if (!match || (!match[1] && !match[2]) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
          start < 0 || start > end || start >= head.size || (!match[1] && Number(match[2]) <= 0)) {
        headers.set("Content-Range", `bytes */${head.size}`);
        headers.delete("Content-Length");
        return new Response(null, { status: 416, headers });
      }
      const object = await bucket.get(key, { range: { offset: start, length: end - start + 1 } });
      if (!object) return missing();
      headers.set("Content-Range", `bytes ${start}-${end}/${head.size}`);
      headers.set("Content-Length", String(end - start + 1));
      return new Response(object.body, { status: 206, headers });
    }
  }
  const object = await bucket.get(key);
  return object ? new Response(object.body, { headers: headersFor(object) }) : missing();
}

function missing(): Response {
  return Response.json({ error: "download_not_found" }, { status: 404, headers: { ...cors, "Cache-Control": "no-store" } });
}

async function batchResponse(request: Request, env: DownloadEnv, prefix: string): Promise<Response> {
  const values = new URL(request.url).searchParams.getAll("objects");
  const hashes = values[0]?.split(",") ?? [];
  if (values.length !== 1 || !hashes.length || hashes.length > 32 ||
      hashes.some((hash) => !DIGEST.test(hash)) || new Set(hashes).size !== hashes.length) {
    return Response.json({ error: "invalid_download_batch" }, { status: 400, headers: cors });
  }
  const shards = [...new Set(hashes.map((hash) => hash.slice(0, 2)))];
  const indexes = new Map(await Promise.all(shards.map(async (shard) =>
    [shard, await document(env.ASSET_BUCKET, `${prefix}objects/${shard}.json`)] as const)));
  const entries = hashes.map((hash) => indexes.get(hash.slice(0, 2))?.[hash] as { bytes: number } | undefined);
  if (entries.some((entry) => !entry)) return missing();
  const bytes = entries.reduce((sum, entry) => sum + entry!.bytes, 0);
  if (bytes > 4 * 1024 * 1024) return Response.json({ error: "download_batch_too_large" }, { status: 400, headers: cors });
  const encoder = new TextEncoder();
  const magic = encoder.encode("HNPK1\n");
  const frames = hashes.map((hash, index) => encoder.encode(`${hash}\t${entries[index]!.bytes}\n`));
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(`HNPK1\n${hashes.join(",")}`));
  const etag = `"${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}"`;
  const headers = { ...cors, "Content-Type": "application/octet-stream", "Cache-Control": IMMUTABLE,
    "Content-Length": String(magic.length + bytes + frames.reduce((sum, frame) => sum + frame.length, 0)), ETag: etag };
  if (matches(request.headers.get("If-None-Match"), etag)) return new Response(null, { status: 304, headers });
  if (request.method === "HEAD") return new Response(null, { headers });
  let index = 0, started = false, cancelled = false;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!started) { started = true; controller.enqueue(magic); return; }
      while (!cancelled) {
        if (reader) {
          const next = await reader.read();
          if (!next.done) { controller.enqueue(next.value); return; }
          reader.releaseLock(); reader = undefined; index++;
        }
        if (index === hashes.length) { controller.close(); return; }
        const hash = hashes[index]!;
        const object = await env.ASSET_BUCKET.get(`cas/v1/sha256/${hash.slice(0, 2)}/${hash}`);
        if (!object || object.size !== entries[index]!.bytes) throw new Error(`Batch object missing: ${hash}`);
        if (cancelled) { await object.body.cancel(); return; }
        reader = object.body.getReader();
        controller.enqueue(frames[index]!);
        return;
      }
    },
    async cancel(reason) { cancelled = true; await reader?.cancel(reason); },
  });
  return new Response(stream, { headers });
}

async function serve(request: Request, env: DownloadEnv): Promise<Response> {
  const url = new URL(request.url);
  const app = /^\/downloads\/app\/(latest\.json|latest\/([^/]+)|(v\d+\.\d+\.\d+)\/([^/]+))$/u.exec(url.pathname);
  if (app) {
    if (app[1] === "latest.json") return objectResponse(request, env.APP_RELEASES, "app/latest.json", false);
    if (app[2]) {
      const latest = await document(env.APP_RELEASES, "app/latest.json");
      const asset = (latest?.assets as Array<Record<string, unknown>> | undefined)?.find((row) => row.name === app[2]);
      if (!asset || typeof asset.browser_download_url !== "string") return missing();
      // Stay on the site the reader reached: haneoka.com must not send them to haneoka.org.
      const location = new URL(new URL(asset.browser_download_url).pathname, url.origin);
      return new Response(null, { status: 302, headers: { ...cors, "Cache-Control": CURRENT, Location: location.href } });
    }
    return objectResponse(request, env.APP_RELEASES, `app/${app[3]}/${app[4]}`, true, app[4]);
  }
  const story = /^\/downloads\/stories\/(jp|intl)\/(latest\.json|(r-[a-f0-9]{20})\/(manifest\.json|manifests\/([a-f0-9]{64})\.json|objects\/([a-f0-9]{64})|batches\/v1))$/u.exec(url.pathname);
  if (!story) return missing();
  const server = story[1]!;
  if (story[2] === "latest.json") {
    return objectResponse(request, env.ASSET_BUCKET, `servers/${server}/offline/current.json`, false);
  }
  const release = story[3]!;
  const prefix = `servers/${server}/releases/${release}/offline/`;
  if (story[4] === "batches/v1") return batchResponse(request, env, prefix);
  if (story[4] === "manifest.json") {
    const pointer = await document(env.ASSET_BUCKET, `${prefix}latest.json`);
    const query = new URLSearchParams();
    if (url.searchParams.has("spoiler")) query.set("spoiler", url.searchParams.get("spoiler")!);
    return typeof pointer?.sha256 === "string" && DIGEST.test(pointer.sha256)
      ? new Response(null, { status: 302, headers: { ...cors, "Cache-Control": CURRENT,
          Location: `/downloads/stories/${server}/${release}/manifests/${pointer.sha256}.json${query.size ? `?${query}` : ""}` } })
      : missing();
  }
  if (story[5]) return objectResponse(request, env.ASSET_BUCKET, `${prefix}manifests/${story[5]}.json`, true);
  const digest = story[6]!;
  if (!DIGEST.test(digest)) return missing();
  const index = await document(env.ASSET_BUCKET, `${prefix}objects/${digest.slice(0, 2)}.json`);
  const entry = index?.[digest] as { bytes: number; mediaType: string } | undefined;
  if (!entry) return missing();
  const response = await objectResponse(request, env.ASSET_BUCKET, `cas/v1/sha256/${digest.slice(0, 2)}/${digest}`, true);
  const headers = new Headers(response.headers);
  headers.set("Content-Type", entry.mediaType);
  return new Response(response.body, { status: response.status, headers });
}

async function storyDownloadAccess(request: Request, env: DownloadEnv): Promise<"public" | "private" | Response> {
  const url = new URL(request.url), route = /^\/downloads\/stories\/(jp|intl)\/(latest\.json|r-[a-f0-9]{20})(?:\/|$)/u.exec(url.pathname);
  if (!route) return "public";
  const server = route[1]!;
  const pointer = route[2] === "latest.json" ? await document(env.ASSET_BUCKET, `servers/${server}/offline/current.json`) : undefined;
  const release = route[2] === "latest.json" ? String(pointer?.releaseId || "") : route[2]!;
  if (!/^r-[a-f0-9]{20}$/u.test(release)) return missing();
  const proof = new Request(`https://published-story-downloads.haneoka.internal/${server}/${release}`);
  if (await caches.default.match(proof)) return "public";
  const check = new URL(`/api/v1/servers/${server}/stories`, url);
  check.searchParams.set("projection", "offline-authorization"); check.searchParams.set("release", release);
  if (url.searchParams.has("spoiler")) check.searchParams.set("spoiler", url.searchParams.get("spoiler")!);
  const headers = new Headers();
  for (const name of ["Cookie", "Authorization"]) if (request.headers.has(name)) headers.set(name, request.headers.get(name)!);
  const response = await env.CONTENT_SERVICE.fetch(new Request(check, { method: "HEAD", headers }));
  if (response.status !== 204 || response.headers.get("X-Haneoka-Content-Authorization") !== "v1") {
    await response.body?.cancel();
    return Response.json({ error: "content_unpublished" }, { status: response.status === 403 || response.status === 401 ? response.status : 503, headers: { ...cors, "Cache-Control": "private, no-store", Vary: "Cookie, Authorization" } });
  }
  if (response.headers.get("X-Haneoka-Public-Content") === "1") {
    await caches.default.put(proof, new Response("1", { headers: { "Cache-Control": IMMUTABLE } }));
    return "public";
  }
  return "private";
}
function downloadResponse(response: Response, access: "public" | "private"): Response {
  if (access === "public") return response;
  const headers = new Headers(response.headers); headers.set("Cache-Control", "private, max-age=0, must-revalidate"); headers.set("Vary", "Cookie, Authorization");
  return new Response(response.body, { status: response.status, headers });
}

export default {
  async fetch(request: Request, env: DownloadEnv, ctx: ExecutionContext): Promise<Response> {
    if (rejectedResourceClient(request)) return new Response("Forbidden", { status: 403, headers: { "Cache-Control": "no-store", Vary: "User-Agent" } });
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (!["GET", "HEAD"].includes(request.method)) return new Response(null, { status: 405, headers: { ...cors, Allow: "GET, HEAD, OPTIONS" } });
    try {
      const access = await storyDownloadAccess(request, env);
      if (access instanceof Response) return access;
      const cache = caches.default;
      const cacheable = !request.url.includes("/latest") && !request.headers.has("If-Range");
      if (cacheable) {
        const hit = await cache.match(new Request(request, { method: "GET" }));
        if (hit) return downloadResponse(request.method === "HEAD" ? new Response(null, hit) : hit, access);
      }
      const response = await serve(request, env);
      if (cacheable && request.method === "GET" && response.status === 200 && !request.headers.has("Range")) {
        ctx.waitUntil(cache.put(request, response.clone()));
      }
      return downloadResponse(response, access);
    } catch (error) {
      console.error(JSON.stringify({ event: "download_failed", path: new URL(request.url).pathname, error: String(error) }));
      return Response.json({ error: "download_unavailable" }, { status: 503, headers: { ...cors, "Cache-Control": "no-store", "Retry-After": "60" } });
    }
  },
} satisfies ExportedHandler<DownloadEnv>;
