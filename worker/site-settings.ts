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
  return { showTestServerContent: row?.enabled === 1, version: row?.version ?? 1, updatedAt: row?.updatedAt ?? 0 };
}

/** Stream the flag into HTML; immutable scripts, styles and resource JSON keep their own caches. */
export function applySiteSettings(request: Request, response: Response, settings: SiteSettings): Response {
  if (!response.headers.get("Content-Type")?.toLowerCase().includes("text/html")) return response;
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "public, max-age=0, must-revalidate");
  headers.delete("Content-Length");
  const assetEtag = headers.get("ETag");
  const etag = assetEtag?.replace(/"$/u, `:site-${settings.version}"`);
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
    },
  }).transform(output);
}
