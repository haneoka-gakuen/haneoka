// L3 — GEB
// Input: 固定 release 的谱面来源。
// Output: 完整谱面 JSON 及受文本字节数和张数限制的共享下载缓存。
// Pos: [Map](L2-2.md)；主线程和 Worker 的谱面装载。
// Effects/Dependencies: 按固定身份共享在途下载，以 AbortController 处理取消及限时重试，身份核对和 gzip 解压；可预置离线固定谱面。
import { RequestScope, throwIfAborted } from "../../request-scope";
import { pinnedSongAssetUrl } from "../solver/song-loader";
import type { SongRef } from "./api";
import type { EngineChart, EngineChartSources } from "./protocol";

export const chartKey = (song: SongRef) => `${song.songId}:${song.difficulty}`;
const CACHE_BYTES = 8 * 1024 * 1024;
const CACHE_CHARTS = 128;
const chartSizes = new WeakMap<Record<string, unknown>, number>();

export async function downloadChart(source: EngineChartSources[string] | undefined, signal?: AbortSignal): Promise<Record<string, unknown>> {
  if (!source?.file) throw new Error("chart-file-missing");
  const { identity, file, apiBase } = source;
  const path = pinnedSongAssetUrl(identity, file);
  const target = apiBase ? new URL(path, apiBase).href : path;
  const request = new RequestScope();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const fetchChart = async () => {
    if (signal) throwIfAborted(signal);
    clearTimeout(timeout);
    const requestSignal = request.begin(signal);
    timeout = setTimeout(() => request.cancel(), 60_000);
    const response = await fetch(target, { credentials: "omit", signal: requestSignal }).catch(() => null);
    if (signal) throwIfAborted(signal);
    return response;
  };
  try {
    let response = await fetchChart();
    for (let attempt = 1; attempt < 3 && (!response || response.status >= 500); attempt++) {
      await new Promise(resolve => setTimeout(resolve, 500 * attempt));
      response = await fetchChart();
    }
    if (!response) throw new Error("chart-network");
    if (!response.ok) throw new Error(`chart-http:${response.status}`);
    const release = response.headers.get("x-haneoka-release-id");
    if (release && release !== identity.releaseId) throw new Error("chart-release-identity-mismatch");
    let bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
      bytes = new Uint8Array(await new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
    }
    const chart = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
    chartSizes.set(chart, bytes.byteLength);
    return chart;
  } finally {
    clearTimeout(timeout);
    request.cancel();
  }
}

export class EngineCharts {
  private readonly downloads = new Map<string, Promise<EngineChart>>();
  private readonly pending = new Map<string, Promise<EngineChart>>();
  private readonly sizes = new Map<string, number>();
  private bytes = 0;
  prime(rows: readonly EngineChart[]) {
    for (const row of rows) {
      const key = chartKey(row.song);
      if (this.downloads.has(key)) continue;
      const size = new TextEncoder().encode(JSON.stringify(row.chart)).byteLength;
      if (size > CACHE_BYTES) continue;
      while (this.downloads.size >= CACHE_CHARTS || this.bytes + size > CACHE_BYTES) {
        const oldest = this.downloads.keys().next().value!;
        this.bytes -= this.sizes.get(oldest)!;
        this.sizes.delete(oldest);
        this.downloads.delete(oldest);
      }
      this.downloads.set(key, Promise.resolve(row));
      this.sizes.set(key, size);
      this.bytes += size;
    }
  }
  private lifetime = new AbortController();
  constructor(private readonly sources: EngineChartSources) {}
  load(song: SongRef): Promise<EngineChart> {
    const key = chartKey(song);
    const existing = this.pending.get(key) ?? this.downloads.get(key);
    if (existing) {
      if (this.downloads.delete(key)) this.downloads.set(key, existing);
      return existing;
    }
    const download = downloadChart(this.sources[key], this.lifetime.signal).then(chart => {
      const size = chartSizes.get(chart)!;
      if (size <= CACHE_BYTES && this.pending.get(key) === download) {
        while (this.downloads.size >= CACHE_CHARTS || this.bytes + size > CACHE_BYTES) {
          const oldest = this.downloads.keys().next().value!;
          this.bytes -= this.sizes.get(oldest)!;
          this.sizes.delete(oldest);
          this.downloads.delete(oldest);
        }
        this.downloads.set(key, download);
        this.sizes.set(key, size);
        this.bytes += size;
      }
      return { song, chart };
    }).finally(() => { if (this.pending.get(key) === download) this.pending.delete(key); });
    this.pending.set(key, download);
    return download;
  }
  prefetch(songs: readonly SongRef[]) {
    void this.loadMany(songs.slice(0, CACHE_CHARTS)).catch(() => {});
  }
  async loadMany(songs: readonly SongRef[]): Promise<EngineChart[]> {
    const rows = new Array<EngineChart>(songs.length);
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(6, songs.length) }, async () => {
        while (next < songs.length) {
          const index = next++;
          rows[index] = await this.load(songs[index]!);
        }
      }),
    );
    return rows;
  }
  cancel() {
    this.pending.clear();
    this.lifetime.abort();
    this.lifetime = new AbortController();
  }
}
