import type { SearchResult, SearchResumeCheckpoint } from "./contracts";
import { restoreSearchResumeCheckpoint } from "./search-resume";

export type SearchContinuation = "continue" | "finished" | "capacity" | "no-progress" | "unavailable";

/** Interpret the engine-owned checkpoint outside the UI. Automatic continuation
 * must advance committed work and must not retry a full frontier indefinitely.
 */
export async function searchContinuation(
  result: SearchResult,
  checkpoint: SearchResumeCheckpoint | undefined,
  previous: SearchResumeCheckpoint | undefined,
  nextCapacity: number,
): Promise<SearchContinuation> {
  if (result.completeness !== "budget-limited") return "finished";
  if (!checkpoint || !Number.isSafeInteger(nextCapacity) || nextCapacity < 1 || nextCapacity > 1000)
    return "unavailable";
  const state = await restoreSearchResumeCheckpoint(checkpoint, checkpoint.fingerprint);
  if (!state) return "unavailable";
  if (state.pendingCandidate && state.frontier.length >= nextCapacity) return "capacity";
  if (previous) {
    if (previous.fingerprint !== checkpoint.fingerprint) return "unavailable";
    const before = await restoreSearchResumeCheckpoint(previous, previous.fingerprint);
    if (!before) return "unavailable";
    if (state.cursor.completedLeaves <= before.cursor.completedLeaves && state.cursor.work <= before.cursor.work)
      return "no-progress";
  }
  return "continue";
}
