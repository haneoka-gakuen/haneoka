// L3 — GEB
// Input: An ordinary shared live goal, certified roster ceilings, and feasible joint candidates.
// Output: Distinct rosters with proven joint reward ranks, or an incomplete proof for the native fallback.
// Pos: [Map](L2-2.md); EngineClient shared-event proof.
// Effects/Dependencies: Reuses the request's Worker pool, deadlines and cancellation for native chart and joint searches.
import type { ConstraintInput, EngineHit, EngineRequest, EngineResponse, Goal, RewardFraction, RewardRankingPlan, SongResult } from "./api";
import { chartKey } from "./charts";
import type { PartitionBatch } from "./event-partitions";
import { clock } from "./execution";
import { compareHitRank, compareHits, topDistinct } from "./merge";
import type { SharedEventRosterCandidate } from "./shared-event-rosters";

type EventRequest = EngineRequest & { goal: Extract<Goal, { kind: "event" }> };
type Fraction = readonly [numerator: bigint, denominator: bigint];
type Rank = readonly Fraction[];
type Formation = Pick<EngineHit, "members" | "snaps">;
type Submit = (request: EventRequest) => Promise<SongResult | undefined>;

function gcd(numerator: bigint, denominator: bigint): bigint {
  while (denominator) [numerator, denominator] = [denominator, numerator % denominator];
  return numerator < 0n ? -numerator : numerator;
}

function fraction(value: RewardFraction): Fraction {
  return [BigInt(value.numerator), BigInt(value.denominator)];
}

function rank(hit: EngineHit, levels: number): Rank | undefined {
  return hit.rewardRanking?.length === levels ? hit.rewardRanking.map(fraction) : undefined;
}

function rankLength(plan: RewardRankingPlan): number {
  return plan.levels.length + (plan.tieBreak === "score" ? 2 : plan.tieBreak === "power" ? 1 : 0);
}

function compare(left: Rank, right: Rank): number {
  for (let index = 0; index < left.length; index++) {
    const [n, d] = left[index]!;
    const [m, e] = right[index]!;
    const difference = n * e - m * d;
    if (difference) return difference > 0n ? 1 : -1;
  }
  return 0;
}

function mean(values: readonly Fraction[]): Fraction {
  let n = 0n, d = 1n;
  for (const [m, e] of values) {
    n = n * e + m * d;
    d *= e;
    const divisor = gcd(n, d);
    n /= divisor;
    d /= divisor;
  }
  return [n, d * BigInt(values.length)];
}

function meanRank(values: readonly Rank[]): Rank {
  const length = Math.min(...values.map(value => value.length));
  return Array.from({ length }, (_, index) => mean(values.map(value => value[index]!)));
}
const rosterKey = (members: readonly string[]): string => JSON.stringify([...members].sort());
const formationKey = ({ members, snaps }: Formation): string => JSON.stringify([members, snaps]);
const exactKey = (tuple: Rank): string => tuple.map(([n, d]) => {
  const divisor = gcd(n, d);
  return `${n / divisor}/${d / divisor}`;
}).join("|");

function allowed(team: Formation, constraints: ConstraintInput): boolean {
  return (!constraints.leader || team.members[0] === constraints.leader) &&
    constraints.requiredMembers.every(member => team.members.includes(member)) &&
    !constraints.excludedMembers.some(member => team.members.includes(member)) &&
    (!constraints.noSnaps || team.snaps.every(snap => snap === null)) &&
    constraints.requiredSnaps.every(snap => team.snaps.includes(snap)) &&
    !constraints.excludedSnaps.some(snap => team.snaps.includes(snap)) &&
    constraints.bindings.every(([member, snap]) => team.snaps[team.members.indexOf(member)] === snap);
}

function fixed(request: EventRequest, team: Formation): EventRequest {
  return { ...request, snaps: request.snaps.filter(snap => team.snaps.includes(snap.key)), constraints: {
    ...request.constraints, leader: team.members[0]!,
    bindings: team.members.map((member, slot) => [member, team.snaps[slot]!]),
  } };
}

function batchJobs(
  runBatch: PartitionBatch,
  stopped: () => boolean,
  receive: (response: EngineResponse, request: EventRequest) => SongResult | undefined,
) {
  const pending: { request: EventRequest; resolve: (value?: SongResult) => void }[] = [];
  let active: Promise<void> | undefined;
  let failed = false;
  const drain = async () => {
    try {
      while (pending.length && !stopped() && !failed) {
        const jobs = pending.splice(0, 18);
        try {
          await runBatch(jobs.map(job => job.request), (index, response) => {
            if (stopped()) return;
            const job = jobs[index]!;
            job.resolve(receive(response, job.request));
          }, () => {}, { stopped });
        } catch {
          failed = true;
        } finally {
          for (const job of jobs) job.resolve();
        }
      }
    } finally {
      active = undefined;
      for (const job of pending.splice(0)) job.resolve();
    }
  };
  const submit: Submit = request => new Promise(resolve => {
    if (failed || stopped()) { resolve(undefined); return; }
    pending.push({ request, resolve });
    active ??= Promise.resolve().then(drain);
  });
  return { submit, settled: async () => { await active; } };
}

interface ChartProof { rank: Rank; hit: EngineHit }

async function proveRoster(
  request: EventRequest, candidate: SharedEventRosterCandidate, initial: EngineHit | undefined, submit: Submit,
  cutoff: () => Rank, offer: (hit: EngineHit) => void, stopped: () => boolean,
): Promise<EngineHit | null | undefined> {
  const plan = request.goal.rewardPlan!;
  const levels = rankLength(plan);
  const rewardLevels = plan.levels.length;
  const prefixPlan = plan.tieBreak ? { ...plan, tieBreak: undefined } : plan;
  const songs = request.goal.songs;
  const key = rosterKey(candidate.members);
  const members = request.members.filter(member => candidate.members.includes(member.key));
  if (members.length !== 5 || candidate.chartPoints.length !== songs.length ||
      request.constraints.requiredMembers.some(member => !candidate.members.includes(member))) return undefined;
  const base: EventRequest = { ...request, members, k: 1, seeds: undefined, completed: undefined, constraints: {
    ...request.constraints, requiredMembers: candidate.members,
  } };
  const points = candidate.chartPoints.map(fraction);
  const chartOrder = songs.map((_, index) => index).sort((a, b) => compare([points[b]!], [points[a]!]));
  const impossible = () => compare([mean(points)], cutoff().slice(0, 1)) < 0;
  const charts = (scope: EventRequest, indexes: readonly number[], chartPlan: RewardRankingPlan,
    seeds?: readonly (EngineHit | undefined)[]) => Promise.all(indexes.map(index => submit({
    ...scope, aggregation: undefined, seeds: seeds?.[index] ? [seeds[index]!] : undefined,
    goal: { ...scope.goal, songs: [songs[index]!], rewardPlan: chartPlan },
  })));

  const early = !plan.tieBreak && rewardLevels > 1 ? chartOrder.slice(0, Math.min(8, Math.floor(songs.length / 3))) : [];
  const primaryPlan = { ...prefixPlan, levels: plan.levels.slice(0, 1) };
  while (early.length && !impossible()) {
    const indexes = early.splice(0, 2);
    const results = await charts(base, indexes, primaryPlan);
    for (const [position, result] of results.entries()) {
      if (!result?.proven) return undefined;
      const hit = result.hits[0];
      if (!hit) return null;
      const value = rank(hit, 1);
      const index = indexes[position]!;
      if (!value || compare(value, [points[index]!]) > 0) return undefined;
      points[index] = value[0]!;
    }
  }

  const chartProofs: ChartProof[] = [];
  const known = songs.map(() => new Map<string, Map<string, EngineHit>>());
  const remember = (index: number, value: Rank, hit: EngineHit) => {
    const keys = value.length > rewardLevels ? [exactKey(value), exactKey(value.slice(0, rewardLevels))] : [exactKey(value)];
    for (const key of keys) {
      const teams = known[index]!.get(key) ?? new Map<string, EngineHit>();
      teams.set(formationKey(hit), hit);
      known[index]!.set(key, teams);
    }
  };
  while (chartOrder.length && !impossible()) {
    const indexes = chartOrder.splice(0, 3);
    const results = await charts(base, indexes, prefixPlan);
    for (const [position, result] of results.entries()) {
      if (!result?.proven) return undefined;
      const hit = result.hits[0];
      if (!hit) return null;
      const value = rank(hit, rewardLevels);
      const index = indexes[position]!;
      if (!value || compare(value.slice(0, 1), [points[index]!]) > 0) return undefined;
      points[index] = value[0]!;
      chartProofs[index] = { rank: value, hit };
      remember(index, value, hit);
    }
  }
  if (impossible()) return null;
  const roof = meanRank(chartProofs.map(chart => chart.rank));
  if (compare(roof, cutoff()) < 0) return null;

  let best = initial;
  const scored = new Set<string>();
  function consider(hit: EngineHit): boolean {
    const value = rank(hit, levels);
    if (rosterKey(hit.members) !== key || !allowed(hit, base.constraints) || !value ||
        compare(value.slice(0, roof.length), roof) > 0 || hit.aggregate?.songs.length !== songs.length) return false;
    for (const [index, chart] of hit.aggregate.songs.entries()) {
      const value = rank(chart, levels);
      if (!value || !chart.song || chartKey(chart.song) !== chartKey(songs[index]!)) return false;
      remember(index, value, chart);
    }
    scored.add(formationKey(hit));
    if (!best || compareHits(hit, best) < 0) { best = hit; offer(hit); }
    return true;
  }
  if (initial && !consider(initial)) return undefined;
  const closes = (value: Rank) => {
    if (compare(value, cutoff()) < 0) return true;
    if (!best) return false;
    const comparison = compare(value, rank(best, levels)!);
    return comparison < 0 || comparison === 0 && value.length === levels;
  };

  async function tighten(scope: EventRequest, bounds: Rank[], chartPlan: RewardRankingPlan,
    seeds?: readonly (EngineHit | undefined)[]): Promise<(EngineHit | undefined)[] | null | undefined> {
    const size = rankLength(chartPlan);
    const winners = bounds.map((value, index) => value.length < size ? undefined :
      [...(known[index]!.get(exactKey(value.slice(0, size)))?.values() ?? [])]
        .find(hit => allowed(hit, scope.constraints)));
    const missing = songs.map((_, index) => index).filter(index => !winners[index]);
    missing.sort((a, b) => compare(bounds[b]!.slice(0, rewardLevels), bounds[a]!.slice(0, rewardLevels)));
    while (missing.length && !closes(meanRank(bounds))) {
      const indexes = missing.splice(0, 3);
      const results = await charts(scope, indexes, chartPlan, seeds);
      for (const [position, result] of results.entries()) {
        if (!result?.proven) return undefined;
        const hit = result.hits[0];
        if (!hit) return null;
        const index = indexes[position]!;
        const value = rank(hit, size);
        if (!value) return undefined;
        const prior = bounds[index]!;
        const length = Math.min(value.length, prior.length);
        const comparison = compare(value.slice(0, length), prior.slice(0, length));
        if (comparison > 0) return undefined;
        if (comparison < 0 || value.length >= prior.length) bounds[index] = value;
        winners[index] = hit;
        remember(index, value, hit);
      }
    }
    return winners;
  }

  async function replay(teams: readonly Formation[]): Promise<boolean> {
    const unique = new Map<string, { team: Formation; count: number }>();
    for (const team of teams) {
      const id = formationKey(team);
      const candidate = unique.get(id) ?? { team, count: 0 };
      candidate.count++;
      unique.set(id, candidate);
    }
    const chosen = [...unique.values()].filter(({ team }) => !scored.has(formationKey(team)) &&
      rosterKey(team.members) === key && allowed(team, base.constraints))
      .sort((a, b) => b.count - a.count || formationKey(a.team).localeCompare(formationKey(b.team))).slice(0, 4);
    const results = await Promise.all(chosen.map(({ team }) => submit(fixed(base, team))));
    return results.every(result => result?.proven && result.hits.length === 1 && consider(result.hits[0]!));
  }
  if (!closes(roof) && !await replay([...chartProofs.map(chart => chart.hit), ...candidate.seeds])) return undefined;

  const leaders = base.constraints.leader ? [base.constraints.leader] : candidate.members;
  const pending = leaders.map(leader => ({ constraints: { ...base.constraints, leader }, bounds: chartProofs.map(chart => chart.rank), depth: 0 }));
  while (pending.length && !closes(roof)) {
    if (stopped()) return undefined;
    const { constraints, bounds, depth } = pending.shift()!;
    if (closes(meanRank(bounds))) continue;
    const required = new Set([...constraints.requiredSnaps, ...constraints.bindings.flatMap(([, snap]) => snap === null ? [] : [snap])]);
    const emptySlots = constraints.bindings.filter(([, snap]) => snap === null).length;
    if (required.size + emptySlots > 5) continue;
    const available = base.snaps.filter(snap => !constraints.excludedSnaps.includes(snap.key));
    const locked = constraints.noSnaps || required.size + emptySlots === 5;
    const snaps = locked ? available.filter(snap => required.has(snap.key)) : available;
    const scope = { ...base, snaps, constraints };
    if (locked || snaps.every(snap => required.has(snap.key))) {
      const result = await submit(scope);
      if (!result?.proven || result.hits.some(hit => !consider(hit))) return undefined;
      continue;
    }

    let winners = await tighten(scope, bounds, prefixPlan);
    if (winners === undefined) return undefined;
    if (winners === null || closes(meanRank(bounds))) continue;
    // Equal reward ceilings can still contain a better score or power. Narrow a tied leader's
    // first snapshot domain before paying for those tie-breaks.
    const narrowTies = depth === 0 && compare(meanRank(bounds), cutoff()) === 0;
    if (plan.tieBreak && !narrowTies) {
      winners = await tighten(scope, bounds, plan, winners);
      if (winners === undefined) return undefined;
      if (winners === null || closes(meanRank(bounds))) continue;
    }
    const knownWinners = winners.filter((hit): hit is EngineHit => !!hit);
    if (!await replay(knownWinners)) return undefined;
    if (closes(meanRank(bounds))) continue;

    const counts = new Map<string, number>();
    for (const team of knownWinners) for (const snap of team.snaps) {
      if (snap !== null && !required.has(snap) && !constraints.excludedSnaps.includes(snap))
        counts.set(snap, (counts.get(snap) ?? 0) + 1);
    }
    const split = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0]
      ?? snaps.find(snap => !required.has(snap.key))!.key;
    // Presence and absence of this snapshot cover the entire current domain.
    pending.unshift({ constraints: { ...constraints, requiredSnaps: [...constraints.requiredSnaps, split] }, bounds: [...bounds], depth: depth + 1 },
      { constraints: { ...constraints, excludedSnaps: [...constraints.excludedSnaps, split] }, bounds: [...bounds], depth: depth + 1 });
  }
  return best ?? null;
}

interface SnapshotProofOptions {
  request: EventRequest;
  rosters: readonly SharedEventRosterCandidate[];
  initial: EngineResponse;
  outside?: RewardFraction;
  runBatch: PartitionBatch;
  stopped: () => boolean;
  publish: (response: EngineResponse) => void;
}

export async function proveSharedEventSnapshots({
  request, rosters, initial, outside, runBatch, stopped, publish,
}: SnapshotProofOptions): Promise<EngineResponse | undefined> {
  const base = initial.results[0];
  const plan = request.goal.rewardPlan;
  if (!base || !plan) return undefined;
  const levels = rankLength(plan);
  const started = clock();
  const stats = { ...base.stats };
  const unknownCards = new Set(initial.unknownCards);
  let hits = topDistinct(initial.overall, request.k);
  if (hits.length !== request.k || hits.some(hit => hit.song !== null || !rank(hit, levels)) ||
      outside && compare([fraction(outside)], rank(hits.at(-1)!, levels)!.slice(0, 1)) >= 0) return undefined;
  const initialByRoster = new Map(hits.map(hit => [rosterKey(hit.members), hit]));
  const covered = new Set(rosters.map(candidate => rosterKey(candidate.members)));
  if (covered.size !== rosters.length || [...initialByRoster.keys()].some(key => !covered.has(key))) return undefined;

  let incomplete = false;
  const proofStopped = () => incomplete || stopped();
  const response = (rows: EngineHit[], proven: boolean): EngineResponse => ({
    ...initial, stopReason: proven ? "complete" : undefined, elapsedMs: initial.elapsedMs + clock() - started,
    overall: rows, unknownCards: [...unknownCards],
    results: [{ ...base, song: null, hits: rows, proven, bound: proven ? null : base.bound, stats: { ...stats } }],
  });
  const cutoff = () => rank(hits.at(-1)!, levels)!;
  const offer = (hit: EngineHit) => {
    if (proofStopped()) return;
    const next = topDistinct([...hits, hit], request.k);
    if (next.some((value, index) => value !== hits[index])) {
      hits = next;
      publish(response(hits, false));
    }
  };
  const { submit, settled } = batchJobs(runBatch, proofStopped, (result, job) => {
    const row = result.results[0];
    if (result.error || result.results.length !== 1 || !row?.proven ||
        (job.aggregation === "mean" ? row.song !== null : !row.song || chartKey(row.song) !== chartKey(job.goal.songs[0]!))) {
      incomplete = true;
      return undefined;
    }
    for (const key of result.unknownCards) unknownCards.add(key);
    for (const key of Object.keys(row.stats) as (keyof SongResult["stats"])[])
      stats[key] = (stats[key] ?? 0) + (row.stats[key] ?? 0);
    return row;
  });

  const candidates = [...rosters].sort((a, b) => compare([fraction(b.primary)], [fraction(a.primary)]));
  const proven: EngineHit[] = [];
  let next = 0;
  const lane = async () => {
    try {
      while (next < candidates.length && !proofStopped()) {
        const candidate = candidates[next++]!;
        if (compare([fraction(candidate.primary)], cutoff().slice(0, 1)) < 0) continue;
        const result = await proveRoster(request, candidate, initialByRoster.get(rosterKey(candidate.members)), submit, cutoff, offer, proofStopped);
        if (result === undefined) incomplete = true;
        else if (result) proven.push(result);
      }
    } catch (error) {
      incomplete = true;
      throw error;
    }
  };
  const lanes = await Promise.allSettled(Array.from({ length: Math.min(12, candidates.length) }, lane));
  await settled();
  const rejected = lanes.find(result => result.status === "rejected");
  if (rejected) throw rejected.reason;
  if (proofStopped()) return undefined;
  proven.sort(compareHits);
  if (proven.length < request.k || compareHitRank(proven[request.k - 1]!, hits.at(-1)!) > 0) return undefined;
  // Equal reward tuples across member sets also depend on the native formation tie-break.
  for (let index = 1; index < Math.min(request.k + 1, proven.length); index++)
    if (compareHitRank(proven[index - 1]!, proven[index]!) === 0) return undefined;
  return response(proven.slice(0, request.k), true);
}
