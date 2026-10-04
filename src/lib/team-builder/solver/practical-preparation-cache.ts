import type { TeamAssignment } from "../contracts";
import type { PracticalTask } from "../practical-search";
import type { PreparedSearchEvaluation } from "./evaluation";

/** One immutable practical request only. The factory receives the same selected
 * inventory in original inventory order; leader and physical photo bindings
 * remain arguments of its native evaluator, not properties of this cache key.
 */
export function createPracticalPreparationCache(capacity = 4) {
  if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 4)
    throw new RangeError("practical-preparation-cache-capacity");
  const entries = new Map<string, PreparedSearchEvaluation>();
  let preparations = 0, hits = 0;
  return {
    get(task: PracticalTask, assignment: TeamAssignment, create: () => PreparedSearchEvaluation) {
      const key = JSON.stringify([task.key, task.mode, task.songKey, task.objective,
        [...assignment.memberInstanceIds].sort(),
        assignment.snapshotInstanceIds.filter(id => id !== null).sort()]);
      const found = entries.get(key);
      if (found) {
        hits++; entries.delete(key); entries.set(key, found);
        return found;
      }
      preparations++;
      const prepared = create();
      if (entries.size >= capacity) entries.delete(entries.keys().next().value!);
      entries.set(key, prepared);
      return prepared;
    },
    clear() { entries.clear(); },
    stats() { return { preparations, hits, entries: entries.size, capacity }; },
  };
}
