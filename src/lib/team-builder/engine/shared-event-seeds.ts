// L3 — GEB
// Input: Resolved ordinary-live mean reward request, Worker batch callback and cancellation state.
// Output: Fully scored legal joint candidates, distinct by member set, plus native work statistics.
// Pos: [Map](L2-2.md); incumbent candidates for ordinary-live multi-chart reward proof.
// Effects/Dependencies: Scouts chart winners in disjoint member partitions and replays fixed formations with the original reward plan.
import type { ConstraintInput, EngineHit, EngineRequest, EngineResponse, Goal, SongRef, SongResult } from "./api";
import { splitEventPartition, type PartitionBatch } from "./event-partitions";
import { clock, deadlineOf, pendingSong } from "./execution";
import { compareHits, topDistinct } from "./merge";

type EventRequest = EngineRequest & { goal: Extract<Goal, { kind: "event" }> };
type Partition = { constraints: ConstraintInput; best: EngineHit };
type ChartState = { song: SongRef; frontier: Partition[]; candidates: EngineHit[] };
type ChartJob = { chart: ChartState; constraints: ConstraintInput };

export interface SharedEventSeeds {
  hits: EngineHit[];
  unknownCards: string[];
  stats: SongResult["stats"];
}

const MAX_SCOUT_DEPTH = 10;
const sameSong = (left: SongRef | null, right: SongRef) => left?.songId === right.songId && left.difficulty === right.difficulty;
const formationKey = (hit: EngineHit) => JSON.stringify([hit.members, hit.snaps]);

function fixedSeedRequest(request: EventRequest, hit: EngineHit): EngineRequest | null {
  const { constraints } = request;
  const leader = hit.members[0];
  const members = new Set(hit.members);
  if (!leader || members.size !== 5 || hit.members.length !== 5 || hit.snaps.length !== 5 ||
    constraints.leader !== null && constraints.leader !== leader || constraints.requiredMembers.some(member => !members.has(member)) ||
    constraints.excludedMembers.some(member => members.has(member)) ||
    constraints.bindings.some(([member, snap]) => !members.has(member) || hit.snaps[hit.members.indexOf(member)] !== snap)) return null;

  const snaps = new Set(hit.snaps.filter(snap => snap !== null));
  if (constraints.noSnaps && snaps.size || constraints.requiredSnaps.some(snap => !snaps.has(snap)) ||
    constraints.excludedSnaps.some(snap => snaps.has(snap))) return null;
  const memberRows = request.members.filter(member => members.has(member.key));
  const snapRows = request.snaps.filter(snap => snaps.has(snap.key));
  if (memberRows.length !== members.size || snapRows.length !== snaps.size) return null;

  return {
    ...request, k: 1, seeds: undefined, completed: undefined,
    members: memberRows,
    snaps: snapRows,
    constraints: {
      ...constraints, requiredMembers: [...members], leader,
      bindings: hit.members.map((member, slot) => [member, hit.snaps[slot] ?? null]),
    },
  };
}

export async function acquireSharedEventSeeds(
  request: EventRequest,
  runBatch: PartitionBatch,
  publish: (result: SharedEventSeeds) => void,
  stopped: () => boolean,
  workers: number,
): Promise<SharedEventSeeds> {
  const start = clock(), deadline = deadlineOf(request);
  // Leave the majority of a finite request budget for the actual joint proof or its fallback.
  const scoutDeadline = Number.isFinite(deadline) ? start + Math.max(0, deadline - start) / 3 : deadline;
  const finished = () => stopped() || clock() >= scoutDeadline;
  const scoped: EventRequest = { ...request, deadline: scoutDeadline };
  const plan = request.goal.rewardPlan;
  const level = plan?.levels[0];
  const rawPrimary = request.goal.route === "live" && !request.goal.gekiso && !request.goal.rewardRoom &&
    !request.goal.eventEffects && !request.goal.weights && !request.goal.cpExchange && (plan
      ? plan.criterion === "mean" && plan.minimumRank === undefined && !plan.autoCp &&
        level?.length === 1 && level[0]!.metric === "points" && level[0]!.weight === plan.unit
      : request.goal.measure === "points");
  const goal = rawPrimary
    ? { ...request.goal, ranking: "primary" as const, measure: "points" as const, rewardPlan: undefined }
    : plan ? { ...request.goal, rewardPlan: { ...plan, levels: plan.levels.slice(0, 1) } } : request.goal;

  const charts: ChartState[] = goal.songs.map(song => ({ song, frontier: [], candidates: [] }));
  const byChart = new Map(charts.map(chart => [`${chart.song.songId}:${chart.song.difficulty}`, chart]));
  const stats = pendingSong(null).stats;
  const unknown = new Set<string>();
  const replayed = new Set<string>();
  const depthLimit = Math.min(request.k, MAX_SCOUT_DEPTH);
  const waveSize = Math.max(1, workers);
  let hits: EngineHit[] = [];

  const result = (): SharedEventSeeds => ({ hits, unknownCards: [...unknown], stats: { ...stats } });
  const record = (response: EngineResponse) => {
    if (response.error) throw new Error(response.error);
    for (const card of response.unknownCards) unknown.add(card);
    for (const row of response.results) {
      stats.leaders += row.stats.leaders;
      stats.memberNodes += row.stats.memberNodes;
      stats.snapNodes += row.stats.snapNodes;
      stats.candidates += row.stats.candidates;
      stats.exact += row.stats.exact;
      stats.elapsedMs += row.stats.elapsedMs;
    }
  };

  const acceptJoint = (response: EngineResponse) => {
    if (stopped()) return;
    const complete = response.overall.filter(hit => hit.song === null && hit.event !== null &&
      hit.aggregate?.songs.length === request.goal.songs.length && hit.aggregate.songs.every((chart, index) => sameSong(chart.song, request.goal.songs[index]!)));
    if (!complete.length) return;
    const next = topDistinct([...hits, ...complete], request.k);
    if (next.length === hits.length && next.every((hit, index) => compareHits(hit, hits[index]!) === 0)) return;
    hits = next;
    publish(result());
  };

  const replay = async (candidates: readonly EngineHit[]) => {
    const batch: EngineRequest[] = [];
    for (const hit of candidates) {
      const key = formationKey(hit);
      if (replayed.has(key)) continue;
      replayed.add(key);
      const fixed = fixedSeedRequest(scoped, hit);
      if (fixed) batch.push(fixed);
    }
    if (!batch.length || finished()) return;
    await runBatch(batch, (_index, response) => { record(response); acceptJoint(response); }, acceptJoint);
  };

  const offer = (hit: EngineHit) => {
    if (!hit.song) return;
    const chart = byChart.get(`${hit.song.songId}:${hit.song.difficulty}`);
    if (!chart) return;
    const key = formationKey(hit);
    if (chart.candidates.some(candidate => formationKey(candidate) === key)) return;
    chart.candidates = topDistinct([...chart.candidates, hit], depthLimit);
  };

  const scout = async (jobs: readonly ChartJob[]) => {
    if (!jobs.length || finished()) return;
    await runBatch(jobs.map(({ chart, constraints }) => ({
      ...scoped, goal: { ...goal, songs: [chart.song] }, constraints,
      k: 1, aggregation: undefined, seeds: undefined, completed: undefined,
      rewardPhase: rawPrimary ? { kind: "primary" } : undefined,
    })), (index, response) => {
      record(response);
      const { chart, constraints } = jobs[index]!;
      const row = response.results[0];
      const best = row?.hits[0];
      if (!best) return;
      offer(best);
      if (row.proven) chart.frontier.push({ constraints, best });
    }, response => { for (const hit of response.overall) offer(hit); });
  };

  await replay(request.seeds ?? []);
  for (let first = 0; first < charts.length && !finished(); first += waveSize) {
    const wave = charts.slice(first, first + waveSize);
    await scout(wave.map(chart => ({ chart, constraints: request.constraints })));
    await replay(wave.flatMap(chart => chart.candidates));
  }

  for (let depth = 1; depth < depthLimit && !finished(); depth++) {
    const jobs = charts.flatMap(chart => {
      chart.frontier.sort((a, b) => compareHits(a.best, b.best));
      const parent = chart.frontier.shift();
      return parent ? splitEventPartition(parent).map(constraints => ({ chart, constraints })) : [];
    });
    if (!jobs.length) break;
    await scout(jobs);
    await replay(charts.flatMap(chart => chart.candidates));
  }
  return result();
}
