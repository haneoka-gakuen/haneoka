// L3 — GEB
// Input: SVG 文本与预编译 Resvg WASM。
// Output: 共享 WASM 初始化和有尺寸限制的静态图片。
// Pos: [Map](L2.md)；谱面图片和故事素材检查共用的 SVG 栅格化。
// Effects/Dependencies: 仅执行 WASM，不读取外部图片或网络。
import { initWasm, Resvg } from "@resvg/resvg-wasm";
import wasm from "@resvg/resvg-wasm/index_bg.wasm";
export { Resvg };
export const svgWasmReady = initWasm(wasm);

export async function rasterizeSvgPreview(svg: string): Promise<Uint8Array> {
  await svgWasmReady;
  const probe = new Resvg(svg);
  let scale: number;
  try {
    if (probe.imagesToResolve().length) throw new Error("svg_external_images");
    scale = 1024 / Math.max(probe.width, probe.height);
    if (!Number.isFinite(scale) || scale <= 0) throw new Error("svg_dimensions");
  } finally {
    probe.free();
  }
  const renderer = new Resvg(svg, { fitTo: { mode: "zoom", value: Math.min(1, scale) } });
  try {
    const image = renderer.render();
    try {
      return new Uint8Array(image.asPng());
    } finally {
      image.free();
    }
  } finally {
    renderer.free();
  }
}
