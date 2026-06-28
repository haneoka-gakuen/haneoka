import { Object3D } from "three";
import type { CubismParameterBlend, CubismParameterFrame } from "../cubism/AdvCubismModel";
import type { StoryCharacterModel } from "../StoryCharacterModel";
import type { LipSyncState, RimLightState, StoryCharacterEntry, StoryCharacterItem } from "./StorySceneTypes";
import type { VoiceMotionSyncInput } from "./VoiceMotionSync";
import type { AdvWorldPosition } from "../../types/AdvRuntime";

const DEFAULT_RIM_LIGHT: RimLightState = {
  enabled: false,
  color: { r: 1, g: 1, b: 1, a: 1 },
  shadowIntensity: 0.8,
};

export class StoryCharacter implements StoryCharacterItem {
  readonly node = new Object3D();
  worldPosition: AdvWorldPosition | null = null;
  readonly offset = { x: 0, y: 0, z: 0 };
  alpha = 1;
  brightness = 1;
  facing: 1 | -1 = 1;
  roleAngle = 0;
  angle = 0;
  bodyAngle = 0;
  angleOverride = false;
  angleTweenController: AbortController | null = null;
  lookX = 0;
  lookY = 0;
  lookOverride = false;
  lookOriginalX = 0;
  lookOriginalY = 0;
  lookTweenController: AbortController | null = null;
  pendingPausedMotion: { name: string; fadeInSeconds?: number } | null = null;
  pendingPausedExpression: { name: string; fadeInSeconds?: number } | null = null;
  /** Motion currently owned by the model, distinct from the pause queue. */
  currentMotionName = "";
  currentMotionFadeInSeconds: number | undefined;
  /** Live2DCharacterController's logical expression channel head. */
  currentExpressionName = "";
  currentExpressionFadeInSeconds: number | undefined;
  /** Expression currently owned by the model, distinct from controller bookkeeping. */
  activeExpressionName = "";
  activeExpressionFadeInSeconds: number | undefined;
  /** Mirrors AdvCharacterFieldRendererEntry.BlurIntensity. */
  blurIntensity = 0;
  /** Unity world-position z captured by RegisterCharacterEntry. */
  sortingOrder = 0;
  rimLight: RimLightState = structuredClone(DEFAULT_RIM_LIGHT);
  lipSync: LipSyncState = {
    enabled: false,
    source: "none",
    timedMode: "oscillating",
    holdOpenLevel: 0,
    timedRemaining: 0,
    voiceRemaining: 0,
    voiceSpeed: 1,
    voiceMultiplier: 1,
    voiceExpiresAtSeconds: 0,
    stopRemaining: 0,
    speed: 1,
    multiplier: 1,
    timer: 0,
    openScale: 0,
    isOpen: false,
    beforeLevel: 0,
    mouthOpenY: 0,
    mouthForm: 0,
    motionSyncPcm: null,
    dampVelocity: { value: 0 },
    randomSeed: { value: 0x9e3779b9 },
    sources: [],
  };
  harmonicTime = 0;
  updateFailureCount = 0;
  updateRetryAtSeconds = 0;
  stalledUpdateCount = 0;
  drawFailureCount = 0;
  drawRetryAtSeconds = 0;
  stalledDrawCount = 0;
  /** Stable per-frame storage; Cubism consumes it synchronously. */
  readonly parameterFrame: CubismParameterFrame = {};
  readonly harmonicBlends: CubismParameterBlend[] = [];
  readonly voiceMotionSyncInput: VoiceMotionSyncInput = {
    pcm: null,
    rms: 0,
    playing: false,
    pending: false,
    analyzable: false,
  };
  private pausedValue = false;

  constructor(
    readonly target: string,
    readonly live2dKey: string,
    readonly entry: StoryCharacterEntry,
    public model: StoryCharacterModel,
    public positionType: number,
  ) {
    this.node.name = `ADV Character ${target}`;
  }

  get paused(): boolean {
    return this.pausedValue;
  }

  set paused(value: boolean) {
    // Keep scene truth independent from the SDK call. ThreeStoryScene applies
    // this value through its supervised model-command boundary so a failed
    // Resume cannot leave the controller and model silently disagreeing.
    this.pausedValue = Boolean(value);
  }
}
