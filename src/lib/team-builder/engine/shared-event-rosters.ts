// Input: A joint ordinary-live PT plan, release data and a feasible rank threshold.
// Output: Fixed member sets that can reach the threshold, with exact per-chart PT bounds.
// Pos: [Map](L2-2.md); first stage of the shared event proof in EngineClient.
// Effects/Dependencies: Batches native score and primary reward proofs under the parent deadline.
import { dataRows, nativeRow, objectRow, type TeamBuilderData } from "../data";
import type { ConstraintInput, EngineHit, EngineRequest, EngineResponse, Goal, RewardFraction, SongRef, SongResult } from "./api";
import { chartKey } from "./charts";
import type { PartitionBatch } from "./event-partitions";
import { pendingSong } from "./execution";
import { ORDERS } from "./order-equivalence";

type SharedRequest = EngineRequest & { goal: Extract<Goal, { kind: "event" }> };
type Stats = SongResult["stats"];
type BonusMember = { key: string; character: number; bonus: number };
type Witness = { hit: EngineHit; points: number };
interface Domain {
  constraints: ConstraintInput;
  bounds: number[];
  witnesses: (Witness | undefined)[];
  total: number;
  queries: number;
}
export interface SharedEventRosterCandidate {
  members: string[];
  seeds: EngineHit[];
  chartPoints: RewardFraction[];
  primary: RewardFraction;
}
export interface SharedEventRosterProof {
  candidates: SharedEventRosterCandidate[];
  outside: RewardFraction;
  stats: Stats;
  unknownCards: string[];
}

const teamSize = 5;
const orders = ORDERS.length;
const intMax = 2_147_483_647;
const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);
const memberSet = (members: readonly string[]) => JSON.stringify([...members].sort());
const isInt = (value: unknown, min = 0): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= min && value <= intMax;
const forcedMembers = (constraints: ConstraintInput) => new Set([
  ...constraints.requiredMembers, ...constraints.bindings.map(([member]) => member),
  ...(constraints.leader === null ? [] : [constraints.leader]),
]);

function isSharedRequest(data: TeamBuilderData, request: EngineRequest): request is SharedRequest {
  const { goal } = request;
  if (goal.kind !== "event" || goal.route !== "live" || goal.measure !== "points" || goal.ranking === "pt-only" ||
      goal.gekiso || goal.rewardRoom || goal.eventEffects || goal.weights || goal.cpExchange ||
      request.aggregation !== "mean" || goal.songs.length < 2 || new Set(goal.songs.map(chartKey)).size !== goal.songs.length ||
      request.songRules || request.shard || request.noFloor || request.seedOnly || request.seedVariant || request.seeded ||
      request.rewardPhase || request.rewardLexicographic || request.rewardIncumbent || request.resolveRewardPlan ||
      request.floors || request.cutoff || request.rewardCutoff !== undefined || request.completed?.length) return false;
  const plan = goal.rewardPlan;
  const primary = plan?.levels[0];
  const play = goal.play;
  const event = data.events[goal.eventId];
  return !!plan && (plan.criterion === undefined || plan.criterion === "mean") && plan.minimumRank === undefined && !plan.autoCp &&
    primary?.length === 1 && primary[0]!.metric === "points" &&
    primary[0]!.weight === plan.unit && isInt(plan.unit, 1) && plan.unit <= 1_000_000_000 &&
    Number.isFinite(request.constraints.minBonusPercent ?? 0) &&
    play.great === 0 && play.good === 0 && play.bad === 0 && play.miss === 0 && !play.missEvery && !play.cumulativeTiming &&
    !!event && Number(event.id) === goal.eventId && Array.isArray(event.effects) &&
    dataRows(objectRow(event.tables).MasterLiveEventPoint).length > 0;
}

function rosterModel(data: TeamBuilderData, request: SharedRequest) {
  const { goal } = request;
  const event = data.events[goal.eventId]!;
  const effects = [];
  for (const row of dataRows(event.effects).map(nativeRow)) {
    const type = row.eventBonusType ?? 0;
    if (!isInt(type)) return null;
    if (type !== 0) continue;
    const { resourceTypeConstraint } = row;
    const characterId = row.characterId ?? 0, bandId = row.bandId ?? 0, cardType = row.cardType ?? 0;
    const tagId = row.tagId ?? 0, memberCardId = row.memberCardId ?? 0;
    if (resourceTypeConstraint !== 2 || !isInt(characterId) || !isInt(bandId) ||
        !isInt(cardType) || !isInt(tagId) || !isInt(memberCardId)) return null;
    const values = new Map<number, number>();
    if (!Array.isArray(row.perRank)) return null;
    for (const { rank, value } of dataRows(row.perRank)) {
      if (!isInt(rank, 1) || rank > teamSize || !isInt(value) || values.has(rank)) return null;
      values.set(rank, value);
    }
    effects.push({ characterId, bandId, cardType, tagId, memberCardId, values });
  }

  const rankCaps = new Map<number, number>();
  for (const { group, rank } of dataRows(data.progression.memberCardRanks).map(nativeRow)) {
    if (!isInt(group) || !isInt(rank, 1)) return null;
    rankCaps.set(group, Math.max(rankCaps.get(group) ?? 1, rank));
  }
  const cards = new Map<number, TeamBuilderData["members"][string]>();
  for (const card of Object.values(data.members)) {
    if (!isInt(card.id, 1) || cards.has(card.id)) return null;
    cards.set(card.id, card);
  }
  const members = new Map<string, BonusMember>();
  const byCharacter = new Map<number, BonusMember[]>();
  for (const source of request.members) {
    const card = cards.get(source.cardId);
    if (!card || !isInt(card.characterId, 1) || !isInt(card.bandId) || !isInt(card.attribute) ||
        !isInt(card.awakeningGroup) || members.has(source.key) || (source.rank != null && !isInt(source.rank, 1)) ||
        card.bestMusicTagIds?.some(id => !isInt(id, 1))) return null;
    const cap = rankCaps.get(card.awakeningGroup) ?? 1;
    const maximize = (source as typeof source & { maximize?: boolean }).maximize === true;
    const rank = Math.min(maximize ? cap : source.rank ?? (request.unknownPolicy === "min" ? 1 : cap), cap);
    let bonus = 0;
    for (const effect of effects) {
      if ((effect.characterId && effect.characterId !== card.characterId) || (effect.bandId && effect.bandId !== card.bandId) ||
          (effect.cardType && effect.cardType !== card.attribute) || (effect.tagId && !card.bestMusicTagIds?.includes(effect.tagId)) ||
          (effect.memberCardId && effect.memberCardId !== card.id)) continue;
      bonus += effect.values.get(rank) ?? 0;
    }
    if (!isInt(bonus)) return null;
    const member = { key: source.key, character: card.characterId, bonus };
    members.set(source.key, member);
    let options = byCharacter.get(card.characterId);
    if (!options) byCharacter.set(card.characterId, options = []);
    options.push(member);
  }
  for (const options of byCharacter.values()) options.sort((a, b) => b.bonus - a.bonus);

  const points: { scoreRank: number; value: number }[] = [];
  // Using every point group is conservative even when native settlement selects a single group.
  for (const { scoreRank, value } of dataRows(objectRow(event.tables).MasterLiveEventPoint).map(nativeRow)) {
    if (!isInt(scoreRank) || !isInt(value)) return null;
    points.push({ scoreRank, value });
  }
  if (!isInt(goal.consumption)) return null;
  const boost = dataRows(data.liveTools.liveBoostBonuses).map(nativeRow).find(row => row.consumedLiveBoostCount === goal.consumption);
  const rate = goal.consumption === 0 ? 1 : boost?.eventPointRate;
  if (!isInt(rate, 1)) return null;

  const ranks = new Map<number, { rank: number; required: number }[]>();
  for (const { group, liveScoreRank, requiredScore } of dataRows(data.liveTools.scoreRanks).map(nativeRow)) {
    if (!isInt(group) || !isInt(liveScoreRank) || !isInt(requiredScore)) return null;
    let rows = ranks.get(group);
    if (!rows) ranks.set(group, rows = []);
    rows.push({ rank: liveScoreRank, required: requiredScore });
  }
  const chartRanks = goal.songs.map(({ songId }) => {
    const song = data.songs[songId];
    return song?.musicId === songId && isInt(song.liveScoreRankGroup) ? ranks.get(song.liveScoreRankGroup) : undefined;
  });
  if (chartRanks.some(rows => !rows?.length)) return null;

  function domainBonus(constraints: ConstraintInput, fixed: ReadonlySet<string>): number | null {
    if (fixed.size > teamSize) return null;
    const excluded = new Set(constraints.excludedMembers);
    const characters = new Set<number>();
    let bonus = 0;
    for (const key of fixed) {
      const member = members.get(key);
      if (!member || excluded.has(key) || characters.has(member.character)) return null;
      characters.add(member.character);
      bonus += member.bonus;
    }
    const needed = teamSize - fixed.size;
    if (!needed) return bonus;
    const optional: number[] = [];
    for (const [character, options] of byCharacter) {
      if (characters.has(character)) continue;
      const best = options.find(member => !excluded.has(member.key));
      if (best) optional.push(best.bonus);
    }
    return optional.length < needed ? null : bonus + sum(optional.sort((a, b) => b - a).slice(0, needed));
  }
  const basePoints = (chart: number, maxScore: number) => {
    const maxRank = chartRanks[chart]!.reduce((best, row) => row.required <= maxScore ? Math.max(best, row.rank) : best, 2);
    return points.reduce((best, row) => row.scoreRank <= maxRank ? Math.max(best, row.value) : best, 0);
  };
  const rosterBonus = (keys: readonly string[]) => sum(keys.map(key => members.get(key)?.bonus ?? NaN));
  return { domainBonus, basePoints, rate, rosterBonus };
}

export function canUseSharedEventRosters(data: TeamBuilderData, request: EngineRequest): request is SharedRequest {
  return isSharedRequest(data, request) && rosterModel(data, request) !== null;
}

function completedRow(response: EngineResponse | undefined, song: SongRef, phase?: "primary") {
  if (!response || response.error || (response.stopReason != null && response.stopReason !== "complete") || response.results.length !== 1) return null;
  const row = response.results[0]!;
  return row.proven && row.rewardPhase === phase && row.song && chartKey(row.song) === chartKey(song) && row.hits.length <= 1 ? row : null;
}

function contains(constraints: ConstraintInput, hit: EngineHit): boolean {
  return hit.members.length === teamSize && new Set(hit.members).size === teamSize &&
    (constraints.leader === null || constraints.leader === hit.members[0]) &&
    [...forcedMembers(constraints)].every(key => hit.members.includes(key)) &&
    constraints.excludedMembers.every(key => !hit.members.includes(key));
}

function split(constraints: ConstraintInput, fixed: ReadonlySet<string>, hit: EngineHit): ConstraintInput[] {
  const required = [...constraints.requiredMembers];
  const scopes: ConstraintInput[] = [];
  // The first absent member identifies a unique complement domain; the last domain fixes the winning roster.
  for (const member of [...hit.members].sort()) {
    if (fixed.has(member)) continue;
    scopes.push({ ...constraints, requiredMembers: [...required], excludedMembers: [...constraints.excludedMembers, member] });
    required.push(member);
  }
  scopes.push({ ...constraints, requiredMembers: required });
  return scopes;
}

const floorValue = new Float64Array(1);
const floorBits = new BigUint64Array(floorValue.buffer);
function inclusiveFloor(points: number): number {
  // The native floor is binary64 and may only rule out values strictly below this integer sum.
  floorValue[0] = points / orders;
  floorBits[0] = floorBits[0]! - 1n;
  return floorValue[0]!;
}

function pointSum(hit: EngineHit): number | null {
  if (hit.score?.orders.length !== orders) return null;
  const points = Math.round(hit.key * orders);
  const normalized = points / orders;
  return Number.isSafeInteger(points) && points >= 0 &&
    Math.abs(hit.key - normalized) <= 4 * Number.EPSILON * Math.max(1, normalized) ? points : null;
}

export async function proveSharedEventRosters(
  data: TeamBuilderData,
  request: EngineRequest,
  floor: RewardFraction,
  workerCount: number,
  runBatch: PartitionBatch,
  stopped: () => boolean,
): Promise<SharedEventRosterProof | null> {
  if (!isSharedRequest(data, request) || stopped() || !Number.isInteger(workerCount) || workerCount < 1 ||
      !/^\d+$/u.test(floor.numerator) || !/^\d+$/u.test(floor.denominator)) return null;
  const { goal } = request;
  const songs = goal.songs;
  const model = rosterModel(data, request);
  if (!model) return null;
  const observations = orders * songs.length;
  const weight = BigInt(goal.rewardPlan!.unit);
  const n = BigInt(floor.numerator) * BigInt(observations);
  const d = BigInt(floor.denominator) * weight;
  if (n <= 0n || d <= 0n || n % d !== 0n) return null;
  const threshold = Number(n / d);
  const overallBonus = model.domainBonus(request.constraints, forcedMembers(request.constraints));
  if (!Number.isSafeInteger(threshold) || overallBonus === null || overallBonus > intMax - 10_000) return null;

  const stats = pendingSong(null).stats;
  const unknown = new Set<string>();
  const fraction = (points: number, count: number): RewardFraction => {
    const numerator = BigInt(points) * weight;
    return { numerator: String(numerator), denominator: String(count), value: Number(numerator) / count };
  };
  const native = async (jobs: EngineRequest[]) => {
    const rows: EngineResponse[] = [];
    await runBatch(jobs, (index, response) => {
      rows[index] = response;
      for (const card of response.unknownCards) unknown.add(card);
      for (const { stats: row } of response.results) {
        stats.leaders += row.leaders;
        stats.memberNodes += row.memberNodes;
        stats.snapNodes += row.snapNodes;
        stats.candidates += row.candidates;
        stats.exact += row.exact;
        stats.elapsedMs += row.elapsedMs;
      }
    }, () => {});
    return rows;
  };
  const subrequest: EngineRequest = { ...request, k: 1, aggregation: undefined, completed: undefined, seeds: undefined };
  // Score has no event bonus. Removing that condition only enlarges the score cap search.
  const scoreRows = await native(songs.map(song => ({
    ...subrequest, constraints: { ...request.constraints, minBonusPercent: null },
    goal: { kind: "score", songs: [song], criterion: "max", challengeEventId: null, play: goal.play },
  })));
  if (stopped()) return null;
  const basePoints: number[] = [];
  for (const [index, song] of songs.entries()) {
    const row = completedRow(scoreRows[index], song);
    const score = row?.hits[0]?.score;
    if (!score || !Number.isFinite(score.max) || score.orders.length !== orders) return null;
    const points = model.basePoints(index, score.max);
    if (BigInt(points) * BigInt(model.rate) * BigInt(10_000 + overallBonus) > BigInt(intMax)) return null;
    basePoints.push(points);
  }

  const cap = (chart: number, bonus: number) => Math.floor(basePoints[chart]! * model.rate * (10_000 + bonus) / 10_000) * orders;
  const atBonus = (bonus: number) => sum(basePoints.map((_, index) => cap(index, bonus)));
  let minBonus = Math.max(0, Math.floor((request.constraints.minBonusPercent ?? 0) * 100 + 0.5));
  let high = overallBonus;
  const maximum = atBonus(high);
  if (minBonus > high || !Number.isSafeInteger(maximum) || maximum < threshold) return null;
  // Any roster below this bonus is already below the feasible rank threshold, on the score-capped charts.
  while (minBonus < high) {
    const mid = Math.floor((minBonus + high) / 2);
    if (atBonus(mid) < threshold) minBonus = mid + 1;
    else high = mid;
  }

  const candidates: SharedEventRosterCandidate[] = [];
  const pending: Domain[] = [];
  const fallback: (number | undefined)[] = [];
  const enqueue = (constraints: ConstraintInput, parent?: Domain): boolean => {
    const bonus = model.domainBonus(constraints, forcedMembers(constraints));
    if (bonus === null || bonus < minBonus) return true;
    const bounds = songs.map((_, index) => Math.min(parent?.bounds[index] ?? Infinity, cap(index, bonus)));
    const total = sum(bounds);
    if (total < threshold) return true;
    const witnesses = songs.map((_, index) => {
      const witness = parent?.witnesses[index];
      return witness && contains(constraints, witness.hit) ? witness : undefined;
    });
    if (witnesses.some((witness, index) => witness && witness.points !== bounds[index])) return false;
    pending.push({ constraints, bounds, total, witnesses, queries: 0 });
    return true;
  };

  if (!enqueue({ ...request.constraints, minBonusPercent: minBonus / 100 })) return null;
  const rawGoal = { ...goal, ranking: "primary" as const, rewardPlan: undefined };
  while (pending.length && !stopped()) {
    pending.sort((a, b) => b.total - a.total || b.constraints.requiredMembers.length - a.constraints.requiredMembers.length);
    const jobs: { domain: Domain; chart: number; target: number }[] = [];
    while (pending.length && jobs.length < workerCount && !stopped()) {
      const domain = pending.shift()!;
      const fixed = forcedMembers(domain.constraints);
      if (fixed.size === teamSize) {
        const seeds = new Map<string, EngineHit>();
        for (const witness of domain.witnesses) if (witness) {
          const { hit } = witness;
          seeds.set(JSON.stringify([hit.members, hit.snaps]), hit);
        }
        candidates.push({ members: [...fixed].sort(), seeds: [...seeds.values()],
          chartPoints: domain.bounds.map(points => fraction(points, orders)), primary: fraction(domain.total, observations) });
        continue;
      }
      const missing = songs.map((_, index) => index).filter(index => !domain.witnesses[index]);
      const known = domain.witnesses.filter(witness => witness !== undefined);
      if (known.length && (!missing.length || domain.queries >= 6 || (known.length >= songs.length / 2 && domain.total > threshold * 1.05))) {
        const counts = new Map<string, { hit: EngineHit; count: number }>();
        for (const { hit } of known) {
          const key = memberSet(hit.members);
          const entry = counts.get(key);
          if (entry) entry.count++;
          else counts.set(key, { hit, count: 1 });
        }
        const { hit } = [...counts.values()].sort((a, b) => b.count - a.count)[0]!;
        for (const constraints of split(domain.constraints, fixed, hit)) if (!enqueue(constraints, domain)) return null;
        continue;
      }
      const gap = (chart: number) => domain.bounds[chart]! - (fallback[chart] ?? threshold / songs.length);
      missing.sort((a, b) => gap(b) - gap(a));
      for (const chart of missing.slice(0, pending.length ? 1 : workerCount - jobs.length)) {
        jobs.push({ domain, chart, target: threshold - (domain.total - domain.bounds[chart]!) });
      }
    }
    if (!jobs.length || stopped()) continue;
    const rows = await native(jobs.map(({ domain, chart, target }) => ({
      ...subrequest, constraints: domain.constraints, rewardPhase: { kind: "primary" },
      floors: target > 0 ? { [chartKey(songs[chart]!)]: inclusiveFloor(target) } : undefined,
      goal: { ...rawGoal, songs: [songs[chart]!] },
    })));
    if (stopped()) return null;
    const updated = new Set<Domain>();
    const empty = new Set<Domain>();
    for (const [index, { domain, chart, target }] of jobs.entries()) {
      const row = completedRow(rows[index], songs[chart]!, "primary");
      if (!row) return null;
      const hit = row.hits[0];
      const points = hit ? pointSum(hit) : null;
      if (hit && (points === null || points > domain.bounds[chart]! || !contains(domain.constraints, hit) ||
          Math.round((hit.event?.bonusPercent ?? NaN) * 100) !== model.rosterBonus(hit.members))) return null;
      if (target > 0 && (points === null || points < target)) domain.bounds[chart] = target - 1;
      else if (!hit || points === null) empty.add(domain);
      else {
        domain.bounds[chart] = points;
        domain.witnesses[chart] = { hit, points };
        fallback[chart] ??= points;
      }
      domain.queries++;
      updated.add(domain);
    }
    for (const domain of updated) {
      domain.total = sum(domain.bounds);
      if (!empty.has(domain) && domain.total >= threshold) pending.push(domain);
    }
  }
  return stopped() ? null : { candidates, outside: fraction(threshold - 1, observations), stats, unknownCards: [...unknown] };
}
