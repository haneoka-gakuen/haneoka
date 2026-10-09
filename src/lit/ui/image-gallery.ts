import { LitElement, html, nothing, type PropertyValues } from "lit";
import type PhotoSwipe from "photoswipe";
import { AlphaVideo, alphaVideoSource, type AlphaVideoSource } from "../runtime/alpha-video";
import { trapFocus } from "../../lib/overlay";
import { uiText } from "../shared/catalog";
import { iconButton, rovingKeydown } from "./controls";
import { icon } from "./icon";
import { nextImageCandidate } from "./lazy-images";
import { knownImageSize, rememberImageSize } from "../../lib/image-dimensions";
import "../../styles/image-gallery.css";
import "photoswipe/style.css";
import { loadingIndicator } from "./loading-indicator";

export interface GalleryClip extends AlphaVideoSource {
  loop?: boolean;
  /**
   * Whether the sequence's background should show behind this clip. Only the
   * alpha-transparent Live2D segments composite over the card scene; the
   * opaque anime segments carry their own full-frame picture.
   */
  backdrop?: boolean;
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
   * sequence, and the replay control restarts it from the first clip.
   */
  videoSequence?: { clips: GalleryClip[]; background?: string };
  /**
   * The still's own animated mode (the showcase loop composited over the card
   * background). The stage keeps showing the still until the viewer opts in
   * through the play toggle beside the zoom control.
   */
  animatedOverlay?: AlphaVideoSource & { background?: string };
}
export class ImageGallery extends LitElement {
  static properties = {
    images: { attribute: false },
    locale: {},
    active: {},
    title: {},
    natural: { type: Boolean, reflect: true },
    busy: { state: true },
    error: { state: true },
    clipIndex: { state: true },
    animated: { state: true },
    movieBusy: { state: true },
    movieReady: { state: true },
    movieBackdrop: { state: true },
  };
  declare images: readonly GalleryImage[];
  declare locale: string;
  declare active: string;
  declare title: string;
  declare natural: boolean;
  declare busy: boolean;
  declare error: string;
  declare clipIndex: number;
  declare animated: boolean;
  declare movieBusy: boolean;
  declare movieReady: boolean;
  declare movieBackdrop: boolean;
  private movieVideo?: HTMLVideoElement;
  private movieCanvas?: HTMLCanvasElement;
  private movieRenderer?: AlphaVideo;
  private movieIdentity = "";
  private movieGeneration = 0;
  private movieDeadline?: ReturnType<typeof setTimeout>;
  private desiredBackdrop = false;
  private movieStarting = false;
  private nextMovie?: {
    index: number;
    identity: string;
    video: HTMLVideoElement;
    packed: boolean;
    controller: AbortController;
    ready: Promise<void>;
    url?: string;
    error?: unknown;
  };
  private currentMovieUrl?: string;
  private movieFetchLifetime?: AbortController;
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
    this.busy = false;
    this.error = "";
    this.clipIndex = 0;
    this.animated = false;
    this.movieBusy = this.movieReady = this.movieBackdrop = false;
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
  disconnectedCallback() {
    this.generation++;
    this.stopMovie();
    this.viewer?.destroy();
    this.releaseFocus?.();
    super.disconnectedCallback();
  }
  protected willUpdate(changed: PropertyValues) {
    if (changed.has("active") && changed.get("active") !== this.active) {
      this.stopMovie();
      this.clipIndex = 0;
      this.animated = false;
    }
    const previous = changed.get("images") as GalleryImage[] | undefined;
    if (
      previous &&
      previous.map((image) => image.source).join("\n") !== this.images.map((image) => image.source).join("\n")
    ) {
      this.generation++;
      this.stopMovie();
      this.viewer?.destroy();
      this.busy = false;
      this.error = "";
      this.dimensions.clear();
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
    if (!this.movieVideo?.getAttribute("src")) return;
    this.movieBusy = true;
    this.clearMovieDeadline();
    const generation = this.movieGeneration;
    this.movieDeadline = setTimeout(() => {
      if (this.isConnected && generation === this.movieGeneration) this.failMovie();
    }, 30_000);
  };
  private movieProgress = () => {
    if (this.movieBusy) this.waitForMovie();
  };
  private stopMovie() {
    this.movieGeneration++;
    this.clearMovieDeadline();
    this.releaseNextMovie();
    this.movieFetchLifetime?.abort();
    this.movieFetchLifetime = undefined;
    this.movieBlobs.clear();
    this.movieRenderer?.dispose();
    this.movieRenderer = undefined;
    if (this.movieVideo) {
      this.movieVideo.pause();
      this.movieVideo.removeAttribute("src");
      this.movieVideo.load();
    }
    if (this.currentMovieUrl) URL.revokeObjectURL(this.currentMovieUrl);
    this.currentMovieUrl = undefined;
    this.movieVideo = undefined;
    this.movieCanvas = undefined;
    this.movieIdentity = "";
    this.movieStarting = false;
    this.movieBusy = this.movieReady = this.movieBackdrop = false;
  }
  private failMovie() {
    // Keep the poster and existing retry controls; release decoder/GPU work.
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
    return JSON.stringify([
      active.id,
      index,
      clip,
      active.videoSequence?.background || active.animatedOverlay?.background,
    ]);
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
    const video = [...this.querySelectorAll<HTMLVideoElement>("video.image-gallery__decoder")].find(
      (value) => value !== this.movieVideo,
    );
    const source = alphaVideoSource(clip, Boolean(clip.backdrop));
    if (!video || !source) return;
    const controller = new AbortController();
    const next = {
      index,
      identity,
      video,
      packed: source.packed,
      controller,
      ready: Promise.resolve(),
      url: undefined as string | undefined,
      error: undefined as unknown,
    };
    this.nextMovie = next;
    // Only the upcoming segment is fetched; a complete Blob cannot stall on a later network range.
    const deadline = setTimeout(
      () => controller.abort(new DOMException("Video preload timed out", "TimeoutError")),
      30_000,
    );
    next.ready = (async () => {
      const blob = await this.movieBlob(source.url);
      controller.signal.throwIfAborted();
      if (this.nextMovie !== next || !this.isConnected) return;
      next.url = URL.createObjectURL(blob);
      video.crossOrigin = "anonymous";
      video.muted = true;
      video.playsInline = true;
      video.loop = Boolean(clip.loop);
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
    const clip: GalleryClip | undefined = active?.videoSequence
      ? active.videoSequence.clips[this.clipIndex]
      : active?.animatedOverlay && this.animated
        ? { ...active.animatedOverlay, loop: true, backdrop: true }
        : undefined;
    if (!clip) {
      if (this.movieVideo) this.stopMovie();
      return;
    }
    const identity = this.clipIdentity(active!, this.clipIndex, clip);
    if (identity === this.movieIdentity) return;
    const prepared =
      this.nextMovie?.identity === identity &&
      !this.nextMovie.error &&
      this.nextMovie.video.readyState >= 2 &&
      !this.nextMovie.video.seeking
        ? this.nextMovie
        : undefined;
    const video =
      prepared?.video ?? this.movieVideo ?? this.querySelector<HTMLVideoElement>("video.image-gallery__decoder");
    const canvas = this.querySelector<HTMLCanvasElement>("canvas.image-gallery__clip");
    if (!video || !canvas) return;
    const source = alphaVideoSource(clip, Boolean(clip.backdrop));
    if (!source) {
      this.movieIdentity = identity;
      this.failMovie();
      return;
    }
    const previousVideo = this.movieVideo;
    const reused = this.movieCanvas === canvas && this.movieRenderer;
    if (!reused) this.stopMovie();
    else {
      this.movieGeneration++;
      this.clearMovieDeadline();
      this.movieVideo?.pause();
    }
    this.movieVideo = video;
    this.movieCanvas = canvas;
    this.movieIdentity = identity;
    this.desiredBackdrop = Boolean(clip.backdrop);
    this.movieStarting = !prepared && this.clipIndex === 0 && (active!.videoSequence?.clips.length ?? 0) > 1;
    this.error = "";
    try {
      if (!this.movieRenderer) {
        const renderer = new AlphaVideo(video, canvas, {
          frame: () => {
            if (this.movieRenderer !== renderer || !this.isConnected) return;
            if (!this.movieStarting) this.clearMovieDeadline();
            this.movieBusy = this.movieStarting;
            this.movieReady = true;
            this.movieBackdrop = this.desiredBackdrop;
          },
          lost: () => {
            if (this.movieRenderer === renderer) {
              this.movieReady = false;
              this.waitForMovie();
            }
          },
          error: () => {
            if (this.movieRenderer === renderer && this.isConnected) this.failMovie();
          },
        });
        this.movieRenderer = renderer;
      }
      if (prepared) {
        this.nextMovie = undefined;
        if (this.currentMovieUrl) URL.revokeObjectURL(this.currentMovieUrl);
        this.currentMovieUrl = prepared.url;
        this.waitForMovie();
        this.movieRenderer.setVideo(video, prepared.packed);
        if (previousVideo && previousVideo !== video) {
          previousVideo.removeAttribute("src");
          previousVideo.load();
        }
      } else {
        this.releaseNextMovie();
        if (this.currentMovieUrl) URL.revokeObjectURL(this.currentMovieUrl);
        this.currentMovieUrl = undefined;
        this.movieRenderer.configure(source.packed);
      }
      video.crossOrigin = "anonymous";
      video.muted = true;
      video.playsInline = true;
      video.loop = Boolean(clip.loop);
      if (!prepared) {
        this.movieReady = false;
        video.src = source.url;
        video.load();
        this.waitForMovie();
      }
      this.prepareNextMovie(active!);
      // This selected three-part movie alone is warmed; only two decoders exist.
      // Later bytes can arrive while the first upcoming decoder is prepared.
      for (const following of active!.videoSequence?.clips.slice(this.clipIndex + 2) ?? []) {
        const upcoming = alphaVideoSource(following, Boolean(following.backdrop));
        if (upcoming) void this.movieBlob(upcoming.url).catch(() => undefined);
      }
      const generation = this.movieGeneration;
      const startup = !prepared && this.clipIndex === 0 ? this.nextMovie : undefined;
      void (async () => {
        // Pay cold-network preparation before starting, not at the first cut.
        if (startup) {
          await startup.ready;
          if (startup.error) throw startup.error;
        }
        if (!this.isConnected || generation !== this.movieGeneration) return;
        this.movieStarting = false;
        await video.play();
      })().catch(() => {
        if (this.isConnected && generation === this.movieGeneration) this.failMovie();
      });
    } catch {
      this.failMovie();
    }
  }
  private onClipEnded(event: Event) {
    if (event.currentTarget !== this.movieVideo || !this.movieVideo?.ended) return;
    const active = this.images.find((image) => image.id === this.active) || this.images[0];
    if (!active?.videoSequence || this.clipIndex >= active.videoSequence.clips.length - 1) return;
    const next = this.nextMovie,
      generation = this.movieGeneration;
    if (!next) {
      this.clipIndex++;
      return;
    }
    if (next.video.readyState >= 2 && !next.error) {
      this.clipIndex++;
      return;
    }
    this.movieReady = false;
    this.waitForMovie();
    void next.ready.then(() => {
      if (!this.isConnected || generation !== this.movieGeneration || this.nextMovie !== next) return;
      if (next.error) this.failMovie();
      else this.clipIndex++;
    });
  }
  private replaySequence() {
    const next = this.nextMovie;
    if (next?.index === 0 && !next.error && next.video.readyState < 2) {
      const generation = this.movieGeneration;
      this.movieVideo?.pause();
      this.movieReady = false;
      this.waitForMovie();
      void next.ready.then(() => {
        if (!this.isConnected || generation !== this.movieGeneration || this.nextMovie !== next) return;
        if (next.error) this.failMovie();
        else this.replaySequence();
      });
      return;
    }
    this.clipIndex = 0;
    this.movieIdentity = "";
    this.error = "";
    this.requestUpdate();
  }
  private select(index: number) {
    this.active = this.images[index]?.id || "";
    this.error = "";
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
        loading=${thumbnail ? "lazy" : "eager"}
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
    // Cinema stage: hidden-control video composited over an optional still
    // background (the gacha sequence, or the still's own animated mode). It
    // never enters the photo lightbox — the zoom chain decodes stills only.
    if (active.videoSequence || (active.animatedOverlay && this.animated)) {
      const background = active.videoSequence?.background || active.animatedOverlay?.background;
      const isSequence = Boolean(active.videoSequence);
      // Only the transparent Live2D segments composite over the card scene;
      // the opaque anime segments carry their own full-frame picture.
      const backdrop = background && this.movieBackdrop;
      return html`
        <section class="image-gallery" aria-label=${this.title || uiText(this.locale, "image")}>
          <div class="image-gallery__stage image-gallery__stage--cinema">
            <div class="image-gallery__cinema-frame">
              ${
                background
                  ? html`
                      <img
                        class="image-gallery__cinema-bg${backdrop ? " is-visible" : ""}"
                        src=${background}
                        alt=""
                        decoding="async"
                      />
                    `
                  : nothing
              }
              <img
                class="image-gallery__cinema-poster${this.movieReady ? "" : " is-visible"}"
                src=${active.source}
                alt=""
                decoding="async"
              />
              ${[0, 1].map(
                () => html`
                  <video
                    class="image-gallery__decoder"
                    muted
                    playsinline
                    crossorigin="anonymous"
                    preload="auto"
                    @ended=${(event: Event) => this.onClipEnded(event)}
                    @waiting=${(event: Event) => {
                      if (event.currentTarget === this.movieVideo) this.waitForMovie();
                    }}
                    @progress=${(event: Event) => {
                      if (event.currentTarget === this.movieVideo) this.movieProgress();
                    }}
                    @error=${() => {
                      if (this.movieVideo?.error) this.failMovie();
                    }}
                    aria-hidden="true"
                  ></video>
                `,
              )}
              <canvas
                class="image-gallery__clip${this.movieReady ? " is-current" : ""}"
                role="img"
                aria-label=${active.label}
              ></canvas>
              ${
                this.movieBusy
                  ? html`
                      ${loadingIndicator({ className: "image-gallery__cinema-loading", label: uiText(this.locale, "common.states.loading") })}
                    `
                  : nothing
              }
            </div>
            ${
              isSequence
                ? html`
                    <button
                      class="image-gallery__replay icon-button"
                      type="button"
                      aria-label=${uiText(this.locale, "catalog.cards.animations.replay")}
                      title=${uiText(this.locale, "catalog.cards.animations.replay")}
                      @click=${() => this.replaySequence()}
                    >
                      ${icon("refresh", 22)}
                    </button>
                  `
                : nothing
            }
            ${
              active.animatedOverlay
                ? html`
                    <button
                      class="image-gallery__animate icon-button"
                      type="button"
                      aria-label=${uiText(this.locale, "catalog.cards.animations.animated")}
                      title=${uiText(this.locale, "catalog.cards.animations.animated")}
                      @click=${() => {
                        this.animated = false;
                        this.error = "";
                      }}
                    >
                      ${icon("pause", 22)}
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
              href=${active.videoSequence?.clips[0]?.url || candidates[0]}
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
            aria-label=${`${uiText(this.locale, "media.models.labels.zoom")} · ${active.label}`}
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
