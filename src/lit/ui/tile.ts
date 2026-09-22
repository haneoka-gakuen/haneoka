import { html, nothing, type TemplateResult } from "lit";
import { icon } from "./icon";

/**
 * Collection tile.
 *
 * Artwork plus a two-line identity, rendered as a real <button> so the
 * platform supplies activation, focus and role. The previous tiles were
 * `<article role="button" tabindex="0">` with hand-written Enter/Space
 * handlers — which is a button, minus everything a button gives you for free.
 *
 * Marks (rarity, attribute, level, category) are positioned overlays on the
 * artwork rather than extra rows, which is what keeps a grid of 2,000 cards
 * scannable.
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
  title: unknown;
  /** null hides the supporting line entirely; "" reserves its height. */
  subtitle?: unknown;
  /** 16dp emblem before the supporting text (band logo, attribute). */
  adornment?: unknown;
  label: string;
  image: string;
  imageFallback?: string;
  /** Rendered when the resource has no artwork: a rendered 32dp icon. */
  placeholder?: unknown;
  /** Presentation hook, e.g. "song" → `.tile--song`. */
  kind?: string;
  marks?: ReadonlyArray<TileMark | null | undefined>;
  selected?: boolean;
  onOpen: () => void;
  onImageError?: (event: Event) => void;
  style?: string;
  /** Extra content below the identity (a fact row, a play button). */
  extra?: unknown;
  /** `contain` for logos and items that must not be cropped. */
  fit?: "cover" | "contain";
}

const markClass = (mark: TileMark) =>
  ["tile__mark", `tile__mark--${mark.at}`, mark.accent ? "tile__mark--accent" : ""].filter(Boolean).join(" ");

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
      aria-label=${options.label}
      aria-selected=${options.selected === undefined ? nothing : String(options.selected)}
      style=${options.style || nothing}
      @click=${options.onOpen}
    >
      <span class=${`tile__media ${options.fit === "contain" ? "tile__media--contain" : ""}`}>
        ${
          options.image
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
            : (options.placeholder ?? icon("image", 32))
        }
        ${(options.marks || []).map((mark) =>
          mark
            ? html`
                <span class=${markClass(mark)} style=${mark.accent ? `--mark:${mark.accent}` : nothing}>
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
      ${options.extra ?? nothing}
    </button>
  `;
}
