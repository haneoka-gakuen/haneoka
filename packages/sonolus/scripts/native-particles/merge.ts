// Replace selected effects while preserving the baseline's sprite indices,
// placements and all retained/reused pixels. Reclaim tiles used exclusively
// by replaced effects before expanding the atlas.
import { createHash } from "node:crypto";
import type { CompileResult } from "./compile.ts";
import { decodePng, encodeRgbaPng, type RgbaImage } from "./textureBake.ts";

export type ParticleDelta = Pick<CompileResult, "effects" | "atlas">;

type Sprite = CompileResult["atlas"]["sprites"][number];
type Effect = CompileResult["effects"][number];
export interface ParticleData {
  width: number;
  height: number;
  interpolation: boolean;
  sprites: Sprite[];
  effects: Effect[];
}
interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
const crop = (image: RgbaImage, rect: Rect): Uint8Array => {
  if (rect.x < 0 || rect.y < 0 || rect.x + rect.w > image.width || rect.y + rect.h > image.height)
    throw new Error("Particle sprite exceeds its paired texture");
  const out = new Uint8Array(rect.w * rect.h * 4);
  for (let y = 0; y < rect.h; y++) {
    const offset = ((rect.y + y) * image.width + rect.x) * 4;
    out.set(image.pixels.subarray(offset, offset + rect.w * 4), y * rect.w * 4);
  }
  return out;
};
const digest = (w: number, h: number, pixels: Uint8Array) =>
  createHash("sha256").update(`${w},${h}|`).update(pixels).digest("hex");
const padded = (s: Sprite): Rect => ({ x: s.x - 1, y: s.y - 1, w: s.w + 2, h: s.h + 2 });
// Keep maximal free rectangles (they may overlap). Disjoint guillotine
// fragments hide usable space between the baseline's existing shelves.
const subtract = (free: Rect[], used: Rect): Rect[] =>
  free
    .flatMap((r) => {
      const x0 = Math.max(r.x, used.x),
        x1 = Math.min(r.x + r.w, used.x + used.w);
      const y0 = Math.max(r.y, used.y),
        y1 = Math.min(r.y + r.h, used.y + used.h);
      if (x0 >= x1 || y0 >= y1) return [r];
      return [
        { x: r.x, y: r.y, w: r.w, h: y0 - r.y },
        { x: r.x, y: y1, w: r.w, h: r.y + r.h - y1 },
        { x: r.x, y: r.y, w: x0 - r.x, h: r.h },
        { x: x1, y: r.y, w: r.x + r.w - x1, h: r.h },
      ].filter((piece) => piece.w > 0 && piece.h > 0);
    })
    .filter(
      (r, index, list) =>
        !list.some(
          (other, j) =>
            j !== index &&
            other.x <= r.x &&
            other.y <= r.y &&
            other.x + other.w >= r.x + r.w &&
            other.y + other.h >= r.y + r.h &&
            (other.x !== r.x || other.y !== r.y || other.w !== r.w || other.h !== r.h || j < index),
        ),
    );

export function mergeNativeParticleDelta(
  baseline: ParticleData,
  baselinePng: Buffer,
  delta: ParticleDelta,
  retainGroups: ReadonlySet<string> = new Set(),
) {
  const original = decodePng(baselinePng, "baseline particle texture");
  const update = decodePng(delta.atlas.png, "delta particle texture");
  if (original.width !== baseline.width || original.height !== baseline.height)
    throw new Error("Baseline ParticleData/texture dimensions differ");
  const names = new Set(baseline.effects.map((effect) => effect.name));
  const replacements = new Map(delta.effects.map((effect) => [effect.name, effect]));
  if (
    names.size !== baseline.effects.length ||
    replacements.size !== delta.effects.length ||
    [...replacements.keys()].some((name) => !names.has(name))
  )
    throw new Error("Delta effects must uniquely replace existing baseline names");
  const known = new Map<string, number>();
  baseline.sprites.forEach((sprite, index) => known.set(digest(sprite.w, sprite.h, crop(original, sprite)), index));
  const remap = new Map<number, number>();
  const protectedSprites = new Set<number>();
  for (const effect of baseline.effects)
    if (!replacements.has(effect.name) || retainGroups.has(String(effect.name)))
      for (const group of effect.groups as Array<{ particles: Array<{ sprite: number }> }>)
        for (const particle of group.particles) protectedSprites.add(particle.sprite);
  // Append only referenced tiles. The compiler also bakes optional halo tiles.
  const referenced = new Set<number>();
  for (const effect of delta.effects)
    for (const group of effect.groups as Array<{ particles: Array<{ sprite: number }> }>)
      for (const particle of group.particles) referenced.add(particle.sprite);
  const additions: Array<{ index: number; w: number; h: number; pixels: Uint8Array }> = [];
  let reused = 0;
  for (const index of referenced) {
    const sprite = delta.atlas.sprites[index];
    if (!sprite) throw new Error(`Delta sprite missing: ${index}`);
    const pixels = crop(update, sprite);
    const hash = digest(sprite.w, sprite.h, pixels);
    let target = known.get(hash);
    if (target === undefined) {
      target = baseline.sprites.length + additions.length;
      known.set(hash, target);
      additions.push({ index: target, w: sprite.w, h: sprite.h, pixels });
    } else {
      reused++;
      if (target < baseline.sprites.length) protectedSprites.add(target);
    }
    remap.set(index, target);
  }
  const order = additions.slice().sort((a, b) => b.h - a.h || b.w - a.w);
  let placements: Map<number, Sprite> | undefined;
  let width = baseline.width,
    height = baseline.height;
  while (Math.max(width, height) <= 4096) {
    let free: Rect[] = [{ x: 0, y: 0, w: width, h: height }];
    for (const index of protectedSprites) free = subtract(free, padded(baseline.sprites[index]!));
    const candidate = new Map<number, Sprite>();
    for (const tile of order) {
      const spaces = free.filter((r) => r.w >= tile.w + 2 && r.h >= tile.h + 2).sort((a, b) => a.w * a.h - b.w * b.h);
      const space = spaces[0];
      if (!space) break;
      const sprite = { x: space.x + 1, y: space.y + 1, w: tile.w, h: tile.h };
      candidate.set(tile.index, sprite);
      free = subtract(free, padded(sprite));
    }
    if (candidate.size === additions.length) {
      placements = candidate;
      break;
    }
    width *= 2;
    height *= 2;
  }
  if (!placements) throw new Error("Particle delta exceeds the 4096 atlas cap with baseline placements preserved");
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < original.height; y++)
    pixels.set(original.pixels.subarray(y * original.width * 4, (y + 1) * original.width * 4), y * width * 4);
  const sprites = baseline.sprites.slice();
  for (const tile of additions) {
    const s = placements.get(tile.index)!;
    sprites.push(s);
    // Same edge extension as packAtlas; retained/reused gutters stay occupied.
    for (let y = -1; y <= s.h; y++)
      for (let x = -1; x <= s.w; x++) {
        const from = (Math.min(s.h - 1, Math.max(0, y)) * s.w + Math.min(s.w - 1, Math.max(0, x))) * 4;
        pixels.set(tile.pixels.subarray(from, from + 4), ((s.y + y) * width + s.x + x) * 4);
      }
  }
  const effects = baseline.effects.map((effect) => {
    const replacement = replacements.get(effect.name);
    if (!replacement) return effect;
    const groups = (replacement.groups as Array<Record<string, unknown>>).map((group) => ({
      ...group,
      particles: (group.particles as Array<Record<string, unknown>>).map((particle) => {
        const sprite = remap.get(particle.sprite as number);
        if (sprite === undefined) throw new Error("Unmapped delta sprite");
        return { ...particle, sprite };
      }),
    }));
    return {
      ...replacement,
      groups: retainGroups.has(String(effect.name)) ? [...groups, ...(effect.groups as unknown[])] : groups,
    };
  });
  const affected = effects
    .filter((effect, index) => JSON.stringify(effect) !== JSON.stringify(baseline.effects[index]))
    .map((e) => e.name);
  return {
    data: { ...baseline, width, height, sprites, effects },
    png: encodeRgbaPng({ width, height, pixels }),
    affected,
    fitted: [...replacements.keys()],
    reusedSprites: reused,
    appendedSprites: additions.length,
    protectedSprites: [...protectedSprites],
    reclaimedUnusedSprites: baseline.sprites.length - protectedSprites.size,
  };
}
