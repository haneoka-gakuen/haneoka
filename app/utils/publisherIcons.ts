import { svg as bilibiliMarkSvg } from "@thesvg/icons/bilibili";
import bushimoCircleSvg from "~/assets/icons/bushimo-circle.svg?raw";
import { inlineSvgDataUrl } from "~/utils/inlineSvg";

const bilibiliMark = bilibiliMarkSvg
  .replace(/^<svg[^>]*>/, "")
  .replace(/<title>.*?<\/title>/, "")
  .replace(/<\/svg>$/, "");

export const bilibiliCircleSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><circle cx="256" cy="256" r="256" fill="#00a1d6"/><g fill="#fff" transform="translate(76 76) scale(15)">${bilibiliMark}</g></svg>`;

export const publisherIconUrls = {
  bilibili: inlineSvgDataUrl(bilibiliCircleSvg),
  bushimo: inlineSvgDataUrl(bushimoCircleSvg),
} as const;
