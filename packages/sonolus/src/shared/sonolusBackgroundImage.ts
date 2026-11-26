// L3 — GEB
// Input: Released band stage, song jacket or Snapshot illustration.
// Output: Compact Sonolus PNGs for the lightweight background choices.
// Pos: [Map](../../L2-2.md); image preparation for the Worker and standalone server.
// Effects/Dependencies: Uses the shared game compositor for jacket backgrounds.
import {
  OUR_NOTES_LIGHTWEIGHT_BACKGROUND,
  buildOurNotesLightweightBackground,
} from "@haneoka/cassiopeia-plugin-our-notes";
import { convertIndexedToRgb, decode, encode } from "fast-png";

const { width: frameWidth, height: frameHeight } = OUR_NOTES_LIGHTWEIGHT_BACKGROUND;
// LightWeightBackgroundStageTrack ends at 1.20 in all six band timelines.
const gameplayScale = 1.2;
const width = Math.round(frameWidth / gameplayScale / 2);
const height = Math.round(frameHeight / gameplayScale / 2);

export const sonolusSongBackgroundAspect = frameWidth / frameHeight;

function decodeBackground(source: Uint8Array) {
  if (source.byteLength < 24) throw new Error("Invalid background PNG");
  const header = new DataView(source.buffer, source.byteOffset, source.byteLength);
  const width = header.getUint32(16), height = header.getUint32(20);
  if (!width || !height || width > 2048 || height > 2048) throw new Error("Unsupported background dimensions");
  const decoded = decode(source);
  const pixels = decoded.palette ? convertIndexedToRgb(decoded) : decoded.data;
  const channels = pixels.length / (width * height);
  if ((!decoded.palette && decoded.depth !== 8) || (channels !== 3 && channels !== 4))
    throw new Error("Unsupported background PNG colors");
  if (channels === 4 && pixels instanceof Uint8Array) return { width, height, rgba: pixels };
  const rgba = new Uint8Array(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel++) {
    const from = pixel * channels, to = pixel * 4;
    rgba[to] = pixels[from]!;
    rgba[to + 1] = pixels[from + 1]!;
    rgba[to + 2] = pixels[from + 2]!;
    rgba[to + 3] = channels === 4 ? pixels[from + 3]! : 255;
  }
  return { width, height, rgba };
}

function encodeSongFrame(frame: ReturnType<typeof buildOurNotesLightweightBackground>): Uint8Array {
  const left = (frame.width - width * 2) / 2;
  const top = (frame.height - height * 2) / 2;
  const data = new Uint8Array(width * height * 3);
  const stride = frame.width * 4;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const pixel = (top + 2 * y) * stride + (left + 2 * x) * 4;
      const output = (y * width + x) * 3;
      for (let channel = 0; channel < 3; channel++)
        data[output + channel] = Math.round((
          frame.rgba[pixel + channel]! + frame.rgba[pixel + 4 + channel]! +
          frame.rgba[pixel + stride + channel]! + frame.rgba[pixel + stride + 4 + channel]!
        ) / 4);
    }
  }
  return encode({ width, height, channels: 3, data });
}

export function composeSonolusSongBackground(stage: Uint8Array, jacket: Uint8Array): Uint8Array {
  return encodeSongFrame(buildOurNotesLightweightBackground({
    stage: decodeBackground(stage),
    jacket: decodeBackground(jacket),
  }));
}

export function buildSonolusSnapshotBackground(source: Uint8Array): Uint8Array {
  const image = decodeBackground(source);
  const width = Math.ceil(image.width / 2);
  const height = Math.ceil(image.height / 2);
  const data = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    const top = 2 * y * image.width;
    const bottom = Math.min(2 * y + 1, image.height - 1) * image.width;
    for (let x = 0; x < width; x++) {
      const left = 2 * x, right = Math.min(left + 1, image.width - 1);
      const a = (top + left) * 4, b = (top + right) * 4;
      const c = (bottom + left) * 4, d = (bottom + right) * 4;
      const output = (y * width + x) * 3;
      for (let channel = 0; channel < 3; channel++) {
        data[output + channel] = Math.round((
          image.rgba[a + channel]! * image.rgba[a + 3]! + image.rgba[b + channel]! * image.rgba[b + 3]! +
          image.rgba[c + channel]! * image.rgba[c + 3]! + image.rgba[d + channel]! * image.rgba[d + 3]!
        ) / (4 * 255));
      }
    }
  }
  return encode({ width, height, channels: 3, data });
}

export function buildSonolusBandBackground(stage: Uint8Array): Uint8Array {
  const image = decodeBackground(stage);
  const output = new Uint8Array(width * height * 4);
  const stepX = image.width / (gameplayScale * width), stepY = image.height / (gameplayScale * height);
  const left = (image.width - width * stepX) / 2, top = (image.height - height * stepY) / 2;
  for (let y = 0; y < height; y++) {
    const y0 = top + y * stepY, y1 = y0 + stepY;
    for (let x = 0; x < width; x++) {
      const x0 = left + x * stepX, x1 = x0 + stepX;
      let red = 0, green = 0, blue = 0, alpha = 0;
      for (let row = Math.floor(y0); row < y1; row++) {
        const rowWeight = Math.min(row + 1, y1) - Math.max(row, y0);
        for (let column = Math.floor(x0); column < x1; column++) {
          const weight = rowWeight * (Math.min(column + 1, x1) - Math.max(column, x0));
          const pixel = (row * image.width + column) * 4;
          const coverage = image.rgba[pixel + 3]! * weight;
          red += image.rgba[pixel]! * coverage;
          green += image.rgba[pixel + 1]! * coverage;
          blue += image.rgba[pixel + 2]! * coverage;
          alpha += coverage;
        }
      }
      const pixel = (y * width + x) * 4;
      if (alpha > 0) {
        output[pixel] = Math.round(red / alpha);
        output[pixel + 1] = Math.round(green / alpha);
        output[pixel + 2] = Math.round(blue / alpha);
        output[pixel + 3] = Math.round(alpha / (stepX * stepY));
      }
    }
  }
  return encode({ width, height, channels: 4, data: output });
}
