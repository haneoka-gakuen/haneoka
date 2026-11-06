import {
  DEFAULT_VISIBILITY_POLICY,
  parseVisibilityPolicy,
  type ContentVisibilitySettings,
} from "../src/lib/content-visibility-policy";

export async function readContentVisibility(env: Env): Promise<ContentVisibilitySettings> {
  const row = await env.DB.withSession("first-primary")
    .prepare("SELECT policy, version, updated_at AS updatedAt FROM content_visibility_setting WHERE id = 1")
    .first<{ policy: string; version: number; updatedAt: number }>();
  return {
    policy: row
      ? (parseVisibilityPolicy(JSON.parse(row.policy)) ?? DEFAULT_VISIBILITY_POLICY)
      : DEFAULT_VISIBILITY_POLICY,
    version: row?.version ?? 1,
    updatedAt: row?.updatedAt ?? 0,
  };
}
export async function handleContentVisibilityRequest(request: Request, env: Env): Promise<Response | null> {
  if (new URL(request.url).pathname !== "/api/v1/content-visibility") return null;
  if (request.method !== "GET" && request.method !== "HEAD")
    return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });
  const settings = await readContentVisibility(env);
  const etag = `"visibility-${settings.version}"`;
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "public, max-age=0, must-revalidate",
    ETag: etag,
  };
  return request.headers.get("If-None-Match") === etag
    ? new Response(null, { status: 304, headers })
    : new Response(request.method === "HEAD" ? null : JSON.stringify(settings), { headers });
}
