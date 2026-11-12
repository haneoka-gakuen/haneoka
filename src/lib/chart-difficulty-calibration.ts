import type { DifficultyCalibration } from "./chart-difficulty";

/** Fitted to every intl chart's official level (all four slots) by least absolute deviation along a rising curve, with
 * player-confirmed levels in place of the official ones for God's Blood, mugamuchu, Abracadabra and Wonder of the
 * Universe (Expert). */
export const OUR_NOTES_FC_CALIBRATION: Readonly<DifficultyCalibration> = {
  version: "ournotes-fc-threshold-v7",
  kind: "lad-slot-quadratic-fc-skill",
  offsets: [-14.409676654813799, -11.294413333316214, -9.02333007243022, -5.462310760876148],
  coefficients: [6.128480822387341, -0.20913438657924946],
  skillRange: [3.417225612010215, 7.789449426723127],
  trainingSongs: 96,
  trainingCharts: 384,
};
