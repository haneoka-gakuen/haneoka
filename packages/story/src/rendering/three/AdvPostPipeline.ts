import {
  AddEquation,
  Camera,
  Color,
  CustomBlending,
  Mesh,
  NearestFilter,
  NoBlending,
  NoColorSpace,
  OneFactor,
  OneMinusSrcAlphaFactor,
  OrthographicCamera,
  PlaneGeometry,
  RGBAFormat,
  RepeatWrapping,
  Scene,
  ShaderMaterial,
  Texture,
  UnsignedByteType,
  Vector2,
  Vector4,
  WebGLRenderTarget,
  WebGLRenderer,
} from "three";
import type { ColorRepresentation, IUniform, TextureDataType } from "three";
import { AdvFinalPostFxaa } from "../post/AdvFinalPostFxaa";
import { AdvUrpPostProcessor } from "../post/AdvUrpPostProcessor";
import type { AdvColorGradingPipelineMode } from "../post/AdvUrpPostProcessor";
import type { AdvVolumeLayer } from "../post/AdvVolumeStack";
import type { AdvFieldTargetFormat } from "./AdvFieldTargetFormat";

type GlContext = WebGLRenderingContext | WebGL2RenderingContext;

export type AdvPhysicalViewport = readonly [x: number, y: number, width: number, height: number];

export interface AdvCubismFramebuffer {
  readonly renderer: WebGLRenderer;
  readonly gl: GlContext;
  readonly target: WebGLRenderTarget;
  readonly framebuffer: WebGLFramebuffer | null;
  readonly viewport: AdvPhysicalViewport;
  readonly width: number;
  readonly height: number;
}

interface MutableAdvCubismFramebuffer {
  renderer: WebGLRenderer;
  gl: GlContext;
  target: WebGLRenderTarget;
  framebuffer: WebGLFramebuffer | null;
  viewport: [x: number, y: number, width: number, height: number];
  width: number;
  height: number;
}

interface ThreeRenderTargetProperties {
  __webglFramebuffer?: WebGLFramebuffer | readonly WebGLFramebuffer[];
}

export interface AdvBlurSettings {
  readonly enabled: boolean;
  readonly background: number;
  /** Camera-distance lookup value applied by the Unity blur material. */
  readonly radiusMax: number;
}

export interface AdvCurvedLensSettings {
  readonly enabled: boolean;
  readonly center: Readonly<{ x: number; y: number }>;
  readonly intensity: number;
  readonly size: number;
  readonly softness: number;
  readonly horizontalRate: number;
  readonly verticalRate: number;
  readonly scale: number;
  readonly reverse: boolean;
}

export interface AdvPostPipelineEffects {
  readonly blur: AdvBlurSettings;
  readonly curvedLens: AdvCurvedLensSettings;
}

export interface AdvPostPipelineEffectPatch {
  readonly blur?: Partial<AdvBlurSettings>;
  readonly curvedLens?: Omit<Partial<AdvCurvedLensSettings>, "center"> & {
    readonly center?: Partial<AdvCurvedLensSettings["center"]>;
  };
}

export interface AdvPostPipelineOptions {
  readonly width?: number;
  readonly height?: number;
  readonly pixelRatio?: number;
  readonly effects?: AdvPostPipelineEffectPatch;
  /** AdvQualityConfig.SetAntialiasingFxAA: packaged FinalPost FXAA, not MSAA. */
  readonly finalPostFxaaEnabled?: boolean;
  /** Renderer-asset setting. Reference ADV assets use LDR; HDR remains explicitly opt-in. */
  readonly colorGradingMode?: AdvColorGradingPipelineMode;
  /** Capability-probed field buffer format. RGBA8 is the portable LDR fallback. */
  readonly fieldTargetFormat?: AdvFieldTargetFormat;
}

export interface AdvPostBeginOptions {
  readonly clearColor?: ColorRepresentation;
  readonly clearAlpha?: number;
  /** ScreenCaptureRenderPass redraw of the raw AdvBack layer, before field blur. */
  readonly captureStage?: boolean;
  readonly stageCaptureScene?: Scene;
  /** Command effects routed to Unity's AdvBack layer. */
  readonly advBackEffects?: AdvSceneLayer | null;
}

export interface AdvSceneLayer {
  readonly scene: Scene;
  readonly camera: Camera;
}

export interface AdvPostFinishOptions {
  /** Three objects which must be composited after the raw Cubism draw. */
  readonly foreground?: AdvSceneLayer | null;
  /** Command-owned particles/overlays rendered with their authored material. */
  readonly commandEffects?: AdvSceneLayer | null;
  /** UI-layer command effects composite after the ADV camera post stack. */
  readonly uiEffects?: AdvSceneLayer | null;
  /** Defaults to the renderer's canvas. */
  readonly outputTarget?: WebGLRenderTarget | null;
  readonly timeSeconds?: number;
}

export interface AdvCharacterGroupSettings {
  readonly blur: number;
  readonly alpha: number;
  readonly brightness: number;
  readonly radiusMax: number;
}

const FULLSCREEN_VERTEX = /* glsl */ `
varying vec2 vUv;

void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const OUTPUT_FRAGMENT = /* glsl */ `
uniform sampler2D tInput;
varying vec2 vUv;

void main() {
  gl_FragColor = texture2D(tInput, vUv);
}
`;

// Exact GLES3 math from Adv/DistanceAdaptiveLensBlur. The shipped field pass
// executes this 25-tap kernel twice; pass 1 differs only by +pi/3.
const DISTANCE_ADAPTIVE_LENS_BLUR_FRAGMENT = /* glsl */ `
uniform sampler2D tInput;
uniform vec2 uTexelSize;
uniform vec2 uScreenSize;
uniform float uBlurSize;
uniform float uBlurRadiusMax;
uniform float uBokehRadius;
uniform float uBokehEdgeBias;
uniform float uHighlightThreshold;
uniform float uHighlightBoost;
uniform float uChromaticAberration;
uniform float uUsePremultipliedAlphaBlur;
uniform float uPassAngleOffset;
varying vec2 vUv;

float advHash(vec2 pixel) {
  vec2 p = fract(pixel * vec2(123.339996, 456.209991));
  p += dot(p, p + vec2(45.3199997));
  return fract(p.x * p.y);
}

float highlightGain(vec3 rgb) {
  float highlight = clamp(
    (dot(rgb, vec3(0.212599993, 0.715200007, 0.0722000003)) - uHighlightThreshold) * 4.0,
    0.0,
    1.0
  );
  return 1.0 + highlight * uHighlightBoost;
}

vec4 sampleTap(vec2 uv, vec2 delta) {
  vec4 color = texture2D(tInput, uv);
  if (uChromaticAberration > 9.99999975e-05) {
    float amount = uChromaticAberration * 0.25;
    color.r = texture2D(tInput, uv + delta * amount).r;
    color.b = texture2D(tInput, uv - delta * amount).b;
  }
  return color;
}

void addTap(
  vec2 delta,
  float radiusRate,
  float baseWeight,
  inout vec3 colorSum,
  inout float alphaSum,
  inout float weightSum
) {
  vec4 color = sampleTap(vUv + delta, delta);
  float weight = baseWeight * (1.0 + uBokehEdgeBias * radiusRate) * highlightGain(color.rgb);
  // Preserve the input encoding while filtering. Character targets are
  // already premultiplied, so multiplying RGB by alpha here a second time
  // produces dark fringes and makes thin components appear to disappear.
  colorSum += color.rgb * weight;
  alphaSum += color.a * weight;
  weightSum += weight;
}

void main() {
  vec4 center = texture2D(tInput, vUv);
  float blur = clamp(uBlurSize, 0.0, 10.0);
  if (blur <= 9.99999975e-05) {
    gl_FragColor = center;
    return;
  }

  vec2 radius = blur * uBlurRadiusMax * uBokehRadius * uTexelSize;
  float jitter = (advHash(floor(vUv * uScreenSize)) - 0.5) * 0.0299999993 + uPassAngleOffset;
  float centerHighlight = clamp(
    (dot(center.rgb, vec3(0.212599993, 0.715200007, 0.0722000003)) - uHighlightThreshold) * 4.0,
    0.0,
    1.0
  ) * uHighlightBoost;
  float centerWeight = (1.0 + centerHighlight * 0.400000006) * 0.5;
  vec3 colorSum = center.rgb * centerWeight;
  float alphaSum = center.a * centerWeight;
  float weightSum = centerWeight;

  for (int index = 0; index < 8; ++index) {
    float angle = jitter + float(index) * ${Math.PI / 4};
    vec2 direction = vec2(cos(angle), sin(angle));
    addTap(direction * radius * 0.400000006, 0.400000006, 0.0500000007,
      colorSum, alphaSum, weightSum);
    addTap(direction * radius * 0.720000029, 0.720000029, 0.0599999987,
      colorSum, alphaSum, weightSum);
    addTap(direction * radius, 1.0, 0.0700000003,
      colorSum, alphaSum, weightSum);
  }

  float safeWeight = max(weightSum, 9.99999975e-06);
  float outputAlpha = alphaSum / safeWeight;
  vec3 outputRgb = colorSum / safeWeight;
  gl_FragColor = vec4(outputRgb, outputAlpha);
}
`;

const COMPOSITE_FRAGMENT = /* glsl */ `
uniform sampler2D tInput;
uniform float uBrightness;
uniform float uAlpha;
varying vec2 vUv;

void main() {
  vec4 color = texture2D(tInput, vUv);
  // The character target is premultiplied. Group opacity therefore scales RGB
  // and alpha together before ONE / ONE_MINUS_SRC_ALPHA compositing.
  gl_FragColor = color * vec4(
    uBrightness * uAlpha,
    uBrightness * uAlpha,
    uBrightness * uAlpha,
    uAlpha
  );
}
`;

// UV math and parameter packing from the CurvedLens GLES3 ShaderSubProgram.
// It is intentionally a separate final pass because the original enqueues it
// after URP post processing (renderPassEvent 600).
const CURVED_LENS_FRAGMENT = /* glsl */ `
uniform sampler2D tInput;
uniform vec2 uResolution;
uniform vec4 uLens1; // center.xy, intensity, size
uniform vec4 uLens2; // softness, horizontalRate, verticalRate, scale
uniform float uReverse;
varying vec2 vUv;

void main() {
  vec2 center = uLens1.xy;
  float softness = max(uLens2.x, 0.0001);
  float scale = max(uLens2.w, 0.001);
  vec2 delta = (vUv - center) / scale;
  vec2 lensDelta = delta * uLens2.yz;
  lensDelta.x *= uResolution.x / max(uResolution.y, 1.0);
  float radiusSquared = dot(lensDelta, lensDelta);
  float fade = smoothstep(0.0, 1.0, clamp((sqrt(radiusSquared) - uLens1.w) / softness, 0.0, 1.0));
  float signedIntensity = uReverse > 0.5 ? -uLens1.z : uLens1.z;
  float distortion = max(1.0 + radiusSquared * signedIntensity * fade, 0.001);
  vec2 uv = center + delta * distortion;
  gl_FragColor = texture2D(tInput, uv);
}
`;

const DEFAULT_EFFECTS: AdvPostPipelineEffects = {
  blur: { enabled: false, background: 0, radiusMax: 0.75 },
  curvedLens: {
    enabled: false,
    center: { x: 0.5, y: 0.5 },
    intensity: 0,
    size: 0.35,
    softness: 0.2,
    horizontalRate: 1,
    verticalRate: 0.15,
    scale: 1,
    reverse: true,
  },
};

interface InputUniforms {
  readonly [name: string]: IUniform<unknown>;
  readonly tInput: IUniform<Texture | null>;
}

interface BlurUniforms extends InputUniforms {
  readonly uTexelSize: IUniform<Vector2>;
  readonly uScreenSize: IUniform<Vector2>;
  readonly uBlurSize: IUniform<number>;
  readonly uBlurRadiusMax: IUniform<number>;
  readonly uBokehRadius: IUniform<number>;
  readonly uBokehEdgeBias: IUniform<number>;
  readonly uHighlightThreshold: IUniform<number>;
  readonly uHighlightBoost: IUniform<number>;
  readonly uChromaticAberration: IUniform<number>;
  readonly uUsePremultipliedAlphaBlur: IUniform<number>;
  readonly uPassAngleOffset: IUniform<number>;
}

interface CompositeUniforms extends InputUniforms {
  readonly uBrightness: IUniform<number>;
  readonly uAlpha: IUniform<number>;
}

interface CurvedLensUniforms extends InputUniforms {
  readonly uResolution: IUniform<Vector2>;
  readonly uLens1: IUniform<Vector4>;
  readonly uLens2: IUniform<Vector4>;
  readonly uReverse: IUniform<number>;
}

function finite(value: number | undefined, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function nonNegative(value: number | undefined, fallback = 0): number {
  return Math.max(0, finite(value, fallback));
}

function clamp01(value: number | undefined, fallback = 0): number {
  return Math.max(0, Math.min(1, finite(value, fallback)));
}

/** Mathf.RoundToInt uses banker's rounding for exact .5 ties. */
function roundToNearestEven(value: number): number {
  const lower = Math.floor(value);
  const fraction = value - lower;
  if (fraction < 0.5) return lower;
  if (fraction > 0.5) return lower + 1;
  return lower % 2 === 0 ? lower : lower + 1;
}

function createTarget(
  name: string,
  depthBuffer: boolean,
  type: TextureDataType,
  normalized = false,
): WebGLRenderTarget {
  const target = new WebGLRenderTarget(1, 1, {
    depthBuffer,
    stencilBuffer: false,
    format: RGBAFormat,
    type,
    minFilter: NearestFilter,
    magFilter: NearestFilter,
    samples: 0,
  });
  target.texture.name = name;
  target.texture.normalized = normalized;
  target.texture.generateMipmaps = false;
  target.texture.colorSpace = NoColorSpace;
  return target;
}

function createMaterial(fragmentShader: string, uniforms: Record<string, IUniform<unknown>>): ShaderMaterial {
  return new ShaderMaterial({
    vertexShader: FULLSCREEN_VERTEX,
    fragmentShader,
    uniforms,
    depthTest: false,
    depthWrite: false,
    blending: NoBlending,
    transparent: false,
    toneMapped: false,
  });
}

function copyEffects(source: AdvPostPipelineEffects): AdvPostPipelineEffects {
  return {
    blur: { ...source.blur },
    curvedLens: { ...source.curvedLens, center: { ...source.curvedLens.center } },
  };
}

/**
 * Owns the ADV offscreen buffers and the state boundary between Three and the
 * official Cubism WebGL renderer. A frame is deliberately split into begin()
 * and finish(): Cubism draws directly into the framebuffer returned by begin().
 */
export class AdvPostPipeline {
  readonly renderer: WebGLRenderer;

  // AdvFieldRenderPass.Setup forces depthBufferBits=0 for all four RTs.
  private readonly mainTarget: WebGLRenderTarget;
  private readonly temporaryTarget: WebGLRenderTarget;
  private readonly characterBlurTarget: WebGLRenderTarget;
  private readonly backgroundBlurTarget: WebGLRenderTarget;
  private stageCaptureTarget: WebGLRenderTarget | null = null;
  private readonly fullscreenScene = new Scene();
  private readonly fullscreenCamera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly fullscreenGeometry = new PlaneGeometry(2, 2);
  private readonly outputUniforms: InputUniforms = { tInput: { value: null } };
  private readonly blurUniforms: BlurUniforms = {
    tInput: { value: null },
    uTexelSize: { value: new Vector2(1, 1) },
    uScreenSize: { value: new Vector2(1, 1) },
    uBlurSize: { value: 0 },
    uBlurRadiusMax: { value: 0.75 },
    uBokehRadius: { value: 0.9 },
    uBokehEdgeBias: { value: 0.05 },
    uHighlightThreshold: { value: 0.7 },
    uHighlightBoost: { value: 0.28 },
    uChromaticAberration: { value: 0 },
    uUsePremultipliedAlphaBlur: { value: 0 },
    uPassAngleOffset: { value: 0 },
  };
  private readonly compositeUniforms: CompositeUniforms = {
    tInput: { value: null },
    uBrightness: { value: 1 },
    uAlpha: { value: 1 },
  };
  private readonly curvedLensUniforms: CurvedLensUniforms = {
    tInput: { value: null },
    uResolution: { value: new Vector2(1, 1) },
    uLens1: { value: new Vector4(0.5, 0.5, 0, 0.35) },
    uLens2: { value: new Vector4(0.2, 1, 0.15, 1) },
    uReverse: { value: 1 },
  };
  private readonly outputMaterial: ShaderMaterial;
  private readonly blurMaterial: ShaderMaterial;
  private readonly compositeMaterial: ShaderMaterial;
  private readonly curvedLensMaterial: ShaderMaterial;
  private readonly urpPostProcessor = new AdvUrpPostProcessor();
  private readonly finalPostFxaa = new AdvFinalPostFxaa();
  private readonly fullscreenQuad: Mesh<PlaneGeometry, ShaderMaterial>;
  private readonly savedClearColor = new Color();
  private readonly savedViewport = new Vector4();
  private readonly savedScissor = new Vector4();
  private readonly cubismFrames = new Map<WebGLRenderTarget, MutableAdvCubismFramebuffer>();
  private readonly renderFullscreenCallback = (
    material: ShaderMaterial,
    target: WebGLRenderTarget | null,
    clear: boolean,
  ): void => this.renderFullscreen(material, target, clear);

  private effects = copyEffects(DEFAULT_EFFECTS);
  private physicalWidth = 1;
  private physicalHeight = 1;
  private cssWidth = 1;
  private cssHeight = 1;
  private pixelRatio = 1;
  private frameActive = false;
  private disposed = false;
  private characterGroupActive = false;
  private characterGroupIsolated = false;
  private activeCubismTarget: WebGLRenderTarget | null = null;
  private activeCamera: Camera | null = null;
  private previousRenderTarget: WebGLRenderTarget | null = null;
  private previousActiveCubeFace = 0;
  private previousActiveMipmapLevel = 0;
  private previousAutoClear = true;
  private previousScissorTest = false;
  private finalPostFxaaEnabled = false;
  private lastOutputTarget: WebGLRenderTarget;

  constructor(renderer: WebGLRenderer, options: AdvPostPipelineOptions = {}) {
    this.renderer = renderer;
    const fieldTargetFormat = options.fieldTargetFormat;
    if (!fieldTargetFormat) throw new Error("AdvPostPipeline requires a capability-probed field target format");
    this.mainTarget = createTarget(
      "adv-field-main",
      false,
      fieldTargetFormat.textureType,
      fieldTargetFormat.normalized,
    );
    this.lastOutputTarget = this.mainTarget;
    this.temporaryTarget = createTarget(
      "adv-field-temporary",
      false,
      fieldTargetFormat.textureType,
      fieldTargetFormat.normalized,
    );
    this.characterBlurTarget = createTarget(
      "adv-field-character-blur",
      false,
      fieldTargetFormat.textureType,
      fieldTargetFormat.normalized,
    );
    this.backgroundBlurTarget = createTarget(
      "adv-field-background-blur",
      false,
      fieldTargetFormat.textureType,
      fieldTargetFormat.normalized,
    );
    this.outputMaterial = createMaterial(OUTPUT_FRAGMENT, this.outputUniforms);
    this.blurMaterial = createMaterial(DISTANCE_ADAPTIVE_LENS_BLUR_FRAGMENT, this.blurUniforms);
    this.compositeMaterial = createMaterial(COMPOSITE_FRAGMENT, this.compositeUniforms);
    this.compositeMaterial.transparent = true;
    this.compositeMaterial.premultipliedAlpha = true;
    this.compositeMaterial.blending = CustomBlending;
    this.compositeMaterial.blendEquation = AddEquation;
    this.compositeMaterial.blendSrc = OneFactor;
    this.compositeMaterial.blendDst = OneMinusSrcAlphaFactor;
    this.compositeMaterial.blendEquationAlpha = AddEquation;
    this.compositeMaterial.blendSrcAlpha = OneFactor;
    this.compositeMaterial.blendDstAlpha = OneMinusSrcAlphaFactor;
    this.curvedLensMaterial = createMaterial(CURVED_LENS_FRAGMENT, this.curvedLensUniforms);
    this.fullscreenQuad = new Mesh(this.fullscreenGeometry, this.outputMaterial);
    this.fullscreenQuad.frustumCulled = false;
    this.fullscreenScene.add(this.fullscreenQuad);
    this.finalPostFxaaEnabled = options.finalPostFxaaEnabled === true;
    this.urpPostProcessor.setColorGradingMode(options.colorGradingMode ?? "ldr");
    this.setEffects(options.effects ?? {});
    this.setSize(options.width ?? 1, options.height ?? 1, options.pixelRatio ?? 1);
  }

  get width(): number {
    return this.cssWidth;
  }

  get height(): number {
    return this.cssHeight;
  }

  get framebufferWidth(): number {
    return this.physicalWidth;
  }

  get framebufferHeight(): number {
    return this.physicalHeight;
  }

  get outputTexture(): Texture {
    return this.lastOutputTarget.texture;
  }

  get currentEffects(): AdvPostPipelineEffects {
    return copyEffects(this.effects);
  }

  setSize(width: number, height: number, pixelRatio = this.pixelRatio): void {
    this.assertUsable();
    if (this.frameActive) throw new Error("Cannot resize AdvPostPipeline during an active frame");
    this.cssWidth = Math.max(1, finite(width, 1));
    this.cssHeight = Math.max(1, finite(height, 1));
    this.pixelRatio = Math.max(0.1, finite(pixelRatio, 1));

    const requestedWidth = Math.max(1, Math.round(this.cssWidth * this.pixelRatio));
    const requestedHeight = Math.max(1, Math.round(this.cssHeight * this.pixelRatio));
    const maximum = Math.max(1, this.renderer.capabilities.maxTextureSize);
    const scale = Math.min(1, maximum / requestedWidth, maximum / requestedHeight);
    const physicalWidth = Math.max(1, Math.round(requestedWidth * scale));
    const physicalHeight = Math.max(1, Math.round(requestedHeight * scale));
    if (physicalWidth === this.physicalWidth && physicalHeight === this.physicalHeight) return;

    this.physicalWidth = physicalWidth;
    this.physicalHeight = physicalHeight;

    this.mainTarget.setSize(this.physicalWidth, this.physicalHeight);
    this.temporaryTarget.setSize(this.physicalWidth, this.physicalHeight);
    // The RendererFeature constructor and its serialized data both request
    // 0.5-scale blur buffers. Keep the full-resolution main/temp pair.
    const blurWidth = Math.max(1, roundToNearestEven(this.physicalWidth * 0.5));
    const blurHeight = Math.max(1, roundToNearestEven(this.physicalHeight * 0.5));
    this.characterBlurTarget.setSize(blurWidth, blurHeight);
    this.backgroundBlurTarget.setSize(blurWidth, blurHeight);
    this.blurUniforms.uTexelSize.value.set(1 / this.physicalWidth, 1 / this.physicalHeight);
    this.blurUniforms.uScreenSize.value.set(this.physicalWidth, this.physicalHeight);
    this.curvedLensUniforms.uResolution.value.set(this.physicalWidth, this.physicalHeight);
  }

  setEffects(patch: AdvPostPipelineEffectPatch): void {
    this.assertUsable();
    const current = this.effects;
    this.effects = {
      blur: { ...current.blur, ...(patch.blur ?? {}) },
      curvedLens: {
        ...current.curvedLens,
        ...(patch.curvedLens ?? {}),
        center: { ...current.curvedLens.center, ...(patch.curvedLens?.center ?? {}) },
      },
    };
  }

  resetEffects(): void {
    this.assertUsable();
    this.effects = copyEffects(DEFAULT_EFFECTS);
  }

  setFinalPostFxaaEnabled(enabled: boolean): void {
    this.assertUsable();
    this.finalPostFxaaEnabled = Boolean(enabled);
  }

  setColorGradingMode(mode: AdvColorGradingPipelineMode): void {
    this.assertUsable();
    this.urpPostProcessor.setColorGradingMode(mode);
  }

  setVolumeLayers(layers: readonly AdvVolumeLayer[]): void {
    this.assertUsable();
    this.urpPostProcessor.setVolumeLayers(layers);
  }

  /** Starts the Unity field pass and renders the background layer. */
  begin(background: Scene, camera: Camera, options: AdvPostBeginOptions = {}): AdvCubismFramebuffer {
    this.beginBackground(background, camera, options);
    return this.exposeCubismTarget(this.mainTarget);
  }

  /** Starts a field frame when the caller will open explicit character groups. */
  beginBackground(background: Scene, camera: Camera, options: AdvPostBeginOptions = {}): void {
    this.assertUsable();
    if (this.frameActive) throw new Error("AdvPostPipeline.begin() called before the previous frame was finished");

    this.frameActive = true;
    this.activeCamera = camera;
    this.previousRenderTarget = this.renderer.getRenderTarget();
    this.previousActiveCubeFace = this.renderer.getActiveCubeFace();
    this.previousActiveMipmapLevel = this.renderer.getActiveMipmapLevel();
    this.previousAutoClear = this.renderer.autoClear;
    this.previousScissorTest = this.renderer.getScissorTest();
    this.renderer.getViewport(this.savedViewport);
    this.renderer.getScissor(this.savedScissor);
    // Cubism 2/3 model construction and asynchronous texture uploads issue raw
    // WebGL calls between animation frames. Three's state cache cannot observe
    // those calls, so the next background pass could incorrectly skip binding
    // its framebuffer/program and present the canvas clear color as a full
    // black frame. Preserve the caller's logical state above, then invalidate
    // Three's cache at the start of every owned frame before any field draw.
    this.renderer.resetState();
    this.renderer.autoClear = false;

    try {
      this.clearTarget(this.mainTarget, options.clearColor ?? 0x000000, finite(options.clearAlpha, 1));
      this.bindTarget(this.mainTarget);
      this.renderer.render(background, camera);
      if (options.advBackEffects) this.renderSceneLayer(options.advBackEffects, this.mainTarget);
      if (options.captureStage) {
        this.captureStageBackground(options.stageCaptureScene ?? background, camera, options.advBackEffects);
      }
      this.applyBackgroundEffects();
      this.activeCubismTarget = this.mainTarget;
    } catch (error: unknown) {
      this.restoreRendererState();
      throw error;
    }
  }

  /** Copies the post-background field before any live Cubism character draw. */
  captureStageBackground(background: Scene, camera: Camera, advBackEffects?: AdvSceneLayer | null): void {
    this.assertUsable();
    if (!this.frameActive || this.characterGroupActive) {
      throw new Error("captureStageBackground() requires an active field before characters");
    }
    const previous = this.stageCaptureTarget;
    const capture = createTarget("adv-stage-capture", false, UnsignedByteType);
    capture.texture.wrapS = RepeatWrapping;
    capture.texture.wrapT = RepeatWrapping;
    capture.setSize(this.physicalWidth, this.physicalHeight);
    this.stageCaptureTarget = capture;
    this.clearTarget(capture, 0x000000, 0);
    this.bindTarget(capture);
    this.renderer.render(background, camera);
    if (advBackEffects) this.renderSceneLayer(advBackEffects, capture);
    this.bindTarget(this.mainTarget);
    previous?.dispose();
  }

  /** AdvFieldRenderPass AlphaBlend: old capture over the new field, before characters. */
  compositeStageCapture(alpha: number): void {
    this.assertUsable();
    if (!this.frameActive || this.characterGroupActive) {
      throw new Error("compositeStageCapture() requires an active field before characters");
    }
    const opacity = clamp01(alpha);
    const capture = this.stageCaptureTarget;
    if (opacity <= 0 || !capture) return;
    this.compositeUniforms.tInput.value = capture.texture;
    this.compositeUniforms.uBrightness.value = 1;
    this.compositeUniforms.uAlpha.value = opacity;
    this.renderFullscreen(this.compositeMaterial, this.mainTarget, false);
  }

  /**
   * Starts one adjacent Unity character-entry group. Groups with default
   * alpha/brightness/blur draw directly into mainRT; affected groups use the
   * full-size tempRT and are composited in finishCharacterGroup().
   */
  beginCharacterGroup(settings: AdvCharacterGroupSettings): AdvCubismFramebuffer {
    this.assertUsable();
    if (!this.frameActive) throw new Error("beginCharacterGroup() requires an active field frame");
    if (this.characterGroupActive) throw new Error("Character groups cannot be nested");
    const blur = nonNegative(settings.blur);
    const alpha = clamp01(settings.alpha, 1);
    const brightness = nonNegative(settings.brightness, 1);
    this.characterGroupIsolated = blur > 0 || alpha < 1 || brightness < 1;
    this.characterGroupActive = true;
    this.activeCubismTarget = this.characterGroupIsolated ? this.temporaryTarget : this.mainTarget;
    if (this.characterGroupIsolated) this.clearTarget(this.temporaryTarget, 0x000000, 0);
    return this.exposeCubismTarget(this.activeCubismTarget);
  }

  /** Re-establish the raw WebGL boundary before every individual model draw. */
  prepareCubismDraw(frame: AdvCubismFramebuffer): void {
    this.assertUsable();
    if (!this.frameActive || !this.characterGroupActive || frame.target !== this.activeCubismTarget) {
      throw new Error("prepareCubismDraw() requires the active character-group framebuffer");
    }
    this.renderer.resetState();
    this.bindTarget(frame.target);
    frame.gl.bindFramebuffer(frame.gl.FRAMEBUFFER, frame.framebuffer);
    frame.gl.viewport(...frame.viewport);
    (frame.gl as WebGL2RenderingContext).bindVertexArray(null);
  }

  /** Applies the exact field AlphaBlend material to the current group. */
  finishCharacterGroup(settings: AdvCharacterGroupSettings): void {
    this.assertUsable();
    if (!this.frameActive || !this.characterGroupActive) {
      throw new Error("finishCharacterGroup() requires an active character group");
    }
    try {
      // Cubism mutates program/VAO/texture/blend state behind Three's cache.
      this.renderer.resetState();
      if (!this.characterGroupIsolated) return;
      const blur = nonNegative(settings.blur);
      if (blur > 0.0001) {
        this.blurInPlace(
          this.temporaryTarget,
          this.characterBlurTarget,
          blur,
          Math.max(0, finite(settings.radiusMax, 0.75)),
          true,
        );
      }
      this.compositeUniforms.tInput.value = this.temporaryTarget.texture;
      this.compositeUniforms.uBrightness.value = nonNegative(settings.brightness, 1);
      this.compositeUniforms.uAlpha.value = clamp01(settings.alpha, 1);
      this.renderFullscreen(this.compositeMaterial, this.mainTarget, false);
    } finally {
      this.characterGroupActive = false;
      this.characterGroupIsolated = false;
      this.activeCubismTarget = null;
    }
  }

  /** Draws Camera1..5 command effects into the current character group RT. */
  renderCharacterLayer(layer: AdvSceneLayer): void {
    this.assertUsable();
    if (!this.frameActive || !this.characterGroupActive || !this.activeCubismTarget) {
      throw new Error("renderCharacterLayer() requires an active character group");
    }
    // Cubism submits raw WebGL commands, so invalidate Three's cached state
    // before drawing the routed particle hierarchy into the same target.
    this.renderer.resetState();
    this.renderSceneLayer(layer, this.activeCubismTarget);
    // The next character is submitted by raw Cubism GL. Detach Three's VAO
    // and invalidate its cache again so Cubism's attribute pointers cannot
    // mutate a Three-owned VAO after an interleaved character effect.
    this.renderer.resetState();
    this.bindTarget(this.activeCubismTarget);
    (this.renderer.getContext() as WebGL2RenderingContext).bindVertexArray(null);
  }

  /** Completes layer compositing and writes the final image to the requested target. */
  finish(options: AdvPostFinishOptions = {}): Texture {
    this.assertUsable();
    if (!this.frameActive) {
      throw new Error("AdvPostPipeline.finish() requires an active frame from begin()");
    }
    if (this.characterGroupActive) throw new Error("finish() called before finishCharacterGroup()");

    try {
      this.renderer.resetState();

      if (options.foreground) this.renderSceneLayer(options.foreground, this.mainTarget);
      if (options.commandEffects) this.renderSceneLayer(options.commandEffects, this.mainTarget);

      // The ADV camera has m_RenderPostProcessing=1. Compatibility-mode URP
      // builds the 16^3 LUT, bloom pyramid and UberPost before the custom
      // CurvedLens RendererFeature (RenderPassEvent 600).
      let source = this.urpPostProcessor.render(
        this.mainTarget,
        this.temporaryTarget,
        this.renderFullscreenCallback,
        this.activeCamera,
      );
      if (this.curvedLensActive()) {
        this.configureCurvedLensUniforms();
        const destination = source === this.mainTarget ? this.temporaryTarget : this.mainTarget;
        this.curvedLensUniforms.tInput.value = source.texture;
        this.renderFullscreen(this.curvedLensMaterial, destination, true);
        source = destination;
      }
      if (this.finalPostFxaaEnabled) {
        const destination = source === this.mainTarget ? this.temporaryTarget : this.mainTarget;
        this.finalPostFxaa.render(source, destination, this.renderFullscreenCallback);
        source = destination;
      }
      if (options.uiEffects) this.renderSceneLayer(options.uiEffects, source);

      this.lastOutputTarget = source;
      const outputTarget = options.outputTarget ?? null;
      if (outputTarget !== source) {
        this.outputUniforms.tInput.value = source.texture;
        this.renderFullscreen(this.outputMaterial, outputTarget, true);
      }
      return source.texture;
    } finally {
      this.restoreRendererState();
    }
  }

  /** Restores Three state when a caller abandons a frame after begin(). */
  abortFrame(): void {
    if (!this.frameActive) return;
    this.restoreRendererState();
  }

  dispose(): void {
    if (this.disposed) return;
    this.abortFrame();
    this.mainTarget.dispose();
    this.temporaryTarget.dispose();
    this.characterBlurTarget.dispose();
    this.backgroundBlurTarget.dispose();
    this.stageCaptureTarget?.dispose();
    this.stageCaptureTarget = null;
    this.cubismFrames.clear();
    this.outputMaterial.dispose();
    this.blurMaterial.dispose();
    this.compositeMaterial.dispose();
    this.curvedLensMaterial.dispose();
    this.urpPostProcessor.dispose();
    this.finalPostFxaa.dispose();
    this.fullscreenGeometry.dispose();
    this.fullscreenScene.remove(this.fullscreenQuad);
    this.disposed = true;
  }

  private assertUsable(): void {
    if (this.disposed) throw new Error("AdvPostPipeline has been disposed");
  }

  private backgroundBlurValue(): number {
    return this.effects.blur.enabled ? nonNegative(this.effects.blur.background) : 0;
  }

  private applyBackgroundEffects(): void {
    const blur = this.backgroundBlurValue();
    if (blur > 0) {
      this.blurInPlace(
        this.mainTarget,
        this.backgroundBlurTarget,
        blur,
        Math.max(0, finite(this.effects.blur.radiusMax, 0.75)),
        false,
      );
    }
  }

  private blurInPlace(
    target: WebGLRenderTarget,
    intermediate: WebGLRenderTarget,
    strength: number,
    radiusMax: number,
    premultipliedAlpha: boolean,
  ): void {
    // AdvFieldRenderPass writes the two properties independently. Both pass
    // programs use the same radial kernel; pass 1 rotates it by pi/3.
    this.blurUniforms.uBlurSize.value = strength;
    this.blurUniforms.uBlurRadiusMax.value = radiusMax;
    this.blurUniforms.uUsePremultipliedAlphaBlur.value = premultipliedAlpha ? 1 : 0;
    this.blurUniforms.uPassAngleOffset.value = 0;
    this.blurUniforms.tInput.value = target.texture;
    this.blurUniforms.uTexelSize.value.set(1 / target.width, 1 / target.height);
    this.renderFullscreen(this.blurMaterial, intermediate, true);

    this.blurUniforms.uPassAngleOffset.value = Math.PI / 3;
    this.blurUniforms.tInput.value = intermediate.texture;
    this.blurUniforms.uTexelSize.value.set(1 / intermediate.width, 1 / intermediate.height);
    this.renderFullscreen(this.blurMaterial, target, true);
  }

  private curvedLensActive(): boolean {
    const lens = this.effects.curvedLens;
    return (
      lens.enabled &&
      Math.abs(finite(lens.intensity)) > 0.0001 &&
      (nonNegative(lens.horizontalRate) > 0.0001 || nonNegative(lens.verticalRate) > 0.0001)
    );
  }

  private configureCurvedLensUniforms(): void {
    const lens = this.effects.curvedLens;
    this.curvedLensUniforms.uLens1.value.set(
      finite(lens.center.x, 0.5),
      finite(lens.center.y, 0.5),
      finite(lens.intensity),
      nonNegative(lens.size, 0.35),
    );
    this.curvedLensUniforms.uLens2.value.set(
      Math.max(0.0001, nonNegative(lens.softness, 0.2)),
      nonNegative(lens.horizontalRate),
      nonNegative(lens.verticalRate),
      Math.max(0.001, nonNegative(lens.scale, 1)),
    );
    this.curvedLensUniforms.uReverse.value = lens.reverse ? 1 : 0;
  }

  private exposeCubismTarget(target: WebGLRenderTarget): AdvCubismFramebuffer {
    // resetState unbinds Three's FBO and VAO. Rebind immediately before
    // handing the shared context to Cubism's raw WebGL renderer.
    this.renderer.resetState();
    this.bindTarget(target);
    const gl = this.renderer.getContext() as GlContext;
    (gl as WebGL2RenderingContext).bindVertexArray(null);
    const properties = this.renderer.properties.get(target) as ThreeRenderTargetProperties;
    const internalFramebuffer = properties.__webglFramebuffer;
    // These are ordinary 2D, single-mip targets. Reading Three's initialized
    // target property avoids a synchronous gl.getParameter driver round-trip;
    // retain the query only as a defensive fallback for an unexpected target.
    const framebuffer = Array.isArray(internalFramebuffer)
      ? (gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null)
      : (internalFramebuffer ?? (gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null));
    let frame = this.cubismFrames.get(target);
    if (!frame) {
      frame = {
        renderer: this.renderer,
        gl,
        target,
        framebuffer,
        viewport: [0, 0, target.width, target.height],
        width: target.width,
        height: target.height,
      };
      this.cubismFrames.set(target, frame);
    } else {
      frame.gl = gl;
      frame.framebuffer = framebuffer;
      frame.width = target.width;
      frame.height = target.height;
    }
    const viewport = target.viewport;
    frame.viewport[0] = viewport.x;
    frame.viewport[1] = viewport.y;
    frame.viewport[2] = viewport.z;
    frame.viewport[3] = viewport.w;
    return frame;
  }

  private renderSceneLayer(layer: AdvSceneLayer, target: WebGLRenderTarget): void {
    this.bindTarget(target);
    this.renderer.render(layer.scene, layer.camera);
  }

  private renderFullscreen(material: ShaderMaterial, target: WebGLRenderTarget | null, clear: boolean): void {
    this.fullscreenQuad.material = material;
    this.renderer.setRenderTarget(target);
    this.renderer.setScissorTest(false);
    if (clear) this.renderer.clear(true, false, false);
    this.renderer.render(this.fullscreenScene, this.fullscreenCamera);
  }

  private bindTarget(target: WebGLRenderTarget): void {
    this.renderer.setRenderTarget(target);
    this.renderer.setScissorTest(false);
  }

  private clearTarget(target: WebGLRenderTarget, color: ColorRepresentation, alpha: number): void {
    this.renderer.getClearColor(this.savedClearColor);
    const previousAlpha = this.renderer.getClearAlpha();
    try {
      this.renderer.setClearColor(color, Math.max(0, Math.min(1, alpha)));
      this.bindTarget(target);
      this.renderer.clear(true, true, true);
    } finally {
      this.renderer.setClearColor(this.savedClearColor, previousAlpha);
    }
  }

  private restoreRendererState(): void {
    this.renderer.resetState();
    // setViewport()/setScissor() update Three's default-target state even while
    // another target is active. Restore those globals first, then rebind the
    // caller's target so a cube face or target-specific viewport is preserved.
    this.renderer.setRenderTarget(null);
    this.renderer.setViewport(this.savedViewport);
    this.renderer.setScissor(this.savedScissor);
    this.renderer.setScissorTest(this.previousScissorTest);
    this.renderer.setRenderTarget(
      this.previousRenderTarget,
      this.previousActiveCubeFace,
      this.previousActiveMipmapLevel,
    );
    this.renderer.autoClear = this.previousAutoClear;
    this.frameActive = false;
    this.characterGroupActive = false;
    this.characterGroupIsolated = false;
    this.activeCubismTarget = null;
    this.activeCamera = null;
    this.previousRenderTarget = null;
    this.previousActiveCubeFace = 0;
    this.previousActiveMipmapLevel = 0;
  }
}
