import { handleAuthRequest } from "./auth";
import { handleAdminRequest } from "./admin";
import { handleCommunityForumsRequest } from "./community-forums";

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : null;
const json = (value: unknown, status = 200) => Response.json(value, {
  status,
  headers: { "Cache-Control": "private, no-store", Vary: "Cookie" },
});

/** Same authoritative session/staff handshake as the browser, before reading content. */
async function viewer(request: Request, env: Env) {
  const [sessionResponse, staffResponse] = await Promise.all([
    handleAuthRequest(new Request(new URL("/api/auth/get-session", request.url), request), env),
    handleAdminRequest(new Request(new URL("/api/v1/admin/session", request.url), request), env),
  ]);
  if (!sessionResponse || !staffResponse) throw new Error("Community identity routes unavailable");
  if (!sessionResponse.ok) return { response: sessionResponse };
  const session = object(await sessionResponse.json());
  const user = object(session?.user);
  let userId = typeof user?.id === "string" ? user.id : "";
  let staffRole: "admin" | "moderator" | null = null;
  if (userId) {
    if (staffResponse.status === 401) userId = "";
    else if (staffResponse.status !== 403) {
      if (!staffResponse.ok) return { response: staffResponse };
      const staff = object(object(await staffResponse.json())?.session);
      if (object(staff?.user)?.id !== userId)
        return { response: json({ error: { code: "community_identity_changed" } }, 409) };
      if (staff?.role === "admin" || staff?.role === "moderator") staffRole = staff.role;
    }
  }
  return {
    value: { session: userId ? session : null, userId, staffRole, realm: JSON.stringify([userId, staffRole]) },
    cookies: sessionResponse.headers.getSetCookie(),
  };
}

/** Aggregate existing GET handlers. No shared/private-response cache or alternate authorization path. */
export async function handleCommunityBootstrap(
  request: Request,
  env: Env,
  read: (request: Request) => Promise<Response | null>,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/api/v1/community/bootstrap") return null;
  const origin = request.headers.get("Origin");
  if (request.headers.get("Sec-Fetch-Site") === "cross-site" || (origin && origin !== url.origin))
    return json({ error: { code: "cross_origin_request" } }, 403);
  if (request.method !== "GET") return json({ error: { code: "method_not_allowed" } }, 405);
  const path = url.searchParams.get("path") || "";
  if (path.length > 4096 || !path.startsWith("/api/v1/community/") || path.includes("#") ||
      [...url.searchParams.keys()].some((key) => !["path", "forums"].includes(key)) ||
      ["path", "forums"].some((key) => url.searchParams.getAll(key).length > 1) ||
      (url.searchParams.has("forums") && url.searchParams.get("forums") !== "1"))
    return json({ error: { code: "invalid_bootstrap_query" } }, 400);
  const target = new URL(path, url);
  if (target.origin !== url.origin ||
      !/^\/api\/v1\/community\/(?:posts(?:\/[a-f0-9-]{36})?|entity-threads\/[a-z][a-z0-9-]{0,63}\/[^/]+)$/iu.test(target.pathname))
    return json({ error: { code: "invalid_bootstrap_target" } }, 400);
  const started = performance.now();
  const identity = await viewer(request, env);
  if ("response" in identity) return identity.response!;
  const identified = performance.now();
  const [content, directory] = await Promise.all([
    read(new Request(target, request)),
    url.searchParams.get("forums") === "1"
      ? handleCommunityForumsRequest(new Request(new URL("/api/v1/community/forums", url), request), env)
      : Promise.resolve(null),
  ]);
  if (!content) return json({ error: { code: "bootstrap_target_unavailable" } }, 404);
  const failure = !content.ok ? content : directory && !directory.ok ? directory : null;
  const response = failure
    ? new Response(failure.body, failure)
    : json({ viewer: identity.value, data: await content.json(), directory: directory ? await directory.json() : null });
  response.headers.set("Cache-Control", "private, no-store");
  response.headers.set("Vary", "Cookie");
  for (const cookie of identity.cookies) response.headers.append("Set-Cookie", cookie);
  response.headers.append("Server-Timing", `identity;dur=${(identified - started).toFixed(1)},content;dur=${(performance.now() - identified).toFixed(1)}`);
  return response;
}
