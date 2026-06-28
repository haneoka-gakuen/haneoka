import { communityAccessState, type CommunityRestrictionKind } from "./access";
import { getAuthSession, type AuthSession } from "./auth";
import { COMMENT_LAST_EDITED_AT_SELECT } from "./community-revision";
import { requestIpMetadata } from "./ip-address";
import { inspectCommunityText, scheduleEntityModeration } from "./moderation";
import { requestClientMetadata, type BrowserFamily, type OsFamily } from "./user-agent";

const COMMUNITY_PREFIX = "/api/v1/community";
const MAX_JSON_BYTES = 32 * 1024;
const COMMENT_BODY_MAX = 5_000;
const EDIT_REASON_MAX = 500;
const REPORT_DETAIL_MAX = 2_000;
const TAG_NAME_MAX = 32;
const DEFAULT_PAGE_SIZE = 30;
const MAX_PAGE_SIZE = 100;
const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;
const REPORT_HOURLY_LIMIT = 20;
const REPORT_DAILY_LIMIT = 100;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const UID_PATTERN = /^[1-9][0-9]{0,15}$/u;
const TAG_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}_-]{0,31}$/u;
const REASON_CODE_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,79}$/u;

type JsonPrimitive = boolean | null | number | string;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };
type PayloadErrorKind = "content_type" | "invalid" | "too_large";
type SocialAction = "block" | "follow" | "mute";
type TagPreferenceKind = "follow" | "mute";
type ReportTargetKind = "comment" | "post" | "user";
type ReportReason =
  "copyright" | "harassment" | "hate" | "misinformation" | "other" | "privacy" | "sexual" | "spam" | "violence";
type ModerationStatus = "allow" | "block" | "pending" | "review";
type Session = NonNullable<AuthSession>;
type MutationAccess = { ok: false; response: Response } | { ok: true; session: Session };
type ReadJsonResult = { error: PayloadErrorKind } | { value: JsonObject };
type BindValue = null | number | string;

interface PublicUserRow {
  image: string | null;
  name: string;
  uid: number;
  userId: string;
}

interface RelationshipRow {
  blockedBy: number;
  blocking: number;
  followedBy: number;
  following: number;
  muting: number;
}

interface TagRow {
  description: string | null;
  displayName: string;
  followerCount: number;
  id: string;
  normalizedName: string;
  postCount: number;
  preference: TagPreferenceKind | null;
  status: "active" | "hidden" | "merged";
}

interface ResolvedTagRow {
  description: string | null;
  displayName: string;
  id: string;
  normalizedName: string;
  status: "active" | "hidden" | "merged";
}

interface TagPreferenceRow extends ResolvedTagRow {
  createdAt: number;
  kind: TagPreferenceKind;
  preferenceTagId: string;
}

interface TagCursor {
  id: string;
  name: string;
}

interface TimeCursor {
  createdAt: number;
  id: string;
}

interface AccessiblePostRow {
  authorId: string;
  id: string;
  moderationRevision: number;
}

interface ReportTarget {
  commentId: string | null;
  postId: string | null;
  reportedUserId: string | null;
  targetRevision: number | null;
  publicTargetId: number | string;
  targetKind: ReportTargetKind;
}

interface ReportRow {
  createdAt: number;
  id: string;
  status: "dismissed" | "pending" | "resolved" | "reviewing";
  version: number;
}

interface ReportQuotaRow {
  dayCount: number;
  hourCount: number;
}

interface CommentOwnershipRow {
  archivedAt: number | null;
  authorId: string;
  blocked: number;
  body: string;
  commentsLockedAt: number | null;
  deletedAt: number | null;
  hiddenAt: number | null;
  moderationRevision: number;
  postAuthorId: string;
  postDeletedAt: number | null;
  postModerationStatus: ModerationStatus;
  postStatus: "draft" | "hidden" | "published";
  postVisibility: "private" | "protected" | "public";
  version: number;
}

interface CommentResponseRow {
  authorId: string;
  authorImage: string | null;
  authorName: string;
  authorUid: number;
  body: string;
  browserFamily: BrowserFamily | null;
  createdAt: number;
  id: string;
  ipCountryCode: string | null;
  ipRegionCode: string | null;
  ipRegionName: string | null;
  lastEditedAt: number;
  likeCount: number;
  moderationStatus: ModerationStatus;
  osFamily: OsFamily | null;
  parentId: string | null;
  updatedAt: number;
  version: number;
  viewerLiked: number;
}

interface CommentReactionRow {
  authorId: string;
  likeCount: number;
  postId: string;
}

const isJsonValue = (value: unknown): value is JsonValue => {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return true;
  }
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value !== "object") return false;
  return Object.values(value).every(isJsonValue);
};

const isJsonObject = (value: JsonValue): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const requestId = (request: Request): string => request.headers.get("cf-ray") || crypto.randomUUID();

const json = (request: Request, value: object, status = 200, extraHeaders: HeadersInit = {}): Response => {
  const headers = new Headers(extraHeaders);
  headers.set("Cache-Control", "no-store");
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Request-Id", requestId(request));
  return new Response(request.method === "HEAD" ? null : JSON.stringify(value), { headers, status });
};

const error = (request: Request, status: number, code: string, message: string): Response =>
  json(request, { error: { code, message } }, status);

const payloadError = (request: Request, kind: PayloadErrorKind): Response =>
  kind === "too_large"
    ? error(request, 413, "request_too_large", "The JSON request body is too large")
    : error(request, 400, `invalid_${kind}`, "A valid JSON body is required");

const sameOrigin = (request: Request): boolean => {
  const fetchSite = request.headers.get("Sec-Fetch-Site");
  if (fetchSite && fetchSite !== "none" && fetchSite !== "same-origin") return false;
  const origin = request.headers.get("Origin");
  if (!origin) return fetchSite === null || fetchSite === "none" || fetchSite === "same-origin";
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
};

const readJson = async (request: Request): Promise<ReadJsonResult> => {
  if (!request.headers.get("Content-Type")?.toLowerCase().startsWith("application/json") || !request.body) {
    return { error: "content_type" };
  }
  const contentLength = request.headers.get("Content-Length");
  if (contentLength && (!/^\d{1,10}$/u.test(contentLength) || Number(contentLength) > MAX_JSON_BYTES)) {
    await request.body.cancel();
    return { error: "too_large" };
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > MAX_JSON_BYTES) {
      await reader.cancel();
      return { error: "too_large" };
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
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
    return isJsonValue(parsed) && isJsonObject(parsed) ? { value: parsed } : { error: "invalid" };
  } catch {
    return { error: "invalid" };
  }
};

const cleanText = (value: JsonValue | undefined, maximum: number): string | null => {
  if (typeof value !== "string") return null;
  const normalized = value.normalize("NFC").trim();
  return normalized && [...normalized].length <= maximum ? normalized : null;
};

const optionalText = (value: JsonValue | undefined, maximum: number): string | null | undefined => {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return undefined;
  const normalized = value.normalize("NFC").trim();
  return [...normalized].length <= maximum ? normalized || null : undefined;
};

const expectedVersion = (value: JsonValue | undefined): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 1 ? value : null;

const normalizeTag = (value: string): string | null => {
  const normalized = value.normalize("NFKC").replace(/^#/u, "").toLocaleLowerCase("und").trim();
  return [...normalized].length <= TAG_NAME_MAX && TAG_PATTERN.test(normalized) ? normalized : null;
};

const requireMutationAccess = async (
  request: Request,
  env: Env,
  message: string,
  restrictionKinds: readonly CommunityRestrictionKind[] = ["sign_in", "write"],
): Promise<MutationAccess> => {
  const session = await getAuthSession(request, env);
  if (!session?.user?.id) return { ok: false, response: error(request, 401, "authentication_required", message) };
  if (!session.user.emailVerified) {
    return {
      ok: false,
      response: error(request, 403, "email_verification_required", "Verify the account email before continuing"),
    };
  }
  const access = await communityAccessState(env, session.user.id, restrictionKinds);
  if (!access || access.status !== "active") {
    return { ok: false, response: error(request, 403, "account_unavailable", "This account is not active") };
  }
  if (access.restriction) {
    return {
      ok: false,
      response: error(request, 403, "community_action_restricted", "This account cannot perform this action"),
    };
  }
  if (env.COMMUNITY_RATE_LIMITER) {
    const result = await env.COMMUNITY_RATE_LIMITER.limit({ key: session.user.id });
    if (!result.success) {
      return {
        ok: false,
        response: json(
          request,
          { error: { code: "rate_limit_exceeded", message: "Too many community actions" } },
          429,
          { "Retry-After": "60" },
        ),
      };
    }
  }
  return { ok: true, session: session as Session };
};

const parseLimit = (url: URL): number | null => {
  const values = url.searchParams.getAll("limit");
  if (values.length > 1) return null;
  const raw = values[0];
  if (raw === undefined) return DEFAULT_PAGE_SIZE;
  if (!/^\d{1,3}$/u.test(raw)) return null;
  const value = Number(raw);
  return value >= 1 && value <= MAX_PAGE_SIZE ? value : null;
};

const encodeCursor = (value: TagCursor | TimeCursor): string => {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/gu, "");
};

const decodeCursor = <T extends TagCursor | TimeCursor>(value: string | null): T | null => {
  if (!value || value.length > 512) return null;
  try {
    const base64 = value.replace(/-/gu, "+").replace(/_/gu, "/");
    const binary = atob(`${base64}${"=".repeat((4 - (base64.length % 4)) % 4)}`);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
    return parsed && typeof parsed === "object" ? (parsed as T) : null;
  } catch {
    return null;
  }
};

const decodePath = (pathname: string): string[] | null => {
  const suffix = pathname.slice(COMMUNITY_PREFIX.length).replace(/^\/+|\/+$/gu, "");
  if (!suffix) return [];
  try {
    return suffix.split("/").map((segment) => decodeURIComponent(segment));
  } catch {
    return null;
  }
};

const publicUserByUid = async (env: Env, uid: number): Promise<PublicUserRow | null> =>
  env.DB.prepare(
    `SELECT account.id AS userId, identity.uid, profile.display_name AS name, account.image
     FROM community_identity AS identity
     JOIN "user" AS account ON account.id = identity.user_id
     JOIN community_profile AS profile ON profile.user_id = identity.user_id
     WHERE identity.uid = ? AND profile.status = 'active' AND profile.deleted_at IS NULL
       AND profile.display_name IS NOT NULL
     LIMIT 1`,
  )
    .bind(uid)
    .first<PublicUserRow>();

const relationshipState = async (env: Env, viewerId: string, targetId: string): Promise<RelationshipRow> => {
  const row = await env.DB.prepare(
    `SELECT
       EXISTS(SELECT 1 FROM community_user_follow
              WHERE follower_user_id = ? AND followed_user_id = ?) AS following,
       EXISTS(SELECT 1 FROM community_user_follow
              WHERE follower_user_id = ? AND followed_user_id = ?) AS followedBy,
       EXISTS(SELECT 1 FROM community_user_block
              WHERE blocker_user_id = ? AND blocked_user_id = ?) AS blocking,
       EXISTS(SELECT 1 FROM community_user_block
              WHERE blocker_user_id = ? AND blocked_user_id = ?) AS blockedBy,
       EXISTS(SELECT 1 FROM community_user_mute
              WHERE muter_user_id = ? AND muted_user_id = ?) AS muting`,
  )
    .bind(viewerId, targetId, targetId, viewerId, viewerId, targetId, targetId, viewerId, viewerId, targetId)
    .first<RelationshipRow>();
  if (!row) throw new Error("D1 did not return relationship state");
  return row;
};

const relationshipValue = (row: RelationshipRow) => ({
  following: row.following === 1,
  followedBy: row.followedBy === 1,
  blocked: row.blocking === 1,
  blocking: row.blocking === 1,
  blockedBy: row.blockedBy === 1,
  muted: row.muting === 1,
  muting: row.muting === 1,
  canFollow: row.blocking !== 1 && row.blockedBy !== 1,
});

const putUserRelationship = async (
  request: Request,
  env: Env,
  uid: number,
  action: SocialAction,
): Promise<Response> => {
  const restrictionKinds: readonly CommunityRestrictionKind[] =
    action === "follow" ? ["sign_in", "write"] : ["sign_in"];
  const access = await requireMutationAccess(request, env, `Sign in to ${action} this user`, restrictionKinds);
  if (!access.ok) return access.response;
  const payload = await readJson(request);
  if ("error" in payload) return payloadError(request, payload.error);
  if (typeof payload.value.active !== "boolean") {
    return error(request, 422, "invalid_relationship", "The active boolean is required");
  }
  const target = await publicUserByUid(env, uid);
  if (!target) return error(request, 404, "user_not_found", "User not found");
  const viewerId = access.session.user.id;
  if (target.userId === viewerId) {
    return error(request, 422, "self_relationship_forbidden", "You cannot create a relationship with yourself");
  }
  const active = payload.value.active;
  const now = Date.now();
  const before = await relationshipState(env, viewerId, target.userId);
  if (action === "follow" && active && (before.blocking === 1 || before.blockedBy === 1)) {
    return error(request, 409, "relationship_blocked", "Blocked users cannot follow each other");
  }

  if (action === "follow" && active) {
    const activationId = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT OR IGNORE INTO community_user_follow
           (follower_user_id, followed_user_id, created_at, activation_id)
         SELECT ?, ?, ?, ?
         WHERE NOT EXISTS (
           SELECT 1 FROM community_user_block
           WHERE (blocker_user_id = ? AND blocked_user_id = ?)
              OR (blocker_user_id = ? AND blocked_user_id = ?)
         )`,
      ).bind(viewerId, target.userId, now, activationId, viewerId, target.userId, target.userId, viewerId),
      env.DB.prepare(
        `INSERT OR IGNORE INTO community_notification
           (id, recipient_user_id, actor_user_id, kind, activation_id, created_at)
         SELECT ?, ?, ?, 'follow', activation_id, ?
         FROM community_user_follow
         WHERE follower_user_id = ? AND followed_user_id = ? AND activation_id = ?`,
      ).bind(crypto.randomUUID(), target.userId, viewerId, now, viewerId, target.userId, activationId),
    ]);
  } else if (action === "follow") {
    await env.DB.prepare("DELETE FROM community_user_follow WHERE follower_user_id = ? AND followed_user_id = ?")
      .bind(viewerId, target.userId)
      .run();
  } else if (action === "block" && active) {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT OR IGNORE INTO community_user_block (blocker_user_id, blocked_user_id, created_at)
         VALUES (?, ?, ?)`,
      ).bind(viewerId, target.userId, now),
      env.DB.prepare("DELETE FROM community_user_mute WHERE muter_user_id = ? AND muted_user_id = ?").bind(
        viewerId,
        target.userId,
      ),
      env.DB.prepare(
        `DELETE FROM community_notification
         WHERE kind = 'follow'
           AND ((recipient_user_id = ? AND actor_user_id = ?)
             OR (recipient_user_id = ? AND actor_user_id = ?))`,
      ).bind(viewerId, target.userId, target.userId, viewerId),
    ]);
  } else if (action === "block") {
    await env.DB.prepare("DELETE FROM community_user_block WHERE blocker_user_id = ? AND blocked_user_id = ?")
      .bind(viewerId, target.userId)
      .run();
  } else if (active) {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO community_user_mute (muter_user_id, muted_user_id, created_at)
       VALUES (?, ?, ?)`,
    )
      .bind(viewerId, target.userId, now)
      .run();
  } else {
    await env.DB.prepare("DELETE FROM community_user_mute WHERE muter_user_id = ? AND muted_user_id = ?")
      .bind(viewerId, target.userId)
      .run();
  }

  const relationship = await relationshipState(env, viewerId, target.userId);
  if (action === "follow" && active && relationship.following !== 1) {
    return error(request, 409, "relationship_blocked", "Blocked users cannot follow each other");
  }
  return json(request, {
    user: { uid: target.uid, name: target.name, image: target.image },
    relationship: relationshipValue(relationship),
  });
};

const tagCursor = (raw: string | null): TagCursor | null => {
  const cursor = decodeCursor<TagCursor>(raw);
  return cursor &&
    typeof cursor.name === "string" &&
    normalizeTag(cursor.name) === cursor.name &&
    UUID_PATTERN.test(cursor.id)
    ? cursor
    : null;
};

const timeCursor = (raw: string | null): TimeCursor | null => {
  const cursor = decodeCursor<TimeCursor>(raw);
  return cursor && Number.isSafeInteger(cursor.createdAt) && cursor.createdAt >= 0 && UUID_PATTERN.test(cursor.id)
    ? cursor
    : null;
};

const getTags = async (request: Request, env: Env, url: URL): Promise<Response> => {
  const limit = parseLimit(url);
  if (!limit) return error(request, 400, "invalid_limit", "limit must be between 1 and 100");
  const cursorValues = url.searchParams.getAll("cursor");
  if (cursorValues.length > 1) return error(request, 400, "duplicate_cursor", "cursor may only be sent once");
  const cursorRaw = cursorValues[0] ?? null;
  const cursor = cursorRaw ? tagCursor(cursorRaw) : null;
  if (cursorRaw && !cursor) return error(request, 400, "invalid_cursor", "The cursor is invalid");
  const queryValues = url.searchParams.getAll("q");
  if (queryValues.length > 1) return error(request, 400, "duplicate_query", "q may only be sent once");
  const query = queryValues[0]?.normalize("NFKC").trim() ?? null;
  if (query !== null && (!query || [...query].length > 64)) {
    return error(request, 400, "invalid_query", "q must contain 1-64 characters");
  }

  const session = await getAuthSession(request, env);
  const viewerId = session?.user?.id ?? null;
  const conditions = ["tag.status = 'active'"];
  const readablePostConditions = [
    "post.status = 'published'",
    "post.deleted_at IS NULL",
    `EXISTS (
      SELECT 1 FROM community_profile AS post_author_profile
      WHERE post_author_profile.user_id = post.author_id
        AND post_author_profile.status <> 'deleted'
        AND post_author_profile.display_name IS NOT NULL
    )`,
  ];
  const readablePostValues: BindValue[] = [];
  if (viewerId) {
    readablePostConditions.push(
      "(post.visibility IN ('public', 'protected') OR post.author_id = ?)",
      "(post.moderation_status = 'allow' OR post.author_id = ?)",
      "(post.archived_at IS NULL OR post.author_id = ?)",
      `NOT EXISTS (
        SELECT 1 FROM community_user_block AS viewer_block
        WHERE (viewer_block.blocker_user_id = ? AND viewer_block.blocked_user_id = post.author_id)
           OR (viewer_block.blocker_user_id = post.author_id AND viewer_block.blocked_user_id = ?)
      )`,
    );
    readablePostValues.push(viewerId, viewerId, viewerId, viewerId, viewerId);
  } else {
    readablePostConditions.push(
      "post.visibility = 'public'",
      "post.moderation_status = 'allow'",
      "post.archived_at IS NULL",
    );
  }
  const values: BindValue[] = [...readablePostValues, viewerId];
  if (query) {
    conditions.push(
      "(tag.normalized_name LIKE ? ESCAPE '\\' COLLATE NOCASE OR tag.display_name LIKE ? ESCAPE '\\' COLLATE NOCASE)",
    );
    const escaped = query.replace(/[\\%_]/gu, (character) => `\\${character}`);
    values.push(`%${escaped}%`, `%${escaped}%`);
  }
  if (cursor) {
    conditions.push(
      "(tag.normalized_name > ? COLLATE NOCASE OR (tag.normalized_name = ? COLLATE NOCASE AND tag.id > ?))",
    );
    values.push(cursor.name, cursor.name, cursor.id);
  }
  values.push(limit + 1);
  const result = await env.DB.prepare(
    `WITH readable_tag AS (
       SELECT post_tag.tag_id, COUNT(*) AS post_count
       FROM community_post_tag AS post_tag
       JOIN community_post AS post ON post.id = post_tag.post_id
       WHERE ${readablePostConditions.join(" AND ")}
       GROUP BY post_tag.tag_id
     )
     SELECT tag.id, tag.normalized_name AS normalizedName, tag.display_name AS displayName,
            tag.description, tag.status,
            (SELECT COUNT(*)
             FROM community_tag_preference AS preference_count
             JOIN community_profile AS preference_owner
               ON preference_owner.user_id = preference_count.user_id
              AND preference_owner.status <> 'deleted'
              AND preference_owner.display_name IS NOT NULL
             WHERE preference_count.tag_id = tag.id AND preference_count.kind = 'follow') AS followerCount,
            readable_tag.post_count AS postCount,
            (SELECT viewer_preference.kind
             FROM community_tag_preference AS viewer_preference
             WHERE viewer_preference.user_id = ? AND viewer_preference.tag_id = tag.id
             LIMIT 1) AS preference
     FROM community_tag AS tag
     JOIN readable_tag ON readable_tag.tag_id = tag.id
     WHERE ${conditions.join(" AND ")}
     ORDER BY tag.normalized_name COLLATE NOCASE, tag.id
     LIMIT ?`,
  )
    .bind(...values)
    .all<TagRow>();
  const hasMore = result.results.length > limit;
  const tags = result.results.slice(0, limit);
  const last = tags.at(-1);
  return json(request, {
    tags: tags.map((tag) => ({
      id: tag.id,
      normalizedName: tag.normalizedName,
      displayName: tag.displayName,
      description: tag.description,
      postCount: tag.postCount,
      followerCount: tag.followerCount,
      preference: tag.preference,
    })),
    nextCursor: hasMore && last ? encodeCursor({ name: last.normalizedName, id: last.id }) : null,
  });
};

const resolveTag = async (env: Env, normalizedName: string, includeHidden: boolean): Promise<ResolvedTagRow | null> =>
  env.DB.prepare(
    `WITH requested_tag(id) AS (
       SELECT id FROM community_tag WHERE normalized_name = ? COLLATE NOCASE
       UNION
       SELECT tag_id FROM community_tag_alias WHERE alias_normalized_name = ? COLLATE NOCASE
     ), resolved_tag(id) AS (
       SELECT CASE WHEN tag.status = 'merged' THEN tag.canonical_tag_id ELSE tag.id END
       FROM community_tag AS tag
       JOIN requested_tag ON requested_tag.id = tag.id
       LIMIT 1
     )
     SELECT tag.id, tag.normalized_name AS normalizedName, tag.display_name AS displayName,
            tag.description, tag.status
     FROM community_tag AS tag
     JOIN resolved_tag ON resolved_tag.id = tag.id
     WHERE (? = 1 OR tag.status = 'active')
     LIMIT 1`,
  )
    .bind(normalizedName, normalizedName, includeHidden ? 1 : 0)
    .first<ResolvedTagRow>();

const getTagPreferences = async (request: Request, env: Env, url: URL): Promise<Response> => {
  const session = await getAuthSession(request, env);
  if (!session?.user?.id) {
    return error(request, 401, "authentication_required", "Sign in to view tag preferences");
  }
  const limit = parseLimit(url);
  if (!limit) return error(request, 400, "invalid_limit", "limit must be between 1 and 100");
  const cursorValues = url.searchParams.getAll("cursor");
  if (cursorValues.length > 1) return error(request, 400, "duplicate_cursor", "cursor may only be sent once");
  const cursorRaw = cursorValues[0] ?? null;
  const cursor = cursorRaw ? timeCursor(cursorRaw) : null;
  if (cursorRaw && !cursor) return error(request, 400, "invalid_cursor", "The cursor is invalid");
  const values: BindValue[] = [session.user.id];
  const cursorWhere = cursor
    ? "AND (preference.created_at < ? OR (preference.created_at = ? AND preference.tag_id < ?))"
    : "";
  if (cursor) values.push(cursor.createdAt, cursor.createdAt, cursor.id);
  values.push(limit + 1);
  const result = await env.DB.prepare(
    `SELECT tag.id, tag.normalized_name AS normalizedName, tag.display_name AS displayName,
            tag.description, tag.status, preference.kind, preference.created_at AS createdAt,
            preference.tag_id AS preferenceTagId
     FROM community_tag_preference AS preference
     JOIN community_tag AS stored_tag ON stored_tag.id = preference.tag_id
     JOIN community_tag AS tag ON tag.id = COALESCE(stored_tag.canonical_tag_id, stored_tag.id)
     WHERE preference.user_id = ? ${cursorWhere}
     ORDER BY preference.created_at DESC, preference.tag_id DESC
     LIMIT ?`,
  )
    .bind(...values)
    .all<TagPreferenceRow>();
  const hasMore = result.results.length > limit;
  const preferences = result.results.slice(0, limit);
  const last = preferences.at(-1);
  return json(request, {
    preferences: preferences.map((preference) => ({
      kind: preference.kind,
      createdAt: preference.createdAt,
      tag: {
        id: preference.id,
        normalizedName: preference.normalizedName,
        displayName: preference.displayName,
        description: preference.description,
        status: preference.status,
      },
    })),
    nextCursor: hasMore && last ? encodeCursor({ createdAt: last.createdAt, id: last.preferenceTagId }) : null,
  });
};

const putTagPreference = async (request: Request, env: Env, normalizedNameValue: string): Promise<Response> => {
  const normalizedName = normalizeTag(normalizedNameValue);
  if (!normalizedName) return error(request, 404, "tag_not_found", "Tag not found");
  const access = await requireMutationAccess(request, env, "Sign in to update tag preferences");
  if (!access.ok) return access.response;
  const payload = await readJson(request);
  if ("error" in payload) return payloadError(request, payload.error);
  const preference = payload.value.preference;
  if (preference !== null && preference !== "follow" && preference !== "mute") {
    return error(request, 422, "invalid_tag_preference", "preference must be follow, mute, or null");
  }
  const tag = await resolveTag(env, normalizedName, preference === null);
  if (!tag) return error(request, 404, "tag_not_found", "Tag not found");
  const now = Date.now();
  if (preference === null) {
    await env.DB.prepare("DELETE FROM community_tag_preference WHERE user_id = ? AND tag_id = ?")
      .bind(access.session.user.id, tag.id)
      .run();
  } else {
    await env.DB.prepare(
      `INSERT INTO community_tag_preference (user_id, tag_id, kind, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id, tag_id) DO UPDATE SET kind = excluded.kind, created_at = excluded.created_at`,
    )
      .bind(access.session.user.id, tag.id, preference, now)
      .run();
  }
  return json(request, {
    preference:
      preference === null
        ? null
        : {
            kind: preference,
            createdAt: now,
          },
    tag: {
      id: tag.id,
      normalizedName: tag.normalizedName,
      displayName: tag.displayName,
      description: tag.description,
      status: tag.status,
    },
  });
};

const accessiblePostForViewer = async (env: Env, postId: string, viewerId: string): Promise<AccessiblePostRow | null> =>
  env.DB.prepare(
    `SELECT post.id, post.author_id AS authorId, post.moderation_revision AS moderationRevision
     FROM community_post AS post
     JOIN community_profile AS author_profile ON author_profile.user_id = post.author_id
     WHERE post.id = ? AND post.status = 'published' AND post.deleted_at IS NULL
       AND post.archived_at IS NULL AND post.moderation_status = 'allow'
       AND post.visibility IN ('public', 'protected')
       AND author_profile.status <> 'deleted' AND author_profile.display_name IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM community_user_block AS block
         WHERE (block.blocker_user_id = ? AND block.blocked_user_id = post.author_id)
            OR (block.blocker_user_id = post.author_id AND block.blocked_user_id = ?)
       )
     LIMIT 1`,
  )
    .bind(postId, viewerId, viewerId)
    .first<AccessiblePostRow>();

const putPostFeedback = async (request: Request, env: Env, postId: string): Promise<Response> => {
  const access = await requireMutationAccess(request, env, "Sign in to update feed feedback");
  if (!access.ok) return access.response;
  const payload = await readJson(request);
  if ("error" in payload) return payloadError(request, payload.error);
  const feedback = payload.value.feedback;
  if (feedback !== null && feedback !== "not_interested" && feedback !== "hide") {
    return error(request, 422, "invalid_feedback", "feedback must be not_interested, hide, or null");
  }
  const reasonValue = optionalText(payload.value.reasonCode, 80);
  if (
    reasonValue === undefined ||
    (reasonValue !== null && !REASON_CODE_PATTERN.test(reasonValue)) ||
    (feedback === null && reasonValue !== null)
  ) {
    return error(request, 422, "invalid_feedback_reason", "reasonCode is invalid");
  }
  const post = await accessiblePostForViewer(env, postId, access.session.user.id);
  if (!post) return error(request, 404, "post_not_found", "Post not found");
  const now = Date.now();
  if (feedback === null) {
    await env.DB.prepare("DELETE FROM community_post_feedback WHERE user_id = ? AND post_id = ?")
      .bind(access.session.user.id, postId)
      .run();
  } else {
    await env.DB.prepare(
      `INSERT INTO community_post_feedback (user_id, post_id, kind, reason_code, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id, post_id) DO UPDATE SET
         kind = excluded.kind, reason_code = excluded.reason_code, created_at = excluded.created_at`,
    )
      .bind(access.session.user.id, postId, feedback, reasonValue, now)
      .run();
  }
  return json(request, {
    feedback: feedback === null ? null : { kind: feedback, reasonCode: reasonValue, createdAt: now },
  });
};

const isReportReason = (value: JsonValue | undefined): value is ReportReason =>
  value === "spam" ||
  value === "harassment" ||
  value === "hate" ||
  value === "sexual" ||
  value === "violence" ||
  value === "privacy" ||
  value === "copyright" ||
  value === "misinformation" ||
  value === "other";

const reportTarget = async (
  env: Env,
  viewerId: string,
  targetKind: ReportTargetKind,
  targetIdValue: JsonValue | undefined,
): Promise<ReportTarget | null> => {
  if (targetKind === "user") {
    const rawUid =
      typeof targetIdValue === "number" && Number.isSafeInteger(targetIdValue)
        ? String(targetIdValue)
        : typeof targetIdValue === "string"
          ? targetIdValue
          : "";
    if (!UID_PATTERN.test(rawUid)) return null;
    const target = await env.DB.prepare(
      `SELECT identity.uid, identity.user_id AS userId
       FROM community_identity AS identity
       JOIN community_profile AS profile ON profile.user_id = identity.user_id
       WHERE identity.uid = ? AND profile.status <> 'deleted' AND profile.deleted_at IS NULL
       LIMIT 1`,
    )
      .bind(Number(rawUid))
      .first<{ uid: number; userId: string }>();
    return target
      ? {
          targetKind,
          publicTargetId: target.uid,
          postId: null,
          commentId: null,
          reportedUserId: target.userId,
          targetRevision: null,
        }
      : null;
  }
  if (typeof targetIdValue !== "string" || !UUID_PATTERN.test(targetIdValue)) return null;
  if (targetKind === "post") {
    const post = await accessiblePostForViewer(env, targetIdValue, viewerId);
    return post
      ? {
          targetKind,
          publicTargetId: post.id,
          postId: post.id,
          commentId: null,
          reportedUserId: null,
          targetRevision: post.moderationRevision,
        }
      : null;
  }
  const comment = await env.DB.prepare(
    `SELECT comment.id, comment.moderation_revision AS moderationRevision
     FROM community_comment AS comment
     JOIN community_post AS post ON post.id = comment.post_id
     JOIN community_profile AS comment_author ON comment_author.user_id = comment.author_id
     JOIN community_profile AS post_author ON post_author.user_id = post.author_id
     WHERE comment.id = ? AND comment.deleted_at IS NULL AND comment.hidden_at IS NULL
       AND comment.moderation_status = 'allow'
       AND post.status = 'published' AND post.deleted_at IS NULL AND post.archived_at IS NULL
       AND post.moderation_status = 'allow' AND post.visibility IN ('public', 'protected')
       AND comment_author.status <> 'deleted' AND comment_author.display_name IS NOT NULL
       AND post_author.status <> 'deleted' AND post_author.display_name IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM community_user_block AS block
         WHERE (block.blocker_user_id = ? AND block.blocked_user_id IN (comment.author_id, post.author_id))
            OR (block.blocker_user_id IN (comment.author_id, post.author_id) AND block.blocked_user_id = ?)
       )
     LIMIT 1`,
  )
    .bind(targetIdValue, viewerId, viewerId)
    .first<{ id: string; moderationRevision: number }>();
  return comment
    ? {
        targetKind,
        publicTargetId: comment.id,
        postId: null,
        commentId: comment.id,
        reportedUserId: null,
        targetRevision: comment.moderationRevision,
      }
    : null;
};

const findActiveReport = async (env: Env, reporterId: string, target: ReportTarget): Promise<ReportRow | null> => {
  const condition = target.postId ? "post_id = ?" : target.commentId ? "comment_id = ?" : "reported_user_id = ?";
  const id = target.postId ?? target.commentId ?? target.reportedUserId;
  return env.DB.prepare(
    `SELECT id, status, version, created_at AS createdAt
     FROM community_content_report
     WHERE reporter_user_id = ? AND ${condition} AND status IN ('pending', 'reviewing')
     LIMIT 1`,
  )
    .bind(reporterId, id)
    .first<ReportRow>();
};

const createReport = async (request: Request, env: Env): Promise<Response> => {
  const access = await requireMutationAccess(request, env, "Sign in to report community content", ["sign_in"]);
  if (!access.ok) return access.response;
  const payload = await readJson(request);
  if ("error" in payload) return payloadError(request, payload.error);
  const targetKind = payload.value.targetKind;
  if (targetKind !== "post" && targetKind !== "comment" && targetKind !== "user") {
    return error(request, 422, "invalid_report_target", "targetKind must be post, comment, or user");
  }
  if (!isReportReason(payload.value.reasonCode)) {
    return error(request, 422, "invalid_report_reason", "reasonCode is invalid");
  }
  const detail = optionalText(payload.value.details, REPORT_DETAIL_MAX);
  if (detail === undefined || (payload.value.reasonCode === "other" && detail === null)) {
    return error(request, 422, "invalid_report_detail", "details are invalid or required for the other reason");
  }
  const target = await reportTarget(env, access.session.user.id, targetKind, payload.value.targetId);
  if (!target) return error(request, 404, "report_target_not_found", "The report target was not found");
  const existing = await findActiveReport(env, access.session.user.id, target);
  if (existing) {
    return json(request, {
      report: {
        id: existing.id,
        targetKind,
        targetId: target.publicTargetId,
        status: existing.status,
        version: existing.version,
        createdAt: existing.createdAt,
      },
    });
  }
  const now = Date.now();
  const quota = await env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM community_content_report
        WHERE reporter_user_id = ? AND created_at >= ?) AS hourCount,
       (SELECT COUNT(*) FROM community_content_report
        WHERE reporter_user_id = ? AND created_at >= ?) AS dayCount`,
  )
    .bind(access.session.user.id, now - HOUR_MS, access.session.user.id, now - DAY_MS)
    .first<ReportQuotaRow>();
  if (!quota) throw new Error("D1 did not return report quota counts");
  if (quota.hourCount >= REPORT_HOURLY_LIMIT || quota.dayCount >= REPORT_DAILY_LIMIT) {
    return json(
      request,
      { error: { code: "report_quota_exceeded", message: "The report quota has been reached" } },
      429,
      { "Retry-After": "3600" },
    );
  }
  const id = crypto.randomUUID();
  const result = await env.DB.prepare(
    `INSERT OR IGNORE INTO community_content_report
       (id, reporter_user_id, post_id, comment_id, reported_user_id, target_revision, reason_code, detail,
        status, created_at, updated_at, version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, 1)`,
  )
    .bind(
      id,
      access.session.user.id,
      target.postId,
      target.commentId,
      target.reportedUserId,
      target.targetRevision,
      payload.value.reasonCode,
      detail,
      now,
      now,
    )
    .run();
  if (!result.meta.changes) {
    const raced = await findActiveReport(env, access.session.user.id, target);
    if (!raced) throw new Error("A report insert was ignored without an active report");
    return json(request, {
      report: {
        id: raced.id,
        targetKind,
        targetId: target.publicTargetId,
        status: raced.status,
        version: raced.version,
        createdAt: raced.createdAt,
      },
    });
  }
  return json(
    request,
    {
      report: {
        id,
        targetKind,
        targetId: target.publicTargetId,
        status: "pending",
        version: 1,
        createdAt: now,
      },
    },
    201,
  );
};

const readCommentOwnership = async (
  env: Env,
  commentId: string,
  viewerId: string,
): Promise<CommentOwnershipRow | null> =>
  env.DB.prepare(
    `SELECT comment.author_id AS authorId, comment.body, comment.version,
            comment.moderation_revision AS moderationRevision,
            comment.deleted_at AS deletedAt, comment.hidden_at AS hiddenAt,
            post.author_id AS postAuthorId, post.status AS postStatus,
            post.visibility AS postVisibility, post.deleted_at AS postDeletedAt,
            post.archived_at AS archivedAt, post.comments_locked_at AS commentsLockedAt,
            post.moderation_status AS postModerationStatus,
            EXISTS(
              SELECT 1 FROM community_user_block AS block
              WHERE (block.blocker_user_id = ? AND block.blocked_user_id = post.author_id)
                 OR (block.blocker_user_id = post.author_id AND block.blocked_user_id = ?)
            ) AS blocked
     FROM community_comment AS comment
     JOIN community_post AS post ON post.id = comment.post_id
     WHERE comment.id = ?
     LIMIT 1`,
  )
    .bind(viewerId, viewerId, commentId)
    .first<CommentOwnershipRow>();

const commentValue = (row: CommentResponseRow) => ({
  id: row.id,
  body: row.body,
  moderationStatus: row.moderationStatus,
  parentId: row.parentId,
  likeCount: row.likeCount,
  version: row.version,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  lastEditedAt: row.lastEditedAt,
  device: row.browserFamily || row.osFamily ? { browserFamily: row.browserFamily, osFamily: row.osFamily } : null,
  ipLocation: row.ipCountryCode
    ? {
        countryCode: row.ipCountryCode,
        regionCode: row.ipRegionCode,
        regionName: row.ipRegionName,
      }
    : null,
  authorUid: row.authorUid,
  avatarSeed: row.authorId,
  authorName: row.authorName,
  authorImage: row.authorImage,
  viewer: {
    liked: row.viewerLiked === 1,
    canEdit: true,
    canDelete: true,
  },
});

const readCommentResponse = async (env: Env, commentId: string, viewerId: string): Promise<CommentResponseRow | null> =>
  env.DB.prepare(
    `SELECT comment.id, comment.body, comment.parent_id AS parentId,
            comment.moderation_status AS moderationStatus, comment.like_count AS likeCount,
            comment.version, comment.created_at AS createdAt, comment.updated_at AS updatedAt,
            ${COMMENT_LAST_EDITED_AT_SELECT} AS lastEditedAt,
            comment.ip_country_code AS ipCountryCode, comment.ip_region_code AS ipRegionCode,
            comment.ip_region_name AS ipRegionName,
            comment.browser_family AS browserFamily, comment.os_family AS osFamily,
            account.id AS authorId, identity.uid AS authorUid,
            profile.display_name AS authorName, account.image AS authorImage,
            EXISTS(
              SELECT 1 FROM community_comment_reaction AS reaction
              WHERE reaction.comment_id = comment.id AND reaction.user_id = ? AND reaction.kind = 'like'
            ) AS viewerLiked
     FROM community_comment AS comment
     JOIN "user" AS account ON account.id = comment.author_id
     JOIN community_identity AS identity ON identity.user_id = comment.author_id
     JOIN community_profile AS profile ON profile.user_id = comment.author_id
     WHERE comment.id = ? AND profile.status <> 'deleted' AND profile.display_name IS NOT NULL
     LIMIT 1`,
  )
    .bind(viewerId, commentId)
    .first<CommentResponseRow>();

const logModerationFailure = (request: Request, commentId: string, failure: unknown): void => {
  console.error(
    JSON.stringify({
      event: "community.comment_edit.moderation_schedule_failed",
      commentId,
      requestId: request.headers.get("cf-ray") || null,
      error: failure instanceof Error ? { name: failure.name, message: failure.message } : String(failure),
    }),
  );
};

const patchComment = async (request: Request, env: Env, commentId: string): Promise<Response> => {
  const access = await requireMutationAccess(request, env, "Sign in to edit this comment");
  if (!access.ok) return access.response;
  const payload = await readJson(request);
  if ("error" in payload) return payloadError(request, payload.error);
  const body = cleanText(payload.value.body, COMMENT_BODY_MAX);
  const version = expectedVersion(payload.value.version);
  const editReason = optionalText(payload.value.editReason, EDIT_REASON_MAX);
  if (!body || version === null || editReason === undefined) {
    return error(request, 422, "invalid_comment_edit", "body, version, and an optional valid editReason are required");
  }
  const viewerId = access.session.user.id;
  const current = await readCommentOwnership(env, commentId, viewerId);
  if (!current || current.authorId !== viewerId) return error(request, 404, "comment_not_found", "Comment not found");
  if (current.deletedAt !== null) return error(request, 409, "comment_deleted", "Deleted comments cannot be edited");
  if (current.hiddenAt !== null) return error(request, 409, "comment_hidden", "Hidden comments cannot be edited");
  if (current.version !== version) {
    return error(request, 409, "version_conflict", "The comment changed; refresh and try again");
  }
  if (current.body === body) return error(request, 422, "comment_unchanged", "The edited comment has not changed");
  if (
    current.blocked === 1 ||
    current.postDeletedAt !== null ||
    current.archivedAt !== null ||
    current.commentsLockedAt !== null ||
    current.postStatus !== "published" ||
    current.postModerationStatus !== "allow" ||
    (current.postVisibility === "private" && current.postAuthorId !== viewerId)
  ) {
    return error(request, 409, "comment_edit_closed", "This discussion is not open for editing");
  }

  const inspection = inspectCommunityText(body);
  const moderationStatus = inspection.verdict === "allow" ? "pending" : "block";
  const nextRevision = current.moderationRevision + 1;
  const now = Date.now();
  const ip = requestIpMetadata(request);
  const client = requestClientMetadata(request);
  const results = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO community_comment_revision
         (comment_id, revision_number, editor_user_id, body, edit_reason, source_kind,
          ip_country_code, ip_region_code, ip_address, ip_region_name,
          user_agent, browser_family, os_family, created_at)
       SELECT comment.id, comment.moderation_revision + 1, ?, ?, ?, 'edit', ?, ?, ?, ?, ?, ?, ?, ?
       FROM community_comment AS comment
       JOIN community_post AS post ON post.id = comment.post_id
       WHERE comment.id = ? AND comment.author_id = ? AND comment.version = ?
         AND comment.moderation_revision = ? AND comment.deleted_at IS NULL AND comment.hidden_at IS NULL
         AND comment.body <> ?
         AND post.status = 'published' AND post.deleted_at IS NULL AND post.archived_at IS NULL
         AND post.comments_locked_at IS NULL AND post.moderation_status = 'allow'
         AND (post.visibility IN ('public', 'protected') OR post.author_id = ?)
         AND NOT EXISTS (
           SELECT 1 FROM community_user_block AS block
           WHERE (block.blocker_user_id = ? AND block.blocked_user_id = post.author_id)
              OR (block.blocker_user_id = post.author_id AND block.blocked_user_id = ?)
         )`,
    ).bind(
      viewerId,
      body,
      editReason,
      ip.countryCode,
      ip.regionCode,
      ip.ipAddress,
      ip.regionName,
      client.userAgent,
      client.browserFamily,
      client.osFamily,
      now,
      commentId,
      viewerId,
      version,
      current.moderationRevision,
      body,
      viewerId,
      viewerId,
      viewerId,
    ),
    env.DB.prepare(
      `UPDATE community_comment
       SET body = ?, moderation_status = ?, moderation_revision = ?, version = version + 1,
           ip_country_code = ?, ip_region_code = ?, ip_address = ?, ip_region_name = ?,
           user_agent = ?, browser_family = ?, os_family = ?, updated_at = ?
       WHERE id = ? AND author_id = ? AND version = ? AND moderation_revision = ?
         AND deleted_at IS NULL AND hidden_at IS NULL
         AND EXISTS (
           SELECT 1 FROM community_comment_revision AS revision
           WHERE revision.comment_id = community_comment.id
             AND revision.revision_number = ? AND revision.body = ?
         )`,
    ).bind(
      body,
      moderationStatus,
      nextRevision,
      ip.countryCode,
      ip.regionCode,
      ip.ipAddress,
      ip.regionName,
      client.userAgent,
      client.browserFamily,
      client.osFamily,
      now,
      commentId,
      viewerId,
      version,
      current.moderationRevision,
      nextRevision,
      body,
    ),
    env.DB.prepare(
      `UPDATE community_appeal
       SET status = 'superseded', reviewer_user_id = NULL,
           resolution_reason_code = 'system.entity_revision_superseded',
           resolution_id = id, version = version + 1, updated_at = ?, resolved_at = ?
       WHERE status = 'pending' AND case_id IN (
         SELECT moderation_case.id
         FROM community_moderation_case AS moderation_case
         WHERE moderation_case.entity_kind = 'comment' AND moderation_case.entity_id = ?
           AND moderation_case.entity_revision < ?
       )
         AND EXISTS (
           SELECT 1 FROM community_comment
           WHERE id = ? AND author_id = ? AND version = ? AND moderation_revision = ?
         )`,
    ).bind(now, now, commentId, nextRevision, commentId, viewerId, version + 1, nextRevision),
  ]);
  if (Number(results[0]?.meta.changes || 0) < 1 || Number(results[1]?.meta.changes || 0) < 1) {
    return error(request, 409, "version_conflict", "The comment changed; refresh and try again");
  }
  let moderationQueued: boolean;
  try {
    moderationQueued =
      (await scheduleEntityModeration(env, "comment", commentId, inspection, nextRevision)) === "pending";
  } catch (failure) {
    logModerationFailure(request, commentId, failure);
    const updated = await readCommentResponse(env, commentId, viewerId);
    if (!updated) throw new Error("The edited comment could not be read after moderation scheduling failed");
    return json(request, { moderationQueued: false, comment: commentValue(updated) }, 202);
  }
  const updated = await readCommentResponse(env, commentId, viewerId);
  if (!updated) throw new Error("The edited comment could not be read");
  return json(request, { moderationQueued, comment: commentValue(updated) });
};

const deleteComment = async (request: Request, env: Env, commentId: string): Promise<Response> => {
  const access = await requireMutationAccess(request, env, "Sign in to delete this comment", ["sign_in"]);
  if (!access.ok) return access.response;
  const payload = await readJson(request);
  if ("error" in payload) return payloadError(request, payload.error);
  const version = expectedVersion(payload.value.version);
  if (version === null) return error(request, 422, "invalid_comment_delete", "The current version is required");
  const viewerId = access.session.user.id;
  const current = await readCommentOwnership(env, commentId, viewerId);
  if (!current || current.authorId !== viewerId) return error(request, 404, "comment_not_found", "Comment not found");
  if (current.deletedAt !== null) return error(request, 409, "comment_deleted", "The comment is already deleted");
  if (current.version !== version) {
    return error(request, 409, "version_conflict", "The comment changed; refresh and try again");
  }
  const now = Date.now();
  const ip = requestIpMetadata(request);
  const eventId = crypto.randomUUID();
  const results = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO community_comment_state_event
         (id, comment_id, actor_user_id, event_kind, revision_number, reason_code,
          ip_country_code, ip_region_code, ip_address, ip_region_name, created_at)
       SELECT ?, comment.id, ?, 'deleted', comment.moderation_revision, 'user.self_delete', ?, ?, ?, ?, ?
       FROM community_comment AS comment
       WHERE comment.id = ? AND comment.author_id = ? AND comment.version = ?
         AND comment.deleted_at IS NULL`,
    ).bind(
      eventId,
      viewerId,
      ip.countryCode,
      ip.regionCode,
      ip.ipAddress,
      ip.regionName,
      now,
      commentId,
      viewerId,
      version,
    ),
    env.DB.prepare(
      `UPDATE community_comment
       SET deleted_at = ?, deleted_by_user_id = ?, delete_reason_code = 'user.self_delete',
           version = version + 1, updated_at = ?
       WHERE id = ? AND author_id = ? AND version = ? AND deleted_at IS NULL
         AND EXISTS (
           SELECT 1 FROM community_comment_state_event
           WHERE id = ? AND comment_id = community_comment.id AND event_kind = 'deleted'
         )`,
    ).bind(now, viewerId, now, commentId, viewerId, version, eventId),
  ]);
  if (Number(results[0]?.meta.changes || 0) < 1 || Number(results[1]?.meta.changes || 0) < 1) {
    return error(request, 409, "version_conflict", "The comment changed; refresh and try again");
  }
  return json(request, { comment: { id: commentId, version: version + 1, deletedAt: now } });
};

const accessibleCommentReactionTarget = async (
  env: Env,
  commentId: string,
  viewerId: string,
): Promise<CommentReactionRow | null> =>
  env.DB.prepare(
    `SELECT comment.author_id AS authorId, comment.post_id AS postId, comment.like_count AS likeCount
     FROM community_comment AS comment
     JOIN community_post AS post ON post.id = comment.post_id
     JOIN community_profile AS comment_author ON comment_author.user_id = comment.author_id
     JOIN community_profile AS post_author ON post_author.user_id = post.author_id
     WHERE comment.id = ? AND comment.deleted_at IS NULL AND comment.hidden_at IS NULL
       AND comment.moderation_status = 'allow'
       AND post.status = 'published' AND post.deleted_at IS NULL AND post.archived_at IS NULL
       AND post.moderation_status = 'allow' AND post.visibility IN ('public', 'protected')
       AND comment_author.status <> 'deleted' AND comment_author.display_name IS NOT NULL
       AND post_author.status <> 'deleted' AND post_author.display_name IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM community_user_block AS block
         WHERE (block.blocker_user_id = ? AND block.blocked_user_id IN (comment.author_id, post.author_id))
            OR (block.blocker_user_id IN (comment.author_id, post.author_id) AND block.blocked_user_id = ?)
       )
     LIMIT 1`,
  )
    .bind(commentId, viewerId, viewerId)
    .first<CommentReactionRow>();

const putCommentReaction = async (request: Request, env: Env, commentId: string): Promise<Response> => {
  const access = await requireMutationAccess(request, env, "Sign in to react to this comment");
  if (!access.ok) return access.response;
  const payload = await readJson(request);
  if ("error" in payload) return payloadError(request, payload.error);
  if (typeof payload.value.active !== "boolean") {
    return error(request, 422, "invalid_reaction", "The active boolean is required");
  }
  const viewerId = access.session.user.id;
  const target = await accessibleCommentReactionTarget(env, commentId, viewerId);
  if (!target) return error(request, 404, "comment_not_found", "Comment not found");
  const active = payload.value.active;
  const now = Date.now();
  const activationId = crypto.randomUUID();
  const write = active
    ? env.DB.prepare(
        `INSERT OR IGNORE INTO community_comment_reaction
           (comment_id, user_id, kind, created_at, activation_id)
         SELECT comment.id, ?, 'like', ?, ?
         FROM community_comment AS comment
         JOIN community_post AS post ON post.id = comment.post_id
         WHERE comment.id = ? AND comment.deleted_at IS NULL AND comment.hidden_at IS NULL
           AND comment.moderation_status = 'allow'
           AND post.status = 'published' AND post.deleted_at IS NULL AND post.archived_at IS NULL
           AND post.moderation_status = 'allow' AND post.visibility IN ('public', 'protected')
           AND NOT EXISTS (
             SELECT 1 FROM community_user_block AS block
             WHERE (block.blocker_user_id = ? AND block.blocked_user_id IN (comment.author_id, post.author_id))
                OR (block.blocker_user_id IN (comment.author_id, post.author_id) AND block.blocked_user_id = ?)
           )`,
      ).bind(viewerId, now, activationId, commentId, viewerId, viewerId)
    : env.DB.prepare(
        `DELETE FROM community_comment_reaction
         WHERE comment_id = ? AND user_id = ? AND kind = 'like'
           AND EXISTS (
             SELECT 1 FROM community_comment AS comment
             JOIN community_post AS post ON post.id = comment.post_id
             WHERE comment.id = ? AND comment.deleted_at IS NULL AND comment.hidden_at IS NULL
               AND comment.moderation_status = 'allow'
               AND post.status = 'published' AND post.deleted_at IS NULL AND post.archived_at IS NULL
               AND post.moderation_status = 'allow' AND post.visibility IN ('public', 'protected')
           )`,
      ).bind(commentId, viewerId, commentId);
  const statements = [write];
  if (active) {
    statements.push(
      env.DB.prepare(
        `INSERT OR IGNORE INTO community_notification
           (id, recipient_user_id, actor_user_id, kind, post_id, comment_id, activation_id, created_at)
         SELECT ?, comment.author_id, ?, 'comment_reaction', comment.post_id, comment.id,
                reaction.activation_id, ?
         FROM community_comment AS comment
         JOIN community_comment_reaction AS reaction
           ON reaction.comment_id = comment.id AND reaction.user_id = ? AND reaction.kind = 'like'
         WHERE comment.id = ? AND comment.author_id <> ? AND reaction.activation_id = ?`,
      ).bind(crypto.randomUUID(), viewerId, now, viewerId, commentId, viewerId, activationId),
    );
  }
  statements.push(
    env.DB.prepare(
      `SELECT comment.author_id AS authorId, comment.post_id AS postId,
              comment.like_count AS likeCount
       FROM community_comment AS comment
       WHERE comment.id = ? AND comment.deleted_at IS NULL AND comment.hidden_at IS NULL
       LIMIT 1`,
    ).bind(commentId),
  );
  const results = await env.DB.batch<CommentReactionRow>(statements);
  const updated = results.at(-1)?.results[0] ?? null;
  if (!updated) return error(request, 404, "comment_not_found", "Comment not found");
  return json(request, { active, likeCount: updated.likeCount });
};

const methodNotAllowed = (request: Request, allow: string): Response =>
  json(request, { error: { code: "method_not_allowed", message: "Method not allowed" } }, 405, { Allow: allow });

const mutation = (request: Request, operation: () => Promise<Response>): Promise<Response> =>
  sameOrigin(request)
    ? operation()
    : Promise.resolve(error(request, 403, "same_origin_required", "Community mutations require a same-origin request"));

export const handleCommunitySocialRequest = async (request: Request, env: Env): Promise<Response | null> => {
  const url = new URL(request.url);
  if (url.pathname !== COMMUNITY_PREFIX && !url.pathname.startsWith(`${COMMUNITY_PREFIX}/`)) return null;
  const path = decodePath(url.pathname);
  if (!path) return error(request, 404, "route_not_found", "Community API route not found");
  const method = request.method === "HEAD" ? "GET" : request.method;

  if (method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: { Allow: "GET, HEAD, POST, PATCH, PUT, DELETE, OPTIONS", "Cache-Control": "no-store" },
    });
  }

  if (path.length === 1 && path[0] === "tags") {
    if (method !== "GET") return methodNotAllowed(request, "GET, HEAD, OPTIONS");
    if (!env.DB) return error(request, 503, "database_unavailable", "Database is not configured");
    return getTags(request, env, url);
  }
  if (path.length === 2 && path[0] === "tags" && path[1] === "preferences") {
    if (method !== "GET") return methodNotAllowed(request, "GET, HEAD, OPTIONS");
    if (!env.DB) return error(request, 503, "database_unavailable", "Database is not configured");
    return getTagPreferences(request, env, url);
  }
  if (path.length === 3 && path[0] === "tags" && path[2] === "preference") {
    if (method !== "PUT") return methodNotAllowed(request, "PUT, OPTIONS");
    if (!env.DB) return error(request, 503, "database_unavailable", "Database is not configured");
    const normalizedName = path[1];
    return normalizedName
      ? mutation(request, () => putTagPreference(request, env, normalizedName))
      : error(request, 404, "tag_not_found", "Tag not found");
  }
  if (path.length === 3 && path[0] === "users" && path[1] && path[2]) {
    const rawUid = path[1];
    const action = path[2];
    if (!UID_PATTERN.test(rawUid) || (action !== "follow" && action !== "block" && action !== "mute")) return null;
    if (method !== "PUT") return methodNotAllowed(request, "PUT, OPTIONS");
    if (!env.DB) return error(request, 503, "database_unavailable", "Database is not configured");
    const uid = Number(rawUid);
    if (!Number.isSafeInteger(uid)) return error(request, 404, "user_not_found", "User not found");
    return mutation(request, () => putUserRelationship(request, env, uid, action));
  }
  if (path.length === 3 && path[0] === "posts" && path[1] && path[2] === "feedback") {
    const postId = path[1];
    if (!UUID_PATTERN.test(postId)) return null;
    if (method !== "PUT") return methodNotAllowed(request, "PUT, OPTIONS");
    if (!env.DB) return error(request, 503, "database_unavailable", "Database is not configured");
    return mutation(request, () => putPostFeedback(request, env, postId));
  }
  if (path.length === 1 && path[0] === "reports") {
    if (method !== "POST") return methodNotAllowed(request, "POST, OPTIONS");
    if (!env.DB) return error(request, 503, "database_unavailable", "Database is not configured");
    return mutation(request, () => createReport(request, env));
  }
  if (path.length === 2 && path[0] === "comments" && path[1] && UUID_PATTERN.test(path[1])) {
    if (method !== "PATCH" && method !== "DELETE") return methodNotAllowed(request, "PATCH, DELETE, OPTIONS");
    if (!env.DB) return error(request, 503, "database_unavailable", "Database is not configured");
    const commentId = path[1];
    return mutation(request, () =>
      method === "PATCH" ? patchComment(request, env, commentId) : deleteComment(request, env, commentId),
    );
  }
  if (path.length === 3 && path[0] === "comments" && path[1] && UUID_PATTERN.test(path[1]) && path[2] === "reaction") {
    if (method !== "PUT") return methodNotAllowed(request, "PUT, OPTIONS");
    if (!env.DB) return error(request, 503, "database_unavailable", "Database is not configured");
    const commentId = path[1];
    return mutation(request, () => putCommentReaction(request, env, commentId));
  }
  return null;
};
