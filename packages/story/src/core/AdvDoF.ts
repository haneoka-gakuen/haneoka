/** AdvCanvasLayer values handled by AdvDoFCommand. */
export const ADV_DOF_CANVAS_LAYER = Object.freeze({
  Background: 0,
  Character: 2,
} as const);

export type AdvDoFTarget = "background" | "character";

/**
 * Reproduces the native switch.
 * Empty CanvasLayers is a distinct character-only path; unsupported layers
 * are logged by Unity and produce no renderer task.
 */
export function advDoFTargets(canvasLayers: readonly unknown[] | null | undefined): AdvDoFTarget[] {
  if (!canvasLayers?.length) return ["character"];
  const targets: AdvDoFTarget[] = [];
  for (const value of canvasLayers) {
    const layer = Number(value);
    if (layer === ADV_DOF_CANVAS_LAYER.Background) targets.push("background");
    else if (layer === ADV_DOF_CANVAS_LAYER.Character) targets.push("character");
  }
  return targets;
}
