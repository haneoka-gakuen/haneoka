/// <reference lib="webworker" />
// L3 — GEB
// Input: EngineCall、已序列化 release、谱面固定来源索引／共享载荷及编译后的 WASM 模块。
// Output: EngineReply、进度、快照、活动养成更新、计算结果或错误；时间线以请求队长为首映射成员与留影槽位；私有补分请求保留最终待评分候选，公开进度只含完整评分。
// Pos: [Map](L2-2.md)；当前 Rust/WASM 配队引擎的浏览器 Worker 适配。
// Effects/Dependencies: 补取未提供的固定谱面、实例化独立 WASM 内存；准备期间保留当前调用的排序下界，JSPI 暂停期间实时接收下界；活动养成复用句柄按八毫秒原生步进，任务队列让出并支持可见性暂停，不读取谱面。
/** Team engine Worker: the ournotes-team-builder engine (WebAssembly) holds the release and the charts it was sent, and
 * serves searches and evaluations. */
import { chartKey, downloadChart } from "./charts";
import type { EngineHit, EngineRequest, EngineResponse, SongRef, TeamEvaluation, Timeline, RewardFloor } from "./api";
import { emptyResponse, requestChartSongs } from "./execution";
import type { EngineCall, EngineChart, EngineChartSources, EngineReply, ExplainRequest } from "./protocol";
import type { EventTeamSearchResult } from "../../event-team-analysis";

interface Exports {
  memory: WebAssembly.Memory;
  haneoka_buffer_alloc(length: number): number;
  haneoka_buffer_free(pointer: number, length: number): void;
  haneoka_string_free(pointer: number): void;
  haneoka_context_json(input: number): number;
  haneoka_context_stream_wasm(input: number): number;
  haneoka_search_floor?: (value: number) => void;
  haneoka_search_reward?: (primary: number, other: number, mean: number) => void;
}
type PromiseWasm = {
  Suspending?: new (callback: () => number | Promise<number>) => WebAssembly.ImportValue;
  promising?: (callback: (pointer: number) => number) => (pointer: number) => Promise<number>;
};
const promiseWasm = WebAssembly as typeof WebAssembly & PromiseWasm;
type Doc = Record<string, unknown>;

const post = (reply: EngineReply) => (self as unknown as DedicatedWorkerGlobalScope).postMessage(reply);
const encoder = new TextEncoder();
const decoder = new TextDecoder();
let activeId = 0;
let data: string | null = null;
let chartSources: EngineChartSources = {};
let engine: Exports | null = null;
let compiled: WebAssembly.Module | null = null;
let handle = 0;
/** Charts the engine holds (it keeps the latest few), as `songId:difficulty`. */
let cached: string[] = [];
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
  if (!cooperativeRun || now < nextYield) return now;
  nextYield = now + 16;
  return yieldTask();
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
      haneoka_now_ms: promiseWasm.Suspending && promiseWasm.promising ? new promiseWasm.Suspending(cooperativeClock) : milliseconds,
      haneoka_progress: (pointer: number) => onProgress?.(JSON.parse(readString(pointer)) as Doc),
    },
  };
  const instance = await WebAssembly.instantiate(compiled!, imports);
  engine = instance.exports as unknown as Exports;
}
/** One engine call; a trapped instance is discarded, so the next call starts a fresh one. */
async function invoke(input: Doc | string, stream = false): Promise<Doc> {
  const e = engine!;
  const bytes = encoder.encode(typeof input === "string" ? input : JSON.stringify(input));
  const pointer = e.haneoka_buffer_alloc(bytes.length + 1);
  const target = new Uint8Array(e.memory.buffer, pointer, bytes.length + 1);
  target.set(bytes);
  target[bytes.length] = 0;
  let result = 0;
  try {
    const operation = stream ? e.haneoka_context_stream_wasm : e.haneoka_context_json;
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
      engine.haneoka_buffer_free(pointer, bytes.length + 1);
    }
  }
}
async function ready() {
  if (!engine) await instantiate();
  if (!handle) {
    handle = Number((await invoke(`{"op":"create","data":${data},"trustedScores":true}`)).handle);
    cached = [];
  }
}

/** The charts of `songs` the engine does not hold yet, in the order it will keep them. */
async function charts(songs: SongRef[], loaded: EngineChart[] = [], touch = true) {
  const staged = [...cached];
  const rows: Doc[] = [];
  for (const song of songs) {
    const key = `${song.songId}:${song.difficulty}`;
    const index = staged.indexOf(key);
    if (index >= 0 && !touch) continue;
    if (index >= 0) staged.splice(index, 1);
    else {
      const prepared = loaded.find(row => chartKey(row.song) === key);
      if (prepared) rows.push(prepared);
      else {
        post({ type: "phase", id: activeId, phase: "network" });
        rows.push({ song, chart: await downloadChart(chartSources[key]) });
        post({ type: "phase", id: activeId, phase: "computation" });
      }
    }
    staged.push(key);
    if (staged.length > 4) staged.shift();
  }
  return rows;
}

async function execute(call: EngineCall) {
  try {
    if (call.type === "init") {
      data = call.data;
      chartSources = call.charts;
      compiled = call.module;
      handle = 0;
      await ready();
      const cooperativeFloor = !!promiseWasm.Suspending && !!promiseWasm.promising && !!engine?.haneoka_search_floor;
      post({ type: "ready", id: call.id, cooperativeFloor, cooperativeReward: cooperativeFloor && !!engine?.haneoka_search_reward });
      return;
    }
    if (!data) throw new Error("engine-not-ready");
    await ready();
    activeId = call.id;
    if (call.type === "run") {
      let request: EngineRequest = call.request;
      pendingFloor = call.initialFloor ?? -Infinity;
      pendingReward = call.initialReward ?? request.rewardIncumbent ?? null;
      const songs = requestChartSongs(request).filter((song): song is SongRef => song !== null);
      const rows = await charts(songs, call.loadedCharts);
      if (pendingFloor !== null && Number.isFinite(pendingFloor)) {
        request = request.rewardPhase && request.rewardPhase.kind !== "primary"
          ? { ...request, rewardPhase: { ...request.rewardPhase, floor: Math.max(request.rewardPhase.floor ?? -Infinity, pendingFloor) } }
          : { ...request, floors: { ...request.floors, [chartKey(songs[0]!)]: Math.max(request.floors?.[chartKey(songs[0]!)] ?? -Infinity, pendingFloor) } };
      }
      // Each improvement arrives as one song's best teams so far.
      onProgress = (value) => {
        const song = (value.song ?? null) as SongRef | null;
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
        const output = await invoke({ op: "run", handle, request: { ...request, ...(call.deferScores ? { deferScores: true } : {}), ...(pendingReward ? { rewardIncumbent: pendingReward } : {}), cooperativeFloor: cooperativeRun },
          charts: rows, scoredSeeds: call.scoredSeeds,
          exportScores: request.goal.kind === "gekiso" || (request.goal.kind === "event" && !!request.goal.gekiso) }, true);
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
      const rows = await charts(requestChartSongs(request).filter((song): song is SongRef => song !== null), call.loadedCharts);
      onProgress = (value) => {
        const growth = value.growth as { done: number; total: number } | undefined;
        if (growth) post({ type: "progress", id: call.id, done: growth.done, total: growth.total });
      };
      try {
        post({ type: "result", id: call.id, result: await invoke({ op: "growth", handle, request, charts: rows }, true), cachedCharts: cached });
      } finally {
        onProgress = null;
      }
    } else if (call.type === "eventGrowth") {
      try {
        await waitEventGrowth(call.id);
        let result = await invoke({ op: "eventGrowthStart", handle, request: call.request }) as unknown as EventTeamSearchResult;
        let lastPublished = -Infinity, hadRows = false;
        while (!result.complete) {
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
    } else if (call.type === "evaluate") {
      const rows = await charts(call.request.songs, call.loadedCharts);
      const result = await invoke({ op: "evaluateAll", handle, request: call.request, charts: rows });
      post({ type: "result", id: call.id, result: result.evaluations as TeamEvaluation[], cachedCharts: cached });
    } else if (call.type === "explain") {
      const request: ExplainRequest = call.request;
      const rows = await charts([request.song], call.loadedCharts);
      const leader = request.team.members.indexOf(request.team.leader);
      const slots = [leader, ...request.team.members.map((_, index) => index).filter(index => index !== leader)];
      const memberKeys = slots.map(index => request.team.members[index]!);
      const snapKeys = slots.map(index => request.team.snaps[index] ?? null);
      const order = request.eventOrder.map((key) => memberKeys.indexOf(key));
      const result = await invoke({
        op: "timeline",
        handle,
        request: { ...request, memberKeys, snapKeys, order: order.filter((slot) => slot >= 0) },
        charts: rows,
      });
      post({ type: "result", id: call.id, result: { ...(result as unknown as Timeline), score: 0 }, cachedCharts: cached });
    } else if (call.type === "charts") {
      for (const row of await charts(call.songs, call.loadedCharts, false)) {
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
    if (call.type === "eventGrowth") eventGrowthPaused.set(call.id, call.paused ?? false);
    operations = operations.then(() => execute(call));
  }
};
