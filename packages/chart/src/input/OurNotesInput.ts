export interface InputPoint {
  pointerId: number;
  x: number;
  y: number;
  /** Native continuous lane-centre coordinate (0..23), or -1 outside the accepted margin. */
  lane: number;
  timeMs: number;
}

export interface FlickInput extends InputPoint {
  dx: number;
  dy: number;
  previousLane: number;
}

export interface OurNotesInputHandlers {
  tap(point: InputPoint): void;
  move?(point: InputPoint): void;
  release?(point: InputPoint): void;
  flick?(point: FlickInput): void;
  cancel?(pointerId: number): void;
}

export interface OurNotesInputOptions {
  now?: () => number;
  laneAtClientPoint: (clientX: number, clientY: number) => number;
  screenDpi?: number;
  flickDistanceCm?: number;
}

interface PointerState extends InputPoint {
  previousX: number;
  previousY: number;
  previousLane: number;
  previousFrameTimeMs: number;
}

/**
 * Browser adapter for LiveInputManager.Update and GetFlickState. Only the
 * first four active fingers participate.
 */
export class OurNotesInput {
  private readonly pointers = new Map<number, PointerState>();
  private readonly now: () => number;
  private readonly dpi: number;
  private readonly flickDistanceCm: number;
  private readonly previousTouchAction: string;

  constructor(
    private readonly element: HTMLElement,
    private readonly handlers: OurNotesInputHandlers,
    private readonly options: OurNotesInputOptions,
  ) {
    this.now = options.now ?? (() => performance.now());
    this.dpi = options.screenDpi ?? 96;
    this.flickDistanceCm = options.flickDistanceCm ?? 0.1;
    this.previousTouchAction = element.style.touchAction;
    element.style.touchAction = "none";
    element.addEventListener("pointerdown", this.onPointerDown, { passive: false });
    element.addEventListener("pointermove", this.onPointerMove, { passive: false });
    element.addEventListener("pointerup", this.onPointerUp, { passive: false });
    element.addEventListener("pointercancel", this.onPointerCancel, { passive: false });
    element.addEventListener("contextmenu", this.preventDefault);
    element.addEventListener("dblclick", this.preventDefault);
    element.addEventListener("dragstart", this.preventDefault);
    element.addEventListener("selectstart", this.preventDefault);
    window.addEventListener("blur", this.cancelAll);
    window.addEventListener("pagehide", this.cancelAll);
    document.addEventListener("visibilitychange", this.onVisibilityChange);
  }

  destroy(): void {
    this.element.removeEventListener("pointerdown", this.onPointerDown);
    this.element.removeEventListener("pointermove", this.onPointerMove);
    this.element.removeEventListener("pointerup", this.onPointerUp);
    this.element.removeEventListener("pointercancel", this.onPointerCancel);
    this.element.removeEventListener("contextmenu", this.preventDefault);
    this.element.removeEventListener("dblclick", this.preventDefault);
    this.element.removeEventListener("dragstart", this.preventDefault);
    this.element.removeEventListener("selectstart", this.preventDefault);
    window.removeEventListener("blur", this.cancelAll);
    window.removeEventListener("pagehide", this.cancelAll);
    document.removeEventListener("visibilitychange", this.onVisibilityChange);
    this.element.style.touchAction = this.previousTouchAction;
    this.cancelAll();
  }

  get activePoints(): ReadonlyArray<InputPoint> {
    return [...this.pointers.values()].map(({ pointerId, x, y, lane, timeMs }) => ({ pointerId, x, y, lane, timeMs }));
  }

  private point(event: PointerEvent, timeMs: number): InputPoint {
    const rect = this.element.getBoundingClientRect();
    return {
      pointerId: event.pointerId,
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
      lane: this.options.laneAtClientPoint(event.clientX, event.clientY),
      timeMs,
    };
  }

  private readonly preventDefault = (event: Event): void => {
    if (event.cancelable) event.preventDefault();
  };

  private preventPointerDefault(event: PointerEvent): void {
    if (event.pointerType !== "mouse") this.preventDefault(event);
  }

  private readonly cancelAll = (): void => {
    for (const pointerId of this.pointers.keys()) this.handlers.cancel?.(pointerId);
    this.pointers.clear();
  };

  private readonly onVisibilityChange = (): void => {
    if (document.visibilityState === "hidden") this.cancelAll();
  };

  private readonly onPointerDown = (event: PointerEvent): void => {
    this.preventPointerDefault(event);
    if (this.pointers.size >= 4 || this.pointers.has(event.pointerId)) return;
    const point = this.point(event, this.now());
    this.element.setPointerCapture?.(event.pointerId);
    this.pointers.set(event.pointerId, {
      ...point,
      previousX: point.x,
      previousY: point.y,
      previousLane: point.lane,
      previousFrameTimeMs: point.timeMs,
    });
    this.handlers.tap(point);
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    this.preventPointerDefault(event);
    const state = this.pointers.get(event.pointerId);
    if (!state) return;
    const point = this.point(event, this.now());
    const rawDx = point.x - state.previousX;
    const rawDy = point.y - state.previousY;
    const deltaSeconds = Math.max(0, point.timeMs - state.previousFrameTimeMs) / 1000;
    const frameScale = Math.max(deltaSeconds / (1 / 60), 1);
    const moveX = rawDx / frameScale;
    const moveY = rawDy / frameScale;
    const threshold = (this.dpi / 2.54) * this.flickDistanceCm;
    if (moveX * moveX + moveY * moveY > threshold * threshold) {
      // Unity returns the raw screen delta; it uses the previous position's lane for flick judgement.
      this.handlers.flick?.({
        ...point,
        lane: state.previousLane,
        previousLane: state.previousLane,
        dx: rawDx,
        dy: rawDy,
      });
    }
    this.handlers.move?.(point);
    state.previousX = point.x;
    state.previousY = point.y;
    state.previousLane = point.lane;
    state.previousFrameTimeMs = point.timeMs;
    state.x = point.x;
    state.y = point.y;
    state.lane = point.lane;
    state.timeMs = point.timeMs;
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    this.preventPointerDefault(event);
    const state = this.pointers.get(event.pointerId);
    if (!state) return;
    const point = this.point(event, this.now());
    // Ended participates in flick detection in the original input manager.
    this.onPointerMove(event);
    this.handlers.release?.(point);
    this.pointers.delete(event.pointerId);
  };

  private readonly onPointerCancel = (event: PointerEvent): void => {
    this.preventPointerDefault(event);
    if (!this.pointers.delete(event.pointerId)) return;
    // Browser/system cancellation is not Unity's Ended phase: clear the
    // claim without creating a flick or accepting a slide-end judgment.
    this.handlers.cancel?.(event.pointerId);
  };
}
