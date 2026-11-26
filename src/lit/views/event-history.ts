import { html, nothing } from "lit";
import { renderDetailSectionHeading } from "../shared/detail-section-heading";
import { historySelect } from "../ui/history-select";
import { emptyState, errorState } from "../ui/state";
import { rankColor, rankSwatch as swatch, renderRankHistoryChart, type RankHistorySeries } from "./rank-history-chart";

type Option = { value: string; label: string };
type Forecast = { rank: number; score: bigint; gainPerHour: bigint; minutes: number };

export type EventHistoryView = {
  t: (key: string, fallback: string) => string;
  locale: string;
  boards: Option[];
  board: string;
  comparisons: Option[];
  comparison: string;
  onBoard: (value: string) => void;
  onComparison: (value: string) => void;
  onRetry: () => void;
  onPlan: (target: string) => void;
  canPlan: boolean;
  forecasts: Forecast[];
  phase: "idle" | "loading" | "ready" | "error";
  series: RankHistorySeries[];
};

function scores(view: EventHistoryView) {
  const { t } = view;
  const primary = view.series.filter(line => !line.comparison);
  if (!primary.length) return nothing;
  const numbers = new Intl.NumberFormat(view.locale);
  const time = new Intl.DateTimeFormat(view.locale, { dateStyle: "short", timeStyle: "short" });
  const minutes = new Intl.NumberFormat(view.locale, { style: "unit", unit: "minute" });
  const forecasts = new Map(view.forecasts.map(f => [f.rank, f]));
  const plan = (value: bigint, action: string, rank: number) => view.canPlan && view.phase === "ready"
    ? html`<button class="button button--text" type="button" title=${action}
        aria-label=${`${action} · #${rank} · ${numbers.format(value)}`}
        @click=${() => view.onPlan(String(value))}>${numbers.format(value)}</button>`
    : numbers.format(value);
  return html`<section class="surface stack stack--tight">
    ${renderDetailSectionHeading(forecasts.size ? t("forecast", "Cutoff at recent pace") : t("samples", "Samples"), "stats")}
    <div class="table-scroll"><table class="data-table data-table--numeric">
      <thead><tr>
        <th scope="col">${t("rank", "Rank")}</th>
        <th scope="col" class="is-numeric">${t("score", "Score")}</th>
        ${forecasts.size ? html`
          <th scope="col" class="is-numeric">${view.board === "points" ? t("forecastCutoff", "Points at deadline") : t("forecastTotalCutoff", "Score at deadline")}</th>
          <th scope="col" class="is-numeric">${t("perHour", "Gain/hr")}</th>
          <th scope="col">${t("forecastWindow", "Recent observations")}</th>` : nothing}
        <th scope="col">${t("time", "Time")}</th>
      </tr></thead>
      <tbody>${primary.map(line => {
        const latest = line.samples.findLast(sample => sample.score !== null);
        const forecast = forecasts.get(line.rank);
        return html`<tr>
          <th scope="row"><span class="history-rank-label nowrap">${swatch(rankColor(line.rank))} #${line.rank}</span></th>
          <td class="is-numeric">${latest?.score != null ? plan(BigInt(latest.score), t("planLatest", "Use as target PT"), line.rank) : "—"}</td>
          ${forecasts.size ? html`
            <td class="is-numeric">${forecast ? plan(forecast.score, t("planForecast", "Plan to forecast cutoff"), line.rank) : "—"}</td>
            <td class="is-numeric">${forecast ? numbers.format(forecast.gainPerHour) : "—"}</td>
            <td>${forecast ? minutes.format(forecast.minutes) : "—"}</td>` : nothing}
          <td>${latest ? html`<time datetime=${new Date(latest.atMs).toISOString()}>${time.format(latest.atMs)}</time>` : "—"}</td>
        </tr>`;
      })}</tbody>
    </table></div>
  </section>`;
}

export function renderEventHistory(view: EventHistoryView) {
  const { t } = view;
  const plot = renderRankHistoryChart({ locale: view.locale, series: view.series,
    title: t("chart", "Rank history"), label: t("chartLabel", "Score by elapsed time") });
  return html`<div class="stack">
    <div class="grid history-controls">
      ${historySelect(t("board", "Board"), view.board, view.boards, view.onBoard)}
      ${historySelect(t("comparison", "Compare with"), view.comparison, view.comparisons, view.onComparison, {
        disabled: view.comparisons.length <= 1,
      })}
    </div>
    <div class="stack" aria-busy=${String(view.phase === "loading")}>
      ${plot}
      ${view.phase === "loading" ? html`<p role="status">${t("loading", "Loading")}</p>` : nothing}
      ${view.phase === "error" ? errorState(t("error", "History unavailable"), t("load", "Load"), view.onRetry) : nothing}
      ${view.phase === "ready" && plot === nothing ? emptyState({ title: t("empty", "No samples") }) : nothing}
      ${plot !== nothing && view.phase === "ready" ? scores(view) : nothing}
    </div>
  </div>`;
}
