import { nativeJudgementAreaOffsetX, applyLineEase, type ChartDocument, type ChartNote } from "@haneoka/cassiopeia";

/** FC/stable-completion operation-load estimate at 1x, assist 0; no player or team score input. */
export const CHART_DIFFICULTY_VERSION = "ournotes-fc-strain-v1";
export const CHART_DIFFICULTY_WEIGHTS = {
  chords: 0.35,
  handMovement: 0.4,
  flick: 0.35,
  holdConstraints: 0.45,
  rhythm: 0.2,
  reading: 0.15,
  stamina: 0.25,
} as const;
export type DifficultyComponent = "density" | keyof typeof CHART_DIFFICULTY_WEIGHTS;
export interface DifficultyCalibration {
  version: typeof CHART_DIFFICULTY_VERSION;
  canonicalConverterSha256: string;
  kind: "theil-sen-blend-log1p";
  slope: number;
  intercept: number;
  xRange: readonly [number, number];
  rateWeight: number;
  strainWeight: number;
  trainingSongs: number;
  trainingCharts: number;
  sha256: string;
}
export interface DifficultyInputPin {
  sourceId: string;
  chartSha256: string;
  canonicalConverterSha256: string;
  algorithmSha256: string;
}
export interface ChartDifficultyInput {
  chart: Readonly<ChartDocument>;
  masterJudgedCount: number | null;
  canonicalWarnings?: readonly string[];
  pin: DifficultyInputPin;
}
export interface DifficultyQuality {
  status: "estimated" | "low-confidence" | "unavailable";
  confidence: "medium" | "low" | null;
  warnings: string[];
  canonicalJudgedCount: number;
  masterJudgedCount: number | null;
  operationCount: number;
  downCount: number;
  flickCount: number;
  traceCheckCount: number;
  generatedScoreTicks: number;
}
export interface ChartDifficultyEstimate {
  version: string;
  target: "fc-operation-load";
  estimatedConstant: number | null;
  components: Record<DifficultyComponent, number> | null;
  quality: DifficultyQuality;
  /** Components are relative strain units; movement is based on fractions of the 24-lane plane. */
  units: "relative-strain";
  pin: DifficultyInputPin & { calibrationSha256: string | null };
}
export interface ChartDifficultyFeatures {
  raw: { manualRate: number; temporalStrain: number; operationStrain: number };
  components: Record<DifficultyComponent, number>;
  quality: DifficultyQuality;
}
const DOWNS = new Set([1, 20, 41, 61, 101]);
const FLICKS = new Set([40, 41, 42, 102]);
const TRACES = new Set([60, 104, 105]);
const KNOWN = new Set([
  0, 1, 20, 21, 22, 40, 41, 42, 60, 61, 62, 63, 80, 82, 100, 101, 102, 103, 104, 105, 120, 121, 122, 123,
]);
const FACTORS = Object.keys(CHART_DIFFICULTY_WEIGHTS) as (keyof typeof CHART_DIFFICULTY_WEIGHTS)[];
const COMPONENTS: DifficultyComponent[] = ["density", ...FACTORS];
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
function aggregate(values: Iterable<number>): number {
  return (
    [...values]
      .filter((value) => value > 0)
      .sort((a, b) => b - a)
      .reduce((sum, value, index) => sum + value * 0.9 ** index, 0) * 0.1
  );
}
function emptyComponents(): Record<DifficultyComponent, number> {
  return Object.fromEntries(COMPONENTS.map((name) => [name, 0])) as Record<DifficultyComponent, number>;
}
interface Operation {
  time: number;
  note: ChartNote;
  base: number;
  starts: number[];
}
interface LongPath {
  id: number;
  points: ChartNote[];
  start: number;
  end: number;
}
function interval(note: ChartNote): [number, number] {
  const offset = nativeJudgementAreaOffsetX(note.judgementAreaOffsetType, note.size, 0);
  return [Math.max(0, note.pos - offset - 0.5) / 24, Math.min(23, note.pos + note.size + offset - 0.5) / 24];
}
function trajectory(line: LongPath, time: number): [number, number] {
  const points = line.points;
  let index = 0;
  while (index + 1 < points.length - 1 && points[index + 1]!.timeMs / 1000 <= time) index++;
  const head = points[index]!,
    tail = points[index + 1]!;
  const span = (tail.timeMs - head.timeMs) / 1000;
  const progress = clamp(span > 0 ? (time - head.timeMs / 1000) / span : 0, 0, 1);
  const left = head.pos + (tail.pos - head.pos) * applyLineEase(head.easeL, progress);
  const right =
    head.pos + head.size + (tail.pos + tail.size - head.pos - head.size) * applyLineEase(head.easeR, progress);
  const offset = Math.max(0, head.pos / 24 - interval(head)[0]);
  return [Math.max(0, left / 24 - offset), Math.min(23 / 24, right / 24 + offset)];
}
/** Deterministic, bounded feature extraction. Generated score ticks never create press impulses. */
export function chartDifficultyFeatures(input: ChartDifficultyInput): ChartDifficultyFeatures {
  const chart = input.chart,
    warnings = new Set(input.canonicalWarnings ?? []),
    notes = chart.notes;
  const quality: DifficultyQuality = {
    status: "low-confidence",
    confidence: "low",
    warnings: [],
    canonicalJudgedCount: notes.filter((note) => note.judged).length,
    masterJudgedCount: input.masterJudgedCount,
    operationCount: 0,
    downCount: 0,
    flickCount: 0,
    traceCheckCount: 0,
    generatedScoreTicks: notes.filter((note) => note.operateType === 120).length,
  };
  const unavailable = (): ChartDifficultyFeatures => {
    quality.status = "unavailable";
    quality.confidence = null;
    quality.warnings = [...warnings].sort();
    return { raw: { manualRate: 0, temporalStrain: 0, operationStrain: 0 }, components: emptyComponents(), quality };
  };
  if (input.masterJudgedCount === null) warnings.add("master-count-unavailable");
  if (input.masterJudgedCount !== null && quality.canonicalJudgedCount !== input.masterJudgedCount)
    warnings.add("canonical-full-combo-mismatch");
  if (notes.length > 25000 || !Number.isFinite(chart.durationMs) || chart.durationMs <= 0 || chart.durationMs > 900000)
    warnings.add("chart-budget-or-duration");
  if (
    notes.some(
      (note) =>
        !KNOWN.has(note.operateType) ||
        !Number.isInteger(note.judgementAreaOffsetType) ||
        note.judgementAreaOffsetType < 0 ||
        note.judgementAreaOffsetType > 10,
    )
  )
    warnings.add("unsupported-operation");
  // Zero-width unjudged Guide/Hidden markers are legal canonical data.
  if (
    notes.some((note) => ![note.timeMs, note.pos, note.size].every(Number.isFinite) || note.timeMs < 0 || note.size < 0)
  )
    warnings.add("invalid-canonical-geometry");
  const byId = new Map(notes.map((note) => [note.id, note]));
  if (byId.size !== notes.length) warnings.add("duplicate-canonical-id");
  if (
    [...warnings].some(
      (warning) =>
        warning.startsWith("canonical-") ||
        [
          "chart-budget-or-duration",
          "unsupported-operation",
          "invalid-canonical-geometry",
          "duplicate-canonical-id",
        ].includes(warning),
    )
  )
    return unavailable();
  const lines: LongPath[] = [],
    starts = new Map<number, number[]>();
  for (const line of chart.lines) {
    if (line.noteIds.some((id) => !byId.has(id))) {
      warnings.add("missing-line-node");
      continue;
    }
    const points = line.noteIds
      .map((id) => byId.get(id)!)
      .filter((note) => note.operateType !== 120 && note.operateType !== 121)
      .sort((a, b) => a.timeMs - b.timeMs || a.id - b.id);
    if (line.kind !== "long" || points.length < 2) continue;
    const head = points[0]!,
      tail = points.at(-1)!;
    if (tail.timeMs <= head.timeMs) {
      warnings.add("nonpositive-long-span");
      continue;
    }
    lines.push({ id: line.id, points, start: head.timeMs / 1000, end: tail.timeMs / 1000 });
    starts.set(head.id, [...(starts.get(head.id) ?? []), line.id]);
  }
  if (warnings.has("missing-line-node") || warnings.has("nonpositive-long-span")) return unavailable();
  const events: Operation[] = [];
  for (const note of notes) {
    const op = note.operateType;
    if (!note.judged || op === 120 || op === 121) continue;
    if (DOWNS.has(op) || FLICKS.has(op) || TRACES.has(op)) {
      if (DOWNS.has(op)) quality.downCount++;
      if (FLICKS.has(op)) quality.flickCount++;
      if (TRACES.has(op)) quality.traceCheckCount++;
      events.push({
        time: note.timeMs / 1000,
        note,
        base: DOWNS.has(op) || FLICKS.has(op) ? 1 : 0.35,
        starts: starts.get(note.id) ?? [],
      });
    }
    // Maintained SlideEnd/Trace checkpoints and auto Combo nodes are not independent new presses.
  }
  const operationIds = new Set(events.map((event) => event.note.id));
  for (const line of lines) {
    if (operationIds.has(line.points[0]!.id)) continue;
    const member = chart.lines.find((value) => value.id === line.id)!;
    const candidates = member.noteIds
      .map((id) => byId.get(id)!)
      .filter((note) => note.judged)
      .sort((a, b) => a.timeMs - b.timeMs);
    if (candidates.length) {
      const note = candidates[0]!;
      events.push({ time: note.timeMs / 1000, note, base: 0.35, starts: [line.id] });
      warnings.add("inferred-maintained-entry");
    }
  }
  events.sort((a, b) => a.time - b.time || a.note.id - b.note.id);
  quality.operationCount = events.length;
  if (!events.length) {
    warnings.add("no-operation-events");
    return unavailable();
  }
  const duration = chart.durationMs / 1000,
    groups = new Map<number, Operation[]>();
  for (const event of events) groups.set(event.time, [...(groups.get(event.time) ?? []), event]);
  if ([...groups.values()].some((group) => group.length > 8)) {
    warnings.add("unsupported-contact-demand");
    return unavailable();
  }
  const times = new Set<number>([duration, ...groups.keys()]);
  for (let index = 0; index <= Math.floor(duration / 0.05); index++) times.add(index * 0.05);
  for (const event of chart.bpmChanges) {
    if (!Number.isFinite(event.timeMs) || !Number.isFinite(event.bpm) || event.bpm <= 0) {
      warnings.add("invalid-bpm");
      return unavailable();
    }
    times.add(event.timeMs / 1000);
  }
  for (const event of chart.timeScaleChanges) {
    if (!Number.isFinite(event.timeMs) || !Number.isFinite(event.scale) || event.scale <= 0) {
      warnings.add("nonpositive-scroll-scale");
      return unavailable();
    }
    times.add(event.timeMs / 1000);
  }
  const position = [0.25, 0.75],
    last = [-2, -2],
    handStrain = [0, 0],
    owners = new Map<number, number>(),
    directions = new Map<number, number>();
  const state = emptyComponents(),
    peaks = new Map<string, Map<number, number>>(["temporal", "rich", ...COMPONENTS].map((key) => [key, new Map()]));
  let globalStrain = 0,
    fatigue = 0,
    previousTime = 0,
    previousGroup: number | null = null,
    previousIoi: number | null = null;
  for (const time of [...times].sort((a, b) => a - b)) {
    const dt = Math.max(0, time - previousTime),
      decay = 0.3 ** dt;
    globalStrain *= decay;
    for (const hand of [0, 1]) handStrain[hand] = handStrain[hand]! * 0.125 ** dt;
    for (const key of FACTORS) state[key] *= decay;
    const active = lines.filter((line) => line.start <= time && time < line.end),
      held: LongPath[][] = [[], []];
    for (const line of active) {
      if (!owners.has(line.id)) {
        const range = trajectory(line, time);
        owners.set(line.id, (range[0] + range[1]) / 2 < 0.5 ? 0 : 1);
      }
      held[owners.get(line.id)!]!.push(line);
    }
    let holdSpeed = 0;
    for (const hand of [0, 1]) {
      if (!held[hand]!.length) continue;
      const ranges = held[hand]!.map((line) => trajectory(line, time)),
        low = Math.max(...ranges.map((range) => range[0])),
        high = Math.min(...ranges.map((range) => range[1]));
      const target =
        low <= high ? clamp(position[hand]!, low, high) : mean(ranges.map((range) => (range[0] + range[1]) / 2));
      holdSpeed += Math.abs(target - position[hand]!) / Math.max(dt, 0.05);
      position[hand] = target;
    }
    state.holdConstraints += dt * (0.2 * active.length + 0.15 * holdSpeed);
    const rows = groups.get(time) ?? [];
    if (rows.length) {
      if (rows.length > 4) warnings.add("more-than-four-coincident-actions");
      let bestCost = Infinity,
        best = 0;
      for (let mask = 0; mask < 2 ** rows.length; mask++) {
        let cost = 0;
        for (const hand of [0, 1]) {
          const intervals = rows
            .filter((_, index) => ((mask >> (rows.length - 1 - index)) & 1) === hand)
            .map((row) => interval(row.note));
          if (!intervals.length) continue;
          const low = Math.max(...intervals.map((range) => range[0])),
            high = Math.min(...intervals.map((range) => range[1]));
          let distance =
            low <= position[hand]! && position[hand]! <= high
              ? 0
              : Math.min(Math.abs(position[hand]! - low), Math.abs(position[hand]! - high));
          if (low > high) distance += low - high;
          cost +=
            handStrain[hand]! +
            distance / Math.max(time - last[hand]!, 0.05) +
            0.35 * Math.max(0, intervals.length + held[hand]!.length - 2) ** 2;
        }
        if (cost < bestCost) {
          bestCost = cost;
          best = mask;
        }
      }
      let movement = 0,
        repeat = 0;
      rows.forEach((row, index) => {
        const hand = (best >> (rows.length - 1 - index)) & 1,
          range = interval(row.note),
          elapsed = time - last[hand]!,
          target = clamp(position[hand]!, range[0], range[1]);
        movement += Math.abs(target - position[hand]!) / Math.max(elapsed, 0.05);
        repeat += Math.max(0, 0.2 / Math.max(elapsed, 0.05) - 1) * 0.15;
        handStrain[hand] = handStrain[hand]! + row.base;
        position[hand] = target;
        last[hand] = time;
        for (const id of row.starts) owners.set(id, hand);
        if (FLICKS.has(row.note.operateType)) {
          state.flick += 1;
          // Native flick eligibility ignores chart direction; changes contribute only a small reading cue.
          if (directions.has(hand) && directions.get(hand) !== row.note.direction) state.reading += 0.1;
          directions.set(hand, row.note.direction);
        }
      });
      globalStrain += rows.reduce((sum, row) => sum + row.base, 0);
      state.chords += Math.max(0, rows.length - 1) ** 1.2;
      state.handMovement += movement / 4 + repeat;
      state.holdConstraints += 0.15 * active.length * rows.length;
      if (previousGroup !== null) {
        const ioi = time - previousGroup;
        if (ioi > 0 && previousIoi !== null && previousIoi > 0)
          state.rhythm += Math.min(2, Math.abs(Math.log2(ioi / previousIoi))) * 0.25;
        if (ioi > 0) previousIoi = ioi;
      }
      previousGroup = time;
    }
    chart.bpmChanges.forEach((event, index) => {
      if (index && Math.abs(event.timeMs / 1000 - time) < 1e-9)
        state.reading += Math.abs(Math.log2(event.bpm / chart.bpmChanges[index - 1]!.bpm));
    });
    for (const event of chart.timeScaleChanges)
      if (Math.abs(event.timeMs / 1000 - time) < 1e-9) state.reading += Math.abs(Math.log2(event.scale)) * 0.25;
    fatigue =
      fatigue * Math.exp(-dt / 6) + (1 - Math.exp(-dt / 6)) * Math.max(0, globalStrain + Math.max(...handStrain) - 3);
    state.stamina = fatigue;
    const density = globalStrain + 0.5 * Math.max(...handStrain),
      rich = density + FACTORS.reduce((sum, key) => sum + CHART_DIFFICULTY_WEIGHTS[key] * state[key], 0),
      slot = Math.floor(time / 0.4);
    const values = {
      temporal: globalStrain,
      rich,
      density,
      ...Object.fromEntries(FACTORS.map((key) => [key, state[key]])),
    };
    for (const [key, value] of Object.entries(values))
      peaks.get(key)!.set(slot, Math.max(peaks.get(key)!.get(slot) ?? 0, value));
    previousTime = time;
  }
  warnings.add("heuristic-no-player-validation");
  warnings.add("two-hand-contact-assumption");
  warnings.add("reading-visibility-proxy");
  quality.warnings = [...warnings].sort();
  return {
    raw: {
      manualRate: events.reduce((sum, event) => sum + event.base, 0) / duration,
      temporalStrain: aggregate(peaks.get("temporal")!.values()),
      operationStrain: aggregate(peaks.get("rich")!.values()),
    },
    components: Object.fromEntries(COMPONENTS.map((key) => [key, aggregate(peaks.get(key)!.values())])) as Record<
      DifficultyComponent,
      number
    >,
    quality,
  };
}
/** Calibration is explicit: absence never fabricates a constant or reuses an official per-chart label. */
export function estimateChartDifficulty(
  input: ChartDifficultyInput,
  calibration?: DifficultyCalibration,
): ChartDifficultyEstimate {
  const feature = chartDifficultyFeatures(input),
    warnings = feature.quality.warnings;
  const result: ChartDifficultyEstimate = {
    version: CHART_DIFFICULTY_VERSION,
    target: "fc-operation-load",
    estimatedConstant: null,
    components: feature.quality.status === "unavailable" ? null : feature.components,
    quality: feature.quality,
    units: "relative-strain",
    pin: { ...input.pin, calibrationSha256: calibration?.sha256 ?? null },
  };
  if (feature.quality.status === "unavailable") return result;
  if (
    !calibration ||
    calibration.version !== CHART_DIFFICULTY_VERSION ||
    calibration.kind !== "theil-sen-blend-log1p" ||
    !/^[a-f0-9]{64}$/.test(calibration.sha256) ||
    ![
      calibration.slope,
      calibration.intercept,
      ...calibration.xRange,
      calibration.rateWeight,
      calibration.strainWeight,
    ].every(Number.isFinite) ||
    calibration.slope <= 0 ||
    calibration.xRange[0] > calibration.xRange[1] ||
    calibration.rateWeight < 0 ||
    calibration.strainWeight < 0
  ) {
    warnings.push("calibration-unavailable");
    result.quality.status = "unavailable";
    result.quality.confidence = null;
    return result;
  }
  if (calibration.canonicalConverterSha256 !== input.pin.canonicalConverterSha256) {
    warnings.push("calibration-converter-mismatch");
    result.quality.status = "unavailable";
    result.quality.confidence = null;
    return result;
  }
  const x =
    calibration.rateWeight * Math.log1p(feature.raw.manualRate) +
    calibration.strainWeight * Math.log1p(feature.raw.operationStrain);
  if (x < calibration.xRange[0] || x > calibration.xRange[1]) warnings.push("outside-calibration-range");
  result.estimatedConstant = Math.round((calibration.intercept + calibration.slope * x) * 10) / 10;
  return result;
}
