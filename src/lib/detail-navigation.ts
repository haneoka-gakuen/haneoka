type Listener = { path: string; update: () => void };
const listeners = new Set<Listener>();
let listening = false;
export function observeDetailLocation(update: () => void): () => void {
  const listener = { path: location.pathname, update };
  listeners.add(listener);
  if (!listening) {
    listening = true;
    window.addEventListener(
      "haneoka:detail-popstate",
      (event) => {
        const active = [...listeners].filter((entry) => entry.path === location.pathname);
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
  history.pushState({ ...history.state, haneokaDetail: location.pathname }, "", url);
}
export function closeDetailLocation(url: string): void {
  if (history.state?.haneokaDetail === location.pathname) history.back();
  else {
    history.replaceState(history.state, "", url);
    for (const listener of listeners) if (listener.path === location.pathname) listener.update();
  }
}
