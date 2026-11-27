// L3 — GEB
// Input: Released GEKISO prefab profiles, source textures, and Sonolus skins.
// Output: Baked Light and Standard stage tracks, plus the authored GEKISO HUD sprites.
// Pos: [Map](../L2-2.md); standalone Sonolus GEKISO stage asset authoring.
// Effects/Dependencies: Updates the standalone engine ROM, ABI and three skin atlases.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { appendGekisouSkinTiles, decodeRgba8Png } from "./pack-original-note-skins.ts";
import { OurNotesGekisouStageProjector } from "../particle-producer/profile/src/presentation/GekisouStageProjector.js";
import type { OurNotesGekisouEffectProfile } from "../particle-producer/profile/src/presentation/GekisouStage.js";
import { soloHudSpriteNames } from "../../../.dependencies/sonolus-our-notes/shared/src/engine/data/soloModeHudSprites.ts";
import { GEKISOU_COUNTDOWN_ROM, GEKISOU_STAGE_ROM } from "../../../.dependencies/sonolus-our-notes/shared/src/engine/data/gekisouStageRomAbi.ts";
import { OurNotesGekisouOverlayProjector } from "../particle-producer/profile/src/presentation/GekisouOverlay.js";
import type { OurNotesGekisouMission } from "../particle-producer/profile/src/presentation/Gekisou.js";
import laneHud from "../particle-producer/profile/src/assets/gekisou-lane-hud-profile.json";
import type { RenderOverlaySprite } from "../particle-producer/profile/src/render/types.js";
import { bakeGekisouMissionHud } from "./export-gekisou-mission-hud.ts";

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
type MaterialRecipe = {
  textureKey: string;
  uv: readonly [number, number, number, number];
  rgb: readonly [number, number, number];
  additive: boolean;
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
function spriteQuad(draw: RenderOverlaySprite, preferCorners = false): number[] {
  const { indices, vertices } = draw;
  const u: number[] = [], v: number[] = [];
  for (let i = 0; i < vertices.length; i += 10) {
    u.push(vertices[i + 4]!);
    v.push(vertices[i + 5]!);
  }
  const left = Math.min(...u), right = Math.max(...u);
  const top = Math.min(...v), bottom = Math.max(...v);
  const corners = [[left, bottom], [left, top], [right, top], [right, bottom]];
  if (preferCorners) {
    const indices = corners.map(([x, y]) => u.findIndex((value, i) => value === x && v[i] === y));
    if (indices.every(i => i >= 0)) return indices.flatMap(i => Array.from({ length: 10 }, (_, j) => vertices[i * 10 + j]!));
  }
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i]!, b = indices[i + 1]!, c = indices[i + 2]!;
    const du1 = u[b]! - u[a]!, du2 = u[c]! - u[a]!;
    const dv1 = v[b]! - v[a]!, dv2 = v[c]! - v[a]!;
    const area = du1 * dv2 - du2 * dv1;
    if (Math.abs(area) < 1e-8) continue;
    return corners.flatMap(([x, y]) => {
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
    const additive = draw.blend === "source-alpha-additive";
    const key = JSON.stringify([group, draw.textureKey, uv, additive]);
    let material = materialKeys.get(key);
    const rgb: MaterialRecipe["rgb"] = [
      vertices[offset + 6]! * tintFactor(0),
      vertices[offset + 7]! * tintFactor(1),
      vertices[offset + 8]! * tintFactor(2),
    ];
    if (rgb.every((value) => value <= 0)) continue;
    if (material === undefined) {
      material = recipes.length;
      if (material >= spriteLimit) throw new Error("GEKISO stage material count exceeds the fixed skin table");
      materialKeys.set(key, material);
      recipes.push({ textureKey: draw.textureKey, uv, rgb, additive });
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
const tiles = recipes.map(({ textureKey, uv: [left, top, right, bottom], rgb, additive }, i) => {
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
    const r = Math.min(255, image.pixels[src]! * rgb[0]);
    const g = Math.min(255, image.pixels[src + 1]! * rgb[1]);
    const b = Math.min(255, image.pixels[src + 2]! * rgb[2]);
    // Preserve emitted RGB over black using straight alpha. Dark texels in a
    // source-alpha additive texture transmit the stage under Sonolus Draw.
    const coverage = additive ? Math.max(r, g, b) / 255 : 1;
    if (coverage <= 0) continue;
    pixels[dest] = Math.round(r / coverage);
    pixels[dest + 1] = Math.round(g / coverage);
    pixels[dest + 2] = Math.round(b / coverage);
    pixels[dest + 3] = Math.round(image.pixels[src + 3]! * coverage);
  }
  return { name: spritePrefix + i, w, h, pixels };
});

const laneHudPaths = new Map(laneHud.textures.map(texture => [texture.key, texture.path]));
const hudPath = (index: number) => laneHudPaths.get(laneHud.sprites[index]!.texture)!;
const atlasDir = resolvePath(release, hudPath(16), "..");
const atlasSprites = new Map(readdirSync(atlasDir).map(file => [file.split("--Sprite")[0], resolvePath(atlasDir, file)]));
const hudSources = {
  digit0: 1, digit1: 2, digit2: 3, digit3: 4, digit4: 5,
  digit5: 6, digit6: 7, digit7: 8, digit8: 9, digit9: 10,
  countdown1: 20, countdown2: 21, countdown3: 22,
  modeCombo: 16, modeLuck: 18, modeJust: 17,
  ready: 24, divider: 23,
  countCombo: "SP_gekisou_count_combo", countLuck: "SP_gekisou_count_luck", countJust: 19,
  noLuck: "gekisou_luck_noluck_text", luck: "gekisou_luck_lucky_text",
  superLuck: "gekisou_luck_s_lucky_text", luckRush: "gekisou_luck_luckyrush_text",
  modeAssist: "../LiveAtlas.spriteatlasv2/SP_AssistMode--Sprite--4011404251611919236.png",
} satisfies Partial<Record<keyof typeof soloHudSpriteNames, number | string>>;
function sampleHudTexture(image: ReturnType<typeof decodeRgba8Png>, w: number, h: number) {
  const pixels = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const x0 = Math.floor(x * image.width / w), x1 = Math.ceil((x + 1) * image.width / w);
    const y0 = Math.floor(y * image.height / h), y1 = Math.ceil((y + 1) * image.height / h);
    let alpha = 0, red = 0, green = 0, blue = 0;
    for (let sy = y0; sy < y1; sy++) for (let sx = x0; sx < x1; sx++) {
      const offset = (sy * image.width + sx) * 4;
      const a = image.pixels[offset + 3]!;
      alpha += a;
      red += a * image.pixels[offset]!;
      green += a * image.pixels[offset + 1]!;
      blue += a * image.pixels[offset + 2]!;
    }
    if (alpha === 0) continue;
    const offset = (y * w + x) * 4;
    pixels[offset] = Math.round(red / alpha);
    pixels[offset + 1] = Math.round(green / alpha);
    pixels[offset + 2] = Math.round(blue / alpha);
    pixels[offset + 3] = Math.round(alpha / ((x1 - x0) * (y1 - y0)));
  }
  return pixels;
}

const readHudSource = (source: number | string) => {
  const path = typeof source === "number" ? hudPath(source) :
    source.startsWith("../") ? resolvePath(atlasDir, source) : atlasSprites.get(source);
  if (!path) throw new Error(`Missing authored HUD sprite: ${source}`);
  const file = resolvePath(release, path);
  return decodeRgba8Png(readFileSync(file), file);
};

const hudTiles: { name: string; w: number; h: number; pixels: Buffer }[] =
  (Object.keys(hudSources) as (keyof typeof hudSources)[]).map(key => {
    const image = readHudSource(hudSources[key]);
    const scale = Math.min(1, atlasTileLimit / Math.max(image.width, image.height));
    const w = Math.max(1, Math.round(image.width * scale));
    const h = Math.max(1, Math.round(image.height * scale));
    return { name: soloHudSpriteNames[key], w, h, pixels: sampleHudTexture(image, w, h) };
  });

const assistTitle = readHudSource(hudSources.modeAssist);
const assistWidth = atlasTileLimit * 2;
const assistHeight = Math.round(assistWidth * assistTitle.height / assistTitle.width);
const assistPixels = sampleHudTexture(assistTitle, assistWidth, assistHeight);
for (const [index, key] of (["assistTitleLeft", "assistTitleRight"] as const).entries()) {
  const pixels = Buffer.alloc(atlasTileLimit * assistHeight * 4);
  const stride = atlasTileLimit * 4;
  for (let y = 0; y < assistHeight; y++) {
    const start = y * stride * 2 + index * stride;
    assistPixels.copy(pixels, y * stride, start, start + stride);
  }
  hudTiles.push({ name: soloHudSpriteNames[key], w: atlasTileLimit, h: assistHeight, pixels });
}

const assistDigits = ["assistLevel0", "assistLevel1", "assistLevel2", "assistLevel3", "assistLevel4", "assistLevel5"] as const;
for (const [digit, key] of assistDigits.entries()) {
  const path = resolvePath(release, "assets/Assets/AddressableResources/Live/UiSpriteAssets/AtlasSources/LiveComboNAtlas",
    `SP_combo_n_${digit}_fill.png`);
  const glyph = decodeRgba8Png(readFileSync(path), path);
  const w = 30, h = 44;
  const scale = Math.min(w / glyph.width, h / glyph.height);
  const gw = Math.round(glyph.width * scale), gh = Math.round(glyph.height * scale);
  const fill = sampleHudTexture(glyph, gw, gh);
  const pixels = Buffer.alloc(w * h * 4);
  const offset = Math.floor((w - gw) / 2) + w * Math.floor((h - gh) / 2);
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
    const dst = (offset + y * w + x) * 4;
    pixels.fill(255, dst, dst + 3);
    // SP_AssistMode's principal lettering is white with 20% opacity.
    pixels[dst + 3] = Math.round(fill[(y * gw + x) * 4 + 3]! / 5);
  }
  hudTiles.push({ name: soloHudSpriteNames[key], w, h, pixels });
}
const hudKeys = Object.keys(soloHudSpriteNames);
const firstCountdownSprite = hudKeys.indexOf("countdown1");
const textureSlots = new Map([
  [20, "countdown1"], [21, "countdown2"], [22, "countdown3"],
  [16, "modeCombo"], [18, "modeLuck"], [17, "modeJust"],
  [23, "divider"], [24, "ready"],
].map(([index, key]) => [laneHud.sprites[index as number]!.texture, hudKeys.indexOf(key as string) - firstCountdownSprite]));
const countdownProjector = new OurNotesGekisouOverlayProjector();
const countdownViewport = { width: 1920, height: 1080, worldToClip: matrix, displayPositionChanged: false };
const countdownFrames = Math.round(GEKISOU_COUNTDOWN_ROM.durationMs / ticks);
const countdownRom: number[] = [GEKISOU_COUNTDOWN_ROM.magic];
for (let mission = 1; mission <= GEKISOU_COUNTDOWN_ROM.missionCount; mission++) {
  for (let index = 0; index < countdownFrames; index++) {
    const elapsed = index * ticks;
    const count = Math.max(0, 3 - Math.floor(index / fps));
    const clip = count === 3 ? "number3" : count === 2 ? "number2" : count === 1 ? "number1" : "out";
    const draws = [...countdownProjector.project({
      enabled: true, observedTimeMs: elapsed,
      countdown: {
        mission: mission as OurNotesGekisouMission,
        rangeIndex: 0, count: count > 0 ? count as 1 | 2 | 3 : null,
        clip, clipTimeSeconds: (index % fps) / fps, visible: true,
      },
      just: { rangeIndex: null, visible: false, count: 0, lastJudgedAtMs: null, lastAddedCount: 0 },
    }, countdownViewport)].sort((a, b) => a.sortingOrder - b.sortingOrder);
    if (draws.length > GEKISOU_COUNTDOWN_ROM.slotCount) throw new Error("GEKISO countdown sprite limit exceeded");
    for (let slot = 0; slot < GEKISOU_COUNTDOWN_ROM.slotCount; slot++) {
      const draw = draws[slot];
      if (!draw) {
        countdownRom.push(...Array<number>(GEKISOU_COUNTDOWN_ROM.slotStride).fill(0));
        continue;
      }
      const texture = textureSlots.get(draw.textureKey);
      if (texture === undefined || texture < 0) throw new Error(`Unmapped GEKISO countdown texture: ${draw.textureKey}`);
      const vertices = spriteQuad(draw, true);
      const positions = Array.from({ length: 4 }, (_, i) => {
        const v = i * 10;
        return [vertices[v]! / vertices[v + 3]!, vertices[v + 1]! / vertices[v + 3]!];
      }).flat();
      if (positions.some(value => !Number.isFinite(value))) throw new Error(`Invalid GEKISO countdown quad: ${draw.id}`);
      countdownRom.push(vertices[9]!, texture, ...positions);
    }
  }
}
const mission = bakeGekisouMissionHud(release, matrix, fov, aspect);
for (const edition of ["skin001", "skin002", "skin003"]) {
  appendGekisouSkinTiles(resolvePath(engine, "resources/presentation/skins", edition), [...tiles, ...hudTiles, ...mission.tiles]);
}

const values = [GEKISOU_STAGE_ROM.magic, fps, standbyLeadMs, inFrames, loopFrames, outFrames, exitDelayMs,
  ...light, ...standard, ...countdownRom, ...mission.rom];
const rom = Buffer.alloc(values.length * 4);
for (const [i, value] of values.entries()) rom.writeFloatLE(value, i * 4);
writeFileSync(resolvePath(engine, "assets/GekisouStageRom"), rom);
console.log(`GEKISO stage ROM: ${rom.length} bytes, ${tiles.length} stage tiles, ${hudTiles.length} HUD tiles, profile sha256 ${createHash("sha256").update(bytes).digest("hex")}`);
