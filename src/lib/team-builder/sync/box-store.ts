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
  storage?: StorageLike;
  fetcher?: typeof fetch;
  /** Debounce before sending local edits. */
  flushDelayMs?: number;
  /** Background pull period while the page is visible. */
  pullIntervalMs?: number;
}

const replicaKey = (server: string, owner: string | null) =>
  `haneoka:team-box:v1:${owner === null ? "anonymous" : `account:${encodeURIComponent(owner)}`}:${encodeURIComponent(server)}`;
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
  private pullTimer?: ReturnType<typeof setInterval>;
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
        const message = event.data as { server?: string; owner?: string | null };
        if (message?.server === this.options.server && message.owner === this.owner) this.reload();
      };
    }
    if (typeof document !== "undefined") {
      const visible = () => {
        if (document.visibilityState === "visible") void this.refresh();
        else this.flushNow(true);
      };
      const hide = () => this.flushNow(true);
      document.addEventListener("visibilitychange", visible);
      addEventListener("pagehide", hide);
      addEventListener("online", visible);
      this.cleanups.push(
        () => document.removeEventListener("visibilitychange", visible),
        () => removeEventListener("pagehide", hide),
        () => removeEventListener("online", visible),
      );
    }
    this.pullTimer = setInterval(() => {
      if (typeof document === "undefined" || document.visibilityState === "visible") void this.pull();
    }, this.options.pullIntervalMs ?? 90_000);
    // Local data first: the page is usable before the network answers.
    this.useOwner(this.readCachedOwner(), false);
    await this.checkSession(true);
  }
  dispose() {
    this.disposed = true;
    clearTimeout(this.flushTimer);
    clearInterval(this.pullTimer);
    this.channel?.close();
    for (const cleanup of this.cleanups) cleanup();
    this.listeners.clear();
  }

  /** Applies local writes immediately and queues them for the cloud. */
  set(changes: readonly { key: string; value: BoxValue }[]) {
    if (!changes.length) return;
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

  /** Re-checks the session (rate limited) and syncs both ways. */
  async refresh(): Promise<void> {
    await this.checkSession(false);
    await this.pull();
    this.flushNow();
  }

  private readCachedOwner(): string | null {
    const cached = this.storage.getItem("haneoka:team-box:owner");
    return cached ? cached : null;
  }
  private async checkSession(force: boolean) {
    if (!force && Date.now() - this.sessionCheckedAt < 60_000) return;
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
      return;
    }
    if (owner !== this.owner) this.useOwner(owner, true);
    if (owner) {
      await this.migrateCloudOnce();
      await this.pull();
      this.flushNow();
    } else this.setStatus("local");
  }
  private useOwner(owner: string | null, fromSession: boolean) {
    const previous = this.owner;
    this.owner = owner;
    if (fromSession) {
      if (owner) this.storage.setItem("haneoka:team-box:owner", owner);
      else this.storage.removeItem("haneoka:team-box:owner");
    }
    this.replica = this.read(owner);
    for (const entry of Object.values(this.replica.entries)) this.clock.observe(entry.t);
    if (!this.replica.migrated) {
      this.applyMigration(legacyOps(this.storage, this.options.server, owner, this.client));
      this.replica.migrated = true;
      this.persist();
    }
    // Signing in merges what was edited signed out; clocks decide every key.
    if (owner && previous === null) {
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
      const raw = this.storage.getItem(replicaKey(this.options.server, owner));
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
    if (this.owner === undefined) return;
    try {
      this.storage.setItem(replicaKey(this.options.server, this.owner), JSON.stringify(this.replica));
      this.channel?.postMessage({ server: this.options.server, owner: this.owner });
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
    if (this.inflight && !keepalive) return;
    const owner = this.owner;
    const sent = this.replica.outbox.slice(0, 4000);
    const since = this.replica.revision;
    this.setStatus("syncing");
    const task = (async () => {
      try {
        const response = await this.fetcher(`/api/v1/team-box/${encodeURIComponent(this.options.server)}`, {
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
        this.receive((await response.json()) as { revision: number; entries: Record<string, BoxEntry> });
        // Acknowledge exactly what was sent; edits made meanwhile stay queued.
        const acknowledged = new Map(sent.map((op) => [op.k, op.t]));
        this.replica.outbox = this.replica.outbox.filter((op) => acknowledged.get(op.k) !== op.t);
        this.failures = 0;
        this.error = null;
        this.lastSyncedAt = Date.now();
        this.persist();
        this.setStatus(this.replica.outbox.length ? "pending" : "synced");
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
  }
  async pull(): Promise<void> {
    const owner = this.owner;
    if (!owner || this.disposed) return;
    try {
      const response = await this.fetcher(
        `/api/v1/team-box/${encodeURIComponent(this.options.server)}?since=${this.replica.revision}`,
        { credentials: "same-origin", cache: "no-store", headers: { accept: "application/json", "x-haneoka-expected-user": owner } },
      );
      if (owner !== this.owner) return;
      if (response.status === 401 || response.status === 403) {
        this.setStatus("signed-out");
        return;
      }
      if (!response.ok) throw new Error(`http-${response.status}`);
      this.receive((await response.json()) as { revision: number; entries: Record<string, BoxEntry> });
      this.lastSyncedAt = Date.now();
      this.persist();
      this.setStatus(this.replica.outbox.length ? "pending" : "synced");
    } catch (error) {
      this.error = String(error);
      this.setStatus("offline");
    }
  }
  private receive(payload: { revision: number; entries: Record<string, BoxEntry> }) {
    if (!payload || typeof payload.revision !== "number" || typeof payload.entries !== "object") throw new Error("invalid-box-response");
    // A server behind this replica (restored backup) gets everything again.
    if (payload.revision < this.replica.revision) this.replica.outbox = Object.entries(this.replica.entries).map(([k, e]) => ({ k, v: e.v, t: e.t, c: e.c }));
    const changed = mergeEntries(this.replica.entries, payload.entries);
    for (const entry of Object.values(payload.entries)) this.clock.observe(entry.t);
    this.replica.revision = payload.revision;
    if (changed.length) this.changed();
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
