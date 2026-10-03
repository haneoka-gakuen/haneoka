import { html, nothing, type TemplateResult } from "lit";
import { ref } from "lit/directives/ref.js";
import { prepareMaterialProgress } from "../../lib/loading-progress";
import { icon } from "./icon";
import { nextImageCandidate } from "./lazy-images";
import "@material/web/progress/circular-progress.js";

/** Native Material progress; decorative by default inside a named media frame. */
export function mediaProgress(options: { label?: string; value?: number } = {}): TemplateResult {
  const value = typeof options.value === "number" && Number.isFinite(options.value)
    ? Math.min(1, Math.max(0, options.value)) : undefined;
  return html`
    <md-circular-progress
      ${ref(prepareMaterialProgress)}
      class="media-loading__progress"
      ?indeterminate=${value === undefined}
      .value=${value ?? 0}
      aria-label=${options.label ?? nothing}
      aria-hidden=${options.label ? nothing : "true"}
    ></md-circular-progress>
  `;
}

/**
 * Collection tile — a Material card with media.
 *
 * Full-bleed artwork, then a headline and a subhead. That is the whole
 * contract, and it is deliberately closed: no fact rows, no third line, no
 * per-page slot for "one more useful number". Dense data has two homes on
 * this site already (the list view and the table view); a tile exists so a
 * reader can recognise one thing in a grid of thousands and open it.
 *
 * Rendered as a real <button> so the platform supplies activation, focus and
 * role. The previous tiles were `<article role="button" tabindex="0">` with
 * hand-written Enter/Space handlers — which is a button, minus everything a
 * button gives you for free.
 *
 * Marks (rarity, attribute, category) are positioned overlays on the artwork,
 * never extra rows, which is what keeps the anatomy fixed at two lines.
 */

export interface TileMark {
  /** Corner to pin the mark to. */
  at: "start" | "end" | "bottom-start" | "bottom-end";
  /** Image source for a game emblem, or … */
  image?: string;
  /** … text for a level or category. */
  text?: unknown;
  /** Paint the mark in an accent colour instead of the translucent surface. */
  accent?: string;
  label?: string;
}

export interface TileOptions {
  /** Headline: title-medium, clamped to two lines. */
  title: unknown;
  titleLanguage?: string;
  /** Subhead: body-medium, one line. null drops it; "" reserves its height. */
  subtitle?: unknown;
  /** 16dp emblem before the subhead (band logo, attribute). */
  adornment?: unknown;
  label: string;
  image: string;
  imageFallback?: string;
  imageCandidates?: string[];
  /** Known source dimensions. They reserve the media before the request starts. */
  width?: number;
  height?: number;
  /** Explicit presentation or metadata ratio, expressed as a CSS ratio. */
  aspectRatio?: number | string;
  natural?: boolean;
  href?: string;
  /** Rendered when the resource has no artwork: a rendered 32dp icon. */
  placeholder?: unknown;
  media?: unknown;
  /** Presentation hook, e.g. "song" → `.tile--song`. */
  kind?: string;
  id?: string;
  marks?: ReadonlyArray<TileMark | null | undefined>;
  /** A verified publisher/exclusive-server emblem; separate from status/date marks. */
  serverMark?: { image: string; label: string };
  /**
   * Only for a tile that *is* a chooser — a band in the roster, a model in
   * the viewer. A tile that opens a detail must leave this undefined: the
   * detail covers the grid, so a selected tile is an invisible state nobody
   * can act on.
   */
  selected?: boolean;
  onOpen?: () => void;
  /** Entity id for the catalogue screen's delegated opening fallback. */
  itemId?: string;
  onImageError?: (event: Event) => void;
  style?: string;
  /** `contain` for logos and items that must not be cropped. */
  fit?: "cover" | "contain" | "fill";
  /**
   * `tab` when the tile is one of a set that switches what an adjacent region
   * shows — a chapter in the pane rail, a band in the roster rail. Pair it
   * with `controls` (the region's id) and `tabIndex` for roving focus.
   */
  role?: "tab";
  controls?: string;
  tabIndex?: number;
}

const markClass = (mark: TileMark) =>
  [
    "tile__mark",
    `tile__mark--${mark.at}`,
    mark.image && mark.text == null ? "tile__mark--image" : mark.accent ? "tile__mark--accent" : "",
  ]
    .filter(Boolean)
    .join(" ");

/** Returns a stable CSS ratio only when both indexed dimensions are valid. */
export function mediaAspectRatio(width: unknown, height: unknown): number | undefined {
  const numericWidth = Number(width);
  const numericHeight = Number(height);
  return Number.isFinite(numericWidth) && numericWidth > 0 && Number.isFinite(numericHeight) && numericHeight > 0
    ? numericWidth / numericHeight
    : undefined;
}

const KIND_MEDIA_RATIOS: Record<string, number | string> = {
  member: "3 / 4", support: "16 / 9", character: "3 / 4",
  comic: "4 / 3", story: "16 / 9", background: "16 / 9", system: "16 / 9",
  band: "3 / 1", song: 1, stamp: 1, item: 1, "band-item": 1, model: 1,
};

/** Artwork and native marks shared by grid tiles and compact identity rows. */
export function tileMedia(options: TileOptions): TemplateResult {
  const width = Number(options.width);
  const height = Number(options.height);
  const dimensionRatio = mediaAspectRatio(width, height);
  const ratio = dimensionRatio ?? options.aspectRatio ?? KIND_MEDIA_RATIOS[options.kind ?? ""];
  const mediaStyle = ratio === undefined ? undefined : `--tile-ratio:${ratio};aspect-ratio:${ratio}`;
  const onImageError = options.onImageError || nextImageCandidate;
  const onImageLoad = (event: Event) => {
    const square = options.aspectRatio === 1 || options.aspectRatio === "1" || options.aspectRatio === "1 / 1";
    if (!options.natural || dimensionRatio !== undefined || square) return;
    const image = event.currentTarget as HTMLImageElement;
    const nativeRatio = mediaAspectRatio(image.naturalWidth, image.naturalHeight);
    if (nativeRatio === undefined) return;
    const frame = image.parentElement;
    if (!frame?.classList.contains("tile__media")) return;
    frame.style.setProperty("--tile-ratio", String(nativeRatio));
    frame.style.aspectRatio = String(nativeRatio);
  };
  // Rendered as two plain templates rather than one static-html template with
  // a literal tag name: static templates lose their event-part wiring when the
  // bundler splits the lit modules across chunks in a different order, which
  // silently left every tile unclickable in production builds.
  return html`
    <span
      class=${`tile__media media-loading ${options.fit ? `tile__media--${options.fit}` : ""}${options.serverMark?.image ? " tile__media--server-mark" : ""}`}
      style=${mediaStyle || nothing}
    >
      ${
        options.media ??
        (options.image
          ? html`
              <img
                data-src=${options.image}
                data-fallback=${options.imageFallback || nothing}
                data-fallbacks=${options.imageCandidates ? JSON.stringify(options.imageCandidates) : nothing}
                alt=${options.label}
                width=${Number.isFinite(width) && width > 0 ? String(width) : nothing}
                height=${Number.isFinite(height) && height > 0 ? String(height) : nothing}
                decoding="async"
                @load=${onImageLoad}
                @error=${onImageError}
              />
            `
          : (options.placeholder ?? icon("image", 32)))
      }
      <span class="tile__media-state" role="img" aria-label=${options.label} title=${options.label}>
        ${icon("broken_image", 24)}
      </span>
      ${mediaProgress()}
      ${(options.marks || []).map((mark) =>
        mark
          ? html`
              <span
                class=${markClass(mark)}
                title=${mark.label || nothing}
                style=${mark.accent ? `--mark:${mark.accent}` : nothing}
              >
                ${
                  mark.image
                    ? html`
                        <img src=${mark.image} alt="" width="16" height="16" />
                      `
                    : nothing
                }
                ${mark.text ?? nothing}
              </span>
            `
          : nothing,
      )}
      ${options.serverMark?.image
        ? html`<span class="tile__server-mark" title=${options.serverMark.label}>
            <img src=${options.serverMark.image} alt=${options.serverMark.label} width="18" height="18" decoding="async" />
          </span>`
        : nothing}
    </span>
  `;
}

export function tile(options: TileOptions): TemplateResult {
  const label = [options.label, options.serverMark?.image ? options.serverMark.label : ""].filter(Boolean).join(" · ");
  const classes = [
    "tile",
    "tile--interactive",
    options.kind ? `tile--${options.kind}` : "",
    options.selected ? "is-selected" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const media = html`
    ${tileMedia(options)}
    <span class="tile__identity">
      <strong class="tile__title" lang=${options.titleLanguage || nothing}>${options.title}</strong>
      ${
        options.subtitle === null || options.subtitle === undefined
          ? nothing
          : html`
              <small class="tile__subtitle">
                ${options.adornment ?? nothing}
                <span>${options.subtitle || " "}</span>
              </small>
            `
      }
    </span>
  `;
  if (options.href)
    return html`
      <a
        id=${options.id || nothing}
        class=${classes}
        href=${options.href}
        data-open-item=${options.itemId ?? nothing}
        role=${options.role ?? nothing}
        aria-controls=${options.controls ?? nothing}
        tabindex=${options.tabIndex ?? nothing}
        aria-selected=${options.selected === undefined ? nothing : String(options.selected)}
        aria-label=${label}
        style=${options.style || nothing}
        @click=${options.onOpen ?? nothing}
      >
        ${media}
      </a>
    `;
  return html`
    <button
      id=${options.id || nothing}
      class=${classes}
      type="button"
      data-open-item=${options.itemId ?? nothing}
      aria-label=${label}
      role=${options.role ?? nothing}
      aria-controls=${options.controls ?? nothing}
      tabindex=${options.tabIndex ?? nothing}
      aria-selected=${options.selected === undefined ? nothing : String(options.selected)}
      style=${options.style || nothing}
      @click=${options.onOpen ?? nothing}
    >
      ${media}
    </button>
  `;
}
