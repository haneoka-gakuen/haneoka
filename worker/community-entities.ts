import { getAuthSession } from "./auth";
import { communityAccessState } from "./access";
import { communityEntityCommentBackend, type CommunityCommentInitializer } from "./community";
import { canonicalEntityTarget, entityCommentTextOnly, type CommunityEntityTarget } from "./community-entity-guard";
import { forumPermissionSql, forumDiscoveryPostSql, handleCommunityForumsRequest } from "./community-forums";
import {
  privateTeamJson as json,
  privateTeamError as error,
  teamSameOrigin as sameOrigin,
  readTeamBody as readBody,
  writableTeamOwner,
} from "./team-inventory";

const PREFIX = "/api/v1/community/entity-threads/";
const PURPOSE_ADMIN = "/api/v1/admin/forum-purposes";
const FEED = "/api/v1/community/entity-comments";
const locales = ["ja", "en", "zh-TW", "zh-CN", "ko"] as const;
type Locale = (typeof locales)[number];
export interface CommunityEntityDescriptor {
  type: string;
  originalId: string;
  titles: Partial<Record<Locale, string>>;
  availability: { jp: "present" | "absent" | "unknown"; intl: "present" | "absent" | "unknown" };
  locators: Partial<Record<"jp" | "intl", { routeKind: string; routeId: string; detailPath: string }>>;
}
export type CommunityEntityResolver = (
  env: Env,
  target: CommunityEntityTarget,
  context: { server: "jp" | "intl"; locale: Locale },
) => Promise<CommunityEntityDescriptor | null>;
interface Thread {
  postId: string;
  forumId: string;
  version: number;
  status: string;
  visibility: string;
  moderationStatus: string;
  deletedAt: number | null;
  archivedAt: number | null;
  commentsLockedAt: number | null;
}
const thread = (env: Env, target: CommunityEntityTarget) =>
  env.DB.prepare(
    `SELECT post.id AS postId,post.forum_id AS forumId,post.version,post.status,post.visibility,
  post.moderation_status AS moderationStatus,post.deleted_at AS deletedAt,post.archived_at AS archivedAt,post.comments_locked_at AS commentsLockedAt
  FROM community_entity_thread AS entity JOIN community_post AS post ON post.id=entity.post_id WHERE entity.entity_type=? AND entity.original_id=?`,
  )
    .bind(target.entityType, target.originalId)
    .first<Thread>();
const knownTypes = new Set([
  "cards",
  "support-cards",
  "characters",
  "songs",
  "bands",
  "band-items",
  "items",
  "stamps",
  "stickers",
  "comics",
  "backgrounds",
  "events",
  "real-lives",
  "gacha",
  "login-campaigns",
  "shop",
  "exchange",
  "circle",
  "challenge",
  "passes-season",
  "passes-monthly",
  "missions-regular",
  "missions-limited",
  "stories",
  "live2d",
  "spine",
  "help",
  "tgw-card",
]);

async function carrierId(target: CommunityEntityTarget): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(JSON.stringify(["haneoka-entity-thread-v1", target.entityType, target.originalId])),
    ),
  ).slice(0, 16);
  bytes[6] = (bytes[6]! & 15) | 0x50;
  bytes[8] = (bytes[8]! & 63) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
const readable = (row: Thread) =>
  row.status === "published" && row.deletedAt === null && row.archivedAt === null && row.moderationStatus === "allow";
async function replyAllowed(env: Env, row: Thread | null, forumId: string, userId: string | null): Promise<boolean> {
  if (!userId || (row && (!readable(row) || row.commentsLockedAt !== null))) return false;
  return !!(await env.DB.prepare(`SELECT 1 WHERE ${forumPermissionSql("?", "?", "reply")}`)
    .bind(userId, forumId)
    .first());
}

function initializeThread(
  env: Env,
  target: CommunityEntityTarget,
  postId: string,
  forumId: string,
  userId: string,
  token: string,
): CommunityCommentInitializer {
  const now = Date.now(),
    title = `Entity discussion: ${target.entityType}`,
    body = "Shared catalogue discussion.";
  const insert = env.DB.prepare(
    `INSERT INTO community_post(id,author_id,title,body,status,visibility,moderation_status,forum_id,version,moderation_revision,created_at,updated_at,published_at)
    SELECT ?,?,?,?,'published','public','allow',?,1,1,?,?,? WHERE ${writableTeamOwner}
      AND ${forumPermissionSql("?", "?", "post")} AND ${forumPermissionSql("?", "?", "reply")}
      AND (SELECT COUNT(*) FROM community_comment WHERE author_id=? AND created_at>=?)<300
      AND (SELECT COUNT(*) FROM community_comment WHERE author_id=? AND created_at>=?)<2000
    ON CONFLICT(id) DO NOTHING`,
  ).bind(
    postId,
    userId,
    title,
    body,
    forumId,
    now,
    now,
    now,
    userId,
    token,
    new Date(now).toISOString(),
    now,
    userId,
    forumId,
    userId,
    forumId,
    userId,
    now - 3600000,
    userId,
    now - 86400000,
  );
  const bind = env.DB.prepare(
    `INSERT INTO community_entity_thread(entity_type,original_id,post_id,created_at)
    SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM community_post WHERE id=? AND title=? AND body=?)
    ON CONFLICT(entity_type,original_id) DO NOTHING`,
  ).bind(target.entityType, target.originalId, postId, now, postId, title, body);
  const revision = env.DB.prepare(
    `INSERT INTO community_post_revision(post_id,revision_number,editor_user_id,title,body,visibility,source_kind,created_at)
    SELECT id,1,author_id,title,body,visibility,'create',created_at FROM community_post WHERE id=?
      AND NOT EXISTS(SELECT 1 FROM community_post_revision WHERE post_id=? AND revision_number=1)`,
  ).bind(postId, postId);
  const seal = env.DB.prepare(
    `INSERT INTO community_post_revision_seal(post_id,revision_number,sealed_at)
    SELECT post_id,revision_number,created_at FROM community_post_revision WHERE post_id=? AND revision_number=1
      AND NOT EXISTS(SELECT 1 FROM community_post_revision_seal WHERE post_id=? AND revision_number=1)`,
  ).bind(postId, postId);
  return {
    textOnly: true,
    statements: [insert, bind, revision, seal],
    // A zero-row conditional comment INSERT is not an SQLite error. Make a
    // rejected first comment fail this same transaction so no empty carrier survives.
    acceptedCommentGuard: (commentId) => env.DB.prepare(`
      INSERT INTO community_entity_thread(entity_type,original_id,post_id,created_at)
      SELECT NULL,NULL,NULL,NULL WHERE NOT EXISTS (
        SELECT 1 FROM community_comment WHERE id=? AND post_id=?
      )`).bind(commentId,postId),
  };
}

async function defaultForum(env: Env, userId: string | null): Promise<string | null> {
  return (
    (
      await env.DB.prepare(
        `SELECT purpose.forum_id AS id FROM community_forum_purpose AS purpose WHERE purpose.purpose='entity-comments'
    AND ${forumPermissionSql("purpose.forum_id", "?", "read")}`,
      )
        .bind(userId)
        .first<{ id: string }>()
    )?.id ?? null
  );
}
const entityValue = (descriptor: CommunityEntityDescriptor) => ({
  ...descriptor,
  availableServers: (["jp", "intl"] as const).filter((server) => descriptor.availability[server] === "present"),
  detailPaths: Object.fromEntries(
    Object.entries(descriptor.locators).map(([server, locator]) => [server, locator.detailPath]),
  ),
});

async function purposes(request: Request, env: Env, url: URL): Promise<Response> {
  if (!sameOrigin(request)) return error(request, 403, "cross_origin_request", "Use the same-origin purpose API");
  const session = await getAuthSession(request, env, { authoritative: true });
  if (!session?.user.id) return error(request, 401, "authentication_required", "Sign in required");
  const access = await communityAccessState(
    env,
    session.user.id,
    request.method === "GET" || request.method === "HEAD" ? ["sign_in"] : ["sign_in", "write"],
  );
  if (
    !access ||
    access.role !== "admin" ||
    access.status !== "active" ||
    access.restriction ||
    !session.user.emailVerified
  )
    return error(request, 403, "admin_required", "Administrator access required");
  if (url.pathname === PURPOSE_ADMIN && (request.method === "GET" || request.method === "HEAD")) {
    const rows = await env.DB.prepare(
      "SELECT purpose,forum_id AS forumId,updated_at AS updatedAt FROM community_forum_purpose ORDER BY purpose",
    ).all();
    return json(request, { purposes: rows.results });
  }
  if (url.pathname !== PURPOSE_ADMIN + "/entity-comments" || request.method !== "PUT" || url.searchParams.size)
    return error(request, 405, "method_not_allowed", "Method not allowed");
  const parsed = await readBody(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;
  if (
    Object.keys(body).length !== 2 ||
    typeof body.forumId !== "string" ||
    !/^[a-f\d-]{36}$/iu.test(body.forumId) ||
    typeof body.expectedUpdatedAt !== "number" ||
    !Number.isSafeInteger(body.expectedUpdatedAt) ||
    body.expectedUpdatedAt < 0
  )
    return error(request, 422, "invalid_purpose", "Send a forum and current purpose timestamp");
  const current = await env.DB.prepare(
    "SELECT forum_id AS forumId,updated_at AS updatedAt FROM community_forum_purpose WHERE purpose='entity-comments'",
  ).first<{ forumId: string; updatedAt: number }>();
  if (!current) return error(request, 404, "purpose_not_found", "Purpose not found");
  if (current.updatedAt !== body.expectedUpdatedAt)
    return json(
      request,
      {
        error: { code: "version_conflict", message: "The purpose changed" },
        purpose: { purpose: "entity-comments", ...current },
      },
      409,
    );
  const now = Math.max(Date.now(), current.updatedAt + 1);
  const updated = await env.DB.prepare(
    `UPDATE community_forum_purpose SET forum_id=?,updated_at=?
    WHERE purpose='entity-comments' AND updated_at=? AND EXISTS(SELECT 1 FROM community_forum WHERE id=?)
      AND ${writableTeamOwner} AND EXISTS(SELECT 1 FROM community_profile WHERE user_id=? AND role='admin') RETURNING forum_id AS forumId,updated_at AS updatedAt`,
  )
    .bind(
      body.forumId,
      now,
      current.updatedAt,
      body.forumId,
      session.user.id,
      session.session.token,
      new Date(Date.now()).toISOString(),
      Date.now(),
      session.user.id,
    )
    .first();
  return updated
    ? json(request, { purpose: { purpose: "entity-comments", ...updated } })
    : error(request, 409, "version_or_access_conflict", "The purpose or administrative access changed");
}

async function entityFeed(request: Request, env: Env, url: URL, resolver: CommunityEntityResolver): Promise<Response> {
  const session = await getAuthSession(request, env, { authoritative: true }),
    userId = session?.user.id ?? null;
  const sort = url.searchParams.get("sort") ?? "hot",
    limit = Number(url.searchParams.get("limit") ?? 20);
  const server = url.searchParams.get("server") ?? "intl",
    locale = url.searchParams.get("locale") ?? "en";
  if (
    !["hot", "latest"].includes(sort) ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 50 ||
    !["jp", "intl"].includes(server) ||
    !locales.includes(locale as Locale)
  )
    return error(request, 400, "invalid_query", "Use a supported entity-comment feed context");
  const conditions = [
    "comment.deleted_at IS NULL",
    "comment.hidden_at IS NULL",
    "author.status<>'deleted'",
    "author.display_name IS NOT NULL",
    "comment.moderation_status='allow'",
    "post.status='published'",
    "post.deleted_at IS NULL",
    "post.archived_at IS NULL",
    "post.moderation_status='allow'",
    // The real comment author supplies publication and block status; the carrier's
    // incidental first participant is never a discovery owner or author exemption.
    forumDiscoveryPostSql("post", "viewer.user_id").replaceAll(/\bpost\.author_id\b/gu, "comment.author_id"),
    "NOT EXISTS(SELECT 1 FROM community_user_block WHERE (blocker_user_id=viewer.user_id AND blocked_user_id=comment.author_id) OR (blocker_user_id=comment.author_id AND blocked_user_id=viewer.user_id))",
    "NOT EXISTS(SELECT 1 FROM community_user_mute WHERE muter_user_id=viewer.user_id AND muted_user_id=comment.author_id)",
  ];
  const values: Array<string | number | null> = [userId];
  const q = url.searchParams.get("q")?.normalize("NFKC").trim();
  if (q) {
    if ([...q].length > 100) return error(request, 400, "invalid_query", "Search is too long");
    conditions.push("comment.body LIKE ? ESCAPE '\\'");
    values.push(`%${q.replace(/[\\%_]/gu, "\\$&")}%`);
  }
  const forumId = url.searchParams.get("forumId");
  if (forumId) {
    if (!/^[a-f\d-]{36}$/iu.test(forumId)) return error(request, 400, "invalid_forum", "Use a forum UUID");
    conditions.push("post.forum_id=?");
    values.push(forumId);
  }
  const raw = url.searchParams.get("cursor");
  if (raw) {
    try {
      const cursor = JSON.parse(atob(raw.replace(/-/gu, "+").replace(/_/gu, "/"))) as {
        id: string;
        createdAt: number;
        likeCount: number;
      };
      if (
        !/^[a-f\d-]{36}$/iu.test(cursor.id) ||
        !Number.isSafeInteger(cursor.createdAt) ||
        !Number.isSafeInteger(cursor.likeCount)
      )
        throw new Error();
      if (sort === "hot") {
        conditions.push(
          "(comment.like_count<? OR (comment.like_count=? AND (comment.created_at<? OR (comment.created_at=? AND comment.id<?))))",
        );
        values.push(cursor.likeCount, cursor.likeCount, cursor.createdAt, cursor.createdAt, cursor.id);
      } else {
        conditions.push("(comment.created_at<? OR (comment.created_at=? AND comment.id<?))");
        values.push(cursor.createdAt, cursor.createdAt, cursor.id);
      }
    } catch {
      return error(request, 400, "invalid_cursor", "Invalid comment feed cursor");
    }
  }
  values.push(limit + 1);
  const candidates = (
    await env.DB.prepare(
      `WITH viewer(user_id) AS(SELECT ?) SELECT comment.id,comment.created_at AS createdAt,comment.like_count AS likeCount,
    entity.entity_type AS entityType,entity.original_id AS originalId,post.id AS postId,post.visibility AS postVisibility
    FROM community_comment AS comment JOIN community_entity_thread AS entity ON entity.post_id=comment.post_id
    JOIN community_post AS post ON post.id=comment.post_id JOIN community_profile AS author ON author.user_id=comment.author_id CROSS JOIN viewer
    WHERE ${conditions.join(" AND ")} ORDER BY ${sort === "hot" ? "comment.like_count DESC," : ""}comment.created_at DESC,comment.id DESC LIMIT ?`,
    )
      .bind(...values)
      .all<{
        id: string;
        createdAt: number;
        likeCount: number;
        entityType: string;
        originalId: string;
        postId: string;
        postVisibility: string;
      }>()
  ).results;
  const page = candidates.slice(0, limit),
    entries = [];
  for (const candidate of page) {
    const descriptor = await resolver(
      env,
      { entityType: candidate.entityType, originalId: candidate.originalId },
      { server: server as "jp" | "intl", locale: locale as Locale },
    );
    if (!descriptor) continue;
    const focus = new URL(url);
    focus.search = "";
    focus.searchParams.set("commentId", candidate.id);
    focus.searchParams.set("commentsOnly", "true");
    const response = await communityEntityCommentBackend.read(request, env, candidate.postId, focus);
    if (response.status >= 400) continue;
    const data = (await response.json()) as { comments: Array<{ id: string; rootId?: string }> };
    const comment = data.comments.find((row) => row.id === candidate.id);
    if (!comment) continue;
    entries.push({
      kind: "entity-comment",
      adminOnlyContext: candidate.postVisibility === "private",
      comment: { ...comment, threadId: candidate.postId },
      entityRef: entityValue(descriptor),
      focusedCommentId: comment.id,
      rootId: comment.rootId ?? comment.id,
    });
  }
  const last = page.at(-1),
    nextCursor =
      candidates.length > limit && last
        ? btoa(JSON.stringify({ id: last.id, createdAt: last.createdAt, likeCount: last.likeCount }))
            .replace(/\+/gu, "-")
            .replace(/\//gu, "_")
            .replace(/=+$/gu, "")
        : null;
  return json(request, { entries, nextCursor, sort });
}

/** The resolver validates original identities and current public locators; request labels never become trusted metadata. */
export async function handleCommunityEntityRequest(
  request: Request,
  env: Env,
  resolver: CommunityEntityResolver,
): Promise<Response | null> {
  const url = new URL(request.url);
  const recognized =
    url.pathname.startsWith(PREFIX) ||
    url.pathname === FEED ||
    url.pathname === PURPOSE_ADMIN ||
    url.pathname.startsWith(PURPOSE_ADMIN + "/") ||
    url.pathname === "/api/v1/community/entity-comment-forum" ||
    (url.pathname === "/api/v1/community/forums" && url.searchParams.get("purpose") === "entity-comments");
  if (!recognized) return null;
  if (!env.DB) return error(request, 503, "database_unavailable", "Database is not configured");
  if (!sameOrigin(request)) return error(request, 403, "cross_origin_request", "Use the same-origin entity API");
  if (url.pathname === FEED)
    return request.method === "GET" || request.method === "HEAD"
      ? entityFeed(request, env, url, resolver)
      : error(request, 405, "method_not_allowed", "Method not allowed");
  if (url.pathname === PURPOSE_ADMIN || url.pathname.startsWith(PURPOSE_ADMIN + "/"))
    return purposes(request, env, url);
  const purposeLookup =
    url.pathname === "/api/v1/community/entity-comment-forum" ||
    (url.pathname === "/api/v1/community/forums" && url.searchParams.get("purpose") === "entity-comments");
  if (purposeLookup) {
    if (request.method !== "GET" && request.method !== "HEAD")
      return error(request, 405, "method_not_allowed", "Method not allowed");
    const current = await env.DB.prepare(
      "SELECT forum_id AS forumId FROM community_forum_purpose WHERE purpose='entity-comments'",
    ).first<{ forumId: string }>();
    if (!current) return json(request, { purpose: "entity-comments", forums: [] });
    const forwarded = new Request(new URL(`/api/v1/community/forums/${current.forumId}`, url), request);
    const result = await handleCommunityForumsRequest(forwarded, env);
    if (!result || result.status === 404) return json(request, { purpose: "entity-comments", forums: [] });
    if (request.method === "HEAD") return result;
    if (result.status >= 400) return result;
    const value = (await result.json()) as { forum: unknown };
    return json(request, { purpose: "entity-comments", forums: [value.forum] });
  }
  if (!url.pathname.startsWith(PREFIX)) return null;
  if (!sameOrigin(request)) return error(request, 403, "cross_origin_request", "Use the same-origin comment API");
  if (!env.DB) return error(request, 503, "database_unavailable", "Database is not configured");
  if (request.method === "OPTIONS")
    return new Response(null, {
      status: 204,
      headers: { Allow: "GET, HEAD, POST, OPTIONS", "Cache-Control": "private, no-store", Vary: "Cookie" },
    });
  const path = url.pathname.slice(PREFIX.length).split("/");
  let target: CommunityEntityTarget | null = null;
  try {
    target = canonicalEntityTarget(decodeURIComponent(path[0] ?? ""), decodeURIComponent(path[1] ?? ""));
  } catch {}
  if (
    !target ||
    !knownTypes.has(target.entityType) ||
    !(path.length === 2 || (path.length === 3 && path[2] === "comments"))
  )
    return error(request, 404, "entity_not_found", "Entity target not found");
  const write = request.method === "POST" && path[2] === "comments";
  if (!write && request.method !== "GET" && request.method !== "HEAD")
    return error(request, 405, "method_not_allowed", "Method not allowed");
  const allowedQuery=["server","locale","commentsSort","commentsCursor","commentId","commentsRoot"];
  if([...url.searchParams.keys()].some(key=>!allowedQuery.includes(key)) || allowedQuery.some(key=>url.searchParams.getAll(key).length>1))return error(request,400,"invalid_query","Use one value per supported entity-comment query");
  const sortValue=url.searchParams.get("commentsSort");
  if(sortValue!==null && sortValue!=="hot" && sortValue!=="latest")return error(request,400,"invalid_comment_sort","Use hot or latest");
  for(const key of ["commentId","commentsRoot"]){const value=url.searchParams.get(key);if(value!==null && !/^[a-f\d]{8}-[a-f\d]{4}-[1-8][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/iu.test(value))return error(request,400,"invalid_comment_id","Use a comment UUID");}
  const server = url.searchParams.get("server") ?? "intl",
    locale = url.searchParams.get("locale") ?? "en";
  if (
    !["jp", "intl"].includes(server) ||
    !locales.includes(locale as Locale) ||
    ["server", "locale"].some((key) => url.searchParams.getAll(key).length > 1)
  )
    return error(request, 400, "invalid_context", "Use a supported display server and locale");
  const descriptor = await resolver(env, target, { server: server as "jp" | "intl", locale: locale as Locale });
  if (!descriptor || descriptor.type !== target.entityType || descriptor.originalId !== target.originalId)
    return error(request, 404, "entity_not_found", "The original entity is unavailable or unresolved");
  const session = await getAuthSession(request, env, { authoritative: true }),
    userId = session?.user?.id ?? null;
  const existing = await thread(env, target),
    forumId = existing?.forumId ?? (await defaultForum(env, userId));
  if (
    !forumId ||
    !(await env.DB.prepare(`SELECT 1 WHERE ${forumPermissionSql("?", "?", "read")}`)
      .bind(userId, forumId)
      .first())
  )
    return error(request, 404, "thread_not_found", "Entity discussion is not readable");
  if (write) {
    if (!session?.user.id) return error(request, 401, "authentication_required", "Sign in to comment");
    const body = await readBody(request);
    if (!body.ok) return body.response;
    if (
      !entityCommentTextOnly(body.body) ||
      typeof body.body.body !== "string" ||
      !body.body.body.trim() ||
      [...body.body.body.trim()].length > 5000
    )
      return error(request, 422, "entity_comment_media_forbidden", "Send comment text and an optional parentId only");
    if (!(await replyAllowed(env, existing, forumId, userId)))
      return error(request, 403, "thread_not_writable", "This discussion is not open for replies");
    const postId = existing?.postId ?? (await carrierId(target)),
      initialize = existing
        ? undefined
        : initializeThread(env, target, postId, forumId, userId!, session.session.token);
    const headers = new Headers(request.headers);
    headers.delete("Content-Length");
    headers.set("Content-Type", "application/json");
    const forwarded = new Request(request.url, { method: "POST", headers, body: JSON.stringify(body.body) });
    const result = await communityEntityCommentBackend.create(forwarded, env, postId, initialize);
    const payload: unknown = await result.json();
    if (!payload || typeof payload !== "object" || result.status >= 400)
      return json(request, payload && typeof payload === "object" ? payload : {}, result.status);
    const created = (payload as { comment?: { id?: string } }).comment;
    let comment: unknown = created;
    if (created?.id) {
      const focus = new URL(url);
      focus.search = "";
      focus.searchParams.set("commentId", created.id);
      focus.searchParams.set("commentsOnly", "true");
      const hydrated = await communityEntityCommentBackend.read(forwarded, env, postId, focus);
      if (hydrated.ok) {
        const value = (await hydrated.json()) as { comments?: Array<{ id: string }> };
        comment = value.comments?.find((row) => row.id === created.id) ?? created;
      }
    }
    return json(
      request,
      {
        ...payload,
        comment: comment && typeof comment === "object" ? { ...comment, threadId: postId } : comment,
        entity: entityValue(descriptor),
        thread: { id: postId, forumId },
      },
      result.status,
    );
  }
  if (!existing)
    return json(request, {
      entity: entityValue(descriptor),
      thread: null,
      comments: [],
      commentCount: 0,
      nextCursor: null,
      sort: url.searchParams.get("commentsSort") ?? "hot",
      viewer: { canComment: await replyAllowed(env, null, forumId, userId) },
    });
  const readUrl = new URL(url);
  readUrl.searchParams.delete("server");
  readUrl.searchParams.delete("locale");
  readUrl.searchParams.set("commentsOnly", "true");
  const result = await communityEntityCommentBackend.read(request, env, existing.postId, readUrl);
  if (result.status >= 400) return result;
  const payload = (await result.json()) as {
    comments?: Array<{ id: string; rootId?: string }>;
    commentCount?: number;
    commentsNextCursor?: string | null;
    commentsSort?: string;
    replyCursor?: string | null;
  };
  const focusId = url.searchParams.get("commentId"),
    focus = payload.comments?.find((comment) => comment.id === focusId);
  return json(request, {
    ...payload,
    comments: payload.comments?.map((comment) => ({ ...comment, threadId: existing.postId })),
    entity: entityValue(descriptor),
    thread: { id: existing.postId, forumId, commentCount: payload.commentCount ?? 0 },
    nextCursor: payload.commentsNextCursor ?? null,
    sort: payload.commentsSort ?? "hot",
    focusedCommentId: focus?.id ?? null,
    focusedRootId: focus?.rootId ?? focus?.id ?? null,
    viewer: { canComment: await replyAllowed(env, existing, forumId, userId) },
  });
}
