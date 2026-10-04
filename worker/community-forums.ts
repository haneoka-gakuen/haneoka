import { getAuthSession, type AuthSession } from "./auth";
import { communityAccessState } from "./access";
import { postAttachmentsAllowedSql } from "./moderation";
import {
  privateTeamJson as json,
  privateTeamError as error,
  teamSameOrigin as sameOrigin,
  readTeamBody as readBody,
  writableTeamOwner,
} from "./team-inventory";

export type ForumReadAudience = "public" | "member" | "verified" | "moderator" | "admin" | "none";
export type ForumWriteAudience = "verified" | "moderator" | "admin" | "none";
export type ForumLocale = "ja" | "en" | "zh-TW" | "zh-CN" | "ko";
export interface ForumInput {
  slug: string;
  groupId?: string | null;
  names: Partial<Record<ForumLocale, string>>;
  descriptions: Partial<Record<ForumLocale, string>>;
  icon: string;
  sortOrder: number;
  enabled: boolean;
  permissions: {
    read: ForumReadAudience;
    post: ForumWriteAudience;
    reply: ForumWriteAudience;
    manage: "moderator" | "admin";
  };
  defaultPurpose: "general" | "stamp" | null;
}
type Value = string | number | null;
type Action = "read" | "post" | "reply" | "manage";
type Actor = {
  userId: string;
  token: string;
  role: "admin" | "moderator" | "member";
  session: NonNullable<AuthSession>;
};
interface ForumRow {
  id: string;
  slug: string;
  groupId: string | null;
  namesJson: string;
  descriptionsJson: string;
  icon: string;
  sortOrder: number;
  enabled: number;
  readPermission: ForumReadAudience;
  postPermission: ForumWriteAudience;
  replyPermission: ForumWriteAudience;
  managePermission: "moderator" | "admin";
  defaultPurpose: "general" | "stamp" | null;
  version: number;
  createdAt: number;
  updatedAt: number;
  canRead?: number;
  canPost?: number;
  canReply?: number;
  canManage?: number;
  postCount?: number;
}
const locales = ["ja", "en", "zh-TW", "zh-CN", "ko"] as const;
const uuid = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f\d]{8}-[a-f\d]{4}-[1-8][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/iu.test(value);
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const integer = (value: unknown, min = 1, max = Number.MAX_SAFE_INTEGER - 1): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
const slug = (value: unknown): value is string =>
  typeof value === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value) && value.length <= 80;
const text = (value: unknown, maximum: number, empty = false): value is string =>
  typeof value === "string" &&
  value === value.trim() &&
  [...value].length <= maximum &&
  (empty || value.length > 0) &&
  !/[\p{Cc}\p{Cs}]/u.test(value);
const localized = (value: unknown, maximum: number, required: boolean): Record<ForumLocale, string> | null => {
  if (!object(value) || Object.keys(value).some((key) => !locales.includes(key as ForumLocale))) return null;
  const result = Object.fromEntries(locales.map((locale) => [locale, value[locale] ?? ""])) as Record<
    ForumLocale,
    string
  >;
  if (
    !Object.values(result).every((value) => text(value, maximum, true)) ||
    (required && !Object.values(result).some(Boolean))
  )
    return null;
  return result;
};
const defaultName = (names: Record<ForumLocale, string>) =>
  names.en || names["zh-TW"] || names["zh-CN"] || names.ja || names.ko;

/** SQL expressions are internal caller expressions, never request strings. Each actor expression occurs once. */
export function forumPermissionSql(forumIdExpression: string, actorIdExpression: string, action: Action): string {
  const active = `forum_actor.status = 'active' AND forum_actor.deleted_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM community_user_restriction AS forum_restriction
      WHERE forum_restriction.user_id = forum_actor.user_id AND forum_restriction.revoked_at IS NULL
        AND forum_restriction.kind IN (${action === "read" ? "'sign_in'" : "'sign_in','write'"})
        AND (forum_restriction.expires_at IS NULL OR forum_restriction.expires_at > ${Date.now()}))`;
  const verified = `${active} AND forum_account.emailVerified = 1`;
  const admin = `${verified} AND forum_actor.role = 'admin'`;
  const read = `(forum_acl.read_permission = 'public' OR (${active} AND (
    forum_acl.read_permission = 'member' OR (forum_account.emailVerified = 1 AND (
      forum_acl.read_permission = 'verified'
      OR (forum_acl.read_permission = 'moderator' AND forum_actor.role IN ('moderator','admin'))
      OR (forum_acl.read_permission = 'admin' AND forum_actor.role = 'admin'))))))`;
  const permission =
    action === "read"
      ? `(${admin}) OR (forum_acl.enabled = 1 AND ${read})`
      : action === "manage"
        ? `(${admin}) OR (forum_acl.enabled = 1 AND ${verified} AND ${read} AND forum_acl.manage_permission = 'moderator' AND forum_actor.role = 'moderator')`
        : `forum_acl.enabled = 1 AND ${verified} AND (${read} OR ${admin}) AND (forum_acl.${action}_permission = 'verified'
      OR (forum_acl.${action}_permission = 'moderator' AND forum_actor.role IN ('moderator','admin'))
      OR (forum_acl.${action}_permission = 'admin' AND forum_actor.role = 'admin'))`;
  return `EXISTS (SELECT 1 FROM community_forum AS forum_acl
    LEFT JOIN community_profile AS forum_actor ON forum_actor.user_id = ${actorIdExpression}
    LEFT JOIN "user" AS forum_account ON forum_account.id = forum_actor.user_id
    WHERE forum_acl.id = ${forumIdExpression} AND (${permission}))`;
}
export function forumReadSql(postAlias: string, actorIdExpression: string): string {
  return forumPermissionSql(`${postAlias}.forum_id`, actorIdExpression, "read");
}
export function forumAdminSql(actorIdExpression: string): string {
  return `EXISTS (SELECT 1 FROM community_profile AS forum_admin JOIN "user" AS forum_admin_account ON forum_admin_account.id = forum_admin.user_id
    WHERE forum_admin.user_id = ${actorIdExpression} AND forum_admin.role = 'admin'
      AND forum_admin.status = 'active' AND forum_admin.deleted_at IS NULL AND forum_admin_account.emailVerified = 1
      AND NOT EXISTS (SELECT 1 FROM community_user_restriction AS forum_admin_restriction
        WHERE forum_admin_restriction.user_id = forum_admin.user_id AND forum_admin_restriction.kind = 'sign_in'
          AND forum_admin_restriction.revoked_at IS NULL AND (forum_admin_restriction.expires_at IS NULL OR forum_admin_restriction.expires_at > ${Date.now()})))`;
}
export function forumReadablePostSql(postAlias: string, actorIdExpression: string): string {
  const attachments = postAttachmentsAllowedSql.replaceAll(/\bpost\./gu, `${postAlias}.`);
  return `${forumReadSql(postAlias, actorIdExpression)} AND (${forumAdminSql(actorIdExpression)} OR (
    ${postAlias}.status = 'published' AND ${postAlias}.deleted_at IS NULL
    AND EXISTS (SELECT 1 FROM community_profile AS forum_post_author WHERE forum_post_author.user_id = ${postAlias}.author_id
      AND forum_post_author.status <> 'deleted' AND (forum_post_author.display_name IS NOT NULL OR ${postAlias}.author_id = ${actorIdExpression}))
    AND (${postAlias}.visibility = 'public' OR (${actorIdExpression} IS NOT NULL AND (${postAlias}.visibility = 'protected' OR ${postAlias}.author_id = ${actorIdExpression})))
    AND ((${postAlias}.moderation_status = 'allow' AND ${attachments}) OR ${postAlias}.author_id = ${actorIdExpression})
    AND (${postAlias}.archived_at IS NULL OR ${postAlias}.author_id = ${actorIdExpression})
    AND NOT EXISTS (SELECT 1 FROM community_user_block AS forum_post_block
      WHERE (forum_post_block.blocker_user_id = ${actorIdExpression} AND forum_post_block.blocked_user_id = ${postAlias}.author_id)
         OR (forum_post_block.blocker_user_id = ${postAlias}.author_id AND forum_post_block.blocked_user_id = ${actorIdExpression}))
  ))`;
}

export async function canAccessPostForum(
  env: Env,
  postId: string,
  userId: string | null,
  action: Action = "read",
): Promise<boolean> {
  return !!(await env.DB.prepare(
    `SELECT 1 AS allowed FROM community_post AS post WHERE post.id = ? AND ${forumPermissionSql("post.forum_id", "?", action)}`,
  )
    .bind(postId, userId)
    .first());
}
export async function canAccessAttachmentForum(
  env: Env,
  attachmentId: string,
  userId: string | null,
  action: Action = "read",
): Promise<boolean> {
  return !!(await env.DB.prepare(
    `SELECT 1 AS allowed WHERE NOT EXISTS(SELECT 1 FROM community_post_attachment WHERE attachment_id=?)
    OR EXISTS(SELECT 1 FROM community_post_attachment AS forum_link JOIN community_post AS post ON post.id=forum_link.post_id
      WHERE forum_link.attachment_id=? AND ${forumPermissionSql("post.forum_id", "?", action)})`,
  )
    .bind(attachmentId, attachmentId, userId)
    .first());
}
export async function resolvePostForum(
  env: Env,
  value: unknown,
  purpose: "general" | "stamp",
  userId: string,
): Promise<string | null> {
  if (value !== undefined && !uuid(value)) return null;
  const filter = value === undefined ? "forum.default_purpose = ?" : "forum.id = ?";
  return (
    (
      await env.DB.prepare(
        `SELECT forum.id FROM community_forum AS forum WHERE ${filter} AND ${forumPermissionSql("forum.id", "?", "post")}`,
      )
        .bind(value === undefined ? purpose : value, userId)
        .first<{ id: string }>()
    )?.id ?? null
  );
}

export interface ForumTagSelection {
  tags: string[];
  match: "all" | "any";
}
export function normalizeForumTag(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.normalize("NFKC").replace(/^#/u, "").toLocaleLowerCase("und").trim();
  return /^[\p{L}\p{N}][\p{L}\p{N}_-]{0,31}$/u.test(normalized) ? normalized : null;
}
export function parseForumTagQuery(url: URL): ForumTagSelection | null {
  if (["tags", "tag", "tagMatch", "tagMode"].some((key) => url.searchParams.getAll(key).length > 1)) return null;
  if (url.searchParams.has("tagMatch") && url.searchParams.has("tagMode")) return null;
  const match = url.searchParams.get("tagMatch") ?? url.searchParams.get("tagMode") ?? "all";
  if (match !== "all" && match !== "any") return null;
  const raw = url.searchParams.get("tags");
  const values = raw === null ? (url.searchParams.has("tag") ? [url.searchParams.get("tag")] : []) : raw.split(",");
  if (values.length > 10 || (raw !== null && url.searchParams.has("tag"))) return null;
  const tags = values.map(normalizeForumTag);
  if (tags.some((tag) => tag === null)) return null;
  return { tags: [...new Set(tags as string[])], match };
}
export function forumTagFilterSql(selection: ForumTagSelection, postAlias = "post"): { sql: string; values: Value[] } {
  const clauses = selection.tags.map(
    () => `EXISTS (
    SELECT 1 FROM community_post_tag AS selected_link JOIN community_tag AS selected_tag ON selected_tag.id=selected_link.tag_id
    WHERE selected_link.post_id=${postAlias}.id AND selected_tag.status='active' AND (
      selected_tag.normalized_name=? COLLATE NOCASE
      OR EXISTS(SELECT 1 FROM community_tag_alias AS selected_alias WHERE selected_alias.tag_id=selected_tag.id AND selected_alias.alias_normalized_name=? COLLATE NOCASE)
      OR EXISTS(SELECT 1 FROM community_tag AS selected_merged WHERE selected_merged.status='merged' AND selected_merged.canonical_tag_id=selected_tag.id AND selected_merged.normalized_name=? COLLATE NOCASE)))`,
  );
  return {
    sql: clauses.length ? `(${clauses.join(selection.match === "all" ? " AND " : " OR ")})` : "1",
    values: selection.tags.flatMap((tag) => [tag, tag, tag]),
  };
}

const columns = `forum.id,forum.slug,forum.group_id AS groupId,forum.names_json AS namesJson,forum.descriptions_json AS descriptionsJson,
  forum.icon,forum.sort_order AS sortOrder,forum.enabled,forum.read_permission AS readPermission,
  forum.post_permission AS postPermission,forum.reply_permission AS replyPermission,forum.manage_permission AS managePermission,
  forum.default_purpose AS defaultPurpose,forum.version,forum.created_at AS createdAt,forum.updated_at AS updatedAt`;
const forumValue = (row: ForumRow) => {
  const names = JSON.parse(row.namesJson) as Record<ForumLocale, string>;
  return {
    id: row.id,
    slug: row.slug,
    groupId: row.groupId,
    names,
    defaultName: defaultName(names),
    descriptions: JSON.parse(row.descriptionsJson) as Record<ForumLocale, string>,
    icon: row.icon,
    sortOrder: row.sortOrder,
    enabled: row.enabled === 1,
    permissions: {
      read: row.readPermission,
      post: row.postPermission,
      reply: row.replyPermission,
      manage: row.managePermission,
    },
    defaultPurpose: row.defaultPurpose,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    postCount: row.postCount ?? 0,
    capabilities: {
      canRead: row.canRead === 1,
      canPost: row.canPost === 1,
      canReply: row.canReply === 1,
      canManage: row.canManage === 1,
    },
  };
};
async function readForums(env: Env, userId: string | null, filter = "1", values: Value[] = []): Promise<ForumRow[]> {
  return (
    await env.DB.prepare(
      `WITH forum_viewer(user_id) AS (SELECT ?)
    SELECT ${columns},${forumPermissionSql("forum.id", "forum_viewer.user_id", "read")} AS canRead,
      ${forumPermissionSql("forum.id", "forum_viewer.user_id", "post")} AS canPost,
      ${forumPermissionSql("forum.id", "forum_viewer.user_id", "reply")} AS canReply,
      ${forumPermissionSql("forum.id", "forum_viewer.user_id", "manage")} AS canManage,
      (SELECT COUNT(*) FROM community_post AS post WHERE post.forum_id = forum.id AND ${forumReadablePostSql("post", "forum_viewer.user_id")}) AS postCount
    FROM community_forum AS forum CROSS JOIN forum_viewer
    WHERE ${forumPermissionSql("forum.id", "forum_viewer.user_id", "read")} AND (${filter}) ORDER BY forum.sort_order,forum.id`,
    )
      .bind(userId, ...values)
      .all<ForumRow>()
  ).results;
}
async function readForum(env: Env, userId: string, id: string): Promise<ForumRow | null> {
  return (await readForums(env, userId, "forum.id = ?", [id]))[0] ?? null;
}
const actorGuard = (role: "admin" | "staff") => `${writableTeamOwner} AND EXISTS (
  SELECT 1 FROM community_profile WHERE user_id = ? AND role ${role === "admin" ? "= 'admin'" : "IN ('admin','moderator')"})`;
const actorValues = (actor: Actor, now: number): Value[] => [
  actor.userId,
  actor.token,
  new Date(now).toISOString(),
  now,
  actor.userId,
];
async function requireActor(request: Request, env: Env, role: "admin" | "staff"): Promise<Actor | Response> {
  const session = await getAuthSession(request, env, { authoritative: true });
  if (!session?.user?.id) return error(request, 401, "authentication_required", "Sign in required");
  const expected = request.headers.get("X-Haneoka-Expected-User");
  if (expected && expected !== session.user.id)
    return error(request, 409, "account_changed", "The signed-in account changed");
  const state = await communityAccessState(
    env,
    session.user.id,
    request.method === "GET" || request.method === "HEAD" ? ["sign_in"] : ["sign_in", "write"],
  );
  if (!state || state.status !== "active" || state.restriction || !session.user.emailVerified)
    return error(request, 403, "account_restricted", "This account cannot manage forums");
  if (state.role !== "admin" && !(role === "staff" && state.role === "moderator"))
    return error(request, 403, "admin_required", "Forum administration access required");
  return { userId: session.user.id, token: session.session.token, role: state.role, session };
}
function forumInput(value: unknown): Required<ForumInput> | null {
  if (
    !object(value) ||
    Object.keys(value).some(
      (key) =>
        ![
          "slug",
          "groupId",
          "names",
          "descriptions",
          "icon",
          "sortOrder",
          "enabled",
          "permissions",
          "defaultPurpose",
        ].includes(key),
    )
  )
    return null;
  const names = localized(value.names, 80, true),
    descriptions = localized(value.descriptions ?? {}, 500, false),
    permission = value.permissions;
  if (
    !slug(value.slug) ||
    !names ||
    !descriptions ||
    !(value.groupId === undefined || value.groupId === null || uuid(value.groupId)) ||
    typeof value.icon !== "string" ||
    !/^[a-z][a-z0-9_]{0,79}$/u.test(value.icon) ||
    !integer(value.sortOrder, -1_000_000, 1_000_000) ||
    typeof value.enabled !== "boolean" ||
    !object(permission) ||
    Object.keys(permission).length !== 4 ||
    typeof permission.read !== "string" ||
    !["public", "member", "verified", "moderator", "admin", "none"].includes(permission.read) ||
    ![permission.post, permission.reply].every(
      (value) => typeof value === "string" && ["verified", "moderator", "admin", "none"].includes(value),
    ) ||
    typeof permission.manage !== "string" ||
    !["moderator", "admin"].includes(permission.manage) ||
    !(value.defaultPurpose === null || value.defaultPurpose === "general" || value.defaultPurpose === "stamp")
  )
    return null;
  return {
    slug: value.slug,
    groupId: value.groupId ?? null,
    names,
    descriptions,
    icon: value.icon,
    sortOrder: value.sortOrder,
    enabled: value.enabled,
    permissions: permission as ForumInput["permissions"],
    defaultPurpose: value.defaultPurpose,
  };
}
const configValues = (input: Required<ForumInput>): Value[] => [
  input.slug,
  input.groupId,
  JSON.stringify(input.names),
  JSON.stringify(input.descriptions),
  input.icon,
  input.sortOrder,
  Number(input.enabled),
  input.permissions.read,
  input.permissions.post,
  input.permissions.reply,
  input.permissions.manage,
  input.defaultPurpose,
];
const auditExists = "EXISTS (SELECT 1 FROM community_forum_audit WHERE id = ?)";
function auditStatement(
  env: Env,
  actor: Actor,
  auditId: string,
  action: string,
  targetId: string,
  before: object,
  after: object,
  now: number,
  extra: string,
  values: Value[],
  postId: string | null = null,
  reason: string | null = null,
  role: "admin" | "staff" = "admin",
) {
  return env.DB.prepare(
    `INSERT INTO community_forum_audit(id,actor_user_id,action,target_id,post_id,before_json,after_json,reason_code,created_at)
    SELECT ?,?,?,?,?,?,?,?,? WHERE ${actorGuard(role)} AND (${extra})`,
  ).bind(
    auditId,
    actor.userId,
    action,
    targetId,
    postId,
    JSON.stringify(before),
    JSON.stringify(after),
    reason,
    now,
    ...actorValues(actor, now),
    ...values,
  );
}
async function groups(
  env: Env,
  table: "community_forum_group" | "community_tag_group",
  visibleIds?: (string | null)[],
) {
  const ids = [...new Set(visibleIds?.filter((id): id is string => id !== null))];
  if (visibleIds && !ids.length) return [];
  const rows = (
    await env.DB.prepare(
      `SELECT id,slug,names_json AS namesJson,sort_order AS sortOrder,version,created_at AS createdAt,updated_at AS updatedAt FROM ${table}
    ${visibleIds ? `WHERE id IN (${ids.map(() => "?").join(",")})` : ""} ORDER BY sort_order,id`,
    )
      .bind(...ids)
      .all<{
        id: string;
        slug: string;
        namesJson: string;
        sortOrder: number;
        version: number;
        createdAt: number;
        updatedAt: number;
      }>()
  ).results;
  return rows.map(({ namesJson, ...row }) => {
    const names = JSON.parse(namesJson) as Record<ForumLocale, string>;
    return { ...row, names, defaultName: defaultName(names) };
  });
}

async function saveGroup(
  request: Request,
  env: Env,
  actor: Actor,
  kind: "forum" | "tag",
  id: string | null,
): Promise<Response> {
  const table = kind === "forum" ? "community_forum_group" : "community_tag_group";
  const result = await readBody(request);
  if (!result.ok) return result.response;
  const value = id ? result.body.group : result.body,
    names = object(value) ? localized(value.names, 80, true) : null;
  if (
    !object(value) ||
    Object.keys(value).length !== 3 ||
    !slug(value.slug) ||
    !names ||
    !integer(value.sortOrder, -1_000_000, 1_000_000) ||
    (id && (!integer(result.body.expectedVersion) || Object.keys(result.body).length !== 2))
  )
    return error(request, 422, "invalid_group", "Send a slug, translated name and sort order");
  const previous = id ? (await groups(env, table)).find((group) => group.id === id) : null;
  if (id && !previous) return error(request, 404, "group_not_found", "Group not found");
  if (previous && previous.version !== result.body.expectedVersion)
    return json(request, { error: { code: "version_conflict", message: "The group changed" }, group: previous }, 409);
  const targetId = id ?? crypto.randomUUID(),
    auditId = crypto.randomUUID(),
    now = Math.max(Date.now(), (previous?.updatedAt ?? 0) + 1);
  const condition = id
    ? `EXISTS(SELECT 1 FROM ${table} WHERE id=? AND version=?) AND NOT EXISTS(SELECT 1 FROM ${table} WHERE slug=? AND id<>?)`
    : `NOT EXISTS(SELECT 1 FROM ${table} WHERE slug=?)`;
  const values: Value[] = previous ? [targetId, previous.version, value.slug, targetId] : [value.slug];
  const audit = auditStatement(
    env,
    actor,
    auditId,
    `${kind}_group_${id ? "edit" : "create"}`,
    targetId,
    previous ?? {},
    { ...value, names },
    now,
    condition,
    values,
  );
  const write = previous
    ? env.DB.prepare(
        `UPDATE ${table} SET slug=?,names_json=?,sort_order=?,version=version+1,updated_at=? WHERE id=? AND version=? AND ${auditExists}`,
      ).bind(value.slug, JSON.stringify(names), value.sortOrder, now, targetId, previous.version, auditId)
    : env.DB.prepare(
        `INSERT INTO ${table}(id,slug,names_json,sort_order,version,created_at,updated_at) SELECT ?,?,?,?,1,?,? WHERE ${auditExists}`,
      ).bind(targetId, value.slug, JSON.stringify(names), value.sortOrder, now, now, auditId);
  const saved = await env.DB.batch([audit, write]);
  if (!saved[0]?.meta.changes) return error(request, 409, "version_or_slug_conflict", "Group version or slug changed");
  return json(
    request,
    { group: (await groups(env, table)).find((group) => group.id === targetId), auditId },
    id ? 200 : 201,
  );
}

interface TagRow {
  id: string;
  normalizedName: string;
  displayName: string;
  description: string | null;
  status: string;
  groupId: string | null;
  version: number;
  createdAt: number;
  updatedAt: number;
  postCount?: number;
  followerCount?: number;
  preference?: string | null;
}
const tagColumns =
  "tag.id,tag.normalized_name AS normalizedName,tag.display_name AS displayName,tag.description,tag.status,tag.group_id AS groupId,tag.version,tag.created_at AS createdAt,tag.updated_at AS updatedAt";
async function attachTagAliases(env: Env, rows: TagRow[]) {
  if (!rows.length) return [];
  const result = await env.DB.prepare(
    `SELECT tag_id AS tagId,alias_normalized_name AS alias FROM community_tag_alias WHERE tag_id IN (${rows.map(() => "?").join(",")}) ORDER BY alias_normalized_name`,
  )
    .bind(...rows.map((row) => row.id))
    .all<{ tagId: string; alias: string }>();
  return rows.map((row) => ({
    ...row,
    aliases: result.results.filter((alias) => alias.tagId === row.id).map((alias) => alias.alias),
  }));
}
async function getTagFacets(request: Request, env: Env, url: URL, userId: string | null): Promise<Response> {
  const allowed = [
    "limit",
    "cursor",
    "q",
    "postQ",
    "forumId",
    "tag",
    "tags",
    "tagMatch",
    "tagMode",
    "scope",
    "state",
    "groupId",
  ];
  if (
    [...url.searchParams.keys()].some((key) => !allowed.includes(key)) ||
    allowed.some((key) => url.searchParams.getAll(key).length > 1)
  )
    return error(request, 400, "invalid_query", "Use one value per supported tag filter");
  const selection = parseForumTagQuery(url),
    forumId = url.searchParams.get("forumId"),
    groupId = url.searchParams.get("groupId");
  const qRaw = url.searchParams.get("q"), postQRaw = url.searchParams.get("postQ");
  const q = qRaw === null ? null : qRaw.normalize("NFKC").trim(),
    postQ = postQRaw === null ? null : postQRaw.normalize("NFKC").trim(),
    scope = url.searchParams.get("scope") ?? "all",
    state = url.searchParams.get("state") ?? "active";
  const limitRaw = url.searchParams.get("limit"),
    limit = limitRaw === null ? 100 : Number(limitRaw);
  if (
    !selection ||
    (forumId !== null && !uuid(forumId)) ||
    (groupId !== null && !uuid(groupId)) ||
    !integer(limit, 1, 100) ||
    (q !== null && !text(q, 64)) ||
    (postQ !== null && !text(postQ, 100)) ||
    !["all", "latest", "recommended", "following", "mine", "bookmarked"].includes(scope) ||
    !["active", "archived", "all"].includes(state)
  )
    return error(request, 400, "invalid_query", "Use valid forum, search and tag filters");
  if (!userId && ["mine", "following", "bookmarked"].includes(scope))
    return error(request, 401, "authentication_required", "Sign in to use this scope");
  let cursor: { name: string; id: string } | null = null;
  const rawCursor = url.searchParams.get("cursor");
  if (rawCursor) {
    try {
      const value: unknown = JSON.parse(
        new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
          Uint8Array.from(atob(rawCursor.replace(/-/gu, "+").replace(/_/gu, "/")), (char) => char.charCodeAt(0)),
        ),
      );
      if (
        !object(value) ||
        !uuid(value.id) ||
        typeof value.name !== "string" ||
        normalizeForumTag(value.name) !== value.name
      )
        throw new Error();
      cursor = { name: value.name as string, id: value.id };
    } catch {
      return error(request, 400, "invalid_cursor", "Invalid tag cursor");
    }
  }
  const selected = forumTagFilterSql(selection),
    conditions = [forumReadablePostSql("post", "facet_viewer.user_id"), selected.sql],
    values: Value[] = [userId, ...selected.values];
  if (forumId) {
    conditions.push("post.forum_id=?");
    values.push(forumId);
  }
  if (postQ) {
    const pattern = `%${postQ.replace(/[\\%_]/gu, "\\$&")}%`;
    conditions.push("(post.title LIKE ? ESCAPE '\\' OR post.body LIKE ? ESCAPE '\\')");
    values.push(pattern, pattern);
  }
  if (state === "active") conditions.push("post.archived_at IS NULL");
  else if (state === "archived") conditions.push("post.archived_at IS NOT NULL");
  if (scope === "mine") conditions.push("post.author_id=facet_viewer.user_id");
  if (scope === "bookmarked")
    conditions.push("EXISTS(SELECT 1 FROM community_bookmark WHERE post_id=post.id AND user_id=facet_viewer.user_id)");
  if (scope === "following")
    conditions.push(`(EXISTS(SELECT 1 FROM community_user_follow WHERE followed_user_id=post.author_id AND follower_user_id=facet_viewer.user_id)
    OR EXISTS(SELECT 1 FROM community_post_tag JOIN community_tag_preference ON community_tag_preference.tag_id=community_post_tag.tag_id WHERE community_post_tag.post_id=post.id AND community_tag_preference.user_id=facet_viewer.user_id AND community_tag_preference.kind='follow'))`);
  if (userId && ["all", "latest", "recommended", "following"].includes(scope) && !postQ && !selection.tags.length)
    conditions.push(`NOT EXISTS(SELECT 1 FROM community_user_mute WHERE muter_user_id=facet_viewer.user_id AND muted_user_id=post.author_id)
    AND NOT EXISTS(SELECT 1 FROM community_post_tag JOIN community_tag_preference ON community_tag_preference.tag_id=community_post_tag.tag_id WHERE community_post_tag.post_id=post.id AND community_tag_preference.user_id=facet_viewer.user_id AND community_tag_preference.kind='mute')
    AND NOT EXISTS(SELECT 1 FROM community_post_feedback WHERE user_id=facet_viewer.user_id AND post_id=post.id)`);
  const filters = ["tag.status='active'"];
  if (q) {
    const pattern = `%${q.replace(/[\\%_]/gu, "\\$&")}%`;
    filters.push(
      "(tag.normalized_name LIKE ? ESCAPE '\\' OR tag.display_name LIKE ? ESCAPE '\\' OR EXISTS(SELECT 1 FROM community_tag_alias WHERE tag_id=tag.id AND alias_normalized_name LIKE ? ESCAPE '\\'))",
    );
    values.push(pattern, pattern, pattern);
  }
  if (groupId) {
    filters.push("tag.group_id=?");
    values.push(groupId);
  }
  if (cursor) {
    filters.push("(tag.normalized_name>? COLLATE NOCASE OR (tag.normalized_name=? COLLATE NOCASE AND tag.id>?))");
    values.push(cursor.name, cursor.name, cursor.id);
  }
  values.push(limit + 1);
  const rows = (
    await env.DB.prepare(
      `WITH facet_viewer(user_id) AS(SELECT ?),readable_post AS(SELECT post.id FROM community_post AS post CROSS JOIN facet_viewer WHERE ${conditions.join(" AND ")}),
    readable_tag AS(SELECT link.tag_id,COUNT(*) AS postCount FROM community_post_tag AS link JOIN readable_post ON readable_post.id=link.post_id GROUP BY link.tag_id)
    SELECT ${tagColumns},readable_tag.postCount,
      (SELECT kind FROM community_tag_preference WHERE tag_id=tag.id AND user_id=facet_viewer.user_id) AS preference,
      (SELECT COUNT(*) FROM community_tag_preference JOIN community_profile ON community_profile.user_id=community_tag_preference.user_id WHERE tag_id=tag.id AND kind='follow' AND community_profile.status<>'deleted' AND community_profile.display_name IS NOT NULL) AS followerCount
    FROM community_tag AS tag JOIN readable_tag ON readable_tag.tag_id=tag.id CROSS JOIN facet_viewer WHERE ${filters.join(" AND ")} ORDER BY tag.normalized_name COLLATE NOCASE,tag.id LIMIT ?`,
    )
      .bind(...values)
      .all<TagRow>()
  ).results;
  const hasMore = rows.length > limit,
    page = rows.slice(0, limit),
    last = page.at(-1);
  const nextCursor =
    hasMore && last
      ? btoa(
          String.fromCharCode(...new TextEncoder().encode(JSON.stringify({ name: last.normalizedName, id: last.id }))),
        )
          .replace(/\+/gu, "-")
          .replace(/\//gu, "_")
          .replace(/=+$/gu, "")
      : null;
  return json(request, {
    tags: await attachTagAliases(env, page),
    groups: await groups(
      env,
      "community_tag_group",
      page.map((tag) => tag.groupId),
    ),
    selection,
    nextCursor,
  });
}

async function saveTag(request: Request, env: Env, actor: Actor, id: string | null): Promise<Response> {
  const result = await readBody(request);
  if (!result.ok) return result.response;
  const value = id ? result.body.tag : result.body;
  if (
    !object(value) ||
    Object.keys(value).length !== 6 ||
    typeof value.normalizedName !== "string" ||
    normalizeForumTag(value.normalizedName) !== value.normalizedName ||
    !text(value.displayName, 32) ||
    (value.description !== null && !text(value.description, 500, true)) ||
    typeof value.status !== "string" ||
    !["active", "hidden"].includes(value.status) ||
    !(value.groupId === null || uuid(value.groupId)) ||
    !Array.isArray(value.aliases) ||
    value.aliases.length > 64 ||
    !value.aliases.every((alias) => typeof alias === "string" && normalizeForumTag(alias) === alias) ||
    (id && (!integer(result.body.expectedVersion) || Object.keys(result.body).length !== 2))
  )
    return error(request, 422, "invalid_tag", "Send valid tag metadata, aliases and current version");
  const previous = id
    ? await env.DB.prepare(`SELECT ${tagColumns} FROM community_tag AS tag WHERE tag.id=?`).bind(id).first<TagRow>()
    : null;
  if (id && !previous) return error(request, 404, "tag_not_found", "Tag not found");
  if (previous?.status === "merged") return error(request, 409, "merged_tag", "Edit the canonical tag");
  if (previous && previous.version !== result.body.expectedVersion)
    return json(
      request,
      {
        error: { code: "version_conflict", message: "The tag changed" },
        tag: (await attachTagAliases(env, [previous]))[0],
      },
      409,
    );
  if (
    value.groupId &&
    !(await env.DB.prepare("SELECT 1 FROM community_tag_group WHERE id=?").bind(value.groupId).first())
  )
    return error(request, 422, "invalid_group", "Tag group not found");
  const targetId = id ?? crypto.randomUUID(),
    auditId = crypto.randomUUID(),
    now = Math.max(Date.now(), (previous?.updatedAt ?? 0) + 1);
  const aliases = [
    ...new Set([
      ...(value.aliases as string[]),
      ...(previous && previous.normalizedName !== value.normalizedName ? [previous.normalizedName] : []),
    ]),
  ];
  if (aliases.length > 64) return error(request, 422, "alias_limit", "Too many aliases");
  const names = [value.normalizedName, ...aliases],
    namesJson = JSON.stringify(names);
  const guard = `NOT EXISTS(SELECT 1 FROM community_tag WHERE normalized_name IN (SELECT value FROM json_each(?)) COLLATE NOCASE AND id<>?)
    AND NOT EXISTS(SELECT 1 FROM community_tag_alias WHERE alias_normalized_name IN (SELECT value FROM json_each(?)) COLLATE NOCASE AND tag_id<>?)
    ${previous ? "AND EXISTS(SELECT 1 FROM community_tag WHERE id=? AND version=?)" : ""}`;
  const guardValues: Value[] = [
    namesJson,
    targetId,
    namesJson,
    targetId,
    ...(previous ? [targetId, previous.version] : []),
  ];
  const audit = auditStatement(
    env,
    actor,
    auditId,
    id ? "tag_edit" : "tag_create",
    targetId,
    previous ?? {},
    { ...value, aliases },
    now,
    guard,
    guardValues,
  );
  const write = previous
    ? env.DB.prepare(
        `UPDATE community_tag SET normalized_name=?,display_name=?,description=?,status=?,group_id=?,version=version+1,updated_at=? WHERE id=? AND version=? AND ${auditExists}`,
      ).bind(
        value.normalizedName as string,
        value.displayName,
        value.description as string | null,
        value.status,
        value.groupId,
        now,
        targetId,
        previous.version,
        auditId,
      )
    : env.DB.prepare(
        `INSERT INTO community_tag(id,normalized_name,display_name,description,status,group_id,version,created_by_user_id,created_at,updated_at) SELECT ?,?,?,?,?,?,1,?,?,? WHERE ${auditExists}`,
      ).bind(
        targetId,
        value.normalizedName as string,
        value.displayName,
        value.description as string | null,
        value.status,
        value.groupId,
        actor.userId,
        now,
        now,
        auditId,
      );
  const saved = await env.DB.batch([
    audit,
    write,
    env.DB.prepare(`DELETE FROM community_tag_alias WHERE tag_id=? AND ${auditExists}`).bind(targetId, auditId),
    env.DB.prepare(
      `INSERT INTO community_tag_alias(alias_normalized_name,tag_id,created_at) SELECT value,?,? FROM json_each(?) WHERE ${auditExists}`,
    ).bind(targetId, now, JSON.stringify(aliases), auditId),
  ]);
  if (!saved[0]?.meta.changes)
    return error(request, 409, "version_or_alias_conflict", "Tag version, name or alias changed");
  const row = await env.DB.prepare(`SELECT ${tagColumns} FROM community_tag AS tag WHERE tag.id=?`)
    .bind(targetId)
    .first<TagRow>();
  if (!row) throw new Error("Saved tag unavailable");
  return json(request, { tag: (await attachTagAliases(env, [row]))[0], auditId }, id ? 200 : 201);
}

async function saveForum(request: Request, env: Env, actor: Actor, id: string | null): Promise<Response> {
  const body = await readBody(request);
  if (!body.ok) return body.response;
  const input = forumInput(id ? body.body.forum : body.body);
  if (!input || (id && (!integer(body.body.expectedVersion) || Object.keys(body.body).length !== 2)))
    return error(request, 422, "invalid_forum", "Send valid forum metadata and its current version");
  const previous = id ? await readForum(env, actor.userId, id) : null;
  if (id && !previous) return error(request, 404, "forum_not_found", "Forum not found");
  if (previous && previous.version !== body.body.expectedVersion)
    return json(
      request,
      { error: { code: "version_conflict", message: "The forum changed" }, forum: forumValue(previous) },
      409,
    );
  if (previous?.defaultPurpose && previous.defaultPurpose !== input.defaultPurpose)
    return error(
      request,
      422,
      "default_purpose_required",
      "Assign the default purpose to another forum before clearing it",
    );
  if (
    input.groupId &&
    !(await env.DB.prepare("SELECT 1 FROM community_forum_group WHERE id = ?").bind(input.groupId).first())
  )
    return error(request, 422, "invalid_group", "Forum group not found");
  const targetId = id ?? crypto.randomUUID(),
    auditId = crypto.randomUUID(),
    now = Math.max(Date.now(), (previous?.updatedAt ?? 0) + 1);
  const safeSlug = `NOT EXISTS (SELECT 1 FROM community_forum WHERE slug = ? AND id <> ?)
    AND NOT EXISTS (SELECT 1 FROM community_forum_slug_alias WHERE slug = ? AND forum_id <> ?)`;
  const guard = previous
    ? `EXISTS (SELECT 1 FROM community_forum WHERE id = ? AND version = ?) AND ${safeSlug}`
    : safeSlug;
  const guardValues: Value[] = previous
    ? [targetId, previous.version, input.slug, targetId, input.slug, targetId]
    : [input.slug, targetId, input.slug, targetId];
  const statements = [
    auditStatement(
      env,
      actor,
      auditId,
      id ? "forum_edit" : "forum_create",
      targetId,
      previous ? forumValue(previous) : {},
      input,
      now,
      guard,
      guardValues,
    ),
  ];
  if (input.defaultPurpose)
    statements.push(
      env.DB.prepare(
        `UPDATE community_forum SET default_purpose = NULL,version = version + 1,updated_at = MAX(updated_at + 1,?) WHERE default_purpose = ? AND id <> ? AND ${auditExists}`,
      ).bind(now, input.defaultPurpose, targetId, auditId),
    );
  if (previous) {
    statements.push(
      env.DB.prepare(
        `UPDATE community_forum SET slug=?,group_id=?,names_json=?,descriptions_json=?,icon=?,sort_order=?,enabled=?,read_permission=?,post_permission=?,reply_permission=?,manage_permission=?,default_purpose=?,version=version+1,updated_at=? WHERE id=? AND version=? AND ${auditExists}`,
      ).bind(...configValues(input), now, targetId, previous.version, auditId),
    );
    if (previous.slug !== input.slug)
      statements.push(
        env.DB.prepare(
          `INSERT INTO community_forum_slug_alias(slug,forum_id,created_at) SELECT ?,?,? WHERE ${auditExists} AND NOT EXISTS(SELECT 1 FROM community_forum_slug_alias WHERE slug=?)`,
        ).bind(previous.slug, targetId, now, auditId, previous.slug),
      );
  } else
    statements.push(
      env.DB.prepare(
        `INSERT INTO community_forum(id,slug,group_id,names_json,descriptions_json,icon,sort_order,enabled,read_permission,post_permission,reply_permission,manage_permission,default_purpose,version,created_at,updated_at) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,? WHERE ${auditExists}`,
      ).bind(targetId, ...configValues(input), now, now, auditId),
    );
  const result = await env.DB.batch(statements);
  if (!result[0]?.meta.changes) return error(request, 409, "version_or_slug_conflict", "Forum version or slug changed");
  const saved = await readForum(env, actor.userId, targetId);
  if (!saved) throw new Error("Saved forum unavailable");
  return json(request, { forum: forumValue(saved), auditId }, id ? 200 : 201);
}

async function movePost(request: Request, env: Env, actor: Actor): Promise<Response> {
  const result = await readBody(request);
  if (!result.ok) return result.response;
  const body = result.body;
  if (
    Object.keys(body).length !== 4 ||
    !uuid(body.postId) ||
    !uuid(body.forumId) ||
    !integer(body.expectedVersion) ||
    !text(body.reasonCode, 80)
  )
    return error(request, 422, "invalid_move", "Send a post, forum, current version and reason code");
  const post = await env.DB.prepare("SELECT id,forum_id AS forumId,version FROM community_post WHERE id = ?")
    .bind(body.postId)
    .first<{ id: string; forumId: string; version: number }>();
  if (!post) return error(request, 404, "post_not_found", "Post not found");
  const manageable = await env.DB.prepare(`SELECT 1 AS allowed
    WHERE ${forumPermissionSql("?", "?", "manage")} AND ${forumPermissionSql("?", "?", "manage")}`)
    .bind(actor.userId, post.forumId, actor.userId, body.forumId).first();
  if (!manageable) return error(request, 403, "forum_manage_required", "Manage access to both forums is required");
  if (post.version !== body.expectedVersion)
    return json(request, { error: { code: "version_conflict", message: "The post changed" }, post }, 409);
  if (post.forumId === body.forumId) return json(request, { post, auditId: null });
  const now = Date.now(),
    auditId = crypto.randomUUID();
  const permitted = `EXISTS(SELECT 1 FROM community_post AS post WHERE post.id=? AND post.version=? AND post.forum_id=?
    AND ${forumPermissionSql("post.forum_id", "?", "manage")} AND ${forumPermissionSql("?", "?", "manage")})`;
  const audit = auditStatement(
    env,
    actor,
    auditId,
    "post_move",
    post.id,
    post,
    { ...post, forumId: body.forumId, version: post.version + 1 },
    now,
    permitted,
    [post.id, post.version, post.forumId, actor.userId, actor.userId, body.forumId],
    post.id,
    body.reasonCode,
    "staff",
  );
  const update = env.DB.prepare(
    `UPDATE community_post SET forum_id=?,version=version+1 WHERE id=? AND version=? AND forum_id=? AND ${auditExists}`,
  ).bind(body.forumId, post.id, post.version, post.forumId, auditId);
  const saved = await env.DB.batch([audit, update]);
  if (!saved[0]?.meta.changes)
    return error(request, 403, "forum_manage_required", "Manage access to both forums is required");
  if (!saved[1]?.meta.changes) throw new Error("Audited post move did not update its post");
  return json(request, { post: { id: post.id, forumId: body.forumId, version: post.version + 1 }, auditId });
}

async function forumAudit(request: Request, env: Env, url: URL): Promise<Response> {
  const allowed = ["postId", "forumId", "limit", "cursor"];
  if (
    [...url.searchParams.keys()].some((key) => !allowed.includes(key)) ||
    allowed.some((key) => url.searchParams.getAll(key).length > 1)
  )
    return error(request, 400, "invalid_query", "Use supported audit filters");
  const postId = url.searchParams.get("postId"),
    forumId = url.searchParams.get("forumId"),
    limit = Number(url.searchParams.get("limit") ?? 50);
  if ((postId !== null && !uuid(postId)) || (forumId !== null && !uuid(forumId)) || !integer(limit, 1, 100))
    return error(request, 400, "invalid_query", "Use valid audit identifiers and limit");
  const where: string[] = [],
    values: Value[] = [];
  if (postId) {
    where.push("audit.post_id=?");
    values.push(postId);
  }
  if (forumId) {
    where.push(
      "(audit.target_id=? OR json_extract(audit.before_json,'$.forumId')=? OR json_extract(audit.after_json,'$.forumId')=?)",
    );
    values.push(forumId, forumId, forumId);
  }
  const raw = url.searchParams.get("cursor");
  if (raw) {
    try {
      const cursor: unknown = JSON.parse(atob(raw.replace(/-/gu, "+").replace(/_/gu, "/")));
      if (!object(cursor) || !uuid(cursor.id) || !integer(cursor.createdAt, 0)) throw new Error();
      where.push("(audit.created_at<? OR (audit.created_at=? AND audit.id<?))");
      values.push(cursor.createdAt, cursor.createdAt, cursor.id);
    } catch {
      return error(request, 400, "invalid_cursor", "Invalid audit cursor");
    }
  }
  values.push(limit + 1);
  const rows = (
    await env.DB.prepare(
      `SELECT audit.id,audit.actor_user_id AS actorUserId,account.name AS actorName,audit.action,audit.target_id AS targetId,audit.post_id AS postId,
    audit.before_json AS beforeJson,audit.after_json AS afterJson,audit.reason_code AS reasonCode,audit.created_at AS createdAt
    FROM community_forum_audit AS audit LEFT JOIN "user" AS account ON account.id=audit.actor_user_id
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY audit.created_at DESC,audit.id DESC LIMIT ?`,
    )
      .bind(...values)
      .all<{
        id: string;
        actorUserId: string;
        actorName: string | null;
        action: string;
        targetId: string;
        postId: string | null;
        beforeJson: string;
        afterJson: string;
        reasonCode: string | null;
        createdAt: number;
      }>()
  ).results;
  const page = rows.slice(0, limit),
    last = page.at(-1);
  return json(request, {
    audit: page.map(({ beforeJson, afterJson, ...row }) => ({
      ...row,
      before: JSON.parse(beforeJson) as unknown,
      after: JSON.parse(afterJson) as unknown,
    })),
    nextCursor:
      rows.length > limit && last
        ? btoa(JSON.stringify({ id: last.id, createdAt: last.createdAt }))
            .replace(/\+/gu, "-")
            .replace(/\//gu, "_")
            .replace(/=+$/gu, "")
        : null,
  });
}

export async function handleCommunityForumsRequest(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url),
    publicPrefix = "/api/v1/community/forums";
  const adminMatch = /^\/api\/v1\/admin\/(forums|forum-groups|tags|tag-groups)(?:\/|$)/u.exec(url.pathname);
  const administrative = adminMatch !== null;
  const domain = adminMatch?.[1] ?? "forums";
  const adminPrefix = `/api/v1/admin/${domain}`;
  const tagFacets = url.pathname === "/api/v1/community/tags" || url.pathname === "/api/v1/community/tag-facets";
  if (!administrative && !tagFacets && url.pathname !== publicPrefix && !url.pathname.startsWith(publicPrefix + "/"))
    return null;
  if (!env.DB) return error(request, 503, "database_unavailable", "Database is not configured");
  if (!sameOrigin(request)) return error(request, 403, "cross_origin_request", "Use the same-origin forum API");
  if (request.method === "OPTIONS")
    return new Response(null, {
      status: 204,
      headers: { Allow: "GET, HEAD, POST, PATCH, OPTIONS", "Cache-Control": "private, no-store", Vary: "Cookie" },
    });
  const method = request.method === "HEAD" ? "GET" : request.method;
  const suffix = url.pathname.slice((administrative ? adminPrefix : publicPrefix).length).replace(/^\/+|\/+$/gu, "");
  const path = suffix ? suffix.split("/") : [];
  if (administrative) {
    const audit = domain === "forums" && path.length === 1 && path[0] === "audit" && method === "GET";
    if (url.searchParams.size && !audit)
      return error(request, 400, "invalid_query", "Forum administration does not accept query parameters");
    const access = await requireActor(request, env, path[0] === "move-post" ? "staff" : "admin");
    if (access instanceof Response) return access;
    if (audit) return forumAudit(request, env, url);
    if (domain === "forum-groups" || domain === "tag-groups") {
      const kind = domain === "forum-groups" ? "forum" : "tag",
        table = kind === "forum" ? "community_forum_group" : "community_tag_group";
      if (!path.length && method === "GET") return json(request, { groups: await groups(env, table) });
      if (!path.length && method === "POST") return saveGroup(request, env, access, kind, null);
      if (path.length === 1 && uuid(path[0]) && method === "PATCH")
        return saveGroup(request, env, access, kind, path[0]);
      return error(request, 405, "method_not_allowed", "Method not allowed");
    }
    if (domain === "tags") {
      if (!path.length && method === "GET") {
        const rows = (
          await env.DB.prepare(
            `SELECT ${tagColumns} FROM community_tag AS tag ORDER BY tag.normalized_name,tag.id`,
          ).all<TagRow>()
        ).results;
        return json(request, {
          tags: await attachTagAliases(env, rows),
          groups: await groups(env, "community_tag_group"),
        });
      }
      if (!path.length && method === "POST") return saveTag(request, env, access, null);
      if (path.length === 1 && uuid(path[0]) && method === "PATCH") return saveTag(request, env, access, path[0]);
      return error(request, 405, "method_not_allowed", "Method not allowed");
    }
    if (!path.length && method === "GET") {
      const rows = await readForums(env, access.userId);
      return json(request, { forums: rows.map(forumValue), groups: await groups(env, "community_forum_group") });
    }
    if (!path.length && method === "POST") return saveForum(request, env, access, null);
    if (path.length === 1 && path[0] === "move-post" && method === "POST") return movePost(request, env, access);
    if (path.length === 1 && uuid(path[0]) && method === "PATCH") return saveForum(request, env, access, path[0]);
    return error(request, 405, "method_not_allowed", "Method not allowed");
  }
  if (method !== "GET") return error(request, 405, "method_not_allowed", "Method not allowed");
  const session = await getAuthSession(request, env, { authoritative: true }),
    userId = session?.user?.id ?? null;
  if (tagFacets) return getTagFacets(request, env, url, userId);
  if (!path.length) {
    const purposes = url.searchParams.getAll("purpose");
    if (
      [...url.searchParams.keys()].some((key) => key !== "purpose") ||
      purposes.length > 1 ||
      (purposes.length && !["general", "stamp"].includes(purposes[0]!))
    )
      return error(request, 400, "invalid_query", "Use a single supported purpose");
    const rows = await readForums(
      env,
      userId,
      purposes.length ? "forum.default_purpose = ?" : "1",
      purposes.length ? [purposes[0]!] : [],
    );
    return json(request, {
      forums: rows.map(forumValue),
      groups: await groups(
        env,
        "community_forum_group",
        rows.map((row) => row.groupId),
      ),
    });
  }
  if (url.searchParams.size)
    return error(request, 400, "invalid_query", "Forum detail does not accept query parameters");
  if (path.length === 1 && uuid(path[0])) {
    const rows = await readForums(env, userId, "forum.id=?", [path[0]]);
    return rows[0]
      ? json(request, { forum: forumValue(rows[0]) })
      : error(request, 404, "forum_not_found", "Forum not found");
  }
  if (path.length === 2 && path[0] === "by-slug" && slug(path[1])) {
    const rows = await readForums(
      env,
      userId,
      "forum.slug=? OR EXISTS(SELECT 1 FROM community_forum_slug_alias WHERE forum_id=forum.id AND slug=?)",
      [path[1], path[1]],
    );
    const row = rows[0];
    return row
      ? json(request, { forum: forumValue(row), canonicalSlug: row.slug, redirected: row.slug !== path[1] })
      : error(request, 404, "forum_not_found", "Forum not found");
  }
  return error(request, 404, "forum_not_found", "Forum not found");
}
