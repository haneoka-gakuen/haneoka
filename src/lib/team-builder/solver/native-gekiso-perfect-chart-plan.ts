import type { SongOption } from "../contracts.ts";
import type { TeamBuilderData } from "../data.ts";
import type { GekisoResolved } from "./gekiso-mission-luck.ts";
import { createNativeGekisoAllComboChartPlan, nativeGekisoMissionPattern,
  type NativeGekisoChartTiming } from "./native-gekiso-chart-plan.ts";
import type { NativeGekisoSongPlan } from "./native-gekiso-evaluation.ts";

/** Uninterrupted PERFECT source-state transitions are mission-independent.
 * The selected runtime proves each Luck charge < both gauge maxima, making
 * pending lots zero after every note and removing update-cadence dependence. */
export function createNativeGekisoPerfectChartPlan(data: TeamBuilderData, song: SongOption,
  timing: NativeGekisoChartTiming): GekisoResolved<NativeGekisoSongPlan> {
  const combo = createNativeGekisoAllComboChartPlan(data, song, timing);
  if (combo.value) return combo;
  const missions = song.segments.map((range) => range.mission);
  const luckCount = missions.filter((mission) => mission === 2).length;
  if (missions.length !== 3 || missions.some((mission) => ![1, 2, 3].includes(mission)) || luckCount > 1)
    return { value: null, gaps: [{ code: "native-gekiso-perfect-driver-luck-count-unresolved", source: song.key }] };
  const shape = { ...song, segments: song.segments.map((range) => ({ ...range, mission: 1 })) };
  const built = createNativeGekisoAllComboChartPlan(data, shape, timing, { effectTypes: [11001, 12000, 13000] });
  if (!built.value) return built;
  return { value: { ...built.value, producer: luckCount
    ? "native-single-luck-ap-event-reduction-v1" : "native-no-luck-ap-event-reduction-v1",
    missionPattern: nativeGekisoMissionPattern(missions)!, frames: built.value.frames.map((frame) => ({ ...frame,
      rangeUpdates: frame.rangeUpdates.map((update) => ({ ...update, mission: missions[update.rangeIndex]! })),
    })) }, gaps: [] };
}
