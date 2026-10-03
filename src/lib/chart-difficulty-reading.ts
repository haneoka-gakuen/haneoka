import { VisualTimeMap, type ChartDocument } from "@haneoka/cassiopeia";
import { noteViewTimeSeconds } from "@haneoka/cassiopeia-plugin-our-notes";
export function readingTimeline(
  chart: Readonly<ChartDocument>,
  speed: number,
  gapRatio: number,
) {
  const clock = new VisualTimeMap(chart.timeScaleChanges),
    view = noteViewTimeSeconds(speed) * 1000;
  const notes = chart.notes
    .filter(
      (n) =>
        n.visible && ![120, 121, 100, 101, 102, 103].includes(n.operateType),
    )
    .map((n) => ({ note: n, time: clock.toScaledTimeMs(n.timeMs) }))
    .sort((a, b) => a.time - b.time || a.note.id - b.note.id);
  let first = 0;
  for (let last = 0; last < notes.length; last++) {
    while (
      first <= last &&
      notes[first]!.time <= Math.max(0, notes[last]!.time - 1.1 * view)
    )
      first++;
    if (last + 1 - first > 256) throw Error("reading-window-budget");
  }
  const events: { time: number; delta: number }[] = [];
  for (let i = 0; i < notes.length; i++)
    for (let j = i + 1; j < notes.length; j++) {
      const first = notes[i]!,
        next = notes[j]!,
        gap = next.time - first.time;
      if (gap > gapRatio * view) break;
      if (
        gap <= 0 ||
        Math.max(first.note.pos, next.note.pos) + 1e-6 >=
          Math.min(
            first.note.pos + first.note.size,
            next.note.pos + next.note.size,
          )
      )
        continue;
      const start = Math.max(0, clock.toTimeMs(next.time - 1.1 * view) / 1000),
        end = Math.min(
          chart.durationMs / 1000,
          clock.toTimeMs(first.time) / 1000,
        );
      if (end > start)
        events.push({ time: start, delta: 1 }, { time: end, delta: -1 });
      if (events.length > 400000) throw Error("reading-timeline-budget");
    }
  events.sort((a, b) => a.time - b.time || a.delta - b.delta);
  const cues = [
    ...chart.bpmChanges.flatMap((event, index) =>
      index
        ? [
            {
              time: event.timeMs / 1000,
              weight: Math.abs(
                Math.log2(event.bpm / chart.bpmChanges[index - 1]!.bpm),
              ),
            },
          ]
        : [],
    ),
    ...chart.timeScaleChanges.map((event) => ({
      time: event.timeMs / 1000,
      weight: Math.abs(Math.log2(event.scale)) * 0.25,
    })),
  ].sort((a, b) => a.time - b.time);
  let cueCursor = 0;
  let cursor = 0,
    pairs = 0;
  return {
    integral(start: number, end: number) {
      while (cursor < events.length && events[cursor]!.time <= start) {
        pairs += events[cursor]!.delta;
        cursor++;
      }
      const lambda = -Math.log(0.3);
      let time = start,
        increment = 0;
      const integrate = (until: number) => {
        const width = Math.max(0, until - time);
        increment +=
          (Math.log1p(Math.max(0, pairs)) / lambda) *
          (1 - Math.exp(-lambda * width)) *
          Math.exp(-lambda * (end - until));
        time = until;
      };
      while (cursor < events.length && events[cursor]!.time < end) {
        integrate(events[cursor]!.time);
        pairs += events[cursor]!.delta;
        cursor++;
      }
      integrate(end);
      while (cueCursor < cues.length && cues[cueCursor]!.time <= end) {
        const cue = cues[cueCursor++]!;
        increment +=
          cue.weight * Math.exp(-lambda * Math.max(0, end - cue.time));
      }
      return increment;
    },
  };
}
