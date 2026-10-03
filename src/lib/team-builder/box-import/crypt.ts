import Rijndael from "./vendor/rijndael.js";
import tables from "./vendor/rijndael-precalculated.js";
import { BoxImportError } from "./types";
const hex = (s: string) => Uint8Array.from(s.match(/../g)!, (v) => parseInt(v, 16));
// Public local-save format constants from the supplied extractor, not account credentials.
const HEADER = hex("b50b23a5fd628c3dc386f7488f81d6b0450b8c89671574f55a3ad815f10b8e30");
const KEY = hex("0532791c510a08eb7ede6b46c6ba71ea9aa2a3cfb678a595f89d67c8a5e493b6");
export const isEncryptedBox = (data: Uint8Array) => data.length >= 96 && HEADER.every((v, i) => data[i] === v);
export async function decryptBox(data: Uint8Array, signal?: AbortSignal): Promise<Uint8Array> {
  if (!isEncryptedBox(data) || (data.length - 64) % 32) throw new BoxImportError("box_invalid_encryption");
  const cipher = new Rijndael(KEY),
    expanded = cipher.ExpandKey(32),
    inverse = new Uint8Array(256);
  tables.SBOX.forEach((v, i) => (inverse[v] = i));
  const reverse = tables.ROW_SHIFT[32]!.map((_, i) => tables.ROW_SHIFT[32]!.indexOf(i));
  // Cache the public round schedule and inverse lookup. The audited vendor rounds stay unchanged.
  cipher.ExpandKey = () => expanded;
  cipher.SubBytesReversed = (block) => {
    for (let i = 0; i < block.length; i++) block[i] = inverse[block[i]!]!;
  };
  cipher.ShiftRowsReversed = (block) => {
    const copy = block.slice();
    for (let i = 0; i < block.length; i++) block[i] = copy[reverse[i]!]!;
  };
  const output = new Uint8Array(data.length - 64);
  let previous = data.subarray(32, 64);
  try {
    for (let offset = 64; offset < data.length; offset += 32) {
      if ((offset - 64) % 8192 === 0) {
        signal?.throwIfAborted();
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        signal?.throwIfAborted();
      }
      const decrypted = cipher.decrypt(data.subarray(offset, offset + 32));
      for (let i = 0; i < 32; i++) output[offset - 64 + i] = decrypted[i]! ^ previous[i]!;
      previous = data.subarray(offset, offset + 32);
    }
    const padding = output[output.length - 1]!;
    if (padding < 1 || padding > 32 || !output.subarray(output.length - padding).every((v) => v === padding))
      throw new BoxImportError("box_invalid_padding");
    return output.slice(0, -padding);
  } finally {
    output.fill(0);
    expanded.fill(0);
  }
}
