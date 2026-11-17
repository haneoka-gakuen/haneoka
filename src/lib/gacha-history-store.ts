// L3 — GEB
// Input: 规范化本地抽卡快照、App 分来源文件名与当前 Haneoka owner。
// Output: 本地记录、显式合并别名与原始记录，以及按 owner 隔离的云缓存、同步许可。
// Pos: [Map](L2-2.md)；抽卡历史账号同步边界。
// Effects/Dependencies: 读写 IndexedDB；云下载保持独立，显式合并可导入本机；上传许可按 grant 条件写入。
import { mergeHistoryCollection, parseHistory, type HistorySnapshot } from "./gacha-history-data";
import { HISTORY_CLOUD_SCHEMA, parseStoredCloudHistory, type HistoryCloudDocument } from "./gacha-history-cloud-data";

export interface HistoryCloudLink {
  ownerId: string;
  accountKey: string;
  grantId: string;
  uploaded: Record<string, string>;
}

export interface StoredHistory {
  key: string;
  snapshot: HistorySnapshot;
  histories?: HistorySnapshot[];
  aliases?: string[];
  mergeSources?: Array<Omit<StoredHistory, "mergeSources">>;
}
const request = <T>(value: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    value.onsuccess = () => resolve(value.result);
    value.onerror = () => reject(value.error);
  });

/** A union must remain readable by the portable SDK's batch/prize limits. */
function checkHistoryBudget(histories: readonly HistorySnapshot[]) {
  for (const history of histories) if (history.batches.length > 100_000 ||
    history.batches.reduce((total, batch) => total + batch.prizes.length, 0) > 250_000) throw new Error("history_merge_budget");
}

/** A browser-local history library shared by import and analysis entry points. */
class HistoryStore extends EventTarget {
  private database?: Promise<IDBDatabase>;
  private db(): Promise<IDBDatabase> {
    return (this.database ??= new Promise((resolve, reject) => {
      const pending = indexedDB.open("haneoka-gacha-history", 3);
      pending.onupgradeneeded = () => {
        if (!pending.result.objectStoreNames.contains("histories"))
          pending.result.createObjectStore("histories", { keyPath: "key" });
        if (!pending.result.objectStoreNames.contains("historyAliases"))
          pending.result.createObjectStore("historyAliases", { keyPath: "key" });
        for (const name of ["cloudAccounts", "cloudLinks"])
          if (!pending.result.objectStoreNames.contains(name))
            pending.result.createObjectStore(name, { keyPath: ["ownerId", "accountKey"] });
      };
      pending.onerror = () => {
        this.database = undefined;
        reject(pending.error);
      };
      pending.onblocked = () => {
        this.database = undefined;
        reject(new Error("history_storage_busy"));
      };
      pending.onsuccess = () => {
        const database = pending.result;
        database.onversionchange = () => {
          database.close();
          this.database = undefined;
        };
        resolve(database);
      };
    }));
  }
  async list(): Promise<StoredHistory[]> {
    const db = await this.db(),
      tx = db.transaction("histories");
    const values: unknown[] = await request(tx.objectStore("histories").getAll());
    return values
      .flatMap((value) => {
        if (!value || typeof value !== "object") return [];
        const record = value as StoredHistory;
        if (typeof record.key !== "string" || !/^[a-f0-9]{64}$/u.test(record.key)) return [];
        try {
          let histories = [parseHistory(record.snapshot)];
          for (const history of record.histories ?? [])
            histories = mergeHistoryCollection(histories, parseHistory(history));
          return [{ key: record.key, snapshot: histories[0], histories,
            aliases: record.aliases?.filter(key => /^[a-f0-9]{64}$/u.test(key)), mergeSources: record.mergeSources }];
        } catch {
          return [];
        }
      })
      .sort((a, b) => Date.parse(b.snapshot.queriedAt) - Date.parse(a.snapshot.queriedAt));
  }
  async import(value: unknown, companionKey?: string): Promise<StoredHistory> {
    const snapshot = parseHistory(value),
      companion = companionKey ? /^([a-f0-9]{64})(?:-(jp|global-hmt|global-en|global-kr))?(?:-kind-[a-f0-9]{16})?$/u.exec(companionKey) : null,
      companionIdentity = companion && (!companion[2] || companion[2] === snapshot.source.server)
        ? `${companion[1]}-${snapshot.source.server}` : undefined,
      bytes = new TextEncoder().encode(
        companionIdentity
          ? `${snapshot.source.server}:${companionIdentity}`
          : JSON.stringify(snapshot),
      );
    const key =
      snapshot.source.accountKey ??
      [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
        .map((value) => value.toString(16).padStart(2, "0"))
        .join("");
    const record: StoredHistory = { key, snapshot, histories: [snapshot] },
      db = await this.db();
    let failure: unknown;
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(["histories", "historyAliases"], "readwrite");
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () => reject(failure ?? tx.error ?? new Error("history_storage_failed"));
      const store = tx.objectStore("histories"), alias = tx.objectStore("historyAliases").get(key);
      alias.onsuccess = () => {
        record.key = alias.result?.target ?? key;
        const incoming = alias.result && snapshot.source.accountKey
          ? { ...snapshot, source: { ...snapshot.source, accountKey: record.key } } : snapshot;
        record.snapshot = incoming; record.histories = [incoming];
        const previous = store.get(record.key);
        previous.onsuccess = () => {
          try {
            if (previous.result) {
              const previousRecord = previous.result as StoredHistory;
              let histories = [parseHistory(previousRecord.snapshot)];
              for (const history of previousRecord.histories ?? [])
                histories = mergeHistoryCollection(histories, parseHistory(history));
              record.histories = mergeHistoryCollection(histories, incoming);
              checkHistoryBudget(record.histories);
              record.snapshot = record.histories[0];
              record.aliases = previousRecord.aliases;
              record.mergeSources = previousRecord.mergeSources;
            }
            store.put(record);
          } catch (error) { failure = error; tx.abort(); }
        };
      };
    });
    this.dispatchEvent(new Event("change"));
    return record;
  }

  /** Explicit selection may copy visible owner-scoped cloud records into the local library. */
  async merge(keys: readonly string[], preferred?: string, visible: readonly StoredHistory[] = [], confirmIdentity = false, valid: () => boolean = () => true): Promise<StoredHistory> {
    if (new Set(keys).size < 2) throw new Error("history_merge_selection");
    const db = await this.db();
    let merged!: StoredHistory;
    let failure: Error | undefined;
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(["histories", "historyAliases"], "readwrite"), store = tx.objectStore("histories");
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () => reject(failure ?? tx.error ?? new Error("history_storage_failed"));
      const pending = store.getAll();
      pending.onsuccess = () => {
        try {
          if (!valid()) throw new Error("history_merge_owner_changed");
          const all = pending.result as StoredHistory[], local = new Map(all.map(row => [row.key, row]));
          const available = new Map([...all, ...visible].map(row => [row.key, row]));
          const selected = [...new Set(keys)].flatMap(key => available.has(key) ? [available.get(key)!] : []);
          if (selected.length !== new Set(keys).size) throw new Error("history_merge_selection");
          const snapshots = selected.flatMap(row => row.histories ?? [row.snapshot]).map(parseHistory);
          if (new Set(snapshots.map(value => value.source.server)).size !== 1) throw new Error("history_merge_server");
          const identity = (row: StoredHistory) => (local.get(row.key) ?? row).snapshot.source.accountKey;
          const identities = new Set(selected.flatMap(row => identity(row) ? [identity(row)!] : []));
          if (identities.size > 1 && !confirmIdentity) throw new Error("history_merge_identity");
          const preferredKey = preferred && keys.includes(preferred) ? preferred : selected[0].key;
          const key = identities.size === 1 ? identities.values().next().value! : preferredKey;
          const existing = all.find(row => row.key === key);
          if (existing && !selected.includes(existing)) selected.push(existing);
          let histories: HistorySnapshot[] = [];
          for (const row of selected) for (const value of row.histories ?? [row.snapshot]) {
            const history = parseHistory(value), source = { ...history.source };
            if (identities.size) source.accountKey = key; else delete source.accountKey;
            histories = mergeHistoryCollection(histories, { ...history, source });
          }
          checkHistoryBudget(histories);
          const aliases = [...new Set(selected.flatMap(row => [row.key, ...row.aliases ?? []]))].filter(value => value !== key);
          const sources = new Map<string, Omit<StoredHistory, "mergeSources">>();
          for (const row of selected) for (const value of [...row.mergeSources ?? [], row]) {
            const { mergeSources: _sources, ...original } = value as StoredHistory;
            sources.set(JSON.stringify(original), original);
          }
          merged = { key, snapshot: histories[0], histories, aliases, mergeSources: [...sources.values()] };
          store.put(merged);
          tx.objectStore("historyAliases").delete(key);
          for (const alias of aliases) { store.delete(alias); tx.objectStore("historyAliases").put({ key: alias, target: key }); }
        } catch (error) { failure = error instanceof Error ? error : new Error("history_merge_failed"); tx.abort(); }
      };
    });
    this.dispatchEvent(new Event("change"));
    return merged;
  }

  async cloudState(ownerId: string): Promise<{ documents: HistoryCloudDocument[]; links: HistoryCloudLink[] }> {
    const db = await this.db(),
      tx = db.transaction(["cloudAccounts", "cloudLinks"]);
    const range = IDBKeyRange.bound([ownerId, ""], [ownerId, "\uffff"]);
    const [cached, linked] = await Promise.all([
      request<HistoryCloudDocument[]>(tx.objectStore("cloudAccounts").getAll(range)),
      request<HistoryCloudLink[]>(tx.objectStore("cloudLinks").getAll(range)),
    ]);
    const documents = cached.flatMap((value) => {
      if (value.ownerId !== ownerId) return [];
      try {
        const parsed = parseStoredCloudHistory(
          { schema: HISTORY_CLOUD_SCHEMA, histories: value.histories },
          value.accountKey,
          value.server,
        );
        return [{ ...value, histories: parsed.histories }];
      } catch {
        return [];
      }
    });
    const links = linked.filter(
      (value) =>
        value.ownerId === ownerId && /^[a-f0-9]{64}$/u.test(value.accountKey) && typeof value.grantId === "string",
    );
    return { documents, links };
  }

  private async cloudWrite(storeName: "cloudAccounts" | "cloudLinks", value: HistoryCloudDocument | HistoryCloudLink) {
    const db = await this.db();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(storeName, "readwrite");
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () => reject(tx.error ?? new Error("history_storage_failed"));
      tx.objectStore(storeName).put(value);
    });
  }
  saveCloud(document: HistoryCloudDocument): Promise<void> {
    return this.cloudWrite("cloudAccounts", document);
  }
  async saveCloudLink(link: HistoryCloudLink, valid: () => boolean, updateOnly = false): Promise<void> {
    const db = await this.db();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("cloudLinks", "readwrite"),
        store = tx.objectStore("cloudLinks");
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () => reject(tx.error ?? new Error("history_storage_failed"));
      if (updateOnly) {
        const previous = store.get([link.ownerId, link.accountKey]);
        previous.onsuccess = () => {
          if (valid() && previous.result?.grantId === link.grantId) store.put(link);
        };
      } else if (valid()) store.put(link);
    });
  }
  async unlinkCloud(ownerId: string, accountKey: string, grantId: string): Promise<void> {
    const db = await this.db();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("cloudLinks", "readwrite");
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () => reject(tx.error ?? new Error("history_storage_failed"));
      const store = tx.objectStore("cloudLinks"),
        previous = store.get([ownerId, accountKey]);
      previous.onsuccess = () => {
        if (previous.result?.grantId === grantId) store.delete([ownerId, accountKey]);
      };
    });
  }
}
export const historyStore = new HistoryStore();
