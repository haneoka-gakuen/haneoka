// L3 — GEB
// Input: 社区故事 HTTP、账户、D1、R2 与原生 Altair 工程。
// Output: 私有云草稿、不可变公开版本、运行资源、改编及作者管理。
// Pos: [Map](L2.md)；社区故事版本、发布和访问控制所有者。
// Effects/Dependencies: 认证、限流、D1 CAS、R2 和共用 Vega 编译；公开读取逐次检查作者、讨论及素材审核。
import { getAuthSession } from "./auth";
import { communityAccessState } from "./access";
import { withPrimaryD1 } from "./d1-session";
import { inspectCommunityText } from "./moderation";
import { compileCommunityStory } from "../src/lib/story-creation/project";
import {
  STORY_API,
  STORY_ASSET_API,
  STORY_LIMITS,
  storyFilePath,
  publishableStoryPath,
  storyAssetUrl,
  type StoryCloudManifest,
  type CommunityStoryItem,
  type StorySaveInput,
} from "../src/lib/story-creation/types";
import { mapStoryProjectResources } from "@haneoka/altair-plugin-vega-preview/packaging";
import type { VegaProject } from "@haneoka/vega-protocol";
import {
  storyAssetContent as assetContent,
  reserveStoryAsset,
  putStoryAsset,
  storyAsset,
  storyAssets,
  reconcileStoryAssets,
} from "./community-story-assets";
type Value = Record<string, unknown>;
interface Row {
  id: string;
  ownerId: string;
  ownerName: string;
  ownerUid: number;
  head: number;
  version: number;
  revision: number;
  publishedRevision: number | null;
  publishingRevision: number | null;
  publishError: string | null;
  compilationError: string | null;
  upstreamJson: string | null;
  objectKey: string;
  runtimeKey: string;
  projectId: string;
  title: string;
  summary: string;
  localesJson: string;
  coverPath: string | null;
  visibility: "public" | "unlisted";
  remix: number;
  upstreamId: string | null;
  upstreamRevision: number | null;
  sceneCount: number;
  commandCount: number;
  bytes: number;
  fileCount: number;
  updatedAt: number;
  createdAt: number;
  publishedAt: number | null;
  likeCount: number;
  liked: number;
}
class StorySourceReadError extends Error {}
const expectedErrors = new Set([
  "asset_busy",
  "asset_integrity",
  "authentication_required",
  "community_write_restricted",
  "email_verification_required",
  "file_size",
  "forbidden",
  "identity_changed",
  "invalid_asset",
  "invalid_cover",
  "invalid_file_path",
  "invalid_project",
  "invalid_request",
  "media_missing",
  "media_rejected",
  "method_not_allowed",
  "missing_file",
  "rate_limit_exceeded",
  "remix_unavailable",
  "request_conflict",
  "resource_missing",
  "storage_limit",
  "story_limit",
  "story_missing",
  "version_conflict",
  "visual_upload_required",
]);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const upstreamAttribution = (value: string | null): CommunityStoryItem["upstream"] => {
  if (!value) return null;
  const source = JSON.parse(value);
  return { ...source, available: !!source.available };
};
const columns = `s.id,s.owner_id AS ownerId,p.display_name AS ownerName,i.uid AS ownerUid,s.head,s.version,
 s.published_revision AS publishedRevision,s.publishing_revision AS publishingRevision,s.publish_error AS publishError,
 s.updated_at AS updatedAt,r.revision,r.object_key AS objectKey,r.runtime_key AS runtimeKey,r.project_id AS projectId,r.compile_error AS compilationError,
 r.title,r.summary,r.locales_json AS localesJson,r.cover_path AS coverPath,r.visibility,r.remix,
 COALESCE(o.source_story_id,r.upstream_id) AS upstreamId,COALESCE(o.source_revision,g.source_revision) AS upstreamRevision,
 CASE WHEN o.story_id IS NOT NULL OR g.source_story_id IS NOT NULL THEN json_object(
 'title',COALESCE(o.source_title,g.source_title),'revision',COALESCE(o.source_revision,g.source_revision),
 'ownerName',COALESCE(o.source_owner_name,g.source_owner_name),'ownerUid',COALESCE(o.source_owner_uid,g.source_owner_uid),
 'available',EXISTS(SELECT 1 FROM community_story original JOIN community_profile op ON op.user_id=original.owner_id
 WHERE original.id=COALESCE(o.source_story_id,r.upstream_id) AND original.published_revision IS NOT NULL AND original.deleted_at IS NULL AND op.status='active' AND op.deleted_at IS NULL)) ELSE NULL END AS upstreamJson,
 r.scene_count AS sceneCount,r.command_count AS commandCount,r.byte_size AS bytes,r.file_count AS fileCount,
 r.created_at AS createdAt,r.published_at AS publishedAt,
 (SELECT count(*) FROM community_story_like l WHERE l.story_id=s.id) AS likeCount,
 EXISTS(SELECT 1 FROM community_story_like l WHERE l.story_id=s.id AND l.user_id=?1) AS liked`;
const joined = `FROM community_story s JOIN community_story_revision r ON r.story_id=s.id
 JOIN community_profile p ON p.user_id=s.owner_id JOIN community_identity i ON i.user_id=s.owner_id
 LEFT JOIN community_story_revision_origin o ON o.story_id=r.story_id AND o.revision=r.revision
 LEFT JOIN community_story_remix_grant g ON g.owner_id=s.owner_id AND g.source_story_id=r.upstream_id`;
const publicAccess = `s.published_revision IS NOT NULL AND r.published_at IS NOT NULL AND p.status='active' AND p.deleted_at IS NULL AND s.deleted_at IS NULL AND r.deleted_at IS NULL
 AND NOT EXISTS(SELECT 1 FROM community_entity_thread et JOIN community_post post ON post.id=et.post_id
 WHERE et.entity_type='community-stories' AND et.original_id=s.id AND
 (post.status<>'published' OR post.moderation_status<>'allow' OR post.deleted_at IS NOT NULL OR post.archived_at IS NOT NULL))
 AND NOT EXISTS(SELECT 1 FROM community_story_revision_asset ra JOIN community_story_asset a ON a.id=ra.asset_id
 JOIN community_story_blob b ON b.hash=a.blob_hash WHERE ra.story_id=s.id AND ra.revision=r.revision AND ra.is_public=1
 AND (a.state<>'ready' OR b.state<>'active' OR b.moderation_status<>'allow'
 OR (a.attachment_id IS NOT NULL AND EXISTS(SELECT 1 FROM community_attachment att WHERE att.id=a.attachment_id AND att.deleted_at IS NULL AND att.moderation_status<>'allow'))))`;
const response = (request: Request, value: unknown, status = 200) =>
  new Response(request.method === "HEAD" ? null : JSON.stringify(value), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
const digest = async (value: string) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))]
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");
async function body(request: Request, maxBytes = 4 * 1024 ** 2): Promise<Value> {
  if (!request.body || !request.headers.get("Content-Type")?.startsWith("application/json"))
    throw new Error("invalid_request");
  const reader = request.body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.length;
    if (size > maxBytes) {
      await reader.cancel();
      throw new Error("file_size");
    }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    throw new Error("invalid_request");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_request");
  return value as Value;
}

async function viewer(request: Request, env: Env) {
  return (await getAuthSession(request, env, { authoritative: true }))?.user ?? null;
}
async function writer(request: Request, env: Env, mode: "story" | "asset" = "story") {
  if (
    request.headers.get("Sec-Fetch-Site") === "cross-site" ||
    (request.headers.get("Origin") && request.headers.get("Origin") !== new URL(request.url).origin)
  )
    throw new Error("forbidden");
  const user = await viewer(request, env);
  if (!user) throw new Error("authentication_required");
  const actor = request.headers.get("X-Haneoka-Actor");
  if (actor !== null && actor !== user.id) throw new Error("identity_changed");
  if (!user.emailVerified) throw new Error("email_verification_required");
  const access = await communityAccessState(
    env,
    user.id,
    mode === "asset" ? ["sign_in", "write", "upload"] : ["sign_in", "write"],
  );
  if (access?.status !== "active" || access.restriction) throw new Error("community_write_restricted");
  if (
    mode === "story" &&
    env.COMMUNITY_RATE_LIMITER &&
    !(await env.COMMUNITY_RATE_LIMITER.limit({ key: user.id })).success
  )
    throw new Error("rate_limit_exceeded");
  return user;
}
const item = (r: Row, owner = ""): CommunityStoryItem => ({
  id: r.id,
  projectId: r.projectId,
  title: r.title,
  summary: r.summary,
  ownerId: r.ownerId === owner ? r.ownerId : "",
  ownerName: r.ownerName || `#${r.ownerUid}`,
  ownerUid: r.ownerUid,
  version: r.ownerId === owner ? r.version : r.revision,
  revision: r.revision,
  publishedRevision: r.publishedRevision,
  publishingRevision: r.ownerId === owner ? r.publishingRevision : null,
  publishError: r.ownerId === owner ? r.publishError : null,
  publishedAt: r.publishedAt,
  updatedAt: r.ownerId === owner ? r.updatedAt : (r.publishedAt ?? r.createdAt),
  locales: JSON.parse(r.localesJson),
  coverPath: r.coverPath,
  coverUrl: r.coverPath ? storyAssetUrl(r.id, r.revision, r.coverPath) : "",
  visibility: r.visibility,
  remix: !!r.remix,
  upstreamId: r.upstreamId,
  upstreamRevision: r.upstreamRevision,
  upstream: upstreamAttribution(r.upstreamJson),
  sceneCount: r.sceneCount,
  commandCount: r.commandCount,
  bytes: r.bytes,
  fileCount: r.fileCount,
  canEdit: r.ownerId === owner,
  compilationError: r.compilationError,
  likeCount: r.likeCount,
  liked: !!r.liked,
});
async function find(env: Env, id: string, owner = "", draft = false, revision?: number): Promise<Row | null> {
  return env.DB.prepare(
    `SELECT ${columns} ${joined} WHERE s.id=?2 AND s.deleted_at IS NULL AND r.deleted_at IS NULL
 AND r.revision=${revision ? "?3" : draft ? "CASE WHEN s.owner_id=?1 THEN s.head ELSE s.published_revision END" : "s.published_revision"}
 AND (s.owner_id=?1 OR (${publicAccess}))`,
  )
    .bind(owner, id, ...(revision ? [revision] : []))
    .first<Row>();
}
async function manifest(env: Env, row: Row) {
  const object = await env.COMMUNITY_UPLOADS.get(row.objectKey);
  if (!object) throw new Error("story_missing");
  return object.json<StoryCloudManifest>();
}
async function runtime(env: Env, row: Row) {
  const object = await env.COMMUNITY_UPLOADS.get(row.runtimeKey);
  if (!object) throw new Error("story_missing");
  return object.json<{
    error: string | null;
    diagnostics: { source: string; reason: string }[];
    project: VegaProject | null;
    resources: string[];
    issues: { source: string; reason: string }[];
  }>();
}
function saveInput(value: Value): StorySaveInput {
  if (
    typeof value.projectId !== "string" ||
    !value.projectId ||
    value.projectId.length > 512 ||
    typeof value.title !== "string" ||
    !value.title.trim() ||
    value.title.trim().length > 120 ||
    typeof value.summary !== "string" ||
    value.summary.length > 2000 ||
    !uuid.test(String(value.requestId)) ||
    !Number.isSafeInteger(value.version) ||
    Number(value.version) < 0 ||
    !Array.isArray(value.files) ||
    !value.files.length ||
    value.files.length > STORY_LIMITS.files ||
    !["public", "unlisted"].includes(String(value.visibility)) ||
    typeof value.remix !== "boolean" ||
    !Array.isArray(value.directories) ||
    value.files.length + value.directories.length > STORY_LIMITS.files
  )
    throw new Error("invalid_project");
  const files = value.files.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_project");
    const file = value as Value;
    if (typeof file.path !== "string" || typeof file.assetId !== "string") throw new Error("invalid_project");
    const path = storyFilePath(file.path);
    if (!publishableStoryPath(path) || !uuid.test(file.assetId)) throw new Error("invalid_project");
    return { path, assetId: file.assetId };
  });
  if (new Set(files.map((f) => f.path)).size !== files.length) throw new Error("invalid_file_path");
  const directories = value.directories.map((path) => {
    if (typeof path !== "string") throw new Error("invalid_file_path");
    const directory = storyFilePath(path);
    if (!publishableStoryPath(directory)) throw new Error("invalid_file_path");
    return directory;
  });
  const paths = new Set(files.map((file) => file.path));
  if (new Set(directories).size !== directories.length || directories.some((path) => paths.has(path)))
    throw new Error("invalid_file_path");
  for (const path of [...paths, ...directories]) {
    const parts = path.split("/");
    while (parts.length > 1) {
      parts.pop();
      if (paths.has(parts.join("/"))) throw new Error("invalid_file_path");
    }
  }
  const coverPath = value.coverPath === null ? null : storyFilePath(String(value.coverPath || ""));
  if (coverPath && !files.some((f) => f.path === coverPath)) throw new Error("invalid_cover");
  const upstreamId = value.upstreamId ? String(value.upstreamId) : null;
  if (upstreamId && !uuid.test(upstreamId)) throw new Error("invalid_project");
  const upstreamRevision = value.upstreamRevision == null ? null : value.upstreamRevision;
  if (
    upstreamRevision !== null &&
    (!upstreamId || !Number.isSafeInteger(upstreamRevision) || Number(upstreamRevision) <= 0)
  )
    throw new Error("invalid_project");
  return {
    projectId: value.projectId,
    title: value.title.trim(),
    summary: value.summary,
    requestId: String(value.requestId),
    version: Number(value.version),
    files,
    directories,
    coverPath,
    visibility: value.visibility as "public" | "unlisted",
    remix: value.remix,
    upstreamId,
    ...(upstreamRevision === null ? {} : { upstreamRevision: upstreamRevision as number }),
  };
}
async function save(request: Request, env: Env, id: string, owner: string, value: Value) {
  const input = saveInput(value),
    payloadHash = await digest(JSON.stringify(input));
  const previous = await env.DB.prepare(
    `SELECT revision,write_version AS version,payload_hash AS hash FROM community_story_revision
 WHERE story_id=? AND request_id=? AND EXISTS(SELECT 1 FROM community_story WHERE id=? AND owner_id=? AND deleted_at IS NULL)`,
  )
    .bind(id, input.requestId, id, owner)
    .first<{ revision: number; version: number; hash: string }>();
  if (previous) {
    if (previous.hash !== payloadHash) throw new Error("request_conflict");
    return response(request, {
      story: item((await find(env, id, owner, true))!, owner),
      savedVersion: previous.version,
      savedRevision: previous.revision,
    });
  }
  const old = await env.DB.prepare(
    "SELECT owner_id AS ownerId,version,head,deleted_at AS deletedAt FROM community_story WHERE id=?",
  )
    .bind(id)
    .first<{ ownerId: string; version: number; head: number; deletedAt: number | null }>();
  if (old && (old.ownerId !== owner || old.deletedAt !== null)) throw new Error("story_missing");
  if ((old?.version ?? 0) !== input.version) throw new Error("version_conflict");
  if (!old) {
    const count = await env.DB.prepare(
      "SELECT count(*) AS n FROM community_story WHERE owner_id=? AND deleted_at IS NULL",
    )
      .bind(owner)
      .first<{ n: number }>();
    if ((count?.n ?? 0) >= STORY_LIMITS.stories) throw new Error("story_limit");
  }
  const origin = input.upstreamId
    ? await env.DB.prepare(
        `SELECT source_story_id AS sourceId,source_revision AS revision,source_title AS title,
        source_owner_uid AS ownerUid,source_owner_name AS ownerName FROM community_story_remix_revision_grant
        WHERE owner_id=?1 AND source_story_id=?2 AND source_revision=COALESCE(?3,
          (SELECT source_revision FROM community_story_remix_grant WHERE owner_id=?1 AND source_story_id=?2))`,
      )
        .bind(owner, input.upstreamId, input.upstreamRevision ?? null)
        .first<{ sourceId: string; revision: number; title: string; ownerUid: number; ownerName: string }>()
    : null;
  if (input.upstreamId && !origin) throw new Error("remix_unavailable");
  const assets = await storyAssets(
      env,
      input.files.map((f) => f.assetId),
      owner,
    ),
    byId = new Map(assets.map((a) => [a.id, a]));
  if (
    byId.size !== new Set(input.files.map((f) => f.assetId)).size ||
    assets.some((a) => a.state === "reserved" || a.blobState !== "active")
  )
    throw new Error("media_missing");
  const bytes = input.files.reduce((n, f) => n + byId.get(f.assetId)!.bytes, 0);
  if (bytes > STORY_LIMITS.projectBytes) throw new Error("file_size");
  const files = input.files.map((f) => {
    const a = byId.get(f.assetId)!;
    return { ...f, hash: a.hash, bytes: a.bytes, mediaType: a.mediaType };
  });
  let compiled;
  try {
    compiled = await compileCommunityStory(
      files.map((f) => ({
        path: f.path,
        blob: {
          size: f.bytes,
          text: async () => {
            if (f.bytes > STORY_LIMITS.binaryBytes) throw new Error(`file_size:${f.path}`);
            let object;
            try {
              object = await env.COMMUNITY_UPLOADS.get(byId.get(f.assetId)!.objectKey);
            } catch (cause) {
              throw new StorySourceReadError("Story source read failed", { cause });
            }
            if (!object) throw new StorySourceReadError("Story source object is missing");
            try {
              return await object.text();
            } catch (cause) {
              throw new StorySourceReadError("Story source read failed", { cause });
            }
          },
        },
      })),
    );
  } catch (error) {
    if (error instanceof StorySourceReadError) throw error;
    compiled = {
      projectId: input.projectId,
      locales: [],
      sceneCount: 0,
      commandCount: 0,
      project: null,
      resources: [],
      issues: [],
      error: "invalid_project",
      diagnostics: [],
    };
  }
  const revision = (old?.head ?? 0) + 1,
    version = input.version + 1,
    now = Date.now(),
    token = crypto.randomUUID();
  const objectKey = `community/stories/${id}/${revision}/${token}/source.json`,
    runtimeKey = `community/stories/${id}/${revision}/${token}/runtime.json`;
  const cloud: StoryCloudManifest = {
    projectId: compiled.projectId,
    title: input.title,
    files,
    directories: input.directories,
  };
  await env.DB.batch([
    env.DB.prepare("INSERT INTO community_story_gc(object_key,created_at) VALUES(?,?)").bind(objectKey, now),
    env.DB.prepare("INSERT INTO community_story_gc(object_key,created_at) VALUES(?,?)").bind(runtimeKey, now),
  ]);
  await Promise.all([
    env.COMMUNITY_UPLOADS.put(objectKey, JSON.stringify(cloud)),
    env.COMMUNITY_UPLOADS.put(
      runtimeKey,
      JSON.stringify({
        project: compiled.project ? { ...compiled.project, title: input.title } : null,
        resources: compiled.resources,
        issues: compiled.issues,
        error: compiled.error,
        diagnostics: compiled.diagnostics,
      }),
    ),
  ]);
  const revisionFields = {
    story_id: id,
    revision,
    request_id: input.requestId,
    payload_hash: payloadHash,
    write_version: version,
    object_key: objectKey,
    runtime_key: runtimeKey,
    project_id: compiled.projectId,
    compile_error: compiled.error,
    title: input.title,
    summary: input.summary,
    locales_json: JSON.stringify(compiled.locales),
    cover_path: input.coverPath,
    visibility: input.visibility,
    remix: input.remix ? 1 : 0,
    // Origin snapshots outlive the source story's foreign-key lifetime.
    upstream_id: null,
    scene_count: compiled.sceneCount,
    command_count: compiled.commandCount,
    byte_size: bytes,
    file_count: files.length,
    created_at: now,
  };
  const revisionColumns = Object.keys(revisionFields);
  const insertRevision = env.DB.prepare(
    `INSERT OR IGNORE INTO community_story_revision(${revisionColumns.join(",")}) SELECT ${revisionColumns.map(() => "?").join(",")}
  WHERE EXISTS(SELECT 1 FROM community_story WHERE id=? AND owner_id=? AND version=? AND deleted_at IS NULL)`,
  ).bind(...Object.values(revisionFields), id, owner, input.version);
  const runtimePaths = new Set(compiled.resources);
  const publicAssets = files
    .filter((file) => input.remix || file.path === input.coverPath || runtimePaths.has(file.path))
    .map((file) => file.assetId);
  const result = await env.DB.batch([
    env.DB.prepare(
      "INSERT OR IGNORE INTO community_story(id,owner_id,created_at,updated_at) SELECT ?,?,?,? WHERE (SELECT count(*) FROM community_story WHERE owner_id=? AND deleted_at IS NULL)<?",
    ).bind(id, owner, now, now, owner, STORY_LIMITS.stories),
    insertRevision,
    ...(origin
      ? [
          env.DB.prepare(
            `INSERT OR IGNORE INTO community_story_revision_origin(story_id,revision,source_story_id,source_revision,source_title,source_owner_uid,source_owner_name)
      SELECT ?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM community_story_revision WHERE story_id=? AND revision=? AND object_key=?)`,
          ).bind(
            id,
            revision,
            origin.sourceId,
            origin.revision,
            origin.title,
            origin.ownerUid,
            origin.ownerName,
            id,
            revision,
            objectKey,
          ),
        ]
      : []),
    env.DB.prepare(
      `INSERT INTO community_story_revision_asset(story_id,revision,asset_id,is_public) SELECT ?,?,value,CASE WHEN value IN(SELECT value FROM json_each(?)) THEN 1 ELSE 0 END FROM json_each(?) WHERE EXISTS(SELECT 1 FROM community_story_revision WHERE story_id=? AND revision=? AND object_key=?)`,
    ).bind(id, revision, JSON.stringify(publicAssets), JSON.stringify([...byId.keys()]), id, revision, objectKey),
    env.DB.prepare(
      `UPDATE community_story SET head=?,version=version+1,updated_at=? WHERE id=? AND owner_id=? AND version=? AND EXISTS(SELECT 1 FROM community_story_revision WHERE story_id=? AND revision=? AND object_key=?)`,
    ).bind(revision, now, id, owner, input.version, id, revision, objectKey),
    env.DB.prepare(
      "DELETE FROM community_story_gc WHERE object_key IN (?,?) AND EXISTS(SELECT 1 FROM community_story_revision WHERE object_key=?)",
    ).bind(objectKey, runtimeKey, objectKey),
  ]);
  if (!result.at(-2)?.meta.changes) {
    const receipt = await env.DB.prepare(
      "SELECT revision,write_version AS version,payload_hash AS hash FROM community_story_revision WHERE story_id=? AND request_id=?",
    )
      .bind(id, input.requestId)
      .first<{ revision: number; version: number; hash: string }>();
    if (!receipt) throw new Error("version_conflict");
    if (receipt.hash !== payloadHash) throw new Error("request_conflict");
    return response(request, {
      story: item((await find(env, id, owner, true))!, owner),
      savedVersion: receipt.version,
      savedRevision: receipt.revision,
    });
  }
  return response(request, {
    story: item((await find(env, id, owner, true))!, owner),
    savedVersion: version,
    savedRevision: revision,
  });
}
interface ActionRow {
  kind: string;
  hash: string;
  version: number;
  revision: number;
}
async function actionReceipt(request: Request, env: Env, id: string, owner: string, receipt: ActionRow) {
  const current = await find(env, id, owner, true);
  return response(request, {
    story: current ? item(current, owner) : null,
    appliedVersion: receipt.version,
    appliedRevision: receipt.revision,
    deleted: receipt.kind === "delete",
  });
}
async function previousAction(
  env: Env,
  id: string,
  owner: string,
  value: Value,
  kind: string,
): Promise<ActionRow | null> {
  if (!uuid.test(String(value.requestId))) throw new Error("invalid_request");
  const receipt = await env.DB.prepare(
    `SELECT a.kind,a.payload_hash AS hash,a.applied_version AS version,a.revision FROM community_story_action a
  JOIN community_story s ON s.id=a.story_id WHERE a.story_id=? AND a.request_id=? AND s.owner_id=?`,
  )
    .bind(id, String(value.requestId), owner)
    .first<ActionRow>();
  if (
    receipt &&
    (receipt.kind !== kind || receipt.hash !== (await digest(JSON.stringify({ kind, version: value.version }))))
  )
    throw new Error("request_conflict");
  return receipt;
}
async function mutateStory(
  request: Request,
  env: Env,
  row: Row,
  owner: string,
  value: Value,
  kind: "publish" | "unpublish" | "delete",
) {
  if (!Number.isSafeInteger(value.version) || value.version !== row.version) throw new Error("version_conflict");
  const hash = await digest(JSON.stringify({ kind, version: value.version })),
    version = Number(value.version) + 1,
    revision = row.head,
    now = Date.now(),
    requestId = String(value.requestId);
  const claim = env.DB.prepare(
    `INSERT INTO community_story_action(story_id,request_id,kind,payload_hash,applied_version,revision,created_at)
  SELECT ?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM community_story WHERE id=? AND owner_id=? AND version=? AND deleted_at IS NULL)`,
  ).bind(row.id, requestId, kind, hash, version, revision, now, row.id, owner, value.version as number);
  const guard = `id=? AND owner_id=? AND version=? AND deleted_at IS NULL AND EXISTS(SELECT 1 FROM community_story_action WHERE story_id=? AND request_id=? AND payload_hash=?)`;
  const guardValues = [row.id, owner, Number(value.version), row.id, requestId, hash] as const;
  const statements = [claim];
  if (kind === "delete") {
    statements.push(
      env.DB.prepare(
        `UPDATE community_story SET deleted_at=?,published_revision=NULL,publishing_revision=NULL,publish_token=NULL,version=version+1 WHERE ${guard}`,
      ).bind(now, ...guardValues),
    );
  } else if (kind === "unpublish")
    statements.push(
      env.DB.prepare(
        `UPDATE community_story SET published_revision=NULL,publishing_revision=NULL,publish_token=NULL,publish_error=NULL,version=version+1,updated_at=? WHERE ${guard}`,
      ).bind(now, ...guardValues),
    );
  else {
    const plan = await runtime(env, row);
    if (plan.error || !plan.project)
      return response(
        request,
        { error: { code: plan.error || "invalid_project", diagnostics: plan.diagnostics } },
        422,
      );
    if (row.coverPath) {
      const cloud = await manifest(env, row),
        file = cloud.files.find((file) => file.path === row.coverPath),
        asset = file ? await storyAsset(env, file.assetId, owner) : null;
      if (asset?.kind !== "image" || asset.bytes === 0) throw new Error("invalid_cover");
    }
    if (plan.issues.length)
      return response(request, { error: { code: "resource_missing", resources: plan.issues } }, 422);
    statements.push(
      env.DB.prepare(
        `UPDATE community_story SET publishing_revision=head,publish_token=?,publish_error=NULL,version=version+1,updated_at=? WHERE ${guard}`,
      ).bind(requestId, now, ...guardValues),
    );
  }
  const result = await env.DB.batch(statements);
  if (!result.at(-1)?.meta.changes) {
    const receipt = await previousAction(env, row.id, owner, value, kind);
    if (receipt) return await actionReceipt(request, env, row.id, owner, receipt);
    throw new Error("version_conflict");
  }
  if (kind === "publish") {
    await reconcileStoryAssets(env);
    await finalize(env, row.id);
  }
  return await actionReceipt(request, env, row.id, owner, { kind, hash, version, revision });
}
async function finalize(env: Env, id: string): Promise<void> {
  const intent = await env.DB.prepare(
    "SELECT publishing_revision AS revision,publish_token AS token,owner_id AS ownerId FROM community_story WHERE id=? AND deleted_at IS NULL AND publishing_revision IS NOT NULL",
  )
    .bind(id)
    .first<{ revision: number; token: string; ownerId: string }>();
  if (!intent) return;
  const row = await find(env, id, intent.ownerId, true, intent.revision);
  if (!row) return;
  const unavailable = await env.DB.prepare(
    `SELECT a.state,b.moderation_status AS moderation FROM community_story_revision_asset ra JOIN community_story_asset a ON a.id=ra.asset_id JOIN community_story_blob b ON b.hash=a.blob_hash
 WHERE ra.story_id=? AND ra.revision=? AND ra.is_public=1 AND (a.state<>'ready' OR b.state<>'active' OR b.moderation_status<>'allow')`,
  )
    .bind(id, intent.revision)
    .all<{ state: string; moderation: string }>();
  if (unavailable.results.length) {
    if (unavailable.results.some((a) => a.state === "rejected" || a.moderation === "block"))
      await env.DB.prepare(
        "UPDATE community_story SET publishing_revision=NULL,publish_token=NULL,publish_error='media_rejected' WHERE id=? AND publish_token=?",
      )
        .bind(id, intent.token)
        .run();
    return;
  }
  const data = await runtime(env, row);
  if (data.issues.length) throw new Error("resource_missing");
  if (inspectCommunityText(JSON.stringify([row.title, row.summary, data.project])).verdict !== "allow") {
    await env.DB.prepare(
      "UPDATE community_story SET publishing_revision=NULL,publish_token=NULL,publish_error='text_blocked' WHERE id=? AND publish_token=?",
    )
      .bind(id, intent.token)
      .run();
    return;
  }
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE community_story_revision SET published_at=COALESCE(published_at,?) WHERE story_id=? AND revision=? AND EXISTS(SELECT 1 FROM community_story WHERE id=? AND publish_token=? AND publishing_revision=? AND deleted_at IS NULL)",
    ).bind(now, id, intent.revision, id, intent.token, intent.revision),
    env.DB.prepare(
      "UPDATE community_story SET published_revision=?,publishing_revision=NULL,publish_token=NULL,publish_error=NULL WHERE id=? AND publish_token=? AND publishing_revision=? AND deleted_at IS NULL",
    ).bind(intent.revision, id, intent.token, intent.revision),
  ]);
}
export async function publishedCommunityStory(env: Env, id: string) {
  const row = await find(env, id);
  return row ? item(row) : null;
}

/** Called only after the admin router authoritatively checks staff access. */
export async function readCommunityStoryForAdmin(
  request: Request, env: Env, id: string, revision: number, path?: string,
): Promise<Response> {
  const row = await env.DB.prepare(`SELECT ${columns} ${joined} WHERE s.id=?2 AND r.revision=?3`)
    .bind("", id, revision).first<Row>();
  if (!row) return response(request, { error: { code: "story_missing" } }, 404);
  try {
    if (path !== undefined) {
      const file = (await manifest(env, row)).files.find((file) => file.path === storyFilePath(path));
      const asset = file ? await storyAsset(env, file.assetId) : null;
      if (!asset || asset.blobState !== "active") return response(request, { error: { code: "media_missing" } }, 404);
      return await assetContent(request, env, asset);
    }
    const data = await runtime(env, row);
    if (data.error || !data.project) return response(request, { error: { code: data.error || "invalid_project" }, diagnostics: data.diagnostics }, 422);
    const allowed = new Set(data.resources);
    const base = `/api/v1/admin/stories/${id}/assets/${revision}/`;
    return response(request, { project: mapStoryProjectResources(data.project, (source) => {
      const path = source.replace(/^\.\//u, "");
      return allowed.has(path) ? base + path.split("/").map(encodeURIComponent).join("/") : source;
    }, base) });
  } catch (error) {
    if (error instanceof Error && ["story_missing", "media_missing"].includes(error.message))
      return response(request, { error: { code: error.message } }, 404);
    throw error;
  }
}
export async function reconcileCommunityStories(env: Env): Promise<void> {
  const { scheduleStoryResourceChecks } = await import("./community-story-moderation");
  await scheduleStoryResourceChecks(env);
  await reconcileStoryAssets(env);
  const rows = await env.DB.prepare(
    "SELECT id FROM community_story WHERE publishing_revision IS NOT NULL AND deleted_at IS NULL ORDER BY updated_at LIMIT 30",
  ).all<{ id: string }>();
  for (const row of rows.results) await finalize(env, row.id);
}
export async function cleanupCommunityStories(env: Env): Promise<void> {
  await reconcileCommunityStories(env);
  const cutoff = Date.now() - 7 * 86400000;
  const removedOwners = await env.DB.prepare(
    `SELECT s.id,s.deleted_at AS deletedAt FROM community_story s JOIN community_profile p ON p.user_id=s.owner_id
    WHERE p.status='deleted' OR p.deleted_at IS NOT NULL OR s.deleted_at<? ORDER BY s.id LIMIT 30`,
  ).bind(cutoff).all<{ id: string; deletedAt: number | null }>();
  for (const row of removedOwners.results)
    await env.DB.batch([
      env.DB.prepare(
        "INSERT OR IGNORE INTO community_story_gc(object_key,created_at) SELECT object_key,? FROM community_story_revision WHERE story_id=?",
      ).bind(row.deletedAt ?? Date.now(), row.id),
      env.DB.prepare(
        "INSERT OR IGNORE INTO community_story_gc(object_key,created_at) SELECT runtime_key,? FROM community_story_revision WHERE story_id=?",
      ).bind(row.deletedAt ?? Date.now(), row.id),
      env.DB.prepare("DELETE FROM community_story WHERE id=?").bind(row.id),
    ]);
  const garbage = await env.DB.prepare(
    "SELECT object_key AS objectKey FROM community_story_gc WHERE created_at<? LIMIT 100",
  )
    .bind(cutoff)
    .all<{ objectKey: string }>();
  for (const row of garbage.results) {
    await env.COMMUNITY_UPLOADS.delete(row.objectKey);
    await env.DB.prepare("DELETE FROM community_story_gc WHERE object_key=?").bind(row.objectKey).run();
  }
  await env.DB.prepare(
    "DELETE FROM community_story_asset WHERE updated_at<? AND NOT EXISTS(SELECT 1 FROM community_story_revision_asset ra WHERE ra.asset_id=community_story_asset.id)",
  )
    .bind(cutoff)
    .run();
  const blobs = await env.DB.prepare(
    `UPDATE community_story_blob SET state='deleting' WHERE hash IN(SELECT hash FROM community_story_blob WHERE updated_at<? AND NOT EXISTS(SELECT 1 FROM community_story_asset a WHERE a.blob_hash=community_story_blob.hash) ORDER BY updated_at,hash LIMIT 100) RETURNING hash,object_key AS objectKey`,
  )
    .bind(cutoff)
    .all<{ hash: string; objectKey: string }>();
  for (const blob of blobs.results) {
    await env.COMMUNITY_UPLOADS.delete(blob.objectKey);
    await env.DB.prepare(
      "DELETE FROM community_story_blob WHERE hash=? AND state='deleting' AND NOT EXISTS(SELECT 1 FROM community_story_asset WHERE blob_hash=?)",
    )
      .bind(blob.hash, blob.hash)
      .run();
  }
}
export async function handleCommunityStoryRequest(
  request: Request,
  originalEnv: Env,
  resolvePublic?: (source: string) => Promise<Response | null>,
): Promise<Response | null> {
  const url = new URL(request.url),
    isAssets = url.pathname === STORY_ASSET_API || url.pathname.startsWith(`${STORY_ASSET_API}/`);
  if (!isAssets && url.pathname !== STORY_API && !url.pathname.startsWith(`${STORY_API}/`)) return null;
  return withPrimaryD1(originalEnv, async (env) => {
    try {
      const parts = url.pathname
          .slice((isAssets ? STORY_ASSET_API : STORY_API).length)
          .split("/")
          .filter(Boolean),
        id = parts[0];
      if (id && !(isAssets && id === "lookup") && !uuid.test(id)) throw new Error("story_missing");
      if (isAssets && id && parts[1] === "content" && ["GET", "HEAD"].includes(request.method)) {
        const user = await viewer(request, env);
        if (!user) throw new Error("authentication_required");
        const access = await communityAccessState(env, user.id, ["sign_in"]);
        if (access?.status !== "active" || access.restriction) throw new Error("forbidden");
        const asset = await storyAsset(env, id, user.id);
        if (!asset) throw new Error("media_missing");
        await env.DB.prepare("UPDATE community_story_asset SET updated_at=? WHERE id=?").bind(Date.now(), id).run();
        return await assetContent(request, env, asset);
      }
      if (isAssets) {
        const user = await writer(request, env, "asset");
        if (id === "lookup" && request.method === "POST") {
          if (
            env.COMMUNITY_RATE_LIMITER &&
            !(await env.COMMUNITY_RATE_LIMITER.limit({ key: `story-lookup:${user.id}` })).success
          )
            throw new Error("rate_limit_exceeded");
          const value = await body(request);
          if (
            !Array.isArray(value.hashes) ||
            value.hashes.length > 1024 ||
            value.hashes.some((hash) => typeof hash !== "string" || !/^[a-f0-9]{64}$/u.test(hash))
          )
            throw new Error("invalid_asset");
          const rows = await env.DB.prepare(
            `SELECT a.id,a.blob_hash AS hash,b.byte_size AS bytes,a.media_type AS mediaType,a.state,b.moderation_status AS moderation
    FROM community_story_asset a JOIN community_story_blob b ON b.hash=a.blob_hash WHERE a.owner_id=? AND a.blob_hash IN(SELECT value FROM json_each(?)) AND b.state='active' AND a.state IN('ready','processing','rejected')`,
          )
            .bind(user.id, JSON.stringify(value.hashes))
            .all<{ id: string; hash: string; bytes: number; mediaType: string; state: string; moderation: string }>();
          await env.DB.prepare(
            "UPDATE community_story_asset SET updated_at=? WHERE owner_id=? AND blob_hash IN(SELECT value FROM json_each(?))",
          )
            .bind(Date.now(), user.id, JSON.stringify(value.hashes))
            .run();
          return response(request, {
            assets: rows.results.map((row) => ({
              id: row.id,
              hash: row.hash,
              bytes: row.bytes,
              mediaType: row.mediaType,
              state:
                row.state === "rejected" || row.moderation === "block"
                  ? "rejected"
                  : row.state === "ready" && row.moderation === "allow"
                    ? "ready"
                    : "processing",
            })),
          });
        }

        if (!id && request.method === "POST") {
          if (
            env.COMMUNITY_RATE_LIMITER &&
            !(await env.COMMUNITY_RATE_LIMITER.limit({ key: `story-assets:${user.id}` })).success
          )
            throw new Error("rate_limit_exceeded");
          const value = await body(request);
          if (Array.isArray(value.assets)) {
            if (
              !value.assets.length ||
              value.assets.length > 64 ||
              value.assets.some((entry) => !entry || typeof entry !== "object" || Array.isArray(entry))
            )
              throw new Error("invalid_asset");
            const assets = [];
            for (const input of value.assets)
              assets.push(await reserveStoryAsset(env, user.id, input as Value, resolvePublic));
            return response(request, { assets });
          }
          return response(request, await reserveStoryAsset(env, user.id, value, resolvePublic));
        }
        if (id) {
          const asset = await storyAsset(env, id, user.id);
          if (!asset) throw new Error("media_missing");
          if (parts[1] === "content" && request.method === "PUT") {
            if (
              env.COMMUNITY_RATE_LIMITER &&
              !(await env.COMMUNITY_RATE_LIMITER.limit({ key: `story-asset:${id}` })).success
            )
              throw new Error("rate_limit_exceeded");
            return response(request, await putStoryAsset(env, asset, request));
          }
          if (request.method === "GET") {
            await env.DB.prepare("UPDATE community_story_asset SET updated_at=? WHERE id=?").bind(Date.now(), id).run();
            await reconcileStoryAssets(env, id);
            const { storyAssetReceipt } = await import("./community-story-assets");
            return response(request, storyAssetReceipt((await storyAsset(env, id, user.id))!));
          }
        }
        throw new Error("method_not_allowed");
      }
      const user = await viewer(request, env),
        owner = user?.id ?? "";
      if (!id) {
        if (request.method === "POST") {
          const user = await writer(request, env);
          return await save(
            request,
            env,
            crypto.randomUUID(),
            user.id,
            await body(request, STORY_LIMITS.manifestBytes),
          );
        }
        if (request.method !== "GET" && request.method !== "HEAD") throw new Error("method_not_allowed");
        const mine = url.searchParams.get("scope") === "mine";
        if (mine && !user) throw new Error("authentication_required");
        const rows = await env.DB.prepare(
          `SELECT ${columns} ${joined} WHERE s.deleted_at IS NULL AND r.deleted_at IS NULL AND r.revision=${mine ? "s.head" : "s.published_revision"} AND ${mine ? "s.owner_id=?1" : `${publicAccess} AND r.visibility='public'`} ORDER BY ${mine ? "s.updated_at" : "r.published_at"} DESC,s.id`,
        )
          .bind(owner)
          .all<Row>();
        return response(request, { stories: rows.results.map((r) => item(r, owner)) });
      }
      if (request.method === "PUT" && !parts[1]) {
        const user = await writer(request, env);
        return await save(request, env, id, user.id, await body(request, STORY_LIMITS.manifestBytes));
      }
      const actionKind =
        request.method === "DELETE" && !parts[1]
          ? "delete"
          : request.method === "POST" && ["publish", "unpublish"].includes(parts[1] || "")
            ? (parts[1] as "publish" | "unpublish")
            : null;
      if (actionKind) {
        const author = await writer(request, env),
          value = await body(request),
          receipt = await previousAction(env, id, author.id, value, actionKind);
        if (receipt) return await actionReceipt(request, env, id, author.id, receipt);
        const current = await find(env, id, author.id, true);
        if (!current) throw new Error("story_missing");
        if (current.ownerId !== author.id) throw new Error("forbidden");
        return await mutateStory(request, env, current, author.id, value, actionKind);
      }
      const requestedRevision =
        parts[1] === "assets" || parts[1] === "source"
          ? Number(parts[2])
          : Number(url.searchParams.get("revision") || 0) || undefined;
      if (requestedRevision !== undefined && (!Number.isSafeInteger(requestedRevision) || requestedRevision < 1))
        throw new Error("story_missing");
      let row = await find(
        env,
        id,
        owner,
        url.searchParams.get("draft") === "1" || (!["GET", "HEAD"].includes(request.method) && parts[1] !== "like"),
        requestedRevision,
      );
      if (!row) throw new Error("story_missing");
      if ((parts[1] === "assets" || parts[1] === "source") && (request.method === "GET" || request.method === "HEAD")) {
        const path = storyFilePath(parts.slice(3).map(decodeURIComponent).join("/")),
          cloud = await manifest(env, row);
        const file = cloud.files.find((f) => f.path === path);
        if (!file) throw new Error("media_missing");
        if (parts[1] === "source" && row.ownerId !== owner && !row.remix) throw new Error("remix_unavailable");
        if (row.ownerId !== owner && parts[1] !== "source") {
          const plan = await runtime(env, row);
          if (!plan.resources.includes(path) && path !== row.coverPath) throw new Error("media_missing");
        }
        const asset = await storyAsset(env, file.assetId);
        if (
          !asset ||
          asset.blobState !== "active" ||
          (row.ownerId !== owner && (asset.state !== "ready" || asset.moderation !== "allow"))
        )
          throw new Error("media_missing");
        return await assetContent(request, env, asset);
      }
      if (request.method === "GET" || request.method === "HEAD") {
        if (parts[1] === "runtime") {
          const selected = row;
          const data = await runtime(env, selected);
          if (data.error || !data.project)
            return response(
              request,
              { error: { code: data.error || "invalid_project", diagnostics: data.diagnostics } },
              422,
            );
          const allowed = new Set(data.resources);
          return response(request, {
            story: item(selected, owner),
            project: mapStoryProjectResources(
              data.project,
              (source) => {
                const path = source.replace(/^\.\//u, "");
                return allowed.has(path) ? storyAssetUrl(id, selected.revision, path) : source;
              },
              `${STORY_API}/${id}/assets/${selected.revision}/`,
            ),
          });
        }
        if (parts[1] === "project") {
          if (row.ownerId !== owner && !row.remix) throw new Error("remix_unavailable");
          return response(request, { story: item(row, owner), manifest: await manifest(env, row) });
        }
        if (parts[1] === "versions") {
          const rows = await env.DB.prepare(
            `SELECT revision,title,created_at AS createdAt,published_at AS publishedAt FROM community_story_revision WHERE story_id=? AND deleted_at IS NULL ${row.ownerId === owner ? "" : "AND published_at IS NOT NULL"} ORDER BY revision DESC`,
          )
            .bind(id)
            .all();
          return response(request, { versions: rows.results });
        }
        if (!parts[1]) {
          if (row.ownerId === owner && row.publishingRevision) {
            await reconcileStoryAssets(env);
            await finalize(env, id);
            row = (await find(env, id, owner, url.searchParams.get("draft") === "1", requestedRevision))!;
          }
          return response(request, { story: item(row, owner) });
        }
      }
      const author = await writer(request, env),
        value = await body(request);
      if (parts[1] === "like" && request.method === "PUT") {
        if (typeof value.liked !== "boolean") throw new Error("invalid_request");
        await env.DB.prepare(
          value.liked
            ? "INSERT OR IGNORE INTO community_story_like(story_id,user_id,created_at) VALUES(?,?,?)"
            : "DELETE FROM community_story_like WHERE story_id=? AND user_id=?",
        )
          .bind(id, author.id, ...(value.liked ? [Date.now()] : []))
          .run();
        return response(request, { story: item((await find(env, id, owner))!, owner) });
      }
      if (parts[1] === "remix" && request.method === "POST") {
        if (row.ownerId !== author.id && !row.remix) throw new Error("remix_unavailable");
        const cloud = await manifest(env, row),
          now = Date.now(),
          ids = [...new Set(cloud.files.map((f) => f.assetId))];
        const authorized = await env.DB.batch([
          env.DB.prepare(
            `INSERT INTO community_story_remix_grant(owner_id,source_story_id,source_revision,source_title,source_owner_uid,source_owner_name,granted_at)
    SELECT ?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 ${joined} WHERE s.id=? AND r.revision=? AND (r.remix=1 OR s.owner_id=?) AND ${publicAccess})
    AND (SELECT COALESCE(sum(b.byte_size),0) FROM community_story_asset a JOIN community_story_blob b ON b.hash=a.blob_hash WHERE a.owner_id=?)
      +(SELECT COALESCE(sum(b.byte_size),0) FROM community_story_asset a JOIN community_story_blob b ON b.hash=a.blob_hash WHERE a.id IN(SELECT value FROM json_each(?)) AND NOT EXISTS(SELECT 1 FROM community_story_asset owned WHERE owned.owner_id=? AND owned.blob_hash=a.blob_hash))<=?
    ON CONFLICT(owner_id,source_story_id) DO UPDATE SET source_revision=excluded.source_revision,source_title=excluded.source_title,source_owner_uid=excluded.source_owner_uid,source_owner_name=excluded.source_owner_name,granted_at=excluded.granted_at`,
          ).bind(
            author.id,
            id,
            row.revision,
            row.title,
            row.ownerUid,
            row.ownerName || `#${row.ownerUid}`,
            now,
            id,
            row.revision,
            author.id,
            author.id,
            JSON.stringify(ids),
            author.id,
            4 * STORY_LIMITS.projectBytes,
          ),
          env.DB.prepare(
            `INSERT OR IGNORE INTO community_story_remix_revision_grant(owner_id,source_story_id,source_revision,source_title,source_owner_uid,source_owner_name,granted_at)
            SELECT owner_id,source_story_id,source_revision,source_title,source_owner_uid,source_owner_name,granted_at
            FROM community_story_remix_grant WHERE owner_id=? AND source_story_id=? AND source_revision=? AND granted_at=?`,
          ).bind(author.id, id, row.revision, now),
          env.DB.prepare(
            `INSERT INTO community_story_asset(id,owner_id,blob_hash,media_type,kind,state,created_at,updated_at)
   SELECT lower(hex(randomblob(4)))||'-'||lower(hex(randomblob(2)))||'-4'||substr(lower(hex(randomblob(2))),2)||'-8'||substr(lower(hex(randomblob(2))),2)||'-'||lower(hex(randomblob(6))),?,a.blob_hash,a.media_type,a.kind,'ready',?,?
   FROM community_story_asset a JOIN community_story_blob b ON b.hash=a.blob_hash WHERE a.id IN(SELECT value FROM json_each(?)) AND a.state='ready' AND b.state='active' AND b.moderation_status='allow'
   AND EXISTS(SELECT 1 FROM community_story_remix_grant WHERE owner_id=? AND source_story_id=? AND granted_at=?)
   ON CONFLICT(owner_id,blob_hash) DO UPDATE SET updated_at=excluded.updated_at`,
          ).bind(author.id, now, now, JSON.stringify(ids), author.id, id, now),
        ]);
        if (!authorized[0]?.meta.changes) throw new Error("remix_unavailable");
        const grants = await env.DB.prepare(
          "SELECT id,blob_hash AS hash FROM community_story_asset WHERE owner_id=? AND blob_hash IN(SELECT value FROM json_each(?))",
        )
          .bind(author.id, JSON.stringify(cloud.files.map((f) => f.hash)))
          .all<{ id: string; hash: string }>();
        const map = new Map(grants.results.map((a) => [a.hash, a.id]));
        if (cloud.files.some((f) => !map.has(f.hash))) throw new Error("media_missing");
        return response(request, {
          story: item(row, owner),
          manifest: { ...cloud, files: cloud.files.map((f) => ({ ...f, assetId: map.get(f.hash)! })) },
        });
      }
      throw new Error("method_not_allowed");
    } catch (error) {
      const message = error instanceof Error ? error.message : "service_unavailable",
        code = message.split(":")[0] || "service_unavailable";
      if (!expectedErrors.has(code)) throw error;
      const status =
        code === "authentication_required"
          ? 401
          : ["forbidden", "community_write_restricted", "email_verification_required", "remix_unavailable"].includes(
                code,
              )
            ? 403
            : code === "story_missing" || code === "media_missing"
              ? 404
              : ["version_conflict", "request_conflict", "asset_busy", "identity_changed"].includes(code)
                ? 409
                : code === "rate_limit_exceeded"
                  ? 429
                  : code === "method_not_allowed"
                    ? 405
                    : 400;
      return response(
        request,
        { error: { code, ...(message.includes(":") ? { file: message.slice(message.indexOf(":") + 1) } : {}) } },
        status,
      );
    }
  });
}
