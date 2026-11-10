import {
  DEFAULT_VISIBILITY_POLICY,
  parseVisibilityPolicy,
  type ContentVisibilitySettings,
} from "../src/lib/content-visibility-policy";
import { getAuthSession } from "./auth";
import { communityAccessState } from "./access";
import type { UserGroup } from "../src/lib/user-roles";

export async function contentUserGroup(request: Request, env: Env): Promise<UserGroup> {
  if (!request.headers.has("Authorization") && !/(?:^|;\s*)(?:__Secure-|__Host-)?haneoka\.session_/u.test(request.headers.get("Cookie") || "")) return "guest";
  const session = await getAuthSession(request, env, { authoritative: true }).catch(() => null);
  if (!session?.user?.id) return "guest";
  const profile = await communityAccessState(env, session.user.id, ["sign_in"]);
  return profile?.status === "active" && !profile.restriction ? profile.role : "guest";
}

const policyCache = new WeakMap<object, { expiresAt: number; value: ContentVisibilitySettings }>();
export async function readContentVisibility(env: Env, fresh = false): Promise<ContentVisibilitySettings> {
  const cached = policyCache.get(env.ASSET_BUCKET);
  if (!fresh && cached && cached.expiresAt > Date.now()) return cached.value;
  const row = await env.DB.withSession("first-primary")
    .prepare("SELECT policy, version, updated_at AS updatedAt FROM content_visibility_setting WHERE id = 1")
    .first<{ policy: string; version: number; updatedAt: number }>();
  const value = {
    policy: row
      ? (parseVisibilityPolicy(JSON.parse(row.policy)) ?? DEFAULT_VISIBILITY_POLICY)
      : DEFAULT_VISIBILITY_POLICY,
    version: row?.version ?? 1,
    updatedAt: row?.updatedAt ?? 0,
  };
  policyCache.set(env.ASSET_BUCKET, { value, expiresAt: Date.now() + 5000 });
  return value;
}
export async function handleContentVisibilityRequest(request: Request, env: Env): Promise<Response | null> {
  if (new URL(request.url).pathname !== "/api/v1/content-visibility") return null;
  if (request.method !== "GET" && request.method !== "HEAD")
    return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });
  const { requestContentView } = await import("./content-view");
  const { settings, group } = await requestContentView(request, env);
  const etag = `"visibility-v5-${settings.version}-${group}"`;
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "private, no-store",
    Vary: "Cookie, Authorization",
    ETag: etag,
  };
  return request.headers.get("If-None-Match") === etag
    ? new Response(null, { status: 304, headers })
    : new Response(request.method === "HEAD" ? null : JSON.stringify({ ...settings, group }), { headers });
}
