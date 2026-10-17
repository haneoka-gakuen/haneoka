// L3 — GEB
// Input: 用户选定的本地来源、格式、密码、取消和进度选项。
// Output: 本地存档解析 Promise 或 BoxImportError。
// Pos: [Map](L2-2.md)；文件夹／备份／归档解析的主线程桥。
// Effects/Dependencies: 创建 Worker、传递输入并在结束／取消时终止；本文件不上传所选来源。
import { BoxImportError, type BoxParseResult } from "@haneoka/game-data-exporter";
import type { FolderSource } from "./directory";
export function readLocalSource(
  source: FolderSource & { archive?: Blob },
  kind: "folder" | "backup" | "archive",
  password: string,
  options: { signal: AbortSignal; progress: (completed: number, total: number) => void },
): Promise<BoxParseResult> {
  options.signal.throwIfAborted();
  const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown, result?: BoxParseResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate();
      options.signal.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve(result!);
    };
    const abort = () => finish(new DOMException("Aborted", "AbortError"));
    const timer = setTimeout(() => finish(new BoxImportError("backup_timeout")), 180000);
    options.signal.addEventListener("abort", abort, { once: true });
    worker.onmessage = (event) => {
      if (event.data.progress) options.progress(event.data.progress.completed, event.data.progress.total);
      else if (event.data.error) finish(new BoxImportError(event.data.error));
      else finish(undefined, event.data.result);
    };
    worker.onerror = () => finish(new BoxImportError("backup_invalid"));
    try {
      worker.postMessage({ source, kind, password, archive: source.archive });
    } catch (error) {
      finish(error);
    }
  });
}
