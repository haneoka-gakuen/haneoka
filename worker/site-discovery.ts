// L3 — GEB
// Input: 当前请求域名、已发布 sitemap／robots 静态资产与社区显示配置。
// Output: 同域发现地址、过滤隐藏页面的 sitemap 和按域名／策略区分的验证器。
// Pos: [Map](L2.md)；公开搜索发现文档的 Worker 适配器。
// Effects/Dependencies: 读取 ASSETS；逐条流式转换 XML，保留构建期的完整公开地址集。
import { CANONICAL_ORIGIN, siteOrigin } from "../src/lib/site-origin";
import { communityPagesEnabled, isCommunityPagePath } from "../src/lib/site-community";

export async function serveSiteDiscovery(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  const robots = url.pathname === "/robots.txt";
  if (
    (!robots && !/^\/sitemap(?:-(?:ja|en|zh-TW|zh-CN|ko)-[1-9]\d*)?\.xml$/u.test(url.pathname)) ||
    (request.method !== "GET" && request.method !== "HEAD")
  )
    return null;
  const assetHeaders = new Headers(request.headers);
  for (const name of ["If-None-Match", "If-Modified-Since", "Range", "If-Range"]) assetHeaders.delete(name);
  assetHeaders.set("Accept-Encoding", "identity");
  const asset = await env.ASSETS.fetch(new Request(request, { headers: assetHeaders }));
  if (!asset.ok) return asset;
  const origin = siteOrigin(url);
  const community = communityPagesEnabled(url.hostname, env.COMMUNITY_HIDDEN_HOSTS);
  const headers = new Headers(asset.headers);
  for (const name of ["Content-Length", "Content-Encoding", "Last-Modified"]) headers.delete(name);
  const etag = headers.get("ETag")?.replace(/"$/u, `:discovery-v1:${url.hostname}:${community ? 1 : 0}"`);
  if (etag) {
    headers.set("ETag", etag);
    if (
      request.headers
        .get("If-None-Match")
        ?.split(",")
        .some((value) => value.trim() === "*" || value.trim().replace(/^W\//u, "") === etag.replace(/^W\//u, ""))
    ) {
      await asset.body?.cancel();
      return new Response(null, { status: 304, headers });
    }
  }
  if (!asset.body || request.method === "HEAD") return new Response(null, { status: asset.status, headers });
  const separator = robots ? "\n" : url.pathname === "/sitemap.xml" ? "</sitemap>" : "</url>";
  const rewrite = (record: string) => {
    if (!community && !robots) {
      const loc = /<url><loc>([^<]+)<\/loc>/u.exec(record);
      if (loc && isCommunityPagePath(new URL(loc[1]!.replaceAll("&amp;", "&")).pathname))
        record = record.slice(0, record.indexOf("<url>"));
    }
    return record.replaceAll(`${CANONICAL_ORIGIN}/`, `${origin}/`);
  };
  let pending = "";
  const body = asset.body
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(
      new TransformStream<string, string>({
        transform(chunk, controller) {
          pending += chunk;
          let end: number;
          while ((end = pending.indexOf(separator)) !== -1) {
            end += separator.length;
            controller.enqueue(rewrite(pending.slice(0, end)));
            pending = pending.slice(end);
          }
        },
        flush(controller) {
          controller.enqueue(rewrite(pending));
        },
      }),
    )
    .pipeThrough(new TextEncoderStream());
  return new Response(body, { status: asset.status, headers });
}
