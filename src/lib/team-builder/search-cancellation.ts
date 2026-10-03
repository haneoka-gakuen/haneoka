import type { SolverRequest } from "./contracts.ts";

/** Explicit user cancellation gives the existing Worker a short opportunity
 * to return its already completed leaves. Input/account/source invalidation
 * continues to terminate immediately in the owning UI. The returned cleanup
 * cancels the watchdog after a terminal message; it persists no search state.
 */
export function requestSearchCancellation(
  worker: Pick<Worker, "postMessage">,
  runId: string,
  unresponsive: () => void,
  timeoutMs = 1500,
): () => void {
  let pending = true;
  const timer = setTimeout(() => {
    if (!pending) return;
    pending = false;
    unresponsive();
  }, timeoutMs);
  const clear = () => {
    pending = false;
    clearTimeout(timer);
  };
  try {
    worker.postMessage({ type: "cancel", runId } satisfies SolverRequest);
  } catch {
    clear();
    unresponsive();
  }
  return clear;
}
