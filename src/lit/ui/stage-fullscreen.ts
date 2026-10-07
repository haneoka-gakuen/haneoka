/**
 * Fullscreen for a model stage (Live2D, Spine).
 *
 * Uses the element Fullscreen API (with WebKit's prefixed names for older
 * iPadOS). iPhone Safari offers no element fullscreen, so there the stage is
 * expanded over the viewport with `data-stage-fullscreen` instead; Escape
 * leaves either mode. The host re-renders through `onChange`.
 */
type FullscreenDocument = Document & {
  webkitFullscreenEnabled?: boolean;
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => void;
};
type FullscreenElement = HTMLElement & { webkitRequestFullscreen?: () => void };

const CHANGE_EVENTS = ["fullscreenchange", "webkitfullscreenchange"] as const;

export class StageFullscreen {
  private target?: HTMLElement;
  private pseudo = false;
  private restore: Array<() => void> = [];
  private listening = false;

  constructor(private readonly onChange: (active: boolean) => void) {}

  get active() {
    return this.pseudo || Boolean(this.target && this.fullscreenElement() === this.target);
  }

  connect() {
    if (this.listening) return;
    this.listening = true;
    for (const name of CHANGE_EVENTS) document.addEventListener(name, this.changed);
    window.addEventListener("keydown", this.keydown, true);
  }

  disconnect() {
    this.exit();
    if (!this.listening) return;
    this.listening = false;
    for (const name of CHANGE_EVENTS) document.removeEventListener(name, this.changed);
    window.removeEventListener("keydown", this.keydown, true);
  }

  async toggle(target: HTMLElement | null) {
    if (this.active) {
      this.exit();
      return;
    }
    if (!target) return;
    this.target = target;
    const doc = document as FullscreenDocument;
    const element = target as FullscreenElement;
    try {
      if (doc.fullscreenEnabled && typeof element.requestFullscreen === "function") {
        await element.requestFullscreen({ navigationUI: "hide" });
        this.lockLandscape();
        return;
      }
      if (doc.webkitFullscreenEnabled && typeof element.webkitRequestFullscreen === "function") {
        element.webkitRequestFullscreen();
        return;
      }
    } catch {
      // Refused (no user activation, policy): fall through to the viewport layout.
    }
    this.enterPseudo(target);
  }

  exit() {
    if (this.pseudo) {
      this.pseudo = false;
      for (const undo of this.restore.splice(0).reverse()) undo();
      this.onChange(false);
      return;
    }
    const doc = document as FullscreenDocument;
    if (this.target && this.fullscreenElement() === this.target) {
      if (doc.fullscreenElement) void doc.exitFullscreen().catch(() => undefined);
      else doc.webkitExitFullscreen?.();
    }
  }

  private fullscreenElement() {
    const doc = document as FullscreenDocument;
    return doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
  }

  private enterPseudo(target: HTMLElement) {
    this.pseudo = true;
    const remember = (element: HTMLElement | null | undefined, property: string, value: string) => {
      if (!element) return;
      const previous = element.style.getPropertyValue(property);
      element.style.setProperty(property, value);
      this.restore.push(() =>
        previous ? element.style.setProperty(property, previous) : element.style.removeProperty(property),
      );
    };
    target.setAttribute("data-stage-fullscreen", "true");
    this.restore.push(() => target.removeAttribute("data-stage-fullscreen"));
    // The shell pane clips its content; a fixed stage must escape it.
    const main = target.closest<HTMLElement>(".app-shell__main");
    remember(main, "clip-path", "none");
    remember(main, "overflow", "visible");
    remember(document.body, "overflow", "hidden");
    remember(document.body, "overscroll-behavior", "none");
    this.onChange(true);
  }

  private lockLandscape() {
    if (!matchMedia("(pointer: coarse)").matches) return;
    const orientation = screen.orientation as
      | (ScreenOrientation & { lock?: (orientation: string) => Promise<void> })
      | undefined;
    orientation?.lock?.("landscape").catch(() => undefined);
  }

  private changed = () => {
    if (!this.pseudo) this.onChange(this.active);
  };

  private keydown = (event: KeyboardEvent) => {
    if (!this.pseudo || event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    this.exit();
  };
}

/**
 * Drag-to-pan, wheel zoom and two-finger pinch on a model stage, always on.
 *
 * Positions are reported in normalised device units (-1..1 across the
 * element), which both runtimes' transforms use. `zoom(ratio, x, y)` scales
 * about the given point.
 */
export interface StageGestureHandlers {
  enabled(): boolean;
  pan(dx: number, dy: number): void;
  zoom(ratio: number, x: number, y: number): void;
  onDraggingChange?(dragging: boolean): void;
}

export class StageGestures {
  private pointers = new Map<number, { x: number; y: number }>();
  private pinchDistance = 0;
  private element?: HTMLElement;

  constructor(private readonly handlers: StageGestureHandlers) {}

  get dragging() {
    return this.pointers.size > 0;
  }

  private normalised(element: HTMLElement, clientX: number, clientY: number) {
    const rect = element.getBoundingClientRect();
    return {
      rect,
      x: ((clientX - rect.left) / rect.width) * 2 - 1,
      y: ((clientY - rect.top) / rect.height) * 2 - 1,
    };
  }

  private pair() {
    const [a, b] = [...this.pointers.values()];
    if (!a || !b) return null;
    return { distance: Math.hypot(a.x - b.x, a.y - b.y), x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }

  down = (event: PointerEvent) => {
    if (!this.handlers.enabled() || (event.pointerType === "mouse" && event.button !== 0)) return;
    event.preventDefault();
    const element = event.currentTarget as HTMLElement;
    this.element = element;
    element.setPointerCapture?.(event.pointerId);
    this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (this.pointers.size === 2) this.pinchDistance = this.pair()?.distance || 0;
    if (this.pointers.size === 1) this.handlers.onDraggingChange?.(true);
  };

  move = (event: PointerEvent) => {
    const previous = this.pointers.get(event.pointerId);
    if (!previous) return;
    const element = event.currentTarget as HTMLElement;
    const rect = element.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    if (this.pointers.size >= 2) {
      const before = this.pair();
      this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      const after = this.pair();
      if (!before || !after || !this.pinchDistance) return;
      // Pan with the midpoint, scale about it.
      this.handlers.pan(((after.x - before.x) / rect.width) * 2, ((after.y - before.y) / rect.height) * 2);
      const ratio = after.distance / (before.distance || after.distance);
      const point = this.normalised(element, after.x, after.y);
      if (Number.isFinite(ratio) && ratio > 0) this.handlers.zoom(ratio, point.x, point.y);
      return;
    }
    this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    this.handlers.pan(((event.clientX - previous.x) / rect.width) * 2, ((event.clientY - previous.y) / rect.height) * 2);
  };

  up = (event: PointerEvent) => {
    if (!this.pointers.delete(event.pointerId)) return;
    const element = event.currentTarget as HTMLElement | null;
    if (element?.hasPointerCapture?.(event.pointerId)) element.releasePointerCapture(event.pointerId);
    this.pinchDistance = this.pointers.size === 2 ? this.pair()?.distance || 0 : 0;
    if (!this.pointers.size) this.handlers.onDraggingChange?.(false);
  };

  wheel = (event: WheelEvent) => {
    if (!this.handlers.enabled() || !Number.isFinite(event.deltaY)) return;
    event.preventDefault();
    const element = event.currentTarget as HTMLElement;
    const { rect, x, y } = this.normalised(element, event.clientX, event.clientY);
    if (!rect.width || !rect.height) return;
    const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? rect.height : 1);
    // Trackpad pinch arrives as ctrl+wheel with small deltas; scale it up.
    this.handlers.zoom(Math.exp(-delta * (event.ctrlKey ? 0.01 : 0.002)), x, y);
  };

  cancel() {
    for (const id of this.pointers.keys())
      if (this.element?.hasPointerCapture?.(id)) this.element.releasePointerCapture(id);
    const had = this.pointers.size > 0;
    this.pointers.clear();
    this.pinchDistance = 0;
    if (had) this.handlers.onDraggingChange?.(false);
  }
}
