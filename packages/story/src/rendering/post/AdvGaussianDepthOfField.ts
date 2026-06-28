import {
  ClampToEdgeWrapping,
  HalfFloatType,
  LinearFilter,
  NoBlending,
  NoColorSpace,
  RedFormat,
  RGBAFormat,
  ShaderMaterial,
  UnsignedByteType,
  Vector2,
  Vector3,
  WebGLRenderTarget,
} from "three";
import type { IUniform } from "three";
import type { AdvRenderFullscreen } from "./AdvUrpBloom";
import type { AdvDepthOfFieldVolume } from "./AdvVolumeStack";

const CAMERA_FAR_CLIP = 5000;
const FULLSCREEN_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const COC_FRAGMENT = /* glsl */ `
precision highp float;
uniform vec3 uCocParams; // gaussian start, gaussian end, ADV far depth
varying vec2 vUv;
void main() {
  float coc = (uCocParams.z - uCocParams.x) / (uCocParams.y - uCocParams.x);
  gl_FragColor = vec4(clamp(coc, 0.0, 1.0));
}
`;

// Reference pass 1 is MRT. WebGL renders its R8 CoC and RGBA16F color outputs in
// two draws because Three's shared fullscreen callback exposes one target;
// both shaders retain the exact pass-1 sample positions and equations.
const HALF_COC_FRAGMENT = /* glsl */ `
precision highp float;
uniform sampler2D tFullCoc;
uniform vec2 uSourceTexelSize;
uniform float uHighQuality;
varying vec2 vUv;
void main() {
  float coc = texture2D(tFullCoc, vUv).r;
  if (uHighQuality > 0.5) {
    coc += texture2D(tFullCoc, vUv + uSourceTexelSize * vec2( 0.9, -0.4)).r;
    coc += texture2D(tFullCoc, vUv + uSourceTexelSize * vec2(-0.9,  0.4)).r;
    coc += texture2D(tFullCoc, vUv + uSourceTexelSize * vec2( 0.4,  0.9)).r;
    coc += texture2D(tFullCoc, vUv + uSourceTexelSize * vec2(-0.4, -0.9)).r;
    coc *= 0.200000003;
  }
  gl_FragColor = vec4(coc);
}
`;

const PREFILTER_FRAGMENT = /* glsl */ `
precision highp float;
uniform sampler2D tInput;
uniform sampler2D tFullCoc;
uniform vec2 uSourceTexelSize;
uniform float uHighQuality;
varying vec2 vUv;
vec4 weightedSample(vec2 uv) {
  return texture2D(tInput, uv) * texture2D(tFullCoc, uv).rrrr;
}
void main() {
  vec4 color = weightedSample(vUv);
  if (uHighQuality > 0.5) {
    color += weightedSample(vUv + uSourceTexelSize * vec2( 0.9, -0.4));
    color += weightedSample(vUv + uSourceTexelSize * vec2(-0.9,  0.4));
    color += weightedSample(vUv + uSourceTexelSize * vec2( 0.4,  0.9));
    color += weightedSample(vUv + uSourceTexelSize * vec2(-0.4, -0.9));
    color *= 0.200000003;
  }
  gl_FragColor = color;
}
`;

// Pass 2 normalizes the premultiplied prefilter color by a CoC-weighted
// denominator. Its alpha numerator remains the source alpha, not the CoC.
const HORIZONTAL_BLUR_FRAGMENT = /* glsl */ `
precision highp float;
uniform sampler2D tInput;
uniform sampler2D tHalfCoc;
uniform vec2 uHalfSize;
uniform vec2 uHalfTexelSize;
uniform float uMaxRadius;
varying vec2 vUv;

void main() {
  vec2 centerUv = (floor(vUv * uHalfSize) + 0.5) * uHalfTexelSize;
  float centerCoc = texture2D(tHalfCoc, centerUv).r;
  vec2 displacement = vec2(uHalfTexelSize.x, 0.0) * centerCoc * uMaxRadius * 1.33333337;

  vec2 uv0 = vUv - displacement;
  vec2 uv2 = vUv + displacement;
  vec4 sample0 = texture2D(tInput, uv0);
  vec4 sample1 = texture2D(tInput, vUv);
  vec4 sample2 = texture2D(tInput, uv2);
  float coc0 = texture2D(tHalfCoc, uv0).r;
  float coc1 = texture2D(tHalfCoc, vUv).r;
  float coc2 = texture2D(tHalfCoc, uv2).r;
  float factor0 = clamp(1.0 - (centerCoc - coc0), 0.0, 1.0);
  float factor1 = clamp(1.0 - (centerCoc - coc1), 0.0, 1.0);
  float factor2 = clamp(1.0 - (centerCoc - coc2), 0.0, 1.0);
  const float outerWeight = 0.352941185;
  const float centerWeight = 0.294117659;
  vec3 color = sample0.rgb * (outerWeight * factor0)
             + sample1.rgb * (centerWeight * factor1)
             + sample2.rgb * (outerWeight * factor2);
  float alpha = sample0.a * outerWeight * factor0
              + sample1.a * centerWeight * factor1
              + sample2.a * outerWeight * factor2;
  float denominator = coc0 * outerWeight * factor0
                    + coc1 * centerWeight * factor1
                    + coc2 * outerWeight * factor2
                    + 9.99999975e-05;
  gl_FragColor = vec4(color / denominator, alpha / denominator);
}
`;

// Pass 3 receives the already-normalized horizontal result. The blob's
// denominator is therefore only the accepted kernel-weight sum; substituting
// sampled alpha here changes transparent-edge pixels.
const VERTICAL_BLUR_FRAGMENT = /* glsl */ `
precision highp float;
uniform sampler2D tInput;
uniform sampler2D tHalfCoc;
uniform vec2 uHalfSize;
uniform vec2 uHalfTexelSize;
uniform float uMaxRadius;
varying vec2 vUv;

void main() {
  vec2 centerUv = (floor(vUv * uHalfSize) + 0.5) * uHalfTexelSize;
  float centerCoc = texture2D(tHalfCoc, centerUv).r;
  vec2 displacement = vec2(0.0, uHalfTexelSize.y) * centerCoc * uMaxRadius * 1.33333337;

  vec2 uv0 = vUv - displacement;
  vec2 uv2 = vUv + displacement;
  vec4 sample0 = texture2D(tInput, uv0);
  vec4 sample1 = texture2D(tInput, vUv);
  vec4 sample2 = texture2D(tInput, uv2);
  float coc0 = texture2D(tHalfCoc, uv0).r;
  float coc1 = texture2D(tHalfCoc, vUv).r;
  float coc2 = texture2D(tHalfCoc, uv2).r;
  float factor0 = clamp(1.0 - (centerCoc - coc0), 0.0, 1.0);
  float factor1 = clamp(1.0 - (centerCoc - coc1), 0.0, 1.0);
  float factor2 = clamp(1.0 - (centerCoc - coc2), 0.0, 1.0);
  const float outerWeight = 0.352941185;
  const float centerWeight = 0.294117659;
  float weight0 = outerWeight * factor0;
  float weight1 = centerWeight * factor1;
  float weight2 = outerWeight * factor2;
  vec4 color = sample0 * weight0 + sample1 * weight1 + sample2 * weight2;
  float denominator = weight0 + weight1 + weight2 + 9.99999975e-05;
  gl_FragColor = color / denominator;
}
`;

const COMPOSITE_FRAGMENT = /* glsl */ `
precision highp float;
uniform sampler2D tInput;
uniform sampler2D tDof;
uniform sampler2D tFullCoc;
uniform vec2 uDofTexelSize;
uniform float uHighQuality;
varying vec2 vUv;

vec2 bSplineMiddleLeft(vec2 x) {
  return vec2(0.166666672) + x * (vec2(0.5) + x * (vec2(0.5) - x * 0.5));
}
vec2 bSplineMiddleRight(vec2 x) {
  return vec2(0.666666687) + x * (vec2(-1.0) + 0.5 * x) * x;
}
vec2 bSplineRightmost(vec2 x) {
  return vec2(0.166666672) + x * (vec2(-0.5) + x * (vec2(0.5) - x * 0.166666672));
}
vec4 sampleBicubic(vec2 uv) {
  vec2 pixel = uv / uDofTexelSize + 0.5;
  vec2 cell = floor(pixel);
  vec2 fraction = fract(pixel);
  vec2 right = bSplineRightmost(fraction);
  vec2 middleRight = bSplineMiddleRight(fraction);
  vec2 middleLeft = bSplineMiddleLeft(fraction);
  vec2 left = vec2(1.0) - middleRight - middleLeft - right;
  vec2 weight0 = right + middleRight;
  vec2 weight1 = middleLeft + left;
  vec2 offset0 = vec2(-1.0) + middleRight / weight0;
  vec2 offset1 = vec2(1.0) + left / weight1;
  vec2 uv00 = min((cell + vec2(offset0.x, offset0.y) - 0.5) * uDofTexelSize, vec2(1.0));
  vec2 uv10 = min((cell + vec2(offset1.x, offset0.y) - 0.5) * uDofTexelSize, vec2(1.0));
  vec2 uv01 = min((cell + vec2(offset0.x, offset1.y) - 0.5) * uDofTexelSize, vec2(1.0));
  vec2 uv11 = min((cell + vec2(offset1.x, offset1.y) - 0.5) * uDofTexelSize, vec2(1.0));
  return weight0.y * (
    weight0.x * texture2D(tDof, uv00) + weight1.x * texture2D(tDof, uv10)
  ) + weight1.y * (
    weight0.x * texture2D(tDof, uv01) + weight1.x * texture2D(tDof, uv11)
  );
}

void main() {
  vec4 source = texture2D(tInput, vUv);
  float coc = texture2D(tFullCoc, vUv).r;
  vec4 dof = uHighQuality > 0.5 ? sampleBicubic(vUv) : texture2D(tDof, vUv);
  float radius = sqrt(coc * ${2 * Math.PI});
  vec4 color = source * max(1.0 - radius, 0.0) + dof * min(radius, 1.0);
  color.rgb = color.a > 0.0 ? color.rgb : source.rgb;
  gl_FragColor = color;
}
`;

type UniformMap = Record<string, IUniform<unknown>>;

function material(fragmentShader: string, uniforms: UniformMap): ShaderMaterial {
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

function target(
  name: string,
  format: typeof RedFormat | typeof RGBAFormat,
  type: typeof UnsignedByteType | typeof HalfFloatType,
): WebGLRenderTarget {
  const result = new WebGLRenderTarget(1, 1, {
    depthBuffer: false,
    stencilBuffer: false,
    format,
    type,
    minFilter: LinearFilter,
    magFilter: LinearFilter,
    samples: 0,
  });
  result.texture.name = name;
  result.texture.colorSpace = NoColorSpace;
  result.texture.wrapS = ClampToEdgeWrapping;
  result.texture.wrapT = ClampToEdgeWrapping;
  result.texture.generateMipmaps = false;
  return result;
}

export interface AdvGaussianParameters {
  readonly halfWidth: number;
  readonly halfHeight: number;
  readonly maxRadius: number;
}

export interface AdvGaussianBlurTap {
  readonly color: readonly [number, number, number, number];
  readonly coc: number;
}

/**
 * CPU oracle for GaussianDepthOfField passes 2/3. Pass 2 divides by the
 * CoC-weighted kernel sum; pass 3 divides by the accepted kernel weights.
 */
export function advGaussianBlurPixel(
  pass: 2 | 3,
  centerCoc: number,
  taps: readonly [AdvGaussianBlurTap, AdvGaussianBlurTap, AdvGaussianBlurTap],
): readonly [number, number, number, number] {
  const weights = [0.352941185, 0.294117659, 0.352941185] as const;
  const accepted = taps.map((tap, index) => weights[index] * Math.max(0, Math.min(1, 1 - (centerCoc - tap.coc))));
  const denominator =
    accepted.reduce((sum, weight, index) => sum + weight * (pass === 2 ? taps[index].coc : 1), 0) + 9.99999975e-5;
  const channel = (channelIndex: 0 | 1 | 2 | 3): number =>
    accepted.reduce((sum, weight, index) => sum + taps[index].color[channelIndex] * weight, 0) / denominator;
  return [channel(0), channel(1), channel(2), channel(3)];
}

/** CPU packing for the Gaussian depth-of-field pass. */
export function computeAdvGaussianParameters(
  settings: Readonly<AdvDepthOfFieldVolume>,
  width: number,
  height: number,
): AdvGaussianParameters {
  const halfWidth = Math.max(1, Math.trunc(width) >> 1);
  const halfHeight = Math.max(1, Math.trunc(height) >> 1);
  return {
    halfWidth,
    halfHeight,
    maxRadius: Math.min((halfHeight / 1080) * settings.gaussianMaxRadius, 2),
  };
}

/** Hidden/Universal Render Pipeline/GaussianDepthOfField passes 0-4. */
export class AdvGaussianDepthOfField {
  private readonly fullCoc = target("adv-gaussian-dof-full-coc", RedFormat, UnsignedByteType);
  private readonly halfCoc = target("adv-gaussian-dof-half-coc", RedFormat, UnsignedByteType);
  private readonly ping = target("adv-gaussian-dof-ping", RGBAFormat, HalfFloatType);
  private readonly pong = target("adv-gaussian-dof-pong", RGBAFormat, HalfFloatType);
  private readonly cocUniforms: UniformMap = { uCocParams: { value: new Vector3() } };
  private readonly halfCocUniforms: UniformMap = {
    tFullCoc: { value: null },
    uSourceTexelSize: { value: new Vector2() },
    uHighQuality: { value: 0 },
  };
  private readonly prefilterUniforms: UniformMap = {
    tInput: { value: null },
    tFullCoc: { value: null },
    uSourceTexelSize: { value: new Vector2() },
    uHighQuality: { value: 0 },
  };
  private readonly blurUniforms: UniformMap = {
    tInput: { value: null },
    tHalfCoc: { value: null },
    uHalfSize: { value: new Vector2() },
    uHalfTexelSize: { value: new Vector2() },
    uMaxRadius: { value: 0 },
  };
  private readonly compositeUniforms: UniformMap = {
    tInput: { value: null },
    tDof: { value: null },
    tFullCoc: { value: null },
    uDofTexelSize: { value: new Vector2() },
    uHighQuality: { value: 0 },
  };
  private readonly cocMaterial = material(COC_FRAGMENT, this.cocUniforms);
  private readonly halfCocMaterial = material(HALF_COC_FRAGMENT, this.halfCocUniforms);
  private readonly prefilterMaterial = material(PREFILTER_FRAGMENT, this.prefilterUniforms);
  private readonly horizontalBlurMaterial = material(HORIZONTAL_BLUR_FRAGMENT, this.blurUniforms);
  private readonly verticalBlurMaterial = material(VERTICAL_BLUR_FRAGMENT, this.blurUniforms);
  private readonly compositeMaterial = material(COMPOSITE_FRAGMENT, this.compositeUniforms);

  render(
    source: WebGLRenderTarget,
    destination: WebGLRenderTarget,
    settings: Readonly<AdvDepthOfFieldVolume>,
    renderFullscreen: AdvRenderFullscreen,
  ): boolean {
    if (!settings.active || Math.trunc(settings.mode) !== 1) return false;
    source.texture.minFilter = LinearFilter;
    source.texture.magFilter = LinearFilter;
    const { halfWidth, halfHeight, maxRadius } = computeAdvGaussianParameters(settings, source.width, source.height);
    this.fullCoc.setSize(source.width, source.height);
    this.halfCoc.setSize(halfWidth, halfHeight);
    this.ping.setSize(halfWidth, halfHeight);
    this.pong.setSize(halfWidth, halfHeight);

    const sourceTexelX = 1 / source.width;
    const sourceTexelY = 1 / source.height;
    const halfTexelX = 1 / halfWidth;
    const halfTexelY = 1 / halfHeight;
    const highQuality = settings.highQualitySampling ? 1 : 0;
    (this.cocUniforms.uCocParams.value as Vector3).set(
      settings.gaussianStart,
      Math.max(settings.gaussianStart, settings.gaussianEnd),
      CAMERA_FAR_CLIP,
    );
    renderFullscreen(this.cocMaterial, this.fullCoc, true);

    this.halfCocUniforms.tFullCoc.value = this.fullCoc.texture;
    (this.halfCocUniforms.uSourceTexelSize.value as Vector2).set(sourceTexelX, sourceTexelY);
    this.halfCocUniforms.uHighQuality.value = highQuality;
    renderFullscreen(this.halfCocMaterial, this.halfCoc, true);

    this.prefilterUniforms.tInput.value = source.texture;
    this.prefilterUniforms.tFullCoc.value = this.fullCoc.texture;
    (this.prefilterUniforms.uSourceTexelSize.value as Vector2).set(sourceTexelX, sourceTexelY);
    this.prefilterUniforms.uHighQuality.value = highQuality;
    renderFullscreen(this.prefilterMaterial, this.ping, true);

    this.blurUniforms.tHalfCoc.value = this.halfCoc.texture;
    (this.blurUniforms.uHalfSize.value as Vector2).set(halfWidth, halfHeight);
    (this.blurUniforms.uHalfTexelSize.value as Vector2).set(halfTexelX, halfTexelY);
    this.blurUniforms.uMaxRadius.value = maxRadius;
    this.blurUniforms.tInput.value = this.ping.texture;
    renderFullscreen(this.horizontalBlurMaterial, this.pong, true);
    this.blurUniforms.tInput.value = this.pong.texture;
    renderFullscreen(this.verticalBlurMaterial, this.ping, true);

    this.compositeUniforms.tInput.value = source.texture;
    this.compositeUniforms.tDof.value = this.ping.texture;
    this.compositeUniforms.tFullCoc.value = this.fullCoc.texture;
    (this.compositeUniforms.uDofTexelSize.value as Vector2).set(halfTexelX, halfTexelY);
    this.compositeUniforms.uHighQuality.value = highQuality;
    renderFullscreen(this.compositeMaterial, destination, true);
    return true;
  }

  dispose(): void {
    this.fullCoc.dispose();
    this.halfCoc.dispose();
    this.ping.dispose();
    this.pong.dispose();
    this.cocMaterial.dispose();
    this.halfCocMaterial.dispose();
    this.prefilterMaterial.dispose();
    this.horizontalBlurMaterial.dispose();
    this.verticalBlurMaterial.dispose();
    this.compositeMaterial.dispose();
  }
}
