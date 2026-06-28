import type { ChartTimeScaleChange, SsBpm, SsSig } from "./types";

export const PPQ = 480;
const MAX_SUPPORTED_BPM = 10_000;

interface VisualTimeSegment {
  timeMs: number;
  scaledTimeMs: number;
  scale: number;
}

/**
 * Piecewise-linear Sonolus visual time. Positive scales keep the mapping
 * monotonic, so the same map can also clip ribbons in scaled-time space.
 */
export class VisualTimeMap {
  private readonly segments: readonly VisualTimeSegment[];

  constructor(changes: readonly ChartTimeScaleChange[] = []) {
    const normalized = changes
      .filter(
        (change) =>
          Number.isFinite(change.timeMs) && change.timeMs >= 0 && Number.isFinite(change.scale) && change.scale > 0,
      )
      .sort((left, right) => left.timeMs - right.timeMs);
    const segments: VisualTimeSegment[] = [{ timeMs: 0, scaledTimeMs: 0, scale: 1 }];
    for (const change of normalized) {
      const previous = segments[segments.length - 1]!;
      if (change.timeMs === previous.timeMs) {
        previous.scale = change.scale;
        continue;
      }
      segments.push({
        timeMs: change.timeMs,
        scaledTimeMs: previous.scaledTimeMs + (change.timeMs - previous.timeMs) * previous.scale,
        scale: change.scale,
      });
    }
    this.segments = segments;
  }

  toScaledTimeMs(timeMs: number): number {
    if (!Number.isFinite(timeMs)) return 0;
    if (timeMs < 0) return timeMs;
    let low = 0;
    let high = this.segments.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (this.segments[middle]!.timeMs <= timeMs) low = middle + 1;
      else high = middle;
    }
    const segment = this.segments[Math.max(0, low - 1)]!;
    return segment.scaledTimeMs + (timeMs - segment.timeMs) * segment.scale;
  }

  toTimeMs(scaledTimeMs: number): number {
    if (!Number.isFinite(scaledTimeMs)) return 0;
    if (scaledTimeMs < 0) return scaledTimeMs;
    let low = 0;
    let high = this.segments.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (this.segments[middle]!.scaledTimeMs <= scaledTimeMs) low = middle + 1;
      else high = middle;
    }
    const segment = this.segments[Math.max(0, low - 1)]!;
    return segment.timeMs + (scaledTimeMs - segment.scaledTimeMs) / segment.scale;
  }
}

interface BpmSegment {
  startTick: number;
  startTimeMs: number;
  eventTimeMs: number;
  bpm: number;
}

interface SignatureSegment {
  startTick: number;
  startBar: number;
  eventTimeMs: number;
  ticksPerMeasure: number;
  quarterBeatsPerMeasure: number;
}

export interface BarPosition {
  bar: number;
  progress: number;
}

function roundToEven(value: number): number {
  const floor = Math.floor(value);
  const fraction = value - floor;
  if (fraction < 0.5) return floor;
  if (fraction > 0.5) return floor + 1;
  return floor % 2 === 0 ? floor : floor + 1;
}

function tickDurationMs(deltaTick: number, bpm: number): number {
  // The BPM-to-time conversion multiplies BPM * 480 in single precision
  // before the double division.
  return (deltaTick * 60_000) / Math.fround(bpm * PPQ);
}

export class TickConverter {
  private readonly bpmSegments: BpmSegment[];
  private readonly signatureSegments: SignatureSegment[];

  constructor(bpms: SsBpm[], signatures: SsSig[] = []) {
    for (const [index, point] of bpms.entries()) {
      if (!Number.isFinite(point.t) || !Number.isFinite(point.bpm) || point.bpm <= 0 || point.bpm > MAX_SUPPORTED_BPM) {
        throw new RangeError(`Invalid BPM event at index ${index}.`);
      }
    }
    for (const [index, point] of signatures.entries()) {
      const [numerator, denominator] = point.sig;
      if (
        !Number.isFinite(point.t) ||
        !Number.isFinite(numerator) ||
        !Number.isFinite(denominator) ||
        numerator <= 0 ||
        denominator <= 0
      ) {
        throw new RangeError(`Invalid time-signature event at index ${index}.`);
      }
    }
    const bpmPoints = (bpms.length ? [...bpms] : [{ t: 0, bpm: 120 }]).sort((a, b) => a.t - b.t);
    if (bpmPoints[0]!.t > 0) bpmPoints.unshift({ t: 0, bpm: 120 });
    this.bpmSegments = [];
    let previousBpm: BpmSegment | undefined;
    let accumulatedTimeMs = 0;
    for (const point of bpmPoints) {
      if (previousBpm) {
        accumulatedTimeMs += tickDurationMs(point.t - previousBpm.startTick, previousBpm.bpm);
      }
      const startTimeMs = roundToEven(accumulatedTimeMs);
      previousBpm = {
        startTick: point.t,
        startTimeMs,
        eventTimeMs: startTimeMs,
        bpm: Math.fround(point.bpm),
      };
      this.bpmSegments.push(previousBpm);
    }

    const signaturePoints = (signatures.length ? [...signatures] : [{ t: 0, sig: [4, 4] as [number, number] }]).sort(
      (a, b) => a.t - b.t,
    );
    if (signaturePoints[0]!.t > 0) signaturePoints.unshift({ t: 0, sig: [4, 4] });
    this.signatureSegments = [];
    let previousSignature: SignatureSegment | undefined;
    for (const point of signaturePoints) {
      const measureTicks = ticksPerMeasure(point.sig[0], point.sig[1]);
      const startBar = previousSignature
        ? previousSignature.startBar +
          Math.floor((point.t - previousSignature.startTick) / previousSignature.ticksPerMeasure)
        : 0;
      previousSignature = {
        startTick: point.t,
        startBar,
        eventTimeMs: this.tickToTimeMs(point.t),
        ticksPerMeasure: measureTicks,
        quarterBeatsPerMeasure: Math.fround(Math.fround(point.sig[0] * 4) / point.sig[1]),
      };
      this.signatureSegments.push(previousSignature);
    }
  }

  tickToTimeMs(tick: number): number {
    let segment = this.bpmSegments[0]!;
    for (const candidate of this.bpmSegments) {
      if (candidate.startTick > tick) break;
      segment = candidate;
    }
    return Math.floor(segment.startTimeMs + tickDurationMs(tick - segment.startTick, segment.bpm));
  }

  timeMsToTick(timeMs: number): number {
    let segment = this.bpmSegments[0]!;
    for (const candidate of this.bpmSegments) {
      if (candidate.startTimeMs > timeMs) break;
      segment = candidate;
    }
    return segment.startTick + ((timeMs - segment.startTimeMs) * Math.fround(segment.bpm * PPQ)) / 60_000;
  }

  timeMsToBeat(timeMs: number): number {
    return this.timeMsToTick(timeMs) / PPQ;
  }

  bpmAtTimeMs(timeMs: number): number {
    let segment = this.bpmSegments[0]!;
    for (const candidate of this.bpmSegments) {
      // GetBpmAtTimeMs compares the integer TimeMs stored on
      // BPMChangeEvent.MusicScorePosition, not the converter's unrounded
      // accumulated duration.
      if (candidate.eventTimeMs > timeMs) break;
      segment = candidate;
    }
    return segment.bpm;
  }

  tickToBarPosition(tick: number): BarPosition {
    let segment = this.signatureSegments[0]!;
    for (const candidate of this.signatureSegments) {
      if (candidate.startTick > tick) break;
      segment = candidate;
    }
    const delta = tick - segment.startTick;
    const barDelta = Math.floor(delta / segment.ticksPerMeasure);
    return {
      bar: segment.startBar + barDelta,
      // TickToBarPosition performs the division in `float`.
      progress: Math.fround((delta - barDelta * segment.ticksPerMeasure) / segment.ticksPerMeasure),
    };
  }

  timeMsToBarPosition(timeMs: number): BarPosition {
    // MusicScoreNoteCreator.GetPositionFromTimeMs does not invert
    // TickToTimeMs. It anchors at the latest BPM/bar-change event, advances by
    // the current measure duration, and stores BarProgress as a float. This is
    // observable when TrySetSlideNoteId compares generated Combo positions.
    let bpm = this.bpmSegments[0]!;
    for (const candidate of this.bpmSegments) {
      if (candidate.eventTimeMs > timeMs) break;
      bpm = candidate;
    }

    let signature = this.signatureSegments[0]!;
    for (const candidate of this.signatureSegments) {
      if (candidate.eventTimeMs > timeMs) break;
      signature = candidate;
    }

    const bpmAnchor = this.tickToBarPosition(bpm.startTick);
    const signatureAnchor = this.tickToBarPosition(signature.startTick);
    const anchor =
      signature.eventTimeMs >= bpm.eventTimeMs
        ? { ...signatureAnchor, timeMs: signature.eventTimeMs }
        : { ...bpmAnchor, timeMs: bpm.eventTimeMs };
    const measureMs = (signature.quarterBeatsPerMeasure * 60_000) / bpm.bpm;
    const relativeBar = anchor.progress + (timeMs - anchor.timeMs) / measureMs;
    const wholeBars = Math.floor(relativeBar);
    return {
      bar: anchor.bar + wholeBars,
      progress: Math.fround(relativeBar - wholeBars),
    };
  }
}

export function ticksPerMeasure(numerator: number, denominator: number): number {
  return (numerator * 1920) / denominator;
}
