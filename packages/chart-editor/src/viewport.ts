/** A vertical rhythm-editor viewport. Time runs upwards by default. */
export interface VerticalTimeViewport {
  /** Earliest visible time, at the bottom edge by default or the top edge in top-down mode. */
  startSeconds: number;
  pixelsPerSecond: number;
  height: number;
  topDown?: boolean;
}

const finite = (value: number, label: string): number => {
  if (!Number.isFinite(value)) throw new TypeError(`${label} must be finite`);
  return value;
};

const validateViewport = (viewport: VerticalTimeViewport): void => {
  finite(viewport.startSeconds, "Viewport start");
  finite(viewport.pixelsPerSecond, "Viewport scale");
  finite(viewport.height, "Viewport height");
  if (viewport.pixelsPerSecond <= 0) throw new RangeError("Viewport scale must be positive");
  if (viewport.height < 0) throw new RangeError("Viewport height must not be negative");
};

/** Convert an authored/audio timestamp to a canvas y coordinate. */
export const timeToViewportY = (seconds: number, viewport: VerticalTimeViewport): number => {
  finite(seconds, "Time");
  validateViewport(viewport);
  const distance = (seconds - viewport.startSeconds) * viewport.pixelsPerSecond;
  return viewport.topDown ? distance : viewport.height - distance;
};

/** Convert a canvas y coordinate to an authored/audio timestamp. */
export const viewportYToTime = (y: number, viewport: VerticalTimeViewport): number => {
  finite(y, "Viewport y");
  validateViewport(viewport);
  const distance = viewport.topDown ? y : viewport.height - y;
  return viewport.startSeconds + distance / viewport.pixelsPerSecond;
};

/**
 * Move the viewport so that its content follows a vertical pointer drag.
 * Positive `contentDeltaY` means the content was dragged down the screen.
 */
export const panVerticalTimeViewport = (
  viewport: VerticalTimeViewport,
  contentDeltaY: number,
): VerticalTimeViewport => {
  validateViewport(viewport);
  finite(contentDeltaY, "Content drag delta");
  return {
    ...viewport,
    startSeconds: viewport.startSeconds + (viewport.topDown ? -contentDeltaY : contentDeltaY) / viewport.pixelsPerSecond,
  };
};

/**
 * Scroll the timeline using the platform wheel convention.
 * Positive `scrollDeltaY` moves the rendered chart up the screen.
 */
export const scrollVerticalTimeViewport = (
  viewport: VerticalTimeViewport,
  scrollDeltaY: number,
): VerticalTimeViewport => {
  return panVerticalTimeViewport(viewport, -scrollDeltaY);
};

/**
 * Change scale while preserving the exact timestamp beneath `anchorY`.
 * The anchor may be inside or outside the visible canvas.
 */
export const zoomVerticalTimeViewportAtY = (
  viewport: VerticalTimeViewport,
  nextPixelsPerSecond: number,
  anchorY: number,
): VerticalTimeViewport => {
  validateViewport(viewport);
  finite(nextPixelsPerSecond, "Next viewport scale");
  finite(anchorY, "Zoom anchor y");
  if (nextPixelsPerSecond <= 0) throw new RangeError("Next viewport scale must be positive");

  const anchorSeconds = viewportYToTime(anchorY, viewport);
  const distance = viewport.topDown ? anchorY : viewport.height - anchorY;
  return {
    ...viewport,
    startSeconds: anchorSeconds - distance / nextPixelsPerSecond,
    pixelsPerSecond: nextPixelsPerSecond,
  };
};
