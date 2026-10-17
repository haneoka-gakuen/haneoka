// L3 — GEB
// Input: 公共 API 客户端选项、资源和请求参数。
// Output: HaneokaClient 与目录资源访问适配。
// Pos: [Map](../../L2.md)；Haneoka 公共 API 的包级适配。
// Effects/Dependencies: 复用 ApiClient，调用方法可能联网；不直接读取站点私有数据库。
import { createApiClient, type ApiClientOptions, type ApiQuery } from "./index.js";

export type HaneokaLocale = "ja" | "en" | "zh-TW" | "zh-CN" | "ko";
export type HaneokaJson = null | boolean | number | string | HaneokaJson[] | { [key: string]: HaneokaJson };

export interface HaneokaReleaseIdentity {
  readonly schema: "haneoka-resource-release-identity-v1";
  readonly server: string;
  readonly releaseId: string;
  readonly sourceId: string;
}

export interface HaneokaClientOptions extends Omit<ApiClientOptions, "baseUrl"> {
  readonly baseUrl?: string;
}

export interface HaneokaScope {
  /** Resource-server slug from the server registry; defaults to intl. */
  readonly server?: string;
  /** UI language; catalog entities retain all supplied localized values. */
  readonly locale?: HaneokaLocale;
  /** Advanced snapshot selection, routed through /servers/{server}. */
  readonly release?: string;
  readonly signal?: AbortSignal;
}

export interface HaneokaReadOptions<T = HaneokaJson> extends HaneokaScope {
  readonly view?: string;
  readonly decode?: (value: unknown) => T;
}

export interface HaneokaPageOptions<T = HaneokaJson> extends HaneokaReadOptions<T> {
  readonly limit?: number;
  readonly cursor?: string;
}

export interface HaneokaBatch<T> {
  readonly items: Readonly<Record<string, T>>;
  readonly missing: readonly string[];
}

export interface HaneokaPage<T> {
  readonly items: readonly { readonly id: string; readonly value: T }[];
  readonly total: number;
  readonly limit: number;
  readonly nextCursor: string | null;
  readonly release: HaneokaReleaseIdentity;
}

export interface HaneokaServer {
  readonly id: string;
  readonly displayName: string;
  readonly region: string;
}

export interface HaneokaChartImageOptions {
  readonly server?: string;
  readonly locale?: HaneokaLocale;
  readonly format?: "svg" | "png";
  readonly height?: number;
  readonly download?: boolean;
}

const namePattern = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;
const serverPattern = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/u;
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:~-]{0,255}$/u;
const releasePattern = /^r-[a-f0-9]{20}$/u;
const locales = new Set<string>(["ja", "en", "zh-TW", "zh-CN", "ko"]);
const reserved = new Set([
  "game",
  "search",
  "account",
  "admin",
  "announcements",
  "auth",
  "catalog",
  "community",
  "garupa",
  "me",
  "release",
  "releases",
  "servers",
  "sources",
  "ui-marks",
]);

function segment(value: string, pattern: RegExp, label: string): string {
  if (!pattern.test(value)) throw new TypeError(`Invalid ${label}`);
  return encodeURIComponent(value);
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Expected an object");
  return value as Record<string, unknown>;
}

function json(value: unknown): HaneokaJson {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  )
    return value;
  if (Array.isArray(value)) return value.map(json);
  const result: Record<string, HaneokaJson> = Object.create(null) as Record<string, HaneokaJson>;
  for (const [key, entry] of Object.entries(object(value))) result[key] = json(entry);
  return result;
}

function identity(value: unknown): HaneokaReleaseIdentity {
  const raw = object(value);
  if (
    raw.schema !== "haneoka-resource-release-identity-v1" ||
    typeof raw.server !== "string" ||
    !serverPattern.test(raw.server) ||
    typeof raw.releaseId !== "string" ||
    !releasePattern.test(raw.releaseId) ||
    typeof raw.sourceId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(raw.sourceId)
  ) {
    throw new TypeError("Invalid release identity");
  }
  return { schema: raw.schema, server: raw.server, releaseId: raw.releaseId, sourceId: raw.sourceId };
}

function scopeQuery(scope: HaneokaScope): ApiQuery {
  if (scope.server !== undefined) segment(scope.server, serverPattern, "server");
  if (scope.release !== undefined) segment(scope.release, releasePattern, "release");
  if (scope.locale !== undefined && !locales.has(scope.locale)) throw new TypeError("Invalid locale");
  return {
    ...(scope.release === undefined ? { server: scope.server } : { release: scope.release }),
    locale: scope.locale,
  };
}

function resourcePath(resource: string, options: HaneokaReadOptions<unknown>): string {
  if (reserved.has(resource)) throw new TypeError("Use a catalog resource name");
  const root = segment(resource, namePattern, "resource");
  const view = options.view === undefined ? "" : `/views/${segment(options.view, namePattern, "view")}`;
  return `${options.release === undefined ? "" : `servers/${segment(options.server ?? "intl", serverPattern, "server")}/`}${root}${view}`;
}

export interface HaneokaClient {
  servers(scope?: Pick<HaneokaScope, "signal">): Promise<readonly HaneokaServer[]>;
  index<T = HaneokaJson>(resource: string, options?: HaneokaReadOptions<T>): Promise<T>;
  entity<T = HaneokaJson>(resource: string, id: string, options?: HaneokaReadOptions<T>): Promise<T>;
  batch<T = HaneokaJson>(
    resource: string,
    ids: readonly string[],
    options?: HaneokaReadOptions<T>,
  ): Promise<HaneokaBatch<T>>;
  page<T = HaneokaJson>(resource: string, options?: HaneokaPageOptions<T>): Promise<HaneokaPage<T>>;
  relation<T = HaneokaJson>(
    resource: string,
    relation: string,
    key: string,
    options?: HaneokaReadOptions<T>,
  ): Promise<T>;
  chartImageUrl(
    songId: string,
    difficulty: "easy" | "normal" | "hard" | "expert" | "special" | "master",
    options?: HaneokaChartImageOptions,
  ): string;
}

/** baseUrl is the /api/v1 root; all resource and image routes are constructed here. */
export function createHaneokaClient(options: HaneokaClientOptions = {}): HaneokaClient {
  const transport = options.transport ?? fetch;
  const api = createApiClient({
    ...options,
    baseUrl: options.baseUrl ?? "https://haneoka.org/api/v1/",
    transport: (request) =>
      transport(
        new Request(request, {
          credentials: "omit",
          mode: "cors",
          referrerPolicy: "no-referrer",
        }),
      ),
  });
  const read = <T>(path: string, scope: HaneokaScope, decode: (value: unknown) => T, extra: ApiQuery = {}) =>
    api.get<T>(path, {
      query: { ...scopeQuery(scope), ...extra },
      ...(scope.signal ? { signal: scope.signal } : {}),
      decode,
    });
  const decoder = <T>(options: HaneokaReadOptions<T>) => options.decode ?? (json as (value: unknown) => T);
  return {
    servers: (scope = {}) =>
      api.get("releases", {
        ...scope,
        decode: (value) => {
          const raw = object(value).releases;
          if (!Array.isArray(raw)) throw new TypeError("Invalid server registry");
          return raw.map((entry) => {
            const row = object(entry);
            if (
              typeof row.id !== "string" ||
              !serverPattern.test(row.id) ||
              typeof row.displayName !== "string" ||
              typeof row.region !== "string"
            )
              throw new TypeError("Invalid server registry entry");
            return { id: row.id, displayName: row.displayName, region: row.region };
          });
        },
      }),
    index: <T = HaneokaJson>(resource: string, scope: HaneokaReadOptions<T> = {}) =>
      read(resourcePath(resource, scope), scope, decoder(scope)),
    entity: <T = HaneokaJson>(resource: string, id: string, scope: HaneokaReadOptions<T> = {}) =>
      read(`${resourcePath(resource, scope)}/${segment(id, idPattern, "entity id")}`, scope, decoder(scope)),
    batch: <T = HaneokaJson>(resource: string, ids: readonly string[], scope: HaneokaReadOptions<T> = {}) => {
      if (!ids.length || ids.length > 100) throw new TypeError("Batch must contain 1–100 ids");
      for (const id of ids) segment(id, idPattern, "entity id");
      return read(
        resourcePath(resource, scope),
        scope,
        (value) => {
          const raw = object(value);
          const items: Record<string, T> = Object.create(null) as Record<string, T>;
          for (const [id, entry] of Object.entries(object(raw.items))) items[id] = decoder(scope)(entry);
          if (!Array.isArray(raw.missing) || raw.missing.some((id) => typeof id !== "string"))
            throw new TypeError("Invalid missing ids");
          return { items, missing: raw.missing as string[] };
        },
        { id: ids },
      );
    },
    page: <T = HaneokaJson>(resource: string, scope: HaneokaPageOptions<T> = {}) => {
      const limit = scope.limit ?? 50;
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new TypeError("Page limit must be 1–100");
      return read(
        resourcePath(resource, scope),
        scope,
        (value) => {
          const raw = object(value);
          if (
            !Array.isArray(raw.items) ||
            !Number.isSafeInteger(raw.total) ||
            Number(raw.total) < 0 ||
            raw.limit !== limit ||
            raw.items.length > limit ||
            (raw.nextCursor !== null && (typeof raw.nextCursor !== "string" || !raw.nextCursor))
          )
            throw new TypeError("Invalid catalog page");
          const release = identity(raw.release);
          if (release.server !== (scope.server ?? "intl") || (scope.release && release.releaseId !== scope.release))
            throw new TypeError("Unexpected page snapshot");
          return {
            items: raw.items.map((entry) => {
              const row = object(entry);
              if (typeof row.id !== "string" || !idPattern.test(row.id)) throw new TypeError("Invalid page id");
              return { id: row.id, value: decoder(scope)(row.value) };
            }),
            total: raw.total as number,
            limit,
            nextCursor: raw.nextCursor as string | null,
            release,
          };
        },
        { limit, cursor: scope.cursor },
      );
    },
    relation: <T = HaneokaJson>(resource: string, relation: string, key: string, scope: HaneokaReadOptions<T> = {}) => {
      if (scope.view !== undefined) throw new TypeError("Relations belong to resources");
      return read(
        `${resourcePath(resource, scope)}/relations/${segment(relation, namePattern, "relation")}/${segment(key, idPattern, "relation key")}`,
        scope,
        decoder(scope),
      );
    },
    chartImageUrl: (songId, difficulty, scope = {}) => {
      if (!["easy", "normal", "hard", "expert", "special", "master"].includes(difficulty))
        throw new TypeError("Invalid difficulty");
      if (scope.height !== undefined && (!Number.isInteger(scope.height) || scope.height < 360 || scope.height > 1440))
        throw new TypeError("Image height must be 360–1440");
      const format = scope.format ?? "svg";
      if (format !== "svg" && format !== "png") throw new TypeError("Invalid image format");
      return api.url(`songs/${segment(songId, idPattern, "song id")}/charts/${difficulty}/image.${format}`, {
        ...scopeQuery(scope),
        height: scope.height,
        download: scope.download === undefined ? undefined : scope.download ? 1 : 0,
      });
    },
  };
}
