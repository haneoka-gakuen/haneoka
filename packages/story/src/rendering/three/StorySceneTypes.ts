import type { Object3D } from "three";
import type { StoryCharacterModel } from "../StoryCharacterModel";
import type { AdvCharacterModelEntry, AdvWorldPosition } from "../../types/AdvRuntime";
import type { AdvVoiceAnalyzer, AdvVoiceMotionSyncPcmSnapshot } from "../../sound/AdvSoundManager";

export interface Vec2 {
  x: number;
  y: number;
}

export interface Vec3 extends Vec2 {
  z: number;
}

export interface StoryCameraState {
  rotationY: number;
  fieldRotationY: number;
  stageRotationY: number;
  rotationX: number;
  angle: number;
  zoomRatio: number;
  baseX: number;
  baseY: number;
  baseZ: number;
  panOffsetX: number;
  panOffsetY: number;
  focusPositionType: number;
  focusTargetName: string;
}

export interface FieldRendererState {
  distance: number;
  blurRadiusMax: number;
  curvedLensRate: number;
  backgroundBlur: number;
  /** Last Focus profile's non-focused-character target; entries retain their own value. */
  characterBlur: number;
  brightness: number;
}

export interface Live2DProfile {
  basePosition?: Partial<Vec3>;
  baseScale?: number;
  anchors?: {
    head?: { position?: Partial<Vec3> };
    stomach?: { position?: Partial<Vec3> };
  };
  defaultMotionName?: string;
  defaultExpressionName?: string;
  /** Default fade passed by Show when no command-specific value exists. */
  presentationFadeInSeconds?: number;
  /** Start the default motion before an explicit Show motion (legacy C2 providers). */
  playDefaultMotionBeforePresentation?: boolean;
  /** Keep the controller's current motion/expression presentation when it is hidden. */
  preservePresentationOnHide?: boolean;
}

export interface HarmonicParameter {
  id?: string;
  channel?: number;
  normalizedOrigin?: number;
  normalizedRange?: number;
  duration?: number;
}

export interface StoryCharacterEntry extends AdvCharacterModelEntry {
  profile?: Live2DProfile;
  harmonicMotion?: {
    blendMode?: number;
    channelTimescales?: number[];
    parameters?: HarmonicParameter[];
  };
}

export interface VoiceAnalysisSource {
  analyzer?: AdvVoiceAnalyzer | null;
  howl?: {
    playing?: (id?: number) => boolean;
    seek?: (id?: number) => unknown;
  };
  howlId?: number;
  playbackStarted?: boolean;
  playbackSettled?: boolean;
  stopping?: boolean;
}

export interface LipSyncState {
  enabled: boolean;
  source: "none" | "timed" | "voice";
  timedMode: "oscillating" | "hold-open";
  holdOpenLevel: number;
  timedRemaining: number;
  voiceRemaining: number;
  /** Voice-player channel state retained underneath a timed-pseudo overlay. */
  voiceSpeed: number;
  voiceMultiplier: number;
  voiceExpiresAtSeconds: number;
  stopRemaining: number;
  speed: number;
  multiplier: number;
  timer: number;
  openScale: number;
  isOpen: boolean;
  /** Live2DLipSyncController._beforeLevel, before pseudo multiplier/presentation. */
  beforeLevel: number;
  mouthOpenY: number;
  mouthForm: number;
  motionSyncPcm: AdvVoiceMotionSyncPcmSnapshot | null;
  dampVelocity: { value: number };
  randomSeed: { value: number };
  sources: VoiceAnalysisSource[];
}

export interface RimLightState {
  enabled: boolean;
  color: { r: number; g: number; b: number; a: number };
  shadowIntensity: number;
}

export interface StoryCharacterItem {
  readonly target: string;
  readonly live2dKey: string;
  readonly entry: StoryCharacterEntry;
  readonly model: StoryCharacterModel;
  readonly node: Object3D;
  positionType: number;
  /** Absolute ADV world position; null keeps the native slot-based layout. */
  worldPosition: AdvWorldPosition | null;
  offset: Vec3;
  alpha: number;
  brightness: number;
  facing: 1 | -1;
  roleAngle: number;
  angle: number;
  bodyAngle: number;
  angleOverride: boolean;
  lookX: number;
  lookY: number;
  lookOverride: boolean;
  /** AdvCharacterFieldRendererEntry.BlurIntensity. Focus and DoF both write this property. */
  blurIntensity: number;
  sortingOrder: number;
  rimLight: RimLightState;
  lipSync: LipSyncState;
  harmonicTime: number;
  paused: boolean;
}
