import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { constants, gunzipSync, gzipSync } from "node:zlib";
import {
  bakeRadianceFieldCarrierPair, bakeRadianceFieldTile, fitHdrCarrierSamples, packAtlas,
  partitionRadianceField, rasterizeCompositeRadiance, rasterizeProjectedRadiance,
  splitConstantTileColumns, trimTile, type CompositeQuad, type Tile,
} from "./bake.ts";
import { EffectTracer, effectPixelOrigin, unitsPerPixel, W_TO_H, type QuadSample } from "./trace.ts";
import { durationBeforeNextPhase, fitSourceAlphaTrajectory, type TrajectoryParticle } from "./trajectory.ts";
import { decodePng, encodeRgbaPng } from "./textureBake.ts";
import { repackParticleAtlas } from "./repack.ts";
import { NATIVE_EFFECT_WIDTHS } from "./compile.ts";
import { refreshNativeParticlePackReports } from "./packs.ts";
import type { ParticleData } from "./merge.ts";
import {
  nativeLoopEffectDuration, nativeNoteEffectDuration, NATIVE_SHORT_EFFECT_DURATION, NATIVE_SHORT_SLIDE_EFFECT,
} from "../../../../.dependencies/sonolus-our-notes/shared/src/engine/data/nativeEffects.ts";

type JsonRecord = Record<string, unknown>;
type ParticleGroup = { count: number; particles: TrajectoryParticle[] };
interface RigTarget {
  kind: "tap" | "flick" | "slide" | "connect" | "slide-loop";
  direction?: "left" | "right"; family?: string; width: number; name: string;
  judgement?: "perfect" | "great" | "good" | "bad";
  frameOnly?: boolean;
  playbackSeconds?: number;
}
interface RigProfile {
  key: string; quality: number; renderingScale: number; nativeFrameGroupCount?: number;
  noteEffectSkin?: "effect001" | "effect001Simple"; frameOnly?: boolean; maximumAtlasHeight?: number;
  unslicedFrameMaxWidth?: number;
  wallsOnly?: boolean;
  baselineDataSha256: string; baselineJsonSha256: string; baselineTextureSha256: string;
  baselineTextureRgbaSha256: string; baselineTextureSize: [number, number]; effects: RigTarget[];
}
interface RigRecipe {
  schema: string; atlasSide: number; referenceWidth: number; wallGroupCount: number;
  sourceRendererSha256: string; sourceAuthoredSha256: string;
  sourceSeed: number; profiles: RigProfile[];
}
type Mesh = { name: string; samples: QuadSample[] };
const hash = (bytes: Uint8Array, algorithm = "sha256") => createHash(algorithm).update(bytes).digest("hex");
const channel = (value: number) => ({ from: { c: value }, to: { c: value }, ease: "none" });
const identity = Object.fromEntries(["x1", "y1", "x2", "y2", "x3", "y3", "x4", "y4"].map((key) => [key, { [key]: 1 }]));
const span = (quads: CompositeQuad[]) => {
  const xs = quads.flatMap((quad) => quad.corners.map(([x]) => x));
  return Math.max(...xs) - Math.min(...xs);
};

/** Encode the wall's emitted light over the stage instead of tinting the stage black at its edges. */
function wallRadianceTile(tile: Tile): Tile {
  const background = [10, 22, 49];
  const pixels = tile.image.pixels.slice();
  for (let offset = 0; offset < pixels.length; offset += 4) {
    const alpha = pixels[offset + 3]! / 255;
    if (!alpha) continue;
    const light = background.map((value, channel) => Math.min(255 - value, pixels[offset + channel]! * alpha));
    const opacity = Math.ceil(255 * Math.max(...light.map((value, channel) => value / (255 - background[channel]!))));
    pixels[offset + 3] = opacity;
    if (!opacity) continue;
    // Coarser stored color in transparent texels changes their light by less than one displayed level.
    const step = Math.floor(255 / opacity);
    for (let channel = 0; channel < 3; channel++) {
      const color = background[channel]! + 255 * light[channel]! / opacity;
      pixels[offset + channel] = Math.min(255, Math.round(color / step) * step);
    }
  }
  return { ...tile, image: { ...tile.image, pixels } };
}

/** Produce dynamic material fields from the formal evaluator; projection and draw order remain separate. */
export async function buildSourceRigDelta(options: {
  destination: string; baseline: string; releaseRoot: string; proofFile?: string;
  runtimeFiles: { renderer: string; authored: string; contract: string };
} & ({ recipePath: string } | { recipe: RigRecipe })) {
  const recipeBytes = "recipePath" in options ? readFileSync(options.recipePath) : Buffer.from(JSON.stringify(options.recipe));
  const recipe: RigRecipe = "recipePath" in options ? JSON.parse(recipeBytes.toString()) : options.recipe;
  if (recipe.schema !== "our-notes-source-rigs-v1" || recipe.atlasSide !== 1024 || recipe.referenceWidth !== 8)
    throw new Error("Invalid Source rig recipe");
  if (hash(readFileSync(options.runtimeFiles.renderer)) !== recipe.sourceRendererSha256 ||
      hash(readFileSync(options.runtimeFiles.authored)) !== recipe.sourceAuthoredSha256)
    throw new Error("Source rig runtime changed");
  const contract = JSON.parse(readFileSync(options.runtimeFiles.contract, "utf8"));
  const manifest = JSON.parse(readFileSync(resolve(options.baseline, "particle-packs.json"), "utf8"));
  const sourceFiles = ["sourceRigs.ts", "bake.ts", "trace.ts", "trajectory.ts", "fit.ts", "repack.ts", "rectanglePacking.ts", "textureBake.ts", "../pack-original-note-skins.ts"];
  const sourceHashes = Object.fromEntries(sourceFiles.map((file) => [file, hash(readFileSync(resolve(import.meta.dirname, file)))]));
  const textureHashes = new Map<string, string>();
  const reports: JsonRecord[] = [];
  mkdirSync(options.destination, { recursive: true });
  for (const profile of recipe.profiles) {
    const input = resolve(options.baseline, "particles", profile.key);
    const bytes = readFileSync(resolve(input, "particle.data")), png = readFileSync(resolve(input, "particle.texture.png"));
    const json = gunzipSync(bytes);
    const image = decodePng(png, "Source rig baseline");
    if (hash(json) !== profile.baselineJsonSha256 || hash(image.pixels) !== profile.baselineTextureRgbaSha256 ||
        image.width !== profile.baselineTextureSize[0] || image.height !== profile.baselineTextureSize[1])
      throw new Error("Source rig baseline changed");
    const baseline = JSON.parse(json.toString()) as ParticleData;
    const tracer = new EffectTracer({ releaseRoot: options.releaseRoot, currentQuality: profile.quality, noteEffectSkin: profile.noteEffectSkin ?? "effect001" });
    await tracer.load();
    const tiles: Tile[] = [], tileIds = new Map<string, number>(), oldIds = new Map<number, number>();
    const register = (tile: Tile) => {
      const key = `${tile.image.width}:${tile.image.height}:${hash(tile.image.pixels)}`;
      const found = tileIds.get(key); if (found !== undefined) return found;
      const id = tiles.length; tiles.push(tile); tileIds.set(key, id); return id;
    };
    const copyGroup = (group: ParticleGroup) => ({ ...group, particles: group.particles.map((particle) => {
      let sprite = oldIds.get(particle.sprite);
      if (sprite === undefined) {
        const old = baseline.sprites[particle.sprite]!, pixels = new Uint8Array(old.w * old.h * 4);
        for (let y = 0; y < old.h; y++) pixels.set(image.pixels.subarray(
          ((old.y + y) * image.width + old.x) * 4, ((old.y + y) * image.width + old.x + old.w) * 4), y * old.w * 4);
        sprite = register({ key: "baseline", image: { width: old.w, height: old.h, pixels },
          expand: [1, 1], offset: [0, 0], response: new Float32Array(9).fill(1) });
        oldIds.set(particle.sprite, sprite);
      }
      return { ...particle, sprite };
    }) });
    const cases = new Map<string, Mesh[]>(), durations = new Map<string, number>(), loopPeriods = new Map<string, number>();
    const frameMaximums = new Map<string, [number, number, number]>();
    const frameMaterials = new Map<string, [number, number, number]>();
    for (const target of profile.effects) {
      const familyKey = target.family ?? target.kind;
      const slot = target.kind === "flick" && target.direction === "left" ? "Left" : target.kind === "flick" && target.direction === "right" ? "Right" : ({ tap: "Normal", flick: "Flick", slide: "Slide", connect: "Connect", "slide-loop": "SlideLoop" } as Record<string, string>)[target.kind];
      const prefab = tracer.assets.particles.effect001Prefabs[slot as "Normal"];
      if (!prefab) throw new Error("Missing Source rig prefab");
      const judgement = target.judgement ?? "perfect";
      const clip = target.playbackSeconds ?? (target.kind === "slide-loop"
        ? contract.nativeEffects.timings.loopParticles[2]
        : await tracer.clipDuration(prefab.animationClipUrls?.[judgement] ?? prefab.animationClipUrl));
      durations.set(familyKey, clip);
      if (target.kind === "slide-loop") loopPeriods.set(familyKey, await tracer.clipDuration(prefab.animationClipUrl));
      const result = tracer.trace({ kind: target.kind, direction: target.direction ?? "none", judgement, lifetime: clip, ...(target.kind === "slide-loop" ? { loop: true } : {}) },
        target.width, Array.from({ length: Math.ceil(clip * 60) + 1 }, (_, index) => index / 60), [recipe.sourceSeed], { particle: () => false });
      // Judgements share one frame texture; their material clocks remain separate.
      const materialKey = `${slot} W${target.width}`;
      let maximum = frameMaximums.get(materialKey);
      if (!maximum) frameMaximums.set(materialKey, maximum = [0, 0, 0]);
      for (const mesh of result.meshes.values()) for (const sample of mesh) {
        if (sample.texture !== "frame") continue;
        for (let c = 0; c < 3; c++) maximum[c] = Math.max(maximum[c]!, sample.emission[c]!);
      }
      frameMaterials.set(`${familyKey} W${target.width}`, maximum);
      cases.set(`${familyKey}:${target.width}`, [...result.meshes].map(([name, samples]) => ({ name, samples })));
    }
    const family = (kind: string, width: number, name: string, plane: number) => {
      const meshes = cases.get(`${kind}:${width}`)!.filter((mesh) =>
        mesh.name.startsWith(name + "#") && (profile.wallsOnly || mesh.samples[0]!.plane === plane));
      if (!meshes.length) throw new Error("Source rig family missing");
      const envelope = meshes[0]!.samples, units = unitsPerPixel(width / 4), p = contract.nativeEffects.planes[plane];
      for (const mesh of meshes) for (const [index, sample] of mesh.samples.entries()) {
        if (JSON.stringify(sample.emission) !== JSON.stringify(envelope[index]?.emission)) throw new Error("Source rig materials need distinct clocks");
        const first = mesh.samples[0]!;
        if (!textureHashes.has(first.file)) textureHashes.set(first.file, hash(readFileSync(first.file)));
        for (const key of ["corners", "inverseDepths", "uv"] as const)
          if (JSON.stringify(sample[key]) !== JSON.stringify(first[key])) throw new Error("Source rig geometry is animated");
      }
      const quads: CompositeQuad[] = meshes.map(({ samples }) => {
        const sample = samples[0]!;
        const sourcePlane = contract.nativeEffects.planes[sample.plane];
        const alpha = (projection: typeof p, y: number) => projection.alpha1 - projection.slope * W_TO_H * (1 + y);
        return { file: sample.file, uv: sample.uv, emission: [1, 1, 1],
          corners: sample.corners.map(({ x, y }) => [x * (sample.plane === plane ? 1 : alpha(sourcePlane, y) / alpha(p, y)) / units.x, y / units.y]),
          projection: { originX: 0, originY: 0, alphaOrigin: p.alpha1 - p.slope * W_TO_H,
            alphaSlope: -p.slope * W_TO_H * units.y, inverseDepths: sample.inverseDepths! } };
      });
      const death = Math.min(durations.get(kind)!, envelope.at(-1)!.t + 1 / 60);
      const clock = death > envelope.at(-1)!.t ? [...envelope, { ...envelope.at(-1)!, t: death, emission: [0, 0, 0] as const }] : envelope;
      return { envelope: clock, units, quads, faces: meshes.length };
    };
    const build = (kind: string, width: number, name: "frame" | "wall", plane: number) => {
      const source = family(kind, width, name, plane), { envelope, units } = source, clip = durations.get(kind)!;
      const maximum = name === "frame" ? frameMaterials.get(`${kind} W${width}`)!
        : [0, 1, 2].map((c) => Math.max(...envelope.map((sample) => sample.emission[c]!))) as [number, number, number];
      const sourceDensity = profile.renderingScale * (name === "frame" ? 1 : profile.wallsOnly ? .375 : .5);
      const nativeDensity = name === "frame" ? 1 : profile.wallsOnly ? profile.renderingScale < 1 ? .16 : .18 : .25;
      const nearBloom = name === "frame" ? 1 : 0;
      const field = rasterizeProjectedRadiance(source.quads, sourceDensity, nativeDensity, effectPixelOrigin(), nearBloom * 3);
      const visiblePixels = name === "frame" ? bakeRadianceFieldTile("frame-visibility", field, maximum, nearBloom, nearBloom).image.pixels : undefined;
      const parts = profile.wallsOnly ? [field] : partitionRadianceField(field, visiblePixels);
      const groups: ParticleGroup[] = [];
      const emissionAt = (q: number): [number, number, number] => {
        const time = q * clip; if (time < envelope[0]!.t) return [0, 0, 0];
        let a = envelope[0]!;
        for (const b of envelope) {
          if (b.t >= time) { const f = b.t === a.t ? 0 : (time - a.t) / (b.t - a.t); return a.emission.map((v, c) => v * (1 - f) + b.emission[c]! * f) as [number, number, number]; }
          a = b;
        }
        return a.emission.map((value) => value * Math.max(0, 1 - (time - a.t) / (clip - a.t))) as [number, number, number];
      };
      const gainAt = (q: number) => Math.max(...emissionAt(q).map((v, c) => v / Math.max(1e-12, maximum[c]!)));
      const sampleByGain = name === "frame" || (profile.wallsOnly && profile.key === "simple" && loopPeriods.has(kind));
      const alphaKnots = new Set([0, 1, ...envelope.map((sample) => sample.t / clip)]);
      if (name === "frame") {
        const envelopeKnots = [...alphaKnots].sort((a, b) => a - b);
        for (let i = 1; i < envelopeKnots.length; i++) {
          const a = envelopeKnots[i - 1]!, b = envelopeKnots[i]!;
          const low = emissionAt(a).map((v, c) => v / Math.max(1e-12, maximum[c]!));
          const high = emissionAt(b).map((v, c) => v / Math.max(1e-12, maximum[c]!));
          for (let c = 0; c < 3; c++) for (let d = c + 1; d < 3; d++) {
            const u = low[c]! - low[d]!, v = high[c]! - high[d]!;
            const q = u / (u - v);
            if (q > 0 && q < 1) alphaKnots.add(a + (b - a) * q);
          }
        }
        const gainKnots = [...alphaKnots].sort((a, b) => a - b);
        for (let i = 1; i < gainKnots.length; i++) {
          const a = gainKnots[i - 1]!, b = gainKnots[i]!, low = gainAt(a), high = gainAt(b);
          for (let step = 0; step <= 96; step++) {
            const q = (step / 96 - low) / (high - low);
            if (q > 0 && q < 1) alphaKnots.add(a + (b - a) * q);
          }
        }
      }
      for (const [partIndex, part] of parts.entries()) {
        const sourcePair = bakeRadianceFieldCarrierPair(`${profile.key}|${kind}|${name}|${plane}|${partIndex}`, part, maximum, nearBloom, nearBloom);
        const singlePeak = name === "wall" && (plane === 0 || profile.wallsOnly) && sourcePair.core !== undefined;
        const pair = singlePeak ? { critical: 1, body: sourcePair.peak, peak: sourcePair.peak } : sourcePair;
        const responses = fitHdrCarrierSamples(pair, (q) => bakeRadianceFieldTile("clock", part,
          sampleByGain ? maximum.map((v) => v * q) as [number, number, number] : emissionAt(q), nearBloom, nearBloom).image.pixels,
        profile.wallsOnly ? 24 : 96, sampleByGain ? (q) => q : gainAt, name === "frame");
        const responseAt = (time: number) => {
          const steps = responses.length - 1;
          const q = Math.max(0, Math.min(1, sampleByGain ? gainAt(time) : time));
          const i = Math.min(steps - 1, Math.floor(q * steps)), f = q * steps - i;
          const a = responses[i]!, b = responses[i + 1]!;
          return { bodyAlpha: a.bodyAlpha * (1 - f) + b.bodyAlpha * f, coreAlpha: a.coreAlpha * (1 - f) + b.coreAlpha * f,
            coreTint: a.coreTint.map((v, c) => v * (1 - f) + b.coreTint[c]! * f) as [number, number, number] };
        };
        const program: TrajectoryParticle[] = [];
        for (const [layer, original] of [[0, pair.body], [1, pair.core]] as const) if (original) {
          const tile = trimTile(profile.wallsOnly ? wallRadianceTile(original) : original), sprite = 0;
          const r = part.rect, w = (r.x1 - r.x0) / 2 * units.x, h = (r.y1 - r.y0) / 2 * units.y;
          const motion = [{ sprite, color: "#ffffff", start: envelope[0]!.t / clip, duration: 1 - envelope[0]!.t / clip,
            x: channel((r.x0 + r.x1) / 2 * units.x + 2 * w * tile.offset[0]),
            y: channel((r.y0 + r.y1) / 2 * units.y + 2 * h * tile.offset[1]),
            w: channel(w * tile.expand[0]), h: channel(h * tile.expand[1]), r: channel(0), a: channel(1) }] as TrajectoryParticle[];
          const tintScale = [0, 1, 2].map((c) => {
            let peak = 0; for (let pixel = 0; pixel < original.image.pixels.length; pixel += 4)
              peak = Math.max(peak, original.image.pixels[pixel + c]! * original.image.pixels[pixel + 3]! / 65025);
            return peak;
          }) as [number, number, number];
          const period = loopPeriods.get(kind);
          const breakpoints = period ? Array.from({ length: Math.round(clip / period) - 1 }, (_, index) => (index + 1) * period / clip) : [];
          const clockKnots = [...envelope.map((sample) => sample.t / clip), 1].filter((time) => !breakpoints.some((boundary) => Math.abs(time - boundary) < 1e-6));
          const zeroKnots = envelope.filter((sample, index) =>
              sample.emission.every((value) => value === 0) &&
              (envelope[index - 1]?.emission.some((value) => value > 0) || envelope[index + 1]?.emission.some((value) => value > 0)))
              .map((sample) => sample.t / clip);
          const fitted = fitSourceAlphaTrajectory(motion, { breakpoints, alpha: (q) => layer ? responseAt(q).coreAlpha : responseAt(q).bodyAlpha,
            ...(layer && name !== "frame" ? { tint: (q: number) => responseAt(q).coreTint, tintScale, maxTintError: .025 } : {}),
            knots: [...clockKnots, ...breakpoints], zeroKnots, projects: [(x, y) => [x, y]],
            maxPixelError: .2, maxAlphaError: name === "frame" ? .02 : 1 / 255, sprite,
            ...(name === "frame" ? { fitMetric: "max" as const, alphaKnots: [...alphaKnots] } : {}) });
          for (const [index, particle] of fitted.particles.entries()) {
            const next = fitted.particles[index + 1];
            let duration = particle.duration;
            if (next && Math.abs(particle.start + particle.duration - next.start) < 1e-6) {
              if (name === "frame" || singlePeak) {
                duration = durationBeforeNextPhase(particle.start, next.start);
              } else duration = Math.max(0, next.start - particle.start - 1e-6);
            }
            for (const zero of zeroKnots) if (zero > particle.start && Math.abs(particle.start + duration - zero) < 1e-7)
              duration = Math.min(duration, durationBeforeNextPhase(particle.start, zero));
            const fieldTile = { ...tile, expand: [1, 1] as [number, number], offset: [0, 0] as [number, number] };
            const pieces = (profile.wallsOnly && width < 12) || (name === "frame" && width <= (profile.unslicedFrameMaxWidth ?? 0))
              ? [fieldTile]
              : splitConstantTileColumns(fieldTile);
            for (const piece of pieces) {
              program.push({ ...particle, duration, sprite: register(piece),
                x: channel(motion[0]!.x.from.c! + 2 * motion[0]!.w.from.c! * piece.offset[0]),
                w: channel(motion[0]!.w.from.c! * piece.expand[0]) });
            }
          }
          reports.push({ profile: profile.key, kind, width, name, plane, partIndex, layer, clipSeconds: clip,
            definitions: fitted.particles.length,
            ...(singlePeak ? { materialStrategy: "single-source-peak-ls", maximumResponseRms: Math.max(...responses.map((sample) => sample.rms)) } : {}),
            fitMetric: name === "frame" ? "max" : "rms", sourceDensity, nativeDensity,
            maxAlphaError: fitted.maxAlphaError, maxTintError: fitted.maxTintError,
            ...(name === "frame" ? { fixedCoreTint: true, maxSourceRgbError: [0, 1, 2].map((c) => Math.max(...responses.map((r) => r.maxRgbError?.[c] ?? 0))) } : {}) });
        }
        groups.push({ count: 1, particles: program });
      }
      const groupCount = name === "frame" ? profile.nativeFrameGroupCount ?? groups.length : groups.length;
      if (groups.length > groupCount) {
        const horizontal = groups.splice(0, groups.length - groupCount + 1);
        groups.unshift({ count: 1, particles: horizontal.flatMap((group) => group.particles) });
      }
      return { groups, source };
    };
    const replacements = new Map<string, ParticleGroup[]>(), backgrounds: ParticleData["effects"] = [];
    if (profile.wallsOnly) for (const target of profile.effects) {
      replacements.set(`${target.name} P1`, build(target.family ?? target.kind, target.width, "wall", 1).groups);
    }
    for (const kind of profile.wallsOnly ? [] : [...new Set(profile.effects.map((target) => target.family ?? target.kind))]) {
      const targets = profile.effects.filter((target) => (target.family ?? target.kind) === kind);
      const frameOnly = profile.frameOnly || targets.every((target) => target.frameOnly);
      const reference = frameOnly ? [] : [0, 1].map((plane) => build(kind, recipe.referenceWidth, "wall", plane));
      for (const target of targets) {
        replacements.set(`${target.name} P3`, build(kind, target.width, "frame", 3).groups);
        for (const plane of frameOnly ? [] : [0, 1]) {
          const own = family(kind, target.width, "wall", plane), ref = reference[plane]!, ratio = span(ref.source.quads) / span(own.quads);
          if (JSON.stringify(own.envelope.map(({ t, emission }) => [t, emission])) !==
              JSON.stringify(ref.source.envelope.map(({ t, emission }) => [t, emission])))
            throw new Error("Source wall width requires a distinct material clock");
          const normalized = own.quads.map((quad) => ({ ...quad, corners: quad.corners.map(([x, y]) => [x * ratio, y] as [number, number]) }));
          const a = rasterizeCompositeRadiance(ref.source.quads, .2), b = rasterizeCompositeRadiance(normalized, .2);
          if (a.width !== b.width || a.height !== b.height || a.emission.some((v, i) => Math.abs(v - b.emission[i]!) > 1e-5))
            throw new Error("Source wall width requires a distinct material field");
          const scale = own.units.x / ref.source.units.x / ratio;
          const groups = ref.groups.map((group) => ({ ...group, particles: group.particles.map((particle) => ({ ...particle,
            x: channel(particle.x.from.c! * scale), w: channel(particle.w.from.c! * scale),
          })) }));
          if (!plane) backgrounds.push({ name: `${target.name} B0`, transform: identity, groups });
          else replacements.set(`${target.name} P1`, groups);
        }
      }
    }
    const effects = baseline.effects.map((effect) => {
      const replacement = replacements.get(effect.name as string);
      const groups = effect.groups as ParticleGroup[];
      return { ...effect, groups: replacement ? String(effect.name).endsWith(" P1")
        ? [...replacement, ...groups.slice(profile.wallsOnly ? wallGroupCount(groups) : recipe.wallGroupCount).map(copyGroup)]
        : replacement : groups.map(copyGroup) };
    });
    const atlas = packAtlas(tiles), packed = repackParticleAtlas({ ...baseline, width: atlas.width, height: atlas.height,
      sprites: atlas.sprites, effects: [...effects, ...backgrounds] } as ParticleData, atlas.png, recipe.atlasSide,
    { denseSearch: true, factorConstantTint: !profile.wallsOnly, decode: decodePng, maximumHeight: profile.maximumAtlasHeight ?? recipe.atlasSide });
    const output = resolve(options.destination, "particles", profile.key); mkdirSync(output, { recursive: true });
    const data = gzipSync(JSON.stringify(packed.data), { level: 9, ...(profile.wallsOnly ? { strategy: constants.Z_FILTERED } : {}) });
    const filtered = profile.wallsOnly ? encodeRgbaPng(decodePng(packed.png, "Source wall atlas"), true) : packed.png;
    const texture = filtered.length < packed.png.length ? filtered : packed.png;
    writeFileSync(resolve(output, "particle.data"), data); writeFileSync(resolve(output, "particle.texture.png"), texture);
    const pack = JSON.parse(readFileSync(resolve(input, "particle-pack-report.json"), "utf8"));
    pack.effects = packed.data.effects.length;
    pack.groups = packed.data.effects.reduce((n, effect) => n + (effect.groups as ParticleGroup[]).length, 0);
    pack.instances = packed.data.effects.reduce((n, effect) => n + (effect.groups as ParticleGroup[]).reduce((m, group) => m + group.count, 0), 0);
    pack.definitions = packed.data.effects.reduce((n, effect) => n + (effect.groups as ParticleGroup[]).reduce((m, group) => m + group.count * group.particles.length, 0), 0);
    pack.atlas = { width: packed.data.width, height: packed.data.height, sprites: packed.data.sprites.length };
    pack.artifacts = { data: { bytes: data.length, sha1: hash(data, "sha1") }, texture: { bytes: texture.length, sha1: hash(texture, "sha1") } };
    writeFileSync(resolve(output, "particle-pack-report.json"), JSON.stringify(pack, null, 2));
    manifest.packs = manifest.packs.map((item: { key: string }) => item.key === profile.key ? pack : item);
    tracer.dispose();
  }
  const simple = resolve(options.destination, "particles/simple"); mkdirSync(simple, { recursive: true });
  if (options.baseline !== options.destination && !recipe.profiles.some((profile) => profile.key === "simple"))
    for (const file of ["particle.data", "particle.texture.png", "particle-pack-report.json"])
    copyFileSync(resolve(options.baseline, "particles/simple", file), resolve(simple, file));
  writeFileSync(resolve(options.destination, "particle-packs.json"), JSON.stringify(manifest, null, 2));
  for (const [file, expected] of Object.entries(sourceHashes))
    if (hash(readFileSync(resolve(import.meta.dirname, file))) !== expected) throw new Error("Source rig producer changed during generation");
  writeFileSync(resolve(options.destination, options.proofFile ?? "source-rigs-proof.json"), JSON.stringify({ schema: recipe.schema,
    recipeSha256: hash(recipeBytes), sourceRendererSha256: recipe.sourceRendererSha256,
    sourceHashes, textureHashes: Object.fromEntries(textureHashes), reports }, null, 2));
}

function wallGroupCount(groups: ParticleGroup[]): number {
  const [left, middle, right] = groups.map(({ particles }) => particles[0]);
  if ((left?.w.from?.c ?? 0) > 0.55) return 1;
  if ((middle?.w.from?.c ?? 0) > 0.55 && Math.abs((left?.x.from?.c ?? 0) - (right?.x.from?.c ?? 0)) > 1)
    return 3;
  throw new Error("Cannot identify the baseline wall groups");
}

function sourceRigRuntimeFiles() {
  return {
    renderer: fileURLToPath(import.meta.resolve("@haneoka/cassiopeia-renderer-three")),
    authored: fileURLToPath(import.meta.resolve("@haneoka/cassiopeia-plugin-our-notes/authored")),
    contract: fileURLToPath(import.meta.resolve("@haneoka/sonolus-our-notes/contract/native-effects.json")),
  };
}

const wallNotes = {
  Normal: { kind: "tap", operateType: 10 },
  Slide: { kind: "slide", operateType: 20 },
  Connect: { kind: "connect", operateType: 61 },
  Flick: { kind: "flick", operateType: 40 },
  "Flick Left": { kind: "flick", operateType: 41, direction: "left" },
  "Flick Right": { kind: "flick", operateType: 42, direction: "right" },
  "Slide Loop": { kind: "slide-loop", operateType: 0 },
} as const;
const wallJudgements = { perfect: 5, great: 4, good: 3, bad: 2 } as const;

/** Project the source wall faces and fit their authored material for each Sonolus profile. */
export async function buildNativeNoteWalls(
  directory: string,
  releaseRoot: string,
  profiles: readonly ("standard" | "light" | "simple")[] = ["standard", "light", "simple"],
) {
  const runtimeFiles = sourceRigRuntimeFiles();
  const builtProfiles: RigProfile[] = profiles.map((key) => {
    const input = resolve(directory, "particles", key);
    const bytes = readFileSync(resolve(input, "particle.data"));
    const texture = readFileSync(resolve(input, "particle.texture.png"));
    const json = gunzipSync(bytes);
    const data = JSON.parse(json.toString()) as ParticleData;
    const image = decodePng(texture, "Source wall baseline");
    const profile = key === "simple" ? 2 : 1;
    const effects = data.effects.flatMap(({ name }): RigTarget[] => {
      const match = /^Our Notes Native (Normal|Slide Loop|Slide|Connect|Flick Left|Flick Right|Flick)(?: (Great|Good|Bad|Short))? W(\d+) P1$/u.exec(String(name));
      if (!match) return [];
      const [, label, grade, width] = match;
      const { kind, operateType, ...direction } = wallNotes[label as keyof typeof wallNotes];
      const judgement = grade && grade !== "Short" ? grade.toLowerCase() as keyof typeof wallJudgements : "perfect";
      const playbackSeconds = kind === "slide-loop" ? nativeLoopEffectDuration(profile)
        : grade === "Short" ? key === "simple" ? NATIVE_SHORT_EFFECT_DURATION : NATIVE_SHORT_SLIDE_EFFECT.duration
        : nativeNoteEffectDuration(profile, operateType, wallJudgements[judgement]);
      return [{ kind, ...direction, judgement, playbackSeconds, width: Number(width),
        name: String(name).slice(0, -3), family: `${label}-${grade ?? "perfect"}` }];
    });
    return {
      key,
      quality: key === "light" ? 2 : 0,
      renderingScale: key === "light" ? 0.71 : 1,
      noteEffectSkin: key === "simple" ? "effect001Simple" : "effect001",
      wallsOnly: true,
      maximumAtlasHeight: key === "light" ? 1984 : 1792,
      baselineDataSha256: hash(bytes),
      baselineJsonSha256: hash(json),
      baselineTextureSha256: hash(texture),
      baselineTextureRgbaSha256: hash(image.pixels),
      baselineTextureSize: [image.width, image.height],
      effects,
    };
  });
  await buildSourceRigDelta({
    baseline: directory, destination: directory, releaseRoot, runtimeFiles, proofFile: "source-wall-materials-proof.json",
    recipe: {
      schema: "our-notes-source-rigs-v1", atlasSide: 1024, referenceWidth: 8, wallGroupCount: 3, sourceSeed: 4660,
      sourceRendererSha256: hash(readFileSync(runtimeFiles.renderer)),
      sourceAuthoredSha256: hash(readFileSync(runtimeFiles.authored)),
      profiles: builtProfiles,
    },
  });
}

// Least-squares fit of the rendered frame against the original material at
// W4/W6/W12/W24 and 384/1280 pixels. Each viewport contributes per unit area.
const SIMPLE_BAD_TAP_OPACITY = 0.6214134384024382;
const SIMPLE_BAD_SLIDE_OPACITY = 0.6393760811745367;
const SIMPLE_GOOD_OPACITY = 0.85;

async function buildSimpleSourceFrames(
  directory: string,
  releaseRoot: string,
  effects: RigTarget[],
  options: Pick<RigProfile, "maximumAtlasHeight" | "unslicedFrameMaxWidth"> & { proofFile: string },
) {
  const pack = resolve(directory, "particles/simple");
  const data = readFileSync(resolve(pack, "particle.data"));
  const texture = readFileSync(resolve(pack, "particle.texture.png"));
  const image = decodePng(texture, "Simple frame baseline");
  const runtimeFiles = sourceRigRuntimeFiles();
  await buildSourceRigDelta({
    baseline: directory,
    destination: directory,
    releaseRoot,
    proofFile: options.proofFile,
    runtimeFiles,
    recipe: {
      schema: "our-notes-source-rigs-v1",
      atlasSide: 1024,
      referenceWidth: 8,
      wallGroupCount: 3,
      sourceSeed: 4660,
      sourceRendererSha256: hash(readFileSync(runtimeFiles.renderer)),
      sourceAuthoredSha256: hash(readFileSync(runtimeFiles.authored)),
      profiles: [{
        key: "simple",
        quality: 0,
        renderingScale: 1,
        noteEffectSkin: "effect001Simple",
        frameOnly: true,
        ...(options.unslicedFrameMaxWidth ? { unslicedFrameMaxWidth: options.unslicedFrameMaxWidth } : {}),
        nativeFrameGroupCount: 3,
        ...(options.maximumAtlasHeight ? { maximumAtlasHeight: options.maximumAtlasHeight } : {}),
        baselineDataSha256: hash(data),
        baselineJsonSha256: hash(gunzipSync(data)),
        baselineTextureSha256: hash(texture),
        baselineTextureRgbaSha256: hash(image.pixels),
        baselineTextureSize: [image.width, image.height],
        effects,
      }],
    },
  });
}

/** Fit ordinary and slide frames against their judgement-specific materials. */
export async function buildSimpleJudgementFrames(directory: string, releaseRoot: string, judgement: "good" | "bad") {
  const label = judgement === "good" ? "Good" : "Bad";
  const effects = ([
    ["tap", "Normal"],
    ["slide", "Slide"],
    ["connect", "Connect"],
  ] as const).flatMap(([kind, name]) =>
    NATIVE_EFFECT_WIDTHS.map((width): RigTarget => ({
      kind,
      width,
      name: `Our Notes Native ${name} ${label} W${width}`,
      judgement,
    })),
  );
  await buildSimpleSourceFrames(directory, releaseRoot, effects, {
    proofFile: `source-simple-${judgement}-frames-proof.json`,
    ...(judgement === "good" ? { unslicedFrameMaxWidth: 8 } : {}),
    maximumAtlasHeight: judgement === "good" ? 1248 : 1152,
  });
  const dataFile = resolve(directory, "particles/simple/particle.data");
  const built = JSON.parse(gunzipSync(readFileSync(dataFile)).toString()) as ParticleData;
  const opacity = new Map<string, number>();
  for (const effect of effects) {
    const frameOpacity = judgement === "good" ? SIMPLE_GOOD_OPACITY
      : effect.kind === "tap" ? SIMPLE_BAD_TAP_OPACITY : SIMPLE_BAD_SLIDE_OPACITY;
    opacity.set(`${effect.name} P3`, frameOpacity);
    if (judgement === "good") opacity.set(`${effect.name} P1`, SIMPLE_GOOD_OPACITY);
  }
  for (const effect of built.effects) {
    const gain = opacity.get(String(effect.name));
    if (gain === undefined) continue;
    for (const group of effect.groups as ParticleGroup[]) {
      for (const particle of group.particles) {
        for (const endpoint of [particle.a.from, particle.a.to]) {
          for (const [coefficient, value] of Object.entries(endpoint)) {
            endpoint[coefficient] = Math.fround(value * gain);
          }
        }
      }
    }
  }
  writeFileSync(dataFile, gzipSync(JSON.stringify(built), { level: 9 }));
  refreshNativeParticlePackReports(directory);
}

/** Match the thin Simple right-flick frame for widths that fit without horizontal slices. */
export async function buildSimpleRightFlickFrames(directory: string, releaseRoot: string) {
  const effects = NATIVE_EFFECT_WIDTHS.filter((width) => width <= 8).flatMap((width) =>
    [false, true].map((short): RigTarget => ({
      kind: "flick",
      direction: "right",
      width,
      name: `Our Notes Native Flick Right${short ? " Short" : ""} W${width}`,
      judgement: "perfect",
      family: short ? "right-short" : "right",
      playbackSeconds: short ? NATIVE_SHORT_EFFECT_DURATION : nativeNoteEffectDuration(2, 42, 5),
    })),
  );
  await buildSimpleSourceFrames(directory, releaseRoot, effects, {
    proofFile: "source-simple-right-flick-frames-proof.json",
    unslicedFrameMaxWidth: 8,
    maximumAtlasHeight: 1792,
  });
}
