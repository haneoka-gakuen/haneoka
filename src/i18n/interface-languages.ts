// L3 — GEB
// Input: Browser language choice and the English document catalog.
// Output: A lazily loaded interface catalog retaining the English content locale.
// Pos: [Map](L2-2.md); extra interface languages share the English documents.
// Effects/Dependencies: Loads one immutable catalog chunk and stores the preference in the browser.
import {
  interpolateMessage,
  mergeMessageNodes,
  messageAtPath,
  messageNodeAtPath,
  scriptForLanguageTag,
  type Catalog,
  type MessageCatalog,
  type MessageParams,
  type MessageTree,
} from "@haneoka/i18n";

import {
  interfaceLanguages,
  SHARE_LANGUAGE_STORAGE_KEY,
  type InterfaceLanguage,
  type InterfaceLanguageId,
} from "./interface-language-options";
export { interfaceLanguages, type InterfaceLanguageId } from "./interface-language-options";

export const INTERFACE_LANGUAGE_EVENT = "haneoka:interface-language";
const STORAGE_KEY = "haneoka.interface-language";
const sources = import.meta.glob<MessageCatalog>("./interface/*.json", { import: "default" });

export function readInterfaceLanguage(): InterfaceLanguage | undefined {
  try {
    const value = sessionStorage.getItem(SHARE_LANGUAGE_STORAGE_KEY) || localStorage.getItem(STORAGE_KEY);
    return interfaceLanguages.find((language) => language.value === value);
  } catch {
    return undefined;
  }
}

export function writeInterfaceLanguage(value?: InterfaceLanguageId): void {
  try {
    sessionStorage.removeItem(SHARE_LANGUAGE_STORAGE_KEY);
    if (value) localStorage.setItem(STORAGE_KEY, value);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // In-place changes still work when storage is blocked.
  }
  window.dispatchEvent(new CustomEvent(INTERFACE_LANGUAGE_EVENT, { detail: value }));
}

export async function loadInterfaceLanguage(language: InterfaceLanguage): Promise<MessageCatalog> {
  return sources[`./interface/${language.value}.json`]!();
}

export function localizedInterfaceCatalog(
  base: Catalog,
  language: InterfaceLanguage,
  messages: MessageCatalog,
): Catalog {
  const lang = language.tag;
  const script = scriptForLanguageTag(lang);
  const resolve = (key: string, params?: MessageParams) => {
    const translation = messageAtPath(messages, key);
    if (translation === undefined) return base.resolve(key, params);
    return {
      key,
      text: interpolateMessage(translation, params),
      requestedLocale: base.locale,
      sourceLocale: base.locale,
      lang,
      script,
      isFallback: false,
      fallbackReason: "none" as const,
    };
  };
  const pluralRules = new Intl.PluralRules(lang);
  return {
    locale: base.locale,
    resolve,
    text: (key, params, fallback = key) => {
      const result = resolve(key, params);
      return result.fallbackReason === "missing" ? fallback : result.text;
    },
    plural: (key, count, params) => {
      const category = pluralRules.select(count);
      const localizedKey = `${key}.${category}`;
      const candidate = messageAtPath(messages, localizedKey) !== undefined ? localizedKey : key;
      if (messageAtPath(messages, candidate) === undefined) return base.plural(key, count, params);
      const values = Array.isArray(params) ? params : { ...(params || {}), count };
      return { ...resolve(candidate, values), key };
    },
    has: (key) => messageAtPath(messages, key) !== undefined || base.has(key),
    group: <T = MessageTree>(path: string) =>
      mergeMessageNodes(base.group(path), messageNodeAtPath(messages, path)) as T | undefined,
  };
}
