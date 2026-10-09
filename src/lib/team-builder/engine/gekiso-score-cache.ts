/** Bounded, per-release cache of one exact native draw. No note-sized simulation arrays are retained. */
import type { GekisoChart } from "./gekiso";
import type { GekisoJustSummary } from "./gekiso-just";
import type { OrderScores } from "./live";

export interface GekisoScoreDraw {
  scores: OrderScores;
  just: GekisoJustSummary;
}

export class GekisoScoreCache {
  private readonly charts = new WeakMap<GekisoChart, number>();
  private nextChart = 0;
  private nextPrefix = 0;
  private readonly prefixes = new Map<string, number>();
  private prefixBytes = 0;
  private readonly entries = new Map<string, { value: GekisoScoreDraw; bytes: number }>();
  private usedBytes = 0;
  constructor(readonly maxBytes = 8 * 1024 * 1024) {}

  /** The chart owns accuracy, missions, timings and rank. The exact serialized deck/skills and power own all other
   * scoring inputs. This cache belongs to one ChartCache/master, never to a server-global singleton. */
  prefix(chart: GekisoChart, deck: unknown, skills: unknown, power: number): string {
    let id = this.charts.get(chart);
    if (id === undefined) this.charts.set(chart, (id = this.nextChart++));
    const key = `${id}|${JSON.stringify([deck, skills, power])}`;
    let prefix = this.prefixes.get(key);
    if (prefix === undefined) {
      prefix = this.nextPrefix++;
      const bytes = key.length * 2 + 64;
      // Intern the full scoring identity once, not once for each of its 32 draws. Evicted identities receive
      // fresh ids, so an old draw can never accidentally match a different team.
      while (this.prefixes.size && this.prefixBytes + bytes > this.maxBytes / 4) {
        const oldest = this.prefixes.keys().next().value!;
        this.prefixBytes -= oldest.length * 2 + 64;
        this.prefixes.delete(oldest);
      }
      if (bytes <= this.maxBytes / 4) {
        this.prefixes.set(key, prefix);
        this.prefixBytes += bytes;
        this.trim(0);
      }
    } else {
      this.prefixes.delete(key);
      this.prefixes.set(key, prefix);
    }
    return `${prefix}|`;
  }
  get(prefix: string, seed: number): GekisoScoreDraw | undefined {
    const key = prefix + seed;
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }
  put(prefix: string, seed: number, value: GekisoScoreDraw): void {
    const key = prefix + seed;
    const bytes = key.length * 2 + value.scores.scores.byteLength + 256;
    const previous = this.entries.get(key);
    if (previous) {
      this.entries.delete(key);
      this.usedBytes -= previous.bytes;
    }
    if (bytes > this.maxBytes) return;
    this.trim(bytes);
    if (this.usedBytes + this.prefixBytes + bytes > this.maxBytes) return;
    this.entries.set(key, { value, bytes });
    this.usedBytes += bytes;
  }
  private trim(incoming: number) {
    while (this.entries.size && this.usedBytes + this.prefixBytes + incoming > this.maxBytes) {
      const oldest = this.entries.keys().next().value!;
      this.usedBytes -= this.entries.get(oldest)!.bytes;
      this.entries.delete(oldest);
    }
  }
  get size(): number {
    return this.entries.size;
  }
  get bytes(): number {
    return this.usedBytes + this.prefixBytes;
  }
}
