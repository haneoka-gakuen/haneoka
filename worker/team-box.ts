// L3 — GEB
// Input: 认证 Box 读写请求、server、操作与 Env。
// Output: Box 版本／变化或权限、格式和状态错误。
// Pos: [Map](L2.md)；当前配队 Box 云端同步接口。
// Effects/Dependencies: 鉴权、服务器状态、限流和 D1 读写；复用浏览器共享 Box 文档契约。
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
const readBox = (env: Env, userId: string, server: string) =>
  env.DB.prepare("SELECT revision, box_json AS boxJson FROM account_team_box WHERE user_id = ? AND server = ?")
    .bind(userId, server)
    .first<BoxRow>();
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
): Promise<{ revision: number; entries: Record<string, BoxEntry>; changed: number } | "too_many" | "too_large" | "busy" | Response> {
  for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
    const row = await readBox(env, userId, server);
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
          `UPDATE account_team_box SET box_json = ?, revision = ?, updated_at = ?
           WHERE user_id = ? AND server = ? AND revision = ? AND ${guardSql}
           RETURNING revision`,
        ).bind(serialized, next, now, userId, server, revision, ...guard)
      : env.DB.prepare(
          `INSERT INTO account_team_box(user_id, server, box_json, revision, updated_at)
           SELECT ?, ?, ?, 1, ? WHERE ${guardSql}
           ON CONFLICT(user_id, server) DO NOTHING RETURNING revision`,
        ).bind(userId, server, serialized, now, ...guard);
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
  if (!sameOrigin(request)) return error(request, 403, "cross_origin_request", "Use the same-origin team box endpoint");
  if (request.method === "OPTIONS")
    return new Response(null, { status: 204, headers: { Allow: "GET, POST, OPTIONS", "Cache-Control": "private, no-store" } });
  if (!["GET", "POST"].includes(request.method)) return error(request, 405, "method_not_allowed", "Method not allowed");
  if (!env.DB) return error(request, 503, "database_unavailable", "Database is not configured");
  const write = request.method === "POST";
  const access = await requireAccess(request, env, write);
  if (!access.ok) return access.response;
  const { userId, token } = access.value;
  const resourceServer = await env.DB.prepare("SELECT status FROM resource_server WHERE slug = ?").bind(server).first<{ status: string }>();
  if (!resourceServer) return error(request, 404, "server_not_found", "Server not found");
  const now = Date.now();
  if (!write) {
    const since = sinceOf(Number(url.searchParams.get("since") ?? 0));
    if (since === null) return error(request, 400, "invalid_since", "since must be a revision");
    const row = await readBox(env, userId, server);
    const revision = row?.revision ?? 0;
    // A client ahead of the server (restored database) refetches everything.
    return json(request, { revision, serverTime: now, entries: changesSince(parse(row).entries, since > revision ? 0 : since) });
  }
  if (resourceServer.status !== "active") return error(request, 409, "server_unavailable", "This resource server is not active");
  if (env.COMMUNITY_RATE_LIMITER) {
    const limit = await env.COMMUNITY_RATE_LIMITER.limit({ key: `team-box:${userId}` });
    if (!limit.success) return error(request, 429, "rate_limit_exceeded", "Try again later");
  }
  const result = await readBody(request);
  if (!result.ok) return result.response;
  const body = result.body;
  const since = sinceOf(body.since);
  if (
    !exactKeys(body, ["since", "ops"]) ||
    since === null ||
    !Array.isArray(body.ops) ||
    body.ops.length > MAX_OPS_PER_REQUEST ||
    !body.ops.every(validOp)
  )
    return error(request, 422, "invalid_ops", "Send since and valid ops");
  // Clocks far in the future would pin a key forever; clamp them to the server's day.
  const ops = body.ops.map((op) => ({ ...op, t: Math.min(op.t, now + 86_400_000) }));
  const guard = [userId, token, new Date(now).toISOString(), now];
  const committed = await commitBoxOps(env, userId, server, ops, now, writableOwner, guard, async () => {
    const refreshed = await requireAccess(request, env, true);
    return refreshed.ok ? null : refreshed.response;
  });
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
