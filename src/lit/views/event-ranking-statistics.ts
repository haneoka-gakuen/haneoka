// L3 — GEB
// Input: Selected board, scores, fixed rank cutoffs, observed changes and other event songs.
// Output: Score-to-rank comparison, score distribution and same-event cutoff comparison.
// Pos: [Map](../L2-2.md); statistics view within event tracking.
// Effects/Dependencies: Renders computed observations and passes interactions to the statistics controller.
import { html, nothing } from "lit";
import "@material/web/textfield/outlined-text-field.js";
import type { MdOutlinedTextField } from "@material/web/textfield/outlined-text-field.js";
import "@material/web/button/filled-tonal-button.js";
import "@material/web/button/text-button.js";
import { accordion } from "../ui/accordion";
import type { EventCardAnalysis } from "../../lib/event-card-analysis";
import "./event-card-analysis";
import type { CardInfo } from "./event-card-analysis";
import { parseStatsScore, type EventBoardComparison, type EventBoardStatistics, type EventRankingTrend, type EventSongSurge } from "../../lib/event-ranking-statistics";
import { renderDetailSectionHeading as heading } from "../shared/detail-section-heading";
import { historySelect } from "../ui/history-select";
import { emptyState, errorState, loadingState } from "../ui/state";
import { renderEventRankingTrend } from "./event-ranking-trend";

type Board = EventBoardStatistics;
type Phase = "loading" | "ready" | "error";
export type EventRankingStatisticsView = {
  locale: string;
  t: (key: string, fallback: string) => string;
  boards: { value: string; label: string }[];
  board: string;
  onBoard: (id: string) => void;
  phase: Phase;
  data?: Board;
  goal: string;
  place: number | null;
  onGoal: (value: string) => void;
  cardPhase: Phase | "idle";
  cardAnalysis?: EventCardAnalysis;
  cardInfo: CardInfo;
  onLoadCards: () => void;
  expanded: ReadonlySet<string>;
  onExpand: (id: string, open: boolean) => void;
  changes: { rank: number; delta: bigint | null }[];
  trendPhase: Phase | "idle";
  trendAtMs?: number;
  onTrend: () => void;
  trend?: EventRankingTrend;
  surges: EventSongSurge[];
  surgePhase: Phase | "idle";
  onSurges: () => void;
  showComparison: boolean;
  comparePhase: Phase | "idle";
  comparison: EventBoardComparison[];
  onCompare: () => void;
  onRetry: () => void;
  onHistory: () => void;
};
type View = EventRankingStatisticsView;
const timestamp = (value: number, view: View) =>
  new Intl.DateTimeFormat(view.locale, { dateStyle: "short", timeStyle: "short" }).format(value);
const signed = (value: bigint, view: View) =>
  new Intl.NumberFormat(view.locale, { signDisplay: "exceptZero" }).format(value);

function cutoffPanel(view: View, data: Board) {
  const { t } = view;
  const goal = parseStatsScore(view.goal);
  const changes = new Map(view.changes.map(change => [change.rank, change.delta]));
  return html`<section class="surface stack stack--tight">
    <div class="row row--between statistics-cutoff-heading">
      ${heading(t("cutoffs", "Rank cutoffs"), "stats")}
      <md-outlined-text-field class="statistics-score" label=${t("myScore", "My score")} inputmode="numeric"
        .value=${view.goal} @input=${(event: Event) => view.onGoal((event.currentTarget as MdOutlinedTextField).value)}>
      </md-outlined-text-field>
    </div>
    <output class="tabular" aria-live="polite">${goal !== null && view.place !== null
        ? `${t("position", "Rank at this score")} · ${view.place === 101 ? t("outside", "Outside the top 100") : `#${view.place}`}` : nothing}</output>
    <div class="table-scroll"><table class="data-table data-table--numeric">
      <thead><tr>
        <th scope="col">${t("rank", "Rank")}</th><th scope="col" class="is-numeric">${t("score", "Score")}</th>
        ${goal !== null ? html`<th scope="col" class="is-numeric">${t("needed", "Points needed")}</th>` : nothing}
        ${view.trendPhase === "ready" ? html`<th scope="col" class="is-numeric">${t("trend", "Cutoff change")}</th>` : nothing}
      </tr></thead>
      <tbody>${data.cuts.map(cut => {
        const delta = changes.get(cut.rank);
        return html`<tr><th scope="row">#${cut.rank}</th><td class="is-numeric">${cut.score.toLocaleString(view.locale)}</td>
          ${goal !== null ? html`<td class="is-numeric">${(goal >= cut.score ? 0n : cut.score - goal).toLocaleString(view.locale)}</td>` : nothing}
          ${view.trendPhase === "ready" ? html`<td class="is-numeric">${delta == null ? "—" : signed(delta, view)}</td>` : nothing}
        </tr>`;
      })}</tbody>
    </table></div>
    <div class="cluster">
      ${view.trendPhase !== "ready" ? html`<md-filled-tonal-button type="button" ?disabled=${view.trendPhase === "loading"} @click=${view.onTrend}>
        ${view.trendPhase === "loading" ? t("loading", "Loading") : view.trendPhase === "error" ? t("retry", "Retry") : t("trend", "Cutoff change")}
      </md-filled-tonal-button>` : nothing}
      <md-text-button type="button" @click=${view.onHistory}>${t("history", "Rank history")}</md-text-button>
    </div>
    ${view.trendPhase === "ready" ? html`<small class="statistics-caption">${view.trendAtMs
      ? html`${t("baseline", "Compared with")} <time datetime=${new Date(view.trendAtMs).toISOString()}>${timestamp(view.trendAtMs, view)}</time>
          ${data.observedAtMs !== null ? html` · ${new Intl.NumberFormat(view.locale, {
            style: "unit", unit: "hour", unitDisplay: "long", maximumFractionDigits: 1,
          }).format((data.observedAtMs - view.trendAtMs) / 3_600_000)}` : nothing}`
      : t("noBaseline", "No earlier cutoff observation")}</small>` : nothing}
    ${view.trendPhase === "error" ? html`<p role="alert">${t("trendError", "Trend unavailable")}</p>` : nothing}
  </section>`;
}

function distributionPanel(view: View, data: Board) {
  const values = data.scores;
  if (!values) return nothing;
  const { t } = view;
  const maxCount = Math.max(1, ...data.histogram.map(bin => bin.count));
  const compact = new Intl.NumberFormat(view.locale, { notation: "compact", maximumFractionDigits: 1 });
  return html`<section class="surface stack stack--tight">
    ${heading(t("distribution", "Score distribution"), "difficulty")}
    <dl class="statistics-metrics">
      ${([[t("median", "Median"), values.median], ["P90", values.p90], [t("max", "Maximum"), values.max]] as const)
        .map(([label, value]) => html`<div><dt>${label}</dt><dd>${value.toLocaleString(view.locale)}</dd></div>`)}
    </dl>
    <div class="statistics-plot" role="img" aria-label=${t("distribution", "Score distribution")}>
      ${data.histogram.map(bin => html`<div class="statistics-bin" title=${`${bin.from.toLocaleString(view.locale)}–${bin.to.toLocaleString(view.locale)} · ${bin.count}`}>
        <span>${bin.count}</span><i style=${`height:${60 * bin.count / maxCount}px`}></i>
      </div>`)}
    </div>
    <div class="row row--between statistics-axis"><span>${compact.format(values.min)}</span><span>${compact.format(values.max)}</span></div>
    ${accordion({ id: "statistics-intervals", label: t("intervals", "Score ranges"), expanded: view.expanded.has("intervals"),
      onExpandedChange: open => view.onExpand("intervals", open), content: html`<div class="table-scroll"><table class="data-table"><thead><tr>
        <th scope="col">${t("interval", "Score range")}</th><th scope="col" class="is-numeric">${t("players", "Players")}</th>
      </tr></thead><tbody>${data.histogram.map(bin => html`<tr>
        <td>${bin.from.toLocaleString(view.locale)} – ${bin.to.toLocaleString(view.locale)}</td><td class="is-numeric">${bin.count}</td>
      </tr>`)}</tbody></table></div>
    `})}
  </section>`;
}

function comparison(view: View, data: Board) {
  const { t } = view;
  const rank100 = (board: Pick<Board, "cuts">) => board.cuts.find(cut => cut.rank === 100)?.score;
  const own = rank100(data);
  const boards: EventBoardComparison[] = [
    { ...data, label: view.boards.find(board => board.value === view.board)?.label ?? view.board },
    ...view.comparison,
  ];
  const format = (n?: bigint) => n == null ? "—" : n.toLocaleString(view.locale);
  return accordion({ id: "statistics-compare", label: t("compare", "Compare event songs"), expanded: view.expanded.has("compare"),
    onExpandedChange: open => {
      view.onExpand("compare", open);
      if (open && view.comparePhase === "idle") view.onCompare();
    },
    content: view.comparePhase === "loading" ? loadingState(t("loading", "Loading"), { local: true })
      : view.comparePhase === "error" ? errorState(t("error", "Statistics unavailable"), t("retry", "Retry"), view.onCompare)
      : view.comparePhase === "ready" && !view.comparison.length ? emptyState({ title: t("noComparison", "No comparable songs") })
      : view.comparison.length ? html`<div class="table-scroll"><table class="data-table data-table--numeric">
        <thead><tr><th scope="col">${t("board", "Board")}</th>
          ${boards.map(board => html`<th scope="col" class="is-numeric">${board.label}</th>`)}
        </tr></thead>
        <tbody>${([
          ["#10", b => format(b.cuts.find(c => c.rank === 10)?.score)],
          ["#50", b => format(b.cuts.find(c => c.rank === 50)?.score)],
          ["#100", b => format(rank100(b))],
          [t("cutGap", "Top 100 vs selected song"), b => {
            const cutoff = rank100(b);
            return cutoff != null && own != null ? signed(cutoff - own, view) : "—";
          }],
          [t("median", "Median"), b => format(b.scores?.median)],
          ["P25", b => format(b.scores?.p25)],
          ["P75", b => format(b.scores?.p75)],
          ["P90", b => format(b.scores?.p90)],
          [t("observed", "Observed"), b => b.observedAtMs ? timestamp(b.observedAtMs, view) : "—"],
        ] satisfies [string, (board: EventBoardComparison) => string | number][]).map(([label, value]) => html`<tr>
          <th scope="row">${label}</th>${boards.map(board => html`<td class="is-numeric">${value(board)}</td>`)}
        </tr>`)}</tbody></table></div>` : nothing });
}

export function renderEventRankingStatistics(view: View) {
  const { data, t } = view;
  return html`<div class="ranking-statistics stack">
    <div class="cluster statistics-controls">
      ${historySelect(t("board", "Board"), view.board, view.boards, view.onBoard)}
      ${data?.observedAtMs && view.phase === "ready" ? html`<time class="statistics-caption" datetime=${new Date(data.observedAtMs).toISOString()}>${timestamp(data.observedAtMs, view)}</time>` : nothing}
    </div>
    ${view.phase === "loading" ? loadingState(t("loading", "Loading"), { local: true })
      : view.phase === "error" ? errorState(t("error", "Statistics unavailable"), t("retry", "Retry"), view.onRetry)
      : !data?.scores ? emptyState({ title: t("empty", "No rankings yet") })
      : html`<div class="grid grid--fit statistics-overview">${cutoffPanel(view, data)}${distributionPanel(view, data)}</div>
        ${renderEventRankingTrend(view)}
        ${view.board.startsWith("challenges/") ? accordion({ id: "statistics-cards", label: t("cardAnalysis", "Card analysis"), expanded: view.expanded.has("cards"),
          onExpandedChange: open => {
            view.onExpand("cards", open);
            if (open && view.cardPhase === "idle") view.onLoadCards();
          },
          content: view.cardAnalysis ? html`<event-statistics-cards .locale=${view.locale} .data=${view.cardAnalysis}
                .cardInfo=${view.cardInfo} .t=${view.t}></event-statistics-cards>`
            : view.cardPhase === "error" ? errorState(t("error", "Statistics unavailable"), t("retry", "Retry"), view.onLoadCards)
            : view.cardPhase === "loading" ? loadingState(t("loading", "Loading"), { local: true }) : nothing }) : nothing}
        ${view.showComparison ? comparison(view, data) : nothing}`}
  </div>`;
}
