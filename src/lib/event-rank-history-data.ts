import { exactEventScore } from "./game-event-history";
import { EVENT_HISTORY_MILESTONES, type EventRankingDto, type EventRankMilestoneSample, type EventRankMilestoneTimeline } from "./game-records";

type ShowInitialPage = (samples: EventRankMilestoneSample[]) => void;

export async function fetchEventRankingResponse(url: string, signal?: AbortSignal) {
  const options = { signal, headers: { accept: "application/json" } };
  try {
    const response = await fetch(url, options);
    if (![500, 502, 503, 504].includes(response.status)) return response;
    await response.body?.cancel();
  } catch (error) {
    if (signal?.aborted) throw error;
  }
  return fetch(url, options);
}

async function milestonePage(endpoint: string, signal: AbortSignal, before?: number) {
  const params = new URLSearchParams({ milestones: "1" });
  if (before !== undefined) params.set("before", String(before));
  const response = await fetchEventRankingResponse(`${endpoint}?${params}`, signal);
  if (response.status === 404 && !endpoint.endsWith("/points/timeline")) return null;
  if (!response.ok) throw new Error(`event-history:${response.status}`);
  return await response.json() as EventRankMilestoneTimeline;
}

const legacyEndpoint = (endpoint: string) => endpoint.replace(/\/timeline$/u, "/history");

export async function loadEventMilestones(endpoint: string, signal: AbortSignal, showInitial?: ShowInitialPage) {
  const samples: EventRankMilestoneSample[] = [];
  let before: number | undefined;
  for (;;) {
    const page = await milestonePage(endpoint, signal, before);
    if (!page) {
      if (before !== undefined) throw new Error("event-history:404");
      return legacyTimeline(legacyEndpoint(endpoint), signal, showInitial);
    }
    samples.push(...page.samples);
    if (page.nextBefore === null) return samples.reverse();
    if (before === undefined) showInitial?.([...samples].reverse());
    before = page.nextBefore;
  }
}

function selectWindow(samples: EventRankMilestoneSample[], from: number, to: number) {
  const baseline = samples.findLastIndex((sample) => sample.atMs <= from && sample.scores.some((score) => score !== null));
  return (baseline < 0 ? samples.filter((sample) => sample.atMs > from) : samples.slice(baseline))
    .filter((sample) => sample.atMs <= to);
}

export async function loadEventMilestoneWindow(endpoint: string, from: number, to: number, signal: AbortSignal) {
  const descending: EventRankMilestoneSample[] = [];
  let before = to + 1;
  for (;;) {
    const page = await milestonePage(endpoint, signal, before);
    if (!page) return selectWindow(await legacyTimeline(legacyEndpoint(endpoint), signal), from, to);
    descending.push(...page.samples);
    if (page.nextBefore === null || page.samples.some((sample) => sample.atMs <= from && sample.scores.some((score) => score !== null))) {
      return selectWindow(descending.reverse(), from, to);
    }
    before = page.nextBefore;
  }
}

async function legacyTimeline(endpoint: string, signal: AbortSignal, showInitial?: ShowInitialPage): Promise<EventRankMilestoneSample[]> {
  const samples = new Map<number, EventRankMilestoneSample["scores"]>();
  const orderedSamples = () => [...samples].sort(([left], [right]) => left - right).map(([atMs, scores]) => ({ atMs, scores }));
  let cursor = 0;
  for (;;) {
    const response = await fetchEventRankingResponse(`${endpoint}?after=${cursor}`, signal);
    if (!response.ok) throw new Error(`event-history:${response.status}`);
    const data = await response.json() as {
      observations: Array<{ observedAtMs: number; ranking?: EventRankingDto }>;
      nextCursor: number;
    };
    for (const item of data.observations) {
      const previous = samples.get(item.observedAtMs);
      const scores = EVENT_HISTORY_MILESTONES.map((rank, index) => {
        const row = item.ranking?.rows[rank - 1];
        return exactEventScore(row?.scoreExact ?? row?.score) ?? previous?.[index] ?? null;
      });
      samples.set(item.observedAtMs, scores);
    }
    if (!cursor && data.nextCursor > cursor) showInitial?.(orderedSamples());
    if (data.nextCursor <= cursor) {
      return orderedSamples();
    }
    cursor = data.nextCursor;
  }
}
