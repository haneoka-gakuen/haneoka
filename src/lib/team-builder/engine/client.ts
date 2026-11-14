// L3 — GEB
// Input: 配队资料、Engine 请求及进度／快照／单 Worker 最终结果回调；私有分片可返回待补分候选。
// Output: EngineClient、搜索／成长／活动养成分页／评价／批量评价／单顺序样例／解释结果及当前 Worker 阶段。
// Pos: [Map](L2-2.md)；主线程到当前引擎 Worker 的生命周期与分片协调。
// Effects/Dependencies: 在现有池中调度普通演出各曲分区和联合收益证明；首个候选即时发布、节流结束补发最新候选；共享编译后的 WASM 模块、一次编码的 UTF-8 计算资料和有界固定谱面载荷缓存（含调用者预置的固定谱面），允许预取已选谱面并与 Worker 初始化并行，按请求数量预热 Worker；普通 AP 挑战奖励的显式同分排序沿用单 Worker，复用预热上下文；创建和替换独立 Worker，独立场景在现有池中各占单个 Worker 并沿用完整请求流程；交换完整评分候选及排序下界，独立保留合法候选，合并全部分片证明，取消与重试替换对应实例。
import type { SampleRequest, PlaySample } from "./protocol";
/** Main-thread handle on the engine Worker. Cancelling replaces the Worker, so a long search never blocks. */
import { dataRows, objectRow, type TeamBuilderData } from "../data";
import { teamBuilderSourceIdentity } from "../data/source";
import type { EngineHit, EngineRequest, EngineResponse, GrowthResult, SongRef, TeamEvaluation, Timeline, RewardFloor } from "./api";
import type { EngineCall, EngineChart, EngineChartSources, EngineReply, EvaluateRequest, ExplainRequest, EngineSnapshot, StopReason } from "./protocol";
import type { EventTeamGrowthRequest, EventTeamSearchPage, EventTeamSearchResult } from "../../event-team-analysis";
import { clock, deadlineOf, remaining, emptyResponse, completeResponse, requestSongs, requestChartSongs, singleSongRequest } from "./execution";
import { aspirationHeld, compareHits, memberSetKey, mergeShardResponses } from "./merge";
import { canPartitionEvent, partitionEvent, type PartitionBatch } from "./event-partitions";
import { canUseSharedEventRosters } from "./shared-event-rosters";
import { proveSharedEvent } from "./shared-event-search";
import { chartKey, EngineCharts } from "./charts";
import engineUrl from "./generated/team-engine.wasm?url";

let compiledEngine: Promise<WebAssembly.Module> | null = null;
const engineModule = () => compiledEngine ??= WebAssembly.compileStreaming(fetch(new URL(engineUrl, import.meta.url), { signal: AbortSignal.timeout(60_000) }))
  .catch(error => { compiledEngine = null; throw error; });

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; progress?: (done: number, total: number) => void;
  snapshot?: (value: EngineSnapshot) => void; eventGrowth?: (value: EventTeamSearchPage) => void };
type Preparation = { message: Extract<EngineCall, { type: "run" }>; floor: number; reward?: RewardFloor };
const rewardFloor = (hit: EngineHit): RewardFloor => [hit.key, hit.event?.otherMean ?? 0, hit.score?.mean ?? 0];

/** A detached normal result from a single Worker, before candidate merging and search-proof labels. */
export interface FinalEngineResult { requestId: string; contextKey: string; response: EngineResponse }
type FinalResultHandler = (result: FinalEngineResult) => void;

function workerData(data: TeamBuilderData): Uint8Array {
  const cards = (rows: TeamBuilderData["members"] | TeamBuilderData["snapshots"]) => Object.fromEntries(Object.entries(rows).map(([id, row]) => {
    const metadata = objectRow(row.catalogMetadata);
    if (!("resolvedSkills" in metadata)) return [id, row];
    const { resolvedSkills: _display, ...catalogMetadata } = metadata;
    return [id, { ...row, catalogMetadata }];
  }));
  return new TextEncoder().encode(JSON.stringify({ ...data, members: cards(data.members), snapshots: cards(data.snapshots) }));
}

/** One engine Worker: compiles the release once, then serves calls. */
class EngineWorker {
  scoredSeeds: unknown[] = [];
  private cooperativeFloor = false;
  private cooperativeReward = false;
  private runId: number | null = null;
  private eventGrowthId: number | null = null;
  private eventGrowthPaused = false;
  private cachedCharts: string[] = [];
  private chartCacheLimit = 4;
  private preparing: Preparation | null = null;
  private worker: Worker | null = null;
  private ready: Promise<void> | null = null;
  private nextId = 1;
  private phase: "initializationMs" | "networkMs" | "computationMs" | null = null;
  private phaseAt = 0;
  private readonly times = { initializationMs: 0, networkMs: 0, computationMs: 0 };
  private setPhase(phase: typeof this.phase) {
    const now = clock();
    if (this.phase) this.times[this.phase] += now - this.phaseAt;
    this.phaseAt = now;
    this.phase = phase;
    this.changed();
  }
  get currentPhase() { return this.phase; }
  get supportsFloor() { return this.cooperativeFloor; }
  get supportsReward() { return this.cooperativeReward; }
  timing() {
    return { ...this.times, ...(this.phase ? { [this.phase]: this.times[this.phase] + clock() - this.phaseAt } : {}) };
  }
  private readonly pending = new Map<number, Pending>();
  constructor(
    private readonly data: Uint8Array,
    private readonly charts: EngineChartSources,
    private readonly downloads: EngineCharts,
    private readonly name: string,
    private readonly changed: () => void,
  ) {}
  private spawn(): Promise<void> {
    if (this.ready) return this.ready;
    this.setPhase("initializationMs");
    const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module", name: this.name });
    this.worker = worker;
    worker.onmessage = (event: MessageEvent<EngineReply>) => {
      const reply = event.data;
      const pending = this.pending.get(reply.id);
      if (!pending) return;
      if (reply.type === "phase") this.setPhase(reply.phase === "network" ? "networkMs" : "computationMs");
      else if (reply.type === "progress") pending.progress?.(reply.done, reply.total);
      else if (reply.type === "snapshot") pending.snapshot?.(reply.snapshot);
      else if (reply.type === "eventGrowth") pending.eventGrowth?.({ ...reply.result, id: reply.id });
      else {
        const eventGrowth = reply.id === this.eventGrowthId;
        this.setPhase(null);
        this.pending.delete(reply.id);
        if (reply.type === "ready") this.cooperativeFloor = reply.cooperativeFloor === true;
        if (reply.type === "ready") this.cooperativeReward = reply.cooperativeReward === true;
        if (reply.type === "ready") this.chartCacheLimit = reply.chartCacheLimit ?? 4;
        if (reply.id === this.runId) this.runId = null;
        if (reply.id === this.eventGrowthId) this.eventGrowthId = null;
        if (reply.type === "error") pending.reject(new Error(reply.message));
        else {
          if (reply.type === "result" && reply.cachedCharts) this.cachedCharts = reply.cachedCharts;
          if (reply.type === "result" && reply.scoredSeeds) this.scoredSeeds = reply.scoredSeeds;
          if (reply.type === "result" && eventGrowth) {
            const result: EventTeamSearchPage = { ...(reply.result as EventTeamSearchResult), id: reply.id };
            pending.eventGrowth?.(result);
            pending.resolve(result);
          } else pending.resolve(reply.type === "result" ? reply.result : undefined);
        }
      }
    };
    worker.onerror = (event) => {
      if (this.worker !== worker) return;
      for (const pending of this.pending.values()) pending.reject(new Error(event.message || "engine-crashed"));
      this.pending.clear();
      this.reset();
    };
    this.ready = engineModule().then(module => {
      if (this.worker !== worker) throw new DOMException("Cancelled", "AbortError");
      return this.call({ type: "init", id: 0, data: this.data, charts: this.charts, module }) as Promise<void>;
    }).catch((error) => {
      // A failed release compile must not pin the Worker to its rejected ready promise.
      if (this.worker === worker) this.reset();
      throw error;
    });
    return this.ready;
  }
  private acceptsFloor(message: EngineCall) {
    return message.type === "run" && !message.request.noFloor && !message.request.seedOnly
      && message.request.k === 1 && (message.request.shard?.count ?? 1) > 1 && (message.request.goal.kind === "event"
        ? (!!message.request.rewardPhase || message.request.rewardLexicographic === true) && !!message.request.goal.gekiso
        : message.request.goal.kind === "gekiso" && (message.request.goal.arena?.mode === "shared" || message.request.aggregation === "mean" || (["mean", "max"].includes(message.request.goal.criterion) && message.request.goal.seeds >= 16 && !message.request.goal.opponents)));
  }
  private call(message: EngineCall, progress?: Pending["progress"], snapshot?: Pending["snapshot"], eventGrowth?: Pending["eventGrowth"]): Promise<unknown> {
    const id = this.nextId++;
    const cooperativeFloor = this.cooperativeFloor && this.acceptsFloor(message);
    if (message.type === "run") this.runId = cooperativeFloor ? id : null;
    if (message.type === "eventGrowth" || message.type === "eventGrowthPage") this.eventGrowthId = id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, progress, snapshot, eventGrowth });
      this.worker!.postMessage({ ...message, id, ...(message.type === "run" ? { cooperativeFloor } : {}),
        ...(message.type === "eventGrowth" || message.type === "eventGrowthPage" ? { paused: this.eventGrowthPaused } : {}) });
    });
  }
  pauseEventGrowth(paused: boolean) {
    this.eventGrowthPaused = paused;
    if (this.eventGrowthId !== null)
      this.worker!.postMessage({ type: "pauseEventGrowth", id: this.eventGrowthId, paused } satisfies EngineCall);
  }
  raiseFloor(value: number) {
    if (!Number.isFinite(value)) return false;
    if (this.runId === null) {
      if (!this.preparing || !this.acceptsFloor(this.preparing.message)) return false;
      this.preparing.floor = Math.max(this.preparing.floor, value);
      return true;
    }
    this.worker!.postMessage({ type: "floor", id: this.runId, value } satisfies EngineCall);
    return true;
  }
  raiseReward(hit: EngineHit) {
    if (!this.cooperativeReward) return this.raiseFloor(hit.key);
    const reward = rewardFloor(hit);
    if (this.runId === null) {
      if (!this.preparing || !this.acceptsFloor(this.preparing.message)) return false;
      this.preparing.floor = Math.max(this.preparing.floor, hit.key);
      this.preparing.reward = reward;
      return true;
    }
    this.worker!.postMessage({ type: "floor", id: this.runId, value: hit.key, reward } satisfies EngineCall);
    return true;
  }
  async send<T>(message: EngineCall, progress?: Pending["progress"], snapshot?: Pending["snapshot"], searchBudgetMs?: number,
    eventGrowth?: Pending["eventGrowth"]): Promise<T> {
    const preparation: Preparation | null = message.type === "run" ? { message, floor: -Infinity } : null;
    this.preparing = preparation;
    const ready = this.spawn();
    const worker = this.worker;
    const songs = message.type === "run" || message.type === "growth" ? requestChartSongs(message.request).filter((song): song is SongRef => song !== null)
      : message.type === "evaluate" || message.type === "sample" ? message.request.songs : message.type === "explain" ? [message.request.song]
        : message.type === "charts" ? message.songs : [];
    const staged = [...this.cachedCharts];
    const missing = songs.filter(song => {
      const key = chartKey(song), index = staged.indexOf(key);
      if (index >= 0 && message.type === "charts") return false;
      if (index >= 0) staged.splice(index, 1);
      staged.push(key);
      if (staged.length > this.chartCacheLimit) staged.shift();
      return index < 0;
    });
    let loading = true;
    const requestedCharts = new Set(songs.map(chartKey));
    const loaded = (
      message.loadedCharts
        ? Promise.resolve(message.loadedCharts.filter(row => requestedCharts.has(chartKey(row.song))))
        : songs.length <= 4 ? Promise.all(missing.map(song => this.downloads.load(song))) : Promise.resolve(undefined)).finally(() => { loading = false; });
    const initialized = ready.then(() => { if (loading) this.setPhase("networkMs"); });
    try {
      const [, loadedCharts] = await Promise.all([initialized, loaded]);
      if (worker !== this.worker) throw new DOMException("Cancelled", "AbortError");
      if (this.preparing === preparation) this.preparing = null;
      if (message.type === "run" || message.type === "evaluate" || message.type === "eventGrowth" || message.type === "eventGrowthPage") this.setPhase("computationMs");
      if (message.type === "run" && searchBudgetMs !== undefined)
        message = { ...message, request: { ...message.request, deadline: Math.min(message.request.deadline ?? Infinity, clock() + searchBudgetMs) } };
      return (await this.call({ ...message, loadedCharts, ...(message.type === "run" && Number.isFinite(preparation?.floor) ? { initialFloor: preparation!.floor } : {}), ...(preparation?.reward ? { initialReward: preparation.reward } : {}) }, progress, snapshot, eventGrowth)) as T;
    } finally {
      if (this.preparing === preparation) this.preparing = null;
      if (worker === this.worker && this.pending.size === 0) this.setPhase(null);
    }
  }
  /** Calls in flight; 0 when idle. */
  get load() {
    return this.pending.size + Number(this.preparing !== null && this.runId === null);
  }
  get started() {
    return this.ready !== null;
  }
  hasChart(key: string) { return this.cachedCharts.includes(key); }
  /** Starts the Worker and compiles the release ahead of the first call. */
  warm(): Promise<void> {
    return this.spawn().catch(() => {});
  }
  async preload(songs: readonly SongRef[]): Promise<EngineChart[]> {
    await this.spawn();
    this.setPhase("networkMs");
    try {
      return await this.downloads.loadMany(songs);
    } finally {
      this.setPhase(null);
    }
  }
  cancel() {
    for (const pending of this.pending.values()) pending.reject(new DOMException("Cancelled", "AbortError"));
    this.pending.clear();
    this.reset();
  }
  private reset() {
    this.scoredSeeds = [];
    this.cachedCharts = [];
    this.chartCacheLimit = 4;
    this.preparing = null;
    this.runId = null;
    this.eventGrowthId = null;
    this.cooperativeFloor = false;
    this.cooperativeReward = false;
    this.setPhase(null);
    this.worker?.terminate();
    this.worker = null;
    this.ready = null;
  }
}

type DeferredHit = EngineHit & { pendingScores?: true };
const pendingScores = (hit: EngineHit) => (hit as DeferredHit).pendingScores === true;
const memberSet = (hit: EngineHit) => memberSetKey(hit.members);
const exactTeam = (hit: EngineHit) => JSON.stringify([hit.song?.songId, hit.song?.difficulty, hit.members, hit.snaps, hit.power, hit.key]);
/** Keep every variant tied at the distinct-member primary boundary until its mean is known. */
function completionCandidates(hits: readonly EngineHit[], k: number): EngineHit[] {
  const primary = new Map<string, number>();
  for (const hit of hits) primary.set(memberSet(hit), Math.max(primary.get(memberSet(hit)) ?? -Infinity, hit.key));
  const keys = [...primary.values()].sort((a, b) => b - a);
  const floor = keys[k - 1] ?? -Infinity;
  const candidates = new Map<string, EngineHit>();
  for (const hit of hits) {
    if (hit.key < floor || hit.key !== primary.get(memberSet(hit))) continue;
    const key = exactTeam(hit);
    const old = candidates.get(key);
    if (!old || pendingScores(old) && !pendingScores(hit)) candidates.set(key, hit);
  }
  return [...candidates.values()];
}
function primarySeeds(hits: readonly EngineHit[], k: number): EngineHit[] {
  const seen = new Set<string>();
  return [...hits].sort((a, b) => b.key - a.key || (!pendingScores(a) && !pendingScores(b) ? compareHits(a, b) : 0)).filter(hit => {
    const key = memberSet(hit);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, k);
}
function scoredResponse(response: EngineResponse): EngineResponse {
  return { ...response, results: response.results.map(result => ({ ...result,
    hits: result.hits.filter(hit => !pendingScores(hit)),
    proven: result.proven && !result.hits.some(pendingScores),
  })), overall: response.overall.filter(hit => !pendingScores(hit)) };
}

/** How many Workers share a search: the device's cores, minus one for the page, at most six. */
const poolSize = () => {
  const nav = typeof navigator !== "undefined" ? (navigator as Navigator & { deviceMemory?: number }) : null;
  const cores = nav?.hardwareConcurrency || 4;
  // A searching Worker's heap grows to a few hundred MB, and a phone browser discards a tab long before a desktop
  // one does. Browsers that do not report memory (Safari, Firefox) are sized by form factor alone.
  const phone = !!nav && (/Android|iPhone|iPad|iPod|Mobile/u.test(nav.userAgent) || (nav.maxTouchPoints > 1 && /Macintosh/u.test(nav.userAgent)));
  const memory = nav?.deviceMemory ?? (phone ? 2 : 8);
  const limit = memory <= 2 ? 2 : memory <= 4 ? 3 : phone ? 4 : 6;
  return Math.max(1, Math.min(limit, cores - 1));
};
/** Below this many members a single Worker finishes before the others would compile the release. */
const PARALLEL_MIN_MEMBERS = 15;
const SINGLE_WORKER_COMBO_COMBINATIONS = 66;

function smallComboDomain(request: EngineRequest): boolean {
  if (!request.constraints.noSnaps) return false;
  const required = new Set(request.constraints.requiredMembers);
  if (required.size > 5 || [...required].some(key => !request.members.some(member => member.key === key))) return false;
  const open = 5 - required.size;
  const available = request.members.length - required.size;
  if (available < open) return true;
  let combinations = 1;
  for (let i = 1; i <= open; i++) combinations = combinations * (available - i + 1) / i;
  return combinations <= SINGLE_WORKER_COMBO_COMBINATIONS;
}
/** How long one Worker tries before a search fans out over the pool. */
const QUICK_MS = 700;
/** Leader shards per Worker: enough for the free Workers to even out uneven subtrees. */
const SHARDS_PER_WORKER = 4;

function requestMissions(data: TeamBuilderData, request: EngineRequest, song: SongRef): number[] {
  const original = objectRow(data.songs[String(song.songId)]?.gekisou).missionTypes;
  const arena = request.goal.kind === "gekiso" ? request.goal.arena : undefined;
  return [0, 1, 2].map(index => arena?.missions[index] || request.songRules?.missions[index]
    || (Array.isArray(original) ? original[index] : 0));
}

function wholeSongReward(data: TeamBuilderData, request: EngineRequest): boolean {
  const goal = request.goal;
  if (request.k !== 1 || goal.kind !== "event" || !goal.gekiso || goal.songs.length !== 1) return false;
  return requestMissions(data, request, goal.songs[0]!).every(mission => mission === 2 || mission === 3);
}

function weightedLiveReward(request: EngineRequest): boolean {
  const goal = request.goal;
  return goal.kind === "event" && !goal.gekiso && goal.route !== "skip"
    && goal.measure !== "challenge-points" && !!goal.weights
    && request.k === 1 && goal.songs.length === 1;
}
function wholeChallengeReward(request: EngineRequest): boolean {
  const goal = request.goal;
  if (goal.kind !== "event" || goal.gekiso || goal.route !== "challenge" || goal.songs.length !== 1) return false;
  const play = goal.play;
  return request.k > 1 || !!goal.rewardPlan?.tieBreak && !play?.great && !play?.good && !play?.bad
    && !play?.miss && !play?.missEvery && !play?.mistakes?.indices.length && !play?.cumulativeTiming;
}
function phasedReward(data: TeamBuilderData, request: EngineRequest): boolean {
  if (request.goal.kind === "event" && request.goal.rewardPlan) return false;
  if (weightedLiveReward(request)) return true;
  const goal = request.goal;
  if (request.k !== 1 || goal.kind !== "event" || !goal.gekiso || goal.songs.length !== 1) return false;
  return requestMissions(data, request, goal.songs[0]!).every(mission => mission === 1);
}

/** Main-thread handle on the engine Workers. A search is split by leader over a pool of Workers and merged; cancelling
 * replaces every Worker, so a long search never blocks. */
export class EngineClient {
  private readonly pool: EngineWorker[];
  private readonly dataIdentity: string;
  private readonly downloads: EngineCharts;
  constructor(private readonly data: TeamBuilderData, changed: () => void = () => {}, options: { maxWorkers?: number; apiBase?: string; charts?: readonly EngineChart[] } = {}) {
    this.dataIdentity = JSON.stringify([data.identity, data.crossServer?.identities]);
    const serialized = workerData(data);
    const charts: EngineChartSources = {};
    for (const song of Object.values(data.songs)) {
      const id = Number(song.musicId);
      const identity = teamBuilderSourceIdentity(data, "songs", id);
      for (const row of dataRows(song.difficulty)) {
        const key = `${id}:${Number(row.difficulty)}`;
        charts[key] ??= { identity, file: typeof row.file === "string" ? row.file : "", ...(options.apiBase ? { apiBase: options.apiBase } : {}) };
      }
    }
    this.downloads = new EngineCharts(charts);
    if (options.charts) this.downloads.prime(options.charts);
    const size = options.maxWorkers ?? poolSize();
    if (!Number.isInteger(size) || size < 1 || size > 8) throw new RangeError("maxWorkers must be between 1 and 8");
    this.pool = Array.from({ length: size }, (_, index) => new EngineWorker(serialized, charts, this.downloads, `team-engine-${index + 1}`, changed));
  }
  get phases() { return [...new Set(this.pool.map(worker => worker.currentPhase).filter((phase): phase is NonNullable<typeof phase> => phase !== null))]; }
  prefetch(songs: readonly SongRef[]) {
    this.downloads.prefetch(songs);
  }
  /** Warm the requested part of the pool after the first Worker is ready. */
  warm(count = this.pool.length) {
    // The others compile once the first is ready, so the first search can use every Worker.
    const generation = this.generation;
    void this.pool[0]?.warm().then(() => {
      if (generation === this.generation) for (const worker of this.pool.slice(1, count)) void worker.warm();
    });
  }
  /** The idlest Worker, preferring one that has already compiled the release. */
  private idlest(pool = this.pool) {
    return [...pool].sort((a, b) => a.load - b.load || Number(b.started) - Number(a.started))[0]!;
  }
  private queue: Promise<unknown> = Promise.resolve();
  private readonly activeStops = new Set<(reason: StopReason) => void>();
  private generation = 0;
  private completed: { key: string; response: EngineResponse } | null = null;
  private responseKey(request: EngineRequest): string | null {
    if (request.k > 5 || request.members.length > 256 || request.snaps.length > 256 || requestSongs(request).length > 4
      || request.shard || request.noFloor || request.seedOnly || request.seedVariant || request.seeded || request.rewardPhase || request.certifyRewardRanks
      || request.resolveRewardPlan || request.floors || request.rewardIncumbent || request.cutoff || request.rewardCutoff !== undefined || request.completed?.length) return null;
    const { timeLimitMs: _time, deadline: _deadline, requestId: _id, contextKey: _context, ...input } = request;
    return JSON.stringify(["native-window-coverage-v1", input]);
  }

  run(request: EngineRequest, progress?: Pending["progress"], snapshot?: Pending["snapshot"], onFinalResult?: FinalResultHandler): Promise<EngineResponse> {
    request = singleSongRequest(request);
    const started = clock();
    const generation = this.generation;
    const task = { ...request, timeLimitMs: null, deadline: deadlineOf(request), requestId: request.requestId ?? crypto.randomUUID(), contextKey: request.contextKey ?? JSON.stringify([this.dataIdentity, request]) };
    let expired = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const waiting = new Promise<EngineResponse>(resolve => {
      if (Number.isFinite(task.deadline)) timer = setTimeout(() => {
        expired = true;
        const response = { ...emptyResponse(task), stopReason: "budget" as const, elapsedMs: clock() - started };
        snapshot?.({ requestId: task.requestId, contextKey: task.contextKey, response, stopReason: "budget", coverage: { completed: 0, total: response.results.length } });
        resolve(response);
      }, remaining(task.deadline));
    });
    const queued = this.queue.then(() => {
      clearTimeout(timer);
      if (expired || generation !== this.generation) return { ...emptyResponse(task), stopReason: expired ? "budget" as const : "cancelled" as const };
      const key = onFinalResult ? null : this.responseKey(task);
      if (key !== null && key === this.completed?.key && remaining(task.deadline) > 0) {
        const response = structuredClone(this.completed.response);
        response.elapsedMs = clock() - started;
        response.timing = { initializationMs: 0, networkMs: 0, computationMs: 0, wallMs: response.elapsedMs };
        progress?.(response.results.length, response.results.length);
        snapshot?.({ requestId: task.requestId, contextKey: task.contextKey, response, stopReason: "complete",
          coverage: { completed: response.results.length, total: response.results.length } });
        return response;
      }
      return this.execute(task, started, progress, snapshot, onFinalResult, key);
    });
    this.queue = queued.catch(() => {});
    return Promise.race([queued, waiting]).finally(() => clearTimeout(timer));
  }

  /** Independent complete scenarios share the existing Worker pool and the normal request pipeline. */
  runBatch(requests: readonly EngineRequest[], onResult?: (index: number, response: EngineResponse) => void): Promise<EngineResponse[]> {
    if (!requests.length) return Promise.resolve([]);
    const started = clock();
    const generation = this.generation;
    const tasks = requests.map(input => {
      const request = singleSongRequest(input);
      return { ...request, timeLimitMs: null, deadline: deadlineOf(request),
        requestId: request.requestId ?? crypto.randomUUID(), contextKey: request.contextKey ?? JSON.stringify([this.dataIdentity, request]) };
    });
    return this.enqueue(async () => {
      const responses: EngineResponse[] = new Array(tasks.length);
      let next = 0;
      let failed = false;
      let failure: unknown;
      const consume = async (worker: EngineWorker) => {
        try {
          while (!failed && generation === this.generation && next < tasks.length) {
            const index = next++;
            const response = await this.execute(tasks[index]!, started, undefined, undefined, undefined, null, [worker]);
            responses[index] = response;
            onResult?.(index, response);
            if (generation !== this.generation) throw new DOMException("Cancelled", "AbortError");
          }
        } catch (error) {
          if (!failed) {
            failed = true;
            failure = error;
            for (const stop of this.activeStops) stop("cancelled");
            this.downloads.cancel();
          }
          throw error;
        }
      };
      await Promise.allSettled(this.pool.slice(0, Math.min(tasks.length, this.pool.length)).map(consume));
      if (failed) throw failure;
      if (generation !== this.generation) throw new DOMException("Cancelled", "AbortError");
      return responses;
    });
  }

  private async execute(request: EngineRequest, started: number, progress?: Pending["progress"], snapshot?: Pending["snapshot"], onFinalResult?: FinalResultHandler, responseKey: string | null = null, pool = this.pool): Promise<EngineResponse> {
    const justWindow = request.goal.kind === "gekiso" ? request.goal.justWindow?.minimumMs ?? request.goal.minJustWindowMs
      : request.goal.kind === "event" ? request.goal.gekiso?.justWindow?.minimumMs ?? request.goal.gekiso?.minJustWindowMs : undefined;
    if (justWindow && justWindow > 0) request = { ...request, noFloor: true };
    const idlest = () => this.idlest(pool);
    const before = pool.map(worker => worker.timing());
    let latest = emptyResponse(request);
    if (request.seeds?.length) {
      for (const result of latest.results) result.hits = request.seeds.filter(hit => hit.song?.songId === result.song?.songId && hit.song?.difficulty === result.song?.difficulty).slice(0, request.k);
      latest.overall = latest.results.flatMap(result => result.hits).sort(compareHits).slice(0, request.k);
    }
    let stopped = false;
    let lastShown = -Infinity;
    let publishTimer: ReturnType<typeof setTimeout> | undefined;
    const joint = request.aggregation === "mean" || request.goal.kind === "gekiso" && request.goal.arena?.mode === "shared";
    const canPartition = !onFinalResult && request.members.length >= PARALLEL_MIN_MEMBERS;
    const partitioned = canPartition && canPartitionEvent(request);
    const snapshotInterval = partitioned ? 250 : joint ? Math.min(1000, Math.max(100, requestChartSongs(request).length * 20)) : 100;
    let cpChallenge: EngineHit | undefined;
    const showLatest = () => {
      clearTimeout(publishTimer);
      publishTimer = undefined;
      if (stopped) return;
      lastShown = clock();
      snapshot?.({ requestId: request.requestId!, contextKey: request.contextKey!, response: latest, stopReason: latest.stopReason,
        coverage: { completed: latest.results.filter(result => result.proven || result.exclusion).length, total: latest.results.length } });
    };
    const publish = (response: EngineResponse, force = false) => {
      if (stopped) return;
      if (response.cpChallenge) cpChallenge = response.cpChallenge;
      if (cpChallenge) response.cpChallenge = cpChallenge;
      const hadCandidate = latest.overall.length > 0;
      for (const result of response.results) {
        const previous = latest.results.find(part => part.song?.songId === result.song?.songId && part.song?.difficulty === result.song?.difficulty);
        if (previous && !result.proven) {
          const seen = new Set<string>();
          result.hits = [...result.hits, ...previous.hits].sort(compareHits).filter(hit => {
            const key = memberSet(hit);
            if (seen.has(key)) return false;
            seen.add(key); return true;
          }).slice(0, request.k);
        }
      }
      response.overall = response.results.flatMap(result => result.hits).sort(compareHits).slice(0, request.k);
      latest = response;
      latest.timing = pool.reduce((total, worker, index) => {
        const timing = worker.timing();
        for (const field of ["initializationMs", "networkMs", "computationMs"] as const) total[field] += timing[field] - before[index]![field];
        return total;
      }, { initializationMs: 0, networkMs: 0, computationMs: 0, wallMs: clock() - started });
      latest.elapsedMs = clock() - started;
      if (!force && (hadCandidate || !latest.overall.length) && clock() - lastShown < snapshotInterval) {
        if (snapshot && publishTimer === undefined) publishTimer = setTimeout(showLatest, snapshotInterval - (clock() - lastShown));
        return;
      }
      if (force && responseKey !== null && latest.results.length <= 4 && latest.stopReason === "complete" && !latest.error && completeResponse(latest)) {
        this.completed = { key: responseKey, response: structuredClone(latest) };
      }
      showLatest();
    };
    let wakeWork: (() => void) | undefined;
    let partitionProgress: (() => EngineResponse) | undefined;
    let stop!: (reason: StopReason) => void;
    const interrupted = new Promise<EngineResponse>(resolve => {
      stop = reason => {
        if (stopped) return;
        publish({ ...(partitionProgress?.() ?? latest), stopReason: reason }, true);
        stopped = true;
        wakeWork?.();
        if (pool === this.pool) this.downloads.cancel();
        for (const worker of pool) worker.cancel();
        resolve(latest);
      };
    });
    this.activeStops.add(stop);
    const deadline = request.deadline!;
    const timer = Number.isFinite(deadline) ? setTimeout(() => stop("budget"), remaining(deadline)) : undefined;
    const accept = (value: EngineSnapshot) => {
      if (!stopped && value.requestId === request.requestId && value.contextKey === request.contextKey) publish(value.response);
    };
    const work = async (): Promise<EngineResponse> => {
      if (!remaining(deadline)) { stop("budget"); return latest; }
      if (completeResponse(latest)) return latest;
      if (request.goal.kind === "event" && request.goal.rewardPlan?.autoCp) {
        const resolved = await idlest().send<EngineResponse>({ type: "run", id: 0, request: { ...request, resolveRewardPlan: true } });
        if (stopped) return latest;
        if (!resolved.resolvedRewardPlan) return { ...latest, stopReason: resolved.stopReason ?? "budget" };
        cpChallenge = resolved.cpChallenge;
        if (cpChallenge) publish({ ...latest, cpChallenge }, true);
        request = { ...request, goal: { ...request.goal, rewardPlan: resolved.resolvedRewardPlan } };
      }
      const separateEvent = canPartition && canPartitionEvent(request) ? request : null;
      const sharedEvent = canPartition && request.goal.kind === "event" && canUseSharedEventRosters(this.data, request)
        ? { ...request, goal: request.goal } : null;
      if (separateEvent || sharedEvent) {
        const finished = () => stopped || !remaining(deadline);
        const workers = [...pool].sort((a, b) => Number(b.started) - Number(a.started));
        let sharedCharts: Promise<EngineChart[]> | undefined;
        const pending: { chart: string | null; run: (worker?: EngineWorker) => Promise<void> }[] = [];
        const dispatch = () => {
          if (finished()) {
            for (const job of pending.splice(0)) void job.run();
            return;
          }
          while (pending.length && workers.length) {
            let nextJob = 0;
            let nextWorker = 0;
            if (sharedEvent) {
              for (const [index, job] of pending.entries()) {
                if (job.chart === null) continue;
                const key = job.chart;
                const cached = workers.findIndex(worker => worker.hasChart(key));
                if (cached < 0) continue;
                nextJob = index;
                nextWorker = cached;
                break;
              }
            }
            const [worker] = workers.splice(nextWorker, 1);
            const [job] = pending.splice(nextJob, 1);
            void job!.run(worker!).finally(() => {
              workers.push(worker!);
              dispatch();
            });
          }
        };
        wakeWork = dispatch;
        const runBatch: PartitionBatch = async (jobs, onResult, onProgress, options) => {
          let failed = false;
          const active = () => !stopped && !failed && !options?.stopped?.();
          const batch = jobs.map((job, index) => new Promise<void>((resolve, reject) => {
            const charts = sharedEvent ? requestChartSongs(job) : [];
            pending.push({ chart: charts.length === 1 && charts[0] ? chartKey(charts[0]) : null,
              run: async worker => {
                try {
                  const budgetDeadline = options?.budgetMs === undefined ? Infinity : clock() + options.budgetMs;
                  const jobDeadline = Math.min(deadline, job.deadline ?? Infinity, budgetDeadline);
                  if (worker && active() && remaining(jobDeadline)) {
                    const loadedCharts = sharedEvent && job.aggregation === "mean"
                      ? await (sharedCharts ??= worker.preload(sharedEvent.goal.songs)) : undefined;
                    if (active() && remaining(jobDeadline)) {
                      const input = { ...job, deadline: jobDeadline };
                      const response = await worker.send<EngineResponse>({ type: "run", id: 0, request: input, loadedCharts }, undefined,
                        value => { if (active()) onProgress(value.response); });
                      if (active()) onResult(index, response);
                    }
                  }
                  resolve();
                } catch (error) {
                  failed = true;
                  reject(error);
                }
              },
            });
          }));
          dispatch();
          const settled = await Promise.allSettled(batch);
          const rejected = settled.find(result => result.status === "rejected");
          if (rejected) throw rejected.reason;
        };
        if (sharedEvent) {
          const result = await proveSharedEvent(this.data, sharedEvent, runBatch, publish, finished, pool.length);
          if (stopped) return latest;
          if (result) return result;
        } else if (separateEvent) {
          const goal = separateEvent.goal;
          if (goal.songs.length === 1) return partitionEvent(separateEvent, runBatch, publish, finished);

          const parts = [...latest.results];
          const unknown = new Set(latest.unknownCards);
          const response = (): EngineResponse => ({ ...latest, results: [...parts], overall: [], unknownCards: [...unknown] });
          partitionProgress = response;
          let done = parts.filter(part => part.proven).length;
          const firstPassWaves = Math.ceil((goal.songs.length - done) / pool.length);
          // FIFO gives each chart its first pass before refinement. Reserve one wave for that refinement.
          const firstPassBudgetMs = Number.isFinite(deadline) && firstPassWaves > 1 ? remaining(deadline) / (firstPassWaves + 1) : undefined;
          await Promise.all(goal.songs.map(async (song, index) => {
            if (parts[index]!.proven) return;
            const part: EngineRequest = { ...separateEvent, goal: { ...goal, songs: [song] }, completed: undefined, seeds: undefined };
            const update = (value: EngineResponse, final = false) => {
              if (stopped) return;
              parts[index] = value.results[0]!;
              for (const key of value.unknownCards) unknown.add(key);
              if (final || clock() - lastShown >= snapshotInterval) publish(response(), final);
            };
            const result = await partitionEvent(part, runBatch, update, finished, firstPassBudgetMs);
            if (!stopped) {
              update(result, true);
              progress?.(++done, goal.songs.length);
            }
          }));
          return response();
        }
      }
      if (request.goal.kind === "gekiso" && request.goal.arena?.objective === "sections") {
        const worker = pool[0]!;
        const loadedCharts = await worker.preload(request.goal.songs);
        if (stopped) return latest;
        const time = remaining(deadline);
        const budget = Number.isFinite(time) ? Math.max(1, time - Math.min(100, time / 10)) : undefined;
        const result = await worker.send<EngineResponse>({ type: "run", id: 0, loadedCharts, request }, undefined, accept, budget);
        if (stopped) return latest;
        publish(result, true);
        return result;
      }
      if ((request.aggregation === "mean" && (request.goal.kind === "score" || request.goal.kind === "event" || request.goal.kind === "gekiso")) || (request.goal.kind === "gekiso" && request.goal.arena?.mode === "shared")) {
        const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 4;
        const count = request.constraints.leader !== null ? 1 : Math.min(pool.length, memory <= 4 ? 1 : request.goal.kind === "gekiso" ? 6 : 2);
        const workers = pool.slice(0, count);
        const loadedCharts = await workers[0]!.preload(request.goal.songs);
        if (stopped) return latest;
        let sharedSeed: EngineHit | undefined;
        let sharedUnknown: string[] = [];
        if (count > 1 && request.k === 1 && request.goal.kind === "gekiso" && request.goal.songs.length >= 8
          && request.goal.seeds === 0 && request.goal.accuracy.great === 0 && !request.goal.accuracy.missEvery
          && !request.goal.justWindow && !(request.goal.minJustWindowMs ?? 0)
          && (request.goal.minComboBonus ?? 1) <= 1
          && request.goal.songs.every(song => requestMissions(this.data, request, song).every(type => type === 3))) {
          const goal = request.goal;
          const warm = await workers[0]!.send<EngineResponse>({ type: "run", id: 0, loadedCharts,
            request: { ...request, aggregation: undefined, seedOnly: true, seeded: undefined, shard: undefined, floors: undefined, completed: undefined, noFloor: true,
              deadline: Math.min(deadline, clock() + 80),
              goal: { ...goal, songs: [goal.songs[0]!], ...(goal.arena ? { arena: { ...goal.arena, mode: "individual" as const } } : {}) } } });
          if (stopped) return latest;
          sharedUnknown = warm.unknownCards;
          const team = warm.overall[0];
          if (team) {
            const evaluated = (await Promise.all(workers.map((worker, index) => worker.send<TeamEvaluation[]>({
              type: "evaluate", id: 0, loadedCharts,
              request: { songRules: request.songRules, members: request.members, snaps: request.snaps, player: request.player, unknownPolicy: request.unknownPolicy,
                team: { members: team.members, snaps: team.snaps, leader: team.members[0]! },
                songs: goal.songs.filter((_, position) => position % count === index),
                play: { great: 0, good: 0, bad: 0, miss: 0 }, challengeEventId: null, event: null,
                gekiso: { accuracy: goal.accuracy, rank: goal.rank, ranks: goal.ranks, seeds: goal.seeds, arena: goal.arena, minJustWindowMs: goal.minJustWindowMs, justWindow: goal.justWindow } },
            })))).flat();
            if (stopped) return latest;
            const bySong = new Map(evaluated.map(value => [chartKey(value.song), value]));
            const songs: EngineHit[] = goal.songs.map(song => {
              const value = bySong.get(chartKey(song))!;
              return { ...team, song, power: value.power, slotPowers: value.slotPowers, key: value.score.mean,
                score: value.score, justWindow: value.justWindow, event: null, skipScore: value.skipScore, potential: null };
            });
            const average = (value: (hit: EngineHit) => number) => songs.reduce((sum, hit) => sum + value(hit), 0) / songs.length;
            sharedSeed = evaluated.every(value => value.justWindow?.meetsTarget !== false) ? { ...team, song: null, key: average(hit => hit.score!.mean), power: average(hit => hit.power),
              slotPowers: team.slotPowers.map((_, index) => average(hit => hit.slotPowers[index]!)),
              score: { mean: average(hit => hit.score!.mean), min: average(hit => hit.score!.min), max: average(hit => hit.score!.max),
                median: average(hit => hit.score!.median), orders: [], ranks: {}, bestOrder: [], worstOrder: [] },
              event: null, skipScore: null, potential: null, aggregate: { kind: "mean", songs } } : undefined;
          }
        }
        const parts = workers.map(() => emptyResponse(request));
        const merged = () => {
          const response = mergeShardResponses(parts, request.k, clock() - started);
          response.unknownCards = [...new Set([...sharedUnknown, ...response.unknownCards])];
          if (sharedSeed && (!response.overall[0] || compareHits(sharedSeed, response.overall[0]) < 0)) {
            response.overall = [sharedSeed];
            response.results[0]!.hits = [sharedSeed];
          }
          return response;
        };
        const publishShared = () => {
          const response = merged();
          const hit = response.overall[0];
          if (request.goal.kind === "gekiso" && request.k === 1 && hit)
            for (const worker of workers) worker.raiseFloor(hit.key);
          publish(response);
        };
        if (sharedSeed) publishShared();
        if (stopped) return latest;
        await Promise.all(
          workers.map(async (worker, index) => {
            const part = { ...request, ...(count > 1 ? { shard: { index, count } } : {}),
              ...(sharedSeed ? { seeded: true, seeds: [sharedSeed], floors: { [chartKey(request.goal.kind === "gekiso" ? request.goal.songs[0]! : requestChartSongs(request)[0]!)]: sharedSeed.key } } : {}) };
            parts[index] = await worker.send<EngineResponse>(
              { type: "run", id: 0, request: part, loadedCharts },
              undefined,
              (value) => {
                if (stopped || value.requestId !== request.requestId || value.contextKey !== request.contextKey) return;
                parts[index] = value.response;
                publishShared();
              },
            );
            if (!stopped) publishShared();
          }),
        );
        return merged();
      }
      // Plan shards keep their tuple bounds and lottery state throughout the proof.
      if (request.goal.kind === "event" && request.goal.rewardPlan && request.goal.gekiso)
        request = { ...request, noFloor: true };
      if (request.goal.kind === "event" && request.goal.gekiso && !request.rewardPhase && phasedReward(this.data, request))
        request = { ...request, rewardLexicographic: true };
      const opponents = request.goal.kind === "gekiso" && !!request.goal.opponents;
      const wholeReward = wholeSongReward(this.data, request);
      const parallelSampledReward = wholeReward
        && request.goal.kind === "event" && (request.goal.gekiso?.luckSamples ?? 0) >= 16 && request.constraints.leader === null;
      const wholeChallenge = wholeChallengeReward(request);
      const comboMean = request.goal.kind === "gekiso" && request.goal.songs.length === 1
        && request.goal.criterion === "mean" && request.goal.seeds === 0
        && requestMissions(this.data, request, request.goal.songs[0]!).every(mission => mission === 1);
      const singleWorkerCombo = comboMean && pool.filter(worker => worker.started).length <= 1 && smallComboDomain(request);
      const parallel = pool.length > 1 && (request.members.length >= PARALLEL_MIN_MEMBERS || parallelSampledReward) && request.goal.kind !== "plan" && !request.seedOnly
        && !wholeChallenge && !singleWorkerCombo
        && (!wholeReward || parallelSampledReward)
        && !(request.goal.kind === "gekiso" && request.goal.songs.length === 1 && (request.constraints.leader !== null || request.goal.opponents));
      if (!parallel) {
        const response = await idlest().send<EngineResponse>({ type: "run", id: 0, request }, progress, opponents ? undefined : accept);
        if (!stopped) onFinalResult?.({ requestId: request.requestId!, contextKey: request.contextKey!, response: structuredClone(response) });
        return response;
      }
      const songs = requestSongs(request);
      if (request.goal.kind === "gekiso" && !request.goal.opponents) {
        const goal = request.goal;
        const deferScores = goal.criterion === "max" && goal.seeds === 0 && request.k > 1;
        const count = request.constraints.leader ? 1 : pool.length;
        const sampledLive = ["mean", "max"].includes(goal.criterion) && goal.seeds >= 16 && request.k === 1;
        if (sampledLive && goal.criterion === "max") this.warm();
        const seedCount = goal.songs.length === 1 && goal.seeds > 1 && goal.criterion !== "mean" ? 2 : 1;
        const parts = [...latest.results];
        const completeScores = new Map<string, EngineHit>();
        const unknownCards = new Set(latest.unknownCards);
        const same = (song: SongRef) => (hit: { song: SongRef | null }) => hit.song?.songId === song.songId && hit.song?.difficulty === song.difficulty;
        const states = goal.songs.map((song, index) => {
          const part: EngineRequest = { ...request, goal: { ...goal, songs: [song] }, completed: undefined, seeds: request.seeds?.filter(same(song)) };
          const responses = Array.from({ length: count }, () => {
            const response = emptyResponse(part);
            response.results[0]!.hits = parts[index]!.hits;
            return response;
          });
          const warm = Array.from({ length: seedCount }, () => emptyResponse(part));
          return { request: part, responses, warm, scoredSeeds: new Map<EngineWorker, unknown[]>(), deferred: false, seeded: request.seeded === true, seedNext: 0, seedDone: 0, next: 0, finished: 0, running: 0, done: completeResponse({ ...latest, results: [parts[index]!] }) };
        });
        const merged = (): EngineResponse => ({ ...latest, results: [...parts], overall: [], unknownCards: [...unknownCards], elapsedMs: clock() - started });
        const waiters = new Set<() => void>();
        const warming = new Map<EngineWorker, number>();
        const activeScores = new Map<EngineWorker, { index: number; floor: number }>();
        const wake = () => { for (const resolve of waiters) resolve(); waiters.clear(); };
        wakeWork = wake;
        let failed = false;
        let done = states.filter(state => state.done).length * count;
        const progressTotal = states.length * (count + Number(deferScores));
        const take = (preferred: number) => {
          const ready = (index: number) => { const state = states[index]; return state && !state.done && state.seeded && state.next < count; };
          let index = ready(preferred) ? preferred : states.findIndex((_, index) => ready(index));
          if (index >= 0) {
            const state = states[index]!;
            state.running++;
            return { index, shard: state.next++, seed: null };
          }
          index = states.findIndex(state => !state.done && !state.seeded && state.seedNext < seedCount);
          if (index < 0) return null;
          const state = states[index]!;
          state.running++;
          return { index, shard: null, seed: state.seedNext++ };
        };
        const completeHit = async (engine: EngineWorker, job: { index: number; hit: EngineHit }) => {
          const hit = job.hit;
          const key = exactTeam(hit);
          const evaluations = await engine.send<TeamEvaluation[]>({ type: "evaluate", id: 0, request: {
            songRules: request.songRules,
            members: request.members, snaps: request.snaps, player: request.player, unknownPolicy: request.unknownPolicy,
            team: { members: hit.members, snaps: hit.snaps, leader: hit.members[0]! }, songs: [hit.song!],
            play: { great: 0, good: 0, bad: 0, miss: 0 }, gekiso: { accuracy: goal.accuracy, rank: goal.rank, ranks: goal.ranks, seeds: goal.seeds, arena: goal.arena, minJustWindowMs: goal.minJustWindowMs, justWindow: goal.justWindow },
            challengeEventId: null, event: null,
          } });
          if (stopped) return;
          const evaluation = evaluations[0]!;
          if (evaluation.score.max !== hit.key || evaluation.power !== hit.power || evaluation.justWindow?.meetsTarget === false) throw new Error("engine-score-completion-mismatch");
          const value: DeferredHit = { ...hit, score: evaluation.score };
          delete value.pendingScores;
          completeScores.set(key, value);
          const state = states[job.index]!;
          for (const response of state.responses) for (const part of response.results)
            part.hits = part.hits.map(candidate => completeScores.get(exactTeam(candidate)) ?? candidate);
          parts[job.index] = mergeShardResponses(state.responses.map(scoredResponse), request.k, clock() - started).results[0]!;
          publish(merged());
        };
        const run = async (engine: EngineWorker) => {
          let preferred = -1;
          while (!stopped && !failed && remaining(deadline) > 0) {
            const job = take(preferred);
            if (!job) {
              if (states.every(state => state.done)) return;
              await new Promise<void>(resolve => waiters.add(resolve));
              continue;
            }
            preferred = job.index;
            const state = states[job.index]!;
            const current = parts[job.index]!;
            const privateHits = deferScores ? primarySeeds(state.responses.flatMap(response => response.results[0]!.hits), request.k) : current.hits;
            const key = `${current.song!.songId}:${current.song!.difficulty}`;
            const floors = privateHits.length >= request.k ? { [key]: privateHits[request.k - 1]!.key } : {};
            const part: EngineRequest = { ...state.request, seeds: privateHits, floors,
              ...(job.shard === null ? { seedOnly: true, seedVariant: seedCount === 2 ? (job.seed === 0 ? "sample" as const : "quiet" as const) : undefined }
                : { seeded: true, seedOnly: false, seedVariant: undefined, shard: { index: job.shard, count } }) };
            const update = (response: EngineResponse) => {
              state.deferred ||= response.results.some(part => part.hits.some(pendingScores));
              if (state.deferred) for (const part of response.results) for (const hit of part.hits)
                if (!pendingScores(hit) && hit.score) completeScores.set(exactTeam(hit), hit);
              if (state.deferred) for (const part of response.results)
                part.hits = part.hits.map(hit => completeScores.get(exactTeam(hit)) ?? hit);
              for (const key of response.unknownCards) unknownCards.add(key);
              if (job.shard === null) {
                state.warm[job.seed!] = response;
                if (comboMean && !state.seeded && response.overall.length >= request.k) {
                  state.seeded = true;
                  for (const shard of state.responses) shard.results[0]!.hits = response.results[0]?.hits ?? [];
                  wake();
                }
                if (sampledLive && !request.noFloor && engine.supportsFloor && !state.seeded && response.overall.length >= request.k) {
                  state.seeded = true;
                  wake();
                }
                if (state.seeded && state.next > 0 && !sampledLive) return;
                parts[job.index] = mergeShardResponses(state.warm.map(scoredResponse), request.k, clock() - started).results[0]!;
              } else {
                state.responses[job.shard] = response;
                parts[job.index] = mergeShardResponses(state.responses.map(scoredResponse), request.k, clock() - started).results[0]!;
              }
              if (sampledLive && state.seeded && state.next > 0) {
                const warm = state.warm.flatMap(response => response.results[0]!.hits).sort(compareHits)[0];
                if (warm) for (const response of state.responses) {
                  const row = response.results[0]!;
                  row.hits = [...row.hits, warm].sort(compareHits).slice(0, 1);
                }
                parts[job.index] = mergeShardResponses(state.responses.map(scoredResponse), request.k, clock() - started).results[0]!;
              }
              const best = parts[job.index]!.hits[0];
              if (sampledLive && best) for (const [worker, running] of activeScores)
                if (running.index === job.index && best.key > running.floor && worker.raiseFloor(best.key)) running.floor = best.key;
              publish(merged());
            };
            if (job.shard === null) warming.set(engine, job.index);
            else activeScores.set(engine, { index: job.index, floor: Math.max(-Infinity, ...Object.values(floors)) });
            try {
              const response = await engine.send<EngineResponse>({ type: "run", id: 0, request: part, deferScores,
                scoredSeeds: [...state.scoredSeeds.values()].flat() }, undefined, value => {
                if (!stopped && value.contextKey === request.contextKey && value.requestId === request.requestId) update(value.response);
              });
              if (stopped) return;
              state.scoredSeeds.set(engine, engine.scoredSeeds);
              update(response);
              if (job.shard === null) {
                state.seedDone++;
                if (!state.seeded) {
                  const warm = mergeShardResponses(state.warm, request.k, clock() - started);
                  state.seeded = state.seedDone === seedCount || warm.overall.length >= request.k;
                  state.done = state.seeded && completeResponse(warm);
                  if (state.done) {
                    done += count;
                    state.finished = count;
                    state.responses.fill(warm);
                  } else for (const shard of state.responses) shard.results[0]!.hits = warm.results[0]?.hits ?? [];
                }
              } else {
                done++;
                state.done = ++state.finished === count;
              }
              if (state.done) for (const [worker, index] of warming)
                if (index === job.index && worker !== engine) worker.cancel();
              progress?.(done / progressTotal, 1);
            } catch (error) {
              if (!stopped && job.shard === null && state.done) continue;
              failed = true;
              throw error;
            } finally {
              activeScores.delete(engine);
              warming.delete(engine);
              state.running--;
              wake();
            }
          }
        };
        await Promise.all(pool.map(run));
        if (!stopped && deferScores) {
          for (const state of states) for (const response of state.responses) for (const part of response.results)
            part.hits = part.hits.map(hit => completeScores.get(exactTeam(hit)) ?? hit);
          const jobs = states.flatMap((state, index) => completionCandidates(state.responses.flatMap(response => response.results[0]!.hits), request.k)
            .filter(pendingScores).map(hit => ({ index, hit })));
          let next = 0;
          const finish = async (engine: EngineWorker) => {
            while (!stopped && remaining(deadline) > 0 && next < jobs.length) {
              const job = jobs[next++]!;
              await completeHit(engine, job);
            }
          };
          await Promise.all(pool.map(finish));
          if (!stopped) for (const [index, state] of states.entries()) {
            const unfinished = completionCandidates(state.responses.flatMap(response => response.results[0]!.hits), request.k).some(pendingScores);
            const rows = state.responses.map(response => ({ ...response, results: response.results.map(part => ({ ...part,
              hits: part.hits.filter(hit => !pendingScores(hit)), proven: part.proven && !unfinished,
            })) }));
            parts[index] = mergeShardResponses(rows, request.k, clock() - started).results[0]!;
            if (!unfinished) progress?.(++done / progressTotal, 1);
          }
        }
        const response = merged();
        if (!aspirationHeld(response, request.k) && !request.noFloor && remaining(deadline))
          return idlest().send<EngineResponse>({ type: "run", id: 0, request: { ...request, seeds: parts.flatMap(part => part.hits), seeded: true, noFloor: true } }, progress, accept);
        return response;
      }
      if (songs.length > 1 && songs.every((song): song is SongRef => song !== null)) {
        // Songs run whole, side by side: a Worker keeps only the current song's chart, seeds and contexts, and
        // shards that each walked the whole list would prepare every song once per shard. Each song gets an even
        // share of the time left, so every song has teams when the deadline arrives.
        const same = (song: SongRef) => (hit: { song: SongRef | null }) => hit.song?.songId === song.songId && hit.song?.difficulty === song.difficulty;
        const parts = latest.results.map(result => result);
        const merged = (): EngineResponse => ({ ...latest, results: [...parts], overall: [], elapsedMs: clock() - started });
        let next = 0, done = 0;
        const runSong = async (engine: EngineWorker) => {
          while (!stopped && remaining(deadline) > 0 && next < songs.length) {
            const index = next++;
            const song = songs[index]!;
            if (parts[index]!.proven) { progress?.(++done / songs.length, 1); continue; }
            const share = remaining(deadline) * pool.length / (songs.length - index);
            const part: EngineRequest = {
              ...request,
              goal: { ...request.goal, songs: [song] } as EngineRequest["goal"],
              deadline: Math.min(deadline, clock() + share),
              seeds: request.seeds?.filter(same(song)),
              completed: request.completed?.filter(same(song)),
            };
            const response = await engine.send<EngineResponse>({ type: "run", id: 0, request: part }, undefined, value => {
              if (opponents) return;
              if (stopped || value.contextKey !== request.contextKey || value.requestId !== request.requestId) return;
              parts[index] = value.response.results[0] ?? parts[index]!;
              publish(merged());
            });
            if (stopped) return;
            parts[index] = response.results[0] ?? parts[index]!;
            publish(merged());
            progress?.(++done / songs.length, 1);
          }
        };
        await Promise.all(pool.map(runSong));
        return merged();
      }
      if (request.goal.kind === "gekiso")
        return idlest().send<EngineResponse>({ type: "run", id: 0, request }, progress, accept);
      const rewardScores = new Map<EngineWorker, unknown[]>();
      const runShards = async (request: EngineRequest, publish: (response: EngineResponse) => void, stage = -1): Promise<EngineResponse> => {
        const stageProgress: Pending["progress"] = stage < 0 ? progress
          : (done, total) => progress?.((stage + done / total) / 3, 1);
        const acceptPart = (value: EngineSnapshot) => {
          if (!stopped && value.requestId === request.requestId && value.contextKey === request.contextKey) publish(value.response);
        };
        let seeds = request.seeds ?? [];
        let quickWorker: EngineWorker | null = null;
        let quickWork: Promise<EngineResponse> | null = null;
        let acceptQuick = (response: EngineResponse) => publish(response);
        let rewardBest: EngineHit | undefined;
        const observeReward = (response: EngineResponse) => {
          if (!request.rewardLexicographic) return;
          const hit = response.overall[0];
          if (hit?.score?.orders.length !== 120 || pendingScores(hit)) return;
          if (!rewardBest || compareHits(hit, rewardBest) < 0) rewardBest = hit;
        };
        if (!request.noFloor && !(parallelSampledReward && request.members.length < PARALLEL_MIN_MEMBERS) && stage <= 0) {
          quickWorker = idlest();
          let quick: EngineResponse;
          const quickResponse = (response: EngineResponse): EngineResponse => request.rewardLexicographic ? {
            ...response, stopReason: undefined,
            results: response.results.map(({ rewardPhase: _phase, ...part }) => ({ ...part, proven: false })),
          } : response;
          const message = { type: "run" as const, id: 0, request: request.rewardLexicographic
            ? { ...request, rewardPhase: { kind: "primary" as const } }
            : { ...request, deadline: Math.min(deadline, clock() + QUICK_MS) } };
          if (request.rewardLexicographic) {
            this.warm();
            let firstSeed!: (response: EngineResponse) => void;
            const seeded = new Promise<EngineResponse>(resolve => { firstSeed = resolve; });
            acceptQuick = response => {
              observeReward(response);
              publish(response);
              if (quickWorker!.supportsReward && response.overall.length >= request.k) firstSeed(response);
            };
            quickWork = quickWorker.send<EngineResponse>(message, stageProgress, value => {
              if (!stopped && value.requestId === request.requestId && value.contextKey === request.contextKey) acceptQuick(quickResponse(value.response));
            }, QUICK_MS).then(response => {
              rewardScores.set(quickWorker!, quickWorker!.scoredSeeds);
              const value = quickResponse(response);
              if (!stopped) acceptQuick(value);
              return value;
            });
            quick = await Promise.race([quickWork, seeded]);
          } else {
            quick = await quickWorker.send<EngineResponse>(message, stageProgress, acceptPart);
          }
          for (const worker of pool) if (worker.scoredSeeds.length) rewardScores.set(worker, worker.scoredSeeds);
          observeReward(quick);
          publish(quick);
          if (completeResponse(quick)) return quick;
          seeds = quick.results.flatMap(result => result.hits);
        }
        const valueOf = (hit: EngineHit) => request.rewardPhase?.kind === "other" ? hit.event?.otherMean ?? 0
          : request.rewardPhase?.kind === "score" ? hit.score?.mean ?? 0 : hit.key;
        const sampledRewards = request.goal.kind === "event" && request.goal.gekiso;
        const workers = pool;
        const count = sampledRewards
          ? (request.constraints.leader ? 1 : workers.length)
          : workers.length * SHARDS_PER_WORKER;
        const responses = Array.from({ length: count }, () => emptyResponse(request));
        for (const response of responses) for (const result of response.results)
          result.hits = seeds.filter(hit => hit.song?.songId === result.song?.songId && hit.song?.difficulty === result.song?.difficulty).slice(0, request.k);
        let next = 0, done = 0;
        const merge = () => {
          if (rewardBest) for (const response of responses) for (const result of response.results)
            if (result.song?.songId === rewardBest.song?.songId && result.song?.difficulty === rewardBest.song?.difficulty)
              result.hits = [...result.hits, rewardBest].sort(compareHits).slice(0, request.k);
          return mergeShardResponses(responses, request.k, clock() - started);
        };
        const active = new Map<EngineWorker, { floor: number; retry: boolean }>();
        if (quickWork) acceptQuick = response => {
          observeReward(response);
          publish(merge());
          if (rewardBest) for (const [worker, running] of active)
            if (!running.retry && worker.raiseReward(rewardBest)) running.floor = Math.max(running.floor, rewardBest.key);
        };
        const runShard = async (engine: EngineWorker) => {
          if (engine === quickWorker && quickWork) await quickWork;
          while (!stopped && remaining(deadline) > 0 && next < count) {
            const index = next++;
            while (!stopped && remaining(deadline) > 0) {
              const current = merge();
              const floors = Object.fromEntries(current.results.filter(result => result.song && result.hits.length >= request.k).map(result => [`${result.song!.songId}:${result.song!.difficulty}`, valueOf(result.hits[request.k - 1]!)]));
              const job = { floor: Math.max(-Infinity, ...Object.values(floors)), retry: false };
              active.set(engine, job);
              let response: EngineResponse;
              try {
                const rewardPhase = request.rewardPhase && request.rewardPhase.kind !== "primary"
                  ? { ...request.rewardPhase, floor: job.floor } : request.rewardPhase;
                response = await engine.send<EngineResponse>({ type: "run", id: 0, scoredSeeds: [...rewardScores.values()].flat(), request: { ...request, rewardPhase,
                  seeded: sampledRewards || request.rewardPhase ? current.overall.length > 0 : request.seeded,
                  seeds: sampledRewards ? current.overall : seeds, shard: { index, count }, floors: rewardPhase && rewardPhase.kind !== "primary" ? undefined : floors,
                  ...(rewardBest ? { rewardIncumbent: rewardFloor(rewardBest) } : {}) } }, undefined, value => {
                  if (stopped || job.retry || active.get(engine) !== job || value.contextKey !== request.contextKey || value.requestId !== request.requestId) return;
                  const hit = value.response.overall[request.k - 1];
                  observeReward(value.response);
                  if (hit) job.floor = Math.max(job.floor, valueOf(hit));
                  responses[index] = value.response;
                  publish(merge());
                  if (rewardBest) {
                    for (const [worker, running] of active)
                      if (!running.retry && worker.raiseReward(rewardBest)) running.floor = Math.max(running.floor, rewardBest.key);
                  } else if (hit) for (const [worker, running] of active)
                    if (!running.retry && valueOf(hit) > running.floor && worker.raiseFloor(valueOf(hit))) running.floor = valueOf(hit);
                });
                rewardScores.set(engine, engine.scoredSeeds);
              } catch (error) {
                if (job.retry && !stopped) continue;
                throw error;
              } finally {
                active.delete(engine);
              }
              if (stopped) return;
              observeReward(response);
              responses[index] = response;
              publish(merge());
              stageProgress?.(++done / count, 1);
              if (rewardBest) {
                for (const [worker, running] of active)
                  if (!running.retry && worker.raiseReward(rewardBest)) running.floor = Math.max(running.floor, rewardBest.key);
              } else if (sampledRewards && !request.noFloor && completeResponse(response)) {
                const hit = response.overall[request.k - 1];
                const floor = hit ? valueOf(hit) : -Infinity;
                for (const [worker, running] of active) if (!running.retry && floor > running.floor) {
                    if (worker.raiseFloor(floor)) running.floor = floor;
                  else { running.retry = true; worker.cancel(); }
                }
              }
              break;
            }
          }
        };
        await Promise.all(workers.map(runShard));
        const merged = merge();
        if (!aspirationHeld(merged, request.k) && !request.noFloor && remaining(deadline))
          return idlest().send<EngineResponse>({ type: "run", id: 0, request: { ...request, seeds: merged.overall, noFloor: true } }, stageProgress, acceptPart);
        return merged;
      };
      if (request.rewardLexicographic || !phasedReward(this.data, request)) return runShards(request, publish);
      let seeds = request.seeds ?? [];
      let response = emptyResponse(request);
      for (const kind of ["primary", "other", "score"] as const) {
        if (stopped || !remaining(deadline)) return latest;
        const best = seeds[0];
        const rewardPhase: EngineRequest["rewardPhase"] = kind === "primary" ? { kind }
          : kind === "other" ? { kind, reward: best!.key }
          : { kind, reward: best!.key, other: best!.event?.otherMean ?? 0 };
        const publicResponse = (response: EngineResponse): EngineResponse => ({ ...response,
          results: response.results.map(({ rewardPhase: _phase, ...part }) => ({ ...part, bound: null,
            proven: kind === "score" && part.proven })),
        });
        response = await runShards({ ...request, seeds, rewardPhase, completed: undefined },
          response => publish(publicResponse(response)), kind === "primary" ? 0 : kind === "other" ? 1 : 2);
        if (stopped) return latest;
        if (!completeResponse(response) || !response.overall.length) return publicResponse(response);
        if (response.results.some(part => part.rewardPhase !== kind)) throw new Error("engine-reward-phase-mismatch");
        seeds = response.overall;
        response = publicResponse(response);
      }
      return response;
    };
    try {
      const response = await Promise.race([work(), interrupted]);
      if (!stopped) publish({ ...response, stopReason: completeResponse(response) ? "complete" : "budget" }, true);
      return latest;
    } catch (error) {
      if (stopped) return latest;
      latest.error = error instanceof Error ? error.message : String(error);
      stop("error");
      if (latest.overall.length) return latest;
      throw error;
    } finally {
      clearTimeout(timer);
      clearTimeout(publishTimer);
      this.activeStops.delete(stop);
    }
  }
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const generation = this.generation;
    const queued = this.queue.then(() => {
      if (generation !== this.generation) throw new DOMException("Cancelled", "AbortError");
      return work();
    });
    this.queue = queued.catch(() => {});
    return queued;
  }
  sample(request: SampleRequest) {
    return this.enqueue(() => this.pool[0]!.send<PlaySample>({ type: "sample", id: 0, request }));
  }
  evaluateBatch(requests: EvaluateRequest[]) {
    const generation = this.generation;
    return this.enqueue(async () => {
      const results: TeamEvaluation[][] = [];
      let next = 0;
      await Promise.all(this.pool.slice(0, Math.min(3, requests.length)).map(async worker => {
        while (next < requests.length && generation === this.generation) {
          const index = next++;
          results[index] = await worker.send<TeamEvaluation[]>({ type: "evaluate", id: 0, request: requests[index]! });
        }
      }));
      return results;
    }).catch(error => {
      if (generation === this.generation) this.cancel();
      throw error;
    });
  }
  evaluate(request: EvaluateRequest) {
    return this.enqueue(() => this.pool[0]!.send<TeamEvaluation[]>({ type: "evaluate", id: 0, request }));
  }
  growth(request: EngineRequest, progress?: Pending["progress"]) {
    return this.enqueue(() => this.pool[0]!.send<GrowthResult>({ type: "growth", id: 0, request }, progress));
  }
  analyzeEventGrowth(request: EventTeamGrowthRequest, onUpdate?: (value: EventTeamSearchPage) => void): Promise<EventTeamSearchPage> {
    return this.enqueue(() => this.pool[0]!.send<EventTeamSearchPage>({ type: "eventGrowth", id: 0, request },
      undefined, undefined, undefined, onUpdate));
  }
  eventGrowthPage(page: number, onUpdate?: (value: EventTeamSearchPage) => void): Promise<EventTeamSearchPage> {
    return this.enqueue(() => this.pool[0]!.send<EventTeamSearchPage>({ type: "eventGrowthPage", id: 0, page },
      undefined, undefined, undefined, onUpdate));
  }
  pauseEventGrowth(paused: boolean) {
    this.pool[0]!.pauseEventGrowth(paused);
  }
  explain(request: ExplainRequest) {
    return this.enqueue(() => this.pool[0]!.send<Timeline>({ type: "explain", id: 0, request }));
  }
  /** Stops everything in flight; the next call starts fresh Workers. */
  cancel() {
    this.generation++;
    for (const stop of this.activeStops) stop("cancelled");
    this.downloads.cancel();
    for (const worker of this.pool) worker.cancel();
  }
  dispose() {
    this.cancel();
  }
}
