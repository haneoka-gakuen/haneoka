// L3 — GEB
// Input: 配队资料、Engine 请求及进度／快照／单 Worker 最终结果回调。
// Output: EngineClient、搜索／成长／评价／解释结果及当前 Worker 阶段。
// Pos: [Map](L2-2.md)；主线程到当前引擎 Worker 的生命周期与分片协调。
// Effects/Dependencies: 创建和替换 Worker、消息通信及内存 Promise；取消会终止对应计算实例。
/** Main-thread handle on the engine Worker. Cancelling replaces the Worker, so a long search never blocks. */
import type { TeamBuilderData } from "../data";
import type { EngineRequest, EngineResponse, GrowthResult, SongRef, TeamEvaluation, Timeline } from "./api";
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
    if (message.type === "run") this.setPhase("computationMs");
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

/** How many Workers share a search: the device's cores, minus one for the page, at most eight. */
const poolSize = () => {
  const nav = typeof navigator !== "undefined" ? (navigator as Navigator & { deviceMemory?: number }) : null;
  const cores = nav?.hardwareConcurrency || 4;
  // A searching Worker's heap grows to a few hundred MB, and a phone browser discards a tab long before a desktop
  // one does. Browsers that do not report memory (Safari, Firefox) are sized by form factor alone.
  const phone = !!nav && (/Android|iPhone|iPad|iPod|Mobile/u.test(nav.userAgent) || (nav.maxTouchPoints > 1 && /Macintosh/u.test(nav.userAgent)));
  const memory = nav?.deviceMemory ?? (phone ? 2 : 8);
  const limit = memory <= 2 ? 2 : memory <= 4 ? 3 : phone ? 4 : 8;
  return Math.max(1, Math.min(limit, cores - 1));
};
/** Below this many members a single Worker finishes before the others would compile the release. */
const PARALLEL_MIN_MEMBERS = 15;
/** How long one Worker tries before a search fans out over the pool. */
const QUICK_MS = 700;
/** Leader shards per Worker: enough for the free Workers to even out uneven subtrees. */
const SHARDS_PER_WORKER = 4;

/** Main-thread handle on the engine Workers. A search is split by leader over a pool of Workers and merged; cancelling
 * replaces every Worker, so a long search never blocks. */
export class EngineClient {
  private readonly pool: EngineWorker[];
  private readonly dataIdentity: string;
  constructor(data: TeamBuilderData, changed: () => void = () => {}) {
    this.dataIdentity = JSON.stringify([data.identity, data.crossServer?.identities]);
    this.pool = Array.from({ length: poolSize() }, (_, index) => new EngineWorker(data, `team-engine-${index + 1}`, changed));
  }
  get phases() { return [...new Set(this.pool.map(worker => worker.currentPhase).filter((phase): phase is NonNullable<typeof phase> => phase !== null))]; }
  /** Warm one Worker; the others compile lazily only if a search actually fans out. */
  warm() {
    // The others compile once the first is ready, so the first search can use every Worker.
    void this.pool[0]?.warm().then(() => { for (const worker of this.pool.slice(1)) void worker.warm(); });
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
    const task = { ...request, deadline: deadlineOf(request), requestId: request.requestId ?? crypto.randomUUID(), contextKey: request.contextKey ?? JSON.stringify([this.dataIdentity, request]) };
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
    let stop!: (reason: StopReason) => void;
    const interrupted = new Promise<EngineResponse>(resolve => {
      stop = reason => {
        if (stopped) return;
        publish({ ...latest, stopReason: reason }, true);
        stopped = true;
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
      const parallel = this.pool.length > 1 && request.members.length >= PARALLEL_MIN_MEMBERS && request.goal.kind !== "plan" && !request.seedOnly;
      if (!parallel) {
        const response = await this.idlest().send<EngineResponse>({ type: "run", id: 0, request }, progress, accept);
        if (!stopped) onFinalResult?.({ requestId: request.requestId!, contextKey: request.contextKey!, response: structuredClone(response) });
        return response;
      }
      const songs = requestSongs(request);
      if (request.goal.kind === "gekiso" && !request.goal.opponents) {
        const goal = request.goal;
        const count = request.constraints.leader ? 1 : this.pool.length;
        const parts = [...latest.results];
        const unknownCards = new Set(latest.unknownCards);
        const same = (song: SongRef) => (hit: { song: SongRef | null }) => hit.song?.songId === song.songId && hit.song?.difficulty === song.difficulty;
        const states = goal.songs.map((song, index) => {
          const part: EngineRequest = { ...request, goal: { ...goal, songs: [song] }, completed: undefined, seeds: request.seeds?.filter(same(song)) };
          const responses = Array.from({ length: count }, () => {
            const response = emptyResponse(part);
            response.results[0]!.hits = parts[index]!.hits;
            return response;
          });
          return { request: part, responses, seeded: request.seeded === true, seedStarted: false, next: 0, running: 0, done: completeResponse({ ...latest, results: [parts[index]!] }) };
        });
        const merged = (): EngineResponse => ({ ...latest, results: [...parts], overall: [], unknownCards: [...unknownCards], elapsedMs: clock() - started });
        const waiters = new Set<() => void>();
        const wake = () => { for (const resolve of waiters) resolve(); waiters.clear(); };
        let failed = false;
        let done = states.filter(state => state.done).length * count;
        const take = (preferred: number) => {
          const ready = (index: number) => { const state = states[index]; return state && !state.done && state.seeded && state.next < count; };
          let index = ready(preferred) ? preferred : states.findIndex((_, index) => ready(index));
          if (index >= 0) {
            const state = states[index]!;
            state.running++;
            return { index, shard: state.next++ };
          }
          index = states.findIndex(state => !state.done && !state.seeded && !state.seedStarted);
          if (index < 0) return null;
          states[index]!.seedStarted = true;
          states[index]!.running++;
          return { index, shard: null };
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
            const key = `${current.song!.songId}:${current.song!.difficulty}`;
            const floors = current.hits.length >= request.k ? { [key]: current.hits[request.k - 1]!.key } : {};
            const part: EngineRequest = { ...state.request, seeds: current.hits, floors,
              ...(job.shard === null ? { seedOnly: true } : { seeded: true, seedOnly: false, shard: { index: job.shard, count } }) };
            const update = (response: EngineResponse) => {
              for (const key of response.unknownCards) unknownCards.add(key);
              if (job.shard === null) parts[job.index] = response.results[0] ?? parts[job.index]!;
              else {
                state.responses[job.shard] = response;
                parts[job.index] = mergeShardResponses(state.responses, request.k, clock() - started).results[0]!;
              }
              publish(merged());
            };
            try {
              const response = await engine.send<EngineResponse>({ type: "run", id: 0, request: part }, undefined, value => {
                if (!stopped && value.contextKey === request.contextKey && value.requestId === request.requestId) update(value.response);
              });
              if (stopped) return;
              update(response);
              if (job.shard === null) {
                state.seeded = true;
                state.done = completeResponse(response);
                if (state.done) done += count;
                for (const shard of state.responses) shard.results[0]!.hits = parts[job.index]!.hits;
              } else {
                done++;
                state.done = state.next === count && state.running === 1;
              }
              progress?.(done / (states.length * count), 1);
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
      let seeds = request.seeds ?? [];
      if (!request.noFloor) {
        const quick = await this.idlest().send<EngineResponse>({ type: "run", id: 0, request: { ...request, deadline: Math.min(deadline, clock() + QUICK_MS) } }, progress, accept);
        publish(quick);
        if (completeResponse(quick)) return quick;
        seeds = quick.results.flatMap(result => result.hits);
      }
      const count = this.pool.length * SHARDS_PER_WORKER;
      const responses = Array.from({ length: count }, () => emptyResponse(request));
      for (const response of responses) for (const result of response.results)
        result.hits = seeds.filter(hit => hit.song?.songId === result.song?.songId && hit.song?.difficulty === result.song?.difficulty).slice(0, request.k);
      let next = 0, done = 0;
      const merge = () => mergeShardResponses(responses, request.k, clock() - started);
      const runShard = async (engine: EngineWorker) => {
        while (!stopped && remaining(deadline) > 0 && next < count) {
          const index = next++;
          const current = merge();
          const floors = Object.fromEntries(current.results.filter(result => result.song && result.hits.length >= request.k).map(result => [`${result.song!.songId}:${result.song!.difficulty}`, result.hits[request.k - 1]!.key]));
          const response = await engine.send<EngineResponse>({ type: "run", id: 0, request: { ...request, seeds, shard: { index, count }, floors } }, undefined, value => {
            if (stopped || value.contextKey !== request.contextKey || value.requestId !== request.requestId) return;
            responses[index] = value.response;
            publish(merge());
          });
          if (stopped) return;
          responses[index] = response;
          publish(merge());
          progress?.(++done / count, 1);
        }
      };
      await Promise.all(this.pool.map(runShard));
      const merged = merge();
      if (!aspirationHeld(merged, request.k) && !request.noFloor && remaining(deadline))
        return this.idlest().send<EngineResponse>({ type: "run", id: 0, request: { ...request, seeds: merged.overall, noFloor: true } }, progress, accept);
      return merged;
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
