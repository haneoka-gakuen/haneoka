// L3 — GEB
// Input: 当前请求域名与已发布 sitemap／robots 静态资产。
// Output: .org 规范 sitemap 入口与声明主站索引的 robots。
// Pos: [Map](L2.md)；公开搜索发现文档的 Worker 适配器。
// Effects/Dependencies: 非主站 sitemap 永久重定向至主站；ASSETS 保留静态验证器与完整公开地址集。
import { CANONICAL_ORIGIN, isSiteHostname } from "../src/lib/site-origin";

export async function serveSiteDiscovery(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  const robots = url.pathname === "/robots.txt";
  if (
    (!robots && !/^\/sitemap(?:-(?:ja|en|zh-TW|zh-CN|ko)-[1-9]\d*)?\.xml$/u.test(url.pathname)) ||
    (request.method !== "GET" && request.method !== "HEAD")
  )
    return null;
  if (!robots && isSiteHostname(url.hostname) && url.origin !== CANONICAL_ORIGIN)
    return new Response(null, {
      status: 308,
      headers: {
        Location: `${CANONICAL_ORIGIN}${url.pathname}${url.search}`,
        "Cache-Control": "public, max-age=3600",
      },
    });
  return env.ASSETS.fetch(request);
}
