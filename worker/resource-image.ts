// L3 — GEB
// Input: 资源图片路径、网页导出模型与浏览器执行绑定。
// Output: 与网页相同的 PNG／ZIP；结构化参数错误。
// Pos: [Map](L2.md)；资源级图片 API。
// Effects/Dependencies: 有界请求读取、限流、浏览器或私有服务绘图；不存储用户图片或配队资料。
import { RESOURCE_IMAGE_ROUTES, type ImageRenderRequest } from "../src/lib/public-tools/image-routes";
import { validateResourceImage } from "../src/lib/public-tools/image-validation";
import type { NativeRendererBindings } from "./chart-native-renderer";

const MAX_BODY = 8 * 1024 * 1024;
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Accept",
  "Access-Control-Expose-Headers": "Content-Disposition, X-Haneoka-Image-Width, X-Haneoka-Image-Height, X-Request-Id, Retry-After", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
const routes = RESOURCE_IMAGE_ROUTES.map(route => ({ ...route, pattern: new RegExp(`^${route.path.replaceAll(".", "\\.").replace("{id}", "([A-Za-z0-9_.-]{1,160})")}$`, "u") }));
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);


export async function handleResourceImage(request: Request, env: NativeRendererBindings): Promise<Response | null> {
  const url = new URL(request.url);
  const scoped = /^\/api\/v1\/servers\/(jp|intl)\/(.+)$/u.exec(url.pathname);
  const pathname = scoped ? `/api/v1/${scoped[2]}` : url.pathname;
  const route = routes.find(entry => entry.pattern.test(pathname));
  if (!route || scoped && !["live2d", "spine"].includes(route.kind)) return null;
  const requestId = crypto.randomUUID();
  const fail = (status: number, code: string, message: string) => new Response(request.method === "HEAD" ? null : JSON.stringify({ error: { code, message, requestId } }), { status, headers: { ...CORS, "Content-Type": "application/json", "X-Request-Id": requestId, ...(status === 405 ? { Allow: [...route.methods, "OPTIONS"].join(", ") } : {}), ...(status === 429 ? { "Retry-After": "60" } : {}) } });
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (!(route.methods as readonly string[]).includes(request.method)) return fail(405, "method_not_allowed", `Use ${route.methods.join(" or ")}`);
  let input: ImageRenderRequest;
  try {
    let body: Record<string, unknown> = {};
    if (request.method === "POST") {
      if (!request.headers.get("Content-Type")?.toLowerCase().startsWith("application/json")) return fail(415, "unsupported_media_type", "Use application/json");
      if (Number(request.headers.get("Content-Length")) > MAX_BODY) return fail(413, "body_too_large", "Image request exceeds 8 MiB");
      if (!request.body) throw new TypeError("Supply a JSON body");
      const reader = request.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
      try { for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > MAX_BODY) return fail(413, "body_too_large", "Image request exceeds 8 MiB"); chunks.push(value); } }
      finally { await reader.cancel(); reader.releaseLock(); }
      const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
      if (!object(parsed) || !object(parsed.data)) throw new TypeError("Supply a JSON object with data");
      body = parsed;
    }
    const model = route.kind === "live2d" || route.kind === "spine";
    const data = { ...(object(body.data) ? body.data : {}) };
    const appearance = { ...body };
    const options = new Set(model ? ["server", "release", "width", "height", "time", "loop", "locale", "theme", "seed", ...(route.kind === "live2d" ? ["motion", "expression", "blink", "breath"] : ["animation", "skin", "playbackRate"])] : ["locale", "theme", "seed", ...(route.kind === "gacha-history" ? ["page"] : [])]);
    for (const [key, value] of url.searchParams) {
      if (key === "spoiler" || key === "__content") continue;
      if (!options.has(key) || url.searchParams.getAll(key).length !== 1) throw new TypeError(`Invalid parameter ${key}`);
      if (["locale", "theme", "seed", "page"].includes(key)) appearance[key] = key === "page" ? Number(value) : value;
      else if (["width", "height", "time", "playbackRate"].includes(key)) data[key] = Number(value);
      else if (["loop", "blink", "breath"].includes(key)) { if (!["true", "false"].includes(value)) throw new TypeError(`Invalid ${key}`); data[key] = value === "true"; }
      else data[key] = value;
    }
    if (scoped) { if (data.server && data.server !== scoped[1]) throw new TypeError("Conflicting server"); data.server = scoped[1]; }
    input = { ...appearance, data, kind: route.kind, ...(model ? { id: route.pattern.exec(pathname)![1]! } : {}), ...(route.kind === "gacha-history" ? { archive: pathname.endsWith(".zip") } : {}) } as ImageRenderRequest;
    validateResourceImage(input, url.origin);
  } catch (error) { return fail(400, "invalid_request", error instanceof Error ? error.message : "Invalid image request"); }
  if (env.IMAGE_RENDERER_RATE_LIMITER && !(await env.IMAGE_RENDERER_RATE_LIMITER.limit({ key: "resource-images" })).success) return fail(429, "renderer_busy", "Retry after 60 seconds");
  try {
    let response: Response;
    if (env.TOOLS_SERVICE_URL && env.TOOLS_SERVICE_TOKEN) {
      const target = new URL("v1/resource-image", env.TOOLS_SERVICE_URL.replace(/\/?$/u, "/"));
      if (target.username || target.password || target.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(target.hostname)) throw new Error("Invalid renderer URL");
      response = await fetch(target, { method: "POST", headers: { Authorization: `Bearer ${env.TOOLS_SERVICE_TOKEN}`, "Content-Type": "application/json", ...resourceContextHeaders(request) }, body: JSON.stringify(input), redirect: "manual", signal: AbortSignal.any([request.signal, AbortSignal.timeout(55000)]) });
    } else {
      if (!env.BROWSER) return fail(503, "renderer_unavailable", "Image renderer is unavailable");
      const { renderBrowserResource } = await import("./resource-image-browser");
      response = await renderBrowserResource(env.BROWSER, input, url.origin, request);
    }
    if (!response.ok) { const status = [400, 404, 409, 413, 429].includes(response.status) ? response.status : 502; await response.body?.cancel(); return fail(status, status === 404 ? "not_found" : "image_render_failed", status === 404 ? "Resource not found" : "Image rendering failed"); }
    const type = response.headers.get("Content-Type");
    if (type !== ("archive" in input && input.archive ? "application/zip" : "image/png")) { await response.body?.cancel(); return fail(502, "image_render_failed", "Unexpected image response"); }
    const headers = new Headers(CORS); headers.set("Content-Type", type!); headers.set("Content-Disposition", `attachment; filename="${input.kind}.${type === "image/png" ? "png" : "zip"}"`); headers.set("X-Request-Id", requestId);
    for (const name of ["X-Haneoka-Image-Width", "X-Haneoka-Image-Height", "Content-Length"]) { const value = response.headers.get(name); if (value) headers.set(name, value); }
    if (request.method === "HEAD") { await response.body?.cancel(); return new Response(null, { headers }); }
    let bytes = 0;
    return new Response(response.body?.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ transform(chunk, controller) { bytes += chunk.length; if (bytes > 16 * 1024 * 1024) throw new RangeError("Image exceeds 16 MiB"); controller.enqueue(chunk); } })), { headers });
  } catch (error) {
    if (request.signal.aborted) throw error;
    const invalid = error instanceof TypeError || error instanceof RangeError || error instanceof Error && /page\.evaluate: (TypeError|RangeError):/u.test(error.message);
    return fail(invalid ? 400 : 502, "image_render_failed", "Image rendering failed");
  }
}

function resourceContextHeaders(request: Request): Record<string, string> {
  return Object.fromEntries([...["Cookie", "Authorization"].flatMap((name) => request.headers.has(name) ? [[`X-Haneoka-Resource-${name}`, request.headers.get(name)!]] : []),
    ...(new URL(request.url).searchParams.has("spoiler") ? [["X-Haneoka-Resource-Spoiler", new URL(request.url).searchParams.get("spoiler")!]] : [])]);
}
