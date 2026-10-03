export interface ScreenshotRecognitionOptions {
  context: { server: string; releaseId: string; sourceId: string };
  userId: string;
  signal: AbortSignal;
}
export interface ScreenshotRecognitionUploadOptions extends ScreenshotRecognitionOptions {
  id: string;
  progress: (loaded: number, total: number) => void;
  crop?: { x: number; y: number; width: number; height: number };
  kind?: "members" | "snapshots";
}
type JsonRecord = Record<string, unknown>;
export class ScreenshotRecognitionError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(message: string, code: string, status: number) {
    super(message);
    this.name = "ScreenshotRecognitionError";
    this.code = code;
    this.status = status;
  }
}
function httpError(data: JsonRecord, status: number): ScreenshotRecognitionError {
  const error = data.error as JsonRecord | undefined;
  return new ScreenshotRecognitionError(
    String(error?.message || `HTTP ${status}`),
    typeof error?.code === "string" && error.code ? error.code : "http_error",
    status,
  );
}

const PREFIX = "/api/v1/team-builder/recognition/jobs";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function url(id: string | null, options: ScreenshotRecognitionOptions): string {
  if (id !== null && !UUID.test(id)) throw new Error("Invalid recognition job identity");
  return `${PREFIX}${id ? `/${id}` : ""}?${new URLSearchParams(options.context)}`;
}
function value(data: JsonRecord, status: number): JsonRecord {
  if (status < 200 || status >= 300) throw httpError(data, status);
  if (!data.job || typeof data.job !== "object" || Array.isArray(data.job))
    throw new ScreenshotRecognitionError("Invalid recognition response", "invalid_response", status);
  return data.job as JsonRecord;
}

/** A local Blob is sent only to the authenticated private job endpoint. */
export async function uploadPrivateScreenshot(
  file: Blob,
  options: ScreenshotRecognitionUploadOptions,
): Promise<JsonRecord> {
  options.signal.throwIfAborted();
  if (
    !UUID.test(options.id) ||
    !["image/png", "image/jpeg", "image/webp"].includes(file.type) ||
    !file.size ||
    file.size > 8 * 1024 * 1024
  )
    throw new Error("Use a PNG, JPEG or WebP screenshot up to 8 MiB");
  const sha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", await file.arrayBuffer()))]
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("");
  options.signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let timer: ReturnType<typeof setTimeout>;
    const abort = () => xhr.abort();
    const cleanup = () => {
      clearTimeout(timer);
      options.signal.removeEventListener("abort", abort);
    };
    const deadline = () => {
      clearTimeout(timer);
      timer = setTimeout(() => xhr.abort(), 90_000);
    };
    xhr.open("POST", url(null, options));
    xhr.setRequestHeader("Content-Type", file.type);
    xhr.setRequestHeader("Idempotency-Key", options.id);
    xhr.setRequestHeader("X-Image-Sha256", sha256);
    xhr.setRequestHeader("X-Haneoka-Expected-User", options.userId);
    if (options.crop) xhr.setRequestHeader("X-Recognition-Crop", JSON.stringify(options.crop));
    if (options.kind) xhr.setRequestHeader("X-Recognition-Kind", options.kind);
    xhr.upload.onprogress = (event) => {
      options.progress(Math.min(file.size, event.loaded), file.size);
      deadline();
    };
    xhr.onload = () => {
      cleanup();
      try {
        resolve(value(JSON.parse(xhr.responseText) as JsonRecord, xhr.status));
      } catch (error) {
        reject(error);
      }
    };
    xhr.onabort = () => {
      cleanup();
      reject(options.signal.aborted ? options.signal.reason : new Error("Recognition upload timed out"));
    };
    xhr.onerror = () => {
      cleanup();
      reject(new Error("Recognition upload failed"));
    };
    options.signal.addEventListener("abort", abort, { once: true });
    if (options.signal.aborted) {
      cleanup();
      reject(options.signal.reason);
      return;
    }
    deadline();
    xhr.send(file);
  });
}
export async function readPrivateScreenshotJob(id: string, options: ScreenshotRecognitionOptions): Promise<JsonRecord> {
  options.signal.throwIfAborted();
  const response = await fetch(url(id, options), {
    credentials: "same-origin",
    cache: "no-store",
    headers: { "X-Haneoka-Expected-User": options.userId },
    signal: options.signal,
  });
  return value((await response.json()) as JsonRecord, response.status);
}
export async function deletePrivateScreenshotJob(id: string, options: ScreenshotRecognitionOptions): Promise<void> {
  const response = await fetch(url(id, options), {
    method: "DELETE",
    credentials: "same-origin",
    cache: "no-store",
    headers: { "X-Haneoka-Expected-User": options.userId },
    signal: options.signal,
  });
  if (!response.ok && response.status !== 404) {
    const data = (await response.json()) as JsonRecord;
    throw httpError(data, response.status);
  }
}
