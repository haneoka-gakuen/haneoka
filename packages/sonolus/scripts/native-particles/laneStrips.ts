import { createHash } from "node:crypto";
import type { RenderParticleEffect } from "@haneoka/cassiopeia-plugin-our-notes";
import { bakeTile } from "./bake.ts";
import { ease, type EaseName } from "./fit.ts";
import { EffectTracer, W_TO_H, type LaneSurfaceSample } from "./trace.ts";
import { decodePng } from "./textureBake.ts";

interface Channel { from: Record<string, number>; to: Record<string, number>; ease?: EaseName }
interface Particle {
  sprite: number; color: string; start: number; duration: number;
  x: Channel; y: Channel; w: Channel; h: Channel; r: Channel; a: Channel;
}
interface Sprite { x: number; y: number; w: number; h: number }
interface Effect { name: string; groups: Array<{ count: number; particles: Particle[] }> }
export interface LaneParticleData { width: number; height: number; sprites: Sprite[]; effects: Effect[] }
const LANES: Array<[string, RenderParticleEffect["kind"]]> = [
  ["In Vain", "lane-input-blank-miss"], ["Normal", "lane-effect-normal"],
  ["Slide", "lane-effect-slide"], ["Flick", "lane-effect-flick"],
  ["Flick Left", "lane-effect-flick-left"], ["Flick Right", "lane-effect-flick-right"],
];
const LIFETIME = 0.225;
const FPS = 60;
// End just before the next interval: inclusive particle ends must not draw
// both adjacent frames. This gap is below one microsecond of real time.
const END_GAP = 2e-6;
const PIXELS_Y = (1.115119873136453 + 0.5815420740473228) * 540;
const PIXELS_X = 126.92395667992498;
const VIEW_TOP = (1.115119873136453 - 1) / (1.115119873136453 + 0.5815420740473228);
const VIEW_BOTTOM = (1.115119873136453 + 1) / (1.115119873136453 + 0.5815420740473228);
const TARGET_UV_ERROR_PX = 4;
const MAX_BANDS = 96;
const constant = (c: number): Channel => ({ from: c ? { c } : {}, to: c ? { c } : {} });
const linear = (from: number, to: number): Channel => ({ from: { c: from }, to: { c: to }, ease: "linear" });
const evaluate = (channel: Channel, q: number) => (channel.from.c ?? 0) +
  ((channel.to.c ?? 0) - (channel.from.c ?? 0)) * ease(channel.ease ?? "linear", q);
const stageY = (unitY: number) => 1 - W_TO_H * (unitY + 1);
const percentile = (values: number[], p: number) => {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!;
};

/** Six lane effects only. Every new sprite is a subrectangle of retained atlas pixels. */
export async function compileLaneStripDelta(baseline: LaneParticleData, png: Buffer, releaseRoot: string) {
  if (baseline.effects.length !== 1506) throw new Error("Lane delta needs the complete 1506-effect baseline");
  const atlas = decodePng(png, "lane delta baseline");
  if (atlas.width !== baseline.width || atlas.height !== baseline.height) throw new Error("Unpaired lane baseline");
  const tracer = new EffectTracer({ releaseRoot, currentQuality: 2 });
  const sprites = baseline.sprites.slice();
  const spriteIds = new Map<string, number>();
  const reports: Array<Record<string, unknown>> = [];
  const replacements = new Map<string, Effect>();
  const laneNames = new Set(LANES.map(([label]) => `Our Notes Lane ${label}`));
  // Keep the original alpha-piece boundaries, including a discontinuous
  // half-cycle fade edge, even when it falls between 60 Hz geometry keys.
  const alphaEdges = baseline.effects.filter((e) => laneNames.has(e.name)).flatMap((e) =>
    e.groups.flatMap((g) => g.particles.flatMap((p) => [p.start, p.start + p.duration].map((q) => q * LIFETIME))));
  const phaseEdges = [...new Set([...alphaEdges,
    ...Array.from({ length: Math.ceil(LIFETIME * FPS) + 1 }, (_, i) => Math.min(LIFETIME, i / FPS))])].sort((a, b) => a - b);
  // Quarter-frame observations also check time interpolation between geometry keys.
  const sampleTimes = phaseEdges.flatMap((t, i) => i === phaseEdges.length - 1 ? [t] :
    [t, ...[.25, .5, .75].map((q) => t + (phaseEdges[i + 1]! - t) * q)]);
  const actualTimes = sampleTimes.map((t) => Math.min(t, LIFETIME - 1e-7));
  try {
    await tracer.load();
    for (const [label, kind] of LANES) {
      const name = `Our Notes Lane ${label}`;
      const original = baseline.effects.find((e) => e.name === name);
      if (!original || original.groups.length !== 1 || original.groups[0]!.count !== 1)
        throw new Error(`Unexpected lane baseline: ${name}`);
      const originals = original.groups[0]!.particles;
      const parentId = originals[0]!.sprite;
      if (originals.some((p) => p.sprite !== parentId || p.r.from.c || p.r.to.c))
        throw new Error(`Lane texture/rotation contract changed: ${name}`);
      const parent = baseline.sprites[parentId]!;
      // Recover the exact alpha crop of the retained image. It must reproduce
      // its published bytes before its UV rows can be used as geometry bands.
      const oldSamples = tracer.traceLane(kind, 2, Array.from({ length: 14 }, (_, i) => i / FPS));
      const reference = oldSamples.reduce((best, s) => Math.max(...s.emission) > Math.max(...best.emission) ? s : best);
      const tile = bakeTile({ key: `lane-crop:${name}`, file: reference.file, uv: reference.uv, emission: reference.emission,
        screenHeight: percentile(oldSamples.filter((s) => s.pixelHeight > .5 && s.pixelWidth > .05).map((s) => s.pixelHeight), .9),
        screenAspect: Math.max(.05, Math.min(20, percentile(oldSamples.filter((s) => s.pixelHeight > .5 && s.pixelWidth > .05).map((s) => s.pixelWidth / s.pixelHeight), .5))),
        mips: 0, sigmaScale: 1 / .71, bloomGain: 1 });
      const retained = Buffer.alloc(parent.w * parent.h * 4);
      for (let y = 0; y < parent.h; y++) retained.set(atlas.pixels.subarray(
        ((parent.y + y) * atlas.width + parent.x) * 4,
        ((parent.y + y) * atlas.width + parent.x + parent.w) * 4), y * parent.w * 4);
      if (tile.image.width !== parent.w || tile.image.height !== parent.h || !retained.equals(Buffer.from(tile.image.pixels)))
        throw new Error(`Published lane mask cannot be reproduced: ${name}`);
      const vMin = .5 + tile.offset[1] - tile.expand[1] / 2;
      const vMax = .5 + tile.offset[1] + tile.expand[1] / 2;
      const uMin = .5 + tile.offset[0] - tile.expand[0] / 2;
      const uMax = .5 + tile.offset[0] + tile.expand[0] / 2;
      const vAt = (row: number) => vMax - row / parent.h * (vMax - vMin);
      const surfaces = tracer.traceLaneSurfaces(kind, 2, actualTimes);
      if (surfaces.length !== actualTimes.length) throw new Error(`Missing lane surface: ${name}`);
      const point = (surface: LaneSurfaceSample, u: number, v: number) => tracer.projectLaneUV(surface.quad, u, v, .5);
      const bandError = (first: number, last: number) => {
        let worst = 0;
        for (let i = 0; i < surfaces.length; i += 4) {
          const surface = surfaces[i]!;
          const low = point(surface, .5, vAt(last)), high = point(surface, .5, vAt(first));
          if (high.depth <= high.near || stageY(high.y) > VIEW_BOTTOM) continue;
          if (low.depth <= low.near) return Infinity;
          const b = stageY(low.y), t = stageY(high.y);
          for (const v of [.25, .5, .75]) {
            const native = stageY(point(surface, .5, vAt(last) + v * (vAt(first) - vAt(last))).y);
            if (native < VIEW_TOP || native > VIEW_BOTTOM) continue;
            const predicted = b + (t - b) * v;
            // Include both triangle diagonals; their UV-center shear has the
            // same magnitude. Off-centre lanes also magnify a Y interpolation error.
            worst = Math.max(worst, Math.abs(predicted - native) * PIXELS_Y,
              (5.5 * Math.abs(predicted - native) + .5 * Math.min(v, 1 - v) * Math.abs(b - t)) * PIXELS_X);
          }
        }
        return worst;
      };
      // Put the original UV .5 exactly on a band boundary: the judgment
      // anchor remains exact throughout the size curve, including time interpolation.
      const centerRow = Math.round((vMax - .5) / (vMax - vMin) * parent.h);
      if (Math.abs(vAt(centerRow) - .5) > 1e-8) throw new Error(`Lane UV center is not an integer atlas row: ${name}`);
      const boundaries = [0];
      for (const end of [centerRow, parent.h]) {
        let first = boundaries[boundaries.length - 1]!;
        while (first < end) {
          let last = first + 1;
          while (last < end && bandError(first, last + 1) <= TARGET_UV_ERROR_PX) last++;
          boundaries.push(last); first = last;
        }
      }
      if (boundaries.length - 1 > MAX_BANDS) throw new Error(`Lane strip budget exceeded: ${name}`);
      const getSprite = (first: number, last: number) => {
        const key = `${parentId}:${first}:${last}`;
        const existing = spriteIds.get(key);
        if (existing !== undefined) return existing;
        const id = sprites.length;
        sprites.push({ x: parent.x, y: parent.y + first, w: parent.w, h: last - first });
        spriteIds.set(key, id); return id;
      };
      const particles: Particle[] = [];
      let maxActive = 0, maxTemporalError = 0, clippedRows = 0;
      for (let phase = 0; phase < phaseEdges.length - 1; phase++) {
        const t0 = phaseEdges[phase]!, t1 = phaseEdges[phase + 1]!;
        const alphaPiece = originals.find((p) => (t0 + t1) / 2 / LIFETIME >= p.start &&
          (t0 + t1) / 2 / LIFETIME < p.start + p.duration);
        if (!alphaPiece) throw new Error(`Missing original alpha interval: ${name}`);
        const alphaAt = (t: number) => evaluate(alphaPiece.a, (t / LIFETIME - alphaPiece.start) / alphaPiece.duration);
        const phaseSurfaces = surfaces.slice(phase * 4, phase * 4 + 5);
        let active = 0;
        for (let band = 0; band < boundaries.length - 1; band++) {
          const first = boundaries[band]!, last = boundaries[band + 1]!;
          // Carry the near-clip UV into an atlas-row crop. Use the most
          // restrictive lower row across this interval, so no corner crosses
          // the camera plane between its geometry keys.
          let lastVisible = last;
          for (const surface of phaseSurfaces) {
            const low = point(surface, .5, vAt(lastVisible)), high = point(surface, .5, vAt(first));
            if (high.depth <= high.near) { lastVisible = first; break; }
            if (low.depth <= low.near) {
              const fraction = (high.near + .01 - low.depth) / (high.depth - low.depth);
              lastVisible = Math.min(lastVisible, Math.floor(lastVisible - fraction * (lastVisible - first)));
            }
          }
          if (lastVisible <= first) { clippedRows += last - first; continue; }
          clippedRows += last - lastVisible;
          const rectangle = (surface: LaneSurfaceSample) => {
            const low = point(surface, uMin, vAt(lastVisible));
            const high = point(surface, uMax, vAt(first));
            if (low.depth <= low.near || high.depth <= high.near) throw new Error("Lane crop is behind the camera");
            return { x: (low.x + high.x) / 2, y: (low.y + high.y) / 2, w: (high.x - low.x) / 2, h: (high.y - low.y) / 2 };
          };
          const from = rectangle(phaseSurfaces[0]!), to = rectangle(phaseSurfaces[phaseSurfaces.length - 1]!);
          if (![...Object.values(from), ...Object.values(to)].every(Number.isFinite) || from.h <= 0 || to.h <= 0)
            throw new Error(`Invalid lane geometry: ${name}`);
          for (let i = 1; i < phaseSurfaces.length - 1; i++) {
            const actual = rectangle(phaseSurfaces[i]!), q = i / (phaseSurfaces.length - 1);
            for (const sign of [-1, 1]) {
              const nativeY = stageY(actual.y + sign * actual.h);
              if (nativeY < VIEW_TOP || nativeY > VIEW_BOTTOM) continue;
              const predictedY = stageY(from.y + (to.y - from.y) * q + sign * (from.h + (to.h - from.h) * q));
              maxTemporalError = Math.max(maxTemporalError, Math.abs(predictedY - nativeY) * PIXELS_Y);
            }
          }
          particles.push({ sprite: getSprite(first, lastVisible), color: originals[0]!.color,
            start: t0 / LIFETIME, duration: (t1 - t0) / LIFETIME - END_GAP,
            x: linear(from.x, to.x), y: linear(from.y, to.y), w: linear(from.w, to.w), h: linear(from.h, to.h),
            r: constant(0), a: linear(alphaAt(t0), alphaAt(t1)) });
          active++;
        }
        maxActive = Math.max(maxActive, active);
      }
      if (maxTemporalError > TARGET_UV_ERROR_PX) throw new Error(`Lane time interpolation exceeds budget: ${name} ${maxTemporalError}`);
      replacements.set(name, { ...original, groups: [{ count: 1, particles }] });
      reports.push({ name, bands: boundaries.length - 1, maxActiveStrips: maxActive, definitions: particles.length,
        maxTemporalErrorPx: maxTemporalError, maxBandErrorPx: Math.max(...boundaries.slice(1).map((last, i) => bandError(boundaries[i]!, last))),
        nearClippedRowsAcrossPhases: clippedRows, uvCenterRow: centerRow, crop: { uMin, uMax, vMin, vMax },
        originalMaskPixelHash: createHash("sha256").update(retained).digest("hex"), maskReproducedByteExactly: true });
    }
  } finally { tracer.dispose(); }
  return { data: { ...baseline, sprites, effects: baseline.effects.map((e) => replacements.get(e.name) ?? e) },
    report: { policy: "Source UV strips with true camera-depth clipping; 60 Hz geometry interpolation; retained atlas subrects",
      lifetime: LIFETIME, phases: phaseEdges.length - 1, frameEndGapSeconds: END_GAP * LIFETIME,
      targetReferenceErrorPx: TARGET_UV_ERROR_PX, referenceViewport: "1920x1080, locked16:9", maximumBands: MAX_BANDS,
      appendedSubrects: sprites.length - baseline.sprites.length, textureByteIdentical: true, changedEffects: LANES.length,
      unchangedEffects: baseline.effects.length - LANES.length, effects: reports } };
}
