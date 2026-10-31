/** The decoration of a seasonal theme: a background of its motif behind the page, an ornament on the brand mark, and
 * a burst of the motif where the theme was picked. The background holds still with reduced motion; the reader can turn
 * it off and keep the ornament and the brand shape. */
import { html, nothing, render, type TemplateResult } from "lit";
import { icon } from "../lit/ui/icon";
import { SEASON_AUTO_KEY, SEED_CSS_KEY, type SeasonMark } from "./tuning";
import "../styles/components/seasonal.css";

export const EFFECTS_KEY = "haneoka.ui-season-effects.v1";

export function effectsEnabled(): boolean {
  try {
    return localStorage.getItem(EFFECTS_KEY) !== "off";
  } catch {
    return true;
  }
}

export function setEffectsEnabled(on: boolean) {
  try {
    if (on) localStorage.removeItem(EFFECTS_KEY);
    else localStorage.setItem(EFFECTS_KEY, "off");
  } catch {}
  syncSeason();
}

function mark(): SeasonMark | null {
  if (!document.documentElement.dataset.season) return null;
  try {
    const key = document.documentElement.dataset.seedAuto ? SEASON_AUTO_KEY : SEED_CSS_KEY;
    return (JSON.parse(localStorage.getItem(key) || "null")?.season as SeasonMark | null) ?? null;
  } catch {
    return null;
  }
}

const BAT = html`<svg viewBox="0 0 24 12" aria-hidden="true"><path d="M12 3c.6-1 1.4-1.6 1.4-1.6l.3 1.4c1.6-.4 3.3-.2 4.6.6 1.4.9 3.4.9 5.7.1-1.3 1.3-2.2 3-2.4 5-1-.8-2.4-1-3.6-.6-.6-1.3-1.9-2-3.3-1.8-.4.9-1.6 1.7-2.7 2.5-1.1-.8-2.3-1.6-2.7-2.5-1.4-.2-2.7.5-3.3 1.8-1.2-.4-2.6-.2-3.6.6C2.2 6.5 1.3 4.8 0 3.5c2.3.8 4.3.8 5.7-.1 1.3-.8 3-1 4.6-.6l.3-1.4S11.4 2 12 3Z"/></svg>`;
const LANTERN = html`<svg viewBox="0 0 16 24" aria-hidden="true"><path d="M6 0h4v2H6zM2.5 3h11C15 5 16 8 16 12s-1 7-2.5 9h-11C1 19 0 16 0 12s1-7 2.5-9ZM6 22h4v2H6z"/></svg>`;

/** One motif glyph: a Material symbol, or the bat, lantern, petal or dot the symbols lack. */
function particle(motif: string, index: number): TemplateResult {
  switch (motif) {
    case "snow":
      return index % 3 ? html`<i class="season-dot"></i>` : icon("ac_unit", 24);
    case "hearts":
      return icon("favorite", 24);
    case "sparkles":
    case "fireworks":
      return index % 3 ? icon("auto_awesome", 24) : html`<i class="season-dot"></i>`;
    case "stars":
      return index % 3 ? icon("star", 24) : html`<i class="season-dot"></i>`;
    case "bats":
      return BAT;
    case "lanterns":
      return LANTERN;
    case "petals":
      return html`<i class="season-petal"></i>`;
    case "moon":
    case "beans":
      return html`<i class="season-dot"></i>`;
    default:
      return html`<i class="season-confetti"></i>`;
  }
}

const random = (seed: number) => {
  const value = Math.sin(seed * 9301 + 49297) * 233280;
  return value - Math.floor(value);
};

/** Depths from far to near: how many glyphs, their size, blur and scroll speed. */
const DEPTHS = [
  { count: 5, size: [56, 88], blur: 6, opacity: 0.3, speed: 0.4 },
  { count: 8, size: [22, 32], blur: 1.5, opacity: 0.55, speed: 1 },
  { count: 14, size: [14, 22], blur: 0, opacity: 0.75, speed: 1.2 },
];

/** The background: a wash in the theme's colours, three facets, and the motif scattered over three depths that
 * drift slowly and move with scrolling at their own speed. */
function layer(motif: string) {
  const narrow = matchMedia("(max-width: 600px)").matches;
  return html`
    <div class="season-wash"></div>
    <svg class="season-facets" viewBox="0 0 1600 900" preserveAspectRatio="none">
      <polygon points="0,0 380,0 0,820" fill-opacity="0.9"></polygon>
      <polygon points="250,0 1600,0 1600,380 1040,250" fill-opacity="0.55"></polygon>
      <polygon points="120,900 1040,250 1600,380 1600,900" fill-opacity="0.75"></polygon>
    </svg>
    ${motif === "moon" ? html`<i class="season-moon"></i>` : nothing}
    ${DEPTHS.map((depth, layerIndex) => html`
      <div class="season-depth" style=${`--speed:${depth.speed};--blur:${depth.blur}px;--opacity:${depth.opacity}`}>
        ${Array.from({ length: narrow ? Math.ceil(depth.count / 2) : depth.count }, (_, index) => {
          const seed = layerIndex * 97 + index + 1;
          const size = depth.size[0]! + random(seed + 3) * (depth.size[1]! - depth.size[0]!);
          const style = [
            `--x:${(random(seed) * 100).toFixed(1)}%`,
            `--y:${(random(seed + 41) * 100).toFixed(1)}%`,
            `--size:${size.toFixed(0)}px`,
            `--angle:${((random(seed + 17) - 0.5) * 60).toFixed(0)}deg`,
            `--dx:${((random(seed + 5) - 0.5) * 32).toFixed(0)}px`,
            `--dy:${((random(seed + 9) - 0.5) * 40).toFixed(0)}px`,
            `--turn:${((random(seed + 11) - 0.5) * 24).toFixed(0)}deg`,
            `--duration:${(14 + random(seed + 13) * 14).toFixed(1)}s`,
            `--delay:${(-random(seed + 7) * 20).toFixed(1)}s`,
          ].join(";");
          return html`<span class="season-particle" data-tone=${index % 2} style=${style}>${particle(motif, index)}</span>`;
        })}
      </div>
    `)}
  `;
}

let scroller: HTMLElement | null = null;
let frame = 0;
const onScroll = () => {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    document.querySelector<HTMLElement>("body > .season-layer")?.style.setProperty("--scroll", String(scroller?.scrollTop ?? 0));
  });
};
/** Parallax follows the page's own scroll container, which a navigation replaces. */
function follow(element: HTMLElement | null) {
  scroller?.removeEventListener("scroll", onScroll);
  scroller = element;
  scroller?.addEventListener("scroll", onScroll, { passive: true });
  onScroll();
}

/** Brings the page's decoration in line with the current seed. */
export function syncSeason() {
  const season = mark();
  const brand = document.querySelector<HTMLElement>(".nav__brand");
  brand?.querySelector(".season-ornament")?.remove();
  let host = document.querySelector<HTMLElement>("body > .season-layer");
  if (!season) {
    document.documentElement.style.removeProperty("--season-shape");
    delete document.documentElement.dataset.seasonLayer;
    follow(null);
    host?.remove();
    return;
  }
  document.documentElement.style.setProperty("--season-shape", `var(${season.shape})`);
  if (brand) {
    const ornament = document.createElement("span");
    ornament.className = "season-ornament";
    ornament.setAttribute("aria-hidden", "true");
    render(ornamentIcon(season.ornament), ornament);
    brand.append(ornament);
  }
  if (!effectsEnabled()) {
    delete document.documentElement.dataset.seasonLayer;
    follow(null);
    host?.remove();
    return;
  }
  document.documentElement.dataset.seasonLayer = "";
  follow(document.getElementById("main-content"));
  if (host?.dataset.motif === season.motif) return;
  host?.remove();
  host = document.createElement("div");
  host.className = "season-layer";
  host.dataset.motif = season.motif;
  host.setAttribute("aria-hidden", "true");
  render(layer(season.motif), host);
  document.body.prepend(host);
}

/** The ornament names, written out for the icon sprite builder. */
function ornamentIcon(name: string) {
  switch (name) {
    case "skull":
      return icon("skull", 16);
    case "celebration":
      return icon("celebration", 16);
    case "mood_bad":
      return icon("mood_bad", 16);
    case "festival":
      return icon("festival", 16);
    case "favorite":
      return icon("favorite", 16);
    case "filter_vintage":
      return icon("filter_vintage", 16);
    case "redeem":
      return icon("redeem", 16);
    case "local_florist":
      return icon("local_florist", 16);
    case "sentiment_very_satisfied":
      return icon("sentiment_very_satisfied", 16);
    case "toys":
      return icon("toys", 16);
    case "auto_awesome":
      return icon("auto_awesome", 16);
    case "candle":
      return icon("candle", 16);
    case "bedtime":
      return icon("bedtime", 16);
    case "featured_seasonal_and_gifts":
      return icon("featured_seasonal_and_gifts", 16);
    default:
      return icon("cake", 16);
  }
}

/** A burst of the motif from where a seasonal theme was picked. */
export function celebrate(motif: string, origin: { x: number; y: number }) {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches || !effectsEnabled()) return;
  const host = document.createElement("div");
  host.className = "season-celebration";
  host.dataset.motif = motif;
  host.setAttribute("aria-hidden", "true");
  host.style.setProperty("--ox", `${origin.x}px`);
  host.style.setProperty("--oy", `${origin.y}px`);
  render(
    html`${Array.from({ length: 16 }, (_, index) => {
      const angle = (index / 16) * Math.PI * 2;
      const distance = 80 + random(index + 5) * 80;
      return html`<span
        class="season-particle"
        data-tone=${index % 3}
        style=${`--dx:${(Math.cos(angle) * distance).toFixed(0)}px;--dy:${(Math.sin(angle) * distance).toFixed(0)}px`}
        >${particle(motif === "fireworks" || motif === "moon" ? "sparkles" : motif, index + 1)}</span
      >`;
    })}`,
    host,
  );
  document.body.append(host);
  setTimeout(() => host.remove(), 1400);
}
