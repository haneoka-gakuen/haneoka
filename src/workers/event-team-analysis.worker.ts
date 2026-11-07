// L3 — GEB
// Input: Release-pinned activity deck, song identity and visibility state.
// Output: Immediately available, ordered preferred configurations, limited to ten.
// Pos: [Map](../L2.md); local cooperative inverse search for activity ranking dialogs.
// Effects/Dependencies: CPU only; yields every eight milliseconds, pauses when hidden and stops after ten results.
import { createEventTeamAnalyzer, type EventTeamConfiguration, type EventTeamSearch, type EventTeamReading,
  type EventTeamSearchPage } from "../lib/event-team-analysis";
import type { SongRankingRowDto } from "../lib/game-records";
import type { TeamBuilderData } from "../lib/team-builder/data";
import type { EventTeamGrowthSources } from "../lib/event-team-growth-limits";

interface SearchInput { id: number; data?: TeamBuilderData; growthSources?: EventTeamGrowthSources; asOf: number;
  row: SongRankingRowDto; eventId: number; challengeId: number; related: EventTeamReading[] }
const RESULT_LIMIT = 10;
let analyze: ReturnType<typeof createEventTeamAnalyzer>;
let input: SearchInput;
let search: EventTeamSearch;
let rows: EventTeamConfiguration[] = [], complete = false, paused = false;
let status: EventTeamSearchPage["status"] = "ready";
const channel = new MessageChannel();
let scheduled = false;
let lastPublished = 0;

function publish() {
  lastPublished = performance.now();
  self.postMessage({ id: input.id, page: 0, rows, count: rows.length, complete, status } satisfies EventTeamSearchPage);
}
function schedule() {
  if (!input || !search) return;
  if (!paused && !complete && !scheduled) { scheduled = true; channel.port2.postMessage(null); }
}
function pump() {
  if (paused || complete || !search) return;
  const stop = performance.now() + 8;
  try {
    do {
      const step = search.next();
      if (step.done) { complete = true; status = step.value.status; publish(); }
      else if (step.value) {
        rows.push(step.value);
        if (rows.length === RESULT_LIMIT) {
          complete = true;
          search.return({ status: "ready" });
          publish();
        } else if (rows.length === 1) {
          publish();
        }
      }
    } while (performance.now() < stop && !complete);
    if (performance.now() - lastPublished >= 100) publish();
    schedule();
  } catch {
    complete = true; status = "missingRules"; publish();
  }
}
channel.port1.onmessage = () => { scheduled = false; pump(); };
self.onmessage = (event: MessageEvent<SearchInput | { paused: boolean }>) => {
  const message = event.data;
  if ("paused" in message) { paused = message.paused; schedule(); return; }
  try {
    if (message.data) analyze = createEventTeamAnalyzer(message.data, message.growthSources!, message.asOf);
    input = message;
    search = analyze(input.row, input.eventId, input.challengeId, undefined, input.related);
    rows = []; complete = false; status = "ready";
    lastPublished = 0;
    schedule();
  } catch {
    complete = true;
    self.postMessage({ id: message.id, page: 0, rows: [], count: 0, complete: true, status: "missingRules" } satisfies EventTeamSearchPage);
  }
};
