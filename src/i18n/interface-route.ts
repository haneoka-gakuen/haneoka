// L3 — GEB
// Input: 公共文档 URL 和界面语言。
// Output: 扩展语言地址及其英文内容地址。
// Pos: [Map](L2-2.md)；区分界面语言路由和静态内容路由。
// Effects/Dependencies: Worker 与浏览器共用纯路径和链接转换。
import groups from "../config/interface-share.json";
import { isSiteOrigin } from "../lib/site-origin";
import { interfaceLanguages, type InterfaceLanguage, type InterfaceLanguageId } from "./interface-language-options";

const interfaceById = new Map<string, InterfaceLanguage>(
  interfaceLanguages.map((language) => [language.value, language]),
);
const localePrefix = /^(\/(?:(?:jp|intl)\/)?)((?:[a-z]{2})(?:-[A-Z]{2})?)(?=\/|[?#]|$)/u;

export function interfaceLanguageFromPath(path: string): InterfaceLanguage | undefined {
  const locale = localePrefix.exec(path)?.[2];
  return locale ? interfaceById.get(locale) : undefined;
}

export function englishInterfacePath(path: string): string {
  return interfaceLanguageFromPath(path) ? path.replace(localePrefix, "$1en") : path;
}

export function interfacePath(path: string, locale: InterfaceLanguageId): string {
  return englishInterfacePath(path).replace(localePrefix, (match, prefix: string, source: string) =>
    source === "en" ? prefix + locale : match,
  );
}

export function interfaceHref(value: string, locale: InterfaceLanguageId, sourceOrigin: string): string {
  if (!value.startsWith("/") && !value.startsWith("https://") && !value.startsWith("http://")) return value;
  if (/^\/[^/]/u.test(value)) return interfaceLanguageFromPath(value) ? value : interfacePath(value, locale);
  try {
    const url = new URL(value, sourceOrigin);
    if (url.origin !== sourceOrigin && !isSiteOrigin(url.origin)) return value;
    if (interfaceLanguageFromPath(url.pathname)) return value;
    const path = interfacePath(url.pathname, locale);
    if (path === url.pathname) return value;
    url.pathname = path;
    return url.href;
  } catch {
    return value;
  }
}

export function interfaceSocialGroup(path: string): string {
  const logical = englishInterfacePath(path).replace(localePrefix, "").replace(/\/$/u, "");
  let selected = "home";
  let length = 0;
  for (const [id, { paths }] of Object.entries(groups)) {
    for (const prefix of paths) {
      if (prefix.length > length && (logical === prefix || logical.startsWith(`${prefix}/`))) {
        length = prefix.length;
        selected = id;
      }
    }
  }
  return selected;
}
