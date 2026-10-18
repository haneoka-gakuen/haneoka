import type { DifficultyCalibration } from "./chart-difficulty";

/** Fitted to every intl chart's official level (all four slots) by least absolute deviation along a rising curve, with
 * player-confirmed levels in place of the official ones for God's Blood, mugamuchu, Abracadabra and Wonder of the
 * Universe (Expert). */
export const OUR_NOTES_FC_CALIBRATION: Readonly<DifficultyCalibration> = {
  version: "ournotes-fc-threshold-v6",
  kind: "lad-slot-quadratic-fc-skill",
  offsets: [-19.47189753404222, -17.152195462349027, -15.406105295647567, -12.771988707110154],
  coefficients: [7.7637832903937065, -0.2928728928347437],
  skillRange: [3.417225612010215, 7.689609551514696],
  trainingSongs: 89,
  trainingCharts: 353,
};
