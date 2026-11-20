#!/usr/bin/env node
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { compileNativeParticles, motionFitReport, NATIVE_EFFECT_PROFILES, NATIVE_EFFECT_PLANES } from "./native-particles/compile.ts";
import { mergeParticleGroupDelta } from "./native-particles/groupDelta.ts";
import { repackParticleAtlas } from "./native-particles/repack.ts";
import { decodeRgba8Png } from "./pack-original-note-skins.ts";
import type { ParticleData } from "./native-particles/merge.ts";
import { EffectTracer, effectPixelOrigin, unitsPerPixel, W_TO_H, type ParticleSample } from "./native-particles/trace.ts";
import { sourceParticleFamily } from "./native-particles/budget.ts";
import { durationBeforeNextPhase, type TrajectoryParticle } from "./native-particles/trajectory.ts";
import { bakeRadianceFieldTile, downsamplePremultipliedTile, packAtlas, rasterizeProjectedRadiance, textureCoverage, trimTile, type CompositeQuad, type Tile } from "./native-particles/bake.ts";
import { NATIVE_EARLY_POINT_EFFECT, nativeEarlyPointEffectTable } from "../../../.dependencies/sonolus-our-notes/shared/src/engine/data/nativeEffects.ts";

type JsonRecord = Record<string, unknown>;
type Group = { count: number; particles: TrajectoryParticle[] };
type PointPatch = JsonRecord & { members: Array<{ system: number; emission: number }> };
type ActorWindow = {
  time: number; start: number; end: number; energy: number; coreEnergy?: number;
  sparseCoverage?: boolean; worldSize: ParticleSample["worldSize"]; emission: ParticleSample["emission"];
};
type ActorProof = { system: number; emission: number; birth: number; lifetime: number; available: number; windows: ActorWindow[] };
type Provenance = { effect: string; width: number; plane: number; sourceFamily: string };
interface Window {
  sample: ParticleSample;
  start: number;
  end: number;
  energy: number;
  coreEnergy: number;
  centre: [number, number];
  velocity: [number, number];
  bounds: [number, number, number, number];
}
const sha = (bytes: Uint8Array, algorithm = "sha256") => createHash(algorithm).update(bytes).digest("hex");
const clip = Math.fround(5 / 12);
const frameRate = 60;
const maximumWindows = 4;
const maximumMembers = 4;
const patchSide = 64;
const channel = (a: number, b = a) => ({ from: { c: Math.round(a * 1e6) / 1e6 }, to: { c: Math.round(b * 1e6) / 1e6 }, ease: "linear" });

/** Keep the original draw order; mutually exclusive early/late point windows share a power-of-two clock. */
export function retireEarlyPointPhases(data: ParticleData, rebuiltEffects: readonly string[]): JsonRecord[] {
  const names = new Set(Object.values(nativeEarlyPointEffectTable())), ratio = NATIVE_EARLY_POINT_EFFECT.durationRatio;
  const selected = new Set(rebuiltEffects), replacedAliases = new Set(rebuiltEffects.map(name => `${name} Early`));
  const aliases: ParticleData["effects"] = [], report: JsonRecord[] = [];
  for (const effect of data.effects) {
    const alias = `${effect.name} Early`;
    if (!selected.has(String(effect.name)) || !names.has(alias)) continue;
    const groups = effect.groups as Group[], points = groups[0]!;
    if (groups.some(g => g.count !== 1 || g.particles.some(p => (["x", "y", "w", "h", "r", "a"] as const).some(c =>
      [p[c].from, p[c].to].some(v => Object.keys(v).some(k => k !== "c"))))))
      throw new Error(`Point retirement requires fixed Source groups: ${effect.name}`);
    const early = points.particles.filter(p => p.start + p.duration <= ratio);
    const late = points.particles.filter(p => p.start + p.duration > ratio);
    if (!early.length) continue;
    if (early.some(a => late.some(b => Math.min(a.start + a.duration, b.start + b.duration) > Math.max(a.start, b.start))))
      throw new Error(`Point retirement crosses an original display window: ${effect.name}`);
    points.particles = late;
    aliases.push({ ...effect, name: alias, groups: [{ count: 1, particles: early.map(p => ({ ...p, start: p.start / ratio, duration: p.duration / ratio })) }] });
    report.push({ name: effect.name, alias, durationRatio: ratio, earlyDefinitions: early.length, lateDefinitions: late.length,
      extraSpawnCalls: 1, extraMoveCalls: 0, textureChanges: 0 });
  }
  data.effects = [...data.effects.filter(effect => !replacedAliases.has(String(effect.name))), ...aliases];
  return report;
}


function visibleCore(tile: Tile): Tile {
  const pixels = new Uint8Array(tile.image.pixels);
  for (let i = 3; i < pixels.length; i += 4) if (pixels[i]! <= 2) pixels[i] = 0;
  return trimTile({ ...tile, image: { ...tile.image, pixels } });
}

// Measured lower stage color used by the other Sonolus material fits.
const POINT_STAGE_RGB = [10 / 255, 22 / 255, 49 / 255] as const;

/** Encode the baked additive radiance as the least opaque source-over color at the stage. */
export function encodePointStageRadiance(tile: Tile): Tile {
  const pixels = new Uint8Array(tile.image.pixels);
  for (let offset = 0; offset < pixels.length; offset += 4) {
    const sourceAlpha = pixels[offset + 3]! / 255;
    if (!sourceAlpha) continue;
    const emission = POINT_STAGE_RGB.map((channel, index) =>
      Math.min(1 - channel, (pixels[offset + index]! / 255) * sourceAlpha),
    );
    const opacity = Math.ceil(255 * Math.max(
      ...emission.map((channel, index) => channel / (1 - POINT_STAGE_RGB[index]!)),
    ));
    pixels[offset + 3] = opacity;
    if (!opacity) continue;
    for (const [index, channel] of emission.entries()) {
      pixels[offset + index] = Math.round(255 * (POINT_STAGE_RGB[index]! + (255 * channel) / opacity));
    }
  }
  return { ...tile, image: { ...tile.image, pixels } };
}

/** Bilinear filtering in Sonolus samples straight RGBA before applying SrcAlpha. */
export function extendPointEdgeColor(tile: Tile): Tile {
  const { width, height, pixels } = tile.image;
  const output = new Uint8Array(pixels);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      if (pixels[offset + 3]) continue;
      let coverage = 0;
      const rgb = [0, 0, 0];
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (x + dx < 0 || x + dx >= width || y + dy < 0 || y + dy >= height) continue;
          const neighbor = ((y + dy) * width + x + dx) * 4;
          const weight = pixels[neighbor + 3]! / (1 + Math.abs(dx) + Math.abs(dy));
          coverage += weight;
          for (let channel = 0; channel < 3; channel += 1)
            rgb[channel]! += pixels[neighbor + channel]! * weight;
        }
      }
      if (coverage === 0) continue;
      for (let channel = 0; channel < 3; channel += 1)
        output[offset + channel] = Math.round(rgb[channel]! / coverage);
    }
  }
  return { ...tile, image: { width, height, pixels: output } };
}

const sourceTexels=new Map<string,{pixels:number[][];area:number}>(),coreResponses=new Map<string,number>();
function sourceCoreEnergy(sample:ParticleSample):number {
  const key=sample.file+"|"+sample.uv.join(","),responseKey=key+"|"+sample.emission.join(",");
  let response=coreResponses.get(responseKey);
  if(response===undefined) {
    let texture=sourceTexels.get(key);
    if(!texture) {
      const image=decodeRgba8Png(readFileSync(sample.file),sample.file),[u0,v0,u1,v1]=sample.uv,pixels:number[][]=[];
      const x0=Math.floor(u0*image.width),x1=Math.ceil(u1*image.width),y0=Math.floor((1-v1)*image.height),y1=Math.ceil((1-v0)*image.height);
      for(let y=y0;y<y1;y++)for(let x=x0;x<x1;x++) {
        const p=(y*image.width+x)*4,a=image.pixels[p+3]!/255;
        if(a>0)pixels.push([0,1,2].map(c=>image.pixels[p+c]!/255*a));
      }
      texture={pixels,area:(x1-x0)*(y1-y0)};sourceTexels.set(key,texture);
    }
    response=0;
    for(const pixel of texture.pixels)for(let c=0;c<3;c++)response+=Math.min(1,pixel[c]!*sample.emission[c]!)*[.2126,.7152,.0722][c]!;
    response/=Math.max(1,texture.area);coreResponses.set(responseKey,response);
  }
  return sample.pixelArea*response;
}

/** Bake bounded, nearby Source micro-particles together on their original display clock. */
export async function buildSourcePointAssets(options: {
  destination: string; baseline: string; releaseRoot: string;
  profile: "standard" | "light"; target?: string; maximumAtlasHeight?: number;
}): Promise<void> {
  const { destination, baseline, releaseRoot, profile: key, target = "all" } = options;
  if (resolve(destination) === resolve(baseline)) throw new Error("Point generation requires a separate output");
  const folder = resolve(baseline, "particles", key);
  let data = JSON.parse(gunzipSync(readFileSync(resolve(folder, "particle.data"))).toString()) as ParticleData;
  let png: Buffer = readFileSync(resolve(folder, "particle.texture.png"));
  const profile = NATIVE_EFFECT_PROFILES.find(p => p.prefix === (key === "standard" ? "Our Notes Native" : "Our Notes Light"))!;
  const previousFitReport = process.env.SONOLUS_FIT_REPORT;
  process.env.SONOLUS_FIT_REPORT = "1";
  try {
    const fullName = `${profile.prefix} ${target}`;
    const only = (name: string) => target === "all"
      ? /^(Normal|Flick) W\d+$/.test(name.slice(profile.prefix.length + 1)) : name === fullName;
    motionFitReport.length = 0;
    const legacy = await compileNativeParticles({ releaseRoot, profiles: [profile], billboardsOnly: true, only });
    const provenance = structuredClone(motionFitReport) as unknown as Provenance[];
    motionFitReport.length = 0;
    const tracer = new EffectTracer({ releaseRoot, currentQuality: profile.quality, noteEffectSkin: "effect001" });
    await tracer.load();
    const tiles: Tile[] = [], effects: ParticleData["effects"] = [], records: JsonRecord[] = [];
    const atoms=new Map<string,{tile:Tile;sprite:number;rect:{x0:number;y0:number;x1:number;y1:number};centre:[number,number];units:{x:number;y:number};width:number;height:number;peak:number}>();
    try {
      for (const effect of legacy.effects) {
        const effectName = String(effect.name);
        if (!effectName.endsWith(" P0")) continue;
        const width = Number(/ W(\d+) P0$/.exec(effectName)![1]);
        const kind = effectName.includes(" Flick") ? "flick" : "tap";
        const trace = tracer.trace({ kind, direction: "none", judgement: "perfect", lifetime: clip }, width,
          Array.from({ length: 26 }, (_, i) => i / frameRate), [4660], { meshes: false });
        const actors = new Map<string, ParticleSample[]>();
        for (const sample of trace.particles) if (sourceParticleFamily(sample) === "point") {
          const identity = `${sample.system}:${sample.emission_}`;
          const list = actors.get(identity) ?? [];
          list.push(sample); actors.set(identity, list);
        }
        const units = unitsPerPixel(width / 4), plane = NATIVE_EFFECT_PLANES[0]!;
        const pixel = (x: number, y: number): [number, number] => [x * (plane.alpha1 - plane.slope * (y + 1) * W_TO_H) / units.x / 2, y / units.y / 2];
        const centre = (sample: ParticleSample): [number, number] => [
          sample.corners.reduce((n, c) => n + c.x, 0) / 4,
          sample.corners.reduce((n, c) => n + c.y, 0) / 4,
        ];
        const windows: Window[] = [], allWindows:Window[]=[], actorsProof: ActorProof[] = [];
        for (const samples of actors.values()) {
          const choices = samples.flatMap((sample, index): Window[] => {
            if (sample.t < sample.birth || sample.pixelArea <= 0) return [];
            const coverage = textureCoverage(sample.file, sample.uv);
            const energy = sample.pixelArea * coverage.reduce((n, value, c) => n + value * sample.emission[c]! * [.2126, .7152, .0722][c]!, 0);
            if (energy <= 1e-8) return [];
            const start = Math.max(0, sample.birth, sample.t - .5 / frameRate);
            const end = Math.min(clip, sample.birth + sample.lifetime, sample.t + .5 / frameRate);
            if (end <= start) return [];
            const previous = samples[Math.max(0, index - 1)]!, next = samples[Math.min(samples.length - 1, index + 1)]!;
            const a = centre(previous), b = centre(next), position = centre(sample), dt = next.t - previous.t;
            const velocity: [number, number] = dt > 0 ? [(b[0] - a[0]) / dt, (b[1] - a[1]) / dt] : [0, 0];
            const points = sample.corners.map(c => pixel(c.x, c.y));
            const bounds:[number,number,number,number]=[Math.min(...points.map(p=>p[0])),Math.min(...points.map(p=>p[1])),Math.max(...points.map(p=>p[0])),Math.max(...points.map(p=>p[1]))];
            const origin=effectPixelOrigin();
            // Source display windows above/below the fixed stage contribute no visible light.
            if(bounds[3]<-origin[1]/2-4||bounds[1]>540-origin[1]/2+4)return [];
            return [{ sample, start, end, energy,coreEnergy:sourceCoreEnergy(sample), centre: position, velocity,
              bounds }];
          });
          const selected = choices.sort((a, b) => b.energy - a.energy).slice(0, maximumWindows);
          allWindows.push(...choices);
          windows.push(...selected);
          actorsProof.push({ system: samples[0]!.system, emission: samples[0]!.emission_, birth: samples[0]!.birth,
            lifetime: samples[0]!.lifetime, available: choices.length,
            windows: selected.map(w => ({ time: w.sample.t, start: w.start, end: w.end, energy: w.energy,
              worldSize: w.sample.worldSize, emission: w.sample.emission })) });
        }
        const visibleFrames=new Map<number,Window[]>();
        for(const w of allWindows) {const frame=Math.round(w.sample.t*frameRate),list=visibleFrames.get(frame)??[];list.push(w);visibleFrames.set(frame,list);}
        const corePeak=Math.max(...[...visibleFrames.values()].map(list=>list.reduce((n,w)=>n+w.coreEnergy,0)));
        const identities=new Set(windows.map(w=>`${w.sample.system}:${w.sample.emission_}:${Math.round(w.sample.t*frameRate)}`)),counts=new Map<string,number>();
        for(const w of windows){const id=`${w.sample.system}:${w.sample.emission_}`;counts.set(id,(counts.get(id)??0)+1);}
        const sparseFrames:JsonRecord[]=[];
        for(const [frame,list]of [...visibleFrames].sort(([af,a],[bf,b])=>{const ratio=(frame:number,list:Window[])=>list.filter(w=>identities.has(`${w.sample.system}:${w.sample.emission_}:${frame}`)).reduce((n,w)=>n+w.coreEnergy,0)/Math.max(1e-12,list.reduce((n,w)=>n+w.coreEnergy,0));return ratio(af,a)-ratio(bf,b)||af-bf;})) {
          const total=list.reduce((n,w)=>n+w.coreEnergy,0);let retained=list.filter(w=>identities.has(`${w.sample.system}:${w.sample.emission_}:${frame}`)).reduce((n,w)=>n+w.coreEnergy,0),added=0;
          if(total>=corePeak*.05)for(const w of list.slice().sort((a,b)=>b.coreEnergy-a.coreEnergy)) {
            if(retained>=total*.8)break;
            const actor=`${w.sample.system}:${w.sample.emission_}`,id=`${actor}:${frame}`;
            if(identities.has(id)||(counts.get(actor)??0)>=maximumWindows+1)continue;
            windows.push(w);identities.add(id);counts.set(actor,(counts.get(actor)??0)+1);retained+=w.coreEnergy;added++;
            actorsProof.find(a=>a.system===w.sample.system&&a.emission===w.sample.emission_)!.windows.push({time:w.sample.t,start:w.start,end:w.end,energy:w.energy,coreEnergy:w.coreEnergy,sparseCoverage:true,worldSize:w.sample.worldSize,emission:w.sample.emission});
          }
          sparseFrames.push({frame,totalCore:total,retainedCore:retained,added});
        }
        const byTime = new Map<string, Window[]>();
        for (const window of windows) {
          const identity = `${Math.round(window.sample.t * frameRate)}:${window.start}:${window.end}`;
          const list = byTime.get(identity) ?? []; list.push(window); byTime.set(identity, list);
        }
        const groups: Group[] = [], patches: PointPatch[] = [];
        for (const sameTime of byTime.values()) {
          const pending = sameTime.slice().sort((a, b) => b.energy - a.energy);
          while (pending.length) {
            const members = [pending.shift()!], first = members[0]!;
            let bounds = first.bounds.slice() as [number, number, number, number];
            const point = pixel(...first.centre), nextPoint = pixel(first.centre[0] + first.velocity[0] / frameRate, first.centre[1] + first.velocity[1] / frameRate);
            for (let i = 0; i < pending.length && members.length < maximumMembers;) {
              const candidate = pending[i]!, at = pixel(...candidate.centre), after = pixel(candidate.centre[0] + candidate.velocity[0] / frameRate, candidate.centre[1] + candidate.velocity[1] / frameRate);
              const combined: typeof bounds = [Math.min(bounds[0], candidate.bounds[0]), Math.min(bounds[1], candidate.bounds[1]), Math.max(bounds[2], candidate.bounds[2]), Math.max(bounds[3], candidate.bounds[3])];
              const relativeMotion = Math.hypot(after[0] - at[0] - nextPoint[0] + point[0], after[1] - at[1] - nextPoint[1] + point[1]);
              if (Math.hypot(at[0] - point[0], at[1] - point[1]) <= 24 && relativeMotion <= 3 && combined[2] - combined[0] <= patchSide - 8 && combined[3] - combined[1] <= patchSide - 8) {
                members.push(candidate); bounds = combined; pending.splice(i, 1);
              } else i++;
            }
            const peak=Math.max(...first.sample.emission), height=first.sample.pixelHeight/2;
            const atomKey=members.length===1?JSON.stringify([kind,first.sample.file,
              Math.round(Math.log2(height)*2),Math.round(Math.log2(peak)*2),
              first.sample.emission.map(v=>Math.round(v/peak*8)),Math.round(first.sample.pixelWidth/first.sample.pixelHeight*8)]):undefined;
            let atom=atomKey?atoms.get(atomKey):undefined;
            const quads: CompositeQuad[] = members.map(({ sample }) => ({ file: sample.file, uv: sample.uv, emission: sample.emission,
              corners: sample.corners.map(c => [c.x / units.x, c.y / units.y]),
              projection: { originX: 0, originY: 0, alphaOrigin: plane.alpha1 - plane.slope * W_TO_H,
                alphaSlope: -plane.slope * W_TO_H * units.y, inverseDepths: sample.inverseDepths! } }));
            const renderingScale = key === "standard" ? .85 : .71;
            const field = atom?undefined:rasterizeProjectedRadiance(quads, renderingScale / 2, .5, effectPixelOrigin(), 4);
            const name = `${key}|${effectName}|${patches.length}`;
            const fullTile=atom?.tile??visibleCore(bakeRadianceFieldTile(name, field!, [1, 1, 1], 1, 1, 1 / renderingScale));
            const tile = atom?.tile ?? extendPointEdgeColor(encodePointStageRadiance(
              members.length > 1 ? visibleCore(downsamplePremultipliedTile(fullTile, 4)) : fullTile,
            ));
            if (!tile.image.pixels.some((v, i) => i % 4 === 3 && v > 0)) continue;
            const sprite=atom?.sprite??tiles.length;
            if(!atom) {
              tiles.push(tile);
              if(atomKey) {atom={tile,sprite,rect:field!.rect,centre:first.centre,units,width:first.sample.pixelWidth/2,height,peak};atoms.set(atomKey,atom);}
            }
            const rect=atom?.rect??field!.rect, relativeScale=atom?height/atom.height:1, scaleX=atom?first.sample.pixelWidth/2/atom.width:1;
            const w=(rect.x1-rect.x0)/2*units.x*scaleX, h=(rect.y1-rect.y0)/2*units.y*relativeScale;
            const x=atom?first.centre[0]+((rect.x0+rect.x1)/2-atom.centre[0]/atom.units.x)*units.x*scaleX+2*w*tile.offset[0]
              :(rect.x0+rect.x1)/2*units.x+2*w*tile.offset[0];
            const y=atom?first.centre[1]+((rect.y0+rect.y1)/2-atom.centre[1]/atom.units.y)*units.y*relativeScale+2*h*tile.offset[1]
              :(rect.y0+rect.y1)/2*units.y+2*h*tile.offset[1];
            const alpha=atom?Math.min(1,Math.pow(peak/atom.peak,1/2.2)):1;
            const total = members.reduce((n, m) => n + m.energy, 0);
            const velocity = [0, 1].map(c => members.reduce((n, m) => n + m.velocity[c]! * m.energy, 0) / total);
            const start = Math.fround(first.start / clip), end = Math.fround(first.end / clip);
            groups.push({ count: 1, particles: [{ sprite, color: "#ffffff", start, duration: durationBeforeNextPhase(start, end),
              x: channel(x + velocity[0]! * (first.start - first.sample.t), x + velocity[0]! * (first.end - first.sample.t)),
              y: channel(y + velocity[1]! * (first.start - first.sample.t), y + velocity[1]! * (first.end - first.sample.t)),
              w: channel(w * tile.expand[0]), h: channel(h * tile.expand[1]), r: channel(0), a: channel(alpha) }] });
            patches.push({ time: first.sample.t, start: first.start, end: first.end, members: members.map(m => ({ system: m.sample.system, emission: m.sample.emission_ })),
              sprite: [tile.image.width, tile.image.height], screenBounds: bounds, atomKey, relativeScale, alpha,softPatch:members.length>1,
              relativeMotionLimitPixelsPerFrame: 3, sourcePixelDensity: renderingScale / 2, nativePixelDensity: .5 });
          }
        }
        // Fixed Source identities use constants only; all patch windows can share one random draw group.
        effects.push({ ...effect, groups:[{count:1,particles:groups.flatMap(g=>g.particles)}] });
        const renderedWindows=patches.reduce((n,p)=>n+p.members.length,0);
        records.push({ effect: effectName, width, sourceActors: actors.size, sourceWindows: windows.length, definitions: groups.length,
          droppedWindows: windows.length-renderedWindows, mergedWindows: renderedWindows-groups.length, actors: actorsProof,sparseFrames, patches });
      }
    } finally { tracer.dispose(); }
    const textureInventory={atomicKernels:atoms.size,uniqueTiles:tiles.length,
      texelsIncludingGutters:tiles.reduce((n,t)=>n+(t.image.width+2)*(t.image.height+2),0)};
    console.log(JSON.stringify({profile:key,textureInventory}));
    const source = { effects, atlas: packAtlas(tiles), report: [], sourceBudgets: [] };
    const changes: JsonRecord[] = [];
    for (const effect of legacy.effects) {
      const effectName = String(effect.name);
      if (!effectName.endsWith(" P0")) continue;
      const width = Number(/ W(\d+) P0$/.exec(effectName)![1]), name = effectName.replace(profile.prefix, "Our Notes Native"), baseName = effectName.replace(/ W\d+ P0$/, "");
      const rows = provenance.filter(p => p.effect === baseName && p.width === width && p.plane === 0), previous = data.effects.find(e => e.name === name)!;
      if (!previous || rows.length > (previous.groups as Group[]).length) throw new Error(`Point provenance does not match the baseline: ${name}`);
      const indices = new Set(rows.flatMap((p, i) => p.sourceFamily === "point" ? [i] : [])), replacement = source.effects.find(e => e.name === effect.name)!;
      if (!replacement || !indices.size) throw new Error(`No formal point emitter: ${name}`);
      const old = (previous.groups as Group[]).filter((_, i) => indices.has(i));
      const merged = mergeParticleGroupDelta(data, png, { ...source, effects: [{ ...replacement, name }] }, indices, decodeRgba8Png);
      data = merged.data; png = merged.png;
      changes.push({ name, replacedGroups: [...indices], previousBirths: old.reduce((n, g) => n + g.count, 0),
        previousDefinitions: old.reduce((n, g) => n + g.count * g.particles.length, 0), definitions: (replacement.groups as Group[]).reduce((n,g)=>n+g.particles.length,0) });
    }
    if (!changes.length) throw new Error("No point effects generated");
    const packed = repackParticleAtlas(data, png, 1024, { denseSearch: true, decode: decodeRgba8Png, maximumHeight: options.maximumAtlasHeight ?? 1024 }), output = resolve(destination, "particles", key);
    const earlyRetirement = retireEarlyPointPhases(packed.data, changes.map(change => String(change.name)));
    mkdirSync(output, { recursive: true });
    const zipped = gzipSync(JSON.stringify(packed.data), { level: 9 });
    writeFileSync(resolve(output, "particle.data"), zipped); writeFileSync(resolve(output, "particle.texture.png"), packed.png);
    const report = JSON.parse(readFileSync(resolve(folder, "particle-pack-report.json"), "utf8"));
    report.effects = packed.data.effects.length;
    report.groups = packed.data.effects.reduce((n, e) => n + (e.groups as Group[]).length, 0);
    report.instances = packed.data.effects.reduce((n, e) => n + (e.groups as Group[]).reduce((m, g) => m + g.count, 0), 0);
    report.definitions = packed.data.effects.reduce((n, e) => n + (e.groups as Group[]).reduce((m, g) => m + g.count * g.particles.length, 0), 0);
    report.atlas = { width: packed.data.width, height: packed.data.height, sprites: packed.data.sprites.length };
    report.artifacts = { data: { bytes: zipped.length, sha1: sha(zipped, "sha1") }, texture: { bytes: packed.png.length, sha1: sha(packed.png, "sha1") } };
    writeFileSync(resolve(output, "particle-pack-report.json"), JSON.stringify(report, null, 2));
    const manifest = JSON.parse(readFileSync(resolve(baseline, "particle-packs.json"), "utf8"));
    manifest.packs = manifest.packs.map((p: { key: string }) => p.key === key ? report : p);
    for (const sibling of ["standard", "light", "simple"]) if (sibling !== key) {
      const out = resolve(destination, "particles", sibling); mkdirSync(out, { recursive: true });
      for (const file of ["particle.data", "particle.texture.png", "particle-pack-report.json"]) copyFileSync(resolve(baseline, "particles", sibling, file), resolve(out, file));
    }
    writeFileSync(resolve(destination, "particle-packs.json"), JSON.stringify(manifest, null, 2));
    writeFileSync(resolve(destination, "source-points-proof.json"), JSON.stringify({ schema: "our-notes-source-points-v1", profile: key, effect: target, changes, earlyRetirement,
      strategy: { sourceDisplayFrameRate: frameRate,primaryWindowsPerActor:maximumWindows,maximumWindowsPerActor: maximumWindows+1,sparseCoreTarget:.8,significantCoreFrame:.05, maximumMembers, patchSide, coreBloomMips: 1, screenSpacePadding1080: 4, specialEases: 0,
        atomicSizeOctaveStep:.5,atomicHdrOctaveStep:.5,atomicChromaSteps:8,atomicAspectSteps:8,multiPointPatchDownsample:4,alphaFloor:2/255,constantDrawGroupsPerEffect:1 },textureInventory,records,
      sourceSha256: Object.fromEntries([import.meta.filename,
        resolve(import.meta.dirname, "../../../.dependencies/sonolus-our-notes/shared/src/engine/data/nativeEffects.ts"),
        ...["compile.ts", "budget.ts", "trace.ts", "trajectory.ts", "bake.ts"].map(f => resolve(import.meta.dirname, "native-particles", f))].map(f => [f, sha(readFileSync(f))])),
    }, null, 2));
    console.log(JSON.stringify({ profile: key, changes, aggregate: records.map(r => ({ effect: r.effect, windows: r.sourceWindows, definitions: r.definitions, merged: r.mergedWindows })), dataBytes: zipped.length, textureBytes: packed.png.length }));
  } finally {
    if (previousFitReport === undefined) delete process.env.SONOLUS_FIT_REPORT; else process.env.SONOLUS_FIT_REPORT = previousFitReport;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  const [destination, baseline, releaseRoot, profile = "standard", target = "all"] = process.argv.slice(2);
  if (!destination || !baseline || !releaseRoot || (profile !== "standard" && profile !== "light")) throw new Error("Usage: build-native-source-point-assets.ts OUTPUT BASELINE RELEASE [standard|light] [EFFECT|all]");
  await buildSourcePointAssets({ destination, baseline, releaseRoot, profile, target });
}
