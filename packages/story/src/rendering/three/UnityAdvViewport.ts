export interface UnityNormalizedViewport {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export const FULL_UNITY_VIEWPORT: UnityNormalizedViewport = Object.freeze({
  x: 0,
  y: 0,
  width: 1,
  height: 1,
});

/** Target aspect ratio selection, mirroring AdvCameraConfig.GetTargetAspectRatio. */
export function unityAdvTargetAspect(screenWidth: number, screenHeight: number, baseAspect = 16 / 9): number {
  const safeBase = Number.isFinite(baseAspect) && baseAspect > 0 ? baseAspect : 16 / 9;
  return screenWidth > screenHeight ? Math.max(safeBase, 13 / 6) : safeBase;
}

/**
 * The Vue host is deliberately a landscape canvas even while the display is
 * portrait. Keep display orientation separate from the constrained host size
 * so the portrait 16:9 policy is not clamped a second time to 13:6.
 */
export function unityAdvOrientedTargetAspect(
  displayPortrait: boolean,
  screenWidth: number,
  screenHeight: number,
  landscapeBaseAspect = 16 / 9,
  portraitTargetAspect = 16 / 9,
  landscapeTargetAspect?: number,
): number {
  if (!displayPortrait) {
    return Number.isFinite(landscapeTargetAspect) && Number(landscapeTargetAspect) > 0
      ? Number(landscapeTargetAspect)
      : unityAdvTargetAspect(screenWidth, screenHeight, landscapeBaseAspect);
  }
  return Number.isFinite(portraitTargetAspect) && portraitTargetAspect > 0 ? portraitTargetAspect : 16 / 9;
}

/** Letterboxed viewport construction, mirroring AdvCameraConfig.CreateViewport. */
export function createUnityAdvViewport(
  screenWidth: number,
  screenHeight: number,
  targetAspect: number,
): UnityNormalizedViewport {
  if (screenWidth <= 0 || screenHeight <= 0 || targetAspect <= 0) return FULL_UNITY_VIEWPORT;
  const screenAspect = screenWidth / screenHeight;
  if (screenAspect + 0.0001 >= targetAspect) return FULL_UNITY_VIEWPORT;
  const ratio = screenAspect / targetAspect;
  const bandPixels = ((1 - ratio) * screenHeight) / 2;
  if (bandPixels <= 1) return FULL_UNITY_VIEWPORT;
  return { x: 0, y: (1 - ratio) / 2, width: 1, height: ratio };
}
