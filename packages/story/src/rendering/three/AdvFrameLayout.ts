import type { AdvFrameEntry } from "../../types/AdvRuntime";

export interface AdvFrameBandLayout {
  readonly bandHeight: number;
  readonly topOffset: number;
  readonly bottomOffset: number;
  readonly color: string;
}

export interface AdvFrameAnimatorSample {
  readonly opacity: number;
  /** 1 is the authored off-screen position; 0 is the visible position. */
  readonly slide: number;
}

function finite(value: unknown, fallback: number): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function clamp01(value: unknown): number {
  return Math.max(0, Math.min(1, finite(value, 0)));
}

function smoothstep01(value: unknown): number {
  const t = clamp01(value);
  return t * t * (3 - 2 * t);
}

function frameColor(value: unknown): string {
  const color = String(value || "")
    .trim()
    .toLowerCase();
  if (color === "white") return "#ffffff";
  if (color === "black") return "#000000";
  return /^#[0-9a-f]{6}$/i.test(color) ? color : "#000000";
}

/**
 * Reproduces FrameCanvas' CanvasScaler (1920x1080, Match Width) and the
 * letterbox prefab's 70 px bands / 200 px off-screen travel.
 */
export function computeAdvFrameBandLayout(
  frame: Pick<AdvFrameEntry, "bandHeight" | "color" | "referenceWidth" | "slideDistance">,
  viewportWidth: number,
  slide: number,
): AdvFrameBandLayout {
  const referenceWidth = Math.max(1, finite(frame.referenceWidth, 1920));
  const scale = Math.max(0, finite(viewportWidth, 0)) / referenceWidth;
  const bandHeight = Math.max(0, finite(frame.bandHeight, 70)) * scale;
  const travel = Math.max(0, finite(frame.slideDistance, 200)) * scale * clamp01(slide);
  return {
    bandHeight,
    topOffset: travel === 0 ? 0 : -travel,
    bottomOffset: travel,
    color: frameColor(frame.color),
  };
}

/**
 * frame_letterbox_in/out streamed AnimationClip curves. Both clips last 0.5s:
 * band travel uses smoothstep over the whole clip, while CanvasGroup alpha
 * changes only during the first/last 1/12s (one sixth of normalized time).
 */
export function sampleAdvLetterboxAnimator(
  stateName: string,
  normalizedTime: number,
  canvasAlpha: number,
): AdvFrameAnimatorSample {
  const time = clamp01(normalizedTime);
  const alpha = Math.max(0, finite(canvasAlpha, 0.8));
  const hide = /hide/i.test(stateName);
  const slide = hide ? smoothstep01(time) : 1 - smoothstep01(time);
  const alphaProgress = hide ? smoothstep01((time - 5 / 6) * 6) : smoothstep01(time * 6);
  return {
    opacity: hide ? alpha * (1 - alphaProgress) : alpha * alphaProgress,
    slide,
  };
}
