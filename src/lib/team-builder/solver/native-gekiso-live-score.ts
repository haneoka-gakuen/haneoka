import type { EvidenceGap, MetricValue, OptimizationInput, ResolvedSlotProfile, TeamAssignment } from "../contracts.ts";
import { dataRows, nativeRow, type TeamBuilderData } from "../data.ts";
import type { SearchEvaluationControls } from "../optimizer.ts";
import type { PreparedSong } from "../song-metrics.ts";
import { unavailableMetric } from "../score.ts";
import { gekisoPreviousScoreFrameEnd, resolveGekisoRankingBonus, type GekisoRules } from "./gekiso-mission-luck.ts";
import { createNativeGekisoBasicRuntimeResolver, type NativeGekisoBasicRuntimeInput } from "./native-gekiso-runtime.ts";
import { createNativeNormalScoreResolver, type NativeNormalPlayScoreLaw, type NativeScoreAugmentation } from "./native-normal-score.ts";

export interface NativeGekisoScoreRange {
  startTimeMs: number;
  endTimeMs: number;
  /** Confirmed rank from the native ranking updater, rather than room size. */
  rank: number;
}
const f = Math.fround;
const int = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0x7fffffff;
const gap = (code: string, source: string): EvidenceGap => ({ code, source });

/** Complete deterministic AP Live ledger for a supplied native three-range
 * tape without Luck missions. Ordinary skills use the shared 120-order engine;
 * GK combo is resolved per node, and each completed play receives its integer
 * range-rank additions before the law/mean/worst score is published.
 */
export function createNativeGekisoNoLuckLiveScoreResolver(data: TeamBuilderData, input: OptimizationInput) {
  const runtime = createNativeGekisoBasicRuntimeResolver(data, input);
  const normal = createNativeNormalScoreResolver(data, input);
  const ladder = dataRows(data.liveTools.comboScoreBonuses).map(nativeRow)
    .filter((row) => row.comboBonusType === 1)
    .map((row) => ({ count: Number(row.requiredComboCount), bonus: Number(row.bonusFactor) }))
    .sort((a, b) => a.count - b.count);
  return {
    async score(
      assignment: TeamAssignment,
      song: PreparedSong,
      profiles: readonly (ResolvedSlotProfile | undefined)[],
      rules: GekisoRules,
      tape: NativeGekisoBasicRuntimeInput,
      ranges: readonly NativeGekisoScoreRange[],
      controls: SearchEvaluationControls,
      onCompleteLaw?: (law: NativeNormalPlayScoreLaw) => void,
    ): Promise<MetricValue> {
      const local: EvidenceGap[] = [];
      if (input.constraints.justRate !== 0 || tape.missions.some((mission) => mission === 2))
        local.push(gap("native-gekiso-deterministic-live-domain-unresolved", "PERFECT and no Luck mission"));
      if (tape.assignment.leaderInstanceId !== assignment.leaderInstanceId ||
        tape.assignment.memberInstanceIds.length !== assignment.memberInstanceIds.length ||
        tape.assignment.memberInstanceIds.some((id, i) => id !== assignment.memberInstanceIds[i]) ||
        tape.assignment.snapshotInstanceIds.length !== assignment.snapshotInstanceIds.length ||
        tape.assignment.snapshotInstanceIds.some((id, i) => id !== assignment.snapshotInstanceIds[i]))
        local.push(gap("native-gekiso-live-assignment-mismatch", "same selected member/photo/leader slots"));
      if (song.song.segments.length !== 3 || song.song.segments.some((range, i) => range.mission !== tape.missions[i]))
        local.push(gap("native-gekiso-live-mission-mismatch", song.song.key));
      if (!ladder.length || ladder.some((row, i) => !int(row.count) || !Number.isFinite(f(row.bonus)) ||
        row.bonus < 0 || (i > 0 && row.count === ladder[i - 1]!.count)))
        local.push(gap("native-gekiso-live-combo-ladder-unresolved", "same-pin Master type1 rows"));
      if (ranges.length !== 3 || ranges.some((range, i) => !int(range.startTimeMs) || !int(range.endTimeMs) ||
        range.endTimeMs <= range.startTimeMs || !int(range.rank) || range.rank < 1 || range.rank > 5 ||
        (i > 0 && range.startTimeMs <= ranges[i - 1]!.endTimeMs)))
        local.push(gap("native-gekiso-live-range-times-unresolved", "three ordered native source ranges"));
      if (tape.frames.some((frame) => frame.rangeUpdates.some((update) =>
        update.startTimeMs !== ranges[update.rangeIndex]?.startTimeMs)))
        local.push(gap("native-gekiso-live-range-start-mismatch", "native source start-time getter"));
      const completeFrames = [0, 1, 2].map((rangeIndex) => tape.frames.find((frame) =>
        frame.rangeUpdates.some((update) => update.rangeIndex === rangeIndex && update.simulateState === 7))?.timeMs);
      if (completeFrames.some((time, i) => time === undefined || time < ranges[i]?.endTimeMs ||
        (i < 2 && time > ranges[i + 1]?.startTimeMs)))
        local.push(gap("native-gekiso-live-range-completion-unresolved", "completed rank before next range starts"));
      if (local.length) return { value: null, status: "unavailable", gaps: local, assumptions: [] };
      const played = await runtime.evaluate(rules, tape, controls);
      if (!played.value) return { value: null, status: "unavailable", gaps: played.gaps, assumptions: [] };
      const counts = new Map<string, number>();
      const key = (range: number, time: number, operation: number) => `${range}/${time}/${operation}`;
      for (const frame of tape.frames) for (const note of frame.notes) {
        const id = key(note.rangeIndex, note.timeMs, note.operation);
        counts.set(id, (counts.get(id) ?? 0) + 1);
      }
      for (const node of song.nodes) if (node.segmentIndex >= 0) {
        const id = key(node.segmentIndex, node.event.timeMs, node.event.operateType), remaining = counts.get(id) ?? 0;
        if (!remaining) return unavailableMetric("native-gekiso-live-chart-admission-mismatch", id);
        counts.set(id, remaining - 1);
      }
      if ([...counts.values()].some((count) => count !== 0))
        return unavailableMetric("native-gekiso-live-chart-admission-mismatch", "extra admitted history");
      const bonuses = song.nodes.map((node) => {
        // TryGetActiveComboInRange selects only mission1 and compares the
        // original source start/end times inclusively, independently of ticks.
        const rangeIndex = ranges.findIndex((range, i) => tape.missions[i] === 1 &&
          range.startTimeMs <= node.event.timeMs && node.event.timeMs <= range.endTimeMs);
        if (rangeIndex < 0) return f(0);
        const boundary = gekisoPreviousScoreFrameEnd(node.event.timeMs);
        const snapshots = played.value!.counters[rangeIndex]!.comboSnapshots;
        let low = 0, high = snapshots.length;
        while (low < high) {
          const middle = (low + high) >>> 1;
          if (snapshots[middle]!.timeMs <= boundary) low = middle + 1;
          else high = middle;
        }
        const count = low ? snapshots[low - 1]!.combo : 0;
        let bonus = f(0);
        for (const row of ladder) {
          if (row.count > count) break;
          bonus = f(bonus + f(row.bonus));
        }
        return bonus;
      });
      const at = (prefix: Float64Array, time: number) => {
        const boundary = Math.ceil(f(f(time) / f(40))) * 40;
        let low = 0, high = song.nodes.length;
        while (low < high) {
          const middle = (low + high) >>> 1;
          if (song.nodes[middle]!.event.timeMs <= boundary) low = middle + 1;
          else high = middle;
        }
        return prefix[low]!;
      };
      const augmentation: NativeScoreAugmentation = {
        gekisoComboBonuses: bonuses,
        assumptions: [...played.value.assumptions, "native-GK-personal-Live-ledger", "native-GK-complete-play-rank-rounding"],
        completePlayBonus(prefix) {
          let total = 0;
          for (const [rangeIndex, range] of ranges.entries()) {
            const value = resolveGekisoRankingBonus({ rules, rangeIndex, complete: true, rank: range.rank,
              startTimingScore: at(prefix, range.startTimeMs), endTimingScore: at(prefix, range.endTimeMs) });
            if (!value.value) return { value: null, gaps: value.gaps };
            total += value.value.fixedScore;
          }
          return { value: total, gaps: [] };
        },
      };
      const metric = await normal.score(assignment, song, profiles, controls, onCompleteLaw, augmentation);
      if (metric.value !== null) metric.scoreDomain = "personal-live";
      if (metric.value !== null) metric.breakdown = (metric.breakdown ?? []).map((entry) => ({ ...entry,
        key: entry.key.replace(/^normal-score-/u, "gekiso-live-score-"),
        source: entry.key.startsWith("normal-score-") ? "complete native GK Live play per member order" : entry.source,
      }));
      return metric;
    },
  };
}
