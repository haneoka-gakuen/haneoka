import type { EvidenceGap, OptimizationInput, PowerStats, TeamAssignment } from "./contracts";
import type { TeamBuilderData } from "./data";
import type { InventoryV1 } from "./inventory";

export interface FormationLeaderResult { value: PowerStats[] | null; gaps: EvidenceGap[] }
export interface FormationLeaderContext {
  data: TeamBuilderData;
  inventory: InventoryV1;
  input: OptimizationInput;
}

/** Resolver-generation cache for the photo-independent leader bonus only.
 * The native factory computes the values and keeps its effect addition order.
 * Event and final member/photo slot power are evaluated outside this cache.
 */
export function createFormationLeaderCache(
  context: Readonly<FormationLeaderContext>,
  prepare: (assignment: TeamAssignment, musicType: number | null) => FormationLeaderResult,
  capacity = 128,
) {
  if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 512) throw new RangeError("formation-leader-cache-capacity");
  const entries = new Map<string, { context: Readonly<FormationLeaderContext>; values: PowerStats[] }>();
  let preparations = 0, hits = 0;
  return {
    resolve(assignment: TeamAssignment, musicType: number | null, interrupted = false): FormationLeaderResult {
      if (interrupted) entries.clear();
      const key = JSON.stringify([assignment.memberInstanceIds, assignment.leaderInstanceId, musicType]);
      const found = entries.get(key);
      if (!interrupted && found?.context === context) {
        hits++; entries.delete(key); entries.set(key, found);
        return { value: structuredClone(found.values), gaps: [] };
      }
      preparations++;
      const result = prepare(assignment, musicType);
      if (!interrupted && result.value?.length === assignment.memberInstanceIds.length && !result.gaps.length &&
          result.value.every(row => Object.values(row).every(Number.isFinite))) {
        if (entries.size >= capacity) entries.delete(entries.keys().next().value!);
        entries.set(key, { context, values: structuredClone(result.value) });
      }
      return result;
    },
    clear() { entries.clear(); },
    stats() { return { preparations, hits, entries: entries.size, capacity }; },
  };
}
