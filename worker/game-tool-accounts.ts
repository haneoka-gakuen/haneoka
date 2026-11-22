// L3 — GEB
// Input: Authenticated private game-tool account list and imports.
// Output: Owner-scoped profiles with an immutable catalog scope.
// Pos: [Map](L2.md); private accounts shared by Box, progress and recruitment.
// Effects/Dependencies: D1, Haneoka sessions, and community write authorization.
import {
  gameToolIdFromSave,
  isGameToolAccount,
  isGameToolAccountId,
  isGameToolAccountSettings,
  isLegacyGameToolSettingsId,
} from "../src/lib/game-tool-accounts";
import {
  privateTeamError as error,
  privateTeamJson as json,
  readTeamBody,
  requireTeamAccess,
  teamSameOrigin,
  writableTeamOwner,
} from "./team-inventory";

export async function handleGameToolAccounts(request: Request, env: Env): Promise<Response | null> {
  if (new URL(request.url).pathname !== "/api/v1/account/tool-accounts") return null;
  if (!teamSameOrigin(request)) return error(request, 403, "cross_origin_request", "Use a same-origin request");
  if (!["GET", "POST", "PATCH", "DELETE"].includes(request.method))
    return error(request, 405, "method_not_allowed", "Use GET, POST, PATCH or DELETE");
  if (!env.DB) return error(request, 503, "database_unavailable", "Database is not configured");
  const accountAccess = await requireTeamAccess(request, env, request.method !== "GET");
  if (!accountAccess.ok) return accountAccess.response;
  const { userId, token } = accountAccess.value;
  if (request.method === "GET") {
    const [profiles, legacy] = await Promise.all([
      env.DB.prepare("SELECT metadata_json, settings_json FROM account_game_tool WHERE user_id = ? ORDER BY id")
        .bind(userId)
        .all<{ metadata_json: string; settings_json: string | null }>(),
      env.DB.prepare(
        `
        SELECT DISTINCT server FROM (
          SELECT server FROM account_team_box WHERE user_id = ?
          UNION SELECT server FROM account_team_inventory WHERE user_id = ?
          UNION SELECT server FROM account_team_workspace WHERE user_id = ?
        ) WHERE server IN ('jp', 'intl')
      `,
      )
        .bind(userId, userId, userId)
        .all<{ server: string }>(),
    ]);
    return json(request, {
      accounts: profiles.results.map((row) => ({
        ...JSON.parse(row.metadata_json),
        settings: row.settings_json ? JSON.parse(row.settings_json) : undefined,
      })),
      legacy: legacy.results.map((row) => row.server),
    });
  }
  const parsed = await readTeamBody(request);
  if (!parsed.ok) return parsed.response;
  if (request.method === "DELETE") {
    const id = parsed.body.id;
    if (!isGameToolAccountId(id)) return error(request, 422, "invalid_game_tool_account", "Invalid game-tool account");
    if (isLegacyGameToolSettingsId(id))
      return error(request, 409, "game_tool_account_unavailable", "This profile is recoverable");
    const now = Date.now(),
      guard = [userId, token, new Date(now).toISOString(), now];
    const [, , acknowledgement] = await env.DB.batch<{ id: string }>([
      env.DB.prepare(`
        INSERT OR IGNORE INTO account_game_tool_purge(user_id, id) SELECT ?, ?
        WHERE ${writableTeamOwner} AND NOT EXISTS (
          SELECT 1 FROM account_game_tool WHERE user_id = ? AND id = ? AND uid IS NOT NULL
        )
      `).bind(userId, id, ...guard, userId, id),
      env.DB.prepare(`
        DELETE FROM account_game_tool WHERE user_id = ? AND id = ? AND uid IS NULL AND ${writableTeamOwner}
      `).bind(userId, id, ...guard),
      env.DB.prepare(`
        SELECT id FROM account_game_tool_purge WHERE user_id = ? AND id = ? AND ${writableTeamOwner}
      `).bind(userId, id, ...guard),
    ]);
    return acknowledgement?.results.length
      ? json(request, { deleted: true })
      : error(request, 409, "game_tool_account_unavailable", "This profile is recoverable or the session changed");
  }
  if (request.method === "PATCH") {
    const edits = parsed.body.settings;
    const now = Date.now(),
      guard = [userId, token, new Date(now).toISOString(), now];
    if (
      !Array.isArray(edits) ||
      !edits.length ||
      edits.length > 80 ||
      edits.some(
        (row) =>
          !isGameToolAccountId(row?.id) ||
          !isGameToolAccountSettings(row?.value) ||
          row.value.changedAt > now + 86_400_000,
      )
    )
      return error(request, 422, "invalid_game_tool_settings", "Invalid game-tool account settings");
    await env.DB.batch(
      edits.map(({ id, value }) =>
        env.DB.prepare(
          `
      UPDATE account_game_tool SET settings_json = ?, settings_time = ?
      WHERE user_id = ? AND id = ? AND settings_time <= ? AND ${writableTeamOwner}
    `,
        ).bind(JSON.stringify(value), value.changedAt, userId, id, value.changedAt, ...guard),
      ),
    );
    const flags = edits.map(() => "?").join(", ");
    const { results } = await env.DB.prepare(
      `SELECT id, settings_json FROM account_game_tool WHERE user_id = ? AND id IN (${flags})`,
    )
      .bind(userId, ...edits.map((row) => row.id))
      .all<{ id: string; settings_json: string | null }>();
    return json(request, {
      settings: results.map((row) => ({ id: row.id, value: row.settings_json ? JSON.parse(row.settings_json) : null })),
    });
  }
  const account = parsed.body.account;
  if (
    !isGameToolAccount(account) ||
    (account.uid && account.id !== (await gameToolIdFromSave(account.tool, account.server, account.uid)))
  )
    return error(request, 422, "invalid_game_tool_account", "Invalid game-tool account");
  const { id, tool, server, uid, name, rank, favoriteCardId, savedAt, historyKeys } = account;
  const now = Date.now();
  if (savedAt !== undefined && savedAt > now + 86_400_000)
    return error(request, 422, "invalid_game_save_time", "Game save time is too far ahead");
  const metadata = JSON.stringify({
    id,
    tool,
    server,
    uid,
    name,
    rank,
    favoriteCardId,
    savedAt,
    historyKeys: [...new Set(historyKeys)],
  });
  const written = await env.DB.prepare(
    `
    INSERT INTO account_game_tool(user_id, id, tool, server, uid, metadata_json, source_time)
    SELECT ?, ?, ?, ?, ?, ?, ?
    WHERE ${writableTeamOwner}
      AND NOT EXISTS (SELECT 1 FROM account_game_tool_purge WHERE user_id = ? AND id = ?)
      AND (EXISTS (SELECT 1 FROM account_game_tool WHERE user_id = ? AND id = ?)
        OR (SELECT COUNT(*) FROM account_game_tool WHERE user_id = ?) < 80)
    ON CONFLICT(user_id, id) DO UPDATE SET
      metadata_json = json_set(
        CASE WHEN excluded.source_time >= account_game_tool.source_time
          THEN excluded.metadata_json ELSE account_game_tool.metadata_json END,
        '$.historyKeys', json((SELECT json_group_array(value) FROM (
          SELECT value FROM json_each(account_game_tool.metadata_json, '$.historyKeys')
          UNION SELECT value FROM json_each(excluded.metadata_json, '$.historyKeys') LIMIT 64
        )))
      ),
      source_time = MAX(account_game_tool.source_time, excluded.source_time)
    WHERE account_game_tool.tool = excluded.tool AND account_game_tool.server = excluded.server AND account_game_tool.uid IS excluded.uid
    RETURNING metadata_json, settings_json
  `,
  )
    .bind(
      userId,
      id,
      tool,
      server,
      uid ?? null,
      metadata,
      savedAt ?? 0,
      userId,
      token,
      new Date(now).toISOString(),
      now,
      userId,
      id,
      userId,
      id,
      userId,
    )
    .first<{ metadata_json: string; settings_json: string | null }>();
  if (!written && await env.DB.prepare("SELECT 1 FROM account_game_tool_purge WHERE user_id = ? AND id = ?").bind(userId, id).first())
    return error(request, 409, "game_tool_account_deleted", "This profile was permanently deleted");
  return written
    ? json(request, {
        account: {
          ...JSON.parse(written.metadata_json),
          settings: written.settings_json ? JSON.parse(written.settings_json) : undefined,
        },
      })
    : error(request, 409, "game_tool_account_unavailable", "Account limit or identity changed");
}
