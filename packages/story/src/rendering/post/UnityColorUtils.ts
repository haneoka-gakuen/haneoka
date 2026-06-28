// UnityEngine.Rendering.ColorUtils: StandardIlluminantY, CIExyToLMS and
// ColorBalanceToLMSCoeffs ported to TypeScript.

export type UnityLmsCoefficients = readonly [number, number, number];

const D65_LMS: UnityLmsCoefficients = [0.949237, 1.03542, 1.08728];

const LINEAR_TO_LMS = [
  [0.390405, 0.549941, 0.00892632],
  [0.0708416, 0.963172, 0.00135775],
  [0.0231082, 0.128021, 0.936245],
] as const;

const LMS_TO_LINEAR = [
  [2.85847, -1.62879, -0.024891],
  [-0.210182, 1.1582, 0.000324281],
  [-0.041812, -0.118169, 1.06867],
] as const;

export function unityStandardIlluminantY(x: number): number {
  return 2.87 * x - 3 * x * x - 0.27509507;
}

export function unityCieXyToLms(x: number, y: number): UnityLmsCoefficients {
  const safeY = Math.abs(y) > Number.EPSILON ? y : Number.EPSILON;
  const X = x / safeY;
  const Z = (1 - x - y) / safeY;
  return [0.7328 * X + 0.4296 - 0.1624 * Z, -0.7036 * X + 1.6975 + 0.0061 * Z, 0.003 * X + 0.0136 + 0.9834 * Z];
}

export function unityColorBalanceToLmsCoefficients(temperature: number, tint: number): UnityLmsCoefficients {
  const t1 = (Number.isFinite(temperature) ? temperature : 0) / 65;
  const t2 = (Number.isFinite(tint) ? tint : 0) / 65;
  const x = 0.31271 - t1 * (t1 < 0 ? 0.1 : 0.05);
  const y = unityStandardIlluminantY(x) + t2 * 0.05;
  const target = unityCieXyToLms(x, y);
  return [D65_LMS[0] / target[0], D65_LMS[1] / target[1], D65_LMS[2] / target[2]];
}

function multiply3(a: readonly (readonly number[])[], b: readonly (readonly number[])[]): number[][] {
  return a.map((row) =>
    [0, 1, 2].map((column) => row.reduce((sum, value, index) => sum + value * b[index][column], 0)),
  );
}

export function unityWhiteBalanceColorMatrix(temperature: number, tint: number): number[] {
  const balance = unityColorBalanceToLmsCoefficients(temperature, tint);
  const balancedLms = LINEAR_TO_LMS.map((row, index) => row.map((value) => value * balance[index]));
  const rgb = multiply3(LMS_TO_LINEAR, balancedLms);
  return [
    rgb[0][0],
    rgb[0][1],
    rgb[0][2],
    0,
    0,
    rgb[1][0],
    rgb[1][1],
    rgb[1][2],
    0,
    0,
    rgb[2][0],
    rgb[2][1],
    rgb[2][2],
    0,
    0,
    0,
    0,
    0,
    1,
    0,
  ];
}
