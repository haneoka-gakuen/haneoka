import { NATIVE_PARTICLE_PACKS } from "./particlePacks.ts";
import { LOOP_FRAME_EFFECTS } from "../../../../.dependencies/sonolus-our-notes/shared/src/engine/data/loopFrameContract.ts";

export const NATIVE_PARTICLE_OPTIONAL_DRAW_CAPABILITIES: readonly string[] = NATIVE_PARTICLE_PACKS.flatMap(
  ({ key }) => [`Our Notes Source Connect Draw ${key}`, `Our Notes Source Connect Frame Draw ${key}`],
);

export const NATIVE_PARTICLE_OPTIONAL_EFFECTS: readonly string[] = [
  ...NATIVE_PARTICLE_OPTIONAL_DRAW_CAPABILITIES,
  ...Object.values(LOOP_FRAME_EFFECTS),
];

/** Play, Watch and Tutorial all prefer these compact, single-cycle effects. */
export const NATIVE_LOOP_FRAME_REPLACEMENTS: ReadonlyMap<string, string> = new Map(
  Object.values(LOOP_FRAME_EFFECTS).map((name) => [
    name.replace("Our Notes Source Slide Loop Frame", "Our Notes Native Slide Loop") + " P3",
    name,
  ]),
);
