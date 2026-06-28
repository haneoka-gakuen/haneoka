import {
  isMessageCatalog,
  resolveUiMessage,
  resolveUiMessageNode,
  type MessageCatalogs,
  type MessageGroupKey,
  type MessageParams,
  type MessagePath,
  type TranslationShape,
} from "@haneoka/i18n/messages";
import { shallowReactive } from "vue";

import type { ArchiveLocale } from "../locales";
import ja from "./ja.json";
import type en from "../../../public/i18n/en.json";
import type ko from "../../../public/i18n/ko.json";
import type zhCN from "../../../public/i18n/zh-CN.json";
import type zhTW from "../../../public/i18n/zh-TW.json";

export type ArchiveMessageSchema = TranslationShape<typeof ja>;
export type ArchiveMessageKey = MessagePath<ArchiveMessageSchema>;
export type ArchiveMessageGroupKey = MessageGroupKey<ArchiveMessageSchema>;
export type ArchiveMessageParams = MessageParams;

type MessageLoader = () => Promise<ArchiveMessageSchema>;

const messageUrls = {
  en: "/i18n/en.json",
  "zh-TW": "/i18n/zh-TW.json",
  "zh-CN": "/i18n/zh-CN.json",
  ko: "/i18n/ko.json",
} as const;

const fetchMessageCatalog = async <Catalog extends ArchiveMessageSchema>(url: string): Promise<Catalog> => {
  const response = await fetch(url, {
    // Locale payloads are a small, versioned part of the UI contract. A
    // force-cache hit can retain an older catalog after deployment, leaving
    // only recently added nested copy (such as story navigation labels) in
    // Japanese while the rest of the UI is already localized. Revalidate once
    // per locale/session instead; `loadArchiveMessages` still deduplicates and
    // memoizes the request in memory.
    cache: "no-cache",
    credentials: "same-origin",
    headers: { accept: "application/json" },
  });
  if (!response.ok) throw new Error(`Locale catalog request failed (${response.status})`);

  const value: unknown = await response.json();
  if (!isMessageCatalog(value)) throw new TypeError("Locale catalog is not a message tree");
  return value as Catalog;
};

const messageLoaders = {
  en: () => fetchMessageCatalog<TranslationShape<typeof en>>(messageUrls.en),
  "zh-TW": () => fetchMessageCatalog<TranslationShape<typeof zhTW>>(messageUrls["zh-TW"]),
  "zh-CN": () => fetchMessageCatalog<TranslationShape<typeof zhCN>>(messageUrls["zh-CN"]),
  ko: () => fetchMessageCatalog<TranslationShape<typeof ko>>(messageUrls.ko),
} satisfies Partial<Record<ArchiveLocale, MessageLoader>>;

export const archiveMessages = shallowReactive<Partial<Record<ArchiveLocale, ArchiveMessageSchema>>>({ ja });

const pendingLoads = new Map<ArchiveLocale, Promise<ArchiveMessageSchema>>();

export const loadArchiveMessages = (locale: ArchiveLocale): Promise<ArchiveMessageSchema> => {
  const loaded = archiveMessages[locale];
  if (loaded) return Promise.resolve(loaded);

  const pending = pendingLoads.get(locale);
  if (pending) return pending;

  const loader = (messageLoaders as Partial<Record<ArchiveLocale, MessageLoader>>)[locale];
  if (!loader) return Promise.resolve(ja);

  const request = loader()
    .then((messages) => {
      archiveMessages[locale] = messages;
      return messages;
    })
    .finally(() => pendingLoads.delete(locale));
  pendingLoads.set(locale, request);
  return request;
};

const catalogs = archiveMessages as MessageCatalogs;

export const archiveMessage = (locale: ArchiveLocale, key: ArchiveMessageKey, params?: ArchiveMessageParams): string =>
  resolveUiMessage(catalogs, locale, key, params);

export const archiveMessageGroup = <Key extends ArchiveMessageGroupKey>(
  locale: ArchiveLocale,
  key: Key,
): ArchiveMessageSchema[Key] => resolveUiMessageNode(catalogs, locale, key) as ArchiveMessageSchema[Key];
