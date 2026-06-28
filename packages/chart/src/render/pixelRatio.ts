/** UIFreeLiveHeader and the original CanvasScaler use a 1920×1080 reference. */
export const NATIVE_RENDER_PIXEL_BUDGET = 1920 * 1080;

/**
 * Preserve up to 2× detail on small screens, then stop supersampling once the
 * framebuffer reaches the native reference pixel count. CSS pixels remain at
 * least 1× so very large viewports never become sub-pixel blurred.
 */
export function nativeRenderPixelRatio(
  width: number,
  height: number,
  devicePixelRatio = globalThis.devicePixelRatio ?? 1,
): number {
  const cssPixels = Math.max(1, width) * Math.max(1, height);
  const nativeBound = Math.sqrt(NATIVE_RENDER_PIXEL_BUDGET / cssPixels);
  return Math.max(1, Math.min(2, Math.max(1, devicePixelRatio), nativeBound));
}
