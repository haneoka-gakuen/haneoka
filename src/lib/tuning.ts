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
    const previous = root.dataset.seed || "haneoka";
    if (generated) seedStyle(generated.css);
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
