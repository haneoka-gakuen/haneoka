// L3 — GEB
// Input: server、存储／fetch 接口、会话与用户操作。
// Output: BoxStore、BoxSnapshot 和同步状态。
// Pos: [Map](L2-2.md)；当前配队的本地优先 Box 副本与后台同步。
// Effects/Dependencies: 读写 localStorage 或注入存储，认证网络同步和事件通知；换号／离线有独立状态。
/** Local-first replica of the team box with background, conflict-free cloud sync. */
import { BoxClock, mergeEntries, newer, validEntry, type BoxEntry, type BoxOp, type BoxValue } from "./box-doc";
import { legacyOps } from "./legacy";

export type BoxSyncStatus = "local" | "syncing" | "synced" | "pending" | "offline" | "signed-out" | "error";
export interface BoxSnapshot {
  /** undefined while the session is unknown; null when signed out. */
  owner: string | null | undefined;
  entries: Readonly<Record<string, BoxEntry>>;
  status: BoxSyncStatus;
  pending: number;
  lastSyncedAt: number | null;
  error: string | null;
  /** Bumps on every visible change. */
  version: number;
}
interface Replica {
  schema: "haneoka-team-box-replica-v1";
  revision: number;
  entries: Record<string, BoxEntry>;
  outbox: BoxOp[];
  migrated: boolean;
}
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  readonly length: number;
  key(index: number): string | null;
}
export interface BoxStoreOptions {
  server: string;
  accountId?: string;
  accountOwner?: string | null;
  storage?: StorageLike;
  fetcher?: typeof fetch;
  /** Debounce before sending local edits. */
  flushDelayMs?: number;
  /** Minimum background pull period while the page is visible. */
  pullIntervalMs?: number;
}

const replicaKey = (server: string, owner: string | null, accountId?: string) =>
  `haneoka:team-box:v1:${owner === null ? "anonymous" : `account:${encodeURIComponent(owner)}`}:${encodeURIComponent(server)}${accountId ? `:${accountId}` : ""}`;
const CLIENT_KEY = "haneoka:team-box:client";
const emptyReplica = (): Replica => ({ schema: "haneoka-team-box-replica-v1", revision: 0, entries: {}, outbox: [], migrated: false });
const BACKOFF = [1500, 4000, 10000, 30000, 60000];

export class BoxStore {
  private replica: Replica = emptyReplica();
  private owner: string | null | undefined = undefined;
  private status: BoxSyncStatus = "local";
  private error: string | null = null;
  private lastSyncedAt: number | null = null;
  private version = 0;
  private readonly clock = new BoxClock();
  private readonly client: string;
  private readonly storage: StorageLike;
  private readonly fetcher: typeof fetch;
  private readonly listeners = new Set<(snapshot: BoxSnapshot) => void>();
  private flushTimer?: ReturnType<typeof setTimeout>;
  private pullTimer?: ReturnType<typeof setTimeout>;
  private idlePullDelay?: number;
  private pulling?: { owner: string; promise: Promise<void> };
  private inflight: Promise<void> | null = null;
  private failures = 0;
  private channel: BroadcastChannel | null = null;
  private sessionCheckedAt = 0;
  private disposed = false;
  private readonly cleanups: (() => void)[] = [];

  constructor(private readonly options: BoxStoreOptions) {
    this.storage = options.storage ?? globalThis.localStorage;
    this.fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
    let client = this.storage.getItem(CLIENT_KEY);
    if (!client || !/^[A-Za-z0-9_-]{6,40}$/u.test(client)) {
      client = (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}${Math.random()}`).replace(/[^A-Za-z0-9]/gu, "").slice(0, 24);
      this.storage.setItem(CLIENT_KEY, client);
    }
    this.client = client;
  }
  private boxUrl(since?: number) {
    const query = new URLSearchParams();
    if (this.options.accountId) query.set("gameAccount", this.options.accountId);
    if (since !== undefined) query.set("since", String(since));
    return `/api/v1/team-box/${encodeURIComponent(this.options.server)}${query.size ? `?${query}` : ""}`;
  }

  get snapshot(): BoxSnapshot {
    return {
      owner: this.owner,
      entries: this.replica.entries,
      status: this.status,
      pending: this.replica.outbox.length,
      lastSyncedAt: this.lastSyncedAt,
      error: this.error,
      version: this.version,
    };
  }
  subscribe(listener: (snapshot: BoxSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot);
    return () => this.listeners.delete(listener);
  }
  value(key: string): BoxValue | undefined {
    const entry = this.replica.entries[key];
    return entry ? entry.v : undefined;
  }

  /** Reads the session, loads the matching replica and starts syncing. */
  async start(): Promise<void> {
    if (typeof BroadcastChannel !== "undefined") {
      this.channel = new BroadcastChannel("haneoka-team-box");
      this.channel.onmessage = (event: MessageEvent) => {
        const message = event.data as { server?: string; owner?: string | null; accountId?: string };
        if (message?.server === this.options.server && message.owner === this.owner && message.accountId === this.options.accountId)
          this.reload();
      };
    }
    if (typeof document !== "undefined") {
      const visible = () => {
        if (document.hidden) {
          clearTimeout(this.pullTimer);
          this.flushNow(true);
          return;
        }
        if (this.status === "signed-out" || Date.now() - (this.lastSyncedAt ?? 0) >= this.pullFloor)
          void this.refresh();
        else this.schedulePull();
      };
      const online = () => void this.refresh();
      const sessionChanged = () => void this.checkSession(true);
      const hide = () => this.flushNow(true);
      document.addEventListener("visibilitychange", visible);
      addEventListener("haneoka:session-changed", sessionChanged);
      addEventListener("pagehide", hide);
      addEventListener("online", online);
      this.cleanups.push(
        () => document.removeEventListener("visibilitychange", visible),
        () => removeEventListener("haneoka:session-changed", sessionChanged),
        () => removeEventListener("pagehide", hide),
        () => removeEventListener("online", online),
      );
    }
    // Local data first: the page is usable before the network answers.
    this.useOwner(this.readCachedOwner(), false);
    await this.checkSession(true);
    this.schedulePull();
  }
  dispose() {
    this.disposed = true;
    clearTimeout(this.flushTimer);
    clearTimeout(this.pullTimer);
    this.channel?.close();
    for (const cleanup of this.cleanups) cleanup();
    this.listeners.clear();
  }

  /** Applies local writes immediately and queues them for the cloud. */
  set(changes: readonly { key: string; value: BoxValue }[]) {
    if (this.disposed || !changes.length) return;
    const ops: BoxOp[] = [];
    for (const { key, value } of changes) {
      if (!validEntry(key, value)) throw new RangeError(`invalid-box-entry:${key}`);
      const current = this.replica.entries[key];
      if (current && JSON.stringify(current.v) === JSON.stringify(value)) continue;
      const op: BoxOp = { k: key, v: value, t: this.clock.next(), c: this.client };
      this.replica.entries[key] = { v: value, t: op.t, c: op.c, r: current?.r ?? 0 };
      ops.push(op);
    }
    if (!ops.length) return;
    // Only the newest unsent value of a key needs to travel.
    const replaced = new Set(ops.map((op) => op.k));
    this.replica.outbox = [...this.replica.outbox.filter((op) => !replaced.has(op.k)), ...ops];
    this.persist();
    this.changed();
    this.scheduleFlush();
  }

  /** A background save updates one account atomically, after the source version is registered. */
  async applyGameSave(changes: readonly { key: string; value: BoxValue }[], saveTime: number): Promise<boolean> {
    if (!this.options.accountId || this.disposed || this.owner === undefined) return false;
    const owner = this.owner;
    if (!owner) { this.set(changes); return true; }
    if (!await this.flushPending() || this.disposed || this.owner !== owner) return false;
    const since = this.replica.revision;
    const ops = changes.filter(({ key, value }) => JSON.stringify(this.value(key)) !== JSON.stringify(value))
      .map(({ key, value }) => ({ k: key, v: value, t: this.clock.next(), c: this.client }));
    if (!ops.length) return true;
    try {
      const response = await this.fetcher(this.boxUrl(), {
        method: "POST", credentials: "same-origin", cache: "no-store",
        headers: { "x-haneoka-expected-user": owner, "content-type": "application/json" },
        body: JSON.stringify({ since, ops, saveTime }),
      });
      if (this.disposed || this.owner !== owner) return false;
      if (!response.ok) {
        if (response.status !== 409) return false;
        const result = await response.json() as { error?: { code?: string } };
        return result.error?.code === "stale_game_save";
      }
      const body = await response.json() as { revision: number; entries: Record<string, BoxEntry> };
      if (this.disposed || this.owner !== owner) return false;
      this.receive(body, since);
      this.persist();
      this.changed();
      return true;
    } catch { return false; }
  }

  /** Re-checks the session (rate limited) and syncs both ways. */
  async refresh(): Promise<void> {
    if (!(await this.checkSession(false))) await this.pull();
    this.flushNow();
  }

  private readCachedOwner(): string | null {
    if (this.options.accountId) return this.options.accountOwner ?? null;
    const cached = this.storage.getItem("haneoka:team-box:owner");
    return cached ? cached : null;
  }
  private async checkSession(force: boolean) {
    if (this.disposed || !force && Date.now() - this.sessionCheckedAt < 60_000) return false;
    this.sessionCheckedAt = Date.now();
    let owner: string | null;
    try {
      const response = await this.fetcher("/api/auth/get-session", { credentials: "same-origin", cache: "no-store" });
      if (!response.ok) owner = null;
      else {
        const session = (await response.json()) as { user?: { id?: unknown } } | null;
        owner = typeof session?.user?.id === "string" ? session.user.id : null;
      }
    } catch {
      // Offline: keep working on the cached account's replica.
      if (this.owner === undefined) this.useOwner(this.readCachedOwner(), false);
      this.setStatus(this.owner ? "offline" : "local");
      return false;
    }
    if (this.disposed) return false;
    if (this.options.accountId && owner !== (this.options.accountOwner ?? null)) {
      this.setStatus("signed-out");
      return true;
    }
    if (owner !== this.owner) this.useOwner(owner, true);
    if (owner) {
      if (!this.options.accountId) await this.migrateCloudOnce();
      await this.pull();
      this.flushNow();
      return true;
    }
    this.setStatus("local");
    return false;
  }
  private useOwner(owner: string | null, fromSession: boolean) {
    const previous = this.owner;
    this.owner = owner;
    this.idlePullDelay = undefined;
    this.lastSyncedAt = null;
    clearTimeout(this.pullTimer);
    if (fromSession) {
      if (owner) this.storage.setItem("haneoka:team-box:owner", owner);
      else this.storage.removeItem("haneoka:team-box:owner");
    }
    this.replica = this.read(owner);
    for (const entry of Object.values(this.replica.entries)) this.clock.observe(entry.t);
    if (!this.replica.migrated) {
      if (!this.options.accountId) this.applyMigration(legacyOps(this.storage, this.options.server, owner, this.client));
      this.replica.migrated = true;
      this.persist();
    }
    // Signing in merges what was edited signed out; clocks decide every key.
    if (!this.options.accountId && owner && previous === null) {
      const anonymous = this.read(null);
      const ops = Object.entries(anonymous.entries).map(([k, entry]) => ({ k, v: entry.v, t: entry.t, c: entry.c }));
      this.applyMigration(ops);
    }
    this.failures = 0;
    this.setStatus(owner ? (this.replica.outbox.length ? "pending" : "syncing") : "local");
    this.changed();
  }
  /** Ops merged as if received: older than local values they lose, and they are sent on. */
  private applyMigration(ops: readonly BoxOp[]) {
    const accepted: BoxOp[] = [];
    for (const op of ops) {
      if (!validEntry(op.k, op.v)) continue;
      if (!newer(op, this.replica.entries[op.k])) continue;
      this.replica.entries[op.k] = { v: op.v, t: op.t, c: op.c, r: 0 };
      this.clock.observe(op.t);
      accepted.push(op);
    }
    if (!accepted.length) return;
    const keys = new Set(accepted.map((op) => op.k));
    this.replica.outbox = [...this.replica.outbox.filter((op) => !keys.has(op.k)), ...accepted];
    this.persist();
    this.scheduleFlush();
  }
  private async migrateCloudOnce() {
    const owner = this.owner;
    if (!owner) return;
    const flag = `haneoka:team-box:cloud-migrated:${encodeURIComponent(owner)}:${encodeURIComponent(this.options.server)}`;
    if (this.storage.getItem(flag)) return;
    try {
      const server = encodeURIComponent(this.options.server);
      const headers = { accept: "application/json", "x-haneoka-expected-user": owner };
      const [inventory, workspace] = await Promise.all(
        [`/api/v1/team-inventory/${server}`, `/api/v1/team-workspace/${server}`].map(async (url) => {
          const response = await this.fetcher(url, { credentials: "same-origin", cache: "no-store", headers });
          return response.ok ? ((await response.json()) as Record<string, unknown>) : null;
        }),
      );
      const { cloudLegacyOps } = await import("./legacy");
      this.applyMigration(cloudLegacyOps(inventory?.inventory ?? null, workspace?.workspace ?? null, this.client));
      this.storage.setItem(flag, "1");
    } catch {
      // Retried at the next session check.
    }
  }

  private read(owner: string | null): Replica {
    try {
      const raw = this.storage.getItem(replicaKey(this.options.server, owner, this.options.accountId));
      if (!raw) return emptyReplica();
      const value = JSON.parse(raw) as Replica;
      if (value?.schema !== "haneoka-team-box-replica-v1" || typeof value.entries !== "object") return emptyReplica();
      value.outbox = Array.isArray(value.outbox) ? value.outbox : [];
      return value;
    } catch {
      return emptyReplica();
    }
  }
  private persist() {
    if (this.disposed || this.owner === undefined) return;
    try {
      this.storage.setItem(replicaKey(this.options.server, this.owner, this.options.accountId), JSON.stringify(this.replica));
      this.channel?.postMessage({ server: this.options.server, owner: this.owner, accountId: this.options.accountId });
    } catch (error) {
      this.error = String(error);
    }
  }
  /** Another tab wrote: adopt its replica, keeping any newer local clocks. */
  private reload() {
    const other = this.read(this.owner ?? null);
    const local = this.replica;
    mergeEntries(other.entries, local.entries);
    const keys = new Set(other.outbox.map((op) => op.k));
    other.outbox = [...other.outbox, ...local.outbox.filter((op) => !keys.has(op.k) || newer(op, other.entries[op.k]))];
    other.revision = Math.max(other.revision, local.revision);
    this.replica = other;
    for (const entry of Object.values(other.entries)) this.clock.observe(entry.t);
    this.changed();
  }

  private scheduleFlush() {
    if (!this.owner) return;
    clearTimeout(this.flushTimer);
    this.setStatus("pending");
    this.flushTimer = setTimeout(() => this.flushNow(), this.options.flushDelayMs ?? 700);
  }
  /** Sends the outbox; `keepalive` lets it survive page unload. */
  flushNow(keepalive = false) {
    clearTimeout(this.flushTimer);
    if (!this.owner || !this.replica.outbox.length || this.disposed) return;
    if (this.inflight && !keepalive) return this.inflight;
    const owner = this.owner;
    const sent = this.replica.outbox.slice(0, 4000);
    const since = this.replica.revision;
    this.setStatus("syncing");
    const task = (async () => {
      try {
        const response = await this.fetcher(this.boxUrl(), {
          method: "POST",
          credentials: "same-origin",
          cache: "no-store",
          keepalive,
          headers: { accept: "application/json", "content-type": "application/json", "x-haneoka-expected-user": owner },
          body: JSON.stringify({ since, ops: sent }),
        });
        if (owner !== this.owner) return;
        if (response.status === 401 || response.status === 403) {
          this.error = `http-${response.status}`;
          this.setStatus("signed-out");
          return;
        }
        if (!response.ok) throw new Error(`http-${response.status}`);
        this.receive((await response.json()) as { revision: number; entries: Record<string, BoxEntry> }, since);
        // Acknowledge exactly what was sent; edits made meanwhile stay queued.
        const acknowledged = new Map(sent.map((op) => [op.k, op.t]));
        this.replica.outbox = this.replica.outbox.filter((op) => acknowledged.get(op.k) !== op.t);
        this.failures = 0;
        this.error = null;
        this.lastSyncedAt = Date.now();
        this.persist();
        this.setStatus(this.replica.outbox.length ? "pending" : "synced");
        this.idlePullDelay = undefined;
        this.schedulePull();
        if (this.replica.outbox.length) this.scheduleFlush();
      } catch (error) {
        if (owner !== this.owner) return;
        this.error = String(error);
        this.setStatus("offline");
        const delay = BACKOFF[Math.min(this.failures++, BACKOFF.length - 1)]!;
        clearTimeout(this.flushTimer);
        this.flushTimer = setTimeout(() => this.flushNow(), delay);
      }
    })();
    this.inflight = task.finally(() => {
      if (this.inflight === wrapped) this.inflight = null;
    });
    const wrapped = this.inflight;
    return wrapped;
  }
  /** Wait for this owner's queued edits to be acknowledged before closing a background replica. */
  async flushPending(): Promise<boolean> {
    const owner = this.owner;
    if (!owner) return this.owner === null;
    await this.inflight;
    while (owner === this.owner && this.replica.outbox.length) {
      const pending = this.replica.outbox.length;
      const flush = this.flushNow();
      if (!flush) return false;
      await flush;
      if (this.replica.outbox.length >= pending || this.status === "offline" || this.status === "signed-out") return false;
    }
    return owner === this.owner;
  }
  private get pullFloor() {
    return this.options.pullIntervalMs ?? 90_000;
  }

  private schedulePull() {
    clearTimeout(this.pullTimer);
    if (!this.owner || this.disposed || this.status === "signed-out" ||
        typeof document !== "undefined" && document.hidden) return;
    this.pullTimer = setTimeout(() => void this.pull(), this.idlePullDelay ?? this.pullFloor);
  }

  pull(): Promise<void> {
    const owner = this.owner;
    if (!owner || this.disposed) return Promise.resolve();
    if (this.pulling?.owner === owner) return this.pulling.promise;
    const since = this.replica.revision;
    const promise = this.pullReplica(owner, since).finally(() => {
      if (this.pulling?.promise === promise) this.pulling = undefined;
      if (this.owner === owner) this.schedulePull();
    });
    this.pulling = { owner, promise };
    return promise;
  }

  private async pullReplica(owner: string, since: number): Promise<void> {
    try {
      const response = await this.fetcher(
        this.boxUrl(since),
        { credentials: "same-origin", cache: "no-store", headers: { accept: "application/json", "x-haneoka-expected-user": owner } },
      );
      if (owner !== this.owner || this.disposed) return;
      if ([401, 403, 409].includes(response.status)) {
        this.sessionCheckedAt = 0;
        this.setStatus("signed-out");
        return;
      }
      if (!response.ok) throw new Error(`http-${response.status}`);
      const body = (await response.json()) as { revision: number; entries: Record<string, BoxEntry> };
      if (owner !== this.owner || this.disposed) return;
      const changed = this.receive(body, since);
      const idle = !changed && this.status === "synced" && !this.replica.outbox.length;
      this.idlePullDelay = idle
        ? Math.min(4 * this.pullFloor, 2 * (this.idlePullDelay ?? this.pullFloor))
        : undefined;
      this.lastSyncedAt = Date.now();
      this.error = null;
      if (changed) this.persist();
      this.setStatus(this.replica.outbox.length ? "pending" : "synced");
      if (this.replica.outbox.length && !this.inflight) this.scheduleFlush();
    } catch (error) {
      if (owner !== this.owner || this.disposed) return;
      this.error = String(error);
      this.setStatus("offline");
    }
  }
  private receive(payload: { revision: number; entries: Record<string, BoxEntry> }, since: number) {
    if (!payload || typeof payload.revision !== "number" || typeof payload.entries !== "object") throw new Error("invalid-box-response");
    const previous = this.replica.revision;
    if (payload.revision < previous && previous !== since) return false;
    // A server behind this replica (restored backup) gets everything again.
    if (payload.revision < previous) this.replica.outbox = Object.entries(this.replica.entries).map(([k, e]) => ({ k, v: e.v, t: e.t, c: e.c }));
    const changed = mergeEntries(this.replica.entries, payload.entries);
    for (const entry of Object.values(payload.entries)) this.clock.observe(entry.t);
    this.replica.revision = payload.revision;
    if (changed.length) this.changed();
    return changed.length > 0 || previous !== payload.revision;
  }
  private setStatus(status: BoxSyncStatus) {
    if (this.status === status) return;
    this.status = status;
    this.changed();
  }
  private changed() {
    this.version++;
    const snapshot = this.snapshot;
    for (const listener of this.listeners) listener(snapshot);
  }
}
