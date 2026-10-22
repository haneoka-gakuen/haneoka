/** Merges the responses of a sharded search (one shard of leaders per Worker) into one response. Every team has one
 * leader, so each shard's per-song top k is exact over its leaders; the union, deduplicated by member set (the same
 * set can lead with a different member in another shard), holds the exact global top k. */
import type { EngineHit, EngineResponse, Goal, PlanSummary, SongResult } from "./api";

const songKey = (hit: EngineHit) => (hit.song ? `${hit.song.songId}:${hit.song.difficulty}` : "-");
/** Higher key first; equal rewards prefer the other reward, then mean score. */
export const compareHits = (a: EngineHit, b: EngineHit) => b.key - a.key || (b.event?.otherMean ?? 0) - (a.event?.otherMean ?? 0) || (b.score?.mean ?? 0) - (a.score?.mean ?? 0) || (a.song?.songId ?? 0) - (b.song?.songId ?? 0) || (a.song?.difficulty ?? 0) - (b.song?.difficulty ?? 0) || JSON.stringify([a.members, a.snaps]).localeCompare(JSON.stringify([b.members, b.snaps]));
const setKey = (hit: EngineHit) => `${songKey(hit)}|${[...hit.members].sort().join(",")}`;

function topDistinct(hits: readonly EngineHit[], k: number): EngineHit[] {
  const best = new Map<string, EngineHit>();
  for (const hit of hits) {
    const key = setKey(hit);
    const known = best.get(key);
    if (!known || compareHits(hit, known) < 0) best.set(key, hit);
  }
  return [...best.values()].sort(compareHits).slice(0, k);
}

export function mergeShardResponses(responses: readonly EngineResponse[], k: number, elapsedMs: number): EngineResponse {
  const first = responses[0]!;
  const results: SongResult[] = first.results.map((result, index) => {
    const parts = responses.map((response) => response.results[index]!);
    const bounds = parts.map((part) => part.bound).filter((bound): bound is number => bound !== null);
    const floors = parts.map((part) => part.floor).filter((floor): floor is number => floor !== undefined);
    const hits = topDistinct(parts.flatMap((part) => part.hits), k);
    const exclusions = parts.flatMap((part) => part.excludedBelow === undefined ? [] : [part.excludedBelow]);
    const allExhausted = parts.every((part) => part.proven || part.excludedBelow !== undefined || part.exclusion !== undefined);
    const excludedBelow = allExhausted && !hits.length && exclusions.length ? Math.max(...exclusions) : undefined;
    const exclusion = allExhausted && !hits.length ? parts.find(part => part.exclusion)?.exclusion : undefined;
    const proven = !exclusion && allExhausted && excludedBelow === undefined &&
      parts.every((part) => (part.exclusion === undefined || (hits.length >= k && hits[k - 1]!.key >= part.exclusion.key)) &&
        (part.excludedBelow === undefined || (hits.length >= k && hits[k - 1]!.key >= part.excludedBelow)));
    const phase = parts[0]!.rewardPhase;
    return {
      ...(phase && parts.every(part => part.rewardPhase === phase) ? { rewardPhase: phase } : {}),
      ...(exclusion ? { exclusion } : {}),
      ...(floors.length ? { floor: Math.max(...floors) } : {}),
      ...(excludedBelow === undefined ? {} : { excludedBelow }),
      song: result.song,
      hits,
      proven,
      bound: proven ? null : bounds.length ? Math.max(...bounds) : null,
      stats: parts.reduce(
        (total, part) => ({
          leaders: total.leaders + part.stats.leaders,
          memberNodes: total.memberNodes + part.stats.memberNodes,
          snapNodes: total.snapNodes + part.stats.snapNodes,
          candidates: total.candidates + part.stats.candidates,
          exact: total.exact + part.stats.exact,
          sampleComputations: total.sampleComputations + (part.stats.sampleComputations ?? 0),
          sampleCacheHits: total.sampleCacheHits + (part.stats.sampleCacheHits ?? 0),
          sampleEarlyStops: total.sampleEarlyStops + (part.stats.sampleEarlyStops ?? 0),
          elapsedMs: Math.max(total.elapsedMs, part.stats.elapsedMs),
        }),
        { leaders: 0, memberNodes: 0, snapNodes: 0, candidates: 0, exact: 0, elapsedMs: 0, sampleComputations: 0, sampleCacheHits: 0, sampleEarlyStops: 0 },
      ),
    };
  });
  const overall = results
    .flatMap((result) => result.hits)
    .sort(compareHits)
    .slice(0, k);
  return { results, overall, unknownCards: first.unknownCards, elapsedMs };
}

/** Whether every song of a merged aspiration search kept k hits at or above its floor (otherwise it must rerun). */
export function aspirationHeld(response: EngineResponse, k: number): boolean {
  return response.results.every((result) => result.excludedBelow !== undefined || result.floor === undefined || result.hits.filter((hit) => hit.key >= result.floor!).length >= k);
}

/** The cycle a plan settles into: normal lives spend the boosts and earn challenge points, challenge lives spend those. */
export function planSummary(goal: Extract<Goal, { kind: "plan" }>, bestNormal: EngineHit | null, bestChallenge: EngineHit | null, pointsPerChallenge: number): PlanSummary {
  const lives = goal.boostsPerLive > 0 ? Math.floor(goal.boostBudget / goal.boostsPerLive) : goal.boostBudget;
  const earned = Math.floor(lives * (bestNormal?.event?.challengePoints ?? 0));
  const pool = goal.startingChallengePoints + earned;
  const challengeLives = goal.challengePointsPerLive > 0 ? Math.floor(pool / goal.challengePointsPerLive) : 0;
  const eventPointsTotal = lives * (bestNormal?.event?.mean ?? 0) + challengeLives * pointsPerChallenge;
  return {
    normal: bestNormal,
    challenge: bestChallenge,
    normalLives: lives,
    challengeLives,
    challengePointsEarned: earned,
    leftoverChallengePoints: pool - challengeLives * goal.challengePointsPerLive,
    eventPoints: eventPointsTotal,
    perBoost: goal.boostBudget ? eventPointsTotal / Math.max(1, goal.boostsPerLive > 0 ? lives * goal.boostsPerLive : goal.boostBudget) : 0,
  };
}

