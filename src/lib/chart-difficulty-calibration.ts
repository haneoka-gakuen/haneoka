import type { DifficultyCalibration } from "./chart-difficulty";

/** Official levels read as lower bounds: the 0.85 quantile of every intl chart's official level (all four slots) for
 * its full-combo skill, along a rising curve, so most charts estimate at or above their official level. */
export const OUR_NOTES_FC_CALIBRATION: Readonly<DifficultyCalibration> = {
  version: "ournotes-fc-threshold-v5",
  kind: "lad-slot-quadratic-fc-skill",
  offsets: [-3.7058431592987056, -0.5578551243253216, 2.339415072121053, 5.056449594258659],
  coefficients: [5.416455925452022, -0.26198694852875837],
  skillRange: [1.9735661338683834, 6.5202788624353865],
  trainingSongs: 89,
  trainingCharts: 349,
};
