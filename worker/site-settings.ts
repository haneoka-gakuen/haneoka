import { spoilerCookieEnabled } from "../src/lib/spoiler-content";

export type SiteSettings = {
  showTestServerContent: boolean;
  version: number;
  updatedAt: number;
};

/** Read current administrative policy, without a stale per-isolate flag cache. */
export async function readSiteSettings(env: Env): Promise<SiteSettings> {
  const row = await env.DB.withSession("first-primary").prepare(
    `SELECT show_test_server_content AS enabled, version, updated_at AS updatedAt
     FROM site_setting WHERE id = 1`,
  ).first<{ enabled: number; version: number; updatedAt: number }>();
  return { showTestServerContent: row?.enabled !== 0, version: row?.version ?? 1, updatedAt: row?.updatedAt ?? 0 };
}

/** Stream the flag into HTML; immutable scripts, styles and resource JSON keep their own caches. */
export function testContentAllowed(request: Request, settings: SiteSettings): boolean {
  return settings.showTestServerContent && spoilerCookieEnabled(request.headers.get("Cookie"));
}

export function applySiteSettings(request: Request, response: Response, settings: SiteSettings): Response {
  if (!response.headers.get("Content-Type")?.toLowerCase().includes("text/html")) return response;
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "public, max-age=0, must-revalidate");
  const vary = new Set((headers.get("Vary") || "").split(",").map((value) => value.trim()).filter(Boolean));
  vary.add("Cookie");
  headers.set("Vary", [...vary].join(", "));
  headers.delete("Content-Length");
  const assetEtag = headers.get("ETag");
  const spoilers = spoilerCookieEnabled(request.headers.get("Cookie"));
  const etag = assetEtag?.replace(/"$/u, `:site-${settings.version}:spoilers-${spoilers ? 1 : 0}"`);
  if (etag) {
    headers.set("ETag", etag);
    if (request.headers.get("If-None-Match") === etag)
      return new Response(null, { status: 304, headers });
  }
  const output = new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  if (request.method === "HEAD") return new Response(null, { status: output.status, headers });
  return new HTMLRewriter().on("html", {
    element(element) {
      element.setAttribute("data-show-test-server-content", settings.showTestServerContent ? "1" : "0");
      element.setAttribute("data-site-settings-version", String(settings.version));
      element.setAttribute("data-spoiler-content", spoilers ? "1" : "0");
    },
  }).transform(output);
}
