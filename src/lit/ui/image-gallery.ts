import { LitElement, html, nothing, type PropertyValues } from "lit";
import type PhotoSwipe from "photoswipe";
import { backdropPress, isBackdropClick, modal } from "./modal";
import { trapFocus } from "../../lib/overlay";
import { uiText } from "../shared/catalog";
import { iconButton, rovingKeydown } from "./controls";
import { icon } from "./icon";
import { nextImageCandidate } from "./lazy-images";
import { knownImageSize, rememberImageSize } from "../../lib/image-dimensions";
import "../../styles/image-gallery.css";
import "photoswipe/style.css";

export interface GalleryClip {
  url: string;
  label: string;
  filename: string;
  width: number;
  height: number;
  loop?: boolean;
}
export interface GalleryImage {
  id: string;
  source: string;
  label: string;
  thumbnail?: string;
  candidates?: string[];
  width?: number;
  height?: number;
  bounds?: readonly [number, number, number, number];
  /**
   * Ordered clips played as one seamless hidden-control sequence (the gacha
   * movie): clips auto-advance on `ended`; a trailing loop clip parks the
   * sequence; selecting its thumbnail restarts it from the first clip.
   */
  videoSequence?: { clips: GalleryClip[] };
  /** The complete animated card, selected from the still's play toggle. */
  animatedOverlay?: GalleryClip;
}
export class ImageGallery extends LitElement {
  static properties = {
    images: { attribute: false },
    locale: {},
    active: {},
    title: {},
    natural: { type: Boolean, reflect: true },
    lazy: { type: Boolean },
    busy: { state: true },
    error: { state: true },
    clipIndex: { state: true },
    animated: { state: true },
    movieReady: { state: true },
    downloadsOpen: { state: true },
  };
  declare images: readonly GalleryImage[];
  declare locale: string;
  declare active: string;
  declare title: string;
  declare natural: boolean;
  /** Load the stage image only near the viewport (long lists of galleries). */
  declare lazy: boolean;
  declare busy: boolean;
  declare error: string;
  declare clipIndex: number;
  declare animated: boolean;
  declare movieReady: boolean;
  declare downloadsOpen: boolean;
  private movieVideo?: HTMLVideoElement;
  private movieVideos = new Set<HTMLVideoElement>();
  private movieIdentity = "";
  private movieGeneration = 0;
  private movieDeadline?: ReturnType<typeof setTimeout>;
  private nextMovie?: {
    index: number;
    identity: string;
    video: HTMLVideoElement;
    controller: AbortController;
    ready: Promise<void>;
    url?: string;
    error?: unknown;
  };
  private currentMovieUrl?: string;
  private movieFetchLifetime?: AbortController;
  /** Clip downloads, kept across loops, replays and switches until the image set changes. */
  private movieBlobs = new Map<string, Promise<Blob>>();
  private viewer?: PhotoSwipe;
  private releaseFocus?: () => void;
  private generation = 0;
  private dimensions = new Map<string, { src: string; width: number; height: number }>();
  constructor() {
    super();
    this.images = [];
    this.locale = "ja";
    this.active = "";
    this.title = "";
    this.natural = false;
    this.lazy = false;
    this.busy = false;
    this.error = "";
    this.clipIndex = 0;
    this.animated = false;
    this.movieReady = this.downloadsOpen = false;
  }
  createRenderRoot() {
    return this;
  }
  protected override shouldUpdate(changed: PropertyValues): boolean {
    if (this.hasAttribute("data-prerendered") && !this.images.length) return false;
    return super.shouldUpdate(changed);
  }
  protected override update(changed: PropertyValues): void {
    if (this.hasAttribute("data-prerendered")) {
      this.removeAttribute("data-prerendered");
      this.replaceChildren();
    }
    super.update(changed);
  }
  private dropMovieDownloads() {
    this.movieFetchLifetime?.abort();
    this.movieFetchLifetime = undefined;
    this.movieBlobs.clear();
  }
  disconnectedCallback() {
    this.generation++;
    this.stopMovie();
    this.dropMovieDownloads();
    this.viewer?.destroy();
    this.releaseFocus?.();
    super.disconnectedCallback();
  }
  protected willUpdate(changed: PropertyValues) {
    if (changed.has("active") && changed.get("active") !== this.active) {
      this.stopMovie();
      this.clipIndex = 0;
      this.animated = this.downloadsOpen = false;
    }
    const previous = changed.get("images") as GalleryImage[] | undefined;
    if (previous && JSON.stringify(previous) !== JSON.stringify(this.images)) {
      this.generation++;
      this.stopMovie();
      this.viewer?.destroy();
      this.busy = false;
      this.error = "";
      this.dimensions.clear();
      this.dropMovieDownloads();
    }
  }
  protected updated(changed: PropertyValues) {
    if (changed.has("active")) {
      const strip = this.querySelector<HTMLElement>(".image-gallery__thumbnails");
      const selected = strip?.querySelector<HTMLElement>('[aria-current="true"]');
      if (strip && selected) {
        const delta = selected.getBoundingClientRect().left - strip.getBoundingClientRect().left;
        if (delta < 0 || delta + selected.offsetWidth > strip.clientWidth) strip.scrollLeft += delta;
      }
    }
    this.syncMovie();
  }
  private clearMovieDeadline() {
    clearTimeout(this.movieDeadline);
    this.movieDeadline = undefined;
  }
  private waitForMovie = () => {
    this.clearMovieDeadline();
    const generation = this.movieGeneration;
    this.movieDeadline = setTimeout(() => {
      if (this.isConnected && generation === this.movieGeneration) this.failMovie();
    }, 30_000);
  };
  private stopMovie() {
    this.movieGeneration++;
    this.clearMovieDeadline();
    this.releaseNextMovie();
    for (const video of this.movieVideos) {
      video.pause();
      video.classList.remove("is-current");
      video.removeAttribute("src");
      video.load();
    }
    this.movieVideos.clear();
    if (this.currentMovieUrl) URL.revokeObjectURL(this.currentMovieUrl);
    this.currentMovieUrl = undefined;
    this.movieVideo = undefined;
    this.movieIdentity = "";
    this.movieReady = false;
  }
  private failMovie() {
    const identity = this.movieIdentity;
    this.stopMovie();
    this.movieIdentity = identity;
    this.error = uiText(this.locale, "common.states.unavailable");
  }
  private releaseNextMovie() {
    const next = this.nextMovie;
    this.nextMovie = undefined;
    if (!next) return;
    next.controller.abort();
    next.video.pause();
    next.video.removeAttribute("src");
    next.video.load();
    if (next.url) URL.revokeObjectURL(next.url);
  }
  private clipIdentity(active: GalleryImage, index: number, clip: GalleryClip): string {
    return JSON.stringify([active.id, index, clip.url]);
  }
  private movieBlob(url: string): Promise<Blob> {
    let pending = this.movieBlobs.get(url);
    if (pending) return pending;
    this.movieFetchLifetime ??= new AbortController();
    const signal = AbortSignal.any([this.movieFetchLifetime.signal, AbortSignal.timeout(30_000)]);
    pending = fetch(url, { signal }).then(async (response) => {
      if (!response.ok) throw new Error(`Video preload failed (${response.status})`);
      const blob = await response.blob();
      signal.throwIfAborted();
      return blob;
    });
    pending.catch(() => {
      if (this.movieBlobs.get(url) === pending) this.movieBlobs.delete(url);
    });
    this.movieBlobs.set(url, pending);
    return pending;
  }
  private prepareNextMovie(active: GalleryImage) {
    const clips = active.videoSequence?.clips;
    if (!clips || clips.length < 2 || !this.movieVideo) return;
    const index = this.clipIndex + 1 < clips.length ? this.clipIndex + 1 : 0;
    const clip = clips[index]!,
      identity = this.clipIdentity(active, index, clip);
    if (this.nextMovie?.identity === identity) return;
    this.releaseNextMovie();
    const video = [...this.querySelectorAll<HTMLVideoElement>("video.image-gallery__clip")].find(
      (value) => value !== this.movieVideo,
    );
    if (!video) return;
    this.movieVideos.add(video);
    const controller = new AbortController();
    const next = {
      index,
      identity,
      video,
      controller,
      ready: Promise.resolve(),
      url: undefined as string | undefined,
      error: undefined as unknown,
    };
    this.nextMovie = next;
    const deadline = setTimeout(
      () => controller.abort(new DOMException("Video preload timed out", "TimeoutError")),
      30_000,
    );
    next.ready = (async () => {
      const blob = await this.movieBlob(clip.url);
      controller.signal.throwIfAborted();
      if (this.nextMovie !== next || !this.isConnected) return;
      next.url = URL.createObjectURL(blob);
      video.muted = true;
      video.playsInline = true;
      video.loop = Boolean(clip.loop);
      video.width = clip.width;
      video.height = clip.height;
      await new Promise<void>((resolve, reject) => {
        const clean = () => {
          video.removeEventListener("loadeddata", decoded);
          video.removeEventListener("error", failed);
          controller.signal.removeEventListener("abort", aborted);
        };
        const decoded = () => {
          clean();
          resolve();
        };
        const failed = () => {
          clean();
          reject(new Error("Video preload decode failed"));
        };
        const aborted = () => {
          clean();
          reject(controller.signal.reason);
        };
        video.addEventListener("loadeddata", decoded, { once: true });
        video.addEventListener("error", failed, { once: true });
        controller.signal.addEventListener("abort", aborted, { once: true });
        video.src = next.url!;
        video.load();
      });
      controller.signal.throwIfAborted();
    })()
      .catch((error) => {
        next.error = error;
      })
      .finally(() => clearTimeout(deadline));
  }
  private syncMovie() {
    if (!this.isConnected) return;
    const active = this.images.find((image) => image.id === this.active) || this.images[0];
    const clip = active?.videoSequence
      ? active.videoSequence.clips[this.clipIndex]
      : this.animated
        ? active?.animatedOverlay
        : undefined;
    if (!clip) {
      if (this.movieVideo) this.stopMovie();
      return;
    }
    const identity = this.clipIdentity(active!, this.clipIndex, clip);
    if (identity === this.movieIdentity) return;
    const prepared = this.nextMovie?.identity === identity ? this.nextMovie : undefined;
    const previousVideo = this.movieVideo;
    const video =
      prepared?.video ??
      [...this.querySelectorAll<HTMLVideoElement>("video.image-gallery__clip")].find(
        (value) => value !== previousVideo,
      );
    if (!video) return;
    this.movieVideos.add(video);
    this.movieGeneration++;
    const generation = this.movieGeneration;
    this.movieIdentity = identity;
    this.error = "";
    this.waitForMovie();
    if (!prepared) this.releaseNextMovie();
    const download = prepared ? undefined : this.movieBlob(clip.url);
    void (async () => {
      if (prepared) {
        await prepared.ready;
        if (prepared.error) throw prepared.error;
      }
      const blob = download ? await download : undefined;
      if (!this.isConnected || generation !== this.movieGeneration) return;
      if (prepared) this.nextMovie = undefined;
      const previousUrl = this.currentMovieUrl;
      this.currentMovieUrl = prepared?.url ?? URL.createObjectURL(blob!);
      if (!prepared) {
        video.src = this.currentMovieUrl;
        video.load();
      }
      this.movieVideo = video;
      video.muted = true;
      video.playsInline = true;
      video.loop = Boolean(clip.loop || !active?.videoSequence);
      video.width = clip.width;
      video.height = clip.height;
      for (const following of active!.videoSequence?.clips.slice(this.clipIndex + 2) ?? [])
        void this.movieBlob(following.url).catch(() => undefined);
      try {
        await video.play();
        if (!this.isConnected || generation !== this.movieGeneration) return;
        video.classList.add("is-current");
        if (previousVideo && previousVideo !== video) {
          previousVideo.classList.remove("is-current");
          previousVideo.pause();
        }
        this.clearMovieDeadline();
        this.movieReady = true;
        this.prepareNextMovie(active!);
      } finally {
        if (previousUrl) URL.revokeObjectURL(previousUrl);
      }
    })().catch(() => {
      if (this.isConnected && generation === this.movieGeneration) this.failMovie();
    });
  }
  private onClipEnded(event: Event) {
    if (event.currentTarget !== this.movieVideo || !this.movieVideo?.ended) return;
    const active = this.images.find((image) => image.id === this.active) || this.images[0];
    if (active?.videoSequence && this.clipIndex < active.videoSequence.clips.length - 1) this.clipIndex++;
  }
  private renderDownloads(active: GalleryImage) {
    const clips = active.videoSequence?.clips;
    if (!this.downloadsOpen || !clips) return nothing;
    return html`
      <dialog
        class="dialog"
        aria-label=${uiText(this.locale, "common.actions.download")}
        ${modal(() => {
          this.downloadsOpen = false;
        })}
        @pointerdown=${backdropPress}
        @click=${(event: MouseEvent) => {
          if (isBackdropClick(event)) this.downloadsOpen = false;
        }}
      >
        <div class="dialog__header"><h2>${uiText(this.locale, "common.actions.download")}</h2></div>
        <div class="dialog__body stack">
          ${clips.map(
            (clip) => html`
              <a class="button button--tonal" href=${clip.url} download=${clip.filename}>
                ${icon("download", 20)}${clip.label}
              </a>
            `,
          )}
        </div>
        <div class="dialog__actions">
          <button
            class="button button--text"
            type="button"
            @click=${() => {
            this.downloadsOpen = false;
          }}
          >
            ${uiText(this.locale, "common.actions.close")}
          </button>
        </div>
      </dialog>
    `;
  }
  private select(index: number) {
    this.clipIndex = 0;
    this.animated = this.downloadsOpen = false;
    this.movieIdentity = "";
    this.active = this.images[index]?.id || "";
    this.error = "";
    this.requestUpdate();
    this.dispatchEvent(new CustomEvent("image-change", { detail: this.active, bubbles: true, composed: true }));
  }
  private remember(image: HTMLImageElement, source: string) {
    if (image.naturalWidth)
      this.dimensions.set(source, {
        src: image.currentSrc || image.src,
        width: image.naturalWidth,
        height: image.naturalHeight,
      });
    // Remembered for the next visit only: the stage keeps the ratio it was
    // first drawn with, so nothing below it moves when the picture arrives.
    rememberImageSize(source, image.naturalWidth, image.naturalHeight);
  }
  /** The ratio a natural stage reserves for `entry`, known at first paint. */
  private stageRatio(entry: GalleryImage): string {
    const size =
      entry.width && entry.height ? { width: entry.width, height: entry.height } : knownImageSize(entry.source);
    return size ? `${size.width} / ${size.height}` : "16 / 9";
  }
  private async imageData(entry: GalleryImage) {
    const cached = this.dimensions.get(entry.source);
    if (cached) return { ...cached, alt: entry.label };
    if (entry.width && entry.height)
      return { src: entry.source, width: entry.width, height: entry.height, alt: entry.label };
    for (const source of entry.candidates || [entry.source]) {
      try {
        const image = new Image();
        image.src = source;
        await image.decode();
        this.remember(image, entry.source);
        return { src: source, width: image.naturalWidth, height: image.naturalHeight, alt: entry.label };
      } catch {}
    }
    throw new Error(uiText(this.locale, "common.states.unavailable"));
  }
  private async open(index: number, event: MouseEvent) {
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button !== 0) return;
    event.preventDefault();
    if (this.busy || this.viewer) return;
    const generation = ++this.generation;
    const trigger = event.currentTarget as HTMLElement;
    this.busy = true;
    this.error = "";
    try {
      const [{ default: Viewer }, slides] = await Promise.all([
        import("photoswipe"),
        Promise.all(this.images.map((entry) => this.imageData(entry).catch(() => null))),
      ]);
      if (!this.isConnected || generation !== this.generation) return;
      if (!slides[index]) throw new Error(uiText(this.locale, "common.states.unavailable"));
      const indices = slides.flatMap((slide, i) => (slide ? [i] : []));
      const viewer = new Viewer({
        dataSource: slides.filter((slide): slide is NonNullable<typeof slide> => slide !== null),
        index: indices.indexOf(index),
        bgOpacity: 1,
        showHideAnimationType: "fade",
        trapFocus: false,
        returnFocus: false,
        wheelToZoom: true,
        imageClickAction: "zoom",
        padding: { top: 64, bottom: 24, left: 12, right: 12 },
        closeTitle: uiText(this.locale, "common.actions.close"),
        zoomTitle: uiText(this.locale, "media.models.labels.zoom"),
        arrowPrevTitle: uiText(this.locale, "media.images.actions.previousImage"),
        arrowNextTitle: uiText(this.locale, "media.images.actions.nextImage"),
        errorMsg: uiText(this.locale, "common.states.unavailable"),
      });
      this.viewer = viewer;
      viewer.on("afterInit", () => {
        if (viewer.element) {
          viewer.element.setAttribute("aria-label", this.title || uiText(this.locale, "image"));
          this.releaseFocus = trapFocus(viewer.element, { onDismiss: () => viewer.close(), returnFocus: trigger });
        }
      });
      viewer.on("change", () => this.select(indices[viewer.currIndex] ?? index));
      viewer.on("destroy", () => {
        this.releaseFocus?.();
        this.releaseFocus = undefined;
        this.viewer = undefined;
      });
      viewer.init();
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    } finally {
      if (generation === this.generation) this.busy = false;
    }
  }
  private picture(entry: GalleryImage, thumbnail = false) {
    const source = thumbnail
      ? entry.thumbnail || entry.candidates?.[0] || entry.source
      : entry.candidates?.[0] || entry.source;
    if (entry.bounds && entry.width && entry.height)
      return html`
        <svg
          viewBox=${entry.bounds.join(" ")}
          preserveAspectRatio="xMidYMid meet"
          role=${thumbnail ? nothing : "img"}
          aria-label=${thumbnail ? nothing : entry.label}
          aria-hidden=${thumbnail ? "true" : nothing}
        >
          <image
            href=${source}
            width=${entry.width}
            height=${entry.height}
            @error=${() => {
              this.error = uiText(this.locale, "common.states.unavailable");
            }}
          ></image>
        </svg>
      `;
    return html`
      <img
        src=${source}
        data-candidates=${JSON.stringify(entry.candidates || [entry.source])}
        data-candidate-index="0"
        alt=${thumbnail ? "" : entry.label}
        decoding="async"
        loading=${thumbnail || this.lazy ? "lazy" : "eager"}
        @error=${nextImageCandidate}
        @load=${(event: Event) => {
          if (!thumbnail || !entry.thumbnail) this.remember(event.currentTarget as HTMLImageElement, entry.source);
        }}
      />
    `;
  }
  render() {
    const index = Math.max(
      0,
      this.images.findIndex((image) => image.id === this.active),
    );
    const active = this.images[index];
    if (!active) return nothing;
    const candidates = active.candidates || [active.source];
    if (active.videoSequence || (active.animatedOverlay && this.animated)) {
      const overlay = active.animatedOverlay;
      return html`
        <section class="image-gallery" aria-label=${this.title || uiText(this.locale, "image")}>
          <div class="image-gallery__stage image-gallery__stage--cinema">
            <img
              class="image-gallery__cinema-poster${this.movieReady ? "" : " is-visible"}"
              src=${active.source}
              alt=""
              decoding="async"
            />
            ${[0, 1].map(
              () => html`
                <video
                  class="image-gallery__clip"
                  muted
                  playsinline
                  preload="auto"
                  disablepictureinpicture
                  disableremoteplayback
                  @ended=${(event: Event) => this.onClipEnded(event)}
                  @waiting=${(event: Event) => {
                  if (event.currentTarget === this.movieVideo) this.waitForMovie();
                }}
                  @playing=${(event: Event) => {
                  if (event.currentTarget === this.movieVideo) this.clearMovieDeadline();
                }}
                  @error=${(event: Event) => {
                  if (event.currentTarget === this.movieVideo) this.failMovie();
                }}
                  aria-hidden="true"
                ></video>
              `,
            )}
            ${
              overlay
                ? html`
                    <a
                      class="image-gallery__download icon-button"
                      href=${overlay.url}
                      download=${overlay.filename}
                      aria-label=${uiText(this.locale, "common.actions.download")}
                      title=${uiText(this.locale, "common.actions.download")}
                    >
                      ${icon("download", 22)}
                    </a>
                  `
                : html`
                    <button
                      class="image-gallery__download icon-button"
                      type="button"
                      aria-label=${uiText(this.locale, "common.actions.download")}
                      title=${uiText(this.locale, "common.actions.download")}
                      @click=${() => {
                  this.downloadsOpen = true;
                }}
                    >
                      ${icon("download", 22)}
                    </button>
                  `
            }
          </div>
          <div class="image-gallery__toolbar">
            ${this.images.length > 1 ? iconButton({ icon: "chevron_left", label: uiText(this.locale, "media.images.actions.previousImage"), disabled: index === 0, onClick: () => this.select(index - 1) }) : nothing}
            <span class="image-gallery__caption">
              <strong>${active.label}</strong>
              ${
                this.images.length > 1
                  ? html`
                      <small>${index + 1} / ${this.images.length}</small>
                    `
                  : nothing
              }
            </span>
            ${this.images.length > 1 ? iconButton({ icon: "chevron_right", label: uiText(this.locale, "media.images.actions.nextImage"), disabled: index === this.images.length - 1, onClick: () => this.select(index + 1) }) : nothing}
            <a
              class="icon-button"
              href=${active.videoSequence?.clips[0]?.url || candidates[0]}
              target="_blank"
              rel="noopener"
              aria-label=${uiText(this.locale, "media.images.actions.originalImage")}
              title=${uiText(this.locale, "media.images.actions.originalImage")}
            >
              ${icon("open_in_new", 20)}
            </a>
          </div>
          ${this.renderThumbnails(index)} ${this.renderDownloads(active)}
          ${
            this.error
              ? html`
                  <p class="image-gallery__status" role="alert">${this.error}</p>
                `
              : nothing
          }
        </section>
      `;
    }
    return html`
      <section class="image-gallery" aria-label=${this.title || uiText(this.locale, "image")}>
        <div class="image-gallery__stagewrap">
          <a
            class="image-gallery__stage"
            style=${this.natural ? `--gallery-ratio:${this.stageRatio(active)}` : nothing}
            href=${candidates[0]}
            target="_blank"
            rel="noopener"
            aria-label=${`${uiText(this.locale, "media.models.labels.zoom")} / ${active.label}`}
            @click=${(event: MouseEvent) => this.open(index, event)}
          >
            ${this.picture(active)}
            <span class="image-gallery__expand" aria-hidden="true">${icon("zoom_in", 20)}</span>
          </a>
          ${
            active.animatedOverlay
              ? html`
                  <button
                    class="image-gallery__animate icon-button"
                    type="button"
                    aria-label=${uiText(this.locale, "catalog.cards.animations.animated")}
                    title=${uiText(this.locale, "catalog.cards.animations.animated")}
                    @click=${() => {
                      this.animated = true;
                    }}
                  >
                    ${icon("play_arrow", 22)}
                  </button>
                `
              : nothing
          }
        </div>
        <div class="image-gallery__toolbar">
          ${this.images.length > 1 ? iconButton({ icon: "chevron_left", label: uiText(this.locale, "media.images.actions.previousImage"), disabled: index === 0, onClick: () => this.select(index - 1) }) : nothing}
          <span class="image-gallery__caption">
            <strong>${active.label}</strong>
            ${
              this.images.length > 1
                ? html`
                    <small>${index + 1} / ${this.images.length}</small>
                  `
                : nothing
            }
          </span>
          ${this.images.length > 1 ? iconButton({ icon: "chevron_right", label: uiText(this.locale, "media.images.actions.nextImage"), disabled: index === this.images.length - 1, onClick: () => this.select(index + 1) }) : nothing}
          <a
            class="icon-button"
            href=${this.dimensions.get(active.source)?.src || candidates[0]}
            target="_blank"
            rel="noopener"
            aria-label=${uiText(this.locale, "media.images.actions.originalImage")}
            title=${uiText(this.locale, "media.images.actions.originalImage")}
          >
            ${icon("open_in_new", 20)}
          </a>
        </div>
        ${this.renderThumbnails(index)}
        ${
          this.busy
            ? html`
                <p class="image-gallery__status" role="status">${uiText(this.locale, "common.states.loading")}</p>
              `
            : nothing
        }
        ${
          this.error
            ? html`
                <p class="image-gallery__status" role="alert">${this.error}</p>
              `
            : nothing
        }
      </section>
    `;
  }
  private renderThumbnails(index: number) {
    if (this.images.length < 2) return nothing;
    return html`
      <div
        class="image-gallery__thumbnails"
        role="radiogroup"
        aria-label=${uiText(this.locale, "image")}
        @keydown=${rovingKeydown(
          this.images.map((_, i) => i),
          index,
          (i) => this.select(i),
        )}
      >
        ${this.images.map(
          (entry, i) => html`
            <button
              type="button"
              role="radio"
              class=${entry.videoSequence ? "image-gallery__thumb--video" : nothing}
              aria-checked=${i === index}
              aria-current=${i === index ? "true" : nothing}
              aria-label=${entry.label}
              title=${entry.label}
              tabindex=${i === index ? 0 : -1}
              @click=${() => this.select(i)}
            >
              ${this.picture(entry, true)}
            </button>
          `,
        )}
      </div>
    `;
  }
}
if (!customElements.get("image-gallery")) customElements.define("image-gallery", ImageGallery);
