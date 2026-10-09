/** Exact scores are shared by reward objectives; cache eviction only causes recomputation. */
import type { LiveSettings, OrderScores, PlayModel, PreparedLive } from "./live";
import type { SlotSkill } from "./skills";

export class LiveScoreCache {
  private readonly charts = new WeakMap<PreparedLive, number>();
  private nextChart = 0;
  private readonly entries = new Map<string, { scores: OrderScores; bytes: number }>();
  private usedBytes = 0;
  hits = 0;
  computations = 0;
  constructor(readonly maxBytes = 2 * 1024 * 1024) {}

  score(
    live: PreparedLive,
    play: PlayModel,
    settings: LiveSettings | undefined,
    power: number,
    skills: readonly SlotSkill[],
    compute: () => OrderScores,
  ): OrderScores {
    let chart = this.charts.get(live);
    if (chart === undefined) this.charts.set(live, (chart = this.nextChart++));
    // PreparedLive identifies the immutable master/chart; power and resolved skills already
    // contain the player, practice, leader, photo and challenge-power contributions.
    const key = `${chart}|${JSON.stringify([play, settings, power, skills], (_key, value: unknown) =>
      typeof value === "number" && !Number.isFinite(value) ? String(value) : value,
    )}`;
    const found = this.entries.get(key);
    if (found) {
      this.hits++;
      this.entries.delete(key);
      this.entries.set(key, found);
      return found.scores;
    }
    this.computations++;
    const scores = compute();
    const bytes = key.length * 2 + scores.scores.byteLength + 192;
    if (bytes > this.maxBytes) return scores;
    while (this.entries.size && this.usedBytes + bytes > this.maxBytes) {
      const oldest = this.entries.keys().next().value!;
      this.usedBytes -= this.entries.get(oldest)!.bytes;
      this.entries.delete(oldest);
    }
    this.entries.set(key, { scores, bytes });
    this.usedBytes += bytes;
    return scores;
  }

  get size() {
    return this.entries.size;
  }
  get bytes() {
    return this.usedBytes;
  }
}

/** One module instance per Worker; WeakMap identities never retain the large prepared chart. */
export const liveScoreCache = new LiveScoreCache();
