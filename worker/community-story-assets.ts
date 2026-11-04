// L3 — GEB
// Input: 社区故事素材上传、既有附件、D1 和 R2。
// Output: 账户素材授权、不可变内容池和有界流上传。
// Pos: [Map](L2.md)；故事素材持久化与审核状态所有者。
// Effects/Dependencies: 写 D1／R2；附件限定故事范围，音频／SVG 按哈希审核；生命周期回收由社区故事协调。
import { STORY_LIMITS, type StoryAssetReceipt } from "../src/lib/story-creation/types";
export interface StoryAssetRow {
  id: string;
  ownerId: string;
  hash: string;
  objectKey: string;
  bytes: number;
  mediaType: string;
  kind: string;
  state: string;
  blobState: string;
  moderation: string;
  attachmentId: string | null;
}
const fields = `a.id,a.owner_id AS ownerId,a.blob_hash AS hash,b.object_key AS objectKey,b.byte_size AS bytes,
 a.media_type AS mediaType,a.kind,a.state,b.state AS blobState,b.moderation_status AS moderation,a.attachment_id AS attachmentId`;
const ownedAssetByHash = (env: Env, owner: string, hash: string) =>
  env.DB.prepare(
    `SELECT ${fields} FROM community_story_asset a JOIN community_story_blob b ON b.hash=a.blob_hash WHERE a.owner_id=? AND a.blob_hash=?`,
  )
    .bind(owner, hash)
    .first<StoryAssetRow>();
export const storyAssetReceipt = (row: StoryAssetRow): StoryAssetReceipt => ({
  id: row.id,
  hash: row.hash,
  bytes: row.bytes,
  mediaType: row.mediaType,
  state:
    row.state === "rejected" || row.moderation === "block"
      ? "rejected"
      : row.state === "ready" && row.blobState === "active" && row.moderation === "allow"
        ? "ready"
        : "processing",
});
export async function storyAsset(env: Env, id: string, owner?: string): Promise<StoryAssetRow | null> {
  return env.DB.prepare(
    `SELECT ${fields} FROM community_story_asset a JOIN community_story_blob b ON b.hash=a.blob_hash
    WHERE a.id=? ${owner ? "AND a.owner_id=?" : ""}`,
  )
    .bind(id, ...(owner ? [owner] : []))
    .first<StoryAssetRow>();
}
export async function storyAssets(env: Env, ids: readonly string[], owner: string): Promise<StoryAssetRow[]> {
  await env.DB.prepare(
    "UPDATE community_story_asset SET updated_at=? WHERE owner_id=? AND id IN(SELECT value FROM json_each(?))",
  )
    .bind(Date.now(), owner, JSON.stringify(ids))
    .run();
  const rows = await env.DB.prepare(
    `SELECT ${fields} FROM community_story_asset a JOIN community_story_blob b ON b.hash=a.blob_hash
    WHERE a.id IN (SELECT value FROM json_each(?)) AND a.owner_id=? AND b.state<>'deleting'`,
  )
    .bind(JSON.stringify([...new Set(ids)]), owner)
    .all<StoryAssetRow>();
  return rows.results;
}
export async function reserveStoryAsset(
  env: Env,
  owner: string,
  input: Record<string, unknown>,
  resolvePublic?: (source: string) => Promise<Response | null>,
): Promise<StoryAssetReceipt & { uploadUrl?: string }> {
  const hash = String(input.hash || ""),
    bytes = Number(input.bytes),
    now = Date.now();
  if (!/^[a-f0-9]{64}$/u.test(hash) || !Number.isSafeInteger(bytes) || bytes < 0) throw new Error("invalid_asset");
  const owned = await ownedAssetByHash(env, owner, hash);
  if (
    owned &&
    owned.bytes === bytes &&
    owned.blobState === "active" &&
    ["ready", "processing", "rejected"].includes(owned.state)
  ) {
    const renewed = await env.DB.prepare("UPDATE community_story_asset SET updated_at=? WHERE id=?")
      .bind(now, owned.id)
      .run();
    if (renewed.meta.changes) return storyAssetReceipt(owned);
  }
  const attachmentId = typeof input.attachmentId === "string" ? input.attachmentId : null;
  const publicSource = typeof input.publicSource === "string" ? input.publicSource : null;
  let trusted: Response | null = null;
  if (publicSource) {
    trusted = (await resolvePublic?.(publicSource)) ?? null;
    if (!trusted?.ok || !trusted.body) throw new Error("media_missing");
  }
  let kind = "data",
    mediaType = "application/octet-stream";
  let attachment: {
    objectKey: string;
    status: string;
    moderation: string;
    hash: string | null;
    bytes: number;
    mediaType: string;
  } | null = null;
  if (attachmentId) {
    attachment = await env.DB.prepare(
      `SELECT object_key AS objectKey,status,moderation_status AS moderation,sha256 AS hash,
      byte_size AS bytes,media_type AS mediaType FROM community_attachment WHERE id=? AND owner_user_id=? AND deleted_at IS NULL
      AND purpose='post' AND NOT EXISTS(SELECT 1 FROM community_post_attachment link WHERE link.attachment_id=community_attachment.id)
      AND NOT EXISTS(SELECT 1 FROM community_playlist cover WHERE cover.cover_attachment_id=community_attachment.id)
      AND NOT EXISTS(SELECT 1 FROM community_chart_revision cover WHERE cover.cover_attachment_id=community_attachment.id)`,
    )
      .bind(attachmentId, owner)
      .first();
    if (
      !attachment ||
      attachment.hash !== hash ||
      attachment.bytes !== bytes ||
      !/^(?:image|video)\//u.test(attachment.mediaType)
    )
      throw new Error("invalid_asset");
    const scope = await env.DB.prepare(
      `INSERT OR IGNORE INTO community_story_upload(attachment_id,created_at)
      SELECT id,? FROM community_attachment WHERE id=? AND owner_user_id=?
      AND NOT EXISTS(SELECT 1 FROM community_post_attachment link WHERE link.attachment_id=community_attachment.id)
      AND NOT EXISTS(SELECT 1 FROM community_playlist cover WHERE cover.cover_attachment_id=community_attachment.id)
      AND NOT EXISTS(SELECT 1 FROM community_chart_revision cover WHERE cover.cover_attachment_id=community_attachment.id)`,
    )
      .bind(now, attachmentId, owner)
      .run();
    if (
      !scope.meta.changes &&
      !(await env.DB.prepare("SELECT attachment_id FROM community_story_upload WHERE attachment_id=?")
        .bind(attachmentId)
        .first())
    )
      throw new Error("invalid_asset");
    kind = attachment.mediaType.startsWith("image/") ? "image" : "video";
    mediaType = attachment.mediaType;
  } else if (trusted) {
    mediaType = trusted.headers.get("Content-Type")?.split(";")[0] || "application/octet-stream";
    kind =
      mediaType.startsWith("image/") && mediaType !== "image/ktx2"
        ? "image"
        : mediaType.startsWith("video/")
          ? "video"
          : mediaType.startsWith("audio/")
            ? "audio"
            : "data";
  } else {
    if (bytes > STORY_LIMITS.binaryBytes) throw new Error("file_size");
    const requested = String(input.mediaType || "");
    if (/^audio\/(?:mpeg|ogg|wav|x-wav|flac|mp4|aac|webm|opus)$/u.test(requested)) {
      kind = "audio";
      mediaType = requested;
    } else if (
      [
        "application/json",
        "text/plain",
        "application/yaml",
        "text/yaml",
        "image/ktx2",
        "image/svg+xml",
        "font/woff2",
        "font/ttf",
        "font/otf",
      ].includes(requested)
    )
      mediaType = requested;
  }
  if (bytes > (attachment || trusted ? STORY_LIMITS.visualBytes : STORY_LIMITS.binaryBytes))
    throw new Error("file_size");
  const key = `community/stories/blobs/${hash}/${crypto.randomUUID()}`;
  await env.DB.prepare(
    `INSERT OR IGNORE INTO community_story_blob(hash,object_key,byte_size,state,created_at,updated_at)
    SELECT ?,?,?,'uploading',?,? WHERE (SELECT COALESCE(sum(b.byte_size),0) FROM community_story_asset a JOIN community_story_blob b ON b.hash=a.blob_hash WHERE a.owner_id=?) + ? <= ?`,
  )
    .bind(hash, key, bytes, now, now, owner, bytes, 8 * STORY_LIMITS.projectBytes)
    .run();
  const blob = await env.DB.prepare(
    "SELECT object_key AS objectKey,byte_size AS bytes,state FROM community_story_blob WHERE hash=?",
  )
    .bind(hash)
    .first<{ objectKey: string; bytes: number; state: string }>();
  if (!blob) throw new Error("storage_limit");
  if (blob.state === "deleting") throw new Error("asset_busy");
  if (blob.bytes !== bytes) throw new Error("invalid_asset");
  // A known hash alone grants no access: binary reuse still requires verified upload bytes or an existing owner grant.
  const proposedId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO community_story_asset(id,owner_id,blob_hash,media_type,kind,state,attachment_id,created_at,updated_at)
    SELECT ?,?,?,?,?,'reserved',?,?,? WHERE EXISTS(SELECT 1 FROM community_story_blob WHERE hash=? AND state<>'deleting') AND (SELECT COALESCE(sum(b.byte_size),0) FROM community_story_asset a JOIN community_story_blob b ON b.hash=a.blob_hash WHERE a.owner_id=?) + ? <= ?
    ON CONFLICT(owner_id,blob_hash) DO UPDATE SET updated_at=excluded.updated_at,
      media_type=CASE WHEN community_story_asset.state='reserved' THEN excluded.media_type ELSE community_story_asset.media_type END,
      kind=CASE WHEN community_story_asset.state='reserved' THEN excluded.kind ELSE community_story_asset.kind END,
      attachment_id=CASE WHEN community_story_asset.state='reserved' THEN excluded.attachment_id ELSE community_story_asset.attachment_id END`,
  )
    .bind(
      proposedId,
      owner,
      hash,
      mediaType,
      kind,
      attachmentId,
      now,
      now,
      hash,
      owner,
      bytes,
      4 * STORY_LIMITS.projectBytes,
    )
    .run();
  let row = await ownedAssetByHash(env, owner, hash);
  if (!row) throw new Error("asset_busy");
  const id = row.id;
  if (trusted) {
    if (row.state === "reserved") {
      const fixed = new FixedLengthStream(bytes);
      const transfer = new AbortController();
      const copied = trusted.body!.pipeTo(fixed.writable, { signal: transfer.signal });
      const writing = env.COMMUNITY_UPLOADS.put(row.objectKey, fixed.readable, {
        sha256: hash,
        httpMetadata: { contentType: mediaType },
      }).catch((error) => {
        transfer.abort(error);
        throw error;
      });
      const [, stored] = await Promise.all([copied, writing]);
      if (!stored || stored.size !== bytes) throw new Error("asset_integrity");
      await env.DB.batch([
        env.DB.prepare(
          "UPDATE community_story_blob SET state='active',updated_at=? WHERE hash=? AND state<>'deleting'",
        ).bind(now, hash),
        env.DB.prepare("UPDATE community_story_asset SET state='ready',updated_at=? WHERE id=?").bind(now, id),
      ]);
      row = (await storyAsset(env, id, owner))!;
      await ensureStoryResourceReview(
        env,
        row,
        new URL(publicSource!, "https://story.invalid/").pathname.split("/").at(-1) || hash,
        true,
      );
    } else await trusted.body?.cancel();
  }
  if (attachment && row.state === "reserved") {
    const object = await env.COMMUNITY_UPLOADS.get(attachment.objectKey);
    if (!object || object.size !== bytes) throw new Error("media_missing");
    await env.COMMUNITY_UPLOADS.put(row.objectKey, object.body, {
      sha256: hash,
      httpMetadata: { contentType: mediaType },
    });
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE community_story_blob SET state='active',updated_at=? WHERE hash=? AND state<>'deleting'",
      ).bind(now, hash),
      env.DB.prepare("UPDATE community_story_asset SET state=?,updated_at=? WHERE id=?").bind(
        attachment.status === "rejected" || attachment.moderation === "block"
          ? "rejected"
          : attachment.status === "ready" && attachment.moderation === "allow" ? "ready" : "processing",
        now,
        id,
      ),
    ]);
    row = (await storyAsset(env, id, owner))!;
  }
  return {
    ...storyAssetReceipt(row),
    ...(row.state === "reserved" ? { uploadUrl: `/api/v1/community/story-assets/${id}/content` } : {}),
  };
}
export async function putStoryAsset(env: Env, row: StoryAssetRow, request: Request): Promise<StoryAssetReceipt> {
  if ((!request.body && row.bytes !== 0) || row.attachmentId || row.blobState === "deleting")
    throw new Error("invalid_asset");
  const declared = request.headers.get("Content-Length");
  if (declared && Number(declared) !== row.bytes) throw new Error("file_size");
  const reader = (request.body ?? new Blob([]).stream()).getReader();
  const prefix: Uint8Array[] = [];
  let prefixLength = 0;
  while (prefixLength < Math.min(256, row.bytes)) {
    const part = await reader.read();
    if (part.done) break;
    prefix.push(part.value);
    prefixLength += part.value.length;
  }
  if (prefixLength > row.bytes) {
    await reader.cancel();
    throw new Error("file_size");
  }
  const head = new Uint8Array(prefixLength);
  let offset = 0;
  for (const chunk of prefix) {
    head.set(chunk, offset);
    offset += chunk.length;
  }
  const ascii = new TextDecoder().decode(head.subarray(0, 256)).trimStart().toLowerCase();
  const svg = /^(?:<\?xml[^>]*>\s*)?<svg(?:\s|>)/u.test(ascii);
  const htmlSource = /^(?:<!doctype\s+html(?:\s|>)|<html(?:\s|>))/u.test(ascii);
  const starts = (bytes: readonly number[]) => bytes.every((byte, index) => head[index] === byte);
  const container =
    new TextDecoder().decode(head.subarray(4, 8)) === "ftyp"
      ? "mp4"
      : starts([0x1a, 0x45, 0xdf, 0xa3])
        ? "webm"
        : ascii.startsWith("oggs")
          ? "ogg"
          : null;
  if (
    (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e) ||
    (head[0] === 0xff && head[1] === 0xd8) ||
    /^(?:gif8|riff.{4}webp)/su.test(ascii) ||
    starts([0x42, 0x4d]) ||
    starts([0, 0, 1, 0]) ||
    starts([0, 0, 2, 0]) ||
    starts([0xab, 0x4b, 0x54, 0x58]) ||
    (container && row.kind !== "audio") ||
    (!svg && !htmlSource && /^(?:<\?xml|<svg|<!doctype|<html)/u.test(ascii))
  ) {
    await reader.cancel();
    throw new Error("visual_upload_required");
  }
  let count = head.byteLength;
  const bounded = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(head);
    },
    async pull(controller) {
      const part = await reader.read();
      if (part.done) {
        if (count !== row.bytes) controller.error(new Error("file_size"));
        else controller.close();
        return;
      }
      count += part.value.byteLength;
      if (count > row.bytes) {
        await reader.cancel();
        controller.error(new Error("file_size"));
        return;
      }
      controller.enqueue(part.value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  const fixed = new FixedLengthStream(row.bytes);
  const pipe = bounded.pipeTo(fixed.writable);
  try {
    await Promise.all([
      pipe,
      env.COMMUNITY_UPLOADS.put(row.objectKey, fixed.readable, {
        sha256: row.hash,
        httpMetadata: { contentType: row.mediaType },
      }),
    ]);
  } catch {
    await reader.cancel().catch(() => undefined);
    throw new Error("asset_integrity");
  }
  if (container) {
    const object = await env.COMMUNITY_UPLOADS.get(row.objectKey);
    if (!object || !audioOnlyContainer(new Uint8Array(await object.arrayBuffer()), container))
      throw new Error("visual_upload_required");
  }
  const audioType =
    row.kind === "audio"
      ? row.mediaType
      : head[0] === 0xff && (head[1]! & 0xf6) === 0xf0
        ? "audio/aac"
        : ascii.startsWith("id3") || (head[0] === 0xff && (head[1]! & 0xe0) === 0xe0)
          ? "audio/mpeg"
          : ascii.startsWith("flac")
            ? "audio/flac"
            : ascii.startsWith("riff") && new TextDecoder().decode(head.subarray(8, 12)) === "WAVE"
              ? "audio/wav"
              : null;
  const storedKind = svg ? "image" : audioType ? "audio" : row.kind;
  const storedType = htmlSource ? "text/plain" : svg ? "image/svg+xml" : (audioType ?? row.mediaType);
  if (svg || audioType) {
    let name = row.hash;
    const encoded = request.headers.get("X-Haneoka-Story-Path");
    if (encoded) {
      try {
        name = decodeURIComponent(encoded).split("/").at(-1) || name;
      } catch {
        /* A legacy label does not change content identity. */
      }
    }
    await ensureStoryResourceReview(env, { ...row, kind: storedKind, mediaType: storedType }, name, false);
  }
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE community_story_blob SET state='active',updated_at=? WHERE hash=? AND state<>'deleting'",
    ).bind(Date.now(), row.hash),
    env.DB.prepare("UPDATE community_story_asset SET state='ready',kind=?,media_type=?,updated_at=? WHERE id=?").bind(
      storedKind,
      storedType,
      Date.now(),
      row.id,
    ),
  ]);
  if (svg || audioType) {
    const { scheduleStoryResourceChecks } = await import("./community-story-moderation");
    await scheduleStoryResourceChecks(env, row.hash);
  }
  return storyAssetReceipt((await storyAsset(env, row.id, row.ownerId))!);
}

async function ensureStoryResourceReview(env: Env, asset: StoryAssetRow, name: string, trusted: boolean) {
  if (asset.kind !== "audio" && asset.mediaType !== "image/svg+xml") return;
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO community_story_resource_review(id,blob_hash,media_type,file_name,status,source,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?)`,
    ).bind(
      crypto.randomUUID(),
      asset.hash,
      asset.mediaType,
      Array.from(name).slice(0, 160).join(""),
      trusted ? "allow" : "review",
      trusted ? "trusted" : "upload",
      now,
      now,
    ),
    env.DB.prepare(
      `UPDATE community_story_blob SET moderation_status=(SELECT status FROM community_story_resource_review WHERE blob_hash=?),updated_at=?
      WHERE hash=? AND moderation_status<>'block'`,
    ).bind(asset.hash, now, asset.hash),
  ]);
}

export async function storyResourceReviewAsset(env: Env, id: string): Promise<StoryAssetRow | null> {
  return env.DB.prepare(
    `SELECT ${fields} FROM community_story_resource_review review
    JOIN community_story_asset a ON a.blob_hash=review.blob_hash JOIN community_story_blob b ON b.hash=a.blob_hash
    WHERE review.id=? AND b.state='active' ORDER BY a.created_at,a.id LIMIT 1`,
  )
    .bind(id)
    .first<StoryAssetRow>();
}

export async function decideStoryResourceReview(
  env: Env,
  input: {
    id: string;
    decision: "allow" | "block";
    expectedStatus: "pending" | "review" | "allow" | "block";
    expectedToken?: string;
    reviewerId: string;
    operationId: string;
  },
): Promise<boolean> {
  const now = Date.now();
  const result = await env.DB.batch([
    env.DB.prepare(
      `UPDATE community_story_resource_review SET status=?,source='manual',reviewer_user_id=?,decision_operation_id=?,decided_at=?,updated_at=?
      WHERE id=? AND status=? AND (? IS NULL OR COALESCE(decision_operation_id,id)=?)
      AND EXISTS(SELECT 1 FROM community_story_blob b WHERE b.hash=blob_hash AND b.state='active')`,
    ).bind(input.decision, input.reviewerId, input.operationId, now, now, input.id, input.expectedStatus,input.expectedToken ?? null,input.expectedToken ?? null),
    env.DB.prepare(
      `UPDATE community_story_blob SET moderation_status=?,updated_at=? WHERE hash=(SELECT blob_hash FROM community_story_resource_review WHERE id=? AND decision_operation_id=?)`,
    ).bind(input.decision, now, input.id, input.operationId),
    env.DB.prepare(
      `UPDATE admin_operation SET status='succeeded',external_ref=?,updated_at=?,completed_at=? WHERE id=? AND status='pending'
      AND EXISTS(SELECT 1 FROM community_story_resource_review WHERE id=? AND decision_operation_id=?)`,
    ).bind(input.id, now, now, input.operationId, input.id, input.operationId),
    env.DB.prepare(
      `INSERT INTO admin_operation_event(id,operation_id,from_status,to_status,detail_json,created_at)
      SELECT ?,?,'pending','succeeded',json_object('caseId',review.id,'blobHash',review.blob_hash,'decision',?),?
      FROM community_story_resource_review review WHERE review.id=? AND review.decision_operation_id=?
      AND EXISTS(SELECT 1 FROM admin_operation WHERE id=? AND status='succeeded')`,
    ).bind(crypto.randomUUID(), input.operationId, input.decision, now, input.id, input.operationId, input.operationId),
  ]);
  return Number(result[0]?.meta.changes) > 0;
}

function audioOnlyContainer(bytes: Uint8Array, format: "mp4" | "webm" | "ogg"): boolean {
  const text = (offset: number, length: number) => new TextDecoder().decode(bytes.subarray(offset, offset + length));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let audio = 0;
  if (format === "mp4") {
    const walk = (start: number, end: number): boolean => {
      for (let offset = start; offset < end;) {
        if (offset + 8 > end) return false;
        let size = view.getUint32(offset),
          header = 8;
        if (size === 1) {
          if (offset + 16 > end) return false;
          size = Number(view.getBigUint64(offset + 8));
          header = 16;
        } else if (size === 0) size = end - offset;
        if (!Number.isSafeInteger(size) || size < header || size > end - offset) return false;
        const type = text(offset + 4, 4);
        if (["moov", "trak", "mdia"].includes(type) && !walk(offset + header, offset + size)) return false;
        if (type === "hdlr") {
          if (size < header + 12 || text(offset + header + 8, 4) !== "soun") return false;
          audio++;
        }
        offset += size;
      }
      return true;
    };
    return walk(0, bytes.length) && audio > 0;
  }
  if (format === "webm") {
    const vint = (offset: number, id: boolean): { value: number; length: number; unknown: boolean } | null => {
      const first = bytes[offset];
      if (!first) return null;
      let length = 1,
        mask = 0x80;
      while (!(first & mask)) {
        length++;
        mask >>= 1;
      }
      if (length > (id ? 4 : 8) || offset + length > bytes.length) return null;
      let value = id ? first : first & (mask - 1),
        unknown = !id && value === mask - 1;
      for (let index = 1; index < length; index++) {
        value = value * 256 + bytes[offset + index]!;
        unknown &&= bytes[offset + index] === 255;
      }
      return { value, length, unknown };
    };
    const walk = (start: number, end: number): boolean => {
      for (let offset = start; offset < end;) {
        const id = vint(offset, true);
        if (!id) return false;
        const size = vint(offset + id.length, false);
        if (!size) return false;
        const body = offset + id.length + size.length,
          limit = size.unknown ? end : body + size.value;
        if (!Number.isSafeInteger(limit) || limit > end || limit < body) return false;
        if ([0x18538067, 0x1654ae6b, 0xae].includes(id.value) && !walk(body, limit)) return false;
        if (id.value === 0x83) {
          if (limit - body !== 1 || bytes[body] !== 2) return false;
          audio++;
        }
        offset = limit;
      }
      return true;
    };
    return walk(0, bytes.length) && audio > 0;
  }
  for (let offset = 0; offset < bytes.length;) {
    if (offset + 27 > bytes.length || text(offset, 4) !== "OggS") return false;
    const segments = bytes[offset + 26]!,
      body = offset + 27 + segments;
    if (body > bytes.length) return false;
    const size = bytes.subarray(offset + 27, body).reduce((sum, value) => sum + value, 0);
    if (body + size > bytes.length) return false;
    if (bytes[offset + 5]! & 2) {
      if (!(
        text(body, 8) === "OpusHead" ||
        text(body, 7) === "\u0001vorbis" ||
        text(body, 8) === "Speex   " ||
        (bytes[body] === 0x7f && text(body + 1, 4) === "FLAC")
      ))
        return false;
      audio++;
    }
    offset = body + size;
  }
  return audio > 0;
}
export async function reconcileStoryAssets(env: Env, id?: string): Promise<void> {
  const assetState = `CASE WHEN EXISTS(SELECT 1 FROM community_attachment a WHERE a.id=attachment_id
      AND a.deleted_at IS NULL AND a.status='ready' AND a.moderation_status='allow') THEN 'ready'
      WHEN EXISTS(SELECT 1 FROM community_attachment a WHERE a.id=attachment_id AND a.deleted_at IS NULL AND a.status NOT IN ('rejected','deleted') AND a.moderation_status NOT IN ('block')) THEN 'processing'
      ELSE 'rejected' END`;
  const moderation = `CASE
      WHEN EXISTS(SELECT 1 FROM community_attachment a WHERE a.sha256=community_story_blob.hash AND a.moderation_status='block' AND a.deleted_at IS NULL) THEN 'block'
      WHEN EXISTS(SELECT 1 FROM community_attachment a JOIN community_moderation_case c ON c.entity_id=a.id AND c.entity_kind='attachment'
        WHERE a.sha256=community_story_blob.hash AND a.moderation_status='allow' AND a.deleted_at IS NULL AND c.status='allow' AND c.source IN ('manual','appeal')) THEN 'allow'
      WHEN moderation_status='block' THEN 'block'
      WHEN EXISTS(SELECT 1 FROM community_attachment a WHERE a.sha256=community_story_blob.hash AND a.moderation_status<>'allow' AND a.deleted_at IS NULL) THEN 'review'
      ELSE 'allow' END`;
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE community_story_asset SET state=${assetState} WHERE attachment_id IS NOT NULL AND state<>(${assetState}) ${id ? "AND id=?" : ""}`,
    ).bind(...(id ? [id] : [])),
    env.DB.prepare(
      `UPDATE community_story_blob SET moderation_status=${moderation} WHERE moderation_status<>(${moderation}) AND EXISTS(SELECT 1 FROM community_story_asset a WHERE a.blob_hash=community_story_blob.hash AND a.attachment_id IS NOT NULL) ${id ? "AND hash=(SELECT blob_hash FROM community_story_asset WHERE id=?)" : ""}`,
    ).bind(...(id ? [id] : [])),
  ]);
}

export async function storyAssetContent(request: Request, env: Env, asset: StoryAssetRow): Promise<Response> {
  if (asset.blobState !== "active" || asset.state === "reserved") throw new Error("media_missing");
  const object = await env.COMMUNITY_UPLOADS.get(asset.objectKey, {
    ...(request.headers.has("Range") ? { range: request.headers } : {}),
    onlyIf: request.headers,
  });
  if (!object) throw new Error("media_missing");
  const headers = new Headers({
    "Content-Type": asset.mediaType,
    "Cache-Control": "private, no-store",
    ETag: object.httpEtag,
    "X-Content-Type-Options": "nosniff",
    "Content-Disposition": "inline",
    "Content-Security-Policy":
      asset.mediaType === "image/svg+xml"
        ? "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; sandbox"
        : "default-src 'none'; sandbox",
    "Accept-Ranges": "bytes",
    "Cross-Origin-Resource-Policy": "same-origin",
  });
  if (!("body" in object)) return new Response(null, { status: 304, headers });
  let status = 200;
  if (
    request.headers.has("Range") &&
    object.range &&
    "offset" in object.range &&
    object.range.offset !== undefined &&
    object.range.length !== undefined
  ) {
    headers.set(
      "Content-Range",
      `bytes ${object.range.offset}-${object.range.offset + object.range.length - 1}/${object.size}`,
    );
    headers.set("Content-Length", String(object.range.length));
    status = 206;
  } else headers.set("Content-Length", String(object.size));
  return new Response(request.method === "HEAD" ? null : object.body, { status, headers });
}
