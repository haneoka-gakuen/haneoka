import type { EvidenceGap } from "./contracts";
import type { SearchEvaluationControls } from "./optimizer";
import type { FixedResourceCycleInput } from "./solver/resource-cycle";
import type { FixedNormalResourceSummary } from "./solver/resource-cycle-summary";
import type { ResourceStageCandidate } from "./resource-plan-contract";

export type NormalResourceCycleInput = Omit<FixedResourceCycleInput, "challenge">;
export type NormalResourceCycleSummary = FixedNormalResourceSummary;
export type NormalResourceCycleResult = { value: NormalResourceCycleSummary | null; gaps: EvidenceGap[] };
export type NormalResourceCycleContext = Pick<ResourceStageCandidate,
  "server" | "releaseId" | "sourceId" | "kind" | "eventId" | "consumedCount" |
  "skillOrderCriterion" | "itemResource" | "assignment"> & { outcomes?: ResourceStageCandidate["outcomes"] };
export type NormalResourceCycleResolver = (input: NormalResourceCycleInput, controls?: SearchEvaluationControls) => Promise<NormalResourceCycleResult>;

/** One native-preparation generation. Keep ordered complete laws and every
 * resource/DP limit in the key; cache only successful, uninterrupted summaries.
 * The native resolver owns convolution and arithmetic. No scalar CP proxy is used.
 */
export function memoizeNormalResourceCycles(resolve: NormalResourceCycleResolver, options: { capacity?: number; maxBytes?: number } = {}) {
  const capacity = options.capacity ?? 64, maxBytes = options.maxBytes ?? 4 * 1024 * 1024;
  if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 256 || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 16 * 1024 * 1024)
    throw new RangeError("resource-normal-cache-budget");
  const cache = new Map<string, { summary: NormalResourceCycleSummary; bytes: number }>();
  let bytes = 0, preparations = 0, hits = 0;
  const interrupted = (controls?: SearchEvaluationControls) => Boolean(controls?.cancelled() || controls?.expired());
  const stopped = (): NormalResourceCycleResult => ({ value: null, gaps: [{ code: "resource-cycle-interrupted", source: "worker cancellation/budget" }] });
  return {
    async prepare(context: NormalResourceCycleContext, input: NormalResourceCycleInput, controls?: SearchEvaluationControls): Promise<NormalResourceCycleResult> {
      if (interrupted(controls)) return stopped();
      if (context.kind !== "normal" || ![context.server, context.releaseId, context.sourceId].every(value => typeof value === "string" && value.length > 0) ||
          !Number.isSafeInteger(context.eventId) || context.eventId < 1 || context.consumedCount !== input.boostPerNormalPlay ||
          !["nominal-mean", "worst-ap", "best-ap"].includes(context.skillOrderCriterion))
        return { value: null, gaps: [{ code: "resource-normal-cache-context", source: "same-source normal stage and consumption" }] };
      const key = JSON.stringify([
        context.server, context.releaseId, context.sourceId, context.kind, context.eventId,
        context.consumedCount, context.skillOrderCriterion, context.itemResource ?? null,
        context.assignment.memberInstanceIds, context.assignment.snapshotInstanceIds, context.assignment.leaderInstanceId,
        (context.outcomes ?? input.normal).map(row => [row.probability, row.eventPoints, row.eventItems, row.challengePoints]),
        input.normal.map(row => [row.probability, row.challengePoints]),
        input.boostBudget, input.boostPerNormalPlay, input.initialChallengePoints, input.challengePointCost,
        input.budget.maxStates, input.budget.maxTransitions,
      ]);
      const existing = cache.get(key);
      if (existing) {
        cache.delete(key); cache.set(key, existing); hits++;
        return { value: structuredClone(existing.summary), gaps: [] };
      }
      preparations++;
      const result = await resolve(input, controls);
      if (interrupted(controls)) return stopped();
      if (!result.value || result.gaps.length) return result;
      const summary = structuredClone(result.value);
      const size = new TextEncoder().encode(key + JSON.stringify(summary)).byteLength;
      if (size <= maxBytes) {
        while (cache.size >= capacity || bytes + size > maxBytes) {
          const oldest = cache.keys().next().value!;
          bytes -= cache.get(oldest)!.bytes; cache.delete(oldest);
        }
        cache.set(key, { summary, bytes: size }); bytes += size;
      }
      return result;
    },
    clear() { cache.clear(); bytes = 0; },
    stats() { return { preparations, hits, entries: cache.size, bytes, capacity, maxBytes }; },
  };
}
