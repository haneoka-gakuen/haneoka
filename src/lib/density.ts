/**
 * Density: Material 3's density levels, exposed as a reader control.
 *
 * An archive is read at two distances — scanning a whole collection, and
 * comparing a handful of rows — and those want different row heights. Rather
 * than guessing one value, the browse bar offers both and every list, table
 * and grid derives its metrics from the --row-height / --tile-min tokens in
 * base/tokens.css. Like tuning, this is a single attribute flip on <html>:
 * no component re-measures anything.
 */
export const DENSITY_KEY = "haneoka.ui-density.v1";
export const DENSITY_EVENT = "haneoka:density-change";
export const DENSITIES = ["comfortable", "compact"] as const;
export type Density = (typeof DENSITIES)[number];

export const isDensity = (value: unknown): value is Density => (DENSITIES as readonly unknown[]).includes(value);

export function currentDensity(): Density {
  const value = document.documentElement.dataset.density;
  return isDensity(value) ? value : "comfortable";
}

export function applyDensity(density: Density) {
  const root = document.documentElement;
  if (currentDensity() === density) return;
  root.dataset.density = density;
  try {
    localStorage.setItem(DENSITY_KEY, density);
  } catch {
    // Private mode: the choice lasts for this page view.
  }
  window.dispatchEvent(new CustomEvent(DENSITY_EVENT, { detail: density }));
}

export const toggleDensity = () => applyDensity(currentDensity() === "compact" ? "comfortable" : "compact");
