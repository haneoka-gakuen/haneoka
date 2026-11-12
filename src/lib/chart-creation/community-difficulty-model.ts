// L3 — GEB
// Input: canonical community chart, independent combo count and source identity.
// Output: slot-independent integer recommendation for every playable community chart.
// Pos: [Map](../L2-2.md); community-only calibration and operation-load fallback.
// Effects/Dependencies: Fixed intl release r-ea9911b7160133665523, 96 songs / 384 charts;
// Source: v86-1e5e2dca8254-663e541d2039-md693d1a4759f-n9ee9059e.
// Official displayed levels calibrate v7 FC strain; endpoint slopes extend the level scale.
// Multi-contact and unusual long-note geometry use a nonnegative operation-load projection.
// Five song-grouped folds: FC-skill MAE 0.119, 90th-percentile absolute error 0.245.
import { CHART_DIFFICULTY_VERSION, chartDifficultyFeatures } from "../chart-difficulty";
import type { ChartDifficultyEstimate, ChartDifficultyInput } from "../chart-difficulty";

const FEATURE_VERSION = "ournotes-fc-threshold-v7";
export const COMMUNITY_DIFFICULTY_VERSION = `${FEATURE_VERSION}:community-slotless-v3`;
const DOWNS = new Set([1, 20, 101]);
const FLICKS = new Set([40, 41, 42, 102]);
const TRACES = new Set([21, 60, 61, 62, 63, 103, 104, 105]);
const TAILS = new Set([22]);
const LOAD_INTERCEPT = 1.6874092019252531;
const LOAD_WEIGHTS = [
  1.0833296911757253, 0.11763847628524457, 0.48085277863771536, 0.37731052501113266, 0.2866561914939221, 0.0,
  0.9008957248166902, 0.0,
];

export function communityOperationLoad(input: ChartDifficultyInput) {
  const duration = Math.max(1, input.chart.durationMs / 1000);
  const events = input.chart.notes
    .filter(
      (note) =>
        note.judged &&
        (DOWNS.has(note.operateType) ||
          FLICKS.has(note.operateType) ||
          TRACES.has(note.operateType) ||
          TAILS.has(note.operateType)),
    )
    .map((note) => ({
      note,
      time: note.timeMs / 1000,
      weight: DOWNS.has(note.operateType)
        ? 1
        : FLICKS.has(note.operateType)
          ? 1.25
          : TAILS.has(note.operateType)
            ? 0.15
            : 0.35,
    }))
    .sort((a, b) => a.time - b.time || a.note.id - b.note.id);
  const peak = (seconds: number) => {
    let left = 0,
      sum = 0,
      maximum = 0;
    for (let right = 0; right < events.length; right++) {
      sum += events[right]!.weight;
      while (events[right]!.time - events[left]!.time >= seconds) sum -= events[left++]!.weight;
      maximum = Math.max(maximum, sum / seconds);
    }
    return maximum;
  };
  let total = 0,
    chord = 0,
    previous = -Infinity;
  const positions = new Map<number, [number, number]>();
  let downCount = 0,
    flickCount = 0,
    traceCheckCount = 0,
    tailCheckCount = 0;
  for (const event of events) {
    total += event.weight;
    if (event.time === previous) chord += event.weight;
    const centre = (event.note.pos + event.note.size / 2) / 24;
    const bounds = positions.get(event.time);
    positions.set(event.time, bounds ? [Math.min(bounds[0], centre), Math.max(bounds[1], centre)] : [centre, centre]);
    previous = event.time;
    if (DOWNS.has(event.note.operateType)) downCount++;
    if (FLICKS.has(event.note.operateType)) flickCount++;
    if (TRACES.has(event.note.operateType)) traceCheckCount++;
    if (TAILS.has(event.note.operateType)) tailCheckCount++;
  }
  const notes = new Map(input.chart.notes.map((note) => [note.id, note]));
  let heldSeconds = 0;
  for (const line of input.chart.lines) {
    if (line.kind !== "long") continue;
    let start = Infinity,
      end = -Infinity;
    for (const id of line.noteIds) {
      const note = notes.get(id);
      if (!note || note.operateType === 120 || note.operateType === 121) continue;
      start = Math.min(start, note.timeMs / 1000);
      end = Math.max(end, note.timeMs / 1000);
    }
    heldSeconds += Math.max(0, end - start);
  }
  let movement = 0,
    before: [number, number] | undefined;
  for (const bounds of positions.values()) {
    if (before) movement += Math.abs(bounds[0] - before[0]) + Math.abs(bounds[1] - before[1]);
    before = bounds;
  }
  const density = total / duration,
    peak1 = peak(1),
    peak4 = peak(4);
  return {
    values: [
      density,
      peak1,
      peak4,
      flickCount / duration,
      chord / duration,
      heldSeconds / duration,
      duration / 60,
      movement / duration,
    ].map(Math.log1p),
    components: {
      density,
      chords: chord / duration,
      handMovement: movement / duration,
      flick: flickCount / duration,
      holdConstraints: heldSeconds / duration,
      rhythm: peak1 / Math.max(1, density),
      reading: Math.log1p(input.chart.timeScaleChanges?.length ?? 0),
      stamina: peak4,
    },
    operationCount: events.length,
    downCount,
    flickCount,
    traceCheckCount,
    tailCheckCount,
  };
}
const CURVE = [
  [3.417225612010215, 5.0],
  [3.614686507001449, 5.333333333333333],
  [3.740435652683453, 6.0],
  [3.762519682847543, 6.0],
  [3.7879425541413134, 6.0],
  [3.803835848670074, 6.0],
  [3.8153384686861678, 6.0],
  [3.8587182878319517, 6.0],
  [3.890310238219115, 6.666666666666667],
  [3.951192227368146, 6.973684210526316],
  [3.993933694797648, 7.0],
  [4.0307840687584005, 7.0],
  [4.131997448575153, 7.578947368421052],
  [4.225362867630995, 7.625],
  [4.251873295537954, 8.333333333333334],
  [4.2965607666068975, 8.375],
  [4.351544454637915, 9.125],
  [4.37974868904646, 11.0],
  [4.428290374682819, 11.4],
  [4.482860912378106, 11.636363636363637],
  [4.532952182592072, 12.4],
  [4.582278830489739, 12.916666666666666],
  [4.6121115502461, 13.0],
  [4.712422735112983, 13.028571428571428],
  [4.835184661973538, 13.333333333333334],
  [4.887371897312982, 13.75],
  [4.957796395299014, 13.857142857142858],
  [5.01224642417767, 15.0],
  [5.043334807328242, 15.0],
  [5.093973409328171, 16.5],
  [5.174081171128696, 16.636363636363637],
  [5.352020999328859, 18.136363636363637],
  [5.452961437441436, 19.0],
  [5.499824398647547, 19.0],
  [5.558141001213257, 19.2],
  [5.575387984981911, 19.5],
  [5.661344683432413, 19.82608695652174],
  [5.780664750503323, 20.6875],
  [5.899406712314096, 21.105263157894736],
  [6.061981145213239, 22.071428571428573],
  [6.149132641425106, 22.785714285714285],
  [6.200455587622729, 23.0],
  [6.228190289165119, 24.5],
  [6.263507411288828, 24.983333333333334],
  [6.454350286865167, 25.123999999999995],
  [6.72498069842869, 25.793750000000003],
  [6.94737727894377, 27.025000000000002],
  [7.154750026269953, 27.6],
  [7.275729084681727, 28.5],
  [7.741909889106983, 28.5],
];

function levelForSkill(skill: number): number {
  let first = CURVE[0]!,
    last = CURVE[1]!;
  if (skill >= CURVE.at(-1)![0]!) {
    last = CURVE.at(-1)!;
    for (let i = CURVE.length - 2; i >= 0; i--) {
      if (CURVE[i]![1]! < last[1]!) {
        first = CURVE[i]!;
        break;
      }
    }
  } else {
    for (let i = 1; i < CURVE.length; i++) {
      last = CURVE[i]!;
      first = CURVE[i - 1]!;
      if (skill <= last[0]!) break;
    }
  }
  const value = first[1]! + ((last[1]! - first[1]!) * (skill - first[0]!)) / (last[0]! - first[0]!);
  return Math.max(1, Math.round(value));
}

export function estimateCommunityDifficulty(input: ChartDifficultyInput): ChartDifficultyEstimate {
  const feature = chartDifficultyFeatures(input);
  const quality = { ...feature.quality, warnings: [...feature.quality.warnings] };
  let skill = feature.raw.fcSkill ?? Number.NaN;
  let components = feature.components;
  if (CHART_DIFFICULTY_VERSION !== FEATURE_VERSION || quality.status === "unavailable" || !Number.isFinite(skill)) {
    const load = communityOperationLoad(input);
    skill = LOAD_INTERCEPT + load.values.reduce((sum, value, i) => sum + value * LOAD_WEIGHTS[i]!, 0);
    components = load.components;
    quality.operationCount = load.operationCount;
    quality.downCount = load.downCount;
    quality.flickCount = load.flickCount;
    quality.traceCheckCount = load.traceCheckCount;
    quality.tailCheckCount = load.tailCheckCount;
    quality.warnings.push("community-operation-load-fallback");
    if (!load.operationCount) skill = CURVE[0]![0]! - 2;
  }
  if (skill < CURVE[0]![0]! || skill > CURVE.at(-1)![0]!) quality.warnings.push("community-calibration-extrapolated");
  quality.status = "low-confidence";
  quality.confidence = "low";
  return {
    version: COMMUNITY_DIFFICULTY_VERSION,
    target: "fc-operation-load",
    estimatedConstant: levelForSkill(skill),
    components,
    quality,
    units: "relative-strain",
    sourceId: input.sourceId,
  };
}
