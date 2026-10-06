/** Native numeric conversions: binary32 arithmetic and saturating integer casts, as the client computes them. */
export const f = Math.fround;
export const I32_MIN = -2147483648;
export const I32_MAX = 2147483647;

/** `x as i32`: truncation with saturation, NaN → 0. */
export function satI32(x: number): number {
  if (Number.isNaN(x)) return 0;
  if (x >= I32_MAX) return I32_MAX;
  if (x <= I32_MIN) return I32_MIN;
  return Math.trunc(x);
}
/** Floor to i32; +∞ gives `i32::MIN`. */
export function floorToI32(x: number): number {
  if (x === Infinity) return I32_MIN;
  const t = satI32(x);
  return t !== I32_MIN && f(t) > x ? t - 1 : t;
}
export function floorToI32F64(x: number): number {
  if (x === Infinity) return I32_MIN;
  const t = satI32(x);
  return t !== I32_MIN && t > x ? t - 1 : t;
}
/** Ceil to i32; ±∞ gives `i32::MIN`. */
export function ceilToI32(x: number): number {
  if (x === Infinity || x === -Infinity) return I32_MIN;
  const t = satI32(x);
  return t !== I32_MAX && f(t) < x ? t + 1 : t;
}
export function roundTiesEven(x: number): number {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}
export function minIgnoringNaN(a: number, b: number): number {
  if (Number.isNaN(a)) return b;
  if (Number.isNaN(b)) return a;
  if (a === b) return Object.is(a, -0) ? a : b;
  return a < b ? a : b;
}
/** Signed division and remainder that treat a zero divisor as 0, wrapping like the client. */
export const sdiv = (a: number, b: number) => (b === 0 ? 0 : (a / b) | 0);
export const srem = (a: number, b: number) => (a - Math.imul(sdiv(a, b), b)) | 0;

/** Frame of a music time for the score and life logs: 0 below 0 ms, else `ceil(ms / 40f)`. */
export const getFrame = (ms: number) => (ms < 0 ? 0 : ceilToI32(f(f(ms) / 40)));
