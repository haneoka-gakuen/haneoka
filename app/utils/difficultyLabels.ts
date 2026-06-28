import type { SongDifficulty } from "~/types/archive";

const DIFFICULTY_LABELS = ["Easy", "Normal", "Hard", "Expert", "Special", "Master"] as const;
const CODE_LABELS: Record<string, string> = {
  easy: "Easy",
  normal: "Normal",
  hard: "Hard",
  expert: "Expert",
  special: "Special",
  master: "Master",
};

/**
 * Resolve a difficulty display name. Prefers an explicit `difficultyName` from
 * the data, then maps the difficulty code, then falls back to the positional
 * label. Centralizes the per-component fallback arrays. Intentionally not
 * localized — difficulty names are game terms shown as-is across locales.
 */
export const difficultyNameOf = (difficulty: SongDifficulty | undefined, index: number): string => {
  const provided = difficulty?.difficultyName;
  if (typeof provided === "string" && provided) return provided;
  const code = String(difficulty?.difficulty || "");
  if (CODE_LABELS[code]) return CODE_LABELS[code];
  return DIFFICULTY_LABELS[index] || code;
};
