// L3 — GEB
// Input: 画布、背景、文字／图片图层与输出尺寸。
// Output: 与网页相同的贴图画布。
// Pos: [Map](../L2-2.md)；贴图制作器的公开设备接口。
// Effects/Dependencies: Canvas 与字体装载；不提交社区内容。
import { siteOrigin } from "../site-origin";
import { loadStampFont as loadFont, type StampText } from "../stamp-maker/render";
export { drawStamp, defaultStampText } from "../stamp-maker/render";
export type { StampBackground, StampText } from "../stamp-maker/render";
export { createStampLayer, createStampImageLayer, copyStampText } from "../stamp-maker/layers";
export type { StampLayer } from "../stamp-maker/layers";
export { stampOutputSize, STAMP_CANVAS_SIZE } from "../stamp-maker/sizes";
export function loadStampFont(text: StampText, fallback: string, assetsBase = `${siteOrigin()}/`) {
  return loadFont(text, fallback, assetsBase);
}
