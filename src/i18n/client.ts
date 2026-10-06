import {
  createCatalog,
  isLocale,
  isMessageCatalog,
  mergeMessageNodes,
  normalizeLocale,
  type Catalog,
  type I18nSeed,
  type MessageCatalog,
  type MessageCatalogs,
  type MessageParams,
  type UiLocale,
} from "@haneoka/i18n";
import { COMMON_I18N_NAMESPACE, I18N_NAMESPACES, UNSEEDED_I18N_VERSION, catalogLookupKeys } from "./keys";

const SEED_ID = "haneoka-i18n-seed";
const LOCALE_READY_EVENT = "haneoka:locale-ready";

export interface I18nClientOptions {
  readonly version?: string;
  readonly seed?: I18nSeed | null;
  readonly namespaces?: readonly string[];
  readonly load?: (locale: UiLocale, namespace: string, signal: AbortSignal) => Promise<MessageCatalog>;
}

export type MainI18nSeed = I18nSeed & {
  readonly requiredNamespaces?: readonly string[];
  readonly fallbacks?: Readonly<Record<string, MessageCatalog>>;
};

const freeze = <T>(value: T): T => {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
  return Object.freeze(value);
};

const mergeTrees = (trees: readonly MessageCatalog[]): MessageCatalog => {
  let merged: MessageCatalog = {};
  for (const tree of trees) {
    const next = mergeMessageNodes(merged, tree);
    if (next && typeof next === "object" && !Array.isArray(next)) merged = next as MessageCatalog;
  }
  return freeze(merged);
};

const abortError = (): DOMException => new DOMException("The i18n request was aborted", "AbortError");

const linkAbortSignal = (source: AbortSignal | undefined, target: AbortController): (() => void) => {
  if (!source) return () => {};
  const abort = () => target.abort();
  if (source.aborted) abort();
  else source.addEventListener("abort", abort, { once: true });
  return () => source.removeEventListener("abort", abort);
};

interface ParsedSeed extends MainI18nSeed {
  readonly fallbacks: Readonly<Record<string, MessageCatalog>>;
}

const parseSeed = (value: unknown): ParsedSeed | null => {
  if (!value || typeof value !== "object") return null;
  const seed = value as Partial<MainI18nSeed>;
  if (
    !isLocale(seed.locale) ||
    typeof seed.version !== "string" ||
    !seed.namespaces ||
    typeof seed.namespaces !== "object"
  ) {
    return null;
  }
  const namespaces: Record<string, MessageCatalog> = {};
  for (const [namespace, catalog] of Object.entries(seed.namespaces)) {
    if (!isMessageCatalog(catalog)) return null;
    namespaces[namespace] = freeze(catalog);
  }
  if (!Object.keys(namespaces).length) return null;
  const fallbacks: Record<string, MessageCatalog> = {};
  if (seed.fallbacks !== undefined) {
    if (!seed.fallbacks || typeof seed.fallbacks !== "object") return null;
    for (const [namespace, catalog] of Object.entries(seed.fallbacks)) {
      if (!isMessageCatalog(catalog)) return null;
      fallbacks[namespace] = freeze(catalog);
    }
  }
  const requiredNamespaces = seed.requiredNamespaces ? [...seed.requiredNamespaces] : Object.keys(namespaces);
  if (
    !requiredNamespaces.length ||
    requiredNamespaces.some((namespace) => typeof namespace !== "string" || !namespaces[namespace])
  ) {
    return null;
  }
  return {
    version: seed.version,
    locale: seed.locale,
    namespaces,
    requiredNamespaces,
    fallbacks,
  };
};

export const readI18nSeed = (document: Document = globalThis.document): ParsedSeed | null => {
  // Server renderers may expose a document shim without element lookup.
  if (typeof document?.getElementById !== "function") return null;
  const element = document.getElementById(SEED_ID);
  if (!element?.textContent) return null;
  try {
    return parseSeed(JSON.parse(element.textContent));
  } catch {
    return null;
  }
};

interface I18nNamespaceBundle {
  readonly version: string;
  readonly locale: UiLocale;
  readonly requiredNamespaces: readonly string[];
  readonly namespaces: Readonly<Record<string, MessageCatalog>>;
  readonly fallbacks?: Readonly<Record<string, MessageCatalog>>;
}

interface SharedRequest<T> {
  readonly controller: AbortController;
  readonly promise: Promise<T>;
  waiters: number;
  settled: boolean;
  invalidated: boolean;
}

export class MainI18nClient {
  private catalogVersion: string;
  private readonly allowedNamespaces: ReadonlySet<string>;
  private readonly loader: I18nClientOptions["load"];
  /** Partial route seeds live here; they are never treated as the raw JSON. */
  private readonly namespaceCache = new Map<string, MessageCatalog>();
  private readonly fallbackCache = new Map<string, MessageCatalog>();
  /** Custom loaders share one cancellable request per locale/namespace/version. */
  private readonly namespaceInFlight = new Map<string, SharedRequest<MessageCatalog>>();
  /** The default loader shares one static common+feature bundle per locale/version. */
  private readonly bundleInFlight = new Map<string, SharedRequest<I18nNamespaceBundle>>();
  private readonly listeners = new Set<(catalog: Catalog) => void>();
  private currentCatalog: Catalog;
  private currentLocale: UiLocale;
  private pendingLocale: UiLocale | null = null;
  private requiredNamespaces: readonly string[];
  private generation = 0;
  private activeLocaleRequest?: AbortController;
  private readyPromise?: Promise<Catalog>;

  constructor(options: I18nClientOptions = {}) {
    const seed = options.seed === undefined ? readI18nSeed() : parseSeed(options.seed);
    this.catalogVersion = options.version || seed?.version || UNSEEDED_I18N_VERSION;
    this.allowedNamespaces = new Set(options.namespaces || [...I18N_NAMESPACES]);
    this.loader = options.load;
    const documentLocale = typeof document === "undefined" ? undefined : document.documentElement?.dataset?.locale;
    this.currentLocale = seed?.locale || normalizeLocale(documentLocale);
    const initialNamespaces = seed?.requiredNamespaces?.length
      ? seed.requiredNamespaces
      : options.namespaces?.length
        ? options.namespaces
        : [COMMON_I18N_NAMESPACE];
    this.requiredNamespaces = this.validateNamespaces(initialNamespaces);
    this.currentCatalog = createCatalog(this.currentLocale, {});

    if (seed && seed.version === this.version && this.acceptsSeed(seed)) {
      this.installSeed(seed);
      this.currentCatalog = this.catalogFromSeed(seed);
      // The first paint is synchronously backed by the seed; ready() must not fetch.
      this.readyPromise = Promise.resolve(this.currentCatalog);
    }
  }

  get version(): string {
    return this.catalogVersion;
  }

  get committed(): UiLocale {
    return this.currentLocale;
  }

  get pending(): UiLocale | null {
    return this.pendingLocale;
  }

  get namespaces(): readonly string[] {
    return this.requiredNamespaces;
  }

  current(): Catalog {
    return this.currentCatalog;
  }

  /** Adopt the next Astro document before its custom elements connect. */
  adoptSeed(value: I18nSeed): boolean {
    const seed = parseSeed(value);
    if (!seed || !this.acceptsSeed(seed)) return false;
    this.generation += 1;
    this.activeLocaleRequest?.abort();
    this.activeLocaleRequest = undefined;
    if (seed.version !== this.version) {
      this.catalogVersion = seed.version;
      this.namespaceCache.clear();
      this.fallbackCache.clear();
    }
    this.installSeed(seed);
    this.requiredNamespaces = [...(seed.requiredNamespaces || Object.keys(seed.namespaces))];
    const catalog = this.catalogFromSeed(seed);
    this.readyPromise = Promise.resolve(catalog);
    return this.commit(catalog, this.generation);
  }

  async ready(): Promise<Catalog> {
    if (!this.readyPromise) {
      const request = this.generation;
      const required = this.requiredNamespaces;
      this.readyPromise = this.ensure(this.currentLocale, required).then((catalog) => {
        if (request === this.generation) this.commit(catalog, request);
        return this.currentCatalog;
      });
      const pending = this.readyPromise;
      // Do not create an unhandled rejected finally/follow-up promise.
      void pending.catch(() => {
        if (this.readyPromise === pending) this.readyPromise = undefined;
      });
    }
    return this.readyPromise;
  }

  subscribe(listener: (catalog: Catalog) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async ensure(locale: UiLocale, namespaces: readonly string[], signal?: AbortSignal): Promise<Catalog> {
    if (signal?.aborted) throw abortError();
    if (!isLocale(locale)) throw new Error(`Unsupported UI locale: ${String(locale)}`);
    const requestedNamespaces = this.validateNamespaces(namespaces);
    const requestVersion = this.version;
    const loaded = await Promise.all(
      requestedNamespaces.map(async (namespace) => {
        const bundleNamespace = this.bundleNamespaceFor(requestedNamespaces, namespace);
        const preferredPromise = this.loadCatalog(locale, namespace, requestVersion, signal, bundleNamespace);
        if (locale === "ja") return { preferred: await preferredPromise, fallback: undefined };
        const cacheKey = this.cacheKey(locale, namespace, requestVersion);
        const seededFallback = this.fallbackCache.get(cacheKey);
        if (this.loader) {
          const [preferred, fallback] = await Promise.all([
            preferredPromise,
            seededFallback ?? this.loadCatalog("ja", namespace, requestVersion, signal, bundleNamespace),
          ]);
          return { preferred, fallback };
        }
        const preferred = await preferredPromise;
        const fallback =
          this.fallbackCache.get(cacheKey) ??
          (await this.loadCatalog("ja", namespace, requestVersion, signal, bundleNamespace));
        return { preferred, fallback };
      }),
    );
    if (signal?.aborted) throw abortError();
    const preferred = mergeTrees(loaded.map(({ preferred }) => preferred));
    const fallback = mergeTrees(loaded.flatMap(({ fallback }) => (fallback ? [fallback] : [])));
    const catalogs: MessageCatalogs = {
      [locale]: preferred,
      ...(locale === "ja" ? {} : { ja: fallback }),
    };
    return createCatalog(locale, catalogs);
  }

  async requestLocale(
    locale: UiLocale,
    namespaces: readonly string[] = this.requiredNamespaces,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (!isLocale(locale)) throw new Error(`Unsupported UI locale: ${String(locale)}`);
    const requestedNamespaces = this.validateNamespaces(namespaces);
    const request = ++this.generation;
    this.activeLocaleRequest?.abort();
    const controller = new AbortController();
    this.activeLocaleRequest = controller;
    const unlink = linkAbortSignal(signal, controller);
    this.pendingLocale = locale;
    try {
      const catalog = await this.ensure(locale, requestedNamespaces, controller.signal);
      if (request !== this.generation || controller.signal.aborted) return false;
      this.requiredNamespaces = requestedNamespaces;
      return this.commit(catalog, request);
    } catch (error) {
      // A newer locale request or document seed owns the replacement lease.
      // Preserve the boolean stale-result contract; caller cancellation still
      // surfaces as AbortError to the DOM transition hook.
      if (controller.signal.aborted && !signal?.aborted) return false;
      throw error;
    } finally {
      unlink();
      controller.abort();
      if (this.activeLocaleRequest === controller) this.activeLocaleRequest = undefined;
      if (request === this.generation) this.pendingLocale = null;
    }
  }

  commit(catalog: Catalog, request = this.generation): boolean {
    if (request !== this.generation) return false;
    this.currentCatalog = catalog;
    this.currentLocale = catalog.locale;
    this.pendingLocale = null;
    for (const listener of this.listeners) listener(catalog);
    if (typeof globalThis.dispatchEvent === "function") globalThis.dispatchEvent(new CustomEvent(LOCALE_READY_EVENT));
    return true;
  }

  private acceptsSeed(seed: ParsedSeed): boolean {
    const names = Object.keys(seed.namespaces);
    return (
      names.length > 0 &&
      names.every((namespace) => this.allowedNamespaces.has(namespace)) &&
      Object.keys(seed.fallbacks).every((namespace) => this.allowedNamespaces.has(namespace)) &&
      (seed.requiredNamespaces || names).every(
        (namespace) => this.allowedNamespaces.has(namespace) && names.includes(namespace),
      )
    );
  }

  private installSeed(seed: ParsedSeed): void {
    for (const [namespace, catalog] of Object.entries(seed.namespaces)) {
      this.namespaceCache.set(this.cacheKey(seed.locale, namespace), catalog);
      if (seed.locale !== "ja")
        this.fallbackCache.set(this.cacheKey(seed.locale, namespace), seed.fallbacks[namespace] || {});
    }
  }

  private catalogFromSeed(seed: ParsedSeed): Catalog {
    const preferred = mergeTrees(Object.values(seed.namespaces));
    const fallback = mergeTrees(Object.values(seed.fallbacks));
    return createCatalog(seed.locale, {
      [seed.locale]: preferred,
      ...(seed.locale === "ja" ? {} : { ja: fallback }),
    });
  }

  private validateNamespaces(namespaces: readonly string[]): readonly string[] {
    const requestedNamespaces = [...new Set(namespaces)];
    if (!requestedNamespaces.length) throw new Error("At least one i18n namespace is required");
    for (const namespace of requestedNamespaces) {
      if (!this.allowedNamespaces.has(namespace)) throw new Error(`Unsupported i18n namespace: ${namespace}`);
    }
    return requestedNamespaces;
  }

  private cacheKey(locale: UiLocale, namespace: string, version = this.version): string {
    return `${version}:${locale}:${namespace}`;
  }

  private bundleNamespaceFor(namespaces: readonly string[], namespace: string): string {
    if (namespace !== COMMON_I18N_NAMESPACE) return namespace;
    return namespaces.find((candidate) => candidate !== COMMON_I18N_NAMESPACE) ?? COMMON_I18N_NAMESPACE;
  }

  private acquireShared<T>(
    map: Map<string, SharedRequest<T>>,
    key: string,
    factory: (signal: AbortSignal) => Promise<T>,
    signal: AbortSignal | undefined,
    onResolve?: (value: T) => void,
  ): Promise<T> {
    let entry = map.get(key);
    if (!entry) {
      const controller = new AbortController();
      let promise: Promise<T>;
      try {
        promise = Promise.resolve(factory(controller.signal));
      } catch (error) {
        promise = Promise.reject(error);
      }
      entry = { controller, promise, waiters: 0, settled: false, invalidated: false };
      map.set(key, entry);
      const owned = entry;
      void promise.then(
        (value) => {
          owned.settled = true;
          if (!owned.invalidated && map.get(key) === owned) onResolve?.(value);
          if (map.get(key) === owned) map.delete(key);
        },
        () => {
          owned.settled = true;
          if (map.get(key) === owned) map.delete(key);
        },
      );
    }

    const owned = entry;
    owned.waiters += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      owned.waiters -= 1;
      if (owned.waiters === 0 && !owned.settled) {
        owned.invalidated = true;
        if (map.get(key) === owned) map.delete(key);
        owned.controller.abort();
      }
    };

    const promise = new Promise<T>((resolve, reject) => {
      if (signal?.aborted) {
        release();
        reject(abortError());
        return;
      }
      const abort = () => {
        release();
        reject(abortError());
      };
      signal?.addEventListener("abort", abort, { once: true });
      owned.promise.then(
        (value) => {
          signal?.removeEventListener("abort", abort);
          release();
          resolve(value);
        },
        (error: unknown) => {
          signal?.removeEventListener("abort", abort);
          release();
          reject(error);
        },
      );
    });
    return promise;
  }

  private loadCatalog(
    locale: UiLocale,
    namespace: string,
    version = this.version,
    signal?: AbortSignal,
    bundleNamespace = namespace,
  ): Promise<MessageCatalog> {
    const key = this.cacheKey(locale, namespace, version);
    const cached = this.namespaceCache.get(key);
    if (cached) return Promise.resolve(cached);
    if (signal?.aborted) return Promise.reject(abortError());

    if (this.loader) {
      const loader = this.loader;
      return this.acquireShared(
        this.namespaceInFlight,
        key,
        (requestSignal) => loader(locale, namespace, requestSignal).then((catalog) => freeze(catalog)),
        signal,
        (catalog) => this.namespaceCache.set(key, catalog),
      );
    }

    if (version === UNSEEDED_I18N_VERSION) {
      return Promise.reject(new Error("Default i18n loading requires a versioned SSR seed or explicit version"));
    }
    const bundleKey = `${version}:${locale}:${bundleNamespace}`;
    const pending = this.acquireShared(
      this.bundleInFlight,
      bundleKey,
      (requestSignal) => this.loadNamespaceBundle(locale, bundleNamespace, version, requestSignal),
      signal,
      (bundle) => this.cacheNamespaceBundle(bundle, version),
    );
    return pending.then((bundle) => {
      const catalog = bundle.namespaces[namespace];
      if (!catalog) throw new Error(`i18n bundle is missing namespace: ${namespace}`);
      return catalog;
    });
  }

  private cacheNamespaceBundle(bundle: I18nNamespaceBundle, version: string): void {
    for (const [namespace, catalog] of Object.entries(bundle.namespaces)) {
      const key = this.cacheKey(bundle.locale, namespace, version);
      this.namespaceCache.set(key, catalog);
      if (bundle.locale !== "ja") this.fallbackCache.set(key, bundle.fallbacks?.[namespace] || {});
    }
  }

  private loadNamespaceBundle(
    locale: UiLocale,
    namespace: string,
    version: string,
    signal: AbortSignal,
  ): Promise<I18nNamespaceBundle> {
    return fetch(
      `/i18n/${encodeURIComponent(version)}/${encodeURIComponent(locale)}/${encodeURIComponent(namespace)}.json`,
      {
        signal,
        headers: { accept: "application/json" },
        cache: "force-cache",
      },
    ).then(async (response) => {
      if (!response.ok) throw new Error(`i18n ${response.status}`);
      const value: unknown = await response.json();
      if (!value || typeof value !== "object") throw new Error(`Invalid i18n bundle: ${locale}/${namespace}`);
      const bundle = value as Partial<I18nNamespaceBundle>;
      if (
        bundle.version !== version ||
        bundle.locale !== locale ||
        !Array.isArray(bundle.requiredNamespaces) ||
        !bundle.namespaces ||
        typeof bundle.namespaces !== "object"
      ) {
        throw new Error(`Invalid i18n bundle metadata: ${locale}/${namespace}`);
      }
      if (
        bundle.requiredNamespaces.some((name) => typeof name !== "string" || !this.allowedNamespaces.has(name)) ||
        !bundle.requiredNamespaces.includes(namespace)
      ) {
        throw new Error(`Invalid i18n bundle namespace list: ${locale}/${namespace}`);
      }
      const namespaces: Record<string, MessageCatalog> = {};
      for (const [name, catalog] of Object.entries(bundle.namespaces)) {
        if (!this.allowedNamespaces.has(name)) throw new Error(`Unsupported i18n namespace: ${name}`);
        if (!isMessageCatalog(catalog)) throw new Error(`Invalid i18n namespace: ${locale}/${name}`);
        namespaces[name] = freeze(catalog);
      }
      if (bundle.requiredNamespaces.some((name) => !namespaces[name])) {
        throw new Error(`Invalid i18n bundle namespace payload: ${locale}/${namespace}`);
      }
      const fallbacks: Record<string, MessageCatalog> = {};
      if (bundle.fallbacks !== undefined) {
        if (!bundle.fallbacks || typeof bundle.fallbacks !== "object") {
          throw new Error(`Invalid i18n fallback metadata: ${locale}/${namespace}`);
        }
        for (const [name, catalog] of Object.entries(bundle.fallbacks)) {
          if (!this.allowedNamespaces.has(name)) throw new Error(`Unsupported i18n fallback namespace: ${name}`);
          if (!isMessageCatalog(catalog)) throw new Error(`Invalid i18n fallback: ${locale}/${name}`);
          fallbacks[name] = freeze(catalog);
        }
      }
      return {
        version,
        locale,
        requiredNamespaces: [...bundle.requiredNamespaces],
        namespaces,
        ...(Object.keys(fallbacks).length ? { fallbacks } : {}),
      };
    });
  }
}

let defaultClient: MainI18nClient | undefined;

export const initializeI18nClient = (options?: I18nClientOptions): MainI18nClient => {
  if (defaultClient) return defaultClient;
  defaultClient = new MainI18nClient(options);
  void defaultClient.ready().catch(() => undefined);
  return defaultClient;
};

export const getI18nClient = (): MainI18nClient | undefined => defaultClient;

const groupCache = new WeakMap<Catalog, Map<string, unknown>>();

export function clientGroup<T = Record<string, unknown>>(key: string): T {
  const catalog = initializeI18nClient().current();
  let groups = groupCache.get(catalog);
  if (!groups) groupCache.set(catalog, (groups = new Map()));
  if (!groups.has(key)) groups.set(key, catalog.group(key) ?? {});
  return groups.get(key) as T;
}

export const clientText = (locale: string, key: string, fallback = key, params?: MessageParams): string => {
  if (!isLocale(locale)) locale = "en";
  const client = initializeI18nClient();
  for (const candidate of catalogLookupKeys(key)) {
    const catalog = client.current();
    if (catalog.has(candidate)) return catalog.text(candidate, params, fallback);
  }
  return fallback;
};
