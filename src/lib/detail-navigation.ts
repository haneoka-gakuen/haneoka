import { navigationDocumentUrl } from "./document-url";
import { clientText } from "../i18n/client";
import { parseEntitySelection, resourceCollectionHref, resourcePath } from "./resource-route";

type Listener = { path: string; owner?: Element; update: () => void };
const listeners = new Set<Listener>();
let listening = false;
const routePath = (path: string) => path.replace(/\/+$/, "") || "/";
/**
 * Detail history is only local to the current actual document pathname.
 *
 * The shell's data-route is a logical collection route, so using it here on a
 * canonical server-first page made a browser Back from `/intl/en/...` look
 * like a local pane pop on `/en/catalog/...`. That prevented Astro from
 * loading the collection document. Query changes remain local; pathname
 * changes belong to the router.
 */
const actualPath = (path: string) => routePath(path.split(/[?#]/u, 1)[0] || "/");
export function observeDetailLocation(update: () => void, owner?: Element): () => void {
  const listener = {
    path: actualPath(navigationDocumentUrl().pathname),
    owner,
    update,
  };
  listeners.add(listener);
  if (!listening) {
    listening = true;
    window.addEventListener(
      "haneoka:detail-popstate",
      (event) => {
        const active = [...listeners].filter((entry) => {
          if (entry.owner && !entry.owner.isConnected) {
            listeners.delete(entry);
            return false;
          }
          return entry.path === actualPath(location.pathname);
        });
        if (!active.length) return;
        event.preventDefault();
        active.forEach((entry) => entry.update());
      },
      { capture: true },
    );
  }
  return () => {
    listeners.delete(listener);
  };
}
export function openDetailLocation(url: string): void {
  const target = new URL(url, location.href);
  if (target.href === location.href) return;
  if (actualPath(target.pathname) !== actualPath(location.pathname)) {
    void navigateDetailPage(target.href);
    return;
  }
  history.pushState({ ...history.state, haneokaDetail: routePath(location.pathname) }, "", url);
}
export function closeDetailLocation(url: string): void {
  if (actualPath(new URL(url, location.href).pathname) !== actualPath(location.pathname)) {
    void navigateDetailPage(url, "replace");
    return;
  }
  if (history.state?.haneokaDetail === routePath(location.pathname)) history.back();
  else {
    history.replaceState(history.state, "", url);
    for (const listener of listeners) {
      if (listener.owner && !listener.owner.isConnected) {
        listeners.delete(listener);
        continue;
      }
      if (listener.path === actualPath(location.pathname)) listener.update();
    }
  }
}

export async function navigateDetailPage(href: string, historyMode: "push" | "replace" = "push"): Promise<void> {
  const target = new URL(href, location.href);
  if (target.origin !== location.origin) return;
  try {
    const { navigate } = await import("astro:transitions/client");
    await navigate(target.href, { history: historyMode });
  } catch {
    if (historyMode === "replace") window.location.replace(target.href);
    else window.location.assign(target.href);
  }
}

export function entityReturnHref(): string | undefined {
  const value = navigationDocumentUrl().searchParams.get("return");
  if (value?.startsWith("/")) {
    try {
      const target = new URL(value, location.origin);
      if (target.origin === location.origin) return `${target.pathname}${target.search}${target.hash}`;
    } catch {}
  }
  return document.querySelector<HTMLAnchorElement>("[data-entity-back]")?.dataset.entityFallbackHref;
}

/** Apply runtime return state to static app-bar links on every kind of detail page. */
export function syncEntityNavigation(): void {
  let back = document.querySelector<HTMLAnchorElement>("[data-entity-back]");
  const documentUrl = navigationDocumentUrl();
  const selection = parseEntitySelection(documentUrl.pathname);
  if (!back && selection?.source === "canonical") {
    const slot = document.querySelector<HTMLElement>("[data-top-app-bar-leading]");
    if (slot) {
      back = document.createElement("a");
      back.className = "icon-button";
      back.dataset.entityBack = "";
      const collection = document.querySelector<HTMLElement>("[data-shell]")?.dataset.route;
      back.dataset.entityFallbackHref = collection
        ? resourceCollectionHref(collection, selection.route.server, selection.route.locale) ||
          resourcePath({ ...selection.route, id: undefined })
        : resourcePath({ ...selection.route, id: undefined });
      back.dataset.i18nAriaLabel = "back";
      back.setAttribute("aria-label", clientText(selection.route.locale, "common.actions.back", "Back"));
      const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      icon.setAttribute("class", "material-icon");
      icon.setAttribute("width", "24");
      icon.setAttribute("height", "24");
      icon.setAttribute("aria-hidden", "true");
      const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
      use.setAttribute("href", "/icons.svg#arrow_back");
      icon.append(use);
      back.append(icon);
      const menu = slot.querySelector<HTMLElement>(".top-app-bar__menu");
      if (menu) document.querySelector("[data-top-app-bar-actions]")?.prepend(menu);
      slot.prepend(back);
    }
  }
  if (!back) return;
  if (selection?.source === "canonical") delete back.dataset.astroHistory;
  const returnTo = entityReturnHref();
  if (!returnTo) return;
  back.href = returnTo;
  for (const link of document.querySelectorAll<HTMLAnchorElement>("[data-entity-navigation]")) {
    const target = new URL(link.dataset.entityBaseHref || link.href, documentUrl);
    if (target.origin !== location.origin) continue;
    target.searchParams.set("return", returnTo);
    link.href = target.href;
  }
}

/** Detail renderers own the title; the shell owns its placement and navigation. */
export function updateEntityHeading(owner: HTMLElement, title: string, language?: string): void {
  if (!owner.isConnected || !title) return;
  const heading = owner.closest("[data-shell]")?.querySelector<HTMLElement>("[data-top-app-bar] h1");
  if (!heading) return;
  if (heading.textContent !== title) heading.textContent = title;
  heading.dataset.entityTitle = "true";
  if (language) heading.lang = language;
  else heading.removeAttribute("lang");
}
