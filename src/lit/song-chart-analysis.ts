// L3 — GEB
// Input: 已载入的谱面与发布版每点综合力分数率。
// Output: 音符构成、三个激奏段的最大 Just 数、技能位权重与可调场景得分。
// Pos: [Map](L2-2.md)；歌曲详情的谱面分析。
// Effects/Dependencies: 纯前端计算，不发请求。
import { LitElement, html, nothing } from "lit";
import { renderDetailSectionHeading } from "./shared/detail-section-heading";
import "../styles/components/song-chart-analysis.css";
import { clientText } from "../i18n/client";
import { gekisouRate, isSongScoreRank, roomRequiredScore, type ChartRates } from "../lib/chart-rates";
import { scoreRankIcon } from "./shared/score-rank";
import type { ChartSource } from "../lib/team-builder/engine/chart";
import { segmented, numberField } from "./ui/controls";
import { renderLevelSwitch } from "./ui/level-switch";
import { collectionTable } from "./ui/collection-view";
import "@material/web/textfield/outlined-text-field.js";

const KINDS = ["tap", "flick", "long", "trace", "node"] as const;
type Kind = (typeof KINDS)[number];
/** Operate types by the game's note families; 120 is a long note's combo node. */
const kindOf = (op: number): Kind =>
  op >= 120 ? "node" : op >= 60 && op < 80 ? "trace" : op >= 40 && op < 60 ? "flick" : op >= 20 && op < 40 ? "long" : "tap";
// The time between lives that per-minute values count.
const MIN_EXTRA_SECONDS = 30;
const PERCENTS = Array.from({ length: 101 }, (_, index) => index);

export class SongChartAnalysis extends LitElement {
  static properties = {
    chart: { attribute: false },
    rates: { attribute: false },
    greatFactor: { type: Number },
    chartId: { type: String },
    server: { type: String },
    locale: { type: String },
    great: { state: true },
    skills: { state: true },
    gekisou: { state: true },
    ranks: { state: true },
    just: { state: true },
    room: { state: true },
    power: { state: true },
    pending: { type: Boolean },
  };
  declare chart: ChartSource | null;
  declare rates: ChartRates | null;
  declare greatFactor: number;
  declare chartId: string;
  declare server: string;
  declare locale: string;
  declare great: number;
  declare skills: number[];
  declare gekisou: boolean;
  declare ranks: number[];
  declare just: number;
  declare room: number;
  declare power: number;
  declare pending: boolean;
  constructor() {
    super();
    this.chart = null;
    this.rates = null;
    this.greatFactor = 0.8;
    this.chartId = "";
    this.server = "jp";
    this.locale = "ja";
    this.great = 0;
    this.skills = [100, 100, 100, 100, 100];
    this.gekisou = true;
    this.ranks = [1, 1, 1];
    this.just = 1;
    this.room = 5;
    this.power = 300000;
    this.pending = false;
  }
  createRenderRoot() {
    return this;
  }
  private text(key: string, fallback: string) {
    return clientText(this.locale, `catalog.songs.analysis.${key}`, fallback);
  }
  private number(value: number, digits = 0) {
    if (this.pending) return "—";
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
              <dd>${counts.get(kind)!.toLocaleString(this.locale)}<small>${Math.round((counts.get(kind)! / notes.length) * 100)}%</small></dd>
            </div>
          `)}
        </dl>
      </section>
    `;
  }
  private choice(label: string, values: readonly number[], current: number, pick: (value: number) => void, format: (value: number) => string = String) {
    return segmented({ label, value: String(current), options: values.map(value => ({ value: String(value), label: format(value) })),
      onSelect: value => pick(Number(value)) });
  }
  private slider(label: string, value: number, pick: (value: number) => void) {
    return renderLevelSwitch(label, PERCENTS, Math.round(value * 100), next => pick(next / 100), next => `${next}%`, { context: this.chart });
  }
  private scenario(rates: ChartRates, durationMs: number) {
    const general = 1 - this.great * (1 - this.greatFactor);
    const gekisou = this.gekisou ? rates.gekisou : undefined;
    const free = rates.base * general + (rates.windows[0] ?? []).reduce((sum, value, index) => sum + value * general * ((this.skills[index] ?? 0) / 100), 0);
    const perPower = gekisou ? gekisouRate(gekisou, this.ranks, this.just, general, this.skills) : free;
    const base = gekisou ? gekisouRate(gekisou, this.ranks, this.just, general, [0, 0, 0, 0, 0]) : rates.base * general;
    const weights = gekisou
      ? [0, 1, 2, 3, 4].map((event) => gekisouRate(gekisou, this.ranks, this.just, general, this.skills.map((_, index) => (index === event ? 100 : 0))) - base)
      : (rates.windows[0] ?? []).map((value) => value * general);
    const total = weights.reduce((sum, value) => sum + value, 0) || 1;
    const minutes = (durationMs / 1000 + MIN_EXTRA_SECONDS) / 60;
    const thresholds = rates.ranks.filter(([rank]) => isSongScoreRank(rank)).reverse().map(([rank, solo, battle]) => {
      const score = gekisou ? Math.ceil(roomRequiredScore(battle, this.room) / this.room) : solo;
      return { rank, score, power: Math.ceil((score + rates.notes) / perPower) };
    });
    return html`
      <section class="song-analysis__block">
        ${renderDetailSectionHeading(this.text("scenario", "Score scenario"), "rewards")}
        <div class="stack stack--tight">
          ${rates.gekisou ? this.choice(this.text("scenario", "Score scenario"), [1, 0], this.gekisou ? 1 : 0, (value) => (this.gekisou = value === 1),
            (value) => (value ? this.text("gekisouLive", "GEKISO Live") : this.text("freeLive", "Free Live"))) : nothing}
          ${gekisou ? html`<div class="song-analysis__ranks">${this.ranks.map((rank, index) => html`
            <div><span>${this.text("section", "Section")} ${index + 1} / ${this.text("placement", "Place")}</span>
            ${this.choice(`${this.text("section", "Section")} ${index + 1} / ${this.text("placement", "Place")}`, [1, 2, 3, 4, 5], rank, (value) => {
              const next = [...this.ranks];
              next[index] = value;
              this.ranks = next;
            })}</div>`)}</div>
            ${this.slider(this.text("justShare", "Just share"), this.just, (value) => (this.just = value))}` : nothing}
          ${this.slider(this.text("greatShare", "Great share"), this.great, (value) => (this.great = value))}
          <div class="filter-range filter-range--five">
            ${this.skills.map((value, index) => numberField({
              label: `${this.text("skill", "Skill")} ${index + 1}`, value, min: 0, max: 400, step: 5, suffix: "%",
              onInput: next => { this.skills = this.skills.map((previous, at) => at === index ? next : previous); },
            }))}
          </div>
        </div>
        <dl class="spec-list spec-list--split spec-list--numeric">
          <div><dt>${this.text("perPower", "Score / power")}</dt><dd>${this.number(perPower, 3)}</dd></div>
          ${gekisou ? html`<div><dt>${this.text("recordPerPower", "Song record / power")}</dt><dd>${this.number(free, 3)}</dd></div>` : nothing}
          <div><dt>${this.text("perMinute", "Score / power / minute")}</dt><dd>${this.number(perPower / minutes, 3)}</dd></div>
          <div><dt>${this.text("base", "No skills")}</dt><dd>${this.number(base, 3)}</dd></div>
          <div><dt>${this.text("skip", "Skip")}</dt><dd>${this.number(rates.skip, 3)}</dd></div>
        </dl>
        <h4 class="song-analysis__subhead">${this.text("slotWeights", "Skill slot weights")}</h4>
        <ol class="song-analysis__slots">
          ${weights.map((value, index) => html`<li>
            <span>#${index + 1}</span>
            <i class="song-analysis__slot-track"><i style=${`width:${this.pending ? 0 : (Math.max(0, value) / total) * 100}%`}></i></i>
            <b>${this.number(value, 3)}</b><small>${this.pending ? "—" : `${Math.round((value / total) * 100)}%`}</small>
          </li>`)}
        </ol>
        <h4 class="song-analysis__subhead">${this.text("thresholds", "Rank thresholds")}</h4>
        <div class="stack stack--tight">
          ${gekisou ? html`<div class="song-analysis__ranks"><div><span>${this.text("roomSize", "Room size")}</span>
            ${this.choice(this.text("roomSize", "Room size"), [1, 2, 3, 4, 5], this.room, (value) => (this.room = value))}</div></div>` : nothing}
          ${numberField({ label: this.text("power", "Power"), value: this.power, min: 0, step: 1000,
            onInput: value => { this.power = value; } })}
        </div>
        ${collectionTable(this.text("thresholds", "Rank thresholds"), [
          this.text("rank", "Rank"), gekisou ? this.text("scorePerPlayer", "Score per player") : this.text("score", "Score"),
          this.text("powerNeeded", "Power needed"), this.text("reached", "Reached"),
        ], thresholds.map(row => [scoreRankIcon(this.server, row.rank), this.number(row.score), this.number(row.power),
          this.pending ? "—" : `${Math.min(100, Math.max(0, Math.floor(((this.power * perPower - rates.notes) / Math.max(1, row.score)) * 100)))}%`,
        ]), { numeric: true })}
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
      ${this.rates ? this.scenario(this.rates, chart.durationMs) : nothing}
      ${this.chartId ? html`<p class="song-analysis__id">${this.text("chartId", "Chart ID")} ${this.chartId}</p>` : nothing}
    `;
  }
}
if (!customElements.get("song-chart-analysis")) customElements.define("song-chart-analysis", SongChartAnalysis);
