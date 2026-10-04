import type { OptimizationInput, SearchResult } from "./contracts.ts";
import { optimizeTeams, type SearchHooks } from "./optimizer.ts";
import type { SearchResumeState } from "./search-resume.ts";

export interface CompleteSearchHooks extends SearchHooks {
  fingerprint: string;
  /** Same-context partial state is available for persistence after each slice. */
  onSlice?: (value: { slices: number; result: SearchResult; resumeState: SearchResumeState | undefined }) => void | Promise<void>;
  maxNoProgressSlices?: number;
}
export interface CompleteSearchResult {
  method: "exhaustive-bounded-slice-continuation";
  stopReason: "domain-finished" | "unavailable" | "cancelled" | "memory-limit" | "no-progress" | "missing-resume-state";
  slices: number;
  result: SearchResult;
  resumeState?: SearchResumeState;
}
const pause = () => new Promise<void>(resolve => setTimeout(resolve, 0));

/** Continue the exact cursor across bounded CPU slices. Every original song
 * and legal assignment remains in the domain; there is no overall slice-count
 * cap. A stalled atomic native leaf or frontier memory cap returns resumable
 * candidate work rather than spinning or declaring a full-domain proof. */
export async function runCompleteSearch(input: OptimizationInput, hooks: CompleteSearchHooks): Promise<CompleteSearchResult> {
  if (!/^[a-f0-9]{64}$/u.test(hooks.fingerprint)) throw new RangeError("complete-search-fingerprint");
  const noProgressLimit = hooks.maxNoProgressSlices ?? 2;
  if (!Number.isInteger(noProgressLimit) || noProgressLimit < 1 || noProgressLimit > 8)
    throw new RangeError("complete-search-no-progress-limit");
  const now = hooks.now ?? (() => performance.now()), started = now();
  const elapsed = () => Math.max(0, now() - started);
  const yieldWork = hooks.yield ?? pause;
  let resumeState = hooks.resumeState, slices = 0, stalled = 0;
  for (;;) {
    const before = resumeState;
    let captured: SearchResumeState | undefined;
    const result = await optimizeTeams(input, {
      ...hooks, now, fingerprint: hooks.fingerprint, resumeState,
      onResumeState: state => { captured = state; },
      progress: value => hooks.progress?.({ ...value, elapsedMs: elapsed(),
        phase: value.phase === "complete" && value.proofStatus === "candidate" ? "search" : value.phase }),
    });
    slices++;
    resumeState = captured;
    const cumulative = { ...result, elapsedMs: elapsed() };
    hooks.onResumeState?.(resumeState);
    await hooks.onSlice?.({ slices, result: cumulative, resumeState });
    const finish = (stopReason: CompleteSearchResult["stopReason"]): CompleteSearchResult => ({
      method: "exhaustive-bounded-slice-continuation", stopReason, slices, result: cumulative,
      ...(resumeState ? { resumeState } : {}),
    });
    if (result.completeness === "cancelled") return finish("cancelled");
    if (result.completeness === "unavailable") return finish("unavailable");
    if (result.completeness !== "budget-limited") return finish("domain-finished");
    if (hooks.cancelled?.()) {
      return { ...finish("cancelled"), result: { ...cumulative, completeness: "cancelled",
        proof: { status: "candidate", method: "exhaustive-selected-domain", scope: "selected-input-domain" } } };
    }
    if (!resumeState) return finish("missing-resume-state");
    if (resumeState.pendingCandidate && resumeState.frontier.length >= input.budget.maxCandidates)
      return finish("memory-limit");
    const progressed = resumeState.evaluated > (before?.evaluated ?? 0) ||
      resumeState.cursor.work > (before?.cursor.work ?? 0);
    stalled = progressed ? 0 : stalled + 1;
    if (stalled >= noProgressLimit) return finish("no-progress");
    // Let the owner's cancel/source-invalidation message reach the Worker
    // before beginning another slice. The native factory stays job-local.
    await yieldWork();
  }
}
