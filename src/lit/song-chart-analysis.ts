// L3 — GEB
// Input: 已载入的谱面与发布版每点综合力分数率。
// Output: 音符构成、激奏段指标、技能位权重与可调场景下的得分。
// Pos: [Map](L2-2.md)；歌曲详情的谱面分析。
// Effects/Dependencies: 纯前端计算，不发请求。
import { LitElement, html, nothing } from "lit";
import { renderDetailSectionHeading } from "./shared/detail-section-heading";
import "../styles/components/song-chart-analysis.css";
import { clientText } from "../i18n/client";
import { gekisouRate, isSongScoreRank, roomRequiredScore, type ChartRates } from "../lib/chart-rates";
import { scoreRankIcon } from "./shared/score-rank";
import type { ChartSource } from "../lib/team-builder/engine/chart";

const KINDS = ["tap", "flick", "long", "trace", "node"] as const;
type Kind = (typeof KINDS)[number];
/** Operate types by the game's note families; 120 is a long note's combo node. */
const kindOf = (op: number): Kind =>
  op >= 120 ? "node" : op >= 60 && op < 80 ? "trace" : op >= 40 && op < 60 ? "flick" : op >= 20 && op < 40 ? "long" : "tap";
// The time between lives that per-minute values count.
const MIN_EXTRA_SECONDS = 30;
const MISSION_KEYS: Record<number, string> = { 1: "gekisouMissionCombo", 2: "gekisouMissionLuck", 3: "gekisouMissionJustCount", 4: "gekisouMissionAll" };

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
    const gekisou = this.rates?.gekisou;
    return html`
      <section class="song-analysis__block">
        ${renderDetailSectionHeading(this.text("sections", "Gekisou sections"), "effects")}
        <div class="table-scroll"><table class="data-table">
          <thead><tr>
            <th>${this.text("section", "Section")}</th>
            <th>${this.text("metric", "Ranked by")}</th><th>${this.text("sectionNotes", "Notes")}</th>
            ${gekisou ? html`<th>Just</th>` : nothing}
            <th>${this.text("startCombo", "Starting combo")}</th><th>${this.text("seconds", "Length")}</th>
          </tr></thead>
          <tbody>${fever.map(([start, end], index) => html`<tr>
            <td>${index + 1}</td>
            <td>${gekisou ? clientText(this.locale, `catalog.songs.gekisou.${MISSION_KEYS[gekisou.missions[index]!] ?? "gekisouMissionNone"}`, "") : "—"}</td>
            <td>${this.number(gekisou?.notes[index] ?? notes.filter((note) => note.timeMs >= start && note.timeMs < end).length)}</td>
            ${gekisou ? html`<td>${this.number(gekisou.just[index] ?? 0)}</td>` : nothing}
            <td>${this.number(notes.filter((note) => note.timeMs < start).length)}</td>
            <td>${this.number((end - start) / 1000, 1)}s</td>
          </tr>`)}</tbody>
        </table></div>
      </section>
    `;
  }
  private segmented(values: readonly number[], current: number, pick: (value: number) => void, label: (value: number) => string = String) {
    return html`<div class="segmented">${values.map((value) => html`
      <button type="button" aria-pressed=${value === current} @click=${() => pick(value)}>${label(value)}</button>`)}</div>`;
  }
  private slider(label: string, value: number, pick: (value: number) => void) {
    return html`<label class="song-analysis__great">
      <span>${label}</span>
      <input type="range" min="0" max="100" step="1" .value=${String(Math.round(value * 100))}
        @input=${(event: Event) => pick(Number((event.target as HTMLInputElement).value) / 100)} />
      <output>${Math.round(value * 100)}%</output>
    </label>`;
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
        <div class="song-analysis__controls">
          ${rates.gekisou ? this.segmented([1, 0], this.gekisou ? 1 : 0, (value) => (this.gekisou = value === 1),
            (value) => (value ? this.text("gekisouLive", "Gekisou Live") : this.text("freeLive", "Free Live"))) : nothing}
          ${gekisou ? html`<div class="song-analysis__ranks">${this.ranks.map((rank, index) => html`
            <div><span>${this.text("section", "Section")} ${index + 1} · ${this.text("placement", "Place")}</span>
            ${this.segmented([1, 2, 3, 4, 5], rank, (value) => {
              const next = [...this.ranks];
              next[index] = value;
              this.ranks = next;
            })}</div>`)}</div>
            ${this.slider(this.text("justShare", "Just share"), this.just, (value) => (this.just = value))}` : nothing}
          ${this.slider(this.text("greatShare", "Great share"), this.great, (value) => (this.great = value))}
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
          ${gekisou ? html`<div><dt>${this.text("recordPerPower", "Song record / power")}</dt><dd>${this.number(free, 3)}</dd></div>` : nothing}
          <div><dt>${this.text("perMinute", "Score / power / minute")}</dt><dd>${this.number(perPower / minutes, 3)}</dd></div>
          <div><dt>${this.text("base", "No skills")}</dt><dd>${this.number(base, 3)}</dd></div>
          <div><dt>${this.text("skip", "Skip")}</dt><dd>${this.number(rates.skip, 3)}</dd></div>
        </dl>
        <h4 class="song-analysis__subhead">${this.text("slotWeights", "Skill slot weights")}</h4>
        <ol class="song-analysis__slots">
          ${weights.map((value, index) => html`<li>
            <span>#${index + 1}</span>
            <i class="song-analysis__slot-track"><i style=${`width:${(Math.max(0, value) / total) * 100}%`}></i></i>
            <b>${this.number(value, 3)}</b><small>${Math.round((value / total) * 100)}%</small>
          </li>`)}
        </ol>
        <h4 class="song-analysis__subhead">${this.text("thresholds", "Rank thresholds")}</h4>
        <div class="song-analysis__controls">
          ${gekisou ? html`<div class="song-analysis__ranks"><div><span>${this.text("roomSize", "Room size")}</span>
            ${this.segmented([1, 2, 3, 4, 5], this.room, (value) => (this.room = value))}</div></div>` : nothing}
          <label class="song-analysis__power"><span>${this.text("power", "Power")}</span>
            <input class="song-analysis__skill" type="number" min="0" step="1000" inputmode="numeric" .value=${String(this.power)}
              @input=${(event: Event) => (this.power = Math.max(0, Number((event.target as HTMLInputElement).value) || 0))} /></label>
        </div>
        <div class="table-scroll"><table class="data-table">
          <thead><tr>
            <th>${this.text("rank", "Rank")}</th>
            <th>${gekisou ? this.text("scorePerPlayer", "Score per player") : this.text("score", "Score")}</th>
            <th>${this.text("powerNeeded", "Power needed")}</th>
            <th>${this.text("reached", "Reached")}</th>
          </tr></thead>
          <tbody>${thresholds.map((row) => html`<tr>
            <td>${scoreRankIcon(this.server, row.rank)}</td>
            <td>${this.number(row.score)}</td>
            <td>${this.number(row.power)}</td>
            <td>${Math.min(100, Math.max(0, Math.floor(((this.power * perPower - rates.notes) / Math.max(1, row.score)) * 100)))}%</td>
          </tr>`)}</tbody>
        </table></div>
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
