import {
  uploadPrivateScreenshot, readPrivateScreenshotJob, deletePrivateScreenshotJob,
  type ScreenshotRecognitionOptions, type ScreenshotRecognitionUploadOptions,
} from "../../../packages/community-media/client";
import type { ScreenshotRecognitionContext, ScreenshotRecognitionResult } from "./screenshot-import.ts";

export interface RecognitionJob {
  id: string;
  state: "queued" | "processing" | "ready" | "failed";
  context: ScreenshotRecognitionContext;
  progress: unknown;
  expiresAt: number;
  result?: NativeRecognitionResult;
  error?: { code: string; message?: string };
}
export interface NativeRecognitionResult {
  schema: "haneoka-card-recognition-result-v1";
  identity: { server: string; releaseId: string; sourceId: string };
  referenceId?: string;
  images: { id: string; sha256: string; size: [number, number]; coordinateSpace: string; observationIds: string[]; status: string }[];
  observations: {
    id: string; imageId: string; kind: "members" | "snapshots"; bbox: [number, number, number, number]; cardId: number | null;
    status: string; candidates: { cardId: number; variant: string; score: number; [key: string]: unknown }[];
    fields: { level: { value: number | null; status: string; reason?: string }; [key: string]: unknown };
  }[];
  engine: { algorithm: string };
}
export interface RecognitionClientContext { ownerId: string; server: string; releaseId: string; sourceId: string }
export interface RecognitionTransport {
  upload: (file: Blob, options: ScreenshotRecognitionUploadOptions) => Promise<Record<string, unknown>>;
  read: (id: string, options: ScreenshotRecognitionOptions) => Promise<Record<string, unknown>>;
  delete: (id: string, options: ScreenshotRecognitionOptions) => Promise<void>;
}
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
const HASH = /^[a-f0-9]{64}$/u;

/** Adapt the deployed kernel shape once at the UI boundary. Accepted visible
 * level evidence survives; hidden practice fields are never imported.
 */
export function normalizeRecognitionResult(job: RecognitionJob): ScreenshotRecognitionResult[] {
  const result = job.result;
  if (job.state !== "ready" || !result || result.schema !== "haneoka-card-recognition-result-v1" ||
      !["server", "releaseId", "sourceId"].every(key => result.identity?.[key as keyof typeof result.identity] === job.context[key as keyof typeof result.identity]) ||
      (result.referenceId !== undefined && result.referenceId !== job.context.referenceId) ||
      !HASH.test(job.context.referenceId) || !Array.isArray(result.images) || !result.images.length || result.images.length > 8 ||
      !Array.isArray(result.observations) || result.observations.length > 100)
    throw new RangeError("recognition-result-context");
  const ids = new Set<string>(), observationIds = new Set<string>();
  for (const image of result.images) {
    if (ids.has(image.id) || image.coordinateSpace !== "exif_normalized_original" || !HASH.test(image.sha256) ||
        !Array.isArray(image.size) || image.size.length !== 2 || image.size.some(value => !Number.isSafeInteger(value) || value < 128 || value > 4096) ||
        image.size[0] * image.size[1] > 8_000_000 || !Array.isArray(image.observationIds)) throw new RangeError("recognition-result-image");
    ids.add(image.id);
  }
  for (const row of result.observations) {
    const image = result.images.find(value => value.id === row.imageId);
    if (!image || observationIds.has(row.id) || !image.observationIds.includes(row.id)) throw new RangeError("recognition-result-observation");
    observationIds.add(row.id);
  }
  if (result.images.some(image => image.observationIds.length !== result.observations.filter(row => row.imageId === image.id).length))
    throw new RangeError("recognition-result-observation");
  return result.images.map(image => ({
    schema: result.schema, context: { ...job.context }, algorithmVersion: result.engine.algorithm,
    image: { width: image.size[0], height: image.size[1], sha256: image.sha256 },
    status: image.status === "needs_crop" ? "no-reliable-grid" : "candidates",
    observations: result.observations.filter(row => row.imageId === image.id).map(row => ({
      bbox: [...row.bbox], kind: row.kind, cardId: row.cardId,
      candidates: row.candidates.map(candidate => ({ cardId: candidate.cardId, variant: candidate.variant, score: candidate.score, evidence: { ...candidate } })),
      level: { value: row.fields.level.status === "recognized" ? row.fields.level.value : null, reason: row.fields.level.reason ?? row.fields.level.status },
    })),
  }));
}

/** Reuse the media owner's upload/progress/cancel transport, captured to one
 * account and source. Cancel uses a fresh signal even after upload abort.
 */
export function createRecognitionClient(initialContext: RecognitionClientContext, transport: RecognitionTransport = {
  upload: uploadPrivateScreenshot, read: readPrivateScreenshotJob, delete: deletePrivateScreenshotJob,
}) {
  const context = { ...initialContext };
  if (!context.ownerId || !context.server || !context.releaseId || !context.sourceId) throw new TypeError("recognition-context");
  const options = (signal?: AbortSignal): ScreenshotRecognitionOptions => ({
    userId: context.ownerId, context: { server: context.server, releaseId: context.releaseId, sourceId: context.sourceId },
    signal: signal ?? new AbortController().signal,
  });
  const check = (payload: Record<string, unknown>, expectedId: string): RecognitionJob => {
    const job = payload as unknown as RecognitionJob;
    if (!UUID.test(expectedId) || job.id !== expectedId || !["queued", "processing", "ready", "failed"].includes(job.state) ||
        job.context?.server !== context.server || job.context.releaseId !== context.releaseId || job.context.sourceId !== context.sourceId ||
        !HASH.test(job.context.referenceId)) throw new Error("recognition-job-context-mismatch");
    return job;
  };
  return {
    async submit(image: Blob, signal?: AbortSignal, idempotencyKey: string = crypto.randomUUID(), progress: (loaded: number, total: number) => void = () => {}) {
      if (!UUID.test(idempotencyKey)) throw new TypeError("recognition-job-id");
      return check(await transport.upload(image, { ...options(signal), id: idempotencyKey, progress }), idempotencyKey);
    },
    async poll(id: string, signal?: AbortSignal) {
      if (!UUID.test(id)) throw new TypeError("recognition-job-id");
      return check(await transport.read(id, options(signal)), id);
    },
    async cancel(id: string) {
      if (!UUID.test(id)) throw new TypeError("recognition-job-id");
      await transport.delete(id, options());
    },
  };
}
