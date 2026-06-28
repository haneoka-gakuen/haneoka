import { createApiClient, type ApiClient } from "@haneoka/api-client";
import { BESTDORI_CACHE_POLICY } from "@haneoka/bestdori/cache-policy";
import { BESTDORI_CATALOG_VERSION } from "@haneoka/bestdori/resources";

let browserApiClient: ApiClient | undefined;
const catalogJson = <T>(url: string): Promise<T> => {
  if (!import.meta.client) throw new Error("Catalog requests are only available in the browser");
  browserApiClient ??= createApiClient({ baseUrl: `${window.location.origin}/` });
  return browserApiClient.get<T>(new URL(url, window.location.origin).toString());
};

export const catalogApiUrl = (apiBase: unknown, server: unknown, path: unknown): string => {
  const base = String(apiBase || "/api/v1").replace(/\/+$/, "");
  const serverId = encodeURIComponent(normalizeAssetServer(server));
  const segments = String(path || "")
    .replace(/^\/+|\/+$/g, "")
    .split("/")
    .filter(Boolean)
    .map(encodeURIComponent);
  return `${base}/servers/${serverId}/${segments.join("/")}`;
};

const appendCatalogQuery = (url: string, query: string): string =>
  query ? `${url}${url.includes("?") ? "&" : "?"}${query.replace(/^\?/, "")}` : url;

const useCatalogRequestContext = (server?: MaybeRefOrGetter<string | undefined>) => {
  const config = useRuntimeConfig();
  const { assetServer } = useAssetServer();
  const { locale } = useLocale();
  // Most catalog requests follow the selected release server. Catalog-shaped
  // proxy sources can opt into their stable server name without duplicating
  // URL, cache-key, or shallow-response behavior at each call site.
  const catalogServer = computed(() => {
    // A reactive optional override can resolve to undefined; that means
    // “follow the selected server,” not “pin the default server.”
    const requested = server === undefined ? undefined : toValue(server);
    return normalizeAssetServer(requested === undefined ? assetServer.value : requested);
  });
  // Bestdori publishes independent regional resources. Every catalog-shaped
  // request carries the UI locale so the worker can apply one shared fallback
  // order instead of silently choosing JP while transforming the response.
  const catalogQueryPart = computed(() =>
    catalogServer.value === "bestdori"
      ? `lang=${encodeURIComponent(locale.value)}&v=${encodeURIComponent(BESTDORI_CATALOG_VERSION)}`
      : "",
  );
  const requestUrl = (path: MaybeRefOrGetter<string>) =>
    computed(() =>
      appendCatalogQuery(
        catalogApiUrl(config.public.apiBase, catalogServer.value, toValue(path)),
        catalogQueryPart.value,
      ),
    );
  const dataKey = (path: MaybeRefOrGetter<string>) =>
    computed(() => `catalog:${catalogServer.value}:${toValue(path)}?${catalogQueryPart.value}`);
  return { assetServer, catalogServer, catalogQueryPart, requestUrl, dataKey };
};

export const useCatalogDocument = <T>(
  resource: MaybeRefOrGetter<string>,
  server?: MaybeRefOrGetter<string | undefined>,
) => {
  const { requestUrl, dataKey } = useCatalogRequestContext(server);
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
  server?: MaybeRefOrGetter<string | undefined>,
) =>
  useCatalogDocument<T>(
    computed(() => `${resource}/views/${toValue(view)}`),
    server,
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
const lazyCatalogCacheTtlMs = (catalogServer: string): number =>
  catalogServer === "bestdori" ? BESTDORI_CACHE_POLICY.catalog.clientTtlMs : Number.POSITIVE_INFINITY;

const readLazyCatalogCache = (key: string): LazyCatalogCacheEntry | undefined => {
  const entry = lazyCatalogCache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    lazyCatalogCache.delete(key);
    return undefined;
  }
  return entry;
};

const writeLazyCatalogCache = (key: string, value: unknown, catalogServer: string): void => {
  lazyCatalogCache.set(key, {
    value,
    expiresAt: Date.now() + lazyCatalogCacheTtlMs(catalogServer),
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
  server?: MaybeRefOrGetter<string | undefined>,
) => {
  const config = useRuntimeConfig();
  const { catalogServer, catalogQueryPart } = useCatalogRequestContext(server);
  const data = shallowRef<T>();
  const pending = ref(false);
  const error = shallowRef<unknown>();
  let loadedKey = "";
  let requestVersion = 0;

  const cacheKey = (path: string) => `${catalogServer.value}:${path}?${catalogQueryPart.value}`;
  const requestDocument = async <Value>(path: string, force: boolean): Promise<Value> => {
    const key = cacheKey(path);
    const cached = force ? undefined : readLazyCatalogCache(key);
    if (cached) return cached.value as Value;
    let request = lazyCatalogInflight.get(key) as Promise<Value> | undefined;
    if (!request) {
      request = catalogJson<Value>(
        appendCatalogQuery(catalogApiUrl(config.public.apiBase, catalogServer.value, path), catalogQueryPart.value),
      );
      lazyCatalogInflight.set(key, request);
      void request.then(
        () => lazyCatalogInflight.delete(key),
        () => lazyCatalogInflight.delete(key),
      );
    }
    const response = await request;
    writeLazyCatalogCache(key, response, catalogServer.value);
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
        writeLazyCatalogCache(fallbackResultKey, response, catalogServer.value);
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
      catalogServer,
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
  server?: MaybeRefOrGetter<string | undefined>,
) =>
  useLazyCatalogDocument<T>(
    computed(() => `${resource}/views/${toValue(view)}`),
    active,
    fallback,
    server,
  );

export const useLazyCatalogCollection = <T>(
  resource: string,
  active: MaybeRefOrGetter<boolean>,
  server?: MaybeRefOrGetter<string | undefined>,
) => useLazyCatalogDocument<Record<string, T>>(resource, active, undefined, server);

export interface CatalogSummaryResource {
  count: number;
}

export interface CatalogSummary {
  resources: Record<string, CatalogSummaryResource>;
}

export const useCatalogSummary = () => useCatalogDocument<CatalogSummary>("catalog/summary");

export const useCatalogCollection = <T>(resource: string, server?: MaybeRefOrGetter<string | undefined>) => {
  const { requestUrl, dataKey } = useCatalogRequestContext(server);
  const url = requestUrl(resource);
  return useAsyncData<Record<string, T>>(dataKey(resource), () => catalogJson<Record<string, T>>(url.value), {
    deep: false,
    server: false,
    default: () => ({}),
    watch: [url],
  });
};

export const useCatalogRecord = <T>(
  resource: string,
  id: MaybeRefOrGetter<string>,
  server?: MaybeRefOrGetter<string | undefined>,
  query?: MaybeRefOrGetter<CatalogRecordsQuery | undefined>,
) => {
  const path = computed(() => `${resource}/${toValue(id)}`);
  const { requestUrl, dataKey } = useCatalogRequestContext(server);
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
) => {
  const config = useRuntimeConfig();
  const { assetServer } = useAssetServer();
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
        assetServer.value,
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

  watch([() => toValue(key), assetServer], () => void load(), { immediate: true });
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
  server?: MaybeRefOrGetter<string | undefined>,
  query?: MaybeRefOrGetter<CatalogRecordsQuery | undefined>,
) => {
  const config = useRuntimeConfig();
  const { assetServer } = useAssetServer();
  const { locale } = useLocale();
  const catalogServer = computed(() => {
    const requested = server === undefined ? undefined : toValue(server);
    return normalizeAssetServer(requested === undefined ? assetServer.value : requested);
  });
  const data = shallowRef<Record<string, T>>({});
  const pending = ref(false);
  const error = shallowRef<unknown>();
  let requestVersion = 0;

  const normalizedIds = () =>
    [...new Set(toValue(ids).map(String).filter(Boolean))].sort((left, right) => left.localeCompare(right));
  const normalizedQuery = () => {
    const entries = new Map<string, string>();
    if (catalogServer.value === "bestdori") {
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
      const baseUrl = catalogApiUrl(config.public.apiBase, catalogServer.value, resource);
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
      catalogServer,
    ],
    () => void load(),
    { immediate: true },
  );
  return { data, pending, error, refresh: load };
};

export const useCatalogSelection = <T>(
  resource: string,
  id: MaybeRefOrGetter<string | number | undefined>,
  server?: MaybeRefOrGetter<string | undefined>,
) => {
  const config = useRuntimeConfig();
  const { assetServer } = useAssetServer();
  const { locale } = useLocale();
  const catalogServer = computed(() => {
    const requested = server === undefined ? undefined : toValue(server);
    return normalizeAssetServer(requested === undefined ? assetServer.value : requested);
  });
  const data = shallowRef<T>();
  const pending = ref(false);
  const error = shallowRef<unknown>();
  let requestVersion = 0;

  const load = async () => {
    const selected = toValue(id);
    const version = ++requestVersion;
    error.value = undefined;
    if (import.meta.server || selected === undefined || selected === null || selected === "") {
      data.value = undefined;
      pending.value = false;
      return;
    }
    data.value = undefined;
    pending.value = true;
    try {
      const query =
        catalogServer.value === "bestdori"
          ? `lang=${encodeURIComponent(locale.value)}&v=${encodeURIComponent(BESTDORI_CATALOG_VERSION)}`
          : "";
      const url = appendCatalogQuery(
        catalogApiUrl(config.public.apiBase, catalogServer.value, `${resource}/${selected}`),
        query,
      );
      const response = await catalogJson<T>(url);
      if (version === requestVersion) data.value = response;
    } catch (reason) {
      if (version === requestVersion) {
        data.value = undefined;
        error.value = reason;
      }
    } finally {
      if (version === requestVersion) pending.value = false;
    }
  };

  watch([() => toValue(id), catalogServer, locale], () => void load(), { immediate: true });
  return { data, pending, error, refresh: load };
};

export const recordValues = <T>(record: Record<string, T> | null | undefined): T[] => {
  // A proxy/CDN misconfiguration can return an HTML string with HTTP 200. Do
  // not turn every character of that document into a catalog row while the
  // caller is recovering from the bad response.
  if (!record || typeof record !== "object" || Array.isArray(record)) return [];
  return Object.values(record);
};
