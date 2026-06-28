import { Matrix4 } from "three";
import type { AdvCubismDrawState, CubismDrawableBounds, CubismParameterFrame } from "./AdvCubismModel";
import type { AdvMotionSyncCoreStatus } from "./AdvMotionSyncCore";
import type { StoryCharacterModel } from "../StoryCharacterModel";
import { ensureCubism2Framework } from "./CubismCoreRuntime";
import {
  createOwnedAbortSignal,
  fetchCachedArrayBuffer,
  loadCachedImage,
  type OwnedAbortSignal,
} from "./CubismResourceCache";
import { cubismRetryClockSeconds, CubismResourceRetrySchedule } from "./CubismResourceRetry";

/**
 * Legacy Live2D Cubism 2 (`.moc` / `.mtn` / `.exp.json`) rendered through the
 * original `live2d.min.js` SDK in the same WebGL context as the story field.
 *
 * The host resolves model, texture, motion, expression, physics and transition
 * records into this class's URLs. The runtime deliberately knows nothing about
 * the source package or authoring tool that produced those records.
 *
 * The legacy SDK is untyped and exposes its constructors as globals. These
 * declarations intentionally mirror `public/Core/live2d.min.js` and the
 * public Cubism 2 WebGL API rather than inventing methods on the model
 * instance. In particular, motion and expression playback belongs to
 * `MotionQueueManager`, while parameters use `loadParam`/`saveParam`.
 */

// ---- minimal Cubism 2 SDK global typings (the SDK ships untyped) ----
interface Live2DModelWebGLC2 {
  setGL(gl: WebGLRenderingContext): void;
  setTexture(index: number, texture: WebGLTexture): void;
  setMatrix(matrix: Float32Array | number[]): void;
  draw(): void;
  update(): void;
  loadParam(): void;
  saveParam(): void;
  setParamFloat(id: string, value: number, weight?: number): void;
  addToParamFloat(id: string, value: number, weight?: number): void;
  multParamFloat(id: string, value: number, weight?: number): void;
  getParamFloat(id: string): number;
  getCanvasWidth(): number;
  getCanvasHeight(): number;
  isPremultipliedAlpha(): boolean;
  getDrawParam(): DrawParamWebGLC2;
  getModelContext(): ModelContextC2;
}

interface DrawParamWebGLC2 {
  /** Cubism 2 orders this public API as alpha, red, green, blue. */
  setBaseColor(alpha: number, red: number, green: number, blue: number): void;
  gl?: WebGLRenderingContext;
  glno?: number;
  culling?: boolean;
}

interface ClipManagerC2 {
  curFrameNo?: number;
  setupClip(modelContext: unknown, drawParam: DrawParamWebGLC2): void;
}

interface ModelContextC2 {
  clipManager?: ClipManagerC2;
}

interface AMotionC2 {
  setFadeIn(milliseconds: number): void;
  setFadeOut(milliseconds: number): void;
  getFadeOut(): number;
  updateParamExe?: (
    model: Live2DModelWebGLC2,
    userTimeMilliseconds: number,
    weight: number,
    queueEntry: unknown,
  ) => void;
}

type Live2DMotionC2 = AMotionC2;

interface MotionQueueManagerC2 {
  startMotion(motion: AMotionC2, priority?: number): number;
  updateParam(model: Live2DModelWebGLC2): boolean;
  isFinished(motionId?: number): boolean;
  stopAllMotions(): void;
}

interface PhysicsHairC2 {
  setup(length: number, regist: number, mass: number): void;
  addSrcParam(type: string, id: string, scale: number, weight: number): void;
  addTargetParam(type: string, id: string, scale: number, weight: number): void;
  update(model: Live2DModelWebGLC2, timeMilliseconds: number): void;
}

interface PhysicsHairConstructorC2 {
  new (): PhysicsHairC2;
  Src: {
    SRC_TO_X: string;
    SRC_TO_Y: string;
    SRC_TO_G_ANGLE: string;
  };
  Target: {
    TARGET_FROM_ANGLE: string;
    TARGET_FROM_ANGLE_V: string;
  };
}

interface Live2DStaticC2 {
  init(): void;
  setGL(gl: WebGLRenderingContext, bufferIndex?: number): void;
  deleteBuffer?(bufferIndex: number): void;
  dispose?(): void;
}

interface Live2DModelWebGLStaticC2 {
  loadModel(buffer: ArrayBuffer, bufferIndex?: number): Live2DModelWebGLC2;
}

interface Live2DMotionStaticC2 {
  loadMotion(buffer: ArrayBuffer): Live2DMotionC2;
}

interface MotionQueueManagerConstructorC2 {
  new (): MotionQueueManagerC2;
}

interface AMotionConstructorC2 {
  new (): AMotionC2;
}

interface Cubism2RuntimeC2 {
  Live2D: Live2DStaticC2;
  Live2DModelWebGL: Live2DModelWebGLStaticC2;
  Live2DMotion: Live2DMotionStaticC2;
  MotionQueueManager: MotionQueueManagerConstructorC2;
  AMotion: AMotionConstructorC2;
}

declare global {
  var Live2D: Live2DStaticC2 | undefined;
  var Live2DModelWebGL: Live2DModelWebGLStaticC2 | undefined;
  var Live2DMotion: Live2DMotionStaticC2 | undefined;
  var MotionQueueManager: MotionQueueManagerConstructorC2 | undefined;
  var AMotion: AMotionConstructorC2 | undefined;
  var PhysicsHair: PhysicsHairConstructorC2 | undefined;
}

const live2d = (): Cubism2RuntimeC2 => {
  const { AMotion, Live2D, Live2DModelWebGL, Live2DMotion, MotionQueueManager } = globalThis;
  if (!Live2D || !Live2DModelWebGL || !Live2DMotion || !MotionQueueManager || !AMotion) {
    throw new Error("Live2D (Cubism 2) core is unavailable or incomplete");
  }
  return { Live2D, Live2DModelWebGL, Live2DMotion, MotionQueueManager, AMotion };
};

interface Cubism2ContextLease {
  readonly gl: WebGL2RenderingContext;
  readonly id: number;
  references: number;
}

const cubism2ContextLeases = new WeakMap<WebGL2RenderingContext, Cubism2ContextLease>();
let cubism2ContextLeaseCount = 0;
let nextCubism2ContextId = 0;

/**
 * Cubism 2 stores its clipping framebuffer in process-global arrays keyed by
 * `glno`. A fixed zero aliases different Three renderers (including replay and
 * context restoration), leaving a framebuffer from the old WebGL context in
 * the new model. Give every live WebGL context a stable slot and release the
 * global mask storage after its last model goes away.
 */
const acquireCubism2Context = (sdk: Cubism2RuntimeC2, gl: WebGL2RenderingContext): Cubism2ContextLease => {
  let lease = cubism2ContextLeases.get(gl);
  if (!lease) {
    lease = { gl, id: nextCubism2ContextId++, references: 0 };
    cubism2ContextLeases.set(gl, lease);
  }
  lease.references += 1;
  cubism2ContextLeaseCount += 1;
  sdk.Live2D.setGL(gl, lease.id);
  return lease;
};

const releaseCubism2Context = (sdk: Cubism2RuntimeC2, lease: Cubism2ContextLease): void => {
  if (lease.references <= 0) return;
  lease.references -= 1;
  cubism2ContextLeaseCount = Math.max(0, cubism2ContextLeaseCount - 1);
  if (lease.references === 0) {
    cubism2ContextLeases.delete(lease.gl);
    try {
      sdk.Live2D.deleteBuffer?.(lease.id);
    } catch {
      // Models without a clipping context may not have allocated this slot.
    }
  }
  if (cubism2ContextLeaseCount === 0) {
    // `dispose` only clears the legacy runtime's GL arrays. The classic script
    // and motion classes remain initialized and can be reused by the next story.
    sdk.Live2D.dispose?.();
    nextCubism2ContextId = 0;
  }
};

export interface Cubism2ModelOptions {
  gl: WebGL2RenderingContext;
  /** Cancels browser-side resource waits when this character load loses ownership. */
  signal?: AbortSignal;
  /** Resolved legacy `.moc` (or `.moc.bytes`) URL. */
  mocUrl: string;
  textureUrls: string[];
  /**
   * Converts the legacy canvas pixel coordinates into story world units.
   * Cubism 2 has no canvas `PixelsPerUnit` field, so hosts should provide the
   * value from their import metadata when one is available.
   */
  pixelsPerUnit?: number;
  /**
   * Authored height of the complete model canvas in story world units. Used to
   * derive `pixelsPerUnit` after loading when no explicit value is available.
   */
  canvasWorldHeight?: number;
  /** Optional legacy physics descriptor URL. */
  physicsUrl?: string;
  /** Quality gate; defaults to true when a physics asset is available. */
  physicsEnabled?: boolean;
}

interface MotionEntry {
  name: string;
  url: string;
}

interface ExpressionEntry {
  name: string;
  url: string;
}

interface PlaybackRequest {
  sequence: number;
  name: string;
  fadeInSeconds?: number;
}

interface CachedMotion {
  bytes: ArrayBuffer;
}

interface CachedExpression {
  operations: ExpressionOperation[];
  defaultFadeInMilliseconds: number;
  defaultFadeOutMilliseconds: number;
}

interface LegacyExpressionParameter {
  calc?: unknown;
  def?: unknown;
  id?: unknown;
  val?: unknown;
}

interface LegacyExpressionAsset {
  fade_in?: unknown;
  fade_out?: unknown;
  params?: LegacyExpressionParameter[];
}

interface LegacyPhysicsParameter {
  id?: unknown;
  ptype?: unknown;
  scale?: unknown;
  weight?: unknown;
}

interface LegacyPhysicsHairDefinition {
  setup?: {
    length?: unknown;
    mass?: unknown;
    regist?: unknown;
  };
  src?: LegacyPhysicsParameter[];
  targets?: LegacyPhysicsParameter[];
}

interface LegacyPhysicsAsset {
  physics_hair?: LegacyPhysicsHairDefinition[];
}

interface ExpressionOperation {
  id: string;
  type: "add" | "mult" | "set";
  value: number;
}

const EYE_BLINK_IDS = ["PARAM_EYE_L_OPEN", "PARAM_EYE_R_OPEN"] as const;
const MOUTH_OPEN_ID = "PARAM_MOUTH_OPEN_Y";
const MOUTH_FORM_ID = "PARAM_MOUTH_FORM";
const ANGLE_X_ID = "PARAM_ANGLE_X";
const ANGLE_Y_ID = "PARAM_ANGLE_Y";
const ANGLE_Z_ID = "PARAM_ANGLE_Z";
const BODY_ANGLE_X_ID = "PARAM_BODY_ANGLE_X";
const EYE_BALL_X_ID = "PARAM_EYE_BALL_X";
const EYE_BALL_Y_ID = "PARAM_EYE_BALL_Y";
const BREATH_ID = "PARAM_BREATH";
const EYE_BLINK_INTERVAL_MIN_SECONDS = 0.5;
const EYE_BLINK_INTERVAL_MAX_SECONDS = 4.5;
const EYE_BLINK_CLOSING_SECONDS = 0.1;
const EYE_BLINK_CLOSED_SECONDS = 0.05;
const EYE_BLINK_OPENING_SECONDS = 0.15;

const finiteNumber = (value: unknown, fallback: number): number => {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number.parseFloat(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
};

const nonEmptyString = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

/** Cubism 2 expression files use a one-second fallback when fade is omitted. */
const expressionFadeMilliseconds = (value: unknown): number => {
  const parsed = Number.parseInt(typeof value === "string" || typeof value === "number" ? String(value) : "", 10);
  return parsed || 1000;
};

const requestedFadeMilliseconds = (fadeInSeconds: number | undefined, fallback: number): number => {
  const seconds = Number(fadeInSeconds);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : fallback;
};

const createTexture2D = (
  gl: WebGL2RenderingContext,
  image: HTMLImageElement,
  modelUsesPremultipliedAlpha: boolean,
): WebGLTexture => {
  const texture = gl.createTexture();
  if (!texture) throw new Error("Unable to allocate a Cubism 2 texture");

  // Cubism 2 records whether its renderer expects premultiplied source data;
  // preserve that contract while restoring the caller's pixel-store state.
  const activeTexture = gl.getParameter(gl.ACTIVE_TEXTURE) as number;
  gl.activeTexture(gl.TEXTURE0);
  const boundTexture = gl.getParameter(gl.TEXTURE_BINDING_2D) as WebGLTexture | null;
  const unpackPremultiply = Boolean(gl.getParameter(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL));
  const unpackFlipY = Boolean(gl.getParameter(gl.UNPACK_FLIP_Y_WEBGL));
  try {
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, modelUsesPremultipliedAlpha ? 0 : 1);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.generateMipmap(gl.TEXTURE_2D);
    return texture;
  } catch (error) {
    gl.deleteTexture(texture);
    throw error;
  } finally {
    gl.bindTexture(gl.TEXTURE_2D, boundTexture);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, unpackPremultiply ? 1 : 0);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, unpackFlipY ? 1 : 0);
    gl.activeTexture(activeTexture);
  }
};

const DEFAULT_PIXELS_PER_UNIT = 100;

export class Cubism2Model implements StoryCharacterModel {
  readonly format = "cubism2" as const;
  readonly modelUrl: string;
  readonly motionSyncStatus: AdvMotionSyncCoreStatus | "unconfigured" = "unconfigured";

  get pixelsPerUnit(): number {
    return this.pixelsPerUnitValue;
  }

  get isOperational(): boolean {
    return !this.released && this.initialized && Boolean(this.liveModel);
  }

  get updateSerial(): number {
    return this.updateSerialValue;
  }

  get drawSerial(): number {
    return this.drawSerialValue;
  }

  get isMotionPlaying(): boolean {
    return Boolean(this.motionManager && !this.motionManager.isFinished());
  }

  private readonly gl: WebGL2RenderingContext;
  private readonly resourceAbort: OwnedAbortSignal;
  private readonly resourceSignal: AbortSignal;
  private glContextLease: Cubism2ContextLease | null = null;
  private liveModel: Live2DModelWebGLC2 | null = null;
  private motionManager: MotionQueueManagerC2 | null = null;
  private expressionManager: MotionQueueManagerC2 | null = null;
  private readonly textures: WebGLTexture[] = [];
  private readonly motionIndex = new Map<string, string>();
  private readonly drawScale = new Matrix4();
  private readonly drawMvp = new Matrix4();
  /** Stable upload storage; Cubism consumes this synchronously during draw. */
  private readonly drawMatrix = new Float32Array(16);
  private readonly drawViewport: [number, number, number, number] = [0, 0, 1, 1];
  private drawFramebuffer: WebGLFramebuffer | null = null;
  private readonly expressionIndex = new Map<string, ExpressionEntry>();
  private readonly motionCache = new Map<string, CachedMotion>();
  private readonly expressionCache = new Map<string, CachedExpression>();
  private readonly loadingMotions = new Map<string, Promise<CachedMotion | null>>();
  private readonly loadingExpressions = new Map<string, Promise<CachedExpression | null>>();
  private readonly motionRetries = new CubismResourceRetrySchedule();
  private readonly expressionRetries = new CubismResourceRetrySchedule();
  private physicsHairs: PhysicsHairC2[] = [];
  private requestedMotion: PlaybackRequest | null = null;
  private requestedExpression: PlaybackRequest | null = null;
  private motionRequestSequence = 0;
  private expressionRequestSequence = 0;
  private resourceGeneration = 0;
  private physicsEnabled = true;
  private eyeBlinkEnabled = true;
  private eyeBlinkPhase: "interval" | "closing" | "closed" | "opening" = "interval";
  private eyeBlinkPhaseElapsedSeconds = 0;
  private eyeBlinkIntervalRemainingSeconds = this.nextEyeBlinkIntervalSeconds();
  private paused = false;
  private motionSpeed = 1;
  private elapsedSeconds = 0;
  // PhysicsHair treats zero as its uninitialized-time sentinel, so start the
  // per-model monotonic clock above zero even when priming at delta=0.
  private physicsTimeMilliseconds = 1;
  private updateSerialValue = 0;
  private drawSerialValue = 0;
  private released = false;
  private initialized = false;
  private pixelsPerUnitValue: number;
  private readonly hasExplicitPixelsPerUnit: boolean;
  private readonly canvasWorldHeight: number | null;

  private constructor(options: Cubism2ModelOptions) {
    this.gl = options.gl;
    this.resourceAbort = createOwnedAbortSignal(options.signal);
    this.resourceSignal = this.resourceAbort.signal;
    this.modelUrl = options.mocUrl;
    const pixelsPerUnit = finiteNumber(options.pixelsPerUnit, Number.NaN);
    this.hasExplicitPixelsPerUnit = Number.isFinite(pixelsPerUnit) && pixelsPerUnit > 0;
    this.pixelsPerUnitValue = this.hasExplicitPixelsPerUnit ? pixelsPerUnit : DEFAULT_PIXELS_PER_UNIT;
    const canvasWorldHeight = finiteNumber(options.canvasWorldHeight, Number.NaN);
    this.canvasWorldHeight = Number.isFinite(canvasWorldHeight) && canvasWorldHeight > 0 ? canvasWorldHeight : null;
    this.physicsEnabled = options.physicsEnabled !== false;
  }

  static async create(options: Cubism2ModelOptions): Promise<Cubism2Model | null> {
    await ensureCubism2Framework();
    if (options.signal?.aborted) return null;
    const instance = new Cubism2Model(options);
    try {
      await instance.initialize(options);
      return instance;
    } catch (error) {
      // Initialization allocates the model and textures in stages. Release
      // anything that was acquired before a later resource failed.
      try {
        instance.release();
      } catch {
        // Preserve the original load error if a partial SDK object is broken.
      }
      if ((error as { name?: unknown })?.name !== "AbortError") {
        console.warn("[Cubism2Model] failed to load model:", error);
      }
      return null;
    }
  }

  private async initialize(options: Cubism2ModelOptions): Promise<void> {
    const sdk = live2d();
    const mocBytes = await fetchCachedArrayBuffer(options.mocUrl, this.resourceSignal);
    // ensureCubism2Framework initialized the process-global SDK exactly once.
    // Calling Live2D.init again for a second character can reset global state.
    // Acquire the global slot only after the async fetch, immediately before
    // the synchronous loadModel call. Context IDs are therefore allocated in
    // the same order as Core creates their mask FBOs; an out-of-order download
    // cannot leave a lower framebuffer-array slot empty.
    this.glContextLease = acquireCubism2Context(sdk, this.gl);
    this.motionManager = new sdk.MotionQueueManager();
    this.expressionManager = new sdk.MotionQueueManager();

    const model = sdk.Live2DModelWebGL.loadModel(mocBytes, this.glContextLease.id);
    this.installModelGlGuards(model, this.glContextLease.id);
    // Save the model's authored defaults immediately after loading.
    // Each frame's `loadParam()` below restores this baseline before motion.
    model.saveParam();
    this.liveModel = model;
    if (!this.hasExplicitPixelsPerUnit && this.canvasWorldHeight) {
      const canvasHeight = Math.max(0, finiteNumber(model.getCanvasHeight(), 0));
      if (canvasHeight > 0) this.pixelsPerUnitValue = canvasHeight / this.canvasWorldHeight;
    }

    const modelUsesPremultipliedAlpha = model.isPremultipliedAlpha();
    for (let index = 0; index < options.textureUrls.length; index += 1) {
      const url = String(options.textureUrls[index] || "").trim();
      if (!url) continue;
      const image = await loadCachedImage(url, this.resourceSignal);
      const texture = createTexture2D(this.gl, image, modelUsesPremultipliedAlpha);
      this.textures.push(texture);
      model.setTexture(index, texture);
    }

    // Physics is optional: a bad/missing upstream JSON must not discard a
    // usable character. With quality disabled, avoid the extra network request.
    if (this.physicsEnabled && options.physicsUrl) await this.loadPhysics(options.physicsUrl);
    this.initialized = true;
  }

  private installModelGlGuards(model: Live2DModelWebGLC2, contextId: number): void {
    const drawParam = model.getDrawParam();
    // `loadModel(bytes, id)` constructs the draw parameter for this GL slot,
    // but the legacy ClipManager leaves `curFrameNo` at zero for the second
    // model on a non-zero context. Keep both indices explicit so every model in
    // the renderer samples that renderer's mask texture.
    drawParam.glno = contextId;
    // The story field uses a Y-flipped projection and always renders characters
    // into an offscreen framebuffer. Cubism 2 hard-codes CCW while drawing, so
    // authored culling can otherwise discard only the affected components.
    let authoredCulling = Boolean(drawParam.culling);
    try {
      Object.defineProperty(drawParam, "culling", {
        configurable: true,
        enumerable: true,
        get: () => false,
        set: (value: unknown) => {
          authoredCulling = Boolean(value);
        },
      });
      void authoredCulling;
    } catch {
      drawParam.culling = false;
    }

    const clipManager = model.getModelContext()?.clipManager;
    if (!clipManager?.setupClip) return;
    clipManager.curFrameNo = contextId;
    const setupClip = clipManager.setupClip.bind(clipManager);
    clipManager.setupClip = (modelContext, activeDrawParam): void => {
      setupClip(modelContext, activeDrawParam);
      const gl = (activeDrawParam.gl || this.gl) as WebGL2RenderingContext;
      // The stock C2 runtime restores `gl.canvas` dimensions after its 256px
      // mask pass, which is wrong for a Three render target or scaled viewport.
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.drawFramebuffer);
      gl.viewport(...this.drawViewport);
    };
  }

  /** Register host-resolved motion and expression descriptors. */
  registerCatalog(motions: MotionEntry[], expressions: ExpressionEntry[]): void {
    if (this.released) return;
    for (const motion of motions) {
      const name = motion.name.trim();
      if (name && motion.url) this.motionIndex.set(name, motion.url);
    }
    for (const expression of expressions) {
      const name = expression.name.trim();
      if (name && expression.url) this.expressionIndex.set(name, { name, url: expression.url });
    }
  }

  setPaused(paused: boolean): void {
    const next = Boolean(paused);
    if (this.paused && !next) this.resetExpressionParametersToDefault();
    this.paused = next;
  }

  /**
   * Cubism 2's MotionQueueManager reads its own SDK wall clock, so authored
   * `.mtn` playback cannot safely be rate-scaled per model. This rate still
   * controls local blink and physics elapsed time; it intentionally does not
   * pretend to change the global manager's motion speed.
   */
  setMotionSpeed(speed: number): void {
    this.motionSpeed = Math.max(0.001, Number(speed) || 1);
  }

  setEyeBlinkEnabled(enabled: boolean): void {
    this.eyeBlinkEnabled = enabled;
  }

  resetExpressionParametersToDefault(): void {
    this.expressionRequestSequence += 1;
    this.requestedExpression = null;
    this.expressionManager?.stopAllMotions();
    if (!this.liveModel) return;
    // Expressions are applied after `saveParam`, so restoring/saving this
    // baseline removes their overrides without erasing the current motion.
    this.liveModel.loadParam();
    this.liveModel.saveParam();
    this.liveModel.update();
  }

  hasMotion(name: string): boolean {
    return Boolean(name && this.motionIndex.has(name));
  }

  stopMotions(): void {
    if (this.requestedMotion) this.motionRetries.succeed(this.requestedMotion.name);
    this.motionRequestSequence += 1;
    this.requestedMotion = null;
    this.motionManager?.stopAllMotions();
  }

  resetMotionSync(): void {
    /* Cubism 2 has no MotionSync; intentional no-op. */
  }

  drawableBounds(): CubismDrawableBounds | null {
    if (!this.liveModel) return null;
    const width = Math.max(0, finiteNumber(this.liveModel.getCanvasWidth(), 0)) / this.pixelsPerUnitValue;
    const height = Math.max(0, finiteNumber(this.liveModel.getCanvasHeight(), 0)) / this.pixelsPerUnitValue;
    return { x: -width / 2, y: -height / 2, width, height };
  }

  canvasBounds(): CubismDrawableBounds {
    return this.drawableBounds() ?? { x: 0, y: 0, width: 0, height: 0 };
  }

  async prepareMotion(name: string): Promise<boolean> {
    return Boolean(await this.ensureMotion(name));
  }

  async prepareExpression(name: string): Promise<boolean> {
    return Boolean(await this.ensureExpression(name));
  }

  private async ensureMotion(name: string): Promise<CachedMotion | null> {
    const url = this.motionIndex.get(name);
    if (!url || !this.liveModel || this.released) return null;
    const cached = this.motionCache.get(name);
    if (cached) return cached;
    const inFlight = this.loadingMotions.get(name);
    if (inFlight) return inFlight;
    if (!this.motionRetries.isDue(name)) return null;

    const generation = this.resourceGeneration;
    const task = (async (): Promise<CachedMotion | null> => {
      try {
        const bytes = await fetchCachedArrayBuffer(url, this.resourceSignal);
        if (this.released || generation !== this.resourceGeneration) return null;
        // Keep bytes, not a mutable Live2DMotion instance. `setFadeIn` mutates
        // that instance and the legacy API has no public getFadeIn(), so a new
        // parser instance is required to faithfully restore an authored fade
        // after a command explicitly requested a different one.
        const result = { bytes };
        if (!this.released && generation === this.resourceGeneration) this.motionCache.set(name, result);
        this.motionRetries.succeed(name);
        return result;
      } catch (error) {
        this.recordResourceFailure("motion", name, error);
        return null;
      } finally {
        this.loadingMotions.delete(name);
      }
    })();
    this.loadingMotions.set(name, task);
    return task;
  }

  private async ensureExpression(name: string): Promise<CachedExpression | null> {
    const entry = this.expressionIndex.get(name);
    if (!entry || this.released) return null;
    const cached = this.expressionCache.get(name);
    if (cached) return cached;
    const inFlight = this.loadingExpressions.get(name);
    if (inFlight) return inFlight;
    if (!this.expressionRetries.isDue(name)) return null;

    const generation = this.resourceGeneration;
    const task = (async (): Promise<CachedExpression | null> => {
      try {
        const bytes = await fetchCachedArrayBuffer(entry.url, this.resourceSignal);
        if (this.released || generation !== this.resourceGeneration) return null;
        const asset = JSON.parse(new TextDecoder().decode(bytes)) as LegacyExpressionAsset;
        const result = this.createExpressionRecipe(asset);
        if (!this.released && generation === this.resourceGeneration) this.expressionCache.set(name, result);
        this.expressionRetries.succeed(name);
        return result;
      } catch (error) {
        this.recordResourceFailure("expression", name, error);
        return null;
      } finally {
        this.loadingExpressions.delete(name);
      }
    })();
    this.loadingExpressions.set(name, task);
    return task;
  }

  /** Parse the legacy lowercase `params` expression descriptor once. */
  private createExpressionRecipe(asset: LegacyExpressionAsset): CachedExpression {
    const operations: ExpressionOperation[] = [];
    for (const parameter of Array.isArray(asset.params) ? asset.params : []) {
      const id = nonEmptyString(parameter?.id);
      const value = finiteNumber(parameter?.val, Number.NaN);
      if (!id || !Number.isFinite(value)) continue;
      const defaultValue = finiteNumber(parameter?.def, 0);
      const calc = nonEmptyString(parameter?.calc);
      if (calc === "set") operations.push({ id, type: "set", value });
      else if (calc === "mult") operations.push({ id, type: "mult", value: value / (defaultValue || 1) });
      else operations.push({ id, type: "add", value: value - defaultValue });
    }
    return {
      operations,
      defaultFadeInMilliseconds: expressionFadeMilliseconds(asset.fade_in),
      defaultFadeOutMilliseconds: expressionFadeMilliseconds(asset.fade_out),
    };
  }

  /** Build the AMotion subclass shape used by the legacy C2 expression API. */
  private createExpressionMotion(recipe: CachedExpression, fadeInSeconds: number | undefined): AMotionC2 {
    const sdk = live2d();
    const motion = new sdk.AMotion();
    motion.setFadeIn(requestedFadeMilliseconds(fadeInSeconds, recipe.defaultFadeInMilliseconds));
    motion.setFadeOut(recipe.defaultFadeOutMilliseconds);
    motion.updateParamExe = (model, _userTimeMilliseconds, weight) => {
      for (const operation of recipe.operations) {
        if (operation.type === "set") model.setParamFloat(operation.id, operation.value, weight);
        else if (operation.type === "mult") model.multParamFloat(operation.id, operation.value, weight);
        else model.addToParamFloat(operation.id, operation.value, weight);
      }
    };
    return motion;
  }

  private startMotionRequest(request: PlaybackRequest): boolean {
    if (this.released || this.requestedMotion?.sequence !== request.sequence) return false;
    const cached = this.motionCache.get(request.name);
    if (!cached || !this.motionManager) return false;
    try {
      const motion = live2d().Live2DMotion.loadMotion(cached.bytes);
      const requestedFade = Number(request.fadeInSeconds);
      if (Number.isFinite(requestedFade) && requestedFade >= 0) motion.setFadeIn(requestedFade * 1000);
      this.motionManager.startMotion(motion);
      this.motionRetries.succeed(request.name);
      return true;
    } catch (error) {
      this.recordResourceFailure("motion", request.name, error);
      return false;
    }
  }

  private startExpressionRequest(request: PlaybackRequest): boolean {
    if (this.released || this.requestedExpression?.sequence !== request.sequence) return false;
    const cached = this.expressionCache.get(request.name);
    if (!cached || !this.expressionManager) return false;
    try {
      this.expressionManager.startMotion(this.createExpressionMotion(cached, request.fadeInSeconds));
      this.expressionRetries.succeed(request.name);
      return true;
    } catch (error) {
      this.recordResourceFailure("expression", request.name, error);
      return false;
    }
  }

  playMotion(name: string, fadeInSeconds?: number): boolean {
    if (!this.hasMotion(name) || this.released) return false;
    if (this.requestedMotion?.name && this.requestedMotion.name !== name) {
      this.motionRetries.succeed(this.requestedMotion.name);
    }
    const request = { sequence: ++this.motionRequestSequence, name, fadeInSeconds };
    this.requestedMotion = request;
    if (this.motionCache.has(name)) return this.startMotionRequest(request);
    void this.ensureMotion(name).then((motion) => {
      if (motion) this.startMotionRequest(request);
    });
    return false;
  }

  playExpression(name: string, fadeInSeconds?: number): boolean {
    if (!name || !this.expressionIndex.has(name) || this.released) return false;
    if (this.requestedExpression?.name && this.requestedExpression.name !== name) {
      this.expressionRetries.succeed(this.requestedExpression.name);
    }
    const request = { sequence: ++this.expressionRequestSequence, name, fadeInSeconds };
    this.requestedExpression = request;
    if (this.expressionCache.has(name)) return this.startExpressionRequest(request);
    void this.ensureExpression(name).then((expression) => {
      if (expression) this.startExpressionRequest(request);
    });
    return false;
  }

  private recordResourceFailure(channel: "motion" | "expression", name: string, error: unknown): void {
    if (this.released || this.resourceSignal?.aborted) return;
    const schedule = channel === "motion" ? this.motionRetries : this.expressionRetries;
    const attempt = schedule.fail(name);
    if (attempt === 1 || (attempt & (attempt - 1)) === 0) {
      console.warn(`[Cubism2Model] ${channel} ${name} failed (attempt ${attempt}); retrying`, error);
    }
  }

  private retryRequestedResources(): void {
    if (this.motionRetries.empty && this.expressionRetries.empty) return;
    const now = cubismRetryClockSeconds();
    const motion = this.requestedMotion;
    if (
      motion &&
      this.motionRetries.has(motion.name) &&
      this.motionRetries.isDue(motion.name, now) &&
      !this.loadingMotions.has(motion.name)
    ) {
      if (this.motionCache.has(motion.name)) this.startMotionRequest(motion);
      else {
        void this.ensureMotion(motion.name).then((resource) => {
          if (resource) this.startMotionRequest(motion);
        });
      }
    }
    const expression = this.requestedExpression;
    if (
      expression &&
      this.expressionRetries.has(expression.name) &&
      this.expressionRetries.isDue(expression.name, now) &&
      !this.loadingExpressions.has(expression.name)
    ) {
      if (this.expressionCache.has(expression.name)) this.startExpressionRequest(expression);
      else {
        void this.ensureExpression(expression.name).then((resource) => {
          if (resource) this.startExpressionRequest(expression);
        });
      }
    }
  }

  isCurrentExpression(name: string): boolean {
    return Boolean(name && this.requestedExpression?.name === name);
  }

  refreshCurrentExpressionFadeIn(name: string, fadeInSeconds?: number): void {
    if (!name || this.requestedExpression?.name !== name) return;
    // The native controller only refreshes its bookkeeping for duplicate
    // expression requests. Retain that behavior while a lazy load is pending.
    this.requestedExpression = { ...this.requestedExpression, fadeInSeconds };
  }

  primeInitialFrame(frame: CubismParameterFrame): void {
    this.update(0, frame);
  }

  setParameter(id: string, value: number, weight = 1): void {
    this.liveModel?.setParamFloat(id, value, weight);
  }

  parameterRange(): { minimum: number; maximum: number } | null {
    // Cubism 2's public SDK does not expose authored parameter ranges.
    return null;
  }

  eyeBallPosition(): { x: number; y: number } {
    if (!this.liveModel) return { x: 0, y: 0 };
    return { x: this.liveModel.getParamFloat("PARAM_EYE_BALL_X"), y: this.liveModel.getParamFloat("PARAM_EYE_BALL_Y") };
  }

  setEyeBallPosition(x: number, y: number): void {
    this.liveModel?.setParamFloat("PARAM_EYE_BALL_X", x);
    this.liveModel?.setParamFloat("PARAM_EYE_BALL_Y", y);
  }

  forceEyeBallPosition(x: number, y: number): void {
    this.setEyeBallPosition(x, y);
    this.liveModel?.update();
  }

  private async loadPhysics(url: string): Promise<void> {
    try {
      const bytes = await fetchCachedArrayBuffer(url, this.resourceSignal);
      if (this.released) return;
      const asset = JSON.parse(new TextDecoder().decode(bytes)) as LegacyPhysicsAsset;
      this.physicsHairs = this.createPhysicsHairs(asset);
    } catch (error) {
      // Physics is a visual enhancement, never a reason to remove a character.
      console.warn("[Cubism2Model] physics failed to load:", error);
      this.physicsHairs = [];
    }
  }

  private createPhysicsHairs(asset: LegacyPhysicsAsset): PhysicsHairC2[] {
    const constructor = globalThis.PhysicsHair;
    if (!constructor || !Array.isArray(asset.physics_hair)) return [];
    const hairs: PhysicsHairC2[] = [];
    for (const definition of asset.physics_hair) {
      const hair = new constructor();
      const setup = definition?.setup;
      hair.setup(finiteNumber(setup?.length, 0.3), finiteNumber(setup?.regist, 0.5), finiteNumber(setup?.mass, 0.1));

      let hasTarget = false;
      for (const source of Array.isArray(definition?.src) ? definition.src : []) {
        const id = nonEmptyString(source?.id);
        if (!id) continue;
        hair.addSrcParam(
          this.physicsSourceType(nonEmptyString(source?.ptype), constructor),
          id,
          finiteNumber(source?.scale, 1),
          finiteNumber(source?.weight, 1),
        );
      }
      for (const target of Array.isArray(definition?.targets) ? definition.targets : []) {
        const id = nonEmptyString(target?.id);
        if (!id) continue;
        hair.addTargetParam(
          this.physicsTargetType(nonEmptyString(target?.ptype), constructor),
          id,
          finiteNumber(target?.scale, 1),
          finiteNumber(target?.weight, 1),
        );
        hasTarget = true;
      }
      if (hasTarget) hairs.push(hair);
    }
    return hairs;
  }

  private physicsSourceType(type: string, constructor: PhysicsHairConstructorC2): string {
    switch (type.toLowerCase()) {
      case "x":
        return constructor.Src.SRC_TO_X;
      case "y":
        return constructor.Src.SRC_TO_Y;
      default:
        return constructor.Src.SRC_TO_G_ANGLE;
    }
  }

  private physicsTargetType(type: string, constructor: PhysicsHairConstructorC2): string {
    return type.toLowerCase() === "angle_v"
      ? constructor.Target.TARGET_FROM_ANGLE_V
      : constructor.Target.TARGET_FROM_ANGLE;
  }

  private nextEyeBlinkIntervalSeconds(): number {
    return (
      EYE_BLINK_INTERVAL_MIN_SECONDS + Math.random() * (EYE_BLINK_INTERVAL_MAX_SECONDS - EYE_BLINK_INTERVAL_MIN_SECONDS)
    );
  }

  private applyAutoBlink(model: Live2DModelWebGLC2, deltaSeconds: number, canStartBlink: boolean): void {
    let value = 1;
    if (this.eyeBlinkPhase === "interval") {
      // Native IsBlinking=false freezes only the idle countdown. An active
      // closing/closed/opening phase is still allowed to finish below.
      if (canStartBlink) {
        this.eyeBlinkIntervalRemainingSeconds -= deltaSeconds;
        if (this.eyeBlinkIntervalRemainingSeconds < 0) {
          this.eyeBlinkPhase = "closing";
          this.eyeBlinkPhaseElapsedSeconds = 0;
        }
      }
    } else {
      this.eyeBlinkPhaseElapsedSeconds += deltaSeconds * this.motionSpeed;
      if (this.eyeBlinkPhase === "closing") {
        const progress = Math.min(1, this.eyeBlinkPhaseElapsedSeconds / EYE_BLINK_CLOSING_SECONDS);
        value = 1 - progress;
        if (progress >= 1) {
          this.eyeBlinkPhase = "closed";
          this.eyeBlinkPhaseElapsedSeconds = 0;
        }
      } else if (this.eyeBlinkPhase === "closed") {
        value = 0;
        if (this.eyeBlinkPhaseElapsedSeconds / EYE_BLINK_CLOSED_SECONDS >= 1) {
          this.eyeBlinkPhase = "opening";
          this.eyeBlinkPhaseElapsedSeconds = 0;
        }
      } else {
        const progress = Math.min(1, this.eyeBlinkPhaseElapsedSeconds / EYE_BLINK_OPENING_SECONDS);
        value = progress;
        if (progress >= 1) {
          this.eyeBlinkPhase = "interval";
          this.eyeBlinkPhaseElapsedSeconds = 0;
          this.eyeBlinkIntervalRemainingSeconds = this.nextEyeBlinkIntervalSeconds();
        }
      }
    }
    for (const id of EYE_BLINK_IDS) model.multParamFloat(id, value, 1);
  }

  private applyAutoBreath(model: Live2DModelWebGLC2): void {
    const phase = this.elapsedSeconds * Math.PI * 2;
    model.setParamFloat(BREATH_ID, 0.5 + 0.5 * Math.sin(phase / 3.2345), 1);
  }

  /**
   * Apply the story engine's pre-physics input in the same order used by the
   * Cubism 3 adapter: focus/lip/explicit overrides/harmonic blends. The C2
   * SDK accepts the standard PARAM_* identifiers used by Cubism 2 assets.
   */
  private applyStoryParameters(model: Live2DModelWebGLC2, frame: CubismParameterFrame): void {
    if (frame.focusX != null || frame.focusY != null) {
      const focusX = Math.max(-1, Math.min(1, Number(frame.focusX) || 0));
      const focusY = Math.max(-1, Math.min(1, Number(frame.focusY) || 0));
      model.addToParamFloat(EYE_BALL_X_ID, focusX);
      model.addToParamFloat(EYE_BALL_Y_ID, focusY);
      model.addToParamFloat(ANGLE_X_ID, focusX * 30);
      model.addToParamFloat(ANGLE_Y_ID, focusY * 30);
      model.addToParamFloat(ANGLE_Z_ID, focusX * focusY * -30);
      model.addToParamFloat(BODY_ANGLE_X_ID, focusX * 10);
    }

    // Classic C2 models have no MotionSync Core integration. Add the complete
    // voice envelope over the motion/expression base: addition preserves the
    // authored pose, while the model's own parameter range caps strong vowels.
    // A partial SDK weight makes a nominal 1.0 envelope open the mouth only a
    // fraction as far as Cubism 3, which is especially visible on legacy C2.
    if (frame.mouthOpenY != null) model.addToParamFloat(MOUTH_OPEN_ID, frame.mouthOpenY);
    if (frame.mouthForm != null) model.setParamFloat(MOUTH_FORM_ID, frame.mouthForm);

    for (const [id, value] of Object.entries(frame.overrides || {})) {
      if (id && Number.isFinite(value)) model.setParamFloat(id, value);
    }
    for (const blend of frame.blends || []) {
      if (!blend.id || !Number.isFinite(blend.value)) continue;
      if (blend.mode === 1) model.addToParamFloat(blend.id, blend.value);
      else if (blend.mode === 2) model.multParamFloat(blend.id, blend.value);
      else model.setParamFloat(blend.id, blend.value);
    }
  }

  /** ADV Angle/Look are late controller overrides, after C2 physics. */
  private applyLateStoryParameters(model: Live2DModelWebGLC2, frame: CubismParameterFrame): void {
    if (frame.angleX != null) model.addToParamFloat(ANGLE_X_ID, frame.angleX);
    if (frame.bodyAngleX != null) model.addToParamFloat(BODY_ANGLE_X_ID, frame.bodyAngleX);
    if (frame.lookX != null) model.setParamFloat(EYE_BALL_X_ID, frame.lookX);
    if (frame.lookY != null) model.setParamFloat(EYE_BALL_Y_ID, frame.lookY);
  }

  update(deltaSeconds: number, frame: CubismParameterFrame): void {
    const model = this.liveModel;
    if (!model || this.released) return;
    this.retryRequestedResources();
    if (this.paused) return;
    const delta = Math.max(0, Math.min(0.1, Number(deltaSeconds) || 0));
    const localDelta = delta * this.motionSpeed;
    this.elapsedSeconds += localDelta;
    this.physicsTimeMilliseconds += localDelta * 1000;

    // This order follows the Cubism 2 controller contract:
    // loadParam → motion manager → saveParam → expression manager → model.update.
    model.loadParam();
    const motionUpdated = this.motionManager?.updateParam(model) ?? false;
    model.saveParam();
    this.expressionManager?.updateParam(model);

    this.applyAutoBlink(model, delta, this.eyeBlinkEnabled && !motionUpdated);
    this.applyAutoBreath(model);
    this.applyStoryParameters(model, frame);

    // C2 PhysicsHair consumes the motion/expression-driven source parameters
    // and writes its target parameters before the model computes drawables.
    if (this.physicsEnabled) {
      for (const hair of this.physicsHairs) hair.update(model, this.physicsTimeMilliseconds);
    }
    this.applyLateStoryParameters(model, frame);
    model.update();
    this.updateSerialValue += 1;
  }

  /**
   * Cubism 2 exposes vertices in top-left-origin canvas pixels. Convert them to
   * centered, Y-up story world units before applying the ordinary character and
   * camera MVP. This fixed authoring transform keeps camera framing independent
   * from model size and lets legacy models share the Cubism 3 scene pipeline.
   */
  private composeDrawMatrix(mvp: Matrix4): Float32Array {
    const model = this.liveModel;
    if (!model) {
      this.drawMatrix.set(mvp.elements);
      return this.drawMatrix;
    }
    const canvasW = Math.max(Number(model.getCanvasWidth()) || 0, 0);
    const canvasH = Math.max(Number(model.getCanvasHeight()) || 0, 0);
    const scale = 1 / this.pixelsPerUnitValue;
    this.drawScale.set(
      scale,
      0,
      0,
      -canvasW * 0.5 * scale,
      0,
      -scale,
      0,
      canvasH * 0.5 * scale,
      0,
      0,
      1,
      0,
      0,
      0,
      0,
      1,
    );
    this.drawMvp.copy(mvp).multiply(this.drawScale);
    this.drawMatrix.set(this.drawMvp.elements);
    return this.drawMatrix;
  }

  draw(
    mvp: Matrix4,
    framebuffer: WebGLFramebuffer | null,
    viewport: readonly [number, number, number, number],
    color: readonly [number, number, number, number],
    _drawState?: AdvCubismDrawState,
  ): void {
    if (!this.initialized || !this.liveModel || this.released) return;
    const gl = this.gl;
    const sdk = live2d();
    const contextId = this.glContextLease?.id;
    if (contextId == null) return;
    sdk.Live2D.setGL(gl, contextId);
    this.drawFramebuffer = framebuffer;
    this.drawViewport[0] = viewport[0];
    this.drawViewport[1] = viewport[1];
    this.drawViewport[2] = viewport[2];
    this.drawViewport[3] = viewport[3];
    const clearColor = gl.getParameter(gl.COLOR_CLEAR_VALUE) as Float32Array;
    try {
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.viewport(...this.drawViewport);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.SCISSOR_TEST);
      gl.disable(gl.STENCIL_TEST);
      gl.disable(gl.CULL_FACE);
      gl.colorMask(true, true, true, true);
      gl.depthMask(false);
      gl.frontFace(gl.CCW);
      gl.enable(gl.BLEND);
      gl.blendEquationSeparate(gl.FUNC_ADD, gl.FUNC_ADD);
      gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.bindVertexArray(null);
      this.liveModel.setMatrix(this.composeDrawMatrix(mvp));
      const alpha = Math.max(0, Math.min(1, finiteNumber(color[3], 1)));
      const red = Math.max(0, Math.min(1, finiteNumber(color[0], 1))) * alpha;
      const green = Math.max(0, Math.min(1, finiteNumber(color[1], 1))) * alpha;
      const blue = Math.max(0, Math.min(1, finiteNumber(color[2], 1))) * alpha;
      this.liveModel.getDrawParam().setBaseColor(alpha, red, green, blue);
      // C2's `update()` also rebuilds the process-global clipping mask. Keep it
      // adjacent to this model's draw so another character cannot overwrite the
      // shared mask between the scene-wide update and render phases.
      this.liveModel.update();
      this.liveModel.draw();
      this.drawSerialValue += 1;
    } finally {
      // Cubism's mask pass mutates clear color, framebuffer, viewport, active
      // texture and raw GL state behind Three's cache. Restore the state that
      // matters before the pipeline invalidates the remainder of that cache.
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.viewport(...this.drawViewport);
      gl.clearColor(clearColor[0]!, clearColor[1]!, clearColor[2]!, clearColor[3]!);
      gl.colorMask(true, true, true, true);
      gl.depthMask(true);
      gl.disable(gl.CULL_FACE);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindVertexArray(null);
    }
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    this.resourceAbort.abort();
    this.resourceGeneration += 1;
    this.motionManager?.stopAllMotions();
    this.expressionManager?.stopAllMotions();
    for (const texture of this.textures) this.gl.deleteTexture(texture);
    this.textures.length = 0;
    this.motionCache.clear();
    this.expressionCache.clear();
    this.loadingMotions.clear();
    this.loadingExpressions.clear();
    this.motionRetries.clear();
    this.expressionRetries.clear();
    this.physicsHairs = [];
    this.motionManager = null;
    this.expressionManager = null;
    this.liveModel = null;
    this.initialized = false;
    const lease = this.glContextLease;
    this.glContextLease = null;
    if (lease) releaseCubism2Context(live2d(), lease);
  }
}
