import type { SearchResumeCheckpoint, SearchResult } from "../../lib/team-builder/contracts";

/** UI conditions plus an opaque Worker checkpoint; never a completed-result cache. */
export interface SearchResumeBookmark {
  schema: "haneoka-team-resume-bookmark-v1";
  identity: { server: string; releaseId: string; sourceId: string };
  inventoryText: string;
  settings: unknown;
  checkpoint: SearchResumeCheckpoint;
  result: SearchResult;
  savedAt: string;
}
export interface SearchResumeBackend {
  read(key: string): Promise<unknown>;
  write(key: string, value: SearchResumeBookmark | null): Promise<void>;
}
const MAX_BYTES = 32 * 1024 * 1024;
function bookmark(value: unknown): value is SearchResumeBookmark {
  if (!value || typeof value !== "object") return false;
  const row = value as SearchResumeBookmark;
  return row.schema === "haneoka-team-resume-bookmark-v1" && typeof row.inventoryText === "string" &&
    typeof row.identity?.server === "string" && typeof row.identity.releaseId === "string" &&
    typeof row.identity.sourceId === "string" && typeof row.savedAt === "string" &&
    row.checkpoint?.schema === "haneoka-search-resume-v1" && typeof row.checkpoint.engineRevision === "string" &&
    /^[a-f0-9]{64}$/.test(row.checkpoint.fingerprint) && /^[a-f0-9]{64}$/.test(row.checkpoint.stateDigest) &&
    ["cancelled", "budget-limited", "unavailable"].includes(row.result?.completeness) &&
    Array.isArray(row.result.candidates) && typeof row.settings === "object" && row.settings !== null;
}
let connection: Promise<IDBDatabase> | undefined;
function database() {
  if (connection) return connection;
  const pending = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("haneoka-team-search-resume", 1);
    let failed = false;
    request.onupgradeneeded = () => request.result.createObjectStore("bookmarks");
    request.onerror = request.onblocked = () => { failed = true; reject(new Error("resume-storage-unavailable")); };
    request.onsuccess = () => {
      const db = request.result;
      if (failed) { db.close(); return; }
      db.onversionchange = () => { db.close(); if (connection === pending) connection = undefined; };
      resolve(db);
    };
  });
  connection = pending;
  void pending.catch(() => { if (connection === pending) connection = undefined; });
  return pending;
}
async function transaction(key: string, value?: SearchResumeBookmark | null) {
  const db = await database();
  return new Promise<unknown>((resolve, reject) => {
    const write = value !== undefined, tx = db.transaction("bookmarks", write ? "readwrite" : "readonly");
    const store = tx.objectStore("bookmarks");
    const request = write ? value === null ? store.delete(key) : store.put(value, key) : store.get(key);
    let result: unknown;
    request.onsuccess = () => { result = request.result; };
    tx.oncomplete = () => resolve(result);
    tx.onerror = tx.onabort = () => reject(new Error("resume-storage-failed"));
  });
}
const browserBackend: SearchResumeBackend = {
  read: key => transaction(key),
  write: async (key, value) => { await transaction(key, value); },
};

/** Each account/server/profile has its own last committed partial traversal. */
export class SearchResumeStore {
  value: SearchResumeBookmark | null = null;
  status: "loading" | "idle" | "saving" | "saved" | "error" = "loading";
  readonly ready: Promise<void>;
  private disposed = false;
  private version = 0;
  private pending: { value: SearchResumeBookmark | null } | undefined;
  private writing: Promise<void> | undefined;
  constructor(readonly key: string, private changed: () => void, private backend = browserBackend) {
    this.ready = this.restore();
  }
  private emit() { if (!this.disposed) this.changed(); }
  private async restore() {
    const version = this.version;
    try {
      const value = await this.backend.read(this.key);
      if (this.disposed || version !== this.version) return;
      if (value !== undefined && value !== null && !bookmark(value)) throw new Error("resume-bookmark-invalid");
      this.value = value as SearchResumeBookmark | null ?? null;
      this.status = this.value ? "saved" : "idle";
    } catch { if (!this.disposed && version === this.version) this.status = "error"; }
    this.emit();
  }
  save(value: SearchResumeBookmark | null) {
    if (this.disposed) return Promise.resolve();
    if (value && (!bookmark(value) || new TextEncoder().encode(JSON.stringify(value)).byteLength > MAX_BYTES)) {
      this.status = "error"; this.emit(); return Promise.resolve();
    }
    this.version++;
    this.value = value ? structuredClone(value) : null;
    this.pending = { value: this.value };
    this.status = "saving"; this.emit();
    return this.writing ??= Promise.resolve().then(() => this.drain());
  }
  private async drain() {
    try {
      while (this.pending) {
        const pending = this.pending; this.pending = undefined;
        try {
          await this.backend.write(this.key, pending.value);
          if (!this.pending) this.status = this.value ? "saved" : "idle";
        } catch { if (!this.pending) this.status = "error"; }
        this.emit();
      }
    } finally { this.writing = undefined; }
  }
  dispose() { this.disposed = true; /* Pending writes finish only under their captured key. */ }
}
