// L3 — GEB
// Input: 现有 Haneoka 会话、D1 及严格云快照请求。
// Output: 私有历史读写、CAS 归并／别名兼容、原始备份和刷新序号。
// Pos: [Map](L2.md)；抽卡历史账号同步边界。
// Effects/Dependencies: 私有 D1，摘要和刷新可仅传输元数据；复用 SQL guard、保留 1 MiB/64 账户限制。
import { HISTORY_REGIONS, type HistoryRegion } from "@haneoka/game-data-exporter/gacha-history";
import {
  HISTORY_CLOUD_BYTES,
  HISTORY_CLOUD_SCHEMA,
  HistoryCloudDataError,
  historyCloudAccountKeyValid,
  mergeCloudHistory,
  parseCloudHistory,
  parseStoredCloudHistory,
  type StoredCloudHistory,
  type HistoryCombineSource,
} from "../src/lib/gacha-history-cloud-data";
import {
  privateTeamJson as json,
  privateTeamError as error,
  teamExactKeys as exactKeys,
  teamSameOrigin as sameOrigin,
  requireTeamAccess as requireAccess,
  readTeamBody as readBody,
  writableTeamOwner as writableOwner,
} from "./team-inventory";

const PREFIX = "/api/v1/gacha-history";
const WRITE_ATTEMPTS = 6;
const MAX_ACCOUNTS = 64;
const sequence = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

interface HistoryRowSummary {
  accountKey: string;
  server: HistoryRegion;
  revision: number;
  updatedAt: number;
  refreshRequested: number;
  refreshCompleted: number;
  aliasesJson?: string;
}
type HistoryRow = HistoryRowSummary & { historyJson: string };
const summaryColumns =
  "account_key AS accountKey, server, revision, updated_at AS updatedAt, refresh_requested AS refreshRequested, refresh_completed AS refreshCompleted";
const columns = `${summaryColumns}, history_json AS historyJson`;
const aliasColumns = `(SELECT json_group_array(alias_key) FROM account_gacha_history_alias a WHERE a.user_id = account_gacha_history.user_id AND a.canonical_key = account_gacha_history.account_key) AS aliasesJson`;
const canonicalSql =
  "COALESCE((SELECT canonical_key FROM account_gacha_history_alias WHERE user_id = ? AND alias_key = ?), ?)";
const historyQuery = (env: Env, userId: string, key: string, projection: string) =>
  env.DB.prepare(
    `SELECT ${projection}, ${aliasColumns} FROM account_gacha_history WHERE user_id = ? AND account_key = ${canonicalSql}`,
  ).bind(userId, userId, key, key);
const readHistory = (env: Env, userId: string, key: string) =>
  historyQuery(env, userId, key, columns).first<HistoryRow>();
const readSummary = (env: Env, userId: string, key: string) =>
  historyQuery(env, userId, key, summaryColumns).first<HistoryRowSummary>();
const summary = ({
  accountKey,
  server,
  revision,
  updatedAt,
  refreshRequested,
  refreshCompleted,
  aliasesJson,
}: HistoryRowSummary) => {
  if (!historyCloudAccountKeyValid(accountKey) || !HISTORY_REGIONS.includes(server))
    throw new HistoryCloudDataError("invalid_history", 422);
  return {
    accountKey,
    server,
    revision,
    updatedAt,
    refreshRequested,
    refreshCompleted,
    aliases: JSON.parse(aliasesJson ?? "[]") as string[],
  };
};
const storedHistory = (row: HistoryRow, key: string): StoredCloudHistory => {
  if (row.accountKey !== key) throw new HistoryCloudDataError("history_account_mismatch", 409);
  let value: unknown;
  try {
    value = JSON.parse(row.historyJson);
  } catch {
    throw new HistoryCloudDataError("invalid_history", 422);
  }
  return parseStoredCloudHistory(value, key, row.server);
};
const publicSummary = (ownerId: string, row: HistoryRowSummary, key: string) => ({
  ownerId,
  ...summary(row),
  accountKey: key,
  ...(row.accountKey !== key ? { canonicalAccountKey: row.accountKey } : {}),
});
const document = (ownerId: string, row: HistoryRowSummary, key: string, stored: StoredCloudHistory) => ({
  ...publicSummary(ownerId, row, key),
  histories: row.accountKey === key
    ? stored.histories
    : stored.histories.map((history) => ({ ...history, source: { ...history.source, accountKey: key } })),
});

export const listGachaHistory = async (env: Env, userId: string) =>
  (
    await env.DB.prepare(
      `SELECT ${summaryColumns}, ${aliasColumns} FROM account_gacha_history WHERE user_id = ? AND NOT EXISTS (SELECT 1 FROM account_gacha_history_alias a WHERE a.user_id = account_gacha_history.user_id AND a.alias_key = account_gacha_history.account_key) ORDER BY updated_at DESC`,
    )
      .bind(userId)
      .all<HistoryRowSummary>()
  ).results.map(summary);
export const readGachaHistory = async (env: Env, userId: string, key: string) => {
  const row = await readHistory(env, userId, key);
  return row ? document(userId, row, key, storedHistory(row, row.accountKey)) : null;
};

export async function handleGachaHistoryRequest(request: Request, env: Env): Promise<Response | null> {
  try {
    return await routeGachaHistoryRequest(request, env);
  } catch (cause) {
    if (cause instanceof HistoryCloudDataError)
      return error(
        request,
        cause.status,
        cause.message,
        cause.status === 409 ? "History account does not match" : "Send normalized history",
      );
    throw cause;
  }
}

async function routeGachaHistoryRequest(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== PREFIX && !url.pathname.startsWith(PREFIX + "/")) return null;
  const tail = url.pathname.slice(PREFIX.length);
  const match =
    tail === "" ? null : /^\/([a-f0-9]{64})(\/(?:refresh|combine|sources(?:\/[a-f0-9]{64})?))?$/u.exec(tail);
  if (tail && !match) return error(request, 404, "history_not_found", "History not found");
  const key = match?.[1] ?? null;
  const action = match?.[2] ?? "";
  const refresh = action === "/refresh";
  const combine = action === "/combine";
  const sources = action.startsWith("/sources");
  if (!sameOrigin(request)) return error(request, 403, "cross_origin_request", "Use the same-origin history endpoint");
  if (request.method === "OPTIONS")
    return new Response(null, {
      status: 204,
      headers: { Allow: "GET, HEAD, POST, OPTIONS", "Cache-Control": "private, no-store" },
    });
  const write = request.method === "POST";
  if (
    (!write && !["GET", "HEAD"].includes(request.method)) ||
    (write && key === null) ||
    ((refresh || combine) && !write) ||
    (sources && write)
  )
    return error(request, 405, "method_not_allowed", "Method not allowed");
  if (url.searchParams.size)
    return error(request, 400, "invalid_query", "History endpoints do not accept query parameters");
  if (!env.DB) return error(request, 503, "database_unavailable", "Database is not configured");
  const access = await requireAccess(request, env, write);
  if (!access.ok) return access.response;
  const { userId, token } = access.value;
  if (key === null) {
    return json(request, { ownerId: userId, accounts: await listGachaHistory(env, userId) });
  }
  if (sources) {
    const row = await readSummary(env, userId, key);
    if (!row) return error(request, 404, "history_not_found", "History not found");
    const sourceKey = action.slice("/sources/".length);
    const sourceSql = `FROM account_gacha_history h LEFT JOIN account_gacha_history_original o ON o.user_id = h.user_id AND o.account_key = h.account_key
      WHERE h.user_id = ? AND ((h.account_key = ? AND o.account_key IS NOT NULL) OR h.account_key IN
        (SELECT alias_key FROM account_gacha_history_alias WHERE user_id = ? AND canonical_key = ?))`;
    if (action === "/sources") {
      const rows = await env.DB.prepare(`SELECT h.account_key AS accountKey ${sourceSql}`)
        .bind(userId, row.accountKey, userId, row.accountKey)
        .all<{ accountKey: string }>();
      return json(request, { ownerId: userId, sources: rows.results });
    }
    if (request.method === "HEAD") {
      const exists = await env.DB.prepare(`SELECT 1 ${sourceSql} AND h.account_key = ?`)
        .bind(userId, row.accountKey, userId, row.accountKey, sourceKey).first();
      return exists ? json(request, {}) : error(request, 404, "history_not_found", "History not found");
    }
    const original = await env.DB.prepare(
      `SELECT h.account_key AS accountKey, h.server, COALESCE(o.history_json, h.history_json) AS historyJson,
      COALESCE(o.revision, h.revision) AS revision, COALESCE(o.updated_at, h.updated_at) AS updatedAt, 0 AS refreshRequested, 0 AS refreshCompleted
      ${sourceSql} AND h.account_key = ?`,
    )
      .bind(userId, row.accountKey, userId, row.accountKey, sourceKey)
      .first<HistoryRow>();
    return original
      ? json(request, document(userId, original, sourceKey, storedHistory(original, sourceKey)))
      : error(request, 404, "history_not_found", "History not found");
  }
  if (request.method === "HEAD") {
    const row = await readSummary(env, userId, key);
    return row ? json(request, {}) : error(request, 404, "history_not_found", "History not found");
  }
  if (!write) {
    const history = await readGachaHistory(env, userId, key);
    return history ? json(request, history) : error(request, 404, "history_not_found", "History not found");
  }
  if (
    env.COMMUNITY_RATE_LIMITER &&
    !(await env.COMMUNITY_RATE_LIMITER.limit({ key: `gacha-history:${userId}` })).success
  )
    return error(request, 429, "rate_limit_exceeded", "Try again later");
  const result = await readBody(request);
  if (!result.ok) {
    if (result.response.status === 413) return error(request, 413, "history_too_large", "Cloud history exceeds 1 MiB");
    if (result.response.status === 422) return error(request, 422, "invalid_history", "Send a history object");
    return result.response;
  }
  if (combine) {
    if (
      !exactKeys(result.body, ["histories", "sources"]) ||
      !Array.isArray(result.body.histories) ||
      !Array.isArray(result.body.sources) ||
      result.body.sources.length < 2 ||
      result.body.sources.length > MAX_ACCOUNTS
    )
      return error(request, 422, "invalid_history", "Send histories and source revisions");
    const claims = result.body.sources as Array<HistoryCombineSource & Record<string, unknown>>;
    if (
      claims.some(
        (value) =>
          !value ||
          !exactKeys(value, ["accountKey", "revision"]) ||
          !historyCloudAccountKeyValid(value.accountKey) ||
          (value.revision !== null && (!sequence(value.revision) || value.revision === 0)),
      ) ||
      new Set(claims.map((value) => value.accountKey)).size !== claims.length ||
      !claims.some((value) => value.accountKey === key && value.revision !== null)
    )
      return error(request, 422, "invalid_history", "Send source revisions");
    const histories = result.body.histories.map((value) => parseCloudHistory(value, key));
    if (!histories.length || new Set(histories.map((value) => value.source.server)).size !== 1)
      return error(request, 422, "invalid_history", "Send one server's histories");
    const row = await readSummary(env, userId, key);
    if (!row || row.accountKey !== key || row.server !== histories[0]!.source.server)
      return error(request, 409, "history_merge_conflict", "Sync histories again");
    const merged = { schema: HISTORY_CLOUD_SCHEMA, histories } satisfies StoredCloudHistory;
    const historyJson = JSON.stringify(merged);
    if (new TextEncoder().encode(historyJson).byteLength > HISTORY_CLOUD_BYTES)
      return error(request, 413, "history_too_large", "Cloud history exceeds 1 MiB");
    const now = Date.now();
    try {
      const writeMerge = env.DB.prepare(
        `INSERT INTO account_gacha_history_combine(id, user_id, canonical_key, sources_json, history_json, created_at)
        SELECT ?, ?, ?, ?, ?, ? WHERE ${writableOwner}`,
      )
        .bind(
          crypto.randomUUID(),
          userId,
          key,
          JSON.stringify(claims),
          historyJson,
          now,
          userId,
          token,
          new Date(now).toISOString(),
          now,
        );
      const [written, lookup] = await env.DB.batch<HistoryRowSummary>([
        writeMerge, historyQuery(env, userId, key, summaryColumns),
      ]);
      if (!written?.meta.changes) return error(request, 409, "history_session_expired", "Sign in again");
      const combined = lookup?.results[0];
      if (!combined) throw new Error("history_merge_summary_missing");
      return json(request, document(userId, combined, key, merged));
    } catch (cause) {
      if (cause instanceof Error && cause.message.includes("history_merge_conflict"))
        return error(request, 409, "history_merge_conflict", "Sync histories again");
      throw cause;
    }
  }
  if (refresh) {
    if (!exactKeys(result.body, [])) return error(request, 422, "invalid_refresh", "Send an empty refresh request");
    const compact = request.headers.get("X-Haneoka-History-Projection") === "summary";
    const now = Date.now();
    const update = env.DB.prepare(
      `UPDATE account_gacha_history SET revision = revision + 1, updated_at = ?, refresh_requested = refresh_requested + 1
       WHERE user_id = ? AND account_key = ${canonicalSql} AND ${writableOwner}
       RETURNING ${compact ? summaryColumns : columns}, ${aliasColumns}`,
    ).bind(now, userId, userId, key, key, userId, token, new Date(now).toISOString(), now);
    if (compact) {
      const row = await update.first<HistoryRowSummary>();
      if (row) return json(request, publicSummary(userId, row, key));
    } else {
      const row = await update.first<HistoryRow>();
      if (row) return json(request, document(userId, row, key, storedHistory(row, row.accountKey)));
    }
    const refreshed = await requireAccess(request, env, true);
    return refreshed.ok ? error(request, 404, "history_not_found", "History not found") : refreshed.response;
  }
  if (!exactKeys(result.body, ["history", "completedRequest"]) || !sequence(result.body.completedRequest))
    return error(request, 422, "invalid_history", "Send normalized history and completedRequest");
  const incoming = parseCloudHistory(result.body.history, key);
  const completed = result.body.completedRequest;
  for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
    const row = await readHistory(env, userId, key);
    const stored: StoredCloudHistory = row
      ? storedHistory(row, row.accountKey)
      : { schema: HISTORY_CLOUD_SCHEMA, histories: [] };
    if (row && row.server !== incoming.source.server)
      return error(request, 409, "history_server_mismatch", "History belongs to another server");
    const requested = row?.refreshRequested ?? 0;
    if (completed > requested) return error(request, 422, "invalid_refresh", "Refresh request is no longer current");
    const merged = mergeCloudHistory(stored, {
      ...incoming, source: { ...incoming.source, accountKey: row?.accountKey ?? key },
    });
    const historyJson = row && merged === stored ? row.historyJson : JSON.stringify(merged);
    const historyChanged = historyJson !== row?.historyJson;
    const refreshCompleted = Math.max(row?.refreshCompleted ?? 0, completed);
    if (row && !historyChanged && refreshCompleted === row.refreshCompleted)
      return json(request, document(userId, row, key, merged));
    if (historyChanged && new TextEncoder().encode(historyJson).byteLength > HISTORY_CLOUD_BYTES)
      return error(request, 413, "history_too_large", "Cloud history exceeds 1 MiB");
    const now = Date.now();
    const guard = [userId, token, new Date(now).toISOString(), now];
    const statement = row
      ? env.DB.prepare(
          `UPDATE account_gacha_history SET ${historyChanged ? "history_json = ?, " : ""}revision = revision + 1, updated_at = ?, refresh_completed = ? WHERE user_id = ? AND account_key = ? AND revision = ? AND ${canonicalSql} = account_key AND ${writableOwner} RETURNING ${summaryColumns}`,
        ).bind(
          ...(historyChanged ? [historyJson] : []),
          now,
          refreshCompleted,
          userId,
          row.accountKey,
          row.revision,
          userId,
          key,
          key,
          ...guard,
        )
      : env.DB.prepare(
          `INSERT INTO account_gacha_history(user_id, account_key, server, history_json, revision, updated_at, refresh_requested, refresh_completed) SELECT ?, ?, ?, ?, 1, ?, 0, 0 WHERE ${writableOwner} AND NOT EXISTS (SELECT 1 FROM account_gacha_history_alias WHERE user_id = ? AND alias_key = ?) AND (SELECT COUNT(*) FROM account_gacha_history h WHERE user_id = ? AND NOT EXISTS (SELECT 1 FROM account_gacha_history_alias a WHERE a.user_id = h.user_id AND a.alias_key = h.account_key)) < ? ON CONFLICT(user_id, account_key) DO NOTHING RETURNING ${summaryColumns}`,
        ).bind(userId, key, incoming.source.server, historyJson, now, ...guard, userId, key, userId, MAX_ACCOUNTS);
    const written = await statement.first<HistoryRowSummary>();
    if (written) return json(request, document(userId, { ...written, aliasesJson: row?.aliasesJson ?? "[]" }, key, merged));
    const refreshed = await requireAccess(request, env, true);
    if (!refreshed.ok) return refreshed.response;
    if (
      !row &&
      !(await readSummary(env, userId, key)) &&
      (await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM account_gacha_history h WHERE user_id = ? AND NOT EXISTS (SELECT 1 FROM account_gacha_history_alias a WHERE a.user_id = h.user_id AND a.alias_key = h.account_key)",
      )
        .bind(userId)
        .first<{ count: number }>())!.count >= MAX_ACCOUNTS
    )
      return error(request, 413, "history_account_limit", "Too many cloud history accounts");
  }
  return error(request, 503, "busy", "Try again");
}
