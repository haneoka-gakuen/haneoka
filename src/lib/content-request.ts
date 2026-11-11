// L3 — GEB
// Input: Same-origin resource URLs and the active document context.
// Output: Resource requests and cache identities that retain the current content view.
// Pos: [Map](L2-2.md); browser resource-request context propagation.
// Effects/Dependencies: Installs the fetch adapter and shares the current display scope with the browser cache.
import { visibilityType } from "./content-visibility-policy";
import { navigationDocumentUrl } from "./document-url";
import { spoilerContentEnabled } from "./spoiler-content";
import { spoilerOverrideEnabled } from "./spoiler-cookie";
import { isAssetBrowserDocument } from "./asset-static-routing";

export function contentCacheScope(target = navigationDocumentUrl()): string {
  const data = document.documentElement.dataset;
  return `view-v1-${data.contentVisibilityVersion ?? "0"}-${data.contentGroup ?? "guest"}-${Number(spoilerContentEnabled())}-${Number(spoilerOverrideEnabled(target))}`;
}

export function publishContentCacheScope(): void {
  navigator.serviceWorker?.controller?.postMessage({ type: "haneoka:content-view", scope: contentCacheScope() });
}

const resourcePath =
  /^(?:\/api\/v1\/community\/(?:entity-threads|entity-comments|posts|bootstrap|charts)(?:\/|$)|\/(?:assets|runtime|objects|artifacts|game-client|static-views|asset-static|playlist-static|downloads\/stories)\/|\/api\/v1\/(?:servers|team-builder|meta-reference|search|live2d|spine)(?:\/|$))/u;
export function contentRequestUrl(source: string): string {
  if (typeof location === "undefined" || typeof document === "undefined" || !document.documentElement || import.meta.env?.SSR || !source)
    return source;
  const url = new URL(source, location.href);
  const kind = /^\/api\/v1\/([^/]+)/u.exec(url.pathname)?.[1];
  if (url.origin !== location.origin || (!resourcePath.test(url.pathname) && !(kind && visibilityType(kind))))
    return source;
  url.searchParams.set("__content", "1");
  const override = navigationDocumentUrl().searchParams.get("spoiler");
  if (override !== null && !url.searchParams.has("spoiler")) url.searchParams.set("spoiler", override);
  if (/^\/(?:assets|runtime|objects)\//u.test(url.pathname)) {
    if (isAssetBrowserDocument(navigationDocumentUrl())) url.searchParams.set("asset", "1");
    if (url.searchParams.get("asset") === "1") url.searchParams.delete("cv");
    else url.searchParams.set("cv", contentCacheScope(url));
  }
  return url.pathname + url.search + url.hash;
}
let installed = false;
export function installContentRequests(): void {
  if (installed) return;
  installed = true;
  const nativeFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const raw = input instanceof Request ? input.url : String(input);
    const url = contentRequestUrl(raw);
    return nativeFetch(url === raw ? input : input instanceof Request ? new Request(url, input) : url, init);
  };
}
