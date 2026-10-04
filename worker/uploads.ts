import { forumReadSql, forumPermissionSql, canAccessAttachmentForum } from "./community-forums";
import { COMMUNITY_UPLOAD_LIMITS } from "../src/config/community";
import { getAuthSession } from "./auth";
import { communityAccessState } from "./access";
import { enqueueNativeMediaJob, retryNativeMediaJob, cleanupNativeMediaStorage, mediaPresentation, type MediaVariantRow } from "./community-media";
import { inspectCommunityText, type TextInspection } from "./moderation";

type UploadMediaType =
  | "image/jpeg"
  | "image/png"
  | "image/webp"
  | "image/gif"
  | "image/heic"
  | "image/heif"
  | "video/mp4"
  | "video/webm"
  | "video/quicktime"
  | "text/plain";
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
  height: number | null;
  id: string;
  idempotencyKey: string;
  mediaType: UploadMediaType;
  moderationStatus: AttachmentModerationStatus;
  objectKey: string;
  ownerUserId: string;
  purpose: "avatar" | "post";
  r2UploadId: string | null;
  r2Etag: string | null;
  r2Version: string | null;
  sha256: string | null;
  status: AttachmentStatus;
  updatedAt: number;
  width: number | null;
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
  r2UploadId: string | null;
}

interface JsonObject {
  [key: string]: JsonValue;
}
type JsonValue = boolean | JsonObject | JsonValue[] | null | number | string;

interface UploadInspection {
  height: number | null;
  inspection: TextInspection;
  ok: boolean;
  reason?: string;
  width: number | null;
}

interface ImageDimensions {
  height: number;
  width: number;
}

export interface ImageLimits {
  maximumDimension: number;
  maximumPixels: number;
}

const PREFIX = "/api/v1/community";
const INTENT_TTL_MS = 15 * 60 * 1_000;
const UNATTACHED_TTL_MS = 24 * 60 * 60 * 1_000;
const CLEANUP_RETRY_DELAY_MS = 5 * 60 * 1_000;
const CLEANUP_REVIEW_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_ATTACHMENTS_PER_POST = COMMUNITY_UPLOAD_LIMITS.attachmentsPerPost;
const MULTIPART_PART_SIZE = COMMUNITY_UPLOAD_LIMITS.partBytes;
const DIRECT_UPLOAD_MAX_BYTES = MULTIPART_PART_SIZE;
const JSON_BODY_LIMIT = 16 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/u;

const POLICIES: Readonly<Record<UploadMediaType, UploadPolicy>> = Object.freeze({
  "image/jpeg": { extensions: new Set([".jpeg", ".jpg"]), maximumBytes: COMMUNITY_UPLOAD_LIMITS.fileBytes },
  "image/png": { extensions: new Set([".png"]), maximumBytes: COMMUNITY_UPLOAD_LIMITS.fileBytes },
  "image/webp": { extensions: new Set([".webp"]), maximumBytes: COMMUNITY_UPLOAD_LIMITS.fileBytes },
  "image/gif": { extensions: new Set([".gif"]), maximumBytes: COMMUNITY_UPLOAD_LIMITS.fileBytes },
  "image/heic": { extensions: new Set([".heic"]), maximumBytes: COMMUNITY_UPLOAD_LIMITS.fileBytes },
  "image/heif": { extensions: new Set([".heif"]), maximumBytes: COMMUNITY_UPLOAD_LIMITS.fileBytes },
  "video/mp4": { extensions: new Set([".mp4"]), maximumBytes: COMMUNITY_UPLOAD_LIMITS.fileBytes },
  "video/webm": { extensions: new Set([".webm"]), maximumBytes: COMMUNITY_UPLOAD_LIMITS.fileBytes },
  "video/quicktime": { extensions: new Set([".mov"]), maximumBytes: COMMUNITY_UPLOAD_LIMITS.fileBytes },
  // Historical text attachments remain readable, but new text intents are rejected.
  "text/plain": { extensions: new Set([".txt"]), maximumBytes: COMMUNITY_UPLOAD_LIMITS.fileBytes },
});

const NEW_UPLOAD_MEDIA_TYPES: ReadonlySet<UploadMediaType> = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/heic",
  "image/heif",
  "video/mp4",
  "video/webm",
  "video/quicktime",
]);
const RASTER_MEDIA_TYPES: ReadonlySet<UploadMediaType> = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/heic",
  "image/heif",
]);

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
  community_attachment.width,
  community_attachment.height,
  community_attachment.sha256,
  community_attachment.r2_upload_id AS r2UploadId,
  community_attachment.r2_etag AS r2Etag,
  community_attachment.r2_version AS r2Version,
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

const isUploadMediaType = (value: string): value is UploadMediaType =>
  NEW_UPLOAD_MEDIA_TYPES.has(value as UploadMediaType);

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
  width: row.width,
  height: row.height,
  status: row.status,
  moderationStatus: row.moderationStatus,
  createdAt: row.createdAt,
  expiresAt: row.expiresAt,
  uploadUrl: row.status === "reserved" ? `${PREFIX}/uploads/${row.id}/content` : null,
  multipart:
    row.status === "reserved" && row.r2UploadId
      ? {
          partSize: MULTIPART_PART_SIZE,
          partCount: Math.ceil(row.declaredSize / MULTIPART_PART_SIZE),
          partUploadUrl: `${PREFIX}/uploads/${row.id}/parts/{partNumber}`,
          completeUrl: `${PREFIX}/uploads/${row.id}/complete`,
          cancelUrl: `${PREFIX}/uploads/${row.id}/multipart`,
        }
      : null,
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
    return error(
      request,
      415,
      "unsupported_file",
      "Only JPEG, PNG, WebP, GIF, HEIC, MP4, MOV, and WebM files are supported",
    );
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
  let multipart: R2MultipartUpload;
  try {
    multipart = await env.COMMUNITY_UPLOADS.createMultipartUpload(objectKey, {
      httpMetadata: {
        cacheControl: "private, no-store",
        contentDisposition: contentDisposition(fileName, mediaType),
        contentType: mediaType,
      },
      customMetadata: { attachmentId: id, declaredSize: String(rawSize), ownerUserId: access.userId },
    });
  } catch (storageError) {
    console.error(
      JSON.stringify({
        event: "community.upload.multipart_create_failed",
        attachmentId: id,
        error: storageError instanceof Error ? storageError.name : "R2MultipartCreateError",
      }),
    );
    return error(request, 503, "upload_storage_unavailable", "Upload storage is temporarily unavailable");
  }
  let inserted: D1Result;
  try {
    inserted = await env.DB.prepare(
      `INSERT OR IGNORE INTO community_attachment
         (id, owner_user_id, purpose, idempotency_key, object_key, r2_upload_id, original_name, media_type,
          declared_size, status, moderation_status, expires_at, created_at, updated_at)
       VALUES (?, ?, 'post', ?, ?, ?, ?, ?, ?, 'reserved', 'pending', ?, ?, ?)`,
    )
      .bind(
        id,
        access.userId,
        idempotencyKey,
        objectKey,
        multipart.uploadId,
        fileName,
        mediaType,
        rawSize,
        expiresAt,
        now,
        now,
      )
      .run();
  } catch (databaseError) {
    await multipart.abort().catch(() => undefined);
    console.error(
      JSON.stringify({
        event: "community.upload.intent_persist_failed",
        attachmentId: id,
        error: databaseError instanceof Error ? databaseError.name : "D1InsertError",
      }),
    );
    return error(request, 503, "upload_state_unavailable", "Upload intent could not be persisted");
  }
  if (Number(inserted.meta.changes || 0) === 0) {
    await multipart.abort().catch(() => undefined);
    const raced = await env.DB.prepare(`${attachmentSelect} WHERE owner_user_id = ? AND idempotency_key = ? LIMIT 1`)
      .bind(access.userId, idempotencyKey)
      .first<AttachmentRow>();
    if (raced && raced.fileName === fileName && raced.mediaType === mediaType && raced.declaredSize === rawSize) {
      return json(request, { attachment: attachmentValue(raced) });
    }
    if (raced) return error(request, 409, "idempotency_conflict", "This Idempotency-Key was used for a different file");
    throw new Error("Upload intent was not reserved despite no idempotency conflict");
  }
  const attachment = await findAttachment(env, id);
  if (!attachment) throw new Error("Upload intent was not persisted");
  return json(request, { attachment: attachmentValue(attachment) }, 201, { Location: `${PREFIX}/attachments/${id}` });
};

const startsWith = (bytes: Uint8Array, signature: readonly number[]): boolean =>
  signature.every((value, index) => bytes[index] === value);

// Community attachments have no policy pixel or dimension ceiling. The limits
// object remains configurable because avatars use a stricter explicit policy.
const DEFAULT_IMAGE_LIMITS: ImageLimits = {
  maximumDimension: Number.MAX_SAFE_INTEGER,
  maximumPixels: Number.MAX_SAFE_INTEGER,
};

const ascii = (bytes: Uint8Array, offset: number, length: number): string =>
  String.fromCharCode(...bytes.subarray(offset, offset + length));

const dimensionsAllowed = (width: number, height: number, limits: ImageLimits): boolean =>
  Number.isSafeInteger(width) &&
  Number.isSafeInteger(height) &&
  width > 0 &&
  height > 0 &&
  width <= limits.maximumDimension &&
  height <= limits.maximumDimension &&
  (limits.maximumPixels === Number.MAX_SAFE_INTEGER ||
    (Number.isSafeInteger(width * height) && width * height <= limits.maximumPixels));

const inspectPngContainer = (bytes: Uint8Array, limits: ImageLimits): ImageDimensions | string => {
  if (!startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) || bytes.length < 45) {
    return "invalid_png_container";
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  let dimensionsSeen = false;
  let dimensions: ImageDimensions | null = null;
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
      dimensions = { height, width };
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
  return dimensionsSeen && endSeen && dimensions ? dimensions : "invalid_png_container";
};

const JPEG_SOF_MARKERS: ReadonlySet<number> = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

const hasBytes = (offset: number, length: number, total: number): boolean =>
  Number.isSafeInteger(offset) &&
  Number.isSafeInteger(length) &&
  offset >= 0 &&
  length >= 0 &&
  offset <= total &&
  length <= total - offset;

const readExifOrientation = (bytes: Uint8Array): number | "invalid" | null => {
  if (bytes.length < 6 || !startsWith(bytes, [0x45, 0x78, 0x69, 0x66, 0x00, 0x00])) return null;
  const tiffOffset = 6;
  if (!hasBytes(tiffOffset, 8, bytes.length)) return "invalid";
  const littleEndian = startsWith(bytes.subarray(tiffOffset), [0x49, 0x49])
    ? true
    : startsWith(bytes.subarray(tiffOffset), [0x4d, 0x4d])
      ? false
      : null;
  if (littleEndian === null) return "invalid";
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(tiffOffset + 2, littleEndian) !== 42) return "invalid";
  const ifdOffset = view.getUint32(tiffOffset + 4, littleEndian);
  if (!hasBytes(tiffOffset + ifdOffset, 2, bytes.length)) return "invalid";
  const entryCountOffset = tiffOffset + ifdOffset;
  const entryCount = view.getUint16(entryCountOffset, littleEndian);
  const entriesOffset = entryCountOffset + 2;
  if (entryCount > Math.floor((bytes.length - entriesOffset) / 12)) return "invalid";
  for (let index = 0; index < entryCount; index += 1) {
    const entryOffset = entriesOffset + index * 12;
    const tag = view.getUint16(entryOffset, littleEndian);
    if (tag !== 0x0112) continue;
    const type = view.getUint16(entryOffset + 2, littleEndian);
    const count = view.getUint32(entryOffset + 4, littleEndian);
    if (type !== 3 || count !== 1) return "invalid";
    const orientation = view.getUint16(entryOffset + 8, littleEndian);
    return orientation >= 1 && orientation <= 8 ? orientation : "invalid";
  }
  return null;
};

const inspectJpegContainer = (bytes: Uint8Array, limits: ImageLimits): ImageDimensions | string => {
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
  let dimensions: ImageDimensions | null = null;
  let orientation = 1;
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
    if (marker === 0xe1) {
      const exifOrientation = readExifOrientation(bytes.subarray(offset + 2, offset + length));
      if (exifOrientation === "invalid") return "invalid_jpeg_container";
      if (typeof exifOrientation === "number") orientation = exifOrientation;
    }
    if (JPEG_SOF_MARKERS.has(marker)) {
      if (length < 7) return "invalid_jpeg_container";
      const height = view.getUint16(offset + 3, false);
      const width = view.getUint16(offset + 5, false);
      if (!dimensionsAllowed(width, height, limits)) return "image_dimensions_exceeded";
      if (!dimensions) dimensions = { height, width };
      dimensionsSeen = true;
    }
    if (marker === 0xda) break;
    offset += length;
  }
  if (!dimensionsSeen || !dimensions) return "invalid_jpeg_container";
  return orientation >= 5 && orientation <= 8 ? { height: dimensions.width, width: dimensions.height } : dimensions;
};

const inspectWebpContainer = (bytes: Uint8Array, limits: ImageLimits): ImageDimensions | string => {
  if (bytes.length < 30 || ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WEBP") {
    return "invalid_webp_container";
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(4, true) + 8 !== bytes.length) return "invalid_webp_container";
  let offset = 12;
  let dimensionsSeen = false;
  let dimensions: ImageDimensions | null = null;
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
      if (!dimensions) dimensions = { height, width };
      dimensionsSeen = true;
    } else if (type === "VP8 ") {
      if (length < 10 || !startsWith(bytes.subarray(dataOffset + 3), [0x9d, 0x01, 0x2a])) {
        return "invalid_webp_container";
      }
      const width = view.getUint16(dataOffset + 6, true) & 0x3fff;
      const height = view.getUint16(dataOffset + 8, true) & 0x3fff;
      if (!dimensionsAllowed(width, height, limits)) return "image_dimensions_exceeded";
      if (!dimensions) dimensions = { height, width };
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
      if (!dimensions) dimensions = { height, width };
      dimensionsSeen = true;
    }
    offset = dataOffset + length + (length % 2);
  }
  return dimensionsSeen && offset === bytes.length && dimensions ? dimensions : "invalid_webp_container";
};

const inspectGifContainer = (bytes: Uint8Array, limits: ImageLimits): ImageDimensions | string => {
  if (
    bytes.length < 13 ||
    !(
      startsWith(bytes, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) || startsWith(bytes, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
    ) ||
    bytes[bytes.length - 1] !== 0x3b
  ) {
    return "invalid_gif_container";
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint16(6, true);
  const height = view.getUint16(8, true);
  return dimensionsAllowed(width, height, limits) ? { height, width } : "image_dimensions_exceeded";
};

const inspectBmffHeader = (
  bytes: Uint8Array,
  mediaType: "image/heic" | "image/heif" | "video/mp4" | "video/quicktime",
): ImageDimensions | string => {
  if (bytes.length < 16 || ascii(bytes, 4, 4) !== "ftyp") return `invalid_${mediaType.replace("/", "_")}_container`;
  const boxSize = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, false);
  if (boxSize < 16 || boxSize > bytes.length) return `invalid_${mediaType.replace("/", "_")}_container`;
  const majorBrand = ascii(bytes, 8, 4);
  const imageBrands = new Set(["heic", "heix", "hevc", "hevx", "mif1", "msf1"]);
  const videoBrands = new Set(["isom", "iso2", "iso3", "iso4", "iso5", "iso6", "avc1", "mp41", "mp42", "qt  "]);
  const compatible = new Set<string>();
  for (let offset = 16; offset + 4 <= bytes.length; offset += 4) compatible.add(ascii(bytes, offset, 4));
  if (
    mediaType.startsWith("image/") &&
    !imageBrands.has(majorBrand) &&
    ![...compatible].some((brand) => imageBrands.has(brand))
  ) {
    return "invalid_heic_container";
  }
  if (
    mediaType.startsWith("video/") &&
    !videoBrands.has(majorBrand) &&
    ![...compatible].some((brand) => videoBrands.has(brand))
  ) {
    return "invalid_video_container";
  }
  if (mediaType.startsWith("image/")) {
    // HEIF dimensions are carried by an `ispe` property. Require them when
    // available and reject explicit zero dimensions; a later moderation pass
    // may keep a valid HEIF without a parsable display property in review.
    for (let offset = 0; offset + 16 <= bytes.length; offset += 1) {
      if (ascii(bytes, offset, 4) !== "ispe") continue;
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const width = view.getUint32(offset + 8, false);
      const height = view.getUint32(offset + 12, false);
      if (!width || !height) return "invalid_image_dimensions";
      return { height, width };
    }
    return "invalid_image_dimensions";
  }
  return { width: 1, height: 1 };
};

const inspectWebmContainer = (bytes: Uint8Array): ImageDimensions | string =>
  bytes.length >= 4 && startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3]) ? { width: 1, height: 1 } : "invalid_webm_container";

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
    return { height: null, inspection: clean, ok: false, reason: "forbidden_container", width: null };
  }
  if (mediaType === "image/jpeg") {
    const result = inspectJpegContainer(bytes, limits);
    return typeof result === "string"
      ? { height: null, inspection: clean, ok: false, reason: result, width: null }
      : { height: result.height, inspection: clean, ok: true, width: result.width };
  }
  if (mediaType === "image/png") {
    const result = inspectPngContainer(bytes, limits);
    return typeof result === "string"
      ? { height: null, inspection: clean, ok: false, reason: result, width: null }
      : { height: result.height, inspection: clean, ok: true, width: result.width };
  }
  if (mediaType === "image/webp") {
    const result = inspectWebpContainer(bytes, limits);
    return typeof result === "string"
      ? { height: null, inspection: clean, ok: false, reason: result, width: null }
      : { height: result.height, inspection: clean, ok: true, width: result.width };
  }
  if (mediaType === "image/gif") {
    const result = inspectGifContainer(bytes, limits);
    return typeof result === "string"
      ? { height: null, inspection: clean, ok: false, reason: result, width: null }
      : { height: result.height, inspection: clean, ok: true, width: result.width };
  }
  if (mediaType === "image/heic" || mediaType === "image/heif") {
    const result = inspectBmffHeader(bytes, mediaType);
    return typeof result === "string"
      ? { height: null, inspection: clean, ok: false, reason: result, width: null }
      : { height: result.height, inspection: clean, ok: true, width: result.width };
  }
  if (mediaType === "video/mp4" || mediaType === "video/quicktime") {
    const result = inspectBmffHeader(bytes, mediaType);
    return typeof result === "string"
      ? { height: null, inspection: clean, ok: false, reason: result, width: null }
      : { height: null, inspection: clean, ok: true, width: null };
  }
  if (mediaType === "video/webm") {
    const result = inspectWebmContainer(bytes);
    return typeof result === "string"
      ? { height: null, inspection: clean, ok: false, reason: result, width: null }
      : { height: null, inspection: clean, ok: true, width: null };
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
    if (/^\s*(?:<!doctype\s+html\b|<html\b)/iu.test(text)) {
      return { height: null, inspection: clean, ok: false, reason: "html_is_not_allowed", width: null };
    }
    return { height: null, inspection: inspectCommunityText(text), ok: true, width: null };
  } catch {
    return { height: null, inspection: clean, ok: false, reason: "invalid_utf8_text", width: null };
  }
};

const IMAGE_PROBE_BYTES = 1 * 1024 * 1024;
const TAIL_PROBE_BYTES = 64;

const inspectCompletedMedia = (
  mediaType: UploadMediaType,
  prefix: Uint8Array,
  tail: Uint8Array,
  totalSize: number,
): { height: number | null; width: number | null; reason?: string } => {
  if (totalSize <= IMAGE_PROBE_BYTES) {
    const complete = new Uint8Array(totalSize);
    complete.set(prefix.subarray(0, totalSize));
    const result = inspectUploadBytes(mediaType, complete);
    return result.ok
      ? { height: result.height, width: result.width }
      : { height: null, reason: result.reason || "invalid_file_signature", width: null };
  }
  if (mediaType === "image/jpeg") {
    if (!startsWith(prefix, [0xff, 0xd8]) || !startsWith(tail.subarray(Math.max(0, tail.length - 2)), [0xff, 0xd9])) {
      return { height: null, reason: "invalid_jpeg_container", width: null };
    }
    const view = new DataView(prefix.buffer, prefix.byteOffset, prefix.byteLength);
    let offset = 2;
    while (offset + 8 < prefix.length) {
      if (prefix[offset] !== 0xff) return { height: null, reason: "invalid_jpeg_container", width: null };
      while (prefix[offset] === 0xff) offset += 1;
      const marker = prefix[offset++];
      if (marker === undefined) break;
      if (marker === 0xda) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) continue;
      if (offset + 2 > prefix.length) break;
      const length = view.getUint16(offset, false);
      if (length < 2 || offset + length > prefix.length) break;
      if (JPEG_SOF_MARKERS.has(marker)) {
        if (length < 7) return { height: null, reason: "invalid_jpeg_container", width: null };
        const height = view.getUint16(offset + 3, false);
        const width = view.getUint16(offset + 5, false);
        return dimensionsAllowed(width, height, DEFAULT_IMAGE_LIMITS)
          ? { height, width }
          : { height: null, reason: "invalid_image_dimensions", width: null };
      }
      offset += length;
    }
    return { height: null, reason: "invalid_jpeg_container", width: null };
  }
  if (mediaType === "image/png") {
    if (!startsWith(prefix, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) || prefix.length < 26) {
      return { height: null, reason: "invalid_png_container", width: null };
    }
    const view = new DataView(prefix.buffer, prefix.byteOffset, prefix.byteLength);
    if (ascii(prefix, 12, 4) !== "IHDR" || view.getUint32(8, false) !== 13) {
      return { height: null, reason: "invalid_png_container", width: null };
    }
    const width = view.getUint32(16, false);
    const height = view.getUint32(20, false);
    if (!dimensionsAllowed(width, height, DEFAULT_IMAGE_LIMITS)) {
      return { height: null, reason: "invalid_image_dimensions", width: null };
    }
    if (prefix.includes(0x61) && prefix.includes(0x63) && prefix.includes(0x54) && prefix.includes(0x4c)) {
      return { height: null, reason: "animated_images_not_allowed", width: null };
    }
    if (tail.length < 12 || !startsWith(tail.subarray(tail.length - 12), [0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44])) {
      return { height: null, reason: "invalid_png_container", width: null };
    }
    return { height, width };
  }
  if (mediaType === "image/gif") {
    if (
      !(
        startsWith(prefix, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) ||
        startsWith(prefix, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
      ) ||
      tail[tail.length - 1] !== 0x3b
    ) {
      return { height: null, reason: "invalid_gif_container", width: null };
    }
    const view = new DataView(prefix.buffer, prefix.byteOffset, prefix.byteLength);
    const width = view.getUint16(6, true);
    const height = view.getUint16(8, true);
    return dimensionsAllowed(width, height, DEFAULT_IMAGE_LIMITS)
      ? { height, width }
      : { height: null, reason: "invalid_image_dimensions", width: null };
  }
  if (mediaType === "image/webp") {
    if (prefix.length < 16 || ascii(prefix, 0, 4) !== "RIFF" || ascii(prefix, 8, 4) !== "WEBP") {
      return { height: null, reason: "invalid_webp_container", width: null };
    }
    const view = new DataView(prefix.buffer, prefix.byteOffset, prefix.byteLength);
    if (view.getUint32(4, true) + 8 !== totalSize) {
      return { height: null, reason: "invalid_webp_container", width: null };
    }
    let offset = 12;
    while (offset + 8 <= prefix.length) {
      const type = ascii(prefix, offset, 4);
      const length = view.getUint32(offset + 4, true);
      const dataOffset = offset + 8;
      if (length > prefix.length - dataOffset) break;
      if (type === "ANIM" || type === "ANMF")
        return { height: null, reason: "animated_images_not_allowed", width: null };
      if (type === "VP8X") {
        if (length < 10) return { height: null, reason: "invalid_webp_container", width: null };
        const width = 1 + view.getUint16(dataOffset + 4, true) + ((prefix[dataOffset + 6] ?? 0) << 16);
        const height = 1 + view.getUint16(dataOffset + 7, true) + ((prefix[dataOffset + 9] ?? 0) << 16);
        return dimensionsAllowed(width, height, DEFAULT_IMAGE_LIMITS)
          ? { height, width }
          : { height: null, reason: "invalid_image_dimensions", width: null };
      }
      if (type === "VP8 ") {
        if (length < 10 || !startsWith(prefix.subarray(dataOffset + 3), [0x9d, 0x01, 0x2a])) {
          return { height: null, reason: "invalid_webp_container", width: null };
        }
        const width = view.getUint16(dataOffset + 6, true) & 0x3fff;
        const height = view.getUint16(dataOffset + 8, true) & 0x3fff;
        return dimensionsAllowed(width, height, DEFAULT_IMAGE_LIMITS)
          ? { height, width }
          : { height: null, reason: "invalid_image_dimensions", width: null };
      }
      if (type === "VP8L") {
        if (length < 5 || prefix[dataOffset] !== 0x2f)
          return { height: null, reason: "invalid_webp_container", width: null };
        const b1 = prefix[dataOffset + 1] ?? 0;
        const b2 = prefix[dataOffset + 2] ?? 0;
        const b3 = prefix[dataOffset + 3] ?? 0;
        const b4 = prefix[dataOffset + 4] ?? 0;
        const width = 1 + b1 + ((b2 & 0x3f) << 8);
        const height = 1 + (b2 >> 6) + (b3 << 2) + ((b4 & 0x0f) << 10);
        return dimensionsAllowed(width, height, DEFAULT_IMAGE_LIMITS)
          ? { height, width }
          : { height: null, reason: "invalid_image_dimensions", width: null };
      }
      offset = dataOffset + length + (length % 2);
    }
    return { height: null, reason: "invalid_webp_container", width: null };
  }
  if (mediaType === "image/heic" || mediaType === "image/heif") {
    const result = inspectBmffHeader(prefix, mediaType);
    return typeof result === "string" ? { height: null, reason: result, width: null } : result;
  }
  if (mediaType === "video/mp4" || mediaType === "video/quicktime") {
    const result = inspectBmffHeader(prefix, mediaType);
    return typeof result === "string" ? { height: null, reason: result, width: null } : { height: null, width: null };
  }
  if (mediaType === "video/webm" && typeof inspectWebmContainer(prefix) === "string") {
    return { height: null, reason: "invalid_webm_container", width: null };
  }
  return { height: null, width: null };
};

interface CompletedObjectInspection {
  digestHex: string;
  height: number | null;
  width: number | null;
}

const inspectCompletedObject = async (env: Env, attachment: AttachmentRow): Promise<CompletedObjectInspection> => {
  const object = await env.COMMUNITY_UPLOADS.get(attachment.objectKey);
  if (
    !object?.body ||
    object.size !== attachment.declaredSize ||
    object.customMetadata?.attachmentId !== attachment.id
  ) {
    throw new Error("completed_object_integrity_mismatch");
  }
  const digest = new StreamingSha256();
  const prefix = new Uint8Array(Math.min(IMAGE_PROBE_BYTES, attachment.declaredSize));
  let prefixLength = 0;
  let tail = new Uint8Array(0);
  let size = 0;
  const reader = object.body.getReader();
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      digest.update(part.value);
      size += part.value.byteLength;
      if (prefixLength < prefix.length) {
        const copied = Math.min(prefix.length - prefixLength, part.value.byteLength);
        prefix.set(part.value.subarray(0, copied), prefixLength);
        prefixLength += copied;
      }
      const merged = new Uint8Array(Math.min(TAIL_PROBE_BYTES, tail.length + part.value.byteLength));
      const previousOffset = Math.max(
        0,
        tail.length - (merged.length - Math.min(part.value.byteLength, merged.length)),
      );
      if (tail.length) merged.set(tail.subarray(previousOffset), 0);
      const copiedPart = Math.min(part.value.byteLength, merged.length);
      merged.set(part.value.subarray(part.value.byteLength - copiedPart), merged.length - copiedPart);
      tail = merged;
    }
  } finally {
    reader.releaseLock();
  }
  if (size !== attachment.declaredSize) throw new Error("completed_object_size_mismatch");
  const media = inspectCompletedMedia(attachment.mediaType, prefix.subarray(0, prefixLength), tail, size);
  if (media.reason) throw new Error(media.reason);
  return { digestHex: hexBytes(digest.digest()), height: media.height, width: media.width };
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

const hexBytes = (bytes: Uint8Array): string => [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");

// Web Crypto's digest API accepts only a complete ArrayBuffer. Multipart
// completion therefore uses a small incremental SHA-256 implementation while
// reading the completed R2 object stream. Its only retained input is one
// 64-byte block, so a 128 MiB object never enters Worker memory at once.
class StreamingSha256 {
  private readonly state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  private readonly pending = new Uint8Array(64);
  private pendingLength = 0;
  private totalBytes = 0;

  update(input: Uint8Array): void {
    this.totalBytes += input.byteLength;
    let offset = 0;
    if (this.pendingLength) {
      const needed = 64 - this.pendingLength;
      const copied = Math.min(needed, input.byteLength);
      this.pending.set(input.subarray(0, copied), this.pendingLength);
      this.pendingLength += copied;
      offset += copied;
      if (this.pendingLength === 64) {
        this.compress(this.pending);
        this.pendingLength = 0;
      }
    }
    while (offset + 64 <= input.byteLength) {
      this.compress(input.subarray(offset, offset + 64));
      offset += 64;
    }
    if (offset < input.byteLength) {
      this.pending.set(input.subarray(offset), 0);
      this.pendingLength = input.byteLength - offset;
    }
  }

  digest(): Uint8Array {
    const bitLength = this.totalBytes * 8;
    const paddingLength = (56 - ((this.totalBytes + 1) % 64) + 64) % 64;
    const padding = new Uint8Array(1 + paddingLength + 8);
    padding[0] = 0x80;
    const view = new DataView(padding.buffer);
    view.setUint32(padding.byteLength - 4, bitLength >>> 0, false);
    view.setUint32(padding.byteLength - 8, Math.floor(bitLength / 0x1_0000_0000), false);
    this.update(padding);
    const output = new Uint8Array(32);
    const outputView = new DataView(output.buffer);
    this.state.forEach((value, index) => outputView.setUint32(index * 4, value, false));
    return output;
  }

  private compress(block: Uint8Array): void {
    const words = new Uint32Array(64);
    const view = new DataView(block.buffer, block.byteOffset, block.byteLength);
    for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(index * 4, false);
    for (let index = 16; index < 64; index += 1) {
      const value = words[index - 15] ?? 0;
      const value2 = words[index - 2] ?? 0;
      const sigma0 = ((value >>> 7) | (value << 25)) ^ ((value >>> 18) | (value << 14)) ^ (value >>> 3);
      const sigma1 = ((value2 >>> 17) | (value2 << 15)) ^ ((value2 >>> 19) | (value2 << 13)) ^ (value2 >>> 10);
      words[index] = ((words[index - 16] ?? 0) + sigma0 + (words[index - 7] ?? 0) + sigma1) >>> 0;
    }
    const constants = [
      0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98,
      0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
      0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8,
      0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
      0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
      0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
      0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
      0xc67178f2,
    ];
    let a = this.state[0] ?? 0;
    let b = this.state[1] ?? 0;
    let c = this.state[2] ?? 0;
    let d = this.state[3] ?? 0;
    let e = this.state[4] ?? 0;
    let f = this.state[5] ?? 0;
    let g = this.state[6] ?? 0;
    let h = this.state[7] ?? 0;
    for (let index = 0; index < 64; index += 1) {
      const sigma1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const choose = (e & f) ^ (~e & g);
      const t1 = (h + sigma1 + choose + (constants[index] ?? 0) + (words[index] ?? 0)) >>> 0;
      const sigma0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (sigma0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    this.state[0] = ((this.state[0] ?? 0) + a) >>> 0;
    this.state[1] = ((this.state[1] ?? 0) + b) >>> 0;
    this.state[2] = ((this.state[2] ?? 0) + c) >>> 0;
    this.state[3] = ((this.state[3] ?? 0) + d) >>> 0;
    this.state[4] = ((this.state[4] ?? 0) + e) >>> 0;
    this.state[5] = ((this.state[5] ?? 0) + f) >>> 0;
    this.state[6] = ((this.state[6] ?? 0) + g) >>> 0;
    this.state[7] = ((this.state[7] ?? 0) + h) >>> 0;
  }
}

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
  if (attachment.status === "deleted" || attachment.deletedAt !== null) {
    await request.body?.cancel();
    return error(request, 409, "upload_cancelled", "The upload was cancelled and cannot be resumed");
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
  if (attachment.declaredSize > DIRECT_UPLOAD_MAX_BYTES) {
    await request.body?.cancel();
    return error(request, 413, "multipart_required", "Files larger than 8 MiB must use multipart upload");
  }
  const bytes = await readBoundedBody(
    request,
    attachment.declaredSize,
    Math.min(policy.maximumBytes, DIRECT_UPLOAD_MAX_BYTES),
  );
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
  if (
    RASTER_MEDIA_TYPES.has(attachment.mediaType) &&
    (byteInspection.width === null || byteInspection.height === null)
  ) {
    return error(request, 415, "invalid_image_dimensions", "The image dimensions could not be verified");
  }

  const digestInput = new Uint8Array(bytes.byteLength);
  digestInput.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", digestInput.buffer);
  const digestHex = hex(digest);
  let stored: R2Object | null;
  try {
    stored = await env.COMMUNITY_UPLOADS.put(attachment.objectKey, bytes, {
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
  } catch (storageError) {
    console.error(
      JSON.stringify({
        event: "community.upload.storage_put_failed",
        attachmentId: attachment.id,
        error: storageError instanceof Error ? storageError.name : "R2PutError",
        requestId: request.headers.get("X-Request-Id") || null,
      }),
    );
    return error(request, 503, "upload_storage_unavailable", "Upload storage is temporarily unavailable");
  }
  let object = stored;
  let createdObject = Boolean(stored);
  if (!object) {
    let existing: R2Object | null;
    try {
      existing = await env.COMMUNITY_UPLOADS.head(attachment.objectKey);
    } catch (storageError) {
      console.error(
        JSON.stringify({
          event: "community.upload.storage_head_failed",
          attachmentId: attachment.id,
          error: storageError instanceof Error ? storageError.name : "R2HeadError",
          requestId: request.headers.get("X-Request-Id") || null,
        }),
      );
      return error(request, 503, "upload_storage_unavailable", "Upload storage is temporarily unavailable");
    }
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
  let updated: D1Result;
  try {
    updated = await env.DB.prepare(
      `UPDATE community_attachment
       SET byte_size = ?, width = ?, height = ?, sha256 = ?, r2_etag = ?, r2_version = ?, r2_upload_id = NULL, status = 'scanning',
           moderation_status = 'pending', failure_code = NULL, expires_at = ?, updated_at = ?
       WHERE id = ? AND owner_user_id = ? AND status = 'reserved'`,
    )
      .bind(
        bytes.byteLength,
        byteInspection.width,
        byteInspection.height,
        digestHex,
        object.etag,
        object.version,
        now + UNATTACHED_TTL_MS,
        now,
        attachment.id,
        access.userId,
      )
      .run();
  } catch (databaseError) {
    console.error(
      JSON.stringify({
        event: "community.upload.state_update_failed",
        attachmentId: attachment.id,
        error: databaseError instanceof Error ? databaseError.name : "D1UpdateError",
        requestId: request.headers.get("X-Request-Id") || null,
      }),
    );
    return error(request, 503, "upload_state_unavailable", "Upload state could not be finalized; retry the upload");
  }
  if (attachment.r2UploadId) {
    await env.COMMUNITY_UPLOADS.resumeMultipartUpload(attachment.objectKey, attachment.r2UploadId)
      .abort()
      .catch(() => undefined);
  }
  if (Number(updated.meta.changes || 0) === 0) {
    let raced: AttachmentRow | null;
    try {
      raced = await findAttachment(env, id);
    } catch (databaseError) {
      console.error(
        JSON.stringify({
          event: "community.upload.state_read_after_race_failed",
          attachmentId: attachment.id,
          error: databaseError instanceof Error ? databaseError.name : "D1ReadError",
          requestId: request.headers.get("X-Request-Id") || null,
        }),
      );
      return error(request, 503, "upload_state_unavailable", "Upload state could not be confirmed; retry the upload");
    }
    if (!raced) return error(request, 503, "upload_state_unavailable", "Upload state could not be confirmed");
    if (raced.status === "deleted" || raced.deletedAt !== null) {
      try {
        await env.COMMUNITY_UPLOADS.delete(attachment.objectKey);
      } catch (cleanupError) {
        console.error(
          JSON.stringify({
            event: "community.upload.cancelled_object_cleanup_failed",
            attachmentId: attachment.id,
            error: cleanupError instanceof Error ? cleanupError.name : "R2DeleteError",
          }),
        );
      }
      return error(request, 409, "upload_cancelled", "The upload was cancelled and cannot be resumed");
    }
    if (raced.byteSize === bytes.byteLength && raced.sha256 === digestHex) {
      return json(request, { attachment: attachmentValue(raced) }, 202);
    }
    if (createdObject) {
      try {
        await env.COMMUNITY_UPLOADS.delete(attachment.objectKey);
      } catch (cleanupError) {
        console.error(
          JSON.stringify({
            event: "community.upload.conflict_object_cleanup_failed",
            attachmentId: attachment.id,
            error: cleanupError instanceof Error ? cleanupError.name : "R2DeleteError",
          }),
        );
      }
    }
    return error(request, 409, "upload_state_conflict", "The upload state changed; retry with its current status");
  }

  const transitioned = await findAttachment(env, attachment.id);
  if (!transitioned) {
    return error(request, 503, "upload_state_unavailable", "Upload state could not be confirmed; retry the upload");
  }
  if (transitioned.status === "deleted" || transitioned.deletedAt !== null) {
    try {
      await env.COMMUNITY_UPLOADS.delete(attachment.objectKey);
    } catch (cleanupError) {
      console.error(
        JSON.stringify({
          event: "community.upload.cancelled_object_cleanup_failed",
          attachmentId: attachment.id,
          error: cleanupError instanceof Error ? cleanupError.name : "R2DeleteError",
        }),
      );
    }
    return error(request, 409, "upload_cancelled", "The upload was cancelled and cannot be resumed");
  }

  try {
    await enqueueNativeMediaJob(env, attachment.id);
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
    const failedAt = Date.now();
    let cleanupSucceeded = false;
    try {
      const cleanup = await env.DB.batch([
        env.DB.prepare(
          `DELETE FROM community_moderation_case
           WHERE entity_kind = 'attachment' AND entity_id = ? AND status = 'pending'`,
        ).bind(attachment.id),
        env.DB.prepare(
          `UPDATE community_attachment
           SET status = 'deleted', failure_code = 'moderation_unavailable', deleted_at = ?, updated_at = ?
           WHERE id = ? AND deleted_at IS NULL`,
        ).bind(failedAt, failedAt, attachment.id),
      ]);
      cleanupSucceeded = Number(cleanup[1]?.meta.changes || 0) === 1;
    } catch (cleanupError) {
      console.error(
        JSON.stringify({
          event: "community.upload.moderation_failure_cleanup_failed",
          attachmentId: attachment.id,
          error: cleanupError instanceof Error ? cleanupError.name : "D1CleanupError",
        }),
      );
    }
    if (!cleanupSucceeded) {
      const current = await findAttachment(env, attachment.id);
      if (current && (current.status === "deleted" || current.deletedAt !== null)) {
        return error(request, 409, "upload_cancelled", "The upload was cancelled and cannot be resumed");
      }
      return error(request, 503, "moderation_unavailable", "Upload moderation is temporarily unavailable; retry later");
    }
    let objectDeleted = false;
    try {
      await env.COMMUNITY_UPLOADS.delete(attachment.objectKey);
      objectDeleted = true;
    } catch (cleanupError) {
      console.error(
        JSON.stringify({
          event: "community.upload.moderation_object_delete_deferred",
          attachmentId: attachment.id,
          error: cleanupError instanceof Error ? cleanupError.name : "R2DeleteError",
        }),
      );
    }
    if (objectDeleted) {
      await env.DB.prepare(
        `UPDATE community_attachment
         SET object_deleted_at = ?, updated_at = ?
         WHERE id = ? AND status = 'deleted' AND object_deleted_at IS NULL`,
      )
        .bind(failedAt, Date.now(), attachment.id)
        .run();
    }
    return error(request, 503, "moderation_unavailable", "Upload moderation is temporarily unavailable");
  }
  const result = await findAttachment(env, attachment.id);
  if (!result) throw new Error("Attachment disappeared after upload");
  if (result.status === "deleted" || result.deletedAt !== null) {
    try {
      await env.COMMUNITY_UPLOADS.delete(attachment.objectKey);
    } catch (cleanupError) {
      console.error(
        JSON.stringify({
          event: "community.upload.late_cancel_object_cleanup_failed",
          attachmentId: attachment.id,
          error: cleanupError instanceof Error ? cleanupError.name : "R2DeleteError",
        }),
      );
    }
    await env.DB.prepare(
      "DELETE FROM community_moderation_case WHERE entity_kind = 'attachment' AND entity_id = ? AND status = 'pending'",
    )
      .bind(attachment.id)
      .run();
    return error(request, 409, "upload_cancelled", "The upload was cancelled and cannot be resumed");
  }
  return json(request, { attachment: attachmentValue(result) }, 202);
};

interface MultipartPartRow {
  byteSize: number;
  etag: string;
  partNumber: number;
}

const multipartParts = async (env: Env, id: string): Promise<MultipartPartRow[]> => {
  const result = await env.DB.prepare(
    `SELECT part_number AS partNumber, etag, byte_size AS byteSize
     FROM community_attachment_part WHERE attachment_id = ? ORDER BY part_number`,
  )
    .bind(id)
    .all<MultipartPartRow>();
  return result.results;
};

const expectedPartSize = (attachment: AttachmentRow, partNumber: number): number => {
  const start = (partNumber - 1) * MULTIPART_PART_SIZE;
  if (partNumber < 1 || start >= attachment.declaredSize) return 0;
  return Math.min(MULTIPART_PART_SIZE, attachment.declaredSize - start);
};

const boundedPartStream = (request: Request, expected: number): ReadableStream<Uint8Array> | null => {
  if (!request.body) return null;
  const declared = Number(request.headers.get("Content-Length") || "");
  if (!Number.isSafeInteger(declared) || declared !== expected) return null;
  // R2 requires a known-length stream. FixedLengthStream preserves that
  // runtime marker and rejects both truncated and oversized part bodies.
  return request.body.pipeThrough(new FixedLengthStream(expected));
};

const uploadMultipartPart = async (request: Request, env: Env, id: string, partNumber: number): Promise<Response> => {
  const access = await requireActiveUser(request, env);
  if ("response" in access) return access.response;
  const contentType = request.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLocaleLowerCase("und");
  if (contentType !== "application/octet-stream") {
    await request.body?.cancel();
    return error(request, 415, "invalid_part_media_type", "Upload parts must use application/octet-stream");
  }
  const attachment = await findAttachment(env, id);
  if (!attachment || attachment.ownerUserId !== access.userId || attachment.purpose !== "post") {
    await request.body?.cancel();
    return error(request, 404, "attachment_not_found", "Attachment not found");
  }
  if (attachment.status === "deleted" || attachment.deletedAt !== null) {
    await request.body?.cancel();
    return error(request, 409, "upload_cancelled", "The upload was cancelled and cannot be resumed");
  }
  if (attachment.status !== "reserved" || !attachment.r2UploadId) {
    await request.body?.cancel();
    return json(request, {
      attachment: attachmentValue(attachment),
      parts: (await multipartParts(env, id)).map((part) => ({
        byteSize: part.byteSize,
        etag: part.etag,
        partNumber: part.partNumber,
      })),
    });
  }
  if (attachment.expiresAt <= Date.now()) {
    await request.body?.cancel();
    return error(request, 410, "upload_intent_expired", "Upload intent expired");
  }
  const expected = expectedPartSize(attachment, partNumber);
  if (!expected) {
    await request.body?.cancel();
    return error(request, 422, "invalid_part_number", "Part number is outside the upload plan");
  }
  const stream = boundedPartStream(request, expected);
  if (!stream) {
    await request.body?.cancel();
    return error(request, 422, "invalid_part_size", "The part size does not match the upload plan");
  }
  let uploaded: R2UploadedPart;
  try {
    uploaded = await env.COMMUNITY_UPLOADS.resumeMultipartUpload(
      attachment.objectKey,
      attachment.r2UploadId,
    ).uploadPart(partNumber, stream);
  } catch (storageError) {
    console.error(
      JSON.stringify({
        event: "community.upload.multipart_part_failed",
        attachmentId: id,
        partNumber,
        error: storageError instanceof Error ? storageError.name : "R2MultipartPartError",
      }),
    );
    return error(request, 503, "upload_storage_unavailable", "The upload part could not be stored");
  }
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO community_attachment_part (attachment_id, part_number, etag, byte_size, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(attachment_id, part_number) DO UPDATE SET etag = excluded.etag, byte_size = excluded.byte_size, created_at = excluded.created_at`,
    ).bind(id, partNumber, uploaded.etag, expected, now),
    env.DB.prepare("UPDATE community_attachment SET updated_at = ? WHERE id = ? AND status = 'reserved'").bind(now, id),
  ]);
  return json(request, {
    attachment: attachmentValue(attachment),
    part: { byteSize: expected, etag: uploaded.etag, partNumber },
  });
};

const completeMultipartUpload = async (request: Request, env: Env, id: string): Promise<Response> => {
  const access = await requireActiveUser(request, env);
  if ("response" in access) return access.response;
  const attachment = await findAttachment(env, id);
  if (!attachment || attachment.ownerUserId !== access.userId || attachment.purpose !== "post") {
    return error(request, 404, "attachment_not_found", "Attachment not found");
  }
  if (attachment.status === "scanning" || attachment.status === "ready" || attachment.status === "review") {
    return json(request, { attachment: attachmentValue(attachment) }, 202);
  }
  if (attachment.status === "deleted" || attachment.deletedAt !== null) {
    return error(request, 409, "upload_cancelled", "The upload was cancelled and cannot be resumed");
  }
  if (attachment.status !== "reserved" || !attachment.r2UploadId) {
    return error(request, 409, "upload_not_completable", "This upload is not ready for completion");
  }
  const body = await readJson(request);
  const requestedParts = body?.parts;
  const storedParts = await multipartParts(env, id);
  const partCount = Math.ceil(attachment.declaredSize / MULTIPART_PART_SIZE);
  if (
    storedParts.length !== partCount ||
    storedParts.some(
      (part, index) => part.partNumber !== index + 1 || part.byteSize !== expectedPartSize(attachment, part.partNumber),
    )
  ) {
    return error(request, 409, "parts_incomplete", "All upload parts must be stored before completion");
  }
  if (requestedParts !== undefined) {
    if (!Array.isArray(requestedParts) || requestedParts.length !== storedParts.length) {
      return error(request, 422, "invalid_parts", "The completion part list is invalid");
    }
    for (const [index, candidate] of requestedParts.entries()) {
      const value = isJsonValue(candidate) && isJsonObject(candidate) ? candidate : null;
      if (!value || value.partNumber !== storedParts[index]?.partNumber || value.etag !== storedParts[index]?.etag) {
        return error(request, 409, "part_conflict", "The completion part list does not match uploaded parts");
      }
    }
  }
  let completed: R2Object;
  try {
    completed = await env.COMMUNITY_UPLOADS.resumeMultipartUpload(attachment.objectKey, attachment.r2UploadId).complete(
      storedParts.map((part) => ({ etag: part.etag, partNumber: part.partNumber })),
    );
  } catch (storageError) {
    const existing = await env.COMMUNITY_UPLOADS.head(attachment.objectKey).catch(() => null);
    if (!existing) {
      console.error(
        JSON.stringify({
          event: "community.upload.multipart_complete_failed",
          attachmentId: id,
          error: storageError instanceof Error ? storageError.name : "R2MultipartCompleteError",
        }),
      );
      return error(request, 503, "upload_storage_unavailable", "The upload could not be completed");
    }
    completed = existing;
  }
  if (completed.size !== attachment.declaredSize) {
    await env.COMMUNITY_UPLOADS.delete(attachment.objectKey).catch(() => undefined);
    await env.DB.prepare(
      "UPDATE community_attachment SET status = 'rejected', moderation_status = 'block', failure_code = 'size_mismatch', r2_upload_id = NULL, updated_at = ? WHERE id = ? AND status = 'reserved'",
    )
      .bind(Date.now(), id)
      .run();
    return error(request, 422, "size_mismatch", "Completed object size does not match the upload intent");
  }
  let inspection: CompletedObjectInspection;
  try {
    inspection = await inspectCompletedObject(env, attachment);
  } catch (validationError) {
    await env.COMMUNITY_UPLOADS.delete(attachment.objectKey).catch(() => undefined);
    const reason = validationError instanceof Error ? validationError.message.slice(0, 80) : "invalid_file";
    await env.DB.prepare(
      "UPDATE community_attachment SET status = 'rejected', moderation_status = 'block', failure_code = ?, r2_upload_id = NULL, updated_at = ? WHERE id = ? AND status = 'reserved'",
    )
      .bind(reason, Date.now(), id)
      .run();
    return error(request, 415, reason, "File content does not match its type");
  }
  const now = Date.now();
  const metadata = await env.COMMUNITY_UPLOADS.head(attachment.objectKey);
  if (
    !metadata ||
    metadata.size !== attachment.declaredSize ||
    metadata.customMetadata?.attachmentId !== attachment.id
  ) {
    return error(request, 503, "upload_storage_unavailable", "Completed object metadata is unavailable");
  }
  const updated = await env.DB.prepare(
    `UPDATE community_attachment
     SET byte_size = ?, width = ?, height = ?, sha256 = ?, r2_etag = ?, r2_version = ?, r2_upload_id = NULL,
         status = 'scanning', moderation_status = 'pending', failure_code = NULL, expires_at = ?, updated_at = ?
     WHERE id = ? AND owner_user_id = ? AND status = 'reserved'`,
  )
    .bind(
      attachment.declaredSize,
      inspection.width,
      inspection.height,
      inspection.digestHex,
      metadata.etag,
      metadata.version,
      now + UNATTACHED_TTL_MS,
      now,
      id,
      access.userId,
    )
    .run();
  if (Number(updated.meta.changes || 0) !== 1) {
    const raced = await findAttachment(env, id);
    return raced
      ? json(request, { attachment: attachmentValue(raced) }, 202)
      : error(request, 503, "upload_state_unavailable", "Upload state could not be confirmed");
  }
  try {
    await enqueueNativeMediaJob(env, id);
  } catch (moderationError) {
    console.error(
      JSON.stringify({
        event: "community.upload.moderation_schedule_failed",
        attachmentId: id,
        error: moderationError instanceof Error ? moderationError.name : "ModerationError",
      }),
    );
    return error(request, 503, "moderation_unavailable", "Upload moderation is temporarily unavailable");
  }
  const result = await findAttachment(env, id);
  return json(request, { attachment: result ? attachmentValue(result) : null }, 202);
};

const cancelMultipartUpload = async (request: Request, env: Env, id: string): Promise<Response> => {
  const access = await requireActiveUser(request, env);
  if ("response" in access) return access.response;
  const attachment = await findAttachment(env, id);
  if (!attachment || attachment.ownerUserId !== access.userId || attachment.purpose !== "post") {
    return error(request, 404, "attachment_not_found", "Attachment not found");
  }
  const now = Date.now();
  const result = await env.DB.prepare(
    `UPDATE community_attachment SET status = 'deleted', deleted_at = ?, updated_at = ?
     WHERE id = ? AND owner_user_id = ? AND status = 'reserved' AND deleted_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM community_post_attachment WHERE attachment_id = ?)
       AND NOT EXISTS (SELECT 1 FROM community_profile_avatar WHERE attachment_id = ?)`,
  )
    .bind(now, now, id, access.userId, id, id)
    .run();
  if (Number(result.meta.changes || 0) !== 1)
    return error(request, 409, "attachment_in_use", "The upload cannot be cancelled now");
  if (attachment.r2UploadId) {
    await env.COMMUNITY_UPLOADS.resumeMultipartUpload(attachment.objectKey, attachment.r2UploadId)
      .abort()
      .catch(() => undefined);
  }
  return json(request, {
    attachment: await findAttachment(env, id).then((row) => (row ? attachmentValue(row) : null)),
  });
};

const getMetadata = async (request: Request, env: Env, id: string): Promise<Response> => {
  const access = await requireActiveUser(request, env);
  if ("response" in access) return access.response;
  const attachment = await findAttachment(env, id);
  if (!await canAccessAttachmentForum(env,id,access.userId)) return error(request,404,"attachment_not_found","Attachment not found");
  if (
    !attachment ||
    attachment.ownerUserId !== access.userId ||
    attachment.purpose !== "post" ||
    attachment.deletedAt !== null
  ) {
    return error(request, 404, "attachment_not_found", "Attachment not found");
  }
  return json(request, {
    attachment: { ...attachmentValue(attachment), ...(await mediaPresentation(env, id)) },
    parts: attachment.status === "reserved" ? (await multipartParts(env, id)).map((part) => ({ ...part })) : [],
  });
};

const retryAttachment = async (request: Request, env: Env, id: string): Promise<Response> => {
  const access = await requireActiveUser(request, env);
  if ("response" in access) return access.response;
  const attachment = await findAttachment(env, id);
  if (!await canAccessAttachmentForum(env,id,access.userId)) return error(request,404,"attachment_not_found","Attachment not found");
  if (
    !attachment ||
    attachment.ownerUserId !== access.userId ||
    attachment.purpose !== "post" ||
    attachment.deletedAt !== null
  )
    return error(request, 404, "attachment_not_found", "Attachment not found");
  if (attachment.status !== "scanning")
    return error(request, 409, "media_not_retryable", "Only pending media conversion can be retried");
  await retryNativeMediaJob(env, id);
  return json(request, { attachment: { ...attachmentValue(attachment), ...(await mediaPresentation(env, id)) } }, 202);
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
  const ownerPreview = new URL(request.url).searchParams.get("preview") === "owner";
  const session = await getAuthSession(request, env, { authoritative: true });
  const userId = session?.user?.id || null;
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
     WHERE community_attachment.id = ? AND (post.id IS NULL OR ${forumReadSql("post","?")}) LIMIT 1`,
  )
    .bind(id,userId)
    .first<DownloadAccessRow>();
  if (
    !row ||
    row.deletedAt !== null ||
    (!ownerPreview && (row.status !== "ready" || row.moderationStatus !== "allow")) ||
    row.attachmentOwnerStatus === null ||
    row.attachmentOwnerStatus === "deleted" ||
    !row.byteSize ||
    !row.sha256
  ) {
    return error(request, 404, "attachment_not_found", "Attachment not found");
  }
  const owner = userId === row.ownerUserId;
  if (
    ownerPreview &&
    (!owner ||
      row.purpose !== "post" ||
      row.attachmentOwnerStatus !== "active" ||
      !(
        (row.status === "scanning" && row.moderationStatus === "pending") ||
        (row.status === "review" && row.moderationStatus === "review") ||
        (row.status === "ready" && row.moderationStatus === "allow")
      ))
  )
    return error(request, 404, "attachment_not_found", "Attachment not found");
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

  const variantKind = new URL(request.url).searchParams.get("variant") || (ownerPreview ? "media" : null);
  if (variantKind) {
    if (!["thumb", "poster", "media"].includes(variantKind))
      return error(request, 400, "invalid_media_variant", "Unknown media variant");
    const variant = await env.DB.prepare(
      "SELECT kind,object_key AS objectKey,media_type AS mediaType,byte_size AS byteSize,width,height,duration_seconds AS durationSeconds,sha256 FROM community_attachment_variant WHERE attachment_id=? AND kind=?",
    )
      .bind(id, variantKind)
      .first<MediaVariantRow>();
    if (variant) {
      row.objectKey = variant.objectKey;
      row.byteSize = variant.byteSize;
      row.sha256 = variant.sha256;
      row.mediaType = variant.mediaType as UploadMediaType;
      row.fileName = `${row.fileName.replace(/\.[^.]*$/, "")}.${variant.mediaType === "video/mp4" ? "mp4" : variant.mediaType === "image/jpeg" ? "jpg" : "webp"}`;
    } else if (!["image/jpeg", "image/png", "image/webp", "image/gif"].includes(row.mediaType))
      return error(request, 404, "media_variant_missing", "Media is not ready");
  }
  const metadata = await env.COMMUNITY_UPLOADS.head(row.objectKey);
  if (
    !metadata ||
    metadata.size !== row.byteSize ||
    (metadata.customMetadata?.sha256
      ? metadata.customMetadata.sha256 !== row.sha256
      : metadata.customMetadata?.attachmentId !== row.id ||
        metadata.etag !== row.r2Etag ||
        metadata.version !== row.r2Version)
  ) {
    return error(request, 404, "attachment_object_missing", "Attachment object is unavailable");
  }
  const headers = new Headers({
    "Accept-Ranges": "bytes",
    // Forum permissions are mutable; authorize each request before serving bytes.
    "Cache-Control": "private, no-store",
    Vary: "Cookie",
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
  const claimResults = await env.DB.batch([
    env.DB.prepare(
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
    ).bind(now, now, id, access.userId),
    env.DB.prepare(
      `DELETE FROM community_moderation_case
       WHERE entity_kind = 'attachment' AND entity_id = ? AND status = 'pending'
         AND EXISTS (
           SELECT 1 FROM community_attachment
           WHERE id = ? AND status = 'deleted' AND deleted_at IS NOT NULL
         )`,
    ).bind(id, id),
  ]);
  if (!Number(claimResults[0]?.meta.changes || 0)) {
    return error(request, 409, "attachment_in_use", "Detach the file or finish its appeal before deleting it");
  }
  if (attachment.r2UploadId) {
    await env.COMMUNITY_UPLOADS.resumeMultipartUpload(attachment.objectKey, attachment.r2UploadId)
      .abort()
      .catch(() => undefined);
  }
  try {
    await cleanupNativeMediaStorage(env, id, attachment.objectKey);
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
  if (!attachmentIds)
    return error(request, 422, "invalid_attachment_ids", `Provide 1-${MAX_ATTACHMENTS_PER_POST} unique attachment IDs`);
  const post = await env.DB.prepare(
    `SELECT author_id AS authorId FROM community_post AS post WHERE id = ? AND deleted_at IS NULL AND ${forumPermissionSql("post.forum_id","post.author_id","post")} LIMIT 1`,
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
    return error(
      request,
      422,
      "too_many_attachments",
      `A post may contain at most ${MAX_ATTACHMENTS_PER_POST} attachments`,
    );
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
    // Positions must continue past the current maximum, not the row count:
    // unlinking a middle attachment leaves gaps, so COUNT-based positions can
    // collide with a surviving row under UNIQUE(post_id, position).
    const inputRows = additions.map(() => "(?, ?)").join(", ");
    const inputValues = additions.flatMap((id, index) => [id, index]);
    await env.DB.prepare(
      `WITH input(attachment_id, offset) AS (VALUES ${inputRows})
       INSERT INTO community_post_attachment (post_id, attachment_id, position, created_at)
       SELECT ?, input.attachment_id,
              (SELECT COALESCE(MAX(link.position) + 1, 0)
               FROM community_post_attachment AS link WHERE link.post_id = ?) + input.offset,
              ?
       FROM input
       ORDER BY input.offset`,
    )
      .bind(...inputValues, postId, postId, now)
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
    `SELECT author_id AS authorId FROM community_post AS post WHERE id = ? AND deleted_at IS NULL AND ${forumPermissionSql("post.forum_id","post.author_id","post")} LIMIT 1`,
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
       RETURNING id, object_key AS objectKey, r2_upload_id AS r2UploadId`,
  )
    .bind(retryBefore, claimedAt, claimedAt, reviewBefore, claimedAt, claimedAt)
    .all<CleanupRow>();
  const deletedIds: string[] = [];
  for (const row of claimed.results) {
    try {
      if (row.r2UploadId) {
        await env.COMMUNITY_UPLOADS.resumeMultipartUpload(row.objectKey, row.r2UploadId)
          .abort()
          .catch(() => undefined);
      }
      await cleanupNativeMediaStorage(env, row.id, row.objectKey);
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
  if (url.pathname === `${managedPrefix}/policy`) {
    if (request.method !== "GET" && request.method !== "HEAD")
      return error(request, 405, "method_not_allowed", "Method not allowed");
    return json(request, { limits: { ...COMMUNITY_UPLOAD_LIMITS } });
  }
  if (url.pathname === `${managedPrefix}/intents`) {
    return request.method === "POST"
      ? createIntent(request, env)
      : error(request, 405, "method_not_allowed", "Method not allowed");
  }
  const partMatch = new RegExp(`^${managedPrefix}/([0-9a-f-]{36})/parts/(\\d+)$`, "iu").exec(url.pathname);
  if (partMatch?.[1] && UUID_PATTERN.test(partMatch[1])) {
    const partNumber = Number(partMatch[2]);
    return request.method === "PUT"
      ? uploadMultipartPart(request, env, partMatch[1], partNumber)
      : error(request, 405, "method_not_allowed", "Method not allowed");
  }
  const completeMatch = new RegExp(`^${managedPrefix}/([0-9a-f-]{36})/complete$`, "iu").exec(url.pathname);
  if (completeMatch?.[1] && UUID_PATTERN.test(completeMatch[1])) {
    return request.method === "POST"
      ? completeMultipartUpload(request, env, completeMatch[1])
      : error(request, 405, "method_not_allowed", "Method not allowed");
  }
  const cancelMatch = new RegExp(`^${managedPrefix}/([0-9a-f-]{36})/multipart$`, "iu").exec(url.pathname);
  if (cancelMatch?.[1] && UUID_PATTERN.test(cancelMatch[1])) {
    return request.method === "DELETE"
      ? cancelMultipartUpload(request, env, cancelMatch[1])
      : error(request, 405, "method_not_allowed", "Method not allowed");
  }
  const uploadMatch = new RegExp(`^${managedPrefix}/([0-9a-f-]{36})/content$`, "iu").exec(url.pathname);
  if (uploadMatch?.[1] && UUID_PATTERN.test(uploadMatch[1])) {
    return request.method === "PUT"
      ? putContent(request, env, uploadMatch[1])
      : error(request, 405, "method_not_allowed", "Method not allowed");
  }
  const retryMatch = new RegExp(`^${attachmentsPrefix}/([0-9a-f-]{36})/retry$`, "iu").exec(url.pathname);
  if (retryMatch?.[1] && UUID_PATTERN.test(retryMatch[1])) {
    return request.method === "POST"
      ? retryAttachment(request, env, retryMatch[1])
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
