import {
  type AdvBaseQualityMode,
  type AdvQualityOverrides,
  isHighOrAboveQuality,
  isMiddleOrAboveQuality,
  isUnityLightingEnabledFor,
  normalizeBaseQualityMode,
} from "../types/AdvQuality";

export {
  DETERMINISTIC_BROWSER_BASE_QUALITY_MODE,
  isUnityLightingEnabledFor,
  normalizeBaseQualityMode,
} from "../types/AdvQuality";

export class AdvQualityConfig {
  readonly baseQualityMode: AdvBaseQualityMode;
  readonly allowUnityLighting: boolean;
  characterBlurEnabled = true;
  backgroundBlurEnabled = true;
  characterPhysicsEnabled = true;
  characterBreathMotionEnabled = true;
  cameraAntiAliasingEnabled = true;
  stageParticleEffectEnabled = true;
  stagePostEffectEnabled = true;

  constructor(quality?: AdvQualityOverrides | null) {
    this.baseQualityMode = normalizeBaseQualityMode(quality?.baseQualityMode);
    this.allowUnityLighting = quality?.allowUnityLighting ?? true;
    if (quality) {
      this.characterBlurEnabled = quality.characterBlurEnabled !== false && quality.allowCharacterBlur !== false;
      this.backgroundBlurEnabled = quality.backgroundBlurEnabled !== false && quality.allowBackgroundBlur !== false;
      this.characterPhysicsEnabled =
        quality.characterPhysicsEnabled !== false && quality.allowCharacterPhysics !== false;
      this.characterBreathMotionEnabled =
        quality.characterBreathMotionEnabled !== false && quality.allowCharacterBreathMotion !== false;
      this.cameraAntiAliasingEnabled = quality.cameraAntiAliasingEnabled !== false;
      this.stageParticleEffectEnabled =
        quality.stageParticleEffectEnabled !== false && quality.allowStageParticleEffect !== false;
      this.stagePostEffectEnabled = quality.stagePostEffectEnabled !== false && quality.allowStagePostEffect !== false;
    }
  }

  isCharacterBlurEnabled() {
    return this.characterBlurEnabled && this.isHighOrAboveQuality();
  }
  isBackgroundBlurEnabled() {
    return this.backgroundBlurEnabled && this.isHighOrAboveQuality();
  }
  isCharacterPhysicsEnabled() {
    return this.characterPhysicsEnabled && this.isMiddleOrAboveQuality();
  }
  isCharacterBreathMotionEnabled() {
    return this.characterBreathMotionEnabled && this.isHighOrAboveQuality();
  }
  isUnityLightingEnabled() {
    return isUnityLightingEnabledFor(this.baseQualityMode, this.allowUnityLighting);
  }
  isCameraAntiAliasingEnabled() {
    return this.cameraAntiAliasingEnabled && this.isHighOrAboveQuality();
  }
  isStageParticleEffectEnabled() {
    return this.stageParticleEffectEnabled && this.isMiddleOrAboveQuality();
  }
  isStagePostEffectEnabled() {
    return this.stagePostEffectEnabled && this.isHighOrAboveQuality();
  }

  /** AdvQualityConfig.IsMiddleOrAboveQuality. */
  isMiddleOrAboveQuality() {
    return isMiddleOrAboveQuality(this.baseQualityMode);
  }

  /** AdvQualityConfig.IsHighOrAboveQuality. */
  isHighOrAboveQuality() {
    return isHighOrAboveQuality(this.baseQualityMode);
  }
}
