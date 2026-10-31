/** The decoration of a seasonal theme: an effect layer of its motif over the page, an ornament on the brand mark, and
 * a burst of the motif where the theme was picked. Effects stay off with reduced motion or when the reader turns
 * them off; the ornament and the brand shape remain. */
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

/** One particle of a motif, as markup and the animation it runs. */
function particle(motif: string, index: number): TemplateResult {
  switch (motif) {
    case "snow":
      return index % 3 ? html`<i class="season-dot"></i>` : icon("ac_unit", 16);
    case "hearts":
      return icon("favorite", 18);
    case "sparkles":
      return icon("auto_awesome", 18);
    case "stars":
      return index % 4 ? icon("star", 12) : html`<i class="season-streak"></i>`;
    case "moon":
      return html`<i class="season-dot"></i>`;
    case "bats":
      return BAT;
    case "lanterns":
      return LANTERN;
    case "petals":
      return html`<i class="season-petal"></i>`;
    case "beans":
      return html`<i class="season-dot"></i>`;
    case "fireworks":
      return html`<i class="season-burst">${Array.from({ length: 10 }, () => html`<b></b>`)}</i>`;
    default:
      return html`<i class="season-confetti"></i>`;
  }
}

const random = (seed: number) => {
  const value = Math.sin(seed * 9301 + 49297) * 233280;
  return value - Math.floor(value);
};

function layer(motif: string) {
  const count = matchMedia("(max-width: 600px)").matches ? 10 : 18;
  return html`
    ${motif === "moon" ? html`<i class="season-moon"></i>` : nothing}
    ${Array.from({ length: count }, (_, index) => {
      const style = [
        `--x:${(random(index + 1) * 100).toFixed(1)}%`,
        `--y:${(random(index + 41) * 70).toFixed(1)}%`,
        `--delay:${(-random(index + 7) * 16).toFixed(2)}s`,
        `--duration:${(10 + random(index + 13) * 10).toFixed(2)}s`,
        `--scale:${(0.6 + random(index + 29) * 0.8).toFixed(2)}`,
        `--sway:${((random(index + 3) - 0.5) * 120).toFixed(0)}px`,
        `--tone:${index % 3}`,
      ].join(";");
      return html`<span class="season-particle" data-tone=${index % 3} style=${style}>${particle(motif, index)}</span>`;
    })}
  `;
}

/** Brings the page's decoration in line with the current seed. */
export function syncSeason() {
  const season = mark();
  const brand = document.querySelector<HTMLElement>(".nav__brand");
  brand?.querySelector(".season-ornament")?.remove();
  let host = document.querySelector<HTMLElement>("body > .season-layer");
  if (!season) {
    document.documentElement.style.removeProperty("--season-shape");
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
    host?.remove();
    return;
  }
  if (host?.dataset.motif === season.motif) return;
  host?.remove();
  host = document.createElement("div");
  host.className = "season-layer";
  host.dataset.motif = season.motif;
  host.setAttribute("aria-hidden", "true");
  render(layer(season.motif), host);
  document.body.append(host);
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
