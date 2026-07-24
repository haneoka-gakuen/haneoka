import { RevisionCache } from "./repository.js";
import {
  projectLevelDetails,
  projectLevelInfo,
  projectLevelItem,
  projectLevelList,
  projectPlaylistDetails,
  projectPlaylistInfo,
  projectPlaylistItem,
  projectPlaylistList,
  projectRandomLevelInfo,
  projectRandomLevelList,
  projectServerInfo,
} from "./projection.js";
import type {
  ChartCatalogProvider,
  ChartDataProvider,
  ChartDescriptor,
  ChartRecord,
  JsonObject,
  LevelTemplate,
  LevelTemplateProvider,
  SonolusPlaylistItem,
} from "./types.js";

const FEATURED_ITEM_COUNT = 5;
const LEVEL_PAGE_SIZE = 20;
const DEFAULT_PREPARE_CONCURRENCY = 4;
const MAX_PREPARE_CONCURRENCY = 16;
const SHA1_PATTERN = /^[a-f0-9]{40}$/u;
const LEVEL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,254}$/u;
const DIFFICULTY_ORDER: Readonly<Record<string, number>> = Object.freeze({
  master: 0,
  special: 1,
  expert: 2,
  hard: 3,
  normal: 4,
  easy: 5,
});
const RANDOM_DIFFICULTIES = new Set(["hard", "expert", "special", "master"]);

interface PlaylistDescriptor {
  artists: string;
  charts: readonly ChartDescriptor[];
  name: string;
  publishedAt: number;
  songId: string;
  title: string;
}

interface PlaylistRecord extends PlaylistDescriptor {
  item: SonolusPlaylistItem;
}

interface SonolusLevelSnapshot {
  byName: ReadonlyMap<string, ChartDescriptor>;
  byPlaylistName: ReadonlyMap<string, PlaylistDescriptor>;
  charts: readonly ChartDescriptor[];
  dataProvider: ChartDataProvider;
  latestCharts: readonly ChartDescriptor[];
  latestPlaylists: readonly PlaylistDescriptor[];
  playlists: readonly PlaylistDescriptor[];
  template: LevelTemplate;
}

export interface SonolusLevelRouteOptions {
  catalogProvider: ChartCatalogProvider;
  dataProvider: ChartDataProvider;
  levelInfoTitle?: string;
  levelTemplateProvider: LevelTemplateProvider;
  pathname: string;
  playlistInfoTitle?: string;
  playlistName?: (songId: string) => string;
  preparationConcurrency?: number;
  quickSearchValues?: string;
  randomIndex?: (length: number) => number;
  revision: string;
  searchParams: URLSearchParams;
  serverBanner?: JsonObject;
  sonolusBaseUrl?: string;
}

export interface SonolusLevelDocumentRouteResult {
  body: JsonObject;
  cacheControl: string;
  contentType: "application/json; charset=utf-8";
  kind: "document";
  status: 200 | 404;
}

export interface SonolusLevelDataRouteResult {
  body: ArrayBuffer;
  cacheControl: string;
  contentType: string;
  etag?: string;
  kind: "data";
  status: 200;
}

export type SonolusLevelRouteResult = SonolusLevelDocumentRouteResult | SonolusLevelDataRouteResult;

function levelDataUrl(name: string, hash: string, baseUrl: string | undefined): string {
  const pathname = `/sonolus/levels/${encodeURIComponent(name)}/data/${hash}`;
  if (!baseUrl) return pathname;
  return new URL(pathname, baseUrl).toString();
}

function preparationConcurrency(value: number | undefined): number {
  if (value === undefined) return DEFAULT_PREPARE_CONCURRENCY;
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError("Preparation concurrency must be positive");
  return Math.min(MAX_PREPARE_CONCURRENCY, value);
}

async function prepareCharts(
  descriptors: readonly ChartDescriptor[],
  template: LevelTemplate,
  dataProvider: ChartDataProvider,
  sonolusBaseUrl: string | undefined,
  concurrency: number,
): Promise<ChartRecord[]> {
  const records: Array<ChartRecord | null> = Array.from({ length: descriptors.length }, () => null);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < descriptors.length) {
      const index = cursor;
      cursor += 1;
      const descriptor = descriptors[index];
      if (!descriptor) continue;
      const prepared = await dataProvider.prepare(descriptor);
      if (!prepared) continue;
      if (!SHA1_PATTERN.test(prepared.hash)) {
        throw new Error(`Chart data provider returned an invalid SHA-1 hash: ${descriptor.name}`);
      }
      const data = {
        ...prepared.resource,
        hash: prepared.hash,
        url: levelDataUrl(descriptor.name, prepared.hash, sonolusBaseUrl),
      };
      records[index] = {
        ...descriptor,
        item: projectLevelItem(template.item, {
          ...descriptor,
          data,
          ...(sonolusBaseUrl ? { sonolusBaseUrl } : {}),
        }),
      };
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, descriptors.length) }, worker));
  return records.filter((record): record is ChartRecord => record !== null);
}

function difficultyOrder(difficulty: string): number {
  return DIFFICULTY_ORDER[difficulty.toLocaleLowerCase("en-US")] ?? Number.MAX_SAFE_INTEGER;
}

function featuredLevelForPlaylist(playlist: PlaylistDescriptor): ChartDescriptor | null {
  return playlist.charts[0] ?? null;
}

function randomLevelPool(playlists: readonly PlaylistDescriptor[]): ChartDescriptor[] {
  return playlists.flatMap((playlist) => {
    const chart = playlist.charts.find((candidate) =>
      RANDOM_DIFFICULTIES.has(candidate.difficulty.toLocaleLowerCase("en-US")),
    );
    return chart ? [chart] : [];
  });
}

function compareNewest(
  left: Pick<ChartDescriptor, "publishedAt" | "songId"> & { difficulty?: string },
  right: Pick<ChartDescriptor, "publishedAt" | "songId"> & { difficulty?: string },
): number {
  if (left.publishedAt !== right.publishedAt) return right.publishedAt - left.publishedAt;
  const songId = right.songId.localeCompare(left.songId, "en", { numeric: true });
  if (songId) return songId;
  return difficultyOrder(left.difficulty ?? "") - difficultyOrder(right.difficulty ?? "");
}

function groupedPlaylists(
  charts: readonly ChartDescriptor[],
  playlistName: ((songId: string) => string) | undefined,
): PlaylistDescriptor[] {
  const groups = new Map<string, ChartDescriptor[]>();
  for (const chart of charts) {
    const group = groups.get(chart.songId);
    if (group) group.push(chart);
    else groups.set(chart.songId, [chart]);
  }
  return [...groups.entries()].map(([songId, grouped]) => {
    const first = grouped[0];
    if (!first) throw new Error(`Sonolus playlist is missing its first chart: ${songId}`);
    const name = playlistName ? playlistName(songId) : `playlist-${songId}`;
    if (!LEVEL_NAME_PATTERN.test(name)) throw new Error(`Invalid Sonolus playlist name: ${name}`);
    const orderedCharts = [...grouped].sort(
      (left, right) => difficultyOrder(left.difficulty) - difficultyOrder(right.difficulty),
    );
    return {
      artists: first.artists,
      charts: Object.freeze(orderedCharts),
      name,
      publishedAt: Math.max(...grouped.map((chart) => chart.publishedAt)),
      songId,
      title: first.title,
    };
  });
}

async function loadSnapshot(options: SonolusLevelRouteOptions): Promise<SonolusLevelSnapshot> {
  const [catalog, template] = await Promise.all([options.catalogProvider.load(), options.levelTemplateProvider.load()]);
  if (catalog.revision.id !== options.revision) {
    throw new Error(`Chart catalog revision mismatch: expected ${options.revision}, received ${catalog.revision.id}`);
  }
  const byName = new Map<string, ChartDescriptor>();
  for (const chart of catalog.charts) {
    if (!chart.name || byName.has(chart.name)) throw new Error(`Duplicate Sonolus chart name: ${chart.name}`);
    byName.set(chart.name, chart);
  }
  const charts = Object.freeze([...catalog.charts]);
  const playlists = Object.freeze(groupedPlaylists(charts, options.playlistName));
  const byPlaylistName = new Map<string, PlaylistDescriptor>();
  for (const playlist of playlists) {
    if (byPlaylistName.has(playlist.name)) throw new Error(`Duplicate Sonolus playlist name: ${playlist.name}`);
    byPlaylistName.set(playlist.name, playlist);
  }
  return {
    byName,
    byPlaylistName,
    charts,
    dataProvider: options.dataProvider,
    latestCharts: Object.freeze([...charts].sort(compareNewest)),
    latestPlaylists: Object.freeze([...playlists].sort(compareNewest)),
    playlists,
    template,
  };
}

function descriptorRecommendations(
  chart: ChartDescriptor,
  charts: readonly ChartDescriptor[],
  count: number,
): ChartDescriptor[] {
  if (charts.length < 2 || count < 1) return [];
  const index = Math.max(
    0,
    charts.findIndex((candidate) => candidate.name === chart.name),
  );
  const result: ChartDescriptor[] = [];
  for (let offset = 1; offset < charts.length && result.length < count; offset += 1) {
    const candidate = charts[(index + offset) % charts.length];
    if (candidate && candidate.name !== chart.name) result.push(candidate);
  }
  return result;
}

async function prepareSnapshotCharts(
  snapshot: SonolusLevelSnapshot,
  charts: readonly ChartDescriptor[],
  options: SonolusLevelRouteOptions,
): Promise<ChartRecord[]> {
  return prepareCharts(
    charts,
    snapshot.template,
    snapshot.dataProvider,
    options.sonolusBaseUrl,
    preparationConcurrency(options.preparationConcurrency),
  );
}

function randomDescriptors<T>(
  descriptors: readonly T[],
  count: number,
  randomIndex: SonolusLevelRouteOptions["randomIndex"],
): T[] {
  const remaining = [...descriptors];
  const selected: T[] = [];
  while (remaining.length && selected.length < count) {
    const requestedIndex = randomIndex ? randomIndex(remaining.length) : Math.floor(Math.random() * remaining.length);
    if (!Number.isSafeInteger(requestedIndex) || requestedIndex < 0) {
      throw new Error("Sonolus random index is invalid");
    }
    const [selectedDescriptor] = remaining.splice(requestedIndex % remaining.length, 1);
    if (selectedDescriptor !== undefined) selected.push(selectedDescriptor);
  }
  return selected;
}

function uniqueCharts(charts: readonly ChartDescriptor[]): ChartDescriptor[] {
  const result: ChartDescriptor[] = [];
  const names = new Set<string>();
  for (const chart of charts) {
    if (names.has(chart.name)) continue;
    names.add(chart.name);
    result.push(chart);
  }
  return result;
}

function recordsFor(descriptors: readonly ChartDescriptor[], records: readonly ChartRecord[]): ChartRecord[] {
  const byName = new Map(records.map((record) => [record.name, record]));
  return descriptors.flatMap((descriptor) => {
    const record = byName.get(descriptor.name);
    return record ? [record] : [];
  });
}

async function preparePlaylistRecords(
  snapshot: SonolusLevelSnapshot,
  descriptors: readonly PlaylistDescriptor[],
  options: SonolusLevelRouteOptions,
): Promise<PlaylistRecord[]> {
  const charts = uniqueCharts(descriptors.flatMap((descriptor) => descriptor.charts));
  const prepared = await prepareSnapshotCharts(snapshot, charts, options);
  const byName = new Map(prepared.map((record) => [record.name, record]));
  return descriptors.flatMap((descriptor) => {
    const levels = descriptor.charts.flatMap((chart) => {
      const record = byName.get(chart.name);
      return record ? [record] : [];
    });
    return levels.length ? [{ ...descriptor, item: projectPlaylistItem(descriptor, levels) }] : [];
  });
}

function parsedPage(value: string | null): number {
  const page = Number(value ?? 0);
  return Number.isSafeInteger(page) && page >= 0 ? page : 0;
}

function document(status: 200 | 404, body: JsonObject, cacheControl: string): SonolusLevelDocumentRouteResult {
  return {
    body,
    cacheControl,
    contentType: "application/json; charset=utf-8",
    kind: "document",
    status,
  };
}

function notFound(): SonolusLevelDocumentRouteResult {
  return document(404, { message: "Not found" }, "no-store");
}

function decodeName(encodedName: string | undefined): string | null {
  if (!encodedName) return null;
  try {
    const name = decodeURIComponent(encodedName);
    return LEVEL_NAME_PATTERN.test(name) ? name : null;
  } catch {
    return null;
  }
}

export class SonolusLevelService {
  readonly #snapshotCache: RevisionCache<SonolusLevelSnapshot>;

  constructor(revisionCacheSize = 3) {
    this.#snapshotCache = new RevisionCache(revisionCacheSize);
  }

  clear(): void {
    this.#snapshotCache.clear();
  }

  async handle(options: SonolusLevelRouteOptions): Promise<SonolusLevelRouteResult | null> {
    const isServerInfo = options.pathname === "/sonolus/info";
    const isLevelInfo = options.pathname === "/sonolus/levels/info";
    const isLevelList = options.pathname === "/sonolus/levels/list";
    const levelDetailMatch = /^\/sonolus\/levels\/([^/]+)$/u.exec(options.pathname);
    const levelDataMatch = /^\/sonolus\/levels\/([^/]+)\/data\/([a-f0-9]{40})$/u.exec(options.pathname);
    const isPlaylistInfo = options.pathname === "/sonolus/playlists/info";
    const isPlaylistList = options.pathname === "/sonolus/playlists/list";
    const playlistDetailMatch = /^\/sonolus\/playlists\/([^/]+)$/u.exec(options.pathname);
    if (
      !isServerInfo &&
      !isLevelInfo &&
      !isLevelList &&
      !levelDetailMatch &&
      !levelDataMatch &&
      !isPlaylistInfo &&
      !isPlaylistList &&
      !playlistDetailMatch
    ) {
      return null;
    }

    if (isServerInfo) {
      return document(
        200,
        projectServerInfo(options.serverBanner ? { banner: options.serverBanner } : {}),
        "public, max-age=600, stale-while-revalidate=86400",
      );
    }

    const snapshot = await this.#snapshotCache.getOrCreate(options.revision, () => loadSnapshot(options));
    if (levelDataMatch) {
      const name = decodeName(levelDataMatch[1]);
      const hash = levelDataMatch[2];
      if (!name || !hash) return notFound();
      const descriptor = snapshot.byName.get(name);
      if (!descriptor) return notFound();
      const [chart] = await prepareSnapshotCharts(snapshot, [descriptor], options);
      if (!chart) return notFound();
      const resource = chart.item.data;
      if (typeof resource !== "object" || resource === null || Array.isArray(resource) || resource.hash !== hash) {
        return notFound();
      }
      const payload = await snapshot.dataProvider.load(chart, hash);
      if (!payload) return notFound();
      return {
        body: payload.body,
        cacheControl: payload.cacheControl ?? "public, max-age=31536000, immutable",
        contentType: payload.contentType ?? "application/gzip",
        ...(payload.etag ? { etag: payload.etag } : {}),
        kind: "data",
        status: 200,
      };
    }

    const random = options.searchParams.get("type") === "random";
    if (random && (isLevelInfo || isLevelList)) {
      const [descriptor] = randomDescriptors(randomLevelPool(snapshot.playlists), 1, options.randomIndex);
      if (!descriptor) return notFound();
      const [chart] = await prepareSnapshotCharts(snapshot, [descriptor], options);
      if (!chart) return notFound();
      return document(200, isLevelInfo ? projectRandomLevelInfo(chart) : projectRandomLevelList(chart), "no-store");
    }

    if (isLevelInfo) {
      const randomCharts = randomDescriptors(
        randomLevelPool(snapshot.playlists),
        FEATURED_ITEM_COUNT,
        options.randomIndex,
      );
      const newestCharts = snapshot.latestPlaylists.slice(0, FEATURED_ITEM_COUNT).flatMap((playlist) => {
        const chart = featuredLevelForPlaylist(playlist);
        return chart ? [chart] : [];
      });
      const prepared = await prepareSnapshotCharts(snapshot, uniqueCharts([...randomCharts, ...newestCharts]), options);
      return document(
        200,
        projectLevelInfo(recordsFor(newestCharts, prepared), {
          randomCharts: recordsFor(randomCharts, prepared),
          ...(options.levelInfoTitle ? { title: options.levelInfoTitle } : {}),
          ...(options.quickSearchValues ? { quickSearchValues: options.quickSearchValues } : {}),
        }),
        "no-store",
      );
    }
    if (isLevelList) {
      const pageIndex = parsedPage(options.searchParams.get("page"));
      const start = pageIndex * LEVEL_PAGE_SIZE;
      const charts = await prepareSnapshotCharts(
        snapshot,
        snapshot.latestCharts.slice(start, start + LEVEL_PAGE_SIZE),
        options,
      );
      const page = {
        items: charts,
        page: pageIndex,
        pageCount: Math.ceil(snapshot.charts.length / LEVEL_PAGE_SIZE),
        pageSize: LEVEL_PAGE_SIZE,
        revision: { id: options.revision },
        total: snapshot.charts.length,
      };
      return document(
        200,
        projectLevelList(page, {
          ...(options.levelInfoTitle ? { title: options.levelInfoTitle } : {}),
          ...(options.quickSearchValues ? { quickSearchValues: options.quickSearchValues } : {}),
        }),
        "public, max-age=600, stale-while-revalidate=86400",
      );
    }
    if (isPlaylistInfo) {
      const randomPlaylists = randomDescriptors(snapshot.playlists, FEATURED_ITEM_COUNT, options.randomIndex);
      const newestPlaylists = snapshot.latestPlaylists.slice(0, FEATURED_ITEM_COUNT);
      const prepared = await preparePlaylistRecords(
        snapshot,
        [...new Map([...randomPlaylists, ...newestPlaylists].map((playlist) => [playlist.name, playlist])).values()],
        options,
      );
      const byName = new Map(prepared.map((playlist) => [playlist.name, playlist.item]));
      const itemsFor = (playlists: readonly PlaylistDescriptor[]): SonolusPlaylistItem[] =>
        playlists.flatMap((playlist) => {
          const item = byName.get(playlist.name);
          return item ? [item] : [];
        });
      return document(
        200,
        projectPlaylistInfo(itemsFor(newestPlaylists), itemsFor(randomPlaylists), FEATURED_ITEM_COUNT, {
          ...(options.playlistInfoTitle ? { title: options.playlistInfoTitle } : {}),
          ...(options.quickSearchValues ? { quickSearchValues: options.quickSearchValues } : {}),
        }),
        "no-store",
      );
    }
    if (isPlaylistList) {
      const pageIndex = parsedPage(options.searchParams.get("page"));
      const start = pageIndex * LEVEL_PAGE_SIZE;
      const playlists = await preparePlaylistRecords(
        snapshot,
        snapshot.latestPlaylists.slice(start, start + LEVEL_PAGE_SIZE),
        options,
      );
      return document(
        200,
        projectPlaylistList(
          playlists.map((playlist) => playlist.item),
          Math.ceil(snapshot.playlists.length / LEVEL_PAGE_SIZE),
          {
            ...(options.playlistInfoTitle ? { title: options.playlistInfoTitle } : {}),
            ...(options.quickSearchValues ? { quickSearchValues: options.quickSearchValues } : {}),
          },
        ),
        "public, max-age=600, stale-while-revalidate=86400",
      );
    }
    if (playlistDetailMatch) {
      const name = decodeName(playlistDetailMatch[1]);
      if (!name) return notFound();
      const descriptor = snapshot.byPlaylistName.get(name);
      if (!descriptor) return notFound();
      const [playlist] = await preparePlaylistRecords(snapshot, [descriptor], options);
      return playlist
        ? document(200, projectPlaylistDetails(playlist.item), "public, max-age=600, stale-while-revalidate=86400")
        : notFound();
    }

    const name = decodeName(levelDetailMatch?.[1]);
    if (!name) return notFound();
    const descriptor = snapshot.byName.get(name);
    if (!descriptor) return notFound();
    const prepared = await prepareSnapshotCharts(
      snapshot,
      [descriptor, ...descriptorRecommendations(descriptor, snapshot.charts, FEATURED_ITEM_COUNT)],
      options,
    );
    const chart = prepared.find((candidate) => candidate.name === name);
    return chart
      ? document(
          200,
          projectLevelDetails(chart, prepared, { template: snapshot.template.details ?? null }),
          "public, max-age=600, stale-while-revalidate=86400",
        )
      : notFound();
  }
}
