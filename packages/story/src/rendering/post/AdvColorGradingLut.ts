import {
  LinearFilter,
  NoBlending,
  NoColorSpace,
  RGBAFormat,
  ShaderMaterial,
  Texture,
  UnsignedByteType,
  Vector3,
  Vector4,
  WebGLRenderTarget,
} from "three";
import type { IUniform } from "three";
import { unityColorBalanceToLmsCoefficients } from "./UnityColorUtils";
import type { AdvRenderFullscreen } from "./AdvUrpBloom";
import { ADV_URP_COLOR_GRADING_LUT_SIZE } from "./AdvUrpMath";
import type { AdvUrpVolumeState } from "./AdvVolumeStack";
import {
  bakeUnityTextureCurve,
  prepareUnityLiftGammaGain,
  prepareUnityShadowsMidtonesHighlights,
  prepareUnitySplitToning,
  unityLinearColor,
} from "./UnityColorGrading";

// All five reference UniversalRenderPipelineAsset objects serialize
// m_ColorGradingLutSize=16. This is intentionally not URP's editor default.
const LUT_SIZE = ADV_URP_COLOR_GRADING_LUT_SIZE;
const LUT_WIDTH = LUT_SIZE * LUT_SIZE;

const FULLSCREEN_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

// Reference GLES3 LUT contract. The constants and operation order preserve
// gamma-space split toning and two 128-sample curve lookups.
const LUT_BUILDER_FRAGMENT = /* glsl */ `
precision highp float;
uniform vec4 uLutParams;
uniform vec3 uColorBalance;
uniform vec3 uColorFilter;
uniform vec3 uChannelMixerRed;
uniform vec3 uChannelMixerGreen;
uniform vec3 uChannelMixerBlue;
uniform vec3 uHueSatCon;
uniform vec3 uLift;
uniform vec3 uGamma;
uniform vec3 uGain;
uniform vec3 uShadows;
uniform vec3 uMidtones;
uniform vec3 uHighlights;
uniform vec4 uShaHiLimits;
uniform vec4 uSplitShadows;
uniform vec3 uSplitHighlights;
uniform sampler2D tCurveMaster;
uniform sampler2D tCurveRed;
uniform sampler2D tCurveGreen;
uniform sampler2D tCurveBlue;
uniform sampler2D tCurveHueVsHue;
uniform sampler2D tCurveHueVsSat;
uniform sampler2D tCurveSatVsSat;
uniform sampler2D tCurveLumVsSat;
varying vec2 vUv;

float advLuminance(vec3 value) {
  return dot(value, vec3(0.212672904, 0.715152204, 0.0721750036));
}

float evaluateCurve(sampler2D curve, float value) {
  return clamp(texture2D(curve, vec2(value, 0.0)).r, 0.0, 1.0);
}

vec3 softLight(vec3 base, vec3 blend) {
  vec3 r1 = 2.0 * base * blend + base * base * (1.0 - 2.0 * blend);
  vec3 r2 = sqrt(base) * (2.0 * blend - 1.0) + 2.0 * base * (1.0 - blend);
  return mix(r1, r2, step(vec3(0.5), blend));
}

vec3 rgbToHsv(vec3 c) {
  vec4 K = vec4(0.0, -0.333333343, 0.666666687, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + 9.99999975e-05)), d / (q.x + 9.99999975e-05), q.x);
}

vec3 hsvToRgb(vec3 c) {
  vec3 p = abs(fract(c.xxx + vec3(1.0, 0.666666687, 0.333333343)) * 6.0 - 3.0);
  return c.z * mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), c.y);
}

float rotateHue(float value) {
  return value < 0.0 ? value + 1.0 : (value > 1.0 ? value - 1.0 : value);
}

vec3 lutStripValue(vec2 uv) {
  uv.x *= uLutParams.x;
  float base = floor(uv.x);
  uv.x -= base;
  vec3 color = vec3(uv - uLutParams.zz, base * 2.0 * uLutParams.z);
  return color * uLutParams.w;
}

void main() {
  vec3 color = lutStripValue(vUv);

  vec3 lms;
  lms.x = dot(vec3(0.390404999, 0.549941003, 0.00892631989), color);
  lms.y = dot(vec3(0.070841603, 0.963172019, 0.00135775004), color);
  lms.z = dot(vec3(0.0231081992, 0.128021002, 0.936245024), color);
  lms *= uColorBalance;
  color.x = dot(vec3(2.85846996, -1.62879002, -0.0248910002), lms);
  color.y = dot(vec3(-0.210181996, 1.15820003, 0.000324280991), lms);
  color.z = dot(vec3(-0.0418119989, -0.118169002, 1.06867003), lms);

  // LinearToLogC -> contrast about ACEScc mid gray -> LogCToLinear. These
  // constants are the folded values emitted by the shipped GLES compiler.
  color = max(color * 5.55555582 + 0.0479959995, 0.0);
  color = log2(color) * 0.0734997839 - 0.0275523961;
  color = color * uHueSatCon.z + 0.0275523961;
  color = exp2(color * 13.6054821) - 0.0479959995;
  color *= 0.179999992;
  color *= uColorFilter;
  color = max(color, 0.0);

  vec3 gammaColor = pow(color, vec3(0.454545468));
  float splitWeight = clamp(advLuminance(min(gammaColor, 1.0)) + uSplitShadows.w, 0.0, 1.0);
  vec3 splitShadow = mix(vec3(0.5), uSplitShadows.rgb, 1.0 - splitWeight);
  vec3 splitHighlight = mix(vec3(0.5), uSplitHighlights, splitWeight);
  gammaColor = softLight(gammaColor, splitShadow);
  gammaColor = softLight(gammaColor, splitHighlight);
  color = pow(abs(gammaColor), vec3(2.20000005));

  color = vec3(
    dot(color, uChannelMixerRed),
    dot(color, uChannelMixerGreen),
    dot(color, uChannelMixerBlue)
  );

  float luma = advLuminance(color);
  float shadowT = clamp((luma - uShaHiLimits.x) / (uShaHiLimits.y - uShaHiLimits.x), 0.0, 1.0);
  float highlightT = clamp((luma - uShaHiLimits.z) / (uShaHiLimits.w - uShaHiLimits.z), 0.0, 1.0);
  float shadowFactor = 1.0 - shadowT * shadowT * (3.0 - 2.0 * shadowT);
  float highlightFactor = highlightT * highlightT * (3.0 - 2.0 * highlightT);
  float midtoneFactor = 1.0 - shadowFactor - highlightFactor;
  color = color * uShadows * shadowFactor
        + color * uMidtones * midtoneFactor
        + color * uHighlights * highlightFactor;

  color = color * uGain + uLift;
  color = sign(color) * pow(abs(color), uGamma);

  vec3 hsv = rgbToHsv(color);
  float originalHue = abs(hsv.x);
  float originalSaturation = hsv.y;
  float originalLuminance = advLuminance(color);
  float hueForCurve = originalHue + uHueSatCon.x;
  float hueOffset = evaluateCurve(tCurveHueVsHue, hueForCurve) - 0.5;
  hsv.x = rotateHue(hueForCurve + hueOffset);
  color = hsvToRgb(hsv);

  float satMultiplier = evaluateCurve(tCurveHueVsSat, originalHue) * 2.0;
  satMultiplier *= evaluateCurve(tCurveSatVsSat, originalSaturation) * 2.0;
  satMultiplier *= evaluateCurve(tCurveLumVsSat, originalLuminance) * 2.0;
  luma = advLuminance(color);
  color = vec3(luma) + (uHueSatCon.y * satMultiplier) * (color - vec3(luma));

  const float halfPixel = 0.00390625;
  vec3 masterInput = color + halfPixel;
  color = vec3(
    evaluateCurve(tCurveMaster, masterInput.r),
    evaluateCurve(tCurveMaster, masterInput.g),
    evaluateCurve(tCurveMaster, masterInput.b)
  );
  vec3 rgbInput = color + halfPixel;
  color = vec3(
    evaluateCurve(tCurveRed, rgbInput.r),
    evaluateCurve(tCurveGreen, rgbInput.g),
    evaluateCurve(tCurveBlue, rgbInput.b)
  );
  gl_FragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
}
`;

type LutUniforms = Record<string, IUniform<unknown>> & {
  uLutParams: IUniform<Vector4>;
  uColorBalance: IUniform<Vector3>;
  uColorFilter: IUniform<Vector3>;
  uChannelMixerRed: IUniform<Vector3>;
  uChannelMixerGreen: IUniform<Vector3>;
  uChannelMixerBlue: IUniform<Vector3>;
  uHueSatCon: IUniform<Vector3>;
  uLift: IUniform<Vector3>;
  uGamma: IUniform<Vector3>;
  uGain: IUniform<Vector3>;
  uShadows: IUniform<Vector3>;
  uMidtones: IUniform<Vector3>;
  uHighlights: IUniform<Vector3>;
  uShaHiLimits: IUniform<Vector4>;
  uSplitShadows: IUniform<Vector4>;
  uSplitHighlights: IUniform<Vector3>;
  tCurveMaster: IUniform<Texture | null>;
  tCurveRed: IUniform<Texture | null>;
  tCurveGreen: IUniform<Texture | null>;
  tCurveBlue: IUniform<Texture | null>;
  tCurveHueVsHue: IUniform<Texture | null>;
  tCurveHueVsSat: IUniform<Texture | null>;
  tCurveSatVsSat: IUniform<Texture | null>;
  tCurveLumVsSat: IUniform<Texture | null>;
};

function vector3(value: readonly number[]): Vector3 {
  return new Vector3(value[0], value[1], value[2]);
}

export class AdvColorGradingLut {
  private readonly target = new WebGLRenderTarget(LUT_WIDTH, LUT_SIZE, {
    depthBuffer: false,
    stencilBuffer: false,
    format: RGBAFormat,
    type: UnsignedByteType,
    minFilter: LinearFilter,
    magFilter: LinearFilter,
    samples: 0,
  });
  private readonly uniforms: LutUniforms = {
    uLutParams: { value: new Vector4(LUT_SIZE, 0.5 / LUT_WIDTH, 0.5 / LUT_SIZE, LUT_SIZE / (LUT_SIZE - 1)) },
    uColorBalance: { value: new Vector3(1, 1, 1) },
    uColorFilter: { value: new Vector3(1, 1, 1) },
    uChannelMixerRed: { value: new Vector3(1, 0, 0) },
    uChannelMixerGreen: { value: new Vector3(0, 1, 0) },
    uChannelMixerBlue: { value: new Vector3(0, 0, 1) },
    uHueSatCon: { value: new Vector3(0, 1, 1) },
    uLift: { value: new Vector3() },
    uGamma: { value: new Vector3(1, 1, 1) },
    uGain: { value: new Vector3(1, 1, 1) },
    uShadows: { value: new Vector3(1, 1, 1) },
    uMidtones: { value: new Vector3(1, 1, 1) },
    uHighlights: { value: new Vector3(1, 1, 1) },
    uShaHiLimits: { value: new Vector4(0, 0.3, 0.55, 1) },
    uSplitShadows: { value: new Vector4(0.5, 0.5, 0.5, 0) },
    uSplitHighlights: { value: new Vector3(0.5, 0.5, 0.5) },
    tCurveMaster: { value: null },
    tCurveRed: { value: null },
    tCurveGreen: { value: null },
    tCurveBlue: { value: null },
    tCurveHueVsHue: { value: null },
    tCurveHueVsSat: { value: null },
    tCurveSatVsSat: { value: null },
    tCurveLumVsSat: { value: null },
  };
  private readonly material = new ShaderMaterial({
    vertexShader: FULLSCREEN_VERTEX,
    fragmentShader: LUT_BUILDER_FRAGMENT,
    uniforms: this.uniforms,
    depthTest: false,
    depthWrite: false,
    blending: NoBlending,
    transparent: false,
    toneMapped: false,
  });
  private curveTextures: Texture[] = [];
  private lastFingerprint = "";
  private lastState: Readonly<AdvUrpVolumeState> | null = null;

  constructor() {
    this.target.texture.name = "adv-urp-internal-ldr-lut-16";
    this.target.texture.colorSpace = NoColorSpace;
    this.target.texture.generateMipmaps = false;
  }

  get texture(): Texture {
    return this.target.texture;
  }

  render(state: Readonly<AdvUrpVolumeState>, renderFullscreen: AdvRenderFullscreen): Texture {
    // AdvUrpPostProcessor replaces the resolved volume state whenever a layer
    // changes. The common frame path keeps the same immutable state object, so
    // avoid rebuilding and serializing a grading projection every frame.
    if (state === this.lastState) return this.target.texture;
    const grading = {
      splitToning: state.splitToning,
      colorAdjustments: state.colorAdjustments,
      whiteBalance: state.whiteBalance,
      liftGammaGain: state.liftGammaGain,
      shadowsMidtonesHighlights: state.shadowsMidtonesHighlights,
      channelMixer: state.channelMixer,
      colorCurves: state.colorCurves,
    };
    const fingerprint = JSON.stringify(grading);
    if (fingerprint === this.lastFingerprint) {
      this.lastState = state;
      return this.target.texture;
    }

    const balance = unityColorBalanceToLmsCoefficients(state.whiteBalance.temperature, state.whiteBalance.tint);
    this.uniforms.uColorBalance.value.set(...balance);
    const linearFilter = unityLinearColor(state.colorAdjustments.colorFilter);
    this.uniforms.uColorFilter.value.set(linearFilter[0], linearFilter[1], linearFilter[2]);
    const mixer = state.channelMixer;
    this.uniforms.uChannelMixerRed.value.set(
      mixer.redOutRedIn / 100,
      mixer.redOutGreenIn / 100,
      mixer.redOutBlueIn / 100,
    );
    this.uniforms.uChannelMixerGreen.value.set(
      mixer.greenOutRedIn / 100,
      mixer.greenOutGreenIn / 100,
      mixer.greenOutBlueIn / 100,
    );
    this.uniforms.uChannelMixerBlue.value.set(
      mixer.blueOutRedIn / 100,
      mixer.blueOutGreenIn / 100,
      mixer.blueOutBlueIn / 100,
    );
    this.uniforms.uHueSatCon.value.set(
      state.colorAdjustments.hueShift / 360,
      state.colorAdjustments.saturation / 100 + 1,
      state.colorAdjustments.contrast / 100 + 1,
    );

    const [shadows, midtones, highlights] = prepareUnityShadowsMidtonesHighlights(
      state.shadowsMidtonesHighlights.shadows,
      state.shadowsMidtonesHighlights.midtones,
      state.shadowsMidtonesHighlights.highlights,
    );
    this.uniforms.uShadows.value.copy(vector3(shadows));
    this.uniforms.uMidtones.value.copy(vector3(midtones));
    this.uniforms.uHighlights.value.copy(vector3(highlights));
    this.uniforms.uShaHiLimits.value.set(
      state.shadowsMidtonesHighlights.shadowsStart,
      state.shadowsMidtonesHighlights.shadowsEnd,
      state.shadowsMidtonesHighlights.highlightsStart,
      state.shadowsMidtonesHighlights.highlightsEnd,
    );

    const [lift, gamma, gain] = prepareUnityLiftGammaGain(
      state.liftGammaGain.lift,
      state.liftGammaGain.gamma,
      state.liftGammaGain.gain,
    );
    this.uniforms.uLift.value.copy(vector3(lift));
    this.uniforms.uGamma.value.copy(vector3(gamma));
    this.uniforms.uGain.value.copy(vector3(gain));

    const [splitShadows, splitHighlights] = prepareUnitySplitToning(
      state.splitToning.shadows,
      state.splitToning.highlights,
      state.splitToning.balance,
    );
    this.uniforms.uSplitShadows.value.set(...splitShadows);
    this.uniforms.uSplitHighlights.value.copy(vector3(splitHighlights));

    for (const texture of this.curveTextures) texture.dispose();
    const curves = state.colorCurves;
    this.curveTextures = [
      bakeUnityTextureCurve(curves.master),
      bakeUnityTextureCurve(curves.red),
      bakeUnityTextureCurve(curves.green),
      bakeUnityTextureCurve(curves.blue),
      bakeUnityTextureCurve(curves.hueVsHue),
      bakeUnityTextureCurve(curves.hueVsSat),
      bakeUnityTextureCurve(curves.satVsSat),
      bakeUnityTextureCurve(curves.lumVsSat),
    ];
    [
      this.uniforms.tCurveMaster,
      this.uniforms.tCurveRed,
      this.uniforms.tCurveGreen,
      this.uniforms.tCurveBlue,
      this.uniforms.tCurveHueVsHue,
      this.uniforms.tCurveHueVsSat,
      this.uniforms.tCurveSatVsSat,
      this.uniforms.tCurveLumVsSat,
    ].forEach((uniform, index) => {
      uniform.value = this.curveTextures[index];
    });
    renderFullscreen(this.material, this.target, true);
    this.lastFingerprint = fingerprint;
    this.lastState = state;
    return this.target.texture;
  }

  dispose(): void {
    this.target.dispose();
    this.material.dispose();
    for (const texture of this.curveTextures) texture.dispose();
    this.curveTextures = [];
  }
}
