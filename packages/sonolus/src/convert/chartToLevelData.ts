import { EngineArchetypeDataName, EngineArchetypeName, type LevelData, type LevelDataEntity } from "@sonolus/core";
import { NoteDirection, NoteLineEaseType, NoteOperateType } from "../shared/enums.js";
import type { InternalChart, NoteLine, ResolvedNote } from "./types.js";

type Intermediate = {
  archetype: string;
  data: Record<string, number | Intermediate | undefined>;
  sim: boolean;
  ease?: number;
  easeL?: number;
  easeR?: number;
};

const laneOf = (note: ResolvedNote) => (note.pos + note.size / 2) / 2 - 6;
const halfWidthOf = (note: ResolvedNote) => note.size / 4;
const directionOf = (direction: NoteDirection) =>
  direction === NoteDirection.Left ? -1 : direction === NoteDirection.Right ? 1 : 0;
const easeOf = (ease: NoteLineEaseType | null) =>
  ease === NoteLineEaseType.EaseIn ? -1 : ease === NoteLineEaseType.EaseOut ? 1 : 0;

const originalData = (note: ResolvedNote) => ({
  [EngineArchetypeDataName.Beat]: note.beat,
  lane: laneOf(note),
  size: halfWidthOf(note),
  operateType: note.operateType,
  judgementType: note.judgementType,
  originalDirection: note.direction,
  originalTick: note.tick,
  originalTimeMs: note.timeMs,
  originalPos: note.pos,
  originalSize: note.size,
  originalCritical: note.critical ? 1 : 0,
  originalVisible: note.visible ? 1 : 0,
  originalLineId: note.lineIds[0] ?? -1,
  originalLineIndex: note.indexInLine ?? -1,
  originalEaseL: note.easeL ?? -1,
  originalEaseR: note.easeR ?? -1,
});

const withEase = (note: ResolvedNote) => ({
  ease: easeOf(note.easeR),
  easeL: easeOf(note.easeL),
  easeR: easeOf(note.easeR),
});

const isFlick = (operateType: NoteOperateType) =>
  [
    NoteOperateType.Flick,
    NoteOperateType.SlideBeginFlick,
    NoteOperateType.SlideEndFlick,
    NoteOperateType.GuideBeginFlick,
  ].includes(operateType);

const isTrace = (operateType: NoteOperateType) =>
  [
    NoteOperateType.Trace,
    NoteOperateType.SlideBeginTrace,
    NoteOperateType.SlideEndTrace,
    NoteOperateType.SlideConnectionTrace,
    NoteOperateType.GuideBeginTrace,
    NoteOperateType.GuideEndTrace,
  ].includes(operateType);

function isPairNoteType(operateType: NoteOperateType): boolean {
  switch (operateType) {
    case NoteOperateType.Normal:
    case NoteOperateType.SlideBegin:
    case NoteOperateType.SlideEnd:
    case NoteOperateType.Flick:
    case NoteOperateType.SlideBeginFlick:
    case NoteOperateType.SlideEndFlick:
      return true;
    default:
      return false;
  }
}

function flatArchetype(note: ResolvedNote): string {
  if (isFlick(note.operateType)) {
    if (isTrace(note.operateType)) return "NormalTraceFlickNote";
    return "NormalFlickNote";
  }
  if (isTrace(note.operateType)) return "NormalTraceNote";

  // Judgement conversion only changes Normal -> EasyNormal and SlideBegin ->
  // SlideBeginEasy. `crit` remains in originalData for every authored node,
  // but must not select PJS-style critical archetypes for operations whose
  // timing and visuals stay ordinary.
  return note.critical && note.operateType === NoteOperateType.Normal ? "CriticalTapNote" : "NormalTapNote";
}

function standalone(note: ResolvedNote): Intermediate {
  return {
    archetype: flatArchetype(note),
    data: {
      ...originalData(note),
      direction: isFlick(note.operateType) ? directionOf(note.direction) : undefined,
    },
    sim: isPairNoteType(note.operateType),
  };
}

function isStart(operateType: NoteOperateType) {
  return [
    NoteOperateType.SlideBegin,
    NoteOperateType.SlideBeginFlick,
    NoteOperateType.SlideBeginTrace,
    NoteOperateType.HiddenSlideBegin,
    NoteOperateType.GuideBegin,
    NoteOperateType.GuideBeginNormal,
    NoteOperateType.GuideBeginFlick,
    NoteOperateType.GuideBeginTrace,
  ].includes(operateType);
}

function isEnd(operateType: NoteOperateType) {
  return [
    NoteOperateType.SlideEnd,
    NoteOperateType.SlideEndFlick,
    NoteOperateType.SlideEndTrace,
    NoteOperateType.HiddenSlideEnd,
    NoteOperateType.GuideEnd,
    NoteOperateType.GuideEndTrace,
  ].includes(operateType);
}

function lineSortKey(note: ResolvedNote) {
  return isStart(note.operateType) ? 0 : isEnd(note.operateType) ? 2 : 1;
}

function ignored(note: ResolvedNote): Intermediate {
  return {
    archetype: "IgnoredSlideTickNote",
    data: originalData(note),
    sim: false,
    ...withEase(note),
  };
}

function guideJudgment(note: ResolvedNote, base: ReturnType<typeof originalData>): Intermediate | undefined {
  switch (note.operateType) {
    case NoteOperateType.GuideBeginNormal:
      return { archetype: "NormalTapNote", data: base, sim: true };
    case NoteOperateType.GuideBeginFlick:
      return {
        archetype: "NormalFlickNote",
        data: { ...base, direction: directionOf(note.direction) },
        sim: true,
      };
    case NoteOperateType.GuideBeginTrace:
    case NoteOperateType.SlideConnectionTrace:
      return { archetype: "NormalSlideTraceNote", data: base, sim: false };
    case NoteOperateType.GuideEndTrace:
      return { archetype: "NormalSlideEndTraceNote", data: base, sim: false };
    default:
      return undefined;
  }
}

function lineNode(
  line: NoteLine,
  note: ResolvedNote,
  index: number,
  count: number,
): {
  intermediate: Intermediate;
  judgment?: Intermediate;
  joint: boolean;
  attach: boolean;
  end: boolean;
} {
  const first = index === 0;
  const last = index === count - 1;
  const base = originalData(note);

  if (line.kind === "guide") {
    const topology = { intermediate: ignored(note), joint: true, attach: false, end: false };
    const judgment = guideJudgment(note, base);
    return judgment ? { ...topology, judgment } : topology;
  }

  if (first) {
    if (note.operateType === NoteOperateType.HiddenSlideBegin) {
      return { intermediate: ignored(note), joint: true, attach: false, end: false };
    }
    const archetype =
      note.operateType === NoteOperateType.SlideBeginFlick
        ? "NormalFlickNote"
        : note.operateType === NoteOperateType.SlideBeginTrace
          ? "NormalSlideTraceNote"
          : note.critical && note.operateType === NoteOperateType.SlideBegin
            ? "CriticalSlideStartNote"
            : "NormalSlideStartNote";
    return {
      intermediate: {
        archetype,
        data: {
          ...base,
          direction: note.operateType === NoteOperateType.SlideBeginFlick ? directionOf(note.direction) : undefined,
        },
        sim: isPairNoteType(note.operateType),
        ...withEase(note),
      },
      joint: true,
      attach: false,
      end: false,
    };
  }

  if (last) {
    if (note.operateType === NoteOperateType.HiddenSlideEnd) {
      return { intermediate: ignored(note), joint: true, attach: false, end: false };
    }
    const flick = note.operateType === NoteOperateType.SlideEndFlick;
    const trace = note.operateType === NoteOperateType.SlideEndTrace;
    const archetype = flick ? "NormalSlideEndFlickNote" : trace ? "NormalSlideEndTraceNote" : "NormalSlideEndNote";
    return {
      intermediate: {
        archetype,
        data: { ...base, direction: flick ? directionOf(note.direction) : undefined },
        sim: isPairNoteType(note.operateType),
      },
      joint: true,
      attach: false,
      end: flick || !trace,
    };
  }

  switch (note.operateType) {
    case NoteOperateType.Combo:
      return {
        intermediate: { archetype: "HiddenSlideTickNote", data: base, sim: false },
        joint: false,
        attach: true,
        end: false,
      };
    case NoteOperateType.ComboSkip:
    case NoteOperateType.Hidden:
      return { intermediate: ignored(note), joint: true, attach: false, end: false };
    case NoteOperateType.SlideConnectionTrace:
      return {
        intermediate: {
          archetype: "NormalSlideTraceNote",
          data: base,
          sim: false,
          ...withEase(note),
        },
        joint: true,
        attach: false,
        end: false,
      };
    default:
      return {
        intermediate: {
          archetype: "NormalSlideTickNote",
          data: base,
          sim: false,
          ...withEase(note),
        },
        joint: true,
        attach: false,
        end: false,
      };
  }
}

export function chartToLevelData(chart: InternalChart, offset = 0): LevelData {
  const entities: LevelDataEntity[] = [];
  const beatAndTickToSim = new Map<number, Map<number, Intermediate[]>>();
  const refs = new Map<Intermediate, string>();
  const materialized = new Map<Intermediate, LevelDataEntity>();
  let refId = 0;

  const getRef = (intermediate: Intermediate) => {
    let ref = refs.get(intermediate);
    if (!ref) {
      ref = (refId++).toString(36);
      refs.set(intermediate, ref);
      const entity = materialized.get(intermediate);
      if (entity) entity.name = ref;
    }
    return ref;
  };

  const append = (intermediate: Intermediate) => {
    const entity: LevelDataEntity = { archetype: intermediate.archetype, data: [] };
    const operateType = intermediate.data.operateType;
    if (intermediate.sim && typeof operateType === "number" && isPairNoteType(operateType)) {
      const beat = intermediate.data[EngineArchetypeDataName.Beat];
      if (typeof beat !== "number") throw new Error("simultaneous note is missing beat");
      const tick = intermediate.data.originalTick;
      if (typeof tick !== "number") throw new Error("simultaneous note is missing original tick");
      const tickToSim = beatAndTickToSim.get(beat) ?? new Map<number, Intermediate[]>();
      const group = tickToSim.get(tick) ?? [];
      group.push(intermediate);
      tickToSim.set(tick, group);
      beatAndTickToSim.set(beat, tickToSim);
    }
    const ref = refs.get(intermediate);
    if (ref) entity.name = ref;
    materialized.set(intermediate, entity);
    entities.push(entity);
    for (const [name, value] of Object.entries(intermediate.data)) {
      if (value === undefined) continue;
      entity.data.push(typeof value === "number" ? { name, value } : { name, ref: getRef(value) });
    }
  };

  append({ archetype: "Initialization", data: {}, sim: false });
  append({ archetype: "Stage", data: {}, sim: false });
  for (const bpm of chart.bpmChanges) {
    append({
      archetype: EngineArchetypeName.BpmChange,
      data: {
        [EngineArchetypeDataName.Beat]: bpm.beat,
        [EngineArchetypeDataName.Bpm]: bpm.bpm,
      },
      sim: false,
    });
  }

  const byId = new Map(chart.notes.map((note) => [note.id, note]));
  for (const note of chart.notes) if (note.lineIds.length === 0) append(standalone(note));

  for (const line of chart.lines) {
    const notes = line.noteIds
      .map((id) => byId.get(id))
      .filter((note): note is ResolvedNote => note !== undefined)
      .sort((a, b) => a.beat - b.beat || lineSortKey(a) - lineSortKey(b) || a.id - b.id);
    if (notes.length < 2) continue;

    const records = notes.map((note, index) => lineNode(line, note, index, notes.length));
    const joints = records.filter((record) => record.joint).map((record) => record.intermediate);
    const connectors: Intermediate[] = [];
    const start = records[0].intermediate;
    const end = records[records.length - 1].intermediate;
    // Connector archetype imports must match the actual start archetype. An
    // authored critical end does not turn an otherwise normal slide yellow.
    const criticalStart = start.archetype === "CriticalSlideStartNote";

    for (let i = 1; i < joints.length; i++) {
      const head = joints[i - 1];
      const tail = joints[i];
      connectors.push({
        archetype:
          line.kind === "long"
            ? criticalStart
              ? "CriticalActiveSlideConnector"
              : "NormalActiveSlideConnector"
            : criticalStart
              ? "CriticalSlideConnector"
              : "NormalSlideConnector",
        data: {
          start,
          end,
          head,
          tail,
          ease: head.ease ?? 0,
          easeL: head.easeL ?? head.ease ?? 0,
          easeR: head.easeR ?? head.ease ?? 0,
        },
        sim: false,
      });
    }

    for (const record of records) {
      if (record.attach) {
        const index = records.indexOf(record);
        const nextJoint = records.findIndex((candidate, candidateIndex) => candidateIndex > index && candidate.joint);
        const connectorIndex = Math.max(
          0,
          records.slice(0, nextJoint).filter((candidate) => candidate.joint).length - 1,
        );
        record.intermediate.data.attach = connectors[connectorIndex];
      }
      if (record.end && connectors.length) record.intermediate.data.slide = connectors[connectors.length - 1];
      append(record.intermediate);
      if (record.judgment) append(record.judgment);
    }
    for (const connector of connectors) append(connector);
  }

  for (const tickToSim of beatAndTickToSim.values()) {
    for (const group of tickToSim.values()) {
      for (let i = 1; i < group.length; i++) {
        append({ archetype: "SimLine", data: { a: group[i - 1], b: group[i] }, sim: false });
      }
    }
  }

  return { bgmOffset: offset, entities };
}
