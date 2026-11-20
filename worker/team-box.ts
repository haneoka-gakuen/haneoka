// L3 — GEB
// Input: 认证 Box 读写请求、server、操作与 Env。
// Output: Box 版本／变化或权限、格式和状态错误。
// Pos: [Map](L2.md)；当前配队 Box 云端同步接口。
// Effects/Dependencies: 鉴权、服务器状态、限流和 D1 读写；轮询命中当前版本只读取摘要。
import {
  BOX_SCHEMA,
  MAX_BOX_BYTES,
  MAX_BOX_KEYS,
  MAX_OPS_PER_REQUEST,
  applyOps,
  changesSince,
  validOp,
  type BoxEntry,
  type BoxOp,
} from "../src/lib/team-builder/sync/box-doc";
import {
  privateTeamJson as json,
  privateTeamError as error,
  teamExactKeys as exactKeys,
  teamSameOrigin as sameOrigin,
  requireTeamAccess as requireAccess,
  readTeamBody as readBody,
  writableTeamOwner as writableOwner,
} from "./team-inventory";
import { isGameToolAccountId } from "../src/lib/game-tool-accounts";

const PREFIX = "/api/v1/team-box/";
/** Concurrent writers retry the compare-and-swap; ops commute, so the client never sees a conflict. */
const WRITE_ATTEMPTS = 6;

interface BoxRow {
  revision: number;
  boxJson: string;
}
interface StoredBox {
  schema: typeof BOX_SCHEMA;
  entries: Record<string, BoxEntry>;
}
const parse = (row: BoxRow | null): StoredBox => (row ? (JSON.parse(row.boxJson) as StoredBox) : { schema: BOX_SCHEMA, entries: {} });
const sinceOf = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;

/** Compare-and-swap of ops onto the stored box; `guard` is rechecked inside the write. */
export async function commitBoxOps(
  env: Env,
  userId: string,
  server: string,
  ops: BoxOp[],
  now: number,
  guardSql: string,
  guard: unknown[],
  recheck: () => Promise<Response | null>,
  accountId?: string,
): Promise<{ revision: number; entries: Record<string, BoxEntry>; changed: number } | "too_many" | "too_large" | "busy" | Response> {
  const table = accountId ? "account_game_tool_box" : "account_team_box";
  const key = accountId ? "account_id" : "server";
  const scope = accountId ?? server;
  for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
    const row = await env.DB.prepare(`SELECT revision, box_json AS boxJson FROM ${table} WHERE user_id = ? AND ${key} = ?`)
      .bind(userId, scope).first<BoxRow>();
    const revision = row?.revision ?? 0;
    const stored = parse(row);
    const next = revision + 1;
    const changed = applyOps(stored.entries, ops, next);
    if (!changed.length) return { revision, entries: stored.entries, changed: 0 };
    if (Object.keys(stored.entries).length > MAX_BOX_KEYS) return "too_many";
    const serialized = JSON.stringify(stored);
    if (new TextEncoder().encode(serialized).byteLength > MAX_BOX_BYTES) return "too_large";
    const statement = row
      ? env.DB.prepare(
          `UPDATE ${table} SET box_json = ?, revision = ?, updated_at = ?
           WHERE user_id = ? AND ${key} = ? AND revision = ? AND ${guardSql}
           RETURNING revision`,
        ).bind(serialized, next, now, userId, scope, revision, ...guard)
      : env.DB.prepare(
          `INSERT INTO ${table}(user_id, ${key}, box_json, revision, updated_at)
           SELECT ?, ?, ?, 1, ? WHERE ${guardSql}
           ON CONFLICT(user_id, ${key}) DO NOTHING RETURNING revision`,
        ).bind(userId, scope, serialized, now, ...guard);
    const written = await statement.first<{ revision: number }>();
    if (written) return { revision: written.revision, entries: stored.entries, changed: changed.length };
    const refused = await recheck();
    if (refused) return refused;
  }
  return "busy";
}

export const handleTeamBoxRequest = async (request: Request, env: Env): Promise<Response | null> => {
  const url = new URL(request.url);
  if (!url.pathname.startsWith(PREFIX)) return null;
  const server = url.pathname.slice(PREFIX.length);
  if (!/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/u.test(server)) return error(request, 404, "server_not_found", "Server not found");
  const accountId = url.searchParams.get("gameAccount");
  if (accountId !== null && !isGameToolAccountId(accountId))
    return error(request, 404, "game_tool_account_not_found", "Game account not found");
  if (!sameOrigin(request)) return error(request, 403, "cross_origin_request", "Use the same-origin team box endpoint");
  if (request.method === "OPTIONS")
    return new Response(null, { status: 204, headers: { Allow: "GET, POST, OPTIONS", "Cache-Control": "private, no-store" } });
  if (!["GET", "POST"].includes(request.method)) return error(request, 405, "method_not_allowed", "Method not allowed");
  if (!env.DB) return error(request, 503, "database_unavailable", "Database is not configured");
  const write = request.method === "POST";
  const access = await requireAccess(request, env, write);
  if (!access.ok) return access.response;
  const { userId, token } = access.value;
  const now = Date.now();
  if (!write) {
    const since = sinceOf(Number(url.searchParams.get("since") ?? 0));
    if (since === null) return error(request, 400, "invalid_since", "since must be a revision");
    const row = await (accountId ? env.DB.prepare(
      `SELECT COALESCE(box.revision, 0) AS revision,
              CASE WHEN box.revision <> ? THEN box.box_json END AS boxJson
       FROM account_game_tool account
       LEFT JOIN account_game_tool_box box ON box.account_id = account.id AND box.user_id = account.user_id
       WHERE account.user_id = ? AND account.id = ? AND account.server = ?
         AND COALESCE(json_extract(account.settings_json, '$.removed'), 0) = 0`,
    ).bind(since, userId, accountId, server) : env.DB.prepare(
      `SELECT COALESCE(box.revision, 0) AS revision,
              CASE WHEN box.revision <> ? THEN box.box_json END AS boxJson
       FROM resource_server rs
       LEFT JOIN account_team_box box ON box.server = rs.slug AND box.user_id = ?
       WHERE rs.slug = ?`,
    ).bind(since, userId, server)).first<{ revision: number; boxJson: string | null }>();
    if (!row) return error(request, 404, accountId ? "game_tool_account_not_found" : "server_not_found", "Box scope not found");
    const { revision, boxJson } = row;
    // A client ahead of the server (restored database) refetches everything.
    const entries = boxJson === null ? {} : changesSince(parse({ revision, boxJson }).entries, since > revision ? 0 : since);
    return json(request, { revision, serverTime: now, entries });
  }
  const resourceServer = await env.DB.prepare("SELECT status FROM resource_server WHERE slug = ?").bind(server).first<{ status: string }>();
  if (!resourceServer) return error(request, 404, "server_not_found", "Server not found");
  if (resourceServer.status !== "active") return error(request, 409, "server_unavailable", "This resource server is not active");
  const activeAccount = "COALESCE(json_extract(settings_json, '$.removed'), 0) = 0";
  const hasScope = () => env.DB.prepare(`SELECT 1 FROM account_game_tool WHERE user_id = ? AND id = ? AND server = ? AND ${activeAccount}`)
    .bind(userId, accountId, server).first();
  if (accountId && !await hasScope()) return error(request, 404, "game_tool_account_not_found", "Game account not found");
  if (env.COMMUNITY_RATE_LIMITER) {
    const limit = await env.COMMUNITY_RATE_LIMITER.limit({ key: `team-box:${userId}` });
    if (!limit.success) return error(request, 429, "rate_limit_exceeded", "Try again later");
  }
  const result = await readBody(request);
  if (!result.ok) return result.response;
  const body = result.body;
  const since = sinceOf(body.since);
  const saving = Object.hasOwn(body, "saveTime");
  const saveTime = saving ? sinceOf(body.saveTime) : null;
  if (
    !exactKeys(body, saving ? ["since", "ops", "saveTime"] : ["since", "ops"]) ||
    (saving && (!accountId || saveTime === null)) ||
    since === null ||
    !Array.isArray(body.ops) ||
    body.ops.length > (saving ? MAX_BOX_KEYS : MAX_OPS_PER_REQUEST) ||
    !body.ops.every(validOp)
  )
    return error(request, 422, "invalid_ops", "Send since and valid ops");
  const sourceTime = saveTime ?? 0;
  const verifySource = async () => {
    if (!saving) return null;
    const row = await env.DB.prepare("SELECT source_time FROM account_game_tool WHERE user_id = ? AND id = ?")
      .bind(userId, accountId).first<{ source_time: number }>();
    if (row?.source_time === sourceTime) return null;
    return row && row.source_time > sourceTime
      ? error(request, 409, "stale_game_save", "A newer save is already registered")
      : error(request, 409, "unregistered_game_save", "Register the save version before importing");
  };
  const refusal = await verifySource();
  if (refusal) return refusal;
  // Clocks far in the future would pin a key forever; clamp them to the server's day.
  const ops = body.ops.map((op) => ({ ...op, t: Math.min(op.t, now + 86_400_000) }));
  const guard = [userId, token, new Date(now).toISOString(), now];
  const scopedGuard = accountId
    ? `${writableOwner} AND EXISTS (SELECT 1 FROM account_game_tool WHERE user_id = ? AND id = ? AND server = ? AND ${activeAccount}${saving ? " AND source_time = ?" : ""})`
    : writableOwner;
  if (accountId) guard.push(userId, accountId, server);
  if (saving) guard.push(sourceTime);
  const committed = await commitBoxOps(env, userId, server, ops, now, scopedGuard, guard, async () => {
    const refreshed = await requireAccess(request, env, true);
    if (!refreshed.ok) return refreshed.response;
    if (accountId && !await hasScope()) return error(request, 404, "game_tool_account_not_found", "Game account not found");
    return verifySource();
  }, accountId ?? undefined);
  if (committed instanceof Response) return committed;
  if (committed === "too_many") return error(request, 413, "box_too_large", "Too many entries");
  if (committed === "too_large") return error(request, 413, "box_too_large", "Box exceeds 1 MiB");
  if (committed === "busy") return error(request, 503, "busy", "Try again");
  return json(request, {
    revision: committed.revision,
    serverTime: now,
    entries: changesSince(committed.entries, since > committed.revision ? 0 : since),
  });
};
