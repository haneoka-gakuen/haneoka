import { decodePng, encodeRgbaPng } from "./textureBake.ts";
import { packRectangles } from "./rectanglePacking.ts";
import type { ParticleData } from "./merge.ts";
import { createHash } from "node:crypto";

type TintParticle = Record<string, unknown> & { sprite: number; color: string };
type TintGroup = Record<string, unknown> & { particles: TintParticle[] };

/** Share constant-colour masks while retaining every source RGBA byte after tinting. */
function factorConstantTints(data: ParticleData, png: Buffer, decode: typeof decodePng) {
  const image = decode(png, "particle tint input"),
    pixels = new Uint8Array(image.pixels);
  const used = [
    ...new Set(
      data.effects.flatMap((effect) =>
        (effect.groups as TintGroup[]).flatMap((group) => group.particles.map((particle) => particle.sprite)),
      ),
    ),
  ];
  const aliases = new Map<number, number>(),
    tints = new Map<number, string>(),
    masks = new Map<string, number>();
  for (const index of used) {
    const sprite = data.sprites[index]!,
      bytes = new Uint8Array(sprite.w * sprite.h * 4);
    for (let y = 0; y < sprite.h; y++)
      bytes.set(
        image.pixels.subarray(
          ((sprite.y + y) * image.width + sprite.x) * 4,
          ((sprite.y + y) * image.width + sprite.x + sprite.w) * 4,
        ),
        y * sprite.w * 4,
      );
    const eligible = data.effects.every((effect) =>
      (effect.groups as TintGroup[]).every((group) =>
        group.particles.every((particle) => particle.sprite !== index || /^#(?:fff|ffffff)$/i.test(particle.color)),
      ),
    );
    let colour: number[] | undefined,
      constant = eligible;
    for (let pixel = 0; constant && pixel < bytes.length; pixel += 4) {
      const rgb = [...bytes.subarray(pixel, pixel + 3)];
      if (rgb.every((value) => value === 0)) continue;
      if (!colour) colour = rgb;
      else if (rgb.some((value, channel) => value !== colour![channel])) constant = false;
    }
    if (constant && colour) {
      for (let pixel = 0; pixel < bytes.length; pixel += 4) {
        const value = bytes[pixel] || bytes[pixel + 1] || bytes[pixel + 2] ? 255 : 0;
        for (let channel = 0; channel < 3; channel++) bytes[pixel + channel] = value;
      }
      tints.set(index, "#" + colour.map((value) => value.toString(16).padStart(2, "0")).join(""));
      for (let y = 0; y < sprite.h; y++)
        pixels.set(
          bytes.subarray(y * sprite.w * 4, (y + 1) * sprite.w * 4),
          ((sprite.y + y) * image.width + sprite.x) * 4,
        );
    }
    const key = `${sprite.w}:${sprite.h}:${createHash("sha256").update(bytes).digest("hex")}`;
    const previous = masks.get(key);
    if (previous === undefined) masks.set(key, index);
    aliases.set(index, previous ?? index);
  }
  return {
    data: {
      ...data,
      effects: data.effects.map((effect) => ({
        ...effect,
        groups: (effect.groups as TintGroup[]).map((group) => ({
          ...group,
          particles: group.particles.map((particle) => ({
            ...particle,
            sprite: aliases.get(particle.sprite)!,
            color: tints.get(particle.sprite) ?? particle.color,
          })),
        })),
      })),
    },
    png: encodeRgbaPng({ width: image.width, height: image.height, pixels }),
  };
}

export class ParticleAtlasCapacityError extends Error {}

/** Remove unreachable sprite table entries after every delta has been applied. */
export function compactUnusedParticleSprites(data: ParticleData): ParticleData {
  const indices = new Map<number, number>();
  const sprites: ParticleData["sprites"] = [];
  const effects = data.effects.map((effect) => ({
    ...effect,
    groups: (effect.groups as TintGroup[]).map((group) => ({
      ...group,
      particles: group.particles.map((particle) => {
        const old = particle.sprite;
        let index = indices.get(old);
        if (index === undefined) {
          index = sprites.length;
          indices.set(old, index);
          sprites.push(data.sprites[old]!);
        }
        return { ...particle, sprite: index };
      }),
    })),
  }));
  return { ...data, effects, sprites };
}

/** Keep effect definitions and sprite indices while relocating live RGBA tiles. */
export function repackParticleAtlas(
  data: ParticleData,
  png: Buffer,
  size = 1024,
  options: {
    denseSearch?: boolean;
    decode?: typeof decodePng;
    factorConstantTint?: boolean;
    maximumHeight?: number;
  } = {},
) {
  if (options.factorConstantTint) {
    const factored = factorConstantTints(data, png, options.decode ?? decodePng);
    return repackParticleAtlas(factored.data, factored.png, size, { ...options, factorConstantTint: false });
  }
  const image = (options.decode ?? decodePng)(png, "particle repack input");
  const used = [
    ...new Set(
      data.effects.flatMap((effect) =>
        (effect.groups as Array<{ particles: Array<{ sprite: number }> }>).flatMap((group) =>
          group.particles.map((particle) => particle.sprite),
        ),
      ),
    ),
  ].sort((a, b) => a - b);
  const rects = used.map((index) => ({ width: data.sprites[index]!.w + 2, height: data.sprites[index]!.h + 2 }));
  // Unreferenced indices share a transparent sentinel; no effect points at it.
  rects.push({ width: 3, height: 3 });
  let height = size;
  let positions = packRectangles(rects, size, options.denseSearch, height);
  while (!positions && height + 16 <= (options.maximumHeight ?? size)) {
    height += 16;
    positions = packRectangles(rects, size, options.denseSearch, height);
  }
  if (!positions)
    throw new ParticleAtlasCapacityError(
      `Referenced particle tiles do not fit ${size}×${options.maximumHeight ?? size} (${rects.reduce((n, r) => n + r.width * r.height, 0)} texels)`,
    );
  const pixels = new Uint8Array(size * height * 4),
    sentinel = positions.at(-1)!;
  const sprites = data.sprites.map(() => ({ x: sentinel.x + 1, y: sentinel.y + 1, w: 1, h: 1 }));
  used.forEach((index, slot) => {
    const from = data.sprites[index]!,
      to = { x: positions[slot]!.x + 1, y: positions[slot]!.y + 1, w: from.w, h: from.h };
    sprites[index] = to;
    for (let y = -1; y <= from.h; y++)
      for (let x = -1; x <= from.w; x++) {
        const a =
          ((from.y + Math.min(from.h - 1, Math.max(0, y))) * image.width +
            from.x +
            Math.min(from.w - 1, Math.max(0, x))) *
          4;
        pixels.set(image.pixels.subarray(a, a + 4), ((to.y + y) * size + to.x + x) * 4);
      }
  });
  return {
    data: { ...data, width: size, height, sprites },
    png: encodeRgbaPng({ width: size, height, pixels }),
    liveSprites: used.length,
  };
}
