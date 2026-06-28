import type {
  UnityAnimationCurve,
  UnityColor,
  UnityGradient,
  UnityMinMaxCurve,
  UnityMinMaxGradient,
  UnityStreamedCurveSegment,
} from "./UnityParticleTypes";

export interface ReadonlyVector3Like {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface MutableVector3Like {
  x: number;
  y: number;
  z: number;
}

export interface MutableVector2Like {
  x: number;
  y: number;
}

export interface UnityCurlNoiseScratch {
  readonly first: MutableVector2Like;
  readonly second: MutableVector2Like;
  readonly third: MutableVector2Like;
}

const UNITY_RANDOM_MULTIPLIER = 0x6c078965;
const UNITY_RANDOM_VALUE_SCALE = Math.fround(1 / 0x7fffff);
const UNITY_NOISE_MIN_FREQUENCY = Math.fround(0.000001);
const UNITY_NOISE_SQRT_TWO = Math.fround(1.4142135381698608);
const UNITY_NOISE_DIAGONAL = Math.fround(0.7071067690849304);

// This 256-entry permutation is stored twice. Every value 0..255 occurs
// exactly once.
const UNITY_NOISE_PERMUTATION = new Uint8Array([
  151, 160, 137, 91, 90, 15, 131, 13, 201, 95, 96, 53, 194, 233, 7, 225, 140, 36, 103, 30, 69, 142, 8, 99, 37, 240, 21,
  10, 23, 190, 6, 148, 247, 120, 234, 75, 0, 26, 197, 62, 94, 252, 219, 203, 117, 35, 11, 32, 57, 177, 33, 88, 237, 149,
  56, 87, 174, 20, 125, 136, 171, 168, 68, 175, 74, 165, 71, 134, 139, 48, 27, 166, 77, 146, 158, 231, 83, 111, 229,
  122, 60, 211, 133, 230, 220, 105, 92, 41, 55, 46, 245, 40, 244, 102, 143, 54, 65, 25, 63, 161, 1, 216, 80, 73, 209,
  76, 132, 187, 208, 89, 18, 169, 200, 196, 135, 130, 116, 188, 159, 86, 164, 100, 109, 198, 173, 186, 3, 64, 52, 217,
  226, 250, 124, 123, 5, 202, 38, 147, 118, 126, 255, 82, 85, 212, 207, 206, 59, 227, 47, 16, 58, 17, 182, 189, 28, 42,
  223, 183, 170, 213, 119, 248, 152, 2, 44, 154, 163, 70, 221, 153, 101, 155, 167, 43, 172, 9, 129, 22, 39, 253, 19, 98,
  108, 110, 79, 113, 224, 232, 178, 185, 112, 104, 218, 246, 97, 228, 251, 34, 242, 193, 238, 210, 144, 12, 191, 179,
  162, 241, 81, 51, 145, 235, 249, 14, 239, 107, 49, 192, 214, 31, 181, 199, 106, 157, 184, 84, 204, 176, 115, 121, 50,
  45, 127, 4, 150, 254, 138, 236, 205, 93, 222, 114, 67, 29, 24, 72, 243, 141, 128, 195, 78, 66, 215, 61, 156, 180,
]);

// Exact eight vec2 entries used by the Medium ParticleSystem noise kernel.
const UNITY_NOISE_GRADIENT_X = new Float32Array([
  1,
  -1,
  0,
  0,
  UNITY_NOISE_DIAGONAL,
  -UNITY_NOISE_DIAGONAL,
  UNITY_NOISE_DIAGONAL,
  -UNITY_NOISE_DIAGONAL,
]);
const UNITY_NOISE_GRADIENT_Y = new Float32Array([
  0,
  0,
  1,
  -1,
  UNITY_NOISE_DIAGONAL,
  UNITY_NOISE_DIAGONAL,
  -UNITY_NOISE_DIAGONAL,
  -UNITY_NOISE_DIAGONAL,
]);

// Exact 1D and 3D gradient tables.
const UNITY_NOISE_GRADIENT_1 = new Float32Array([1, -1]);
const UNITY_NOISE_GRADIENT_3_X = new Float32Array([1, -1, 1, -1, 1, -1, 1, -1, 0, 0, 0, 0, 1, -1, 0, 0]);
const UNITY_NOISE_GRADIENT_3_Y = new Float32Array([1, 1, -1, -1, 0, 0, 0, 0, 1, -1, 1, -1, 1, 1, -1, -1]);
const UNITY_NOISE_GRADIENT_3_Z = new Float32Array([0, 0, 0, 0, 1, 1, -1, -1, 1, 1, -1, -1, 0, 0, 1, -1]);

export class UnityRandom {
  private s0: number;
  private s1: number;
  private s2: number;
  private s3: number;

  constructor(seed: number) {
    // Unity 6000.3's native ParticleSystem jobs use the same four-word
    // xorshift state as UnityEngine.Random. Each lane is initialized with
    // this LCG and then performs the 11/8/19 shifts before converting the
    // low 23 bits.
    this.s0 = Math.trunc(seed) >>> 0;
    this.s1 = (Math.imul(this.s0, UNITY_RANDOM_MULTIPLIER) + 1) >>> 0;
    this.s2 = (Math.imul(this.s1, UNITY_RANDOM_MULTIPLIER) + 1) >>> 0;
    this.s3 = (Math.imul(this.s2, UNITY_RANDOM_MULTIPLIER) + 1) >>> 0;
  }

  next(): number {
    const temporary = (this.s0 ^ (this.s0 << 11)) >>> 0;
    const next = (temporary ^ this.s3 ^ (temporary >>> 8) ^ (this.s3 >>> 19)) >>> 0;
    this.s0 = this.s1;
    this.s1 = this.s2;
    this.s2 = this.s3;
    this.s3 = next;
    return Math.fround(Math.fround(next & 0x7fffff) * UNITY_RANDOM_VALUE_SCALE);
  }

  signed(): number {
    return Math.fround(Math.fround(this.next() * 2) - 1);
  }
}

/** Writes the three system-wide offsets consumed by native ParticleSystem noise jobs. */
export function writeUnityParticleNoiseFieldOffset(seed: number, target: MutableVector3Like): void {
  const random = new UnityRandom(seed);
  target.x = f32Multiply(random.next(), 100);
  target.y = f32Multiply(random.next(), 100);
  target.z = f32Multiply(random.next(), 100);
}

function f32Add(left: number, right: number): number {
  return Math.fround(Math.fround(left) + Math.fround(right));
}

function f32Subtract(left: number, right: number): number {
  return Math.fround(Math.fround(left) - Math.fround(right));
}

function f32Multiply(left: number, right: number): number {
  return Math.fround(Math.fround(left) * Math.fround(right));
}

function f32Lerp(left: number, right: number, amount: number): number {
  return f32Add(left, f32Multiply(amount, f32Subtract(right, left)));
}

function unityNoiseFade(value: number): number {
  const square = f32Multiply(value, value);
  const cube = f32Multiply(value, square);
  const polynomial = f32Add(f32Multiply(value, f32Add(f32Multiply(value, 6), -15)), 10);
  return f32Multiply(cube, polynomial);
}

function unityNoiseFadeDerivative(value: number): number {
  const inner = f32Add(f32Multiply(value, f32Add(value, -2)), 1);
  return f32Multiply(f32Multiply(value, f32Multiply(value, 30)), inner);
}

function unityNoiseGradientIndex(x: number, y: number): number {
  return UNITY_NOISE_PERMUTATION[(UNITY_NOISE_PERMUTATION[x & 0xff] + (y & 0xff)) & 0xff] & 7;
}

function unityNoiseGradient3Index(x: number, y: number, z: number): number {
  const xy = UNITY_NOISE_PERMUTATION[(UNITY_NOISE_PERMUTATION[x & 0xff] + (y & 0xff)) & 0xff];
  return UNITY_NOISE_PERMUTATION[(xy + (z & 0xff)) & 0xff] & 15;
}

function unityNoiseDot(gradient: number, x: number, y: number): number {
  return f32Add(f32Multiply(UNITY_NOISE_GRADIENT_X[gradient], x), f32Multiply(UNITY_NOISE_GRADIENT_Y[gradient], y));
}

function unityNoiseDot3(gradient: number, x: number, y: number, z: number): number {
  return f32Add(
    f32Add(f32Multiply(UNITY_NOISE_GRADIENT_3_X[gradient], x), f32Multiply(UNITY_NOISE_GRADIENT_3_Y[gradient], y)),
    f32Multiply(UNITY_NOISE_GRADIENT_3_Z[gradient], z),
  );
}

/** Writes the derivative produced by Unity's vectorized 1D Low-quality helper. */
export function unityParticlePerlin1Derivative(x: number, frequency: number): number {
  const safeFrequency = Math.max(UNITY_NOISE_MIN_FREQUENCY, Math.fround(frequency));
  const scaledX = f32Multiply(x, safeFrequency);
  const floorX = Math.floor(scaledX);
  const localX = f32Subtract(scaledX, floorX);
  const gradient0 = UNITY_NOISE_GRADIENT_1[UNITY_NOISE_PERMUTATION[floorX & 0xff] & 1];
  const gradient1 = UNITY_NOISE_GRADIENT_1[UNITY_NOISE_PERMUTATION[(floorX + 1) & 0xff] & 1];
  const noise0 = f32Multiply(gradient0, localX);
  const noise1 = f32Multiply(gradient1, f32Add(localX, -1));
  const derivative = f32Add(
    f32Lerp(gradient0, gradient1, unityNoiseFade(localX)),
    f32Multiply(unityNoiseFadeDerivative(localX), f32Subtract(noise1, noise0)),
  );
  return f32Multiply(derivative, f32Multiply(safeFrequency, 2));
}

/**
 * Writes the two analytic derivatives produced by Unity's vectorized 2D
 * ParticleSystem Perlin kernel. Inputs are unscaled noise coordinates; the
 * native helper applies frequency internally and returns d/dx and d/dy.
 */
export function writeUnityParticlePerlin2Derivatives(
  x: number,
  y: number,
  frequency: number,
  target: MutableVector2Like,
): void {
  const safeFrequency = Math.max(UNITY_NOISE_MIN_FREQUENCY, Math.fround(frequency));
  const scaledX = f32Multiply(x, safeFrequency);
  const scaledY = f32Multiply(y, safeFrequency);
  const floorX = Math.floor(scaledX);
  const floorY = Math.floor(scaledY);
  const localX = f32Subtract(scaledX, floorX);
  const localY = f32Subtract(scaledY, floorY);
  const localXMinusOne = f32Add(localX, -1);
  const localYMinusOne = f32Add(localY, -1);

  const gradient00 = unityNoiseGradientIndex(floorX, floorY);
  const gradient10 = unityNoiseGradientIndex(floorX + 1, floorY);
  const gradient01 = unityNoiseGradientIndex(floorX, floorY + 1);
  const gradient11 = unityNoiseGradientIndex(floorX + 1, floorY + 1);
  const noise00 = unityNoiseDot(gradient00, localX, localY);
  const noise10 = unityNoiseDot(gradient10, localXMinusOne, localY);
  const noise01 = unityNoiseDot(gradient01, localX, localYMinusOne);
  const noise11 = unityNoiseDot(gradient11, localXMinusOne, localYMinusOne);
  const fadeX = unityNoiseFade(localX);
  const fadeY = unityNoiseFade(localY);
  const fadeDerivativeX = unityNoiseFadeDerivative(localX);
  const fadeDerivativeY = unityNoiseFadeDerivative(localY);

  const lowerNoise = f32Add(noise00, f32Multiply(fadeX, f32Subtract(noise10, noise00)));
  const upperNoise = f32Add(noise01, f32Multiply(fadeX, f32Subtract(noise11, noise01)));
  const lowerDerivativeX = f32Add(
    f32Add(
      UNITY_NOISE_GRADIENT_X[gradient00],
      f32Multiply(fadeX, f32Subtract(UNITY_NOISE_GRADIENT_X[gradient10], UNITY_NOISE_GRADIENT_X[gradient00])),
    ),
    f32Multiply(fadeDerivativeX, f32Subtract(noise10, noise00)),
  );
  const upperDerivativeX = f32Add(
    f32Add(
      UNITY_NOISE_GRADIENT_X[gradient01],
      f32Multiply(fadeX, f32Subtract(UNITY_NOISE_GRADIENT_X[gradient11], UNITY_NOISE_GRADIENT_X[gradient01])),
    ),
    f32Multiply(fadeDerivativeX, f32Subtract(noise11, noise01)),
  );
  const lowerDerivativeY = f32Add(
    UNITY_NOISE_GRADIENT_Y[gradient00],
    f32Multiply(fadeX, f32Subtract(UNITY_NOISE_GRADIENT_Y[gradient10], UNITY_NOISE_GRADIENT_Y[gradient00])),
  );
  const upperDerivativeY = f32Add(
    UNITY_NOISE_GRADIENT_Y[gradient01],
    f32Multiply(fadeX, f32Subtract(UNITY_NOISE_GRADIENT_Y[gradient11], UNITY_NOISE_GRADIENT_Y[gradient01])),
  );
  const derivativeX = f32Add(lowerDerivativeX, f32Multiply(fadeY, f32Subtract(upperDerivativeX, lowerDerivativeX)));
  const derivativeY = f32Add(
    f32Add(lowerDerivativeY, f32Multiply(fadeY, f32Subtract(upperDerivativeY, lowerDerivativeY))),
    f32Multiply(fadeDerivativeY, f32Subtract(upperNoise, lowerNoise)),
  );
  const derivativeScale = f32Multiply(safeFrequency, UNITY_NOISE_SQRT_TWO);
  target.x = f32Multiply(derivativeX, derivativeScale);
  target.y = f32Multiply(derivativeY, derivativeScale);
}

/**
 * Writes the first two analytic derivatives produced by Unity's vectorized
 * 3D High-quality helper. Callers permute XYZ so these are the two curl terms
 * needed for each potential field.
 */
export function writeUnityParticlePerlin3Derivatives(
  x: number,
  y: number,
  z: number,
  frequency: number,
  target: MutableVector2Like,
): void {
  const safeFrequency = Math.max(UNITY_NOISE_MIN_FREQUENCY, Math.fround(frequency));
  const scaledX = f32Multiply(x, safeFrequency);
  const scaledY = f32Multiply(y, safeFrequency);
  const scaledZ = f32Multiply(z, safeFrequency);
  const floorX = Math.floor(scaledX);
  const floorY = Math.floor(scaledY);
  const floorZ = Math.floor(scaledZ);
  const localX = f32Subtract(scaledX, floorX);
  const localY = f32Subtract(scaledY, floorY);
  const localZ = f32Subtract(scaledZ, floorZ);
  const localXMinusOne = f32Add(localX, -1);
  const localYMinusOne = f32Add(localY, -1);
  const localZMinusOne = f32Add(localZ, -1);

  const gradient000 = unityNoiseGradient3Index(floorX, floorY, floorZ);
  const gradient100 = unityNoiseGradient3Index(floorX + 1, floorY, floorZ);
  const gradient010 = unityNoiseGradient3Index(floorX, floorY + 1, floorZ);
  const gradient110 = unityNoiseGradient3Index(floorX + 1, floorY + 1, floorZ);
  const gradient001 = unityNoiseGradient3Index(floorX, floorY, floorZ + 1);
  const gradient101 = unityNoiseGradient3Index(floorX + 1, floorY, floorZ + 1);
  const gradient011 = unityNoiseGradient3Index(floorX, floorY + 1, floorZ + 1);
  const gradient111 = unityNoiseGradient3Index(floorX + 1, floorY + 1, floorZ + 1);

  const noise000 = unityNoiseDot3(gradient000, localX, localY, localZ);
  const noise100 = unityNoiseDot3(gradient100, localXMinusOne, localY, localZ);
  const noise010 = unityNoiseDot3(gradient010, localX, localYMinusOne, localZ);
  const noise110 = unityNoiseDot3(gradient110, localXMinusOne, localYMinusOne, localZ);
  const noise001 = unityNoiseDot3(gradient001, localX, localY, localZMinusOne);
  const noise101 = unityNoiseDot3(gradient101, localXMinusOne, localY, localZMinusOne);
  const noise011 = unityNoiseDot3(gradient011, localX, localYMinusOne, localZMinusOne);
  const noise111 = unityNoiseDot3(gradient111, localXMinusOne, localYMinusOne, localZMinusOne);
  const fadeX = unityNoiseFade(localX);
  const fadeY = unityNoiseFade(localY);
  const fadeZ = unityNoiseFade(localZ);
  const fadeDerivativeX = unityNoiseFadeDerivative(localX);
  const fadeDerivativeY = unityNoiseFadeDerivative(localY);

  const noiseX00 = f32Lerp(noise000, noise100, fadeX);
  const noiseX10 = f32Lerp(noise010, noise110, fadeX);
  const noiseX01 = f32Lerp(noise001, noise101, fadeX);
  const noiseX11 = f32Lerp(noise011, noise111, fadeX);
  const derivativeX00 = f32Add(
    f32Lerp(UNITY_NOISE_GRADIENT_3_X[gradient000], UNITY_NOISE_GRADIENT_3_X[gradient100], fadeX),
    f32Multiply(fadeDerivativeX, f32Subtract(noise100, noise000)),
  );
  const derivativeX10 = f32Add(
    f32Lerp(UNITY_NOISE_GRADIENT_3_X[gradient010], UNITY_NOISE_GRADIENT_3_X[gradient110], fadeX),
    f32Multiply(fadeDerivativeX, f32Subtract(noise110, noise010)),
  );
  const derivativeX01 = f32Add(
    f32Lerp(UNITY_NOISE_GRADIENT_3_X[gradient001], UNITY_NOISE_GRADIENT_3_X[gradient101], fadeX),
    f32Multiply(fadeDerivativeX, f32Subtract(noise101, noise001)),
  );
  const derivativeX11 = f32Add(
    f32Lerp(UNITY_NOISE_GRADIENT_3_X[gradient011], UNITY_NOISE_GRADIENT_3_X[gradient111], fadeX),
    f32Multiply(fadeDerivativeX, f32Subtract(noise111, noise011)),
  );
  const derivativeXY0 = f32Lerp(derivativeX00, derivativeX10, fadeY);
  const derivativeXY1 = f32Lerp(derivativeX01, derivativeX11, fadeY);

  const gradientY00 = f32Lerp(UNITY_NOISE_GRADIENT_3_Y[gradient000], UNITY_NOISE_GRADIENT_3_Y[gradient100], fadeX);
  const gradientY10 = f32Lerp(UNITY_NOISE_GRADIENT_3_Y[gradient010], UNITY_NOISE_GRADIENT_3_Y[gradient110], fadeX);
  const gradientY01 = f32Lerp(UNITY_NOISE_GRADIENT_3_Y[gradient001], UNITY_NOISE_GRADIENT_3_Y[gradient101], fadeX);
  const gradientY11 = f32Lerp(UNITY_NOISE_GRADIENT_3_Y[gradient011], UNITY_NOISE_GRADIENT_3_Y[gradient111], fadeX);
  const derivativeY0 = f32Add(
    f32Lerp(gradientY00, gradientY10, fadeY),
    f32Multiply(fadeDerivativeY, f32Subtract(noiseX10, noiseX00)),
  );
  const derivativeY1 = f32Add(
    f32Lerp(gradientY01, gradientY11, fadeY),
    f32Multiply(fadeDerivativeY, f32Subtract(noiseX11, noiseX01)),
  );

  target.x = f32Multiply(f32Lerp(derivativeXY0, derivativeXY1, fadeZ), safeFrequency);
  target.y = f32Multiply(f32Lerp(derivativeY0, derivativeY1, fadeZ), safeFrequency);
}

function unityFractalPerlin1Derivative(
  x: number,
  frequency: number,
  octaves: number,
  octaveMultiplier: number,
  octaveScale: number,
): number {
  let octaveFrequency = Math.max(UNITY_NOISE_MIN_FREQUENCY, Math.fround(frequency));
  let amplitude = Math.fround(1);
  let amplitudeSum = Math.fround(1);
  let derivative = unityParticlePerlin1Derivative(x, octaveFrequency);
  for (let octave = 1; octave < Math.max(1, Math.trunc(octaves)); octave += 1) {
    octaveFrequency = f32Multiply(octaveFrequency, octaveScale);
    amplitude = f32Multiply(amplitude, octaveMultiplier);
    amplitudeSum = f32Add(amplitudeSum, amplitude);
    derivative = f32Add(derivative, f32Multiply(unityParticlePerlin1Derivative(x, octaveFrequency), amplitude));
  }
  return Math.fround(derivative / amplitudeSum);
}

function writeUnityFractalPerlin2Derivatives(
  x: number,
  y: number,
  frequency: number,
  octaves: number,
  octaveMultiplier: number,
  octaveScale: number,
  target: MutableVector2Like,
): void {
  let octaveFrequency = Math.max(UNITY_NOISE_MIN_FREQUENCY, Math.fround(frequency));
  let amplitude = Math.fround(1);
  let amplitudeSum = Math.fround(1);
  writeUnityParticlePerlin2Derivatives(x, y, octaveFrequency, target);
  let derivativeX = target.x;
  let derivativeY = target.y;
  for (let octave = 1; octave < Math.max(1, Math.trunc(octaves)); octave += 1) {
    octaveFrequency = f32Multiply(octaveFrequency, octaveScale);
    amplitude = f32Multiply(amplitude, octaveMultiplier);
    amplitudeSum = f32Add(amplitudeSum, amplitude);
    writeUnityParticlePerlin2Derivatives(x, y, octaveFrequency, target);
    derivativeX = f32Add(derivativeX, f32Multiply(target.x, amplitude));
    derivativeY = f32Add(derivativeY, f32Multiply(target.y, amplitude));
  }
  target.x = Math.fround(derivativeX / amplitudeSum);
  target.y = Math.fround(derivativeY / amplitudeSum);
}

function writeUnityFractalPerlin3Derivatives(
  x: number,
  y: number,
  z: number,
  frequency: number,
  octaves: number,
  octaveMultiplier: number,
  octaveScale: number,
  target: MutableVector2Like,
): void {
  let octaveFrequency = Math.max(UNITY_NOISE_MIN_FREQUENCY, Math.fround(frequency));
  let amplitude = Math.fround(1);
  let amplitudeSum = Math.fround(1);
  writeUnityParticlePerlin3Derivatives(x, y, z, octaveFrequency, target);
  let derivativeX = target.x;
  let derivativeY = target.y;
  for (let octave = 1; octave < Math.max(1, Math.trunc(octaves)); octave += 1) {
    octaveFrequency = f32Multiply(octaveFrequency, octaveScale);
    amplitude = f32Multiply(amplitude, octaveMultiplier);
    amplitudeSum = f32Add(amplitudeSum, amplitude);
    writeUnityParticlePerlin3Derivatives(x, y, z, octaveFrequency, target);
    derivativeX = f32Add(derivativeX, f32Multiply(target.x, amplitude));
    derivativeY = f32Add(derivativeY, f32Multiply(target.y, amplitude));
  }
  target.x = Math.fround(derivativeX / amplitudeSum);
  target.y = Math.fround(derivativeY / amplitudeSum);
}

/**
 * Reconstructs Unity's Low-quality 1D derivative field and axis shuffle.
 */
export function writeUnityLowQualityCurlNoise(
  position: ReadonlyVector3Like,
  fieldOffset: ReadonlyVector3Like,
  scroll: number,
  frequency: number,
  octaves: number,
  octaveMultiplier: number,
  octaveScale: number,
  target: MutableVector3Like,
): void {
  const x = f32Add(position.x, fieldOffset.x);
  const y = f32Add(position.y, fieldOffset.y);
  const z = f32Add(position.z, fieldOffset.z);
  const fieldScroll = Math.fround(scroll);
  const derivativeZ = unityFractalPerlin1Derivative(
    f32Add(z, fieldScroll),
    frequency,
    octaves,
    octaveMultiplier,
    octaveScale,
  );
  const derivativeX = unityFractalPerlin1Derivative(
    f32Add(f32Add(x, 100), fieldScroll),
    frequency,
    octaves,
    octaveMultiplier,
    octaveScale,
  );
  const derivativeY = unityFractalPerlin1Derivative(
    f32Add(y, fieldScroll),
    frequency,
    octaves,
    octaveMultiplier,
    octaveScale,
  );
  target.x = derivativeY;
  target.y = derivativeZ;
  target.z = derivativeX;
}

/**
 * Reconstructs Unity 6000.3's Medium-quality ParticleSystem curl field.
 *
 * Three 2D potential fields are evaluated at `(z,y+scroll)`,
 * `(x+100,z+scroll)`, and `(y,x+100+scroll)`, then their analytic
 * derivatives are combined as a curl.
 * Each field uses the same normalized octave accumulation.
 */
export function writeUnityMediumQualityCurlNoise(
  position: ReadonlyVector3Like,
  fieldOffset: ReadonlyVector3Like,
  scroll: number,
  frequency: number,
  octaves: number,
  octaveMultiplier: number,
  octaveScale: number,
  target: MutableVector3Like,
  scratch: UnityCurlNoiseScratch,
): void {
  const x = f32Add(position.x, fieldOffset.x);
  const y = f32Add(position.y, fieldOffset.y);
  const z = f32Add(position.z, fieldOffset.z);
  const shiftedX = f32Add(x, 100);
  const fieldScroll = Math.fround(scroll);

  writeUnityFractalPerlin2Derivatives(
    z,
    f32Add(y, fieldScroll),
    frequency,
    octaves,
    octaveMultiplier,
    octaveScale,
    scratch.first,
  );
  writeUnityFractalPerlin2Derivatives(
    shiftedX,
    f32Add(z, fieldScroll),
    frequency,
    octaves,
    octaveMultiplier,
    octaveScale,
    scratch.second,
  );
  writeUnityFractalPerlin2Derivatives(
    y,
    f32Add(shiftedX, fieldScroll),
    frequency,
    octaves,
    octaveMultiplier,
    octaveScale,
    scratch.third,
  );

  target.x = f32Subtract(scratch.third.x, scratch.second.y);
  target.y = f32Subtract(scratch.first.x, scratch.third.y);
  target.z = f32Subtract(scratch.second.x, scratch.first.y);
}

/**
 * Reconstructs Unity's High-quality 3D curl field.
 */
export function writeUnityHighQualityCurlNoise(
  position: ReadonlyVector3Like,
  fieldOffset: ReadonlyVector3Like,
  scroll: number,
  frequency: number,
  octaves: number,
  octaveMultiplier: number,
  octaveScale: number,
  target: MutableVector3Like,
  scratch: UnityCurlNoiseScratch,
): void {
  const x = f32Add(position.x, fieldOffset.x);
  const y = f32Add(position.y, fieldOffset.y);
  const z = f32Add(position.z, fieldOffset.z);
  const shiftedX = f32Add(x, 100);
  const fieldScroll = Math.fround(scroll);

  writeUnityFractalPerlin3Derivatives(
    z,
    y,
    f32Add(x, fieldScroll),
    frequency,
    octaves,
    octaveMultiplier,
    octaveScale,
    scratch.first,
  );
  writeUnityFractalPerlin3Derivatives(
    shiftedX,
    z,
    f32Add(y, fieldScroll),
    frequency,
    octaves,
    octaveMultiplier,
    octaveScale,
    scratch.second,
  );
  writeUnityFractalPerlin3Derivatives(
    y,
    shiftedX,
    f32Add(z, fieldScroll),
    frequency,
    octaves,
    octaveMultiplier,
    octaveScale,
    scratch.third,
  );

  target.x = f32Subtract(scratch.third.x, scratch.second.y);
  target.y = f32Subtract(scratch.first.x, scratch.third.y);
  target.z = f32Subtract(scratch.second.x, scratch.first.y);
}

function finite(value: number, fallback = 0): number {
  return Number.isFinite(value) ? value : fallback;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, finite(value)));
}

function lerp(left: number, right: number, amount: number): number {
  return left + (right - left) * amount;
}

/** Applies command playback speed and serialized MainModule.simulationSpeed once each. */
export function unityParticleSimulationDelta(
  deltaSeconds: number,
  playbackSpeed: number,
  serializedSimulationSpeed: number,
): number {
  return (
    Math.max(0, finite(deltaSeconds)) *
    Math.max(0, finite(playbackSpeed, 1)) *
    Math.max(0, finite(serializedSimulationSpeed, 1))
  );
}

function writeColor(target: UnityColor, red: number, green: number, blue: number, alpha: number): UnityColor {
  target.r = red;
  target.g = green;
  target.b = blue;
  target.a = alpha;
  return target;
}

/**
 * Writes a serialized ShapeModule type-4 cone sample after Unity-to-Three
 * handedness conversion. Unity emits the cone around local +Z; C=diag(1,1,-1)
 * therefore maps its base to XY and its forward component to Three -Z.
 */
export function writeUnityConeShapeSample(
  radius: number,
  coneAngleDegrees: number,
  arcDegrees: number,
  angleRandom: number,
  radiusRandom: number,
  position: MutableVector3Like,
  direction: MutableVector3Like,
): void {
  const azimuth = clamp01(angleRandom) * Math.PI * 2 * (Math.max(0, finite(arcDegrees, 360)) / 360);
  const radial = Math.max(0, finite(radius, 1)) * Math.sqrt(clamp01(radiusRandom));
  const coneAngle = (finite(coneAngleDegrees, 25) * Math.PI) / 180;
  const cosine = Math.cos(azimuth);
  const sine = Math.sin(azimuth);
  const coneSine = Math.sin(coneAngle);
  position.x = cosine * radial;
  position.y = sine * radial;
  position.z = 0;
  direction.x = cosine * coneSine;
  direction.y = sine * coneSine;
  direction.z = -Math.cos(coneAngle);
}

/** Writes Unity's SingleSidedEdge line sample and its documented local +Y direction. */
export function writeUnitySingleSidedEdgeShapeSample(
  radius: number,
  positionRandom: number,
  position: MutableVector3Like,
  direction: MutableVector3Like,
): void {
  position.x = (clamp01(positionRandom) * 2 - 1) * Math.max(0, finite(radius, 1));
  position.y = 0;
  position.z = 0;
  direction.x = 0;
  direction.y = 1;
  direction.z = 0;
}

/** Writes the world-Y-constrained basis used by Unity VerticalBillboard. */
export function writeUnityVerticalBillboardAxes(
  cameraPosition: ReadonlyVector3Like,
  particleCenter: ReadonlyVector3Like,
  right: MutableVector3Like,
  up: MutableVector3Like,
  forward: MutableVector3Like,
): void {
  let forwardX = finite(cameraPosition.x) - finite(particleCenter.x);
  let forwardZ = finite(cameraPosition.z) - finite(particleCenter.z);
  const lengthSquared = forwardX * forwardX + forwardZ * forwardZ;
  if (lengthSquared <= 1e-8) {
    forwardX = 0;
    forwardZ = 1;
  } else {
    const inverseLength = 1 / Math.sqrt(lengthSquared);
    forwardX *= inverseLength;
    forwardZ *= inverseLength;
  }
  forward.x = forwardX;
  forward.y = 0;
  forward.z = forwardZ;
  up.x = 0;
  up.y = 1;
  up.z = 0;
  // cross(worldUp, forward)
  right.x = forwardZ;
  right.y = 0;
  right.z = -forwardX;
}

/** Applies Unity Quaternion.Euler's Z-X-Y order in the reflected Three basis. */
export function writeUnityZxyRotation(
  threeValue: ReadonlyVector3Like,
  radians: ReadonlyVector3Like,
  target: MutableVector3Like,
): void {
  const a = Math.cos(radians.x);
  const b = Math.sin(radians.x);
  const c = Math.cos(radians.y);
  const d = Math.sin(radians.y);
  const e = Math.cos(radians.z);
  const f = Math.sin(radians.z);
  const ce = c * e;
  const cf = c * f;
  const de = d * e;
  const df = d * f;
  const unityX = threeValue.x;
  const unityY = threeValue.y;
  const unityZ = -threeValue.z;
  target.x = (ce - df * b) * unityX - a * f * unityY + (de + cf * b) * unityZ;
  target.y = (cf + de * b) * unityX + a * e * unityY + (df - ce * b) * unityZ;
  target.z = -(-a * d * unityX + b * unityY + a * c * unityZ);
}

/** Stable O(n) compaction used by the live-particle pool. */
export function stableCompactInPlace<Value>(
  values: Value[],
  retain: (value: Value) => boolean,
  removed?: Value[],
): number {
  let writeIndex = 0;
  for (let readIndex = 0; readIndex < values.length; readIndex += 1) {
    const value = values[readIndex];
    if (!retain(value)) {
      removed?.push(value);
      continue;
    }
    values[writeIndex] = value;
    writeIndex += 1;
  }
  values.length = writeIndex;
  return writeIndex;
}

function cubicBezier(left: number, leftHandle: number, rightHandle: number, right: number, amount: number): number {
  const inverse = 1 - amount;
  return (
    inverse * inverse * inverse * left +
    3 * inverse * inverse * amount * leftHandle +
    3 * inverse * amount * amount * rightHandle +
    amount * amount * amount * right
  );
}

function weightedHermite(
  time: number,
  left: UnityAnimationCurve["keys"][number],
  right: UnityAnimationCurve["keys"][number],
): number {
  const duration = right.time - left.time;
  if (duration <= 0) return right.value;
  const leftWeighted = (left.weightedMode & 2) !== 0;
  const rightWeighted = (right.weightedMode & 1) !== 0;
  if (!leftWeighted && !rightWeighted) {
    const amount = clamp01((time - left.time) / duration);
    const square = amount * amount;
    const cube = square * amount;
    return (
      (2 * cube - 3 * square + 1) * left.value +
      (cube - 2 * square + amount) * duration * left.outSlope +
      (-2 * cube + 3 * square) * right.value +
      (cube - square) * duration * right.inSlope
    );
  }

  const leftWeight = leftWeighted ? clamp01(left.outWeight) : 1 / 3;
  const rightWeight = rightWeighted ? clamp01(right.inWeight) : 1 / 3;
  const x1 = left.time + duration * leftWeight;
  const x2 = right.time - duration * rightWeight;
  const y1 = left.value + left.outSlope * duration * leftWeight;
  const y2 = right.value - right.inSlope * duration * rightWeight;
  let low = 0;
  let high = 1;
  for (let iteration = 0; iteration < 18; iteration += 1) {
    const middle = (low + high) * 0.5;
    if (cubicBezier(left.time, x1, x2, right.time, middle) < time) low = middle;
    else high = middle;
  }
  return cubicBezier(left.value, y1, y2, right.value, (low + high) * 0.5);
}

export function evaluateUnityCurve(curve: UnityAnimationCurve, time: number): number {
  const keys = curve.keys;
  if (!keys.length) return 1;
  if (time <= keys[0].time) return keys[0].value;
  const last = keys[keys.length - 1];
  if (time >= last.time) return last.value;
  let low = 0;
  let high = keys.length - 1;
  while (low + 1 < high) {
    const middle = (low + high) >>> 1;
    if (keys[middle].time <= time) low = middle;
    else high = middle;
  }
  return weightedHermite(time, keys[low], keys[high]);
}

export function sampleUnityMinMaxCurve(curve: UnityMinMaxCurve, time: number, random: number): number {
  const amount = clamp01(random);
  switch (curve.mode) {
    case 0:
      return curve.constantMax;
    case 1:
      return evaluateUnityCurve(curve.curveMax, time) * curve.multiplier;
    case 2:
      return (
        lerp(evaluateUnityCurve(curve.curveMin, time), evaluateUnityCurve(curve.curveMax, time), amount) *
        curve.multiplier
      );
    case 3:
      return lerp(curve.constantMin, curve.constantMax, amount);
  }
}

function gradientColorChannel(
  keys: UnityGradient["colorKeys"],
  time: number,
  channel: "r" | "g" | "b",
  fixed: boolean,
): number {
  if (!keys.length) return 1;
  const value = clamp01(time);
  if (value <= keys[0].time) return keys[0].color[channel];
  for (let index = 1; index < keys.length; index += 1) {
    const right = keys[index];
    if (value > right.time) continue;
    const left = keys[index - 1];
    if (fixed || right.time <= left.time) return left.color[channel];
    return lerp(left.color[channel], right.color[channel], (value - left.time) / (right.time - left.time));
  }
  return keys[keys.length - 1].color[channel];
}

function gradientAlphaChannel(keys: UnityGradient["alphaKeys"], time: number, fixed: boolean): number {
  if (!keys.length) return 1;
  const value = clamp01(time);
  if (value <= keys[0].time) return keys[0].alpha;
  for (let index = 1; index < keys.length; index += 1) {
    const right = keys[index];
    if (value > right.time) continue;
    const left = keys[index - 1];
    if (fixed || right.time <= left.time) return left.alpha;
    return lerp(left.alpha, right.alpha, (value - left.time) / (right.time - left.time));
  }
  return keys[keys.length - 1].alpha;
}

export function evaluateUnityGradient(
  gradient: UnityGradient,
  time: number,
  target: UnityColor = { r: 1, g: 1, b: 1, a: 1 },
): UnityColor {
  const fixed = gradient.mode === 1;
  return writeColor(
    target,
    gradientColorChannel(gradient.colorKeys, time, "r", fixed),
    gradientColorChannel(gradient.colorKeys, time, "g", fixed),
    gradientColorChannel(gradient.colorKeys, time, "b", fixed),
    gradientAlphaChannel(gradient.alphaKeys, time, fixed),
  );
}

function mixColor(left: UnityColor, right: UnityColor, amount: number, target: UnityColor): UnityColor {
  return writeColor(
    target,
    lerp(left.r, right.r, amount),
    lerp(left.g, right.g, amount),
    lerp(left.b, right.b, amount),
    lerp(left.a, right.a, amount),
  );
}

export function sampleUnityMinMaxGradient(
  gradient: UnityMinMaxGradient,
  time: number,
  random: number,
  target: UnityColor = { r: 1, g: 1, b: 1, a: 1 },
  scratch: UnityColor = { r: 1, g: 1, b: 1, a: 1 },
): UnityColor {
  const amount = clamp01(random);
  switch (gradient.mode) {
    case 0:
      return writeColor(target, gradient.colorMax.r, gradient.colorMax.g, gradient.colorMax.b, gradient.colorMax.a);
    case 1:
      return evaluateUnityGradient(gradient.gradientMax, time, target);
    case 2:
      return mixColor(gradient.colorMin, gradient.colorMax, amount, target);
    case 3:
      evaluateUnityGradient(gradient.gradientMin, time, target);
      return mixColor(target, evaluateUnityGradient(gradient.gradientMax, time, scratch), amount, target);
    case 4:
      return evaluateUnityGradient(gradient.gradientMax, amount, target);
  }
}

/** Evaluates Unity's streamed-clip polynomial for one scalar binding. */
export function evaluateUnityStreamedCurve(segments: UnityStreamedCurveSegment[], time: number): number {
  if (!segments.length) return 0;
  let segment = segments[0];
  for (let index = 1; index < segments.length && segments[index].time <= time; index += 1) {
    segment = segments[index];
  }
  const elapsed = Math.max(0, time - segment.time);
  const [a, b, c, d] = segment.coefficients;
  return ((a * elapsed + b) * elapsed + c) * elapsed + d;
}

export function multiplyUnityColors(
  left: UnityColor,
  right: UnityColor,
  target: UnityColor = { r: 1, g: 1, b: 1, a: 1 },
): UnityColor {
  return writeColor(target, left.r * right.r, left.g * right.g, left.b * right.b, left.a * right.a);
}
