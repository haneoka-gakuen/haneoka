// L3 — GEB
// Input: An own-game artwork URL and the requested image language.
// Output: Locale-tagged sibling candidates followed by the original artwork.
// Pos: [Map](L2-2.md); shared image-language selection for browsers and build metadata.
// Effects/Dependencies: Pure URL selection; performs no resource requests.
const LOCALE_IMAGE_TAGS: Record<string, readonly string[]> = {
  en: ["en"],
  "zh-TW": ["zh-Hant", "zh-Hans"],
  "zh-CN": ["zh-Hans", "zh-Hant"],
  ko: ["ko"],
};

export function localizedImageCandidates(source: string, locale: string): string[] {
  if (
    !source ||
    locale === "ja" ||
    !/^\/assets\/[^/]+\/(?:Assets|Packages)\//u.test(source) ||
    /\((?:en|ko|zh-Hans|zh-Hant)\)(?=\.[^./]+$)/u.test(source)
  )
    return [source];
  const tagged = (localeTag: string) => {
    const slash = source.lastIndexOf("/");
    const dot = source.lastIndexOf(".");
    return dot > slash ? `${source.slice(0, dot)}(${localeTag})${source.slice(dot)}` : `${source}(${localeTag})`;
  };
  return [...(LOCALE_IMAGE_TAGS[locale] || []).map(tagged), source];
}
