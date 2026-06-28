export type JsonPrimitive = boolean | null | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
export type JsonObject = { [key: string]: JsonValue };

export interface ChartRevision {
  id: string;
}

export interface ChartQuery {
  difficulties?: readonly string[];
  maxRating?: number;
  minRating?: number;
  page?: number;
  pageSize?: number;
  revision?: string;
  search?: string;
}

export interface ChartPage<T> {
  items: T[];
  page: number;
  pageCount: number;
  pageSize: number;
  revision: ChartRevision;
  total: number;
}

export interface SonolusLevelItem extends JsonObject {
  artists: string;
  author: string;
  name: string;
  rating: number;
  title: string;
}

export interface ChartDescriptor {
  artists: string;
  bgmUrl?: string;
  coverUrl?: string;
  dataId: string;
  difficulty: string;
  name: string;
  rating: number;
  songId: string;
  title: string;
}

export interface ChartRecord extends ChartDescriptor {
  item: SonolusLevelItem;
}

export interface ChartCatalogSnapshot {
  charts: ChartDescriptor[];
  revision: ChartRevision;
}

export interface ChartCatalogProvider {
  load(): Promise<ChartCatalogSnapshot>;
}

export interface LevelTemplate {
  details?: JsonObject;
  item: SonolusLevelItem;
}

export interface LevelTemplateProvider {
  load(): Promise<LevelTemplate>;
}

export interface PreparedChartData {
  hash: string;
  resource: JsonObject;
}

export interface ChartDataPayload {
  body: ArrayBuffer;
  cacheControl?: string;
  contentType?: string;
  etag?: string;
}

export interface ChartDataProvider {
  load(chart: ChartDescriptor, expectedHash: string): Promise<ChartDataPayload | null>;
  prepare(chart: ChartDescriptor): Promise<PreparedChartData | null>;
}

export interface ChartRepository<T extends ChartRecord = ChartRecord> {
  find(name: string, revision?: string): Promise<T | null>;
  getRevision(): Promise<ChartRevision>;
  query(query?: ChartQuery): Promise<ChartPage<T>>;
}

export interface CatalogProjectionOptions {
  chartDataId?: (songId: string, difficulty: string, rawDifficulty: Readonly<Record<string, unknown>>) => string | null;
  levelName?: (songId: string, difficulty: string) => string;
  localeOrder?: readonly CatalogLocale[];
  mediaBaseUrl?: string;
}

export type CatalogLocale = "en" | "ja" | "ko" | "zh-CN" | "zh-TW";

export interface CatalogProjectionResult {
  charts: ChartDescriptor[];
  invalidChartNames: string[];
}

export interface LevelInfoOptions {
  itemCount?: number;
  sectionTitle?: string;
}

export interface LevelDetailsOptions {
  recommendationCount?: number;
  sectionTitle?: string;
  template?: JsonObject | null;
}
