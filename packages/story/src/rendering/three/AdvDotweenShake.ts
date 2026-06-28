import type { Vec2, Vec3 } from "./StorySceneTypes";

export interface AdvDotweenShakePath {
  readonly points: readonly Vec3[];
  readonly cumulativeDurations: readonly number[];
}

interface AdvDotweenShakeOptions {
  readonly duration: number;
  readonly strength: number;
  readonly vibrato: number;
  readonly randomness: number;
  readonly fadeOut: boolean;
  /** Field uses the Vector3 overload; Still/Talk use the scalar overload. */
  readonly vectorBased: boolean;
  readonly random?: () => number;
}

const ZERO: Readonly<Vec3> = { x: 0, y: 0, z: 0 };
const DEG_TO_RAD = Math.PI / 180;

function finite(value: unknown, fallback = 0): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function magnitude(value: Vec3): number {
  return Math.hypot(value.x, value.y, value.z);
}

function multiply(value: Vec3, scalar: number): Vec3 {
  return { x: value.x * scalar, y: value.y * scalar, z: value.z * scalar };
}

function clampMagnitude(value: Vec3, maximum: number): Vec3 {
  const length = magnitude(value);
  if (length <= Math.abs(maximum) || length <= Number.EPSILON) return { ...value };
  return multiply(value, maximum / length);
}

function normalizeTo(value: Vec3, length: number): Vec3 {
  const current = magnitude(value);
  return current <= Number.EPSILON ? { ...ZERO } : multiply(value, length / current);
}

function randomRange(random: () => number, minimum: number, maximum: number): number {
  return minimum + (maximum - minimum) * random();
}

function vectorFromAngle(degrees: number, length: number): Vec3 {
  const radians = degrees * DEG_TO_RAD;
  return { x: length * Math.cos(radians), y: length * Math.sin(radians), z: 0 };
}

/** Quaternion.AngleAxis(degrees, Vector3.up) multiplied by a Vector3. */
function rotateAroundY(value: Vec3, degrees: number): Vec3 {
  const radians = degrees * DEG_TO_RAD;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  return {
    x: value.x * cosine + value.z * sine,
    y: value.y,
    z: -value.x * sine + value.z * cosine,
  };
}

/**
 * DOTween.Shake path generation used by DOShakePosition in the original ADV.
 * The path is relative to the transform's startup position and always ends at
 * zero. RandomnessMode.Full is the only mode authored by AdvShakeCommand.
 */
export function createAdvDotweenShakePath(options: AdvDotweenShakeOptions): AdvDotweenShakePath {
  const duration = Math.max(0, finite(options.duration));
  if (duration <= 0) return { points: [ZERO], cumulativeDurations: [1] };

  const random = options.random || Math.random;
  const vibrato = Math.trunc(finite(options.vibrato, 10));
  const iterations = Math.max(2, Math.trunc(vibrato * duration));
  const randomness = finite(options.randomness, 90);
  const signedStrength = finite(options.strength);
  let strength: Vec3 = options.vectorBased
    ? { x: signedStrength, y: signedStrength, z: 0 }
    : { x: signedStrength, y: signedStrength, z: signedStrength };
  let shakeMagnitude = options.vectorBased ? magnitude(strength) : strength.x;
  const decayPerSegment = shakeMagnitude / iterations;
  let angle = randomRange(random, 0, 360);
  const points: Vec3[] = [];

  for (let index = 0; index < iterations; index += 1) {
    if (index === iterations - 1) {
      points.push({ ...ZERO });
      continue;
    }
    if (index > 0) {
      angle = angle - 180 + randomRange(random, -randomness, randomness);
    }
    if (options.vectorBased) {
      const rotation = randomRange(random, -randomness, randomness);
      const limited = rotateAroundY(vectorFromAngle(angle, shakeMagnitude), rotation);
      // DOTween performs these three ClampMagnitude/component assignments in
      // sequence; each axis therefore observes the preceding clamp.
      limited.x = clampMagnitude(limited, strength.x).x;
      limited.y = clampMagnitude(limited, strength.y).y;
      limited.z = clampMagnitude(limited, strength.z).z;
      points.push(normalizeTo(limited, shakeMagnitude));
      if (options.fadeOut) shakeMagnitude -= decayPerSegment;
      strength = clampMagnitude(strength, shakeMagnitude);
    } else {
      // DOShakeAnchorPos's scalar overload forwards ignoreZAxis=true. It uses
      // the 2D angle directly and neither consumes nor applies a Y rotation.
      points.push(vectorFromAngle(angle, shakeMagnitude));
      if (options.fadeOut) shakeMagnitude -= decayPerSegment;
    }
  }

  let durationWeightSum = 0;
  const durationWeights = new Array<number>(iterations);
  for (let index = 0; index < iterations; index += 1) {
    const weight = options.fadeOut ? index + 1 : 1;
    durationWeights[index] = weight;
    durationWeightSum += weight;
  }
  let cumulative = 0;
  const cumulativeDurations = durationWeights.map((weight, index) => {
    cumulative += weight / durationWeightSum;
    return index === iterations - 1 ? 1 : cumulative;
  });
  return { points, cumulativeDurations };
}

/** Vector3ArrayPlugin with Ease.Linear, sampled in normalized tween time. */
export function sampleAdvDotweenShake(path: AdvDotweenShakePath, progress: number): Vec2 {
  const clamped = Math.max(0, Math.min(1, finite(progress)));
  let segment = path.cumulativeDurations.findIndex((end) => clamped <= end);
  if (segment < 0) segment = path.points.length - 1;
  const segmentStart = segment > 0 ? path.cumulativeDurations[segment - 1]! : 0;
  const segmentEnd = path.cumulativeDurations[segment] ?? 1;
  const segmentProgress =
    segmentEnd <= segmentStart ? 1 : Math.max(0, Math.min(1, (clamped - segmentStart) / (segmentEnd - segmentStart)));
  const from = segment > 0 ? path.points[segment - 1]! : ZERO;
  const to = path.points[segment] || ZERO;
  return {
    x: from.x + (to.x - from.x) * segmentProgress,
    y: from.y + (to.y - from.y) * segmentProgress,
  };
}
