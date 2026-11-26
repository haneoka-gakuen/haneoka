// L3 — GEB
// Input: Selected event, region, supported boards and a comparable event catalogue.
// Output: Time-aligned milestone series and forecasts for the selected board.
// Pos: [Map](L2-2.md); data controller for the Event tracker history tab.
// Effects/Dependencies: Reads one paginated milestone history per board and aborts obsolete reads.
import { LitElement } from "lit";
import { clientText } from "../i18n/client";
import { RequestScope } from "../lib/request-scope";
import {
  EVENT_HISTORY_MILESTONES, type EventRankMilestoneSample, type GameRecordsRegion,
} from "../lib/game-records";
import { loadEventMilestones } from "../lib/event-rank-history-data";
import { eventRankForecast } from "../lib/event-rank-forecast";
import { renderEventHistory, type EventHistoryView } from "./views/event-history";

type HistoryBoard = { value: string; label: string; startAtMs: number; comparisons: HistoryComparison[] };
type HistoryComparison = { value: string; label: string; endpoint: string; startAtMs: number };
export type { HistoryBoard, HistoryComparison };

function milestoneSeries(samples: EventRankMilestoneSample[], label: string, startAtMs: number, comparison: boolean) {
  return EVENT_HISTORY_MILESTONES.map((rank, index) => ({
    label, rank, comparison,
    samples: samples.map(({ atMs, scores }) => ({
      atMs, elapsedMs: Math.max(0, atMs - startAtMs), score: scores[index] ?? null,
    })),
  }));
}

export class EventRankHistory extends LitElement {
  static properties = {
    locale: {}, region: {}, eventId: {}, eventTitle: {}, endAtMs: {}, boards: { attribute: false },
    planEnabled: { attribute: false }, onPlan: { attribute: false }, initialBoard: {},
    board: { state: true }, comparison: { state: true },
    phase: { state: true }, series: { state: true },
  };
  declare locale: string;
  declare region: GameRecordsRegion;
  declare eventId: string;
  declare eventTitle: string;
  declare endAtMs?: number | null;
  declare boards: HistoryBoard[];
  declare planEnabled: boolean;
  declare onPlan: (value: string) => void;
  declare initialBoard?: string;
  declare private board: string;
  declare private comparison: string;
  declare private phase: EventHistoryView["phase"];
  declare private series: EventHistoryView["series"];
  private readonly requests = new RequestScope();

  constructor() {
    super();
    this.locale = "en";
    this.boards = [];
    this.board = "";
    this.comparison = "";
    this.phase = "idle";
    this.series = [];
  }

  createRenderRoot() { return this; }

  disconnectedCallback() {
    this.reset();
    super.disconnectedCallback();
  }

  private reset() {
    this.requests.cancel();
    this.phase = "idle";
    this.series = [];
  }

  private label = (key: string, fallback: string) => clientText(this.locale, `tools.eventTracker.history.${key.replace(/^eventHistory\./u, "")}`, fallback);

  private selectedBoard() {
    return this.boards.find((board) => board.value === this.board) ?? this.boards[0];
  }

  connectedCallback() {
    super.connectedCallback();
    void Promise.resolve().then(() => {
      if (!this.isConnected) return;
      this.board = this.initialBoard ?? "";
      void this.load();
    });
  }

  showBoard(value: string) {
    if (this.selectedBoard()?.value === value || !this.boards.some((board) => board.value === value)) return;
    this.board = value;
    this.comparison = "";
    void this.load();
  }

  private async load() {
    const board = this.selectedBoard();
    if (!board) return;
    const comparison = board.comparisons.find((option) => option.value === this.comparison);
    const main = `/api/v2/game/records/${this.region}/events/${this.eventId}/${board.value}/timeline`;
    const signal = this.requests.begin();
    this.phase = "loading";
    this.series = [];
    try {
      const [primary, secondary] = await Promise.all([
        loadEventMilestones(main, signal, samples => {
          if (this.requests.current(signal)) this.series = milestoneSeries(samples, this.eventTitle, board.startAtMs, false);
        }),
        comparison ? loadEventMilestones(comparison.endpoint, signal) : Promise.resolve(null),
      ]);
      if (!this.requests.current(signal)) return;
      this.series = milestoneSeries(primary, this.eventTitle, board.startAtMs, false);
      if (comparison && secondary) this.series = [...this.series, ...milestoneSeries(secondary, comparison.label, comparison.startAtMs, true)];
      this.phase = "ready";
    } catch {
      if (this.requests.current(signal)) {
        this.reset();
        this.phase = "error";
      }
    }
  }

  render() {
    const board = this.selectedBoard();
    const endAtMs = this.endAtMs, now = Date.now();
    const forecasts = this.phase === "ready" && (board?.value === "points" || board?.value === "total") && endAtMs
      ? this.series.filter((series) => !series.comparison).flatMap(({ rank, samples }) => {
        const forecast = eventRankForecast(samples, endAtMs, now);
        return forecast ? [{ rank, ...forecast }] : [];
      }) : [];
    return renderEventHistory({
      t: this.label,
      locale: this.locale,
      boards: this.boards,
      board: board?.value ?? "",
      comparisons: [{ value: "", label: this.label("none", "No comparison") }, ...(board?.comparisons ?? [])],
      comparison: this.comparison,
      onBoard: (value) => this.showBoard(value),
      onComparison: (value) => { this.comparison = value; void this.load(); },
      onRetry: () => void this.load(),
      onPlan: (score) => this.onPlan(score),
      canPlan: this.planEnabled && board?.value === "points",
      forecasts,
      phase: this.phase,
      series: this.series,
    });
  }
}

if (!customElements.get("event-rank-history")) customElements.define("event-rank-history", EventRankHistory);
