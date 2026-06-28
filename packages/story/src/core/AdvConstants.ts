import type { AdvFocusDataRow, AdvRuntimeConfig } from "../types/AdvRuntime";
import {
  ADV_RENDER_SCALE_BY_QUALITY,
  ADV_TARGET_FRAME_RATE_BY_QUALITY,
  AdvBaseQualityMode,
  DETERMINISTIC_BROWSER_TARGET_FRAME_RATE,
  normalizeBaseQualityMode,
  qualityTableValue,
} from "../types/AdvQuality";

export const ADV_COMMAND = Object.freeze({
  In: 0,
  Out: 1,
  Talk: 2,
  Delay: 3,
  Shake: 4,
  FadeOut: 5,
  FadeIn: 6,
  Focus: 7,
  Forward: 9,
  Back: 10,
  Flash: 11,
  Brightness: 12,
  MoveToRight: 13,
  MoveToLeft: 14,
  Bgm: 15,
  SoundVolume: 16,
  Expression: 17,
  Pause: 18,
  Resume: 19,
  Location: 20,
  Motion: 21,
  Character: 23,
  Costume: 24,
  Stage: 25,
  Movie: 26,
  Clip: 27,
  Subtitles: 28,
  Wait: 29,
  Still: 30,
  Se: 31,
  Angle: 32,
  Pan: 33,
  Tilt: 34,
  TalkWindow: 35,
  ChatWindow: 36,
  ChatTalk: 37,
  ChatStamp: 38,
  ChatRead: 39,
  ChoiceSet: 40,
  ChoiceShow: 41,
  GoTo: 42,
  PostEffect: 43,
  Frame: 44,
  Timeline: 45,
  Look: 46,
  Pedestal: 47,
  Track: 48,
  DoF: 49,
  Role: 50,
  CameraShake: 51,
  Voice: 52,
  Zoom: 53,
  Effect: 54,
  Alpha: 55,
  ForceAuto: 56,
  StageEnv: 57,
  RimLight: 58,
  CancelDelay: 59,
  MoveToUp: 60,
  MoveToDown: 61,
  MoveToForward: 62,
  MoveToBack: 63,
  MoveToDirection: 64,
  ChatTyping: 65,
  LookTarget: 66,
  PanV2: 67,
  /** Generic Story opcode namespace begins at 500. */
  CommandGroup: 500,
});

export const ADV_CAMERA_DISTANCE = Object.freeze({
  KneeShot: 0,
  WaistShot: 1,
  BustShot: 2,
  UpShot: 3,
  CloseUp: 4,
  BigCloseUp: 5,
  DetailShot: 6,
});

export const ADV_POSITION_TYPE = Object.freeze({
  None: 0,
  Position1: 1,
  Position1To2: 2,
  Position2: 3,
  Position2To3: 4,
  Position3: 5,
  Position3To4: 6,
  Position4: 7,
  Position4To5: 8,
  Position5: 9,
});

export const ADV_CANVAS_LAYER = Object.freeze({
  Background: 0,
  Overlay: 1,
  Character: 2,
  Foreground: 3,
  Chat: 4,
  Frame: 5,
  Video: 6,
  Still: 7,
  Front: 8,
  Talk: 9,
});

export const ADV_STAGE_ENV_TYPE = Object.freeze({
  All: 0,
  Light: 1,
  Effect: 2,
  PostEffect: 3,
  FocusPosition: 4,
});

export const ADV_PLAYBACK_SPEED = Object.freeze({
  Normal: 10,
  OnePointFive: 15,
  OnePointSeven: 17,
  Double: 20,
});

export const FOCUS_DATA_SIRIUS = Object.freeze([
  {
    cameraDistance: 0,
    fieldZoomRatio: 1,
    fieldZoomOffsetY: 0,
    characterBlurIntensity: 0,
    backgroundBlurIntensity: 0,
    characterHeadFocusOffsetY: 0.8,
  },
  {
    cameraDistance: 1,
    fieldZoomRatio: 1.2,
    fieldZoomOffsetY: 0.05,
    characterBlurIntensity: 0,
    backgroundBlurIntensity: 0,
    characterHeadFocusOffsetY: 0.6,
  },
  {
    cameraDistance: 2,
    fieldZoomRatio: 1.4,
    fieldZoomOffsetY: 0.1,
    characterBlurIntensity: 0,
    backgroundBlurIntensity: 0,
    characterHeadFocusOffsetY: 0.4,
  },
  {
    cameraDistance: 3,
    fieldZoomRatio: 1.8,
    fieldZoomOffsetY: 0.2,
    characterBlurIntensity: 1,
    backgroundBlurIntensity: 1,
    characterHeadFocusOffsetY: 0.25,
  },
  {
    cameraDistance: 4,
    fieldZoomRatio: 2.8,
    fieldZoomOffsetY: 0.36,
    characterBlurIntensity: 1,
    backgroundBlurIntensity: 1,
    characterHeadFocusOffsetY: 0.1,
  },
  {
    cameraDistance: 5,
    fieldZoomRatio: 4.0,
    fieldZoomOffsetY: 0.44,
    characterBlurIntensity: 1,
    backgroundBlurIntensity: 1,
    characterHeadFocusOffsetY: 0.05,
  },
  {
    cameraDistance: 6,
    fieldZoomRatio: 6.0,
    fieldZoomOffsetY: 0.5,
    characterBlurIntensity: 1,
    backgroundBlurIntensity: 1,
    characterHeadFocusOffsetY: 0.025,
  },
]);

export const FOCUS_DATA_SETTINGS1 = Object.freeze([
  {
    cameraDistance: 0,
    fieldZoomRatio: 1,
    fieldZoomOffsetY: 0,
    characterBlurIntensity: 0,
    backgroundBlurIntensity: 0,
    characterHeadFocusOffsetY: 0,
  },
  {
    cameraDistance: 1,
    fieldZoomRatio: 1.25,
    fieldZoomOffsetY: 0.05,
    characterBlurIntensity: 1,
    backgroundBlurIntensity: 1,
    characterHeadFocusOffsetY: 0,
  },
  {
    cameraDistance: 2,
    fieldZoomRatio: 1.5,
    fieldZoomOffsetY: 0.1,
    characterBlurIntensity: 1,
    backgroundBlurIntensity: 1,
    characterHeadFocusOffsetY: 0,
  },
  {
    cameraDistance: 3,
    fieldZoomRatio: 1.75,
    fieldZoomOffsetY: 0.15,
    characterBlurIntensity: 1,
    backgroundBlurIntensity: 1,
    characterHeadFocusOffsetY: 0,
  },
  {
    cameraDistance: 4,
    fieldZoomRatio: 2.0,
    fieldZoomOffsetY: 0.2,
    characterBlurIntensity: 1,
    backgroundBlurIntensity: 1,
    characterHeadFocusOffsetY: 0,
  },
  {
    cameraDistance: 5,
    fieldZoomRatio: 3.0,
    fieldZoomOffsetY: 0.3,
    characterBlurIntensity: 1,
    backgroundBlurIntensity: 1,
    characterHeadFocusOffsetY: 0,
  },
  {
    cameraDistance: 6,
    fieldZoomRatio: 5.0,
    fieldZoomOffsetY: 0.6,
    characterBlurIntensity: 1,
    backgroundBlurIntensity: 1,
    characterHeadFocusOffsetY: 0,
  },
]);

export const FOCUS_DATA_SETTINGS2 = Object.freeze([
  {
    cameraDistance: 0,
    fieldZoomRatio: 1,
    fieldZoomOffsetY: 0,
    characterBlurIntensity: 0,
    backgroundBlurIntensity: 0,
    characterHeadFocusOffsetY: 0,
  },
  {
    cameraDistance: 1,
    fieldZoomRatio: 1.25,
    fieldZoomOffsetY: 0,
    characterBlurIntensity: 1,
    backgroundBlurIntensity: 1,
    characterHeadFocusOffsetY: 0,
  },
  {
    cameraDistance: 2,
    fieldZoomRatio: 1.5,
    fieldZoomOffsetY: 0,
    characterBlurIntensity: 1,
    backgroundBlurIntensity: 1,
    characterHeadFocusOffsetY: 0,
  },
  {
    cameraDistance: 3,
    fieldZoomRatio: 1.75,
    fieldZoomOffsetY: 0,
    characterBlurIntensity: 1,
    backgroundBlurIntensity: 1,
    characterHeadFocusOffsetY: 0,
  },
  {
    cameraDistance: 4,
    fieldZoomRatio: 2.0,
    fieldZoomOffsetY: 0,
    characterBlurIntensity: 1,
    backgroundBlurIntensity: 1,
    characterHeadFocusOffsetY: 0,
  },
  {
    cameraDistance: 5,
    fieldZoomRatio: 2.25,
    fieldZoomOffsetY: 0,
    characterBlurIntensity: 1,
    backgroundBlurIntensity: 1,
    characterHeadFocusOffsetY: 0,
  },
  {
    cameraDistance: 6,
    fieldZoomRatio: 2.5,
    fieldZoomOffsetY: 0,
    characterBlurIntensity: 1,
    backgroundBlurIntensity: 1,
    characterHeadFocusOffsetY: 0,
  },
]);

export const FOCUS_DATA_BY_KEY: Record<string, readonly AdvFocusDataRow[]> = {
  "Settings-Default": FOCUS_DATA_SIRIUS,
  Sirius: FOCUS_DATA_SIRIUS,
  "AdvFocusDataSettings-Sirius": FOCUS_DATA_SIRIUS,
  Settings1: FOCUS_DATA_SETTINGS1,
  AdvFocusDataSettings1: FOCUS_DATA_SETTINGS1,
  Settings2: FOCUS_DATA_SETTINGS2,
  AdvFocusDataSettings2: FOCUS_DATA_SETTINGS2,
};

// Focus zoom ratios validated against the reference FocusData values.
// UniversalCamera.UpdateZoom applies these as effectiveFov = baseFov / ratio.
export const FOCUS_MAGNIFICATION_BY_KEY: Record<string, number[]> = {
  "Settings-Default": FOCUS_DATA_SIRIUS.map((row) => row.fieldZoomRatio),
  Sirius: FOCUS_DATA_SIRIUS.map((row) => row.fieldZoomRatio),
  "AdvFocusDataSettings-Sirius": FOCUS_DATA_SIRIUS.map((row) => row.fieldZoomRatio),
  Settings1: FOCUS_DATA_SETTINGS1.map((row) => row.fieldZoomRatio),
  AdvFocusDataSettings1: FOCUS_DATA_SETTINGS1.map((row) => row.fieldZoomRatio),
  Settings2: FOCUS_DATA_SETTINGS2.map((row) => row.fieldZoomRatio),
  AdvFocusDataSettings2: FOCUS_DATA_SETTINGS2.map((row) => row.fieldZoomRatio),
};

export const DEFAULT_ADV_RUNTIME = Object.freeze({
  // The reference runtime has no universal default: first setup scores the
  // device and later runs use the persisted choice. High is our deterministic
  // desktop policy, preserving the full lighting, blur, and post path.
  baseQualityMode: AdvBaseQualityMode.High,
  allowUnityLighting: true,
  allowCharacterPhysics: true,
  allowCharacterBreathMotion: true,
  allowCharacterBlur: true,
  allowBackgroundBlur: true,
  allowStageParticleEffect: true,
  allowStagePostEffect: true,
  isCharacterDistributedUpdate: false,
  characterDistributedUpdateRate: 45,
  targetNameSplitKey: "・",
  waitAfterVoiceTime: 0,
  waitTalkTextUnitTime: 0.04,
  minTalkDisplayTime: 1.6,
  waitVideoLingeringTimeOnAutoPlay: 0.3,
  waitSubtitlesLingeringTimeOnAutoPlay: 0.1,
  waitCommandLingeringTimeOnAutoPlay: 2,
  shakeFieldStrength: 0.1,
  shakeUIStrength: 10,
  cameraShakeStrength: 0.04,
  cameraShakeDuration: 1,
  cameraShakeVibrato: 2,
  cameraShakeRandomness: 60,
  defaultPanV2FocusSlideRate: 0.5,
  focusEase: 6,
  // Multiplier on devicePixelRatio for the framebuffer. 1.0 = render at exact device-native
  // density (never softer than the screen), never below it. The field targets themselves have no
  // MSAA; High/Best edge smoothing belongs to URP FinalPost FXAA. This avoids extra supersampling
  // above native and saves fill rate across the filter stack.
  rendererResolutionScale: 1,
  renderScaleByQuality: ADV_RENDER_SCALE_BY_QUALITY,
  rendererResolutionMax: 3,
  rendererPixelCountMax: 10_000_000,
  // Deterministic browser mode keeps Unity's authored render scale.
  // Adaptive scaling remains available as an explicit host opt-in.
  adaptiveRenderScaleEnabled: false,
  adaptiveRenderScaleMin: 0.72,
  // AdvPlayerSettings.asset assigns 60 fps to High.
  targetFrameRate: DETERMINISTIC_BROWSER_TARGET_FRAME_RATE,
  targetFrameRateByQuality: ADV_TARGET_FRAME_RATE_BY_QUALITY,
  lowTargetFrameRate: 30,
  preloadConcurrency: 8,
  preloadAheadCommands: 192,
  preloadBehindCommands: 24,
  preloadBackgroundConcurrency: 6,
  textureCacheEntryMax: 48,
  textureCacheMegabytes: 384,
  compressedTextureVariants: {},
  live2dMaskResolutionScale: 1,
  live2dMaskBufferMax: 1024,
  live2dMaskBufferSize: 1024,
  live2dUpdateFps: 60,
  live2dDegradedUpdateFps: 45,
  // ADV Cubism textures use linear, non-mip sampling.
  live2dTextureMipmaps: false,
  live2dTextureMaxAnisotropy: 1,
  // The global gates are enabled, while every focus-data settings asset
  // independently disables character blur and enables background blur.
  characterBlurEnabled: false,
  backgroundBlurEnabled: true,
  viewportFollowOnResolutionChanged: true,
  captureRig: {
    renderTextureSize: 1536,
  },
  stage: {
    // AdvCharacterField prefab: five stages at -1.6..1.6 and four
    // inter-stage focus anchors at -1.2/-0.4/0.4/1.2 (all in field-local units).
    minX: -1.6,
    maxX: 1.6,
    width: 3.2,
    backgroundSize: { width: 22.31, height: 14.28145 },
    positions: {
      1: { x: -1.6, y: 0, z: 0 },
      3: { x: -0.8, y: 0, z: 0 },
      5: { x: 0, y: 0, z: 0 },
      7: { x: 0.8, y: 0, z: 0 },
      9: { x: 1.6, y: 0, z: 0 },
    },
    focusAnchors: {
      1: { x: -1.6, y: 0, z: 0 },
      2: { x: -1.2, y: 0, z: 0 },
      3: { x: -0.8, y: 0, z: 0 },
      4: { x: -0.4, y: 0, z: 0 },
      5: { x: 0, y: 0, z: 0 },
      6: { x: 0.4, y: 0, z: 0 },
      7: { x: 0.8, y: 0, z: 0 },
      8: { x: 1.2, y: 0, z: 0 },
      9: { x: 1.6, y: 0, z: 0 },
    },
  },
  layout: {
    designViewportAspect: 13 / 6,
    portraitTargetAspect: 16 / 9,
    // Character size/position/framing are derived entirely from the transcoded model profile
    // (basePosition, baseScale, anchors.head) + the model's real Cubism pixelsPerUnit and vertex
    // range — no calibration constants (see layoutCharacter / headWorldY / createLive2DItem pivot).
  },
  focusData: [
    {
      cameraDistance: 0,
      fieldZoomRatio: 1,
      fieldZoomOffsetY: 0,
      characterBlurIntensity: 0,
      backgroundBlurIntensity: 0,
      characterHeadFocusOffsetY: 0.8,
    },
    {
      cameraDistance: 1,
      fieldZoomRatio: 1.2,
      fieldZoomOffsetY: 0.05,
      characterBlurIntensity: 0,
      backgroundBlurIntensity: 0,
      characterHeadFocusOffsetY: 0.6,
    },
    {
      cameraDistance: 2,
      fieldZoomRatio: 1.4,
      fieldZoomOffsetY: 0.1,
      characterBlurIntensity: 0,
      backgroundBlurIntensity: 0,
      characterHeadFocusOffsetY: 0.4,
    },
    {
      cameraDistance: 3,
      fieldZoomRatio: 1.8,
      fieldZoomOffsetY: 0.2,
      characterBlurIntensity: 1,
      backgroundBlurIntensity: 1,
      characterHeadFocusOffsetY: 0.25,
    },
    {
      cameraDistance: 4,
      fieldZoomRatio: 2.8,
      fieldZoomOffsetY: 0.36,
      characterBlurIntensity: 1,
      backgroundBlurIntensity: 1,
      characterHeadFocusOffsetY: 0.1,
    },
    {
      cameraDistance: 5,
      fieldZoomRatio: 4,
      fieldZoomOffsetY: 0.44,
      characterBlurIntensity: 1,
      backgroundBlurIntensity: 1,
      characterHeadFocusOffsetY: 0.05,
    },
    {
      cameraDistance: 6,
      fieldZoomRatio: 6,
      fieldZoomOffsetY: 0.5,
      characterBlurIntensity: 1,
      backgroundBlurIntensity: 1,
      characterHeadFocusOffsetY: 0.025,
    },
  ],
  fieldRenderer: {
    blurRadiusMaxByCameraDistance: [0.75, 2.25, 3.75, 5.5, 7.75, 9.75, 12],
    curvedLensIntensityRateByCameraDistance: [1, 0.85, 0.65, 0.45, 0.3, 0.15, 0],
  },
  audio: {
    categoryVolumes: { Bgm: 0.7, Se: 1, Voice: 1 },
  },
});

export function canPlaceCharacter(positionType: number) {
  const value = Number(positionType) || 0;
  return value < 10 && (value & 1) === 1;
}

export function clampCameraDistance(value: number) {
  return Math.max(0, Math.min(6, Number(value) || 0));
}

export function mergeAdvRuntime(runtime?: Partial<AdvRuntimeConfig> | null): AdvRuntimeConfig {
  const baseQualityMode = normalizeBaseQualityMode(runtime?.quality?.baseQualityMode ?? runtime?.baseQualityMode);
  const renderScaleByQuality = runtime?.renderScaleByQuality || ADV_RENDER_SCALE_BY_QUALITY;
  const targetFrameRateByQuality = runtime?.targetFrameRateByQuality || ADV_TARGET_FRAME_RATE_BY_QUALITY;
  const quality = {
    baseQualityMode,
    allowUnityLighting: runtime?.allowUnityLighting ?? DEFAULT_ADV_RUNTIME.allowUnityLighting,
    allowCharacterBlur: runtime?.allowCharacterBlur ?? DEFAULT_ADV_RUNTIME.allowCharacterBlur,
    allowBackgroundBlur: runtime?.allowBackgroundBlur ?? DEFAULT_ADV_RUNTIME.allowBackgroundBlur,
    allowCharacterPhysics: runtime?.allowCharacterPhysics ?? DEFAULT_ADV_RUNTIME.allowCharacterPhysics,
    allowCharacterBreathMotion: runtime?.allowCharacterBreathMotion ?? DEFAULT_ADV_RUNTIME.allowCharacterBreathMotion,
    allowStageParticleEffect: runtime?.allowStageParticleEffect ?? DEFAULT_ADV_RUNTIME.allowStageParticleEffect,
    allowStagePostEffect: runtime?.allowStagePostEffect ?? DEFAULT_ADV_RUNTIME.allowStagePostEffect,
    characterBlurEnabled: runtime?.characterBlurEnabled ?? DEFAULT_ADV_RUNTIME.characterBlurEnabled,
    backgroundBlurEnabled: runtime?.backgroundBlurEnabled ?? DEFAULT_ADV_RUNTIME.backgroundBlurEnabled,
    ...(runtime?.quality || {}),
  };
  return {
    ...DEFAULT_ADV_RUNTIME,
    ...(runtime || {}),
    baseQualityMode,
    rendererResolutionScale:
      runtime?.rendererResolutionScale ??
      qualityTableValue(renderScaleByQuality, baseQualityMode, ADV_RENDER_SCALE_BY_QUALITY),
    renderScaleByQuality,
    targetFrameRate:
      runtime?.targetFrameRate ??
      qualityTableValue(targetFrameRateByQuality, baseQualityMode, ADV_TARGET_FRAME_RATE_BY_QUALITY),
    targetFrameRateByQuality,
    quality,
    stage: { ...DEFAULT_ADV_RUNTIME.stage, ...(runtime?.stage || {}) },
    layout: { ...DEFAULT_ADV_RUNTIME.layout, ...(runtime?.layout || {}) },
    fieldRenderer: { ...DEFAULT_ADV_RUNTIME.fieldRenderer, ...(runtime?.fieldRenderer || {}) },
    captureRig: { ...DEFAULT_ADV_RUNTIME.captureRig, ...(runtime?.captureRig || {}) },
    audio: { ...DEFAULT_ADV_RUNTIME.audio, ...(runtime?.audio || {}) },
  } as AdvRuntimeConfig;
}
