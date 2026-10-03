import { LitElement, html, nothing } from "lit";
import { live } from "lit/directives/live.js";
import "@material/web/textfield/outlined-text-field.js";
import "@material/web/select/outlined-select.js";
import "@material/web/select/select-option.js";
import "@material/web/checkbox/checkbox.js";
import "@material/web/slider/slider.js";
import { ProjectHistory } from "../../packages/chart-editor/src/history";
import {
  createEmptyProject,
  createProjectId,
  resolveLinePointShape,
  type Project,
  type SingleNote,
  type LinePoint,
} from "../../packages/chart-editor/src/model";
import { TempoMap, snapTick, timeToViewportY } from "../../packages/chart-editor/src/index";
import { importChart } from "../../packages/chart-editor/src/formats/detect";
import { assertValidProject } from "../../packages/chart-editor/src/validation";
import { CreationStore, type CreationDocument, type CreationRevision } from "../lib/chart-creation/storage";
import { createExampleAudio, decodeCreationAudio, type CreationAudio } from "../lib/chart-creation/audio";
import { CreationPreview, creationChartDocument, type PreviewColors } from "../lib/chart-creation/preview";
import { clientText, initializeI18nClient } from "../i18n/client";
import { beginLoading } from "../lib/loading-progress";
import { downloadBlob } from "../lib/canvas-capture";
import { iconButton, segmented } from "./ui/controls";
import { accordion } from "./ui/accordion";
import {
  copyChartSelection,
  deleteChartSelection,
  pasteChartSelection,
  type ChartSelection,
} from "../../packages/chart-editor/src/creation/editing";
import {
  panVerticalTimeViewport,
  scrollVerticalTimeViewport,
  zoomVerticalTimeViewportAtY,
} from "../../packages/chart-editor/src/viewport";
import { serializeProjectJson } from "../../packages/chart-editor/src/formats/project-json";
import { serializeSs } from "../../packages/chart-editor/src/formats/ss";
import { serializeUsc } from "../../packages/chart-editor/src/formats/usc";
import { getExportDiagnostics, type ExportFormat } from "../../packages/chart-editor/src/formats/diagnostics";

// Authored source stays in Project. This workspace's playback is a presentation preview.
export class ChartCreationWorkspace extends LitElement {
  static properties = {
    locale: {},
    busy: { state: true },
    dirty: { state: true },
    error: { state: true },
    status: { state: true },
    tool: { state: true },
    selected: { state: true },
    documents: { state: true },
    revisions: { state: true },
    windowStart: { state: true },
  };
  declare locale: string;
  private history = new ProjectHistory(createEmptyProject());
  private original = createEmptyProject();
  private source?: CreationDocument["source"];
  private projectId: string = crypto.randomUUID();
  private head = 0;
  private conflict = false;
  private activeRevision = 0;
  private projectExpanded = false;
  private toolExpanded = false;
  private store = new CreationStore();
  private audio?: CreationAudio;
  private preview?: CreationPreview;
  private controller?: AbortController;
  private observer?: ResizeObserver;
  private unlocale?: () => void;
  declare private busy: boolean;
  declare private dirty: boolean;
  declare private error: string;
  declare private status: string;
  declare private tool: string;
  declare private selected: string;
  declare private documents: CreationDocument[];
  declare private revisions: CreationRevision[];
  declare private windowStart: number;
  private pending?: { tick: number; lane: number };
  private seconds = 0;
  private critical = false;
  private snap = 4;
  private secondsPerScreen = 4;
  private rate = 1;
  private exportFormat: ExportFormat = "project";
  private clipboard?: ChartSelection;
  private pan?: { pointer: number; y: number; start: number };
  private direction: "left" | "up" | "right" = "up";
  private insertLane = 0;
  constructor() {
    super();
    this.locale = "en";
    this.busy = false;
    this.dirty = false;
    this.error = "";
    this.status = "";
    this.tool = "tap";
    this.selected = "";
    this.documents = [];
    this.revisions = [];
    this.windowStart = 0;
  }
  createRenderRoot() {
    return this;
  }
  private t(key: string) {
    return clientText(this.locale, `chartEditorPage.${key}`);
  }
  private c(key: string) {
    return clientText(this.locale, key);
  }
  private get chart() {
    return this.history.value;
  }
  connectedCallback() {
    super.connectedCallback();
    this.addEventListener("keydown", this.keydown);
    window.addEventListener("beforeunload", this.beforeUnload);
    this.unlocale = initializeI18nClient().subscribe((catalog) => {
      this.locale = catalog.locale;
      this.requestUpdate();
    });
    void this.updateComplete.then(() => {
      if (!this.isConnected) return;
      this.observer ??= new ResizeObserver(() => this.paint());
      this.observer.observe(this.querySelector(".chart-creation__editor")!);
      this.rebuildPreview();
      this.paint();
    });
    void this.run(async () => {
      this.documents = await this.store.list();
    });
  }
  disconnectedCallback() {
    this.removeEventListener("keydown", this.keydown);
    window.removeEventListener("beforeunload", this.beforeUnload);
    this.pan = undefined;
    this.controller?.abort();
    this.preview?.dispose();
    this.preview = undefined;
    this.observer?.disconnect();
    this.unlocale?.();
    void this.store.close().catch(() => {});
    super.disconnectedCallback();
  }
  protected updated() {
    this.paint();
    // Material resolves value synchronously; newly rendered options must settle first.
    for (const [selector, value] of [
      ["[data-window]", String(this.secondsPerScreen)],
      ["[data-version]", String(this.activeRevision)],
    ]) {
      const control = this.querySelector<HTMLElementTagNameMap["md-outlined-select"]>(selector);
      if (!control) continue;
      void control.updateComplete.then(() => {
        const current = selector === "[data-window]" ? String(this.secondsPerScreen) : String(this.activeRevision);
        if (this.isConnected && current === value && control.value !== value) control.select(value);
      });
    }
  }
  private async run(action: (signal: AbortSignal) => Promise<void>) {
    if (this.busy) return;
    this.busy = true;
    this.error = "";
    const controller = (this.controller = new AbortController());
    const report = beginLoading(this.c("loading"), { signal: controller.signal, scope: "owner" });
    try {
      await action(controller.signal);
      controller.signal.throwIfAborted();
      report.finish();
    } catch (error) {
      if (!controller.signal.aborted) {
        this.conflict = error instanceof Error && error.message === "save_conflict";
        this.error = clientText(
          this.locale,
          `chartEditorPage.creation.${error instanceof Error ? error.message : "failed"}`,
          this.t("loadFailed"),
        );
        report.fail(error);
      }
    } finally {
      if (this.controller === controller) {
        this.controller = undefined;
        this.busy = false;
      }
    }
  }
  private async save() {
    if (!this.audio || !this.dirty) return;
    const document = await this.store.save(
      this.projectId,
      this.head,
      this.chart,
      this.audio,
      this.original,
      this.source,
    );
    this.conflict = false;
    this.head = document.head;
    this.activeRevision = document.head;
    this.dirty = false;
    this.status = this.t("creation.saved");
    this.documents = await this.store.list();
    this.revisions = await this.store.versions(this.projectId);
  }
  private edit(updater: (draft: Project) => void) {
    if (this.busy) return;
    try {
      const draft = this.chart;
      updater(draft);
      assertValidProject(draft);
      const revision = this.history.revision;
      this.history.replace(draft);
      if (revision === this.history.revision) return;
      this.dirty = true;
      this.status = "";
      this.error = "";
      this.rebuildPreview();
      this.requestUpdate();
    } catch {
      this.error = this.t("creation.invalid_edit");
    }
  }
  private rebuildPreview(position = this.seconds) {
    this.preview?.dispose();
    this.preview = undefined;
    if (!this.audio || !this.isConnected) return;
    const style = getComputedStyle(this),
      color = (name: string) => style.getPropertyValue(`--md-sys-color-${name}`).trim();
    const colors: PreviewColors = {
      surface: color("surface-container"),
      primary: color("primary"),
      secondary: color("secondary"),
      outline: color("outline-variant"),
      critical: color("tertiary"),
    };
    this.preview = new CreationPreview(
      this.querySelector(".chart-creation__preview")!,
      creationChartDocument(this.chart, this.audio.analysis.duration),
      this.audio.file,
      colors,
      (seconds, playing) => {
        this.seconds = seconds;
        const output = this.querySelector("[data-time]");
        if (output) output.textContent = seconds.toFixed(2);
        const button = this.querySelector<HTMLButtonElement>("[data-play]");
        if (button) {
          button.textContent = this.c(playing ? "pause" : "play");
          button.setAttribute("aria-pressed", String(playing));
        }
      },
      () => {
        this.error = this.t("audioFailed");
      },
    );
    this.preview.clock.rate = this.rate;
    this.preview.seek(Math.max(0, position));
  }
  private loadAudio(file: File, example = false) {
    void this.run(async (signal) => {
      const audio = await decodeCreationAudio(file, signal);
      await this.save();
      this.preview?.dispose();
      this.audio = audio;
      if (example) {
        this.projectId = crypto.randomUUID();
        this.head = 0;
        this.activeRevision = 0;
        this.source = undefined;
        const chart = createEmptyProject({ title: file.name, source: "authored" });
        chart.singles = Array.from({ length: 15 }, (_, i) => ({
          id: createProjectId("note"),
          tick: (i + 1) * 480,
          lane: (i % 6) * 4,
          size: 4,
          type: "tap",
          critical: false,
          direction: "none",
          visible: true,
        }));
        this.history.reset(chart);
        this.original = structuredClone(chart);
        this.revisions = [];
      }
      this.dirty = true;
      this.windowStart = 0;
      this.rebuildPreview(0);
    });
  }
  private async open(id: string, revision?: number) {
    await this.save();
    const opened = await this.store.open(id, revision),
      signal = this.controller!.signal;
    const audio = await decodeCreationAudio(opened.file, signal);
    if (audio.sha256 !== opened.value.audio.sha256) throw new Error("audio_hash");
    signal.throwIfAborted();
    this.preview?.dispose();
    this.projectId = id;
    this.head = opened.document.head;
    this.activeRevision = opened.value.revision;
    this.original = opened.document.original;
    this.source = opened.document.source;
    this.history.reset(opened.value.chart);
    this.audio = audio;
    this.selected = "";
    this.pending = undefined;
    // An earlier version becomes a new branch of edits on the same monotonic local history.
    this.dirty = opened.value.revision !== opened.document.head;
    this.windowStart = 0;
    this.revisions = await this.store.versions(id);
    this.rebuildPreview(0);
    this.status = this.t("restored");
  }
  private pick(selector: string) {
    (this.querySelector(selector) as HTMLInputElement).click();
  }
  private importFile(event: Event, backup = false) {
    const input = event.target as HTMLInputElement,
      file = input.files?.[0];
    input.value = "";
    if (!file) return;
    void this.run(async (signal) => {
      await this.save();
      if (backup) {
        const id = await this.store.import(file);
        await this.open(id);
        this.documents = await this.store.list();
        return;
      }
      if (file.size > 2 * 1024 * 1024) throw new Error("chart_size");
      const text = await file.text(),
        imported = importChart(text);
      signal.throwIfAborted();
      this.history.reset(imported.project);
      this.original = structuredClone(imported.project);
      this.source = { name: file.name, text };
      this.projectId = crypto.randomUUID();
      this.head = 0;
      this.activeRevision = 0;
      this.revisions = [];
      this.selected = "";
      this.pending = undefined;
      this.dirty = true;
      this.rebuildPreview();
      this.status = imported.warnings.length ? this.t("warnings") : this.t("ready");
    });
  }
  private map() {
    const p = this.chart;
    return new TempoMap(p.tempos, { resolution: p.resolution, audioOffset: p.audioOffset });
  }
  private beforeUnload = (event: BeforeUnloadEvent) => {
    if (this.dirty) {
      event.preventDefault();
      event.returnValue = "";
    }
  };
  private keydown = (event: KeyboardEvent) => {
    if (this.busy || event.defaultPrevented || event.isComposing || event.repeat) return;
    if (
      event
        .composedPath()
        .some(
          (node) =>
            node instanceof HTMLElement &&
            (node.matches(
              "button,a[href],input,textarea,select,[role=button],[role=radio],[role=checkbox],[role=combobox],[role=slider],[role=switch],[role=option],[role=textbox]",
            ) ||
              node.localName.startsWith("md-") ||
              node.isContentEditable),
        )
    )
      return;
    let used = true;
    const modifier = event.ctrlKey || event.metaKey;
    if (modifier && event.key.toLowerCase() === "s") void this.run(() => this.save());
    else if (modifier && (event.key.toLowerCase() === "z" || event.key.toLowerCase() === "y")) {
      if (event.shiftKey || event.key.toLowerCase() === "y") this.history.redo();
      else this.history.undo();
      this.dirty = true;
      this.rebuildPreview();
      this.requestUpdate();
    } else if (modifier && event.key.toLowerCase() === "c") {
      this.clipboard = copyChartSelection(this.chart, this.selected);
      this.requestUpdate();
    } else if (modifier && event.key.toLowerCase() === "v" && this.clipboard)
      this.edit((p) => {
        this.selected = pasteChartSelection(
          p,
          this.clipboard!,
          Math.max(0, snapTick(this.map().secondsToTick(this.seconds), this.snap)),
        );
      });
    else if (event.key === "Delete" || event.key === "Backspace")
      this.edit((p) => deleteChartSelection(p, this.selected));
    else if (event.key === " ") this.togglePlayback();
    else if (event.key === "Escape") {
      this.pending = undefined;
      this.selected = "";
      this.requestUpdate();
    } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      this.windowStart = this.clampStart(this.windowStart + (event.key === "ArrowUp" ? 1 : -1) * 0.25);
      this.requestUpdate();
    } else if (/^[1-7]$/.test(event.key) && !modifier) {
      this.tool = ["select", "tap", "flick", "trace", "hold", "guide", "erase"][Number(event.key) - 1];
      this.pending = undefined;
    } else used = false;
    if (used) event.preventDefault();
  };
  private togglePlayback() {
    if (this.preview?.clock.playing) this.preview.pause();
    else
      void this.preview?.play().catch(() => {
        this.error = this.t("audioFailed");
      });
  }
  private clampStart(value: number) {
    return Math.max(0, Math.min(Math.max(0, (this.audio?.analysis.duration ?? 0) - this.secondsPerScreen), value));
  }
  private wheel(event: WheelEvent) {
    if (this.busy || !this.audio) return;
    event.preventDefault();
    const canvas = event.currentTarget as HTMLCanvasElement;
    const viewport = {
      startSeconds: this.windowStart,
      pixelsPerSecond: canvas.clientHeight / this.secondsPerScreen,
      height: canvas.clientHeight,
    };
    if (event.ctrlKey || event.metaKey) {
      const scale = Math.max(
        canvas.clientHeight / 16,
        Math.min(canvas.clientHeight / 0.5, viewport.pixelsPerSecond * Math.exp(-event.deltaY * 0.002)),
      );
      const next = zoomVerticalTimeViewportAtY(viewport, scale, event.clientY - canvas.getBoundingClientRect().top);
      this.secondsPerScreen = canvas.clientHeight / scale;
      this.windowStart = this.clampStart(next.startSeconds);
    } else this.windowStart = this.clampStart(scrollVerticalTimeViewport(viewport, event.deltaY).startSeconds);
    this.requestUpdate();
  }
  private panMove(event: PointerEvent) {
    if (this.pan?.pointer !== event.pointerId) return;
    const canvas = event.currentTarget as HTMLCanvasElement;
    this.windowStart = this.clampStart(
      panVerticalTimeViewport(
        {
          startSeconds: this.pan.start,
          pixelsPerSecond: canvas.clientHeight / this.secondsPerScreen,
          height: canvas.clientHeight,
        },
        event.clientY - this.pan.y,
      ).startSeconds,
    );
  }
  private panEnd(event: PointerEvent) {
    if (this.pan?.pointer !== event.pointerId) return;
    this.pan = undefined;
    const canvas = event.currentTarget as HTMLCanvasElement;
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
  }
  private hit(event: PointerEvent) {
    if (this.busy || !this.audio) return;
    const canvas = event.currentTarget as HTMLCanvasElement;
    canvas.focus();
    if (this.tool === "pan") {
      this.pan = { pointer: event.pointerId, y: event.clientY, start: this.windowStart };
      canvas.setPointerCapture(event.pointerId);
      return;
    }
    const rect = canvas.getBoundingClientRect(),
      chart = this.chart,
      map = this.map();
    const seconds = this.windowStart + (1 - (event.clientY - rect.top) / rect.height) * this.secondsPerScreen;
    const tick = Math.max(0, snapTick(this.map().secondsToTick(seconds), this.snap)),
      lane = Math.min(
        chart.laneBasis - chart.laneBasis / 6,
        Math.max(0, (Math.floor(((event.clientX - rect.left) / rect.width) * 6) * chart.laneBasis) / 6),
      );
    const nearby = [
      ...chart.singles.map((note) => ({ note, lane: note.lane, size: note.size })),
      ...chart.lines.flatMap((line) =>
        line.points.map((note, index) => ({ note, ...resolveLinePointShape(line.points, index) })),
      ),
    ].find(
      (item) =>
        Math.abs(map.tickToSeconds(item.note.tick) - seconds) < 0.12 &&
        lane >= item.lane &&
        lane < item.lane + Math.max(item.size, 1),
    )?.note;
    if (this.tool === "select") {
      this.selected = nearby?.id ?? "";
      return;
    }
    if (this.tool === "erase") {
      if (nearby)
        this.edit((p) => {
          p.singles = p.singles.filter((n) => n.id !== nearby.id);
          p.lines = p.lines.filter((l) => !l.points.some((n) => n.id === nearby.id));
        });
      return;
    }
    this.place(tick, lane);
  }
  private place(tick: number, lane: number) {
    const chart = this.chart;
    const base = (at: number, position: number): SingleNote => ({
      id: createProjectId("note"),
      tick: at,
      lane: position,
      size: chart.laneBasis / 6,
      type: this.tool === "flick" ? "flick" : this.tool === "trace" ? "trace" : "tap",
      direction: this.tool === "flick" ? this.direction : "none",
      critical: this.critical,
      visible: true,
    });
    if (this.tool === "hold" || this.tool === "guide") {
      if (!this.pending) {
        this.pending = { tick, lane };
        this.requestUpdate();
        return;
      }
      const start = this.pending;
      if (tick <= start.tick) {
        this.error = this.t("creation.line_order");
        return;
      }
      this.pending = undefined;
      this.edit((p) =>
        p.lines.push({
          id: createProjectId("line"),
          kind: this.tool === "guide" ? "guide" : "long",
          critical: this.critical,
          points: [base(start.tick, start.lane), base(tick, lane)].map((n) => ({
            ...n,
            ease: { left: "linear", right: "linear" },
          })),
        }),
      );
    } else this.edit((p) => p.singles.push(base(tick, lane)));
  }
  private paint() {
    const canvas = this.querySelector<HTMLCanvasElement>(".chart-creation__editor");
    if (!canvas) return;
    const width = canvas.clientWidth,
      height = canvas.clientHeight,
      ratio = Math.min(devicePixelRatio || 1, 2);
    if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
    }
    const ctx = canvas.getContext("2d");
    if (!ctx || !width || !height) return;
    const style = getComputedStyle(this),
      color = (name: string) => style.getPropertyValue(`--md-sys-color-${name}`).trim();
    const chart = this.chart,
      map = this.map(),
      y = (tick: number) =>
        timeToViewportY(map.tickToSeconds(tick), {
          startSeconds: this.windowStart,
          pixelsPerSecond: height / this.secondsPerScreen,
          height,
        });
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.fillStyle = color("surface-container");
    ctx.fillRect(0, 0, width, height);
    ctx.strokeStyle = color("outline-variant");
    ctx.lineWidth = 1;
    for (let i = 0; i <= 6; i++) {
      ctx.beginPath();
      ctx.moveTo((i * width) / 6, 0);
      ctx.lineTo((i * width) / 6, height);
      ctx.stroke();
    }
    const first = Math.max(0, Math.floor(map.secondsToBeat(this.windowStart)));
    const last = map.secondsToBeat(this.windowStart + this.secondsPerScreen);
    const divisions = Number.isFinite(last) ? Math.min(256, Math.ceil((last - first) * this.snap)) : 0;
    for (let i = 0; i <= divisions && divisions > 0; i++) {
      const beat = first + i * Math.max(1 / this.snap, (last - first) / 256);
      const at = y(beat * chart.resolution);
      ctx.globalAlpha = beat % 1 ? 0.3 : 1;
      ctx.beginPath();
      ctx.moveTo(0, at);
      ctx.lineTo(width, at);
      ctx.stroke();
    }
    ctx.globalAlpha = 0.3;
    ctx.fillStyle = color("secondary");
    if (this.audio) {
      const wave = this.audio.analysis.waveform;
      for (let row = 0; row < height; row++) {
        const at = Math.floor(
          ((this.windowStart + (1 - row / height) * this.secondsPerScreen) / wave.duration) * wave.length,
        );
        if (at < 0 || at >= wave.length) continue;
        ctx.fillRect(0, row, (Math.max(0, wave.max[at] - wave.min[at]) * width) / 12, 1);
      }
    }
    ctx.globalAlpha = 1;
    const note = (n: SingleNote | LinePoint, lane: number, size: number) => {
      const at = y(n.tick);
      if (at < -12 || at > height + 12) return;
      ctx.fillStyle = n.id === this.selected ? color("tertiary") : n.critical ? color("tertiary") : color("primary");
      ctx.fillRect(
        (lane / chart.laneBasis) * width,
        at - 5,
        Math.max(2, (size / chart.laneBasis) * width),
        n.visible ? 10 : 3,
      );
      ctx.fillStyle = color("on-primary");
      ctx.font = "12px sans-serif";
      ctx.fillText(
        n.type === "flick"
          ? n.direction === "left"
            ? "←"
            : n.direction === "right"
              ? "→"
              : "↑"
          : n.type === "trace"
            ? "·"
            : "",
        ((lane + size / 2) / chart.laneBasis) * width,
        at + 4,
      );
    };
    for (const line of chart.lines) {
      ctx.strokeStyle = color("secondary");
      ctx.lineWidth = 6;
      ctx.beginPath();
      line.points.forEach((n, i) => {
        const shape = resolveLinePointShape(line.points, i),
          x = ((shape.lane + shape.size / 2) / chart.laneBasis) * width;
        if (!i) ctx.moveTo(x, y(n.tick));
        else ctx.lineTo(x, y(n.tick));
      });
      ctx.stroke();
      line.points.forEach((n, i) => {
        const shape = resolveLinePointShape(line.points, i);
        note(n, shape.lane, shape.size);
      });
    }
    for (const n of chart.singles) note(n, n.lane, n.size);
    if (this.pending) {
      ctx.strokeStyle = color("tertiary");
      ctx.lineWidth = 3;
      ctx.strokeRect((this.pending.lane / chart.laneBasis) * width, y(this.pending.tick) - 5, width / 6, 10);
    }
  }
  private field(key: string, value: string | number, changed: (value: string) => void, numeric = false) {
    return html`
      <md-outlined-text-field
        label=${this.t(key)}
        .value=${live(String(value))}
        type=${numeric ? "number" : "text"}
        ?disabled=${this.busy || !this.audio}
        @change=${(e: Event) => changed((e.target as HTMLInputElement).value)}
      ></md-outlined-text-field>
    `;
  }
  render() {
    const chart = this.chart,
      selection = [...chart.singles, ...chart.lines.flatMap((l) => l.points)].find((n) => n.id === this.selected);
    const selectedUpdate = (updater: (note: SingleNote | LinePoint) => void) =>
      this.edit((p) => {
        const note = [...p.singles, ...p.lines.flatMap((l) => l.points)].find((n) => n.id === this.selected);
        if (note) updater(note);
      });
    return html`
      <input
        hidden
        data-audio
        type="file"
        accept="audio/*"
        @change=${(e: Event) => {
          const input = e.target as HTMLInputElement,
            file = input.files?.[0];
          input.value = "";
          if (file) this.loadAudio(file);
        }}
      />
      <input hidden data-chart type="file" accept=".json,.sus,.ss,.usc" @change=${(e: Event) => this.importFile(e)} />
      <input hidden data-backup type="file" accept=".zip" @change=${(e: Event) => this.importFile(e, true)} />
      ${
        this.conflict
          ? html`
              <button
                class="button button--tonal"
                ?disabled=${this.busy}
                @click=${() =>
                  void this.run(async () => {
                    this.projectId = crypto.randomUUID();
                    this.head = 0;
                    this.activeRevision = 0;
                    await this.save();
                  })}
              >
                ${this.t("creation.save_copy")}
              </button>
            `
          : nothing
      }
      <div class="chart-creation__actions">
        <button class="button button--filled" ?disabled=${this.busy} @click=${() => this.pick("[data-audio]")}>
          ${this.t("importLocalAudio")}
        </button>
        <button
          class="button button--tonal"
          ?disabled=${this.busy}
          @click=${() => this.loadAudio(createExampleAudio(), true)}
        >
          ${this.t("creation.example")}
        </button>
        <button class="button" ?disabled=${this.busy || !this.audio} @click=${() => this.pick("[data-chart]")}>
          ${this.t("importLocalChart")}
        </button>
        <button
          class="button"
          ?disabled=${this.busy || !this.audio || !this.dirty}
          @click=${() => void this.run(() => this.save())}
        >
          ${this.t("creation.save")}
        </button>
        <button
          class="button"
          ?disabled=${this.busy || !this.audio}
          @click=${() =>
            void this.run(async () => {
              await this.save();
              downloadBlob(await this.store.export(this.projectId), "chart-project.zip");
            })}
        >
          ${this.c("export")}
        </button>
        <button class="button" ?disabled=${this.busy} @click=${() => this.pick("[data-backup]")}>
          ${this.t("creation.open_backup")}
        </button>
      </div>
      ${
        this.error
          ? html`
              <p role="alert">${this.error}</p>
            `
          : nothing
      }
      ${
        this.status
          ? html`
              <p role="status">${this.status}</p>
            `
          : nothing
      }
      ${
        this.audio
          ? html`
              <div class="chart-creation__audio">
                <span>${this.audio.file.name} · ${this.audio.analysis.duration.toFixed(2)} s</span>
                ${this.audio.analysis.candidates.map(
                  (candidate) => html`
                    <button
                      class="chip"
                      ?disabled=${this.busy}
                      @click=${() =>
                        this.edit((p) => {
                          p.tempos[0].bpm = candidate.bpm;
                        })}
                    >
                      ${this.t("creation.candidate")} ${candidate.bpm}
                    </button>
                  `,
                )}
              </div>
            `
          : nothing
      }

      <div class="chart-creation__actions">
        ${segmented({
          label: this.t("currentTool"),
          value: this.tool,
          options: ["select", "tap", "flick", "trace", "hold", "guide", "erase", "pan"].map((value) => ({
            value,
            label: this.t(value),
          })),
          onSelect: (value) => {
            if (!this.busy) {
              this.tool = value;
              this.pending = undefined;
            }
          },
        })}
        ${iconButton({
          label: this.t("undo"),
          icon: "undo",
          disabled: this.busy || !this.history.canUndo,
          onClick: () => {
            this.history.undo();
            this.dirty = true;
            this.rebuildPreview();
            this.requestUpdate();
          },
        })}
        ${iconButton({
          label: this.t("redo"),
          icon: "redo",
          disabled: this.busy || !this.history.canRedo,
          onClick: () => {
            this.history.redo();
            this.dirty = true;
            this.rebuildPreview();
            this.requestUpdate();
          },
        })}
      </div>
      <button
        class="button"
        ?disabled=${this.busy || !this.clipboard || !this.audio}
        @click=${() =>
          this.edit((p) => {
            this.selected = pasteChartSelection(
              p,
              this.clipboard!,
              Math.max(0, snapTick(this.map().secondsToTick(this.seconds), this.snap)),
            );
          })}
      >
        ${this.t("creation.paste")}
      </button>
      <div class="chart-creation__stages">
        <section aria-label=${this.t("edit")}>
          <canvas
            class="chart-creation__editor"
            role="img"
            aria-label=${this.t("edit")}
            tabindex="0"
            style=${this.tool === "pan" ? "touch-action:none" : "touch-action:manipulation"}
            @pointerdown=${this.hit}
            @pointermove=${this.panMove}
            @pointerup=${this.panEnd}
            @pointercancel=${this.panEnd}
            @lostpointercapture=${this.panEnd}
            @wheel=${this.wheel}
          ></canvas>
          <md-slider
            aria-label=${this.t("creation.position")}
            min="0"
            max=${Math.max(0, (this.audio?.analysis.duration ?? 4) - this.secondsPerScreen)}
            step="0.1"
            .value=${this.windowStart}
            ?disabled=${this.busy}
            @input=${(e: Event) => {
              this.windowStart = Number((e.target as HTMLInputElement).value);
            }}
          ></md-slider>
          <div class="chart-creation__actions">
            <button
              class="button"
              ?disabled=${this.busy || !this.audio}
              @click=${() => {
                this.windowStart = Math.max(0, this.seconds - 1);
              }}
            >
              ${this.t("creation.follow")}
            </button>
            ${this.field(
              "beat",
              Math.round(this.map().secondsToBeat(this.seconds) * 100) / 100,
              (value) => {
                if (Number.isFinite(Number(value)))
                  this.preview?.seek(Math.max(0, this.map().beatToSeconds(Number(value))));
              },
              true,
            )}
          </div>
        </section>
        <section aria-label=${this.t("preview")}>
          <canvas class="chart-creation__preview" role="img" aria-label=${this.t("preview")}></canvas>
          <div class="chart-creation__actions">
            <button
              class="button button--tonal"
              data-play
              ?disabled=${this.busy || !this.audio}
              @click=${() => {
                if (this.preview?.clock.playing) this.preview.pause();
                else
                  void this.preview?.play().catch(() => {
                    this.error = this.t("audioFailed");
                  });
              }}
            >
              ${this.c("play")}
            </button>
            <output data-time>0.00</output>
            <span>/ ${this.audio?.analysis.duration.toFixed(2) ?? "0.00"} s</span>
          </div>
        </section>
      </div>
      ${
        selection
          ? html`
              <section class="chart-creation__form" aria-label=${this.t("selection")}>
                <button
                  class="button"
                  ?disabled=${this.busy}
                  @click=${() => {
                    this.clipboard = copyChartSelection(this.chart, this.selected);
                    this.requestUpdate();
                  }}
                >
                  ${this.t("creation.copy")}
                </button>
                <button
                  class="button"
                  ?disabled=${this.busy}
                  @click=${() => this.edit((p) => deleteChartSelection(p, this.selected))}
                >
                  ${this.t("deleteSelection")}
                </button>

                ${this.field(
                  "beat",
                  selection.tick / chart.resolution,
                  (value) =>
                    selectedUpdate((n) => {
                      n.tick = Math.round(Number(value) * chart.resolution);
                    }),
                  true,
                )}
                ${this.field(
                  "lane",
                  selection.lane,
                  (value) =>
                    selectedUpdate((n) => {
                      n.lane = Number(value);
                    }),
                  true,
                )}
                ${this.field(
                  "width",
                  selection.size,
                  (value) =>
                    selectedUpdate((n) => {
                      n.size = Number(value);
                    }),
                  true,
                )}
                <md-outlined-select
                  label=${this.t("noteType")}
                  .value=${selection.type}
                  ?disabled=${this.busy}
                  @change=${(e: Event) =>
                    selectedUpdate((n) => {
                      n.type = (e.target as HTMLSelectElement).value as SingleNote["type"];
                      if (n.type !== "flick") n.direction = "none";
                      else n.direction = "up";
                    })}
                >
                  ${["tap", "flick", "trace"].map(
                    (type) => html`
                      <md-select-option value=${type}><div slot="headline">${this.t(type)}</div></md-select-option>
                    `,
                  )}
                </md-outlined-select>
                ${
                  selection.type === "flick"
                    ? html`
                        <md-outlined-select
                          label=${this.t("direction")}
                          .value=${selection.direction}
                          ?disabled=${this.busy}
                          @change=${(e: Event) =>
                            selectedUpdate((n) => {
                              n.direction = (e.target as HTMLSelectElement).value as SingleNote["direction"];
                            })}
                        >
                          ${["left", "up", "right"].map(
                            (value) => html`
                              <md-select-option value=${value}>
                                <div slot="headline">
                                  ${this.t(`direction${value[0].toUpperCase()}${value.slice(1)}`)}
                                </div>
                              </md-select-option>
                            `,
                          )}
                        </md-outlined-select>
                      `
                    : nothing
                }
                ${
                  "ease" in selection
                    ? ["left", "right"].map(
                        (side) => html`
                          <md-outlined-select
                            label=${this.t(side === "left" ? "leftEase" : "rightEase")}
                            .value=${selection.ease[side as "left" | "right"]}
                            ?disabled=${this.busy}
                            @change=${(e: Event) =>
                              selectedUpdate((n) => {
                                if ("ease" in n)
                                  n.ease[side as "left" | "right"] = (e.target as HTMLSelectElement).value as
                                    "linear" | "in" | "out";
                              })}
                          >
                            ${["linear", "in", "out"].map(
                              (value) => html`
                                <md-select-option value=${value}>
                                  <div slot="headline">${this.t(`ease${value[0].toUpperCase()}${value.slice(1)}`)}</div>
                                </md-select-option>
                              `,
                            )}
                          </md-outlined-select>
                        `,
                      )
                    : nothing
                }
                <label>
                  <md-checkbox
                    aria-label=${this.t("critical")}
                    .checked=${selection.critical}
                    ?disabled=${this.busy}
                    @change=${(e: Event) =>
                      selectedUpdate((n) => {
                        n.critical = (e.target as HTMLInputElement).checked;
                      })}
                  ></md-checkbox>
                  ${this.t("critical")}
                </label>
                <label>
                  <md-checkbox
                    aria-label=${this.t("visible")}
                    .checked=${selection.visible}
                    ?disabled=${this.busy}
                    @change=${(e: Event) =>
                      selectedUpdate((n) => {
                        n.visible = (e.target as HTMLInputElement).checked;
                      })}
                  ></md-checkbox>
                  ${this.t("visible")}
                </label>
              </section>
            `
          : nothing
      }
      ${accordion({
        id: "chart-creation-project",
        label: this.t("project"),
        expanded: this.projectExpanded,
        onExpandedChange: (value) => {
          this.projectExpanded = value;
          this.requestUpdate();
        },
        content: html`
          <div class="chart-creation__form">
            ${this.field("title", chart.meta.title, (value) =>
              this.edit((p) => {
                p.meta.title = value;
              }),
            )}
            ${this.field("artist", chart.meta.artist, (value) =>
              this.edit((p) => {
                p.meta.artist = value;
              }),
            )}
            ${this.field("charter", chart.meta.charter, (value) =>
              this.edit((p) => {
                p.meta.charter = value;
              }),
            )}
            ${this.field(
              "creation.bpm",
              chart.tempos[0].bpm,
              (value) =>
                this.edit((p) => {
                  p.tempos[0].bpm = Number(value);
                }),
              true,
            )}
            ${this.field(
              "audioOffset",
              chart.audioOffset,
              (value) =>
                this.edit((p) => {
                  p.audioOffset = Number(value);
                }),
              true,
            )}
          </div>
        `,
      })}
      ${accordion({
        id: "chart-creation-tool",
        label: this.t("viewAndTool"),
        expanded: this.toolExpanded,
        onExpandedChange: (value) => {
          this.toolExpanded = value;
          this.requestUpdate();
        },
        content: html`
          <div class="chart-creation__form">
            ${this.field(
              "lane",
              this.insertLane,
              (value) => {
                this.insertLane = Math.max(0, Math.min(chart.laneBasis - chart.laneBasis / 6, Number(value)));
                this.requestUpdate();
              },
              true,
            )}
            <button
              class="button"
              ?disabled=${this.busy || !this.audio || ["select", "erase", "pan"].includes(this.tool)}
              @click=${() => this.place(Math.max(0, snapTick(this.map().secondsToTick(this.seconds), this.snap)), this.insertLane)}
            >
              ${this.t("creation.add_note")}
            </button>
            <label>
              <md-checkbox
                aria-label=${this.t("defaultCritical")}
                .checked=${this.critical}
                ?disabled=${this.busy}
                @change=${(e: Event) => {
                  this.critical = (e.target as HTMLInputElement).checked;
                }}
              ></md-checkbox>
              ${this.t("defaultCritical")}
            </label>
            <md-outlined-select
              label=${this.t("defaultDirection")}
              .value=${this.direction}
              ?disabled=${this.busy}
              @change=${(e: Event) => {
                this.direction = (e.target as HTMLSelectElement).value as typeof this.direction;
              }}
            >
              ${["left", "up", "right"].map(
                (value) => html`
                  <md-select-option value=${value}>
                    <div slot="headline">${this.t(`direction${value[0].toUpperCase()}${value.slice(1)}`)}</div>
                  </md-select-option>
                `,
              )}
            </md-outlined-select>
          </div>
        `,
      })}
      <div class="chart-creation__form">
        <md-outlined-select
          label=${this.t("snap")}
          .value=${String(this.snap)}
          ?disabled=${this.busy}
          @change=${(e: Event) => {
            this.snap = Number((e.target as HTMLSelectElement).value);
            this.requestUpdate();
          }}
        >
          ${[1, 2, 3, 4, 6, 8, 12, 16].map(
            (value) => html`
              <md-select-option value=${String(value)}><div slot="headline">1/${value}</div></md-select-option>
            `,
          )}
        </md-outlined-select>
        <md-outlined-select
          data-window
          label=${this.t("creation.zoom")}
          .value=${String(this.secondsPerScreen)}
          ?disabled=${this.busy}
          @change=${(e: Event) => {
            this.secondsPerScreen = Number((e.target as HTMLSelectElement).value);
            this.windowStart = this.clampStart(this.windowStart);
            this.requestUpdate();
          }}
        >
          ${[...new Set([0.5, 1, 2, 4, 8, 16, this.secondsPerScreen])]
            .sort((a, b) => a - b)
            .map(
              (value) => html`
                <md-select-option value=${String(value)} .selected=${value === this.secondsPerScreen}>
                  <div slot="headline">${Math.round(value * 100) / 100} s</div>
                </md-select-option>
              `,
            )}
        </md-outlined-select>
        <md-outlined-select
          label=${this.t("playbackSpeed")}
          .value=${String(this.rate)}
          ?disabled=${this.busy}
          @change=${(e: Event) => {
            this.rate = Number((e.target as HTMLSelectElement).value);
            if (this.preview) this.preview.clock.rate = this.rate;
          }}
        >
          ${[0.25, 0.5, 0.75, 1, 1.25, 1.5, 2].map(
            (value) => html`
              <md-select-option value=${String(value)}><div slot="headline">${value}×</div></md-select-option>
            `,
          )}
        </md-outlined-select>
        <md-outlined-select
          label=${this.t("file")}
          .value=${this.exportFormat}
          ?disabled=${this.busy}
          @change=${(e: Event) => {
            this.exportFormat = (e.target as HTMLSelectElement).value as ExportFormat;
            this.requestUpdate();
          }}
        >
          ${(["project", "ss", "usc"] as const).map(
            (value) => html`
              <md-select-option value=${value}>
                <div slot="headline">
                  ${this.t(value === "project" ? "formatProject" : value === "ss" ? "formatSs" : "formatUsc")}
                </div>
              </md-select-option>
            `,
          )}
        </md-outlined-select>
        <button
          class="button"
          ?disabled=${this.busy || !this.audio}
          @click=${() =>
            void this.run(async () => {
              await this.save();
              const chart = this.chart;
              const content =
                this.exportFormat === "ss"
                  ? serializeSs(chart)
                  : this.exportFormat === "usc"
                    ? serializeUsc(chart, { wrapped: true })
                    : serializeProjectJson(chart);
              await downloadBlob(new Blob([content], { type: "application/json" }), `chart.${this.exportFormat}.json`);
            })}
        >
          ${this.t("creation.export_chart")}
        </button>
      </div>
      ${
        getExportDiagnostics(chart, this.exportFormat).length
          ? html`
              <ul aria-label=${this.t("warnings")}>
                ${getExportDiagnostics(chart, this.exportFormat).map(
                  (warning) => html`
                    <li>${this.t(`creation.export_${warning.code.split(".").at(-1)}`)}</li>
                  `,
                )}
              </ul>
            `
          : nothing
      }
      <section aria-label=${this.t("timing")}>
        <div class="chart-creation__actions">
          <button
            class="button"
            ?disabled=${this.busy || !this.audio}
            @click=${() =>
              this.edit((p) => {
                const tick = Math.max(0, snapTick(this.map().secondsToTick(this.seconds), this.snap));
                if (!p.tempos.some((t) => t.tick === tick))
                  p.tempos.push({ id: createProjectId("tempo"), tick, bpm: this.map().bpmAtTick(tick) });
                p.tempos.sort((a, b) => a.tick - b.tick);
              })}
          >
            ${this.t("addBpm")}
          </button>
        </div>
        ${chart.tempos.slice(1).map(
          (tempo) => html`
            <div class="chart-creation__form">
              ${this.field(
                "beat",
                tempo.tick / chart.resolution,
                (value) =>
                  this.edit((p) => {
                    p.tempos.find((t) => t.id === tempo.id)!.tick = Math.round(Number(value) * chart.resolution);
                    p.tempos.sort((a, b) => a.tick - b.tick);
                  }),
                true,
              )}
              ${this.field(
                "creation.bpm",
                tempo.bpm,
                (value) =>
                  this.edit((p) => {
                    p.tempos.find((t) => t.id === tempo.id)!.bpm = Number(value);
                  }),
                true,
              )}
              ${iconButton({
                label: this.t("deleteBpm"),
                icon: "delete",
                disabled: this.busy,
                onClick: () =>
                  this.edit((p) => {
                    p.tempos = p.tempos.filter((t) => t.id !== tempo.id);
                  }),
              })}
            </div>
          `,
        )}
      </section>
      <section aria-label=${this.t("timeScale")}>
        <button
          class="button"
          ?disabled=${this.busy || !this.audio}
          @click=${() =>
            this.edit((p) => {
              const tick = Math.max(0, snapTick(this.map().secondsToTick(this.seconds), this.snap));
              if (!p.timeScales.some((t) => t.tick === tick))
                p.timeScales.push({ id: createProjectId("speed"), tick, scale: 1 });
              p.timeScales.sort((a, b) => a.tick - b.tick);
            })}
        >
          ${this.t("addTimeScale")}
        </button>
        ${chart.timeScales.map(
          (scale) => html`
            <div class="chart-creation__form">
              ${this.field(
                "beat",
                scale.tick / chart.resolution,
                (value) =>
                  this.edit((p) => {
                    p.timeScales.find((t) => t.id === scale.id)!.tick = Math.round(Number(value) * chart.resolution);
                    p.timeScales.sort((a, b) => a.tick - b.tick);
                  }),
                true,
              )}
              ${this.field(
                "timeScale",
                scale.scale,
                (value) =>
                  this.edit((p) => {
                    p.timeScales.find((t) => t.id === scale.id)!.scale = Number(value);
                  }),
                true,
              )}
              ${iconButton({
                label: this.t("deleteTimeScale"),
                icon: "delete",
                disabled: this.busy,
                onClick: () =>
                  this.edit((p) => {
                    p.timeScales = p.timeScales.filter((t) => t.id !== scale.id);
                  }),
              })}
            </div>
          `,
        )}
      </section>
      <div class="chart-creation__form">
        <md-outlined-select
          label=${this.t("creation.projects")}
          value=""
          ?disabled=${this.busy}
          @change=${(e: Event) => {
            const id = (e.target as HTMLSelectElement).value;
            if (id) void this.run(() => this.open(id));
          }}
        >
          ${this.documents.map(
            (document) => html`
              <md-select-option value=${document.id}>
                <div slot="headline">${document.title || this.t("project")}</div>
              </md-select-option>
            `,
          )}
        </md-outlined-select>
        <md-outlined-select
          data-version
          label=${this.t("creation.versions")}
          .value=${String(this.activeRevision)}
          ?disabled=${this.busy || !this.revisions.length}
          @change=${(e: Event) => void this.run(() => this.open(this.projectId, Number((e.target as HTMLSelectElement).value)))}
        >
          ${this.revisions.map(
            (revision) => html`
              <md-select-option
                value=${String(revision.revision)}
                .selected=${revision.revision === this.activeRevision}
              >
                <div slot="headline">
                  ${revision.revision} · ${new Date(revision.savedAt).toLocaleString(this.locale)}
                </div>
              </md-select-option>
            `,
          )}
        </md-outlined-select>
      </div>
    `;
  }
}
if (!customElements.get("chart-creation-workspace"))
  customElements.define("chart-creation-workspace", ChartCreationWorkspace);
