type Listener = { path: string; update: () => void };
const listeners = new Set<Listener>();
let listening = false;
const routePath = (path: string) => path.replace(/\/+$/, "") || "/";
/** Built pages live under a locale prefix; the shell's data-route does not. */
const barePath = (path: string) => routePath(path.replace(/^\/(?:ja|en|zh-TW|zh-CN|ko)(?=\/)/u, ""));
export function observeDetailLocation(update: () => void, owner?: Element): () => void {
  const listener = {
    path: barePath(owner?.closest("[data-route]")?.getAttribute("data-route") || location.pathname),
    update,
  };
  listeners.add(listener);
  if (!listening) {
    listening = true;
    window.addEventListener(
      "haneoka:detail-popstate",
      (event) => {
        const active = [...listeners].filter((entry) => entry.path === barePath(location.pathname));
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
  if (new URL(url, location.href).href === location.href) return;
  history.pushState({ ...history.state, haneokaDetail: routePath(location.pathname) }, "", url);
}
export function closeDetailLocation(url: string): void {
  if (history.state?.haneokaDetail === routePath(location.pathname)) history.back();
  else {
    history.replaceState(history.state, "", url);
    for (const listener of listeners) if (listener.path === routePath(location.pathname)) listener.update();
  }
}
