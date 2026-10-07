/** Main-thread handle on the engine Worker. Cancelling replaces the Worker, so a long search never blocks. */
import type { TeamBuilderData } from "../data";
import type { EngineRequest, EngineResponse, TeamEvaluation, Timeline } from "./api";
import type { EngineCall, EngineReply, EvaluateRequest, ExplainRequest } from "./protocol";
import { aspirationHeld, mergeShardResponses, planSummary } from "./merge";

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; progress?: (done: number, total: number) => void };

/** One engine Worker: compiles the release once, then serves calls. */
class EngineWorker {
  private worker: Worker | null = null;
  private ready: Promise<void> | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  constructor(
    private readonly data: TeamBuilderData,
    private readonly name: string,
  ) {}
  private spawn(): Promise<void> {
    if (this.ready) return this.ready;
    const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module", name: this.name });
    this.worker = worker;
    worker.onmessage = (event: MessageEvent<EngineReply>) => {
      const reply = event.data;
      const pending = this.pending.get(reply.id);
      if (!pending) return;
      if (reply.type === "progress") pending.progress?.(reply.done, reply.total);
      else {
        this.pending.delete(reply.id);
        if (reply.type === "error") pending.reject(new Error(reply.message));
        else pending.resolve(reply.type === "result" ? reply.result : undefined);
      }
    };
    worker.onerror = (event) => {
      for (const pending of this.pending.values()) pending.reject(new Error(event.message || "engine-crashed"));
      this.pending.clear();
      this.reset();
    };
    this.ready = this.call({ type: "init", id: 0, data: this.data }) as Promise<void>;
    return this.ready;
  }
  private call(message: EngineCall, progress?: Pending["progress"]): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, progress });
      this.worker!.postMessage({ ...message, id });
    });
  }
  async send<T>(message: EngineCall, progress?: Pending["progress"]): Promise<T> {
    await this.spawn();
    return (await this.call(message, progress)) as T;
  }
  /** Starts the Worker and compiles the release ahead of the first call. */
  warm() {
    void this.spawn().catch(() => {});
  }
  cancel() {
    for (const pending of this.pending.values()) pending.reject(new DOMException("Cancelled", "AbortError"));
    this.pending.clear();
    this.reset();
  }
  private reset() {
    this.worker?.terminate();
    this.worker = null;
    this.ready = null;
  }
}

/** How many Workers share a search: the device's cores, minus one for the page, at most eight. */
const poolSize = () => {
  const cores = typeof navigator !== "undefined" && navigator.hardwareConcurrency ? navigator.hardwareConcurrency : 4;
  // Each Worker holds its own compiled release (tens of MB): low-memory phones get fewer.
  const memory = typeof navigator !== "undefined" ? ((navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 8) : 8;
  const limit = memory <= 2 ? 2 : memory <= 4 ? 4 : 8;
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
  constructor(data: TeamBuilderData) {
    this.pool = Array.from({ length: poolSize() }, (_, index) => new EngineWorker(data, `team-engine-${index + 1}`));
  }
  /** Compiles the release in every Worker in the background so the first search starts at full width. */
  warm() {
    for (const worker of this.pool) worker.warm();
  }
  async run(request: EngineRequest, progress?: Pending["progress"]): Promise<EngineResponse> {
    const parallel = this.pool.length > 1 && request.members.length >= PARALLEL_MIN_MEMBERS;
    if (!parallel) return this.pool[0]!.send<EngineResponse>({ type: "run", id: 0, request }, progress);
    const started = performance.now();
    // Most searches prove their ranking in well under a second on one Worker; only those that don't fan out, and
    // the teams found so far give every shard its starting floor.
    const initial: Record<string, number> = {};
    // Gekisou seeding alone outlasts the quick window, so it fans out at once.
    if (!request.noFloor && request.goal.kind !== "gekiso") {
      const quick = await this.pool[0]!.send<EngineResponse>({
        type: "run",
        id: 0,
        request: { ...request, timeLimitMs: Math.min(request.timeLimitMs ?? Infinity, QUICK_MS) },
      });
      if (quick.results.every((result) => result.proven)) return quick;
      if (request.goal.kind !== "plan")
        for (const result of quick.results)
          if (result.song && result.hits.length >= request.k) initial[`${result.song.songId}:${result.song.difficulty}`] = result.hits[request.k - 1]!.key;
    }
    if (request.goal.kind === "plan") return this.plan(request, request.goal, started, progress);
    const merged = await this.sharded(request, initial, progress);
    merged.elapsedMs = performance.now() - started;
    if (aspirationHeld(merged, request.k) || request.noFloor) return merged;
    // A floor admitted fewer than k teams: search again without it.
    return this.run({ ...request, noFloor: true }, progress);
  }
  /** Leader shards are many and small, handed to whichever Worker is free: subtree sizes vary widely, and each new
   * task starts from the best k-th key found so far. */
  private async sharded(request: EngineRequest, initial: Record<string, number>, progress?: Pending["progress"], offset = 0, total = 1): Promise<EngineResponse> {
    const count = this.pool.length * SHARDS_PER_WORKER;
    const responses: EngineResponse[] = [];
    let next = 0;
    const floors = (): Record<string, number> => {
      if (!responses.length) return initial;
      const merged = mergeShardResponses(responses, request.k, 0);
      const out: Record<string, number> = { ...initial };
      for (const result of merged.results)
        if (result.song && result.hits.length >= request.k) {
          const key = `${result.song.songId}:${result.song.difficulty}`;
          out[key] = Math.max(out[key] ?? -Infinity, result.hits[request.k - 1]!.key);
        }
      return out;
    };
    const worker = async (engine: EngineWorker) => {
      while (next < count) {
        const index = next++;
        responses.push(await engine.send<EngineResponse>({ type: "run", id: 0, request: { ...request, shard: { index, count }, floors: floors() } }));
        progress?.(offset + responses.length / count, total);
      }
    };
    await Promise.all(this.pool.map(worker));
    return mergeShardResponses(responses, request.k, 0);
  }
  /** A plan's normal lives are priced by the best challenge live, so the stages run one after the other, each
   * over the pool. */
  private async plan(request: EngineRequest, goal: Extract<EngineRequest["goal"], { kind: "plan" }>, started: number, progress?: Pending["progress"]): Promise<EngineResponse> {
    const challengeRequest: EngineRequest = {
      ...request,
      goal: { kind: "event", measure: "points", route: "challenge", eventId: goal.eventId, songs: goal.challengeSongs, consumption: goal.challengePointsPerLive, play: goal.play },
    };
    let challenge = await this.sharded(challengeRequest, {}, progress, 0, 2);
    if (!aspirationHeld(challenge, request.k)) challenge = await this.sharded({ ...challengeRequest, noFloor: true }, {}, progress, 0, 2);
    const bestChallenge = challenge.overall[0] ?? null;
    const pointsPerChallenge = bestChallenge?.event?.mean ?? 0;
    const normal = await this.sharded({ ...request, goal: { ...goal, challengePointsPerPlay: pointsPerChallenge } }, {}, progress, 1, 2);
    const bestNormal = normal.results.flatMap((result) => result.hits).sort((a, b) => b.key - a.key)[0] ?? null;
    return {
      plan: planSummary(goal, bestNormal, bestChallenge, pointsPerChallenge),
      results: [...challenge.results, ...normal.results],
      overall: [...(bestNormal ? [bestNormal] : []), ...(bestChallenge ? [bestChallenge] : [])],
      unknownCards: normal.unknownCards,
      elapsedMs: performance.now() - started,
    };
  }
  evaluate(request: EvaluateRequest) {
    return this.pool[0]!.send<TeamEvaluation[]>({ type: "evaluate", id: 0, request });
  }
  explain(request: ExplainRequest) {
    return this.pool[0]!.send<Timeline>({ type: "explain", id: 0, request });
  }
  /** Stops everything in flight; the next call starts fresh Workers. */
  cancel() {
    for (const worker of this.pool) worker.cancel();
  }
  dispose() {
    this.cancel();
  }
}
