import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { deflateSync, gzipSync, inflateSync } from "node:zlib";
import {
  OUR_NOTES_SLIDE_LINE_STYLES,
  OUR_NOTES_BUNDLED_NOTE_ATLASES,
  OUR_NOTES_NOTE_SKINS,
  type BundledNoteAtlas,
  type BundledNoteSkin,
  type NoteSkinDefinition,
} from "@haneoka/cassiopeia-plugin-our-notes";

type VertexComponent = "x1" | "y1" | "x2" | "y2" | "x3" | "y3" | "x4" | "y4";
type SpriteTransform = Record<VertexComponent, Partial<Record<VertexComponent, number>>>;

export interface PngChunk {
  type: string;
  bytes: Buffer;
}

export interface DecodedRgbaPng {
  signature: Buffer;
  chunks: PngChunk[];
  width: number;
  height: number;
  pixels: Buffer;
}

interface SpriteSource {
  x: number;
  y: number;
  w: number;
  h: number;
  transform?: SpriteTransform;
}

interface SkinSprite extends SpriteSource {
  name: string;
  transform: SpriteTransform;
}

interface PackedNativeSprite {
  name: string;
  w: number;
  h: number;
  pixels: Buffer;
  x: number;
  y: number;
}

interface FreeRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface NumberPair {
  x: number;
  y: number;
}

const NATIVE_TEXTURE_SIZE = 2048;
const COMMON_TEXTURE_HEIGHT = 4096;
// Shelf spacing must cover the 2px edge-extension gutter that copySprite
// bakes around every sprite: bilinear sampling at a sprite-rect edge reaches
// 1px outside the content area, and an unpacked transparent-black neighbour
// renders as a dark fringe (the "black seams" on composed note bodies).
const PACK_GAP = 5;
const SKIN_PACK_PAD = 2;

const identity = {
  x1: { x1: 1 },
  y1: { y1: 1 },
  x2: { x2: 1 },
  y2: { y2: 1 },
  x3: { x3: 1 },
  y3: { y3: 1 },
  x4: { x4: 1 },
  y4: { y4: 1 },
} satisfies SpriteTransform;

const special = new Map<string, SpriteSource>([
  ["lane_base", { x: 0, y: 2048, w: 2048, h: 1644 }],
  ["slide_line", { x: 0, y: 3692, w: 100, h: 48 }],
  // The legacy fixed strips retain the transverse mask without transparent
  // rows bleeding into the longitudinal edges.
  ["slide_line_fixed_v", { x: 401, y: 3693, w: 100, h: 8 }],
  ["slide_line_normal", { x: 505, y: 3693, w: 100, h: 8 }],
  ["slide_line_pressed", { x: 609, y: 3693, w: 100, h: 8 }],
  ["slide_line_guide", { x: 713, y: 3693, w: 100, h: 8 }],
  ["preview_lane", { x: 817, y: 3693, w: 8, h: 8 }],
  ["preview_border", { x: 829, y: 3693, w: 8, h: 8 }],
  ["preview_divider", { x: 841, y: 3693, w: 8, h: 8 }],
  ["sim_line", { x: 853, y: 3693, w: 8, h: 8 }],
  ["guideline_gradient", { x: 864, y: 3694, w: 8, h: 64 }],
  ["guideline_space", { x: 879, y: 3694, w: 8, h: 8 }],
  ["judgment_line", { x: 330, y: 3692, w: 1, h: 1 }],
  ["lane_tap", { x: 104, y: 3692, w: 96, h: 96 }],
  ["lane_tap_tl", { x: 104, y: 3692, w: 46, h: 46 }],
  ["lane_tap_t", { x: 150, y: 3692, w: 4, h: 46 }],
  ["lane_tap_tr", { x: 154, y: 3692, w: 46, h: 46 }],
  ["lane_tap_l", { x: 104, y: 3738, w: 46, h: 4 }],
  ["lane_tap_c", { x: 150, y: 3738, w: 4, h: 4 }],
  ["lane_tap_r", { x: 154, y: 3738, w: 46, h: 4 }],
  ["lane_tap_bl", { x: 104, y: 3742, w: 46, h: 46 }],
  ["lane_tap_b", { x: 150, y: 3742, w: 4, h: 46 }],
  ["lane_tap_br", { x: 154, y: 3742, w: 46, h: 46 }],
  ["lane_side", { x: 204, y: 3692, w: 16, h: 24 }],
]);

function byteAt(buffer: Uint8Array, index: number, context: string): number {
  const value = buffer[index];
  if (value === undefined) throw new Error(`${context}: byte ${index} is out of bounds for ${buffer.length} bytes`);
  return value;
}

function crc32(buffer: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  if (!/^[A-Za-z]{4}$/.test(type)) throw new Error(`Invalid PNG chunk type: ${type}`);
  const name = Buffer.from(type, "ascii");
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  name.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([name, data])), 8 + data.length);
  return chunk;
}

export function decodeRgba8Png(input: Buffer, sourceName: string): DecodedRgbaPng {
  const expectedSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (input.length < expectedSignature.length || !input.subarray(0, 8).equals(expectedSignature)) {
    throw new Error(`${sourceName} has an invalid PNG signature`);
  }

  const signature = input.subarray(0, 8);
  const chunks: PngChunk[] = [];
  const idat: Buffer[] = [];
  let width = 0;
  let height = 0;
  let offset = 8;
  while (offset < input.length) {
    if (input.length - offset < 12) throw new Error(`${sourceName}: truncated PNG chunk header at byte ${offset}`);
    const length = input.readUInt32BE(offset);
    const type = input.toString("ascii", offset + 4, offset + 8);
    const end = offset + 12 + length;
    if (!Number.isSafeInteger(end) || end > input.length) {
      throw new Error(`${sourceName}: truncated PNG ${type || "unknown"} chunk at byte ${offset}`);
    }
    const data = input.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      if (data.length !== 13) throw new Error(`${sourceName}: invalid PNG IHDR length ${data.length}`);
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (
        byteAt(data, 8, `${sourceName} IHDR`) !== 8 ||
        byteAt(data, 9, `${sourceName} IHDR`) !== 6 ||
        byteAt(data, 10, `${sourceName} IHDR`) !== 0 ||
        byteAt(data, 11, `${sourceName} IHDR`) !== 0 ||
        byteAt(data, 12, `${sourceName} IHDR`) !== 0
      ) {
        throw new Error(`${sourceName} must be a non-interlaced RGBA8 PNG`);
      }
    }
    if (type === "IDAT") idat.push(data);
    else chunks.push({ type, bytes: input.subarray(offset, end) });
    offset = end;
  }

  if (!width || !height) throw new Error(`${sourceName} contains no valid IHDR chunk`);
  if (!idat.length) throw new Error(`${sourceName} contains no IDAT chunks`);

  const packed = inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const expectedPackedLength = (stride + 1) * height;
  if (packed.length !== expectedPackedLength) {
    throw new Error(`${sourceName}: unexpected PNG scanline size ${packed.length} != ${expectedPackedLength}`);
  }

  const pixels = Buffer.alloc(stride * height);
  let packedOffset = 0;
  for (let y = 0; y < height; y++) {
    const filter = byteAt(packed, packedOffset++, `${sourceName} row ${y}`);
    const row = pixels.subarray(y * stride, (y + 1) * stride);
    const previous = y ? pixels.subarray((y - 1) * stride, y * stride) : undefined;
    for (let x = 0; x < stride; x++) {
      const raw = byteAt(packed, packedOffset++, `${sourceName} row ${y}`);
      const left = x >= 4 ? byteAt(row, x - 4, `${sourceName} decoded row ${y}`) : 0;
      const up = previous ? byteAt(previous, x, `${sourceName} decoded row ${y - 1}`) : 0;
      const upLeft = previous && x >= 4 ? byteAt(previous, x - 4, `${sourceName} decoded row ${y - 1}`) : 0;
      if (filter === 0) row[x] = raw;
      else if (filter === 1) row[x] = (raw + left) & 255;
      else if (filter === 2) row[x] = (raw + up) & 255;
      else if (filter === 3) row[x] = (raw + Math.floor((left + up) / 2)) & 255;
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        row[x] = (raw + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft)) & 255;
      } else throw new Error(`${sourceName}: unsupported PNG filter ${filter}`);
    }
  }

  return { signature, chunks, width, height, pixels };
}

export function encodeRgba8Png({ signature, chunks, width, height, pixels }: DecodedRgbaPng): Buffer {
  const stride = width * 4;
  if (pixels.length !== stride * height) {
    throw new Error(`Invalid RGBA pixel buffer: ${pixels.length} != ${stride * height}`);
  }
  const scanlines = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const target = y * (stride + 1);
    scanlines[target] = 0;
    pixels.copy(scanlines, target + 1, y * stride, (y + 1) * stride);
  }
  const encoded = pngChunk("IDAT", deflateSync(scanlines, { level: 9 }));
  const output: Buffer[] = [signature];
  let inserted = false;
  for (const chunk of chunks) {
    if (!inserted && chunk.type === "IEND") {
      output.push(encoded);
      inserted = true;
    }
    output.push(chunk.bytes);
  }
  if (!inserted) throw new Error("PNG contains no IEND chunk");
  return Buffer.concat(output);
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must be an object`);
  return value as Record<string, unknown>;
}

function array(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
  return value;
}

function string(value: unknown, path: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${path} must be a non-empty string`);
  return value;
}

function finite(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${path} must be a finite number`);
  return value;
}

function integer(value: unknown, path: string): number {
  const result = finite(value, path);
  if (!Number.isInteger(result)) throw new Error(`${path} must be an integer`);
  return result;
}

function positiveInteger(value: unknown, path: string): number {
  const result = integer(value, path);
  if (result <= 0) throw new Error(`${path} must be positive`);
  return result;
}

function pair(value: unknown, path: string): NumberPair {
  const object = record(value, path);
  return { x: finite(object.x, `${path}.x`), y: finite(object.y, `${path}.y`) };
}

function cloneTexture(texture: DecodedRgbaPng): DecodedRgbaPng {
  return { ...texture, chunks: texture.chunks.slice(), pixels: Buffer.from(texture.pixels) };
}

function renderDataFor(atlas: BundledNoteAtlas, renderDataKey: unknown, sourceName: string): Record<string, unknown> {
  const atlasObject = record(atlas.atlasMetadata, `${sourceName}.atlasMetadata`);
  const atlasData = record(atlasObject.data, `${sourceName}.atlasMetadata.data`);
  const renderDataMap = array(atlasData.m_RenderDataMap, `${sourceName}.atlasMetadata.data.m_RenderDataMap`);
  const key = JSON.stringify(renderDataKey);
  const matches = renderDataMap.filter((entry) => Array.isArray(entry) && JSON.stringify(entry[0]) === key);
  if (matches.length !== 1) {
    throw new Error(`${sourceName} m_RenderDataKey matched ${matches.length} atlas entries, expected exactly one`);
  }
  const match = matches[0];
  if (!Array.isArray(match) || match.length < 2) throw new Error(`${sourceName} atlas render entry is malformed`);
  return record(match[1], `${sourceName}.atlasRenderData`);
}

function meshContains(
  x: number,
  y: number,
  positions: ReadonlyArray<readonly [number, number]>,
  indices: ReadonlyArray<number>,
): boolean {
  const epsilon = 1e-7;
  for (let index = 0; index < indices.length; index += 3) {
    const a = positions[indices[index]!];
    const b = positions[indices[index + 1]!];
    const c = positions[indices[index + 2]!];
    if (!a || !b || !c) throw new Error("Sprite mesh index is out of bounds");
    const ab = (x - a[0]) * (b[1] - a[1]) - (y - a[1]) * (b[0] - a[0]);
    const bc = (x - b[0]) * (c[1] - b[1]) - (y - b[1]) * (c[0] - b[0]);
    const ca = (x - c[0]) * (a[1] - c[1]) - (y - c[1]) * (a[0] - c[0]);
    const hasNegative = ab < -epsilon || bc < -epsilon || ca < -epsilon;
    const hasPositive = ab > epsilon || bc > epsilon || ca > epsilon;
    if (!(hasNegative && hasPositive)) return true;
  }
  return false;
}

function reversePackingRotation(
  u: number,
  v: number,
  packedWidth: number,
  packedHeight: number,
  rotation: number,
  sourceName: string,
): NumberPair {
  switch (rotation) {
    case 0:
      return { x: u, y: v };
    case 1:
      return { x: packedWidth - u, y: v };
    case 2:
      return { x: u, y: packedHeight - v };
    case 3:
      return { x: packedWidth - u, y: packedHeight - v };
    case 4:
      // Unity's Rotate90 stores the source clockwise in the packed atlas.
      // This is the inverse mapping back to the source's unrotated rectangle.
      return { x: v, y: packedWidth - u };
    default:
      throw new Error(`${sourceName} uses unsupported SpritePackingRotation ${rotation}`);
  }
}

function rasterizeFullRectSprite(
  sourceTexture: DecodedRgbaPng,
  atlas: BundledNoteAtlas,
  sourceName: string,
  rawMetadata: unknown,
): { w: number; h: number; pixels: Buffer } {
  const entry = record(rawMetadata, `spriteMetadata.${sourceName}`);
  const data = record(entry.data, `spriteMetadata.${sourceName}.data`);
  if (string(data.m_Name, `${sourceName}.m_Name`) !== sourceName) {
    throw new Error(`${sourceName}.m_Name disagrees with spriteMetadata key`);
  }
  const rect = record(data.m_Rect, `${sourceName}.m_Rect`);
  const width = positiveInteger(rect.width, `${sourceName}.m_Rect.width`);
  const height = positiveInteger(rect.height, `${sourceName}.m_Rect.height`);
  const pivot = pair(data.m_Pivot, `${sourceName}.m_Pivot`);
  const offset = pair(data.m_Offset, `${sourceName}.m_Offset`);
  const pixelsToUnits = finite(data.m_PixelsToUnits, `${sourceName}.m_PixelsToUnits`);
  if (pixelsToUnits <= 0) throw new Error(`${sourceName}.m_PixelsToUnits must be positive`);

  const originalRenderData = record(data.originalRenderData, `${sourceName}.originalRenderData`);
  const mesh = record(originalRenderData.mesh, `${sourceName}.originalRenderData.mesh`);
  const rawPositions = array(mesh.positions, `${sourceName}.mesh.positions`);
  const positions = rawPositions.map((value, index) => {
    const item = array(value, `${sourceName}.mesh.positions[${index}]`);
    if (item.length < 2) throw new Error(`${sourceName}.mesh.positions[${index}] must have x/y`);
    return [
      finite(item[0], `${sourceName}.mesh.positions[${index}][0]`),
      finite(item[1], `${sourceName}.mesh.positions[${index}][1]`),
    ] as const;
  });
  const rawIndices = array(mesh.indices, `${sourceName}.mesh.indices`);
  if (!rawIndices.length || rawIndices.length % 3 !== 0)
    throw new Error(`${sourceName}.mesh.indices must contain triangles`);
  const indices = rawIndices.map((value, index) => integer(value, `${sourceName}.mesh.indices[${index}]`));
  if (indices.some((value) => value < 0 || value >= positions.length))
    throw new Error(`${sourceName} mesh index is out of bounds`);

  const render = renderDataFor(atlas, data.m_RenderDataKey, sourceName);
  const textureRect = record(render.textureRect, `${sourceName}.textureRect`);
  const textureX = finite(textureRect.x, `${sourceName}.textureRect.x`);
  const textureY = finite(textureRect.y, `${sourceName}.textureRect.y`);
  const textureWidth = finite(textureRect.width, `${sourceName}.textureRect.width`);
  const textureHeight = finite(textureRect.height, `${sourceName}.textureRect.height`);
  if (textureWidth <= 0 || textureHeight <= 0) throw new Error(`${sourceName}.textureRect must be positive`);
  if (
    textureX < 0 ||
    textureY < 0 ||
    textureX + textureWidth > sourceTexture.width ||
    textureY + textureHeight > sourceTexture.height
  ) {
    throw new Error(`${sourceName}.textureRect is outside ${sourceTexture.width}x${sourceTexture.height}`);
  }
  const textureRectOffset = pair(render.textureRectOffset, `${sourceName}.textureRectOffset`);
  const settingsRaw = integer(render.settingsRaw, `${sourceName}.settingsRaw`);
  const rotation = (settingsRaw >> 2) & 0xf;

  const cropX0 = Math.floor(textureX);
  const cropX1 = Math.ceil(textureX + textureWidth);
  const cropYTop0 = Math.floor(sourceTexture.height - textureY - textureHeight);
  const cropYTop1 = Math.ceil(sourceTexture.height - textureY);
  const output = Buffer.alloc(width * height * 4);
  const sourceStride = sourceTexture.width * 4;
  const pivotPixels = { x: pivot.x * width, y: pivot.y * height };

  for (let sourceYTop = cropYTop0; sourceYTop < cropYTop1; sourceYTop++) {
    const sourceBottom = sourceTexture.height - (sourceYTop + 0.5);
    const packedV = sourceBottom - textureY;
    if (packedV < 0 || packedV >= textureHeight) continue;
    for (let sourceX = cropX0; sourceX < cropX1; sourceX++) {
      const packedU = sourceX + 0.5 - textureX;
      if (packedU < 0 || packedU >= textureWidth) continue;
      const unpacked = reversePackingRotation(packedU, packedV, textureWidth, textureHeight, rotation, sourceName);
      const fullX = Math.floor(textureRectOffset.x + unpacked.x);
      const fullY = Math.floor(textureRectOffset.y + unpacked.y);
      if (fullX < 0 || fullX >= width || fullY < 0 || fullY >= height) continue;

      const meshX = (fullX + 0.5 - pivotPixels.x + offset.x) / pixelsToUnits;
      const meshY = (fullY + 0.5 - pivotPixels.y + offset.y) / pixelsToUnits;
      if (!meshContains(meshX, meshY, positions, indices)) continue;

      const sourceOffset = sourceYTop * sourceStride + sourceX * 4;
      const outputYTop = height - 1 - fullY;
      const outputOffset = outputYTop * width * 4 + fullX * 4;
      sourceTexture.pixels.copy(output, outputOffset, sourceOffset, sourceOffset + 4);
    }
  }
  return { w: width, h: height, pixels: output };
}

function intersects(a: FreeRect, b: FreeRect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function contains(outer: FreeRect, inner: FreeRect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.w <= outer.x + outer.w &&
    inner.y + inner.h <= outer.y + outer.h
  );
}

function packNativeSprites(items: ReadonlyArray<Omit<PackedNativeSprite, "x" | "y">>): PackedNativeSprite[] {
  const free: FreeRect[] = [{ x: 0, y: 0, w: NATIVE_TEXTURE_SIZE, h: NATIVE_TEXTURE_SIZE }];
  const placed: PackedNativeSprite[] = [];
  const ordered = [...items].sort((a, b) => {
    const area = b.w * b.h - a.w * a.h;
    return area || b.h - a.h || b.w - a.w || a.name.localeCompare(b.name);
  });

  for (const item of ordered) {
    const requiredW = item.w + PACK_GAP;
    const requiredH = item.h + PACK_GAP;
    let bestIndex = -1;
    let bestShortSide = Number.POSITIVE_INFINITY;
    let bestLongSide = Number.POSITIVE_INFINITY;
    for (let index = 0; index < free.length; index++) {
      const slot = free[index]!;
      if (requiredW > slot.w || requiredH > slot.h) continue;
      const shortSide = Math.min(slot.w - requiredW, slot.h - requiredH);
      const longSide = Math.max(slot.w - requiredW, slot.h - requiredH);
      if (shortSide < bestShortSide || (shortSide === bestShortSide && longSide < bestLongSide)) {
        bestIndex = index;
        bestShortSide = shortSide;
        bestLongSide = longSide;
      }
    }
    if (bestIndex < 0) {
      throw new Error(
        `Native ${NATIVE_TEXTURE_SIZE}x${NATIVE_TEXTURE_SIZE} upper pack cannot place ${item.name} ${item.w}x${item.h}`,
      );
    }

    const slot = free[bestIndex]!;
    const used: FreeRect = { x: slot.x, y: slot.y, w: requiredW, h: requiredH };
    const nextFree: FreeRect[] = [];
    for (const candidate of free) {
      if (!intersects(candidate, used)) {
        nextFree.push(candidate);
        continue;
      }
      if (used.x > candidate.x)
        nextFree.push({ x: candidate.x, y: candidate.y, w: used.x - candidate.x, h: candidate.h });
      if (used.x + used.w < candidate.x + candidate.w) {
        nextFree.push({
          x: used.x + used.w,
          y: candidate.y,
          w: candidate.x + candidate.w - (used.x + used.w),
          h: candidate.h,
        });
      }
      if (used.y > candidate.y)
        nextFree.push({ x: candidate.x, y: candidate.y, w: candidate.w, h: used.y - candidate.y });
      if (used.y + used.h < candidate.y + candidate.h) {
        nextFree.push({
          x: candidate.x,
          y: used.y + used.h,
          w: candidate.w,
          h: candidate.y + candidate.h - (used.y + used.h),
        });
      }
    }
    free.length = 0;
    for (const candidate of nextFree) {
      if (candidate.w <= 0 || candidate.h <= 0) continue;
      if (nextFree.some((other) => other !== candidate && contains(other, candidate))) continue;
      free.push(candidate);
    }
    placed.push({ ...item, x: used.x, y: used.y });
  }
  return placed;
}

function addAlias(
  sprites: SkinSprite[],
  sources: ReadonlyMap<string, SpriteSource>,
  name: string,
  sourceName: string | null,
): void {
  if (sourceName === null) return;
  const source = sources.get(sourceName) || special.get(sourceName);
  if (!source) throw new Error(`Unknown native sprite alias source ${sourceName} for ${name}`);
  sprites.push({ name, x: source.x, y: source.y, w: source.w, h: source.h, transform: source.transform || identity });
}

function requirePartZero(note: NoteSkinDefinition, kind: string): NoteSkinDefinition["parts"][number] {
  const part = note.parts.find((candidate) => candidate.tilt === 0) || note.parts[0];
  if (!part) throw new Error(`${kind} note skin has no parts`);
  return part;
}

function addBodyAliases(
  sprites: SkinSprite[],
  sources: ReadonlyMap<string, SpriteSource>,
  label: string,
  note: NoteSkinDefinition,
): void {
  const part = requirePartZero(note, label);
  addAlias(sprites, sources, `Our Notes Note ${label} Left`, part.leftSprite);
  addAlias(sprites, sources, `Our Notes Note ${label} Middle`, note.mainSprite);
  addAlias(sprites, sources, `Our Notes Note ${label} Right`, part.rightSprite);
}

function addTraceAliases(
  sprites: SkinSprite[],
  sources: ReadonlyMap<string, SpriteSource>,
  color: "Green" | "Yellow" | "Red",
  note: NoteSkinDefinition,
): void {
  const part = requirePartZero(note, `Trace Note ${color}`);
  addAlias(sprites, sources, `Our Notes Trace Note ${color}`, note.mainSprite);
  addAlias(sprites, sources, `Our Notes Trace Note ${color} Left`, part.leftSprite);
  addAlias(sprites, sources, `Our Notes Trace Note ${color} Middle`, note.mainSprite);
  addAlias(sprites, sources, `Our Notes Trace Note ${color} Right`, part.rightSprite);
}

function addArrowAliases(
  sprites: SkinSprite[],
  sources: ReadonlyMap<string, SpriteSource>,
  label: "Up" | "Left" | "Right",
  arrows: NoteSkinDefinition["arrows"],
): void {
  // Some authored skins leave individual width tiers without a sprite
  // (skin002's right arrow has none at maxWidth 13). The indicator must stay
  // visible at every width, so a null tier falls forward to the nearest
  // authored tier (and backward when only earlier tiers exist).
  const original = arrows.map((arrow) => arrow.sprite);
  const fallbacks = [...original];
  for (let index = 0; index < fallbacks.length; index += 1) {
    if (fallbacks[index]) continue;
    const forward = original.slice(index + 1).find((sprite) => sprite) ?? null;
    const before = original.slice(0, index);
    const backward = before.length ? (before.filter((sprite): sprite is string => !!sprite).at(-1) ?? null) : null;
    fallbacks[index] = forward ?? backward;
  }
  arrows.forEach((_, index) => {
    for (const color of ["Red", "Yellow"] as const) {
      addAlias(sprites, sources, `Our Notes Flick Arrow ${color} ${label} ${index + 1}`, fallbacks[index] ?? null);
    }
  });
}

function requiredNote(
  notes: Readonly<Record<string, NoteSkinDefinition>>,
  kind: string,
  skinName: string,
): NoteSkinDefinition {
  const note = notes[kind];
  if (!note) throw new Error(`${skinName} published note skin is missing ${kind}`);
  return note;
}

function createSkinSprites(
  skinName: BundledNoteSkin,
  atlas: BundledNoteAtlas,
  native: PackedNativeSprite[],
): SkinSprite[] {
  const sources = new Map<string, SpriteSource>(
    native.map((sprite) => [sprite.name, { x: sprite.x, y: sprite.y, w: sprite.w, h: sprite.h, transform: identity }]),
  );
  const sprites: SkinSprite[] = native.map((sprite) => ({
    name: sprite.name,
    x: sprite.x,
    y: sprite.y,
    w: sprite.w,
    h: sprite.h,
    transform: identity,
  }));
  const alias = (name: string, sourceName: string | null): void => addAlias(sprites, sources, name, sourceName);

  // Stage and built-in fallbacks used by play, watch, preview and tutorial.
  alias("Our Notes Stage", "lane_base");
  alias("Our Notes Preview Stage", "preview_lane");
  alias("Our Notes Preview Border", "preview_border");
  alias("Our Notes Preview Divider", "preview_divider");
  alias("Our Notes Simultaneous Line", "sim_line");
  alias("Our Notes Lane Tap Area", "lane_tap");
  for (const [suffix, sourceName] of [
    ["Top Left", "lane_tap_tl"],
    ["Top", "lane_tap_t"],
    ["Top Right", "lane_tap_tr"],
    ["Left", "lane_tap_l"],
    ["Center", "lane_tap_c"],
    ["Right", "lane_tap_r"],
    ["Bottom Left", "lane_tap_bl"],
    ["Bottom", "lane_tap_b"],
    ["Bottom Right", "lane_tap_br"],
  ] as const)
    alias(`Our Notes Lane Tap Area ${suffix}`, sourceName);
  alias("Our Notes Guideline", "guideline_gradient");
  alias("Our Notes Guideline Space", "guideline_space");
  alias("Our Notes Outside Line", "lane_side");
  alias("Our Notes Judgment Line", "judgment_line");
  alias("#LANE", "lane_base");
  alias("#STAGE_LEFT_BORDER", "lane_side");
  alias("#STAGE_RIGHT_BORDER", "lane_side");
  alias("#JUDGMENT_LINE", "judgment_line");
  alias("#STAGE_COVER", "lane_side");
  alias("#GRID_NEUTRAL", "lane_side");
  alias("#GRID_PURPLE", "lane_side");
  alias("#GRID_YELLOW", "lane_side");
  alias("#SIMULTANEOUS_CONNECTION_NEUTRAL", "sim_line");
  alias("#NOTE_CONNECTION_GREEN_SEAMLESS", "slide_line_fixed_v");
  alias("#NOTE_CONNECTION_YELLOW_SEAMLESS", "slide_line_fixed_v");

  const notes = atlas.notes;
  const tap = requiredNote(notes, "tap", skinName);
  const slide = requiredNote(notes, "slide-start", skinName);
  const slideNode = requiredNote(notes, "slide-node", skinName);
  const slideEnd = requiredNote(notes, "slide-end", skinName);
  const flick = requiredNote(notes, "flick", skinName);
  const flickLeft = requiredNote(notes, "flick-left", skinName);
  const flickRight = requiredNote(notes, "flick-right", skinName);
  const trace = requiredNote(notes, "trace", skinName);

  // Preserve every authored cap tier; runtime chooses each boundary
  // independently and mirrors the selected cap in its draw geometry.
  for (const [label, note] of [
    ["Tap", tap], ["Slide", slide], ["End", slideEnd], ["Flick", flick],
    ["FlickLeft", flickLeft], ["FlickRight", flickRight], ["Trace", trace], ["Node", slideNode],
  ] as const) {
    for (const part of note.parts) {
      alias(`Our Notes Native ${label} Left ${part.tilt}`, part.leftSprite);
      alias(`Our Notes Native ${label} Right ${part.tilt}`, part.rightSprite);
    }
    const main = sources.get(note.mainSprite);
    if (!main) throw new Error(`${skinName} missing ${note.mainSprite}`);
    const metadata = record(record(atlas.spriteMetadata[note.mainSprite], note.mainSprite).data, note.mainSprite);
    const border = record(metadata.m_Border, `${note.mainSprite}.m_Border`);
    const left = finite(border.x, `${note.mainSprite}.border.left`);
    const right = finite(border.z, `${note.mainSprite}.border.right`);
    for (const [side, x, w] of [
      ["Left", main.x, left], ["Middle", main.x + left, main.w - left - right],
      ["Right", main.x + main.w - right, right],
    ] as const) {
      if (w <= 0) continue;
      sprites.push({ name: `Our Notes Native ${label} Main ${side}`, x, y: main.y, w, h: main.h, transform: identity });
    }
  }

  addBodyAliases(sprites, sources, "Cyan", tap);
  addBodyAliases(sprites, sources, "Green", slide);
  addBodyAliases(sprites, sources, "Green End", slideEnd);
  addBodyAliases(sprites, sources, "Red", flick);
  addBodyAliases(sprites, sources, "Red Leftward", flickLeft);
  addBodyAliases(sprites, sources, "Red Rightward", flickRight);
  addBodyAliases(sprites, sources, "Yellow", tap);

  for (const [name, sourceName] of [
    ["#NOTE_HEAD_CYAN", tap.mainSprite],
    ["#NOTE_HEAD_GREEN", slide.mainSprite],
    ["#NOTE_TAIL_GREEN", slideEnd.mainSprite],
    ["#NOTE_HEAD_RED", flick.mainSprite],
    ["#NOTE_TAIL_RED", flick.mainSprite],
    ["#NOTE_HEAD_YELLOW", tap.mainSprite],
    ["#NOTE_TAIL_YELLOW", slideEnd.mainSprite],
    ["#NOTE_TICK_GREEN", slideNode.centerMarkSprite],
    ["#NOTE_TICK_YELLOW", slideNode.centerMarkSprite],
    ["#NOTE_TICK_RED", flick.centerMarkSprite],
    ["Our Notes Diamond Green", slideNode.centerMarkSprite],
    ["Our Notes Diamond Yellow", slideNode.centerMarkSprite],
    ["Our Notes Trace Diamond Green", trace.centerMarkSprite],
    ["Our Notes Trace Diamond Yellow", trace.centerMarkSprite],
    ["Our Notes Trace Diamond Red", trace.centerMarkSprite],
  ] as const)
    alias(name, sourceName);

  for (const [name, sourceName] of [
    ["Our Notes Tap Decoration", tap.centerMarkSprite],
    ["Our Notes Slide Decoration", slide.centerMarkSprite],
    ["Our Notes Flick Decoration", flick.centerMarkSprite],
    ["Our Notes Flick Left Decoration", flickLeft.centerMarkSprite],
    ["Our Notes Flick Right Decoration", flickRight.centerMarkSprite],
  ] as const)
    alias(name, sourceName);

  for (const color of ["Green", "Yellow", "Red"] as const) {
    addTraceAliases(sprites, sources, color, trace);
  }

  for (const name of [
    "Our Notes Slide Connection Green",
    "Our Notes Slide Connection Green Active",
    "Our Notes Slide Connection Yellow",
    "Our Notes Slide Connection Yellow Active",
  ])
    alias(name, "slide_line_guide");
  for (const name of ["Our Notes Active Slide Connection Green", "Our Notes Active Slide Connection Yellow"])
    alias(name, "slide_line_normal");
  for (const name of [
    "Our Notes Active Slide Connection Green Active",
    "Our Notes Active Slide Connection Yellow Active",
  ])
    alias(name, "slide_line_pressed");

  for (const [state, x] of [["Normal", 505], ["Pressed", 609], ["Missed", 713]] as const) {
    for (let cell = 0; cell < 16; cell++)
      sprites.push({ name: `Our Notes Native Line ${state} ${cell}`, x, y: 3720 + cell * 10, w: 100, h: 8, transform: identity });
  }

  addArrowAliases(sprites, sources, "Up", flick.arrows);
  addArrowAliases(sprites, sources, "Left", flickLeft.arrows);
  addArrowAliases(sprites, sources, "Right", flickRight.arrows);

  const markerSource = flick.arrows.find((arrow) => arrow.sprite)?.sprite;
  if (!markerSource) throw new Error(`${skinName} has no flick arrow marker source`);
  alias(`Our Notes Native Flick Arrow Animation Skin ${skinName.slice(-3)}`, markerSource);
  const directionalMarkerSource = flick.arrows[1]?.sprite || markerSource;
  alias("#DIRECTIONAL_MARKER_RED", directionalMarkerSource);
  alias("#DIRECTIONAL_MARKER_YELLOW", directionalMarkerSource);

  const names = sprites.map((sprite) => sprite.name);
  if (new Set(names).size !== names.length) throw new Error(`${skinName} skin.data contains duplicate sprite names`);
  const markerNames = names.filter((name) => name.startsWith("Our Notes Native Flick Arrow Animation Skin "));
  if (
    markerNames.length !== 1 ||
    markerNames[0] !== `Our Notes Native Flick Arrow Animation Skin ${skinName.slice(-3)}`
  ) {
    throw new Error(`${skinName} skin.data must contain exactly one selected native animation marker`);
  }
  return sprites;
}

function validateBounds(
  sprites: ReadonlyArray<{ name: string } & SpriteSource>,
  width: number,
  height: number,
  skinName: string,
): void {
  for (const sprite of sprites) {
    if (
      ![sprite.x, sprite.y, sprite.w, sprite.h].every(Number.isInteger) ||
      sprite.x < 0 ||
      sprite.y < 0 ||
      sprite.w <= 0 ||
      sprite.h <= 0
    ) {
      throw new Error(`${skinName} sprite ${sprite.name} has invalid integer bounds`);
    }
    if (sprite.x + sprite.w > width || sprite.y + sprite.h > height) {
      throw new Error(`${skinName} sprite ${sprite.name} is outside ${width}x${height}`);
    }
  }
}

// Legacy September 30 ribbon appearance: midpoint tint over grayscale art.
const SLIDE_STRIP_X = { normal: 505, pressed: 609, missed: 713 } as const;
const SLIDE_SOURCE_ROW = 3693;
const SLIDE_STRIP_WIDTH = 100;
/** The authored grayscale line art spans x=6..93 of the 100px row. */
const SLIDE_ART_SPAN = { left: 6, right: 93 } as const;

type SlideGradient = { colors: readonly (readonly number[])[]; alpha: readonly number[] };

function sampleLegacySlideGradient(gradient: SlideGradient, time: number): [number, number, number, number] {
  const stops = gradient.colors;
  if (!stops.length) return [1, 1, 1, 1];
  let left = stops[0]!;
  let right = stops[stops.length - 1]!;
  for (let index = 0; index + 1 < stops.length; index += 1) {
    if (time >= stops[index]![0]! && time <= stops[index + 1]![0]!) {
      left = stops[index]!;
      right = stops[index + 1]!;
      break;
    }
  }
  const span = Math.max(1e-6, right[0]! - left[0]!);
  const amount = Math.min(1, Math.max(0, (time - left[0]!) / span));
  const channel = (offset: number): number =>
    Math.min(1, Math.max(0, left[offset]! + (right[offset]! - left[offset]!) * amount));
  // Preserve the legacy sampler mapping to reproduce the accepted colors.
  const alphaKeys = gradient.alpha;
  const a0 = alphaKeys[1] ?? 1;
  const a1 = alphaKeys[2] ?? a0;
  const t0 = alphaKeys[0] ?? 0;
  const t1 = alphaKeys[3] ?? 1;
  const alphaAmount = Math.min(1, Math.max(0, (time - t0) / Math.max(1e-6, t1 - t0)));
  return [channel(1), channel(2), channel(3), a0 + (a1 - a0) * alphaAmount];
}

function rgbToHsv(r: number, g: number, b: number): readonly [number, number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  const h =
    delta === 0 ? 0 : max === r ? ((g - b) / delta) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
  return [((h / 6) + 1) % 1, max === 0 ? 0 : delta / max, max];
}

function hsvToRgb(h: number, s: number, v: number): readonly [number, number, number] {
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  const table: ReadonlyArray<readonly [number, number, number]> = [
    [v, t, p],
    [q, v, p],
    [p, v, t],
    [p, q, v],
    [t, p, v],
    [v, p, q],
  ];
  return table[((i % 6) + 6) % 6]!;
}

export function bakeSkinSlideStrips(texture: DecodedRgbaPng, skinName: BundledNoteSkin): void {
  // Restore the September 30 midpoint tint and grayscale cross-section.
  // Every length sample uses this appearance; the line's state still
  // selects normal, pressed, or missed colors.
  const style = OUR_NOTES_SLIDE_LINE_STYLES[skinName];
  const stride = texture.width * 4;
  const sourceOffset = SLIDE_SOURCE_ROW * stride;
  const states: ReadonlyArray<[keyof typeof SLIDE_STRIP_X, SlideGradient, number]> = [
    ["normal", style.normal, style.glow.enabledScale],
    ["pressed", style.pressed, style.glow.pressedScale],
    ["missed", style.disabled, style.glow.disabledScale],
  ];
  for (const [state, gradient, stateScale] of states) {
    const targetX = SLIDE_STRIP_X[state];
    const [baseR, baseG, baseB, baseA] = sampleLegacySlideGradient(gradient, 0.5);
    for (let column = 0; column < SLIDE_STRIP_WIDTH; column += 1) {
      const sourceOffsetPixel = sourceOffset + Math.min(99, column) * 4;
      const gray = texture.pixels[sourceOffsetPixel]! / 255;
      const sourceA = texture.pixels[sourceOffsetPixel + 3]! / 255;
      // Glow rides the authored art's outer rails: symmetric across the
      // strip, strongest at the edges, zero from 12.5% inward.
      const u = Math.min(1, Math.max(0, (column - SLIDE_ART_SPAN.left) / (SLIDE_ART_SPAN.right - SLIDE_ART_SPAN.left)));
      const edge = Math.abs(2 * u - 1);
      const glowBase = Math.min(1, Math.max(0, edge / 0.125 - 7));
      const glow =
        (glowBase <= 0 ? 0 : Math.pow(glowBase, style.glow.falloff)) * style.glow.intensity * stateScale;
      const [h, s, v] = rgbToHsv(baseR, baseG, baseB);
      const [ar, ag, ab] = hsvToRgb(h, Math.min(1, Math.max(0, s - glow)), Math.min(1, v + glow));
      const mixAmount = Math.min(1, glow);
      const r = (ar + (style.glow.color[0] - ar) * mixAmount) * gray;
      const g = (ag + (style.glow.color[1] - ag) * mixAmount) * gray;
      const b = (ab + (style.glow.color[2] - ab) * mixAmount) * gray;
      const a = (baseA + (1 - baseA) * mixAmount) * sourceA;
      // All length aliases share the same strip, so clipping or distance
      // cannot introduce a longitudinal color or brightness gradient.
      for (let cell = -1; cell < 16; cell += 1) {
        const targetY = cell < 0 ? SLIDE_SOURCE_ROW : 3720 + cell * 10;
        for (let y = targetY - 1; y <= targetY + 8; y += 1) {
          const target = y * stride + (targetX + column) * 4;
          texture.pixels[target] = Math.round(Math.min(1, Math.max(0, r)) * 255);
          texture.pixels[target + 1] = Math.round(Math.min(1, Math.max(0, g)) * 255);
          texture.pixels[target + 2] = Math.round(Math.min(1, Math.max(0, b)) * 255);
          texture.pixels[target + 3] = Math.round(Math.min(1, Math.max(0, a)) * 255);
        }
      }
    }
  }
}

/** Bake the lane-line colors separately from the note and ribbon artwork. */
export function bakeSkinLaneGuidelines(texture: DecodedRgbaPng): Record<string, SpriteSource> {
  const gradient = special.get("guideline_gradient")!;
  const space = special.get("guideline_space")!;
  const targets = [
    { source: gradient, near: 0.6132076, far: 0.6156863, fade: true },
    // Stage applies the short line's authored .5019608 alpha once at draw time.
    { source: space, near: 0.6117647, far: 0.6117647, fade: false },
  ];
  for (const { source, near, far, fade } of targets) {
    for (let row = -SKIN_PACK_PAD; row < source.h + SKIN_PACK_PAD; row += 1) {
      const t = Math.min(1, Math.max(0, row / (source.h - 1)));
      // Image top is the distant end; image bottom is the judgment end.
      const color = Math.round((far + (near - far) * t) * 255);
      const alpha = fade ? Math.round(t * 255) : 255;
      for (let col = -SKIN_PACK_PAD; col < source.w + SKIN_PACK_PAD; col += 1) {
        const x = source.x + col;
        const y = source.y + row;
        if (x < 0 || y < 0 || x >= texture.width || y >= texture.height) {
          throw new Error("Lane guideline strip exceeds the common texture");
        }
        const offset = (y * texture.width + x) * 4;
        texture.pixels[offset] = color;
        texture.pixels[offset + 1] = color;
        texture.pixels[offset + 2] = color;
        texture.pixels[offset + 3] = alpha;
      }
    }
  }
  return { "Our Notes Guideline": gradient, "Our Notes Guideline Space": space };
}

function copySprite(texture: DecodedRgbaPng, sprite: PackedNativeSprite): void {
  const stride = texture.width * 4;
  for (let row = 0; row < sprite.h; row++) {
    const sourceOffset = row * sprite.w * 4;
    const targetOffset = (sprite.y + row) * stride + sprite.x * 4;
    sprite.pixels.copy(texture.pixels, targetOffset, sourceOffset, sourceOffset + sprite.w * 4);
  }
  // Edge-extension gutter: replicate the border pixels outward so bilinear
  // sampling just outside the sprite rect stays on same-colored texels
  // instead of fringing into transparent black. Clamped to the upper native
  // region — the lower half holds the shared lane art.
  const at = (x: number, y: number): number => (y * texture.width + x) * 4;
  const sample = (x: number, y: number): Uint8Array => {
    const offset = at(x, y);
    return texture.pixels.subarray(offset, offset + 4);
  };
  const write = (x: number, y: number, source: Uint8Array): void => {
    if (x < 0 || y < 0 || x >= texture.width || y >= NATIVE_TEXTURE_SIZE) return;
    const offset = at(x, y);
    for (let channel = 0; channel < 4; channel++) texture.pixels[offset + channel] = source[channel]!;
  };
  const right = sprite.x + sprite.w - 1;
  const bottom = sprite.y + sprite.h - 1;
  for (let pad = 1; pad <= SKIN_PACK_PAD; pad++) {
    for (let row = 0; row < sprite.h; row++) {
      const y = sprite.y + row;
      write(sprite.x - pad, y, sample(sprite.x, y));
      write(right + pad, y, sample(right, y));
    }
    for (let col = 0; col < sprite.w; col++) {
      const x = sprite.x + col;
      write(x, sprite.y - pad, sample(x, sprite.y));
      write(x, bottom + pad, sample(x, bottom));
    }
    for (const [cx, cy] of [
      [sprite.x, sprite.y],
      [right, sprite.y],
      [sprite.x, bottom],
      [right, bottom],
    ] as const) {
      const directionX = cx === sprite.x ? -pad : pad;
      const directionY = cy === sprite.y ? -pad : pad;
      write(cx + directionX, cy + directionY, sample(cx, cy));
    }
  }
}

function packSkin(
  skinName: BundledNoteSkin,
  atlas: BundledNoteAtlas,
  commonTexture: DecodedRgbaPng,
): { skinSprites: SkinSprite[]; nativeSprites: number; nativeArea: number; texture: DecodedRgbaPng } {
  if (commonTexture.width !== NATIVE_TEXTURE_SIZE || commonTexture.height !== COMMON_TEXTURE_HEIGHT) {
    throw new Error(`Common Sonolus texture must be ${NATIVE_TEXTURE_SIZE}x${COMMON_TEXTURE_HEIGHT}`);
  }
  const textureUrl = new URL(atlas.textureUrl);
  if (textureUrl.protocol !== "file:")
    throw new Error(`${skinName} note texture must be a file URL: ${atlas.textureUrl}`);
  const sourceTexture = decodeRgba8Png(readFileSync(fileURLToPath(textureUrl)), `${skinName} bundled note texture`);
  if (sourceTexture.width !== NATIVE_TEXTURE_SIZE || sourceTexture.height !== NATIVE_TEXTURE_SIZE) {
    throw new Error(`${skinName} bundled note texture must be ${NATIVE_TEXTURE_SIZE}x${NATIVE_TEXTURE_SIZE}`);
  }

  const nativeItems: Omit<PackedNativeSprite, "x" | "y">[] = [];
  for (const [sourceName, metadata] of Object.entries(atlas.spriteMetadata)) {
    const image = rasterizeFullRectSprite(sourceTexture, atlas, sourceName, metadata);
    nativeItems.push({ name: sourceName, w: image.w, h: image.h, pixels: image.pixels });
  }
  if (!nativeItems.length) throw new Error(`${skinName} has no bundled note sprites`);
  const native = packNativeSprites(nativeItems);
  validateBounds(native, NATIVE_TEXTURE_SIZE, NATIVE_TEXTURE_SIZE, `${skinName} native upper pack`);
  const sprites = createSkinSprites(skinName, atlas, native);
  validateBounds(sprites, commonTexture.width, commonTexture.height, skinName);

  const texture = cloneTexture(commonTexture);
  texture.pixels.fill(0, 0, NATIVE_TEXTURE_SIZE * texture.width * 4);
  for (const sprite of native) copySprite(texture, sprite);
  bakeSkinSlideStrips(texture, skinName);
  bakeSkinLaneGuidelines(texture);
  // Solid compatibility texels baked by build-original-assets. A transparent
  // texel here silently disables an engine feature (published skins once
  // shipped an invisible judgment line and simultaneous-press line).
  for (const name of ["sim_line", "judgment_line", "preview_lane", "preview_border"] as const) {
    const source = special.get(name)!;
    const alpha = texture.pixels[((source.y + Math.floor(source.h / 2)) * texture.width + source.x + Math.floor(source.w / 2)) * 4 + 3];
    if (!alpha) throw new Error(`${skinName} compatibility sprite ${name} is transparent; bake the common texture first`);
  }

  return {
    skinSprites: sprites,
    nativeSprites: native.length,
    nativeArea: native.reduce((area, sprite) => area + sprite.w * sprite.h, 0),
    texture,
  };
}

export interface NativeNoteSkinPackSummary {
  skinName: BundledNoteSkin;
  outputDirectory: string;
  sprites: number;
  nativeSprites: number;
  nativeArea: number;
}

export function buildNativeNoteSkinPacks(
  outputRoot: string,
  commonTexture: DecodedRgbaPng,
): NativeNoteSkinPackSummary[] {
  const skinNames = [...OUR_NOTES_NOTE_SKINS] as BundledNoteSkin[];
  const expectedSkins: BundledNoteSkin[] = ["skin001", "skin002", "skin003"];
  if (skinNames.length !== expectedSkins.length || expectedSkins.some((name, index) => skinNames[index] !== name)) {
    throw new Error(`Published Our Notes note skin list must be exactly ${expectedSkins.join(", ")}`);
  }
  mkdirSync(outputRoot, { recursive: true });
  const summaries: NativeNoteSkinPackSummary[] = [];
  for (const skinName of skinNames) {
    const atlas = OUR_NOTES_BUNDLED_NOTE_ATLASES[skinName];
    if (!atlas) throw new Error(`Published Our Notes atlas ${skinName} is missing`);
    const result = packSkin(skinName, atlas, commonTexture);
    const outputDirectory = `${outputRoot}/${skinName}`;
    mkdirSync(outputDirectory, { recursive: true });
    writeFileSync(
      `${outputDirectory}/skin.data`,
      gzipSync(
        JSON.stringify({
          width: NATIVE_TEXTURE_SIZE,
          height: COMMON_TEXTURE_HEIGHT,
          interpolation: true,
          sprites: result.skinSprites,
        }),
        { level: 9 },
      ),
    );
    writeFileSync(`${outputDirectory}/skin.texture.png`, encodeRgba8Png(result.texture));
    summaries.push({
      skinName,
      outputDirectory,
      sprites: result.skinSprites.length,
      nativeSprites: result.nativeSprites,
      nativeArea: result.nativeArea,
    });
  }
  return summaries;
}
