import {
  GLSL3,
  HalfFloatType,
  LinearFilter,
  NoBlending,
  NoColorSpace,
  RGBAFormat,
  ShaderMaterial,
  Texture,
  Vector2,
  Vector4,
  WebGLRenderTarget,
} from "three";
import type { IUniform } from "three";
import { unityColorBalanceToLmsCoefficients } from "./UnityColorUtils";
import type { AdvRenderFullscreen } from "./AdvUrpBloom";
import { ADV_URP_COLOR_GRADING_LUT_SIZE, advHdrLutBlob } from "./AdvUrpMath";
import type { AdvUrpVolumeState } from "./AdvVolumeStack";
import {
  bakeUnityTextureCurve,
  prepareUnityLiftGammaGain,
  prepareUnityShadowsMidtonesHighlights,
  prepareUnitySplitToning,
  unityLinearColor,
} from "./UnityColorGrading";
import { HDR_LUT_ACES_FRAGMENT, HDR_LUT_NEUTRAL_FRAGMENT, HDR_LUT_NONE_FRAGMENT } from "./shaders/AdvHdrLutShaders";

const LUT_SIZE = ADV_URP_COLOR_GRADING_LUT_SIZE;
const LUT_WIDTH = LUT_SIZE * LUT_SIZE;

const FULLSCREEN_VERTEX = /* glsl */ `
out highp vec2 vs_TEXCOORD0;
void main() {
  vs_TEXCOORD0 = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

export type AdvHdrTonemappingMode = 0 | 1 | 2;

function fragmentForMode(mode: number): string {
  const fragment =
    advHdrLutBlob(mode) === 2
      ? HDR_LUT_ACES_FRAGMENT
      : advHdrLutBlob(mode) === 3
        ? HDR_LUT_NEUTRAL_FRAGMENT
        : HDR_LUT_NONE_FRAGMENT;
  // WebGL2 is GLES 3.0 and does not expose Unity's native explicit-uniform-
  // location extension. This changes bindings only; the reference pixel
  // program, constants, precision qualifiers and operation order stay intact.
  return fragment.replace("#define UNITY_SUPPORTS_UNIFORM_LOCATION 1", "#define UNITY_SUPPORTS_UNIFORM_LOCATION 0");
}

type HdrLutUniforms = Record<string, IUniform<unknown>> & {
  _GlobalMipBias: IUniform<Vector2>;
  _Lut_Params: IUniform<Vector4>;
  _ColorBalance: IUniform<Vector4>;
  _ColorFilter: IUniform<Vector4>;
  _ChannelMixerRed: IUniform<Vector4>;
  _ChannelMixerGreen: IUniform<Vector4>;
  _ChannelMixerBlue: IUniform<Vector4>;
  _HueSatCon: IUniform<Vector4>;
  _Lift: IUniform<Vector4>;
  _Gamma: IUniform<Vector4>;
  _Gain: IUniform<Vector4>;
  _Shadows: IUniform<Vector4>;
  _Midtones: IUniform<Vector4>;
  _Highlights: IUniform<Vector4>;
  _ShaHiLimits: IUniform<Vector4>;
  _SplitShadows: IUniform<Vector4>;
  _SplitHighlights: IUniform<Vector4>;
  _CurveMaster: IUniform<Texture | null>;
  _CurveRed: IUniform<Texture | null>;
  _CurveGreen: IUniform<Texture | null>;
  _CurveBlue: IUniform<Texture | null>;
  _CurveHueVsHue: IUniform<Texture | null>;
  _CurveHueVsSat: IUniform<Texture | null>;
  _CurveSatVsSat: IUniform<Texture | null>;
  _CurveLumVsSat: IUniform<Texture | null>;
};

function setVector(uniform: IUniform<Vector4>, value: readonly number[], w = 0): void {
  uniform.value.set(value[0], value[1], value[2], w);
}

function createMaterial(fragmentShader: string, uniforms: HdrLutUniforms): ShaderMaterial {
  return new ShaderMaterial({
    glslVersion: GLSL3,
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

/**
 * Future renderer-asset HDR grading path. It is dormant for the five packaged
 * LDR renderer assets, but all three PathID 113 variants are executable.
 */
export class AdvHdrColorGradingLut {
  private readonly target = new WebGLRenderTarget(LUT_WIDTH, LUT_SIZE, {
    depthBuffer: false,
    stencilBuffer: false,
    format: RGBAFormat,
    type: HalfFloatType,
    minFilter: LinearFilter,
    magFilter: LinearFilter,
    samples: 0,
  });
  private readonly uniforms: HdrLutUniforms = {
    _GlobalMipBias: { value: new Vector2(0, 0) },
    _Lut_Params: { value: new Vector4(LUT_SIZE, 0.5 / LUT_WIDTH, 0.5 / LUT_SIZE, LUT_SIZE / (LUT_SIZE - 1)) },
    _ColorBalance: { value: new Vector4(1, 1, 1, 0) },
    _ColorFilter: { value: new Vector4(1, 1, 1, 0) },
    _ChannelMixerRed: { value: new Vector4(1, 0, 0, 0) },
    _ChannelMixerGreen: { value: new Vector4(0, 1, 0, 0) },
    _ChannelMixerBlue: { value: new Vector4(0, 0, 1, 0) },
    _HueSatCon: { value: new Vector4(0, 1, 1, 0) },
    _Lift: { value: new Vector4(0, 0, 0, 0) },
    _Gamma: { value: new Vector4(1, 1, 1, 0) },
    _Gain: { value: new Vector4(1, 1, 1, 0) },
    _Shadows: { value: new Vector4(1, 1, 1, 0) },
    _Midtones: { value: new Vector4(1, 1, 1, 0) },
    _Highlights: { value: new Vector4(1, 1, 1, 0) },
    _ShaHiLimits: { value: new Vector4(0, 0.3, 0.55, 1) },
    _SplitShadows: { value: new Vector4(0.5, 0.5, 0.5, 0) },
    _SplitHighlights: { value: new Vector4(0.5, 0.5, 0.5, 0) },
    _CurveMaster: { value: null },
    _CurveRed: { value: null },
    _CurveGreen: { value: null },
    _CurveBlue: { value: null },
    _CurveHueVsHue: { value: null },
    _CurveHueVsSat: { value: null },
    _CurveSatVsSat: { value: null },
    _CurveLumVsSat: { value: null },
  };
  private readonly materials = new Map<1 | 2 | 3, ShaderMaterial>([
    [1, createMaterial(fragmentForMode(0), this.uniforms)],
    [2, createMaterial(fragmentForMode(2), this.uniforms)],
    [3, createMaterial(fragmentForMode(1), this.uniforms)],
  ]);
  private curveTextures: Texture[] = [];
  private lastFingerprint = "";
  private lastState: Readonly<AdvUrpVolumeState> | null = null;

  constructor() {
    this.target.texture.name = "adv-urp-internal-hdr-lut-16";
    this.target.texture.colorSpace = NoColorSpace;
    this.target.texture.generateMipmaps = false;
  }

  get texture(): Texture {
    return this.target.texture;
  }

  render(state: Readonly<AdvUrpVolumeState>, renderFullscreen: AdvRenderFullscreen): Texture {
    if (state === this.lastState) return this.target.texture;
    const mode = state.tonemapping.active ? Math.trunc(state.tonemapping.mode) : 0;
    const grading = {
      mode,
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
    setVector(this.uniforms._ColorBalance, balance);
    setVector(this.uniforms._ColorFilter, unityLinearColor(state.colorAdjustments.colorFilter));
    const mixer = state.channelMixer;
    this.uniforms._ChannelMixerRed.value.set(
      mixer.redOutRedIn / 100,
      mixer.redOutGreenIn / 100,
      mixer.redOutBlueIn / 100,
      0,
    );
    this.uniforms._ChannelMixerGreen.value.set(
      mixer.greenOutRedIn / 100,
      mixer.greenOutGreenIn / 100,
      mixer.greenOutBlueIn / 100,
      0,
    );
    this.uniforms._ChannelMixerBlue.value.set(
      mixer.blueOutRedIn / 100,
      mixer.blueOutGreenIn / 100,
      mixer.blueOutBlueIn / 100,
      0,
    );
    this.uniforms._HueSatCon.value.set(
      state.colorAdjustments.hueShift / 360,
      state.colorAdjustments.saturation / 100 + 1,
      state.colorAdjustments.contrast / 100 + 1,
      0,
    );

    const [shadows, midtones, highlights] = prepareUnityShadowsMidtonesHighlights(
      state.shadowsMidtonesHighlights.shadows,
      state.shadowsMidtonesHighlights.midtones,
      state.shadowsMidtonesHighlights.highlights,
    );
    setVector(this.uniforms._Shadows, shadows);
    setVector(this.uniforms._Midtones, midtones);
    setVector(this.uniforms._Highlights, highlights);
    this.uniforms._ShaHiLimits.value.set(
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
    setVector(this.uniforms._Lift, lift);
    setVector(this.uniforms._Gamma, gamma);
    setVector(this.uniforms._Gain, gain);

    const [splitShadows, splitHighlights] = prepareUnitySplitToning(
      state.splitToning.shadows,
      state.splitToning.highlights,
      state.splitToning.balance,
    );
    this.uniforms._SplitShadows.value.set(...splitShadows);
    setVector(this.uniforms._SplitHighlights, splitHighlights);

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
      this.uniforms._CurveMaster,
      this.uniforms._CurveRed,
      this.uniforms._CurveGreen,
      this.uniforms._CurveBlue,
      this.uniforms._CurveHueVsHue,
      this.uniforms._CurveHueVsSat,
      this.uniforms._CurveSatVsSat,
      this.uniforms._CurveLumVsSat,
    ].forEach((uniform, index) => {
      uniform.value = this.curveTextures[index];
    });

    const material = this.materials.get(advHdrLutBlob(mode));
    if (!material) throw new Error(`Missing packaged HDR LUT shader for mode ${mode}`);
    renderFullscreen(material, this.target, true);
    this.lastFingerprint = fingerprint;
    this.lastState = state;
    return this.target.texture;
  }

  dispose(): void {
    this.target.dispose();
    for (const material of this.materials.values()) material.dispose();
    this.materials.clear();
    for (const texture of this.curveTextures) texture.dispose();
    this.curveTextures = [];
  }
}
