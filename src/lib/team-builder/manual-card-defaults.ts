import { practiceRanges, updateInventoryEntries, validateInventory, type InventoryKind, type InventoryV1, type MemberEntry, type SnapshotEntry } from "./inventory";
import type { TeamBuilderData } from "./data";
import { resolveCharacterRankTotal, type CharacterRankTotalScope } from "./data/character-rank-total";
import { characterRankInventoryIds } from "./data/character-rank-scope";

/** Maximum legal new-card preset. Only IDs absent from the pre-add inventory
 * and null fields are initialized. Existing cards and supplied values stay intact.
 */
export function initializeNewCardPractice(before: InventoryV1, added: InventoryV1, data: TeamBuilderData,
  scope?: CharacterRankTotalScope): InventoryV1 {
  let next = added;
  for (const kind of ["members", "snapshots"] as const satisfies readonly InventoryKind[]) {
    const owned = new Set(before[kind].map(entry => entry.cardId));
    for (const entry of added[kind]) {
      if (owned.has(entry.cardId)) continue;
      next = updateInventoryEntries(next, kind, [entry.instanceId], maximumNewCardPractice(data, kind, entry.cardId, entry));
    }
  }
  const ids = scope ? characterRankInventoryIds(resolveCharacterRankTotal(data, next, scope)) : [];
  if (!validateInventory(next, data, { accountCharacterIds: ids }).valid) throw new RangeError("manual-card-default-practice");
  return next;
}

/** Preview metadata only. These defaults are not recognized screenshot values. */
export function maximumNewCardPractice(data: TeamBuilderData, kind: InventoryKind, cardId: number, supplied: Partial<MemberEntry | SnapshotEntry> = {}) {
  const state = { ...supplied } as Record<string, number | null | undefined>;
  const patch: Record<string, number> = {};
  const fields = kind === "members" ? ["training", "awakening", "level", "liveSkillLevel", "gekisoSkillLevel"] : ["awakening", "level"];
  for (const field of fields) {
    if (state[field] !== null && state[field] !== undefined) continue;
    if (field === "level" && state[kind === "members" ? "training" : "awakening"] == null) continue;
    const legal = practiceRanges(data, kind, cardId, state as Partial<MemberEntry | SnapshotEntry>)[field] ?? [];
    if (legal.length) state[field] = patch[field] = Math.max(...legal);
  }
  return patch;
}

/** Existing main caller keeps this name; ordinary manual add uses the same preset. */
export const initializeManualCardPractice = initializeNewCardPractice;
