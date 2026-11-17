// L3 — GEB
// Input: 原本地记录、现有 Haneoka 会话与显式同步许可。
// Output: 当前 owner 的可见合并视图、显式本地别名投影及前台云同步。
// Pos: [Map](L2-2.md)；抽卡历史账号同步边界。
// Effects/Dependencies: 读写独立 IndexedDB 云区并发 HTTP；上传只取原本地快照，无后台轮询。
import { fetchJson } from "../lit/shared/catalog";
import { historyStore, type HistoryCloudLink, type StoredHistory } from "./gacha-history-store";
import { mergeHistoryCollection } from "./gacha-history-data";
import {
  HistoryCloudClient,
  HistoryCloudError,
  historyCloudErrorCode,
  type HistoryCloudDocument,
} from "./gacha-history-cloud";

/** Browser lifecycle over the existing local library and authenticated transport.
 * Downloaded histories stay in their owner's cache; uploads read local records only. */
export class HistoryCloudSync extends EventTarget {
  ownerId: string | null = null;
  busy = false;
  errorCode = "";
  private documents = new Map<string, HistoryCloudDocument>();
  private links = new Map<string, HistoryCloudLink>();
  private local: StoredHistory[] = [];
  private generation = 0;
  private lastSync = 0;
  private inflight?: { generation: number; promise: Promise<void> };
  private sessionRead?: Promise<void>;
  private syncAgain = false;
  private lifetime = new AbortController();
  private active = false;
  private client = new HistoryCloudClient({
    ownerId: () => this.ownerId,
    fetcher: (input, init) =>
      fetch(input, {
        ...init,
        signal: AbortSignal.any([this.lifetime.signal, ...(init?.signal ? [init.signal] : [])]),
      }),
  });
  private changed() {
    this.dispatchEvent(new Event("change"));
  }
  private guard(owner: string, generation: number) {
    if (!this.active || this.ownerId !== owner || generation !== this.generation)
      throw new HistoryCloudError("account_changed", 409);
  }
  setLocal(records: StoredHistory[]) {
    this.local = records;
    this.changed();
  }
  isLinked(key: string): boolean {
    return !!this.ownerId && this.links.has(key);
  }
  refreshPending(key: string): boolean {
    const row = this.ownerId ? this.documents.get(key) : undefined;
    return !!row && row.refreshRequested > row.refreshCompleted;
  }
  visibleRecords(): StoredHistory[] {
    const records = new Map(this.local.map((record) => [record.key, record]));
    const aliases = new Map(this.local.flatMap(record => (record.aliases ?? []).map(key => [key, record.key] as const)));
    if (this.ownerId)
      for (const document of this.documents.values()) {
        const key = aliases.get(document.accountKey) ?? document.accountKey;
        const previous = records.get(key);
        if (previous && previous.snapshot.source.server !== document.server) continue;
        let histories = previous?.histories ?? (previous ? [previous.snapshot] : []);
        for (const incoming of document.histories) histories = mergeHistoryCollection(histories,
          key === document.accountKey ? incoming : { ...incoming, source: { ...incoming.source, accountKey: previous?.snapshot.source.accountKey ?? key } });
        if (histories.length)
          records.set(key, { ...previous, key, snapshot: histories[0], histories });
      }
    return [...records.values()].sort((a, b) => Date.parse(b.snapshot.queriedAt) - Date.parse(a.snapshot.queriedAt));
  }
  private revoke = () => {
    this.generation++;
    this.ownerId = null;
    this.documents.clear();
    this.links.clear();
    this.busy = false;
    this.errorCode = "";
    this.sessionRead = undefined;
    this.lastSync = 0;
    this.changed();
    void this.foreground(true);
  };
  private focus = () => {
    if (document.visibilityState === "visible") void this.foreground();
  };
  start() {
    if (this.active) return;
    this.active = true;
    this.lifetime = new AbortController();
    window.addEventListener("haneoka:session-changed", this.revoke, { signal: this.lifetime.signal });
    window.addEventListener("focus", this.focus, { signal: this.lifetime.signal });
    document.addEventListener("visibilitychange", this.focus, { signal: this.lifetime.signal });
    void this.foreground(true);
  }
  stop() {
    this.active = false;
    this.generation++;
    this.lifetime.abort();
    this.ownerId = null;
    this.documents.clear();
    this.links.clear();
    this.busy = false;
    this.sessionRead = undefined;
    this.changed();
  }
  private session(): Promise<void> {
    if (this.sessionRead) return this.sessionRead;
    const generation = this.generation;
    const pending = (async () => {
      let value: { user?: { id?: unknown } } | null;
      try {
        value = await fetchJson<typeof value>("/api/auth/get-session", {
          credentials: "same-origin",
          cache: "no-store",
          signal: AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(30_000)]),
        });
      } catch (error) {
        if (!this.active || this.generation !== generation) throw new HistoryCloudError("account_changed", 409);
        this.generation++;
        this.ownerId = null;
        this.documents.clear();
        this.links.clear();
        this.changed();
        throw error;
      }
      if (!this.active || this.generation !== generation) throw new HistoryCloudError("account_changed", 409);
      const owner = typeof value?.user?.id === "string" ? value.user.id : null;
      if (owner === this.ownerId) return;
      this.generation++;
      this.ownerId = owner;
      this.documents.clear();
      this.links.clear();
      this.busy = false;
      this.errorCode = "";
      this.lastSync = 0;
      this.changed();
      if (owner) {
        const current = this.generation;
        let cached: Awaited<ReturnType<typeof historyStore.cloudState>>;
        try {
          cached = await historyStore.cloudState(owner);
        } catch (error) {
          this.guard(owner, current);
          throw error;
        }
        this.guard(owner, current);
        this.documents = new Map(cached.documents.map((row) => [row.accountKey, row]));
        this.links = new Map(cached.links.map((row) => [row.accountKey, row]));
        this.changed();
      }
    })();
    this.sessionRead = pending;
    void pending
      .finally(() => {
        if (this.sessionRead === pending) this.sessionRead = undefined;
      })
      .catch(() => {});
    return pending;
  }
  private fail(error: unknown) {
    const code = historyCloudErrorCode(error);
    if (code !== "account_changed" && !this.lifetime.signal.aborted) {
      this.errorCode = code;
      this.changed();
    }
  }
  private async foreground(force = false) {
    try {
      await this.session();
      await this.syncCurrent(force);
    } catch (error) {
      this.fail(error);
    }
  }
  async sync(force = true) {
    const expected = this.ownerId,
      generation = this.generation;
    try {
      await this.session();
      if (expected) this.guard(expected, generation);
      await this.syncCurrent(force);
    } catch (error) {
      this.fail(error);
    }
  }
  async setLinked(key: string, linked: boolean) {
    const owner = this.ownerId,
      generation = this.generation;
    if (!owner) {
      this.fail(new HistoryCloudError("authentication_required", 401));
      return;
    }
    const previous = this.links.get(key);
    if (!linked) {
      this.links.delete(key);
      this.changed();
    }
    try {
      if (!linked) {
        if (previous) await historyStore.unlinkCloud(owner, key, previous.grantId);
        return;
      }
      await this.session();
      this.guard(owner, generation);
      if (!this.local.some((record) => record.key === key) && !this.documents.has(key))
        throw new HistoryCloudError("history_account_mismatch", 409);
      if (linked) {
        const link: HistoryCloudLink = { ownerId: owner, accountKey: key, grantId: crypto.randomUUID(), uploaded: {} };
        this.links.set(key, link);
        this.changed();
        await historyStore.saveCloudLink(
          link,
          () => this.ownerId === owner && this.generation === generation && this.links.get(key) === link,
        );
        this.guard(owner, generation);
        if (this.links.get(key) !== link) return;
      }
      this.changed();
      if (linked) await this.syncCurrent(true);
    } catch (error) {
      if (owner === this.ownerId && generation === this.generation) this.fail(error);
    }
  }
  async requestRefresh(key: string) {
    const owner = this.ownerId,
      generation = this.generation;
    if (!owner) {
      this.fail(new HistoryCloudError("authentication_required", 401));
      return;
    }
    let started = false;
    try {
      await this.session();
      this.guard(owner, generation);
      if (this.busy) return;
      if (!this.links.has(key)) throw new HistoryCloudError("history_account_mismatch", 409);
      started = true;
      this.busy = true;
      this.errorCode = "";
      this.changed();
      const document = await this.client.requestRefresh(key);
      this.guard(owner, generation);
      await this.accept(document, owner, generation);
    } catch (error) {
      if (owner === this.ownerId && generation === this.generation) this.fail(error);
    } finally {
      if (started && owner === this.ownerId && generation === this.generation) {
        this.busy = false;
        this.changed();
      }
    }
  }
  private async accept(document: HistoryCloudDocument, owner: string, generation: number) {
    this.guard(owner, generation);
    await historyStore.saveCloud(document);
    this.guard(owner, generation);
    this.documents.set(document.accountKey, document);
    this.changed();
  }
  private async digest(value: unknown): Promise<string> {
    return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value))))]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  }
  private syncCurrent(force: boolean): Promise<void> {
    const owner = this.ownerId,
      generation = this.generation;
    if (!owner) return Promise.resolve();
    if (this.busy && !this.inflight) return Promise.resolve();
    if (this.inflight?.generation === generation) {
      this.syncAgain ||= force;
      return this.inflight.promise;
    }
    if (!force && Date.now() - this.lastSync < 30_000) return Promise.resolve();
    const promise = (async () => {
      this.lastSync = Date.now();
      this.busy = true;
      this.errorCode = "";
      this.changed();
      try {
        do {
          this.syncAgain = false;
          const summaries = await this.client.list();
          this.guard(owner, generation);
          for (const summary of summaries) {
            if ((this.documents.get(summary.accountKey)?.revision ?? -1) >= summary.revision) continue;
            const document = await this.client.read(summary.accountKey);
            this.guard(owner, generation);
            await this.accept(document, owner, generation);
          }
          for (const record of this.local) {
            const initialLink = this.links.get(record.key);
            if (!initialLink) continue;
            let link: HistoryCloudLink = initialLink;
            for (const snapshot of record.histories ?? [record.snapshot]) {
              if (this.links.get(record.key) !== link) break;
              const digest = await this.digest(snapshot);
              this.guard(owner, generation);
              if (this.links.get(record.key) !== link) break;
              if (link.uploaded[snapshot.historyKind] === digest) continue;
              const document = await this.client.upload(record.key, snapshot);
              this.guard(owner, generation);
              await this.accept(document, owner, generation);
              if (this.links.get(record.key) !== link) break;
              const updated: HistoryCloudLink = {
                ...link,
                uploaded: { ...link.uploaded, [snapshot.historyKind]: digest },
              };
              const captured = link;
              await historyStore.saveCloudLink(
                updated,
                () =>
                  this.ownerId === owner && this.generation === generation && this.links.get(record.key) === captured,
                true,
              );
              this.guard(owner, generation);
              if (this.links.get(record.key) !== link) break;
              this.links.set(record.key, updated);
              link = updated;
            }
          }
          this.lastSync = Date.now();
        } while (this.syncAgain);
      } catch (error) {
        this.guard(owner, generation);
        throw error;
      } finally {
        if (generation === this.generation) {
          this.busy = false;
          this.changed();
        }
      }
    })();
    this.inflight = { generation, promise };
    void promise
      .finally(() => {
        if (this.inflight?.promise === promise) this.inflight = undefined;
      })
      .catch(() => {});
    return promise;
  }
}
