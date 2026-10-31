// L3 — GEB
// Input: 已载入的谱面与发布版每点综合力分数率。
// Output: 音符构成、激奏段指标、技能位权重与可调场景下的得分。
// Pos: [Map](L2-2.md)；歌曲详情的谱面分析。
// Effects/Dependencies: 纯前端计算，不发请求。
import { LitElement, html, nothing } from "lit";
import { renderDetailSectionHeading } from "./shared/detail-section-heading";
import "../styles/components/song-chart-analysis.css";
import { clientText } from "../i18n/client";
import type { ChartRates } from "../lib/chart-rates";
import type { ChartSource } from "../lib/team-builder/engine/chart";

const KINDS = ["tap", "flick", "long", "trace", "node"] as const;
type Kind = (typeof KINDS)[number];
/** Operate types by the game's note families; 120 is a long note's combo node. */
const kindOf = (op: number): Kind =>
  op >= 120 ? "node" : op >= 60 && op < 80 ? "trace" : op >= 40 && op < 60 ? "flick" : op >= 20 && op < 40 ? "long" : "tap";
// The time between lives that per-minute values count.
const MIN_EXTRA_SECONDS = 30;

export class SongChartAnalysis extends LitElement {
  static properties = {
    chart: { attribute: false },
    rates: { attribute: false },
    greatFactor: { type: Number },
    chartId: { type: String },
    locale: { type: String },
    great: { state: true },
    skills: { state: true },
  };
  declare chart: ChartSource | null;
  declare rates: ChartRates | null;
  declare greatFactor: number;
  declare chartId: string;
  declare locale: string;
  declare great: number;
  declare skills: number[];
  constructor() {
    super();
    this.chart = null;
    this.rates = null;
    this.greatFactor = 0.8;
    this.chartId = "";
    this.locale = "ja";
    this.great = 0;
    this.skills = [100, 100, 100, 100, 100];
  }
  createRenderRoot() {
    return this;
  }
  private text(key: string, fallback: string) {
    return clientText(this.locale, `catalog.songs.analysis.${key}`, fallback);
  }
  private number(value: number, digits = 0) {
    return value.toLocaleString(this.locale, { minimumFractionDigits: digits, maximumFractionDigits: digits });
  }
  private composition(notes: ChartSource["notes"]) {
    const counts = new Map<Kind, number>();
    for (const note of notes) counts.set(kindOf(note.operateType), (counts.get(kindOf(note.operateType)) ?? 0) + 1);
    return html`
      <section class="song-analysis__block">
        ${renderDetailSectionHeading(this.text("composition", "Note composition"), "details")}
        <div class="song-analysis__bar" aria-hidden="true">
          ${KINDS.map((kind) => html`<span class=${`song-analysis__bar-${kind}`} style=${`flex-grow:${counts.get(kind) ?? 0}`}></span>`)}
        </div>
        <dl class="song-analysis__legend">
          ${KINDS.filter((kind) => counts.get(kind)).map((kind) => html`
            <div>
              <dt><i class=${`song-analysis__bar-${kind}`}></i>${this.text(kind, kind)}</dt>
              <dd>${this.number(counts.get(kind)!)}<small>${Math.round((counts.get(kind)! / notes.length) * 100)}%</small></dd>
            </div>
          `)}
        </dl>
      </section>
    `;
  }
  private sections(notes: ChartSource["notes"], fever: ChartSource["feverMs"]) {
    if (!fever.length) return nothing;
    return html`
      <section class="song-analysis__block">
        ${renderDetailSectionHeading(this.text("sections", "Gekisou sections"), "effects")}
        <div class="table-scroll"><table class="data-table">
          <thead><tr>
            <th>${this.text("section", "Section")}</th><th>${this.text("sectionNotes", "Notes")}</th>
            <th>${this.text("startCombo", "Starting combo")}</th><th>${this.text("seconds", "Length")}</th>
          </tr></thead>
          <tbody>${fever.map(([start, end], index) => html`<tr>
            <td>${index + 1}</td>
            <td>${this.number(notes.filter((note) => note.timeMs >= start && note.timeMs < end).length)}</td>
            <td>${this.number(notes.filter((note) => note.timeMs < start).length)}</td>
            <td>${this.number((end - start) / 1000, 1)}s</td>
          </tr>`)}</tbody>
        </table></div>
      </section>
    `;
  }
  private scenario(rates: ChartRates, durationMs: number) {
    const general = 1 - this.great * (1 - this.greatFactor);
    const events = rates.windows[0] ?? [];
    const weights = events.map((value) => value * general);
    const total = weights.reduce((sum, value) => sum + value, 0) || 1;
    const perPower = rates.base * general + weights.reduce((sum, value, index) => sum + value * ((this.skills[index] ?? 0) / 100), 0);
    const minutes = (durationMs / 1000 + MIN_EXTRA_SECONDS) / 60;
    return html`
      <section class="song-analysis__block">
        ${renderDetailSectionHeading(this.text("scenario", "Score scenario"), "rewards")}
        <div class="song-analysis__controls">
          <label class="song-analysis__great">
            <span>${this.text("greatShare", "Great share")}</span>
            <input type="range" min="0" max="100" step="1" .value=${String(this.great * 100)}
              @input=${(event: Event) => (this.great = Number((event.target as HTMLInputElement).value) / 100)} />
            <output>${Math.round(this.great * 100)}%</output>
          </label>
          <div class="song-analysis__skills">
            ${this.skills.map((value, index) => html`
              <label><span>${this.text("skill", "Skill")} ${index + 1}</span>
                <input class="song-analysis__skill" type="number" min="0" max="400" step="5" inputmode="numeric" .value=${String(value)}
                  @input=${(event: Event) => {
                    const next = [...this.skills];
                    next[index] = Math.max(0, Number((event.target as HTMLInputElement).value) || 0);
                    this.skills = next;
                  }} /><i>%</i></label>
            `)}
          </div>
        </div>
        <dl class="song-analysis__stats">
          <div><dt>${this.text("perPower", "Score / power")}</dt><dd>${this.number(perPower, 3)}</dd></div>
          <div><dt>${this.text("perMinute", "Score / power / minute")}</dt><dd>${this.number(perPower / minutes, 3)}</dd></div>
          <div><dt>${this.text("base", "No skills")}</dt><dd>${this.number(rates.base * general, 3)}</dd></div>
          <div><dt>${this.text("skip", "Skip")}</dt><dd>${this.number(rates.skip, 3)}</dd></div>
        </dl>
        <h4 class="song-analysis__subhead">${this.text("slotWeights", "Skill slot weights")}</h4>
        <ol class="song-analysis__slots">
          ${weights.map((value, index) => html`<li>
            <span>#${index + 1}</span>
            <i class="song-analysis__slot-track"><i style=${`width:${(value / total) * 100}%`}></i></i>
            <b>${this.number(value, 3)}</b><small>${Math.round((value / total) * 100)}%</small>
          </li>`)}
        </ol>
      </section>
    `;
  }
  render() {
    const chart = this.chart;
    if (!chart) return nothing;
    const notes = chart.notes.filter((note) => note.judged);
    if (!notes.length) return nothing;
    return html`
      ${this.composition(notes)}
      ${this.sections(notes, chart.feverMs)}
      ${this.rates ? this.scenario(this.rates, chart.durationMs) : nothing}
      ${this.chartId ? html`<p class="song-analysis__id">${this.text("chartId", "Chart ID")} ${this.chartId}</p>` : nothing}
    `;
  }
}
if (!customElements.get("song-chart-analysis")) customElements.define("song-chart-analysis", SongChartAnalysis);
