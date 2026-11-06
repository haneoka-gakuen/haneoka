import { SPOILER_COOKIE } from "./spoiler-cookie";
export { SPOILER_COOKIE, spoilerCookieEnabled } from "./spoiler-cookie";
export const SPOILER_STORAGE_KEY = "haneoka:spoiler-content:v1";
export const SPOILER_CONTENT_EVENT = "haneoka:spoiler-content";

export function spoilerContentEnabled(): boolean {
  try {
    const stored = localStorage.getItem(SPOILER_STORAGE_KEY);
    if (stored !== null) return stored === "1";
  } catch {}
  return true;
}

export function setSpoilerContentEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(SPOILER_STORAGE_KEY, enabled ? "1" : "0");
  } catch {}
  document.cookie = `${SPOILER_COOKIE}=${enabled ? "1" : "0"}; Path=/; Max-Age=31536000; SameSite=Lax${location.protocol === "https:" ? "; Secure" : ""}`;
  document.documentElement.dataset.spoilerContent = enabled ? "1" : "0";
  dispatchEvent(new Event(SPOILER_CONTENT_EVENT));
}

export function observeSpoilerContent(update: () => void): () => void {
  const storage = (event: StorageEvent) => {
    if (event.key === SPOILER_STORAGE_KEY || event.key === null) update();
  };
  addEventListener(SPOILER_CONTENT_EVENT, update);
  addEventListener("storage", storage);
  return () => {
    removeEventListener(SPOILER_CONTENT_EVENT, update);
    removeEventListener("storage", storage);
  };
}
