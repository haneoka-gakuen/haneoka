import { getAuthSession } from "./auth";
import { COMMENT_LAST_EDITED_AT_SELECT } from "./community-revision";

const ACTIVITY_PATH = "/api/v1/community/me/comments";
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

interface CommentActivityRow {
  body: string;
  canDelete: number;
  canEdit: number;
  createdAt: number;
  deletedAt: number | null;
  hiddenAt: number | null;
  id: string;
  lastEditedAt: number;
  moderationRevision: number;
  moderationStatus: "allow" | "block" | "pending" | "review";
  parentId: string | null;
  postAccessible: number;
  postId: string;
  postTitle: string | null;
  revisionCount: number;
  updatedAt: number;
  version: number;
}

interface Cursor {
  createdAt: number;
  id: string;
}

type JsonPrimitive = boolean | null | number | string;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

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

const singleParameter = (url: URL, name: string): string | null | undefined => {
  const values = url.searchParams.getAll(name);
  return values.length > 1 ? undefined : (values[0] ?? null);
};

const parseLimit = (value: string | null): number | null => {
  if (value === null) return DEFAULT_LIMIT;
  if (!/^\d{1,2}$/u.test(value)) return null;
  const limit = Number(value);
  return limit >= 1 && limit <= MAX_LIMIT ? limit : null;
};

const encodeCursor = (cursor: Cursor): string =>
  btoa(JSON.stringify(cursor)).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/gu, "");

const decodeCursor = (value: string | null): Cursor | null => {
  if (value === null) return null;
  if (!value || value.length > 512 || !/^[A-Za-z0-9_-]+$/u.test(value)) return null;
  try {
    const padded = value
      .replace(/-/gu, "+")
      .replace(/_/gu, "/")
      .padEnd(Math.ceil(value.length / 4) * 4, "=");
    const parsed: unknown = JSON.parse(atob(padded));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const createdAt = Reflect.get(parsed, "createdAt");
    const id = Reflect.get(parsed, "id");
    return typeof createdAt === "number" &&
      Number.isSafeInteger(createdAt) &&
      createdAt >= 0 &&
      typeof id === "string" &&
      UUID_PATTERN.test(id)
      ? { createdAt, id }
      : null;
  } catch {
    return null;
  }
};

const listOwnComments = async (request: Request, env: Env, url: URL): Promise<Response> => {
  const session = await getAuthSession(request, env);
  if (!session?.user?.id) return error(request, 401, "authentication_required", "Sign in required");
  const limitValue = singleParameter(url, "limit");
  const cursorValue = singleParameter(url, "cursor");
  if (limitValue === undefined || cursorValue === undefined) {
    return error(request, 400, "duplicate_query_parameter", "Pagination parameters may only be sent once");
  }
  const limit = parseLimit(limitValue);
  if (limit === null) return error(request, 400, "invalid_limit", `limit must be between 1 and ${MAX_LIMIT}`);
  const cursor = decodeCursor(cursorValue);
  if (cursorValue !== null && !cursor) return error(request, 400, "invalid_cursor", "The cursor is invalid");

  const accessiblePost = `post.status = 'published'
    AND post.deleted_at IS NULL
    AND post.moderation_status = 'allow'
    AND (post.visibility IN ('public', 'protected') OR post.author_id = viewer.user_id)
    AND NOT EXISTS (
      SELECT 1 FROM community_user_block AS block
      WHERE (block.blocker_user_id = viewer.user_id AND block.blocked_user_id = post.author_id)
         OR (block.blocker_user_id = post.author_id AND block.blocked_user_id = viewer.user_id)
    )`;
  const cursorSql = cursor ? "AND (comment.created_at < ? OR (comment.created_at = ? AND comment.id < ?))" : "";
  const cursorBindings = cursor ? [cursor.createdAt, cursor.createdAt, cursor.id] : [];
  const result = await env.DB.prepare(
    `WITH viewer(user_id) AS (SELECT ?)
     SELECT comment.id, comment.post_id AS postId, comment.parent_id AS parentId,
            comment.body, comment.version,
            comment.moderation_status AS moderationStatus,
            comment.moderation_revision AS moderationRevision,
            comment.created_at AS createdAt, comment.updated_at AS updatedAt,
            ${COMMENT_LAST_EDITED_AT_SELECT} AS lastEditedAt,
            comment.deleted_at AS deletedAt, comment.hidden_at AS hiddenAt,
            CASE WHEN ${accessiblePost} THEN post.title ELSE NULL END AS postTitle,
            CASE WHEN ${accessiblePost} THEN 1 ELSE 0 END AS postAccessible,
            CASE WHEN comment.deleted_at IS NULL THEN 1 ELSE 0 END AS canDelete,
            CASE WHEN comment.deleted_at IS NULL AND comment.hidden_at IS NULL
                   AND post.archived_at IS NULL AND post.comments_locked_at IS NULL
                   AND ${accessiblePost}
                 THEN 1 ELSE 0 END AS canEdit,
            (SELECT COUNT(*) FROM community_comment_revision AS revision
             WHERE revision.comment_id = comment.id) AS revisionCount
     FROM community_comment AS comment
     JOIN community_post AS post ON post.id = comment.post_id
     CROSS JOIN viewer
     WHERE comment.author_id = viewer.user_id
       ${cursorSql}
     ORDER BY comment.created_at DESC, comment.id DESC
     LIMIT ?`,
  )
    .bind(session.user.id, ...cursorBindings, limit + 1)
    .all<CommentActivityRow>();
  const hasMore = result.results.length > limit;
  const rows = hasMore ? result.results.slice(0, limit) : result.results;
  const last = rows.at(-1);
  return json(request, {
    comments: rows.map((row) => ({
      id: row.id,
      postId: row.postId,
      postTitle: row.postTitle,
      postAccessible: row.postAccessible === 1,
      parentId: row.parentId,
      body: row.body,
      moderationStatus: row.moderationStatus,
      moderationRevision: row.moderationRevision,
      version: row.version,
      revisionCount: row.revisionCount,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      lastEditedAt: row.lastEditedAt,
      deletedAt: row.deletedAt,
      hiddenAt: row.hiddenAt,
      viewer: { canDelete: row.canDelete === 1, canEdit: row.canEdit === 1 },
    })),
    nextCursor: hasMore && last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : null,
  });
};

export const handleCommunityActivityRequest = async (request: Request, env: Env): Promise<Response | null> => {
  const url = new URL(request.url);
  if (url.pathname !== ACTIVITY_PATH) return null;
  if (!env.DB) return error(request, 503, "database_unavailable", "Database is not configured");
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: { Allow: "GET, HEAD, OPTIONS", "Cache-Control": "no-store" } });
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return error(request, 405, "method_not_allowed", "Method not allowed");
  }
  return listOwnComments(request, env, url);
};
