// L3 — GEB
// Input: Account token requests from a session, and team data reads with a bearer token.
// Output: Token list, one-time token value, and engine inputs for the token owner's Box.
// Pos: [Map](L2.md); read-only third-party access to the owner's team data.
// Effects/Dependencies: Stores SHA-256 hashes in D1; team data never reads cookies, so it allows any origin.
import { communityAccessState } from "./access";
import { engineInputs, readBox } from "../src/lib/team-builder/sync/box-view";
import type { BoxEntry } from "../src/lib/team-builder/sync/box-doc";
import {
  privateTeamJson as json,
  privateTeamError as error,
  requireTeamAccess as requireAccess,
  readTeamBody as readBody,
  teamExactKeys as exactKeys,
  teamSameOrigin as sameOrigin,
} from "./team-inventory";

const MANAGE_PREFIX = "/api/v1/account/api-tokens";
const DATA_PREFIX = "/api/v1/team-data/";
const TOKEN = /^hnk_[A-Za-z0-9_-]{43}$/u;
const MAX_TOKENS = 10;
const LIFETIME_DAYS = [30, 90, 365];
const DAY_MS = 86_400_000;
const USED_PRECISION_MS = 3_600_000;
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization",
  "Access-Control-Max-Age": "86400",
};

const sha256 = async (value: string) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
const cors = (response: Response) => {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(CORS)) headers.set(key, value);
  headers.delete("Vary");
  return new Response(response.body, { status: response.status, headers });
};
const list = async (env: Env, userId: string) =>
  (
    await env.DB.prepare(
      `SELECT id, name, created_at AS createdAt, expires_at AS expiresAt, last_used_at AS lastUsedAt
       FROM account_api_token WHERE user_id = ? ORDER BY created_at DESC`,
    )
      .bind(userId)
      .all()
  ).results;

async function manage(request: Request, env: Env, id: string | null): Promise<Response> {
  if (!sameOrigin(request)) return error(request, 403, "cross_origin_request", "Use the same-origin token endpoint");
  const allowed = id ? ["DELETE"] : ["GET", "HEAD", "POST"];
  if (!allowed.includes(request.method)) return error(request, 405, "method_not_allowed", "Method not allowed");
  if (!env.DB) return error(request, 503, "database_unavailable", "Database is not configured");
  const write = request.method === "POST" || request.method === "DELETE";
  const access = await requireAccess(request, env, write);
  if (!access.ok) return access.response;
  const { userId } = access.value;
  if (id) {
    await env.DB.prepare("DELETE FROM account_api_token WHERE id = ? AND user_id = ?").bind(id, userId).run();
    return json(request, { tokens: await list(env, userId) });
  }
  if (!write) return json(request, { tokens: await list(env, userId) });
  if (env.COMMUNITY_RATE_LIMITER && !(await env.COMMUNITY_RATE_LIMITER.limit({ key: `api-token:${userId}` })).success)
    return error(request, 429, "rate_limit_exceeded", "Try again later");
  const result = await readBody(request);
  if (!result.ok) return result.response;
  const { body } = result;
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!exactKeys(body, ["name", "days"]) || !name || [...name].length > 64 || !LIFETIME_DAYS.includes(body.days as number))
    return error(request, 422, "invalid_token_request", "Send a name and 30, 90 or 365 days");
  const now = Date.now();
  const tokenId = crypto.randomUUID();
  const value = `hnk_${btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    .replace(/\+/gu, "-")
    .replace(/\//gu, "_")
    .replace(/=+$/u, "")}`;
  const inserted = await env.DB.prepare(
    `INSERT INTO account_api_token (id, user_id, name, token_hash, created_at, expires_at)
     SELECT ?, ?, ?, ?, ?, ?
     WHERE (SELECT COUNT(*) FROM account_api_token WHERE user_id = ? AND expires_at > ?) < ?`,
  )
    .bind(tokenId, userId, name, await sha256(value), now, now + (body.days as number) * DAY_MS, userId, now, MAX_TOKENS)
    .run();
  if (!inserted.meta.changes) return error(request, 409, "too_many_tokens", "Revoke a token first");
  return json(request, { token: value, tokens: await list(env, userId) }, 201);
}

async function teamData(request: Request, env: Env, server: string): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...CORS, "Cache-Control": "private, no-store" } });
  if (!["GET", "HEAD"].includes(request.method)) return error(request, 405, "method_not_allowed", "Method not allowed");
  if (!/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/u.test(server)) return error(request, 404, "server_not_found", "Server not found");
  if (!env.DB) return error(request, 503, "database_unavailable", "Database is not configured");
  const value = /^Bearer (\S+)$/u.exec(request.headers.get("Authorization") ?? "")?.[1] ?? "";
  const now = Date.now();
  const owner = TOKEN.test(value)
    ? await env.DB.prepare(
        "SELECT id, user_id AS userId, last_used_at AS lastUsedAt FROM account_api_token WHERE token_hash = ? AND expires_at > ?",
      )
        .bind(await sha256(value), now)
        .first<{ id: string; userId: string; lastUsedAt: number | null }>()
    : null;
  if (!owner) return error(request, 401, "invalid_token", "Send a valid API token");
  const state = await communityAccessState(env, owner.userId, ["sign_in"]);
  if (!state || state.status === "deleted" || state.restriction)
    return error(request, 403, "account_restricted", "This account cannot use API tokens");
  if (env.COMMUNITY_RATE_LIMITER && !(await env.COMMUNITY_RATE_LIMITER.limit({ key: `team-data:${owner.id}` })).success)
    return error(request, 429, "rate_limit_exceeded", "Try again later");
  const known = await env.DB.prepare("SELECT 1 FROM resource_server WHERE slug = ?").bind(server).first();
  if (!known) return error(request, 404, "server_not_found", "Server not found");
  if ((owner.lastUsedAt ?? 0) < now - USED_PRECISION_MS)
    await env.DB.prepare("UPDATE account_api_token SET last_used_at = ? WHERE id = ?").bind(now, owner.id).run();
  const row = await env.DB.prepare("SELECT revision, box_json AS box FROM account_team_box WHERE user_id = ? AND server = ?")
    .bind(owner.userId, server)
    .first<{ revision: number; box: string }>();
  const entries = row ? (JSON.parse(row.box) as { entries: Record<string, BoxEntry> }).entries : {};
  const view = readBox(entries);
  return json(request, { server, revision: row?.revision ?? 0, ...engineInputs(view), player: view.player });
}

export async function handleAccountApiTokenRequest(request: Request, env: Env): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  if (pathname.startsWith(DATA_PREFIX)) return cors(await teamData(request, env, pathname.slice(DATA_PREFIX.length)));
  if (pathname === MANAGE_PREFIX) return manage(request, env, null);
  const id = pathname.startsWith(`${MANAGE_PREFIX}/`) ? pathname.slice(MANAGE_PREFIX.length + 1) : null;
  return id && /^[0-9a-f-]{36}$/u.test(id) ? manage(request, env, id) : null;
}
