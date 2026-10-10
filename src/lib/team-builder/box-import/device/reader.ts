import { BOX_LIMITS, BoxImportError } from "../types";

export const ANDROID_CHANNELS = [
  { packageId: "com.bilibili.sirius.official", server: "intl", label: "Global · official" },
  { packageId: "com.bilibili.sirius", server: "intl", label: "Global · Google Play" },
  { packageId: "com.bushiroad.sirius", server: "jp", label: "Japan" },
] as const;
export interface DeviceEntry {
  name: string;
  type: "file" | "directory" | "other";
}
export interface DeviceReader {
  /** Must invoke the chooser synchronously, before its first await. */
  open(signal: AbortSignal): Promise<boolean>;
  type(path: string): Promise<DeviceEntry["type"]>;
  list(path: string): AsyncIterable<DeviceEntry>;
  read(path: string): {
    read(): Promise<{ done: false; value: Uint8Array } | { done: true; value?: unknown }>;
    cancel(): Promise<unknown>;
    releaseLock(): void;
  };
  close(): Promise<void>;
}
export const DEVICE_LIMITS = {
  directories: 32,
  entries: BOX_LIMITS.entries,
  depth: 2,
  files: BOX_LIMITS.candidates,
  milliseconds: 60_000,
} as const;
const safeName = (name: string) =>
  name.length > 0 && name.length <= 160 && !/[\/\\\x00-\x1f\x7f]/u.test(name) && name !== "." && name !== "..";
const skipped =
  /^(?:EncryptedBundles|Addressables|Master|RemoteCatalog|il2cpp|Unity|UnityCache|cache|tmp|ChatHistory)$/iu;
const candidate = (name: string) => /^[a-z0-9_-]+(?:\.(?:json|dat|sav|bin|gz|zip))?$/iu.test(name);

/** Rejects waiting on abort; callers also close the actual connection/stream. */
export function abortable<T>(promise: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(promise).then(
      (value) => {
        signal.removeEventListener("abort", abort);
        if (signal.aborted) reject(signal.reason);
        else resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

/** One selected game's external files only. No shell, app list or device writes. */
export async function readAndroidFiles(
  port: DeviceReader,
  packageId: string,
  signal: AbortSignal,
  timeoutMs: number = DEVICE_LIMITS.milliseconds,
): Promise<File[] | null> {
  if (!ANDROID_CHANNELS.some((channel) => channel.packageId === packageId)) throw new BoxImportError("device_channel");
  const timeout = new AbortController();
  const run = AbortSignal.any([signal, timeout.signal]);
  const timer = setTimeout(() => timeout.abort(new BoxImportError("device_timeout")), timeoutMs);
  const stop = () => {
    void port.close().catch(() => {});
  };
  run.addEventListener("abort", stop, { once: true });
  let total = 0,
    entries = 0,
    directories = 0,
    attempts = 0;
  const files: File[] = [];
  const root = `/sdcard/Android/data/${packageId}/files`;
  const visit = async (path: string, depth: number) => {
    run.throwIfAborted();
    if (depth > DEVICE_LIMITS.depth || ++directories > DEVICE_LIMITS.directories)
      throw new BoxImportError("device_scan_budget");
    if ((await abortable(port.type(path), run)) !== "directory") throw new BoxImportError("device_path");
    const iterator = port.list(path)[Symbol.asyncIterator]();
    const children: DeviceEntry[] = [];
    // Finish the list stream before opening another sync operation on this socket.
    try {
      while (true) {
        const result = await abortable(iterator.next(), run);
        if (result.done) break;
        if (++entries > DEVICE_LIMITS.entries) throw new BoxImportError("device_scan_budget");
        const entry = result.value;
        if (entry.name === "." || entry.name === "..") continue;
        if (!safeName(entry.name)) throw new BoxImportError("device_path");
        if (skipped.test(entry.name)) continue;
        children.push(entry);
      }
    } finally {
      if (iterator.return) void iterator.return().catch(() => {});
    }
    for (const entry of children) {
      run.throwIfAborted();
      const child = `${path}/${entry.name}`;
      if (!child.startsWith(root + "/")) throw new BoxImportError("device_path");
      if (entry.type === "other") continue;
      if (entry.type === "directory") {
        await visit(child, depth + 1);
        continue;
      }
      if (!candidate(entry.name)) continue;
      if (++attempts > DEVICE_LIMITS.files) throw new BoxImportError("device_scan_budget");
      if ((await abortable(port.type(child), run)) !== "file") throw new BoxImportError("device_path");
      const reader = port.read(child);
      const cancel = () => {
        void reader.cancel().catch(() => {});
      };
      run.addEventListener("abort", cancel, { once: true });
      const chunks: Uint8Array<ArrayBuffer>[] = [];
      let size = 0;
      try {
        while (true) {
          const chunk = await abortable(reader.read(), run);
          if (chunk.done) break;
          size += chunk.value.byteLength;
          total += chunk.value.byteLength;
          if (size > BOX_LIMITS.fileBytes || total > BOX_LIMITS.inputBytes)
            throw new BoxImportError("device_read_budget");
          chunks.push(Uint8Array.from(chunk.value));
        }
        if (size) files.push(new File(chunks, `candidate-${files.length + 1}.bin`));
      } finally {
        run.removeEventListener("abort", cancel);
        cancel();
        reader.releaseLock();
        chunks.forEach((chunk) => chunk.fill(0));
      }
    }
  };
  try {
    if (!(await abortable(port.open(run), run))) return null;
    await visit(root, 0);
    if (!files.length) throw new BoxImportError("device_empty");
    return files;
  } catch (error) {
    if (run.aborted) throw run.reason;
    if (error instanceof BoxImportError) throw error;
    // Never leak paths, device names, serials or transport error text.
    throw new BoxImportError("device_read_failed");
  } finally {
    clearTimeout(timer);
    run.removeEventListener("abort", stop);
    try {
      await abortable(port.close(), AbortSignal.timeout(2_000));
    } catch {
      // Never offer a review while the transport's release is unconfirmed.
      throw new BoxImportError("device_close_failed");
    }
  }
}
