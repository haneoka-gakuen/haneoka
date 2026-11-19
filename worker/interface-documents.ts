// L3 — GEB
// Input: 新界面语言的文档请求及同一英文页面的响应。
// Output: 本地化 HTML、规范地址、链接与社交元数据。
// Pos: [Map](L2.md)；复用英文文档的界面语言适配器。
// Effects/Dependencies: 由原文档路径执行权限检查和缓存；只加载当前语言的词库。
import { interpolateMessage, messageAtPath, type MessageCatalog } from "@haneoka/i18n";
import {
  englishInterfacePath,
  interfaceHref,
  interfaceLanguageFromPath,
  interfaceSocialGroup,
} from "../src/i18n/interface-route.ts";
import type { InterfaceLanguage, InterfaceLanguageId } from "../src/i18n/interface-language-options";
import { formatDocumentTitle, withoutSiteSuffix } from "../src/lib/document-title";
import { CANONICAL_ORIGIN } from "../src/lib/site-origin";

const dictionaries: Record<InterfaceLanguageId, () => Promise<{ default: MessageCatalog }>> = {
  de: () => import("../src/i18n/interface/de.json"),
  es: () => import("../src/i18n/interface/es.json"),
  fr: () => import("../src/i18n/interface/fr.json"),
  id: () => import("../src/i18n/interface/id.json"),
  it: () => import("../src/i18n/interface/it.json"),
  pl: () => import("../src/i18n/interface/pl.json"),
  pt: () => import("../src/i18n/interface/pt.json"),
  ru: () => import("../src/i18n/interface/ru.json"),
  th: () => import("../src/i18n/interface/th.json"),
  vi: () => import("../src/i18n/interface/vi.json"),
};

interface InterfaceDocument {
  url: URL;
  request: Request;
  language: InterfaceLanguage;
}

export function interfaceDocument(request: Request): InterfaceDocument | undefined {
  if (request.method !== "GET" && request.method !== "HEAD") return;
  const url = new URL(request.url);
  const language = interfaceLanguageFromPath(url.pathname);
  if (!language) return;
  const source = new URL(url);
  source.pathname = englishInterfacePath(url.pathname);
  const headers = new Headers(request.headers);
  if (!source.pathname.endsWith(".md")) {
    headers.set("Accept-Encoding", "identity");
    for (const name of ["If-None-Match", "If-Modified-Since", "Range", "If-Range"]) headers.delete(name);
  }
  return { url, language, request: new Request(source, { headers, method: request.method }) };
}

export async function translateInterfaceDocument(document: InterfaceDocument, source: Response): Promise<Response> {
  const { url, language } = document;
  const link = (value: string) => interfaceHref(value, language.value, url.origin);
  const location = source.headers.get("Location");
  if (location && source.status >= 300 && source.status < 400) {
    const headers = new Headers(source.headers);
    headers.set("Location", link(location));
    return new Response(source.body, { headers, status: source.status });
  }
  if (!source.headers.get("Content-Type")?.includes("text/html")) return source;

  const headers = new Headers(source.headers);
  headers.set("Content-Language", language.tag);
  for (const name of ["Content-Encoding", "Content-Length", "ETag", "Last-Modified", "Accept-Ranges"])
    headers.delete(name);
  const response = new Response(source.body, { headers, status: source.status });
  if (!source.body) return response;

  const { default: catalog } = await dictionaries[language.value]();
  const message = (key: string | null) => (key ? messageAtPath(catalog, key) : undefined);
  const siteTitle = message("common.seo.siteTitle") ?? "BanG Dream! Our Notes Database";
  const englishPath = new URL(document.request.url).pathname;
  const home = /^\/(?:(?:jp|intl)\/)?en\/?$/u.test(englishPath);
  const titleText = (original: string, key: string | null) =>
    formatDocumentTitle(home ? "" : (message(key) ?? withoutSiteSuffix(original)), siteTitle);
  const socialImage = new URL(
    `/images/social/${language.value}/${interfaceSocialGroup(englishPath)}.png`,
    CANONICAL_ORIGIN,
  ).href;
  let titleKey: string | null = null;
  let title = "";
  let pageTitle = "";
  let structuredData = "";
  return new HTMLRewriter()
    .on("html", {
      element(element) {
        element.setAttribute("lang", language.tag);
        element.setAttribute("data-interface-locale", language.value);
      },
    })
    .on("title", {
      element(element) {
        titleKey = element.getAttribute("data-interface-title-key");
        const original = element.getAttribute("data-interface-title-original");
        if (original !== null) {
          pageTitle = titleText(original, titleKey);
          element.setInnerContent(pageTitle);
        }
      },
      text(text) {
        title += text.text;
        if (text.lastInTextNode) {
          pageTitle = titleText(title, titleKey);
          text.replace(pageTitle);
          title = "";
        } else text.remove();
      },
    })
    .on("[data-i18n]", {
      element(element) {
        const text = message(element.getAttribute("data-i18n"));
        if (text === undefined) return;
        element.setInnerContent(text);
        element.setAttribute("lang", language.tag);
      },
    })
    .on("[data-i18n-aria-label]", {
      element(element) {
        const label = message(element.getAttribute("data-i18n-aria-label"));
        if (label !== undefined) element.setAttribute("aria-label", label);
      },
    })
    .on("a[href], link[rel='canonical']", {
      element(element) {
        const href = element.getAttribute("href");
        if (href && !element.hasAttribute("hreflang") && !element.hasAttribute("download"))
          element.setAttribute("href", link(href));
      },
    })
    .on("meta[content]", {
      element(element) {
        const field = element.getAttribute("property") ?? element.getAttribute("name");
        const value = element.getAttribute("content");
        if (!value) return;
        if (field === "og:url") element.setAttribute("content", link(value));
        if (field === "og:title" || field === "twitter:title")
          element.setAttribute("content", pageTitle || titleText(value, titleKey));
        if (field === "description" || field === "og:description" || field === "twitter:description") {
          const description = message(element.getAttribute("data-interface-description-key"));
          if (description)
            element.setAttribute("content", interpolateMessage(description, { title: withoutSiteSuffix(pageTitle) }));
        }
        if ((field === "og:image" || field === "twitter:image") && value.includes("/images/social/"))
          element.setAttribute("content", socialImage);
      },
    })
    .on("head", {
      element(element) {
        element.append(`<meta property="og:locale" content="${language.tag.replace("-", "_")}">`, { html: true });
      },
    })
    .on('script[type="application/ld+json"]', {
      text(text) {
        structuredData += text.text;
        if (!text.lastInTextNode) {
          text.remove();
          return;
        }
        try {
          const value = JSON.parse(structuredData, (key, item) => {
            if (key === "inLanguage" && (item === "en" || item === "en-US")) return language.tag;
            if (typeof item === "string" && item.startsWith("https://")) return link(item);
            return item;
          });
          text.replace(JSON.stringify(value).replaceAll("<", "\\u003c"), { html: true });
        } catch {
          text.replace(structuredData, { html: true });
        }
        structuredData = "";
      },
    })
    .transform(response);
}
