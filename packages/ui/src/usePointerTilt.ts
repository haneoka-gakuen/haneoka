import { onBeforeUnmount } from "vue";

export interface UiPointerTiltOptions {
  prefix: string;
  strength: number | (() => number);
  restingX?: number;
  restingY?: number;
}

const clampUnit = (value: number) => Math.max(0, Math.min(1, value));

export function usePointerTilt(options: UiPointerTiltOptions) {
  let frame = 0;
  let target: HTMLElement | undefined;
  let bounds: DOMRect | undefined;
  let clientX = 0;
  let clientY = 0;

  const supported = (event: PointerEvent) =>
    event.pointerType !== "touch" &&
    !window.matchMedia("(prefers-reduced-motion: reduce)").matches &&
    window.matchMedia("(hover: hover) and (pointer: fine)").matches;

  const cancelFrame = () => {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
  };

  const flush = () => {
    frame = 0;
    if (!target || !bounds?.width || !bounds.height) return;

    const x = clampUnit((clientX - bounds.left) / bounds.width);
    const y = clampUnit((clientY - bounds.top) / bounds.height);
    const strength = typeof options.strength === "function" ? options.strength() : options.strength;
    target.style.setProperty(`--${options.prefix}-pointer-x`, `${x * 100}%`);
    target.style.setProperty(`--${options.prefix}-pointer-y`, `${y * 100}%`);
    target.style.setProperty(`--${options.prefix}-tilt-x`, `${(0.5 - y) * strength}deg`);
    target.style.setProperty(`--${options.prefix}-tilt-y`, `${(x - 0.5) * strength}deg`);
  };

  const schedule = (event: PointerEvent) => {
    if (!supported(event)) return;
    const nextTarget = event.currentTarget as HTMLElement;
    if (target !== nextTarget || !bounds) {
      target = nextTarget;
      bounds = nextTarget.getBoundingClientRect();
    }
    clientX = event.clientX;
    clientY = event.clientY;
    if (!frame) frame = requestAnimationFrame(flush);
  };

  const onPointerEnter = (event: PointerEvent) => {
    bounds = undefined;
    schedule(event);
  };

  const onPointerMove = (event: PointerEvent) => schedule(event);

  const reset = (event: PointerEvent) => {
    cancelFrame();
    const element = event.currentTarget as HTMLElement;
    element.style.setProperty(`--${options.prefix}-pointer-x`, `${options.restingX ?? 50}%`);
    element.style.setProperty(`--${options.prefix}-pointer-y`, `${options.restingY ?? 38}%`);
    element.style.setProperty(`--${options.prefix}-tilt-x`, "0deg");
    element.style.setProperty(`--${options.prefix}-tilt-y`, "0deg");
    target = undefined;
    bounds = undefined;
  };

  onBeforeUnmount(cancelFrame);

  return {
    onPointerCancel: reset,
    onPointerEnter,
    onPointerLeave: reset,
    onPointerMove,
  };
}
