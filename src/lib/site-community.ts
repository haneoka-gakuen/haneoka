// L3 — GEB
// Input: 请求域名、社区隐藏域名配置、页面／评论路径和 HTML 站点状态。
// Output: 社区可见性、受限页面／评论接口识别和保留水合标记的显示规则。
// Pos: [Map](L2-2.md)；Worker、开发中间件与浏览器共用的社区显示策略。
// Effects/Dependencies: 浏览器读取 HTML 状态；不改变账号、库存或云同步权限。
export const COMMUNITY_VISIBILITY_ATTRIBUTE = "data-community-pages";
export const DEFAULT_COMMUNITY_HIDDEN_HOSTS = "haneoka.com";

export const communityPagesEnabled = (hostname: string, hiddenHosts = DEFAULT_COMMUNITY_HIDDEN_HOSTS): boolean =>
  !hiddenHosts.split(",").some((host) => host.trim() === hostname);

export function communityVisible(): boolean {
  const page = (globalThis as { document?: { documentElement?: { getAttribute(name: string): string | null } } })
    .document;
  return page?.documentElement?.getAttribute(COMMUNITY_VISIBILITY_ATTRIBUTE) !== "0";
}

export function isCommunityPagePath(pathname: string): boolean {
  if (pathname.startsWith("/playlist-static/")) return true;
  const path = pathname.replace(/^\/(?:(?:[a-z0-9-]+)\/)?(?:ja|en|zh-TW|zh-CN|ko)(?=\/|$)/u, "");
  if (/^\/community(?:\/|$)/u.test(path)) return true;
  return /^\/(?:charts|community-stories|playlist-static)(?:\/|$)/u.test(path);
}

export function isCommunityCommentRequest(url: URL): boolean {
  const bootstrapPath = url.pathname === "/api/v1/community/bootstrap" ? url.searchParams.get("path") || "/" : null;
  const [pathname, query] = bootstrapPath === null ? [url.pathname, ""] : bootstrapPath.split("?", 2);
  const params = bootstrapPath === null ? url.searchParams : new URLSearchParams(query);
  return (
    (pathname === "/api/v1/community/forums" && params.get("purpose") === "entity-comments") ||
    /^\/api\/v1\/community\/(?:entity-threads|entity-comments|entity-comment-forum)(?:\/|$)/u.test(pathname!) ||
    /^\/api\/v1\/community\/posts\/[^/]+\/comments(?:\/|$)/u.test(pathname!)
  );
}

export function communityVisibilityCss(origin: string): string {
  const communityLinks = [...new Set(["", "https://haneoka.org", "https://haneoka.com", origin])].flatMap((base) =>
    ["", "/ja", "/en", "/zh-TW", "/zh-CN", "/ko"].flatMap((locale) => {
      const prefix = `${base}${locale}/community`;
      return [`a[href="${prefix}"]`, `a[href^="${prefix}?"]`, `a[href^="${prefix}/"]`];
    }),
  );
  return `@layer utilities {
html[${COMMUNITY_VISIBILITY_ATTRIBUTE}="0"] :is(
[data-community-feature], [data-destination="community"],
.home-board__slot--community, .detail-layout__comments, entity-comments, #entity-comments,
a[href$="#entity-comments"], ${communityLinks.join(",")}
) { display: none !important; }
}`;
}

export function communityVisibilityHtml(html: string, enabled: boolean, origin: string): string {
  return html
    .replace("<html", `<html ${COMMUNITY_VISIBILITY_ATTRIBUTE}="${enabled ? "1" : "0"}"`)
    .replace("</head>", `<style data-community-visibility>${communityVisibilityCss(origin)}</style></head>`);
}
