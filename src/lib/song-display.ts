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
/** What a reader who has not chosen sees: Japanese titles except on English pages. Build-time pages use it. */
export const defaultJapaneseSongTitles = (locale: string): boolean => locale !== "en";
/** A song's built title in [locale] from its per-locale titles, by the default above. */
export function defaultSongTitle<L extends string>(titles: Record<L, string>, locale: L): string {
  return (defaultJapaneseSongTitles(locale) && titles["ja" as L]) || titles[locale];
}
/** Japanese titles unless the reader chose otherwise; English pages default to their own titles. */
export function japaneseSongTitles(locale: string): boolean {
  return storedChoice() ?? defaultJapaneseSongTitles(locale);
}
export function setJapaneseSongTitles(enabled: boolean): void {
  cached = enabled;
  try {
    localStorage.setItem(KEY, JSON.stringify({ forceJapaneseTitles: enabled }));
  } catch {}
  dispatchEvent(new Event(SONG_DISPLAY_EVENT));
}
export function observeSongDisplay(update: () => void): () => void {
  const storage = (event: StorageEvent) => {
    if (event.key === KEY || event.key === null) {
      cached = undefined;
      update();
    }
  };
  addEventListener(SONG_DISPLAY_EVENT, update);
  addEventListener("storage", storage);
  return () => {
    removeEventListener(SONG_DISPLAY_EVENT, update);
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
