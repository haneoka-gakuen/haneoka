/** Local reward jobs. A completed or certified-excluded chart is the smallest resumable unit. */
import type { EngineHit, EngineRequest, EngineResponse, SongRef, SongResult } from "./engine/api";
import { clock, remaining, type RewardCutoff } from "./engine/execution";
import type { EngineSnapshot } from "./engine/protocol";
import { cpExchange } from "./engine/pt-value";

export const PT_VERSION = "reward-other-score-base-cb-v6";
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
  assumptions: string[];
  presentation?: { scope: "box" | "theoretical" };
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
export function ptCutoff(job: PtJob, measure: PtMeasure): number | undefined {
  return ptSongRanking(job, measure)[(job.scope === "top-one" ? 1 : 5) - 1]?.key;
}
export function ptTaskCutoff(job: PtJob, task: PtTask): RewardCutoff | undefined {
  if (job.scope === "all" || task.route !== "live") return;
  const last = ptSongRanking(job, task.measure)[(job.scope === "top-one" ? 1 : 5) - 1];
  if (!last) return;
  return { key: last.key, comparison: "gte", contextKey: job.fingerprint, ranking: "reward-mean-score-v2" };
}
const chartComplete = (task: PtTask) =>
  (task.status === "complete" || task.status === "empty") && task.result?.proven === true;
export function chartExcluded(job: PtJob, task: PtTask): boolean {
  const proof = task.result?.exclusion;
  const cutoff = ptTaskCutoff(job, task);
  return !!proof && !!cutoff && task.status === "pruned" && proof.contextKey === job.fingerprint && proof.ranking === cutoff.ranking &&
    (proof.key < cutoff.key || (proof.key === cutoff.key && (proof.comparison === "gte" || cutoff.comparison === "gt")));
}
export const ptAllComplete = (job: PtJob) => job.tasks.length > 0 && job.tasks.every(chartComplete);
export const ptComplete = (job: PtJob) => job.tasks.length > 0 && job.tasks.every(task => chartComplete(task) || chartExcluded(job, task));

export interface PtEngine {
  run(request: EngineRequest, progress?: (done: number, total: number) => void, snapshot?: (value: EngineSnapshot) => void): Promise<EngineResponse>;
  cancel(): void;
}
export interface PtJobStore {
  save(job: PtJob): Promise<void>;
  latest(server: string, owner: string): Promise<PtJob | null>;
}
export class PtRunner {
  running = false;
  private stopped = false;
  constructor(
    private readonly engine: PtEngine,
    private readonly store: PtJobStore,
    private readonly changed: (job: PtJob) => void,
    private readonly storageFailed: () => void,
  ) {}
  stop() {
    this.stopped = true;
    this.engine.cancel();
  }
  async run(job: PtJob, scope: PtScope = job.scope ?? "top-one", deadline = clock() + 3000): Promise<void> {
    if (this.running) throw new Error("pt-busy");
    this.running = true;
    this.stopped = false;
    job.scope = scope;
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
    try {
      for (const task of job.tasks)
        if (!chartComplete(task) && !chartExcluded(job, task)) {
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
      /** Runs one task; false once the run was stopped. */
      const step = async (task: PtTask): Promise<boolean> => {
        if (this.stopped || !remaining(deadline)) return false;
        if (chartComplete(task) || chartExcluded(job, task)) return true;
        const challenge = job.cycle && task.route === "live" ? ptChallengeBest(job, task.measure) : null;
        if (job.cycle && task.route === "live" && !challenge) return true;
        task.status = "running";
        await publish();
        if (this.stopped) {
          task.status = "queued";
          return false;
        }
        try {
          const request = structuredClone(job.request);
          if (request.goal.kind !== "event") throw new Error("pt-mode");
          request.goal.songs = [task.song];
          request.goal.route = task.route;
          request.goal.measure = task.measure;
          delete request.rewardCutoff;
          request.cutoff = ptTaskCutoff(job, task);
          request.deadline = deadline;
          request.contextKey = job.fingerprint;
          request.seeds = task.result?.hits ?? [];
          if (task.route === "challenge") {
            request.goal.consumption = job.cycle!.consumption;
            delete request.goal.gekiso;
          }
          if (challenge)
            request.goal.cpExchange = cpExchange(
              challenge.event!.rewardSum!,
              challenge.event!.orders!,
              job.cycle!.consumption,
            );
          const previous = task.result?.hits ?? [];
          const accept = (response: EngineResponse) => {
            const result = response.results.find(r => r.song && chartKey(r.song) === chartKey(task.song));
            if (!result) return;
            if (!result.hits.length && !result.proven) result.hits = task.result?.hits.length ? task.result.hits : previous;
            if (result.exclusion && result.hits.length && result.hits[0]!.key >= result.exclusion.key) {
              result.proven = true;
              result.bound = null;
              delete result.exclusion;
            }
            task.result = result;
            if (response.stopReason === "error") { task.status = "failed"; task.error = response.error ?? "engine-error"; return; }
            task.status = result.exclusion ? "pruned" : result.proven ? (result.hits.length ? "complete" : "empty") : "partial";
          };
          const response = await this.engine.run(request, undefined, snapshot => {
            if (snapshot.contextKey !== job.fingerprint) return;
            const first = !job.tasks.some(entry => entry.result?.hits.length) && snapshot.response.overall.length > 0;
            accept(snapshot.response);
            void publish(first);
          });
          accept(response);
        } catch (error) {
          if (this.stopped) {
            task.status = "queued";
            return false;
          }
          task.status = "failed";
          task.error = error instanceof Error ? error.message : String(error);
        }
        await publish();
        return true;
      };
      for (const task of tasks) if (!(await step(task))) break;
    } finally {
      for (const task of job.tasks) if (task.status === "running") task.status = "queued";
      this.running = false;
      await publish(true);
    }
  }
}
