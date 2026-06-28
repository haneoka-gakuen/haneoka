import {
  Color,
  DoubleSide,
  FrontSide,
  LinearFilter,
  LinearSRGBColorSpace,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  NoToneMapping,
  NoColorSpace,
  Object3D,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  Texture,
  Vector3,
  WebGLRenderer,
} from "three";
import { AdvCamera } from "../AdvCamera";
import { AdaptiveRenderQuality } from "../AdaptiveRenderQuality";
import {
  AdvCubismModel,
  type AdvCubismMultiplyTextureOptions,
  type CubismParameterBlend,
  type CubismParameterFrame,
} from "../cubism/AdvCubismModel";
import { Cubism2Model } from "../cubism/Cubism2Model";
import type { StoryCharacterModel } from "../StoryCharacterModel";
import { StaticPortraitModel } from "../portrait/StaticPortraitModel";
import { ensureCubismFramework } from "../cubism/CubismCoreRuntime";
import { configureCubismResourceCache, loadCachedImage } from "../cubism/CubismResourceCache";
import { evaluateAdvHarmonicMotion, type AdvHarmonicMotionData } from "../cubism/AdvHarmonicMotion";
import {
  DEFAULT_UNITY_CUBISM_LIGHTING,
  UNITY_CUBISM_REFERENCE_FLAT_WHITE_SH,
  packUnityUrpAdditionalLights,
  packUnityUrpDirectionalLight,
  type UnityCubismAdditionalLightLike,
  type UnityCubismLightingState,
} from "../cubism/UnityCubismAdvLighting";
import {
  registerCharacterItem,
  UNITY_CHARACTER_FADE_DELAY_FRAMES,
  UnityCharacterFadeCoordinator,
} from "../AdvCharacterLifecycle";
import { AdvPostPipeline, type AdvSceneLayer } from "./AdvPostPipeline";
import { advVolumeProfileKey, type AdvVolumeLayer, type UnityVolumeProfile } from "../post/AdvVolumeStack";
import { StoryCharacter } from "./StoryCharacter";
import { StoryDomOverlay } from "./StoryDomOverlay";
import { UnityParticleEffectController } from "../particles/UnityParticleEffect";
import { resolveAdvEffectRoute, type AdvEffectRoute } from "../particles/AdvEffectRoute";
import { AdvRuleTransitionController } from "./transitions/AdvRuleTransition";
import { AdvRuleTransitionPass } from "./transitions/AdvRuleTransitionPass";
import { threeVector3ToUnity, unityEulerDegrees, unityVector3 } from "./UnityTransform";
import { createUnityAdvViewport, unityAdvOrientedTargetAspect } from "./UnityAdvViewport";
import { sampleVoiceMotionSyncInput, voiceRmsMouthOpening } from "./VoiceMotionSync";
import { SharedTextureResourceCache, type SharedTextureLease } from "./SharedTextureResourceCache";
import { computeAdvCharacterHeadWorldPosition, computeAdvLookTarget } from "./AdvLookTarget";
import { createAdvDotweenShakePath, sampleAdvDotweenShake } from "./AdvDotweenShake";
import { advanceAdvHoldOpenPseudoLipSync, advanceAdvPseudoLipSync } from "../cubism/AdvPseudoLipSyncMath";
import {
  PendingCharacterCommands,
  type PendingCharacterAlphaEvent,
  type PendingCharacterAngleEvent,
  type PendingCharacterBrightness,
  type PendingCharacterDoF,
  type PendingCharacterDoFSet,
  type PendingCharacterLipSync,
  type PendingCharacterLookEvent,
  type PendingCharacterPauseEvent,
  type PendingCharacterPresentation,
  type PendingCharacterRimLightEvent,
} from "./PendingCharacterCommands";
import { UnityTargetFrameClock } from "./UnityTargetFrameClock";
import { detectAdvFieldTargetFormat } from "./AdvFieldTargetFormat";
import {
  acquireCubismShaderContext,
  releaseCubismShaderContext,
} from "../../vendor/cubism/rendering/cubismshader_webgl";
import { clampCameraDistance, FOCUS_DATA_BY_KEY, mergeAdvRuntime } from "../../core/AdvConstants";
import { AdvQualityConfig } from "../../core/AdvQualityConfig";
import { lerp, resolveEase, tween } from "../../core/easing";
import { advCharacterExpressions, advCharacterMotions } from "../../types/AdvRuntime";
import type {
  AdvBackgroundEntry,
  AdvCommand,
  AdvEffectEntry,
  AdvFocusDataRow,
  AdvFrameEntry,
  AdvPlayerState,
  AdvPostEffectEntry,
  AdvRuleTransitionEntry,
  AdvRuntimeConfig,
  AdvStillEntry,
  AdvVideoEntry,
} from "../../types/AdvRuntime";
import type {
  FieldRendererState,
  StoryCharacterEntry,
  StoryCameraState,
  Vec2,
  Vec3,
  VoiceAnalysisSource,
} from "./StorySceneTypes";
import {
  STORY_SCENE_SEEK_SNAPSHOT_VERSION,
  type AdvCharacterPresentationEvent,
  type AdvStorySceneSeekSnapshot,
  type SeekSnapshotSafety,
} from "./StorySceneSnapshot";

type BackgroundMesh = Mesh<PlaneGeometry, MeshBasicMaterial>;
type UnknownRecord = Record<string, unknown>;

interface CommandVolumeState {
  profile: UnityVolumeProfile;
  weight: number;
  enabled: boolean;
  version: number;
}

interface CommandEffectState {
  readonly key: string;
  readonly effect: AdvEffectEntry;
  readonly atOnce: boolean;
  readonly simulationSpeed: number;
  readonly positionType?: number;
  readonly targetName: string;
  readonly canvasLayers: readonly unknown[];
}

interface PendingStageCapture {
  readonly generation: number;
  readonly resolve: (generation: number | null) => void;
}

interface PendingCharacterPlacement {
  readonly token: number;
  readonly entry: StoryCharacterEntry;
  readonly positionType: number;
  readonly identity: string;
  readonly worldPosition: Vec3 | null;
  readonly fadeInDurationSeconds: number;
  fadeInStartedAtSeconds: number | null;
}

interface PendingCharacterWorldPosition {
  readonly token: number;
  readonly positionType: number;
  readonly position: Vec3;
}

interface StagedCharacterItem {
  readonly token: number;
  readonly item: StoryCharacter;
}

interface PendingCharacterLoadController {
  readonly token: number;
  readonly controller: AbortController;
  readonly detach: () => void;
}

interface CharacterGraphicsRestoreFailure {
  readonly item: StoryCharacter;
  readonly error: unknown;
}

interface CharacterModelRecoveryState {
  generation: number;
  attempts: number;
  retryAtSeconds: number;
  controller: AbortController | null;
  detach: (() => void) | null;
}

interface ContextRestoreController {
  readonly controller: AbortController;
  readonly detach: () => void;
}

interface SceneUpdateFailureState {
  failures: number;
  retryAtSeconds: number;
}

async function loadPngTexture(url: string): Promise<Texture> {
  const texture = new Texture(await loadCachedImage(url));
  // PlayerSettings.m_ActiveColorSpace=Gamma. Unity therefore samples
  // imported ADV textures without hardware sRGB decoding.
  texture.colorSpace = NoColorSpace;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

const sharedTextureCache = new SharedTextureResourceCache<string, Texture>(
  loadPngTexture,
  (texture) => texture.dispose(),
  48,
);
const DEG_TO_RAD = Math.PI / 180;
const PSEUDO_LIP_UNIT_TIME = 0.14;
const PSEUDO_LIP_STOP_DURATION = 0.3;
const FLOAT_EPSILON = 1e-45;
const ADV_UI_REFERENCE_HEIGHT = 1080;
const CHARACTER_FRAME_FAILURE_REBUILD_THRESHOLD = 4;
const CHARACTER_MODEL_RECOVERY_MAX_DELAY_SECONDS = 30;
const CHARACTER_MODEL_RECOVERY_PREPARE_MAX_PASSES = 3;
const ZERO_VEC3: Readonly<Vec3> = { x: 0, y: 0, z: 0 };
const BACKGROUND_FIELD_POSITION: Readonly<Vec3> = { x: 0, y: 0, z: 16 };
const CHARACTER_FIELD_POSITION: Readonly<Vec3> = { x: 0, y: -0.45, z: 5.5 };
const CHARACTER_BASE_POSITION: Readonly<Vec3> = { x: 0, y: -0.41, z: 0 };
const WHITE_CUBISM_COLOR = [1, 1, 1, 1] as const;

interface MutableColor4 {
  r: number;
  g: number;
  b: number;
  a: number;
}

interface CharacterRenderGroup {
  readonly settings: {
    blur: number;
    alpha: number;
    brightness: number;
    radiusMax: number;
  };
  readonly items: StoryCharacter[];
}

function finite(value: unknown, fallback = 0): number {
  const result = Number(value);
  return Number.isFinite(result) ? result : fallback;
}

function clamp(value: unknown, minimum = 0, maximum = 1): number {
  return Math.max(minimum, Math.min(maximum, finite(value, minimum)));
}

function sceneAbortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

/** Mathf.Approximately, as in AdvFieldRenderPass character grouping. */
function unityApproximately(left: number, right: number): boolean {
  return Math.abs(left - right) < Math.max(0.000001 * Math.max(Math.abs(left), Math.abs(right)), 8 * FLOAT_EPSILON);
}

function hashSeed(value: unknown): number {
  let hash = 0x811c9dc5;
  for (const character of String(value || "")) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash || 0x9e3779b9;
}

function nextRandom(seed: { value: number }): number {
  seed.value = Math.imul(seed.value ^ (seed.value >>> 15), seed.value | 1) >>> 0;
  return seed.value / 4294967295;
}

function record(value: unknown): UnknownRecord {
  return value && typeof value === "object" ? (value as UnknownRecord) : {};
}

function clonePlain<T>(value: T): T {
  if (value == null) return value;
  try {
    return JSON.parse(JSON.stringify(value)) as T;
  } catch {
    return value;
  }
}

function vec3(value: unknown, fallback: Readonly<Vec3>, target: Vec3 = { x: 0, y: 0, z: 0 }): Vec3 {
  const source = record(value);
  target.x = finite(source.x, fallback.x);
  target.y = finite(source.y, fallback.y);
  target.z = finite(source.z, fallback.z);
  return target;
}

function worldPosition(value: unknown): Vec3 | null {
  const source = record(value);
  if (
    ![source.x, source.y, source.z].every((component) => typeof component === "number" && Number.isFinite(component))
  ) {
    return null;
  }
  return { x: source.x as number, y: source.y as number, z: source.z as number };
}

function positiveFinite(value: unknown): number | undefined {
  const result = Number(value);
  return Number.isFinite(result) && result > 0 ? result : undefined;
}

function textureAspect(texture: Texture, fallback = 16 / 9): number {
  const source = record(texture.source);
  const image = record(texture.image || source.data);
  const width = positiveFinite(image.naturalWidth ?? image.videoWidth ?? image.width);
  const height = positiveFinite(image.naturalHeight ?? image.videoHeight ?? image.height);
  return width && height ? width / height : fallback;
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    const text = typeof value === "string" ? value : "";
    if (text) return text;
  }
  return "";
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function colorComponents(value: unknown): { r: number; g: number; b: number; a: number } {
  if (typeof value === "number" && Number.isFinite(value)) {
    const packed = Math.trunc(value) >>> 0;
    return {
      r: ((packed >>> 16) & 0xff) / 255,
      g: ((packed >>> 8) & 0xff) / 255,
      b: (packed & 0xff) / 255,
      a: packed > 0xffffff ? ((packed >>> 24) & 0xff) / 255 : 1,
    };
  }
  if (typeof value === "string") {
    const color = new Color(value || "#ffffff");
    return { r: color.r, g: color.g, b: color.b, a: 1 };
  }
  const source = record(value);
  return {
    r: clamp(source.r, 0, 2),
    g: clamp(source.g, 0, 2),
    b: clamp(source.b, 0, 2),
    a: clamp(source.a, 0, 1),
  };
}

function unityHtmlColor(value: unknown): { r: number; g: number; b: number; a: number } {
  const source = String(value ?? "")
    .trim()
    .toLowerCase();
  const hex = source.match(/^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i)?.[1];
  if (hex) {
    const expanded = hex.length <= 4 ? [...hex].map((digit) => `${digit}${digit}`).join("") : hex;
    const hasAlpha = expanded.length === 8;
    return {
      r: Number.parseInt(expanded.slice(0, 2), 16) / 255,
      g: Number.parseInt(expanded.slice(2, 4), 16) / 255,
      b: Number.parseInt(expanded.slice(4, 6), 16) / 255,
      a: hasAlpha ? Number.parseInt(expanded.slice(6, 8), 16) / 255 : 1,
    };
  }
  const named = Color.NAMES[source as keyof typeof Color.NAMES];
  if (named != null) {
    return {
      r: ((named >>> 16) & 0xff) / 255,
      g: ((named >>> 8) & 0xff) / 255,
      b: (named & 0xff) / 255,
      a: 1,
    };
  }
  // AdvRimLightCommand initializes the out color to Color.white and ignores
  // TryParseHtmlString's false result.
  return { r: 1, g: 1, b: 1, a: 1 };
}

function stageSpriteTint(value: unknown, target: MutableColor4 = { r: 1, g: 1, b: 1, a: 1 }): MutableColor4 {
  const source = record(value);
  // AdvBackgroundField.SetStageInfo copies all four serialized floats directly
  // into SpriteRenderer.color; unlike public UI colors, this path performs no
  // clamp before ApplyBrightness multiplies RGB.
  target.r = finite(source.r, 1);
  target.g = finite(source.g, 1);
  target.b = finite(source.b, 1);
  target.a = finite(source.a, 1);
  return target;
}

/**
 * Three/Cubism implementation of the Unity ADV scene root.
 *
 * The class keeps the existing command-facing contract, but all field roots,
 * character stages and the camera are real 3D transforms. Cubism is submitted
 * into the exact framebuffer owned by the Three post pipeline.
 */
export class ThreeStoryScene {
  runtime: AdvRuntimeConfig;
  state: AdvPlayerState;
  readonly scene = new Scene();
  readonly backgroundCaptureScene = new Scene();
  // SceneCamera.asset serializes near=.3 and far=5000; UniversalCamera only
  // replaces the authored ADV FOV/pose during setup.
  readonly camera = new PerspectiveCamera(39.6, 13 / 6, 0.3, 5000);
  readonly backgroundField = new Object3D();
  private readonly backgroundCaptureField = new Object3D();
  readonly characterField = new Object3D();
  readonly foregroundField = new Object3D();
  readonly characterItems = new Map<string, StoryCharacter>();
  private readonly characterControllerIdentities = new Map<string, string>();
  private readonly cachedCharacterControllers = new Map<string, StoryCharacter>();
  private readonly sortedCharacterItems: StoryCharacter[] = [];
  private readonly characterRenderGroupPool: CharacterRenderGroup[] = [];
  private readonly stagedCharacterItems = new Map<string, StagedCharacterItem>();
  private readonly pendingCharacterPlacements = new Map<string, PendingCharacterPlacement>();
  private readonly pendingCharacterWorldPositions = new Map<string, PendingCharacterWorldPosition>();
  private readonly pendingAngleWaitControllers = new Map<string, AbortController>();
  private readonly pendingLookWaitControllers = new Map<string, AbortController>();
  private readonly pendingCharacterLoadControllers = new Map<string, PendingCharacterLoadController>();
  readonly cameraState: StoryCameraState = {
    rotationY: 0,
    fieldRotationY: 0,
    stageRotationY: 0,
    rotationX: 0,
    angle: 0,
    zoomRatio: 1,
    baseX: 0,
    baseY: 0,
    baseZ: 0,
    panOffsetX: 0,
    panOffsetY: 0,
    focusPositionType: 5,
    focusTargetName: "",
  };
  readonly fieldRendererState: FieldRendererState = {
    distance: 0,
    blurRadiusMax: 0.75,
    curvedLensRate: 1,
    backgroundBlur: 0,
    characterBlur: 0,
    brightness: 1,
  };

  private renderer: WebGLRenderer | null = null;
  private cubismShaderContextAcquired = false;
  private pipeline: AdvPostPipeline | null = null;
  private overlay: StoryDomOverlay | null = null;
  private ruleTransitionPass: AdvRuleTransitionPass | null = null;
  private mount: HTMLElement | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private animationFrame = 0;
  private previousFrameTime = 0;
  private readonly targetFrameClock = new UnityTargetFrameClock();
  private backgroundMesh: BackgroundMesh | null = null;
  private backgroundCaptureMesh: BackgroundMesh | null = null;
  private backgroundTextureLease: SharedTextureLease<Texture> | null = null;
  private readonly backgroundGeometry = new PlaneGeometry(1, 1);
  private readonly backgroundBaseMaterial = new MeshBasicMaterial({
    color: 0x000000,
    transparent: true,
    opacity: 1,
    depthTest: true,
    depthWrite: false,
    side: FrontSide,
    toneMapped: false,
  });
  private readonly backgroundCaptureBaseMaterial = this.backgroundBaseMaterial.clone();
  private readonly backgroundBaseMesh = new Mesh(this.backgroundGeometry, this.backgroundBaseMaterial);
  private readonly backgroundCaptureBaseMesh = new Mesh(this.backgroundGeometry, this.backgroundCaptureBaseMaterial);
  private readonly stageNodes = new Map<number, Object3D>();
  private readonly stageOffsets = new Map<number, Vec3>();
  private readonly characterFadeCoordinator = new UnityCharacterFadeCoordinator();
  private readonly commandEffects = new UnityParticleEffectController((key) => this.commandEffectStates.delete(key));
  private readonly stageEffects = new UnityParticleEffectController();
  private readonly commandEffectStates = new Map<string, CommandEffectState>();
  private readonly commandAdvBackScene = new Scene();
  private readonly commandAdvFrontScene = new Scene();
  private readonly commandUiScene = new Scene();
  private readonly commandCharacterScenes = new Map<number, Scene>();
  private readonly stageParticleKeys = new Set<string>();
  private readonly ruleTransition = new AdvRuleTransitionController();
  private ruleTransitionTextureLease: SharedTextureLease<Texture> | null = null;
  private ruleTransitionVersion = 0;
  private readonly textureCacheKeys = new Set<string>();
  // AdvFieldRendererManager owns one cancellation source per renderer entry.
  // Focus and DoF therefore cancel/replace one another instead of combining.
  private backgroundBlurTweenVersion = 0;
  private readonly characterBlurTweenVersions = new Map<string, number>();
  private backgroundBlurTweenController: AbortController | null = null;
  private readonly characterBlurTweenControllers = new Map<string, AbortController>();
  private readonly characterBrightnessTweenControllers = new Map<string, AbortController>();
  private readonly renderMvp = new Matrix4();
  private readonly cubismDrawState = { objectToWorld: this.renderMvp, timeSeconds: 0 };
  private readonly renderWorldPosition = new Vector3();
  private readonly renderUnityPosition = new Vector3();
  private readonly placementUnityPosition = new Vector3();
  private readonly scratchBackgroundPosition: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly scratchCharacterPosition: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly scratchStagePosition: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly scratchCharacterBasePosition: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly scratchEuler: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly scratchTint: MutableColor4 = { r: 1, g: 1, b: 1, a: 1 };
  private readonly stageNodeKeys = new Set<number>([1, 3, 5, 7, 9]);
  private readonly sceneLayerCache = new Map<Scene, AdvSceneLayer>();
  private readonly postBeginOptions: {
    clearColor: number;
    clearAlpha: number;
    captureStage: boolean;
    stageCaptureScene: Scene;
    advBackEffects: AdvSceneLayer | null;
  };
  private readonly postFinishOptions: {
    timeSeconds: number;
    foreground: AdvSceneLayer | null;
    commandEffects: AdvSceneLayer | null;
    uiEffects: AdvSceneLayer | null;
  } = { timeSeconds: 0, foreground: null, commandEffects: null, uiEffects: null };
  private readonly adaptiveRenderQuality: AdaptiveRenderQuality;
  private readonly qualityConfig: AdvQualityConfig;
  private readonly cameraTweenVersions: Record<string, number> = {};
  private backgroundShake: Vec2 = { x: 0, y: 0 };
  private characterShake: Vec2 = { x: 0, y: 0 };
  private readonly commandShakeControllers = new Map<"background" | "character" | "still" | "talk", AbortController>();
  private cameraShake: Vec2 = { x: 0, y: 0 };
  private cameraShakeMode: "idle" | "playing" | "stopping" = "idle";
  private cameraShakeCycleElapsed = 0;
  private cameraShakeFadeElapsed = 0;
  private cameraShakeFadeSeconds = 0;
  private cameraShakeWeight = 0;
  private cameraShakeStrength = 0;
  private cameraShakeCycleSeconds = 1;
  private cameraShakeVibrato = 2;
  private cameraShakeRandomness = 60;
  private cameraShakePath: ReturnType<typeof createAdvDotweenShakePath> | null = null;
  private cameraShakeCycleStart: Vec2 = { x: 0, y: 0 };
  private cameraShakeWaitNextCycle = false;
  private cameraShakeFadeController: AbortController | null = null;
  private cameraShakeStopPromise: Promise<void> | null = null;
  private commandPostEffect: unknown = null;
  private readonly commandVolumes = new Map<string, CommandVolumeState>();
  private stagePostEffect: UnknownRecord | null = null;
  private stageLightState: UnknownRecord | null = null;
  private cubismLightingState: UnityCubismLightingState = DEFAULT_UNITY_CUBISM_LIGHTING;
  private stageMultiplyTextureVersion = 0;
  private stageMultiplyTextureUrl = "";
  private stageMultiplyTextureOptions: AdvCubismMultiplyTextureOptions = {};
  private focusDataSettingsKey = "Settings-Default";
  private frameEpoch = 0;
  private pendingStageCapture: PendingStageCapture | null = null;
  private stageCaptureAlpha = 0;
  private stageCaptureGeneration = 0;
  private deterministicReplayActive = false;
  private contextLost = false;
  private contextRestoreGeneration = 0;
  private contextRestoreController: ContextRestoreController | null = null;
  private contextRestoreRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly contextReadyWaiters = new Set<(ready: boolean) => void>();
  private readonly characterModelRecoveryStates = new Map<StoryCharacter, CharacterModelRecoveryState>();
  private readonly sceneUpdateFailureStates = new Map<string, SceneUpdateFailureState>();
  private renderFailureCount = 0;
  private renderRetryAtSeconds = 0;
  private destroyed = false;
  private sceneGeneration = 0;
  private readonly lifecycleController = new AbortController();
  // Global monotonic allocation prevents an ABA race when teardown or a target
  // replacement clears the map while an older Cubism load is still resolving.
  private characterLoadSequence = 0;
  private readonly characterLoadTokens = new Map<string, number>();
  private readonly pendingCharacterCommands = new PendingCharacterCommands();
  private characterAlphaOperationSequence = 0;
  private readonly characterAlphaOperations = new Map<string, number>();
  private readonly characterPresentationHistory = new Map<string, AdvCharacterPresentationEvent[]>();
  private characterPriorityOrder: number[] = [4, 0, 3, 1, 2];
  private playbackSpeedRate = 1;
  private readonly playbackSpeedEvents: Array<{ readonly rate: number; readonly queuedAtSeconds: number }> = [];

  constructor(runtime: Partial<AdvRuntimeConfig>, state: AdvPlayerState) {
    this.runtime = mergeAdvRuntime(runtime);
    this.qualityConfig = new AdvQualityConfig(this.runtime.quality);
    this.adaptiveRenderQuality = new AdaptiveRenderQuality({
      enabled: this.runtime.adaptiveRenderScaleEnabled,
      initialScale: 1,
      minScale: finite(this.runtime.adaptiveRenderScaleMin, 0.72),
      maxScale: 1,
      targetFps: finite(this.runtime.targetFrameRate, 60),
    });
    configureCubismResourceCache(finite(this.runtime.textureCacheEntryMax, 48));
    sharedTextureCache.configure(Math.max(8, Math.trunc(finite(this.runtime.textureCacheEntryMax, 48))));
    this.state = state;
    const initialCameraPosition = vec3(this.runtime.stage.initialCameraPosition, ZERO_VEC3);
    const initialCameraRotation = vec3(this.runtime.stage.initialCameraRotation, ZERO_VEC3);
    this.cameraState.baseX = initialCameraPosition.x;
    this.cameraState.baseY = initialCameraPosition.y;
    this.cameraState.baseZ = initialCameraPosition.z;
    this.cameraState.rotationX = -initialCameraRotation.x;
    this.cameraState.rotationY = initialCameraRotation.y;
    this.cameraState.angle = initialCameraRotation.z;
    this.postBeginOptions = {
      clearColor: 0x000000,
      clearAlpha: 0,
      captureStage: false,
      stageCaptureScene: this.backgroundCaptureScene,
      advBackEffects: null,
    };
    this.scene.name = "Unity ADV Scene";
    this.backgroundField.name = "AdvBackgroundField";
    this.backgroundCaptureScene.name = "Unity ADV AdvBack Capture Scene";
    this.backgroundCaptureField.name = "AdvBackgroundCaptureField";
    this.commandAdvBackScene.name = "Unity ADV Command AdvBack Effects";
    this.commandAdvFrontScene.name = "Unity ADV Command AdvFront Effects";
    this.commandUiScene.name = "Unity ADV Command UI Effects";
    this.characterField.name = "AdvCharacterField";
    this.foregroundField.name = "AdvForegroundField";
    this.scene.add(this.backgroundField, this.characterField, this.foregroundField);
    this.backgroundCaptureScene.add(this.backgroundCaptureField);
    this.backgroundField.visible = false;
    this.backgroundCaptureField.visible = false;
    // AdvBackgroundField/BaseRenderer is Unity's built-in 10x10 Plane at
    // local (0, 0, +1), rotated -90 degrees and scaled by five. Converting
    // Unity Z to Three puts the opaque black 50x50 backing plane at -1,
    // immediately behind the stage sprite. ScreenCaptureRenderPass redraws
    // this renderer together with the sprite because both are on AdvBack.
    for (const [mesh, field] of [
      [this.backgroundBaseMesh, this.backgroundField],
      [this.backgroundCaptureBaseMesh, this.backgroundCaptureField],
    ] as const) {
      mesh.name = "AdvBackgroundBaseRenderer";
      mesh.position.set(0, 0, -1);
      mesh.scale.setScalar(50);
      mesh.renderOrder = 0;
      field.add(mesh);
    }
    this.camera.matrixAutoUpdate = true;
  }

  async setup(mount: HTMLElement): Promise<void> {
    if (this.renderer) return;
    if (this.destroyed) throw sceneAbortError("A destroyed story scene cannot be set up again");
    this.mount = mount;
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("webgl2", {
      alpha: false,
      // The Unity ADV field targets have samples=0. High/Best enables URP's
      // FinalPost FXAA, not default-framebuffer MSAA.
      antialias: false,
      depth: true,
      premultipliedAlpha: true,
      powerPreference: "high-performance",
      preserveDrawingBuffer: false,
      stencil: false,
    });
    if (!context) throw new Error("The Three story player requires WebGL2");
    const fieldTargetFormat = detectAdvFieldTargetFormat(context);
    canvas.dataset.advFieldTargetFormat = fieldTargetFormat.precision;
    this.renderer = new WebGLRenderer({ canvas, context, antialias: false, alpha: false });
    this.renderer.outputColorSpace = LinearSRGBColorSpace;
    this.renderer.toneMapping = NoToneMapping;
    this.renderer.autoClear = false;
    canvas.className = "adv-story-canvas adv-story-canvas-three";
    Object.assign(canvas.style, { display: "block", width: "100%", height: "100%" });
    canvas.addEventListener("webglcontextlost", this.handleContextLost, false);
    canvas.addEventListener("webglcontextrestored", this.handleContextRestored, false);
    mount.appendChild(canvas);
    this.pipeline = new AdvPostPipeline(this.renderer, {
      finalPostFxaaEnabled: this.qualityConfig.isCameraAntiAliasingEnabled(),
      fieldTargetFormat,
    });
    this.overlay = new StoryDomOverlay(mount);
    this.ruleTransitionPass = new AdvRuleTransitionPass(this.overlay.ruleTransitionLayer);
    acquireCubismShaderContext(context);
    this.cubismShaderContextAcquired = true;
    if (this.runtime.viewportFollowOnResolutionChanged) {
      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(mount);
    }
    this.resize();
    this.previousFrameTime = performance.now();
    this.targetFrameClock.reset();
    this.settleContextReadyWaiters(true);
    this.animationFrame = requestAnimationFrame(this.onAnimationFrame);
  }

  private readonly handleContextLost = (event: Event): void => {
    event.preventDefault();
    if (this.destroyed) return;
    this.contextLost = true;
    this.contextRestoreGeneration += 1;
    this.cancelContextRestoreRetry();
    this.cancelContextRestore();
    this.cancelAllCharacterModelRecoveries();
    this.sceneUpdateFailureStates.clear();
    this.renderFailureCount = 0;
    this.renderRetryAtSeconds = 0;
    this.pipeline?.abortFrame();
    const renderer = this.renderer;
    if (renderer && this.cubismShaderContextAcquired) {
      releaseCubismShaderContext(renderer.getContext());
      this.cubismShaderContextAcquired = false;
    }
    this.targetFrameClock.reset();
  };

  private readonly handleContextRestored = (): void => {
    this.beginContextRestore(1);
  };

  private beginContextRestore(attempt: number): void {
    const renderer = this.renderer;
    if (this.destroyed || !renderer) return;
    this.cancelContextRestoreRetry();
    const generation = ++this.contextRestoreGeneration;
    this.contextLost = true;
    this.cancelContextRestore();
    this.cancelAllCharacterModelRecoveries();
    const controller = new AbortController();
    const restoreController: ContextRestoreController = {
      controller,
      detach: this.bindControllerToSignal(controller, this.lifecycleController.signal),
    };
    this.contextRestoreController = restoreController;
    void (async () => {
      let ownedItems: readonly StoryCharacter[] = [];
      let failures: readonly CharacterGraphicsRestoreFailure[] = [];
      let infrastructureError: unknown = null;
      try {
        ownedItems = this.releaseInvalidCharacterGraphics();
        if (this.cubismShaderContextAcquired) {
          releaseCubismShaderContext(renderer.getContext());
          this.cubismShaderContextAcquired = false;
        }
        acquireCubismShaderContext(renderer.getContext());
        this.cubismShaderContextAcquired = true;
        this.renderFailureCount = 0;
        this.renderRetryAtSeconds = 0;
        this.previousFrameTime = performance.now();
        this.targetFrameClock.reset();
        // The framebuffer and shared shader context are usable again. Resume
        // healthy scene layers immediately while character GPU resources rebuild
        // independently; one slow model must not blank the entire story surface.
        this.contextLost = false;
        this.resize();
        this.syncPostPipeline();
        failures = await this.restoreCharacterGraphics(generation, ownedItems, controller.signal);
      } catch (error) {
        if (!controller.signal.aborted) {
          this.contextLost = true;
          infrastructureError = error;
          console.error(`[ThreeStoryScene] WebGL context restore failed (attempt ${attempt}); retrying`, error);
        }
      } finally {
        const current =
          !this.destroyed &&
          !controller.signal.aborted &&
          generation === this.contextRestoreGeneration &&
          this.contextRestoreController === restoreController;
        this.completeContextRestore(restoreController);
        if (!current) return;
        if (infrastructureError) {
          this.scheduleContextRestoreRetry(attempt + 1);
          return;
        }
        this.contextLost = false;
        this.previousFrameTime = performance.now();
        this.targetFrameClock.reset();
        const now = this.monotonicSeconds();
        for (const failure of failures) {
          if (!this.ownsCharacterController(failure.item)) continue;
          this.requestCharacterModelRecovery(failure.item, failure.error, now, true);
        }
        this.settleContextReadyWaiters(true);
      }
    })();
  }

  private isRenderableContextReady(): boolean {
    const renderer = this.renderer;
    return Boolean(
      renderer &&
      !this.destroyed &&
      !this.contextLost &&
      !this.contextRestoreController &&
      !renderer.getContext().isContextLost(),
    );
  }

  private isRenderableContextGenerationCurrent(generation: number): boolean {
    return generation === this.contextRestoreGeneration && this.isRenderableContextReady();
  }

  private waitForRenderableContext(signal: AbortSignal): Promise<boolean> {
    if (this.isRenderableContextReady()) return Promise.resolve(true);
    if (this.destroyed || signal.aborted) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (ready: boolean): void => {
        if (settled) return;
        settled = true;
        this.contextReadyWaiters.delete(finish);
        signal.removeEventListener("abort", abort);
        resolve(ready && this.isRenderableContextReady());
      };
      const abort = (): void => finish(false);
      this.contextReadyWaiters.add(finish);
      signal.addEventListener("abort", abort, { once: true });
      // Avoid missing a restore that completed between the initial check and
      // waiter registration in this same task turn.
      if (signal.aborted) abort();
      else if (this.isRenderableContextReady()) finish(true);
    });
  }

  private settleContextReadyWaiters(ready: boolean): void {
    for (const settle of [...this.contextReadyWaiters]) settle(ready);
  }

  private scheduleContextRestoreRetry(attempt: number): void {
    if (this.destroyed) return;
    this.cancelContextRestoreRetry();
    const delayMilliseconds = Math.min(4000, 125 * 2 ** Math.min(5, Math.max(0, attempt - 2)));
    this.contextRestoreRetryTimer = setTimeout(() => {
      this.contextRestoreRetryTimer = null;
      if (!this.destroyed && this.contextLost) this.beginContextRestore(attempt);
    }, delayMilliseconds);
  }

  private cancelContextRestoreRetry(): void {
    if (this.contextRestoreRetryTimer == null) return;
    clearTimeout(this.contextRestoreRetryTimer);
    this.contextRestoreRetryTimer = null;
  }

  private cancelContextRestore(): void {
    const active = this.contextRestoreController;
    if (!active) return;
    this.contextRestoreController = null;
    active.detach();
    active.controller.abort();
  }

  private completeContextRestore(active: ContextRestoreController): void {
    active.detach();
    if (this.contextRestoreController === active) this.contextRestoreController = null;
  }

  private releaseInvalidCharacterGraphics(): StoryCharacter[] {
    const ownedItems = new Set<StoryCharacter>(this.cachedCharacterControllers.values());
    for (const item of this.characterItems.values()) ownedItems.add(item);
    for (const { item } of this.stagedCharacterItems.values()) ownedItems.add(item);
    // Release all owners before any replacement acquires the same context-keyed
    // Cubism shader or static-portrait texture/program cache entry. Hidden and
    // staged TargetName+Asset controllers keep their logical state: native Out
    // unregisters only the renderer entry, while the Web staging layer bridges
    // the browser-only asynchronous resource window before Show can commit.
    for (const item of ownedItems) {
      this.releaseCharacterModelSafely(item, "WebGL context restore");
    }
    return [...ownedItems];
  }

  private releaseCharacterModelSafely(item: StoryCharacter, reason: string): void {
    try {
      item.model.release();
    } catch (error) {
      console.warn(`[ThreeStoryScene] character ${item.target} release failed during ${reason}`, error);
    }
  }

  private async restoreCharacterGraphics(
    generation: number,
    ownedItems: readonly StoryCharacter[],
    signal: AbortSignal,
  ): Promise<readonly CharacterGraphicsRestoreFailure[]> {
    const failures: CharacterGraphicsRestoreFailure[] = [];
    await Promise.all(
      ownedItems.map(async (item) => {
        const source = this.resolveCharacterModelSource(item.entry);
        if (!source) {
          failures.push({ item, error: new Error(`Character ${item.target} has no restorable model source`) });
          return;
        }
        let replacement: StoryCharacterModel | null = null;
        // WebGL restores the context object, not its user-created textures,
        // programs, VAOs or Cubism renderer objects.
        try {
          replacement = await this.createCharacterModel(item.entry, source, signal);
          if (!replacement) throw new Error(`Unable to restore character model ${item.target}`);
          if (
            this.destroyed ||
            signal.aborted ||
            generation !== this.contextRestoreGeneration ||
            !this.ownsCharacterController(item)
          ) {
            replacement.release();
            return;
          }
          await this.prepareReplacementCharacterModel(item, replacement, signal);
          if (
            this.destroyed ||
            signal.aborted ||
            generation !== this.contextRestoreGeneration ||
            !this.ownsCharacterController(item)
          ) {
            replacement.release();
            return;
          }

          item.model = replacement;
          replacement = null;
          item.updateFailureCount = 0;
          item.updateRetryAtSeconds = 0;
          item.stalledUpdateCount = 0;
          item.drawFailureCount = 0;
          item.drawRetryAtSeconds = 0;
          item.stalledDrawCount = 0;
        } catch (error) {
          replacement?.release();
          if (!signal.aborted && generation === this.contextRestoreGeneration) failures.push({ item, error });
        }
      }),
    );
    return failures;
  }

  private async prepareReplacementCharacterModel(
    item: StoryCharacter,
    replacement: StoryCharacterModel,
    signal: AbortSignal,
  ): Promise<void> {
    await this.configureModelMultiplyTexture(replacement, this.stageMultiplyTextureVersion);
    if (signal.aborted) throw sceneAbortError(`Character ${item.target} recovery was aborted`);
    const desiredChannels = (): { motionName: string; expressionName: string } => {
      const presentation = this.characterPresentationHistory.get(item.target) || [];
      const latestMotion = [...presentation].reverse().find((event) => event.kind === "motion")?.name;
      const latestExpression = [...presentation].reverse().find((event) => event.kind === "expression")?.name;
      return {
        motionName: firstString(
          item.currentMotionName,
          latestMotion,
          item.entry.profile?.defaultMotionName,
          record(item.entry.runtime).defaultMotionName,
        ),
        expressionName: firstString(
          item.activeExpressionName,
          latestExpression,
          item.entry.profile?.defaultExpressionName,
          record(item.entry.runtime).defaultExpressionName,
        ),
      };
    };
    let prepared = desiredChannels();
    // Coalesce commands that arrive during I/O, but never let rapid authoring or
    // autoplay changes starve installation. playMotion/playExpression retain the
    // latest request and lazy-load it if the final snapshot was not prewarmed.
    for (let pass = 0; pass < CHARACTER_MODEL_RECOVERY_PREPARE_MAX_PASSES; pass += 1) {
      await Promise.all([
        prepared.motionName ? replacement.prepareMotion(prepared.motionName) : Promise.resolve(false),
        prepared.expressionName ? replacement.prepareExpression(prepared.expressionName) : Promise.resolve(false),
      ]);
      if (signal.aborted) throw sceneAbortError(`Character ${item.target} recovery was aborted`);
      const latest = desiredChannels();
      if (latest.motionName === prepared.motionName && latest.expressionName === prepared.expressionName) {
        prepared = latest;
        break;
      }
      prepared = latest;
    }
    // No await is allowed from here through primeInitialFrame. Commands may be
    // dispatched while resources are loading, so this synchronous commit must
    // sample the newest controller state rather than install an older request.
    replacement.setMotionSpeed(this.playbackSpeedRate);
    replacement.setPaused(item.paused);
    const currentMotionName = firstString(item.currentMotionName, prepared.motionName);
    const activeExpressionName = firstString(item.activeExpressionName, prepared.expressionName);
    if (currentMotionName) replacement.playMotion(currentMotionName, item.currentMotionFadeInSeconds ?? 0);
    if (activeExpressionName) {
      replacement.playExpression(activeExpressionName, item.activeExpressionFadeInSeconds ?? 0);
    }
    replacement.primeInitialFrame(this.characterParameterFrame(item));
  }

  destroy(options: { releaseTextures?: boolean } = {}): void {
    if (this.destroyed) {
      // Natural story completion tears the scene down with retention enabled;
      // a later route unmount must still be able to upgrade that decision.
      if (options.releaseTextures !== false) sharedTextureCache.disposeAllWhenIdle();
      return;
    }
    this.destroyed = true;
    this.settleContextReadyWaiters(false);
    this.sceneGeneration += 1;
    this.resetShakeState();
    this.cancelContextRestoreRetry();
    this.cancelContextRestore();
    this.cancelAllCharacterModelRecoveries();
    this.sceneUpdateFailureStates.clear();
    this.lifecycleController.abort();
    this.cancelPendingStageCapture(true);
    this.characterLoadTokens.clear();
    cancelAnimationFrame(this.animationFrame);
    this.animationFrame = 0;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.cancelBackgroundBlurTween();
    this.clearCharacters();
    this.commandEffects.dispose();
    this.stageEffects.dispose();
    this.commandEffectStates.clear();
    this.backgroundMesh?.material.dispose();
    this.backgroundMesh = null;
    this.backgroundCaptureMesh?.removeFromParent();
    this.backgroundCaptureMesh?.material.dispose();
    this.backgroundCaptureMesh = null;
    this.backgroundTextureLease?.release();
    this.backgroundTextureLease = null;
    this.backgroundBaseMaterial.dispose();
    this.backgroundCaptureBaseMaterial.dispose();
    this.backgroundGeometry.dispose();
    this.pipeline?.dispose();
    this.pipeline = null;
    this.clearRuleTransition();
    this.ruleTransitionPass?.dispose();
    this.ruleTransitionPass = null;
    this.overlay?.destroy();
    this.overlay = null;
    const renderer = this.renderer;
    const canvas = renderer?.domElement;
    canvas?.removeEventListener("webglcontextlost", this.handleContextLost, false);
    canvas?.removeEventListener("webglcontextrestored", this.handleContextRestored, false);
    if (renderer && this.cubismShaderContextAcquired) {
      releaseCubismShaderContext(renderer.getContext());
      this.cubismShaderContextAcquired = false;
    }
    renderer?.dispose();
    // Story surfaces are never reused after destroy. Explicitly release the
    // browser context so repeated backward seeks cannot accumulate inactive
    // WebGL contexts until the browser's global limit is reached.
    renderer?.forceContextLoss();
    this.renderer = null;
    canvas?.remove();
    this.mount = null;
    if (options.releaseTextures !== false) sharedTextureCache.disposeAllWhenIdle();
    this.textureCacheKeys.clear();
  }

  detachState(state: AdvPlayerState): void {
    this.state = state;
  }

  resize(): void {
    if (!this.mount || !this.renderer || !this.pipeline) return;
    // CSS rotation changes getBoundingClientRect() to the transformed AABB.
    // Rendering must follow the mount's untransformed layout box instead.
    const surfaceWidth = Math.max(1, Math.round(this.mount.clientWidth || 1));
    const surfaceHeight = Math.max(1, Math.round(this.mount.clientHeight || surfaceWidth / (13 / 6)));
    const displayPortrait =
      globalThis.matchMedia?.("(orientation: portrait)").matches ??
      (globalThis.innerHeight || surfaceHeight) > (globalThis.innerWidth || surfaceWidth);
    const targetAspect = unityAdvOrientedTargetAspect(
      displayPortrait,
      surfaceWidth,
      surfaceHeight,
      finite(this.runtime.layout.designViewportAspect, 16 / 9),
      finite(this.runtime.layout.portraitTargetAspect, 16 / 9),
      positiveFinite(this.runtime.layout.landscapeTargetAspect),
    );
    const viewport = createUnityAdvViewport(surfaceWidth, surfaceHeight, targetAspect);
    const x = viewport.x * surfaceWidth;
    const y = viewport.y * surfaceHeight;
    const width = Math.max(1, viewport.width * surfaceWidth);
    const height = Math.max(1, viewport.height * surfaceHeight);
    const requestedDpr = Math.min(
      Math.max(1, globalThis.devicePixelRatio || 1) *
        clamp(this.runtime.rendererResolutionScale, 0.5, 2) *
        this.adaptiveRenderQuality.scale,
      Math.max(1, finite(this.runtime.rendererResolutionMax, 3)),
    );
    const pixelCountMax = Math.max(1, finite(this.runtime.rendererPixelCountMax, 10_000_000));
    const pixelLimitedDpr = Math.sqrt(pixelCountMax / Math.max(1, width * height));
    const dpr = Math.max(0.5, Math.min(requestedDpr, pixelLimitedDpr));
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(width, height, false);
    Object.assign(this.renderer.domElement.style, {
      position: "absolute",
      left: `${x}px`,
      top: `${y}px`,
      width: `${width}px`,
      height: `${height}px`,
    });
    this.pipeline.setSize(width, height, dpr);
    this.ruleTransitionPass?.setSize(width, height, dpr);
    this.overlay?.setViewport(x, y, width, height);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    Object.assign(this.state.viewport, {
      x,
      y,
      width,
      height,
      surfaceWidth,
      surfaceHeight,
    });
  }

  async preloadLive2D(): Promise<void> {
    const generation = this.sceneGeneration;
    await ensureCubismFramework();
    if (this.destroyed || generation !== this.sceneGeneration) {
      throw sceneAbortError("Cubism initialization outlived its story scene");
    }
  }

  async preloadTexture(url: string): Promise<Texture> {
    return this.loadTexture(url);
  }

  async loadTexture(url: string): Promise<Texture> {
    if (!url) throw new Error("Cannot load an empty ADV texture URL");
    this.textureCacheKeys.add(url);
    return sharedTextureCache.warm(url);
  }

  private acquireTexture(url: string): Promise<SharedTextureLease<Texture>> {
    if (!url) return Promise.reject(new Error("Cannot load an empty ADV texture URL"));
    this.textureCacheKeys.add(url);
    return sharedTextureCache.acquire(url);
  }

  setDeterministicReplayActive(active: boolean): void {
    if (this.deterministicReplayActive === active) return;
    this.deterministicReplayActive = active;
    this.previousFrameTime = performance.now();
    this.targetFrameClock.reset();
  }

  private runTween(options: Parameters<typeof tween>[0]): Promise<void> {
    const lifecycleSignal = this.lifecycleController.signal;
    const callerSignal = options.signal;
    if (!callerSignal || callerSignal === lifecycleSignal) {
      return tween({ ...options, signal: lifecycleSignal });
    }
    const linked = new AbortController();
    const abort = (): void => linked.abort();
    if (callerSignal.aborted || lifecycleSignal.aborted) linked.abort();
    else {
      callerSignal.addEventListener("abort", abort, { once: true });
      lifecycleSignal.addEventListener("abort", abort, { once: true });
    }
    return tween({ ...options, signal: linked.signal }).finally(() => {
      callerSignal.removeEventListener("abort", abort);
      lifecycleSignal.removeEventListener("abort", abort);
    });
  }

  private replaceCharacterTweenController(controllers: Map<string, AbortController>, target: string): AbortController {
    controllers.get(target)?.abort();
    const controller = new AbortController();
    controllers.set(target, controller);
    return controller;
  }

  private releaseCharacterTweenController(
    controllers: Map<string, AbortController>,
    target: string,
    controller: AbortController,
  ): void {
    if (controllers.get(target) === controller) controllers.delete(target);
  }

  private cancelCharacterOwnedTweens(target: string): void {
    this.characterBrightnessTweenControllers.get(target)?.abort();
    this.characterBrightnessTweenControllers.delete(target);
    this.cancelCharacterBlurTween(target);
  }

  private cancelCharacterBlurTween(target: string): void {
    this.characterBlurTweenControllers.get(target)?.abort();
    this.characterBlurTweenControllers.delete(target);
  }

  private cancelAllCharacterOwnedTweens(): void {
    for (const controller of this.characterBrightnessTweenControllers.values()) controller.abort();
    this.characterBrightnessTweenControllers.clear();
    for (const controller of this.characterBlurTweenControllers.values()) controller.abort();
    this.characterBlurTweenControllers.clear();
  }

  private replaceBackgroundBlurTweenController(): AbortController {
    this.backgroundBlurTweenController?.abort();
    const controller = new AbortController();
    this.backgroundBlurTweenController = controller;
    return controller;
  }

  private bindControllerToSignal(controller: AbortController, signal?: AbortSignal): () => void {
    if (!signal) return () => {};
    const abort = (): void => controller.abort();
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", abort, { once: true });
    return () => signal.removeEventListener("abort", abort);
  }

  private cancelBackgroundBlurTween(): void {
    this.backgroundBlurTweenController?.abort();
    this.backgroundBlurTweenController = null;
  }

  private readonly onAnimationFrame = (time: number): void => {
    if (this.destroyed) return;
    try {
      const elapsedMs = time - this.previousFrameTime;
      this.previousFrameTime = time;
      const targetFrameRate = Math.max(1, finite(this.runtime.targetFrameRate, 45));
      const deltaSeconds = this.targetFrameClock.advance(elapsedMs / 1000, targetFrameRate);
      if (deltaSeconds == null) return;
      if (this.deterministicReplayActive) {
        // Asset decode time must not advance Cubism motions/physics or particle
        // clocks—or expose intermediate frames—while a target is assembled.
        this.targetFrameClock.reset();
        return;
      }
      if (this.adaptiveRenderQuality.sample(deltaSeconds * 1000)) this.resize();
      try {
        this.update(deltaSeconds, time / 1000);
      } catch (error) {
        // Keep rendering the last coherent state even if an unforeseen update
        // path escapes its subsystem boundary. Otherwise one deterministic
        // effect fault can make every healthy character appear frozen.
        console.error("[ThreeStoryScene] scene update failed; rendering the current state", error);
      }
      this.render(time / 1000);
    } catch (error) {
      // A browser frame callback is not supervised like Unity's player loop: an
      // escaped exception would otherwise prevent every subsequent animation
      // frame from being scheduled and freeze all characters permanently.
      this.pipeline?.abortFrame();
      console.error("[ThreeStoryScene] animation frame failed; retrying on the next frame", error);
    } finally {
      if (!this.destroyed) this.animationFrame = requestAnimationFrame(this.onAnimationFrame);
    }
  };

  private characterParameterFrame(item: StoryCharacter): CubismParameterFrame {
    const applyFallbackMouth = item.lipSync.enabled && !item.lipSync.motionSyncPcm;
    const frame = item.parameterFrame;
    frame.angleX = item.angleOverride ? item.angle : undefined;
    frame.bodyAngleX = item.angleOverride ? item.bodyAngle : undefined;
    frame.lookX = item.lookOverride ? finite(item.lookX) : undefined;
    frame.lookY = item.lookOverride ? finite(item.lookY) : undefined;
    frame.mouthOpenY = applyFallbackMouth ? item.lipSync.mouthOpenY : undefined;
    frame.motionSyncPcm = item.lipSync.motionSyncPcm;
    frame.motionSyncWeight = item.lipSync.multiplier;
    frame.blends = this.harmonicBlends(item);
    return frame;
  }

  private update(deltaSeconds: number, timeSeconds = this.monotonicSeconds()): void {
    this.pumpCharacterModelRecoveries(timeSeconds);
    this.runSceneUpdateSubsystem("rule transition", timeSeconds, () => this.ruleTransition.update(deltaSeconds));
    this.runSceneUpdateSubsystem("camera shake", timeSeconds, () => this.updatePersistentCameraShake(deltaSeconds));
    for (const item of this.characterItems.values()) {
      if (timeSeconds < item.updateRetryAtSeconds) continue;
      try {
        if (!item.model.isOperational) {
          // Released/uninitialized SDK wrappers intentionally no-op instead of
          // throwing. Detect that state explicitly so it cannot masquerade as
          // a healthy but motionless character forever.
          if (!this.contextRestoreController) {
            this.requestCharacterModelRecovery(
              item,
              new Error(`Character ${item.target} model is no longer operational`),
              timeSeconds,
              true,
            );
          }
          continue;
        }
        // Pause freezes the authored motion/expression clocks inside the model,
        // but the character still receives every scene frame. Keeping lip sync,
        // harmonic inputs, blink, physics and Core evaluation alive prevents a
        // stale Pause/Resume latch from becoming a permanent static image.
        this.updateLipSync(item, deltaSeconds);
        item.harmonicTime += deltaSeconds;
        const updateSerial = item.model.updateSerial;
        item.model.update(deltaSeconds, this.characterParameterFrame(item));
        if (item.model.updateSerial === updateSerial) {
          item.stalledUpdateCount += 1;
          if (item.stalledUpdateCount >= CHARACTER_FRAME_FAILURE_REBUILD_THRESHOLD) {
            item.stalledUpdateCount = 0;
            this.requestCharacterModelRecovery(
              item,
              new Error(`Character ${item.target} model accepted frames without advancing`),
              timeSeconds,
              true,
            );
          }
          continue;
        }
        item.stalledUpdateCount = 0;
        item.updateFailureCount = 0;
        item.updateRetryAtSeconds = 0;
      } catch (error) {
        this.recordCharacterFrameFailure(item, "update", error, timeSeconds);
      }
    }
    this.runSceneUpdateSubsystem("command effects", timeSeconds, () => this.commandEffects.update(deltaSeconds));
    this.runSceneUpdateSubsystem("stage effects", timeSeconds, () => this.stageEffects.update(deltaSeconds));
    this.runSceneUpdateSubsystem("video state", timeSeconds, () => {
      const video = this.overlay?.videoElement;
      if (!video) return;
      const duration = Number.isFinite(video.duration) ? video.duration : 0;
      this.state.video.currentTime = video.currentTime;
      this.state.video.duration = duration;
      this.state.video.progress = duration > 0 ? video.currentTime / duration : 0;
      this.state.video.ended = video.ended;
      this.state.video.playing = !video.paused && !video.ended;
    });
  }

  private runSceneUpdateSubsystem(name: string, timeSeconds: number, update: () => void): void {
    const previous = this.sceneUpdateFailureStates.get(name);
    if (previous && timeSeconds < previous.retryAtSeconds) return;
    try {
      update();
      if (previous) this.sceneUpdateFailureStates.delete(name);
    } catch (error) {
      const failures = (previous?.failures ?? 0) + 1;
      this.sceneUpdateFailureStates.set(name, {
        failures,
        retryAtSeconds: timeSeconds + Math.min(4, 0.125 * 2 ** Math.min(5, failures - 1)),
      });
      if (failures === 1 || (failures & (failures - 1)) === 0) {
        console.error(`[ThreeStoryScene] ${name} update failed (attempt ${failures}); retrying`, error);
      }
    }
  }

  private render(timeSeconds: number): void {
    if (!this.renderer || !this.pipeline) return;
    // A context loss is recoverable by the browser/Three and must not latch a
    // permanent scene fault. Other synchronous renderer/SDK failures are
    // deterministic, so retrying them every animation frame only burns CPU.
    if (this.contextLost || this.renderer.getContext().isContextLost() || timeSeconds < this.renderRetryAtSeconds)
      return;
    this.applyTransforms();
    this.commandEffects.syncAnchors();
    this.stageEffects.syncAnchors();
    const capture = this.pendingStageCapture;
    // pipeline.beginBackground renders the scene before any Cubism draw, and
    // WebGLRenderer updates both scene and camera matrices there. Explicitly
    // traversing the same trees here duplicated that work every frame; effect
    // anchors already update their own parent chain in syncAnchor().
    try {
      const characters = this.sortedCharacterItems;
      characters.length = 0;
      for (const item of this.characterItems.values()) characters.push(item);
      characters.sort(
        (left, right) =>
          right.sortingOrder - left.sortingOrder ||
          this.characterPriority(left.positionType) - this.characterPriority(right.positionType),
      );
      const groupCount = this.characterRenderGroups(characters);
      const beginOptions = this.postBeginOptions;
      beginOptions.captureStage = Boolean(capture);
      beginOptions.advBackEffects = this.effectLayer(this.commandAdvBackScene);
      this.pipeline.beginBackground(this.scene, this.camera, beginOptions);
      if (capture && capture.generation === this.stageCaptureGeneration) {
        this.stageCaptureAlpha = 1;
        this.pendingStageCapture = null;
        capture.resolve(capture.generation);
      }
      this.pipeline.compositeStageCapture(this.stageCaptureAlpha);
      for (let groupIndex = 0; groupIndex < groupCount; groupIndex += 1) {
        const group = this.characterRenderGroupPool[groupIndex]!;
        const frame = this.pipeline.beginCharacterGroup(group.settings);
        for (const item of group.items) {
          this.renderMvp
            .copy(this.camera.projectionMatrix)
            .multiply(this.camera.matrixWorldInverse)
            .multiply(item.node.matrixWorld);
          // Unity applies character Alpha/Brightness once in AlphaBlend.shader
          // after the whole adjacent group has been rendered into tempRT.
          this.cubismDrawState.objectToWorld = item.node.matrixWorld;
          this.cubismDrawState.timeSeconds = timeSeconds;
          if (timeSeconds >= item.drawRetryAtSeconds) {
            try {
              this.pipeline.prepareCubismDraw(frame);
              const drawSerial = item.model.drawSerial;
              item.model.draw(
                this.renderMvp,
                frame.framebuffer,
                frame.viewport,
                WHITE_CUBISM_COLOR,
                this.cubismDrawState,
              );
              if (item.model.drawSerial === drawSerial) {
                item.stalledDrawCount += 1;
                if (item.stalledDrawCount >= CHARACTER_FRAME_FAILURE_REBUILD_THRESHOLD) {
                  item.stalledDrawCount = 0;
                  this.requestCharacterModelRecovery(
                    item,
                    new Error(`Character ${item.target} model accepted draws without submitting`),
                    timeSeconds,
                    true,
                  );
                }
              } else {
                item.stalledDrawCount = 0;
                item.drawFailureCount = 0;
                item.drawRetryAtSeconds = 0;
              }
            } catch (error) {
              this.renderer.resetState();
              this.recordCharacterFrameFailure(item, "draw", error, timeSeconds);
            }
          }
          const routedEffects = this.commandCharacterScenes.get(item.positionType);
          const characterEffectLayer = routedEffects ? this.effectLayer(routedEffects) : null;
          if (characterEffectLayer) this.pipeline.renderCharacterLayer(characterEffectLayer);
        }
        this.pipeline.finishCharacterGroup(group.settings);
      }
      const finishOptions = this.postFinishOptions;
      finishOptions.timeSeconds = timeSeconds;
      finishOptions.foreground = this.stageEffects.layer(this.camera);
      finishOptions.commandEffects = this.effectLayer(this.commandAdvFrontScene);
      finishOptions.uiEffects = this.effectLayer(this.commandUiScene);
      this.pipeline.finish(finishOptions);
      this.ruleTransitionPass?.render(this.ruleTransition.renderState);
      this.renderFailureCount = 0;
      this.renderRetryAtSeconds = 0;
    } catch (error) {
      const contextLost = this.renderer?.getContext().isContextLost() ?? false;
      if (!contextLost) {
        const count = ++this.renderFailureCount;
        this.renderRetryAtSeconds = timeSeconds + Math.min(4, 0.125 * 2 ** Math.min(5, count - 1));
        if (count === 1 || (count & (count - 1)) === 0) {
          console.error(`[ThreeStoryScene] scene render failed (attempt ${count}); retrying`, error);
        }
      }
      this.pipeline.abortFrame();
    }
  }

  private recordCharacterFrameFailure(
    item: StoryCharacter,
    phase: "update" | "draw",
    error: unknown,
    timeSeconds: number,
  ): void {
    const countKey = phase === "update" ? "updateFailureCount" : "drawFailureCount";
    const retryKey = phase === "update" ? "updateRetryAtSeconds" : "drawRetryAtSeconds";
    const count = item[countKey] + 1;
    item[countKey] = count;
    // Retry transient SDK/GL faults, but cap repeated failures so one broken
    // model cannot consume the whole frame budget or block healthy characters.
    item[retryKey] = timeSeconds + Math.min(4, 0.125 * 2 ** Math.min(5, count - 1));
    if (count === 1 || (count & (count - 1)) === 0) {
      console.error(`[ThreeStoryScene] character ${item.target} ${phase} failed (attempt ${count})`, error);
    }
    if (count >= CHARACTER_FRAME_FAILURE_REBUILD_THRESHOLD) {
      this.requestCharacterModelRecovery(item, error, timeSeconds);
    }
  }

  private invokeCharacterModel<T>(
    item: StoryCharacter,
    operation: string,
    fallback: T,
    invoke: (model: StoryCharacterModel) => T,
  ): T {
    // Logical controller state continues to advance during context restore or
    // a single-flight rebuild. prepareReplacementCharacterModel commits that
    // latest state immediately before installation.
    if (this.destroyed || this.contextLost || this.characterModelRecoveryStates.has(item)) return fallback;
    try {
      return invoke(item.model);
    } catch (error) {
      const failure = new Error(`Character ${item.target} model command ${operation} failed`);
      Object.assign(failure, { cause: error });
      this.requestCharacterModelRecovery(item, failure, this.monotonicSeconds(), true);
      return fallback;
    }
  }

  private async invokeCharacterModelTask<T>(
    item: StoryCharacter,
    operation: string,
    fallback: T,
    invoke: (model: StoryCharacterModel) => Promise<T>,
  ): Promise<T> {
    if (this.destroyed || this.contextLost || this.characterModelRecoveryStates.has(item)) return fallback;
    try {
      return await invoke(item.model);
    } catch (error) {
      const failure = new Error(`Character ${item.target} model task ${operation} failed`);
      Object.assign(failure, { cause: error });
      this.requestCharacterModelRecovery(item, failure, this.monotonicSeconds(), true);
      return fallback;
    }
  }

  private requestCharacterModelRecovery(
    item: StoryCharacter,
    error: unknown,
    timeSeconds = this.monotonicSeconds(),
    immediate = false,
  ): void {
    if (this.destroyed || !this.ownsCharacterController(item)) return;
    let state = this.characterModelRecoveryStates.get(item);
    if (!state) {
      if (immediate) {
        console.error(
          `[ThreeStoryScene] character ${item.target} model fault detected; rebuilding independently`,
          error,
        );
      }
      state = {
        generation: 0,
        attempts: 0,
        retryAtSeconds: timeSeconds,
        controller: null,
        detach: null,
      };
      this.characterModelRecoveryStates.set(item, state);
    } else {
      if (immediate) state.retryAtSeconds = Math.min(state.retryAtSeconds, timeSeconds);
    }
    if (!this.contextLost && !state.controller && state.retryAtSeconds <= timeSeconds) {
      this.startCharacterModelRecovery(item, state);
    }
  }

  private pumpCharacterModelRecoveries(timeSeconds: number): void {
    if (this.destroyed || this.contextLost) return;
    for (const [item, state] of this.characterModelRecoveryStates) {
      if (!this.ownsCharacterController(item)) {
        this.cancelCharacterModelRecovery(item);
        continue;
      }
      if (!state.controller && state.retryAtSeconds <= timeSeconds) this.startCharacterModelRecovery(item, state);
    }
  }

  private startCharacterModelRecovery(item: StoryCharacter, state: CharacterModelRecoveryState): void {
    if (
      this.destroyed ||
      this.contextLost ||
      state.controller ||
      this.characterModelRecoveryStates.get(item) !== state ||
      !this.ownsCharacterController(item)
    ) {
      return;
    }
    const source = this.resolveCharacterModelSource(item.entry);
    if (!source) {
      state.attempts += 1;
      state.retryAtSeconds =
        this.monotonicSeconds() +
        Math.min(CHARACTER_MODEL_RECOVERY_MAX_DELAY_SECONDS, 0.5 * 2 ** Math.min(6, state.attempts - 1));
      return;
    }

    const controller = new AbortController();
    const detach = this.bindControllerToSignal(controller, this.lifecycleController.signal);
    const generation = ++state.generation;
    const expectedModel = item.model;
    state.controller = controller;
    state.detach = detach;
    state.attempts += 1;
    const attempt = state.attempts;

    void (async () => {
      let replacement: StoryCharacterModel | null = null;
      try {
        replacement = await this.createCharacterModel(item.entry, source, controller.signal);
        if (!replacement) throw new Error(`Unable to rebuild character model ${item.target}`);
        if (!this.isCharacterModelRecoveryCurrent(item, state, generation, expectedModel, controller.signal)) {
          replacement.release();
          return;
        }
        await this.prepareReplacementCharacterModel(item, replacement, controller.signal);
        if (!this.isCharacterModelRecoveryCurrent(item, state, generation, expectedModel, controller.signal)) {
          replacement.release();
          return;
        }

        item.model = replacement;
        replacement = null;
        item.updateFailureCount = 0;
        item.updateRetryAtSeconds = 0;
        item.stalledUpdateCount = 0;
        item.drawFailureCount = 0;
        item.drawRetryAtSeconds = 0;
        item.stalledDrawCount = 0;
        this.characterModelRecoveryStates.delete(item);
        try {
          expectedModel.release();
        } catch (releaseError) {
          console.warn(
            `[ThreeStoryScene] replaced character ${item.target} could not release its failed model`,
            releaseError,
          );
        }
        this.renderer?.resetState();
        console.info(`[ThreeStoryScene] character ${item.target} model recovered after ${attempt} rebuild attempt(s)`);
      } catch (recoveryError) {
        replacement?.release();
        if (!this.isCharacterModelRecoveryCurrent(item, state, generation, expectedModel, controller.signal)) return;
        state.retryAtSeconds =
          this.monotonicSeconds() +
          Math.min(CHARACTER_MODEL_RECOVERY_MAX_DELAY_SECONDS, 0.5 * 2 ** Math.min(6, attempt - 1));
        if (attempt === 1 || (attempt & (attempt - 1)) === 0) {
          console.error(
            `[ThreeStoryScene] character ${item.target} model rebuild failed (attempt ${attempt}); retrying`,
            recoveryError,
          );
        }
      } finally {
        detach();
        if (this.characterModelRecoveryStates.get(item) === state && state.generation === generation) {
          state.controller = null;
          state.detach = null;
        }
      }
    })();
  }

  private isCharacterModelRecoveryCurrent(
    item: StoryCharacter,
    state: CharacterModelRecoveryState,
    generation: number,
    expectedModel: StoryCharacterModel,
    signal: AbortSignal,
  ): boolean {
    return (
      !this.destroyed &&
      !this.contextLost &&
      !signal.aborted &&
      state.generation === generation &&
      this.characterModelRecoveryStates.get(item) === state &&
      item.model === expectedModel &&
      this.ownsCharacterController(item)
    );
  }

  private cancelCharacterModelRecovery(item: StoryCharacter): void {
    const state = this.characterModelRecoveryStates.get(item);
    if (!state) return;
    this.characterModelRecoveryStates.delete(item);
    state.detach?.();
    state.detach = null;
    state.controller?.abort();
    state.controller = null;
  }

  private cancelAllCharacterModelRecoveries(): void {
    for (const item of [...this.characterModelRecoveryStates.keys()]) this.cancelCharacterModelRecovery(item);
  }

  private characterRenderGroups(characters: readonly StoryCharacter[]): number {
    let groupCount = 0;
    for (const item of characters) {
      if (item.alpha <= 0.0001) continue;
      const blur = Math.max(0, item.blurIntensity);
      const alpha = clamp(item.alpha);
      const brightness = Math.max(0, item.brightness);
      const previous = groupCount > 0 ? this.characterRenderGroupPool[groupCount - 1]! : undefined;
      if (
        previous &&
        unityApproximately(previous.settings.blur, blur) &&
        unityApproximately(previous.settings.alpha, alpha) &&
        unityApproximately(previous.settings.brightness, brightness)
      ) {
        previous.items.push(item);
      } else {
        let group = this.characterRenderGroupPool[groupCount];
        if (!group) {
          group = {
            settings: { blur: 0, alpha: 1, brightness: 1, radiusMax: 0 },
            items: [],
          };
          this.characterRenderGroupPool.push(group);
        }
        group.settings.blur = blur;
        group.settings.alpha = alpha;
        group.settings.brightness = brightness;
        group.settings.radiusMax = Math.max(0, this.fieldRendererState.blurRadiusMax);
        group.items.length = 0;
        group.items.push(item);
        groupCount += 1;
      }
    }
    for (let index = groupCount; index < this.characterRenderGroupPool.length; index += 1) {
      this.characterRenderGroupPool[index]!.items.length = 0;
    }
    return groupCount;
  }

  private effectLayer(scene: Scene): AdvSceneLayer | null {
    if (!scene.children.length) return null;
    let layer = this.sceneLayerCache.get(scene);
    if (!layer) {
      layer = { scene, camera: this.camera };
      this.sceneLayerCache.set(scene, layer);
    }
    return layer;
  }

  private commandCharacterScene(positionType: number): Scene {
    let scene = this.commandCharacterScenes.get(positionType);
    if (!scene) {
      scene = new Scene();
      scene.name = `Unity ADV Camera${(positionType + 1) / 2} Command Effects`;
      this.commandCharacterScenes.set(positionType, scene);
    }
    return scene;
  }

  private commandEffectScene(route: AdvEffectRoute): Scene {
    if (route.phase === "advBack") return this.commandAdvBackScene;
    if (route.phase === "ui") return this.commandUiScene;
    if (route.phase === "character") return this.commandCharacterScene(route.positionType ?? 5);
    return this.commandAdvFrontScene;
  }

  private harmonicBlends(item: StoryCharacter): CubismParameterBlend[] {
    if (!this.qualityConfig.isCharacterBreathMotionEnabled()) {
      item.harmonicBlends.length = 0;
      return item.harmonicBlends;
    }
    const harmonic = item.entry.harmonicMotion || record(item.entry.runtime).harmonicMotion;
    return evaluateAdvHarmonicMotion(
      harmonic as AdvHarmonicMotionData | null | undefined,
      item.harmonicTime,
      item.model,
      item.harmonicBlends,
    );
  }

  private updateLipSync(item: StoryCharacter, deltaSeconds: number): void {
    const lip = item.lipSync;
    if (!lip.enabled) return;
    const pseudoPlaybackRate = lip.source === "timed" ? this.playbackSpeedRate : 1;
    if (lip.source === "voice") {
      if (!lip.sources.length && item.model.motionSyncStatus === "unconfigured") {
        // Native leaves Timed in LipMode 2 for one OnLateUpdate when no
        // MotionSync controller exists; that frame runs ResetLip.
        this.resetLipSync(item);
        return;
      }
      lip.voiceRemaining = Math.max(
        0,
        (lip.voiceExpiresAtSeconds - this.monotonicSeconds()) * Math.max(0.001, lip.voiceSpeed),
      );
      const motionSyncReady = item.model.motionSyncStatus === "ready";
      const input = sampleVoiceMotionSyncInput(lip.sources, motionSyncReady, item.voiceMotionSyncInput);
      lip.motionSyncPcm = motionSyncReady ? input.pcm : null;
      if (lip.motionSyncPcm) {
        // Core output controls both ParamMouthOpenY and ParamMouthForm. These
        // fallback fields must not be blended over the captured-base result.
        lip.mouthOpenY = 0;
        lip.mouthForm = 0;
      } else if (input.playing && !input.analyzable) {
        // Old WebViews and a Howler backend fallback may expose no decoded PCM
        // or analyser. Keep that rare path speech-like and aperiodic rather
        // than returning to a fixed 0.4 s triangle wave.
        const pseudo = advanceAdvPseudoLipSync(lip, {
          deltaSeconds,
          currentMouthOpening: lip.mouthOpenY,
          multiplier: lip.voiceMultiplier,
          random: () => nextRandom(lip.randomSeed),
        });
        lip.mouthOpenY = clamp(pseudo.rawOpening);
      } else {
        const target = input.playing ? voiceRmsMouthOpening(input.rms, lip.voiceMultiplier) : 0;
        lip.mouthOpenY +=
          (target - lip.mouthOpenY) * (1 - Math.exp(-deltaSeconds / (target > lip.mouthOpenY ? 0.025 : 0.075)));
      }
      if (!input.playing && !input.pending && lip.voiceRemaining <= 0 && lip.mouthOpenY < 0.001) {
        this.resetLipSync(item);
      }
      return;
    }

    this.advanceTimedLipSyncFrame(item, deltaSeconds, pseudoPlaybackRate);
  }

  private advanceTimedLipSyncFrame(item: StoryCharacter, deltaSeconds: number, playbackRate: number): void {
    const lip = item.lipSync;
    if (!lip.enabled || lip.source !== "timed") return;
    const rate = Math.max(0.001, finite(playbackRate, 1));
    const scaledDelta = Math.max(0, deltaSeconds) * Math.max(0.001, lip.speed) * rate;
    lip.motionSyncPcm = null;
    // OnLateUpdate updates the oscillator before decrementing the talk timer.
    // The frame that crosses zero only arms the 0.3 s close tail; subtraction
    // from that tail begins on the following frame.
    const stopping = lip.timedRemaining < 0;
    const pseudo =
      lip.timedMode === "hold-open"
        ? advanceAdvHoldOpenPseudoLipSync(lip, {
            deltaSeconds,
            speedMultiplier: rate,
            currentMouthOpening: lip.mouthOpenY,
            manualLevel: lip.holdOpenLevel,
            stopping,
            random: () => nextRandom(lip.randomSeed),
          })
        : advanceAdvPseudoLipSync(lip, {
            deltaSeconds,
            speedMultiplier: rate,
            currentMouthOpening: lip.mouthOpenY,
            multiplier: lip.multiplier,
            stopping,
            random: () => nextRandom(lip.randomSeed),
          });
    lip.mouthOpenY = clamp(pseudo.rawOpening);

    if (!stopping) {
      lip.timedRemaining -= scaledDelta;
      if (lip.timedRemaining <= 0) lip.stopRemaining = PSEUDO_LIP_STOP_DURATION;
    } else if (lip.stopRemaining >= 0) {
      lip.stopRemaining -= scaledDelta;
      if (lip.stopRemaining <= 0) this.finishTimedLipSync(item);
    }
  }

  private resetLipSync(item: StoryCharacter): void {
    Object.assign(item.lipSync, {
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
      timer: 0,
      openScale: 0,
      isOpen: false,
      beforeLevel: 0,
      mouthOpenY: 0,
      mouthForm: 0,
      motionSyncPcm: null,
      dampVelocity: { value: 0 },
      sources: [],
    });
    this.invokeCharacterModel(item, "reset motion sync", undefined, (model) => model.resetMotionSync());
  }

  private finishTimedLipSync(item: StoryCharacter): void {
    this.leaveTimedLipSync(item);
  }

  private fieldPosition(kind: "background" | "character", target: Vec3): Vec3 {
    const stage = record(this.state.stage || this.runtime.stage);
    const key = kind === "background" ? "backgroundFieldPosition" : "characterFieldPosition";
    const fallback = kind === "background" ? BACKGROUND_FIELD_POSITION : CHARACTER_FIELD_POSITION;
    return vec3(stage[key] ?? record(this.runtime.stage)[key], fallback, target);
  }

  private fieldScale(kind: "background" | "character"): number {
    const stage = record(this.state.stage || this.runtime.stage);
    const key = kind === "background" ? "backgroundFieldScale" : "characterFieldScale";
    return Math.max(0.001, finite(stage[key] ?? record(this.runtime.stage)[key], kind === "background" ? 1 : 4));
  }

  private stageFov(): number {
    return Math.max(1, finite(record(this.state.stage).fov, finite(this.runtime.stage.fov, 39.6)));
  }

  private applyTransforms(): void {
    const backgroundPosition = this.fieldPosition("background", this.scratchBackgroundPosition);
    backgroundPosition.x += this.backgroundShake.x;
    backgroundPosition.y += this.backgroundShake.y;
    unityVector3(backgroundPosition, this.backgroundField.position);
    this.backgroundCaptureField.position.copy(this.backgroundField.position);
    const characterPosition = this.fieldPosition("character", this.scratchCharacterPosition);
    characterPosition.x += this.characterShake.x;
    characterPosition.y += this.characterShake.y;
    unityVector3(characterPosition, this.characterField.position);
    // ApplyFieldScale obtains the SpriteRenderer transform from its parent
    // field. The shared _field root remains unscaled; in particular, the
    // fixed black BaseRenderer and its local Z offset never inherit this value.
    this.backgroundField.scale.setScalar(1);
    this.backgroundCaptureField.scale.copy(this.backgroundField.scale);
    const tint = stageSpriteTint(record(this.state.stage).backgroundColor, this.scratchTint);
    const backgroundBrightness = Math.max(0, this.fieldRendererState.brightness);
    this.applyBackgroundTint(this.backgroundMesh, tint, backgroundBrightness);
    this.applyBackgroundTint(this.backgroundCaptureMesh, tint, backgroundBrightness);
    this.scratchEuler.x = 0;
    this.scratchEuler.y = this.cameraState.fieldRotationY;
    this.scratchEuler.z = 0;
    unityEulerDegrees(this.scratchEuler, this.backgroundField.quaternion);
    this.backgroundCaptureField.quaternion.copy(this.backgroundField.quaternion);
    unityEulerDegrees(this.scratchEuler, this.characterField.quaternion);
    const cameraPosition = this.scratchStagePosition;
    cameraPosition.x = this.cameraState.baseX + this.cameraState.panOffsetX + this.cameraShake.x;
    cameraPosition.y = this.cameraState.baseY + this.cameraShake.y;
    cameraPosition.z = this.cameraState.baseZ + this.cameraState.panOffsetY;
    unityVector3(cameraPosition, this.camera.position);
    this.scratchEuler.x = this.cameraState.rotationX;
    this.scratchEuler.y = this.cameraState.rotationY;
    this.scratchEuler.z = this.cameraState.angle;
    unityEulerDegrees(this.scratchEuler, this.camera.quaternion);
    const fov = AdvCamera.effectiveFov(this.stageFov(), this.cameraState.zoomRatio);
    if (this.camera.fov !== fov) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
    const characterFieldScale = this.fieldScale("character");
    this.refreshStageNodes(characterFieldScale);
    for (const item of this.characterItems.values()) this.layoutCharacter(item, characterFieldScale);
  }

  private applyBackgroundTint(mesh: BackgroundMesh | null, tint: MutableColor4, brightness: number): void {
    if (!mesh) return;
    // AdvBackgroundField.ApplyBrightness multiplies only the stored
    // SpriteRenderer RGB by brightness and preserves tint alpha.
    mesh.material.color.setRGB(tint.r * brightness, tint.g * brightness, tint.b * brightness);
    mesh.material.opacity = tint.a;
  }

  stagePoint(positionType: unknown): Vec3 {
    const key = Number(positionType) || 5;
    return this.stagePointInto(key, { x: 0, y: 0, z: 0 });
  }

  private stagePointInto(key: number, target: Vec3): Vec3 {
    return vec3(this.runtime.stage.positions?.[key] || this.runtime.stage.focusAnchors?.[key], ZERO_VEC3, target);
  }

  private focusPointInternal(positionType: unknown): Vec3 {
    const key = Number(positionType) || 5;
    return vec3(this.runtime.stage.focusAnchors?.[key] || this.runtime.stage.positions?.[key], ZERO_VEC3);
  }

  private stageOffsetInternal(positionType: number): Vec3 {
    const key = Number(positionType) || 0;
    this.stageNodeKeys.add(key);
    let value = this.stageOffsets.get(key);
    if (!value) {
      value = { x: 0, y: 0, z: 0 };
      this.stageOffsets.set(key, value);
    }
    return value;
  }

  private stageNode(positionType: number): Object3D {
    const key = Number(positionType) || 5;
    this.stageNodeKeys.add(key);
    let node = this.stageNodes.get(key);
    if (!node) {
      node = new Object3D();
      node.name = `AdvCharacterStage${key}`;
      this.stageNodes.set(key, node);
      this.characterField.add(node);
    }
    return node;
  }

  private refreshStageNodes(fieldScale = this.fieldScale("character")): void {
    this.scratchEuler.x = 0;
    this.scratchEuler.y = this.cameraState.stageRotationY;
    this.scratchEuler.z = 0;
    for (const key of this.stageNodeKeys) {
      const node = this.stageNode(key);
      const base = this.stagePointInto(key, this.scratchStagePosition);
      const offset = this.stageOffsetInternal(key);
      base.x += offset.x;
      base.y += offset.y;
      base.z += offset.z;
      unityVector3(base, node.position);
      unityEulerDegrees(this.scratchEuler, node.quaternion);
      // AdvCharacterField.ApplyFieldScale scales each of the five stage
      // transforms, not the character-field root.
      node.scale.setScalar(fieldScale);
    }
  }

  private layoutCharacter(item: StoryCharacter, fieldScale = this.fieldScale("character")): void {
    const profile = item.entry.profile || {};
    const basePosition = vec3(profile.basePosition, CHARACTER_BASE_POSITION, this.scratchCharacterBasePosition);
    const scale = Math.max(0.001, finite(profile.baseScale, 1.6));
    const expectedParent = this.stageNode(item.positionType);
    if (item.node.parent !== expectedParent) expectedParent.add(item.node);
    if (item.worldPosition) {
      // Absolute adapter coordinates are resolved into the same authored ADV
      // field basis as native stage points. Dynamic field/stage transforms stay
      // on the parent nodes, so shake, tilt and camera movement affect both
      // placement modes through the regular scene graph.
      const fieldPosition = this.fieldPosition("character", this.scratchCharacterPosition);
      const stagePosition = this.stagePointInto(item.positionType, this.scratchStagePosition);
      basePosition.x = (item.worldPosition.x + item.offset.x - fieldPosition.x - stagePosition.x) / fieldScale;
      basePosition.y = (item.worldPosition.y + item.offset.y - fieldPosition.y - stagePosition.y) / fieldScale;
      basePosition.z = (item.worldPosition.z + item.offset.z - fieldPosition.z - stagePosition.z) / fieldScale;
    } else {
      basePosition.x += item.offset.x / fieldScale;
      basePosition.y += item.offset.y / fieldScale;
      basePosition.z += item.offset.z / fieldScale;
    }
    unityVector3(basePosition, item.node.position);
    item.node.scale.set(scale * item.facing, scale, scale);
    this.scratchEuler.x = 0;
    this.scratchEuler.y = 0;
    this.scratchEuler.z = item.roleAngle;
    unityEulerDegrees(this.scratchEuler, item.node.quaternion);
  }

  private characterAuthoredWorldPosition(item: StoryCharacter): Vec3 {
    if (item.worldPosition) return { ...item.worldPosition };
    const profile = item.entry.profile || {};
    const base = vec3(profile.basePosition, CHARACTER_BASE_POSITION);
    const field = this.fieldPosition("character", { x: 0, y: 0, z: 0 });
    const stage = this.stagePoint(item.positionType);
    const fieldScale = this.fieldScale("character");
    return {
      x: field.x + stage.x + base.x * fieldScale + item.offset.x,
      y: field.y + stage.y + base.y * fieldScale + item.offset.y,
      z: field.z + stage.z + base.z * fieldScale + item.offset.z,
    };
  }

  private beginCharacterLoad(target: string, cmd: AdvCommand): { scene: number; target: number; signal: AbortSignal } {
    this.cancelCharacterOwnedTweens(target);
    this.cancelPendingAngleWait(target);
    this.cancelPendingLookWait(target);
    this.cancelPendingCharacterLoadController(target);
    this.releaseStagedCharacter(target);
    this.pendingCharacterPlacements.delete(target);
    this.pendingCharacterWorldPositions.delete(target);
    const targetToken = ++this.characterLoadSequence;
    this.characterLoadTokens.set(target, targetToken);
    const entry = cmd.live2d as StoryCharacterEntry | undefined;
    this.pendingCharacterCommands.begin(
      target,
      targetToken,
      firstString(entry?.profile?.defaultExpressionName, record(entry?.runtime).defaultExpressionName),
    );
    this.characterPresentationHistory.set(target, []);
    const controller = new AbortController();
    const detach = this.bindControllerToSignal(controller, this.lifecycleController.signal);
    this.pendingCharacterLoadControllers.set(target, { token: targetToken, controller, detach });
    return { scene: this.sceneGeneration, target: targetToken, signal: controller.signal };
  }

  private invalidateCharacterLoad(target: string): void {
    this.cancelPendingAngleWait(target);
    this.cancelPendingLookWait(target);
    this.releaseStagedCharacter(target);
    this.pendingCharacterPlacements.delete(target);
    this.pendingCharacterWorldPositions.delete(target);
    this.pendingCharacterCommands.invalidate(target);
    this.cancelPendingCharacterLoadController(target);
    this.characterLoadTokens.set(target, ++this.characterLoadSequence);
  }

  private cancelPendingCharacterLoadController(target: string, token?: number): void {
    const pending = this.pendingCharacterLoadControllers.get(target);
    if (!pending || (token != null && pending.token !== token)) return;
    this.pendingCharacterLoadControllers.delete(target);
    pending.detach();
    pending.controller.abort();
  }

  private completePendingCharacterLoadController(target: string, token: number): void {
    const pending = this.pendingCharacterLoadControllers.get(target);
    if (!pending || pending.token !== token) return;
    this.pendingCharacterLoadControllers.delete(target);
    pending.detach();
  }

  private releaseStagedCharacter(target: string, expected?: StoryCharacter): void {
    const staged = this.stagedCharacterItems.get(target);
    if (!staged || (expected && staged.item !== expected)) return;
    this.stagedCharacterItems.delete(target);
    this.cancelCharacterModelRecovery(staged.item);
    staged.item.angleTweenController?.abort();
    staged.item.lookTweenController?.abort();
    staged.item.node.removeFromParent();
    this.releaseCharacterModelSafely(staged.item, "staged character release");
  }

  private stageCharacter(target: string, token: number, item: StoryCharacter): boolean {
    if (token !== this.characterLoadTokens.get(target)) return false;
    this.releaseStagedCharacter(target);
    this.stagedCharacterItems.set(target, { token, item });
    return true;
  }

  private commitStagedCharacter(target: string, token: number, item: StoryCharacter): boolean {
    const staged = this.stagedCharacterItems.get(target);
    if (!staged || staged.token !== token || staged.item !== item) return false;
    this.stagedCharacterItems.delete(target);
    const identity = this.pendingCharacterPlacements.get(target)?.identity;
    this.pendingCharacterPlacements.delete(target);
    registerCharacterItem(this.characterItems, target, item, () => this.layoutCharacter(item));
    const resolvedIdentity =
      identity || firstString(item.live2dKey, item.entry.url, record(item.entry.runtime).modelUrl, target);
    // CharacterIn captures the controller it started with, but a Costume can
    // change the loader's selected TargetName+AssetIndex while this browser
    // model is still loading. Preserve that newer selection just as the
    // native loader's asset-index map does.
    const selectedIdentity = this.characterControllerIdentities.get(target);
    if (!selectedIdentity || selectedIdentity === resolvedIdentity) {
      this.characterControllerIdentities.set(target, resolvedIdentity);
    }
    this.cachedCharacterControllers.set(resolvedIdentity, item);
    this.completePendingCharacterLoadController(target, token);
    return true;
  }

  private cachedCharacterController(target: string): StoryCharacter | null {
    const identity = this.characterControllerIdentities.get(target);
    return identity ? this.cachedCharacterControllers.get(identity) || null : null;
  }

  private ownsCharacterController(item: StoryCharacter): boolean {
    if (this.characterItems.get(item.target) === item) return true;
    for (const cached of this.cachedCharacterControllers.values()) {
      if (cached === item) return true;
    }
    for (const staged of this.stagedCharacterItems.values()) {
      if (staged.item === item) return true;
    }
    return false;
  }

  private selectedPendingCharacterToken(target: string): number | null {
    const pending = this.pendingCharacterPlacements.get(target);
    const identity = this.characterControllerIdentities.get(target);
    if (
      !pending ||
      !identity ||
      pending.identity !== identity ||
      this.characterLoadTokens.get(target) !== pending.token
    ) {
      return null;
    }
    return pending.token;
  }

  private async markPendingCharacterFadeInStarted(target: string, placement: PendingCharacterPlacement): Promise<void> {
    if (placement.fadeInDurationSeconds <= 0) return;
    for (let frame = 0; frame < UNITY_CHARACTER_FADE_DELAY_FRAMES; frame += 1) await nextFrame();
    if (
      this.pendingCharacterPlacements.get(target) === placement &&
      this.characterLoadTokens.get(target) === placement.token
    ) {
      placement.fadeInStartedAtSeconds = this.monotonicSeconds();
    }
  }

  private pendingCharacterFadeInAlpha(target: string, token: number, atSeconds: number): number {
    const placement = this.pendingCharacterPlacements.get(target);
    if (!placement || placement.token !== token) return 1;
    const duration = Math.max(0, placement.fadeInDurationSeconds);
    if (duration <= 0) return 1;
    if (placement.fadeInStartedAtSeconds == null) return 0;
    return clamp((atSeconds - placement.fadeInStartedAtSeconds) / duration);
  }

  /** Mirror AdvEpisodeResourceLoader.SetCharacterAssetIndex for controller lookup. */
  selectCharacterAssetIndex(target: string, assetIndex: number): void {
    const name = String(target || "");
    if (!name) return;
    this.characterControllerIdentities.set(name, `${name}\u0000${Number(assetIndex) || 0}`);
  }

  private cancelPendingLookWait(target: string): void {
    const controller = this.pendingLookWaitControllers.get(target);
    if (!controller) return;
    this.pendingLookWaitControllers.delete(target);
    controller.abort();
  }

  private cancelPendingAngleWait(target: string): void {
    const controller = this.pendingAngleWaitControllers.get(target);
    if (!controller) return;
    this.pendingAngleWaitControllers.delete(target);
    controller.abort();
  }

  private resetCharacterAngleLook(item: StoryCharacter): void {
    this.cancelPendingAngleWait(item.target);
    this.cancelPendingLookWait(item.target);
    item.angleTweenController?.abort();
    item.lookTweenController?.abort();
    item.angleTweenController = null;
    item.lookTweenController = null;
    item.angle = 0;
    item.bodyAngle = 0;
    item.angleOverride = false;
    item.lookX = 0;
    item.lookY = 0;
    item.lookOriginalX = 0;
    item.lookOriginalY = 0;
    item.lookOverride = false;
  }

  private recordCharacterPresentation(target: string, event: AdvCharacterPresentationEvent): void {
    const history = this.characterPresentationHistory.get(target) || [];
    history.push(event);
    this.characterPresentationHistory.set(target, history);
  }

  private hasCharacterPresentationResource(
    entry: StoryCharacterEntry | undefined,
    channel: "motions" | "expressions",
    name: string,
  ): boolean {
    if (!entry || !name) return false;
    const resources = entry[channel];
    // Some embedders provide only model3.json and let Cubism expose its own
    // resource index. A populated prepared catalogue, however, is the exact
    // equivalent of Live2DCharacter's motion/expression data maps and can
    // reject an authored typo synchronously before it overwrites pending Show
    // state.
    if (!Array.isArray(resources) || resources.length === 0) return true;
    return resources.some((resource) => String(record(resource).name || "") === name);
  }

  private isCharacterLoadCurrent(
    target: string,
    token: { scene: number; target: number; signal: AbortSignal },
  ): boolean {
    return (
      !this.destroyed &&
      !token.signal.aborted &&
      token.scene === this.sceneGeneration &&
      token.target === this.characterLoadTokens.get(target) &&
      Boolean(this.renderer)
    );
  }

  private resolveCharacterModelSource(entry: StoryCharacterEntry): {
    format: "cubism2" | "cubism3" | "static-portrait";
    modelUrl: string;
  } | null {
    const runtime = entry.runtime;
    const format =
      runtime?.format === "cubism2" ? "cubism2" : runtime?.format === "static-portrait" ? "static-portrait" : "cubism3";
    const modelUrl = firstString(
      format === "cubism2" ? runtime?.moc : format === "static-portrait" ? runtime?.imageUrl : runtime?.model,
    );
    return modelUrl ? { format, modelUrl } : null;
  }

  private async createCharacterModel(
    entry: StoryCharacterEntry,
    source: Readonly<{ format: "cubism2" | "cubism3" | "static-portrait"; modelUrl: string }>,
    signal?: AbortSignal,
  ): Promise<StoryCharacterModel | null> {
    const renderer = this.renderer;
    if (!renderer) return null;
    const gl = renderer.getContext();
    if (!(gl instanceof WebGL2RenderingContext)) {
      throw new Error("Story character rendering requires WebGL2");
    }
    const runtime = entry.runtime;
    const activeStage = record(this.state.stage);
    let model: StoryCharacterModel | null = null;
    if (source.format === "cubism2") {
      const c2 = await Cubism2Model.create({
        gl,
        signal,
        mocUrl: String(runtime?.moc || source.modelUrl),
        textureUrls: Array.isArray(runtime?.textures) ? runtime.textures.map(String) : [],
        pixelsPerUnit:
          positiveFinite(runtime?.pixelsPerUnit) ??
          positiveFinite(activeStage.characterPixelsPerUnit) ??
          positiveFinite(this.runtime.stage.characterPixelsPerUnit),
        canvasWorldHeight:
          positiveFinite(runtime?.canvasWorldHeight) ??
          positiveFinite(activeStage.characterCanvasWorldHeight) ??
          positiveFinite(this.runtime.stage.characterCanvasWorldHeight),
        physicsUrl: firstString(runtime?.physics),
        physicsEnabled: this.qualityConfig.isCharacterPhysicsEnabled(),
      });
      if (c2) {
        c2.registerCatalog(
          advCharacterMotions(entry)
            .filter((motion) => motion && motion.name && motion.runtime)
            .map((motion) => ({ name: String(motion.name), url: String(motion.runtime) })),
          advCharacterExpressions(entry)
            .filter((expression) => expression && expression.name && expression.runtime)
            .map((expression) => ({ name: String(expression.name), url: String(expression.runtime) })),
        );
        model = c2;
      }
    } else if (source.format === "static-portrait") {
      model = await StaticPortraitModel.create({
        gl,
        signal,
        imageUrl: String(runtime?.imageUrl || source.modelUrl),
        pixelsPerUnit:
          positiveFinite(runtime?.pixelsPerUnit) ??
          positiveFinite(activeStage.characterPixelsPerUnit) ??
          positiveFinite(this.runtime.stage.characterPixelsPerUnit),
        worldHeight:
          positiveFinite(runtime?.worldHeight) ??
          positiveFinite(activeStage.characterCanvasWorldHeight) ??
          positiveFinite(this.runtime.stage.characterCanvasWorldHeight),
        pivot: runtime?.pivot,
        anisotropy: positiveFinite(this.runtime.live2dTextureMaxAnisotropy),
      });
    } else {
      model = await AdvCubismModel.create({
        gl,
        signal,
        modelUrl: source.modelUrl,
        defaultMotionName: firstString(entry.profile?.defaultMotionName, record(runtime).defaultMotionName),
        maskBufferSize: Math.min(
          Math.max(256, finite(this.runtime.live2dMaskBufferMax, 1024)),
          Math.max(
            256,
            finite(this.runtime.live2dMaskBufferSize, 1024) * finite(this.runtime.live2dMaskResolutionScale, 1),
          ),
        ),
        anisotropy: finite(this.runtime.live2dTextureMaxAnisotropy, 1),
        physics: this.qualityConfig.isCharacterPhysicsEnabled(),
        breath: false,
        lighting: this.cubismLightingState,
        motionSync: runtime?.motionSync ?? entry.motionSync ?? null,
      });
    }
    model?.setMotionSpeed(this.playbackSpeedRate);
    return model;
  }

  private async createCharacter(
    cmd: AdvCommand,
    target: string,
    positionType: number,
    token: { scene: number; target: number; signal: AbortSignal },
  ): Promise<StoryCharacter | null> {
    const entry = cmd.live2d as StoryCharacterEntry | undefined;
    const source = entry ? this.resolveCharacterModelSource(entry) : null;
    if (!entry || !source || !this.isCharacterLoadCurrent(target, token)) return null;
    const modelUrl = source.modelUrl;
    while (this.isCharacterLoadCurrent(target, token)) {
      if (!(await this.waitForRenderableContext(token.signal))) return null;
      const contextGeneration = this.contextRestoreGeneration;
      let model: StoryCharacterModel | null = null;
      let item: StoryCharacter | null = null;
      try {
        model = await this.createCharacterModel(entry, source, token.signal);
        if (!model) return null;
        if (!this.isCharacterLoadCurrent(target, token)) {
          model.release();
          return null;
        }
        // A model may have fetched/decoded across a WebGL loss. Even if its SDK
        // wrapper reports success, resources created before that loss belong to
        // the invalid generation and must never enter the staged controller.
        if (!this.isRenderableContextGenerationCurrent(contextGeneration)) {
          model.release();
          continue;
        }
        item = new StoryCharacter(target, String(cmd.live2dKey || ""), entry, model, positionType);
        const pendingPlacement = this.pendingCharacterPlacements.get(target);
        const pendingWorld = this.pendingCharacterWorldPositions.get(target);
        item.worldPosition =
          (pendingWorld?.token === token.target ? { ...pendingWorld.position } : null) ??
          (pendingPlacement?.token === token.target && pendingPlacement.worldPosition
            ? { ...pendingPlacement.worldPosition }
            : null) ??
          worldPosition(cmd.characterWorldTransition?.from) ??
          worldPosition(cmd.characterWorldPosition) ??
          worldPosition(cmd.characterWorldTransition?.to);
        item.lipSync.randomSeed.value = hashSeed(`${cmd.live2dKey || modelUrl}:${target}`);
        this.layoutCharacter(item);
        if (!this.stageCharacter(target, token.target, item)) {
          model.release();
          return null;
        }
        await this.configureModelMultiplyTexture(model, this.stageMultiplyTextureVersion);
        if (!this.isCharacterLoadCurrent(target, token)) {
          this.releaseStagedCharacter(target, item);
          return null;
        }
        if (!this.isRenderableContextGenerationCurrent(contextGeneration)) {
          this.releaseStagedCharacter(target, item);
          continue;
        }
        return item;
      } catch (error) {
        if (item) this.releaseStagedCharacter(target, item);
        else model?.release();
        if (!this.isCharacterLoadCurrent(target, token)) return null;
        // Context restoration is a retry boundary, not a failed ADV In. Keep
        // the pending command channels and reconstruct against the new GL state.
        if (!this.isRenderableContextGenerationCurrent(contextGeneration)) continue;
        this.pendingCharacterCommands.invalidate(target);
        this.pendingCharacterPlacements.delete(target);
        this.pendingCharacterWorldPositions.delete(target);
        this.cancelPendingCharacterLoadController(target, token.target);
        throw error;
      }
    }
    return null;
  }

  async placeCharacter(cmd: AdvCommand, positionType: number, duration = 0, _noWait = false): Promise<void> {
    const target = String(cmd.targetName || cmd.targets?.[0]?.target || "");
    if (!target) return;
    const alphaOperationAtStart = this.characterAlphaOperations.get(target);
    const transitionFrom = worldPosition(cmd.characterWorldTransition?.from);
    const transitionTo = worldPosition(cmd.characterWorldTransition?.to);
    const initialWorldPosition = transitionFrom ?? worldPosition(cmd.characterWorldPosition) ?? transitionTo;
    const identity = firstString(record(cmd).controllerIdentity, `${target}\u0000${Number(cmd.targetAssetIndex) || 0}`);
    // TryGetCharacterController always consults the loader's current asset
    // index. Select this identity synchronously, before browser model loading.
    this.characterControllerIdentities.set(target, identity);
    const token = this.beginCharacterLoad(target, cmd);
    const entry = cmd.live2d as StoryCharacterEntry | undefined;
    let pendingPlacement: PendingCharacterPlacement | null = null;
    if (entry) {
      pendingPlacement = {
        token: token.target,
        entry,
        positionType: Number(positionType) || 5,
        // Native controller instances are cached by TargetName+AssetIndex and
        // survive Out/In. Only a character/costume asset-index change selects
        // a different controller identity.
        identity,
        worldPosition: initialWorldPosition ? { ...initialWorldPosition } : null,
        fadeInDurationSeconds: Math.max(0, finite(duration)),
        fadeInStartedAtSeconds: null,
      };
      this.pendingCharacterPlacements.set(target, pendingPlacement);
    }
    const previous = this.characterItems.get(target);
    if (previous) {
      this.characterFadeCoordinator.cancel(previous.positionType);
      this.characterItems.delete(target);
    }

    const cached = this.cachedCharacterControllers.get(identity);
    if (cached) {
      const pending = this.pendingCharacterCommands.consume(target, token.target) || {};
      this.pendingCharacterPlacements.delete(target);
      this.pendingCharacterWorldPositions.delete(target);
      this.completePendingCharacterLoadController(target, token.target);
      cached.positionType = Number(positionType) || 5;
      if (initialWorldPosition) cached.worldPosition = { ...initialWorldPosition };
      cached.paused = false;
      cached.pendingPausedMotion = null;
      cached.pendingPausedExpression = null;
      // AdvInCommand.AddSpeaker calls ResetAngleLook after showing the cached
      // controller. This wrapper-level reset is easy to miss because neither
      // Live2DCharacter.Show nor Hide owns it: every new In starts from motion
      // eye/head parameters until a following Angle/Look command takes over.
      this.resetCharacterAngleLook(cached);
      // RegisterCharacterEntry is recreated on every Show, so its blur starts
      // from the field renderer's current slot state rather than the hidden
      // entry that was removed by Out.
      cached.blurIntensity =
        cached.positionType === this.cameraState.focusPositionType ? 0 : this.fieldRendererState.characterBlur;
      const presentation = this.resolveInitialCharacterPresentation(cached, pending);
      const presentationFadeIn = this.defaultCharacterPresentationFadeIn(cached);
      cached.currentMotionName = presentation.motionName;
      cached.currentMotionFadeInSeconds = presentationFadeIn;
      if (presentation.expressionName) {
        cached.currentExpressionName = presentation.expressionName;
        cached.currentExpressionFadeInSeconds = presentationFadeIn;
        cached.activeExpressionName = presentation.expressionName;
        cached.activeExpressionFadeInSeconds = presentationFadeIn;
      }
      this.invokeCharacterModel(cached, "show cached controller", undefined, (model) => {
        model.setPaused(false);
        model.setMotionSpeed(this.playbackSpeedRate);
        if (presentation.motionName) model.playMotion(presentation.motionName, presentationFadeIn);
        if (presentation.expressionName) model.playExpression(presentation.expressionName, presentationFadeIn);
      });
      cached.alpha = duration > 0 ? 0 : 1;
      registerCharacterItem(this.characterItems, target, cached, () => this.layoutCharacter(cached));
      this.layoutCharacter(cached);
      this.characterControllerIdentities.set(target, identity);
      this.scene.updateMatrixWorld(true);
      cached.node.getWorldPosition(this.renderWorldPosition);
      const authoredRenderOrder = Number(cmd.characterRenderOrder);
      cached.sortingOrder = Number.isFinite(authoredRenderOrder)
        ? authoredRenderOrder
        : threeVector3ToUnity(this.renderWorldPosition, this.renderUnityPosition).z;
      const layoutMove = transitionTo
        ? this.moveCharacterToWorld(target, transitionTo, cached.positionType, duration, 6)
        : Promise.resolve();
      if (duration > 0) await Promise.all([this.fadeCharacterLifecycle(cached, 0, 1, duration), layoutMove]);
      else await layoutMove;
      return;
    }
    if (pendingPlacement) void this.markPendingCharacterFadeInStarted(target, pendingPlacement);
    const item = await this.createCharacter(cmd, target, Number(positionType) || 5, token);
    if (!item) {
      if (this.isCharacterLoadCurrent(target, token)) {
        this.pendingCharacterCommands.invalidate(target);
        this.pendingCharacterPlacements.delete(target);
        this.pendingCharacterWorldPositions.delete(target);
        this.cancelPendingCharacterLoadController(target, token.target);
      }
      return;
    }
    if (!this.isCharacterLoadCurrent(target, token)) {
      this.releaseStagedCharacter(target, item);
      return;
    }
    let registered = false;
    try {
      registered = await this.prepareAndRegisterInitialCharacterPresentation(item, target, token, duration);
    } catch (error) {
      if (this.characterItems.get(target) === item) this.characterItems.delete(target);
      this.releaseStagedCharacter(target, item);
      item.angleTweenController?.abort();
      item.lookTweenController?.abort();
      item.node.removeFromParent();
      if (this.isCharacterLoadCurrent(target, token)) {
        this.pendingCharacterCommands.invalidate(target);
        this.pendingCharacterPlacements.delete(target);
        this.pendingCharacterWorldPositions.delete(target);
      }
      throw error;
    }
    if (!registered) {
      this.releaseStagedCharacter(target, item);
      if (this.isCharacterLoadCurrent(target, token)) {
        this.pendingCharacterCommands.invalidate(target);
        this.pendingCharacterPlacements.delete(target);
        this.pendingCharacterWorldPositions.delete(target);
      }
      return;
    }
    // Registration happened atomically with pending-state consumption below.
    // A later command may already have removed/replaced the item while this
    // outer async continuation was waiting to resume.
    if (!this.isCharacterLoadCurrent(target, token) || this.characterItems.get(target) !== item) return;
    // AdvFieldRenderPass.RegisterCharacterEntry stores the controller's Unity
    // world-position z once, then OrderByDescending uses that value before the
    // position-priority tie breaker.
    this.scene.updateMatrixWorld(true);
    item.node.getWorldPosition(this.renderWorldPosition);
    const authoredRenderOrder = Number(cmd.characterRenderOrder);
    item.sortingOrder = Number.isFinite(authoredRenderOrder)
      ? authoredRenderOrder
      : threeVector3ToUnity(this.renderWorldPosition, this.renderUnityPosition).z;
    const pendingWorld = this.pendingCharacterWorldPositions.get(target);
    if (pendingWorld?.token === token.target) this.pendingCharacterWorldPositions.delete(target);
    const layoutMove =
      pendingWorld?.token === token.target
        ? this.moveCharacterToWorld(target, pendingWorld.position, pendingWorld.positionType, 0, 6)
        : transitionTo
          ? this.moveCharacterToWorld(target, transitionTo, item.positionType, duration, 6)
          : Promise.resolve();
    const pendingAlphaOwnsFade = this.characterAlphaOperations.get(target) !== alphaOperationAtStart;
    if (duration > 0 && !pendingAlphaOwnsFade) {
      // A newer Out/replacement owns cleanup after it cancels this position's
      // fade. The obsolete In continuation must never release mid-fade.
      const fadeStartedAt = pendingPlacement?.fadeInStartedAtSeconds;
      const elapsed = fadeStartedAt == null ? 0 : Math.max(0, this.monotonicSeconds() - fadeStartedAt);
      const startRaw = clamp(elapsed / duration);
      if (startRaw >= 1) item.alpha = 1;
      await Promise.all([
        startRaw >= 1
          ? Promise.resolve(true)
          : this.fadeCharacterLifecycle(item, 0, 1, duration * (1 - startRaw), {
              delayFrames: fadeStartedAt == null ? undefined : 0,
              startRaw,
            }),
        layoutMove,
      ]);
    } else {
      await layoutMove;
    }
  }

  /**
   * Registration and pending-state consumption intentionally share one
   * synchronous segment. A following Talk can therefore always find either
   * the in-flight pending slot or the registered character; there is no
   * promise-continuation gap in which the first lip-sync can be dropped.
   */
  private primeCharacterPresentation(item: StoryCharacter, pending: PendingCharacterPresentation): void {
    // Unity's character and its animation assets already exist when ADV Show
    // runs; Show selects the supplied name or the default once per channel
    // (Live2DCharacterController.Show). The browser model may still be
    // loading, so issuing both default and pending requests would create an
    // artificial race in which a late default can overwrite authored state.
    const { motionName, expressionName, activeMotionName, activeExpressionName, hasPausedMotion, hasPausedExpression } =
      this.resolveCharacterPresentationChannels(item, pending);
    const defaultFadeInSeconds = this.defaultCharacterPresentationFadeIn(item);
    const defaultMotionName = firstString(
      item.entry.profile?.defaultMotionName,
      record(item.entry.runtime).defaultMotionName,
    );
    if (
      item.entry.profile?.playDefaultMotionBeforePresentation &&
      defaultMotionName &&
      activeMotionName &&
      activeMotionName !== defaultMotionName
    ) {
      this.invokeCharacterModel(item, "prime default motion", false, (model) =>
        model.playMotion(defaultMotionName, defaultFadeInSeconds),
      );
    }
    // AdvCharacterHelper.Show defaults its fadeIn argument to 0. A pending
    // command carries the command's explicit value (including -1); otherwise
    // the default Show motion/expression must also be applied immediately.
    if (activeMotionName) {
      const fadeInSeconds = hasPausedMotion
        ? (pending.activeMotion?.fadeInSeconds ?? defaultFadeInSeconds)
        : (pending.motion?.fadeInSeconds ?? defaultFadeInSeconds);
      item.currentMotionName = activeMotionName;
      item.currentMotionFadeInSeconds = fadeInSeconds;
      this.invokeCharacterModel(item, "play initial motion", false, (model) =>
        model.playMotion(activeMotionName, fadeInSeconds),
      );
    }
    if (hasPausedMotion && motionName && pending.motion) {
      item.pendingPausedMotion = { name: motionName, fadeInSeconds: pending.motion.fadeInSeconds };
    }
    if (activeExpressionName) {
      const fadeInSeconds = hasPausedExpression
        ? (pending.activeExpression?.fadeInSeconds ?? defaultFadeInSeconds)
        : (pending.expression?.fadeInSeconds ?? defaultFadeInSeconds);
      item.activeExpressionName = activeExpressionName;
      item.activeExpressionFadeInSeconds = fadeInSeconds;
      this.invokeCharacterModel(item, "play initial expression", false, (model) =>
        model.playExpression(activeExpressionName, fadeInSeconds),
      );
    }
    item.currentExpressionName = firstString(pending.currentExpressionName, expressionName);
    item.currentExpressionFadeInSeconds = pending.currentExpressionFadeInSeconds;
    if (hasPausedExpression && expressionName && pending.expression) {
      item.pendingPausedExpression = { name: expressionName, fadeInSeconds: pending.expression.fadeInSeconds };
    }
    if (pending?.lipSync) {
      this.restorePendingLipSync(item, pending.lipSync, pending.pauseEvents || []);
      this.updateLipSync(item, 0);
    }
    if (pending.angleOverridePrepared) item.angleOverride = true;
    if (pending.angleEvents?.length) this.restorePendingAngle(item, pending.angleEvents);
    if (pending.brightnessEvents?.length) this.restorePendingBrightness(item, pending.brightnessEvents);
    if (pending.alphaEvents?.length) this.restorePendingAlpha(item, pending.alphaEvents);
    if (pending.rimLightEvents?.length) this.restorePendingRimLight(item, pending.rimLightEvents);
    if (pending.dofEvents?.length) this.restorePendingDoF(item, pending.dofEvents);
    if (pending.paused != null) {
      item.paused = pending.paused;
      this.invokeCharacterModel(item, "apply initial pause state", undefined, (model) => model.setPaused(item.paused));
    }
    this.invokeCharacterModel(item, "prime initial frame", undefined, (model) =>
      model.primeInitialFrame(this.characterParameterFrame(item)),
    );
    if (pending.lookEvents?.length) {
      this.restorePendingLook(item, pending.lookEvents, Boolean(pending.lookOverridePrepared));
    } else if (pending.lookOverridePrepared) this.enableLookOverride(item);
  }

  private resolveInitialCharacterPresentation(
    item: StoryCharacter,
    pending: PendingCharacterPresentation | null,
  ): { motionName: string; expressionName: string } {
    return {
      motionName: firstString(
        pending?.motion?.name,
        item.entry.profile?.defaultMotionName,
        record(item.entry.runtime).defaultMotionName,
      ),
      expressionName: firstString(
        pending?.expression?.name,
        item.entry.profile?.defaultExpressionName,
        record(item.entry.runtime).defaultExpressionName,
      ),
    };
  }

  private defaultCharacterPresentationFadeIn(item: StoryCharacter): number {
    return finite(
      item.entry.profile?.presentationFadeInSeconds,
      finite(record(item.entry.runtime).presentationFadeInSeconds, 0),
    );
  }

  private resolveCharacterPresentationChannels(item: StoryCharacter, pending: PendingCharacterPresentation) {
    const { motionName, expressionName } = this.resolveInitialCharacterPresentation(item, pending);
    const defaultMotionName = firstString(
      item.entry.profile?.defaultMotionName,
      record(item.entry.runtime).defaultMotionName,
    );
    const defaultExpressionName = firstString(
      item.entry.profile?.defaultExpressionName,
      record(item.entry.runtime).defaultExpressionName,
    );
    const hasPausedMotion = Boolean(pending.paused && pending.motionQueuedWhilePaused && pending.motion);
    const hasPausedExpression = Boolean(pending.paused && pending.expressionQueuedWhilePaused && pending.expression);
    return {
      motionName,
      expressionName,
      activeMotionName: hasPausedMotion ? firstString(pending.activeMotion?.name, defaultMotionName) : motionName,
      activeExpressionName: hasPausedExpression
        ? firstString(pending.activeExpression?.name, defaultExpressionName)
        : expressionName,
      hasPausedMotion,
      hasPausedExpression,
    };
  }

  /**
   * Unity loads Live2D animation assets before Show and applies Show's selected
   * motion/expression before enabling the renderer. Browser resource fetches are
   * asynchronous, so keep the item outside characterItems until the latest
   * pending pair has been parsed. A command arriving during an await replaces
   * the single pending slot; the loop then prepares that newer pair instead.
   */
  private async prepareAndRegisterInitialCharacterPresentation(
    item: StoryCharacter,
    target: string,
    token: { scene: number; target: number; signal: AbortSignal },
    duration: number,
  ): Promise<boolean> {
    while (this.isCharacterLoadCurrent(target, token)) {
      if (!(await this.waitForRenderableContext(token.signal))) return false;
      const contextGeneration = this.contextRestoreGeneration;
      // A staged controller is part of context restoration. If its first rebuild
      // failed, the supervised single-flight recovery owns the model until it
      // installs a replacement; do not consume pending Motion/Expression early.
      while (
        this.isCharacterLoadCurrent(target, token) &&
        this.isRenderableContextGenerationCurrent(contextGeneration) &&
        this.characterModelRecoveryStates.has(item)
      ) {
        await nextFrame();
      }
      if (!this.isCharacterLoadCurrent(target, token)) return false;
      if (!this.isRenderableContextGenerationCurrent(contextGeneration)) continue;
      const before = this.pendingCharacterCommands.peek(target, token.target);
      if (!before) return false;
      const names = this.resolveCharacterPresentationChannels(item, before);
      const resourceChange = this.pendingCharacterCommands.observeResourceChange(target, token.target);
      if (!resourceChange) return false;
      const defaultMotionName = item.entry.profile?.playDefaultMotionBeforePresentation
        ? firstString(item.entry.profile?.defaultMotionName, record(item.entry.runtime).defaultMotionName)
        : "";
      const motionNames = [...new Set([defaultMotionName, names.motionName, names.activeMotionName].filter(Boolean))];
      const expressionNames = [...new Set([names.expressionName, names.activeExpressionName].filter(Boolean))];
      const prepared = Promise.all([
        Promise.all(
          motionNames.map((name) =>
            this.invokeCharacterModelTask(item, `prepare motion ${name}`, false, (model) => model.prepareMotion(name)),
          ),
        ),
        Promise.all(
          expressionNames.map((name) =>
            this.invokeCharacterModelTask(item, `prepare expression ${name}`, false, (model) =>
              model.prepareExpression(name),
            ),
          ),
        ),
      ]).then(() => ({ kind: "prepared" as const }));
      const outcome = await Promise.race([prepared, resourceChange.changed.then(() => ({ kind: "changed" as const }))]);
      if (!this.isRenderableContextGenerationCurrent(contextGeneration)) continue;
      if (outcome.kind === "changed") continue;
      if (!this.isCharacterLoadCurrent(target, token)) return false;
      const after = this.pendingCharacterCommands.peek(target, token.target);
      if (!after) return false;
      const currentNames = this.resolveCharacterPresentationChannels(item, after);
      if (
        currentNames.motionName === names.motionName &&
        currentNames.expressionName === names.expressionName &&
        currentNames.activeMotionName === names.activeMotionName &&
        currentNames.activeExpressionName === names.activeExpressionName &&
        currentNames.hasPausedMotion === names.hasPausedMotion &&
        currentNames.hasPausedExpression === names.hasPausedExpression
      ) {
        // Live2DCharacter.PlayMotion/PlayExpression use TryGetValue and simply
        // return when an authored key is absent. In particular, Mujica 1 has
        // `mtn_surprise01_R` while Mutsumi's bundle contains
        // `mtn_surprised01_R`; that typo must not turn CharacterIn into a
        // failed model load. Preparation still eagerly parses every available
        // channel, while playMotion/playExpression below preserve the native
        // non-fatal lookup semantics for missing entries.
        // No await is allowed from this final validation through registration.
        // ADV can keep dispatching no-wait commands while assets load; keeping
        // this segment synchronous prevents both an unprepared late override
        // and a consume-before-register command-loss window.
        const pending = this.pendingCharacterCommands.consume(target, token.target);
        if (!pending) return false;
        item.alpha = duration > 0 ? 0 : 1;
        item.blurIntensity =
          item.positionType === this.cameraState.focusPositionType ? 0 : this.fieldRendererState.characterBlur;
        this.primeCharacterPresentation(item, pending);
        return this.commitStagedCharacter(target, token.target, item);
      }
    }
    return false;
  }

  async removeCharacter(target: string, duration = 0): Promise<boolean> {
    const wasPending = this.pendingCharacterPlacements.has(target) || this.stagedCharacterItems.has(target);
    this.invalidateCharacterLoad(target);
    this.characterPresentationHistory.delete(target);
    const item = this.characterItems.get(target);
    if (!item) {
      this.cancelCharacterOwnedTweens(target);
      return wasPending;
    }
    const owns = await this.fadeCharacterLifecycle(item, item.alpha, 0, duration);
    if (!owns || this.characterItems.get(target) !== item) return false;
    // AdvOut keeps Angle/Look running through FadeOutCharacterAsync. Hide then
    // unregisters only the renderer entry; the loader's controller survives.
    this.cancelCharacterOwnedTweens(target);
    // Live2DCharacter.Hide normally performs ClearPauseState followed by
    // ResetExpressionParametersToDefault/FlushExpressionResetToDrawableState.
    // Some source viewers retain the controller's presentation across Hide;
    // keep that provider-specific state on the cached controller.
    const preservePresentation = item.entry.profile?.preservePresentationOnHide === true;
    item.paused = false;
    item.pendingPausedMotion = null;
    item.pendingPausedExpression = null;
    if (!preservePresentation) {
      item.activeExpressionName = "";
      item.activeExpressionFadeInSeconds = undefined;
    }
    this.invokeCharacterModel(item, "hide controller", undefined, (model) => {
      model.setPaused(false);
      if (!preservePresentation) model.resetExpressionParametersToDefault();
    });
    this.characterItems.delete(target);
    // Hide/Unregister does not evict the loader's TargetName+Asset controller.
    // Keep its transform, model, angle/look state and queued motion alive while
    // excluding it from the manually rendered showing map.
    return true;
  }

  async fadeCharacter(target: string, alpha: number, duration = 0): Promise<void> {
    const targetAlpha = clamp(alpha);
    const seconds = Math.max(0, finite(duration));
    const operationId = ++this.characterAlphaOperationSequence;
    this.characterAlphaOperations.set(target, operationId);
    const item = this.cachedCharacterController(target);
    if (item) {
      await this.fadeCharacterLifecycle(item, item.alpha, targetAlpha, seconds);
      return;
    }

    const token = this.selectedPendingCharacterToken(target);
    const queuedAtSeconds = this.monotonicSeconds();
    if (
      token == null ||
      !this.pendingCharacterCommands.queueAlpha(
        target,
        token,
        {
          operationId,
          value: targetAlpha,
          durationSeconds: seconds,
          queuedAtSeconds,
          startedAtSeconds: null,
        },
        this.pendingCharacterFadeInAlpha(target, token, queuedAtSeconds),
      )
    ) {
      return;
    }

    // FadeCharacterAsync captures and writes the current alpha, then waits
    // three Update frames before constructing its DOTween. Native always has a
    // preloaded controller; this gate lets a browser controller that resolves
    // during those frames enter the same phase without delaying it twice.
    for (let frame = 0; frame < UNITY_CHARACTER_FADE_DELAY_FRAMES; frame += 1) await nextFrame();
    if (this.characterAlphaOperations.get(target) !== operationId) return;
    const loaded = this.cachedCharacterController(target);
    if (loaded) {
      await this.fadeCharacterLifecycle(loaded, loaded.alpha, targetAlpha, seconds, {
        delayFrames: 0,
      });
      return;
    }
    if (!this.pendingCharacterCommands.markAlphaStarted(target, token, operationId, this.monotonicSeconds())) return;
    await this.runTween({ duration: seconds });
  }

  private async fadeCharacterLifecycle(
    item: StoryCharacter,
    from: number,
    to: number,
    duration: number,
    resumed: { readonly delayFrames?: number; readonly startRaw?: number } = {},
  ): Promise<boolean> {
    return this.characterFadeCoordinator.fade(item.positionType, {
      from,
      to,
      duration,
      delayFrames: resumed.delayFrames,
      startRaw: resumed.startRaw,
      setAlpha: (alpha) => {
        item.alpha = alpha;
      },
      waitFrame: nextFrame,
      tween: (seconds, update) => this.runTween({ duration: seconds, update }),
    });
  }

  clearCharacters(): void {
    this.cancelAllCharacterModelRecoveries();
    this.cancelAllCharacterOwnedTweens();
    this.characterLoadTokens.clear();
    this.characterAlphaOperations.clear();
    for (const pending of this.pendingCharacterLoadControllers.values()) {
      pending.detach();
      pending.controller.abort();
    }
    this.pendingCharacterLoadControllers.clear();
    this.pendingCharacterCommands.clear();
    this.pendingCharacterPlacements.clear();
    this.pendingCharacterWorldPositions.clear();
    for (const controller of this.pendingAngleWaitControllers.values()) controller.abort();
    this.pendingAngleWaitControllers.clear();
    for (const controller of this.pendingLookWaitControllers.values()) controller.abort();
    this.pendingLookWaitControllers.clear();
    this.characterPresentationHistory.clear();
    for (const target of [...this.stagedCharacterItems.keys()]) this.releaseStagedCharacter(target);
    const controllers = new Set<StoryCharacter>([
      ...this.cachedCharacterControllers.values(),
      ...this.characterItems.values(),
    ]);
    for (const item of controllers) {
      item.angleTweenController?.abort();
      item.lookTweenController?.abort();
      this.characterFadeCoordinator.cancel(item.positionType);
      item.node.removeFromParent();
      this.releaseCharacterModelSafely(item, "scene character clear");
    }
    this.characterItems.clear();
    this.cachedCharacterControllers.clear();
    this.characterControllerIdentities.clear();
    this.sortedCharacterItems.length = 0;
    for (const group of this.characterRenderGroupPool) group.items.length = 0;
  }

  playMotionForTarget(target: string, motionName = "", motionFadeIn = -1, expectedIdentity?: string): void {
    const item = expectedIdentity
      ? this.cachedCharacterControllers.get(expectedIdentity)
      : this.cachedCharacterController(target);
    const placement = this.pendingCharacterPlacements.get(target);
    if (item) {
      // Live2DCharacter.PlayMotion checks the loaded _motionDataMap before it
      // mutates either the active player or the paused pending slot. Keep a
      // missing key out of snapshot history as well, so seek restores the last
      // motion that actually became active instead of falling back to idle.
      const hasMotion = this.invokeCharacterModel(
        item,
        `query motion ${motionName}`,
        this.hasCharacterPresentationResource(item.entry, "motions", motionName),
        (model) => model.hasMotion(motionName),
      );
      if (!hasMotion) return;
      if (item.paused) {
        this.recordCharacterPresentation(target, { kind: "motion", name: motionName });
        // Live2DCharacter keeps one pending motion slot while paused; the
        // latest command replaces the earlier request and plays on Resume.
        item.pendingPausedMotion = { name: motionName, fadeInSeconds: motionFadeIn };
        return;
      }
      this.recordCharacterPresentation(target, { kind: "motion", name: motionName });
      item.currentMotionName = motionName;
      item.currentMotionFadeInSeconds = motionFadeIn;
      this.invokeCharacterModel(item, `play motion ${motionName}`, false, (model) =>
        model.playMotion(motionName, motionFadeIn),
      );
      return;
    }
    // Before browser CharacterIn has produced a controller, use the prepared
    // data map to preserve the default/previous pending motion on a missing
    // authored key. This is the asynchronous equivalent of native TryGetValue.
    if (!this.hasCharacterPresentationResource(placement?.entry, "motions", motionName)) return;
    this.recordCharacterPresentation(target, { kind: "motion", name: motionName });
    const token = this.selectedPendingCharacterToken(target);
    const pendingIdentity = placement?.identity;
    if (token != null && (!expectedIdentity || pendingIdentity === expectedIdentity)) {
      this.pendingCharacterCommands.queueMotion(target, token, { name: motionName, fadeInSeconds: motionFadeIn });
    }
  }

  playExpressionForTarget(
    target: string,
    expressionName = "",
    fadeInSeconds?: number,
    expectedIdentity?: string,
  ): void {
    const item = expectedIdentity
      ? this.cachedCharacterControllers.get(expectedIdentity)
      : this.cachedCharacterController(target);
    const placement = this.pendingCharacterPlacements.get(target);
    const entry = item?.entry || placement?.entry;
    const resolvedName = firstString(
      expressionName,
      entry?.profile?.defaultExpressionName,
      record(entry?.runtime).defaultExpressionName,
    );
    if (!item) {
      if (!this.hasCharacterPresentationResource(entry, "expressions", resolvedName)) return;
      this.recordCharacterPresentation(target, { kind: "expression", name: resolvedName });
      const token = this.selectedPendingCharacterToken(target);
      const pendingIdentity = placement?.identity;
      if (token != null && (!expectedIdentity || pendingIdentity === expectedIdentity)) {
        this.pendingCharacterCommands.queueExpression(target, token, { name: resolvedName, fadeInSeconds });
      }
      return;
    }
    // The controller records CurrentExpressionName/fade before delegating to
    // Live2DCharacter; a missing underlying expression therefore still
    // changes duplicate-request bookkeeping even though the model map lookup
    // itself is a no-op.
    this.recordCharacterPresentation(target, { kind: "expression", name: resolvedName });
    // Live2DCharacterController only refreshes its fade field when the same
    // expression is requested again; it neither restarts the expression nor
    // fills the single Pause pending slot.
    if (this.characterItems.get(target) === item && item.currentExpressionName === resolvedName) {
      item.currentExpressionFadeInSeconds = fadeInSeconds;
      if (!item.paused && item.activeExpressionName === resolvedName) {
        item.activeExpressionFadeInSeconds = fadeInSeconds;
      }
      this.invokeCharacterModel(item, `refresh expression ${resolvedName}`, undefined, (model) =>
        model.refreshCurrentExpressionFadeIn(resolvedName, fadeInSeconds),
      );
      return;
    }
    item.currentExpressionName = resolvedName;
    item.currentExpressionFadeInSeconds = fadeInSeconds;
    if (item.paused) {
      // Controller-side name/fade fields are already updated above, but the
      // underlying Live2DCharacter returns on a failed data-map lookup before
      // assigning its paused pending expression.
      if (!this.hasCharacterPresentationResource(item.entry, "expressions", resolvedName)) return;
      item.pendingPausedExpression = { name: resolvedName, fadeInSeconds };
      return;
    }
    item.activeExpressionName = resolvedName;
    item.activeExpressionFadeInSeconds = fadeInSeconds;
    this.invokeCharacterModel(item, `play expression ${resolvedName}`, false, (model) =>
      model.playExpression(resolvedName, fadeInSeconds),
    );
  }

  setCharacterForward(positionType: number): void {
    const index = this.characterStageIndex(positionType);
    if (index < 0) return;
    // Native mutates the current render-pass priority list (Remove + Add), so
    // successive Forward/Back commands must preserve earlier rearrangements.
    this.characterPriorityOrder = this.characterPriorityOrder.filter((value) => value !== index);
    this.characterPriorityOrder.push(index);
  }

  setCharacterBack(positionType: number): void {
    const index = this.characterStageIndex(positionType);
    if (index < 0) return;
    this.characterPriorityOrder = [index, ...this.characterPriorityOrder.filter((value) => value !== index)];
  }

  sortCharacters(): void {
    this.characterPriorityOrder = [4, 0, 3, 1, 2];
    this.applyTransforms();
    this.scene.updateMatrixWorld(true);
    for (const item of this.characterItems.values()) {
      item.node.getWorldPosition(this.renderWorldPosition);
      item.sortingOrder = threeVector3ToUnity(this.renderWorldPosition, this.renderUnityPosition).z;
    }
  }

  setCharacterPaused(target: string, paused: boolean): void {
    const item = this.cachedCharacterController(target);
    if (item) {
      item.paused = paused;
      let motion: { name: string; fadeInSeconds?: number } | null = null;
      let expression: { name: string; fadeInSeconds?: number } | null = null;
      if (!paused) {
        motion = item.pendingPausedMotion;
        expression = item.pendingPausedExpression;
        item.pendingPausedMotion = null;
        item.pendingPausedExpression = null;
        if (motion) {
          item.currentMotionName = motion.name;
          item.currentMotionFadeInSeconds = motion.fadeInSeconds;
        }
        if (expression) {
          item.activeExpressionName = expression.name;
          item.activeExpressionFadeInSeconds = expression.fadeInSeconds;
        }
      }
      this.invokeCharacterModel(item, paused ? "pause" : "resume", undefined, (model) => {
        model.setPaused(paused);
        if (motion) model.playMotion(motion.name, motion.fadeInSeconds);
        if (expression) model.playExpression(expression.name, expression.fadeInSeconds);
      });
      return;
    }
    const token = this.selectedPendingCharacterToken(target);
    if (token != null) {
      this.pendingCharacterCommands.queuePaused(target, token, paused, this.monotonicSeconds());
    }
  }

  /** Native showing controllers, including Web-only asynchronous In staging. */
  showingCharacterTargets(): string[] {
    const targets = new Set(this.characterItems.keys());
    for (const [target, pending] of this.pendingCharacterPlacements) {
      if (this.characterLoadTokens.get(target) === pending.token) targets.add(target);
    }
    return [...targets];
  }

  characterMotionIdentity(target: string): string | null {
    const pending = this.pendingCharacterPlacements.get(target);
    const identity = this.characterControllerIdentities.get(target);
    if (pending && identity === pending.identity && this.characterLoadTokens.get(target) === pending.token) {
      return identity;
    }
    if (identity && this.cachedCharacterControllers.has(identity)) return identity;
    return null;
  }

  /** Browser equivalent of AdvEpisodeResourceLoader.TryGetCharacterController. */
  hasCharacterController(target: string): boolean {
    const identity = this.characterControllerIdentities.get(target);
    const pending = this.pendingCharacterPlacements.get(target);
    return Boolean(
      this.cachedCharacterController(target) ||
      (identity && pending?.identity === identity && this.characterLoadTokens.get(target) === pending.token),
    );
  }

  isCharacterShowing(target: string, expectedIdentity?: string): boolean {
    const identity = this.characterMotionIdentity(target);
    const pending = this.pendingCharacterPlacements.get(target);
    const pendingShowing = Boolean(
      pending &&
      identity === pending.identity &&
      this.characterLoadTokens.get(target) === pending.token &&
      (!expectedIdentity || pending.identity === expectedIdentity),
    );
    const selectedController = identity ? this.cachedCharacterControllers.get(identity) : null;
    return Boolean(
      pendingShowing ||
      (selectedController &&
        this.characterItems.get(target) === selectedController &&
        (!expectedIdentity || identity === expectedIdentity)),
    );
  }

  /** AdvLocalDataHandler.ReapplyPlaybackSpeed -> Live2D character controllers. */
  setPlaybackSpeed(rate: number): void {
    const next = Math.max(0.001, finite(rate, 1));
    if (Math.abs(next - this.playbackSpeedRate) > 0.000001) {
      this.playbackSpeedEvents.push({ rate: next, queuedAtSeconds: this.monotonicSeconds() });
    }
    this.playbackSpeedRate = next;
    const controllers = new Set<StoryCharacter>(this.cachedCharacterControllers.values());
    for (const { item } of this.stagedCharacterItems.values()) controllers.add(item);
    for (const item of controllers) {
      this.invokeCharacterModel(item, "set playback speed", undefined, (model) =>
        model.setMotionSpeed(this.playbackSpeedRate),
      );
    }
  }

  async setBackground(
    background: AdvBackgroundEntry | null | undefined,
    _transitionDuration = 0,
    stageCaptureOwner?: number,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const ownsCapture = (): boolean =>
      !signal?.aborted && (stageCaptureOwner == null || stageCaptureOwner === this.stageCaptureGeneration);
    if (!ownsCapture()) return false;
    const epoch = ++this.frameEpoch;
    const url = firstString(background?.url);
    if (!url) {
      this.backgroundMesh?.removeFromParent();
      this.backgroundMesh?.material.dispose();
      this.backgroundMesh = null;
      this.backgroundCaptureMesh?.removeFromParent();
      this.backgroundCaptureMesh?.material.dispose();
      this.backgroundCaptureMesh = null;
      this.backgroundTextureLease?.release();
      this.backgroundTextureLease = null;
      const hasStage = background?.stage != null;
      this.backgroundField.visible = hasStage;
      this.backgroundCaptureField.visible = hasStage;
      if (hasStage) this.applyStage(background.stage, 0, true);
      this.state.background = hasStage ? background : null;
      return true;
    }
    const textureLease = await this.acquireTexture(url);
    if (epoch !== this.frameEpoch || this.destroyed || !ownsCapture()) {
      textureLease.release();
      return false;
    }
    const texture = textureLease.value;
    const material = new MeshBasicMaterial({
      map: texture,
      color: 0xffffff,
      transparent: true,
      opacity: 1,
      depthTest: true,
      depthWrite: false,
      side: DoubleSide,
      toneMapped: false,
    });
    const next = new Mesh(this.backgroundGeometry, material);
    next.name = "AdvBackgroundSprite";
    const nextCapture = new Mesh(this.backgroundGeometry, material.clone());
    nextCapture.name = "AdvBackgroundCaptureSprite";
    const stage = record(background?.stage);
    const sprite = record(stage.backgroundSprite);
    const size = record(stage.backgroundSize || sprite.worldSize || this.runtime.stage.backgroundSize);
    const fieldScale = finite(stage.backgroundFieldScale, finite(record(this.runtime.stage).backgroundFieldScale, 1));
    const fit = String(stage.backgroundFit || this.runtime.stage.backgroundFit || "authored");
    let width = finite(size.width, this.runtime.stage.backgroundSize.width);
    let height = finite(size.height, this.runtime.stage.backgroundSize.height);
    let appliedFieldScale = fieldScale;
    if (fit === "camera-width") {
      const cameraPosition = vec3(stage.initialCameraPosition ?? this.runtime.stage.initialCameraPosition, ZERO_VEC3);
      const backgroundPosition = vec3(
        stage.backgroundFieldPosition ?? this.runtime.stage.backgroundFieldPosition,
        BACKGROUND_FIELD_POSITION,
      );
      const depth = Math.max(0.001, backgroundPosition.z - cameraPosition.z);
      const fov = Math.max(1, finite(stage.fov, finite(this.runtime.stage.fov, 39.6)));
      const visibleWidth = 2 * depth * Math.tan((fov * Math.PI) / 360) * Math.max(0.001, this.camera.aspect);
      width =
        visibleWidth * Math.max(1, finite(stage.backgroundOverscan, finite(this.runtime.stage.backgroundOverscan, 1)));
      height = width / textureAspect(texture, this.camera.aspect);
      // Camera-fit dimensions are already world units. Field scale remains an
      // authored-stage concern and must not be multiplied in a second time.
      appliedFieldScale = 1;
    }
    const pivot = record(sprite.pivot);
    const scaledWidth = width * appliedFieldScale;
    const scaledHeight = height * appliedFieldScale;
    next.scale.set(scaledWidth, scaledHeight, appliedFieldScale);
    // Unity Sprite vertices are relative to the serialized pivot. Current
    // reference sprites are centered, but retaining this offset makes future
    // non-centred sprites use the same local geometry without a processor-specific case.
    next.position.set((0.5 - finite(pivot.x, 0.5)) * scaledWidth, (0.5 - finite(pivot.y, 0.5)) * scaledHeight, 0);
    nextCapture.scale.copy(next.scale);
    nextCapture.position.copy(next.position);
    const previous = this.backgroundMesh;
    const previousCapture = this.backgroundCaptureMesh;
    const previousTextureLease = this.backgroundTextureLease;
    this.backgroundMesh = next;
    this.backgroundCaptureMesh = nextCapture;
    this.backgroundTextureLease = textureLease;
    this.backgroundField.add(next);
    this.backgroundCaptureField.add(nextCapture);
    this.backgroundField.visible = true;
    this.backgroundCaptureField.visible = true;
    this.applyStage(stage, 0, true);
    this.state.background = background;
    if (previous && previous !== next) {
      previousCapture?.removeFromParent();
      previous.removeFromParent();
      previous.material.dispose();
      previousCapture?.material.dispose();
    }
    previousTextureLease?.release();
    return true;
  }

  captureStage(signal?: AbortSignal): Promise<number | null> {
    if (this.destroyed || !this.pipeline || signal?.aborted) return Promise.resolve(null);
    this.cancelPendingStageCapture(false);
    const generation = ++this.stageCaptureGeneration;
    return new Promise<number | null>((resolve) => {
      const onAbort = (): void => {
        if (this.pendingStageCapture?.generation !== generation) return;
        this.cancelPendingStageCapture(true);
      };
      const resolveCapture = (owner: number | null): void => {
        signal?.removeEventListener("abort", onAbort);
        resolve(owner);
      };
      this.pendingStageCapture = { generation, resolve: resolveCapture };
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  async fadeStageCapture(duration: number, owner: number, signal?: AbortSignal): Promise<boolean> {
    if (owner !== this.stageCaptureGeneration) return false;
    const from = this.stageCaptureAlpha;
    await this.runTween({
      duration,
      signal,
      ease: resolveEase(6),
      update: (progress) => {
        if (owner === this.stageCaptureGeneration) this.stageCaptureAlpha = lerp(from, 0, progress);
      },
    });
    if (owner !== this.stageCaptureGeneration) return false;
    if (signal?.aborted) return false;
    this.resetStageCapture(owner);
    return true;
  }

  private cancelPendingStageCapture(clearComposite: boolean): void {
    const pending = this.pendingStageCapture;
    if (pending) {
      this.pendingStageCapture = null;
      this.stageCaptureGeneration += 1;
      pending.resolve(null);
    }
    if (clearComposite) this.stageCaptureAlpha = 0;
  }

  resetStageCapture(owner?: number): void {
    if (owner != null && owner !== this.stageCaptureGeneration) return;
    this.stageCaptureGeneration += 1;
    this.stageCaptureAlpha = 0;
    this.pendingStageCapture?.resolve(null);
    this.pendingStageCapture = null;
  }

  private applyStage(stageValue: unknown, focusGroupIndex = 0, reset = true): void {
    const stage = record(stageValue);
    this.state.stage = stageValue || null;
    const stageUpdate = { ...this.runtime.stage } as AdvRuntimeConfig["stage"] & UnknownRecord;
    for (const key of [
      "initialCameraPosition",
      "initialCameraRotation",
      "characterFieldPosition",
      "backgroundFieldPosition",
      "characterFieldScale",
      "backgroundFieldScale",
      "characterPixelsPerUnit",
      "characterCanvasWorldHeight",
      "backgroundFit",
      "backgroundOverscan",
      "fov",
    ]) {
      if (stage[key] != null) stageUpdate[key] = stage[key];
    }
    const backgroundSprite = record(stage.backgroundSprite);
    if (stage.backgroundSize || backgroundSprite.worldSize) {
      stageUpdate.backgroundSize = (stage.backgroundSize || backgroundSprite.worldSize) as {
        width: number;
        height: number;
      };
    }
    const groups = Array.isArray(stage.focusPointGroups) ? stage.focusPointGroups : [];
    const points = (groups[Math.max(0, focusGroupIndex)] || groups[0]) as unknown;
    if (Array.isArray(points) && points.length >= 9) {
      const anchors: Record<number, Vec3> = {};
      for (let pointIndex = 0; pointIndex < 9; pointIndex += 1) {
        anchors[pointIndex + 1] = vec3(points[pointIndex], { x: 0, y: 0, z: 0 });
      }
      stageUpdate.focusAnchors = anchors;
      stageUpdate.positions = { 1: anchors[1], 3: anchors[3], 5: anchors[5], 7: anchors[7], 9: anchors[9] };
      stageUpdate.minX = Math.min(...Object.values(anchors).map((point) => point.x));
      stageUpdate.maxX = Math.max(...Object.values(anchors).map((point) => point.x));
      stageUpdate.width = stageUpdate.maxX - stageUpdate.minX;
    }
    this.runtime = { ...this.runtime, stage: stageUpdate };
    this.focusDataSettingsKey = String(stage.usingFocusDataSettingsKey || this.focusDataSettingsKey);
    if (!reset) {
      this.applyTransforms();
      return;
    }
    this.stageOffsets.clear();
    const initialPosition = vec3(stage.initialCameraPosition ?? this.runtime.stage.initialCameraPosition, ZERO_VEC3);
    const initialRotation = vec3(stage.initialCameraRotation ?? this.runtime.stage.initialCameraRotation, ZERO_VEC3);
    const positionMagnitude = initialPosition.x ** 2 + initialPosition.y ** 2 + initialPosition.z ** 2;
    const rotationMagnitude = initialRotation.x ** 2 + initialRotation.y ** 2 + initialRotation.z ** 2;
    if (positionMagnitude >= 9.99999944e-11) {
      this.cameraState.baseX = initialPosition.x;
      this.cameraState.baseY = initialPosition.y;
      this.cameraState.baseZ = initialPosition.z;
    } else {
      this.cameraState.baseX = 0;
      this.cameraState.baseY = 0;
      this.cameraState.baseZ = 0;
    }
    if (rotationMagnitude >= 9.99999944e-11) {
      // AdvStage.get_InitialCameraRotation negates X only.
      this.cameraState.rotationX = -initialRotation.x;
      this.cameraState.rotationY = initialRotation.y;
      this.cameraState.angle = initialRotation.z;
    } else {
      this.cameraState.rotationX = 0;
      this.cameraState.rotationY = 0;
      this.cameraState.angle = 0;
    }
    this.cameraState.fieldRotationY = 0;
    this.cameraState.stageRotationY = 0;
    this.cameraState.zoomRatio = 1;
    this.cameraState.panOffsetX = 0;
    this.cameraState.panOffsetY = 0;
    this.cameraState.focusPositionType = 5;
    this.cameraState.focusTargetName = "";
    this.applyStageMultiplyTexture(stage);
    this.applyStageLight(0);
    this.applyStagePostEffect(0);
    this.changeStageParticleEffects(0);
    this.applyTransforms();
  }

  applyStageEnv(index = 0): void {
    const stage = record(this.state.stage);
    const groups = Array.isArray(stage.focusPointGroups) ? stage.focusPointGroups : [];
    const requestedIndex = Math.trunc(finite(index));
    const resolvedIndex =
      requestedIndex >= 0 && requestedIndex < groups.length && groups[requestedIndex] != null ? requestedIndex : 0;
    this.stageOffsets.clear();
    this.applyStage(this.state.stage, resolvedIndex, false);
  }

  private environmentPostEffect(index = 0): UnknownRecord | null {
    const stage = record(this.state.stage);
    const profiles = stage.environmentPostEffects || stage.environmentPosteffects;
    const requestedIndex = Math.trunc(finite(index));
    if (Array.isArray(profiles)) {
      if (requestedIndex < 0 || requestedIndex >= profiles.length) return null;
      const profile = record(profiles[requestedIndex]);
      return Object.keys(profile).length ? profile : null;
    }
    if (requestedIndex !== 0) return null;
    const profile = record(stage.environmentPostEffect);
    return Object.keys(profile).length ? profile : null;
  }

  private environmentLightGroup(index = 0): UnknownRecord | null {
    const stage = record(this.state.stage);
    const groups = stage.environmentLightGroups || stage.environmentLightgroups;
    const requestedIndex = Math.trunc(finite(index));
    if (Array.isArray(groups)) {
      if (requestedIndex < 0 || requestedIndex >= groups.length) return null;
      const group = record(groups[requestedIndex]);
      return Object.keys(group).length ? group : null;
    }
    if (requestedIndex !== 0) return null;
    const group = record(stage.environmentLightGroup);
    return Object.keys(group).length ? group : null;
  }

  applyStageLight(index = 0): void {
    const group = this.environmentLightGroup(index);
    const lights = (Array.isArray(group?.lights) ? group.lights : [])
      .map(record)
      .filter((light) => light.active !== false);
    const directional = lights.find(
      (light) => Number(light.type) === 1 || String(light.typeName || "").toLowerCase() === "directional",
    );
    const lightQuaternion = (value: unknown) => {
      const source = record(value);
      return {
        x: finite(source.x),
        y: finite(source.y),
        z: finite(source.z),
        w: finite(source.w, 1),
      };
    };
    const lightColor = (value: unknown) => {
      const source = record(value);
      return { r: finite(source.r, 1), g: finite(source.g, 1), b: finite(source.b, 1) };
    };
    const main = packUnityUrpDirectionalLight(
      directional
        ? {
            active: true,
            forward: vec3(directional.worldForward, { x: 0, y: 0, z: 1 }),
            rotation: lightQuaternion(directional.worldRotation),
            color: lightColor(directional.color),
            intensity: finite(directional.intensity, 1),
          }
        : null,
    );
    const additional = packUnityUrpAdditionalLights(
      lights
        .filter((light) => light !== directional)
        .map((light): UnityCubismAdditionalLightLike => ({
          active: true,
          type: finite(light.type, -1),
          position: vec3(light.worldPosition, { x: 0, y: 0, z: 0 }),
          forward: vec3(light.worldForward, { x: 0, y: 0, z: 1 }),
          rotation: lightQuaternion(light.worldRotation),
          color: lightColor(light.color),
          intensity: finite(light.intensity, 1),
          range: finite(light.range, 10),
          spotAngle: finite(light.spotAngle, 30),
          innerSpotAngle: Number.isFinite(Number(light.innerSpotAngle)) ? Number(light.innerSpotAngle) : undefined,
        })),
    );
    const enabled = this.qualityConfig.isUnityLightingEnabled() && lights.length > 0;
    this.cubismLightingState = {
      enabled,
      disableForMultiplicativeDrawables: true,
      mainLightPosition: main.mainLightPosition,
      mainLightColor: main.mainLightColor,
      sphericalHarmonics: UNITY_CUBISM_REFERENCE_FLAT_WHITE_SH,
      additionalLights: enabled ? additional : [],
    };
    const controllers = new Set<StoryCharacter>(this.cachedCharacterControllers.values());
    for (const { item } of this.stagedCharacterItems.values()) controllers.add(item);
    for (const item of controllers) {
      if (item.model.format !== "cubism3") continue;
      this.invokeCharacterModel(item, "apply stage lighting", undefined, (model) =>
        (model as AdvCubismModel).setUnityLighting(this.cubismLightingState),
      );
    }
    const sourceColor = record(directional?.color);
    const intensity = finite(directional?.intensity, 1);
    this.stageLightState = {
      index: Math.trunc(finite(index)),
      group,
      enabled,
      color: directional
        ? {
            r: finite(sourceColor.r, 1) * intensity,
            g: finite(sourceColor.g, 1) * intensity,
            b: finite(sourceColor.b, 1) * intensity,
          }
        : { r: 1, g: 1, b: 1 },
      source: directional || null,
      lighting: this.cubismLightingState,
    };
    this.state.stageLight = this.stageLightState;
  }

  private applyStageMultiplyTexture(stage: UnknownRecord): void {
    const texture = record(stage.shadowTexture || stage.multiplyTexture);
    this.stageMultiplyTextureUrl = firstString(texture.url, stage.shadowTextureUrl, stage.multiplyTextureUrl);
    const uv = record(stage.shadowTextureUv || stage.multiplyTextureUv);
    const amplitude = record(stage.shadowTextureAmplitude || stage.multiplyTextureAmplitude);
    this.stageMultiplyTextureOptions = {
      enabled: Boolean(this.stageMultiplyTextureUrl),
      uv: [finite(uv.x, 1), finite(uv.y, 1), finite(uv.z), finite(uv.w)],
      intensity: finite(stage.shadowTextureIntensity ?? stage.multiplyTextureIntensity, 0.3),
      amplitude: [finite(amplitude.x, 0.002), finite(amplitude.y, 0.002)],
      frequency: finite(stage.shadowTextureFrequency ?? stage.multiplyTextureFrequency, 0.5),
    };
    const version = ++this.stageMultiplyTextureVersion;
    const controllers = new Set<StoryCharacter>(this.cachedCharacterControllers.values());
    for (const { item } of this.stagedCharacterItems.values()) controllers.add(item);
    for (const item of controllers) {
      void this.invokeCharacterModelTask(item, "apply stage multiply texture", undefined, (model) =>
        this.configureModelMultiplyTexture(model, version),
      );
    }
  }

  private async configureModelMultiplyTexture(model: StoryCharacterModel, version: number): Promise<void> {
    // Multiply-texture / Unity ADV lighting is a Cubism-3-only renderer hook.
    // Other character backends have no matching shadow sampler and opt out.
    if (model.format !== "cubism3") return;
    const advModel = model as AdvCubismModel;
    const url = this.stageMultiplyTextureUrl;
    const options = this.stageMultiplyTextureOptions;
    if (!url) {
      advModel.clearUnityMultiplyTexture();
      return;
    }
    await advModel.loadUnityMultiplyTexture(url, options);
    // A stage can change while its image is decoding. Re-apply the latest
    // authored state instead of letting the older async load win the race.
    if (version !== this.stageMultiplyTextureVersion) {
      await this.configureModelMultiplyTexture(model, this.stageMultiplyTextureVersion);
    }
  }

  applyStagePostEffect(index = 0): void {
    this.stagePostEffect = this.qualityConfig.isStagePostEffectEnabled() ? this.environmentPostEffect(index) : null;
    this.state.stagePostEffect = this.stagePostEffect;
    this.syncPostPipeline();
  }

  changeStageParticleEffects(index = 0): void {
    const stage = record(this.state.stage);
    const groups = Array.isArray(stage.particleEffectGroups)
      ? stage.particleEffectGroups
      : Array.isArray(stage.particleEffects)
        ? stage.particleEffects
        : [];
    for (const key of this.stageParticleKeys) this.stageEffects.stop(key);
    this.stageParticleKeys.clear();
    const requestedIndex = Math.trunc(finite(index));
    const selected =
      this.qualityConfig.isStageParticleEffectEnabled() && requestedIndex >= 0 && requestedIndex < groups.length
        ? (groups[requestedIndex] ?? null)
        : null;
    this.state.stageParticleEffects = selected;
    const effects = Array.isArray(record(selected).effects) ? (record(selected).effects as unknown[]) : [];
    effects.forEach((rawEffect, effectIndex) => {
      const effect = record(rawEffect);
      const runtime = effect.runtime as AdvEffectEntry["runtime"];
      if (!runtime) return;
      const key = `stage:${requestedIndex}:${effectIndex}`;
      this.stageParticleKeys.add(key);
      void this.stageEffects.play(key, runtime, { simulationSpeed: 1, anchor: this.characterField }).catch((error) => {
        if (!this.state.error) this.state.error = error instanceof Error ? error.message : String(error);
      });
    });
  }

  async setStill(still: AdvStillEntry | null | undefined, alpha = 1, duration = 0): Promise<void> {
    const source = firstString(still?.url);
    const from = this.overlay?.stillAlpha || 0;
    if (source) this.overlay?.setStill(source, duration > 0 ? from : alpha);
    if (duration > 0) {
      await this.runTween({
        duration,
        ease: resolveEase(6),
        update: (progress) => this.overlay?.setStillAlpha(lerp(from, source ? clamp(alpha) : 0, progress)),
      });
    }
    if (!source) {
      this.overlay?.setStill("", 0);
      this.overlay?.setStillViewAlpha(0, 0);
    } else {
      this.overlay?.setStillViewAlpha(1, 0);
    }
    this.state.still = still || null;
  }

  /** AdvStillCommand: any currently showing Still makes the next command Hide. */
  async runStillCommand(
    still: AdvStillEntry | null | undefined,
    stillAlpha: number,
    overlayAlpha: number,
    animationIndex: number,
    duration = 0,
  ): Promise<void> {
    const source = firstString(still?.url);
    if (!source) return;
    // AdvStillCommand branches on AdvStill.IsShowing, not on an asset-name
    // comparison. A different Still command while one is visible hides the
    // existing Still; it does not swap the sprite in the same invocation.
    const hide = Boolean(this.state.still);
    const seconds = Math.max(0, finite(duration));
    if (hide) {
      // AdvStillCommand starts HideStill and UIAdvWidget.FadeToStill together,
      // then awaits UniTask.WhenAll. HideStill keeps IsShowing true throughout
      // its alpha tween and deactivates only after that tween completes.
      const hideStill = this.fadeStill(0, seconds).then(() => {
        this.overlay?.setStill("", 0);
        this.state.still = null;
      });
      await Promise.all([hideStill, this.fadeStillView(0, 0, seconds)]);
      return;
    }

    this.overlay?.setStill(source, this.overlay?.stillAlpha || 0);
    this.overlay?.setStillAnimationIndex(animationIndex);
    this.state.still = still || null;
    const resolvedOverlayAlpha = clamp(overlayAlpha);
    // ShowStill sets the GameObject active synchronously before beginning its
    // alpha tween; FadeToStill is the parallel sibling awaited by WhenAll.
    await Promise.all([
      this.fadeStill(clamp(stillAlpha), seconds),
      this.fadeStillView(resolvedOverlayAlpha === 0 ? 1 : null, resolvedOverlayAlpha, seconds),
    ]);
  }

  private async fadeStillView(backgroundAlpha: number | null, overlayAlpha: number, duration: number): Promise<void> {
    const fromBackground = this.overlay?.stillBackgroundAlpha || 0;
    const fromOverlay = this.overlay?.stillOverlayAlpha || 0;
    const targetBackground = backgroundAlpha == null ? fromBackground : clamp(backgroundAlpha);
    await this.runTween({
      duration,
      ease: resolveEase(6),
      update: (progress) =>
        this.overlay?.setStillViewAlpha(
          lerp(fromBackground, targetBackground, progress),
          lerp(fromOverlay, clamp(overlayAlpha), progress),
        ),
    });
  }

  async fadeStill(alpha: number, duration = 0): Promise<void> {
    const from = this.overlay?.stillAlpha || 0;
    await this.runTween({
      duration,
      ease: resolveEase(6),
      update: (progress) => this.overlay?.setStillAlpha(lerp(from, clamp(alpha), progress)),
    });
  }

  async clearStill(duration = 0): Promise<void> {
    await this.setStill(null, 0, duration);
  }

  async setFrameOverlay(frame: AdvFrameEntry, alpha = 1, key = ""): Promise<void> {
    const resolvedKey = key || String(frame.name || frame.source || "frame");
    await this.overlay?.setFrame(resolvedKey, frame, alpha);
  }

  setFrameOpacity(alpha: number, slide = 0, key = ""): void {
    const resolvedKey = key || this.state.frameName || "frame";
    this.overlay?.setFrameOpacity(resolvedKey, alpha, slide);
  }

  clearFrameOverlay(key?: string): void {
    this.overlay?.clearFrame(key);
  }

  setCover(color: unknown, opacity: unknown): void {
    // A plain fade and a rule fade are mutually exclusive in UIAdvWidget.
    this.clearRuleTransition();
    const value =
      typeof color === "string"
        ? color
        : `#${(Math.trunc(finite(color)) >>> 0).toString(16).padStart(6, "0").slice(-6)}`;
    this.overlay?.setCover(value, clamp(opacity));
    this.state.cover.color = value;
    this.state.cover.opacity = clamp(opacity);
  }

  async flashWhite(duration = 0.12): Promise<void> {
    this.overlay?.setFlash(1);
    await this.runTween({ duration, update: (progress) => this.overlay?.setFlash(1 - progress) });
    this.overlay?.setFlash(0);
  }

  async runRuleTransition(
    rule: AdvRuleTransitionEntry,
    color: string,
    duration: number,
    fadeOut: boolean,
  ): Promise<void> {
    const source = firstString(rule.texture, rule.maskTexture);
    if (!source) return;
    const version = ++this.ruleTransitionVersion;
    const textureLease = await this.acquireTexture(source);
    if (this.destroyed || version !== this.ruleTransitionVersion) {
      textureLease.release();
      return;
    }
    const resolvedColor = colorComponents(color);
    // Screen-space UI/Transition owns coverage while it is active. Clear a
    // preceding plain Image fade without routing the rule through the DOM.
    this.overlay?.setCover(color, 0);
    const previousTextureLease = this.ruleTransitionTextureLease;
    this.ruleTransitionTextureLease = textureLease;
    const completion = this.ruleTransition.play({
      texture: textureLease.value,
      color: resolvedColor,
      duration,
      curve: rule.easingCurve,
      useGradient: Boolean(rule.gradient),
      fadeOut,
    });
    previousTextureLease?.release();
    await completion;
    if (!fadeOut && this.ruleTransitionTextureLease === textureLease) {
      this.ruleTransitionTextureLease = null;
      textureLease.release();
    }
    if (this.destroyed || version !== this.ruleTransitionVersion) return;
    this.state.cover.color = color;
    this.state.cover.opacity = fadeOut ? 1 : 0;
  }

  private clearRuleTransition(): void {
    this.ruleTransitionVersion += 1;
    this.ruleTransition.clear();
    this.ruleTransitionTextureLease?.release();
    this.ruleTransitionTextureLease = null;
  }

  async showVideo(
    videoInfo: AdvVideoEntry | string,
    fadeIn = 0,
    _readyTimeout = 0,
    playbackRate = 1,
    signal?: AbortSignal,
    targetAlpha = 1,
  ): Promise<void> {
    const generation = this.sceneGeneration;
    const overlay = this.overlay;
    const video = await overlay?.showVideo(videoInfo, playbackRate, signal);
    if (this.destroyed || generation !== this.sceneGeneration || signal?.aborted || this.overlay !== overlay) return;
    if (!video) return;
    const source =
      typeof videoInfo === "string" ? videoInfo : firstString(videoInfo.playableUrl, videoInfo.src, videoInfo.url);
    Object.assign(this.state.video, {
      visible: true,
      src: source,
      alpha: fadeIn > 0 ? 0 : clamp(targetAlpha),
      playbackRate,
      playing: true,
      ended: false,
    });
    this.overlay?.setVideoAlpha(fadeIn > 0 ? 0 : clamp(targetAlpha));
    if (fadeIn > 0) {
      await this.fadeVideo(targetAlpha, fadeIn);
      if (this.destroyed || generation !== this.sceneGeneration || signal?.aborted || this.overlay !== overlay) return;
    }
  }

  async fadeVideo(alpha: number, duration = 0): Promise<void> {
    const from = finite(this.state.video.alpha, 1);
    const to = clamp(alpha);
    await this.runTween({
      duration,
      ease: resolveEase(6),
      update: (progress) => {
        const value = lerp(from, to, progress);
        this.state.video.alpha = value;
        this.overlay?.setVideoAlpha(value);
      },
    });
  }

  async hideVideo(fadeOut = 0): Promise<void> {
    if (fadeOut > 0) await this.fadeVideo(0, fadeOut);
    this.overlay?.clearVideo();
    Object.assign(this.state.video, {
      visible: false,
      src: "",
      alpha: 1,
      playing: false,
      ended: false,
      currentTime: 0,
      duration: 0,
      progress: 0,
    });
  }

  skipVideo(): boolean {
    const video = this.overlay?.videoElement;
    if (!video) return false;
    video.currentTime = Number.isFinite(video.duration) ? video.duration : video.currentTime;
    return true;
  }

  seekVideoRatio(ratio: unknown): boolean {
    const video = this.overlay?.videoElement;
    if (!video || !Number.isFinite(video.duration) || video.duration <= 0) return false;
    video.currentTime = clamp(ratio) * video.duration;
    return true;
  }

  waitVideoEnded(signal?: AbortSignal): Promise<void> {
    return this.overlay?.waitVideoEnded(signal) || Promise.resolve();
  }

  async setCommandPostEffect(profile: AdvPostEffectEntry | string | unknown, fade = 0): Promise<void> {
    const volumeProfile =
      typeof profile === "string"
        ? ({ name: profile, effectName: profile } satisfies UnityVolumeProfile)
        : (profile as UnityVolumeProfile | null);
    const key = advVolumeProfileKey(volumeProfile);
    if (!key || !volumeProfile) {
      await this.clearCommandPostEffects(fade);
      return;
    }

    let child = this.commandVolumes.get(key);
    if (!child) {
      child = { profile: volumeProfile, weight: 0, enabled: false, version: 0 };
      this.commandVolumes.set(key, child);
    } else {
      child.profile = volumeProfile;
    }
    const target = child.enabled ? 0 : 1;
    child.enabled = target > 0;
    const from = child.weight;
    const version = ++child.version;
    this.commandPostEffect = target > 0 ? volumeProfile : null;
    this.state.commandPostEffect = this.commandPostEffect;
    await this.runTween({
      duration: fade,
      // DOTween.To uses DOTween's default Ease.OutQuad in AdvChildVolume.
      ease: resolveEase(6),
      update: (progress) => {
        if (child?.version !== version) return;
        child.weight = lerp(from, target, progress);
        this.syncPostVolumeLayers();
      },
    });
    if (child.version === version) child.weight = target;
    this.syncPostVolumeLayers();
  }

  async clearCommandPostEffects(fade = 0): Promise<void> {
    const transitions = [...this.commandVolumes.values()].map(async (child) => {
      const from = child.weight;
      const version = ++child.version;
      child.enabled = false;
      await this.runTween({
        duration: fade,
        ease: resolveEase(6),
        update: (progress) => {
          if (child.version !== version) return;
          child.weight = lerp(from, 0, progress);
          this.syncPostVolumeLayers();
        },
      });
      if (child.version === version) child.weight = 0;
    });
    await Promise.all(transitions);
    this.commandPostEffect = null;
    this.state.commandPostEffect = null;
    this.syncPostVolumeLayers();
  }

  private syncPostPipeline(): void {
    this.syncFieldPostEffects();
    this.syncPostVolumeLayers();
  }

  private syncFieldPostEffects(): void {
    if (!this.pipeline) return;
    const lens = record(this.stagePostEffect?.curvedLens);
    const lensAttenuates = lens.attenuateByCameraDistance !== false;
    const lensIntensity = finite(lens.intensity) * (lensAttenuates ? this.fieldRendererState.curvedLensRate : 1);
    const backgroundBlur = this.fieldRendererState.backgroundBlur;
    this.pipeline.setEffects({
      blur: {
        enabled: backgroundBlur > 0.01,
        background: backgroundBlur,
        radiusMax: this.fieldRendererState.blurRadiusMax,
      },
      curvedLens: {
        enabled:
          lens.active !== false &&
          lensIntensity > 0 &&
          (finite(lens.horizontalRate) > 0 || finite(lens.verticalRate) > 0),
        center: { x: finite(record(lens.center).x, 0.5), y: finite(record(lens.center).y, 0.5) },
        intensity: lensIntensity,
        size: finite(lens.size, 0.35),
        softness: finite(lens.softness, 0.2),
        horizontalRate: finite(lens.horizontalRate, 1),
        verticalRate: finite(lens.verticalRate, 0.15),
        scale: finite(lens.scale, 1),
        reverse: lens.reverse !== false,
      },
    });
  }

  private syncPostVolumeLayers(): void {
    if (!this.pipeline) return;
    const volumeLayers: AdvVolumeLayer[] = [];
    if (this.stagePostEffect) {
      volumeLayers.push({ profile: this.stagePostEffect as UnityVolumeProfile, weight: 1 });
    }
    for (const child of this.commandVolumes.values()) {
      if (child.weight > 0) volumeLayers.push({ profile: child.profile, weight: child.weight });
    }
    this.pipeline.setVolumeLayers(volumeLayers);
  }

  async playCommandEffect(
    effect: AdvEffectEntry | null,
    options: {
      atOnce?: boolean;
      simulationSpeed?: number;
      positionType?: number;
      targetName?: string;
      canvasLayers?: readonly unknown[];
    } = {},
  ): Promise<void> {
    const key = firstString(options.targetName, effect?.name, "adv-command-effect");
    if (this.commandEffects.isPlaying(key)) {
      this.commandEffects.stop(key, Boolean(options.atOnce));
      this.commandEffectStates.delete(key);
      return;
    }
    if (!effect) return;
    if (!effect.runtime) {
      throw new Error(`ADV effect ${effect.name || key} has no Unity particle prefab data`);
    }
    const route = resolveAdvEffectRoute(options.canvasLayers, options.positionType);
    const state: CommandEffectState = {
      key,
      effect,
      atOnce: Boolean(options.atOnce),
      simulationSpeed: Math.max(0, finite(options.simulationSpeed, 1)),
      positionType: options.positionType,
      targetName: key,
      canvasLayers: [...(options.canvasLayers || [])],
    };
    this.commandEffectStates.set(key, state);
    const anchor =
      route.phase === "advBack"
        ? this.backgroundField
        : route.phase === "character"
          ? this.stageNode(route.positionType ?? 5)
          : route.phase === "advFront"
            ? this.characterField
            : null;
    await this.commandEffects.play(key, effect.runtime, {
      simulationSpeed: state.simulationSpeed,
      anchor,
      sortingOrderOverride: route.sortingOrder,
      targetScene: this.commandEffectScene(route),
    });
  }

  isCommandEffectPlaying(key: string): boolean {
    return this.commandEffects.isPlaying(key);
  }

  stopCommandEffects(): void {
    this.commandEffects.stop();
    this.commandEffectStates.clear();
  }

  async settleSeekSnapshotResources(): Promise<void> {
    await Promise.all([this.commandEffects.waitForPending(), this.stageEffects.waitForPending()]);
  }

  seekSnapshotSafety(): SeekSnapshotSafety {
    if (this.destroyed || !this.renderer) return { safe: false, reason: "scene-not-ready" };
    if (this.contextLost || this.contextRestoreController) return { safe: false, reason: "webgl-context-restoring" };
    if (this.characterModelRecoveryStates.size) return { safe: false, reason: "character-model-recovering" };
    if (this.pendingStageCapture || this.stageCaptureAlpha > 0.000001) {
      return { safe: false, reason: "stage-capture-active" };
    }
    if (this.pendingCharacterCommands.hasPendingLoads) {
      return { safe: false, reason: "character-load-active" };
    }
    if (this.commandEffects.hasPendingEffects || this.stageEffects.hasPendingEffects) {
      return { safe: false, reason: "particle-effect-loading" };
    }
    if (this.commandEffects.hasAdvancedEffects || this.stageEffects.hasAdvancedEffects) {
      return { safe: false, reason: "particle-effect-advanced" };
    }
    if (this.backgroundBlurTweenController) return { safe: false, reason: "background-blur-active" };
    if (this.characterBlurTweenControllers.size || this.characterBrightnessTweenControllers.size) {
      return { safe: false, reason: "character-renderer-tween-active" };
    }
    if (this.state.video.visible || this.overlay?.videoElement) return { safe: false, reason: "video-active" };
    const visibleControllers = new Set(this.characterItems.values());
    for (const controller of this.cachedCharacterControllers.values()) {
      if (!visibleControllers.has(controller)) {
        // Hidden cached controllers carry native angle/look/motion state. Until
        // snapshots serialize that cache, force seek to deterministic replay.
        return { safe: false, reason: `hidden-character-controller:${controller.target}` };
      }
    }
    if (
      this.commandShakeControllers.size > 0 ||
      Math.abs(this.backgroundShake.x) > 0.000001 ||
      Math.abs(this.backgroundShake.y) > 0.000001 ||
      Math.abs(this.characterShake.x) > 0.000001 ||
      Math.abs(this.characterShake.y) > 0.000001 ||
      Math.abs(this.cameraShake.x) > 0.000001 ||
      Math.abs(this.cameraShake.y) > 0.000001 ||
      this.cameraShakeMode !== "idle"
    ) {
      return { safe: false, reason: "shake-active" };
    }
    for (const item of this.characterItems.values()) {
      if (item.model.format !== "static-portrait") {
        // Replaying the final motion/expression name does not restore Cubism's
        // motion queue time, expression fade, physics, pose or blink phase.
        // Reject that checkpoint instead of presenting a plausible but false
        // internal state; the player will replay from the nearest safe boundary.
        return { safe: false, reason: `character-runtime-phase:${item.target}` };
      }
      if (item.pendingPausedMotion || item.pendingPausedExpression) {
        return { safe: false, reason: `character-paused-presentation-pending:${item.target}` };
      }
      if (item.angleTweenController) return { safe: false, reason: `character-angle-active:${item.target}` };
      if (item.lookTweenController) return { safe: false, reason: `character-look-active:${item.target}` };
      if (item.lipSync.enabled || item.lipSync.motionSyncPcm || item.lipSync.sources.length) {
        return { safe: false, reason: `character-lip-active:${item.target}` };
      }
    }
    return { safe: true };
  }

  createSeekSnapshot(): AdvStorySceneSeekSnapshot | null {
    if (!this.seekSnapshotSafety().safe) return null;
    const characters = [...this.characterItems.values()].map((item) => ({
      target: item.target,
      live2dKey: item.live2dKey,
      controllerIdentity:
        this.characterControllerIdentities.get(item.target) ||
        firstString(item.live2dKey, item.entry.url, record(item.entry.runtime).modelUrl, item.target),
      entry: item.entry,
      positionType: item.positionType,
      worldPosition: item.worldPosition ? { ...item.worldPosition } : null,
      offset: { ...item.offset },
      alpha: item.alpha,
      brightness: item.brightness,
      facing: item.facing,
      roleAngle: item.roleAngle,
      angle: item.angle,
      bodyAngle: item.bodyAngle,
      angleOverride: item.angleOverride,
      lookX: item.lookX,
      lookY: item.lookY,
      lookOriginalX: item.lookOriginalX,
      lookOriginalY: item.lookOriginalY,
      lookOverride: item.lookOverride,
      blurIntensity: item.blurIntensity,
      sortingOrder: item.sortingOrder,
      rimLight: clonePlain(item.rimLight),
      presentation: (this.characterPresentationHistory.get(item.target) || []).map((event) => ({ ...event })),
      // Active lip states are rejected by seekSnapshotSafety; retain the
      // normalized idle values without serializing browser audio objects.
      lipSync: {
        ...item.lipSync,
        motionSyncPcm: null,
        sources: [] as const,
        dampVelocity: { ...item.lipSync.dampVelocity },
        randomSeed: { ...item.lipSync.randomSeed },
      },
      paused: item.paused,
    }));
    return {
      version: STORY_SCENE_SEEK_SNAPSHOT_VERSION,
      background: (this.state.background as AdvBackgroundEntry | null) || null,
      still: (this.state.still as AdvStillEntry | null) || null,
      stillAlpha: this.overlay?.stillAlpha || 0,
      stillBackgroundAlpha: this.overlay?.stillBackgroundAlpha || 0,
      stillOverlayAlpha: this.overlay?.stillOverlayAlpha || 0,
      stillAnimationIndex: this.overlay?.stillAnimationIndex || 0,
      frame: this.state.frame,
      frameName: this.state.frameName,
      frameOpacity: this.state.frameOpacity,
      frameSlide: this.state.frameSlide,
      frameEntries: clonePlain(this.state.frameEntries),
      stage: this.state.stage,
      stageEnv: clonePlain(this.state.stageEnv),
      stageOffsets: [...this.stageOffsets.entries()].map(([key, value]) => [key, { ...value }] as const),
      cameraState: clonePlain(this.cameraState),
      fieldRendererState: clonePlain(this.fieldRendererState),
      postEffect: clonePlain(this.state.postEffect),
      commandVolumes: [...this.commandVolumes.entries()].map(([key, child]) => ({
        key,
        profile: child.profile,
        weight: child.weight,
        enabled: child.enabled,
      })),
      commandEffects: [...this.commandEffectStates.values()]
        .filter((entry) => this.commandEffects.isPlaying(entry.key))
        .map((entry) => ({
          ...entry,
          canvasLayers: [...entry.canvasLayers],
        })),
      effect: this.state.effect,
      effects: clonePlain(this.state.effects),
      cover: clonePlain(this.state.cover),
      talk: clonePlain(this.state.talk),
      // Story-title visibility is controlled by a Vue timer outside the scene;
      // shortcut seek never replays elapsed UI-only title time.
      title: { ...clonePlain(this.state.title), visible: false },
      location: clonePlain(this.state.location),
      subtitles: clonePlain(this.state.subtitles),
      chat: clonePlain(this.state.chat),
      choices: clonePlain(this.state.choices),
      dofActive: Boolean(this.state.dofActive),
      characters,
      lifecycle: {
        characterLoadSequence: this.characterLoadSequence,
        characterLoadTokens: [...this.characterLoadTokens.entries()],
        pendingCharacters: this.pendingCharacterCommands.createSnapshot(),
        characterPriorityOrder: [...this.characterPriorityOrder],
      },
    };
  }

  async restoreSeekSnapshot(snapshot: AdvStorySceneSeekSnapshot): Promise<void> {
    if (snapshot.version !== STORY_SCENE_SEEK_SNAPSHOT_VERSION) {
      throw new Error(`Unsupported ADV scene seek snapshot version: ${String(snapshot.version)}`);
    }
    // A pending browser-side model load has no serializable continuation. Such
    // a checkpoint must never have passed seekSnapshotSafety in the first place.
    if (snapshot.lifecycle.pendingCharacters.loads.length) {
      throw new Error("ADV seek snapshot contains a pending character load");
    }

    // A checkpoint is only captured while shake is idle, but it is restored
    // into the currently running scene. Clear that scene's transient state
    // before replay: CameraShake is a native state toggle, so carrying a
    // previous `playing` value across this boundary would invert both the
    // authored start and stop commands during deterministic replay.
    this.resetShakeState();
    this.cancelPendingStageCapture(true);
    this.clearRuleTransition();
    this.commandEffects.dispose();
    this.stageEffects.dispose();
    this.commandEffectStates.clear();
    this.stageParticleKeys.clear();
    await this.hideVideo(0);
    this.clearCharacters();
    this.clearFrameOverlay();

    await this.setBackground(snapshot.background, 0);
    const stageEnv = snapshot.stageEnv;
    this.state.stage = snapshot.stage;
    this.applyStageEnv(stageEnv.focusPosition);
    this.applyStageLight(stageEnv.light);
    this.changeStageParticleEffects(stageEnv.effect);
    this.applyStagePostEffect(stageEnv.postEffect);
    this.state.stageEnv = clonePlain(stageEnv);

    this.stageOffsets.clear();
    for (const [positionType, offset] of snapshot.stageOffsets) {
      this.stageOffsets.set(Number(positionType), { ...offset });
    }
    Object.assign(this.cameraState, clonePlain(snapshot.cameraState));
    Object.assign(this.fieldRendererState, clonePlain(snapshot.fieldRendererState));

    for (const character of snapshot.characters) {
      const placement = this.placeCharacter(
        {
          targetName: character.target,
          targets: [{ target: character.target }],
          live2d: character.entry,
          live2dKey: character.live2dKey,
          controllerIdentity: character.controllerIdentity,
          characterWorldPosition: character.worldPosition || undefined,
        },
        character.positionType,
        0,
        false,
      );
      // Restore the active channel heads while CharacterIn is still staged so
      // seek never exposes defaults while the historical clips lazy-parse.
      const reversedPresentation = [...character.presentation].reverse();
      const lastMotion = reversedPresentation.find((event) => event.kind === "motion");
      const lastExpression = reversedPresentation.find((event) => event.kind === "expression");
      if (lastMotion) this.playMotionForTarget(character.target, lastMotion.name, 0);
      if (lastExpression) this.playExpressionForTarget(character.target, lastExpression.name, 0);
      await placement;
      const item = this.characterItems.get(character.target);
      if (!item) throw new Error(`ADV seek could not restore character ${character.target}`);
      item.worldPosition = character.worldPosition ? { ...character.worldPosition } : null;
      Object.assign(item.offset, character.offset);
      item.alpha = character.alpha;
      item.brightness = character.brightness;
      item.facing = character.facing;
      item.roleAngle = character.roleAngle;
      item.angle = character.angle;
      item.bodyAngle = character.bodyAngle;
      item.angleOverride = character.angleOverride;
      item.lookX = character.lookX;
      item.lookY = character.lookY;
      item.lookOriginalX = character.lookOriginalX;
      item.lookOriginalY = character.lookOriginalY;
      item.lookOverride = character.lookOverride;
      item.blurIntensity = character.blurIntensity;
      item.sortingOrder = character.sortingOrder;
      item.rimLight = clonePlain(character.rimLight);
      item.lipSync = {
        ...character.lipSync,
        motionSyncPcm: null,
        sources: [],
        dampVelocity: { ...character.lipSync.dampVelocity },
        randomSeed: { ...character.lipSync.randomSeed },
      };
      item.paused = character.paused;
      this.invokeCharacterModel(item, "restore seek pause state", undefined, (model) => model.setPaused(item.paused));
      if (item.lookOverride) {
        this.invokeCharacterModel(item, "restore seek look", undefined, (model) =>
          model.setEyeBallPosition(item.lookX, item.lookY),
        );
      }
      this.characterPresentationHistory.set(
        character.target,
        character.presentation.map((event) => ({ ...event })),
      );
      this.layoutCharacter(item);
    }

    this.characterPriorityOrder = [...snapshot.lifecycle.characterPriorityOrder];
    this.characterLoadTokens.clear();
    for (const [target, token] of snapshot.lifecycle.characterLoadTokens) {
      this.characterLoadTokens.set(target, token);
    }
    this.characterLoadSequence = Math.max(
      this.characterLoadSequence,
      snapshot.lifecycle.characterLoadSequence,
      0,
      ...snapshot.lifecycle.characterLoadTokens.map(([, token]) => token),
    );
    this.pendingCharacterCommands.restoreSnapshot(snapshot.lifecycle.pendingCharacters);

    await this.stageEffects.waitForPending();
    for (const entry of snapshot.commandEffects) {
      await this.playCommandEffect(entry.effect, {
        atOnce: entry.atOnce,
        simulationSpeed: entry.simulationSpeed,
        positionType: entry.positionType,
        targetName: entry.targetName,
        canvasLayers: entry.canvasLayers,
      });
    }
    await this.setStill(snapshot.still, snapshot.stillAlpha, 0);
    this.overlay?.setStillViewAlpha(snapshot.stillBackgroundAlpha, snapshot.stillOverlayAlpha);
    this.overlay?.setStillAnimationIndex(snapshot.stillAnimationIndex);
    this.state.frame = snapshot.frame;
    this.state.frameName = snapshot.frameName;
    this.state.frameOpacity = snapshot.frameOpacity;
    this.state.frameSlide = snapshot.frameSlide;
    this.state.frameEntries = clonePlain(snapshot.frameEntries);
    for (const [key, value] of Object.entries(this.state.frameEntries)) {
      if (!value.frame || value.opacity <= 0.001) continue;
      await this.setFrameOverlay(value.frame, value.opacity, key);
      this.setFrameOpacity(value.opacity, value.slide, key);
    }

    this.commandVolumes.clear();
    for (const child of snapshot.commandVolumes) {
      this.commandVolumes.set(child.key, {
        profile: child.profile as UnityVolumeProfile,
        weight: clamp(child.weight),
        enabled: child.enabled,
        version: 0,
      });
    }
    this.commandPostEffect = [...this.commandVolumes.values()].find((child) => child.enabled)?.profile ?? null;
    this.state.commandPostEffect = this.commandPostEffect;
    this.state.postEffect = clonePlain(snapshot.postEffect);
    this.state.talk = clonePlain(snapshot.talk);
    this.state.title = clonePlain(snapshot.title);
    this.state.location = clonePlain(snapshot.location);
    this.state.subtitles = clonePlain(snapshot.subtitles);
    this.state.chat = clonePlain(snapshot.chat);
    this.state.choices = clonePlain(snapshot.choices);
    this.state.dofActive = snapshot.dofActive;
    this.state.effect = snapshot.effect;
    this.state.effects = clonePlain(snapshot.effects);
    this.setCover(snapshot.cover.color, snapshot.cover.opacity);
    this.syncPostPipeline();
    this.refreshStageNodes();
    this.applyTransforms();
  }

  focusPoint(positionType: unknown): Vec3 {
    return this.focusPointInternal(positionType);
  }

  characterAtPosition(positionType: unknown): StoryCharacter | null {
    const key = Number(positionType) || 0;
    for (const item of this.characterItems.values()) {
      if (item.positionType === key) return item;
    }
    return null;
  }

  setCameraRoll(angle: number, duration = 0, easeValue: unknown = 6, signal?: AbortSignal): Promise<void> {
    const from = this.cameraState.angle;
    const target = finite(angle);
    const token = this.beginCameraTween(["angle"]);
    return this.runTween({
      duration,
      ease: resolveEase(easeValue, 6),
      signal,
      update: (progress) => {
        if (!this.ownsCameraTween(token, "angle")) return;
        this.cameraState.angle = lerp(from, target, progress);
        this.applyTransforms();
      },
    });
  }

  prepareLook(
    target: string,
    lookX: number,
    lookY: number,
    duration = 0,
    enabled = true,
  ): (() => Promise<void>) | null {
    const expectedItem = this.cachedCharacterController(target);
    const loadToken = expectedItem ? null : this.selectedPendingCharacterToken(target);
    if (!expectedItem && loadToken == null) return null;

    const targetX = finite(lookX);
    const targetY = finite(lookY);
    let stopX = 0;
    let stopY = 0;
    if (expectedItem) {
      if (enabled) {
        // SetLookEnabled(true) precedes DelaySeconds and captures the original
        // eye parameters on the first false -> true transition.
        this.enableLookOverride(expectedItem);
      } else {
        // Stop captures its return target before DelaySeconds but does not
        // disable the late Look override until the tween completes.
        // SetLookEnabled(false) clears OriginalLookX/Y, so a repeated Stop
        // samples zero while leaving the controller's current look fields free
        // to tween invisibly just as the native controller does.
        stopX = expectedItem.lookOverride ? expectedItem.lookOriginalX : 0;
        stopY = expectedItem.lookOverride ? expectedItem.lookOriginalY : 0;
      }
    } else if (enabled && loadToken != null) {
      this.pendingCharacterCommands.queueLookOverridePreparation(target, loadToken);
    }

    return async () => {
      if (expectedItem) {
        this.cancelPendingLookWait(target);
        if (enabled) {
          await this.tweenLook(expectedItem, targetX, targetY, duration, false);
        } else {
          await this.tweenLook(expectedItem, stopX, stopY, duration, true);
        }
        return;
      }
      if (loadToken == null || this.characterLoadTokens.get(target) !== loadToken) return;
      await this.setLook(target, targetX, targetY, duration, enabled);
    };
  }

  prepareLookTarget(
    target: string,
    targetPositionType: number,
    duration = 0,
    enabled = true,
    lookTargetName?: string,
  ): (() => Promise<void>) | null {
    if (!enabled) return this.prepareLook(target, 0, 0, duration, false);

    const sourceCharacter = this.cachedCharacterController(target);
    const sourceHead = sourceCharacter
      ? (this.applyTransforms(), this.characterHeadWorldPosition(sourceCharacter))
      : this.pendingCharacterHeadWorldPosition(target);
    const targetHead = this.characterHeadWorldPositionAtPosition(targetPositionType, lookTargetName);
    // Native exits immediately when either controller cannot be resolved;
    // DelaySeconds is not entered on this path.
    if (!sourceHead || !targetHead) return null;
    const look = computeAdvLookTarget(sourceHead, targetHead);
    return this.prepareLook(target, look.x, look.y, duration, true);
  }

  async setLook(target: string, lookX: number, lookY: number, duration = 0, enabled = true): Promise<void> {
    // RefreshLookCancellationToken cancels the preceding Look/Stop task before
    // either the loaded or Web-staged path starts the new linear tween.
    this.cancelPendingLookWait(target);
    const item = this.cachedCharacterController(target);
    if (!item) {
      const token = this.selectedPendingCharacterToken(target);
      const resolvedDuration = Math.max(0, finite(duration));
      if (
        token != null &&
        this.pendingCharacterCommands.queueLook(target, token, {
          kind: enabled ? "set" : "stop",
          x: finite(lookX),
          y: finite(lookY),
          durationSeconds: resolvedDuration,
          queuedAtSeconds: this.monotonicSeconds(),
        })
      ) {
        // A blocking Look command still owns its authored duration even while
        // the Web-only model load is pending. noWait callers detach this task.
        const controller = new AbortController();
        this.pendingLookWaitControllers.set(target, controller);
        try {
          await this.runTween({ duration: resolvedDuration, signal: controller.signal });
        } finally {
          if (this.pendingLookWaitControllers.get(target) === controller) {
            this.pendingLookWaitControllers.delete(target);
          }
        }
      }
      return;
    }
    if (!enabled) {
      await this.disableLookOverride(item, duration);
      return;
    }
    this.enableLookOverride(item);
    await this.tweenLook(item, finite(lookX), finite(lookY), duration, false);
  }

  /**
   * Fast-forward Look commands that Unity executed while its already-loaded
   * character existed, but the browser character was still being prepared.
   * Each new event cancels the preceding linear tween; Stop returns to the
   * eye position captured by the first active Set before releasing override.
   */
  private restorePendingLook(
    item: StoryCharacter,
    events: readonly PendingCharacterLookEvent[],
    overridePrepared = false,
  ): void {
    const sampled = this.invokeCharacterModel(item, "sample pending look", { x: item.lookX, y: item.lookY }, (model) =>
      model.eyeBallPosition(),
    );
    let originalX = sampled.x;
    let originalY = sampled.y;
    let currentX = sampled.x;
    let currentY = sampled.y;
    let override = overridePrepared;
    let tweenState: {
      readonly startSeconds: number;
      readonly endSeconds: number;
      readonly fromX: number;
      readonly fromY: number;
      readonly toX: number;
      readonly toY: number;
      readonly disableAfter: boolean;
    } | null = null;

    const advance = (seconds: number): void => {
      if (!tweenState) return;
      const duration = tweenState.endSeconds - tweenState.startSeconds;
      const progress = duration <= 0 ? 1 : clamp((seconds - tweenState.startSeconds) / duration);
      currentX = lerp(tweenState.fromX, tweenState.toX, progress);
      currentY = lerp(tweenState.fromY, tweenState.toY, progress);
      if (progress < 1) return;
      if (tweenState.disableAfter) override = false;
      tweenState = null;
    };

    for (const event of events) {
      advance(event.queuedAtSeconds);
      if (event.kind === "set") {
        if (!override) {
          originalX = currentX;
          originalY = currentY;
        }
        override = true;
        tweenState = {
          startSeconds: event.queuedAtSeconds,
          endSeconds: event.queuedAtSeconds + Math.max(0, event.durationSeconds),
          fromX: currentX,
          fromY: currentY,
          toX: event.x,
          toY: event.y,
          disableAfter: false,
        };
      } else {
        tweenState = {
          startSeconds: event.queuedAtSeconds,
          endSeconds: event.queuedAtSeconds + Math.max(0, event.durationSeconds),
          fromX: currentX,
          fromY: currentY,
          toX: override ? originalX : 0,
          toY: override ? originalY : 0,
          disableAfter: true,
        };
      }
    }

    const now = this.monotonicSeconds();
    advance(now);
    item.lookOriginalX = originalX;
    item.lookOriginalY = originalY;
    item.lookX = currentX;
    item.lookY = currentY;
    item.lookOverride = override;
    if (override && tweenState) {
      const remaining = Math.max(0, tweenState.endSeconds - now);
      void this.tweenLook(item, tweenState.toX, tweenState.toY, remaining, tweenState.disableAfter);
    }
  }

  async setLookTarget(
    target: string,
    targetPositionType: number,
    duration = 0,
    enabled = true,
    lookTargetName?: string,
  ): Promise<void> {
    this.cancelPendingLookWait(target);
    const sourceCharacter = this.cachedCharacterController(target);
    if (!sourceCharacter) {
      if (!enabled) {
        await this.setLook(target, 0, 0, duration, false);
        return;
      }
      const sourceHead = this.pendingCharacterHeadWorldPosition(target);
      const targetHead = this.characterHeadWorldPositionAtPosition(targetPositionType, lookTargetName);
      if (!sourceHead || !targetHead) {
        this.cancelPendingLookWait(target);
        return;
      }
      const look = computeAdvLookTarget(sourceHead, targetHead);
      await this.setLook(target, look.x, look.y, duration, true);
      return;
    }
    if (!enabled) {
      await this.disableLookOverride(sourceCharacter, duration);
      return;
    }

    const targetHead = this.characterHeadWorldPositionAtPosition(targetPositionType, lookTargetName);
    if (!targetHead) return;

    // GetHeadPosition returns the anchor's current Transform.position. Flush
    // same-frame no-wait stage changes before reading the equivalent world
    // matrices, then preserve the complete parent transform chain.
    this.applyTransforms();
    const sourceHead = this.characterHeadWorldPosition(sourceCharacter);
    const look = computeAdvLookTarget(sourceHead, targetHead);
    this.enableLookOverride(sourceCharacter);
    await this.tweenLook(sourceCharacter, look.x, look.y, duration, false);
  }

  private enableLookOverride(item: StoryCharacter): void {
    if (item.lookOverride) return;
    const original = this.invokeCharacterModel(item, "sample look", { x: item.lookX, y: item.lookY }, (model) =>
      model.eyeBallPosition(),
    );
    item.lookOriginalX = original.x;
    item.lookOriginalY = original.y;
    item.lookX = original.x;
    item.lookY = original.y;
    item.lookOverride = true;
  }

  private async disableLookOverride(item: StoryCharacter, duration: number): Promise<void> {
    if (!item.lookOverride) {
      // OriginalLookX/Y are zero after SetLookEnabled(false). The controller
      // still tweens its private current fields on a repeated Stop, but because
      // Look remains disabled those values never overwrite the model.
      await this.tweenLook(item, 0, 0, duration, true);
      return;
    }
    await this.tweenLook(item, item.lookOriginalX, item.lookOriginalY, duration, true);
  }

  private async tweenLook(
    item: StoryCharacter,
    targetX: number,
    targetY: number,
    duration: number,
    disableAfter: boolean,
  ): Promise<void> {
    item.lookTweenController?.abort();
    const controller = new AbortController();
    item.lookTweenController = controller;
    const abort = (): void => controller.abort();
    const lifecycleSignal = this.lifecycleController.signal;
    if (lifecycleSignal.aborted) controller.abort();
    else lifecycleSignal.addEventListener("abort", abort, { once: true });
    const fromX = item.lookX;
    const fromY = item.lookY;
    const forceUpdateNow = Math.max(0, finite(duration)) <= 0;
    try {
      await this.runTween({
        duration,
        signal: controller.signal,
        update: (progress) => {
          item.lookX = lerp(fromX, targetX, progress);
          item.lookY = lerp(fromY, targetY, progress);
          // A positive-duration SmoothChangeToLook only advances controller
          // fields; OnLateUpdate applies them to Cubism (and Pause can skip
          // that application). Its <= 0 fast path uniquely calls
          // ForceUpdateNow, which #343 depends on for same-command visibility.
          if (forceUpdateNow) {
            this.invokeCharacterModel(item, "force look update", undefined, (model) =>
              model.forceEyeBallPosition(item.lookX, item.lookY),
            );
          }
        },
      });
      if (item.lookTweenController === controller && !controller.signal.aborted && disableAfter) {
        item.lookOverride = false;
        // Live2DCharacterController.SetLookEnabled(false) clears only the
        // captured originals. It deliberately retains the final LookX/Y.
        item.lookOriginalX = 0;
        item.lookOriginalY = 0;
      }
    } finally {
      lifecycleSignal.removeEventListener("abort", abort);
      if (item.lookTweenController === controller) item.lookTweenController = null;
    }
  }

  prepareCharacterAngle(target: string, angle: number, bodyAngle: number, duration = 0): (() => Promise<void>) | null {
    const expectedItem = this.cachedCharacterController(target);
    const loadToken = expectedItem ? null : this.selectedPendingCharacterToken(target);
    if (!expectedItem && loadToken == null) return null;

    // SetOverrideAngleEnabled(true, true) is the synchronous preparation step
    // before DelaySeconds. A cancelled delay intentionally leaves it enabled.
    if (expectedItem) expectedItem.angleOverride = true;
    else if (loadToken != null) {
      this.pendingCharacterCommands.queueAngleOverridePreparation(target, loadToken);
    }
    return async () => {
      if (expectedItem) {
        await this.tweenCharacterAngle(expectedItem, finite(angle), finite(bodyAngle), Math.max(0, finite(duration)));
        return;
      }
      if (loadToken == null || this.characterLoadTokens.get(target) !== loadToken) return;
      await this.setCharacterAngle(target, angle, bodyAngle, duration);
    };
  }

  async setCharacterAngle(target: string, angle: number, bodyAngle: number, duration = 0): Promise<void> {
    // AdvAngleCommand refreshes a per-character cancellation token before
    // SmoothRotateToAngle. Keep that ownership while the Web-only lazy load is
    // pending as well, so an obsolete blocking command is released promptly.
    this.cancelPendingAngleWait(target);
    const item = this.cachedCharacterController(target);
    const resolvedDuration = Math.max(0, finite(duration));
    if (!item) {
      const token = this.selectedPendingCharacterToken(target);
      if (
        token != null &&
        this.pendingCharacterCommands.queueAngle(target, token, {
          angle: finite(angle),
          bodyAngle: finite(bodyAngle),
          durationSeconds: resolvedDuration,
          queuedAtSeconds: this.monotonicSeconds(),
        })
      ) {
        const controller = new AbortController();
        this.pendingAngleWaitControllers.set(target, controller);
        try {
          await this.runTween({ duration: resolvedDuration, signal: controller.signal });
        } finally {
          if (this.pendingAngleWaitControllers.get(target) === controller) {
            this.pendingAngleWaitControllers.delete(target);
          }
        }
      }
      return;
    }
    await this.tweenCharacterAngle(item, finite(angle), finite(bodyAngle), resolvedDuration);
  }

  private async tweenCharacterAngle(
    item: StoryCharacter,
    targetAngle: number,
    targetBodyAngle: number,
    duration: number,
    resumed?: {
      readonly fromAngle: number;
      readonly fromBodyAngle: number;
      readonly startRaw: number;
    },
  ): Promise<void> {
    item.angleTweenController?.abort();
    const controller = new AbortController();
    item.angleTweenController = controller;
    const abort = (): void => controller.abort();
    const lifecycleSignal = this.lifecycleController.signal;
    if (lifecycleSignal.aborted) controller.abort();
    else lifecycleSignal.addEventListener("abort", abort, { once: true });

    item.angleOverride = true;
    const fromAngle = resumed?.fromAngle ?? item.angle;
    const fromBodyAngle = resumed?.fromBodyAngle ?? item.bodyAngle;
    const startRaw = clamp(resumed?.startRaw ?? 0);
    const ease = resolveEase(15, 15);
    try {
      await this.runTween({
        duration,
        signal: controller.signal,
        update: (_progress, raw) => {
          // When a pending browser load completes mid-tween, continue the
          // original OutQuint curve instead of restarting easing from zero.
          const originalRaw = startRaw + (1 - startRaw) * raw;
          const progress = ease(originalRaw);
          item.angle = lerp(fromAngle, targetAngle, progress);
          item.bodyAngle = lerp(fromBodyAngle, targetBodyAngle, progress);
        },
      });
    } finally {
      lifecycleSignal.removeEventListener("abort", abort);
      if (item.angleTweenController === controller) item.angleTweenController = null;
    }
  }

  /**
   * Reconstruct Angle events issued after a no-wait In while the browser was
   * fetching Cubism assets. Native has a preloaded controller at that point,
   * so each event starts immediately and cancels the previous OutQuint tween.
   */
  private restorePendingAngle(item: StoryCharacter, events: readonly PendingCharacterAngleEvent[]): void {
    const ease = resolveEase(15, 15);
    let currentAngle = 0;
    let currentBodyAngle = 0;
    let tweenState: {
      readonly startSeconds: number;
      readonly endSeconds: number;
      readonly fromAngle: number;
      readonly fromBodyAngle: number;
      readonly toAngle: number;
      readonly toBodyAngle: number;
    } | null = null;

    const advance = (seconds: number): number => {
      if (!tweenState) return 1;
      const duration = tweenState.endSeconds - tweenState.startSeconds;
      const raw = duration <= 0 ? 1 : clamp((seconds - tweenState.startSeconds) / duration);
      const progress = ease(raw);
      currentAngle = lerp(tweenState.fromAngle, tweenState.toAngle, progress);
      currentBodyAngle = lerp(tweenState.fromBodyAngle, tweenState.toBodyAngle, progress);
      if (raw >= 1) tweenState = null;
      return raw;
    };

    for (const event of events) {
      advance(event.queuedAtSeconds);
      tweenState = {
        startSeconds: event.queuedAtSeconds,
        endSeconds: event.queuedAtSeconds + Math.max(0, event.durationSeconds),
        fromAngle: currentAngle,
        fromBodyAngle: currentBodyAngle,
        toAngle: finite(event.angle),
        toBodyAngle: finite(event.bodyAngle),
      };
    }

    const now = this.monotonicSeconds();
    const startRaw = advance(now);
    item.angleOverride = events.length > 0;
    item.angle = currentAngle;
    item.bodyAngle = currentBodyAngle;
    if (tweenState) {
      const remaining = Math.max(0, tweenState.endSeconds - now);
      void this.tweenCharacterAngle(item, tweenState.toAngle, tweenState.toBodyAngle, remaining, {
        fromAngle: tweenState.fromAngle,
        fromBodyAngle: tweenState.fromBodyAngle,
        startRaw,
      });
    }
  }

  moveCharacter(
    positionType: number,
    delta: { x?: number; y?: number; z?: number },
    duration = 0,
    easeValue: unknown = "OutQuad",
  ): Promise<void> {
    const offset = this.stageOffsetInternal(positionType);
    const start = { ...offset };
    const end = {
      x: start.x + finite(delta.x),
      y: start.y + finite(delta.y),
      z: start.z + finite(delta.z),
    };
    return this.runTween({
      duration,
      ease: resolveEase(easeValue, this.runtime.focusEase),
      update: (progress) => {
        offset.x = lerp(start.x, end.x, progress);
        offset.y = lerp(start.y, end.y, progress);
        offset.z = lerp(start.z, end.z, progress);
        this.refreshStageNodes();
      },
    });
  }

  /** Move one controller through authored 3D world space without affecting its slot peers. */
  moveCharacterToWorld(
    target: string,
    position: { x: number; y: number; z: number },
    positionType: number,
    duration = 0,
    easeValue: unknown = "OutQuad",
  ): Promise<void> {
    const destination = worldPosition(position);
    if (!destination) return Promise.resolve();
    const item = this.characterItems.get(target) || this.cachedCharacterController(target);
    if (!item) {
      const pending = this.pendingCharacterPlacements.get(target);
      if (pending && pending.token === this.characterLoadTokens.get(target)) {
        this.pendingCharacterWorldPositions.set(target, {
          token: pending.token,
          positionType: Number(positionType) || pending.positionType || 5,
          position: destination,
        });
      }
      return Promise.resolve();
    }
    const destinationPosition = Number(positionType) || item.positionType || 5;
    let start = this.characterAuthoredWorldPosition(item);
    if (destinationPosition !== item.positionType) {
      const destinationParent = this.stageNode(destinationPosition);
      this.applyTransforms();
      this.scene.updateMatrixWorld(true);
      destinationParent.attach(item.node);
      const local = threeVector3ToUnity(item.node.position, this.placementUnityPosition);
      const field = this.fieldPosition("character", { x: 0, y: 0, z: 0 });
      const stage = this.stagePoint(destinationPosition);
      const fieldScale = this.fieldScale("character");
      start = {
        x: field.x + stage.x + local.x * fieldScale - item.offset.x,
        y: field.y + stage.y + local.y * fieldScale - item.offset.y,
        z: field.z + stage.z + local.z * fieldScale - item.offset.z,
      };
    }
    item.worldPosition = { ...start };
    item.positionType = destinationPosition;
    this.layoutCharacter(item);
    const update = (progress: number): void => {
      if (!item.worldPosition) item.worldPosition = { ...start };
      item.worldPosition.x = lerp(start.x, destination.x, progress);
      item.worldPosition.y = lerp(start.y, destination.y, progress);
      item.worldPosition.z = lerp(start.z, destination.z, progress);
      this.layoutCharacter(item);
    };
    if (duration <= 0) {
      update(1);
      return Promise.resolve();
    }
    return this.runTween({
      duration,
      ease: resolveEase(easeValue, this.runtime.focusEase),
      update,
    });
  }

  async setRendererCharacterBrightness(
    targetName: string,
    value: number,
    duration = 0,
    positionType = 0,
  ): Promise<void> {
    const entryPosition = Number(positionType) || this.characterItems.get(targetName)?.positionType || 0;
    const ownershipKey = `entry:${entryPosition}`;
    const item = this.characterItems.get(targetName);
    if (!item) {
      const token = this.characterLoadTokens.get(targetName);
      const seconds = Math.max(0, finite(duration));
      if (
        token != null &&
        this.pendingCharacterCommands.queueBrightness(targetName, token, {
          route: "renderer",
          positionType: entryPosition,
          value: clamp(value),
          durationSeconds: seconds,
          queuedAtSeconds: this.monotonicSeconds(),
        })
      ) {
        const controller = this.replaceCharacterTweenController(this.characterBrightnessTweenControllers, ownershipKey);
        try {
          await this.runTween({ duration: seconds, signal: controller.signal });
        } finally {
          this.releaseCharacterTweenController(this.characterBrightnessTweenControllers, ownershipKey, controller);
        }
      }
      return;
    }
    await this.tweenRendererCharacterBrightness(item, value, duration, undefined, undefined, ownershipKey);
  }

  private async tweenRendererCharacterBrightness(
    item: StoryCharacter,
    value: number,
    duration = 0,
    resumed?: { readonly from: number; readonly startRaw: number },
    existingController?: AbortController,
    ownershipKey = `entry:${item.positionType}`,
  ): Promise<void> {
    const controller =
      existingController ||
      this.replaceCharacterTweenController(this.characterBrightnessTweenControllers, ownershipKey);
    const ownsController = !existingController;
    const from = resumed?.from ?? item.brightness;
    const startRaw = clamp(resumed?.startRaw ?? 0);
    const ease = resolveEase(6);
    try {
      await this.runTween({
        duration,
        signal: controller.signal,
        update: (_progress, rawProgress) => {
          const originalRaw = lerp(startRaw, 1, rawProgress);
          item.brightness = lerp(from, clamp(value), ease(originalRaw));
        },
      });
    } finally {
      if (ownsController) {
        this.releaseCharacterTweenController(this.characterBrightnessTweenControllers, ownershipKey, controller);
      }
    }
  }

  /** Live2DCharacterController.SetBrightness: current-value lerp, no per-property cancellation. */
  async setBrightness(targetName: string, value: number, duration = 0): Promise<void> {
    const target = clamp(value);
    const seconds = Math.max(0, finite(duration));
    const item = this.cachedCharacterController(targetName);
    if (!item) {
      const token = this.selectedPendingCharacterToken(targetName);
      if (
        token != null &&
        this.pendingCharacterCommands.queueBrightness(targetName, token, {
          route: "direct",
          value: target,
          durationSeconds: seconds,
          queuedAtSeconds: this.monotonicSeconds(),
        })
      ) {
        await this.runTween({ duration: seconds });
      }
      return;
    }
    await this.tweenDirectCharacterBrightness(item, target, seconds);
  }

  private tweenDirectCharacterBrightness(
    item: StoryCharacter,
    value: number,
    duration: number,
    startRaw = 0,
  ): Promise<void> {
    const initialRaw = clamp(startRaw);
    return this.runTween({
      duration,
      update: (_progress, raw) => {
        const originalRaw = lerp(initialRaw, 1, raw);
        item.brightness = lerp(item.brightness, clamp(value), originalRaw);
      },
    });
  }

  private restorePendingBrightness(item: StoryCharacter, events: readonly PendingCharacterBrightness[]): void {
    const targetFrameRate = Math.max(1, finite(this.runtime.targetFrameRate, 45));
    const frameSeconds = 1 / targetFrameRate;
    let current = 1;
    let renderer: {
      readonly event: PendingCharacterBrightness;
      readonly from: number;
      nextFrameSeconds: number;
    } | null = null;
    const direct: Array<{ readonly event: PendingCharacterBrightness; nextFrameSeconds: number }> = [];
    const advance = (untilSeconds: number): void => {
      while (true) {
        const nextSeconds = Math.min(
          renderer?.nextFrameSeconds ?? Number.POSITIVE_INFINITY,
          ...direct.map((entry) => entry.nextFrameSeconds),
        );
        if (!Number.isFinite(nextSeconds) || nextSeconds > untilSeconds) break;
        if (renderer && renderer.nextFrameSeconds <= nextSeconds) {
          const duration = Math.max(0, renderer.event.durationSeconds);
          const raw = duration <= 0 ? 1 : clamp((nextSeconds - renderer.event.queuedAtSeconds) / duration);
          current = lerp(renderer.from, clamp(renderer.event.value), resolveEase(6)(raw));
          if (raw >= 1) renderer = null;
          else renderer.nextFrameSeconds += frameSeconds;
        }
        for (let index = 0; index < direct.length;) {
          const entry = direct[index];
          if (entry.nextFrameSeconds > nextSeconds) {
            index += 1;
            continue;
          }
          const duration = Math.max(0, entry.event.durationSeconds);
          const raw = duration <= 0 ? 1 : clamp((nextSeconds - entry.event.queuedAtSeconds) / duration);
          current = lerp(current, clamp(entry.event.value), raw);
          if (raw >= 1) direct.splice(index, 1);
          else {
            entry.nextFrameSeconds += frameSeconds;
            index += 1;
          }
        }
      }
    };

    for (const event of events) {
      advance(event.queuedAtSeconds);
      const duration = Math.max(0, event.durationSeconds);
      if (duration <= 0) {
        current = clamp(event.value);
        if (event.route === "renderer") renderer = null;
      } else if (event.route === "renderer") {
        renderer = { event, from: current, nextFrameSeconds: event.queuedAtSeconds + frameSeconds };
      } else {
        direct.push({ event, nextFrameSeconds: event.queuedAtSeconds + frameSeconds });
      }
    }

    const now = this.monotonicSeconds();
    advance(now);
    item.brightness = current;
    if (renderer) {
      const duration = Math.max(0, renderer.event.durationSeconds);
      const elapsed = Math.max(0, now - renderer.event.queuedAtSeconds);
      const ownershipKey = `entry:${Number(renderer.event.positionType) || item.positionType}`;
      const controller = this.characterBrightnessTweenControllers.get(ownershipKey);
      void this.tweenRendererCharacterBrightness(
        item,
        clamp(renderer.event.value),
        Math.max(0, duration - elapsed),
        { from: renderer.from, startRaw: clamp(elapsed / duration) },
        controller,
        ownershipKey,
      );
    }
    for (const entry of direct) {
      const duration = Math.max(0, entry.event.durationSeconds);
      const elapsed = Math.max(0, now - entry.event.queuedAtSeconds);
      void this.tweenDirectCharacterBrightness(
        item,
        clamp(entry.event.value),
        Math.max(0, duration - elapsed),
        clamp(elapsed / duration),
      );
    }
  }

  async setPositionBrightness(positionType: number, value: number, duration = 0): Promise<void> {
    const item = this.characterAtPosition(positionType);
    if (item) await this.setRendererCharacterBrightness(item.target, value, duration, Number(positionType) || 0);
  }

  setBackgroundBrightness(value: number, duration = 0): Promise<void> {
    return this.tweenBackgroundBrightness(value, duration);
  }

  private async tweenBackgroundBrightness(value: number, duration = 0): Promise<void> {
    const from = this.fieldRendererState.brightness;
    const target = clamp(value, 0, 1);
    await this.runTween({
      duration,
      // DOTweenModuleSprite.DOColor uses DOTween's default OutQuad ease.
      ease: resolveEase(6),
      update: (progress) => {
        this.fieldRendererState.brightness = lerp(from, target, progress);
        this.applyTransforms();
      },
    });
  }

  async setBackgroundDoF(
    intensity: number,
    duration = 0,
    easeValue: unknown = "OutQuad",
    signal?: AbortSignal,
  ): Promise<void> {
    if (!this.qualityConfig.isBackgroundBlurEnabled()) return;
    const controller = this.replaceBackgroundBlurTweenController();
    const unbind = this.bindControllerToSignal(controller, signal);
    const version = ++this.backgroundBlurTweenVersion;
    const from = this.fieldRendererState.backgroundBlur;
    try {
      await this.runTween({
        duration,
        signal: controller.signal,
        ease: resolveEase(easeValue, this.runtime.focusEase),
        update: (progress) => {
          if (version !== this.backgroundBlurTweenVersion) return;
          // SetBackgroundBlurAsync clamps the requested intensity to [0,1]
          // before applying the quality gate.
          this.fieldRendererState.backgroundBlur = lerp(from, clamp(intensity), progress);
          this.syncFieldPostEffects();
        },
      });
    } finally {
      unbind();
      if (this.backgroundBlurTweenController === controller) this.backgroundBlurTweenController = null;
    }
  }

  async setCharacterDoF(
    targetName: string,
    intensity: number,
    duration = 0,
    easeValue: unknown = "OutQuad",
    signal?: AbortSignal,
  ): Promise<void> {
    if (!this.qualityConfig.isCharacterBlurEnabled()) return;
    const item = this.characterItems.get(targetName);
    if (!item) {
      const token = this.characterLoadTokens.get(targetName);
      const seconds = Math.max(0, finite(duration));
      if (
        token != null &&
        this.pendingCharacterCommands.queueDoF(targetName, token, {
          kind: "set",
          intensity: clamp(intensity),
          durationSeconds: seconds,
          ease: easeValue,
          queuedAtSeconds: this.monotonicSeconds(),
        })
      ) {
        const controller = this.replaceCharacterTweenController(this.characterBlurTweenControllers, targetName);
        const unbind = this.bindControllerToSignal(controller, signal);
        try {
          await this.runTween({ duration: seconds, signal: controller.signal });
        } finally {
          unbind();
          this.releaseCharacterTweenController(this.characterBlurTweenControllers, targetName, controller);
        }
      }
      return;
    }
    await this.tweenCharacterDoF(item, intensity, duration, easeValue, undefined, undefined, signal);
  }

  cancelPendingCharacterDoF(targetName: string): void {
    const token = this.characterLoadTokens.get(targetName);
    if (token != null) {
      this.pendingCharacterCommands.queueDoFCancel(targetName, token, this.monotonicSeconds());
    }
  }

  private async tweenCharacterDoF(
    item: StoryCharacter,
    intensity: number,
    duration: number,
    easeValue: unknown,
    resumed?: { readonly from: number; readonly startRaw: number },
    existingController?: AbortController,
    signal?: AbortSignal,
  ): Promise<void> {
    const targetName = item.target;
    const controller =
      existingController || this.replaceCharacterTweenController(this.characterBlurTweenControllers, targetName);
    const ownsController = !existingController;
    const unbind = ownsController ? this.bindControllerToSignal(controller, signal) : () => {};
    const version = (this.characterBlurTweenVersions.get(targetName) || 0) + 1;
    this.characterBlurTweenVersions.set(targetName, version);
    const from = resumed?.from ?? item.blurIntensity;
    const startRaw = clamp(resumed?.startRaw ?? 0);
    const ease = resolveEase(easeValue, this.runtime.focusEase);
    try {
      await this.runTween({
        duration,
        signal: controller.signal,
        update: (_progress, raw) => {
          if (version !== this.characterBlurTweenVersions.get(targetName)) return;
          // SetCharacterBlurAsync applies the same [0,1] clamp.
          const originalRaw = startRaw + (1 - startRaw) * raw;
          item.blurIntensity = lerp(from, clamp(intensity), ease(originalRaw));
        },
      });
    } finally {
      unbind();
      if (ownsController) {
        this.releaseCharacterTweenController(this.characterBlurTweenControllers, targetName, controller);
      }
    }
  }

  private restorePendingDoF(item: StoryCharacter, events: readonly PendingCharacterDoF[]): void {
    if (!this.qualityConfig.isCharacterBlurEnabled()) return;
    let current = item.blurIntensity;
    let active: { readonly event: PendingCharacterDoFSet; readonly from: number } | null = null;
    const advance = (untilSeconds: number): void => {
      if (!active) return;
      const duration = Math.max(0, active.event.durationSeconds);
      const elapsed = Math.max(0, untilSeconds - active.event.queuedAtSeconds);
      const progress = duration <= 0 ? 1 : clamp(elapsed / duration);
      const ease = resolveEase(active.event.ease, this.runtime.focusEase);
      current = lerp(active.from, clamp(active.event.intensity), ease(progress));
      if (progress >= 1) active = null;
    };

    for (const event of events) {
      advance(event.queuedAtSeconds);
      if (event.kind === "cancel") {
        active = null;
        continue;
      }
      const duration = Math.max(0, event.durationSeconds);
      if (duration <= 0) {
        current = clamp(event.intensity);
        active = null;
      } else {
        active = { event, from: current };
      }
    }

    const now = this.monotonicSeconds();
    advance(now);
    item.blurIntensity = current;
    if (!active) return;
    const duration = Math.max(0, active.event.durationSeconds);
    const elapsed = Math.max(0, now - active.event.queuedAtSeconds);
    const startRaw = clamp(elapsed / duration);
    const controller = this.characterBlurTweenControllers.get(item.target);
    void this.tweenCharacterDoF(
      item,
      clamp(active.event.intensity),
      Math.max(0, duration - elapsed),
      active.event.ease,
      { from: active.from, startRaw },
      controller,
    );
  }

  private restorePendingAlpha(item: StoryCharacter, events: readonly PendingCharacterAlphaEvent[]): void {
    const latest = events.at(-1);
    if (!latest) return;
    this.characterAlphaOperations.set(item.target, latest.operationId);
    const now = this.monotonicSeconds();
    const duration = Math.max(0, latest.durationSeconds);
    const elapsed = latest.startedAtSeconds == null ? 0 : Math.max(0, now - latest.startedAtSeconds);
    const startRaw = latest.startedAtSeconds == null ? 0 : duration <= 0 ? 1 : clamp(elapsed / duration);
    item.alpha = lerp(latest.from, clamp(latest.value), startRaw);
    if (latest.startedAtSeconds == null || startRaw >= 1) return;
    void this.fadeCharacterLifecycle(item, latest.from, clamp(latest.value), Math.max(0, duration - elapsed), {
      delayFrames: 0,
      startRaw,
    });
  }

  private restorePendingRimLight(item: StoryCharacter, events: readonly PendingCharacterRimLightEvent[]): void {
    for (const event of events) {
      item.rimLight = {
        enabled: !item.rimLight.enabled,
        color: { ...event.color },
        shadowIntensity: event.shadowIntensity,
      };
    }
  }

  setRimLight(targetName: string, colorValue: unknown, shadowIntensity: number): Promise<void> {
    const item = this.cachedCharacterController(targetName);
    const event: PendingCharacterRimLightEvent = {
      color: unityHtmlColor(colorValue),
      shadowIntensity: finite(shadowIntensity),
    };
    if (!item) {
      const token = this.selectedPendingCharacterToken(targetName);
      if (token != null) this.pendingCharacterCommands.queueRimLight(targetName, token, event);
      return Promise.resolve();
    }
    item.rimLight = {
      enabled: !item.rimLight.enabled,
      color: { ...event.color },
      shadowIntensity: event.shadowIntensity,
    };
    return Promise.resolve();
  }

  startTimedPseudoLipSync(targets: string[] | string, talkLength: number, speed = 1, multiplier = 1): void {
    this.startTimedPseudoLipSyncSeconds(
      targets,
      Math.max(0, Math.trunc(finite(talkLength))) * PSEUDO_LIP_UNIT_TIME,
      speed,
      multiplier,
    );
  }

  startTimedHoldOpenPseudoLipSync(
    targets: string[] | string,
    mouthOpening: number,
    talkLength: number,
    speed = 1,
  ): void {
    const durationSeconds = Math.max(0, Math.trunc(finite(talkLength))) * PSEUDO_LIP_UNIT_TIME;
    const resolvedSpeed = Math.max(0.001, finite(speed, 1));
    const resolvedMouthOpening = finite(mouthOpening, 1) || 1;
    const queuedAtSeconds = this.monotonicSeconds();
    for (const target of Array.isArray(targets) ? targets : [targets]) {
      const item = this.cachedCharacterController(target);
      if (item) {
        this.applyTimedLipSync(item, durationSeconds, resolvedSpeed, 1, "hold-open", resolvedMouthOpening);
        continue;
      }
      const token = this.selectedPendingCharacterToken(target);
      if (token != null) {
        this.pendingCharacterCommands.queueLipSync(target, token, {
          source: "timed",
          timedMode: "hold-open",
          holdOpenLevel: resolvedMouthOpening,
          durationSeconds,
          speed: resolvedSpeed,
          multiplier: 1,
          queuedAtSeconds,
        });
      }
    }
  }

  startTimedPseudoLipSyncSeconds(targets: string[] | string, seconds: number, speed = 1, multiplier = 1): void {
    const durationSeconds = Math.max(0, finite(seconds));
    const resolvedSpeed = Math.max(0.001, finite(speed, 1));
    const resolvedMultiplier = Math.max(0, finite(multiplier, 1));
    const queuedAtSeconds = this.monotonicSeconds();
    for (const target of Array.isArray(targets) ? targets : [targets]) {
      const item = this.cachedCharacterController(target);
      if (item) {
        this.applyTimedLipSync(item, durationSeconds, resolvedSpeed, resolvedMultiplier);
        continue;
      }
      const token = this.selectedPendingCharacterToken(target);
      if (token != null) {
        this.pendingCharacterCommands.queueLipSync(target, token, {
          source: "timed",
          timedMode: "oscillating",
          durationSeconds,
          speed: resolvedSpeed,
          multiplier: resolvedMultiplier,
          queuedAtSeconds,
        });
      }
    }
  }

  startVoiceLipSync(
    targets: string[] | string,
    voiceEntries: unknown[],
    duration: number,
    speed = 1,
    multiplier = 1,
  ): boolean {
    const sources = voiceEntries.filter(Boolean) as VoiceAnalysisSource[];
    if (!sources.length) return false;
    const durationSeconds = Math.max(0, finite(duration));
    const resolvedSpeed = Math.max(0.001, finite(speed, 1));
    const resolvedMultiplier = Math.max(0, finite(multiplier, 1));
    const queuedAtSeconds = this.monotonicSeconds();
    let started = false;
    for (const target of Array.isArray(targets) ? targets : [targets]) {
      const item = this.cachedCharacterController(target);
      if (item) {
        this.applyVoiceLipSync(item, sources, durationSeconds, resolvedSpeed, resolvedMultiplier);
        started = true;
        continue;
      }
      const token = this.selectedPendingCharacterToken(target);
      if (
        token != null &&
        this.pendingCharacterCommands.queueLipSync(target, token, {
          source: "voice",
          sources,
          voiceSpeed: resolvedSpeed,
          voiceMultiplier: resolvedMultiplier,
          voiceExpiresAtSeconds: queuedAtSeconds + durationSeconds / resolvedSpeed,
          durationSeconds,
          speed: resolvedSpeed,
          multiplier: resolvedMultiplier,
          queuedAtSeconds,
        })
      ) {
        started = true;
      }
    }
    return started;
  }

  private monotonicSeconds(): number {
    return (globalThis.performance?.now?.() ?? Date.now()) / 1000;
  }

  private applyTimedLipSync(
    item: StoryCharacter,
    seconds: number,
    speed: number,
    multiplier: number,
    timedMode: "oscillating" | "hold-open" = "oscillating",
    holdOpenLevel = 0,
  ): void {
    Object.assign(item.lipSync, {
      enabled: true,
      source: "timed",
      timedMode,
      holdOpenLevel,
      timedRemaining: Math.max(0, finite(seconds)),
      stopRemaining: 0,
      speed: Math.max(0.001, finite(speed, 1)),
      multiplier: Math.max(0, finite(multiplier, 1)),
      mouthForm: 0,
      motionSyncPcm: null,
    });
  }

  private restoreTimedLipSyncAtTime(
    item: StoryCharacter,
    pending: PendingCharacterLipSync,
    pauseEvents: readonly PendingCharacterPauseEvent[],
    now: number,
  ): void {
    if (pending.sources?.length) item.lipSync.sources = [...pending.sources] as VoiceAnalysisSource[];
    item.lipSync.voiceSpeed = Math.max(0.001, finite(pending.voiceSpeed, 1));
    item.lipSync.voiceMultiplier = Math.max(0, finite(pending.voiceMultiplier, 1));
    item.lipSync.voiceExpiresAtSeconds = Math.max(0, finite(pending.voiceExpiresAtSeconds));
    const duration = Math.max(0, pending.durationSeconds);
    this.applyTimedLipSync(
      item,
      duration,
      pending.speed,
      pending.multiplier,
      pending.timedMode ?? "oscillating",
      finite(pending.holdOpenLevel),
    );
    const frameSeconds = 1 / Math.max(1, finite(this.runtime.targetFrameRate, 45));
    const start = pending.queuedAtSeconds;
    let paused = false;
    let playbackRate = 1;
    for (const event of pauseEvents) {
      if (event.queuedAtSeconds <= start) paused = event.paused;
    }
    for (const event of this.playbackSpeedEvents) {
      if (event.queuedAtSeconds <= start) playbackRate = event.rate;
    }
    const events = [
      ...pauseEvents
        .filter((event) => event.queuedAtSeconds > start && event.queuedAtSeconds <= now)
        .map((event) => ({ ...event, kind: "pause" as const })),
      ...this.playbackSpeedEvents
        .filter((event) => event.queuedAtSeconds > start && event.queuedAtSeconds <= now)
        .map((event) => ({ ...event, kind: "speed" as const })),
    ].sort((left, right) => left.queuedAtSeconds - right.queuedAtSeconds);
    let eventIndex = 0;
    // Replay complete native update frames only. In particular, do not use a
    // duration+tail continuous threshold: the crossing frame arms the close
    // tail without consuming it, which is observably one-frame later.
    for (let frameTime = start + frameSeconds; frameTime <= now + 1e-9; frameTime += frameSeconds) {
      while (eventIndex < events.length && events[eventIndex].queuedAtSeconds <= frameTime) {
        const event = events[eventIndex++];
        if (event.kind === "pause") paused = event.paused;
        else playbackRate = event.rate;
      }
      if (!paused) this.advanceTimedLipSyncFrame(item, frameSeconds, playbackRate);
      if (item.lipSync.source !== "timed") break;
    }
  }

  private applyVoiceLipSync(
    item: StoryCharacter,
    sources: VoiceAnalysisSource[],
    durationSeconds: number,
    speed: number,
    multiplier: number,
  ): void {
    const resolvedSpeed = Math.max(0.001, finite(speed, 1));
    const resolvedMultiplier = Math.max(0, finite(multiplier, 1));
    Object.assign(item.lipSync, {
      enabled: true,
      source: "voice",
      timedMode: "oscillating",
      holdOpenLevel: 0,
      timedRemaining: 0,
      voiceRemaining: Math.max(0, finite(durationSeconds)),
      voiceSpeed: resolvedSpeed,
      voiceMultiplier: resolvedMultiplier,
      voiceExpiresAtSeconds: this.monotonicSeconds() + Math.max(0, finite(durationSeconds)) / resolvedSpeed,
      stopRemaining: 0,
      speed: resolvedSpeed,
      multiplier: resolvedMultiplier,
      timer: 0,
      isOpen: false,
      mouthOpenY: 0,
      mouthForm: 0,
      motionSyncPcm: null,
      dampVelocity: { value: 0 },
      sources,
    });
    this.invokeCharacterModel(item, "start voice motion sync", undefined, (model) => model.resetMotionSync());
  }

  private restorePendingLipSync(
    item: StoryCharacter,
    pending: PendingCharacterLipSync,
    pauseEvents: readonly PendingCharacterPauseEvent[],
  ): void {
    const now = this.monotonicSeconds();
    if (pending.source === "timed") {
      this.restoreTimedLipSyncAtTime(item, pending, pauseEvents, now);
      return;
    }

    // The CRI/Howl voice player keeps advancing while the character animation
    // is paused or covered by timed pseudo lip-sync. Use its wall-clock
    // deadline rather than freezing an artificial controller countdown.
    const voiceSpeed = Math.max(0.001, finite(pending.voiceSpeed, pending.speed));
    const voiceMultiplier = Math.max(0, finite(pending.voiceMultiplier, pending.multiplier));
    const expiresAt = finite(
      pending.voiceExpiresAtSeconds,
      pending.queuedAtSeconds + Math.max(0, pending.durationSeconds) / voiceSpeed,
    );
    const remaining = Math.max(0, (expiresAt - now) * voiceSpeed);
    const sources = (pending.sources || []).filter(Boolean) as VoiceAnalysisSource[];
    if (sources.length) {
      this.applyVoiceLipSync(item, sources, remaining, voiceSpeed, voiceMultiplier);
    }
  }

  stopTimedPseudoLipSync(targets: string[] | string): void {
    for (const target of Array.isArray(targets) ? targets : [targets]) {
      const token = this.selectedPendingCharacterToken(target);
      if (token != null) this.pendingCharacterCommands.clearTimedLipSync(target, token);
      const item = this.cachedCharacterController(target);
      if (!item || item.lipSync.source !== "timed") continue;
      // Live2DLipSyncController.StopTimedPseudoLipSync does not run the
      // natural 0.3 s timeout release. For TimedPseudo/HoldOpen it clears the
      // timer, immediately returns to the available voice mode and refreshes
      // the mouth controller. The 0.3 s close is exclusive to a timer that
      // expires naturally in OnLateUpdate.
      this.stopTimedLipSyncNow(item);
    }
  }

  stopAllTimedPseudoLipSync(): void {
    this.pendingCharacterCommands.clearAllTimedLipSync();
    for (const item of this.characterItems.values()) {
      if (item.lipSync.source === "timed") this.stopTimedLipSyncNow(item);
    }
  }

  /** StopTimedPseudoLipSync switches mode without calling ResetLip. */
  private stopTimedLipSyncNow(item: StoryCharacter): void {
    this.leaveTimedLipSync(item);
  }

  private leaveTimedLipSync(item: StoryCharacter): void {
    const voiceSpeed = Math.max(0.001, item.lipSync.voiceSpeed);
    Object.assign(item.lipSync, {
      // Native chooses LipMode 1/2 from controller configuration here; it
      // never disables merely because no browser voice source is bound.
      enabled: true,
      source: "voice",
      timedRemaining: 0,
      voiceRemaining: Math.max(0, (item.lipSync.voiceExpiresAtSeconds - this.monotonicSeconds()) * voiceSpeed),
      stopRemaining: 0,
      speed: voiceSpeed,
      multiplier: item.lipSync.voiceMultiplier,
      motionSyncPcm: null,
    });
  }

  stopSpeaking(targets: string[] | string): void {
    for (const target of Array.isArray(targets) ? targets : [targets]) {
      const token = this.selectedPendingCharacterToken(target);
      if (token != null) this.pendingCharacterCommands.clearLipSync(target, token);
      const item = this.cachedCharacterController(target);
      if (item) this.resetLipSync(item);
    }
  }

  stopAllSpeaking(): void {
    this.pendingCharacterCommands.clearAllLipSync();
    for (const item of this.characterItems.values()) this.resetLipSync(item);
  }

  private currentFocusDataTable(): readonly AdvFocusDataRow[] {
    return (
      FOCUS_DATA_BY_KEY[this.focusDataSettingsKey] || this.runtime.focusData || FOCUS_DATA_BY_KEY["Settings-Default"]
    );
  }

  currentFocusData(distance: number): AdvFocusDataRow | null {
    const target = clampCameraDistance(Math.round(finite(distance)));
    return this.currentFocusDataTable().find((row) => row.cameraDistance === target) || null;
  }

  closestFocusDataByZoomRatio(ratio: number): AdvFocusDataRow | null {
    const rows = this.currentFocusDataTable();
    if (!rows.length) return null;
    const value = finite(ratio, 1);
    return rows.reduce((best, row) =>
      Math.abs(row.fieldZoomRatio - value) < Math.abs(best.fieldZoomRatio - value) ? row : best,
    );
  }

  private characterHeadWorldPosition(item: StoryCharacter): Vec3 {
    const authoredHead = item.entry.profile?.anchors?.head?.position;
    if (authoredHead) {
      return computeAdvCharacterHeadWorldPosition(item.node, vec3(authoredHead, ZERO_VEC3));
    }
    const bounds = this.invokeCharacterModel(
      item,
      "read character bounds",
      { x: -0.5, y: -1, width: 1, height: 2 },
      (model) => model.drawableBounds(true) || model.canvasBounds(),
    );
    return computeAdvCharacterHeadWorldPosition(item.node, {
      x: bounds.x + bounds.width / 2,
      y: bounds.y + bounds.height,
      z: 0,
    });
  }

  private pendingCharacterHeadWorldPosition(target: string): Vec3 | null {
    const staged = this.stagedCharacterItems.get(target);
    if (staged && staged.token === this.characterLoadTokens.get(target)) {
      this.applyTransforms();
      return this.characterHeadWorldPosition(staged.item);
    }

    const pending = this.pendingCharacterPlacements.get(target);
    if (!pending || pending.token !== this.characterLoadTokens.get(target)) return null;
    const head = pending.entry.profile?.anchors?.head?.position;
    if (!head) return null;
    const pendingWorld = this.pendingCharacterWorldPositions.get(target);
    const positionType = pendingWorld?.token === pending.token ? pendingWorld.positionType : pending.positionType;
    const authoredWorld = pendingWorld?.token === pending.token ? pendingWorld.position : pending.worldPosition;
    const stage = this.stageNode(positionType);
    this.applyTransforms();
    const node = new Object3D();
    const profile = pending.entry.profile || {};
    const basePosition = vec3(profile.basePosition, { x: 0, y: -0.41, z: 0 });
    const scale = Math.max(0.001, finite(profile.baseScale, 1.6));
    if (authoredWorld) {
      const fieldPosition = this.fieldPosition("character", { x: 0, y: 0, z: 0 });
      const stagePosition = this.stagePoint(positionType);
      const fieldScale = this.fieldScale("character");
      basePosition.x = (authoredWorld.x - fieldPosition.x - stagePosition.x) / fieldScale;
      basePosition.y = (authoredWorld.y - fieldPosition.y - stagePosition.y) / fieldScale;
      basePosition.z = (authoredWorld.z - fieldPosition.z - stagePosition.z) / fieldScale;
    }
    unityVector3(
      {
        x: basePosition.x,
        y: basePosition.y,
        z: basePosition.z,
      },
      node.position,
    );
    node.scale.setScalar(scale);
    stage.add(node);
    try {
      return computeAdvCharacterHeadWorldPosition(node, vec3(head, { x: 0, y: 0, z: 0 }));
    } finally {
      node.removeFromParent();
    }
  }

  private characterHeadWorldPositionAtPosition(positionType: number, targetName?: string): Vec3 | null {
    if (targetName !== undefined) {
      // AdvPlaybackSession.TryGetPositionTypeToCharacter, not the renderer's
      // showing map, owns LookTarget resolution. Out leaves that mapping and
      // its cached controller alive, so a hidden character remains a valid
      // head target. Pending/staged entries are the Web-only async equivalent
      // of the already-loaded native controller.
      if (!targetName) return null;
      const pendingHead = this.pendingCharacterHeadWorldPosition(targetName);
      if (pendingHead) return pendingHead;
      const cached = this.cachedCharacterController(targetName);
      if (!cached) return null;
      this.applyTransforms();
      return this.characterHeadWorldPosition(cached);
    }
    const item = this.characterAtPosition(positionType);
    if (item) {
      this.applyTransforms();
      return this.characterHeadWorldPosition(item);
    }
    for (const [target, pending] of this.pendingCharacterPlacements) {
      if (pending.positionType !== positionType) continue;
      const head = this.pendingCharacterHeadWorldPosition(target);
      if (head) return head;
    }
    return null;
  }

  focusBaseCameraPosition(positionType: number, targetName = "", focusData: AdvFocusDataRow | null = null): Vec3 {
    const point = this.focusPointInternal(positionType);
    const namedItem = targetName ? this.characterItems.get(targetName) : null;
    const pendingHead = !namedItem && targetName ? this.pendingCharacterHeadWorldPosition(targetName) : null;
    // AdvFocusCommand resolves GetHeadPosition only after its explicit
    // TargetName succeeds in TryGetCharacterController. A position-only Focus
    // therefore keeps the authored fieldZoomOffsetY even when that slot happens
    // to contain a character.
    const item = namedItem;
    if (item) this.applyTransforms();
    return {
      x: point.x,
      y: AdvCamera.focusTargetY(
        finite(focusData?.fieldZoomOffsetY),
        item ? this.characterHeadWorldPosition(item).y : pendingHead?.y,
        finite(focusData?.characterHeadFocusOffsetY),
      ),
      z: 0,
    };
  }

  private beginCameraTween(keys: readonly string[]): Record<string, number> {
    const token: Record<string, number> = {};
    for (const key of keys) {
      const next = (this.cameraTweenVersions[key] || 0) + 1;
      this.cameraTweenVersions[key] = next;
      token[key] = next;
    }
    return token;
  }

  private ownsCameraTween(token: Readonly<Record<string, number>>, key: string): boolean {
    return token[key] === this.cameraTweenVersions[key];
  }

  private fieldRendererValuesForDistance(distance: number) {
    const index = clampCameraDistance(Math.round(finite(distance)));
    const focus = this.currentFocusData(index);
    return {
      distance: index,
      blurRadiusMax: finite(this.runtime.fieldRenderer.blurRadiusMaxByCameraDistance[index], 0.75),
      curvedLensRate: finite(this.runtime.fieldRenderer.curvedLensIntensityRateByCameraDistance[index], 1),
      backgroundBlur: this.qualityConfig.isBackgroundBlurEnabled() ? clamp(focus?.backgroundBlurIntensity) : 0,
      characterBlur: this.qualityConfig.isCharacterBlurEnabled() ? clamp(focus?.characterBlurIntensity) : 0,
    };
  }

  focus({
    positionType = 5,
    targetName = "",
    cameraDistance = 0,
    duration = 0,
    ease = "OutQuad",
    signal,
  }: {
    positionType?: number;
    targetName?: string;
    cameraDistance?: number;
    duration?: number;
    ease?: unknown;
    signal?: AbortSignal;
  }): Promise<void> {
    const session = this.state.session as { tryGetTargetNameToPositionType?: (name: string) => number } | null;
    const position = AdvCamera.focusCommandPositionType(
      positionType,
      targetName,
      (name) => session?.tryGetTargetNameToPositionType?.(name) || 0,
    );
    const distance = clampCameraDistance(cameraDistance);
    const focusData = this.currentFocusData(distance);
    const targetBase = this.focusBaseCameraPosition(position, targetName, focusData);
    const rendererTarget = this.fieldRendererValuesForDistance(distance);
    const startCamera = { ...this.cameraState };
    const startRenderer = { ...this.fieldRendererState };
    this.cancelBackgroundBlurTween();
    const backgroundBlurVersion = ++this.backgroundBlurTweenVersion;
    const characterBlurTweens = [...this.characterItems.values()].map((item) => {
      this.cancelCharacterBlurTween(item.target);
      const version = (this.characterBlurTweenVersions.get(item.target) || 0) + 1;
      this.characterBlurTweenVersions.set(item.target, version);
      return {
        item,
        version,
        from: item.blurIntensity,
        to: item.positionType === position ? 0 : rendererTarget.characterBlur,
      };
    });
    const token = this.beginCameraTween([
      "focusMeta",
      "baseX",
      "baseY",
      "baseZ",
      "rotationY",
      "stageRotationY",
      "zoomRatio",
      "panOffsetX",
      "panOffsetY",
      "renderer",
    ]);
    return this.runTween({
      duration,
      ease: resolveEase(ease, this.runtime.focusEase),
      signal,
      update: (progress) => {
        if (this.ownsCameraTween(token, "focusMeta")) {
          this.cameraState.focusPositionType = position;
          this.cameraState.focusTargetName = targetName;
        }
        if (this.ownsCameraTween(token, "baseX"))
          this.cameraState.baseX = lerp(startCamera.baseX, targetBase.x, progress);
        if (this.ownsCameraTween(token, "baseY"))
          this.cameraState.baseY = lerp(startCamera.baseY, targetBase.y, progress);
        if (this.ownsCameraTween(token, "baseZ"))
          this.cameraState.baseZ = lerp(startCamera.baseZ, targetBase.z, progress);
        if (this.ownsCameraTween(token, "rotationY"))
          this.cameraState.rotationY = lerp(startCamera.rotationY, 0, progress);
        if (this.ownsCameraTween(token, "stageRotationY"))
          this.cameraState.stageRotationY = lerp(startCamera.stageRotationY, 0, progress);
        if (this.ownsCameraTween(token, "zoomRatio"))
          this.cameraState.zoomRatio = lerp(
            startCamera.zoomRatio,
            Math.max(0.001, finite(focusData?.fieldZoomRatio, 1)),
            progress,
          );
        if (this.ownsCameraTween(token, "panOffsetX"))
          this.cameraState.panOffsetX = lerp(startCamera.panOffsetX, 0, progress);
        if (this.ownsCameraTween(token, "panOffsetY"))
          this.cameraState.panOffsetY = lerp(startCamera.panOffsetY, 0, progress);
        if (this.ownsCameraTween(token, "renderer")) {
          this.fieldRendererState.distance = lerp(startRenderer.distance, rendererTarget.distance, progress);
          this.fieldRendererState.blurRadiusMax = lerp(
            startRenderer.blurRadiusMax,
            rendererTarget.blurRadiusMax,
            progress,
          );
          this.fieldRendererState.curvedLensRate = lerp(
            startRenderer.curvedLensRate,
            rendererTarget.curvedLensRate,
            progress,
          );
          this.fieldRendererState.characterBlur = lerp(
            startRenderer.characterBlur,
            rendererTarget.characterBlur,
            progress,
          );
        }
        if (backgroundBlurVersion === this.backgroundBlurTweenVersion) {
          this.fieldRendererState.backgroundBlur = lerp(
            startRenderer.backgroundBlur,
            rendererTarget.backgroundBlur,
            progress,
          );
        }
        for (const blur of characterBlurTweens) {
          if (blur.version !== this.characterBlurTweenVersions.get(blur.item.target)) continue;
          blur.item.blurIntensity = lerp(blur.from, blur.to, progress);
        }
        this.syncFieldPostEffects();
        this.applyTransforms();
      },
    });
  }

  zoomByRatio(
    ratio: number,
    duration = 0,
    ease: unknown = "OutQuad",
    backgroundBlurOffset: number | null = null,
    adjustBackgroundBlur = true,
    signal?: AbortSignal,
  ): Promise<void> {
    const targetRatio = Math.max(0.001, finite(ratio, 1));
    const focus = this.closestFocusDataByZoomRatio(targetRatio);
    const targetRenderer = this.fieldRendererValuesForDistance(focus?.cameraDistance || 0);
    if (backgroundBlurOffset != null && this.qualityConfig.isBackgroundBlurEnabled()) {
      targetRenderer.backgroundBlur = finite(focus?.backgroundBlurIntensity) + finite(backgroundBlurOffset);
    }
    const startRatio = this.cameraState.zoomRatio;
    const startRenderer = { ...this.fieldRendererState };
    let backgroundBlurVersion = this.backgroundBlurTweenVersion;
    if (adjustBackgroundBlur) {
      this.cancelBackgroundBlurTween();
      backgroundBlurVersion = ++this.backgroundBlurTweenVersion;
    }
    const token = this.beginCameraTween(["zoomRatio", "renderer"]);
    return this.runTween({
      duration,
      ease: resolveEase(ease, this.runtime.focusEase),
      signal,
      update: (progress) => {
        if (this.ownsCameraTween(token, "zoomRatio"))
          this.cameraState.zoomRatio = lerp(startRatio, targetRatio, progress);
        if (this.ownsCameraTween(token, "renderer")) {
          this.fieldRendererState.distance = lerp(startRenderer.distance, targetRenderer.distance, progress);
          this.fieldRendererState.blurRadiusMax = lerp(
            startRenderer.blurRadiusMax,
            targetRenderer.blurRadiusMax,
            progress,
          );
          this.fieldRendererState.curvedLensRate = lerp(
            startRenderer.curvedLensRate,
            targetRenderer.curvedLensRate,
            progress,
          );
        }
        if (adjustBackgroundBlur && backgroundBlurVersion === this.backgroundBlurTweenVersion) {
          this.fieldRendererState.backgroundBlur = lerp(
            startRenderer.backgroundBlur,
            targetRenderer.backgroundBlur,
            progress,
          );
        }
        this.syncFieldPostEffects();
      },
    });
  }

  setCharacterStagesY(
    angle: number,
    duration = 0,
    easeValue: unknown = "OutQuad",
    signal?: AbortSignal,
  ): Promise<void> {
    const fieldFrom = this.cameraState.fieldRotationY;
    const target = finite(angle);
    // AdvPanCommand rotates the background/character field roots. It does not
    // rotate the SceneCamera itself (that is a separate serialized channel).
    const token = this.beginCameraTween(["fieldRotationY"]);
    return this.runTween({
      duration,
      ease: resolveEase(easeValue, this.runtime.focusEase),
      signal,
      update: (progress) => {
        if (this.ownsCameraTween(token, "fieldRotationY"))
          this.cameraState.fieldRotationY = lerp(fieldFrom, target, progress);
        this.applyTransforms();
      },
    });
  }

  setTilt(angle: number, duration = 0, easeValue: unknown = "OutQuad", signal?: AbortSignal): Promise<void> {
    const from = this.cameraState.rotationX;
    const target = finite(angle);
    const token = this.beginCameraTween(["rotationX"]);
    return this.runTween({
      duration,
      ease: resolveEase(easeValue, this.runtime.focusEase),
      signal,
      update: (progress) => {
        if (!this.ownsCameraTween(token, "rotationX")) return;
        this.cameraState.rotationX = lerp(from, target, progress);
        this.applyTransforms();
      },
    });
  }

  panFocusDistance(focusPosition: { z?: number }): number {
    return Math.abs(this.fieldPosition("character", this.scratchCharacterPosition).z - finite(focusPosition.z));
  }

  panV2CameraOffset(rotationY: number, distance: number, focusSlideRate: number): Vec2 {
    const radians = finite(rotationY) * DEG_TO_RAD;
    const radiusRate = 1 - finite(focusSlideRate, 0.5);
    return {
      x: -radiusRate * finite(distance) * Math.sin(radians),
      y: radiusRate * finite(distance) * (1 - Math.cos(radians)),
    };
  }

  setPanV2CameraOffset(
    offset: { x?: number; y?: number },
    duration = 0,
    ease: unknown = "OutQuad",
    signal?: AbortSignal,
  ): Promise<void> {
    const from = { x: this.cameraState.panOffsetX, y: this.cameraState.panOffsetY };
    const target = { x: finite(offset.x), y: finite(offset.y) };
    const token = this.beginCameraTween(["panOffsetX", "panOffsetY"]);
    return this.runTween({
      duration,
      ease: resolveEase(ease, this.runtime.focusEase),
      signal,
      update: (progress) => {
        if (this.ownsCameraTween(token, "panOffsetX")) this.cameraState.panOffsetX = lerp(from.x, target.x, progress);
        if (this.ownsCameraTween(token, "panOffsetY")) this.cameraState.panOffsetY = lerp(from.y, target.y, progress);
      },
    });
  }

  setPanV2BaseCameraPosition(
    position: { x?: number; y?: number; z?: number },
    duration = 0,
    ease: unknown = "OutQuad",
    signal?: AbortSignal,
  ): Promise<void> {
    const from = { x: this.cameraState.baseX, y: this.cameraState.baseY, z: this.cameraState.baseZ };
    const target = { x: finite(position.x), y: finite(position.y), z: finite(position.z) };
    const token = this.beginCameraTween(["baseX", "baseY", "baseZ"]);
    return this.runTween({
      duration,
      ease: resolveEase(ease, this.runtime.focusEase),
      signal,
      update: (progress) => {
        if (this.ownsCameraTween(token, "baseX")) this.cameraState.baseX = lerp(from.x, target.x, progress);
        if (this.ownsCameraTween(token, "baseY")) this.cameraState.baseY = lerp(from.y, target.y, progress);
        if (this.ownsCameraTween(token, "baseZ")) this.cameraState.baseZ = lerp(from.z, target.z, progress);
      },
    });
  }

  panV2({
    rotationY = 0,
    cameraOffset = { x: 0, y: 0 },
    duration = 0,
    ease = "OutQuad",
    signal,
  }: {
    rotationY?: number;
    cameraOffset?: { x?: number; y?: number };
    cameraDistance?: number;
    duration?: number;
    ease?: unknown;
    signal?: AbortSignal;
  }): Promise<void> {
    const from = {
      rotationY: this.cameraState.rotationY,
      stageRotationY: this.cameraState.stageRotationY,
      panOffsetX: this.cameraState.panOffsetX,
      panOffsetY: this.cameraState.panOffsetY,
    };
    // AdvPanV2 rotates both ICamera.RotateY and the five character stage
    // transforms while applying the versine-derived X/Z camera offset.
    const token = this.beginCameraTween(["rotationY", "stageRotationY", "panOffsetX", "panOffsetY"]);
    return this.runTween({
      duration,
      ease: resolveEase(ease, this.runtime.focusEase),
      signal,
      update: (progress) => {
        if (this.ownsCameraTween(token, "rotationY"))
          this.cameraState.rotationY = lerp(from.rotationY, finite(rotationY), progress);
        if (this.ownsCameraTween(token, "stageRotationY"))
          this.cameraState.stageRotationY = lerp(from.stageRotationY, finite(rotationY), progress);
        if (this.ownsCameraTween(token, "panOffsetX"))
          this.cameraState.panOffsetX = lerp(from.panOffsetX, finite(cameraOffset.x), progress);
        if (this.ownsCameraTween(token, "panOffsetY"))
          this.cameraState.panOffsetY = lerp(from.panOffsetY, finite(cameraOffset.y), progress);
        this.applyTransforms();
      },
    });
  }

  private shakeScene(
    kind: "background" | "character" | "still" | "talk",
    strength: number,
    duration: number,
    vibrato: number,
    randomness: number,
    fadeOut: boolean,
  ): Promise<void> {
    // Each native target owns its own tween. A new Shake stops only a selected
    // target; disjoint layers from an earlier command continue independently.
    this.commandShakeControllers.get(kind)?.abort();
    this.resetCommandShake(kind);
    const controller = new AbortController();
    this.commandShakeControllers.set(kind, controller);
    const path = createAdvDotweenShakePath({
      duration,
      strength,
      vibrato,
      randomness,
      fadeOut,
      // AdvFieldBase receives Vector3(strength, strength, 0), while the two
      // UI views use DOShakeAnchorPos's scalar/ignore-Z overload.
      vectorBased: kind === "background" || kind === "character",
    });
    return this.runTween({
      duration,
      signal: controller.signal,
      update: (progress) => {
        if (this.commandShakeControllers.get(kind) !== controller) return;
        const { x, y } = sampleAdvDotweenShake(path, progress);
        if (kind === "background") this.backgroundShake = { x, y };
        else if (kind === "character") this.characterShake = { x, y };
        else if (kind === "still") {
          const uiScale = Math.max(0, finite(this.state.viewport.height)) / ADV_UI_REFERENCE_HEIGHT;
          this.overlay?.setStillOffset(x * uiScale, y * uiScale);
        } else {
          const uiScale = Math.max(0, finite(this.state.viewport.height)) / ADV_UI_REFERENCE_HEIGHT;
          this.state.talk.shakeX = x * uiScale;
          this.state.talk.shakeY = y * uiScale;
        }
      },
    }).finally(() => {
      if (this.commandShakeControllers.get(kind) !== controller) return;
      this.commandShakeControllers.delete(kind);
      this.resetCommandShake(kind);
    });
  }

  private resetCommandShake(kind: "background" | "character" | "still" | "talk"): void {
    if (kind === "background") this.backgroundShake = { x: 0, y: 0 };
    else if (kind === "character") this.characterShake = { x: 0, y: 0 };
    else if (kind === "still") this.overlay?.setStillOffset(0, 0);
    else {
      this.state.talk.shakeX = 0;
      this.state.talk.shakeY = 0;
    }
  }

  shakeCommand(
    fieldStrength: number,
    uiStrength: number,
    duration: number,
    vibrato: number,
    randomness: number,
    fadeOut: boolean,
    layers?: number[],
  ): Promise<void> {
    // CanvasLayers.Count == 0 is the native all-supported-layers branch.
    const layerSet = new Set((layers?.length ? layers : [0, 2, 7, 9]).map(Number));
    const tasks: Promise<void>[] = [];
    if (layerSet.has(0)) {
      tasks.push(this.shakeScene("background", fieldStrength, duration, vibrato, randomness, fadeOut));
    }
    if (layerSet.has(2)) {
      tasks.push(this.shakeScene("character", fieldStrength, duration, vibrato, randomness, fadeOut));
    }
    // AdvShakeCommand routes CanvasLayer.Still and CanvasLayer.Talk to their
    // independent UIAdvWidget shake targets. Other DOM layers are untouched.
    if (layerSet.has(7)) {
      tasks.push(this.shakeScene("still", uiStrength, duration, vibrato, randomness, fadeOut));
    }
    if (layerSet.has(9)) {
      tasks.push(this.shakeScene("talk", uiStrength, duration, vibrato, randomness, fadeOut));
    }
    return Promise.all(tasks).then(() => undefined);
  }

  private resetAllCommandShakes(): void {
    this.resetCommandShake("background");
    this.resetCommandShake("character");
    this.resetCommandShake("still");
    this.resetCommandShake("talk");
  }

  private resetShakeState(): void {
    for (const controller of this.commandShakeControllers.values()) controller.abort();
    this.commandShakeControllers.clear();
    this.resetAllCommandShakes();

    const cameraController = this.cameraShakeFadeController;
    this.cameraShakeFadeController = null;
    cameraController?.abort();
    this.cameraShakeStopPromise = null;
    this.cameraShake = { x: 0, y: 0 };
    this.cameraShakeMode = "idle";
    this.cameraShakeCycleElapsed = 0;
    this.cameraShakeFadeElapsed = 0;
    this.cameraShakeFadeSeconds = 0;
    this.cameraShakeWeight = 0;
    this.cameraShakeStrength = 0;
    this.cameraShakeCycleSeconds = 1;
    this.cameraShakeVibrato = 2;
    this.cameraShakeRandomness = 60;
    this.cameraShakePath = null;
    this.cameraShakeCycleStart = { x: 0, y: 0 };
    this.cameraShakeWaitNextCycle = false;

    // WebGL field/camera offsets and DOM still/talk offsets must all observe
    // the same synchronous reset before snapshot restoration starts.
    this.applyTransforms();
  }

  isCameraShakePlaying(): boolean {
    return this.cameraShakeMode === "playing";
  }

  async enableCameraShake(
    strength: number,
    shakeDuration: number,
    vibrato: number,
    randomness: number,
    fadeDuration: number,
  ): Promise<void> {
    const fadeSeconds = Math.max(0, finite(fadeDuration));
    // An already-Playing Enable is ignored, but Stopping is interruptible: a
    // new Enable refreshes the token and starts another Playing lifecycle.
    // The command still owns its fade delay in the ignored branch.
    if (this.cameraShakeMode === "playing") {
      await this.runTween({ duration: fadeSeconds });
      return;
    }
    const startup = this.cameraShakeMode === "stopping" ? { ...this.cameraShake } : { x: 0, y: 0 };
    this.cameraShakeFadeController?.abort();
    this.cameraShakeStopPromise = null;
    const controller = new AbortController();
    this.cameraShakeFadeController = controller;
    this.cameraShakeMode = "playing";
    this.cameraShake = startup;
    this.cameraShakeFadeElapsed = 0;
    this.cameraShakeFadeSeconds = fadeSeconds;
    this.cameraShakeWeight = fadeSeconds > 0 ? 0 : 1;
    this.cameraShakeStrength = Math.max(0, finite(strength));
    this.cameraShakeCycleSeconds = Math.max(0.001, finite(shakeDuration, 1));
    this.cameraShakeVibrato = Math.max(1, finite(vibrato, 2));
    this.cameraShakeRandomness = finite(randomness, 60);
    this.beginPersistentCameraShakeCycle(startup);
    try {
      await this.runTween({
        duration: fadeSeconds,
        signal: controller.signal,
      });
    } finally {
      if (this.cameraShakeFadeController === controller) this.cameraShakeFadeController = null;
    }
  }

  async disableCameraShake(fadeDuration: number): Promise<void> {
    if (this.cameraShakeMode === "idle") return;
    if (this.cameraShakeMode === "stopping") {
      await this.cameraShakeStopPromise;
      return;
    }
    this.cameraShakeFadeController?.abort();
    const controller = new AbortController();
    this.cameraShakeFadeController = controller;
    this.cameraShakeMode = "stopping";
    this.cameraShakeFadeElapsed = 0;
    this.cameraShakeFadeSeconds = Math.max(0, finite(fadeDuration));
    this.cameraShakeWeight = this.cameraShakeFadeSeconds > 0 ? 1 : 0;
    // Disable starts a fresh non-fading DOTween cycle and waits for that whole
    // cycle. If the fade is longer than one cycle, native recursively starts
    // another complete cycle until Time.time - disableStartTime reaches the
    // fade duration. Only that final completion restores the Boot position.
    const task: Promise<void> = (async () => {
      do {
        this.beginPersistentCameraShakeCycle({ ...this.cameraShake });
        await this.runTween({
          duration: this.cameraShakeCycleSeconds,
          signal: controller.signal,
        });
        if (this.cameraShakeFadeController !== controller || controller.signal.aborted) return;
      } while (this.cameraShakeFadeElapsed < this.cameraShakeFadeSeconds);
    })()
      .then(() => {
        if (this.cameraShakeFadeController !== controller || controller.signal.aborted) return;
        this.cameraShakeMode = "idle";
        this.cameraShakeWeight = 0;
        this.cameraShake = { x: 0, y: 0 };
        this.cameraShakePath = null;
        this.cameraShakeWaitNextCycle = false;
      })
      .finally(() => {
        if (this.cameraShakeFadeController === controller) this.cameraShakeFadeController = null;
        if (this.cameraShakeStopPromise === task) this.cameraShakeStopPromise = null;
      });
    this.cameraShakeStopPromise = task;
    await task;
  }

  private beginPersistentCameraShakeCycle(startup: Vec2): void {
    this.cameraShakeCycleStart = { ...startup };
    this.cameraShakeCycleElapsed = 0;
    this.cameraShakeWaitNextCycle = false;
    this.cameraShakePath = createAdvDotweenShakePath({
      duration: this.cameraShakeCycleSeconds,
      strength: this.cameraShakeStrength,
      vibrato: this.cameraShakeVibrato,
      randomness: this.cameraShakeRandomness,
      fadeOut: false,
      vectorBased: true,
    });
  }

  private updatePersistentCameraShake(deltaSeconds: number): void {
    if (this.cameraShakeMode === "idle") {
      this.cameraShake = { x: 0, y: 0 };
      return;
    }
    const delta = Math.max(0, finite(deltaSeconds));
    this.cameraShakeFadeElapsed += delta;
    this.cameraShakeWeight =
      this.cameraShakeMode === "playing"
        ? this.cameraShakeFadeSeconds > 0
          ? clamp(this.cameraShakeFadeElapsed / this.cameraShakeFadeSeconds)
          : 1
        : this.cameraShakeFadeSeconds > 0
          ? clamp(1 - this.cameraShakeFadeElapsed / this.cameraShakeFadeSeconds)
          : 0;

    // Enable recursively creates a freshly-randomized tween one frame after
    // each cycle completes. Preserve that NextFrame gap instead of wrapping a
    // single periodic waveform/path.
    if (this.cameraShakeWaitNextCycle) {
      if (this.cameraShakeMode === "playing") this.beginPersistentCameraShakeCycle(this.cameraShake);
      return;
    }
    if (!this.cameraShakePath) this.beginPersistentCameraShakeCycle(this.cameraShake);
    this.cameraShakeCycleElapsed += delta;
    const progress = clamp(this.cameraShakeCycleElapsed / this.cameraShakeCycleSeconds);
    const pathOffset = sampleAdvDotweenShake(this.cameraShakePath!, progress);
    const current = {
      x: this.cameraShakeCycleStart.x + pathOffset.x,
      y: this.cameraShakeCycleStart.y + pathOffset.y,
    };
    this.cameraShake = {
      x: current.x * this.cameraShakeWeight,
      y: current.y * this.cameraShakeWeight,
    };
    if (progress >= 1 && this.cameraShakeMode === "playing") {
      this.cameraShakePath = null;
      this.cameraShakeWaitNextCycle = true;
    }
  }

  private characterStageIndex(positionType: number): number {
    const value = Math.trunc(Number(positionType));
    return value >= 1 && value <= 9 && value % 2 === 1 ? (value - 1) / 2 : -1;
  }

  private characterPriority(positionType: number): number {
    const index = this.characterStageIndex(positionType);
    if (index < 0) return this.characterPriorityOrder.length;
    const priority = this.characterPriorityOrder.indexOf(index);
    return priority >= 0 ? priority : this.characterPriorityOrder.length;
  }
}
