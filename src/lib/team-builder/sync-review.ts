import type { TeamBuilderData } from "./data.ts";
import type { InventoryStoreState } from "./storage.ts";
import { upgradeInventory, validateInventory } from "./inventory.ts";

/** Object key order is transport detail; row order and every saved value stay exact. */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b))
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, index) => same(value, b[index]));
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  return Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([key, value]) =>
    Object.hasOwn(b, key) && same(value, (b as Record<string, unknown>)[key]));
}

/** An identical revision-conflict payload needs no merge choice or cloud write.
 * The owning store still adopts the observed revision through resolveConflict.
 * Changed values, foreign identities, schema conflicts and regressed revisions
 * retain their original review flow.
 */
export function isUnchangedInventoryConflict(
  state: InventoryStoreState,
  data: TeamBuilderData,
  ownerId: string | null | undefined,
): boolean {
  const remote = state.remote;
  if (
    state.phase !== "conflict" || !ownerId || state.ownerId !== ownerId || remote?.ownerId !== ownerId ||
    remote.server !== data.identity.server || remote.revision < state.revision ||
    (state.error !== undefined && state.error !== "revision_conflict") ||
    !state.inventory || !remote.inventory ||
    state.inventory.server !== data.identity.server || remote.inventory.server !== data.identity.server ||
    state.inventory.releaseId !== data.identity.releaseId || remote.inventory.releaseId !== data.identity.releaseId ||
    !validateInventory(state.inventory, data).valid || !validateInventory(remote.inventory, data).valid
  ) return false;
  return same(upgradeInventory(state.inventory), upgradeInventory(remote.inventory));
}
