/**
 * Unity ADV camera command math.
 *
 * `UniversalCamera.UpdateZoom` divides the stage FOV by the current zoom ratio.
 * These helpers stay independent from Three so command scheduling remains testable.
 */
export class AdvCamera {
  static readonly defaultTweenDuration = 0;

  static zoomCommandTargetRatio(baseFocusRatio: number, parameter: unknown): number {
    const base = Math.max(0.001, finite(baseFocusRatio, 1));
    const rawMultiplier = Number(parameter);
    const multiplier = Number.isFinite(rawMultiplier) && rawMultiplier > 0 ? rawMultiplier : 1;
    return base * multiplier;
  }

  static focusTargetY(
    fieldZoomOffsetY: number,
    headWorldY: number | null | undefined,
    characterHeadFocusOffsetY = 0,
  ): number {
    return typeof headWorldY === "number" && Number.isFinite(headWorldY)
      ? headWorldY - finite(characterHeadFocusOffsetY)
      : finite(fieldZoomOffsetY);
  }

  static focusCommandPositionType(
    positionType: number,
    targetName: string,
    targetPosition: (targetName: string) => number,
  ): number {
    const requested = Number(positionType) || 5;
    return targetName ? Number(targetPosition(targetName)) || requested : requested;
  }

  static effectiveFov(baseFov: number, zoomRatio: number): number {
    return Math.max(0.001, finite(baseFov, 39.6) / Math.max(0.001, finite(zoomRatio, 1)));
  }
}

function finite(value: unknown, fallback = 0): number {
  const result = Number(value);
  return Number.isFinite(result) ? result : fallback;
}
