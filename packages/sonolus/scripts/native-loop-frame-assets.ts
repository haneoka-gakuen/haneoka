// Input: authored particle packs and the engine's short-loop contract.
// Output: optional single-cycle slide frames with the original sprites and channels.
// Pos: late-stage Sonolus resource producer; direct map: ../L2-2.md.
// Effects: replaces verified repeated timelines and refreshes pack identities; writes a reduction report.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { isDeepStrictEqual } from "node:util";
import {
  LOOP_FRAME_DURATION,
} from "../../../.dependencies/sonolus-our-notes/shared/src/engine/data/loopFrameContract.ts";
import {
  nativeLoopEffectDuration,
} from "../../../.dependencies/sonolus-our-notes/shared/src/engine/data/nativeEffects.ts";
import { NATIVE_PARTICLE_PACKS } from "../src/shared/particlePacks.ts";
import { NATIVE_LOOP_FRAME_REPLACEMENTS } from "../src/shared/nativeDrawCapabilities.ts";
import type { ParticleData } from "./native-particles/merge.ts";
import { refreshNativeParticlePackReports } from "./native-particles/packs.ts";
import { durationBeforeNextPhase, type TrajectoryParticle } from "./native-particles/trajectory.ts";

type Effect = {
  name: string;
  transform: unknown;
  groups: Array<{ count: number; particles: TrajectoryParticle[] }>;
};
// Float32 timeline endpoints lose precision when expanded across many cycles.
const phaseTolerance = 0.00001;
const channels = ({ start: _start, duration: _duration, ...body }: TrajectoryParticle) => body;
const phase = (value: number) => Math.round(value * 1e6) / 1e6;
const holdPlaneOpacity = {
  standard: [1, 1, 1, 0.75],
  light: [0.8, 0.8, 0.8, 1.03],
  simple: [1, 1, 1, 1],
};

/** Calibrate the sustained slide against the source at phone and desktop resolutions. */
export function calibrateHoldLoopExposure(data: ParticleData, profile: keyof typeof holdPlaneOpacity): void {
  for (const effect of data.effects as Effect[]) {
    const plane = /^Our Notes Native Slide Loop W\d+ P([0-3])$/u.exec(effect.name)?.[1];
    if (plane === undefined) continue;
    const opacity = holdPlaneOpacity[profile][Number(plane)]!;
    if (opacity === 1) continue;
    for (const group of effect.groups) {
      for (const particle of group.particles) {
        for (const endpoint of [particle.a.from, particle.a.to]) {
          for (const [key, value] of Object.entries(endpoint)) {
            endpoint[key] = Math.fround(value * opacity);
          }
        }
      }
    }
  }
}

/** Fold only timelines whose ordered particle programs repeat for every source cycle. */
export function compactLoopFrame(effect: Effect, duration: number): Effect | undefined {
  const cycles = Math.round(duration / LOOP_FRAME_DURATION);
  const groups: Effect["groups"] = [];
  for (const group of effect.groups) {
    const repetitions = Array.from({ length: cycles }, () => [] as TrajectoryParticle[]);
    for (const particle of group.particles) {
      const time = particle.start * cycles;
      const cycle = Math.floor(time + phaseTolerance);
      if (cycle < 0 || cycle >= cycles || time - cycle + particle.duration * cycles > 1 + phaseTolerance) return;
      repetitions[cycle]!.push({ ...particle, start: time - cycle, duration: particle.duration * cycles });
    }
    const first = repetitions[0]!;
    if (first.some((particle) => phase(particle.start + particle.duration) <= phase(particle.start))) return;
    for (const repetition of repetitions) {
      if (repetition.length !== first.length) return;
      for (const [index, particle] of repetition.entries()) {
        const reference = first[index]!;
        if (
          Math.abs(particle.start - reference.start) > phaseTolerance ||
          Math.abs(particle.duration - reference.duration) > phaseTolerance ||
          !isDeepStrictEqual(channels(particle), channels(reference))
        )
          return;
      }
    }
    groups.push({
      count: group.count,
      particles: first.map((particle) => {
        const start = phase(particle.start);
        const end = phase(particle.start + particle.duration);
        return { ...particle, start, duration: durationBeforeNextPhase(start, end) };
      }),
    });
  }
  return { ...effect, groups };
}

export function buildNativeLoopFrameAssets(directory: string) {
  const reports = [];
  for (const pack of NATIVE_PARTICLE_PACKS) {
    const file = resolve(directory, "particles", pack.key, "particle.data");
    const data = JSON.parse(gunzipSync(readFileSync(file)).toString()) as ParticleData;
    calibrateHoldLoopExposure(data, pack.key);
    const effects = new Map((data.effects as Effect[]).map((effect) => [effect.name, effect]));
    const duration = nativeLoopEffectDuration(pack.key === "simple" ? 2 : 1);
    for (const [legacyName, compactName] of NATIVE_LOOP_FRAME_REPLACEMENTS) {
      const source = effects.get(legacyName);
      if (!source) continue;
      const compact = compactLoopFrame(source, duration);
      if (!compact) {
        effects.delete(compactName);
        continue;
      }
      effects.set(compactName, { ...compact, name: compactName });
      effects.delete(legacyName);
      reports.push({
        profile: pack.key,
        effect: compactName,
        duration: LOOP_FRAME_DURATION,
        definitionsBefore: source.groups.reduce((n, group) => n + group.particles.length, 0),
        definitionsAfter: compact.groups.reduce((n, group) => n + group.particles.length, 0),
      });
    }
    data.effects = [...effects.values()];
    writeFileSync(file, gzipSync(JSON.stringify(data), { level: 9 }));
  }
  refreshNativeParticlePackReports(directory);
  writeFileSync(resolve(directory, "native-loop-frame-proof.json"), JSON.stringify({ reports }, null, 2) + "\n");
  return reports;
}
