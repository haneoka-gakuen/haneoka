// L3 — GEB
// Input: Ordinary Live shared reward request and its native Worker scheduler.
// Output: Feasible joint candidates and a completed joint ranking when all domains are proved.
// Pos: [Map](L2-2.md); ordinary shared reward orchestration in EngineClient.
// Effects/Dependencies: Replays candidates and dispatches member and Snapshot proof jobs under the request deadline.
import type { EngineRequest, EngineResponse, Goal, SongResult } from "./api";
import type { TeamBuilderData } from "../data";
import type { PartitionBatch } from "./event-partitions";
import { emptyResponse } from "./execution";
import { acquireSharedEventSeeds } from "./shared-event-seeds";
import { proveSharedEventRosters } from "./shared-event-rosters";
import { proveSharedEventSnapshots } from "./shared-event-snapshots";

type EventRequest = EngineRequest & { goal: Extract<Goal, { kind: "event" }> };

function addStats(a: SongResult["stats"], b: SongResult["stats"]): SongResult["stats"] {
  return {
    leaders: a.leaders + b.leaders,
    memberNodes: a.memberNodes + b.memberNodes,
    snapNodes: a.snapNodes + b.snapNodes,
    candidates: a.candidates + b.candidates,
    exact: a.exact + b.exact,
    elapsedMs: a.elapsedMs + b.elapsedMs,
  };
}

export async function proveSharedEvent(
  data: TeamBuilderData,
  request: EventRequest,
  runBatch: PartitionBatch,
  publish: (response: EngineResponse) => void,
  stopped: () => boolean,
  workers: number,
): Promise<EngineResponse | undefined> {
  const base = emptyResponse(request);
  const row = base.results[0]!;
  const response = (seeds: Awaited<ReturnType<typeof acquireSharedEventSeeds>>): EngineResponse => ({
    ...base,
    results: [{ ...row, hits: seeds.hits, stats: seeds.stats }],
    overall: seeds.hits,
    unknownCards: seeds.unknownCards,
  });
  const seeds = await acquireSharedEventSeeds(request, runBatch, candidates => publish(response(candidates)), stopped, workers);
  const floor = seeds.hits[request.k - 1]?.rewardRanking?.[0];
  if (stopped() || !floor) return undefined;

  const proof = await proveSharedEventRosters(data, request, floor, workers, runBatch, stopped);
  if (stopped() || !proof) return undefined;
  const initial = response({
    ...seeds,
    stats: addStats(seeds.stats, proof.stats),
    unknownCards: [...new Set([...seeds.unknownCards, ...proof.unknownCards])],
  });
  publish(initial);
  return proveSharedEventSnapshots({ request, rosters: proof.candidates, outside: proof.outside, initial, runBatch, stopped, publish });
}
