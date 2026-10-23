// L3 — GEB
// Input: 配队资料、Engine 请求及进度／快照／单 Worker 最终结果回调；私有分片可返回待补分候选。
// Output: EngineClient、搜索／成长／评价／解释结果及当前 Worker 阶段。
// Pos: [Map](L2-2.md)；主线程到当前引擎 Worker 的生命周期与分片协调。
// Effects/Dependencies: 创建和替换 Worker、消息通信及内存 Promise；合并主分边界后补齐原生评分，COMBO 奖励分阶段证明，取消与重试替换对应实例。
/** Main-thread handle on the engine Worker. Cancelling replaces the Worker, so a long search never blocks. */
import { objectRow, type TeamBuilderData } from "../data";
import type { EngineHit, EngineRequest, EngineResponse, GrowthResult, SongRef, TeamEvaluation, Timeline } from "./api";
import type { EngineCall, EngineReply, EvaluateRequest, ExplainRequest, EngineSnapshot, StopReason } from "./protocol";
import { clock, deadlineOf, remaining, emptyResponse, completeResponse, requestSongs } from "./execution";
import { aspirationHeld, compareHits, mergeShardResponses } from "./merge";

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; progress?: (done: number, total: number) => void; snapshot?: (value: EngineSnapshot) => void };

/** A detached normal result from a single Worker, before candidate merging and search-proof labels. */
export interface FinalEngineResult { requestId: string; contextKey: string; response: EngineResponse }
type FinalResultHandler = (result: FinalEngineResult) => void;

/** One engine Worker: compiles the release once, then serves calls. */
class EngineWorker {
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
  timing() {
    return { ...this.times, ...(this.phase ? { [this.phase]: this.times[this.phase] + clock() - this.phaseAt } : {}) };
  }
  private readonly pending = new Map<number, Pending>();
  constructor(
    private readonly data: TeamBuilderData,
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
      else {
        this.setPhase(null);
        this.pending.delete(reply.id);
        if (reply.type === "error") pending.reject(new Error(reply.message));
        else pending.resolve(reply.type === "result" ? reply.result : undefined);
      }
    };
    worker.onerror = (event) => {
      if (this.worker !== worker) return;
      for (const pending of this.pending.values()) pending.reject(new Error(event.message || "engine-crashed"));
      this.pending.clear();
      this.reset();
    };
    this.ready = (this.call({ type: "init", id: 0, data: this.data }) as Promise<void>).catch((error) => {
      // A failed release compile must not pin the Worker to its rejected ready promise.
      if (this.worker === worker) this.reset();
      throw error;
    });
    return this.ready;
  }
  private call(message: EngineCall, progress?: Pending["progress"], snapshot?: Pending["snapshot"]): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, progress, snapshot });
      this.worker!.postMessage({ ...message, id });
    });
  }
  async send<T>(message: EngineCall, progress?: Pending["progress"], snapshot?: Pending["snapshot"]): Promise<T> {
    await this.spawn();
    if (message.type === "run" || message.type === "evaluate") this.setPhase("computationMs");
    return (await this.call(message, progress, snapshot)) as T;
  }
  /** Calls in flight; 0 when idle. */
  get load() {
    return this.pending.size;
  }
  get started() {
    return this.ready !== null;
  }
  /** Starts the Worker and compiles the release ahead of the first call. */
  warm(): Promise<void> {
    return this.spawn().catch(() => {});
  }
  cancel() {
    for (const pending of this.pending.values()) pending.reject(new DOMException("Cancelled", "AbortError"));
    this.pending.clear();
    this.reset();
  }
  private reset() {
    this.setPhase(null);
    this.worker?.terminate();
    this.worker = null;
    this.ready = null;
  }
}

type DeferredHit = EngineHit & { pendingScores?: true };
const pendingScores = (hit: EngineHit) => (hit as DeferredHit).pendingScores === true;
const memberSet = (hit: EngineHit) => [...hit.members].sort().join(",");
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
/** How long one Worker tries before a search fans out over the pool. */
const QUICK_MS = 700;
/** Leader shards per Worker: enough for the free Workers to even out uneven subtrees. */
const SHARDS_PER_WORKER = 4;

function wholeSongReward(data: TeamBuilderData, request: EngineRequest): boolean {
  const goal = request.goal;
  if (request.k !== 1 || goal.kind !== "event" || !goal.gekiso || goal.songs.length !== 1) return false;
  const missions = objectRow(data.songs[String(goal.songs[0]!.songId)]?.gekisou).missionTypes;
  return Array.isArray(missions) && missions.length > 0 && missions.every(mission => mission === 2 || mission === 3);
}

function phasedReward(data: TeamBuilderData, request: EngineRequest): boolean {
  const goal = request.goal;
  if (request.k !== 1 || goal.kind !== "event" || !goal.gekiso || goal.songs.length !== 1) return false;
  const missions = objectRow(data.songs[String(goal.songs[0]!.songId)]?.gekisou).missionTypes;
  return Array.isArray(missions) && missions.length > 0 && missions.every(mission => mission === 1);
}

/** Main-thread handle on the engine Workers. A search is split by leader over a pool of Workers and merged; cancelling
 * replaces every Worker, so a long search never blocks. */
export class EngineClient {
  private readonly pool: EngineWorker[];
  private readonly dataIdentity: string;
  constructor(private readonly data: TeamBuilderData, changed: () => void = () => {}) {
    this.dataIdentity = JSON.stringify([data.identity, data.crossServer?.identities]);
    this.pool = Array.from({ length: poolSize() }, (_, index) => new EngineWorker(data, `team-engine-${index + 1}`, changed));
  }
  get phases() { return [...new Set(this.pool.map(worker => worker.currentPhase).filter((phase): phase is NonNullable<typeof phase> => phase !== null))]; }
  /** Warm one Worker; the others compile lazily only if a search actually fans out. */
  warm() {
    // The others compile once the first is ready, so the first search can use every Worker.
    const generation = this.generation;
    void this.pool[0]?.warm().then(() => {
      if (generation === this.generation) for (const worker of this.pool.slice(1)) void worker.warm();
    });
  }
  /** The idlest Worker, preferring one that has already compiled the release. */
  private idlest() {
    return [...this.pool].sort((a, b) => a.load - b.load || Number(b.started) - Number(a.started))[0]!;
  }
  private queue: Promise<unknown> = Promise.resolve();
  private activeStop: ((reason: StopReason) => void) | null = null;
  private generation = 0;

  run(request: EngineRequest, progress?: Pending["progress"], snapshot?: Pending["snapshot"], onFinalResult?: FinalResultHandler): Promise<EngineResponse> {
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
      return this.execute(task, started, progress, snapshot, onFinalResult);
    });
    this.queue = queued.catch(() => {});
    return Promise.race([queued, waiting]).finally(() => clearTimeout(timer));
  }

  private async execute(request: EngineRequest, started: number, progress?: Pending["progress"], snapshot?: Pending["snapshot"], onFinalResult?: FinalResultHandler): Promise<EngineResponse> {
    const before = this.pool.map(worker => worker.timing());
    let latest = emptyResponse(request);
    if (request.seeds?.length) {
      for (const result of latest.results) result.hits = request.seeds.filter(hit => hit.song?.songId === result.song?.songId && hit.song?.difficulty === result.song?.difficulty).slice(0, request.k);
      latest.overall = latest.results.flatMap(result => result.hits).sort(compareHits).slice(0, request.k);
    }
    let stopped = false;
    let lastShown = -Infinity;
    const publish = (response: EngineResponse, force = false) => {
      if (stopped) return;
      const hadCandidate = latest.overall.length > 0;
      for (const result of response.results) {
        const previous = latest.results.find(part => part.song?.songId === result.song?.songId && part.song?.difficulty === result.song?.difficulty);
        if (previous && !result.proven) {
          const seen = new Set<string>();
          result.hits = [...result.hits, ...previous.hits].sort(compareHits).filter(hit => {
            const key = [...hit.members].sort().join(",");
            if (seen.has(key)) return false;
            seen.add(key); return true;
          }).slice(0, request.k);
        }
      }
      response.overall = response.results.flatMap(result => result.hits).sort(compareHits).slice(0, request.k);
      latest = response;
      latest.timing = this.pool.reduce((total, worker, index) => {
        const timing = worker.timing();
        for (const field of ["initializationMs", "networkMs", "computationMs"] as const) total[field] += timing[field] - before[index]![field];
        return total;
      }, { initializationMs: 0, networkMs: 0, computationMs: 0, wallMs: clock() - started });
      latest.elapsedMs = clock() - started;
      if (!force && (hadCandidate || !latest.overall.length) && clock() - lastShown < 100) return;
      lastShown = clock();
      snapshot?.({ requestId: request.requestId!, contextKey: request.contextKey!, response: latest, stopReason: latest.stopReason,
        coverage: { completed: latest.results.filter(result => result.proven || result.exclusion).length, total: latest.results.length } });
    };
    let wakeWork: (() => void) | undefined;
    let stop!: (reason: StopReason) => void;
    const interrupted = new Promise<EngineResponse>(resolve => {
      stop = reason => {
        if (stopped) return;
        publish({ ...latest, stopReason: reason }, true);
        stopped = true;
        wakeWork?.();
        for (const worker of this.pool) worker.cancel();
        resolve(latest);
      };
    });
    this.activeStop = stop;
    const deadline = request.deadline!;
    const timer = Number.isFinite(deadline) ? setTimeout(() => stop("budget"), remaining(deadline)) : undefined;
    const accept = (value: EngineSnapshot) => {
      if (!stopped && value.requestId === request.requestId && value.contextKey === request.contextKey) publish(value.response);
    };
    const work = async (): Promise<EngineResponse> => {
      if (!remaining(deadline)) { stop("budget"); return latest; }
      if (completeResponse(latest)) return latest;
      const parallel = this.pool.length > 1 && request.members.length >= PARALLEL_MIN_MEMBERS && request.goal.kind !== "plan" && !request.seedOnly
        && !wholeSongReward(this.data, request)
        && !(request.goal.kind === "gekiso" && request.constraints.leader !== null && request.goal.songs.length === 1);
      if (!parallel) {
        const response = await this.idlest().send<EngineResponse>({ type: "run", id: 0, request }, progress, accept);
        if (!stopped) onFinalResult?.({ requestId: request.requestId!, contextKey: request.contextKey!, response: structuredClone(response) });
        return response;
      }
      const songs = requestSongs(request);
      if (request.goal.kind === "gekiso" && !request.goal.opponents) {
        const goal = request.goal;
        const deferScores = goal.criterion === "max" && goal.seeds === 0 && request.k > 1;
        const count = request.constraints.leader ? 1 : this.pool.length;
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
          return { request: part, responses, warm, deferred: false, seeded: request.seeded === true, seedNext: 0, seedDone: 0, next: 0, finished: 0, running: 0, done: completeResponse({ ...latest, results: [parts[index]!] }) };
        });
        const merged = (): EngineResponse => ({ ...latest, results: [...parts], overall: [], unknownCards: [...unknownCards], elapsedMs: clock() - started });
        const waiters = new Set<() => void>();
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
            members: request.members, snaps: request.snaps, player: request.player, unknownPolicy: request.unknownPolicy,
            team: { members: hit.members, snaps: hit.snaps, leader: hit.members[0]! }, songs: [hit.song!],
            play: { great: 0, good: 0, bad: 0, miss: 0 }, gekiso: { accuracy: goal.accuracy, rank: goal.rank, seeds: goal.seeds },
            challengeEventId: null, event: null,
          } });
          if (stopped) return;
          const evaluation = evaluations[0]!;
          if (evaluation.score.max !== hit.key || evaluation.power !== hit.power) throw new Error("engine-score-completion-mismatch");
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
                if (state.seeded && state.next > 0) return;
                parts[job.index] = mergeShardResponses(state.warm.map(scoredResponse), request.k, clock() - started).results[0]!;
              } else {
                state.responses[job.shard] = response;
                parts[job.index] = mergeShardResponses(state.responses.map(scoredResponse), request.k, clock() - started).results[0]!;
              }
              publish(merged());
            };
            try {
              const response = await engine.send<EngineResponse>({ type: "run", id: 0, request: part, deferScores }, undefined, value => {
                if (!stopped && value.contextKey === request.contextKey && value.requestId === request.requestId) update(value.response);
              });
              if (stopped) return;
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
              progress?.(done / progressTotal, 1);
            } catch (error) {
              failed = true;
              throw error;
            } finally {
              state.running--;
              wake();
            }
          }
        };
        await Promise.all(this.pool.map(run));
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
          await Promise.all(this.pool.map(finish));
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
          return this.idlest().send<EngineResponse>({ type: "run", id: 0, request: { ...request, seeds: parts.flatMap(part => part.hits), seeded: true, noFloor: true } }, progress, accept);
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
            const share = remaining(deadline) * this.pool.length / (songs.length - index);
            const part: EngineRequest = {
              ...request,
              goal: { ...request.goal, songs: [song] } as EngineRequest["goal"],
              deadline: Math.min(deadline, clock() + share),
              seeds: request.seeds?.filter(same(song)),
              completed: request.completed?.filter(same(song)),
            };
            const response = await engine.send<EngineResponse>({ type: "run", id: 0, request: part }, undefined, value => {
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
        await Promise.all(this.pool.map(runSong));
        return merged();
      }
      if (request.goal.kind === "gekiso")
        return this.idlest().send<EngineResponse>({ type: "run", id: 0, request }, progress, accept);
      const runShards = async (request: EngineRequest, publish: (response: EngineResponse) => void, stage = -1): Promise<EngineResponse> => {
        const stageProgress: Pending["progress"] = stage < 0 ? progress
          : (done, total) => progress?.((stage + done / total) / 3, 1);
        const acceptPart = (value: EngineSnapshot) => {
          if (!stopped && value.requestId === request.requestId && value.contextKey === request.contextKey) publish(value.response);
        };
        let seeds = request.seeds ?? [];
        if (!request.noFloor && stage < 0) {
          const quick = await this.idlest().send<EngineResponse>({ type: "run", id: 0, request: { ...request, deadline: Math.min(deadline, clock() + QUICK_MS) } }, stageProgress, acceptPart);
          publish(quick);
          if (completeResponse(quick)) return quick;
          seeds = quick.results.flatMap(result => result.hits);
        }
        const valueOf = (hit: EngineHit) => request.rewardPhase?.kind === "other" ? hit.event?.otherMean ?? 0
          : request.rewardPhase?.kind === "score" ? hit.score?.mean ?? 0 : hit.key;
        const sampledRewards = request.goal.kind === "event" && request.goal.gekiso;
        const workers = request.rewardPhase ? this.pool.slice(0, 4) : this.pool;
        const count = sampledRewards
          ? (request.constraints.leader ? 1 : workers.length)
          : workers.length * SHARDS_PER_WORKER;
        const responses = Array.from({ length: count }, () => emptyResponse(request));
        for (const response of responses) for (const result of response.results)
          result.hits = seeds.filter(hit => hit.song?.songId === result.song?.songId && hit.song?.difficulty === result.song?.difficulty).slice(0, request.k);
        let next = 0, done = 0;
        const merge = () => mergeShardResponses(responses, request.k, clock() - started);
        const active = new Map<EngineWorker, { floor: number; retry: boolean }>();
        const runShard = async (engine: EngineWorker) => {
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
                  ? { ...request.rewardPhase, floor: Math.max(0, job.floor) } : request.rewardPhase;
                response = await engine.send<EngineResponse>({ type: "run", id: 0, request: { ...request, rewardPhase,
                  seeded: request.rewardPhase ? current.overall.length > 0 : request.seeded,
                  seeds: sampledRewards ? current.overall : seeds, shard: { index, count }, floors: rewardPhase && rewardPhase.kind !== "primary" ? undefined : floors } }, undefined, value => {
                  if (stopped || job.retry || active.get(engine) !== job || value.contextKey !== request.contextKey || value.requestId !== request.requestId) return;
                  if (request.rewardPhase) {
                    const hit = value.response.overall[request.k - 1];
                    if (hit) job.floor = Math.max(job.floor, valueOf(hit));
                  }
                  responses[index] = value.response;
                  publish(merge());
                });
              } catch (error) {
                if (job.retry && !stopped) continue;
                throw error;
              } finally {
                active.delete(engine);
              }
              if (stopped) return;
              responses[index] = response;
              publish(merge());
              stageProgress?.(++done / count, 1);
              if (sampledRewards && !request.noFloor && completeResponse(response)) {
                const hit = response.overall[request.k - 1];
                const floor = hit ? valueOf(hit) : -Infinity;
                for (const [worker, running] of active) if (!running.retry && floor > running.floor) {
                  running.retry = true;
                  worker.cancel();
                }
              }
              break;
            }
          }
        };
        await Promise.all(workers.map(runShard));
        const merged = merge();
        if (!aspirationHeld(merged, request.k) && !request.noFloor && remaining(deadline))
          return this.idlest().send<EngineResponse>({ type: "run", id: 0, request: { ...request, seeds: merged.overall, noFloor: true } }, stageProgress, acceptPart);
        return merged;
      };
      if (!phasedReward(this.data, request)) return runShards(request, publish);
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
      if (this.activeStop === stop) this.activeStop = null;
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
  evaluate(request: EvaluateRequest) {
    return this.enqueue(() => this.pool[0]!.send<TeamEvaluation[]>({ type: "evaluate", id: 0, request }));
  }
  growth(request: EngineRequest, progress?: Pending["progress"]) {
    return this.enqueue(() => this.pool[0]!.send<GrowthResult>({ type: "growth", id: 0, request }, progress));
  }
  explain(request: ExplainRequest) {
    return this.enqueue(() => this.pool[0]!.send<Timeline>({ type: "explain", id: 0, request }));
  }
  /** Stops everything in flight; the next call starts fresh Workers. */
  cancel() {
    this.generation++;
    this.activeStop?.("cancelled");
    for (const worker of this.pool) worker.cancel();
  }
  dispose() {
    this.cancel();
  }
}
