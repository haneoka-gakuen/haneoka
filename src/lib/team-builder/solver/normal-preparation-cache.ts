import { normalSkillPreparationKeyInput } from "../normal-skill-key.ts";
import {
  buildNormalSkillWindows,
  normalSkillOrders,
  type NormalSkillInput,
  type NormalSkillResult,
} from "./normal-skills.ts";
import type { SearchEvaluationControls } from "../optimizer.ts";

type Frozen<T> = T extends readonly (infer V)[]
  ? readonly Frozen<V>[]
  : T extends object
    ? { readonly [K in keyof T]: Frozen<T[K]> }
    : T;
export type NormalPreparationInput = Omit<NormalSkillInput, "order">;
export interface PreparedNormalOrders {
  /** All 120 nominal orders remain separate and retain their original weight. */
  entries: readonly { order: readonly number[]; result: Frozen<NormalSkillResult> }[];
  /** A gap-bearing first result is returned to the caller without caching. */
  complete: boolean;
}
export interface NormalPreparationCacheLimits {
  maxEntries: number;
  /** UTF-8 size of exact keys and serialized prepared results, excluding JS object overhead. */
  maxSerializedBytes: number;
}

// Arrays retain native slot/effect/target/trigger order. Only object field names
// are canonicalized. Tagged numbers preserve -0 and distinguish absent values.
function exactValue(value: unknown): unknown {
  if (value === undefined) return ["undefined"];
  if (value === null) return ["null"];
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("preparation-nonfinite");
    return ["number", Object.is(value, -0) ? "-0" : String(value)];
  }
  if (typeof value === "string" || typeof value === "boolean") return [typeof value, value];
  if (Array.isArray(value)) return ["array", value.map(exactValue)];
  if (typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype)
    throw new TypeError("preparation-nonplain");
  return ["object", Object.keys(value).sort().map((key) => [key, exactValue((value as Record<string, unknown>)[key])])];
}
function freeze<T>(value: T): Frozen<T> {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value as Frozen<T>;
}

/** One cache per immutable scorer/resolved input generation. Reuse prepared
 * commands across powers; every integer note score, rank and reward remains in
 * the caller. A changed photo slot, effect, trigger or frame produces a miss.
 * Cancellation and gap-bearing preparations are never saved as complete work.
 */
export function createNormalPreparationCache(
  limits: NormalPreparationCacheLimits = { maxEntries: 8, maxSerializedBytes: 4 * 1024 * 1024 },
  build: (input: NormalSkillInput) => NormalSkillResult = buildNormalSkillWindows,
) {
  if (
    !Number.isSafeInteger(limits.maxEntries) || limits.maxEntries < 1 || limits.maxEntries > 64 ||
    !Number.isSafeInteger(limits.maxSerializedBytes) || limits.maxSerializedBytes < 1 ||
    limits.maxSerializedBytes > 16 * 1024 * 1024
  ) throw new RangeError("normal-preparation-cache-budget");
  const orders = freeze(normalSkillOrders());
  const encoder = new TextEncoder();
  const entries = new Map<string, { value: PreparedNormalOrders; bytes: number }>();
  let bytes = 0, hits = 0, misses = 0, builds = 0, evictions = 0, generation = 0;
  const interrupted = (controls?: SearchEvaluationControls) => controls?.cancelled() || controls?.expired();
  return {
    async prepare(
      input: NormalPreparationInput,
      controls?: SearchEvaluationControls,
    ): Promise<PreparedNormalOrders | null> {
      if (interrupted(controls)) return null;
      let key: string | null;
      try {
        key = JSON.stringify(exactValue(normalSkillPreparationKeyInput(input)));
      } catch {
        // Invalid inputs still reach the authoritative builder and its own gaps.
        key = null;
      }
      const found = key === null ? undefined : entries.get(key);
      if (found) {
        entries.delete(key!);
        entries.set(key!, found);
        hits++;
        return found.value;
      }
      misses++;
      const startedGeneration = generation;
      // Yielding lets cancellation messages run; retain the exact keyed inputs
      // even if their caller replaces mutable practice while preparation runs.
      const snapshot = structuredClone(input);
      const prepared: { order: readonly number[]; result: Frozen<NormalSkillResult> }[] = [];
      let complete = true;
      for (const [index, order] of orders.entries()) {
        if (interrupted(controls)) return null;
        if (controls && index && index % 8 === 0) {
          controls.progress();
          await controls.yield();
          if (interrupted(controls)) return null;
        }
        const result = build({ ...snapshot, order });
        builds++;
        complete &&= result.gaps.length === 0;
        prepared.push({ order, result: freeze(result) });
        // A gap is already sufficient for the scorer's unavailable result.
        if (!complete) break;
      }
      if (interrupted(controls)) return null;
      const value = freeze({ entries: prepared, complete });
      if (key !== null && complete && startedGeneration === generation) {
        let size: number;
        try {
          size = encoder.encode(key).byteLength + encoder.encode(JSON.stringify(value)).byteLength;
        } catch {
          return value;
        }
        if (size <= limits.maxSerializedBytes) {
          // Another pending preparation may have committed the same key.
          const previous = entries.get(key);
          if (previous) {
            bytes -= previous.bytes;
            entries.delete(key);
          }
          while (entries.size && (entries.size >= limits.maxEntries || bytes + size > limits.maxSerializedBytes)) {
            const oldestKey = entries.keys().next().value!;
            bytes -= entries.get(oldestKey)!.bytes;
            entries.delete(oldestKey);
            evictions++;
          }
          entries.set(key, { value, bytes: size });
          bytes += size;
        }
      }
      return value;
    },
    clear() {
      generation++;
      entries.clear();
      bytes = 0;
    },
    stats() {
      return { entries: entries.size, serializedBytes: bytes, hits, misses, builds, evictions };
    },
  };
}
