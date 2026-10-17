/// <reference lib="webworker" />
// L3 — GEB
// Input: EngineCall、release 资料、固定来源谱面及 WASM URL。
// Output: EngineReply、进度、快照、计算结果或错误。
// Pos: [Map](L2-2.md)；当前 Rust/WASM 配队引擎的浏览器 Worker 适配。
// Effects/Dependencies: 获取 WASM／谱面、实例化 WebAssembly，持有句柄和缓存并发送消息。
/** Team engine Worker: the ournotes-team-builder engine (WebAssembly) holds the release and the charts it was sent, and
 * serves searches and evaluations. */
import engineUrl from "./generated/team-engine.wasm?url";
import { pinnedSongAssetUrl } from "../solver/song-loader";
import { teamBuilderSourceIdentity } from "../data/source";
import { dataRows, type TeamBuilderData } from "../data";
import type { EngineHit, EngineRequest, EngineResponse, SongRef, TeamEvaluation, Timeline } from "./api";
import { emptyResponse, requestSongs } from "./execution";
import type { EngineCall, EngineReply, ExplainRequest } from "./protocol";

interface Exports {
  memory: WebAssembly.Memory;
  haneoka_buffer_alloc(length: number): number;
  haneoka_buffer_free(pointer: number, length: number): void;
  haneoka_string_free(pointer: number): void;
  haneoka_context_json(input: number): number;
  haneoka_context_stream_wasm(input: number): number;
}
type Doc = Record<string, unknown>;

const post = (reply: EngineReply) => (self as unknown as DedicatedWorkerGlobalScope).postMessage(reply);
const encoder = new TextEncoder();
const decoder = new TextDecoder();
let activeId = 0;
let data: TeamBuilderData | null = null;
let engine: Exports | null = null;
let handle = 0;
/** Charts the engine holds (it keeps the latest few), as `songId:difficulty`. */
let cached: string[] = [];
let onProgress: ((value: Doc) => void) | null = null;

const readString = (pointer: number) => {
  const bytes = new Uint8Array(engine!.memory.buffer);
  let end = pointer;
  while (bytes[end]) end++;
  return decoder.decode(bytes.subarray(pointer, end));
};
async function instantiate() {
  const imports = {
    env: {
      haneoka_now_ms: () => performance.timeOrigin + performance.now(),
      haneoka_progress: (pointer: number) => onProgress?.(JSON.parse(readString(pointer)) as Doc),
    },
  };
  const { instance } = await WebAssembly.instantiateStreaming(fetch(engineUrl), imports);
  engine = instance.exports as unknown as Exports;
}
/** One engine call; a trapped instance is discarded, so the next call starts a fresh one. */
function invoke(input: Doc, stream = false): Doc {
  const e = engine!;
  const bytes = encoder.encode(JSON.stringify(input));
  const pointer = e.haneoka_buffer_alloc(bytes.length + 1);
  const target = new Uint8Array(e.memory.buffer, pointer, bytes.length + 1);
  target.set(bytes);
  target[bytes.length] = 0;
  let result = 0;
  try {
    result = stream ? e.haneoka_context_stream_wasm(pointer) : e.haneoka_context_json(pointer);
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
    handle = Number(invoke({ op: "create", data }).handle);
    cached = [];
  }
}

async function chartBytes(song: SongRef): Promise<Uint8Array> {
  const pinned = teamBuilderSourceIdentity(data!, "songs", song.songId);
  const row = Object.values(data!.songs).find((item) => Number(item.musicId) === song.songId);
  const file = dataRows(row?.difficulty).find((level) => Number(level.difficulty) === song.difficulty)?.file;
  if (typeof file !== "string" || !file) throw new Error("chart-file-missing");
  post({ type: "phase", id: activeId, phase: "network" });
  // A search over many songs fetches many charts: one dropped request must not fail all of them.
  let response = await fetch(pinnedSongAssetUrl(pinned, file), { credentials: "omit" }).catch(() => null);
  for (let attempt = 1; attempt < 3 && (!response || response.status >= 500); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
    response = await fetch(pinnedSongAssetUrl(pinned, file), { credentials: "omit" }).catch(() => null);
  }
  if (!response) throw new Error("chart-network");
  if (!response.ok) throw new Error(`chart-http:${response.status}`);
  // The URL pins the release; a server that labels it must agree.
  const release = response.headers.get("x-haneoka-release-id");
  if (release && release !== pinned.releaseId) throw new Error("chart-release-identity-mismatch");
  const bytes = new Uint8Array(await response.arrayBuffer());
  post({ type: "phase", id: activeId, phase: "computation" });
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return bytes;
  return new Uint8Array(await new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
}
/** The charts of `songs` the engine does not hold yet, in the order it will keep them. */
async function charts(songs: SongRef[]) {
  const staged = [...cached];
  const rows: Doc[] = [];
  for (const song of songs) {
    const key = `${song.songId}:${song.difficulty}`;
    const index = staged.indexOf(key);
    if (index >= 0) staged.splice(index, 1);
    else rows.push({ song, chart: JSON.parse(decoder.decode(await chartBytes(song))) });
    staged.push(key);
  }
  return rows;
}

self.onmessage = async (event: MessageEvent<EngineCall>) => {
  const call = event.data;
  try {
    if (call.type === "init") {
      data = call.data;
      handle = 0;
      await ready();
      post({ type: "ready", id: call.id });
      return;
    }
    if (!data) throw new Error("engine-not-ready");
    await ready();
    activeId = call.id;
    if (call.type === "run") {
      const request: EngineRequest = call.request;
      const songs = requestSongs(request).filter((song): song is SongRef => song !== null);
      const rows = await charts(songs);
      // Each improvement arrives as one song's best teams so far.
      onProgress = (value) => {
        const song = (value.song ?? null) as SongRef | null;
        const hits = (value.hits ?? []) as EngineHit[];
        const response = emptyResponse(request);
        const row = response.results.find((result) => result.song?.songId === song?.songId && result.song?.difficulty === song?.difficulty);
        if (row) row.hits = hits;
        response.overall = hits;
        post({ type: "snapshot", id: call.id, snapshot: { requestId: request.requestId!, contextKey: request.contextKey!, response, coverage: { completed: 0, total: response.results.length } } });
      };
      try {
        const result = invoke({ op: "run", handle, request, charts: rows }, true) as unknown as EngineResponse;
        post({ type: "progress", id: call.id, done: songs.length, total: songs.length });
        post({ type: "result", id: call.id, result });
      } finally {
        onProgress = null;
      }
    } else if (call.type === "growth") {
      const request: EngineRequest = call.request;
      const rows = await charts(requestSongs(request).filter((song): song is SongRef => song !== null));
      onProgress = (value) => {
        const growth = value.growth as { done: number; total: number } | undefined;
        if (growth) post({ type: "progress", id: call.id, done: growth.done, total: growth.total });
      };
      try {
        post({ type: "result", id: call.id, result: invoke({ op: "growth", handle, request, charts: rows }, true) });
      } finally {
        onProgress = null;
      }
    } else if (call.type === "evaluate") {
      const rows = await charts(call.request.songs);
      const result = invoke({ op: "evaluateAll", handle, request: call.request, charts: rows });
      post({ type: "result", id: call.id, result: result.evaluations as TeamEvaluation[] });
    } else if (call.type === "explain") {
      const request: ExplainRequest = call.request;
      const rows = await charts([request.song]);
      const order = request.eventOrder.map((key) => request.team.members.indexOf(key));
      const result = invoke({
        op: "timeline",
        handle,
        request: { ...request, memberKeys: request.team.members, snapKeys: request.team.snaps, order: order.filter((slot) => slot >= 0) },
        charts: rows,
      });
      post({ type: "result", id: call.id, result: { ...(result as unknown as Timeline), score: 0 } });
    } else if (call.type === "charts") {
      for (const row of await charts(call.songs)) {
        invoke({ op: "chart", handle, song: row.song, chart: row.chart });
        const song = row.song as SongRef;
        cached = [...cached.filter((key) => key !== `${song.songId}:${song.difficulty}`), `${song.songId}:${song.difficulty}`];
      }
      post({ type: "result", id: call.id, result: null });
    }
  } catch (error) {
    post({ type: "error", id: call.id, message: error instanceof Error ? error.message : String(error) });
  }
};
