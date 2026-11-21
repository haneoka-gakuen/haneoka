// L3 — GEB
// Input: Final image dimensions and a painter for a vertical span of the image.
// Output: One lossless PNG, including images taller than the browser canvas limit.
// Pos: [Map](L2-2.md); shared long image export.
// Effects/Dependencies: Uses a bounded canvas and streams scanlines through the PNG compressor.
import { Zlib } from "fflate";

const canvasBudget = 12_000_000;
const crcTable = Uint32Array.from({ length: 256 }, (_, byte) => {
  let crc = byte;
  for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  return crc;
});

function chunk(kind: string, data: Uint8Array) {
  const bytes = new Uint8Array(data.length + 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, data.length);
  for (let index = 0; index < 4; index++) bytes[index + 4] = kind.charCodeAt(index);
  bytes.set(data, 8);
  let crc = 0xffffffff;
  for (let index = 4; index < bytes.length - 4; index++) crc = (crc >>> 8) ^ crcTable[(crc ^ bytes[index]!) & 255]!;
  view.setUint32(bytes.length - 4, crc ^ 0xffffffff);
  return bytes;
}

export async function drawLongPng(
  width: number,
  height: number,
  paint: (context: CanvasRenderingContext2D, top: number, bottom: number) => void,
  signal?: AbortSignal,
): Promise<Blob> {
  signal?.throwIfAborted();
  const canvas = document.createElement("canvas");
  canvas.width = width;
  if (height <= 12_000 && width * height <= canvasBudget) {
    canvas.height = height;
    const context = canvas.getContext("2d")!;
    paint(context, 0, height);
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/png"));
    canvas.width = canvas.height = 1;
    signal?.throwIfAborted();
    if (blob) return blob;
  }

  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = 8;
  header[9] = 6;
  const pieces: BlobPart[] = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header)];
  const compressor = new Zlib({ level: 3 }, data => { if (data.length) pieces.push(chunk("IDAT", data)); });
  const stride = width * 4;
  const step = Math.max(1, Math.min(512, Math.floor(1_000_000 / width)));
  canvas.width = width;
  try {
    for (let top = 0; top < height; top += step) {
      signal?.throwIfAborted();
      const rows = Math.min(step, height - top);
      canvas.height = rows;
      const context = canvas.getContext("2d", { willReadFrequently: true })!;
      context.translate(0, -top);
      paint(context, top, top + rows);
      const rgba = context.getImageData(0, 0, width, rows).data;
      const scanlines = new Uint8Array((stride + 1) * rows);
      for (let row = 0; row < rows; row++) {
        const src = row * stride, dst = row * (stride + 1);
        scanlines[dst] = 1;
        scanlines.set(rgba.subarray(src, src + 4), dst + 1);
        for (let byte = 4; byte < stride; byte++)
          scanlines[dst + byte + 1] = rgba[src + byte]! - rgba[src + byte - 4]!;
      }
      compressor.push(scanlines, top + rows === height);
      if (top + rows < height) await new Promise(resolve => setTimeout(resolve, 0));
    }
  } finally {
    canvas.width = canvas.height = 1;
  }
  signal?.throwIfAborted();
  pieces.push(chunk("IEND", new Uint8Array()));
  return new Blob(pieces, { type: "image/png" });
}
