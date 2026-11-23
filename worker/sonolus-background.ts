// L3 — GEB
// Input: Pinned lightweight stage and song jacket PNGs.
// Output: One compressed background using the same authored composite as Web.
// Pos: [Map](L2.md); Sonolus catalog background image adapter.
// Effects/Dependencies: Uses the shared Our Notes compositor and a bounded PNG encoder.
import { OUR_NOTES_LIGHTWEIGHT_BACKGROUND, buildOurNotesLightweightBackground } from "@haneoka/cassiopeia-plugin-our-notes";
import { convertIndexedToRgb, decode, encode } from "fast-png";

export const sonolusSongBackgroundAspect =
  OUR_NOTES_LIGHTWEIGHT_BACKGROUND.width / OUR_NOTES_LIGHTWEIGHT_BACKGROUND.height;
export const sonolusSongBackgroundVersion = 2;
export const sonolusSongBackgroundPath = /^\/sonolus\/backgrounds\/(haneoka-jacket-(jp|intl)-(r-[a-f0-9]{20})-([1-9]\d{0,15}))(?:\/(image|data|configuration))?$/u;

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

export function composeSonolusSongBackground(stage: Uint8Array, jacket: Uint8Array): Uint8Array {
  const frame = buildOurNotesLightweightBackground({ stage: decodeBackground(stage), jacket: decodeBackground(jacket) });
  const width = frame.width / 2, height = frame.height / 2;
  const data = new Uint8Array(width * height * 3);
  const stride = frame.width * 4;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const top = 2 * y * stride + 8 * x;
      const output = (y * width + x) * 3;
      for (let channel = 0; channel < 3; channel++)
        data[output + channel] = Math.round((
          frame.rgba[top + channel]! + frame.rgba[top + 4 + channel]! +
          frame.rgba[top + stride + channel]! + frame.rgba[top + stride + 4 + channel]!
        ) / 4);
    }
  }
  return encode({ width, height, channels: 3, data });
}
