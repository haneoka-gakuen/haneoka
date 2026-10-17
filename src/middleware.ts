// L3 — GEB
// Input: Astro 请求上下文、构建模式与供应方静态载荷。
// Output: 开发路由重写、首屏样式及打包后的 HTML 响应。
// Pos: [Map](L2.md)；前端请求与静态文档的连接点。
// Effects/Dependencies: 开发读取本地载荷；生产预渲染可写静态文档；调用下游渲染。
import { defineMiddleware } from "astro:middleware";
import fs from "node:fs";
import path from "node:path";
import { staticDocumentLookupPath, coreStaticDocumentPath } from "./lib/static-documents";
import { writeStaticDocument } from "./server/static-documents";
import { readProviderStaticData } from "./server/provider-static-data";
import { providerEntityManifestEntry, providerEntityRoot, readProviderEntityPayload } from "./server/provider-entity-manifest";
import { providerEntityFromUrl, providerEntityPhysicalPath } from "./lib/provider-entity-routing";
import { providerEntityHtmlPath } from "./lib/provider-entity-data";
import { withMaterialStylePreloads } from "./server/material-ssr-styles";

export const onRequest = defineMiddleware(async (context, next) => {
  if (import.meta.env.DEV && /^\/provider-static\/data\/[a-f0-9]{64}\.json$/u.test(context.url.pathname)) {
    try {
      return Response.json(readProviderStaticData(context.url.pathname));
    } catch {
      return new Response("Not found", { status: 404 });
    }
  }
  if (import.meta.env.DEV && context.url.pathname.startsWith("/provider-static/") && context.url.pathname.endsWith(".json")) {
    if (!fs.existsSync(path.join(providerEntityRoot(), "manifest.json"))) return new Response("Not found", { status: 404 });
    const entry = providerEntityManifestEntry(context.url.pathname, true);
    return entry ? Response.json(readProviderEntityPayload(entry), { headers: { "Cache-Control": "no-cache", ETag: `"${entry.sha256}"` } }) : new Response("Not found", { status: 404 });
  }
  if (import.meta.env.DEV) {
    const selected = providerEntityFromUrl(context.url);
    if (selected && fs.existsSync(path.join(providerEntityRoot(), "manifest.json"))) {
      const entry = providerEntityManifestEntry(providerEntityHtmlPath(selected), true);
      if (entry) {
        const target = new URL(providerEntityPhysicalPath(entry), context.url);
        target.search = context.url.search;
        return context.rewrite(target);
      }
    }
    const community = /^\/(ja|en|zh-TW|zh-CN|ko)\/community\/(posts\/[^/]+(?:\/edit)?|users\/[^/]+|forums\/[^/]+)\/?$/u.exec(context.url.pathname);
    if (community) {
      const target = new URL(`/${community[1]}/community/${community[2]!.startsWith("forums/") ? "forums/" : ""}`, context.url);
      target.search = context.url.search;
      return context.rewrite(target);
    }
  }
  let response = await next();
  if (response.body && response.status === 200 && response.headers.get("Content-Type")?.startsWith("text/html")) {
    const headers = new Headers(response.headers);
    for (const name of ["Content-Length", "Content-Encoding", "ETag"]) headers.delete(name);
    response = new Response(withMaterialStylePreloads(await response.text()), {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
  const pathname = staticDocumentLookupPath(context.url.pathname);
  if (!import.meta.env.PROD || !context.isPrerendered || !pathname || coreStaticDocumentPath(pathname) || response.status !== 200) return response;
  const record = await writeStaticDocument(pathname, await response.text());
  return new Response(`<!-- static-document:${record.sha256} -->`, {
    status: 200, headers: { "Content-Type": "text/html; charset=utf-8" },
  });
});
