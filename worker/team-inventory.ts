import { getAuthSession } from "./auth";
import { communityAccessState } from "./access";

const PREFIX = "/api/v1/team-inventory/";
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_ENTRIES = 5000;
const MAX_MAP_ENTRIES = 2048;
const MAX_COUNTER = 1_000_000;
const MAX_ID = 2_147_483_647;

interface MemberEntry {
  instanceId: string;
  cardId: number;
  level: number | null;
  training: number | null;
  awakening: number | null;
  liveSkillLevel: number | null;
  gekisoSkillLevel: number | null;
  locked: boolean;
  excluded: boolean;
}
interface SnapshotEntry {
  instanceId: string;
  cardId: number;
  level: number | null;
  awakening: number | null;
  locked: boolean;
  excluded: boolean;
}
export interface TeamInventoryV1 {
  schema: "haneoka-team-inventory-v1";
  server: string;
  releaseId: string;
  members: MemberEntry[];
  snapshots: SnapshotEntry[];
  bandItems: Record<string, number | null>;
  characterRanks: Record<string, number | null>;
  bandRanks: Record<string, number | null>;
}
export interface TeamPlayerModifiers {
  characterTotalRank: number | null;
  musicMemoryPoints: Record<string, number | null>;
  characterMemoryPoints: Record<string, number | null>;
  vipRank: number | null;
}
export interface TeamInventoryV2 extends Omit<TeamInventoryV1, "schema"> {
  schema: "haneoka-team-inventory-v2";
  playerModifiers: TeamPlayerModifiers;
}
export type TeamInventory = TeamInventoryV1 | TeamInventoryV2;
interface InventoryRow {
  revision: number;
  inventoryJson: string;
}
interface Access {
  userId: string;
  token: string;
}
type AccessResult = { ok: true; value: Access } | { ok: false; response: Response };
type BodyResult = { ok: true; body: Record<string, unknown> } | { ok: false; response: Response };

const json = (request: Request, value: object, status = 200): Response =>
  new Response(request.method === "HEAD" ? null : JSON.stringify(value), {
    status,
    headers: {
      "Cache-Control": "private, no-store",
      "Content-Type": "application/json; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      Vary: "Cookie",
    },
  });
const error = (request: Request, status: number, code: string, message: string): Response =>
  json(request, { error: { code, message } }, status);
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const text = (value: unknown, maximum: number): value is string =>
  typeof value === "string" &&
  [...value].length >= 1 &&
  [...value].length <= maximum &&
  new TextEncoder().encode(value).byteLength <= maximum * 4 &&
  !/[\p{Cc}\p{Cs}]/u.test(value);
const counter = (value: unknown): value is number | null =>
  value === null || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_COUNTER);
const positiveId = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= MAX_ID;

const sameOrigin = (request: Request): boolean => {
  const site = request.headers.get("Sec-Fetch-Site");
  if (site && site !== "none" && site !== "same-origin") return false;
  const origin = request.headers.get("Origin");
  if (!origin) return true;
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
};

const requireAccess = async (request: Request, env: Env, write: boolean): Promise<AccessResult> => {
  const session = await getAuthSession(request, env, { authoritative: true });
  if (!session?.user?.id)
    return { ok: false, response: error(request, 401, "authentication_required", "Sign in required") };
  const expectedUser = request.headers.get("X-Haneoka-Expected-User");
  if (!expectedUser)
    return {
      ok: false,
      response: error(request, 400, "expected_user_required", "Send the expected Haneoka account identity"),
    };
  if (expectedUser !== session.user.id)
    return {
      ok: false,
      response: error(request, 409, "account_changed", "The signed-in account changed; reload its inventory"),
    };
  const access = await communityAccessState(env, session.user.id, write ? ["sign_in", "write"] : ["sign_in"]);
  if (!access)
    return { ok: false, response: error(request, 503, "profile_unavailable", "Account profile is unavailable") };
  if (access.status === "deleted")
    return { ok: false, response: error(request, 403, "account_deleted", "Account is unavailable") };
  if (access.restriction || (write && access.status !== "active")) {
    return { ok: false, response: error(request, 403, "account_restricted", "This account cannot save its inventory") };
  }
  if (write && !session.user.emailVerified) {
    return {
      ok: false,
      response: error(request, 403, "email_verification_required", "Verify the account email first"),
    };
  }
  return { ok: true, value: { userId: session.user.id, token: session.session.token } };
};

const readBody = async (request: Request): Promise<BodyResult> => {
  if (request.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    await request.body?.cancel();
    return { ok: false, response: error(request, 415, "content_type_required", "Use application/json") };
  }
  const length = request.headers.get("Content-Length");
  if (length !== null && (!/^\d+$/u.test(length) || Number(length) > MAX_BODY_BYTES)) {
    await request.body?.cancel();
    return { ok: false, response: error(request, 413, "request_too_large", "Inventory request exceeds 1 MiB") };
  }
  if (!request.body) return { ok: false, response: error(request, 400, "invalid_body", "A JSON body is required") };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      return { ok: false, response: error(request, 413, "request_too_large", "Inventory request exceeds 1 MiB") };
    }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const body: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
    return object(body)
      ? { ok: true, body }
      : { ok: false, response: error(request, 422, "invalid_body", "Send an inventory object") };
  } catch {
    return { ok: false, response: error(request, 400, "invalid_json", "Invalid JSON body") };
  }
};

const modifierCounter = (value: unknown): value is number | null =>
  value === null || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_ID);
const rankMap = (value: unknown, validValue = counter): boolean =>
  object(value) &&
  Object.keys(value).length <= MAX_MAP_ENTRIES &&
  Object.entries(value).every(
    ([key, entry]) => /^[1-9]\d{0,9}$/u.test(key) && Number(key) <= MAX_ID && validValue(entry),
  );

const modifiersValid = (value: unknown): value is TeamPlayerModifiers =>
  object(value) &&
  exactKeys(value, ["characterTotalRank", "musicMemoryPoints", "characterMemoryPoints", "vipRank"]) &&
  modifierCounter(value.characterTotalRank) &&
  rankMap(value.musicMemoryPoints, modifierCounter) &&
  rankMap(value.characterMemoryPoints, modifierCounter) &&
  (value.vipRank === null || positiveId(value.vipRank));

const duplicateCards = (value: unknown): { kind: "members" | "snapshots"; cardId: number }[] => {
  if (!object(value)) return [];
  const duplicates: { kind: "members" | "snapshots"; cardId: number }[] = [];
  for (const kind of ["members", "snapshots"] as const) {
    const rows = value[kind];
    if (!Array.isArray(rows)) continue;
    const seen = new Set<number>();
    const reported = new Set<number>();
    for (const row of rows) {
      if (!object(row) || !positiveId(row.cardId)) continue;
      if (seen.has(row.cardId) && !reported.has(row.cardId)) {
        duplicates.push({ kind, cardId: row.cardId });
        reported.add(row.cardId);
      }
      seen.add(row.cardId);
    }
  }
  return duplicates;
};

/** Transport bounds and shape; T20 validates the original Master values for the chosen release. */
const inventoryValid = (value: unknown, server: string): value is TeamInventory => {
  const v2 = object(value) && value.schema === "haneoka-team-inventory-v2";
  if (
    !object(value) ||
    !exactKeys(value, [
      "schema",
      "server",
      "releaseId",
      "members",
      "snapshots",
      "bandItems",
      "characterRanks",
      "bandRanks",
      ...(v2 ? ["playerModifiers"] : []),
    ]) ||
    (value.schema !== "haneoka-team-inventory-v1" && !v2) ||
    (v2 && !modifiersValid(value.playerModifiers)) ||
    value.server !== server ||
    !text(value.releaseId, 128) ||
    !Array.isArray(value.members) ||
    value.members.length > MAX_ENTRIES ||
    !Array.isArray(value.snapshots) ||
    value.snapshots.length > MAX_ENTRIES ||
    !rankMap(value.bandItems) ||
    !rankMap(value.characterRanks) ||
    !rankMap(value.bandRanks)
  )
    return false;
  const instances = new Set<string>();
  const entry = (row: unknown, member: boolean): boolean => {
    const numeric = member
      ? ["level", "training", "awakening", "liveSkillLevel", "gekisoSkillLevel"]
      : ["level", "awakening"];
    if (
      !object(row) ||
      !exactKeys(row, ["instanceId", "cardId", ...numeric, "locked", "excluded"]) ||
      !text(row.instanceId, 128) ||
      instances.has(row.instanceId) ||
      !positiveId(row.cardId) ||
      !numeric.every((key) => counter(row[key])) ||
      typeof row.locked !== "boolean" ||
      typeof row.excluded !== "boolean"
    )
      return false;
    instances.add(row.instanceId);
    return true;
  };
  return (
    value.members.every((row) => entry(row, true)) &&
    value.snapshots.every((row) => entry(row, false)) &&
    duplicateCards(value).length === 0
  );
};

const readInventory = (env: Env, userId: string, server: string): Promise<InventoryRow | null> =>
  env.DB.prepare(
    "SELECT revision, inventory_json AS inventoryJson FROM account_team_inventory WHERE user_id = ? AND server = ?",
  )
    .bind(userId, server)
    .first<InventoryRow>();
const documentValue = (ownerId: string, server: string, row: InventoryRow | null) => ({
  ownerId,
  server,
  revision: row?.revision ?? 0,
  inventory: row ? (JSON.parse(row.inventoryJson) as TeamInventory) : null,
});

// Rechecked inside the mutation after reading the body, so a revoked session or
// deleted/restricted account cannot revive data with an old in-flight request.
const writableOwner = `EXISTS (
  SELECT 1 FROM "session" AS active_session
  JOIN community_profile AS profile ON profile.user_id = active_session.userId
  JOIN "user" AS account ON account.id = profile.user_id
  WHERE active_session.userId = ? AND active_session.token = ?
    AND julianday(active_session.expiresAt) > julianday(?)
    AND profile.status = 'active' AND profile.deleted_at IS NULL AND account.emailVerified = 1
    AND NOT EXISTS (
      SELECT 1 FROM community_user_restriction
      WHERE user_id = profile.user_id AND kind IN ('sign_in', 'write') AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > ?)
    )
)`;

// The separate planning library shares account authorization and transport bounds.
export {
  json as privateTeamJson,
  error as privateTeamError,
  exactKeys as teamExactKeys,
  sameOrigin as teamSameOrigin,
  requireAccess as requireTeamAccess,
  readBody as readTeamBody,
  writableOwner as writableTeamOwner,
};

export const handleTeamInventoryRequest = async (request: Request, env: Env): Promise<Response | null> => {
  const url = new URL(request.url);
  if (!url.pathname.startsWith(PREFIX)) return null;
  const server = url.pathname.slice(PREFIX.length);
  if (!/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/u.test(server))
    return error(request, 404, "server_not_found", "Server not found");
  if (!sameOrigin(request))
    return error(request, 403, "cross_origin_request", "Use the same-origin inventory endpoint");
  if (request.method === "OPTIONS")
    return new Response(null, {
      status: 204,
      headers: { Allow: "GET, HEAD, PUT, OPTIONS", "Cache-Control": "private, no-store" },
    });
  if (!["GET", "HEAD", "PUT"].includes(request.method))
    return error(request, 405, "method_not_allowed", "Method not allowed");
  if (url.searchParams.size)
    return error(request, 400, "invalid_query", "Inventory endpoints do not accept query parameters");
  if (!env.DB) return error(request, 503, "database_unavailable", "Database is not configured");
  const write = request.method === "PUT";
  const access = await requireAccess(request, env, write);
  if (!access.ok) return access.response;
  const resourceServer = await env.DB.prepare("SELECT status FROM resource_server WHERE slug = ?")
    .bind(server)
    .first<{ status: string }>();
  if (!resourceServer) return error(request, 404, "server_not_found", "Server not found");
  const { userId, token } = access.value;
  if (!write) return json(request, documentValue(userId, server, await readInventory(env, userId, server)));
  if (resourceServer.status !== "active")
    return error(request, 409, "server_unavailable", "This resource server is not active");
  if (env.COMMUNITY_RATE_LIMITER) {
    const limit = await env.COMMUNITY_RATE_LIMITER.limit({ key: `team-inventory:${userId}` });
    if (!limit.success) return error(request, 429, "rate_limit_exceeded", "Try again later");
  }
  const result = await readBody(request);
  if (!result.ok) return result.response;
  const body = result.body;
  if (
    !exactKeys(body, ["expectedRevision", "inventory"]) ||
    typeof body.expectedRevision !== "number" ||
    !Number.isSafeInteger(body.expectedRevision) ||
    body.expectedRevision < 0 ||
    body.expectedRevision >= Number.MAX_SAFE_INTEGER
  )
    return error(request, 422, "invalid_inventory", "Send a valid inventory and expectedRevision");
  if (!inventoryValid(body.inventory, server)) {
    const duplicates = duplicateCards(body.inventory);
    if (duplicates.length)
      return json(
        request,
        {
          error: {
            code: "duplicate_card",
            message:
              "Keep one owned card per server, kind, and cardId; resolve historical practice conflicts before saving",
          },
          duplicates,
        },
        422,
      );
    return error(request, 422, "invalid_inventory", "Send a valid inventory and expectedRevision");
  }
  const expected = body.expectedRevision;
  const serialized = JSON.stringify(body.inventory);
  const now = Date.now();
  const guardValues = [userId, token, new Date(now).toISOString(), now];
  const statement =
    expected === 0
      ? env.DB.prepare(
          `INSERT INTO account_team_inventory(user_id, server, inventory_json, revision, updated_at)
        SELECT ?, ?, ?, 1, ? WHERE ${writableOwner}
          AND EXISTS (SELECT 1 FROM resource_server WHERE slug = ? AND status = 'active')
        ON CONFLICT(user_id, server) DO NOTHING
        RETURNING revision, inventory_json AS inventoryJson`,
        ).bind(userId, server, serialized, now, ...guardValues, server)
      : env.DB.prepare(
          `UPDATE account_team_inventory
        SET inventory_json = ?, revision = revision + 1, updated_at = ?
        WHERE user_id = ? AND server = ? AND revision = ? AND ${writableOwner}
          AND (? = 'haneoka-team-inventory-v2' OR json_extract(inventory_json, '$.schema') <> 'haneoka-team-inventory-v2')
          AND EXISTS (SELECT 1 FROM resource_server WHERE slug = ? AND status = 'active')
        RETURNING revision, inventory_json AS inventoryJson`,
        ).bind(serialized, now, userId, server, expected, ...guardValues, body.inventory.schema, server);
  const updated = await statement.first<InventoryRow>();
  if (updated) return json(request, documentValue(userId, server, updated));
  const refreshedAccess = await requireAccess(request, env, true);
  if (!refreshedAccess.ok) return refreshedAccess.response;
  const currentServer = await env.DB.prepare("SELECT status FROM resource_server WHERE slug = ?")
    .bind(server)
    .first<{ status: string }>();
  if (currentServer?.status !== "active")
    return error(request, 409, "server_unavailable", "This resource server is not active");
  const current = await readInventory(env, userId, server);
  if (
    current?.revision === expected &&
    body.inventory.schema === "haneoka-team-inventory-v1" &&
    (JSON.parse(current.inventoryJson) as TeamInventory).schema === "haneoka-team-inventory-v2"
  ) {
    return json(
      request,
      {
        error: {
          code: "inventory_schema_conflict",
          message: "Upgrade the inventory schema before saving to preserve player modifiers",
        },
        ...documentValue(userId, server, current),
      },
      409,
    );
  }
  return json(
    request,
    {
      error: { code: "revision_conflict", message: "The cloud inventory changed; merge with its current revision" },
      ...documentValue(userId, server, current),
    },
    409,
  );
};
