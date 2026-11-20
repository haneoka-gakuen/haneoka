// L3 — GEB
// Input: Recorded source glow fields and the corresponding Sonolus presentation pack.
// Output: One active light layer per hit frame, beneath the corresponding foreground.
// Pos: [Map](../L2-2.md); offline glow atlas production.
// Effects/Dependencies: Rebuilds the selected particle atlas and refreshes its resource report.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { constants, gunzipSync, gzipSync } from "node:zlib";
import { extendPointEdgeColor } from "./build-native-source-point-assets.ts";
import { downsamplePremultipliedTile, packAtlas } from "./native-particles/bake.ts";
import { mergeNativeParticleDelta, type ParticleData } from "./native-particles/merge.ts";
import { refreshNativeParticlePackReports } from "./native-particles/packs.ts";
import { ParticleAtlasCapacityError, repackParticleAtlas } from "./native-particles/repack.ts";
import { durationBeforeNextPhase } from "./native-particles/trajectory.ts";
import { decodePng, encodeRgbaPng } from "./native-particles/textureBake.ts";

const sideFlickLayer = / Flick (Left|Right)(?: Short)? W\d+ P0$/u;

interface GlowFrame {
  frame: number;
  bounds: [number, number, number, number];
  pixels: number[];
}

interface GlowCapture {
  profile: "standard" | "light" | "simple";
  width: number;
  height: number;
  frameCount: number;
  effects: { name: string; frames: GlowFrame[] }[];
}

export function buildNativeSourceGlowAssets(directory: string, capture: GlowCapture) {
  const { profile, width, height, frameCount, effects } = capture;
  if (!["standard", "light", "simple"].includes(profile) || frameCount !== 25) {
    throw new Error("Expected a 60 Hz source glow capture");
  }
  const pack = resolve(directory, "particles", profile);
  const dataFile = resolve(pack, "particle.data");
  const textureFile = resolve(pack, "particle.texture.png");
  const original = JSON.parse(gunzipSync(readFileSync(dataFile)).toString()) as ParticleData;
  const originalTexture = readFileSync(textureFile);
  let minimumBytes = Number.POSITIVE_INFINITY;
  const build = (downsample: number) => {
    const key = (name: string, frame: number) => `${name}:${frame}`;
    const atlas = packAtlas(effects.flatMap(({ name, frames }) =>
      frames.map(({ frame, pixels }) => {
        if (!Number.isInteger(frame) || frame < 0 || frame >= frameCount || pixels.length !== width * height * 4) {
          throw new Error(`Invalid source glow frame: ${name}`);
        }
        const tile = downsamplePremultipliedTile({
          key: key(name, frame),
          image: { width, height, pixels: Uint8Array.from(pixels) },
          expand: [1, 1],
          offset: [0, 0],
          response: new Float32Array(0),
        }, downsample);
        return extendPointEdgeColor(tile);
      }),
    ));
    const constant = (c: number) => ({ from: { c }, to: { c } });
    const targets = effects.flatMap(({ name, frames }) => {
      const original = { name, source: name, frames, durationFrames: profile === "simple" ? 45 : frameCount };
      if (profile !== "simple") return [original];
      return [original, { ...original, name: name.replace(/ (W\d+) P0$/u, " Short $1 P0"), durationFrames: frameCount }];
    });
    const replacements = targets.map(({ name, source, frames, durationFrames }) => {
      const base = original.effects.find((effect) => effect.name === name);
      const sideFlick = sideFlickLayer.test(name);
      if (!base || (!sideFlick && !/ (Normal|Flick) W\d+ B0$/u.test(name))) {
        throw new Error(`Missing native light layer effect: ${name}`);
      }
      const particles = frames.map(({ frame, bounds }) => {
        const [left, bottom, right, top] = bounds;
        const start = Math.fround(frame / durationFrames);
        const end = Math.fround((frame + 1) / durationFrames);
        return {
          sprite: atlas.index.get(key(source, frame))!,
          color: "#ffffff",
          start,
          duration: durationBeforeNextPhase(start, end),
          x: constant((left + right) / 2),
          y: constant((bottom + top) / 2),
          w: constant((right - left) / 2),
          h: constant((top - bottom) / 2),
          r: {},
          a: constant(1),
        };
      });
      return { ...base, groups: [{ count: 1, particles }] };
    });
    const retainGroups = new Set(targets.filter(({ name }) => sideFlickLayer.test(name)).map(({ name }) => name));
    const merged = mergeNativeParticleDelta(original, originalTexture, { atlas, effects: replacements }, retainGroups);
    const packed = retainGroups.size && merged.data.width === original.width && merged.data.height === original.height
      ? merged
      : repackParticleAtlas(merged.data, merged.png, original.width, {
          denseSearch: true,
          maximumHeight: Math.min(2048, Math.max(1536, original.height + 256)),
        });
    const raw = JSON.stringify(packed.data);
    const originalCompression = gzipSync(raw, { level: 9 });
    const filteredCompression = gzipSync(raw, { level: 9, strategy: constants.Z_FILTERED });
    const data = originalCompression.length < filteredCompression.length ? originalCompression : filteredCompression;
    const filteredTexture = encodeRgbaPng(decodePng(packed.png, `${profile} glow atlas`), true);
    const texture = filteredTexture.length < packed.png.length ? filteredTexture : packed.png;
    return { data, texture, atlas: [packed.data.width, packed.data.height] };
  };
  for (const downsample of [1, 1.125, 1.25, 1.5, 2]) {
    let packed: ReturnType<typeof build>;
    try {
      packed = build(downsample);
    } catch (error) {
      if (error instanceof ParticleAtlasCapacityError) continue;
      throw error;
    }
    const { data, texture, atlas } = packed;
    const bytes = data.length + texture.length;
    minimumBytes = Math.min(minimumBytes, bytes);
    if (bytes > 2 * 1024 * 1024) continue;
    writeFileSync(dataFile, data);
    writeFileSync(textureFile, texture);
    refreshNativeParticlePackReports(directory);
    return { profile, effects: effects.length, bytes, atlas, downsample };
  }
  throw new Error(Number.isFinite(minimumBytes)
    ? `Source glow exceeds the ${profile} particle download budget (${minimumBytes} bytes)`
    : `Source glow exceeds the ${profile} atlas capacity`);
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  const [directory, captureFile] = process.argv.slice(2);
  if (!directory || !captureFile) throw new Error("Usage: build-native-source-glow-assets.ts PACK CAPTURE_JSON");
  console.log(buildNativeSourceGlowAssets(directory, JSON.parse(readFileSync(captureFile, "utf8"))));
}
