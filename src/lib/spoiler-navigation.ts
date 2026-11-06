import { setSpoilerContentEnabled, spoilerContentEnabled, SPOILER_STORAGE_KEY } from "./spoiler-content";
import { navigationDocumentUrl } from "./document-url";

let installed = false;
const pageUrl = (url: URL) =>
  url.origin === location.origin &&
  !/^\/(?:api|assets|runtime|objects|artifacts|downloads|sonolus|embed|pagefind)(?:\/|$)/u.test(url.pathname) &&
  !/\.[a-z0-9]+$/iu.test(url.pathname);

function syncLink(anchor: HTMLAnchorElement) {
  const raw = anchor.getAttribute("href");
  if (!raw) return;
  const target = new URL(raw, location.href);
  if (!pageUrl(target)) return;
  const value = navigationDocumentUrl().searchParams.get("spoiler");
  if (value === null || target.searchParams.has("spoiler")) return;
  target.searchParams.set("spoiler", value);
  const href = `${target.pathname}${target.search}${target.hash}`;
  if (href !== raw) anchor.setAttribute("href", href);
}

function syncLinks(root: ParentNode) {
  if (root instanceof HTMLAnchorElement) syncLink(root);
  root.querySelectorAll<HTMLAnchorElement>("a[href]").forEach(syncLink);
}

export function setPageSpoilers(enabled: boolean): void {
  setSpoilerContentEnabled(enabled);
  syncLinks(document);
}

export function installSpoilerNavigation(): void {
  if (installed) return;
  installed = true;
  syncLinks(document);
  new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === "attributes" && record.target instanceof HTMLAnchorElement) syncLink(record.target);
      for (const node of record.addedNodes) if (node instanceof Element) syncLinks(node);
    }
  }).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ["href"] });
  document.addEventListener("astro:before-preparation", (event) => {
    const target = (event as Event & { to: URL }).to;
    if (!pageUrl(target) || target.searchParams.has("spoiler")) return;
    const value = new URL(location.href).searchParams.get("spoiler");
    if (value !== null) target.searchParams.set("spoiler", value);
  });
  document.addEventListener("astro:page-load", () => {
    syncLinks(document);
  });
  window.addEventListener("storage", (event) => {
    if (event.key === SPOILER_STORAGE_KEY || event.key === null) setPageSpoilers(spoilerContentEnabled());
  });
}
