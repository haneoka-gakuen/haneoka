export type AdvEffectPhase = "advBack" | "character" | "advFront" | "ui";

export interface AdvEffectRoute {
  readonly phase: AdvEffectPhase;
  readonly unityLayer: number;
  /** Native SetSortOrder overwrites every child Renderer with this value. */
  readonly sortingOrder: number;
  readonly positionType?: 1 | 3 | 5 | 7 | 9;
  readonly canvasLayer?: number;
}

const CHARACTER_POSITION_TYPES = new Set([1, 3, 5, 7, 9]);

/** Only CanvasLayers[0] is consulted when routing an effect, mirroring AdvEffectCommand.SetEffect. */
export function resolveAdvEffectRoute(
  canvasLayers: readonly unknown[] | null | undefined,
  positionType: unknown,
): AdvEffectRoute {
  const firstLayer = Array.isArray(canvasLayers) && canvasLayers.length ? Number(canvasLayers[0]) : Number.NaN;
  if (firstLayer === 0 || firstLayer === 1) {
    return { phase: "advBack", unityLayer: 12, sortingOrder: 1, canvasLayer: firstLayer };
  }
  if (Number.isInteger(firstLayer) && firstLayer >= 4 && firstLayer <= 8) {
    // TrueCanvasSortOrder is a common base. Keeping the enum value preserves
    // the exact relative order inside the dedicated post-camera UI phase.
    return { phase: "ui", unityLayer: 5, sortingOrder: firstLayer, canvasLayer: firstLayer };
  }
  const position = Number(positionType);
  if (CHARACTER_POSITION_TYPES.has(position)) {
    return {
      phase: "character",
      unityLayer: 6 + (position - 1) / 2,
      sortingOrder: 10_000,
      positionType: position as 1 | 3 | 5 | 7 | 9,
    };
  }
  return { phase: "advFront", unityLayer: 13, sortingOrder: 0 };
}
