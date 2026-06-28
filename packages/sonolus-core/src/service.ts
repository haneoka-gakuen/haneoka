import { RevisionCache } from "./repository.js";
import {
  projectLevelDetails,
  projectLevelInfo,
  projectLevelItem,
  projectLevelList,
  projectRandomLevelInfo,
  projectRandomLevelList,
} from "./projection.js";
import type {
  ChartCatalogProvider,
  ChartDataProvider,
  ChartDescriptor,
  ChartRecord,
  JsonObject,
  LevelTemplate,
  LevelTemplateProvider,
} from "./types.js";

const LEVEL_PAGE_SIZE = 20;
const DEFAULT_PREPARE_CONCURRENCY = 4;
const MAX_PREPARE_CONCURRENCY = 16;
const SHA1_PATTERN = /^[a-f0-9]{40}$/u;
const LEVEL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,254}$/u;

interface SonolusLevelSnapshot {
  byName: ReadonlyMap<string, ChartDescriptor>;
  charts: readonly ChartDescriptor[];
  dataProvider: ChartDataProvider;
  template: LevelTemplate;
}

export interface SonolusLevelRouteOptions {
  catalogProvider: ChartCatalogProvider;
  dataProvider: ChartDataProvider;
  levelTemplateProvider: LevelTemplateProvider;
  pathname: string;
  preparationConcurrency?: number;
  randomIndex?: (length: number) => number;
  revision: string;
  searchParams: URLSearchParams;
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
  return {
    byName,
    charts: Object.freeze([...catalog.charts]),
    dataProvider: options.dataProvider,
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

async function prepareRandomChart(
  snapshot: SonolusLevelSnapshot,
  options: SonolusLevelRouteOptions,
): Promise<ChartRecord | null> {
  const preferred = snapshot.charts.filter((chart) => chart.difficulty === "hard" || chart.difficulty === "expert");
  const pool = preferred.length ? preferred : snapshot.charts;
  if (!pool.length) return null;
  const requestedIndex = options.randomIndex
    ? options.randomIndex(pool.length)
    : Math.floor(Math.random() * pool.length);
  if (!Number.isSafeInteger(requestedIndex) || requestedIndex < 0) {
    throw new Error("Sonolus random index is invalid");
  }
  const start = requestedIndex % pool.length;
  for (let offset = 0; offset < pool.length; offset += 1) {
    const chart = pool[(start + offset) % pool.length];
    if (!chart) continue;
    const [prepared] = await prepareSnapshotCharts(snapshot, [chart], options);
    if (prepared) return prepared;
  }
  return null;
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

function decodeLevelName(encodedName: string | undefined): string | null {
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
    const isInfo = options.pathname === "/sonolus/levels/info";
    const isList = options.pathname === "/sonolus/levels/list";
    const detailMatch = /^\/sonolus\/levels\/([^/]+)$/u.exec(options.pathname);
    const dataMatch = /^\/sonolus\/levels\/([^/]+)\/data\/([a-f0-9]{40})$/u.exec(options.pathname);
    if (!isInfo && !isList && !detailMatch && !dataMatch) return null;

    const snapshot = await this.#snapshotCache.getOrCreate(options.revision, () => loadSnapshot(options));
    if (dataMatch) {
      const name = decodeLevelName(dataMatch[1]);
      const hash = dataMatch[2];
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
    if (random && (isInfo || isList)) {
      const chart = await prepareRandomChart(snapshot, options);
      if (!chart) return notFound();
      return document(200, isInfo ? projectRandomLevelInfo(chart) : projectRandomLevelList(chart), "no-store");
    }
    if (isInfo) {
      const charts = await prepareSnapshotCharts(snapshot, snapshot.charts.slice(0, 5), options);
      return document(200, projectLevelInfo(charts), "public, max-age=600, stale-while-revalidate=86400");
    }
    if (isList) {
      const pageIndex = parsedPage(options.searchParams.get("page"));
      const start = pageIndex * LEVEL_PAGE_SIZE;
      const charts = await prepareSnapshotCharts(
        snapshot,
        snapshot.charts.slice(start, start + LEVEL_PAGE_SIZE),
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
      return document(200, projectLevelList(page), "public, max-age=600, stale-while-revalidate=86400");
    }

    const name = decodeLevelName(detailMatch?.[1]);
    if (!name) return notFound();
    const descriptor = snapshot.byName.get(name);
    if (!descriptor) return notFound();
    const prepared = await prepareSnapshotCharts(
      snapshot,
      [descriptor, ...descriptorRecommendations(descriptor, snapshot.charts, 5)],
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
