import type { OurNotesRendererStats } from "./types";

export interface ChartPerfRange {
  min: number;
  p95: number;
  max: number;
}

export interface ChartPerfSummary {
  frameCount: number;
  buildMs: ChartPerfRange;
  renderMs: ChartPerfRange;
  totalMs: ChartPerfRange;
  drawCalls: ChartPerfRange;
  triangles: ChartPerfRange;
  maximumActiveNotes: number;
  maximumActiveHolds: number;
  maximumRenderedParticles: number;
  effectRefreshFrames: number;
}

/**
 * Opt-in fixed-storage frame probe. ChartPlayer does not instantiate or call
 * it unless `settings.__perf` is true, keeping the normal render path free of
 * timers, closures and diagnostics allocations.
 */
export class ChartPerfProbe {
  private readonly capacity: number;
  private readonly intervalMs: number;
  private readonly buildSamples: Float64Array;
  private readonly renderSamples: Float64Array;
  private readonly drawCallSamples: Float64Array;
  private readonly triangleSamples: Float64Array;
  private readonly noteSamples: Uint32Array;
  private readonly holdSamples: Uint32Array;
  private readonly particleSamples: Uint32Array;
  private readonly refreshSamples: Uint8Array;
  private readonly scratch: Float64Array;
  private count = 0;
  private cursor = 0;
  private lastSummaryAt = 0;

  constructor(capacity = 240, intervalMs = 500) {
    this.capacity = Math.max(1, Math.floor(capacity));
    this.intervalMs = Math.max(1, intervalMs);
    this.buildSamples = new Float64Array(this.capacity);
    this.renderSamples = new Float64Array(this.capacity);
    this.drawCallSamples = new Float64Array(this.capacity);
    this.triangleSamples = new Float64Array(this.capacity);
    this.noteSamples = new Uint32Array(this.capacity);
    this.holdSamples = new Uint32Array(this.capacity);
    this.particleSamples = new Uint32Array(this.capacity);
    this.refreshSamples = new Uint8Array(this.capacity);
    this.scratch = new Float64Array(this.capacity);
  }

  record(buildMs: number, renderMs: number, stats: OurNotesRendererStats): void {
    const index = this.cursor;
    this.buildSamples[index] = buildMs;
    this.renderSamples[index] = renderMs;
    this.drawCallSamples[index] = stats.drawCalls;
    this.triangleSamples[index] = stats.triangles;
    this.noteSamples[index] = stats.activeNoteVisuals;
    this.holdSamples[index] = stats.activeHoldVisuals;
    this.particleSamples[index] = stats.renderedParticles;
    this.refreshSamples[index] = stats.effectRefreshed ? 1 : 0;
    this.cursor = (index + 1) % this.capacity;
    this.count = Math.min(this.capacity, this.count + 1);
  }

  takeSummary(now: number): ChartPerfSummary | undefined {
    if (this.count === 0) return undefined;
    if (this.lastSummaryAt === 0) {
      this.lastSummaryAt = now;
      return undefined;
    }
    if (now - this.lastSummaryAt < this.intervalMs) return undefined;
    this.lastSummaryAt = now;
    let maximumActiveNotes = 0;
    let maximumActiveHolds = 0;
    let maximumRenderedParticles = 0;
    let effectRefreshFrames = 0;
    for (let index = 0; index < this.count; index += 1) {
      maximumActiveNotes = Math.max(maximumActiveNotes, this.noteSamples[index]!);
      maximumActiveHolds = Math.max(maximumActiveHolds, this.holdSamples[index]!);
      maximumRenderedParticles = Math.max(maximumRenderedParticles, this.particleSamples[index]!);
      effectRefreshFrames += this.refreshSamples[index]!;
    }
    const summary = {
      frameCount: this.count,
      buildMs: this.range(this.buildSamples),
      renderMs: this.range(this.renderSamples),
      totalMs: this.totalRange(),
      drawCalls: this.range(this.drawCallSamples),
      triangles: this.range(this.triangleSamples),
      maximumActiveNotes,
      maximumActiveHolds,
      maximumRenderedParticles,
      effectRefreshFrames,
    };
    this.count = 0;
    this.cursor = 0;
    return summary;
  }

  private range(samples: Float64Array): ChartPerfRange {
    for (let index = 0; index < this.count; index += 1) this.scratch[index] = samples[index]!;
    return this.sortedRange();
  }

  private totalRange(): ChartPerfRange {
    for (let index = 0; index < this.count; index += 1) {
      this.scratch[index] = this.buildSamples[index]! + this.renderSamples[index]!;
    }
    return this.sortedRange();
  }

  private sortedRange(): ChartPerfRange {
    // Insertion sort avoids allocating an Array/subarray on every debug
    // summary. At <=240 entries this is negligible and only runs opt-in.
    for (let index = 1; index < this.count; index += 1) {
      const value = this.scratch[index]!;
      let cursor = index - 1;
      while (cursor >= 0 && this.scratch[cursor]! > value) {
        this.scratch[cursor + 1] = this.scratch[cursor]!;
        cursor -= 1;
      }
      this.scratch[cursor + 1] = value;
    }
    return {
      min: this.scratch[0]!,
      p95: this.scratch[Math.min(this.count - 1, Math.ceil(this.count * 0.95) - 1)]!,
      max: this.scratch[this.count - 1]!,
    };
  }
}
