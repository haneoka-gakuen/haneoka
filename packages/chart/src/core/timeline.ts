import { TickConverter } from "./timing";
import type { ChartCallChangeEvent, ChartFeverSection, ChartSkillEvent, ChartTimeline, SsRoot } from "./types";

/**
 * Builds the three non-note timelines produced by SsMusicScoreConverter.
 * Evidence: libil2cpp.decrypted.so BuildFeverList 0x4fb8448,
 * BuildSkillList 0x4fb8804, and BuildCallList 0x4fb89cc.
 */
export function buildChartTimeline(root: SsRoot, converter: TickConverter): ChartTimeline {
  const skills: ChartSkillEvent[] = root.skill.map((tick, index) => ({
    index,
    tick,
    timeMs: converter.tickToTimeMs(tick),
  }));

  const fever: ChartFeverSection[] = root.fever
    .map(([startTick, endTick], sourceIndex) => ({ startTick, endTick, sourceIndex }))
    .sort((left, right) => left.startTick - right.startTick || left.sourceIndex - right.sourceIndex)
    .map(({ startTick, endTick }, index) => ({
      index,
      startTick,
      endTick,
      startTimeMs: converter.tickToTimeMs(startTick),
      endTimeMs: converter.tickToTimeMs(endTick),
    }));

  const callChanges: ChartCallChangeEvent[] = root.call
    .map((call, sourceIndex) => ({ call, sourceIndex }))
    .sort((left, right) => left.call.t - right.call.t || left.sourceIndex - right.sourceIndex)
    .map(({ call }, index) => ({
      index,
      tick: call.t,
      timeMs: converter.tickToTimeMs(call.t),
      rhythms: Object.freeze(
        call.timing.flatMap((value, timingIndex) =>
          value === 1 ? [Math.fround((timingIndex + 1) / call.timing.length)] : [],
        ),
      ),
    }));

  return Object.freeze({
    skills: Object.freeze(skills),
    fever: Object.freeze(fever),
    callChanges: Object.freeze(callChanges),
  });
}
