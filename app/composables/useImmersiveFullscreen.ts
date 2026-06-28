import { collectFocusableElements } from "@haneoka/ui";
import type { ComputedRef, Ref } from "vue";

type ImmersiveElementRef<T extends HTMLElement> = Readonly<Ref<T | null | undefined>>;

interface WebkitFullscreenDocument extends Document {
  webkitExitFullscreen?: () => Promise<void> | void;
  webkitFullscreenElement?: Element | null;
}

interface WebkitFullscreenElement extends HTMLElement {
  webkitRequestFullscreen?: () => Promise<void> | void;
}

export interface ImmersiveFullscreenControls {
  active: Readonly<Ref<boolean>>;
  fallback: ComputedRef<boolean>;
  native: Readonly<Ref<boolean>>;
  enter: () => Promise<void>;
  exit: () => Promise<void>;
  toggle: () => Promise<void>;
}

const fullscreenElement = (document: WebkitFullscreenDocument) =>
  document.fullscreenElement ?? document.webkitFullscreenElement ?? null;

const viewportProperties = [
  "--app-viewport-width",
  "--app-viewport-height",
  "--app-viewport-offset-left",
  "--app-viewport-offset-top",
] as const;

/**
 * Uses the Fullscreen API where it is available and falls back to an
 * application-owned top layer on iPhone. The fallback keeps visual-viewport
 * dimensions in CSS custom properties so Safari's collapsing browser chrome
 * and the on-screen keyboard cannot leave stale 100vh geometry behind.
 */
export const useImmersiveFullscreen = <T extends HTMLElement>(
  target: ImmersiveElementRef<T>,
): ImmersiveFullscreenControls => {
  const active = ref(false);
  const native = ref(false);
  const fallback = computed(() => active.value && !native.value);

  let viewportFrame = 0;
  let previousBodyOverflow = "";
  let previousDocumentOverflow = "";
  let returnFocus: HTMLElement | null = null;
  let inertRoot: HTMLElement | null = null;
  let previousRootInert = false;
  let trackingViewport = false;
  const previousViewportProperties = new Map<string, string>();

  const updateViewport = () => {
    cancelAnimationFrame(viewportFrame);
    viewportFrame = requestAnimationFrame(() => {
      const viewport = window.visualViewport;
      const width = viewport?.width ?? window.innerWidth;
      const height = viewport?.height ?? window.innerHeight;
      const offsetLeft = viewport?.offsetLeft ?? 0;
      const offsetTop = viewport?.offsetTop ?? 0;
      const style = document.documentElement.style;
      style.setProperty("--app-viewport-width", `${width}px`);
      style.setProperty("--app-viewport-height", `${height}px`);
      style.setProperty("--app-viewport-offset-left", `${offsetLeft}px`);
      style.setProperty("--app-viewport-offset-top", `${offsetTop}px`);
    });
  };

  const startViewportTracking = () => {
    if (trackingViewport) return;
    trackingViewport = true;
    const style = document.documentElement.style;
    for (const property of viewportProperties) {
      previousViewportProperties.set(property, style.getPropertyValue(property));
    }
    updateViewport();
    window.addEventListener("resize", updateViewport, { passive: true });
    window.addEventListener("orientationchange", updateViewport, { passive: true });
    window.visualViewport?.addEventListener("resize", updateViewport, { passive: true });
    window.visualViewport?.addEventListener("scroll", updateViewport, { passive: true });
  };

  const stopViewportTracking = () => {
    if (!trackingViewport) return;
    trackingViewport = false;
    cancelAnimationFrame(viewportFrame);
    window.removeEventListener("resize", updateViewport);
    window.removeEventListener("orientationchange", updateViewport);
    window.visualViewport?.removeEventListener("resize", updateViewport);
    window.visualViewport?.removeEventListener("scroll", updateViewport);
    const style = document.documentElement.style;
    for (const property of viewportProperties) {
      const previousValue = previousViewportProperties.get(property);
      if (previousValue) style.setProperty(property, previousValue);
      else style.removeProperty(property);
    }
    previousViewportProperties.clear();
  };

  const suspendBackground = () => {
    const appRoot = document.getElementById("__nuxt");
    const element = target.value;
    if (!appRoot || !element || appRoot.contains(element)) return;
    inertRoot = appRoot;
    previousRootInert = appRoot.inert;
    appRoot.inert = true;
  };

  const restoreBackground = () => {
    if (!inertRoot) return;
    inertRoot.inert = previousRootInert;
    inertRoot = null;
  };

  const restoreFocus = async () => {
    const focusTarget = returnFocus;
    returnFocus = null;
    await nextTick();
    if (focusTarget?.isConnected) focusTarget.focus({ preventScroll: true });
  };

  const enterFallback = async () => {
    const element = target.value;
    if (!element || fallback.value) return;

    returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    previousBodyOverflow = document.body.style.overflow;
    previousDocumentOverflow = document.documentElement.style.overflow;
    document.body.style.overflow = "hidden";
    document.documentElement.style.overflow = "hidden";
    document.documentElement.dataset.appFullscreen = "fallback";
    element.classList.add("is-immersive-fullscreen", "is-app-fullscreen");
    native.value = false;
    active.value = true;
    startViewportTracking();
    await nextTick();
    suspendBackground();
    element.focus({ preventScroll: true });
  };

  const exitFallback = async () => {
    const element = target.value;
    element?.classList.remove("is-immersive-fullscreen", "is-app-fullscreen");
    delete document.documentElement.dataset.appFullscreen;
    document.body.style.overflow = previousBodyOverflow;
    document.documentElement.style.overflow = previousDocumentOverflow;
    restoreBackground();
    stopViewportTracking();
    native.value = false;
    active.value = false;
    await restoreFocus();
  };

  const syncNativeState = () => {
    const element = target.value;
    const current = fullscreenElement(document as WebkitFullscreenDocument);
    const ownsFullscreen = Boolean(element && current === element);

    if (ownsFullscreen) {
      element?.classList.add("is-immersive-fullscreen");
      element?.classList.remove("is-app-fullscreen");
      document.documentElement.dataset.appFullscreen = "native";
      native.value = true;
      active.value = true;
      startViewportTracking();
      return;
    }

    if (native.value) {
      element?.classList.remove("is-immersive-fullscreen");
      delete document.documentElement.dataset.appFullscreen;
      stopViewportTracking();
      native.value = false;
      active.value = false;
      void restoreFocus();
    }
  };

  const enter = async () => {
    const element = target.value as (T & WebkitFullscreenElement) | null | undefined;
    if (!element || active.value) return;

    returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const request = element.requestFullscreen?.bind(element) ?? element.webkitRequestFullscreen?.bind(element);
    if (request) {
      try {
        await request();
        syncNativeState();
        if (native.value) return;
      } catch {
        // iPhone exposes incomplete fullscreen surfaces in some WebKit hosts.
        // The application top layer below is the supported fallback.
      }
    }
    await enterFallback();
  };

  const exit = async () => {
    if (fallback.value) {
      await exitFallback();
      return;
    }
    if (!native.value) return;

    const fullscreenDocument = document as WebkitFullscreenDocument;
    const exitNative =
      document.exitFullscreen?.bind(document) ?? fullscreenDocument.webkitExitFullscreen?.bind(document);
    await exitNative?.();
    syncNativeState();
  };

  const toggle = async () => {
    if (active.value) await exit();
    else await enter();
  };

  const onKeydown = (event: KeyboardEvent) => {
    if (!active.value) return;
    if (event.key === "Escape" && fallback.value) {
      event.preventDefault();
      void exitFallback();
      return;
    }
    if (event.key !== "Tab") return;

    const element = target.value;
    if (!element) return;
    const focusable = collectFocusableElements(element);
    if (!focusable.length) {
      event.preventDefault();
      element.focus({ preventScroll: true });
      return;
    }

    const first = focusable[0]!;
    const last = focusable.at(-1)!;
    const current = document.activeElement;
    const outside = !(current instanceof Node) || !element.contains(current);
    if (event.shiftKey && (current === element || current === first || outside)) {
      event.preventDefault();
      last.focus({ preventScroll: true });
    } else if (!event.shiftKey && (current === element || current === last || outside)) {
      event.preventDefault();
      first.focus({ preventScroll: true });
    }
  };

  onMounted(() => {
    document.addEventListener("fullscreenchange", syncNativeState);
    document.addEventListener("webkitfullscreenchange", syncNativeState);
    window.addEventListener("keydown", onKeydown);
  });

  onBeforeUnmount(() => {
    document.removeEventListener("fullscreenchange", syncNativeState);
    document.removeEventListener("webkitfullscreenchange", syncNativeState);
    window.removeEventListener("keydown", onKeydown);
    restoreBackground();
    if (fallback.value) void exitFallback();
    else {
      target.value?.classList.remove("is-immersive-fullscreen", "is-app-fullscreen");
      delete document.documentElement.dataset.appFullscreen;
      stopViewportTracking();
    }
  });

  return {
    active: readonly(active),
    fallback,
    native: readonly(native),
    enter,
    exit,
    toggle,
  };
};
