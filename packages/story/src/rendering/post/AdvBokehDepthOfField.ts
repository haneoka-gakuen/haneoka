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
  Vector4,
  WebGLRenderTarget,
} from "three";
import type { IUniform } from "three";
import type { AdvRenderFullscreen } from "./AdvUrpBloom";
import { computeAdvBokehParameters, createAdvBokehKernel } from "./AdvUrpMath";
import type { AdvDepthOfFieldVolume } from "./AdvVolumeStack";

const SAMPLE_COUNT = 42;
const CAMERA_FAR_CLIP = 5000;

const FULLSCREEN_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

// The ADV field buffers have no depth attachment. SceneCamera clears depth and
// no later field pass writes it, so _CameraDepthTexture resolves to the camera
// far plane for every ADV pixel. Keep the shipped CoC equation explicit here.
const COC_FRAGMENT = /* glsl */ `
precision highp float;
uniform vec3 uCocParams; // focus distance, lens coefficient, linear far depth
varying vec2 vUv;
void main() {
  float coc = (1.0 - uCocParams.x / uCocParams.z) * uCocParams.y;
  float nearCoc = clamp(coc, -1.0, 0.0);
  float farCoc = clamp(coc, 0.0, 1.0);
  gl_FragColor = vec4(clamp((farCoc + nearCoc + 1.0) * 0.5, 0.0, 1.0));
}
`;

const PREFILTER_FRAGMENT = /* glsl */ `
precision highp float;
uniform sampler2D tInput;
uniform sampler2D tFullCoc;
uniform vec2 uSourceTexelSize;
uniform float uMaxRadius;
varying vec2 vUv;
vec3 fastSrgbToLinear(vec3 color) {
  return color * (color * (color * 0.305306011 + 0.682171111) + 0.012522878);
}
void main() {
  vec2 halfTexel = uSourceTexelSize * 0.5;
  vec2 uv0 = vUv + vec2(-halfTexel.x, -halfTexel.y);
  vec2 uv1 = vUv + vec2( halfTexel.x, -halfTexel.y);
  vec2 uv2 = vUv + vec2(-halfTexel.x,  halfTexel.y);
  vec2 uv3 = vUv + vec2( halfTexel.x,  halfTexel.y);
  vec3 c0 = texture2D(tInput, uv0).rgb;
  vec3 c1 = texture2D(tInput, uv1).rgb;
  vec3 c2 = texture2D(tInput, uv2).rgb;
  vec3 c3 = texture2D(tInput, uv3).rgb;
  float coc0 = texture2D(tFullCoc, uv0).r * 2.0 - 1.0;
  float coc1 = texture2D(tFullCoc, uv1).r * 2.0 - 1.0;
  float coc2 = texture2D(tFullCoc, uv2).r * 2.0 - 1.0;
  float coc3 = texture2D(tFullCoc, uv3).r * 2.0 - 1.0;
  vec3 averageColor = (c0 + c1 + c2 + c3) * 0.25;
  float cocMin = min(min(coc0, coc1), min(coc2, coc3));
  float cocMax = max(max(coc0, coc1), max(coc2, coc3));
  float coc = ((-cocMin > cocMax) ? cocMin : cocMax) * uMaxRadius;
  averageColor *= smoothstep(0.0, uSourceTexelSize.y * 2.0, abs(coc));
  averageColor = fastSrgbToLinear(averageColor);
  gl_FragColor = vec4(averageColor, coc);
}
`;

const BLUR_FRAGMENT = /* glsl */ `
precision highp float;
uniform sampler2D tInput;
uniform vec2 uInputTexelSize;
uniform vec4 uBokehKernel[${SAMPLE_COUNT}];
uniform vec2 uBokehConstants;
varying vec2 vUv;

vec2 clampBilinear(vec2 uv) {
  return clamp(uv, uInputTexelSize * 0.5, vec2(1.0) - uInputTexelSize * 0.5);
}

void accumulate(
  vec4 center,
  vec4 displacement,
  inout vec4 farAccumulation,
  inout vec4 nearAccumulation
) {
  vec2 sampleUv = clampBilinear(vUv + vec2(displacement.w, displacement.y));
  vec4 sampleColor = texture2D(tInput, sampleUv);
  float farCoc = max(min(center.a, sampleColor.a), 0.0);
  float farWeight = clamp(
    (farCoc - displacement.z + uBokehConstants.y) / uBokehConstants.y,
    0.0,
    1.0
  );
  float nearWeight = clamp(
    (-sampleColor.a - displacement.z + uBokehConstants.y) / uBokehConstants.y,
    0.0,
    1.0
  );
  nearWeight *= step(uBokehConstants.x, -sampleColor.a);
  farAccumulation += vec4(sampleColor.rgb, 1.0) * farWeight;
  nearAccumulation += vec4(sampleColor.rgb, 1.0) * nearWeight;
}

void main() {
  vec4 center = texture2D(tInput, vUv);
  vec4 farAccumulation = vec4(0.0);
  vec4 nearAccumulation = vec4(0.0);
  accumulate(center, vec4(0.0), farAccumulation, nearAccumulation);
  for (int index = 0; index < ${SAMPLE_COUNT}; index += 1) {
    accumulate(center, uBokehKernel[index], farAccumulation, nearAccumulation);
  }
  farAccumulation.rgb /= farAccumulation.a + float(farAccumulation.a == 0.0);
  nearAccumulation.rgb /= nearAccumulation.a + float(nearAccumulation.a == 0.0);
  nearAccumulation.a *= ${Math.PI} / ${SAMPLE_COUNT + 1}.0;
  float alpha = clamp(nearAccumulation.a, 0.0, 1.0);
  gl_FragColor = vec4(mix(farAccumulation.rgb, nearAccumulation.rgb, alpha), alpha);
}
`;

const POSTFILTER_FRAGMENT = /* glsl */ `
precision highp float;
uniform sampler2D tInput;
uniform vec2 uSourceTexelSize;
varying vec2 vUv;
void main() {
  vec2 offset = uSourceTexelSize;
  vec4 color = texture2D(tInput, vUv + vec2(-offset.x, -offset.y));
  color += texture2D(tInput, vUv + vec2( offset.x, -offset.y));
  color += texture2D(tInput, vUv + vec2(-offset.x,  offset.y));
  color += texture2D(tInput, vUv + vec2( offset.x,  offset.y));
  gl_FragColor = color * 0.25;
}
`;

const COMPOSITE_FRAGMENT = /* glsl */ `
precision highp float;
uniform sampler2D tInput;
uniform sampler2D tDof;
uniform sampler2D tFullCoc;
uniform vec2 uSourceTexelSize;
uniform float uMaxRadius;
varying vec2 vUv;

vec3 fastSrgbToLinear(vec3 color) {
  return color * (color * (color * 0.305306011 + 0.682171111) + 0.012522878);
}

vec3 fastLinearToSrgb(vec3 color) {
  // Unity PositivePow is pow(abs(base), exponent); the reference pass preserves it.
  return clamp(1.055 * pow(abs(color), vec3(0.416666657)) - 0.055, 0.0, 1.0);
}

vec2 clampBilinear(vec2 uv, vec2 texelSize) {
  return clamp(uv, texelSize * 0.5, vec2(1.0) - texelSize * 0.5);
}

void main() {
  vec4 dof = texture2D(tDof, clampBilinear(vUv, uSourceTexelSize * 2.0));
  float coc = texture2D(tFullCoc, clampBilinear(vUv, uSourceTexelSize)).r;
  coc = (coc - 0.5) * 2.0 * uMaxRadius;
  float farFieldAlpha = smoothstep(uSourceTexelSize.y * 2.0, uSourceTexelSize.y * 4.0, coc);
  vec4 source = texture2D(tInput, clampBilinear(vUv, uSourceTexelSize));
  vec4 linearSource = vec4(fastSrgbToLinear(source.rgb), source.a);
  float dofLuminanceAlpha = max(dof.r, max(dof.g, dof.b));
  float mixFactor = farFieldAlpha + dof.a - farFieldAlpha * dof.a;
  vec4 outputColor = mix(linearSource, vec4(dof.rgb, dofLuminanceAlpha), mixFactor);
  outputColor.rgb = source.a > 0.0 ? outputColor.rgb : linearSource.rgb;
  outputColor.a = source.a;
  outputColor.rgb = fastLinearToSrgb(outputColor.rgb);
  gl_FragColor = outputColor;
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

/** Hidden/Universal Render Pipeline/BokehDepthOfField, passes 0 through 4. */
export class AdvBokehDepthOfField {
  private readonly fullCoc = target("adv-dof-full-coc", RedFormat, UnsignedByteType);
  private readonly ping = target("adv-dof-ping", RGBAFormat, HalfFloatType);
  private readonly pong = target("adv-dof-pong", RGBAFormat, HalfFloatType);
  private readonly cocUniforms: UniformMap = {
    uCocParams: { value: new Vector4() },
  };
  private readonly prefilterUniforms: UniformMap = {
    tInput: { value: null },
    tFullCoc: { value: null },
    uSourceTexelSize: { value: new Vector2(1, 1) },
    uMaxRadius: { value: 0 },
  };
  private readonly blurUniforms: UniformMap = {
    tInput: { value: null },
    uInputTexelSize: { value: new Vector2(1, 1) },
    uBokehKernel: { value: [] },
    uBokehConstants: { value: new Vector2() },
  };
  private readonly postfilterUniforms: UniformMap = {
    tInput: { value: null },
    uSourceTexelSize: { value: new Vector2(1, 1) },
  };
  private readonly compositeUniforms: UniformMap = {
    tInput: { value: null },
    tDof: { value: null },
    tFullCoc: { value: null },
    uSourceTexelSize: { value: new Vector2(1, 1) },
    uMaxRadius: { value: 0 },
  };
  private readonly cocMaterial = material(COC_FRAGMENT, this.cocUniforms);
  private readonly prefilterMaterial = material(PREFILTER_FRAGMENT, this.prefilterUniforms);
  private readonly blurMaterial = material(BLUR_FRAGMENT, this.blurUniforms);
  private readonly postfilterMaterial = material(POSTFILTER_FRAGMENT, this.postfilterUniforms);
  private readonly compositeMaterial = material(COMPOSITE_FRAGMENT, this.compositeUniforms);
  private kernelMaxRadius = Number.NaN;
  private kernelReciprocalAspect = Number.NaN;
  private kernelBladeCount = Number.NaN;
  private kernelBladeCurvature = Number.NaN;
  private kernelBladeRotation = Number.NaN;

  render(
    source: WebGLRenderTarget,
    destination: WebGLRenderTarget,
    settings: Readonly<AdvDepthOfFieldVolume>,
    renderFullscreen: AdvRenderFullscreen,
  ): boolean {
    if (!settings.active || Math.trunc(settings.mode) !== 2) return false;

    source.texture.minFilter = LinearFilter;
    source.texture.magFilter = LinearFilter;

    const width = source.width;
    const height = source.height;
    const halfWidth = Math.max(1, Math.trunc(width / 2));
    const halfHeight = Math.max(1, Math.trunc(height / 2));
    this.fullCoc.setSize(width, height);
    this.ping.setSize(halfWidth, halfHeight);
    this.pong.setSize(halfWidth, halfHeight);

    const { lensCoefficient, maxRadius, reciprocalAspect, uvMargin } = computeAdvBokehParameters(
      settings,
      width,
      height,
    );
    const sourceTexelX = 1 / width;
    const sourceTexelY = 1 / height;

    if (
      maxRadius !== this.kernelMaxRadius ||
      reciprocalAspect !== this.kernelReciprocalAspect ||
      settings.bladeCount !== this.kernelBladeCount ||
      settings.bladeCurvature !== this.kernelBladeCurvature ||
      settings.bladeRotation !== this.kernelBladeRotation
    ) {
      this.kernelMaxRadius = maxRadius;
      this.kernelReciprocalAspect = reciprocalAspect;
      this.kernelBladeCount = settings.bladeCount;
      this.kernelBladeCurvature = settings.bladeCurvature;
      this.kernelBladeRotation = settings.bladeRotation;
      this.blurUniforms.uBokehKernel.value = createAdvBokehKernel(
        maxRadius,
        reciprocalAspect,
        settings.bladeCount,
        settings.bladeCurvature,
        settings.bladeRotation,
      );
    }

    (this.cocUniforms.uCocParams.value as Vector4).set(settings.focusDistance, lensCoefficient, CAMERA_FAR_CLIP, 0);
    renderFullscreen(this.cocMaterial, this.fullCoc, true);

    this.prefilterUniforms.tInput.value = source.texture;
    this.prefilterUniforms.tFullCoc.value = this.fullCoc.texture;
    (this.prefilterUniforms.uSourceTexelSize.value as Vector2).set(sourceTexelX, sourceTexelY);
    this.prefilterUniforms.uMaxRadius.value = maxRadius;
    renderFullscreen(this.prefilterMaterial, this.ping, true);

    this.blurUniforms.tInput.value = this.ping.texture;
    (this.blurUniforms.uInputTexelSize.value as Vector2).set(1 / halfWidth, 1 / halfHeight);
    (this.blurUniforms.uBokehConstants.value as Vector2).set(uvMargin, uvMargin * 2);
    renderFullscreen(this.blurMaterial, this.pong, true);

    this.postfilterUniforms.tInput.value = this.pong.texture;
    (this.postfilterUniforms.uSourceTexelSize.value as Vector2).set(sourceTexelX, sourceTexelY);
    renderFullscreen(this.postfilterMaterial, this.ping, true);

    this.compositeUniforms.tInput.value = source.texture;
    this.compositeUniforms.tDof.value = this.ping.texture;
    this.compositeUniforms.tFullCoc.value = this.fullCoc.texture;
    (this.compositeUniforms.uSourceTexelSize.value as Vector2).set(sourceTexelX, sourceTexelY);
    this.compositeUniforms.uMaxRadius.value = maxRadius;
    renderFullscreen(this.compositeMaterial, destination, true);
    return true;
  }

  dispose(): void {
    this.fullCoc.dispose();
    this.ping.dispose();
    this.pong.dispose();
    this.cocMaterial.dispose();
    this.prefilterMaterial.dispose();
    this.blurMaterial.dispose();
    this.postfilterMaterial.dispose();
    this.compositeMaterial.dispose();
  }
}
