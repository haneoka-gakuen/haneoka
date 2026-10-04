import type { StorageLike } from "../storage";
import {
  checkTeamWorkspace,
  createEmptyTeamWorkspace,
  MAX_WORKSPACE_BYTES,
  type TeamWorkspaceV1,
} from "./workspace-document";

export interface CloudTeamWorkspace {
  ownerId: string;
  server: string;
  revision: number;
  workspace: TeamWorkspaceV1 | null;
}
export interface WorkspaceStoreState {
  ownerId: string | null;
  workspace: TeamWorkspaceV1 | null;
  revision: number;
  dirty: boolean;
  phase:
    | "auth-loading"
    | "loading"
    | "anonymous"
    | "saved"
    | "pending"
    | "saving"
    | "offline"
    | "conflict"
    | "merge-required"
    | "error";
  remote?: CloudTeamWorkspace;
  error?: string;
  authorityError?: { status: number; code: string };
  localConflict?: { ownerId: string | null; workspace: TeamWorkspaceV1 | null; pendingWorkspace: TeamWorkspaceV1; baseRevision: number | null; backupKey?: string };
}
const storageKey = (server: string, owner: string | null) =>
  `haneoka:team-workspace:v1:${owner === null ? "anonymous" : `account:${encodeURIComponent(owner)}`}:${encodeURIComponent(server)}`;
const validRevision = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value < Number.MAX_SAFE_INTEGER;
const equal = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b))
    return (
      Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, index) => equal(value, b[index]))
    );
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  return (
    Object.keys(a).length === Object.keys(b).length &&
    Object.entries(a).every(
      ([key, value]) => Object.hasOwn(b, key) && equal(value, (b as Record<string, unknown>)[key]),
    )
  );
};

export function mergeTeamWorkspaces(
  cloud: TeamWorkspaceV1,
  local: TeamWorkspaceV1,
  priority?: "cloud" | "local",
): TeamWorkspaceV1 {
  if (cloud.server !== local.server) throw new TypeError("team-workspace-server-mismatch");
  const result = checkTeamWorkspace(cloud, cloud.server);
  checkTeamWorkspace(local, cloud.server);
  for (const kind of ["profiles", "teams"] as const) {
    const merged = new Map<string, (typeof result)[typeof kind][number]>();
    for (const record of result[kind]) merged.set(record.id, record);
    for (const record of local[kind]) {
      const previous = merged.get(record.id);
      if (previous && !equal(previous, record) && !priority)
        throw new TypeError("team-workspace-merge-choice-required");
      if (!previous || priority === "local") merged.set(record.id, structuredClone(record));
    }
    if (kind === "profiles") result.profiles = [...merged.values()] as TeamWorkspaceV1["profiles"];
    else result.teams = [...merged.values()] as TeamWorkspaceV1["teams"];
  }
  if (
    cloud.activeProfileId !== local.activeProfileId &&
    !priority &&
    cloud.activeProfileId !== null &&
    local.activeProfileId !== null
  )
    throw new TypeError("team-workspace-merge-choice-required");
  if (priority === "local" || (!priority && cloud.activeProfileId === null))
    result.activeProfileId = local.activeProfileId;
  return checkTeamWorkspace(result, result.server);
}

export class CloudTeamWorkspaceRequestError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

export function createCloudTeamWorkspaceClient(server: string, fetcher: typeof fetch = fetch) {
  createEmptyTeamWorkspace(server);
  const url = `/api/v1/team-workspace/${encodeURIComponent(server)}`;
  const request = async (ownerId: string, init: RequestInit) => {
    const response = await fetcher(url, {
      ...init,
      credentials: "same-origin",
      cache: "no-store",
      headers: {
        accept: "application/json",
        "x-haneoka-expected-user": ownerId,
        ...(init.body ? { "content-type": "application/json" } : {}),
      },
    });
    const body = (await response.json()) as CloudTeamWorkspace & { error?: { code?: string } };
    if (!response.ok && !(response.status === 409 && body.error?.code === "revision_conflict"))
      throw new CloudTeamWorkspaceRequestError(response.status, body.error?.code ?? `team-workspace-http-${response.status}`);
    if (
      body.ownerId !== ownerId ||
      body.server !== server ||
      !validRevision(body.revision) ||
      !(body.workspace === null || (body.workspace && typeof body.workspace === "object"))
    )
      throw new TypeError("team-workspace-response-identity");
    const value: CloudTeamWorkspace = {
      ownerId,
      server,
      revision: body.revision,
      workspace: body.workspace === null ? null : checkTeamWorkspace(body.workspace, server),
    };
    return { conflict: response.status === 409, value };
  };
  return {
    read: (owner: string, signal?: AbortSignal) => request(owner, { signal }),
    save: (owner: string, workspace: TeamWorkspaceV1, expectedRevision: number, signal?: AbortSignal) => {
      if (!validRevision(expectedRevision)) throw new TypeError("team-workspace-invalid-revision");
      const body = JSON.stringify({ expectedRevision, workspace: checkTeamWorkspace(workspace, server) });
      if (new TextEncoder().encode(body).byteLength > MAX_WORKSPACE_BYTES)
        throw new RangeError("team-workspace-byte-limit");
      return request(owner, { method: "PUT", body, signal });
    },
  };
}

/** Separate account/server document; this store never calls the real inventory endpoint. */
export class TeamWorkspaceStore {
  state: WorkspaceStoreState = { ownerId: null, workspace: null, revision: 0, dirty: false, phase: "auth-loading" };
  private generation = 0;
  private edits = 0;
  private controller?: AbortController;
  private timer?: ReturnType<typeof setTimeout>;
  private pending?: Promise<void>;
  private versions = new Map<string, string | null>();
  private localConflictRaw?: { ownerId: string | null; raw: string | null };
  private localBackupVersion = -1;
  private authoritySuspended?: WorkspaceStoreState;
  private anonymous?: TeamWorkspaceV1;
  private client;
  constructor(
    readonly server: string,
    private options: {
      storage: StorageLike;
      fetcher?: typeof fetch;
      onChange?: (state: WorkspaceStoreState) => void;
      debounceMs?: number;
    },
  ) {
    createEmptyTeamWorkspace(server);
    this.client = createCloudTeamWorkspaceClient(server, options.fetcher);
  }
  private emit() {
    this.options.onChange?.(structuredClone(this.state));
  }
  private guard(owner: string | null) {
    const key = storageKey(this.server, owner);
    const observed = this.options.storage.getItem(key), expected = this.versions.get(key);
    if (this.versions.has(key) && observed !== expected && observed && expected) {
      try {
        if (new TextEncoder().encode(observed).byteLength <= MAX_WORKSPACE_BYTES && new TextEncoder().encode(expected).byteLength <= MAX_WORKSPACE_BYTES) {
          const old = JSON.parse(expected), current = JSON.parse(observed);
          const valid = (value: typeof old) => value && typeof value === "object" && !Array.isArray(value) &&
            Object.keys(value).length === 3 && validRevision(value.baseRevision) && typeof value.dirty === "boolean";
          if (valid(old) && valid(current) && equal(checkTeamWorkspace(old.workspace, this.server), checkTeamWorkspace(current.workspace, this.server)) &&
              (old.baseRevision === current.baseRevision || !current.dirty && current.baseRevision >= old.baseRevision)) {
            this.versions.set(key, observed);
            if (owner === this.state.ownerId && !current.dirty) this.state.revision = Math.max(this.state.revision, current.baseRevision);
            return;
          }
        }
      } catch { /* Changed documents stay in the review path. */ }
    }
    if (!this.versions.has(key) || observed !== expected) {
      this.captureLocalConflict(owner, observed);
      this.state.phase = "error"; this.state.error = "team-workspace-local-draft-changed"; this.emit();
      throw new Error("team-workspace-local-draft-changed");
    }
  }
  private captureLocalConflict(owner: string | null, raw: string | null) {
    const pending = owner !== this.state.ownerId ? this.anonymous ?? this.state.workspace : this.state.workspace;
    if (!pending) return;
    let workspace: TeamWorkspaceV1 | null = null, baseRevision: number | null = null;
    try {
      if (raw && new TextEncoder().encode(raw).byteLength <= MAX_WORKSPACE_BYTES) {
        const value = JSON.parse(raw); workspace = checkTeamWorkspace(value.workspace, this.server);
        if (validRevision(value.baseRevision)) baseRevision = value.baseRevision;
      }
    } catch { /* Keep foreign raw and the memory draft separate. */ }
    const conflict: NonNullable<WorkspaceStoreState["localConflict"]> = { ownerId: owner, workspace, baseRevision,
      pendingWorkspace: structuredClone(pending), ...(this.state.localConflict?.backupKey ? { backupKey: this.state.localConflict.backupKey } : {}) };
    if (this.localBackupVersion !== this.edits) {
      try {
        const backupKey = `haneoka:team-workspace:backup:${owner === null ? "anonymous" : `account:${encodeURIComponent(owner)}`}:${encodeURIComponent(this.server)}:${crypto.randomUUID()}`;
        this.options.storage.setItem(backupKey, JSON.stringify({ workspace: pending, baseRevision: this.state.revision, dirty: true }));
        conflict.backupKey = backupKey; this.localBackupVersion = this.edits;
      } catch { /* A quota failure never discards the memory draft. */ }
    }
    this.localConflictRaw = { ownerId: owner, raw }; this.state.localConflict = conflict;
  }
  private local(owner: string | null) {
    const key = storageKey(this.server, owner),
      raw = this.options.storage.getItem(key);
    this.versions.set(key, raw);
    if (!raw) return null;
    if (new TextEncoder().encode(raw).byteLength > MAX_WORKSPACE_BYTES)
      throw new RangeError("team-workspace-byte-limit");
    const value = JSON.parse(raw) as { workspace: unknown; baseRevision: unknown; dirty: unknown };
    if (!validRevision(value.baseRevision) || typeof value.dirty !== "boolean" || Object.keys(value).length !== 3)
      throw new TypeError("team-workspace-invalid-draft");
    return {
      workspace: checkTeamWorkspace(value.workspace, this.server),
      baseRevision: value.baseRevision,
      dirty: value.dirty,
    };
  }
  private persist() {
    if (!this.state.workspace) return;
    this.guard(this.state.ownerId);
    const key = storageKey(this.server, this.state.ownerId),
      raw = JSON.stringify({
        workspace: this.state.workspace,
        baseRevision: this.state.revision,
        dirty: this.state.dirty,
      });
    if (new TextEncoder().encode(raw).byteLength > MAX_WORKSPACE_BYTES)
      throw new RangeError("team-workspace-byte-limit");
    this.options.storage.setItem(key, raw);
    this.versions.set(key, raw);
  }
  async initialize(sessionReady: Promise<{ user?: { id?: string } } | null>) {
    const generation = this.generation;
    try {
      const session = await sessionReady;
      if (generation === this.generation) await this.setAccount(session?.user?.id ?? null);
    } catch (error) {
      if (generation === this.generation) {
        this.state.phase = "error";
        this.state.error = String(error);
        this.emit();
      }
    }
  }
  async setAccount(ownerId: string | null): Promise<void> {
    const retained = ownerId !== null && this.authoritySuspended?.ownerId === ownerId ? this.authoritySuspended : undefined;
    if (retained || (ownerId === this.state.ownerId && this.state.workspace && this.state.error === "team-workspace-local-draft-changed")) {
      this.controller?.abort(); clearTimeout(this.timer); this.pending = undefined;
      const generation = ++this.generation, controller = this.controller = new AbortController();
      try {
        if (ownerId !== null) {
          const { value } = await this.client.read(ownerId, controller.signal);
          if (generation !== this.generation) return;
          if (retained) { this.state = retained; this.authoritySuspended = undefined; }
          this.state.remote = value;
        }
        if (generation !== this.generation) return;
        const owner = this.localConflictRaw ? this.localConflictRaw.ownerId : ownerId;
        this.captureLocalConflict(owner, this.options.storage.getItem(storageKey(this.server, owner)));
      } catch (error) {
        if (generation !== this.generation || controller.signal.aborted) return;
        if (error instanceof CloudTeamWorkspaceRequestError &&
            ([401, 403].includes(error.status) || error.code === "account_changed")) {
          this.authoritySuspended ??= structuredClone(this.state);
          this.state = { phase: "error", workspace: null, ownerId: null, revision: 0, dirty: false,
            error: error.code, authorityError: { status: error.status, code: error.code } };
        }
      }
      if (generation === this.generation) this.emit();
      return;
    }
    this.controller?.abort();
    clearTimeout(this.timer);
    this.pending = undefined;
    this.authoritySuspended = undefined;
    this.anonymous = undefined;
    this.versions.clear();
    this.localConflictRaw = undefined; this.localBackupVersion = -1;
    const generation = ++this.generation;
    this.edits++;
    const controller = (this.controller = new AbortController());
    this.state = {
      ownerId,
      workspace: null,
      revision: 0,
      dirty: false,
      phase: ownerId === null ? "anonymous" : "loading",
    };
    this.emit();
    try {
      const local = this.local(ownerId),
        anonymous = ownerId === null ? null : this.local(null);
      this.state.workspace = local?.workspace ?? createEmptyTeamWorkspace(this.server);
      this.state.revision = local?.baseRevision ?? 0;
      this.state.dirty = local?.dirty ?? false;
      if (ownerId === null) {
        this.emit();
        return;
      }
      const { value } = await this.client.read(ownerId, controller.signal);
      if (generation !== this.generation) return;
      const remote = value.workspace ?? createEmptyTeamWorkspace(this.server);
      const changed =
        !!local && (local.dirty || local.baseRevision > value.revision) && !equal(local.workspace, remote);
      if (changed && local.baseRevision !== value.revision) {
        this.state.phase = "conflict";
        this.state.remote = value;
        this.state.dirty = true;
        this.emit();
        return;
      }
      this.state.workspace = changed ? local.workspace : remote;
      this.state.revision = value.revision;
      this.state.dirty = changed;
      this.persist();
      if (anonymous && (anonymous.workspace.profiles.length || anonymous.workspace.teams.length)) {
        this.anonymous = anonymous.workspace;
        this.state.phase = "merge-required";
      } else this.state.phase = changed ? "pending" : "saved";
      if (this.state.phase === "pending") this.schedule();
      this.emit();
    } catch (error) {
      if (generation !== this.generation || controller.signal.aborted) return;
      this.state.phase =
        error instanceof TypeError && !error.message.startsWith("team-workspace-") ? "offline" : "error";
      this.state.error = error instanceof Error ? error.message : String(error);
      this.emit();
    }
  }
  edit(workspace: TeamWorkspaceV1, force = false) {
    if (!this.state.workspace || ["auth-loading", "loading", "merge-required", "error"].includes(this.state.phase))
      throw new Error("team-workspace-not-ready");
    const next = checkTeamWorkspace(workspace, this.server);
    if (!force && equal(next, this.state.workspace)) return;
    this.state.workspace = next;
    this.state.dirty = true;
    this.edits++;
    try {
      this.persist();
    } catch (error) {
      this.state.phase = "error";
      this.state.error = error instanceof Error ? error.message : String(error);
      this.emit();
      throw error;
    }
    if (this.state.ownerId === null) this.state.phase = "anonymous";
    else if (this.state.phase !== "conflict") {
      this.state.phase = "pending";
      this.schedule();
    }
    this.emit();
  }
  private schedule() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.saveNow();
    }, this.options.debounceMs ?? 600);
  }
  saveNow(): Promise<void> {
    clearTimeout(this.timer);
    if (this.pending) return this.pending;
    if (
      this.state.ownerId === null ||
      !this.state.workspace ||
      !this.state.dirty ||
      ["loading", "auth-loading", "conflict", "merge-required", "error"].includes(this.state.phase)
    )
      return Promise.resolve();
    try {
      this.guard(this.state.ownerId);
    } catch (error) {
      this.state.phase = "error";
      this.state.error = error instanceof Error ? error.message : String(error);
      this.emit();
      return Promise.resolve();
    }
    const owner = this.state.ownerId,
      generation = this.generation,
      version = this.edits,
      workspace = structuredClone(this.state.workspace),
      revision = this.state.revision;
    this.state.phase = "saving";
    this.emit();
    this.pending = (async () => {
      try {
        const result = await this.client.save(owner, workspace, revision, this.controller!.signal);
        if (generation !== this.generation) return;
        const acknowledged = result.value.revision >= revision && result.value.workspace !== null && equal(result.value.workspace, workspace);
        if (result.conflict && !acknowledged) {
          this.state.remote = result.value;
          this.state.phase = "conflict";
          this.emit();
          return;
        }
        this.state.revision = result.value.revision;
        this.state.dirty = this.edits !== version && !equal(this.state.workspace, workspace);
        this.state.remote = result.value;
        this.persist();
        this.state.remote = undefined;
        this.state.phase = this.state.dirty ? "pending" : "saved";
        this.state.error = undefined;
        this.emit();
      } catch (error) {
        if (generation !== this.generation) return;
        this.state.phase =
          error instanceof TypeError && !error.message.startsWith("team-workspace-") ? "offline" : "error";
        this.state.error = error instanceof Error ? error.message : String(error);
        this.emit();
      } finally {
        if (generation === this.generation) {
          this.pending = undefined;
          if (this.state.phase === "pending") this.schedule();
        }
      }
    })();
    return this.pending;
  }
  resolveConflict(strategy: "remote" | "local" | "merge", priority?: "cloud" | "local") {
    if (this.state.phase !== "conflict" || !this.state.remote || !this.state.workspace)
      throw new Error("team-workspace-no-conflict");
    const remote = this.state.remote,
      cloud = remote.workspace ?? createEmptyTeamWorkspace(this.server);
    const next =
      strategy === "remote"
        ? cloud
        : strategy === "local"
          ? this.state.workspace
          : mergeTeamWorkspaces(cloud, this.state.workspace, priority);
    this.state.revision = remote.revision;
    this.state.remote = undefined;
    this.state.phase = "saved";
    if (strategy === "remote") {
      this.state.workspace = checkTeamWorkspace(next, this.server);
      this.state.dirty = false;
      try {
        this.persist();
      } catch (error) {
        this.state.phase = "error";
        this.state.error = error instanceof Error ? error.message : String(error);
        this.emit();
        throw error;
      }
      this.emit();
    } else this.edit(next, true);
  }
  resolveAnonymous(strategy: "cloud" | "local" | "merge", priority?: "cloud" | "local") {
    if (this.state.phase !== "merge-required" || !this.anonymous || !this.state.workspace)
      throw new Error("team-workspace-no-merge");
    this.guard(null);
    const next =
      strategy === "cloud"
        ? this.state.workspace
        : strategy === "local"
          ? this.anonymous
          : mergeTeamWorkspaces(this.state.workspace, this.anonymous, priority);
    this.state.phase = "saved";
    if (strategy !== "cloud") this.edit(next, true);
    this.options.storage.removeItem(storageKey(this.server, null));
    this.versions.set(storageKey(this.server, null), null);
    this.anonymous = undefined;
    if (strategy === "cloud") {
      this.state.phase = this.state.dirty ? "pending" : "saved";
      if (this.state.dirty) this.schedule();
      this.emit();
    }
  }
  dispose() {
    this.generation++;
    this.controller?.abort();
    clearTimeout(this.timer);
    this.pending = undefined;
    this.authoritySuspended = undefined;
    this.anonymous = undefined;
    this.versions.clear();
    this.localConflictRaw = undefined;
    this.state = { ownerId: null, workspace: null, revision: 0, dirty: false, phase: "auth-loading" };
  }
  resolveLocalConflict(workspace: TeamWorkspaceV1) {
    const conflict = this.localConflictRaw;
    if (!conflict || !this.state.localConflict ||
        (conflict.ownerId !== this.state.ownerId && !(conflict.ownerId === null && this.state.ownerId !== null && this.anonymous)) ||
        this.options.storage.getItem(storageKey(this.server, conflict.ownerId)) !== conflict.raw)
      throw new Error("team-workspace-local-draft-changed");
    const candidate = checkTeamWorkspace(workspace, this.server);
    if (conflict.raw !== null) {
      const backupKey = `haneoka:team-workspace:backup:${conflict.ownerId === null ? "anonymous" : `account:${encodeURIComponent(conflict.ownerId)}`}:${encodeURIComponent(this.server)}:${crypto.randomUUID()}`;
      this.options.storage.setItem(backupKey, conflict.raw);
    }
    this.versions.set(storageKey(this.server, conflict.ownerId), conflict.raw);
    this.state.localConflict = undefined; this.localConflictRaw = undefined; this.state.error = undefined;
    if (conflict.ownerId !== this.state.ownerId) {
      const raw = JSON.stringify({ workspace: candidate, baseRevision: 0, dirty: true });
      this.options.storage.setItem(storageKey(this.server, null), raw); this.versions.set(storageKey(this.server, null), raw);
      this.anonymous = candidate; this.state.phase = "merge-required"; this.emit(); return;
    }
    if (this.state.remote) this.state.revision = this.state.remote.revision;
    this.state.phase = "saved"; this.edit(candidate, true);
  }
}
