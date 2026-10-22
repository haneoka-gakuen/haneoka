// L3 — GEB
// Input: 可序列化队伍／歌曲／目标请求、Master 与注入的谱面读取器。
// Output: Engine 输入输出类型及 TS 评价／搜索接口。
// Pos: [Map](L2-2.md)；引擎 TS 契约和实现，区别于当前 Worker 的 WASM 执行。
// Effects/Dependencies: 调用注入的谱面加载与搜索逻辑；实际 I/O 取决于读取器和调用环境。
/** Serializable engine requests and their evaluation. Pure: charts come from an injected loader. */
import { battleRank, compileChart, scoreRank, type ChartSource, type CompiledChart } from "./chart";
import { AP, ORDERS, isAllPerfect, playJudgements, prepareLive, skipScore, type PlayModel, type PreparedLive } from "./live";
import type { EngineMaster, EventEffectRow } from "./master";
import {
  eventObjective,
  eventScoreTieObjective,
  eventPoints,
  liveScoreObjective,
  scoreCapObjective,
  eventBonusSurrogate,
  potentialObjective,
  powerObjective,
  type Criterion,
  type EventDetail,
  type EventRoute,
  type LiveDetail,
} from "./objectives";
import { memberEventPercent, snapEventPercent, teamPower, type MemberState, type MusicView, type PlayerState, type SnapState } from "./power";
import { resolveBox, type MemberInput, type SnapInput, type UnknownPolicy } from "./box";
import { searchTeams, type Constraints, type ObjectiveAdapter, type SearchOutput, type SearchHit, type Team } from "./search";
import { resolveSlotSkill, windowMs } from "./skills";
import { fullOrdersGekiso, gekisoChart, type GekisoChart } from "./gekiso";
import { performer } from "./full/deck";
import { gekisoSearch } from "./gekiso-objective";
import { compareHits, planSummary } from "./merge";
import { validatePtChart, validatePtRequest } from "./pt-eligibility";
import type { Accuracy } from "./full/play";
import type { CpExchange } from "./pt-value";
import type { GekisoRewardOptions } from "./gekiso-rewards";
import type { GekisoJustSummary } from "./gekiso-just";
import { gekisoRewardObjective } from "./gekiso-reward-objective";
import { GekisoScoreCache } from "./gekiso-score-cache";
import { GekisoContextCache } from "./gekiso-context-cache";
import { deadlineOf, remaining, requestSongs, pendingSong, acceptsReward, excludesBound, type RewardCutoff } from "./execution";
import type { EngineSnapshot, StopReason } from "./protocol";
import { isLiveBoostCost } from "./boosts";

export interface SongRef {
  songId: number;
  difficulty: number;
}
export interface PlayerInput {
  characterRanks: Record<string, number | null>;
  characterTotalRank: number | null;
  bandItems: Record<string, number | null>;
  vipRank: number | null;
  characterMemory: Record<string, number | null>;
  musicMemory: Record<string, number | null>;
}
export interface ConstraintInput {
  requiredMembers: string[];
  excludedMembers: string[];
  requiredSnaps: string[];
  excludedSnaps: string[];
  leader: string | null;
  bindings: [string, string | null][];
  noSnaps: boolean;
  /** Event bonus floor in percent. */
  minBonusPercent: number | null;
}
export type Goal =
  | { kind: "power"; song: SongRef | null; challengeEventId: number | null }
  | {
      kind: "score";
      songs: SongRef[];
      criterion: Criterion;
      play: PlayModel;
      challengeEventId: number | null;
      /** Replaces the criterion: share of the 120 orders reaching `score`, or the average capped at it. */
      target?: { kind: "at-least" | "capped"; score: number };
    }
  | {
      kind: "event";
      measure: "points" | "items" | "challenge-points";
      route: "live" | "challenge" | "skip";
      eventId: number;
      songs: SongRef[];
      /** Boosts per normal live (0–10) or challenge points per challenge live. */
      consumption: number;
      play: PlayModel;
      /** Ranks by weights·(points, items, challenge points) instead of the measure alone. */
      weights?: { points: number; items: number; challengePoints: number };
      /** Primary-reward ordering; pt-only additionally validates the strict solo/challenge input contract. */
      ranking?: "pt-only" | "primary";
      /** Best challenge payout per CP for this objective. Only the solo trial uses this value. */
      cpExchange?: CpExchange;
      /** Non-challenge Gekisou rewards, using per-outcome settlement. Absent means solo. */
      gekiso?: GekisoRewardOptions;
    }
  | {
      kind: "gekiso";
      songs: SongRef[];
      criterion: Criterion;
      /** Share of notes hit Great, and of the Just-eligible rest hit Just. */
      accuracy: Accuracy;
      /** Assumed placement in every range (1 for solo Mission lives). */
      rank: number;
      /** Minimum base multiplier at the opening COMBO, evaluated at initial LIFE. */
      minComboBonus?: number;
      /** Opponents' scores in each range; when given they decide the placements instead of `rank`. */
      opponents?: number[][];
      /** Luck ranges: 0 takes the exact nominal lottery expectation; n > 0 averages n native lottery seeds instead. */
      seeds: number;
    }
  | { kind: "potential"; windowSeconds: number }
  | {
      kind: "plan";
      eventId: number;
      normalSongs: SongRef[];
      challengeSongs: SongRef[];
      boostsPerLive: number;
      boostBudget: number;
      startingChallengePoints: number;
      challengePointsPerLive: number;
      play: PlayModel;
      /** Event points of the best challenge live, when the caller already searched the challenge stage (the parallel
       * client does): the plan then only searches the normal lives. */
      challengePointsPerPlay?: number;
    };
export interface EngineRequest {
  members: MemberInput[];
  snaps: SnapInput[];
  player: PlayerInput;
  unknownPolicy: UnknownPolicy;
  goal: Goal;
  constraints: ConstraintInput;
  k: number;
  timeLimitMs: number | null;
  deadline?: number;
  requestId?: string;
  contextKey?: string;
  seeds?: EngineHit[];
  completed?: SongResult[];
  /** Parallel search shard (see SearchInput.shard); merged by the client. */
  shard?: { index: number; count: number };
  /** Disables the aspiration floor (the rerun after a sharded aspiration fell short). */
  noFloor?: boolean;
  /** Gekiso: only the shard-independent seeding, whose teams then seed every shard (`seeded`). */
  seedOnly?: boolean;
  /** Private sampled warm pass; retained candidates still use every requested seed. */
  seedVariant?: "sample" | "quiet";
  seeded?: boolean;
  /** Internal COMBO reward proof stage; later stages follow completed global reward proofs. */
  rewardPhase?: { kind: "primary" } | { kind: "other"; reward: number; floor?: number } | { kind: "score"; reward: number; other: number; floor?: number };
  /** Known lower bounds on each song's k-th key (`songId:difficulty`), from teams other shards already found. */
  floors?: Record<string, number>;
  /** Other songs' Top-K key. Only a pt-only k=1 request may prove this song strictly below the cutoff. */
  rewardCutoff?: number;
  cutoff?: RewardCutoff;
}
/** Best goal value with one card raised to full growth, for every card not there yet, most improving first. */
export interface GrowthResult {
  base: number;
  upgrades: { kind: "members" | "snaps"; key: string; value: number; gain: number; team: EngineHit | null }[];
}
export interface HitScore {
  mean: number;
  min: number;
  max: number;
  median: number;
  /** Member keys at each chart skill event, for the worst and best orders. */
  worstOrder: string[];
  bestOrder: string[];
  /** Score of every skill order, indexed like ORDERS (event → formation slot). */
  orders: number[];
  ranks: Record<string, number>;
  rangeScores?: number[];
}
export interface EngineHit {
  /** Base multiplier, including the first-COMBO sustained bonus. */
  comboBonus?: number | null;
  gekiso?: { just: GekisoJustSummary; luckSamples: number; sampled: boolean; rank: 1 };
  song: SongRef | null;
  /** Leader first. */
  members: string[];
  snaps: (string | null)[];
  power: number;
  slotPowers: number[];
  key: number;
  score: HitScore | null;
  skipScore: number | null;
  event: {
    mean: number; bonusPercent: number; challengePoints: number; perPlayMin: number; perPlayMax: number;
    /** Per-play mean of the other reward (points ↔ items). */
    otherMean?: number;
    /** Exact order sums used by the solo trial; mean includes CP conversion when requested. */
    rewardSum?: number; comparisonSum?: number; orders?: number; directMean?: number; convertedMean?: number;
  } | null;
  potential: { value: number; area: number } | null;
}
export interface SongResult {
  /** Internal stage proof, consumed by the Worker coordinator. */
  rewardPhase?: "primary" | "other" | "score";
  song: SongRef | null;
  hits: EngineHit[];
  proven: boolean;
  bound: number | null;
  stats: SearchOutput<unknown>["stats"];
  /** Gekisou with opponents: the placement in each range that the recommended team's range scores earn. */
  placements?: number[];
  /** Aspiration floor of a sharded search: the merged result is exact only if it holds k hits at or above it. */
  floor?: number;
  /** Exhaustive proof that no team in this scope reaches this key. Not a completed single-song optimum. */
  excludedBelow?: number;
  exclusion?: RewardCutoff;
}
export interface PlanSummary {
  normal: EngineHit | null;
  challenge: EngineHit | null;
  normalLives: number;
  /** Expected challenge lives after spending the finite boost budget. */
  challengeLives: number;
  challengePointsEarned: number;
  leftoverChallengePoints: number;
  eventPoints: number;
  /** Event points per boost spent, over the whole cycle. */
  perBoost: number;
}
export interface EngineResponse {
  stopReason?: StopReason;
  error?: string;
  /** Phase durations sum work across Workers; wallMs includes queueing and all phases. */
  timing?: { initializationMs: number; networkMs: number; computationMs: number; wallMs: number };
  plan?: PlanSummary;
  results: SongResult[];
  /** Best (song, team) pairs over every song, distinct by song + member set. */
  overall: EngineHit[];
  unknownCards: string[];
  elapsedMs: number;
}

export type ChartLoader = (master: EngineMaster, song: SongRef) => Promise<ChartSource>;
export class ChartCache {
  readonly gekisoScores = new GekisoScoreCache();
  readonly gekisoContexts = new GekisoContextCache();
  private readonly sources = new Map<string, Promise<ChartSource>>();
  private readonly charts = new Map<string, Promise<CompiledChart>>();
  private readonly prepared = new WeakMap<CompiledChart, PreparedLive>();
  private readonly gekisoCharts = new Map<string, Promise<GekisoChart>>();
  constructor(
    private readonly master: EngineMaster,
    private readonly load: ChartLoader,
  ) {}
  /** A long recommendation visits the entire song catalog. Retain only a few reusable charts, not the run's history. */
  private cached<T>(cache: Map<string, Promise<T>>, key: string, load: () => Promise<T>): Promise<T> {
    let value = cache.get(key);
    if (value) cache.delete(key);
    else {
      value = load();
      const pending = value;
      void value.catch(() => {
        // A failed evicted load must not delete a newer request for the same chart.
        if (cache.get(key) === pending) cache.delete(key);
      });
    }
    cache.set(key, value);
    if (cache.size > 4) cache.delete(cache.keys().next().value!);
    return value;
  }
  source(ref: SongRef): Promise<ChartSource> {
    const key = `${ref.songId}:${ref.difficulty}`;
    return this.cached(this.sources, key, () => this.load(this.master, ref));
  }
  chart(ref: SongRef): Promise<CompiledChart> {
    const key = `${ref.songId}:${ref.difficulty}`;
    return this.cached(this.charts, key, async () => {
      const song = this.master.songs.get(ref.songId);
      const difficulty = song?.difficulties.find((item) => item.difficulty === ref.difficulty);
      if (!song || !difficulty) throw new RangeError(`unknown-chart:${key}`);
      return compileChart(this.master, song, difficulty, await this.source(ref));
    });
  }
  /** The Gekisou chart of a song at a stated accuracy and assumed range rank. */
  gekiso(ref: SongRef, accuracy: Accuracy, rank: number): Promise<GekisoChart> {
    const key = `${ref.songId}:${ref.difficulty}:${accuracy.great}:${accuracy.just}:${accuracy.missEvery ?? 0}:${rank}`;
    return this.cached(this.gekisoCharts, key, async () => {
      const song = this.master.songs.get(ref.songId);
      const difficulty = song?.difficulties.find((item) => item.difficulty === ref.difficulty);
      if (!song || !difficulty) throw new RangeError(`unknown-chart:${ref.songId}:${ref.difficulty}`);
      return gekisoChart(this.master, await this.source(ref), difficulty.playLevel, song.gekisoMissions, accuracy, rank);
    });
  }
  live(chart: CompiledChart): PreparedLive {
    let value = this.prepared.get(chart);
    if (!value) this.prepared.set(chart, (value = prepareLive(this.master, chart)));
    return value;
  }
}

export function playerState(master: EngineMaster, input: PlayerInput): PlayerState {
  const ranks = new Map<number, number>();
  for (const [id, rank] of Object.entries(input.characterRanks)) if (rank) ranks.set(Number(id), rank);
  const characters = [...master.characters.keys()];
  const total = input.characterTotalRank ?? characters.reduce((sum, id) => sum + (ranks.get(id) ?? 1), 0);
  const items = new Map<number, number>();
  for (const [id, level] of Object.entries(input.bandItems)) if (level) items.set(Number(id), level);
  const points = (record: Record<string, number | null>) =>
    new Map(Object.entries(record).flatMap(([id, value]) => (value ? [[Number(id), value] as const] : [])));
  return {
    characterRanks: ranks,
    totalRank: total,
    bandItems: items,
    vipRank: input.vipRank ?? 1,
    characterMemory: points(input.characterMemory),
    musicMemory: points(input.musicMemory),
  };
}

/** Song view of a chart; a challenge song uses its own nonzero music type. */
export function musicView(master: EngineMaster, songId: number, challengeEventId: number | null): MusicView {
  const song = master.songs.get(songId)!;
  let musicType = song.musicType;
  if (challengeEventId !== null) {
    const challenge = master.challengeMusics.find((row) => row.eventId === challengeEventId && row.liveMusicId === songId);
    if (!challenge) throw new RangeError(`unknown-challenge-song:${challengeEventId}:${songId}`);
    if (challenge.musicType) musicType = challenge.musicType;
  }
  return { musicType, bestTags: song.bestTags, memoryKey: songId };
}
export function eventRoute(master: EngineMaster, eventId: number, route: "live" | "challenge" | "skip", consumption: number): EventRoute {
  const event = master.events.get(eventId);
  if (!event) throw new RangeError(`unknown-event:${eventId}`);
  const challenge = route === "challenge" || (route === "skip" && consumption > 10);
  if (!challenge && !isLiveBoostCost(consumption)) throw new Error("unsupported-live-boost-cost");
  const table = challenge ? master.challengeBoosts : master.boosts;
  const row = table.find((item) => item.consumed === consumption);
  const rate = challenge ? (consumption <= 200 ? row?.eventPointRate ?? 1 : row?.eventPointRate ?? 1) : consumption < 1 ? 1 : row?.eventPointRate ?? 1;
  const rewardRate = challenge ? row?.rewardRate ?? 1 : consumption < 1 ? 1 : row?.rewardRate ?? 1;
  return {
    kind: route === "challenge" ? "challenge" : route,
    rate,
    rewardRate,
    points: challenge ? event.challengePoints : event.livePoints,
    rewards: challenge ? event.challengeRewards : event.liveRewards,
    itemId: event.itemId,
    challengePoints: master.liveChallengePoints,
    effects: event.effects,
  };
}

function constraintsOf(input: ConstraintInput, members: readonly MemberState[], snaps: readonly SnapState[]): Constraints {
  const memberIndex = new Map(members.map((member, index) => [member.key, index]));
  const snapIndex = new Map(snaps.map((snap, index) => [snap.key, index]));
  const ids = (keys: string[], index: Map<string, number>) => keys.flatMap((key) => (index.has(key) ? [index.get(key)!] : []));
  const bindings = new Map<number, number>();
  for (const [member, snap] of input.bindings) {
    const i = memberIndex.get(member);
    if (i === undefined) continue;
    if (snap === null) bindings.set(i, -1);
    else if (snapIndex.has(snap)) bindings.set(i, snapIndex.get(snap)!);
  }
  return {
    requiredMembers: ids(input.requiredMembers, memberIndex),
    excludedMembers: ids(input.excludedMembers, memberIndex),
    requiredSnaps: ids(input.requiredSnaps, snapIndex),
    excludedSnaps: ids(input.excludedSnaps, snapIndex),
    leader: input.leader !== null ? (memberIndex.get(input.leader) ?? -1) : null,
    bindings,
    noSnaps: input.noSnaps,
    minBonus: input.minBonusPercent === null ? null : Math.round(input.minBonusPercent * 100),
  };
}

const median = (values: Float64Array) => {
  const sorted = Float64Array.from(values).sort();
  return (sorted[59]! + sorted[60]!) / 2;
};
function scoreSummary(detail: Pick<LiveDetail, "scores">, chart: CompiledChart, team: Team, members: readonly MemberState[], battle = false): HitScore {
  const { scores } = detail;
  const keysOf = (order: readonly number[]) => order.map((slot) => members[team.members[slot]!]!.key);
  const ranks: Record<string, number> = {};
  for (const value of scores.scores) {
    const rank = battle ? battleRank(chart, value) : scoreRank(chart, value);
    ranks[rank] = (ranks[rank] ?? 0) + 1;
  }
  return {
    mean: scores.mean,
    min: scores.min,
    max: scores.max,
    median: median(scores.scores),
    worstOrder: keysOf(ORDERS[scores.minOrder]!),
    bestOrder: keysOf(ORDERS[scores.maxOrder]!),
    orders: Array.from(scores.scores, Math.round),
    ranks,
  };
}

/** Per-Worker memo of the shard-independent preparation of the latest request. */
const eventPrep = new Map<string, { seeds: Team[]; aspiration: number | undefined }>();
const scoreCaps = new Map<string, number>();
const prepFingerprint = (request: EngineRequest) =>
  JSON.stringify([request.goal, request.members, request.snaps, request.player, request.unknownPolicy, request.constraints, request.k]);

function mergeRewardScoreTies<Detail>(first: readonly SearchHit<Detail>[], tied: readonly SearchHit<Detail>[], key: number, k: number): SearchHit<Detail>[] {
  const seen = new Set<string>();
  return [...tied.filter(hit => hit.key >= 0), ...first]
    .sort((a, b) => (b.detail as LiveDetail).scores.mean - (a.detail as LiveDetail).scores.mean ||
      JSON.stringify(a.team).localeCompare(JSON.stringify(b.team)))
    .filter(hit => {
      const id = [...hit.team.members].sort((a, b) => a - b).join(",");
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    }).slice(0, k).map(hit => ({ ...hit, key }));
}

/** How far the closed-form Gekisou scores may stray from the whole-live simulation, relative. Measured within 4e-6
 * over every order of the best teams of Combo and Just charts; the margin keeps a wide reserve. */
export const GEKISO_CLOSED_FORM_MARGIN = 3e-5;

export async function runEngine(master: EngineMaster, charts: ChartCache, request: EngineRequest, onProgress?: (done: number, total: number) => void, onSnapshot?: (snapshot: EngineSnapshot) => void): Promise<EngineResponse> {
  const started = performance.now();
  const deadline = deadlineOf(request);
  request = { ...request, deadline };
  const primaryOnly = request.goal.kind === "event" && !!request.goal.ranking;
  if (request.cutoff && (!primaryOnly || request.k !== 1 || request.cutoff.contextKey !== request.contextKey || !Number.isFinite(request.cutoff.key))) throw new Error("invalid-reward-cutoff");
  const ptTrial = request.goal.kind === "event" && request.goal.ranking === "pt-only";
  if (request.rewardCutoff !== undefined && (!ptTrial || request.k !== 1 || !Number.isFinite(request.rewardCutoff)))
    throw new Error("invalid-reward-cutoff");
  if (ptTrial) {
    const issues = validatePtRequest(master, request);
    if (issues.length) throw new Error(`pt-input:${JSON.stringify(issues)}`);
  }
  const box = resolveBox(master, request.members, request.snaps, request.unknownPolicy);
  const { members, snaps } = box;
  const player = playerState(master, request.player);
  const constraints = constraintsOf(request.constraints, members, snaps);
  const shared = { master, members, snaps };
  const goal = request.goal;
  const results: SongResult[] = [];
  const toHit = (song: SongRef | null, team: Team, power: number, slotPowers: number[], key: number): EngineHit => ({
    song,
    members: team.members.map((i) => members[i]!.key),
    snaps: team.snaps.map((j) => (j < 0 ? null : snaps[j]!.key)),
    power,
    slotPowers,
    key,
    score: null,
    skipScore: null,
    event: null,
    potential: null,
  });
  const targets = new Set<unknown>();
  let currentSong: SongRef | null = null;
  let currentChart: CompiledChart | null = null;
  let lastSnapshot = -Infinity;
  const snapshotHit = (hit: SearchHit<unknown>): EngineHit => {
    const base = toHit(currentSong, hit.team, hit.power, hit.slotPowers, hit.key);
    if (goal.kind === "power") return base;
    const detail = hit.detail as Partial<EventDetail> & { potential?: number; area?: number; just?: GekisoJustSummary; luckSamples?: number; sampled?: boolean; observations?: number; cpSum?: number };
    if (detail.scores && currentChart) base.score = scoreSummary(detail as LiveDetail, currentChart, hit.team, members, goal.kind === "gekiso" || (goal.kind === "event" && !!goal.gekiso));
    if (detail.potential !== undefined) base.potential = { value: detail.potential, area: detail.area! };
    if (goal.kind === "event") base.event = {
      mean: (detail.mean ?? 0) / (goal.cpExchange?.denominator ?? 1), bonusPercent: (detail.bonus ?? 0) / 100,
      challengePoints: detail.challengePoints ?? (detail.observations ? detail.cpSum! / detail.observations : 0),
      perPlayMin: detail.directMin ?? detail.mean ?? 0, perPlayMax: detail.directMax ?? detail.mean ?? 0,
      rewardSum: detail.rewardSum, comparisonSum: detail.comparisonSum, orders: detail.observations ?? ORDERS.length,
      directMean: detail.rewardSum === undefined ? undefined : detail.rewardSum / (detail.observations ?? ORDERS.length),
    };
    if (detail.just) base.gekiso = { just: detail.just, luckSamples: detail.luckSamples!, sampled: detail.sampled!, rank: 1 };
    return base;
  };
  const publish = (hits: readonly SearchHit<unknown>[]) => {
    if (!onSnapshot || performance.now() - lastSnapshot < 100 || !hits.length) return;
    lastSnapshot = performance.now();
    const all = requestSongs(request).map(song => results.find(result => result.song?.songId === song?.songId && result.song?.difficulty === song?.difficulty) ?? pendingSong(song));
    const index = results.length;
    all[index] = { ...pendingSong(currentSong), hits: hits.map(snapshotHit) };
    const response: EngineResponse = { results: all, overall: all.flatMap(result => result.hits).sort(compareHits).slice(0, request.k), unknownCards: box.unknown, elapsedMs: performance.now() - started };
    onSnapshot({ requestId: request.requestId ?? "", contextKey: request.contextKey ?? "", response, coverage: { completed: results.filter(result => result.proven || result.exclusion).length, total: all.length } });
  };
  const savedSeeds = (request.seeds ?? []).map(hit => ({ members: hit.members.map(key => members.findIndex(member => member.key === key)), snaps: hit.snaps.map(key => key === null ? -1 : snaps.findIndex(snap => snap.key === key)) }));
  const run = <Detail,>(objective: ObjectiveAdapter<Detail>, music: MusicView | null, powerEffects: readonly EventEffectRow[], k = request.k, seeds?: readonly Team[], shard: EngineRequest["shard"] | null = request.shard, limitMs?: number, floor?: number, onCandidate?: (hits: readonly SearchHit<Detail>[]) => void) =>
    searchTeams({
      floor,
      floorExclusive: targets.has(objective) && request.cutoff?.comparison === "gt" && floor === request.cutoff.key,
      shard: shard ?? undefined,
      seeds: [...savedSeeds, ...(seeds ?? [])],
      onCandidate: onCandidate ?? (targets.has(objective) ? publish : undefined),
      // Gekisou rewards also read support-skill effects the four dominance values do not carry.
      disableSnapDominance: ptTrial && request.goal.kind === "event" && !!request.goal.gekiso,
      master,
      player,
      members,
      snaps,
      music,
      objective,
      constraints,
      k,
      timeLimitMs: Math.min(limitMs ?? Infinity, songBudget(), remaining(deadline)),
      memberPowerPercent: powerEffects.length ? (member) => memberEventPercent(powerEffects, member) : undefined,
      snapPowerPercent: powerEffects.length ? (snap) => snapEventPercent(powerEffects, snap) : undefined,
    });
  /** A sharded search first probes the whole box briefly: its teams (exact, from any leader) seed every shard's
   * threshold, which a shard alone would only reach after searching its own strong leaders. */
  const PROBE_MS = 300;
  const seeded = <Detail,>(objective: ObjectiveAdapter<Detail>, music: MusicView | null, powerEffects: readonly EventEffectRow[], seeds?: readonly Team[]) => {
    targets.add(objective);
    if (!request.shard || request.shard.count < 2) return run(objective, music, powerEffects, request.k, seeds);
    const probe = run(objective, music, powerEffects, request.k, seeds, null, PROBE_MS);
    return run(objective, music, powerEffects, request.k, [...(seeds ?? []), ...probe.hits.map((hit) => hit.team)]);
  };
  if (goal.kind === "plan") return runPlan(master, charts, request, goal, started, onProgress, onSnapshot);
  const songs: (SongRef | null)[] =
    goal.kind === "power" ? [goal.song] : goal.kind === "potential" ? [null] : goal.kind === "event" && goal.route === "skip" && !goal.songs.length ? [null] : goal.songs;
  let songsLeft = songs.length;
  const songBudget = () => remaining(deadline) / Math.max(1, songsLeft);
  for (const [index, song] of songs.entries()) {
    const completed = request.completed?.find(result => result.proven && result.song?.songId === song?.songId && result.song?.difficulty === song?.difficulty);
    if (completed) { results.push(completed); continue; }
    if (!remaining(deadline)) { results.push(...songs.slice(index).map(song => request.completed?.find(result => result.proven && result.song?.songId === song?.songId && result.song?.difficulty === song?.difficulty) ?? pendingSong(song))); break; }
    currentSong = song;
    if (ptTrial && song) {
      const source = await charts.source(song);
      validatePtChart(master, song, source);
      if (goal.kind === "event" && goal.gekiso && (!source.enumeration?.length || source.feverMs.length !== 3))
        throw new Error(`gekiso-chart-unsupported:${song.songId}:${song.difficulty}`);
    }
    songsLeft = songs.length - index;
    onProgress?.(index, songs.length);
    const challengeId = goal.kind === "power" || goal.kind === "score" ? goal.challengeEventId : goal.kind === "event" && goal.route === "challenge" ? goal.eventId : null;
    const music = song ? musicView(master, song.songId, challengeId) : null;
    const powerEffects = challengeId !== null ? (master.events.get(challengeId)?.effects ?? []) : [];
    const chart = song && goal.kind !== "power" ? await charts.chart(song) : null;
    currentChart = chart;
    const live = chart ? charts.live(chart) : null;
    if (!remaining(deadline)) { results.push(...songs.slice(index).map(pendingSong)); break; }
    if (goal.kind === "power") {
      const objective = powerObjective();
      targets.add(objective);
      const out = run(objective, music, powerEffects);
      results.push({
        song,
        proven: out.proven,
        bound: out.bound,
        stats: out.stats,
        hits: await Promise.all(
          out.hits.map(async (hit) => {
            const result = toHit(song, hit.team, hit.power, hit.slotPowers, hit.key);
            if (song) result.skipScore = skipScore(master, await charts.chart(song), hit.power);
            return result;
          }),
        ),
      });
    } else if (goal.kind === "score") {
      const objective = liveScoreObjective({ ...shared, live: live!, play: goal.play }, goal.criterion);
      // Loose-bound plays start from the best all-Perfect teams, scored exactly under the real play.
      const seeds = objective.hard ? run(liveScoreObjective({ ...shared, live: live!, play: AP }, goal.criterion), music, powerEffects, Math.max(20, request.k * 3), undefined, null, Math.min(150, songBudget() / 4)).hits.map((hit) => hit.team) : undefined;
      const out = seeded(objective, music, powerEffects, seeds);
      results.push({
        song,
        proven: out.proven,
        bound: out.bound,
        stats: out.stats,
        hits: out.hits.map((hit) => ({ ...toHit(song, hit.team, hit.power, hit.slotPowers, hit.key), score: scoreSummary(hit.detail, chart!, hit.team, members) })),
      });
    } else if (goal.kind === "gekiso") {
      const gekiso = await charts.gekiso(song!, goal.accuracy, goal.rank);
      // The search ranks on the closed form, within a few 1e-5 of the game's own scores. Every team that could still
      // reach the top k after that difference is scored on the whole-live simulation, which decides the ranking.
      const exactRanking = !gekiso.luck && goal.seeds <= 1 && !request.seedOnly;
      const margin = (key: number) => Math.max(1, Math.abs(key)) * GEKISO_CLOSED_FORM_MARGIN;
      let extra = exactRanking ? 4 : 0;
      const known = song ? request.floors?.[`${song.songId}:${song.difficulty}`] : undefined;
      const search = () => gekisoSearch({
        onCandidate: publish,
        initialTeams: savedSeeds,
        master,
        player,
        members,
        snaps,
        music,
        chart: gekiso,
        // 0 seeds: the exact nominal luck expectation; otherwise an average over that many native lottery seeds.
        seeds: Array.from({ length: Math.max(0, goal.seeds) }, (_, i) => i),
        criterion: goal.criterion,
        constraints,
        k: request.k + extra,
        timeLimitMs: songBudget(),
        shard: request.shard,
        // Other shards' keys are whole-live scores: closed-form keys within the margin below may still pass them.
        floor: known === undefined ? undefined : exactRanking ? known - 2 * margin(known) : known,
        seedOnly: request.seedOnly,
        seeded: request.seeded,
      });
      let out = search();
      if (exactRanking) {
        // More teams within the margin than the search returned: widen until the last one falls outside it.
        while (out.proven && out.hits.length === request.k + extra && out.hits.length >= request.k &&
          out.hits.at(-1)!.key >= out.hits[request.k - 1]!.key - 2 * margin(out.hits[request.k - 1]!.key)) {
          extra *= 2;
          out = search();
        }
        const kth = out.hits[Math.min(request.k, out.hits.length) - 1]?.key ?? -Infinity;
        const finalists = out.hits.filter((hit) => hit.key >= kth - 2 * margin(kth)).map((hit) => {
          const deck = hit.team.members.map((member, slot) => performer(master, members[member]!, hit.team.snaps[slot]! >= 0 ? snaps[hit.team.snaps[slot]!]! : null));
          const scores = fullOrdersGekiso(master, gekiso, deck, hit.power, music?.musicType ?? 0);
          const key = goal.criterion === "min" ? scores.min : goal.criterion === "max" ? scores.max : scores.mean;
          return { ...hit, key, detail: { ...hit.detail, scores } };
        });
        out = { ...out, hits: finalists.sort((a, b) => b.key - a.key).slice(0, request.k) };
      }
      results.push({
        song,
        proven: out.proven,
        bound: out.bound,
        stats: out.stats,
        hits: out.hits.map((hit) => ({ ...toHit(song, hit.team, hit.power, hit.slotPowers, hit.key), score: scoreSummary(hit.detail, chart!, hit.team, members, true) })),
      });
    } else if (goal.kind === "event" && goal.gekiso) {
      if (!ptTrial || goal.route !== "live" || !song || !chart) throw new Error("gekiso-reward-mode");
      const route = eventRoute(master, goal.eventId, "live", goal.consumption);
      const gekiso = await charts.gekiso(song, { great: 0, just: goal.gekiso.just }, 1);
      const measure = goal.measure === "items" ? "items" : "points";
      const adapter = gekisoRewardObjective({ ...shared, chart, gekiso, route, measure, options: goal.gekiso, exchange: goal.cpExchange, scoreCache: charts.gekisoScores, contextCache: charts.gekisoContexts });
      targets.add(adapter);
      // Bonus-oriented seeds only improve traversal order. The main search is uncapped and uses safe reward bounds.
      const seeds = run(eventBonusSurrogate(shared, route.effects, measure), music, [], request.k, undefined, null, 100).hits.map(hit => hit.team);
      const known = request.floors?.[`${song.songId}:${song.difficulty}`];
      const searchFloor = request.cutoff?.key ?? Math.max(known ?? -Infinity, request.rewardCutoff ?? -Infinity);
      let out = run(adapter, music, [], request.k, seeds, undefined, undefined, Number.isFinite(searchFloor) ? searchFloor : undefined);
      if (out.hits.length) {
        const rewardTarget = out.hits[0]!.key;
        const scoreTie = gekisoRewardObjective({ ...shared, chart, gekiso, route, measure, options: goal.gekiso, exchange: goal.cpExchange, scoreCache: charts.gekisoScores, contextCache: charts.gekisoContexts, rewardTarget });
        const tied = run(scoreTie, music, [], request.k, out.hits.map(hit => hit.team), undefined, undefined, 0,
          hits => publish(mergeRewardScoreTies(out.hits, hits, rewardTarget, request.k)));
        const hits = mergeRewardScoreTies(out.hits, tied.hits, rewardTarget, request.k);
        for (const field of ["leaders", "memberNodes", "snapNodes", "candidates", "exact", "elapsedMs"] as const)
          out.stats[field] += tied.stats[field];
        for (const field of ["sampleComputations", "sampleCacheHits", "sampleEarlyStops"] as const)
          out.stats[field] = (out.stats[field] ?? 0) + (tied.stats[field] ?? 0);
        out = { ...out, hits, proven: out.proven && tied.proven,
          bound: out.proven && tied.proven ? null : Math.max(out.bound ?? -Infinity, rewardTarget) };
      }
      results.push({ song, proven: out.proven, bound: out.bound, stats: out.stats, hits: out.hits.map(hit => {
        const d = hit.detail;
        return {
          ...toHit(song, hit.team, hit.power, hit.slotPowers, hit.key),
          score: scoreSummary(d, chart, hit.team, members, true),
          gekiso: { just: d.just, luckSamples: d.luckSamples, sampled: d.sampled, rank: 1 },
          event: {
            mean: d.mean / (goal.cpExchange?.denominator ?? 1), bonusPercent: d.bonus / 100,
            challengePoints: d.cpSum / d.observations, perPlayMin: d.directMin, perPlayMax: d.directMax,
            rewardSum: d.rewardSum, comparisonSum: d.comparisonSum, orders: d.observations,
            directMean: d.rewardSum / d.observations,
            convertedMean: goal.cpExchange ? d.cpSum / d.observations * goal.cpExchange.numerator / goal.cpExchange.denominator : 0,
          },
        };
      }) });
    } else if (goal.kind === "event") {
      const route = eventRoute(master, goal.eventId, goal.route, goal.consumption);
      const measure = goal.measure === "items" ? "items" : "points";
      // Under another song's cutoff, the uncapped bounds alone usually prove this song cannot reach it: try that
      // before paying for the score cap and the seed sweeps.
      if (request.rewardCutoff !== undefined && chart && goal.route !== "skip" && goal.measure !== "challenge-points") {
        const quick = eventObjective({ ...shared, live: live!, play: goal.play, chart }, route, measure, master.params.skipRank, 0, Infinity, goal.ranking ?? "primary", goal.cpExchange);
        const probe = run(quick as ObjectiveAdapter<unknown>, music, powerEffects, request.k, undefined, null, 150, request.rewardCutoff);
        if (probe.proven && !probe.hits.some((hit) => hit.key >= request.rewardCutoff!)) {
          const known = song ? request.floors?.[`${song.songId}:${song.difficulty}`] : undefined;
          const excludedBelow = Math.max(request.rewardCutoff, known ?? -Infinity);
          results.push({ song, proven: false, bound: excludedBelow, excludedBelow, stats: probe.stats, hits: [] });
          continue;
        }
      }
      const early = eventObjective(chart && goal.route !== "skip" ? { ...shared, live: live!, play: goal.play, chart } : { ...shared, chart: null }, route, measure, master.params.skipRank, 0, Infinity, goal.ranking ?? "primary", goal.cpExchange);
      const earlySeeds: Team[] = [];
      if (goal.measure !== "challenge-points") {
        targets.add(early);
        earlySeeds.push(...run(early, music, powerEffects, request.k, undefined, null, Math.min(40, songBudget() / 8)).hits.map(hit => hit.team));
      }
      // A fast best-order score search proves the highest score any team reaches; event bounds cap ranks at it.
      let scoreCap = Infinity;
      if (chart && goal.route !== "skip") {
        const capKey = `cap|${prepFingerprint(request)}|${song?.songId}:${song?.difficulty}`;
        const cached = scoreCaps.get(capKey);
        if (cached !== undefined) scoreCap = cached;
        else {
          const best = run(scoreCapObjective({ ...shared, live: live!, play: goal.play }), music, powerEffects, 1, undefined, null, songBudget() / 4);
          const top = best.hits[0]?.key ?? Infinity;
          scoreCap = best.proven ? top : Math.max(top, best.bound ?? Infinity);
          if (scoreCaps.size > 64) scoreCaps.clear();
          scoreCaps.set(capKey, scoreCap);
        }
      }
      const objective = eventObjective(chart && goal.route !== "skip" ? { ...shared, live: live!, play: goal.play, chart } : { ...shared, chart: null }, route, measure, master.params.skipRank, 0, scoreCap, goal.ranking ?? "primary", goal.cpExchange);
      let adapter: ObjectiveAdapter<unknown> = objective as ObjectiveAdapter<unknown>;
      if (goal.measure === "challenge-points" && chart) adapter = challengePointObjective(liveScoreObjective({ ...shared, live: live!, play: goal.play }, "mean"), chart, route);
      targets.add(adapter);
      let out: SearchOutput<unknown>;
      let floor: number | undefined;
      const known = song ? request.floors?.[`${song.songId}:${song.difficulty}`] : undefined;
      if (chart && goal.route !== "skip" && goal.measure !== "challenge-points") {
        // Seeds along the bonus/power front, and a floor at the k-th best seed's key. The preparation is the same for
        // every shard of a request, so a Worker keeps it for the request's other shards.
        const prepKey = `${prepFingerprint(request)}|${song?.songId}:${song?.difficulty}`;
        let prep = eventPrep.get(prepKey);
        if (!prep) {
          const seeds: Team[] = [...earlySeeds];
          for (const weight of [2 ** 24, 64, 32, 16, 8, 4, 2])
            // Seeds only steer the start: each sweep stops at 100 ms (the main search below still runs to proof).
            seeds.push(...run(eventBonusSurrogate(shared, route.effects, measure, weight), music, powerEffects, request.k, undefined, null, 100).hits.map((hit) => hit.team));
          const probe = run(adapter, music, powerEffects, request.k, seeds, null, 1);
          // The k-th best seed is a real team: a floor at its key never cuts the true top k.
          prep = { seeds, aspiration: probe.hits.length >= request.k ? probe.hits[request.k - 1]!.key : undefined };
          if (eventPrep.size > 64) eventPrep.clear();
          eventPrep.set(prepKey, prep);
        }
        const seeds = [...earlySeeds, ...prep.seeds];
        floor = !request.noFloor ? prep.aspiration : undefined;
        const searchFloor = request.cutoff?.key ?? Math.max(floor ?? -Infinity, known ?? -Infinity, request.rewardCutoff ?? -Infinity);
        out = run(adapter, music, powerEffects, request.k, seeds, undefined, undefined, Number.isFinite(searchFloor) ? searchFloor : undefined);
        const enough = out.hits.filter((hit) => floor === undefined || hit.key >= floor).length >= request.k;
        if (!enough && request.cutoff === undefined && request.rewardCutoff === undefined && !(request.shard && request.shard.count > 1)) {
          out = run(adapter, music, powerEffects, request.k, seeds);
          floor = undefined;
        }
      } else out = seeded(adapter, music, powerEffects, earlySeeds);
      // A second search orders each equal-reward group by mean score.
      if (out.hits.length && chart && goal.route !== "skip" && goal.measure !== "challenge-points") {
        const ordered: typeof out.hits = [];
        let proven = out.proven;
        let bound = out.bound;
        for (const key of [...new Set(out.hits.map((hit) => hit.key))].sort((a, b) => b - a)) {
          if (ordered.length >= request.k) break;
          const group = out.hits.filter((hit) => hit.key === key);
          const tie = run(eventScoreTieObjective({ ...shared, live: live!, play: goal.play, chart }, objective, key, ordered.map(hit => hit.team)), music, powerEffects, request.k - ordered.length, group.map((hit) => hit.team), undefined, undefined, 0,
            hits => publish([...ordered, ...mergeRewardScoreTies(group, hits as SearchHit<unknown>[], key, request.k - ordered.length)]));
          if (!tie.proven) {
            proven = false;
            bound = Math.max(bound ?? -Infinity, key);
          }
          for (const field of ["leaders", "memberNodes", "snapNodes", "candidates", "exact", "elapsedMs"] as const)
            out.stats[field] += tie.stats[field];
          ordered.push(...mergeRewardScoreTies(group, tie.hits as SearchHit<unknown>[], key, request.k - ordered.length));
        }
        out = { ...out, proven, bound, hits: ordered.slice(0, request.k) };
      }
      results.push({
        song,
        proven: out.proven,
        bound: out.bound,
        stats: out.stats,
        ...(floor !== undefined && request.shard && request.shard.count > 1 ? { floor } : {}),
        hits: out.hits.map((hit) => {
          const base = toHit(song, hit.team, hit.power, hit.slotPowers, hit.key);
          const detail = hit.detail as Partial<EventDetail> & { bonus?: number; mean?: number; scores?: LiveDetail["scores"] };
          if (detail.scores && chart) base.score = scoreSummary(detail as LiveDetail, chart, hit.team, members);
          if (song && !detail.scores) {
            // Skip routes still report the skip score of the strongest team.
          }
          const perOrder = detail.perOrder;
          base.event = {
            mean: (detail.mean ?? 0) / (goal.cpExchange?.denominator ?? 1),
            bonusPercent: (detail.bonus ?? 0) / 100,
            challengePoints: detail.challengePoints ?? 0,
            perPlayMin: detail.directMin ?? (perOrder ? Math.min(...perOrder) : (detail.mean ?? 0)),
            perPlayMax: detail.directMax ?? (perOrder ? Math.max(...perOrder) : (detail.mean ?? 0)),
            ...(ptTrial ? {
              rewardSum: detail.rewardSum,
              comparisonSum: detail.comparisonSum,
              orders: ORDERS.length,
              directMean: detail.rewardSum === undefined ? undefined : detail.rewardSum / ORDERS.length,
              convertedMean: goal.cpExchange ? (detail.challengePoints ?? 0) * goal.cpExchange.numerator / goal.cpExchange.denominator : 0,
            } : {}),
          };
          return base;
        }),
      });
    } else {
      const objective = potentialObjective(shared, goal.windowSeconds);
      targets.add(objective);
      const out = run(objective, null, []);
      results.push({
        song: null,
        proven: out.proven,
        bound: out.bound,
        stats: out.stats,
        hits: out.hits.map((hit) => ({ ...toHit(null, hit.team, hit.power, hit.slotPowers, hit.key), potential: { value: hit.detail.potential, area: hit.detail.area } })),
      });
    }
    if (request.cutoff) {
      const result = results[results.length - 1]!;
      result.hits = result.hits.filter(hit => acceptsReward(hit.key, request.cutoff!));
      if (!result.hits.length && (result.proven || (result.bound !== null && excludesBound(result.bound, request.cutoff)))) {
        result.exclusion = request.cutoff;
        result.proven = false;
        delete result.floor;
      }
    }
    if (request.rewardCutoff !== undefined) {
      const result = results[results.length - 1]!;
      result.hits = result.hits.filter((hit) => hit.key >= request.rewardCutoff!);
      if (result.proven && !result.hits.length) {
        const known = song ? request.floors?.[`${song.songId}:${song.difficulty}`] : undefined;
        result.excludedBelow = Math.max(request.rewardCutoff, known ?? -Infinity, result.floor ?? -Infinity);
        result.proven = false;
        result.bound = result.excludedBelow;
        delete result.floor;
      }
    }
  }
  const overall = results
    .flatMap((result) => result.hits)
    .sort(compareHits)
    .slice(0, request.k);
  return { results, overall, unknownCards: box.unknown, elapsedMs: performance.now() - started, stopReason: results.every(result => result.proven || result.exclusion || result.excludedBelow !== undefined) ? "complete" : "budget" };
}

/** Normal-live challenge points per play: CP(rank) × rate, mean over orders; ties prefer score. */
function challengePointObjective(base: ObjectiveAdapter<LiveDetail>, chart: CompiledChart, route: EventRoute): ObjectiveAdapter<EventDetail> {
  const value = (rank: number) => (route.challengePoints.get(rank) ?? 0) * route.rate;
  const TIE = 1 / 2 ** 36;
  return {
    skill: base.skill,
    memberBonus: () => 0,
    snapBonus: () => 0,
    bound: (totals) => {
      const high = base.bound(totals);
      return value(scoreRank(chart, high)) + TIE * high;
    },
    interval(team, totals) {
      const [low, high] = base.interval(team, totals);
      return [value(scoreRank(chart, low)) + TIE * low, value(scoreRank(chart, high)) + TIE * high];
    },
    exact(team, power, slots) {
      const { detail } = base.exact(team, power, slots);
      const perOrder = Float64Array.from(detail.scores.scores, (score) => value(scoreRank(chart, score)));
      const mean = perOrder.reduce((sum, item) => sum + item, 0) / perOrder.length;
      const ranks = new Map<number, number>();
      return { key: mean + TIE * detail.scores.mean, detail: { ...detail, perOrder, mean, bonus: 0, ranks, challengePoints: mean } };
    },
  };
}

/** A fixed team across songs (manual check / comparison / song ranking). */
export interface TeamSpec {
  members: string[];
  snaps: (string | null)[];
  leader: string;
}
export interface TeamEvaluation {
  song: SongRef;
  power: number;
  slotPowers: number[];
  score: HitScore;
  skipScore: number;
  event: { points: number; items: number; bonusPercent: number; itemBonusPercent: number } | null;
}
export async function evaluateTeam(
  master: EngineMaster,
  charts: ChartCache,
  request: { members: MemberInput[]; snaps: SnapInput[]; player: PlayerInput; unknownPolicy: UnknownPolicy; team: TeamSpec; songs: SongRef[]; play: PlayModel; challengeEventId: number | null; event: { eventId: number; route: "live" | "challenge"; consumption: number } | null },
): Promise<TeamEvaluation[]> {
  const box = resolveBox(master, request.members, request.snaps, request.unknownPolicy);
  const player = playerState(master, request.player);
  const order = [request.team.leader, ...request.team.members.filter((key) => key !== request.team.leader)];
  const memberStates = order.map((key) => box.members.find((member) => member.key === key)!);
  const snapByMember = new Map(request.team.members.map((key, index) => [key, request.team.snaps[index] ?? null]));
  const snapStates = order.map((key) => {
    const snap = snapByMember.get(key);
    return snap ? (box.snaps.find((item) => item.key === snap) ?? null) : null;
  });
  if (memberStates.some((member) => !member)) throw new RangeError("unknown-team-member");
  const out: TeamEvaluation[] = [];
  for (const song of request.songs) {
    const chart = await charts.chart(song);
    const live = charts.live(chart);
    const challengeId = request.event?.route === "challenge" ? request.event.eventId : request.challengeEventId;
    const effects = challengeId !== null ? (master.events.get(challengeId)?.effects ?? []) : [];
    const power = teamPower(master, player, memberStates, snapStates, 0, musicView(master, song.songId, challengeId), effects);
    const members = memberStates;
    const snaps = snapStates.filter((snap): snap is SnapState => !!snap);
    const team: Team = { members: [0, 1, 2, 3, 4], snaps: snapStates.map((snap) => (snap ? snaps.indexOf(snap) : -1)) };
    const objective = liveScoreObjective({ master, members, snaps, live, play: request.play }, "mean");
    const { detail } = objective.exact(team, power.total, power.slots);
    let event: TeamEvaluation["event"] = null;
    if (request.event) {
      const route = eventRoute(master, request.event.eventId, request.event.route, request.event.consumption);
      const bonus = (type: number) =>
        memberStates.reduce((sum, member) => sum + memberEventPercent(route.effects, member, type), 0) +
        snaps.reduce((sum, snap) => sum + snapEventPercent(route.effects, snap, type), 0);
      const pointBonus = bonus(0),
        itemBonus = bonus(1);
      let points = 0,
        items = 0;
      for (const score of detail.scores.scores) {
        const rank = scoreRank(chart, score);
        points += eventPoints(route, pointBonus, rank);
        for (const reward of route.rewards)
          if (reward.scoreRank === rank && (!route.itemId || reward.resourceId === route.itemId))
            items += (Math.trunc(Math.imul(Math.imul(reward.count, (itemBonus + 10000) | 0), route.rewardRate) / 10000) * reward.probability) / 10000;
      }
      event = { points: points / ORDERS.length, items: items / ORDERS.length, bonusPercent: pointBonus / 100, itemBonusPercent: itemBonus / 100 };
    }
    out.push({
      song,
      power: power.total,
      slotPowers: power.slots,
      score: scoreSummary(detail, chart, team, members),
      skipScore: skipScore(master, chart, power.total),
      event,
    });
  }
  return out;
}

/** Skill windows and note density of one order, for the timeline view. */
export interface Timeline {
  durationMs: number;
  /** Note counts per 500 ms bucket. */
  density: number[];
  fever: (readonly [number, number])[];
  windows: { member: string; event: number; startMs: number; endMs: number; percent: number; perfectPercent: number; extensionMs: number }[];
  score: number;
}
export async function explainTeam(
  master: EngineMaster,
  charts: ChartCache,
  request: { members: MemberInput[]; snaps: SnapInput[]; unknownPolicy: UnknownPolicy; team: TeamSpec; song: SongRef; eventOrder: string[]; play: PlayModel },
): Promise<Timeline> {
  const box = resolveBox(master, request.members, request.snaps, request.unknownPolicy);
  const chart = await charts.chart(request.song);
  const density = new Array<number>(Math.ceil((chart.lastNoteMs + 1000) / 500)).fill(0);
  for (const time of chart.times) density[Math.floor(time / 500)]!++;
  const windows: Timeline["windows"] = [];
  request.eventOrder.forEach((key, event) => {
    const member = box.members.find((item) => item.key === key);
    if (!member || event >= chart.skillTimes.length) return;
    const index = request.team.members.indexOf(key);
    const snapKey = request.team.snaps[index] ?? null;
    const snap = snapKey ? (box.snaps.find((item) => item.key === snapKey) ?? null) : null;
    const skill = resolveSlotSkill(master, member, snap);
    const start = chart.skillTimes[event]!;
    let percent = 0,
      perfect = 0,
      length = 0;
    for (const effect of skill.effects) {
      if (effect.gate.kind === "life-at-least" && (master.live.lifeBase >= effect.gate.value) !== effect.gate.positive && isAllPerfect(request.play)) continue;
      if (effect.type === 2000) percent += effect.delta / 1000;
      else perfect += effect.delta / 1000;
      length = Math.max(length, windowMs(effect.seconds, skill.extensionMs));
    }
    windows.push({ member: key, event, startMs: start, endMs: start + length, percent, perfectPercent: perfect, extensionMs: skill.extensionMs });
  });
  void playJudgements;
  void AP;
  return { durationMs: chart.lastNoteMs + 1000, density, fever: [...chart.feverMs], windows, score: 0 };
}

async function runPlan(
  master: EngineMaster,
  charts: ChartCache,
  request: EngineRequest,
  goal: Extract<Goal, { kind: "plan" }>,
  started: number,
  onProgress?: (done: number, total: number) => void,
  onSnapshot?: (snapshot: EngineSnapshot) => void,
): Promise<EngineResponse> {
  const total = goal.challengeSongs.length + goal.normalSongs.length;
  let done = 0;
  const step = (inner: number) => onProgress?.(done + inner, total);
  const budgetEnd = deadlineOf(request);
  // Challenge stage first: its best points per challenge point prices what normal lives earn.
  const challenge: Pick<EngineResponse, "results" | "overall" | "unknownCards"> =
    goal.challengePointsPerPlay !== undefined
      ? { results: [], overall: [], unknownCards: [] }
      : await runEngine(
    master,
    charts,
    {
      ...request,
      goal: { kind: "event", measure: "points", route: "challenge", eventId: goal.eventId, songs: goal.challengeSongs, consumption: goal.challengePointsPerLive, play: goal.play },
    },
    step,
    snapshot => onSnapshot?.({ ...snapshot, response: { ...snapshot.response, results: [...snapshot.response.results, ...goal.normalSongs.map(pendingSong)] }, coverage: { completed: snapshot.coverage.completed, total } }),
  );
  if (goal.challengePointsPerPlay === undefined && !challenge.results.every(result => result.proven)) return { ...challenge, results: [...challenge.results, ...goal.normalSongs.map(pendingSong)], elapsedMs: performance.now() - started, stopReason: "budget" };
  done += goal.challengeSongs.length;
  const bestChallenge = challenge.overall[0] ?? null;
  const pointsPerChallenge = goal.challengePointsPerPlay ?? bestChallenge?.event?.mean ?? 0;
  const weight = goal.challengePointsPerLive > 0 ? pointsPerChallenge / goal.challengePointsPerLive : 0;
  const box = resolveBox(master, request.members, request.snaps, request.unknownPolicy);
  const player = playerState(master, request.player);
  const constraints = constraintsOf(request.constraints, box.members, box.snaps);
  const shared = { master, members: box.members, snaps: box.snaps };
  const route = eventRoute(master, goal.eventId, "live", goal.boostsPerLive);
  const normalResults: SongResult[] = [];
  let lastSnapshot = -Infinity;
  for (const [index, song] of goal.normalSongs.entries()) {
    if (!remaining(budgetEnd)) { normalResults.push(...goal.normalSongs.slice(index).map(pendingSong)); break; }
    step(index);
    const chart = await charts.chart(song);
    const live = charts.live(chart);
    const music = musicView(master, song.songId, null);
    const songBudget = budgetEnd === Infinity ? Infinity : remaining(budgetEnd) / Math.max(1, goal.normalSongs.length - index);
    const best = searchTeams({ master, player, members: box.members, snaps: box.snaps, music, objective: scoreCapObjective({ ...shared, live, play: goal.play }), constraints, k: 1, timeLimitMs: songBudget / 4 });
    const top = best.hits[0]?.key ?? Infinity;
    const scoreCap = best.proven ? top : Math.max(top, best.bound ?? Infinity);
    const objective = eventObjective({ ...shared, live, play: goal.play, chart }, route, "points", master.params.skipRank, weight, scoreCap, "primary");
    const planHit = (hit: SearchHit<unknown>): EngineHit => {
      const detail = hit.detail as EventDetail;
      const pointsOnly = detail.perOrder ? detail.perOrder.reduce((sum, value) => sum + value, 0) / detail.perOrder.length : 0;
      return {
        song,
        members: hit.team.members.map((i) => box.members[i]!.key),
        snaps: hit.team.snaps.map((j) => (j < 0 ? null : box.snaps[j]!.key)),
        power: hit.power,
        slotPowers: hit.slotPowers,
        key: hit.key,
        score: detail.scores ? scoreSummary(detail, chart, hit.team, box.members) : null,
        skipScore: null,
        // perOrder includes the challenge-point weight; report plain points per play.
        event: { mean: pointsOnly - weight * detail.challengePoints, bonusPercent: detail.bonus / 100, challengePoints: detail.challengePoints, perPlayMin: 0, perPlayMax: 0 },
        potential: null,
      };
    };
    const candidate = (hits: readonly SearchHit<unknown>[]) => {
      if (performance.now() - lastSnapshot < 100) return;
      lastSnapshot = performance.now();
      const results = [...challenge.results, ...normalResults, { ...pendingSong(song), hits: hits.map(planHit) }, ...goal.normalSongs.slice(index + 1).map(pendingSong)];
      onSnapshot?.({ requestId: request.requestId ?? "", contextKey: request.contextKey ?? "", coverage: { completed: results.filter(result => result.proven).length, total },
        response: { results, overall: results.flatMap(result => result.hits).sort(compareHits).slice(0, request.k), unknownCards: box.unknown, elapsedMs: performance.now() - started } });
    };
    let out = searchTeams({ master, player, members: box.members, snaps: box.snaps, music, objective, constraints, k: request.k, onCandidate: onSnapshot ? candidate : undefined, timeLimitMs: Math.min(songBudget, remaining(budgetEnd)), shard: request.shard });
    const ordered: typeof out.hits = [];
    let proven = out.proven, bound = out.bound;
    for (const key of [...new Set(out.hits.map(hit => hit.key))].sort((a, b) => b - a)) {
      if (ordered.length >= request.k) break;
      const group = out.hits.filter(hit => hit.key === key);
      const tied = searchTeams({ master, player, members: box.members, snaps: box.snaps, music,
        objective: eventScoreTieObjective({ ...shared, live, play: goal.play, chart }, objective, key, ordered.map(hit => hit.team)),
        constraints, k: request.k - ordered.length, seeds: group.map(hit => hit.team), floor: 0,
        timeLimitMs: Math.min(songBudget, remaining(budgetEnd)), shard: request.shard,
        onCandidate: onSnapshot ? hits => candidate([...ordered, ...mergeRewardScoreTies(group, hits, key, request.k - ordered.length)]) : undefined });
      if (!tied.proven) { proven = false; bound = Math.max(bound ?? -Infinity, key); }
      for (const field of ["leaders", "memberNodes", "snapNodes", "candidates", "exact", "elapsedMs"] as const)
        out.stats[field] += tied.stats[field];
      ordered.push(...mergeRewardScoreTies(group, tied.hits, key, request.k - ordered.length));
    }
    out = { ...out, hits: ordered, proven, bound };
    normalResults.push({
      song,
      proven: out.proven,
      bound: out.bound,
      stats: out.stats,
      hits: out.hits.map(planHit),
    });
  }
  const bestNormal = normalResults.flatMap((result) => result.hits).sort(compareHits)[0] ?? null;
  return {
    plan: planSummary(goal, bestNormal, bestChallenge, pointsPerChallenge),
    results: [...challenge.results, ...normalResults],
    overall: [...(bestNormal ? [bestNormal] : []), ...(bestChallenge ? [bestChallenge] : [])],
    unknownCards: goal.challengePointsPerPlay !== undefined ? box.unknown : challenge.unknownCards,
    elapsedMs: performance.now() - started,
  };
}
