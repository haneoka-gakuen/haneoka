// L3 — GEB
// Input: 浏览器／App 全屏事件、播放器节点及页面切换。
// Output: 全屏横屏请求、退出恢复与失效会话清理。
// Pos: [Map](L2-2.md)；Base 共用的全屏生命周期。
// Effects/Dependencies: App 方向桥或 Screen Orientation API；离开、Escape 和节点移除时退出 App 全屏。
import { appCall, appPlatform } from "./app-bridge";

type FullscreenDocument = Document & {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => void;
};
type LockableOrientation = ScreenOrientation & { lock?: (orientation: "landscape") => Promise<void> };

export function installFullscreen() {
  const doc = document as FullscreenDocument;
  let current: Element | null = null;
  let releaseOrientation: (() => void) | undefined;
  const element = () => doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
  const exit = () => {
    if (doc.fullscreenElement) void doc.exitFullscreen().catch(() => undefined);
    else if (doc.webkitFullscreenElement) doc.webkitExitFullscreen?.();
  };
  const removed = new MutationObserver(() => {
    if (current && !current.isConnected) exit();
  });
  const changed = () => {
    const target = element();
    if (target === current) return;
    removed.disconnect();
    releaseOrientation?.();
    releaseOrientation = undefined;
    current = target;
    if (!target) return;
    removed.observe(document.body, { childList: true, subtree: true });

    if (target.hasAttribute("data-app-fullscreen")) {
      if (!["ios", "android"].includes(appPlatform() ?? "")) return;
      releaseOrientation = () => void appCall("orientation", { orientation: "any" }).catch(() => undefined);
      void appCall("orientation", { orientation: "landscape" }).catch(() => undefined);
    } else if (matchMedia("(pointer: coarse)").matches) {
      const orientation = screen.orientation as LockableOrientation | undefined;
      if (!orientation?.lock) return;
      releaseOrientation = () => orientation.unlock();
      void orientation
        .lock("landscape")
        .then(() => {
          if (!current) orientation.unlock();
        })
        .catch(() => undefined);
    }
  };
  document.addEventListener("fullscreenchange", changed);
  document.addEventListener("webkitfullscreenchange", changed);
  document.addEventListener("astro:before-swap", exit);
  window.addEventListener("pagehide", exit);
  window.addEventListener(
    "keydown",
    (event) => {
      if (event.key !== "Escape" || !current?.hasAttribute("data-app-fullscreen")) return;
      event.preventDefault();
      event.stopPropagation();
      exit();
    },
    true,
  );
  changed();
}
