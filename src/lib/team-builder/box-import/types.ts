export interface BoxMember {
  cardId: number;
  exp: string | null;
  /** Explicit level from a supported inventory/profile document; raw saves use exp. */
  level?: number | null;
  awakeCount: number | null;
  rank: number | null;
  liveSkillLevel: number | null;
  performanceSkillLevel: number | null;
}
export interface BoxSnapshot {
  cardId: number;
  exp: string | null;
  /** Explicit level from a supported inventory/profile document; raw saves use exp. */
  level?: number | null;
  rank: number | null;
}
export interface BoxCandidate {
  /** Only the supported Haneoka export schema carries these verified paths. */
  playerModifiers?: import("../data/player-modifiers").PlayerModifiers;
  id: string;
  format: "player-json" | "onpkg1" | "encrypted-player" | "reference-profile" | "inventory-json";
  members: BoxMember[];
  snapshots: BoxSnapshot[];
  characters: { id: number; exp: string | null; rank?: number | null }[];
  bandItems: { id: number; level: number | null }[];
  /** Caller still confirms binding to current settings; a declared foreign server is rejected. */
  declaredIdentity?: { server: string; releaseId?: string };
}
export interface BoxParseResult {
  schema: "haneoka-box-import-v1";
  candidates: BoxCandidate[];
  ignoredFiles: number;
}
export interface BoxParseOptions {
  signal?: AbortSignal;
  progress?: (completed: number, total: number) => void;
}
export class BoxImportError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = "BoxImportError";
    this.code = code;
  }
}
export const BOX_LIMITS = Object.freeze({
  inputBytes: 32 * 1024 * 1024,
  fileBytes: 16 * 1024 * 1024,
  expandedBytes: 64 * 1024 * 1024,
  entries: 512,
  candidates: 16,
  rowsPerList: 5000,
  textBytes: 16 * 1024 * 1024,
});
export const object = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
export function integer(value: unknown): number | null {
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0 ? value : null;
  if (typeof value !== "string" || !/^(0|[1-9]\d{0,18})$/.test(value)) return null;
  const result = Number(value);
  return Number.isSafeInteger(result) && result >= 0 ? result : null;
}
export function decimal(value: unknown): string | null {
  const v = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : value;
  return typeof v === "string" && /^(0|[1-9]\d{0,18})$/.test(v) && BigInt(v) <= 0x7fffffffffffffffn ? v : null;
}
