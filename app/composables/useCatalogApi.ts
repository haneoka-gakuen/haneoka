import { ApiClientError, createApiClient, type ApiClient } from "@haneoka/api-client";
import { BESTDORI_CACHE_POLICY } from "@haneoka/bestdori/cache-policy";
import { BESTDORI_CATALOG_VERSION } from "@haneoka/bestdori/resources";
import {
  contentOriginKey,
  isBestdoriOrigin,
  ourNotesReleaseOrigin,
  releaseFallbackOrder,
  type CatalogContentOrigin,
} from "~/features/catalog/contentSource";

let browserApiClient: ApiClient | undefined;
const catalogJson = <T>(url: string): Promise<T> => {
  if (!import.meta.client) throw new Error("Catalog requests are only available in the browser");
  browserApiClient ??= createApiClient({ baseUrl: `${window.location.origin}/` });
  return browserApiClient.get<T>(new URL(url, window.location.origin).toString());
};

const catalogPath = (path: unknown): string =>
  String(path || "")
    .replace(/^\/+|\/+$/g, "")
    .split("/")
    .filter(Boolean)
    .map(encodeURIComponent)
    .join("/");

/**
 * Resolve a catalog URL from a namespaced origin.
 *
 * Our Notes release archives remain under the release API. Garupa content is
 * deliberately routed through its own API namespace, so a Bestdori region can
 * never be mistaken for an Our Notes release with the same slug (for example
 * `jp`).
 */
export const catalogApiUrl = (apiBase: unknown, origin: CatalogContentOrigin, path: unknown): string => {
  const base = String(apiBase || "/api/v1").replace(/\/+$/, "");
  const segments = catalogPath(path);
  if (origin.provider === "release") return `${base}/servers/${encodeURIComponent(origin.releaseId)}/${segments}`;
  return `${base}/garupa/bestdori/${encodeURIComponent(origin.region)}/${segments}`;
};

const appendCatalogQuery = (url: string, query: string): string =>
  query ? `${url}${url.includes("?") ? "&" : "?"}${query.replace(/^\?/, "")}` : url;

const useCatalogRequestContext = (origin?: MaybeRefOrGetter<CatalogContentOrigin | undefined>) => {
  const config = useRuntimeConfig();
  const { releaseServer } = useReleaseServer();
  const { locale } = useLocale();
  // Most catalog requests follow the selected Our Notes release. Bestdori is
  // a provider source, not a release-server slug, and is modeled separately.
  const catalogOrigin = computed<CatalogContentOrigin>(() => {
    const requested = origin === undefined ? undefined : toValue(origin);
    return requested === undefined ? ourNotesReleaseOrigin(releaseServer.value) : requested;
  });
  // Region is part of the Bestdori URL. Locale is intentionally separate: it
  // controls localized labels only and must not choose a different upstream
  // region or asset.
  const catalogQueryPart = computed(() =>
    isBestdoriOrigin(catalogOrigin.value)
      ? `lang=${encodeURIComponent(locale.value)}&v=${encodeURIComponent(BESTDORI_CATALOG_VERSION)}`
      : "",
  );
  const requestUrl = (path: MaybeRefOrGetter<string>) =>
    computed(() =>
      appendCatalogQuery(
        catalogApiUrl(config.public.apiBase, catalogOrigin.value, toValue(path)),
        catalogQueryPart.value,
      ),
    );
  const dataKey = (path: MaybeRefOrGetter<string>) =>
    computed(() => `catalog:${contentOriginKey(catalogOrigin.value)}:${toValue(path)}?${catalogQueryPart.value}`);
  return { releaseServer, catalogOrigin, catalogQueryPart, requestUrl, dataKey };
};

export const useCatalogDocument = <T>(
  resource: MaybeRefOrGetter<string>,
  origin?: MaybeRefOrGetter<CatalogContentOrigin | undefined>,
) => {
  const { requestUrl, dataKey } = useCatalogRequestContext(origin);
  const url = requestUrl(resource);
  // Catalog payloads are immutable snapshots. Keeping them shallow avoids
  // recursively proxying tens of thousands of fields before a page can render.
  return useAsyncData<T>(dataKey(resource), () => catalogJson<T>(url.value), {
    deep: false,
    server: false,
    watch: [url],
  });
};

export const useCatalogView = <T>(
  resource: string,
  view: MaybeRefOrGetter<string>,
  origin?: MaybeRefOrGetter<CatalogContentOrigin | undefined>,
) =>
  useCatalogDocument<T>(
    computed(() => `${resource}/views/${toValue(view)}`),
    origin,
  );

interface LazyCatalogCacheEntry {
  value: unknown;
  expiresAt: number;
}

const lazyCatalogCache = new Map<string, LazyCatalogCacheEntry>();
const lazyCatalogInflight = new Map<string, Promise<unknown>>();

// Normal archive releases are immutable snapshots for the current session.
// Bestdori is a live upstream: bound its in-memory list cache so navigating
// back to a story or song catalog eventually requests a fresh response.
const lazyCatalogCacheTtlMs = (origin: CatalogContentOrigin): number =>
  isBestdoriOrigin(origin) ? BESTDORI_CACHE_POLICY.catalog.clientTtlMs : Number.POSITIVE_INFINITY;

const readLazyCatalogCache = (key: string): LazyCatalogCacheEntry | undefined => {
  const entry = lazyCatalogCache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    lazyCatalogCache.delete(key);
    return undefined;
  }
  return entry;
};

const writeLazyCatalogCache = (key: string, value: unknown, origin: CatalogContentOrigin): void => {
  lazyCatalogCache.set(key, {
    value,
    expiresAt: Date.now() + lazyCatalogCacheTtlMs(origin),
  });
};

interface LazyCatalogFallback<T> {
  resource: MaybeRefOrGetter<string>;
  select: (document: unknown) => T;
}

export const useLazyCatalogDocument = <T>(
  resource: MaybeRefOrGetter<string>,
  active: MaybeRefOrGetter<boolean>,
  fallback?: LazyCatalogFallback<T>,
  origin?: MaybeRefOrGetter<CatalogContentOrigin | undefined>,
) => {
  const config = useRuntimeConfig();
  const { catalogOrigin, catalogQueryPart } = useCatalogRequestContext(origin);
  const data = shallowRef<T>();
  const pending = ref(false);
  const error = shallowRef<unknown>();
  let loadedKey = "";
  let requestVersion = 0;

  const cacheKey = (path: string) => `${contentOriginKey(catalogOrigin.value)}:${path}?${catalogQueryPart.value}`;
  const requestDocument = async <Value>(path: string, force: boolean): Promise<Value> => {
    const key = cacheKey(path);
    const cached = force ? undefined : readLazyCatalogCache(key);
    if (cached) return cached.value as Value;
    let request = lazyCatalogInflight.get(key) as Promise<Value> | undefined;
    if (!request) {
      request = catalogJson<Value>(
        appendCatalogQuery(catalogApiUrl(config.public.apiBase, catalogOrigin.value, path), catalogQueryPart.value),
      );
      lazyCatalogInflight.set(key, request);
      void request.then(
        () => lazyCatalogInflight.delete(key),
        () => lazyCatalogInflight.delete(key),
      );
    }
    const response = await request;
    writeLazyCatalogCache(key, response, catalogOrigin.value);
    return response;
  };

  const load = async (force = false) => {
    if (import.meta.server) return;
    if (!toValue(active)) {
      requestVersion += 1;
      pending.value = false;
      return;
    }
    const resourcePath = toValue(resource);
    const key = cacheKey(resourcePath);
    const fallbackPath = fallback ? toValue(fallback.resource) : "";
    const fallbackResultKey = fallbackPath ? `${key}:fallback:${cacheKey(fallbackPath)}` : "";
    if (!force && loadedKey === key) return;
    const version = ++requestVersion;
    const cached = force ? undefined : readLazyCatalogCache(key) || readLazyCatalogCache(fallbackResultKey);
    if (cached) {
      data.value = cached.value as T;
      loadedKey = key;
      pending.value = false;
      error.value = undefined;
      return;
    }
    if (loadedKey !== key) data.value = undefined;
    pending.value = true;
    error.value = undefined;
    try {
      let response: T;
      try {
        response = await requestDocument<T>(resourcePath, force);
      } catch (reason) {
        if (!fallback || !fallbackPath) throw reason;
        response = fallback.select(await requestDocument<unknown>(fallbackPath, force));
        writeLazyCatalogCache(fallbackResultKey, response, catalogOrigin.value);
      }
      if (version === requestVersion) {
        data.value = response;
        loadedKey = key;
      }
    } catch (reason) {
      if (version === requestVersion) error.value = reason;
    } finally {
      if (version === requestVersion) pending.value = false;
    }
  };

  watch(
    [
      () => Boolean(toValue(active)),
      () => contentOriginKey(catalogOrigin.value),
      catalogQueryPart,
      () => toValue(resource),
      () => (fallback ? toValue(fallback.resource) : ""),
    ],
    () => void load(),
    { immediate: true },
  );

  return { data, pending, error, refresh: () => load(true) };
};

export const useLazyCatalogView = <T>(
  resource: string,
  view: MaybeRefOrGetter<string>,
  active: MaybeRefOrGetter<boolean>,
  fallback?: LazyCatalogFallback<T>,
  origin?: MaybeRefOrGetter<CatalogContentOrigin | undefined>,
) =>
  useLazyCatalogDocument<T>(
    computed(() => `${resource}/views/${toValue(view)}`),
    active,
    fallback,
    origin,
  );

export const useLazyCatalogCollection = <T>(
  resource: string,
  active: MaybeRefOrGetter<boolean>,
  origin?: MaybeRefOrGetter<CatalogContentOrigin | undefined>,
) => useLazyCatalogDocument<Record<string, T>>(resource, active, undefined, origin);

export interface CatalogSummaryResource {
  count: number;
}

export interface CatalogSummary {
  resources: Record<string, CatalogSummaryResource>;
}

export const useCatalogSummary = () => useCatalogDocument<CatalogSummary>("catalog/summary");

export const useCatalogCollection = <T>(
  resource: string,
  origin?: MaybeRefOrGetter<CatalogContentOrigin | undefined>,
) => {
  const { requestUrl, dataKey } = useCatalogRequestContext(origin);
  const url = requestUrl(resource);
  return useAsyncData<Record<string, T>>(dataKey(resource), () => catalogJson<Record<string, T>>(url.value), {
    deep: false,
    server: false,
    default: () => ({}),
    watch: [url],
  });
};

/** One immutable catalog collection for each concrete content origin. */
export interface CatalogCollectionSource<T> {
  readonly origin: CatalogContentOrigin;
  readonly records: Record<string, T>;
}

/**
 * Fetch a collection from a reactive set of origins.
 *
 * This is intentionally separate from `useCatalogCollection`: callers that
 * need a cross-release view (currently Garupa playlist resolution) must keep
 * each origin attached to its records instead of flattening data from
 * different games or releases into one ambiguous map. Failed optional origins
 * are omitted so one unavailable release does not prevent the remaining
 * sources from participating in the fallback chain.
 */
export const useCatalogCollectionSet = <T>(
  resource: MaybeRefOrGetter<string>,
  origins: MaybeRefOrGetter<readonly CatalogContentOrigin[]>,
  key: string,
) => {
  const config = useRuntimeConfig();
  const { locale } = useLocale();
  const uniqueOrigins = computed<CatalogContentOrigin[]>(() => {
    const byKey = new Map<string, CatalogContentOrigin>();
    for (const origin of toValue(origins)) {
      const originKey = contentOriginKey(origin);
      if (!byKey.has(originKey)) byKey.set(originKey, origin);
    }
    return [...byKey.values()];
  });
  const signature = computed(() =>
    [
      toValue(resource),
      ...uniqueOrigins.value.map(
        (origin) =>
          `${contentOriginKey(origin)}${isBestdoriOrigin(origin) ? `?${locale.value}:${BESTDORI_CATALOG_VERSION}` : ""}`,
      ),
    ].join("|"),
  );

  return useAsyncData<CatalogCollectionSource<T>[]>(
    key,
    async () => {
      const path = toValue(resource);
      const results = await Promise.allSettled(
        uniqueOrigins.value.map(async (origin): Promise<CatalogCollectionSource<T>> => {
          const query = isBestdoriOrigin(origin)
            ? `lang=${encodeURIComponent(locale.value)}&v=${encodeURIComponent(BESTDORI_CATALOG_VERSION)}`
            : "";
          const url = appendCatalogQuery(catalogApiUrl(config.public.apiBase, origin, path), query);
          return { origin, records: await catalogJson<Record<string, T>>(url) };
        }),
      );
      const collections = results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
      if (!collections.length && results.length) {
        const failed = results.find((result) => result.status === "rejected");
        if (failed?.status === "rejected") throw failed.reason;
      }
      return collections;
    },
    {
      deep: false,
      server: false,
      default: () => [],
      watch: [signature],
    },
  );
};

export const useCatalogRecord = <T>(
  resource: string,
  id: MaybeRefOrGetter<string>,
  origin?: MaybeRefOrGetter<CatalogContentOrigin | undefined>,
  query?: MaybeRefOrGetter<CatalogRecordsQuery | undefined>,
) => {
  const path = computed(() => `${resource}/${toValue(id)}`);
  const { requestUrl, dataKey } = useCatalogRequestContext(origin);
  const queryPart = computed(() => {
    const entries = Object.entries(toValue(query) || {})
      .filter(([, value]) => value !== undefined && value !== null && value !== "")
      .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
      .sort();
    return entries.length ? `?${entries.join("&")}` : "";
  });
  const url = computed(() => appendCatalogQuery(requestUrl(path).value, queryPart.value));
  return useAsyncData<T>(`${dataKey(path).value}${queryPart.value}`, () => catalogJson<T>(url.value), {
    deep: false,
    server: false,
    watch: [url],
  });
};

export const useCatalogRelation = <T>(
  resource: string,
  relation: string,
  key: MaybeRefOrGetter<string | number | null | undefined>,
  origin?: MaybeRefOrGetter<CatalogContentOrigin | undefined>,
) => {
  const config = useRuntimeConfig();
  const { releaseServer } = useReleaseServer();
  const catalogOrigin = computed<CatalogContentOrigin>(() => {
    const requested = origin === undefined ? undefined : toValue(origin);
    return requested === undefined ? ourNotesReleaseOrigin(releaseServer.value) : requested;
  });
  const data = shallowRef<Record<string, T>>({});
  const pending = ref(false);
  const error = shallowRef<unknown>();
  let requestVersion = 0;

  const load = async () => {
    const selected = toValue(key);
    const version = ++requestVersion;
    data.value = {};
    error.value = undefined;
    if (import.meta.server || selected === undefined || selected === null || selected === "") {
      pending.value = false;
      return;
    }
    pending.value = true;
    try {
      const url = catalogApiUrl(
        config.public.apiBase,
        catalogOrigin.value,
        `${resource}/relations/${relation}/${selected}`,
      );
      const response = await catalogJson<Record<string, T>>(url);
      if (version === requestVersion) data.value = response;
    } catch (reason) {
      if (version === requestVersion) error.value = reason;
    } finally {
      if (version === requestVersion) pending.value = false;
    }
  };

  watch([() => toValue(key), () => contentOriginKey(catalogOrigin.value)], () => void load(), { immediate: true });
  return { data, pending, error, refresh: load };
};

interface CatalogRecordsResponse<T> {
  items: Record<string, T>;
  missing: string[];
}

type CatalogRecordsQuery = Readonly<Record<string, boolean | number | string | null | undefined>>;

export const useCatalogRecords = <T>(
  resource: string,
  ids: MaybeRefOrGetter<readonly string[]>,
  origin?: MaybeRefOrGetter<CatalogContentOrigin | undefined>,
  query?: MaybeRefOrGetter<CatalogRecordsQuery | undefined>,
) => {
  const config = useRuntimeConfig();
  const { releaseServer } = useReleaseServer();
  const { locale } = useLocale();
  const catalogOrigin = computed<CatalogContentOrigin>(() => {
    const requested = origin === undefined ? undefined : toValue(origin);
    return requested === undefined ? ourNotesReleaseOrigin(releaseServer.value) : requested;
  });
  const data = shallowRef<Record<string, T>>({});
  const pending = ref(false);
  const error = shallowRef<unknown>();
  let requestVersion = 0;

  const normalizedIds = () =>
    [...new Set(toValue(ids).map(String).filter(Boolean))].sort((left, right) => left.localeCompare(right));
  const normalizedQuery = () => {
    const entries = new Map<string, string>();
    if (isBestdoriOrigin(catalogOrigin.value)) {
      entries.set("lang", locale.value);
      entries.set("v", BESTDORI_CATALOG_VERSION);
    }
    for (const [key, value] of Object.entries(toValue(query) || {})) {
      if (value === undefined || value === null || value === "") continue;
      entries.set(key, String(value));
    }
    return [...entries].sort(([left], [right]) => left.localeCompare(right));
  };
  const requestParameters = () => {
    const parameters = new URLSearchParams();
    for (const id of normalizedIds()) parameters.append("id", id);
    for (const [key, value] of normalizedQuery()) parameters.append(key, value);
    return parameters.toString();
  };

  const load = async () => {
    const selected = normalizedIds();
    const version = ++requestVersion;
    data.value = {};
    error.value = undefined;
    if (import.meta.server || !selected.length) {
      data.value = {};
      pending.value = false;
      return;
    }
    pending.value = true;
    try {
      const baseUrl = catalogApiUrl(config.public.apiBase, catalogOrigin.value, resource);
      const response = await catalogJson<CatalogRecordsResponse<T>>(`${baseUrl}?${requestParameters()}`);
      if (version === requestVersion) data.value = response.items;
    } catch (reason) {
      if (version === requestVersion) {
        data.value = {};
        error.value = reason;
      }
    } finally {
      if (version === requestVersion) pending.value = false;
    }
  };

  watch(
    [
      () => normalizedIds().join("\0"),
      () =>
        normalizedQuery()
          .map(([key, value]) => `${key}=${value}`)
          .join("\0"),
      () => contentOriginKey(catalogOrigin.value),
    ],
    () => void load(),
    { immediate: true },
  );
  return { data, pending, error, refresh: load };
};

export interface CatalogSelectionOptions {
  /** Try the selected Our Notes release before the configured release fallback chain. */
  fallbackAcrossReleases?: boolean;
  /** Provider-specific parameters for a detail request. */
  query?: MaybeRefOrGetter<CatalogRecordsQuery | undefined>;
}

export const useCatalogSelection = <T>(
  resource: string,
  id: MaybeRefOrGetter<string | number | undefined>,
  origin?: MaybeRefOrGetter<CatalogContentOrigin | undefined>,
  options: CatalogSelectionOptions = {},
) => {
  const config = useRuntimeConfig();
  const { releaseServer, fallbackReleaseServers } = useReleaseServer();
  const { locale } = useLocale();
  const requestedOrigin = computed<CatalogContentOrigin>(() => {
    const requested = origin === undefined ? undefined : toValue(origin);
    return requested === undefined ? ourNotesReleaseOrigin(releaseServer.value) : requested;
  });
  const data = shallowRef<T>();
  const resolvedOrigin = shallowRef<CatalogContentOrigin>();
  const pending = ref(false);
  const error = shallowRef<unknown>();
  let requestVersion = 0;

  const requestQuery = (candidate: CatalogContentOrigin): string => {
    const entries = new Map<string, string>();
    if (isBestdoriOrigin(candidate)) {
      entries.set("lang", locale.value);
      entries.set("v", BESTDORI_CATALOG_VERSION);
    }
    for (const [key, value] of Object.entries(toValue(options.query) || {})) {
      if (value === undefined || value === null || value === "") continue;
      entries.set(key, String(value));
    }
    return [...entries]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
      .join("&");
  };

  const load = async () => {
    const selected = toValue(id);
    const version = ++requestVersion;
    error.value = undefined;
    if (import.meta.server || selected === undefined || selected === null || selected === "") {
      data.value = undefined;
      resolvedOrigin.value = undefined;
      pending.value = false;
      return;
    }
    data.value = undefined;
    resolvedOrigin.value = undefined;
    pending.value = true;
    try {
      const candidates =
        options.fallbackAcrossReleases && requestedOrigin.value.provider === "release"
          ? releaseFallbackOrder(requestedOrigin.value.releaseId, fallbackReleaseServers.value)
          : [requestedOrigin.value];
      let lastError: unknown;
      for (const candidate of candidates) {
        const url = appendCatalogQuery(
          catalogApiUrl(config.public.apiBase, candidate, `${resource}/${selected}`),
          requestQuery(candidate),
        );
        try {
          const response = await catalogJson<T>(url);
          if (version === requestVersion) {
            data.value = response;
            resolvedOrigin.value = candidate;
          }
          lastError = undefined;
          break;
        } catch (reason) {
          lastError = reason;
          if (!(reason instanceof ApiClientError) || reason.status !== 404) throw reason;
        }
      }
      if (lastError !== undefined) throw lastError;
    } catch (reason) {
      if (version === requestVersion) {
        data.value = undefined;
        resolvedOrigin.value = undefined;
        error.value = reason;
      }
    } finally {
      if (version === requestVersion) pending.value = false;
    }
  };

  watch(
    [
      () => toValue(id),
      () => contentOriginKey(requestedOrigin.value),
      () => fallbackReleaseServers.value.join("\0"),
      locale,
      () => requestQuery(requestedOrigin.value),
    ],
    () => void load(),
    { immediate: true },
  );
  return { data, resolvedOrigin, pending, error, refresh: load };
};

export const recordValues = <T>(record: Record<string, T> | null | undefined): T[] => {
  // A proxy/CDN misconfiguration can return an HTML string with HTTP 200. Do
  // not turn every character of that document into a catalog row while the
  // caller is recovering from the bad response.
  if (!record || typeof record !== "object" || Array.isArray(record)) return [];
  return Object.values(record);
};
