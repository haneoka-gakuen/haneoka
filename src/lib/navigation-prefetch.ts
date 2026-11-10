// L3 — GEB
// Input: Pointer, touch and keyboard intent on same-origin page links; Astro client-router preparation events.
// Output: The next page's document fetched before the click and handed to the router's loader.
// Pos: [Map](L2-2.md); page navigation latency for the shell's client router.
// Effects/Dependencies: Fetches HTML documents early and keeps up to four for 30 s in memory; replaces the router loader only on a cache hit.
import type { TransitionBeforePreparationEvent } from "astro:transitions/client";

interface Prefetched {
  html: string;
  mediaType: string;
  redirected?: string;
}

const TTL = 30_000;
const LIMIT = 4;
const HOVER_INTENT = 150;
const pages = new Map<string, { at: number; page: Promise<Prefetched | null> }>();

const cacheKey = (url: URL) => {
  const copy = new URL(url);
  copy.hash = "";
  return copy.href;
};

function target(element: EventTarget | null): URL | null {
  const anchor = element instanceof Element ? element.closest("a[href]") : null;
  if (!(anchor instanceof HTMLAnchorElement)) return null;
  if (
    (anchor.target && anchor.target !== "_self") ||
    anchor.hasAttribute("download") ||
    anchor.hasAttribute("data-astro-reload")
  )
    return null;
  const url = new URL(anchor.href, location.href);
  if (url.origin !== location.origin || (url.pathname === location.pathname && url.search === location.search))
    return null;
  // Documents only: files, APIs and media are never pages the router swaps in.
  if (
    /^\/(?:api|auth|downloads|assets|runtime|objects|sonolus)\//u.test(url.pathname) ||
    /\.[a-z0-9]{2,5}$/iu.test(url.pathname)
  )
    return null;
  return url;
}

function prefetch(url: URL): void {
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  if (connection?.saveData || !navigator.onLine) return;
  const key = cacheKey(url);
  const existing = pages.get(key);
  if (existing && Date.now() - existing.at < TTL) return;
  const page = fetch(url.href, { credentials: "same-origin" })
    .then(async (response): Promise<Prefetched | null> => {
      const mediaType = (response.headers.get("content-type") ?? "").split(";", 1)[0]!.trim();
      if (!response.ok || (mediaType !== "text/html" && mediaType !== "application/xhtml+xml")) return null;
      return { html: await response.text(), mediaType, redirected: response.redirected ? response.url : undefined };
    })
    .catch(() => null);
  pages.delete(key);
  pages.set(key, { at: Date.now(), page });
  while (pages.size > LIMIT) pages.delete(pages.keys().next().value!);
}

function preloadStyles(next: Document): Promise<unknown>[] {
  return [...next.querySelectorAll<HTMLLinkElement>("head link[rel=stylesheet]")].flatMap((sheet) => {
    const href = sheet.getAttribute("href");
    if (!href || document.querySelector(`link[rel=stylesheet][href="${CSS.escape(href)}"]`)) return [];
    const link = document.createElement("link");
    link.rel = "preload";
    link.as = "style";
    link.href = href;
    return [
      new Promise((resolve) => {
        link.addEventListener("load", resolve, { once: true });
        link.addEventListener("error", resolve, { once: true });
        document.head.append(link);
      }),
    ];
  });
}

let installed = false;

/** Starts loading a page while the pointer rests on its link or the finger touches it. */
export function installNavigationPrefetch(): void {
  if (installed) return;
  installed = true;
  addEventListener("haneoka:session-changed", () => pages.clear());
  addEventListener("haneoka:spoiler-content", () => pages.clear());
  let hover = 0;
  document.addEventListener(
    "pointerover",
    (event) => {
      if (event.pointerType !== "mouse") return;
      const url = target(event.target);
      if (!url) return;
      clearTimeout(hover);
      hover = window.setTimeout(() => prefetch(url), HOVER_INTENT);
    },
    { passive: true },
  );
  document.addEventListener("pointerout", () => clearTimeout(hover), { passive: true });
  for (const type of ["pointerdown", "focusin"] as const)
    document.addEventListener(
      type,
      (event) => {
        if (event instanceof PointerEvent && event.button !== 0) return;
        const url = target(event.target);
        if (url) prefetch(url);
      },
      { passive: true },
    );
  document.addEventListener("astro:before-preparation", (event) => {
    const preparation = event as TransitionBeforePreparationEvent;
    if (preparation.formData) return;
    const fallback = preparation.loader;
    preparation.loader = async () => {
      const key = cacheKey(preparation.to);
      const entry = pages.get(key);
      if (!entry || Date.now() - entry.at > TTL) return fallback();
      pages.delete(key);
      const page = await entry.page;
      if (!page || preparation.signal.aborted) return fallback();
      if (page.redirected) {
        const redirected = new URL(page.redirected);
        if (redirected.origin !== preparation.to.origin) return fallback();
        redirected.hash = preparation.to.hash;
        preparation.to = redirected;
      }
      const next = new DOMParser().parseFromString(page.html, page.mediaType as DOMParserSupportedType);
      next.querySelectorAll("noscript").forEach((element) => element.remove());
      if (!next.querySelector('[name="astro-view-transitions-enabled"]')) return fallback();
      preparation.newDocument = next;
      const styles = preloadStyles(next);
      if (styles.length && !preparation.signal.aborted) await Promise.all(styles);
    };
  });
}
