/**
 * "Tuning": the site's Material 3 color scheme is seeded by a band colour.
 * Every scheme is precomputed in packages/design-tokens/src/schemes.css, so a
 * tuning change is a single attribute flip on <html> — no color math at runtime.
 */
import { DYNAMIC_SEED } from "./themes";

export const SEED_KEY = "haneoka.ui-seed.v1";
/** The generated scheme of a character or seasonal seed, read by the boot script before first paint. */
export const SEED_CSS_KEY = "haneoka.ui-seed-css.v1";
export const SEEDS = ["haneoka", "band-1", "band-2", "band-3", "band-4", "band-5"] as const;
export type Seed = string;
export const SEED_EVENT = "haneoka:seed-change";

/** A seasonal seed's decoration as the boot script and the effect layer read it. */
export interface SeasonMark {
  id: string;
  motif: string;
  ornament: string;
  shape: string;
}
/** Today's automatic seasonal theme, applied unless the reader picked a theme while it was open. */
export const SEASON_AUTO_KEY = "haneoka.ui-season-auto.v1";
/** Set when the reader picks a theme during an automatic season: that season stays off until it closes. */
export const SEASON_OVERRIDE_KEY = "haneoka.ui-season-override.v1";
/** The day the boot script compares the automatic theme against: the local date (seasons) and Japan's (birthdays). */
export const localDay = (date = new Date()) =>
  `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}/${new Date(date.getTime() + 32_400_000).toISOString().slice(0, 10)}`;
export interface AutoSeason {
  day: string;
  seed: string | null;
  css?: string;
  season?: SeasonMark;
  closes?: number | null;
}
export interface GeneratedSeed {
  css: string;
  /** When a seasonal seed closes: the page returns to `fallback`. */
  closes: number | null;
  season: SeasonMark | null;
}

export const isSeed = (value: unknown): value is Seed =>
  (SEEDS as readonly unknown[]).includes(value) || (typeof value === "string" && DYNAMIC_SEED.test(value));

export function seedStyle(css: string) {
  let style = document.getElementById("haneoka-seed-scheme");
  if (!style) {
    style = document.createElement("style");
    style.id = "haneoka-seed-scheme";
    document.head.append(style);
  }
  style.textContent = css;
}
export const seedForBand = (bandId: unknown): Seed => {
  const seed = `band-${Number(bandId)}`;
  return isSeed(seed) ? seed : "haneoka";
};

export function currentSeed(): Seed {
  const value = document.documentElement.dataset.seed;
  return isSeed(value) ? value : "haneoka";
}

/** Keeps the browser chrome (address bar / PWA title bar) on the tuned surface colour. */
export function syncThemeColor() {
  const value = getComputedStyle(document.documentElement).getPropertyValue("--md-sys-color-surface-container").trim();
  if (value) document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute("content", value);
}

/**
 * Re-tunes the page. When the browser supports view transitions the new scheme
 * spreads from `origin` as a circular reveal (Material's "container transform"
 * energy, 500ms emphasized-decelerate); otherwise — or with reduced motion — it
 * switches instantly.
 */
export function applySeed(seed: Seed, origin?: { x: number; y: number }, generated?: GeneratedSeed) {
  const root = document.documentElement;
  if (root.dataset.seed === seed) return;
  const commit = () => {
    let previous = "haneoka";
    try {
      previous = localStorage.getItem(SEED_KEY) || previous;
      const auto = JSON.parse(localStorage.getItem(SEASON_AUTO_KEY) || "null") as AutoSeason | null;
      if (auto?.seed && auto.day === localDay())
        localStorage.setItem(SEASON_OVERRIDE_KEY, JSON.stringify({ seed: auto.seed, until: auto.closes ?? 0 }));
    } catch {}
    if (generated) seedStyle(generated.css);
    delete root.dataset.seedAuto;
    root.dataset.seed = seed;
    if (generated?.season) root.dataset.season = generated.season.id;
    else delete root.dataset.season;
    try {
      localStorage.setItem(SEED_KEY, seed);
      if (generated) {
        // Only a precomputed scheme outlives the cache this seed replaces.
        const fallback = (SEEDS as readonly string[]).includes(previous) ? previous : "haneoka";
        localStorage.setItem(SEED_CSS_KEY, JSON.stringify({ seed, ...generated, fallback }));
      } else localStorage.removeItem(SEED_CSS_KEY);
    } catch {
      // Private mode: the tuning simply lasts for this page view.
    }
    syncThemeColor();
    window.dispatchEvent(new CustomEvent(SEED_EVENT, { detail: seed }));
  };
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const start = (
    document as Document & {
      startViewTransition?: (callback: () => void) => { ready: Promise<void>; finished: Promise<void> };
    }
  ).startViewTransition;
  if (!start || reduced) {
    commit();
    return;
  }
  root.classList.add("is-tuning");
  const transition = start.call(document, commit);
  const x = origin?.x ?? innerWidth / 2;
  const y = origin?.y ?? innerHeight / 2;
  const radius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
  transition.ready
    .then(() => {
      root.animate(
        { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
        { duration: 500, easing: "cubic-bezier(0.05, 0.7, 0.1, 1)", pseudoElement: "::view-transition-new(root)" },
      );
    })
    .catch(() => {});
  transition.finished.finally(() => root.classList.remove("is-tuning"));
}
