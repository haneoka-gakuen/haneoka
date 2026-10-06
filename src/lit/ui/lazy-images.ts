import { createLoadingIndicator } from "./loading-indicator";

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

export function localizedAssetUrl(source: string, locale: string): string {
  return localeTaggedCandidates(source, locale)[0] || source;
}

export interface LazyImageOptions {
  /**
   * Extra sources to try before the plain one — localized artwork, usually.
   * Returning `[source]` (the default) means "no variants".
   */
  candidates?: (source: string) => readonly string[];
  /** How far ahead of the viewport to start loading. */
  rootMargin?: string;
  /** Scroll container whose nearby rows should be prefetched. */
  root?: Element | null;
  /** Restricts observation when a parent owns only part of its light-DOM tree. */
  filter?: (image: HTMLImageElement) => boolean;
}

type FinishImage = (state: "loaded" | "error" | "cancelled") => void;
interface PendingImage {
  owner: LazyImages;
  inputSource: string;
  source: string;
  finish: FinishImage;
}

/*
 * The loader and the image's error listener are separate event parts in Lit.
 * Keeping the finish callback beside the element lets the shared error path
 * release the load listener too, including when a candidate list is exhausted
 * or a render removes the image before it settles.
 */
const pendingImageFinishes = new WeakMap<HTMLImageElement, PendingImage>();

function syncMediaFrame(image: HTMLImageElement, frame = image.closest<HTMLElement>(".media-loading")) {
  if (!frame) return;
  const pending = [...frame.querySelectorAll<HTMLImageElement>("img")].some((item) =>
    Boolean(item.dataset.loading || (item.dataset.src && !item.dataset.cancelled && !item.classList.contains("is-error"))),
  );
  frame.setAttribute("aria-busy", String(pending));
  if (!pending || frame.querySelector(":scope > .media-loading__progress")) return;
  frame.append(createLoadingIndicator({ className: "media-loading__progress" }));
}

function finishImage(image: HTMLImageElement, state: "loaded" | "error" | "cancelled") {
  pendingImageFinishes.get(image)?.finish(state);
}

function sourceMatches(image: HTMLImageElement, expected: string) {
  const actual = image.getAttribute("src") || image.currentSrc || image.src;
  if (!actual || !expected) return false;
  try {
    return new URL(actual, document.baseURI).href === new URL(expected, document.baseURI).href;
  } catch {
    return actual === expected;
  }
}

export class LazyImages {
  private observer?: IntersectionObserver;
  private candidates: (source: string) => readonly string[];
  private rootMargin: string;
  private root: Element | null;
  private filter: (image: HTMLImageElement) => boolean;
  private observed = new Set<HTMLImageElement>();
  private pending = new Set<HTMLImageElement>();

  constructor(options: LazyImageOptions = {}) {
    this.candidates = options.candidates ?? ((source) => [source]);
    this.rootMargin = options.rootMargin ?? "240px";
    this.root = options.root ?? null;
    this.filter = options.filter ?? (() => true);
  }

  /** Call from `updated()`: picks up whatever the last render added. */
  observe(root: ParentNode) {
    const node = root as Node;
    new Set([...this.observed, ...this.pending]).forEach((image) => {
      const pending = this.pending.has(image);
      const state = pendingImageFinishes.get(image);
      const source = image.dataset.src?.trim();
      if (
        !node.contains(image) ||
        (!pending && !source) ||
        (pending && source !== undefined && source !== state?.inputSource)
      )
        this.cancel(image);
    });
    const images = [...root.querySelectorAll<HTMLImageElement>("img[data-src]")].filter(this.filter);
    images.forEach((image) => syncMediaFrame(image));
    if (!images.length) return;
    if (!("IntersectionObserver" in window)) {
      images.forEach((image) => this.load(image));
      return;
    }
    this.observer ??= new IntersectionObserver(
      (entries) => entries.forEach((entry) => entry.isIntersecting && this.load(entry.target as HTMLImageElement)),
      { root: this.root, rootMargin: this.rootMargin },
    );
    images.forEach((image) => {
      this.observed.add(image);
      this.observer?.observe(image);
    });
  }

  /** Promotes one image immediately, whether or not it is on screen. */
  load(image: HTMLImageElement) {
    this.cancel(image, true);
    if (!image.isConnected) return;
    image.removeAttribute("src");
    const source = image.dataset.src?.trim() || "";
    let fallbacks: string[] = [];
    try {
      const value = JSON.parse(image.dataset.fallbacks || "[]");
      if (Array.isArray(value)) fallbacks = value.filter((entry): entry is string => typeof entry === "string");
    } catch {}
    const candidates = [
      ...this.candidates(source),
      ...fallbacks,
      ...(image.dataset.fallback ? [image.dataset.fallback] : []),
    ]
      .map((value) => (typeof value === "string" ? value.trim() : ""))
      .filter((value, index, values) => value && values.indexOf(value) === index);
    image.classList.remove("is-loaded", "is-error");
    this.observed.delete(image);
    this.observer?.unobserve(image);
    image.removeAttribute("data-candidates");
    image.removeAttribute("data-candidate-index");
    if (!candidates.length) {
      delete image.dataset.loading;
      image.dataset.error = "true";
      image.classList.add("is-error");
      image.removeAttribute("data-src");
      syncMediaFrame(image);
      return;
    }

    const frame = image.closest<HTMLElement>(".media-loading");
    const controller = new AbortController();
    let request: PendingImage;
    const settle: FinishImage = (state) => {
      if (pendingImageFinishes.get(image)?.finish !== settle) return;
      pendingImageFinishes.delete(image);
      this.pending.delete(image);
      controller.abort();
      delete image.dataset.loading;
      if (state === "loaded") {
        delete image.dataset.cancelled;
        delete image.dataset.error;
        image.classList.remove("is-error");
        image.classList.add("is-loaded");
      } else if (state === "error") {
        delete image.dataset.cancelled;
        image.dataset.error = "true";
        image.classList.add("is-error");
      } else {
        image.dataset.cancelled = "true";
        delete image.dataset.candidates;
        delete image.dataset.candidateIndex;
        delete image.dataset.error;
        image.classList.remove("is-loaded", "is-error");
      }
      syncMediaFrame(image);
      if (frame && frame !== image.closest(".media-loading")) syncMediaFrame(image, frame);
    };
    request = { owner: this, inputSource: source, source: candidates[0], finish: settle };
    pendingImageFinishes.set(image, request);
    this.pending.add(image);
    delete image.dataset.cancelled;
    image.dataset.loading = "true";
    image.addEventListener(
      "load",
      () => {
        const current = pendingImageFinishes.get(image);
        if (current?.finish === settle && sourceMatches(image, current.source)) settle("loaded");
      },
      { once: true, signal: controller.signal },
    );
    image.dataset.candidates = JSON.stringify(candidates);
    image.dataset.candidateIndex = "0";
    image.src = candidates[0];
    image.removeAttribute("data-src");
    syncMediaFrame(image);
  }

  private cancel(image: HTMLImageElement, force = false) {
    const pending = pendingImageFinishes.get(image);
    if (pending && (force || pending.owner === this)) {
      pending.finish("cancelled");
      image.removeAttribute("src");
    }
    this.pending.delete(image);
    this.observed.delete(image);
    this.observer?.unobserve(image);
  }

  disconnect() {
    this.pending.forEach((image) => this.cancel(image));
    this.pending.clear();
    this.observed.clear();
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
  if (image.dataset.cancelled) return;
  const request = pendingImageFinishes.get(image);
  if (request && !sourceMatches(image, request.source)) return;
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
    if (request) request.source = candidates[next];
    image.src = candidates[next];
    return;
  }
  finishImage(image, "error");
  delete image.dataset.candidateIndex;
  delete image.dataset.candidates;
  image.classList.add("is-error");
}
