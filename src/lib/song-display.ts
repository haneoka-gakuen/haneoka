import { resolveLocalizedText } from "./localized-text";

const KEY = "haneoka:song-display:v1";
export const SONG_DISPLAY_EVENT = "haneoka:song-display";
let cached: boolean | undefined;
export function japaneseSongTitles(): boolean {
  if (cached !== undefined) return cached;
  try {
    return (cached = JSON.parse(localStorage.getItem(KEY) || "{}").forceJapaneseTitles === true);
  } catch {
    return false;
  }
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
  const value = song.musicTitle || song.title || song.name;
  const resolved = resolveLocalizedText(value, japaneseSongTitles() ? "ja" : locale);
  return { ...resolved, text: resolved.text || String(song.musicId || song.id || "—") };
}
