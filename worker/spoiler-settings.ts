import { getAuthSession } from "./auth";
import { communityAccessState } from "./access";
import { USER_ROLES } from "../src/lib/user-roles";
import { privateTeamJson as json, privateTeamError as error, teamSameOrigin, readTeamBody } from "./team-inventory";

export async function readSpoilerSettings(env: Env) {
  const row = await env.DB.withSession("first-primary")
    .prepare("SELECT roles, version, updated_at AS updatedAt FROM spoiler_setting WHERE id = 1")
    .first<{ roles: string; version: number; updatedAt: number }>();
  const roles: unknown = JSON.parse(row?.roles ?? "[]");
  return {
    roles: USER_ROLES.filter((role) => Array.isArray(roles) && roles.includes(role)),
    version: row?.version ?? 1,
    updatedAt: row?.updatedAt ?? 0,
  };
}

export async function handleSpoilerPreferenceRequest(request: Request, env: Env): Promise<Response | null> {
  if (new URL(request.url).pathname !== "/api/v1/account/spoilers") return null;
  if (!["GET", "HEAD", "PUT"].includes(request.method))
    return new Response(null, {
      status: 405,
      headers: { Allow: "GET, HEAD, PUT", "Cache-Control": "private, no-store" },
    });
  if (request.method === "PUT" && !teamSameOrigin(request))
    return error(request, 403, "same_origin_required", "Use a same-origin request");
  const session = await getAuthSession(request, env, { authoritative: true });
  if (!session?.user?.id) {
    if (request.method === "PUT") return error(request, 401, "authentication_required", "Sign in required");
    return json(request, { allowed: false, enabled: false });
  }
  const [settings, state] = await Promise.all([
    readSpoilerSettings(env),
    communityAccessState(env, session.user.id, ["sign_in"]),
  ]);
  const allowed = Boolean(
    session.user.emailVerified &&
    state?.status === "active" &&
    !state.restriction &&
    settings.roles.includes(state.role),
  );
  if (request.method === "PUT") {
    if (!allowed) return error(request, 403, "preference_unavailable", "Setting is unavailable");
    if (request.headers.get("X-Haneoka-Expected-User") !== session.user.id)
      return error(request, 409, "account_changed", "The signed-in account changed");
    const value = await readTeamBody(request);
    if (!value.ok) return value.response;
    if (typeof value.body.enabled !== "boolean")
      return error(request, 422, "invalid_preference", "enabled is required");
    await env.DB.prepare(
      `INSERT INTO account_spoiler_preference (user_id, enabled, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at`,
    )
      .bind(session.user.id, value.body.enabled ? 1 : 0, Date.now())
      .run();
    return json(request, { userId: session.user.id, allowed, enabled: value.body.enabled });
  }
  const preference = allowed
    ? await env.DB.withSession("first-primary")
        .prepare("SELECT enabled FROM account_spoiler_preference WHERE user_id = ?")
        .bind(session.user.id)
        .first<{ enabled: number }>()
    : null;
  return json(request, { userId: session.user.id, allowed, enabled: preference?.enabled === 1 });
}
