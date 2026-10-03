import { practiceRanges, updateInventoryEntries, validateInventory, type InventoryKind, type InventoryV1 } from "./inventory";
import type { TeamBuilderData } from "./data";

/** Explicit manual-add preset. Only IDs absent from the pre-add inventory are
 * initialized; screenshots, imports and historical unknown values stay intact.
 */
export function initializeManualCardPractice(before: InventoryV1, added: InventoryV1, data: TeamBuilderData): InventoryV1 {
  let next = added;
  for (const kind of ["members", "snapshots"] as const satisfies readonly InventoryKind[]) {
    const owned = new Set(before[kind].map(entry => entry.cardId));
    for (const entry of added[kind]) {
      if (owned.has(entry.cardId)) continue;
      // Set the cap-defining fields before choosing a legal level.
      const fields = kind === "members" ? ["training", "awakening", "level", "liveSkillLevel", "gekisoSkillLevel"] : ["awakening", "level"];
      for (const field of fields) {
        const current = next[kind].find(value => value.instanceId === entry.instanceId)!;
        if ((current as unknown as Record<string, unknown>)[field] !== null) continue;
        const legal = practiceRanges(data, kind, entry.cardId, current)[field] ?? [];
        if (legal.length) next = updateInventoryEntries(next, kind, [entry.instanceId], { [field]: Math.min(...legal) });
      }
    }
  }
  if (!validateInventory(next, data).valid) throw new RangeError("manual-card-default-practice");
  return next;
}
