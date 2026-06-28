import type { StoryJsonDraftBase, WebGalSceneEditContext } from "@haneoka/story-editor";

const DATABASE_NAME = "haneoka-story-editor";
const DATABASE_VERSION = 1;
const STORE_NAME = "drafts";
const ACTIVE_DRAFT = "active";

export interface StoredStoryEditorDraft<Project> {
  project: Project;
  updatedAt: number;
  currentSceneId?: string;
  projectRevision?: number;
  projectCode?: string;
  projectCodeBase?: StoryJsonDraftBase;
  sceneCode?: string;
  sceneCodes?: Record<string, string>;
  sceneCodeContexts?: Record<string, WebGalSceneEditContext>;
}

let databasePromise: Promise<IDBDatabase> | undefined;

const requestResult = <Value>(request: IDBRequest<Value>) =>
  new Promise<Value>((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error || new Error("IndexedDB request failed")), {
      once: true,
    });
  });

const openDatabase = () => {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.addEventListener(
      "upgradeneeded",
      () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(STORE_NAME)) database.createObjectStore(STORE_NAME);
      },
      { once: true },
    );
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error || new Error("IndexedDB could not be opened")), {
      once: true,
    });
    request.addEventListener("blocked", () => reject(new Error("IndexedDB upgrade was blocked by another tab")), {
      once: true,
    });
  });
  return databasePromise;
};

const withStore = async <Value>(
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest<Value>,
): Promise<Value> => {
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, mode);
  const result = await requestResult(action(transaction.objectStore(STORE_NAME)));
  await new Promise<void>((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve(), { once: true });
    transaction.addEventListener(
      "abort",
      () => reject(transaction.error || new Error("IndexedDB transaction aborted")),
      { once: true },
    );
    transaction.addEventListener(
      "error",
      () => reject(transaction.error || new Error("IndexedDB transaction failed")),
      { once: true },
    );
  });
  return result;
};

export const loadStoryEditorDraft = async <Project>(): Promise<StoredStoryEditorDraft<Project> | undefined> =>
  withStore("readonly", (store) => store.get(ACTIVE_DRAFT));

export const saveStoryEditorDraft = async <Project>(draft: StoredStoryEditorDraft<Project>): Promise<void> => {
  await withStore("readwrite", (store) => store.put(draft, ACTIVE_DRAFT));
};

export const clearStoryEditorDraft = async (): Promise<void> => {
  await withStore("readwrite", (store) => store.delete(ACTIVE_DRAFT));
};
