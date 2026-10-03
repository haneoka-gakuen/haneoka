export interface DifficultyDisplayPreferences {
  readonly showDifficultyEstimates: boolean;
}

export const DIFFICULTY_DISPLAY_KEY = "haneoka:difficulty-display:v1";
export const DIFFICULTY_DISPLAY_EVENT = "haneoka:difficulty-display";

/** Missing, legacy and invalid values keep the experimental display off. */
export function normalizeDifficultyDisplayPreferences(value: unknown): DifficultyDisplayPreferences {
  const record = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
  return {
    showDifficultyEstimates: !!record && Object.hasOwn(record, "showDifficultyEstimates") && record.showDifficultyEstimates === true,
  };
}

let cached: boolean | undefined;
let cacheFresh = false;
let memoryOnly = false;
let observers = 0;

function refreshPersisted(force = false): void {
  if (memoryOnly && !force) {
    cacheFresh = true;
    return;
  }
  let raw: string | null;
  try {
    raw = localStorage.getItem(DIFFICULTY_DISPLAY_KEY);
  } catch {
    cached ??= false;
    cacheFresh = true;
    return;
  }
  try {
    cached = normalizeDifficultyDisplayPreferences(JSON.parse(raw || "null")).showDifficultyEstimates;
  } catch {
    cached = false;
  }
  memoryOnly = false;
  cacheFresh = true;
}

export function difficultyEstimatesEnabled(): boolean {
  if (typeof window === "undefined") return false;
  if (!cacheFresh) refreshPersisted();
  return cached ?? false;
}

export function setDifficultyEstimatesEnabled(enabled: boolean): void {
  if (typeof window === "undefined") return;
  cached = enabled === true;
  cacheFresh = true;
  try {
    localStorage.setItem(DIFFICULTY_DISPLAY_KEY, JSON.stringify({ showDifficultyEstimates: cached }));
    memoryOnly = false;
  } catch {
    // A storage-blocked page keeps the live choice for its current view.
    memoryOnly = true;
  }
  window.dispatchEvent(new Event(DIFFICULTY_DISPLAY_EVENT));
}

export function observeDifficultyDisplay(update: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const target = window;
  const first = observers++ === 0;
  let disposed = false;
  const notify = () => update();
  const storage = (event: StorageEvent) => {
    if (event.key === DIFFICULTY_DISPLAY_KEY || event.key === null) {
      refreshPersisted(true);
      notify();
    }
  };
  target.addEventListener(DIFFICULTY_DISPLAY_EVENT, notify);
  target.addEventListener("storage", storage);
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    target.removeEventListener(DIFFICULTY_DISPLAY_EVENT, notify);
    target.removeEventListener("storage", storage);
    if (--observers === 0) cacheFresh = false;
  };
  if (first) refreshPersisted();
  try {
    notify();
  } catch (error) {
    dispose();
    throw error;
  }
  return dispose;
}
