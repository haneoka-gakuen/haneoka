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
const MIN_SCOUT_DEPTH = 3;
const STAGNANT_SCOUT_DEPTHS = 2;
const sameSong = (left: SongRef | null, right: SongRef) => left?.songId === right.songId && left.difficulty === right.difficulty;
const formationKey = (hit: EngineHit) => JSON.stringify([hit.members, hit.snaps]);
const rosterKey = (hit: EngineHit) => JSON.stringify([...hit.members].sort());

function samePrimary(left: EngineHit | undefined, right: EngineHit): boolean {
  if (!left) return false;
  const a = left.rewardRanking?.[0], b = right.rewardRanking?.[0];
  return a && b
    ? BigInt(a.numerator) * BigInt(b.denominator) === BigInt(b.numerator) * BigInt(a.denominator)
    : left.key === right.key;
}

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
  const jointByRoster = new Map<string, EngineHit>();
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
    if (request.k > 1) {
      for (const hit of complete) {
        const key = rosterKey(hit);
        const known = jointByRoster.get(key);
        if (!known || compareHits(hit, known) < 0) jointByRoster.set(key, hit);
      }
    }
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
    const winners: (EngineHit | undefined)[] = [];
    if (!jobs.length || finished()) return winners;
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
      winners[index] = best;
      offer(best);
      if (row.proven) chart.frontier.push({ constraints, best });
    }, response => { for (const hit of response.overall) offer(hit); });
    return winners;
  };

  const childCandidates = (winners: readonly (EngineHit | undefined)[]): EngineHit[] => {
    const selected = new Map<string, EngineHit>();
    for (const hit of winners) {
      const song = hit?.song;
      if (!hit || !song || replayed.has(formationKey(hit))) continue;
      const key = rosterKey(hit);
      if (selected.has(key)) continue;
      const known = jointByRoster.get(key)?.aggregate?.songs.find(chart => sameSong(chart.song, song));
      const knownPrimary = rawPrimary ? known?.event?.rewardValues?.points.value
        : known?.rewardRanking?.[0]?.value ?? known?.key;
      const primary = hit.rewardRanking?.[0]?.value ?? hit.key;
      if (knownPrimary === undefined || primary > knownPrimary) selected.set(key, hit);
    }
    return [...selected.values()];
  };

  await replay(request.seeds ?? []);
  for (let first = 0; first < charts.length && !finished(); first += waveSize) {
    const wave = charts.slice(first, first + waveSize);
    const nativeWinners = await scout(wave.map(chart => ({ chart, constraints: request.constraints })));
    if (request.k === 1) {
      await replay(wave.flatMap(chart => chart.candidates));
      continue;
    }
    const winners = nativeWinners.filter(hit => hit !== undefined);
    const seen = new Set([...jointByRoster.keys(), ...winners.map(rosterKey)]);
    const alternates: EngineHit[] = [];
    for (const chart of wave) {
      const alternate = chart.candidates.find(hit => !seen.has(rosterKey(hit)) && !replayed.has(formationKey(hit)));
      if (alternate) {
        seen.add(rosterKey(alternate));
        alternates.push(alternate);
      }
    }
    await replay([...winners, ...alternates]);
  }

  let previousFloor = hits[request.k - 1];
  let stagnantDepths = 0;
  for (let depth = 1; depth < depthLimit && !finished(); depth++) {
    const jobs = charts.flatMap(chart => {
      chart.frontier.sort((a, b) => compareHits(a.best, b.best));
      const parent = chart.frontier.shift();
      return parent ? splitEventPartition(parent).map(constraints => ({ chart, constraints })) : [];
    });
    if (!jobs.length) break;
    await replay(childCandidates(await scout(jobs)));
    if (hits.length < request.k && depth === 1) {
      const deferred = childCandidates(charts.flatMap(chart => chart.candidates));
      await replay(deferred.slice(0, Math.max(waveSize, request.k - hits.length)));
    }
    const floor = hits[request.k - 1];
    stagnantDepths = floor && samePrimary(previousFloor, floor) ? stagnantDepths + 1 : 0;
    if (depth >= MIN_SCOUT_DEPTH && stagnantDepths >= STAGNANT_SCOUT_DEPTHS) break;
    previousFloor = floor;
  }
  return result();
}
