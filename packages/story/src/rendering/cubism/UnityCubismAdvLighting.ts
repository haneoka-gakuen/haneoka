/**
 * CPU mirror of the packaged `Live2D Cubism/Lit-URP-ADV-optimize` GLES3
 * program. Keep this file free of Three/Cubism dependencies so the packing
 * and pixel math can be tested independently of WebGL.
 */

export type UnityCubismVec2 = readonly [x: number, y: number];
export type UnityCubismVec3 = readonly [x: number, y: number, z: number];
export type UnityCubismVec4 = readonly [x: number, y: number, z: number, w: number];
export type UnityCubismRgba = readonly [r: number, g: number, b: number, a: number];

export interface UnityCubismPackedSphericalHarmonics {
  readonly ar: UnityCubismVec4;
  readonly ag: UnityCubismVec4;
  readonly ab: UnityCubismVec4;
  readonly br: UnityCubismVec4;
  readonly bg: UnityCubismVec4;
  readonly bb: UnityCubismVec4;
  readonly c: UnityCubismVec4;
}

export interface UnityCubismVertexLight {
  /** Pre-accumulated `_ADDITIONAL_LIGHTS_VERTEX` color at this vertex. */
  readonly color: UnityCubismVec3;
  /** Pre-accumulated and normalized direction at this vertex. */
  readonly direction: UnityCubismVec3;
}

/** Uniform packing emitted by URP's InitializeLightConstants_Common. */
export interface UnityCubismAdditionalLight {
  readonly position: UnityCubismVec4;
  readonly color: UnityCubismVec3;
  readonly attenuation: UnityCubismVec4;
  readonly spotDirection: UnityCubismVec3;
}

export interface UnityCubismLightingState {
  readonly enabled: boolean;
  /** AdvFieldRendererFeature registers story characters with this set to true. */
  readonly disableForMultiplicativeDrawables: boolean;
  /** URP `_MainLightPosition`; directional lights contain `-Transform.forward`. */
  readonly mainLightPosition: UnityCubismVec4;
  /** URP `VisibleLight.finalColor.rgb`, including Light.intensity. */
  readonly mainLightColor: UnityCubismVec3;
  readonly sphericalHarmonics: UnityCubismPackedSphericalHarmonics;
  /** The reference configuration uses the per-vertex additional-light keyword variant. */
  readonly additionalLights?: readonly UnityCubismAdditionalLight[];
}

export interface UnityCubismMultiplyTextureParameters {
  readonly enabled: boolean;
  /** Compiled uniform `_MultiplyUV`, despite the stale serialized `_MultiplyTexUV` property. */
  readonly uv: UnityCubismVec4;
  readonly intensity: number;
  readonly amplitude: UnityCubismVec2;
  readonly frequency: number;
}

export interface UnityCubismDirectionalLightLike {
  readonly active?: boolean;
  /** Normalized local-to-world column 2, preferred when a parent has signed scale. */
  readonly forward?: Readonly<{ x?: number; y?: number; z?: number }>;
  /** World rotation, not merely the serialized local rotation. */
  readonly rotation?: Readonly<{ x?: number; y?: number; z?: number; w?: number }>;
  readonly color?: Readonly<{ r?: number; g?: number; b?: number }>;
  readonly intensity?: number;
}

export interface UnityCubismAdditionalLightLike extends UnityCubismDirectionalLightLike {
  /** Unity LightType: 0=spot, 1=directional, 2=point. */
  readonly type?: number | "spot" | "directional" | "point";
  readonly position?: Readonly<{ x?: number; y?: number; z?: number }>;
  readonly range?: number;
  readonly spotAngle?: number;
  readonly innerSpotAngle?: number;
}

export interface UnityCubismOptimizedPixelInput {
  readonly texture: UnityCubismRgba;
  readonly vertexColor: UnityCubismRgba;
  readonly drawableMultiplyColor: UnityCubismRgba;
  readonly normal: UnityCubismVec3;
  readonly lighting: UnityCubismLightingState;
  readonly blendMode: UnityCubismBlendMode;
  readonly modelOpacity?: number;
  readonly vertexLight?: UnityCubismVertexLight;
  readonly multiplyTexture?: Readonly<{
    parameters: UnityCubismMultiplyTextureParameters;
    sample: UnityCubismVec3;
  }>;
  readonly mask?: number;
}

export const UnityCubismBlendMode = Object.freeze({
  Normal: 0,
  Additive: 1,
  Multiplicative: 2,
} as const);

export type UnityCubismBlendMode = (typeof UnityCubismBlendMode)[keyof typeof UnityCubismBlendMode];

const ZERO4 = Object.freeze([0, 0, 0, 0] as const);

export const UNITY_CUBISM_MAX_ADDITIONAL_LIGHTS = 16;

/** RenderSettings path 80 is AmbientMode.Flat with a white linear ambient color. */
export function createFlatUnitySphericalHarmonics(color: UnityCubismVec3): UnityCubismPackedSphericalHarmonics {
  return {
    ar: [0, 0, 0, color[0]],
    ag: [0, 0, 0, color[1]],
    ab: [0, 0, 0, color[2]],
    br: ZERO4,
    bg: ZERO4,
    bb: ZERO4,
    c: ZERO4,
  };
}

export const UNITY_CUBISM_REFERENCE_FLAT_WHITE_SH = Object.freeze(createFlatUnitySphericalHarmonics([1, 1, 1]));

export const DEFAULT_UNITY_CUBISM_LIGHTING: UnityCubismLightingState = Object.freeze({
  enabled: false,
  disableForMultiplicativeDrawables: true,
  // UniversalRenderPipeline.k_DefaultLightPosition.
  mainLightPosition: Object.freeze([0, 0, 1, 0] as const),
  // UniversalRenderPipeline.k_DefaultLightColor is black.
  mainLightColor: Object.freeze([0, 0, 0] as const),
  sphericalHarmonics: UNITY_CUBISM_REFERENCE_FLAT_WHITE_SH,
  additionalLights: Object.freeze([]),
});

export const DEFAULT_UNITY_CUBISM_MULTIPLY_TEXTURE: UnityCubismMultiplyTextureParameters = Object.freeze({
  enabled: false,
  uv: Object.freeze([1, 1, 0, 0] as const),
  intensity: 0.3,
  amplitude: Object.freeze([0, 0] as const),
  frequency: 0.5,
});

function finite(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function dot3(left: UnityCubismVec3, right: UnityCubismVec3): number {
  return left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
}

function dot4(left: UnityCubismVec4, right: UnityCubismVec4): number {
  return left[0] * right[0] + left[1] * right[1] + left[2] * right[2] + left[3] * right[3];
}

function normalize3(value: UnityCubismVec3, fallback: UnityCubismVec3): UnityCubismVec3 {
  const lengthSquared = dot3(value, value);
  if (!(lengthSquared > 0) || !Number.isFinite(lengthSquared)) return fallback;
  const inverseLength = 1 / Math.sqrt(lengthSquared);
  return [value[0] * inverseLength, value[1] * inverseLength, value[2] * inverseLength];
}

function unityLightForward(light: UnityCubismDirectionalLightLike): UnityCubismVec3 {
  const sourceForward = light.forward;
  if (sourceForward) {
    return normalize3([finite(sourceForward.x, 0), finite(sourceForward.y, 0), finite(sourceForward.z, 1)], [0, 0, 1]);
  }

  const sourceRotation = light.rotation || {};
  let x = finite(sourceRotation.x, 0);
  let y = finite(sourceRotation.y, 0);
  let z = finite(sourceRotation.z, 0);
  let w = finite(sourceRotation.w, 1);
  const lengthSquared = x * x + y * y + z * z + w * w;
  if (lengthSquared > 0 && Number.isFinite(lengthSquared)) {
    const inverseLength = 1 / Math.sqrt(lengthSquared);
    x *= inverseLength;
    y *= inverseLength;
    z *= inverseLength;
    w *= inverseLength;
  } else {
    x = 0;
    y = 0;
    z = 0;
    w = 1;
  }

  // q * UnityEngine.Vector3.forward.
  return [2 * (x * z + w * y), 2 * (y * z - w * x), 1 - 2 * (x * x + y * y)];
}

function unityLightColor(light: UnityCubismDirectionalLightLike): UnityCubismVec3 {
  const color = light.color || {};
  // VisibleLight.finalColor is already in the active Gamma color space.
  // InitializeLightConstants_Common does not clamp intensity.
  const intensity = finite(light.intensity, 1);
  return [finite(color.r, 1) * intensity, finite(color.g, 1) * intensity, finite(color.b, 1) * intensity];
}

/** Exact scalar constants selected by the GLES3 `UNITY_COLORSPACE_GAMMA` variant. */
export function unityCubismLinearToSrgb(value: number): number {
  if (value <= 0.00313080009) return value * 12.9232101;
  return Math.pow(Math.abs(value), 0.416666657) * 1.05499995 - 0.0549999997;
}

/** Mirrors the packed `ShadeSH9` operations emitted in shader subprogram 4. */
export function evaluateUnityCubismSphericalHarmonics(
  normal: UnityCubismVec3,
  coefficients: UnityCubismPackedSphericalHarmonics,
): UnityCubismVec3 {
  const n = normalize3(normal, [0, 0, 1]);
  const n4: UnityCubismVec4 = [n[0], n[1], n[2], 1];
  const quadratic: UnityCubismVec4 = [n[1] * n[0], n[2] * n[1], n[2] * n[2], n[0] * n[2]];
  const difference = n[0] * n[0] - n[1] * n[1];
  return [
    dot4(coefficients.br, quadratic) + coefficients.c[0] * difference + dot4(coefficients.ar, n4),
    dot4(coefficients.bg, quadratic) + coefficients.c[1] * difference + dot4(coefficients.ag, n4),
    dot4(coefficients.bb, quadratic) + coefficients.c[2] * difference + dot4(coefficients.ab, n4),
  ];
}

export function isUnityCubismLightingEnabledForBlend(
  lighting: Pick<UnityCubismLightingState, "enabled" | "disableForMultiplicativeDrawables">,
  blendMode: UnityCubismBlendMode,
): boolean {
  return (
    lighting.enabled &&
    !(lighting.disableForMultiplicativeDrawables && blendMode === UnityCubismBlendMode.Multiplicative)
  );
}

/**
 * Packs the directional fields exactly as URP's InitializeLightConstants_Common:
 * `_MainLightPosition = -localToWorld.GetColumn(2)` and finalColor = color * intensity.
 */
export function packUnityUrpDirectionalLight(light: UnityCubismDirectionalLightLike | null | undefined): {
  readonly active: boolean;
  readonly mainLightPosition: UnityCubismVec4;
  readonly mainLightColor: UnityCubismVec3;
} {
  if (!light || light.active === false) {
    return {
      active: false,
      mainLightPosition: DEFAULT_UNITY_CUBISM_LIGHTING.mainLightPosition,
      mainLightColor: DEFAULT_UNITY_CUBISM_LIGHTING.mainLightColor,
    };
  }

  // URP stores the negated local-to-world column 2 for directional lights.
  const [forwardX, forwardY, forwardZ] = unityLightForward(light);
  return {
    active: true,
    mainLightPosition: [-forwardX, -forwardY, -forwardZ, 0],
    mainLightColor: unityLightColor(light),
  };
}

function unityAdditionalLightType(light: UnityCubismAdditionalLightLike): "spot" | "directional" | "point" | null {
  if (light.type === 0 || light.type === "spot") return "spot";
  if (light.type === 1 || light.type === "directional") return "directional";
  if (light.type === 2 || light.type === "point") return "point";
  return null;
}

/**
 * Packs one uniform-array entry for the reference
 * `_ADDITIONAL_LIGHTS_VERTEX` variant.
 */
export function packUnityUrpAdditionalLight(
  light: UnityCubismAdditionalLightLike | null | undefined,
): UnityCubismAdditionalLight | null {
  if (!light || light.active === false) return null;
  const type = unityAdditionalLightType(light);
  if (!type) return null;

  const color = unityLightColor(light);
  const [forwardX, forwardY, forwardZ] = unityLightForward(light);
  if (type === "directional") {
    return {
      position: [-forwardX, -forwardY, -forwardZ, 0],
      color,
      attenuation: [0, 1, 0, 1],
      spotDirection: [0, 0, 1],
    };
  }

  const sourcePosition = light.position || {};
  const position: UnityCubismVec4 = [
    finite(sourcePosition.x, 0),
    finite(sourcePosition.y, 0),
    finite(sourcePosition.z, 0),
    1,
  ];
  const range = finite(light.range, 10);
  const rangeSquared = range * range;
  const inverseRangeSquared = 1 / Math.max(rangeSquared, 0.0001);
  const fadeRangeSquared = rangeSquared * 0.64000004529953 - rangeSquared;
  const rangeOverFade = rangeSquared === 0 ? 0 : -rangeSquared / fadeRangeSquared;
  if (type === "point") {
    return {
      position,
      color,
      attenuation: [inverseRangeSquared, rangeOverFade, 0, 1],
      spotDirection: [0, 0, 1],
    };
  }

  // Unity clamps only the pathological outer-angle range below 2.6 degrees.
  const serializedOuterDegrees = finite(light.spotAngle, 30);
  const outerDegrees = Math.max(2.6, serializedOuterDegrees);
  const hasInnerAngle = Number.isFinite(Number(light.innerSpotAngle));
  const outerHalfRadians = (outerDegrees * 0.5 * Math.PI) / 180;
  const innerHalfRadians = hasInnerAngle
    ? ((serializedOuterDegrees < 2.6
        ? Math.min(finite(light.innerSpotAngle, 0), 2.6)
        : finite(light.innerSpotAngle, 0)) *
        0.5 *
        Math.PI) /
      180
    : Math.atan(Math.tan(outerHalfRadians) * (46 / 64));
  const outerCosine = Math.cos(outerHalfRadians);
  const innerCosine = Math.cos(innerHalfRadians);
  const inverseAngleRange = 1 / Math.max(innerCosine - outerCosine, 0.001);
  return {
    position,
    color,
    attenuation: [inverseRangeSquared, rangeOverFade, inverseAngleRange, -outerCosine * inverseAngleRange],
    spotDirection: [-forwardX, -forwardY, -forwardZ],
  };
}

export function packUnityUrpAdditionalLights(
  lights: readonly UnityCubismAdditionalLightLike[],
): readonly UnityCubismAdditionalLight[] {
  const packed: UnityCubismAdditionalLight[] = [];
  for (const light of lights) {
    const value = packUnityUrpAdditionalLight(light);
    if (value) packed.push(value);
    if (packed.length === UNITY_CUBISM_MAX_ADDITIONAL_LIGHTS) break;
  }
  return packed;
}

/** CPU mirror of subprograms 8-11's vertex-light accumulation loop. */
export function evaluateUnityCubismAdditionalVertexLights(
  worldPosition: UnityCubismVec3,
  lights: readonly UnityCubismAdditionalLight[],
  perObjectLightCount = lights.length,
): UnityCubismVertexLight {
  const count = Math.min(
    UNITY_CUBISM_MAX_ADDITIONAL_LIGHTS,
    lights.length,
    Math.max(0, Math.trunc(finite(perObjectLightCount, lights.length))),
  );
  let colorR = 0;
  let colorG = 0;
  let colorB = 0;
  let directionX = 0;
  let directionY = 0;
  let directionZ = 0;
  let totalAttenuation = 0;
  for (let index = 0; index < count; index += 1) {
    const light = lights[index];
    const vector: UnityCubismVec3 = [
      light.position[0] - worldPosition[0] * light.position[3],
      light.position[1] - worldPosition[1] * light.position[3],
      light.position[2] - worldPosition[2] * light.position[3],
    ];
    const distanceSquared = Math.max(dot3(vector, vector), 6.10351562e-5);
    const inverseDistance = 1 / Math.sqrt(distanceSquared);
    const direction: UnityCubismVec3 = [
      vector[0] * inverseDistance,
      vector[1] * inverseDistance,
      vector[2] * inverseDistance,
    ];
    const rangeFactor = distanceSquared * light.attenuation[0];
    const smoothFactor = Math.max(1 - rangeFactor * rangeFactor, 0);
    const distanceAttenuation = (smoothFactor * smoothFactor) / distanceSquared;
    const spotBase = Math.max(
      0,
      Math.min(1, dot3(light.spotDirection, direction) * light.attenuation[2] + light.attenuation[3]),
    );
    const attenuation = distanceAttenuation * spotBase * spotBase;
    directionX += direction[0] * attenuation;
    directionY += direction[1] * attenuation;
    directionZ += direction[2] * attenuation;
    colorR += light.color[0] * attenuation;
    colorG += light.color[1] * attenuation;
    colorB += light.color[2] * attenuation;
    totalAttenuation += attenuation;
  }

  const direction =
    totalAttenuation > 0
      ? normalize3(
          [directionX / totalAttenuation, directionY / totalAttenuation, directionZ / totalAttenuation],
          [0, 0, 1],
        )
      : ([0, 0, 1] as const);
  return { color: [colorR, colorG, colorB], direction };
}

export function evaluateUnityCubismLightFactor(
  normal: UnityCubismVec3,
  lighting: UnityCubismLightingState,
  blendMode: UnityCubismBlendMode,
  vertexLight?: UnityCubismVertexLight,
): UnityCubismVec3 {
  if (!isUnityCubismLightingEnabledForBlend(lighting, blendMode)) return [1, 1, 1];

  const n = normalize3(normal, [0, 0, 1]);
  const sh = evaluateUnityCubismSphericalHarmonics(n, lighting.sphericalHarmonics);
  const ambient: UnityCubismVec3 = [
    unityCubismLinearToSrgb(sh[0]),
    unityCubismLinearToSrgb(sh[1]),
    unityCubismLinearToSrgb(sh[2]),
  ];
  const mainDirection = normalize3(
    [lighting.mainLightPosition[0], lighting.mainLightPosition[1], lighting.mainLightPosition[2]],
    [0, 0, 1],
  );
  const mainNdotL = Math.max(0, dot3(n, [-mainDirection[0], -mainDirection[1], -mainDirection[2]]));
  let lightR = lighting.mainLightColor[0] * mainNdotL;
  let lightG = lighting.mainLightColor[1] * mainNdotL;
  let lightB = lighting.mainLightColor[2] * mainNdotL;
  if (vertexLight) {
    const additionalDirection = normalize3(vertexLight.direction, [0, 0, 1]);
    const additionalNdotL = Math.max(0, dot3(n, additionalDirection));
    lightR += vertexLight.color[0] * additionalNdotL;
    lightG += vertexLight.color[1] * additionalNdotL;
    lightB += vertexLight.color[2] * additionalNdotL;
  }
  return [ambient[0] * lightR, ambient[1] * lightG, ambient[2] * lightB];
}

export function unityCubismMultiplyTextureUv(
  screenUv: UnityCubismVec2,
  timeSeconds: number,
  parameters: UnityCubismMultiplyTextureParameters,
): UnityCubismVec2 {
  const wave = Math.sin(timeSeconds * parameters.frequency * 2 * Math.PI);
  return [
    screenUv[0] * parameters.uv[0] + parameters.uv[2] + parameters.amplitude[0] * wave,
    screenUv[1] * parameters.uv[1] + parameters.uv[3] + parameters.amplitude[1] * wave,
  ];
}

/** CPU oracle for regression tests and browser pixel probes. */
export function evaluateUnityCubismAdvOptimizedPixel(input: UnityCubismOptimizedPixelInput): UnityCubismRgba {
  const alpha = input.texture[3] * input.vertexColor[3];
  const light = evaluateUnityCubismLightFactor(input.normal, input.lighting, input.blendMode, input.vertexLight);
  const rgb = [
    input.texture[0] * input.drawableMultiplyColor[0] * input.vertexColor[0] * light[0],
    input.texture[1] * input.drawableMultiplyColor[1] * input.vertexColor[1] * light[1],
    input.texture[2] * input.drawableMultiplyColor[2] * input.vertexColor[2] * light[2],
  ];
  const multiply = input.multiplyTexture;
  if (multiply?.parameters.enabled) {
    const weight = multiply.parameters.intensity;
    rgb[0] += (rgb[0] * multiply.sample[0] - rgb[0]) * weight;
    rgb[1] += (rgb[1] * multiply.sample[1] - rgb[1]) * weight;
    rgb[2] += (rgb[2] * multiply.sample[2] - rgb[2]) * weight;
  }
  const opacity = input.modelOpacity ?? 1;
  const mask = input.mask ?? 1;
  return [
    rgb[0] * alpha * opacity * mask,
    rgb[1] * alpha * opacity * mask,
    rgb[2] * alpha * opacity * mask,
    alpha * opacity * mask,
  ];
}
