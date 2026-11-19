// L3 — GEB
// Input: Canonical Markdown requests for public entities.
// Output: One build-produced Markdown document or an asset miss.
// Pos: [Map](L2.md); public Markdown detail delivery.
// Effects/Dependencies: Reads one small ASSETS shard; no rendering or external storage.
import { markdownShardPath } from "../src/lib/markdown-document.ts";

export async function serveMarkdownEntity(request: Request, url: URL, assets: Fetcher): Promise<Response | null> {
  const pathname = markdownShardPath(url.pathname);
  if (!pathname) return null;
  const asset = await assets.fetch(new URL(pathname, url));
  if (asset.status === 404) return null;
  if (!asset.ok)
    return new Response("Markdown temporarily unavailable", { status: 503, headers: { "Cache-Control": "no-store" } });
  const documents = await asset.json<Record<string, string>>();
  const markdown = documents[url.pathname];
  if (typeof markdown !== "string") return null;
  const headers = new Headers({
    "Content-Type": "text/markdown; charset=utf-8",
    "Cache-Control": "public, max-age=300, stale-while-revalidate=3600",
    "Content-Language": url.pathname.split("/")[2]!,
    "X-Content-Type-Options": "nosniff",
  });
  const shardEtag = asset.headers.get("ETag");
  if (shardEtag) {
    const etag = `W/"${shardEtag.replace(/^(?:W\/)?"|"$/gu, "")}:${encodeURIComponent(url.pathname)}"`;
    headers.set("ETag", etag);
    if (request.headers.get("If-None-Match") === etag) return new Response(null, { status: 304, headers });
  }
  return new Response(request.method === "HEAD" ? null : markdown, { headers });
}
