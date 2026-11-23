// L3 — GEB
// Input: Released GEKISO prefab profiles, source textures, and Sonolus skins.
// Output: Baked Light and Standard stage tracks and their skin sprites.
// Pos: [Map](../L2-2.md); standalone Sonolus GEKISO stage asset authoring.
// Effects/Dependencies: Updates the standalone engine ROM, ABI and three skin atlases.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { decodeRgba8Png, encodeRgba8Png } from "./pack-original-note-skins.ts";
import { OurNotesGekisouStageProjector } from "../particle-producer/profile/src/presentation/GekisouStageProjector.js";
import type { OurNotesGekisouEffectProfile } from "../particle-producer/profile/src/presentation/GekisouStage.js";
import type { RenderOverlaySprite } from "../particle-producer/profile/src/render/types.js";

const [input, release, engine] = process.argv.slice(2);
if (!input || !release || !engine) throw new Error("Usage: export-gekisou-stage-rom PROFILE RELEASE_DIR ENGINE_DIR");
const bytes = readFileSync(input);
const profile = JSON.parse(bytes.toString("utf8")) as OurNotesGekisouEffectProfile;

function samples(effect: "in" | "loop" | "out") {
  const clip = profile.clips.find(({ name }) => name === profile.stateClipAliases[effect]);
  if (!clip || clip.sampleRate !== 60) throw new Error(`Invalid ${effect} clip`);
  return Math.round(clip.duration * clip.sampleRate);
}

const slots = [
  "root/gekisou_mask/gekisou_mask",
  "root/gekisou_mask/gekisou_mask_glow/center",
  "root/gekisou_mask/gekisou_mask_glow/left",
  "root/gekisou_mask/gekisou_mask_glow/right",
  "root/lane/base/line_l",
  "root/lane/base/line_r",
  "root/lane/base/line_l_stanby",
  "root/lane/base/line_r_stanby",
  "root/lane/base/line_l/line_star/stars",
  "root/lane/base/line_r/line_star/stars",
] as const;
const fps = 60;
const ticks = 1000 / fps;
const inFrames = samples("in"),
  loopFrames = samples("loop"),
  outFrames = samples("out");
const { standbyLeadMs, lastNoteSlowJudgeMs, completeDelayMs } = profile.lifecycle;
const exitDelayMs = lastNoteSlowJudgeMs + completeDelayMs;
const standbyFrames = Math.round(standbyLeadMs / ticks);
const slotStride = 10;
const atlasTileLimit = 128;
const spriteLimit = 20;
const spritePrefix = "Our Notes GEKISO Stage ";
const transform = Object.fromEntries(
  ["x1", "y1", "x2", "y2", "x3", "y3", "x4", "y4"].map((axis) => [axis, { [axis]: 1 }]),
);
type MaterialRecipe = {
  textureKey: string;
  uv: readonly [number, number, number, number];
  rgb: readonly number[];
};
const recipes: MaterialRecipe[] = [];
const materialKeys = new Map<string, number>();

const camera = profile.cameraProfiles["29"];
const { x, y, z, w } = camera.worldRotation;
const view = [
  [1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w)],
  [2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w)],
  [2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y)],
];
const aspect = 1920 / 1080,
  fov = Math.tan(camera.fieldOfViewDegrees * Math.PI / 360);
const { x: cameraX, y: cameraY, z: cameraZ } = camera.worldPosition;
const row = (axis: number, scale: number) => {
  const [a, b, c] = view[axis]!;
  return [a! * scale, b! * scale, c! * scale, -(a! * cameraX + b! * cameraY + c! * cameraZ) * scale];
};
const rows = [row(0, 1 / (fov * aspect)), row(1, 1 / fov), [0, 0, 0, 0], row(2, 1)];
const matrix = new Float64Array(rows.flatMap((_, column) => rows.map((r) => r[column]!)));

/** Unity tight sprites use an affine UV mapping in homogeneous clip space. */
function spriteQuad(draw: RenderOverlaySprite): number[] {
  const { indices, vertices } = draw;
  const u: number[] = [], v: number[] = [];
  for (let i = 0; i < vertices.length; i += 10) {
    u.push(vertices[i + 4]!);
    v.push(vertices[i + 5]!);
  }
  const left = Math.min(...u), right = Math.max(...u);
  const top = Math.min(...v), bottom = Math.max(...v);
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i]!, b = indices[i + 1]!, c = indices[i + 2]!;
    const du1 = u[b]! - u[a]!, du2 = u[c]! - u[a]!;
    const dv1 = v[b]! - v[a]!, dv2 = v[c]! - v[a]!;
    const area = du1 * dv2 - du2 * dv1;
    if (Math.abs(area) < 1e-8) continue;
    return [[left, bottom], [left, top], [right, top], [right, bottom]].flatMap(([x, y]) => {
      const dx = x! - u[a]!, dy = y! - v[a]!;
      const wb = (dx * dv2 - dy * du2) / area;
      const wc = (dy * du1 - dx * dv1) / area;
      const interpolate = (channel: number) =>
        (1 - wb - wc) * vertices[a * 10 + channel]! + wb * vertices[b * 10 + channel]! + wc * vertices[c * 10 + channel]!;
      return [0, 1, 2, 3].map(interpolate).concat(x!, y!, [6, 7, 8, 9].map(interpolate));
    });
  }
  throw new Error(`Degenerate GEKISO Sprite UVs for ${draw.id}`);
}

function quad(path: string, draw: RenderOverlaySprite | undefined): number[] {
  if (!draw) return Array<number>(slotStride).fill(0);
  const vertices = draw.id.startsWith("gekisou-stage:sprite:") ? spriteQuad(draw) : draw.vertices;
  if (vertices.length % 40 !== 0) throw new Error(`Source layer ${draw.id} is not a quad batch`);
  const tint = draw.material?.tint ?? [1, 1, 1, 1];
  const hdr = draw.material?.shader === "mobile-add-hdr";
  const tintFactor = (c: number) => hdr ? 2 * tint[c]! ** 2 : tint[c]!;
  const [scaleX, scaleY, offsetX, offsetY] = draw.material?.textureTransform ?? [1, 1, 0, 0];
  for (let offset = 0; offset < vertices.length; offset += 40) {
    const quad = Array.from({ length: 4 }, (_, vertex) => {
      const i = offset + vertex * 10;
      const w = vertices[i + 3]!;
      return {
        w, x: vertices[i]! / w, y: vertices[i + 1]! / w,
        u: vertices[i + 4]!, v: vertices[i + 5]!, alpha: vertices[i + 9]!,
      };
    });
    const opacity = Math.min(1, quad[0]!.alpha * tintFactor(3));
    if (opacity <= 0 || quad.every(({ w }) => w < camera.near)) continue;
    if (path.endsWith("/stars") && (
      quad.every(({ x }) => x < -1) || quad.every(({ x }) => x > 1) ||
      quad.every(({ y }) => y < -1) || quad.every(({ y }) => y > 1)
    )) continue;
    // Sonolus consumes lb, lt, rt, rb. Preserve the Source mesh's UV orientation.
    quad.sort((a, b) => a.u - b.u);
    const left = quad.slice(0, 2).sort((a, b) => b.v - a.v);
    const right = quad.slice(2).sort((a, b) => a.v - b.v);
    for (const pair of [left, right]) {
      const back = pair.find(({ w }) => w < camera.near);
      if (!back) continue;
      const front = pair.find(({ w }) => w >= camera.near);
      if (!front) break;
      const t = (camera.near - back.w) / (front.w - back.w);
      back.x = ((1 - t) * back.x * back.w + t * front.x * front.w) / camera.near;
      back.y = ((1 - t) * back.y * back.w + t * front.y * front.w) / camera.near;
      back.w = camera.near;
    }
    if (quad.some(({ w }) => w < camera.near)) continue;
    const stableUv = (value: number) => Math.round(value * 4096) / 4096;
    const uv = [
      stableUv(quad[0]!.u * scaleX + offsetX),
      stableUv(right[0]!.v * scaleY + offsetY),
      stableUv(quad[3]!.u * scaleX + offsetX),
      stableUv(left[0]!.v * scaleY + offsetY),
    ] as const;
    const group = path.replace(/(?:left|right|line_[lr])/g, "side");
    const key = JSON.stringify([group, draw.textureKey, uv]);
    let material = materialKeys.get(key);
    const rgb = [0, 1, 2].map((c) => vertices[offset + 6 + c]! * tintFactor(c));
    if (rgb.every((value) => value <= 0)) continue;
    if (material === undefined) {
      material = recipes.length;
      if (material >= spriteLimit) throw new Error("GEKISO stage material count exceeds the fixed skin table");
      materialKeys.set(key, material);
      recipes.push({ textureKey: draw.textureKey, uv, rgb });
    }
    const energy = (color: readonly number[]) => color[0]! * .2126 + color[1]! * .7152 + color[2]! * .0722;
    const gain = energy(rgb) / energy(recipes[material]!.rgb);
    return [Math.min(1, opacity * gain), material, ...[...left, ...right].flatMap(({ x, y }) => [x, y])];
  }
  return Array<number>(slotStride).fill(0);
}

function bake(mode: 1 | 2): number[] {
  const variant = profile.profiles[mode === 1 ? "light" : "standard"];
  const paths = new Map(variant.nodes.map(({ id, path }) => [id, path]));
  const drawIds = new Map<string, string>();
  for (const system of variant.systems)
    drawIds.set(`gekisou-stage:particle:${system.id}`, paths.get(system.nodeId)!);
  for (const component of variant.components) {
    if (component.type !== "SpriteRenderer") continue;
    drawIds.set(`gekisou-stage:sprite:${component.pathId}`, paths.get(component.data.m_GameObject!.m_PathID)!);
  }
  const start = standbyLeadMs;
  // Leave enough time for one full clean Animator loop before triggering exit.
  const loopStart = start + inFrames * ticks;
  const exit = loopStart + loopFrames * ticks;
  const end = exit - exitDelayMs;
  const projector = new OurNotesGekisouStageProjector(profile, [{ startTimeMs: start, endTimeMs: end }], () => 0x12345678);
  const frames: number[] = [];
  for (const [origin, count] of [[0, standbyFrames], [start, inFrames], [loopStart, loopFrames], [exit, outFrames]] as const) {
    for (let frame = 0; frame < count; frame++) {
      const layers = new Map(projector.project(
        { mode, timeMs: origin + frame * ticks },
        { worldToClip: matrix, width: 1920, height: 1080 },
      ).map((draw) => [drawIds.get(draw.id), draw]));
      for (const path of slots) {
        let draw = layers.get(path);
        if (!draw && path.endsWith("/stars")) {
          const side = path.includes("/line_l/") ? "l" : "r";
          draw = layers.get(`root/lane/base/line_${side}_stanby/stars`);
        }
        frames.push(...quad(path, draw));
      }
    }
  }
  return frames;
}

const standard = bake(2);
const light = bake(1);
const frameStride = slots.length * slotStride;
if (!standard.some((value, i) => i % frameStride >= 8 * slotStride && i % slotStride === 0 && value > 0))
  throw new Error("Standard prefab star pass was not sampled");
if (!standard.every(Number.isFinite) || !light.every(Number.isFinite))
  throw new Error("Non-finite GEKISO light sample");
if (!standard.some((value, i) => value !== light[i]))
  throw new Error("Source prefab variants produced identical GEKISO render tracks");

const textures = new OurNotesGekisouStageProjector(profile, [], () => 1).textures((path) => path);
const sourceImages = new Map<string, ReturnType<typeof decodeRgba8Png>>();
const tiles = recipes.map(({ textureKey, uv: [left, top, right, bottom], rgb }, i) => {
  let image = sourceImages.get(textureKey);
  if (!image) {
    const source = resolvePath(release, textures[textureKey]!.url);
    image = decodeRgba8Png(readFileSync(source), source);
    sourceImages.set(textureKey, image);
  }
  const sourceWidth = (right - left) * image.width;
  const sourceHeight = (bottom - top) * image.height;
  const scale = Math.min(1, atlasTileLimit / Math.max(sourceWidth, sourceHeight));
  const w = Math.max(1, Math.round(sourceWidth * scale));
  const h = Math.max(1, Math.round(sourceHeight * scale));
  const pixels = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const sourceX = Math.min(image.width - 1, Math.max(0, Math.floor(left * image.width + (x + .5) * sourceWidth / w)));
    const sourceY = Math.min(image.height - 1, Math.max(0, Math.floor(top * image.height + (y + .5) * sourceHeight / h)));
    const src = (sourceY * image.width + sourceX) * 4;
    const dest = (y * w + x) * 4;
    for (let c = 0; c < 3; c++) pixels[dest + c] = Math.min(255, Math.round(image.pixels[src + c]! * rgb[c]!));
    pixels[dest + 3] = image.pixels[src + 3]!;
  }
  return { name: spritePrefix + i, w, h, pixels };
});

type Rect = { x: number; y: number; w: number; h: number };
for (const edition of ["skin001", "skin002", "skin003"]) {
  const directory = resolvePath(engine, "resources/presentation/skins", edition);
  const dataPath = resolvePath(directory, "skin.data");
  const texturePath = resolvePath(directory, "skin.texture.png");
  const data = JSON.parse(gunzipSync(readFileSync(dataPath)).toString()) as {
    width: number;
    sprites: Array<Rect & { name: string; transform: typeof transform }>;
  };
  const source = decodeRgba8Png(readFileSync(texturePath), texturePath);
  const originalWidth = Math.min(source.width, 2048);
  let width = originalWidth;
  let spillY = 0;
  const image = { ...source, pixels: Buffer.from(source.pixels) };
  data.sprites = data.sprites.filter(({ name }) => !name.startsWith(spritePrefix));
  const rowEnds = Array.from({ length: image.height }, (_, y) => data.sprites
    .filter((s) => y >= s.y - 2 && y < s.y + s.h + 2)
    .map((s) => [Math.max(0, s.x - 2), Math.min(originalWidth, s.x + s.w + 2)] as const));
  for (const tile of [...tiles].sort((a, b) => b.w * b.h - a.w * a.h)) {
    const { w, h, name, pixels } = tile;
    const paddedWidth = w + 4;
    const paddedHeight = h + 4;
    let placement: Rect | undefined;
    for (let y = 0; y <= image.height - paddedHeight && !placement; y += 2) {
      const intervals = rowEnds.slice(y, y + paddedHeight).flat().sort((a, b) => a[0] - b[0]);
      let x = 0;
      for (const [left, right] of intervals) {
        if (left - x >= paddedWidth) break;
        x = Math.max(x, right);
      }
      if (x + paddedWidth > originalWidth) continue;
      placement = { x: x + 2, y: y + 2, w, h };
      for (let row = y; row < y + paddedHeight; row++) rowEnds[row]!.push([x, x + paddedWidth]);
    }
    if (!placement) {
      width = originalWidth + atlasTileLimit + 4;
      if (spillY + paddedHeight > image.height) throw new Error(`${edition}: GEKISO spill exceeds atlas height`);
      if (image.width !== width) {
        const pixels = Buffer.alloc(width * image.height * 4);
        for (let row = 0; row < image.height; row++)
          image.pixels.copy(pixels, row * width * 4, row * image.width * 4, (row + 1) * image.width * 4);
        image.width = width;
        image.pixels = pixels;
      }
      placement = { x: originalWidth + 2, y: spillY + 2, w, h };
      spillY += paddedHeight;
    }
    const { x, y } = placement;
    for (let dy = -2; dy < h + 2; dy++) for (let dx = -2; dx < w + 2; dx++) {
      const src = (Math.min(h - 1, Math.max(0, dy)) * w + Math.min(w - 1, Math.max(0, dx))) * 4;
      pixels.copy(image.pixels, ((y + dy) * image.width + x + dx) * 4, src, src + 4);
    }
    data.sprites.push({ ...placement, name, transform });
  }
  data.width = image.width;
  writeFileSync(dataPath, gzipSync(JSON.stringify(data), { level: 9 }));
  writeFileSync(texturePath, encodeRgba8Png(image, true));
}

const values = [63901, fps, standbyLeadMs, inFrames, loopFrames, outFrames, exitDelayMs, ...light, ...standard];
const rom = Buffer.alloc(values.length * 4);
for (const [i, value] of values.entries()) rom.writeFloatLE(value, i * 4);
writeFileSync(resolvePath(engine, "assets/GekisouStageRom"), rom);
console.log(`GEKISO stage ROM: ${rom.length} bytes, ${tiles.length} skin tiles, profile sha256 ${createHash("sha256").update(bytes).digest("hex")}`);
