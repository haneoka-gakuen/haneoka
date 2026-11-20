// Effect texture baking: fold Unity MobileAddHdrColor into straight-alpha
// atlas tiles for Sonolus' SrcAlpha/OneMinusSrcAlpha particle shader.
// The Source One/One HDR composition is approximated on the LDR atlas.

import { deflateSync } from "node:zlib";
import { decode } from "fast-png";

export interface RgbaImage {
  width: number;
  height: number;
  pixels: Uint8Array;
}

function crc32(buffer: Uint8Array): number {
  let crc = 0xffffffff;
  for (let index = 0; index < buffer.length; index += 1) {
    crc ^= buffer[index]!;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function decodePng(input: Buffer, sourceName: string): RgbaImage {
  if (
    input.length < 33 || input.readUInt32BE(0) !== 0x89504e47 ||
    input[24] !== 8 || input[25] !== 6 || input[28] !== 0
  ) {
    throw new Error(`${sourceName}: expected non-interlaced RGBA8 PNG`);
  }
  const parsed = decode(input);
  return { width: parsed.width, height: parsed.height, pixels: new Uint8Array(parsed.data) };
}

function encodeChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, crc]);
}

function paeth(left: number, up: number, upperLeft: number): number {
  const estimate = left + up - upperLeft;
  const a = Math.abs(estimate - left);
  const b = Math.abs(estimate - up);
  const c = Math.abs(estimate - upperLeft);
  return a <= b && a <= c ? left : b <= c ? up : upperLeft;
}

function encodeFilteredRows(image: RgbaImage, stride: number): Buffer {
  const raw = Buffer.alloc((stride + 1) * image.height);
  const rows = Array.from({ length: 5 }, () => new Uint8Array(stride));
  const scores = new Float64Array(rows.length);
  for (let y = 0; y < image.height; y += 1) {
    scores.fill(0);
    const start = y * stride;
    for (let x = 0; x < stride; x += 1) {
      const index = start + x;
      const value = image.pixels[index]!;
      const left = x >= 4 ? image.pixels[index - 4]! : 0;
      const up = y ? image.pixels[index - stride]! : 0;
      const upperLeft = y && x >= 4 ? image.pixels[index - stride - 4]! : 0;
      rows[0]![x] = value;
      rows[1]![x] = value - left;
      rows[2]![x] = value - up;
      rows[3]![x] = value - ((left + up) >>> 1);
      rows[4]![x] = value - paeth(left, up, upperLeft);
      for (let filter = 0; filter < rows.length; filter += 1) {
        const residual = rows[filter]![x]!;
        scores[filter]! += Math.min(residual, 256 - residual);
      }
    }
    let best = 0;
    for (let filter = 1; filter < scores.length; filter += 1) {
      if (scores[filter]! < scores[best]!) best = filter;
    }
    const offset = y * (stride + 1);
    raw[offset] = best;
    raw.set(rows[best]!, offset + 1);
  }
  return raw;
}

export function encodeRgbaPng(image: RgbaImage, filterRows = false): Buffer {
  const stride = image.width * 4;
  const raw = filterRows ? encodeFilteredRows(image, stride) : Buffer.alloc((stride + 1) * image.height);
  if (!filterRows) {
    for (let y = 0; y < image.height; y += 1) {
      raw.set(image.pixels.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(image.width, 0);
  header.writeUInt32BE(image.height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    encodeChunk("IHDR", header),
    encodeChunk("IDAT", deflateSync(raw, { level: 9 })),
    encodeChunk("IEND", Buffer.alloc(0)),
  ]);
}

export interface TileSource {
  key: string;
  image: RgbaImage;
  /** Authored MobileAddHdrColor tint; applied per particle color, not per tile. */
  tint: readonly [number, number, number, number];
  /** Optional additive halo approximating the game's bloom. */
  glow: number;
}

export interface PackedTile {
  key: string;
  x: number;
  y: number;
  w: number;
  h: number;
  spriteIndex: number;
}

const applyTintAndGlow = (source: TileSource): RgbaImage => {
  // Tiles carry the authored texels untouched: the MobileAddHdrColor tint and
  // its HDR doubling fold into each particle's `color` field instead (the
  // tile-side clamp would otherwise crush the per-system start colors).
  const { width, height, pixels } = source.image;
  void source.tint;
  const baked = new Float32Array(width * height * 4);
  // ef_wall's alpha is a 128-level DITHERED gradient (mobile-shader trick).
  // A flat quad sampling it raw shows the dither as noise, so the wall tile
  // is re-baked as the per-row average: the authored vertical gradient shape
  // (bright near the judgement line, fading upward) without the dither.
  const rowAlpha = new Float32Array(height);
  if (source.key === "wall") {
    for (let y = 0; y < height; y += 1) {
      let total = 0;
      for (let x = 0; x < width; x += 1) total += pixels[(y * width + x) * 4 + 3]!;
      rowAlpha[y] = total / width / 255;
    }
  }
  for (let index = 0; index < width * height; index += 1) {
    const o = index * 4;
    // Several effect textures are pure alpha masks (shape in A, RGB=0); the
    // game shader multiplies them by bright HDR colors, so black RGB here
    // means "use the alpha as the emission shape intensity", not black light.
    let r = pixels[o]! / 255;
    let g = pixels[o + 1]! / 255;
    let b = pixels[o + 2]! / 255;
    let alpha = pixels[o + 3]! / 255;
    if (Math.max(r, g, b) < 8 / 255) r = g = b = alpha;
    if (source.key === "wall") {
      const y = Math.floor(index / width);
      alpha = Math.min(1, rowAlpha[y]! * 2.2);
      r = g = b = alpha;
    }
    baked[o] = r;
    baked[o + 1] = g;
    baked[o + 2] = b;
    baked[o + 3] = alpha;
  }
  if (source.glow > 0) {
    const blurred = boxBlur3(baked, width, height, Math.max(2, Math.round(Math.min(width, height) / 10)));
    const k = source.glow;
    for (let index = 0; index < baked.length; index += 4) {
      baked[index] = Math.min(1, baked[index]! + blurred[index]! * k);
      baked[index + 1] = Math.min(1, baked[index + 1]! + blurred[index + 1]! * k);
      baked[index + 2] = Math.min(1, baked[index + 2]! + blurred[index + 2]! * k);
      baked[index + 3] = Math.min(1, baked[index + 3]! + blurred[index + 3]! * k * 0.7);
    }
  }
  const out = new Uint8Array(width * height * 4);
  for (let index = 0; index < baked.length; index += 1) out[index] = Math.round(clamp01(baked[index]!) * 255);
  return { width, height, pixels: out };
};

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

function boxBlur3(buffer: Float32Array, width: number, height: number, radius: number): Float32Array {
  const channels = 4;
  const temp = new Float32Array(buffer.length);
  const out = new Float32Array(buffer.length);
  const window = radius * 2 + 1;
  for (let pass = 0; pass < 3; pass += 1) {
    const source = pass === 0 ? buffer : out;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        for (let c = 0; c < channels; c += 1) {
          let sum = 0;
          for (let d = -radius; d <= radius; d += 1) {
            const sx = Math.max(0, Math.min(width - 1, x + d));
            sum += source[(y * width + sx) * channels + c]!;
          }
          temp[(y * width + x) * channels + c] = sum / window;
        }
      }
    }
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        for (let c = 0; c < channels; c += 1) {
          let sum = 0;
          for (let d = -radius; d <= radius; d += 1) {
            const sy = Math.max(0, Math.min(height - 1, y + d));
            sum += temp[(sy * width + x) * channels + c]!;
          }
          out[(y * width + x) * channels + c] = sum / window;
        }
      }
    }
  }
  return out;
}

export interface AtlasResult {
  width: number;
  height: number;
  png: Buffer;
  tiles: PackedTile[];
  spriteIndexOf: ReadonlyMap<string, number>;
}

/** Shelf-pack tinted tiles with a 2px gutter into the smallest power-of-two atlas. */
export function bakeAtlas(sources: readonly TileSource[]): AtlasResult {
  const baked = sources.map((source) => ({ source, image: applyTintAndGlow(source) }));
  baked.sort((a, b) => b.image.height - a.image.height);
  for (const size of [1024, 2048, 4096] as const) {
    const shelves: Array<{ y: number; h: number; x: number }> = [];
    const placements: Array<{ x: number; y: number }> = [];
    let overflow = false;
    for (const entry of baked) {
      const w = entry.image.width + 2;
      const h = entry.image.height + 2;
      if (w > size || h > size) {
        overflow = true;
        break;
      }
      let shelf = shelves.find((candidate) => candidate.h >= h && size - candidate.x >= w);
      if (!shelf) {
        shelf = { x: 0, h, y: shelves.reduce((total, current) => total + current.h, 0) };
        shelves.push(shelf);
      }
      placements.push({ x: shelf.x + 1, y: shelf.y + 1 });
      shelf.x += w;
      if (shelf.y + h > size) overflow = true;
    }
    if (overflow) continue;
    const pixels = new Uint8Array(size * size * 4);
    const tiles: PackedTile[] = [];
    const spriteIndexOf = new Map<string, number>();
    baked.forEach((entry, index) => {
      const place = placements[index]!;
      for (let y = 0; y < entry.image.height; y += 1) {
        const from = y * entry.image.width * 4;
        pixels.set(
          entry.image.pixels.subarray(from, from + entry.image.width * 4),
          ((place.y + y) * size + place.x) * 4,
        );
      }
      spriteIndexOf.set(entry.source.key, index);
      tiles.push({
        key: entry.source.key,
        x: place.x,
        y: place.y,
        w: entry.image.width,
        h: entry.image.height,
        spriteIndex: index,
      });
    });
    return {
      width: size,
      height: size,
      png: encodeRgbaPng({ width: size, height: size, pixels }),
      tiles,
      spriteIndexOf,
    };
  }
  throw new Error("effect texture atlas capacity exceeded");
}
