// L3 — GEB
// Input: Selected chart, fixed source identity, mission metadata and published rates.
// Output: One editable Gekisou and skill timeline, stage statistics and score analysis.
// Pos: [Map](L2-2.md); song detail chart reader and local mission scenario.
// Effects/Dependencies: Reuses one chart; custom missions lazily read cached live rules and score locally.
import { LitElement, html, nothing, type PropertyValues } from "lit";
import { renderDetailSectionHeading } from "./shared/detail-section-heading";
import { skillTimeline } from "./shared/skill-timeline";
import "../styles/components/skill-timeline.css";
import "../styles/song-gekisou.css";
import { clientText } from "../i18n/client";
import type { ChartSource } from "../lib/team-builder/engine/chart";
import type { ChartRates, GekisouRates } from "../lib/chart-rates";
import type { CrossCatalogIdentity } from "../lib/cross-server/catalog";
import type { GekisoTimingSegment } from "../lib/team-builder/gekiso-timing";
import { crossServerPublicCache } from "../lib/cross-server/cache";
import { gekisouMission } from "../lib/gekisou";
import { iconButton } from "./ui/controls";
import { gameGlyph } from "./ui/icon";
import { collectionTable } from "./ui/collection-view";
import { gekisoTimingView } from "./shared/gekiso-timing";
import { snackbar } from "../lib/snackbar";
import "./song-chart-analysis";
import type { SongRateRequest, SongRateResponse } from "../workers/song-chart-analysis.worker";

export interface SongChartReady { source: string; chart: ChartSource; signal: AbortSignal }
const SKILL_MS = 5000;
const CYCLE = [1, 3, 2];
const RULE_TABLES: Record<string, string> = {
  MasterLiveSettings: "liveSettings", MasterLiveNoteParameter: "noteParameters",
  MasterLiveJudgementParameter: "judgementParameters", MasterLiveJudgementTiming: "judgementTiming",
  MasterLiveComboScoreBonus: "comboScoreBonuses", MasterLiveGekisouRankingScoreBonus: "gekisouRankingScoreBonuses",
  MasterLiveGekisouLuckBasePoint: "gekisouLuckBasePoints", MasterLiveGekisouLuckBonusLot: "gekisouLuckBonusLots",
};
type Row = Record<string, unknown>;
interface RateJob {
  chart: ChartSource;
  level: number;
  missions: number[];
  tables: Record<string, Row[]>;
  resolve(value: GekisouRates): void;
  reject(): void;
  id?: number;
}

export class SongSkillPoints extends LitElement {
  static properties = {
    source: {}, locale: {}, musicId: {}, level: { type: Number }, identity: { attribute: false },
    gekisou: { attribute: false }, rates: { attribute: false }, greatFactor: { type: Number }, chartId: {},
    chart: { state: true }, missions: { state: true }, computed: { state: true }, pending: { state: true },
    timings: { state: true },
  };
  declare source: string;
  declare locale: string;
  declare musicId: string;
  declare level: number;
  declare identity?: CrossCatalogIdentity;
  declare gekisou: Row;
  declare rates: ChartRates | null;
  declare greatFactor: number;
  declare chartId: string;
  declare chart: ChartSource | null;
  private declare missions: number[] | null;
  private declare computed: GekisouRates | null;
  private declare pending: boolean;
  private declare timings: GekisoTimingSegment[] | null;
  private loaded = "";
  private scope = "";
  private request?: AbortController;
  private rulesRequest = new AbortController();
  private generation = 0;
  private variants = new Map<string, GekisouRates>();
  private rules?: ReturnType<SongSkillPoints["loadRules"]>;
  private worker?: Worker;
  private workerChart?: ChartSource;
  private workerRules = false;
  private workerId = 0;
  private running?: RateJob;
  private queued?: RateJob;

  constructor() {
    super();
    this.source = ""; this.locale = "ja"; this.musicId = ""; this.level = 0;
    this.gekisou = {}; this.rates = null; this.greatFactor = 0.8; this.chartId = ""; this.chart = null;
    this.missions = null; this.computed = null; this.pending = false; this.timings = null;
  }
  createRenderRoot() { return this; }
  connectedCallback() {
    super.connectedCallback(); this.classList.add("detail-section", "song-detail-section", "song-skill-points");
    if (this.rulesRequest.signal.aborted) { this.rulesRequest = new AbortController(); this.rules = undefined; }
    if (this.missions) this.requestUpdate("missions");
  }
  disconnectedCallback() {
    this.request?.abort(); this.rulesRequest.abort(); ++this.generation; this.stopWorker();
    this.pending = false;
    if (!this.chart) this.loaded = "";
    super.disconnectedCallback();
  }
  private get original(): number[] {
    const values = this.rates?.gekisou?.missions ?? this.gekisou.missionTypes ?? this.gekisou.missionPattern;
    return Array.isArray(values) ? values.slice(0, 3).map(value => {
      const mission = gekisouMission(value);
      return mission ? { combo: 1, luck: 2, just: 3 }[mission.icon] : Number(value) || 0;
    }) : [];
  }
  private get selected(): number[] { return this.missions ?? this.original; }
  private text(key: string, fallback: string) { return clientText(this.locale, key, fallback); }
  private label = (key: string, fallback: string) => this.text(`catalog.analysis.fields.${key}`, fallback);
  private reset() { this.missions = null; this.computed = null; this.pending = false; ++this.generation; this.stopWorker(); }
  private cycle(index: number) {
    const next = [...this.selected];
    next[index] = CYCLE[(CYCLE.indexOf(next[index]!) + 1) % CYCLE.length]!;
    if (next.every((value, at) => value === this.original[at])) this.reset();
    else this.missions = next;
  }
  protected willUpdate(changes: PropertyValues) {
    const scope = JSON.stringify([this.identity?.server, this.identity?.releaseId, this.identity?.sourceId, this.musicId]);
    if (scope !== this.scope) {
      this.scope = scope; this.reset(); this.rulesRequest.abort(); this.rulesRequest = new AbortController(); this.rules = undefined;
    }
    if (this.source !== this.loaded) {
      this.loaded = this.source; this.chart = null; this.computed = null; this.timings = null; this.pending = false;
      this.variants.clear(); ++this.generation; this.request?.abort();
      this.queued?.reject(); this.queued = undefined;
      if (this.source) void this.readChart();
    }
    if (this.missions && this.chart && (changes.has("missions") || changes.has("chart") || changes.has("rates")))
      void this.calculate();
  }
  private async readChart() {
    const controller = this.request = new AbortController();
    try {
      const response = await fetch(this.source, { signal: controller.signal, credentials: "omit" });
      if (!response.ok) return;
      const { convertChartBytes } = await import("../lib/team-builder/engine/chart");
      const chart = await convertChartBytes(new Uint8Array(await response.arrayBuffer()));
      if (controller.signal.aborted) return;
      this.chart = chart;
      this.dispatchEvent(new CustomEvent<SongChartReady>("song-chart-ready", {
        detail: { source: this.source, chart, signal: controller.signal }, bubbles: true,
      }));
    } catch { return; }
  }
  private async loadRules() {
    const identity = this.identity!;
    const [tools, { dataRows, nativeRow }, timing] = await Promise.all([
      crossServerPublicCache().readCollection("live-tools", identity, this.rulesRequest.signal),
      import("../lib/team-builder/data"), import("../lib/team-builder/gekiso-timing"),
    ]);
    const document = tools as Row;
    const tables = Object.fromEntries(Object.entries(RULE_TABLES).map(([table, key]) => [table,
      dataRows(document[key]).map(row => (row.raw ?? nativeRow(row)) as Row),
    ]));
    const windows = timing.perfectTimings(dataRows(document.judgementTiming).map(value => {
      const row = nativeRow(value);
      return { assistLevel: Number(row.assistLevel), noteSimulateJudgement: Number(row.noteSimulateJudgement),
        noteJudgementType: Number(row.noteJudgementType), beforeMs: Number(row.beforeMs ?? row.before), afterMs: Number(row.afterMs ?? row.after) };
    }));
    return { tables, timing, windows };
  }
  private stopWorker() {
    this.worker?.terminate(); this.worker = undefined; this.workerChart = undefined; this.workerRules = false;
    this.running?.reject(); this.queued?.reject(); this.running = this.queued = undefined;
  }
  private send(job: RateJob) {
    if (!this.worker) {
      this.worker = new Worker(new URL("../workers/song-chart-analysis.worker.ts", import.meta.url), { type: "module" });
      this.worker.onerror = () => this.stopWorker();
      this.worker.onmessage = ({ data }: MessageEvent<SongRateResponse>) => {
        const running = this.running;
        if (!running || data.id !== running.id) return;
        this.running = undefined;
        if (data.result) running.resolve(data.result); else running.reject();
        const queued = this.queued; this.queued = undefined;
        if (queued) this.send(queued);
      };
    }
    const message: SongRateRequest = { id: ++this.workerId, level: job.level, missions: job.missions };
    job.id = message.id;
    if (this.workerChart !== job.chart) { message.chart = job.chart; this.workerChart = job.chart; }
    if (!this.workerRules) { message.rules = { identity: this.identity!, tables: job.tables }; this.workerRules = true; }
    this.running = job;
    this.worker.postMessage(message);
  }
  private score(chart: ChartSource, missions: number[], tables: Record<string, Row[]>): Promise<GekisouRates> {
    return new Promise((resolve, reject) => {
      const job: RateJob = { chart, level: this.level, missions, tables, resolve, reject: () => reject(new Error("Cancelled calculation")) };
      if (this.running) { this.queued?.reject(); this.queued = job; }
      else this.send(job);
    });
  }
  private async calculate() {
    if (!this.chart || !this.missions || !this.identity) return;
    const generation = ++this.generation, chart = this.chart, missions = [...this.missions], key = missions.join(":");
    const cached = this.variants.get(key);
    if (cached) {
      if (this.running || this.queued) this.stopWorker();
      this.computed = cached; this.pending = false; return;
    }
    this.pending = true;
    try {
      const rules = await (this.rules ??= this.loadRules());
      if (generation !== this.generation || !this.isConnected) return;
      this.timings ??= rules.timing.gekisoTiming(chart, rules.windows);
      const rates = await this.score(chart, missions, rules.tables);
      if (generation !== this.generation || !this.isConnected) return;
      this.variants.set(key, rates); this.computed = rates;
    } catch {
      if (generation !== this.generation || !this.isConnected) return;
      this.rules = undefined; this.reset();
      snackbar(this.text("catalog.songs.analysis.failed", "Calculation failed"));
    } finally { if (generation === this.generation) this.pending = false; }
  }
  protected updated() { this.hidden = !this.source && !this.original.some(Boolean); }
  private stages() {
    const icons = (this.gekisou.icons ?? {}) as Record<string, string>;
    const segments = (this.gekisou.segments ?? []) as Row[];
    const justEndings = (this.computed ?? this.rates?.gekisou)?.justEndings;
    return html`<ol class="song-gekisou-stages">${this.selected.map((type, index) => {
      const mission = gekisouMission(type);
      if (!mission) return nothing;
      const name = this.text(`catalog.songs.gekisou.${mission.key}`, mission.fallback);
      const justEnding = justEndings?.[index];
      const timing = mission.icon === "combo"
        ? this.timings?.[index] ?? segments[index]?.timing as GekisoTimingSegment | undefined
        : mission.icon === "just" && justEnding ? { ending: justEnding } : undefined;
      return html`<li>
        ${iconButton({ icon: "swap_horiz", variant: "tonal", ...(icons[mission.icon] ? { content: gameGlyph(icons[mission.icon]!) } : {}),
          label: this.text("catalog.songs.analysis.cycleStage", "Change section {stage}: {mission}").replace("{stage}", String(index + 1)).replace("{mission}", name),
          onClick: () => this.cycle(index) })}
        <span><small><span aria-hidden="true">${index + 1}</span><span class="sr-only">${this.label("gekisouSegment", "GEKISO stage")} ${index + 1}</span></small><strong>${name}</strong>
          ${gekisoTimingView(timing, this.locale, this.label)}
        </span>
      </li>`;
    })}</ol>`;
  }
  private sections(chart: ChartSource, notes: ChartSource["notes"]) {
    if (!chart.feverMs.length) return nothing;
    const rates = this.computed ?? this.rates?.gekisou;
    return collectionTable(this.text("catalog.songs.analysis.sections", "GEKISO sections"), [
      this.text("catalog.songs.analysis.section", "Section"), this.text("catalog.songs.analysis.sectionNotes", "Notes"),
      this.text("catalog.songs.analysis.maxJust", "Max Just"), this.text("catalog.songs.analysis.startCombo", "Starting combo"),
      this.text("catalog.songs.analysis.seconds", "Length"),
    ], chart.feverMs.map(([start, end], index) => [index + 1,
      (rates?.notes[index] ?? notes.filter(note => note.timeMs >= start && note.timeMs <= end).length).toLocaleString(this.locale),
      rates ? rates.just[index]?.toLocaleString(this.locale) ?? "—" : "—",
      notes.filter(note => note.timeMs < start).length.toLocaleString(this.locale),
      `${((end - start) / 1000).toLocaleString(this.locale, { maximumFractionDigits: 1 })}s`,
    ]), { numeric: true });
  }
  render() {
    const chart = this.chart, stages = this.original.some(Boolean);
    const title = stages ? this.text("catalog.songs.stageTimeline", "GEKISO stages and skill points") : this.text("catalog.songs.skillPoints", "Skill points");
    const heading = html`<div class="row">${renderDetailSectionHeading(title, "skills")}
      ${stages ? iconButton({ icon: "restart_alt", label: this.text("common.actions.reset", "Reset"), disabled: !this.missions, onClick: () => this.reset() }) : nothing}</div>`;
    if (!chart) return html`${heading}${stages ? this.stages() : nothing}${this.source ? html`<div class="skill-timeline__plot" aria-busy="true"></div>` : nothing}`;
    const notes = chart.notes.filter(note => note.judged), times = notes.map(note => note.timeMs);
    const end = Math.max(chart.durationMs, ...times) + 1000;
    const density = new Array<number>(Math.ceil(end / 500)).fill(0);
    for (const time of times) density[Math.floor(time / 500)]!++;
    const covered = chart.skillTimesMs.map(start => times.filter(time => time >= start && time < start + SKILL_MS).length);
    const ranked = [...covered].sort((a, b) => b - a);
    const share = new Intl.NumberFormat(this.locale, { style: "percent", maximumFractionDigits: 1 });
    const rates = this.computed && this.rates ? { ...this.rates, gekisou: this.computed } : this.rates;
    return html`${heading}${stages ? this.stages() : nothing}
      ${skillTimeline({ label: title, durationMs: end, density, fever: chart.feverMs,
        feverLabel: index => `${this.label("gekisouSegment", "GEKISO stage")} ${index + 1}`,
        windows: chart.skillTimesMs.map((start, index) => ({ startMs: start, endMs: start + SKILL_MS,
          label: `${this.label("metaN", "Notes")} ${covered[index]}`,
          value: `${share.format(covered[index]! / Math.max(1, times.length))} / #${ranked.indexOf(covered[index]!) + 1}`,
        })),
      })}
      ${this.sections(chart, notes)}
      <song-chart-analysis .chart=${chart} .rates=${rates} .greatFactor=${this.greatFactor} .pending=${this.pending}
        aria-busy=${String(this.pending)} chartId=${this.chartId} server=${this.identity?.server ?? ""} locale=${this.locale}></song-chart-analysis>`;
  }
}
if (!customElements.get("song-skill-points")) customElements.define("song-skill-points", SongSkillPoints);
