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

export function difficultyEstimatesEnabled(): boolean {
  if (typeof window === "undefined") return false;
  if (cached !== undefined) return cached;
  try {
    cached = normalizeDifficultyDisplayPreferences(
      JSON.parse(localStorage.getItem(DIFFICULTY_DISPLAY_KEY) || "null"),
    ).showDifficultyEstimates;
  } catch {
    cached = false;
  }
  return cached;
}

export function setDifficultyEstimatesEnabled(enabled: boolean): void {
  if (typeof window === "undefined") return;
  cached = enabled === true;
  try {
    localStorage.setItem(DIFFICULTY_DISPLAY_KEY, JSON.stringify({ showDifficultyEstimates: cached }));
  } catch {
    // A storage-blocked page keeps the live choice for its current view.
  }
  window.dispatchEvent(new Event(DIFFICULTY_DISPLAY_EVENT));
}

export function observeDifficultyDisplay(update: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const target = window;
  const storage = (event: StorageEvent) => {
    if (event.key === DIFFICULTY_DISPLAY_KEY || event.key === null) {
      cached = undefined;
      update();
    }
  };
  target.addEventListener(DIFFICULTY_DISPLAY_EVENT, update);
  target.addEventListener("storage", storage);
  return () => {
    target.removeEventListener(DIFFICULTY_DISPLAY_EVENT, update);
    target.removeEventListener("storage", storage);
  };
}
