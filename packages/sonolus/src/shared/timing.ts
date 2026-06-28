export const PPQ = 480;

export interface BpmPoint {
  t: number;
  bpm: number;
}
export interface SigPoint {
  t: number;
  sig: [number, number];
}

interface BpmSeg {
  startTick: number;
  startTimeMs: number;
  eventTimeMs: number;
  bpm: number;
}
interface SigSeg {
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
  // Uses a single-precision BPM*480 denominator and a double division.
  return (deltaTick * 60000) / Math.fround(bpm * PPQ);
}

export class TickConverter {
  private readonly segs: BpmSeg[];
  private readonly sigs: SigSeg[];

  constructor(bpms: BpmPoint[], sigs: SigPoint[] = []) {
    const pts = (bpms.length ? [...bpms] : [{ t: 0, bpm: 120 }]).sort((a, b) => a.t - b.t);
    if (pts[0].t !== 0) pts.unshift({ t: 0, bpm: 120 });
    const segs: BpmSeg[] = [];
    let prev: BpmSeg | null = null;
    let accumulatedTimeMs = 0;
    for (const p of pts) {
      if (prev) accumulatedTimeMs += tickDurationMs(p.t - prev.startTick, prev.bpm);
      const startTimeMs = roundToEven(accumulatedTimeMs);
      const seg: BpmSeg = {
        startTick: p.t,
        startTimeMs,
        eventTimeMs: startTimeMs,
        bpm: Math.fround(p.bpm),
      };
      segs.push(seg);
      prev = seg;
    }
    this.segs = segs;

    const sigPts = (sigs.length ? [...sigs] : [{ t: 0, sig: [4, 4] as [number, number] }]).sort((a, b) => a.t - b.t);
    if (sigPts[0].t !== 0) sigPts.unshift({ t: 0, sig: [4, 4] });
    const sigSegs: SigSeg[] = [];
    let prevSig: SigSeg | null = null;
    for (const p of sigPts) {
      const ticks = ticksPerMeasure(p.sig[0], p.sig[1]);
      const startBar = prevSig ? prevSig.startBar + Math.floor((p.t - prevSig.startTick) / prevSig.ticksPerMeasure) : 0;
      const seg: SigSeg = {
        startTick: p.t,
        startBar,
        eventTimeMs: this.tickToTimeMs(p.t),
        ticksPerMeasure: ticks,
        quarterBeatsPerMeasure: Math.fround(Math.fround(p.sig[0] * 4) / p.sig[1]),
      };
      sigSegs.push(seg);
      prevSig = seg;
    }
    this.sigs = sigSegs;
  }

  tickToTimeMs(tick: number): number {
    let seg = this.segs[0];
    for (const s of this.segs) {
      if (s.startTick <= tick) seg = s;
      else break;
    }
    return Math.floor(seg.startTimeMs + tickDurationMs(tick - seg.startTick, seg.bpm));
  }

  timeMsToTick(timeMs: number): number {
    let seg = this.segs[0];
    for (const s of this.segs) {
      if (s.startTimeMs <= timeMs) seg = s;
      else break;
    }
    return seg.startTick + ((timeMs - seg.startTimeMs) * Math.fround(seg.bpm * PPQ)) / 60000;
  }

  timeMsToBeat(timeMs: number): number {
    return this.timeMsToTick(timeMs) / PPQ;
  }

  bpmAtTimeMs(timeMs: number): number {
    let seg = this.segs[0];
    for (const s of this.segs) {
      // Uses the BPM change event's integer TimeMs.
      if (s.eventTimeMs <= timeMs) seg = s;
      else break;
    }
    return seg.bpm;
  }

  tickToBeat(tick: number): number {
    return tick / PPQ;
  }

  tickToBarPosition(tick: number): BarPosition {
    let seg = this.sigs[0];
    for (const s of this.sigs) {
      if (s.startTick <= tick) seg = s;
      else break;
    }
    const delta = tick - seg.startTick;
    const barsSinceSeg = Math.floor(delta / seg.ticksPerMeasure);
    const tickInMeasure = delta - barsSinceSeg * seg.ticksPerMeasure;
    return {
      bar: seg.startBar + barsSinceSeg,
      // Divides in single precision.
      progress: Math.fround(tickInMeasure / seg.ticksPerMeasure),
    };
  }

  timeMsToBarPosition(timeMs: number): BarPosition {
    // Anchors at the latest BPM or bar event; it is intentionally not the
    // algebraic inverse of tickToTimeMs.
    let bpm = this.segs[0];
    for (const s of this.segs) {
      if (s.eventTimeMs <= timeMs) bpm = s;
      else break;
    }
    let signature = this.sigs[0];
    for (const s of this.sigs) {
      if (s.eventTimeMs <= timeMs) signature = s;
      else break;
    }

    const bpmAnchor = this.tickToBarPosition(bpm.startTick);
    const signatureAnchor = this.tickToBarPosition(signature.startTick);
    const anchor =
      signature.eventTimeMs >= bpm.eventTimeMs
        ? { ...signatureAnchor, timeMs: signature.eventTimeMs }
        : { ...bpmAnchor, timeMs: bpm.eventTimeMs };
    const measureMs = (signature.quarterBeatsPerMeasure * 60000) / bpm.bpm;
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
