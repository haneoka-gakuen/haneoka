// L3 — GEB
// Input: 公共文档 URL 和界面语言。
// Output: 扩展语言地址及其英文内容地址。
// Pos: [Map](L2-2.md)；区分界面语言路由和静态内容路由。
// Effects/Dependencies: Worker 与浏览器共用纯路径和链接转换。
import groups from "../config/interface-share.json" with { type: "json" };
import { isSiteOrigin } from "../lib/site-origin.ts";
import { interfaceLanguages, type InterfaceLanguage, type InterfaceLanguageId } from "./interface-language-options.ts";

const interfaceById = new Map<string, InterfaceLanguage>(
  interfaceLanguages.map((language) => [language.value, language]),
);
const localePrefix = /^(\/(?:(?:jp|intl)\/)?)((?:[a-z]{2})(?:-[A-Z]{2})?)(?=\/|[?#]|$)/u;

function languageSegment(path: string): number {
  if (path[0] !== "/") return 0;
  const start = path.startsWith("/jp/") ? 4 : path.startsWith("/intl/") ? 6 : 1;
  const boundary = path[start + 2];
  return boundary === undefined || boundary === "/" || boundary === "?" || boundary === "#" ? start : 0;
}

export function interfaceLanguageFromPath(path: string): InterfaceLanguage | undefined {
  const start = languageSegment(path);
  return start ? interfaceById.get(path.slice(start, start + 2)) : undefined;
}

export function englishInterfacePath(path: string): string {
  const start = languageSegment(path);
  return start && interfaceById.has(path.slice(start, start + 2))
    ? path.slice(0, start) + "en" + path.slice(start + 2)
    : path;
}

export function interfacePath(path: string, locale: InterfaceLanguageId): string {
  const start = languageSegment(path);
  if (!start) return path;
  const source = path.slice(start, start + 2);
  return source === "en" || interfaceById.has(source)
    ? path.slice(0, start) + locale + path.slice(start + 2)
    : path;
}

/** Links already addressed to a particular language keep that language. */
function localizeEnglishLink(path: string, locale: InterfaceLanguageId): string {
  const start = languageSegment(path);
  return start && path[start] === "e" && path[start + 1] === "n"
    ? path.slice(0, start) + locale + path.slice(start + 2)
    : path;
}

export function interfaceHref(value: string, locale: InterfaceLanguageId, sourceOrigin: string): string {
  if (value[0] === "/" && value[1] !== "/") return localizeEnglishLink(value, locale);
  if (!value.startsWith("//") && !value.startsWith("https://") && !value.startsWith("http://")) return value;
  try {
    const url = new URL(value, sourceOrigin);
    if (url.origin !== sourceOrigin && !isSiteOrigin(url.origin)) return value;
    const path = localizeEnglishLink(url.pathname, locale);
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
