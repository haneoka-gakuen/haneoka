// L3 — GEB
// Input: Frozen chart source and the selected order's cumulative counting window.
// Output: A lazily loaded flat-chart excerpt with the early-hit notes boxed and numbered.
// Pos: [Map](L2-2.md); team-builder timing details reuse the chart overview renderer.
// Effects/Dependencies: Release-pinned chart/skin downloads on expansion; abort and release on source change or disconnect.
import { LitElement, html, nothing } from "lit";
import type { ChartDocument } from "@haneoka/cassiopeia";
import type { TimingWindow } from "../../lib/team-builder/engine/api";
import type { EngineChartSources } from "../../lib/team-builder/engine/protocol";
import type { OurNotesCreationCanvasSkin } from "../../lib/chart-creation/native-canvas-skin";
import { uiText } from "../shared/catalog";
import { loadingState, errorState } from "../ui/state";
import { runtimeChart } from "../../lib/team-builder/engine/runtime-chart";

class TimingChartPreview extends LitElement {
  static properties = {
    source: { attribute: false }, window: { attribute: false }, active: { type: Boolean },
    locale: {}, label: {}, errorLabel: {}, phase: { state: true },
  };
  declare source: EngineChartSources[string];
  declare window: TimingWindow;
  declare active: boolean;
  declare locale: string;
  declare label: string;
  declare errorLabel: string;
  declare private phase: "idle" | "loading" | "ready" | "error";
  private sourceKey = "";
  private controller?: AbortController;
  private chart?: ChartDocument;
  private geometry?: ReturnType<typeof runtimeChart>["geometry"];
  private skin?: OurNotesCreationCanvasSkin;
  private renderer?: typeof import("./chart-overview-renderer");

  constructor() {
    super();
    this.active = false;
    this.locale = "en";
    this.label = "";
    this.errorLabel = "";
    this.phase = "idle";
  }
  createRenderRoot() { return this; }
  disconnectedCallback() {
    this.controller?.abort();
    this.sourceKey = "";
    this.chart = undefined;
    this.geometry = undefined;
    this.skin = undefined;
    this.phase = "idle";
    super.disconnectedCallback();
  }
  protected willUpdate() {
    const key = JSON.stringify(this.source);
    if (key !== this.sourceKey) {
      this.controller?.abort();
      this.sourceKey = key;
      this.chart = undefined;
      this.geometry = undefined;
      this.skin = undefined;
      this.phase = "idle";
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
      const [{ buildChart, parseScore }, { downloadChart }, { loadOurNotesCreationCanvasSkin }, renderer] = await Promise.all([
        import("@haneoka/cassiopeia-plugin-our-notes"), import("../../lib/team-builder/engine/charts"),
        import("../../lib/chart-creation/native-canvas-skin"), import("./chart-overview-renderer"),
      ]);
      signal.throwIfAborted();
      const [raw, skin] = await Promise.all([
        downloadChart(source, signal),
        loadOurNotesCreationCanvasSkin({ schema: "haneoka-resource-release-identity-v1",
          server: source.identity.server, releaseId: source.identity.releaseId, sourceId: source.identity.sourceId! }, { signal, locale: this.locale,
          apiBase: new URL("/api/v1/", window.location.href).href }),
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
    if (!this.active || this.phase !== "ready") return;
    const canvas = this.querySelector<HTMLCanvasElement>("canvas")!;
    this.renderer!.drawDetailedChartOverview(canvas, this.chart!, this.skin!.skin, 360, {
      startMs: Math.max(0, this.window.startMs - 750),
      endMs: Math.min(this.chart!.durationMs, this.window.endMs + 750),
      highlights: this.window.steps.map(step => ({
        ...step, targets: step.noteIndices.map(index => this.geometry![index]!),
      })),
      color: getComputedStyle(this).getPropertyValue("--md-sys-color-primary-fixed-dim").trim(),
    });
  }
  render() {
    return html`<div class="tb-timing__chart" tabindex="0" role="region" aria-label=${this.label} aria-busy=${String(this.phase === "loading")}>
      ${this.phase === "loading" ? loadingState(uiText(this.locale, "common.states.loading"), { local: true }) : nothing}
      ${this.phase === "error" ? errorState(this.errorLabel, uiText(this.locale, "common.actions.retry"), () => void this.load()) : nothing}
      <canvas ?hidden=${this.phase !== "ready"} role="img" aria-label=${this.label}></canvas>
    </div>`;
  }
}

if (!customElements.get("timing-chart-preview")) customElements.define("timing-chart-preview", TimingChartPreview);
