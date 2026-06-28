import { LinearSRGBColorSpace, Matrix4, NoToneMapping, WebGLRenderer } from "three";
import {
  AdvCubismModel,
  type CubismDrawableBounds,
  type CubismParameterValue,
} from "../rendering/cubism/AdvCubismModel";
import { AdvHarmonicMotionController, type AdvHarmonicMotionData } from "../rendering/cubism/AdvHarmonicMotion";
import { UnityTargetFrameClock } from "../rendering/three/UnityTargetFrameClock";
import {
  DEFAULT_UNITY_CUBISM_LIGHTING,
  type UnityCubismLightingState,
} from "../rendering/cubism/UnityCubismAdvLighting";
import { acquireCubismShaderContext, releaseCubismShaderContext } from "../vendor/cubism/rendering/cubismshader_webgl";

const DEFAULT_TARGET_FRAME_RATE = 60;
const VISIBLE_MODEL_FILL = 0.93;
const FOCUS_EPSILON = 0.01;
const FOCUS_MAX_SPEED = 40 / 7.5;
const FOCUS_ACCELERATION_TIME = 1 / (0.15 * 1000);
const FALLBACK_FOCUS_ANCHOR_HEIGHT_RATIO = 0.75;

export interface CubismModelViewerLoadOptions {
  readonly modelUrl: string;
  readonly harmonicMotion?: AdvHarmonicMotionData | null;
  readonly defaultMotionName?: string;
  readonly defaultExpressionName?: string;
  readonly lighting?: UnityCubismLightingState;
  readonly maskBufferSize?: number;
  readonly anisotropy?: number;
}

export interface CubismModelViewerOptions {
  readonly canvas: HTMLCanvasElement;
  readonly targetFrameRate?: number;
  readonly onFrame?: () => void;
  readonly onContextLost?: () => void;
  readonly onContextRestored?: () => void;
  readonly onError?: (error: unknown) => void;
}

export interface CubismModelViewerTransform {
  readonly offsetX?: number;
  readonly offsetY?: number;
  readonly scale?: number;
}

export interface CubismModelViewerFocusAnchor {
  /** Model-local X coordinate, in the same Unity/Cubism space as drawable vertices. */
  readonly x?: number;
  /** Model-local Y coordinate, in the same Unity/Cubism space as drawable vertices. */
  readonly y?: number;
}

function finite(value: unknown, fallback = 0): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function safeDimension(value: unknown): number {
  return Math.max(1, Math.round(finite(value, 1)));
}

/**
 * Standalone Three/WebGL2 adapter for the same Cubism model implementation
 * used by the Unity ADV story scene. The class owns the render loop, resize,
 * context recovery and model resources; UI state stays in the Vue host.
 */
export class CubismModelViewer {
  readonly renderer: WebGLRenderer;

  private readonly canvas: HTMLCanvasElement;
  private readonly gl: WebGL2RenderingContext;
  private readonly targetFrameRate: number;
  private readonly frameClock = new UnityTargetFrameClock();
  private readonly harmonicMotion = new AdvHarmonicMotionController();
  private readonly mvp = new Matrix4();
  private readonly onFrame?: () => void;
  private readonly onContextLostCallback?: () => void;
  private readonly onContextRestoredCallback?: () => void;
  private readonly onError?: (error: unknown) => void;
  private model: AdvCubismModel | null = null;
  private loadOptions: CubismModelViewerLoadOptions | null = null;
  private modelBounds: CubismDrawableBounds | null = null;
  private parameterOverrides: Readonly<Record<string, number>> = {};
  private focusTargetX = 0;
  private focusTargetY = 0;
  private focusX = 0;
  private focusY = 0;
  private focusVelocityX = 0;
  private focusVelocityY = 0;
  private loopMotionName = "";
  private width = 1;
  private height = 1;
  private offsetX = 0;
  private offsetY = 0;
  private modelScale = 1;
  private breathEnabled = true;
  private eyeBlinkEnabled = true;
  private paused = false;
  private contextLost = false;
  private shaderContextAcquired = false;
  private renderFaulted = false;
  private destroyed = false;
  private animationFrame = 0;
  private previousFrameTime = 0;
  private loadGeneration = 0;

  constructor(options: CubismModelViewerOptions) {
    this.canvas = options.canvas;
    this.targetFrameRate = Math.max(1, finite(options.targetFrameRate, DEFAULT_TARGET_FRAME_RATE));
    this.onFrame = options.onFrame;
    this.onContextLostCallback = options.onContextLost;
    this.onContextRestoredCallback = options.onContextRestored;
    this.onError = options.onError;

    const context = this.canvas.getContext("webgl2", {
      alpha: true,
      antialias: true,
      depth: false,
      premultipliedAlpha: true,
      powerPreference: "high-performance",
      preserveDrawingBuffer: false,
      stencil: false,
    });
    if (!context) throw new Error("The Live2D model viewer requires WebGL2");
    this.gl = context;
    this.renderer = new WebGLRenderer({ canvas: this.canvas, context, alpha: true, antialias: true });
    this.renderer.outputColorSpace = LinearSRGBColorSpace;
    this.renderer.toneMapping = NoToneMapping;
    this.renderer.autoClear = false;
    this.renderer.setClearColor(0x000000, 0);
    this.acquireShaderContext();
    this.canvas.addEventListener("webglcontextlost", this.handleContextLost, false);
    this.canvas.addEventListener("webglcontextrestored", this.handleContextRestored, false);
    this.previousFrameTime = performance.now();
    this.animationFrame = requestAnimationFrame(this.animate);
  }

  get ready(): boolean {
    return Boolean(this.model) && !this.contextLost && !this.renderFaulted && !this.destroyed;
  }

  get isMotionPlaying(): boolean {
    return this.model?.isMotionPlaying ?? false;
  }

  get motionNames(): readonly string[] {
    return this.model ? [...this.model.motions.keys()] : [];
  }

  get expressionNames(): readonly string[] {
    return this.model ? [...this.model.expressions.keys()] : [];
  }

  async load(options: CubismModelViewerLoadOptions): Promise<void> {
    if (this.destroyed) throw new Error("A destroyed Cubism model viewer cannot load a model");
    const generation = ++this.loadGeneration;
    this.loadOptions = options;
    this.renderFaulted = false;
    this.releaseModel();
    this.harmonicMotion.configure(options.harmonicMotion);
    this.frameClock.reset();
    this.loopMotionName = "";

    const model = await AdvCubismModel.create({
      gl: this.gl,
      modelUrl: options.modelUrl,
      defaultMotionName: options.defaultMotionName,
      maskBufferSize: options.maskBufferSize,
      anisotropy: options.anisotropy,
      physics: true,
      breath: false,
      lighting: options.lighting ?? DEFAULT_UNITY_CUBISM_LIGHTING,
    });
    if (this.destroyed || generation !== this.loadGeneration || this.contextLost) {
      model.release();
      return;
    }

    this.model = model;
    model.setEyeBlinkEnabled(this.eyeBlinkEnabled);
    if (options.defaultMotionName) model.playMotion(options.defaultMotionName);
    if (options.defaultExpressionName) model.playExpression(options.defaultExpressionName);
    model.primeInitialFrame({ blends: this.breathEnabled ? this.harmonicMotion.current(model) : [] });
    this.modelBounds = model.drawableBounds(true) ?? model.drawableBounds(false) ?? model.canvasBounds();
    this.updateProjection();
    this.render();
  }

  unload(): void {
    this.loadGeneration += 1;
    this.loadOptions = null;
    this.releaseModel();
    this.clear();
  }

  setSize(pixelWidth: number, pixelHeight: number): void {
    const width = safeDimension(pixelWidth);
    const height = safeDimension(pixelHeight);
    if (this.width === width && this.height === height) return;
    this.width = width;
    this.height = height;
    this.renderer.setSize(width, height, false);
    this.updateProjection();
    this.render();
  }

  setTransform(transform: CubismModelViewerTransform): void {
    this.offsetX = finite(transform.offsetX, this.offsetX);
    this.offsetY = finite(transform.offsetY, this.offsetY);
    this.modelScale = Math.max(0.001, finite(transform.scale, this.modelScale));
    this.updateProjection();
    this.render();
  }

  setPaused(paused: boolean): void {
    this.paused = Boolean(paused);
    this.frameClock.reset();
    this.previousFrameTime = performance.now();
  }

  setBreathEnabled(enabled: boolean): void {
    this.breathEnabled = Boolean(enabled);
    this.evaluateWithoutAdvancing();
  }

  setEyeBlinkEnabled(enabled: boolean): void {
    this.eyeBlinkEnabled = Boolean(enabled);
    this.model?.setEyeBlinkEnabled(this.eyeBlinkEnabled);
    this.evaluateWithoutAdvancing();
  }

  setParameterOverrides(values: Readonly<Record<string, number>>): void {
    this.parameterOverrides = { ...values };
    this.evaluateWithoutAdvancing();
  }

  setLookPosition(x: number | null, y: number | null = x): void {
    this.focusTargetX = x == null ? 0 : Math.max(-1, Math.min(1, finite(x)));
    this.focusTargetY = y == null ? 0 : Math.max(-1, Math.min(1, finite(y)));
    // Pointer events can arrive faster and less regularly than animation
    // frames. Keep the RAF loop as the sole owner of focus integration and
    // model evaluation so mouse polling rate cannot alter the time step.
  }

  /**
   * Points the model from its projected head anchor towards a viewport client
   * position. The cached load-time drawable bounds keep the normalization
   * stable while motions deform individual drawables.
   */
  setLookAtClientPosition(clientX: number, clientY: number, anchor: CubismModelViewerFocusAnchor | null = null): void {
    const bounds = this.modelBounds;
    const rect = this.canvas.getBoundingClientRect();
    if (!bounds || !Number.isFinite(clientX) || !Number.isFinite(clientY) || rect.width <= 0 || rect.height <= 0) {
      this.setLookPosition(null);
      return;
    }

    const modelX = finite(anchor?.x, bounds.x + bounds.width * 0.5);
    const modelY = finite(anchor?.y, bounds.y + bounds.height * FALLBACK_FOCUS_ANCHOR_HEIGHT_RATIO);
    const elements = this.mvp.elements;
    const projectedX = elements[0] * modelX + elements[4] * modelY + elements[12];
    const projectedY = elements[1] * modelX + elements[5] * modelY + elements[13];
    const anchorClientX = rect.left + ((projectedX + 1) * rect.width) / 2;
    const anchorClientY = rect.top + ((1 - projectedY) * rect.height) / 2;

    // Normalize in the displayed model's own horizontal/vertical scale, then
    // clamp radially to preserve the cursor direction at and beyond full turn.
    const horizontalRange = Math.max(1, (Math.abs(elements[0]) * bounds.width * rect.width) / 4);
    const verticalRange = Math.max(1, (Math.abs(elements[5]) * bounds.height * rect.height) / 4);
    let targetX = (clientX - anchorClientX) / horizontalRange;
    let targetY = (anchorClientY - clientY) / verticalRange;
    const magnitude = Math.hypot(targetX, targetY);
    if (magnitude > 1) {
      targetX /= magnitude;
      targetY /= magnitude;
    }
    this.setLookPosition(targetX, targetY);
  }

  parameters(): CubismParameterValue[] {
    return this.model?.parameterValues() ?? [];
  }

  playMotion(name: string): boolean {
    return this.model?.playMotion(name) ?? false;
  }

  stopMotions(): void {
    this.loopMotionName = "";
    this.model?.stopMotions();
  }

  setLoopMotion(name: string | null): void {
    // Motions are loaded lazily, so checking only the populated motion cache
    // rejects the first loop request.  The model catalog is already available
    // from model3.json and is the authoritative existence check.
    this.loopMotionName = name && this.model?.hasMotion(name) ? name : "";
  }

  playExpression(name: string): boolean {
    return this.model?.playExpression(name) ?? false;
  }

  renderNow(): void {
    this.evaluateWithoutAdvancing();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.loadGeneration += 1;
    if (this.animationFrame) cancelAnimationFrame(this.animationFrame);
    this.animationFrame = 0;
    this.canvas.removeEventListener("webglcontextlost", this.handleContextLost, false);
    this.canvas.removeEventListener("webglcontextrestored", this.handleContextRestored, false);
    this.releaseModel();
    this.releaseShaderContext();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }

  private readonly animate = (time: number): void => {
    if (this.destroyed) return;
    const elapsedSeconds = Math.max(0, (time - this.previousFrameTime) / 1000);
    this.previousFrameTime = time;
    const focusChanged = this.advanceFocus(elapsedSeconds);
    const deltaSeconds = this.frameClock.advance(elapsedSeconds, this.targetFrameRate);
    if (!this.contextLost && !this.renderFaulted && (deltaSeconds != null || (this.paused && focusChanged))) {
      try {
        if (this.model && deltaSeconds != null && !this.paused) {
          this.updateModel(deltaSeconds);
          if (this.loopMotionName && !this.model.isMotionPlaying) this.model.playMotion(this.loopMotionName);
          this.render();
          this.onFrame?.();
        } else if (this.model && this.paused && focusChanged) {
          this.updateModel(0);
          this.render();
        }
      } catch (error) {
        this.renderFaulted = true;
        this.onError?.(error);
      }
    }
    this.animationFrame = requestAnimationFrame(this.animate);
  };

  private updateModel(deltaSeconds: number): void {
    const model = this.model;
    if (!model) return;
    const blends = this.breathEnabled ? this.harmonicMotion.advance(deltaSeconds, model) : [];
    model.update(deltaSeconds, {
      focusX: this.focusX,
      focusY: this.focusY,
      overrides: this.parameterOverrides,
      blends,
    });
  }

  private evaluateWithoutAdvancing(): void {
    const model = this.model;
    if (!model || this.contextLost || this.renderFaulted) return;
    const blends = this.breathEnabled ? this.harmonicMotion.current(model) : [];
    model.update(0, {
      focusX: this.focusX,
      focusY: this.focusY,
      overrides: this.parameterOverrides,
      blends,
    });
    this.render();
    this.onFrame?.();
  }

  /** Port of Cubism's focus controller acceleration and braking curve. */
  private advanceFocus(elapsedSeconds: number): boolean {
    const beforeX = this.focusX;
    const beforeY = this.focusY;
    const dx = this.focusTargetX - this.focusX;
    const dy = this.focusTargetY - this.focusY;
    if (Math.abs(dx) < FOCUS_EPSILON && Math.abs(dy) < FOCUS_EPSILON) {
      this.focusX = this.focusTargetX;
      this.focusY = this.focusTargetY;
      this.focusVelocityX = 0;
      this.focusVelocityY = 0;
      return beforeX !== this.focusX || beforeY !== this.focusY;
    }

    const milliseconds = Math.max(1, Math.min(100, elapsedSeconds * 1000));
    const distance = Math.sqrt(dx ** 2 + dy ** 2);
    const maximumSpeed = FOCUS_MAX_SPEED / (1000 / milliseconds);
    let accelerationX = maximumSpeed * (dx / distance) - this.focusVelocityX;
    let accelerationY = maximumSpeed * (dy / distance) - this.focusVelocityY;
    const acceleration = Math.sqrt(accelerationX ** 2 + accelerationY ** 2);
    const maximumAcceleration = maximumSpeed * FOCUS_ACCELERATION_TIME * milliseconds;
    if (acceleration > maximumAcceleration) {
      accelerationX *= maximumAcceleration / acceleration;
      accelerationY *= maximumAcceleration / acceleration;
    }

    this.focusVelocityX += accelerationX;
    this.focusVelocityY += accelerationY;
    const speed = Math.sqrt(this.focusVelocityX ** 2 + this.focusVelocityY ** 2);
    const brakingSpeed =
      0.5 * (Math.sqrt(maximumAcceleration ** 2 + 8 * maximumAcceleration * distance) - maximumAcceleration);
    if (speed > brakingSpeed) {
      this.focusVelocityX *= brakingSpeed / speed;
      this.focusVelocityY *= brakingSpeed / speed;
    }
    this.focusX += this.focusVelocityX;
    this.focusY += this.focusVelocityY;
    return beforeX !== this.focusX || beforeY !== this.focusY;
  }

  private updateProjection(): void {
    const bounds = this.modelBounds;
    if (!bounds) return;
    const fillScale = Math.min(this.width / bounds.width, this.height / bounds.height) * VISIBLE_MODEL_FILL;
    const pixelScale = fillScale * this.modelScale;
    const scaleX = (2 * pixelScale) / this.width;
    const scaleY = (2 * pixelScale) / this.height;
    const centerX = bounds.x + bounds.width * 0.5;
    const centerY = bounds.y + bounds.height * 0.5;
    this.mvp.set(
      scaleX,
      0,
      0,
      -centerX * scaleX + this.offsetX,
      0,
      scaleY,
      0,
      -centerY * scaleY - this.offsetY,
      0,
      0,
      1,
      0,
      0,
      0,
      0,
      1,
    );
  }

  private render(): void {
    const model = this.model;
    if (!model || this.contextLost || this.gl.isContextLost()) return;
    this.clear();
    this.renderer.resetState();
    this.gl.bindVertexArray(null);
    model.draw(this.mvp, null, [0, 0, this.width, this.height], [1, 1, 1, 1]);
    this.renderer.resetState();
  }

  private clear(): void {
    if (this.contextLost || this.gl.isContextLost()) return;
    this.renderer.setRenderTarget(null);
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.clear(true, false, false);
  }

  private releaseModel(): void {
    this.model?.release();
    this.model = null;
    this.modelBounds = null;
    this.parameterOverrides = {};
  }

  private acquireShaderContext(): void {
    if (this.shaderContextAcquired) return;
    acquireCubismShaderContext(this.gl);
    this.shaderContextAcquired = true;
  }

  private releaseShaderContext(): void {
    if (!this.shaderContextAcquired) return;
    releaseCubismShaderContext(this.gl);
    this.shaderContextAcquired = false;
  }

  private readonly handleContextLost = (event: Event): void => {
    event.preventDefault();
    this.contextLost = true;
    this.renderFaulted = false;
    this.loadGeneration += 1;
    this.releaseModel();
    this.releaseShaderContext();
    this.frameClock.reset();
    this.onContextLostCallback?.();
  };

  private readonly handleContextRestored = (): void => {
    if (this.destroyed) return;
    this.acquireShaderContext();
    this.contextLost = false;
    this.renderFaulted = false;
    this.previousFrameTime = performance.now();
    this.frameClock.reset();
    const options = this.loadOptions;
    if (!options) return;
    void this.load(options)
      .then(() => this.onContextRestoredCallback?.())
      .catch((error: unknown) => this.onError?.(error));
  };
}
