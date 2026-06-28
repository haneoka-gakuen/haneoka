import {
  ClampToEdgeWrapping,
  DataTexture,
  DataUtils,
  HalfFloatType,
  LinearFilter,
  NoColorSpace,
  RedFormat,
} from "three";
import type { UnityColorValue, UnityCurveKeyframe, UnityTextureCurve } from "./AdvVolumeStack";

export type UnityVector4Tuple = readonly [number, number, number, number];

const LUMINANCE = [0.2126729, 0.7151522, 0.072175] as const;

function finite(value: unknown, fallback = 0): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function finiteOrInfinite(value: unknown, fallback = 0): number {
  const number = Number(value);
  return Number.isNaN(number) ? fallback : number;
}

/** Mathf.GammaToLinearSpace / Color.linear scalar branch used by the reference runtime. */
export function unityGammaToLinear(value: number): number {
  const channel = finite(value);
  if (channel <= 0.04045) return channel / 12.92;
  if (channel < 1) return Math.pow((channel + 0.055) / 1.055, 2.4);
  return Math.pow(channel, 2.4);
}

export function unityLinearColor(color: UnityColorValue): UnityVector4Tuple {
  return [
    unityGammaToLinear(finite(color.r ?? color.x, 1)),
    unityGammaToLinear(finite(color.g ?? color.y, 1)),
    unityGammaToLinear(finite(color.b ?? color.z, 1)),
    finite(color.a ?? color.w, 1),
  ];
}

export function unityLuminance(value: readonly number[]): number {
  return finite(value[0]) * LUMINANCE[0] + finite(value[1]) * LUMINANCE[1] + finite(value[2]) * LUMINANCE[2];
}

function trackballInput(value: UnityColorValue): UnityVector4Tuple {
  return [
    finite(value.r ?? value.x, 1),
    finite(value.g ?? value.y, 1),
    finite(value.b ?? value.z, 1),
    finite(value.a ?? value.w),
  ];
}

export function prepareUnityShadowsMidtonesHighlights(
  shadowsInput: UnityColorValue,
  midtonesInput: UnityColorValue,
  highlightsInput: UnityColorValue,
): readonly [UnityVector4Tuple, UnityVector4Tuple, UnityVector4Tuple] {
  const prepare = (input: UnityColorValue): UnityVector4Tuple => {
    const value = trackballInput(input);
    const weight = value[3] * (Math.sign(value[3]) < 0 ? 1 : 4);
    return [
      Math.max(unityGammaToLinear(value[0]) + weight, 0),
      Math.max(unityGammaToLinear(value[1]) + weight, 0),
      Math.max(unityGammaToLinear(value[2]) + weight, 0),
      0,
    ];
  };
  return [prepare(shadowsInput), prepare(midtonesInput), prepare(highlightsInput)];
}

export function prepareUnityLiftGammaGain(
  liftInput: UnityColorValue,
  gammaInput: UnityColorValue,
  gainInput: UnityColorValue,
): readonly [UnityVector4Tuple, UnityVector4Tuple, UnityVector4Tuple] {
  const liftSource = trackballInput(liftInput);
  const liftRgb = liftSource.slice(0, 3).map((value) => unityGammaToLinear(value) * 0.15);
  const liftLuminance = unityLuminance(liftRgb);
  const lift: UnityVector4Tuple = [
    liftRgb[0] - liftLuminance + liftSource[3],
    liftRgb[1] - liftLuminance + liftSource[3],
    liftRgb[2] - liftLuminance + liftSource[3],
    0,
  ];

  const gammaSource = trackballInput(gammaInput);
  const gammaRgb = gammaSource.slice(0, 3).map((value) => unityGammaToLinear(value) * 0.8);
  const gammaLuminance = unityLuminance(gammaRgb);
  const gammaWeight = gammaSource[3] + 1;
  const gamma: UnityVector4Tuple = [
    1 / Math.max(gammaRgb[0] - gammaLuminance + gammaWeight, 0.001),
    1 / Math.max(gammaRgb[1] - gammaLuminance + gammaWeight, 0.001),
    1 / Math.max(gammaRgb[2] - gammaLuminance + gammaWeight, 0.001),
    0,
  ];

  const gainSource = trackballInput(gainInput);
  const gainRgb = gainSource.slice(0, 3).map((value) => unityGammaToLinear(value) * 0.8);
  const gainLuminance = unityLuminance(gainRgb);
  const gainWeight = gainSource[3] + 1;
  const gain: UnityVector4Tuple = [
    gainRgb[0] - gainLuminance + gainWeight,
    gainRgb[1] - gainLuminance + gainWeight,
    gainRgb[2] - gainLuminance + gainWeight,
    0,
  ];

  return [lift, gamma, gain];
}

export function prepareUnitySplitToning(
  shadows: UnityColorValue,
  highlights: UnityColorValue,
  balance: number,
): readonly [UnityVector4Tuple, UnityVector4Tuple] {
  // Intentionally sRGB. ColorUtils.PrepareSplitToning does not call
  // GammaToLinearSpace; compiled LutBuilderLdr blob 1 agrees.
  return [
    [
      finite(shadows.r ?? shadows.x, 0.5),
      finite(shadows.g ?? shadows.y, 0.5),
      finite(shadows.b ?? shadows.z, 0.5),
      finite(balance) / 100,
    ],
    [
      finite(highlights.r ?? highlights.x, 0.5),
      finite(highlights.g ?? highlights.y, 0.5),
      finite(highlights.b ?? highlights.z, 0.5),
      0,
    ],
  ];
}

function unitySoftLight(base: number, blend: number): number {
  const lower = 2 * base * blend + base * base * (1 - 2 * blend);
  const upper = Math.sqrt(base) * (2 * blend - 1) + 2 * base * (1 - blend);
  return blend >= 0.5 ? upper : lower;
}

/** LutBuilderLdr blob 1 SplitToning pixel oracle (linear RGB in/out). */
export function applyUnitySplitToning(
  linear: readonly [number, number, number],
  shadows: UnityColorValue,
  highlights: UnityColorValue,
  balance: number,
): readonly [number, number, number] {
  const [shadow, highlight] = prepareUnitySplitToning(shadows, highlights, balance);
  let gamma = linear.map((channel) => Math.pow(Math.max(finite(channel), 0), 0.454545468)) as [number, number, number];
  const weight = Math.max(0, Math.min(1, unityLuminance(gamma.map((channel) => Math.min(channel, 1))) + shadow[3]));
  const shadowBlend = shadow.slice(0, 3).map((channel) => 0.5 + (channel - 0.5) * (1 - weight));
  const highlightBlend = highlight.slice(0, 3).map((channel) => 0.5 + (channel - 0.5) * weight);
  gamma = gamma.map((channel, index) => unitySoftLight(channel, shadowBlend[index])) as [number, number, number];
  gamma = gamma.map((channel, index) => unitySoftLight(channel, highlightBlend[index])) as [number, number, number];
  return gamma.map((channel) => Math.pow(Math.abs(channel), 2.20000005)) as [number, number, number];
}

function curveKeys(curve: UnityTextureCurve): UnityCurveKeyframe[] {
  return [...(curve.m_Curve?.m_Curve ?? [])]
    .map((key) => ({
      time: finite(key.time),
      value: finite(key.value),
      inSlope: finiteOrInfinite(key.inSlope),
      outSlope: finiteOrInfinite(key.outSlope),
      weightedMode: finite(key.weightedMode),
      inWeight: finite(key.inWeight, 1 / 3),
      outWeight: finite(key.outWeight, 1 / 3),
    }))
    .sort((left, right) => left.time - right.time);
}

function hermite(left: UnityCurveKeyframe, right: UnityCurveKeyframe, time: number): number {
  const duration = right.time - left.time;
  if (duration <= 0) return right.value;
  const t = Math.max(0, Math.min(1, (time - left.time) / duration));
  const t2 = t * t;
  const t3 = t2 * t;
  const h00 = 2 * t3 - 3 * t2 + 1;
  const h10 = t3 - 2 * t2 + t;
  const h01 = -2 * t3 + 3 * t2;
  const h11 = t3 - t2;
  return h00 * left.value + h10 * duration * left.outSlope + h01 * right.value + h11 * duration * right.inSlope;
}

function cubicBezier(a: number, b: number, c: number, d: number, amount: number): number {
  const inverse = 1 - amount;
  return (
    inverse * inverse * inverse * a +
    3 * inverse * inverse * amount * b +
    3 * inverse * amount * amount * c +
    amount * amount * amount * d
  );
}

function cubicBezierDerivative(a: number, b: number, c: number, d: number, amount: number): number {
  const inverse = 1 - amount;
  return 3 * inverse * inverse * (b - a) + 6 * inverse * amount * (c - b) + 3 * amount * amount * (d - c);
}

function weightedSegment(left: UnityCurveKeyframe, right: UnityCurveKeyframe, time: number): number {
  const duration = right.time - left.time;
  if (duration <= 0) return right.value;
  if (!Number.isFinite(left.outSlope) || !Number.isFinite(right.inSlope)) return left.value;
  const leftWeight =
    (finite(left.weightedMode) & 2) !== 0 ? Math.max(0, Math.min(1, finite(left.outWeight, 1 / 3))) : 1 / 3;
  const rightWeight =
    (finite(right.weightedMode) & 1) !== 0 ? Math.max(0, Math.min(1, finite(right.inWeight, 1 / 3))) : 1 / 3;
  const x1 = left.time + duration * leftWeight;
  const x2 = right.time - duration * rightWeight;
  const y1 = left.value + left.outSlope * duration * leftWeight;
  const y2 = right.value - right.inSlope * duration * rightWeight;

  let parameter = Math.max(0, Math.min(1, (time - left.time) / duration));
  for (let iteration = 0; iteration < 8; iteration += 1) {
    const error = cubicBezier(left.time, x1, x2, right.time, parameter) - time;
    if (Math.abs(error) <= 1e-7) break;
    const derivative = cubicBezierDerivative(left.time, x1, x2, right.time, parameter);
    if (Math.abs(derivative) <= 1e-7) break;
    const candidate = parameter - error / derivative;
    if (candidate < 0 || candidate > 1) break;
    parameter = candidate;
  }
  let low = 0;
  let high = 1;
  for (let iteration = 0; iteration < 20; iteration += 1) {
    const x = cubicBezier(left.time, x1, x2, right.time, parameter);
    if (Math.abs(x - time) <= 1e-7) break;
    if (x < time) low = parameter;
    else high = parameter;
    parameter = (low + high) * 0.5;
  }
  return cubicBezier(left.value, y1, y2, right.value, parameter);
}

function positiveModulo(value: number, modulus: number): number {
  return ((value % modulus) + modulus) % modulus;
}

function wrappedCurveTime(time: number, first: number, last: number, mode: number): number {
  const duration = last - first;
  if (!(duration > 0)) return first;
  if (mode === 2) return first + positiveModulo(time - first, duration);
  if (mode === 4) {
    const position = positiveModulo(time - first, duration * 2);
    return first + (position <= duration ? position : duration * 2 - position);
  }
  // Default, Once/Clamp and ClampForever all hold the endpoint for an
  // AnimationCurve (WrapMode values 0, 1 and 8 in this engine build).
  return Math.max(first, Math.min(last, time));
}

/** AnimationCurve.Evaluate including weighted tangents and serialized wrap modes. */
export function evaluateUnityTextureCurve(curve: UnityTextureCurve, time: number): number {
  const source = curveKeys(curve);
  if (source.length === 0) return finite(curve.m_ZeroValue);
  if (source.length === 1) return source[0].value;

  const loop = Boolean(curve.m_Loop);
  const range = Math.max(Number.EPSILON, finite(curve.m_Range, 1));
  let keys = source;
  if (loop) {
    keys = [
      { ...source[source.length - 1], time: source[source.length - 1].time - range },
      ...source,
      { ...source[0], time: source[0].time + range },
    ];
  }
  const firstTime = keys[0].time;
  const lastTime = keys[keys.length - 1].time;
  let sampleTime = finite(time, firstTime);
  if (sampleTime < firstTime) {
    sampleTime = wrappedCurveTime(sampleTime, firstTime, lastTime, finite(curve.m_Curve?.m_PreInfinity));
  } else if (sampleTime > lastTime) {
    sampleTime = wrappedCurveTime(sampleTime, firstTime, lastTime, finite(curve.m_Curve?.m_PostInfinity));
  }
  if (sampleTime <= firstTime) return keys[0].value;
  if (sampleTime >= lastTime) return keys[keys.length - 1].value;
  for (let index = 0; index < keys.length - 1; index += 1) {
    const left = keys[index];
    const right = keys[index + 1];
    if (sampleTime < left.time || sampleTime > right.time) continue;
    if (sampleTime === right.time) return right.value;
    if (!Number.isFinite(left.outSlope) || !Number.isFinite(right.inSlope)) return left.value;
    const weighted = (finite(left.weightedMode) & 2) !== 0 || (finite(right.weightedMode) & 1) !== 0;
    return weighted ? weightedSegment(left, right, sampleTime) : hermite(left, right, sampleTime);
  }
  return keys[keys.length - 1].value;
}

/** TextureCurve.GetTexture: 128 R16_SFloat samples at i / 128. */
export function bakeUnityTextureCurve(curve: UnityTextureCurve): DataTexture {
  const data = new Uint16Array(128);
  for (let index = 0; index < data.length; index += 1) {
    data[index] = DataUtils.toHalfFloat(evaluateUnityTextureCurve(curve, index / 128));
  }
  const texture = new DataTexture(data, 128, 1, RedFormat, HalfFloatType);
  texture.name = "Unity TextureCurve 128 R16_SFloat";
  texture.colorSpace = NoColorSpace;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.wrapS = ClampToEdgeWrapping;
  texture.wrapT = ClampToEdgeWrapping;
  texture.generateMipmaps = false;
  texture.unpackAlignment = 1;
  texture.needsUpdate = true;
  return texture;
}
