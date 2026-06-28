import {
  AddEquation,
  BufferAttribute,
  BufferGeometry,
  ClampToEdgeWrapping,
  CustomBlending,
  DataTexture,
  DoubleSide,
  DynamicDrawUsage,
  Group,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  LinearFilter,
  Mesh,
  NoColorSpace,
  OneFactor,
  PlaneGeometry,
  RGBAFormat,
  ShaderMaterial,
  SrcAlphaFactor,
  TextureLoader,
  UnsignedByteType,
  Vector2,
  Vector3,
  Vector4,
} from "three";
import type { OneMinusSrcAlphaFactor, Texture } from "three";
import { EFFECT001_PREFAB_IDS } from "../assets/manifest";
import { unityStringHash } from "../assets/unityHash";
import type {
  Effect001AnimationJudgement,
  Effect001ParticleSystemAssetRef,
  Effect001PrefabAssetRef,
  Effect001SpriteAssetRef,
  Effect001SpriteName,
  Effect001TextureKey,
  LaneEffectAssetKey,
  LaneEffectParticleAssetRef,
  OurNotesAssetManifest,
} from "../assets/manifest";
import { isRenderLaneEffectKind, type RenderLaneEffectKind, type RenderParticleEffect } from "./types";
import { StageProjector } from "./stageGeometry";

type NativeRecord = Record<string, unknown>;
type BillboardTextureKey = Exclude<Effect001TextureKey, "wall">;
type LoadedTextureKey = Effect001TextureKey | "line" | "pillar" | "laneEffect";
type EffectMeshShaderMode = "mobileAddHdr" | "uiAdditive";

interface NativeColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface NativeParticleSystemData {
  raw: NativeRecord;
  length: number;
  simulationSpeed: number;
  looping: boolean;
  maxParticles: number;
  /** Serialized `moveWithTransform`; Unity ParticleSystemSimulationSpace. */
  simulationSpace: 0 | 1 | 2;
  /** Serialized ParticleSystemScalingMode. */
  scalingMode: number;
}

interface LoadedParticleSystem extends NativeParticleSystemData {
  ref: Effect001ParticleSystemAssetRef;
  emissionBuffer: ParticleEmission[];
  emissionPool: ParticleEmission[];
}

interface NativeClipFrame {
  time: number;
  coefficients: Map<number, readonly [number, number, number, number]>;
}

interface NativeClipBinding {
  path: number;
  attribute: number;
  curveStart: number;
  componentCount: number;
}

export interface NativeAnimationClip {
  duration: number;
  streamedCurveCount: number;
  constantValues: ReadonlyArray<number>;
  frames: ReadonlyArray<NativeClipFrame>;
  bindings: ReadonlyArray<NativeClipBinding>;
  bindingLookup: ReadonlyMap<number, ReadonlyMap<number, NativeClipBinding>>;
}

interface LoadedPrefab {
  manifest: Effect001PrefabAssetRef;
  systems: ReadonlyArray<LoadedParticleSystem>;
  animation?: NativeAnimationClip;
  animations: ReadonlyMap<Effect001AnimationJudgement, NativeAnimationClip>;
  distanceAnimation?: NativeAnimationClip;
  wallSystem?: LoadedParticleSystem;
}

interface ParticleEmission {
  simulationTime: number;
  originX: number;
  originY: number;
  originZ: number;
  index: number;
}

interface EmissionRing {
  readonly records: ParticleEmission[];
  head: number;
  count: number;
}

interface IncrementalEmissionState {
  initialized: boolean;
  seed: number;
  lastAge: number;
  nextRateStart: number;
  rateRemainder: number;
  emitted: number;
  stepRemainder: number;
  stepEmitted: number;
  stepEvaluations: number;
  rebuilds: number;
  readonly persistent: EmissionRing;
  readonly transient: EmissionRing;
  readonly output: ParticleEmission[];
}

interface ParticleSample {
  x: number;
  y: number;
  z: number;
  sizeX: number;
  sizeY: number;
  sizeZ: number;
  color: NativeColor;
  rotation: number;
}

/**
 * A ParticleSystem GameObject can be enabled partway through an Animator
 * state. Its simulation time starts at that authored edge, while a moving
 * parent Transform continues to use the state's absolute time.
 */
interface ParticlePlayback {
  age: number;
  animationTimeOffset: number;
}

/**
 * ParticleSystem.simulationSpeed is animatable in tap_flick. The Animator
 * value is a rate in simulated seconds per real second, so every particle
 * property must use its integral rather than `age * serializedSpeed`.
 */
interface ParticleSimulationClock {
  current: number;
  timeAt(realTime: number): number;
}

interface ImpactVisual {
  root: Group;
  lastSeen: number;
  prefabId: number;
  readonly emissionStates: Map<LoadedParticleSystem, IncrementalEmissionState>;
}

const EMPTY_EFFECTS: ReadonlyArray<RenderParticleEffect> = [];
const EMPTY_VALUES: ReadonlyArray<unknown> = [];
const LANE_EFFECT_EMISSION: ParticleEmission = { simulationTime: 0, originX: 0, originY: 0, originZ: 0, index: 0 };
// The native lane-effect prefab root is +90° around Unity X. StageProjector
// reflects Unity Z into Three space, so the equivalent rendered rotation is
// -90°. Keeping the Unity sign here flips the long normal-lane fill behind
// the judgement line and makes it look like an invented lateral sweep.
const LANE_EFFECT_UNITY_TO_THREE_ROTATION_X = -Math.PI / 2;
function laneEffectAssetKey(kind: RenderLaneEffectKind): LaneEffectAssetKey {
  switch (kind) {
    case "lane-input-blank-miss":
      return "inVain";
    case "lane-effect-normal":
      return "normal";
    case "lane-effect-slide":
      return "slide";
    case "lane-effect-flick":
      return "flick";
    case "lane-effect-flick-left":
      return "flickLeft";
    case "lane-effect-flick-right":
      return "flickRight";
  }
}
const SPRITE_NAMES: ReadonlyArray<Effect001SpriteName> = ["frame", "pillar01", "pillar02", "pillar03", "pillar04"];
const PATH_HASH: Readonly<Record<Effect001SpriteName, number>> = {
  frame: unityStringHash("frame"),
  pillar01: unityStringHash("pillar01"),
  pillar02: unityStringHash("pillar02"),
  pillar03: unityStringHash("pillar03"),
  pillar04: unityStringHash("pillar04"),
};
const ATTRIBUTE_COLOR_ALPHA = unityStringHash("m_Color.a");
const ATTRIBUTE_SIZE_X = unityStringHash("m_Size.x");
const ATTRIBUTE_ACTIVE = unityStringHash("m_IsActive");
const ATTRIBUTE_TRANSFORM_POSITION = 1;
const ATTRIBUTE_PARTICLE_SIMULATION_SPEED = unityStringHash("simulationSpeed");
const EMISSION_STEP = 1 / 60;
// The source up-flick reaches 144 non-wall particles inside one Animator
// window. This is a GPU allocation budget only: Unity's max-particle limit is
// per ParticleSystem, so a shared, prefab-order cap would incorrectly remove
// the late long-star and center-pillar systems.
const SOURCE_EFFECT_PARTICLE_BUFFER_PER_EFFECT = 160;
// External references in every effect001 prefab resolve to these three
// Custom/Mobile/MobileAddHdrColor materials. The compiled GLES3 shader
// multiplies _TintColor in both vertex and fragment stages and doubles the
// fragment color; omitting this made the HDR beams 18-36x dimmer.
export const MOBILE_ADD_HDR_TINT_NORMAL = [
  2.9960782527923584, 2.9960782527923584, 2.9960782527923584, 0.615686297416687,
] as const;
// ef_tap_normal_long_glow.mat: same HDR RGB as normal stars but a distinct
// alpha. The shader applies this tint twice, so treating it as normal makes
// the long streaks visibly overexposed.
export const MOBILE_ADD_HDR_TINT_LONG_STAR = [
  2.9960782527923584, 2.9960782527923584, 2.9960782527923584, 0.4901960790157318,
] as const;
// ef_tap_pillar_glow(.02).mat: both authored center-pillar masks use half
// the HDR RGB of the normal particle material. Reusing the normal tint here
// quadruples the final RGB because MobileAddHdrColor multiplies twice.
export const MOBILE_ADD_HDR_TINT_CENTER_PILLAR = [
  1.4980392456054688, 1.4980392456054688, 1.4980392456054688, 0.4901960790157318,
] as const;
export const MOBILE_ADD_HDR_TINT_STRONG = [
  4.237094402313232, 4.237094402313232, 4.237094402313232, 0.5490196347236633,
] as const;
export const MOBILE_ADD_HDR_TINT_WALL = [
  1.0592737197875977, 1.0592737197875977, 1.0592737197875977, 0.7176470756530762,
] as const;
// `ef_wall.png` is not anchored by its lower image edge. Its alpha ridge is
// at source row 198/256 (Unity UV ~= .2246), followed by the authored
// reflection towards the image bottom. On the 2.408502817-high wall mesh that
// ridge is at y ~= .534. ParticleSystemRenderer_3 serializes m_Pivot.y=-.21
// as a fraction of the rendered particle diameter; applying it as a raw
// mesh-space coordinate (the old -0.21 uniform) moved the ridge up instead of
// putting it on the judgement origin. Keep the renderer value and mesh
// diameter as their f32 values so the GPU receives Unity's diameter-scaled
// vertical anchor. X needs no visible correction because the renderer pivot
// is zero. Z already uses +0.5 in Three: the wall mesh's depth is exactly 1,
// and reflecting Unity's -0.5 pivot together with the mesh turns it into the
// existing +0.5 shader pivot. Y is the only component whose non-unit mesh
// diameter changes the serialized number.
const WALL_MESH_HEIGHT = Math.fround(2.4085028171539307);
const WALL_RENDERER_PIVOT_Y = Math.fround(-0.21);
export const WALL_MESH_SHADER_PIVOT_Y = Math.fround(-WALL_RENDERER_PIVOT_Y * WALL_MESH_HEIGHT);
const FRAME_SLICE_BORDER = [0.408, 0.4] as const;
const ZERO_COLOR: NativeColor = { r: 0, g: 0, b: 0, a: 0 };
const PARTICLE_COLOR_SCRATCH: NativeColor = { r: 0, g: 0, b: 0, a: 0 };
const PARTICLE_LIFETIME_COLOR_SCRATCH: NativeColor = { r: 0, g: 0, b: 0, a: 0 };
const SHAPE_POSITION_SCRATCH: [number, number, number] = [0, 0, 0];
const VELOCITY_POSITION_SCRATCH: [number, number, number] = [0, 0, 0];
const MOVEMENT_PREVIOUS_SCRATCH: [number, number, number] = [0, 0, 0];
const MOVEMENT_CURRENT_SCRATCH: [number, number, number] = [0, 0, 0];
const UNIT_SCALE = [1, 1, 1] as const;
const PARTICLE_SAMPLE_SCRATCH: ParticleSample = {
  x: 0,
  y: 0,
  z: 0,
  sizeX: 0,
  sizeY: 0,
  sizeZ: 0,
  color: PARTICLE_COLOR_SCRATCH,
  rotation: 0,
};

function record(value: unknown): NativeRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as NativeRecord) : undefined;
}

function array(value: unknown): ReadonlyArray<unknown> {
  return Array.isArray(value) ? value : EMPTY_VALUES;
}

function finite(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min = 0, max = 1): number {
  return Math.max(min, Math.min(max, value));
}

function lerp(a: number, b: number, progress: number): number {
  return a + (b - a) * progress;
}

function hash(value: string): number {
  let result = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 16777619);
  }
  return result >>> 0;
}

const UNITY_PARTICLE_RANDOM_MULTIPLIER = 0x6c078965;
const UNITY_PARTICLE_RANDOM_VALUE_SCALE = Math.fround(1 / 0x7fffff);

function random(seed: number): number {
  // Unity's ParticleSystem jobs seed four xorshift words from this LCG, then
  // turn the low 23 bits of the first xorshift result into a float. The
  // renderer stays stateless so a particle can be reconstructed every frame,
  // but each derived stream uses the native generator rather than a guessed
  // one-word xorshift.
  const s0 = Math.trunc(seed) >>> 0;
  const s1 = (Math.imul(s0, UNITY_PARTICLE_RANDOM_MULTIPLIER) + 1) >>> 0;
  const s2 = (Math.imul(s1, UNITY_PARTICLE_RANDOM_MULTIPLIER) + 1) >>> 0;
  const s3 = (Math.imul(s2, UNITY_PARTICLE_RANDOM_MULTIPLIER) + 1) >>> 0;
  const temporary = (s0 ^ (s0 << 11)) >>> 0;
  const next = (temporary ^ s3 ^ (temporary >>> 8) ^ (s3 >>> 19)) >>> 0;
  return Math.fround(Math.fround(next & 0x7fffff) * UNITY_PARTICLE_RANDOM_VALUE_SCALE);
}

function cubic(a: number, b: number, c: number, d: number, value: number): number {
  const inverse = 1 - value;
  return (
    inverse * inverse * inverse * a +
    3 * inverse * inverse * value * b +
    3 * inverse * value * value * c +
    value * value * value * d
  );
}

const NATIVE_CURVE_LUT_SAMPLES = 512;
const NATIVE_CURVE_LUT_RELATIVE_ERROR = 0.001;
const NATIVE_CURVE_LUT_MIN_ERROR = 0.000001;
const NATIVE_CURVE_LUT_VALIDATION_PROGRESS = [0.25, 0.5, 0.75] as const;

interface NativeCurveLookup {
  readonly exact: boolean;
  readonly start: number;
  readonly end: number;
  readonly samples?: Float32Array;
  readonly maxAbsError: number;
  readonly tolerance: number;
}

export interface NativeCurveLutStats {
  builtCurves: number;
  lutCurves: number;
  exactFallbackCurves: number;
  maximumValidatedError: number;
  maximumTolerance: number;
  samplesPerCurve: number;
}

let nativeCurveLookupCache = new WeakMap<object, NativeCurveLookup>();
const nativeCurveLutStats: NativeCurveLutStats = {
  builtCurves: 0,
  lutCurves: 0,
  exactFallbackCurves: 0,
  maximumValidatedError: 0,
  maximumTolerance: 0,
  samplesPerCurve: NATIVE_CURVE_LUT_SAMPLES,
};

function resetNativeCurveLutStats(): void {
  nativeCurveLutStats.builtCurves = 0;
  nativeCurveLutStats.lutCurves = 0;
  nativeCurveLutStats.exactFallbackCurves = 0;
  nativeCurveLutStats.maximumValidatedError = 0;
  nativeCurveLutStats.maximumTolerance = 0;
}

/** Diagnostics are snapshots so callers cannot mutate the global cache counters. */
export function getNativeCurveLutStats(): NativeCurveLutStats {
  return { ...nativeCurveLutStats };
}

/** Test/benchmark hook; production never clears the atlas-lifetime curve cache. */
export function resetNativeCurveLutCache(): void {
  nativeCurveLookupCache = new WeakMap<object, NativeCurveLookup>();
  resetNativeCurveLutStats();
}

/** Evaluates Unity's serialized AnimationCurve, including weighted tangents. */
export function evaluateNativeAnimationCurve(value: unknown, time: number): number {
  const curve = record(value);
  const keys = array(curve?.m_Curve);
  const first = record(keys[0]);
  const last = record(keys[keys.length - 1]);
  if (!first || !last) return 0;
  if (time <= finite(first.time)) return finite(first.value);
  if (time >= finite(last.time)) return finite(last.value);
  let left = first;
  let right = last;
  for (let index = 1; index < keys.length; index += 1) {
    const candidate = record(keys[index]);
    if (!candidate) continue;
    if (time <= finite(candidate.time)) {
      right = candidate;
      break;
    }
    left = candidate;
  }
  const t0 = finite(left.time);
  const t1 = finite(right.time);
  const duration = Math.max(Number.EPSILON, t1 - t0);
  const v0 = finite(left.value);
  const v1 = finite(right.value);
  const outSlope = finite(left.outSlope);
  const inSlope = finite(right.inSlope);
  if (!Number.isFinite(outSlope) || !Number.isFinite(inSlope)) return time < t1 ? v0 : v1;
  const outWeighted = (Math.round(finite(left.weightedMode)) & 2) !== 0;
  const inWeighted = (Math.round(finite(right.weightedMode)) & 1) !== 0;
  const outWeight = outWeighted ? clamp(finite(left.outWeight, 1 / 3)) : 1 / 3;
  const inWeight = inWeighted ? clamp(finite(right.inWeight, 1 / 3)) : 1 / 3;
  const x1 = t0 + duration * outWeight;
  const x2 = t1 - duration * inWeight;
  const y1 = v0 + outSlope * duration * outWeight;
  const y2 = v1 - inSlope * duration * inWeight;
  let low = 0;
  let high = 1;
  for (let iteration = 0; iteration < 18; iteration += 1) {
    const middle = (low + high) / 2;
    if (cubic(t0, x1, x2, t1, middle) < time) low = middle;
    else high = middle;
  }
  return cubic(v0, y1, y2, v1, (low + high) / 2);
}

function hasNonFiniteCurveTangents(keys: ReadonlyArray<unknown>): boolean {
  for (const rawKey of keys) {
    const key = record(rawKey);
    if (!key) continue;
    for (const name of ["inSlope", "outSlope"] as const) {
      const raw = key[name];
      if (raw !== undefined && !Number.isFinite(Number(raw))) return true;
    }
  }
  return false;
}

function buildNativeCurveLookup(curve: NativeRecord): NativeCurveLookup {
  const keys = array(curve.m_Curve);
  const first = record(keys[0]);
  const last = record(keys[keys.length - 1]);
  nativeCurveLutStats.builtCurves += 1;
  if (!first || !last || hasNonFiniteCurveTangents(keys)) {
    nativeCurveLutStats.exactFallbackCurves += 1;
    return { exact: true, start: 0, end: 0, maxAbsError: 0, tolerance: 0 };
  }
  const start = finite(first.time);
  const end = finite(last.time);
  if (!(end > start)) {
    nativeCurveLutStats.exactFallbackCurves += 1;
    return { exact: true, start, end, maxAbsError: 0, tolerance: 0 };
  }
  const samples = new Float32Array(NATIVE_CURVE_LUT_SAMPLES);
  let minimum = Number.POSITIVE_INFINITY;
  let maximum = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < samples.length; index += 1) {
    const time = start + ((end - start) * index) / (samples.length - 1);
    const sample = evaluateNativeAnimationCurve(curve, time);
    samples[index] = sample;
    minimum = Math.min(minimum, sample);
    maximum = Math.max(maximum, sample);
  }
  const tolerance = Math.max(NATIVE_CURVE_LUT_MIN_ERROR, (maximum - minimum) * NATIVE_CURVE_LUT_RELATIVE_ERROR);
  let maxAbsError = 0;
  // Validate every cell at quarter points. Curves with sharp/weighted segments that a
  // 512-sample linear LUT cannot represent within the declared tolerance use
  // the exact 18-step cubic solve instead.
  for (let index = 0; index < samples.length - 1; index += 1) {
    for (const progress of NATIVE_CURVE_LUT_VALIDATION_PROGRESS) {
      const time = start + ((end - start) * (index + progress)) / (samples.length - 1);
      const exact = evaluateNativeAnimationCurve(curve, time);
      const approximate = lerp(samples[index]!, samples[index + 1]!, progress);
      maxAbsError = Math.max(maxAbsError, Math.abs(exact - approximate));
    }
  }
  nativeCurveLutStats.maximumValidatedError = Math.max(nativeCurveLutStats.maximumValidatedError, maxAbsError);
  nativeCurveLutStats.maximumTolerance = Math.max(nativeCurveLutStats.maximumTolerance, tolerance);
  if (maxAbsError > tolerance) {
    nativeCurveLutStats.exactFallbackCurves += 1;
    return { exact: true, start, end, maxAbsError, tolerance };
  }
  nativeCurveLutStats.lutCurves += 1;
  return { exact: false, start, end, samples, maxAbsError, tolerance };
}

function nativeCurveLookup(value: unknown): NativeCurveLookup | undefined {
  const curve = record(value);
  if (!curve) return undefined;
  const cached = nativeCurveLookupCache.get(curve);
  if (cached) return cached;
  const lookup = buildNativeCurveLookup(curve);
  nativeCurveLookupCache.set(curve, lookup);
  return lookup;
}

function evaluateNativeAnimationCurveCached(value: unknown, time: number): number {
  const curve = record(value);
  if (!curve) return 0;
  const lookup = nativeCurveLookup(curve);
  const samples = lookup?.samples;
  if (!lookup || lookup.exact || !samples) return evaluateNativeAnimationCurve(curve, time);
  if (time <= lookup.start) return samples[0]!;
  if (time >= lookup.end) return samples[samples.length - 1]!;
  const position = ((time - lookup.start) / (lookup.end - lookup.start)) * (samples.length - 1);
  const left = Math.floor(position);
  const progress = position - left;
  return lerp(samples[left]!, samples[left + 1]!, progress);
}

/** Prewarm every serialized AnimationCurve in a decoded particle system. */
export function prepareNativeCurveLuts(value: unknown): void {
  const visited = new WeakSet<object>();
  const visit = (candidate: unknown): void => {
    if (candidate === null || typeof candidate !== "object") return;
    if (visited.has(candidate)) return;
    visited.add(candidate);
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item);
      return;
    }
    const object = candidate as NativeRecord;
    if (Array.isArray(object.m_Curve)) nativeCurveLookup(object);
    for (const child of Object.values(object)) visit(child);
  };
  visit(value);
}

function evaluateNativeMinMaxCurveWith(
  value: unknown,
  time: number,
  randomValue: number,
  evaluator: (curve: unknown, sampleTime: number) => number,
): number {
  const curve = record(value);
  if (!curve) return 0;
  const state = Math.round(finite(curve.minMaxState));
  const maximum = finite(curve.scalar);
  const minimum = finite(curve.minScalar);
  if (state === 0) return maximum;
  if (state === 1) return maximum * evaluator(curve.maxCurve, time);
  if (state === 2) {
    const minValue = minimum * evaluator(curve.minCurve, time);
    const maxValue = maximum * evaluator(curve.maxCurve, time);
    return lerp(minValue, maxValue, clamp(randomValue));
  }
  if (state === 3) return lerp(minimum, maximum, clamp(randomValue));
  return 0;
}

/** Evaluates Unity MinMaxCurve without substituting display defaults for missing values. */
export function evaluateNativeMinMaxCurve(value: unknown, time: number, randomValue = 0.5): number {
  return evaluateNativeMinMaxCurveWith(value, time, randomValue, evaluateNativeAnimationCurveCached);
}

/** Exact reference path retained for tests and difficult-curve fallback. */
export function evaluateNativeMinMaxCurveExact(value: unknown, time: number, randomValue = 0.5): number {
  return evaluateNativeMinMaxCurveWith(value, time, randomValue, evaluateNativeAnimationCurve);
}

function serializedColor(value: unknown, target: NativeColor = { r: 0, g: 0, b: 0, a: 0 }): NativeColor {
  const color = record(value);
  target.r = finite(color?.r);
  target.g = finite(color?.g);
  target.b = finite(color?.b);
  target.a = finite(color?.a);
  return target;
}

function gradientChannel(
  gradient: NativeRecord,
  time: number,
  component: "r" | "g" | "b" | "a",
  alphaTiming: boolean,
): number {
  const count = Math.max(
    0,
    Math.min(8, Math.round(finite(gradient[alphaTiming ? "m_NumAlphaKeys" : "m_NumColorKeys"]))),
  );
  if (count === 0) return 1;
  let leftIndex = 0;
  let leftTime = finite(gradient[`${alphaTiming ? "atime" : "ctime"}0`]) / 65535;
  let leftColor = record(gradient.key0);
  if (time <= leftTime) return finite(leftColor?.[component], 1);
  for (let index = 1; index < count; index += 1) {
    const rightTime = finite(gradient[`${alphaTiming ? "atime" : "ctime"}${index}`]) / 65535;
    const rightColor = record(gradient[`key${index}`]);
    if (time <= rightTime) {
      const progress =
        finite(gradient.m_Mode) === 1 ? 0 : (time - leftTime) / Math.max(Number.EPSILON, rightTime - leftTime);
      return lerp(finite(leftColor?.[component], 1), finite(rightColor?.[component], 1), progress);
    }
    leftIndex = index;
    leftTime = rightTime;
    leftColor = rightColor;
  }
  return finite(record(gradient[`key${leftIndex}`])?.[component], 1);
}

function evaluateGradient(value: unknown, time: number, target: NativeColor): NativeColor {
  const gradient = record(value);
  if (!gradient) {
    target.r = 1;
    target.g = 1;
    target.b = 1;
    target.a = 1;
    return target;
  }
  const progress = clamp(time);
  target.r = gradientChannel(gradient, progress, "r", false);
  target.g = gradientChannel(gradient, progress, "g", false);
  target.b = gradientChannel(gradient, progress, "b", false);
  target.a = gradientChannel(gradient, progress, "a", true);
  return target;
}

const GRADIENT_SCRATCH: NativeColor = { r: 0, g: 0, b: 0, a: 0 };

/** Evaluates Unity MinMaxGradient using one stable per-particle random value. */
export function evaluateNativeMinMaxGradient(
  value: unknown,
  time: number,
  randomValue = 0.5,
  target: NativeColor = { r: 0, g: 0, b: 0, a: 0 },
): NativeColor {
  const gradient = record(value);
  if (!gradient) {
    target.r = 1;
    target.g = 1;
    target.b = 1;
    target.a = 1;
    return target;
  }
  const state = Math.round(finite(gradient.minMaxState));
  if (state === 0) return serializedColor(gradient.maxColor, target);
  if (state === 1 || state === 4)
    return evaluateGradient(gradient.maxGradient, state === 4 ? randomValue : time, target);
  if (state === 2) {
    serializedColor(gradient.minColor, target);
    serializedColor(gradient.maxColor, GRADIENT_SCRATCH);
    target.r = lerp(target.r, GRADIENT_SCRATCH.r, randomValue);
    target.g = lerp(target.g, GRADIENT_SCRATCH.g, randomValue);
    target.b = lerp(target.b, GRADIENT_SCRATCH.b, randomValue);
    target.a = lerp(target.a, GRADIENT_SCRATCH.a, randomValue);
    return target;
  }
  if (state === 3) {
    evaluateGradient(gradient.minGradient, time, target);
    evaluateGradient(gradient.maxGradient, time, GRADIENT_SCRATCH);
    target.r = lerp(target.r, GRADIENT_SCRATCH.r, randomValue);
    target.g = lerp(target.g, GRADIENT_SCRATCH.g, randomValue);
    target.b = lerp(target.b, GRADIENT_SCRATCH.b, randomValue);
    target.a = lerp(target.a, GRADIENT_SCRATCH.a, randomValue);
    return target;
  }
  return serializedColor(ZERO_COLOR, target);
}

export function readNativeParticleSystem(value: unknown): NativeParticleSystemData | undefined {
  const root = record(value);
  if (root?.type !== "ParticleSystem") return undefined;
  const data = record(root.data);
  const initial = record(data?.InitialModule);
  if (!data || !initial || initial.enabled !== true) return undefined;
  // Loading is the one-time point at which paying LUT construction and
  // validation cannot disturb a dense effect frame.
  prepareNativeCurveLuts(data);
  return {
    raw: data,
    length: Math.max(0, finite(data.lengthInSec)),
    simulationSpeed: Math.max(Number.EPSILON, finite(data.simulationSpeed, 1)),
    looping: data.looping === true,
    maxParticles: Math.max(0, Math.round(finite(initial.maxNumParticles, 1000))),
    // UnityEngine.ParticleSystemSimulationSpace is Local=0, World=1,
    // Custom=2. The Unity asset serializer stores that enum under the legacy
    // field name `moveWithTransform`.
    simulationSpace: Math.max(0, Math.min(2, Math.round(finite(data.moveWithTransform)))) as 0 | 1 | 2,
    scalingMode: Math.round(finite(data.scalingMode, 1)),
  };
}

function bitsToFloat(value: number): number {
  const buffer = new ArrayBuffer(4);
  const view = new DataView(buffer);
  view.setUint32(0, value >>> 0, true);
  return view.getFloat32(0, true);
}

function bindingComponentCount(binding: NativeRecord): number {
  const typeId = Math.round(finite(binding.typeID));
  const attribute = Math.round(finite(binding.attribute));
  if (typeId === 4 && attribute === ATTRIBUTE_TRANSFORM_POSITION) return 3;
  return 1;
}

export function readNativeAnimationClip(value: unknown): NativeAnimationClip | undefined {
  const root = record(value);
  if (root?.type !== "AnimationClip") return undefined;
  const data = record(root.data);
  const muscle = record(data?.m_MuscleClip);
  const clip = record(muscle?.m_Clip);
  const clipData = record(clip?.data);
  const streamed = record(clipData?.m_StreamedClip);
  const words = array(streamed?.data).map((word) => Math.round(finite(word)) >>> 0);
  const curveCount = Math.max(0, Math.round(finite(streamed?.curveCount)));
  const constant = record(clipData?.m_ConstantClip);
  const constantValues = array(constant?.data).map((entry) => finite(entry));
  if (words.length === 0 && constantValues.length === 0) return undefined;
  const frames: NativeClipFrame[] = [];
  let cursor = 0;
  while (cursor + 2 <= words.length) {
    const time = bitsToFloat(words[cursor++]!);
    const keyCount = words[cursor++]!;
    if (keyCount > curveCount || cursor + keyCount * 5 > words.length) break;
    const coefficients = new Map<number, readonly [number, number, number, number]>();
    for (let index = 0; index < keyCount; index += 1) {
      const curveIndex = words[cursor++]!;
      const a = bitsToFloat(words[cursor++]!);
      const b = bitsToFloat(words[cursor++]!);
      const c = bitsToFloat(words[cursor++]!);
      const d = bitsToFloat(words[cursor++]!);
      coefficients.set(curveIndex, [a, b, c, d]);
    }
    frames.push({ time, coefficients });
  }
  const bindings: NativeClipBinding[] = [];
  let curveStart = 0;
  const totalCurveCount = curveCount + constantValues.length;
  const bindingRoot = record(data?.m_ClipBindingConstant);
  for (const rawBinding of array(bindingRoot?.genericBindings)) {
    const binding = record(rawBinding);
    if (!binding) continue;
    const componentCount = bindingComponentCount(binding);
    if (curveStart >= totalCurveCount) break;
    bindings.push({
      path: Math.round(finite(binding.path)) >>> 0,
      attribute: Math.round(finite(binding.attribute)) >>> 0,
      curveStart,
      componentCount: Math.min(componentCount, totalCurveCount - curveStart),
    });
    curveStart += componentCount;
  }
  const bindingLookup = new Map<number, Map<number, NativeClipBinding>>();
  for (const binding of bindings) {
    let attributes = bindingLookup.get(binding.path);
    if (!attributes) {
      attributes = new Map();
      bindingLookup.set(binding.path, attributes);
    }
    attributes.set(binding.attribute, binding);
  }
  return {
    duration: Math.max(
      0,
      finite(muscle?.m_StopTime, frames.filter((frame) => Number.isFinite(frame.time)).at(-1)?.time ?? 0),
    ),
    streamedCurveCount: curveCount,
    constantValues,
    frames,
    bindings,
    bindingLookup,
  };
}

function clipCurveValue(clip: NativeAnimationClip | undefined, curveIndex: number, time: number): number | undefined {
  if (!clip) return undefined;
  if (curveIndex >= clip.streamedCurveCount) return clip.constantValues[curveIndex - clip.streamedCurveCount];
  let frame: NativeClipFrame | undefined;
  for (const candidate of clip.frames) {
    if (candidate.time > time) break;
    if (candidate.coefficients.has(curveIndex)) frame = candidate;
  }
  const coefficients = frame?.coefficients.get(curveIndex);
  if (!frame || !coefficients) return undefined;
  const delta = time - frame.time;
  return ((coefficients[0] * delta + coefficients[1]) * delta + coefficients[2]) * delta + coefficients[3];
}

function clipBindingValue(
  clip: NativeAnimationClip | undefined,
  path: number,
  attribute: number,
  time: number,
  component = 0,
): number | undefined {
  const binding = clip?.bindingLookup.get(path)?.get(attribute);
  if (!binding || component >= binding.componentCount) return undefined;
  return clipCurveValue(clip, binding.curveStart + component, time);
}

export function nativeAnimationClipPosition(
  clip: NativeAnimationClip | undefined,
  path: number,
  time: number,
  target: [number, number, number],
): void {
  target[0] = clipBindingValue(clip, path, ATTRIBUTE_TRANSFORM_POSITION, time, 0) ?? 0;
  target[1] = clipBindingValue(clip, path, ATTRIBUTE_TRANSFORM_POSITION, time, 1) ?? 0;
  target[2] = clipBindingValue(clip, path, ATTRIBUTE_TRANSFORM_POSITION, time, 2) ?? 0;
}

function animationPathHierarchy(path: string): number[] {
  const parts = path.split("/").filter(Boolean);
  return parts.map((_, index) => unityStringHash(parts.slice(0, index + 1).join("/")));
}

function particleSystemActiveAt(clip: NativeAnimationClip, paths: ReadonlyArray<number>, time: number): boolean {
  return paths.every((path) => {
    const active = clipBindingValue(clip, path, ATTRIBUTE_ACTIVE, time);
    return active === undefined || active >= 0.5;
  });
}

/**
 * Mirrors Animator-driven GameObject lifetime for a ParticleSystem. This is
 * evaluated before emission: merely hiding an initially inactive system would
 * preserve particles that have not started in the native prefab yet.
 */
function particleSystemPlayback(
  system: LoadedParticleSystem,
  manifest: Effect001PrefabAssetRef,
  animation: NativeAnimationClip | undefined,
  effectAge: number,
): ParticlePlayback | undefined {
  const path = system.ref.animationPath;
  if (!path || !animation || animation.duration <= 0) return { age: effectAge, animationTimeOffset: 0 };
  let cycleStart = 0;
  let animationTime = Math.max(0, effectAge);
  if (manifest.loopAnimation) {
    cycleStart = Math.floor(animationTime / animation.duration) * animation.duration;
    animationTime -= cycleStart;
  } else {
    animationTime = Math.min(animationTime, animation.duration);
  }
  const paths = animationPathHierarchy(path);
  if (!particleSystemActiveAt(animation, paths, animationTime)) return undefined;

  let active = particleSystemActiveAt(animation, paths, 0);
  let activeStart = active ? 0 : undefined;
  for (const frame of animation.frames) {
    if (frame.time <= 0 || frame.time > animationTime) continue;
    const nextActive = particleSystemActiveAt(animation, paths, frame.time);
    if (!active && nextActive) activeStart = frame.time;
    active = nextActive;
  }
  if (activeStart === undefined) return undefined;
  return { age: Math.max(0, animationTime - activeStart), animationTimeOffset: cycleStart + activeStart };
}

function animationPlaybackTime(
  manifest: Effect001PrefabAssetRef,
  animation: NativeAnimationClip | undefined,
  absoluteTime: number,
): number {
  if (!animation || animation.duration <= 0) return 0;
  const time = Math.max(0, absoluteTime);
  return manifest.loopAnimation ? time % animation.duration : Math.min(time, animation.duration);
}

function particleSystemSimulationSpeedAt(
  system: LoadedParticleSystem,
  manifest: Effect001PrefabAssetRef,
  animation: NativeAnimationClip | undefined,
  absoluteAnimationTime: number,
): number {
  const animated = system.ref.animationPath
    ? clipBindingValue(
        animation,
        unityStringHash(system.ref.animationPath),
        ATTRIBUTE_PARTICLE_SIMULATION_SPEED,
        animationPlaybackTime(manifest, animation, absoluteAnimationTime),
      )
    : undefined;
  return Math.max(Number.EPSILON, animated ?? system.simulationSpeed);
}

function particleSimulationClock(
  system: LoadedParticleSystem,
  manifest: Effect001PrefabAssetRef,
  animation: NativeAnimationClip | undefined,
  animationTimeOffset: number,
  seed: number,
  age: number,
): ParticleSimulationClock {
  const delay = evaluateNativeMinMaxCurve(system.raw.startDelay, 0, random(seed + 1));
  const timeAt = (realTime: number): number => {
    const duration = Math.max(0, realTime);
    let simulated = 0;
    for (let start = 0; start < duration; start += EMISSION_STEP) {
      const step = Math.min(EMISSION_STEP, duration - start);
      simulated +=
        particleSystemSimulationSpeedAt(system, manifest, animation, animationTimeOffset + start + step / 2) * step;
    }
    return Math.max(0, simulated - delay);
  };
  return { current: timeAt(age), timeAt };
}

function transparentTexture(): DataTexture {
  const texture = new DataTexture(new Uint8Array([255, 255, 255, 0]), 1, 1, RGBAFormat, UnsignedByteType);
  texture.needsUpdate = true;
  return texture;
}

function configure(texture: Texture): Texture {
  // PlayerSettings.m_ActiveColorSpace is Gamma. The effect shader samples
  // authored texels directly; an sRGB decode here changes both HDR thresholding
  // and the apparent particle colors.
  texture.colorSpace = NoColorSpace;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.wrapS = ClampToEdgeWrapping;
  texture.wrapT = ClampToEdgeWrapping;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

class ParticleQuadBatch {
  readonly geometry: InstancedBufferGeometry;
  readonly material: ShaderMaterial;
  readonly mesh: Mesh<InstancedBufferGeometry, ShaderMaterial>;

  private readonly center: InstancedBufferAttribute;
  private readonly size: InstancedBufferAttribute;
  private readonly color: InstancedBufferAttribute;
  private readonly rotation: InstancedBufferAttribute;
  private readonly pivot: InstancedBufferAttribute;
  private readonly maxParticleSize: InstancedBufferAttribute;
  private readonly capacity: number;
  private cursor = 0;

  constructor(name: string, capacity: number, texture: Texture, tint: readonly [number, number, number, number]) {
    this.capacity = capacity;
    this.geometry = new InstancedBufferGeometry();
    this.geometry.setAttribute(
      "position",
      new BufferAttribute(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]), 3),
    );
    this.geometry.setAttribute("uv", new BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
    this.geometry.setIndex([0, 1, 2, 0, 2, 3]);
    this.center = new InstancedBufferAttribute(new Float32Array(capacity * 3), 3).setUsage(DynamicDrawUsage);
    this.size = new InstancedBufferAttribute(new Float32Array(capacity * 2), 2).setUsage(DynamicDrawUsage);
    this.color = new InstancedBufferAttribute(new Float32Array(capacity * 4), 4).setUsage(DynamicDrawUsage);
    this.rotation = new InstancedBufferAttribute(new Float32Array(capacity), 1).setUsage(DynamicDrawUsage);
    this.pivot = new InstancedBufferAttribute(new Float32Array(capacity * 2), 2).setUsage(DynamicDrawUsage);
    this.maxParticleSize = new InstancedBufferAttribute(new Float32Array(capacity), 1).setUsage(DynamicDrawUsage);
    this.geometry.setAttribute("aCenter", this.center);
    this.geometry.setAttribute("aSize", this.size);
    this.geometry.setAttribute("aColor", this.color);
    this.geometry.setAttribute("aRotation", this.rotation);
    this.geometry.setAttribute("aPivot", this.pivot);
    this.geometry.setAttribute("aMaxParticleSize", this.maxParticleSize);
    this.geometry.instanceCount = 0;
    this.material = new ShaderMaterial({
      uniforms: {
        uMap: { value: texture },
        uTintColor: { value: new Vector4(...tint) },
      },
      vertexShader: `
        attribute vec3 aCenter;
        attribute vec2 aSize;
        attribute vec4 aColor;
        attribute float aRotation;
        attribute vec2 aPivot;
        attribute float aMaxParticleSize;
        uniform vec4 uTintColor;
        varying vec2 vUv;
        varying vec4 vColor;
        vec2 projectNdc(vec3 worldPosition) {
          vec4 clip = projectionMatrix * viewMatrix * vec4(worldPosition, 1.0);
          return clip.xy / max(abs(clip.w), 0.000001);
        }
        void main() {
          float cosine = cos(aRotation);
          float sine = sin(aRotation);
          // ParticleSystemRenderer.pivot is expressed in particle-diameter
          // units. Unity builds the quad/mesh from (vertex - pivot).
          vec2 offset = (position.xy - aPivot) * aSize;
          offset = mat2(cosine, -sine, sine, cosine) * offset;
          vUv = uv;
          // Compiled Custom/Mobile/MobileAddHdrColor GLES3 vertex program:
          //     vs_COLOR0 = in_COLOR0 * _TintColor
          vColor = aColor * uTintColor;
          // Every visible effect001 billboard ParticleSystemRenderer uses
          // RenderMode=VerticalBillboard. It stays upright in world Y while
          // its horizontal axis turns toward the live camera.
          vec4 worldCenter = modelMatrix * vec4(aCenter, 1.0);
          vec3 toCamera = cameraPosition - worldCenter.xyz;
          vec2 horizontal = toCamera.xz;
          float horizontalLength = max(length(horizontal), 0.000001);
          vec3 right = vec3(horizontal.y, 0.0, -horizontal.x) / horizontalLength;
          vec3 up = vec3(0.0, 1.0, 0.0);
          // ParticleSystemRenderer.m_MaxParticleSize is a viewport-height
          // fraction. Project all four authored corners, then apply one
          // common scale to X/Y so asymmetric sprites retain their aspect.
          vec2 corner00 = (vec2(-0.5, -0.5) - aPivot) * aSize;
          vec2 corner10 = (vec2(0.5, -0.5) - aPivot) * aSize;
          vec2 corner11 = (vec2(0.5, 0.5) - aPivot) * aSize;
          vec2 corner01 = (vec2(-0.5, 0.5) - aPivot) * aSize;
          corner00 = mat2(cosine, -sine, sine, cosine) * corner00;
          corner10 = mat2(cosine, -sine, sine, cosine) * corner10;
          corner11 = mat2(cosine, -sine, sine, cosine) * corner11;
          corner01 = mat2(cosine, -sine, sine, cosine) * corner01;
          vec2 ndc00 = projectNdc(worldCenter.xyz + right * corner00.x + up * corner00.y);
          vec2 ndc10 = projectNdc(worldCenter.xyz + right * corner10.x + up * corner10.y);
          vec2 ndc11 = projectNdc(worldCenter.xyz + right * corner11.x + up * corner11.y);
          vec2 ndc01 = projectNdc(worldCenter.xyz + right * corner01.x + up * corner01.y);
          float minNdcX = min(min(ndc00.x, ndc10.x), min(ndc11.x, ndc01.x));
          float maxNdcX = max(max(ndc00.x, ndc10.x), max(ndc11.x, ndc01.x));
          float minNdcY = min(min(ndc00.y, ndc10.y), min(ndc11.y, ndc01.y));
          float maxNdcY = max(max(ndc00.y, ndc10.y), max(ndc11.y, ndc01.y));
          float viewportAspect = abs(projectionMatrix[1][1] / projectionMatrix[0][0]);
          float screenExtent = max((maxNdcX - minNdcX) * 0.5 * viewportAspect, (maxNdcY - minNdcY) * 0.5);
          float particleScale = aMaxParticleSize > 0.0
            ? min(1.0, aMaxParticleSize / max(screenExtent, 0.000001))
            : 1.0;
          vec3 worldPosition = worldCenter.xyz + right * offset.x * particleScale + up * offset.y * particleScale;
          gl_Position = projectionMatrix * viewMatrix * vec4(worldPosition, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D uMap;
        uniform vec4 uTintColor;
        varying vec2 vUv;
        varying vec4 vColor;
        float roundEvenPositive(float value) {
          float lower = floor(value);
          float fraction = value - lower;
          if (fraction < 0.5) return lower;
          if (fraction > 0.5) return lower + 1.0;
          return mod(lower, 2.0) == 0.0 ? lower : lower + 1.0;
        }
        void main() {
          vec4 texel = texture2D(uMap, vUv);
          // Compiled fragment program quantizes vertex alpha to Color32,
          // doubles all channels, then applies _TintColor a second time.
          vec4 hdrColor;
          hdrColor.rgb = vColor.rgb * 2.0;
          hdrColor.a = roundEvenPositive(clamp(vColor.a, 0.0, 1.0) * 255.0) * (2.0 / 255.0);
          hdrColor *= uTintColor;
          float alpha = texel.a * hdrColor.a;
          gl_FragColor = vec4(texel.rgb * hdrColor.rgb, alpha);
        }
      `,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      // Shader state rtBlend0: srcBlend=5 (SrcAlpha), destBlend=1
      // (One), Add; rtSeparateBlend=false uses the same factors for alpha.
      blending: CustomBlending,
      blendEquation: AddEquation,
      blendSrc: SrcAlphaFactor,
      blendDst: OneFactor,
      blendEquationAlpha: AddEquation,
      blendSrcAlpha: SrcAlphaFactor,
      blendDstAlpha: OneFactor,
      side: DoubleSide,
      toneMapped: false,
    });
    // Every particle is a flat billboard. A single unculled DoubleSide pass
    // has identical coverage and avoids Three's transparent back/front draws.
    this.material.forceSinglePass = true;
    this.mesh = new Mesh(this.geometry, this.material);
    this.mesh.name = `Effect001Particles:${name}`;
    this.mesh.visible = false;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 6002;
  }

  reset(): void {
    this.cursor = 0;
  }

  push(
    x: number,
    y: number,
    z: number,
    sizeX: number,
    sizeY: number,
    color: NativeColor,
    rotation: number,
    maxParticleSize = 1,
    pivotX = 0,
    pivotY = 0,
  ): boolean {
    if (this.cursor >= this.capacity) return false;
    this.center.setXYZ(this.cursor, x, y, z);
    this.size.setXY(this.cursor, sizeX, sizeY);
    this.color.setXYZW(this.cursor, color.r, color.g, color.b, color.a);
    this.rotation.setX(this.cursor, rotation);
    this.maxParticleSize.setX(this.cursor, maxParticleSize);
    this.pivot.setXY(this.cursor, pivotX, pivotY);
    this.cursor += 1;
    return true;
  }

  finish(): void {
    this.geometry.instanceCount = this.cursor;
    this.mesh.visible = this.cursor > 0;
    if (this.cursor === 0) return;
    this.center.clearUpdateRanges();
    this.size.clearUpdateRanges();
    this.color.clearUpdateRanges();
    this.rotation.clearUpdateRanges();
    this.pivot.clearUpdateRanges();
    this.maxParticleSize.clearUpdateRanges();
    this.center.addUpdateRange(0, this.cursor * 3);
    this.size.addUpdateRange(0, this.cursor * 2);
    this.color.addUpdateRange(0, this.cursor * 4);
    this.rotation.addUpdateRange(0, this.cursor);
    this.pivot.addUpdateRange(0, this.cursor * 2);
    this.maxParticleSize.addUpdateRange(0, this.cursor);
    this.center.needsUpdate = true;
    this.size.needsUpdate = true;
    this.color.needsUpdate = true;
    this.rotation.needsUpdate = true;
    this.pivot.needsUpdate = true;
    this.maxParticleSize.needsUpdate = true;
  }

  setTexture(texture: Texture): void {
    this.material.uniforms.uMap.value = texture;
  }

  get count(): number {
    return this.cursor;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}

/** Instanced native SpriteRenderer/wall-mesh batch; one draw call per source texture. */
class EffectMeshBatch {
  readonly geometry: InstancedBufferGeometry;
  readonly material: ShaderMaterial;
  readonly mesh: Mesh<InstancedBufferGeometry, ShaderMaterial>;

  private readonly center: InstancedBufferAttribute;
  private readonly scale: InstancedBufferAttribute;
  private readonly color: InstancedBufferAttribute;
  private readonly rotationX: InstancedBufferAttribute;
  private readonly capacity: number;
  private cursor = 0;

  constructor(
    name: string,
    source: BufferGeometry,
    capacity: number,
    texture: Texture,
    tint: readonly [number, number, number, number],
    sliceBorder?: readonly [number, number],
    meshPivot: readonly [number, number, number] = [0, 0, 0],
    blendDestination: typeof OneFactor | typeof OneMinusSrcAlphaFactor = OneFactor,
    blendSourceAlpha: typeof SrcAlphaFactor | typeof OneFactor = SrcAlphaFactor,
    shaderMode: EffectMeshShaderMode = "mobileAddHdr",
  ) {
    this.capacity = capacity;
    this.geometry = new InstancedBufferGeometry();
    const position = source.getAttribute("position");
    const uv = source.getAttribute("uv");
    this.geometry.setAttribute("position", position.clone());
    if (uv) this.geometry.setAttribute("uv", uv.clone());
    if (source.index) this.geometry.setIndex(source.index.clone());
    this.center = new InstancedBufferAttribute(new Float32Array(capacity * 3), 3).setUsage(DynamicDrawUsage);
    this.scale = new InstancedBufferAttribute(new Float32Array(capacity * 3), 3).setUsage(DynamicDrawUsage);
    this.color = new InstancedBufferAttribute(new Float32Array(capacity * 4), 4).setUsage(DynamicDrawUsage);
    this.rotationX = new InstancedBufferAttribute(new Float32Array(capacity), 1).setUsage(DynamicDrawUsage);
    this.geometry.setAttribute("aCenter", this.center);
    this.geometry.setAttribute("aScale", this.scale);
    this.geometry.setAttribute("aColor", this.color);
    this.geometry.setAttribute("aRotationX", this.rotationX);
    this.geometry.instanceCount = 0;
    this.material = new ShaderMaterial({
      uniforms: {
        uMap: { value: texture },
        uTintColor: { value: new Vector4(...tint) },
        uSliceBorder: { value: new Vector2(...(sliceBorder ?? [0, 0])) },
        uSliced: { value: sliceBorder ? 1 : 0 },
        uMeshPivot: { value: new Vector3(...meshPivot) },
      },
      vertexShader: `
        attribute vec3 aCenter;
        attribute vec3 aScale;
        attribute vec4 aColor;
        attribute float aRotationX;
        uniform vec4 uTintColor;
        uniform vec2 uSliceBorder;
        uniform float uSliced;
        uniform vec3 uMeshPivot;
        varying vec2 vUv;
        varying vec4 vColor;
        void main() {
          vec3 offset = (position - uMeshPivot) * aScale;
          if (uSliced > 0.5) {
            // position.xy stores one of four signed slice tags. Unity's
            // SpriteDrawMode.Sliced keeps the 40px/100PPU borders at a fixed
            // world width while SetWidth stretches only the center region.
            offset.x = position.x < -1.0
              ? -aScale.x * 0.5
              : position.x < 0.0
                ? -aScale.x * 0.5 + uSliceBorder.x
                : position.x < 1.0
                  ? aScale.x * 0.5 - uSliceBorder.x
                  : aScale.x * 0.5;
            offset.y = position.y < -1.0
              ? -aScale.y * 0.5
              : position.y < 0.0
                ? -aScale.y * 0.5 + uSliceBorder.y
                : position.y < 1.0
                  ? aScale.y * 0.5 - uSliceBorder.y
                  : aScale.y * 0.5;
          }
          float cosine = cos(aRotationX);
          float sine = sin(aRotationX);
          offset.yz = mat2(cosine, sine, -sine, cosine) * offset.yz;
          vUv = uv;
          vColor = aColor * uTintColor;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(aCenter + offset, 1.0);
        }
      `,
      fragmentShader:
        shaderMode === "uiAdditive"
          ? `
            uniform sampler2D uMap;
            varying vec2 vUv;
            varying vec4 vColor;
            void main() {
              vec4 color = texture2D(uMap, vUv) * vColor;
              // Compiled UI/Additive GLES3 program premultiplies RGB, then
              // the fixed One/One blend state adds it to the framebuffer.
              gl_FragColor = vec4(color.rgb * color.a, color.a);
            }
          `
          : `
            uniform sampler2D uMap;
            uniform vec4 uTintColor;
            varying vec2 vUv;
            varying vec4 vColor;
            float roundEvenPositive(float value) {
              float lower = floor(value);
              float fraction = value - lower;
              if (fraction < 0.5) return lower;
              if (fraction > 0.5) return lower + 1.0;
              return mod(lower, 2.0) == 0.0 ? lower : lower + 1.0;
            }
            void main() {
              vec4 texel = texture2D(uMap, vUv);
              vec4 hdrColor;
              hdrColor.rgb = vColor.rgb * 2.0;
              hdrColor.a = roundEvenPositive(clamp(vColor.a, 0.0, 1.0) * 255.0) * (2.0 / 255.0);
              hdrColor *= uTintColor;
              float alpha = texel.a * hdrColor.a;
              gl_FragColor = vec4(texel.rgb * hdrColor.rgb, alpha);
            }
          `,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: CustomBlending,
      blendEquation: AddEquation,
      blendSrc: shaderMode === "uiAdditive" ? OneFactor : SrcAlphaFactor,
      blendDst: blendDestination,
      blendEquationAlpha: AddEquation,
      blendSrcAlpha: blendSourceAlpha,
      blendDstAlpha: blendDestination,
      side: DoubleSide,
      toneMapped: false,
    });
    // These additive sprite/wall triangles do not need the transparent
    // DoubleSide two-pass ordering used for closed alpha-blended surfaces.
    this.material.forceSinglePass = true;
    this.mesh = new Mesh(this.geometry, this.material);
    this.mesh.name = `Effect001Mesh:${name}`;
    this.mesh.visible = false;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 6001;
  }

  reset(): void {
    this.cursor = 0;
  }

  push(
    x: number,
    y: number,
    z: number,
    scaleX: number,
    scaleY: number,
    scaleZ: number,
    red: number,
    green: number,
    blue: number,
    alpha: number,
    rotationX = 0,
  ): boolean {
    if (this.cursor >= this.capacity) return false;
    this.center.setXYZ(this.cursor, x, y, z);
    this.scale.setXYZ(this.cursor, scaleX, scaleY, scaleZ);
    this.color.setXYZW(this.cursor, red, green, blue, alpha);
    this.rotationX.setX(this.cursor, rotationX);
    this.cursor += 1;
    return true;
  }

  finish(): void {
    this.geometry.instanceCount = this.cursor;
    this.mesh.visible = this.cursor > 0;
    if (this.cursor === 0) return;
    this.center.clearUpdateRanges();
    this.scale.clearUpdateRanges();
    this.color.clearUpdateRanges();
    this.rotationX.clearUpdateRanges();
    this.center.addUpdateRange(0, this.cursor * 3);
    this.scale.addUpdateRange(0, this.cursor * 3);
    this.color.addUpdateRange(0, this.cursor * 4);
    this.rotationX.addUpdateRange(0, this.cursor);
    this.center.needsUpdate = true;
    this.scale.needsUpdate = true;
    this.color.needsUpdate = true;
    this.rotationX.needsUpdate = true;
  }

  setTexture(texture: Texture): void {
    this.material.uniforms.uMap.value = texture;
  }

  get count(): number {
    return this.cursor;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}

function createSlicedSpriteGeometry(): BufferGeometry {
  // ef_tap_line Sprite: full 128x128 rect with 40px borders on every side.
  // Position components are slice tags interpreted by EffectMeshBatch so the
  // borders remain 0.4 world units instead of stretching with note width.
  const tags = [-1.5, -0.5, 0.5, 1.5] as const;
  const uv = [0, 40 / 128, 88 / 128, 1] as const;
  const positions: number[] = [];
  const uvs: number[] = [];
  for (let y = 0; y < 4; y += 1) {
    for (let x = 0; x < 4; x += 1) {
      positions.push(tags[x]!, tags[y]!, 0);
      uvs.push(uv[x]!, uv[y]!);
    }
  }
  const indices: number[] = [];
  for (let y = 0; y < 3; y += 1) {
    for (let x = 0; x < 3; x += 1) {
      const lowerLeft = y * 4 + x;
      const lowerRight = lowerLeft + 1;
      const upperLeft = lowerLeft + 4;
      const upperRight = upperLeft + 1;
      indices.push(lowerLeft, lowerRight, upperRight, lowerLeft, upperRight, upperLeft);
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute("uv", new BufferAttribute(new Float32Array(uvs), 2));
  geometry.setIndex(indices);
  return geometry;
}

function createWallGeometry(): BufferGeometry {
  const positions = [
    -0.966932595, 0, -0.00000006, -0.966932595, 2.408502817, 0.000000014, -0.983466268, 2.408502817, -0.00443018,
    -0.983466268, 0, -0.004430255, -0.995569766, 2.408502817, -0.016533695, -0.995569766, -0.000000001, -0.01653377, -1,
    2.408502817, -0.033067405, -1, -0.000000001, -0.03306748, 1, -0.000000001, -0.03306748, 1, 2.408502817,
    -0.033067405, 0.995569766, 2.408502817, -0.016533695, 0.995569766, -0.000000001, -0.01653377, 0.983466268,
    2.408502817, -0.00443018, 0.983466268, 0, -0.004430255, 0.966932595, 2.408502817, 0.000000014, 0.966932595, 0,
    -0.00000006, -1, -0.000000044, -1, -1, -0.000000001, -0.03306748, -1, 2.408502817, -0.033067405, -1, 2.408502817,
    -1, -0.966932595, 0, -0.00000006, 0.966932595, 0, -0.00000006, 0.966932595, 2.408502817, 0.000000014, -0.966932595,
    2.408502817, 0.000000014, 1, -0.000000001, -0.03306748, 1, -0.000000044, -1, 1, 2.408502817, -1, 1, 2.408502817,
    -0.033067405,
  ];
  const uvs = [
    0.2742908, 0.003899515, 0.2742908, 0.999999642, 0.257075697, 0.999999642, 0.257075697, 0.003899515, 0.241160661,
    0.999999642, 0.241160661, 0.003899515, 0.224267989, 1, 0.224267989, 0.003899902, 0.770728827, 0.003899515,
    0.770728827, 0.999999642, 0.756421268, 0.999999642, 0.756421268, 0.003899515, 0.74077493, 0.999999642, 0.74077493,
    0.003899515, 0.725790977, 0.999999642, 0.725790977, 0.003899515, 0, 0.003899515, 0.224267989, 0.003899902,
    0.224267989, 1, 0, 1, 0.2742908, 0.003899515, 0.725790977, 0.003899515, 0.725790977, 0.999999642, 0.2742908,
    0.999999642, 0.770728827, 0.003899515, 1, 0.003899515, 1, 1, 0.770728827, 0.999999642,
  ];
  // effect.bundle vertices are Unity world-local coordinates. Reflect every
  // authored Z component together with the rest of the scene.
  for (let index = 2; index < positions.length; index += 3) positions[index] = -positions[index]!;
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute("uv", new BufferAttribute(new Float32Array(uvs), 2));
  geometry.setIndex([
    0, 1, 2, 0, 2, 3, 3, 2, 4, 3, 4, 5, 5, 4, 6, 5, 6, 7, 8, 9, 10, 8, 10, 11, 11, 10, 12, 11, 12, 13, 13, 12, 14, 13,
    14, 15, 16, 17, 18, 16, 18, 19, 20, 21, 22, 20, 22, 23, 24, 25, 26, 24, 26, 27,
  ]);
  return geometry;
}

function shapePosition(
  system: LoadedParticleSystem,
  seed: number,
  nativeWidth: number,
  target: [number, number, number],
): void {
  const shape = record(system.raw.ShapeModule);
  if (!shape || shape.enabled !== true) {
    target[0] = 0;
    target[1] = 0;
    target[2] = 0;
    return;
  }
  const scale = record(shape.m_Scale);
  const width =
    system.ref.shapeWidthOffset === undefined
      ? finite(scale?.x)
      : Math.max(0, nativeWidth + system.ref.shapeWidthOffset);
  const height = finite(scale?.y);
  const depth = finite(scale?.z);
  const type = Math.round(finite(shape.type));
  let x: number;
  let y: number;
  let z: number;
  if (type === 16) {
    const perimeter = random(seed + 3) * Math.max(Number.EPSILON, 2 * (width + height));
    if (perimeter < width) {
      x = -width / 2 + perimeter;
      y = -height / 2;
    } else if (perimeter < width + height) {
      x = width / 2;
      y = -height / 2 + perimeter - width;
    } else if (perimeter < 2 * width + height) {
      x = width / 2 - (perimeter - width - height);
      y = height / 2;
    } else {
      x = -width / 2;
      y = height / 2 - (perimeter - 2 * width - height);
    }
    z = 0;
  } else {
    x = (random(seed + 3) - 0.5) * width;
    y = (random(seed + 5) - 0.5) * height;
    z = (random(seed + 7) - 0.5) * depth;
  }
  const offset = record(shape.m_Position);
  const rotation = record(shape.m_Rotation);
  const rx = (finite(rotation?.x) * Math.PI) / 180;
  const ry = (finite(rotation?.y) * Math.PI) / 180;
  const rz = (finite(rotation?.z) * Math.PI) / 180;
  const rotatedY = y * Math.cos(rx) - z * Math.sin(rx);
  z = y * Math.sin(rx) + z * Math.cos(rx);
  y = rotatedY;
  const rotatedX = x * Math.cos(ry) + z * Math.sin(ry);
  z = -x * Math.sin(ry) + z * Math.cos(ry);
  x = rotatedX;
  const finalX = x * Math.cos(rz) - y * Math.sin(rz);
  y = x * Math.sin(rz) + y * Math.cos(rz);
  x = finalX;
  target[0] = x + finite(offset?.x);
  target[1] = y + finite(offset?.y);
  target[2] = z + finite(offset?.z);
}

function integratedVelocity(
  system: LoadedParticleSystem,
  particleAge: number,
  lifetime: number,
  curveRandom: number,
  initialPosition: readonly [number, number, number],
  target: [number, number, number],
): void {
  const velocity = record(system.raw.VelocityModule);
  const limiter = record(system.raw.ClampVelocityModule);
  const initial = record(system.raw.InitialModule);
  const gravityCurve = initial?.gravityModifier;
  const gravityEnabled =
    evaluateNativeMinMaxCurve(gravityCurve, 0.5, curveRandom) !== 0 ||
    evaluateNativeMinMaxCurve(gravityCurve, 1, curveRandom) !== 0;
  if ((velocity?.enabled !== true && !gravityEnabled) || particleAge <= 0) {
    target[0] = 0;
    target[1] = 0;
    target[2] = 0;
    return;
  }
  const steps = limiter?.enabled === true ? 12 : 1;
  const delta = particleAge / steps;
  let px = initialPosition[0];
  let py = initialPosition[1];
  let pz = initialPosition[2];
  let gravityVelocityY = 0;
  for (let step = 0; step < steps; step += 1) {
    const normalized = clamp(((step + 0.5) * delta) / Math.max(Number.EPSILON, lifetime));
    let vx = velocity?.enabled === true ? evaluateNativeMinMaxCurve(velocity.x, normalized, curveRandom) : 0;
    let vy = velocity?.enabled === true ? evaluateNativeMinMaxCurve(velocity.y, normalized, curveRandom) : 0;
    let vz = velocity?.enabled === true ? evaluateNativeMinMaxCurve(velocity.z, normalized, curveRandom) : 0;
    if (velocity?.enabled === true) {
      const offsetX = evaluateNativeMinMaxCurve(velocity.orbitalOffsetX, normalized, curveRandom);
      const offsetY = evaluateNativeMinMaxCurve(velocity.orbitalOffsetY, normalized, curveRandom);
      const offsetZ = evaluateNativeMinMaxCurve(velocity.orbitalOffsetZ, normalized, curveRandom);
      const angularX = evaluateNativeMinMaxCurve(velocity.orbitalX, normalized, curveRandom);
      const angularY = evaluateNativeMinMaxCurve(velocity.orbitalY, normalized, curveRandom);
      const angularZ = evaluateNativeMinMaxCurve(velocity.orbitalZ, normalized, curveRandom);
      const relativeX = px - offsetX;
      const relativeY = py - offsetY;
      const relativeZ = pz - offsetZ;
      vx += angularY * relativeZ - angularZ * relativeY;
      vy += angularZ * relativeX - angularX * relativeZ;
      vz += angularX * relativeY - angularY * relativeX;
      const radialLength = Math.hypot(relativeX, relativeY, relativeZ);
      if (radialLength > Number.EPSILON) {
        const radial = evaluateNativeMinMaxCurve(velocity.radial, normalized, curveRandom);
        vx += (relativeX / radialLength) * radial;
        vy += (relativeY / radialLength) * radial;
        vz += (relativeZ / radialLength) * radial;
      }
      const speedModifier = velocity.speedModifier
        ? evaluateNativeMinMaxCurve(velocity.speedModifier, normalized, curveRandom)
        : 1;
      vx *= speedModifier;
      vy *= speedModifier;
      vz *= speedModifier;
    }
    const gravity = evaluateNativeMinMaxCurve(gravityCurve, normalized, curveRandom);
    gravityVelocityY -= 9.81 * gravity * delta;
    vy += gravityVelocityY;
    if (limiter?.enabled === true) {
      if (limiter.separateAxis === true) {
        const limitX = Math.max(0, evaluateNativeMinMaxCurve(limiter.x, normalized, curveRandom));
        const limitY = Math.max(0, evaluateNativeMinMaxCurve(limiter.y, normalized, curveRandom));
        const limitZ = Math.max(0, evaluateNativeMinMaxCurve(limiter.z, normalized, curveRandom));
        vx = Math.sign(vx) * Math.min(Math.abs(vx), limitX);
        vy = Math.sign(vy) * Math.min(Math.abs(vy), limitY);
        vz = Math.sign(vz) * Math.min(Math.abs(vz), limitZ);
      } else {
        const limit = Math.max(0, evaluateNativeMinMaxCurve(limiter.magnitude, normalized, curveRandom));
        const speed = Math.hypot(vx, vy, vz);
        if (speed > limit && speed > 0) {
          const limitedSpeed = lerp(speed, limit, clamp(finite(limiter.dampen)));
          vx *= limitedSpeed / speed;
          vy *= limitedSpeed / speed;
          vz *= limitedSpeed / speed;
        }
      }
      // UnityParticleEffect.updateParticle uses the serialized drag curve after
      // velocity limiting. Every applicable effect001 system stores 0.74.
      const drag = Math.max(0, evaluateNativeMinMaxCurve(limiter.drag, normalized, curveRandom));
      const dragFactor = Math.max(0, 1 - drag * delta);
      vx *= dragFactor;
      vy *= dragFactor;
      vz *= dragFactor;
    }
    px += vx * delta;
    py += vy * delta;
    pz += vz * delta;
  }
  target[0] = px - initialPosition[0];
  target[1] = py - initialPosition[1];
  target[2] = pz - initialPosition[2];
}

function sampleParticle(
  system: LoadedParticleSystem,
  emission: ParticleEmission,
  currentSimulationTime: number,
  nativeWidth: number,
  baseSeed: number,
  startSizeXOverride?: number,
): ParticleSample | undefined {
  const initial = record(system.raw.InitialModule);
  if (!initial) return undefined;
  const seed = baseSeed ^ Math.imul(emission.index + 1, 0x9e3779b9);
  // Native ParticleSystem assigns one curve random to the particle's
  // lifetime, start size, velocity and curve modules, and a separate color
  // random to both start/lifetime gradients. Shape consumes its own stream.
  const curveRandom = random(seed + 11);
  const colorRandom = random(seed + 37);
  const lifetime = Math.max(0, evaluateNativeMinMaxCurve(initial.startLifetime, 0, curveRandom));
  const age = currentSimulationTime - emission.simulationTime;
  if (lifetime <= 0 || age < 0 || age >= lifetime) return undefined;
  const normalized = clamp(age / lifetime);
  shapePosition(system, seed, nativeWidth, SHAPE_POSITION_SCRATCH);
  integratedVelocity(system, age, lifetime, curveRandom, SHAPE_POSITION_SCRATCH, VELOCITY_POSITION_SCRATCH);
  // SetWidth writes the wall Transform.localScale.x, replacing its serialized
  // prefab value 4.9. Applying both would multiply the native width twice.
  const transformScale = system.ref.renderer === "wallMesh" ? UNIT_SCALE : (system.ref.localScale ?? UNIT_SCALE);
  PARTICLE_SAMPLE_SCRATCH.x =
    (emission.originX + SHAPE_POSITION_SCRATCH[0] + VELOCITY_POSITION_SCRATCH[0]) * transformScale[0];
  PARTICLE_SAMPLE_SCRATCH.y =
    (emission.originY + SHAPE_POSITION_SCRATCH[1] + VELOCITY_POSITION_SCRATCH[1]) * transformScale[1];
  PARTICLE_SAMPLE_SCRATCH.z =
    (emission.originZ + SHAPE_POSITION_SCRATCH[2] + VELOCITY_POSITION_SCRATCH[2]) * transformScale[2];
  const baseSize = evaluateNativeMinMaxCurve(initial.startSize, 0, curveRandom);
  const baseY = initial.size3D === true ? evaluateNativeMinMaxCurve(initial.startSizeY, 0, curveRandom) : baseSize;
  const baseZ = initial.size3D === true ? evaluateNativeMinMaxCurve(initial.startSizeZ, 0, curveRandom) : baseSize;
  const sizeModule = record(system.raw.SizeModule);
  let sizeX = startSizeXOverride ?? baseSize;
  let sizeY = baseY;
  let sizeZ = baseZ;
  if (sizeModule?.enabled === true) {
    sizeX *= evaluateNativeMinMaxCurve(sizeModule.curve, normalized, curveRandom);
    const separate = sizeModule.separateAxes === true;
    sizeY *= evaluateNativeMinMaxCurve(separate ? sizeModule.y : sizeModule.curve, normalized, curveRandom);
    sizeZ *= evaluateNativeMinMaxCurve(separate ? sizeModule.z : sizeModule.curve, normalized, curveRandom);
  }
  const initialColor = evaluateNativeMinMaxGradient(initial.startColor, 0, colorRandom, PARTICLE_COLOR_SCRATCH);
  const colorModule = record(system.raw.ColorModule);
  if (colorModule?.enabled === true) {
    const lifetimeColor = evaluateNativeMinMaxGradient(
      colorModule.gradient,
      normalized,
      colorRandom,
      PARTICLE_LIFETIME_COLOR_SCRATCH,
    );
    initialColor.r *= lifetimeColor.r;
    initialColor.g *= lifetimeColor.g;
    initialColor.b *= lifetimeColor.b;
    initialColor.a *= lifetimeColor.a;
  }
  const rotation = evaluateNativeMinMaxCurve(initial.startRotation, 0, curveRandom);
  const rotationModule = record(system.raw.RotationModule);
  const rotationOverLifetime =
    rotationModule?.enabled === true
      ? evaluateNativeMinMaxCurve(rotationModule.curve, normalized, curveRandom) * age
      : 0;
  PARTICLE_SAMPLE_SCRATCH.sizeX = sizeX * transformScale[0];
  PARTICLE_SAMPLE_SCRATCH.sizeY = sizeY * transformScale[1];
  PARTICLE_SAMPLE_SCRATCH.sizeZ = sizeZ * transformScale[2];
  PARTICLE_SAMPLE_SCRATCH.color = initialColor;
  PARTICLE_SAMPLE_SCRATCH.rotation = rotation + rotationOverLifetime;
  return PARTICLE_SAMPLE_SCRATCH;
}

function movementAt(
  prefab: LoadedPrefab,
  judgementAnimation: NativeAnimationClip | undefined,
  realTime: number,
  target: [number, number, number],
): void {
  const path = prefab.manifest.distanceEmitterPathHash;
  const clip = prefab.distanceAnimation ?? judgementAnimation;
  if (!clip || path === undefined || clip.duration <= 0) {
    target[0] = 0;
    target[1] = 0;
    target[2] = 0;
    return;
  }
  // An explicitly separate emitter controller loops. Directional flick uses
  // its current one-shot judgement clip and holds the last keyed transform.
  const animationTime = prefab.distanceAnimation ? realTime % clip.duration : clamp(realTime, 0, clip.duration);
  nativeAnimationClipPosition(clip, path, animationTime, target);
}

function appendEmission(
  system: LoadedParticleSystem,
  simulationTime: number,
  originX: number,
  originY: number,
  originZ: number,
  index: number,
): void {
  const emission = system.emissionPool.pop() ?? { simulationTime: 0, originX: 0, originY: 0, originZ: 0, index: 0 };
  emission.simulationTime = simulationTime;
  emission.originX = originX;
  emission.originY = originY;
  emission.originZ = originZ;
  emission.index = index;
  const result = system.emissionBuffer;
  const capacity = system.maxParticles;
  if (capacity <= 0) {
    system.emissionPool.push(emission);
    return;
  }

  // This renderer applies the serialized maxParticles limit by retaining the
  // newest emitted records. The old implementation appended the complete
  // history from time zero and trimmed it after sorting. A looping SlideLoop
  // therefore left every discarded ParticleEmission in emissionPool: at age
  // 300s one native system retained 72k records for maxParticles=1000. Keep
  // that same newest-K selection as a bounded min heap instead. At most K+1
  // records are needed, and the final sort preserves the old visible order.
  if (result.length < capacity) {
    let child = result.length;
    result.push(emission);
    while (child > 0) {
      const parent = (child - 1) >>> 1;
      const parentEmission = result[parent]!;
      if (compareEmission(parentEmission, emission) <= 0) break;
      result[child] = parentEmission;
      child = parent;
    }
    result[child] = emission;
    return;
  }

  const oldest = result[0]!;
  if (compareEmission(emission, oldest) <= 0) {
    system.emissionPool.push(emission);
    return;
  }
  let parent = 0;
  while (true) {
    const left = parent * 2 + 1;
    if (left >= result.length) break;
    const right = left + 1;
    const child = right < result.length && compareEmission(result[right]!, result[left]!) < 0 ? right : left;
    if (compareEmission(result[child]!, emission) >= 0) break;
    result[parent] = result[child]!;
    parent = child;
  }
  result[parent] = emission;
  system.emissionPool.push(oldest);
}

function compareEmission(left: ParticleEmission, right: ParticleEmission): number {
  return left.simulationTime - right.simulationTime || left.index - right.index;
}

function emissionEvents(
  system: LoadedParticleSystem,
  prefab: LoadedPrefab,
  age: number,
  seed: number,
  judgementAnimation?: NativeAnimationClip,
  animationTimeOffset = 0,
  simulationClock?: ParticleSimulationClock,
): ParticleEmission[] {
  while (system.emissionBuffer.length > 0) system.emissionPool.push(system.emissionBuffer.pop()!);
  const result = system.emissionBuffer;
  const delay = evaluateNativeMinMaxCurve(system.raw.startDelay, 0, random(seed + 1));
  const elapsedAfterDelay = age - delay / system.simulationSpeed;
  const realDuration = simulationClock ? Math.max(0, age) : Math.max(0, elapsedAfterDelay);
  const simulationDuration = simulationClock
    ? simulationClock.current
    : Math.max(0, elapsedAfterDelay) * system.simulationSpeed;
  if (simulationDuration <= 0) return result;
  const emission = record(system.raw.EmissionModule);
  if (!emission || emission.enabled !== true) return result;
  let emissionIndex = 0;
  const cycleCount = system.looping && system.length > 0 ? Math.floor(simulationDuration / system.length) + 1 : 1;
  for (let cycle = 0; cycle < cycleCount; cycle += 1) {
    const cycleStart = cycle * system.length;
    for (const rawBurst of array(emission.m_Bursts)) {
      const burst = record(rawBurst);
      if (!burst) continue;
      const baseTime = cycleStart + finite(burst.time);
      const repeats = Math.max(1, Math.round(finite(burst.cycleCount, 1)));
      for (let repeat = 0; repeat < repeats; repeat += 1) {
        const time = baseTime + repeat * finite(burst.repeatInterval);
        if (time > simulationDuration || random(seed + emissionIndex + 53) > finite(burst.probability, 1)) continue;
        const count = Math.max(
          0,
          Math.round(evaluateNativeMinMaxCurve(burst.countCurve, 0, random(seed + emissionIndex + 59))),
        );
        for (let index = 0; index < count; index += 1) appendEmission(system, time, 0, 0, 0, emissionIndex++);
      }
    }
  }
  let accumulator = 0;
  const maximumSimulationTime = system.looping ? simulationDuration : Math.min(simulationDuration, system.length);
  for (let start = 0; start < maximumSimulationTime; start += EMISSION_STEP) {
    const step = Math.min(EMISSION_STEP, maximumSimulationTime - start);
    const sampleTime = start + step / 2;
    const cycleTime = system.length > 0 ? sampleTime % system.length : sampleTime;
    const normalized = system.length > 0 ? cycleTime / system.length : 0;
    const rate = Math.max(0, evaluateNativeMinMaxCurve(emission.rateOverTime, normalized, random(seed + 61)));
    accumulator += rate * step;
    while (accumulator >= 1) {
      appendEmission(system, sampleTime, 0, 0, 0, emissionIndex++);
      accumulator -= 1;
    }
  }
  const distanceRate = Math.max(0, evaluateNativeMinMaxCurve(emission.rateOverDistance, 0, random(seed + 67)));
  if (distanceRate > 0 && (prefab.distanceAnimation || judgementAnimation)) {
    movementAt(prefab, judgementAnimation, animationTimeOffset, MOVEMENT_PREVIOUS_SCRATCH);
    let distanceAccumulator = 0;
    let hasSimulationTime = !simulationClock;
    for (let realTime = EMISSION_STEP; realTime <= realDuration + Number.EPSILON; realTime += EMISSION_STEP) {
      const currentTime = Math.min(realDuration, realTime);
      movementAt(prefab, judgementAnimation, animationTimeOffset + currentTime, MOVEMENT_CURRENT_SCRATCH);
      const currentSimulationTime = simulationClock?.timeAt(currentTime) ?? currentTime * system.simulationSpeed;
      if (currentSimulationTime <= 0) {
        MOVEMENT_PREVIOUS_SCRATCH[0] = MOVEMENT_CURRENT_SCRATCH[0];
        MOVEMENT_PREVIOUS_SCRATCH[1] = MOVEMENT_CURRENT_SCRATCH[1];
        MOVEMENT_PREVIOUS_SCRATCH[2] = MOVEMENT_CURRENT_SCRATCH[2];
        continue;
      }
      if (!hasSimulationTime) {
        hasSimulationTime = true;
        MOVEMENT_PREVIOUS_SCRATCH[0] = MOVEMENT_CURRENT_SCRATCH[0];
        MOVEMENT_PREVIOUS_SCRATCH[1] = MOVEMENT_CURRENT_SCRATCH[1];
        MOVEMENT_PREVIOUS_SCRATCH[2] = MOVEMENT_CURRENT_SCRATCH[2];
        continue;
      }
      distanceAccumulator +=
        Math.hypot(
          MOVEMENT_CURRENT_SCRATCH[0] - MOVEMENT_PREVIOUS_SCRATCH[0],
          MOVEMENT_CURRENT_SCRATCH[1] - MOVEMENT_PREVIOUS_SCRATCH[1],
          MOVEMENT_CURRENT_SCRATCH[2] - MOVEMENT_PREVIOUS_SCRATCH[2],
        ) * distanceRate;
      while (distanceAccumulator >= 1) {
        appendEmission(
          system,
          currentSimulationTime,
          MOVEMENT_CURRENT_SCRATCH[0],
          MOVEMENT_CURRENT_SCRATCH[1],
          MOVEMENT_CURRENT_SCRATCH[2],
          emissionIndex++,
        );
        distanceAccumulator -= 1;
      }
      MOVEMENT_PREVIOUS_SCRATCH[0] = MOVEMENT_CURRENT_SCRATCH[0];
      MOVEMENT_PREVIOUS_SCRATCH[1] = MOVEMENT_CURRENT_SCRATCH[1];
      MOVEMENT_PREVIOUS_SCRATCH[2] = MOVEMENT_CURRENT_SCRATCH[2];
    }
  }
  result.sort(compareEmission);
  return result;
}

function createEmissionRing(): EmissionRing {
  return { records: [], head: 0, count: 0 };
}

function createIncrementalEmissionState(): IncrementalEmissionState {
  return {
    initialized: false,
    seed: 0,
    lastAge: Number.NEGATIVE_INFINITY,
    nextRateStart: 0,
    rateRemainder: 0,
    emitted: 0,
    stepRemainder: 0,
    stepEmitted: 0,
    stepEvaluations: 0,
    rebuilds: 0,
    persistent: createEmissionRing(),
    transient: createEmissionRing(),
    output: [],
  };
}

function clearEmissionRing(ring: EmissionRing): void {
  ring.head = 0;
  ring.count = 0;
}

function resetIncrementalEmissionState(state: IncrementalEmissionState, seed: number): void {
  state.rebuilds += 1;
  state.initialized = true;
  state.seed = seed;
  state.lastAge = Number.NEGATIVE_INFINITY;
  state.nextRateStart = 0;
  state.rateRemainder = 0;
  state.emitted = 0;
  state.stepRemainder = 0;
  state.stepEmitted = 0;
  clearEmissionRing(state.persistent);
  clearEmissionRing(state.transient);
  state.output.length = 0;
}

/** Append an already chronological rate-over-time emission to a bounded ring. */
function appendRateEmission(ring: EmissionRing, capacity: number, simulationTime: number, index: number): void {
  if (capacity <= 0) return;
  let slot: number;
  if (ring.count < capacity) {
    slot = (ring.head + ring.count) % capacity;
    ring.count += 1;
  } else {
    slot = ring.head;
    ring.head = (ring.head + 1) % capacity;
  }
  const emission = (ring.records[slot] ??= {
    simulationTime: 0,
    originX: 0,
    originY: 0,
    originZ: 0,
    index: 0,
  });
  emission.simulationTime = simulationTime;
  emission.originX = 0;
  emission.originY = 0;
  emission.originZ = 0;
  emission.index = index;
}

function emissionRingAt(ring: EmissionRing, index: number): ParticleEmission {
  return ring.records[(ring.head + index) % ring.records.length]!;
}

function writeIncrementalOutput(state: IncrementalEmissionState, capacity: number): ParticleEmission[] {
  const total = state.persistent.count + state.transient.count;
  let skip = Math.max(0, total - capacity);
  let outputIndex = 0;
  for (let index = 0; index < state.persistent.count; index += 1) {
    if (skip > 0) {
      skip -= 1;
      continue;
    }
    state.output[outputIndex++] = emissionRingAt(state.persistent, index);
  }
  for (let index = 0; index < state.transient.count; index += 1) {
    if (skip > 0) {
      skip -= 1;
      continue;
    }
    state.output[outputIndex++] = emissionRingAt(state.transient, index);
  }
  state.output.length = outputIndex;
  return state.output;
}

/**
 * Rate-only systems are the long-lived SlideLoop hot path. Their emissions are
 * chronological, so a per effect-id/system ring can advance only the newly
 * elapsed 1/60-second steps. Bursts and distance emission retain the complete
 * replay fallback below; all shipped SlideLoop systems satisfy this predicate.
 */
function supportsIncrementalRateEmission(
  system: LoadedParticleSystem,
  prefab: LoadedPrefab,
  seed: number,
  judgementAnimation: NativeAnimationClip | undefined,
): boolean {
  const emission = record(system.raw.EmissionModule);
  if (!emission || emission.enabled !== true || array(emission.m_Bursts).length > 0) return false;
  const distanceRate = Math.max(0, evaluateNativeMinMaxCurve(emission.rateOverDistance, 0, random(seed + 67)));
  return distanceRate <= 0 || (!prefab.distanceAnimation && !judgementAnimation);
}

function processRateStep(
  state: IncrementalEmissionState,
  system: LoadedParticleSystem,
  emission: NativeRecord,
  seed: number,
  start: number,
  step: number,
  remainder: number,
  emitted: number,
  target: EmissionRing,
): void {
  const sampleTime = start + step / 2;
  const cycleTime = system.length > 0 ? sampleTime % system.length : sampleTime;
  const normalized = system.length > 0 ? cycleTime / system.length : 0;
  const rate = Math.max(0, evaluateNativeMinMaxCurve(emission.rateOverTime, normalized, random(seed + 61)));
  let nextRemainder = remainder + rate * step;
  let nextEmitted = emitted;
  while (nextRemainder >= 1) {
    appendRateEmission(target, system.maxParticles, sampleTime, nextEmitted++);
    nextRemainder -= 1;
  }
  state.stepRemainder = nextRemainder;
  state.stepEmitted = nextEmitted;
}

function incrementalRateEmissionEvents(
  state: IncrementalEmissionState,
  system: LoadedParticleSystem,
  age: number,
  seed: number,
): ParticleEmission[] {
  if (!state.initialized || state.seed !== seed || age < state.lastAge) resetIncrementalEmissionState(state, seed);
  clearEmissionRing(state.transient);
  const emission = record(system.raw.EmissionModule);
  const delay = evaluateNativeMinMaxCurve(system.raw.startDelay, 0, random(seed + 1));
  const elapsedAfterDelay = age - delay / system.simulationSpeed;
  if (!emission || emission.enabled !== true || elapsedAfterDelay < 0) {
    state.lastAge = age;
    state.output.length = 0;
    return state.output;
  }
  const simulationDuration = Math.max(0, elapsedAfterDelay) * system.simulationSpeed;
  const maximumSimulationTime = system.looping ? simulationDuration : Math.min(simulationDuration, system.length);

  // Commit complete native 60 Hz steps. The final fractional step is rebuilt
  // into a separate ring each frame because the full replay changes its sample
  // midpoint until that step becomes complete.
  while (state.nextRateStart < maximumSimulationTime) {
    const available = maximumSimulationTime - state.nextRateStart;
    if (available < EMISSION_STEP) break;
    processRateStep(
      state,
      system,
      emission,
      seed,
      state.nextRateStart,
      EMISSION_STEP,
      state.rateRemainder,
      state.emitted,
      state.persistent,
    );
    state.rateRemainder = state.stepRemainder;
    state.emitted = state.stepEmitted;
    state.stepEvaluations += 1;
    state.nextRateStart += EMISSION_STEP;
  }
  if (state.nextRateStart < maximumSimulationTime) {
    processRateStep(
      state,
      system,
      emission,
      seed,
      state.nextRateStart,
      maximumSimulationTime - state.nextRateStart,
      state.rateRemainder,
      state.emitted,
      state.transient,
    );
    state.stepEvaluations += 1;
  }
  state.lastAge = age;
  return writeIncrementalOutput(state, system.maxParticles);
}

/** Exact SetWidth input: no minimum two-lane width and no simulator-only multiplier. */
export function nativeEffectWidth(projector: StageProjector, chartWidth: number): number {
  return Math.max(0, projector.effectWidthToWorld(chartWidth));
}

/** LiveGameNoteEffectBase.SetWidth TransformScaleXSetRangeParam branch. */
export function nativeEffectWidthRangeScale(
  projector: StageProjector,
  nativeWidth: number,
  range: readonly [number, number] | undefined,
): number {
  if (!range) return 1;
  // SetWidth loads LiveGameNoteEffectBase._baseLaneWidth and divides the
  // supplied width by it. FullInitialize loads LiveLaneView._laneWidth, passes
  // it through Container.Initialize/BeforeInitialize, and
  // OnInitializeElementView forwards that full 19.12-unit width into
  // Base.Initialize. EarlyFloatLerp(min,max,width/fullLaneWidth,true) then
  // replaces (rather than multiplies) Transform.localScale.x.
  const progress = clamp(nativeWidth / Math.max(Number.EPSILON, projector.stageWidth));
  return lerp(range[0], range[1], progress);
}

/**
 * Apply a raw ParticleSystem Transform X rotation, then reflect Unity Z into
 * Three. `widthScaleX` is an inherited TransformScaleXSetRangeParam value.
 */
export function nativeParticleLocalPosition(
  ref: Effect001ParticleSystemAssetRef,
  sampleX: number,
  sampleY: number,
  sampleZ: number,
  widthScaleX: number,
  target = new Vector3(),
): Vector3 {
  const rotation = ref.localRotationX ?? 0;
  const cosine = Math.cos(rotation);
  const sine = Math.sin(rotation);
  const rotatedY = sampleY * cosine - sampleZ * sine;
  const rotatedZ = sampleY * sine + sampleZ * cosine;
  return target.set(
    (ref.localPosition[0] + sampleX) * widthScaleX,
    ref.localPosition[1] + rotatedY,
    -(ref.localPosition[2] + rotatedZ),
  );
}

/**
 * Parent X scale contribution for Unity ParticleSystemScalingMode.
 * Hierarchy(0) scales particle positions and sizes; Local(1) explicitly
 * ignores parent scale. The effect001 width-scaled systems use only 0 or 1.
 */
export function nativeParticleHierarchyScaleX(scalingMode: number, parentScaleX: number): number {
  return scalingMode === 0 ? parentScaleX : 1;
}

/**
 * World-space particles retain the emitter's position at spawn. A scaled
 * parent still scales the animated child Transform position, even when the
 * ParticleSystem's Local scaling mode prevents that parent scale from
 * changing particle size or velocity.
 */
export function nativeParticleEmitterScaledSampleX(
  sampleX: number,
  emissionOriginX: number,
  ownTransformScaleX: number,
  scalingMode: number,
  parentScaleX: number,
): number {
  return scalingMode === 0 ? sampleX : sampleX + emissionOriginX * ownTransformScaleX * (parentScaleX - 1);
}

/** Maps the render DTO to the LiveNoteEffectAssetSettings slot. */
export function effect001PrefabId(effect: RenderParticleEffect): number {
  if (isRenderLaneEffectKind(effect.kind)) return 0;
  if (effect.kind === "excellent") return EFFECT001_PREFAB_IDS.Excellent;
  if (effect.kind === "slide-loop") return EFFECT001_PREFAB_IDS.SlideLoop;
  if (effect.kind === "connect") return EFFECT001_PREFAB_IDS.Connect;
  if (effect.kind === "slide") return EFFECT001_PREFAB_IDS.Slide;
  if (effect.kind === "trace") return EFFECT001_PREFAB_IDS.Connect;
  if (effect.kind === "flick") {
    if (effect.direction === "left") return EFFECT001_PREFAB_IDS.Left;
    if (effect.direction === "right") return EFFECT001_PREFAB_IDS.Right;
    return EFFECT001_PREFAB_IDS.Flick;
  }
  return EFFECT001_PREFAB_IDS.Normal;
}

function effectAnimationJudgement(effect: RenderParticleEffect): Effect001AnimationJudgement {
  if (effect.judgement === "great") return "great";
  if (effect.judgement === "good") return "good";
  if (effect.judgement === "bad") return "bad";
  return "perfect";
}

export class ParticleLayer {
  readonly group = new Group();
  /** Layer-25 lane feedback, rendered by the base camera instead of HDR effect001. */
  readonly laneInputGroup = new Group();

  private readonly projector: StageProjector;
  private readonly assets: OurNotesAssetManifest;
  private readonly maxEffects: number;
  private readonly laneEffectCapacity: number;
  private readonly particlesPerEffect: number;
  private readonly capacity: number;
  private readonly plane = new PlaneGeometry(1, 1);
  private readonly slicedSpriteGeometry = createSlicedSpriteGeometry();
  private readonly wallGeometry = createWallGeometry();
  private readonly fallbackTexture = transparentTexture();
  // Missing decoded Unity media must fail closed: an invented visible strip
  // is more misleading than omitting an effect whose source sprite is absent.
  private readonly laneEffectFallbackTexture = transparentTexture();
  private readonly batches: Readonly<Record<BillboardTextureKey, ParticleQuadBatch>>;
  private readonly batchList: ReadonlyArray<ParticleQuadBatch>;
  private readonly frameBatch: EffectMeshBatch;
  private readonly pillarBatch: EffectMeshBatch;
  private readonly wallBatch: EffectMeshBatch;
  private readonly laneEffectBatch: EffectMeshBatch;
  private readonly impactBatchList: ReadonlyArray<EffectMeshBatch>;
  private readonly prefabManifests = new Map<number, Effect001PrefabAssetRef>();
  private readonly prefabSpriteMaps = new Map<number, ReadonlyMap<Effect001SpriteName, Effect001SpriteAssetRef>>();
  private readonly loadedPrefabs = new Map<number, LoadedPrefab>();
  private readonly impacts = new Map<string, ImpactVisual>();
  private readonly impactPool: ImpactVisual[] = [];
  private readonly emissionStatePools = new Map<LoadedParticleSystem, IncrementalEmissionState[]>();
  private readonly nextImpactIds = new Set<string>();
  private readonly effectIdScratch: string[] = [];
  private readonly noteEffectScratch: RenderParticleEffect[] = [];
  private readonly pointScratch = new Vector3();
  private readonly localPointScratch = new Vector3();
  private readonly textures = new Map<LoadedTextureKey, Texture>();
  private readonly loadedLaneEffectSystems = new Map<LaneEffectAssetKey, LoadedParticleSystem>();
  private disposed = false;
  /** Test-only parity switch; production always keeps the incremental path on. */
  private incrementalEmissions = true;
  private updateEpoch = 0;
  private impactAllocations = 0;

  constructor(
    projector: StageProjector,
    assets: OurNotesAssetManifest,
    maxEffects = 64,
    particlesPerEffect = SOURCE_EFFECT_PARTICLE_BUFFER_PER_EFFECT,
  ) {
    this.projector = projector;
    this.assets = assets;
    this.maxEffects = Math.max(1, Math.round(maxEffects));
    // Native FullInitialize owns one persistent instance for every
    // (LiveLaneEffectViewType, lane), independently from note effect001 pools.
    this.laneEffectCapacity = Math.max(
      this.maxEffects,
      Math.ceil(projector.laneCount) * Object.keys(assets.particles.laneEffects).length,
    );
    // This sizes the per-texture instance buffers. It must not be reused as a
    // cross-system emission quota: effect001's authored hierarchy order is
    // not an importance ordering.
    this.particlesPerEffect = Math.max(1, Math.round(particlesPerEffect));
    this.capacity = this.maxEffects * this.particlesPerEffect;
    this.batches = {
      star: new ParticleQuadBatch("star", this.capacity, this.fallbackTexture, MOBILE_ADD_HDR_TINT_NORMAL),
      longStar: new ParticleQuadBatch("longStar", this.capacity, this.fallbackTexture, MOBILE_ADD_HDR_TINT_LONG_STAR),
      centerPillar: new ParticleQuadBatch(
        "centerPillar",
        this.capacity,
        this.fallbackTexture,
        MOBILE_ADD_HDR_TINT_CENTER_PILLAR,
      ),
      centerPillar02: new ParticleQuadBatch(
        "centerPillar02",
        this.capacity,
        this.fallbackTexture,
        MOBILE_ADD_HDR_TINT_CENTER_PILLAR,
      ),
    };
    this.batchList = [this.batches.star, this.batches.longStar, this.batches.centerPillar, this.batches.centerPillar02];
    this.frameBatch = new EffectMeshBatch(
      "frame",
      this.slicedSpriteGeometry,
      this.maxEffects,
      this.fallbackTexture,
      MOBILE_ADD_HDR_TINT_STRONG,
      FRAME_SLICE_BORDER,
    );
    this.pillarBatch = new EffectMeshBatch(
      "pillars",
      this.plane,
      this.maxEffects * 4,
      this.fallbackTexture,
      MOBILE_ADD_HDR_TINT_NORMAL,
    );
    this.wallBatch = new EffectMeshBatch(
      "wall",
      this.wallGeometry,
      this.maxEffects,
      this.fallbackTexture,
      MOBILE_ADD_HDR_TINT_WALL,
      undefined,
      [0, WALL_MESH_SHADER_PIVOT_Y, 0.5],
    );
    // LiveLaneEffectViewType selects one of six lane ParticleSystems. Their XY
    // mesh roots are rotated +90 degrees onto the lane plane and use the
    // compiled UI/Additive premultiplied fragment program with One/One blend.
    this.laneEffectBatch = new EffectMeshBatch(
      "lane-effects",
      this.plane,
      this.laneEffectCapacity,
      this.laneEffectFallbackTexture,
      [1, 1, 1, 1],
      undefined,
      [0, 0, 0],
      OneFactor,
      OneFactor,
      "uiAdditive",
    );
    this.laneEffectBatch.mesh.renderOrder = 4141;
    this.impactBatchList = [this.frameBatch, this.pillarBatch, this.wallBatch];
    for (const prefab of Object.values(assets.particles.effect001Prefabs)) {
      this.prefabManifests.set(prefab.id, prefab);
      this.prefabSpriteMaps.set(prefab.id, new Map(prefab.sprites.map((sprite) => [sprite.name, sprite])));
    }
    this.group.name = "OurNotesEffect001";
    this.laneInputGroup.name = "OurNotesLaneEffects";
    for (const batch of this.batchList) this.group.add(batch.mesh);
    for (const batch of this.impactBatchList) this.group.add(batch.mesh);
    this.laneInputGroup.add(this.laneEffectBatch.mesh);
  }

  setPixelRatio(_pixelRatio: number): void {
    // effect001 billboards use authored world sizes; point-size/pixel-ratio
    // scaling was a simulator invention and is intentionally absent.
  }

  async loadTextures(loader = new TextureLoader()): Promise<void> {
    const loadErrors: Error[] = [];
    const errorOf = (reason: unknown, context?: string): Error => {
      const error = reason instanceof Error ? reason : new Error(String(reason));
      return context ? new Error(`${context}: ${error.message}`, { cause: error }) : error;
    };
    const textureRequests: ReadonlyArray<readonly [LoadedTextureKey, string]> = [
      ["star", this.assets.particles.starTextureUrl],
      ["longStar", this.assets.particles.longStarTextureUrl],
      ["line", this.assets.particles.tapLineTextureUrl],
      ["pillar", this.assets.particles.tapPillarTextureUrl],
      ["wall", this.assets.particles.wallTextureUrl],
      ["centerPillar", this.assets.particles.centerPillarTextureUrl],
      ["centerPillar02", this.assets.particles.centerPillar02TextureUrl],
      ["laneEffect", this.assets.particles.laneEffects.inVain.textureUrl],
    ];
    const textureResults = await Promise.allSettled(
      textureRequests.map(async ([key, url]) => [key, configure(await loader.loadAsync(url))] as const),
    );
    const laneEffectEntries = Object.entries(this.assets.particles.laneEffects) as Array<
      [LaneEffectAssetKey, LaneEffectParticleAssetRef]
    >;
    const laneEffectSystemResultsPromise = Promise.allSettled(
      laneEffectEntries.map(async ([key, ref]): Promise<readonly [LaneEffectAssetKey, LoadedParticleSystem]> => {
        const response = await fetch(ref.particleSystemMetadataUrl, { cache: "force-cache" });
        if (!response.ok) throw new Error(`${ref.particleSystemMetadataUrl}: HTTP ${response.status}`);
        const parsed = readNativeParticleSystem(await response.json());
        if (!parsed) throw new Error(`${ref.particleSystemMetadataUrl}: invalid ParticleSystem projection`);
        return [
          key,
          {
            ...parsed,
            ref: {
              name: `lane-effect/${key}`,
              metadataUrl: ref.particleSystemMetadataUrl,
              texture: "star",
              localPosition: [0, 0, 0],
              // Lane effects render through EffectMeshBatch, not the
              // effect001 billboard shader that consumes this field.
              rendererMaxParticleSize: 0,
            },
            emissionBuffer: [],
            emissionPool: [],
          },
        ] as const;
      }),
    );
    const animationRequests = new Map<string, Promise<NativeAnimationClip | undefined>>();
    const loadAnimation = (url: string): Promise<NativeAnimationClip | undefined> => {
      let request = animationRequests.get(url);
      if (!request) {
        request = fetch(url, { cache: "force-cache" })
          .then(async (response) => {
            if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
            const animation = readNativeAnimationClip(await response.json());
            if (!animation) throw new Error(`${url}: invalid AnimationClip projection`);
            return animation;
          })
          .catch((reason) => {
            loadErrors.push(errorOf(reason));
            return undefined;
          });
        animationRequests.set(url, request);
      }
      return request;
    };
    const prefabResults = await Promise.all(
      Object.values(this.assets.particles.effect001Prefabs).map(async (manifest): Promise<LoadedPrefab> => {
        const animationEntries = Object.entries(manifest.animationClipUrls ?? {}) as Array<
          [Effect001AnimationJudgement, string]
        >;
        const [systemResults, animationResult, animationResults, distanceResult] = await Promise.all([
          Promise.allSettled(
            manifest.particleSystems.map(async (ref): Promise<LoadedParticleSystem | undefined> => {
              const response = await fetch(ref.metadataUrl, { cache: "force-cache" });
              if (!response.ok) throw new Error(`${ref.metadataUrl}: HTTP ${response.status}`);
              const parsed = readNativeParticleSystem(await response.json());
              if (!parsed) throw new Error(`${ref.metadataUrl}: invalid ParticleSystem projection`);
              return { ...parsed, ref, emissionBuffer: [], emissionPool: [] };
            }),
          ),
          loadAnimation(manifest.animationClipUrl),
          Promise.all(
            animationEntries.map(async ([judgement, url]) => {
              const animation = await loadAnimation(url);
              return [judgement, animation] as const;
            }),
          ),
          manifest.distanceEmitterAnimationClipUrl
            ? loadAnimation(manifest.distanceEmitterAnimationClipUrl)
            : Promise.resolve(undefined),
        ]);
        const systems = systemResults.flatMap((result) => {
          if (result.status === "fulfilled" && result.value) return [result.value];
          if (result.status === "rejected") loadErrors.push(errorOf(result.reason));
          return [];
        });
        const animations = new Map<Effect001AnimationJudgement, NativeAnimationClip>();
        for (const [judgement, animation] of animationResults) if (animation) animations.set(judgement, animation);
        return {
          manifest,
          systems,
          animation: animationResult,
          animations,
          distanceAnimation: distanceResult,
          wallSystem: systems.find((system) => system.ref.renderer === "wallMesh"),
        };
      }),
    );
    const laneEffectSystemResults = await laneEffectSystemResultsPromise;
    if (this.disposed) {
      for (const result of textureResults) if (result.status === "fulfilled") result.value[1].dispose();
      return;
    }
    for (let index = 0; index < textureResults.length; index += 1) {
      const result = textureResults[index]!;
      if (result.status !== "fulfilled") {
        loadErrors.push(errorOf(result.reason, textureRequests[index]?.[1]));
        continue;
      }
      const [key, texture] = result.value;
      this.textures.get(key)?.dispose();
      this.textures.set(key, texture);
      if (key === "star" || key === "longStar" || key === "centerPillar" || key === "centerPillar02")
        this.batches[key].setTexture(texture);
      if (key === "line") this.frameBatch.setTexture(texture);
      if (key === "pillar") this.pillarBatch.setTexture(texture);
      if (key === "wall") this.wallBatch.setTexture(texture);
      if (key === "laneEffect") this.laneEffectBatch.setTexture(texture);
    }
    this.loadedLaneEffectSystems.clear();
    for (const result of laneEffectSystemResults) {
      if (result.status === "fulfilled") this.loadedLaneEffectSystems.set(...result.value);
      else loadErrors.push(errorOf(result.reason));
    }
    this.loadedPrefabs.clear();
    for (const prefab of prefabResults) this.loadedPrefabs.set(prefab.manifest.id, prefab);
    if (loadErrors.length > 0)
      throw new AggregateError(loadErrors, "One or more native particle resources failed to load");
  }

  update(effects: ReadonlyArray<RenderParticleEffect> | undefined): void {
    for (const batch of this.batchList) batch.reset();
    for (const batch of this.impactBatchList) batch.reset();
    const epoch = ++this.updateEpoch;
    this.noteEffectScratch.length = 0;
    for (const effect of effects ?? EMPTY_EFFECTS) {
      if (this.noteEffectScratch.length >= this.maxEffects) break;
      if (!isRenderLaneEffectKind(effect.kind)) this.noteEffectScratch.push(effect);
    }
    const effectList = this.noteEffectScratch;
    const effectCount = effectList.length;
    this.nextImpactIds.clear();
    this.effectIdScratch.length = effectCount;
    for (let effectIndex = 0; effectIndex < effectCount; effectIndex += 1) {
      const effect = effectList[effectIndex]!;
      const id = String(effect.id);
      this.effectIdScratch[effectIndex] = id;
      if (
        effect.age >= 0 &&
        (effect.lifetime === undefined || effect.age <= effect.lifetime) &&
        this.prefabManifests.has(effect001PrefabId(effect))
      )
        this.nextImpactIds.add(id);
    }
    // Release stale rigs before acquiring this frame's rigs. A completely
    // changing ID set therefore remains within maxEffects instead of briefly
    // allocating a second generation before end-of-frame cleanup.
    for (const [id, impact] of this.impacts) if (!this.nextImpactIds.has(id)) this.removeImpact(id, impact);
    for (let effectIndex = 0; effectIndex < effectCount; effectIndex += 1) {
      const effect = effectList[effectIndex]!;
      if (effect.age < 0 || (effect.lifetime !== undefined && effect.age > effect.lifetime)) continue;
      const prefabId = effect001PrefabId(effect);
      const manifest = this.prefabManifests.get(prefabId);
      if (!manifest) continue;
      const width = nativeEffectWidth(this.projector, effect.width ?? 1);
      // Native one-shot effects never use the screen_root approach curve.
      // PlayNoteEffect places their root directly on noteJudgementRoot3D.
      this.projector.effectPoint(effect.lane, effect.width ?? 1, this.pointScratch);
      const id = this.effectIdScratch[effectIndex]!;
      const loaded = this.loadedPrefabs.get(prefabId);
      const judgement = effectAnimationJudgement(effect);
      const movementAnimation = loaded?.animations.get(judgement) ?? loaded?.animation;
      const impact = this.updateImpact(
        id,
        manifest,
        loaded,
        effect.age,
        judgement,
        width,
        this.pointScratch,
        epoch,
        effect.seed ?? hash(id),
      );
      if (!loaded) continue;
      // The per-texture instance batch is the only capacity guard. It is
      // intentionally independent from prefab system order so an earlier
      // high-rate star stream cannot erase authored late glow systems.
      for (const system of loaded.systems) {
        if (system.ref.renderer === "wallMesh") continue;
        const playback = particleSystemPlayback(system, manifest, movementAnimation, effect.age);
        if (!playback) continue;
        const systemSeed = (effect.seed ?? hash(id)) ^ hash(system.ref.name);
        const simulationClock = particleSimulationClock(
          system,
          manifest,
          movementAnimation,
          playback.animationTimeOffset,
          systemSeed,
          playback.age,
        );
        const systemTime = simulationClock.current;
        const emissions = this.emissionEventsFor(
          impact,
          system,
          loaded,
          playback.age,
          systemSeed,
          movementAnimation,
          playback.animationTimeOffset,
          simulationClock,
        );
        for (const emission of emissions) {
          const sample = sampleParticle(system, emission, systemTime, width, systemSeed);
          if (!sample || system.ref.texture === "wall") continue;
          const mirror = manifest.rootScaleX;
          const parentWidthScaleX = nativeEffectWidthRangeScale(this.projector, width, system.ref.widthScaleRange);
          const hierarchyScaleX = nativeParticleHierarchyScaleX(system.scalingMode, parentWidthScaleX);
          const ownTransformScaleX = system.ref.localScale?.[0] ?? 1;
          const sampleX = nativeParticleEmitterScaledSampleX(
            sample.x,
            emission.originX,
            ownTransformScaleX,
            system.scalingMode,
            parentWidthScaleX,
          );
          nativeParticleLocalPosition(system.ref, sampleX, sample.y, sample.z, hierarchyScaleX, this.localPointScratch);
          this.batches[system.ref.texture].push(
            this.pointScratch.x + this.localPointScratch.x * mirror,
            this.pointScratch.y + this.localPointScratch.y,
            this.pointScratch.z + this.localPointScratch.z,
            sample.sizeX * hierarchyScaleX * mirror,
            sample.sizeY,
            sample.color,
            sample.rotation * mirror,
            system.ref.rendererMaxParticleSize,
            system.ref.rendererPivot?.[0] ?? 0,
            system.ref.rendererPivot?.[1] ?? 0,
          );
        }
      }
    }
    for (const batch of this.batchList) batch.finish();
    for (const batch of this.impactBatchList) batch.finish();
    for (const [id, impact] of this.impacts) if (impact.lastSeen !== epoch) this.removeImpact(id, impact);
  }

  updateLaneInput(effects: ReadonlyArray<RenderParticleEffect> | undefined): void {
    this.laneEffectBatch.reset();
    let rendered = 0;
    for (const effect of effects ?? EMPTY_EFFECTS) {
      if (rendered >= this.laneEffectCapacity) break;
      if (!isRenderLaneEffectKind(effect.kind)) continue;
      if (effect.age < 0 || (effect.lifetime !== undefined && effect.age > effect.lifetime)) continue;
      this.renderLaneEffect(effect, laneEffectAssetKey(effect.kind));
      rendered += 1;
    }
    this.laneEffectBatch.finish();
  }

  private renderLaneEffect(effect: RenderParticleEffect, assetKey: LaneEffectAssetKey): void {
    const width = nativeEffectWidth(this.projector, effect.width ?? 2);
    this.projector.effectPoint(effect.lane, effect.width ?? 2, this.pointScratch);
    const system = this.loadedLaneEffectSystems.get(assetKey);
    // A texture plus guessed size/color curves is not the authored effect.
    // Both the ParticleSystem projection and its original texture are needed.
    if (!system) return;
    const seed = effect.seed ?? hash(String(effect.id));
    const sample = sampleParticle(
      system,
      LANE_EFFECT_EMISSION,
      effect.age * system.simulationSpeed,
      width,
      seed,
      width,
    );
    if (!sample) return;
    const color = sample.color;
    const alpha = color.a;
    if (alpha <= 0) return;
    this.laneEffectBatch.push(
      this.pointScratch.x + sample.x,
      // LiveGameLaneEffectBase.SetPosition copies the lane root position
      // exactly. The source lane prefabs have no local Y offset, so a
      // renderer-only nudge here shifts the fill away from its native plane.
      this.pointScratch.y + sample.z,
      this.pointScratch.z - sample.y,
      // LiveGameLaneEffectBase.SetWidth replaces the active ParticleSystem's
      // startSizeX with one initialized lane width (19.12 / 24); it does not
      // multiply the authored 1.0/1.8 value.
      sample.sizeX,
      sample.sizeY,
      sample.sizeZ,
      color.r,
      color.g,
      color.b,
      alpha,
      LANE_EFFECT_UNITY_TO_THREE_ROTATION_X,
    );
  }

  private updateImpact(
    id: string,
    manifest: Effect001PrefabAssetRef,
    loaded: LoadedPrefab | undefined,
    age: number,
    judgement: Effect001AnimationJudgement,
    width: number,
    position: Vector3,
    epoch: number,
    seed: number,
  ): ImpactVisual {
    let impact = this.impacts.get(id);
    if (!impact) {
      impact = this.createImpact(id);
      this.impacts.set(id, impact);
      this.group.add(impact.root);
    }
    if (impact.prefabId !== manifest.id) {
      this.releaseImpactEmissionStates(impact);
      impact.prefabId = manifest.id;
    }
    impact.lastSeen = epoch;
    impact.root.position.copy(position);
    impact.root.scale.set(manifest.rootScaleX, 1, 1);
    const animation = loaded?.animations.get(judgement) ?? loaded?.animation;
    const animationTime =
      animation && manifest.loopAnimation && animation.duration > 0 ? age % animation.duration : age;
    for (let index = 0; index < SPRITE_NAMES.length; index += 1) {
      const name = SPRITE_NAMES[index]!;
      const spec = this.prefabSpriteMaps.get(manifest.id)?.get(name);
      if (!spec) continue;
      const path = PATH_HASH[name];
      const activeValue = clipBindingValue(animation, path, ATTRIBUTE_ACTIVE, animationTime);
      const alphaValue = clipBindingValue(animation, path, ATTRIBUTE_COLOR_ALPHA, animationTime);
      const sizeValue = clipBindingValue(animation, path, ATTRIBUTE_SIZE_X, animationTime);
      const active = activeValue === undefined ? spec.baseActive : activeValue >= 0.5;
      const alpha = alphaValue === undefined ? spec.baseColor[3] : clamp(alphaValue);
      if (!active || alpha <= 0 || !this.textures.has(name === "frame" ? "line" : "pillar")) continue;
      const x =
        name === "pillar01" || name === "pillar03"
          ? -width / 2
          : name === "pillar02" || name === "pillar04"
            ? width / 2
            : spec.localPosition[0];
      const sizeX = name === "frame" ? Math.max(0, width + 0.4) : Math.max(0, sizeValue ?? spec.baseSize[0]);
      const batch = name === "frame" ? this.frameBatch : this.pillarBatch;
      const flipX = spec.flipX ? -1 : 1;
      const rotationX = -spec.localRotationX;
      const pivotOffsetX = (0.5 - spec.pivot[0]) * sizeX * spec.localScale[0] * flipX;
      const pivotOffsetY = (0.5 - spec.pivot[1]) * spec.baseSize[1] * spec.localScale[1];
      const rotatedPivotY = pivotOffsetY * Math.cos(rotationX);
      const rotatedPivotZ = pivotOffsetY * Math.sin(rotationX);
      batch.push(
        position.x + (x + pivotOffsetX) * manifest.rootScaleX,
        position.y + spec.localPosition[1] + rotatedPivotY,
        position.z - spec.localPosition[2] + rotatedPivotZ,
        sizeX * spec.localScale[0] * manifest.rootScaleX * flipX,
        spec.baseSize[1] * spec.localScale[1],
        spec.localScale[2],
        spec.baseColor[0],
        spec.baseColor[1],
        spec.baseColor[2],
        alpha,
        rotationX,
      );
    }
    const wallSystem = loaded?.wallSystem;
    const wallTexture = this.textures.get("wall");
    if (!loaded || !wallSystem || !wallTexture) return impact;
    const playback = particleSystemPlayback(wallSystem, manifest, animation, age);
    if (!playback) return impact;
    const wallSeed = seed ^ hash(wallSystem.ref.name);
    const simulationClock = particleSimulationClock(
      wallSystem,
      manifest,
      animation,
      playback.animationTimeOffset,
      wallSeed,
      playback.age,
    );
    const emissions = this.emissionEventsFor(
      impact,
      wallSystem,
      loaded,
      playback.age,
      wallSeed,
      animation,
      playback.animationTimeOffset,
      simulationClock,
    );
    const wallTime = simulationClock.current;
    for (const emission of emissions) {
      const sample = sampleParticle(wallSystem, emission, wallTime, width, wallSeed);
      if (!sample) continue;
      if (sample.color.a <= 0) continue;
      nativeParticleLocalPosition(wallSystem.ref, sample.x, sample.y, sample.z, 1, this.localPointScratch);
      this.wallBatch.push(
        position.x + this.localPointScratch.x * manifest.rootScaleX,
        position.y + this.localPointScratch.y,
        position.z + this.localPointScratch.z,
        Math.max(0, width - 0.15) * sample.sizeX * manifest.rootScaleX,
        sample.sizeY,
        sample.sizeZ,
        sample.color.r,
        sample.color.g,
        sample.color.b,
        sample.color.a,
      );
      break;
    }
    return impact;
  }

  private emissionEventsFor(
    impact: ImpactVisual,
    system: LoadedParticleSystem,
    prefab: LoadedPrefab,
    age: number,
    seed: number,
    judgementAnimation?: NativeAnimationClip,
    animationTimeOffset = 0,
    simulationClock?: ParticleSimulationClock,
  ): ParticleEmission[] {
    if (
      !this.incrementalEmissions ||
      system.ref.animationPath ||
      simulationClock ||
      !supportsIncrementalRateEmission(system, prefab, seed, judgementAnimation)
    ) {
      return emissionEvents(system, prefab, age, seed, judgementAnimation, animationTimeOffset, simulationClock);
    }
    let state = impact.emissionStates.get(system);
    if (!state) {
      const pool = this.emissionStatePools.get(system);
      state = pool?.pop() ?? createIncrementalEmissionState();
      impact.emissionStates.set(system, state);
    }
    return incrementalRateEmissionEvents(state, system, age, seed);
  }

  private releaseImpactEmissionStates(impact: ImpactVisual): void {
    for (const [system, state] of impact.emissionStates) {
      state.initialized = false;
      clearEmissionRing(state.persistent);
      clearEmissionRing(state.transient);
      state.output.length = 0;
      let pool = this.emissionStatePools.get(system);
      if (!pool) {
        pool = [];
        this.emissionStatePools.set(system, pool);
      }
      if (pool.length < this.maxEffects) pool.push(state);
    }
    impact.emissionStates.clear();
  }

  private createImpact(id: string): ImpactVisual {
    const pooled = this.impactPool.pop();
    if (pooled) {
      pooled.root.name = `Effect001:${id}`;
      pooled.prefabId = -1;
      return pooled;
    }
    const root = new Group();
    root.name = `Effect001:${id}`;
    this.impactAllocations += 1;
    return { root, lastSeen: 0, prefabId: -1, emissionStates: new Map() };
  }

  private removeImpact(id: string, impact: ImpactVisual): void {
    this.group.remove(impact.root);
    this.impacts.delete(id);
    this.releaseImpactEmissionStates(impact);
    impact.prefabId = -1;
    if (this.impactPool.length < this.maxEffects) this.impactPool.push(impact);
    else this.destroyImpact(impact);
  }

  private destroyImpact(impact: ImpactVisual): void {
    this.releaseImpactEmissionStates(impact);
  }

  get stats(): {
    activeImpacts: number;
    pooledImpacts: number;
    allocatedImpacts: number;
    impactPoolCapacity: number;
    impactInstanceCapacity: number;
    pointCapacity: number;
    totalParticleCapacity: number;
    renderedParticles: number;
    renderedImpactInstances: number;
    particleDrawCalls: number;
    impactDrawCalls: number;
  } {
    let renderedParticles = 0;
    let particleDrawCalls = 0;
    for (const batch of this.batchList) {
      renderedParticles += batch.count;
      if (batch.count > 0) particleDrawCalls += 1;
    }
    let renderedImpactInstances = 0;
    let impactDrawCalls = 0;
    for (const batch of this.impactBatchList) {
      renderedImpactInstances += batch.count;
      if (batch.count > 0) impactDrawCalls += 1;
    }
    renderedImpactInstances += this.laneEffectBatch.count;
    if (this.laneEffectBatch.count > 0) impactDrawCalls += 1;
    return {
      activeImpacts: this.impacts.size,
      pooledImpacts: this.impactPool.length,
      allocatedImpacts: this.impactAllocations,
      impactPoolCapacity: this.maxEffects,
      impactInstanceCapacity: this.maxEffects * 6 + this.laneEffectCapacity,
      pointCapacity: this.capacity,
      totalParticleCapacity: this.capacity * this.batchList.length,
      renderedParticles,
      renderedImpactInstances,
      particleDrawCalls,
      impactDrawCalls,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const impact of this.impacts.values()) this.destroyImpact(impact);
    for (const impact of this.impactPool) this.destroyImpact(impact);
    this.impacts.clear();
    this.impactPool.length = 0;
    this.emissionStatePools.clear();
    for (const batch of this.batchList) batch.dispose();
    for (const batch of this.impactBatchList) batch.dispose();
    this.laneEffectBatch.dispose();
    this.plane.dispose();
    this.slicedSpriteGeometry.dispose();
    this.wallGeometry.dispose();
    for (const texture of this.textures.values()) texture.dispose();
    this.textures.clear();
    this.loadedPrefabs.clear();
    this.fallbackTexture.dispose();
    this.laneEffectFallbackTexture.dispose();
    this.group.clear();
    this.laneInputGroup.clear();
  }
}
