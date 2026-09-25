import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { deflateSync, gunzipSync, gzipSync, inflateSync } from "node:zlib";

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

// Composite the reconstructed 3D wall, billboards and HDR/Bloom offline.
// Never expand every Unity particle into thousands of runtime segments.
const bakedRoot = resolve(process.env.SONOLUS_BAKED_EFFECTS_DIR || resolve(root, "packages/sonolus/assets/baked"));
const capture = requireJsonObject(
  parseJson(readFileSync(resolve(bakedRoot, "capture.json"), "utf8"), "effect capture provenance"),
  "effect capture provenance",
);
// This unpublished resource is usable without claiming that a capture of our
// own renderer proves Unity parity. Preserve that distinction in build output.
if (capture.referenceValidated !== true) {
  const message = "Baked effects have partial original-video review; full visual parity is not established.";
  if (process.env.SONOLUS_REQUIRE_REFERENCE_PARITY === "1") throw new Error(message);
  console.warn(message);
}
const baked = requireJsonObject(
  parseJson(readFileSync(resolve(bakedRoot, "particle.json"), "utf8"), "baked particles"),
  "baked particles",
);
if (baked.width !== 8192 || baked.height !== 8192 || !Array.isArray(baked.sprites) || !Array.isArray(baked.effects)) {
  throw new Error("Invalid baked particle atlas; run Cassiopeia's effect capture first");
}
const bakedTexture = decodeRgba8Png(readFileSync(resolve(bakedRoot, "particle.texture.png")), "baked atlas");
if (bakedTexture.width !== 8192 || bakedTexture.height !== 8192) throw new Error("Baked texture dimensions disagree");
const baseNoteNames = [
  ...["Normal", "Slide", "Flick", "Flick Left", "Flick Right", "Connect"].flatMap((name) =>
    ["", " Great", " Good", " Bad"].map((judgement) => `Our Notes Native ${name}${judgement}`),
  ),
  "Our Notes Native Slide Loop",
];
const expectedNames = [
  ...baseNoteNames.flatMap((name) => [name, `${name} Width 4`, `${name} Width 10`]),
  ...["In Vain", "Normal", "Slide", "Flick", "Flick Left", "Flick Right"].map((name) => `Our Notes Lane ${name}`),
];
const actualNames = baked.effects.map((e) => requireJsonObject(e, "baked effect").name);
if (
  new Set(actualNames).size !== actualNames.length ||
  expectedNames.length !== actualNames.length ||
  expectedNames.some((n) => !actualNames.includes(n))
) {
  throw new Error("Baked effect names do not cover every native judgement state");
}
const bakedSpriteCount = baked.sprites.length;
for (const value of baked.sprites) {
  const sprite = requireJsonObject(value, "baked sprite");
  const x = requireFiniteNumber(sprite.x, "sprite.x"),
    y = requireFiniteNumber(sprite.y, "sprite.y");
  const w = requireFiniteNumber(sprite.w, "sprite.w"),
    h = requireFiniteNumber(sprite.h, "sprite.h");
  if (![x, y, w, h].every(Number.isInteger) || x < 0 || y < 0 || w <= 0 || h <= 0 || x + w > 8192 || y + h > 8192)
    throw new Error("Baked sprite is outside the atlas");
}
const budget = baked.effects.map((value) => {
  const effect = requireJsonObject(value, "baked effect");
  if (!Array.isArray(effect.groups) || effect.groups.length > 32 || !effect.groups.length)
    throw new Error("Effect exceeds the 32-frame budget");
  let end = 0;
  for (const value of effect.groups) {
    const group = requireJsonObject(value, "baked group");
    if (group.count !== 1 || !Array.isArray(group.particles) || group.particles.length !== 1)
      throw new Error("Only one quad per animation frame is permitted");
    const p = requireJsonObject(group.particles[0], "baked frame");
    const alpha = requireJsonObject(p.a, "frame.a");
    if (
      alpha.ease !== "none" ||
      requireJsonObject(alpha.from, "alpha.from").c !== 1 ||
      requireJsonObject(alpha.to, "alpha.to").c !== 0
    )
      throw new Error("Frames must step alpha to zero at their inclusive end boundary");
    const start = requireFiniteNumber(p.start, "frame.start"),
      duration = requireFiniteNumber(p.duration, "frame.duration");
    if (duration <= 0 || Math.abs(start - end) > 1e-9)
      throw new Error("Baked frames must be contiguous and non-overlapping");
    if (!Number.isInteger(p.sprite) || typeof p.sprite !== "number" || p.sprite < 0 || p.sprite >= bakedSpriteCount)
      throw new Error("Invalid frame sprite");
    end = start + duration;
  }
  if (Math.abs(end - 1) > 1e-9) throw new Error("Baked animation must cover the complete native duration");
  return { name: effect.name, allocatedQuads: effect.groups.length, peakVisibleQuads: 1 };
});
const particleData = baked;
writeFileSync(resolve(out, "particle.data"), gzipSync(JSON.stringify(particleData), { level: 9 }));
writeFileSync(resolve(out, "particle.texture.png"), encodeRgba8Png(bakedTexture));
writeFileSync(
  resolve(out, "particle-budget.json"),
  JSON.stringify(
    {
      profile: "baked-3d-30fps",
      referenceValidated: capture.referenceValidated === true,
      maxFrames: 32,
      textureBytes: 8192 * 8192 * 4,
      effects: budget,
    },
    null,
    2,
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
  `built Our Notes Sonolus resources: ${sprites.length} skin sprites, ${baked.effects.length} native particle effects -> ${out}`,
);
