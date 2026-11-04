// L3 — GEB
// Input: 规范工程与统一 Our Notes 编译结果。
// Output: 保留独立变速、停速、倒流和固定速度的 Sonolus 原生关卡。
// Pos: [Map](../L2-2.md)；社区谱面的 Sonolus 投影边界。
// Effects/Dependencies: 原生源 ID、共享可视时钟／曲线路径；纯转换，不读取来源文件或媒体。
import { chartToLevelData } from "@haneoka/cassiopeia-plugin-sonolus";
import { prepareNativeScrollGeometry } from "@haneoka/cassiopeia-plugin-our-notes";
import type { NativeChartScrollProfiles } from "@haneoka/cassiopeia-plugin-our-notes";
import type { Project } from "../../../packages/chart-editor/src/model";
import { TempoMap } from "../../../packages/chart-editor/src/timing";
import { compileOurNotesCreation } from "./native-compile";

type ScrollGeometry = ReturnType<typeof prepareNativeScrollGeometry>;
type PathPoint = ScrollGeometry["lines"][number]["points"][number];
type Entity = ReturnType<typeof chartToLevelData>["entities"][number];
const numeric = (entity: Entity, name: string) => {
  const value = entity.data.find(row => row.name === name);
  return value && "value" in value ? value.value : undefined;
};

/** Conservative spawn interval for the complete 1–14 native note-speed range. */
function firstVisible(a: PathPoint, b: PathPoint, end: number) {
  const low = -640, high = 4400, first = -4500;
  const times = new Set<number>([first, Math.max(first, end)]);
  for (const clock of [a.left, a.right, b.left, b.right]) for (const segment of clock.segments)
    if (segment.timeMs > first && segment.timeMs < end) times.add(segment.timeMs);
  const delta = (point: PathPoint, now: number) => point.value - point.left.at(now) * (1 - point.ratio) - point.right.at(now) * point.ratio;
  const visible = (x: number, y: number) => Math.max(x, y) >= low && Math.min(x, y) <= high;
  const boundaries = [...times].sort((x, y) => x - y);
  for (let index = 0; index < boundaries.length - 1; index++) {
    const start = boundaries[index]!, stop = boundaries[index + 1]!, x = delta(a, start), y = delta(b, start);
    if (visible(x, y)) return start / 1000;
    const dx = delta(a, stop) - x, dy = delta(b, stop) - y, candidates: number[] = [];
    for (const [value, change] of [[x, dx], [y, dy]]) if (change) for (const limit of [low, high]) {
      const ratio = (limit - value!) / change!;
      if (ratio >= 0 && ratio <= 1) candidates.push(ratio);
    }
    for (const ratio of candidates.sort((x, y) => x - y)) if (visible(x + dx * ratio, y + dy * ratio))
      return (start + (stop - start) * ratio) / 1000;
  }
  return end / 1000;
}

export function compileCreationSonolus(project: Project, compiled = compileOurNotesCreation(project)) {
  const { chart, visualProfiles } = compiled;
  const custom = !!visualProfiles?.scroll || !!visualProfiles?.notes.length || !!visualProfiles?.lines.length;
  const level = chartToLevelData(chart, project.audioOffset, { includeSourceIds: custom });
  if (!custom) {
    for (const event of project.timeScales) level.entities.push({ archetype: "#TIMESCALE_CHANGE", data: [
      { name: "#BEAT", value: event.tick / project.resolution }, { name: "#TIMESCALE", value: event.scale },
    ] });
    return level;
  }
  const scroll: NativeChartScrollProfiles = visualProfiles!.scroll ?? {
    groups: [{ id: "global", changes: chart.timeScaleChanges }],
    notes: chart.notes.map(note => ({ nativeNoteId: note.id, groupId: "global" })),
  };
  const geometry = prepareNativeScrollGeometry(chart, scroll), clockRefs = new Map<string, string>();
  const tempo = new TempoMap(project.tempos, { resolution: project.resolution });
  for (const clock of geometry.clocks.values()) {
    const name = (index: number) => `our-scroll-${clock.id}-${index}`;
    clockRefs.set(clock.id, name(0));
    clock.segments.forEach((segment, index) => level.entities.push({
      archetype: "ScrollClock", name: name(index), data: [
        { name: "clockHead", value: index === 0 ? 1 : 0 },
        { name: "#BEAT", value: tempo.secondsToTick(segment.timeMs / 1000) / project.resolution },
        { name: "clockTime", value: segment.timeMs / 1000 },
        { name: "clockValue", value: segment.value / 1000 },
        { name: "clockScale", value: segment.scale },
        ...(index + 1 < clock.segments.length ? [{ name: "clockNext", ref: name(index + 1) }] : []),
      ],
    }));
  }
  const speeds = new Map(visualProfiles!.notes.map(entry => [entry.nativeNoteId, entry.noteSpeed]));
  const lineSpeeds = new Map(visualProfiles!.lines.map(entry => [entry.nativeLineId, entry.noteSpeed]));
  const notes = new Map(chart.notes.map(note => [note.id, note])), entities = new Map<number, Entity>();
  for (const entity of level.entities) {
    const id = numeric(entity, "originalNoteId");
    if (id === undefined) continue;
    const note = notes.get(id), clock = geometry.noteClocks.get(id);
    if (!note || !clock) throw new Error("sonolus_source_mapping_mismatch");
    const point: PathPoint = { timeMs: note.timeMs, pos: note.pos, size: note.size, value: clock.at(note.timeMs), left: clock, right: clock, ratio: 0 };
    entity.name ??= `our-scroll-note-${id}`;
    entities.set(id, entity);
    entity.data.push({ name: "scrollRef", ref: clockRefs.get(clock.id)! },
      { name: "scrollTarget", value: point.value / 1000 },
      { name: "scrollSpawn", value: firstVisible(point, point, note.timeMs) });
    const speed = speeds.get(id);
    if (speed !== undefined) entity.data.push({ name: "forceNoteSpeed", value: speed });
  }
  for (const line of geometry.lines) {
    const start = entities.get(line.authored[0]!.id);
    if (!start) throw new Error("sonolus_source_mapping_mismatch");
    for (let index = 1; index < line.points.length; index++) {
      const a = line.points[index - 1]!, b = line.points[index]!;
      if (a.timeMs === b.timeMs) continue;
      const data: Entity["data"] = [
        { name: "start", ref: start.name! },
        { name: "spawn", value: firstVisible(a, b, b.timeMs) },
        { name: "lineStart", value: line.start / 1000 },
        { name: "lineEnd", value: line.end / 1000 },
        { name: "guide", value: line.kind === "guide" ? 1 : 0 },
        { name: "critical", value: line.critical ? 1 : 0 },
        { name: "forceNoteSpeed", value: lineSpeeds.get(line.id) ?? 0 },
      ];
      for (const [prefix, point] of [["a", a], ["b", b]] as const) data.push(
        { name: `${prefix}Time`, value: point.timeMs / 1000 },
        { name: `${prefix}Value`, value: point.value / 1000 },
        { name: `${prefix}Left`, value: point.pos / 2 - 6 },
        { name: `${prefix}Right`, value: (point.pos + point.size) / 2 - 6 },
        { name: `${prefix}Ratio`, value: point.ratio },
        { name: `${prefix}ClockL`, ref: clockRefs.get(point.left.id)! },
        { name: `${prefix}ClockR`, ref: clockRefs.get(point.right.id)! },
      );
      level.entities.push({ archetype: "ScrollRibbon", data });
    }
  }
  return level;
}
