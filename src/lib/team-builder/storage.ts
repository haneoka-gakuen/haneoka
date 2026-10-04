import type { TeamBuilderData } from "./data";
import {
  createEmptyInventory,
  rebaseInventory,
  previewInventoryUniqueness,
  applyInventoryUniqueness,
  InventoryUniquenessError,
  upgradeInventory,
  validateInventory,
  type InventoryIssue,
  type InventoryV1,
  type InventoryV2,
  type InventoryUniquenessPreview,
} from "./inventory";
import { InventoryCardMergeConflictError, sameOwnedCardState } from "./data/inventory-unique";
export { InventoryUniquenessError, InventoryCardMergeConflictError };
import {
  chooseLocalDraft as chooseStoredLocalDraft,
  LocalDraftDiscoveryError,
  locateLocalDraft,
  setLocalDraftLocator,
  type LocatedLocalDraft,
} from "./data/local-draft";

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  readonly length?: number;
  key?(index: number): string | null;
}
export class InventoryValidationError extends Error {
  constructor(readonly issues: InventoryIssue[]) {
    super("Invalid team inventory");
  }
}
export class CloudInventoryRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`Inventory request failed: ${code}`);
  }
}
export class LocalInventoryChangedError extends Error {
  constructor() {
    super("inventory-local-draft-changed");
  }
}
export interface CloudInventory {
  ownerId: string;
  server: string;
  revision: number;
  inventory: InventoryV1 | null;
}
export interface InventoryStoreState {
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
    | "release-mismatch"
    | "error"
    | "normalization-required";
  normalization?: InventoryUniquenessPreview;
  inventory: InventoryV1 | null;
  revision: number;
  ownerId: string | null;
  dirty: boolean;
  remote?: CloudInventory;
  error?: string;
  authorityError?: { status: number; code: string };
  localDraftChoices?: string[];
  localDraftSource?: "anonymous" | "account";
  localConflict?: { ownerId: string | null; inventory: InventoryV1 | null; pendingInventory: InventoryV1; baseRevision: number | null; backupKey?: string };
}
const MAX_JSON_BYTES = 1024 * 1024;
const key = (data: TeamBuilderData, owner: string | null) =>
  `haneoka:team-inventory:v1:${owner === null ? "anonymous" : `account:${encodeURIComponent(owner)}`}:${encodeURIComponent(data.identity.server)}:${encodeURIComponent(data.identity.releaseId)}`;
function checked(value: unknown, data: TeamBuilderData, allowDifferentRelease = false): InventoryV2 {
  const result = validateInventory(value, data, { allowDifferentRelease, allowDuplicateCards: true });
  if (!result.valid) throw new InventoryValidationError(result.issues);
  const preview = previewInventoryUniqueness(value as InventoryV1);
  if (preview.changed) throw new InventoryUniquenessError(preview);
  return upgradeInventory(value as InventoryV1);
}
export function importInventory(text: string, data: TeamBuilderData): InventoryV1 {
  if (new TextEncoder().encode(text).byteLength > MAX_JSON_BYTES) throw new Error("Inventory JSON is too large");
  return checked(JSON.parse(text), data);
}
export function exportInventory(inventory: InventoryV1): string {
  return JSON.stringify(upgradeInventory(inventory), null, 2);
}
export function readLocalInventory(
  storage: StorageLike,
  data: TeamBuilderData,
  owner: string | null = null,
): InventoryV1 | null {
  const text = storage.getItem(key(data, owner));
  if (!text) return null;
  return checked(JSON.parse(text).inventory, data);
}
export function writeLocalInventory(
  storage: StorageLike,
  data: TeamBuilderData,
  inventory: InventoryV1,
  owner: string | null = null,
  baseRevision = 0,
  dirty = true,
): string {
  const serialized = JSON.stringify({ inventory: checked(inventory, data), baseRevision, dirty });
  storage.setItem(key(data, owner), serialized);
  setLocalDraftLocator(storage, data, owner, data.identity.releaseId);
  return serialized;
}

/** JSON object ordering is transport detail; array ordering and every value remain meaningful. */
function sameInventoryContent(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b))
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length &&
      a.every((value, index) => sameInventoryContent(value, b[index]));
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  return Object.keys(a).length === Object.keys(b).length &&
    Object.entries(a).every(([key, value]) => Object.hasOwn(b, key) &&
      sameInventoryContent(value, (b as Record<string, unknown>)[key]));
}
export function mergeInventories(cloud: InventoryV1, draft: InventoryV1, mapPriority?: "cloud" | "draft"): InventoryV1 {
  if (cloud.server !== draft.server || cloud.releaseId !== draft.releaseId)
    throw new Error("Cannot merge different inventory identities");
  cloud = upgradeInventory(cloud);
  draft = upgradeInventory(draft);
  for (const inventory of [cloud, draft]) {
    const preview = previewInventoryUniqueness(inventory);
    if (preview.changed) throw new InventoryUniquenessError(preview);
  }
  const merged = structuredClone(cloud);
  const entries = new Map<
    string,
    { kind: "members" | "snapshots"; entry: InventoryV1["members"][number] | InventoryV1["snapshots"][number] }
  >(
    [
      ...cloud.members.map((entry) => ({ kind: "members" as const, entry })),
      ...cloud.snapshots.map((entry) => ({ kind: "snapshots" as const, entry })),
    ].map((value) => [`${value.kind}:${value.entry.cardId}`, value]),
  );
  const conflicts: ConstructorParameters<typeof InventoryCardMergeConflictError>[0] = [];
  for (const kind of ["members", "snapshots"] as const)
    for (const row of draft[kind]) {
      const cardKey = `${kind}:${row.cardId}`,
        previous = entries.get(cardKey)?.entry;
      if (previous) {
        if (sameOwnedCardState(previous, row)) continue;
        if (!mapPriority) {
          conflicts.push({ key: cardKey, kind, cardId: row.cardId, cloud: previous, draft: row });
          continue;
        }
        if (mapPriority === "cloud") continue;
      }
      entries.set(cardKey, { kind, entry: { ...row, instanceId: previous?.instanceId ?? row.instanceId } });
    }
  if (conflicts.length) throw new InventoryCardMergeConflictError(conflicts);
  const usedIds = new Set<string>();
  for (const value of entries.values()) {
    if (usedIds.has(value.entry.instanceId)) {
      let id = "";
      for (let attempt = 0; attempt < 16; attempt++) {
        const next = crypto.randomUUID();
        if (!usedIds.has(next)) {
          id = next;
          break;
        }
      }
      if (!id) throw new Error("inventory-instance-allocation-failed");
      value.entry.instanceId = id;
    }
    usedIds.add(value.entry.instanceId);
  }
  merged.members = [...entries.values()]
    .filter((value) => value.kind === "members")
    .map((value) => value.entry as InventoryV1["members"][number]);
  merged.snapshots = [...entries.values()]
    .filter((value) => value.kind === "snapshots")
    .map((value) => value.entry as InventoryV1["snapshots"][number]);
  for (const field of ["bandItems", "bandRanks", "characterRanks"] as const)
    for (const [id, level] of Object.entries(draft[field])) {
      if (id in merged[field] && merged[field][id] !== level && !mapPriority)
        throw new Error(`Inventory merge needs a choice: ${field}.${id}`);
      if (!(id in merged[field]) || mapPriority === "draft") merged[field][id] = level;
    }
  for (const field of ["characterTotalRank", "vipRank"] as const) {
    const remote = cloud.playerModifiers[field],
      local = draft.playerModifiers[field];
    if (remote !== null && local !== null && remote !== local && !mapPriority)
      throw new Error(`Inventory merge needs a choice: playerModifiers.${field}`);
    if (local !== null && (remote === null || mapPriority === "draft")) merged.playerModifiers[field] = local;
  }
  for (const field of ["musicMemoryPoints", "characterMemoryPoints"] as const)
    for (const [id, points] of Object.entries(draft.playerModifiers[field])) {
      const remote = merged.playerModifiers[field];
      if (id in remote && remote[id] !== points && !mapPriority)
        throw new Error(`Inventory merge needs a choice: playerModifiers.${field}.${id}`);
      if (!(id in remote) || mapPriority === "draft") remote[id] = points;
    }
  return merged;
}

/** Same-origin cookie session, JSON mutation and no-store follow the existing account client. */
export function createCloudInventoryClient(server: string, fetcher: typeof fetch = fetch) {
  const url = `/api/v1/team-inventory/${encodeURIComponent(server)}`;
  async function request(
    init: RequestInit,
    ownerId: string,
  ): Promise<{ conflict: boolean; conflictCode?: string; value: CloudInventory; inventorySchema: InventoryV1["schema"] | null }> {
    const response = await fetcher(url, {
      credentials: "same-origin",
      cache: "no-store",
      ...init,
      headers: {
        accept: "application/json",
        "x-haneoka-expected-user": ownerId,
        ...(init.body ? { "content-type": "application/json" } : {}),
      },
    });
    const payload = (await response.json()) as CloudInventory & { error?: { code?: string } };
    if (
      (!response.ok && response.status !== 409) ||
      (response.status === 409 &&
        !["revision_conflict", "inventory_schema_conflict"].includes(payload.error?.code ?? ""))
    )
      throw new CloudInventoryRequestError(response.status, payload.error?.code || String(response.status));
    const value = payload;
    if (
      value.ownerId !== ownerId ||
      value.server !== server ||
      !Number.isSafeInteger(value.revision) ||
      value.revision < 0
    )
      throw new Error("Inventory response identity mismatch");
    if (
      value.inventory &&
      (value.inventory.server !== server ||
        !["haneoka-team-inventory-v1", "haneoka-team-inventory-v2"].includes(value.inventory.schema))
    )
      throw new Error("Inventory document identity mismatch");
    const inventorySchema = value.inventory?.schema ?? null;
    if (value.inventory) value.inventory = upgradeInventory(value.inventory);
    return {
      conflict: response.status === 409,
      ...(response.status === 409 ? { conflictCode: payload.error?.code } : {}),
      value,
      inventorySchema,
    };
  }
  return {
    read: (owner: string, signal?: AbortSignal) => request({ signal }, owner),
    save: (owner: string, inventory: InventoryV1, expectedRevision: number, signal?: AbortSignal) => {
      const preview = previewInventoryUniqueness(inventory);
      if (preview.changed) return Promise.reject(new InventoryUniquenessError(preview));
      const body = JSON.stringify({ expectedRevision, inventory: upgradeInventory(inventory) });
      if (new TextEncoder().encode(body).byteLength > MAX_JSON_BYTES)
        return Promise.reject(new Error("Inventory request exceeds 1 MiB"));
      return request({ method: "PUT", body, signal }, owner);
    },
  };
}

export class InventoryStore {
  state: InventoryStoreState = { phase: "auth-loading", inventory: null, revision: 0, ownerId: null, dirty: false };
  private generation = 0;
  private edits = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private controller?: AbortController;
  private pending?: Promise<void>;
  private anonymousDraft?: InventoryV1;
  private restoredDraft?: { kind: "anonymous" | "account"; location: LocatedLocalDraft };
  private normalizationSource?: InventoryUniquenessError;
  private pendingCloudRebase = false;
  private localVersions = new Map<string, string | null>();
  private localConflictRaw?: { ownerId: string | null; raw: string | null };
  private localBackupVersion = -1;
  private authoritySuspended?: InventoryStoreState;
  private readonly client;
  constructor(
    readonly data: TeamBuilderData,
    private readonly options: {
      storage: StorageLike;
      fetcher?: typeof fetch;
      onChange?: (state: InventoryStoreState) => void;
      debounceMs?: number;
    },
  ) {
    this.client = createCloudInventoryClient(data.identity.server, options.fetcher);
  }
  private emit(): void {
    this.options.onChange?.(structuredClone(this.state));
  }
  async initialize(sessionReady: Promise<{ user?: { id?: string } } | null>): Promise<void> {
    const generation = this.generation;
    let session: { user?: { id?: string } } | null;
    try {
      session = await sessionReady;
    } catch (error) {
      if (generation === this.generation) {
        this.state.phase = "error";
        this.state.error = String(error);
        this.emit();
      }
      return;
    }
    if (generation !== this.generation) return;
    await this.setAccount(session?.user?.id || null);
  }
  async setAccount(ownerId: string | null): Promise<void> {
    const retained = ownerId !== null && this.authoritySuspended?.ownerId === ownerId ? this.authoritySuspended : undefined;
    if (retained || (ownerId === this.state.ownerId && this.state.inventory && this.state.error === "inventory-local-draft-changed")) {
      this.controller?.abort(); clearTimeout(this.timer); this.pending = undefined;
      const generation = ++this.generation;
      const controller = this.controller = new AbortController();
      try {
        if (ownerId) {
          const { value } = await this.client.read(ownerId, controller.signal);
          if (generation !== this.generation) return;
          if (retained) { this.state = retained; this.authoritySuspended = undefined; }
          this.state.remote = value;
        }
        if (generation !== this.generation) return;
        const owner = this.localConflictRaw ? this.localConflictRaw.ownerId : ownerId;
        this.captureLocalConflict(owner, this.options.storage.getItem(key(this.data, owner)));
      } catch (error) {
        if (generation !== this.generation || controller.signal.aborted) return;
        if (error instanceof CloudInventoryRequestError &&
            ([401, 403].includes(error.status) || error.code === "account_changed")) {
          this.authoritySuspended ??= structuredClone(this.state);
          this.state = { phase: "error", inventory: null, ownerId: null, revision: 0, dirty: false,
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
    this.anonymousDraft = undefined;
    this.restoredDraft = undefined;
    this.normalizationSource = undefined;
    this.pendingCloudRebase = false;
    this.localVersions.clear();
    this.localConflictRaw = undefined;
    this.localBackupVersion = -1;
    const generation = ++this.generation;
    this.edits++;
    this.controller = new AbortController();
    const signal = this.controller.signal;
    this.state = { phase: ownerId ? "loading" : "anonymous", inventory: null, ownerId, revision: 0, dirty: false };
    this.emit();
    let observedCloud: CloudInventory | undefined;
    try {
      for (const owner of new Set([ownerId, null])) {
        const storageKey = key(this.data, owner);
        this.localVersions.set(storageKey, this.options.storage.getItem(storageKey));
      }
      if (!ownerId) {
        const local = locateLocalDraft(this.options.storage, this.data, null);
        this.state.inventory = local
          ? local.inventory.releaseId === this.data.identity.releaseId
            ? checked(local.inventory, this.data)
            : local.inventory
          : createEmptyInventory(this.data.identity);
        if (local && local.inventory.releaseId !== this.data.identity.releaseId) {
          this.restoredDraft = { kind: "anonymous", location: local };
          this.state.phase = "release-mismatch";
          this.state.localDraftSource = "anonymous";
        }
        this.emit();
        return;
      }
      const { value } = await this.client.read(ownerId, signal);
      observedCloud = value;
      if (generation !== this.generation) return;
      this.state.revision = value.revision;
      if (value.inventory) {
        const preview = previewInventoryUniqueness(value.inventory);
        if (preview.changed) throw new InventoryUniquenessError(preview);
      }
      const local = locateLocalDraft(this.options.storage, this.data, ownerId);
      const localChanged = !!local && (local.dirty !== false || local.baseRevision > value.revision) &&
        !sameInventoryContent(local.inventory, value.inventory ?? createEmptyInventory(this.data.identity));
      if (local && localChanged && local.inventory.releaseId !== this.data.identity.releaseId) {
        this.restoredDraft = { kind: "account", location: local };
        this.state = {
          ...this.state,
          phase: "release-mismatch",
          inventory: local.inventory,
          remote: value,
          dirty: true,
          localDraftSource: "account",
        };
        this.emit();
        return;
      }
      // A local edit against the still-current revision resumes with the same CAS base.
      // Only a differing draft and a changed remote revision need a merge decision.
      if (local && localChanged && local.baseRevision !== value.revision) {
        this.state = {
          ...this.state, phase: "conflict", inventory: checked(local.inventory, this.data), remote: value, dirty: true,
          revision: local.baseRevision,
          ...(local.baseRevision > value.revision ? { error: "inventory-revision-regressed" } : {}),
        };
        this.emit();
        return;
      }
      if (!localChanged && value.inventory && value.inventory.releaseId !== this.data.identity.releaseId) {
        this.state = { ...this.state, phase: "release-mismatch", inventory: value.inventory, remote: value };
        this.emit();
        return;
      }
      this.state.inventory = local && localChanged
        ? checked(local.inventory, this.data)
        : value.inventory ? checked(value.inventory, this.data) : createEmptyInventory(this.data.identity);
      this.state.dirty = localChanged;
      // Cache the observed cloud revision even when the user makes no edits.
      this.persist();
      const anonymous = locateLocalDraft(this.options.storage, this.data, null);
      if (anonymous && anonymous.inventory.releaseId !== this.data.identity.releaseId) {
        this.restoredDraft = { kind: "anonymous", location: anonymous };
        this.state = {
          ...this.state,
          phase: "release-mismatch",
          inventory: anonymous.inventory,
          remote: value,
          localDraftSource: "anonymous",
        };
        this.emit();
        return;
      }
      this.anonymousDraft = anonymous ? checked(anonymous.inventory, this.data) : undefined;
      const draft = this.anonymousDraft;
      const hasDraft =
        draft &&
        (draft.members.length ||
          draft.snapshots.length ||
          Object.keys(draft.bandItems).length ||
          Object.keys(draft.characterRanks).length ||
          Object.keys(draft.bandRanks).length ||
          (draft.schema === "haneoka-team-inventory-v2" &&
            (draft.playerModifiers.characterTotalRank !== null ||
              draft.playerModifiers.vipRank !== null ||
              Object.keys(draft.playerModifiers.musicMemoryPoints).length ||
              Object.keys(draft.playerModifiers.characterMemoryPoints).length)));
      this.state.phase = hasDraft ? "merge-required" : this.state.dirty ? "pending" : "saved";
      if (this.state.phase === "pending") this.schedule();
      this.emit();
    } catch (error) {
      if (generation !== this.generation || signal.aborted) return;
      if (error instanceof InventoryUniquenessError) {
        this.normalizationSource = error;
        this.state = {
          ...this.state,
          phase: "normalization-required",
          normalization: error.preview,
          inventory: error.preview.candidate,
          remote: observedCloud,
          dirty: false,
        };
        this.emit();
        return;
      }
      if (ownerId && error instanceof TypeError) {
        try {
          const local = locateLocalDraft(this.options.storage, this.data, ownerId);
          if (local) {
            this.state.inventory =
              local.inventory.releaseId === this.data.identity.releaseId
                ? checked(local.inventory, this.data)
                : local.inventory;
            this.state.revision = local.baseRevision;
            this.state.dirty = local.dirty ?? true;
            if (local.inventory.releaseId !== this.data.identity.releaseId) {
              this.restoredDraft = { kind: "account", location: local };
              this.state.phase = "release-mismatch";
              this.state.localDraftSource = "account";
            }
          }
          if (this.state.phase !== "release-mismatch") this.state.phase = "offline";
        } catch (localError) {
          if (localError instanceof InventoryUniquenessError) {
            this.normalizationSource = localError;
            this.state.phase = "normalization-required";
            this.state.normalization = localError.preview;
            this.state.inventory = localError.preview.candidate;
            this.state.revision = localError.local?.baseRevision ?? this.state.revision;
          } else this.state.phase = "error";
          this.state.error = String(localError);
          if (localError instanceof LocalDraftDiscoveryError) this.state.localDraftChoices = localError.releaseIds;
        }
      } else this.state.phase = "error";
      if (error instanceof LocalDraftDiscoveryError) this.state.localDraftChoices = error.releaseIds;
      this.state.error ??= String(error);
      this.emit();
    }
  }
  edit(inventory: InventoryV1, force = false): void {
    if (
      !this.state.inventory ||
      ["loading", "auth-loading", "release-mismatch", "merge-required", "normalization-required"].includes(
        this.state.phase,
      )
    )
      throw new Error("Inventory is not ready for editing");
    const next = checked(inventory, this.data);
    if (!force && sameInventoryContent(next, this.state.inventory)) return;
    this.state.inventory = next;
    this.edits++;
    this.state.dirty = true;
    this.persist();
    if (!this.state.ownerId) {
      this.state.phase = "anonymous";
      this.emit();
      return;
    }
    if (this.state.phase !== "conflict") {
      this.state.phase = "pending";
      this.schedule();
    }
    this.emit();
  }
  private persist(): void {
    if (this.state.inventory)
      this.writeDraft(this.state.inventory, this.state.ownerId, this.state.revision, this.state.dirty);
  }
  private assertLocalDraftUnchanged(owner: string | null): void {
    const storageKey = key(this.data, owner);
    const observed = this.options.storage.getItem(storageKey), expected = this.localVersions.get(storageKey);
    if (this.localVersions.has(storageKey) && observed !== expected && expected && observed) {
      try {
        if (new TextEncoder().encode(observed).byteLength <= MAX_JSON_BYTES && new TextEncoder().encode(expected).byteLength <= MAX_JSON_BYTES) {
          const old = JSON.parse(expected), current = JSON.parse(observed);
          const envelope = (value: typeof old) => value && typeof value === "object" && !Array.isArray(value) &&
            Object.keys(value).every(field => ["inventory", "baseRevision", "dirty"].includes(field)) &&
            Number.isSafeInteger(value.baseRevision) && value.baseRevision >= 0 && value.baseRevision < Number.MAX_SAFE_INTEGER &&
            (value.dirty === undefined || typeof value.dirty === "boolean");
          if (envelope(old) && envelope(current) && sameInventoryContent(checked(old.inventory, this.data), checked(current.inventory, this.data)) &&
              (current.baseRevision === old.baseRevision || current.dirty === false && current.baseRevision >= old.baseRevision)) {
            this.localVersions.set(storageKey, observed);
            if (owner === this.state.ownerId && current.dirty === false) this.state.revision = Math.max(this.state.revision, current.baseRevision);
            return;
          }
        }
      } catch { /* A differing or unreadable draft requires explicit review. */ }
    }
    if (!this.localVersions.has(storageKey) || observed !== expected) {
      clearTimeout(this.timer);
      this.captureLocalConflict(owner, observed);
      this.state.phase = "error";
      this.state.error = "inventory-local-draft-changed";
      this.emit();
      throw new LocalInventoryChangedError();
    }
  }
  private captureLocalConflict(owner: string | null, raw: string | null): void {
    const pending = owner !== this.state.ownerId ? this.anonymousDraft ?? this.state.inventory : this.state.inventory;
    if (!pending) return;
    let inventory: InventoryV1 | null = null, baseRevision: number | null = null;
    try {
      if (raw && new TextEncoder().encode(raw).byteLength <= MAX_JSON_BYTES) {
        const stored = JSON.parse(raw);
        inventory = checked(stored.inventory, this.data);
        if (Number.isSafeInteger(stored.baseRevision) && stored.baseRevision >= 0) baseRevision = stored.baseRevision;
      }
    } catch { /* Preserve an unreadable foreign raw without adopting it. */ }
    const conflict: NonNullable<InventoryStoreState["localConflict"]> = { ownerId: owner, inventory, baseRevision, pendingInventory: structuredClone(pending),
      ...(this.state.localConflict?.backupKey ? { backupKey: this.state.localConflict.backupKey } : {}) };
    if (this.localBackupVersion !== this.edits) {
      try {
        const backupKey = `haneoka:team-inventory:backup:${owner === null ? "anonymous" : `account:${encodeURIComponent(owner)}`}:${encodeURIComponent(this.data.identity.server)}:${encodeURIComponent(pending.releaseId)}:${crypto.randomUUID()}`;
        this.options.storage.setItem(backupKey, JSON.stringify({ inventory: pending, baseRevision: this.state.revision, dirty: true }));
        conflict.backupKey = backupKey; this.localBackupVersion = this.edits;
      } catch { /* The in-memory draft remains exportable if backup storage is unavailable. */ }
    }
    this.localConflictRaw = { ownerId: owner, raw };
    this.state.localConflict = conflict;
  }
  /** A UI-reviewed complete candidate, never an automatic choice of disk/cloud. */
  resolveLocalConflict(inventory: InventoryV1): void {
    const conflict = this.localConflictRaw;
    if (!conflict || !this.state.localConflict ||
        (conflict.ownerId !== this.state.ownerId && !(conflict.ownerId === null && this.state.ownerId && this.anonymousDraft)) ||
        this.options.storage.getItem(key(this.data, conflict.ownerId)) !== conflict.raw)
      throw new LocalInventoryChangedError();
    const candidate = checked(inventory, this.data);
    if (conflict.raw !== null) {
      const backupKey = `haneoka:team-inventory:backup:${conflict.ownerId === null ? "anonymous" : `account:${encodeURIComponent(conflict.ownerId)}`}:${encodeURIComponent(this.data.identity.server)}:${encodeURIComponent(this.data.identity.releaseId)}:${crypto.randomUUID()}`;
      this.options.storage.setItem(backupKey, conflict.raw);
    }
    this.localVersions.set(key(this.data, conflict.ownerId), conflict.raw);
    if (conflict.ownerId !== this.state.ownerId) {
      this.writeDraft(candidate, null);
      this.anonymousDraft = candidate;
      this.state.localConflict = undefined; this.localConflictRaw = undefined;
      this.state.error = undefined; this.state.phase = "merge-required"; this.emit();
      return;
    }
    if (this.state.remote) this.state.revision = this.state.remote.revision;
    this.state.localConflict = undefined; this.localConflictRaw = undefined;
    this.state.phase = "saved"; this.state.error = undefined;
    this.edit(candidate, true);
  }
  private writeDraft(inventory: InventoryV1, owner: string | null, revision = 0, dirty = true): void {
    this.assertLocalDraftUnchanged(owner);
    const serialized = writeLocalInventory(this.options.storage, this.data, inventory, owner, revision, dirty);
    this.localVersions.set(key(this.data, owner), serialized);
  }
  private schedule(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.saveNow();
    }, this.options.debounceMs ?? 600);
  }
  saveNow(): Promise<void> {
    clearTimeout(this.timer);
    if (this.pending) return this.pending;
    if (
      !this.state.ownerId ||
      !this.state.inventory ||
      !this.state.dirty ||
      ["conflict", "release-mismatch", "merge-required", "loading", "auth-loading", "normalization-required"].includes(
        this.state.phase,
      )
    )
      return Promise.resolve();
    try {
      this.assertLocalDraftUnchanged(this.state.ownerId);
    } catch (error) {
      if (!(error instanceof LocalInventoryChangedError)) {
        this.state.phase = "error";
        this.state.error = String(error);
        this.emit();
      }
      return Promise.resolve();
    }
    const owner = this.state.ownerId,
      generation = this.generation,
      version = this.edits;
    const inventory = structuredClone(this.state.inventory),
      revision = this.state.revision;
    const signal = this.controller!.signal;
    this.state.phase = "saving";
    this.state.error = undefined;
    this.emit();
    const operation = (async () => {
      try {
        const result = await this.client.save(owner, inventory, revision, signal);
        if (generation !== this.generation) return;
        const acknowledged = result.conflictCode === "revision_conflict" && result.value.revision >= revision &&
          result.inventorySchema === inventory.schema && result.value.inventory?.releaseId === this.data.identity.releaseId &&
          sameInventoryContent(result.value.inventory, inventory);
        if (result.conflict && !acknowledged) {
          this.state.phase = "conflict";
          this.state.remote = result.value;
          this.state.error = result.value.inventory && result.inventorySchema !== inventory.schema
            ? "inventory_schema_conflict" : result.conflictCode;
          this.emit();
          return;
        }
        this.state.revision = result.value.revision;
        this.state.dirty = version !== this.edits && !sameInventoryContent(this.state.inventory, inventory);
        this.state.phase = this.state.dirty ? "pending" : "saved";
        this.state.remote = result.value;
        this.state.error = undefined;
        this.persist();
        this.state.remote = undefined;
        this.emit();
      } catch (error) {
        if (generation !== this.generation || signal.aborted) return;
        this.state.phase = error instanceof CloudInventoryRequestError || error instanceof LocalInventoryChangedError ? "error" : "offline";
        this.state.error = error instanceof LocalInventoryChangedError ? error.message : String(error);
        if (!(error instanceof LocalInventoryChangedError)) {
          try {
            this.persist();
          } catch (draftError) {
            this.state.phase = "error";
            this.state.error = draftError instanceof LocalInventoryChangedError ? draftError.message : String(draftError);
          }
        }
        this.emit();
      } finally {
        if (generation === this.generation) {
          this.pending = undefined;
          if (this.state.dirty && this.state.phase === "pending") this.schedule();
        }
      }
    })();
    this.pending = operation;
    return operation;
  }
  resolveAnonymous(strategy: "cloud" | "draft" | "merge", mapPriority?: "cloud" | "draft"): void {
    if (this.state.phase !== "merge-required" || !this.anonymousDraft || !this.state.inventory)
      throw new Error("No anonymous merge is pending");
    this.assertLocalDraftUnchanged(null);
    const cloud = this.state.inventory;
    const next =
      strategy === "cloud"
        ? cloud
        : strategy === "draft"
          ? this.anonymousDraft
          : mergeInventories(cloud, this.anonymousDraft, mapPriority);
    this.state.phase = "saved";
    this.anonymousDraft = undefined;
    if (strategy !== "cloud" || this.pendingCloudRebase || this.state.dirty) this.edit(next, true);
    this.pendingCloudRebase = false;
    this.options.storage.removeItem(key(this.data, null));
    this.localVersions.set(key(this.data, null), null);
    setLocalDraftLocator(this.options.storage, this.data, null, null);
    this.emit();
  }
  resolveConflict(strategy: "remote" | "local" | "merge", mapPriority?: "cloud" | "draft"): void {
    const remote = this.state.remote;
    if (this.state.phase !== "conflict" || !remote || !this.state.inventory)
      throw new Error("No cloud conflict is pending");
    const remoteForeign = !!remote.inventory && remote.inventory.releaseId !== this.data.identity.releaseId;
    let cloud: InventoryV1 = createEmptyInventory(this.data.identity);
    if (strategy !== "local" && remote.inventory) {
      const preview = remoteForeign ? rebaseInventory(remote.inventory, this.data) : null;
      if (preview && !preview.canApply) throw new InventoryValidationError(preview.issues);
      cloud = checked(preview ? preview.candidate : remote.inventory, this.data);
    }
    const next =
      strategy === "remote"
        ? cloud
        : strategy === "local"
          ? this.state.inventory
          : mergeInventories(cloud, this.state.inventory, mapPriority);
    const anonymousPending = !!this.anonymousDraft && this.state.localDraftSource === "anonymous";
    if (anonymousPending) this.assertLocalDraftUnchanged(null);
    this.state = {
      ...this.state,
      inventory: next,
      revision: remote.revision,
      phase: "saved",
      dirty: false,
      remote: undefined,
    };
    if (strategy !== "remote" || remoteForeign) this.edit(next, true);
    else this.persist();
    if (anonymousPending) {
      this.anonymousDraft = undefined;
      this.options.storage.removeItem(key(this.data, null));
      this.localVersions.set(key(this.data, null), null);
      setLocalDraftLocator(this.options.storage, this.data, null, null);
    }
    this.pendingCloudRebase = false;
    this.emit();
  }
  resolveRelease(inventory: InventoryV1): void {
    if (this.state.phase !== "release-mismatch") throw new Error("No release change is pending");
    const next = checked(inventory, this.data);
    const restored = this.restoredDraft;
    if (!restored && this.state.ownerId && this.state.remote?.inventory) {
      const anonymous = locateLocalDraft(this.options.storage, this.data, null);
      if (anonymous) {
        this.pendingCloudRebase = true;
        this.state.remote = { ...this.state.remote, inventory: next };
        if (anonymous.inventory.releaseId !== this.data.identity.releaseId) {
          this.restoredDraft = { kind: "anonymous", location: anonymous };
          this.state.inventory = anonymous.inventory;
          this.state.localDraftSource = "anonymous";
          this.emit();
          return;
        }
        this.anonymousDraft = checked(anonymous.inventory, this.data);
        this.state.inventory = next;
        this.state.phase = "merge-required";
        this.emit();
        return;
      }
    }
    this.restoredDraft = undefined;
    this.state.localDraftSource = undefined;
    if (restored?.kind === "anonymous" && this.state.ownerId) {
      this.anonymousDraft = next;
      this.writeDraft(next, null);
      const remote = this.state.remote;
      if (remote?.inventory && remote.inventory.releaseId !== this.data.identity.releaseId) {
        this.state.inventory = next;
        this.state.phase = "conflict";
        this.state.dirty = true;
        this.state.localDraftSource = "anonymous";
        this.emit();
        return;
      }
      this.state.inventory = remote?.inventory
        ? checked(remote.inventory, this.data)
        : createEmptyInventory(this.data.identity);
      this.state.phase = "merge-required";
      this.state.dirty = false;
      this.emit();
      return;
    }
    if (restored?.kind === "account" && this.state.ownerId && this.state.remote?.inventory &&
        restored.location.baseRevision !== this.state.remote.revision) {
      this.state.inventory = next;
      this.state.phase = "conflict";
      this.state.dirty = true;
      this.state.revision = restored.location.baseRevision;
      this.persist();
      this.emit();
      return;
    }
    this.state.phase = "saved";
    this.state.inventory = next;
    this.edit(next, true);
  }
  dispose(): void {
    this.generation++;
    this.controller?.abort();
    clearTimeout(this.timer);
    this.pending = undefined;
    this.authoritySuspended = undefined;
    this.anonymousDraft = undefined;
    this.restoredDraft = undefined;
    this.normalizationSource = undefined;
    this.pendingCloudRebase = false;
    this.localVersions.clear();
    this.localConflictRaw = undefined;
    this.state = { phase: "auth-loading", inventory: null, ownerId: null, revision: 0, dirty: false };
  }
  async chooseLocalDraft(releaseId: string): Promise<void> {
    if (!this.state.localDraftChoices?.includes(releaseId)) throw new Error("No local draft choice is pending");
    const owner = this.state.ownerId;
    chooseStoredLocalDraft(this.options.storage, this.data, owner, releaseId);
    await this.setAccount(owner);
  }
  resolveUniqueness(choices: Record<string, string> = {}): void {
    const source = this.normalizationSource,
      preview = this.state.normalization;
    if (this.state.phase !== "normalization-required" || !source || !preview)
      throw new Error("No inventory normalization is pending");
    const next = upgradeInventory(applyInventoryUniqueness(preview, choices));
    if (next.releaseId === this.data.identity.releaseId) checked(next, this.data);
    const owner = source.local ? source.local.ownerId : this.state.ownerId;
    const backupKey = `haneoka:team-inventory:backup:${owner === null ? "anonymous" : `account:${encodeURIComponent(owner)}`}:${encodeURIComponent(this.data.identity.server)}:${encodeURIComponent(preview.original.releaseId)}:${crypto.randomUUID()}`;
    const raw = source.local ? this.options.storage.getItem(source.local.storageKey) : null;
    this.options.storage.setItem(
      backupKey,
      raw ?? JSON.stringify({ inventory: preview.original, baseRevision: this.state.revision }),
    );
    this.state.normalization = undefined;
    this.normalizationSource = undefined;
    this.state.inventory = next;
    if (source.local)
      this.restoredDraft = {
        kind: owner === null ? "anonymous" : "account",
        location: {
          inventory: next,
          baseRevision: source.local.baseRevision,
          storageKey: source.local.storageKey,
        },
      };
    else if (this.state.remote) this.state.remote = { ...this.state.remote, inventory: next };
    if (next.releaseId !== this.data.identity.releaseId) {
      this.state.phase = "release-mismatch";
      this.state.localDraftSource = owner === null ? "anonymous" : "account";
      this.emit();
      return;
    }
    if (source.local && owner === null && this.state.ownerId) {
      this.anonymousDraft = checked(next, this.data);
      if (this.state.remote?.inventory && this.state.remote.inventory.releaseId !== this.data.identity.releaseId) {
        this.state.phase = "conflict";
        this.state.localDraftSource = "anonymous";
        this.state.dirty = true;
        this.emit();
        return;
      }
      this.state.inventory = this.state.remote?.inventory
        ? checked(this.state.remote.inventory, this.data)
        : createEmptyInventory(this.data.identity);
      this.state.phase = "merge-required";
      this.emit();
      return;
    }
    if (source.local && this.state.ownerId && this.state.remote?.inventory &&
        source.local.baseRevision !== this.state.remote.revision) {
      this.state.phase = "conflict";
      this.state.dirty = true;
      this.state.revision = source.local.baseRevision;
      this.emit();
      return;
    }
    this.state.phase = "saved";
    this.edit(checked(next, this.data), true);
  }
}
