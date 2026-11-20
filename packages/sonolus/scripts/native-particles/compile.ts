// Compiles the Our Notes effect001 hit effects into native Sonolus particle
// effects.
//
//  1. trace.ts samples the web renderer's own evaluator for several seeds.
//  2. Every textured quad becomes a Sonolus sprite tile with its HDR colour and
//     bloom halo baked in (bake.ts).
//  3. Deterministic rigs (wall, frame, pillars, lane fill) are fitted as
//     piecewise channels; random particle systems are grouped into cohorts of
//     consecutive emissions whose channels are linear in r1..r8, the same
//     eight Unity draws sampleParticle uses. Each Sonolus instance randomizes
//     the fitted channels; the fit and alpha composition remain approximations.
//  4. Effects are authored for several chart widths so sprite aspect survives
//     wide notes; the engine picks the nearest width and stretches the rest.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type RenderParticleEffect } from "@haneoka/cassiopeia-plugin-our-notes";
import {
  bakeCompositeHalo,
  bloomKernel,
  HALO_KERNEL,
  BLOOM_SIGMAS,
  RIG_BLOOM_MIPS,
  bakeKernelTile,
  bakeTile,
  downsamplePremultipliedTile,
  kernelAlpha,
  packAtlas,
  prefilteredFlux,
  responseAt,
  type BloomKernel,
  type Tile,
} from "./bake.ts";
import {
  capToCeiling,
  capToBounds,
  expressionJson,
  expressionValue,
  fitChannel,
  fitAnchoredChannel,
  randomFeature,
  raiseToFloor,
  type ChannelFit,
  type EaseName,
  type Observation,
} from "./fit.ts";
import { ease } from "./fit.ts";
import { sampleSourceParticleSlots, sourceParticleFamily, type SourceParticleBudgetReport } from "./budget.ts";
import { EffectTracer, W_TO_H, unitsPerPixel, type ParticleSample, type QuadSample, type TextureKey } from "./trace.ts";
import { compressSourceTrajectory, durationBeforeNextPhase, trajectoryCoverage, type TrajectoryParticle } from "./trajectory.ts";
import { compileSourceLaneWarp, SOURCE_LANE_EFFECTS as LANE_KINDS, type CompiledLaneWarp } from "./laneWarp.ts";
import { decodeRgba8Png } from "../pack-original-note-skins.ts";
import { calibrateStarColour } from "./starColour.ts";

interface NativeEffectContract {
  nativeEffects: {
    profiles: readonly string[];
    profileQualities: readonly number[];
    /** Authored NoteEffectSkin asset for each profile (defaults to effect001). */
    profileSkins?: readonly ("effect001" | "effect001Simple")[];
    widths: readonly number[];
    planes: readonly { label: string; alpha1: number; slope: number }[];
    baseNames: Readonly<Record<string, string>>;
    timings?: { loopParticle: number; loopParticles?: readonly number[] };
  };
}

const nativeEffectContract = JSON.parse(
  readFileSync(fileURLToPath(import.meta.resolve("@haneoka/sonolus-our-notes/contract/native-effects.json")), "utf8"),
) as NativeEffectContract;
const nativeEffects = nativeEffectContract.nativeEffects;

/** Chart widths with their own authored effects (84% of notes are 6 or 8). */
export const NATIVE_EFFECT_WIDTHS = nativeEffects.widths;

const SEEDS = [0x4f4e, 0x1234, 0xbeef, 0x51a7, 0x7777, 0x2468];
/** Eases considered for random cohorts; rigs use the full set. */
const COHORT_EASES: readonly EaseName[] = [
  "linear",
  "inQuad",
  "outQuad",
  "inOutQuad",
  "inCubic",
  "outCubic",
  "outQuart",
  "outExpo",
  "inExpo",
  "outCirc",
  "inOutSine",
];
const MAX_FEATURES = 4;
const COHORT_SIZE = 8;
/** Dense-swarm HDR bloom (swarmBloomGroups). */
const SWARM_KEYFRAMES = 4;
const SWARM_DENSITY = 1 / 6;
const SWARM_VISIBILITY = Number(process.env.SONOLUS_SWARM_VISIBILITY ?? Infinity);
const VELOCITY_BINS = Number(process.env.SONOLUS_VELOCITY_BINS ?? 2);
const LIFETIME_SPREAD = 0.1;
const MAX_LIFETIME_BINS = Number(process.env.SONOLUS_LIFETIME_BINS ?? 4);
/** SONOLUS_FIT_REPORT: per-cohort fit error relative to the channel mean (x/y per 20 px). */
export const fitReport: string[] = [];
export const motionFitReport: Array<Record<string, unknown>> = [];
/** Star near bloom: per-star halo particles baked from mips 1..STAR_HALO_MIPS-1. */
const STAR_HALOS = process.env.SONOLUS_STAR_HALOS === "1";
const STAR_HALO_MIPS = 3;
/** Slots born within this many seconds share one Sonolus group. */
const BIRTH_WINDOW = 1 / 120;
const MAX_MESH_PIECES = 6;
const MAX_COHORT_PIECES = Number(process.env.SONOLUS_COHORT_PIECES ?? 2);
/**
 * Unity draws (trace.ts DRAW_OFFSETS: shape x/y/z, lifetime, size, velocity,
 * rotation, colour) that physically drive each Sonolus channel.
 */
const CHANNEL_DRAWS: Readonly<Record<"x" | "y" | "w" | "h" | "r" | "a", readonly number[]>> = {
  // Velocity-over-lifetime is evaluated at normalized age: the lifetime
  // draw (3) moves every particle's path, not only its fade.
  x: [0, 1, 2, 5, 3],
  y: [0, 1, 2, 5, 3],
  w: [4],
  h: [4],
  r: [6],
  a: [3, 4],
};
const POSITION_TOLERANCE = 0.03;
const ALPHA_TOLERANCE = 0.04;
/** Calibrated against the web renderer in the Sonolus preview harness. */
const BLOOM_GAIN = Number(process.env.SONOLUS_PARTICLE_BLOOM_GAIN ?? "1");

export interface EffectSpec {
  name: string;
  kind: RenderParticleEffect["kind"];
  direction: RenderParticleEffect["direction"];
  judgement: RenderParticleEffect["judgement"];
  lifetime: number;
  loop?: { period: number };
  /** Lane fills are drawn by the base camera: no bloom, ground layout. */
  lane?: boolean;
}

const JUDGEMENTS = [
  { suffix: "", judgement: "perfect" },
  { suffix: " Great", judgement: "great" },
  { suffix: " Good", judgement: "good" },
  { suffix: " Bad", judgement: "bad" },
] as const;

const NOTE_KINDS = [
  { label: nativeEffects.baseNames.normalNoteCircular!, kind: "tap", direction: "none", slot: "Normal" },
  { label: nativeEffects.baseNames.slideNoteCircular!, kind: "slide", direction: "none", slot: "Slide" },
  { label: nativeEffects.baseNames.flickNoteCircular!, kind: "flick", direction: "up", slot: "Flick" },
  { label: nativeEffects.baseNames.flickLeftWall!, kind: "flick", direction: "left", slot: "Left" },
  { label: nativeEffects.baseNames.flickRightWall!, kind: "flick", direction: "right", slot: "Right" },
  { label: nativeEffects.baseNames.normalTraceNoteCircular!, kind: "connect", direction: "none", slot: "Connect" },
] as const;

export const nativeEffectName = (base: string, width: number): string => `${base} W${width}`;

/**
 * Plane layers. Every effect001 quad lies on a plane containing the world x
 * axis, where the on-screen lane offset is linear in screen y. Each layer is
 * its own Sonolus effect that the engine spawns with that plane's corners
 * (nativeEffects.ts NATIVE_EFFECT_PLANES), so parallax is exact at every lane.
 * Depths are relative to the judgement line (Three z; negative = farther).
 */
export const NATIVE_EFFECT_PLANES = nativeEffects.planes;

const planeOf = (sample: QuadSample): number => sample.plane;
const majorityPlane = (samples: readonly QuadSample[]): number => {
  const counts = Array.from({ length: NATIVE_EFFECT_PLANES.length }, () => 0);
  for (const sample of samples) counts[sample.plane]! += 1;
  return counts.indexOf(Math.max(...counts));
};

/** Native effect profiles: MasterLiveQualitySettings Low loads effect001Light. */
export const NATIVE_EFFECT_PROFILES = nativeEffects.profiles.map((prefix, index) => ({
  prefix,
  quality: nativeEffects.profileQualities[index]!,
  noteEffectSkin: nativeEffects.profileSkins?.[index] ?? "effect001",
}));

/** MasterLiveQualitySettings _effectRenderingScale by quality (0 High, 2 Low). */
const EFFECT_RENDERING_SCALE: Readonly<Record<number, number>> = { 0: 1, 1: 0.85, 2: 0.71 };

type Json = Record<string, unknown>;

interface QuadParams {
  x: number;
  y: number;
  w: number;
  h: number;
  r: number;
}

export function quadParams(
  sample: QuadSample,
  expand: readonly [number, number],
  width: number,
  previousR?: number,
  offset: readonly [number, number] = [0, 0],
): QuadParams {
  const [c0, c1, c2, c3] = sample.corners;
  const x = (c0.x + c1.x + c2.x + c3.x) / 4;
  const y = (c0.y + c1.y + c2.y + c3.y) / 4;
  const ux = (c1.x - c0.x + (c2.x - c3.x)) / 2;
  const uy = (c1.y - c0.y + (c2.y - c3.y)) / 2;
  const vx = (c3.x - c0.x + (c2.x - c1.x)) / 2;
  const vy = (c3.y - c0.y + (c2.y - c1.y)) / 2;
  // Projection can shear a billboard in normalized spawn space. Choosing
  // its u edge as the rotation discards that shear along the whole v edge,
  // magnifying error on tall flick streaks. Fit both edges in screen pixels
  // and keep the rectangle with the smallest UV-corner error.
  const units = unitsPerPixel(width / 4);
  const plane = NATIVE_EFFECT_PLANES[sample.plane]!;
  const alpha = (py: number) => plane.alpha1 - plane.slope * (py + 1) * W_TO_H;
  const screen = (px: number, py: number) => [(px * alpha(py)) / units.x, py / units.y] as const;
  const sx2 = (alpha(y) / units.x) ** 2;
  const sy2 = (1 / units.y) ** 2;
  const xs = sample.corners.map((corner) => corner.x);
  const ys = sample.corners.map((corner) => corner.y);
  const candidates: Array<{ r: number; w: number; h: number }> = [
    {
      r: 0,
      w: (Math.max(...xs) - Math.min(...xs)) / 2,
      h: (Math.max(...ys) - Math.min(...ys)) / 2,
    },
  ];
  for (const angle of [0, Math.PI / 2, Math.atan2(uy, ux), Math.atan2(-vx, vy)]) {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    let w = (ux * c * sx2 + uy * s * sy2) / Math.max(1e-12, 2 * (c * c * sx2 + s * s * sy2));
    let h = (-vx * s * sx2 + vy * c * sy2) / Math.max(1e-12, 2 * (s * s * sx2 + c * c * sy2));
    let r = angle;
    // Keep the v edge positive; negative width retains UV reflection.
    if (h < 0) {
      r += Math.PI;
      w = -w;
      h = -h;
    }
    candidates.push({ r, w, h });
  }
  const error = (candidate: (typeof candidates)[number]) => {
    const c = Math.cos(candidate.r);
    const s = Math.sin(candidate.r);
    return (
      [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
      ] as const
    ).reduce((total, [u, v], index) => {
      const actual = sample.corners[index]!;
      const a = screen(actual.x, actual.y);
      const b = screen(x + u * candidate.w * c - v * candidate.h * s, y + u * candidate.w * s + v * candidate.h * c);
      return total + (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;
    }, 0);
  };
  let best = candidates[0]!;
  let bestError = error(best);
  for (const candidate of candidates.slice(1)) {
    const candidateError = error(candidate);
    if (candidateError < bestError) {
      best = candidate;
      bestError = candidateError;
    }
  }
  let { r } = best;
  const { w, h } = best;
  if (previousR !== undefined) while (r - previousR > Math.PI) r -= 2 * Math.PI;
  if (previousR !== undefined) while (previousR - r > Math.PI) r += 2 * Math.PI;
  // A cropped tile's centre moves along the sprite's own u/v edges.
  return {
    x: x + offset[0] * ux + offset[1] * vx,
    y: y + offset[0] * uy + offset[1] * vy,
    w: w * expand[0],
    h: h * expand[1],
    r,
  };
}

const intensity = (emission: readonly number[]): number => Math.max(emission[0]!, emission[1]!, emission[2]!);

/** Tile class: texture, uv rect, emission chroma and baked bloom mips. */
export function tileClass(sample: QuadSample, mips: number, mipFrom = 0): string {
  const peak = Math.max(intensity(sample.emission), 1e-9);
  // Halos keep their HDR chroma too: the clip toward white happens before any tint.
  const chroma = sample.emission
    .map((value) => Math.round((value / peak) * (mipFrom ? 4 : 8)) / (mipFrom ? 4 : 8))
    .join(",");
  const material = sample.materialTint ? `|t${sample.materialTint.join(",")}` : "";
  return `${sample.file}|${sample.uv.map((value) => value.toFixed(4)).join(",")}|${chroma}|${mips}${mipFrom ? `h${mipFrom}` : ""}${material}`;
}

interface TileAccumulator {
  texture: TextureKey;
  mips: number;
  mipFrom: number;
  sigmaScale: number;
  uv: QuadSample["uv"];
  emission: [number, number, number];
  heights: number[];
  aspects: number[];
}

const billboardTextures = new Set<TextureKey>(["star", "longStar", "centerPillar", "centerPillar02", "circleIcon"]);

class TileRegistry {
  /** Screen px per effect-camera px of the profile being traced. */
  sigmaScale = 1;
  separateBillboardSystems = false;
  coreBloomPadding: number | undefined;
  emissionKey = false;
  whitenSourceCore = false;
  readonly accumulators = new Map<string, TileAccumulator>();
  readonly tiles = new Map<string, Tile>();

  private readonly files = new Map<string, string>();
  private frozen = false;

  observe(sample: QuadSample, mips: number, mipFrom = 0): string {
    const system = this.separateBillboardSystems && "systemName" in sample ? `|ps${String(sample.systemName)}` : "";
    const energy = this.emissionKey ? `|e${sample.emission.join(",")}` : "";
    const key = `${tileClass(sample, mips, mipFrom)}|s${this.sigmaScale.toFixed(2)}${system}${energy}`;
    let acc = this.accumulators.get(key);
    if (this.frozen) {
      if (!acc) throw new Error(`Re-traced particle tile was not observed in pass 1: ${key}`);
      return key;
    }
    if (!acc) {
      acc = {
        texture: sample.texture,
        mips,
        mipFrom,
        sigmaScale: this.sigmaScale,
        uv: sample.uv,
        emission: [0, 0, 0],
        heights: [],
        aspects: [],
      };
      this.files.set(key, sample.file);
      this.accumulators.set(key, acc);
    }
    if (intensity(sample.emission) > intensity(acc.emission)) {
      const peak = intensity(sample.emission);
      void peak;
      acc.emission = [...sample.emission] as [number, number, number];
    }
    if (sample.pixelHeight > 0.5 && sample.pixelWidth > 0.05) {
      acc.heights.push(sample.pixelHeight);
      acc.aspects.push(sample.pixelWidth / sample.pixelHeight);
    }
    return key;
  }

  bake(): void {
    // Sprites are baked for their large instances (90th percentile): small
    // ones downsample cleanly, big bright stars must not be upscaled blobs.
    const percentile = (values: number[], fallback: number, p: number) => {
      if (!values.length) return fallback;
      const sorted = values.slice().sort((a, b) => a - b);
      return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!;
    };
    for (const [key, acc] of this.accumulators) {
      const sourceCore = this.separateBillboardSystems && key.includes("|ps") && acc.mips === 0;
      const image = sourceCore ? decodeRgba8Png(readFileSync(this.files.get(key)!), this.files.get(key)!) : undefined;
      const rawHeight = image ? (acc.uv[3] - acc.uv[1]) * image.height : 0;
      const rawWidth = image ? (acc.uv[2] - acc.uv[0]) * image.width : 0;
      const billboard = acc.mipFrom === 0 && billboardTextures.has(acc.texture);
      const tile = bakeTile({
          key,
          file: this.files.get(key)!,
          uv: acc.uv,
          emission: acc.emission,
          screenHeight: sourceCore ? rawHeight : percentile(acc.heights, 24, 0.9),
          screenAspect: sourceCore
            ? rawWidth / rawHeight
            : Math.max(0.05, Math.min(20, percentile(acc.aspects, 1, 0.5))),
          sigmaScale: acc.sigmaScale,
          // 9-slice frame borders: margin on the frame's outer edges only.
          ...(acc.texture === "frame"
            ? {
                padSides: [acc.uv[0] <= 1e-6, acc.uv[2] >= 1 - 1e-6, acc.uv[1] <= 1e-6, acc.uv[3] >= 1 - 1e-6] as const,
              }
            : {}),
          ...(sourceCore || acc.texture === "wall" ? { maxDensity: 1 } : {}),
          ...(this.coreBloomPadding !== undefined && billboard
            ? { maxBloomPadding: this.coreBloomPadding } : {}),
          mips: acc.mips,
          mipFrom: acc.mipFrom,
          bloomGain: BLOOM_GAIN,
          whitenCore:
            (!sourceCore || this.whitenSourceCore) &&
            acc.mips === 0 &&
            !["laneEffect", "frame", "wall", "pillar"].includes(acc.texture),
        });
      this.tiles.set(key, tile);
      // The baked tile only needs its reference emission during fitting.
      acc.heights.length = 0;
      acc.aspects.length = 0;
    }
    this.frozen = true;
  }

  chromaHex(key: string): string {
    const acc = this.accumulators.get(key)!;
    const peak = Math.max(intensity(acc.emission), 1e-9);
    return hexColor(acc.emission.map((value) => value / peak));
  }

  relative(key: string, sample: QuadSample): number {
    const acc = this.accumulators.get(key)!;
    return intensity(sample.emission) / Math.max(intensity(acc.emission), 1e-9);
  }
}

const hexColor = (rgb: readonly number[]): string =>
  `#${rgb
    .map((value) =>
      Math.round(Math.max(0, Math.min(1, value)) * 255)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;

/** Emission-weighted chroma of a run, as a Sonolus particle color. */
const meanChroma = (samples: readonly QuadSample[]): string => {
  const total = [0, 0, 0];
  for (const sample of samples) for (let c = 0; c < 3; c += 1) total[c]! += sample.emission[c]!;
  const peak = Math.max(...total, 1e-9);
  return hexColor(total.map((value) => value / peak));
};

const round = (value: number, digits = 4): number => Math.round(value * 10 ** digits) / 10 ** digits;

/** Random-draw terms below a sub-pixel effect (units ~ 1/190 px at W4) are dropped. */
const TERM_EPSILON = 0.002;
const pruned = (expression: readonly number[]): number[] =>
  expression.map((value, index) => (index > 0 && Math.abs(value) < TERM_EPSILON ? 0 : value));

function channelJson(fit: ChannelFit, alpha = false): Json {
  const serialize = (expression: readonly number[]) => {
    const values = pruned(expression);
    if (!alpha) return expressionJson(values, 3);
    // Nearest rounding can push a bounded alpha just outside [0, 1]. Keep
    // random terms on the same decimal grid by rounding toward zero, then
    // clamp the constant within the remaining feasible interval.
    const scale = 1000;
    const quantized = values.map((value, index) =>
      index === 0 ? Math.round(value * scale) : Math.trunc(value * scale),
    );
    const minimum = quantized.slice(1).reduce((sum, value) => sum + Math.min(0, value), 0);
    const maximum = quantized.slice(1).reduce((sum, value) => sum + Math.max(0, value), 0);
    if (maximum - minimum > scale) throw new Error("Alpha fit exceeds the unit random interval");
    quantized[0] = Math.max(-minimum, Math.min(scale - maximum, quantized[0]!));
    return expressionJson(
      quantized.map((value) => value / scale),
      3,
    );
  };
  const from = serialize(fit.from);
  const to = serialize(fit.to);
  if (fit.ease === "linear" && JSON.stringify(from) === JSON.stringify(to)) return { from, to: from };
  return { from, to, ease: fit.ease };
}

const CHANNELS = ["x", "y", "w", "h", "r", "a"] as const;
type Channel = (typeof CHANNELS)[number];

interface ChannelObservations {
  x: Observation[];
  y: Observation[];
  w: Observation[];
  h: Observation[];
  r: Observation[];
  a: Observation[];
}

const emptyObservations = (): ChannelObservations => ({ x: [], y: [], w: [], h: [], r: [], a: [] });

/** Random draws that explain a channel's per-instance variance (residual after the time mean). */
function screenFeatures(observations: readonly Observation[], candidates: readonly number[]): number[] {
  if (!candidates.length || observations.length < 8) return [];
  const bins = new Map<number, { sum: number; count: number }>();
  for (const observation of observations) {
    const bin = Math.round(observation.q * 20);
    const entry = bins.get(bin) ?? { sum: 0, count: 0 };
    entry.sum += observation.v;
    entry.count += 1;
    bins.set(bin, entry);
  }
  const residual = observations.map((observation) => {
    const entry = bins.get(Math.round(observation.q * 20))!;
    return observation.v - entry.sum / entry.count;
  });
  const variance = residual.reduce((sum, value) => sum + value * value, 0) / residual.length;
  if (variance < 1e-8) return [];
  const scores = candidates.map((feature) => {
    let sxy = 0;
    let sxx = 0;
    observations.forEach((observation, index) => {
      const x = randomFeature(observation.r, feature) - (feature < 8 ? 0.5 : 0);
      sxy += x * residual[index]!;
      sxx += x * x;
    });
    return { feature, score: (sxy * sxy) / Math.max(sxx, 1e-12) / (variance * residual.length) };
  });
  return scores
    .filter((entry) => entry.score > 0.02)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_FEATURES)
    .map((entry) => entry.feature);
}

function fitPieces(
  build: (q0: number, q1: number) => ChannelObservations,
  random: boolean,
  maxPieces: number,
  circleSpeedRandom?: boolean,
  positionBounds?: { x: readonly [number, number]; y: readonly [number, number] },
  anchored = false,
  anchors: readonly number[] = [],
  pixelUnits?: { x: number; y: number; tolerance: number },
  intervals?: readonly { q0: number; q1: number }[],
): Array<{ q0: number; q1: number; fits: Record<Channel, ChannelFit> }> {
  const fitRange = (q0: number, q1: number, positionsOnly = false, eases?: Record<Channel, readonly EaseName[]>) => {
    const observations = build(q0, q1);
    const fits = {} as Record<Channel, ChannelFit>;
    let worst = 0;
    for (const channel of CHANNELS) {
      if (positionsOnly && channel !== "x" && channel !== "y") continue;
      const list = observations[channel];
      if (!list.length) {
        fits[channel] = {
          from: [0, 0, 0, 0, 0, 0, 0, 0, 0],
          to: [0, 0, 0, 0, 0, 0, 0, 0, 0],
          ease: "linear",
          rms: 0,
          max: 0,
        };
        continue;
      }
      const circlePosition = circleSpeedRandom !== undefined && (channel === "x" || channel === "y");
      const channelFeatures = circlePosition
        ? [
            8,
            16,
            ...(circleSpeedRandom ? [7] : []),
            ...screenFeatures(list, [1, 3, 5]).slice(0, circleSpeedRandom ? 1 : 2),
          ]
        : random
          ? screenFeatures(list, CHANNEL_DRAWS[channel])
          : [];
      let fit: ChannelFit;
      if (channel === "w" || channel === "h") {
        // Sizes keep one sign per trajectory (negative width = mirrored);
        // fit the magnitude so the random terms can never flip or explode it.
        const sign = list.reduce((sum, observation) => sum + observation.v, 0) < 0 ? -1 : 1;
        const magnitude = list.map((observation) => ({ ...observation, v: Math.abs(observation.v) }));
        const ceiling = Math.max(...magnitude.map((observation) => observation.v));
        fit = capToCeiling(
          raiseToFloor(
            anchored
              ? fitAnchoredChannel(magnitude, eases?.[channel])
              : fitChannel(magnitude, channelFeatures, random ? COHORT_EASES : undefined),
            0,
          ),
          ceiling,
        );
        if (sign < 0) fit = { ...fit, from: fit.from.map((value) => -value), to: fit.to.map((value) => -value) };
      } else {
        fit = anchored
          ? fitAnchoredChannel(list, eases?.[channel])
          : fitChannel(list, channelFeatures, random ? COHORT_EASES : undefined);
        if (channel === "a") fit = capToCeiling(raiseToFloor(fit, 0), 1);
        if (circlePosition) {
          // Sparse seed cells can solve an underdetermined circle with huge
          // coefficients. Its sampled physical extent bounds unseen draws.
          const bounds = positionBounds?.[channel as "x" | "y"];
          const lo = bounds?.[0] ?? Math.min(...list.map((o) => o.v));
          const hi = bounds?.[1] ?? Math.max(...list.map((o) => o.v));
          const padding = Math.max(POSITION_TOLERANCE, (hi - lo) * 0.05);
          fit = capToBounds(fit, lo - padding, hi + padding);
          let squared = 0,
            total = 0,
            maximum = 0;
          for (const observation of list) {
            const t = ease(fit.ease, observation.q);
            const from = expressionValue(fit.from, observation.r),
              to = expressionValue(fit.to, observation.r);
            const error = Math.abs(from + (to - from) * t - observation.v);
            const weight = observation.w ?? 1;
            squared += weight * error * error;
            total += weight;
            maximum = Math.max(maximum, error);
          }
          fit = { ...fit, rms: Math.sqrt(squared / Math.max(total, 1e-12)), max: maximum };
        }
      }
      fits[channel] = fit;
      const tolerance =
        channel === "a"
          ? ALPHA_TOLERANCE
          : channel === "r"
            ? 0.08
            : channel === "w" || channel === "h"
              ? Math.max(1e-5, Math.max(...list.map((observation) => Math.abs(observation.v))) * 0.08)
              : POSITION_TOLERANCE;
      worst = Math.max(worst, fit.rms / tolerance);
    }
    let pixelWorst = 0;
    if (pixelUnits)
      for (const channel of CHANNELS) {
        const fit = fits[channel],
          list = observations[channel];
        const radius = Math.max(
          ...observations.w.map((o) => Math.abs(o.v) / pixelUnits.x),
          ...observations.h.map((o) => Math.abs(o.v) / pixelUnits.y),
          1,
        );
        for (const observation of list) {
          if ((channel === "x" || channel === "y" || channel === "r") && observation.w === 0) continue;
          const value =
            expressionValue(fit.from, observation.r) +
            (expressionValue(fit.to, observation.r) - expressionValue(fit.from, observation.r)) *
              ease(fit.ease, observation.q);
          const scale =
            channel === "x" || channel === "w"
              ? 1 / pixelUnits.x
              : channel === "y" || channel === "h"
                ? 1 / pixelUnits.y
                : channel === "r"
                  ? radius
                  : pixelUnits.tolerance / ALPHA_TOLERANCE;
          pixelWorst = Math.max(pixelWorst, Math.abs(value - observation.v) * scale);
        }
      }
    return { fits, worst, pixelWorst };
  };
  if (circleSpeedRandom !== undefined) {
    // Position fitting keeps the existing timing/alpha/size pieces. Changing
    // the spatial error must not restart, shorten or multiply an emission.
    return fitPieces(build, random, maxPieces, undefined, undefined, false, [], undefined, intervals).map((piece) => ({
      ...piece,
      fits: { ...piece.fits, ...fitRange(piece.q0, piece.q1, true).fits },
    }));
  }
  if (intervals) return intervals.map(({ q0, q1 }) => ({ q0, q1, ...fitRange(q0, q1) }));
  // Greedy bisection of the worst piece until every channel is within tolerance.
  const cuts = [0, ...anchors.filter((q) => q > 1e-8 && q < 1 - 1e-8), 1]
    .sort((a, b) => a - b)
    .filter((q, index, values) => !index || q - values[index - 1]! > 1e-8);
  const pieces = cuts.slice(1).map((q1, index) => ({ q0: cuts[index]!, q1, ...fitRange(cuts[index]!, q1) }));
  const limit = anchors.length ? pieces.length + Math.max(0, maxPieces - 1) : maxPieces;
  while (pieces.length < limit) {
    const worstIndex = pieces.reduce((best, piece, index) => (piece.worst > pieces[best]!.worst ? index : best), 0);
    const worst = pieces[worstIndex]!;
    if (worst.worst <= 1 || worst.q1 - worst.q0 < (anchored ? 1e-6 : 0.02)) break;
    // Split where the alpha observations change fastest (fade-in/out edges).
    const mid = (worst.q0 + worst.q1) / 2;
    const left = { q0: worst.q0, q1: mid, ...fitRange(worst.q0, mid) };
    const right = { q0: mid, q1: worst.q1, ...fitRange(mid, worst.q1) };
    pieces.splice(worstIndex, 1, left, right);
  }
  if (pixelUnits && pieces.length > 1) {
    const mergeAt = (index: number) => {
      const left = pieces[index]!,
        right = pieces[index + 1]!;
      const eases = Object.fromEntries(
        CHANNELS.map((channel) => [
          channel,
          [...new Set<EaseName>(["linear", left.fits[channel].ease, right.fits[channel].ease])],
        ]),
      ) as Record<Channel, EaseName[]>;
      return { q0: left.q0, q1: right.q1, ...fitRange(left.q0, right.q1, false, eases) };
    };
    const candidates = pieces.slice(1).map((_, index) => mergeAt(index));
    while (candidates.length) {
      const index = candidates.reduce(
        (best, candidate, index) => (candidate.pixelWorst < candidates[best]!.pixelWorst ? index : best),
        0,
      );
      const merged = candidates[index]!;
      if (merged.pixelWorst > pixelUnits.tolerance) break;
      pieces.splice(index, 2, merged);
      candidates.splice(index, 1);
      if (index > 0) candidates[index - 1] = mergeAt(index - 1);
      if (index < pieces.length - 1) candidates[index] = mergeAt(index);
    }
  }
  return pieces.map(({ q0, q1, fits }) => ({ q0, q1, fits }));
}

function particleDefs(
  sprite: number,
  start: number,
  duration: number,
  pieces: ReturnType<typeof fitPieces>,
  color = "#ffffff",
  timingDigits = 4,
): Json[] {
  return pieces
    .map((piece) => ({
      sprite,
      color,
      start: round(start + piece.q0 * duration, timingDigits),
      duration: round((piece.q1 - piece.q0) * duration, timingDigits),
      x: channelJson(piece.fits.x),
      y: channelJson(piece.fits.y),
      w: channelJson(piece.fits.w),
      h: channelJson(piece.fits.h),
      r: channelJson(piece.fits.r),
      a: channelJson(piece.fits.a, true),
    }))
    .filter((particle) =>
      [particle.a, particle.w, particle.h].every((channel) =>
        [
          ...Object.values(channel.from as Record<string, number>),
          ...Object.values(channel.to as Record<string, number>),
        ].some((value) => value !== 0),
      ),
    );
}

/** Particle cores keep the original sharp texels; extra glow is opt-in. */
const STAR_GLOW = process.env.SONOLUS_STAR_GLOW === "1";

/** Family (frame, wall, pillarNN) of a traced mesh trajectory. */
const familyOf = new WeakMap<readonly QuadSample[], string>();

function significantMeshes(
  meshes: ReadonlyMap<string, readonly QuadSample[]>,
  select: (list: readonly QuadSample[]) => readonly QuadSample[],
): Array<readonly QuadSample[]> {
  const energy = (list: readonly QuadSample[]) =>
    Math.max(0, ...list.map((sample) => intensity(sample.emission) * sample.pixelArea));
  const familyPeak = new Map<string, number>();
  for (const [key, list] of meshes) {
    const family = key.split("#")[0]!;
    familyPeak.set(family, Math.max(familyPeak.get(family) ?? 0, energy(list)));
  }
  return [...meshes.entries()]
    .filter(([key]) => key.split("#")[0] !== "wall")
    .filter(([key, list]) => energy(list) >= 0.005 * (familyPeak.get(key.split("#")[0]!) ?? 0))
    .map(([key, list]) => {
      const trimmed = select(list);
      familyOf.set(trimmed, key.split("#")[0]!);
      return trimmed;
    });
}

/** Split one deterministic trajectory into runs of one tile class. */
function runsOf(
  samples: readonly QuadSample[],
  registry: TileRegistry,
  mips: number,
  mipFrom = 0,
): Array<{ key: string; samples: QuadSample[] }> {
  const runs: Array<{ key: string; samples: QuadSample[] }> = [];
  for (const sample of samples) {
    if (intensity(sample.emission) <= 1e-6) {
      runs.push({ key: "", samples: [] });
      continue;
    }
    const key = registry.observe(sample, mips, mipFrom);
    const last = runs[runs.length - 1];
    if (last && last.key === key) last.samples.push(sample);
    else runs.push({ key, samples: [sample] });
  }
  return runs.filter((run) => run.key && run.samples.length >= 1);
}

interface PendingGroup {
  /** Plane layer (NATIVE_EFFECT_PLANES index). */
  plane: number;
  build(sprites: ReadonlyMap<string, number>): Json | undefined;
}

/** SONOLUS_PARTICLE_DEBUG=1 tags groups with their tile class (probe output only). */
const debugTag = (key: string): Json => (process.env.SONOLUS_PARTICLE_DEBUG ? { debug: key.split("/").pop() } : {});

const GLOW_KEY = "glow";
/**
 * Keep bounded near bloom on the wall/frame. Pillars retain their sharp core;
 * far-bloom sprites otherwise multiply translucent overdraw on every hit.
 */
const SLICED_FAMILIES = new Set(["wall", "frame"]);
/** Screen px beyond the padding that stay unstretched at each end (side faces, 9-slice borders). */
const SLICE_END_MARGIN = 48;

const COMPOSITE_LAYERS = [
  // Accumulate wall radiance and bloom before the LDR composite. Separate
  // full-wall sprites double fill cost and darken each other with alpha blend.
  { label: "wall", mipFrom: 0, mipTo: 3, density: 1 / 3, families: "wall", core: true },
  { label: "near", mipFrom: 1, mipTo: 3, density: 1 / 4, families: "frame" },
] as const;
/** Screen cell (1080p px) of the far-bloom grid; the default gives one glow per effect. */
const GLOW_CELL = Number(process.env.SONOLUS_PARTICLE_GLOW_CELL ?? "100000");
const GLOW_VISIBILITY = 0.05;
const HALO_KEY = "halo";

export interface CompileResult {
  effects: Json[];
  atlas: ReturnType<typeof packAtlas>;
  report: Array<{ name: string; groups: number; instances: number; defs: number; lifetime: number }>;
  sourceBudgets: Array<{ name: string; width: number; loop: boolean; families: SourceParticleBudgetReport[] }>;
  tileMappings?: Array<{
    sprite: number;
    key: string;
    expand: readonly [number, number];
    offset: readonly [number, number];
  }>;
}

interface SourceParticleSlot {
  system: number;
  seeds: Map<number, ParticleSample[]>;
  birth: number;
}

type SourceParticleSelection = ReturnType<typeof sampleSourceParticleSlots<SourceParticleSlot>>;

const particleSlots = (particles: readonly ParticleSample[], spec: EffectSpec, warm: number): SourceParticleSlot[] => {
  const bySlot = new Map<string, Map<number, ParticleSample[]>>();
  for (const sample of particles) {
    if (intensity(sample.emission) <= 1e-6) continue;
    const cycle = spec.loop ? Math.round(sample.birth * 1e5) : 0;
    const key = `${sample.system}:${sample.emission_}:${cycle}`;
    let seeds = bySlot.get(key);
    if (!seeds) bySlot.set(key, (seeds = new Map()));
    let list = seeds.get(sample.seed);
    if (!list) seeds.set(sample.seed, (list = []));
    list.push(sample);
  }
  return [...bySlot.entries()]
    .map(([key, seeds]) => {
      const births = [...seeds.values()].map((list) => list[0]!.birth);
      return { system: Number(key.split(":")[0]), seeds, birth: births.reduce((a, b) => a + b, 0) / births.length };
    })
    .filter((slot) => !spec.loop || (slot.birth >= warm - 1e-9 && slot.birth < warm + spec.loop.period));
};

const sourceSlotMembers = (slots: readonly SourceParticleSlot[]): ParticleSample[][] => {
  const systems = new Map<number, SourceParticleSlot[]>();
  for (const slot of slots) {
    const list = systems.get(slot.system) ?? [];
    list.push(slot);
    systems.set(slot.system, list);
  }
  return [...systems.values()].flatMap((slots) =>
    slots
      .sort((a, b) => a.birth - b.birth)
      .map(
        (slot, index) => slot.seeds.get(SEEDS[(index + slot.system) % SEEDS.length]!) ?? [...slot.seeds.values()][0]!,
      ),
  );
};

const sourceSampleIdentity = (sample: Pick<ParticleSample, "seed" | "system" | "emission_" | "sourceClock">): string =>
  `${sample.seed}:${sample.system}:${sample.emission_}:${Math.round((sample.sourceClock?.realTimeOffset ?? 0) * 1e5)}`;

export async function compileNativeParticles(options: {
  releaseRoot: string;
  /** Bake real sampled trajectories instead of extrapolating random cohorts. */
  particleMotion?: "random-fit" | "source-trajectories";
  /** Offline adapter budget; this does not change authored emission. */
  particleBudgetScale?: number;
  /** Preserve all formally authored births for complete offline emitter generation. */
  preserveSourceParticleCount?: boolean;
  particleSampleRate?: number;
  particlePieces?: number;
  /** Merge fixed native intervals using projected visibility and energy. */
  particleCompression?: boolean;
  /** Component-resource generation; does not alter the Source emitter. */
  particleFamilies?: readonly ("point" | "star" | "other")[];
  billboardsOnly?: boolean;
  billboardSystemTiles?: boolean;
  /** Core and bounded near bloom share the particle's existing quad. */
  particleCoreMips?: number | ((effectName: string, width: number) => number);
  particleCoreMaxBloomPadding?: number;
  particleCoreBloomDownsample?: number;
  particleEmissionKey?: boolean;
  /** Offline LDRstar carrier generation; preserveexistingSourcecore/pointdefaults. */
  particleWhitenSourceCore?: boolean;
  particleAlpha?: "tile-response" | "source-peak" | "constant";
  particleRequireBrackets?: boolean;
  /** Source samples held for one effect-camera frame; no runtime callback. */
  particleFrameHold?: boolean;
  particleFrameLod?: { pixelWidth: number; minFlux: number };
  /** Offline delta keeps an admitted group's serial clock and definition budget. */
  particleIntervals?: ReadonlyMap<string, readonly { start: number; duration: number }[]>;
  /** Frozen Source-visible representative identities for an externally budgeted family delta. */
  particleRepresentatives?: ReadonlyMap<string, readonly { system: number; emission: number; seed: number }[]>;
  particleColourKeys?: boolean;
  particleCoreColour?: boolean;
  /** Offline component delta; emitted particle cohorts remain in their baseline. */
  meshesOnly?: boolean;
  /** Keep nonlinear HDR halo references distinct when their emitted energy differs. */
  meshHaloEnergyKey?: boolean;
  meshCoreMips?: number;
  meshPerspectiveUv?: boolean;
  meshFrameComposite?: boolean;
  profiles?: ReadonlyArray<{
    prefix: string;
    quality: number;
    noteEffectSkin?: "effect001" | "effect001Simple";
  }>;
  log?: (line: string) => void;
  /** Diagnostics: only trace effects whose name passes. */
  only?: (name: string) => boolean;
}): Promise<CompileResult> {
  const log = options.log ?? (() => {});
  const sourceTrajectories =
    !options.meshesOnly && (options.particleMotion === "source-trajectories" || options.particleFrameHold === true);
  const budgetScale = options.particleBudgetScale ?? 1;
  const sampleStep = 1 / (options.particleSampleRate ?? 60);
  const sourcePieces = options.particlePieces ?? 6;
  const particleCoreMips = options.particleCoreMips ?? 0;
  if (!(budgetScale > 0 && Number.isFinite(budgetScale))) throw new Error("Invalid particle budget scale");
  if (!(sampleStep > 0 && Number.isFinite(sampleStep)) || !Number.isInteger(sourcePieces) || sourcePieces < 1)
    throw new Error("Invalid particle trajectory resolution");
  if (typeof particleCoreMips === "number" &&
    (!Number.isInteger(particleCoreMips) || particleCoreMips < 0 || particleCoreMips > BLOOM_SIGMAS.length))
    throw new Error("Invalid particle core bloom range");
  const profiles = options.profiles ?? NATIVE_EFFECT_PROFILES;
  const tracers = await Promise.all(
    profiles.map(async (profile) => {
      const tracer = new EffectTracer({
        releaseRoot: options.releaseRoot,
        currentQuality: profile.quality,
        ...(profile.noteEffectSkin ? { noteEffectSkin: profile.noteEffectSkin } : {}),
      });
      await tracer.load();
      return { profile, tracer };
    }),
  );
  let tracer = tracers[0]!.tracer;
  const registry = new TileRegistry();
  registry.emissionKey = options.particleEmissionKey ?? false;
  registry.whitenSourceCore = options.particleWhitenSourceCore ?? false;
  registry.separateBillboardSystems = options.billboardSystemTiles ?? false;
  registry.coreBloomPadding = options.particleCoreMaxBloomPadding;
  const compositeHalos = new Map<string, ReturnType<typeof bakeCompositeHalo>>();
  /** Cut a baked composite into its left end, one-column middle and right end. */
  const slicedComposites = new Map<string, Tile>();
  const sliceTiles = (key: string, baked: ReturnType<typeof bakeCompositeHalo>, endWidth: number): void => {
    if (slicedComposites.has(`${key}|L`)) return;
    const { width, height, pixels } = baked.tile.image;
    const endColumns = Math.max(
      1,
      Math.min(Math.floor(width / 2) - 1, Math.round((endWidth / (baked.rect.x1 - baked.rect.x0)) * width)),
    );
    const cut = (from: number, to: number, suffix: string) => {
      const columns = to - from;
      const out = new Uint8Array(columns * height * 4);
      for (let y = 0; y < height; y += 1)
        out.set(pixels.subarray((y * width + from) * 4, (y * width + to) * 4), y * columns * 4);
      slicedComposites.set(`${key}|${suffix}`, {
        ...baked.tile,
        key: `${key}|${suffix}`,
        image: { width: columns, height, pixels: out },
      });
    };
    cut(0, endColumns, "L");
    const middle = Math.floor(width / 2);
    cut(middle, middle + 1, "M");
    cut(width - endColumns, width, "R");
  };
  /** Particle glow kernels by profile bloom scale. */
  const glowKernels = new Map<string, BloomKernel>();
  const glowKernelFor = (scale: number): { key: string; kernel: BloomKernel } => {
    const key = `${GLOW_KEY}|${scale.toFixed(2)}`;
    let kernel = glowKernels.get(key);
    if (!kernel) glowKernels.set(key, (kernel = bloomKernel(STAR_HALOS ? STAR_HALO_MIPS : 1, 5, scale)));
    return { key, kernel };
  };
  // Keep only sampling descriptors across the atlas pass. PendingGroup
  // closures retain raw histories, which exceed the bounded heap for a full
  // pack. Re-tracing one effect at a time preserves global tile statistics.
  const pending: Array<{
    name: string;
    spec: EffectSpec;
    width: number;
    tracer: EffectTracer;
    bloomScale: number;
    lightBudget: boolean;
  }> = [];
  let bloomScale = 1;
  let lightBudget = false;
  const sourceBudgets = new Map<string, CompileResult["sourceBudgets"][number]>();
  const laneWarps = new Map<string, CompiledLaneWarp>();
  for (const entry of tracers) {
    tracer = entry.tracer;
    bloomScale = 1 / (EFFECT_RENDERING_SCALE[entry.profile.quality] ?? 1);
    registry.sigmaScale = bloomScale;
    lightBudget = entry.profile.quality === 2;
    await traceProfile(entry.profile.prefix);
  }
  if (process.env.SONOLUS_PARTICLE_TILE_REPORT) {
    const counts = new Map<string, number>();
    for (const key of registry.accumulators.keys()) {
      const name = key.split("|")[0]!.split("/").pop()!;
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    log(`tile classes ${JSON.stringify(Object.fromEntries(counts))}`);
  }
  registry.bake();
  const tiles = [
    ...registry.tiles.values(),
    ...[...compositeHalos.values()]
      .filter((entry) => !slicedComposites.has(`${entry.tile.key}|L`))
      .map((entry) => entry.tile),
    ...slicedComposites.values(),
    ...[...glowKernels.entries()].map(([key, kernel]) => bakeKernelTile(key, kernel)),
    bakeKernelTile(HALO_KEY, HALO_KERNEL),
  ];
  const atlas = packAtlas(tiles);
  log(`baked ${tiles.length} tiles into ${atlas.width}x${atlas.height}`);
  // Pass 2: fit with the baked tile expansion/response.
  const effects: Json[] = [];
  const report: CompileResult["report"] = [];
  const identity = Object.fromEntries(
    ["x1", "y1", "x2", "y2", "x3", "y3", "x4", "y4"].map((key) => [key, { [key]: 1 }]),
  );
  for (const entry of pending) {
    tracer = entry.tracer;
    bloomScale = entry.bloomScale;
    registry.sigmaScale = bloomScale;
    lightBudget = entry.lightBudget;
    const pendingGroups = traceGroups(entry.spec, entry.width);
    // Lane effects keep one layer; hits and the hold loop get every plane.
    const layered = !entry.spec.lane;
    const layers = layered ? NATIVE_EFFECT_PLANES.length : 1;
    for (let plane = 0; plane < layers; plane += 1) {
      const groups = pendingGroups
        .filter((group) => !layered || group.plane === plane)
        .map((group) => group.build(atlas.index))
        .filter((group): group is Json => !!group && (group.particles as Json[]).length > 0);
      if (entry.spec.loop) {
        for (const group of groups) {
          for (const particle of group.particles as Json[]) {
            // Tail pieces sampled in the next cycle share their cohort's
            // random draws, and must start within Sonolus' [0, 1] interval.
            particle.start = round((particle.start as number) % 1, sourceTrajectories ? 6 : 4);
            if ((particle.duration as number) > 1)
              throw new Error(`Particle tail exceeds the authored loop period: ${entry.name}`);
          }
        }
      }
      const name = layered ? `${entry.name} ${NATIVE_EFFECT_PLANES[plane]!.label}` : entry.name;
      effects.push({ name, transform: identity, groups });
      report.push({
        name,
        groups: groups.length,
        instances: groups.reduce((total, group) => total + (group.count as number), 0),
        defs: groups.reduce((total, group) => total + (group.particles as unknown[]).length, 0),
        lifetime: entry.spec.lifetime,
      });
    }
    log(`fitted ${entry.name}: ${pendingGroups.length} groups`);
  }
  // Fitted alpha can round to zero; only live definitions need atlas space.
  const used = new Set(
    effects.flatMap((effect) =>
      (effect.groups as Json[]).flatMap((group) =>
        (group.particles as Json[]).map((particle) => particle.sprite as number),
      ),
    ),
  );
  const liveTiles = tiles.filter((tile) => used.has(atlas.index.get(tile.key)!));
  // Fit color and trajectories against full-resolution tiles, then reduce
  // download resolution for near-field bloom without changing its footprint.
  const downsample = options.particleCoreBloomDownsample;
  const liveAtlas = packAtlas(downsample === undefined ? liveTiles : liveTiles.map((tile) => {
    const acc = registry.accumulators.get(tile.key);
    return acc && acc.mipFrom === 0 && acc.mips >= 2 && billboardTextures.has(acc.texture)
      ? downsamplePremultipliedTile(tile, downsample)
      : tile;
  }));
  const remap = new Map(liveTiles.map((tile) => [atlas.index.get(tile.key)!, liveAtlas.index.get(tile.key)!]));
  for (const effect of effects)
    for (const group of effect.groups as Json[])
      for (const particle of group.particles as Json[]) particle.sprite = remap.get(particle.sprite as number)!;
  log(`retained ${liveTiles.length}/${tiles.length} referenced tiles (${liveAtlas.width}x${liveAtlas.height})`);
  return {
    effects,
    atlas: liveAtlas,
    report,
    sourceBudgets: [...sourceBudgets.values()],
    tileMappings: liveTiles.map((tile, sprite) => ({
      sprite,
      key: tile.key,
      expand: tile.expand,
      offset: tile.offset,
    })),
  };

  async function traceProfile(prefix: string): Promise<void> {
    const specs: EffectSpec[] = [];
    for (const kind of NOTE_KINDS) {
      const prefab = tracer.assets.particles.effect001Prefabs[kind.slot]!;
      for (const judgement of JUDGEMENTS) {
        const clip = prefab.animationClipUrls?.[judgement.judgement] ?? prefab.animationClipUrl;
        const lifetime = await tracer.clipDuration(clip);
        if (!(lifetime > 0 && Number.isFinite(lifetime))) throw new Error(`Invalid effect clip duration: ${clip}`);
        specs.push({
          name: `${prefix} ${kind.label}${judgement.suffix}`,
          kind: kind.kind,
          direction: kind.direction,
          judgement: judgement.judgement,
          lifetime,
        });
      }
    }
    const animationPeriod = await tracer.clipDuration(
      tracer.assets.particles.effect001Prefabs.SlideLoop!.animationClipUrl,
    );
    const loopPeriod =
      nativeEffects.timings?.loopParticles?.[nativeEffects.profiles.indexOf(prefix)] ??
      nativeEffects.timings?.loopParticle ??
      2;
    if (
      !(animationPeriod > 0) ||
      Math.abs(loopPeriod / animationPeriod - Math.round(loopPeriod / animationPeriod)) > 1e-5
    )
      throw new Error(`Particle loop ${loopPeriod}s must contain whole Animator cycles (${animationPeriod}s)`);
    specs.push({
      name: `${prefix} Slide Loop`,
      kind: "slide-loop",
      direction: "none",
      judgement: "perfect",
      lifetime: loopPeriod,
      loop: { period: loopPeriod },
    });
    if (prefix === profiles[0]!.prefix)
      for (const kind of LANE_KINDS)
        specs.push({
          name: `Our Notes Lane ${kind.label}`,
          kind: kind.kind,
          direction: "none",
          judgement: "perfect",
          lifetime: 0.45 / 2,
          lane: true,
        });

    // Pass 1: trace everything and register tile classes.
    for (const spec of specs) {
      for (const width of spec.lane ? [1] : NATIVE_EFFECT_WIDTHS) {
        const name = spec.lane ? spec.name : nativeEffectName(spec.name, width);
        if (options.only && !options.only(name)) continue;
        const groups = traceGroups(spec, width);
        pending.push({ name, spec, width, tracer, bloomScale, lightBudget });
        log(`traced ${name}: ${groups.length} groups`);
      }
    }
  }

  function traceGroups(spec: EffectSpec, width: number): PendingGroup[] {
    const warm = spec.loop ? spec.loop.period * 3 : 0;
    const times: number[] = [];
    const span = spec.loop ? spec.loop.period * 2 : spec.lifetime;
    for (let t = 0; t <= span + 1e-9; t += sampleStep) times.push(warm + t);
    const groups: PendingGroup[] = [];
    const progressOf = (t: number) => (t - warm) / spec.lifetime;
    if (spec.lane) {
      let warp = laneWarps.get(spec.name);
      if (!warp) {
        warp = compileSourceLaneWarp(tracer, spec.kind, spec.name);
        laneWarps.set(spec.name, warp);
        for (const tile of warp.tiles) registry.tiles.set(tile.key, tile);
      }
      for (const group of warp.groups)
        groups.push({
          plane: 3,
          build: (sprites) => ({
            count: 1,
            particles: group.particles.map((particle) => ({ ...particle, sprite: sprites.get(group.tile)! })),
          }),
        });
    } else {
      const base = {
        kind: spec.kind,
        direction: spec.direction,
        judgement: spec.judgement,
        lifetime: spec.loop ? undefined : spec.lifetime,
      } as never;
      const seeds = options.meshesOnly || (spec.loop && !sourceTrajectories) ? SEEDS.slice(0, 1) : SEEDS;
      const trace = tracer.trace(base, width, times, seeds, options.meshesOnly ? { particle: () => false } : {});
      if (options.particleFamilies)
        trace.particles = trace.particles.filter((sample) =>
          options.particleFamilies!.includes(sourceParticleFamily(sample)),
        );
      if (options.billboardsOnly) trace.meshes.clear();
      let selection: SourceParticleSelection | undefined;
      if (sourceTrajectories) {
        const allSlots = particleSlots(trace.particles, spec, warm);
        const sampled = sampleSourceParticleSlots(
          allSlots,
          spec.lifetime,
          Boolean(spec.loop),
          lightBudget,
          budgetScale,
          options.preserveSourceParticleCount,
        );
        const representatives = options.particleRepresentatives?.get(`${spec.name} W${width}`);
        if (representatives) {
          if (representatives.length !== sampled.slots.length)
            throw new Error("Representative instance budget changed");
          sampled.slots = representatives.map((identity) => {
            const slot = allSlots.find(
              (slot) =>
                slot.system === identity.system && slot.seeds.get(identity.seed)?.[0]?.emission_ === identity.emission,
            );
            const member = slot?.seeds.get(identity.seed);
            if (!slot || !member?.length) throw new Error("Missing formal Source representative");
            return { ...slot, birth: member[0]!.birth, seeds: new Map([[identity.seed, member]]) };
          });
        }
        const members = sourceSlotMembers(sampled.slots);
        if (options.particleFrameHold) {
          selection = {
            report: sampled.report,
            slots: members.map((member) => ({
              system: member[0]!.system,
              birth: member[0]!.birth,
              seeds: new Map([[member[0]!.seed, member]]),
            })),
          };
          trace.particles = members.flat();
        } else {
          const authoredTimes = new Map<string, readonly number[]>();
          const referenceMembers = new Map(members.map((member) => [sourceSampleIdentity(member[0]!), member]));
          const timesBySeed = new Map<number, readonly number[]>();
          const schedules = new Map<number, Set<number>>(seeds.map((seed) => [seed, new Set(times)]));
          for (const member of members) {
            const first = member[0]!;
            const colourKeys: number[] = [];
            if (options.particleColourKeys) {
              const slot = NOTE_KINDS.find(
                (kind) => kind.kind === spec.kind && kind.direction === spec.direction,
              )?.slot;
              const reference = slot
                ? tracer.assets.particles.effect001Prefabs[slot]?.particleSystems[first.system]
                : undefined;
              if (reference) {
                const colour = JSON.parse(readFileSync(reference.metadataUrl, "utf8")).data.ColorModule;
                if (colour?.enabled)
                  for (const g of [colour.gradient.minGradient, colour.gradient.maxGradient]) {
                    if (!g) continue;
                    for (let i = 0; i < g.m_NumColorKeys; i++) colourKeys.push(g[`ctime${i}`] / 65535);
                    for (let i = 0; i < g.m_NumAlphaKeys; i++) colourKeys.push(g[`atime${i}`] / 65535);
                  }
              }
            }
            const anchors = new Set(
              tracer.particleKeyTimes(first, colourKeys).filter((t) => t >= warm - 1e-9 && t <= warm + span + 1e-9),
            );
            const schedule = schedules.get(first.seed)!;
            const units = unitsPerPixel(width / 4);
            const center = (sample: ParticleSample) => ({
              x: sample.corners.reduce((sum, corner) => sum + corner.x, 0) / (4 * units.x),
              y: sample.corners.reduce((sum, corner) => sum + corner.y, 0) / (4 * units.y),
            });
            for (let index = 1; index < member.length; index++) {
              const left = member[index - 1]!,
                right = member[index]!,
                a = center(left),
                b = center(right);
              if (
                Math.max(
                  Math.hypot(b.x - a.x, b.y - a.y),
                  Math.abs(right.pixelHeight - left.pixelHeight),
                  Math.abs(right.pixelWidth - left.pixelWidth),
                ) <= 12
              )
                continue;
              anchors.add(left.t);
              anchors.add(right.t);
              for (let part = 1; part < 8; part++) schedule.add(left.t + ((right.t - left.t) * part) / 8);
            }
            const keys = [...anchors].sort((a, b) => a - b);
            authoredTimes.set(sourceSampleIdentity(first), keys);
            for (const key of keys) schedule.add(key);
            for (let index = 1; index < keys.length; index++)
              for (const fraction of [0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875])
                schedule.add(keys[index - 1]! + (keys[index]! - keys[index - 1]!) * fraction);
          }
          for (const [seed, schedule] of schedules)
            timesBySeed.set(
              seed,
              [...schedule].sort((a, b) => a - b),
            );
          const refined = tracer.trace(base, width, times, seeds, {
            timesBySeed,
            meshes: false,
            particle: ({ seed, system, emission, offset }) =>
              authoredTimes.has(`${seed}:${system}:${emission}:${Math.round(offset * 1e5)}`),
            position: ({ seed, system, emission, offset }, time) => {
              const member = referenceMembers.get(`${seed}:${system}:${emission}:${Math.round(offset * 1e5)}`)!;
              // A zero-size birth can have no coarse sample. Outside an actual
              // bracket retain the formal renderer position, not the first/last visible sample.
              if (options.particleRequireBrackets && (time < member[0]!.t || time > member[member.length - 1]!.t))
                return undefined;
              const next = member.findIndex((sample) => sample.t >= time);
              const right = next < 0 ? member[member.length - 1]! : member[next]!;
              const left = next <= 0 ? right : member[next - 1]!;
              const blend = right.t > left.t ? Math.max(0, Math.min(1, (time - left.t) / (right.t - left.t))) : 0;
              return Object.fromEntries(
                (["x", "y", "z"] as const).map((key) => [
                  key,
                  left.worldPosition[key] + (right.worldPosition[key] - left.worldPosition[key]) * blend,
                ]),
              ) as { x: number; y: number; z: number };
            },
          });
          const refinedMembers = new Map<string, ParticleSample[]>();
          for (const sample of refined.particles) {
            const identity = sourceSampleIdentity(sample);
            sample.authoredTimes = authoredTimes.get(identity)!;
            const list = refinedMembers.get(identity) ?? [];
            list.push(sample);
            refinedMembers.set(identity, list);
          }
          selection = {
            report: sampled.report,
            slots: members.map((member) => {
              const first = member[0]!,
                samples = refinedMembers.get(sourceSampleIdentity(first));
              if (!samples?.length) throw new Error(`Missing retained source trajectory: ${spec.name}`);
              return { system: first.system, birth: first.birth, seeds: new Map([[first.seed, samples]]) };
            }),
          };
          trace.particles = refined.particles;
        }
      }
      const oneCycle = (list: readonly QuadSample[]) => list.filter((sample) => progressOf(sample.t) <= 1 + 1e-9);
      // Halos first: groups draw in order and the sharp cores go on top.
      groups.push(...compositeHaloGroups(trace.meshes, width, progressOf, spec));
      groups.push(...deterministicGroups(significantMeshes(trace.meshes, oneCycle), registry, progressOf, spec, width));
      // Off by default: measured worse than none (see SWARM_VISIBILITY).
      if (!spec.loop && Number.isFinite(SWARM_VISIBILITY))
        groups.unshift(...swarmBloomGroups(trace.particles, width, progressOf, spec, SEEDS.length));
      groups.push(...cohortGroups(trace.particles, registry, progressOf, spec, warm, width, selection));
      const seedCount = spec.loop ? 1 : SEEDS.length;
      groups.unshift(
        // The authored textured stars supply the shape; a centroid glow adds no detail.
        ...(STAR_GLOW
          ? glowGroups([], trace.particles, width, progressOf, spec, seedCount, glowKernelFor(bloomScale))
          : []),
      );
    }
    return groups;
  }

  function deterministicGroups(
    trajectories: ReadonlyArray<readonly QuadSample[]>,
    tiles: TileRegistry,
    progressOf: (t: number) => number,
    spec: EffectSpec,
    width: number,
  ): PendingGroup[] {
    const groups: PendingGroup[] = [];
    for (const trajectory of trajectories) {
      if (options.meshFrameComposite && trajectory[0]?.texture === "frame") continue;
      const family = trajectory[0] ? familyOf.get(trajectory) : undefined;
      void family;
      const runs = runsOf(trajectory, tiles, spec.lane ? 0 : (options.meshCoreMips ?? RIG_BLOOM_MIPS));
      for (const run of runs) {
        groups.push({
          plane: planeOf(run.samples[Math.floor(run.samples.length / 2)]!),
          build: (sprites) => {
            const tile = tiles.tiles.get(run.key)!;
            const sprite = sprites.get(run.key)!;
            const p0 = progressOf(run.samples[0]!.t);
            const p1 = progressOf(run.samples[run.samples.length - 1]!.t);
            // Sampling lands on Animator activation edges (1/30 s); open the
            // run half a step early and hold the last sample for one step.
            const start = Math.max(0, p0 - sampleStep / 2 / spec.lifetime);
            // Mesh trajectories are selected for one authored cycle. Only
            // emitted particle cohorts carry tails into the following cycle.
            const end = Math.min(1, Math.max(p1, p0) + sampleStep / spec.lifetime);
            const duration = Math.max(1e-4, end - start);
            let previousR: number | undefined;
            const params = run.samples.map((sample) => {
              const quad = quadParams(sample, tile.expand, width, previousR, tile.offset);
              previousR = quad.r;
              return {
                q: (progressOf(sample.t) - start) / duration,
                quad,
                a: responseAt(tile, tiles.relative(run.key, sample)),
              };
            });
            const build = (q0: number, q1: number): ChannelObservations => {
              const observations = emptyObservations();
              const span = Math.max(1e-9, q1 - q0);
              for (const { q, quad, a } of params) {
                if (q < q0 - 1e-9 || q > q1 + 1e-9) continue;
                const local = (q - q0) / span;
                for (const channel of ["x", "y", "w", "h", "r"] as const)
                  observations[channel].push({ q: local, r: [], v: quad[channel] });
                observations.a.push({ q: local, r: [], v: a });
              }
              return observations;
            };
            const pieces = fitPieces(build, false, MAX_MESH_PIECES);
            const halo = run.key.endsWith("h1");
            const chroma = halo ? meanChroma(run.samples) : "#ffffff";
            const particles = particleDefs(sprite, start, duration, pieces, chroma);
            return { count: 1, particles, ...debugTag(run.key) };
          },
        });
      }
    }
    return groups;
  }

  function cohortGroups(
    particles: readonly ParticleSample[],
    tiles: TileRegistry,
    progressOf: (t: number) => number,
    spec: EffectSpec,
    warm: number,
    width: number,
    selection?: SourceParticleSelection,
  ): PendingGroup[] {
    const slots = particleSlots(particles, spec, warm);
    const coreMips = typeof particleCoreMips === "function" ? particleCoreMips(spec.name, width) : particleCoreMips;
    const sampled =
      selection ?? sampleSourceParticleSlots(slots, spec.lifetime, Boolean(spec.loop), lightBudget, budgetScale, options.preserveSourceParticleCount);
    sourceBudgets.set(`${spec.name} W${width}`, {
      name: spec.name,
      width,
      loop: Boolean(spec.loop),
      families: sampled.report,
    });
    const bySystem = new Map<number, typeof slots>();
    for (const slot of sampled.slots) {
      let list = bySystem.get(slot.system);
      if (!list) bySystem.set(slot.system, (list = []));
      list.push(slot);
    }
    const units = unitsPerPixel(width / 4);
    const groups: PendingGroup[] = [];
    for (const systemSlots of bySystem.values()) {
      let systemPositionBounds: { x: [number, number]; y: [number, number] } | undefined;
      if (systemSlots[0]!.seeds.values().next().value?.[0]?.randomBindings) {
        systemPositionBounds = { x: [Infinity, -Infinity], y: [Infinity, -Infinity] };
        for (const slot of systemSlots)
          for (const samples of slot.seeds.values())
            for (const sample of samples)
              for (const channel of ["x", "y"] as const) {
                const position = sample.corners.reduce((sum, corner) => sum + corner[channel], 0) / 4;
                systemPositionBounds[channel][0] = Math.min(systemPositionBounds[channel][0], position);
                systemPositionBounds[channel][1] = Math.max(systemPositionBounds[channel][1], position);
              }
      }
      systemSlots.sort((a, b) => a.birth - b.birth);
      // Emission times are deterministic per slot; only the draws vary. A
      // Sonolus instance cannot know its slot, so a group may only hold slots
      // born together (within BIRTH_WINDOW): then every trajectory is a
      // function of the random draws alone.
      const cohorts: Array<typeof systemSlots> = [];
      for (const slot of systemSlots) {
        const last = cohorts[cohorts.length - 1];
        if (!sourceTrajectories && last && last.length < COHORT_SIZE && slot.birth - last[0]!.birth <= BIRTH_WINDOW)
          last.push(slot);
        else cohorts.push([slot]);
      }
      for (const [cohortIndex, cohort] of cohorts.entries()) {
        const instances = sourceTrajectories
          ? cohort.map((slot) => {
              const seed = SEEDS[(cohortIndex + slot.system) % SEEDS.length]!;
              return slot.seeds.get(seed) ?? [...slot.seeds.values()][0]!;
            })
          : cohort.flatMap((slot) => [...slot.seeds.values()]);
        const star = sourceParticleFamily(instances[0]![0]!) === "star";
        const lifetimes = instances.map((list) => list[0]!.lifetime);
        const shortest = Math.min(...lifetimes);
        const longest = Math.max(...lifetimes);
        // Random lifetimes cannot share one fade-out edge: split the lifetime
        // draw (r4) into bins, each re-mapped onto the full [0, 1) range.
        // Random lifetimes cannot share one fade-out edge or one decelerating
        // path: bin the lifetime draw (r4) so each bin's spread stays under
        // LIFETIME_SPREAD of its lifetime.
        const bins =
          sourceTrajectories || star
            ? 1
            : Math.min(
                MAX_LIFETIME_BINS,
                Math.max(1, Math.ceil((longest - shortest) / Math.max(1e-6, LIFETIME_SPREAD * longest))),
              );
        // Path = velocity draw (5) x curve(age / lifetime): a product Sonolus
        // expressions cannot hold. Splitting both draws makes it near-linear
        // inside each bin (each bin re-mapped onto [0, 1)).
        // A sparse star must retain its authored size distribution. Assigning
        // one birth to one of many cells discarded the other size draws.
        const velocityBins = sourceTrajectories || star ? 1 : VELOCITY_BINS;
        let sampledInstances = 0;
        for (let cell = 0; cell < bins * velocityBins; cell += 1) {
          const bin = Math.floor(cell / velocityBins);
          const vbin = cell % velocityBins;
          const lo = bin / bins;
          const hi = (bin + 1) / bins;
          const vlo = vbin / velocityBins;
          const vhi = (vbin + 1) / velocityBins;
          const members = instances.filter(
            (list) =>
              (bins === 1 || (list[0]!.draws[3]! >= lo && list[0]!.draws[3]! < hi)) &&
              (velocityBins === 1 || (list[0]!.draws[5]! >= vlo && list[0]!.draws[5]! < vhi)),
          );
          if (!members.length) continue;
          // Empty fitted cells have no trajectory to emit. Allocate the
          // cohort's whole count across observed cells; allocating uniformly
          // over all cells silently discarded small/sparsely sampled cohorts.
          const previousInstances = sampledInstances;
          sampledInstances += members.length;
          const count =
            Math.round((cohort.length * sampledInstances) / instances.length) -
            Math.round((cohort.length * previousInstances) / instances.length);
          if (count <= 0) continue;
          const remap = (draws: readonly number[]): number[] => {
            const copy = draws.slice();
            if (bins > 1) copy[3] = (copy[3]! - lo) / (hi - lo);
            if (velocityBins > 1) copy[5] = (copy[5]! - vlo) / (vhi - vlo);
            return copy;
          };
          const samples = members.flat();
          const classWeight = new Map<string, number>();
          for (const sample of samples) {
            const key = tiles.observe(sample, coreMips);
            classWeight.set(key, (classWeight.get(key) ?? 0) + intensity(sample.emission));
          }
          const key = [...classWeight.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
          if (!key) continue;
          // The star's own near bloom (mips 1..2): a halo-only bake of the same
          // sprite that follows its position, size and rotation.
          const haloClass = new Map<string, number>();
          if (STAR_HALOS)
            for (const sample of samples) {
              const haloKey = tiles.observe(sample, STAR_HALO_MIPS, 1);
              haloClass.set(haloKey, (haloClass.get(haloKey) ?? 0) + intensity(sample.emission));
            }
          const haloKey = [...haloClass.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? key;
          groups.push({
            plane: majorityPlane(samples),
            build: (sprites) => {
              const tile = tiles.tiles.get(key)!;
              const sprite = sprites.get(key)!;
              const haloTile = tiles.tiles.get(haloKey)!;
              const halo = sprites.get(haloKey)!;
              const first = members[0]![0]!;
              const start = Math.max(
                0,
                progressOf(sourceTrajectories ? first.birth : Math.min(...samples.map((sample) => sample.t))),
              );
              const endProgress = sourceTrajectories
                ? progressOf(first.birth + first.lifetime)
                : progressOf(Math.max(...samples.map((sample) => sample.t))) + sampleStep / spec.lifetime;
              const end = Math.min(spec.loop ? 2 : 1, endProgress);
              const duration = Math.max(1e-4, end - start);
              const intervalKey = JSON.stringify([spec.name, width, first.system, start, lo, hi, vlo, vhi]);
              const intervals = options.particleIntervals?.get(intervalKey)?.map((p) => ({
                q0: (p.start - start) / duration,
                q1: (p.start + p.duration - start) / duration,
              }));
              let sourcePeak: number[] | undefined;
              if (options.particleAlpha === "source-peak") {
                const sourceImage = decodeRgba8Png(readFileSync(first.file), first.file);
                sourcePeak = [0, 0, 0];
                for (let i = 0; i < sourceImage.pixels.length; i += 4)
                  for (let c = 0; c < 3; c++)
                    sourcePeak[c] = Math.max(
                      sourcePeak[c]!,
                      ((sourceImage.pixels[i + c]! / 255) * sourceImage.pixels[i + 3]!) / 255,
                    );
              }
              const traced = members.map((raw) => {
                let previousR: number | undefined;
                const draws = remap(raw[0]!.draws);
                const list = raw;
                return list.map((sample) => {
                  const quad = quadParams(sample, tile.expand, width, previousR, tile.offset);
                  previousR = quad.r;
                  const haloQuad = quadParams(sample, haloTile.expand, width, quad.r, haloTile.offset);
                  return {
                    q: (progressOf(sample.t) - start) / duration,
                    quad,
                    a: options.particleAlpha === "constant" ? 1 : sourcePeak
                      ? Math.min(1, Math.max(...sample.emission.map((value, c) => value * sourcePeak![c]!)))
                      : responseAt(tile, tiles.relative(key, sample)),
                    haloQuad,
                    haloA: responseAt(haloTile, tiles.relative(haloKey, sample)),
                    draws,
                  };
                });
              });
              const gridStep = sampleStep / (spec.lifetime * duration);
              const observe =
                (useHalo: boolean) =>
                (q0: number, q1: number): ChannelObservations => {
                  const observations = emptyObservations();
                  const span = Math.max(1e-9, q1 - q0);
                  for (const instance of traced) {
                    const draws = instance[0]!.draws;
                    const first = instance[0]!.q;
                    const last = instance[instance.length - 1]!.q;
                    for (const { q, quad: core, a, haloQuad, haloA } of instance) {
                      if (q < q0 - 1e-9 || q > q1 + 1e-9) continue;
                      const local = (q - q0) / span;
                      const quad = useHalo ? haloQuad : core;
                      observations.x.push({ q: local, r: draws, v: quad.x });
                      observations.y.push({ q: local, r: draws, v: quad.y });
                      observations.w.push({ q: local, r: draws, v: quad.w });
                      observations.h.push({ q: local, r: draws, v: quad.h });
                      observations.r.push({ q: local, r: draws, v: quad.r });
                      observations.a.push({ q: local, r: draws, v: useHalo ? haloA : a });
                    }
                    if (sourceTrajectories)
                      for (const edge of [q0, q1]) {
                        const next = instance.findIndex((value) => value.q >= edge);
                        const right = next < 0 ? instance[instance.length - 1]! : instance[next]!;
                        const left = next <= 0 ? right : instance[next - 1]!;
                        const blend =
                          right.q > left.q ? Math.max(0, Math.min(1, (edge - left.q) / (right.q - left.q))) : 0;
                        const a = useHalo ? left.haloQuad : left.quad,
                          b = useHalo ? right.haloQuad : right.quad;
                        for (const channel of ["x", "y", "w", "h", "r"] as const)
                          observations[channel].push({
                            q: (edge - q0) / span,
                            r: draws,
                            v: a[channel] + (b[channel] - a[channel]) * blend,
                          });
                        const aa = useHalo ? left.haloA : left.a,
                          ab = useHalo ? right.haloA : right.a;
                        observations.a.push({
                          q: (edge - q0) / span,
                          r: draws,
                          v: edge < first - 1e-9 || edge > last + 1e-9 ? 0 : aa + (ab - aa) * blend,
                        });
                      }
                    // Before birth and after death the instance is invisible.
                    for (let q = q0; q <= q1 + 1e-9; q += gridStep) {
                      if (q >= first - gridStep / 2 && q <= last + gridStep / 2) continue;
                      observations.a.push({ q: (q - q0) / span, r: draws, v: 0 });
                    }
                  }
                  return observations;
                };
              const bindings = members[0]![0]!.randomBindings;
              // Serial pieces preserve sampled size/brightness pulses without
              // keeping several quads alive at once or replacing them by RMS.
              const turns = Math.max(
                ...members.map((list) => {
                  const values = list.map((sample) => sample.pixelArea);
                  const peak = Math.max(...values);
                  let count = 0;
                  for (let index = 2; index < values.length; index++) {
                    const a = values[index - 1]! - values[index - 2]!;
                    const b = values[index]! - values[index - 1]!;
                    if (a * b < 0 && Math.abs(a) + Math.abs(b) > peak * 0.1) count++;
                  }
                  return count;
                }),
              );
              const corePieces = Math.max(MAX_COHORT_PIECES, Math.min(6, turns + 1));
              const frameLod = { candidates: 0, retained: 0, fluxTime: 0, retainedFluxTime: 0 };
              const frameRgbCoverage = [0, 0, 0];
              if (options.particleFrameLod)
                for (let p = 0; p < tile.image.pixels.length; p += 4)
                  for (let c = 0; c < 3; c++)
                    frameRgbCoverage[c]! +=
                      (tile.image.pixels[p + c]! * tile.image.pixels[p + 3]!) /
                      (65025 * tile.image.width * tile.image.height);
              const spritePieces = options.particleFrameHold
                ? []
                : fitPieces(
                    observe(false),
                    !sourceTrajectories,
                    sourceTrajectories ? sourcePieces : corePieces,
                    sourceTrajectories ? undefined : bindings?.startSpeedRandom,
                    systemPositionBounds,
                    sourceTrajectories,
                    sourceTrajectories
                      ? (first.authoredTimes ?? []).map((t) => (progressOf(t) - start) / duration)
                      : [],
                    sourceTrajectories ? { ...units, tolerance: lightBudget ? 3 : 2 } : undefined,
                    intervals,
                  );
              let coreParticles = options.particleFrameHold
                ? members[0]!.flatMap((sample) => {
                    if (Math.abs((sample.t - warm) / sampleStep - Math.round((sample.t - warm) / sampleStep)) > 1e-7)
                      return [];
                    const quad = quadParams(sample, tile.expand, width, undefined, tile.offset);
                    const a = responseAt(tile, tiles.relative(key, sample));
                    const frameStart = progressOf(sample.t);
                    const frameEnd = Math.min(frameStart + sampleStep / spec.lifetime, spec.loop ? 2 : 1);
                    if (frameEnd <= frameStart) return [];
                    // Resource intervals include their endpoint; retire the old image before the next Source frame.
                    const frameDuration = durationBeforeNextPhase(frameStart, frameEnd);
                    if (quad.w === 0 || quad.h === 0 || a <= 0 || frameDuration <= 0) return [];
                    const constant = (value: number) => {
                      const from = expressionJson([value], 6);
                      return { from, to: { ...from }, ease: "none" as const };
                    };
                    const particle = {
                      sprite,
                      color: "#ffffff",
                      start: frameStart,
                      duration: frameDuration,
                      x: constant(quad.x),
                      y: constant(quad.y),
                      w: constant(quad.w),
                      h: constant(quad.h),
                      r: constant(quad.r),
                      a: constant(a),
                    };
                    if (options.particleCoreColour) calibrateStarColour([particle], [sample], tile, progressOf);
                    if (options.particleFrameLod) {
                      const { pixelWidth, minFlux } = options.particleFrameLod;
                      const rgb = [0, 1, 2].map((c) => parseInt(particle.color.slice(1 + c * 2, 3 + c * 2), 16) / 255);
                      const area =
                        sample.pixelArea * Math.abs(tile.expand[0] * tile.expand[1]) * (pixelWidth / 1920) ** 2;
                      const flux =
                        area *
                        (particle.a.from.c ?? 0) *
                        frameRgbCoverage.reduce(
                          (sum, value, c) => sum + value * rgb[c]! * [0.2126, 0.7152, 0.0722][c]!,
                          0,
                        );
                      frameLod.candidates++;
                      frameLod.fluxTime += flux * frameDuration;
                      if (flux < minFlux) return [];
                      frameLod.retained++;
                      frameLod.retainedFluxTime += flux * frameDuration;
                    }
                    return [particle];
                  })
                : particleDefs(sprite, start, duration, spritePieces, "#ffffff", sourceTrajectories ? 6 : 4);
              let compression;
              if (sourceTrajectories && options.particleCompression && !options.particleFrameHold) {
                const plane = NATIVE_EFFECT_PLANES[majorityPlane(samples)]!;
                compression = compressSourceTrajectory(coreParticles as unknown as TrajectoryParticle[], {
                  project: (x, y) => [
                    ((x * (plane.alpha1 - plane.slope * (y + 1) * W_TO_H)) / units.x) * (390 / 1920),
                    (y / units.y) * (390 / 1920),
                  ],
                  coverage: trajectoryCoverage(tile.image),
                  loop: !!spec.loop,
                });
                coreParticles = compression.particles as unknown as Json[];
              }
              if (sourceTrajectories && options.particleCoreColour && !options.particleFrameHold)
                calibrateStarColour(coreParticles as never, members[0]!, tile, progressOf);
              if (process.env.SONOLUS_FIT_REPORT && options.particleFrameHold)
                motionFitReport.push({
                  effect: spec.name,
                  width,
                  system: first.system,
                  sourceFamily: sourceParticleFamily(first),
                  plane: majorityPlane(samples),
                  count,
                  motionModel: "source-frame-hold",
                  sampleRate: 1 / sampleStep,
                  frameLod: options.particleFrameLod ? { ...options.particleFrameLod, ...frameLod } : undefined,
                  sourceIdentity: {
                    seed: first.seed,
                    emission: first.emission_,
                    birth: first.birth,
                    lifetime: first.lifetime,
                  },
                  nativeParticles: coreParticles,
                });
              if (process.env.SONOLUS_FIT_REPORT && !options.particleFrameHold) {
                const obs = observe(false)(0, 1);
                const mean = (channel: Channel) =>
                  obs[channel].reduce((sum, o) => sum + Math.abs(o.v), 0) / Math.max(1, obs[channel].length);
                const piece = spritePieces.reduce((worst, candidate) =>
                  candidate.fits.y.rms > worst.fits.y.rms ? candidate : worst,
                ).fits;
                const pieceCount = spritePieces.length;
                // Bias: mean fitted / mean observed per channel over all pieces.
                const bias = (channel: Channel) => {
                  let fitted = 0;
                  let observed = 0;
                  for (const piece of spritePieces) {
                    const span = piece.q1 - piece.q0;
                    for (const o of observe(false)(piece.q0, piece.q1)[channel]) {
                      const fit = piece.fits[channel];
                      const value = (expression: number[]) => expressionValue(expression, o.r);
                      const k = ease(fit.ease, o.q);
                      fitted += Math.abs(value(fit.from) + (value(fit.to) - value(fit.from)) * k);
                      observed += Math.abs(o.v);
                      void span;
                    }
                  }
                  return fitted / Math.max(1e-9, observed);
                };
                fitReport.push(`BIAS w=${bias("w").toFixed(2)} h=${bias("h").toFixed(2)} a=${bias("a").toFixed(2)}`);
                fitReport.push(
                  `${key.split("|")[0]!.split("/").pop()} n=${members.length} pieces=${pieceCount} ` +
                    (["x", "y", "w", "h", "a"] as const)
                      .map(
                        (channel) =>
                          `${channel}:${(piece[channel].rms / Math.max(1e-6, channel === "x" || channel === "y" ? units.x * 20 : mean(channel))).toFixed(2)}`,
                      )
                      .join(" "),
                );
                motionFitReport.push({
                  effect: spec.name,
                  width,
                  system: samples[0]!.system,
                  sourceFamily: sourceParticleFamily(samples[0]!),
                  intervalKey,
                  count,
                  members: members.length,
                  plane: majorityPlane(samples),
                  motionModel: sourceTrajectories ? "source-trajectories" : "random-fit",
                  sourceMembers: members.map((list, index) => {
                    const first = list[0]!;
                    let previousR: number | undefined;
                    const source = particles.filter(
                      (sample) =>
                        sample.seed === first.seed &&
                        sample.system === first.system &&
                        sample.emission_ === first.emission_ &&
                        Math.abs(sample.birth - first.birth) < 1e-5,
                    );
                    return {
                      seed: first.seed,
                      system: first.system,
                      emission: first.emission_,
                      birth: first.birth,
                      lifetime: first.lifetime,
                      draws: traced[index]![0]!.draws,
                      samples: source.map((sample) => {
                        const quad = quadParams(sample, tile.expand, width, previousR, tile.offset);
                        previousR = quad.r;
                        return {
                          q: (progressOf(sample.t) - start) / duration,
                          quad,
                          displayAlpha: responseAt(tile, tiles.relative(key, sample)),
                          t: sample.t,
                          materialAlpha: sample.materialAlpha,
                          emission: sample.emission,
                        };
                      }),
                    };
                  }),
                  randomBindings: bindings,
                  tileGeometry: { expand: tile.expand, offset: tile.offset },
                  systemPositionBounds,
                  start,
                  duration,
                  lifetime: spec.lifetime,
                  nativeParticles: coreParticles.map(({ sprite: _sprite, ...particle }) => particle),
                  ...(compression ? { compression: compression.report } : {}),
                  emissionSlots: [
                    ...new Set(cohort.flatMap((slot) => [...slot.seeds.values()].map((list) => list[0]!.emission_))),
                  ],
                  drawCell: { lifetime: [lo, hi], velocity: [vlo, vhi] },
                  sourceBounds: Object.fromEntries(
                    CHANNELS.map((channel) => [
                      channel,
                      {
                        min: Math.min(...obs[channel].map((o) => o.v)),
                        max: Math.max(...obs[channel].map((o) => o.v)),
                      },
                    ]),
                  ),
                  pieces: spritePieces.map((piece) => ({
                    q0: piece.q0,
                    q1: piece.q1,
                    fits: Object.fromEntries(
                      CHANNELS.map((channel) => [
                        channel,
                        {
                          rms: piece.fits[channel].rms,
                          max: piece.fits[channel].max,
                          ease: piece.fits[channel].ease,
                          from: expressionJson(piece.fits[channel].from),
                          to: expressionJson(piece.fits[channel].to),
                          serialized: channelJson(piece.fits[channel], channel === "a"),
                          ...(channel === "x" || channel === "y"
                            ? {
                                rmsPixels: piece.fits[channel].rms / units[channel],
                                maxPixels: piece.fits[channel].max / units[channel],
                              }
                            : {}),
                        },
                      ]),
                    ),
                  })),
                });
              }
              const haloPieces = STAR_HALOS
                ? fitPieces(observe(true), true, MAX_COHORT_PIECES, bindings?.startSpeedRandom, systemPositionBounds)
                : [];
              return {
                count,
                ...debugTag(key),
                particles: [...particleDefs(halo, start, duration, haloPieces), ...coreParticles],
              };
            },
          });
        }
      }
    }
    return groups;
  }

  /**
   * HDR accumulation of dense star swarms: the original adds overlapping
   * stars before bloom, so a flick column clips to white and blooms as one
   * cloud; alpha-composited sprites cannot add up. The bloom of a random cloud
   * equals (to within the blur radius) the bloom of its mean density, which
   * is deterministic: bake it from every traced seed at SWARM_KEYFRAMES times
   * and cross-fade them. Only swarms whose cloud is visible get one.
   */
  function swarmBloomGroups(
    particles: readonly ParticleSample[],
    width: number,
    progressOf: (t: number) => number,
    spec: EffectSpec,
    seedCount: number,
  ): PendingGroup[] {
    const units = unitsPerPixel(width / 4);
    const byTime = new Map<number, ParticleSample[]>();
    for (const sample of particles) {
      if (intensity(sample.emission) <= 1e-3) continue;
      const step = Math.round(sample.t / sampleStep);
      let list = byTime.get(step);
      if (!list) byTime.set(step, (list = []));
      list.push(sample);
    }
    const steps = [...byTime.keys()].sort((a, b) => a - b);
    if (!steps.length) return [];
    const energy = (list: readonly ParticleSample[]) =>
      list.reduce((sum, sample) => sum + intensity(sample.emission) * sample.pixelArea, 0) / seedCount;
    const energies = steps.map((step) => energy(byTime.get(step)!));
    const total = energies.reduce((a, b) => a + b, 0);
    if (total <= 0) return [];
    // Keyframes at energy quantiles.
    const keys: number[] = [];
    let running = 0;
    let next = 0;
    for (let index = 0; index < steps.length && keys.length < SWARM_KEYFRAMES; index += 1) {
      running += energies[index]!;
      while (keys.length < SWARM_KEYFRAMES && running >= ((next + 0.5) / SWARM_KEYFRAMES) * total) {
        if (keys[keys.length - 1] !== index) keys.push(index);
        next += 1;
      }
    }
    const baked = keys.map((index) => {
      const list = byTime.get(steps[index]!)!;
      const quads = list.map((sample) => ({
        file: sample.file,
        uv: sample.uv,
        emission: sample.emission.map((value) => value / seedCount) as unknown as readonly [number, number, number],
        corners: sample.corners.map((corner) => [corner.x / units.x, corner.y / units.y] as const),
      }));
      const key = `swarm|${spec.name}|${width}|${bloomScale.toFixed(2)}|${steps[index]}`;
      const result = bakeCompositeHalo(key, quads, 0, 5, BLOOM_GAIN, SWARM_DENSITY, bloomScale, false, 2);
      let peak = 0;
      for (let p = 3; p < result.tile.image.pixels.length; p += 4) peak = Math.max(peak, result.tile.image.pixels[p]!);
      return { index, key, result, peak: peak / 255 };
    });
    if (Math.max(...baked.map((entry) => entry.peak)) < SWARM_VISIBILITY) return [];
    for (const entry of baked) compositeHalos.set(entry.key, entry.result);
    const plane = majorityPlane(particles.slice(0, 64));
    return baked.map((entry, k) => ({
      plane,
      build: (sprites) => {
        const sprite = sprites.get(entry.key);
        if (sprite === undefined) return undefined;
        const { rect } = entry.result;
        const x = ((rect.x0 + rect.x1) / 2) * units.x;
        const y = ((rect.y0 + rect.y1) / 2) * units.y;
        const w = ((rect.x1 - rect.x0) / 2) * units.x;
        const h = ((rect.y1 - rect.y0) / 2) * units.y;
        // Triangle cross-fade between neighbouring keyframes, scaled by the
        // energy relative to this keyframe (the tile is baked at its own).
        const own = energies[entry.index]!;
        const prev = k > 0 ? baked[k - 1]!.index : 0;
        const nextIndex = k < baked.length - 1 ? baked[k + 1]!.index : steps.length - 1;
        const params: Array<{ q: number; a: number }> = [];
        for (let index = prev; index <= nextIndex; index += 1) {
          const weight =
            index <= entry.index
              ? k === 0
                ? 1
                : (index - prev) / Math.max(1, entry.index - prev)
              : k === baked.length - 1
                ? 1
                : (nextIndex - index) / Math.max(1, nextIndex - entry.index);
          params.push({
            q: progressOf(steps[index]! * sampleStep),
            a: Math.max(0, Math.min(1, weight * responseAt(entry.result.tile, energies[index]! / Math.max(1e-9, own)))),
          });
        }
        const start = Math.max(0, params[0]!.q);
        const end = Math.min(1, params[params.length - 1]!.q + sampleStep / spec.lifetime);
        const duration = Math.max(1e-4, end - start);
        const build = (q0: number, q1: number): ChannelObservations => {
          const observations = emptyObservations();
          const span = Math.max(1e-9, q1 - q0);
          for (const param of params) {
            const q = (param.q - start) / duration;
            if (q < q0 - 1e-9 || q > q1 + 1e-9) continue;
            const local = (q - q0) / span;
            observations.x.push({ q: local, r: [], v: x });
            observations.y.push({ q: local, r: [], v: y });
            observations.w.push({ q: local, r: [], v: w });
            observations.h.push({ q: local, r: [], v: h });
            observations.r.push({ q: local, r: [], v: 0 });
            observations.a.push({ q: local, r: [], v: param.a });
          }
          return observations;
        };
        return {
          count: 1,
          particles: particleDefs(sprite, start, duration, fitPieces(build, false, 4)),
          ...debugTag(`swarm ${k}`),
        };
      },
    }));
  }

  /**
   * LiveUrpBloom's wide mips (15..62 px) become radial kernel particles at the
   * flux centroid of each GLOW_CELL px screen cell. Sonolus composites with
   * "over", not additive, so overlapping cells over-brighten; measured against
   * the web renderer one cell per effect (the default) is closest.
   */
  function glowGroups(
    meshSamples: readonly QuadSample[],
    particleSamples: readonly ParticleSample[],
    width: number,
    progressOf: (t: number) => number,
    spec: EffectSpec,
    seedCount: number,
    glow: { key: string; kernel: BloomKernel },
  ): PendingGroup[] {
    const kernel = glow.kernel;
    const units = unitsPerPixel(width / 4);
    const steps = Math.round(spec.lifetime / sampleStep);
    interface Cell {
      flux: Map<number, number>;
      /** Per-time flux centroid (the glow follows the effect as it rises). */
      centroid: Map<number, [number, number, number]>;
      chroma: [number, number, number];
      px: number;
      py: number;
      weight: number;
    }
    const cells = new Map<string, Cell>();
    const add = (sample: QuadSample, share: number) => {
      const p = progressOf(sample.t);
      if (p < -1e-9 || p > 1 + 1e-9) return;
      const flux = prefilteredFlux(sample.file, sample.uv, sample.emission);
      const amount = sample.pixelArea * share;
      const peak = Math.max(...flux) * amount;
      if (peak <= 0) return;
      const [c0, , c2] = sample.corners;
      const x = (c0.x + c2.x) / 2;
      const y = (c0.y + c2.y) / 2;
      const key = `${Math.floor(x / units.x / GLOW_CELL)}:${Math.floor(y / units.y / GLOW_CELL)}`;
      let cell = cells.get(key);
      if (!cell)
        cells.set(key, (cell = { flux: new Map(), centroid: new Map(), chroma: [0, 0, 0], px: 0, py: 0, weight: 0 }));
      const bin = Math.round(p * steps);
      cell.flux.set(bin, (cell.flux.get(bin) ?? 0) + peak);
      const centroid = cell.centroid.get(bin) ?? [0, 0, 0];
      centroid[0] += x * peak;
      centroid[1] += y * peak;
      centroid[2] += peak;
      cell.centroid.set(bin, centroid);
      for (let c = 0; c < 3; c += 1) cell.chroma[c]! += flux[c]! * amount;
      cell.px += x * peak;
      cell.py += y * peak;
      cell.weight += peak;
    };
    for (const sample of meshSamples) add(sample, 1);
    // Particles are traced for every seed; average them.
    for (const sample of particleSamples) add(sample, 1 / seedCount);
    const groups: PendingGroup[] = [];
    for (const cell of cells.values()) {
      const params: Array<{ q: number; a: number; x: number; y: number }> = [];
      let last: [number, number] = [cell.px / cell.weight, cell.py / cell.weight];
      for (let step = 0; step <= steps; step += 1) {
        const centroid = cell.centroid.get(step);
        if (centroid && centroid[2] > 0) last = [centroid[0] / centroid[2], centroid[1] / centroid[2]];
        params.push({
          q: step / steps,
          a: kernelAlpha(kernel.centerGain * (cell.flux.get(step) ?? 0)),
          x: last[0],
          y: last[1],
        });
      }
      if (Math.max(...params.map((param) => param.a)) < GLOW_VISIBILITY) continue;
      const peakChroma = Math.max(...cell.chroma);
      const hex = hexColor(cell.chroma.map((value) => value / peakChroma));
      groups.push({
        plane: 0,
        build: (sprites) => {
          const sprite = sprites.get(glow.key);
          if (sprite === undefined) return undefined;
          const w = kernel.extent * units.x;
          const h = kernel.extent * units.y;
          const build = (q0: number, q1: number): ChannelObservations => {
            const observations = emptyObservations();
            const span = Math.max(1e-9, q1 - q0);
            for (const param of params) {
              if (param.q < q0 - 1e-9 || param.q > q1 + 1e-9) continue;
              const local = (param.q - q0) / span;
              observations.x.push({ q: local, r: [], v: param.x });
              observations.y.push({ q: local, r: [], v: param.y });
              observations.w.push({ q: local, r: [], v: w });
              observations.h.push({ q: local, r: [], v: h });
              observations.r.push({ q: local, r: [], v: 0 });
              observations.a.push({ q: local, r: [], v: param.a });
            }
            return observations;
          };
          return { count: 1, particles: particleDefs(sprite, 0, 1, fitPieces(build, false, MAX_MESH_PIECES), hex) };
        },
      });
    }
    return groups;
  }

  /**
   * Bloom (mips 1..RIG_HALO_MIPS) of each rig family (frame, wall, one pillar)
   * rendered as a whole, so neighbouring slices/strips bloom together as the
   * effect camera sees them. One low-density tile and one static quad per
   * family; its alpha follows the family's traced intensity.
   */
  function compositeHaloGroups(
    meshes: ReadonlyMap<string, readonly QuadSample[]>,
    width: number,
    progressOf: (t: number) => number,
    spec: EffectSpec,
  ): PendingGroup[] {
    const units = unitsPerPixel(width / 4);
    const families = new Map<string, Array<readonly QuadSample[]>>();
    for (const [key, list] of meshes) {
      const family = key.split("#")[0]!;
      let entry = families.get(family);
      if (!entry) families.set(family, (entry = []));
      entry.push(list.filter((sample) => progressOf(sample.t) <= 1 + 1e-9));
    }
    const groups: PendingGroup[] = [];
    for (const [family, trajectories] of families) {
      // Family intensity per time step (sum over its quads).
      const byStep = new Map<number, QuadSample[]>();
      for (const list of trajectories)
        for (const sample of list) {
          const step = Math.round((progressOf(sample.t) * spec.lifetime) / sampleStep);
          let entry = byStep.get(step);
          if (!entry) byStep.set(step, (entry = []));
          entry.push(sample);
        }
      const total = (samples: readonly QuadSample[]) =>
        samples.reduce((sum, sample) => sum + intensity(sample.emission) * sample.pixelArea, 0);
      let peakStep = -1;
      let peak = 0;
      for (const [step, samples] of byStep) {
        const value = total(samples);
        if (value > peak) {
          peak = value;
          peakStep = step;
        }
      }
      if (peakStep < 0 || peak <= 0) continue;
      const snapshot = byStep.get(peakStep)!;
      const quads = snapshot.map((sample) => ({
        file: sample.file,
        uv: sample.uv,
        emission: sample.emission,
        corners: sample.corners.map((corner) => [corner.x / units.x, corner.y / units.y] as const),
      }));
      // Shape relative to the family's own box (a pillar's halo is the same
      // at every note width), chroma only (alpha follows traced intensity).
      const originX = Math.min(...quads.flatMap((quad) => quad.corners.map(([x]) => x)));
      const originY = Math.min(...quads.flatMap((quad) => quad.corners.map(([, y]) => y)));
      // Wall and frame are uniform along x between fixed ends: one bake per
      // colour, 3-sliced to every width (SLICED_FAMILIES).
      const sliced = SLICED_FAMILIES.has(family);
      const signature = JSON.stringify(
        quads.map((quad, index) => [
          quad.file.split("/").pop(),
          ...(snapshot[index]!.materialTint ? [snapshot[index]!.materialTint] : []),
          quad.emission.map((value) => Math.round((value / Math.max(1e-9, intensity(quad.emission))) * 8)),
          ...(options.meshHaloEnergyKey ? [quad.emission.map((value) => Math.round(value * 255) / 255)] : []),
          sliced ? [] : quad.corners.map(([x, y]) => [Math.round(x - originX), Math.round(y - originY)]),
        ]),
      );
      const maxX = Math.max(...quads.flatMap((quad) => quad.corners.map(([x]) => x)));
      const maxY = Math.max(...quads.flatMap((quad) => quad.corners.map(([, y]) => y)));
      for (const layer of COMPOSITE_LAYERS) {
        if (layer.families !== family) continue;
        const key = `composite|${layer.label}|${family}|${bloomScale.toFixed(2)}|${options.meshPerspectiveUv ? "perspective|" : ""}${options.meshFrameComposite && family === "frame" ? "core|" : ""}${signature}`;
        let baked = compositeHalos.get(key);
        if (!baked) {
          const local = quads.map((quad, index) => ({
            ...quad,
            corners: quad.corners.map(([x, y]) => [x - originX, y - originY] as const),
            ...(options.meshPerspectiveUv && snapshot[index]?.inverseDepths
              ? {
                  projection: {
                    originX,
                    originY,
                    alphaOrigin:
                      NATIVE_EFFECT_PLANES[snapshot[index]!.plane]!.alpha1 -
                      NATIVE_EFFECT_PLANES[snapshot[index]!.plane]!.slope * W_TO_H,
                    alphaSlope: -NATIVE_EFFECT_PLANES[snapshot[index]!.plane]!.slope * W_TO_H * units.y,
                    inverseDepths: snapshot[index]!.inverseDepths!,
                  },
                }
              : {}),
          }));
          baked = bakeCompositeHalo(
            key,
            local,
            options.meshFrameComposite && family === "frame" ? 0 : layer.mipFrom,
            lightBudget ? Math.min(layer.mipTo, 2) : layer.mipTo,
            BLOOM_GAIN,
            lightBudget && layer.families === "wall" ? 1 / 4 : layer.density,
            bloomScale,
            ("core" in layer && layer.core) || (options.meshFrameComposite && family === "frame"),
          );
          compositeHalos.set(key, baked);
        }
        // The baked padding around the family box is the same at every width.
        const padX = -baked.rect.x0;
        const padY = -baked.rect.y0;
        const rect = { x0: originX - padX, x1: maxX + padX, y0: originY - padY, y1: maxY + padY };
        const tile = baked.tile;
        // Pieces: [unit-space x0, x1, key suffix]. Sliced families stretch a
        // one-texel middle column between their fixed-size ends.
        const bakedWidth = baked.rect.x1 - baked.rect.x0;
        const endWidth = Math.min(bakedWidth / 2 - 1, padX + SLICE_END_MARGIN);
        const pieces: Array<[number, number, string]> =
          sliced && endWidth > 0
            ? [
                [rect.x0, rect.x0 + endWidth, "L"],
                [rect.x0 + endWidth, rect.x1 - endWidth, "M"],
                [rect.x1 - endWidth, rect.x1, "R"],
              ]
            : [[rect.x0, rect.x1, ""]];
        if (sliced && endWidth > 0) sliceTiles(key, baked, endWidth);
        const params = [...byStep.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([step, samples]) => ({
            q: (step * sampleStep) / spec.lifetime,
            a: responseAt(tile, total(samples) / peak),
          }));
        const largest = snapshot.reduce(
          (best, sample) => (sample.pixelArea > best.pixelArea ? sample : best),
          snapshot[0]!,
        );
        const plane = planeOf(largest);
        for (const [pieceX0, pieceX1, suffix] of pieces)
          groups.push({
            plane,
            build: (sprites) => {
              const sprite = sprites.get(suffix ? `${key}|${suffix}` : key);
              if (sprite === undefined) return undefined;
              const x = ((pieceX0 + pieceX1) / 2) * units.x;
              const y = ((rect.y0 + rect.y1) / 2) * units.y;
              const w = ((pieceX1 - pieceX0) / 2) * units.x;
              const h = ((rect.y1 - rect.y0) / 2) * units.y;
              const start = Math.max(0, params[0]!.q - sampleStep / 2 / spec.lifetime);
              const end = Math.min(1, params[params.length - 1]!.q + sampleStep / spec.lifetime);
              const duration = Math.max(1e-4, end - start);
              const build = (q0: number, q1: number): ChannelObservations => {
                const observations = emptyObservations();
                const span = Math.max(1e-9, q1 - q0);
                for (const param of params) {
                  const q = (param.q - start) / duration;
                  if (q < q0 - 1e-9 || q > q1 + 1e-9) continue;
                  const local = (q - q0) / span;
                  observations.x.push({ q: local, r: [], v: x });
                  observations.y.push({ q: local, r: [], v: y });
                  observations.w.push({ q: local, r: [], v: w });
                  observations.h.push({ q: local, r: [], v: h });
                  observations.r.push({ q: local, r: [], v: 0 });
                  observations.a.push({ q: local, r: [], v: param.a });
                }
                return observations;
              };
              return {
                count: 1,
                particles: particleDefs(sprite, start, duration, fitPieces(build, false, MAX_MESH_PIECES)),
                ...debugTag(`halo ${layer.label} ${family}${suffix}`),
              };
            },
          });
      }
    }
    return groups;
  }
}
