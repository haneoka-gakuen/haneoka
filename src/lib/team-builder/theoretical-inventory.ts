import type { TeamBuilderData } from "./data";
import { addInventoryEntries, upgradeInventory, validateInventory, type InventoryV1 } from "./inventory";
import { maximumNewCardPractice } from "./manual-card-defaults";

/** An independent planning library. Card practice uses the existing legal
 * maximum preset; the selected profile's player bonuses, including unknowns,
 * stay intact. The caller saves this only as an upgrade-planning profile.
 */
export function createTheoreticalInventory(current: InventoryV1, data: TeamBuilderData) {
  if (!validateInventory(current, data).valid) throw new RangeError("theoretical-inventory-source");
  const base = { ...upgradeInventory(current), members: [], snapshots: [] };
  const members = addInventoryEntries(base, "members", Object.values(data.members).map(card => ({ cardId: card.id })), data);
  const all = addInventoryEntries(members, "snapshots", Object.values(data.snapshots).map(card => ({ cardId: card.id })), data);
  const next = {
    ...upgradeInventory(all),
    members: all.members.map(entry => ({ ...entry, ...maximumNewCardPractice(data, "members", entry.cardId, entry) })),
    snapshots: all.snapshots.map(entry => ({ ...entry, ...maximumNewCardPractice(data, "snapshots", entry.cardId, entry) })),
  };
  if (!validateInventory(next, data).valid) throw new RangeError("theoretical-inventory-practice");
  return next;
}
