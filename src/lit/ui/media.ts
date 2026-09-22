/**
 * Window size class queries, shared so components agree on the breakpoints
 * Material defines rather than each picking its own number.
 */
export const COMPACT = "(max-width: 599px)";
export const MEDIUM_UP = "(min-width: 600px)";
export const EXPANDED = "(min-width: 1200px)";

export const matches = (query: string) => typeof matchMedia === "function" && matchMedia(query).matches;

/**
 * Calls `onChange` whenever the query flips, and returns a dispose function.
 * The initial value is not delivered — read it with `matches()` when setting
 * up component state, which keeps the first render synchronous.
 */
export function watchMedia(query: string, onChange: (value: boolean) => void): () => void {
  if (typeof matchMedia !== "function") return () => {};
  const media = matchMedia(query);
  const handler = (event: MediaQueryListEvent) => onChange(event.matches);
  media.addEventListener("change", handler);
  return () => media.removeEventListener("change", handler);
}
