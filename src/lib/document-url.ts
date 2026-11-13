/** Destination identity stays available throughout Astro's document swap. */
let pendingDocumentUrl: URL | undefined;
let documentUrlListening = false;
let renderDocumentUrl: URL | undefined;

export function withDocumentUrl<T>(url: URL, render: () => T): T {
  const previous = renderDocumentUrl;
  renderDocumentUrl = url;
  try {
    return render();
  } finally {
    renderDocumentUrl = previous;
  }
}

/**
 * Astro connects custom elements before it commits the browser URL. Base
 * marks the incoming document during before-swap and clears that attribute
 * during after-swap. Async controllers may resume between after-swap and
 * the URL commit, so retain the destination until page-load completes.
 */
export function navigationDocumentUrl(): URL {
  if (renderDocumentUrl) return new URL(renderDocumentUrl);
  if (!documentUrlListening) {
    documentUrlListening = true;
    document.addEventListener("astro:page-load", () => {
      pendingDocumentUrl = undefined;
    });
  }
  const marked = document.documentElement.dataset.navigationHref;
  if (marked) {
    try {
      const target = new URL(marked, location.href);
      if (target.origin === location.origin) pendingDocumentUrl = target;
    } catch {}
  }
  return pendingDocumentUrl ?? new URL(location.href);
}

const RETURN_STORAGE = "haneoka.navigation.returns.v1";
const returns = new Map<string, string>();
const linkReturns = new Map<string, { from: string; href: string }>();
let returnsLoaded = false;
const returnKey = (url: URL) => url.pathname.replace(/\/+$/u, "") || "/";
const localPath = (url: URL) => `${url.pathname}${url.search}${url.hash}`;
const accountPath = (url: URL) => /\/account(?:\/|$)/u.test(url.pathname);
const legacyReturn = (url: URL) =>
  url.searchParams.get("return") ?? (accountPath(url) ? url.searchParams.get("next") : null);
function returnUrl(value: string, base: URL): URL | undefined {
  try {
    const url = new URL(value, base);
    if (url.origin !== base.origin || !/^https?:$/u.test(url.protocol)) return;
    url.searchParams.delete("return");
    if (accountPath(url)) url.searchParams.delete("next");
    return url;
  } catch {
    return;
  }
}
function loadReturns(): void {
  if (returnsLoaded) return;
  returnsLoaded = true;
  try {
    const saved: [string, string][] = JSON.parse(sessionStorage.getItem(RETURN_STORAGE) || "[]");
    for (const [key, value] of saved) if (returnUrl(value, new URL(location.href))) returns.set(key, value);
  } catch {}
}
/** Keep link-specific return context out of shared and copied URLs. */
export function returnLink(href: string, returnTo?: string): string {
  const browser = typeof window !== "undefined";
  const base = browser ? navigationDocumentUrl() : new URL("https://route.invalid");
  const target = returnUrl(href, base);
  if (!target) return href;
  const source = returnTo && returnUrl(returnTo, base);
  if (browser && source) {
    linkReturns.delete(returnKey(target));
    linkReturns.set(returnKey(target), { from: returnKey(base), href: localPath(source) });
    if (linkReturns.size > 512) linkReturns.delete(linkReturns.keys().next().value!);
  }
  return localPath(target);
}
export function rememberedReturn(url = navigationDocumentUrl()): string | undefined {
  loadReturns();
  const legacy = legacyReturn(url);
  const target = legacy && returnUrl(legacy, url);
  return target ? localPath(target) : returns.get(returnKey(url));
}
/** Persist only actual navigations, bounded to this tab's recent destinations. */
export function rememberReturn(target: URL, from: URL, fallback?: string): void {
  loadReturns();
  if (target.origin !== from.origin || returnKey(target) === returnKey(from)) return;
  const legacy = legacyReturn(target);
  const declared = linkReturns.get(returnKey(target));
  const value = legacy || (declared?.from === returnKey(from) ? declared.href : fallback) || localPath(from);
  const source = returnUrl(value, from);
  if (!source || returnKey(source) === returnKey(target)) return;
  returns.delete(returnKey(target));
  returns.set(returnKey(target), localPath(source));
  if (returns.size > 256) returns.delete(returns.keys().next().value!);
  try {
    sessionStorage.setItem(RETURN_STORAGE, JSON.stringify([...returns]));
  } catch {}
}
/** Native location assignments need to save their context before leaving the document. */
export function rememberReturnLink(href: string, returnTo?: string): string {
  const path = returnLink(href, returnTo);
  rememberReturn(new URL(path, location.href), navigationDocumentUrl());
  return path;
}
export function captureLegacyReturn(): void {
  const url = new URL(location.href);
  if (legacyReturn(url) === null) return;
  let target = url;
  for (let depth = 0; depth < 16; depth++) {
    const value = legacyReturn(target);
    if (!value || !returnUrl(value, url)) break;
    const source = new URL(value, url);
    rememberReturn(target, source);
    target = source;
  }
  url.searchParams.delete("return");
  if (accountPath(url)) url.searchParams.delete("next");
  history.replaceState(history.state, "", localPath(url));
}
