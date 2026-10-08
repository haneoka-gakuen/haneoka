import { bestdoriChartToSs } from "../../../packages/bestdori/src/chart";
import { isBestdoriServer, type BestdoriServer } from "../../../packages/bestdori/src/transport";
import { importBestdoriChart } from "../../../packages/chart-editor/src/formats/bestdori";
import { readBytes } from "../../../packages/embed-core/src/io";
import type { EmbedFetcher } from "../../../packages/embed-core/src/types";
import { resolveLocalizedText } from "../localized-text";
import { AUDIO_LIMITS } from "./audio";
import { createCreationSongCardData } from "./song-card";

export interface BestdoriCreatorOptions {
  apiBase?: string;
  region: BestdoriServer;
  locale: string;
  signal: AbortSignal;
  fetcher?: EmbedFetcher;
}
export interface BestdoriCreatorDifficulty extends Record<string, unknown> {
  difficulty: string;
  playLevel?: number;
  file?: string;
}
export interface BestdoriCreatorSong extends Record<string, unknown> {
  musicId: number;
  musicTitle: unknown;
  musicUrl?: string;
  bandName?: unknown;
  jacketUrl?: string;
  jacketThumbUrl?: string;
  bandId?: number;
  musicType?: number;
  difficulty: BestdoriCreatorDifficulty[];
}
export interface BestdoriCreatorIdentity {
  provider: "bestdori";
  game: "garupa";
  requestedRegion: BestdoriServer;
  audioRegion?: BestdoriServer;
  catalogEtag: string | null;
  chartEtag: string | null;
  chartSha256: string;
}
function base(options: BestdoriCreatorOptions) {
  if (!isBestdoriServer(options.region)) throw new Error("invalid_bestdori_region");
  const url = new URL(options.apiBase ?? "https://haneoka.org/api/v1/garupa/bestdori/");
  if (!["https:", "http:"].includes(url.protocol) || url.search || url.hash)
    throw new Error("invalid_bestdori_api_base");
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url;
}
function route(options: BestdoriCreatorOptions, path: string) {
  const url = new URL(`${options.region}/${path}`, base(options));
  url.searchParams.set("lang", options.locale);
  return url.href;
}
async function read(options: BestdoriCreatorOptions, url: string, maximum: number) {
  options.signal.throwIfAborted();
  const response = await (options.fetcher ?? fetch)(
    new Request(url, { signal: options.signal, credentials: "omit", referrerPolicy: "no-referrer" }),
  );
  const bytes = await readBytes(response, {
    signal: options.signal,
    maxBytes: maximum,
    locale: options.locale,
    fetcher: options.fetcher ?? fetch,
    progress: () => {},
  });
  return { bytes, response };
}
function song(value: unknown): BestdoriCreatorSong {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_bestdori_song");
  const row = value as BestdoriCreatorSong;
  if (
    !Number.isSafeInteger(row.musicId) ||
    row.musicId < 1 ||
    !Array.isArray(row.difficulty) ||
    row.difficulty.some((d) => !d || typeof d.difficulty !== "string")
  )
    throw new Error("invalid_bestdori_song");
  return row;
}
/** Existing provider namespace only; no OurNotes release IDs or duplicate song registry. */
export async function listBestdoriCreatorSongs(options: BestdoriCreatorOptions) {
  options = { ...options };
  const { bytes, response } = await read(options, route(options, "songs"), 8 * 1024 * 1024);
  const json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (!json || typeof json !== "object" || Array.isArray(json)) throw new Error("invalid_bestdori_catalog");
  return {
    provider: "bestdori" as const,
    region: options.region,
    etag: response.headers.get("etag"),
    items: Object.entries(json).map(([id, value]) => ({ id, value: song(value) })),
  };
}
/** The existing catalogue's authored credits and declared round icons, loaded once per picker scope. */
export async function loadBestdoriCreationSongCardData(options: BestdoriCreatorOptions) {
  options = { ...options };
  options.signal.throwIfAborted();
  const [bands, characters] = await Promise.all([
    read(options, route(options, "bands"), 2 * 1024 * 1024),
    read(options, route(options, "characters"), 2 * 1024 * 1024),
  ]);
  options.signal.throwIfAborted();
  const scope = base(options);
  return createCreationSongCardData({
    provider: "bestdori",
    region: options.region,
    bands: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bands.bytes)),
    characters: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(characters.bytes)),
    marks: {},
    assetUrl: (value) => {
      if (typeof value !== "string" || !value) return "";
      const url = new URL(value, scope);
      if (url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname))
        throw new Error("bestdori_visual_url_mismatch");
      return url.href;
    },
  });
}
/** Original Bestdori JSON is retained; the existing bridge supplies geometry, not shared gameplay rules. */
export async function loadBestdoriCreatorSong(
  options: BestdoriCreatorOptions & {
    songId: string;
    difficulty: string;
    withAudio?: boolean;
    bridgeLaneBasis?: number;
    audioOffset?: number;
  },
) {
  if (
    !/^[1-9]\d{0,8}$/.test(options.songId) ||
    !["easy", "normal", "hard", "expert", "special"].includes(options.difficulty)
  )
    throw new Error("invalid_bestdori_selection");
  options = { ...options };
  options.signal.throwIfAborted();
  const [metadataRead, bandsRead] = await Promise.all([
    read(options, route(options, `songs/${options.songId}`), 2 * 1024 * 1024),
    read(options, route(options, "bands"), 2 * 1024 * 1024),
  ]);
  const metadata = song(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(metadataRead.bytes)));
  if (metadata.musicId !== Number(options.songId)) throw new Error("bestdori_song_mismatch");
  const bands = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bandsRead.bytes));
  const difficulty = metadata.difficulty.find((d) => d.difficulty === options.difficulty);
  if (!difficulty) throw new Error("bestdori_difficulty_missing");
  const sourceUrl = route(options, `raw/api/charts/${options.songId}/${options.difficulty}.json`);
  const chartRead = await read(options, sourceUrl, 2 * 1024 * 1024);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(chartRead.bytes);
  const chartSha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", chartRead.bytes))]
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");
  // Seven source lanes, four bridge units per lane. Negative authored overhang remains unchanged.
  const laneBasis = options.bridgeLaneBasis ?? 28;
  const imported = importBestdoriChart(text, {
    toSs: bestdoriChartToSs,
    laneBasis,
    audioOffset: options.audioOffset ?? 0,
    provenance: {
      provider: "bestdori",
      game: "garupa",
      region: options.region,
      songId: options.songId,
      difficulty: options.difficulty,
      sourceUrl,
      chartSha256,
    },
  });
  imported.project.meta.title = resolveLocalizedText(metadata.musicTitle, options.locale).text;
  imported.project.meta.artist = resolveLocalizedText(
    metadata.bandName ?? bands[String(metadata.bandId)]?.bandName,
    options.locale,
  ).text;
  imported.project.meta.difficulty = options.difficulty;
  imported.project.meta.level = String(difficulty.playLevel ?? "");
  let audio: File | undefined, audioRegion: BestdoriServer | undefined;
  if (options.withAudio !== false) {
    if (typeof metadata.musicUrl !== "string" || !metadata.musicUrl) throw new Error("bestdori_audio_missing");
    const url = new URL(metadata.musicUrl, base(options));
    const scope = base(options);
    if (
      url.origin !== scope.origin ||
      !url.pathname.startsWith(scope.pathname) ||
      !/^\/api\/v1\/garupa\/bestdori\/(jp|en|tw|cn|kr)\/media\/sound\/\d+$/.test(url.pathname)
    )
      throw new Error("bestdori_audio_url_mismatch");
    const result = await read(options, url.href, AUDIO_LIMITS.bytes);
    const header = result.response.headers.get("x-bestdori-source-server"),
      region = header ?? url.pathname.split("/")[5];
    if (isBestdoriServer(region)) audioRegion = region;
    audio = new File([result.bytes], `bestdori-${options.songId}.mp3`, {
      type: result.response.headers.get("content-type")?.split(";")[0] ?? "audio/mpeg",
    });
  }
  options.signal.throwIfAborted();
  const identity: BestdoriCreatorIdentity = {
    provider: "bestdori",
    game: "garupa",
    requestedRegion: options.region,
    ...(audioRegion ? { audioRegion } : {}),
    catalogEtag: metadataRead.response.headers.get("etag"),
    chartEtag: chartRead.response.headers.get("etag"),
    chartSha256,
  };
  return {
    provider: "bestdori" as const,
    identity,
    metadata,
    project: imported.project,
    warnings: imported.warnings,
    audio,
    source: { name: `bestdori-${options.songId}-${options.difficulty}.json`, text, sha256: chartSha256 },
  };
}
