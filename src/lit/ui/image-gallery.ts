import { LitElement, html, nothing, type PropertyValues } from "lit";
import type PhotoSwipe from "photoswipe";
import { trapFocus } from "../../lib/overlay";
import { uiText } from "../shared/catalog";
import { iconButton, rovingKeydown } from "./controls";
import { icon } from "./icon";
import { nextImageCandidate } from "./lazy-images";
import "../../styles/image-gallery.css";
import "photoswipe/style.css";

export interface GalleryClip {
  url: string;
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
  animatedOverlay?: { url: string; background?: string };
}
export class ImageGallery extends LitElement {
  static properties = {
    images: { attribute: false },
    locale: {},
    active: {},
    title: {},
    busy: { state: true },
    error: { state: true },
    clipIndex: { state: true },
    animated: { state: true },
  };
  declare images: readonly GalleryImage[];
  declare locale: string;
  declare active: string;
  declare title: string;
  declare busy: boolean;
  declare error: string;
  declare clipIndex: number;
  declare animated: boolean;
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
    this.busy = false;
    this.error = "";
    this.clipIndex = 0;
    this.animated = false;
  }
  createRenderRoot() {
    return this;
  }
  disconnectedCallback() {
    this.generation++;
    this.viewer?.destroy();
    this.releaseFocus?.();
    super.disconnectedCallback();
  }
  protected willUpdate(changed: PropertyValues) {
    const previous = changed.get("images") as GalleryImage[] | undefined;
    if (
      previous &&
      previous.map((image) => image.source).join("\n") !== this.images.map((image) => image.source).join("\n")
    ) {
      this.generation++;
      this.viewer?.destroy();
      this.busy = false;
      this.error = "";
      this.dimensions.clear();
    }
  }
  protected updated(changed: PropertyValues) {
    const active = this.images.find((image) => image.id === this.active);
    if (changed.has("active")) {
      if (this.clipIndex !== 0) this.clipIndex = 0;
      if (this.animated) this.animated = false;
      const strip = this.querySelector<HTMLElement>(".image-gallery__thumbnails");
      const selected = strip?.querySelector<HTMLElement>('[aria-current="true"]');
      if (strip && selected) {
        const delta = selected.getBoundingClientRect().left - strip.getBoundingClientRect().left;
        if (delta < 0 || delta + selected.offsetWidth > strip.clientWidth) strip.scrollLeft += delta;
      }
    }
    if (
      (changed.has("active") || changed.has("clipIndex")) &&
      (changed.has("clipIndex") || changed.get("active") !== this.active) &&
      active?.videoSequence
    ) {
      // Entering or restarting the sequence always plays the current clip
      // from its start; clips are muted so autoplay policy never blocks them.
      this.playCurrentClipFromStart();
    }
    if (changed.has("animated") && this.animated && active?.animatedOverlay) {
      this.playCurrentClipFromStart();
    }
  }
  private playCurrentClipFromStart() {
    const video = this.querySelector<HTMLVideoElement>("video.image-gallery__clip.is-current");
    if (video) {
      video.currentTime = 0;
      video.play().catch(() => {});
    }
  }
  private onClipEnded() {
    const active = this.images.find((image) => image.id === this.active);
    const clips = active?.videoSequence?.clips || [];
    if (this.clipIndex < clips.length - 1) this.clipIndex += 1;
  }
  private replaySequence() {
    const parkedAtFirst = this.clipIndex === 0;
    this.clipIndex = 0;
    if (parkedAtFirst) void this.updateComplete.then(() => this.playCurrentClipFromStart());
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
    throw new Error(uiText(this.locale, "unavailable"));
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
      if (!slides[index]) throw new Error(uiText(this.locale, "unavailable"));
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
        closeTitle: uiText(this.locale, "close"),
        zoomTitle: uiText(this.locale, "zoom"),
        arrowPrevTitle: uiText(this.locale, "previousImage"),
        arrowNextTitle: uiText(this.locale, "nextImage"),
        errorMsg: uiText(this.locale, "unavailable"),
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
              this.error = uiText(this.locale, "unavailable");
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
      const clips = active.videoSequence?.clips || [{ url: active.animatedOverlay!.url, loop: true }];
      // Only the transparent Live2D segments composite over the card scene;
      // the opaque anime segments carry their own full-frame picture.
      const backdrop = background && (!isSequence || (clips[this.clipIndex]?.backdrop ?? false));
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
              ${clips.map(
                (clip, clipIndex) => html`
                  <video
                    class="image-gallery__clip${clipIndex === this.clipIndex ? " is-current" : ""}"
                    muted
                    playsinline
                    preload="auto"
                    ?loop=${clip.loop ?? !isSequence}
                    src=${clip.url}
                    @ended=${isSequence ? () => this.onClipEnded() : nothing}
                    aria-label=${active.label}
                  ></video>
                `,
              )}
            </div>
            ${
              isSequence
                ? html`
                    <button
                      class="image-gallery__replay icon-button"
                      type="button"
                      aria-label=${uiText(this.locale, "cardMovieReplay")}
                      title=${uiText(this.locale, "cardMovieReplay")}
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
                      aria-label=${uiText(this.locale, "cardMovieAnimated")}
                      title=${uiText(this.locale, "cardMovieAnimated")}
                      @click=${() => {
                        this.animated = false;
                      }}
                    >
                      ${icon("pause", 22)}
                    </button>
                  `
                : nothing
            }
          </div>
          <div class="image-gallery__toolbar">
            ${this.images.length > 1 ? iconButton({ icon: "chevron_left", label: uiText(this.locale, "previousImage"), disabled: index === 0, onClick: () => this.select(index - 1) }) : nothing}
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
            ${this.images.length > 1 ? iconButton({ icon: "chevron_right", label: uiText(this.locale, "nextImage"), disabled: index === this.images.length - 1, onClick: () => this.select(index + 1) }) : nothing}
            <a
              class="icon-button"
              href=${active.videoSequence?.clips[0]?.url || candidates[0]}
              target="_blank"
              rel="noopener"
              aria-label=${uiText(this.locale, "originalImage")}
              title=${uiText(this.locale, "originalImage")}
            >
              ${icon("open_in_new", 20)}
            </a>
          </div>
          ${this.renderThumbnails(index)}
        </section>
      `;
    }
    return html`
      <section class="image-gallery" aria-label=${this.title || uiText(this.locale, "image")}>
        <div class="image-gallery__stagewrap">
          <a
            class="image-gallery__stage"
            href=${candidates[0]}
            target="_blank"
            rel="noopener"
            aria-label=${`${uiText(this.locale, "zoom")} · ${active.label}`}
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
                    aria-label=${uiText(this.locale, "cardMovieAnimated")}
                    title=${uiText(this.locale, "cardMovieAnimated")}
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
          ${this.images.length > 1 ? iconButton({ icon: "chevron_left", label: uiText(this.locale, "previousImage"), disabled: index === 0, onClick: () => this.select(index - 1) }) : nothing}
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
          ${this.images.length > 1 ? iconButton({ icon: "chevron_right", label: uiText(this.locale, "nextImage"), disabled: index === this.images.length - 1, onClick: () => this.select(index + 1) }) : nothing}
          <a
            class="icon-button"
            href=${this.dimensions.get(active.source)?.src || candidates[0]}
            target="_blank"
            rel="noopener"
            aria-label=${uiText(this.locale, "originalImage")}
            title=${uiText(this.locale, "originalImage")}
          >
            ${icon("open_in_new", 20)}
          </a>
        </div>
        ${this.renderThumbnails(index)}
        ${
          this.busy
            ? html`
                <p class="image-gallery__status" role="status">${uiText(this.locale, "loading")}</p>
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
