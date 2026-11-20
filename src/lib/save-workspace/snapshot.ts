// L3 — GEB
// Input: Versioned save snapshots and local storage requests.
// Output: Sanitized, lossless progress snapshots including lifetime mission counters and IndexedDB records.
// Pos: [Map](../L2-2.md); shared save workspace.
// Effects/Dependencies: Filters account credentials and persists independent local copies.
import type { SaveSnapshot } from "./schema";
export { parseSnapshot, type SaveSnapshot } from "./schema";
import type { SongProgressProfile } from "../song-progress-profile";
export interface StoredSave {
  id: string;
  label: string;
  importedAt: string;
  snapshot: SaveSnapshot;
  profile?: SongProgressProfile;
}
async function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("haneoka-save-snapshots", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("snapshots", { keyPath: "id" });
    req.onerror = () => reject(new Error("save_storage_failed", { cause: req.error }));
    req.onblocked = () => reject(new Error("save_storage_busy"));
    req.onsuccess = () => {
      req.result.onversionchange = () => req.result.close();
      resolve(req.result);
    };
  });
}
export async function saveRecords(
  action: "list" | "put" | "delete",
  value?: StoredSave | string,
): Promise<StoredSave[]> {
  const db = await database().catch((error) => {
    throw new Error("save_storage_failed", { cause: error });
  });
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction("snapshots", action === "list" ? "readonly" : "readwrite"),
        store = tx.objectStore("snapshots");
      if (action === "put") {
        store.put(value as StoredSave);
      }
      if (action === "delete") store.delete(value as string);
      const req = store.getAll();
      tx.oncomplete = () => resolve(req.result as StoredSave[]);
      tx.onerror = tx.onabort = () => reject(tx.error ?? new Error("save_storage_failed"));
    });
  } catch (error) {
    throw new Error("save_storage_failed", { cause: error });
  } finally {
    db.close();
  }
}
