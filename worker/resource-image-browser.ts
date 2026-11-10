// L3 — GEB
// Input: 资源图片状态与 Browser 绑定。
// Output: 网页共享渲染器的二进制图片。
// Pos: [Map](L2.md)；资源图片的托管浏览器适配。
// Effects/Dependencies: 隔离浏览器会话，只读取本站素材，完成或超时后关闭会话。
import type { ChartBrowserBinding } from "./chart-browser-renderer";
import type { ImageRenderRequest } from "../src/lib/public-tools/image-routes";
export async function renderBrowserResource(binding: ChartBrowserBinding, input: ImageRenderRequest, origin: string, source?: Request) {
  const { launch } = await import("@cloudflare/playwright");
  const browser = await launch(binding);
  const timer = setTimeout(() => { void browser.close(); }, 50000);
  try {
    const width = input.kind === "team" && typeof input.data.width === "number" ? input.data.width : 1280;
    const context = await browser.newContext({ viewport: { width, height: 800 }, deviceScaleFactor: 1, serviceWorkers: "block" });
    await context.route("**/*", route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== origin || !["GET", "HEAD"].includes(request.method()) || /^\/api\/.*\/image\.png$/u.test(url.pathname)) return route.abort();
      const headers = { ...request.headers() };
      for (const name of ["Cookie", "Authorization"]) if (source?.headers.has(name)) headers[name.toLowerCase()] = source.headers.get(name)!;
      const override = source && new URL(source.url).searchParams.get("spoiler");
      if (override !== undefined && override !== null) url.searchParams.set("spoiler", override);
      return route.continue({ headers, url: url.toString() });
    });
    const page = await context.newPage();
    await page.goto(`${origin}/tools/render.html`, { waitUntil: "load", timeout: 20000 });
    const result = await page.evaluate(async ({ input, origin }) => {
      const { renderResourceImageTransport } = await import(`${origin}/tools/images.js`);
      return renderResourceImageTransport(input, { apiBase: `${origin}/api/v1/`, signal: AbortSignal.timeout(45000) });
    }, { input, origin });
    if (result.error) return Response.json(result.error, { status: result.error.status });
    const binary = atob(result.base64); const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < bytes.length; index++) bytes[index] = binary.charCodeAt(index);
    return new Response(bytes, { headers: { "Content-Type": result.contentType, "Content-Length": String(bytes.length), ...(result.width ? { "X-Haneoka-Image-Width": String(result.width), "X-Haneoka-Image-Height": String(result.height) } : {}) } });
  } finally { clearTimeout(timer); await browser.close(); }
}
