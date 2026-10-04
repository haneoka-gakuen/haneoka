import type { Candidate, Objective, OptimizationInput, SongSearchRanking } from "./contracts.ts";
import { createSongRankingCollector } from "./solver/search-rankings.ts";

export interface CardSetRanking { memberCardIds: number[]; candidate: Candidate }
export interface SearchCollectorState {
  schema: "haneoka-search-collector-v1";
  rankings: SongSearchRanking[];
  incompleteSongs: string[];
  /** Includes evaluated formations rejected by a known bonus floor. */
  counts: [string, number][];
  cardSets: Partial<Record<Objective, CardSetRanking[]>>;
}
const assignmentKey = (candidate: Candidate) => JSON.stringify(candidate.assignment);
const completeAxis = (candidate: Candidate, objective: Objective) => {
  const metric = candidate.metrics[objective];
  return metric.value !== null && Number.isFinite(metric.value) && metric.status !== "unavailable" && !metric.gaps.length;
};
const compare = (objective: Objective, a: Candidate, b: Candidate) =>
  b.metrics[objective].value! - a.metrics[objective].value! ||
  a.songKey.localeCompare(b.songKey, "en") || assignmentKey(a).localeCompare(assignmentKey(b), "en");

/** Reuse the existing chart Top3 collector. Small completed summaries restore
 * ranking state; native evaluations and unfinished assignment work stay separate. */
export function createSearchCollectors(input: OptimizationInput, restore?: SearchCollectorState) {
  const legacy = createSongRankingCollector(input);
  const allowedSongs = new Set(input.songs.map(song => song.key));
  const counts = new Map(input.songs.map(song => [song.key, 0]));
  const incomplete = new Set<string>();
  const cardIds = new Map(input.members.map(member => [member.instanceId, member.cardId]));
  const groupLimit = input.constraints.resultDistinctCardSets;
  const groups = new Map(input.objectives.map(objective => [objective, new Map<string, CardSetRanking>()]));
  const cardSet = (candidate: Candidate): number[] => candidate.assignment.memberInstanceIds.map(id => {
    const value = cardIds.get(id);
    if (value === undefined) throw new RangeError("candidate-member-identity");
    return value;
  }).sort((a, b) => a - b);
  const offerGroups = (candidate: Candidate) => {
    if (groupLimit === undefined) return;
    const memberCardIds = cardSet(candidate), key = JSON.stringify(memberCardIds);
    for (const objective of input.objectives) {
      if (!completeAxis(candidate, objective)) continue;
      const rows = groups.get(objective)!;
      const old = rows.get(key);
      if (!old || compare(objective, candidate, old.candidate) < 0) rows.set(key, { memberCardIds, candidate });
      if (rows.size > groupLimit) {
        const worst = [...rows.entries()].sort(([, a], [, b]) => compare(objective, a.candidate, b.candidate)).at(-1)!;
        rows.delete(worst[0]);
      }
    }
  };
  if (restore) {
    if (restore.schema !== "haneoka-search-collector-v1" || !Array.isArray(restore.rankings) ||
      !Array.isArray(restore.counts) || !Array.isArray(restore.incompleteSongs) ||
      restore.rankings.length > input.songs.length || restore.counts.length > input.songs.length)
      throw new RangeError("search-collector-state");
    for (const [songKey, count] of restore.counts) {
      if (!allowedSongs.has(songKey) || !Number.isSafeInteger(count) || count < 0) throw new RangeError("search-collector-count");
      counts.set(songKey, count);
    }
    for (const songKey of restore.incompleteSongs) {
      if (!allowedSongs.has(songKey)) throw new RangeError("search-collector-song");
      incomplete.add(songKey);
    }
    for (const row of restore.rankings) {
      const song = input.songs.find(song => song.key === row.songKey);
      if (!song || row.songId !== song.songId || row.difficulty !== song.difficulty) throw new RangeError("search-collector-song");
      const replay = new Map<string, Candidate>();
      for (const objective of input.objectives) {
        const candidates = row.top3[objective] ?? [];
        if (!Array.isArray(candidates) || candidates.length > 3) throw new RangeError("search-collector-top3");
        for (const candidate of candidates) {
          if (candidate.songKey !== row.songKey) throw new RangeError("search-collector-candidate-song");
          replay.set(assignmentKey(candidate), structuredClone(candidate));
        }
      }
      replay.forEach(candidate => legacy.offer(candidate));
    }
    for (const objective of input.objectives) {
      const rows = restore.cardSets?.[objective] ?? [];
      if (!Array.isArray(rows) || rows.length > (groupLimit ?? 0)) throw new RangeError("search-collector-cardsets");
      for (const row of rows) {
        if (!allowedSongs.has(row.candidate.songKey) || JSON.stringify(cardSet(row.candidate)) !== JSON.stringify(row.memberCardIds))
          throw new RangeError("search-collector-cardset-identity");
        offerGroups(structuredClone(row.candidate));
      }
    }
  }
  const finish = (exhaustive: boolean, allowed: ReadonlySet<string>) => legacy.finish(exhaustive, allowed).map(row => ({
    ...row, evaluated: counts.get(row.songKey)!, proven: row.proven && !incomplete.has(row.songKey),
  }));
  const finishGroups = (): Partial<Record<Objective, CardSetRanking[]>> => groupLimit === undefined ? {} :
    Object.fromEntries(input.objectives.map(objective => [objective, [...groups.get(objective)!.values()]
      .sort((a, b) => compare(objective, a.candidate, b.candidate))]));
  return {
    offer(candidate: Candidate, eligible = true, unknownConstraint = false) {
      if (!counts.has(candidate.songKey)) throw new RangeError("candidate-song-identity");
      counts.set(candidate.songKey, counts.get(candidate.songKey)! + 1);
      if (!eligible) {
        if (unknownConstraint) incomplete.add(candidate.songKey);
        return;
      }
      if (unknownConstraint || !candidate.vector.every(Number.isFinite) ||
        input.objectives.some(objective => !completeAxis(candidate, objective))) incomplete.add(candidate.songKey);
      legacy.offer(candidate); offerGroups(candidate);
    },
    finish,
    finishGroups,
    snapshot(): SearchCollectorState {
      return structuredClone({ schema: "haneoka-search-collector-v1", rankings: finish(false, allowedSongs),
        counts: [...counts], incompleteSongs: [...incomplete], cardSets: finishGroups() });
    },
  };
}
