import { getAuthSession } from "./auth";

const PUBLIC_PROFILE_PREFIX = "/api/v1/community/users/";
const POST_LIMIT = 24;
const POST_LIMIT_MAX = 50;
const WORK_LIMIT = 24;
const GAME_ACCOUNT_LIMIT = 16;
const POST_EXCERPT_MAX = 500;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

type CommunityRole = "admin" | "member" | "moderator";
type WorkKind = "chart" | "story";
type GameAccountVerificationStatus = "pending" | "revoked" | "unverified" | "verified";
type JsonPrimitive = boolean | null | number | string;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

interface PublicProfileRow {
  avatarUrl: string | null;
  bio: string | null;
  displayName: string | null;
  followerCount: number;
  followingCount: number;
  gameAccountCount: number;
  handle: string | null;
  joinedAt: number;
  postCount: number;
  role: CommunityRole;
  uid: number;
  userId: string;
  workCount: number;
}

interface RelationshipRow {
  blockedBy: number;
  blocking: number;
  followedBy: number;
  following: number;
  muted: number;
}

interface PublicProfilePostRow {
  body: string;
  commentCount: number;
  coverAttachmentId: string | null;
  createdAt: number;
  id: string;
  likeCount: number;
  title: string;
  updatedAt: number;
}

interface PublicProfilePostTagRow {
  postId: string;
  tag: string;
}

interface PostCursor {
  createdAt: number;
  id: string;
}

interface PublicWorkRow {
  coverAttachmentId: string | null;
  id: string;
  kind: WorkKind;
  publishedAt: number;
  summary: string | null;
  title: string;
  updatedAt: number;
}

interface PublicGameAccountRow {
  displayName: string | null;
  lastSyncedAt: number | null;
  latestSnapshotCapturedAt: number | null;
  latestSnapshotSummary: string | null;
  playerUid: string;
  provider: string;
  region: string;
  updatedAt: number;
  verificationStatus: GameAccountVerificationStatus;
}

const json = (request: Request, value: object, status = 200): Response =>
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

const parseJsonObject = (value: string): JsonObject => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return {};
  }
  return isJsonValue(parsed) && parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
};

const stripCommunityBbcodeTags = (value: string): string =>
  value
    .replace(/\[\/?(?:quote|code|list|spoiler)(?:=[^\]\r\n]{0,512})?\]|\[\*\]/giu, " ")
    .replace(/\[\/?(?:b|strong|i|em|u|s|strike|url)(?:=[^\]\r\n]{0,512})?\]/giu, "");

const postExcerpt = (body: string): string =>
  [...stripCommunityBbcodeTags(body).replace(/\s+/gu, " ").trim()].slice(0, POST_EXCERPT_MAX).join("");

const attachmentContentUrl = (attachmentId: string | null): string | null =>
  attachmentId ? `/api/v1/community/attachments/${attachmentId}/content` : null;

const singleSearchParameter = (url: URL, name: string): string | null | undefined => {
  const values = url.searchParams.getAll(name);
  if (values.length > 1) return undefined;
  return values[0] ?? null;
};

const parsePostLimit = (value: string | null): number | null => {
  if (value === null) return POST_LIMIT;
  if (!/^\d{1,2}$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= POST_LIMIT_MAX ? parsed : null;
};

const encodePostCursor = (cursor: PostCursor): string =>
  btoa(JSON.stringify(cursor)).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/gu, "");

const decodePostCursor = (value: string | null): PostCursor | null => {
  if (value === null) return null;
  if (!/^[A-Za-z0-9_-]{1,512}$/u.test(value)) return null;
  try {
    const padded = value
      .replace(/-/gu, "+")
      .replace(/_/gu, "/")
      .padEnd(Math.ceil(value.length / 4) * 4, "=");
    const parsed: unknown = JSON.parse(atob(padded));
    if (!parsed || typeof parsed !== "object") return null;
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

const readProfile = (env: Env, uid: number): Promise<PublicProfileRow | null> =>
  env.DB.prepare(
    `SELECT identity.uid, identity.user_id AS userId, identity.created_at AS joinedAt,
            profile.display_name AS displayName, profile.handle, profile.bio, profile.role,
            account.image AS avatarUrl,
            (
              SELECT COUNT(*)
              FROM community_user_follow AS follower
              JOIN community_profile AS follower_profile
                ON follower_profile.user_id = follower.follower_user_id
               AND follower_profile.status <> 'deleted'
               AND follower_profile.display_name IS NOT NULL
              WHERE follower.followed_user_id = identity.user_id
            ) AS followerCount,
            (
              SELECT COUNT(*)
              FROM community_user_follow AS followed
              JOIN community_profile AS followed_profile
                ON followed_profile.user_id = followed.followed_user_id
               AND followed_profile.status <> 'deleted'
               AND followed_profile.display_name IS NOT NULL
              WHERE followed.follower_user_id = identity.user_id
            ) AS followingCount,
            (
              SELECT COUNT(*)
              FROM community_post AS post
              WHERE post.author_id = identity.user_id
                AND post.status = 'published'
                AND post.visibility = 'public'
                AND post.moderation_status = 'allow'
                AND post.archived_at IS NULL
                AND post.deleted_at IS NULL
            ) AS postCount,
            (
              SELECT COUNT(*)
              FROM community_work AS work
              WHERE work.owner_user_id = identity.user_id
                AND work.status = 'published'
                AND work.visibility = 'public'
                AND work.moderation_status = 'allow'
                AND work.deleted_at IS NULL
            ) AS workCount,
            (
              SELECT COUNT(*)
              FROM community_game_account AS game_account
              WHERE game_account.user_id = identity.user_id
                AND game_account.visibility = 'public'
                AND game_account.deleted_at IS NULL
            ) AS gameAccountCount
     FROM community_identity AS identity
     JOIN community_profile AS profile ON profile.user_id = identity.user_id
     JOIN "user" AS account ON account.id = identity.user_id
     WHERE identity.uid = ?
       AND profile.status <> 'deleted'
       AND profile.display_name IS NOT NULL
     LIMIT 1`,
  )
    .bind(uid)
    .first<PublicProfileRow>();

const readPosts = async (env: Env, userId: string, limit: number, cursor: PostCursor | null) => {
  const cursorCondition = cursor ? "AND (post.created_at < ? OR (post.created_at = ? AND post.id < ?))" : "";
  const cursorBindings = cursor ? [cursor.createdAt, cursor.createdAt, cursor.id] : [];
  const result = await env.DB.prepare(
    `SELECT post.id, post.title, post.body,
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
            (
              SELECT COUNT(*)
              FROM community_reaction AS visible_reaction
              JOIN community_profile AS visible_reaction_author
                ON visible_reaction_author.user_id = visible_reaction.user_id
               AND visible_reaction_author.status <> 'deleted'
               AND visible_reaction_author.display_name IS NOT NULL
              WHERE visible_reaction.post_id = post.id
                AND visible_reaction.kind = 'like'
            ) AS likeCount,
            post.created_at AS createdAt, post.updated_at AS updatedAt,
            (
              SELECT attachment.id
              FROM community_post_attachment AS link
              JOIN community_attachment AS attachment ON attachment.id = link.attachment_id
              WHERE link.post_id = post.id
                AND attachment.status = 'ready'
                AND attachment.moderation_status = 'allow'
                AND attachment.deleted_at IS NULL
                AND attachment.media_type IN ('image/jpeg', 'image/png', 'image/webp')
              ORDER BY link.position, attachment.id
              LIMIT 1
            ) AS coverAttachmentId
     FROM community_post AS post
     WHERE post.author_id = ?
       AND post.status = 'published'
       AND post.visibility = 'public'
       AND post.moderation_status = 'allow'
       AND post.archived_at IS NULL
       AND post.deleted_at IS NULL
       ${cursorCondition}
     ORDER BY post.created_at DESC, post.id DESC
     LIMIT ?`,
  )
    .bind(userId, ...cursorBindings, limit + 1)
    .all<PublicProfilePostRow>();
  const hasMore = result.results.length > limit;
  const rows = hasMore ? result.results.slice(0, limit) : result.results;
  if (!rows.length) return { nextCursor: null, posts: [] };

  const placeholders = rows.map(() => "?").join(", ");
  const tags = await env.DB.prepare(
    `SELECT link.post_id AS postId, tag.normalized_name AS tag
     FROM community_post_tag AS link
     JOIN community_tag AS tag ON tag.id = link.tag_id
     WHERE link.post_id IN (${placeholders}) AND tag.status = 'active'
     ORDER BY link.post_id, link.position, tag.normalized_name`,
  )
    .bind(...rows.map((post) => post.id))
    .all<PublicProfilePostTagRow>();
  const tagsByPost = new Map<string, string[]>();
  for (const row of tags.results) {
    const values = tagsByPost.get(row.postId);
    if (values) values.push(row.tag);
    else tagsByPost.set(row.postId, [row.tag]);
  }
  const last = rows.at(-1);
  return {
    nextCursor: hasMore && last ? encodePostCursor({ createdAt: last.createdAt, id: last.id }) : null,
    posts: rows.map(({ body, coverAttachmentId, ...post }) => ({
      ...post,
      coverUrl: attachmentContentUrl(coverAttachmentId),
      excerpt: postExcerpt(body),
      tags: tagsByPost.get(post.id) ?? [],
    })),
  };
};

const readWorks = async (env: Env, userId: string) => {
  const result = await env.DB.prepare(
    `SELECT work.id, work.kind, work.title, work.summary,
            work.updated_at AS updatedAt, work.published_at AS publishedAt,
            cover.id AS coverAttachmentId
     FROM community_work AS work
     LEFT JOIN community_attachment AS cover
       ON cover.id = work.cover_attachment_id
      AND cover.status = 'ready'
      AND cover.moderation_status = 'allow'
      AND cover.deleted_at IS NULL
      AND cover.media_type IN ('image/jpeg', 'image/png', 'image/webp')
     WHERE work.owner_user_id = ?
       AND work.status = 'published'
       AND work.visibility = 'public'
       AND work.moderation_status = 'allow'
       AND work.deleted_at IS NULL
       AND EXISTS (
         SELECT 1
         FROM community_work_revision AS revision
         WHERE revision.work_id = work.id AND revision.status = 'published'
       )
     ORDER BY work.published_at DESC, work.id DESC
     LIMIT ?`,
  )
    .bind(userId, WORK_LIMIT)
    .all<PublicWorkRow>();
  return result.results.map(({ coverAttachmentId, ...work }) => ({
    ...work,
    coverUrl: attachmentContentUrl(coverAttachmentId),
  }));
};

const readGameAccounts = async (env: Env, userId: string) => {
  const result = await env.DB.prepare(
    `SELECT game_account.provider, game_account.region,
            game_account.external_account_id AS playerUid,
            game_account.display_name AS displayName,
            game_account.verification_status AS verificationStatus,
            game_account.last_synced_at AS lastSyncedAt,
            game_account.updated_at AS updatedAt,
            snapshot.captured_at AS latestSnapshotCapturedAt,
            snapshot.summary_json AS latestSnapshotSummary
     FROM community_game_account AS game_account
     LEFT JOIN community_game_account_snapshot AS snapshot
       ON snapshot.id = (
         SELECT candidate.id
         FROM community_game_account_snapshot AS candidate
         WHERE candidate.game_account_id = game_account.id
         ORDER BY candidate.captured_at DESC, candidate.id DESC
         LIMIT 1
       )
     WHERE game_account.user_id = ?
       AND game_account.visibility = 'public'
       AND game_account.deleted_at IS NULL
     ORDER BY game_account.updated_at DESC, game_account.id DESC
     LIMIT ?`,
  )
    .bind(userId, GAME_ACCOUNT_LIMIT)
    .all<PublicGameAccountRow>();
  return result.results.map(({ latestSnapshotCapturedAt, latestSnapshotSummary, ...account }) => ({
    ...account,
    latestSnapshot:
      latestSnapshotCapturedAt === null || latestSnapshotSummary === null
        ? null
        : { capturedAt: latestSnapshotCapturedAt, summary: parseJsonObject(latestSnapshotSummary) },
  }));
};

const getPublicProfile = async (request: Request, env: Env, uid: number, url: URL): Promise<Response> => {
  const limitValue = singleSearchParameter(url, "limit");
  const cursorValue = singleSearchParameter(url, "cursor");
  if (limitValue === undefined || cursorValue === undefined) {
    return error(request, 400, "duplicate_query_parameter", "Profile post query parameters may only be sent once");
  }
  const limit = parsePostLimit(limitValue);
  if (limit === null) {
    return error(request, 400, "invalid_limit", `limit must be 1-${POST_LIMIT_MAX}`);
  }
  const cursor = decodePostCursor(cursorValue);
  if (cursorValue && !cursor) return error(request, 400, "invalid_cursor", "The cursor is invalid");

  const profile = await readProfile(env, uid);
  if (!profile) return error(request, 404, "profile_not_found", "Community profile not found");
  const session = await getAuthSession(request, env);
  const owner = session?.user?.id === profile.userId;
  const relationship =
    session?.user?.id && !owner
      ? await env.DB.prepare(
          `SELECT
             EXISTS(
               SELECT 1 FROM community_user_follow
               WHERE follower_user_id = ? AND followed_user_id = ?
             ) AS following,
             EXISTS(
               SELECT 1 FROM community_user_follow
               WHERE follower_user_id = ? AND followed_user_id = ?
             ) AS followedBy,
             EXISTS(
               SELECT 1 FROM community_user_block
               WHERE blocker_user_id = ? AND blocked_user_id = ?
             ) AS blocking,
             EXISTS(
               SELECT 1 FROM community_user_block
               WHERE blocker_user_id = ? AND blocked_user_id = ?
             ) AS blockedBy,
             EXISTS(
               SELECT 1 FROM community_user_mute
               WHERE muter_user_id = ? AND muted_user_id = ?
             ) AS muted`,
        )
          .bind(
            session.user.id,
            profile.userId,
            profile.userId,
            session.user.id,
            session.user.id,
            profile.userId,
            profile.userId,
            session.user.id,
            session.user.id,
            profile.userId,
          )
          .first<RelationshipRow>()
      : null;
  const blocked = Boolean(relationship?.blocking || relationship?.blockedBy);
  const [postPage, works, gameAccounts] = blocked
    ? [{ nextCursor: null, posts: [] }, [], []]
    : await Promise.all([
        readPosts(env, profile.userId, limit, cursor),
        readWorks(env, profile.userId),
        readGameAccounts(env, profile.userId),
      ]);
  return json(request, {
    profile: {
      avatarSeed: profile.userId,
      avatarUrl: profile.avatarUrl,
      bio: profile.bio,
      displayName: profile.displayName,
      handle: profile.handle,
      joinedAt: profile.joinedAt,
      owner,
      role: profile.role,
      stats: {
        followers: profile.followerCount,
        following: profile.followingCount,
        gameAccounts: profile.gameAccountCount,
        posts: profile.postCount,
        works: profile.workCount,
      },
      uid: profile.uid,
    },
    viewer: {
      blocked: Boolean(relationship?.blocking),
      followedBy: Boolean(relationship?.followedBy),
      following: Boolean(relationship?.following),
      muted: Boolean(relationship?.muted),
      canInteract: Boolean(session?.user?.id && !owner && !blocked),
    },
    gameAccounts,
    posts: postPage.posts,
    postsNextCursor: postPage.nextCursor,
    works,
  });
};

export const handlePublicProfileRequest = async (request: Request, env: Env): Promise<Response | null> => {
  const url = new URL(request.url);
  if (!url.pathname.startsWith(PUBLIC_PROFILE_PREFIX)) return null;
  const uidText = url.pathname.slice(PUBLIC_PROFILE_PREFIX.length);
  if (!/^[1-9]\d{0,15}$/u.test(uidText)) {
    return null;
  }
  const uid = Number(uidText);
  if (!Number.isSafeInteger(uid) || uid < 1) {
    return error(request, 404, "profile_not_found", "Community profile not found");
  }
  if (!env.DB) return error(request, 503, "database_unavailable", "Database is not configured");
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: { Allow: "GET, HEAD, OPTIONS" } });
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    if (!sameOrigin(request)) {
      return error(request, 403, "cross_origin_request", "Cross-origin writes are not allowed");
    }
    return error(request, 405, "method_not_allowed", "Method not allowed");
  }
  return getPublicProfile(request, env, uid, url);
};
