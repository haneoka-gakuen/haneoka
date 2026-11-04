// L3 — GEB
// Input: 任意来源的规范创作工程、分组及变速时间线。
// Output: 统一原生谱面、可视时间线、源映射及导出诊断。
// Pos: [Map](../L2-2.md)；编辑、预览、社区播放与发布共用的纯编译边界。
// Effects/Dependencies: 原生 Our Notes 转换器及创作模型；无 DOM、音频或网络。
import { buildChart, parseScore, type NativeChartVisualProfiles } from "@haneoka/cassiopeia-plugin-our-notes";
import { LANE_COUNT } from "@haneoka/cassiopeia";
import type { Project } from "../../../packages/chart-editor/src/model";
import { assertValidProject } from "../../../packages/chart-editor/src/validation";
import { serializeSs } from "../../../packages/chart-editor/src/formats/ss";
import { getExportDiagnostics } from "../../../packages/chart-editor/src/formats/diagnostics";
import { TempoMap } from "../../../packages/chart-editor/src/timing";
import { assertEditedChartSpans, authoredSpanOverlaps } from "../../../packages/chart-editor/src/creation/span";
import { prepareNativeSourceMap } from "./native-source-map";
import { compileAuthorNativeSpeedPlan, compileAuthorScrollProfiles } from "./native-speed-plan";

/** Canonical imported and authored projects use the actual OurNotes converter, including guide overlap, crit and slide endpoints. */
export function compileOurNotesCreation(project: Project) {
  assertValidProject(project);
  assertEditedChartSpans(project, project);
  const ss = serializeSs(project), root = parseScore(ss), sources = prepareNativeSourceMap(project, root),
    chart = buildChart(root, sources.observer);
  const ids = new Set(chart.notes.map((note) => note.id));
  if (
    !Number.isFinite(chart.durationMs) ||
    chart.notes.some(
      (note) => !Number.isFinite(note.timeMs) || !Number.isFinite(note.pos) || !Number.isFinite(note.size),
    ) ||
    ids.size !== chart.notes.length ||
    chart.lines.some((line) => line.noteIds.some((id) => !ids.has(id)))
  )
    throw new Error("our_notes_invalid_runtime");
  const outside = chart.notes.find((note) => note.judged && !authoredSpanOverlaps(note.pos, note.size, LANE_COUNT));
  if (outside)
    throw new Error("our_notes_judged_note_outside_stage", {
      cause: { id: outside.id, tick: outside.tick, lane: outside.pos, size: outside.size },
    });
  // Musical time stays in the kernel; media zero is represented by the host offset.
  const tempo = new TempoMap(project.tempos, { resolution: project.resolution });
  chart.timeScaleChanges = project.timeScales
    .map((event) => ({ timeMs: tempo.tickToSeconds(event.tick) * 1000, scale: event.scale }))
    .sort((a, b) => a.timeMs - b.timeMs);
  const sourceMap = sources.finish(chart), plan = compileAuthorNativeSpeedPlan(project, chart, sourceMap);
  const scroll = compileAuthorScrollProfiles(project, chart, sourceMap);
  const visualProfiles: NativeChartVisualProfiles | undefined = plan || scroll ? { notes: plan?.notes ?? [], lines: plan?.lines ?? [], ...(scroll ? { scroll } : {}) } : undefined;
  return { ss, chart, sourceMap, visualProfiles, bgmOffsetMs: project.audioOffset * 1000, warnings: getExportDiagnostics(project, "ss") };
}
