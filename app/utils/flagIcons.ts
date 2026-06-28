import chinaFlagSvg from "circle-flags/flags/cn.svg?raw";
import unitedKingdomFlagSvg from "circle-flags/flags/gb.svg?raw";
import hongKongFlagSvg from "circle-flags/flags/hk.svg?raw";
import japanFlagSvg from "circle-flags/flags/jp.svg?raw";
import southKoreaFlagSvg from "circle-flags/flags/kr.svg?raw";
import { inlineSvgDataUrl } from "~/utils/inlineSvg";

export const flagIconUrls = {
  cn: inlineSvgDataUrl(chinaFlagSvg),
  gb: inlineSvgDataUrl(unitedKingdomFlagSvg),
  hk: inlineSvgDataUrl(hongKongFlagSvg),
  jp: inlineSvgDataUrl(japanFlagSvg),
  kr: inlineSvgDataUrl(southKoreaFlagSvg),
} as const;

export const localeFlagIconUrls: Record<string, string> = {
  ja: flagIconUrls.jp,
  en: flagIconUrls.gb,
  "zh-TW": flagIconUrls.hk,
  "zh-CN": flagIconUrls.cn,
  ko: flagIconUrls.kr,
};
