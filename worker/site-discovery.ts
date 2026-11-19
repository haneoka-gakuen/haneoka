// L3 — GEB
// Input: 当前请求域名与已发布 sitemap／robots 静态资产。
// Output: .org 索引、静态语言分片和从英文分片流式派生的界面语言分片。
// Pos: [Map](L2.md)；公开搜索发现文档的 Worker 适配器。
// Effects/Dependencies: sitemap 规范化至主站；扩展语言只读取已有的英文 ASSETS。
import { CANONICAL_ORIGIN, isSiteHostname } from "../src/lib/site-origin";
import { interfaceLanguageFromPath, interfacePath } from "../src/i18n/interface-route";
import type { InterfaceLanguageId } from "../src/i18n/interface-language-options";

function localizedSitemap(body: ReadableStream<Uint8Array>, locale: InterfaceLanguageId): ReadableStream<Uint8Array> {
  let pending = "";
  return body
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(
      new TransformStream<string, string>({
        transform(chunk, controller) {
          pending += chunk;
          const end = pending.lastIndexOf("</loc>");
          if (end === -1) return;
          const length = end + "</loc>".length;
          controller.enqueue(
            pending
              .slice(0, length)
              .replace(
                /(<loc>https:\/\/haneoka\.org)(\/[^<]+)(<\/loc>)/gu,
                (_match, origin: string, path: string, close: string) => origin + interfacePath(path, locale) + close,
              ),
          );
          pending = pending.slice(length);
        },
        flush(controller) {
          if (pending) controller.enqueue(pending);
        },
      }),
    )
    .pipeThrough(new TextEncoderStream());
}

export async function serveSiteDiscovery(request: Request, env: Env): Promise<Response | null> {
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  const url = new URL(request.url);
  const robots = url.pathname === "/robots.txt";
  const segment = /^\/sitemap-([a-z]{2})-([1-9]\d*)\.xml$/u.exec(url.pathname);
  const language = segment && interfaceLanguageFromPath(`/${segment[1]}/`);
  if (!robots && !language && !/^\/sitemap(?:-(?:ja|en|zh-TW|zh-CN|ko)-[1-9]\d*)?\.xml$/u.test(url.pathname))
    return null;
  if (!robots && isSiteHostname(url.hostname) && url.origin !== CANONICAL_ORIGIN)
    return new Response(null, {
      status: 308,
      headers: {
        Location: `${CANONICAL_ORIGIN}${url.pathname}${url.search}`,
        "Cache-Control": "public, max-age=3600",
      },
    });
  if (!language || !segment) return env.ASSETS.fetch(request);

  url.pathname = `/sitemap-en-${segment[2]}.xml`;
  url.search = "";
  const source = await env.ASSETS.fetch(new Request(url, { method: request.method }));
  if (!source.ok) return source;
  const headers = new Headers(source.headers);
  for (const name of ["Content-Encoding", "Content-Length", "ETag", "Last-Modified", "Accept-Ranges"])
    headers.delete(name);
  return new Response(source.body && localizedSitemap(source.body, language.value), {
    headers,
    status: source.status,
  });
}
