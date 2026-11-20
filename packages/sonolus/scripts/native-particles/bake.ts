// Sprite tiles for native Sonolus particles. Sonolus draws straight-alpha
// sprites with ordinary blending and has no HDR target, so each tile carries
// the web renderer's final look for one textured quad at one emission colour:
// HDR emission (MobileAddHdrColor) plus the LiveUrpBloom halo, tone-clamped
// exactly like the composite pass, then encoded as emission-on-black.

import { readFileSync } from "node:fs";
import { decodeRgba8Png } from "../pack-original-note-skins.ts";
import { encodeRgbaPng } from "./textureBake.ts";
import type { CarrierMoments } from "./trajectory.ts";

interface RgbaImage {
  width: number;
  height: number;
  pixels: Uint8Array;
}

/** LiveGameVolume Bloom: threshold 1.2 (gamma), intensity 5, scatter .7 -> .68. */
const BLOOM_THRESHOLD = Math.pow(1.2, 2.2);
const BLOOM_KNEE = BLOOM_THRESHOLD * 0.5;
const BLOOM_INTENSITY = 5;
const BLOOM_SCATTER = 0.05 + 0.9 * 0.7;
/**
 * Effective Gaussian radii (screen px at 1080p) of the five-mip pyramid. The
 * prefilter halves resolution; each later mip applies the 9-tap (sigma 3.4
 * source texels) and 5-tap (sigma 1.6 target texels) passes, i.e. about
 * 6.7 * 2^(i-1) px, accumulated in quadrature.
 */
export const BLOOM_SIGMAS = [1, 7, 15, 31, 62] as const;
/** LQ upsample: final = sum (1-s) s^i D_i, the last mip keeps s^(n-1). */
export const BLOOM_WEIGHTS = BLOOM_SIGMAS.map((_, index, list) =>
  index === list.length - 1 ? BLOOM_SCATTER ** index : (1 - BLOOM_SCATTER) * BLOOM_SCATTER ** index,
);
/**
 * Mip 0 is baked into sprites. Mip 1 is a fixed-size halo particle beside each
 * sprite (a PSF scaled by the sprite's flux); mips 2.. form one glow particle
 * per effect. Large rigs (walls, frames, pillars) bake mips 0 and 1.
 */
const SPRITE_MIPS = 1;
/** Rig halo particles bake mips 1..RIG_HALO_MIPS of the rig sprite itself. */
export const RIG_HALO_MIPS = 3;
// A per-tile halo swamps thin rig parts (the 9-slice frame borders) and seams
// between neighbouring tiles; rigs bake mip 0 and mip 1 joins the glow.
const RIG_MIPS = 1;
export const bloomPrefilter = (brightness: number): number => {
  const rq = brightness - BLOOM_THRESHOLD;
  let soft = Math.min(Math.max(rq + BLOOM_KNEE, 0), 2 * BLOOM_KNEE);
  soft = (soft * soft) / (4 * BLOOM_KNEE + 1e-4);
  return Math.max(rq, soft) / Math.max(brightness, 1e-4);
};
const RESPONSE_STEPS = 8;
/** Screen-space halo margin kept around every sprite tile. */
const bloomPad = (mips: number): number => (mips > 0 ? 2.5 * BLOOM_SIGMAS[mips - 1]! : 0);

export const SPRITE_BLOOM_MIPS = SPRITE_MIPS;
export const RIG_BLOOM_MIPS = RIG_MIPS;

export const srgbToLinear = (c: number): number => c * (c * (c * 0.305306011 + 0.682171111) + 0.012522878);
export const linearToSrgb = (c: number): number =>
  Math.min(1, Math.max(0, 1.055 * Math.pow(Math.abs(c), 0.416666657) - 0.055));

export interface TileRequest {
  key: string;
  file: string;
  uv: readonly [number, number, number, number];
  /** Reference HDR emission colour (includes material tint and alpha). */
  emission: readonly [number, number, number];
  /** Typical on-screen sprite height in 1080p pixels. */
  screenHeight: number;
  /** Sprite aspect on screen (width / height). */
  screenAspect: number;
  /** Bloom mips baked into the tile (0 for lane fills, drawn before bloom). */
  mips: number;
  /** First mip (a halo tile bakes mips `mipFrom..mips` without the sprite itself). */
  mipFrom?: number;
  /** Screen px per effect-camera px (1 / effectRenderingScale). */
  sigmaScale?: number;
  /** Bloom margin only on these sides (left, right, bottom, top); 9-slice joins get none. */
  padSides?: readonly [boolean, boolean, boolean, boolean];
  /** Screen-pixel radius budget for bloom carried by the same billboard. */
  maxBloomPadding?: number;
  /** Upper bound of tile px per screen px (smooth gradients need less). */
  maxDensity?: number;
  /** Bloom calibration multiplier. */
  bloomGain: number;
  /** Mobile LDR fallback: whiten only the original high-value core texels. */
  whitenCore?: boolean;
  /** Source bloom colours confined to the original covered core; alpha and bounds stay unchanged. */
  coreBloomMips?: number;
}

export interface Tile {
  key: string;
  image: RgbaImage;
  /** Particle half-size multipliers covering the halo margin. */
  expand: readonly [number, number];
  /** Tile centre relative to the sprite centre, in sprite sizes (+u, +v). */
  offset: readonly [number, number];
  /** Brightness response: alpha multiplier for relative emission g in [0, 1] (RESPONSE_STEPS grid). */
  response: Float32Array;
}

/** Area-filter premultiplied pixels while retaining the tile's exact geometric bounds. */
export function downsamplePremultipliedTile(tile: Tile, factor = 2, verticalFactor = factor): Tile {
  if ([factor, verticalFactor].some((value) => value < 1 || !Number.isFinite(value)))
    throw new Error("Invalid tile downsampling factor");
  const source = tile.image;
  const width = Math.max(1, Math.ceil(source.width / factor));
  const height = Math.max(1, Math.ceil(source.height / verticalFactor));
  const pixels = new Uint8Array(width * height * 4), sx = source.width / width, sy = source.height / height;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const totals = [0, 0, 0, 0], x0 = x * sx, x1 = (x + 1) * sx, y0 = y * sy, y1 = (y + 1) * sy;
    for (let py = Math.floor(y0); py < Math.ceil(y1) && py < source.height; py++)
      for (let px = Math.floor(x0); px < Math.ceil(x1) && px < source.width; px++) {
        const weight = (Math.min(x1, px + 1) - Math.max(x0, px)) * (Math.min(y1, py + 1) - Math.max(y0, py));
        const p = (py * source.width + px) * 4, alpha = source.pixels[p + 3]! / 255;
        totals[3]! += alpha * weight;
        for (let c = 0; c < 3; c++) totals[c]! += source.pixels[p + c]! * alpha * weight;
      }
    const p = (y * width + x) * 4;
    pixels[p + 3] = Math.round(totals[3]! / (sx * sy) * 255);
    for (let c = 0; c < 3; c++) pixels[p + c] = totals[3]! > 0 ? Math.round(totals[c]! / totals[3]!) : 0;
  }
  return { ...tile, image: { width, height, pixels } };
}

const sourceCache = new Map<string, RgbaImage>();
function source(file: string): RgbaImage {
  let image = sourceCache.get(file);
  if (!image) {
    const decoded = decodeRgba8Png(readFileSync(file), file);
    image = { width: decoded.width, height: decoded.height, pixels: decoded.pixels };
    sourceCache.set(file, image);
  }
  return image;
}

/** Area-sampled crop of `uv` resized to width x height (straight RGBA floats, alpha-weighted). */
function resample(image: RgbaImage, uv: readonly number[], width: number, height: number): Float32Array {
  const [u0, v0, u1, v1] = uv as [number, number, number, number];
  // PNG row 0 is the top of the texture (v = 1).
  const x0 = u0 * image.width;
  const x1 = u1 * image.width;
  const y0 = (1 - v1) * image.height;
  const y1 = (1 - v0) * image.height;
  const out = new Float32Array(width * height * 4);
  const sx = (x1 - x0) / width;
  const sy = (y1 - y0) / height;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      const fx0 = x0 + x * sx;
      const fy0 = y0 + y * sy;
      const steps = Math.max(1, Math.ceil(Math.max(sx, sy)));
      for (let j = 0; j < steps; j += 1) {
        for (let i = 0; i < steps; i += 1) {
          const px = Math.min(image.width - 1, Math.max(0, Math.floor(fx0 + ((i + 0.5) / steps) * sx)));
          const py = Math.min(image.height - 1, Math.max(0, Math.floor(fy0 + ((j + 0.5) / steps) * sy)));
          const o = (py * image.width + px) * 4;
          const alpha = image.pixels[o + 3]! / 255;
          r += (image.pixels[o]! / 255) * alpha;
          g += (image.pixels[o + 1]! / 255) * alpha;
          b += (image.pixels[o + 2]! / 255) * alpha;
          a += alpha;
          n += 1;
        }
      }
      const o = (y * width + x) * 4;
      // Premultiplied texel.rgb * texel.a: exactly what additive blending adds.
      out[o] = r / n;
      out[o + 1] = g / n;
      out[o + 2] = b / n;
      out[o + 3] = a / n;
    }
  }
  return out;
}

function blur(input: Float32Array, width: number, height: number, sigma: number): Float32Array {
  if (sigma < 0.3) return Float32Array.from(input);
  const radius = Math.ceil(sigma * 3);
  const kernel = Array.from({ length: radius * 2 + 1 }, (_, i) => Math.exp(-((i - radius) ** 2) / (2 * sigma * sigma)));
  const sum = kernel.reduce((a, b) => a + b, 0);
  for (let i = 0; i < kernel.length; i += 1) kernel[i] = kernel[i]! / sum;
  const tmp = new Float32Array(input.length);
  const out = new Float32Array(input.length);
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1)
      for (let c = 0; c < 3; c += 1) {
        let v = 0;
        for (let k = -radius; k <= radius; k += 1) {
          const xx = x + k;
          if (xx < 0 || xx >= width) continue;
          v += input[(y * width + xx) * 3 + c]! * kernel[k + radius]!;
        }
        tmp[(y * width + x) * 3 + c] = v;
      }
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1)
      for (let c = 0; c < 3; c += 1) {
        let v = 0;
        for (let k = -radius; k <= radius; k += 1) {
          const yy = y + k;
          if (yy < 0 || yy >= height) continue;
          v += tmp[(yy * width + x) * 3 + c]! * kernel[k + radius]!;
        }
        out[(y * width + x) * 3 + c] = v;
      }
  return out;
}

/** HDR emission -> final composite colour (per channel, 0..1). */
function composite(
  emission: Float32Array,
  width: number,
  height: number,
  scale: number,
  bloomGain: number,
  mips: number,
  mipFrom = 0,
  haloOnly = mipFrom > 0,
  sigmaScale = 1,
): Float32Array {
  const pixels = width * height;
  const bloom = new Float32Array(pixels * 3);
  if (mips > mipFrom) {
    const prefiltered = new Float32Array(pixels * 3);
    for (let p = 0; p < pixels; p += 1) {
      const r = emission[p * 3]!;
      const g = emission[p * 3 + 1]!;
      const b = emission[p * 3 + 2]!;
      const brightness = Math.max(r, g, b);
      const rq = brightness - BLOOM_THRESHOLD;
      let soft = Math.min(Math.max(rq + BLOOM_KNEE, 0), 2 * BLOOM_KNEE);
      soft = (soft * soft) / (4 * BLOOM_KNEE + 1e-4);
      const contribution = Math.max(rq, soft) / Math.max(brightness, 1e-4);
      prefiltered[p * 3] = r * contribution;
      prefiltered[p * 3 + 1] = g * contribution;
      prefiltered[p * 3 + 2] = b * contribution;
    }
    BLOOM_SIGMAS.slice(mipFrom, mips).forEach((sigma, offset) => {
      const index = mipFrom + offset;
      const layer = blur(prefiltered, width, height, sigma * sigmaScale * scale);
      const weight = BLOOM_WEIGHTS[index]! * BLOOM_INTENSITY * bloomGain;
      for (let i = 0; i < bloom.length; i += 1) bloom[i] = bloom[i]! + layer[i]! * weight;
    });
  }
  const out = new Float32Array(pixels * 3);
  for (let i = 0; i < out.length; i += 1)
    out[i] = haloOnly
      ? linearToSrgb(Math.min(1, bloom[i]!))
      : linearToSrgb(Math.min(1, srgbToLinear(Math.min(emission[i]!, 64)) + bloom[i]!));
  return out;
}

export function bakeTile(request: TileRequest): Tile {
  const image = source(request.file);
  const [u0, v0, u1, v1] = request.uv;
  const cropWidth = Math.max(1, (u1 - u0) * image.width);
  const cropHeight = Math.max(1, (v1 - v0) * image.height);
  const screenHeight = Math.max(1, request.screenHeight);
  const screenWidth = Math.max(1, screenHeight * request.screenAspect);
  const naturalPad = bloomPad(request.mips) * (request.sigmaScale ?? 1);
  const pad = Math.min(naturalPad, request.maxBloomPadding ?? naturalPad);
  // Tile pixels per screen pixel: at least the 1080p footprint (1.5x for
  // high-DPI phones), never above the source texels, bounded tile size.
  const scale = Math.min(
    (request.mipFrom ?? 0) > 0
      ? 0.5
      : Math.min(
          request.maxDensity ?? 2,
          Math.max(1.5, Math.min(2, cropHeight / screenHeight, cropWidth / screenWidth)),
        ),
    384 / (screenHeight + 2 * pad),
    384 / (screenWidth + 2 * pad),
  );
  const spriteWidth = Math.max(2, Math.round(screenWidth * scale));
  const spriteHeight = Math.max(2, Math.round(screenHeight * scale));
  const padPixels = Math.round(pad * scale);
  const sides = request.padSides ?? [true, true, true, true];
  const padLeft = sides[0] ? padPixels : 0;
  const padRight = sides[1] ? padPixels : 0;
  const padBottom = sides[2] ? padPixels : 0;
  const padTop = sides[3] ? padPixels : 0;
  const width = spriteWidth + padLeft + padRight;
  const height = spriteHeight + padBottom + padTop;
  const feather = pad < naturalPad && padPixels > 0
    ? Float32Array.from({ length: width * height }, (_, p) => {
        const x = p % width, y = Math.floor(p / width);
        const edge = Math.min(
          padLeft ? x : Infinity,
          padRight ? width - 1 - x : Infinity,
          padTop ? y : Infinity,
          padBottom ? height - 1 - y : Infinity,
        );
        const opacity = Math.min(1, edge / Math.max(1, padPixels * 0.25));
        return opacity * opacity * (3 - 2 * opacity);
      })
    : undefined;
  const texels = resample(image, request.uv, spriteWidth, spriteHeight);
  const unit = new Float32Array(width * height * 3);
  for (let y = 0; y < spriteHeight; y += 1)
    for (let x = 0; x < spriteWidth; x += 1)
      for (let c = 0; c < 3; c += 1)
        unit[((y + padTop) * width + x + padLeft) * 3 + c] = texels[(y * spriteWidth + x) * 4 + c]!;
  const withEmission = (gain: number): Float32Array => {
    const emission = new Float32Array(unit.length);
    for (let i = 0; i < unit.length; i += 1) emission[i] = unit[i]! * request.emission[i % 3]! * gain;
    return emission;
  };
  const mipFrom = request.mipFrom ?? 0;
  const final = composite(
    withEmission(1),
    width,
    height,
    scale,
    request.bloomGain,
    request.mips,
    mipFrom,
    mipFrom > 0,
    request.sigmaScale ?? 1,
  );
  const coreBloom = request.coreBloomMips ? composite(withEmission(1), width, height, scale,
    request.bloomGain, request.coreBloomMips, 0, false, request.sigmaScale ?? 1) : undefined;
  let pixels = new Uint8Array(width * height * 4);
  let reference = 0;
  let referencePeak = 0;
  const hdrPeak = Math.max(...request.emission);
  const coreStrength = request.whitenCore ? 0.9 * Math.min(1, Math.max(0, hdrPeak - 1)) : 0;
  for (let p = 0; p < width * height; p += 1) {
    const edge = feather?.[p] ?? 1;
    let r = final[p * 3]! * edge;
    let g = final[p * 3 + 1]! * edge;
    let b = final[p * 3 + 2]! * edge;
    const alpha = Math.max(r, g, b);
    referencePeak = Math.max(referencePeak, alpha);
    reference += r + g + b;
    if (coreBloom && alpha > .5) {
      const coverage = Math.min(1, (alpha - .5) * 2);
      const weight = coverage * coverage * (3 - 2 * coverage);
      r += (Math.min(alpha, coreBloom[p * 3]!) - r) * weight;
      g += (Math.min(alpha, coreBloom[p * 3 + 1]!) - g) * weight;
      b += (Math.min(alpha, coreBloom[p * 3 + 2]!) - b) * weight;
    }
    // Preserve alpha, visible bounds and the original coloured fringe. This
    // replaces lost HDR accumulation with a white core, without a blur quad.
    if (coreStrength > 0 && alpha > 0) {
      const radiance = Math.max(
        unit[p * 3]! * request.emission[0],
        unit[p * 3 + 1]! * request.emission[1],
        unit[p * 3 + 2]! * request.emission[2],
      );
      const high = Math.min(1, Math.max(0, (radiance - BLOOM_THRESHOLD) / BLOOM_THRESHOLD));
      const white = high * high * (3 - 2 * high) * coreStrength;
      r += (alpha - r) * white;
      g += (alpha - g) * white;
      b += (alpha - b) * white;
    }
    pixels[p * 4] = alpha > 0 ? Math.round((r / alpha) * 255) : 0;
    pixels[p * 4 + 1] = alpha > 0 ? Math.round((g / alpha) * 255) : 0;
    pixels[p * 4 + 2] = alpha > 0 ? Math.round((b / alpha) * 255) : 0;
    pixels[p * 4 + 3] = Math.round(alpha * 255);
  }
  // Crop to the visible bounds (most effect textures are a thin shape in a
  // large transparent square); the quad follows through `offset`/`expand`.
  let x0 = width;
  let y0 = height;
  let x1 = 0;
  let y1 = 0;
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1)
      if (pixels[(y * width + x) * 4 + 3]! > 0) {
        if (x < x0) x0 = x;
        if (y < y0) y0 = y;
        if (x + 1 > x1) x1 = x + 1;
        if (y + 1 > y1) y1 = y + 1;
      }
  if (x1 <= x0 || y1 <= y0) {
    x0 = 0;
    y0 = 0;
    x1 = 1;
    y1 = 1;
  }
  const cropped = new Uint8Array((x1 - x0) * (y1 - y0) * 4);
  for (let y = y0; y < y1; y += 1)
    cropped.set(pixels.subarray((y * width + x0) * 4, (y * width + x1) * 4), (y - y0) * (x1 - x0) * 4);
  pixels = cropped;
  const offset: [number, number] = [
    ((x0 + x1) / 2 - (padLeft + spriteWidth / 2)) / spriteWidth,
    // Image row 0 is the sprite's +v (top) edge.
    (padTop + spriteHeight / 2 - (y0 + y1) / 2) / spriteHeight,
  ];
  // Relative brightness response on a coarse grid (bloom is recomputed per step).
  const response = new Float32Array(RESPONSE_STEPS + 1);
  response[RESPONSE_STEPS] = 1;
  for (let step = 1; step < RESPONSE_STEPS; step += 1) {
    const composed = composite(
      withEmission(step / RESPONSE_STEPS),
      width,
      height,
      scale,
      request.bloomGain,
      request.mips,
      mipFrom,
      mipFrom > 0,
      request.sigmaScale ?? 1,
    );
    let total = 0;
    let peak = 0;
    for (let i = 0; i < composed.length; i += 1) {
      const value = composed[i]! * (feather?.[Math.floor(i / 3)] ?? 1);
      total += value;
      peak = Math.max(peak, value);
    }
    const meanResponse = reference > 0 ? total / reference : step / RESPONSE_STEPS;
    // HDR retains a clipped bright centre while the fringe fades. A single
    // LDR sprite cannot reproduce that per-pixel response with mean alpha.
    const peakResponse = referencePeak > 0 ? peak / referencePeak : meanResponse;
    response[step] = Math.min(1, coreStrength > 0 ? 0.25 * meanResponse + 0.75 * peakResponse : meanResponse);
  }
  return {
    key: request.key,
    image: { width: x1 - x0, height: y1 - y0, pixels },
    expand: [(x1 - x0) / spriteWidth, (y1 - y0) / spriteHeight],
    offset,
    response,
  };
}

export function responseAt(tile: Tile, g: number): number {
  const x = Math.max(0, Math.min(1, g)) * RESPONSE_STEPS;
  const i = Math.min(RESPONSE_STEPS - 1, Math.floor(x));
  const f = x - i;
  return tile.response[i]! * (1 - f) + tile.response[i + 1]! * f;
}

/** A small HDR exposure palette on one unchanged Source UV crop. */
export function bakeCarrierBasisSet(request: TileRequest, exposures: readonly number[], steps = 64) {
  if (!exposures.length || exposures.some((g) => !Number.isFinite(g) || g <= 0 || g > 1) || steps < 2)
    throw new Error("Carrier exposure bases require positive normalized exposure levels");
  const raw = source(request.file), width = Math.round((request.uv[2] - request.uv[0]) * raw.width),
    height = Math.round((request.uv[3] - request.uv[1]) * raw.height);
  const at = (gain: number): RgbaImage => {
    const tile = bakeTile({ ...request, key: `${request.key}|exposure${gain}`,
      emission: request.emission.map((v) => v * gain) as [number, number, number] });
    const pixels = new Uint8Array(width * height * 4),
      x0 = Math.round((width - tile.image.width) / 2 + tile.offset[0] * width),
      y0 = Math.round((height - tile.image.height) / 2 - tile.offset[1] * height);
    if (x0 < 0 || y0 < 0 || x0 + tile.image.width > width || y0 + tile.image.height > height)
      throw new Error("Carrier exposure palette changed its Source UV crop");
    for (let y = 0; y < tile.image.height; y++) pixels.set(
      tile.image.pixels.subarray(y * tile.image.width * 4, (y + 1) * tile.image.width * 4),
      ((y + y0) * width + x0) * 4);
    return { width, height, pixels };
  };
  const tiles: Tile[] = exposures.map((gain) => ({ key: `${request.key}|basis${gain}`, image: at(gain),
    expand: [1, 1], offset: [0, 0], response: new Float32Array(9).fill(1) }));
  const targets = Array.from({ length: steps + 1 }, (_, i) => at(i / steps));
  const moments: CarrierMoments[][] = tiles.map((tile) => targets.map((target) => {
    const square = [0, 0, 0], dot = [0, 0, 0], peak = [0, 0, 0]; let energy = 0;
    for (let pixel = 0; pixel < target.pixels.length; pixel += 4) {
      const desired = [0, 1, 2].map((c) => target.pixels[pixel + c]! * target.pixels[pixel + 3]! / 65025),
        carrier = [0, 1, 2].map((c) => tile.image.pixels[pixel + c]! * tile.image.pixels[pixel + 3]! / 65025),
        weight = 1 + 128 * Math.max(...desired) ** 8;
      for (let c = 0; c < 3; c++) {
        peak[c] = Math.max(peak[c]!, desired[c]!); energy += weight * desired[c]! ** 2;
        square[c]! += weight * carrier[c]! ** 2; dot[c]! += weight * carrier[c]! * desired[c]!;
      }
    }
    const normalization = width * height * 3;
    return { target: energy / normalization, peak: peak as [number, number, number],
      square: square.map((v) => v / normalization) as [number, number, number],
      dot: dot.map((v) => v / normalization) as [number, number, number] };
  }));
  const peaks = tiles.map((tile) => {
    const peak = [0, 0, 0];
    for (let pixel = 0; pixel < tile.image.pixels.length; pixel += 4) for (let c = 0; c < 3; c++)
      peak[c] = Math.max(peak[c]!, tile.image.pixels[pixel + c]! * tile.image.pixels[pixel + 3]! / 65025);
    return peak as [number, number, number];
  });
  return { tiles, moments, peaks, exposures, steps };
}

export interface HdrCarrierPair {
  /** Relative emission at which the first source texel reaches unit value. */
  critical: number;
  body: Tile;
  /** Full exposed image on the same unexpanded source crop. */
  peak: Tile;
  /** Minimal source-over supplement completing the peak composite. */
  core?: Tile;
}

export interface HdrCarrierResponse {
  emission: number;
  bodyAlpha: number;
  coreAlpha: number;
  coreTint: readonly [number, number, number];
  rms: number;
  maxRgbError?: readonly [number, number, number];
}

/** Fit the final composite, including sequential channel saturation, before serializing cheap native curves. */
export function fitHdrCarrierResponse(
  request: TileRequest,
  pair: HdrCarrierPair,
  emissionAt: (relative: number) => readonly [number, number, number],
  steps = 32,
  whiteCorePriority = false,
  preserveClippedCore = false,
): HdrCarrierResponse[] {
  const { width, height } = pair.body.image;
  return fitHdrCarrierSamples(pair, (emission, index) => {
    const tile = bakeTile({ ...request, key: `${request.key}|response${index}`, emission: emissionAt(emission) });
    const target = new Uint8Array(width * height * 4);
    const x0 = Math.round((width - tile.image.width) / 2 + tile.offset[0] * width);
    const y0 = Math.round((height - tile.image.height) / 2 - tile.offset[1] * height);
    if (x0 < 0 || y0 < 0 || x0 + tile.image.width > width || y0 + tile.image.height > height) throw new Error("HDR response UV changed");
    for (let y = 0; y < tile.image.height; y++)
      for (let x = 0; x < tile.image.width; x++)
        target.set(tile.image.pixels.subarray((y * tile.image.width + x) * 4, (y * tile.image.width + x + 1) * 4), ((y + y0) * width + x + x0) * 4);
    return target;
  }, steps, (coordinate) => coordinate, false, whiteCorePriority, preserveClippedCore);
}

/** Fit any shared HDR radiance field without duplicating the carrier optimizer. */
export function fitHdrCarrierSamples(
  pair: HdrCarrierPair,
  targetAt: (emission: number, index: number) => Uint8Array,
  steps = 32,
  amplitudeAt: (coordinate: number) => number = (coordinate) => coordinate,
  fixedCoreTint = false,
  whiteCorePriority = false,
  preserveClippedCore = false,
): HdrCarrierResponse[] {
  const { width: _width, height: _height } = pair.body.image;
  const body = pair.body.image.pixels;
  const core = pair.core?.image.pixels ?? new Uint8Array(body.length);
  const clamp = (v: number, max = 1) => Math.max(0, Math.min(max, v));
  return Array.from({ length: steps + 1 }, (_, index) => {
    const emission = index / steps;
    if (!index) return { emission, bodyAlpha: 0, coreAlpha: 0, coreTint: [1, 1, 1], rms: 0 };
    const target = targetAt(emission, index);
    if (target.length !== body.length) throw new Error("HDR response raster size changed");
    let b2 = 0, b2a = 0, b2a2 = 0, tb = 0, tba = 0, t2 = 0, weight = 0;
    const k2 = [0, 0, 0], bk = [0, 0, 0], bak = [0, 0, 0], tk = [0, 0, 0];
    const targetExcess = [0, 0, 0], referenceExcess = [0, 0, 0];
    let clippedCoreMinimum = 0;
    for (let pixel = 0; pixel < target.length; pixel += 4) {
      const alpha = core[pixel + 3]! / 255;
      const desired = [0, 1, 2].map((c) => (target[pixel + c]! / 255) * (target[pixel + 3]! / 255));
      const peak = [0, 1, 2].map((c) => (body[pixel + c]! / 255) * (body[pixel + 3]! / 255) * (1 - alpha) + (core[pixel + c]! / 255) * alpha);
      const peakLuminance = peak[0]! * .2126 + peak[1]! * .7152 + peak[2]! * .0722;
      const w = whiteCorePriority ? 1 + 128 * peakLuminance ** 8 : 1 + 16 * Math.max(...peak) ** 4;
      const targetLuminance = desired[0]! * .2126 + desired[1]! * .7152 + desired[2]! * .0722;
      if (preserveClippedCore && Math.max(...desired) >= 254 / 255 && targetLuminance >= .85 && peakLuminance > .5)
        clippedCoreMinimum = Math.max(clippedCoreMinimum, Math.max(...desired) / Math.max(...peak));
      for (let c = 0; c < 3; c++) {
        const b = (body[pixel + c]! / 255) * (body[pixel + 3]! / 255), k = (core[pixel + c]! / 255) * alpha, t = desired[c]!;
        b2 += w * b * b; b2a += w * b * b * alpha; b2a2 += w * b * b * alpha * alpha;
        tb += w * t * b; tba += w * t * b * alpha; t2 += w * t * t; weight += w;
        k2[c]! += w * k * k; bk[c]! += w * b * k; bak[c]! += w * b * alpha * k; tk[c]! += w * t * k;
        targetExcess[c]! += w * Math.max(0, t - b);
        referenceExcess[c]! += w * Math.max(0, k - b * alpha);
      }
    }
    if (preserveClippedCore && !pair.core) {
      const alpha = clamp(Math.max(clippedCoreMinimum, tb / Math.max(1e-12, b2)));
      const loss = t2 + alpha * alpha * b2 - 2 * alpha * tb;
      return { emission, bodyAlpha: alpha,
        coreAlpha: 0, coreTint: [1, 1, 1], rms: Math.sqrt(Math.max(0, loss) / Math.max(1, weight)) };
    }
    if (fixedCoreTint && pair.core) {
      const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
      const u = amplitudeAt(emission) <= pair.critical ? clamp(tb / Math.max(1e-12, b2)) : 1;
      const numerator = sum(tk) - tba - sum(bk) + b2a;
      const denominator = sum(k2) - 2 * sum(bak) + b2a2;
      const v = amplitudeAt(emission) <= pair.critical ? 0 : clamp(numerator / Math.max(1e-12, denominator));
      const d2 = b2 - 2 * v * b2a + v * v * b2a2;
      const loss = t2 + u * u * d2 + v * v * sum(k2) - 2 * u * (tb - v * tba)
        - 2 * v * sum(tk) + 2 * u * v * (sum(bk) - v * sum(bak));
      const maximum: [number, number, number] = [0, 0, 0];
      for (let pixel = 0; pixel < target.length; pixel += 4) for (let c = 0; c < 3; c++) {
        const native = u * body[pixel + c]! / 255 * body[pixel + 3]! / 255 * (1 - v * core[pixel + 3]! / 255)
          + v * core[pixel + c]! / 255 * core[pixel + 3]! / 255;
        const original = target[pixel + c]! / 255 * target[pixel + 3]! / 255;
        maximum[c] = Math.max(maximum[c]!, Math.abs(native - original));
      }
      return { emission, bodyAlpha: u, coreAlpha: v, coreTint: [1, 1, 1],
        rms: Math.sqrt(Math.max(0, loss) / Math.max(1, weight)), maxRgbError: maximum };
    }
    if (amplitudeAt(emission) <= pair.critical || !pair.core) {
      const u = clamp(tb / Math.max(1e-12, b2));
      return { emission, bodyAlpha: u, coreAlpha: 0, coreTint: [1, 1, 1], rms: Math.sqrt(Math.max(0, t2 + u * u * b2 - 2 * u * tb) / Math.max(1, weight)) };
    }
    // A fixed peak-weighted channel measure keeps exposure monotonic; colour
    // tint handles the other channels without cancelling the stable body.
    const v = clamp(Math.max(0, ...targetExcess.map((value, c) => referenceExcess[c]! > 1e-9 ? value / referenceExcess[c]! : 0)));
    const d2 = b2 - 2 * v * b2a + v * v * b2a2, td = tb - v * tba;
    const dk = bk.map((b, c) => b - v * bak[c]!);
    const r = tk.map((value, c) => clamp((value - dk[c]!) / Math.max(1e-12, k2[c]!), v));
    const loss = t2 + d2 - 2 * td + r.reduce((n, value, c) => n + value * value * k2[c]! - 2 * value * tk[c]! + 2 * value * dk[c]!, 0);
    return { emission, bodyAlpha: 1, coreAlpha: v, coreTint: r.map((value) => v ? value / v : 1) as [number, number, number], rms: Math.sqrt(Math.max(0, loss) / Math.max(1, weight)) };
  });
}

/** Preserve a saturated HDR nucleus and a coloured dim tail with two LDR sprites. */
export function bakeHdrCarrierPair(request: TileRequest, bodyReference?: Tile): HdrCarrierPair {
  const raw = source(request.file);
  const width = Math.round((request.uv[2] - request.uv[0]) * raw.width);
  const height = Math.round((request.uv[3] - request.uv[1]) * raw.height);
  if (width <= 0 || height <= 0) throw new Error("Empty HDR carrier crop");
  const intrinsic = resample(raw, request.uv, width, height);
  let peak = 0;
  for (let pixel = 0; pixel < width * height; pixel++)
    for (let channel = 0; channel < 3; channel++)
      peak = Math.max(peak, intrinsic[pixel * 4 + channel]! * request.emission[channel]!);
  const critical = Math.min(1, 1 / Math.max(1e-12, peak));
  const pad = (tile: Tile): Uint8Array => {
    const pixels = new Uint8Array(width * height * 4);
    const x0 = Math.round((width - tile.image.width) / 2 + tile.offset[0] * width);
    const y0 = Math.round((height - tile.image.height) / 2 - tile.offset[1] * height);
    if (x0 < 0 || y0 < 0 || x0 + tile.image.width > width || y0 + tile.image.height > height)
      throw new Error("HDR carriers require an unexpanded source UV crop");
    for (let y = 0; y < tile.image.height; y++)
      for (let x = 0; x < tile.image.width; x++)
        pixels.set(
          tile.image.pixels.subarray((y * tile.image.width + x) * 4, (y * tile.image.width + x + 1) * 4),
          ((y0 + y) * width + x0 + x) * 4,
        );
    return pixels;
  };
  const target = pad(bakeTile(request));
  const bodyPixels = bodyReference ? new Uint8Array(bodyReference.image.pixels) : pad(
    bakeTile({ ...request, key: `${request.key}|body`, emission: request.emission.map((v) => v * critical) as [number, number, number] }),
  );
  if (bodyReference && (bodyReference.image.width !== width || bodyReference.image.height !== height)) throw new Error("HDR carrier family crop changed");
  return hdrCarrierPairFromTiles(request.key, critical, { width, height, pixels: bodyPixels }, { width, height, pixels: target });
}

/** Two source-over carriers for a shared raster, independent of the Source texture container. */
export function hdrCarrierPairFromTiles(key: string, critical: number, bodyImage: RgbaImage, targetImage: RgbaImage): HdrCarrierPair {
  const { width, height } = bodyImage;
  if (targetImage.width !== width || targetImage.height !== height) throw new Error("HDR carrier raster size changed");
  const bodyPixels = bodyImage.pixels, target = targetImage.pixels;
  const corePixels = new Uint8Array(target.length);
  let hasCore = false;
  const clamp = (v: number) => Math.max(0, Math.min(1, v));
  for (let pixel = 0; pixel < target.length; pixel += 4) {
    const base = [0, 1, 2].map((c) => (bodyPixels[pixel + c]! * bodyPixels[pixel + 3]!) / 65025);
    const desired = [0, 1, 2].map((c) => (target[pixel + c]! * target[pixel + 3]!) / 65025);
    const alpha = Math.max(0, ...desired.map((value, c) => base[c]! >= 1 - 1e-9 ? 0 : (value - base[c]!) / (1 - base[c]!)));
    for (let channel = 0; channel < 3; channel++)
      corePixels[pixel + channel] = alpha > 0 ? Math.round(clamp((desired[channel]! - base[channel]! * (1 - alpha)) / alpha) * 255) : 0;
    corePixels[pixel + 3] = Math.round(clamp(alpha) * 255);
    hasCore ||= corePixels[pixel + 3]! > 0;
  }
  const tile = (pixels: Uint8Array, name: string): Tile => ({
    key: `${key}|${name}`,
    image: { width, height, pixels },
    expand: [1, 1],
    offset: [0, 0],
    response: new Float32Array(9).fill(1),
  });
  return { critical, body: tile(bodyPixels, "body"), peak: tile(new Uint8Array(target), "peak"), ...(hasCore ? { core: tile(corePixels, "core") } : {}) };
}

/** Lossless three-slice storage for a repeated column run; native geometry retains the full run width. */
export function splitConstantTileColumns(tile: Tile): Tile[] {
  const { width, height, pixels } = tile.image;
  const same = (a: number, b: number) => {
    for (let y = 0; y < height; y++) for (let c = 0; c < 4; c++) if (pixels[(y * width + a) * 4 + c] !== pixels[(y * width + b) * 4 + c]) return false;
    return true;
  };
  let from = 0, to = 0;
  for (let x = 0; x < width;) { let end = x + 1; while (end < width && same(x, end)) end++; if (end - x > to - from) { from = x; to = end; } x = end; }
  if (to - from < 8) return [tile];
  return [[0, from, false], [from, to, true], [to, width, false]].filter(([a,b]) => (b as number) > (a as number)).map(([a,b,middle], index) => {
    const left = a as number, right = b as number, columns = middle ? 1 : right - left, out = new Uint8Array(columns * height * 4);
    for (let y = 0; y < height; y++) out.set(pixels.subarray((y * width + left) * 4, (y * width + left + columns) * 4), y * columns * 4);
    return { ...tile, key: tile.key + "|slice" + index, image: { width: columns, height, pixels: out }, expand: [tile.expand[0] * (right - left) / width, tile.expand[1]], offset: [tile.offset[0] + tile.expand[0] * ((left + right) / (2 * width) - .5), tile.offset[1]] };
  });
}

/** Crop only exactly zero-alpha texels; carry their geometric offset through the existing Tile contract. */
export function trimTile(tile: Tile): Tile {
  const { width, height, pixels } = tile.image;
  let x0 = width, y0 = height, x1 = 0, y1 = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (pixels[(y * width + x) * 4 + 3]! > 0) {
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x + 1); y1 = Math.max(y1, y + 1);
  }
  if (x1 <= x0 || y1 <= y0) return { ...tile, image: { width: 1, height: 1, pixels: new Uint8Array(4) } };
  // Keep the zero-alpha neighbour required by bilinear interpolation at every crop edge.
  x0 = Math.max(0, x0 - 1); y0 = Math.max(0, y0 - 1); x1 = Math.min(width, x1 + 1); y1 = Math.min(height, y1 + 1);
  const w = x1 - x0, h = y1 - y0, cropped = new Uint8Array(w * h * 4);
  for (let y = y0; y < y1; y++) cropped.set(pixels.subarray((y * width + x0) * 4, (y * width + x1) * 4), (y - y0) * w * 4);
  return { ...tile, image: { width: w, height: h, pixels: cropped },
    expand: [tile.expand[0] * w / width, tile.expand[1] * h / height],
    offset: [tile.offset[0] + tile.expand[0] * ((x0 + x1) / (2 * width) - .5), tile.offset[1] + tile.expand[1] * (.5 - (y0 + y1) / (2 * height))],
  };
}

export interface Atlas {
  width: number;
  height: number;
  png: Buffer;
  sprites: Array<{ x: number; y: number; w: number; h: number }>;
  index: Map<string, number>;
}

/** Shelf-pack tiles (1px gutter, edge-extended) into the smallest square power of two. */
export function packAtlas(tiles: readonly Tile[]): Atlas {
  const order = tiles.map((tile, index) => ({ tile, index })).sort((a, b) => b.tile.image.height - a.tile.image.height);
  for (const size of [512, 1024, 2048, 4096]) {
    const placements = new Map<number, { x: number; y: number }>();
    let shelfY = 0;
    let shelfX = 0;
    let shelfHeight = 0;
    let overflow = false;
    for (const { tile, index } of order) {
      const w = tile.image.width + 2;
      const h = tile.image.height + 2;
      if (shelfX + w > size) {
        shelfY += shelfHeight;
        shelfX = 0;
        shelfHeight = 0;
      }
      if (w > size || shelfY + h > size) {
        overflow = true;
        break;
      }
      placements.set(index, { x: shelfX + 1, y: shelfY + 1 });
      shelfX += w;
      shelfHeight = Math.max(shelfHeight, h);
    }
    if (overflow) continue;
    const pixels = new Uint8Array(size * size * 4);
    const sprites: Atlas["sprites"] = [];
    const index = new Map<string, number>();
    tiles.forEach((tile, tileIndex) => {
      const place = placements.get(tileIndex)!;
      const { width, height } = tile.image;
      // Copy with a one-pixel extended border so bilinear filtering never
      // samples a neighbouring tile.
      for (let y = -1; y <= height; y += 1)
        for (let x = -1; x <= width; x += 1) {
          const sx = Math.min(width - 1, Math.max(0, x));
          const sy = Math.min(height - 1, Math.max(0, y));
          const from = (sy * width + sx) * 4;
          const to = ((place.y + y) * size + place.x + x) * 4;
          for (let c = 0; c < 4; c += 1) pixels[to + c] = tile.image.pixels[from + c]!;
        }
      index.set(tile.key, sprites.length);
      sprites.push({ x: place.x, y: place.y, w: width, h: height });
    });
    return { width: size, height: size, png: encodeRgbaPng({ width: size, height: size, pixels }), sprites, index };
  }
  const byKind = new Map<string, { count: number; area: number }>();
  for (const tile of tiles) {
    const kind = tile.key.startsWith("composite|")
      ? tile.key.split("|").slice(0, 3).join("|")
      : tile.key.split("|")[0]!.split("/").pop()!;
    const entry = byKind.get(kind) ?? { count: 0, area: 0 };
    entry.count += 1;
    entry.area += tile.image.width * tile.image.height;
    byKind.set(kind, entry);
  }
  const summary = [...byKind.entries()]
    .sort((a, b) => b[1].area - a[1].area)
    .map(([kind, entry]) => `${kind}: ${entry.count} tiles ${(entry.area / 1e6).toFixed(2)} MPx`);
  throw new Error(`Native particle atlas exceeds 4096x4096\n  ${summary.join("\n  ")}`);
}

/** Mean premultiplied texel colour (texel.rgb * texel.a) over a uv crop. */
export function textureCoverage(file: string, uv: readonly [number, number, number, number]): [number, number, number] {
  const texels = resample(source(file), uv, 16, 16);
  const total = [0, 0, 0];
  for (let i = 0; i < 256; i += 1) for (let c = 0; c < 3; c += 1) total[c]! += texels[i * 4 + c]!;
  return [total[0]! / 256, total[1]! / 256, total[2]! / 256];
}

/** Radial bloom kernels: the per-sprite halo (mip 1) and the per-effect glow (mips 2..). */
export interface BloomKernel {
  sigmas: readonly number[];
  weights: readonly number[];
  /** Half extent of the sprite in screen pixels. */
  extent: number;
  /** Linear radiance at the centre per unit flux (px^2), intensity included. */
  centerGain: number;
}

export const bloomKernel = (from: number, to: number, sigmaScale = 1): BloomKernel => {
  const sigmas = BLOOM_SIGMAS.slice(from, to).map((sigma) => sigma * sigmaScale);
  const weights = BLOOM_WEIGHTS.slice(from, to);
  return {
    sigmas,
    weights,
    extent: 3 * sigmas[sigmas.length - 1]!,
    centerGain:
      BLOOM_INTENSITY * weights.reduce((sum, weight, index) => sum + weight / (2 * Math.PI * sigmas[index]! ** 2), 0),
  };
};
export const HALO_KERNEL = bloomKernel(SPRITE_MIPS, RIG_MIPS);
export const GLOW_KERNEL = bloomKernel(SPRITE_MIPS, BLOOM_SIGMAS.length);
/** Rigs carry mips 1..RIG_HALO_MIPS in their own halo particles; the glow adds the rest. */
export const RIG_GLOW_KERNEL = bloomKernel(RIG_HALO_MIPS, BLOOM_SIGMAS.length);
/** Reference amplitude the radial tiles are baked at (sRGB shape is amplitude dependent). */
export const KERNEL_REFERENCE = 0.25;

export function bakeKernelTile(key: string, bloomKernel: BloomKernel, size = 96): Tile {
  if (!Number.isInteger(size) || size < 8 || size > 384) throw new Error("Invalid bloom kernel size");
  const GLOW_SIGMAS = bloomKernel.sigmas;
  const GLOW_WEIGHTS = bloomKernel.weights;
  const GLOW_EXTENT = bloomKernel.extent;
  const pixels = new Uint8Array(size * size * 4);
  // Linear profile normalised to 1 at the centre, stored at a typical 0.25 amplitude.
  const center = GLOW_WEIGHTS.reduce((sum, weight, index) => sum + weight / GLOW_SIGMAS[index]! ** 2, 0);
  const reference = linearToSrgb(KERNEL_REFERENCE);
  for (let y = 0; y < size; y += 1)
    for (let x = 0; x < size; x += 1) {
      const dx = ((x + 0.5) / size - 0.5) * 2 * GLOW_EXTENT;
      const dy = ((y + 0.5) / size - 0.5) * 2 * GLOW_EXTENT;
      const rho2 = dx * dx + dy * dy;
      let value = 0;
      GLOW_WEIGHTS.forEach((weight, index) => {
        const sigma = GLOW_SIGMAS[index]!;
        value += (weight / sigma ** 2) * Math.exp(-rho2 / (2 * sigma * sigma));
      });
      const alpha = linearToSrgb((value / center) * KERNEL_REFERENCE) / reference;
      const o = (y * size + x) * 4;
      pixels[o] = pixels[o + 1] = pixels[o + 2] = 255;
      pixels[o + 3] = Math.round(Math.min(1, alpha) * 255);
    }
  const response = new Float32Array(RESPONSE_STEPS + 1);
  for (let step = 0; step <= RESPONSE_STEPS; step += 1) response[step] = step / RESPONSE_STEPS;
  return { key, image: { width: size, height: size, pixels }, expand: [1, 1], offset: [0, 0], response };
}

const fluxCache = new Map<string, Float32Array>();
/**
 * Prefiltered bloom flux per unit screen area of one quad: the mean over the
 * crop of prefilter(texel * emission), in linear units.
 */
export function prefilteredFlux(
  file: string,
  uv: readonly [number, number, number, number],
  emission: readonly [number, number, number],
): [number, number, number] {
  const key = `${file}|${uv.join(",")}`;
  let texels = fluxCache.get(key);
  if (!texels) fluxCache.set(key, (texels = resample(source(file), uv, 12, 12)));
  const total: [number, number, number] = [0, 0, 0];
  const count = texels.length / 4;
  for (let i = 0; i < count; i += 1) {
    const r = texels[i * 4]! * emission[0];
    const g = texels[i * 4 + 1]! * emission[1];
    const b = texels[i * 4 + 2]! * emission[2];
    const contribution = bloomPrefilter(Math.max(r, g, b));
    total[0] += r * contribution;
    total[1] += g * contribution;
    total[2] += b * contribution;
  }
  return [total[0] / count, total[1] / count, total[2] / count];
}

/** Particle alpha for a radial kernel tile at linear centre radiance `amplitude`. */
export const kernelAlpha = (amplitude: number): number =>
  Math.min(1, linearToSrgb(Math.max(0, amplitude)) / linearToSrgb(KERNEL_REFERENCE));

/** One textured quad of a composite, corners in screen pixels ((u0,v0) (u1,v0) (u1,v1) (u0,v1)). */
export interface CompositeQuad {
  projection?: {
    originX: number;
    originY: number;
    alphaOrigin: number;
    alphaSlope: number;
    inverseDepths: readonly [number, number, number, number];
  };
  file: string;
  uv: readonly [number, number, number, number];
  emission: readonly [number, number, number];
  corners: ReadonlyArray<readonly [number, number]>;
}

function sampleTexel(image: RgbaImage, u: number, v: number, out: [number, number, number]): void {
  // Bilinear, premultiplied (texel.rgb * texel.a); PNG row 0 is v = 1.
  const x = Math.min(image.width - 1, Math.max(0, u * image.width - 0.5));
  const y = Math.min(image.height - 1, Math.max(0, (1 - v) * image.height - 0.5));
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(image.width - 1, x0 + 1);
  const y1 = Math.min(image.height - 1, y0 + 1);
  const fx = x - x0;
  const fy = y - y0;
  out[0] = out[1] = out[2] = 0;
  for (const [px, py, w] of [
    [x0, y0, (1 - fx) * (1 - fy)],
    [x1, y0, fx * (1 - fy)],
    [x0, y1, (1 - fx) * fy],
    [x1, y1, fx * fy],
  ] as const) {
    const o = (py * image.width + px) * 4;
    const a = image.pixels[o + 3]! / 255;
    out[0] += (image.pixels[o]! / 255) * a * w;
    out[1] += (image.pixels[o + 1]! / 255) * a * w;
    out[2] += (image.pixels[o + 2]! / 255) * a * w;
  }
}

/** Inverse bilinear map of point p in quad (c0 c1 c2 c3); undefined outside. */
export function inverseBilinear(
  corners: ReadonlyArray<readonly [number, number]>,
  px: number,
  py: number,
): [number, number] | undefined {
  const [a, b, c, d] = corners as [
    readonly [number, number],
    readonly [number, number],
    readonly [number, number],
    readonly [number, number],
  ];
  const e = [b[0] - a[0], b[1] - a[1]];
  const f = [d[0] - a[0], d[1] - a[1]];
  const g = [a[0] - b[0] + c[0] - d[0], a[1] - b[1] + c[1] - d[1]];
  const h = [px - a[0], py - a[1]];
  const cross = (x: number[], y: number[]) => x[0]! * y[1]! - x[1]! * y[0]!;
  const k2 = cross(g, f);
  const k1 = cross(e, f) + cross(h, g);
  const k0 = cross(h, e);
  let v: number;
  if (Math.abs(k2) < 1e-9) v = -k0 / k1;
  else {
    const disc = k1 * k1 - 4 * k0 * k2;
    if (disc < 0) return undefined;
    const root = Math.sqrt(disc);
    const v1 = (-k1 - root) / (2 * k2);
    const v2 = (-k1 + root) / (2 * k2);
    v = v1 >= -1e-6 && v1 <= 1 + 1e-6 ? v1 : v2;
  }
  const denomX = e[0]! + g[0]! * v;
  const denomY = e[1]! + g[1]! * v;
  const u = Math.abs(denomX) > Math.abs(denomY) ? (h[0]! - f[0]! * v) / denomX : (h[1]! - f[1]! * v) / denomY;
  if (u < -1e-6 || u > 1 + 1e-6 || v < -1e-6 || v > 1 + 1e-6) return undefined;
  return [u, v];
}

/** Perspective-correct Source triangle UVs after undoing the native plane rectification. */
export function perspectiveUv(quad: CompositeQuad, x: number, y: number): [number, number] | undefined {
  const p = quad.projection!;
  const screen = ([x, y]: readonly [number, number]): [number, number] => {
    const py = y + p.originY;
    return [(x + p.originX) * (p.alphaOrigin + p.alphaSlope * py), py];
  };
  const at = screen([x, y]),
    corners = quad.corners.map(screen);
  const uv = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ];
  for (const ids of [
    [0, 1, 2],
    [0, 2, 3],
  ]) {
    const a = corners[ids[0]!]!,
      b = corners[ids[1]!]!,
      c = corners[ids[2]!]!;
    const den = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
    if (Math.abs(den) < 1e-12) continue;
    const l0 = ((b[1] - c[1]) * (at[0] - c[0]) + (c[0] - b[0]) * (at[1] - c[1])) / den;
    const l1 = ((c[1] - a[1]) * (at[0] - c[0]) + (a[0] - c[0]) * (at[1] - c[1])) / den;
    const weights = [l0, l1, 1 - l0 - l1];
    if (weights.some((w) => w < -1e-7 || w > 1 + 1e-7)) continue;
    let u = 0,
      v = 0,
      total = 0;
    for (let i = 0; i < 3; i++) {
      const id = ids[i]!,
        w = weights[i]! * p.inverseDepths[id]!;
      total += w;
      u += uv[id]![0]! * w;
      v += uv[id]![1]! * w;
    }
    return [u / total, v / total];
  }
  return undefined;
}

/** A bounded pair preserving the current family's HDR saturation response. */
export function bakeRadianceFieldCarrierPair(
  key: string, field: CompositeRadianceField, maximum: readonly [number, number, number],
  bloomGain = 0, mipTo = 0,
): HdrCarrierPair {
  let peak = 0;
  for (let index = 0; index < (field.sourceRaster ?? field).emission.length; index++) peak = Math.max(peak, (field.sourceRaster ?? field).emission[index]! * maximum[index % 3]!);
  const critical = Math.min(1, 1 / Math.max(1e-12, peak));
  const body = bakeRadianceFieldTile(key + "|body", field, maximum.map((v) => v * critical) as [number, number, number], bloomGain, mipTo);
  const target = bakeRadianceFieldTile(key + "|target", field, maximum, bloomGain, mipTo);
  return hdrCarrierPairFromTiles(key, critical, body.image, target.image);
}

/**
 * Bloom halo (mips mipFrom..mipTo) of several quads rendered together, the way
 * the effect camera sees them: emissions add, then the bloom pyramid. Returns
 * a straight-alpha tile and its rectangle in screen pixels.
 */
export interface CompositeRadianceField {
  width: number;
  height: number;
  pixelDensity: number;
  /** Additive Source RGB before LDR clipping and bloom. */
  emission: Float32Array;
  rect: { x0: number; y0: number; x1: number; y1: number };
  sourceFxaa?: boolean;
  sourceRaster?: CompositeRadianceField;
  /** Native target texel -> source render-target texel, before LDR upsampling. */
  sourceCoordinates?: Float32Array;
}

/** Rasterize Source UVs and perspective once; preserve HDR until the material clock is sampled. */
export function rasterizeCompositeRadiance(
  quads: readonly CompositeQuad[],
  pixelDensity: number,
  pad = 0,
  supersample = 1,
  snapToPixelGrid = false,
): CompositeRadianceField {
  if (!quads.length || !(pixelDensity > 0) || !Number.isInteger(supersample) || supersample < 1)
    throw new Error("Invalid composite radiance raster");
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const quad of quads)
    for (const [x, y] of quad.corners) {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  minX -= pad;
  minY -= pad;
  maxX += pad;
  maxY += pad;
  if (snapToPixelGrid) { minX = Math.floor(minX * pixelDensity) / pixelDensity; minY = Math.floor(minY * pixelDensity) / pixelDensity; maxX = Math.ceil(maxX * pixelDensity) / pixelDensity; maxY = Math.ceil(maxY * pixelDensity) / pixelDensity; }
  // Supersample the thin source geometry, then box-reduce to the tile density.
  const fine = pixelDensity * supersample;
  const width = Math.max(2, Math.ceil((maxX - minX) * pixelDensity));
  const height = Math.max(2, Math.ceil((maxY - minY) * pixelDensity));
  const fineWidth = width * supersample;
  const fineHeight = height * supersample;
  const emission = new Float32Array(width * height * 3);
  const texel: [number, number, number] = [0, 0, 0];
  for (const quad of quads) {
    const image = source(quad.file);
    const [u0, v0, u1, v1] = quad.uv;
    // Only the quad's own bounding box (swarm composites hold thousands).
    const qx0 = Math.min(...quad.corners.map(([x]) => x));
    const qx1 = Math.max(...quad.corners.map(([x]) => x));
    const qy0 = Math.min(...quad.corners.map(([, y]) => y));
    const qy1 = Math.max(...quad.corners.map(([, y]) => y));
    const fxFrom = Math.max(0, Math.floor((qx0 - minX) * fine));
    const fxTo = Math.min(fineWidth, Math.ceil((qx1 - minX) * fine) + 1);
    const fyFrom = Math.max(0, Math.floor((maxY - qy1) * fine));
    const fyTo = Math.min(fineHeight, Math.ceil((maxY - qy0) * fine) + 1);
    for (let fy = fyFrom; fy < fyTo; fy += 1)
      for (let fx = fxFrom; fx < fxTo; fx += 1) {
        // Tile rows run top to bottom; screen y grows upwards.
        const px = minX + (fx + 0.5) / fine;
        const py = maxY - (fy + 0.5) / fine;
        const st = quad.projection ? perspectiveUv(quad, px, py) : inverseBilinear(quad.corners, px, py);
        if (!st) continue;
        sampleTexel(image, u0 + (u1 - u0) * st[0], v0 + (v1 - v0) * st[1], texel);
        const o = (Math.floor(fy / supersample) * width + Math.floor(fx / supersample)) * 3;
        const weight = 1 / (supersample * supersample);
        emission[o] = emission[o]! + texel[0] * quad.emission[0] * weight;
        emission[o + 1] = emission[o + 1]! + texel[1] * quad.emission[1] * weight;
        emission[o + 2] = emission[o + 2]! + texel[2] * quad.emission[2] * weight;
      }
  }
  return { width, height, pixelDensity, emission, rect: { x0: minX, y0: minY, x1: maxX, y1: maxY } };
}

/** CPU counterpart of the formal FinalPost FXAA12 pass; all work happens in the producer. */
export function applySourceFxaa(rgb: Float32Array, width: number, height: number, alphaSupport: Float32Array): Float32Array {
  const sample = (x: number, y: number): [number, number, number] => {
    const x0 = Math.floor(x), y0 = Math.floor(y), dx = x - x0, dy = y - y0, result: [number, number, number] = [0, 0, 0];
    for (const [px, py, weight] of [[x0, y0, (1 - dx) * (1 - dy)], [x0 + 1, y0, dx * (1 - dy)], [x0, y0 + 1, (1 - dx) * dy], [x0 + 1, y0 + 1, dx * dy]]) {
      if (px! < 0 || px! >= width || py! < 0 || py! >= height) continue;
      for (let c = 0; c < 3; c++) result[c]! += rgb[(py! * width + px!) * 3 + c]! * weight!;
    }
    return result;
  };
  const brightness = (x: number, y: number) => { const c = sample(x, y); return c[0] * .299 + c[1] * .587 + c[2] * .114; };
  const output = new Float32Array(rgb);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const index = (y * width + x) * 3;
    if (!(alphaSupport[index]! > 0 || alphaSupport[index + 1]! > 0 || alphaSupport[index + 2]! > 0)) continue;
    const mid = brightness(x, y), top = brightness(x, y - 1), bottom = brightness(x, y + 1), left = brightness(x - 1, y), right = brightness(x + 1, y);
    const high = Math.max(mid, top, bottom, left, right), low = Math.min(mid, top, bottom, left, right), contrast = high - low;
    if (contrast < Math.max(.03, high * .15)) continue;
    const tl = brightness(x - 1, y - 1), tr = brightness(x + 1, y - 1), bl = brightness(x - 1, y + 1), br = brightness(x + 1, y + 1);
    const horizontal = 2 * Math.abs(top + bottom - 2 * mid) + Math.abs(tl + bl - 2 * left) + Math.abs(tr + br - 2 * right);
    const vertical = 2 * Math.abs(left + right - 2 * mid) + Math.abs(tl + tr - 2 * top) + Math.abs(bl + br - 2 * bottom);
    const rows = horizontal >= vertical, nearA = rows ? top : right, nearB = rows ? bottom : left, towardA = Math.abs(nearA - mid) >= Math.abs(nearB - mid), neighbor = towardA ? nearA : nearB;
    const average = .5 * (mid + neighbor), gradient = Math.abs(neighbor - mid) * .25;
    const normal = rows ? [0, towardA ? -1 : 1] : [towardA ? 1 : -1, 0], tangent = rows ? [1, 0] : [0, -1];
    const center = [x + normal[0]! * .5, y + normal[1]! * .5], before = [center[0]! - tangent[0]!, center[1]! - tangent[1]!], after = [center[0]! + tangent[0]!, center[1]! + tangent[1]!];
    let beforeDelta = 0, afterDelta = 0, beforeEnded = false, afterEnded = false;
    for (const advance of [1.5, 2, 4, 12]) {
      if (!beforeEnded) { beforeDelta = brightness(before[0]!, before[1]!) - average; beforeEnded = Math.abs(beforeDelta) >= gradient; }
      if (!afterEnded) { afterDelta = brightness(after[0]!, after[1]!) - average; afterEnded = Math.abs(afterDelta) >= gradient; }
      if (beforeEnded && afterEnded) break;
      if (!beforeEnded) { before[0]! -= tangent[0]! * advance; before[1]! -= tangent[1]! * advance; }
      if (!afterEnded) { after[0]! += tangent[0]! * advance; after[1]! += tangent[1]! * advance; }
    }
    const distanceBefore = rows ? x - before[0]! : before[1]! - y, distanceAfter = rows ? after[0]! - x : y - after[1]!;
    const endDelta = distanceBefore < distanceAfter ? beforeDelta : afterDelta;
    let edgeOffset = .5 - Math.min(distanceBefore, distanceAfter) / Math.max(distanceBefore + distanceAfter, .000001);
    if ((endDelta < 0) === (mid < average)) edgeOffset = 0;
    const local = (2 * (top + bottom + left + right) + tl + tr + bl + br) / 12;
    let sub = Math.max(0, Math.min(1, Math.abs(local - mid) / contrast)); sub = sub * sub * (3 - 2 * sub); sub *= sub * .65;
    const offset = Math.max(edgeOffset, sub), filtered = sample(x + normal[0]! * offset, y + normal[1]! * offset);
    output.set(filtered, index);
  }
  return output;
}

function resampleRadiance(source: Float32Array, width: number, height: number, coordinates: Float32Array): Float32Array {
  const out = new Float32Array(coordinates.length / 2 * 3);
  for (let pixel = 0; pixel < coordinates.length / 2; pixel++) {
    const x = coordinates[pixel * 2]!, y = coordinates[pixel * 2 + 1]!, x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
    for (const [px, py, weight] of [[x0, y0, (1 - fx) * (1 - fy)], [x0 + 1, y0, fx * (1 - fy)], [x0, y0 + 1, (1 - fx) * fy], [x0 + 1, y0 + 1, fx * fy]]) {
      if (px! < 0 || px! >= width || py! < 0 || py! >= height) continue;
      for (let channel = 0; channel < 3; channel++) out[pixel * 3 + channel]! += source[(py! * width + px!) * 3 + channel]! * weight!;
    }
  }
  return out;
}

/** Preserve the actual Source RT sampling grid, then pre-warp its LDR result into the Native projection. */
export function rasterizeProjectedRadiance(
  quads: readonly CompositeQuad[],
  sourceDensity: number,
  nativeDensity: number,
  screenOrigin: readonly [number, number],
  pad = 0,
): CompositeRadianceField {
  const transform = (quad: CompositeQuad, x: number, y: number): [number, number] => {
    const p = quad.projection;
    const py = y + (p?.originY ?? 0), px = x + (p?.originX ?? 0);
    return [screenOrigin[0] + px * (p ? p.alphaOrigin + p.alphaSlope * py : 1), screenOrigin[1] + py];
  };
  const projected = quads.map((quad) => ({ ...quad, corners: quad.corners.map(([x, y]) => transform(quad, x, y)),
    ...(quad.projection ? { projection: { originX: 0, originY: 0, alphaOrigin: 1, alphaSlope: 0, inverseDepths: quad.projection.inverseDepths } } : {}),
  }));
  const bloomPad = pad;
  const sourceRaster = { ...rasterizeCompositeRadiance(projected, sourceDensity, bloomPad, 1, true), sourceFxaa: true,
  };
  const target = rasterizeCompositeRadiance(quads, nativeDensity, bloomPad, 1, true);
  const coordinates = new Float32Array(target.width * target.height * 2);
  for (let y = 0; y < target.height; y++) for (let x = 0; x < target.width; x++) {
    const nativeX = target.rect.x0 + (x + .5) / nativeDensity, nativeY = target.rect.y1 - (y + .5) / nativeDensity;
    const [sx, sy] = transform(quads[0]!, nativeX, nativeY), index = (y * target.width + x) * 2;
    coordinates[index] = (sx - sourceRaster.rect.x0) * sourceDensity - .5; coordinates[index + 1] = (sourceRaster.rect.y1 - sy) * sourceDensity - .5;
  }
  return { ...target, sourceRaster, sourceCoordinates: coordinates, emission: resampleRadiance(sourceRaster.emission, sourceRaster.width, sourceRaster.height, coordinates) };
}

/** Remove an exactly empty interior rectangle, retaining at most four disjoint radiance strips. */
export function partitionRadianceField(field: CompositeRadianceField, visiblePixels?: Uint8Array): CompositeRadianceField[] {
  const { width, height } = field;
  const occupied = (x: number, y: number) => {
    const index = (y * width + x) * 3;
    return (visiblePixels?.[(y * width + x) * 4 + 3] ?? 0) > 0 ||
      field.emission[index]! > 0 || field.emission[index + 1]! > 0 || field.emission[index + 2]! > 0;
  };
  let left = width, right = 0, top = height, bottom = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (occupied(x, y)) {
    left = Math.min(left, x); right = Math.max(right, x + 1); top = Math.min(top, y); bottom = Math.max(bottom, y + 1);
  }
  if (right <= left || bottom <= top) return [];
  const columns = new Int32Array(width);
  let hole = { x0: left, x1: left, y0: top, y1: top }, area = 0;
  for (let y = top; y < bottom; y++) {
    for (let x = left; x < right; x++) columns[x] = occupied(x, y) ? 0 : columns[x]! + 1;
    const stack: number[] = [];
    for (let x = left; x <= right; x++) {
      const current = x < right ? columns[x]! : 0;
      while (stack.length && columns[stack.at(-1)!]! > current) {
        const h = columns[stack.pop()!]!, x0 = stack.length ? stack.at(-1)! + 1 : left, candidate = h * (x - x0);
        if (candidate > area) { area = candidate; hole = { x0, x1: x, y0: y + 1 - h, y1: y + 1 }; }
      }
      stack.push(x);
    }
  }
  const boxes = area > (right - left) * (bottom - top) / 4 ? [
    [left, top, right, hole.y0], [left, hole.y1, right, bottom],
    [left, hole.y0, hole.x0, hole.y1], [hole.x1, hole.y0, right, hole.y1],
  ] : [[left, top, right, bottom]];
  return boxes.filter(([x0, y0, x1, y1]) => x1! > x0! && y1! > y0!).map(([x0, y0, x1, y1]) => {
    const w = x1! - x0!, h = y1! - y0!, emission = new Float32Array(w * h * 3);
    const coordinates = field.sourceCoordinates ? new Float32Array(w * h * 2) : undefined;
    for (let y = 0; y < h; y++) emission.set(field.emission.subarray(((y + y0!) * width + x0!) * 3, ((y + y0!) * width + x1!) * 3), y * w * 3);
    if (coordinates) for (let y = 0; y < h; y++) coordinates.set(field.sourceCoordinates!.subarray(((y + y0!) * width + x0!) * 2, ((y + y0!) * width + x1!) * 2), y * w * 2);
    return { width: w, height: h, pixelDensity: field.pixelDensity, emission, ...(coordinates ? { sourceRaster: field.sourceRaster!, sourceCoordinates: coordinates } : {}), rect: {
      x0: field.rect.x0 + x0! / field.pixelDensity, x1: field.rect.x0 + x1! / field.pixelDensity,
      y0: field.rect.y1 - y1! / field.pixelDensity, y1: field.rect.y1 - y0! / field.pixelDensity,
    } };
  });
}

const sourceTransferCache = new WeakMap<CompositeRadianceField, Map<string, Float32Array>>();

/** Apply the current material emission before the shared HDR composite transfer. */
export function bakeRadianceFieldTile(
  key: string,
  field: CompositeRadianceField,
  multiplier: readonly [number, number, number],
  bloomGain = 0,
  mipTo = 0,
  sigmaScale = 1,
): Tile {
  const sourceField = field.sourceRaster ?? field;
  let cache = sourceTransferCache.get(sourceField);
  if (!cache) sourceTransferCache.set(sourceField, (cache = new Map()));
  const cacheKey = [multiplier, bloomGain, mipTo, sigmaScale, sourceField.sourceFxaa].join("|");
  let filtered = cache.get(cacheKey);
  if (!filtered) {
    const current = sourceField.emission.map((value, index) => value * multiplier[index % 3]!);
    const rendered = composite(current, sourceField.width, sourceField.height, sourceField.pixelDensity, bloomGain, mipTo, 0, false, sigmaScale);
    filtered = sourceField.sourceFxaa ? applySourceFxaa(rendered, sourceField.width, sourceField.height, sourceField.emission) : rendered;
    if (cache.size >= 128) cache.delete(cache.keys().next().value!);
    cache.set(cacheKey, filtered);
  }
  const final = field.sourceCoordinates ? resampleRadiance(filtered, sourceField.width, sourceField.height, field.sourceCoordinates) : filtered;
  const pixels = new Uint8Array(field.width * field.height * 4);
  for (let pixel = 0; pixel < field.width * field.height; pixel++) {
    const alpha = Math.max(final[pixel * 3]!, final[pixel * 3 + 1]!, final[pixel * 3 + 2]!);
    for (let channel = 0; channel < 3; channel++)
      pixels[pixel * 4 + channel] = alpha > 0 ? Math.round(final[pixel * 3 + channel]! / alpha * 255) : 0;
    pixels[pixel * 4 + 3] = Math.round(alpha * 255);
  }
  return { key, image: { width: field.width, height: field.height, pixels }, expand: [1, 1], offset: [0, 0], response: new Float32Array(9).fill(1) };
}

export function bakeCompositeHalo(
  key: string,
  quads: readonly CompositeQuad[],
  mipFrom: number,
  mipTo: number,
  bloomGain: number,
  pixelDensity = 0.25,
  sigmaScale = 1,
  includeCore = false,
  supersampleOverride?: number,
): { tile: Tile; rect: { x0: number; y0: number; x1: number; y1: number } } {
  const pad = mipTo > 0 ? 3 * BLOOM_SIGMAS[mipTo - 1]! * sigmaScale : 0;
  const field = rasterizeCompositeRadiance(quads, pixelDensity, pad, supersampleOverride ?? 4);
  const { width, height, emission } = field;
  const { x0: minX, y0: minY, x1: maxX, y1: maxY } = field.rect;
  const build = (gain: number): Float32Array => {
    const scaled = emission.map((value) => value * gain);
    const out = composite(scaled, width, height, pixelDensity, bloomGain, mipTo, mipFrom, !includeCore, sigmaScale);
    // Fade the last tenth of the pad so the tile border never shows.
    const fade = Math.max(1, pad * pixelDensity * 0.3);
    for (let y = 0; y < height; y += 1)
      for (let x = 0; x < width; x += 1) {
        const edge = Math.min(x + 0.5, y + 0.5, width - x - 0.5, height - y - 0.5);
        if (pad <= 0 || edge >= fade) continue;
        const k = Math.max(0, edge / fade);
        const weight = k * k * (3 - 2 * k);
        for (let c = 0; c < 3; c += 1) out[(y * width + x) * 3 + c]! *= weight;
      }
    return out;
  };
  const final = build(1);
  const pixels = new Uint8Array(width * height * 4);
  let reference = 0;
  for (let p = 0; p < width * height; p += 1) {
    const r = final[p * 3]!;
    const g = final[p * 3 + 1]!;
    const b = final[p * 3 + 2]!;
    const alpha = Math.max(r, g, b);
    reference += r + g + b;
    pixels[p * 4] = alpha > 0 ? Math.round((r / alpha) * 255) : 0;
    pixels[p * 4 + 1] = alpha > 0 ? Math.round((g / alpha) * 255) : 0;
    pixels[p * 4 + 2] = alpha > 0 ? Math.round((b / alpha) * 255) : 0;
    pixels[p * 4 + 3] = Math.round(alpha * 255);
  }
  const response = new Float32Array(RESPONSE_STEPS + 1);
  response[RESPONSE_STEPS] = 1;
  for (let step = 1; step < RESPONSE_STEPS; step += 1) {
    let total = 0;
    for (const value of build(step / RESPONSE_STEPS)) total += value;
    response[step] = reference > 0 ? Math.min(1, total / reference) : step / RESPONSE_STEPS;
  }
  return {
    tile: { key, image: { width, height, pixels }, expand: [1, 1], offset: [0, 0], response },
    rect: { x0: minX, y0: minY, x1: maxX, y1: maxY },
  };
}
