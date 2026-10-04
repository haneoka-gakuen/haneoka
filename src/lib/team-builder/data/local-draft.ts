import {
  upgradeInventory,
  previewInventoryUniqueness,
  InventoryUniquenessError,
  type InventoryV1,
  type InventoryV2,
} from "../inventory";
import type { TeamBuilderData } from "../data";
import type { StorageLike } from "../storage";
import type { SyncBase } from "./sync-merge";

const MAX_BYTES = 2 * 1024 * 1024 + 4096;
const MAX_KEYS = 512;
const MAX_RELEASES = 32;
const MAX_ID = 0x7fffffff;
const releaseIdValid = (value: unknown): value is string =>
  typeof value === "string" && /^r-[a-f0-9]{20}$/u.test(value);
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const exact = (value: Record<string, unknown>, fields: string[]) =>
  Object.keys(value).length === fields.length && fields.every((field) => Object.hasOwn(value, field));
const counter = (value: unknown, maximum: number, minimum = 0) =>
  value === null || (typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum);
const levelMap = (value: unknown, maximum: number) =>
  object(value) &&
  Object.keys(value).length <= 2048 &&
  Object.entries(value).every(
    ([id, level]) => /^[1-9]\d{0,9}$/u.test(id) && Number(id) <= MAX_ID && counter(level, maximum),
  );

/** Storage representation only; the new Master is checked in an explicit rebase preview. */
function storedShape(value: unknown): value is InventoryV1 {
  if (!object(value)) return false;
  const v2 = value.schema === "haneoka-team-inventory-v2";
  const fields = ["schema", "server", "releaseId", "members", "snapshots", "bandItems", "characterRanks", "bandRanks"];
  if (!v2 && value.schema !== "haneoka-team-inventory-v1") return false;
  if (
    !exact(value, v2 ? [...fields, "playerModifiers"] : fields) ||
    !releaseIdValid(value.releaseId) ||
    typeof value.server !== "string" ||
    !levelMap(value.bandItems, 1000000) ||
    !levelMap(value.characterRanks, 1000000) ||
    !levelMap(value.bandRanks, 1000000)
  )
    return false;
  const seen = new Set<string>();
  for (const kind of ["members", "snapshots"] as const) {
    const rows = value[kind];
    if (!Array.isArray(rows) || rows.length > 5000) return false;
    const practice =
      kind === "members"
        ? ["level", "training", "awakening", "liveSkillLevel", "gekisoSkillLevel"]
        : ["level", "awakening"];
    for (const row of rows) {
      if (
        !object(row) ||
        !exact(row, ["instanceId", "cardId", "locked", "excluded", ...practice]) ||
        typeof row.instanceId !== "string" ||
        !row.instanceId ||
        row.instanceId.length > 128 ||
        seen.has(row.instanceId) ||
        typeof row.cardId !== "number" ||
        !Number.isSafeInteger(row.cardId) ||
        row.cardId < 1 ||
        row.cardId > MAX_ID ||
        typeof row.locked !== "boolean" ||
        typeof row.excluded !== "boolean" ||
        (row.locked && row.excluded) ||
        !practice.every((field) => counter(row[field], 1000000))
      )
        return false;
      seen.add(row.instanceId);
    }
  }
  if (v2) {
    const modifiers = value.playerModifiers;
    if (
      !object(modifiers) ||
      !exact(modifiers, ["characterTotalRank", "vipRank", "musicMemoryPoints", "characterMemoryPoints"]) ||
      !counter(modifiers.characterTotalRank, MAX_ID) ||
      !counter(modifiers.vipRank, MAX_ID, 1) ||
      !levelMap(modifiers.musicMemoryPoints, MAX_ID) ||
      !levelMap(modifiers.characterMemoryPoints, MAX_ID)
    )
      return false;
  }
  return true;
}

export const localDraftPrefix = (data: TeamBuilderData, owner: string | null) =>
  `haneoka:team-inventory:v1:${owner === null ? "anonymous" : `account:${encodeURIComponent(owner)}`}:${encodeURIComponent(data.identity.server)}:`;
const locatorKey = (data: TeamBuilderData, owner: string | null) => `${localDraftPrefix(data, owner)}locator`;
export function setLocalDraftLocator(
  storage: StorageLike,
  data: TeamBuilderData,
  owner: string | null,
  releaseId: string | null,
) {
  if (releaseId !== null && !releaseIdValid(releaseId)) throw new Error("Invalid local draft release");
  // The inventory write is authoritative; an unavailable metadata slot must not erase it.
  try {
    storage.setItem(
      locatorKey(data, owner),
      JSON.stringify({ schema: "haneoka-local-draft-locator-v1", owner, server: data.identity.server, releaseId }),
    );
  } catch {
    /* Legacy bounded discovery remains available. */
  }
}
export interface LocatedLocalDraft {
  inventory: InventoryV2;
  baseRevision: number;
  storageKey: string;
  syncBase?: SyncBase<InventoryV2>;
  /** Absent on historical envelopes, whose differing content must be retained. */
  dirty?: boolean;
}
export class LocalDraftDiscoveryError extends Error {
  readonly code: "multiple-local-drafts" | "local-draft-search-limit";
  readonly releaseIds: string[];
  constructor(code: "multiple-local-drafts" | "local-draft-search-limit", releaseIds: string[] = []) {
    super(code);
    this.code = code;
    this.releaseIds = releaseIds;
  }
}
function readStored(
  storage: StorageLike,
  data: TeamBuilderData,
  owner: string | null,
  releaseId: string,
): LocatedLocalDraft | null {
  const storageKey = localDraftPrefix(data, owner) + encodeURIComponent(releaseId);
  const text = storage.getItem(storageKey);
  if (text === null) return null;
  if (new TextEncoder().encode(text).byteLength > MAX_BYTES) throw new Error("Local inventory JSON is too large");
  const envelope: unknown = JSON.parse(text);
  if (
    !object(envelope) ||
    !storedShape(envelope.inventory) ||
    envelope.inventory.server !== data.identity.server ||
    envelope.inventory.releaseId !== releaseId ||
    !Number.isSafeInteger(envelope.baseRevision) ||
    Number(envelope.baseRevision) < 0 ||
    (envelope.dirty !== undefined && typeof envelope.dirty !== "boolean")
  )
    throw new Error("Invalid stored inventory identity or document");
  const preview = previewInventoryUniqueness(envelope.inventory);
  if (preview.changed)
    throw new InventoryUniquenessError(preview, {
      storageKey,
      ownerId: owner,
      baseRevision: Number(envelope.baseRevision),
    });
  return {
    inventory: upgradeInventory(envelope.inventory), baseRevision: Number(envelope.baseRevision), storageKey,
    ...(object(envelope.syncBase) && envelope.syncBase.revision === envelope.baseRevision &&
      storedShape(envelope.syncBase.document) && envelope.syncBase.document.server === data.identity.server
      ? { syncBase: { revision: Number(envelope.syncBase.revision), document: upgradeInventory(envelope.syncBase.document) } } : {}),
    ...(typeof envelope.dirty === "boolean" ? { dirty: envelope.dirty } : {}),
  };
}

/** Exact current pin, then last saved pin, then one bounded legacy-key discovery. */
export function locateLocalDraft(
  storage: StorageLike,
  data: TeamBuilderData,
  owner: string | null,
): LocatedLocalDraft | null {
  const current = readStored(storage, data, owner, data.identity.releaseId);
  if (current) return current;
  const indexText = storage.getItem(locatorKey(data, owner));
  if (indexText && indexText.length <= 2048) {
    let index: unknown;
    try {
      index = JSON.parse(indexText);
    } catch {
      index = undefined;
    }
    if (
      object(index) &&
      exact(index, ["schema", "owner", "server", "releaseId"]) &&
      index.schema === "haneoka-local-draft-locator-v1" &&
      index.owner === owner &&
      index.server === data.identity.server
    ) {
      // Explicit anonymous merge/discard leaves a marker, preserving old JSON without reimporting it.
      if (index.releaseId === null) return null;
      if (releaseIdValid(index.releaseId)) {
        const located = readStored(storage, data, owner, index.releaseId);
        if (located) return located;
      }
    }
  }
  if (!storage.key || typeof storage.length !== "number") return null;
  const prefix = localDraftPrefix(data, owner),
    releases: string[] = [];
  for (let i = 0; i < Math.min(storage.length, MAX_KEYS); i++) {
    const candidate = storage.key(i);
    if (!candidate?.startsWith(prefix)) continue;
    const suffix = candidate.slice(prefix.length);
    if (releaseIdValid(suffix)) releases.push(suffix);
    if (releases.length > MAX_RELEASES)
      throw new LocalDraftDiscoveryError("local-draft-search-limit", releases.slice(0, MAX_RELEASES));
  }
  if (storage.length > MAX_KEYS) throw new LocalDraftDiscoveryError("local-draft-search-limit", releases);
  if (releases.length > 1) throw new LocalDraftDiscoveryError("multiple-local-drafts", releases);
  const releaseId = releases[0];
  if (!releaseId) return null;
  const located = readStored(storage, data, owner, releaseId);
  if (located) setLocalDraftLocator(storage, data, owner, releaseId);
  return located;
}

/** UI selection is scoped to this account/server and never changes the original draft. */
export function chooseLocalDraft(storage: StorageLike, data: TeamBuilderData, owner: string | null, releaseId: string) {
  if (!releaseIdValid(releaseId) || !readStored(storage, data, owner, releaseId))
    throw new Error("Local draft not found");
  setLocalDraftLocator(storage, data, owner, releaseId);
}
