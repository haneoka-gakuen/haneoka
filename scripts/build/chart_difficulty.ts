import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import type { ChartDocument } from "@haneoka/cassiopeia";
import type { ChartDifficultyEstimate, DifficultyCalibration, ChartDifficultyInput } from "../../src/lib/chart-difficulty";

interface ChartInput {
  path: string;
  sha256: string;
  masterJudgedCount: number | null;
}
interface Request {
  schema: "haneoka-chart-difficulty-build-v1";
  server: string;
  sourceId: string;
  buildRoot: string;
  charts: Record<string, ChartInput>;
}
interface Exports {
  convertChart(input: Uint8Array): ChartDocument;
  estimateChartDifficulty(input: ChartDifficultyInput, calibration: DifficultyCalibration): ChartDifficultyEstimate;
  OUR_NOTES_FC_CALIBRATION: DifficultyCalibration;
}
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const digestFiles = (files: readonly string[]) => hash(JSON.stringify(Object.fromEntries(
  files.map((relative) => [relative, hash(fs.readFileSync(path.join(repository, relative)))]),
)));
// The same manifest labels work in a developer checkout and the pipeline host.
const converterFiles = [
  ".dependencies/cassiopeia-plugin-our-notes/src/core/chart.ts",
  ".dependencies/cassiopeia-plugin-our-notes/src/core/parser.ts",
  ".dependencies/cassiopeia/src/core/timing.ts",
] as const;
const algorithmFiles = [
  "src/lib/chart-difficulty.ts",
  "src/lib/chart-difficulty-reading.ts",
  ".dependencies/cassiopeia/src/core/session.ts",
  ".dependencies/cassiopeia/src/core/geometry.ts",
  ".dependencies/cassiopeia/src/core/assist.ts",
  ".dependencies/cassiopeia/src/core/enums.ts",
  ".dependencies/cassiopeia-plugin-our-notes/src/adapter/renderFrame.ts",
  ".dependencies/cassiopeia-plugin-our-notes/src/index.ts",
] as const;
const converter = [
  "packages/sonolus/src/convert/index.ts",
  ".dependencies/cassiopeia-plugin-sonolus/src/convert/index.ts",
].find((relative) => fs.existsSync(path.join(repository, relative)));
if (!converter) throw new Error("Canonical chart converter unavailable");
const bundled = buildSync({
  stdin: {
    contents: `export {convertChart} from ${JSON.stringify(path.join(repository, converter))};
      export {estimateChartDifficulty} from ${JSON.stringify(path.join(repository, "src/lib/chart-difficulty.ts"))};
      export {OUR_NOTES_FC_CALIBRATION} from ${JSON.stringify(path.join(repository, "src/lib/chart-difficulty-calibration.ts"))};`,
    resolveDir: repository, loader: "ts",
  },
  bundle: true, platform: "node", format: "cjs", write: false, logLevel: "silent",
  alias: {
    "@haneoka/cassiopeia": path.join(repository, ".dependencies/cassiopeia/src"),
    "@haneoka/cassiopeia-plugin-our-notes": path.join(repository, ".dependencies/cassiopeia-plugin-our-notes/src"),
  },
});
const compiled = { exports: {} as Exports };
new Function("module", "exports", "require", bundled.outputFiles[0]!.text)(compiled, compiled.exports, createRequire(import.meta.url));
const { convertChart, estimateChartDifficulty, OUR_NOTES_FC_CALIBRATION } = compiled.exports;
const canonicalConverterSha256 = digestFiles(converterFiles), algorithmSha256 = digestFiles(algorithmFiles);

const input = JSON.parse(fs.readFileSync(0, "utf8")) as Request;
if (input.schema !== "haneoka-chart-difficulty-build-v1" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(input.server) ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(input.sourceId) || typeof input.buildRoot !== "string" ||
    !input.charts || typeof input.charts !== "object" || Array.isArray(input.charts) || Object.keys(input.charts).length > 2000)
  throw new Error("Invalid chart difficulty build request");
const root = fs.realpathSync(input.buildRoot), estimates: Record<string, ChartDifficultyEstimate> = {};
const cache = new Map<string, ChartDifficultyEstimate>();
for (const [scoreId, descriptor] of Object.entries(input.charts)) {
  if (!/^[1-9]\d*$/u.test(scoreId) || !descriptor || typeof descriptor.path !== "string" ||
      !descriptor.path.startsWith("assets/Assets/AddressableResources/Live/MusicScore/") || !descriptor.path.endsWith(".bytes") ||
      descriptor.path.split("/").some((part) => !part || part === "." || part === "..") ||
      typeof descriptor.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(descriptor.sha256) ||
      (descriptor.masterJudgedCount !== null && (!Number.isSafeInteger(descriptor.masterJudgedCount) || descriptor.masterJudgedCount < 1)))
    throw new Error(`Invalid chart difficulty input:${scoreId}`);
  const file = fs.realpathSync(path.join(root, descriptor.path));
  if (!file.startsWith(root + path.sep) || !fs.statSync(file).isFile() || fs.statSync(file).size > 2 * 1024 * 1024)
    throw new Error(`Chart difficulty file outside budget/root:${scoreId}`);
  const bytes = fs.readFileSync(file);
  if (hash(bytes) !== descriptor.sha256) throw new Error(`Chart difficulty source checksum mismatch:${scoreId}`);
  const key = JSON.stringify([input.sourceId, descriptor.sha256, descriptor.masterJudgedCount,
    canonicalConverterSha256, algorithmSha256, OUR_NOTES_FC_CALIBRATION.sha256]);
  let estimate = cache.get(key);
  if (!estimate) {
    estimate = estimateChartDifficulty({
      chart: convertChart(bytes), masterJudgedCount: descriptor.masterJudgedCount,
      canonicalWarnings: descriptor.masterJudgedCount === null ? ["canonical-count-reference-missing"] : [],
      pin: { sourceId: input.sourceId, chartSha256: descriptor.sha256, canonicalConverterSha256, algorithmSha256 },
    }, OUR_NOTES_FC_CALIBRATION);
    cache.set(key, estimate);
  }
  estimates[scoreId] = structuredClone(estimate);
}
process.stdout.write(JSON.stringify(estimates));
