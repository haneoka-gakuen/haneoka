/// <reference lib="webworker" />
// L3 — GEB
// Input: EngineCall、UTF-8 或字符串序列化的 release、谱面固定来源索引／JSON 对象或 UTF-8 载荷及编译后的 WASM 模块。
// Output: EngineReply（含执行应答及实例故障）、评级资格检查计数、候选快照、活动养成分页更新、区间任务点数频数、计算结果或错误；固定顺序样例沿用本地原生计分；时间线以请求队长为首映射成员与留影槽位；私有补分请求保留最终待评分候选，公开候选只含完整评分。
// Pos: [Map](L2-2.md)；当前 Rust/WASM 配队引擎的浏览器 Worker 适配。
// Effects/Dependencies: 补取未提供的固定谱面、实例化独立 WASM 内存；普通计时沿用同步导入，协作分片通过零指针进度回调按需让出；准备期间保留当前调用的排序下界，JSPI 暂停期间实时接收下界；活动养成复用句柄按八毫秒原生步进，每页就绪后保留搜索前沿，任务队列让出并支持可见性暂停，不读取谱面。
/** Team engine Worker: the ournotes-team-builder engine (WebAssembly) holds the release and the charts it was sent, and
 * serves searches and evaluations. */
import { chartKey, EngineCharts } from "./charts";
import type { EngineHit, EngineRequest, EngineResponse, SongRef, TeamEvaluation, Timeline, RewardFloor } from "./api";
import { emptyResponse, requestChartSongs } from "./execution";
import type { EncodedEngineChart, EngineCall, EngineChart, EngineReply, ExplainRequest } from "./protocol";
import type { EventTeamSearchResult } from "../../event-team-analysis";

interface Exports {
  memory: WebAssembly.Memory;
  haneoka_buffer_alloc(length: number): number;
  haneoka_buffer_free(pointer: number, length: number): void;
  haneoka_string_free(pointer: number): void;
  haneoka_context_json(input: number): number;
  haneoka_context_stream_wasm(input: number): number;
  haneoka_cooperative_clock?: (enabled: number) => void;
  haneoka_search_floor?: (value: number) => void;
  haneoka_search_reward?: (primary: number, other: number, mean: number) => void;
}
type PromiseWasm = {
  Suspending?: new (callback: (...args: number[]) => unknown) => WebAssembly.ImportValue;
  promising?: (callback: (pointer: number) => number) => (pointer: number) => Promise<number>;
};
const promiseWasm = WebAssembly as typeof WebAssembly & PromiseWasm;
type Doc = Record<string, unknown>;
type ChartPayload = EngineChart | EncodedEngineChart;

const post = (reply: EngineReply) => (self as unknown as DedicatedWorkerGlobalScope).postMessage(reply);
const encoder = new TextEncoder();
const decoder = new TextDecoder();
let activeId = 0;
let data: string | Uint8Array | null = null;
let downloads = new EngineCharts({});
let engine: Exports | null = null;
let compiled: WebAssembly.Module | null = null;
let handle = 0;
/** Charts the engine holds (it keeps the latest few), as `songId:difficulty`. */
let cached: string[] = [];
let chartCacheLimit = 4;
let onProgress: ((value: Doc) => void) | null = null;
let cooperativeRun = false;
let pendingFloor: number | null = null;
let pendingReward: RewardFloor | null = null;
let nextYield = 0;
const eventGrowthPaused = new Map<number, boolean>();
const eventGrowthResumes = new Map<number, () => void>();
const milliseconds = () => performance.timeOrigin + performance.now();
const continuation = new MessageChannel();
let resume: ((time: number) => void) | null = null;
continuation.port1.onmessage = () => {
  const resolve = resume;
  resume = null;
  resolve?.(milliseconds());
};
const yieldTask = () => new Promise<number>(resolve => { resume = resolve; continuation.port2.postMessage(null); });
const cooperativeClock = () => {
  const now = milliseconds();
  if (!cooperativeRun || now < nextYield) return;
  nextYield = now + 16;
  return yieldTask().then(() => undefined);
};
async function waitEventGrowth(id: number) {
  while (eventGrowthPaused.get(id)) await new Promise<void>(resolve => eventGrowthResumes.set(id, resolve));
}

const readString = (pointer: number) => {
  const bytes = new Uint8Array(engine!.memory.buffer);
  let end = pointer;
  while (bytes[end]) end++;
  return decoder.decode(bytes.subarray(pointer, end));
};
async function instantiate() {
  const imports = {
    env: {
      haneoka_now_ms: milliseconds,
      haneoka_progress: promiseWasm.Suspending && promiseWasm.promising ? new promiseWasm.Suspending((pointer: number) =>
        pointer === 0 ? cooperativeClock() : onProgress?.(JSON.parse(readString(pointer)) as Doc))
        : (pointer: number) => { if (pointer) onProgress?.(JSON.parse(readString(pointer)) as Doc); },
    },
  };
  const instance = await WebAssembly.instantiate(compiled!, imports);
  engine = instance.exports as unknown as Exports;
}
/** One engine call; a trapped instance is discarded, so the next call starts a fresh one. */
async function invoke(input: Doc | string | Uint8Array | Uint8Array[], stream = false): Promise<Doc> {
  const e = engine!;
  const parts = Array.isArray(input) ? input
    : [input instanceof Uint8Array ? input : encoder.encode(typeof input === "string" ? input : JSON.stringify(input))];
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const pointer = e.haneoka_buffer_alloc(length + 1);
  const target = new Uint8Array(e.memory.buffer, pointer, length + 1);
  let offset = 0;
  for (const part of parts) {
    target.set(part, offset);
    offset += part.length;
  }
  target[length] = 0;
  let result = 0;
  try {
    const operation = stream ? e.haneoka_context_stream_wasm : e.haneoka_context_json;
    e.haneoka_cooperative_clock?.(cooperativeRun ? 1 : 0);
    result = promiseWasm.Suspending && promiseWasm.promising
      ? await promiseWasm.promising(operation)(pointer) : operation(pointer);
    const output = JSON.parse(readString(result)) as Doc;
    if (typeof output.error === "string") throw new Error(output.error);
    if (Array.isArray(output.cachedCharts)) cached = output.cachedCharts.map(String);
    return output;
  } catch (error) {
    if (error instanceof WebAssembly.RuntimeError) {
      engine = null;
      handle = 0;
    }
    throw error;
  } finally {
    if (engine) {
      if (result) engine.haneoka_string_free(result);
      engine.haneoka_buffer_free(pointer, length + 1);
    }
  }
}
function requestWithCharts(request: Doc, charts: readonly ChartPayload[]): Doc | Uint8Array[] {
  if (!charts.some(row => "bytes" in row)) return { ...request, charts };
  const parts: Uint8Array[] = [encoder.encode(JSON.stringify(request).slice(0, -1) + ',"charts":[')];
  const comma = encoder.encode(",");
  for (const [index, row] of charts.entries()) {
    if (index > 0) parts.push(comma);
    parts.push("bytes" in row ? row.bytes : encoder.encode(JSON.stringify(row)));
  }
  parts.push(encoder.encode("]}"));
  return parts;
}
async function ready() {
  if (!engine) await instantiate();
  if (!handle) {
    const source = typeof data === "string" ? encoder.encode(data) : data!;
    const prefix = encoder.encode('{"op":"create","data":');
    const suffix = encoder.encode(',"trustedScores":true}');
    const context = await invoke([prefix, source, suffix]);
    handle = Number(context.handle);
    chartCacheLimit = Number(context.chartCacheLimit ?? 4);
    cached = [];
  }
}

/** The charts of `songs` the engine does not hold yet, in the order it will keep them. */
async function charts<T extends ChartPayload>(songs: SongRef[], loaded: readonly T[], touch = true): Promise<(EngineChart | T)[]> {
  const staged = [...cached];
  const rows: (EngineChart | T | SongRef)[] = [];
  const missing: SongRef[] = [];
  const bySong = loaded.length > 8 ? new Map<string, T>() : null;
  if (bySong) {
    for (let index = loaded.length - 1; index >= 0; index--) {
      const row = loaded[index]!;
      bySong.set(chartKey(row.song), row);
    }
  }
  for (const song of songs) {
    const key = `${song.songId}:${song.difficulty}`;
    const index = staged.indexOf(key);
    if (index >= 0 && !touch) continue;
    if (index >= 0) staged.splice(index, 1);
    else {
      const prepared = bySong ? bySong.get(key) : loaded.find(row => chartKey(row.song) === key);
      if (prepared) rows.push(prepared);
      else {
        missing.push(song);
        rows.push(song);
      }
    }
    staged.push(key);
    if (staged.length > chartCacheLimit) staged.shift();
  }
  if (missing.length === 0) return rows as (EngineChart | T)[];
  post({ type: "phase", id: activeId, phase: "network" });
  const recovered = await downloads.loadMany(missing);
  post({ type: "phase", id: activeId, phase: "computation" });
  let next = 0;
  return rows.map(row => "song" in row ? row : recovered[next++]!);
}

async function execute(call: EngineCall) {
  try {
    if (call.type === "init") {
      data = call.data;
      downloads.cancel();
      downloads = new EngineCharts(call.charts);
      compiled = call.module;
      handle = 0;
      await ready();
      const cooperativeFloor = !!promiseWasm.Suspending && !!promiseWasm.promising && !!engine?.haneoka_search_floor && !!engine?.haneoka_cooperative_clock;
      post({ type: "ready", id: call.id, chartCacheLimit, cooperativeFloor, cooperativeReward: cooperativeFloor && !!engine?.haneoka_search_reward });
      return;
    }
    if (!data) throw new Error("engine-not-ready");
    await ready();
    activeId = call.id;
    post({ type: "started", id: call.id });
    const loaded: readonly ChartPayload[] = call.loadedChartBytes ?? call.loadedCharts ?? [];
    if (call.type === "run") {
      let request: EngineRequest = call.request;
      pendingFloor = call.initialFloor ?? -Infinity;
      pendingReward = call.initialReward ?? request.rewardIncumbent ?? null;
      const songs = requestChartSongs(request).filter((song): song is SongRef => song !== null);
      const rows = await charts(songs, loaded);
      if (pendingFloor !== null && Number.isFinite(pendingFloor)) {
        request = request.rewardPhase && request.rewardPhase.kind !== "primary"
          ? { ...request, rewardPhase: { ...request.rewardPhase, floor: Math.max(request.rewardPhase.floor ?? -Infinity, pendingFloor) } }
          : { ...request, floors: { ...request.floors, [chartKey(songs[0]!)]: Math.max(request.floors?.[chartKey(songs[0]!)] ?? -Infinity, pendingFloor) } };
      }
      // Each improvement arrives as one song's best teams so far.
      onProgress = (value) => {
        const song = (value.song ?? null) as SongRef | null;
        if (typeof value.checkedTeams === "number") {
          post({ type: "checkedTeams", id: call.id, song, count: value.checkedTeams });
          return;
        }
        const hits = ((value.hits ?? []) as EngineHit[]).filter(hit => !call.deferScores || hit.score?.orders.length === 120);
        const response = emptyResponse(request);
        const row = response.results.find((result) => result.song?.songId === song?.songId && result.song?.difficulty === song?.difficulty);
        if (row) row.hits = hits;
        response.overall = hits;
        post({ type: "snapshot", id: call.id, snapshot: { requestId: request.requestId!, contextKey: request.contextKey!, response, coverage: { completed: 0, total: response.results.length } } });
      };
      try {
        cooperativeRun = call.cooperativeFloor === true && !!promiseWasm.Suspending && !!promiseWasm.promising && !!engine?.haneoka_search_floor;
        nextYield = milliseconds() + 16;
        post({ type: "phase", id: call.id, phase: "computation" });
        const output = await invoke(requestWithCharts({
          op: "run", handle, request: { ...request, ...(call.deferScores ? { deferScores: true } : {}), ...(pendingReward ? { rewardIncumbent: pendingReward } : {}), cooperativeFloor: cooperativeRun },
          scoredSeeds: call.scoredSeeds, reportRankChecks: call.reportRankChecks,
          exportScores: request.goal.kind === "gekiso" || (request.goal.kind === "event" && !!request.goal.gekiso),
        }, rows), true);
        const scoredSeeds = output._scoredSeeds as unknown[] | undefined;
        delete output._scoredSeeds;
        const result = output as unknown as EngineResponse;
        // Native runs that exhaust the budget before evaluating a chart return null here.
        if (result.unknownCards === null) result.unknownCards = [];
        post({ type: "progress", id: call.id, done: songs.length, total: songs.length });
        post({ type: "result", id: call.id, result, scoredSeeds, cachedCharts: cached });
      } finally {
        cooperativeRun = false;
        pendingFloor = null;
        pendingReward = null;
        onProgress = null;
      }
    } else if (call.type === "growth") {
      const request: EngineRequest = call.request;
      const rows = await charts(requestChartSongs(request).filter((song): song is SongRef => song !== null), loaded);
      onProgress = (value) => {
        const growth = value.growth as { done: number; total: number } | undefined;
        if (growth) post({ type: "progress", id: call.id, done: growth.done, total: growth.total });
      };
      try {
        post({ type: "result", id: call.id, result: await invoke(requestWithCharts({ op: "growth", handle, request }, rows), true), cachedCharts: cached });
      } finally {
        onProgress = null;
      }
    } else if (call.type === "eventGrowth" || call.type === "eventGrowthPage") {
      try {
        await waitEventGrowth(call.id);
        let result = await invoke(call.type === "eventGrowth"
          ? { op: "eventGrowthStart", handle, request: call.request }
          : { op: "eventGrowthPage", handle, page: call.page }) as unknown as EventTeamSearchResult;
        let lastPublished = -Infinity, hadRows = false;
        while (!result.complete && !result.awaitingPage) {
          const now = performance.now();
          if (!hadRows && result.rows.length > 0 || now - lastPublished >= 100) {
            post({ type: "eventGrowth", id: call.id, result });
            lastPublished = now;
          }
          hadRows ||= result.rows.length > 0;
          await yieldTask();
          await waitEventGrowth(call.id);
          result = await invoke({ op: "eventGrowthStep", handle, budgetMs: 8 }) as unknown as EventTeamSearchResult;
        }
        post({ type: "result", id: call.id, result });
      } finally {
        eventGrowthPaused.delete(call.id);
        eventGrowthResumes.delete(call.id);
      }
    } else if (call.type === "sample") {
      const rows = await charts(call.request.songs, loaded);
      post({ type: "result", id: call.id, result: await invoke(requestWithCharts({ op: "sample", handle, request: call.request }, rows)), cachedCharts: cached });
    } else if (call.type === "evaluate") {
      const rows = await charts(call.request.songs, loaded);
      const result = await invoke(requestWithCharts({ op: "evaluateAll", handle, request: call.request }, rows));
      post({ type: "result", id: call.id, result: result.evaluations as TeamEvaluation[], cachedCharts: cached });
    } else if (call.type === "sectionMetrics") {
      const rows = await charts(call.request.songs, loaded);
      const result = await invoke(requestWithCharts({ op: "sectionMetrics", handle, request: call.request }, rows));
      post({ type: "result", id: call.id, result: result.metrics, cachedCharts: cached });
    } else if (call.type === "explain") {
      const request: ExplainRequest = call.request;
      const rows = await charts([request.song], loaded);
      const leader = request.team.members.indexOf(request.team.leader);
      const slots = [leader, ...request.team.members.map((_, index) => index).filter(index => index !== leader)];
      const memberKeys = slots.map(index => request.team.members[index]!);
      const snapKeys = slots.map(index => request.team.snaps[index] ?? null);
      const order = request.eventOrder.map((key) => memberKeys.indexOf(key));
      const result = await invoke(requestWithCharts({
        op: "timeline",
        handle,
        request: { ...request, memberKeys, snapKeys, order: order.filter((slot) => slot >= 0) },
      }, rows));
      post({ type: "result", id: call.id, result: { ...(result as unknown as Timeline), score: 0 }, cachedCharts: cached });
    } else if (call.type === "charts") {
      for (const row of await charts(call.songs, call.loadedCharts ?? [], false)) {
        await invoke({ op: "chart", handle, song: row.song, chart: row.chart });
      }
      post({ type: "result", id: call.id, result: null, cachedCharts: cached });
    }
  } catch (error) {
    pendingFloor = null;
    eventGrowthPaused.delete(call.id);
    eventGrowthResumes.delete(call.id);
    post({ type: "error", id: call.id, message: error instanceof Error ? error.message : String(error) });
  }
}
let operations = Promise.resolve();
self.addEventListener("messageerror", () => post({ type: "fatal", message: "engine-message-error" }));
self.onmessage = (event: MessageEvent<EngineCall>) => {
  const call = event.data;
  if (call.type === "pauseEventGrowth") {
    if (eventGrowthPaused.has(call.id)) {
      eventGrowthPaused.set(call.id, call.paused);
      if (!call.paused) { eventGrowthResumes.get(call.id)?.(); eventGrowthResumes.delete(call.id); }
    }
  } else if (call.type === "floor") {
    if (call.id === activeId && pendingFloor !== null && Number.isFinite(call.value)) {
      pendingFloor = Math.max(pendingFloor, call.value);
      if (call.reward) pendingReward = call.reward;
      if (cooperativeRun) engine?.haneoka_search_floor?.(call.value);
      if (cooperativeRun && call.reward) engine?.haneoka_search_reward?.(...call.reward);
    }
  } else {
    if (call.type === "eventGrowth" || call.type === "eventGrowthPage") eventGrowthPaused.set(call.id, call.paused ?? false);
    operations = operations.then(() => execute(call));
  }
};
