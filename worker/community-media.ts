import { getContainer } from "@cloudflare/containers";
import { scheduleEntityModeration } from "./moderation";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LEASE_MS = 14 * 60 * 1000;
const QUEUE_NAME = "haneoka-community-media";
interface SourceRow {
  id: string;
  objectKey: string;
  mediaType: string;
  byteSize: number;
  status: string;
  deletedAt: number | null;
}
interface NativeOutput {
  name: string;
  kind: string;
  mediaType: string;
  bytes: number;
  width: number;
  height: number;
  durationSeconds?: number | null;
  sha256?: string;
}
interface NativeJob {
  jobId: string;
  state: string;
  progress: number;
  outputs: NativeOutput[];
  error?: { code?: string; message?: string };
}
interface MediaJobRow {
  state: string;
  progress: number;
  attempts: number;
  error: string | null;
}
export interface MediaVariantRow {
  kind: string;
  objectKey: string;
  mediaType: string;
  byteSize: number;
  width: number;
  height: number;
  durationSeconds: number | null;
  sha256: string | null;
}

const processor = (env: Env, id: string) =>
  getContainer(env.MEDIA_PROCESSOR, `media-${parseInt(id.slice(-2), 16) % 2}`);
const sourceRow = (env: Env, id: string) =>
  env.DB.prepare(
    `SELECT id,object_key AS objectKey,media_type AS mediaType,byte_size AS byteSize,status,deleted_at AS deletedAt FROM community_attachment WHERE id=? AND purpose='post'`,
  )
    .bind(id)
    .first<SourceRow>();
const jobRow = (env: Env, id: string) =>
  env.DB.prepare("SELECT state,progress,attempts,error FROM community_media_job WHERE attachment_id=?")
    .bind(id)
    .first<MediaJobRow>();
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function enqueueNativeMediaJob(env: Env, id: string): Promise<void> {
  if (!UUID.test(id)) throw new Error("Invalid media attachment ID");
  const now = Date.now();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO community_media_job(attachment_id,state,created_at,updated_at) SELECT id,'queued',?,? FROM community_attachment WHERE id=? AND status='scanning' AND deleted_at IS NULL`,
  )
    .bind(now, now, id)
    .run();
  const job = await jobRow(env, id);
  if (job?.state !== "queued") return;
  await env.MEDIA_QUEUE.send({ attachmentId: id, version: 1 });
}

export async function retryNativeMediaJob(env: Env, id: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE community_media_job SET state='queued',attempts=0,progress=0,error=NULL,updated_at=?
    WHERE attachment_id=? AND state='failed' AND EXISTS(SELECT 1 FROM community_attachment WHERE id=? AND status='scanning' AND deleted_at IS NULL)`,
  )
    .bind(Date.now(), id, id)
    .run();
  await enqueueNativeMediaJob(env, id);
}

function presentation(id: string, job: MediaJobRow | undefined, entries: MediaVariantRow[]) {
  const media = entries.find((entry) => entry.kind === "media"),
    poster = entries.find((entry) => entry.kind === "poster"),
    thumb = entries.find((entry) => entry.kind === "thumb");
  const url = (kind: string) => `/api/v1/community/attachments/${id}/content?variant=${kind}`;
  return {
    ...(job ? { processing: { state: job.state, progress: job.progress, error: job.error } } : {}),
    ...(media
      ? {
          displayMediaType: media.mediaType,
          displayWidth: media.width,
          displayHeight: media.height,
          durationSeconds: media.durationSeconds,
          ...(media.mediaType.startsWith("video/") ? { playbackUrl: url("media") } : { previewUrl: url("media") }),
        }
      : {}),
    ...(poster ? { posterUrl: url("poster") } : {}),
    ...(thumb ? { thumbnailUrl: url("thumb") } : {}),
  };
}
export async function mediaPresentations(env: Env, ids: readonly string[]) {
  const unique = [...new Set(ids)];
  const result = new Map<string, ReturnType<typeof presentation>>();
  if (!unique.length) return result;
  const keys = JSON.stringify(unique);
  const [jobs, variants] = await Promise.all([
    env.DB.prepare(
      "SELECT attachment_id AS id,state,progress,attempts,error FROM community_media_job WHERE attachment_id IN (SELECT value FROM json_each(?))",
    )
      .bind(keys)
      .all<MediaJobRow & { id: string }>(),
    env.DB.prepare(
      "SELECT attachment_id AS id,kind,object_key AS objectKey,media_type AS mediaType,byte_size AS byteSize,width,height,duration_seconds AS durationSeconds,sha256 FROM community_attachment_variant WHERE attachment_id IN (SELECT value FROM json_each(?))",
    )
      .bind(keys)
      .all<MediaVariantRow & { id: string }>(),
  ]);
  const byJob = new Map(jobs.results.map((job) => [job.id, job]));
  const byVariant = new Map<string, MediaVariantRow[]>();
  for (const row of variants.results) {
    const group = byVariant.get(row.id) || [];
    group.push(row);
    byVariant.set(row.id, group);
  }
  for (const id of unique) result.set(id, presentation(id, byJob.get(id), byVariant.get(id) || []));
  return result;
}
export async function mediaPresentation(env: Env, id: string) {
  return (await mediaPresentations(env, [id])).get(id) || {};
}

function outputKind(output: NativeOutput): string | null {
  if (output.name === "moderation.jpg" && output.mediaType === "image/jpeg") return "moderation";
  if (output.name === "media.mp4" && output.mediaType === "video/mp4") return "media";
  const match = /^(media|poster|thumb)\.(webp|jpg)$/.exec(output.name);
  return match && output.mediaType === (match[2] === "webp" ? "image/webp" : "image/jpeg") ? match[1]! : null;
}
function checksum(value: string): ArrayBuffer {
  if (!/^[0-9a-f]{64}$/i.test(value)) throw new Error("Media output checksum is missing");
  return Uint8Array.from(value.match(/../g)!, (part) => parseInt(part, 16)).buffer;
}
async function readNative(response: Response): Promise<NativeJob> {
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Media processor HTTP ${response.status}`);
  }
  const value = (await response.json()) as NativeJob;
  if (!value || typeof value.state !== "string") throw new Error("Invalid media processor response");
  return value;
}
async function removeNative(env: Env, id: string) {
  try {
    const response = await processor(env, id).fetch(new Request(`http://media/jobs/${id}`, { method: "DELETE" }));
    await response.body?.cancel();
  } catch {}
}

// Include unpublished derivatives: a worker can lose its lease after R2 put
// but before the variant row is inserted. Their attachment prefix is stable.
export async function cleanupNativeMediaStorage(env: Env, id: string, originalKey: string): Promise<void> {
  await env.DB.prepare(
    "UPDATE community_media_job SET state='failed',error='attachment_deleted',lease_token=NULL,lease_until=NULL,updated_at=? WHERE attachment_id=? AND state!='failed'",
  )
    .bind(Date.now(), id)
    .run();
  await removeNative(env, id);
  await env.COMMUNITY_UPLOADS.delete(originalKey);
  let cursor: string | undefined;
  do {
    const listing = await env.COMMUNITY_UPLOADS.list({ prefix: `media/v1/${id}/`, ...(cursor ? { cursor } : {}) });
    if (listing.objects.length) await env.COMMUNITY_UPLOADS.delete(listing.objects.map((object) => object.key));
    cursor = listing.truncated ? listing.cursor : undefined;
  } while (cursor);
}

async function discardOutputs(env: Env, id: string, keys: string[]): Promise<void> {
  try {
    await env.COMMUNITY_UPLOADS.delete(keys);
  } catch (error) {
    // Reopen cleanup even when deletion already marked this attachment done.
    await env.DB.prepare(
      "UPDATE community_attachment SET object_deleted_at=NULL,updated_at=? WHERE id=? AND status='deleted'",
    )
      .bind(Date.now(), id)
      .run();
    throw error;
  }
}

async function processMedia(env: Env, id: string): Promise<void> {
  let source = await sourceRow(env, id);
  if (!source || source.deletedAt !== null || source.status === "deleted") return;
  const previous = await jobRow(env, id);
  if (previous?.state === "ready") {
    if (source.status === "scanning")
      await scheduleEntityModeration(
        env,
        "attachment",
        id,
        { categories: [], normalizedText: "", reasonCode: "deterministic.media_preview_valid", verdict: "allow" },
        1,
      );
    return;
  }
  const token = crypto.randomUUID(),
    now = Date.now();
  const claimed = await env.DB.prepare(
    `UPDATE community_media_job SET state='processing',attempts=attempts+1,lease_token=?,lease_until=?,error=NULL,updated_at=? WHERE attachment_id=? AND (state='queued' OR (state='processing' AND lease_until<?))`,
  )
    .bind(token, now + LEASE_MS, now, id, now)
    .run();
  if (!claimed.meta.changes) return;
  const storedKeys: string[] = [];
  let published = false;
  try {
    const stub = processor(env, id);
    let response = await stub.fetch(new Request(`http://media/jobs/${id}`));
    if (response.status === 404) {
      await response.body?.cancel();
      const original = await env.COMMUNITY_UPLOADS.get(source.objectKey);
      if (!original || original.size !== source.byteSize) throw new Error("Original media is unavailable");
      const fixed = new FixedLengthStream(original.size);
      const transfer = original.body.pipeTo(fixed.writable);
      const upload = stub.fetch(
        new Request("http://media/jobs", {
          method: "POST",
          headers: { "Content-Type": source.mediaType, "X-Community-Media-Job-Id": id },
          body: fixed.readable,
        }),
      );
      [response] = await Promise.all([upload, transfer]);
    }
    let result = await readNative(response);
    const until = Date.now() + 12 * 60 * 1000;
    while (result.state === "queued" || result.state === "running") {
      if (Date.now() > until) throw new Error("Media processing timed out");
      source = await sourceRow(env, id);
      if (!source || source.deletedAt !== null || source.status === "deleted") {
        await removeNative(env, id);
        return;
      }
      await env.DB.prepare(
        "UPDATE community_media_job SET progress=?,lease_until=?,updated_at=? WHERE attachment_id=? AND lease_token=?",
      )
        .bind(Math.max(0, Math.min(1, Number(result.progress) || 0)), Date.now() + LEASE_MS, Date.now(), id, token)
        .run();
      await wait(3000);
      result = await readNative(await stub.fetch(new Request(`http://media/jobs/${id}`)));
    }
    if (result.state !== "succeeded") throw new Error(String(result.error?.code || "media_processing_failed"));
    const variants: MediaVariantRow[] = [];
    for (const output of result.outputs) {
      const kind = outputKind(output);
      if (
        !kind ||
        !Number.isSafeInteger(output.bytes) ||
        output.bytes <= 0 ||
        output.bytes > 128 * 1024 * 1024 ||
        !Number.isSafeInteger(output.width) ||
        output.width <= 0 ||
        !Number.isSafeInteger(output.height) ||
        output.height <= 0
      )
        throw new Error("Invalid media output metadata");
      if (kind === "moderation" && output.bytes > 8 * 1024 * 1024) throw new Error("Moderation preview is too large");
      const digest = checksum(output.sha256 || "");
      const converted = await stub.fetch(new Request(`http://media/jobs/${id}/outputs/${output.name}`));
      if (!converted.ok || !converted.body || Number(converted.headers.get("content-length")) !== output.bytes)
        throw new Error("Media output is incomplete");
      const objectKey = `media/v1/${id}/${token}/${output.name}`;
      const object = await env.COMMUNITY_UPLOADS.put(objectKey, converted.body, {
        sha256: digest,
        httpMetadata: { contentType: output.mediaType, cacheControl: "private, no-store" },
        customMetadata: { attachmentId: id, sha256: output.sha256! },
      });
      if (!object) throw new Error("Media output could not be stored");
      storedKeys.push(objectKey);
      variants.push({
        kind,
        objectKey,
        mediaType: output.mediaType,
        byteSize: output.bytes,
        width: output.width,
        height: output.height,
        durationSeconds: output.durationSeconds ?? null,
        sha256: output.sha256!,
      });
    }
    if (!variants.some((row) => row.kind === "media") || !variants.some((row) => row.kind === "moderation"))
      throw new Error("Required media outputs are missing");
    source = await sourceRow(env, id);
    if (!source || source.deletedAt !== null || source.status === "deleted") {
      await discardOutputs(env, id, storedKeys);
      await removeNative(env, id);
      return;
    }
    const statements = variants.map((row) =>
      env.DB.prepare(
        `INSERT OR REPLACE INTO community_attachment_variant(attachment_id,kind,object_key,media_type,byte_size,width,height,duration_seconds,sha256,created_at) SELECT ?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM community_attachment WHERE id=? AND status='scanning' AND deleted_at IS NULL) AND EXISTS(SELECT 1 FROM community_media_job WHERE attachment_id=? AND lease_token=?)`,
      ).bind(
        id,
        row.kind,
        row.objectKey,
        row.mediaType,
        row.byteSize,
        row.width,
        row.height,
        row.durationSeconds,
        row.sha256,
        Date.now(),
        id,
        id,
        token,
      ),
    );
    statements.push(
      env.DB.prepare(
        "UPDATE community_media_job SET state='ready',progress=1,lease_token=NULL,lease_until=NULL,updated_at=? WHERE attachment_id=? AND lease_token=? AND EXISTS(SELECT 1 FROM community_attachment WHERE id=? AND status='scanning' AND deleted_at IS NULL)",
      ).bind(Date.now(), id, token, id),
    );
    const written = await env.DB.batch(statements);
    if (!written.at(-1)?.meta.changes) {
      await discardOutputs(env, id, storedKeys);
      await removeNative(env, id);
      return;
    }
    published = true;
    await scheduleEntityModeration(
      env,
      "attachment",
      id,
      { categories: [], normalizedText: "", reasonCode: "deterministic.media_preview_valid", verdict: "allow" },
      1,
    );
    await removeNative(env, id);
  } catch (error) {
    if (!published && storedKeys.length) await discardOutputs(env, id, storedKeys).catch(() => undefined);
    const message = error instanceof Error ? error.message : String(error);
    await env.DB.prepare(
      "UPDATE community_media_job SET state=CASE WHEN attempts>=3 THEN 'failed' ELSE 'queued' END,error=?,lease_token=NULL,lease_until=NULL,updated_at=? WHERE attachment_id=? AND lease_token=?",
    )
      .bind(message.slice(0, 300), Date.now(), id, token)
      .run();
    await removeNative(env, id);
    throw error;
  }
}

export async function handleCommunityMediaQueue(batch: MessageBatch, env: Env): Promise<boolean> {
  if (batch.queue !== QUEUE_NAME) return false;
  for (const message of batch.messages) {
    const body = message.body as { attachmentId?: unknown; version?: unknown };
    if (body?.version !== 1 || typeof body.attachmentId !== "string" || !UUID.test(body.attachmentId)) {
      message.ack();
      continue;
    }
    try {
      await processMedia(env, body.attachmentId);
      message.ack();
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "community.media.failed",
          attachmentId: body.attachmentId,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      message.retry({ delaySeconds: 30 });
    }
  }
  return true;
}

export async function reconcileCommunityMedia(env: Env): Promise<void> {
  const jobs = await env.DB.prepare(
    "SELECT attachment_id AS id FROM community_media_job WHERE state='queued' OR (state='processing' AND lease_until<?) ORDER BY updated_at LIMIT 32",
  )
    .bind(Date.now())
    .all<{ id: string }>();
  for (const row of jobs.results) await env.MEDIA_QUEUE.send({ attachmentId: row.id, version: 1 });
}
