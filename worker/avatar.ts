import { getAuthSession } from "./auth";
import { communityAccessState } from "./access";
import { scheduleEntityModeration } from "./moderation";
import { inspectUploadBytes } from "./uploads";

type AvatarMediaType = "image/jpeg" | "image/png" | "image/webp";

interface AvatarObjectRow {
  mediaType: AvatarMediaType;
  objectKey: string;
  r2Etag: string;
  r2Version: string;
  sha256: string;
}

interface OwnedAvatarRow {
  id: string;
  objectKey: string;
}

const ACCOUNT_AVATAR_PREFIX = "/api/v1/account/avatar";
const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
const PENDING_TTL_MS = 24 * 60 * 60 * 1_000;
const MEDIA_TYPES: ReadonlySet<string> = new Set(["image/jpeg", "image/png", "image/webp"]);

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

const isAvatarMediaType = (value: string): value is AvatarMediaType => MEDIA_TYPES.has(value);

const extensionFor = (mediaType: AvatarMediaType): string => {
  if (mediaType === "image/jpeg") return ".jpg";
  if (mediaType === "image/png") return ".png";
  return ".webp";
};

const readBoundedBody = async (request: Request): Promise<Uint8Array | null> => {
  if (!request.body) return null;
  const contentLength = request.headers.get("Content-Length");
  if (contentLength) {
    const declared = Number(contentLength);
    if (!Number.isSafeInteger(declared) || declared < 1 || declared > MAX_AVATAR_BYTES) {
      await request.body.cancel();
      return null;
    }
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > MAX_AVATAR_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(part.value);
  }
  if (!size) return null;
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
};

const hex = (buffer: ArrayBuffer): string =>
  [...new Uint8Array(buffer)].map((value) => value.toString(16).padStart(2, "0")).join("");

const requireAvatarWriteAccess = async (
  request: Request,
  env: Env,
): Promise<{ userId: string } | { response: Response }> => {
  const session = await getAuthSession(request, env);
  if (!session?.user?.id) {
    return { response: error(request, 401, "authentication_required", "Sign in required") };
  }
  if (!session.user.emailVerified) {
    return { response: error(request, 403, "email_verification_required", "Verify the account email first") };
  }
  const access = await communityAccessState(env, session.user.id, ["sign_in", "write", "upload"]);
  if (!access) return { response: error(request, 503, "profile_unavailable", "Account profile is unavailable") };
  if (access.status !== "active") {
    return { response: error(request, 403, "account_suspended", "Account is suspended") };
  }
  if (access.restriction) {
    return { response: error(request, 403, "community_upload_restricted", "This account cannot upload files") };
  }
  if (env.COMMUNITY_RATE_LIMITER) {
    const result = await env.COMMUNITY_RATE_LIMITER.limit({ key: `avatar:${session.user.id}` });
    if (!result.success) return { response: error(request, 429, "rate_limit_exceeded", "Try again later") };
  }
  return { userId: session.user.id };
};

const putAvatar = async (request: Request, env: Env): Promise<Response> => {
  const access = await requireAvatarWriteAccess(request, env);
  if ("response" in access) return access.response;
  const mediaType = request.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLocaleLowerCase("und") ?? "";
  if (!isAvatarMediaType(mediaType)) {
    await request.body?.cancel();
    return error(request, 415, "unsupported_avatar", "Use a JPEG, PNG, or WebP image");
  }
  const bytes = await readBoundedBody(request);
  if (!bytes) return error(request, 413, "invalid_avatar_size", "Avatar images must be 1 byte to 2 MiB");
  const inspection = inspectUploadBytes(mediaType, bytes, {
    maximumDimension: 4_096,
    maximumPixels: 16_000_000,
  });
  if (!inspection.ok) return error(request, 415, inspection.reason ?? "invalid_avatar", "Invalid image data");

  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const digestHex = hex(digest);
  const id = crypto.randomUUID();
  const extension = extensionFor(mediaType);
  const objectKey = `avatars/v1/${id}${extension}`;
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO community_attachment
       (id, owner_user_id, purpose, idempotency_key, object_key, original_name, media_type,
        declared_size, byte_size, sha256, status, moderation_status, expires_at, created_at, updated_at)
     VALUES (?, ?, 'avatar', ?, ?, ?, ?, ?, ?, ?, 'scanning', 'pending', ?, ?, ?)`,
  )
    .bind(
      id,
      access.userId,
      `avatar:${id}`,
      objectKey,
      `avatar${extension}`,
      mediaType,
      bytes.byteLength,
      bytes.byteLength,
      digestHex,
      now + PENDING_TTL_MS,
      now,
      now,
    )
    .run();

  try {
    const stored = await env.COMMUNITY_UPLOADS.put(objectKey, bytes, {
      onlyIf: { etagDoesNotMatch: "*" },
      sha256: digest,
      httpMetadata: {
        cacheControl: "no-cache, must-revalidate",
        contentDisposition: `inline; filename="avatar${extension}"`,
        contentType: mediaType,
      },
      customMetadata: { attachmentId: id, purpose: "avatar", sha256: digestHex },
    });
    if (!stored) throw new Error("Avatar object key collision");
    await env.DB.prepare(
      `UPDATE community_attachment
       SET r2_etag = ?, r2_version = ?, updated_at = ?
       WHERE id = ? AND status = 'scanning'`,
    )
      .bind(stored.etag, stored.version, Date.now(), id)
      .run();
    await scheduleEntityModeration(env, "attachment", id, inspection.inspection, 1);
  } catch (uploadError) {
    await env.COMMUNITY_UPLOADS.delete(objectKey);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM community_moderation_case WHERE entity_kind = 'attachment' AND entity_id = ?").bind(
        id,
      ),
      env.DB.prepare("DELETE FROM community_attachment WHERE id = ? AND purpose = 'avatar'").bind(id),
    ]);
    throw uploadError;
  }
  return json(request, { avatar: { status: "pending" } }, 202);
};

const getAvatar = async (request: Request, env: Env, userId: string): Promise<Response> => {
  if (!userId || userId.length > 200) return error(request, 404, "avatar_not_found", "Avatar not found");
  const avatar = await env.DB.prepare(
    `SELECT attachment.object_key AS objectKey, attachment.media_type AS mediaType, attachment.sha256,
            attachment.r2_etag AS r2Etag, attachment.r2_version AS r2Version
     FROM community_profile_avatar AS avatar
     JOIN community_profile AS profile ON profile.user_id = avatar.user_id
     JOIN community_attachment AS attachment ON attachment.id = avatar.attachment_id
     WHERE avatar.user_id = ?
       AND profile.status <> 'deleted'
       AND attachment.purpose = 'avatar'
       AND attachment.status = 'ready'
       AND attachment.moderation_status = 'allow'
       AND attachment.deleted_at IS NULL
     LIMIT 1`,
  )
    .bind(userId)
    .first<AvatarObjectRow>();
  if (!avatar) return error(request, 404, "avatar_not_found", "Avatar not found");
  const metadata = await env.COMMUNITY_UPLOADS.head(avatar.objectKey);
  if (
    !metadata ||
    metadata.etag !== avatar.r2Etag ||
    metadata.version !== avatar.r2Version ||
    metadata.customMetadata?.sha256 !== avatar.sha256
  ) {
    return error(request, 404, "avatar_not_found", "Avatar not found");
  }
  const headers = new Headers({
    "Cache-Control": "no-cache, must-revalidate",
    "Content-Length": String(metadata.size),
    "Content-Type": avatar.mediaType,
    "Cross-Origin-Resource-Policy": "same-origin",
    ETag: metadata.httpEtag,
    "X-Content-Type-Options": "nosniff",
  });
  if (
    request.headers
      .get("If-None-Match")
      ?.split(",")
      .map((value) => value.trim())
      .includes(metadata.httpEtag)
  ) {
    return new Response(null, { status: 304, headers });
  }
  if (request.method === "HEAD") return new Response(null, { headers });
  const object = await env.COMMUNITY_UPLOADS.get(avatar.objectKey);
  if (!object) return error(request, 404, "avatar_not_found", "Avatar not found");
  return new Response(object.body, { headers });
};

const deleteAvatar = async (request: Request, env: Env): Promise<Response> => {
  const access = await requireAvatarWriteAccess(request, env);
  if ("response" in access) return access.response;
  const avatars = await env.DB.prepare(
    `SELECT id, object_key AS objectKey
     FROM community_attachment
     WHERE owner_user_id = ? AND purpose = 'avatar' AND deleted_at IS NULL`,
  )
    .bind(access.userId)
    .all<OwnedAvatarRow>();
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM community_profile_avatar WHERE user_id = ?").bind(access.userId),
    env.DB.prepare('UPDATE "user" SET image = NULL, updatedAt = ? WHERE id = ?').bind(
      new Date(now).toISOString(),
      access.userId,
    ),
    env.DB.prepare(
      `UPDATE community_attachment
       SET status = 'deleted', deleted_at = COALESCE(deleted_at, ?), updated_at = ?
       WHERE owner_user_id = ? AND purpose = 'avatar' AND deleted_at IS NULL`,
    ).bind(now, now, access.userId),
  ]);
  if (avatars.results.length) {
    await env.COMMUNITY_UPLOADS.delete(avatars.results.map((avatar) => avatar.objectKey));
    await env.DB.prepare(
      `UPDATE community_attachment
       SET object_deleted_at = ?, updated_at = ?
       WHERE owner_user_id = ? AND purpose = 'avatar' AND object_deleted_at IS NULL`,
    )
      .bind(Date.now(), Date.now(), access.userId)
      .run();
  }
  return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
};

export const handleAvatarRequest = async (request: Request, env: Env): Promise<Response | null> => {
  const url = new URL(request.url);
  if (url.pathname !== ACCOUNT_AVATAR_PREFIX && !url.pathname.startsWith(`${ACCOUNT_AVATAR_PREFIX}/`)) return null;
  if (!env.DB || !env.COMMUNITY_UPLOADS) {
    return error(request, 503, "avatar_unavailable", "Avatar storage is unavailable");
  }
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: { Allow: "GET, HEAD, PUT, DELETE, OPTIONS" } });
  }
  if (!new Set(["GET", "HEAD"]).has(request.method) && !sameOrigin(request)) {
    return error(request, 403, "cross_origin_request", "Cross-origin writes are not allowed");
  }
  if (url.pathname === ACCOUNT_AVATAR_PREFIX) {
    if (request.method === "PUT") return putAvatar(request, env);
    if (request.method === "DELETE") return deleteAvatar(request, env);
    return error(request, 405, "method_not_allowed", "Method not allowed");
  }
  const encodedUserId = url.pathname.slice(ACCOUNT_AVATAR_PREFIX.length + 1);
  if (!encodedUserId || encodedUserId.includes("/")) return error(request, 404, "avatar_not_found", "Avatar not found");
  let userId: string;
  try {
    userId = decodeURIComponent(encodedUserId);
  } catch {
    return error(request, 404, "avatar_not_found", "Avatar not found");
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return error(request, 405, "method_not_allowed", "Method not allowed");
  }
  return getAvatar(request, env, userId);
};
