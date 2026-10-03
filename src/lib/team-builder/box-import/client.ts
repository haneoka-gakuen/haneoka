import { BOX_LIMITS, BoxImportError, type BoxParseResult } from "./types";
export function parseBoxLocally(
  input: { files: readonly Blob[] } | { text: string },
  options: {
    signal?: AbortSignal;
    progress?: (completed: number, total: number) => void;
    workerFactory?: () => Worker;
  } = {},
): Promise<BoxParseResult> {
  options.signal?.throwIfAborted();
  if (
    ("text" in input && input.text.length > BOX_LIMITS.textBytes) ||
    ("files" in input &&
      (!input.files.length ||
        input.files.length > BOX_LIMITS.entries ||
        input.files.reduce((n, f) => n + f.size, 0) > BOX_LIMITS.inputBytes))
  )
    return Promise.reject(new BoxImportError("box_input_budget"));
  const worker = options.workerFactory?.() || new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    let settled = false;
    const finish = (error?: unknown, result?: BoxParseResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      worker.terminate();
      if (error) reject(error);
      else resolve(result!);
    };
    const abort = () => finish(options.signal?.reason || new DOMException("Aborted", "AbortError"));
    const timer = setTimeout(() => finish(new BoxImportError("box_timeout")), 30_000);
    worker.onmessage = (event: MessageEvent) => {
      if (event.data.id !== id) return;
      if (event.data.progress) options.progress?.(event.data.progress.completed, event.data.progress.total);
      else if (event.data.error) finish(new BoxImportError(event.data.error.code));
      else finish(undefined, event.data.result);
    };
    worker.onerror = () => finish(new BoxImportError("box_worker_failed"));
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) {
      abort();
      return;
    }
    worker.postMessage({ id, ...("files" in input ? { files: [...input.files] } : { text: input.text }) });
  });
}
