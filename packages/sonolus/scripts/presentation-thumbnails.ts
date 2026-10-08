import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { ease, type EaseName } from "./native-particles/fit.ts";
import { decodeRgba8Png, encodeRgba8Png, type DecodedRgbaPng, type PngChunk } from "./pack-original-note-skins.ts";

const THUMBNAIL_SIZE = 512;
const MAX_TEXTURE_BYTES = 96 * 1024 * 1024;
const BACKGROUND: readonly [number, number, number, number] = [8, 12, 30, 255];
const RANDOM_DRAWS = [0.17, 0.73, 0.31, 0.89, 0.47, 0.63, 0.23, 0.81] as const;
const PARTICLE_SNAPSHOT_TIME = 0.44;
const SKIN_IDS = ["skin001", "skin002", "skin003"] as const;
const PARTICLE_LAYERS = ["Our Notes Light Normal W4 P0"] as const;

type SkinId = (typeof SKIN_IDS)[number];

interface SpriteRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface SkinSprite extends SpriteRect {
  name: string;
}

interface SkinData {
  width: number;
  height: number;
  sprites: SkinSprite[];
}

type ParticleSprite = SpriteRect;

interface ChannelExpression {
  from?: Record<string, number>;
  to?: Record<string, number>;
  ease?: string;
}

interface ParticleDefinition {
  sprite: number;
  color: string;
  start: number;
  duration: number;
  x: ChannelExpression;
  y: ChannelExpression;
  w: ChannelExpression;
  h: ChannelExpression;
  r: ChannelExpression;
  a: ChannelExpression;
}

interface ParticleGroup {
  count: number;
  particles: ParticleDefinition[];
}

interface ParticleEffect {
  name: string;
  groups: ParticleGroup[];
}

interface ParticleData {
  width: number;
  height: number;
  sprites: ParticleSprite[];
  effects: ParticleEffect[];
}

interface PresentationThumbnailPaths {
  skins: Record<SkinId, string>;
  particle: string;
}

interface RgbaSample {
  red: number;
  green: number;
  blue: number;
  alpha: number;
}

type CropRect = SpriteRect;

interface ParticleDraw {
  sprite: SpriteRect;
  x: number;
  y: number;
  w: number;
  h: number;
  rotation: number;
  alpha: number;
  color: RgbaSample;
}

function readGzipJson<T>(path: string): T {
  return JSON.parse(gunzipSync(readFileSync(path)).toString("utf8")) as T;
}

function assertTextureBudget(texture: DecodedRgbaPng, sourceName: string): void {
  if (texture.pixels.length > MAX_TEXTURE_BYTES) {
    throw new Error(`${sourceName} decoded texture exceeds ${MAX_TEXTURE_BYTES} bytes`);
  }
}

function assertRect(rect: SpriteRect, width: number, height: number, sourceName: string): void {
  if (
    ![rect.x, rect.y, rect.w, rect.h].every(Number.isInteger) ||
    rect.x < 0 ||
    rect.y < 0 ||
    rect.w <= 0 ||
    rect.h <= 0 ||
    rect.x + rect.w > width ||
    rect.y + rect.h > height
  ) {
    throw new Error(`${sourceName} has invalid ${rect.x},${rect.y},${rect.w},${rect.h} bounds in ${width}x${height}`);
  }
}

function pixelOffset(texture: DecodedRgbaPng, x: number, y: number): number {
  return (y * texture.width + x) * 4;
}

function sampleNearest(texture: DecodedRgbaPng, x: number, y: number): RgbaSample {
  const offset = pixelOffset(texture, x, y);
  return {
    red: texture.pixels[offset]!,
    green: texture.pixels[offset + 1]!,
    blue: texture.pixels[offset + 2]!,
    alpha: texture.pixels[offset + 3]!,
  };
}

function sampleBilinear(texture: DecodedRgbaPng, x: number, y: number): RgbaSample {
  const x0 = Math.max(0, Math.min(texture.width - 1, Math.floor(x)));
  const y0 = Math.max(0, Math.min(texture.height - 1, Math.floor(y)));
  const x1 = Math.min(texture.width - 1, x0 + 1);
  const y1 = Math.min(texture.height - 1, y0 + 1);
  const tx = Math.max(0, Math.min(1, x - x0));
  const ty = Math.max(0, Math.min(1, y - y0));
  const topLeft = sampleNearest(texture, x0, y0);
  const topRight = sampleNearest(texture, x1, y0);
  const bottomLeft = sampleNearest(texture, x0, y1);
  const bottomRight = sampleNearest(texture, x1, y1);
  const interpolate = (left: number, right: number, amount: number): number => left + (right - left) * amount;
  const interpolateChannel = (channel: keyof RgbaSample): number => {
    const top = interpolate(topLeft[channel], topRight[channel], tx);
    const bottom = interpolate(bottomLeft[channel], bottomRight[channel], tx);
    return interpolate(top, bottom, ty);
  };
  return {
    red: interpolateChannel("red"),
    green: interpolateChannel("green"),
    blue: interpolateChannel("blue"),
    alpha: interpolateChannel("alpha"),
  };
}

function blend(canvas: Buffer, x: number, y: number, sample: RgbaSample, opacity = 1): void {
  if (x < 0 || y < 0 || x >= THUMBNAIL_SIZE || y >= THUMBNAIL_SIZE) return;
  const sourceAlpha = Math.max(0, Math.min(1, (sample.alpha / 255) * opacity));
  if (sourceAlpha <= 0) return;
  const offset = (y * THUMBNAIL_SIZE + x) * 4;
  const destinationAlpha = canvas[offset + 3]! / 255;
  const outputAlpha = sourceAlpha + destinationAlpha * (1 - sourceAlpha);
  if (outputAlpha <= 0) return;
  canvas[offset] = Math.round(
    (sample.red * sourceAlpha + canvas[offset]! * destinationAlpha * (1 - sourceAlpha)) / outputAlpha,
  );
  canvas[offset + 1] = Math.round(
    (sample.green * sourceAlpha + canvas[offset + 1]! * destinationAlpha * (1 - sourceAlpha)) / outputAlpha,
  );
  canvas[offset + 2] = Math.round(
    (sample.blue * sourceAlpha + canvas[offset + 2]! * destinationAlpha * (1 - sourceAlpha)) / outputAlpha,
  );
  canvas[offset + 3] = Math.round(outputAlpha * 255);
}

function createCanvas(): Buffer {
  const canvas = Buffer.alloc(THUMBNAIL_SIZE * THUMBNAIL_SIZE * 4);
  for (let offset = 0; offset < canvas.length; offset += 4) {
    canvas[offset] = BACKGROUND[0];
    canvas[offset + 1] = BACKGROUND[1];
    canvas[offset + 2] = BACKGROUND[2];
    canvas[offset + 3] = BACKGROUND[3];
  }
  return canvas;
}

function alphaCrop(texture: DecodedRgbaPng, rect: SpriteRect): CropRect | undefined {
  let left = rect.x + rect.w;
  let top = rect.y + rect.h;
  let right = rect.x;
  let bottom = rect.y;
  for (let y = rect.y; y < rect.y + rect.h; y += 1) {
    for (let x = rect.x; x < rect.x + rect.w; x += 1) {
      if (texture.pixels[pixelOffset(texture, x, y) + 3]! < 2) continue;
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x + 1);
      bottom = Math.max(bottom, y + 1);
    }
  }
  return left < right && top < bottom ? { x: left, y: top, w: right - left, h: bottom - top } : undefined;
}

function drawFittedCrop(
  canvas: Buffer,
  texture: DecodedRgbaPng,
  rect: SpriteRect,
  centerX: number,
  centerY: number,
  maxWidth: number,
  maxHeight: number,
  stretch = false,
  trimAlpha = true,
): void {
  const crop = trimAlpha ? alphaCrop(texture, rect) : rect;
  if (!crop) throw new Error(`Thumbnail sprite ${rect.x},${rect.y},${rect.w},${rect.h} is fully transparent`);
  const scale = Math.min(maxWidth / crop.w, maxHeight / crop.h);
  const width = Math.max(1, Math.round(stretch ? maxWidth : crop.w * scale));
  const height = Math.max(1, Math.round(stretch ? maxHeight : crop.h * scale));
  const left = Math.round(centerX - width / 2);
  const top = Math.round(centerY - height / 2);
  if (left < 0 || top < 0 || left + width > THUMBNAIL_SIZE || top + height > THUMBNAIL_SIZE) {
    throw new Error(`Thumbnail sprite composition would be cropped at ${left},${top},${width},${height}`);
  }
  for (let targetY = 0; targetY < height; targetY += 1) {
    const sourceY = Math.max(crop.y, Math.min(crop.y + crop.h - 1, crop.y + (stretch ? ((targetY + 0.5) / height) * crop.h : (targetY + 0.5) / scale) - 0.5));
    for (let targetX = 0; targetX < width; targetX += 1) {
      const sourceX = Math.max(
        crop.x,
        Math.min(crop.x + crop.w - 1, crop.x + (stretch ? ((targetX + 0.5) / width) * crop.w : (targetX + 0.5) / scale) - 0.5),
      );
      blend(canvas, left + targetX, top + targetY, sampleBilinear(texture, sourceX, sourceY));
    }
  }
}

function pngCrc32(buffer: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  typeBytes.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(pngCrc32(Buffer.concat([typeBytes, data])), 8 + data.length);
  return chunk;
}

function encodeThumbnail(source: DecodedRgbaPng, pixels: Buffer): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(THUMBNAIL_SIZE, 0);
  ihdr.writeUInt32BE(THUMBNAIL_SIZE, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const iend = source.chunks.find((chunk) => chunk.type === "IEND");
  if (!iend) throw new Error("Source PNG contains no IEND chunk");
  const chunks: PngChunk[] = [
    { type: "IHDR", bytes: pngChunk("IHDR", ihdr) },
    { type: "IEND", bytes: iend.bytes },
  ];
  return encodeRgba8Png({ signature: source.signature, chunks, width: THUMBNAIL_SIZE, height: THUMBNAIL_SIZE, pixels });
}

function writeThumbnail(path: string, source: DecodedRgbaPng, pixels: Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, encodeThumbnail(source, pixels));
}

/** Fit an image into a square Sonolus thumbnail without stretching or cropping. */
export function buildSquareThumbnail(input: Buffer, sourceName: string): Buffer {
  const texture = decodeRgba8Png(input, sourceName);
  assertTextureBudget(texture, sourceName);
  const canvas = createCanvas();
  drawFittedCrop(
    canvas, texture, { x: 0, y: 0, w: texture.width, h: texture.height },
    THUMBNAIL_SIZE / 2, THUMBNAIL_SIZE / 2, THUMBNAIL_SIZE, THUMBNAIL_SIZE,
    false, false,
  );
  return encodeThumbnail(texture, canvas);
}

function spriteByName(data: SkinData, name: string, sourceName: string): SkinSprite {
  const sprite = data.sprites.find((candidate) => candidate.name === name);
  if (!sprite) throw new Error(`${sourceName} is missing published sprite ${name}`);
  return sprite;
}

function renderSkinThumbnail(data: SkinData, texture: DecodedRgbaPng, sourceName: string): Buffer {
  if (data.width !== texture.width || data.height !== texture.height) {
    throw new Error(`${sourceName} skin.data dimensions do not match its texture`);
  }
  for (const sprite of data.sprites) assertRect(sprite, texture.width, texture.height, `${sourceName} ${sprite.name}`);
  const canvas = createCanvas();
  for (const [index, color] of ["Cyan", "Green", "Red"].entries()) {
    const left = spriteByName(data, `Our Notes Note ${color} Left`, sourceName);
    const middle = spriteByName(data, `Our Notes Note ${color} Middle`, sourceName);
    const right = spriteByName(data, `Our Notes Note ${color} Right`, sourceName);
    const height = 70;
    const scale = height / Math.max(left.h, middle.h, right.h);
    const leftWidth = Math.round(left.w * scale);
    const rightWidth = Math.round(right.w * scale);
    const bodyWidth = 360;
    const middleWidth = bodyWidth - leftWidth - rightWidth;
    const row = 106 + index * 154;
    drawFittedCrop(canvas, texture, left, 76 + leftWidth / 2, row, leftWidth, height, true, false);
    drawFittedCrop(canvas, texture, middle, 76 + leftWidth + middleWidth / 2, row, middleWidth, height, true, false);
    drawFittedCrop(canvas, texture, right, 436 - rightWidth / 2, row, rightWidth, height, true, false);
  }
  const marker = spriteByName(data, "Our Notes Flick Arrow Red Up 2", sourceName);
  drawFittedCrop(canvas, texture, marker, 256, 345, 100, 80);
  return canvas;
}

function expressionValue(expression: Record<string, number> | undefined): number {
  if (!expression) return 0;
  let value = expression.c ?? 0;
  for (let index = 1; index <= RANDOM_DRAWS.length; index += 1)
    value += (expression[`r${index}`] ?? 0) * RANDOM_DRAWS[index - 1]!;
  return value;
}

function channelValue(channel: ChannelExpression, progress: number): number {
  const easeName = (channel.ease ?? "linear") as EaseName;
  const amount = ease(easeName, Math.max(0, Math.min(1, progress)));
  const from = expressionValue(channel.from);
  const to = expressionValue(channel.to ?? channel.from);
  return from + (to - from) * amount;
}

function parseColor(color: string): RgbaSample {
  const hex = color.startsWith("#") ? color.slice(1) : color;
  const expanded = hex.length === 3 || hex.length === 4 ? [...hex].map((digit) => `${digit}${digit}`).join("") : hex;
  if (!/^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(expanded)) throw new Error(`Invalid particle color ${color}`);
  return {
    red: Number.parseInt(expanded.slice(0, 2), 16),
    green: Number.parseInt(expanded.slice(2, 4), 16),
    blue: Number.parseInt(expanded.slice(4, 6), 16),
    alpha: expanded.length === 8 ? Number.parseInt(expanded.slice(6, 8), 16) : 255,
  };
}

function collectParticleDraws(data: ParticleData, texture: DecodedRgbaPng): ParticleDraw[] {
  if (data.width !== texture.width || data.height !== texture.height) {
    throw new Error("particle.data dimensions do not match particle.texture.png");
  }
  data.sprites.forEach((sprite, index) =>
    assertRect(sprite, texture.width, texture.height, `particle sprite ${index}`),
  );
  const effects = PARTICLE_LAYERS.map((name) => {
    const effect = data.effects.find((candidate) => candidate.name === name);
    if (!effect) throw new Error(`particle.data is missing representative effect ${name}`);
    return effect;
  });
  const draws: ParticleDraw[] = [];
  for (const effect of effects) {
    for (const group of effect.groups) {
      for (const particle of group.particles) {
        if (PARTICLE_SNAPSHOT_TIME < particle.start || PARTICLE_SNAPSHOT_TIME > particle.start + particle.duration)
          continue;
        const progress = particle.duration <= 0 ? 1 : (PARTICLE_SNAPSHOT_TIME - particle.start) / particle.duration;
        const alpha = Math.max(0, Math.min(1, channelValue(particle.a, progress)));
        const width = channelValue(particle.w, progress);
        const height = channelValue(particle.h, progress);
        if (alpha <= 0.002 || Math.abs(width) <= 1e-5 || Math.abs(height) <= 1e-5) continue;
        const sprite = data.sprites[particle.sprite];
        if (!sprite) throw new Error(`${effect.name} references missing particle sprite ${particle.sprite}`);
        draws.push({
          sprite,
          x: channelValue(particle.x, progress),
          y: channelValue(particle.y, progress),
          w: width,
          h: height,
          rotation: channelValue(particle.r, progress),
          alpha,
          color: parseColor(particle.color),
        });
      }
    }
  }
  if (!draws.length)
    throw new Error(`Representative particle effects have no visible particles at t=${PARTICLE_SNAPSHOT_TIME}`);
  return draws;
}

function renderParticleThumbnail(data: ParticleData, texture: DecodedRgbaPng): Buffer {
  const draws = collectParticleDraws(data, texture);
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const draw of draws) {
    const cosine = Math.abs(Math.cos(draw.rotation));
    const sine = Math.abs(Math.sin(draw.rotation));
    const halfWidth = cosine * Math.abs(draw.w) + sine * Math.abs(draw.h);
    const halfHeight = sine * Math.abs(draw.w) + cosine * Math.abs(draw.h);
    minX = Math.min(minX, draw.x - halfWidth);
    maxX = Math.max(maxX, draw.x + halfWidth);
    minY = Math.min(minY, draw.y - halfHeight);
    maxY = Math.max(maxY, draw.y + halfHeight);
  }
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  const scale = Math.min(
    (THUMBNAIL_SIZE - 56) / Math.max(1e-6, maxX - minX),
    (THUMBNAIL_SIZE - 56) / Math.max(1e-6, maxY - minY),
  );
  const canvas = createCanvas();

  for (const draw of draws) {
    const pixelCenterX = THUMBNAIL_SIZE / 2 + (draw.x - centerX) * scale;
    const pixelCenterY = THUMBNAIL_SIZE / 2 - (draw.y - centerY) * scale;
    const halfWidth = Math.abs(draw.w) * scale;
    const halfHeight = Math.abs(draw.h) * scale;
    const cosine = Math.cos(draw.rotation);
    const sine = Math.sin(draw.rotation);
    const extentX = Math.abs(cosine) * halfWidth + Math.abs(sine) * halfHeight;
    const extentY = Math.abs(sine) * halfWidth + Math.abs(cosine) * halfHeight;
    const left = Math.max(0, Math.floor(pixelCenterX - extentX - 1));
    const right = Math.min(THUMBNAIL_SIZE - 1, Math.ceil(pixelCenterX + extentX + 1));
    const top = Math.max(0, Math.floor(pixelCenterY - extentY - 1));
    const bottom = Math.min(THUMBNAIL_SIZE - 1, Math.ceil(pixelCenterY + extentY + 1));
    const source = draw.sprite;
    for (let targetY = top; targetY <= bottom; targetY += 1) {
      for (let targetX = left; targetX <= right; targetX += 1) {
        const dx = (targetX + 0.5 - pixelCenterX) / scale;
        const dy = -(targetY + 0.5 - pixelCenterY) / scale;
        const localX = Math.cos(draw.rotation) * dx + Math.sin(draw.rotation) * dy;
        const localY = -Math.sin(draw.rotation) * dx + Math.cos(draw.rotation) * dy;
        if (Math.abs(localX) > Math.abs(draw.w) || Math.abs(localY) > Math.abs(draw.h)) continue;
        let u = localX / (2 * Math.abs(draw.w)) + 0.5;
        let v = 0.5 - localY / (2 * Math.abs(draw.h));
        if (draw.w < 0) u = 1 - u;
        if (draw.h < 0) v = 1 - v;
        const sample = sampleBilinear(
          texture,
          source.x + Math.max(0, Math.min(1, u)) * (source.w - 1),
          source.y + Math.max(0, Math.min(1, v)) * (source.h - 1),
        );
        const tinted = {
          red: (sample.red * draw.color.red) / 255,
          green: (sample.green * draw.color.green) / 255,
          blue: (sample.blue * draw.color.blue) / 255,
          alpha: (sample.alpha * draw.color.alpha) / 255,
        };
        blend(canvas, targetX, targetY, tinted, draw.alpha);
      }
    }
  }
  return canvas;
}

export function buildPresentationThumbnails(resourceRoot: string): PresentationThumbnailPaths {
  const skins: Record<SkinId, string> = {
    skin001: resolve(resourceRoot, "skins", "skin001", "thumbnail.png"),
    skin002: resolve(resourceRoot, "skins", "skin002", "thumbnail.png"),
    skin003: resolve(resourceRoot, "skins", "skin003", "thumbnail.png"),
  };
  for (const skinId of SKIN_IDS) {
    const skinDir = resolve(resourceRoot, "skins", skinId);
    const dataPath = resolve(skinDir, "skin.data");
    const texturePath = resolve(skinDir, "skin.texture.png");
    const texture = decodeRgba8Png(readFileSync(texturePath), `${skinId} skin.texture.png`);
    assertTextureBudget(texture, `${skinId} skin.texture.png`);
    writeThumbnail(skins[skinId], texture, renderSkinThumbnail(readGzipJson<SkinData>(dataPath), texture, skinId));
  }

  const particleTexture = decodeRgba8Png(
    readFileSync(resolve(resourceRoot, "particle.texture.png")),
    "particle.texture.png",
  );
  assertTextureBudget(particleTexture, "particle.texture.png");
  const particlePath = resolve(resourceRoot, "particle.thumbnail.png");
  writeThumbnail(
    particlePath,
    particleTexture,
    renderParticleThumbnail(readGzipJson<ParticleData>(resolve(resourceRoot, "particle.data")), particleTexture),
  );
  return { skins, particle: particlePath };
}
