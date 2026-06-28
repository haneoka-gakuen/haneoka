import { authConfiguration, getAuthSession, type AuthSession } from "./auth";
import { communityAccessState } from "./access";
import { COMMENT_LAST_EDITED_AT_SELECT } from "./community-revision";
import { handleCommunitySocialRequest } from "./community-social";
import { requestIpMetadata } from "./ip-address";
import { communityPostModerationText, inspectCommunityText, scheduleEntityModeration } from "./moderation";
import { requestClientMetadata, type BrowserFamily, type OsFamily } from "./user-agent";

const COMMUNITY_PREFIX = "/api/v1/community";
const MAX_JSON_BYTES = 256 * 1024;
const POST_TITLE_MAX = 120;
const POST_BODY_MAX = 20_000;
const POST_EXCERPT_MAX = 500;
const POST_HOURLY_LIMIT = 30;
const POST_DAILY_LIMIT = 200;
const COMMENT_BODY_MAX = 5_000;
const COMMENT_HOURLY_LIMIT = 300;
const COMMENT_DAILY_LIMIT = 2_000;
const COMMENT_PAGE_SIZE = 50;
const SEARCH_QUERY_MAX = 100;
const TAG_MAX = 32;
const TAG_LIMIT = 10;
const POST_ATTACHMENT_LIMIT = 10;
const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TAG_VALUE_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}_-]{0,31}$/u;
const ALLOWED_LOCALES = new Set(["ja", "en", "zh-TW", "zh-CN", "ko"]);

type JsonPrimitive = boolean | null | number | string;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };
type PayloadErrorKind = "content_type" | "invalid" | "too_large";
type PostVisibility = "private" | "protected" | "public";
type PostState = "active" | "archived";
type PostScope = "all" | "bookmarked" | "following" | "latest" | "mine" | "recommended";
type ListState = "active" | "all" | "archived";
type CommentSort = "hot" | "latest";
type NotificationKind =
  "comment" | "comment_reaction" | "follow" | "mention" | "moderation" | "post_reaction" | "reply";
type ModerationStatus = "allow" | "block" | "pending" | "review";
type BindValue = null | number | string;

interface Cursor {
  createdAt: number;
  id: string;
  pinnedAt?: number | null;
  rankAsOf?: number;
  rankScore?: number;
  recommendationSeed?: number;
}

interface CommunityProfileRow {
  role: "admin" | "member" | "moderator";
  status: "active" | "deleted" | "suspended";
}

interface AuthorFields {
  authorId: string;
  authorImage: string | null;
  authorName: string;
  authorUid: number;
}

interface IpLocationFields {
  ipCountryCode: string | null;
  ipRegionCode: string | null;
  ipRegionName: string | null;
}

interface DeviceFields {
  browserFamily: BrowserFamily | null;
  osFamily: OsFamily | null;
}

interface PostDatabaseFields extends AuthorFields, DeviceFields {
  archivedAt: number | null;
  commentCount: number;
  commentsLockedAt: number | null;
  createdAt: number;
  id: string;
  ipCountryCode: string | null;
  ipRegionCode: string | null;
  ipRegionName: string | null;
  lastEditedAt: number;
  likeCount: number;
  moderationStatus: ModerationStatus;
  pinnedAt: number | null;
  title: string;
  updatedAt: number;
  version: number;
  visibility: PostVisibility;
  rankScore?: number;
  recommendationReason?: "followed_author" | "followed_tag" | "popular" | "recent" | null;
}

interface PostRow extends PostDatabaseFields {
  body: string;
}

interface PostListRow extends PostDatabaseFields {
  body: string;
}

interface PostAttachment {
  contentUrl: string;
  fileName: string;
  id: string;
  mediaType: "image/jpeg" | "image/png" | "image/webp" | "text/plain";
  position: number;
  size: number;
}

type PostWithTags = PostRow & { attachments: PostAttachment[]; state: PostState; tags: string[] };
type PostListWithTags = Omit<PostListRow, "body"> & {
  attachments: PostAttachment[];
  excerpt: string;
  state: PostState;
  tags: string[];
};
type PublicPost = Omit<
  PostWithTags,
  "authorId" | "browserFamily" | "ipCountryCode" | "ipRegionCode" | "ipRegionName" | "osFamily"
> & {
  avatarSeed: string;
  device: { browserFamily: BrowserFamily | null; osFamily: OsFamily | null } | null;
  ipLocation: { countryCode: string; regionCode: string | null; regionName: string | null } | null;
};

interface PostTagRow {
  postId: string;
  tag: string;
}

interface PostTagWriteContext {
  now: number;
  postId: string;
  revisionNumber: number;
  userId: string;
  version: number;
}

interface PostAttachmentRow {
  fileName: string;
  id: string;
  mediaType: PostAttachment["mediaType"];
  position: number;
  postId: string;
  size: number;
}

interface CommentRow extends AuthorFields, DeviceFields {
  body: string;
  createdAt: number;
  id: string;
  ipCountryCode: string | null;
  ipRegionCode: string | null;
  ipRegionName: string | null;
  lastEditedAt: number;
  likeCount: number;
  moderationStatus: ModerationStatus;
  parentId: string | null;
  updatedAt: number;
  version: number;
  viewerLiked: number;
}

interface CommentStatusRow {
  moderationStatus: ModerationStatus;
}

interface AttachmentCandidateRow {
  id: string;
}

interface PostOwnershipRow {
  archivedAt: number | null;
  authorId: string;
  deletedAt: number | null;
  moderationRevision: number;
  pinnedAt: number | null;
  version: number;
}

interface CommentQuotaRow {
  dayCount: number;
  hourCount: number;
}

interface ViewerFlagRow {
  active: 1;
}

interface ReactionCountRow {
  likeCount: number;
}

interface NotificationRow {
  actorId: string | null;
  actorImage: string | null;
  actorName: string | null;
  actorUid: number | null;
  commentId: string | null;
  createdAt: number;
  id: string;
  kind: NotificationKind;
  postId: string | null;
  readAt: number | null;
}

interface UnreadCountRow {
  unreadCount: number;
}

interface ReadAtRow {
  readAt: number;
}

interface PreferenceDatabaseRow {
  assetServer: string | null;
  locale: string | null;
  settings: string | null;
  updatedAt: number;
  version: number;
}

interface PreferenceResponse {
  assetServer: string | null;
  locale: string | null;
  settings: JsonValue;
  updatedAt: number;
  version: number;
}

interface ListOptions {
  cursor: Cursor | null;
  limit: number;
  q: string | null;
  refresh: boolean;
  seed: number | null;
  scope: PostScope;
  state: ListState;
  tag: string | null;
}

interface SqlCondition {
  sql: string;
  values: BindValue[];
}

type Session = NonNullable<AuthSession>;
type WritableAccess = { ok: false; response: Response } | { ok: true; profile: CommunityProfileRow; session: Session };
type ReadJsonResult = { error: PayloadErrorKind } | { value: JsonObject };
type ParseResult<T> = { ok: false; response: Response } | { ok: true; value: T };

const isJsonValue = (value: unknown): value is JsonValue => {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return true;
  }
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value !== "object") return false;
  return Object.values(value).every(isJsonValue);
};

const isJsonObject = (value: JsonValue | undefined): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const json = (request: Request, value: object, status = 200, extraHeaders: HeadersInit = {}): Response =>
  new Response(request.method === "HEAD" ? null : JSON.stringify(value), {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      ...extraHeaders,
    },
  });

const error = (request: Request, status: number, code: string, message: string, headers: HeadersInit = {}): Response =>
  json(request, { error: { code, message } }, status, headers);

const publicAuthoredContent = <T extends AuthorFields & DeviceFields & IpLocationFields>(
  value: T,
): Omit<T, "authorId" | "browserFamily" | "ipCountryCode" | "ipRegionCode" | "ipRegionName" | "osFamily"> & {
  avatarSeed: string;
  device: { browserFamily: BrowserFamily | null; osFamily: OsFamily | null } | null;
  ipLocation: { countryCode: string; regionCode: string | null; regionName: string | null } | null;
} => {
  const { authorId, browserFamily, ipCountryCode, ipRegionCode, ipRegionName, osFamily, ...publicValue } = value;
  return {
    ...publicValue,
    avatarSeed: authorId,
    device: browserFamily || osFamily ? { browserFamily, osFamily } : null,
    ipLocation: ipCountryCode
      ? { countryCode: ipCountryCode, regionCode: ipRegionCode, regionName: ipRegionName }
      : null,
  };
};

const serializeComment = (comment: CommentRow, userId: string | null) => {
  const canEdit = Boolean(userId && comment.authorId === userId);
  const { viewerLiked, ...content } = comment;
  return {
    ...publicAuthoredContent(content),
    viewer: {
      liked: viewerLiked === 1,
      canDelete: canEdit,
      canEdit,
    },
  };
};

const logModerationSchedulingError = (request: Request, entityKind: "comment" | "post", errorValue: unknown): void => {
  console.error(
    JSON.stringify({
      event: "community.moderation.schedule_failed",
      entityKind,
      error: errorValue instanceof Error ? { message: errorValue.message, name: errorValue.name } : String(errorValue),
      requestId: request.headers.get("X-Request-Id") || null,
    }),
  );
};

const payloadError = (request: Request, kind: PayloadErrorKind): Response =>
  kind === "too_large"
    ? error(request, 413, "request_too_large", "The JSON request body is too large")
    : error(request, 400, `invalid_${kind}`, "A valid JSON body is required");

const isSameOrigin = (request: Request): boolean => {
  const origin = request.headers.get("Origin");
  if (!origin) return request.headers.get("Sec-Fetch-Site") !== "cross-site";
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
};

const readJSON = async (request: Request): Promise<ReadJsonResult> => {
  if (!request.headers.get("Content-Type")?.toLowerCase().startsWith("application/json")) {
    return { error: "content_type" };
  }
  const declared = Number(request.headers.get("Content-Length") || 0);
  if (declared > MAX_JSON_BYTES) {
    await request.body?.cancel();
    return { error: "too_large" };
  }
  if (!request.body) return { error: "invalid" };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_JSON_BYTES) {
      await reader.cancel();
      return { error: "too_large" };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
    const value: unknown = JSON.parse(text);
    return isJsonValue(value) && isJsonObject(value) ? { value } : { error: "invalid" };
  } catch {
    return { error: "invalid" };
  }
};

const cleanText = (value: JsonValue | undefined, max: number): string | null => {
  if (typeof value !== "string") return null;
  const result = value.trim();
  return result && [...result].length <= max ? result : null;
};

const stripCommunityBbcodeTags = (value: string): string =>
  value
    .replace(/\[\/?(?:quote|code|list|spoiler)(?:=[^\]\r\n]{0,512})?\]|\[\*\]/giu, " ")
    .replace(/\[\/?(?:b|strong|i|em|u|s|strike|url)(?:=[^\]\r\n]{0,512})?\]/giu, "");

const plainTextFromCommunityBbcode = (value: string): string =>
  stripCommunityBbcodeTags(value).replace(/\s+/gu, " ").trim();

const deriveTitle = (body: string): string => {
  const plainLine = body.split(/\r?\n/u).map(plainTextFromCommunityBbcode).find(Boolean);
  const collapsed = plainLine || plainTextFromCommunityBbcode(body) || body.trim().replace(/\s+/gu, " ");
  return [...collapsed].slice(0, POST_TITLE_MAX).join("");
};

const deriveExcerpt = (body: string): string =>
  [...plainTextFromCommunityBbcode(body)].slice(0, POST_EXCERPT_MAX).join("");

const normalizeTag = (value: string): string | null => {
  const normalized = value.normalize("NFKC").replace(/^#/u, "").toLocaleLowerCase("und").trim();
  return [...normalized].length <= TAG_MAX && TAG_VALUE_PATTERN.test(normalized) ? normalized : null;
};

const extractTags = (body: string): string[] => {
  const withoutCode = body.replace(/\[code(?:=[^\]\r\n]{0,512})?\][\s\S]*?\[\/code\]/giu, " ");
  const normalizedBody = stripCommunityBbcodeTags(withoutCode).normalize("NFKC");
  const pattern = /(?:^|[^\p{L}\p{N}_])#([\p{L}\p{N}][\p{L}\p{N}_-]{0,31})(?![\p{L}\p{N}_-])/gu;
  const tags = new Set<string>();
  for (const match of normalizedBody.matchAll(pattern)) {
    const value = match[1] ? normalizeTag(match[1]) : null;
    if (value) tags.add(value);
    if (tags.size === TAG_LIMIT) break;
  }
  return [...tags];
};

const parsePostTags = (value: JsonValue | undefined, body: string): string[] | null => {
  const tags = new Set(extractTags(body));
  if (value === undefined) return [...tags];
  if (!Array.isArray(value) || value.length > TAG_LIMIT) return null;
  for (const item of value) {
    if (typeof item !== "string") return null;
    const tag = normalizeTag(item);
    if (!tag) return null;
    tags.add(tag);
    if (tags.size > TAG_LIMIT) return null;
  }
  return [...tags];
};

const preparePostTagWrites = (
  env: Env,
  tagRecords: readonly { id: string; name: string }[],
  context: PostTagWriteContext,
) => {
  if (!tagRecords.length) return null;
  const valueRows = tagRecords.map(() => "(?, ?)").join(", ");
  const catalogBindings = tagRecords.flatMap((tag) => [tag.id, tag.name]);
  const positionedBindings = tagRecords.flatMap((tag, position) => [tag.name, position]);
  const currentPostGuard = `EXISTS (
    SELECT 1 FROM community_post
    WHERE id = ? AND author_id = ? AND version = ? AND moderation_revision = ?
  )`;
  const currentPostBindings = [context.postId, context.userId, context.version, context.revisionNumber];

  return {
    catalog: env.DB.prepare(
      `WITH input(id, name) AS (VALUES ${valueRows})
       INSERT OR IGNORE INTO community_tag
         (id, normalized_name, display_name, description, status, canonical_tag_id,
          created_by_user_id, created_at, updated_at)
       SELECT input.id, input.name, input.name, NULL, 'active', NULL, ?, ?, ?
       FROM input
       WHERE ${currentPostGuard}`,
    ).bind(...catalogBindings, context.userId, context.now, context.now, ...currentPostBindings),
    current: env.DB.prepare(
      `WITH input(name, position) AS (VALUES ${valueRows})
       INSERT INTO community_post_tag (post_id, tag_id, added_by_user_id, position, created_at)
       SELECT ?, tag.id, ?, input.position, ?
       FROM input
       JOIN community_tag AS tag ON tag.normalized_name = input.name
       WHERE ${currentPostGuard}`,
    ).bind(...positionedBindings, context.postId, context.userId, context.now, ...currentPostBindings),
    revision: env.DB.prepare(
      `WITH input(name, position) AS (VALUES ${valueRows})
       INSERT INTO community_post_revision_tag
         (post_id, revision_number, tag_id, normalized_name, display_name, position)
       SELECT ?, ?, tag.id, tag.normalized_name, tag.display_name, input.position
       FROM input
       JOIN community_tag AS tag ON tag.normalized_name = input.name
       WHERE EXISTS (
         SELECT 1 FROM community_post_revision WHERE post_id = ? AND revision_number = ?
       )`,
    ).bind(...positionedBindings, context.postId, context.revisionNumber, context.postId, context.revisionNumber),
  };
};

const preparePostAttachmentWrites = (
  env: Env,
  attachmentIds: readonly string[],
  context: { now: number; postId: string; revisionNumber: number },
) => {
  if (!attachmentIds.length) return null;
  const valueRows = attachmentIds.map(() => "(?, ?)").join(", ");
  const bindings = attachmentIds.flatMap((attachmentId, position) => [attachmentId, position]);
  return {
    current: env.DB.prepare(
      `WITH input(attachment_id, position) AS (VALUES ${valueRows})
       INSERT INTO community_post_attachment (post_id, attachment_id, position, created_at)
       SELECT ?, input.attachment_id, input.position, ?
       FROM input
       WHERE EXISTS (SELECT 1 FROM community_post WHERE id = ?)`,
    ).bind(...bindings, context.postId, context.now, context.postId),
    revision: env.DB.prepare(
      `WITH input(attachment_id, position) AS (VALUES ${valueRows})
       INSERT INTO community_post_revision_attachment (post_id, revision_number, attachment_id, position)
       SELECT ?, ?, input.attachment_id, input.position
       FROM input
       WHERE EXISTS (
         SELECT 1 FROM community_post_revision WHERE post_id = ? AND revision_number = ?
       )`,
    ).bind(...bindings, context.postId, context.revisionNumber, context.postId, context.revisionNumber),
  };
};

const parseEditReason = (value: JsonValue | undefined): string | null | undefined => {
  if (value === undefined) return null;
  if (typeof value !== "string") return undefined;
  const reason = value.normalize("NFKC").trim();
  return !reason || [...reason].length > 500 ? undefined : reason;
};

const parseVisibility = (value: JsonValue | undefined): PostVisibility | null =>
  value === "public" || value === "protected" || value === "private" ? value : null;

const parseAttachmentIds = (value: JsonValue | undefined): string[] | null => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > POST_ATTACHMENT_LIMIT) return null;
  const ids = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string" || !UUID_PATTERN.test(item) || ids.has(item)) return null;
    ids.add(item);
  }
  return [...ids];
};

const encodeCursor = (row: Cursor): string =>
  btoa(
    JSON.stringify({
      c: row.createdAt,
      i: row.id,
      ...(row.pinnedAt === undefined ? {} : { p: row.pinnedAt }),
      ...(row.rankAsOf === undefined ? {} : { a: row.rankAsOf }),
      ...(row.rankScore === undefined ? {} : { r: row.rankScore }),
      ...(row.recommendationSeed === undefined ? {} : { s: row.recommendationSeed }),
    }),
  )
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");

const decodeCursor = (value: string | null): Cursor | null => {
  if (!value || value.length > 256) return null;
  try {
    const decoded = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
    if (decoded.startsWith("{")) {
      const parsed: unknown = JSON.parse(decoded);
      if (!parsed || typeof parsed !== "object") return null;
      const createdAt = Reflect.get(parsed, "c");
      const id = Reflect.get(parsed, "i");
      const pinnedAt = Reflect.get(parsed, "p");
      const rankAsOf = Reflect.get(parsed, "a");
      const rankScore = Reflect.get(parsed, "r");
      const recommendationSeed = Reflect.get(parsed, "s");
      if (
        typeof createdAt !== "number" ||
        !Number.isSafeInteger(createdAt) ||
        createdAt < 0 ||
        typeof id !== "string" ||
        !UUID_PATTERN.test(id) ||
        (pinnedAt !== undefined &&
          pinnedAt !== null &&
          (typeof pinnedAt !== "number" || !Number.isSafeInteger(pinnedAt) || pinnedAt < 0)) ||
        (rankAsOf !== undefined && (typeof rankAsOf !== "number" || !Number.isSafeInteger(rankAsOf) || rankAsOf < 0)) ||
        (rankScore !== undefined && (typeof rankScore !== "number" || !Number.isSafeInteger(rankScore))) ||
        (recommendationSeed !== undefined &&
          (typeof recommendationSeed !== "number" ||
            !Number.isSafeInteger(recommendationSeed) ||
            recommendationSeed < 0 ||
            recommendationSeed > 2_147_483_647))
      ) {
        return null;
      }
      return {
        createdAt,
        id,
        ...(pinnedAt === undefined ? {} : { pinnedAt }),
        ...(rankAsOf === undefined ? {} : { rankAsOf }),
        ...(rankScore === undefined ? {} : { rankScore }),
        ...(recommendationSeed === undefined ? {} : { recommendationSeed }),
      };
    }
    const separator = decoded.indexOf(":");
    const createdAt = Number(decoded.slice(0, separator));
    const id = decoded.slice(separator + 1);
    return separator > 0 && Number.isSafeInteger(createdAt) && createdAt >= 0 && UUID_PATTERN.test(id)
      ? { createdAt, id }
      : null;
  } catch {
    return null;
  }
};

const singleSearchParameter = (url: URL, name: string): string | null | undefined => {
  const values = url.searchParams.getAll(name);
  if (values.length > 1) return undefined;
  return values[0] ?? null;
};

const parseLimit = (raw: string | null, fallback: number, maximum: number): number | null => {
  if (raw === null) return fallback;
  if (!/^\d{1,2}$/u.test(raw)) return null;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 1 && value <= maximum ? value : null;
};

const parseListOptions = (request: Request, url: URL): ParseResult<ListOptions> => {
  const names = ["limit", "cursor", "q", "tag", "scope", "state", "seed", "refresh"] as const;
  const values = new Map<string, string | null>();
  for (const name of names) {
    const value = singleSearchParameter(url, name);
    if (value === undefined) {
      return { ok: false, response: error(request, 400, "duplicate_query_parameter", `${name} may only be sent once`) };
    }
    values.set(name, value);
  }

  const limit = parseLimit(values.get("limit") ?? null, 20, 50);
  if (limit === null) return { ok: false, response: error(request, 400, "invalid_limit", "limit must be 1-50") };

  const cursorValue = values.get("cursor") ?? null;
  const cursor = decodeCursor(cursorValue);
  if (cursorValue && !cursor)
    return { ok: false, response: error(request, 400, "invalid_cursor", "The cursor is invalid") };

  const qValue = values.get("q") ?? null;
  const q = qValue?.normalize("NFKC").trim() || null;
  if (qValue !== null && (!q || [...q].length > SEARCH_QUERY_MAX)) {
    return {
      ok: false,
      response: error(request, 400, "invalid_query", `q must be 1-${SEARCH_QUERY_MAX} characters`),
    };
  }

  const tagValue = values.get("tag") ?? null;
  const tag = tagValue === null ? null : normalizeTag(tagValue);
  if (tagValue !== null && !tag) {
    return { ok: false, response: error(request, 400, "invalid_tag", `tag must be 1-${TAG_MAX} characters`) };
  }

  const scopeValue = values.get("scope") ?? "all";
  if (
    scopeValue !== "all" &&
    scopeValue !== "latest" &&
    scopeValue !== "recommended" &&
    scopeValue !== "following" &&
    scopeValue !== "mine" &&
    scopeValue !== "bookmarked"
  ) {
    return {
      ok: false,
      response: error(
        request,
        400,
        "invalid_scope",
        "scope must be all, latest, recommended, following, mine, or bookmarked",
      ),
    };
  }
  const stateValue = values.get("state") ?? "active";
  if (stateValue !== "active" && stateValue !== "archived" && stateValue !== "all") {
    return { ok: false, response: error(request, 400, "invalid_state", "state must be active, archived, or all") };
  }
  const seedValue = values.get("seed") ?? null;
  if (seedValue !== null && !/^[0-9]{1,10}$/u.test(seedValue)) {
    return { ok: false, response: error(request, 400, "invalid_seed", "seed must be an integer from 0 to 2147483647") };
  }
  const seed = seedValue === null ? null : Number(seedValue);
  if (seed !== null && (!Number.isSafeInteger(seed) || seed < 0 || seed > 2_147_483_647)) {
    return { ok: false, response: error(request, 400, "invalid_seed", "seed must be an integer from 0 to 2147483647") };
  }
  const refreshValue = values.get("refresh") ?? null;
  if (refreshValue !== null && refreshValue !== "1") {
    return { ok: false, response: error(request, 400, "invalid_refresh", "refresh must be 1 when supplied") };
  }
  if (refreshValue === "1" && cursor) {
    return {
      ok: false,
      response: error(request, 400, "invalid_refresh_cursor", "refresh and cursor cannot be combined"),
    };
  }
  return {
    ok: true,
    value: { cursor, limit, q, refresh: refreshValue === "1", scope: scopeValue, seed, state: stateValue, tag },
  };
};

const escapeLike = (value: string): string => value.replace(/[\\%_]/gu, "\\$&");

const visibleLikeCountSelect = `(
  SELECT COUNT(*)
  FROM community_reaction AS visible_reaction
  JOIN community_profile AS visible_reaction_author
    ON visible_reaction_author.user_id = visible_reaction.user_id
   AND visible_reaction_author.status <> 'deleted'
   AND visible_reaction_author.display_name IS NOT NULL
  WHERE visible_reaction.post_id = post.id
    AND visible_reaction.kind = 'like'
)`;

const visibleParentIdSelect = `CASE
  WHEN comment.parent_id IS NULL THEN NULL
  WHEN EXISTS (
    SELECT 1
    FROM community_comment AS visible_parent
    JOIN community_profile AS visible_parent_author
      ON visible_parent_author.user_id = visible_parent.author_id
     AND visible_parent_author.status <> 'deleted'
     AND visible_parent_author.display_name IS NOT NULL
    WHERE visible_parent.id = comment.parent_id
      AND visible_parent.deleted_at IS NULL
      AND visible_parent.hidden_at IS NULL
      AND visible_parent.moderation_status = 'allow'
  ) THEN comment.parent_id
  ELSE NULL
END`;

const postSelect = `
  SELECT
    post.id,
    post.title,
    post.body,
    post.visibility,
    post.moderation_status AS moderationStatus,
    post.pinned_at AS pinnedAt,
    post.archived_at AS archivedAt,
    post.comments_locked_at AS commentsLockedAt,
    post.version,
    post.created_at AS createdAt,
    post.updated_at AS updatedAt,
    post.ip_country_code AS ipCountryCode,
    post.ip_region_code AS ipRegionCode,
    post.ip_region_name AS ipRegionName,
    post.browser_family AS browserFamily,
    post.os_family AS osFamily,
    COALESCE((
      SELECT current_revision.created_at
      FROM community_post_revision AS current_revision
      WHERE current_revision.post_id = post.id
        AND current_revision.revision_number = post.moderation_revision
    ), post.updated_at) AS lastEditedAt,
    (
      SELECT COUNT(*)
      FROM community_comment AS visible_comment
      JOIN community_profile AS visible_comment_author
        ON visible_comment_author.user_id = visible_comment.author_id
       AND visible_comment_author.status <> 'deleted'
       AND visible_comment_author.display_name IS NOT NULL
      WHERE visible_comment.post_id = post.id
        AND visible_comment.deleted_at IS NULL
        AND visible_comment.hidden_at IS NULL
        AND visible_comment.moderation_status = 'allow'
    ) AS commentCount,
    ${visibleLikeCountSelect} AS likeCount,
    author.id AS authorId,
    author_identity.uid AS authorUid,
    author_profile.display_name AS authorName,
    author.image AS authorImage
  FROM community_post AS post
  JOIN "user" AS author ON author.id = post.author_id
  JOIN community_identity AS author_identity ON author_identity.user_id = post.author_id
  JOIN community_profile AS author_profile
    ON author_profile.user_id = post.author_id
   AND author_profile.status <> 'deleted'
   AND author_profile.display_name IS NOT NULL
`;

const postListSelect = `
  SELECT
    post.id,
    post.title,
    post.body,
    post.visibility,
    post.moderation_status AS moderationStatus,
    post.pinned_at AS pinnedAt,
    post.archived_at AS archivedAt,
    post.comments_locked_at AS commentsLockedAt,
    post.version,
    post.created_at AS createdAt,
    post.updated_at AS updatedAt,
    post.ip_country_code AS ipCountryCode,
    post.ip_region_code AS ipRegionCode,
    post.ip_region_name AS ipRegionName,
    post.browser_family AS browserFamily,
    post.os_family AS osFamily,
    COALESCE((
      SELECT current_revision.created_at
      FROM community_post_revision AS current_revision
      WHERE current_revision.post_id = post.id
        AND current_revision.revision_number = post.moderation_revision
    ), post.updated_at) AS lastEditedAt,
    (
      SELECT COUNT(*)
      FROM community_comment AS visible_comment
      JOIN community_profile AS visible_comment_author
        ON visible_comment_author.user_id = visible_comment.author_id
       AND visible_comment_author.status <> 'deleted'
       AND visible_comment_author.display_name IS NOT NULL
      WHERE visible_comment.post_id = post.id
        AND visible_comment.deleted_at IS NULL
        AND visible_comment.hidden_at IS NULL
        AND visible_comment.moderation_status = 'allow'
    ) AS commentCount,
    ${visibleLikeCountSelect} AS likeCount,
    author.id AS authorId,
    author_identity.uid AS authorUid,
    author_profile.display_name AS authorName,
    author.image AS authorImage
  FROM community_post AS post
  JOIN "user" AS author ON author.id = post.author_id
  JOIN community_identity AS author_identity ON author_identity.user_id = post.author_id
  JOIN community_profile AS author_profile
    ON author_profile.user_id = post.author_id
   AND author_profile.status <> 'deleted'
   AND author_profile.display_name IS NOT NULL
`;

const activePostWhere = `post.status = 'published' AND post.deleted_at IS NULL
  AND EXISTS (
    SELECT 1 FROM community_profile AS post_author_profile
    WHERE post_author_profile.user_id = post.author_id
      AND post_author_profile.status <> 'deleted'
      AND post_author_profile.display_name IS NOT NULL
  )`;
const visibleNotificationWhere = `(
  notification.kind IN ('follow', 'moderation')
  OR EXISTS (
    SELECT 1 FROM community_post AS notification_post
    WHERE notification_post.id = notification.post_id
      AND notification_post.status = 'published'
      AND notification_post.deleted_at IS NULL
      AND notification_post.moderation_status = 'allow'
      AND (
        notification_post.visibility IN ('public', 'protected')
        OR notification_post.author_id = notification.recipient_user_id
      )
      AND (
        notification_post.archived_at IS NULL
        OR notification_post.author_id = notification.recipient_user_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM community_user_block AS notification_post_block
        WHERE (notification_post_block.blocker_user_id = notification.recipient_user_id
               AND notification_post_block.blocked_user_id = notification_post.author_id)
           OR (notification_post_block.blocker_user_id = notification_post.author_id
               AND notification_post_block.blocked_user_id = notification.recipient_user_id)
      )
      AND EXISTS (
        SELECT 1 FROM community_profile AS notification_post_author
        WHERE notification_post_author.user_id = notification_post.author_id
          AND notification_post_author.status <> 'deleted'
          AND notification_post_author.display_name IS NOT NULL
      )
      AND (
        notification.comment_id IS NULL OR EXISTS (
          SELECT 1 FROM community_comment AS notification_comment
          WHERE notification_comment.id = notification.comment_id
            AND notification_comment.deleted_at IS NULL
            AND notification_comment.hidden_at IS NULL
            AND notification_comment.moderation_status = 'allow'
            AND EXISTS (
              SELECT 1 FROM community_profile AS notification_comment_author
              WHERE notification_comment_author.user_id = notification_comment.author_id
                AND notification_comment_author.status <> 'deleted'
                AND notification_comment_author.display_name IS NOT NULL
            )
        )
      )
  )
)`;
const visibleNotificationActorWhere = `(notification.actor_user_id IS NULL OR EXISTS (
  SELECT 1 FROM community_profile AS notification_actor_profile
  WHERE notification_actor_profile.user_id = notification.actor_user_id
    AND notification_actor_profile.status <> 'deleted'
    AND notification_actor_profile.display_name IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM community_user_block AS notification_actor_block
      WHERE (notification_actor_block.blocker_user_id = notification.recipient_user_id
             AND notification_actor_block.blocked_user_id = notification.actor_user_id)
         OR (notification_actor_block.blocker_user_id = notification.actor_user_id
             AND notification_actor_block.blocked_user_id = notification.recipient_user_id)
    )
    AND NOT EXISTS (
      SELECT 1 FROM community_user_mute AS notification_actor_mute
      WHERE notification_actor_mute.muter_user_id = notification.recipient_user_id
        AND notification_actor_mute.muted_user_id = notification.actor_user_id
    )
))`;

const moderationReadableCondition = (userId: string | null): SqlCondition =>
  userId
    ? { sql: "(post.moderation_status = 'allow' OR post.author_id = ?)", values: [userId] }
    : { sql: "post.moderation_status = 'allow'", values: [] };

const readablePostCondition = (userId: string | null): SqlCondition =>
  userId
    ? {
        sql: `(post.visibility IN ('public', 'protected') OR post.author_id = ?)
          AND NOT EXISTS (
            SELECT 1 FROM community_user_block AS viewer_block
            WHERE (viewer_block.blocker_user_id = ? AND viewer_block.blocked_user_id = post.author_id)
               OR (viewer_block.blocker_user_id = post.author_id AND viewer_block.blocked_user_id = ?)
          )`,
        values: [userId, userId, userId],
      }
    : { sql: "post.visibility = 'public'", values: [] };

const directlyReadableStateCondition = (userId: string | null): SqlCondition =>
  userId
    ? { sql: "(post.archived_at IS NULL OR post.author_id = ?)", values: [userId] }
    : { sql: "post.archived_at IS NULL", values: [] };

const writablePostStateCondition: SqlCondition = {
  sql: "post.archived_at IS NULL AND post.moderation_status = 'allow'",
  values: [],
};

const commentablePostStateCondition: SqlCondition = {
  sql: "post.archived_at IS NULL AND post.comments_locked_at IS NULL AND post.moderation_status = 'allow'",
  values: [],
};

const activeSessionProfileWhere = `EXISTS (
  SELECT 1 FROM community_profile AS active_writer
  WHERE active_writer.user_id = ?
    AND active_writer.status = 'active'
    AND active_writer.deleted_at IS NULL
)`;

const activePostAuthorProfileWhere = `EXISTS (
  SELECT 1 FROM community_profile AS active_writer
  WHERE active_writer.user_id = community_post.author_id
    AND active_writer.status = 'active'
    AND active_writer.deleted_at IS NULL
)`;

const requireSession = async (request: Request, env: Env): Promise<Session | null> => {
  const session = await getAuthSession(request, env);
  return session?.user?.id ? session : null;
};

const requireWritableSession = async (
  request: Request,
  env: Env,
  message: string,
  restrictionKinds: readonly ("sign_in" | "write")[] = ["sign_in", "write"],
): Promise<WritableAccess> => {
  const session = await requireSession(request, env);
  if (!session) return { ok: false, response: error(request, 401, "authentication_required", message) };
  if (!session.user.emailVerified) {
    return {
      ok: false,
      response: error(request, 403, "email_verification_required", "Verify the account email before posting"),
    };
  }
  const profile = await communityAccessState(env, session.user.id, restrictionKinds);
  if (!profile) {
    return { ok: false, response: error(request, 503, "profile_unavailable", "The community profile is not ready") };
  }
  if (profile.status !== "active") {
    return {
      ok: false,
      response: error(
        request,
        403,
        profile.status === "suspended" ? "account_suspended" : "account_deleted",
        "This account cannot write to the community",
      ),
    };
  }
  if (profile.restriction) {
    return {
      ok: false,
      response: error(request, 403, "community_write_restricted", "This account cannot write to the community"),
    };
  }
  if (env.COMMUNITY_RATE_LIMITER) {
    const { success } = await env.COMMUNITY_RATE_LIMITER.limit({ key: session.user.id });
    if (!success) {
      return {
        ok: false,
        response: error(request, 429, "rate_limit_exceeded", "Too many community writes", { "Retry-After": "60" }),
      };
    }
  }
  return { ok: true, session, profile };
};

const attachPostMetadata = async <T extends PostDatabaseFields>(
  env: Env,
  rows: T[],
): Promise<Array<T & { attachments: PostAttachment[]; state: PostState; tags: string[] }>> => {
  if (!rows.length) return [];
  const placeholders = rows.map(() => "?").join(", ");
  const postIds = rows.map((row) => row.id);
  const [tagResult, attachmentResult] = await Promise.all([
    env.DB.prepare(
      `SELECT link.post_id AS postId, tag.normalized_name AS tag
       FROM community_post_tag AS link
       JOIN community_tag AS tag ON tag.id = link.tag_id
       WHERE link.post_id IN (${placeholders}) AND tag.status = 'active'
       ORDER BY link.post_id, link.position, tag.normalized_name`,
    )
      .bind(...postIds)
      .all<PostTagRow>(),
    env.DB.prepare(
      `SELECT link.post_id AS postId, attachment.id, attachment.original_name AS fileName,
              attachment.media_type AS mediaType, attachment.byte_size AS size, link.position
       FROM community_post_attachment AS link
       JOIN community_attachment AS attachment ON attachment.id = link.attachment_id
       JOIN community_profile AS attachment_owner_profile
         ON attachment_owner_profile.user_id = attachment.owner_user_id
        AND attachment_owner_profile.status <> 'deleted'
       WHERE link.post_id IN (${placeholders})
         AND attachment.status = 'ready' AND attachment.moderation_status = 'allow'
         AND attachment.deleted_at IS NULL AND attachment.byte_size IS NOT NULL
       ORDER BY link.post_id, link.position`,
    )
      .bind(...postIds)
      .all<PostAttachmentRow>(),
  ]);
  const tagsByPost = new Map<string, string[]>();
  for (const row of tagResult.results) {
    const tags = tagsByPost.get(row.postId);
    if (tags) tags.push(row.tag);
    else tagsByPost.set(row.postId, [row.tag]);
  }
  const attachmentsByPost = new Map<string, PostAttachment[]>();
  for (const row of attachmentResult.results) {
    const attachment: PostAttachment = {
      contentUrl: `${COMMUNITY_PREFIX}/attachments/${row.id}/content`,
      fileName: row.fileName,
      id: row.id,
      mediaType: row.mediaType,
      position: row.position,
      size: row.size,
    };
    const attachments = attachmentsByPost.get(row.postId);
    if (attachments) attachments.push(attachment);
    else attachmentsByPost.set(row.postId, [attachment]);
  }
  return rows.map((row) => ({
    ...row,
    attachments: attachmentsByPost.get(row.id) ?? [],
    state: row.archivedAt === null ? "active" : "archived",
    tags: tagsByPost.get(row.id) ?? [],
  }));
};

const findAccessiblePostRow = async (env: Env, id: string, userId: string | null): Promise<PostRow | null> => {
  const access = readablePostCondition(userId);
  const moderation = moderationReadableCondition(userId);
  const state = directlyReadableStateCondition(userId);
  return env.DB.prepare(
    `${postSelect} WHERE post.id = ? AND ${activePostWhere} AND ${access.sql} AND ${moderation.sql} AND ${state.sql} LIMIT 1`,
  )
    .bind(id, ...access.values, ...moderation.values, ...state.values)
    .first<PostRow>();
};

const findAccessiblePost = async (env: Env, id: string, userId: string | null): Promise<PostWithTags | null> => {
  const row = await findAccessiblePostRow(env, id, userId);
  if (!row) return null;
  return (await attachPostMetadata(env, [row]))[0] ?? null;
};

const publicAccessiblePost = async (env: Env, id: string, userId: string): Promise<PublicPost> => {
  const post = await findAccessiblePost(env, id, userId);
  if (!post) throw new Error("The written post could not be read");
  return publicAuthoredContent(post);
};

const readPostOwnership = (env: Env, id: string): Promise<PostOwnershipRow | null> =>
  env.DB.prepare(
    `SELECT author_id AS authorId, version, deleted_at AS deletedAt,
            archived_at AS archivedAt, pinned_at AS pinnedAt,
            moderation_revision AS moderationRevision
     FROM community_post WHERE id = ? LIMIT 1`,
  )
    .bind(id)
    .first<PostOwnershipRow>();

const ownershipError = async (request: Request, env: Env, id: string, userId: string): Promise<Response | null> => {
  const existing = await readPostOwnership(env, id);
  if (!existing || existing.deletedAt !== null) return error(request, 404, "post_not_found", "Post not found");
  if (existing.authorId !== userId) return error(request, 403, "forbidden", "Only the author can modify this post");
  return null;
};

const listPosts = async (request: Request, env: Env, url: URL): Promise<Response> => {
  const parsed = parseListOptions(request, url);
  if (!parsed.ok) return parsed.response;
  const options = parsed.value;
  const session = await requireSession(request, env);
  const userId = session?.user.id ?? null;
  const requestTime = Date.now();
  if ((options.scope === "mine" || options.scope === "bookmarked" || options.scope === "following") && !userId) {
    return error(request, 401, "authentication_required", `Sign in to use scope=${options.scope}`);
  }
  if (options.state !== "active" && options.scope !== "mine") {
    return error(request, 400, "invalid_state_scope", "Archived posts are only available with scope=mine");
  }
  let recommendationRankAsOf: number | null = null;
  let recommendationSeed: number | null = null;
  if (options.scope === "recommended") {
    if (
      options.cursor &&
      (options.cursor.rankScore === undefined ||
        options.cursor.rankAsOf === undefined ||
        options.cursor.recommendationSeed === undefined)
    ) {
      return error(request, 400, "invalid_cursor", "The recommendation cursor is invalid");
    }
    if (options.cursor && options.seed === null) {
      return error(request, 400, "recommendation_seed_required", "seed is required when continuing recommendations");
    }
    if (options.cursor && options.seed !== options.cursor.recommendationSeed) {
      return error(
        request,
        400,
        "recommendation_seed_mismatch",
        "seed must match the recommendation cursor when continuing recommendations",
      );
    }
    if (options.cursor) {
      recommendationSeed = options.cursor.recommendationSeed ?? null;
    } else if (options.seed === null) {
      const random = new Uint32Array(1);
      crypto.getRandomValues(random);
      recommendationSeed = (random[0] ?? 0) & 0x7fffffff;
    } else {
      recommendationSeed = options.seed;
    }
    recommendationRankAsOf = options.cursor?.rankAsOf ?? requestTime;
  }
  const pinFirst = options.scope === "all" || options.scope === "latest" || options.scope === "following";
  if (pinFirst && options.cursor && options.cursor.pinnedAt === undefined) {
    return error(request, 400, "invalid_cursor", "The feed cursor is invalid");
  }

  const where = [activePostWhere];
  const bindings: BindValue[] = [];
  const access = readablePostCondition(userId);
  where.push(access.sql);
  bindings.push(...access.values);
  const moderation = moderationReadableCondition(userId);
  where.push(moderation.sql);
  bindings.push(...moderation.values);

  if (options.state === "active") where.push("post.archived_at IS NULL");
  else if (options.state === "archived") where.push("post.archived_at IS NOT NULL");

  if (options.scope === "mine" && userId) {
    where.push("post.author_id = ?");
    bindings.push(userId);
  } else if (options.scope === "bookmarked" && userId) {
    where.push(
      "EXISTS (SELECT 1 FROM community_bookmark AS bookmark WHERE bookmark.post_id = post.id AND bookmark.user_id = ?)",
    );
    bindings.push(userId);
  } else if (options.scope === "following" && userId) {
    where.push(`(
      EXISTS (
        SELECT 1 FROM community_user_follow AS followed_author
        WHERE followed_author.follower_user_id = ? AND followed_author.followed_user_id = post.author_id
      )
      OR EXISTS (
        SELECT 1
        FROM community_post_tag AS followed_post_tag
        JOIN community_tag_preference AS followed_tag
          ON followed_tag.tag_id = followed_post_tag.tag_id
         AND followed_tag.user_id = ?
         AND followed_tag.kind = 'follow'
        WHERE followed_post_tag.post_id = post.id
      )
    )`);
    bindings.push(userId, userId);
  }

  const discoveryScope =
    options.scope === "all" ||
    options.scope === "latest" ||
    options.scope === "recommended" ||
    options.scope === "following";
  if (discoveryScope && userId && !options.q && !options.tag) {
    where.push(`NOT EXISTS (
      SELECT 1 FROM community_user_mute AS muted_author
      WHERE muted_author.muter_user_id = ? AND muted_author.muted_user_id = post.author_id
    )`);
    where.push(`NOT EXISTS (
      SELECT 1
      FROM community_post_tag AS muted_post_tag
      JOIN community_tag_preference AS muted_tag
        ON muted_tag.tag_id = muted_post_tag.tag_id
       AND muted_tag.user_id = ?
       AND muted_tag.kind = 'mute'
      WHERE muted_post_tag.post_id = post.id
    )`);
    where.push(`NOT EXISTS (
      SELECT 1 FROM community_post_feedback AS feedback
      WHERE feedback.user_id = ? AND feedback.post_id = post.id
    )`);
    bindings.push(userId, userId, userId);
  }

  if (options.q) {
    const pattern = `%${escapeLike(options.q)}%`;
    where.push("(post.title LIKE ? ESCAPE '\\' OR post.body LIKE ? ESCAPE '\\')");
    bindings.push(pattern, pattern);
  }
  if (options.tag) {
    where.push(
      `EXISTS (
        SELECT 1 FROM community_post_tag AS post_tag
        JOIN community_tag AS tag ON tag.id = post_tag.tag_id
        WHERE post_tag.post_id = post.id AND tag.normalized_name = ? AND tag.status = 'active'
      )`,
    );
    bindings.push(options.tag);
  }
  const rowLimit = options.limit + 1;
  let result: D1Result<PostListRow>;
  if (options.scope === "recommended") {
    if (recommendationSeed === null || recommendationRankAsOf === null) {
      throw new Error("A recommendation request has no stable ranking context");
    }
    const scoreBindings: BindValue[] = [
      recommendationRankAsOf - HOUR_MS,
      recommendationRankAsOf - DAY_MS,
      recommendationRankAsOf - 7 * DAY_MS,
      recommendationSeed,
    ];
    let impressionScore = "";
    let personalizedScore = "";
    let reasonExpression = `CASE
      WHEN candidate.likeCount + candidate.commentCount >= 5 THEN 'popular'
      ELSE 'recent'
    END`;
    if (userId) {
      personalizedScore = `
        + CASE WHEN EXISTS (
            SELECT 1 FROM community_user_follow AS score_follow
            WHERE score_follow.follower_user_id = ? AND score_follow.followed_user_id = candidate.authorId
          ) THEN 120 ELSE 0 END
        + CASE WHEN EXISTS (
            SELECT 1
            FROM community_post_tag AS score_post_tag
            JOIN community_tag_preference AS score_tag_preference
              ON score_tag_preference.tag_id = score_post_tag.tag_id
             AND score_tag_preference.user_id = ?
             AND score_tag_preference.kind = 'follow'
            WHERE score_post_tag.post_id = candidate.id
          ) THEN 70 ELSE 0 END`;
      scoreBindings.push(userId, userId);
      impressionScore = `
        - CASE WHEN EXISTS (
            SELECT 1 FROM community_feed_impression AS score_impression
            WHERE score_impression.user_id = ?
              AND score_impression.post_id = candidate.id
              AND score_impression.first_seen_at < ?
          ) THEN 90 ELSE 0 END`;
      scoreBindings.push(userId, recommendationRankAsOf);
      reasonExpression = `CASE
        WHEN EXISTS (
          SELECT 1 FROM community_user_follow AS reason_follow
          WHERE reason_follow.follower_user_id = ? AND reason_follow.followed_user_id = candidate.authorId
        ) THEN 'followed_author'
        WHEN EXISTS (
          SELECT 1
          FROM community_post_tag AS reason_post_tag
          JOIN community_tag_preference AS reason_tag_preference
            ON reason_tag_preference.tag_id = reason_post_tag.tag_id
           AND reason_tag_preference.user_id = ?
           AND reason_tag_preference.kind = 'follow'
          WHERE reason_post_tag.post_id = candidate.id
        ) THEN 'followed_tag'
        WHEN candidate.likeCount + candidate.commentCount >= 5 THEN 'popular'
        ELSE 'recent'
      END`;
      scoreBindings.push(userId, userId);
    }
    const rankCursorSql = options.cursor
      ? `WHERE rankScore < ?
          OR (rankScore = ? AND (createdAt < ? OR (createdAt = ? AND id < ?)))`
      : "";
    const rankCursorBindings: BindValue[] = options.cursor
      ? [
          options.cursor.rankScore ?? 0,
          options.cursor.rankScore ?? 0,
          options.cursor.createdAt,
          options.cursor.createdAt,
          options.cursor.id,
        ]
      : [];
    result = await env.DB.prepare(
      `WITH candidate AS (
         ${postListSelect} WHERE ${where.join(" AND ")}
       ), ranked AS (
         SELECT candidate.*,
           (
             candidate.likeCount * 5
             + candidate.commentCount * 8
             + (SELECT COUNT(*)
                FROM community_bookmark AS rank_bookmark
                JOIN community_profile AS rank_bookmark_owner
                  ON rank_bookmark_owner.user_id = rank_bookmark.user_id
                 AND rank_bookmark_owner.status <> 'deleted'
                 AND rank_bookmark_owner.display_name IS NOT NULL
                WHERE rank_bookmark.post_id = candidate.id) * 3
             + CASE
                 WHEN candidate.createdAt >= ? THEN 80
                 WHEN candidate.createdAt >= ? THEN 50
                 WHEN candidate.createdAt >= ? THEN 20
                 ELSE 0
               END
             + (((? * 1103515245
                 + unicode(substr(candidate.id, 1, 1)) * 104729
                 + unicode(substr(candidate.id, 2, 1)) * 13007
                 + unicode(substr(candidate.id, 3, 1)) * 1543
                 + unicode(substr(candidate.id, 4, 1)) * 193) & 2147483647) % 13)
             ${personalizedScore}
             ${impressionScore}
           ) AS rankScore,
           ${reasonExpression} AS recommendationReason
         FROM candidate
       )
       SELECT * FROM ranked
       ${rankCursorSql}
       ORDER BY rankScore DESC, createdAt DESC, id DESC
       LIMIT ?`,
    )
      .bind(...bindings, ...scoreBindings, ...rankCursorBindings, rowLimit)
      .all<PostListRow>();
  } else {
    if (options.cursor && pinFirst && typeof options.cursor.pinnedAt === "number") {
      where.push(`(
        (post.pinned_at IS NOT NULL AND (
          post.pinned_at < ?
          OR (post.pinned_at = ? AND (
            post.created_at < ? OR (post.created_at = ? AND post.id < ?)
          ))
        ))
        OR post.pinned_at IS NULL
      )`);
      bindings.push(
        options.cursor.pinnedAt,
        options.cursor.pinnedAt,
        options.cursor.createdAt,
        options.cursor.createdAt,
        options.cursor.id,
      );
    } else if (options.cursor && pinFirst) {
      where.push("post.pinned_at IS NULL AND (post.created_at < ? OR (post.created_at = ? AND post.id < ?))");
      bindings.push(options.cursor.createdAt, options.cursor.createdAt, options.cursor.id);
    } else if (options.cursor) {
      where.push("(post.created_at < ? OR (post.created_at = ? AND post.id < ?))");
      bindings.push(options.cursor.createdAt, options.cursor.createdAt, options.cursor.id);
    }
    const order = pinFirst
      ? `CASE WHEN post.pinned_at IS NULL THEN 0 ELSE 1 END DESC,
         post.pinned_at DESC, post.created_at DESC, post.id DESC`
      : "post.created_at DESC, post.id DESC";
    result = await env.DB.prepare(
      `${postListSelect} WHERE ${where.join(" AND ")}
       ORDER BY ${order} LIMIT ?`,
    )
      .bind(...bindings, rowLimit)
      .all<PostListRow>();
  }
  const hasMore = result.results.length > options.limit;
  const rows = hasMore ? result.results.slice(0, options.limit) : result.results;
  const taggedRows = await attachPostMetadata(env, rows);
  const posts = taggedRows.map(({ body, rankScore, ...post }) => {
    void rankScore;
    const value = publicAuthoredContent<PostListWithTags>({
      ...post,
      excerpt: deriveExcerpt(body),
    });
    return {
      ...value,
      viewer: { canGiveFeedback: Boolean(userId) },
    };
  });
  if (userId && options.scope === "recommended" && taggedRows.length) {
    const seenAt = Date.now();
    const impressionRows = taggedRows.map(() => "(?)").join(", ");
    try {
      await env.DB.prepare(
        `WITH impressions(post_id) AS (VALUES ${impressionRows})
         INSERT INTO community_feed_impression
           (user_id, post_id, first_seen_at, last_seen_at, seen_count)
         SELECT ?, impressions.post_id, ?, ?, 1
         FROM impressions
         WHERE ${activeSessionProfileWhere}
         ON CONFLICT(user_id, post_id) DO UPDATE SET
           last_seen_at = excluded.last_seen_at,
           seen_count = community_feed_impression.seen_count + 1`,
      )
        .bind(...taggedRows.map((row) => row.id), userId, seenAt, seenAt, userId)
        .run();
    } catch (impressionError) {
      console.error(
        JSON.stringify({
          event: "community.recommendation.impression_write_failed",
          error:
            impressionError instanceof Error
              ? { name: impressionError.name, message: impressionError.message }
              : String(impressionError),
        }),
      );
    }
  }
  const lastRow = taggedRows.at(-1);
  return json(request, {
    posts,
    nextCursor:
      hasMore && lastRow
        ? encodeCursor({
            createdAt: lastRow.createdAt,
            id: lastRow.id,
            ...(pinFirst ? { pinnedAt: lastRow.pinnedAt } : {}),
            ...(options.scope === "recommended" && lastRow.rankScore !== undefined
              ? {
                  rankAsOf: recommendationRankAsOf ?? requestTime,
                  rankScore: lastRow.rankScore,
                  recommendationSeed: recommendationSeed ?? 0,
                }
              : {}),
          })
        : null,
    ...(recommendationSeed === null ? {} : { seed: recommendationSeed }),
  });
};

const getPost = async (request: Request, env: Env, id: string, url: URL): Promise<Response> => {
  const session = await requireSession(request, env);
  const userId = session?.user.id ?? null;
  const includeCommentsValue = singleSearchParameter(url, "includeComments");
  const commentsOnlyValue = singleSearchParameter(url, "commentsOnly");
  if (includeCommentsValue === undefined || commentsOnlyValue === undefined) {
    return error(request, 400, "duplicate_query_parameter", "Post query parameters may only be sent once");
  }
  if (includeCommentsValue !== null && includeCommentsValue !== "false") {
    return error(request, 400, "invalid_include_comments", "includeComments must be false when provided");
  }
  if (commentsOnlyValue !== null && commentsOnlyValue !== "true") {
    return error(request, 400, "invalid_comments_only", "commentsOnly must be true when provided");
  }
  if (includeCommentsValue === "false" && commentsOnlyValue === "true") {
    return error(request, 400, "conflicting_post_query", "Comments cannot be both excluded and requested alone");
  }
  const commentsOnly = commentsOnlyValue === "true";
  const postRow = await findAccessiblePostRow(env, id, userId);
  if (!postRow) return error(request, 404, "post_not_found", "Post not found");
  const postWithTags = commentsOnly ? null : ((await attachPostMetadata(env, [postRow]))[0] ?? null);
  const post = postWithTags ?? postRow;
  if (includeCommentsValue === "false") {
    if (!postWithTags) return error(request, 500, "post_metadata_unavailable", "Post metadata is unavailable");
    return json(request, {
      post: publicAuthoredContent(postWithTags),
      comments: [],
      commentsNextCursor: null,
      commentsSort: "hot",
      viewer: {
        liked: false,
        bookmarked: false,
        canEdit: Boolean(userId && userId === post.authorId),
        canDelete: Boolean(userId && userId === post.authorId),
        canComment: Boolean(
          userId && post.moderationStatus === "allow" && post.archivedAt === null && post.commentsLockedAt === null,
        ),
      },
    });
  }
  const cursorValue = singleSearchParameter(url, "commentsCursor");
  const sortValue = singleSearchParameter(url, "commentsSort");
  const focusedCommentValue = singleSearchParameter(url, "commentId");
  if (cursorValue === undefined || sortValue === undefined || focusedCommentValue === undefined) {
    return error(request, 400, "duplicate_query_parameter", "Comment query parameters may only be sent once");
  }
  const focusedCommentId =
    focusedCommentValue === null || UUID_PATTERN.test(focusedCommentValue) ? focusedCommentValue : undefined;
  if (focusedCommentId === undefined) {
    return error(request, 400, "invalid_comment_id", "commentId must be a valid comment identifier");
  }
  const cursor = decodeCursor(cursorValue);
  if (cursorValue && !cursor) return error(request, 400, "invalid_cursor", "The comments cursor is invalid");
  const commentsSort: CommentSort = sortValue === null || sortValue === "hot" ? "hot" : "latest";
  if (sortValue !== null && sortValue !== "hot" && sortValue !== "latest") {
    return error(request, 400, "invalid_comment_sort", "commentsSort must be hot or latest");
  }
  if (commentsSort === "hot" && cursor && cursor.rankScore === undefined) {
    return error(request, 400, "invalid_cursor", "The hot-comment cursor is invalid");
  }
  const commentModerationSql = userId
    ? "(comment.moderation_status = 'allow' OR comment.author_id = ?)"
    : "comment.moderation_status = 'allow'";
  const commentModerationValues: BindValue[] = userId ? [userId] : [];

  let liked = false;
  let bookmarked = false;
  if (userId && !commentsOnly) {
    const flags = await env.DB.batch<ViewerFlagRow>([
      env.DB.prepare(
        "SELECT 1 AS active FROM community_reaction WHERE post_id = ? AND user_id = ? AND kind = 'like' LIMIT 1",
      ).bind(id, userId),
      env.DB.prepare("SELECT 1 AS active FROM community_bookmark WHERE post_id = ? AND user_id = ? LIMIT 1").bind(
        id,
        userId,
      ),
    ]);
    liked = Boolean(flags[0]?.results[0]);
    bookmarked = Boolean(flags[1]?.results[0]);
  }

  const viewerLikedSql = userId
    ? `CASE WHEN EXISTS (
        SELECT 1 FROM community_comment_reaction AS viewer_reaction
        WHERE viewer_reaction.comment_id = comment.id
          AND viewer_reaction.user_id = ?
          AND viewer_reaction.kind = 'like'
      ) THEN 1 ELSE 0 END`
    : "0";
  const commentWhere = [
    "comment.post_id = ?",
    "comment.deleted_at IS NULL",
    "comment.hidden_at IS NULL",
    commentModerationSql,
  ];
  const commentBindings: BindValue[] = [...(userId ? [userId] : []), id, ...commentModerationValues];
  if (userId) {
    commentWhere.push(`NOT EXISTS (
      SELECT 1 FROM community_user_block AS comment_block
      WHERE (comment_block.blocker_user_id = ? AND comment_block.blocked_user_id = comment.author_id)
         OR (comment_block.blocker_user_id = comment.author_id AND comment_block.blocked_user_id = ?)
    )`);
    commentWhere.push(`NOT EXISTS (
      SELECT 1 FROM community_user_mute AS comment_mute
      WHERE comment_mute.muter_user_id = ? AND comment_mute.muted_user_id = comment.author_id
    )`);
    commentBindings.push(userId, userId, userId);
  }
  const focusedCommentWhere = [...commentWhere];
  const focusedCommentBindings = [...commentBindings];
  if (cursor) {
    if (commentsSort === "hot") {
      commentWhere.push(`(
        comment.like_count < ?
        OR (comment.like_count = ? AND (
          comment.created_at < ? OR (comment.created_at = ? AND comment.id < ?)
        ))
      )`);
      commentBindings.push(cursor.rankScore ?? 0, cursor.rankScore ?? 0, cursor.createdAt, cursor.createdAt, cursor.id);
    } else {
      commentWhere.push("(comment.created_at < ? OR (comment.created_at = ? AND comment.id < ?))");
      commentBindings.push(cursor.createdAt, cursor.createdAt, cursor.id);
    }
  }
  const commentOrder =
    commentsSort === "hot"
      ? "comment.like_count DESC, comment.created_at DESC, comment.id DESC"
      : "comment.created_at DESC, comment.id DESC";
  const commentSelect = `SELECT
       comment.id,
       comment.body,
       comment.version,
       comment.like_count AS likeCount,
       comment.ip_country_code AS ipCountryCode,
       comment.ip_region_code AS ipRegionCode,
       comment.ip_region_name AS ipRegionName,
       comment.browser_family AS browserFamily,
       comment.os_family AS osFamily,
       comment.moderation_status AS moderationStatus,
       ${visibleParentIdSelect} AS parentId,
       comment.created_at AS createdAt,
       comment.updated_at AS updatedAt,
       ${COMMENT_LAST_EDITED_AT_SELECT} AS lastEditedAt,
       ${viewerLikedSql} AS viewerLiked,
       author.id AS authorId,
       author_identity.uid AS authorUid,
       author_profile.display_name AS authorName,
       author.image AS authorImage
     FROM community_comment AS comment
     JOIN "user" AS author ON author.id = comment.author_id
     JOIN community_identity AS author_identity ON author_identity.user_id = comment.author_id
     JOIN community_profile AS author_profile
       ON author_profile.user_id = comment.author_id
      AND author_profile.status <> 'deleted'
      AND author_profile.display_name IS NOT NULL`;
  const commentsStatement = env.DB.prepare(
    `${commentSelect}
     WHERE ${commentWhere.join(" AND ")}
     ORDER BY ${commentOrder}
     LIMIT ?`,
  ).bind(...commentBindings, COMMENT_PAGE_SIZE + 1);
  const commentsResult = await commentsStatement.all<CommentRow>();
  const hasMoreComments = commentsResult.results.length > COMMENT_PAGE_SIZE;
  const pageComments = hasMoreComments ? commentsResult.results.slice(0, COMMENT_PAGE_SIZE) : commentsResult.results;
  const lastComment = pageComments.at(-1);
  const comments = [...pageComments];
  if (focusedCommentId && !comments.some((comment) => comment.id === focusedCommentId)) {
    const focusedComment = await env.DB.prepare(
      `${commentSelect}
       WHERE ${focusedCommentWhere.join(" AND ")} AND comment.id = ?
       LIMIT 1`,
    )
      .bind(...focusedCommentBindings, focusedCommentId)
      .first<CommentRow>();
    if (focusedComment) comments.push(focusedComment);
  }
  const publicComments = comments.map((comment) => serializeComment(comment, userId));
  const commentResponse = {
    comments: publicComments,
    commentsNextCursor:
      hasMoreComments && lastComment
        ? encodeCursor({
            createdAt: lastComment.createdAt,
            id: lastComment.id,
            ...(commentsSort === "hot" ? { rankScore: lastComment.likeCount } : {}),
          })
        : null,
    commentsSort,
  };
  if (commentsOnly) return json(request, commentResponse);
  if (!postWithTags) return error(request, 500, "post_metadata_unavailable", "Post metadata is unavailable");
  return json(request, {
    post: publicAuthoredContent(postWithTags),
    ...commentResponse,
    viewer: {
      liked,
      bookmarked,
      canEdit: Boolean(userId && userId === post.authorId),
      canDelete: Boolean(userId && userId === post.authorId),
      canComment: Boolean(
        userId && post.moderationStatus === "allow" && post.archivedAt === null && post.commentsLockedAt === null,
      ),
    },
  });
};

const createPost = async (request: Request, env: Env): Promise<Response> => {
  const access = await requireWritableSession(request, env, "Sign in to create a post");
  if (!access.ok) return access.response;
  const { session } = access;
  const payload = await readJSON(request);
  if ("error" in payload) return payloadError(request, payload.error);
  const body = cleanText(payload.value.body, POST_BODY_MAX);
  if (!body) return error(request, 422, "invalid_post", `Body must be 1-${POST_BODY_MAX} characters`);

  const titleValue = payload.value.title;
  const title = titleValue === undefined ? deriveTitle(body) : cleanText(titleValue, POST_TITLE_MAX);
  if (!title) return error(request, 422, "invalid_post", `Title must be 1-${POST_TITLE_MAX} characters`);

  const visibilityValue = payload.value.visibility;
  const visibility = visibilityValue === undefined ? "public" : parseVisibility(visibilityValue);
  if (!visibility) {
    return error(request, 422, "invalid_visibility", "visibility must be public, protected, or private");
  }
  const attachmentIds = parseAttachmentIds(payload.value.attachmentIds);
  if (!attachmentIds) {
    return error(request, 422, "invalid_attachment_ids", "attachmentIds must contain at most 10 unique IDs");
  }
  if (attachmentIds.length) {
    const placeholders = attachmentIds.map(() => "?").join(", ");
    const candidates = await env.DB.prepare(
      `SELECT id FROM community_attachment
       WHERE id IN (${placeholders}) AND owner_user_id = ?
         AND purpose = 'post' AND status = 'ready' AND moderation_status = 'allow' AND deleted_at IS NULL`,
    )
      .bind(...attachmentIds, session.user.id)
      .all<AttachmentCandidateRow>();
    if (candidates.results.length !== attachmentIds.length) {
      return error(request, 409, "attachment_not_ready", "Every attachment must be owned by you, ready, and allowed");
    }
  }

  const id = crypto.randomUUID();
  const now = Date.now();
  const tags = parsePostTags(payload.value.tags, body);
  if (!tags) return error(request, 422, "invalid_tags", `A post may contain at most ${TAG_LIMIT} valid tags`);
  const tagRecords = tags.map((tag) => ({ id: crypto.randomUUID(), name: tag }));
  const ip = requestIpMetadata(request);
  const client = requestClientMetadata(request);
  const inspection = inspectCommunityText(communityPostModerationText(title, body, tags));
  const initialModeration = inspection.verdict === "allow" ? "pending" : inspection.verdict;
  const insert = env.DB.prepare(
    `INSERT INTO community_post
       (id, author_id, title, body, status, visibility, moderation_status,
        created_at, updated_at, published_at, ip_country_code, ip_region_code, ip_region_name, ip_address,
        user_agent, browser_family, os_family)
     SELECT ?, ?, ?, ?, 'published', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
     WHERE ${activeSessionProfileWhere}
       AND (
       SELECT COUNT(*) FROM community_post WHERE author_id = ? AND created_at >= ?
     ) < ?
       AND (
         SELECT COUNT(*) FROM community_post WHERE author_id = ? AND created_at >= ?
       ) < ?`,
  ).bind(
    id,
    session.user.id,
    title,
    body,
    visibility,
    initialModeration,
    now,
    now,
    now,
    ip.countryCode,
    ip.regionCode,
    ip.regionName,
    ip.ipAddress,
    client.userAgent,
    client.browserFamily,
    client.osFamily,
    session.user.id,
    session.user.id,
    now - HOUR_MS,
    POST_HOURLY_LIMIT,
    session.user.id,
    now - DAY_MS,
    POST_DAILY_LIMIT,
  );
  const revision = env.DB.prepare(
    `INSERT INTO community_post_revision
       (post_id, revision_number, editor_user_id, title, body, visibility, edit_reason, source_kind,
        ip_country_code, ip_region_code, ip_region_name, ip_address,
        user_agent, browser_family, os_family, created_at)
     SELECT id, 1, author_id, title, body, visibility, NULL, 'create',
            ip_country_code, ip_region_code, ip_region_name, ip_address,
            user_agent, browser_family, os_family, ?
     FROM community_post WHERE id = ? AND author_id = ?`,
  ).bind(now, id, session.user.id);
  const tagWrites = preparePostTagWrites(env, tagRecords, {
    now,
    postId: id,
    revisionNumber: 1,
    userId: session.user.id,
    version: 1,
  });
  const attachmentWrites = preparePostAttachmentWrites(env, attachmentIds, {
    now,
    postId: id,
    revisionNumber: 1,
  });
  const revisionSeal = env.DB.prepare(
    `INSERT INTO community_post_revision_seal (post_id, revision_number, sealed_at)
     SELECT post_id, revision_number, ?
     FROM community_post_revision
     WHERE post_id = ? AND revision_number = 1`,
  ).bind(now, id);
  let results: D1Result[];
  try {
    results = await env.DB.batch([
      insert,
      revision,
      ...(tagWrites ? [tagWrites.catalog, tagWrites.current, tagWrites.revision] : []),
      ...(attachmentWrites ? [attachmentWrites.current, attachmentWrites.revision] : []),
      revisionSeal,
    ]);
  } catch (batchError) {
    if (attachmentIds.length) {
      return error(request, 409, "attachment_state_changed", "An attachment changed while the post was being created");
    }
    throw batchError;
  }
  if (!results[0]?.meta.changes) {
    return error(request, 429, "post_quota_exceeded", "The account post quota has been reached", {
      "Retry-After": "3600",
    });
  }
  if (!results.at(-1)?.meta.changes) throw new Error("The initial post revision snapshot was not sealed");
  try {
    await scheduleEntityModeration(env, "post", id, inspection, 1);
  } catch (moderationError) {
    logModerationSchedulingError(request, "post", moderationError);
    return json(request, { moderationQueued: false, post: await publicAccessiblePost(env, id, session.user.id) }, 202);
  }
  const post = await publicAccessiblePost(env, id, session.user.id);
  return json(request, { post }, 201);
};

const updatePost = async (request: Request, env: Env, id: string): Promise<Response> => {
  const access = await requireWritableSession(request, env, "Sign in to edit a post");
  if (!access.ok) return access.response;
  const { session } = access;
  const payload = await readJSON(request);
  if ("error" in payload) return payloadError(request, payload.error);

  const body = cleanText(payload.value.body, POST_BODY_MAX);
  const version = typeof payload.value.version === "number" ? payload.value.version : Number.NaN;
  if (!body || !Number.isSafeInteger(version) || version < 1) {
    return error(request, 422, "invalid_post", "Body and the current version are required");
  }
  const titleValue = payload.value.title;
  const title = titleValue === undefined ? deriveTitle(body) : cleanText(titleValue, POST_TITLE_MAX);
  if (!title) return error(request, 422, "invalid_post", `Title must be 1-${POST_TITLE_MAX} characters`);

  const visibilityValue = payload.value.visibility;
  const visibility = visibilityValue === undefined ? null : parseVisibility(visibilityValue);
  if (visibilityValue !== undefined && !visibility) {
    return error(request, 422, "invalid_visibility", "visibility must be public, protected, or private");
  }
  const tags = parsePostTags(payload.value.tags, body);
  if (!tags) return error(request, 422, "invalid_tags", `A post may contain at most ${TAG_LIMIT} valid tags`);
  const editReason = parseEditReason(payload.value.editReason);
  if (editReason === undefined)
    return error(request, 422, "invalid_edit_reason", "editReason must be 1-500 characters");
  const ownership = await readPostOwnership(env, id);
  if (!ownership || ownership.deletedAt !== null) return error(request, 404, "post_not_found", "Post not found");
  if (ownership.authorId !== session.user.id) {
    return error(request, 403, "forbidden", "Only the author can modify this post");
  }
  if (ownership.version !== version) {
    return error(request, 409, "version_conflict", "The post was changed in another session");
  }
  const inspection = inspectCommunityText(communityPostModerationText(title, body, tags));
  const initialModeration = inspection.verdict === "allow" ? "pending" : inspection.verdict;
  const nextVersion = version + 1;
  const nextRevision = ownership.moderationRevision + 1;
  const now = Date.now();
  const ip = requestIpMetadata(request);
  const client = requestClientMetadata(request);
  const tagRecords = tags.map((tag) => ({ id: crypto.randomUUID(), name: tag }));
  const revision = env.DB.prepare(
    `INSERT INTO community_post_revision
       (post_id, revision_number, editor_user_id, title, body, visibility, edit_reason, source_kind,
        ip_country_code, ip_region_code, ip_region_name, ip_address,
        user_agent, browser_family, os_family, created_at)
     SELECT id, ?, author_id, ?, ?, COALESCE(?, visibility), ?, 'edit', ?, ?, ?, ?, ?, ?, ?, ?
     FROM community_post
     WHERE id = ? AND author_id = ? AND version = ? AND deleted_at IS NULL
       AND ${activePostAuthorProfileWhere}`,
  ).bind(
    nextRevision,
    title,
    body,
    visibility,
    editReason,
    ip.countryCode,
    ip.regionCode,
    ip.regionName,
    ip.ipAddress,
    client.userAgent,
    client.browserFamily,
    client.osFamily,
    now,
    id,
    session.user.id,
    version,
  );
  const update = env.DB.prepare(
    `UPDATE community_post
     SET title = ?, body = ?, visibility = COALESCE(?, visibility), moderation_status = ?,
         moderation_revision = ?, version = version + 1, updated_at = ?,
         ip_country_code = ?, ip_region_code = ?, ip_region_name = ?, ip_address = ?,
         user_agent = ?, browser_family = ?, os_family = ?
     WHERE id = ? AND author_id = ? AND version = ? AND deleted_at IS NULL
       AND ${activePostAuthorProfileWhere}
       AND EXISTS (
         SELECT 1 FROM community_post_revision
         WHERE post_id = community_post.id AND revision_number = ?
       )`,
  ).bind(
    title,
    body,
    visibility,
    initialModeration,
    nextRevision,
    now,
    ip.countryCode,
    ip.regionCode,
    ip.regionName,
    ip.ipAddress,
    client.userAgent,
    client.browserFamily,
    client.osFamily,
    id,
    session.user.id,
    version,
    nextRevision,
  );
  const tagGuard = `post_id = ? AND EXISTS (
    SELECT 1 FROM community_post
    WHERE id = ? AND author_id = ? AND version = ? AND moderation_revision = ?
  )`;
  const deleteTags = env.DB.prepare(`DELETE FROM community_post_tag WHERE ${tagGuard}`).bind(
    id,
    id,
    session.user.id,
    nextVersion,
    nextRevision,
  );
  const tagWrites = preparePostTagWrites(env, tagRecords, {
    now,
    postId: id,
    revisionNumber: nextRevision,
    userId: session.user.id,
    version: nextVersion,
  });
  const revisionAttachments = env.DB.prepare(
    `INSERT INTO community_post_revision_attachment (post_id, revision_number, attachment_id, position)
     SELECT link.post_id, ?, link.attachment_id, link.position
     FROM community_post_attachment AS link
     WHERE link.post_id = ?
       AND EXISTS (
         SELECT 1 FROM community_post_revision WHERE post_id = ? AND revision_number = ?
     )`,
  ).bind(nextRevision, id, id, nextRevision);
  const revisionSeal = env.DB.prepare(
    `INSERT INTO community_post_revision_seal (post_id, revision_number, sealed_at)
     SELECT post_id, revision_number, ?
     FROM community_post_revision
     WHERE post_id = ? AND revision_number = ?`,
  ).bind(now, id, nextRevision);
  const supersedeAppeals = env.DB.prepare(
    `UPDATE community_appeal
     SET status = 'superseded', reviewer_user_id = NULL,
         resolution_reason_code = 'system.entity_revision_superseded',
         resolution_id = id, version = version + 1, updated_at = ?, resolved_at = ?
     WHERE status = 'pending' AND case_id IN (
       SELECT moderation_case.id
       FROM community_moderation_case AS moderation_case
       WHERE moderation_case.entity_kind = 'post' AND moderation_case.entity_id = ?
         AND moderation_case.entity_revision < ?
     )
       AND EXISTS (
         SELECT 1 FROM community_post
         WHERE id = ? AND author_id = ? AND version = ? AND moderation_revision = ?
       )`,
  ).bind(now, now, id, nextRevision, id, session.user.id, nextVersion, nextRevision);
  const results = await env.DB.batch([
    revision,
    update,
    ...(tagWrites ? [tagWrites.catalog] : []),
    deleteTags,
    ...(tagWrites ? [tagWrites.current, tagWrites.revision] : []),
    revisionAttachments,
    revisionSeal,
    supersedeAppeals,
  ]);
  if (!results[0]?.meta.changes || !results[1]?.meta.changes) {
    const denied = await ownershipError(request, env, id, session.user.id);
    if (denied) return denied;
    return error(request, 409, "version_conflict", "The post was changed in another session");
  }
  if (!results.at(-2)?.meta.changes) throw new Error("The updated post revision snapshot was not sealed");
  const updated = await readPostOwnership(env, id);
  if (!updated) throw new Error("The updated post could not be read");
  let moderationQueued: boolean;
  try {
    moderationQueued =
      (await scheduleEntityModeration(env, "post", id, inspection, updated.moderationRevision)) === "pending";
  } catch (moderationError) {
    logModerationSchedulingError(request, "post", moderationError);
    return json(request, { moderationQueued: false, post: await publicAccessiblePost(env, id, session.user.id) }, 202);
  }
  return json(request, { moderationQueued, post: await publicAccessiblePost(env, id, session.user.id) });
};

const deletePost = async (request: Request, env: Env, id: string): Promise<Response> => {
  const access = await requireWritableSession(request, env, "Sign in to delete a post", ["sign_in"]);
  if (!access.ok) return access.response;
  const payload = await readJSON(request);
  if ("error" in payload) return payloadError(request, payload.error);
  const version = typeof payload.value.version === "number" ? payload.value.version : Number.NaN;
  if (!Number.isSafeInteger(version) || version < 1) {
    return error(request, 422, "invalid_post_delete", "The current post version is required");
  }
  const { session } = access;
  const now = Date.now();
  const ip = requestIpMetadata(request);
  const eventId = crypto.randomUUID();
  const results = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO community_post_state_event
         (id, post_id, actor_user_id, event_kind, revision_number, reason_code,
          ip_country_code, ip_region_code, ip_region_name, ip_address, created_at)
       SELECT ?, id, ?, 'deleted', moderation_revision, 'user.self_delete', ?, ?, ?, ?, ?
       FROM community_post
       WHERE id = ? AND author_id = ? AND version = ? AND deleted_at IS NULL
         AND ${activePostAuthorProfileWhere}`,
    ).bind(
      eventId,
      session.user.id,
      ip.countryCode,
      ip.regionCode,
      ip.regionName,
      ip.ipAddress,
      now,
      id,
      session.user.id,
      version,
    ),
    env.DB.prepare(
      `UPDATE community_post
       SET deleted_at = ?, deleted_by_user_id = ?, delete_reason_code = 'user.self_delete',
           pinned_at = NULL, version = version + 1, updated_at = ?
       WHERE id = ? AND author_id = ? AND version = ? AND deleted_at IS NULL
         AND ${activePostAuthorProfileWhere}
         AND EXISTS (
           SELECT 1 FROM community_post_state_event
           WHERE id = ? AND post_id = community_post.id AND event_kind = 'deleted'
         )`,
    ).bind(now, session.user.id, now, id, session.user.id, version, eventId),
  ]);
  if (!results[0]?.meta.changes || !results[1]?.meta.changes) {
    const denied = await ownershipError(request, env, id, session.user.id);
    return denied ?? error(request, 409, "version_conflict", "The post changed; refresh and try again");
  }
  return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
};

const setPinned = async (request: Request, env: Env, id: string): Promise<Response> => {
  const access = await requireWritableSession(request, env, "Sign in to pin a post");
  if (!access.ok) return access.response;
  const payload = await readJSON(request);
  if ("error" in payload) return payloadError(request, payload.error);
  const version = typeof payload.value.version === "number" ? payload.value.version : Number.NaN;
  if (typeof payload.value.active !== "boolean" || !Number.isSafeInteger(version) || version < 1) {
    return error(request, 422, "invalid_pin", "The active boolean and current post version are required");
  }
  const { session } = access;
  const active = payload.value.active;
  const now = Date.now();
  const ip = requestIpMetadata(request);
  const eventId = crypto.randomUUID();
  const results = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO community_post_state_event
         (id, post_id, actor_user_id, event_kind, revision_number, reason_code,
          ip_country_code, ip_region_code, ip_region_name, ip_address, created_at)
       SELECT ?, id, ?, ?, moderation_revision, ?, ?, ?, ?, ?, ?
       FROM community_post
       WHERE id = ? AND author_id = ? AND version = ? AND deleted_at IS NULL AND archived_at IS NULL
         AND ${activePostAuthorProfileWhere}
         AND ((? = 1 AND pinned_at IS NULL) OR (? = 0 AND pinned_at IS NOT NULL))`,
    ).bind(
      eventId,
      session.user.id,
      active ? "pinned" : "unpinned",
      active ? "user.post_pin" : "user.post_unpin",
      ip.countryCode,
      ip.regionCode,
      ip.regionName,
      ip.ipAddress,
      now,
      id,
      session.user.id,
      version,
      active ? 1 : 0,
      active ? 1 : 0,
    ),
    env.DB.prepare(
      `UPDATE community_post
       SET pinned_at = ?, version = version + 1, updated_at = ?
       WHERE id = ? AND author_id = ? AND version = ? AND deleted_at IS NULL AND archived_at IS NULL
         AND ${activePostAuthorProfileWhere}
         AND EXISTS (
           SELECT 1 FROM community_post_state_event
           WHERE id = ? AND post_id = community_post.id AND event_kind = ?
         )`,
    ).bind(active ? now : null, now, id, session.user.id, version, eventId, active ? "pinned" : "unpinned"),
  ]);
  if (!results[0]?.meta.changes || !results[1]?.meta.changes) {
    const denied = await ownershipError(request, env, id, session.user.id);
    if (denied) return denied;
    const existing = await readPostOwnership(env, id);
    if (active && existing?.archivedAt !== null) {
      return error(request, 409, "post_archived", "Restore the post before pinning it");
    }
    return error(request, 409, "version_conflict", "The post changed; refresh and try again");
  }
  return json(request, { post: await publicAccessiblePost(env, id, session.user.id) });
};

const setArchived = async (request: Request, env: Env, id: string, archived: boolean): Promise<Response> => {
  const access = await requireWritableSession(
    request,
    env,
    archived ? "Sign in to archive a post" : "Sign in to restore a post",
  );
  if (!access.ok) return access.response;
  const payload = await readJSON(request);
  if ("error" in payload) return payloadError(request, payload.error);
  const version = typeof payload.value.version === "number" ? payload.value.version : Number.NaN;
  if (!Number.isSafeInteger(version) || version < 1) {
    return error(request, 422, "invalid_archive", "The current post version is required");
  }
  const { session } = access;
  const now = Date.now();
  const ip = requestIpMetadata(request);
  const eventId = crypto.randomUUID();
  const results = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO community_post_state_event
         (id, post_id, actor_user_id, event_kind, revision_number, reason_code,
          ip_country_code, ip_region_code, ip_region_name, ip_address, created_at)
       SELECT ?, id, ?, ?, moderation_revision, ?, ?, ?, ?, ?, ?
       FROM community_post
       WHERE id = ? AND author_id = ? AND version = ? AND deleted_at IS NULL
         AND ${activePostAuthorProfileWhere}
         AND ((? = 1 AND archived_at IS NULL) OR (? = 0 AND archived_at IS NOT NULL))`,
    ).bind(
      eventId,
      session.user.id,
      archived ? "archived" : "unarchived",
      archived ? "user.post_archive" : "user.post_unarchive",
      ip.countryCode,
      ip.regionCode,
      ip.regionName,
      ip.ipAddress,
      now,
      id,
      session.user.id,
      version,
      archived ? 1 : 0,
      archived ? 1 : 0,
    ),
    env.DB.prepare(
      `UPDATE community_post
       SET archived_at = ?, pinned_at = CASE WHEN ? = 1 THEN NULL ELSE pinned_at END,
           version = version + 1, updated_at = ?
       WHERE id = ? AND author_id = ? AND version = ? AND deleted_at IS NULL
         AND ${activePostAuthorProfileWhere}
         AND EXISTS (
           SELECT 1 FROM community_post_state_event
           WHERE id = ? AND post_id = community_post.id AND event_kind = ?
         )`,
    ).bind(
      archived ? now : null,
      archived ? 1 : 0,
      now,
      id,
      session.user.id,
      version,
      eventId,
      archived ? "archived" : "unarchived",
    ),
  ]);
  if (!results[0]?.meta.changes || !results[1]?.meta.changes) {
    const denied = await ownershipError(request, env, id, session.user.id);
    if (denied) return denied;
    return error(request, 409, "version_conflict", "The post changed; refresh and try again");
  }
  return json(request, { post: await publicAccessiblePost(env, id, session.user.id) });
};

const createComment = async (request: Request, env: Env, postId: string): Promise<Response> => {
  const writable = await requireWritableSession(request, env, "Sign in to comment");
  if (!writable.ok) return writable.response;
  const { session } = writable;
  const payload = await readJSON(request);
  if ("error" in payload) return payloadError(request, payload.error);
  const body = cleanText(payload.value.body, COMMENT_BODY_MAX);
  const parentId =
    typeof payload.value.parentId === "string" && UUID_PATTERN.test(payload.value.parentId)
      ? payload.value.parentId
      : null;
  if (!body) return error(request, 422, "invalid_comment", `Comment must be 1-${COMMENT_BODY_MAX} characters`);
  if (payload.value.parentId != null && !parentId) {
    return error(request, 422, "invalid_parent", "The parent comment identifier is invalid");
  }

  const id = crypto.randomUUID();
  const now = Date.now();
  const ip = requestIpMetadata(request);
  const client = requestClientMetadata(request);
  const inspection = inspectCommunityText(body);
  const initialModeration = inspection.verdict === "allow" ? "pending" : inspection.verdict;
  const access = readablePostCondition(session.user.id);
  const state = commentablePostStateCondition;
  const insert = env.DB.prepare(
    `INSERT INTO community_comment
       (id, post_id, author_id, parent_id, body, moderation_status,
        ip_country_code, ip_region_code, ip_region_name, ip_address,
        user_agent, browser_family, os_family, created_at, updated_at)
     SELECT ?, post.id, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
     FROM community_post AS post
     WHERE post.id = ? AND ${activePostWhere} AND post.moderation_status = 'allow'
       AND ${access.sql} AND ${state.sql}
       AND ${activeSessionProfileWhere}
       AND (
         ? IS NULL OR EXISTS (
           SELECT 1 FROM community_comment AS parent
           WHERE parent.id = ? AND parent.post_id = post.id AND parent.deleted_at IS NULL
             AND parent.hidden_at IS NULL
             AND parent.moderation_status = 'allow'
         )
       )
       AND (SELECT COUNT(*) FROM community_comment WHERE author_id = ? AND created_at >= ?) < ?
       AND (SELECT COUNT(*) FROM community_comment WHERE author_id = ? AND created_at >= ?) < ?`,
  ).bind(
    id,
    session.user.id,
    parentId,
    body,
    initialModeration,
    ip.countryCode,
    ip.regionCode,
    ip.regionName,
    ip.ipAddress,
    client.userAgent,
    client.browserFamily,
    client.osFamily,
    now,
    now,
    postId,
    ...access.values,
    ...state.values,
    session.user.id,
    parentId,
    parentId,
    session.user.id,
    now - HOUR_MS,
    COMMENT_HOURLY_LIMIT,
    session.user.id,
    now - DAY_MS,
    COMMENT_DAILY_LIMIT,
  );
  const revision = env.DB.prepare(
    `INSERT INTO community_comment_revision
       (comment_id, revision_number, editor_user_id, body, edit_reason, source_kind,
        ip_country_code, ip_region_code, ip_region_name, ip_address,
        user_agent, browser_family, os_family, created_at)
     SELECT id, 1, author_id, body, NULL, 'create',
            ip_country_code, ip_region_code, ip_region_name, ip_address,
            user_agent, browser_family, os_family, ?
     FROM community_comment WHERE id = ? AND author_id = ?`,
  ).bind(now, id, session.user.id);
  const select = env.DB.prepare(
    `SELECT
       comment.id,
       comment.body,
       comment.version,
       comment.like_count AS likeCount,
       comment.ip_country_code AS ipCountryCode,
       comment.ip_region_code AS ipRegionCode,
       comment.ip_region_name AS ipRegionName,
       comment.browser_family AS browserFamily,
       comment.os_family AS osFamily,
       comment.moderation_status AS moderationStatus,
       comment.parent_id AS parentId,
       comment.created_at AS createdAt,
       comment.updated_at AS updatedAt,
       ${COMMENT_LAST_EDITED_AT_SELECT} AS lastEditedAt,
       0 AS viewerLiked,
       author.id AS authorId,
       author_identity.uid AS authorUid,
       author_profile.display_name AS authorName,
       author.image AS authorImage
     FROM community_comment AS comment
     JOIN "user" AS author ON author.id = comment.author_id
     JOIN community_identity AS author_identity ON author_identity.user_id = comment.author_id
     JOIN community_profile AS author_profile
       ON author_profile.user_id = comment.author_id
      AND author_profile.status = 'active'
      AND author_profile.deleted_at IS NULL
      AND author_profile.display_name IS NOT NULL
     WHERE comment.id = ?`,
  ).bind(id);
  const results = await env.DB.batch<CommentRow>([insert, revision, select]);
  const insertResult = results[0];
  const comment = results[2]?.results[0] ?? null;
  if (!insertResult) throw new Error("D1 returned an incomplete comment batch result");
  if (!insertResult.meta.changes || !comment) {
    const accessiblePost = await findAccessiblePost(env, postId, session.user.id);
    if (!accessiblePost) {
      return error(request, 404, "post_not_found", "Post not found");
    }
    if (accessiblePost.moderationStatus !== "allow") {
      return error(request, 409, "post_not_ready", "The post is not open for comments");
    }
    const counts = await env.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM community_comment WHERE author_id = ? AND created_at >= ?) AS hourCount,
         (SELECT COUNT(*) FROM community_comment WHERE author_id = ? AND created_at >= ?) AS dayCount`,
    )
      .bind(session.user.id, now - HOUR_MS, session.user.id, now - DAY_MS)
      .first<CommentQuotaRow>();
    if (!counts) throw new Error("D1 did not return comment quota counts");
    if (counts.hourCount >= COMMENT_HOURLY_LIMIT || counts.dayCount >= COMMENT_DAILY_LIMIT) {
      return error(request, 429, "comment_quota_exceeded", "The account comment quota has been reached", {
        "Retry-After": "3600",
      });
    }
    return error(request, 422, "invalid_parent", "The parent comment does not exist on this post");
  }
  let moderationQueued = false;
  let responseStatus = 201;
  try {
    moderationQueued = (await scheduleEntityModeration(env, "comment", id, inspection, 1)) === "pending";
  } catch (moderationError) {
    logModerationSchedulingError(request, "comment", moderationError);
    responseStatus = 202;
  }
  const moderated = await env.DB.prepare(
    "SELECT moderation_status AS moderationStatus FROM community_comment WHERE id = ? LIMIT 1",
  )
    .bind(id)
    .first<CommentStatusRow>();
  return json(
    request,
    {
      comment: serializeComment(
        {
          ...comment,
          moderationStatus: moderated?.moderationStatus ?? comment.moderationStatus,
        },
        session.user.id,
      ),
      moderationQueued,
    },
    responseStatus,
  );
};

const setReaction = async (request: Request, env: Env, postId: string): Promise<Response> => {
  const writable = await requireWritableSession(request, env, "Sign in to react");
  if (!writable.ok) return writable.response;
  const { session } = writable;
  const payload = await readJSON(request);
  if ("error" in payload) return payloadError(request, payload.error);
  if (typeof payload.value.active !== "boolean") {
    return error(request, 422, "invalid_reaction", "The active boolean is required");
  }
  const active = payload.value.active;
  const now = Date.now();
  const activationId = crypto.randomUUID();
  const access = readablePostCondition(session.user.id);
  const state = writablePostStateCondition;
  const target = await env.DB.prepare(
    `SELECT 1 AS active
     FROM community_post AS post
     WHERE post.id = ? AND ${activePostWhere} AND ${access.sql} AND ${state.sql}
     LIMIT 1`,
  )
    .bind(postId, ...access.values, ...state.values)
    .first<ViewerFlagRow>();
  if (!target) return error(request, 404, "post_not_found", "Post not found");
  const write = active
    ? env.DB.prepare(
        `INSERT OR IGNORE INTO community_reaction (post_id, user_id, kind, created_at, activation_id)
         SELECT post.id, ?, 'like', ?, ? FROM community_post AS post
         WHERE post.id = ? AND ${activePostWhere} AND ${access.sql} AND ${state.sql}
           AND ${activeSessionProfileWhere}`,
      ).bind(session.user.id, now, activationId, postId, ...access.values, ...state.values, session.user.id)
    : env.DB.prepare(
        `DELETE FROM community_reaction
         WHERE post_id = ? AND user_id = ? AND kind = 'like'
           AND EXISTS (
             SELECT 1 FROM community_post AS post
             WHERE post.id = ? AND ${activePostWhere} AND ${access.sql} AND ${state.sql}
               AND ${activeSessionProfileWhere}
           )`,
      ).bind(postId, session.user.id, postId, ...access.values, ...state.values, session.user.id);
  const select = env.DB.prepare(
    `SELECT ${visibleLikeCountSelect} AS likeCount FROM community_post AS post
     WHERE post.id = ? AND ${activePostWhere} AND ${access.sql} AND ${state.sql}
       AND ${activeSessionProfileWhere}`,
  ).bind(postId, ...access.values, ...state.values, session.user.id);
  const notify = env.DB.prepare(
    `INSERT OR IGNORE INTO community_notification
       (id, recipient_user_id, actor_user_id, kind, post_id, comment_id, activation_id, created_at)
     SELECT ?, post.author_id, ?, 'post_reaction', post.id, NULL, reaction.activation_id, ?
     FROM community_post AS post
     JOIN community_reaction AS reaction
       ON reaction.post_id = post.id AND reaction.user_id = ? AND reaction.kind = 'like'
     WHERE post.id = ? AND post.author_id <> ? AND reaction.activation_id = ?
       AND ${activePostWhere} AND ${access.sql} AND ${state.sql}
       AND ${activeSessionProfileWhere}`,
  ).bind(
    crypto.randomUUID(),
    session.user.id,
    now,
    session.user.id,
    postId,
    session.user.id,
    activationId,
    ...access.values,
    ...state.values,
    session.user.id,
  );
  const statements = active ? [write, notify, select] : [write, select];
  const results = await env.DB.batch<ReactionCountRow>(statements);
  const writeResult = results[0];
  const post = results.at(-1)?.results[0] ?? null;
  if (!writeResult || !post) return error(request, 404, "post_not_found", "Post not found");
  return json(request, { active, likeCount: post.likeCount || 0 });
};

const setBookmark = async (request: Request, env: Env, postId: string): Promise<Response> => {
  const writable = await requireWritableSession(request, env, "Sign in to bookmark a post");
  if (!writable.ok) return writable.response;
  const { session } = writable;
  const payload = await readJSON(request);
  if ("error" in payload) return payloadError(request, payload.error);
  if (typeof payload.value.active !== "boolean") {
    return error(request, 422, "invalid_bookmark", "The active boolean is required");
  }
  const active = payload.value.active;
  const access = readablePostCondition(session.user.id);
  const state = writablePostStateCondition;
  const write = active
    ? env.DB.prepare(
        `INSERT OR IGNORE INTO community_bookmark (post_id, user_id, created_at)
         SELECT post.id, ?, ? FROM community_post AS post
         WHERE post.id = ? AND ${activePostWhere} AND ${access.sql} AND ${state.sql}
           AND ${activeSessionProfileWhere}`,
      ).bind(session.user.id, Date.now(), postId, ...access.values, ...state.values, session.user.id)
    : env.DB.prepare(
        `DELETE FROM community_bookmark
         WHERE post_id = ? AND user_id = ?
           AND EXISTS (
             SELECT 1 FROM community_post AS post
             WHERE post.id = ? AND ${activePostWhere} AND ${access.sql} AND ${state.sql}
               AND ${activeSessionProfileWhere}
           )`,
      ).bind(postId, session.user.id, postId, ...access.values, ...state.values, session.user.id);
  const select = env.DB.prepare(
    `SELECT 1 AS active FROM community_post AS post
     WHERE post.id = ? AND ${activePostWhere} AND ${access.sql} AND ${state.sql}
       AND ${activeSessionProfileWhere}
     LIMIT 1`,
  ).bind(postId, ...access.values, ...state.values, session.user.id);
  const results = await env.DB.batch<ViewerFlagRow>([write, select]);
  if (!results[1]?.results[0]) return error(request, 404, "post_not_found", "Post not found");
  return json(request, { active });
};

const listNotifications = async (request: Request, env: Env, url: URL): Promise<Response> => {
  const session = await requireSession(request, env);
  if (!session) return error(request, 401, "authentication_required", "Sign in to read notifications");
  const limitValue = singleSearchParameter(url, "limit");
  const cursorValue = singleSearchParameter(url, "cursor");
  const unreadValue = singleSearchParameter(url, "unread");
  const countOnlyValue = singleSearchParameter(url, "countOnly");
  if (
    limitValue === undefined ||
    cursorValue === undefined ||
    unreadValue === undefined ||
    countOnlyValue === undefined
  ) {
    return error(request, 400, "duplicate_query_parameter", "Notification query parameters may only be sent once");
  }
  if (countOnlyValue !== null && countOnlyValue !== "true") {
    return error(request, 400, "invalid_count_only", "countOnly must be true");
  }
  const limit = parseLimit(limitValue, 20, 50);
  if (limit === null) return error(request, 400, "invalid_limit", "limit must be 1-50");
  const cursor = decodeCursor(cursorValue);
  if (cursorValue && !cursor) return error(request, 400, "invalid_cursor", "The cursor is invalid");
  if (unreadValue !== null && unreadValue !== "true" && unreadValue !== "false") {
    return error(request, 400, "invalid_unread", "unread must be true or false");
  }

  if (countOnlyValue === "true") {
    const count = await env.DB.prepare(
      `SELECT COUNT(*) AS unreadCount
       FROM community_notification AS notification
       WHERE notification.recipient_user_id = ? AND notification.read_at IS NULL
         AND ${visibleNotificationWhere}
         AND ${visibleNotificationActorWhere}`,
    )
      .bind(session.user.id)
      .first<UnreadCountRow>();
    return json(request, { notifications: [], nextCursor: null, unreadCount: count?.unreadCount ?? 0 });
  }

  const where = ["notification.recipient_user_id = ?", visibleNotificationWhere, visibleNotificationActorWhere];
  const bindings: BindValue[] = [session.user.id];
  if (unreadValue === "true") where.push("notification.read_at IS NULL");
  else if (unreadValue === "false") where.push("notification.read_at IS NOT NULL");
  if (cursor) {
    where.push("(notification.created_at < ? OR (notification.created_at = ? AND notification.id < ?))");
    bindings.push(cursor.createdAt, cursor.createdAt, cursor.id);
  }
  const result = await env.DB.prepare(
    `SELECT
       notification.id,
       notification.kind,
       notification.post_id AS postId,
       notification.comment_id AS commentId,
       notification.created_at AS createdAt,
       notification.read_at AS readAt,
       actor.id AS actorId,
       actor_identity.uid AS actorUid,
       actor_profile.display_name AS actorName,
       actor.image AS actorImage
     FROM community_notification AS notification
     LEFT JOIN "user" AS actor ON actor.id = notification.actor_user_id
     LEFT JOIN community_identity AS actor_identity ON actor_identity.user_id = notification.actor_user_id
     LEFT JOIN community_profile AS actor_profile ON actor_profile.user_id = notification.actor_user_id
     WHERE ${where.join(" AND ")}
     ORDER BY notification.created_at DESC, notification.id DESC
     LIMIT ?`,
  )
    .bind(...bindings, limit + 1)
    .all<NotificationRow>();
  const count = await env.DB.prepare(
    `SELECT COUNT(*) AS unreadCount
     FROM community_notification AS notification
     WHERE notification.recipient_user_id = ? AND notification.read_at IS NULL
       AND ${visibleNotificationWhere}
       AND ${visibleNotificationActorWhere}`,
  )
    .bind(session.user.id)
    .first<UnreadCountRow>();
  const hasMore = result.results.length > limit;
  const notificationRows = hasMore ? result.results.slice(0, limit) : result.results;
  const notifications = notificationRows.map(({ actorId, ...notification }) => ({
    ...notification,
    actorAvatarSeed: actorId,
  }));
  const last = notifications.at(-1);
  return json(request, {
    notifications,
    nextCursor: hasMore && last ? encodeCursor(last) : null,
    unreadCount: count?.unreadCount ?? 0,
  });
};

const markNotificationRead = async (request: Request, env: Env, id: string): Promise<Response> => {
  const session = await requireSession(request, env);
  if (!session) return error(request, 401, "authentication_required", "Sign in to update notifications");
  const now = Date.now();
  const notification = await env.DB.prepare(
    `UPDATE community_notification AS notification SET read_at = COALESCE(read_at, ?)
     WHERE notification.id = ? AND notification.recipient_user_id = ?
       AND ${visibleNotificationWhere}
       AND ${visibleNotificationActorWhere}
       AND EXISTS (
         SELECT 1 FROM community_profile AS active_recipient
         WHERE active_recipient.user_id = notification.recipient_user_id
           AND active_recipient.status = 'active'
           AND active_recipient.deleted_at IS NULL
       )
     RETURNING read_at AS readAt`,
  )
    .bind(now, id, session.user.id)
    .first<ReadAtRow>();
  if (!notification) return error(request, 404, "notification_not_found", "Notification not found");
  return json(request, { id, readAt: notification.readAt });
};

const markAllNotificationsRead = async (request: Request, env: Env): Promise<Response> => {
  const session = await requireSession(request, env);
  if (!session) return error(request, 401, "authentication_required", "Sign in to update notifications");
  const readAt = Date.now();
  const result = await env.DB.prepare(
    `UPDATE community_notification AS notification
     SET read_at = ?
     WHERE notification.recipient_user_id = ? AND notification.read_at IS NULL
       AND ${visibleNotificationWhere}
       AND ${visibleNotificationActorWhere}
       AND EXISTS (
         SELECT 1 FROM community_profile AS active_recipient
         WHERE active_recipient.user_id = notification.recipient_user_id
           AND active_recipient.status = 'active'
           AND active_recipient.deleted_at IS NULL
       )`,
  )
    .bind(readAt, session.user.id)
    .run();
  return json(request, { readAt, updatedCount: Number(result.meta.changes || 0) });
};

const readPreferences = async (request: Request, env: Env, userId: string): Promise<Response> => {
  const value = await env.DB.prepare(
    `SELECT locale, asset_server AS assetServer, settings_json AS settings, version, updated_at AS updatedAt
     FROM user_preference WHERE user_id = ?`,
  )
    .bind(userId)
    .first<PreferenceDatabaseRow>();
  if (!value) return json(request, { preferences: null });
  let settings: JsonValue = null;
  if (value.settings) {
    const parsed: unknown = JSON.parse(value.settings);
    if (!isJsonValue(parsed)) throw new Error("Stored preference settings are not valid JSON data");
    settings = parsed;
  }
  const preferences: PreferenceResponse = { ...value, settings };
  return json(request, { preferences });
};

const preferences = async (request: Request, env: Env): Promise<Response> => {
  if (request.method === "GET" || request.method === "HEAD") {
    const session = await requireSession(request, env);
    if (!session) return error(request, 401, "authentication_required", "Sign in to sync preferences");
    return readPreferences(request, env, session.user.id);
  }
  if (request.method !== "PUT") return error(request, 405, "method_not_allowed", "Method not allowed");
  const access = await requireWritableSession(request, env, "Sign in to sync preferences");
  if (!access.ok) return access.response;
  const { session } = access;
  const payload = await readJSON(request);
  if ("error" in payload) return payloadError(request, payload.error);
  const locale = typeof payload.value.locale === "string" ? payload.value.locale : null;
  const assetServer = typeof payload.value.assetServer === "string" ? payload.value.assetServer.trim() : null;
  const settings = payload.value.settings == null ? null : JSON.stringify(payload.value.settings);
  if (locale && !ALLOWED_LOCALES.has(locale)) return error(request, 422, "invalid_locale", "Unsupported locale");
  if (assetServer && !/^[a-z0-9][a-z0-9-]{0,31}$/i.test(assetServer)) {
    return error(request, 422, "invalid_asset_server", "Invalid asset server identifier");
  }
  if (settings && new TextEncoder().encode(settings).byteLength > 16 * 1024) {
    return error(request, 422, "settings_too_large", "Settings exceed 16 KiB");
  }
  const now = Date.now();
  const result = await env.DB.prepare(
    `INSERT INTO user_preference (user_id, locale, asset_server, settings_json, version, updated_at)
     SELECT ?, ?, ?, ?, 1, ?
     WHERE ${activeSessionProfileWhere}
     ON CONFLICT(user_id) DO UPDATE SET
       locale = excluded.locale,
       asset_server = excluded.asset_server,
       settings_json = excluded.settings_json,
       version = user_preference.version + 1,
       updated_at = excluded.updated_at`,
  )
    .bind(session.user.id, locale, assetServer, settings, now, session.user.id)
    .run();
  if (!result.meta.changes) {
    return error(request, 403, "account_deleted", "This account cannot write to the community");
  }
  return readPreferences(request, env, session.user.id);
};

export const handleCommunityRequest = async (request: Request, env: Env): Promise<Response | null> => {
  const url = new URL(request.url);
  if (url.pathname === "/api/v1/account/config" && (request.method === "GET" || request.method === "HEAD")) {
    return json(request, authConfiguration(env));
  }
  if (url.pathname === "/api/v1/me/preferences") {
    if (!isSameOrigin(request) && !new Set(["GET", "HEAD"]).has(request.method)) {
      return error(request, 403, "cross_origin_request", "Cross-origin writes are not allowed");
    }
    if (!env.DB) return error(request, 503, "database_unavailable", "Database is not configured");
    return preferences(request, env);
  }
  if (!url.pathname.startsWith(COMMUNITY_PREFIX)) return null;
  if (!env.DB) return error(request, 503, "database_unavailable", "Database is not configured");

  const social = await handleCommunitySocialRequest(request, env);
  if (social) return social;

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: { Allow: "GET, HEAD, POST, PATCH, PUT, DELETE, OPTIONS" } });
  }
  if (!new Set(["GET", "HEAD"]).has(request.method) && !isSameOrigin(request)) {
    return error(request, 403, "cross_origin_request", "Cross-origin writes are not allowed");
  }

  if (url.pathname === `${COMMUNITY_PREFIX}/posts`) {
    if (request.method === "GET" || request.method === "HEAD") return listPosts(request, env, url);
    if (request.method === "POST") return createPost(request, env);
    return error(request, 405, "method_not_allowed", "Method not allowed");
  }
  if (url.pathname === `${COMMUNITY_PREFIX}/notifications`) {
    if (request.method === "GET" || request.method === "HEAD") return listNotifications(request, env, url);
    return error(request, 405, "method_not_allowed", "Method not allowed");
  }
  if (url.pathname === `${COMMUNITY_PREFIX}/notifications/read-all`) {
    if (request.method === "PUT") return markAllNotificationsRead(request, env);
    return error(request, 405, "method_not_allowed", "Method not allowed");
  }
  const notificationMatch = new RegExp(`^${COMMUNITY_PREFIX}/notifications/([0-9a-f-]{36})/read$`, "i").exec(
    url.pathname,
  );
  if (notificationMatch?.[1]) {
    if (!UUID_PATTERN.test(notificationMatch[1]))
      return error(request, 404, "route_not_found", "Community API route not found");
    if (request.method === "PUT") return markNotificationRead(request, env, notificationMatch[1]);
    return error(request, 405, "method_not_allowed", "Method not allowed");
  }

  const match = new RegExp(
    `^${COMMUNITY_PREFIX}/posts/([0-9a-f-]{36})(?:/(comments|reaction|bookmark|pin|archive|restore))?$`,
    "i",
  ).exec(url.pathname);
  if (!match?.[1] || !UUID_PATTERN.test(match[1])) {
    return error(request, 404, "route_not_found", "Community API route not found");
  }
  const postId = match[1];
  const action = match[2];
  if (!action) {
    if (request.method === "GET" || request.method === "HEAD") return getPost(request, env, postId, url);
    if (request.method === "PATCH") return updatePost(request, env, postId);
    if (request.method === "DELETE") return deletePost(request, env, postId);
  }
  if (action === "comments" && request.method === "POST") return createComment(request, env, postId);
  if (action === "reaction" && request.method === "PUT") return setReaction(request, env, postId);
  if (action === "bookmark" && request.method === "PUT") return setBookmark(request, env, postId);
  if (action === "pin" && request.method === "PUT") return setPinned(request, env, postId);
  if (action === "archive" && request.method === "POST") return setArchived(request, env, postId, true);
  if (action === "restore" && request.method === "POST") return setArchived(request, env, postId, false);
  return error(request, 405, "method_not_allowed", "Method not allowed");
};
