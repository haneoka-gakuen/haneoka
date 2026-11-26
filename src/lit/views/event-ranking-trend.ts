import { html, nothing } from "lit";
import { accordion } from "../ui/accordion";
import { loadingState } from "../ui/state";
import { renderRankHistoryChart } from "./rank-history-chart";
import type { EventRankingStatisticsView } from "./event-ranking-statistics";

export function renderEventRankingTrend(view: EventRankingStatisticsView) {
  const { trend, t } = view;
  if (!trend) return nothing;
  const { locale } = view;
  const date = new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short" });
  const percent = new Intl.NumberFormat(locale, { style: "percent", signDisplay: "exceptZero", maximumFractionDigits: 2 });
  const hours = new Intl.NumberFormat(locale, { style: "unit", unit: "hour", maximumFractionDigits: 1 });
  const score = new Intl.NumberFormat(locale);
  const change = new Intl.NumberFormat(locale, { signDisplay: "exceptZero" });
  const title = trend.closed ? t("closingChart", "Closing cutoff trend") : t("trendChart", "Cutoff trend");
  return html`
    ${renderRankHistoryChart({
      locale, title, label: t("trendChartLabel", "Cutoff growth by rank"), percentage: true,
      series: trend.lines.map(({ rank, points }) => ({
        rank, label: "", comparison: false,
        samples: points.map(({ atMs, growth }) => ({
          atMs, elapsedMs: Math.max(0, atMs - trend.fromAtMs), score: growth == null ? null : String(growth),
        })),
      })),
    })}
    ${trend.lines.length ? html`<div class="statistics-caption cluster" aria-label=${title}>
      <span>${date.formatRange(trend.fromAtMs, trend.toAtMs)}</span>
      ${trend.changes.filter((entry) => trend.lines.some((line) => line.rank === entry.rank)).map(({ rank, growth }) => html`
        <span>#${rank} ${growth == null ? "—" : percent.format(growth)}</span>`)}
    </div>` : nothing}
    ${view.showComparison ? accordion({
      id: "statistics-surge", label: t("surge", "Top-100 cutoff by song"), expanded: view.expanded.has("surge"),
      onExpandedChange: (open) => {
        view.onExpand("surge", open);
        if (open && view.surgePhase === "idle") view.onSurges();
      },
      content: view.surgePhase === "loading" ? loadingState(t("loading", "Loading"), { local: true })
        : view.surges.length ? html`<div class="table-scroll"><table class="data-table data-table--numeric">
          <thead><tr>
            <th scope="col">${t("board", "Board")}</th>
            <th scope="col" class="is-numeric">#100</th>
            <th scope="col" class="is-numeric">${t("trend", "Cutoff change")}</th>
            <th scope="col" class="is-numeric">${t("growthRate", "Growth rate")}</th>
            <th scope="col" class="is-numeric">${t("trendPeriod", "Time span")}</th>
          </tr></thead>
          <tbody>${view.surges.map((item) => html`<tr>
            <th scope="row">${item.label}</th>
            <td class="is-numeric">${item.cutoff == null ? "—" : score.format(item.cutoff)}</td>
            <td class="is-numeric">${item.change?.delta == null ? "—" : change.format(item.change.delta)}</td>
            <td class="is-numeric">${item.change?.growth == null ? "—" : percent.format(item.change.growth)}</td>
            <td class="is-numeric">${item.periodHours == null ? "—" : hours.format(item.periodHours)}</td>
          </tr>`)}</tbody>
        </table></div>` : nothing,
    }) : nothing}
  `;
}
