import { Resvg, svgWasmReady as ready } from "./svg-rasterizer";

const FONT_ROOT = "https://haneoka.org/chart-image-fonts/";
const MAX_FONT_BYTES = 4 * 1024 * 1024;
interface FontSubset {
  family: string;
  path: string;
  bytes: number;
  ranges: number[][];
}

async function boundedAsset(assets: Pick<Fetcher, "fetch">, path: string, limit: number): Promise<Uint8Array> {
  const response = await assets.fetch(new Request(FONT_ROOT + path));
  if (!response.ok || !response.body) throw new Error("Chart image font asset unavailable");
  const declared = Number(response.headers.get("content-length"));
  if (declared > limit) throw new RangeError("Chart image font budget exceeded");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new RangeError("Chart image font budget exceeded");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

/** Uses only the precompiled WASM module and same-deployment Fontsource assets. */
export async function rasterizeChartSvg(
  svg: string,
  width: number,
  height: number,
  assets: Pick<Fetcher, "fetch">,
): Promise<Uint8Array> {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    width * height > 12_000_000
  )
    throw new RangeError("Chart image pixel budget exceeded");
  await ready;
  const manifest: unknown = JSON.parse(
    new TextDecoder().decode(await boundedAsset(assets, "manifest.json", 1024 * 1024)),
  );
  if (!manifest || typeof manifest !== "object" || !("fonts" in manifest) || !Array.isArray(manifest.fonts))
    throw new Error("Chart image font manifest invalid");
  const fonts: FontSubset[] = [];
  for (const value of manifest.fonts) {
    if (
      !value ||
      typeof value !== "object" ||
      typeof value.family !== "string" ||
      typeof value.path !== "string" ||
      !/^[a-f0-9]{64}\.woff2$/u.test(value.path) ||
      !Number.isSafeInteger(value.bytes) ||
      value.bytes <= 0 ||
      value.bytes > MAX_FONT_BYTES ||
      !Array.isArray(value.ranges) ||
      !value.ranges.every(
        (range: unknown) =>
          Array.isArray(range) && range.length === 2 && range.every((point: unknown) => Number.isSafeInteger(point)),
      )
    )
      throw new Error("Chart image font manifest invalid");
    fonts.push(value);
  }
  const sample = [...svg.matchAll(/<text\b[^>]*>([^<]*)<\/text>/gu)]
    .map((match) => match[1] || "")
    .join("")
    .replace(
      /&(?:amp|lt|gt|quot|apos);/gu,
      (entity) => ({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'" })[entity] || entity,
    );
  const needed = new Set(Array.from(sample, (glyph) => glyph.codePointAt(0)!));
  const locale = /\blang="([^"]+)"/u.exec(svg)?.[1];
  const preferred =
    locale === "ko"
      ? "noto-sans-kr"
      : locale === "zh-CN"
        ? "noto-sans-sc"
        : locale === "zh-TW"
          ? "noto-sans-tc"
          : "noto-sans-jp";
  const order = ["roboto", preferred, "noto-sans", "noto-sans-jp", "noto-sans-tc", "noto-sans-sc", "noto-sans-kr"];
  fonts.sort((a, b) => order.indexOf(a.family) - order.indexOf(b.family));
  const selected: FontSubset[] = [];
  for (const font of fonts) {
    const covered = [...needed].filter((point) =>
      font.ranges.some(([start = 0, end = 0]) => point >= start && point <= end),
    );
    if (!covered.length) continue;
    selected.push(font);
    for (const point of covered) needed.delete(point);
    if (!needed.size) break;
  }
  if (!selected.length) throw new Error("Chart image fonts unavailable");
  if (selected.length > 64 || selected.reduce((total, font) => total + font.bytes, 0) > MAX_FONT_BYTES)
    throw new RangeError("Chart image font budget exceeded");
  const fontBuffers: Uint8Array[] = [];
  for (const font of selected) {
    const bytes = await boundedAsset(assets, font.path, font.bytes);
    if (bytes.length !== font.bytes) throw new Error("Chart image font size invalid");
    fontBuffers.push(bytes);
  }
  const renderer = new Resvg(
    svg.replace(
      /font-family:([^;}]+);/gu,
      (_match, families: string) => `font-family:${families.replaceAll(" Variable", "")};`,
    ),
    { font: { fontBuffers, defaultFontFamily: "Roboto" } },
  );
  try {
    const image = renderer.render();
    try {
      if (image.width !== width || image.height !== height) throw new Error("Chart image raster dimensions invalid");
      return new Uint8Array(image.asPng());
    } finally {
      image.free();
    }
  } finally {
    renderer.free();
  }
}
