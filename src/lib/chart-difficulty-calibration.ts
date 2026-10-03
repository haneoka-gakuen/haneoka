import type { DifficultyCalibration } from "./chart-difficulty";

/** Global scale proxy fitted on 24 song groups; heuristic, without player validation. */
export const OUR_NOTES_FC_CALIBRATION: Readonly<DifficultyCalibration> = {
  kind: "theil-sen-blend-log1p",
  slope: 14.250866266606018,
  intercept: -4.590264247175792,
  trainingSongs: 24,
  trainingCharts: 85,
  xRange: [0.6785251898544711, 2.281959026009871],
  rateWeight: 0.7,
  strainWeight: 0.3,
  version: "ournotes-fc-strain-v1",
  canonicalConverterSha256: "f8b473d7e376c8a04c782587a3ba52085a6c89a53e5f82dd0d5a0aa68561d9f9",
  sha256: "10ff2e1660d02a1f0ddecc818b14b6f0742341de947f083d472553c11657aaed",
};
