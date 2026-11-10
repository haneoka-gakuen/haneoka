// L3 — GEB
// Input: 固定的歌曲／release 身份、浏览器绑定或私有渲染服务地址。
// Output: 原生画布生成的 PNG 与尺寸。
// Pos: [Map](L2.md)；Worker 到原生浏览器渲染的缓存边界。
// Effects/Dependencies: 托管浏览器或固定 HTTPS 服务请求与边缘缓存；不在 Worker 内运行配队搜索。
import { CHART_IMAGE_RENDERER_VERSION } from "../src/lib/public-tools/chart-contract";
import type { ChartBrowserBinding } from "./chart-browser-renderer";
export interface NativeChartRenderInput { server: string; songId: string; difficulty: string; release: string; locale: string; height: number; origin?: string; timeZone?: string }
export interface NativeRendererBindings { TOOLS_SERVICE_URL?: string; TOOLS_SERVICE_TOKEN?: string; BROWSER?: ChartBrowserBinding; IMAGE_RENDERER_RATE_LIMITER?: { limit(input: { key: string }): Promise<{ success: boolean }> } }
export async function renderNativeChart(env: NativeRendererBindings, input: NativeChartRenderInput, waitUntil?: (promise: Promise<unknown>) => void, source?: Request) {
  const cache = typeof caches === "undefined" ? undefined : caches.default;
  const key = new Request(`https://native-chart.cache.invalid/${CHART_IMAGE_RENDERER_VERSION}/${Object.values(input).map(value => encodeURIComponent(String(value))).join("/")}`);
  const hit = await cache?.match(key);
  if (hit) return { png: new Uint8Array(await hit.arrayBuffer()), width: Number(hit.headers.get("X-Haneoka-Image-Width")), height: Number(hit.headers.get("X-Haneoka-Image-Height")) };
  if (env.IMAGE_RENDERER_RATE_LIMITER && !(await env.IMAGE_RENDERER_RATE_LIMITER.limit({ key: "native-chart-images" })).success) throw new Error("native_renderer_busy");
  if (!env.TOOLS_SERVICE_URL || !env.TOOLS_SERVICE_TOKEN) {
    if (!env.BROWSER) throw new Error("native_renderer_unavailable");
    const { renderBrowserChart } = await import("./chart-browser-renderer");
    const result = await renderBrowserChart(env.BROWSER, input, source);
    if (cache) {
      const put = cache.put(key, new Response(result.png, { headers: { "Cache-Control": "public, max-age=86400", "X-Haneoka-Image-Width": String(result.width), "X-Haneoka-Image-Height": String(result.height) } }));
      if (waitUntil) waitUntil(put); else await put;
    }
    return result;
  }
  const target = new URL("v1/chart-image", env.TOOLS_SERVICE_URL.replace(/\/?$/u, "/"));
  if (target.username || target.password || (target.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(target.hostname))) throw new Error("native_renderer_url_invalid");
  for (const [name, value] of Object.entries(input)) target.searchParams.set(name, String(value));
  const response = await fetch(target, { headers: { Authorization: `Bearer ${env.TOOLS_SERVICE_TOKEN}`, Accept: "image/png", ...(source?.headers.has("Cookie") ? { "X-Haneoka-Resource-Cookie": source.headers.get("Cookie")! } : {}), ...(source?.headers.has("Authorization") ? { "X-Haneoka-Resource-Authorization": source.headers.get("Authorization")! } : {}), ...(source && new URL(source.url).searchParams.has("spoiler") ? { "X-Haneoka-Resource-Spoiler": new URL(source.url).searchParams.get("spoiler")! } : {}) }, redirect: "manual", signal: AbortSignal.timeout(25000) });
  if (!response.ok || response.headers.get("Content-Type") !== "image/png" || response.headers.get("X-Haneoka-Release-Id") !== input.release || response.headers.get("X-Haneoka-Chart-Renderer") !== CHART_IMAGE_RENDERER_VERSION) {
    await response.body?.cancel(); throw new Error("native_renderer_failed");
  }
  if (!response.body) throw new Error("native_renderer_failed");
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length; if (size > 8 * 1024 * 1024) throw new RangeError("chart_render_budget"); chunks.push(value);
    }
  } finally { await reader.cancel(); reader.releaseLock(); }
  const png = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { png.set(chunk, offset); offset += chunk.length; }
  if (cache) {
    const headers = new Headers(response.headers); headers.set("Cache-Control", "public, max-age=86400");
    const put = cache.put(key, new Response(png, { headers }));
    if (waitUntil) waitUntil(put); else await put;
  }
  return { png, width: Number(response.headers.get("X-Haneoka-Image-Width")), height: Number(response.headers.get("X-Haneoka-Image-Height")) };
}
