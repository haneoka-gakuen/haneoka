// L3 — GEB
// Input: Pinned native song metadata and the chart's canonical note and fever timelines.
// Output: Solo scoring and GEKISO arguments on the Sonolus Initialization entity.
// Pos: [Map](../../L2-2.md).
// Effects/Dependencies: Only changes the immutable LevelData generated for this source.
import type { LevelData } from "@sonolus/core";
import type { convertChart } from "@haneoka/cassiopeia-plugin-sonolus";

type Chart = ReturnType<typeof convertChart>;
type NativeChart = Chart & {
  timeline?: {
    fever: ReadonlyArray<{ startTimeMs: number; endTimeMs: number }>;
  };
};

const lightScoreNotes = new Set([21, 60, 61, 62, 63, 104, 105, 120]);

export function projectSoloModeParameters(
  song: Readonly<Record<string, unknown>>,
  difficulty: Readonly<Record<string, unknown>>,
): Readonly<Record<string, number>> {
  const result: Record<string, number> = {};
  if (typeof difficulty.playLevel === "number") result.ourNotesPlayLevel = difficulty.playLevel;
  const gekisou = song.gekisou;
  if (!gekisou || typeof gekisou !== "object" || !("missionTypes" in gekisou)) return result;
  const { missionTypes } = gekisou;
  if (Array.isArray(missionTypes)) {
    missionTypes.slice(0, 3).forEach((mission, index) => {
      if (Number.isInteger(mission) && mission >= 1 && mission <= 3) result[`ourNotesMission${index + 1}`] = mission;
    });
  }
  return result;
}

export function levelWithSoloModes(
  data: LevelData,
  source: NativeChart,
  parameters?: Readonly<Record<string, number>>,
): LevelData {
  if (!parameters) return data;
  const initialization = data.entities[0];
  if (!initialization || initialization.archetype !== "Initialization") return data;

  const judged = source.notes.filter(note => note.judged);
  const values = {
    ...parameters,
    ourNotesJudgedNoteCount: judged.length,
    ourNotesConvertedNoteCount:
      Math.ceil(judged.reduce((sum, note) => sum + (lightScoreNotes.has(note.operateType) ? 1 : 10), 0) / 10),
  };
  for (const [name, value] of Object.entries(values)) initialization.data.push({ name, value });
  for (const [index, range] of (source.timeline?.fever ?? []).slice(0, 3).entries()) {
    initialization.data.push(
      { name: `ourNotesMissionStart${index + 1}`, value: range.startTimeMs },
      { name: `ourNotesMissionEnd${index + 1}`, value: range.endTimeMs },
    );
  }
  return data;
}
