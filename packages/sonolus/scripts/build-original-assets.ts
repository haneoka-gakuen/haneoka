import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { deflateSync, gunzipSync, gzipSync, inflateSync } from "node:zlib";
import { resolveSonolusReleaseWorkspace } from "../src/server/releaseWorkspace.ts";

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

interface AtlasEntry {
  name: string;
  rect: { x: number; y: number; width: number; height: number };
  settingsRaw: number;
}

type VertexComponent = "x1" | "y1" | "x2" | "y2" | "x3" | "y3" | "x4" | "y4";
type SpriteTransform = Record<VertexComponent, Partial<Record<VertexComponent, number>>>;

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

interface PngChunk {
  type: string;
  bytes: Buffer;
}

interface DecodedRgbaPng {
  signature: Buffer;
  chunks: PngChunk[];
  width: number;
  height: number;
  pixels: Buffer;
}

type NormalizedRgba = readonly [red: number, green: number, blue: number, alpha: number];
type ByteRgba = readonly [red: number, green: number, blue: number, alpha: number];

const CHANNELS = [0, 1, 2, 3] as const;

function parseJson(text: string, sourceName: string): JsonValue {
  try {
    return JSON.parse(text) as JsonValue;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${sourceName} is not valid JSON: ${detail}`, { cause: error });
  }
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireJsonObject(value: JsonValue | undefined, path: string): JsonObject {
  if (!value || !isJsonObject(value)) throw new Error(`${path} must be an object`);
  return value;
}

function requireFiniteNumber(value: JsonValue | undefined, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${path} must be a finite number`);
  return value;
}

function readAtlasEntries(file: string): AtlasEntry[] {
  const document = requireJsonObject(parseJson(readFileSync(file, "utf8"), file), "atlas");
  const data = requireJsonObject(document.data, "atlas.data");
  const names = data.m_PackedSpriteNamesToIndex;
  const renderData = data.m_RenderDataMap;
  if (!Array.isArray(names)) throw new Error("atlas.data.m_PackedSpriteNamesToIndex must be an array");
  if (!Array.isArray(renderData)) throw new Error("atlas.data.m_RenderDataMap must be an array");
  if (names.length !== renderData.length) {
    throw new Error(`atlas sprite name/render data length mismatch: ${names.length} != ${renderData.length}`);
  }

  return names.map((name, index) => {
    if (typeof name !== "string" || !name) throw new Error(`atlas sprite name ${index} must be a non-empty string`);
    const pair = renderData[index];
    if (!Array.isArray(pair) || pair.length < 2) throw new Error(`atlas render data ${index} must be a key/value pair`);
    const render = requireJsonObject(pair[1], `atlas.data.m_RenderDataMap[${index}][1]`);
    const rect = requireJsonObject(render.textureRect, `atlas render data ${index}.textureRect`);
    return {
      name,
      rect: {
        x: requireFiniteNumber(rect.x, `atlas render data ${index}.textureRect.x`),
        y: requireFiniteNumber(rect.y, `atlas render data ${index}.textureRect.y`),
        width: requireFiniteNumber(rect.width, `atlas render data ${index}.textureRect.width`),
        height: requireFiniteNumber(rect.height, `atlas render data ${index}.textureRect.height`),
      },
      settingsRaw: requireFiniteNumber(render.settingsRaw, `atlas render data ${index}.settingsRaw`),
    };
  });
}

function byteAt(buffer: Uint8Array, index: number, context: string): number {
  const value = buffer[index];
  if (value === undefined) throw new Error(`${context}: byte ${index} is out of bounds for ${buffer.length} bytes`);
  return value;
}

const root = resolve(process.env.OUR_NOTES_ROOT || process.cwd());
const source = resolve(process.env.SONOLUS_ORIGINAL_ASSETS_DIR || resolve(root, "packages/sonolus/assets/original"));
const out = resolve(root, "packages/sonolus/dist/our-notes");

mkdirSync(out, { recursive: true });

const atlas = readAtlasEntries(resolve(source, "skin001.atlas.json"));
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
const flipHorizontal = {
  x1: { x4: 1 },
  y1: { y4: 1 },
  x2: { x3: 1 },
  y2: { y3: 1 },
  x3: { x2: 1 },
  y3: { y2: 1 },
  x4: { x1: 1 },
  y4: { y1: 1 },
} satisfies SpriteTransform;
const flipVertical = {
  x1: { x2: 1 },
  y1: { y2: 1 },
  x2: { x1: 1 },
  y2: { y1: 1 },
  x3: { x4: 1 },
  y3: { y4: 1 },
  x4: { x3: 1 },
  y4: { y3: 1 },
} satisfies SpriteTransform;

const sprites: SkinSprite[] = [];
const originals = new Map<string, SkinSprite>();

for (const entry of atlas) {
  const { name, rect } = entry;
  // Unity SpriteAtlas coordinates start at the lower-left. Sonolus skin
  // coordinates start at the upper-left of the texture.
  const x = Math.floor(rect.x);
  const y = Math.floor(2048 - rect.y - rect.height);
  const w = Math.max(1, Math.ceil(rect.x + rect.width) - x);
  const h = Math.max(1, Math.ceil(2048 - rect.y) - y);
  // Unity SpritePackingRotation lives in settingsRaw bits 2..5. skin001 has
  // one horizontal and one vertical flip; aliases must retain that transform.
  const rotation = (entry.settingsRaw >> 2) & 0xf;
  const transform = rotation === 1 ? flipHorizontal : rotation === 2 ? flipVertical : identity;
  const sprite = { name, x, y, w, h, transform };
  originals.set(name, sprite);
  sprites.push(sprite);
}

const special = new Map<string, SpriteSource>([
  ["lane_base", { x: 0, y: 2048, w: 2048, h: 1644 }],
  ["slide_line", { x: 0, y: 3692, w: 100, h: 48 }],
  // The connector shader selects V=.5. Sonolus linearly samples the entire
  // sprite rectangle for every connector quad, so exposing a literal
  // one-pixel row lets the transparent neighbouring rows bleed into both
  // longitudinal edges of every tessellation unit. The compatibility strips
  // below are eight identical rows with a one-pixel duplicate gutter outside
  // their declared rect; this keeps the transverse U mask while making V
  // constant and therefore removes the repeated horizontal banding.
  ["slide_line_fixed_v", { x: 401, y: 3693, w: 100, h: 8 }],
  ["slide_line_normal", { x: 505, y: 3693, w: 100, h: 8 }],
  ["slide_line_pressed", { x: 609, y: 3693, w: 100, h: 8 }],
  ["slide_line_guide", { x: 713, y: 3693, w: 100, h: 8 }],
  // Preview is an orthographic chart, not the live perspective lane. It must
  // use dedicated flat sprites instead of stretching lane_base into six
  // vertical rectangles (which turns the trapezoid's alpha edge into teeth).
  ["preview_lane", { x: 817, y: 3693, w: 8, h: 8 }],
  ["preview_border", { x: 829, y: 3693, w: 8, h: 8 }],
  ["preview_divider", { x: 841, y: 3693, w: 8, h: 8 }],
  ["sim_line", { x: 853, y: 3693, w: 8, h: 8 }],
  ["guideline_gradient", { x: 326, y: 3692, w: 1, h: 2 }],
  ["guideline_space", { x: 328, y: 3692, w: 1, h: 1 }],
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

function alias(name: string, sourceName: string): void {
  const sourceSprite = originals.get(sourceName) || special.get(sourceName);
  if (!sourceSprite) throw new Error(`Unknown original sprite alias: ${sourceName}`);
  const { x, y, w, h, transform = identity } = sourceSprite;
  sprites.push({ name, x, y, w, h, transform });
}

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

const noteSets = [
  ["normalNote", "notes_tap_side_L", "notes_tap_side_0", "notes_tap_side_R"],
  ["slideNote", "notes_slide_side_L", "notes_slide_side_0", "notes_slide_side_R"],
  ["slideEndNote", "notes_slide_end_side_L", "notes_slide_end_side_0", "notes_slide_end_side_R"],
  ["flickNote", "notes_flick_side_L", "notes_flick_side_0", "notes_flick_side_R"],
  ["flickLeftNote", "notes_flick_left_side_L", "notes_flick_left_side_0", "notes_flick_left_side_R"],
  ["flickRightNote", "notes_flick_right_side_L", "notes_flick_right_side_0", "notes_flick_right_side_R"],
  ["criticalNote", "notes_tap_side_L", "notes_tap_side_0", "notes_tap_side_R"],
] as const;
const labels = {
  normalNote: "Cyan",
  slideNote: "Green",
  slideEndNote: "Green End",
  flickNote: "Red",
  flickLeftNote: "Red Leftward",
  flickRightNote: "Red Rightward",
  criticalNote: "Yellow",
} satisfies Record<(typeof noteSets)[number][0], string>;
for (const [key, left, middle, right] of noteSets) {
  const color = labels[key];
  alias(`Our Notes Note ${color} Left`, left);
  alias(`Our Notes Note ${color} Middle`, middle);
  alias(`Our Notes Note ${color} Right`, right);
}

for (const [name, sourceName] of [
  ["#NOTE_HEAD_CYAN", "notes_tap_side_0"],
  ["#NOTE_HEAD_GREEN", "notes_slide_side_0"],
  ["#NOTE_TAIL_GREEN", "notes_slide_end_side_0"],
  ["#NOTE_HEAD_RED", "notes_flick_side_0"],
  ["#NOTE_TAIL_RED", "notes_flick_side_0"],
  ["#NOTE_HEAD_YELLOW", "notes_tap_side_0"],
  ["#NOTE_TAIL_YELLOW", "notes_slide_end_side_0"],
  ["#NOTE_TICK_GREEN", "slide_connection_icon"],
  ["#NOTE_TICK_YELLOW", "slide_connection_icon"],
  ["#NOTE_TICK_RED", "flick_decoration"],
  ["Our Notes Diamond Green", "slide_connection_icon"],
  ["Our Notes Diamond Yellow", "slide_connection_icon"],
  ["Our Notes Trace Diamond Green", "note_trace_3"],
  ["Our Notes Trace Diamond Yellow", "note_trace_3"],
  ["Our Notes Trace Diamond Red", "flick_decoration"],
] as const)
  alias(name, sourceName);

for (const [name, sourceName] of [
  ["Our Notes Tap Decoration", "tap_decoration"],
  ["Our Notes Slide Decoration", "slide_decoration"],
  ["Our Notes Flick Decoration", "flick_decoration"],
  ["Our Notes Flick Left Decoration", "flick_left_decoration"],
  ["Our Notes Flick Right Decoration", "flick_right_decoration"],
] as const)
  alias(name, sourceName);

for (const [color, prefix] of [
  ["Green", "notes_trace"],
  ["Yellow", "notes_trace"],
  ["Red", "notes_flick"],
] as const) {
  alias(`Our Notes Trace Note ${color}`, `${prefix}_side_0`);
  alias(`Our Notes Trace Note ${color} Left`, `${prefix}_side_L`);
  alias(`Our Notes Trace Note ${color} Middle`, `${prefix}_side_0`);
  alias(`Our Notes Trace Note ${color} Right`, `${prefix}_side_R`);
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

// The upstream PJS engine models hit feedback as slot/glow skin sprites. The
// Unity game does not: LiveLaneEffectView.PlayEffect dispatches authored
// ParticleSystems (InVain/Normal/Slide/Flick/Left/Right) and scales their root
// to the hit width. Do not bind those optional PJS sprite names to lane_tap;
// doing so turns every hit into the large rectangular blocks seen in-game.

for (let i = 1; i <= 8; i++) {
  // The up array is indexed by the four width buckets [5, 12, 17, 9999].
  // Directional arrays retain their 01..08 entries.
  const up =
    i === 1
      ? "notes_flick_arrow_upper_S"
      : i === 2
        ? "notes_flick_arrow_upper_M"
        : i === 3
          ? "notes_flick_arrow_upper_L"
          : "notes_flick_arrow_upper_LL";
  const left = `notes_flick_arrow_left_0${i}`;
  const right = `notes_flick_arrow_right_0${i}`;
  alias(`Our Notes Flick Arrow Red Up ${i}`, up);
  alias(`Our Notes Flick Arrow Red Left ${i}`, left);
  alias(`Our Notes Flick Arrow Red Right ${i}`, right);
  alias(`Our Notes Flick Arrow Yellow Up ${i}`, up);
  alias(`Our Notes Flick Arrow Yellow Left ${i}`, left);
  alias(`Our Notes Flick Arrow Yellow Right ${i}`, right);
}
alias("#DIRECTIONAL_MARKER_RED", "notes_flick_arrow_upper_M");
alias("#DIRECTIONAL_MARKER_YELLOW", "notes_flick_arrow_upper_M");

const skinData = { width: 2048, height: 4096, interpolation: true, sprites };
writeFileSync(resolve(out, "skin.data"), gzipSync(JSON.stringify(skinData), { level: 9 }));

// Sonolus skin sprites cannot run the SlideLine shader. Preserve its exact
// V=.5 mask and pre-bake the shader's judgement-end color keys. The shader's
// depth-continuous gradient remains an engine API limit.
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

function decodeRgba8Png(input: Buffer, sourceName: string): DecodedRgbaPng {
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

function encodeRgba8Png({ signature, chunks, width, height, pixels }: DecodedRgbaPng): Buffer {
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

function bakeSlideLineColors(input: Buffer): Buffer {
  const decoded = decodeRgba8Png(input, "skin.texture.png");
  const { width, height, pixels } = decoded;
  if (width < 862 || height < 3717) {
    throw new Error(`skin.texture.png is too small for compatibility sprites: ${width}x${height}`);
  }
  const stride = width * 4;

  const sourceSlideRow = Buffer.from(pixels.subarray(3716 * stride, 3716 * stride + 100 * 4));
  const writePaddedSlideStrip = (spriteX: number, rgba: NormalizedRgba): void => {
    // The declared sprite occupies y=3693..3700. Duplicate it once above and
    // below so bilinear filtering at either UV boundary never samples alpha 0.
    for (let y = 3692; y <= 3701; y++) {
      for (let x = -1; x <= 100; x++) {
        const sourceX = Math.max(0, Math.min(99, x));
        const sourceOffset = sourceX * 4;
        const targetOffset = y * stride + (spriteX + x) * 4;
        pixels[targetOffset] = Math.round(byteAt(sourceSlideRow, sourceOffset, "slide source") * rgba[0]);
        pixels[targetOffset + 1] = Math.round(byteAt(sourceSlideRow, sourceOffset + 1, "slide source") * rgba[1]);
        pixels[targetOffset + 2] = Math.round(byteAt(sourceSlideRow, sourceOffset + 2, "slide source") * rgba[2]);
        pixels[targetOffset + 3] = Math.round(byteAt(sourceSlideRow, sourceOffset + 3, "slide source") * rgba[3]);
      }
    }
  };

  // SlideLine judgement-end color keys from the slide line material. The
  // uncoloured strip is retained for Sonolus fallback sprite names; custom
  // connector archetypes use the three coloured strips.
  writePaddedSlideStrip(401, [1, 1, 1, 1]);
  writePaddedSlideStrip(505, [0.4796607196, 0.2862745523, 1, 0.8627451062]);
  writePaddedSlideStrip(609, [0.6041513681, 0.334905684, 1, 0.8627451062]);
  writePaddedSlideStrip(713, [0.470588237, 0.384313732, 1, 0.509803951]);

  const writePaddedSolid = (spriteX: number, rgba: ByteRgba): void => {
    for (let y = 3692; y <= 3701; y++) {
      for (let x = -1; x <= 8; x++) {
        const targetOffset = y * stride + (spriteX + x) * 4;
        for (const channel of CHANNELS) {
          pixels[targetOffset + channel] = rgba[channel];
        }
      }
    }
  };
  // lane_base's opaque centre is exactly sRGBA(9,19,46,1). The orthographic
  // preview uses that flat colour; borders follow the judgement white and
  // dividers use the serialized lane-line grey at restrained alpha.
  writePaddedSolid(817, [9, 19, 46, 255]);
  writePaddedSolid(829, [250, 246, 255, 255]);
  writePaddedSolid(841, [156, 156, 156, 72]);
  // The pair-note prefab uses Sprite-Unlit-Default with an untinted white
  // SpriteRenderer. Keep this independent from the purple SlideLine strips.
  writePaddedSolid(853, [255, 255, 255, 255]);

  // LiveLaneLine styles 0/2. Main lines interpolate alpha 1 -> 0 from
  // judgment to horizon; Space ticks use the serialized uniform gray.
  const lanePixels: ReadonlyArray<readonly [x: number, y: number, rgba: NormalizedRgba]> = [
    [326, 3692, [0.6156863, 0.6156863, 0.6156863, 0]],
    [326, 3693, [0.6132076, 0.6132076, 0.6132076, 1]],
    [328, 3692, [0.6117647, 0.6117647, 0.6117647, 1]],
    [330, 3692, [250 / 255, 246 / 255, 1, 1]],
  ];
  for (const [x, y, rgba] of lanePixels) {
    const targetOffset = y * stride + x * 4;
    for (const channel of CHANNELS) {
      pixels[targetOffset + channel] = Math.round(rgba[channel] * 255);
    }
  }

  return encodeRgba8Png(decoded);
}

writeFileSync(resolve(out, "skin.texture.png"), bakeSlideLineColors(readFileSync(resolve(source, "skin.texture.png"))));

const workspace = resolveSonolusReleaseWorkspace(process.env.RELEASE_SERVER || "jp-cbt", root);
const nativeEffectRoot = resolve(
  workspace.runtimeRoot,
  "unity-json/Assets/AddressableResources/Live/NoteEffect/effect001",
);
const nativeEffectCommonRoot = resolve(
  workspace.runtimeRoot,
  "unity/Assets/AddressableResources/Live/NoteEffect/common",
);
const nativeLaneEffectRoot = resolve(workspace.runtimeRoot, "unity/Assets/AddressableResources/Live/Images");
const nativeEffectAnimationRoot = resolve(
  workspace.runtimeRoot,
  "unity-json/Assets/AddressableResources/Live/NoteEffect/common/anim",
);

// LiveAllNoteEffectView uses 24 chart half-lanes across the 19.12000084-unit
// physical lane, so a normal (size=2) note effect is 19.12000084 / 12 units
// wide.  Keep all effect001 billboards in that native one-lane reference
// space before projecting them into Sonolus' [-1, 1] particle coordinates.
// LiveGameNoteEffectBase.SetWidth adds .4 to the sliced frame width.
const nativeEffectPhysicalLaneWidth = 19.12000084;
const nativeEffectReferenceWidth = nativeEffectPhysicalLaneWidth / 12;
const nativeEffectFrameWidthPadding = 0.4;
const nativeEffectFrameScaleX = 1.02;
const nativeEffectPillarPivotY = 0.04267627373337746;

const nativeEffectCoordinateScale = {
  // A full source lane occupies two local X units (-1 to 1).
  x: 2 / nativeEffectReferenceWidth,
} as const;

function nativeEffectWidthRangeScale(range: readonly [number, number]): number {
  const [min, max] = range;
  return min + (max - min) * (nativeEffectReferenceWidth / nativeEffectPhysicalLaneWidth);
}

// LiveGameCamera.asset: position=(0,10,0), X rotation=29.60445665468814°,
// FOV=54°.  SpriteRenderers and ParticleSystems are authored in that world
// space, so project their vertical bounds instead of treating world Y as a
// flat lane-depth coordinate.
const nativeEffectCameraHeight = 10;
const nativeEffectJudgementZ = 9.62;
const nativeEffectCameraSin = Math.sin((29.60445665468814 * Math.PI) / 180);
const nativeEffectCameraCos = Math.cos((29.60445665468814 * Math.PI) / 180);
const nativeEffectCameraTanHalfFov = Math.tan((54 * Math.PI) / 360);

function nativeEffectNdcY(y: number, z: number): number {
  return (
    (nativeEffectCameraCos * (y - nativeEffectCameraHeight) + nativeEffectCameraSin * (nativeEffectJudgementZ + z)) /
    ((nativeEffectCameraHeight - y) * nativeEffectCameraSin + (nativeEffectJudgementZ + z) * nativeEffectCameraCos) /
    nativeEffectCameraTanHalfFov
  );
}

const nativeEffectOriginNdcY = nativeEffectNdcY(0, 0);
const nativeEffectOneLaneNdcY = nativeEffectNdcY(0, nativeEffectReferenceWidth) - nativeEffectOriginNdcY;

function nativeEffectLocalY(y: number, z: number): number {
  return -1 + (nativeEffectNdcY(y, z) - nativeEffectOriginNdcY) / nativeEffectOneLaneNdcY;
}

function nativeEffectGroundRect(z: number, height: number): { y: number; h: number } {
  const b = nativeEffectLocalY(0, z - height / 2);
  const t = nativeEffectLocalY(0, z + height / 2);
  return { y: (b + t) / 2, h: t - b };
}

function nativeEffectVerticalRect(y: number, z: number, height: number, pivot: number): { y: number; h: number } {
  const b = nativeEffectLocalY(y - pivot * height, z);
  const t = nativeEffectLocalY(y + (1 - pivot) * height, z);
  return { y: (b + t) / 2, h: t - b };
}

const nativeParticleSpriteSpecs = [
  { key: "lane", x: 0, y: 0, w: 128, h: 126 },
  { key: "star", x: 132, y: 0, w: 47, h: 125, source: "ef_tap_particle_star.png" },
  { key: "longStar", x: 184, y: 0, w: 47, h: 235, source: "ef_tap_particle_star_long.png" },
  { key: "line", x: 236, y: 0, w: 128, h: 128, source: "ef_tap_line.png" },
  { key: "pillar", x: 368, y: 0, w: 25, h: 128, source: "ef_tap_pillar.png" },
  { key: "centerPillar", x: 400, y: 0, w: 118, h: 420, source: "ef_pillar_center.png" },
  { key: "centerPillar02", x: 524, y: 0, w: 414, h: 387, source: "ef_pillar_center02.png" },
  // Unity renders this on a custom wall mesh. Sonolus has no equivalent mesh
  // particle, but the original 64x487 alpha mask is still materially closer
  // than omitting it or substituting a rectangular glow.
  { key: "wall", x: 944, y: 0, w: 64, h: 487, source: "ef_wall.png" },
] as const;
type NativeParticleSpriteKey = (typeof nativeParticleSpriteSpecs)[number]["key"];

const nativeParticleSpriteIndices = Object.fromEntries(
  nativeParticleSpriteSpecs.map(({ key }, index) => [key, index]),
) as Record<NativeParticleSpriteKey, number>;

function preparedPng(root: string, sourceName: string): Buffer {
  const directory = resolve(root, sourceName);
  const files = readdirSync(directory).filter((file) => file.endsWith(".png"));
  if (files.length !== 1 || !files[0]) {
    throw new Error(`${directory} must contain exactly one prepared PNG, found ${files.length}`);
  }
  return readFileSync(resolve(directory, files[0]));
}

const preparedNativePng = (sourceName: string): Buffer => preparedPng(nativeEffectCommonRoot, sourceName);

function copyNativeParticleSprite(
  atlas: DecodedRgbaPng,
  input: Buffer,
  spec: (typeof nativeParticleSpriteSpecs)[number],
  sourceName: string,
): void {
  const sprite = decodeRgba8Png(input, sourceName);
  if (sprite.width !== spec.w || sprite.height !== spec.h) {
    throw new Error(`${sourceName} must be ${spec.w}x${spec.h}, got ${sprite.width}x${sprite.height}`);
  }
  if (spec.x + spec.w > atlas.width || spec.y + spec.h > atlas.height) {
    throw new Error(`${sourceName} does not fit in the native particle atlas`);
  }

  const atlasStride = atlas.width * 4;
  const spriteStride = sprite.width * 4;
  for (let y = 0; y < sprite.height; y++) {
    const targetStart = (spec.y + y) * atlasStride + spec.x * 4;
    sprite.pixels.copy(atlas.pixels, targetStart, y * spriteStride, (y + 1) * spriteStride);
  }
}

function bakeNativeParticleTexture(input: Buffer, nativeLaneMaskInput: Buffer): Buffer {
  // The old PJS atlas is used only as a PNG container. Erase every source
  // texel before copying the selected effect001 sprites so no block, wall, or
  // spark from the unrelated engine can remain reachable.
  const atlas = decodeRgba8Png(input, "particle.texture.png");
  if (atlas.width !== 1024 || atlas.height !== 1024) {
    throw new Error(`particle.texture.png must be 1024x1024, got ${atlas.width}x${atlas.height}`);
  }
  atlas.pixels.fill(0);

  for (const spec of nativeParticleSpriteSpecs) {
    const bytes = spec.key === "lane" ? nativeLaneMaskInput : preparedNativePng(spec.source);
    copyNativeParticleSprite(atlas, bytes, spec, spec.key === "lane" ? "lane_effect_white.png" : spec.source);
  }
  return encodeRgba8Png(atlas);
}

const particleCurve = (value: number): JsonObject => ({ c: value });
const randomizedParticleCurve = (value: number, key: number, amplitude: number): JsonObject =>
  amplitude > 0 ? { c: value, [`sinr${key}`]: amplitude } : particleCurve(value);

function particleProperty(
  from: JsonObject,
  to: JsonObject,
  ease: "linear" | "inCubic" | "outCubic" | "inOutSine" = "outCubic",
): JsonObject {
  return { from, to, ease };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function colorHex(value: JsonObject, path: string): string {
  const component = (name: "r" | "g" | "b") =>
    Math.round(clamp(requireFiniteNumber(value[name], `${path}.${name}`), 0, 1) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${component("r")}${component("g")}${component("b")}`;
}

function unityObjectData(file: string, type: "AnimationClip" | "ParticleSystem" | "SpriteRenderer"): JsonObject {
  const document = requireJsonObject(parseJson(readFileSync(file, "utf8"), file), file);
  if (document.type !== type) throw new Error(`${file} must project a Unity ${type}`);
  return requireJsonObject(document.data, `${file}.data`);
}

interface NativeCurveKey {
  time: number;
  value: number;
  inSlope: number;
  outSlope: number;
}

function readNativeCurve(value: JsonValue | undefined, path: string): NativeCurveKey[] {
  const curve = requireJsonObject(value, path);
  const keys = curve.m_Curve;
  if (!Array.isArray(keys)) throw new Error(`${path}.m_Curve must be an array`);
  return keys.map((entry, index) => {
    const key = requireJsonObject(entry, `${path}.m_Curve[${index}]`);
    return {
      time: requireFiniteNumber(key.time, `${path}.m_Curve[${index}].time`),
      value: requireFiniteNumber(key.value, `${path}.m_Curve[${index}].value`),
      inSlope: requireFiniteNumber(key.inSlope, `${path}.m_Curve[${index}].inSlope`),
      outSlope: requireFiniteNumber(key.outSlope, `${path}.m_Curve[${index}].outSlope`),
    };
  });
}

function evaluateNativeCurve(value: JsonValue | undefined, time: number, path: string): number {
  const keys = readNativeCurve(value, path);
  if (!keys.length) return 1;
  const first = keys[0]!;
  const last = keys.at(-1)!;
  if (time <= first.time) return first.value;
  if (time >= last.time) return last.value;
  for (let index = 0; index < keys.length - 1; index++) {
    const from = keys[index]!;
    const to = keys[index + 1]!;
    if (time > to.time) continue;
    const length = to.time - from.time;
    const progress = (time - from.time) / length;
    const progress2 = progress * progress;
    const progress3 = progress2 * progress;
    return (
      (2 * progress3 - 3 * progress2 + 1) * from.value +
      (progress3 - 2 * progress2 + progress) * from.outSlope * length +
      (-2 * progress3 + 3 * progress2) * to.value +
      (progress3 - progress2) * to.inSlope * length
    );
  }
  return last.value;
}

function evaluateMinMaxCurve(value: JsonValue | undefined, time: number, path: string): number {
  const curve = requireJsonObject(value, path);
  // InitialModule.startSize in this Unity version wraps the actual MinMaxCurve
  // in a `curve` member when separate-axis size is enabled.
  if (curve.minMaxState === undefined && curve.curve !== undefined) {
    return evaluateMinMaxCurve(curve.curve, time, `${path}.curve`);
  }
  const state = Math.round(requireFiniteNumber(curve.minMaxState, `${path}.minMaxState`));
  const scalar = requireFiniteNumber(curve.scalar, `${path}.scalar`);
  const minScalar = requireFiniteNumber(curve.minScalar, `${path}.minScalar`);
  if (state === 0) return scalar;
  if (state === 1) return scalar * evaluateNativeCurve(curve.maxCurve, time, `${path}.maxCurve`);
  if (state === 2) {
    const minimum = minScalar * evaluateNativeCurve(curve.minCurve, time, `${path}.minCurve`);
    const maximum = scalar * evaluateNativeCurve(curve.maxCurve, time, `${path}.maxCurve`);
    return (minimum + maximum) / 2;
  }
  if (state === 3) return (minScalar + scalar) / 2;
  throw new Error(`${path}.minMaxState has unsupported value ${state}`);
}

function minMaxScalarRange(value: JsonValue | undefined, path: string): readonly [number, number] {
  const curve = requireJsonObject(value, path);
  if (curve.minMaxState === undefined && curve.curve !== undefined) {
    return minMaxScalarRange(curve.curve, `${path}.curve`);
  }
  const state = Math.round(requireFiniteNumber(curve.minMaxState, `${path}.minMaxState`));
  const scalar = requireFiniteNumber(curve.scalar, `${path}.scalar`);
  const minScalar = requireFiniteNumber(curve.minScalar, `${path}.minScalar`);
  return state === 3 ? [Math.min(minScalar, scalar), Math.max(minScalar, scalar)] : [scalar, scalar];
}

function bitsToFloat(value: number): number {
  const buffer = new ArrayBuffer(4);
  const view = new DataView(buffer);
  view.setUint32(0, value >>> 0, true);
  return view.getFloat32(0, true);
}

interface NativeAnimationClip {
  duration: number;
  streamedCurveCount: number;
  constantValues: readonly number[];
  frames: ReadonlyArray<{
    time: number;
    coefficients: ReadonlyMap<number, readonly [number, number, number, number]>;
  }>;
  bindings: ReadonlyMap<string, { curveStart: number; componentCount: number }>;
}

function readNativeAnimationClip(name: string): NativeAnimationClip {
  const file = resolve(nativeEffectAnimationRoot, name, "AnimationClip.json");
  const data = unityObjectData(file, "AnimationClip");
  const muscle = requireJsonObject(data.m_MuscleClip, `${file}.data.m_MuscleClip`);
  const clip = requireJsonObject(muscle.m_Clip, `${file}.data.m_MuscleClip.m_Clip`);
  const clipData = requireJsonObject(clip.data, `${file}.data.m_MuscleClip.m_Clip.data`);
  const streamed = requireJsonObject(clipData.m_StreamedClip, `${file}.data.m_MuscleClip.m_Clip.data.m_StreamedClip`);
  const rawWords = streamed.data;
  if (!Array.isArray(rawWords)) throw new Error(`${file} streamed clip data must be an array`);
  const words = rawWords.map(
    (word, index) => Math.round(requireFiniteNumber(word, `${file}.streamed[${index}]`)) >>> 0,
  );
  const curveCount = Math.max(0, Math.round(requireFiniteNumber(streamed.curveCount, `${file}.curveCount`)));
  const frames: Array<{
    time: number;
    coefficients: ReadonlyMap<number, readonly [number, number, number, number]>;
  }> = [];
  let cursor = 0;
  while (cursor + 2 <= words.length) {
    const time = bitsToFloat(words[cursor++]!);
    const keyCount = words[cursor++]!;
    if (keyCount > curveCount || cursor + keyCount * 5 > words.length) break;
    const coefficients = new Map<number, readonly [number, number, number, number]>();
    for (let index = 0; index < keyCount; index++) {
      const curveIndex = words[cursor++]!;
      coefficients.set(curveIndex, [
        bitsToFloat(words[cursor++]!),
        bitsToFloat(words[cursor++]!),
        bitsToFloat(words[cursor++]!),
        bitsToFloat(words[cursor++]!),
      ]);
    }
    frames.push({ time, coefficients });
  }

  const dense = requireJsonObject(clipData.m_DenseClip, `${file}.data.m_MuscleClip.m_Clip.data.m_DenseClip`);
  const denseCurveCount = Math.max(
    0,
    Math.round(
      requireFiniteNumber(dense.m_CurveCount, `${file}.data.m_MuscleClip.m_Clip.data.m_DenseClip.m_CurveCount`),
    ),
  );
  const denseSamples = dense.m_SampleArray;
  if (!Array.isArray(denseSamples)) {
    throw new Error(`${file}.data.m_MuscleClip.m_Clip.data.m_DenseClip.m_SampleArray must be an array`);
  }
  // The selected reference release stores these effects as streamed and
  // constant curves. Refuse a future dense encoding rather than silently
  // associating its values with the wrong Unity binding.
  if (denseCurveCount || denseSamples.length) {
    throw new Error(`${file} uses unsupported dense AnimationClip curves`);
  }

  const constant = requireJsonObject(clipData.m_ConstantClip, `${file}.data.m_MuscleClip.m_Clip.data.m_ConstantClip`);
  const rawConstantValues = constant.data;
  if (!Array.isArray(rawConstantValues)) {
    throw new Error(`${file}.data.m_MuscleClip.m_Clip.data.m_ConstantClip.data must be an array`);
  }
  const constantValues = rawConstantValues.map((value, index) =>
    requireFiniteNumber(value, `${file}.data.m_MuscleClip.m_Clip.data.m_ConstantClip.data[${index}]`),
  );

  const bindingRoot = requireJsonObject(data.m_ClipBindingConstant, `${file}.data.m_ClipBindingConstant`);
  const genericBindings = bindingRoot.genericBindings;
  if (!Array.isArray(genericBindings)) throw new Error(`${file} genericBindings must be an array`);
  const bindings = new Map<string, { curveStart: number; componentCount: number }>();
  let curveStart = 0;
  for (const [index, value] of genericBindings.entries()) {
    const binding = requireJsonObject(value, `${file}.genericBindings[${index}]`);
    const typeId = Math.round(requireFiniteNumber(binding.typeID, `${file}.genericBindings[${index}].typeID`));
    const attribute = Math.round(requireFiniteNumber(binding.attribute, `${file}.genericBindings[${index}].attribute`));
    const componentCount = typeId === 4 && attribute === 1 ? 3 : 1;
    const pathHash = Math.round(requireFiniteNumber(binding.path, `${file}.genericBindings[${index}].path`)) >>> 0;
    bindings.set(`${typeId}:${pathHash}:${attribute >>> 0}`, {
      curveStart,
      componentCount,
    });
    curveStart += componentCount;
  }
  const expectedCurveCount = curveCount + constantValues.length;
  if (curveStart !== expectedCurveCount) {
    throw new Error(`${file} binding curves ${curveStart} != streamed + constant curves ${expectedCurveCount}`);
  }
  return {
    duration: requireFiniteNumber(muscle.m_StopTime, `${file}.data.m_MuscleClip.m_StopTime`),
    streamedCurveCount: curveCount,
    constantValues,
    frames,
    bindings,
  };
}

function nativeClipValue(
  clip: NativeAnimationClip,
  typeId: number,
  pathHash: number,
  attributeHash: number,
  time: number,
  component = 0,
): number | undefined {
  const binding = clip.bindings.get(`${typeId}:${pathHash >>> 0}:${attributeHash >>> 0}`);
  if (!binding || component < 0 || component >= binding.componentCount) return undefined;
  const curveIndex = binding.curveStart + component;
  if (curveIndex >= clip.streamedCurveCount) {
    return clip.constantValues[curveIndex - clip.streamedCurveCount];
  }
  let frame: NativeAnimationClip["frames"][number] | undefined;
  for (const candidate of clip.frames) {
    if (candidate.time > time) break;
    if (candidate.coefficients.has(curveIndex)) frame = candidate;
  }
  const coefficients = frame?.coefficients.get(curveIndex);
  if (!frame || !coefficients) return undefined;
  const delta = time - frame.time;
  return ((coefficients[0] * delta + coefficients[1]) * delta + coefficients[2]) * delta + coefficients[3];
}

interface NativeSystemProjection {
  file: string;
  animationPath: string;
  /** World-space side-flick particles inherit this animated parent's position at emission. */
  motionPath?: string;
  /** Source hierarchy scale of motionPath, applied before rate-over-distance integration. */
  motionPathScaleX?: number;
  sprite: "star" | "longStar" | "centerPillar" | "centerPillar02" | "wall";
  /** Local source Z position, used for the native live-camera projection. */
  z?: number;
  y: number;
  /** SetWidth replaces the serialized ShapeModule width with referenceWidth + this offset. */
  shapeWidthOffset?: number;
  /**
   * LiveGameNoteEffectBase.SetWidth writes a width-derived localScale.x to
   * this system's Transform. The generated effect uses the normal note's
   * reference width, so this captures the original range at size=2.
   */
  widthScaleRange?: readonly [min: number, max: number];
  /** Hierarchy scales particle position/width; Local replaces the moving emitter path scale. */
  widthScaleMode?: "hierarchy" | "motionPath";
  /** Authored local Transform scale.x retained after SetWidth changes an ancestor. */
  localScaleX?: number;
  /** Serialized ParticleSystemRenderer.m_Pivot.y in particle-diameter units. */
  rendererPivotY?: number;
  /** Explicit opt-in degradation hook; the default native profile never clips source emissions. */
  performanceMaxCount?: number;
  direction?: -1 | 1;
}

const nativeFlickHierarchyWidthScale = {
  widthScaleRange: [0.05, 3] as const,
  widthScaleMode: "hierarchy" as const,
};

const nativeSideFlickEmitterWidthScale = {
  widthScaleRange: [0.082, 1.5] as const,
  widthScaleMode: "motionPath" as const,
};

type NativeRendererName = "frame" | "pillar01" | "pillar02" | "pillar03" | "pillar04";

interface NativeEffectProjection {
  name: string;
  prefab: string;
  clip: string;
  judgmentClips?: Readonly<{ great: string; good: string; bad: string }>;
  systems: readonly NativeSystemProjection[];
  renderers: Readonly<Partial<Record<NativeRendererName, string>>>;
  loopPulses?: number;
}

// animationPath is the path relative to the prefab's `root` Animator. It is
// deliberately explicit so AnimationClip binding hashes can be matched to the
// exact ParticleSystem represented by each prepared JSON file. `ef_wall_center`
// is projected with the authored wall alpha mask and source timing; Sonolus has
// no equivalent 3D particle mesh, so its mesh silhouette remains the explicit
// compatibility boundary rather than being silently replaced by a block.
const nativeEffectProjections: readonly NativeEffectProjection[] = [
  {
    name: "Our Notes Native Normal",
    prefab: "note_normal.prefab",
    clip: "tap_perfect.anim",
    judgmentClips: { great: "tap_great.anim", good: "tap_good.anim", bad: "tap_bad.anim" },
    systems: [
      {
        file: "ParticleSystem_3.json",
        animationPath: "ef_splash/ef_particle_point",
        sprite: "star",
        y: -0.53,
        shapeWidthOffset: 0.08,
      },
      {
        file: "ParticleSystem_1.json",
        animationPath: "ef_splash/ef_particle_star",
        sprite: "star",
        y: -0.531,
        shapeWidthOffset: -0.02,
      },
      {
        file: "ParticleSystem.json",
        animationPath: "ef_splash/ef_wall_center",
        sprite: "wall",
        y: 0,
        z: 0.05,
      },
    ],
    renderers: {
      frame: "SpriteRenderer.json",
      pillar01: "SpriteRenderer_4.json",
      pillar02: "SpriteRenderer_1.json",
      pillar03: "SpriteRenderer_2.json",
      pillar04: "SpriteRenderer_3.json",
    },
  },
  {
    name: "Our Notes Native Slide",
    prefab: "note_slide.prefab",
    clip: "tap_slide_parfect.anim",
    judgmentClips: {
      great: "tap_slide_great.anim",
      good: "tap_slide_good.anim",
      bad: "tap_slide_bad.anim",
    },
    systems: [
      {
        file: "ParticleSystem_3.json",
        animationPath: "ef_splash/ef_particle_point",
        sprite: "star",
        y: -0.53,
        shapeWidthOffset: 0.08,
      },
      {
        file: "ParticleSystem.json",
        animationPath: "ef_splash/ef_particle_star",
        sprite: "star",
        y: -0.531,
        shapeWidthOffset: -0.02,
      },
      {
        file: "ParticleSystem_1.json",
        animationPath: "ef_splash/ef_wall_center",
        sprite: "wall",
        y: 0,
        z: 0.05,
      },
    ],
    renderers: {
      frame: "SpriteRenderer_1.json",
      pillar01: "SpriteRenderer_4.json",
      pillar02: "SpriteRenderer.json",
      pillar03: "SpriteRenderer_3.json",
      pillar04: "SpriteRenderer_2.json",
    },
  },
  {
    name: "Our Notes Native Flick",
    prefab: "note_flick.prefab",
    clip: "tap_flick_perfect.anim",
    judgmentClips: {
      great: "tap_flick_great.anim",
      good: "tap_flick_good.anim",
      bad: "tap_flick_bad.anim",
    },
    systems: [
      {
        file: "ParticleSystem_5.json",
        animationPath: "ef_splash/ef_particle_point",
        sprite: "star",
        y: -0.53,
        shapeWidthOffset: 0.08,
      },
      {
        file: "ParticleSystem_4.json",
        animationPath: "ef_splash/ef_particle_star",
        sprite: "star",
        y: -0.531,
        shapeWidthOffset: -0.02,
      },
      {
        file: "ParticleSystem_8.json",
        animationPath: "ef_splash_move/ef_particle_point01",
        sprite: "star",
        y: 0.71,
        ...nativeFlickHierarchyWidthScale,
      },
      {
        file: "ParticleSystem_2.json",
        animationPath: "ef_splash_move/ef_particle_point02",
        sprite: "star",
        y: 0.71,
        ...nativeFlickHierarchyWidthScale,
      },
      {
        file: "ParticleSystem_6.json",
        animationPath: "ef_splash_move/ef_particl_splash",
        sprite: "longStar",
        y: 1.8,
        z: -0.2,
        ...nativeFlickHierarchyWidthScale,
        localScaleX: 1.0199999809265137,
      },
      {
        file: "ParticleSystem_3.json",
        animationPath: "ef_splash_move/ef_particl_splash_line",
        sprite: "centerPillar",
        y: 0.15,
        z: -0.2,
        ...nativeFlickHierarchyWidthScale,
        // note_flick.prefab / ef_particl_splash_line: m_Pivot.y = .3.
        rendererPivotY: 0.30000001192092896,
      },
      {
        file: "ParticleSystem.json",
        animationPath: "ef_splash_move/ef_particl_splash_line02",
        sprite: "centerPillar02",
        y: -0.5,
        z: -0.2,
        ...nativeFlickHierarchyWidthScale,
        // note_flick.prefab / ef_particl_splash_line02: m_Pivot.y = .3.
        rendererPivotY: 0.30000001192092896,
      },
      {
        file: "ParticleSystem_7.json",
        animationPath: "ef_splash/ef_wall_center",
        sprite: "wall",
        y: 0,
        z: 0.05,
      },
    ],
    renderers: {
      frame: "SpriteRenderer_2.json",
      pillar01: "SpriteRenderer.json",
      pillar02: "SpriteRenderer_3.json",
      pillar03: "SpriteRenderer_1.json",
      pillar04: "SpriteRenderer_4.json",
    },
  },
  {
    name: "Our Notes Native Flick Left",
    prefab: "note_flick_left.prefab",
    clip: "tap_flick_perfect.anim",
    judgmentClips: {
      great: "tap_flick_great.anim",
      good: "tap_flick_good.anim",
      bad: "tap_flick_bad.anim",
    },
    systems: [
      {
        file: "ParticleSystem_2.json",
        animationPath: "ef_splash/ef_particle_point",
        sprite: "star",
        y: -0.53,
        shapeWidthOffset: 0.08,
      },
      {
        file: "ParticleSystem_6.json",
        animationPath: "ef_splash/ef_particle_star",
        sprite: "star",
        y: -0.531,
        shapeWidthOffset: -0.02,
      },
      {
        file: "ParticleSystem_1.json",
        animationPath: "ef_splash_move/ef_splash",
        motionPath: "ef_splash_move/ef_splash",
        motionPathScaleX: 0.6000000238418579,
        sprite: "longStar",
        y: 0,
        direction: -1,
        ...nativeSideFlickEmitterWidthScale,
      },
      {
        file: "ParticleSystem.json",
        animationPath: "ef_splash_move/ef_splash/ef_splash02",
        motionPath: "ef_splash_move/ef_splash",
        motionPathScaleX: 0.6000000238418579,
        sprite: "star",
        y: 0,
        direction: -1,
        ...nativeSideFlickEmitterWidthScale,
      },
      {
        file: "ParticleSystem_5.json",
        animationPath: "ef_splash/ef_wall_center",
        sprite: "wall",
        y: 0,
        z: 0.05,
      },
    ],
    renderers: {
      frame: "SpriteRenderer.json",
      pillar01: "SpriteRenderer_3.json",
      pillar02: "SpriteRenderer_4.json",
      pillar03: "SpriteRenderer_1.json",
      pillar04: "SpriteRenderer_2.json",
    },
  },
  {
    name: "Our Notes Native Flick Right",
    prefab: "note_flick_right.prefab",
    clip: "tap_flick_perfect.anim",
    judgmentClips: {
      great: "tap_flick_great.anim",
      good: "tap_flick_good.anim",
      bad: "tap_flick_bad.anim",
    },
    systems: [
      {
        file: "ParticleSystem_5.json",
        animationPath: "ef_splash/ef_particle_point",
        sprite: "star",
        y: -0.53,
        shapeWidthOffset: 0.08,
      },
      {
        file: "ParticleSystem_2.json",
        animationPath: "ef_splash/ef_particle_star",
        sprite: "star",
        y: -0.531,
        shapeWidthOffset: -0.02,
      },
      {
        file: "ParticleSystem_6.json",
        animationPath: "ef_splash_move/ef_splash",
        motionPath: "ef_splash_move/ef_splash",
        motionPathScaleX: 0.6000000238418579,
        sprite: "longStar",
        y: 0,
        direction: 1,
        ...nativeSideFlickEmitterWidthScale,
      },
      {
        file: "ParticleSystem_4.json",
        animationPath: "ef_splash_move/ef_splash/ef_splash02",
        motionPath: "ef_splash_move/ef_splash",
        motionPathScaleX: 0.6000000238418579,
        sprite: "star",
        y: 0,
        direction: 1,
        ...nativeSideFlickEmitterWidthScale,
      },
      {
        file: "ParticleSystem_3.json",
        animationPath: "ef_splash/ef_wall_center",
        sprite: "wall",
        y: 0,
        z: 0.05,
      },
    ],
    renderers: {
      frame: "SpriteRenderer_1.json",
      pillar01: "SpriteRenderer_2.json",
      pillar02: "SpriteRenderer.json",
      pillar03: "SpriteRenderer_3.json",
      pillar04: "SpriteRenderer_4.json",
    },
  },
  {
    name: "Our Notes Native Slide Loop",
    prefab: "note_slide_loop.prefab",
    clip: "tap_slide_loop.anim",
    systems: [
      {
        file: "ParticleSystem_1.json",
        animationPath: "ef_slide_loop/ef_particle_point",
        sprite: "star",
        y: -0.531,
        shapeWidthOffset: 0.08,
      },
      {
        file: "ParticleSystem.json",
        animationPath: "ef_slide_loop/ef_particle_point_frame",
        sprite: "star",
        y: -0.531,
        shapeWidthOffset: 0.08,
      },
    ],
    renderers: {
      frame: "SpriteRenderer_1.json",
      pillar01: "SpriteRenderer_3.json",
      pillar02: "SpriteRenderer_2.json",
      pillar03: "SpriteRenderer_4.json",
      pillar04: "SpriteRenderer.json",
    },
    loopPulses: 10,
  },
  {
    name: "Our Notes Native Connect",
    prefab: "note_slide_connect.prefab",
    clip: "tap_slide_parfect.anim",
    judgmentClips: {
      great: "tap_slide_great.anim",
      good: "tap_slide_good.anim",
      bad: "tap_slide_bad.anim",
    },
    systems: [
      {
        file: "ParticleSystem_1.json",
        animationPath: "ef_splash/ef_particle_point",
        sprite: "star",
        y: -0.53,
        shapeWidthOffset: 0.08,
      },
      {
        file: "ParticleSystem_2.json",
        animationPath: "ef_splash/ef_particle_star",
        sprite: "star",
        y: -0.531,
        shapeWidthOffset: -0.02,
      },
      {
        file: "ParticleSystem.json",
        animationPath: "ef_splash",
        sprite: "star",
        y: 0,
      },
    ],
    renderers: { frame: "SpriteRenderer.json" },
  },
];

const nativeAnimationTypeIds = {
  gameObject: 1,
  transform: 4,
  particleSystem: 198,
  spriteRenderer: 212,
} as const;

const nativeAnimationAttributes = {
  active: crc32(Buffer.from("m_IsActive", "utf8")),
  transformPosition: 1,
  spriteColor: {
    r: crc32(Buffer.from("m_Color.r", "utf8")),
    g: crc32(Buffer.from("m_Color.g", "utf8")),
    b: crc32(Buffer.from("m_Color.b", "utf8")),
    a: crc32(Buffer.from("m_Color.a", "utf8")),
  },
  sizeX: crc32(Buffer.from("m_Size.x", "utf8")),
  simulationSpeed: crc32(Buffer.from("simulationSpeed", "utf8")),
  rateOverDistance: crc32(Buffer.from("EmissionModule.rateOverDistance.scalar", "utf8")),
  particleMaxColor: {
    r: crc32(Buffer.from("InitialModule.startColor.maxColor.r", "utf8")),
    g: crc32(Buffer.from("InitialModule.startColor.maxColor.g", "utf8")),
    b: crc32(Buffer.from("InitialModule.startColor.maxColor.b", "utf8")),
    a: crc32(Buffer.from("InitialModule.startColor.maxColor.a", "utf8")),
  },
} as const;

type NativeColorAttributes = Readonly<Record<"r" | "g" | "b" | "a", number>>;

function nativeAnimatedColor(
  base: JsonObject,
  clip: NativeAnimationClip,
  typeId: number,
  pathHash: number,
  attributes: NativeColorAttributes,
  time: number,
): JsonObject {
  const component = (name: keyof NativeColorAttributes): number =>
    nativeClipValue(clip, typeId, pathHash, attributes[name], time) ??
    requireFiniteNumber(base[name], `animated color.${name}`);
  return { r: component("r"), g: component("g"), b: component("b"), a: component("a") };
}

interface NativeSpriteRendererProjection {
  name: NativeRendererName;
  color: JsonObject;
  size: { x: number; y: number };
}

function readNativeSpriteRenderer(
  projection: NativeEffectProjection,
  name: NativeRendererName,
  filename: string,
): NativeSpriteRendererProjection {
  const file = resolve(nativeEffectRoot, projection.prefab, filename);
  const data = unityObjectData(file, "SpriteRenderer");
  const color = requireJsonObject(data.m_Color, `${file}.data.m_Color`);
  const size = requireJsonObject(data.m_Size, `${file}.data.m_Size`);
  return {
    name,
    color,
    size: {
      x: requireFiniteNumber(size.x, `${file}.data.m_Size.x`),
      y: requireFiniteNumber(size.y, `${file}.data.m_Size.y`),
    },
  };
}

function animatedRendererLayout(
  effect: NativeEffectProjection,
  renderer: NativeSpriteRendererProjection,
  sizeX: number,
): { x: number; y: number; w: number; h: number } {
  if (renderer.name === "frame") {
    // SetWidth replaces m_Size.x with the active physical note width plus
    // .4; it does not retain the prefab's serialized 5.5-unit width.  The
    // one-lane reference makes the static particle faithful for ordinary
    // notes, while the engine still scales it with each chart note's width.
    const rect = nativeEffectGroundRect(0, renderer.size.y);
    return {
      x: 0,
      y: rect.y,
      w:
        (nativeEffectReferenceWidth + nativeEffectFrameWidthPadding) *
        nativeEffectFrameScaleX *
        nativeEffectCoordinateScale.x,
      h: rect.h,
    };
  }

  const left = renderer.name === "pillar01" || renderer.name === "pillar03";
  const front = renderer.name === "pillar01" || renderer.name === "pillar02";
  const z = front ? 0.64 : effect.prefab === "note_normal.prefab" ? -0.61 : -0.54;
  const rect = nativeEffectVerticalRect(-0.06, z, renderer.size.y, nativeEffectPillarPivotY);
  // ef_tap_pillar's normalized pivot is near its lower edge.  Keep that
  // authored anchor on the judgement line instead of centring the glow.
  return {
    x: left ? -1 : 1,
    y: rect.y,
    w: Math.max(0, sizeX) * nativeEffectCoordinateScale.x,
    h: rect.h,
  };
}

function makeAnimatedRendererGroups(projection: NativeEffectProjection, clip: NativeAnimationClip): JsonValue[] {
  const renderers = Object.entries(projection.renderers).map(([name, filename]) =>
    readNativeSpriteRenderer(projection, name as NativeRendererName, filename),
  );
  const groups: JsonValue[] = [];
  const loopPulses = projection.loopPulses;
  const sourceTimeAt = (progress: number, atSegmentEnd = false): number => {
    if (!loopPulses) return progress * clip.duration;
    const scaled = progress * loopPulses;
    const pulseProgress = scaled % 1;
    if (atSegmentEnd && progress > 0 && Math.abs(pulseProgress) <= Number.EPSILON * 16) {
      return clip.duration;
    }
    return pulseProgress * clip.duration;
  };
  const finiteFrameTimes = clip.frames
    .map(({ time }) => time)
    .filter((time) => Number.isFinite(time) && time >= 0 && time <= clip.duration);
  const boundaries = loopPulses
    ? Array.from({ length: loopPulses }, (_, pulse) => [
        pulse / loopPulses,
        (pulse + 0.5) / loopPulses,
        (pulse + 1) / loopPulses,
        ...finiteFrameTimes.map((time) => (pulse + time / clip.duration) / loopPulses),
      ]).flat()
    : [
        ...Array.from({ length: 11 }, (_, index) => index / 10),
        ...finiteFrameTimes.map((time) => time / clip.duration),
      ];
  const segmentBoundaries = [...new Set(boundaries.map((time) => clamp(time, 0, 1)))]
    .sort((left, right) => left - right)
    .filter((time, index, values) => index === 0 || time - values[index - 1]! > Number.EPSILON);

  for (let segment = 0; segment < segmentBoundaries.length - 1; segment++) {
    const start = segmentBoundaries[segment];
    const end = segmentBoundaries[segment + 1];
    if (start === undefined || end === undefined || end <= start) continue;
    // At the final point of a pulse sample the clip end, not the next pulse's
    // first key. This retains the native loop envelope at every pulse.
    const sourceStart = sourceTimeAt(start);
    const sourceEnd = sourceTimeAt(end, true);

    for (const renderer of renderers) {
      const pathHash = crc32(Buffer.from(renderer.name, "utf8"));
      const baseAlpha = requireFiniteNumber(renderer.color.a, `${projection.name}.${renderer.name}.color.a`);
      const alphaStart =
        nativeClipValue(
          clip,
          nativeAnimationTypeIds.spriteRenderer,
          pathHash,
          nativeAnimationAttributes.spriteColor.a,
          sourceStart,
        ) ?? baseAlpha;
      const alphaEnd =
        nativeClipValue(
          clip,
          nativeAnimationTypeIds.spriteRenderer,
          pathHash,
          nativeAnimationAttributes.spriteColor.a,
          sourceEnd,
        ) ?? baseAlpha;
      const activeStart =
        nativeClipValue(
          clip,
          nativeAnimationTypeIds.gameObject,
          pathHash,
          nativeAnimationAttributes.active,
          sourceStart,
        ) ?? 1;
      const activeEnd =
        nativeClipValue(
          clip,
          nativeAnimationTypeIds.gameObject,
          pathHash,
          nativeAnimationAttributes.active,
          sourceEnd,
        ) ?? 1;
      const sizeStart =
        nativeClipValue(
          clip,
          nativeAnimationTypeIds.spriteRenderer,
          pathHash,
          nativeAnimationAttributes.sizeX,
          sourceStart,
        ) ?? renderer.size.x;
      const sizeEnd =
        nativeClipValue(
          clip,
          nativeAnimationTypeIds.spriteRenderer,
          pathHash,
          nativeAnimationAttributes.sizeX,
          sourceEnd,
        ) ?? renderer.size.x;
      const alphaFrom = clamp(alphaStart * (activeStart > 0.5 ? 1 : 0), 0, 1);
      const alphaTo = clamp(alphaEnd * (activeEnd > 0.5 ? 1 : 0), 0, 1);
      if (alphaFrom <= 0 && alphaTo <= 0) continue;

      const from = animatedRendererLayout(projection, renderer, sizeStart);
      const to = animatedRendererLayout(projection, renderer, sizeEnd);
      // Sonolus particle RGB is fixed per particle. Each already-discrete
      // AnimationClip segment therefore samples the authored SpriteRenderer
      // RGB at its midpoint; alpha and size retain their endpoint curves.
      const animatedColor = nativeAnimatedColor(
        renderer.color,
        clip,
        nativeAnimationTypeIds.spriteRenderer,
        pathHash,
        nativeAnimationAttributes.spriteColor,
        sourceTimeAt((start + end) / 2),
      );
      groups.push({
        count: 1,
        particles: [
          {
            sprite: renderer.name === "frame" ? nativeParticleSpriteIndices.line : nativeParticleSpriteIndices.pillar,
            color: colorHex(animatedColor, `${projection.name}.${renderer.name}.animatedColor`),
            start,
            duration: end - start,
            x: particleProperty(particleCurve(from.x), particleCurve(to.x), "linear"),
            y: particleProperty(particleCurve(from.y), particleCurve(to.y), "linear"),
            w: particleProperty(particleCurve(from.w), particleCurve(to.w), "linear"),
            h: particleProperty(particleCurve(from.h), particleCurve(to.h), "linear"),
            r: particleProperty(particleCurve(0), particleCurve(0), "linear"),
            a: particleProperty(particleCurve(alphaFrom), particleCurve(alphaTo), "linear"),
          },
        ],
      });
    }
  }
  return groups;
}

interface NativeActiveWindow {
  start: number;
  end: number;
}

function nativeSourceTimeAt(
  effect: NativeEffectProjection,
  clip: NativeAnimationClip,
  effectDuration: number,
  effectTime: number,
): number {
  if (!effect.loopPulses) return clamp(effectTime, 0, clip.duration);
  const pulseDuration = effectDuration / effect.loopPulses;
  const pulseTime = ((effectTime % pulseDuration) + pulseDuration) % pulseDuration;
  return (pulseTime / pulseDuration) * clip.duration;
}

function nativeAnimationHierarchy(path: string): string[] {
  const parts = path.split("/").filter(Boolean);
  return parts.map((_, index) => parts.slice(0, index + 1).join("/"));
}

function nativeSystemActiveAt(
  effect: NativeEffectProjection,
  clip: NativeAnimationClip,
  projection: NativeSystemProjection,
  effectDuration: number,
  effectTime: number,
): boolean {
  const sourceTime = nativeSourceTimeAt(effect, clip, effectDuration, effectTime);
  return nativeAnimationHierarchy(projection.animationPath).every((path) => {
    const active = nativeClipValue(
      clip,
      nativeAnimationTypeIds.gameObject,
      crc32(Buffer.from(path, "utf8")),
      nativeAnimationAttributes.active,
      sourceTime,
    );
    return active === undefined || active > 0.5;
  });
}

function nativeSystemActiveWindows(
  effect: NativeEffectProjection,
  clip: NativeAnimationClip,
  projection: NativeSystemProjection,
  effectDuration: number,
): NativeActiveWindow[] {
  const sourceFrameTimes = clip.frames
    .map(({ time }) => time)
    .filter((time) => Number.isFinite(time) && time >= 0 && time <= clip.duration);
  const boundaries = [0, effectDuration];
  if (effect.loopPulses) {
    const pulseDuration = effectDuration / effect.loopPulses;
    for (let pulse = 0; pulse < effect.loopPulses; pulse++) {
      const pulseStart = pulse * pulseDuration;
      boundaries.push(pulseStart, pulseStart + pulseDuration);
      for (const time of sourceFrameTimes) boundaries.push(pulseStart + (time / clip.duration) * pulseDuration);
    }
  } else {
    for (const time of sourceFrameTimes) boundaries.push((time / clip.duration) * effectDuration);
  }

  const times = [...new Set(boundaries.map((time) => clamp(time, 0, effectDuration)))]
    .sort((left, right) => left - right)
    .filter((time, index, values) => index === 0 || time - values[index - 1]! > Number.EPSILON);
  const windows: NativeActiveWindow[] = [];
  for (let index = 0; index < times.length - 1; index++) {
    const start = times[index];
    const end = times[index + 1];
    if (start === undefined || end === undefined || end <= start) continue;
    if (!nativeSystemActiveAt(effect, clip, projection, effectDuration, (start + end) / 2)) continue;
    const previous = windows.at(-1);
    if (previous && Math.abs(previous.end - start) <= Number.EPSILON) previous.end = end;
    else windows.push({ start, end });
  }
  return windows;
}

function nativeSystemClipValue(
  effect: NativeEffectProjection,
  clip: NativeAnimationClip,
  projection: NativeSystemProjection,
  effectDuration: number,
  effectTime: number,
  attribute: number,
): number | undefined {
  return nativeClipValue(
    clip,
    nativeAnimationTypeIds.particleSystem,
    crc32(Buffer.from(projection.animationPath, "utf8")),
    attribute,
    nativeSourceTimeAt(effect, clip, effectDuration, effectTime),
  );
}

function nativeSystemAverageValue(
  effect: NativeEffectProjection,
  clip: NativeAnimationClip,
  projection: NativeSystemProjection,
  effectDuration: number,
  window: NativeActiveWindow,
  attribute: number,
  fallback: number,
): number {
  const samples = 32;
  let sum = 0;
  for (let index = 0; index < samples; index++) {
    const time = window.start + ((index + 0.5) / samples) * (window.end - window.start);
    sum += nativeSystemClipValue(effect, clip, projection, effectDuration, time, attribute) ?? fallback;
  }
  return sum / samples;
}

interface NativeDirectionalMotion {
  /** The effect-relative time at which its animated X position stops changing. */
  end: number;
  /** Source-world X after the animated parent hierarchy's local X scale. */
  positionAt(effectTime: number): number;
  /** Source-world path length inside an effect-time interval. */
  distanceBetween(start: number, end: number): number;
}

function nativeDirectionalMotion(
  effect: NativeEffectProjection,
  clip: NativeAnimationClip,
  projection: NativeSystemProjection,
  effectDuration: number,
): NativeDirectionalMotion | undefined {
  const path = projection.motionPath;
  // The directional prefabs use a one-shot world-space emitter. A looping
  // projection would need a separate path per pulse, so fail closed instead
  // of inventing a repeated horizontal trajectory.
  if (!projection.direction || !path || effect.loopPulses || clip.duration <= 0) return undefined;
  const pathHash = crc32(Buffer.from(path, "utf8"));
  const xAtSourceTime = (sourceTime: number): number | undefined =>
    nativeClipValue(
      clip,
      nativeAnimationTypeIds.transform,
      pathHash,
      nativeAnimationAttributes.transformPosition,
      sourceTime,
      0,
    );
  const startX = xAtSourceTime(0);
  const endX = xAtSourceTime(clip.duration);
  if (startX === undefined || endX === undefined || Math.abs(endX - startX) <= 1e-5) return undefined;
  // The decoded prefab hierarchy puts ef_splash under ef_splash_move, whose
  // authored local X scale is .6000000238418579 for both side-flick prefabs.
  // Their TransformScaleXSetRangeParam replaces that value at runtime rather
  // than multiplying it, so use the range result for both the emitter path
  // and rate-over-distance's world-space distance.
  const hierarchyScaleX =
    projection.widthScaleMode === "motionPath" && projection.widthScaleRange
      ? nativeEffectWidthRangeScale(projection.widthScaleRange)
      : (projection.motionPathScaleX ?? 1);

  const sourceTimes = [...new Set([0, clip.duration, ...clip.frames.map(({ time }) => time)])]
    .filter((time) => Number.isFinite(time) && time >= 0 && time <= clip.duration)
    .sort((left, right) => left - right);
  let stopSourceTime = clip.duration;
  for (let index = 0; index < sourceTimes.length - 1; index++) {
    const sourceTime = sourceTimes[index]!;
    const currentX = xAtSourceTime(sourceTime);
    if (currentX !== undefined && Math.abs(currentX - endX) > 1e-5) {
      stopSourceTime = sourceTimes[index + 1]!;
    }
  }

  const motionEnd = (stopSourceTime / clip.duration) * effectDuration;
  const positionAt = (effectTime: number): number => {
    const sourceTime = nativeSourceTimeAt(effect, clip, effectDuration, clamp(effectTime, 0, motionEnd));
    return (xAtSourceTime(sourceTime) ?? endX) * hierarchyScaleX;
  };
  return {
    end: motionEnd,
    positionAt,
    distanceBetween(start: number, end: number): number {
      const intervalStart = clamp(Math.min(start, end), 0, motionEnd);
      const intervalEnd = clamp(Math.max(start, end), 0, motionEnd);
      if (intervalEnd <= intervalStart) return 0;
      const steps = Math.max(1, Math.ceil((intervalEnd - intervalStart) * 60));
      let previous = positionAt(intervalStart);
      let distance = 0;
      for (let index = 1; index <= steps; index++) {
        const current = positionAt(intervalStart + ((intervalEnd - intervalStart) * index) / steps);
        distance += Math.abs(current - previous);
        previous = current;
      }
      return distance;
    },
  };
}

function projectedEmissionCount(
  data: JsonObject,
  activeDuration: number,
  simulationSpeed: number,
  rateOverDistance: number,
  motionDistance: number,
  projection: NativeSystemProjection,
  path: string,
): number {
  const emission = requireJsonObject(data.EmissionModule, `${path}.EmissionModule`);
  if (emission.enabled === false) return 0;
  const length = Math.max(0, requireFiniteNumber(data.lengthInSec, `${path}.lengthInSec`));
  const looping = data.looping === true;
  const simulatedDuration = looping
    ? activeDuration * simulationSpeed
    : Math.min(length, activeDuration * simulationSpeed);
  let count = 0;
  // Match the chart renderer's native 60 Hz rate accumulator. In particular,
  // rate-over-time and rate-over-distance are additive modules, not mutually
  // exclusive alternatives.
  let rateAccumulator = 0;
  for (let start = 0; start < simulatedDuration; start += 1 / 60) {
    const step = Math.min(1 / 60, simulatedDuration - start);
    const simulationTime = start + step / 2;
    const cycleTime = length > 0 ? simulationTime % length : simulationTime;
    const normalized = length > 0 ? cycleTime / length : 0;
    rateAccumulator +=
      evaluateMinMaxCurve(emission.rateOverTime, normalized, `${path}.EmissionModule.rateOverTime`) * step;
    while (rateAccumulator >= 1) {
      count += 1;
      rateAccumulator -= 1;
    }
  }

  const bursts = emission.m_Bursts;
  if (!Array.isArray(bursts)) throw new Error(`${path}.EmissionModule.m_Bursts must be an array`);
  const cycleCount = looping && length > 0 ? Math.floor(simulatedDuration / length) + 1 : 1;
  for (let cycle = 0; cycle < cycleCount; cycle++) {
    const cycleStart = cycle * length;
    for (const [index, value] of bursts.entries()) {
      const burst = requireJsonObject(value, `${path}.EmissionModule.m_Bursts[${index}]`);
      const repeatCount = Math.max(
        1,
        Math.round(requireFiniteNumber(burst.cycleCount, `${path}.EmissionModule.m_Bursts[${index}].cycleCount`)),
      );
      const repeatInterval = requireFiniteNumber(
        burst.repeatInterval,
        `${path}.EmissionModule.m_Bursts[${index}].repeatInterval`,
      );
      for (let repeat = 0; repeat < repeatCount; repeat++) {
        const burstTime =
          cycleStart +
          requireFiniteNumber(burst.time, `${path}.EmissionModule.m_Bursts[${index}].time`) +
          repeat * repeatInterval;
        if (burstTime > simulatedDuration) continue;
        count += Math.max(
          0,
          Math.round(evaluateMinMaxCurve(burst.countCurve, 0, `${path}.EmissionModule.m_Bursts[${index}].countCurve`)),
        );
      }
    }
  }

  count += Math.max(0, rateOverDistance) * Math.max(0, motionDistance);
  const initial = requireJsonObject(data.InitialModule, `${path}.InitialModule`);
  const maxParticles = Math.max(
    0,
    Math.round(requireFiniteNumber(initial.maxNumParticles, `${path}.InitialModule.maxNumParticles`)),
  );
  const sourceCount = Math.min(maxParticles, Math.max(0, Math.round(count)));
  return projection.performanceMaxCount === undefined
    ? sourceCount
    : Math.min(sourceCount, Math.max(0, Math.round(projection.performanceMaxCount)));
}

function nativeStartColor(initial: JsonObject, path: string): JsonObject {
  const gradient = requireJsonObject(initial.startColor, `${path}.InitialModule.startColor`);
  return requireJsonObject(gradient.maxColor, `${path}.InitialModule.startColor.maxColor`);
}

function nativeParticleStartColor(
  effect: NativeEffectProjection,
  clip: NativeAnimationClip,
  projection: NativeSystemProjection,
  effectDuration: number,
  effectTime: number,
  initial: JsonObject,
  path: string,
): JsonObject {
  return nativeAnimatedColor(
    nativeStartColor(initial, path),
    clip,
    nativeAnimationTypeIds.particleSystem,
    crc32(Buffer.from(projection.animationPath, "utf8")),
    nativeAnimationAttributes.particleMaxColor,
    nativeSourceTimeAt(effect, clip, effectDuration, effectTime),
  );
}

function nativeColor(value: JsonValue | undefined, path: string): JsonObject {
  const color = requireJsonObject(value, path);
  return {
    r: requireFiniteNumber(color.r, `${path}.r`),
    g: requireFiniteNumber(color.g, `${path}.g`),
    b: requireFiniteNumber(color.b, `${path}.b`),
    a: requireFiniteNumber(color.a, `${path}.a`),
  };
}

function multiplyNativeColors(left: JsonObject, right: JsonObject, path: string): JsonObject {
  return {
    r: requireFiniteNumber(left.r, `${path}.left.r`) * requireFiniteNumber(right.r, `${path}.right.r`),
    g: requireFiniteNumber(left.g, `${path}.left.g`) * requireFiniteNumber(right.g, `${path}.right.g`),
    b: requireFiniteNumber(left.b, `${path}.left.b`) * requireFiniteNumber(right.b, `${path}.right.b`),
    a: requireFiniteNumber(left.a, `${path}.left.a`) * requireFiniteNumber(right.a, `${path}.right.a`),
  };
}

function nativeGradientChannel(
  gradient: JsonObject,
  normalizedTime: number,
  component: "r" | "g" | "b" | "a",
  alphaTiming: boolean,
  path: string,
): number {
  const countName = alphaTiming ? "m_NumAlphaKeys" : "m_NumColorKeys";
  const count = Math.max(0, Math.min(8, Math.round(requireFiniteNumber(gradient[countName], `${path}.${countName}`))));
  if (count === 0) return 1;
  const timeName = alphaTiming ? "atime" : "ctime";
  const point = clamp(normalizedTime, 0, 1);
  let leftTime = requireFiniteNumber(gradient[`${timeName}0`], `${path}.${timeName}0`) / 65535;
  let leftColor = nativeColor(gradient.key0, `${path}.key0`);
  if (point <= leftTime) return requireFiniteNumber(leftColor[component], `${path}.key0.${component}`);
  for (let index = 1; index < count; index++) {
    const rightTime = requireFiniteNumber(gradient[`${timeName}${index}`], `${path}.${timeName}${index}`) / 65535;
    const rightColor = nativeColor(gradient[`key${index}`], `${path}.key${index}`);
    if (point <= rightTime) {
      const stepped = Math.round(requireFiniteNumber(gradient.m_Mode, `${path}.m_Mode`)) === 1;
      const progress = stepped ? 0 : (point - leftTime) / Math.max(Number.EPSILON, rightTime - leftTime);
      return (
        requireFiniteNumber(leftColor[component], `${path}.key${index - 1}.${component}`) * (1 - progress) +
        requireFiniteNumber(rightColor[component], `${path}.key${index}.${component}`) * progress
      );
    }
    leftTime = rightTime;
    leftColor = rightColor;
  }
  return requireFiniteNumber(leftColor[component], `${path}.last.${component}`);
}

function nativeGradientColor(gradient: JsonObject, normalizedTime: number, path: string): JsonObject {
  return {
    r: nativeGradientChannel(gradient, normalizedTime, "r", false, path),
    g: nativeGradientChannel(gradient, normalizedTime, "g", false, path),
    b: nativeGradientChannel(gradient, normalizedTime, "b", false, path),
    a: nativeGradientChannel(gradient, normalizedTime, "a", true, path),
  };
}

function averageNativeColors(left: JsonObject, right: JsonObject, path: string): JsonObject {
  return {
    r: (requireFiniteNumber(left.r, `${path}.left.r`) + requireFiniteNumber(right.r, `${path}.right.r`)) / 2,
    g: (requireFiniteNumber(left.g, `${path}.left.g`) + requireFiniteNumber(right.g, `${path}.right.g`)) / 2,
    b: (requireFiniteNumber(left.b, `${path}.left.b`) + requireFiniteNumber(right.b, `${path}.right.b`)) / 2,
    a: (requireFiniteNumber(left.a, `${path}.left.a`) + requireFiniteNumber(right.a, `${path}.right.a`)) / 2,
  };
}

function nativeMinMaxGradient(value: JsonValue | undefined, normalizedTime: number, path: string): JsonObject {
  const gradient = requireJsonObject(value, path);
  const state = Math.round(requireFiniteNumber(gradient.minMaxState, `${path}.minMaxState`));
  if (state === 0) return nativeColor(gradient.maxColor, `${path}.maxColor`);
  if (state === 1)
    return nativeGradientColor(
      requireJsonObject(gradient.maxGradient, `${path}.maxGradient`),
      normalizedTime,
      `${path}.maxGradient`,
    );
  if (state === 2)
    return averageNativeColors(
      nativeColor(gradient.minColor, `${path}.minColor`),
      nativeColor(gradient.maxColor, `${path}.maxColor`),
      path,
    );
  if (state === 3)
    return averageNativeColors(
      nativeGradientColor(
        requireJsonObject(gradient.minGradient, `${path}.minGradient`),
        normalizedTime,
        `${path}.minGradient`,
      ),
      nativeGradientColor(
        requireJsonObject(gradient.maxGradient, `${path}.maxGradient`),
        normalizedTime,
        `${path}.maxGradient`,
      ),
      path,
    );
  // RandomColor picks a stable gradient position per particle. Sonolus group
  // particles carry their own randomized geometry but no per-particle RGB, so
  // use the source gradient midpoint rather than replacing it with white.
  if (state === 4)
    return nativeGradientColor(
      requireJsonObject(gradient.maxGradient, `${path}.maxGradient`),
      0.5,
      `${path}.maxGradient`,
    );
  throw new Error(`${path}.minMaxState has unsupported value ${state}`);
}

function nativeColorOverLifetime(data: JsonObject, normalizedTime: number, path: string): JsonObject {
  const colorModule = requireJsonObject(data.ColorModule, `${path}.ColorModule`);
  if (colorModule.enabled !== true) return { r: 1, g: 1, b: 1, a: 1 };
  return nativeMinMaxGradient(colorModule.gradient, normalizedTime, `${path}.ColorModule.gradient`);
}

function nativeSizeAxisScale(sizeModule: JsonObject, axis: "x" | "y", normalizedTime: number, path: string): number {
  if (sizeModule.enabled !== true) return 1;
  const curve =
    axis === "x" || sizeModule.separateAxes !== true ? sizeModule.curve : (sizeModule[axis] ?? sizeModule.curve);
  return Math.max(0, evaluateMinMaxCurve(curve, normalizedTime, `${path}.SizeModule.${axis}`));
}

function integratedVelocityAxis(
  data: JsonObject,
  axis: "x" | "y",
  particleAge: number,
  lifetime: number,
  path: string,
): number {
  const velocity = requireJsonObject(data.VelocityModule, `${path}.VelocityModule`);
  if (velocity.enabled !== true || particleAge <= 0 || lifetime <= 0) return 0;
  const steps = Math.max(1, Math.ceil(particleAge * 16));
  const step = particleAge / steps;
  let distance = 0;
  for (let index = 0; index < steps; index++) {
    const normalized = clamp(((index + 0.5) * step) / lifetime, 0, 1);
    const speedModifier = velocity.speedModifier
      ? evaluateMinMaxCurve(velocity.speedModifier, normalized, `${path}.VelocityModule.speedModifier`)
      : 1;
    distance +=
      evaluateMinMaxCurve(velocity[axis], normalized, `${path}.VelocityModule.${axis}`) * speedModifier * step;
  }
  return distance;
}

function integratedVerticalVelocity(data: JsonObject, particleAge: number, lifetime: number, path: string): number {
  return integratedVelocityAxis(data, "y", particleAge, lifetime, path);
}

function gradientBoundaryTimes(gradient: JsonObject, path: string): number[] {
  const result: number[] = [];
  for (const [countName, timeName] of [
    ["m_NumColorKeys", "ctime"],
    ["m_NumAlphaKeys", "atime"],
  ] as const) {
    const count = Math.max(
      0,
      Math.min(8, Math.round(requireFiniteNumber(gradient[countName], `${path}.${countName}`))),
    );
    for (let index = 0; index < count; index++) {
      result.push(
        clamp(requireFiniteNumber(gradient[`${timeName}${index}`], `${path}.${timeName}${index}`) / 65535, 0, 1),
      );
    }
  }
  return result;
}

function nativeLifetimeBoundaries(data: JsonObject, path: string): number[] {
  // Sonolus has fixed RGB per particle. Split each source particle at every
  // authored ColorModule key and interleave twelve source-curve samples so
  // SizeModule's separate X/Y pulse survives without inventing a new glow.
  const boundaries = Array.from({ length: 13 }, (_, index) => index / 12);
  const colorModule = requireJsonObject(data.ColorModule, `${path}.ColorModule`);
  if (colorModule.enabled === true) {
    const gradient = requireJsonObject(colorModule.gradient, `${path}.ColorModule.gradient`);
    const state = Math.round(requireFiniteNumber(gradient.minMaxState, `${path}.ColorModule.gradient.minMaxState`));
    if (state === 1 || state === 3 || state === 4) {
      boundaries.push(
        ...gradientBoundaryTimes(
          requireJsonObject(gradient.maxGradient, `${path}.ColorModule.gradient.maxGradient`),
          `${path}.ColorModule.gradient.maxGradient`,
        ),
      );
    }
    if (state === 3) {
      boundaries.push(
        ...gradientBoundaryTimes(
          requireJsonObject(gradient.minGradient, `${path}.ColorModule.gradient.minGradient`),
          `${path}.ColorModule.gradient.minGradient`,
        ),
      );
    }
  }
  return [...new Set(boundaries.map((time) => clamp(time, 0, 1)).map((time) => time.toFixed(8)))]
    .map((time) => Number(time))
    .sort((left, right) => left - right);
}

interface NativeEffectCoordinateMap {
  xPerUnity: number;
}

function nativeEffectCoordinateMap(): NativeEffectCoordinateMap {
  // Source particle positions are relative to the same effect root as the
  // SpriteRenderers.  Do not derive this from the serialized frame footprint:
  // SetWidth overwrites that footprint at runtime, and doing so used to shrink
  // every system by roughly sevenfold.
  return {
    xPerUnity: nativeEffectCoordinateScale.x,
  };
}

function makeParticleSystemGroups(
  effect: NativeEffectProjection,
  clip: NativeAnimationClip,
  projection: NativeSystemProjection,
  effectDuration: number,
): JsonValue[] {
  const file = resolve(nativeEffectRoot, effect.prefab, projection.file);
  const data = unityObjectData(file, "ParticleSystem");
  const initial = requireJsonObject(data.InitialModule, `${file}.data.InitialModule`);
  if (initial.enabled !== true) throw new Error(`${file} InitialModule must be enabled`);
  const windows = nativeSystemActiveWindows(effect, clip, projection, effectDuration);
  if (!windows.length) return [];

  const coordinates = nativeEffectCoordinateMap();
  const [sizeMin, sizeMax] = minMaxScalarRange(initial.startSize, `${file}.data.InitialModule.startSize`);
  const baseSize = (sizeMin + sizeMax) / 2;
  const sizeRandom = (sizeMax - sizeMin) / 2;
  const baseSimulationSpeed = Math.max(
    Number.EPSILON,
    requireFiniteNumber(data.simulationSpeed, `${file}.data.simulationSpeed`),
  );
  const emission = requireJsonObject(data.EmissionModule, `${file}.data.EmissionModule`);
  const baseRateOverDistance = evaluateMinMaxCurve(
    emission.rateOverDistance,
    0.5,
    `${file}.data.EmissionModule.rateOverDistance`,
  );
  const lifetime = evaluateMinMaxCurve(initial.startLifetime, 0.5, `${file}.data.InitialModule.startLifetime`);
  const sizeModule = requireJsonObject(data.SizeModule, `${file}.data.SizeModule`);
  const lifetimeBoundaries = nativeLifetimeBoundaries(data, file);
  const shape = requireJsonObject(data.ShapeModule, `${file}.data.ShapeModule`);
  const shapeScale = requireJsonObject(shape.m_Scale, `${file}.data.ShapeModule.m_Scale`);
  const rawShapeWidth =
    shape.enabled === true ? Math.abs(requireFiniteNumber(shapeScale.x, `${file}.ShapeModule.m_Scale.x`)) : 0;
  // The point/star systems are included in SetWidth's shape-width list.  At
  // runtime their serialized 4/5-unit ShapeModule values are overwritten by
  // the active note width plus their asset-specific offset.
  const shapeWidth =
    shape.enabled !== true
      ? 0
      : projection.shapeWidthOffset === undefined
        ? rawShapeWidth
        : Math.max(0, nativeEffectReferenceWidth + projection.shapeWidthOffset);
  const widthRangeScale = projection.widthScaleRange ? nativeEffectWidthRangeScale(projection.widthScaleRange) : 1;
  const hierarchyWidthScale = projection.widthScaleMode === "hierarchy" ? widthRangeScale : 1;
  const particleXScale = hierarchyWidthScale * (projection.localScaleX ?? 1);
  const spread = shapeWidth * coordinates.xPerUnity * particleXScale;
  const directionalMotion = nativeDirectionalMotion(effect, clip, projection, effectDuration);
  const groups: JsonValue[] = [];
  for (const window of windows) {
    const emissionEnd = directionalMotion
      ? Math.min(window.end, Math.max(window.start, directionalMotion.end))
      : window.end;
    const activeDuration = emissionEnd - window.start;
    if (activeDuration <= 0) continue;
    const simulationSpeed = Math.max(
      Number.EPSILON,
      nativeSystemAverageValue(
        effect,
        clip,
        projection,
        effectDuration,
        window,
        nativeAnimationAttributes.simulationSpeed,
        baseSimulationSpeed,
      ),
    );
    const rateOverDistance = Math.max(
      0,
      nativeSystemAverageValue(
        effect,
        clip,
        projection,
        effectDuration,
        window,
        nativeAnimationAttributes.rateOverDistance,
        baseRateOverDistance,
      ),
    );
    const motionDistance = directionalMotion?.distanceBetween(window.start, emissionEnd) ?? 0;
    const count = projectedEmissionCount(
      data,
      activeDuration,
      simulationSpeed,
      rateOverDistance,
      motionDistance,
      projection,
      file,
    );
    if (!count) continue;
    const realLifetime = lifetime / simulationSpeed;
    const duration = Math.min(
      realLifetime / effectDuration,
      window.end / effectDuration - window.start / effectDuration,
    );
    if (duration <= 0) continue;
    const sourceEmissionDuration =
      data.looping === true
        ? activeDuration
        : Math.min(
            activeDuration,
            data.lengthInSec === undefined
              ? activeDuration
              : requireFiniteNumber(data.lengthInSec, `${file}.data.lengthInSec`) / simulationSpeed,
          );
    const emissionSpan = sourceEmissionDuration / effectDuration;
    // Do not collapse source streams into six artificial bursts. A group can
    // still represent several identically-authored particles, but their birth
    // times remain dense enough to retain the rising/moving stream.
    const steps = Math.min(48, Math.max(1, Math.ceil(count / 3)));
    let remaining = count;
    const motionStart = directionalMotion?.positionAt(window.start) ?? 0;
    const motionEnd = directionalMotion?.positionAt(emissionEnd) ?? motionStart;
    const sourceMotionSign = Math.sign(motionEnd - motionStart) || -1;
    const directionScale = projection.direction ? projection.direction / sourceMotionSign : 1;
    for (let step = 0; step < steps; step++) {
      const stepCount = Math.ceil(remaining / (steps - step));
      remaining -= stepCount;
      const start = window.start / effectDuration + (steps === 1 ? 0 : (emissionSpan * step) / (steps - 1));
      const visibleDuration = Math.min(duration, window.end / effectDuration - start);
      if (visibleDuration <= 0) continue;
      const effectTime = start * effectDuration;
      const startColor = nativeParticleStartColor(effect, clip, projection, effectDuration, effectTime, initial, file);
      const emissionX = directionalMotion
        ? (directionalMotion.positionAt(effectTime) - motionStart) *
          directionScale *
          coordinates.xPerUnity *
          particleXScale
        : 0;
      for (let segment = 0; segment < lifetimeBoundaries.length - 1; segment++) {
        const lifeStart = lifetimeBoundaries[segment]!;
        const lifeEnd = lifetimeBoundaries[segment + 1]!;
        if (lifeEnd <= lifeStart) continue;
        const segmentStart = start + visibleDuration * lifeStart;
        const segmentDuration = visibleDuration * (lifeEnd - lifeStart);
        if (segmentDuration <= 0) continue;
        const color = multiplyNativeColors(
          startColor,
          nativeColorOverLifetime(data, (lifeStart + lifeEnd) / 2, file),
          `${file}.particleColor`,
        );
        const alphaFrom = clamp(
          requireFiniteNumber(startColor.a, `${file}.InitialModule.startColor.maxColor.a`) *
            requireFiniteNumber(nativeColorOverLifetime(data, lifeStart, file).a, `${file}.ColorModule.a`),
          0,
          1,
        );
        const alphaTo = clamp(
          requireFiniteNumber(startColor.a, `${file}.InitialModule.startColor.maxColor.a`) *
            requireFiniteNumber(nativeColorOverLifetime(data, lifeEnd, file).a, `${file}.ColorModule.a`),
          0,
          1,
        );
        const widthFrom = Math.max(
          0.001,
          baseSize * nativeSizeAxisScale(sizeModule, "x", lifeStart, file) * coordinates.xPerUnity * particleXScale,
        );
        const widthTo = Math.max(
          0.001,
          baseSize * nativeSizeAxisScale(sizeModule, "x", lifeEnd, file) * coordinates.xPerUnity * particleXScale,
        );
        const sourceHeightFrom = Math.max(0.001, baseSize * nativeSizeAxisScale(sizeModule, "y", lifeStart, file));
        const sourceHeightTo = Math.max(0.001, baseSize * nativeSizeAxisScale(sizeModule, "y", lifeEnd, file));
        // ShapeModule determines a particle's fixed birth offset. Reusing the
        // same random channel at both endpoints keeps that offset fixed; the
        // former `spread * .8` invented a left/right drift even for normal
        // notes, whose source systems are Local-space and have
        // rateOverDistance=0 and VelocityModule.x=0. Horizontal motion now
        // comes only from an authored world-space emitter path or Velocity.x.
        const xFrom = randomizedParticleCurve(
          emissionX +
            integratedVelocityAxis(data, "x", lifetime * lifeStart, lifetime, file) *
              coordinates.xPerUnity *
              particleXScale,
          1,
          spread,
        );
        const xTo = randomizedParticleCurve(
          emissionX +
            integratedVelocityAxis(data, "x", lifetime * lifeEnd, lifetime, file) *
              coordinates.xPerUnity *
              particleXScale,
          1,
          spread,
        );
        // Unity builds a ParticleSystemRenderer quad around
        // `(vertex - m_Pivot) * particleSize`. Project the resulting native
        // vertical bounds through LiveGameCamera rather than flattening them
        // into the lane-depth scale; this retains the tall beam silhouettes.
        const rendererPivotY = projection.rendererPivotY ?? 0;
        const sourceCenterYFrom =
          projection.y +
          integratedVerticalVelocity(data, lifetime * lifeStart, lifetime, file) -
          rendererPivotY * sourceHeightFrom;
        const sourceCenterYTo =
          projection.y +
          integratedVerticalVelocity(data, lifetime * lifeEnd, lifetime, file) -
          rendererPivotY * sourceHeightTo;
        const rectFrom = nativeEffectVerticalRect(sourceCenterYFrom, projection.z ?? 0, sourceHeightFrom, 0.5);
        const rectTo = nativeEffectVerticalRect(sourceCenterYTo, projection.z ?? 0, sourceHeightTo, 0.5);
        groups.push({
          count: stepCount,
          particles: [
            {
              sprite: nativeParticleSpriteIndices[projection.sprite],
              color: colorHex(color, `${file}.particleColor`),
              start: segmentStart,
              duration: segmentDuration,
              x: particleProperty(xFrom, xTo, "linear"),
              y: particleProperty(
                randomizedParticleCurve(rectFrom.y, 2, 0.045),
                randomizedParticleCurve(rectTo.y, 3, 0.12),
              ),
              w: particleProperty(
                randomizedParticleCurve(widthFrom, 5, sizeRandom * coordinates.xPerUnity * particleXScale),
                particleCurve(widthTo),
              ),
              h: particleProperty(
                randomizedParticleCurve(
                  rectFrom.h,
                  5,
                  (Math.abs(rectFrom.h) / Math.max(Number.EPSILON, sourceHeightFrom)) * sizeRandom,
                ),
                particleCurve(rectTo.h),
              ),
              r: particleProperty(particleCurve(0), particleCurve(0), "linear"),
              a: particleProperty(particleCurve(alphaFrom), particleCurve(alphaTo), "linear"),
            },
          ],
        });
      }
    }
  }
  return groups;
}

function makeNativeNoteParticle(projection: NativeEffectProjection): JsonObject {
  const clip = readNativeAnimationClip(projection.clip);
  const effectDuration = projection.loopPulses ? 1 : clip.duration;
  if (effectDuration <= 0) throw new Error(`${projection.clip} has no positive duration`);
  return {
    name: projection.name,
    transform: identity,
    groups: [
      ...makeAnimatedRendererGroups(projection, clip),
      ...projection.systems.flatMap((system) => makeParticleSystemGroups(projection, clip, system, effectDuration)),
    ],
  };
}

function makeJudgedNativeNoteParticles(projection: NativeEffectProjection): JsonObject[] {
  const effects = [makeNativeNoteParticle(projection)];
  if (!projection.judgmentClips) return effects;
  const { judgmentClips, ...baseProjection } = projection;
  effects.push(
    makeNativeNoteParticle({
      ...baseProjection,
      name: `${projection.name} Great`,
      clip: judgmentClips.great,
    }),
    makeNativeNoteParticle({
      ...baseProjection,
      name: `${projection.name} Good`,
      clip: judgmentClips.good,
    }),
    makeNativeNoteParticle({
      ...baseProjection,
      name: `${projection.name} Bad`,
      clip: judgmentClips.bad,
    }),
  );
  return effects;
}

function makeLaneParticle(
  name: string,
  transform: JsonValue,
  color: string,
  width: number,
  heightAt: (time: number) => number,
  alpha: number,
  alphaKeys: readonly (readonly [time: number, value: number])[],
  sprite: number,
): JsonObject {
  const groups: JsonValue[] = [];
  const alphaAt = (time: number): number => {
    for (let index = 0; index < alphaKeys.length - 1; index++) {
      const from = alphaKeys[index];
      const to = alphaKeys[index + 1];
      if (!from || !to || time < from[0] || time > to[0]) continue;
      const progress = (time - from[0]) / (to[0] - from[0]);
      return from[1] + (to[1] - from[1]) * progress;
    }
    return alphaKeys.at(-1)?.[1] ?? 0;
  };
  // Sonolus particle curves expose easing rather than Unity Hermite tangents.
  // Split the native size curve into short linear spans while retaining every
  // authored alpha key exactly; this is substantially closer than one line
  // across each alpha interval without introducing overlapping particles.
  const times = [
    ...new Set([...Array.from({ length: 9 }, (_, index) => index / 8), ...alphaKeys.map(([time]) => time)]),
  ]
    .sort((left, right) => left - right)
    .filter((time, index, values) => index === 0 || time - values[index - 1]! > Number.EPSILON);
  for (let index = 0; index < times.length - 1; index++) {
    const start = times[index];
    const end = times[index + 1];
    if (start === undefined || end === undefined || end <= start) continue;

    groups.push({
      count: 1,
      particles: [
        {
          // Native lane_effect_white alpha mask, appended to the compatibility
          // particle atlas below. Sonolus still approximates Unity's additive
          // material, but no longer substitutes an unrelated PJS texture.
          sprite,
          color,
          start,
          duration: end - start,
          x: { from: particleCurve(0), to: particleCurve(0), ease: "linear" },
          y: { from: particleCurve(-1), to: particleCurve(-1), ease: "linear" },
          w: { from: particleCurve(width), to: particleCurve(width), ease: "linear" },
          h: {
            from: particleCurve(heightAt(start)),
            to: particleCurve(heightAt(end)),
            ease: "linear",
          },
          r: { from: particleCurve(0), to: particleCurve(0), ease: "linear" },
          a: {
            from: particleCurve(alpha * alphaAt(start)),
            to: particleCurve(alpha * alphaAt(end)),
            ease: "linear",
          },
        },
      ],
    });
  }

  return { name, transform, groups };
}

function makeLaneParticles(transform: JsonValue, sprite: number): JsonObject[] {
  // Values below match the reference Unity 6000.3.12f1 ParticleSystems:
  // lane_tap_{blank_miss,normal,slide,flick,left,right}_view. The similarly
  // named lane_in_vain_view is an unreferenced legacy prefab and deliberately
  // is not used here. Their startLifetime is 0.45 with simulationSpeed=2, so
  // callers spawn this normalized curve for 0.225 real seconds. startSizeY is
  // normalized by the native 217.6000061 lane length because the Sonolus
  // effect is spawned on that lane.
  const laneLength = 217.6000061;
  const laneHeightAt = (time: number) => {
    // Unity AnimationCurve Hermite segment from the active ParticleSystem's
    // SizeModule.y, multiplied by y.scalar=2 and startSizeY=70.
    const startValue = 0.473175048828125;
    const startSlope = 1.1440188884735107;
    const endValue = 1;
    const endSlope = 0.09866950660943985;
    const time2 = time * time;
    const time3 = time2 * time;
    const value =
      (2 * time3 - 3 * time2 + 1) * startValue +
      (time3 - 2 * time2 + time) * startSlope +
      (-2 * time3 + 3 * time2) * endValue +
      (time3 - time2) * endSlope;
    return (70 * 2 * value) / laneLength;
  };
  const holdThenFade = [
    [0, 1],
    [0.44411383230334933, 1],
    [1, 0],
  ] as const;

  return [
    makeLaneParticle(
      "Our Notes Lane In Vain",
      transform,
      "#ffffff",
      1,
      laneHeightAt,
      0.4000000059604645,
      holdThenFade,
      sprite,
    ),
    makeLaneParticle(
      "Our Notes Lane Normal",
      transform,
      "#4e9cff",
      1,
      laneHeightAt,
      0.5254902243614197,
      holdThenFade,
      sprite,
    ),
    makeLaneParticle(
      "Our Notes Lane Slide",
      transform,
      "#ad7cff",
      1,
      laneHeightAt,
      0.2980392277240753,
      holdThenFade,
      sprite,
    ),
    makeLaneParticle(
      "Our Notes Lane Flick",
      transform,
      "#ffb17c",
      1,
      laneHeightAt,
      0.2078431397676468,
      holdThenFade,
      sprite,
    ),
    makeLaneParticle(
      "Our Notes Lane Flick Left",
      transform,
      "#7cff9b",
      1,
      laneHeightAt,
      0.2078431397676468,
      holdThenFade,
      sprite,
    ),
    makeLaneParticle(
      "Our Notes Lane Flick Right",
      transform,
      "#ec7cff",
      1,
      laneHeightAt,
      0.2078431397676468,
      holdThenFade,
      sprite,
    ),
  ];
}

const particleData = {
  width: 1024,
  height: 1024,
  interpolation: true,
  sprites: nativeParticleSpriteSpecs.map(({ x, y, w, h }) => ({ x, y, w, h })),
  effects: [
    ...makeLaneParticles(identity, nativeParticleSpriteIndices.lane),
    ...nativeEffectProjections.flatMap(makeJudgedNativeNoteParticles),
  ],
};
writeFileSync(resolve(out, "particle.data"), gzipSync(JSON.stringify(particleData), { level: 9 }));
writeFileSync(
  resolve(out, "particle.texture.png"),
  bakeNativeParticleTexture(
    readFileSync(resolve(source, "particle.texture.png")),
    preparedPng(nativeLaneEffectRoot, "lane_effect_white.png"),
  ),
);

const effectSourceFile = resolve(source, "effect.data");
const effectData = requireJsonObject(
  parseJson(gunzipSync(readFileSync(effectSourceFile)).toString("utf8"), effectSourceFile),
  "effect.data",
);
const effectClips = effectData.clips;
if (!Array.isArray(effectClips)) throw new Error("effect.data.clips must be an array");
for (const [index, value] of effectClips.entries()) {
  const entry = requireJsonObject(value, `effect.data.clips[${index}]`);
  if (typeof entry.name !== "string") throw new Error(`effect.data.clips[${index}].name must be a string`);
  entry.name = entry.name.replace(/^Sekai /, "Our Notes ");
}
writeFileSync(resolve(out, "effect.data"), gzipSync(JSON.stringify(effectData), { level: 9 }));
copyFileSync(resolve(source, "effect.audio"), resolve(out, "effect.audio"));

console.log(
  `built Our Notes Sonolus resources: ${sprites.length} skin sprites, ${particleData.effects.length} native particle effects -> ${out}`,
);
