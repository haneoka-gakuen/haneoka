import type { EngineRequest, EngineResponse, SongRef, SongResult } from "./api";

/** Comparable between the page and Workers, whose performance origins may differ. */
export const clock = () => performance.timeOrigin + performance.now();
export const deadlineOf = (request: EngineRequest) => request.deadline ?? (request.timeLimitMs == null ? Infinity : clock() + request.timeLimitMs);
export const remaining = (deadline: number) => Math.max(0, deadline - clock());
export function singleSongRequest(request: EngineRequest): EngineRequest {
  const goal = request.goal;
  if (goal.kind !== "score" && goal.kind !== "event" && goal.kind !== "gekiso") return request;
  if (request.aggregation !== "mean" && !(goal.kind === "gekiso" && goal.arena?.mode === "shared")) return request;
  const first = goal.songs[0];
  if (!first || goal.songs.some(song => song.songId !== first.songId || song.difficulty !== first.difficulty)) return request;
  const { aggregation: _aggregation, ...input } = request;
  return { ...input, goal: goal.kind === "gekiso" && goal.arena?.mode === "shared"
    ? { ...goal, songs: [first], arena: { ...goal.arena, mode: "individual" } }
    : { ...goal, songs: [first] } };
}
export const requestSongs = (input: EngineRequest): (SongRef | null)[] => {
  const request = singleSongRequest(input);
  const goal = request.goal;
  if (request.aggregation === "mean" || (goal.kind === "gekiso" && goal.arena?.mode === "shared")) return [null];
  return goal.kind === "power" ? [goal.song] : goal.kind === "potential" ? [null] : goal.kind === "plan"
    ? [...goal.challengeSongs, ...goal.normalSongs] : goal.kind === "event" && !goal.songs.length && goal.route === "skip" ? [null] : goal.songs;
};
export const requestChartSongs = (input: EngineRequest): (SongRef | null)[] => {
  if (input.resolveRewardPlan && !input.songRules && input.goal.kind === "event" && input.goal.rewardPlan) {
    return input.goal.rewardPlan.autoCp?.songs ?? [];
  }
  const request = singleSongRequest(input);
  return [
    ...((request.aggregation === "mean" && (request.goal.kind === "score" || request.goal.kind === "event")) || (request.goal.kind === "gekiso" && (request.goal.arena || request.aggregation === "mean")) ? request.goal.songs : requestSongs(request)), ...(request.goal.kind === "event" ? request.goal.rewardPlan?.autoCp?.songs ?? [] : []),
  ];
};
export const pendingSong = (song: SongRef | null): SongResult => ({
  song, hits: [], proven: false, bound: Infinity,
  stats: { leaders: 0, memberNodes: 0, snapNodes: 0, candidates: 0, exact: 0, elapsedMs: 0 },
});
export const emptyResponse = (request: EngineRequest): EngineResponse => ({
  results: requestSongs(request).map(song => request.completed?.find(result => result.song?.songId === song?.songId && result.song?.difficulty === song?.difficulty) ?? pendingSong(song)), overall: [], unknownCards: [], elapsedMs: 0,
});
export const completeResponse = (response: EngineResponse) => response.results.length > 0 && response.results.every(result => result.proven || result.exclusion !== undefined || result.excludedBelow !== undefined);

export interface RewardCutoff {
  key: number;
  comparison: "gt" | "gte";
  contextKey: string;
  ranking: "reward-mean-score-v2";
}
export const acceptsReward = (key: number, cutoff: RewardCutoff) => cutoff.comparison === "gt" ? key > cutoff.key : key >= cutoff.key;
export const excludesBound = (bound: number, cutoff: RewardCutoff) => cutoff.comparison === "gt" ? bound <= cutoff.key : bound < cutoff.key;

export function improvementPercent(results: readonly SongResult[]): number | null {
  const best = Math.max(...results.flatMap(result => result.hits.map(hit => hit.key)));
  if (!(best > 0) || !results.length) return null;
  let upper = best;
  for (const result of results) {
    if (result.proven) continue;
    const bound = result.exclusion?.key ?? result.bound;
    if (bound === null || !Number.isFinite(bound)) return null;
    upper = Math.max(upper, bound);
  }
  return Math.ceil(Math.max(0, (upper / best - 1) * 1000)) / 10;
}
