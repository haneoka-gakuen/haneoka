// L3 — GEB
// Input: 浏览器绑定与固定的歌曲／release 身份。
// Output: 与网页共用画布导出的 PNG。
// Pos: [Map](L2.md)；托管浏览器的原生图片执行适配。
// Effects/Dependencies: 启动隔离浏览器、读取公开素材，完成后关闭会话；不运行配队搜索。
import { CHART_IMAGE_RENDERER_VERSION } from "../src/lib/public-tools/chart-contract";
import type { launch } from "@cloudflare/playwright";
import type { NativeChartRenderInput } from "./chart-native-renderer";

export type ChartBrowserBinding = Parameters<typeof launch>[0];

export async function renderBrowserChart(binding: ChartBrowserBinding, input: NativeChartRenderInput, source?: Request) {
  const { launch } = await import("@cloudflare/playwright");
  const browser = await launch(binding);
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    page.setDefaultTimeout(20000);
    const origin = new URL(input.origin || "https://haneoka.org").origin;
    await context.route("**/*", route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== origin) return route.abort();
      const headers = { ...request.headers() };
      for (const name of ["Cookie", "Authorization"]) if (source?.headers.has(name)) headers[name.toLowerCase()] = source.headers.get(name)!;
      const override = source && new URL(source.url).searchParams.get("spoiler");
      if (override !== undefined && override !== null) url.searchParams.set("spoiler", override);
      return route.continue({ headers, url: url.toString() });
    });
    await page.goto(`${origin}/tools/render.html`, { waitUntil: "load", timeout: 20000 });
    const result = await page.evaluate(async ({ input, origin }) => {
      const { renderChartImage } = await import(`${origin}/tools/chart-image.js`);
      const image = await renderChartImage({ ...input, apiBase: `${origin}/api/v1/`, signal: AbortSignal.timeout(20000) });
      const bytes = new Uint8Array(await image.blob.arrayBuffer());
      let binary = "";
      for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
      return { base64: btoa(binary), width: image.width, height: image.height, release: image.identity.releaseId, renderer: image.renderer };
    }, { input, origin });
    if (result.release !== input.release || result.renderer !== CHART_IMAGE_RENDERER_VERSION || result.base64.length > 12 * 1024 * 1024) throw new Error("native_renderer_failed");
    const binary = atob(result.base64);
    const png = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) png[index] = binary.charCodeAt(index);
    return { png, width: result.width, height: result.height };
  } finally { await browser.close(); }
}
