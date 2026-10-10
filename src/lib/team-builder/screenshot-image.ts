/** Local, bounded preprocessing. The returned bytes are also used for OCR crops. */
export interface ScreenshotCrop {
  top: number;
  right: number;
  bottom: number;
  left: number;
}
export const FULL_SCREENSHOT: ScreenshotCrop = { top: 0, right: 0, bottom: 0, left: 0 };
export const IMAGE_LIMITS = { bytes: 8 * 1024 * 1024, pixels: 16_000_000, side: 4096 } as const;
export function screenshotHeader(bytes: Uint8Array): { type: string; width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (from: number, length: number) => String.fromCharCode(...bytes.subarray(from, from + length));
  let width = 0,
    height = 0,
    type = "";
  if (bytes.length >= 24 && bytes[0] === 137 && ascii(1, 3) === "PNG" && ascii(12, 4) === "IHDR") {
    type = "image/png";
    width = view.getUint32(16);
    height = view.getUint32(20);
  } else if (bytes.length >= 12 && ascii(4, 4) === "ftyp") {
    throw new RangeError("image-heic");
  } else if (bytes[0] === 255 && bytes[1] === 216) {
    type = "image/jpeg";
    for (let offset = 2; offset + 8 < bytes.length;) {
      if (bytes[offset] !== 255) break;
      const marker = bytes[offset + 1]!;
      if (marker === 255) {
        offset++;
        continue;
      }
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
        offset += 2;
        continue;
      }
      const length = view.getUint16(offset + 2);
      if (length < 2 || offset + length + 2 > bytes.length) break;
      if ([0xc0, 0xc1, 0xc2].includes(marker)) {
        height = view.getUint16(offset + 5);
        width = view.getUint16(offset + 7);
        break;
      }
      offset += length + 2;
    }
  } else if (bytes.length >= 30 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") {
    type = "image/webp";
    if (ascii(12, 4) === "VP8X") {
      width = 1 + bytes[24]! + (bytes[25]! << 8) + (bytes[26]! << 16);
      height = 1 + bytes[27]! + (bytes[28]! << 8) + (bytes[29]! << 16);
    } else if (ascii(12, 4) === "VP8 " && bytes[23] === 0x9d && bytes[24] === 1 && bytes[25] === 0x2a) {
      width = view.getUint16(26, true) & 0x3fff;
      height = view.getUint16(28, true) & 0x3fff;
    } else if (ascii(12, 4) === "VP8L" && bytes[20] === 0x2f) {
      const bits = view.getUint32(21, true);
      width = (bits & 0x3fff) + 1;
      height = ((bits >>> 14) & 0x3fff) + 1;
    }
  }
  if (!width || !height || !type) throw new RangeError("image-format");
  if (width > 8192 || height > 8192 || width * height > IMAGE_LIMITS.pixels) throw new RangeError("image-budget");
  return { type, width, height };
}
export function cropPixels(width: number, height: number, crop: ScreenshotCrop) {
  if (
    Object.values(crop).some((value) => !Number.isFinite(value) || value < 0 || value > 95) ||
    crop.left + crop.right >= 100 ||
    crop.top + crop.bottom >= 100
  )
    throw new RangeError("image-crop");
  const x = Math.floor((width * crop.left) / 100),
    y = Math.floor((height * crop.top) / 100);
  const w = width - x - Math.floor((width * crop.right) / 100),
    h = height - y - Math.floor((height * crop.bottom) / 100);
  if (w < 128 || h < 128) throw new RangeError("image-crop");
  return { x, y, width: w, height: h };
}
export async function prepareScreenshot(file: Blob, crop: ScreenshotCrop, signal: AbortSignal): Promise<Blob> {
  signal.throwIfAborted();
  if (!file.size || file.size > IMAGE_LIMITS.bytes) throw new RangeError("image-budget");
  const bytes = new Uint8Array(await file.arrayBuffer());
  let image: ImageBitmap;
  try {
    signal.throwIfAborted();
    const header = screenshotHeader(bytes);
    image = await createImageBitmap(new Blob([bytes], { type: header.type }), { imageOrientation: "from-image" });
  } finally {
    bytes.fill(0);
  }
  try {
    signal.throwIfAborted();
    if (image.width * image.height > IMAGE_LIMITS.pixels) throw new RangeError("image-budget");
    const rect = cropPixels(image.width, image.height, crop);
    // Recognition's deployed result contract allows at most eight million pixels.
    const scale = Math.min(
      1,
      IMAGE_LIMITS.side / Math.max(rect.width, rect.height),
      Math.sqrt(8_000_000 / (rect.width * rect.height)),
    );
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(rect.width * scale);
    canvas.height = Math.round(rect.height * scale);
    if (canvas.width < 128 || canvas.height < 128) throw new RangeError("image-crop");
    try {
      const context = canvas.getContext("2d", { alpha: false, colorSpace: "srgb" });
      if (!context) throw new RangeError("image-format");
      context.drawImage(image, rect.x, rect.y, rect.width, rect.height, 0, 0, canvas.width, canvas.height);
      const encode = (type: string) =>
        new Promise<Blob>((resolve, reject) =>
          canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new RangeError("image-format"))), type, 0.92),
        );
      let result = await encode("image/png");
      if (result.size > IMAGE_LIMITS.bytes) result = await encode("image/jpeg");
      if (result.size > IMAGE_LIMITS.bytes) throw new RangeError("image-budget");
      signal.throwIfAborted();
      return result;
    } finally {
      canvas.width = 1;
      canvas.height = 1;
    }
  } finally {
    image.close();
  }
}
