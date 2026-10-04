import type { MetricValue, OptimizationInput, ResolvedSlotProfile, TeamAssignment } from "../contracts.ts";
import { dataRows, nativeRow, type TeamBuilderData } from "../data.ts";
import type { SearchEvaluationControls } from "../optimizer.ts";
import type { PreparedSong } from "../song-metrics.ts";
import { nativeLuckFactorPercent, unavailableMetric } from "../score.ts";
import { gekisoPreviousScoreFrameEnd, resolveGekisoRankingBonus, type GekisoRules } from "./gekiso-mission-luck.ts";
import { evaluateGekisoLuckTimeline } from "./gekiso-luck-timeline.ts";
import { createNativeGekisoBasicRuntimeResolver, type NativeGekisoBasicRuntimeInput,
  type NativeGekisoBasicRuntimeResult } from "./native-gekiso-runtime.ts";
import { nativeGekisoAllComboDriverSupports } from "./native-gekiso-driver-profile.ts";
import type { NativeGekisoScoreRange } from "./native-gekiso-live-score.ts";
import { createNativeNormalScoreResolver } from "./native-normal-score.ts";

const f = Math.fround;
const int = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) &&
  value >= 0 && value <= 0x7fffffff;

/** Selected basic effects and one or three disjoint Luck ranges. Each native
 * range owns its gauge/Next/rush state. With no minimum/probability modifiers
 * and no inter-range rush handle, complete order means add range-local gains;
 * both per-note floors and rank residues remain inside each range law. */
export function createNativeGekisoLuckLiveScoreResolver(data: TeamBuilderData, input: OptimizationInput) {
  const runtime = createNativeGekisoBasicRuntimeResolver(data, input);
  const normal = createNativeNormalScoreResolver(data, input);
  const ladder = dataRows(data.liveTools.comboScoreBonuses).map(nativeRow).filter((row) => row.comboBonusType === 1)
    .map((row) => ({ count: Number(row.requiredComboCount), bonus: Number(row.bonusFactor) }))
    .sort((a, b) => a.count - b.count);
  return {
    async score(assignment: TeamAssignment, song: PreparedSong, profiles: readonly (ResolvedSlotProfile | undefined)[],
      rules: GekisoRules, tape: NativeGekisoBasicRuntimeInput, ranges: readonly NativeGekisoScoreRange[],
      controls: SearchEvaluationControls): Promise<MetricValue> {
      const luckIndices = tape.missions.flatMap((mission, index) => mission === 2 ? [index as 0 | 1 | 2] : []);
      const threeLuck = luckIndices.length === 3;
      if (input.constraints.justRate !== 0 || ![1, 3].includes(luckIndices.length) ||
        (threeLuck && (!tape.requireNoPendingLots || !nativeGekisoAllComboDriverSupports(data.identity))))
        return unavailableMetric("native-gekiso-luck-live-domain-unresolved", "PERFECT, one or three qualified Luck ranges");
      if (tape.assignment.leaderInstanceId !== assignment.leaderInstanceId ||
        tape.assignment.memberInstanceIds.length !== assignment.memberInstanceIds.length ||
        tape.assignment.memberInstanceIds.some((id, index) => id !== assignment.memberInstanceIds[index]) ||
        tape.assignment.snapshotInstanceIds.length !== assignment.snapshotInstanceIds.length ||
        tape.assignment.snapshotInstanceIds.some((id, index) => id !== assignment.snapshotInstanceIds[index]))
        return unavailableMetric("native-gekiso-live-assignment-mismatch", "selected member/photo/leader slots");
      if (song.song.segments.length !== 3 || song.song.segments.some((range, index) => range.mission !== tape.missions[index]))
        return unavailableMetric("native-gekiso-live-mission-mismatch", song.song.key);
      if (!ladder.length || ladder.some((row, index) => !int(row.count) || !Number.isFinite(f(row.bonus)) ||
        row.bonus < 0 || (index > 0 && row.count === ladder[index - 1]!.count)))
        return unavailableMetric("native-gekiso-live-combo-ladder-unresolved", song.song.key);
      if (ranges.length !== 3 || ranges.some((range, index) => !int(range.startTimeMs) || !int(range.endTimeMs) ||
        range.endTimeMs <= range.startTimeMs || !int(range.rank) || range.rank < 1 || range.rank > 5 ||
        (index > 0 && range.startTimeMs <= ranges[index - 1]!.endTimeMs)))
        return unavailableMetric("native-gekiso-live-range-times-unresolved", song.song.key);
      const completions = [0, 1, 2].map((index) => tape.frames.find((frame) => frame.rangeUpdates.some((update) =>
        update.rangeIndex === index && update.simulateState === 7))?.timeMs);
      if (completions.some((time, index) => time === undefined || time < ranges[index]!.endTimeMs ||
        (index < 2 && time > ranges[index + 1]!.startTimeMs)) || tape.frames.some((frame) =>
          frame.rangeUpdates.some((update) => update.startTimeMs !== ranges[update.rangeIndex]?.startTimeMs)))
        return unavailableMetric("native-gekiso-live-range-completion-unresolved", song.song.key);
      const counts = new Map<string, number>();
      const key = (range: number, time: number, operation: number) => `${range}/${time}/${operation}`;
      for (const frame of tape.frames) for (const note of frame.notes) {
        const id = key(note.rangeIndex, note.timeMs, note.operation);
        counts.set(id, (counts.get(id) ?? 0) + 1);
      }
      for (const node of song.nodes) if (node.segmentIndex >= 0) {
        const id = key(node.segmentIndex, node.event.timeMs, node.event.operateType), count = counts.get(id) ?? 0;
        if (!count) return unavailableMetric("native-gekiso-live-chart-admission-mismatch", id);
        counts.set(id, count - 1);
      }
      if ([...counts.values()].some((count) => count !== 0))
        return unavailableMetric("native-gekiso-live-chart-admission-mismatch", "extra admitted history");
      const plays: NativeGekisoBasicRuntimeResult[] = [];
      for (const index of luckIndices) {
        const played = await runtime.evaluate(rules, { ...tape, projection: "expectations-only", liveScore: undefined,
          ...(threeLuck ? { isolatedLuckRangeIndex: index } : {}) }, controls);
        if (!played.value) return { value: null, status: "unavailable", assumptions: [], gaps: played.gaps };
        plays.push(played.value);
      }
      const combo = song.nodes.map((node) => {
        const index = ranges.findIndex((range, index) => tape.missions[index] === 1 &&
          range.startTimeMs <= node.event.timeMs && node.event.timeMs <= range.endTimeMs);
        if (index < 0) return f(0);
        const snapshots = plays[0]!.counters[index]!.comboSnapshots,
          boundary = gekisoPreviousScoreFrameEnd(node.event.timeMs);
        let low = 0, high = snapshots.length;
        while (low < high) { const mid = (low + high) >>> 1;
          if (snapshots[mid]!.timeMs <= boundary) low = mid + 1; else high = mid; }
        const count = low ? snapshots[low - 1]!.combo : 0;
        let value = f(0);
        for (const row of ladder) { if (row.count > count) break; value = f(value + f(row.bonus)); }
        return value;
      });
      const luckRanges = luckIndices.map((luckIndex, index) => ({
        luckIndex, luckInput: plays[index]!.luckInput,
        rushStart: Math.min(...tape.frames.flatMap((frame) => frame.notes
          .filter((note) => note.rangeIndex === luckIndex).map((note) => note.timeMs))),
        rushEnd: tape.frames.find((frame) => frame.rangeUpdates.some((update) =>
          update.rangeIndex === luckIndex && update.simulateState === 8))?.timeMs,
      }));
      if (luckRanges.some((range) => range.rushEnd === undefined || !int(range.rushStart) ||
        (threeLuck && range.luckIndex < 2 && range.rushEnd! >= ranges[range.luckIndex + 1]!.startTimeMs)))
        return unavailableMetric("native-gekiso-luck-score-horizon-unresolved", song.song.key);
      const frameEnd = (time: number) => Math.ceil(f(f(time) / f(40))) * 40;
      const orderMeans = new Map<string, number>();
      let cachedBytes = 0;
      const metric = await normal.score(assignment, song, profiles, controls, undefined, {
        gekisoComboBonuses: combo, completePlayBonus: () => ({ value: 0, gaps: [] }),
        assumptions: ["native-GK-personal-Live-ledger", "native-Luck-nominal-law-per-native-member-order",
          "native-rank-rounded-before-Luck-expectation", "complete-native-update-frame-tape"],
        luckPlay: {
          rushFactorPercent: nativeLuckFactorPercent(rules.luckRushScoreBonusPercent),
          async resolve(samples, controls) {
            if (controls.cancelled() || controls.expired()) return { value: null,
              gaps: [{ code: "native-gekiso-luck-order-interrupted", source: "worker cancellation/budget" }] };
            // Equivalent per-note floors induce the same Luck/rank calculation.
            // Keep the exact signature, avoiding a collision-prone numeric hash.
            const idleRanges = ranges.map((range) => samples.reduce((sum, sample) =>
              sum + (sample.timeMs > frameEnd(range.startTimeMs) && sample.timeMs <= frameEnd(range.endTimeMs)
                ? sample.idleScore : 0), 0));
            let idlePlay = input.evaluation.songContexts[song.song.key]!.fixedScore +
              samples.reduce((sum, sample) => sum + sample.idleScore, 0);
            const baseRemainders: number[] = [];
            const gcd = (a: number, b: number): number => b ? gcd(b, a % b) : a;
            for (const [index, range] of ranges.entries()) {
              const bonus = resolveGekisoRankingBonus({ rules, rangeIndex: index, complete: true, rank: range.rank,
                startTimingScore: 0, endTimingScore: idleRanges[index]! });
              if (!bonus.value) return { value: null, gaps: bonus.gaps };
              idlePlay += bonus.value.fixedScore;
              baseRemainders.push(idleRanges[index]! % (100 / gcd(bonus.value.percent, 100)));
            }
            let totalDelta = 0;
            for (const { luckIndex, luckInput, rushStart, rushEnd } of luckRanges) {
              const frames = luckInput.frames;
              const residues = ranges.map((range, index) => frameEnd(range.endTimeMs) >= rushStart &&
                frameEnd(range.startTimeMs) < rushEnd! ? (idleRanges[index]! * rules.rankingPercents[index]![range.rank - 1]!) % 100 : 0);
              const signature = luckIndex + "|" + residues.join("/") + "|" + samples.filter((sample) =>
                sample.timeMs >= rushStart && sample.timeMs < rushEnd!).map((sample) =>
                  sample.rushScore - sample.idleScore).join(",");
              const cached = orderMeans.get(signature);
              if (cached !== undefined) { totalDelta += cached; continue; }
              let cursor = 0;
              const scoreFrames = frames.map((frame) => {
                const start = cursor;
                while (cursor < samples.length && samples[cursor]!.timeMs <= frame.timeMs) cursor++;
                return samples.slice(start, cursor).map((sample) => ({ timeMs: sample.timeMs, idleScore: 0,
                  rushScore: sample.timeMs >= rushStart && sample.timeMs < rushEnd!
                    ? sample.rushScore - sample.idleScore : 0 }));
              });
              if (cursor !== samples.length) return { value: null,
                gaps: [{ code: "native-gekiso-luck-score-horizon-unresolved", source: song.song.key }] };
              const law = await evaluateGekisoLuckTimeline(rules, { ...luckInput,
                projection: "expectations-only", liveScore: { projection: "score-expectation",
                  initialScore: 0, rankBaseRemainders: baseRemainders as [number, number, number],
                  expectedNoteCount: song.nodes.length, frames: scoreFrames, ranges } }, controls);
              const delta = law.value?.liveScore?.mean ?? null;
              const value = delta === null ? null : idlePlay + delta;
              if (value !== null && !law.gaps.length && !controls.cancelled() && !controls.expired() &&
                signature.length * 2 <= 4 * 1024 * 1024) {
                while (orderMeans.size && (orderMeans.size >= 128 || cachedBytes + signature.length * 2 > 4 * 1024 * 1024)) {
                  const oldest = orderMeans.keys().next().value!;
                  orderMeans.delete(oldest); cachedBytes -= oldest.length * 2;
                }
                orderMeans.set(signature, delta!); cachedBytes += signature.length * 2;
              }
              if (value === null || law.gaps.length) return { value: null, gaps: law.gaps };
              totalDelta += delta!;
            }
            return { value: idlePlay + totalDelta, gaps: [] };
          },
        },
      });
      if (metric.value !== null) metric.scoreDomain = "personal-live";
      metric.breakdown = metric.breakdown?.map((entry) => ({ ...entry,
        key: entry.key.replace(/^normal-score-/u, "gekiso-luck-expected-score-"),
        source: entry.key.startsWith("normal-score-") ? "complete Luck expectation per native member order" : entry.source }));
      return metric;
    },
  };
}
