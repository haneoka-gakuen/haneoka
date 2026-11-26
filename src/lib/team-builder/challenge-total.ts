// L3 — GEB
// Input: The selected event songs and charts, native score candidates and their proof status.
// Output: One counted score per song and a device-only resumable checkpoint.
// Pos: [Map](L2-2.md); event song leaderboard scores.
// Effects/Dependencies: IndexedDB stores checkpoints separately from the player's card collection.
import type { EngineHit, SongRef } from "./engine/api";

export interface RankedChart extends SongRef {
  proven: boolean;
  candidate?: { score: number; members: string[]; snaps: (string | null)[] };
  error?: string;
}

export interface ChallengeTotalResult {
  context: string;
  stopped?: boolean;
  shared: boolean;
  /** For the shared team, the mean over every selected chart, before best-difficulty selection. */
  sharedKey: number | null;
  songs: { id: number; charts: RankedChart[] }[];
}

export function countChallengeSongs(result: ChallengeTotalResult) {
  const songs = result.songs.map(song => {
    const best = song.charts.reduce<RankedChart | undefined>((winner, row) =>
      row.candidate && (!winner?.candidate || row.candidate.score > winner.candidate.score) ? row : winner, undefined);
    const proven = song.charts.filter(row => row.proven).length;
    return { ...song, best, proven, complete: song.charts.length > 0 && proven === song.charts.length };
  });
  const covered = songs.filter(row => row.best).length;
  return { songs, covered, total: songs.reduce((sum, row) => sum + (row.best?.candidate?.score ?? 0), 0),
    complete: covered > 0 && covered === songs.length && songs.every(row => row.complete) };
}

export function countChart(chart: RankedChart, hit: EngineHit | undefined, proven: boolean, shared: boolean) {
  const score = shared ? hit?.score?.mean : hit?.score?.max;
  if (score != null && hit && (shared || !chart.candidate || score >= chart.candidate.score))
    chart.candidate = { score, members: hit.members, snaps: hit.snaps };
  chart.proven ||= proven;
}

let opening: Promise<IDBDatabase> | undefined;
function database() {
  return opening ??= new Promise<IDBDatabase>((resolve, reject) => {
    const open = indexedDB.open("haneoka-challenge-totals", 1);
    open.onupgradeneeded = () => open.result.createObjectStore("runs");
    open.onsuccess = () => {
      const db = open.result;
      db.onversionchange = () => { db.close(); opening = undefined; };
      resolve(db);
    };
    open.onerror = () => { opening = undefined; reject(open.error); };
  });
}

export async function loadChallengeTotal(key: string): Promise<ChallengeTotalResult | undefined> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const read = db.transaction("runs").objectStore("runs").get(key);
    read.onsuccess = () => resolve(read.result as ChallengeTotalResult | undefined);
    read.onerror = () => reject(read.error);
  });
}

export async function saveChallengeTotal(key: string, value: ChallengeTotalResult) {
  const db = await database();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction("runs", "readwrite");
    tx.objectStore("runs").put(value, key);
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error);
    tx.onerror = () => reject(tx.error);
  });
}
