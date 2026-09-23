/**
 * Deferred artwork for collections.
 *
 * `tile()` renders its image as `data-src` rather than `src` so a grid of two
 * thousand thumbnails does not issue two thousand requests on first paint.
 * Something has to promote those to `src` once they approach the viewport,
 * and that something belongs with the tile: the loader used to live inside
 * catalog-screen, so every *other* screen that rendered a tile — stories, the
 * Live2D and Spine viewers — showed no artwork at all. The image sat there
 * with a `data-src` nobody read and `opacity: 0` waiting for a `load` event
 * that could never fire.
 *
 * Candidates, in order: any locale-tagged variants the caller supplies, then
 * the plain source, then the caller's `data-fallback`. `onError` walks that
 * list, so a missing Chinese banner falls back to the Japanese one and only
 * then gives up.
 */
/**
 * Locale-tagged artwork candidates.
 *
 * The pipeline writes a localized variant beside its original, as a tag
 * before the extension: `banner(zh-Hans).png` next to `banner.png`.
 * Simplified and traditional Chinese each accept the other as a second
 * choice, and every locale ends at the untagged Japanese original — so
 * artwork that has not been localized yet still appears rather than leaving
 * an empty frame. Three screens had their own copy of this; it belongs with
 * the loader that consumes it.
 */
const LOCALE_IMAGE_TAGS: Record<string, readonly string[]> = {
  en: ["en"],
  "zh-TW": ["zh-Hant", "zh-Hans"],
  "zh-CN": ["zh-Hans", "zh-Hant"],
  ko: ["ko"],
};

export function localeTaggedCandidates(source: string, locale: string): string[] {
  if (!source || locale === "ja") return [source];
  const tagged = (localeTag: string) => {
    const slash = source.lastIndexOf("/");
    const dot = source.lastIndexOf(".");
    return dot > slash ? `${source.slice(0, dot)}(${localeTag})${source.slice(dot)}` : `${source}(${localeTag})`;
  };
  return [...(LOCALE_IMAGE_TAGS[locale] || []).map(tagged), source];
}

export interface LazyImageOptions {
  /**
   * Extra sources to try before the plain one — localized artwork, usually.
   * Returning `[source]` (the default) means "no variants".
   */
  candidates?: (source: string) => readonly string[];
  /** How far ahead of the viewport to start loading. */
  rootMargin?: string;
}

export class LazyImages {
  private observer?: IntersectionObserver;
  private candidates: (source: string) => readonly string[];
  private rootMargin: string;

  constructor(options: LazyImageOptions = {}) {
    this.candidates = options.candidates ?? ((source) => [source]);
    this.rootMargin = options.rootMargin ?? "240px";
  }

  /** Call from `updated()`: picks up whatever the last render added. */
  observe(root: ParentNode) {
    const images = root.querySelectorAll<HTMLImageElement>("img[data-src]");
    if (!images.length) return;
    if (!("IntersectionObserver" in window)) {
      images.forEach((image) => this.load(image));
      return;
    }
    this.observer ??= new IntersectionObserver(
      (entries) => entries.forEach((entry) => entry.isIntersecting && this.load(entry.target as HTMLImageElement)),
      { rootMargin: this.rootMargin },
    );
    images.forEach((image) => this.observer?.observe(image));
  }

  /** Promotes one image immediately, whether or not it is on screen. */
  load(image: HTMLImageElement) {
    const source = image.dataset.src || "";
    const candidates = [...this.candidates(source), ...(image.dataset.fallback ? [image.dataset.fallback] : [])].filter(
      (value, index, values) => value && values.indexOf(value) === index,
    );
    image.classList.remove("is-loaded", "is-error");
    image.dataset.loading = "true";
    image.addEventListener(
      "load",
      () => {
        delete image.dataset.loading;
        image.classList.add("is-loaded");
      },
      { once: true },
    );
    image.dataset.candidates = JSON.stringify(candidates);
    image.dataset.candidateIndex = "0";
    image.src = candidates[0] || source;
    image.removeAttribute("data-src");
    this.observer?.unobserve(image);
  }

  disconnect() {
    this.observer?.disconnect();
    this.observer = undefined;
  }
}

/**
 * The `@error` handler for a lazily-loaded image: steps to the next candidate
 * and hides the element once they are all exhausted, so a broken source shows
 * the media box's own surface instead of a broken-image glyph.
 */
export function nextImageCandidate(event: Event) {
  const image = event.currentTarget as HTMLImageElement;
  const candidates = (() => {
    try {
      const parsed = JSON.parse(image.dataset.candidates || "[]");
      return Array.isArray(parsed) ? (parsed as string[]) : [];
    } catch {
      return [];
    }
  })();
  const next = Number(image.dataset.candidateIndex || 0) + 1;
  if (candidates[next]) {
    image.dataset.candidateIndex = String(next);
    image.src = candidates[next];
    return;
  }
  image.classList.add("is-error");
}
