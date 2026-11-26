// L3 — GEB
// Input: Event cutoff observations aligned by elapsed time.
// Output: A shared score or percentage chart with a zoomable time range.
// Pos: [Map](../L2-2.md); activity history and cutoff growth chart.
// Effects/Dependencies: Keeps the time viewport and pointer selection local to the chart.
import { html, LitElement, nothing, svg } from "lit";
import { clientText } from "../../i18n/client";
import { renderDetailSectionHeading } from "../shared/detail-section-heading";
import { iconButton, segmented } from "../ui/controls";

export type RankHistorySeries = {
  label: string;
  rank: number;
  comparison: boolean;
  samples: { atMs: number; elapsedMs: number; score: string | null }[];
};

type ChartView = {
  locale: string; series: RankHistorySeries[]; title: string; label: string; percentage?: boolean;
};
type TimeWindow = { from: number; to: number };
type Point = { at: number; value: number };

const LEFT = 78, RIGHT = 544, TOP = 16, BOTTOM = 244;
const TICKS = [0, 0.25, 0.5, 0.75, 1];
const HOUR = 3_600_000;
const COLORS = ["primary", "tertiary", "secondary", "error", "on-surface-variant"];

export function rankColor(rank: number) {
  const index = rank <= 10 ? rank - 1 : 8 + rank / 10;
  const base = `var(--md-sys-color-${COLORS[index % COLORS.length]})`;
  const mix = [100, 70, 80, 55][Math.floor(index / COLORS.length)];
  const target = index < 10 ? "on-surface" : "surface";
  return `color-mix(in srgb, ${base} ${mix}%, var(--md-sys-color-${target}))`;
}

export function rankSwatch(color: string, dashed = false) {
  return html`<svg width="16" height="8" aria-hidden="true"><path d="M0 4H16" stroke=${color}
    stroke-width="2" stroke-dasharray=${dashed ? "4 3" : nothing}></path></svg>`;
}

function visibleRuns(series: RankHistorySeries, window: TimeWindow): Point[][] {
  const runs: Point[][] = [];
  let run: Point[] = [];
  let previous: Point | undefined;
  const append = (point: Point) => {
    if (!run.length) runs.push(run);
    run.push(point);
  };
  const interpolate = (left: Point, right: Point, at: number) =>
    ({ at, value: left.value + (right.value - left.value) * (at - left.at) / (right.at - left.at) });
  for (const { elapsedMs: at, score } of series.samples) {
    const value = score === null ? NaN : Number(score);
    if (!Number.isFinite(value)) {
      previous = undefined;
      run = [];
      if (at > window.to) break;
      continue;
    }
    const point = { at, value };
    if (previous && previous.at < window.from && at > window.from) {
      append(interpolate(previous, point, window.from));
    }
    if (at > window.to) {
      if (previous && previous.at < window.to) append(interpolate(previous, point, window.to));
      break;
    }
    if (at >= window.from) append(point);
    previous = point;
  }
  return runs;
}

class RankHistoryChart extends LitElement {
  static properties = { view: { attribute: false }, selection: { state: true } };
  declare view: ChartView;
  declare private selection?: TimeWindow;
  private drag?: { id: number; start: number; window: TimeWindow };

  createRenderRoot() { return this; }

  private label(key: string, fallback: string) {
    return clientText(this.view.locale, `tools.eventTracker.chartZoom.${key}`, fallback);
  }

  private window(end: number): TimeWindow {
    if (!this.selection) return { from: 0, to: end };
    const length = Math.min(end, this.selection.to - this.selection.from);
    const from = Math.min(this.selection.from, end - length);
    return { from, to: from + length };
  }

  private shift(window: TimeWindow, end: number, direction: -1 | 1) {
    const length = window.to - window.from;
    const from = Math.max(0, Math.min(end - length, window.from + direction * length));
    this.selection = { from, to: from + length };
  }

  private coordinate(event: PointerEvent) {
    const chart = event.currentTarget as SVGSVGElement;
    const matrix = chart.getScreenCTM();
    return matrix ? new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse()) : undefined;
  }

  private startDrag(event: PointerEvent, window: TimeWindow) {
    if (event.pointerType !== "mouse" || event.button !== 0) return;
    const point = this.coordinate(event);
    if (!point || point.x < LEFT || point.x > RIGHT || point.y < TOP || point.y > BOTTOM) return;
    event.preventDefault();
    const chart = event.currentTarget as SVGSVGElement;
    this.drag = { id: event.pointerId, start: point.x, window };
    chart.setPointerCapture(event.pointerId);
  }

  private drawDrag(event: PointerEvent) {
    if (this.drag?.id !== event.pointerId) return;
    const point = this.coordinate(event);
    if (!point) return;
    const x = Math.max(LEFT, Math.min(RIGHT, point.x));
    const marker = (event.currentTarget as SVGSVGElement).querySelector(".history-selection");
    marker?.setAttribute("x", String(Math.min(x, this.drag.start)));
    marker?.setAttribute("width", String(Math.abs(x - this.drag.start)));
  }

  private endDrag(event: PointerEvent, commit: boolean) {
    const drag = this.drag;
    if (drag?.id !== event.pointerId) return;
    this.drag = undefined;
    (event.currentTarget as SVGSVGElement).querySelector(".history-selection")?.setAttribute("width", "0");
    if (!commit) return;
    const point = this.coordinate(event);
    if (!point) return;
    const x = Math.max(LEFT, Math.min(RIGHT, point.x));
    if (Math.abs(x - drag.start) < 4) return;
    const time = (value: number) => drag.window.from + (value - LEFT) / (RIGHT - LEFT) * (drag.window.to - drag.window.from);
    const from = time(Math.min(x, drag.start)), to = time(Math.max(x, drag.start));
    if (to - from >= 15_000) this.selection = { from, to };
  }

  render() {
    const { locale, series, percentage, title, label } = this.view;
    const end = series.reduce((max, line) => line.samples.reduce((last, point) => Math.max(last, point.elapsedMs), max), 1);
    const window = this.window(end), duration = window.to - window.from;
    const visible = series.map((line) => visibleRuns(line, window));
    let min = Infinity, max = -Infinity;
    for (const runs of visible) for (const run of runs) for (const point of run) {
      min = Math.min(min, point.value);
      max = Math.max(max, point.value);
    }
    const hasPoints = Number.isFinite(min);
    if (hasPoints && min === max) {
      const padding = percentage ? 0.001 : 1;
      min -= padding;
      max += padding;
    }
    const x = (fraction: number) => LEFT + fraction * (RIGHT - LEFT);
    const y = (fraction: number) => BOTTOM - fraction * (BOTTOM - TOP);
    const scale = new Intl.NumberFormat(locale, percentage
      ? { style: "percent", maximumFractionDigits: 1 }
      : { notation: "compact", maximumFractionDigits: 1 });
    const timeAxis = new Intl.NumberFormat(locale, {
      style: "unit", unit: duration >= HOUR ? "hour" : duration >= 60_000 ? "minute" : "second",
      unitDisplay: "narrow", maximumFractionDigits: 1,
    });
    const timeUnit = duration >= HOUR ? HOUR : duration >= 60_000 ? 60_000 : 1000;
    const path = (runs: Point[][]) => runs.map((run) => run.map(({ at, value }, index) =>
      `${index ? "L" : "M"}${x((at - window.from) / duration).toFixed(1)} ${y((value - min) / (max - min)).toFixed(1)}`).join("")).join("");
    const primary = series.filter(line => !line.comparison);
    const compared = series.find(line => line.comparison);
    const presets = [24 * HOUR, 6 * HOUR, HOUR, HOUR / 4].filter((span) => span < end).slice(0, 2);
    if (!presets.length && end > 30_000) presets.push(Math.floor(end / 2000) * 1000);
    const selected = !this.selection ? "all" : String(presets.find(span => Math.abs(span - duration) < 1) ?? "");
    const unit = (span: number) => new Intl.NumberFormat(locale, {
      style: "unit", unit: span >= HOUR ? "hour" : span >= 60_000 ? "minute" : "second",
      unitDisplay: "short", maximumFractionDigits: 1,
    }).format(span / (span >= HOUR ? HOUR : span >= 60_000 ? 60_000 : 1000));
    return html`
      <section class="surface stack stack--tight">
        ${renderDetailSectionHeading(title, "stats")}
        ${presets.length || this.selection ? html`<div class="cluster">
          ${segmented({
            label: this.label("range", "Time range"), value: selected, grow: false,
            options: [{ value: "all", label: this.label("all", "All time") }, ...presets.map(span => ({ value: String(span), label: unit(span) }))],
            onSelect: (value) => { this.selection = value === "all" ? undefined : { from: end - Number(value), to: end }; },
          })}
          <div class="row">
            ${iconButton({ label: this.label("earlier", "Earlier"), icon: "chevron_left", disabled: window.from <= 0,
              onClick: () => this.shift(window, end, -1) })}
            ${iconButton({ label: this.label("later", "Later"), icon: "chevron_right", disabled: window.to >= end,
              onClick: () => this.shift(window, end, 1) })}
          </div>
        </div>` : nothing}
        <svg class="history-chart" viewBox="0 0 560 272" role="img" aria-label=${label}
          @pointerdown=${(event: PointerEvent) => this.startDrag(event, window)}
          @pointermove=${this.drawDrag}
          @pointerup=${(event: PointerEvent) => this.endDrag(event, true)}
          @pointercancel=${(event: PointerEvent) => this.endDrag(event, false)}
          @lostpointercapture=${(event: PointerEvent) => this.endDrag(event, false)}>
          ${TICKS.map(f => svg`
            <path class="history-grid" d=${`M${x(f)} ${TOP}V${BOTTOM}M${LEFT} ${y(f)}H${RIGHT}`}></path>
            ${hasPoints ? svg`<text x=${LEFT - 8} y=${y(f)} text-anchor="end" dominant-baseline="middle">${scale.format(min + f * (max - min))}</text>` : nothing}
            <text x=${x(f)} y="264" text-anchor=${f === 0 ? "start" : f === 1 ? "end" : "middle"}>${timeAxis.format((window.from + f * duration) / timeUnit)}</text>
          `)}
          ${hasPoints ? series.map((line, index) => svg`
            <path class="history-line" d=${path(visible[index]!)} stroke=${rankColor(line.rank)}
              stroke-dasharray=${line.comparison ? "6 4" : nothing}><title>${line.label ? `${line.label} · ` : ""}#${line.rank}</title></path>`)
            : svg`<text x=${x(0.5)} y=${y(0.5)} text-anchor="middle">${this.label("empty", "No rankings in this range")}</text>`}
          <rect class="history-selection" x=${LEFT} y=${TOP} width="0" height=${BOTTOM - TOP} aria-hidden="true"></rect>
        </svg>
        ${compared ? html`<div class="cluster history-event-key">
          <span>${rankSwatch("currentColor")} ${primary[0]?.label}</span>
          <span>${rankSwatch("currentColor", true)} ${compared.label}</span>
        </div>` : nothing}
        <div class="cluster history-key">
          ${primary.map(line => html`<span>${rankSwatch(rankColor(line.rank))} #${line.rank}</span>`)}
        </div>
      </section>`;
  }
}

if (!customElements.get("rank-history-chart")) customElements.define("rank-history-chart", RankHistoryChart);

export function renderRankHistoryChart(view: ChartView) {
  return view.series.some(line => line.samples.some(point => point.score !== null))
    ? html`<rank-history-chart .view=${view}></rank-history-chart>`
    : nothing;
}
