// L3 — GEB
// Input: 浏览器保存的关卡、操作历史与显示／求解偏好。
// Output: 按服、歌曲、尺寸、来源和目标空格保存的本地进度。
// Pos: [Map](../L2-2.md)；华容道续局存储。
// Effects/Dependencies: localStorage；限制为最近 24 个局面，每个方向保留 32 条历史。
import { validPosition } from "./model";

export interface PuzzleSelection {
  server: string;
  song: string;
  size: number;
  goalBlank: number;
  source: "native" | "free";
}
export interface PuzzleSnapshot {
  tiles: number[];
  moves: number;
  initial: number[];
  source: "native" | "free";
}
interface StoredLevel extends PuzzleSnapshot {
  past: PuzzleSnapshot[];
  future: PuzzleSnapshot[];
}
export interface PuzzleStorage {
  version: 1;
  selected?: PuzzleSelection;
  preferences?: {
    numbers: boolean;
    reference: boolean;
    zoom?: number;
    speed: number;
    quality: "fast" | "short";
    budget: number;
    scramble: number;
  };
  levels: Record<string, StoredLevel>;
}
const KEY = "haneoka.song-puzzle.v1";
export const puzzleSlotKey = (value: PuzzleSelection) =>
  [value.server, value.song, value.size, value.source, value.goalBlank].join(":");

export function readPuzzleStorage(): PuzzleStorage {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) || "null") as PuzzleStorage | null;
    if (value?.version === 1 && value.levels && typeof value.levels === "object" && !Array.isArray(value.levels))
      return value;
  } catch {}
  return { version: 1, levels: {} };
}

export function savedPuzzleLevel(
  storage: PuzzleStorage,
  selection: PuzzleSelection,
  goal: number[],
): StoredLevel | undefined {
  const level = storage.levels[puzzleSlotKey(selection)],
    size = selection.size;
  const valid = (value: PuzzleSnapshot) =>
    value &&
    Number.isInteger(value.moves) &&
    value.moves >= 0 &&
    (value.source === "native" || value.source === "free") &&
    validPosition({ size, goal, tiles: value.tiles }) &&
    validPosition({ size, goal, tiles: value.initial });
  if (!valid(level!)) return;
  return {
    ...level!,
    past: Array.isArray(level!.past) ? level!.past.filter(valid).slice(-32) : [],
    future: Array.isArray(level!.future) ? level!.future.filter(valid).slice(-32) : [],
  };
}

export function writePuzzleStorage(storage: PuzzleStorage, selection: PuzzleSelection, level: StoredLevel): void {
  const key = puzzleSlotKey(selection);
  delete storage.levels[key];
  storage.levels[key] = { ...level, past: level.past.slice(-32), future: level.future.slice(-32) };
  while (Object.keys(storage.levels).length > 24) delete storage.levels[Object.keys(storage.levels)[0]!];
  storage.selected = selection;
  try {
    localStorage.setItem(KEY, JSON.stringify(storage));
  } catch {}
}
