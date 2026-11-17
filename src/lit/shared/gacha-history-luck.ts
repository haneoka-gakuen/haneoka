// L3 — GEB
// Input: Current scoped history and a render notification callback.
// Output: Cached overall/pool ratings with one coalesced browser-worker calculation.
// Pos: [Map](../L2-2.md); gacha history background probability controller.
// Effects/Dependencies: Starts its private worker on demand; reset terminates work and releases numeric caches.
import { gachaLuckInput, type GachaLuckInput, type GachaLuckResult, type GachaLuckSummary } from "../../lib/gacha-history-luck";
import type { GachaHistoryBatch } from "../../lib/gacha-history-view";
import type { GachaLuckRequest, GachaLuckResponse } from "../../workers/gacha-history-luck.worker";

interface Job { id: number; key: string; input: GachaLuckInput }
export class GachaLuckClient {
  private cache = new Map<string, GachaLuckResult>();
  private inputs = new WeakMap<readonly GachaHistoryBatch[], { key: string; input: GachaLuckInput }>();
  private worker?: Worker;
  private running?: Job;
  private queued?: Job;
  private nextId = 0;
  private current = "";
  error = false;
  pending = false;
  constructor(private notify: () => void) {}
  read(batches: readonly GachaHistoryBatch[], active: boolean): GachaLuckResult | undefined {
    if (!active || typeof window === "undefined") return;
    let source = this.inputs.get(batches);
    if (!source) {
      const input = gachaLuckInput(batches);
      source = { input, key: JSON.stringify(input) }; this.inputs.set(batches, source);
    }
    const { key, input } = source;
    if (this.current !== key) { this.current = key; this.error = false; }
    const cached = this.cache.get(key);
    if (cached) { this.queued = undefined; this.pending = false; return cached; }
    if (!Object.values(input.pools).some(pool => pool.knownDraws)) {
      const overall: GachaLuckSummary = { combined: null, high: null, pickup: null, knownDraws: 0, unknownDraws: 0, itemDraws: 0 };
      const pools = Object.fromEntries(Object.entries(input.pools).map(([id, scope]) => {
        overall.unknownDraws += scope.unknownDraws; overall.itemDraws += scope.itemDraws;
        return [id, { combined: null, high: null, pickup: null, knownDraws: 0, unknownDraws: scope.unknownDraws, itemDraws: scope.itemDraws }];
      }));
      const result = { overall, pools }; this.remember(key, result); this.queued = undefined; this.pending = false; return result;
    }
    if (this.error) return;
    this.pending = true;
    if (this.running?.key === key) { this.queued = undefined; return; }
    if (this.queued?.key === key) return;
    const job = { id: ++this.nextId, key, input };
    if (this.running) this.queued = job; else this.send(job);
    return;
  }
  private remember(key: string, result: GachaLuckResult) {
    this.cache.set(key, result);
    while (this.cache.size > 12) this.cache.delete(this.cache.keys().next().value!);
  }
  private send(job: Job) {
    try {
      if (!this.worker) {
        this.worker = new Worker(new URL("../../workers/gacha-history-luck.worker.ts", import.meta.url), { type: "module" });
        this.worker.onerror = () => this.fail();
        this.worker.onmessage = ({ data }: MessageEvent<GachaLuckResponse>) => {
          const running = this.running;
          if (!running || running.id !== data.id) return;
          this.running = undefined;
          if (data.result) this.remember(running.key, data.result);
          else if (running.key === this.current) this.error = true;
          if (running.key === this.current) { this.pending = false; this.notify(); }
          const queued = this.queued; this.queued = undefined;
          if (queued) this.send(queued);
        };
      }
      this.running = job;
      this.worker.postMessage({ id: job.id, input: job.input } satisfies GachaLuckRequest);
    } catch { this.fail(); }
  }
  private fail() {
    this.worker?.terminate(); this.worker = undefined; this.running = this.queued = undefined;
    this.error = !this.cache.has(this.current); this.pending = false; this.notify();
  }
  reset() {
    this.worker?.terminate(); this.worker = undefined; this.running = this.queued = undefined;
    this.cache.clear(); this.inputs = new WeakMap(); this.current = ""; this.error = this.pending = false;
  }
}
