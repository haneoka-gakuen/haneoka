// L3 — GEB
// Input: Authored side-flick prefabs and assembled Sonolus particle packs.
// Output: Replacement billboard trajectories for each preset and shorter Simple hit effects.
// Pos: [Map](../L2-2.md); offline authoring of the distributed Sonolus presentation pack.
// Effects/Dependencies: Reads the source release and packs the referenced sprite bytes.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { buildNativeParticleLifetimeAssets, retimeShortParticleEffect } from "../../../.dependencies/sonolus-our-notes/scripts/build-native-particle-lifetime-assets.ts";
import { NATIVE_PARTICLE_PACKS, NATIVE_PARTICLE_SEMANTIC_PREFIX, type NativeParticlePackKey } from "../src/shared/particlePacks.ts";
import { compileNativeParticles, NATIVE_EFFECT_PROFILES, NATIVE_EFFECT_WIDTHS } from "./native-particles/compile.ts";
import { mergeNativeParticleDelta, type ParticleData } from "./native-particles/merge.ts";
import { refreshNativeParticlePackReports } from "./native-particles/packs.ts";
import { repackParticleAtlas } from "./native-particles/repack.ts";
import type { TrajectoryParticle } from "./native-particles/trajectory.ts";

type BillboardGroup = { count: number; particles: TrajectoryParticle[] };
const channels = ["x", "y", "w", "h", "r", "a"] as const;

function fixedPoints(groups: BillboardGroup[]): boolean {
  return groups.every(({ count, particles }) => count === 1 && particles.every((particle) =>
    channels.every((name) => {
      const { from = {}, to = {} } = particle[name] ?? {};
      return Object.keys(from).every((key) => key === "c")
        && Object.keys(to).every((key) => key === "c")
        && (from.c ?? 0) === (to.c ?? 0);
    }),
  ));
}

/** Combine fixed billboards in draw order and remove empty quads. */
export function optimizeFixedSideFlicks(data: ParticleData, preserveGlow = false): number {
  let removed = 0;
  for (const effect of data.effects) {
    const match = / Flick (?:Left|Right)( Great)? W(\d+) P0$/u.exec(String(effect.name));
    if (!match) continue;
    const groups = effect.groups as BillboardGroup[];
    const keep = preserveGlow && !match[1] ? 1 : 0;
    const billboards = groups.slice(keep);
    if (!billboards.length || !fixedPoints(groups)) continue;
    const particles = billboards.flatMap(({ particles }) => particles.filter((particle) => {
      const w = particle.w.from?.c ?? 0, h = particle.h.from?.c ?? 0;
      const alpha = particle.a.from?.c ?? 0;
      if (w !== 0 && h !== 0 && alpha > 0) return true;
      removed++;
      return false;
    }));
    if (particles.length) effect.groups = [...groups.slice(0, keep), { count: 1, particles }];
  }
  return removed;
}

/** Frame-held channels have identical endpoints, so their easing is immaterial. */
export function packFrameChannels(groups: BillboardGroup[]) {
  return groups.map((group) => ({
    ...group,
    particles: group.particles.map((particle) => {
      const packed: Record<string, unknown> = { ...particle };
      for (const channel of channels) {
        const { from = {}, to = {} } = particle[channel];
        if (JSON.stringify(from) !== JSON.stringify(to)) {
          throw new Error(`Frame-held channel ${channel} has moving endpoints`);
        }
        // Position is subpixel at 1920px. Size keeps one extra digit for narrow streaks.
        const precision = channel === "w" || channel === "h" ? 4 : 3;
        const rounded = Object.fromEntries(
          Object.entries(from).map(([key, value]) => [key, Number(value.toFixed(precision))]).filter(([, value]) => value !== 0),
        );
        packed[channel] = Object.keys(rounded).length === 0 ? {} : { from: rounded, to: rounded };
      }
      return packed;
    }),
  }));
}

export async function buildNativeSideFlickAssets(directory: string, releaseRoot: string, onlyProfile?: NativeParticlePackKey) {
  let replaced = 0;
  for (const pack of NATIVE_PARTICLE_PACKS) {
    if (onlyProfile && pack.key !== onlyProfile) continue;
    const profile = NATIVE_EFFECT_PROFILES.find(({ prefix }) => prefix === pack.prefix)!;
    const simple = pack.key === "simple";
    const compiled = await compileNativeParticles({
      releaseRoot,
      profiles: [profile],
      only: (name) => /Flick (Left|Right)(?: Great)? W\d+$/u.test(name),
      preserveSourceParticleCount: true,
      ...(simple
        ? {
            particleMotion: "source-trajectories" as const,
            particleCompression: true,
            particleCoreMips: 2,
            billboardSystemTiles: true,
          }
        : {
            particleFrameHold: true,
            particleCoreColour: true,
            ...(pack.key === "standard" ? {
              particleCoreMips: (name: string, width: number) =>
                name.endsWith(" Flick Right") && (width === 6 || width === 8) ? 2 : 1,
              particleCoreMaxBloomPadding: 8,
              particleCoreBloomDownsample: 1.7,
            } : { particleCoreMips: 1 }),
          }),
      billboardsOnly: true,
    });
    const effects = compiled.effects.flatMap((effect) => {
      const name = String(effect.name);
      if (!Array.isArray(effect.groups) || !effect.groups.length) return [];
      if (!name.endsWith(" P0")) throw new Error(`Side flick billboards must use P0: ${name}`);
      return [{
        ...effect,
        name: NATIVE_PARTICLE_SEMANTIC_PREFIX + name.slice(profile.prefix.length),
        groups: simple ? effect.groups : packFrameChannels(effect.groups as BillboardGroup[]),
      }];
    });
    if (effects.length !== NATIVE_EFFECT_WIDTHS.length * 4)
      throw new Error(`Incomplete side flick effects for ${pack.key}`);

    const packDirectory = resolve(directory, "particles", pack.key);
    const dataFile = resolve(packDirectory, "particle.data");
    const textureFile = resolve(packDirectory, "particle.texture.png");
    const original = JSON.parse(gunzipSync(readFileSync(dataFile)).toString()) as ParticleData;
    const aliases = simple && onlyProfile ? effects.flatMap(effect => {
      const name = /^(Our Notes Native Flick (?:Left|Right)) (W\d+ P0)$/u.exec(effect.name);
      return name ? [retimeShortParticleEffect({ ...effect, groups: effect.groups as BillboardGroup[] }, `${name[1]} Short ${name[2]}`).effect] : [];
    }) : [];
    const merged = mergeNativeParticleDelta(original, readFileSync(textureFile), { effects: [...effects, ...aliases], atlas: compiled.atlas });
    if (!simple) optimizeFixedSideFlicks(merged.data);
    const packed = repackParticleAtlas(merged.data, merged.png, original.width, {
      denseSearch: true,
      maximumHeight: Math.max(1152, original.height + 96),
    });
    writeFileSync(dataFile, gzipSync(JSON.stringify(packed.data), { level: 9 }));
    writeFileSync(textureFile, packed.png);
    if (simple && !onlyProfile) buildNativeParticleLifetimeAssets({ baseline: packDirectory, destination: packDirectory });
    replaced += effects.length;
  }
  refreshNativeParticlePackReports(directory);
  return replaced;
}
