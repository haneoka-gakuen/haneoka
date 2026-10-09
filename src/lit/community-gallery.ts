import { LitElement, html, nothing } from "lit";
import { keyed } from "lit/directives/keyed.js";
import { clientText } from "../i18n/client";
import { trapFocus } from "../lib/overlay";
import { icon } from "./ui/icon";
import type PhotoSwipe from "photoswipe";
import "photoswipe/style.css";
import { communityImageRatio, type CommunityImage } from "../lib/community-media-layout";
import { loadingIndicator } from "./ui/loading-indicator";

/** Message paths for this view's finite control/metadata identifiers. */
const uiLabelPaths: Readonly<Record<string, string>> = {
  "close": "common.actions.close",
  "error": "common.states.error",
  "loading": "common.states.loading",
  "nextImage": "media.images.actions.nextImage",
  "previousImage": "media.images.actions.previousImage",
  "unavailable": "common.states.unavailable",
  "video": "story.labels.video",
  "zoom": "media.models.labels.zoom"
};

export { communityImageRatio, type CommunityImage } from "../lib/community-media-layout";
export class CommunityGallery extends LitElement {
  static properties = {
    images: { attribute: false },
    locale: {},
    index: { state: true },
    busy: { state: true },
    error: { state: true },
  };
  declare images: CommunityImage[];
  declare locale: string;
  declare index: number;
  declare busy: boolean;
  declare error: string;
  private viewer?: PhotoSwipe;
  private isVideo(image: CommunityImage) {
    return !!image.playbackUrl || String(image.displayMediaType || image.mediaType || "").startsWith("video/");
  }
  private displaySource(image: CommunityImage) {
    return image.playbackUrl || image.previewUrl || image.contentUrl;
  }
  protected updated() {
    for (const video of this.querySelectorAll<HTMLVideoElement>("video"))
      if (Number(video.dataset.index) !== this.index) video.pause();
  }
  private releaseFocus?: () => void;
  private generation = 0;
  constructor() {
    super();
    this.images = [];
    this.locale = "en";
    this.index = 0;
    this.busy = false;
    this.error = "";
  }
  createRenderRoot() {
    return this;
  }
  disconnectedCallback() {
    this.generation++;
    for (const video of this.querySelectorAll<HTMLVideoElement>("video")) {
      video.pause();
      video.removeAttribute("src");
      video.load();
    }
    this.viewer?.destroy();
    this.releaseFocus?.();
    super.disconnectedCallback();
  }
  private text(key: string) {
    return clientText(this.locale, (uiLabelPaths[key] ?? key), key);
  }
  private select(index: number) {
    const track = this.querySelector<HTMLElement>(".community-gallery__track");
    track?.scrollTo({
      left: Math.max(0, Math.min(this.images.length - 1, index)) * track.clientWidth,
      behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth",
    });
  }
  private async zoom(index: number, event: MouseEvent) {
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button !== 0) return;
    event.preventDefault();
    if (this.busy || this.viewer) return;
    const generation = ++this.generation;
    this.busy = true;
    this.error = "";
    const trigger = event.currentTarget as HTMLElement;
    try {
      const { default: Viewer } = await import("photoswipe");
      if (!this.isConnected || this.generation !== generation) return;
      const indices = this.images.flatMap((entry, i) => (this.isVideo(entry) ? [] : [i]));
      const slides = indices.map((i) => {
        const entry = this.images[i];
        const image = this.querySelector<HTMLImageElement>(`img[data-index="${i}"]`);
        return {
          src: this.displaySource(entry),
          width: image?.naturalWidth || entry.displayWidth || entry.width || 1200,
          height: image?.naturalHeight || entry.displayHeight || entry.height || 1500,
          alt: entry.fileName || "",
        };
      });
      const viewer = new Viewer({
        dataSource: slides,
        index: indices.indexOf(index),
        showHideAnimationType: "fade",
        bgOpacity: 1,
        trapFocus: false,
        returnFocus: false,
        wheelToZoom: true,
        imageClickAction: "zoom",
        closeTitle: this.text("close"),
        zoomTitle: this.text("zoom"),
        arrowPrevTitle: this.text("previousImage"),
        arrowNextTitle: this.text("nextImage"),
        errorMsg: this.text("unavailable"),
      });
      this.viewer = viewer;
      viewer.on("afterInit", () => {
        if (viewer.element)
          this.releaseFocus = trapFocus(viewer.element, { onDismiss: () => viewer.close(), returnFocus: trigger });
      });
      viewer.on("destroy", () => {
        this.releaseFocus?.();
        this.releaseFocus = undefined;
        this.viewer = undefined;
      });
      viewer.on("change", () => this.select(indices[viewer.currIndex]));
      viewer.init();
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    } finally {
      if (generation === this.generation) this.busy = false;
    }
  }
  render() {
    if (!this.images.length) return nothing;
    return html`
      <section
        class="community-gallery"
        aria-label=${this.text("image")}
        style=${`--community-gallery-ratio:${communityImageRatio(this.images[0])}`}
      >
        <div
          class="community-gallery__track"
          @scroll=${(event: Event) => {
            const track = event.currentTarget as HTMLElement;
            this.index = Math.round(track.scrollLeft / Math.max(track.clientWidth, 1));
          }}
        >
          ${this.images.map((image, index) =>
            keyed(
              image.contentUrl,
              this.isVideo(image)
                ? html`
                    <div class="community-gallery__slide community-gallery__slide--video">
                      <video
                        data-index=${index}
                        controls
                        playsinline
                        preload="none"
                        .muted=${image.mediaType === "image/gif"}
                        ?loop=${image.mediaType === "image/gif"}
                        src=${index === this.index ? this.displaySource(image) : nothing}
                        poster=${image.posterUrl || image.thumbnailUrl || nothing}
                        aria-label=${image.fileName || this.text("video")}
                        @error=${() => (this.error = this.text("unavailable"))}
                      ></video>
                    </div>
                  `
                : html`
                    <a
                      class="community-gallery__slide"
                      href=${this.displaySource(image)}
                      target="_blank"
                      rel="noopener"
                      aria-label=${this.text("zoom")}
                      @click=${(event: MouseEvent) => this.zoom(index, event)}
                    >
                      ${loadingIndicator({ label: this.text("loading") })}
                      <img
                        src=${this.displaySource(image)}
                        data-index=${index}
                        width=${image.displayWidth || image.width || 1200}
                        height=${image.displayHeight || image.height || 1500}
                        alt=${image.fileName || ""}
                        loading=${index === 0 ? "eager" : "lazy"}
                        decoding="async"
                        @load=${(event: Event) => ((event.currentTarget as HTMLElement).parentElement!.dataset.state = "ready")}
                        @error=${(event: Event) => ((event.currentTarget as HTMLElement).parentElement!.dataset.state = "error")}
                      />
                      <span class="community-gallery__failure">${this.text("unavailable")}</span>
                      <span class="community-gallery__zoom" aria-hidden="true">${icon("zoom_in", 20)}</span>
                    </a>
                  `,
            ),
          )}
        </div>
        ${
          this.images.length > 1
            ? html`
                <div class="community-gallery__controls">
                  <button
                    class="icon-button"
                    type="button"
                    ?disabled=${this.index === 0}
                    aria-label=${this.text("previousImage")}
                    @click=${() => this.select(this.index - 1)}
                  >
                    ${icon("chevron_left", 20)}
                  </button>
                  <span aria-live="polite">${this.index + 1} / ${this.images.length}</span>
                  <button
                    class="icon-button"
                    type="button"
                    ?disabled=${this.index >= this.images.length - 1}
                    aria-label=${this.text("nextImage")}
                    @click=${() => this.select(this.index + 1)}
                  >
                    ${icon("chevron_right", 20)}
                  </button>
                </div>
              `
            : nothing
        }
        ${
          this.busy
            ? html`
                <span class="sr-only" role="status">${this.text("loading")}</span>
              `
            : nothing
        }
        ${
          this.error
            ? html`
                <p role="alert">${this.error}</p>
              `
            : nothing
        }
      </section>
    `;
  }
}
if (!customElements.get("community-gallery")) customElements.define("community-gallery", CommunityGallery);
