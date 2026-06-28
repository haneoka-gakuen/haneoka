import { getAuthSession } from "./auth";
import type { ModerationEntityKind } from "./moderation";

interface AppealCaseRow {
  entityId: string;
  entityKind: ModerationEntityKind;
  entityRevision: number;
  id: string;
}

interface AppealRow extends AppealCaseRow {
  appealId: string;
  createdAt: number;
  resolutionReasonCode: string | null;
  resolvedAt: number | null;
  statement: string;
  status: "accepted" | "pending" | "rejected" | "superseded";
  updatedAt: number;
  version: number;
}

type JsonPrimitive = boolean | null | number | string;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

const APPEALS_PATH = "/api/v1/community/appeals";
const MAX_JSON_BYTES = 8 * 1024;
const MAX_STATEMENT_LENGTH = 2_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

const isJsonValue = (value: unknown): value is JsonValue => {
  if (value === null || typeof value === "boolean" || typeof value === "string") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value !== "object") return false;
  return Object.values(value).every(isJsonValue);
};

const isJsonObject = (value: JsonValue): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const json = (request: Request, value: JsonValue, status = 200): Response =>
  new Response(request.method === "HEAD" ? null : JSON.stringify(value), {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    },
  });

const error = (request: Request, status: number, code: string, message: string): Response =>
  json(request, { error: { code, message } }, status);

const sameOrigin = (request: Request): boolean => {
  const origin = request.headers.get("Origin");
  if (!origin) return request.headers.get("Sec-Fetch-Site") !== "cross-site";
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
};

const readJson = async (request: Request): Promise<JsonObject | null> => {
  if (!request.headers.get("Content-Type")?.toLocaleLowerCase("und").startsWith("application/json")) return null;
  const declared = Number(request.headers.get("Content-Length") || 0);
  if (declared > MAX_JSON_BYTES || !request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    length += part.value.byteLength;
    if (length > MAX_JSON_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
    return isJsonValue(parsed) && isJsonObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const isEntityKind = (value: JsonValue | undefined): value is ModerationEntityKind =>
  value === "attachment" || value === "comment" || value === "post" || value === "profile-name";

const requireAccess = async (request: Request, env: Env): Promise<{ userId: string } | { response: Response }> => {
  const session = await getAuthSession(request, env);
  if (!session?.user?.id) return { response: error(request, 401, "authentication_required", "Sign in required") };
  if (!session.user.emailVerified) {
    return { response: error(request, 403, "email_verification_required", "Verify the account email first") };
  }
  return { userId: session.user.id };
};

const listAppeals = async (request: Request, env: Env, userId: string): Promise<Response> => {
  const result = await env.DB.prepare(
    `SELECT appeal.id AS appealId, appeal.statement, appeal.status, appeal.version,
            appeal.resolution_reason_code AS resolutionReasonCode,
            appeal.created_at AS createdAt, appeal.updated_at AS updatedAt, appeal.resolved_at AS resolvedAt,
            moderation_case.id, moderation_case.entity_kind AS entityKind, moderation_case.entity_id AS entityId,
            moderation_case.entity_revision AS entityRevision
     FROM community_appeal AS appeal
     JOIN community_moderation_case AS moderation_case ON moderation_case.id = appeal.case_id
     WHERE appeal.appellant_user_id = ?
     ORDER BY appeal.created_at DESC, appeal.id DESC
     LIMIT 100`,
  )
    .bind(userId)
    .all<AppealRow>();
  return json(request, {
    appeals: result.results.map((item) => ({
      createdAt: item.createdAt,
      entityId: item.entityId,
      entityKind: item.entityKind,
      entityRevision: item.entityRevision,
      id: item.appealId,
      resolutionReasonCode: item.resolutionReasonCode,
      resolvedAt: item.resolvedAt,
      statement: item.statement,
      status: item.status,
      updatedAt: item.updatedAt,
      version: item.version,
    })),
  });
};

const createAppeal = async (request: Request, env: Env, userId: string): Promise<Response> => {
  if (env.COMMUNITY_RATE_LIMITER) {
    const limited = await env.COMMUNITY_RATE_LIMITER.limit({ key: `appeal:${userId}` });
    if (!limited.success) return error(request, 429, "rate_limit_exceeded", "Try again later");
  }
  const body = await readJson(request);
  const entityKind = body?.entityKind;
  const entityId = body?.entityId;
  const requestedEntityRevision = body?.entityRevision === undefined ? null : body.entityRevision;
  const validEntityRevision =
    requestedEntityRevision === null ||
    (typeof requestedEntityRevision === "number" &&
      Number.isSafeInteger(requestedEntityRevision) &&
      requestedEntityRevision >= 1);
  const statement =
    typeof body?.statement === "string"
      ? body.statement
          .normalize("NFKC")
          .replace(/[\u200B-\u200D\u2060\uFEFF]/gu, "")
          .trim()
      : "";
  const validEntityId =
    typeof entityId === "string" &&
    (entityKind === "profile-name"
      ? entityId.length >= 1 && entityId.length <= 200 && !/[\u0000-\u001F\u007F]/u.test(entityId)
      : UUID_PATTERN.test(entityId));
  if (
    !body ||
    !isEntityKind(entityKind) ||
    !validEntityId ||
    !validEntityRevision ||
    !statement ||
    /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(statement) ||
    [...statement].length > MAX_STATEMENT_LENGTH
  ) {
    return error(
      request,
      422,
      "invalid_appeal",
      "A blocked entity, an optional positive entity revision, and a 1-2000 character statement are required",
    );
  }
  const now = Date.now();
  const appealId = crypto.randomUUID();
  const result = await env.DB.prepare(
    `INSERT OR IGNORE INTO community_appeal
       (id, case_id, appellant_user_id, statement, status, version, created_at, updated_at)
     SELECT ?, moderation_case.id, ?, ?, 'pending', 1, ?, ?
     FROM community_moderation_case AS moderation_case
     WHERE moderation_case.entity_kind = ?
       AND moderation_case.entity_id = ?
       AND (? IS NULL OR moderation_case.entity_revision = ?)
       AND moderation_case.status = 'block'
       AND NOT EXISTS (
         SELECT 1 FROM community_moderation_case AS newer_case
         WHERE newer_case.entity_kind = moderation_case.entity_kind
           AND newer_case.entity_id = moderation_case.entity_id
           AND newer_case.entity_revision = moderation_case.entity_revision
           AND newer_case.policy_generation > moderation_case.policy_generation
       )
       AND (
         (moderation_case.entity_kind = 'post' AND EXISTS (
           SELECT 1 FROM community_post AS post
           WHERE post.id = moderation_case.entity_id
             AND post.author_id = ?
             AND post.moderation_revision = moderation_case.entity_revision
             AND post.moderation_status = 'block'
             AND post.deleted_at IS NULL
         ))
         OR (moderation_case.entity_kind = 'comment' AND EXISTS (
           SELECT 1 FROM community_comment AS comment
           WHERE comment.id = moderation_case.entity_id
             AND comment.author_id = ?
             AND comment.moderation_revision = moderation_case.entity_revision
             AND comment.moderation_status = 'block'
             AND comment.deleted_at IS NULL
         ))
         OR (moderation_case.entity_kind = 'attachment' AND EXISTS (
           SELECT 1 FROM community_attachment AS attachment
           WHERE attachment.id = moderation_case.entity_id
             AND attachment.owner_user_id = ?
             AND attachment.moderation_status = 'block'
             AND attachment.status = 'rejected'
             AND attachment.deleted_at IS NULL
         ))
         OR (moderation_case.entity_kind = 'profile-name' AND EXISTS (
           SELECT 1 FROM community_profile AS profile
           WHERE profile.user_id = moderation_case.entity_id
             AND profile.user_id = ?
             AND profile.status <> 'deleted'
             AND profile.deleted_at IS NULL
             AND profile.display_name_revision = moderation_case.entity_revision
             AND profile.display_name_status = 'block'
             AND profile.pending_display_name IS NOT NULL
         ))
       )
     ORDER BY moderation_case.updated_at DESC, moderation_case.created_at DESC, moderation_case.id DESC
     LIMIT 1`,
  )
    .bind(
      appealId,
      userId,
      statement,
      now,
      now,
      entityKind,
      entityId,
      requestedEntityRevision,
      requestedEntityRevision,
      userId,
      userId,
      userId,
      userId,
    )
    .run();
  if (!Number(result.meta.changes || 0)) {
    return error(request, 409, "appeal_already_exists", "This moderation decision has already been appealed");
  }
  const created = await env.DB.prepare(
    `SELECT moderation_case.entity_revision AS entityRevision
     FROM community_appeal AS appeal
     JOIN community_moderation_case AS moderation_case ON moderation_case.id = appeal.case_id
     WHERE appeal.id = ?
     LIMIT 1`,
  )
    .bind(appealId)
    .first<{ entityRevision: number }>();
  if (!created) throw new Error("The created moderation appeal could not be read");
  return json(
    request,
    {
      appeal: {
        createdAt: now,
        entityId,
        entityKind,
        entityRevision: created.entityRevision,
        id: appealId,
        statement,
        status: "pending",
        updatedAt: now,
        version: 1,
      },
    },
    201,
  );
};

export const handleAppealRequest = async (request: Request, env: Env): Promise<Response | null> => {
  const url = new URL(request.url);
  if (url.pathname !== APPEALS_PATH) return null;
  if (!env.DB) return error(request, 503, "database_unavailable", "Database is unavailable");
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: { Allow: "GET, HEAD, POST, OPTIONS" } });
  }
  if (request.method === "POST" && !sameOrigin(request)) {
    return error(request, 403, "cross_origin_request", "Cross-origin writes are not allowed");
  }
  const access = await requireAccess(request, env);
  if ("response" in access) return access.response;
  if (request.method === "GET" || request.method === "HEAD") return listAppeals(request, env, access.userId);
  if (request.method === "POST") return createAppeal(request, env, access.userId);
  return error(request, 405, "method_not_allowed", "Method not allowed");
};
