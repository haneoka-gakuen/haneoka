import { Vector4 } from "three";
import type { AdvDepthOfFieldVolume } from "./AdvVolumeStack";

/** Serialized by every reference UniversalRenderPipelineAsset, not an editor default. */
export const ADV_URP_COLOR_GRADING_LUT_SIZE = 16;

export function advBloomMappedScatter(scatter: number): number {
  const value = Math.max(0, Math.min(1, Number.isFinite(scatter) ? scatter : 0.7));
  return 0.05 + (0.95 - 0.05) * value;
}

function bloomGammaToLinear(value: number): number {
  if (value <= 0.04045) return value / 12.92;
  if (value < 1) return Math.pow((value + 0.055) / 1.055, 2.4);
  return Math.pow(value, 2.4);
}

/** Compatibility SetupBloom prefilter vector. */
export function advBloomPrefilterParameters(
  settings: Readonly<{ scatter: number; clamp: number; threshold: number }>,
): readonly [scatter: number, clamp: number, thresholdLinear: number, knee: number] {
  const threshold = bloomGammaToLinear(Number.isFinite(settings.threshold) ? settings.threshold : 0.9);
  return [advBloomMappedScatter(settings.scatter), Math.max(0, settings.clamp), threshold, threshold * 0.5];
}

/** UberPost shader variant selected by tonemap mode: none=blob1, ACES=blob2, Neutral=blob3. */
export function advHdrLutBlob(mode: number): 1 | 2 | 3 {
  if (Math.trunc(mode) === 2) return 2;
  if (Math.trunc(mode) === 1) return 3;
  return 1;
}

export type AdvBloomFilterMode = "gaussian" | "dual" | "kawase";

export function resolveAdvBloomFilterMode(value: number): AdvBloomFilterMode {
  switch (Math.trunc(value)) {
    case 1:
      return "dual";
    case 2:
      return "kawase";
    default:
      return "gaussian";
  }
}

/** Pass order in the reference Bloom shader (prefilter is always pass 0). */
export function advBloomPassPlan(filter: number, mipCount: number): readonly number[] {
  const count = Math.max(1, Math.trunc(mipCount));
  const mode = resolveAdvBloomFilterMode(filter);
  if (mode === "kawase") return [0, ...Array.from({ length: count }, () => 4)];
  if (mode === "dual") {
    return [0, ...Array.from({ length: count - 1 }, () => 5), ...Array.from({ length: count - 1 }, () => 6)];
  }
  return [0, ...Array.from({ length: count - 1 }, () => [1, 2]).flat(), ...Array.from({ length: count - 1 }, () => 3)];
}

export interface AdvBokehParameters {
  readonly lensCoefficient: number;
  readonly maxRadius: number;
  readonly reciprocalAspect: number;
  readonly uvMargin: number;
}

export function computeAdvBokehParameters(
  settings: Readonly<AdvDepthOfFieldVolume>,
  width: number,
  height: number,
): AdvBokehParameters {
  const halfWidth = Math.max(1, Math.trunc(width / 2));
  const halfHeight = Math.max(1, Math.trunc(height / 2));
  const focalLengthMeters = settings.focalLength / 1000;
  const apertureDiameter = settings.focalLength / settings.aperture;
  return {
    // PostProcessPass.DoBokehDepthOfField uses the physical-lens expression
    // directly. The serialized ClampedFloatParameters keep this denominator
    // valid; adding an epsilon changes the rendered result for close focus.
    lensCoefficient: (apertureDiameter * focalLengthMeters) / (settings.focusDistance - focalLengthMeters),
    maxRadius: Math.min(0.05, 14 / height),
    reciprocalAspect: halfHeight / halfWidth,
    uvMargin: 2 / height,
  };
}

export function createAdvBokehKernel(
  maxRadius: number,
  reciprocalAspect: number,
  bladeCount: number,
  bladeCurvature: number,
  bladeRotation: number,
): Vector4[] {
  const output: Vector4[] = [];
  const curvature = 1 - bladeCurvature;
  const rotation = bladeRotation * (Math.PI / 180);
  for (let ring = 1; ring < 4; ring += 1) {
    const bias = 1 / 7;
    const radius = (ring + bias) / (3 + bias);
    const points = ring * 7;
    for (let point = 0; point < points; point += 1) {
      const phi = (2 * Math.PI * point) / points;
      const numerator = Math.cos(Math.PI / bladeCount);
      const denominator = Math.cos(
        phi - (2 * Math.PI * Math.floor((bladeCount * phi + Math.PI) / (2 * Math.PI))) / bladeCount,
      );
      const transformedRadius = radius * Math.pow(numerator / denominator, curvature);
      const u = transformedRadius * Math.cos(phi - rotation) * maxRadius;
      const v = transformedRadius * Math.sin(phi - rotation) * maxRadius;
      output.push(new Vector4(u, v, Math.sqrt(u * u + v * v), u * reciprocalAspect));
    }
  }
  return output;
}
