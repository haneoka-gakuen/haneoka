import {
  AdditiveBlending,
  Color,
  LinearFilter,
  Mesh,
  NoBlending,
  NoColorSpace,
  OrthographicCamera,
  PlaneGeometry,
  RGBFormat,
  Scene,
  ShaderMaterial,
  UnsignedInt101111Type,
  Vector2,
  Vector4,
  WebGLRenderTarget,
  WebGLRenderer,
} from "three";
import type { IUniform, Texture } from "three";

/**
 * LiveEffectCamera configuration.
 *
 * Sources: LiveEffectCamera.asset Camera_1 / MonoBehaviour_67 / 45 and the
 * default (quality=1) MasterLiveQualitySettings entry. The main live camera
 * is layer 25 with HDR/post-processing disabled; only layer 29 is rendered by
 * this HDR effect camera and fed through the global LiveGameVolume.
 */
export const OUR_NOTES_LIVE_EFFECT_CAMERA = Object.freeze({
  layer: 29,
  hdr: true,
  postProcessing: true,
  volumeLayerMask: 1 << 29,
  baseFrameRate: 60,
  renderFrameRate: 30,
  renderingScale: 0.85,
  // FullInitialize passes RenderTextureFormat.RGB111110Float (22) to
  // RenderTexture..ctor.
  renderTextureFormat: 22,
});

/** Exact active values from the LiveGameVolume Bloom component. */
export const OUR_NOTES_LIVE_BLOOM = Object.freeze({
  active: true,
  threshold: 1.2,
  intensity: 5,
  scatter: 0.7,
  clamp: 65472,
  highQualityFiltering: false,
  filter: 0,
  downscale: 0,
  maxIterations: 5,
});

export interface LiveBloomMipLayout {
  readonly effectWidth: number;
  readonly effectHeight: number;
  readonly mips: ReadonlyArray<readonly [width: number, height: number]>;
}

export function liveBloomGammaToLinear(value: number): number {
  if (value <= 0.04045) return value / 12.92;
  if (value < 1) return Math.pow((value + 0.055) / 1.055, 2.4);
  return Math.pow(value, 2.4);
}

export function liveBloomMappedScatter(scatter: number): number {
  const value = Math.max(0, Math.min(1, Number.isFinite(scatter) ? scatter : 0.7));
  return 0.05 + 0.9 * value;
}

/** Compatibility SetupBloom prefilter vector. */
export function liveBloomPrefilterParameters(): readonly [
  scatter: number,
  clamp: number,
  thresholdLinear: number,
  knee: number,
] {
  const threshold = liveBloomGammaToLinear(OUR_NOTES_LIVE_BLOOM.threshold);
  return [liveBloomMappedScatter(OUR_NOTES_LIVE_BLOOM.scatter), OUR_NOTES_LIVE_BLOOM.clamp, threshold, threshold * 0.5];
}

/** The reference Gaussian filter dispatches passes 0, (1,2)*, then 3*. */
export function liveBloomPassPlan(mipCount: number): readonly number[] {
  const count = Math.max(1, Math.trunc(mipCount));
  return [0, ...Array.from({ length: count - 1 }, () => [1, 2]).flat(), ...Array.from({ length: count - 1 }, () => 3)];
}

/** URP render scale, Half downscale and max-iteration sizing. */
export function liveBloomMipLayout(
  outputWidth: number,
  outputHeight: number,
  renderingScale = OUR_NOTES_LIVE_EFFECT_CAMERA.renderingScale,
  maxIterations = OUR_NOTES_LIVE_BLOOM.maxIterations,
): LiveBloomMipLayout {
  const width = Math.max(1, Math.trunc(outputWidth));
  const height = Math.max(1, Math.trunc(outputHeight));
  const scale = Math.max(0.01, Number.isFinite(renderingScale) ? renderingScale : 1);
  const effectWidth = Math.max(1, Math.trunc(width * scale));
  const effectHeight = Math.max(1, Math.trunc(height * scale));
  // BloomDownscaleMode.Half=0. Quarter would shift twice instead.
  const initialWidth = Math.max(1, effectWidth >> 1);
  const initialHeight = Math.max(1, effectHeight >> 1);
  const possibleIterations = Math.floor(Math.log2(Math.max(initialWidth, initialHeight))) - 1;
  const mipCount = Math.max(1, Math.min(Math.max(1, Math.trunc(maxIterations)), possibleIterations));
  const mips: Array<readonly [number, number]> = [];
  for (let index = 0; index < mipCount; index += 1) {
    mips.push([Math.max(1, initialWidth >> index), Math.max(1, initialHeight >> index)]);
  }
  return { effectWidth, effectHeight, mips };
}

/** MonoBehaviour_45 renders the effect camera at 30 fps without slowing the base camera. */
export function liveEffectFrameIndex(timeSeconds: number): number {
  const time = Number.isFinite(timeSeconds) ? Math.max(0, timeSeconds) : 0;
  return Math.floor(time * OUR_NOTES_LIVE_EFFECT_CAMERA.renderFrameRate + 0.000001);
}

export type LiveEffectFrameAction = "refresh" | "reuse" | "release" | "idle";

/** Scheduling shared by the particle simulation and its cached 30-fps HDR RT. */
export function liveEffectFrameAction(
  particleEffectCount: number,
  particleStateActive: boolean,
  effectCacheActive: boolean,
  lastEffectFrame: number,
  timeSeconds: number,
): LiveEffectFrameAction {
  if (particleEffectCount <= 0) return particleStateActive || effectCacheActive ? "release" : "idle";
  return !effectCacheActive || liveEffectFrameIndex(timeSeconds) !== lastEffectFrame ? "refresh" : "reuse";
}

const FULLSCREEN_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

// Hidden/Universal Render Pipeline/Bloom, reference GLES3 pass 0. LiveEffectCamera
// explicitly targets RGB111110Float, so _ENABLE_ALPHA_OUTPUT is off and the
// RGB source is thresholded directly. The Gamma project shader uses sqrt
// encoding around its linear-space filtering operations.
const PREFILTER_FRAGMENT = /* glsl */ `
precision highp float;
uniform sampler2D tInput;
uniform vec4 uParams;
uniform vec2 uTexelSize;
varying vec2 vUv;
void main() {
  vec3 color = min(texture2D(tInput, vUv).rgb, uParams.yyy);
  float brightness = max(color.r, max(color.g, color.b));
  float rq = brightness - uParams.z;
  float soft = clamp(rq + uParams.w, 0.0, 2.0 * uParams.w);
  soft = soft * soft / (4.0 * uParams.w + 9.99999975e-05);
  float contribution = max(rq, soft) / max(brightness, 9.99999975e-05);
  gl_FragColor = vec4(sqrt(max(color * contribution, vec3(0.0))), 1.0);
}
`;

// Reference pass 1: exact nine-tap horizontal Gaussian and 2x downsample.
const HORIZONTAL_FRAGMENT = /* glsl */ `
precision highp float;
uniform sampler2D tInput;
uniform vec2 uTexelSize;
varying vec2 vUv;
vec3 sampleSquared(float offset) {
  vec2 uv = min(vUv + vec2(offset * uTexelSize.x, 0.0), vec2(1.0) - uTexelSize);
  vec3 value = texture2D(tInput, uv).rgb;
  return value * value;
}
void main() {
  vec3 color = sampleSquared(-8.0) * 0.0162162203;
  color += sampleSquared(-6.0) * 0.0540540516;
  color += sampleSquared(-4.0) * 0.121621624;
  color += sampleSquared(-2.0) * 0.194594592;
  color += sampleSquared( 0.0) * 0.227027029;
  color += sampleSquared( 2.0) * 0.194594592;
  color += sampleSquared( 4.0) * 0.121621624;
  color += sampleSquared( 6.0) * 0.0540540516;
  color += sampleSquared( 8.0) * 0.0162162203;
  gl_FragColor = vec4(sqrt(color), 1.0);
}
`;

// Reference pass 2: exact bilinear-assisted vertical five-tap kernel.
const VERTICAL_FRAGMENT = /* glsl */ `
precision highp float;
uniform sampler2D tInput;
uniform vec2 uTexelSize;
varying vec2 vUv;
vec3 sampleSquared(float offset) {
  vec2 uv = min(vUv + vec2(0.0, offset * uTexelSize.y), vec2(1.0) - 0.5 * uTexelSize);
  vec3 value = texture2D(tInput, uv).rgb;
  return value * value;
}
void main() {
  vec3 color = sampleSquared(-3.23076916) * 0.0702702701;
  color += sampleSquared(-1.38461542) * 0.31621623;
  color += sampleSquared( 0.0) * 0.227027029;
  color += sampleSquared( 1.38461542) * 0.31621623;
  color += sampleSquared( 3.23076916) * 0.0702702701;
  gl_FragColor = vec4(sqrt(color), 1.0);
}
`;

// Reference pass 3 LQ branch. Bloom.asset explicitly disables HQ filtering.
const UPSAMPLE_FRAGMENT = /* glsl */ `
precision highp float;
uniform sampler2D tHigh;
uniform sampler2D tLow;
uniform float uScatter;
varying vec2 vUv;
void main() {
  vec3 high = texture2D(tHigh, vUv).rgb;
  vec3 low = texture2D(tLow, vUv).rgb;
  gl_FragColor = vec4(sqrt(mix(high * high, low * low, uScatter)), 1.0);
}
`;

// LiveGameVolume contains only Bloom. This is the relevant UberPost path:
// Gamma project input -> linear, decoded bloom * intensity, then gamma output.
// It is additively composited over the already-rendered base camera, matching
// the native two-camera/layer split while leaving DOM and HUD canvases alone.
const COMPOSITE_FRAGMENT = /* glsl */ `
precision highp float;
uniform sampler2D tEffect;
uniform sampler2D tBloom;
uniform float uIntensity;
varying vec2 vUv;
vec3 fastSrgbToLinear(vec3 color) {
  return color * (color * (color * 0.305306011 + 0.682171111) + 0.012522878);
}
vec3 fastLinearToSrgb(vec3 color) {
  return clamp(1.055 * pow(abs(color), vec3(0.416666657)) - 0.055, 0.0, 1.0);
}
void main() {
  vec3 effect = texture2D(tEffect, vUv).rgb;
  vec3 bloom = texture2D(tBloom, vUv).rgb;
  bloom *= bloom * uIntensity;
  vec3 color = fastLinearToSrgb(clamp(fastSrgbToLinear(effect) + bloom, 0.0, 1.0));
  // Native EffectRawImageMaterial uses UI/Additive (One, One) and ignores
  // source alpha for RGB. The browser compositor still needs premultiplied
  // canvas alpha, so derive it from the post-process color only.
  float alpha = max(color.r, max(color.g, color.b));
  gl_FragColor = vec4(color, clamp(alpha, 0.0, 1.0));
}
`;

interface InputUniforms extends Record<string, IUniform<unknown>> {
  tInput: IUniform<Texture | null>;
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

function createTarget(name: string): WebGLRenderTarget {
  const result = new WebGLRenderTarget(1, 1, {
    depthBuffer: false,
    stencilBuffer: false,
    // WebGL2 R11F_G11F_B10F is the exact RenderTextureFormat 22 backing.
    format: RGBFormat,
    type: UnsignedInt101111Type,
    minFilter: LinearFilter,
    magFilter: LinearFilter,
    samples: 0,
  });
  result.texture.name = name;
  result.texture.colorSpace = NoColorSpace;
  result.texture.generateMipmaps = false;
  return result;
}

/**
 * Minimal selective URP Bloom pipeline for the LiveEffectCamera. Targets,
 * geometry and uniforms are retained; no per-frame GPU resources are created.
 * The caller can cache renderEffect() at native 30 fps and call the cheap
 * composite() pass on every base-camera frame.
 */
export class LiveUrpBloomPipeline {
  // Camera_1 has m_HDR=true and FullInitialize creates format 22 explicitly.
  // It preserves Mobile/Add HDR Color energy above 1 until the 1.2 threshold,
  // with four-byte pixels just like the native R11F_G11F_B10F target.
  private readonly effectTarget = createTarget("our-notes-live-effect-camera");
  private readonly mipDown = Array.from({ length: OUR_NOTES_LIVE_BLOOM.maxIterations }, (_, index) =>
    createTarget(`our-notes-live-bloom-down-${index}`),
  );
  private readonly mipUp = Array.from({ length: OUR_NOTES_LIVE_BLOOM.maxIterations }, (_, index) =>
    createTarget(`our-notes-live-bloom-up-${index}`),
  );
  private readonly prefilterUniforms: InputUniforms & {
    uParams: IUniform<Vector4>;
    uTexelSize: IUniform<Vector2>;
  } = {
    tInput: { value: null },
    uParams: { value: new Vector4() },
    uTexelSize: { value: new Vector2(1, 1) },
  };
  private readonly horizontalUniforms: InputUniforms & { uTexelSize: IUniform<Vector2> } = {
    tInput: { value: null },
    uTexelSize: { value: new Vector2(1, 1) },
  };
  private readonly verticalUniforms: InputUniforms & { uTexelSize: IUniform<Vector2> } = {
    tInput: { value: null },
    uTexelSize: { value: new Vector2(1, 1) },
  };
  private readonly upsampleUniforms: Record<string, IUniform<unknown>> & {
    tHigh: IUniform<Texture | null>;
    tLow: IUniform<Texture | null>;
    uScatter: IUniform<number>;
  } = {
    tHigh: { value: null },
    tLow: { value: null },
    uScatter: { value: liveBloomMappedScatter(OUR_NOTES_LIVE_BLOOM.scatter) },
  };
  private readonly compositeUniforms: Record<string, IUniform<unknown>> & {
    tEffect: IUniform<Texture | null>;
    tBloom: IUniform<Texture | null>;
    uIntensity: IUniform<number>;
  } = {
    tEffect: { value: this.effectTarget.texture },
    tBloom: { value: null },
    uIntensity: { value: OUR_NOTES_LIVE_BLOOM.intensity },
  };
  private readonly prefilterMaterial = createMaterial(PREFILTER_FRAGMENT, this.prefilterUniforms);
  private readonly horizontalMaterial = createMaterial(HORIZONTAL_FRAGMENT, this.horizontalUniforms);
  private readonly verticalMaterial = createMaterial(VERTICAL_FRAGMENT, this.verticalUniforms);
  private readonly upsampleMaterial = createMaterial(UPSAMPLE_FRAGMENT, this.upsampleUniforms);
  private readonly compositeMaterial = new ShaderMaterial({
    vertexShader: FULLSCREEN_VERTEX,
    fragmentShader: COMPOSITE_FRAGMENT,
    uniforms: this.compositeUniforms,
    depthTest: false,
    depthWrite: false,
    blending: AdditiveBlending,
    // AdditiveBlending becomes ONE/ONE for premultiplied materials. The
    // composite shader has already applied effect alpha in the effect target.
    premultipliedAlpha: true,
    transparent: true,
    toneMapped: false,
  });
  private readonly fullscreenScene = new Scene();
  private readonly fullscreenCamera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly fullscreenGeometry = new PlaneGeometry(2, 2);
  private readonly fullscreenMesh = new Mesh(this.fullscreenGeometry, this.prefilterMaterial);
  private readonly clearColor = new Color();
  private mipCount = 1;
  private outputWidth = 0;
  private outputHeight = 0;
  private ready = false;

  constructor() {
    this.fullscreenMesh.frustumCulled = false;
    this.fullscreenScene.add(this.fullscreenMesh);
  }

  setSize(outputWidth: number, outputHeight: number): void {
    const width = Math.max(1, Math.trunc(outputWidth));
    const height = Math.max(1, Math.trunc(outputHeight));
    if (width === this.outputWidth && height === this.outputHeight) return;
    this.outputWidth = width;
    this.outputHeight = height;
    const layout = liveBloomMipLayout(width, height);
    this.effectTarget.setSize(layout.effectWidth, layout.effectHeight);
    this.mipCount = layout.mips.length;
    for (let index = 0; index < this.mipCount; index += 1) {
      const [mipWidth, mipHeight] = layout.mips[index]!;
      this.mipDown[index]!.setSize(mipWidth, mipHeight);
      this.mipUp[index]!.setSize(mipWidth, mipHeight);
    }
    this.ready = false;
  }

  /** Render the layer-29 effect scene and refresh its cached bloom pyramid. */
  renderEffect(renderer: WebGLRenderer, drawEffectScene: () => void): void {
    if (this.outputWidth < 1 || this.outputHeight < 1) return;
    const previousTarget = renderer.getRenderTarget();
    const previousAlpha = renderer.getClearAlpha();
    renderer.getClearColor(this.clearColor);
    renderer.setRenderTarget(this.effectTarget);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, false, false);
    drawEffectScene();
    renderer.setClearColor(this.clearColor, previousAlpha);

    const [scatter, bloomClamp, threshold, knee] = liveBloomPrefilterParameters();
    this.prefilterUniforms.tInput.value = this.effectTarget.texture;
    this.prefilterUniforms.uParams.value.set(scatter, bloomClamp, threshold, knee);
    this.prefilterUniforms.uTexelSize.value.set(1 / this.effectTarget.width, 1 / this.effectTarget.height);
    this.renderFullscreen(renderer, this.prefilterMaterial, this.mipDown[0]!);

    for (let index = 1; index < this.mipCount; index += 1) {
      const previous = this.mipDown[index - 1]!;
      this.horizontalUniforms.tInput.value = previous.texture;
      this.horizontalUniforms.uTexelSize.value.set(1 / previous.width, 1 / previous.height);
      this.renderFullscreen(renderer, this.horizontalMaterial, this.mipUp[index]!);

      const temporary = this.mipUp[index]!;
      this.verticalUniforms.tInput.value = temporary.texture;
      this.verticalUniforms.uTexelSize.value.set(1 / temporary.width, 1 / temporary.height);
      this.renderFullscreen(renderer, this.verticalMaterial, this.mipDown[index]!);
    }

    for (let index = this.mipCount - 2; index >= 0; index -= 1) {
      const low = index === this.mipCount - 2 ? this.mipDown[index + 1]! : this.mipUp[index + 1]!;
      this.upsampleUniforms.tHigh.value = this.mipDown[index]!.texture;
      this.upsampleUniforms.tLow.value = low.texture;
      this.renderFullscreen(renderer, this.upsampleMaterial, this.mipUp[index]!);
    }

    const bloomTarget = this.mipCount > 1 ? this.mipUp[0]! : this.mipDown[0]!;
    this.compositeUniforms.tBloom.value = bloomTarget.texture;
    renderer.setRenderTarget(previousTarget);
    this.ready = true;
  }

  /** Add cached effect-camera output to the base-camera framebuffer. */
  composite(renderer: WebGLRenderer): void {
    if (!this.ready) return;
    renderer.setRenderTarget(null);
    this.fullscreenMesh.material = this.compositeMaterial;
    renderer.render(this.fullscreenScene, this.fullscreenCamera);
  }

  invalidate(): void {
    this.ready = false;
  }

  get stats(): {
    readonly effectWidth: number;
    readonly effectHeight: number;
    readonly mipCount: number;
    readonly bloomPasses: number;
    readonly cached: boolean;
  } {
    return {
      effectWidth: this.effectTarget.width,
      effectHeight: this.effectTarget.height,
      mipCount: this.mipCount,
      bloomPasses: liveBloomPassPlan(this.mipCount).length,
      cached: this.ready,
    };
  }

  dispose(): void {
    this.effectTarget.dispose();
    for (const target of [...this.mipDown, ...this.mipUp]) target.dispose();
    this.prefilterMaterial.dispose();
    this.horizontalMaterial.dispose();
    this.verticalMaterial.dispose();
    this.upsampleMaterial.dispose();
    this.compositeMaterial.dispose();
    this.fullscreenGeometry.dispose();
    this.fullscreenScene.clear();
  }

  private renderFullscreen(renderer: WebGLRenderer, material: ShaderMaterial, target: WebGLRenderTarget): void {
    this.fullscreenMesh.material = material;
    renderer.setRenderTarget(target);
    // Every material is NoBlending and the full-screen triangle coverage is
    // complete, so a separate clear would only add bandwidth.
    renderer.render(this.fullscreenScene, this.fullscreenCamera);
  }
}
