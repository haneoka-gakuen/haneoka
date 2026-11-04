// L3 — GEB
// Input: 现有 SEKAI 曲库、SUS 谱面与可选音乐／封面。
// Output: 普通创作工程、来源收据和媒体文件。
// Pos: [Map](../L2-2.md)；SEKAI 曲库到统一谱面工程的导入适配。
// Effects/Dependencies: 同源 SEKAI API、有界下载、取消与 SHA-256；不选择另一套编辑或播放规则。
import { importSus } from "../../../packages/chart-editor/src/formats/sus";
import { readBytes } from "../../../packages/embed-core/src/io";
import { AUDIO_LIMITS } from "./audio";
import { createCreationSongCardData } from "./song-card";
import type { PublicCreationSong, PublicSongSourceOptions } from "./public-songs";

type SekaiOptions = PublicSongSourceOptions & { locale: string; signal: AbortSignal };
const base = (options: SekaiOptions) => new URL("/api/v1/sekai/jp/",
  options.apiBase ?? (typeof location === "undefined" ? "https://haneoka.org" : location.origin));
async function read(options: SekaiOptions, path: string, maxBytes: number) {
  const url = new URL(path, base(options));
  if (url.origin !== base(options).origin || !url.pathname.startsWith("/api/v1/sekai/jp/"))
    throw new Error("invalid_sekai_source");
  const response = await (options.fetcher ?? fetch)(new Request(url, { signal: options.signal, credentials: "omit" }));
  const bytes = await readBytes(response, { signal: options.signal, maxBytes, locale: options.locale,
    fetcher: options.fetcher ?? fetch, progress: () => {} });
  return { bytes, type: response.headers.get("content-type")?.split(";")[0] };
}
async function json(options: SekaiOptions, path: string) {
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode((await read(options, path, 8 * 1024 * 1024)).bytes));
}
export async function listSekaiCreatorSongs(options: SekaiOptions) {
  const songs = await json(options, "songs") as Record<string, PublicCreationSong>;
  return { items: Object.entries(songs).map(([id, value]) => ({ id, value })) };
}
export async function loadSekaiCreationSongCardData(options: SekaiOptions) {
  return createCreationSongCardData({ provider: "sekai", region: "jp", bands: await json(options, "bands"),
    characters: {}, marks: {}, assetUrl: value => typeof value === "string" && value ? new URL(value, base(options)).href : "" });
}
export async function loadSekaiCreatorSong(options: SekaiOptions & { songId: string; difficulty: string; song?: PublicCreationSong }) {
  if (!/^[1-9]\d{0,8}$/.test(options.songId)) throw new Error("invalid_sekai_selection");
  const metadata = options.song ?? await json(options, `songs/${options.songId}`) as PublicCreationSong;
  const difficulty = metadata.difficulty.find(row => row.difficultyName === options.difficulty);
  if (!difficulty) throw new Error("invalid_sekai_selection");
  const chart = await read(options, difficulty.file, 2 * 1024 * 1024);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(chart.bytes), imported = importSus(text);
  imported.project.meta.title = String(metadata.musicTitle);
  imported.project.meta.artist = String(metadata.composer ?? "");
  imported.project.meta.difficulty = options.difficulty;
  imported.project.meta.level = String(difficulty.playLevel ?? "");
  imported.project.audioOffset += Number(metadata.chartOffsetMs ?? 0) / 1000;
  const optionalMedia = async (url: string | undefined, name: string, maxBytes: number) => {
    if (!url) return undefined;
    try {
      const { bytes, type } = await read({ ...options, signal: AbortSignal.any([options.signal, AbortSignal.timeout(20_000)]) }, url, maxBytes);
      return new File([bytes], name, { type: type ?? "application/octet-stream" });
    } catch { options.signal.throwIfAborted(); return undefined; }
  };
  const [audio, coverFile] = await Promise.all([
    optionalMedia(metadata.musicUrl, `sekai-${options.songId}.mp3`, AUDIO_LIMITS.bytes),
    optionalMedia(metadata.jacketUrl, `sekai-${options.songId}.webp`, 10 * 1024 * 1024),
  ]);
  options.signal.throwIfAborted();
  const sha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", chart.bytes))]
    .map(value => value.toString(16).padStart(2, "0")).join("");
  return { provider: "sekai" as const, metadata, project: imported.project, warnings: imported.warnings, audio, coverFile,
    source: { name: `sekai-${options.songId}-${options.difficulty}.sus`, text, sha256 } };
}
