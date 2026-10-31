// L3 — GEB
// Input: Account token requests from a session, and open platform requests with a bearer token.
// Output: Token list, one-time token value, and the owner's data within the token's scopes.
// Pos: [Map](L2.md); open platform for tools acting on one account.
// Effects/Dependencies: Stores SHA-256 hashes in D1; bearer routes never read cookies, so they allow any origin.
import { communityAccessState } from "./access";
import { listGameAccounts } from "./app-account";
import { listGachaHistory, readGachaHistory } from "./gacha-history";
import { commitBoxOps } from "./team-box";
import { engineInputs, readBox } from "../src/lib/team-builder/sync/box-view";
import { MAX_OPS_PER_REQUEST, validEntry, type BoxEntry, type BoxOp, type BoxValue } from "../src/lib/team-builder/sync/box-doc";
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
const OPEN_PREFIX = "/api/v1/open/";
const SCOPES = ["profile:read", "games:read", "team:read", "team:write", "gacha:read"];
const TOKEN = /^hnk_[A-Za-z0-9_-]{43}$/u;
const MAX_TOKENS = 10;
const LIFETIME_DAYS = [30, 90, 365];
const DAY_MS = 86_400_000;
const USED_PRECISION_MS = 3_600_000;
const KEPT_EVENTS = 50;
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
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
      `SELECT id, name, created_at AS createdAt, expires_at AS expiresAt, last_used_at AS lastUsedAt,
              (SELECT json_group_array(scope) FROM account_api_token_scope WHERE token_id = id) AS scopes
       FROM account_api_token WHERE user_id = ? ORDER BY created_at DESC`,
    )
      .bind(userId)
      .all<{ scopes: string }>()
  ).results.map((row) => ({ ...row, scopes: JSON.parse(row.scopes) as string[] }));

const events = async (env: Env, userId: string) =>
  (
    await env.DB.prepare(
      `SELECT id, token_name AS tokenName, server, changed, created_at AS createdAt
       FROM account_api_token_event WHERE user_id = ? ORDER BY id DESC LIMIT ?`,
    )
      .bind(userId, KEPT_EVENTS)
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
  if (!write) return json(request, { tokens: await list(env, userId), events: await events(env, userId) });
  if (env.COMMUNITY_RATE_LIMITER && !(await env.COMMUNITY_RATE_LIMITER.limit({ key: `api-token:${userId}` })).success)
    return error(request, 429, "rate_limit_exceeded", "Try again later");
  const result = await readBody(request);
  if (!result.ok) return result.response;
  const { body } = result;
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const scopes = Array.isArray(body.scopes) ? [...new Set(body.scopes as string[])] : [];
  if (
    !exactKeys(body, ["name", "days", "scopes"]) ||
    !name ||
    [...name].length > 64 ||
    !LIFETIME_DAYS.includes(body.days as number) ||
    !scopes.length ||
    !scopes.every((scope) => SCOPES.includes(scope))
  )
    return error(request, 422, "invalid_token_request", "Send a name, 30, 90 or 365 days, and scopes");
  const now = Date.now();
  const tokenId = crypto.randomUUID();
  const value = `hnk_${btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    .replace(/\+/gu, "-")
    .replace(/\//gu, "_")
    .replace(/=+$/u, "")}`;
  const [inserted] = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO account_api_token (id, user_id, name, token_hash, created_at, expires_at)
       SELECT ?, ?, ?, ?, ?, ?
       WHERE (SELECT COUNT(*) FROM account_api_token WHERE user_id = ? AND expires_at > ?) < ?`,
    ).bind(tokenId, userId, name, await sha256(value), now, now + (body.days as number) * DAY_MS, userId, now, MAX_TOKENS),
    ...scopes.map((scope) =>
      env.DB.prepare(
        "INSERT INTO account_api_token_scope (token_id, scope) SELECT ?, ? WHERE EXISTS (SELECT 1 FROM account_api_token WHERE id = ?)",
      ).bind(tokenId, scope, tokenId),
    ),
  ]);
  if (!inserted!.meta.changes) return error(request, 409, "too_many_tokens", "Revoke a token first");
  return json(request, { token: value, tokens: await list(env, userId) }, 201);
}

// Rechecked inside the write, so a revoked token or restricted account cannot finish one in flight.
const tokenWritable = `EXISTS (
  SELECT 1 FROM account_api_token AS token
  JOIN community_profile AS profile ON profile.user_id = token.user_id
  JOIN "user" AS account ON account.id = profile.user_id
  JOIN account_api_token_scope AS grant_row ON grant_row.token_id = token.id AND grant_row.scope = 'team:write'
  WHERE token.id = ? AND token.user_id = ? AND token.expires_at > ?
    AND profile.status = 'active' AND profile.deleted_at IS NULL AND account.emailVerified = 1
    AND NOT EXISTS (
      SELECT 1 FROM community_user_restriction
      WHERE user_id = profile.user_id AND kind IN ('sign_in', 'write') AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > ?)
    )
)`;

interface TokenOwner {
  id: string;
  name: string;
  userId: string;
  expiresAt: number;
  lastUsedAt: number | null;
  scopes: string[];
}

async function authenticate(request: Request, env: Env, scope: string | null): Promise<TokenOwner | Response> {
  const value = /^Bearer (\S+)$/u.exec(request.headers.get("Authorization") ?? "")?.[1] ?? "";
  const now = Date.now();
  const row = TOKEN.test(value)
    ? await env.DB.prepare(
        `SELECT id, name, user_id AS userId, expires_at AS expiresAt, last_used_at AS lastUsedAt,
                (SELECT json_group_array(scope) FROM account_api_token_scope WHERE token_id = id) AS scopes
         FROM account_api_token WHERE token_hash = ? AND expires_at > ?`,
      )
        .bind(await sha256(value), now)
        .first<Omit<TokenOwner, "scopes"> & { scopes: string }>()
    : null;
  if (!row) return error(request, 401, "invalid_token", "Send a valid API token");
  const owner = { ...row, scopes: JSON.parse(row.scopes) as string[] };
  const state = await communityAccessState(env, owner.userId, ["sign_in"]);
  if (!state || state.status === "deleted" || state.restriction)
    return error(request, 403, "account_restricted", "This account cannot use API tokens");
  if (scope && !owner.scopes.includes(scope)) return error(request, 403, "insufficient_scope", `This token needs ${scope}`);
  if (env.COMMUNITY_RATE_LIMITER && !(await env.COMMUNITY_RATE_LIMITER.limit({ key: `open-api:${owner.id}` })).success)
    return error(request, 429, "rate_limit_exceeded", "Try again later");
  if ((owner.lastUsedAt ?? 0) < now - USED_PRECISION_MS)
    await env.DB.prepare("UPDATE account_api_token SET last_used_at = ? WHERE id = ?").bind(now, owner.id).run();
  return owner;
}

async function teamRead(request: Request, env: Env, server: string): Promise<Response> {
  const owner = await authenticate(request, env, "team:read");
  if (owner instanceof Response) return owner;
  const known = await env.DB.prepare("SELECT 1 FROM resource_server WHERE slug = ?").bind(server).first();
  if (!known) return error(request, 404, "server_not_found", "Server not found");
  const row = await env.DB.prepare("SELECT revision, box_json AS box FROM account_team_box WHERE user_id = ? AND server = ?")
    .bind(owner.userId, server)
    .first<{ revision: number; box: string }>();
  const entries = row ? (JSON.parse(row.box) as { entries: Record<string, BoxEntry> }).entries : {};
  const view = readBox(entries);
  return json(request, { server, revision: row?.revision ?? 0, ...engineInputs(view), player: view.player, teams: view.teams });
}

async function teamWrite(request: Request, env: Env, server: string): Promise<Response> {
  const owner = await authenticate(request, env, "team:write");
  if (owner instanceof Response) return owner;
  const resource = await env.DB.prepare("SELECT status FROM resource_server WHERE slug = ?").bind(server).first<{ status: string }>();
  if (!resource) return error(request, 404, "server_not_found", "Server not found");
  if (resource.status !== "active") return error(request, 409, "server_unavailable", "This resource server is not active");
  const result = await readBody(request);
  if (!result.ok) return result.response;
  const { changes } = result.body;
  if (
    !exactKeys(result.body, ["changes"]) ||
    !Array.isArray(changes) ||
    !changes.length ||
    changes.length > MAX_OPS_PER_REQUEST ||
    !changes.every((change) => validEntry((change as { key: string })?.key, (change as { value: unknown })?.value))
  )
    return error(request, 422, "invalid_changes", "Send valid box changes");
  const now = Date.now();
  const client = `api-${owner.id.slice(0, 8)}`;
  const ops: BoxOp[] = (changes as { key: string; value: BoxValue }[]).map(({ key, value }) => ({ k: key, v: value, t: now, c: client }));
  const committed = await commitBoxOps(env, owner.userId, server, ops, now, tokenWritable, [owner.id, owner.userId, now, now], async () =>
    error(request, 403, "account_restricted", "This account cannot save changes"),
  );
  if (committed instanceof Response) return committed;
  if (committed === "too_many" || committed === "too_large") return error(request, 413, "box_too_large", "Box limit reached");
  if (committed === "busy") return error(request, 503, "busy", "Try again");
  if (committed.changed)
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO account_api_token_event (user_id, token_name, server, changed, created_at) VALUES (?, ?, ?, ?, ?)",
      ).bind(owner.userId, owner.name, server, committed.changed, now),
      env.DB.prepare(
        `DELETE FROM account_api_token_event WHERE user_id = ? AND id NOT IN (
           SELECT id FROM account_api_token_event WHERE user_id = ? ORDER BY id DESC LIMIT ?)`,
      ).bind(owner.userId, owner.userId, KEPT_EVENTS),
    ]);
  return json(request, { revision: committed.revision, changed: committed.changed });
}

async function open(request: Request, env: Env, path: string): Promise<Response> {
  const route = path.split("/");
  if (path === "me") {
    const owner = await authenticate(request, env, null);
    if (owner instanceof Response) return owner;
    const profile = owner.scopes.includes("profile:read")
      ? await env.DB.prepare(
          `SELECT identity.uid AS uid, profile.display_name AS displayName, profile.handle, profile.bio
           FROM community_profile AS profile
           LEFT JOIN community_identity AS identity ON identity.user_id = profile.user_id
           WHERE profile.user_id = ?`,
        )
          .bind(owner.userId)
          .first()
      : null;
    return json(request, { token: { name: owner.name, expiresAt: owner.expiresAt, scopes: owner.scopes }, profile });
  }
  if (path === "game-accounts") {
    const owner = await authenticate(request, env, "games:read");
    return owner instanceof Response ? owner : json(request, { accounts: await listGameAccounts(env, owner.userId) });
  }
  if (route[0] === "gacha-history" && route.length <= 2) {
    const key = route[1];
    if (key !== undefined && !/^[a-f0-9]{64}$/u.test(key)) return error(request, 404, "history_not_found", "History not found");
    const owner = await authenticate(request, env, "gacha:read");
    if (owner instanceof Response) return owner;
    if (key === undefined) return json(request, { accounts: await listGachaHistory(env, owner.userId) });
    const history = await readGachaHistory(env, owner.userId, key);
    return history ? json(request, history) : error(request, 404, "history_not_found", "History not found");
  }
  return error(request, 404, "route_not_found", "API route not found");
}

async function bearer(request: Request, env: Env, pathname: string): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...CORS, "Cache-Control": "private, no-store" } });
  if (!env.DB) return error(request, 503, "database_unavailable", "Database is not configured");
  const read = ["GET", "HEAD"].includes(request.method);
  if (pathname.startsWith(OPEN_PREFIX)) {
    if (!read) return error(request, 405, "method_not_allowed", "Method not allowed");
    return open(request, env, pathname.slice(OPEN_PREFIX.length));
  }
  const server = pathname.slice(DATA_PREFIX.length);
  if (!read && request.method !== "POST") return error(request, 405, "method_not_allowed", "Method not allowed");
  if (!/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/u.test(server)) return error(request, 404, "server_not_found", "Server not found");
  return read ? teamRead(request, env, server) : teamWrite(request, env, server);
}

export async function handleAccountApiTokenRequest(request: Request, env: Env): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  if (pathname.startsWith(DATA_PREFIX) || pathname.startsWith(OPEN_PREFIX)) return cors(await bearer(request, env, pathname));
  if (pathname === MANAGE_PREFIX) return manage(request, env, null);
  const id = pathname.startsWith(`${MANAGE_PREFIX}/`) ? pathname.slice(MANAGE_PREFIX.length + 1) : null;
  return id && /^[0-9a-f-]{36}$/u.test(id) ? manage(request, env, id) : null;
}
