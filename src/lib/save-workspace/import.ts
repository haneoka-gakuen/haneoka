// L3 — GEB
// Input: Local files, selected server and cancellation signal.
// Output: Decoded, sanitized save snapshots.
// Pos: [Map](../L2-2.md); shared save workspace.
// Effects/Dependencies: Owns a bounded decoding Worker and terminates it on completion or cancellation.
import type { SaveSnapshot } from "./snapshot";
export function importSaves(
  files: File[],
  server: "jp" | "intl",
  signal: AbortSignal,
): Promise<{ label: string; snapshot: SaveSnapshot }[]> {
  signal.throwIfAborted();
  const worker = new Worker(new URL("./import-worker.ts", import.meta.url), { type: "module" });
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown, value?: { label: string; snapshot: SaveSnapshot }[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      worker.terminate();
      error ? reject(error) : resolve(value!);
    };
    const abort = () => finish(signal.reason);
    const timer = setTimeout(() => finish(new Error("box_timeout")), 60000);
    signal.addEventListener("abort", abort, { once: true });
    worker.onmessage = (e) => (e.data.error ? finish(new Error(e.data.error)) : finish(undefined, e.data.snapshots));
    worker.onerror = () => finish(new Error("save_worker_failed"));
    worker.onmessageerror = () => finish(new Error("save_worker_failed"));
    worker.postMessage({ files, server });
  });
}
