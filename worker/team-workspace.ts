import { isTeamWorkspaceDocument as workspaceValid } from "../src/lib/team-builder/data/workspace-document";
import {
  privateTeamJson as json,
  privateTeamError as error,
  teamExactKeys as exactKeys,
  teamSameOrigin as sameOrigin,
  requireTeamAccess as requireAccess,
  readTeamBody as readBody,
  writableTeamOwner as writableOwner,
} from "./team-inventory";

const PREFIX = "/api/v1/team-workspace/";
const revision = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value < Number.MAX_SAFE_INTEGER;

interface WorkspaceRow {
  revision: number;
  workspaceJson: string;
}
const readWorkspace = (env: Env, userId: string, server: string): Promise<WorkspaceRow | null> =>
  env.DB.prepare(
    "SELECT revision, workspace_json AS workspaceJson FROM account_team_workspace WHERE user_id = ? AND server = ?",
  )
    .bind(userId, server)
    .first<WorkspaceRow>();
const document = (ownerId: string, server: string, row: WorkspaceRow | null) => ({
  ownerId,
  server,
  revision: row?.revision ?? 0,
  workspace: row ? (JSON.parse(row.workspaceJson) as unknown) : null,
});

export const handleTeamWorkspaceRequest = async (request: Request, env: Env): Promise<Response | null> => {
  const url = new URL(request.url);
  if (!url.pathname.startsWith(PREFIX)) return null;
  const server = url.pathname.slice(PREFIX.length);
  if (!/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/u.test(server))
    return error(request, 404, "server_not_found", "Server not found");
  if (!sameOrigin(request))
    return error(request, 403, "cross_origin_request", "Use the same-origin workspace endpoint");
  if (request.method === "OPTIONS")
    return new Response(null, {
      status: 204,
      headers: { Allow: "GET, HEAD, PUT, OPTIONS", "Cache-Control": "private, no-store" },
    });
  if (!["GET", "HEAD", "PUT"].includes(request.method))
    return error(request, 405, "method_not_allowed", "Method not allowed");
  if (url.searchParams.size)
    return error(request, 400, "invalid_query", "Workspace endpoints do not accept query parameters");
  if (!env.DB) return error(request, 503, "database_unavailable", "Database is not configured");
  const write = request.method === "PUT";
  const access = await requireAccess(request, env, write);
  if (!access.ok) return access.response;
  const { userId, token } = access.value;
  const resourceServer = await env.DB.prepare("SELECT status FROM resource_server WHERE slug = ?")
    .bind(server)
    .first<{ status: string }>();
  if (!resourceServer) return error(request, 404, "server_not_found", "Server not found");
  if (!write) return json(request, document(userId, server, await readWorkspace(env, userId, server)));
  if (resourceServer.status !== "active")
    return error(request, 409, "server_unavailable", "This resource server is not active");
  if (env.COMMUNITY_RATE_LIMITER) {
    const limit = await env.COMMUNITY_RATE_LIMITER.limit({ key: `team-workspace:${userId}` });
    if (!limit.success) return error(request, 429, "rate_limit_exceeded", "Try again later");
  }
  const result = await readBody(request);
  if (!result.ok) return result.response;
  const body = result.body;
  if (
    !exactKeys(body, ["expectedRevision", "workspace"]) ||
    !revision(body.expectedRevision) ||
    !workspaceValid(body.workspace, server)
  )
    return error(request, 422, "invalid_workspace", "Send a valid workspace and expectedRevision");
  const now = Date.now();
  const guardValues = [userId, token, new Date(now).toISOString(), now];
  const serialized = JSON.stringify(body.workspace);
  const updated = await (
    body.expectedRevision === 0
      ? env.DB.prepare(
          `INSERT INTO account_team_workspace(user_id, server, workspace_json, revision, updated_at)
     SELECT ?, ?, ?, 1, ? WHERE ${writableOwner}
       AND EXISTS (SELECT 1 FROM resource_server WHERE slug = ? AND status = 'active')
     ON CONFLICT(user_id, server) DO NOTHING RETURNING revision, workspace_json AS workspaceJson`,
        ).bind(userId, server, serialized, now, ...guardValues, server)
      : env.DB.prepare(
          `UPDATE account_team_workspace SET workspace_json = ?, revision = revision + 1, updated_at = ?
     WHERE user_id = ? AND server = ? AND revision = ? AND ${writableOwner}
       AND EXISTS (SELECT 1 FROM resource_server WHERE slug = ? AND status = 'active')
     RETURNING revision, workspace_json AS workspaceJson`,
        ).bind(serialized, now, userId, server, body.expectedRevision, ...guardValues, server)
  ).first<WorkspaceRow>();
  if (updated) return json(request, document(userId, server, updated));
  const refreshed = await requireAccess(request, env, true);
  if (!refreshed.ok) return refreshed.response;
  const currentServer = await env.DB.prepare("SELECT status FROM resource_server WHERE slug = ?")
    .bind(server)
    .first<{ status: string }>();
  if (currentServer?.status !== "active")
    return error(request, 409, "server_unavailable", "This resource server is not active");
  return json(
    request,
    {
      error: { code: "revision_conflict", message: "The cloud workspace changed; merge with its current revision" },
      ...document(userId, server, await readWorkspace(env, userId, server)),
    },
    409,
  );
};
