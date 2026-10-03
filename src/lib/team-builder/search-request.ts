import type { SearchConstraints, WorkerPreparationInput } from "./contracts.ts";
import { validateInventory } from "./inventory.ts";

export interface SearchRequestProjection {
  before: { members: number; snapshots: number };
  after: { members: number; snapshots: number };
  removed: { excludedMembers: number; excludedSnapshots: number; lockedCharacter: number; fullMemberLocks: number; fullSnapshotLocks: number };
}

/** Remove only options forbidden by the submitted formation constraints.
 * The complete inventory is validated first; invalid records/locks still reach
 * the authoritative Worker unchanged. All player modifiers, Master rows, card
 * practice, slot ordering and objectives are preserved. Photo character lists
 * are effect selectors, so they never filter the photo pool here.
 */
export function projectPreparationRequest(request: WorkerPreparationInput): {
  request: WorkerPreparationInput;
  projection: SearchRequestProjection;
} {
  const inventory = request.inventory;
  const projection: SearchRequestProjection = {
    before: { members: inventory.members.length, snapshots: inventory.snapshots.length },
    after: { members: inventory.members.length, snapshots: inventory.snapshots.length },
    removed: { excludedMembers: 0, excludedSnapshots: 0, lockedCharacter: 0, fullMemberLocks: 0, fullSnapshotLocks: 0 },
  };
  const unchanged = () => ({ request, projection });
  if (!validateInventory(inventory, request.data).valid) return unchanged();
  const constraints: SearchConstraints = request.constraints;
  if (!Number.isSafeInteger(constraints.teamSize) || constraints.teamSize < 1 || constraints.teamSize > 5)
    return unchanged();
  const memberLocks = new Set(constraints.lockedMemberIds), photoLocks = new Set(constraints.lockedSnapshotIds);
  if (
    memberLocks.size !== constraints.lockedMemberIds.length || photoLocks.size !== constraints.lockedSnapshotIds.length ||
    memberLocks.size > constraints.teamSize || photoLocks.size > constraints.teamSize
  ) return unchanged();
  const excludedMembers = new Set(constraints.excludedMemberIds), excludedPhotos = new Set(constraints.excludedSnapshotIds);
  const byMember = new Map(inventory.members.map(entry => [entry.instanceId, entry]));
  const byPhoto = new Map(inventory.snapshots.map(entry => [entry.instanceId, entry]));
  const characters = new Set<number>();
  for (const id of memberLocks) {
    const entry = byMember.get(id);
    const character = entry && request.data.members[String(entry.cardId)]?.characterId;
    if (!entry || entry.excluded || excludedMembers.has(id) || !Number.isSafeInteger(character) || character! < 1 || characters.has(character!))
      return unchanged();
    characters.add(character!);
  }
  for (const id of photoLocks) {
    const entry = byPhoto.get(id);
    if (!entry || entry.excluded || excludedPhotos.has(id)) return unchanged();
  }
  const members = inventory.members.filter(entry => {
    if (entry.excluded || excludedMembers.has(entry.instanceId)) { projection.removed.excludedMembers++; return false; }
    if (memberLocks.has(entry.instanceId)) return true;
    if (memberLocks.size === constraints.teamSize) { projection.removed.fullMemberLocks++; return false; }
    const character = request.data.members[String(entry.cardId)]?.characterId;
    if (Number.isSafeInteger(character) && characters.has(character!)) { projection.removed.lockedCharacter++; return false; }
    return true;
  });
  const snapshots = inventory.snapshots.filter(entry => {
    if (entry.excluded || excludedPhotos.has(entry.instanceId)) { projection.removed.excludedSnapshots++; return false; }
    if (photoLocks.size === constraints.teamSize && !photoLocks.has(entry.instanceId)) {
      projection.removed.fullSnapshotLocks++; return false;
    }
    return true;
  });
  projection.after = { members: members.length, snapshots: snapshots.length };
  return members.length === inventory.members.length && snapshots.length === inventory.snapshots.length
    ? unchanged()
    : { request: { ...request, inventory: { ...inventory, members, snapshots } }, projection };
}
