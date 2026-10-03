// Samples the Cassiopeia web renderer's own effect001 evaluator headlessly and
// converts every emitted instance into a textured quad in Sonolus particle
// units. The web player and the Sonolus build therefore share one Unity
// particle implementation; this module projects quads and restores the
// explicitly bound Simple billboard modes for offline particle authoring.

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { PerspectiveCamera, Vector3 } from "three";
import {
  ParticleLayer,
  StageProjector,
  configureOurNotesCamera,
  nativeBillboardQuad,
  nativeMeshQuads,
  nativeParticleRandom,
  readNativeAnimationClip,
  MOBILE_ADD_HDR_TINT_CENTER_PILLAR,
  MOBILE_ADD_HDR_TINT_CIRCLE_ICON,
  MOBILE_ADD_HDR_TINT_LONG_STAR,
  MOBILE_ADD_HDR_TINT_NORMAL,
  MOBILE_ADD_HDR_TINT_STRONG,
  MOBILE_ADD_HDR_TINT_WALL,
  type NativeBillboardTrace,
  type NativeMeshTrace,
  type NativeWorldQuad,
} from "@haneoka/cassiopeia-renderer-three";
import {
  createOurNotesAssetManifest,
  type OurNotesAssetManifest,
  type RenderParticleEffect,
} from "@haneoka/cassiopeia-plugin-our-notes";
import { authoredBillboardQuad, simpleBillboardStyle } from "./billboard.ts";

export type Tint = readonly [number, number, number, number];
// Published renderer declarations may precede the optional trace extension.
type MaterialBillboardTrace = NativeBillboardTrace & { materialTint?: Tint };
type MaterialMeshTrace = NativeMeshTrace & { materialTint?: Tint };

/** GLES roundEven for the nonnegative final MobileAddHdrColor alpha. */
const roundEven = (value: number): number => {
  const floor = Math.floor(value);
  const fraction = value - floor;
  return fraction < 0.5 ? floor : fraction > 0.5 ? floor + 1 : floor + (floor % 2);
};

export function materialEmission(
  texture: TextureKey,
  color: { r: number; g: number; b: number; a: number },
  materialTint?: Tint,
): readonly [number, number, number] {
  const tint = materialTint ?? TEXTURE_TINTS[texture]!;
  // MobileAddHdrColor quantizes after both tint stages and HDR doubling,
  // without a unit clamp. The tile supplies texel.rgb * texel.a.
  const alpha =
    texture === "laneEffect"
      ? Math.max(0, color.a)
      : roundEven(Math.max(0, color.a * 2 * tint[3] * tint[3]) * 255) / 255;
  const hdr = texture === "laneEffect" ? [1, 1, 1] : tint.slice(0, 3).map((value) => 2 * value * value);
  return [color.r * hdr[0]! * alpha, color.g * hdr[1]! * alpha, color.b * hdr[2]! * alpha];
}

/** Source texture key -> material tint (MobileAddHdrColor applies it twice). */
export const TEXTURE_TINTS: Readonly<Record<string, Tint>> = {
  star: MOBILE_ADD_HDR_TINT_NORMAL,
  longStar: MOBILE_ADD_HDR_TINT_LONG_STAR,
  centerPillar: MOBILE_ADD_HDR_TINT_CENTER_PILLAR,
  centerPillar02: MOBILE_ADD_HDR_TINT_CENTER_PILLAR,
  circleIcon: MOBILE_ADD_HDR_TINT_CIRCLE_ICON,
  frame: MOBILE_ADD_HDR_TINT_STRONG,
  pillar: MOBILE_ADD_HDR_TINT_NORMAL,
  wall: MOBILE_ADD_HDR_TINT_WALL,
  laneEffect: [1, 1, 1, 1],
};

/** Particle manifest URL field for each texture key. */
export const TEXTURE_URL_FIELDS = {
  star: "starTextureUrl",
  longStar: "longStarTextureUrl",
  centerPillar: "centerPillarTextureUrl",
  centerPillar02: "centerPillar02TextureUrl",
  circleIcon: "circleIconTextureUrl",
  frame: "tapLineTextureUrl",
  pillar: "tapPillarTextureUrl",
  wall: "wallTextureUrl",
} as const;

export type TextureKey = keyof typeof TEXTURE_URL_FIELDS | "laneEffect";

// shared/src/engine/data/lane.ts (Sonolus engine). Authoring always uses the
// 16:9 stage, where Sonolus screen units equal stage units.
const HORIZON_Y = 1.115119873136453;
const JUDGMENT_Y = -0.5815420740473228;
const JUDGMENT_HALF_X = 0.7932747292495311;
const ASPECT = 16 / 9;
const STAGE_T = HORIZON_Y;
/** World z just in front of the trace camera (camera faces -z at the origin). */
const NEAR_CLIP_Z = -0.2;

/** Sutherland-Hodgman clip of a convex world polygon against z <= NEAR_CLIP_Z. */
function clipNearPlane(corners: readonly Vector3[]): Vector3[] {
  const output: Vector3[] = [];
  for (let index = 0; index < corners.length; index += 1) {
    const current = corners[index]!;
    const next = corners[(index + 1) % corners.length]!;
    const currentInside = current.z <= NEAR_CLIP_Z;
    const nextInside = next.z <= NEAR_CLIP_Z;
    if (currentInside) output.push(current);
    if (currentInside !== nextInside) {
      const amount = (NEAR_CLIP_Z - current.z) / (next.z - current.z);
      output.push(current.clone().lerp(next, amount));
    }
  }
  return output;
}
const STAGE_B = JUDGMENT_Y;
const STAGE_SX = ASPECT * (JUDGMENT_HALF_X / 6);
const STAGE_SY = STAGE_B - STAGE_T;
/** Engine `scaledScreen.wToH`: the spawn rect is 2 * W_TO_H stage units tall. */
export const W_TO_H = STAGE_SX / (STAGE_T - STAGE_B);

const JUDGEMENT_Z = new StageProjector().judgementZ;

/**
 * The effect meshes split every face into halves along v (the wall mesh cuts
 * at v = 0.502). Rejoin halves that share an edge, so one face is one quad.
 */
function mergeMeshQuads(quads: NativeWorldQuad[]): NativeWorldQuad[] {
  const result = quads.slice();
  let merged = true;
  const close = (a: Vector3, b: Vector3) => a.distanceToSquared(b) < 1e-8;
  while (merged) {
    merged = false;
    outer: for (let i = 0; i < result.length; i += 1)
      for (let j = 0; j < result.length; j += 1) {
        if (i === j) continue;
        const a = result[i]!;
        const b = result[j]!;
        // b stacked on a: same u range, b.v0 == a.v1, shared top/bottom edge.
        if (
          Math.abs(a.uv[0] - b.uv[0]) < 1e-6 &&
          Math.abs(a.uv[2] - b.uv[2]) < 1e-6 &&
          Math.abs(a.uv[3] - b.uv[1]) < 1e-6 &&
          close(a.corners[3], b.corners[0]) &&
          close(a.corners[2], b.corners[1])
        ) {
          const ab = a.corners[3].clone().sub(a.corners[0]);
          const bb = b.corners[3].clone().sub(b.corners[0]);
          // Only coplanar, collinear continuations (same edge direction) whose
          // texture runs linearly across the join (not 9-slice borders).
          if (ab.clone().normalize().distanceTo(bb.clone().normalize()) > 1e-4) continue;
          const ratio = (b.uv[3] - b.uv[1]) / (a.uv[3] - a.uv[1]) / (bb.length() / Math.max(1e-9, ab.length()));
          if (Math.abs(ratio - 1) > 1e-3) continue;
          result[i] = {
            corners: [a.corners[0], a.corners[1], b.corners[2], b.corners[3]],
            uv: [a.uv[0], a.uv[1], a.uv[2], b.uv[3]],
          };
          result.splice(j, 1);
          merged = true;
          break outer;
        }
      }
  }
  return result;
}

/**
 * Sonolus effect transform that puts a centre-authored part on its own plane.
 * For any plane, the projected lane offset is linear in screen y:
 * lane * alpha(sy). The engine's linearEffectLayout realises the judgement
 * plane's alpha; the transform re-expresses another plane's alpha through
 * lane = (x1+x4)/2 and lane*(1-t) = ((x2+x3)/2 - lane) / skew, both linear in
 * the spawned corners, so it holds for any lane, width and effect size.
 */
/**
 * Plane layers (depth relative to the judgement line, Three z). Must match
 * the engine's NATIVE_EFFECT_PLANES; `alpha` values are measured below.
 */
export const EFFECT_PLANES = [
  { depth: 0, ground: false },
  { depth: -0.64, ground: false },
  { depth: 0.6, ground: false },
  { depth: 0, ground: true },
] as const;

export const planeIndex = (depth: number, ground: boolean): number => {
  if (ground) return 3;
  let best = 0;
  for (let index = 1; index < 3; index += 1)
    if (Math.abs(depth - EFFECT_PLANES[index]!.depth) < Math.abs(depth - EFFECT_PLANES[best]!.depth)) best = index;
  return best;
};

export interface PlaneTransform {
  /** alpha at the judgement line and its slope in stage y. */
  alpha1: number;
  slope: number;
}

export interface UnitPoint {
  x: number;
  y: number;
}

/** One textured quad at one instant, in Sonolus particle units of the spawn rect. */
export interface QuadSample {
  t: number;
  /** Corners (u0,v0) (u1,v0) (u1,v1) (u0,v1) in unit space. */
  corners: [UnitPoint, UnitPoint, UnitPoint, UnitPoint];
  texture: TextureKey;
  /** Source PNG of `texture` for the traced profile. */
  file: string;
  uv: readonly [number, number, number, number];
  /** Instance override; one texture can be bound to several authored materials. */
  materialTint?: Tint;
  /** HDR colour with final quantized source alpha folded in for additive baking. */
  emission: readonly [number, number, number];
  /** World depth of the quad centre relative to the judgement line (Three z). */
  depth: number;
  /** Lies on the ground plane (judgement frame, lane fill). */
  ground: boolean;
  /** Plane layer the corners are rectified for (EFFECT_PLANES index). */
  plane: number;
  /** On-screen extent of the quad in pixels at 1920x1080 (u and v edges, and area). */
  pixelWidth: number;
  pixelHeight: number;
  pixelArea: number;
}

/** Sonolus unit-space distance of one 1080p screen pixel, for a spawn rect of half width `size` lanes. */
export const unitsPerPixel = (size: number): { x: number; y: number } => ({
  x: ASPECT / (960 * STAGE_SX * size),
  y: 1 / (540 * Math.abs(STAGE_SY) * W_TO_H),
});

export interface ParticleSample extends QuadSample {
  system: number;
  emission_: number;
  seed: number;
  /** Unity draws used by sampleParticle; r1..r8 in Sonolus order. */
  draws: readonly number[];
  birth: number;
  /** Real-time lifetime in seconds. */
  lifetime: number;
}

export interface EffectTrace {
  particles: ParticleSample[];
  /** Mesh instances keyed `${name}#${quadIndex}` (deterministic across seeds). */
  meshes: Map<string, QuadSample[]>;
}

/** Unclipped lane surface; keep world positions paired with the original UVs. */
export interface LaneSurfaceSample {
  t: number;
  quad: NativeWorldQuad;
  file: string;
  emission: readonly [number, number, number];
}

/** Draw offsets used by the renderer's sampleParticle/shapePosition. */
const DRAW_OFFSETS = [3, 5, 7, 11, 17, 23, 29, 37] as const;

export interface TracerOptions {
  releaseRoot: string;
  currentQuality?: number;
  /** Selected MasterLiveNoteEffectSkin asset; quality remains independent. */
  noteEffectSkin?: "effect001" | "effect001Simple";
}

export class EffectTracer {
  readonly assets: OurNotesAssetManifest;
  /** alpha(sy) = alpha1 + slope * (sy - 1) of every plane layer. */
  readonly planes: PlaneTransform[];
  private readonly layer: ParticleLayer;
  private readonly camera = configureOurNotesCamera(new PerspectiveCamera(54, ASPECT, 0.1, 5000));
  private readonly projectionScaleY: number;
  private readonly releaseRoot: string;
  private readonly requireMaterialTint: boolean;
  private readonly simpleBillboards: boolean;

  constructor(options: TracerOptions) {
    this.releaseRoot = options.releaseRoot;
    this.requireMaterialTint = options.currentQuality === 2 && (options.noteEffectSkin ?? "effect001") === "effect001";
    this.simpleBillboards = options.noteEffectSkin === "effect001Simple";
    const map =
      (kind: "assets" | "runtime") =>
      (path: string): string => {
        const prefix = `/${kind}/__release_template__/`;
        const relative = path.startsWith(prefix) ? path.slice(prefix.length) : path.replace(/^\//, "");
        return resolve(options.releaseRoot, kind, relative.split("/").map(decodeURIComponent).join("/"));
      };
    this.assets = createOurNotesAssetManifest(
      {
        noteAtlasTextureUrl: "/unused",
        noteEffectSkin: options.noteEffectSkin ?? "effect001",
        currentQuality: options.currentQuality ?? 0,
        hud: {
          judgementImages: {},
          comboDigitUrls: [],
          perfectComboDigitUrls: [],
          lifeIconUrls: {},
          rankIconUrls: {},
        } as never,
      },
      { asset: map("assets"), runtime: map("runtime") },
    );
    this.layer = new ParticleLayer(new StageProjector(), this.assets, 4, 1024);
    this.camera.updateMatrixWorld(true);
    this.camera.updateProjectionMatrix();
    this.projectionScaleY = this.camera.projectionMatrix.elements[5]!;
    const judgement = new StageProjector().judgementZ;
    this.planes = EFFECT_PLANES.map((plane) =>
      this.planeAlpha(
        new Vector3(0, 0, judgement + plane.depth),
        plane.ground ? new Vector3(0, 1, 0) : new Vector3(0, 0, 1),
      ),
    );
  }

  async load(): Promise<void> {
    await this.layer.loadDefinitions(async (url) => JSON.parse(await readFile(url, "utf8")));
  }

  textureFile(key: TextureKey): string {
    if (key === "laneEffect") return this.assets.particles.laneEffects.normal.textureUrl;
    return this.assets.particles[TEXTURE_URL_FIELDS[key]];
  }

  async clipDuration(url: string): Promise<number> {
    const clip = readNativeAnimationClip(JSON.parse(await readFile(url, "utf8")));
    return clip?.duration ?? 0;
  }

  /** World point -> Sonolus unit space of a centred spawn rect with half width `size` lanes. */
  /**
   * World point -> rectified unit space of plane layer `plane`: the spawn
   * quad's corners are (lane ± size) * alpha(y), so dividing by alpha(y)
   * turns every face of that plane into its true rectangle.
   */
  private toUnit(point: Vector3, size: number, plane: number): UnitPoint & { px: number; py: number } {
    const projected = point.clone().project(this.camera);
    const stageX = (projected.x * ASPECT) / STAGE_SX;
    const stageY = (projected.y - STAGE_T) / STAGE_SY;
    const { alpha1, slope } = this.planes[plane]!;
    const alpha = alpha1 + slope * (stageY - 1);
    return { x: stageX / alpha / size, y: (1 - stageY) / W_TO_H - 1, px: projected.x * 960, py: projected.y * 540 };
  }

  private quadSample(
    quad: NativeWorldQuad,
    size: number,
    t: number,
    texture: TextureKey,
    color: { r: number; g: number; b: number; a: number },
    ground = false,
    forcedPlane?: number,
    materialTint?: Tint,
  ): QuadSample | undefined {
    const depth = quad.corners.reduce((sum, corner) => sum + corner.z, 0) / 4 - JUDGEMENT_Z;
    const plane = forcedPlane ?? planeIndex(depth, ground);
    // The lane fill's 70-unit ground quad reaches past the camera; projecting
    // behind-camera corners flips their screen coordinates and wrecks the
    // fitted rect. The native GPU clips at the near plane, so clip the world
    // polygon there first and fit the visible remainder.
    const clipped = quad.corners.some((corner) => corner.z > NEAR_CLIP_Z);
    const worldCorners = clipped ? clipNearPlane(quad.corners) : quad.corners;
    if (worldCorners.length < 3) return undefined;
    const projected = worldCorners.map((corner) => this.toUnit(corner, size, plane));
    const emission = materialEmission(texture, color, materialTint);
    const minX = Math.min(...projected.map((point) => point.x));
    const maxX = Math.max(...projected.map((point) => point.x));
    const minY = Math.min(...projected.map((point) => point.y));
    const maxY = Math.max(...projected.map((point) => point.y));
    const pixelLeft = Math.min(...projected.map((point) => point.px));
    const pixelRight = Math.max(...projected.map((point) => point.px));
    const pixelTop = Math.min(...projected.map((point) => point.py));
    const pixelBottom = Math.max(...projected.map((point) => point.py));
    // Keep the UV-ordered corners: a bounding box erases rotation, reflection,
    // and the projected aspect of narrow flick streaks. Near-clipped lane
    // polygons still use the existing visible-rectangle approximation.
    const corners: QuadSample["corners"] = clipped
      ? [
          { x: minX, y: minY },
          { x: maxX, y: minY },
          { x: maxX, y: maxY },
          { x: minX, y: maxY },
        ]
      : (projected.map(({ x, y }) => ({ x, y })) as QuadSample["corners"]);
    const edge = (a: number, b: number) =>
      Math.hypot(projected[b]!.px - projected[a]!.px, projected[b]!.py - projected[a]!.py);
    const area =
      Math.abs(
        projected.reduce((sum, point, index) => {
          const next = projected[(index + 1) % projected.length]!;
          return sum + point.px * next.py - next.px * point.py;
        }, 0),
      ) / 2;
    return {
      t,
      corners,
      texture,
      file: this.textureFile(texture),
      depth,
      ground,
      plane,
      uv: quad.uv,
      emission,
      ...(materialTint ? { materialTint } : {}),
      pixelWidth: clipped ? pixelRight - pixelLeft : (edge(0, 1) + edge(3, 2)) / 2,
      pixelHeight: clipped ? pixelBottom - pixelTop : (edge(0, 3) + edge(1, 2)) / 2,
      pixelArea: clipped ? (pixelRight - pixelLeft) * (pixelBottom - pixelTop) : area,
    };
  }

  /**
   * Trace one note effect of chart `width` at the stage centre over `times`
   * (real seconds since the judgement), for every seed.
   */
  trace(
    base: Omit<RenderParticleEffect, "id" | "age" | "lane" | "width" | "seed">,
    width: number,
    times: readonly number[],
    seeds: readonly number[],
  ): EffectTrace {
    const size = width / 4;
    const particles: ParticleSample[] = [];
    const meshes = new Map<string, QuadSample[]>();
    const births = new Map<string, number>();
    for (const [seedIndex, seed] of seeds.entries()) {
      let t = 0;
      const billboards: MaterialBillboardTrace[] = [];
      const meshTraces: MaterialMeshTrace[] = [];
      this.layer.setTraceSink({
        billboard: (entry) => billboards.push(entry),
        mesh: (entry) => meshTraces.push(entry),
      });
      for (const time of times) {
        t = time;
        billboards.length = 0;
        meshTraces.length = 0;
        this.layer.update([
          { ...base, id: `trace:${seed}`, age: time, lane: 12 - width / 2, width, seed } as RenderParticleEffect,
        ]);
        for (const entry of billboards) {
          if (this.requireMaterialTint && !entry.materialTint)
            throw new Error("Light billboard trace requires the per-instance material tint renderer contract");
          const slot = base.kind === "tap" ? "Normal" : base.kind === "slide-loop" ? "SlideLoop" : undefined;
          const ref = slot ? this.assets.particles.effect001Prefabs[slot]?.particleSystems[entry.system] : undefined;
          const style = this.simpleBillboards && ref ? simpleBillboardStyle(base.kind, ref.name) : undefined;
          const quad = style
            ? authoredBillboardQuad(
                entry,
                style,
                this.camera.position,
                this.camera.matrixWorldInverse,
                this.projectionScaleY,
              )
            : nativeBillboardQuad(entry, this.camera.position, this.camera.matrixWorldInverse, this.projectionScaleY);
          // Cohorts keep the existing judgement-plane layout. Horizontal
          // Simple quads are fitted within that same consumer plane contract.
          const sample = this.quadSample(
            quad,
            size,
            t,
            entry.texture as TextureKey,
            entry.color,
            false,
            0,
            entry.materialTint,
          );
          if (!sample) continue;
          const birth = t - entry.age / entry.simulationSpeed;
          // Animator loops reuse emission indices. A recycled index belongs
          // to a new birth, rather than the particle sampled during warm-up.
          const cycle = base.kind === "slide-loop" ? Math.round(birth * 1e5) : 0;
          const key = `${seed}:${entry.system}:${entry.emission}:${cycle}`;
          if (!births.has(key)) births.set(key, birth);
          particles.push({
            ...sample,
            system: entry.system,
            emission_: entry.emission,
            seed,
            draws: DRAW_OFFSETS.map((offset) => nativeParticleRandom(entry.particleSeed + offset)),
            birth: births.get(key)!,
            lifetime: entry.lifetime / entry.simulationSpeed,
          });
        }
        // Mesh rigs carry no randomness; seed 0 is enough.
        if (seedIndex > 0) continue;
        for (const entry of meshTraces) {
          if (this.requireMaterialTint && !entry.materialTint)
            throw new Error("Light mesh trace requires the per-instance material tint renderer contract");
          const quads = mergeMeshQuads(nativeMeshQuads(entry));
          const texture: TextureKey = entry.kind === "frame" ? "frame" : entry.kind === "wall" ? "wall" : "pillar";
          quads.forEach((quad, index) => {
            this.strips(quad).forEach((strip, stripIndex) => {
              const sample = this.quadSample(
                strip,
                size,
                t,
                texture,
                entry.color,
                entry.kind === "frame",
                undefined,
                entry.materialTint,
              );
              if (!sample) return;
              const key = `${entry.name}#${index}.${stripIndex}`;
              let list = meshes.get(key);
              if (!list) meshes.set(key, (list = []));
              list.push(sample);
            });
          });
        }
      }
    }
    this.layer.setTraceSink(undefined);
    this.layer.update(undefined);
    return { particles, meshes };
  }

  /**
   * Sonolus quads are parallelograms. A face that projects to a strong
   * trapezoid (wall sides receding towards the horizon) is split into strips
   * along its tapering axis so every strip stays nearly parallel.
   */
  private strips(quad: NativeWorldQuad): NativeWorldQuad[] {
    // A face containing the world x axis is an exact rectangle in its
    // rectified plane layer; only faces turned away from x need strips.
    const edgeU = quad.corners[1].clone().sub(quad.corners[0]);
    const edgeV = quad.corners[3].clone().sub(quad.corners[0]);
    const normal = edgeU.clone().cross(edgeV).normalize();
    if (Math.abs(normal.x) < 1e-3) return [quad];
    const screen = quad.corners.map((corner) => corner.clone().project(this.camera));
    const length = (a: Vector3, b: Vector3) => Math.hypot(b.x - a.x, (b.y - a.y) / ASPECT);
    const [s0, s1, s2, s3] = screen as [Vector3, Vector3, Vector3, Vector3];
    const uRatio = Math.max(length(s0, s1), length(s3, s2)) / Math.max(1e-9, Math.min(length(s0, s1), length(s3, s2)));
    const vRatio = Math.max(length(s0, s3), length(s1, s2)) / Math.max(1e-9, Math.min(length(s0, s3), length(s1, s2)));
    const ratio = Math.max(uRatio, vRatio);
    if (!(ratio > 1.12)) return [quad];
    const count = Math.min(10, Math.ceil(Math.log(Math.min(ratio, 64)) / Math.log(1.12)));
    const [c0, c1, c2, c3] = quad.corners;
    const [u0, v0, u1, v1] = quad.uv;
    const result: NativeWorldQuad[] = [];
    for (let index = 0; index < count; index += 1) {
      const a = index / count;
      const b = (index + 1) / count;
      if (uRatio >= vRatio) {
        // u-edges differ in length: the taper runs along v; cut across v.
        result.push({
          corners: [c0.clone().lerp(c3, a), c1.clone().lerp(c2, a), c1.clone().lerp(c2, b), c0.clone().lerp(c3, b)],
          uv: [u0, v0 + (v1 - v0) * a, u1, v0 + (v1 - v0) * b],
        });
      } else {
        result.push({
          corners: [c0.clone().lerp(c1, a), c0.clone().lerp(c1, b), c3.clone().lerp(c2, b), c3.clone().lerp(c2, a)],
          uv: [u0 + (u1 - u0) * a, v0, u0 + (u1 - u0) * b, v1],
        });
      }
    }
    return result;
  }

  /** Trace one lane fill (LiveLaneEffectView) of chart `width` at the stage centre. */
  traceLane(kind: RenderParticleEffect["kind"], width: number, times: readonly number[]): QuadSample[] {
    const size = width / 4;
    const samples: QuadSample[] = [];
    const meshTraces: NativeMeshTrace[] = [];
    this.layer.setTraceSink({ billboard: () => {}, mesh: (entry) => meshTraces.push(entry) });
    for (const time of times) {
      meshTraces.length = 0;
      this.layer.updateLaneInput([
        {
          id: "trace-lane",
          kind,
          direction: "none",
          judgement: "perfect",
          age: time,
          lane: 12 - width / 2,
          width,
          seed: 1,
        } as RenderParticleEffect,
      ]);
      for (const entry of meshTraces)
        for (const quad of nativeMeshQuads(entry)) {
          const sample = this.quadSample(quad, size, time, "laneEffect", entry.color, true);
          if (sample) samples.push(sample);
        }
    }
    this.layer.setTraceSink(undefined);
    this.layer.updateLaneInput(undefined);
    return samples;
  }

  /** Lane-only compiler input, before the old clipped bounding-rectangle fit. */
  traceLaneSurfaces(kind: RenderParticleEffect["kind"], width: number, times: readonly number[]): LaneSurfaceSample[] {
    const surfaces: LaneSurfaceSample[] = [];
    const meshes: NativeMeshTrace[] = [];
    this.layer.setTraceSink({ billboard: () => {}, mesh: (entry) => meshes.push(entry) });
    try {
      for (const t of times) {
        meshes.length = 0;
        this.layer.updateLaneInput([{ id: "lane-surface", kind, direction: "none", judgement: "perfect",
          age: t, lane: 12 - width / 2, width, seed: 1 } as RenderParticleEffect]);
        for (const mesh of meshes)
          for (const quad of nativeMeshQuads(mesh))
            surfaces.push({ t, quad, file: this.textureFile("laneEffect"), emission: materialEmission("laneEffect", mesh.color) });
      }
    } finally {
      this.layer.setTraceSink(undefined);
      this.layer.updateLaneInput(undefined);
    }
    return surfaces;
  }

  /** Original source UV -> ground-rectified particle units and real camera depth. */
  projectLaneUV(quad: NativeWorldQuad, u: number, v: number, size: number) {
    const nu = (u - quad.uv[0]) / (quad.uv[2] - quad.uv[0]);
    const nv = (v - quad.uv[1]) / (quad.uv[3] - quad.uv[1]);
    const point = quad.corners[0].clone().lerp(quad.corners[1], nu)
      .lerp(quad.corners[3].clone().lerp(quad.corners[2], nu), nv);
    const depth = -point.clone().applyMatrix4(this.camera.matrixWorldInverse).z;
    return { ...this.toUnit(point, size, 3), depth, near: this.camera.near };
  }

  dispose(): void {
    this.layer.dispose();
  }

  /** alpha(sy) of the plane through `point` with normal `normal` (Three world). */
  planeAlpha(point: Vector3, normal: Vector3): PlaneTransform {
    // Two points on the plane at different heights (or depths for the ground).
    const along = Math.abs(normal.y) > 0.5 ? new Vector3(0, 0, -1) : new Vector3(0, 1, 0);
    const sample = (offset: number): { sy: number; scale: number } => {
      const base = point.clone().addScaledVector(along, offset);
      const a = base.clone().project(this.camera);
      const b = base
        .clone()
        .add(new Vector3(1, 0, 0))
        .project(this.camera);
      return { sy: (a.y - STAGE_T) / STAGE_SY, scale: ((b.x - a.x) * ASPECT) / STAGE_SX };
    };
    const reference = (() => {
      const origin = new Vector3(0, 0, JUDGEMENT_Z);
      const a = origin.clone().project(this.camera);
      const b = origin
        .clone()
        .add(new Vector3(1, 0, 0))
        .project(this.camera);
      return ((b.x - a.x) * ASPECT) / STAGE_SX;
    })();
    const p0 = sample(0);
    const p1 = sample(1);
    const slope = (p1.scale - p0.scale) / (p1.sy - p0.sy) / reference;
    const alpha1 = p0.scale / reference + slope * (1 - p0.sy);
    return { alpha1, slope };
  }

  /** Relative release path helper for diagnostics. */
  relative(file: string): string {
    return file.startsWith(this.releaseRoot) ? file.slice(this.releaseRoot.length + 1) : file;
  }
}
