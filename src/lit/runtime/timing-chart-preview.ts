// L3 — GEB
// Input: Frozen chart source and the selected order's marked input window.
// Output: A lazy excerpt or one full annotated chart with viewport-sized canvas rendering.
// Pos: [Map](L2-2.md); team-builder timing details reuse the chart overview renderer.
// Effects/Dependencies: Loads the pinned chart and bundled native note atlas on expansion, without stage/HUD source discovery; abort releases the atlas.
import { LitElement, html, nothing } from "lit";
import type { ChartDocument } from "@haneoka/cassiopeia";
import type { TimingWindow } from "../../lib/team-builder/engine/api";
import type { EngineChartSources } from "../../lib/team-builder/engine/protocol";
import type { ChartCanvasSkin } from "@haneoka/cassiopeia-ui-vue/overview";
import { uiText } from "../shared/catalog";
import { loadingState, errorState } from "../ui/state";
import { runtimeChart } from "../../lib/team-builder/engine/runtime-chart";
import { icon } from "../ui/icon";

export type TimingMarkerKind = "combo" | "skill" | "both";

class TimingChartPreview extends LitElement {
  static properties = {
    source: { attribute: false }, window: { attribute: false }, active: { type: Boolean },
    locale: {}, label: {}, errorLabel: {}, phase: { state: true },
    numberNotes: { type: Boolean }, whole: { type: Boolean }, kinds: { attribute: false },
    currentNote: { state: true },
  };
  declare source: EngineChartSources[string];
  declare window: TimingWindow;
  declare active: boolean;
  declare locale: string;
  declare label: string;
  declare errorLabel: string;
  declare numberNotes: boolean;
  declare whole: boolean;
  declare kinds: ReadonlyMap<number, TimingMarkerKind>;
  declare private currentNote: number;
  declare private phase: "idle" | "loading" | "ready" | "error";
  private sourceKey = "";
  private controller?: AbortController;
  private chart?: ChartDocument;
  private geometry?: ReturnType<typeof runtimeChart>["geometry"];
  private skin?: ChartCanvasSkin;
  private renderer?: typeof import("./chart-overview-renderer");
  private observer?: ResizeObserver;
  private drawFrame = 0;
  private marksKey = "";
  private needsFocus = true;

  constructor() {
    super();
    this.active = false;
    this.locale = "en";
    this.label = "";
    this.errorLabel = "";
    this.phase = "idle";
    this.numberNotes = false;
    this.whole = false;
    this.kinds = new Map();
    this.currentNote = 0;
  }
  createRenderRoot() { return this; }
  disconnectedCallback() {
    this.controller?.abort();
    this.observer?.disconnect();
    this.observer = undefined;
    cancelAnimationFrame(this.drawFrame);
    this.drawFrame = 0;
    this.sourceKey = "";
    this.chart = undefined;
    this.geometry = undefined;
    this.skin = undefined;
    this.phase = "idle";
    this.marksKey = "";
    super.disconnectedCallback();
  }
  protected willUpdate() {
    const marksKey = JSON.stringify(this.window.steps.map(step => [step.step, step.timeMs, step.noteIndices]));
    if (marksKey !== this.marksKey) {
      this.marksKey = marksKey;
      this.currentNote = 0;
      this.needsFocus = true;
    }
    const key = JSON.stringify(this.source);
    if (key !== this.sourceKey) {
      this.controller?.abort();
      this.sourceKey = key;
      this.chart = undefined;
      this.geometry = undefined;
      this.skin = undefined;
      this.phase = "idle";
      this.needsFocus = true;
    }
    if (this.active && this.phase === "idle") void this.load();
  }
  private async load() {
    this.controller?.abort();
    const controller = this.controller = new AbortController();
    const { signal } = controller;
    const source = this.source;
    this.phase = "loading";
    try {
      const [{ buildChart, parseScore }, { downloadChart }, { ChartCanvasSkin }, renderer] = await Promise.all([
        import("@haneoka/cassiopeia-plugin-our-notes"), import("../../lib/team-builder/engine/charts"),
        import("@haneoka/cassiopeia-ui-vue/overview"), import("./chart-overview-renderer"),
      ]);
      signal.throwIfAborted();
      const skinTask = ChartCanvasSkin.loadBundled();
      signal.addEventListener("abort", () => { void skinTask.then(skin => skin.dispose(), () => {}); }, { once: true });
      const [raw, skin] = await Promise.all([
        downloadChart(source, signal),
        skinTask,
        renderer.loadChartCanvasFonts(this.locale),
      ]);
      signal.throwIfAborted();
      const score = parseScore(raw);
      this.chart = buildChart(score);
      this.geometry = runtimeChart(raw, true).geometry;
      this.skin = skin;
      this.renderer = renderer;
      this.phase = "ready";
    } catch (error) {
      if (signal.aborted) return;
      controller.abort();
      this.phase = "error";
      console.warn("Unable to load timing chart", error);
    }
  }
  protected updated() {
    if (!this.observer) {
      this.observer = new ResizeObserver(() => this.queueDraw());
      this.observer.observe(this.querySelector(".tb-timing__chart")!);
    }
    this.queueDraw();
  }
  focusNote(number: number) {
    this.currentNote = number - 1;
    this.needsFocus = true;
    this.requestUpdate();
  }
  private queueDraw() {
    if (!this.drawFrame) this.drawFrame = requestAnimationFrame(() => { this.drawFrame = 0; this.draw(); });
  }
  private draw() {
    if (!this.active || this.phase !== "ready") return;
    const region = this.querySelector<HTMLElement>(".tb-timing__chart")!;
    if (!region.clientWidth) return;
    const canvas = this.querySelector<HTMLCanvasElement>("canvas")!;
    const zoom = this.numberNotes ? 1.6 : 1;
    const startMs = this.whole ? 0 : Math.max(0, this.window.startMs - 750);
    const endMs = this.whole ? this.chart!.durationMs : Math.min(this.chart!.durationMs, this.window.endMs + 750);
    const layout = this.renderer!.chartOverviewLayout(endMs - startMs, 360, zoom);
    if (this.whole && this.needsFocus && this.window.steps.length) {
      if (region.scrollWidth + 1 < layout.width) { this.queueDraw(); return; }
      const step = this.window.steps[this.currentNote]!;
      const column = Math.floor(step.timeMs / layout.panelDuration);
      const left = Math.max(0, Math.min(region.scrollWidth - region.clientWidth,
        column * layout.panelWidth - (region.clientWidth - layout.panelWidth) / 2));
      region.scrollLeft = left;
      if (Math.abs(region.scrollLeft - left) > 1) { this.queueDraw(); return; }
      this.needsFocus = false;
    }
    const first = this.whole ? Math.max(0, Math.floor(region.scrollLeft / layout.panelWidth) - 1) : 0;
    const count = this.whole ? Math.min(layout.panelCount - first, Math.ceil(region.clientWidth / layout.panelWidth) + 2) : layout.panelCount;
    canvas.style.position = this.whole ? "absolute" : "static";
    canvas.style.insetInlineStart = this.whole ? `${first * layout.panelWidth}px` : "";
    canvas.style.marginInline = this.whole ? "0" : "auto";
    const styles = getComputedStyle(this);
    const colors = {
      combo: styles.getPropertyValue("--md-sys-color-primary-fixed-dim").trim(),
      skill: styles.getPropertyValue("--md-sys-color-tertiary-fixed-dim").trim(),
      both: styles.getPropertyValue("--md-sys-color-secondary-fixed-dim").trim(),
    };
    this.renderer!.drawDetailedChartOverview(canvas, this.chart!, this.skin!, 360, {
      startMs, endMs,
      highlights: this.window.steps.map(step => ({
        ...step, targets: step.noteIndices.map(index => this.geometry![index]!),
        color: colors[this.kinds.get(step.step) ?? "combo"],
        selected: this.whole && step.step === this.window.steps[this.currentNote]?.step,
      })),
      color: colors.combo,
      labelEachTarget: this.numberNotes,
      zoom,
    }, { first, count });
  }
  render() {
    const step = this.window.steps[this.currentNote];
    const layout = this.whole && this.chart && this.renderer ? this.renderer.chartOverviewLayout(this.chart.durationMs, 360, 1.6) : undefined;
    return html`${this.whole && step ? html`<div class="row row--between">
      <button class="button button--text button--icon" type="button" ?disabled=${this.currentNote === 0}
        aria-label=${uiText(this.locale, "tools.teamBuilder.timingPreviousNote")} @click=${() => this.focusNote(step.step - 1)}>${icon("arrow_back")}</button>
      <span class="tabular">${uiText(this.locale, "tools.teamBuilder.timingNoteNumber").replace("{number}", String(step.step))} / ${this.window.steps.length}</span>
      <button class="button button--text button--icon" type="button" ?disabled=${this.currentNote === this.window.steps.length - 1}
        aria-label=${uiText(this.locale, "tools.teamBuilder.timingNextNote")} @click=${() => this.focusNote(step.step + 1)}>${icon("arrow_forward")}</button>
    </div>` : nothing}
    <div class="tb-timing__chart" tabindex="0" role="region" aria-label=${this.label} aria-busy=${String(this.phase === "loading")}
      @scroll=${() => this.queueDraw()}>
      ${this.phase === "loading" ? loadingState(uiText(this.locale, "common.states.loading"), { local: true }) : nothing}
      ${this.phase === "error" ? errorState(this.errorLabel, uiText(this.locale, "common.actions.retry"), () => void this.load()) : nothing}
      <div class="tb-timing__chart-strip" style=${layout ? `inline-size:${layout.width}px;block-size:${layout.height}px` : ""}>
        <canvas ?hidden=${this.phase !== "ready"} role="img" aria-label=${this.label}></canvas>
      </div>
    </div>`;
  }
}

if (!customElements.get("timing-chart-preview")) customElements.define("timing-chart-preview", TimingChartPreview);
