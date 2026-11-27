/** Local reward jobs. A completed or certified-excluded chart is the smallest resumable unit. */
import type { EngineHit, EngineRequest, EngineResponse, SongRef, SongResult } from "./engine/api";
import { clock, remaining, type RewardCutoff } from "./engine/execution";
import type { EngineSnapshot } from "./engine/protocol";
import type { EngineClient } from "./engine/client";
import { cpExchange } from "./engine/pt-value";

export const PT_VERSION = "native-reward-settlement-v22";
export type PtMeasure = "points" | "items";
export type PtScope = "top-one" | "top-five" | "all";
export interface PtCycleInput {
  songs: SongRef[];
  consumption: number;
}
export type PtStatus = "partial" | "queued" | "running" | "complete" | "empty" | "pruned" | "failed";
export interface PtTask {
  route: "live" | "challenge";
  measure: PtMeasure;
  song: SongRef;
  status: PtStatus;
  result: SongResult | null;
  error: string;
}
export interface PtJob {
  version: typeof PT_VERSION;
  id: string;
  fingerprint: string;
  dataFingerprint: string;
  owner: string;
  server: string;
  releaseId: string;
  sourceId: string;
  request: EngineRequest;
  cycle: PtCycleInput | null;
  /** Missing on older jobs, which retain their original exhaustive chart scope. */
  scope?: PtScope;
  budgetSeconds?: number | null;
  stopReason?: "budget" | "cancelled";
  assumptions: string[];
  presentation?: { scope: "box" | "theoretical"; maxAccountBonuses?: boolean };
  createdAt: number;
  updatedAt: number;
  tasks: PtTask[];
}
/** Canonical JSON, including explicit Map/Set encoding; object insertion order cannot change identity. */
export function canonical(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (item instanceof Map)
      return [...item].sort(([a], [b]) => String(a).localeCompare(String(b))).map(([k, v]) => [k, normalize(v)]);
    if (item instanceof Set) return [...item].sort().map(normalize);
    if (Array.isArray(item)) return item.map(normalize);
    if (item && typeof item === "object")
      return Object.fromEntries(
        Object.entries(item)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => [k, normalize(v)]),
      );
    return item;
  };
  return JSON.stringify(normalize(value));
}
export async function digest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonical(value));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
export const ptFingerprint = (
  request: EngineRequest,
  dataFingerprint: string,
  owner: string,
  cycle: PtCycleInput | null = null,
) => digest({ version: PT_VERSION, dataFingerprint, owner, request, cycle });

export async function createPtJob(
  request: EngineRequest,
  context: Pick<PtJob, "server" | "releaseId" | "sourceId" | "dataFingerprint" | "owner" | "assumptions">,
  cycle: PtCycleInput | null = null,
): Promise<PtJob> {
  if (
    request.goal.kind !== "event" ||
    request.goal.ranking !== "pt-only" ||
    request.goal.route !== "live" ||
    (request.goal.measure !== "points" && request.goal.measure !== "items")
  )
    throw new Error("pt-mode");
  if (cycle && (!cycle.songs.length || !Number.isSafeInteger(cycle.consumption) || cycle.consumption <= 0))
    throw new Error("pt-cycle-input");
  const tasks: PtTask[] = [];
  const add = (route: PtTask["route"], measures: readonly PtMeasure[], songs: SongRef[]) =>
    tasks.push(
      ...songs.flatMap((song) =>
        measures.map((measure): PtTask => ({
          route,
          measure,
          song: { ...song },
          status: "queued",
          result: null,
          error: "",
        })),
      ),
    );
  if (cycle) add("challenge", [request.goal.measure], cycle.songs);
  add("live", [request.goal.measure], request.goal.songs);
  return {
    ...structuredClone(context),
    version: PT_VERSION,
    id: crypto.randomUUID(),
    fingerprint: await ptFingerprint(request, context.dataFingerprint, context.owner, cycle),
    request: structuredClone(request),
    cycle: structuredClone(cycle),
    scope: "top-one",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    tasks,
  };
}
const chartKey = (song: SongRef) => `${song.songId}:${song.difficulty}`;
const compareHit = (a: EngineHit, b: EngineHit) =>
  b.key - a.key ||
  (b.event?.otherMean ?? 0) - (a.event?.otherMean ?? 0) ||
  (b.score?.mean ?? 0) - (a.score?.mean ?? 0) ||
  a.song!.songId - b.song!.songId ||
  a.song!.difficulty - b.song!.difficulty ||
  canonical([a.members, a.snaps]).localeCompare(canonical([b.members, b.snaps]));
export function ptSongRanking(job: PtJob, measure: PtMeasure = "points", route: PtTask["route"] = "live"): EngineHit[] {
  const songs = new Map<number, EngineHit>();
  for (const task of job.tasks) {
    if (task.measure !== measure || task.route !== route) continue;
    for (const hit of task.result?.hits ?? []) {
      if (!hit.song || !hit.event || !Number.isFinite(hit.event.mean)) continue;
      const previous = songs.get(hit.song.songId);
      if (!previous || compareHit(hit, previous) < 0) songs.set(hit.song.songId, hit);
    }
  }
  return [...songs.values()].sort(compareHit);
}
export function ptChallengeBest(job: PtJob, measure: PtMeasure): EngineHit | null {
  const tasks = job.tasks.filter((task) => task.route === "challenge" && task.measure === measure);
  if (
    !tasks.length ||
    !tasks.every((task) => (task.status === "complete" || task.status === "empty") && task.result?.proven)
  )
    return null;
  return ptSongRanking(job, measure, "challenge")[0] ?? null;
}
export function ptChallengeCharts(job: PtJob, measure: PtMeasure): EngineHit[] {
  const charts = new Map<string, EngineHit>();
  for (const task of job.tasks) {
    if (task.route !== "challenge" || task.measure !== measure || !chartComplete(task)) continue;
    for (const hit of task.result?.hits ?? []) {
      if (!hit.song || !hit.event || !Number.isFinite(hit.event.mean)) continue;
      const key = chartKey(hit.song);
      const previous = charts.get(key);
      if (!previous || compareHit(hit, previous) < 0) charts.set(key, hit);
    }
  }
  return [...charts.values()].sort(compareHit);
}

export function ptFollowUpTotals(live: EngineHit, challenge: EngineHit, measure: PtMeasure,
                                 normalPlays: number, startingCp: number, cost: number) {
  const normal = live.event!;
  const next = challenge.event!;
  const cp = normal.rewardValues?.["challenge-points"];
  const denominator = Number(cp?.denominator);
  const numerator = Number(cp?.numerator);
  const fraction = Number.isSafeInteger(denominator) && denominator > 0 && Number.isSafeInteger(numerator)
    && Number.isSafeInteger(startingCp * denominator + numerator * normalPlays)
    && Number.isSafeInteger(cost * denominator);
  const orders = fraction ? denominator : Math.max(1, normal.orders ?? 1);
  const earned = fraction ? numerator : Math.round(normal.challengePoints * orders);
  const budget = startingCp * orders + earned * normalPlays;
  const consumption = cost * orders;
  const plays = Math.floor(budget / consumption);
  const reward = (event: NonNullable<EngineHit["event"]>, metric: PtMeasure) => {
    const value = event.rewardValues?.[metric]?.value ?? (metric === measure
      ? event.directMean ?? event.mean - (event.convertedMean ?? 0) : event.otherMean);
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  };
  const settlement = (metric: PtMeasure) => {
    const perPlay = reward(normal, metric);
    const perChallenge = reward(next, metric);
    const followUp = plays === 0 ? 0 : perChallenge === null ? null : perChallenge * plays;
    return { perPlay, followUp, total: perPlay === null || followUp === null ? null : perPlay * normalPlays + followUp };
  };
  const points = settlement("points"), items = settlement("items");
  return {
    plays,
    remaining: (budget - plays * consumption) / orders,
    perPlay: { points: points.perPlay, items: items.perPlay },
    followUp: { points: points.followUp, items: items.followUp },
    points: points.total,
    items: items.total,
  };
}

export function ptCutoff(job: PtJob, measure: PtMeasure): number | undefined {
  return ptSongRanking(job, measure)[(job.scope === "top-one" ? 1 : 5) - 1]?.key;
}
function rewardCutoff(job: PtJob, measure: PtMeasure): RewardCutoff | undefined {
  if (job.scope === "all") return;
  const key = ptCutoff(job, measure);
  if (key === undefined) return;
  return { key, comparison: "gte", contextKey: job.fingerprint, ranking: "reward-mean-score-v2" };
}
export function ptTaskCutoff(job: PtJob, task: PtTask): RewardCutoff | undefined {
  return task.route === "live" ? rewardCutoff(job, task.measure) : undefined;
}
function hasValidExclusion(task: PtTask, cutoff: RewardCutoff | undefined): boolean {
  const proof = task.result?.exclusion;
  return !!proof && !!cutoff && task.status === "pruned" && proof.contextKey === cutoff.contextKey && proof.ranking === cutoff.ranking &&
    (proof.key < cutoff.key || (proof.key === cutoff.key && (proof.comparison === "gte" || cutoff.comparison === "gt")));
}
export function chartExcluded(job: PtJob, task: PtTask): boolean {
  return task.status === "pruned" && hasValidExclusion(task, ptTaskCutoff(job, task));
}
const chartComplete = (task: PtTask) =>
  (task.status === "complete" || task.status === "empty") && task.result?.proven === true;
function proofStatus(job: PtJob): (task: PtTask) => boolean {
  const cutoffs = new Map<PtMeasure, RewardCutoff | undefined>();
  return task => {
    if (chartComplete(task)) return true;
    if (task.status !== "pruned" || task.route !== "live") return false;
    if (!cutoffs.has(task.measure)) cutoffs.set(task.measure, rewardCutoff(job, task.measure));
    return hasValidExclusion(task, cutoffs.get(task.measure));
  };
}
export const ptAllComplete = (job: PtJob) => job.tasks.length > 0 && job.tasks.every(chartComplete);
export const ptComplete = (job: PtJob) => job.tasks.length > 0 && job.tasks.every(proofStatus(job));

export interface PtEngine {
  run(request: EngineRequest, progress?: (done: number, total: number) => void, snapshot?: (value: EngineSnapshot) => void): Promise<EngineResponse>;
  cancel(): void;
  prefetch?(songs: readonly SongRef[]): void;
  runBatch?: EngineClient["runBatch"];
}
export interface PtJobStore {
  save(job: PtJob): Promise<void>;
  latest(server: string, owner: string): Promise<PtJob | null>;
}
export class PtRunner {
  running = false;
  private stopped = false;
  private checkpointStop?: () => void;
  constructor(
    private readonly engine: PtEngine,
    private readonly store: PtJobStore,
    private readonly changed: (job: PtJob) => void,
    private readonly storageFailed: () => void,
    private readonly current: () => boolean = () => true,
  ) {}
  stop() {
    if (this.stopped || !this.running) return;
    this.stopped = true;
    this.checkpointStop?.();
    this.engine.cancel();
  }
  async run(job: PtJob, scope: PtScope = job.scope ?? "top-one", deadline = clock() + 3000): Promise<void> {
    if (this.running) throw new Error("pt-busy");
    this.running = true;
    this.stopped = false;
    delete job.stopReason;
    job.scope = scope;
    let budgetReached = false;
    let savedAt = 0;
    let shownAt = 0;
    const publish = async (force = false) => {
      job.updatedAt = Date.now();
      if (force || job.updatedAt - shownAt >= 100) {
        shownAt = job.updatedAt;
        this.changed(job);
      }
      if (!force && job.updatedAt - savedAt < 1000) return;
      savedAt = job.updatedAt;
      try {
        await this.store.save(job);
      } catch {
        this.storageFailed();
      }
    };
    const active = () => this.running && !this.stopped && this.current();
    const requeue = () => {
      for (const task of job.tasks) if (task.status === "running") task.status = "queued";
    };
    this.checkpointStop = () => {
      requeue();
      job.stopReason = "cancelled";
      void publish(true);
    };
    try {
      const initiallyComplete = proofStatus(job);
      for (const task of job.tasks)
        if (!initiallyComplete(task)) {
          task.status = "queued";
          task.error = "";
        }
      await publish();
      const tasks = [...job.tasks].sort(
        (a, b) =>
          Number(a.route === "live") - Number(b.route === "live") ||
          a.song.songId - b.song.songId ||
          a.song.difficulty - b.song.difficulty ||
          Number(a.measure === "items") - Number(b.measure === "items"),
      );
      const buildRequest = (task: PtTask, challenge: EngineHit | null): EngineRequest => {
        const { goal, rewardCutoff: _legacyCutoff, ...base } = job.request;
        if (goal.kind !== "event") throw new Error("pt-mode");
        return {
          ...base,
          goal: {
            ...goal, songs: [task.song], route: task.route, measure: task.measure,
            ...(task.route === "challenge" ? { consumption: job.cycle!.consumption, gekiso: undefined } : {}),
            ...(challenge ? { cpExchange: cpExchange(
              challenge.event!.rewardSum!, challenge.event!.orders!, job.cycle!.consumption,
            ) } : {}),
          },
          deadline,
          contextKey: job.fingerprint,
          seeds: task.result?.hits ?? [],
        };
      };
      const accept = (task: PtTask, response: EngineResponse) => {
        if (!active()) return;
        if (response.stopReason === "budget") budgetReached = true;
        const result = response.results.find(r => r.song && chartKey(r.song) === chartKey(task.song));
        if (!result) return;
        const previous = task.result?.hits[0];
        if (previous && !result.proven && (!result.hits.length || compareHit(previous, result.hits[0]!) < 0))
          result.hits = [previous];
        if (result.exclusion && result.hits.length && result.hits[0]!.key >= result.exclusion.key) {
          result.proven = true;
          result.bound = null;
          delete result.exclusion;
        }
        task.result = result;
        if (response.stopReason === "error") {
          task.status = "failed"; task.error = response.error ?? "engine-error"; return;
        }
        task.status = result.exclusion ? "pruned" : result.proven ? (result.hits.length ? "complete" : "empty") : "partial";
      };
      const snapshot = (task: PtTask, value: EngineSnapshot) => {
        if (!active() || value.contextKey !== job.fingerprint) return;
        const first = !job.tasks.some(entry => entry.result?.hits.length) && value.response.overall.length > 0;
        accept(task, value.response);
        void publish(first);
      };
      const challengeFor = (task: PtTask) =>
        job.cycle && task.route === "live" ? ptChallengeBest(job, task.measure) : null;
      const completed = (task: PtTask) => chartComplete(task) || chartExcluded(job, task);
      /** Runs one task; false once the run was stopped. */
      const step = async (task: PtTask, index: number): Promise<boolean> => {
        if (!active() || !remaining(deadline)) return false;
        if (completed(task)) return true;
        const challenge = challengeFor(task);
        if (job.cycle && task.route === "live" && !challenge) return true;
        // Overlap a small lookahead with the current proof and reuse the
        // shared chart cache, including during the initial single-chart run.
        this.engine.prefetch?.(tasks.slice(index, index + 4)
          .filter(next => next.route === task.route && !chartComplete(next) && next.status !== "pruned")
          .map(next => next.song));
        task.status = "running";
        await publish();
        if (!active()) return false;
        try {
          const request = { ...buildRequest(task, challenge), cutoff: ptTaskCutoff(job, task) };
          const response = await this.engine.run(request, undefined, value => snapshot(task, value));
          accept(task, response);
        } catch (error) {
          if (!active()) return false;
          task.status = "failed";
          task.error = error instanceof Error ? error.message : String(error);
        }
        if (!active()) return false;
        await publish();
        return true;
      };
      let runBatch = this.engine.runBatch?.bind(this.engine);
      for (const [index, task] of tasks.entries()) {
        if (!(await step(task, index))) break;
        // Establish an incumbent first. Then ordinary charts use separate
        // workers with the latest catalog cutoff when each chart starts.
        if (!runBatch || deadline !== Infinity || task.route !== "live"
            || job.request.goal.kind !== "event" || job.request.goal.gekiso || this.stopped) continue;
        const complete = proofStatus(job);
        const pending = tasks.slice(index + 1).filter(next => !complete(next) && (!job.cycle || challengeFor(next)));
        if (pending.length < 2) continue;
        try {
          await runBatch(pending.map(next => buildRequest(next, challengeFor(next))), (i, response) => {
            if (!active()) return;
            accept(pending[i]!, response);
            void publish();
          }, {
            prepare: (i, request) => {
              const next = pending[i]!;
              if (active()) next.status = "running";
              return { ...request, cutoff: ptTaskCutoff(job, next) };
            },
            snapshot: (i, value) => snapshot(pending[i]!, value),
          });
          break;
        } catch {
          if (!active()) break;
          runBatch = undefined;
          // Retry unresolved charts via the original per-chart path so a
          // failed Worker or resource does not discard completed results.
          for (const next of pending) if (next.status === "running") next.status = "queued";
        }
      }
    } finally {
      if (active()) {
        requeue();
        if (!ptComplete(job) && (budgetReached || !remaining(deadline))) job.stopReason = "budget";
        await publish(true);
      }
      this.checkpointStop = undefined;
      this.running = false;
    }
  }
}
