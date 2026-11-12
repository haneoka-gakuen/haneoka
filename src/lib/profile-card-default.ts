import type { Locale } from "../i18n/locales";

const suffix: Record<Locale, string> = {
  ja: "",
  en: "(en)",
  ko: "(ko)",
  "zh-CN": "(zh-Hans)",
  "zh-TW": "(zh-Hant)",
};

export function defaultProfileCardUrl(locale: Locale, releaseId?: string): string {
  const name = `img_PFC2_mini${suffix[locale]}.png`;
  return `/assets/intl/Assets/AddressableResources/UI/Texture/Tmp1/${encodeURIComponent(name)}?asset=1${releaseId ? `&release=${encodeURIComponent(releaseId)}` : ""}`;
}
