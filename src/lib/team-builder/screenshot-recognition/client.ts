// L3 — GEB
// Input: 截图 Blob 与识别上下文（server/releaseId/sourceId）。
// Output: 与 RecognitionTransport 相同形状的已完成任务。
// Pos: [Map](../L2-2.md)；截图识别的本机传输层，替代上传接口。
// Effects/Dependencies: 复用一个模块 Worker；不需要登录，截图不上传。
import type { RecognitionTransport } from "../recognition-client";

let worker: Worker | null = null;
const pending = new Map<
  string,
  { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }
>();

function recognitionWorker() {
  if (!worker) {
    worker = new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
      name: "haneoka-screenshot-recognition",
    });
    worker.onmessage = (
      event: MessageEvent<{ id: string; error?: string; result?: unknown; referenceId?: string }>,
    ) => {
      const request = pending.get(event.data.id);
      if (!request) return;
      pending.delete(event.data.id);
      if (event.data.error) request.reject(Object.assign(new Error(event.data.error), { code: event.data.error }));
      else request.resolve(event.data as Record<string, unknown>);
    };
    worker.onerror = () => {
      for (const request of pending.values())
        request.reject(Object.assign(new Error("recognition_failed"), { code: "recognition_failed" }));
      pending.clear();
      worker?.terminate();
      worker = null;
    };
  }
  return worker;
}

export const localRecognitionTransport: RecognitionTransport = {
  async upload(file, options) {
    options.signal.throwIfAborted();
    const output = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const abort = () => {
        pending.delete(options.id);
        reject(options.signal.reason);
      };
      options.signal.addEventListener("abort", abort, { once: true });
      pending.set(options.id, {
        resolve: (value) => {
          options.signal.removeEventListener("abort", abort);
          resolve(value);
        },
        reject: (error) => {
          options.signal.removeEventListener("abort", abort);
          reject(error);
        },
      });
      recognitionWorker().postMessage({
        id: options.id,
        server: options.context.server,
        identity: options.context,
        file,
        kind: options.kind,
      });
    });
    options.progress(file.size, file.size);
    return {
      id: options.id,
      state: "ready",
      context: { ...options.context, referenceId: output.referenceId },
      progress: null,
      expiresAt: Date.now() + 3_600_000,
      result: output.result,
    };
  },
  async read() {
    throw Object.assign(new Error("recognition_job_not_found"), { code: "recognition_job_not_found" });
  },
  async delete() {},
};
