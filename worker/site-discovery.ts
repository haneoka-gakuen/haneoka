// L3 — GEB
// Input: 当前请求域名与已发布 sitemap／robots 静态资产。
// Output: 同域 robots、sitemap 索引和语言分片，以及对应的缓存验证器。
// Pos: [Map](L2.md)；公开搜索发现文档的 Worker 适配器。
// Effects/Dependencies: 读取共享 ASSETS；扩展语言从英文分片流式派生。
import { CANONICAL_ORIGIN, siteOrigin } from "../src/lib/site-origin.ts";
import { interfaceLanguageFromPath, interfacePath } from "../src/i18n/interface-route.ts";
import type { InterfaceLanguageId } from "../src/i18n/interface-language-options";

function rewriteSitemap(body: ReadableStream<Uint8Array>, origin: string, locale?: InterfaceLanguageId): ReadableStream<Uint8Array> {
  const close = "</loc>";
  let pending = "";
  return body
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(
      new TransformStream<string, string>({
        transform(chunk, controller) {
          pending += chunk;
          const end = pending.lastIndexOf(close);
          if (end === -1) return;
          const length = end + close.length;
          controller.enqueue(
            pending
              .slice(0, length)
              .replace(
                /<loc>(https:\/\/[^/<]+)(\/[^<]*)<\/loc>/gu,
                (match, source: string, path: string) => source === CANONICAL_ORIGIN
                  ? `<loc>${origin}${locale ? interfacePath(path, locale) : path}${close}` : match,
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
  const origin = siteOrigin(url);
  if (origin === CANONICAL_ORIGIN && !language) return env.ASSETS.fetch(request);

  if (language && segment) {
    url.pathname = `/sitemap-en-${segment[2]}.xml`;
    url.search = "";
  }
  const source = await env.ASSETS.fetch(new Request(url, {
    method: request.method,
    headers: { "Accept-Encoding": "identity" },
  }));
  if (!source.ok) return source;
  const headers = new Headers(source.headers);
  for (const name of ["Content-Encoding", "Content-Length", "ETag", "Last-Modified", "Accept-Ranges", "Content-Range"])
    headers.delete(name);
  const sourceTag = /^(?:W\/)?"([^"]+)"$/u.exec(source.headers.get("ETag") ?? "")?.[1];
  const tag = sourceTag && `"${sourceTag}:discovery-v2:${origin}:${language?.value ?? ""}"`;
  if (tag) headers.set("ETag", `W/${tag}`);
  if (request.headers.get("If-None-Match")?.split(",").some((value) => {
    const candidate = value.trim();
    return candidate === "*" || candidate.replace(/^W\//u, "") === tag;
  })) {
    await source.body?.cancel();
    return new Response(null, { status: 304, headers });
  }
  if (!source.body) return new Response(null, { status: source.status, headers });
  const body = robots
    ? (await source.text()).replace(`${CANONICAL_ORIGIN}/sitemap.xml`, `${origin}/sitemap.xml`)
    : rewriteSitemap(source.body, origin, language?.value);
  return new Response(body, { status: source.status, headers });
}
