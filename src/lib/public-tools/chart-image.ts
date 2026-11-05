// L3 — GEB
// Input: server、歌曲、难度、release 与图片高度。
// Output: 与网页共用原生皮肤、画布及排版的 PNG Blob。
// Pos: [Map](../L2-2.md)；公开浏览器谱面导出。
// Effects/Dependencies: 获取固定 release 的谱面、原生图集和五语标签；释放皮肤与 Blob URL。
import { siteOrigin } from "../site-origin";
import { createHaneokaClient, type HaneokaLocale, type HaneokaReleaseIdentity } from "../../../packages/api-client/src/haneoka";
import { ApiClientError } from "../../../packages/api-client/src/index";
import { buildChart, parseScore } from "@haneoka/cassiopeia-plugin-our-notes";
import { chartCanvasOverviewPresentation } from "@haneoka/cassiopeia-ui-vue/overview";
import { loadOurNotesCreationCanvasSkin } from "../chart-creation/native-canvas-skin";
import { createPinnedPublicFetcher, pinnedPublicUrl } from "../chart-creation/public-songs";
import { readBytes } from "../../../packages/embed-core/src/io";
import { resolveLocalizedText } from "../localized-text";
import { drawDetailedChartOverview, loadChartCanvasFonts } from "../../lit/runtime/chart-overview-renderer";
import { completeChartOverviewMeta, composeChartOverviewImage, chartImageFileName } from "../../lit/runtime/chart-image-export";
import { createChartOverviewMeta } from "./chart-meta";

import { CHART_IMAGE_RENDERER_VERSION } from "./chart-contract";
export const CHART_IMAGE_RENDERER = CHART_IMAGE_RENDERER_VERSION;
export interface NativeChartImageOptions {
  songId: string;
  difficulty: "easy" | "normal" | "hard" | "expert" | "special" | "master";
  server?: "jp" | "intl";
  release?: string;
  locale?: HaneokaLocale;
  height?: number;
  timeZone?: string;
  apiBase?: string;
  signal?: AbortSignal;
}
type Row = Record<string, unknown>;
const row = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};

export async function renderChartImage(options: NativeChartImageOptions) {
  const server = options.server ?? "intl", locale = options.locale ?? "en", height = options.height ?? 720;
  if (!Number.isInteger(height) || height < 360 || height > 1440) throw new RangeError("height must be between 360 and 1440");
  if (server !== "jp" && server !== "intl") throw new TypeError("server must be jp or intl");
  if (options.timeZone !== undefined) new Intl.DateTimeFormat("en", { timeZone: options.timeZone });
  const apiBase = new URL(options.apiBase ?? `${siteOrigin()}/api/v1/`);
  apiBase.pathname = apiBase.pathname.replace(/\/?$/u, "/");
  const signal = options.signal ?? new AbortController().signal;
  const identityUrl = new URL(`servers/${server}/release?projection=identity`, apiBase);
  if (options.release) identityUrl.searchParams.set("release", options.release);
  const identityResponse = await fetch(identityUrl, { signal, credentials: "omit" });
  if (!identityResponse.ok) throw new Error(`release-http:${identityResponse.status}`);
  const identity = await identityResponse.json() as HaneokaReleaseIdentity;
  const client = createHaneokaClient({ baseUrl: apiBase.href });
  const scope = { server, locale, release: identity.releaseId, signal };
  const optionalEntity = async (resource: string, id: string) => {
    try { return await client.entity<Row>(resource, id, { ...scope, decode: row }); }
    catch (error) { if (error instanceof ApiClientError && error.status === 404) return {}; throw error; }
  };
  const song = await client.entity<Row>("songs", options.songId, { ...scope, decode: row });
  const difficulty = (Array.isArray(song.difficulty) ? song.difficulty : []).map(row).find(d => d.difficultyName === options.difficulty);
  if (!difficulty || typeof difficulty.file !== "string") throw new Error("difficulty_not_found");
  const pinned = createPinnedPublicFetcher(identity, { apiBase: apiBase.href });
  const response = await pinned(new Request(pinnedPublicUrl(difficulty.file, identity, { apiBase: apiBase.href }), { signal }));
  if (!response.ok) throw new Error(`chart-http:${response.status}`);
  const bytes = await readBytes(response, { signal, maxBytes: 2 * 1024 * 1024, locale, fetcher: fetch, progress: () => {} });
  const chart = buildChart(parseScore(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  const presentation = chartCanvasOverviewPresentation();
  const panels = Math.max(1, Math.ceil(chart.durationMs / ((height / presentation.heightPerSecond) * 1000)));
  if (chart.notes.length > 25000 || panels * presentation.laneWidth * 13 * height > 12_000_000) throw new RangeError("chart_render_budget");
  const [band, marks, translations, songMeta] = await Promise.all([
    Number(song.bandId) > 0 ? optionalEntity("bands", String(song.bandId)) : Promise.resolve({} as Row),
    fetch(new URL(`servers/${server}/ui-marks?release=${identity.releaseId}&projection=2`, apiBase), { signal }).then(async r => {
      if (r.status === 404) return {};
      if (!r.ok) throw new Error(`marks-http:${r.status}`);
      return row(await r.json());
    }),
    fetch(new URL(`/i18n/${locale}.json`, apiBase), { signal }).then(async r => {
      if (!r.ok) throw new Error(`locale-http:${r.status}`);
      return row(await r.json());
    }),
    optionalEntity("song-meta", options.songId),
  ]);
  const skin = await loadOurNotesCreationCanvasSkin(identity, { apiBase: apiBase.href, signal, locale });
  try {
    signal.throwIfAborted();
    const label = (key: string) => {
      const path = key.startsWith("note") ? ["media", "chartPlayer", key]
        : ["composer", "lyricist", "arranger"].includes(key) ? ["catalog", "songs", "fields", key]
        : key === "time" ? ["common", "fields", key]
        : key === "release" ? ["catalog", "fields", key] : ["catalog", "analysis", "fields", key];
      const value = path.reduce<unknown>((v, k) => row(v)[k], translations);
      if (typeof value !== "string") throw new Error(`label_missing:${key}`);
      return value;
    };
    const localized = (value: unknown) => resolveLocalizedText(value, locale).text;
    const mark = marks[`sp_icon_live_music_type_${song.musicType}.png`];
    const publishedAt = (Array.isArray(song.publishedAt) ? song.publishedAt : [song.publishedAt]).find(value => Number(value) > 0);
    const publishedText = publishedAt ? new Intl.DateTimeFormat(locale, { ...(options.timeZone ? { timeZone: options.timeZone } : {}), year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(Number(publishedAt))) : "";
    const meta = createChartOverviewMeta({ song, difficulty, chartMeta: row(row(songMeta[String(difficulty.difficulty)]).chart), locale, label, localized,
      bandName: localized(band.bandName), publishedAt: publishedText,
      bandIcon: typeof band.icon === "string" ? pinnedPublicUrl(band.icon, identity, { apiBase: apiBase.href }) : undefined,
      attributeIcon: typeof mark === "string" ? pinnedPublicUrl(`/runtime/${server}/${mark.replace(/^runtime\//u, "")}`, identity, { apiBase: apiBase.href }) : undefined,
      jacket: typeof song.jacketUrl === "string" ? pinnedPublicUrl(song.jacketUrl, identity, { apiBase: apiBase.href }) : undefined,
    });
    const canvas = document.createElement("canvas");
    const fontFamily = await loadChartCanvasFonts(locale);
    drawDetailedChartOverview(canvas, chart, skin.skin, height, undefined, undefined, fontFamily);
    const completed = completeChartOverviewMeta(meta, chart, label);
    const blob = await composeChartOverviewImage(canvas, completed);
    if (!blob) throw new Error("chart_image_failed");
    const image = await createImageBitmap(blob);
    const dimensions = { width: image.width, height: image.height };
    image.close();
    return { blob, ...dimensions, identity, renderer: CHART_IMAGE_RENDERER, fileName: chartImageFileName(completed) };
  } finally {
    await skin.dispose();
  }
}
