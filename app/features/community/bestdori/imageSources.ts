import { archiveLocaleFallbacks, type ArchiveLocale } from "~/i18n/locales";

const LOCALE_TO_SERVER: Record<ArchiveLocale, string> = {
  ja: "jp",
  en: "en",
  "zh-TW": "tw",
  "zh-CN": "cn",
  ko: "kr",
};

const SERVER_SEGMENT = /\/assets\/(?:jp|en|tw|cn|kr)\//;
const PROXIED_SERVER_SEGMENTS = /(\/bestdori\/)(?:jp|en|tw|cn|kr)(\/raw\/assets\/)(?:jp|en|tw|cn|kr)(\/)/;

export const bestdoriImageSources = (
  proxiedUrl: string | null | undefined,
  locale: ArchiveLocale,
): readonly string[] => {
  if (!proxiedUrl || !SERVER_SEGMENT.test(proxiedUrl)) return proxiedUrl ? [proxiedUrl] : [];
  const order = archiveLocaleFallbacks(locale).map((candidate) => LOCALE_TO_SERVER[candidate]);
  const proxiedAsset = PROXIED_SERVER_SEGMENTS.test(proxiedUrl);
  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const server of order) {
    const candidate = proxiedAsset
      ? proxiedUrl.replace(
          PROXIED_SERVER_SEGMENTS,
          (_match, prefix: string, rawAssets: string, suffix: string) =>
            `${prefix}${server}${rawAssets}${server}${suffix}`,
        )
      : proxiedUrl.replace(SERVER_SEGMENT, `/assets/${server}/`);
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    candidates.push(candidate);
  }
  if (!proxiedAsset && !seen.has(proxiedUrl)) candidates.push(proxiedUrl);
  return candidates;
};

export const useBestdoriImageSources = (): ((url: string | null | undefined) => readonly string[]) => {
  const { locale } = useLocale();
  return (url) => bestdoriImageSources(url, locale.value);
};
