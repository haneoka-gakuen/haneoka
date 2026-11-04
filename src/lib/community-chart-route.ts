// L3 — GEB
// Input: locale, community chart identity and old or canonical document URL.
// Output: Cross-server chart paths, legacy redirects, shell lookup and preview metadata.
// Pos: [Map](L2-2.md); shared by browser, static rendering and request handlers.
// Effects/Dependencies: Pure URL and HTML transformations; no network or storage.
import { rewriteCommunityDocument, rewriteCommunityStructuredData } from "./community-document-meta.ts";
const LOCALE = "(?:ja|en|zh-TW|zh-CN|ko)";
const CHART_ID = "[0-9a-f-]{36}";
const DOCUMENT = new RegExp(`^/(${LOCALE})/community/charts/(${CHART_ID})(/chart)?/?$`, "u");
const LEGACY = new RegExp(`^/(?:(?:jp|intl)/)?(${LOCALE})/charts(?:/(${CHART_ID})(/chart)?)?/?$`, "u");

export function communityChartPath(_server: string, locale: string, id = ""): string {
  return `/${locale}/community/charts/${id ? `${encodeURIComponent(id)}/` : ""}`;
}
export function communityChartPlayerPath(server: string, locale: string, id: string): string {
  return `${communityChartPath(server, locale, id)}chart/`;
}
export function parseCommunityChartDocument(pathname: string) {
  const match = DOCUMENT.exec(pathname);
  return match ? { locale: match[1]!, id: match[2]!, player: !!match[3] } : undefined;
}
export function legacyCommunityChartRedirectTarget(pathname: string, search = ""): string | undefined {
  const match = LEGACY.exec(pathname);
  if (!match) return undefined;
  return `${communityChartPath("", match[1]!, match[2])}${match[3] ? "chart/" : ""}${search}`;
}
export function communityChartShellPath(pathname: string): string | undefined {
  const route = parseCommunityChartDocument(pathname);
  return route ? `/${route.locale}/community/charts/_/` : undefined;
}

/** The shared shell has different metadata for each chart document. */
export function communityChartDocumentEtag(etag: string, pathname: string): string {
  const route = parseCommunityChartDocument(pathname);
  return route
    ? etag.replace(/"$/u, `:chart-${route.locale}-${route.id}-${route.player ? "player" : "detail"}"`)
    : etag;
}

export function rewriteCommunityChartStructuredData(body: string, pathname: string, origin: string): string {
  const route = parseCommunityChartDocument(pathname);
  return route
    ? rewriteCommunityStructuredData(
        body,
        `${origin}${route.player ? communityChartPlayerPath("", route.locale, route.id) : communityChartPath("", route.locale, route.id)}`,
      )
    : body;
}
export function rewriteCommunityChartDocument(html: string, pathname: string, origin: string): string {
  const route = parseCommunityChartDocument(pathname);
  return route
    ? rewriteCommunityDocument(
        html,
        route.locale,
        (locale) =>
          route.player ? communityChartPlayerPath("", locale, route.id) : communityChartPath("", locale, route.id),
        origin,
      )
    : html;
}
