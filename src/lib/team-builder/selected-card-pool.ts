import type { SearchConstraints } from "./contracts";
import type { InventoryV1 } from "./inventory";

export interface SelectedCardPool { members: string[]; snapshots: string[] }
export function validSelectedCardPool(value: unknown): value is SelectedCardPool {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 2) return false;
  const pool = value as SelectedCardPool;
  return ["members", "snapshots"].every(kind => Object.hasOwn(pool, kind)) &&
    Array.isArray(pool.members) && pool.members.length === 5 && Array.isArray(pool.snapshots) && pool.snapshots.length <= 5 &&
    [pool.members, pool.snapshots].every(ids => new Set(ids).size === ids.length && ids.every(id => typeof id === "string" && id.length > 0 && id.length <= 160));
}
/** Constrain search to the selected physical cards, preserving existing user
 * exclusions and requirements. Empty photo slots stay part of the legal domain.
 */
export function restrictToSelectedCardPool(constraints: SearchConstraints, inventory: InventoryV1, pool: SelectedCardPool): SearchConstraints {
  if (!validSelectedCardPool(pool)) throw new RangeError("selected-card-pool");
  const members = new Set(pool.members), photos = new Set(pool.snapshots);
  return {
    ...constraints,
    lockedMemberIds: [...new Set([...constraints.lockedMemberIds, ...pool.members])],
    lockedSnapshotIds: [...new Set([...constraints.lockedSnapshotIds, ...pool.snapshots])],
    excludedMemberIds: [...new Set([...constraints.excludedMemberIds, ...inventory.members.filter(row => !members.has(row.instanceId)).map(row => row.instanceId)])],
    excludedSnapshotIds: [...new Set([...constraints.excludedSnapshotIds, ...inventory.snapshots.filter(row => !photos.has(row.instanceId)).map(row => row.instanceId)])],
  };
}
