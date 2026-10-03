/** A local PNG handoff. Uploads and publication remain the composer's responsibility. */
const DATABASE = "haneoka-community-stamp-drafts";
const STORE = "drafts";
const POINTER = "haneoka:community-stamp-draft:v1";
const MAX_DRAFTS = 4;
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_AGE = 7 * 24 * 60 * 60 * 1000;
const validId = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(id);

interface StoredDraft {
  id: string;
  png: Blob;
  fileName: string;
  createdAt: number;
  userId: string | null;
}

function validDraft(value: unknown): value is StoredDraft {
  if (!value || typeof value !== "object") return false;
  const row = value as StoredDraft;
  return (
    typeof row.id === "string" && validId(row.id) &&
    row.png instanceof Blob && row.png.type === "image/png" && row.png.size > 0 && row.png.size <= MAX_BYTES &&
    typeof row.fileName === "string" && row.fileName.length > 0 && row.fileName.length <= 120 &&
    Number.isFinite(row.createdAt) && row.createdAt <= Date.now() && Date.now() - row.createdAt < MAX_AGE &&
    (row.userId === null || (typeof row.userId === "string" && row.userId.length > 0))
  );
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };
    const timer = setTimeout(() => fail(new Error("Local draft storage timed out")), 5000);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE, { keyPath: "id" });
    };
    request.onblocked = () => fail(new Error("Local draft storage is busy"));
    request.onerror = () => fail(request.error);
    request.onsuccess = () => {
      const database = request.result;
      if (settled) {
        database.close();
        return;
      }
      settled = true;
      clearTimeout(timer);
      database.onversionchange = () => database.close();
      resolve(database);
    };
  });
}

/** Resolve only after commit, so navigation cannot interrupt a queued write. */
async function transaction<T>(work: (store: IDBObjectStore, result: (value: T) => void) => void): Promise<T> {
  const database = await openDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = database.transaction(STORE, "readwrite");
      let value: T;
      const timer = setTimeout(() => {
        reject(new Error("Local draft storage timed out"));
        try { tx.abort(); } catch {}
      }, 5000);
      tx.oncomplete = () => { clearTimeout(timer); resolve(value); };
      tx.onabort = () => { clearTimeout(timer); reject(tx.error || new Error("Local draft storage failed")); };
      tx.onerror = () => { clearTimeout(timer); reject(tx.error || new Error("Local draft storage failed")); };
      try {
        work(tx.objectStore(STORE), (next) => { value = next; });
      } catch (error) {
        tx.abort();
        reject(error);
      }
    });
  } finally {
    database.close();
  }
}

function currentId(): string | null {
  try {
    const id = sessionStorage.getItem(POINTER);
    return id && validId(id) ? id : null;
  } catch {
    return null;
  }
}
function rememberId(id: string) {
  try { sessionStorage.setItem(POINTER, id); } catch { /* The explicit URL still carries the ID. */ }
}
function forgetId(id: string) {
  try { if (sessionStorage.getItem(POINTER) === id) sessionStorage.removeItem(POINTER); } catch {}
}

export async function prepareCommunityStampDraft(png: Blob, fileName = "stamp.png"): Promise<string> {
  if (!(png instanceof Blob) || png.type !== "image/png" || png.size < 33 || png.size > MAX_BYTES)
    throw new Error("Invalid stamp PNG");
  const header = new Uint8Array(await png.slice(0, 24).arrayBuffer());
  const signature = [137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82];
  const dimensions = new DataView(header.buffer);
  if (!signature.every((byte, index) => header[index] === byte) || dimensions.getUint32(16) !== 512 || dimensions.getUint32(20) !== 512)
    throw new Error("The community stamp canvas must be 512 × 512");
  const id = crypto.randomUUID();
  const safeName = fileName.replace(/[<>:"/\\|?*\u0000-\u001f]/gu, "_").slice(0, 116).replace(/\.png$/iu, "") || "stamp";
  const draft: StoredDraft = { id, png, fileName: `${safeName}.png`, createdAt: Date.now(), userId: null };
  await transaction<void>((store, result) => {
    const all = store.getAll();
    all.onsuccess = () => {
      const rows = all.result.filter(validDraft).sort((a, b) => b.createdAt - a.createdAt);
      const keep = new Set(rows.slice(0, MAX_DRAFTS - 1).map((row) => row.id));
      for (const row of all.result) if (!keep.has(row.id)) store.delete(row.id);
      store.add(draft);
      result(undefined);
    };
  });
  rememberId(id);
  return id;
}

export function communityStampComposerHref(locale: string, id: string): string {
  if (!/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/iu.test(locale) || !validId(id)) throw new Error("Invalid stamp draft route");
  return `/${locale}/community/posts/new/?stampDraft=${id}`;
}

export function communityStampDraftId(url: URL): string | null {
  if (url.searchParams.has("stampDraft")) {
    const id = url.searchParams.get("stampDraft") || "";
    return validId(id) ? id : null;
  }
  return currentId();
}

/** The first authenticated composer claims a guest handoff atomically. */
export async function readCommunityStampDraft(id: string, userId: string): Promise<{ id: string; file: File } | null> {
  if (!validId(id) || !userId) return null;
  const draft = await transaction<StoredDraft | null>((store, result) => {
    const request = store.get(id);
    request.onsuccess = () => {
      const row: unknown = request.result;
      if (!validDraft(row)) {
        store.delete(id);
        result(null);
      } else if (row.userId !== null && row.userId !== userId) result(null);
      else {
        const claimed = { ...row, userId };
        store.put(claimed);
        result(claimed);
      }
    };
  });
  if (!draft) return null;
  rememberId(id);
  return { id, file: new File([draft.png], draft.fileName, { type: "image/png", lastModified: draft.createdAt }) };
}

/** Call for explicit attachment removal or successful publication; leaving retains the PNG. */
export async function removeCommunityStampDraft(id: string, userId: string): Promise<void> {
  if (!validId(id) || !userId) return;
  const removed = await transaction<boolean>((store, result) => {
    const request = store.get(id);
    request.onsuccess = () => {
      const row: unknown = request.result;
      if (validDraft(row) && row.userId !== userId) result(false);
      else { store.delete(id); result(true); }
    };
  });
  if (removed) forgetId(id);
}
