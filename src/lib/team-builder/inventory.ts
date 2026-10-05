import type { ReleaseIdentity, TeamAssignment } from "./contracts";
import { dataRows, nativeRow, type TeamBuilderData } from "./data";
import { createUnknownPlayerModifiers, validatePlayerModifiers, type PlayerModifiers } from "./data/player-modifiers";
import { InventoryUniquenessError, previewInventoryUniqueness } from "./data/inventory-unique";
export { createUnknownPlayerModifiers, playerModifierRanges, type PlayerModifiers } from "./data/player-modifiers";
export {
  InventoryUniquenessError,
  previewInventoryUniqueness,
  applyInventoryUniqueness,
  type InventoryUniquenessPreview,
} from "./data/inventory-unique";

export interface MemberEntry {
  instanceId: string;
  cardId: number;
  level: number | null;
  training: number | null;
  awakening: number | null;
  liveSkillLevel: number | null;
  gekisoSkillLevel: number | null;
  locked: boolean;
  excluded: boolean;
}
export interface SnapshotEntry {
  instanceId: string;
  cardId: number;
  level: number | null;
  awakening: number | null;
  locked: boolean;
  excluded: boolean;
}
export interface LegacyInventoryV1 extends ReleaseIdentity {
  schema: "haneoka-team-inventory-v1";
  members: MemberEntry[];
  snapshots: SnapshotEntry[];
  bandItems: Record<string, number | null>;
  characterRanks: Record<string, number | null>;
  bandRanks: Record<string, number | null>;
}
export interface InventoryV2 extends Omit<LegacyInventoryV1, "schema"> {
  schema: "haneoka-team-inventory-v2";
  playerModifiers: PlayerModifiers;
}
export type Inventory = LegacyInventoryV1 | InventoryV2;
/** Historical caller name; use Inventory or InventoryV2 for new integrations. */
export type InventoryV1 = Inventory;
/** Caller validates the document before upgrading. Identity and all values are retained. */
export function upgradeInventory(inventory: Inventory): InventoryV2 {
  const cloned = structuredClone(inventory);
  return cloned.schema === "haneoka-team-inventory-v2"
    ? cloned
    : { ...cloned, schema: "haneoka-team-inventory-v2", playerModifiers: createUnknownPlayerModifiers() };
}
export interface InventoryIssue {
  path: string;
  code: string;
  values?: number[];
}
export type InventoryKind = "members" | "snapshots";
export const MAX_INVENTORY_ENTRIES = 5000;
export const MAX_INVENTORY_BYTES = 1024 * 1024;
export interface InventoryAddition {
  cardId: number;
}
export interface InventoryRebasePreview {
  candidate: InventoryV1;
  changes: { path: string; from: unknown; to: unknown }[];
  unknownCards: { kind: InventoryKind; instanceId: string; cardId: number }[];
  issues: InventoryIssue[];
  canApply: boolean;
}
const MEMBER_FIELDS = ["level", "training", "awakening", "liveSkillLevel", "gekisoSkillLevel"] as const;
const SNAPSHOT_FIELDS = ["level", "awakening"] as const;
const rangeCache = new WeakMap<TeamBuilderData, Map<string, Record<string, number[]>>>();
const values = (rows: Record<string, unknown>[], key: string) =>
  [...new Set(rows.map((row) => Number(row[key])))].filter(Number.isFinite).sort((a, b) => a - b);
/** Zero explicitly means this known band item is not unlocked; null stays unknown. */
export function bandItemLevelValues(data: TeamBuilderData, itemId: string | number): number[] {
  const item = data.bandItems[String(itemId)];
  return item ? [...new Set([0, ...values(dataRows(item.levels).map(nativeRow), "level")])] : [];
}

export function createEmptyInventory(identity: ReleaseIdentity): InventoryV2 {
  return {
    schema: "haneoka-team-inventory-v2",
    server: identity.server,
    releaseId: identity.releaseId,
    members: [],
    snapshots: [],
    bandItems: {},
    characterRanks: {},
    bandRanks: {},
    playerModifiers: createUnknownPlayerModifiers(),
  };
}
export function addInventoryEntry(
  inventory: InventoryV1,
  kind: InventoryKind,
  cardId: number,
  instanceId?: string,
): InventoryV1 {
  const preview = previewInventoryUniqueness(inventory);
  if (preview.changed) throw new InventoryUniquenessError(preview);
  if (inventory[kind].some((entry) => entry.cardId === cardId)) return inventory;
  if (!Number.isSafeInteger(cardId) || cardId < 1 || cardId > 0x7fffffff) throw new RangeError("invalid-card-id");
  if (inventory[kind].length >= MAX_INVENTORY_ENTRIES) throw new RangeError("inventory-entry-limit");
  const id = instanceId ?? crypto.randomUUID();
  if ([...inventory.members, ...inventory.snapshots].some((entry) => entry.instanceId === id))
    throw new Error("duplicate-instance-id");
  const flags = { instanceId: id, cardId, locked: false, excluded: false };
  return kind === "members"
    ? {
        ...inventory,
        members: [
          ...inventory.members,
          { ...flags, level: null, training: null, awakening: null, liveSkillLevel: null, gekisoSkillLevel: null },
        ],
      }
    : { ...inventory, snapshots: [...inventory.snapshots, { ...flags, level: null, awakening: null }] };
}
/** One append allocation. Original entries remain unchanged and new practice stays unknown. */
export function addInventoryEntries(
  inventory: InventoryV1,
  kind: InventoryKind,
  requests: readonly InventoryAddition[],
  data?: TeamBuilderData,
): InventoryV1 {
  if (requests.length > MAX_INVENTORY_ENTRIES) throw new RangeError("inventory-entry-limit");
  const preview = previewInventoryUniqueness(inventory);
  if (preview.changed) throw new InventoryUniquenessError(preview);
  const owned = new Set(inventory[kind].map((entry) => entry.cardId));
  const additions: InventoryAddition[] = [];
  for (const request of requests) {
    if (
      !Number.isSafeInteger(request.cardId) ||
      request.cardId <= 0 ||
      request.cardId > 0x7fffffff ||
      Object.keys(request).some((key) => key !== "cardId")
    )
      throw new RangeError("invalid-inventory-addition");
    if (owned.has(request.cardId)) continue;
    owned.add(request.cardId);
    additions.push(request);
    if (additions.length + inventory[kind].length > MAX_INVENTORY_ENTRIES)
      throw new RangeError("inventory-entry-limit");
    if (data && !(kind === "members" ? data.members : data.snapshots)[String(request.cardId)])
      throw new RangeError("unknown-card");
  }
  if (!additions.length) return inventory;
  const used = new Set([...inventory.members, ...inventory.snapshots].map((entry) => entry.instanceId));
  const members: MemberEntry[] = [],
    snapshots: SnapshotEntry[] = [];
  for (const request of additions) {
    let instanceId = "";
    for (let attempt = 0; attempt < 16; attempt++) {
      const id = crypto.randomUUID();
      if (!used.has(id)) {
        instanceId = id;
        break;
      }
    }
    if (!instanceId) throw new Error("inventory-instance-allocation-failed");
    used.add(instanceId);
    const flags = { instanceId, cardId: request.cardId, locked: false, excluded: false };
    if (kind === "members")
      members.push({
        ...flags,
        level: null,
        training: null,
        awakening: null,
        liveSkillLevel: null,
        gekisoSkillLevel: null,
      });
    else snapshots.push({ ...flags, level: null, awakening: null });
  }
  const next =
    kind === "members"
      ? { ...inventory, members: [...inventory.members, ...members] }
      : { ...inventory, snapshots: [...inventory.snapshots, ...snapshots] };
  // Reserve the largest safe CAS revision envelope, not just the inventory document.
  if (
    new TextEncoder().encode(JSON.stringify({ expectedRevision: Number.MAX_SAFE_INTEGER, inventory: next }))
      .byteLength > MAX_INVENTORY_BYTES
  )
    throw new RangeError("inventory-byte-limit");
  if (data) {
    const result = validateInventory(next, data);
    if (!result.valid) throw new Error(`invalid-inventory:${result.issues[0]?.path}`);
  }
  return next;
}

/** Dry-run only. Out-of-range practice and missing cards are retained for an explicit choice. */
export function rebaseInventory(inventory: InventoryV1, nextData: TeamBuilderData): InventoryRebasePreview {
  const candidate = structuredClone(inventory);
  if (inventory.server !== nextData.identity.server)
    return {
      candidate,
      changes: [],
      unknownCards: [],
      issues: [{ path: "server", code: "different-server" }],
      canApply: false,
    };
  candidate.releaseId = nextData.identity.releaseId;
  const changes =
    inventory.releaseId === candidate.releaseId
      ? []
      : [{ path: "releaseId", from: inventory.releaseId, to: candidate.releaseId }];
  const unknownCards: InventoryRebasePreview["unknownCards"] = [];
  for (const kind of ["members", "snapshots"] as const)
    for (const entry of candidate[kind])
      if (!(kind === "members" ? nextData.members : nextData.snapshots)[String(entry.cardId)])
        unknownCards.push({ kind, instanceId: entry.instanceId, cardId: entry.cardId });
  const { issues } = validateInventory(candidate, nextData);
  return { candidate, changes, unknownCards, issues, canApply: issues.length === 0 };
}

/** Each native skill slot has its own rank field; these levels are not independently editable. */
export function snapshotSkillLevels(
  data: TeamBuilderData,
  cardId: number,
  awakening: number | null,
): {
  support: { id: number; slot: number; level: number | null }[];
  gekisoSupport: { id: number; slot: number; level: number | null }[];
} {
  const card = data.snapshots[String(cardId)];
  if (!card) return { support: [], gekisoSupport: [] };
  const rank =
    awakening === null
      ? undefined
      : data.progression.supportCardRanks?.find(
          (row) => Number(row.group) === card.awakeningGroup && Number(row.rank) === awakening,
        );
  const levels = (ids: number[], prefix: string, known: boolean) =>
    ids.map((id, slot) => {
      if (!known) return { id, slot, level: null };
      if (id === 0) return { id, slot, level: 0 };
      const value = rank?.[`${prefix}${String(slot + 1).padStart(2, "0")}Level`];
      return { id, slot, level: typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null };
    });
  return {
    support: levels(
      card.supportSkillIds,
      "supportSkill",
      card.supportSkillSlotsKnown ?? card.supportSkillIds.length === 2,
    ),
    gekisoSupport: levels(
      card.gekisoSupportSkillIds,
      "gekisouSupportSkill",
      card.gekisoSupportSkillSlotsKnown ?? card.gekisoSupportSkillIds.length === 2,
    ),
  };
}
export function updateInventoryEntries(
  inventory: InventoryV1,
  kind: InventoryKind,
  ids: readonly string[],
  patch: Partial<MemberEntry | SnapshotEntry>,
): InventoryV1 {
  const allowed = new Set<string>([...(kind === "members" ? MEMBER_FIELDS : SNAPSHOT_FIELDS), "locked", "excluded"]);
  const clean = Object.fromEntries(Object.entries(patch).filter(([key]) => allowed.has(key)));
  const selected = new Set(ids);
  return {
    ...inventory,
    [kind]: inventory[kind].map((entry) => (selected.has(entry.instanceId) ? { ...entry, ...clean } : entry)),
  };
}
export function removeInventoryEntry(inventory: InventoryV1, kind: InventoryKind, id: string): InventoryV1 {
  return { ...inventory, [kind]: inventory[kind].filter((entry) => entry.instanceId !== id) };
}

export function practiceRanges(
  data: TeamBuilderData,
  kind: InventoryKind,
  cardId: number,
  state?: Partial<MemberEntry | SnapshotEntry>,
): Record<string, number[]> {
  const support = kind === "snapshots";
  const card = support ? data.snapshots[String(cardId)] : data.members[String(cardId)];
  if (!card) return {};
  let cache = rangeCache.get(data);
  if (!cache) {
    cache = new Map();
    rangeCache.set(data, cache);
  }
  const key = `${kind}/${cardId}/${(state as Partial<MemberEntry> | undefined)?.training ?? "?"}/${state?.awakening ?? "?"}`;
  const cached = cache.get(key);
  if (cached) return Object.fromEntries(Object.entries(cached).map(([field, values]) => [field, [...values]]));
  const progression = data.progression;
  const ranks = (progression[support ? "supportCardRanks" : "memberCardRanks"] || []).filter(
    (row) => Number(row.group) === card.awakeningGroup,
  );
  const levels = (progression[support ? "supportCardLevels" : "memberCardLevels"] || []).filter(
    (row) => Number(row.group) === card.levelGroup,
  );
  const ranges: Record<string, number[]> = { awakening: values(ranks, "rank"), level: values(levels, "level") };
  let cap: number | undefined;
  if (support) cap = Number(ranks.find((row) => Number(row.rank) === state?.awakening)?.limitLevel);
  else {
    const member = data.members[String(cardId)];
    if (!member) return {};
    ranges.training = values(
      (progression.memberCardAwake || []).filter((row) => Number(row.group) === member.trainingGroup),
      "awakeCount",
    );
    const training = (state as Partial<MemberEntry> | undefined)?.training;
    cap = Number(
      (progression.memberCardLevelLimits || []).find(
        (row) => Number(row.rarity) === member.rarity && Number(row.awakeCount) === training,
      )?.limitLevel,
    );
    for (const [field, group, skillId] of [
      ["liveSkillLevel", "live", member.liveSkillId],
      ["gekisoSkillLevel", "gekiso", member.gekisoSkillId],
    ] as const) {
      ranges[field] =
        skillId > 0 ? values(dataRows(data.skills[group]?.[String(skillId)]?.effects).map(nativeRow), "level") : [];
    }
  }
  if (Number.isFinite(cap) && cap! > 0) ranges.level = (ranges.level || []).filter((level) => level <= cap!);
  if (cache.size < 4096)
    cache.set(key, Object.fromEntries(Object.entries(ranges).map(([field, values]) => [field, [...values]])));
  return ranges;
}

/** Unknown practice is editable; requirePractice turns it into a solver input error. */
export function validateInventory(
  value: unknown,
  data: TeamBuilderData,
  options: {
    requirePractice?: boolean;
    requireModifiers?: boolean;
    allowDifferentRelease?: boolean;
    allowDuplicateCards?: boolean;
    /** Retained account IDs qualified against this exact Master/account scope. */
    accountCharacterIds?: readonly number[];
  } = {},
): { valid: boolean; issues: InventoryIssue[] } {
  const issues: InventoryIssue[] = [];
  const problem = (path: string, code: string, allowed?: number[]) =>
    issues.push({ path, code, ...(allowed ? { values: allowed } : {}) });
  if (!value || typeof value !== "object" || Array.isArray(value))
    return { valid: false, issues: [{ path: "", code: "invalid-document" }] };
  const inventory = value as InventoryV1;
  const rootKeys = new Set([
    "schema",
    "server",
    "releaseId",
    "members",
    "snapshots",
    "bandItems",
    "characterRanks",
    "bandRanks",
  ]);
  if (inventory.schema === "haneoka-team-inventory-v2") rootKeys.add("playerModifiers");
  for (const field of Object.keys(inventory)) if (!rootKeys.has(field)) problem(field, "unknown-field");
  if (!["haneoka-team-inventory-v1", "haneoka-team-inventory-v2"].includes(inventory.schema))
    problem("schema", "unsupported-schema");
  if (inventory.schema === "haneoka-team-inventory-v2")
    issues.push(...validatePlayerModifiers(inventory.playerModifiers, data, options.requireModifiers));
  else if (options.requireModifiers) problem("playerModifiers", "unknown-modifiers");
  if (inventory.server !== data.identity.server) problem("server", "different-server");
  if (
    typeof inventory.releaseId !== "string" ||
    (!options.allowDifferentRelease && inventory.releaseId !== data.identity.releaseId)
  )
    problem("releaseId", "different-release");
  const seen = new Set<string>();
  for (const kind of ["members", "snapshots"] as const) {
    const cardIds = new Set<number>();
    if (!Array.isArray(inventory[kind]) || inventory[kind].length > MAX_INVENTORY_ENTRIES) {
      problem(kind, "invalid-entry-list");
      continue;
    }
    inventory[kind].forEach((entry, index) => {
      const path = `${kind}.${index}`;
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        problem(path, "invalid-entry");
        return;
      }
      const fields = kind === "members" ? MEMBER_FIELDS : SNAPSHOT_FIELDS;
      const allowedKeys = new Set<string>(["instanceId", "cardId", "locked", "excluded", ...fields]);
      for (const field of Object.keys(entry)) if (!allowedKeys.has(field)) problem(`${path}.${field}`, "unknown-field");
      if (
        typeof entry.instanceId !== "string" ||
        !entry.instanceId ||
        entry.instanceId.length > 128 ||
        seen.has(entry.instanceId)
      )
        problem(`${path}.instanceId`, "invalid-or-duplicate-instance");
      else seen.add(entry.instanceId);
      const card = (kind === "members" ? data.members : data.snapshots)[String(entry.cardId)];
      if (!Number.isSafeInteger(entry.cardId) || !card) problem(`${path}.cardId`, "unknown-card");
      if (cardIds.has(entry.cardId) && !options.allowDuplicateCards) problem(`${path}.cardId`, "duplicate-card");
      cardIds.add(entry.cardId);
      if (typeof entry.locked !== "boolean" || typeof entry.excluded !== "boolean" || (entry.locked && entry.excluded))
        problem(path, "invalid-flags");
      const ranges = practiceRanges(data, kind, entry.cardId, entry);
      for (const field of kind === "members" ? MEMBER_FIELDS : SNAPSHOT_FIELDS) {
        const number = (entry as unknown as Record<string, unknown>)[field];
        if (number === null) {
          if (options.requirePractice) problem(`${path}.${field}`, "unknown-practice");
          continue;
        }
        if (!Number.isSafeInteger(number) || !ranges[field]?.includes(number as number))
          problem(`${path}.${field}`, "out-of-range", ranges[field] || []);
      }
      if (options.requirePractice && kind === "members" && (entry as MemberEntry).training === null)
        problem(`${path}.level`, "unknown-level-cap");
      if (options.requirePractice && kind === "snapshots" && entry.awakening === null)
        problem(`${path}.level`, "unknown-level-cap");
    });
  }
  for (const field of ["bandItems", "characterRanks", "bandRanks"] as const) {
    const map = inventory[field];
    if (!map || typeof map !== "object" || Array.isArray(map)) {
      problem(field, "invalid-level-map");
      continue;
    }
    if (Object.keys(map).length > 2048) {
      problem(field, "too-many-levels");
      continue;
    }
    for (const [id, level] of Object.entries(map)) {
      const record =
        field === "bandItems" ? data.bandItems[id] : field === "characterRanks" ? data.characters[id] : data.bands[id];
      const accountCharacter = field === "characterRanks" && Number.isSafeInteger(Number(id)) &&
        options.accountCharacterIds?.includes(Number(id));
      if (!/^[1-9]\d*$/u.test(id) || (!record && !accountCharacter)) {
        problem(`${field}.${id}`, "unknown-entity");
        continue;
      }
      const allowed =
        field === "bandItems"
          ? bandItemLevelValues(data, id)
          : values(data.progression[field] || [], "rank");
      if (level === null) {
        if (options.requirePractice) problem(`${field}.${id}`, "unknown-practice");
      } else if (!Number.isSafeInteger(level) || !allowed.includes(level))
        problem(`${field}.${id}`, "out-of-range", allowed);
    }
  }
  return { valid: issues.length === 0, issues };
}

/** Instance uniqueness is established; native equip/character restrictions are reported separately by the solver. */
export function validateAssignment(assignment: TeamAssignment, inventory: InventoryV1): InventoryIssue[] {
  const issues: InventoryIssue[] = [];
  const members = new Map(inventory.members.map((entry) => [entry.instanceId, entry]));
  const snapshots = new Map(inventory.snapshots.map((entry) => [entry.instanceId, entry]));
  if (assignment.snapshotInstanceIds.length !== assignment.memberInstanceIds.length)
    issues.push({ path: "assignment", code: "slot-count-mismatch" });
  const used = new Set<string>();
  const slots = [
    ...assignment.memberInstanceIds.map((id) => ({ id, entry: members.get(id) })),
    ...assignment.snapshotInstanceIds
      .filter((id): id is string => id !== null)
      .map((id) => ({ id, entry: snapshots.get(id) })),
  ];
  for (const { id, entry } of slots) {
    if (!entry || entry.excluded || used.has(id))
      issues.push({ path: id, code: "missing-excluded-or-reused-instance" });
    used.add(id);
  }
  if (!assignment.memberInstanceIds.includes(assignment.leaderInstanceId))
    issues.push({ path: "leaderInstanceId", code: "leader-not-in-team" });
  for (const entry of [...inventory.members, ...inventory.snapshots])
    if (entry.locked && !used.has(entry.instanceId))
      issues.push({ path: entry.instanceId, code: "locked-instance-missing" });
  return issues;
}
