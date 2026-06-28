/**
 * Unity Volume stack compatibility layer for the ADV camera.
 *
 * The normalized API deliberately preserves every serialized override state.
 * Values that are not overridden must continue to come from the lower-priority
 * profile or the component constructor default; treating the serialized value
 * as active would change the generated color LUT.
 */

export interface UnityColorValue {
  readonly r?: number;
  readonly g?: number;
  readonly b?: number;
  readonly a?: number;
  /** Trackball parameters serialize as Vector4 instead of Color. */
  readonly x?: number;
  readonly y?: number;
  readonly z?: number;
  readonly w?: number;
}

export interface UnityVector2Value {
  readonly x: number;
  readonly y: number;
}

export interface UnityCurveKeyframe {
  readonly time: number;
  readonly value: number;
  readonly inSlope: number;
  readonly outSlope: number;
  readonly weightedMode?: number;
  readonly inWeight?: number;
  readonly outWeight?: number;
}

export interface UnityTextureCurve {
  readonly "<length>k__BackingField"?: number;
  readonly m_Loop?: number | boolean;
  readonly m_ZeroValue?: number;
  readonly m_Range?: number;
  readonly m_Curve?: {
    readonly m_Curve?: readonly UnityCurveKeyframe[];
    readonly m_PreInfinity?: number;
    readonly m_PostInfinity?: number;
  };
}

export interface UnityVolumeField<T = unknown> {
  readonly override?: boolean;
  readonly overrideState?: number;
  readonly value?: T;
}

export interface UnityVolumeComponent {
  readonly name?: string;
  readonly active?: boolean;
  readonly fields?: Readonly<Record<string, UnityVolumeField>>;
}

export interface UnityVolumeProfile {
  readonly name?: string;
  readonly effectName?: string;
  readonly componentOrder?: readonly string[];
  readonly components?: Readonly<Record<string, UnityVolumeComponent>>;
  /** Stage profiles are emitted in this compact form by infoData.mjs. */
  readonly bloom?: Readonly<Record<string, unknown>> | null;
  readonly splitToning?: Readonly<Record<string, unknown>> | null;
  readonly curvedLens?: Readonly<Record<string, unknown>> | null;
}

export interface AdvVolumeLayer {
  readonly profile: UnityVolumeProfile;
  readonly weight: number;
}

export interface AdvBloomVolume {
  active: boolean;
  skipIterations: number;
  threshold: number;
  intensity: number;
  scatter: number;
  clamp: number;
  tint: UnityColorValue;
  dirtTexture: unknown;
  dirtIntensity: number;
  highQualityFiltering: boolean;
  maxIterations: number;
  downscale: number;
  filter: number;
}

export interface AdvSplitToningVolume {
  active: boolean;
  shadows: UnityColorValue;
  highlights: UnityColorValue;
  balance: number;
}

export interface AdvColorAdjustmentsVolume {
  active: boolean;
  postExposure: number;
  contrast: number;
  colorFilter: UnityColorValue;
  hueShift: number;
  saturation: number;
}

export interface AdvWhiteBalanceVolume {
  active: boolean;
  temperature: number;
  tint: number;
}

export interface AdvLiftGammaGainVolume {
  active: boolean;
  lift: UnityColorValue;
  gamma: UnityColorValue;
  gain: UnityColorValue;
}

export interface AdvShadowsMidtonesHighlightsVolume {
  active: boolean;
  shadows: UnityColorValue;
  midtones: UnityColorValue;
  highlights: UnityColorValue;
  shadowsStart: number;
  shadowsEnd: number;
  highlightsStart: number;
  highlightsEnd: number;
}

export interface AdvChannelMixerVolume {
  active: boolean;
  redOutRedIn: number;
  redOutGreenIn: number;
  redOutBlueIn: number;
  greenOutRedIn: number;
  greenOutGreenIn: number;
  greenOutBlueIn: number;
  blueOutRedIn: number;
  blueOutGreenIn: number;
  blueOutBlueIn: number;
}

export interface AdvColorCurvesVolume {
  active: boolean;
  master: UnityTextureCurve;
  red: UnityTextureCurve;
  green: UnityTextureCurve;
  blue: UnityTextureCurve;
  hueVsHue: UnityTextureCurve;
  hueVsSat: UnityTextureCurve;
  satVsSat: UnityTextureCurve;
  lumVsSat: UnityTextureCurve;
}

export interface AdvVignetteVolume {
  active: boolean;
  color: UnityColorValue;
  center: UnityVector2Value;
  intensity: number;
  smoothness: number;
  rounded: boolean;
}

export interface AdvChromaticAberrationVolume {
  active: boolean;
  intensity: number;
}

export interface AdvLensDistortionVolume {
  active: boolean;
  intensity: number;
  xMultiplier: number;
  yMultiplier: number;
  center: UnityVector2Value;
  scale: number;
}

export interface AdvFilmGrainVolume {
  active: boolean;
  type: number;
  intensity: number;
  response: number;
  texture: unknown;
}

export interface AdvDepthOfFieldVolume {
  active: boolean;
  mode: number;
  gaussianStart: number;
  gaussianEnd: number;
  gaussianMaxRadius: number;
  highQualitySampling: boolean;
  focusDistance: number;
  focalLength: number;
  aperture: number;
  bladeCount: number;
  bladeCurvature: number;
  bladeRotation: number;
}

export interface AdvMotionBlurVolume {
  active: boolean;
  mode: number;
  quality: number;
  intensity: number;
  clamp: number;
}

export interface AdvPaniniProjectionVolume {
  active: boolean;
  distance: number;
  cropToFit: number;
}

export interface AdvColorLookupVolume {
  active: boolean;
  texture: unknown;
  contribution: number;
}

export interface AdvTonemappingVolume {
  active: boolean;
  mode: number;
}

export interface AdvUrpVolumeState {
  bloom: AdvBloomVolume;
  splitToning: AdvSplitToningVolume;
  colorAdjustments: AdvColorAdjustmentsVolume;
  whiteBalance: AdvWhiteBalanceVolume;
  liftGammaGain: AdvLiftGammaGainVolume;
  shadowsMidtonesHighlights: AdvShadowsMidtonesHighlightsVolume;
  channelMixer: AdvChannelMixerVolume;
  colorCurves: AdvColorCurvesVolume;
  vignette: AdvVignetteVolume;
  chromaticAberration: AdvChromaticAberrationVolume;
  lensDistortion: AdvLensDistortionVolume;
  filmGrain: AdvFilmGrainVolume;
  depthOfField: AdvDepthOfFieldVolume;
  motionBlur: AdvMotionBlurVolume;
  paniniProjection: AdvPaniniProjectionVolume;
  colorLookup: AdvColorLookupVolume;
  tonemapping: AdvTonemappingVolume;
}

const WHITE: UnityColorValue = { r: 1, g: 1, b: 1, a: 1 };
const GRAY: UnityColorValue = { r: 0.5, g: 0.5, b: 0.5, a: 1 };
const BLACK: UnityColorValue = { r: 0, g: 0, b: 0, a: 1 };
const NEUTRAL_TRACKBALL: UnityColorValue = { r: 1, g: 1, b: 1, a: 0 };

function identityCurve(): UnityTextureCurve {
  return {
    "<length>k__BackingField": 2,
    m_Loop: 0,
    m_ZeroValue: 0,
    m_Range: 1,
    m_Curve: {
      m_Curve: [
        { time: 0, value: 0, inSlope: 1, outSlope: 1, weightedMode: 0 },
        { time: 1, value: 1, inSlope: 1, outSlope: 1, weightedMode: 0 },
      ],
    },
  };
}

function constantCurve(zeroValue: number, loop: boolean): UnityTextureCurve {
  return {
    "<length>k__BackingField": 0,
    m_Loop: loop ? 1 : 0,
    m_ZeroValue: zeroValue,
    m_Range: 1,
    m_Curve: {
      m_Curve: [],
    },
  };
}

export function createDefaultAdvUrpVolumeState(): AdvUrpVolumeState {
  return {
    bloom: {
      active: true,
      skipIterations: 1,
      threshold: 0.9,
      intensity: 0,
      scatter: 0.7,
      clamp: 65472,
      tint: { ...WHITE },
      dirtTexture: null,
      dirtIntensity: 0,
      highQualityFiltering: false,
      maxIterations: 6,
      downscale: 0,
      filter: 0,
    },
    splitToning: { active: true, shadows: { ...GRAY }, highlights: { ...GRAY }, balance: 0 },
    colorAdjustments: {
      active: true,
      postExposure: 0,
      contrast: 0,
      colorFilter: { ...WHITE },
      hueShift: 0,
      saturation: 0,
    },
    whiteBalance: { active: true, temperature: 0, tint: 0 },
    liftGammaGain: {
      active: true,
      lift: { ...NEUTRAL_TRACKBALL },
      gamma: { ...NEUTRAL_TRACKBALL },
      gain: { ...NEUTRAL_TRACKBALL },
    },
    shadowsMidtonesHighlights: {
      active: true,
      shadows: { ...NEUTRAL_TRACKBALL },
      midtones: { ...NEUTRAL_TRACKBALL },
      highlights: { ...NEUTRAL_TRACKBALL },
      shadowsStart: 0,
      shadowsEnd: 0.3,
      highlightsStart: 0.55,
      highlightsEnd: 1,
    },
    channelMixer: {
      active: true,
      redOutRedIn: 100,
      redOutGreenIn: 0,
      redOutBlueIn: 0,
      greenOutRedIn: 0,
      greenOutGreenIn: 100,
      greenOutBlueIn: 0,
      blueOutRedIn: 0,
      blueOutGreenIn: 0,
      blueOutBlueIn: 100,
    },
    colorCurves: {
      active: true,
      master: identityCurve(),
      red: identityCurve(),
      green: identityCurve(),
      blue: identityCurve(),
      // ColorCurves' constructor creates all four secondary TextureCurves
      // from an empty AnimationCurve and zeroValue=0.5. Only the two hue
      // curves enable loop; saturation/luminance do not turn into the
      // identity diagonal when loop is false.
      hueVsHue: constantCurve(0.5, true),
      hueVsSat: constantCurve(0.5, true),
      satVsSat: constantCurve(0.5, false),
      lumVsSat: constantCurve(0.5, false),
    },
    vignette: {
      active: true,
      color: { ...BLACK },
      center: { x: 0.5, y: 0.5 },
      intensity: 0,
      smoothness: 0.2,
      rounded: false,
    },
    chromaticAberration: { active: true, intensity: 0 },
    lensDistortion: {
      active: true,
      intensity: 0,
      xMultiplier: 1,
      yMultiplier: 1,
      center: { x: 0.5, y: 0.5 },
      scale: 1,
    },
    filmGrain: { active: true, type: 0, intensity: 0, response: 0.8, texture: null },
    depthOfField: {
      active: true,
      mode: 0,
      gaussianStart: 10,
      gaussianEnd: 30,
      gaussianMaxRadius: 1,
      highQualitySampling: false,
      focusDistance: 10,
      focalLength: 50,
      aperture: 5.6,
      bladeCount: 5,
      bladeCurvature: 1,
      bladeRotation: 0,
    },
    // MotionBlur defaults to MotionBlurQuality.Low (0).
    motionBlur: { active: true, mode: 0, quality: 0, intensity: 0, clamp: 0.05 },
    // PaniniProjection defaults: distance=0, cropToFit=1.
    paniniProjection: { active: true, distance: 0, cropToFit: 1 },
    colorLookup: { active: true, texture: null, contribution: 1 },
    tonemapping: { active: true, mode: 0 },
  };
}

function finite(value: unknown, fallback = 0): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp01(value: unknown): number {
  return Math.max(0, Math.min(1, finite(value)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function componentKey(name: string): keyof AdvUrpVolumeState | null {
  const normalized = name.replace(/[^a-z0-9]/gi, "").toLowerCase();
  const keys: Readonly<Record<string, keyof AdvUrpVolumeState>> = {
    bloom: "bloom",
    splittoning: "splitToning",
    colorsplittoning: "splitToning",
    coloradjustments: "colorAdjustments",
    whitebalance: "whiteBalance",
    liftgammagain: "liftGammaGain",
    shadowsmidtoneshighlights: "shadowsMidtonesHighlights",
    channelmixer: "channelMixer",
    colorcurves: "colorCurves",
    vignette: "vignette",
    chromaticaberration: "chromaticAberration",
    lensdistortion: "lensDistortion",
    filmgrain: "filmGrain",
    depthoffield: "depthOfField",
    motionblur: "motionBlur",
    paniniprojection: "paniniProjection",
    colorlookup: "colorLookup",
    tonemapping: "tonemapping",
  };
  return keys[normalized] ?? null;
}

function cloneValue<T>(value: T): T {
  if (value == null || typeof value !== "object") return value;
  return structuredClone(value);
}

const NO_INTERPOLATION_FIELDS = new Set([
  "active",
  "mode",
  "quality",
  "type",
  "rounded",
  "highQualityFiltering",
  "highQualitySampling",
  "downscale",
  "filter",
  "dirtTexture",
  "texture",
  "master",
  "red",
  "green",
  "blue",
  "hueVsHue",
  "hueVsSat",
  "satVsSat",
  "lumVsSat",
]);

const INTEGER_INTERPOLATION_FIELDS = new Set(["skipIterations", "maxIterations", "bladeCount"]);

/** Mathf.RoundToInt: nearest integer with ties rounded to the even integer. */
function roundToNearestEven(value: number): number {
  const lower = Math.floor(value);
  const fraction = value - lower;
  if (fraction < 0.5) return lower;
  if (fraction > 0.5) return lower + 1;
  return lower % 2 === 0 ? lower : lower + 1;
}

function interpolateValue(from: unknown, to: unknown, weight: number, field: string): unknown {
  if (NO_INTERPOLATION_FIELDS.has(field)) return weight > 0 ? cloneValue(to) : from;
  if (typeof from === "number" && typeof to === "number") {
    const value = from + (to - from) * weight;
    return INTEGER_INTERPOLATION_FIELDS.has(field) ? roundToNearestEven(value) : value;
  }
  if (typeof from === "boolean" && typeof to === "boolean") return weight > 0 ? to : from;
  if (isRecord(from) && isRecord(to)) {
    const result: Record<string, unknown> = { ...from };
    for (const [key, value] of Object.entries(to)) {
      result[key] = interpolateValue(from[key], value, weight, key);
    }
    return result;
  }
  return weight > 0 ? cloneValue(to) : from;
}

function fieldIsOverridden(field: UnityVolumeField | undefined): boolean {
  return Boolean(field?.override ?? field?.overrideState === 1);
}

function applyComponent(
  state: AdvUrpVolumeState,
  key: keyof AdvUrpVolumeState,
  component: UnityVolumeComponent,
  weight: number,
): void {
  if (component.active === false || weight <= 0) return;
  const target = state[key] as unknown as Record<string, unknown>;
  target.active = true;
  for (const [fieldName, field] of Object.entries(component.fields ?? {})) {
    if (!fieldIsOverridden(field) || field.value === undefined || !(fieldName in target)) continue;
    target[fieldName] = interpolateValue(target[fieldName], field.value, weight, fieldName);
  }
}

function compactStageComponent(name: string, value: Readonly<Record<string, unknown>>): UnityVolumeComponent {
  const fields: Record<string, UnityVolumeField> = {};
  for (const [fieldName, fieldValue] of Object.entries(value)) {
    if (fieldName === "active") continue;
    if (fieldName.endsWith("Override") || fieldName.endsWith("OverrideState")) continue;
    const override = value[`${fieldName}Override`] ?? value[`${fieldName}OverrideState`] === 1;
    fields[fieldName] = { override: Boolean(override), value: fieldValue };
  }
  return { name, active: value.active !== false, fields };
}

function profileComponents(profile: UnityVolumeProfile): readonly UnityVolumeComponent[] {
  const result: UnityVolumeComponent[] = [];
  const components = profile.components ?? {};
  const orderedNames = profile.componentOrder?.length ? profile.componentOrder : Object.keys(components);
  for (const name of orderedNames) {
    const component = components[name];
    if (component) result.push({ ...component, name: component.name || name });
  }
  if (profile.bloom) result.push(compactStageComponent("Bloom", profile.bloom));
  if (profile.splitToning) result.push(compactStageComponent("SplitToning", profile.splitToning));
  return result;
}

/** Rebuilds Unity's global stack from constructor defaults and ordered layers. */
export function resolveAdvVolumeStack(layers: readonly AdvVolumeLayer[]): AdvUrpVolumeState {
  const state = createDefaultAdvUrpVolumeState();
  for (const layer of layers) {
    const weight = clamp01(layer.weight);
    if (weight <= 0) continue;
    for (const component of profileComponents(layer.profile)) {
      const key = componentKey(component.name ?? "");
      if (key) applyComponent(state, key, component, weight);
    }
  }
  return state;
}

export function advVolumeProfileKey(profile: UnityVolumeProfile | string | null | undefined): string {
  if (typeof profile === "string") return profile;
  return String(profile?.name || profile?.effectName || "");
}
