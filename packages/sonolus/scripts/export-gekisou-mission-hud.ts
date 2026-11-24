// L3 — GEB
// Input: Original Live scene mission poses, sprite layout, clips and LUCK particle sheets.
// Output: Projected mission HUD tracks and packed skin tiles for Sonolus.
// Pos: [Map](../L2-2.md).
// Effects/Dependencies: Samples the original world-space HUD without a Unity runtime.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { GEKISOU_MISSION_HUD_ROM as abi } from "../../../.dependencies/sonolus-our-notes/shared/src/engine/data/gekisouStageRomAbi.ts";
import { soloHudSpriteNames } from "../../../.dependencies/sonolus-our-notes/shared/src/engine/data/soloModeHudSprites.ts";
import { eulerZxy, identity, multiply, trs, type Vec3, type Quaternion } from "../particle-producer/profile/src/authored/sourceTransform.js";
import source from "../particle-producer/profile/src/assets/gekisou-world-mission-profile.json";
import { decodeRgba8Png } from "./pack-original-note-skins.ts";

type Sprite = typeof source.glyphs[number];
type Node = typeof source.nodes[keyof typeof source.nodes];
type Track = typeof source.pop[number]["tracks"][number];
type Curve = Track["curves"][number];
type Pose = { position: Vec3; scale: Vec3; rotation: Quaternion; active: boolean; opacity: number };
type Rect = readonly [number, number, number, number];
type Tile = { name: string; w: number; h: number; pixels: Buffer };

const nodes: Record<string, Node> = source.nodes;
const keys = Object.keys(soloHudSpriteNames) as (keyof typeof soloHudSpriteNames)[];
const first = keys.indexOf("countCombo");
const spriteOffset = (key: string) => {
  const index = keys.indexOf(key as keyof typeof soloHudSpriteNames) - first;
  if (index < 0) throw new Error(`Unknown mission HUD sprite ${key}`);
  return index;
};

function sampled(curve: Curve, time: number): number {
  if ("constant" in curve) return curve.constant;
  let index = curve.segments.length - 1;
  while (index > 0 && curve.segments[index]!.time > time) index--;
  const row = curve.segments[index]!;
  const [a, b, c, d] = row.coefficients;
  const dt = time - row.time;
  return ((a! * dt + b!) * dt + c!) * dt + d!;
}

function tableau(tracks: Track[], time: number) {
  const poses = new Map<number, Pose>();
  const pose = (id: number): Pose => {
    let value = poses.get(id);
    if (!value) {
      const node = nodes[id]!;
      value = { position: node.position, scale: node.scale, rotation: node.rotation, active: node.active, opacity: 1 };
      poses.set(id, value);
    }
    return value;
  };
  for (const { node, property, curves } of tracks) {
    const [x, y, z, w] = curves.map(c => sampled(c, time));
    const value = pose(node);
    if (property === "position" || property === "scale") value[property] = { x: x!, y: y!, z: z! };
    else if (property === "rotation") value.rotation = { x: x!, y: y!, z: z!, w: w! };
    else if (property === "euler") value.rotation = eulerZxy({ x: x!, y: y!, z: z! });
    else if (property === "active") value.active = x! >= .5;
    else if (property === "opacity") value.opacity = Math.max(0, Math.min(1, x!));
  }
  const matrices = new Map<number, Float64Array>();
  const transform = (id: number): Float64Array => {
    const cached = matrices.get(id);
    if (cached) return cached;
    const parent = nodes[id]!.parent;
    const v = pose(id);
    const m = multiply(parent === null ? identity : transform(parent), trs(v.position, v.rotation, v.scale));
    matrices.set(id, m);
    return m;
  };
  return { pose, transform };
}

function spriteRect(sprite: Sprite): Rect {
  return [sprite.bounds[0]!, sprite.bounds[1]!, sprite.bounds[2]!, sprite.bounds[3]!];
}

function sizeRect(sprite: Sprite, size: readonly number[]): Rect {
  const [w, h] = size, [px, py] = sprite.pivot;
  const l = -w! * px!, b = -h! * py!;
  return [l, b, l + w!, b + h!];
}

function project(m: Float64Array, x: number, y: number): [number, number] {
  const depth = m[3]! * x + m[7]! * y + m[15]!;
  return [(m[0]! * x + m[4]! * y + m[12]!) / depth, (m[1]! * x + m[5]! * y + m[13]!) / depth];
}

function quad(m: Float64Array, [l, b, r, t]: Rect) {
  return [...project(m, l, b), ...project(m, l, t), ...project(m, r, t), ...project(m, r, b)];
}

function plane(m: Float64Array) {
  return [m[0]!, m[4]!, m[12]!, m[1]!, m[5]!, m[13]!, m[3]!, m[7]!, m[15]!];
}

export function bakeGekisouMissionHud(release: string, camera: Float64Array, fov: number, aspect: number) {
  const idle = tableau([], 0);
  const projectNode = (node: number, state = idle) => multiply(camera, state.transform(node));
  const tiles: Tile[] = [];
  const pictures = new Map<string, ReturnType<typeof decodeRgba8Png>>();
  function picture(relative: string) {
    let asset = pictures.get(relative);
    if (!asset) {
      const file = resolve(release, relative);
      asset = decodeRgba8Png(readFileSync(file), file);
      pictures.set(relative, asset);
    }
    return asset;
  }
  function tile(key: keyof typeof soloHudSpriteNames, asset: ReturnType<typeof decodeRgba8Png>, crop: Rect, width: number, height: number, glow?: number[]) {
    const [x0, y0, x1, y1] = crop;
    const w = Math.max(1, Math.round(width)), h = Math.max(1, Math.round(height));
    const pixels = Buffer.alloc(w * h * 4);
    const stepX = (x1 - x0) / w, stepY = (y1 - y0) / h;
    const samples = Math.max(1, Math.ceil(Math.max(stepX, stepY)));
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let subY = 0; subY < samples; subY++) for (let subX = 0; subX < samples; subX++) {
        const sy = Math.min(asset.height - 1, Math.floor(y0 + (y + (subY + .5) / samples) * stepY));
        const sx = Math.min(asset.width - 1, Math.floor(x0 + (x + (subX + .5) / samples) * stepX));
        const src = (sy * asset.width + sx) * 4;
        const alpha = Math.min(1, asset.pixels[src + 3]! * (glow?.[3] ?? 1) / 255);
        a += alpha;
        r += asset.pixels[src]! * alpha;
        g += asset.pixels[src + 1]! * alpha;
        b += asset.pixels[src + 2]! * alpha;
      }
      if (glow) {
        r *= glow[0]!;
        g *= glow[1]!;
        b *= glow[2]!;
        a = Math.max(r, g, b) / 255;
      }
      if (a <= 0) continue;
      const dst = (y * w + x) * 4;
      pixels[dst] = Math.round(r / a);
      pixels[dst + 1] = Math.round(g / a);
      pixels[dst + 2] = Math.round(b / a);
      pixels[dst + 3] = Math.round(a * 255 / (samples * samples));
    }
    tiles.push({ name: soloHudSpriteNames[key], w, h, pixels });
  }

  const v = source.visuals;
  // Original world SpriteRenderer slices the base and ordinary fill by pixel borders.
  const base = picture(v.luckGaugeBase.sprite.path);
  const fill = picture(v.luckGauge.sprite.path);
  const rush = picture(v.luckRushGauge.sprite.path);
  const [baseLeft, , baseRight] = v.luckGaugeBase.sprite.border;
  const [fillLeft, , fillRight] = v.luckGauge.sprite.border;
  const baseW = 128;
  const px = baseW / v.luckGaugeBase.size[0]!;
  const baseH = Math.round(v.luckGaugeBase.size[1]! * px);
  const capL = Math.round(baseLeft! / v.luckGaugeBase.sprite.pixelsPerUnit * px);
  const capR = Math.round(baseRight! / v.luckGaugeBase.sprite.pixelsPerUnit * px);
  // Keep the authored cap widths in a single fixed-size backing sprite.
  const basePixels = Buffer.alloc(baseW * baseH * 4);
  for (let y = 0; y < baseH; y++) for (let x = 0; x < baseW; x++) {
    const sy = Math.min(base.height - 1, Math.floor((y + .5) * base.height / baseH));
    const sx = x < capL ? (x + .5) * baseLeft! / capL :
      x >= baseW - capR ? base.width - baseRight! + (x - baseW + capR + .5) * baseRight! / capR :
      baseLeft! + (x - capL + .5) * (base.width - baseLeft! - baseRight!) / (baseW - capL - capR);
    const src = (sy * base.width + Math.floor(sx)) * 4;
    base.pixels.copy(basePixels, (y * baseW + x) * 4, src, src + 4);
  }
  tiles.push({ name: soloHudSpriteNames.luckGaugeBase, w: baseW, h: baseH, pixels: basePixels });
  tile("luckGaugeLeft", fill, [0, 0, fillLeft!, fill.height], fillLeft!, fill.height);
  tile("luckGauge", fill, [fillLeft!, 0, fill.width - fillRight!, fill.height], fill.width - fillLeft! - fillRight!, fill.height);
  tile("luckGaugeRight", fill, [fill.width - fillRight!, 0, fill.width, fill.height], fillRight!, fill.height);
  tile("luckRushGauge", rush, [0, 0, rush.width, rush.height], 128, rush.height * 128 / rush.width);
  for (const key of ["luckBase", "superLuckBase", "luckRushStar"] as const) {
    const art = picture(v[key].sprite.path);
    const scale = Math.min(1, 128 / Math.max(art.width, art.height));
    tile(key, art, [0, 0, art.width, art.height], art.width * scale, art.height * scale);
  }
  for (const [variant, hatena] of source.hatena.variants.entries()) {
    const art = picture(hatena.path);
    const [columns, rows] = hatena.tiles;
    if (columns! * rows! !== abi.symbolFrames) throw new Error("Unexpected LUCK symbol sheet dimensions");
    const cellW = art.width / columns!, cellH = art.height / rows!;
    // MobileAddHdrColor applies 2 * tint² before source-alpha additive blending.
    const glow = hatena.color.map((value, i) => value * 2 * hatena.tint[i]! ** 2);
    for (let i = 0; i < abi.symbolFrames; i++) {
      const x = (i % columns!) * cellW, y = Math.floor(i / columns!) * cellH;
      const key = variant === 0 ? `luckSymbol${i}` as const : `rushSymbol${i}` as const;
      tile(key as keyof typeof soloHudSpriteNames, art, [x, y, x + cellW, y + cellH], 48, 48, glow);
    }
  }

  const title = ["countCombo", "countJust"].flatMap(key => {
    const item = v[key as "countCombo" | "countJust"];
    return [item.opacity, spriteOffset(key), ...quad(projectNode(item.node), spriteRect(item.sprite))];
  });
  const glyphs = source.glyphs.flatMap(s => [s.rect[0]! / s.pixelsPerUnit, ...spriteRect(s)]);
  const numbers = source.numbers.flatMap(n => [...plane(projectNode(n.node)), n.spacing, n.capacity]);
  const gauge: number[] = [];
  for (let frame = 0; frame < abi.showFrames; frame++) {
    const show = tableau(source.show.tracks, Math.min(source.show.duration, frame / abi.fps));
    const item = v.countLuck;
    const titleOpacity = show.pose(item.node).opacity * item.opacity;
    const center = projectNode(source.hatena.node, show);
    const projected = project(center, 0, 0);
    const scale = show.pose(source.hatena.scaleNode).scale.x;
    const halfSize = source.hatena.variants[0]!.size * scale / (2 * center[15]! * fov);
    gauge.push(titleOpacity, spriteOffset("countLuck"), ...quad(projectNode(item.node, show), spriteRect(item.sprite)),
      v.luckGaugeBase.opacity, spriteOffset("luckGaugeBase"), ...quad(projectNode(v.luckGaugeBase.node, show), sizeRect(v.luckGaugeBase.sprite, v.luckGaugeBase.size)),
      ...plane(projectNode(v.luckGauge.node, show)), source.gauge.width, -v.luckGauge.size[1]! / 2, v.luckGauge.size[1]! / 2, source.gauge.cap,
      ...projected, halfSize / aspect, halfSize);
  }
  const symbol = [...source.hatena.variants.flatMap(s => [s.lifetime, s.period, s.frameOverTime]), ...source.hatena.tiers];
  const result: number[] = [];
  for (const pop of source.pop) {
    if (pop.layers.length > abi.resultSlots) throw new Error("Unexpected LUCK result layer count");
    for (let i = 0; i < abi.resultFrames; i++) {
      const time = i / abi.fps;
      const pose = tableau(pop.tracks, Math.min(pop.duration, time));
      pose.pose(pop.root).active = true;
      for (let slot = 0; slot < abi.resultSlots; slot++) {
        const item = pop.layers[slot];
        if (!item || time > pop.duration) {
          result.push(...Array<number>(abi.drawStride).fill(0));
          continue;
        }
        let alpha = 1;
        for (let n: number | null = item.node; n !== null; n = nodes[n]!.parent) {
          const value = pose.pose(n);
          alpha *= value.active ? value.opacity : 0;
        }
        const animatedOpacity = pop.tracks.some(t => t.node === item.node && t.property === "opacity");
        if (!animatedOpacity) alpha *= item.opacity;
        result.push(alpha, spriteOffset(item.key), ...quad(projectNode(item.node, pose), spriteRect(item.sprite)));
      }
    }
  }
  const sections = [title, glyphs, numbers, gauge, symbol, result];
  const offsets: number[] = [abi.magic];
  let next: number = abi.headerSize;
  for (const values of sections) {
    offsets.push(next);
    next += values.length;
  }
  const rom = [...offsets, ...sections.flat()];
  if (gauge.length !== abi.showFrames * abi.gaugeStride || rom.some(value => !Number.isFinite(value)))
    throw new Error("Invalid authored mission HUD tracks");
  return { rom, tiles };
}
