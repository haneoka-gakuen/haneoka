import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

interface ScoreEvent {
  tick: number;
  timeMs: number;
  operateType: number;
}

interface MetricBpmChange {
  bpm: number;
  tick: number;
  timeMs: number;
}

interface MetricChart {
  bpmChanges: readonly MetricBpmChange[];
  notes: readonly {
    judged: boolean;
    operateType: number;
    tick: number;
    timeMs: number;
  }[];
  passthrough: {
    fever: readonly (readonly [number, number])[];
    skill: readonly number[];
  };
}

interface ScoreMetrics {
  events: ScoreEvent[];
  canonicalNoteCount: number;
  durationMs: number;
  bpmChanges: MetricBpmChange[];
  skillTimesMs: number[];
  feverRanges: { startTick: number; endTick: number }[];
}

interface ConverterExports {
  convertChart(input: string | Uint8Array): MetricChart;
}

const require = createRequire(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const converterEntry = path.join(repositoryRoot, "packages/sonolus/src/convert/index.ts");

// API generation and the chart player must consume the same native-backed
// conversion model. Bundle that TypeScript entry in memory instead of keeping
// a second, subtly different chart resolver in Python.
const bundle = buildSync({
  stdin: {
    contents: `export { convertChart } from ${JSON.stringify(converterEntry)};`,
    resolveDir: repositoryRoot,
    sourcefile: "haneoka-song-metrics-entry.ts",
    loader: "ts",
  },
  bundle: true,
  platform: "node",
  format: "cjs",
  write: false,
  logLevel: "silent",
});
const source = bundle.outputFiles?.[0]?.text;
if (!source) throw new Error("canonical chart converter bundle is empty");
const compiled: { exports: Partial<ConverterExports> } = { exports: {} };
new Function("module", "exports", "require", source)(compiled, compiled.exports, require);
const convertChart = compiled.exports.convertChart;
if (typeof convertChart !== "function") throw new Error("canonical convertChart export is missing");

function tickToTimeMs(changes: readonly MetricBpmChange[], tick: number): number {
  const first = changes[0];
  if (!first) return Math.floor((Number(tick) * 60000) / (120 * 480));
  let segment = first;
  for (const change of changes) {
    if (Number(change.tick) <= Number(tick)) segment = change;
    else break;
  }
  const denominator = Math.fround(Number(segment.bpm) * 480);
  return Math.floor(Number(segment.timeMs) + ((Number(tick) - Number(segment.tick)) * 60000) / denominator);
}

function parseFiles(sourceText: string): Record<string, string> {
  const value = JSON.parse(sourceText) as JsonValue;
  if (!value || Array.isArray(value) || typeof value !== "object") {
    throw new TypeError("song metric input must be an object of file paths");
  }
  const files: Record<string, string> = {};
  for (const [key, file] of Object.entries(value)) {
    if (typeof file !== "string") throw new TypeError(`song metric path for ${key} must be a string`);
    files[key] = file;
  }
  return files;
}

const files = parseFiles(fs.readFileSync(0, "utf8"));
const output: Record<string, ScoreMetrics> = {};
for (const [key, file] of Object.entries(files)) {
  const chart = convertChart(fs.readFileSync(String(file)));
  const events = chart.notes
    .filter((note) => note.judged)
    .map((note) => ({
      tick: Number(note.tick),
      timeMs: Number(note.timeMs),
      operateType: Number(note.operateType),
    }));
  const bpmChanges = chart.bpmChanges.map((change) => ({
    tick: Number(change.tick),
    timeMs: Number(change.timeMs),
    bpm: Number(change.bpm),
  }));
  output[key] = {
    events,
    canonicalNoteCount: events.length,
    durationMs: events.reduce((maximum, note) => Math.max(maximum, note.timeMs), 0),
    bpmChanges,
    skillTimesMs: chart.passthrough.skill.map((tick) => tickToTimeMs(bpmChanges, tick)),
    feverRanges: chart.passthrough.fever.map(([startTick, endTick]) => ({
      startTick: Number(startTick),
      endTick: Number(endTick),
    })),
  };
}

process.stdout.write(JSON.stringify(output));
