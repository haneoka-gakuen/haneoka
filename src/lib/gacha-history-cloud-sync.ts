// L3 — GEB
// Input: 原本地记录、现有 Haneoka 会话与显式同步许可。
// Output: 当前 owner 的自动归并视图、原始备份导出及前台云同步。
// Pos: [Map](L2-2.md)；抽卡历史账号同步边界。
// Effects/Dependencies: 读写独立 IndexedDB 云区并发 HTTP；上传只取原本地快照，无后台轮询。
import { fetchJson } from "../lit/shared/catalog";
import { historyStore, type HistoryCloudLink, type StoredHistory } from "./gacha-history-store";
import {
  mergeAccountHistories,
  resolveHistoryAccountKey,
  type HistoryMatchCards,
  type HistoryAccountRecord,
} from "./gacha-history-merge";
import { reconcileHistories } from "./gacha-history-reconcile";
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
  private cards: HistoryMatchCards = {};
  private matches = new Map<string, string>();
  configure(cards: HistoryMatchCards) {
    this.cards = cards;
  }
  canonicalKey(key: string): string {
    return resolveHistoryAccountKey(key, this.local, this.ownerId ? [...this.documents.values()] : [], this.matches);
  }
  hasLocal(key: string): boolean {
    return this.local.some((row) => this.canonicalKey(row.key) === this.canonicalKey(key));
  }
  private linkedKeys(key: string): string[] {
    const canonical = this.canonicalKey(key);
    return [...this.links].flatMap(([value, link]) => !link.disabled && this.canonicalKey(value) === canonical ? [value] : []);
  }
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
  private viewCache?: StoredHistory[];
  private changed() {
    this.viewCache = undefined;
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
    return !!this.ownerId && this.linkedKeys(key).length > 0;
  }
  refreshPending(key: string): boolean {
    const row = this.ownerId ? this.documents.get(this.canonicalKey(key)) : undefined;
    return !!row && row.refreshRequested > row.refreshCompleted;
  }
  visibleRecords(): StoredHistory[] {
    if (this.viewCache) return this.viewCache;
    const records = new Map<string, StoredHistory>();
    const add = (record: StoredHistory) => {
      const key = this.canonicalKey(record.key),
        previous = records.get(key);
      const histories = mergeAccountHistories(
        [
          ...(previous ? [{ key, histories: previous.histories ?? [previous.snapshot] }] : []),
          { key: record.key, histories: record.histories ?? [record.snapshot] },
        ],
        key,
      );
      records.set(key, {
        ...previous,
        ...record,
        key,
        histories,
        snapshot: histories[0],
        aliases: [
          ...new Set([
            ...(previous?.aliases ?? []),
            ...(record.aliases ?? []),
            ...(key === record.key ? [] : [record.key]),
          ]),
        ],
        mergeSources: [...(previous?.mergeSources ?? []), ...(record.mergeSources ?? [])],
      });
    };
    for (const record of this.local) add(record);
    if (this.ownerId)
      for (const row of this.documents.values())
        add({ key: row.accountKey, snapshot: row.histories[0], histories: row.histories, aliases: row.aliases });
    return (this.viewCache = [...records.values()].sort(
      (a, b) => Date.parse(b.snapshot.queriedAt) - Date.parse(a.snapshot.queriedAt),
    ));
  }
  async originals(key: string): Promise<HistoryCloudDocument[]> {
    const canonical = this.canonicalKey(key);
    return this.ownerId && this.documents.has(canonical) ? this.client.originals(canonical) : [];
  }
  private async reconcile(owner: string, generation: number) {
    const records = new Map<string, HistoryAccountRecord>();
    const add = (key: string, histories: HistoryAccountRecord["histories"], aliases: readonly string[] = []) => {
      key = this.canonicalKey(key);
      const previous = records.get(key);
      records.set(key, {
        key,
        ownerId: owner,
        aliases: [...(previous?.aliases ?? []), ...aliases],
        histories: mergeAccountHistories([...(previous ? [previous] : []), { key, histories }], key),
      });
    };
    for (const row of this.documents.values()) add(row.accountKey, row.histories, row.aliases);
    for (const row of this.local) add(row.key, row.histories ?? [row.snapshot], row.aliases);
    const groups = await reconcileHistories([...records.values()], this.cards).catch((error) => {
      this.guard(owner, generation);
      this.errorCode = historyCloudErrorCode(error);
      return [];
    });
    this.guard(owner, generation);
    for (const group of groups) {
      const remote = group.keys.flatMap((key) => (this.documents.has(key) ? [this.documents.get(key)!] : []));
      const canonical = remote[0]?.accountKey ?? group.keys[0];
      const linked = group.keys.some((key) => this.isLinked(key));
      const local = linked ? this.local.filter((row) => group.keys.includes(this.canonicalKey(row.key))) : [];
      const sources = new Map(
        remote.map((row) => [row.accountKey, { accountKey: row.accountKey, revision: row.revision as number | null }]),
      );
      for (const row of local) {
        const key = this.canonicalKey(row.key);
        if (!sources.has(key)) sources.set(key, { accountKey: key, revision: null });
      }
      if (remote.length && sources.size > 1) {
        const histories = mergeAccountHistories(
          [
            ...remote.map((row) => ({ key: row.accountKey, histories: row.histories })),
            ...local.map((row) => ({ key: row.key, histories: row.histories ?? [row.snapshot] })),
          ],
          canonical,
        );
        const document = await this.client.combine(canonical, histories, [...sources.values()]);
        this.guard(owner, generation);
        await this.accept(document, owner, generation);
      }
      for (const key of group.keys) if (key !== canonical) this.matches.set(key, canonical);
    }
    for (const row of [...this.documents.values()]) {
      if (!this.isLinked(row.accountKey)) continue;
      const local = this.local.filter((value) => this.canonicalKey(value.key) === row.accountKey);
      const known = new Set([row.accountKey, ...(row.aliases ?? [])]);
      const unknown = [...new Set(local.flatMap((value) => [value.key, ...(value.aliases ?? [])]))].filter(
        (key) => !known.has(key),
      );
      if (!unknown.length) continue;
      const histories = mergeAccountHistories(
        [
          { key: row.accountKey, histories: row.histories },
          ...local.map((value) => ({ key: value.key, histories: value.histories ?? [value.snapshot] })),
        ],
        row.accountKey,
      );
      const sources = [
        { accountKey: row.accountKey, revision: row.revision },
        ...unknown.map((accountKey) => ({ accountKey, revision: null })),
      ];
      this.guard(owner, generation);
      await this.accept(await this.client.combine(row.accountKey, histories, sources), owner, generation);
    }
    this.changed();
  }
  private revoke = () => {
    this.generation++;
    this.ownerId = null;
    this.documents.clear();
    this.matches.clear();
    this.links.clear();
    this.busy = false;
    this.errorCode = "";
    this.sessionRead = undefined;
    this.lastSync = 0;
    this.changed();
    void this.foreground(true);
  };
  start(initialSync = true) {
    if (this.active) return;
    this.active = true;
    this.lifetime = new AbortController();
    window.addEventListener("haneoka:session-changed", this.revoke, { signal: this.lifetime.signal });
    if (initialSync) void this.foreground(true);
  }
  async syncImported(records: StoredHistory[], expectedOwner: string | null, autoLink = false): Promise<boolean> {
    this.setLocal(records);
    try {
      await this.session();
      if (expectedOwner !== this.ownerId) return false;
      if (expectedOwner && autoLink) {
        const generation = this.generation;
        for (const record of records) {
          const key = this.canonicalKey(record.key);
          if ([...this.links.keys()].some(link => this.canonicalKey(link) === key)) continue;
          const link = await historyStore.ensureCloudLink(
            { ownerId: expectedOwner, accountKey: key, grantId: crypto.randomUUID(), uploaded: {} },
            () => this.active && this.ownerId === expectedOwner && this.generation === generation,
          );
          this.guard(expectedOwner, generation);
          if (link) this.links.set(key, link);
        }
      }
      if (records.some(({ key }) => this.isLinked(key))) await this.syncCurrent(true);
      return true;
    } catch (error) {
      this.fail(error);
      return false;
    }
  }
  async refreshLocalLinks() {
    const owner = this.ownerId, generation = this.generation;
    if (!owner) return;
    try {
      const links = await historyStore.localCloudLinks(owner);
      this.guard(owner, generation);
      this.links = new Map(links.map(link => [link.accountKey, link]));
      this.changed();
    } catch (error) { this.fail(error); }
  }
  stop() {
    this.active = false;
    this.generation++;
    this.lifetime.abort();
    this.ownerId = null;
    this.documents.clear();
    this.matches.clear();
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
        this.matches.clear();
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
      this.matches.clear();
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
        for (const row of this.documents.values()) for (const alias of row.aliases ?? []) this.documents.delete(alias);
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
    const previous = this.linkedKeys(key).flatMap((value) => (this.links.has(value) ? [this.links.get(value)!] : []));
    if (!linked) {
      for (const value of previous) this.links.set(value.accountKey, { ...value, disabled: true });
      this.changed();
    }
    try {
      if (!linked) {
        for (const value of previous) await historyStore.unlinkCloud(owner, value.accountKey, value.grantId);
        return;
      }
      await this.session();
      this.guard(owner, generation);
      if (!this.hasLocal(key) && !this.documents.has(this.canonicalKey(key)))
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
      if (!this.isLinked(key)) throw new HistoryCloudError("history_account_mismatch", 409);
      started = true;
      this.busy = true;
      this.errorCode = "";
      this.changed();
      const canonical = this.canonicalKey(key);
      const document = await this.client.requestRefresh(canonical, this.documents.get(canonical));
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
    if (document.canonicalAccountKey) {
      const key = document.canonicalAccountKey;
      document = {
        ...document,
        accountKey: key,
        canonicalAccountKey: undefined,
        histories: document.histories.map((history) => ({
          ...history,
          source: { ...history.source, accountKey: key },
        })),
      };
    }
    await historyStore.saveCloud(document);
    this.guard(owner, generation);
    for (const key of document.aliases ?? []) this.documents.delete(key);
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
        let conflicts = 0;
        do {
          this.syncAgain = false;
          const summaries = await this.client.list();
          this.guard(owner, generation);
          for (const summary of summaries) {
            const cached = this.documents.get(summary.accountKey);
            if (cached && cached.revision >= summary.revision) {
              if (JSON.stringify(cached.aliases) !== JSON.stringify(summary.aliases))
                await this.accept({ ...cached, ...summary }, owner, generation);
              continue;
            }
            const document = await this.client.read(summary.accountKey);
            this.guard(owner, generation);
            await this.accept(document, owner, generation);
          }
          try {
            await this.reconcile(owner, generation);
          } catch (error) {
            if (error instanceof HistoryCloudError && error.code === "history_merge_conflict" && conflicts++ < 2) {
              this.syncAgain = true;
              continue;
            }
            throw error;
          }
          const uploads = new Map<string, StoredHistory[]>();
          for (const record of this.local) {
            const key = this.canonicalKey(record.key);
            const group = uploads.get(key) ?? [];
            group.push(record);
            uploads.set(key, group);
          }
          for (const [key, records] of uploads) {
            const grantKey = this.linkedKeys(key)[0];
            const initialLink = this.links.get(grantKey);
            if (!initialLink) continue;
            let link: HistoryCloudLink = initialLink;
            const histories = mergeAccountHistories(
              records.map((row) => ({ key: row.key, histories: row.histories ?? [row.snapshot] })),
              key,
            );
            for (const snapshot of histories) {
              if (this.links.get(grantKey) !== link) break;
              const digest = await this.digest(snapshot);
              this.guard(owner, generation);
              if (this.links.get(grantKey) !== link) break;
              if (link.uploaded[snapshot.historyKind] === digest) continue;
              const document = await this.client.upload(key, snapshot);
              this.guard(owner, generation);
              await this.accept(document, owner, generation);
              if (this.links.get(grantKey) !== link) break;
              const updated: HistoryCloudLink = {
                ...link,
                uploaded: { ...link.uploaded, [snapshot.historyKind]: digest },
              };
              const captured = link;
              await historyStore.saveCloudLink(
                updated,
                () => this.ownerId === owner && this.generation === generation && this.links.get(grantKey) === captured,
                true,
              );
              this.guard(owner, generation);
              if (this.links.get(grantKey) !== link) break;
              this.links.set(grantKey, updated);
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
