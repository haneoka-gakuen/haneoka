/** Per-master LRU of native Gekisou traces, independent of final power and ordinary live/support skills. */
import { gekisoPerformer, type GekisoChart, type GekisoContext } from "./gekiso";
import type { Performer } from "./full/model";

export class GekisoContextCache {
  private readonly charts = new WeakMap<GekisoChart, number>();
  private nextChart = 0;
  private nextPrefix = 0;
  private readonly prefixes = new Map<string, number>();
  private prefixBytes = 0;
  private readonly entries = new Map<string, { value: GekisoContext; bytes: number }>();
  private usedBytes = 0;
  computations = 0;
  hits = 0;

  constructor(readonly maxBytes = 4 * 1024 * 1024) {}

  /** Keep performer order and all condition metadata: changing leader, tags or skill categories can change the
   * native trace. Only the same two fields removed by gekisoContext itself are omitted. Chart identity owns
   * accuracy, mission pattern, timings and rank. This cache must belong to one immutable master/ChartCache. */
  prefix(chart: GekisoChart, deck: readonly Performer[]): string {
    let chartId = this.charts.get(chart);
    if (chartId === undefined) this.charts.set(chart, (chartId = this.nextChart++));
    const key = `${chartId}|${JSON.stringify(deck.map(gekisoPerformer))}`;
    let id = this.prefixes.get(key);
    if (id === undefined) {
      id = this.nextPrefix++;
      const bytes = key.length * 2 + 64;
      while (this.prefixes.size && this.prefixBytes + bytes > this.maxBytes / 4) {
        const oldest = this.prefixes.keys().next().value!;
        this.prefixBytes -= oldest.length * 2 + 64;
        this.prefixes.delete(oldest);
      }
      // Fresh monotonically increasing ids prevent old entries from matching an evicted identity.
      if (bytes <= this.maxBytes / 4) {
        this.prefixes.set(key, id);
        this.prefixBytes += bytes;
        this.trim(0);
      }
    } else {
      this.prefixes.delete(key);
      this.prefixes.set(key, id);
    }
    return `${id}|`;
  }

  context(prefix: string, seed: number, compute: () => GekisoContext): GekisoContext {
    const key = prefix + seed;
    const entry = this.entries.get(key);
    if (entry) {
      this.entries.delete(key);
      this.entries.set(key, entry);
      this.hits++;
      return entry.value;
    }
    const value = compute();
    this.computations++;
    const bytes =
      key.length * 2 +
      256 +
      value.judgement.byteLength +
      value.gk.byteLength +
      value.up.byteLength +
      value.luck.byteLength;
    if (bytes > this.maxBytes) return value;
    this.trim(bytes);
    if (this.usedBytes + this.prefixBytes + bytes <= this.maxBytes) {
      this.entries.set(key, { value, bytes });
      this.usedBytes += bytes;
    }
    return value;
  }

  private trim(incoming: number): void {
    while (this.entries.size && this.usedBytes + this.prefixBytes + incoming > this.maxBytes) {
      const oldest = this.entries.keys().next().value!;
      this.usedBytes -= this.entries.get(oldest)!.bytes;
      this.entries.delete(oldest);
    }
  }

  get size(): number {
    return this.entries.size;
  }
  /** Accounted buffers, key strings and entry overhead; not a measurement of the browser's entire heap. */
  get bytes(): number {
    return this.usedBytes + this.prefixBytes;
  }
}
