/**
 * "Tuning": the site's Material 3 color scheme is seeded by a band colour.
 * Every scheme is precomputed in packages/design-tokens/src/schemes.css, so a
 * tuning change is a single attribute flip on <html> — no color math at runtime.
 */
export const SEED_KEY = "haneoka.ui-seed.v1";
export const SEEDS = ["haneoka", "band-1", "band-2", "band-3", "band-4", "band-5"] as const;
export type Seed = (typeof SEEDS)[number];
export const SEED_EVENT = "haneoka:seed-change";

export const isSeed = (value: unknown): value is Seed => (SEEDS as readonly unknown[]).includes(value);
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
export function applySeed(seed: Seed, origin?: { x: number; y: number }) {
  const root = document.documentElement;
  if (root.dataset.seed === seed) return;
  const commit = () => {
    root.dataset.seed = seed;
    try {
      localStorage.setItem(SEED_KEY, seed);
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
