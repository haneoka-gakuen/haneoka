// L3 — GEB
// Input: Shared community entity HTML, requested URL and locale paths.
// Output: Canonical, alternate and structured metadata for the concrete document.
// Pos: [Map](L2-2.md); shared by community charts, stories and document servers.
// Effects/Dependencies: Transforms HTML/JSON; the browser entry updates document metadata.
interface MetadataNode {
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  textContent: string | null;
}
export function applyCommunityDocumentMetadata(
  root: { querySelectorAll(selector: string): Iterable<MetadataNode> },
  locale: string,
  path: (locale: string) => string,
  origin: string,
): void {
  const canonical = `${origin}${path(locale)}`;
  for (const node of root.querySelectorAll(
    'link[rel="canonical"], meta[property="og:url"], link[rel="alternate"][hreflang], script[type="application/ld+json"]',
  )) {
    const language = node.getAttribute("hreflang");
    const target = language === "x-default" ? "en" : language === "ja-JP" ? "ja" : language;
    if (node.getAttribute("rel") === "canonical") node.setAttribute("href", canonical);
    else if (node.getAttribute("property") === "og:url") node.setAttribute("content", canonical);
    else if (target && /^(ja|en|zh-TW|zh-CN|ko)$/u.test(target)) node.setAttribute("href", `${origin}${path(target)}`);
    else if (node.getAttribute("type") === "application/ld+json" && node.textContent)
      node.textContent = rewriteCommunityStructuredData(node.textContent, canonical);
  }
}
export function rewriteCommunityStructuredData(body: string, url: string): string {
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    return body;
  }
  if (!data || typeof data !== "object" || !Array.isArray((data as { "@graph"?: unknown })["@graph"])) return body;
  for (const entry of (data as { "@graph": Array<Record<string, unknown>> })["@graph"]) {
    if (!entry || typeof entry !== "object") continue;
    if (entry["@type"] === "WebPage") {
      entry.url = url;
      entry["@id"] = `${url}#page`;
    } else if (entry["@type"] === "BreadcrumbList") {
      entry["@id"] = `${url}#breadcrumb`;
      const items = entry.itemListElement;
      const last = Array.isArray(items) ? items.at(-1) : undefined;
      if (last && typeof last === "object") last.item = url;
    }
  }
  return JSON.stringify(data).replaceAll("<", "\\u003c");
}
export function rewriteCommunityDocument(
  html: string,
  locale: string,
  path: (locale: string) => string,
  origin: string,
): string {
  const canonical = `${origin}${path(locale)}`;
  return html
    .replace(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/giu, (script, body: string) =>
      script.replace(body, rewriteCommunityStructuredData(body, canonical)),
    )
    .replace(/<(?:link|meta)\b[^>]*>/giu, (tag) => {
      const attribute = (name: string) => new RegExp(`\\b${name}=["']([^"']*)["']`, "iu").exec(tag)?.[1];
      const rel = attribute("rel"),
        property = attribute("property"),
        tagLocale = attribute("hreflang");
      const target = tagLocale === "x-default" ? "en" : tagLocale === "ja-JP" ? "ja" : tagLocale;
      const value =
        rel === "canonical" || property === "og:url"
          ? canonical
          : rel === "alternate" && target && /^(ja|en|zh-TW|zh-CN|ko)$/u.test(target)
            ? `${origin}${path(target)}`
            : undefined;
      if (!value) return tag;
      const key = property === "og:url" ? "content" : "href";
      return tag.replace(new RegExp(`(\\b${key}=)["'][^"']*["']`, "iu"), `$1"${value}"`);
    });
}
