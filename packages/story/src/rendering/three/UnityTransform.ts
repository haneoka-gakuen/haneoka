import { Color, Euler, Matrix4, Quaternion, Vector2, Vector3, Vector4 } from "three";

export interface UnityVector2Like {
  readonly x: number;
  readonly y: number;
}

export interface UnityVector3Like extends UnityVector2Like {
  readonly z: number;
}

export interface UnityVector4Like extends UnityVector3Like {
  readonly w: number;
}

export type UnityQuaternionLike = UnityVector4Like;

export interface UnityColorLike {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a?: number;
}

export type UnityVector2Source = UnityVector2Like | readonly [number, number];
export type UnityVector3Source = UnityVector3Like | readonly [number, number, number];
export type UnityVector4Source = UnityVector4Like | readonly [number, number, number, number];
export type UnityColorSource =
  UnityColorLike | readonly [number, number, number] | readonly [number, number, number, number];

/**
 * A serialized Unity Matrix4x4 in row-major field order (m00..m33).
 * Three stores Matrix4.elements column-major, so conversion must go through
 * Matrix4.set() rather than Matrix4.fromArray().
 */
export type UnityMatrixSource =
  | readonly [
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
    ]
  | {
      readonly m00: number;
      readonly m01: number;
      readonly m02: number;
      readonly m03: number;
      readonly m10: number;
      readonly m11: number;
      readonly m12: number;
      readonly m13: number;
      readonly m20: number;
      readonly m21: number;
      readonly m22: number;
      readonly m23: number;
      readonly m30: number;
      readonly m31: number;
      readonly m32: number;
      readonly m33: number;
    };

export interface UnityRgba {
  readonly color: Color;
  readonly alpha: number;
}

export type UnityColorEncoding = "linear" | "srgb";

const HANDEDNESS_REFLECTION = new Matrix4().makeScale(1, 1, -1);
const scratchMatrixA = new Matrix4();
const scratchMatrixB = new Matrix4();
const scratchQuaternion = new Quaternion();
const scratchEuler = new Euler();
const scratchPosition = new Vector3();
const scratchScale = new Vector3();

function finite(value: number, fallback = 0): number {
  return Number.isFinite(value) ? value : fallback;
}

function component2(source: UnityVector2Source, index: 0 | 1): number {
  if (Array.isArray(source)) return finite(source[index]);
  return index === 0 ? finite((source as UnityVector2Like).x) : finite((source as UnityVector2Like).y);
}

function component3(source: UnityVector3Source, index: 0 | 1 | 2): number {
  if (Array.isArray(source)) return finite(source[index]);
  const value = source as UnityVector3Like;
  if (index === 0) return finite(value.x);
  if (index === 1) return finite(value.y);
  return finite(value.z);
}

function component4(source: UnityVector4Source, index: 0 | 1 | 2 | 3): number {
  if (Array.isArray(source)) return finite(source[index]);
  const value = source as UnityVector4Like;
  if (index === 0) return finite(value.x);
  if (index === 1) return finite(value.y);
  if (index === 2) return finite(value.z);
  return finite(value.w, 1);
}

function matrixValues(source: UnityMatrixSource): readonly number[] {
  if (Array.isArray(source)) return source;
  const value = source as Exclude<UnityMatrixSource, readonly number[]>;
  return [
    value.m00,
    value.m01,
    value.m02,
    value.m03,
    value.m10,
    value.m11,
    value.m12,
    value.m13,
    value.m20,
    value.m21,
    value.m22,
    value.m23,
    value.m30,
    value.m31,
    value.m32,
    value.m33,
  ];
}

function setRowMajor(target: Matrix4, values: readonly number[]): Matrix4 {
  if (values.length !== 16) throw new RangeError(`A Unity Matrix4x4 requires 16 values; received ${values.length}`);
  return target.set(
    finite(values[0]),
    finite(values[1]),
    finite(values[2]),
    finite(values[3]),
    finite(values[4]),
    finite(values[5]),
    finite(values[6]),
    finite(values[7]),
    finite(values[8]),
    finite(values[9]),
    finite(values[10]),
    finite(values[11]),
    finite(values[12]),
    finite(values[13]),
    finite(values[14]),
    finite(values[15]),
  );
}

/** Returns the C=diag(1,1,-1,1) basis conversion matrix. */
export function unityToThreeBasis(target = new Matrix4()): Matrix4 {
  return target.copy(HANDEDNESS_REFLECTION);
}

export function unityVector2(source: UnityVector2Source, target = new Vector2()): Vector2 {
  return target.set(component2(source, 0), component2(source, 1));
}

/** Converts a Unity position or direction from +Z-forward to Three's -Z-forward basis. */
export function unityVector3(source: UnityVector3Source, target = new Vector3()): Vector3 {
  return target.set(component3(source, 0), component3(source, 1), -component3(source, 2));
}

export function threeVector3ToUnity(source: Readonly<Vector3>, target = new Vector3()): Vector3 {
  return target.set(finite(source.x), finite(source.y), -finite(source.z));
}

/**
 * Scale is basis-independent: C * scale * C leaves all three scale components
 * unchanged. Negating scale.z here would introduce an unwanted reflection.
 */
export function unityScale(source: UnityVector3Source, target = new Vector3()): Vector3 {
  return target.set(component3(source, 0), component3(source, 1), component3(source, 2));
}

/**
 * Converts a Unity quaternion by converting its rotation matrix with C*R*C.
 * This avoids relying on memorized sign rules and remains correct for arbitrary
 * normalized quaternions.
 */
export function unityQuaternion(
  source: UnityQuaternionLike | readonly [number, number, number, number],
  target = new Quaternion(),
): Quaternion {
  scratchQuaternion
    .set(component4(source, 0), component4(source, 1), component4(source, 2), component4(source, 3))
    .normalize();
  scratchMatrixA.makeRotationFromQuaternion(scratchQuaternion);
  scratchMatrixB.copy(HANDEDNESS_REFLECTION).multiply(scratchMatrixA).multiply(HANDEDNESS_REFLECTION);
  return target.setFromRotationMatrix(scratchMatrixB).normalize();
}

/**
 * Unity's Quaternion.Euler applies the serialized Euler components in Z-X-Y
 * order. The basis conversion is still performed through C*R*C.
 */
export function unityEulerDegrees(source: UnityVector3Source, target = new Quaternion()): Quaternion {
  const radians = Math.PI / 180;
  scratchEuler.set(
    component3(source, 0) * radians,
    component3(source, 1) * radians,
    component3(source, 2) * radians,
    "ZXY",
  );
  scratchQuaternion.setFromEuler(scratchEuler);
  // `unityQuaternion` reads all source components before mutating its target,
  // so the shared quaternion can be passed directly. Avoid allocating a
  // four-element tuple for every animated transform on every frame.
  return unityQuaternion(scratchQuaternion, target);
}

/** Converts a complete Unity transform matrix with Mthree=C*Munity*C. */
export function unityMatrix4(source: UnityMatrixSource, target = new Matrix4()): Matrix4 {
  setRowMajor(scratchMatrixA, matrixValues(source));
  return target.copy(HANDEDNESS_REFLECTION).multiply(scratchMatrixA).multiply(HANDEDNESS_REFLECTION);
}

/** Converts a Three matrix back to Unity's basis. C is its own inverse. */
export function threeMatrix4ToUnity(source: Readonly<Matrix4>, target = new Matrix4()): Matrix4 {
  return target.copy(HANDEDNESS_REFLECTION).multiply(source).multiply(HANDEDNESS_REFLECTION);
}

export function unityTrs(
  position: UnityVector3Source,
  rotation: UnityQuaternionLike | readonly [number, number, number, number],
  scale: UnityVector3Source,
  target = new Matrix4(),
): Matrix4 {
  unityVector3(position, scratchPosition);
  unityQuaternion(rotation, scratchQuaternion);
  unityScale(scale, scratchScale);
  return target.compose(scratchPosition, scratchQuaternion, scratchScale);
}

export function unityEulerTrs(
  position: UnityVector3Source,
  eulerDegrees: UnityVector3Source,
  scale: UnityVector3Source,
  target = new Matrix4(),
): Matrix4 {
  unityVector3(position, scratchPosition);
  unityEulerDegrees(eulerDegrees, scratchQuaternion);
  unityScale(scale, scratchScale);
  return target.compose(scratchPosition, scratchQuaternion, scratchScale);
}

export function unityVector4(source: UnityVector4Source, target = new Vector4()): Vector4 {
  return target.set(component4(source, 0), component4(source, 1), component4(source, 2), component4(source, 3));
}

/**
 * Converts Unity Color without silently assuming its encoding. Unity Color
 * values are frequently already linear when read from runtime assets; callers
 * must explicitly request sRGB decoding when the source is known to be sRGB.
 */
export function unityColor(
  source: UnityColorSource,
  encoding: UnityColorEncoding = "linear",
  target = new Color(),
): UnityRgba {
  let r: number;
  let g: number;
  let b: number;
  let alpha: number;
  if (Array.isArray(source)) {
    r = finite(source[0]);
    g = finite(source[1]);
    b = finite(source[2]);
    alpha = finite(source[3] ?? 1, 1);
  } else {
    const value = source as UnityColorLike;
    r = finite(value.r);
    g = finite(value.g);
    b = finite(value.b);
    alpha = finite(value.a ?? 1, 1);
  }
  target.setRGB(r, g, b);
  if (encoding === "srgb") target.convertSRGBToLinear();
  return { color: target, alpha };
}

/** Reads Unity Color32 bytes without changing their color encoding. */
export function unityColor32(
  red: number,
  green: number,
  blue: number,
  alpha = 255,
  encoding: UnityColorEncoding = "srgb",
  target = new Color(),
): UnityRgba {
  const byte = (value: number): number => Math.max(0, Math.min(255, Math.round(finite(value)))) / 255;
  return unityColor([byte(red), byte(green), byte(blue), byte(alpha)], encoding, target);
}
