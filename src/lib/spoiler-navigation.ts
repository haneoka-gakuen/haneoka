import { SPOILER_CONTENT_EVENT } from "./spoiler-content";
import { RequestScope } from "./request-scope";
import { navigationDocumentUrl } from "./document-url";

const requests = new RequestScope();
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
  if (value === null) target.searchParams.delete("spoiler");
  else target.searchParams.set("spoiler", value);
  const href = `${target.pathname}${target.search}${target.hash}`;
  if (href !== raw) anchor.setAttribute("href", href);
}

function syncLinks(root: ParentNode) {
  if (root instanceof HTMLAnchorElement) syncLink(root);
  root.querySelectorAll<HTMLAnchorElement>("a[href]").forEach(syncLink);
}

export function setPageSpoilers(enabled: boolean): void {
  const target = new URL(location.href);
  target.searchParams.set("spoiler", enabled ? "1" : "0");
  history.replaceState(history.state, "", target);
  try {
    sessionStorage.setItem("haneoka.page-spoilers", enabled ? "1" : "0");
  } catch {}
  syncLinks(document);
  dispatchEvent(new Event(SPOILER_CONTENT_EVENT));
}

export async function refreshSpoilerPreference(): Promise<void> {
  const signal = requests.begin();
  try {
    const response = await fetch("/api/v1/account/spoilers", { credentials: "same-origin", cache: "no-store", signal });
    if (!response.ok) return;
    const value = (await response.json()) as { allowed: boolean; enabled: boolean };
    if (!requests.current(signal)) return;
    document.documentElement.dataset.spoilerPreferenceAllowed = value.allowed ? "1" : "0";
    dispatchEvent(new Event("haneoka:spoiler-preference"));
    if (value.allowed && value.enabled && !new URL(location.href).searchParams.has("spoiler")) {
      const target = new URL(location.href);
      target.searchParams.set("spoiler", "1");
      location.replace(target);
    }
  } catch {
    /* The current URL keeps its state. */
  }
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
  document.addEventListener("astro:page-load", () => syncLinks(document));
  addEventListener("haneoka:session-changed", () => {
    requests.cancel();
    delete document.documentElement.dataset.spoilerPreferenceAllowed;
    dispatchEvent(new Event("haneoka:spoiler-preference"));
  });
}
