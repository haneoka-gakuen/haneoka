import { html, nothing, type TemplateResult } from "lit";
import { icon } from "./icon";

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
  /** Subhead: body-medium, one line. null drops it; "" reserves its height. */
  subtitle?: unknown;
  /** 16dp emblem before the subhead (band logo, attribute). */
  adornment?: unknown;
  label: string;
  image: string;
  imageFallback?: string;
  /** Rendered when the resource has no artwork: a rendered 32dp icon. */
  placeholder?: unknown;
  media?: unknown;
  /** Presentation hook, e.g. "song" → `.tile--song`. */
  kind?: string;
  marks?: ReadonlyArray<TileMark | null | undefined>;
  /**
   * Only for a tile that *is* a chooser — a band in the roster, a model in
   * the viewer. A tile that opens a detail must leave this undefined: the
   * detail covers the grid, so a selected tile is an invisible state nobody
   * can act on.
   */
  selected?: boolean;
  onOpen: () => void;
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

export function tile(options: TileOptions): TemplateResult {
  const classes = [
    "tile",
    "tile--interactive",
    options.kind ? `tile--${options.kind}` : "",
    options.selected ? "is-selected" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return html`
    <button
      class=${classes}
      type="button"
      role=${options.role ?? nothing}
      aria-controls=${options.controls ?? nothing}
      tabindex=${options.tabIndex ?? nothing}
      aria-label=${options.label}
      aria-selected=${options.selected === undefined ? nothing : String(options.selected)}
      style=${options.style || nothing}
      @click=${options.onOpen}
    >
      <span class=${`tile__media ${options.fit ? `tile__media--${options.fit}` : ""}`}>
        ${
          options.media ??
          (options.image
            ? html`
                <img
                  data-src=${options.image}
                  data-fallback=${options.imageFallback || nothing}
                  alt=""
                  decoding="async"
                  @load=${(event: Event) => (event.currentTarget as HTMLImageElement).classList.add("is-loaded")}
                  @error=${options.onImageError}
                />
              `
            : (options.placeholder ?? icon("image", 32)))
        }
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
      </span>
      <span class="tile__identity">
        <strong class="tile__title">${options.title}</strong>
        ${
          options.subtitle === null || options.subtitle === undefined
            ? nothing
            : html`
                <small class="tile__subtitle">
                  ${options.adornment ?? nothing}
                  <span>${options.subtitle || " "}</span>
                </small>
              `
        }
      </span>
    </button>
  `;
}
