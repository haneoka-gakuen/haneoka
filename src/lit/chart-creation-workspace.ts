import { LitElement, html, nothing } from "lit";
import {
  DEFAULT_RENDER_SETTINGS,
  OUR_NOTES_NOTE_SKINS,
  OUR_NOTES_NOTE_SKIN_NAMES,
  OUR_NOTES_NOTE_EFFECT_SKINS,
  OUR_NOTES_NOTE_EFFECT_SKIN_NAMES,
  OUR_NOTES_NOTE_SE_GROUP_IDS,
  OUR_NOTES_NOTE_SE_GROUP_NAMES,
  OUR_NOTES_LIVE_QUALITIES,
  OUR_NOTES_LIVE_QUALITY_NAMES,
} from "@haneoka/cassiopeia-plugin-our-notes";
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
import { TempoMap, snapTick } from "../../packages/chart-editor/src/timing";
import { importChart } from "../../packages/chart-editor/src/formats/detect";
import { assertValidProject } from "../../packages/chart-editor/src/validation";
import { CreationStore, type CreationDocument, type CreationRevision } from "../lib/chart-creation/storage";
import { createExampleAudio, decodeCreationAudio, type CreationAudio } from "../lib/chart-creation/audio";
import { MediaClock } from "@haneoka/cassiopeia-host-web";
import { clientText, initializeI18nClient } from "../i18n/client";
import { beginLoading } from "../lib/loading-progress";
import { downloadBlob } from "../lib/canvas-capture";
import { iconButton, segmented } from "./ui/controls";
import { icon } from "./ui/icon";
import { trapFocus } from "../lib/overlay";
import { setAppBarActions, clearAppBarActions } from "../lib/app-bar";
import { accordion } from "./ui/accordion";
import "./chart-creation-library";
import type { ChartCreationLibrary, PublicChartImport } from "./chart-creation-library";
import type { ChartEmbedHandle, ChartPlaybackOptions, ChartSkin } from "../../packages/embed-cassiopeia/src/types";
import type { HaneokaReleaseIdentity, HaneokaLocale } from "../../packages/api-client/src/haneoka";
import { listPublicCreationSongs } from "../lib/chart-creation/public-songs";
import { readReleaseServer } from "../lib/release-server";
import { compileOurNotesCreation } from "../lib/chart-creation/our-notes";
import { loadOurNotesCreationCanvasSkin, ourNotesCreationCanvasNoteAppearance, createChartCanvasRibbonStyle, drawChartCanvasLanePlane, drawChartCanvasRibbon, interpolateNoteLine, type OurNotesCreationCanvasSkin } from "../lib/chart-creation/native-canvas-skin";
import type { ChartNote } from "@haneoka/cassiopeia";
import type { RenderNoteKind } from "@haneoka/cassiopeia-plugin-our-notes";
import { loadingState } from "./ui/state";
import type { ChartSelection } from "../../packages/chart-editor/src/creation/editing";
import { createAuthoredNote, resizeChartSelection } from "../../packages/chart-editor/src/creation/authoring";
import {
  brushChartSelection,
  flipChartSelection,
  cutChartSelection,
  generateLinePoints,
  type NoteBrush,
} from "../../packages/chart-editor/src/creation/actions";
import {
  timeToViewportY,
  panVerticalTimeViewport,
  scrollVerticalTimeViewport,
  zoomVerticalTimeViewportAtY,
} from "../../packages/chart-editor/src/viewport";
import { serializeProjectJson } from "../../packages/chart-editor/src/formats/project-json";
import { serializeUsc } from "../../packages/chart-editor/src/formats/usc";
import {
  getExportDiagnostics,
  serializeSsForTarget,
  type ExportFormat,
} from "../../packages/chart-editor/src/formats/diagnostics";
import {
  chartSelectionNodes,
  chartSelectionInBox,
  moveChartSelection,
  copyChartSelectionGroup,
  pasteChartSelectionGroup,
  deleteChartSelectionGroup,
} from "../../packages/chart-editor/src/creation/selection";
interface EditAudioTransport {
  clock: MediaClock;
  play(): Promise<void>;
  pause(): void;
  seek(seconds: number): void;
  dispose(): void;
}
interface SelectionGesture {
  pointer: number;
  base: Project;
  rect: DOMRect;
  map: TempoMap;
  startSeconds: number;
  span: number;
  x: number;
  y: number;
  endX: number;
  endY: number;
  tick: number;
  lane: number;
  kind: "move" | "box" | "resize-left" | "resize-right" | "brush";
  resizeWidth?: number;
  resizeId?: string;
  laneStart: number;
  laneSpan: number;
  ids: Set<string>;
  previous: string[];
  primary: string;
  additive: boolean;
  moved: boolean;
  candidate?: Project;
  deltaTick: number;
  deltaLane: number;
  mergeKey: string;
}

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
    selectedIds: { state: true },
    multiPick: { state: true },
    documents: { state: true },
    revisions: { state: true },
    windowStart: { state: true },
    leftOpen: { state: true },
    rightOpen: { state: true },
    narrow: { state: true },
    stageMode: { state: true },
    nativeMode: { state: true },
    defaultWidth: { state: true },
    fullscreen: { state: true },
    zoomX: { state: true },
    laneStart: { state: true },
    followPlayback: { state: true },
    relativeSnap: { state: true },
    canvasLoading: { state: true },
    canvasFailed: { state: true },
  };
  declare locale: string;
  private history = new ProjectHistory(createEmptyProject());
  private original = createEmptyProject();
  private projectSnapshot?: { revision: number; value: Project };
  private warningSnapshot?: { revision: number; format: ExportFormat; value: ReturnType<typeof getExportDiagnostics> };
  private readonly libraryImport = (value: PublicChartImport, signal: AbortSignal) => this.importLibrary(value, signal);
  private source?: CreationDocument["source"];
  private projectId: string = crypto.randomUUID();
  private head = 0;
  private conflict = false;
  private activeRevision = 0;
  private projectExpanded = true;
  private toolExpanded = true;
  private store = new CreationStore();
  private audio?: CreationAudio;
  private preview?: EditAudioTransport;
  declare private stageMode: "edit" | "preview";
  declare private nativeMode: "play" | "watch" | "chart";
  private nativePreview?: ChartEmbedHandle;
  private nativeController?: AbortController;
  private nativePending?: Promise<ChartEmbedHandle>;
  private nativeDisposal: Promise<void> = Promise.resolve();
  private nativeEpoch = 0;
  private previewIdentity?: HaneokaReleaseIdentity;
  private canvasTheme?: OurNotesCreationCanvasSkin;
  private canvasThemeKey = "";
  private canvasController?: AbortController;
  private flatChart?: { project:Project; value?:ReturnType<typeof compileOurNotesCreation> };
  declare private canvasLoading: boolean;
  declare private canvasFailed: boolean;
  private nativeOptions: ChartPlaybackOptions = {
    mode: "play",
    volume: 0.82,
    rate: 1,
    loop: false,
    noteSoundEnabled: true,
    noteSoundVolume: 0.75,
    settings: { ...DEFAULT_RENDER_SETTINGS },
  };
  private nativeSkin: ChartSkin = {
    currentQuality: 2,
    noteSkin: "skin001",
    noteEffectSkin: "effect001",
    noteSeGroup: 1,
  };
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
  private pending?: { tick: number; lane: number; size: number };
  private seconds = 0;
  private lastTransportPaint = 0;
  private critical = false;
  private snap = 4;
  private secondsPerScreen = 4;
  private rate = 1;
  private exportFormat: ExportFormat = "project";
  private clipboard?: ChartSelection[];
  declare private selectedIds: Set<string>;
  declare private multiPick: boolean;
  private gesture?: SelectionGesture;
  private gestureFrame = 0;
  private pan?: { pointer: number; x: number; y: number; start: number; laneStart: number };
  private direction: "left" | "up" | "right" = "up";
  private insertLane = 0;
  declare private defaultWidth: number;
  private widthSession?: { base: Project; id: string; candidate?: Project };
  private widthCancelled = false;
  private brushPreset: NoteBrush = { type: "tap", direction: "none", critical: false, visible: true };
  declare private fullscreen: boolean;
  declare private zoomX: number;
  declare private laneStart: number;
  declare private followPlayback: boolean;
  declare private relativeSnap: boolean;
  private fullscreenChanged = () => {
    this.fullscreen = document.fullscreenElement === this;
  };
  declare private leftOpen: boolean;
  declare private rightOpen: boolean;
  declare private narrow: boolean;
  private projectTab = "project";
  private panelMedia?: MediaQueryList;
  private releasePanelFocus?: () => void;
  private focusedPanel?: HTMLElement;
  private readonly toolbarOwner = `chart-creation-${crypto.randomUUID()}`;
  private mediaChanged = () => {
    this.narrow = this.panelMedia?.matches ?? false;
    this.leftOpen = !this.narrow && innerWidth >= 1280;
    this.rightOpen = !this.narrow;
  };
  constructor() {
    super();
    this.locale = "en";
    this.defaultWidth = 4;
    this.fullscreen = false;
    this.zoomX = 1;
    this.laneStart = 0;
    this.followPlayback = false;
    this.relativeSnap = false;
    this.canvasLoading = false;
    this.canvasFailed = false;
    this.stageMode = "edit";
    this.nativeMode = "play";
    this.multiPick = false;
    this.busy = false;
    this.dirty = false;
    this.error = "";
    this.status = "";
    this.tool = "tap";
    this.setSelection([]);
    this.documents = [];
    this.revisions = [];
    this.windowStart = 0;
    this.leftOpen = false;
    this.rightOpen = false;
    this.narrow = false;
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
    if (this.projectSnapshot?.revision !== this.history.revision)
      this.projectSnapshot = { revision: this.history.revision, value: this.history.value };
    return this.projectSnapshot.value;
  }
  private exportWarnings() {
    if (this.warningSnapshot?.revision !== this.history.revision || this.warningSnapshot.format !== this.exportFormat)
      this.warningSnapshot = {
        revision: this.history.revision,
        format: this.exportFormat,
        value: getExportDiagnostics(this.chart, this.exportFormat),
      };
    return this.warningSnapshot.value;
  }
  connectedCallback() {
    super.connectedCallback();
    document.addEventListener("fullscreenchange", this.fullscreenChanged);
    this.panelMedia = matchMedia("(max-width: 959px)");
    this.panelMedia.addEventListener("change", this.mediaChanged);
    this.mediaChanged();
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
    document.removeEventListener("fullscreenchange", this.fullscreenChanged);
    this.panelMedia?.removeEventListener("change", this.mediaChanged);
    this.releasePanelFocus?.();
    this.focusedPanel = undefined;
    clearAppBarActions(this.toolbarOwner);
    this.removeEventListener("keydown", this.keydown);
    window.removeEventListener("beforeunload", this.beforeUnload);
    this.cancelGesture();
    this.cancelWidth();
    this.pan = undefined;
    this.controller?.abort();
    this.preview?.dispose();
    this.preview = undefined;
    void this.disposeNative();
    this.canvasController?.abort();
    void this.canvasTheme?.dispose();this.canvasTheme=undefined;
    this.observer?.disconnect();
    this.unlocale?.();
    void this.store.close().catch(() => {});
    super.disconnectedCallback();
  }
  protected updated() {
    this.paint();
    setAppBarActions(this.toolbarOwner, this.renderAppActions(), this);
    const panel = this.narrow ? this.querySelector<HTMLElement>(".chart-studio__panel:not([hidden])") : null;
    if (panel !== (this.focusedPanel ?? null)) {
      this.releasePanelFocus?.();
      this.focusedPanel = panel ?? undefined;
      this.releasePanelFocus = panel ? trapFocus(panel, { onDismiss: () => this.closePanels() }) : undefined;
    }
    // Material resolves newly rendered version options after its own update.
    const control = this.querySelector<HTMLElementTagNameMap["md-outlined-select"]>("[data-version]");
    if (control) {
      const value = String(this.activeRevision);
      void control.updateComplete.then(() => {
        if (this.isConnected && String(this.activeRevision) === value && control.value !== value) control.select(value);
      });
    }
  }
  private async run(action: (signal: AbortSignal) => Promise<void>) {
    if (this.busy) return;
    this.cancelGesture();
    this.cancelWidth();
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
    if (this.busy || this.gesture) return;
    this.cancelWidth();
    try {
      const draft = structuredClone(this.chart);
      updater(draft);
      assertValidProject(draft);
      const revision = this.history.revision;
      this.history.replace(draft);
      if (revision === this.history.revision) return;
      this.pruneSelection();
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
    if (this.stageMode === "preview" || this.nativePreview || this.nativePending) {
      this.stageMode = "edit";
      void this.disposeNative();
    }
    this.preview?.dispose();
    this.preview = undefined;
    if (!this.audio || !this.isConnected) return;
    const url = URL.createObjectURL(this.audio.file),
      clock = new MediaClock(url, { playbackRate: this.rate, volume: this.nativeOptions.volume ?? 0.82, loop: this.nativeOptions.loop ?? false });
    let frame = 0,
      disposed = false,
      intent = 0,
      playingIntent = false;
    const sync = () => {
      cancelAnimationFrame(frame);
      frame = 0;
      if (disposed || !this.isConnected) return;
      this.updateTransport(clock.timeMs / 1000, clock.playing);
      if (clock.advancing) frame = requestAnimationFrame(sync);
    };
    const pause = () => {
      playingIntent = false;
      ++intent;
      clock.pause();
      sync();
    };
    const seek = (seconds: number) => {
      clock.seek(Math.max(0, seconds) * 1000);
      sync();
    };
    const error = () => {
      if (disposed) return;
      pause();
      this.error = this.t("audioFailed");
    };
    const visibility = () => {
      if (document.hidden) pause();
    };
    const events = ["playing", "pause", "ended", "timeupdate", "waiting", "stalled", "canplay", "durationchange"];
    for (const event of events) clock.addEventListener(event, sync);
    clock.addEventListener("error", error);
    clock.audio.addEventListener("seeked", sync);
    document.addEventListener("visibilitychange", visibility);
    this.preview = {
      clock,
      play: async () => {
        const current = ++intent;
        playingIntent = true;
        if (clock.audio.ended) seek(0);
        await clock.play();
        if (disposed || !playingIntent) {
          clock.pause();
          return;
        }
        if (current === intent) sync();
      },
      pause,
      seek,
      dispose: () => {
        if (disposed) return;
        disposed = true;
        playingIntent = false;
        ++intent;
        cancelAnimationFrame(frame);
        for (const event of events) clock.removeEventListener(event, sync);
        clock.removeEventListener("error", error);
        clock.audio.removeEventListener("seeked", sync);
        document.removeEventListener("visibilitychange", visibility);
        clock.destroy();
        URL.revokeObjectURL(url);
      },
    };
    this.preview.seek(Math.max(0, position));
    void this.ensureCanvasSkin();
  }
  private async ensureCanvasSkin(force = false) {
    if (!this.audio || !this.isConnected) return;
    const stored=this.chart.extensions.haneoka;
    const identity = stored && typeof stored === "object" && !Array.isArray(stored) && typeof stored.server === "string" && typeof stored.releaseId === "string" && typeof stored.sourceId === "string"
      ? {schema:"haneoka-resource-release-identity-v1" as const,server:stored.server,releaseId:stored.releaseId,sourceId:stored.sourceId}
      : this.previewIdentity?.server===readReleaseServer() ? this.previewIdentity : undefined;
    const requested=JSON.stringify([identity??readReleaseServer(),this.nativeSkin]);
    if(!force&&this.canvasThemeKey===requested&&(this.canvasTheme||this.canvasLoading))return;
    this.canvasController?.abort();
    const retired=this.canvasTheme;this.canvasTheme=undefined;void retired?.dispose();
    const controller=this.canvasController=new AbortController();this.canvasThemeKey=requested;this.canvasLoading=true;this.canvasFailed=false;
    const report=beginLoading(this.c("loading"),{signal:controller.signal,scope:"owner"});
    try {
      const pin=identity??(await listPublicCreationSongs({server:readReleaseServer(),locale:this.locale as HaneokaLocale,limit:1,signal:controller.signal})).release;
      const theme=await loadOurNotesCreationCanvasSkin(pin,{skin:this.nativeSkin,locale:this.locale,signal:controller.signal});
      if(controller!==this.canvasController||!this.isConnected){await theme.dispose();return;}
      this.canvasTheme=theme;this.previewIdentity=pin;this.canvasThemeKey=JSON.stringify([pin,this.nativeSkin]);
      report.finish();this.paint();
    } catch(error) {
      if(!controller.signal.aborted&&controller===this.canvasController){this.canvasFailed=true;report.fail(error);}
    } finally {
      if(controller===this.canvasController){this.canvasLoading=false;this.requestUpdate();}
    }
  }
  private flatProjection(project:Project) {
    if(this.flatChart?.project!==project){
      try { this.flatChart={project,value:compileOurNotesCreation(project)}; }
      catch { this.flatChart={project}; }
    }
    return this.flatChart.value;
  }
  private updateTransport(seconds: number, playing: boolean) {
    this.seconds = seconds;
    if (playing && this.stageMode === "edit" && this.followPlayback && !this.gesture) {
      const next = this.clampStart(seconds - this.secondsPerScreen * 0.25);
      if (Math.abs(next - this.windowStart) > 0.03) this.windowStart = next;
    }
    if(this.stageMode === "edit" && !this.gesture && (!playing || performance.now()-this.lastTransportPaint>=32)) {
      this.lastTransportPaint=performance.now();this.paint();
    }
    const output = this.querySelector("[data-time]");
    if (output) output.textContent = seconds.toFixed(2);
    const playhead = this.querySelector<HTMLElement & { value: number }>("[data-playhead]");
    if (playhead) playhead.value = seconds;
    const button = this.querySelector<HTMLButtonElement>("[data-play]");
    if (button) {
      button.setAttribute("aria-label", this.c(playing ? "pause" : "play"));
      button.setAttribute("aria-pressed", String(playing));
      button.querySelector("use")?.setAttribute("href", `/icons.svg#${playing ? "pause" : "play_arrow"}`);
    }
  }
  private disposeNative() {
    ++this.nativeEpoch;
    this.nativeController?.abort();
    this.nativeController = undefined;
    const handle = this.nativePreview,
      pending = this.nativePending;
    this.nativePreview = undefined;
    this.nativePending = undefined;
    handle?.cancel();
    this.nativeDisposal = Promise.all([
      this.nativeDisposal,
      pending
        ?.then(async (value) => {
          if (value !== handle) await value.dispose();
        })
        .catch(() => {}),
    ])
      .then(async () => {
        await handle?.dispose();
      })
      .catch(() => {});
    return this.nativeDisposal;
  }
  private async importLibrary(value: PublicChartImport, external: AbortSignal) {
    let accepted = false,
      cancelled = false;
    await this.run(async (signal) => {
      const abort = () => this.controller?.abort(external.reason);
      external.addEventListener("abort", abort, { once: true });
      try {
        external.throwIfAborted();
        await this.save();
        const audio = await decodeCreationAudio(value.audio, signal);
        signal.throwIfAborted();
        await this.disposeNative();
        this.projectId = crypto.randomUUID();
        this.head = 0;
        this.activeRevision = 0;
        this.revisions = [];
        this.history.reset(value.project);
        this.original = structuredClone(value.project);
        this.source = value.source;
        this.audio = audio;
        this.previewIdentity = value.identity;
        this.setSelection([]);
        this.pending = undefined;
        this.dirty = true;
        this.windowStart = 0;
        this.rebuildPreview(0);
        this.status = value.warnings.length ? this.t("warnings") : this.t("ready");
        accepted = true;
      } finally {
        cancelled = signal.aborted;
        external.removeEventListener("abort", abort);
      }
    });
    if (!accepted) throw cancelled ? new DOMException("Cancelled", "AbortError") : new Error("import_failed");
  }
  private showLibrary() {
    if (this.busy) return;
    if (this.narrow) this.closePanels();
    void this.updateComplete.then(() => this.querySelector<ChartCreationLibrary>("chart-creation-library")?.show());
  }
  private async switchStage() {
    if (this.busy || !this.audio) return;
    if (this.stageMode === "preview") {
      await this.disposeNative();
      this.stageMode = "edit";
      await this.updateComplete;
      this.rebuildPreview(this.seconds);
      return;
    }
    let mounted = false;
    await this.run(async (signal) => {
      const position = this.seconds;
      await this.disposeNative();
      this.preview?.dispose();
      this.preview = undefined;
      this.stageMode = "preview";
      this.closePanels();
      await this.updateComplete;
      const stored = this.chart.extensions.haneoka;
      if (
        stored &&
        typeof stored === "object" &&
        !Array.isArray(stored) &&
        typeof stored.server === "string" &&
        typeof stored.releaseId === "string" &&
        typeof stored.sourceId === "string"
      )
        this.previewIdentity = {
          schema: "haneoka-resource-release-identity-v1",
          server: stored.server,
          releaseId: stored.releaseId,
          sourceId: stored.sourceId,
        };
      else if (!this.previewIdentity || this.previewIdentity.server !== readReleaseServer())
        this.previewIdentity = (
          await listPublicCreationSongs({
            server: readReleaseServer(),
            locale: this.locale as HaneokaLocale,
            limit: 1,
            signal,
          })
        ).release;
      signal.throwIfAborted();
      const epoch = ++this.nativeEpoch,
        controller = (this.nativeController = new AbortController());
      const abort = () => controller.abort(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      try {
        const { mountOurNotesCreationPreview } = await import("../lib/chart-creation/our-notes");
        signal.throwIfAborted();
        const pending = (this.nativePending = mountOurNotesCreationPreview(
          this.querySelector<HTMLElement>("[data-native-preview]")!,
          this.chart,
          this.audio!,
          {
            identity: this.previewIdentity!,
            locale: this.locale,
            signal: controller.signal,
            skin: this.nativeSkin,
            labels: { player: this.t("preview"), pause: this.c("pause"), loading: this.c("loading") },
            onEvent: (event) => {
              if (epoch !== this.nativeEpoch) return;
              if (event.type === "state") this.updateTransport(event.snapshot.time, event.snapshot.playing);
              if (event.type === "error") this.error = this.t("audioFailed");
            },
          },
        ));
        const handle = await pending;
        signal.throwIfAborted();
        if (epoch !== this.nativeEpoch || !this.isConnected) {
          await handle.dispose();
          return;
        }
        this.nativePreview = handle;
        this.nativePending = undefined;
        await handle.setOptions({ ...this.nativeOptions, mode: this.nativeMode, rate: this.rate });
        signal.throwIfAborted();
        handle.seek(position);
        mounted = true;
      } finally {
        signal.removeEventListener("abort", abort);
      }
    });
    if (!mounted && this.isConnected) {
      await this.disposeNative();
      this.stageMode = "edit";
      await this.updateComplete;
      this.rebuildPreview(this.seconds);
    }
  }
  private seekPlayback(seconds: number) {
    if (this.stageMode === "preview") this.nativePreview?.seek(seconds);
    else this.preview?.seek(seconds);
  }
  private pausePlayback() {
    this.nativePreview?.pause();
    this.preview?.pause();
  }
  private async applyNativeOptions(patch: ChartPlaybackOptions) {
    this.nativeOptions = { ...this.nativeOptions, ...patch };
    try {
      await this.nativePreview?.setOptions(patch);
      this.requestUpdate();
    } catch {
      this.error = this.t("audioFailed");
    }
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
        this.setSelection([]);
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
    this.setSelection([]);
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
      this.setSelection([]);
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
    if (this.stageMode === "preview") {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void this.run(() => this.save());
      }
      return;
    }
    if (this.gesture) {
      if (event.key === "Escape") this.cancelGesture();
      event.preventDefault();
      return;
    }
    let used = true;
    const modifier = event.ctrlKey || event.metaKey;
    if (modifier && event.key.toLowerCase() === "s") void this.run(() => this.save());
    else if (modifier && (event.key.toLowerCase() === "z" || event.key.toLowerCase() === "y")) {
      if (event.shiftKey || event.key.toLowerCase() === "y") this.history.redo();
      else this.history.undo();
      this.pruneSelection();
      this.dirty = true;
      this.rebuildPreview();
      this.requestUpdate();
    } else if (modifier && event.key.toLowerCase() === "a") {
      this.setSelection(chartSelectionNodes(this.chart).map((item) => item.note.id));
    } else if (modifier && event.key.toLowerCase() === "x") {
      this.cutSelection();
    } else if (modifier && event.key.toLowerCase() === "c") {
      this.clipboard = copyChartSelectionGroup(this.chart, this.selectedIds);
      this.requestUpdate();
    } else if (modifier && event.key.toLowerCase() === "v" && this.clipboard?.length)
      this.edit((p) => {
        this.setSelection(
          pasteChartSelectionGroup(
            p,
            this.clipboard!,
            Math.max(0, snapTick(this.map().secondsToTick(this.seconds), this.snap)),
          ),
        );
      });
    else if (event.key === "Delete" || event.key === "Backspace")
      this.edit((p) => deleteChartSelectionGroup(p, this.selectedIds));
    else if (!modifier && (event.key === "+" || event.key === "=")) this.setVerticalZoom(this.secondsPerScreen / 2);
    else if (!modifier && event.key === "-") this.setVerticalZoom(this.secondsPerScreen * 2);
    else if (event.key === " ") this.togglePlayback();
    else if (event.key === "Escape") {
      this.pending = undefined;
      this.setSelection([]);
      this.requestUpdate();
    } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      this.windowStart = this.clampStart(this.windowStart + (event.key === "ArrowUp" ? 1 : -1) * 0.25);
      this.requestUpdate();
    } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      this.laneStart = this.clampLaneStart(
        this.laneStart + (((event.key === "ArrowRight" ? 1 : -1) * this.chart.laneBasis) / this.zoomX) * 0.1,
      );
    } else if (event.key === "PageUp" || event.key === "PageDown") {
      this.windowStart = this.clampStart(this.windowStart + (event.key === "PageUp" ? 1 : -1) * this.secondsPerScreen);
    } else if (event.key === "Home" || event.key === "End") {
      this.windowStart = event.key === "Home" ? 0 : this.clampStart(this.audio?.analysis.duration ?? 0);
    } else if (/^[1-7]$/.test(event.key) && !modifier) {
      this.tool = ["select", "tap", "flick", "trace", "hold", "guide", "erase"][Number(event.key) - 1];
      this.pending = undefined;
    } else used = false;
    if (used) event.preventDefault();
  };
  private togglePlayback() {
    if (this.stageMode === "preview") {
      if (this.nativePreview?.snapshot.playing) this.nativePreview.pause();
      else
        void this.nativePreview?.play().catch(() => {
          this.error = this.t("audioFailed");
        });
      return;
    }
    if (this.preview?.clock.playing) this.preview.pause();
    else
      void this.preview?.play().catch(() => {
        this.error = this.t("audioFailed");
      });
  }
  private clampLaneStart(value: number) {
    const basis = this.chart.laneBasis;
    return Math.max(0, Math.min(basis - basis / this.zoomX, value));
  }
  private setHorizontalZoom(value: number, pixel?: number) {
    if (this.gesture || this.busy) return;
    const canvas = this.querySelector<HTMLCanvasElement>(".chart-creation__editor"),
      basis = this.chart.laneBasis;
    const fraction = canvas?.clientWidth
      ? Math.max(0, Math.min(1, (pixel ?? canvas.clientWidth / 2) / canvas.clientWidth))
      : 0.5;
    const anchor = this.laneStart + (fraction * basis) / this.zoomX;
    this.zoomX = Math.max(1, Math.min(8, value));
    this.laneStart = this.clampLaneStart(anchor - (fraction * basis) / this.zoomX);
  }
  private clampStart(value: number) {
    return Math.max(0, Math.min(Math.max(0, (this.audio?.analysis.duration ?? 0) - this.secondsPerScreen), value));
  }
  private setVerticalZoom(span: number, pixel?: number) {
    if (this.busy || this.gesture || !this.audio || this.stageMode !== "edit" || !Number.isFinite(span)) return;
    const canvas = this.querySelector<HTMLCanvasElement>(".chart-creation__editor");
    if (!canvas?.clientHeight) return;
    const height = canvas.clientHeight;
    if (pixel === undefined) {
      const selected = chartSelectionNodes(this.chart).find((item) => item.note.id === this.selected);
      const time = selected ? this.map().tickToSeconds(selected.note.tick) : this.seconds;
      const at = timeToViewportY(time, { startSeconds: this.windowStart, pixelsPerSecond: height / this.secondsPerScreen, height });
      pixel = at >= 0 && at <= height ? at : height / 2;
    }
    const nextSpan = Math.max(0.5, Math.min(16, span));
    const next = zoomVerticalTimeViewportAtY({
      startSeconds: this.windowStart, pixelsPerSecond: height / this.secondsPerScreen, height,
    }, height / nextSpan, pixel);
    this.secondsPerScreen = nextSpan;
    this.windowStart = this.clampStart(next.startSeconds);
    this.requestUpdate();
  }
  private wheel(event: WheelEvent) {
    if (this.busy || !this.audio) return;
    event.preventDefault();
    if (this.gesture) return;
    const canvas = event.currentTarget as HTMLCanvasElement;
    if ((event.ctrlKey || event.metaKey) && event.shiftKey) {
      this.setHorizontalZoom(
        this.zoomX * Math.exp(-event.deltaY * 0.002),
        event.clientX - canvas.getBoundingClientRect().left,
      );
      return;
    }
    if (event.shiftKey) {
      this.laneStart = this.clampLaneStart(
        this.laneStart + (event.deltaY / canvas.clientWidth) * (this.chart.laneBasis / this.zoomX),
      );
      return;
    }
    const viewport = {
      startSeconds: this.windowStart,
      pixelsPerSecond: canvas.clientHeight / this.secondsPerScreen,
      height: canvas.clientHeight,
    };
    if (event.ctrlKey || event.metaKey) {
      this.setVerticalZoom(this.secondsPerScreen * Math.exp(event.deltaY * 0.002), event.clientY - canvas.getBoundingClientRect().top);
    } else this.windowStart = this.clampStart(scrollVerticalTimeViewport(viewport, event.deltaY).startSeconds);
    this.requestUpdate();
  }
  private panMove(event: PointerEvent) {
    if (this.gesture?.pointer === event.pointerId) {
      this.moveGesture(event);
      return;
    }
    if (this.pan?.pointer !== event.pointerId) return;
    const canvas = event.currentTarget as HTMLCanvasElement;
    this.laneStart = this.clampLaneStart(
      this.pan.laneStart - ((event.clientX - this.pan.x) / canvas.clientWidth) * (this.chart.laneBasis / this.zoomX),
    );
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
    if (this.gesture?.pointer === event.pointerId) {
      this.endGesture(event);
      return;
    }
    if (this.pan?.pointer !== event.pointerId) return;
    this.pan = undefined;
    const canvas = event.currentTarget as HTMLCanvasElement;
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
  }
  private hit(event: PointerEvent) {
    if (this.busy || !this.audio || this.canvasLoading || !this.canvasTheme || this.gesture || this.pan || event.button !== 0 || !event.isPrimary) return;
    const canvas = event.currentTarget as HTMLCanvasElement;
    canvas.focus();
    if (this.tool === "pan") {
      this.pan = {
        pointer: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        start: this.windowStart,
        laneStart: this.laneStart,
      };
      canvas.setPointerCapture(event.pointerId);
      return;
    }
    const rect = canvas.getBoundingClientRect(),
      chart = this.chart,
      map = this.map();
    const seconds = this.windowStart + (1 - (event.clientY - rect.top) / rect.height) * this.secondsPerScreen;
    const laneSpan = chart.laneBasis / this.zoomX;
    const pointerLane = this.laneStart + ((event.clientX - rect.left) / rect.width) * laneSpan;
    const tick = Math.max(0, snapTick(map.secondsToTick(seconds), this.snap)),
      lane = Math.max(0, Math.min(chart.laneBasis, Math.round(pointerLane)));
    const edgeTolerance = ((event.pointerType === "touch" ? 14 : 8) / rect.width) * laneSpan;
    const selectedEdge = (item: ReturnType<typeof chartSelectionNodes>[number]) =>
      this.selectedIds.has(item.note.id) &&
      Math.min(Math.abs(pointerLane - item.lane), Math.abs(pointerLane - item.lane - item.size)) <= edgeTolerance;
    const hitNode = chartSelectionNodes(chart)
      .filter(
        (item) =>
          Math.abs(map.tickToSeconds(item.note.tick) - seconds) <=
            Math.max(0.04, (12 * this.secondsPerScreen) / rect.height) &&
          pointerLane >= item.lane - edgeTolerance &&
          pointerLane <= item.lane + Math.max(item.size, 0.6) + edgeTolerance,
      )
      .sort(
        (a, b) =>
          Number(selectedEdge(b)) - Number(selectedEdge(a)) ||
          Math.abs(map.tickToSeconds(a.note.tick) - seconds) - Math.abs(map.tickToSeconds(b.note.tick) - seconds),
      )[0];
    const nearby = hitNode?.note;
    const leftDistance = hitNode ? Math.abs(pointerLane - hitNode.lane) : Infinity;
    const rightDistance = hitNode ? Math.abs(pointerLane - hitNode.lane - hitNode.size) : Infinity;
    const resizeEdge =
      nearby &&
      this.selectedIds.has(nearby.id) &&
      Math.min(leftDistance, rightDistance) <= edgeTolerance
        ? leftDistance < rightDistance
          ? "resize-left"
          : "resize-right"
        : undefined;
    if (this.tool === "select" || this.tool === "brush") {
      if (this.tool === "brush" && !nearby) return;
      const previous = [...this.selectedIds],
        primary = this.selected,
        additive = this.multiPick || event.shiftKey || event.ctrlKey || event.metaKey;
      if (nearby) {
        const ids = new Set(this.selectedIds);
        if (additive && !resizeEdge) {
          if (ids.has(nearby.id)) ids.delete(nearby.id);
          else ids.add(nearby.id);
          this.setSelection([...ids], nearby.id);
        } else if (!ids.has(nearby.id)) this.setSelection([nearby.id], nearby.id);
        else this.selected = nearby.id;
        if (!this.selectedIds.has(nearby.id)) return;
      } else if (!additive) this.setSelection([]);
      this.preview?.pause();
      this.gesture = {
        pointer: event.pointerId,
        base: chart,
        rect,
        map,
        startSeconds: this.windowStart,
        span: this.secondsPerScreen,
        laneStart: this.laneStart,
        laneSpan,
        x: event.clientX,
        y: event.clientY,
        endX: event.clientX,
        endY: event.clientY,
        tick: map.secondsToTick(seconds),
        lane: pointerLane,
        kind: this.tool === "brush" ? "brush" : nearby ? (resizeEdge ?? "move") : "box",
        resizeWidth: hitNode?.size,
        resizeId: nearby?.id,
        ids: new Set(this.selectedIds),
        previous,
        primary,
        additive,
        moved: this.tool === "brush",
        deltaTick: 0,
        deltaLane: 0,
        mergeKey: createProjectId("gesture"),
      };
      canvas.setPointerCapture(event.pointerId);
      if (this.tool === "brush") this.applyGesture();
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
  private setSelection(ids: string[], primary = ids[0] ?? "") {
    const unique = [...new Set(ids)];
    if (unique.length !== this.selectedIds?.size || unique.some((id) => !this.selectedIds.has(id)))
      this.selectedIds = new Set(unique);
    this.selected = this.selectedIds.has(primary) ? primary : (ids[0] ?? "");
  }
  private pruneSelection() {
    const ids = new Set(chartSelectionNodes(this.chart).map((item) => item.note.id));
    this.setSelection(
      [...this.selectedIds].filter((id) => ids.has(id)),
      this.selected,
    );
  }
  private moveGesture(event: PointerEvent) {
    const gesture = this.gesture;
    if (!gesture) return;
    gesture.endX = event.clientX;
    gesture.endY = event.clientY;
    gesture.moved ||= Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) >= 5;
    if (!gesture.moved) return;
    if (!this.gestureFrame)
      this.gestureFrame = requestAnimationFrame(() => {
        this.gestureFrame = 0;
        this.applyGesture();
      });
  }
  private applyGesture() {
    const g = this.gesture;
    if (!g || !g.moved) return;
    const seconds = g.startSeconds + (1 - (g.endY - g.rect.top) / g.rect.height) * g.span;
    const tick = g.map.secondsToTick(seconds),
      lane = g.laneStart + ((g.endX - g.rect.left) / g.rect.width) * g.laneSpan;
    if (g.kind === "brush") {
      const node = chartSelectionNodes(g.base).find(
        (item) =>
          Math.abs(g.map.tickToSeconds(item.note.tick) - seconds) < Math.max(0.04, (12 * g.span) / g.rect.height) &&
          lane >= item.lane &&
          lane <= item.lane + Math.max(item.size, 0.6),
      );
      if (node) {
        g.ids.add(node.note.id);
        g.candidate = brushChartSelection(g.base, g.ids, {
          ...this.brushPreset,
          size: this.defaultWidth,
          critical: this.critical,
          direction: this.brushPreset.type === "flick" ? this.direction : "none",
        });
      }
    } else if (g.kind === "box") {
      const ids = chartSelectionInBox(g.base, g.tick, tick, g.lane, lane);
      this.setSelection(g.additive ? [...new Set([...g.previous, ...ids])] : ids);
    } else if (g.kind === "resize-left" || g.kind === "resize-right") {
      const delta = Math.round((lane - g.lane) * 4) / 4;
      const size = Math.max(
        0,
        Math.min(g.base.laneBasis, (g.resizeWidth ?? 0) + (g.kind === "resize-left" ? -delta : delta)),
      );
      try {
        g.candidate = resizeChartSelection(g.base, new Set([g.resizeId ?? g.primary]), size, {
          anchor: g.kind === "resize-left" ? "right" : "left",
          resolveAutoLane: true,
        });
      } catch {
        this.error = this.t("creation.invalid_edit");
      }
    } else {
      const anchor = chartSelectionNodes(g.base).find((item) => item.note.id === (g.resizeId ?? g.primary));
      const anchorTick = anchor?.note.tick ?? g.tick;
      const deltaTick = this.relativeSnap
        ? snapTick(tick - g.tick, this.snap)
        : snapTick(anchorTick + tick - g.tick, this.snap) - anchorTick;
      const laneStep = 1,
        deltaLane = this.relativeSnap
          ? Math.round((lane - g.lane) / laneStep) * laneStep
          : Math.round(((anchor?.lane ?? g.lane) + lane - g.lane) / laneStep) * laneStep - (anchor?.lane ?? g.lane);
      if (deltaTick !== g.deltaTick || deltaLane !== g.deltaLane) {
        try {
          const candidate = moveChartSelection(g.base, g.ids, deltaTick, deltaLane);
          assertValidProject(candidate);
          g.candidate = candidate;
          g.deltaTick = deltaTick;
          g.deltaLane = deltaLane;
        } catch {}
      }
    }
    this.paint();
  }
  private cancelGesture() {
    const g = this.gesture;
    if (!g) return;
    cancelAnimationFrame(this.gestureFrame);
    this.gestureFrame = 0;
    this.gesture = undefined;
    this.setSelection(g.previous, g.primary);
    const canvas = this.querySelector<HTMLCanvasElement>(".chart-creation__editor");
    if (canvas?.hasPointerCapture(g.pointer)) canvas.releasePointerCapture(g.pointer);
    this.paint();
  }
  private endGesture(event: PointerEvent) {
    const g = this.gesture;
    if (!g) return;
    if (event.type !== "pointerup") {
      this.cancelGesture();
      return;
    }
    g.endX = event.clientX;
    g.endY = event.clientY;
    cancelAnimationFrame(this.gestureFrame);
    this.gestureFrame = 0;
    this.applyGesture();
    if (this.gesture !== g) return;
    this.gesture = undefined;
    if (g.kind !== "box" && g.candidate) {
      const revision = this.history.revision;
      this.history.replace(g.candidate, { mergeKey: g.mergeKey });
      this.history.endMerge();
      if (this.history.revision !== revision) {
        this.dirty = true;
        this.status = "";
        this.error = "";
        this.rebuildPreview();
      }
    }
    const canvas = event.currentTarget as HTMLCanvasElement;
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    this.paint();
    this.requestUpdate();
  }
  private place(tick: number, lane: number) {
    const chart = this.chart;
    const base = (at: number, position: number, size = this.defaultWidth): SingleNote =>
      createAuthoredNote(chart, {
        tick: at,
        lane: position,
        size,
        type: this.tool === "flick" ? "flick" : this.tool === "trace" ? "trace" : "tap",
        direction: this.tool === "flick" ? this.direction : "none",
        critical: this.critical,
      });
    if (this.tool === "hold" || this.tool === "guide") {
      if (!this.pending) {
        this.pending = { tick, lane, size: this.defaultWidth };
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
          points: [base(start.tick, start.lane, start.size), base(tick, lane)].map((n) => ({
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
    if (
      this.gesture &&
      (Math.abs(width - this.gesture.rect.width) > 1 || Math.abs(height - this.gesture.rect.height) > 1)
    ) {
      this.cancelGesture();
      return;
    }
    if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
    }
    const ctx = canvas.getContext("2d");
    if (!ctx || !width || !height) return;
    const style = getComputedStyle(this),
      color = (name: string) => style.getPropertyValue(`--md-sys-color-${name}`).trim();
    const chart = this.gesture?.candidate ?? this.widthSession?.candidate ?? this.chart,
      map = this.map(),
      laneSpan = chart.laneBasis / this.zoomX,
      x = (lane: number) => ((lane - this.laneStart) / laneSpan) * width,
      w = (size: number) => (size / laneSpan) * width,
      y = (tick: number) =>
        timeToViewportY(map.tickToSeconds(tick), {
          startSeconds: this.windowStart,
          pixelsPerSecond: height / this.secondsPerScreen,
          height,
        });
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    const fullStageWidth=width*this.zoomX;
    if(this.canvasTheme){
      ctx.fillStyle=color("scrim");ctx.fillRect(0,0,width,height);
      drawChartCanvasLanePlane(ctx,{centerX:x(chart.laneBasis/2),height,laneWidth:fullStageWidth/6,styleLaneWidth:24,bandCount:6,spaceCount:3});
    } else {ctx.fillStyle=color("surface-container");ctx.fillRect(0,0,width,height);}
    ctx.strokeStyle=this.canvasTheme?.assets.palette.laneLine??color("outline-variant");ctx.lineWidth=1;
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
      if (Math.abs(beat - Math.round(beat)) < 0.001) {
        ctx.globalAlpha = 1;
        ctx.fillStyle = this.canvasTheme?.assets.palette.outsideLine ?? color("on-surface-variant");
        ctx.font = `11px ${style.getPropertyValue("--app-font").trim() || "sans-serif"}`;
        ctx.fillText(String(Math.round(beat)), 4, at - 14);
      }
    }
    ctx.globalAlpha = 0.3;
    ctx.fillStyle = this.canvasTheme?.assets.palette.outsideLine ?? color("secondary");
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
    const projection=this.flatProjection(chart);
    const skin=this.canvasTheme?.skin;
    const nativeY=(timeMs:number)=>timeToViewportY(timeMs/1000+chart.audioOffset,{startSeconds:this.windowStart,pixelsPerSecond:height/this.secondsPerScreen,height});
    const scale=skin?.scaleForFlatNoteBodyHeight(fullStageWidth,18)??1;
    if(skin&&projection){
      const native=projection.chart, byId=new Map(native.notes.map(note=>[note.id,note]));
      const styles={slide:createChartCanvasRibbonStyle(ctx,"slide",height,24),guide:createChartCanvasRibbonStyle(ctx,"guide",height,24)};
      for(const line of native.lines){
        const points=line.noteIds.map(id=>byId.get(id)).filter((note):note is ChartNote=>Boolean(note)&&note!.indexInLine!==null).sort((a,b)=>a.timeMs-b.timeMs||a.id-b.id);
        for(let i=1;i<points.length;i++){
          const head=points[i-1],tail=points[i];
          const start=Math.max(head.timeMs,(this.windowStart-chart.audioOffset)*1000),end=Math.min(tail.timeMs,(this.windowStart+this.secondsPerScreen-chart.audioOffset)*1000);
          if(end<=start)continue;
          const steps=Math.max(2,Math.ceil((end-start)/25)),samples=[];
          for(let step=0;step<=steps;step++){const time=start+(end-start)*step/steps,shape=interpolateNoteLine(head,tail,time);samples.push({left:x(shape.pos/24*chart.laneBasis),right:x((shape.pos+shape.size)/24*chart.laneBasis),y:nativeY(time)})}
          drawChartCanvasRibbon(ctx,samples,line.kind==="guide"?styles.guide:styles.slide,.6);
        }
      }
      for(const note of native.notes){
        const at=nativeY(note.timeMs);if(!note.visible||at < -32 || at > height+32)continue;
        const appearance=ourNotesCreationCanvasNoteAppearance(note);
        skin.drawFlatNote(ctx,{kind:appearance.kind,direction:appearance.direction,centerX:x((note.pos+note.size/2)/24*chart.laneBasis),centerY:at,width:Math.max(.5,w(note.size/24*chart.laneBasis)),laneSpan:note.size,stageWidth:fullStageWidth,scale});
      }
    }
    const overlay=(n:SingleNote|LinePoint,lane:number,size:number,kind:RenderNoteKind="tap")=>{
      const at=y(n.tick);if(at < -24 || at > height+24)return;
      if(skin&&!projection&&n.visible)skin.drawFlatNote(ctx,{kind:n.type==="flick"?(n.direction==="left"?"flick-left":n.direction==="right"?"flick-right":"flick"):n.type==="trace"?"trace":kind,direction:n.direction,centerX:x(lane+size/2),centerY:at,width:Math.max(.5,w(size)),laneSpan:size/chart.laneBasis*24,stageWidth:fullStageWidth,scale});
      if(!n.visible){ctx.save();ctx.strokeStyle=this.canvasTheme?.assets.palette.outsideLine??color("on-surface-variant");ctx.globalAlpha=.5;ctx.setLineDash([3,3]);ctx.strokeRect(x(lane),at-7,Math.max(2,w(size)),14);ctx.restore();}
      if(this.selectedIds.has(n.id)){
        ctx.strokeStyle=this.canvasTheme?.assets.palette.outsideLine??color("on-surface");ctx.lineWidth=2;ctx.strokeRect(x(lane)-1,at-12,Math.max(2,w(size))+2,24);
        ctx.fillStyle=this.canvasTheme?.assets.palette.outsideLine??color("on-surface");
        for(const edge of [lane,lane+size]){ctx.beginPath();ctx.roundRect(x(edge)-3,at-15,6,30,3);ctx.fill();}
      }
    };
    for(const line of chart.lines)line.points.forEach((note,i)=>{const shape=resolveLinePointShape(line.points,i);overlay(note,shape.lane,shape.size,line.kind==="guide"?"guide":i===0?"slide-start":i===line.points.length-1?"slide-end":"slide-node")});
    for(const note of chart.singles)overlay(note,note.lane,note.size);
    if (this.gesture?.kind === "box" && this.gesture.moved) {
      const g = this.gesture,
        x = Math.min(g.x, g.endX) - g.rect.left,
        y = Math.min(g.y, g.endY) - g.rect.top,
        w = Math.abs(g.endX - g.x),
        h = Math.abs(g.endY - g.y);
      ctx.globalAlpha = 0.15;
      ctx.fillStyle = color("primary");
      ctx.fillRect(x, y, w, h);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = color("primary");
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 4]);
      ctx.strokeRect(x, y, w, h);
      ctx.setLineDash([]);
    }
    const playhead = timeToViewportY(this.seconds, {startSeconds:this.windowStart,pixelsPerSecond:height/this.secondsPerScreen,height});
    if (playhead >= 0 && playhead <= height) {
      ctx.strokeStyle = color("primary");ctx.lineWidth=1.5;ctx.beginPath();ctx.moveTo(0,playhead);ctx.lineTo(width,playhead);ctx.stroke();
      ctx.fillStyle=color("primary");ctx.beginPath();ctx.moveTo(0,playhead-5);ctx.lineTo(8,playhead);ctx.lineTo(0,playhead+5);ctx.closePath();ctx.fill();
    }
    if (this.pending) {
      ctx.strokeStyle = color("tertiary");
      ctx.lineWidth = 3;
      ctx.strokeRect(x(this.pending.lane), y(this.pending.tick) - 5, w(this.pending.size), 10);
    }
  }
  private cancelOperation() {
    this.controller?.abort();
    if (this.stageMode === "preview") {
      void this.disposeNative().then(() => {
        if (!this.isConnected) return;
        this.stageMode = "edit";
        this.rebuildPreview(this.seconds);
      });
    }
  }
  private commitProject(candidate: Project) {
    if (this.busy || this.gesture) return;
    this.cancelWidth();
    const revision = this.history.revision;
    this.history.replace(candidate);
    if (revision === this.history.revision) return;
    this.pruneSelection();
    this.dirty = true;
    this.status = "";
    this.error = "";
    this.rebuildPreview();
    this.requestUpdate();
  }
  private cutSelection() {
    if (this.busy || this.gesture || !this.selectedIds.size) return;
    const value = cutChartSelection(this.chart, this.selectedIds);
    this.clipboard = value.clipboard;
    this.commitProject(value.project);
  }
  private copyBrush() {
    const node = chartSelectionNodes(this.chart).find((item) => item.note.id === this.selected);
    if (!node) return;
    this.brushPreset = {
      type: node.note.type,
      direction: node.note.direction,
      critical: node.note.critical,
      visible: node.note.visible,
      ...("ease" in node.note ? { ease: { ...node.note.ease } } : {}),
    };
    this.defaultWidth = Math.min(this.chart.laneBasis, node.size);
    this.critical = node.note.critical;
    this.direction = node.note.direction === "none" ? "up" : node.note.direction;
    this.tool = "brush";
  }
  private generateSelectedNodes() {
    if (this.busy || this.gesture) return;
    const project = this.chart,
      lines = new Set(
        project.lines
          .filter((line) => line.points.some((note) => this.selectedIds.has(note.id)))
          .map((line) => line.id),
      );
    const result = generateLinePoints(project, lines, this.snap);
    this.commitProject(result.project);
    this.setSelection(result.created);
    this.requestUpdate();
  }
  private async newProject() {
    await this.run(async (signal) => {
      await this.save();
      signal.throwIfAborted();
      await this.disposeNative();
      this.preview?.dispose();
      this.preview = undefined;
      this.audio = undefined;
      const project = createEmptyProject({ source: "authored" });
      this.history.reset(project);
      this.original = structuredClone(project);
      this.source = undefined;
      this.previewIdentity = undefined;
      this.projectId = crypto.randomUUID();
      this.head = 0;
      this.activeRevision = 0;
      this.revisions = [];
      this.setSelection([]);
      this.pending = undefined;
      this.windowStart = 0;
      this.seconds = 0;
      this.dirty = false;
      this.stageMode = "edit";
      this.requestUpdate();
    });
  }
  private async toggleFullscreen() {
    try {
      if (document.fullscreenElement === this) await document.exitFullscreen();
      else await this.requestFullscreen();
    } catch {
      this.error = this.c("unavailable");
    }
  }
  private nativeLabel(key: string) {
    return this.c(`chartPlayer.${key}`);
  }
  private async applyNativeSkin(patch: ChartSkin) {
    if (this.busy) return;
    const skin = { ...this.nativeSkin, ...patch };
    await this.run(async (signal) => {
      await this.nativePreview?.setSkin(skin);
      signal.throwIfAborted();
      this.nativeSkin = skin;
      this.requestUpdate();
    });
  }
  private renderNativeSettings() {
    const settings = { ...DEFAULT_RENDER_SETTINGS, ...this.nativeOptions.settings };
    const slider = (
      label: string,
      value: number,
      min: number,
      max: number,
      step: number,
      change: (value: number) => void,
    ) => html`
      <label class="chart-studio__setting">
        <span>
          ${label}
          <output>${Math.round(value * 100) / 100}</output>
        </span>
        <md-slider
          class="md3-slider"
          labeled
          aria-label=${label}
          .min=${min}
          .max=${max}
          .step=${step}
          .value=${value}
          ?disabled=${this.busy}
          @input=${(e: Event) => change(Number((e.target as HTMLElement & { value: number }).value))}
        ></md-slider>
      </label>
    `;
    const select = (
      label: string,
      value: string,
      rows: readonly { value: string; label: string }[],
      change: (value: string) => void,
    ) => html`
      <md-outlined-select
        label=${label}
        .value=${value}
        ?disabled=${this.busy}
        @change=${(e: Event) => change((e.target as HTMLElement & { value: string }).value)}
      >
        ${rows.map(
          (row) => html`
            <md-select-option value=${row.value} .selected=${row.value === value}>
              <div slot="headline">${row.label}</div>
            </md-select-option>
          `,
        )}
      </md-outlined-select>
    `;
    const toggle = (label: string, value: boolean, change: (value: boolean) => void) => html`
      <label>
        <md-checkbox
          aria-label=${label}
          .checked=${value}
          ?disabled=${this.busy}
          @change=${(e: Event) => change((e.target as HTMLInputElement).checked)}
        ></md-checkbox>
        ${label}
      </label>
    `;
    const changeSetting = (key: keyof typeof settings, value: number | boolean) =>
      void this.applyNativeOptions({
        settings: { ...DEFAULT_RENDER_SETTINGS, ...this.nativeOptions.settings, [key]: value },
      });
    return html`
      <div class="chart-creation__form">
        ${select(
        this.t("preview"),
        this.nativeMode,
        ["play", "watch", "chart"].map((value) => ({ value, label: this.t(`creation.preview_${value}`) })),
        (value) => {
          this.nativeMode = value as typeof this.nativeMode;
          void this.applyNativeOptions({ mode: this.nativeMode });
        },
      )}
        ${slider(this.nativeLabel("volume"), this.nativeOptions.volume ?? 0.82, 0, 1, 0.01, (value) => void this.applyNativeOptions({ volume: value }))}
        ${toggle(this.nativeLabel("noteSe"), this.nativeOptions.noteSoundEnabled ?? true, (value) => void this.applyNativeOptions({ noteSoundEnabled: value }))}
        ${slider(this.nativeLabel("noteSe"), this.nativeOptions.noteSoundVolume ?? 0.75, 0, 1, 0.01, (value) => void this.applyNativeOptions({ noteSoundVolume: value }))}
        ${select(
        this.nativeLabel("playbackSpeed"),
        String(this.rate),
        [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2].map((value) => ({ value: String(value), label: `${value}×` })),
        (value) => {
          this.rate = Number(value);
          void this.applyNativeOptions({ rate: this.rate });
        },
      )}
        ${toggle(this.nativeLabel("loop"), this.nativeOptions.loop ?? false, (value) => void this.applyNativeOptions({ loop: value }))}
        ${select(
        this.nativeLabel("noteSkin"),
        this.nativeSkin.noteSkin ?? "skin001",
        OUR_NOTES_NOTE_SKINS.map((value) => ({
          value,
          label: OUR_NOTES_NOTE_SKIN_NAMES[value][this.locale] ?? OUR_NOTES_NOTE_SKIN_NAMES[value].en,
        })),
        (value) => void this.applyNativeSkin({ noteSkin: value as ChartSkin["noteSkin"] }),
      )}
        ${select(
        this.nativeLabel("noteEffectSkin"),
        this.nativeSkin.noteEffectSkin ?? "effect001",
        OUR_NOTES_NOTE_EFFECT_SKINS.map((value) => ({
          value,
          label: OUR_NOTES_NOTE_EFFECT_SKIN_NAMES[value][this.locale] ?? OUR_NOTES_NOTE_EFFECT_SKIN_NAMES[value].en,
        })),
        (value) => void this.applyNativeSkin({ noteEffectSkin: value as ChartSkin["noteEffectSkin"] }),
      )}
        ${select(
        this.nativeLabel("noteSe"),
        String(this.nativeSkin.noteSeGroup ?? 1),
        OUR_NOTES_NOTE_SE_GROUP_IDS.map((value) => ({
          value: String(value),
          label: OUR_NOTES_NOTE_SE_GROUP_NAMES[value][this.locale] ?? OUR_NOTES_NOTE_SE_GROUP_NAMES[value].en,
        })),
        (value) => void this.applyNativeSkin({ noteSeGroup: Number(value) as ChartSkin["noteSeGroup"] }),
      )}
        ${select(
        this.nativeLabel("liveQuality"),
        String(this.nativeSkin.currentQuality ?? 2),
        OUR_NOTES_LIVE_QUALITIES.map((value) => ({
          value: String(value),
          label: OUR_NOTES_LIVE_QUALITY_NAMES[value][this.locale] ?? OUR_NOTES_LIVE_QUALITY_NAMES[value].en,
        })),
        (value) => void this.applyNativeSkin({ currentQuality: Number(value) as ChartSkin["currentQuality"] }),
      )}
        ${slider(this.nativeLabel("noteSpeed"), settings.noteSpeed, 1, 12, 0.1, (value) => changeSetting("noteSpeed", value))}
        ${slider(this.nativeLabel("longOpacity"), settings.longAlpha, 0, 1, 0.05, (value) => changeSetting("longAlpha", value))}
        ${slider(this.nativeLabel("guideOpacity"), settings.guideAlpha, 0, 1, 0.05, (value) => changeSetting("guideAlpha", value))}
        ${slider(this.nativeLabel("backgroundBrightness"), settings.backgroundBrightness, 0, 1, 0.05, (value) => changeSetting("backgroundBrightness", value))}
        ${slider(this.nativeLabel("laneOpacity"), settings.laneOpacity, 0, 1, 0.05, (value) => changeSetting("laneOpacity", value))}
        ${slider(this.nativeLabel("guidelineOpacity"), settings.guidelineOpacity, 0, 1, 0.05, (value) => changeSetting("guidelineOpacity", value))}
        ${toggle(this.nativeLabel("mirror"), settings.mirror, (value) => changeSetting("mirror", value))}
        ${toggle(this.nativeLabel("effects"), settings.effects, (value) => changeSetting("effects", value))}
        ${toggle(this.nativeLabel("judgementLine"), settings.showJudgementLine, (value) => changeSetting("showJudgementLine", value))}
        ${toggle(this.nativeLabel("simultaneousLine"), settings.showSimultaneousLine, (value) => changeSetting("showSimultaneousLine", value))}
      </div>
    `;
  }
  private setDefaultWidth(value: number) {
    if (!Number.isFinite(value) || value < 0 || value > this.chart.laneBasis) {
      this.error = this.t("creation.invalid_edit");
      return;
    }
    this.defaultWidth = value;
    this.error = "";
  }
  private previewWidth(value: number) {
    if (this.widthCancelled || this.busy || this.gesture || !this.selected) return;
    this.widthSession ??= { base: this.chart, id: this.selected };
    try {
      this.widthSession.candidate = resizeChartSelection(
        this.widthSession.base,
        new Set([this.widthSession.id]),
        value,
        { placement: "authored", resolveAutoLane: true },
      );
      this.paint();
    } catch {
      this.widthSession.candidate = undefined;
      this.error = this.t("creation.invalid_edit");
    }
  }
  private commitWidth(value: number) {
    if (this.widthCancelled || this.busy || this.gesture || !this.selected) return;
    this.previewWidth(value);
    const candidate = this.widthSession?.candidate;
    this.widthSession = undefined;
    if (candidate) {
      const revision = this.history.revision;
      this.history.replace(candidate);
      this.history.endMerge();
      if (this.history.revision !== revision) {
        this.dirty = true;
        this.error = "";
        this.status = "";
        this.rebuildPreview();
      }
    }
    this.paint();
    this.requestUpdate();
  }
  private cancelWidth() {
    if (!this.widthSession) return;
    this.widthSession = undefined;
    this.paint();
    this.requestUpdate();
  }
  private widthControl(value: number, selected = false) {
    const label = selected ? this.t("width") : this.t("creation.default_width");
    const maximum = Math.max(this.chart.laneBasis, value);
    return html`
      <div class="chart-studio__width" data-width-kind=${selected ? "selection" : "default"}>
        <label>
          <span>${label}</span>

        </label>
        <md-slider
          class="md3-slider"
          aria-label=${label}
          labeled
          min="0"
          max=${maximum}
          step="0.25"
          .value=${value}
          ?disabled=${this.busy || !this.audio}
          @pointerdown=${() => {
          this.widthCancelled = false;
        }}
          @keydown=${(event: KeyboardEvent) => {
          if (event.key === "Escape") {
            event.preventDefault();
            this.widthCancelled = true;
            this.cancelWidth();
          } else this.widthCancelled = false;
        }}
          @input=${(event: Event) => {
          const size = Number((event.target as HTMLInputElement).value);
          selected ? this.previewWidth(size) : this.setDefaultWidth(size);
        }}
          @change=${(event: Event) => {
          if (selected) this.commitWidth(Number((event.target as HTMLInputElement).value));
        }}
          @pointercancel=${() => {
          this.widthCancelled = true;
          this.cancelWidth();
        }}
        ></md-slider>
        <md-outlined-text-field
          aria-label=${label}
          type="number"
          min="0"
          step="any"
          .value=${live(String(value))}
          ?disabled=${this.busy || !this.audio}
          @change=${(event: Event) => {
          const raw = (event.target as HTMLInputElement).value;
          const size = raw.trim() ? Number(raw) : NaN;
          this.widthCancelled = false;
          selected ? this.commitWidth(size) : this.setDefaultWidth(size);
        }}
        ></md-outlined-text-field>
      </div>
    `;
  }
  private closePanels() {
    this.cancelWidth();
    this.leftOpen = this.rightOpen = false;
  }
  private togglePanel(side: "left" | "right") {
    this.cancelGesture();
    this.cancelWidth();
    if (side === "left") {
      this.leftOpen = !this.leftOpen;
      if (this.narrow) this.rightOpen = false;
    } else {
      this.rightOpen = !this.rightOpen;
      if (this.narrow) this.leftOpen = false;
    }
  }
  private renderAppActions() {
    return html`
      <span class="chart-studio__wide-actions">
        ${iconButton({ label: this.t("project"), icon: "folder_open", toggle: true, pressed: this.leftOpen, onClick: () => this.togglePanel("left") })}
        ${iconButton({
          label: this.t("undo"),
          icon: "undo",
          disabled: this.busy || !this.history.canUndo,
          onClick: () => {
            this.cancelGesture();
            this.history.undo();
            this.pruneSelection();
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
            this.cancelGesture();
            this.history.redo();
            this.pruneSelection();
            this.dirty = true;
            this.rebuildPreview();
            this.requestUpdate();
          },
        })}
        ${iconButton({ label: this.t("selection"), icon: "tune", toggle: true, pressed: this.rightOpen, onClick: () => this.togglePanel("right") })}
      </span>
      ${this.busy ? iconButton({ label: this.c("cancel"), icon: "close", onClick: () => this.cancelOperation() }) : nothing}
      ${iconButton({ label: this.t("creation.save"), className: "chart-studio__header-save", icon: "save", disabled: this.busy || !this.audio || !this.dirty, onClick: () => void this.run(() => this.save()) })}
      ${iconButton({ label: this.t(this.stageMode === "preview" ? "edit" : "preview"), className: "chart-studio__preview-header", icon: this.stageMode === "preview" ? "edit" : "play_circle", toggle: true, pressed: this.stageMode === "preview", disabled: this.busy || !this.audio, onClick: () => void this.switchStage() })}
    `;
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
    const filesPanel = html`
      <div class="chart-creation__actions">
        <button class="button" ?disabled=${this.busy} @click=${() => void this.newProject()}>
          ${this.t("newProject")}
        </button>
        <button class="button button--tonal" ?disabled=${this.busy} @click=${() => this.showLibrary()}>
          ${this.t("serverLibrary")}
        </button>
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
    `;
    const audioPanel = html`
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
    `;
    const selectionPanel = html`
      ${
        selection
          ? html`
              <section class="chart-creation__form" aria-label=${this.t("selection")}>
                ${this.widthControl(chartSelectionNodes(chart).find((item) => item.note.id === selection.id)?.size ?? selection.size, true)}
                <div class="chart-creation__actions">
                  <button
                    class="button button--text"
                    type="button"
                    ?disabled=${this.busy}
                    @click=${() => this.cutSelection()}
                  >
                    ${this.t("creation.cut")}
                  </button>
                  ${iconButton({ label: this.t("creation.flip"), icon: "swap_horiz", disabled: this.busy, onClick: () => this.commitProject(flipChartSelection(this.chart, this.selectedIds)) })}
                  ${iconButton({ label: this.t("creation.copy_brush"), icon: "format_paint", disabled: this.busy, onClick: () => this.copyBrush() })}
                  ${"ease" in selection ? iconButton({ label: this.t("creation.generate_nodes"), icon: "add", disabled: this.busy, onClick: () => this.generateSelectedNodes() }) : nothing}
                </div>
                <button
                  class="button"
                  ?disabled=${this.busy}
                  @click=${() => {
                    this.clipboard = copyChartSelectionGroup(this.chart, this.selectedIds);
                    this.requestUpdate();
                  }}
                >
                  ${this.t("creation.copy")}
                </button>
                <button
                  class="button"
                  ?disabled=${this.busy}
                  @click=${() => this.edit((p) => deleteChartSelectionGroup(p, this.selectedIds))}
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
                      <md-select-option value=${type} .selected=${type === selection.type}>
                        <div slot="headline">${this.t(type)}</div>
                      </md-select-option>
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
    `;
    const projectPanel = html`
      ${accordion({
        id: "chart-creation-project",
        label: this.t("inspector"),
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
            ${this.field("difficulty", chart.meta.difficulty, (value) =>
              this.edit((p) => {
                p.meta.difficulty = value;
              }),
            )}
            ${this.field("level", chart.meta.level, (value) =>
              this.edit((p) => {
                p.meta.level = value;
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
    `;
    const defaultsPanel = html`
      ${accordion({
        id: "chart-creation-tool",
        label: this.t("currentTool"),
        expanded: this.toolExpanded,
        onExpandedChange: (value) => {
          this.toolExpanded = value;
          this.requestUpdate();
        },
        content: html`
          <div class="chart-creation__form">
            ${this.widthControl(this.defaultWidth)}
            ${this.field(
              "lane",
              this.insertLane,
              (value) => {
                this.insertLane = Math.max(0, Math.min(chart.laneBasis - this.defaultWidth, Number(value)));
                this.requestUpdate();
              },
              true,
            )}
            <button
              class="button"
              ?disabled=${this.busy || !this.audio || ["select", "erase", "pan", "brush"].includes(this.tool)}
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
    `;
    const warningsPanel = html`
      ${
        this.exportWarnings().length
          ? html`
              <ul aria-label=${this.t("warnings")}>
                ${this.exportWarnings().map(
                  (warning) => html`
                    <li>${this.t(`creation.export_${warning.code.split(".").at(-1)}`)}</li>
                  `,
                )}
              </ul>
            `
          : nothing
      }
    `;
    const timingPanel = html`
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
    `;
    const versionsPanel = html`
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
    const viewControls = html`
      <div class="chart-creation__form">
        <label class="chart-studio__setting">
          <span>
            ${this.t("creation.zoom_x")}
            <output>${this.zoomX.toFixed(1)}×</output>
          </span>
          <md-slider
            class="md3-slider"
            min="1"
            max="8"
            step="0.1"
            .value=${this.zoomX}
            aria-label=${this.t("creation.zoom_x")}
            @input=${(event: Event) => this.setHorizontalZoom(Number((event.target as HTMLInputElement).value))}
          ></md-slider>
        </label>
        <button
          class="button button--text"
          ?disabled=${this.busy}
          @click=${() => {
          this.setHorizontalZoom(1);
          this.windowStart = 0;
          this.secondsPerScreen = 4;
          this.requestUpdate();
        }}
        >
          ${this.t("resetView")}
        </button>
        <md-outlined-text-field
          label=${this.t("creation.custom_division")}
          type="number"
          min="1"
          max=${chart.resolution}
          step="1"
          .value=${live(String(this.snap))}
          ?disabled=${this.busy}
          @change=${(event: Event) => {
            const value = Number((event.target as HTMLInputElement).value);
            if (Number.isSafeInteger(value) && value >= 1 && value <= chart.resolution) {
              this.snap = value;
              this.error = "";
              this.requestUpdate();
            } else this.error = this.t("creation.invalid_edit");
          }}
        ></md-outlined-text-field>
        ${segmented({
          label: this.t("snap"),
          value: this.relativeSnap ? "relative" : "absolute",
          options: [
            { value: "absolute", label: this.t("creation.snap_absolute") },
            { value: "relative", label: this.t("creation.snap_relative") },
          ],
          onSelect: (value) => {
            if (!this.busy) {
              this.cancelGesture();
              this.relativeSnap = value === "relative";
            }
          },
        })}
        <md-outlined-select
          label=${this.t("snap")}
          .value=${String(this.snap)}
          ?disabled=${this.busy}
          @change=${(e: Event) => {
            this.snap = Number((e.target as HTMLSelectElement).value);
            this.requestUpdate();
          }}
        >
          ${[...new Set([1, 2, 3, 4, 6, 8, 12, 16, this.snap])]
            .sort((a, b) => a - b)
            .map(
              (value) => html`
                <md-select-option value=${String(value)}><div slot="headline">1/${value}</div></md-select-option>
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
            void this.applyNativeOptions({ rate: this.rate });
          }}
        >
          ${[0.25, 0.5, 0.75, 1, 1.25, 1.5, 2].map(
            (value) => html`
              <md-select-option value=${String(value)}><div slot="headline">${value}×</div></md-select-option>
            `,
          )}
        </md-outlined-select>
      </div>
    `;
    const exportControls = html`
      <div class="chart-creation__form">
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
                  ? serializeSsForTarget(chart)
                  : this.exportFormat === "usc"
                    ? serializeUsc(chart, { wrapped: true })
                    : serializeProjectJson(chart);
              await downloadBlob(new Blob([content], { type: "application/json" }), `chart.${this.exportFormat}.json`);
            })}
        >
          ${this.t("creation.export_chart")}
        </button>
      </div>
    `;
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

      <chart-creation-library
        .locale=${this.locale as HaneokaLocale}
        .onImport=${this.libraryImport}
      ></chart-creation-library>
      <div class="chart-studio" data-stage=${this.stageMode} data-left=${String(this.leftOpen)} data-right=${String(this.rightOpen)}>
        <div class="chart-studio__toolbar">
          ${
            this.fullscreen
              ? html`
                  <div class="chart-studio__fullscreen-actions">
                    <span class="md-label-small">Beta</span>
                    ${this.renderAppActions()}
                  </div>
                `
              : nothing
          }
          <button
            class="icon-button chart-studio__drawer-button"
            type="button"
            aria-label=${this.t("project")}
            aria-controls="chart-studio-project"
            aria-expanded=${String(this.leftOpen)}
            @click=${() => this.togglePanel("left")}
          >
            ${icon("folder_open")}
          </button>
          <button
            class="chip chart-studio__width-preset"
            type="button"
            aria-label=${`${this.t("creation.default_width")} ${this.defaultWidth}`}
            @click=${() => {
            this.rightOpen = true;
            this.toolExpanded = true;
            if (this.narrow) this.leftOpen = false;
            void this.updateComplete.then(() =>
              requestAnimationFrame(() => this.querySelector<HTMLElement>('[data-width-kind="default"] md-slider')?.focus()),
            );
          }}
          >
            ${icon("swap_horiz", 18)}${this.defaultWidth}
          </button>
          ${iconButton({ label: this.t(this.stageMode === "preview" ? "edit" : "preview"), className: "chart-studio__preview-inline", icon: this.stageMode === "preview" ? "edit" : "play_circle", pressed: this.stageMode === "preview", disabled: this.busy || !this.audio, onClick: () => void this.switchStage() })}
          <div class="chart-studio__zoom-y" role="group" aria-label=${this.t("creation.zoom_y")} ?hidden=${this.stageMode !== "edit"}>
            ${iconButton({ icon: "remove", label: `${this.t("creation.zoom_y")} −`, disabled: this.busy || !this.audio || Boolean(this.gesture) || this.secondsPerScreen >= 16,
              onClick: () => this.setVerticalZoom(this.secondsPerScreen * 2) })}
            <span title=${this.t("creation.zoom_y")}>${icon("height", 18)}<output>${Number((4 / this.secondsPerScreen).toFixed(2))}×</output></span>
            ${iconButton({ icon: "add", label: `${this.t("creation.zoom_y")} +`, disabled: this.busy || !this.audio || Boolean(this.gesture) || this.secondsPerScreen <= 0.5,
              onClick: () => this.setVerticalZoom(this.secondsPerScreen / 2) })}
          </div>
          <span class="chart-studio__preview-mode" ?hidden=${this.stageMode !== "preview"}>${this.t(`creation.preview_${this.nativeMode}`)}</span>
          <div class="chart-studio__tools">
            <div class="chart-creation__actions">
              ${segmented({
          label: this.t("currentTool"),
          value: this.tool,
          options: ["select", "tap", "flick", "trace", "hold", "guide", "erase", "pan", "brush"].map((value) => ({
            value,
            label: this.t(value === "brush" ? "creation.brush" : value),
            icon: (
              {
                brush: "format_paint",
                select: "center_focus_strong",
                tap: "music_note",
                flick: "north_east",
                trace: "circle",
                hold: "horizontal_rule",
                guide: "trending_up",
                erase: "delete",
                pan: "pan_tool",
              } as Record<string, string>
            )[value],
          })),
          iconOnly: true,
          onSelect: (value) => {
            if (!this.busy) {
              this.cancelGesture();
              this.tool = value;
              this.pending = undefined;
            }
          },
        })}
              ${iconButton({
          label: this.t("creation.multi_select"),
          icon: "checklist",
          className: "chart-studio__multi",
          toggle: true,
          pressed: this.multiPick,
          disabled: this.busy,
          onClick: () => {
            this.multiPick = !this.multiPick;
          },
        })}
              <output aria-live="polite">
                ${clientText(this.locale, "chartEditorPage.selectedCount", undefined, { count: this.selectedIds.size })}
              </output>
              ${iconButton({
          label: this.t("undo"),
          icon: "undo",
          className: "chart-studio__history",
          disabled: this.busy || !this.history.canUndo,
          onClick: () => {
            this.cancelGesture();
            this.history.undo();
            this.pruneSelection();
            this.dirty = true;
            this.rebuildPreview();
            this.requestUpdate();
          },
        })}
              ${iconButton({
          label: this.t("redo"),
          icon: "redo",
          className: "chart-studio__history",
          disabled: this.busy || !this.history.canRedo,
          onClick: () => {
            this.cancelGesture();
            this.history.redo();
            this.pruneSelection();
            this.dirty = true;
            this.rebuildPreview();
            this.requestUpdate();
          },
        })}
            </div>
            <button
              class="button"
              ?disabled=${this.busy || !this.clipboard?.length || !this.audio}
              @click=${() =>
          this.edit((p) => {
            this.setSelection(
              pasteChartSelectionGroup(
                p,
                this.clipboard!,
                Math.max(0, snapTick(this.map().secondsToTick(this.seconds), this.snap)),
              ),
            );
          })}
            >
              ${this.t("creation.paste")}
            </button>
          </div>
          <button
            class="icon-button chart-studio__drawer-button"
            type="button"
            aria-label=${this.stageMode === "preview" ? this.c("chartPlayer.settings") : this.t("inspector")}
            aria-controls="chart-studio-inspector"
            aria-expanded=${String(this.rightOpen)}
            @click=${() => this.togglePanel("right")}
          >
            ${icon("tune")}
          </button>
        </div>
        <div class="chart-studio__messages">
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
        </div>
        <div class="chart-studio__body">
          ${
            this.narrow && (this.leftOpen || this.rightOpen)
              ? html`
                  <button
                    class="chart-studio__scrim"
                    type="button"
                    aria-label=${this.c("close")}
                    @click=${() => this.closePanels()}
                  ></button>
                `
              : nothing
          }
          <aside
            id="chart-studio-project"
            class="chart-studio__panel chart-studio__panel--left"
            ?hidden=${!this.leftOpen}
            role=${this.narrow ? "dialog" : "complementary"}
            aria-modal=${this.narrow ? "true" : nothing}
            aria-label=${this.t("project")}
          >
            <header>
              <strong>${this.t("project")}</strong>
              ${iconButton({ label: this.c("close"), icon: "close", onClick: () => this.togglePanel("left") })}
            </header>
            ${segmented({
              label: this.t("project"),
              value: this.projectTab,
              options: [
                { value: "project", label: this.t("project"), icon: "description" },
                { value: "files", label: this.t("file"), icon: "folder_open" },
                { value: "timing", label: this.t("timing"), icon: "schedule" },
              ],
              iconOnly: true,
              onSelect: (value) => {
                this.projectTab = value;
                this.requestUpdate();
              },
            })}
            <div class="chart-studio__panel-content">
              <div ?hidden=${this.projectTab !== "project"}>${projectPanel}${audioPanel}${versionsPanel}</div>
              <div ?hidden=${this.projectTab !== "files"}>${filesPanel}${exportControls}${warningsPanel}</div>
              <div ?hidden=${this.projectTab !== "timing"}>${timingPanel}</div>
            </div>
          </aside>
          <section
            class="chart-studio__stage"
            data-mode=${this.stageMode}
            aria-label=${this.t("edit")}
            ?inert=${this.narrow && (this.leftOpen || this.rightOpen)}
          >
            <canvas
              class="chart-creation__editor"
              ?hidden=${this.stageMode !== "edit"}
              role="img"
              aria-label=${this.t("edit")}
              tabindex="0"
              style=${["pan", "select", "brush"].includes(this.tool) ? "touch-action:none" : "touch-action:manipulation"}
              @pointerdown=${this.hit}
              @pointermove=${this.panMove}
              @pointerup=${this.panEnd}
              @pointercancel=${this.panEnd}
              @lostpointercapture=${this.panEnd}
              @wheel=${this.wheel}
            ></canvas>
            ${this.audio && this.stageMode === "edit" && (this.canvasLoading || this.canvasFailed) ? html`<div class="chart-studio__skin-state">${this.canvasLoading ? loadingState(this.c("loading"),{local:true}) : html`<button class="button button--tonal" @click=${()=>void this.ensureCanvasSkin(true)}>${this.c("retry")}</button>`}</div>` : nothing}
            <div data-native-preview class="chart-studio__native" ?hidden=${this.stageMode !== "preview"}></div>
            ${
              !this.audio
                ? html`
                    <div class="chart-studio__empty">
                      <button class="button button--tonal" ?disabled=${this.busy} @click=${() => this.showLibrary()}>
                        ${icon("library_music")}${this.t("serverLibrary")}
                      </button>
                      <strong>${this.t("project")}</strong>
                      <button
                        class="button button--filled"
                        ?disabled=${this.busy}
                        @click=${() => this.pick("[data-audio]")}
                      >
                        ${icon("library_music")}${this.t("importLocalAudio")}
                      </button>
                      <button
                        class="button button--text"
                        ?disabled=${this.busy}
                        @click=${() => this.loadAudio(createExampleAudio(), true)}
                      >
                        ${this.t("creation.example")}
                      </button>
                    </div>
                  `
                : nothing
            }
            <div class="chart-studio__timeline-position" ?hidden=${this.stageMode !== "edit"}>
              <md-slider
                class="md3-slider"
                aria-label=${this.t("creation.position")}
                min="0"
                max=${Math.max(0, (this.audio?.analysis.duration ?? 4) - this.secondsPerScreen)}
                step="0.1"
                .value=${this.windowStart}
                ?disabled=${this.busy || !this.audio}
                @input=${(event: Event) => {
              this.windowStart = Number((event.target as HTMLInputElement).value);
            }}
              ></md-slider>
            </div>
          </section>
          <aside
            id="chart-studio-inspector"
            class="chart-studio__panel chart-studio__panel--right"
            ?hidden=${!this.rightOpen}
            role=${this.narrow ? "dialog" : "complementary"}
            aria-modal=${this.narrow ? "true" : nothing}
            aria-label=${this.stageMode === "preview" ? this.c("chartPlayer.settings") : this.t("inspector")}
          >
            <header>
              <strong>
                ${this.stageMode === "preview" ? this.c("chartPlayer.settings") : this.t("inspector")}
              </strong>
              ${iconButton({ label: this.c("close"), icon: "close", onClick: () => this.togglePanel("right") })}
            </header>
            <div class="chart-studio__panel-content">
              ${
                this.stageMode === "preview"
                  ? this.renderNativeSettings()
                  : html`
                      ${selectionPanel}${defaultsPanel}${viewControls}
                      ${this.field(
                "beat",
                Math.round(this.map().secondsToBeat(this.seconds) * 100) / 100,
                (value) => {
                  if (Number.isFinite(Number(value)))
                    this.seekPlayback(Math.max(0, this.map().beatToSeconds(Number(value))));
                },
                true,
              )}
                      <button
                        class="button button--text"
                        type="button"
                        aria-pressed=${String(this.followPlayback)}
                        @click=${() => {
                this.followPlayback = !this.followPlayback;
                this.windowStart = this.clampStart(this.seconds - this.secondsPerScreen * 0.25);
              }}
                      >
                        ${this.t("creation.follow")}
                      </button>
                    `
              }
            </div>
          </aside>
        </div>
        <footer class="chart-studio__transport" ?inert=${this.narrow && (this.leftOpen || this.rightOpen)}>
          <button
            class="icon-button icon-button--filled"
            type="button"
            data-play
            aria-label=${this.c("play")}
            ?disabled=${this.busy || !this.audio}
            @click=${this.togglePlayback}
          >
            ${icon("play_arrow")}
          </button>
          <button
            class="icon-button"
            type="button"
            aria-label=${this.c("stop")}
            ?disabled=${this.busy || !this.audio}
            @click=${() => {
            this.pausePlayback();
            this.seekPlayback(0);
          }}
          >
            ${icon("stop")}
          </button>
          <md-slider
            class="md3-slider"
            data-playhead
            aria-label=${this.t("creation.position")}
            min="0"
            max=${this.audio?.analysis.duration || 1}
            step="0.01"
            .value=${this.seconds}
            ?disabled=${this.busy || !this.audio}
            @input=${(event: Event) => this.seekPlayback(Number((event.target as HTMLInputElement).value))}
          ></md-slider>
          <output data-time>0.00</output>
          ${iconButton({
            label: this.t("creation.follow"),
            className: "chart-studio__follow",
            icon: "center_focus_strong",
            toggle: true,
            pressed: this.followPlayback,
            disabled: this.busy || !this.audio,
            onClick: () => {
              this.followPlayback = !this.followPlayback;
              this.windowStart = this.clampStart(this.seconds - this.secondsPerScreen * 0.25);
            },
          })}
          ${iconButton({ label: this.c("fullscreen"), icon: this.fullscreen ? "fullscreen_exit" : "fullscreen", onClick: () => void this.toggleFullscreen() })}
        </footer>
      </div>
    `;
  }
}
if (!customElements.get("chart-creation-workspace"))
  customElements.define("chart-creation-workspace", ChartCreationWorkspace);
