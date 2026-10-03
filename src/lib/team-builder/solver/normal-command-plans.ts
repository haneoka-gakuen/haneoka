import type { EvidenceGap } from "../contracts.ts";
import type { SearchEvaluationControls } from "../optimizer.ts";
import type { PreparedSong } from "../song-metrics.ts";
import type { buildNormalSkillWindows } from "./normal-skills.ts";

type Skills = { readonly factorCommands: readonly Readonly<ReturnType<typeof buildNormalSkillWindows>["factorCommands"][number]>[] };
export interface NormalCommandInterval { start: number; end: number; factor: number }
type Result = { value: readonly NormalCommandInterval[] | null; gaps: EvidenceGap[] };
interface Entry { song: PreparedSong; skills: Skills; intervals: readonly NormalCommandInterval[]; bytes: number }
const f = Math.fround;

/** Worker/scorer-generation cache. Song and complete prepared order identities
 * include chart timing, effect levels, physical support slots and native owners. */
export function createNormalCommandPlanCache() {
  let lookup = new WeakMap<PreparedSong, WeakMap<Skills, Entry>>();
  const lru = new Map<Entry, true>();
  let bytes = 0, hits = 0, builds = 0, sorts = 0, lowerBounds = 0;
  const remove = (entry: Entry) => {
    lru.delete(entry); lookup.get(entry.song)?.delete(entry.skills); bytes -= entry.bytes;
  };
  const fail = (code: string, source: string): Result => ({ value: null, gaps: [{ code, source }] });
  return {
    stats: () => ({ entries: lru.size, bytes, hits, builds, sorts, lowerBounds }),
    clear() { lookup = new WeakMap(); lru.clear(); bytes = 0; },
    async resolve(song: PreparedSong, skills: Skills, controls: SearchEvaluationControls): Promise<Result> {
      const interrupted = () => controls.cancelled() || controls.expired();
      if (interrupted()) return fail("native-normal-command-plan-interrupted", "worker cancellation/budget");
      const found = lookup.get(song)?.get(skills);
      if (found) { lru.delete(found); lru.set(found, true); hits++; return { value: found.intervals, gaps: [] }; }
      builds++;
      const commands = [...skills.factorCommands];
      const sameTime = new Map<string, (typeof commands)[number]>();
      for (const [index, command] of commands.entries()) {
        if (interrupted()) return fail("native-normal-command-plan-interrupted", "worker cancellation/budget");
        if (index && index % 512 === 0) { controls.progress(); await controls.yield(); }
        const key = `${command.timeMs}:${command.judgement ?? "general"}`, previous = sameTime.get(key);
        if (previous && (previous.factorOwnerId === undefined || command.factorOwnerId === undefined) &&
          previous.handleId !== command.handleId &&
          (previous.memberSkillIndex !== command.memberSkillIndex || previous.effectId !== command.effectId))
          return fail("native-normal-factor-owner-order-unresolved", song.song.key);
        sameTime.set(key, command);
      }
      commands.sort((a, b) => a.timeMs - b.timeMs ||
        (a.factorOwnerId ?? 0) - (b.factorOwnerId ?? 0) || a.sequence - b.sequence);
      sorts++;
      const lowerBound = (timeMs: number) => {
        lowerBounds++;
        let low = 0, high = song.nodes.length;
        while (low < high) { const middle = (low + high) >>> 1;
          if (song.nodes[middle]!.event.timeMs < timeMs) low = middle + 1; else high = middle; }
        return low;
      };
      const intervals: NormalCommandInterval[] = [];
      let index = 0, factor = f(1), perfect = f(0);
      for (const [count, command] of commands.entries()) {
        if (interrupted()) return fail("native-normal-command-plan-interrupted", "worker cancellation/budget");
        if (count && count % 512 === 0) { controls.progress(); await controls.yield(); }
        const end = lowerBound(command.timeMs);
        if (end > index) intervals.push({ start: index, end, factor: f(factor + perfect) });
        const diff = f(f(command.diffMillPercent) / f(100000));
        if (command.judgement === undefined) factor = f(factor + diff);
        else if (command.judgement === 5) perfect = f(perfect + diff);
        index = end;
      }
      if (index < song.nodes.length) intervals.push({ start: index, end: song.nodes.length, factor: f(factor + perfect) });
      if (interrupted()) return fail("native-normal-command-plan-interrupted", "worker cancellation/budget");
      const size = 128 + intervals.length * 64;
      if (size <= 4 * 1024 * 1024) {
        while (lru.size && (lru.size >= 2048 || bytes + size > 4 * 1024 * 1024)) remove(lru.keys().next().value!);
        const entry = { song, skills, intervals, bytes: size };
        const orders = lookup.get(song) ?? new WeakMap<Skills, Entry>();
        orders.set(skills, entry); lookup.set(song, orders); lru.set(entry, true); bytes += size;
      }
      return { value: intervals, gaps: [] };
    },
  };
}
