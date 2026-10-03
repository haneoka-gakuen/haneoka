import {
  nativeJudgementAreaOffsetX,
  applyLineEase,
  type ChartDocument,
  type ChartNote,
} from "@haneoka/cassiopeia";

/** FC/stable-completion operation-load estimate at 1x, assist 0; no player or team score input. */
export const CHART_DIFFICULTY_VERSION = "ournotes-fc-operation-v3";
export const CHART_DIFFICULTY_PARAMETERS = {
  maxSearchStates: 500000,
  burstReferenceMs: 200,
  burstQuantile: 0.1,
  peakShortMs: 1000,
  peakSustainedMs: 4000,
  densityMode: "global-operation-pressure",
  calibrationDomain: "fit-range-only",
  initialContacts: [23 / 96, 69 / 96],
  coordinateQuantum: 1e-9,
  contactHandoffCost: 0.1,
  newHoldContactCost: 1,
  noteSpeed: 5,
  nearPairApproachGap: 0.08,
} as const;
import { readingTimeline } from "./chart-difficulty-reading.js";
export const CHART_DIFFICULTY_WEIGHTS = {
  chords: 0.35,
  handMovement: 0.4,
  flick: 0.35,
  holdConstraints: 0.45,
  rhythm: 0.2,
  reading: 0.15,
  stamina: 0.25,
} as const;
export const CHART_DIFFICULTY_PROFILE_SHA256 =
  "69c2f80cf55fa0705ef51a83a33729f1c289230296e0cf8a347188a57c729929";
export type DifficultyComponent =
  "density" | keyof typeof CHART_DIFFICULTY_WEIGHTS;
export interface DifficultyCalibration {
  version: typeof CHART_DIFFICULTY_VERSION;
  canonicalConverterSha256: string;
  kind: "theil-sen-operation-skills-v3";
  featureProfileSha256: string;
  algorithmSha256: string;
  slope: number;
  intercept: number;
  xRange: readonly [number, number];
  rateWeight: number;
  strainWeight: number;
  burstWeight: number;
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
  tailCheckCount: number;
  strategyContactStarts: number;
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
  raw: {
    /** Global operation pressure; local peak and excess fields retain separate units. */
    manualRate: number;
    temporalStrain: number;
    operationStrain: number;
    globalOperationRate?: number;
    sustainedPeakRate?: number;
    peak1s?: number;
    peak4s?: number;
    peakExcessRate?: number;
    handoffCount?: number;
    shortSameHandGestures?: number;
    minSameHandIoiMs?: number | null;
    peakOneHand1s?: number;
    contactGestureCount?: number;
    prescribedGestureCount?: number;
    p10SameHandIoiMs?: number | null;
    shortGestureFraction?: number;
    singleHandBurst?: number;
  };
  components: Record<DifficultyComponent, number>;
  quality: DifficultyQuality;
}
const DOWNS = new Set([1, 20, 101]);
const FLICKS = new Set([40, 41, 42, 102]);
const TRACES = new Set([21, 60, 61, 62, 63, 103, 104, 105]);
const TAILS = new Set([22]);
const KNOWN = new Set([
  0, 1, 20, 21, 22, 40, 41, 42, 60, 61, 62, 63, 80, 82, 100, 101, 102, 103, 104,
  105, 120, 121, 122, 123,
]);
const FACTORS = Object.keys(
  CHART_DIFFICULTY_WEIGHTS,
) as (keyof typeof CHART_DIFFICULTY_WEIGHTS)[];
const COMPONENTS: DifficultyComponent[] = ["density", ...FACTORS];
const clamp = (value: number, low: number, high: number) =>
  Math.max(low, Math.min(high, value));
function aggregate(values: Iterable<number>): number {
  return (
    [...values]
      .filter((value) => value > 0)
      .sort((a, b) => b - a)
      .reduce((sum, value, index) => sum + value * 0.9 ** index, 0) * 0.1
  );
}
function emptyComponents(): Record<DifficultyComponent, number> {
  return Object.fromEntries(COMPONENTS.map((name) => [name, 0])) as Record<
    DifficultyComponent,
    number
  >;
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
  const offset = nativeJudgementAreaOffsetX(
    note.judgementAreaOffsetType,
    note.size,
    0,
  );
  return [
    Math.max(0, note.pos - offset - 0.5) / 24,
    Math.min(23, note.pos + note.size + offset - 0.5) / 24,
  ];
}
function trajectory(line: LongPath, time: number): [number, number] {
  const points = line.points;
  let index = 0;
  while (
    index + 1 < points.length - 1 &&
    points[index + 1]!.timeMs / 1000 <= time
  )
    index++;
  const head = points[index]!,
    tail = points[index + 1]!;
  const span = (tail.timeMs - head.timeMs) / 1000;
  const progress = clamp(
    span > 0 ? (time - head.timeMs / 1000) / span : 0,
    0,
    1,
  );
  const left =
    head.pos + (tail.pos - head.pos) * applyLineEase(head.easeL, progress);
  const right =
    head.pos +
    head.size +
    (tail.pos + tail.size - head.pos - head.size) *
      applyLineEase(head.easeR, progress);
  const checkpoint = points.find(
    (note) => note.judged && note.timeMs / 1000 === time,
  );
  if (checkpoint) return interval(checkpoint);
  const offset = nativeJudgementAreaOffsetX(1, right - left, 0);
  return [
    Math.max(0, left - offset - 0.5) / 24,
    Math.min(23, right + offset - 0.5) / 24,
  ];
}
/** Choose one complete mirrored-equivalent geometry before planning, avoiding label-biased ties. */
function canonicalOrientation(source: Readonly<ChartDocument>): ChartDocument {
  const ordered = source.notes
    .filter((note) => note.judged && note.operateType !== 120)
    .sort((a, b) => a.timeMs - b.timeMs || a.id - b.id);
  let reflect = false;
  for (const note of ordered) {
    const centre = note.pos + (note.size - 1) / 2;
    if (Math.abs(centre - 11.5) > 1e-8) {
      reflect = centre > 11.5;
      break;
    }
    if (note.easeL !== note.easeR) {
      reflect = (note.easeL ?? 0) > (note.easeR ?? 0);
      break;
    }
    if (note.direction !== 0) {
      reflect = note.direction === 2;
      break;
    }
  }
  const round = (value: number) =>
    Math.round(value / CHART_DIFFICULTY_PARAMETERS.coordinateQuantum) *
    CHART_DIFFICULTY_PARAMETERS.coordinateQuantum;
  return {
    ...source,
    notes: source.notes.map((note) => {
      const pos = round(reflect ? 24 - note.pos - note.size : note.pos),
        size = round(note.size);
      return {
        ...note,
        pos,
        size,
        laneX: (pos + size / 2) / 12 - 1,
        width: size / 12,
        easeL: reflect ? note.easeR : note.easeL,
        easeR: reflect ? note.easeL : note.easeR,
        direction: reflect
          ? note.direction === 1
            ? 2
            : note.direction === 2
              ? 1
              : note.direction
          : note.direction,
      };
    }),
  };
}
/** Deterministic, bounded feature extraction. Generated score ticks never create press impulses. */
export function chartDifficultyFeatures(
  input: ChartDifficultyInput,
): ChartDifficultyFeatures {
  const chart = canonicalOrientation(input.chart),
    warnings = new Set(input.canonicalWarnings ?? []),
    notes = chart.notes;
  const quality: DifficultyQuality = {
    status: "low-confidence",
    confidence: "low",
    warnings: [],
    canonicalJudgedCount: notes.filter((note) => note.judged).length,
    masterJudgedCount: input.masterJudgedCount,
    operationCount: 0,
    tailCheckCount: 0,
    strategyContactStarts: 0,
    downCount: 0,
    flickCount: 0,
    traceCheckCount: 0,
    generatedScoreTicks: notes.filter((note) => note.operateType === 120)
      .length,
  };
  const unavailable = (): ChartDifficultyFeatures => {
    quality.status = "unavailable";
    quality.confidence = null;
    quality.warnings = [...warnings].sort();
    return {
      raw: { manualRate: 0, temporalStrain: 0, operationStrain: 0 },
      components: emptyComponents(),
      quality,
    };
  };
  if (input.masterJudgedCount === null)
    warnings.add("master-count-unavailable");
  if (
    input.masterJudgedCount !== null &&
    quality.canonicalJudgedCount !== input.masterJudgedCount
  )
    warnings.add("canonical-full-combo-mismatch");
  if (
    notes.length > 25000 ||
    !Number.isFinite(chart.durationMs) ||
    chart.durationMs <= 0 ||
    chart.durationMs > 900000
  )
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
    notes.some(
      (note) =>
        ![note.timeMs, note.pos, note.size].every(Number.isFinite) ||
        note.timeMs < 0 ||
        note.size < 0,
    )
  )
    warnings.add("invalid-canonical-geometry");
  const byId = new Map(notes.map((note) => [note.id, note]));
  if (byId.size !== notes.length) warnings.add("duplicate-canonical-id");
  if (
    [...warnings].some(
      (warning) =>
        warning.startsWith("canonical-") ||
        [
          "master-count-unavailable",
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
    lines.push({
      id: line.id,
      points,
      start: head.timeMs / 1000,
      end: tail.timeMs / 1000,
    });
    starts.set(head.id, [...(starts.get(head.id) ?? []), line.id]);
  }
  if (
    warnings.has("missing-line-node") ||
    warnings.has("nonpositive-long-span")
  )
    return unavailable();
  const events: Operation[] = [];
  for (const note of notes) {
    const op = note.operateType;
    if (!note.judged || op === 120 || op === 121) continue;
    if (DOWNS.has(op) || FLICKS.has(op) || TRACES.has(op) || TAILS.has(op)) {
      if (DOWNS.has(op)) quality.downCount++;
      if (FLICKS.has(op)) quality.flickCount++;
      if (TRACES.has(op)) quality.traceCheckCount++;
      if (TAILS.has(op)) quality.tailCheckCount++;
      events.push({
        time: note.timeMs / 1000,
        note,
        base:
          DOWNS.has(op) || FLICKS.has(op)
            ? 1
            : TAILS.has(op) || op === 21 || op === 62
              ? 0.15
              : 0.35,
        starts: starts.get(note.id) ?? [],
      });
    }
    // Maintained endpoints/checkpoints are low-weight contact phases, never new down impulses.
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
      events.push({
        time: note.timeMs / 1000,
        note,
        base: 0.35,
        starts: [line.id],
      });
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
  for (const event of events)
    groups.set(event.time, [...(groups.get(event.time) ?? []), event]);
  if ([...groups.values()].some((group) => group.length > 8)) {
    warnings.add("unsupported-contact-demand");
    return unavailable();
  }
  const times = new Set<number>([duration, ...groups.keys()]);
  for (let index = 0; index <= Math.floor(duration / 0.05); index++)
    times.add(index * 0.05);
  for (const event of chart.bpmChanges) {
    if (
      !Number.isFinite(event.timeMs) ||
      !Number.isFinite(event.bpm) ||
      event.bpm <= 0
    ) {
      warnings.add("invalid-bpm");
      return unavailable();
    }
  }
  for (const event of chart.timeScaleChanges) {
    if (
      !Number.isFinite(event.timeMs) ||
      !Number.isFinite(event.scale) ||
      event.scale <= 0
    ) {
      warnings.add("nonpositive-scroll-scale");
      return unavailable();
    }
  }
  let reading: ReturnType<typeof readingTimeline>;
  try {
    reading = readingTimeline(
      chart,
      CHART_DIFFICULTY_PARAMETERS.noteSpeed,
      CHART_DIFFICULTY_PARAMETERS.nearPairApproachGap,
    );
  } catch {
    warnings.add("reading-window-budget");
    return unavailable();
  }
  const extraTouchTimes: number[] = [];
  const gestureTimes: number[][] = [[], []];
  let searchStates = 0;
  let handoffCount = 0,
    shortSameHandGestures = 0,
    minSameHandIoiMs: number | null = null;
  const position = [...CHART_DIFFICULTY_PARAMETERS.initialContacts],
    last = [-2, -2],
    handStrain = [0, 0],
    owners = new Map<number, number>(),
    directions = new Map<number, number>();
  const state = emptyComponents(),
    peaks = new Map<string, Map<number, number>>(
      ["temporal", "rich", ...COMPONENTS].map((key) => [key, new Map()]),
    );
  let globalStrain = 0,
    fatigue = 0,
    previousTime = 0,
    previousGroup: number | null = null,
    previousIoi: number | null = null;
  for (const time of [...times].sort((a, b) => a - b)) {
    const dt = Math.max(0, time - previousTime),
      decay = 0.3 ** dt;
    globalStrain *= decay;
    for (const hand of [0, 1])
      handStrain[hand] = handStrain[hand]! * 0.125 ** dt;
    for (const key of FACTORS) state[key] *= decay;
    const active = lines.filter(
      (line) => line.start <= time && time < line.end,
    );
    const rows = groups.get(time) ?? [];
    if (active.length > 8 || active.length + rows.length > 13) {
      warnings.add("contact-search-budget");
      return unavailable();
    }
    const activeRanges = active.map((line) => trajectory(line, time));
    const previouslyHeld = new Set(
      active
        .filter((line) => line.start < time && owners.has(line.id))
        .map((line) => owners.get(line.id)!),
    );
    let bestCost = Infinity;
    let bestTargets = [...position];
    let bestRows: number[] = [];
    let bestOwners: number[] = [];
    // Jointly cover maintained ranges and manual phases. A fresh press cannot
    // use a contact that must continue an old long at this timestamp.
    for (let mask = 0; mask < 2 ** rows.length; mask++) {
      const rowHands = rows.map((_, i) => (mask >> (rows.length - 1 - i)) & 1);
      for (let holdMask = 0; holdMask < 2 ** active.length; holdMask++) {
        if (++searchStates > CHART_DIFFICULTY_PARAMETERS.maxSearchStates) {
          warnings.add("contact-search-budget");
          return unavailable();
        }
        const ownerHands = active.map((_, i) => (holdMask >> i) & 1),
          targets = [...position];
        let cost = 0,
          valid = true;
        for (const hand of [0, 1]) {
          const assigned = rows.filter((_, i) => rowHands[i] === hand);
          const gestures = assigned.filter(
            (row) =>
              DOWNS.has(row.note.operateType) ||
              FLICKS.has(row.note.operateType),
          );
          if (gestures.length > 1) {
            valid = false;
            break;
          }
          const heldIndices = active
            .map((_, i) => i)
            .filter((i) => ownerHands[i] === hand);
          const oldHeld = heldIndices.filter((i) => active[i]!.start < time);
          if (
            assigned.some((row) => DOWNS.has(row.note.operateType)) &&
            oldHeld.length
          ) {
            valid = false;
            break;
          }
          if (
            assigned.some((row) =>
              row.starts.some((id) => {
                const index = active.findIndex((line) => line.id === id);
                return index >= 0 && ownerHands[index] !== hand;
              }),
            )
          ) {
            valid = false;
            break;
          }
          const ranges = [
            ...assigned.map((row) => interval(row.note)),
            ...heldIndices.map((i) => activeRanges[i]!),
          ];
          if (!ranges.length) continue;
          const low = Math.max(...ranges.map((range) => range[0])),
            high = Math.min(...ranges.map((range) => range[1]));
          if (low > high + 1e-8) {
            valid = false;
            break;
          }
          const target = clamp(
            position[hand]!,
            Math.min(low, high),
            Math.max(low, high),
          );
          targets[hand] = target;
          const elapsed = assigned.length
            ? Math.max(time - last[hand]!, 0.05)
            : Math.max(dt, 0.05);
          cost += Math.abs(target - position[hand]!) / elapsed;
          if (gestures.length)
            cost += handStrain[hand]! + Math.max(0, 0.2 / elapsed - 1) * 0.15;
        }
        if (!valid) continue;
        const switches = active.filter(
          (line, i) =>
            owners.has(line.id) && owners.get(line.id) !== ownerHands[i],
        ).length;
        const newTouches = new Set(
          active
            .filter(
              (line, i) =>
                line.start < time &&
                owners.has(line.id) &&
                owners.get(line.id) !== ownerHands[i] &&
                !previouslyHeld.has(ownerHands[i]!),
            )
            .map((line) => ownerHands[active.indexOf(line)]!)
            .filter(
              (hand) =>
                !rows.some(
                  (row, i) =>
                    rowHands[i] === hand &&
                    (DOWNS.has(row.note.operateType) ||
                      FLICKS.has(row.note.operateType)),
                ),
            ),
        );
        cost +=
          switches * CHART_DIFFICULTY_PARAMETERS.contactHandoffCost +
          newTouches.size * CHART_DIFFICULTY_PARAMETERS.newHoldContactCost;
        if (cost < bestCost) {
          bestCost = cost;
          bestTargets = targets;
          bestRows = rowHands;
          bestOwners = ownerHands;
        }
      }
    }
    if (!Number.isFinite(bestCost)) {
      warnings.add("two-contact-phase-deadend");
      return unavailable();
    }
    const handoffs = active.filter(
      (line, i) => owners.has(line.id) && owners.get(line.id) !== bestOwners[i],
    ).length;
    handoffCount += handoffs;
    const occupied = new Set(bestOwners);
    const newTouches = new Set(
      active
        .filter(
          (line, i) =>
            line.start < time &&
            owners.has(line.id) &&
            owners.get(line.id) !== bestOwners[i] &&
            !previouslyHeld.has(bestOwners[i]!),
        )
        .map((line) => bestOwners[active.indexOf(line)]!)
        .filter(
          (hand) =>
            !rows.some(
              (row, i) =>
                bestRows[i] === hand &&
                (DOWNS.has(row.note.operateType) ||
                  FLICKS.has(row.note.operateType)),
            ),
        ),
    );
    quality.strategyContactStarts += newTouches.size;
    for (const hand of newTouches) {
      extraTouchTimes.push(time);
      globalStrain += CHART_DIFFICULTY_PARAMETERS.newHoldContactCost;
      handStrain[hand] =
        handStrain[hand]! + CHART_DIFFICULTY_PARAMETERS.newHoldContactCost;
    }
    let holdSpeed = 0,
      movement = 0,
      repeat = 0;
    for (const hand of [0, 1]) {
      const distance = Math.abs(bestTargets[hand]! - position[hand]!);
      const assigned = rows.filter((_, i) => bestRows[i] === hand);
      if (assigned.length) {
        movement += distance / Math.max(time - last[hand]!, 0.05);
        const gestures = assigned.filter(
          (row) =>
            DOWNS.has(row.note.operateType) || FLICKS.has(row.note.operateType),
        );
        if (gestures.length) {
          const previous = gestureTimes[hand]!.at(-1);
          repeat +=
            previous === undefined
              ? 0
              : Math.max(0, 0.2 / Math.max(time - previous, 0.05) - 1) * 0.15;
          if (previous !== undefined) {
            const ioiMs = (time - previous) * 1000;
            minSameHandIoiMs =
              minSameHandIoiMs === null
                ? ioiMs
                : Math.min(minSameHandIoiMs, ioiMs);
            if (ioiMs < 200 - 1e-6) shortSameHandGestures++;
          }
          if (previous !== time) gestureTimes[hand]!.push(time);
        }
        handStrain[hand] =
          handStrain[hand]! + assigned.reduce((sum, row) => sum + row.base, 0);
        last[hand] = time;
      } else if (occupied.has(hand)) holdSpeed += distance / Math.max(dt, 0.05);
      position[hand] = bestTargets[hand]!;
    }
    for (const hand of newTouches) {
      const previous = gestureTimes[hand]!.at(-1);
      if (previous !== time) {
        if (previous !== undefined) {
          const ioiMs = (time - previous) * 1000;
          minSameHandIoiMs =
            minSameHandIoiMs === null
              ? ioiMs
              : Math.min(minSameHandIoiMs, ioiMs);
          if (ioiMs < 200 - 1e-6) shortSameHandGestures++;
        }
        gestureTimes[hand]!.push(time);
        last[hand] = time;
      }
    }
    active.forEach((line, i) => owners.set(line.id, bestOwners[i]!));
    state.holdConstraints += dt * (0.2 * occupied.size + 0.15 * holdSpeed);
    state.handMovement +=
      movement / 4 +
      repeat +
      handoffs * CHART_DIFFICULTY_PARAMETERS.contactHandoffCost;
    if (rows.length) {
      const gestures = rows.filter(
        (row) =>
          DOWNS.has(row.note.operateType) || FLICKS.has(row.note.operateType),
      );
      globalStrain += rows.reduce((sum, row) => sum + row.base, 0);
      state.chords += Math.max(0, gestures.length - 1) ** 1.2;
      state.holdConstraints += 0.15 * occupied.size * gestures.length;
      rows.forEach((row, i) => {
        const hand = bestRows[i]!;
        if (FLICKS.has(row.note.operateType)) {
          state.flick += 1;
          if (
            directions.has(hand) &&
            directions.get(hand) !== row.note.direction
          )
            state.reading += 0.1;
          directions.set(hand, row.note.direction);
        }
      });
      if (gestures.length) {
        if (previousGroup !== null) {
          const ioi = time - previousGroup;
          if (ioi > 0 && previousIoi !== null && previousIoi > 0)
            state.rhythm +=
              Math.min(2, Math.abs(Math.log2(ioi / previousIoi))) * 0.25;
          if (ioi > 0) previousIoi = ioi;
        }
        previousGroup = time;
      }
    }
    state.reading += reading.integral(previousTime, time);
    fatigue =
      fatigue * Math.exp(-dt / 6) +
      (1 - Math.exp(-dt / 6)) *
        Math.max(0, globalStrain + Math.max(...handStrain) - 3);
    state.stamina = fatigue;
    const density = globalStrain + 0.5 * Math.max(...handStrain),
      rich =
        density +
        FACTORS.reduce(
          (sum, key) => sum + CHART_DIFFICULTY_WEIGHTS[key] * state[key],
          0,
        ),
      slot = Math.floor(time / 0.4);
    const values = {
      temporal: globalStrain,
      rich,
      density,
      ...Object.fromEntries(FACTORS.map((key) => [key, state[key]])),
    };
    for (const [key, value] of Object.entries(values))
      peaks
        .get(key)!
        .set(slot, Math.max(peaks.get(key)!.get(slot) ?? 0, value));
    previousTime = time;
  }
  warnings.add("heuristic-no-player-validation");
  warnings.add("two-contact-continuous-phase-approximation");
  warnings.add("player-validation-pending");
  warnings.add("greedy-contact-cover-no-timing-window-search");
  warnings.add("reading-visibility-proxy");
  quality.warnings = [...warnings].sort();
  const pressureEvents = [
    ...events.map((event) => ({ time: event.time, base: event.base })),
    ...extraTouchTimes.map((time) => ({
      time,
      base: CHART_DIFFICULTY_PARAMETERS.newHoldContactCost,
    })),
  ].sort((a, b) => a.time - b.time);
  const globalOperationRate =
    pressureEvents.reduce((sum, event) => sum + event.base, 0) / duration;
  const windowPeak = (windowMs: number) => {
    let last = 0,
      weight = 0,
      maximum = 0;
    for (let first = 0; first < pressureEvents.length; first++) {
      if (last < first) {
        last = first;
        weight = 0;
      }
      while (
        last < pressureEvents.length &&
        pressureEvents[last]!.time <
          pressureEvents[first]!.time + windowMs / 1000
      ) {
        weight += pressureEvents[last]!.base;
        last++;
      }
      maximum = Math.max(maximum, weight / (windowMs / 1000));
      weight -= pressureEvents[first]!.base;
    }
    return maximum;
  };
  const peak1s = windowPeak(CHART_DIFFICULTY_PARAMETERS.peakShortMs),
    peak4s = windowPeak(CHART_DIFFICULTY_PARAMETERS.peakSustainedMs);
  const sustainedPeakRate = Math.max(
    globalOperationRate,
    Math.sqrt(peak1s * peak4s),
  );
  const peakOneHand1s = Math.max(
    ...gestureTimes.map((times) => {
      let last = 0,
        peak = 0;
      for (let first = 0; first < times.length; first++) {
        while (last < times.length && times[last]! < times[first]! + 1 - 1e-9)
          last++;
        peak = Math.max(peak, last - first);
      }
      return peak;
    }),
  );
  const gestureIois = gestureTimes
    .flatMap((times) =>
      times.slice(1).map((time, i) => (time - times[i]!) * 1000),
    )
    .filter((value) => value > 0)
    .sort((a, b) => a - b);
  const p10SameHandIoiMs = gestureIois.length
    ? gestureIois[
        Math.floor(
          (gestureIois.length - 1) * CHART_DIFFICULTY_PARAMETERS.burstQuantile,
        )
      ]!
    : null;
  const shortGestureFraction =
    shortSameHandGestures / Math.max(1, gestureIois.length);
  const singleHandBurst =
    Math.sqrt(shortGestureFraction) *
    (Math.max(
      0,
      Math.log(
        CHART_DIFFICULTY_PARAMETERS.burstReferenceMs /
          (p10SameHandIoiMs ?? CHART_DIFFICULTY_PARAMETERS.burstReferenceMs),
      ),
    ) +
      Math.log1p(
        Math.max(
          0,
          peakOneHand1s /
            (1000 / CHART_DIFFICULTY_PARAMETERS.burstReferenceMs) -
            1,
        ),
      ));
  return {
    raw: {
      manualRate: globalOperationRate,
      p10SameHandIoiMs,
      shortGestureFraction,
      singleHandBurst,
      globalOperationRate,
      sustainedPeakRate,
      peak1s,
      peak4s,
      peakExcessRate: Math.max(0, sustainedPeakRate - globalOperationRate),
      handoffCount,
      shortSameHandGestures,
      minSameHandIoiMs,
      peakOneHand1s,
      contactGestureCount: gestureTimes.reduce(
        (sum, times) => sum + times.length,
        0,
      ),
      prescribedGestureCount: events.filter(
        (event) =>
          DOWNS.has(event.note.operateType) ||
          FLICKS.has(event.note.operateType),
      ).length,
      temporalStrain: aggregate(peaks.get("temporal")!.values()),
      operationStrain: aggregate(peaks.get("rich")!.values()),
    },
    components: Object.fromEntries(
      COMPONENTS.map((key) => [key, aggregate(peaks.get(key)!.values())]),
    ) as Record<DifficultyComponent, number>,
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
    components:
      feature.quality.status === "unavailable" ? null : feature.components,
    quality: feature.quality,
    units: "relative-strain",
    pin: { ...input.pin, calibrationSha256: calibration?.sha256 ?? null },
  };
  if (feature.quality.status === "unavailable") return result;
  if (
    !calibration ||
    calibration.version !== CHART_DIFFICULTY_VERSION ||
    calibration.kind !== "theil-sen-operation-skills-v3" ||
    !/^[a-f0-9]{64}$/.test(calibration.sha256) ||
    ![
      calibration.slope,
      calibration.intercept,
      ...calibration.xRange,
      calibration.rateWeight,
      calibration.strainWeight,
      calibration.burstWeight,
    ].every(Number.isFinite) ||
    calibration.slope <= 0 ||
    calibration.xRange[0] > calibration.xRange[1] ||
    calibration.rateWeight < 0 ||
    calibration.strainWeight < 0 ||
    calibration.burstWeight < 0
  ) {
    warnings.push("calibration-unavailable");
    result.quality.status = "unavailable";
    result.quality.confidence = null;
    return result;
  }
  if (
    calibration.featureProfileSha256 !== CHART_DIFFICULTY_PROFILE_SHA256 ||
    calibration.algorithmSha256 !== input.pin.algorithmSha256
  ) {
    warnings.push("calibration-feature-profile-mismatch");
    result.quality.status = "unavailable";
    result.quality.confidence = null;
    return result;
  }
  if (
    calibration.canonicalConverterSha256 !== input.pin.canonicalConverterSha256
  ) {
    warnings.push("calibration-converter-mismatch");
    result.quality.status = "unavailable";
    result.quality.confidence = null;
    return result;
  }
  const x =
    calibration.rateWeight * Math.log1p(feature.raw.manualRate) +
    calibration.strainWeight * Math.log1p(feature.raw.operationStrain) +
    calibration.burstWeight * (feature.raw.singleHandBurst ?? 0);
  if (x < calibration.xRange[0] - 1e-9 || x > calibration.xRange[1] + 1e-9) {
    warnings.push("outside-calibration-range");
    result.quality.status = "unavailable";
    result.quality.confidence = null;
    return result;
  }
  result.estimatedConstant =
    Math.round((calibration.intercept + calibration.slope * x) * 10) / 10;
  return result;
}
