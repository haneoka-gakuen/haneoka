// L3 — GEB
// Input: Localized song records, interface locale and the reader's explicit title preference.
// Output: Display title with its source language; English/Korean localized defaults and preference notifications.
// Pos: [Map](L2-2.md); shared song title policy for catalogue and tools.
// Effects/Dependencies: Stores an explicit preference locally, synchronizes in-window caches through event detail and observes cross-window storage changes.
import { resolveLocalizedText } from "./localized-text";

const KEY = "haneoka:song-display:v1";
export const SONG_DISPLAY_EVENT = "haneoka:song-display";
let cached: boolean | null | undefined;
/** The reader's explicit choice, or null when they have not made one. */
function storedChoice(): boolean | null {
  if (cached !== undefined) return cached;
  try {
    const value = JSON.parse(localStorage.getItem(KEY) || "{}").forceJapaneseTitles;
    return (cached = typeof value === "boolean" ? value : null);
  } catch {
    return null;
  }
}
/** Build-time defaults also apply until the reader chooses a title language. */
export const defaultJapaneseSongTitles = (locale: string): boolean => locale !== "en" && locale !== "ko";
/** A song's built title in [locale] from its per-locale titles, by the default above. */
export function defaultSongTitle<L extends string>(titles: Record<L, string>, locale: L): string {
  return (defaultJapaneseSongTitles(locale) && titles["ja" as L]) || titles[locale];
}
/** English and Korean pages default to localized titles; an explicit choice applies across locales. */
export function japaneseSongTitles(locale: string): boolean {
  return storedChoice() ?? defaultJapaneseSongTitles(locale);
}
export function setJapaneseSongTitles(enabled: boolean): void {
  cached = enabled;
  try {
    localStorage.setItem(KEY, JSON.stringify({ forceJapaneseTitles: enabled }));
  } catch {}
  dispatchEvent(new CustomEvent(SONG_DISPLAY_EVENT, { detail: enabled }));
}
export function observeSongDisplay(update: () => void): () => void {
  const changed = (event: Event) => {
    cached = (event as CustomEvent<boolean>).detail;
    update();
  };
  const storage = (event: StorageEvent) => {
    if (event.key === KEY || event.key === null) {
      cached = undefined;
      update();
    }
  };
  addEventListener(SONG_DISPLAY_EVENT, changed);
  addEventListener("storage", storage);
  return () => {
    removeEventListener(SONG_DISPLAY_EVENT, changed);
    removeEventListener("storage", storage);
  };
}
export function songTitle(song: Record<string, unknown>, locale: string) {
  const requested = japaneseSongTitles(locale) ? "ja" : locale;
  const resolved =
    [song.musicTitle, song.title, song.name]
      .map((value) => resolveLocalizedText(value, requested))
      .find((value) => value.text) ?? resolveLocalizedText(undefined, requested);
  return { ...resolved, text: resolved.text || String(song.musicId || song.id || "—") };
}
