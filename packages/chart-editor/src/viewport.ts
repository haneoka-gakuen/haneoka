/**
 * A vertical rhythm-editor viewport whose time axis runs from bottom to top.
 *
 * `startSeconds` is the time at the bottom edge (`y === height`). Later
 * timestamps are rendered higher on screen, at smaller y coordinates.
 */
export interface VerticalTimeViewport {
  startSeconds: number;
  pixelsPerSecond: number;
  height: number;
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
  return viewport.height - (seconds - viewport.startSeconds) * viewport.pixelsPerSecond;
};

/** Convert a canvas y coordinate to an authored/audio timestamp. */
export const viewportYToTime = (y: number, viewport: VerticalTimeViewport): number => {
  finite(y, "Viewport y");
  validateViewport(viewport);
  return viewport.startSeconds + (viewport.height - y) / viewport.pixelsPerSecond;
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
    startSeconds: viewport.startSeconds + contentDeltaY / viewport.pixelsPerSecond,
  };
};

/**
 * Scroll a bottom-up timeline using the platform wheel convention.
 * Positive `scrollDeltaY` moves the document towards later content, so the
 * rendered chart travels up the screen.
 */
export const scrollVerticalTimeViewport = (
  viewport: VerticalTimeViewport,
  scrollDeltaY: number,
): VerticalTimeViewport => {
  validateViewport(viewport);
  finite(scrollDeltaY, "Wheel scroll delta");
  return {
    ...viewport,
    startSeconds: viewport.startSeconds - scrollDeltaY / viewport.pixelsPerSecond,
  };
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
  return {
    ...viewport,
    startSeconds: anchorSeconds - (viewport.height - anchorY) / nextPixelsPerSecond,
    pixelsPerSecond: nextPixelsPerSecond,
  };
};
