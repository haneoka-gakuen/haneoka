/** Device-only recommendation storage, intentionally separate from BoxStore / account sync. */
import { PT_VERSION, type PtJob, type PtJobStore } from "./pt-recommendation";

export class PtCheckpoint implements PtJobStore {
  private db: Promise<IDBDatabase> | undefined;
  private open(): Promise<IDBDatabase> {
    return (this.db ??= new Promise((resolve, reject) => {
      const request = indexedDB.open("haneoka-pt-trial", 1);
      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore("jobs", { keyPath: "id" });
        store.createIndex("by-owner-server", ["owner", "server"]);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("pt-storage-blocked"));
    }));
  }
  async save(job: PtJob): Promise<void> {
    const snapshot = structuredClone(job);
    const db = await this.open();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("jobs", "readwrite");
      tx.objectStore("jobs").put(snapshot);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error("pt-storage-aborted"));
    });
  }
  async latest(server: string, owner: string): Promise<PtJob | null> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("jobs", "readonly");
      const request = tx
        .objectStore("jobs")
        .index("by-owner-server")
        .getAll(IDBKeyRange.only([owner, server]));
      request.onsuccess = () => {
        const rows = (request.result as PtJob[]).filter((job) => job.version === PT_VERSION);
        rows.sort((a, b) => b.updatedAt - a.updatedAt);
        resolve(rows[0] ?? null);
      };
      request.onerror = () => reject(request.error);
    });
  }
}
