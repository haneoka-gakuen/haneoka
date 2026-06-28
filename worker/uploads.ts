import { getAuthSession } from "./auth";
import { communityAccessState } from "./access";
import { inspectCommunityText, scheduleEntityModeration, type TextInspection } from "./moderation";

type UploadMediaType = "image/jpeg" | "image/png" | "image/webp" | "text/plain";
type AttachmentStatus = "deleted" | "ready" | "rejected" | "reserved" | "review" | "scanning";
type AttachmentModerationStatus = "allow" | "block" | "pending" | "review";

interface UploadPolicy {
  extensions: ReadonlySet<string>;
  maximumBytes: number;
}

interface AttachmentRow {
  byteSize: number | null;
  createdAt: number;
  declaredSize: number;
  deletedAt: number | null;
  expiresAt: number;
  failureCode: string | null;
  fileName: string;
  id: string;
  idempotencyKey: string;
  mediaType: UploadMediaType;
  moderationStatus: AttachmentModerationStatus;
  objectKey: string;
  ownerUserId: string;
  purpose: "avatar" | "post";
  sha256: string | null;
  status: AttachmentStatus;
  updatedAt: number;
}

interface QuotaRow {
  usedBytes: number;
}

interface PostOwnerRow {
  authorId: string;
}

interface LinkedAttachmentRow {
  attachmentId: string;
  position: number;
}

interface AttachmentCandidateRow {
  id: string;
}

interface DownloadAccessRow extends AttachmentRow {
  attachmentOwnerStatus: "active" | "deleted" | "suspended" | null;
  postArchivedAt: number | null;
  postAuthorId: string | null;
  postAuthorStatus: "active" | "deleted" | "suspended" | null;
  postDeletedAt: number | null;
  postModerationStatus: "allow" | "block" | "pending" | "review" | null;
  postStatus: "draft" | "hidden" | "published" | null;
  postVisibility: "private" | "protected" | "public" | null;
}

interface CleanupRow {
  id: string;
  objectKey: string;
}

interface JsonObject {
  [key: string]: JsonValue;
}
type JsonValue = boolean | JsonObject | JsonValue[] | null | number | string;

interface UploadInspection {
  inspection: TextInspection;
  ok: boolean;
  reason?: string;
}

interface ImageLimits {
  maximumDimension: number;
  maximumPixels: number;
}

const PREFIX = "/api/v1/community";
const INTENT_TTL_MS = 15 * 60 * 1_000;
const UNATTACHED_TTL_MS = 24 * 60 * 60 * 1_000;
const CLEANUP_RETRY_DELAY_MS = 5 * 60 * 1_000;
const CLEANUP_REVIEW_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const USER_QUOTA_BYTES = 100 * 1024 * 1024;
const MAX_ATTACHMENTS_PER_POST = 10;
const JSON_BODY_LIMIT = 16 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/u;

const POLICIES: Readonly<Record<UploadMediaType, UploadPolicy>> = Object.freeze({
  "image/jpeg": { extensions: new Set([".jpeg", ".jpg"]), maximumBytes: 10 * 1024 * 1024 },
  "image/png": { extensions: new Set([".png"]), maximumBytes: 10 * 1024 * 1024 },
  "image/webp": { extensions: new Set([".webp"]), maximumBytes: 10 * 1024 * 1024 },
  "text/plain": { extensions: new Set([".txt"]), maximumBytes: 64 * 1024 },
});

const attachmentColumns = `
  community_attachment.id,
  community_attachment.owner_user_id AS ownerUserId,
  community_attachment.purpose,
  community_attachment.idempotency_key AS idempotencyKey,
  community_attachment.object_key AS objectKey,
  community_attachment.original_name AS fileName,
  community_attachment.media_type AS mediaType,
  community_attachment.declared_size AS declaredSize,
  community_attachment.byte_size AS byteSize,
  community_attachment.sha256,
  community_attachment.status,
  community_attachment.moderation_status AS moderationStatus,
  community_attachment.failure_code AS failureCode,
  community_attachment.expires_at AS expiresAt,
  community_attachment.created_at AS createdAt,
  community_attachment.updated_at AS updatedAt,
  community_attachment.deleted_at AS deletedAt
`;

const attachmentSelect = `SELECT ${attachmentColumns} FROM community_attachment`;

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

const json = (request: Request, value: JsonValue, status = 200, extraHeaders: HeadersInit = {}): Response =>
  new Response(request.method === "HEAD" ? null : JSON.stringify(value), {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      ...extraHeaders,
    },
  });

const error = (request: Request, status: number, code: string, message: string): Response =>
  json(request, { error: { code, message } }, status);

const isSameOrigin = (request: Request): boolean => {
  const origin = request.headers.get("Origin");
  if (!origin) return request.headers.get("Sec-Fetch-Site") !== "cross-site";
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
};

const readJson = async (request: Request): Promise<JsonObject | null> => {
  if (!request.headers.get("Content-Type")?.toLowerCase().startsWith("application/json") || !request.body) return null;
  const declared = Number(request.headers.get("Content-Length") || 0);
  if (declared > JSON_BODY_LIMIT) {
    await request.body.cancel();
    return null;
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > JSON_BODY_LIMIT) {
      await reader.cancel();
      return null;
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
    return isJsonValue(parsed) && isJsonObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const isUploadMediaType = (value: string): value is UploadMediaType => Object.hasOwn(POLICIES, value);

const extension = (fileName: string): string => {
  const dot = fileName.lastIndexOf(".");
  return dot > 0 ? fileName.slice(dot).toLocaleLowerCase("und") : "";
};

const sanitizeFileName = (value: string): string | null => {
  const normalized = value
    .normalize("NFKC")
    .replace(/[\u0000-\u001F\u007F]/gu, "")
    .trim();
  const base = normalized.split(/[\\/]/u).pop()?.trim() || "";
  if (!base || base === "." || base === ".." || [...base].length > 160) return null;
  return base;
};

const objectKeyFor = (attachmentId: string, fileExtension: string, now: number): string => {
  const date = new Date(now);
  const year = String(date.getUTCFullYear()).padStart(4, "0");
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `attachments/v1/${year}/${month}/${attachmentId}${fileExtension}`;
};

const attachmentValue = (row: AttachmentRow): JsonObject => ({
  id: row.id,
  fileName: row.fileName,
  mediaType: row.mediaType,
  size: row.declaredSize,
  status: row.status,
  moderationStatus: row.moderationStatus,
  createdAt: row.createdAt,
  expiresAt: row.expiresAt,
  uploadUrl: row.status === "reserved" ? `${PREFIX}/uploads/${row.id}/content` : null,
  downloadUrl:
    row.status === "ready" && row.moderationStatus === "allow" ? `${PREFIX}/attachments/${row.id}/content` : null,
  failureCode: row.failureCode,
});

const findAttachment = async (env: Env, id: string): Promise<AttachmentRow | null> =>
  env.DB.prepare(`${attachmentSelect} WHERE id = ? LIMIT 1`).bind(id).first<AttachmentRow>();

const requireActiveUser = async (request: Request, env: Env): Promise<{ userId: string } | { response: Response }> => {
  const session = await getAuthSession(request, env);
  if (!session?.user?.id) return { response: error(request, 401, "authentication_required", "Sign in required") };
  if (!session.user.emailVerified) {
    return { response: error(request, 403, "email_verification_required", "Verify the account email first") };
  }
  const access = await communityAccessState(env, session.user.id, ["sign_in", "write", "upload"]);
  if (!access) return { response: error(request, 503, "profile_unavailable", "Community profile is unavailable") };
  if (access.status !== "active") return { response: error(request, 403, "account_suspended", "Account is suspended") };
  if (access.restriction) {
    return { response: error(request, 403, "community_upload_restricted", "This account cannot upload files") };
  }
  return { userId: session.user.id };
};

const applyRateLimit = async (env: Env, key: string): Promise<boolean> => {
  if (!env.COMMUNITY_RATE_LIMITER) return true;
  const result = await env.COMMUNITY_RATE_LIMITER.limit({ key: `upload:${key}` });
  return result.success;
};

const createIntent = async (request: Request, env: Env): Promise<Response> => {
  const access = await requireActiveUser(request, env);
  if ("response" in access) return access.response;
  if (!(await applyRateLimit(env, access.userId))) {
    return error(request, 429, "rate_limit_exceeded", "Too many upload requests");
  }
  const idempotencyKey = request.headers.get("Idempotency-Key")?.trim() || "";
  if (!IDEMPOTENCY_PATTERN.test(idempotencyKey)) {
    return error(request, 422, "invalid_idempotency_key", "Idempotency-Key must be 16-128 safe characters");
  }
  const body = await readJson(request);
  const rawFileName = body?.fileName;
  const rawMediaType = body?.mediaType;
  const rawSize = body?.size;
  if (typeof rawFileName !== "string" || typeof rawMediaType !== "string" || typeof rawSize !== "number") {
    return error(request, 400, "invalid_body", "fileName, mediaType, and size are required");
  }
  const fileName = sanitizeFileName(rawFileName);
  const mediaType = rawMediaType.toLocaleLowerCase("und").split(";", 1)[0]?.trim() || "";
  if (!fileName || !isUploadMediaType(mediaType)) {
    return error(request, 415, "unsupported_file", "Only JPEG, PNG, WebP, and plain-text files are supported");
  }
  const policy = POLICIES[mediaType];
  if (!policy.extensions.has(extension(fileName))) {
    return error(request, 422, "extension_mismatch", "The filename extension does not match its media type");
  }
  if (!Number.isSafeInteger(rawSize) || rawSize < 1 || rawSize > policy.maximumBytes) {
    return error(request, 413, "file_too_large", `The maximum size for ${mediaType} is ${policy.maximumBytes} bytes`);
  }

  const existing = await env.DB.prepare(`${attachmentSelect} WHERE owner_user_id = ? AND idempotency_key = ? LIMIT 1`)
    .bind(access.userId, idempotencyKey)
    .first<AttachmentRow>();
  if (existing) {
    if (existing.fileName !== fileName || existing.mediaType !== mediaType || existing.declaredSize !== rawSize) {
      return error(request, 409, "idempotency_conflict", "This Idempotency-Key was used for a different file");
    }
    return json(request, { attachment: attachmentValue(existing) });
  }

  const now = Date.now();
  const id = crypto.randomUUID();
  const expiresAt = now + INTENT_TTL_MS;
  const objectKey = objectKeyFor(id, extension(fileName), now);
  const inserted = await env.DB.prepare(
    `INSERT OR IGNORE INTO community_attachment
       (id, owner_user_id, purpose, idempotency_key, object_key, original_name, media_type,
        declared_size, status, moderation_status, expires_at, created_at, updated_at)
     SELECT ?, ?, 'post', ?, ?, ?, ?, ?, 'reserved', 'pending', ?, ?, ?
     WHERE COALESCE((
       SELECT SUM(declared_size)
       FROM community_attachment
       WHERE owner_user_id = ?
         AND status IN ('reserved', 'scanning', 'ready', 'review')
         AND deleted_at IS NULL
     ), 0) + ? <= ?`,
  )
    .bind(
      id,
      access.userId,
      idempotencyKey,
      objectKey,
      fileName,
      mediaType,
      rawSize,
      expiresAt,
      now,
      now,
      access.userId,
      rawSize,
      USER_QUOTA_BYTES,
    )
    .run();
  if (Number(inserted.meta.changes || 0) === 0) {
    const raced = await env.DB.prepare(`${attachmentSelect} WHERE owner_user_id = ? AND idempotency_key = ? LIMIT 1`)
      .bind(access.userId, idempotencyKey)
      .first<AttachmentRow>();
    if (raced && raced.fileName === fileName && raced.mediaType === mediaType && raced.declaredSize === rawSize) {
      return json(request, { attachment: attachmentValue(raced) });
    }
    if (raced) return error(request, 409, "idempotency_conflict", "This Idempotency-Key was used for a different file");
    const quota = await env.DB.prepare(
      `SELECT COALESCE(SUM(declared_size), 0) AS usedBytes
       FROM community_attachment
       WHERE owner_user_id = ? AND status IN ('reserved', 'scanning', 'ready', 'review') AND deleted_at IS NULL`,
    )
      .bind(access.userId)
      .first<QuotaRow>();
    if ((quota?.usedBytes ?? 0) + rawSize > USER_QUOTA_BYTES) {
      return error(request, 413, "storage_quota_exceeded", "The active upload quota is 100 MiB per user");
    }
    throw new Error("Upload intent was not reserved despite available quota");
  }
  const attachment = await findAttachment(env, id);
  if (!attachment) throw new Error("Upload intent was not persisted");
  return json(request, { attachment: attachmentValue(attachment) }, 201, { Location: `${PREFIX}/attachments/${id}` });
};

const startsWith = (bytes: Uint8Array, signature: readonly number[]): boolean =>
  signature.every((value, index) => bytes[index] === value);

const DEFAULT_IMAGE_LIMITS: ImageLimits = { maximumDimension: 8_192, maximumPixels: 40_000_000 };

const ascii = (bytes: Uint8Array, offset: number, length: number): string =>
  String.fromCharCode(...bytes.subarray(offset, offset + length));

const dimensionsAllowed = (width: number, height: number, limits: ImageLimits): boolean =>
  Number.isSafeInteger(width) &&
  Number.isSafeInteger(height) &&
  width > 0 &&
  height > 0 &&
  width <= limits.maximumDimension &&
  height <= limits.maximumDimension &&
  width * height <= limits.maximumPixels;

const inspectPngContainer = (bytes: Uint8Array, limits: ImageLimits): string | null => {
  if (!startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) || bytes.length < 45) {
    return "invalid_png_container";
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  let dimensionsSeen = false;
  let endSeen = false;
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset, false);
    if (length > bytes.length - offset - 12) return "invalid_png_container";
    const type = ascii(bytes, offset + 4, 4);
    if (!dimensionsSeen) {
      if (type !== "IHDR" || length !== 13) return "invalid_png_container";
      const width = view.getUint32(offset + 8, false);
      const height = view.getUint32(offset + 12, false);
      if (!dimensionsAllowed(width, height, limits)) return "image_dimensions_exceeded";
      dimensionsSeen = true;
    }
    if (type === "acTL") return "animated_images_not_allowed";
    offset += length + 12;
    if (type === "IEND") {
      if (length !== 0 || offset !== bytes.length) return "invalid_png_container";
      endSeen = true;
      break;
    }
  }
  return dimensionsSeen && endSeen ? null : "invalid_png_container";
};

const JPEG_SOF_MARKERS: ReadonlySet<number> = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

const inspectJpegContainer = (bytes: Uint8Array, limits: ImageLimits): string | null => {
  if (
    !startsWith(bytes, [0xff, 0xd8]) ||
    bytes.length < 12 ||
    !startsWith(bytes.subarray(bytes.length - 2), [0xff, 0xd9])
  ) {
    return "invalid_jpeg_container";
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 2;
  let dimensionsSeen = false;
  while (offset + 1 < bytes.length - 2) {
    if (bytes[offset] !== 0xff) return "invalid_jpeg_container";
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset];
    offset += 1;
    if (marker === undefined) return "invalid_jpeg_container";
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) continue;
    if (offset + 2 > bytes.length) return "invalid_jpeg_container";
    const length = view.getUint16(offset, false);
    if (length < 2 || length > bytes.length - offset) return "invalid_jpeg_container";
    if (JPEG_SOF_MARKERS.has(marker)) {
      if (length < 7) return "invalid_jpeg_container";
      const height = view.getUint16(offset + 3, false);
      const width = view.getUint16(offset + 5, false);
      if (!dimensionsAllowed(width, height, limits)) return "image_dimensions_exceeded";
      dimensionsSeen = true;
    }
    if (marker === 0xda) break;
    offset += length;
  }
  return dimensionsSeen ? null : "invalid_jpeg_container";
};

const inspectWebpContainer = (bytes: Uint8Array, limits: ImageLimits): string | null => {
  if (bytes.length < 30 || ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WEBP") {
    return "invalid_webp_container";
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(4, true) + 8 !== bytes.length) return "invalid_webp_container";
  let offset = 12;
  let dimensionsSeen = false;
  while (offset + 8 <= bytes.length) {
    const type = ascii(bytes, offset, 4);
    const length = view.getUint32(offset + 4, true);
    const dataOffset = offset + 8;
    if (length > bytes.length - dataOffset) return "invalid_webp_container";
    if (type === "ANIM" || type === "ANMF") return "animated_images_not_allowed";
    if (type === "VP8X") {
      if (length < 10) return "invalid_webp_container";
      if ((bytes[dataOffset] ?? 0) & 0x02) return "animated_images_not_allowed";
      const width = 1 + view.getUint16(dataOffset + 4, true) + ((bytes[dataOffset + 6] ?? 0) << 16);
      const height = 1 + view.getUint16(dataOffset + 7, true) + ((bytes[dataOffset + 9] ?? 0) << 16);
      if (!dimensionsAllowed(width, height, limits)) return "image_dimensions_exceeded";
      dimensionsSeen = true;
    } else if (type === "VP8 ") {
      if (length < 10 || !startsWith(bytes.subarray(dataOffset + 3), [0x9d, 0x01, 0x2a])) {
        return "invalid_webp_container";
      }
      const width = view.getUint16(dataOffset + 6, true) & 0x3fff;
      const height = view.getUint16(dataOffset + 8, true) & 0x3fff;
      if (!dimensionsAllowed(width, height, limits)) return "image_dimensions_exceeded";
      dimensionsSeen = true;
    } else if (type === "VP8L") {
      if (length < 5 || bytes[dataOffset] !== 0x2f) return "invalid_webp_container";
      const b1 = bytes[dataOffset + 1] ?? 0;
      const b2 = bytes[dataOffset + 2] ?? 0;
      const b3 = bytes[dataOffset + 3] ?? 0;
      const b4 = bytes[dataOffset + 4] ?? 0;
      const width = 1 + b1 + ((b2 & 0x3f) << 8);
      const height = 1 + (b2 >> 6) + (b3 << 2) + ((b4 & 0x0f) << 10);
      if (!dimensionsAllowed(width, height, limits)) return "image_dimensions_exceeded";
      dimensionsSeen = true;
    }
    offset = dataOffset + length + (length % 2);
  }
  return dimensionsSeen && offset === bytes.length ? null : "invalid_webp_container";
};

const looksLikeRejectedContainer = (bytes: Uint8Array): boolean =>
  startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) ||
  startsWith(bytes, [0x25, 0x50, 0x44, 0x46]) ||
  startsWith(bytes, [0x7f, 0x45, 0x4c, 0x46]) ||
  startsWith(bytes, [0x4d, 0x5a]) ||
  startsWith(bytes, [0x1f, 0x8b]);

export const inspectUploadBytes = (
  mediaType: UploadMediaType,
  bytes: Uint8Array,
  limits: ImageLimits = DEFAULT_IMAGE_LIMITS,
): UploadInspection => {
  const clean: TextInspection = {
    categories: [],
    normalizedText: "",
    reasonCode: "deterministic.binary_signature_valid",
    verdict: "allow",
  };
  if (!bytes.byteLength || looksLikeRejectedContainer(bytes)) {
    return { inspection: clean, ok: false, reason: "forbidden_container" };
  }
  if (mediaType === "image/jpeg") {
    const reason = inspectJpegContainer(bytes, limits);
    return reason ? { inspection: clean, ok: false, reason } : { inspection: clean, ok: true };
  }
  if (mediaType === "image/png") {
    const reason = inspectPngContainer(bytes, limits);
    return reason ? { inspection: clean, ok: false, reason } : { inspection: clean, ok: true };
  }
  if (mediaType === "image/webp") {
    const reason = inspectWebpContainer(bytes, limits);
    return reason ? { inspection: clean, ok: false, reason } : { inspection: clean, ok: true };
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
    if (/^\s*(?:<!doctype\s+html\b|<html\b)/iu.test(text)) {
      return { inspection: clean, ok: false, reason: "html_is_not_allowed" };
    }
    return { inspection: inspectCommunityText(text), ok: true };
  } catch {
    return { inspection: clean, ok: false, reason: "invalid_utf8_text" };
  }
};

const readBoundedBody = async (request: Request, expected: number, maximum: number): Promise<Uint8Array | null> => {
  if (!request.body) return null;
  const declared = request.headers.get("Content-Length");
  if (declared && Number(declared) !== expected) {
    await request.body.cancel();
    return null;
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > maximum || size > expected) {
      await reader.cancel();
      return null;
    }
    chunks.push(part.value);
  }
  if (size !== expected) return null;
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

const encodedFileName = (value: string): string =>
  encodeURIComponent(value).replace(
    /[!'()*]/gu,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );

const contentDisposition = (fileName: string, mediaType: UploadMediaType): string => {
  const mode = mediaType.startsWith("image/") ? "inline" : "attachment";
  return `${mode}; filename="attachment${extension(fileName)}"; filename*=UTF-8''${encodedFileName(fileName)}`;
};

const putContent = async (request: Request, env: Env, id: string): Promise<Response> => {
  const access = await requireActiveUser(request, env);
  if ("response" in access) return access.response;
  if (!(await applyRateLimit(env, access.userId))) {
    await request.body?.cancel();
    return error(request, 429, "rate_limit_exceeded", "Too many upload requests");
  }
  const attachment = await findAttachment(env, id);
  if (!attachment || attachment.ownerUserId !== access.userId || attachment.purpose !== "post") {
    await request.body?.cancel();
    return error(request, 404, "attachment_not_found", "Attachment not found");
  }
  if (attachment.status !== "reserved") {
    await request.body?.cancel();
    return json(request, { attachment: attachmentValue(attachment) });
  }
  if (attachment.expiresAt < Date.now()) {
    await request.body?.cancel();
    await env.DB.prepare(
      "UPDATE community_attachment SET status = 'deleted', deleted_at = ?, updated_at = ? WHERE id = ? AND status = 'reserved'",
    )
      .bind(Date.now(), Date.now(), id)
      .run();
    return error(request, 410, "upload_intent_expired", "Upload intent expired");
  }
  const requestMediaType = request.headers.get("Content-Type")?.toLocaleLowerCase("und").split(";", 1)[0]?.trim();
  if (requestMediaType !== attachment.mediaType) {
    await request.body?.cancel();
    return error(request, 415, "media_type_mismatch", "Content-Type does not match the upload intent");
  }
  const policy = POLICIES[attachment.mediaType];
  const bytes = await readBoundedBody(request, attachment.declaredSize, policy.maximumBytes);
  if (!bytes) return error(request, 400, "size_mismatch", "Upload size does not match the intent");
  const byteInspection = inspectUploadBytes(attachment.mediaType, bytes);
  if (!byteInspection.ok) {
    return error(
      request,
      415,
      byteInspection.reason || "invalid_file_signature",
      "File content does not match its type",
    );
  }

  const digestInput = new Uint8Array(bytes.byteLength);
  digestInput.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", digestInput.buffer);
  const digestHex = hex(digest);
  const stored = await env.COMMUNITY_UPLOADS.put(attachment.objectKey, bytes, {
    onlyIf: { etagDoesNotMatch: "*" },
    sha256: digest,
    httpMetadata: {
      cacheControl: "private, no-store",
      contentDisposition: contentDisposition(attachment.fileName, attachment.mediaType),
      contentType: attachment.mediaType,
    },
    customMetadata: {
      attachmentId: attachment.id,
      sha256: digestHex,
    },
  });
  let object = stored;
  let createdObject = Boolean(stored);
  if (!object) {
    const existing = await env.COMMUNITY_UPLOADS.head(attachment.objectKey);
    if (
      !existing ||
      existing.size !== bytes.byteLength ||
      existing.customMetadata?.attachmentId !== attachment.id ||
      existing.customMetadata?.sha256 !== digestHex
    ) {
      return error(request, 409, "object_conflict", "The reserved object key is already in use");
    }
    object = existing;
    createdObject = false;
  }

  const now = Date.now();
  try {
    const updated = await env.DB.prepare(
      `UPDATE community_attachment
       SET byte_size = ?, sha256 = ?, r2_etag = ?, r2_version = ?, status = 'scanning',
           moderation_status = 'pending', failure_code = NULL, expires_at = ?, updated_at = ?
       WHERE id = ? AND owner_user_id = ? AND status = 'reserved'`,
    )
      .bind(
        bytes.byteLength,
        digestHex,
        object.etag,
        object.version,
        now + UNATTACHED_TTL_MS,
        now,
        attachment.id,
        access.userId,
      )
      .run();
    if (Number(updated.meta.changes || 0) === 0) {
      const raced = await findAttachment(env, id);
      if (raced) return json(request, { attachment: attachmentValue(raced) });
      throw new Error("Attachment state changed during upload");
    }
  } catch (databaseError) {
    if (createdObject) await env.COMMUNITY_UPLOADS.delete(attachment.objectKey);
    throw databaseError;
  }

  try {
    await scheduleEntityModeration(env, "attachment", attachment.id, byteInspection.inspection, 1);
  } catch (moderationError) {
    console.error(
      JSON.stringify({
        event: "community.upload.moderation_schedule_failed",
        error:
          moderationError instanceof Error
            ? { message: moderationError.message, name: moderationError.name }
            : String(moderationError),
        requestId: request.headers.get("X-Request-Id") || null,
      }),
    );
    await env.COMMUNITY_UPLOADS.delete(attachment.objectKey);
    const failedAt = Date.now();
    await env.DB.batch([
      env.DB.prepare("DELETE FROM community_moderation_case WHERE entity_kind = 'attachment' AND entity_id = ?").bind(
        attachment.id,
      ),
      env.DB.prepare(
        `UPDATE community_attachment
         SET status = 'deleted', failure_code = 'moderation_unavailable', deleted_at = ?,
             object_deleted_at = ?, updated_at = ?
         WHERE id = ?`,
      ).bind(failedAt, failedAt, failedAt, attachment.id),
    ]);
    return error(request, 503, "moderation_unavailable", "Upload moderation is temporarily unavailable");
  }
  const result = await findAttachment(env, attachment.id);
  if (!result) throw new Error("Attachment disappeared after upload");
  return json(request, { attachment: attachmentValue(result) }, 202);
};

const getMetadata = async (request: Request, env: Env, id: string): Promise<Response> => {
  const access = await requireActiveUser(request, env);
  if ("response" in access) return access.response;
  const attachment = await findAttachment(env, id);
  if (
    !attachment ||
    attachment.ownerUserId !== access.userId ||
    attachment.purpose !== "post" ||
    attachment.deletedAt !== null
  ) {
    return error(request, 404, "attachment_not_found", "Attachment not found");
  }
  return json(request, { attachment: attachmentValue(attachment) });
};

const normalizeEtag = (value: string): string => value.trim().replace(/^W\//u, "");

const etagMatches = (requestValue: string | null, etag: string): boolean =>
  Boolean(
    requestValue &&
    (requestValue.trim() === "*" || requestValue.split(",").map(normalizeEtag).includes(normalizeEtag(etag))),
  );

interface ByteRange {
  length: number;
  offset: number;
}

const parseRange = (value: string | null, size: number): ByteRange | "invalid" | null => {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/u.exec(value);
  if (!match || (!match[1] && !match[2])) return "invalid";
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix < 1) return "invalid";
    const length = Math.min(size, suffix);
    return { length, offset: size - length };
  }
  const offset = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(requestedEnd) || offset < 0 || offset >= size) {
    return "invalid";
  }
  const end = Math.min(size - 1, requestedEnd);
  return end >= offset ? { length: end - offset + 1, offset } : "invalid";
};

const downloadAttachment = async (request: Request, env: Env, id: string): Promise<Response> => {
  const session = await getAuthSession(request, env);
  const row = await env.DB.prepare(
    `SELECT ${attachmentColumns},
       post.author_id AS postAuthorId, post.visibility AS postVisibility,
       post.status AS postStatus, post.moderation_status AS postModerationStatus,
       post.archived_at AS postArchivedAt, post.deleted_at AS postDeletedAt,
       post_author_profile.status AS postAuthorStatus,
       attachment_owner_profile.status AS attachmentOwnerStatus
     FROM community_attachment
     LEFT JOIN community_post_attachment AS link ON link.attachment_id = community_attachment.id
     LEFT JOIN community_post AS post ON post.id = link.post_id
     LEFT JOIN community_profile AS post_author_profile ON post_author_profile.user_id = post.author_id
     LEFT JOIN community_profile AS attachment_owner_profile
       ON attachment_owner_profile.user_id = community_attachment.owner_user_id
     WHERE community_attachment.id = ? LIMIT 1`,
  )
    .bind(id)
    .first<DownloadAccessRow>();
  if (
    !row ||
    row.deletedAt !== null ||
    row.status !== "ready" ||
    row.moderationStatus !== "allow" ||
    row.attachmentOwnerStatus === null ||
    row.attachmentOwnerStatus === "deleted" ||
    !row.byteSize ||
    !row.sha256
  ) {
    return error(request, 404, "attachment_not_found", "Attachment not found");
  }
  const userId = session?.user?.id || null;
  const owner = userId === row.ownerUserId;
  const publishedPost =
    row.postAuthorId !== null &&
    row.postStatus === "published" &&
    row.postModerationStatus === "allow" &&
    row.postArchivedAt === null &&
    row.postDeletedAt === null &&
    row.postAuthorStatus !== "deleted";
  const readable =
    owner ||
    (publishedPost && (row.postVisibility === "public" || (row.postVisibility === "protected" && userId !== null)));
  if (!readable) return error(request, userId ? 403 : 401, "attachment_not_readable", "Attachment is not readable");

  const metadata = await env.COMMUNITY_UPLOADS.head(row.objectKey);
  if (!metadata || metadata.size !== row.byteSize || metadata.customMetadata?.sha256 !== row.sha256) {
    return error(request, 404, "attachment_object_missing", "Attachment object is unavailable");
  }
  const headers = new Headers({
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, no-store",
    "Content-Disposition": contentDisposition(row.fileName, row.mediaType),
    "Content-Type": row.mediaType,
    "Cross-Origin-Resource-Policy": "same-origin",
    ETag: metadata.httpEtag,
    "X-Content-Type-Options": "nosniff",
  });
  if (row.mediaType === "text/plain") headers.set("Content-Security-Policy", "sandbox; default-src 'none'");
  if (etagMatches(request.headers.get("If-None-Match"), metadata.httpEtag)) {
    return new Response(null, { status: 304, headers });
  }
  const range = parseRange(request.headers.get("Range"), metadata.size);
  if (range === "invalid") {
    headers.set("Content-Range", `bytes */${metadata.size}`);
    return new Response(null, { status: 416, headers });
  }
  if (range) {
    headers.set("Content-Length", String(range.length));
    headers.set("Content-Range", `bytes ${range.offset}-${range.offset + range.length - 1}/${metadata.size}`);
    if (request.method === "HEAD") return new Response(null, { status: 206, headers });
    const object = await env.COMMUNITY_UPLOADS.get(row.objectKey, {
      range: { length: range.length, offset: range.offset },
    });
    return object?.body
      ? new Response(object.body, { status: 206, headers })
      : error(request, 404, "attachment_object_missing", "Attachment object is unavailable");
  }
  headers.set("Content-Length", String(metadata.size));
  if (request.method === "HEAD") return new Response(null, { status: 200, headers });
  const object = await env.COMMUNITY_UPLOADS.get(row.objectKey);
  return object?.body
    ? new Response(object.body, { status: 200, headers })
    : error(request, 404, "attachment_object_missing", "Attachment object is unavailable");
};

const deleteAttachment = async (request: Request, env: Env, id: string): Promise<Response> => {
  const access = await requireActiveUser(request, env);
  if ("response" in access) return access.response;
  const attachment = await findAttachment(env, id);
  if (
    !attachment ||
    attachment.ownerUserId !== access.userId ||
    attachment.purpose !== "post" ||
    attachment.deletedAt !== null
  ) {
    return error(request, 404, "attachment_not_found", "Attachment not found");
  }
  const now = Date.now();
  const claimed = await env.DB.prepare(
    `UPDATE community_attachment
     SET status = 'deleted', deleted_at = ?, updated_at = ?
     WHERE id = ? AND owner_user_id = ? AND purpose = 'post' AND deleted_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM community_post_attachment AS link WHERE link.attachment_id = community_attachment.id
       )
       AND NOT EXISTS (
         SELECT 1 FROM community_profile_avatar AS avatar WHERE avatar.attachment_id = community_attachment.id
       )
       AND NOT EXISTS (
         SELECT 1
         FROM community_moderation_case AS moderation_case
         JOIN community_appeal AS appeal ON appeal.case_id = moderation_case.id
         WHERE moderation_case.entity_kind = 'attachment'
           AND moderation_case.entity_id = community_attachment.id
           AND appeal.status = 'pending'
       )`,
  )
    .bind(now, now, id, access.userId)
    .run();
  if (!Number(claimed.meta.changes || 0)) {
    return error(request, 409, "attachment_in_use", "Detach the file or finish its appeal before deleting it");
  }
  try {
    await env.COMMUNITY_UPLOADS.delete(attachment.objectKey);
    const objectDeletedAt = Date.now();
    await env.DB.prepare(
      `UPDATE community_attachment
       SET object_deleted_at = ?, updated_at = ?
       WHERE id = ? AND status = 'deleted' AND object_deleted_at IS NULL`,
    )
      .bind(objectDeletedAt, objectDeletedAt, id)
      .run();
  } catch (objectError) {
    console.error(
      JSON.stringify({
        event: "community.attachment.object_delete_deferred",
        attachmentId: id,
        error: objectError instanceof Error ? objectError.name : "R2DeleteError",
      }),
    );
  }
  const deleted = await findAttachment(env, id);
  return json(request, { attachment: deleted ? attachmentValue(deleted) : null });
};

const parseAttachmentIds = (value: JsonValue | undefined): string[] | null => {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_ATTACHMENTS_PER_POST) return null;
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string" || !UUID_PATTERN.test(item) || seen.has(item)) return null;
    seen.add(item);
    ids.push(item);
  }
  return ids;
};

const linkAttachments = async (request: Request, env: Env, postId: string): Promise<Response> => {
  const access = await requireActiveUser(request, env);
  if ("response" in access) return access.response;
  const body = await readJson(request);
  const attachmentIds = parseAttachmentIds(body?.attachmentIds);
  if (!attachmentIds) return error(request, 422, "invalid_attachment_ids", "Provide 1-10 unique attachment IDs");
  const post = await env.DB.prepare(
    `SELECT author_id AS authorId FROM community_post WHERE id = ? AND deleted_at IS NULL LIMIT 1`,
  )
    .bind(postId)
    .first<PostOwnerRow>();
  if (!post || post.authorId !== access.userId) return error(request, 404, "post_not_found", "Post not found");

  const existing = await env.DB.prepare(
    `SELECT attachment_id AS attachmentId, position
     FROM community_post_attachment WHERE post_id = ? ORDER BY position`,
  )
    .bind(postId)
    .all<LinkedAttachmentRow>();
  const existingIds = new Set(existing.results.map((item) => item.attachmentId));
  const additions = attachmentIds.filter((id) => !existingIds.has(id));
  if (existing.results.length + additions.length > MAX_ATTACHMENTS_PER_POST) {
    return error(request, 422, "too_many_attachments", "A post may contain at most 10 attachments");
  }
  if (additions.length) {
    const placeholders = additions.map(() => "?").join(", ");
    const candidates = await env.DB.prepare(
      `SELECT id FROM community_attachment
       WHERE id IN (${placeholders}) AND owner_user_id = ? AND purpose = 'post'
         AND status = 'ready' AND moderation_status = 'allow' AND deleted_at IS NULL`,
    )
      .bind(...additions, access.userId)
      .all<AttachmentCandidateRow>();
    if (candidates.results.length !== additions.length) {
      return error(request, 409, "attachment_not_ready", "Every attachment must be owned by you, ready, and allowed");
    }
    const now = Date.now();
    const inputRows = additions.map(() => "(?, ?)").join(", ");
    const inputValues = additions.flatMap((id, index) => [id, existing.results.length + index]);
    await env.DB.prepare(
      `WITH input(attachment_id, position) AS (VALUES ${inputRows})
       INSERT INTO community_post_attachment (post_id, attachment_id, position, created_at)
       SELECT ?, input.attachment_id, input.position, ?
       FROM input
       ORDER BY input.position`,
    )
      .bind(...inputValues, postId, now)
      .run();
  }
  const linked = await env.DB.prepare(
    `SELECT ${attachmentColumns}
     FROM community_attachment
     JOIN community_post_attachment AS link ON link.attachment_id = community_attachment.id
     WHERE link.post_id = ? ORDER BY link.position`,
  )
    .bind(postId)
    .all<AttachmentRow>();
  return json(request, { attachments: linked.results.map(attachmentValue) });
};

const unlinkAttachment = async (
  request: Request,
  env: Env,
  postId: string,
  attachmentId: string,
): Promise<Response> => {
  const access = await requireActiveUser(request, env);
  if ("response" in access) return access.response;
  const post = await env.DB.prepare(
    `SELECT author_id AS authorId FROM community_post WHERE id = ? AND deleted_at IS NULL LIMIT 1`,
  )
    .bind(postId)
    .first<PostOwnerRow>();
  if (!post || post.authorId !== access.userId) return error(request, 404, "post_not_found", "Post not found");
  const result = await env.DB.prepare("DELETE FROM community_post_attachment WHERE post_id = ? AND attachment_id = ?")
    .bind(postId, attachmentId)
    .run();
  if (Number(result.meta.changes || 0) === 0) {
    return error(request, 404, "attachment_link_not_found", "Attachment link not found");
  }
  return json(request, { attachmentId, detached: true, postId });
};

export const cleanupCommunityUploads = async (env: Env): Promise<void> => {
  const claimedAt = Date.now();
  const retryBefore = claimedAt - CLEANUP_RETRY_DELAY_MS;
  const reviewBefore = claimedAt - CLEANUP_REVIEW_RETENTION_MS;
  const claimed = await env.DB.prepare(
    `WITH cleanup_candidates AS (
       SELECT attachment.id
       FROM community_attachment AS attachment
       WHERE attachment.object_deleted_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM community_profile AS owner_profile
           WHERE owner_profile.user_id = attachment.owner_user_id
             AND owner_profile.status = 'deleted'
         )
         AND (
           (attachment.status = 'deleted' AND attachment.updated_at < ?)
           OR (attachment.status = 'reserved' AND attachment.expires_at < ?)
           OR (attachment.status IN ('scanning', 'ready') AND attachment.expires_at < ?)
           OR (attachment.status IN ('rejected', 'review') AND attachment.updated_at < ?)
         )
         AND NOT EXISTS (
           SELECT 1 FROM community_post_attachment AS link WHERE link.attachment_id = attachment.id
         )
         AND NOT EXISTS (
           SELECT 1 FROM community_profile_avatar AS avatar WHERE avatar.attachment_id = attachment.id
         )
         AND NOT EXISTS (
           SELECT 1
           FROM community_moderation_case AS moderation_case
           JOIN community_appeal AS appeal ON appeal.case_id = moderation_case.id
           WHERE moderation_case.entity_kind = 'attachment'
             AND moderation_case.entity_id = attachment.id
             AND appeal.status = 'pending'
         )
       ORDER BY attachment.updated_at ASC, attachment.id ASC
       LIMIT 100
     )
     UPDATE community_attachment
     SET status = 'deleted', deleted_at = COALESCE(deleted_at, ?), updated_at = ?
     WHERE id IN (SELECT id FROM cleanup_candidates)
     RETURNING id, object_key AS objectKey`,
  )
    .bind(retryBefore, claimedAt, claimedAt, reviewBefore, claimedAt, claimedAt)
    .all<CleanupRow>();
  const deletedIds: string[] = [];
  for (const row of claimed.results) {
    try {
      await env.COMMUNITY_UPLOADS.delete(row.objectKey);
      deletedIds.push(row.id);
    } catch (deleteError) {
      console.error(
        JSON.stringify({
          attachmentId: row.id,
          errorName: deleteError instanceof Error ? deleteError.name : "R2DeleteError",
          event: "community.upload_cleanup_failed",
        }),
      );
    }
  }
  if (!deletedIds.length) return;
  const deletedAt = Date.now();
  await env.DB.prepare(
    `UPDATE community_attachment
     SET object_deleted_at = ?, updated_at = ?
     WHERE id IN (SELECT value FROM json_each(?))
       AND status = 'deleted' AND object_deleted_at IS NULL`,
  )
    .bind(deletedAt, deletedAt, JSON.stringify(deletedIds))
    .run();
};

export const handleUploadRequest = async (request: Request, env: Env): Promise<Response | null> => {
  const url = new URL(request.url);
  const managedPrefix = `${PREFIX}/uploads`;
  const attachmentsPrefix = `${PREFIX}/attachments`;
  const postAttachmentPattern = new RegExp(`^${PREFIX}/posts/([0-9a-f-]{36})/attachments(?:/([0-9a-f-]{36}))?$`, "iu");
  if (
    url.pathname !== `${managedPrefix}/intents` &&
    !url.pathname.startsWith(`${managedPrefix}/`) &&
    url.pathname !== attachmentsPrefix &&
    !url.pathname.startsWith(`${attachmentsPrefix}/`) &&
    !postAttachmentPattern.test(url.pathname)
  ) {
    return null;
  }
  if (!env.DB || !env.COMMUNITY_UPLOADS) {
    return error(request, 503, "upload_unavailable", "Upload storage is not configured");
  }
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: { Allow: "GET, HEAD, POST, PUT, DELETE, OPTIONS" } });
  }
  if (!new Set(["GET", "HEAD"]).has(request.method) && !isSameOrigin(request)) {
    return error(request, 403, "cross_origin_request", "Cross-origin writes are not allowed");
  }
  if (url.pathname === `${managedPrefix}/intents`) {
    return request.method === "POST"
      ? createIntent(request, env)
      : error(request, 405, "method_not_allowed", "Method not allowed");
  }
  const uploadMatch = new RegExp(`^${managedPrefix}/([0-9a-f-]{36})/content$`, "iu").exec(url.pathname);
  if (uploadMatch?.[1] && UUID_PATTERN.test(uploadMatch[1])) {
    return request.method === "PUT"
      ? putContent(request, env, uploadMatch[1])
      : error(request, 405, "method_not_allowed", "Method not allowed");
  }
  const contentMatch = new RegExp(`^${attachmentsPrefix}/([0-9a-f-]{36})/content$`, "iu").exec(url.pathname);
  if (contentMatch?.[1] && UUID_PATTERN.test(contentMatch[1])) {
    return request.method === "GET" || request.method === "HEAD"
      ? downloadAttachment(request, env, contentMatch[1])
      : error(request, 405, "method_not_allowed", "Method not allowed");
  }
  const attachmentMatch = new RegExp(`^${attachmentsPrefix}/([0-9a-f-]{36})$`, "iu").exec(url.pathname);
  if (attachmentMatch?.[1] && UUID_PATTERN.test(attachmentMatch[1])) {
    if (request.method === "GET" || request.method === "HEAD") return getMetadata(request, env, attachmentMatch[1]);
    if (request.method === "DELETE") return deleteAttachment(request, env, attachmentMatch[1]);
    return error(request, 405, "method_not_allowed", "Method not allowed");
  }
  const postAttachmentMatch = postAttachmentPattern.exec(url.pathname);
  if (postAttachmentMatch?.[1] && UUID_PATTERN.test(postAttachmentMatch[1])) {
    if (!postAttachmentMatch[2] && request.method === "POST") {
      return linkAttachments(request, env, postAttachmentMatch[1]);
    }
    if (postAttachmentMatch[2] && UUID_PATTERN.test(postAttachmentMatch[2]) && request.method === "DELETE") {
      return unlinkAttachment(request, env, postAttachmentMatch[1], postAttachmentMatch[2]);
    }
    return error(request, 405, "method_not_allowed", "Method not allowed");
  }
  return error(request, 404, "route_not_found", "Upload API route not found");
};
