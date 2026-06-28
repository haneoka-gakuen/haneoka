import {
  LinearFilter,
  NoBlending,
  NoColorSpace,
  RGBAFormat,
  ShaderMaterial,
  Texture,
  UnsignedByteType,
  Vector2,
  Vector4,
  WebGLRenderTarget,
} from "three";
import type { IUniform } from "three";
import type { AdvBloomVolume } from "./AdvVolumeStack";
import { advBloomPrefilterParameters, resolveAdvBloomFilterMode } from "./AdvUrpMath";
import { unityGammaToLinear } from "./UnityColorGrading";

export type AdvRenderFullscreen = (material: ShaderMaterial, target: WebGLRenderTarget, clear: boolean) => void;

const FULLSCREEN_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

// Hidden/Universal Render Pipeline/Bloom, GLES3 blob 2. `_ENABLE_ALPHA_OUTPUT`
// is enabled by the ADV camera and the prefilter therefore premultiplies RGB.
const PREFILTER_FRAGMENT = /* glsl */ `
uniform sampler2D tInput;
uniform vec4 uParams; // scatter, clamp, threshold-linear, knee
uniform vec2 uTexelSize;
uniform float uHighQuality;
varying vec2 vUv;
vec3 samplePremultiplied(vec2 uv) {
  vec4 source = texture2D(tInput, uv);
  return source.rgb * source.a;
}
void main() {
  vec3 color;
  if (uHighQuality > 0.5) {
    vec3 a = samplePremultiplied(vUv + uTexelSize * vec2(-1.0, -1.0));
    vec3 b = samplePremultiplied(vUv + uTexelSize * vec2( 0.0, -1.0));
    vec3 c = samplePremultiplied(vUv + uTexelSize * vec2( 1.0, -1.0));
    vec3 d = samplePremultiplied(vUv + uTexelSize * vec2(-0.5, -0.5));
    vec3 e = samplePremultiplied(vUv + uTexelSize * vec2( 0.5, -0.5));
    vec3 f = samplePremultiplied(vUv + uTexelSize * vec2(-1.0,  0.0));
    vec3 g = samplePremultiplied(vUv);
    vec3 h = samplePremultiplied(vUv + uTexelSize * vec2( 1.0,  0.0));
    vec3 i = samplePremultiplied(vUv + uTexelSize * vec2(-0.5,  0.5));
    vec3 j = samplePremultiplied(vUv + uTexelSize * vec2( 0.5,  0.5));
    vec3 k = samplePremultiplied(vUv + uTexelSize * vec2(-1.0,  1.0));
    vec3 l = samplePremultiplied(vUv + uTexelSize * vec2( 0.0,  1.0));
    vec3 m = samplePremultiplied(vUv + uTexelSize * vec2( 1.0,  1.0));
    color = (d + e + i + j) * 0.125;
    color += (a + b + g + f) * 0.03125;
    color += (b + c + h + g) * 0.03125;
    color += (f + g + l + k) * 0.03125;
    color += (g + h + m + l) * 0.03125;
  } else {
    color = samplePremultiplied(vUv);
  }
  color = min(color, uParams.yyy);
  float brightness = max(color.r, max(color.g, color.b));
  float rq = brightness - uParams.z;
  float soft = clamp(rq + uParams.w, 0.0, 2.0 * uParams.w);
  soft = soft * soft / (4.0 * uParams.w + 9.99999975e-05);
  float contribution = max(rq, soft) / max(brightness, 9.99999975e-05);
  gl_FragColor = vec4(sqrt(max(color * contribution, vec3(0.0))), 1.0);
}
`;

// GLES3 blob 5: 2x downsample plus exact 9-tap horizontal Gaussian. The
// shipped shader convolves squared encoded samples and takes sqrt afterwards.
const HORIZONTAL_FRAGMENT = /* glsl */ `
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

// GLES3 blob 6: bilinear-assisted vertical 5-tap kernel.
const VERTICAL_FRAGMENT = /* glsl */ `
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

// GLES3 blob 9, LQ branch. Stage assets never override HQ and therefore all
// observed ADV frames use ordinary bilinear sampling here.
const UPSAMPLE_FRAGMENT = /* glsl */ `
uniform sampler2D tHigh;
uniform sampler2D tLow;
uniform float uScatter;
uniform vec2 uLowTexelSize;
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

vec3 sampleBicubic(vec2 uv) {
  vec2 pixel = uv / uLowTexelSize + 0.5;
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
  vec2 uv00 = min((cell + vec2(offset0.x, offset0.y) - 0.5) * uLowTexelSize, vec2(1.0));
  vec2 uv10 = min((cell + vec2(offset1.x, offset0.y) - 0.5) * uLowTexelSize, vec2(1.0));
  vec2 uv01 = min((cell + vec2(offset0.x, offset1.y) - 0.5) * uLowTexelSize, vec2(1.0));
  vec2 uv11 = min((cell + vec2(offset1.x, offset1.y) - 0.5) * uLowTexelSize, vec2(1.0));
  return weight0.y * (
    weight0.x * texture2D(tLow, uv00).rgb + weight1.x * texture2D(tLow, uv10).rgb
  ) + weight1.y * (
    weight0.x * texture2D(tLow, uv01).rgb + weight1.x * texture2D(tLow, uv11).rgb
  );
}

void main() {
  vec3 high = texture2D(tHigh, vUv).rgb;
  vec3 low = uHighQuality > 0.5 ? sampleBicubic(vUv) : texture2D(tLow, vUv).rgb;
  gl_FragColor = vec4(sqrt(mix(high * high, low * low, uScatter)), 1.0);
}
`;

// Reference Bloom pass 4. RenderGraph selects it for BloomFilterMode.Kawase; the
// compatibility renderer used by ADV never dispatches this packaged pass.
const KAWASE_FRAGMENT = /* glsl */ `
uniform sampler2D tInput;
uniform vec2 uTexelSize;
uniform float uDistance;
uniform float uScatter;
uniform float uKawaseScatter;
varying vec2 vUv;
vec3 sampleSquared(vec2 offset) {
  // The GLES blob clamps only the upper RTHandle bound. ClampToEdge supplies
  // the lower-edge behavior without changing the sample coordinate.
  vec2 uv = min(vUv - offset * uTexelSize, vec2(1.0) - uTexelSize * 0.5);
  vec3 value = texture2D(tInput, uv).rgb;
  return value * value;
}
void main() {
  float distance = uDistance;
  vec3 color = sampleSquared(vec2( distance,  distance));
  color += sampleSquared(vec2(-distance,  distance));
  color += sampleSquared(vec2(-distance, -distance));
  color += sampleSquared(vec2( distance, -distance));
  color *= 0.25;
  if (uKawaseScatter < 0.999000013) {
    color = mix(sampleSquared(vec2(0.0)), color, uScatter);
  }
  gl_FragColor = vec4(sqrt(color), 1.0);
}
`;

// Reference Bloom pass 5: fixed dual-filter downsample kernel.
const DUAL_DOWNSAMPLE_FRAGMENT = /* glsl */ `
uniform sampler2D tInput;
uniform vec2 uTexelSize;
varying vec2 vUv;
vec3 sampleSquared(vec2 offset) {
  vec2 uv = min(vUv - offset * uTexelSize, vec2(1.0) - uTexelSize * 0.5);
  vec3 value = texture2D(tInput, uv).rgb;
  return value * value;
}
void main() {
  vec3 color = sampleSquared(vec2(0.0)) * 4.0;
  color += sampleSquared(vec2( 0.5,  0.5));
  color += sampleSquared(vec2(-0.5,  0.5));
  color += sampleSquared(vec2(-0.5, -0.5));
  color += sampleSquared(vec2( 0.5, -0.5));
  gl_FragColor = vec4(sqrt(color * 0.125), 1.0);
}
`;

// Reference Bloom pass 6: dual-filter upsample kernel.
const DUAL_UPSAMPLE_FRAGMENT = /* glsl */ `
uniform sampler2D tInput;
uniform vec2 uTexelSize;
uniform float uScatter;
uniform float uHalfScatter;
varying vec2 vUv;
vec3 sampleSquared(vec2 offset) {
  vec2 uv = min(vUv - offset * uTexelSize, vec2(1.0) - uTexelSize * 0.5);
  vec3 value = texture2D(tInput, uv).rgb;
  return value * value;
}
void main() {
  float halfScatter = uHalfScatter;
  vec3 color = sampleSquared(vec2( halfScatter,  halfScatter));
  color += sampleSquared(vec2(-halfScatter,  halfScatter));
  color += sampleSquared(vec2(-halfScatter, -halfScatter));
  color += sampleSquared(vec2( halfScatter, -halfScatter));
  color *= 2.0;
  float scatter = uScatter;
  color += sampleSquared(vec2(-scatter, 0.0));
  color += sampleSquared(vec2( scatter, 0.0));
  color += sampleSquared(vec2(0.0,  scatter));
  color += sampleSquared(vec2(0.0, -scatter));
  gl_FragColor = vec4(sqrt(color * 0.0833333358), 1.0);
}
`;

interface InputUniforms extends Record<string, IUniform<unknown>> {
  tInput: IUniform<Texture | null>;
}

function material(fragmentShader: string, uniforms: Record<string, IUniform<unknown>>): ShaderMaterial {
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

function target(name: string): WebGLRenderTarget {
  const result = new WebGLRenderTarget(1, 1, {
    depthBuffer: false,
    stencilBuffer: false,
    format: RGBAFormat,
    // Gamma PlayerSettings makes m_DefaultColorFormat R8G8B8A8_UNorm.
    type: UnsignedByteType,
    minFilter: LinearFilter,
    magFilter: LinearFilter,
    samples: 0,
  });
  result.texture.name = name;
  result.texture.colorSpace = NoColorSpace;
  result.texture.generateMipmaps = false;
  return result;
}

export interface AdvBloomResult {
  readonly texture: Texture;
  readonly width: number;
  readonly height: number;
  readonly intensity: number;
  readonly tint: readonly [number, number, number];
}

/** Bloom passes 0-6; ADV profiles select the Gaussian branch. */
export class AdvUrpBloom {
  private readonly mipDown = Array.from({ length: 16 }, (_, index) => target(`adv-bloom-down-${index}`));
  private readonly mipUp = Array.from({ length: 16 }, (_, index) => target(`adv-bloom-up-${index}`));
  private readonly prefilterUniforms: InputUniforms & {
    uParams: IUniform<Vector4>;
    uTexelSize: IUniform<Vector2>;
    uHighQuality: IUniform<number>;
  } = {
    tInput: { value: null },
    uParams: { value: new Vector4() },
    uTexelSize: { value: new Vector2(1, 1) },
    uHighQuality: { value: 0 },
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
    uLowTexelSize: IUniform<Vector2>;
    uHighQuality: IUniform<number>;
  } = {
    tHigh: { value: null },
    tLow: { value: null },
    uScatter: { value: 0.68 },
    uLowTexelSize: { value: new Vector2(1, 1) },
    uHighQuality: { value: 0 },
  };
  private readonly kawaseUniforms: InputUniforms & {
    uTexelSize: IUniform<Vector2>;
    uDistance: IUniform<number>;
    uScatter: IUniform<number>;
    uKawaseScatter: IUniform<number>;
  } = {
    tInput: { value: null },
    uTexelSize: { value: new Vector2(1, 1) },
    uDistance: { value: 0.5 },
    uScatter: { value: 0.68 },
    uKawaseScatter: { value: 0.7 },
  };
  private readonly dualDownsampleUniforms: InputUniforms & { uTexelSize: IUniform<Vector2> } = {
    tInput: { value: null },
    uTexelSize: { value: new Vector2(1, 1) },
  };
  private readonly dualUpsampleUniforms: InputUniforms & {
    uTexelSize: IUniform<Vector2>;
    uScatter: IUniform<number>;
    uHalfScatter: IUniform<number>;
  } = {
    tInput: { value: null },
    uTexelSize: { value: new Vector2(1, 1) },
    uScatter: { value: 1 },
    uHalfScatter: { value: 0.5 },
  };
  private readonly prefilterMaterial = material(PREFILTER_FRAGMENT, this.prefilterUniforms);
  private readonly horizontalMaterial = material(HORIZONTAL_FRAGMENT, this.horizontalUniforms);
  private readonly verticalMaterial = material(VERTICAL_FRAGMENT, this.verticalUniforms);
  private readonly upsampleMaterial = material(UPSAMPLE_FRAGMENT, this.upsampleUniforms);
  private readonly kawaseMaterial = material(KAWASE_FRAGMENT, this.kawaseUniforms);
  private readonly dualDownsampleMaterial = material(DUAL_DOWNSAMPLE_FRAGMENT, this.dualDownsampleUniforms);
  private readonly dualUpsampleMaterial = material(DUAL_UPSAMPLE_FRAGMENT, this.dualUpsampleUniforms);

  render(
    source: Texture,
    width: number,
    height: number,
    settings: Readonly<AdvBloomVolume>,
    renderFullscreen: AdvRenderFullscreen,
  ): AdvBloomResult | null {
    if (!settings.active || settings.intensity <= 0) return null;
    // URP binds sampler_LinearClamp independently of the point-filtered ADV
    // field target. WebGL texture state carries the sampler instead.
    source.minFilter = LinearFilter;
    source.magFilter = LinearFilter;

    // BloomDownscaleMode.Half=0, Quarter=1. All stage assets retain Half.
    const downres = Math.trunc(settings.downscale) === 1 ? 2 : 1;
    const initialWidth = Math.max(1, Math.trunc(width) >> downres);
    const initialHeight = Math.max(1, Math.trunc(height) >> downres);
    const iterations = Math.floor(Math.log2(Math.max(initialWidth, initialHeight))) - 1;
    const mipCount = Math.max(1, Math.min(Math.max(1, Math.trunc(settings.maxIterations)), iterations));

    for (let index = 0; index < mipCount; index += 1) {
      const mipWidth = Math.max(1, initialWidth >> index);
      const mipHeight = Math.max(1, initialHeight >> index);
      this.mipDown[index].setSize(mipWidth, mipHeight);
      this.mipUp[index].setSize(mipWidth, mipHeight);
    }

    const [scatter, bloomClamp, threshold, knee] = advBloomPrefilterParameters(settings);
    this.prefilterUniforms.tInput.value = source;
    this.prefilterUniforms.uParams.value.set(scatter, bloomClamp, threshold, knee);
    this.prefilterUniforms.uTexelSize.value.set(1 / width, 1 / height);
    this.prefilterUniforms.uHighQuality.value = settings.highQualityFiltering ? 1 : 0;
    renderFullscreen(this.prefilterMaterial, this.mipDown[0], true);

    const filter = resolveAdvBloomFilterMode(settings.filter);
    const output =
      filter === "dual"
        ? this.renderDual(mipCount, Math.max(0, Math.min(1, settings.scatter)), renderFullscreen)
        : filter === "kawase"
          ? this.renderKawase(mipCount, scatter, Math.max(0, Math.min(1, settings.scatter)), renderFullscreen)
          : this.renderGaussian(mipCount, scatter, settings.highQualityFiltering, renderFullscreen);
    const linearTint = [
      unityGammaToLinear(settings.tint.r ?? settings.tint.x ?? 1),
      unityGammaToLinear(settings.tint.g ?? settings.tint.y ?? 1),
      unityGammaToLinear(settings.tint.b ?? settings.tint.z ?? 1),
    ] as const;
    const luminance = linearTint[0] * 0.2126729 + linearTint[1] * 0.7151522 + linearTint[2] * 0.072175;
    const tint =
      luminance > 0
        ? ([linearTint[0] / luminance, linearTint[1] / luminance, linearTint[2] / luminance] as const)
        : ([1, 1, 1] as const);
    return {
      texture: output.texture,
      width: output.width,
      height: output.height,
      intensity: Math.max(0, settings.intensity),
      tint,
    };
  }

  dispose(): void {
    for (const item of [...this.mipDown, ...this.mipUp]) item.dispose();
    this.prefilterMaterial.dispose();
    this.horizontalMaterial.dispose();
    this.verticalMaterial.dispose();
    this.upsampleMaterial.dispose();
    this.kawaseMaterial.dispose();
    this.dualDownsampleMaterial.dispose();
    this.dualUpsampleMaterial.dispose();
  }

  private renderGaussian(
    mipCount: number,
    scatter: number,
    highQuality: boolean,
    renderFullscreen: AdvRenderFullscreen,
  ): WebGLRenderTarget {
    for (let index = 1; index < mipCount; index += 1) {
      const previous = this.mipDown[index - 1];
      this.horizontalUniforms.tInput.value = previous.texture;
      this.horizontalUniforms.uTexelSize.value.set(1 / previous.width, 1 / previous.height);
      renderFullscreen(this.horizontalMaterial, this.mipUp[index], true);

      const temporary = this.mipUp[index];
      this.verticalUniforms.tInput.value = temporary.texture;
      this.verticalUniforms.uTexelSize.value.set(1 / temporary.width, 1 / temporary.height);
      renderFullscreen(this.verticalMaterial, this.mipDown[index], true);
    }

    for (let index = mipCount - 2; index >= 0; index -= 1) {
      const low = index === mipCount - 2 ? this.mipDown[index + 1] : this.mipUp[index + 1];
      this.upsampleUniforms.tHigh.value = this.mipDown[index].texture;
      this.upsampleUniforms.tLow.value = low.texture;
      this.upsampleUniforms.uScatter.value = scatter;
      this.upsampleUniforms.uLowTexelSize.value.set(1 / low.width, 1 / low.height);
      this.upsampleUniforms.uHighQuality.value = highQuality ? 1 : 0;
      renderFullscreen(this.upsampleMaterial, this.mipUp[index], true);
    }
    return mipCount > 1 ? this.mipUp[0] : this.mipDown[0];
  }

  private renderKawase(
    mipCount: number,
    scatter: number,
    kawaseScatter: number,
    renderFullscreen: AdvRenderFullscreen,
  ): WebGLRenderTarget {
    for (let index = 0; index < mipCount; index += 1) {
      const source = index % 2 === 0 ? this.mipDown[0] : this.mipUp[0];
      const destination = index % 2 === 0 ? this.mipUp[0] : this.mipDown[0];
      // PostProcessPassRenderGraph: 0.5 + (i > mipCount / 2 ? i - 1 : i).
      const distance = 0.5 + (index > Math.trunc(mipCount / 2) ? index - 1 : index);
      this.kawaseUniforms.tInput.value = source.texture;
      this.kawaseUniforms.uTexelSize.value.set(1 / source.width, 1 / source.height);
      this.kawaseUniforms.uDistance.value = distance;
      this.kawaseUniforms.uScatter.value = scatter;
      this.kawaseUniforms.uKawaseScatter.value = kawaseScatter;
      renderFullscreen(this.kawaseMaterial, destination, true);
    }
    return (mipCount - 1) % 2 === 0 ? this.mipUp[0] : this.mipDown[0];
  }

  private renderDual(mipCount: number, rawScatter: number, renderFullscreen: AdvRenderFullscreen): WebGLRenderTarget {
    for (let index = 1; index < mipCount; index += 1) {
      const source = this.mipDown[index - 1];
      this.dualDownsampleUniforms.tInput.value = source.texture;
      this.dualDownsampleUniforms.uTexelSize.value.set(1 / source.width, 1 / source.height);
      renderFullscreen(this.dualDownsampleMaterial, this.mipDown[index], true);
    }

    const dualScatter = 0.3 + rawScatter;
    for (let index = mipCount - 2; index >= 0; index -= 1) {
      const source = index === mipCount - 2 ? this.mipDown[index + 1] : this.mipUp[index + 1];
      this.dualUpsampleUniforms.tInput.value = source.texture;
      this.dualUpsampleUniforms.uTexelSize.value.set(1 / source.width, 1 / source.height);
      this.dualUpsampleUniforms.uScatter.value = dualScatter;
      this.dualUpsampleUniforms.uHalfScatter.value = dualScatter * 0.5;
      renderFullscreen(this.dualUpsampleMaterial, this.mipUp[index], true);
    }
    return mipCount > 1 ? this.mipUp[0] : this.mipDown[0];
  }
}
