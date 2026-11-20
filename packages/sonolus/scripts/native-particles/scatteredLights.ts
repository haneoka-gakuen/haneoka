// L3 — GEB
// Input: Hit-effect billboard traces and the assembled Sonolus particle packs.
// Output: Compact P0 trajectories on a shared procedural core and halo.
// Pos: [Map](../../L2-2.md); offline particle pack authoring.
// Effects/Dependencies: Replaces qualified P0 effects and refreshes the short-effect aliases.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { constants, gunzipSync, gzipSync } from "node:zlib";
import { retimeShortParticleEffect } from "../../../../.dependencies/sonolus-our-notes/scripts/build-native-particle-lifetime-assets.ts";
import { NATIVE_EFFECT_PLANES, NATIVE_EFFECT_WIDTHS, NATIVE_SHORT_EFFECT_DURATION_RATIO, nativeNoteEffectDuration } from "../../../../.dependencies/sonolus-our-notes/shared/src/engine/data/nativeEffects.ts";
import { packAtlas, type Tile } from "./bake.ts";
import { quadParams } from "./compile.ts";
import { mergeNativeParticleDelta, type ParticleData } from "./merge.ts";
import { refreshNativeParticlePackReports } from "./packs.ts";
import { repackParticleAtlas } from "./repack.ts";
import { EffectTracer, effectPixelOrigin, unitsPerPixel, W_TO_H, type ParticleSample } from "./trace.ts";
import { durationBeforeNextPhase, type TrajectoryParticle } from "./trajectory.ts";

const targets = [
  { name: "Normal", kind: "tap", op: 10, perfect: true, great: true, peakDraws: 16 },
  { name: "Slide", kind: "slide", op: 20, perfect: true, great: false, peakDraws: 16 },
  { name: "Connect", kind: "connect", op: 60, perfect: true, great: false, peakDraws: 16 },
  { name: "Flick", kind: "flick", op: 40, perfect: true, great: true, peakDraws: 12 },
] as const;
const frameRate = 60;
const sampleSeed = 4660;
const channels = ["x", "y", "w", "h", "r", "a"] as const;
type Channel = typeof channels[number];
type Rgb = readonly [number, number, number];
const round = (number: number) => Number(number.toFixed(5));
const clamp = (value: number) => Math.max(0, Math.min(1, value));
const materials = [
  { name: "white", core: [1, 1, 1], halo: [1, 1, 1], expand: [3.1, 2.2] },
  { name: "cyan", core: [0.83, 0.92, 1], halo: [0.18, 0.56, 1], expand: [3.1, 2.2] },
  { name: "violet", core: [0.95, 0.94, 1], halo: [0.38, 0.33, 1], expand: [3.1, 2.2] },
  { name: "glint", core: [1, 0.93, 0.82], halo: [1, 0.55, 0.24], expand: [2.3, 1.8] },
  { name: "streak", core: [1, 0.93, 0.82], halo: [1, 0.55, 0.24], expand: [1.7, 1.16] },
  { name: "column", core: [1, 0.76, 0.56], halo: [1, 0.7, 0.55], expand: [1, 1] },
] as const satisfies readonly { name: string; core: Rgb; halo: Rgb; expand: readonly [number, number] }[];
const columnSprite = materials.findIndex(({ name }) => name === "column");

interface LightSample {
  time: number;
  values: Record<Channel, number>;
  flux: number;
  area: number;
  pixelScale: { x: number; y: number };
}

interface LightTrack {
  samples: LightSample[];
  sprite: number;
  definitionStart: number;
  end: number;
  value: number;
}

/** Pack the neutral core and tinted halo into the same quad. */
function lightTile(material: typeof materials[number]): Tile {
  const side = 32;
  const pixels = new Uint8Array(side * side * 4);
  const streak = material.name === "streak";
  const glint = material.name === "glint";
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      const u = (2 * (x + 0.5)) / side - 1;
      const v = (2 * (y + 0.5)) / side - 1;
      const radius = u * u + v * v;
      const coreY = v + (streak ? 0.39 : glint ? 0.22 : 0);
      const core = Math.exp(-((u / (streak || glint ? 0.15 : 0.23)) ** 2 + (coreY / (streak ? 0.115 : 0.25)) ** 2) / 2);
      const halo = (1 - core) * (streak ? 0.33 : 0.42) *
        Math.exp(-((u / (streak ? 0.34 : 0.51)) ** 2 + ((v + (streak ? 0.16 : 0)) / (streak ? 0.48 : 0.54)) ** 2) / 2);
      const alpha = clamp((1 - radius) * 4) * (core + halo);
      const offset = (y * side + x) * 4;
      for (let channel = 0; channel < 3; channel++)
        pixels[offset + channel] = Math.round(255 * (core * material.core[channel]! + halo * material.halo[channel]!) / (core + halo));
      pixels[offset + 3] = Math.round(255 * (material.name === "column"
        ? clamp((1 - radius) * 3) * Math.exp(-3.9 * radius)
        : alpha));
    }
  }
  return { key: material.name, image: { width: side, height: side, pixels }, expand: material.expand, offset: [0, 0], response: new Float32Array() };
}

function visibleTracks(samples: readonly ParticleSample[], width: number, duration: number, material: number) {
  const actors = new Map<string, ParticleSample[]>();
  for (const sample of samples) {
    if (sample.plane !== 0) continue;
    const identity = `${sample.system}:${sample.emission_}:${sample.sourceClock?.realTimeOffset ?? 0}`;
    const frames = actors.get(identity) ?? [];
    frames.push(sample);
    actors.set(identity, frames);
  }
  const units = unitsPerPixel(width / 4);
  const plane = NATIVE_EFFECT_PLANES[0];
  const [, originY] = effectPixelOrigin();
  const tracks: LightTrack[] = [];
  for (const frames of actors.values()) {
    const system = frames[0]!.systemName;
    const sprite = system === "ef_particle_point02" ? 4 : system === "ef_particle_point01" ? 3 : material;
    const expand = materials[sprite]!.expand;
    let previousRotation: number | undefined;
    const observations = frames.map((sample): LightSample => {
      const projected = quadParams(sample, expand, width, previousRotation);
      previousRotation = projected.r;
      const peak = Math.max(...sample.emission);
      const a = clamp(peak * (sprite >= 3 ? 0.56 : 0.95));
      const alpha = plane.alpha1 - plane.slope * (projected.y + 1) * W_TO_H;
      const pixelScale = { x: alpha / units.x, y: 1 / units.y };
      const y = originY + (projected.y + 1) * pixelScale.y;
      const visible = y > -sample.pixelHeight / 2 && y < 1080 + sample.pixelHeight / 2;
      const area = sample.pixelArea * (sprite >= 3 ? 0.2 : 0.55);
      return { time: sample.t, values: { ...projected, a },
        flux: visible ? Math.min(96, area) * a : 0, area, pixelScale };
    });
    const peakFlux = Math.max(...observations.map((sample) => sample.flux));
    const visible = observations.filter((sample) => sample.flux >= Math.max(0.45, peakFlux * 0.06));
    if (peakFlux < 1.1 || !visible.length) continue;
    const first = visible[0]!;
    const last = visible.at(-1)!;
    const kept = observations.filter((sample) => sample.time >= first.time && sample.time <= last.time);
    tracks.push({ samples: kept, sprite,
      definitionStart: Math.max(0, first.time - 0.5 / frameRate, frames[0]!.birth),
      end: Math.min(duration, last.time + 0.5 / frameRate, frames[0]!.birth + frames[0]!.lifetime),
      value: kept.reduce((sum, sample) => sum + Math.sqrt(sample.flux), 0) });
  }
  return tracks;
}

/** A single soft quad carries the light shared by the overlapping up-flick streaks. */
function columnGlow(tracks: readonly LightTrack[], duration: number, phaseScale: number): TrajectoryParticle[] {
  const frames = new Map<number, LightSample[]>();
  for (const track of tracks) if (track.sprite === 4) for (const sample of track.samples) {
    if (sample.flux <= 0) continue;
    const list = frames.get(sample.time) ?? [];
    list.push(sample);
    frames.set(sample.time, list);
  }
  const samples = [...frames].sort(([a], [b]) => a - b).map(([time, frame]): LightSample => {
    const pixelScale = frame[0]!.pixelScale;
    const energy = frame.reduce((sum, sample) => sum + sample.flux, 0);
    const centre = frame.map(({ values: { x, y, h, r } }) => [x - 0.39 * h * Math.sin(r), y + 0.39 * h * Math.cos(r)] as const);
    const mean = (c: 0 | 1) => centre.reduce((sum, p, i) => sum + p[c] * frame[i]!.flux, 0) / energy;
    const x = mean(0), y = mean(1);
    const spread = (c: 0 | 1, average: number) => centre.reduce((sum, p, i) => sum + (p[c] - average) ** 2 * frame[i]!.flux, 0) / energy;
    const w = Math.min(155 / pixelScale.x, Math.hypot(59 / pixelScale.x, 1.7 * Math.sqrt(spread(0, x))));
    const h = Math.min(410 / pixelScale.y, Math.hypot(145 / pixelScale.y, 1.7 * Math.sqrt(spread(1, y))));
    const a = 0.52 * (1 - Math.exp(-energy / 260));
    return { time, area: 0, flux: energy, pixelScale, values: { x, y, w, h, a, r: 0 } };
  });
  const first = samples[0], last = samples.at(-1);
  if (!first || !last) return [];
  return fitTrack({ samples, sprite: columnSprite, definitionStart: Math.max(0, first.time - 0.5 / frameRate),
    end: Math.min(duration, last.time + 0.5 / frameRate), value: 0 }, duration, phaseScale);
}

/** Retain complete visible trajectories, capped even where bursts overlap. */
function selectTracks(tracks: LightTrack[], peakDraws: number): LightTrack[] {
  const buckets = new Map<number, number>();
  const streaks = new Map<number, number>();
  return tracks.sort((a, b) => b.value - a.value).filter(({ definitionStart, end, sprite }) => {
    const firstBucket = Math.floor(definitionStart * frameRate * 2);
    const lastBucket = Math.ceil(end * frameRate * 2);
    for (let frame = firstBucket; frame <= lastBucket; frame++) {
      if ((buckets.get(frame) ?? 0) >= peakDraws || (sprite === 4 && (streaks.get(frame) ?? 0) >= 8)) return false;
    }
    for (let frame = firstBucket; frame <= lastBucket; frame++) {
      buckets.set(frame, (buckets.get(frame) ?? 0) + 1);
      if (sprite === 4) streaks.set(frame, (streaks.get(frame) ?? 0) + 1);
    }
    return true;
  });
}

/** Use the longest linear segment within the position and exposure tolerances. */
function fitTrack(track: LightTrack, duration: number, phaseScale: number): TrajectoryParticle[] {
  const { samples, sprite, definitionStart, end } = track;
  if (end <= definitionStart) return [];
  const particles: TrajectoryParticle[] = [];
  const endpoints = [
    { ...samples[0]!, time: definitionStart, values: { ...samples[0]!.values, a: 0 } },
    ...samples.filter((s) => s.time > definitionStart && s.time < end),
    { ...samples.at(-1)!, time: end, values: { ...samples.at(-1)!.values, a: 0 } },
  ];
  for (let from = 0; from < endpoints.length - 1;) {
    const a = endpoints[from]!;
    let to = from + 1;
    while (to + 1 < endpoints.length) {
      const candidate = endpoints[to + 1]!;
      const fits = endpoints.slice(from + 1, to + 1).every((sample) => {
        const q = (sample.time - a.time) / (candidate.time - a.time);
        const error = (key: Channel) => sample.values[key] -
          (a.values[key] + (candidate.values[key] - a.values[key]) * q);
        const geometry = Math.hypot((Math.abs(error("x")) + Math.abs(error("w"))) * sample.pixelScale.x,
          (Math.abs(error("y")) + Math.abs(error("h"))) * sample.pixelScale.y);
        const tolerance = sprite === columnSprite ? 20 : sprite === 4 ? 6 : 3.4;
        return geometry <= tolerance && Math.abs(error("a")) <= (sprite === columnSprite ? 0.025 : sample.area > 8 ? 0.14 : 0.3);
      });
      if (!fits) break;
      to++;
    }
    const b = endpoints[to]!;
    const start = a.time / duration;
    const stop = b.time / duration;
    if (a.values.a > 0 || b.values.a > 0) {
      const values = {} as Pick<TrajectoryParticle, Channel>;
      for (const key of channels) {
        const left = round(a.values[key]), right = round(b.values[key]);
        values[key] = { from: { c: left }, to: { c: right }, ...(left === right ? {} : { ease: "linear" }) };
      }
      // Retire this phase before the next one on the full and shortened Float32 clocks.
      const span = to === endpoints.length - 1 ? stop - start : Math.min(
        durationBeforeNextPhase(start, stop),
        durationBeforeNextPhase(start * phaseScale, stop * phaseScale) / phaseScale,
      );
      particles.push({ ...values, sprite, color: "#fff", start, duration: span });
    }
    from = to;
  }
  return particles;
}

export async function buildScatteredLights(directory: string, releaseRoot: string) {
  const pack = resolve(directory, "particles/simple");
  const dataFile = resolve(pack, "particle.data");
  const textureFile = resolve(pack, "particle.texture.png");
  const original = JSON.parse(gunzipSync(readFileSync(dataFile)).toString()) as ParticleData;
  const baseline = new Map(original.effects.map((effect) => [effect.name, effect]));
  const atlas = packAtlas(materials.map(lightTile));
  const tracer = new EffectTracer({ releaseRoot, currentQuality: 0, noteEffectSkin: "effect001Simple" });
  const effects: ParticleData["effects"] = [];
  await tracer.load();
  try {
    for (const target of targets) {
      for (const judgement of ["perfect", "great"] as const) {
        if (!target[judgement]) continue;
        const duration = nativeNoteEffectDuration(2, target.op, judgement === "great" ? 4 : 5);
        const phaseScale = target.kind === "flick" && judgement === "perfect" ? 1 / NATIVE_SHORT_EFFECT_DURATION_RATIO : 1;
        const times = Array.from({ length: Math.round(duration * frameRate) + 1 }, (_, i) => i / frameRate);
        const label = judgement === "great" ? " Great" : "";
        for (const width of NATIVE_EFFECT_WIDTHS) {
          const name = `Our Notes Native ${target.name}${label} W${width} P0`;
          const effect = baseline.get(name);
          if (!effect) throw new Error(`Missing scattered light layer: ${name}`);
          const source = tracer.trace({ kind: target.kind, direction: "none", judgement, lifetime: duration },
            width, times, [sampleSeed], { meshes: false });
          const material = target.kind === "tap" ? (judgement === "great" ? 0 : 1) : 2;
          const tracks = visibleTracks(source.particles, width, duration, material);
          const glow = target.kind === "flick" ? columnGlow(tracks, duration, phaseScale) : [];
          const selected = selectTracks(tracks, target.peakDraws - (glow.length ? 1 : 0));
          const particles = [...glow, ...selected.flatMap((track) => fitTrack(track, duration, phaseScale))];
          if (!particles.length) throw new Error(`Empty scattered light layer: ${name}`);
          const rebuilt = { ...effect, name, groups: [{ count: 1, particles }] };
          effects.push(rebuilt);
          if (phaseScale !== 1) {
            const short = `Our Notes Native Flick Short W${width} P0`;
            effects.push(retimeShortParticleEffect(rebuilt, short).effect);
          }
        }
      }
    }
  } finally {
    tracer.dispose();
  }
  const merged = mergeNativeParticleDelta(original, readFileSync(textureFile), { effects, atlas });
  const packed = repackParticleAtlas(merged.data, merged.png, original.width, { maximumHeight: original.height });
  writeFileSync(dataFile, gzipSync(JSON.stringify(packed.data), { level: 9, strategy: constants.Z_FILTERED }));
  writeFileSync(textureFile, packed.png);
  refreshNativeParticlePackReports(directory);
  return effects.length;
}
