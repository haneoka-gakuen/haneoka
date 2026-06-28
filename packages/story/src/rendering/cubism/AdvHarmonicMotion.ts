import type { CubismParameterBlend } from "./AdvCubismModel";

const HARMONIC_TAU = Math.PI * 2;

export interface AdvHarmonicMotionParameter {
  readonly id?: string;
  readonly channel?: number;
  readonly direction?: number;
  readonly normalizedOrigin?: number;
  readonly normalizedRange?: number;
  readonly duration?: number;
}

export interface AdvHarmonicMotionData {
  readonly blendMode?: number;
  readonly channelTimescales?: readonly number[];
  readonly parameters?: readonly AdvHarmonicMotionParameter[];
}

export interface AdvHarmonicParameterSource {
  parameterRange(id: string): { minimum: number; maximum: number } | null;
}

function finite(value: unknown, fallback = 0): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function clamp(value: unknown, minimum = 0, maximum = 1): number {
  return Math.max(minimum, Math.min(maximum, finite(value)));
}

/**
 * CubismHarmonicMotionController evaluation for the Unity ADV runtime. This is
 * shared by the story scene and the standalone model viewer; stock CubismBreath
 * is deliberately not used by either path.
 */
export function evaluateAdvHarmonicMotion(
  source: AdvHarmonicMotionData | null | undefined,
  elapsedSeconds: number,
  model: AdvHarmonicParameterSource,
  result: CubismParameterBlend[] = [],
): CubismParameterBlend[] {
  const parameters = Array.isArray(source?.parameters) ? source.parameters : [];
  const timescales = Array.isArray(source?.channelTimescales) ? source.channelTimescales : [1];
  const modeRaw = Math.trunc(finite(source?.blendMode));
  const mode: 0 | 1 | 2 = modeRaw === 1 || modeRaw === 2 ? modeRaw : 0;
  let resultCount = 0;

  for (const parameter of parameters) {
    const id = String(parameter?.id || "");
    const duration = finite(parameter?.duration);
    if (!id || duration <= 0) continue;
    const range = model.parameterRange(id);
    if (!range) continue;

    const channel = Math.max(0, Math.trunc(finite(parameter?.channel)));
    const timescale = finite(timescales[channel], 1);
    const direction = Math.trunc(finite(parameter?.direction, 2));
    const valueRange = range.maximum - range.minimum;
    let origin = range.minimum + clamp(parameter?.normalizedOrigin) * valueRange;
    let amplitude = clamp(parameter?.normalizedRange) * valueRange;

    if (direction === 0) {
      if (origin - amplitude < range.minimum) {
        amplitude = (origin - range.minimum) * 0.5;
        origin = range.minimum + amplitude;
      } else {
        amplitude *= 0.5;
        origin -= amplitude;
      }
    } else if (direction === 1) {
      if (origin + amplitude > range.maximum) {
        amplitude = (range.maximum - origin) * 0.5;
        origin = range.maximum - amplitude;
      } else {
        amplitude *= 0.5;
        origin += amplitude;
      }
    }

    if (origin - amplitude < range.minimum) amplitude = origin - range.minimum;
    else if (origin + amplitude > range.maximum) amplitude = range.maximum - origin;

    const phase = ((Math.max(0, finite(elapsedSeconds)) * timescale) % duration) / duration;
    const value = origin + amplitude * Math.sin(phase * HARMONIC_TAU);
    const reusable = result[resultCount] as { id: string; mode: 0 | 1 | 2; value: number } | undefined;
    if (reusable) {
      reusable.id = id;
      reusable.mode = mode;
      reusable.value = value;
    } else {
      result.push({ id, mode, value });
    }
    resultCount += 1;
  }

  result.length = resultCount;
  return result;
}

export class AdvHarmonicMotionController {
  private elapsedSeconds = 0;
  private data: AdvHarmonicMotionData | null;

  constructor(data: AdvHarmonicMotionData | null = null) {
    this.data = data;
  }

  configure(data: AdvHarmonicMotionData | null | undefined): void {
    this.data = data ?? null;
    this.elapsedSeconds = 0;
  }

  reset(): void {
    this.elapsedSeconds = 0;
  }

  advance(deltaSeconds: number, model: AdvHarmonicParameterSource): CubismParameterBlend[] {
    this.elapsedSeconds += Math.max(0, finite(deltaSeconds));
    return evaluateAdvHarmonicMotion(this.data, this.elapsedSeconds, model);
  }

  current(model: AdvHarmonicParameterSource): CubismParameterBlend[] {
    return evaluateAdvHarmonicMotion(this.data, this.elapsedSeconds, model);
  }
}
