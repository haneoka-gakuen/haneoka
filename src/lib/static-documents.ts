// L3 — GEB
// Input: 静态文档路径、分片／内容记录和字节流。
// Output: 格式常量、路径规范化、校验及内容流组合。
// Pos: [Map](L2-2.md)；构建端与 Worker 共享的静态文档格式。
// Effects/Dependencies: 使用 Web Streams 等基础接口；调用者负责实际存储与网络读取。
import { fnv1a32Shard } from "./hash-partition.ts";
import { assetStaticLookupPath } from "./asset-static-routing.ts";
import { playlistStaticLookupPath } from "./playlists/static-routing.ts";
import { communityChartShellPath } from "./community-chart-route.ts";

export const STATIC_DOCUMENT_SCHEMA = "haneoka-static-documents-v2";
export const STATIC_DOCUMENT_INDEX_ROOT = "/provider-static/index";
export const STATIC_DOCUMENT_CONTENT_ROOT = "static-documents/v1/content";
export const STATIC_DOCUMENT_ASSET_ROOT = "/provider-static/content";
export const STATIC_DOCUMENT_CONTENT_INDEX_ROOT = "/provider-static/content-index";
export const STATIC_DOCUMENT_CONTENT_INDEX_SCHEMA = "haneoka-static-content-index-v1";
export const STATIC_DOCUMENT_PACK_BYTES = 1024 * 1024;
/** Legacy publications omit this final output seal and cannot share mutable index caches. */
export function staticPublicationOutputIdentity(value: unknown): string | null {
  if (value === undefined) return null;
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value))
    throw new Error("Invalid static publication output identity");
  return value;
}
export const staticDocumentPackPath = (sha256: string): string => `${STATIC_DOCUMENT_ASSET_ROOT}/pack-${sha256}.bin`;
export interface StaticDocumentContentLocation {
  packSha256: string;
  offset: number;
  gzipBytes: number;
  packBytes: number;
}
/** The .bin extension keeps precompressed bytes opaque to the asset server. */
export const staticDocumentAssetPath = (sha256: string): string => `${STATIC_DOCUMENT_ASSET_ROOT}/${sha256}.bin`;
export const STATIC_DOCUMENT_UNDERLAY_START = "<!--haneoka-static-underlay:start-->";
export const STATIC_DOCUMENT_UNDERLAY_END = "<!--haneoka-static-underlay:end-->";
export function acceptsGzip(value: string | null): boolean {
  let gzip: number | undefined;
  let wildcard: number | undefined;
  for (const part of value?.split(",") || []) {
    const match = /^\s*(gzip|\*)\s*(?:;\s*q\s*=\s*(0(?:\.\d{0,3})?|1(?:\.0{0,3})?))?\s*$/iu.exec(part);
    if (!match) continue;
    const quality = match[2] === undefined ? 1 : Number(match[2]);
    if (match[1]!.toLowerCase() === "gzip") gzip = Math.max(gzip ?? 0, quality);
    else wildcard = Math.max(wildcard ?? 0, quality);
  }
  return (gzip ?? wildcard ?? 0) > 0;
}
export interface StaticDocumentChunk {
  sha256: string;
  bytes: number;
  gzipBytes: number;
}
export interface StaticDocumentRecord extends StaticDocumentChunk {
  contentType: string;
  /** Ordered, independently compressed bytes of the complete HTML document. */
  chunks?: StaticDocumentChunk[];
}
export const staticDocumentChunks = (record: StaticDocumentRecord): readonly StaticDocumentChunk[] =>
  record.chunks || [record];

function isContentChunk(value: unknown): value is StaticDocumentChunk {
  if (!value || typeof value !== "object") return false;
  const chunk = value as Partial<StaticDocumentChunk>;
  return (
    typeof chunk.sha256 === "string" &&
    /^[a-f0-9]{64}$/u.test(chunk.sha256) &&
    Number.isSafeInteger(chunk.bytes) &&
    Number(chunk.bytes) > 0 &&
    Number.isSafeInteger(chunk.gzipBytes) &&
    Number(chunk.gzipBytes) > 0
  );
}
export function isStaticDocumentRecord(value: unknown): value is StaticDocumentRecord {
  if (!isContentChunk(value)) return false;
  const record = value as StaticDocumentRecord;
  if (!["text/html; charset=utf-8", "application/json; charset=utf-8"].includes(record.contentType)) return false;
  if (record.chunks === undefined) return true;
  return (
    record.contentType === "text/html; charset=utf-8" &&
    Array.isArray(record.chunks) &&
    record.chunks.length > 0 &&
    record.chunks.length <= 3 &&
    record.chunks.every(isContentChunk) &&
    record.chunks.reduce((sum, chunk) => sum + chunk.bytes, 0) === record.bytes &&
    record.chunks.reduce((sum, chunk) => sum + chunk.gzipBytes, 0) === record.gzipBytes
  );
}

/** Concatenate immutable byte streams with backpressure and cancellation. */
export function joinStaticDocumentStreams(streams: readonly ReadableStream<Uint8Array>[]): ReadableStream<Uint8Array> {
  let index = 0;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let cancelled = false;
  const cancel = async (reason: unknown) => {
    if (cancelled) return;
    cancelled = true;
    const pending = streams.slice(index + (reader ? 1 : 0)).map((stream) => stream.cancel(reason));
    if (reader) {
      const active = reader;
      pending.push(active.cancel(reason).finally(() => active.releaseLock()));
      reader = undefined;
    }
    await Promise.allSettled(pending);
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        while (index < streams.length) {
          reader ??= streams[index]!.getReader();
          const result = await reader.read();
          if (cancelled) return;
          if (!result.done) {
            controller.enqueue(result.value);
            return;
          }
          reader.releaseLock();
          reader = undefined;
          index++;
        }
        controller.close();
      } catch (error) {
        if (cancelled) return;
        await cancel(error);
        controller.error(error);
      }
    },
    cancel,
  });
}
export const staticDocumentShard = (pathname: string): string => fnv1a32Shard(pathname);
/** Original locale URLs map to their build-produced index document. */
export function coreStaticDocumentPath(pathname: string): string | undefined {
  if (!/^\/(?:static-views\/|(?:(?:jp|intl)\/)?(?:ja|en|ko|zh-CN|zh-TW)(?:\/|$))/u.test(pathname)) return;
  if (/[\\\u0000-\u001f\u007f]/u.test(pathname) || pathname.includes("//")) return;
  const parts = pathname.split("/").filter(Boolean);
  try {
    if (
      parts.some((part) => {
        const value = decodeURIComponent(part);
        return value === "." || value === ".." || /[\\/\u0000-\u001f\u007f]/u.test(value);
      })
    )
      return;
  } catch {
    return;
  }
  if (pathname.endsWith("/index.html")) return pathname;
  if (!pathname.endsWith("/")) return;
  return `${pathname.replace(/\/+$/u, "")}/index.html`;
}
/** Internal SPA and preview redirects still use these direct assets. */
export function isCoreFallbackShell(pathname: string): boolean {
  if (!pathname.endsWith("/index.html")) return false;
  const routePath = pathname.slice(0, -"index.html".length);
  const parts = routePath.split("/").filter(Boolean);
  if (/^(ja|en|ko|zh-CN|zh-TW)$/u.test(parts[0] || "")) {
    if (parts.length <= 2) return true;
    if (["community/forums", "community/feeds", "community/charts", "admin/forums", "catalog/assets"].includes(parts.slice(1).join("/"))) return true;
  }
  if (/^\/(jp|intl)\/(ja|en|ko|zh-CN|zh-TW)\/(assets\/|announcements\/detail\/)$/u.test(routePath)) return true;
  if (/^\/(jp|intl)\/(ja|en|ko|zh-CN|zh-TW)\/(?:calendar\/|announcements\/)?$/u.test(routePath)) return true;
  return false;
}
export function staticDocumentLookupPath(pathname: string): string | undefined {
  const chartShell = communityChartShellPath(pathname);
  if (chartShell) return coreStaticDocumentPath(chartShell);
  if (/^\/data\/chart-rates\/(?:jp|intl)\.json$/u.test(pathname)) return pathname;
  if (pathname === "/data/sponsors/v1.json") return pathname;
  if (/^\/(?:provider-static|asset-static|playlist-static)\//u.test(pathname)) {
    const parts = pathname.split("/").filter(Boolean);
    if (pathname.endsWith("/index.html") && (parts[0] !== "provider-static" || parts.length === 6))
      pathname = pathname.slice(0, -"/index.html".length);
    pathname = pathname.replace(/\/$/u, "");
  }
  const asset = assetStaticLookupPath(pathname);
  if (asset) return asset;
  const playlist = playlistStaticLookupPath(pathname);
  if (playlist) return playlist;
  const core = coreStaticDocumentPath(pathname);
  if (core) return core;
  const json = pathname.endsWith(".json");
  const html = providerStaticDocumentPath(json ? pathname.slice(0, -5) + ".html" : pathname);
  return html && (json ? html.slice(0, -5) + ".json" : html);
}
export function providerStaticDocumentPath(pathname: string): string | undefined {
  const parts = pathname.split("/").filter(Boolean);
  if (
    parts.length !== 5 ||
    parts[0] !== "provider-static" ||
    !["bestdori", "sekai"].includes(parts[1]!) ||
    !["ja", "en", "ko", "zh-CN", "zh-TW"].includes(parts[2]!) ||
    !/^(?:songs|cards|stories-[a-z]+)$/u.test(parts[3]!)
  )
    return;
  const id = parts[4]!.replace(/\.html$/u, "");
  let decoded: string;
  try {
    decoded = decodeURIComponent(id);
  } catch {
    return;
  }
  if (!decoded || decoded === "." || decoded === ".." || /[\\/\u0000-\u001f\u007f]/u.test(decoded)) return;
  return `/${parts.slice(0, 4).join("/")}/${encodeURIComponent(decoded)}.html`;
}
