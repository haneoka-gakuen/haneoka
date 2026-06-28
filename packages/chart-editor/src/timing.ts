import { PROJECT_RESOLUTION, beatToTick, tickToBeat, type MeterEvent, type Project, type TempoEvent } from "./model";

interface TempoSegment {
  tick: number;
  seconds: number;
  bpm: number;
}

const finite = (value: number, label: string): number => {
  if (!Number.isFinite(value)) throw new TypeError(`${label} must be finite`);
  return value;
};

const upperBound = <T>(items: readonly T[], value: number, get: (item: T) => number): number => {
  let low = 0;
  let high = items.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (get(items[mid]!) <= value) low = mid + 1;
    else high = mid;
  }
  return Math.max(0, low - 1);
};

export class TempoMap {
  readonly resolution: number;
  readonly audioOffset: number;
  readonly tempos: readonly TempoEvent[];
  private readonly segments: readonly TempoSegment[];

  constructor(tempos: readonly TempoEvent[], options: { resolution?: number; audioOffset?: number } = {}) {
    this.resolution = options.resolution ?? PROJECT_RESOLUTION;
    this.audioOffset = finite(options.audioOffset ?? 0, "Audio offset");
    if (!Number.isSafeInteger(this.resolution) || this.resolution <= 0) {
      throw new RangeError("Resolution must be a positive safe integer");
    }
    if (!tempos.length) throw new RangeError("Tempo map must contain at least one tempo");

    const sorted = [...tempos].sort((a, b) => a.tick - b.tick || a.id.localeCompare(b.id));
    if (sorted[0]!.tick !== 0) throw new RangeError("Tempo map must start at tick 0");
    for (const [index, tempo] of sorted.entries()) {
      if (!Number.isSafeInteger(tempo.tick) || tempo.tick < 0) throw new RangeError(`Invalid tempo tick at ${index}`);
      if (!Number.isFinite(tempo.bpm) || tempo.bpm <= 0) throw new RangeError(`Invalid BPM at ${index}`);
      if (index > 0 && sorted[index - 1]!.tick === tempo.tick) {
        throw new RangeError(`Duplicate tempo tick ${tempo.tick}`);
      }
    }
    this.tempos = sorted;

    const segments: TempoSegment[] = [];
    let seconds = this.audioOffset;
    for (const [index, tempo] of sorted.entries()) {
      const previous = sorted[index - 1];
      if (previous) seconds += ((tempo.tick - previous.tick) / this.resolution) * (60 / previous.bpm);
      segments.push({ tick: tempo.tick, seconds, bpm: tempo.bpm });
    }
    this.segments = segments;
  }

  tickToSeconds(tick: number): number {
    finite(tick, "Tick");
    const segment = this.segments[upperBound(this.segments, tick, (item) => item.tick)]!;
    return segment.seconds + ((tick - segment.tick) / this.resolution) * (60 / segment.bpm);
  }

  beatToSeconds(beat: number): number {
    finite(beat, "Beat");
    return this.tickToSeconds(beat * this.resolution);
  }

  secondsToTick(seconds: number): number {
    finite(seconds, "Seconds");
    const segment = this.segments[upperBound(this.segments, seconds, (item) => item.seconds)]!;
    return segment.tick + ((seconds - segment.seconds) * segment.bpm * this.resolution) / 60;
  }

  secondsToBeat(seconds: number): number {
    return this.secondsToTick(seconds) / this.resolution;
  }

  bpmAtTick(tick: number): number {
    finite(tick, "Tick");
    return this.segments[upperBound(this.segments, tick, (item) => item.tick)]!.bpm;
  }

  bpmAtSeconds(seconds: number): number {
    finite(seconds, "Seconds");
    return this.segments[upperBound(this.segments, seconds, (item) => item.seconds)]!.bpm;
  }
}

export type SnapMode = "nearest" | "floor" | "ceil";

/** Snap a tick to a beat subdivision and always return an integer canonical tick. */
export const snapTick = (
  tick: number,
  subdivision = 4,
  mode: SnapMode = "nearest",
  resolution = PROJECT_RESOLUTION,
): number => {
  finite(tick, "Tick");
  if (!Number.isSafeInteger(subdivision) || subdivision <= 0) throw new RangeError("Subdivision must be positive");
  if (!Number.isSafeInteger(resolution) || resolution <= 0) throw new RangeError("Resolution must be positive");
  const units = (tick * subdivision) / resolution;
  const snapped = mode === "floor" ? Math.floor(units) : mode === "ceil" ? Math.ceil(units) : Math.round(units);
  return Math.round((snapped * resolution) / subdivision);
};

export const snapBeat = (
  beat: number,
  subdivision = 4,
  mode: SnapMode = "nearest",
  resolution = PROJECT_RESOLUTION,
): number => snapTick(beat * resolution, subdivision, mode, resolution);

export const projectDurationTick = (project: Project): number =>
  Math.max(
    0,
    ...project.tempos.map((item) => item.tick),
    ...project.meters.map((item) => item.tick),
    ...project.timeScales.map((item) => item.tick),
    ...project.singles.map((item) => item.tick),
    ...project.lines.flatMap((line) => line.points.map((point) => point.tick)),
    ...project.markers.skill,
    ...project.markers.fever.flat(),
    ...project.markers.call.map((item) => item.tick),
  );

export const projectDurationBeat = (project: Project): number =>
  tickToBeat(projectDurationTick(project), project.resolution);

export const projectDurationSeconds = (project: Project): number =>
  new TempoMap(project.tempos, {
    resolution: project.resolution,
    audioOffset: project.audioOffset,
  }).tickToSeconds(projectDurationTick(project));

export const meterAtTick = (meters: readonly MeterEvent[], tick: number): MeterEvent | undefined => {
  if (!meters.length) return undefined;
  const sorted = [...meters].sort((a, b) => a.tick - b.tick || a.id.localeCompare(b.id));
  return sorted[upperBound(sorted, tick, (item) => item.tick)];
};

export { beatToTick, tickToBeat };
