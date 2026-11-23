export type JsonPrimitive = boolean | null | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
export type JsonObject = { [key: string]: JsonValue };

export interface ChartRevision {
  id: string;
}

export interface ChartQuery {
  artists?: readonly string[];
  categories?: readonly string[];
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

export interface SonolusPlaylistItem extends JsonObject {
  author: string;
  levels: SonolusLevelItem[];
  name: string;
  subtitle: string;
  title: string;
}

export interface ChartDescriptor {
  artists: string;
  artistFilters?: ChartFilterValue[];
  author?: string;
  background?: JsonObject;
  bgmUrl?: string;
  coverUrl?: string;
  previewUrl?: string;
  categories?: ChartFilterValue[];
  tags?: JsonValue[];
  dataId: string;
  description?: string;
  difficulty: string;
  levelDataParameters?: Readonly<Record<string, number>>;
  name: string;
  publishedAt: number;
  rating: number;
  songDescription?: string;
  songId: string;
  searchKeywords?: string[];
  title: string;
}

export interface ChartFilterValue {
  name: string;
  title: string;
}

export interface ChartRecord extends ChartDescriptor {
  item: SonolusLevelItem;
}

export interface ChartCatalogSnapshot {
  aliases?: ChartDescriptor[];
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
  categoryTitle?: (category: string) => string;
  chartDataId?: (songId: string, difficulty: string, rawDifficulty: Readonly<Record<string, unknown>>) => string | null;
  levelName?: (songId: string, difficulty: string) => string;
  levelDataParameters?: (
    song: Readonly<Record<string, unknown>>,
    difficulty: Readonly<Record<string, unknown>>,
  ) => Readonly<Record<string, number>>;
  localeOrder?: readonly CatalogLocale[];
  mediaBaseUrl?: string;
  songBackground?: (song: Readonly<Record<string, unknown>>, songId: string, title: string, coverUrl?: string) => JsonObject | undefined;
  encodeText?: (labels: Readonly<Record<string, string>>, fallbackLocale: string) => string;
}

export type CatalogLocale = "en" | "ja" | "ko" | "zh-CN" | "zh-TW";

export interface CatalogProjectionResult {
  charts: ChartDescriptor[];
  invalidChartNames: string[];
}

export interface LevelInfoOptions {
  itemCount?: number;
  quickSearchValues?: string;
  randomCharts?: readonly ChartRecord[];
  randomSectionTitle?: string;
  searches?: readonly JsonObject[];
  sectionTitle?: string;
  title?: string;
}

export interface LevelDetailsOptions {
  quickSearchValues?: string;
  recommendationCount?: number;
  sectionTitle?: string;
  template?: JsonObject | null;
}
