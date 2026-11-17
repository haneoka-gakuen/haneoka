// L3 — GEB
// Input: Original mission counters and synced song-progress preferences.
// Output: Exact cumulative clear counts indexed by native type, song and difficulty.
// Pos: [Map](L2-2.md); count imports and manual edits share the same Box entries.
// Effects/Dependencies: Pure; preserves 64-bit counts and leaves missing records unknown.
import type { BoxEntry, BoxValue } from "./team-builder/sync/box-doc";

export const COUNT_SOURCE_KEY = "pref.song-progress-count-source";
export const MAX_PLAY_COUNT = 9_223_372_036_854_775_807n;
const TYPES = new Set([76, 77, 78, 81, 102, 108, 137, 144, 145, 146]);
export const playCountKey = (type: number, param1 = 0, param2 = 0) => `pref.pc-${type}-${param1}-${param2}`;
export type CountEntries = Readonly<Record<string, BoxEntry>>;
export type CountChanges = { key: string; value: BoxValue }[];

export function playCount(value: unknown): bigint | null {
  if (typeof value === "number" && (!Number.isSafeInteger(value) || value < 0)) return null;
  if ((typeof value !== "string" && typeof value !== "number") || !/^\d{1,19}$/u.test(String(value))) return null;
  const count = BigInt(value);
  return count <= MAX_PLAY_COUNT ? count : null;
}
function scope(type: number, p1: number, p2: number) {
  if (![type, p1, p2].every(Number.isSafeInteger) || !TYPES.has(type)) return false;
  if (type === 81 || type === 108) return p1 > 0 && p1 <= 9_999_999_999 && (type === 108 ? p2 >= 1 && p2 <= 5 : p2 === 0);
  if ([144, 145, 146].includes(type)) return p1 >= 0 && p1 <= 9 && p2 === 0;
  return p1 === 0 && p2 === 0;
}
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const field = (row: Record<string, unknown>, names: string[]) => names.map(name => row[name]).find(value => value !== undefined);

export function readMissionCounts(value: unknown): Map<string, bigint> | null {
  if (!Array.isArray(value)) return null;
  const result = new Map<string, bigint>();
  for (const item of value) {
    const row = object(item);
    const type = Number(field(row, ["missionType", "MissionType", "mission_type", "missionType_", "_missionType"]));
    const p1 = Number(field(row, ["param1", "Param1", "param_1", "param1_", "_param1"]) ?? 0);
    const p2 = Number(field(row, ["param2", "Param2", "param_2", "param2_", "_param2"]) ?? 0);
    if (!scope(type, p1, p2)) continue;
    const progress = field(row, ["progress", "Progress", "progress_", "_progress"]);
    const count = playCount(progress === undefined ? 0 : progress);
    if (count !== null) result.set(playCountKey(type, p1, p2), count);
  }
  return result;
}

export function storedPlayCount(entries: CountEntries, type: number, param1 = 0, param2 = 0): bigint | null {
  return playCount(object(entries[playCountKey(type, param1, param2)]?.v).count);
}
export function countChange(type: number, param1: number, param2: number, value: bigint | null): CountChanges[number] {
  return { key: playCountKey(type, param1, param2), value: value === null ? null : { count: String(value) } };
}
export function songPlayCount(entries: CountEntries, song: number, difficulties: readonly number[]): bigint | null {
  const recorded = storedPlayCount(entries, 81, song);
  if (recorded !== null) return recorded;
  const counts = difficulties.map(difficulty => storedPlayCount(entries, 108, song, difficulty + 1));
  if (!counts.length || counts.some(count => count === null)) return null;
  const total = (counts as bigint[]).reduce((sum, count) => sum + count, 0n);
  return total <= MAX_PLAY_COUNT ? total : null;
}
export function chartCountChanges(entries: CountEntries, song: number, difficulty: number, count: bigint | null, difficulties: readonly number[]): CountChanges {
  const old = storedPlayCount(entries, 108, song, difficulty + 1);
  const changes = [countChange(108, song, difficulty + 1, count)];
  if (count === null) return changes;
  if (old !== null) for (const [type, param1] of [[81, song], [76, 0]] as const) {
    const total = storedPlayCount(entries, type, param1);
    if (total !== null && total >= old && total - old + count <= MAX_PLAY_COUNT) changes.push(countChange(type, param1, 0, total - old + count));
  }
  if (storedPlayCount(entries, 81, song) === null) {
    const counts = difficulties.map(other => other === difficulty ? count : storedPlayCount(entries, 108, song, other + 1));
    if (counts.length && counts.every(value => value !== null)) {
      const total = (counts as bigint[]).reduce((sum, value) => sum + value, 0n);
      if (total <= MAX_PLAY_COUNT) changes.push(countChange(81, song, 0, total));
    }
  }
  return changes;
}
export function countImportChanges(counters: unknown, label: string, readAt: string): CountChanges {
  const rows = readMissionCounts(counters);
  if (!rows?.size) return [];
  const changes: CountChanges = [...rows].map(([key, count]) => ({ key, value: { count: String(count) } }));
  changes.push({ key: COUNT_SOURCE_KEY, value: { label: label.split(/[\\/]/u).at(-1) ?? label, readAt } });
  return changes;
}

export function saveClearMarks(player: Record<string, unknown>): Record<string, number> | null {
  if (!Array.isArray(player._liveMusicResults)) return null;
  const result: Record<string, number> = {};
  for (const value of player._liveMusicResults) {
    const row = object(value), song = Number(row._mLiveMusicId ?? row._masterMusicId ?? row._masterId);
    if (!Number.isSafeInteger(song) || song <= 0) continue;
    for (const [index, difficulty] of ["easy", "normal", "hard", "expert"].entries()) {
      const status = Number(row[`_${difficulty}ClearedStatus`]);
      if (status >= 10) result[`l.${song}.${index}`] = status >= 30 ? 3 : status >= 20 ? 2 : 1;
    }
  }
  return result;
}
