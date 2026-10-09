export interface ChartPlaybackRange {
  start: number;
  end: number;
}
export interface ChartPlaybackIdentity {
  hash: string;
  releaseId?: string;
  sourceId?: string;
}
export interface ChartPlaybackShare {
  time: number;
  range?: ChartPlaybackRange;
  loop: boolean;
  identity: ChartPlaybackIdentity;
}

const seconds = (value: string | null): number | undefined => {
  if (value === null || !value.trim()) return;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
};
export function validChartPlaybackRange(
  start: number | undefined,
  end: number | undefined,
  duration: number,
): ChartPlaybackRange | undefined {
  if (
    start === undefined ||
    end === undefined ||
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    !Number.isFinite(duration) ||
    duration <= 0 ||
    start < 0 ||
    end > duration ||
    end - start < 0.05
  )
    return;
  return { start, end };
}

/** Public playback state only; media URLs and arbitrary page queries are excluded. */
export function chartPlaybackShareUrl(
  page: URL,
  identity: ChartPlaybackIdentity,
  time: number,
  range: ChartPlaybackRange | undefined,
  loop: boolean,
): URL {
  const url = new URL(page.href);
  const kept = new URLSearchParams();
  for (const key of ["difficulty", "chartDifficulty", "song", "chart"]) {
    const value = url.searchParams.get(key);
    if (value !== null) kept.set(key, value);
  }
  url.username = "";
  url.password = "";
  url.hash = "";
  url.search = kept.toString();
  url.searchParams.set("chartTime", String(Math.max(0, time)));
  url.searchParams.set("chartHash", identity.hash);
  if (identity.releaseId) url.searchParams.set("chartRelease", identity.releaseId);
  if (identity.sourceId) url.searchParams.set("chartSourceId", identity.sourceId);
  if (range) {
    url.searchParams.set("chartA", String(range.start));
    url.searchParams.set("chartB", String(range.end));
    if (loop) url.searchParams.set("chartLoop", "1");
  }
  return url;
}
export function readChartPlaybackShare(url: URL): ChartPlaybackShare | undefined {
  const hash = url.searchParams.get("chartHash");
  const time = seconds(url.searchParams.get("chartTime"));
  if (!hash || !/^[a-f0-9]{64}$/u.test(hash) || time === undefined) return;
  const start = seconds(url.searchParams.get("chartA"));
  const end = seconds(url.searchParams.get("chartB"));
  const hasRange = url.searchParams.has("chartA") || url.searchParams.has("chartB");
  if (hasRange && (start === undefined || end === undefined || end - start < 0.05)) return;
  return {
    time,
    ...(hasRange ? { range: { start: start!, end: end! } } : {}),
    loop: hasRange && url.searchParams.get("chartLoop") === "1",
    identity: {
      hash,
      releaseId: url.searchParams.get("chartRelease") || undefined,
      sourceId: url.searchParams.get("chartSourceId") || undefined,
    },
  };
}
export function matchesChartPlaybackShare(shared: ChartPlaybackIdentity, loaded: ChartPlaybackIdentity): boolean {
  return (
    shared.hash === loaded.hash &&
    (!shared.releaseId || shared.releaseId === loaded.releaseId) &&
    (!shared.sourceId || shared.sourceId === loaded.sourceId)
  );
}
export function sameChartPlaybackIdentity(first: ChartPlaybackIdentity, second: ChartPlaybackIdentity): boolean {
  return first.hash === second.hash && first.releaseId === second.releaseId && first.sourceId === second.sourceId;
}

export interface ChartRangeIndex {
  noteTimes: readonly number[];
  bpms: readonly { timeMs: number; bpm: number }[];
}
export function chartRangeIndex(
  notes: readonly { timeMs: number; judged: boolean }[],
  bpms: readonly { timeMs: number; bpm: number }[],
): ChartRangeIndex {
  return {
    noteTimes: notes
      .filter((note) => note.judged && Number.isFinite(note.timeMs))
      .map((note) => note.timeMs)
      .sort((a, b) => a - b),
    bpms: bpms
      .filter((point) => Number.isFinite(point.timeMs) && Number.isFinite(point.bpm) && point.bpm > 0)
      .map((point) => ({ ...point }))
      .sort((a, b) => a.timeMs - b.timeMs),
  };
}
/** Half-open [A,B): a note at B belongs to the following selection. */
export function chartRangeStatistics(index: ChartRangeIndex, range: ChartPlaybackRange) {
  const lower = (time: number) => {
    let low = 0,
      high = index.noteTimes.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (index.noteTimes[middle]! < time) low = middle + 1;
      else high = middle;
    }
    return low;
  };
  const start = range.start * 1000,
    end = range.end * 1000;
  const notes = lower(end) - lower(start);
  let active: number | undefined;
  const bpms: number[] = [];
  for (const point of index.bpms) {
    if (point.timeMs <= start) active = point.bpm;
    else if (point.timeMs < end) bpms.push(point.bpm);
    else break;
  }
  if (active !== undefined) bpms.unshift(active);
  return {
    notes,
    notesPerSecond: notes / (range.end - range.start),
    minimumBpm: active !== undefined && bpms.length ? Math.min(...bpms) : undefined,
    maximumBpm: active !== undefined && bpms.length ? Math.max(...bpms) : undefined,
  };
}
