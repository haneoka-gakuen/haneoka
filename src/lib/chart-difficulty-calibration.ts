import type { DifficultyCalibration } from "./chart-difficulty";

/** Limited current-source global scale with structural validation; no player accuracy fit. */
export const OUR_NOTES_FC_CALIBRATION: Readonly<DifficultyCalibration> = {
  version: "ournotes-fc-operation-v3",
  kind: "theil-sen-operation-skills-v3",
  canonicalConverterSha256:
    "f8b473d7e376c8a04c782587a3ba52085a6c89a53e5f82dd0d5a0aa68561d9f9",
  algorithmSha256:
    "727705acbe3f6f20acb94b45e2e02fdff4344d3407ae643c38aa3a4ac304a3a8",
  featureProfileSha256:
    "69c2f80cf55fa0705ef51a83a33729f1c289230296e0cf8a347188a57c729929",
  slope: 13.964774040674929,
  intercept: -4.660006202066066,
  xRange: [1.190367260269811, 2.328532889045462],
  rateWeight: 0.7,
  strainWeight: 0.3,
  burstWeight: 0.3,
  trainingSongs: 6,
  trainingCharts: 12,
  sha256: "51e6e168905d4b9fe355a671b2802e360f7e4835b2032bef8e697b5780d14969",
};
