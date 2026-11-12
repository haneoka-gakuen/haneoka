// Input: A single normal-live event request and its existing Worker pool.
// Output: Ranked distinct member sets and proof from disjoint search partitions.
// Pos: [Map](L2-2.md); single-chart activity reward search in EngineClient.
// Effects/Dependencies: Submits native Top 1 batches under the parent deadline and gives each chart a bounded native Top K pass when the pool cannot start all charts at once.
import type { ConstraintInput, EngineHit, EngineRequest, EngineResponse, Goal } from "./api";
import { emptyResponse } from "./execution";
import { compareHitRank, compareHits, topDistinct } from "./merge";

export const MAX_SINGLE_EVENT_RESULTS = 100;
const PARTITIONS_PER_BATCH = 3;

export function canPartitionEvent(request: EngineRequest): request is EngineRequest & { goal: Extract<Goal, { kind: "event" }> } {
  const { goal, k } = request;
  return goal.kind === "event" && goal.route === "live" && !goal.gekiso && goal.ranking !== "pt-only" && goal.songs.length > 0 &&
    !request.aggregation && k >= 10 && k <= (goal.songs.length === 1 ? MAX_SINGLE_EVENT_RESULTS : 20) &&
    !request.shard && !request.noFloor && !request.seedOnly && !request.seedVariant && !request.seeded &&
    !request.rewardPhase && !request.rewardLexicographic && !request.rewardIncumbent && !request.resolveRewardPlan &&
    !request.floors && !request.cutoff && request.rewardCutoff === undefined;
}

interface Partition {
  constraints: ConstraintInput;
  best: EngineHit;
}

export function splitEventPartition({ constraints, best }: Partition): ConstraintInput[] {
  const required = [...constraints.requiredMembers];
  const fixed = new Set([...required, constraints.leader, ...constraints.bindings.map(([member]) => member)]);
  return [...best.members].sort().filter(member => !fixed.has(member)).map(member => {
    // The first absent member identifies exactly one child for each remaining member set.
    const child = {
      ...constraints,
      requiredMembers: [...required],
      excludedMembers: [...constraints.excludedMembers, member],
    };
    required.push(member);
    return child;
  });
}

export interface PartitionBatchOptions {
  budgetMs?: number;
  stopped?: () => boolean;
}

export type PartitionBatch = (
  requests: readonly EngineRequest[],
  onResult: (index: number, response: EngineResponse) => void,
  onProgress: (response: EngineResponse) => void,
  options?: PartitionBatchOptions,
) => Promise<void>;

export async function partitionEvent(
  request: EngineRequest,
  runBatch: PartitionBatch,
  publish: (response: EngineResponse) => void,
  stopped: () => boolean,
  firstPassBudgetMs?: number,
): Promise<EngineResponse> {
  const base = emptyResponse(request).results[0]!;
  const frontier: Partition[] = [];
  const unknown = new Set<string>();
  const stats = { ...base.stats };
  let provenHits: EngineHit[] = [];
  let candidates: EngineHit[] = [];

  const record = (response: EngineResponse) => {
    if (response.error) throw new Error(response.error);
    for (const key of response.unknownCards) unknown.add(key);
    const part = response.results[0]!;
    stats.leaders += part.stats.leaders;
    stats.memberNodes += part.stats.memberNodes;
    stats.snapNodes += part.stats.snapNodes;
    stats.candidates += part.stats.candidates;
    stats.exact += part.stats.exact;
    stats.elapsedMs += part.stats.elapsedMs;
    return part;
  };

  const result = (proven: boolean): EngineResponse => {
    const hits = proven ? provenHits.slice(0, request.k) : topDistinct([...provenHits, ...candidates], request.k);
    return {
      results: [{ ...base, hits, proven, stats: { ...stats }, bound: null }],
      overall: hits,
      unknownCards: [...unknown],
      elapsedMs: 0,
    };
  };

  const rememberCandidates = (response: EngineResponse) => {
    candidates = topDistinct([...candidates, ...response.overall], request.k);
  };

  const runNative = async (options?: PartitionBatchOptions): Promise<EngineResponse | undefined> => {
    let native: EngineResponse | undefined;
    const withTotals = (response: EngineResponse): EngineResponse => ({
      ...response,
      results: response.results.map(part => ({ ...part, stats: { ...stats } })),
      unknownCards: [...new Set([...unknown, ...response.unknownCards])],
    });
    await runBatch([request], (_index, response) => {
      record(response);
      rememberCandidates(response);
      native = withTotals(response);
      publish(native);
    }, response => {
      rememberCandidates(response);
      publish(withTotals(response));
    }, options);
    return native;
  };

  const solve = async (scopes: readonly ConstraintInput[], seeds?: EngineHit[]): Promise<boolean> => {
    let solved = 0;
    await runBatch(
      scopes.map(constraints => ({ ...request, constraints, k: 1, seeds, completed: undefined })),
      (index, response) => {
        const part = record(response);
        if (part.proven) {
          solved++;
          const best = part.hits[0];
          if (best) {
            frontier.push({ constraints: scopes[index]!, best });
            provenHits = topDistinct([...provenHits, best], request.k + 1);
          }
        } else {
          candidates = topDistinct([...candidates, ...part.hits], request.k);
        }
        publish(result(false));
      },
      response => {
        rememberCandidates(response);
        publish(result(false));
      },
    );
    return solved === scopes.length;
  };

  if (firstPassBudgetMs !== undefined) {
    const first = await runNative({ budgetMs: firstPassBudgetMs });
    if (first?.results[0]?.proven) return first;
    if (stopped()) return result(false);
  }
  if (!await solve([request.constraints], candidates.length ? candidates : undefined)) return result(false);
  while (!stopped()) {
    frontier.sort((a, b) => compareHits(a.best, b.best));
    const cutoff = provenHits[request.k - 1];
    // Expand full-rank ties too so the final identity tie-break sees every tied member set.
    const batch = frontier.slice(0, PARTITIONS_PER_BATCH)
      .filter(part => !cutoff || compareHitRank(part.best, cutoff) <= 0);
    if (!batch.length) {
      const hasTie = provenHits.slice(1).some((hit, index) => compareHitRank(provenHits[index]!, hit) === 0);
      if (!hasTie) return result(true);
      // Preserve the native search's traversal order when the full ranking tuple is tied.
      return await runNative() ?? result(false);
    }
    frontier.splice(0, batch.length);
    const scopes = batch.flatMap(splitEventPartition);
    if (scopes.length && !await solve(scopes)) return result(false);
  }
  return result(false);
}
