import {
  projectCatalogCharts,
  type CatalogLocale,
  type ChartCatalogProvider,
  type ChartCatalogSnapshot,
  type ChartDataPayload,
  type ChartDataProvider,
  type ChartDescriptor,
  type JsonObject,
  type LevelTemplate,
  type LevelTemplateProvider,
  type PreparedChartData,
  type SonolusLevelItem,
} from "@haneoka/sonolus-core";
import { chartToLevelData } from "../convert/chartToLevelData.js";
import { convertChartAsync } from "../convert/index.js";

const DEFAULT_MAX_CACHE_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_CHART_BYTES = 4 * 1024 * 1024;
const RELEASE_CHART_DATA_ID_PREFIX = "release:";
const RELEASE_ID_PATTERN = /^r-[a-f0-9]{20}$/u;
const RELEASE_SERVER_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/u;
const SONOLUS_NAME_PART_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/u;
const SHA1_PATTERN = /^[a-f0-9]{40}$/u;

export type ReleaseJsonReader = (releasePath: string) => Promise<unknown | null>;
export type ReleaseByteReader = (releasePath: string) => Promise<Uint8Array | null>;

/**
 * Identifies one immutable Our Notes release within a logical resource
 * server. `server` is the public release-server slug; `releaseId` is the
 * immutable snapshot selected by that server's current pointer.
 */
export interface ReleaseChartProvenance {
  readonly releaseId: string;
  readonly server: string;
}

/** A chart source path together with the immutable release that owns it. */
export interface ReleaseChartDataReference extends ReleaseChartProvenance {
  readonly path: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonObject(value: unknown): value is JsonObject {
  if (!isObject(value)) return false;
  return Object.values(value).every((entry) => {
    if (entry === null || typeof entry === "boolean" || typeof entry === "string") return true;
    if (typeof entry === "number") return Number.isFinite(entry);
    if (Array.isArray(entry)) return entry.every(isJsonValue);
    return isJsonObject(entry);
  });
}

function isJsonValue(value: unknown): boolean {
  if (value === null || typeof value === "boolean" || typeof value === "string") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isJsonObject(value);
}

function catalogIndexPath(manifest: unknown, resourceName: string): string {
  if (!isObject(manifest) || !isObject(manifest.resources)) {
    throw new Error("Catalog manifest is invalid");
  }
  const resource = manifest.resources[resourceName];
  const prefix = `api/v1/catalog/${resourceName}/`;
  if (
    !isObject(resource) ||
    typeof resource.index !== "string" ||
    !resource.index.startsWith(prefix) ||
    !resource.index.endsWith(".json") ||
    !/^[A-Za-z0-9._/-]+$/u.test(resource.index) ||
    resource.index.includes("\\") ||
    resource.index.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error(`Catalog index is missing: ${resourceName}`);
  }
  return resource.index;
}

function isEngineItem(value: unknown): value is JsonObject {
  return (
    isJsonObject(value) &&
    typeof value.name === "string" &&
    Boolean(value.name) &&
    typeof value.version === "number" &&
    Number.isSafeInteger(value.version) &&
    value.version > 0
  );
}

export function releaseAssetPath(publicPath: string, server: string): string | null {
  if (!RELEASE_SERVER_PATTERN.test(server)) return null;
  const prefix = `/assets/${server}/`;
  if (!publicPath.startsWith(prefix)) return null;
  const relative = publicPath.slice(prefix.length);
  if (
    !relative ||
    relative.startsWith("/") ||
    relative.includes("\\") ||
    relative.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    return null;
  }
  return `assets/${relative}`;
}

function isReleaseAssetPath(path: string): boolean {
  if (!path.startsWith("assets/") || path.length <= "assets/".length || path.includes("\\")) return false;
  return path
    .slice("assets/".length)
    .split("/")
    .every((part) => Boolean(part) && part !== "." && part !== "..");
}

function releaseChartProvenance(value: ReleaseChartProvenance): ReleaseChartProvenance {
  if (
    !isObject(value) ||
    typeof value.server !== "string" ||
    typeof value.releaseId !== "string" ||
    !RELEASE_SERVER_PATTERN.test(value.server) ||
    !RELEASE_ID_PATTERN.test(value.releaseId)
  ) {
    throw new TypeError("Release chart provenance is invalid");
  }
  return { releaseId: value.releaseId, server: value.server };
}

function sonolusNamePart(value: string | number, label: string): string {
  if (typeof value !== "string" && (typeof value !== "number" || !Number.isFinite(value))) {
    throw new TypeError(`Invalid Sonolus ${label}`);
  }
  const part = String(value).trim();
  if (!SONOLUS_NAME_PART_PATTERN.test(part)) throw new TypeError(`Invalid Sonolus ${label}`);
  return part;
}

/**
 * Returns a stable, collision-free level name for a chart in one logical
 * resource server. The immutable snapshot is carried by the chart data ID so
 * a pointer update can keep this public level URL stable.
 */
export function releaseChartLevelName(releaseServer: string, songId: string | number, difficulty: string): string {
  if (typeof releaseServer !== "string" || !RELEASE_SERVER_PATTERN.test(releaseServer)) {
    throw new TypeError("Invalid release server");
  }
  if (typeof difficulty !== "string") throw new TypeError("Invalid Sonolus difficulty");
  const normalizedSongId = sonolusNamePart(songId, "song ID");
  const normalizedDifficulty = sonolusNamePart(difficulty.toLocaleLowerCase("en-US"), "difficulty");
  // Length prefixes make the tuple unambiguous even when a valid segment
  // contains hyphens, while keeping the result inside Sonolus's name alphabet.
  const name = `release-level-${releaseServer.length}-${releaseServer}-${normalizedSongId.length}-${normalizedSongId}-${normalizedDifficulty.length}-${normalizedDifficulty}`;
  if (name.length > 255) throw new TypeError("Sonolus level name is too long");
  return name;
}

/** Encodes an immutable release and its release-relative chart source path. */
export function encodeReleaseChartDataId(provenance: ReleaseChartProvenance, path: string): string {
  const release = releaseChartProvenance(provenance);
  if (!isReleaseAssetPath(path)) throw new TypeError("Release chart data path is invalid");
  return `${RELEASE_CHART_DATA_ID_PREFIX}${release.server}:${release.releaseId}:${path}`;
}

/**
 * Decodes a chart data reference without ever resolving a server's current
 * pointer. Hosts must use the returned immutable `{ server, releaseId }` pair
 * to select the exact release captured when the catalog was projected.
 */
export function parseReleaseChartDataId(dataId: string): ReleaseChartDataReference | null {
  if (typeof dataId !== "string" || !dataId.startsWith(RELEASE_CHART_DATA_ID_PREFIX)) return null;
  const match = /^release:([a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?):(r-[a-f0-9]{20}):(.*)$/u.exec(dataId);
  const server = match?.[1];
  const releaseId = match?.[2];
  const path = match?.[3];
  if (!server || !releaseId || !path || !isReleaseAssetPath(path)) return null;
  return { path, releaseId, server };
}

export interface ReleaseChartCatalogProviderOptions {
  localeOrder?: readonly CatalogLocale[];
  mediaBaseUrl?: string;
  onInvalidCharts?: (names: readonly string[]) => void;
  readJson: ReleaseJsonReader;
  release: ReleaseChartProvenance;
  revision: string;
}

export class ReleaseChartCatalogProvider implements ChartCatalogProvider {
  readonly #options: ReleaseChartCatalogProviderOptions;

  constructor(options: ReleaseChartCatalogProviderOptions) {
    if (!options.revision.trim()) throw new TypeError("A non-empty release revision is required");
    releaseChartProvenance(options.release);
    this.#options = options;
  }

  async load(): Promise<ChartCatalogSnapshot> {
    const manifest = await this.#options.readJson("api/v1/catalog/manifest.json");
    const songsPath = catalogIndexPath(manifest, "songs");
    const bandsPath = catalogIndexPath(manifest, "bands");
    const [songs, bands] = await Promise.all([this.#options.readJson(songsPath), this.#options.readJson(bandsPath)]);
    if (songs === null || bands === null) throw new Error("Release is missing songs or bands catalog data");
    const release = releaseChartProvenance(this.#options.release);
    const projection = projectCatalogCharts(songs, bands, {
      ...(this.#options.localeOrder ? { localeOrder: this.#options.localeOrder } : {}),
      ...(this.#options.mediaBaseUrl ? { mediaBaseUrl: this.#options.mediaBaseUrl } : {}),
      chartDataId: (_songId, _difficulty, rawDifficulty) => {
        if (typeof rawDifficulty.file !== "string") return null;
        const path = releaseAssetPath(rawDifficulty.file, release.server);
        return path ? encodeReleaseChartDataId(release, path) : null;
      },
      levelName: (songId, difficulty) => releaseChartLevelName(release.server, songId, difficulty),
    });
    if (projection.invalidChartNames.length) this.#options.onInvalidCharts?.(projection.invalidChartNames);
    return { charts: projection.charts, revision: { id: this.#options.revision } };
  }
}

export interface ReleaseLevelTemplateProviderOptions {
  readJson: ReleaseJsonReader;
}

export class ReleaseLevelTemplateProvider implements LevelTemplateProvider {
  readonly #readJson: ReleaseJsonReader;

  constructor(options: ReleaseLevelTemplateProviderOptions) {
    this.#readJson = options.readJson;
  }

  async load(): Promise<LevelTemplate> {
    const page = await this.#readJson("runtime/sonolus/engines/list/page-0");
    if (!isObject(page) || !Array.isArray(page.items)) throw new Error("Sonolus engine page is invalid");
    const engine = page.items.find(isEngineItem);
    if (!engine) throw new Error("Sonolus engine template is missing");
    const item: SonolusLevelItem = {
      artists: "",
      author: "",
      bgm: {},
      cover: {},
      data: {},
      engine,
      name: "",
      rating: 0,
      tags: [],
      title: "",
      useBackground: { useDefault: true },
      useEffect: { useDefault: true },
      useParticle: { useDefault: true },
      useSkin: { useDefault: true },
      version: 1,
    };
    if (typeof engine.source === "string" && engine.source) item.source = engine.source;
    return { item };
  }
}

interface ConvertedChartData {
  body: ArrayBuffer;
  hash: string;
}

interface CacheEntry extends ConvertedChartData {
  bytes: number;
}

export interface RuntimeChartDataProviderOptions {
  maxCacheBytes?: number;
  maxChartBytes?: number;
  onInvalidChart?: (chart: ChartDescriptor, error: unknown) => void;
  readBytes: ReleaseByteReader;
  resource?: JsonObject;
}

async function gzipJson(value: unknown): Promise<ArrayBuffer> {
  if (typeof CompressionStream === "undefined") throw new Error("This runtime does not provide gzip compression");
  const encoded = new TextEncoder().encode(JSON.stringify(value));
  const stream = new Blob([encoded]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Response(stream).arrayBuffer();
}

async function sha1(value: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-1", value);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export class RuntimeChartDataProvider implements ChartDataProvider {
  readonly #cache = new Map<string, CacheEntry>();
  readonly #failures = new Set<string>();
  readonly #hashes = new Map<string, string>();
  readonly #maxCacheBytes: number;
  readonly #maxChartBytes: number;
  readonly #onInvalidChart: ((chart: ChartDescriptor, error: unknown) => void) | undefined;
  readonly #pending = new Map<string, Promise<ConvertedChartData | null>>();
  readonly #readBytes: ReleaseByteReader;
  readonly #resource: JsonObject;
  #cachedBytes = 0;

  constructor(options: RuntimeChartDataProviderOptions) {
    this.#maxCacheBytes = options.maxCacheBytes ?? DEFAULT_MAX_CACHE_BYTES;
    this.#maxChartBytes = options.maxChartBytes ?? DEFAULT_MAX_CHART_BYTES;
    if (!Number.isSafeInteger(this.#maxCacheBytes) || this.#maxCacheBytes < 0) {
      throw new TypeError("Chart data cache limit must be a non-negative integer");
    }
    if (!Number.isSafeInteger(this.#maxChartBytes) || this.#maxChartBytes < 1) {
      throw new TypeError("Chart input limit must be a positive integer");
    }
    this.#onInvalidChart = options.onInvalidChart;
    this.#readBytes = options.readBytes;
    this.#resource = options.resource ?? {};
  }

  async prepare(chart: ChartDescriptor): Promise<PreparedChartData | null> {
    const converted = await this.#getOrConvert(chart);
    return converted ? { hash: converted.hash, resource: { ...this.#resource, hash: converted.hash } } : null;
  }

  async load(chart: ChartDescriptor, expectedHash: string): Promise<ChartDataPayload | null> {
    if (!SHA1_PATTERN.test(expectedHash)) return null;
    const converted = await this.#getOrConvert(chart);
    if (!converted || converted.hash !== expectedHash) return null;
    return {
      body: converted.body,
      cacheControl: "public, max-age=31536000, immutable",
      contentType: "application/gzip",
      etag: `"${converted.hash}"`,
    };
  }

  async #convert(chart: ChartDescriptor): Promise<ConvertedChartData | null> {
    const input = await this.#readBytes(chart.dataId);
    if (!input) {
      this.#recordFailure(chart, new Error(`Chart source is missing: ${chart.dataId}`));
      return null;
    }
    if (input.byteLength > this.#maxChartBytes) {
      this.#recordFailure(chart, new Error(`Chart source exceeds ${this.#maxChartBytes} bytes`));
      return null;
    }

    let levelData: unknown;
    try {
      levelData = chartToLevelData(await convertChartAsync(input));
    } catch (error) {
      this.#recordFailure(chart, error);
      return null;
    }
    const body = await gzipJson(levelData);
    const hash = await sha1(body);
    const previousHash = this.#hashes.get(chart.dataId);
    if (previousHash && previousHash !== hash) {
      throw new Error(`Chart data changed within one catalog revision: ${chart.dataId}`);
    }
    this.#hashes.set(chart.dataId, hash);
    this.#cacheData(chart.dataId, { body, hash });
    return { body, hash };
  }

  async #getOrConvert(chart: ChartDescriptor): Promise<ConvertedChartData | null> {
    const cached = this.#cache.get(chart.dataId);
    if (cached) {
      this.#cache.delete(chart.dataId);
      this.#cache.set(chart.dataId, cached);
      return cached;
    }
    if (this.#failures.has(chart.dataId)) return null;
    const existing = this.#pending.get(chart.dataId);
    if (existing) return existing;
    const pending = this.#convert(chart);
    this.#pending.set(chart.dataId, pending);
    try {
      return await pending;
    } finally {
      if (this.#pending.get(chart.dataId) === pending) this.#pending.delete(chart.dataId);
    }
  }

  #cacheData(key: string, value: ConvertedChartData): void {
    const bytes = value.body.byteLength;
    if (bytes > this.#maxCacheBytes) return;
    const previous = this.#cache.get(key);
    if (previous) this.#cachedBytes -= previous.bytes;
    this.#cache.delete(key);
    this.#cache.set(key, { ...value, bytes });
    this.#cachedBytes += bytes;
    while (this.#cachedBytes > this.#maxCacheBytes) {
      const oldestKey = this.#cache.keys().next().value;
      if (oldestKey === undefined) break;
      const oldest = this.#cache.get(oldestKey);
      this.#cache.delete(oldestKey);
      if (oldest) this.#cachedBytes -= oldest.bytes;
    }
  }

  #recordFailure(chart: ChartDescriptor, error: unknown): void {
    this.#failures.add(chart.dataId);
    this.#onInvalidChart?.(chart, error);
  }
}
