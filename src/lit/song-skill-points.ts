import { LitElement, html, nothing } from "lit";
import { renderDetailSectionHeading } from "./shared/detail-section-heading";
import { skillTimeline } from "./shared/skill-timeline";
import "../styles/components/skill-timeline.css";
import { clientText } from "../i18n/client";
import type { ChartSource } from "../lib/team-builder/engine/chart";

/** Every live skill lasts five seconds before snap extensions (MasterLiveSkillEffect). */
const SKILL_MS = 5000;

/** The selected chart's skill events and Gekisou sections, with the notes each skill window covers. */
export class SongSkillPoints extends LitElement {
  static properties = {
    source: { type: String },
    locale: { type: String },
    chart: { state: true },
  };
  declare source: string;
  declare locale: string;
  declare chart: ChartSource | null;
  private loaded = "";
  private request?: AbortController;
  constructor() {
    super();
    this.source = "";
    this.locale = "ja";
    this.chart = null;
  }
  createRenderRoot() {
    return this;
  }
  connectedCallback() {
    super.connectedCallback();
    this.classList.add("detail-section", "song-detail-section", "song-skill-points");
  }
  disconnectedCallback() {
    this.request?.abort();
    super.disconnectedCallback();
  }
  willUpdate() {
    if (this.source === this.loaded) return;
    this.loaded = this.source;
    this.chart = null;
    this.request?.abort();
    if (!this.source) return;
    const controller = new AbortController();
    this.request = controller;
    void (async () => {
      const response = await fetch(this.source, { signal: controller.signal, credentials: "omit" });
      if (!response.ok) return;
      const { convertChartBytes } = await import("../lib/team-builder/engine/chart");
      const chart = await convertChartBytes(new Uint8Array(await response.arrayBuffer()));
      if (!controller.signal.aborted) this.chart = chart;
    })().catch(() => undefined);
  }
  private text(key: string, fallback: string) {
    return clientText(this.locale, key, fallback);
  }
  updated() {
    this.hidden = !this.source || (this.chart !== null && !this.chart.skillTimesMs.length);
  }
  render() {
    const chart = this.chart;
    const heading = renderDetailSectionHeading(this.text("catalog.songs.skillPoints", "Skill points"), "skills");
    if (!chart) return html`${heading}<div class="skill-timeline__plot" aria-busy="true"></div>`;
    if (!chart.skillTimesMs.length) return nothing;
    const notes = chart.notes.filter((note) => note.judged).map((note) => note.timeMs);
    const end = Math.max(chart.durationMs, ...notes) + 1000;
    const density = new Array<number>(Math.ceil(end / 500)).fill(0);
    for (const time of notes) density[Math.floor(time / 500)]!++;
    const covered = chart.skillTimesMs.map((start) => notes.filter((time) => time >= start && time < start + SKILL_MS).length);
    const ranked = [...covered].sort((a, b) => b - a);
    const share = new Intl.NumberFormat(this.locale, { style: "percent", maximumFractionDigits: 1 });
    const notesLabel = this.text("catalog.analysis.fields.n", "Notes");
    return html`
        ${heading}
        ${skillTimeline({
          label: this.text("catalog.songs.skillPoints", "Skill points"),
          durationMs: end,
          density,
          fever: chart.feverMs,
          feverLabel: (index) => `${this.text("catalog.analysis.fields.gekisouSegment", "Gekisou stage")} ${index + 1}`,
          windows: chart.skillTimesMs.map((start, index) => ({
            startMs: start,
            endMs: start + SKILL_MS,
            label: `${notesLabel} ${covered[index]}`,
            value: `${share.format(covered[index]! / Math.max(1, notes.length))} · #${ranked.indexOf(covered[index]!) + 1}`,
          })),
        })}
    `;
  }
}

if (!customElements.get("song-skill-points")) customElements.define("song-skill-points", SongSkillPoints);
