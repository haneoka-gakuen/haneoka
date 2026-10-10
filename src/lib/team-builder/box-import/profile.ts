import { BOX_LIMITS, BoxImportError, object, integer, type BoxCandidate } from "./types";
import { createUnknownPlayerModifiers } from "../data/player-modifiers";
const id = (v: unknown) => {
  const n = integer(v);
  return n !== null && n > 0 && n <= 0x7fffffff ? n : null;
};
const rows = (v: unknown): unknown[] => {
  if (!Array.isArray(v)) throw new BoxImportError("box_invalid_json");
  if (v.length > BOX_LIMITS.rowsPerList) throw new BoxImportError("box_row_budget");
  return v;
};
function supplied(v: unknown): number | null {
  if (v === undefined || v === null) return null;
  const n = integer(v);
  if (n === null) throw new BoxImportError("box_invalid_json");
  return n;
}
const countToNative = (v: unknown) => {
  const count = supplied(v);
  if (count === Number.MAX_SAFE_INTEGER) throw new BoxImportError("box_invalid_json");
  return count === null ? null : count + 1;
};
/** Explicit supported document schemas only; never follows account/auth envelopes or arbitrary profile APIs. */
export function projectInventoryDocument(root: Record<string, unknown>): BoxCandidate | null {
  const legacy = object(root.profile) || root,
    inventory = object(legacy.inventory);
  const canonical = root.schema === "haneoka-team-inventory-v1" || root.schema === "haneoka-team-inventory-v2";
  const reference =
    integer(legacy.schema_version) === 1 &&
    inventory !== null &&
    Array.isArray(inventory.members) &&
    Array.isArray(inventory.snaps);
  if (!canonical && !reference) return null;
  const candidate: BoxCandidate = {
    id: crypto.randomUUID(),
    format: canonical ? "inventory-json" : "reference-profile",
    members: [],
    snapshots: [],
    characters: [],
    bandItems: [],
  };
  if (canonical) {
    if (typeof root.server !== "string" || root.server.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(root.server))
      throw new BoxImportError("box_invalid_json");
    candidate.declaredIdentity = {
      server: root.server,
      ...(typeof root.releaseId === "string" && /^r-[a-f0-9]{20}$/.test(root.releaseId)
        ? { releaseId: root.releaseId }
        : {}),
    };
  }
  for (const raw of rows(canonical ? root.members : inventory!.members)) {
    const row = object(raw);
    if (!row) throw new BoxImportError("box_invalid_json");
    const cardId = id(canonical ? row.cardId : row.id);
    if (cardId === null) throw new BoxImportError("box_invalid_json");
    candidate.members.push({
      cardId,
      exp: null,
      level: supplied(row.level),
      awakeCount: canonical ? supplied(row.training) : countToNative(row.training_count),
      rank: canonical ? supplied(row.awakening) : countToNative(row.awakening_count),
      liveSkillLevel: supplied(canonical ? row.liveSkillLevel : row.live_skill_level),
      performanceSkillLevel: supplied(canonical ? row.gekisoSkillLevel : row.gekisou_skill_level),
    });
  }
  for (const raw of rows(canonical ? root.snapshots : inventory!.snaps)) {
    const row = object(raw);
    if (!row) throw new BoxImportError("box_invalid_json");
    const cardId = id(canonical ? row.cardId : row.id);
    if (cardId === null) throw new BoxImportError("box_invalid_json");
    candidate.snapshots.push({
      cardId,
      exp: null,
      level: supplied(row.level),
      rank: canonical ? supplied(row.awakening) : countToNative(row.limit_break_count),
    });
  }
  if (canonical) {
    const rawModifiers = object(root.playerModifiers);
    if (rawModifiers) {
      const modifiers = createUnknownPlayerModifiers();
      modifiers.characterTotalRank = supplied(rawModifiers.characterTotalRank);
      modifiers.vipRank = supplied(rawModifiers.vipRank);
      for (const field of ["musicMemoryPoints", "characterMemoryPoints"] as const) {
        const map = object(rawModifiers[field]);
        if (!map || Object.keys(map).length > 2048) throw new BoxImportError("box_invalid_json");
        for (const [rawId, value] of Object.entries(map)) {
          if (!id(rawId)) throw new BoxImportError("box_invalid_json");
          modifiers[field][rawId] = supplied(value);
        }
      }
      candidate.playerModifiers = modifiers;
    }
    for (const key of ["bandItems", "characterRanks"] as const) {
      const map = object(root[key]);
      if (!map || Object.keys(map).length > BOX_LIMITS.rowsPerList) throw new BoxImportError("box_invalid_json");
      for (const [rawId, value] of Object.entries(map)) {
        const entity = id(rawId);
        if (entity === null) throw new BoxImportError("box_invalid_json");
        if (key === "bandItems") candidate.bandItems.push({ id: entity, level: supplied(value) });
        else candidate.characters.push({ id: entity, exp: null, rank: supplied(value) });
      }
    }
  } else {
    for (const raw of rows(legacy.facilities ?? [])) {
      const row = object(raw),
        entity = row && id(row.id);
      if (!row || !entity) throw new BoxImportError("box_invalid_json");
      candidate.bandItems.push({ id: entity, level: supplied(row.level) });
    }
    for (const raw of rows(legacy.character_ranks ?? [])) {
      const row = object(raw),
        entity = row && id(row.character_id);
      if (!row || !entity) throw new BoxImportError("box_invalid_json");
      candidate.characters.push({ id: entity, exp: null, rank: supplied(row.rank) });
    }
  }
  // Source names, account_import/id, old solver settings/candidate pools and auth data are not inventory evidence.
  return candidate;
}
