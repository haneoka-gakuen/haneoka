import { createHash } from "node:crypto";
import {
  createCatalog,
  mergeMessageNodes,
  type Catalog,
  type I18nSeed,
  type MessageCatalog,
  type MessageCatalogs,
  type MessageParams,
  type UiLocale,
  type TranslationShape,
} from "@haneoka/i18n";
import ja from "../../public/i18n/ja.json";
import en from "../../public/i18n/en.json";
import ko from "../../public/i18n/ko.json";
import zhCN from "../../public/i18n/zh-CN.json";
import zhTW from "../../public/i18n/zh-TW.json";
import { CATALOG_I18N_NAMESPACE, COMMON_I18N_NAMESPACE, isI18nNamespace } from "./keys";
import {
  extractNamespace,
  namespaceDependencyClosure,
  featureNamespaceForRoute,
  missingFallbackNamespace,
  requiredNamespacesForRoute,
  I18N_NAMESPACES,
  type MainI18nNamespace,
} from "./namespaces";

const canonicalCatalogs = { ja, en, ko, "zh-CN": zhCN, "zh-TW": zhTW } satisfies Record<UiLocale, TranslationShape<typeof ja>>;

const serverCatalogs: MessageCatalogs = Object.freeze(canonicalCatalogs);

/** Version the delivered namespace content, including its dependency closure. */
export const I18N_CONTENT_VERSION = `content-${createHash("sha256")
  .update(
    JSON.stringify(
      Object.entries(serverCatalogs)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([locale, catalog]) => [
          locale,
          Object.fromEntries(I18N_NAMESPACES.map((namespace) => [namespace, extractNamespace(catalog, namespace)])),
        ]),
    ),
  )
  .digest("hex")}`;
const fullCatalogCache = new Map<UiLocale, Catalog>();

type MainI18nSeed = I18nSeed & {
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

const normalizeNamespaces = (value: readonly string[]): readonly MainI18nNamespace[] => {
  const uniqueStrings = [...new Set(value)];
  if (!uniqueStrings.length || uniqueStrings.some((namespace) => !isI18nNamespace(namespace))) {
    throw new TypeError(
      `Unsupported i18n namespace: ${uniqueStrings.find((namespace) => !isI18nNamespace(namespace)) ?? ""}`,
    );
  }
  const unique = uniqueStrings as MainI18nNamespace[];
  return namespaceDependencyClosure(unique);
};

export interface ServerI18nContextOptions {
  readonly route?: string;
  readonly namespaces?: readonly string[];
}

export type ServerI18nContextRequest = string | readonly string[] | ServerI18nContextOptions;

const namespacesForRequest = (request?: ServerI18nContextRequest): readonly MainI18nNamespace[] => {
  if (request === undefined) return requiredNamespacesForRoute("/catalog");
  if (typeof request !== "string" && Array.isArray(request)) return normalizeNamespaces(request);
  if (typeof request === "string") {
    return request.startsWith("/") ? requiredNamespacesForRoute(request) : normalizeNamespaces([request]);
  }
  const options = request as ServerI18nContextOptions;
  if (options.namespaces) return normalizeNamespaces(options.namespaces);
  return requiredNamespacesForRoute(options.route ?? "/catalog");
};

const namespaceProjection = (
  locale: UiLocale,
  namespaces: readonly MainI18nNamespace[],
): {
  preferred: MessageCatalog;
  fallback: MessageCatalog;
  seedNamespaces: Record<string, MessageCatalog>;
  fallbackNamespaces: Record<string, MessageCatalog>;
} => {
  const preferredSource = serverCatalogs[locale] ?? {};
  const fallbackSource = serverCatalogs.ja ?? {};
  const preferredTrees = namespaces.map((namespace) => extractNamespace(preferredSource, namespace));
  const fallbackTrees = namespaces.map((namespace) => extractNamespace(fallbackSource, namespace));
  const preferred = mergeTrees(preferredTrees);
  const fallback = locale === "ja" ? {} : mergeTrees(fallbackTrees);
  const seedNamespaces: Record<string, MessageCatalog> = {};
  const fallbackNamespaces: Record<string, MessageCatalog> = {};
  for (let index = 0; index < namespaces.length; index += 1) {
    const namespace = namespaces[index]!;
    const target = preferredTrees[index]!;
    const fallbackTree = fallbackTrees[index]!;
    seedNamespaces[namespace] = freeze(target);
    if (locale !== "ja") {
      const missing = missingFallbackNamespace(target, fallbackTree);
      if (Object.keys(missing).length) fallbackNamespaces[namespace] = freeze(missing);
    }
  }
  return { preferred, fallback, seedNamespaces, fallbackNamespaces };
};

export interface I18nNamespaceBundle extends I18nSeed {
  readonly requiredNamespaces: readonly MainI18nNamespace[];
  readonly namespaces: Readonly<Record<MainI18nNamespace, MessageCatalog>>;
  readonly fallbacks?: Readonly<Record<MainI18nNamespace, MessageCatalog>>;
}

/** The static runtime payload for one feature, with common shell copy included. */
export const createI18nNamespaceBundle = (locale: UiLocale, namespace: string): I18nNamespaceBundle => {
  const namespaces = normalizeNamespaces([namespace]);
  const projection = namespaceProjection(locale, namespaces);
  return {
    version: I18N_CONTENT_VERSION,
    locale,
    requiredNamespaces: namespaces,
    namespaces: projection.seedNamespaces as Readonly<Record<MainI18nNamespace, MessageCatalog>>,
    ...(Object.keys(projection.fallbackNamespaces).length
      ? { fallbacks: projection.fallbackNamespaces as Readonly<Record<MainI18nNamespace, MessageCatalog>> }
      : {}),
  };
};

export interface ServerI18nContext {
  readonly locale: UiLocale;
  readonly namespaces: readonly MainI18nNamespace[];
  readonly catalog: Catalog;
  seed(route?: string): MainI18nSeed;
}

const contextCache = new Map<string, ServerI18nContext>();
const serializedSeeds = new WeakMap<object, string>();

export const createServerI18nContext = (locale: UiLocale, request?: ServerI18nContextRequest): ServerI18nContext => {
  const namespaces = namespacesForRequest(request);
  const key = `${locale}:${namespaces.join(",")}`;
  const cached = contextCache.get(key);
  if (cached) return cached;
  const projection = namespaceProjection(locale, namespaces);
  const catalog = createCatalog(locale, {
    [locale]: projection.preferred,
    ...(locale === "ja" ? {} : { ja: projection.fallback }),
  });
  const seed: MainI18nSeed = {
    version: I18N_CONTENT_VERSION,
    locale,
    requiredNamespaces: namespaces,
    namespaces: projection.seedNamespaces,
    ...(Object.keys(projection.fallbackNamespaces).length ? { fallbacks: projection.fallbackNamespaces } : {}),
  };
  const context: ServerI18nContext = {
    locale,
    namespaces: [...namespaces],
    catalog,
    seed: (route?: string) => (route === undefined ? seed : createServerI18nContext(locale, route).seed()),
  };
  contextCache.set(key, context);
  return context;
};

export const serializeI18nSeed = (seed: I18nSeed): string => {
  const cached = serializedSeeds.get(seed);
  if (cached) return cached;
  const serialized = JSON.stringify(seed)
    .replace(/</gu, "\\u003C")
    .replace(/\u2028/gu, "\\u2028")
    .replace(/\u2029/gu, "\\u2029");
  serializedSeeds.set(seed, serialized);
  return serialized;
};

const getFullCatalog = (locale: UiLocale): Catalog => {
  const cached = fullCatalogCache.get(locale);
  if (cached) return cached;
  const catalog = createCatalog(locale, serverCatalogs);
  fullCatalogCache.set(locale, catalog);
  return catalog;
};

/** Standalone server lookup over the authoritative source, with no per-key tree merge. */
export const serverMessage = (locale: UiLocale, key: string, params?: MessageParams, fallback = key) => {
  const message = getFullCatalog(locale).resolve(key, params);
  return message.fallbackReason === "missing" ? { ...message, text: fallback } : message;
};

export const serverText = (locale: UiLocale, key: string, params?: MessageParams, fallback = key): string =>
  serverMessage(locale, key, params, fallback).text;

export const serverGroup = <T = MessageCatalog>(locale: UiLocale, key: string): T =>
  getFullCatalog(locale).group<T>(key) ?? {} as T;

export { CATALOG_I18N_NAMESPACE, COMMON_I18N_NAMESPACE, featureNamespaceForRoute, requiredNamespacesForRoute };
