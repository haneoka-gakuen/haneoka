/** Unity's serialized BaseQualityMode values. */
export const AdvBaseQualityMode = Object.freeze({
  Worst: 0,
  Low: 1,
  Middle: 2,
  High: 3,
  Best: 4,
} as const);

export type AdvBaseQualityMode = (typeof AdvBaseQualityMode)[keyof typeof AdvBaseQualityMode];

/**
 * AdvPlayerSettings.asset, indexed by the serialized BaseQualityMode value.
 * The asset lists the fields Best -> Worst; these tables intentionally follow
 * the enum's Worst -> Best numeric order.
 */
export const ADV_TARGET_FRAME_RATE_BY_QUALITY = [30, 30, 45, 60, 60] as const;
export const ADV_RENDER_SCALE_BY_QUALITY = [1, 1, 1, 1, 1] as const;

export type AdvQualityNumberTable = readonly [number, number, number, number, number];

/**
 * Browser policy, not a runtime-wide default. The reference runtime chooses
 * and persists BaseQualityMode from the device score on first setup.
 */
// Desktop browsers are assigned High deliberately so the browser lighting,
// blur, and post stack take the same fully enabled branch as a
// High-scored Unity device. Hosts can still select any serialized mode.
export const DETERMINISTIC_BROWSER_BASE_QUALITY_MODE = AdvBaseQualityMode.High;
export const DETERMINISTIC_BROWSER_TARGET_FRAME_RATE = 60;

export function normalizeBaseQualityMode(value: unknown): AdvBaseQualityMode {
  const mode = Number(value);
  if (mode === 0 || mode === 1 || mode === 2 || mode === 3 || mode === 4) return mode;
  return DETERMINISTIC_BROWSER_BASE_QUALITY_MODE;
}

export function qualityTableValue(
  table: AdvQualityNumberTable | readonly number[] | undefined,
  baseQualityMode: AdvBaseQualityMode,
  fallback: AdvQualityNumberTable,
): number {
  const value = Number(table?.[baseQualityMode]);
  return Number.isFinite(value) ? value : fallback[baseQualityMode];
}

/** AdvQualityConfig.IsMiddleOrAboveQuality. */
export function isMiddleOrAboveQuality(baseQualityMode: AdvBaseQualityMode): boolean {
  return baseQualityMode > AdvBaseQualityMode.Low;
}

/** AdvQualityConfig.IsHighOrAboveQuality. */
export function isHighOrAboveQuality(baseQualityMode: AdvBaseQualityMode): boolean {
  return baseQualityMode > AdvBaseQualityMode.Middle;
}

/** AdvQualityConfig.IsUnityLightingEnabled. */
export function isUnityLightingEnabledFor(baseQualityMode: AdvBaseQualityMode, allowUnityLighting = true): boolean {
  return allowUnityLighting && isHighOrAboveQuality(baseQualityMode);
}

export interface AdvQualityOverrides {
  baseQualityMode?: AdvBaseQualityMode;
  allowUnityLighting?: boolean;
  allowCharacterBlur?: boolean;
  allowBackgroundBlur?: boolean;
  allowCharacterPhysics?: boolean;
  allowCharacterBreathMotion?: boolean;
  allowStageParticleEffect?: boolean;
  allowStagePostEffect?: boolean;
  characterBlurEnabled?: boolean;
  backgroundBlurEnabled?: boolean;
  characterPhysicsEnabled?: boolean;
  characterBreathMotionEnabled?: boolean;
  cameraAntiAliasingEnabled?: boolean;
  stageParticleEffectEnabled?: boolean;
  stagePostEffectEnabled?: boolean;
}
