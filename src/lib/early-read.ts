import { JsonResponseError } from "../lit/shared/catalog";

/*
 * Document-start reads.
 *
 * A page's inline head script may start the GET requests its workspace is
 * certain to make while stylesheets and the module graph are still
 * downloading, registering each under window.__haneokaEarlyReads[url]. The
 * workspace adopts an entry only for the identical URL, only once, and only
 * shortly after it started; anything else is read normally. Each request
 * carried this browser's cookie like any other read, so it answers for the
 * same viewer the workspace would observe, and a session change drops every
 * pending entry.
 */

interface EarlyRead { at: number; response: Promise<Response | null> }
type EarlyWindow = Window & { __haneokaEarlyReads?: Record<string, EarlyRead> };
const EARLY_READ_MS = 10_000;

if (typeof window !== "undefined")
  window.addEventListener("haneoka:session-changed", () => { delete (window as EarlyWindow).__haneokaEarlyReads; });

/** The pending response for exactly this URL, consumed once; null when there is none. */
export function takeEarlyRead(url: string): Promise<Response | null> | null {
  if (typeof window === "undefined") return null;
  const reads = (window as EarlyWindow).__haneokaEarlyReads;
  const early = reads && Object.hasOwn(reads, url) ? reads[url] : undefined;
  if (!early) return null;
  delete reads![url];
  return performance.now() - early.at < EARLY_READ_MS ? early.response : null;
}

/**
 * Start a read the next page will make (a hovered or pressed link), unless
 * the same read is already pending. The next page adopts it like a
 * document-start read.
 */
export function prefetchEarlyRead(url: string) {
  if (typeof window === "undefined") return;
  const reads = ((window as EarlyWindow).__haneokaEarlyReads ||= {});
  const existing = Object.hasOwn(reads, url) ? reads[url] : undefined;
  if (existing && performance.now() - existing.at < EARLY_READ_MS) return;
  reads[url] = {
    at: performance.now(),
    response: fetch(url, { credentials: "same-origin", cache: "no-store", headers: { accept: "application/json" } })
      .catch(() => null),
  };
}

/** Drop every entry nobody adopted (the workspace chose different requests). */
export function discardEarlyReads() {
  if (typeof window !== "undefined") delete (window as EarlyWindow).__haneokaEarlyReads;
}

const aborted = (signal: AbortSignal) => new Promise<never>((_, reject) => {
  if (signal.aborted) reject(signal.reason);
  signal.addEventListener("abort", () => reject(signal.reason), { once: true });
});

/**
 * The adopted response with fetchJson's contract (JsonResponseError for HTTP
 * failures), or undefined when the early request itself failed and the caller
 * should read normally.
 */
export async function readEarlyJson<T>(early: Promise<Response | null>, signal: AbortSignal): Promise<T | undefined> {
  const response = await Promise.race([early, aborted(signal)]);
  if (!response) return undefined;
  const read = response.text().then((text) => {
    let value: unknown = null;
    try {
      value = text || response.status !== 204 ? JSON.parse(text) : null;
    } catch (error) {
      if (!response.ok) throw new JsonResponseError(response.status, null);
      throw error;
    }
    if (!response.ok) {
      const data = value && typeof value === "object" ? value as Record<string, unknown> : {};
      const detail = data.error && typeof data.error === "object" ? data.error as Record<string, unknown> : {};
      throw new JsonResponseError(response.status, value, String(detail.message || data.message || `HTTP ${response.status}`));
    }
    return value as T;
  });
  return Promise.race([read, aborted(signal)]);
}
