// L3 — GEB
// Input: 本地／云端工程、GBP 歌曲导入地址、歌曲资料、音频与原生素材 release 身份。
// Output: 谱面与滑条结构编辑、精确定位、路标与游戏事件、图案／键位配置、编辑音频及原生统计、保存及社区发布；预览复用 chart-simulator。
// Pos: [Map](L2-2.md)；谱面创作工作区。
// Effects/Dependencies: IndexedDB、localStorage、媒体、Web Audio 与应用栏；消费导入地址并保存原工程，预览退出和断开时销毁查看器并释放素材 URL。
import "@lit-labs/ssr-client/lit-element-hydrate-support.js";
import { snackbar } from "../lib/snackbar";
import { LitElement, html, nothing, type PropertyValues } from "lit";
import { hydrateWorkspace as hydrate } from "./shared/hydrate-workspace";
import { readPageData } from "../lib/page-data";
import type { PublicSongsPageData } from "../server/tool-page-data";
import { buildChart, parseScore, DEFAULT_RENDER_SETTINGS, OUR_NOTES_NOTE_SE_GROUP_IDS, OUR_NOTES_NOTE_SE_GROUP_NAMES, type OurNotesNoteSeGroup } from "@haneoka/cassiopeia-plugin-our-notes";
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
  type NoteLine,
} from "../../packages/chart-editor/src/model";
import { TempoMap, meterAtTick, snapTick, parseBeatTick, type SnapMode } from "../../packages/chart-editor/src/timing";
import { importChart } from "../../packages/chart-editor/src/formats/detect";
import { assertValidProject } from "../../packages/chart-editor/src/validation";
import { ChartPatternStore, parseChartPattern, serializeChartPattern, type ChartPattern } from "../lib/chart-creation/patterns";
import { chartCreationTools as creationTools, chartSnapDivisions as snapDivisions, chartShortcutCommands, chartShortcutBindings,
  displayChartShortcut, matchChartShortcut, readChartShortcuts, shortcutForEvent, writeChartShortcuts,
  type ChartShortcutOverrides } from "../lib/chart-creation/shortcuts";
import { CreationStore, type CreationDocument, type CreationRevision } from "../lib/chart-creation/storage";
import { createExampleAudio, decodeCreationAudio, type CreationAudio } from "../lib/chart-creation/audio";
import { EditorAudioFeedback, DEFAULT_EDITOR_AUDIO, readEditorAudioSettings, writeEditorAudioSettings, type EditorAudioSettings } from "../lib/chart-creation/feedback";
import { MediaClock } from "@haneoka/cassiopeia-host-web";
import { clientText, initializeI18nClient } from "../i18n/client";
import { localizedFallbacks } from "../lib/localized-text";
import { beginLoading } from "../lib/loading-progress";
import { downloadBlob } from "../lib/canvas-capture";
import { iconButton, segmented } from "./ui/controls";
import { icon } from "./ui/icon";
import { trapFocus } from "../lib/overlay";
import { setAppBarActions, clearAppBarActions } from "../lib/app-bar";
import { accordion } from "./ui/accordion";
import "./chart-creation-library";
import "./chart-publication";
import type { ChartPublication } from "./chart-publication";
import { loadCommunityChart, readChartCloudDraft, saveChartCloudDraft } from "../lib/chart-creation/community";
import { communityChartPath, type ChartMediaRef } from "../lib/chart-creation/community-types";
import "./chart-creation-collections";
import type { ChartCollectionScope } from "./chart-creation-collections";
import { readAuthorCollections, authorSelectionForScope, authorEntityIds, reconcileAuthorEdit, assignAuthorSelection, copyAuthorSelection, copyAuthorSegments, mirrorAuthorClipboard, pasteAuthorSelection, type AuthorClipboard } from "../../packages/chart-editor/src/creation/collections";
import { joinNoteLines, lineJoinTargets, linePatternTarget, lineSplitTarget, lineTraces, repeatLinePattern, splitNoteLine } from "../../packages/chart-editor/src/creation/connectors";
import { applyAuthorCollectionOperation, type AuthorCollectionOperation } from "../../packages/chart-editor/src/creation/collections-history";
import type { ChartCreationLibrary, PublicChartImport, CreationLibraryProvider } from "./chart-creation-library";
import { isBestdoriServer } from "../../packages/bestdori/src/transport";
import type { ChartSkin } from "../../packages/embed-cassiopeia/src/types";
import type { ChartSimulator, ChartSimulatorPlayback } from "./runtime/chart-simulator";
import { AuthorNativeSpeedError } from "../lib/chart-creation/native-speed-plan";
import type { HaneokaReleaseIdentity, HaneokaLocale } from "../../packages/api-client/src/haneoka";
import { listPublicCreationSongs, pinnedPublicUrl } from "../lib/chart-creation/public-songs";
import { readReleaseServer } from "../lib/release-server";
import { compileOurNotesCreation } from "../lib/chart-creation/our-notes";
import { loadOurNotesCreationCanvasSkin, ourNotesCreationCanvasNoteAppearance, createChartCanvasRibbonStyle, drawChartCanvasLanePlane, drawChartCanvasRibbon, interpolateNoteLine, type OurNotesCreationCanvasSkin } from "../lib/chart-creation/native-canvas-skin";
import type { ChartNote } from "@haneoka/cassiopeia";
import type { RenderNoteKind } from "@haneoka/cassiopeia-plugin-our-notes";
import { loadingState } from "./ui/state";
import { modal } from "./ui/modal";
import { focusedValue } from "./ui/focused-value";

import { assertEditedChartSpans, authoredSpanInBounds, authoredSpanViewport, authoredWidthBounds, constrainLaneValue, viewportXToAuthoredLane, authoredLaneToViewportX } from "../../packages/chart-editor/src/creation/span";
import { createAuthoredNote, resizeChartSelection, resizeChartSelectionByDelta } from "../../packages/chart-editor/src/creation/authoring";
import {
  brushChartSelection,
  compressChartSelection,
  flipChartSelection,
  generateLinePoints,
  insertLinePoint,
  interpolateChartTimeScales,
  nudgeChartSelectionOnGrid,
  removableLinePointIds,
  removeLineControlPoints,
  sampleLineSpan,
  setLinePointMode,
  type LinePointMode,
  type NoteBrush,
} from "../../packages/chart-editor/src/creation/actions";
import {
  timeToViewportY,
  panVerticalTimeViewport,
  scrollVerticalTimeViewport,
  zoomVerticalTimeViewportAtY,
} from "../../packages/chart-editor/src/viewport";
import { serializeProjectJson } from "../../packages/chart-editor/src/formats/project-json";
import { serializeMmws, isMmws } from "../../packages/chart-editor/src/formats/mmws";
import { serializeSus } from "../../packages/chart-editor/src/formats/sus-export";
import { serializeUsc } from "../../packages/chart-editor/src/formats/usc";
import {
  validateExportTarget,
  serializeSsForTarget,
  type ExportFormat,
} from "../../packages/chart-editor/src/formats/diagnostics";
import {
  chartSelectionNodes,
  chartSelectionInBox,
  moveChartSelection,
  deleteChartSelectionGroup,
} from "../../packages/chart-editor/src/creation/selection";
import { formatDate } from "../lib/date-format";

/** Message paths for this view's finite control/metadata identifiers. */
const uiLabelPaths: Readonly<Record<string, string>> = {
  "cancel": "common.actions.cancel",
  "chart": "navigation.chart",
  "circle": "navigation.circle",
  "close": "common.actions.close",
  "difficulty": "catalog.songs.fields.difficulty",
  "effects": "catalog.fields.effects",
  "error": "common.states.error",
  "export": "common.actions.export",
  "files": "catalog.fields.files",
  "fullscreen": "common.actions.fullscreen",
  "height": "catalog.characters.fields.height",
  "level": "common.fields.level",
  "loading": "common.states.loading",
  "loop": "common.actions.loop",
  "mirror": "editors.chart.labels.mirror",
  "none": "common.states.none",
  "pause": "common.actions.pause",
  "play": "common.actions.play",
  "preview": "common.actions.preview",
  "remove": "common.actions.remove",
  "retry": "common.actions.retry",
  "source": "common.fields.source",
  "speed": "media.playback.fields.speed",
  "stop": "common.actions.stop",
  "title": "common.fields.title",
  "type": "catalog.fields.type",
  "unavailable": "common.states.unavailable",
  "volume": "media.audio.volume",
  "watch": "common.actions.watch"
};

const fineSnapDivisions = [96, 192, 384, 480, 960, 1920];

interface EditAudioTransport {
  clock: MediaClock;
  play(): Promise<void>;
  pause(): void;
  seek(seconds: number): void;
  dispose(): void;
}
interface PastePlacement {
  base: Project;
  clipboard: AuthorClipboard;
  candidate?: Project;
  ids: string[];
  tick: number;
  laneShift: number;
  left: number;
  width: number;
  pointer?: number;
  error: string;
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
  error?: string;
  resizeDelta?: number;
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

let chartCreationOwnerSequence = 0;

export class ChartCreationWorkspace extends LitElement {
  static properties = {
    locale: {},
    collectionScope: { state: true },
    deletingProject: { state: true },
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
    defaultWidth: { state: true },
    fullscreen: { state: true },
    zoomX: { state: true },
    laneStart: { state: true },
    followPlayback: { state: true },
    relativeSnap: { state: true },
    canvasLoading: { state: true },
    canvasFailed: { state: true },
    pastePlacement: { state: true },
    patternOpen: { state: true },
    patternBusy: { state: true },
    patterns: { state: true },
    patternName: { state: true },
    selectedPattern: { state: true },
    patternError: { state: true },
    nodeMode: { state: true },
  };
  declare locale: string;
  declare private collectionScope: ChartCollectionScope;
  declare private deletingProject: boolean;
  private scopeSnapshot?: { project: Project; scope: ChartCollectionScope; ids: Set<string> };
  private editingSnapshot?: { project: Project; scope: ChartCollectionScope; view: Project };
  private readonly collectionOperation = (operation: AuthorCollectionOperation) => {
    if (this.busy || this.gesture || this.pastePlacement) return false;
    try { return this.commitProject(applyAuthorCollectionOperation(this.chart, operation).project); }
    catch { this.error = this.t("creation.invalid_edit"); return false; }
  };
  private readonly changeCollectionScope = (scope: ChartCollectionScope) => {
    this.cancelGesture(); this.cancelWidth(); this.pending = undefined;
    this.collectionScope = scope; this.pruneSelection(); this.paint();
  };
  private readonly selectCollectionMembers = (ids: string[]) => { this.setSelection(ids); this.pruneSelection(); this.paint(); };
  private scopeIds(project = this.chart) {
    if (this.scopeSnapshot?.project !== project || this.scopeSnapshot.scope !== this.collectionScope)
      this.scopeSnapshot = { project, scope: this.collectionScope, ids: authorSelectionForScope(project, this.collectionScope) };
    return this.scopeSnapshot.ids;
  }
  private editingProject(project: Project) {
    if (this.editingSnapshot?.project === project && this.editingSnapshot.scope === this.collectionScope) return this.editingSnapshot.view;
    const ids = this.scopeIds(project), singles = project.singles.filter(note => ids.has(note.id)), lines = project.lines.filter(line => line.points.some(note => ids.has(note.id)));
    const view = singles.length === project.singles.length && lines.length === project.lines.length ? project : { ...project, singles, lines };
    return (this.editingSnapshot = { project, scope: this.collectionScope, view }).view;
  }
  private history = new ProjectHistory(createEmptyProject());
  private static suspendedDraft?: Promise<ReturnType<ChartCreationWorkspace["captureDraft"]>>;
  private static suspendedUnsaved = false;
  private static protectSuspendedDraft = (event: BeforeUnloadEvent) => {
    if (!ChartCreationWorkspace.suspendedUnsaved) return;
    event.preventDefault();
    event.returnValue = "";
  };
  private operation: Promise<void> = Promise.resolve();
  private original = createEmptyProject();
  private projectSnapshot?: { revision: number; value: Project };
  private warningSnapshot?: { revision: number; format: ExportFormat; value: ReturnType<typeof validateExportTarget> };
  private readonly libraryImport = (value: PublicChartImport, signal: AbortSignal) => this.importLibrary(value, signal);
  private source?: CreationDocument["source"];
  private projectId: string = crypto.randomUUID();
  private head = 0;
  private conflict = false;
  private activeRevision = 0;
  private projectExpanded = true;
  private toolExpanded = true;
  private store = new CreationStore();
  private patternStore = new ChartPatternStore();
  declare private pastePlacement: PastePlacement | undefined;
  declare private patternOpen: boolean;
  declare private patternBusy: boolean;
  declare private patterns: ChartPattern[];
  declare private patternName: string;
  declare private selectedPattern: string;
  declare private patternError: string;
  private autosaveTimer?: ReturnType<typeof setTimeout>;
  private audio?: CreationAudio;
  private preview?: EditAudioTransport;
  declare private stageMode: "edit" | "preview";
  private previewPlayback?: ChartSimulatorPlayback;
  private previewAudioUrl?: string;
  private previewCoverUrl?: string;
  private previewJacketUrl?: string;
  private previewBandId = 0;
  private previewIdentity?: HaneokaReleaseIdentity;
  private pageData?: PublicSongsPageData;
  private canvasTheme?: OurNotesCreationCanvasSkin;
  private canvasThemeKey = "";
  private canvasController?: AbortController;
  private flatChart?: { project:Project; value?:ReturnType<typeof compileOurNotesCreation> };
  declare private canvasLoading: boolean;
  declare private canvasFailed: boolean;
  private canvasSkin: ChartSkin = {
    currentQuality: 2,
    noteSkin: "skin001",
    noteEffectSkin: "effect001",
    noteSeGroup: 1,
  };
  private controller?: AbortController;
  private observer?: ResizeObserver;
  private appearanceObserver?: MutationObserver;
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
  declare private nodeMode: LinePointMode;
  private seconds = 0;
  private preciseSeekSeconds?: number;
  private lastTransportPaint = 0;
  private cursor?: { clientX: number; clientY: number; pointerType: string };
  private cursorFrame = 0;
  private widthRangeMax = 24;
  private viewProjectId = "";
  private laneBoundsSnapshot?: { project: Project; padding: number; bounds: ReturnType<typeof authoredSpanViewport> };
  private selectionSnapshot?: { project: Project; nodes: ReturnType<typeof chartSelectionNodes> };
  private critical = false;
  private snap = 16;
  private secondsPerScreen = 4;
  private rate = 1;
  private audioSettings: EditorAudioSettings = { ...DEFAULT_EDITOR_AUDIO };
  private audioFeedback?: EditorAudioFeedback;
  private feedbackChart?: { project: Project; chart: ReturnType<typeof buildChart> };
  private transportAudio?: CreationAudio;
  private transportProject = "";
  private startingPlayback = false;
  private playbackRequest = 0;
  private audioSettingsOpen = false;
  private audioFeedbackFailed = false;
  private audioIdentity?: { controller: AbortController; promise: Promise<HaneokaReleaseIdentity> };
  private selectedSpeeds = new Set<string>();
  private gameMarkersOpen = false;
  private meterDrafts = new Map<string, string>();
  private lineToolsOpen = false;
  private statisticsOpen = false;
  private timelineSnapshot?: { project: Project; audio: CreationAudio | undefined; duration: number };
  private statisticsSnapshot?: { project: Project; audio: CreationAudio | undefined; locale: string; facts: [string, string | number][] };
  private shortcutOverrides: ChartShortcutOverrides = {};
  private shortcutsOpen = false;
  private recordingShortcut?: { id: string; index: number };
  private shortcutError = "";
  private exportFormat: ExportFormat = "project";
  private clipboard?: AuthorClipboard;
  private get hasClipboard() { return Boolean(this.clipboard && (this.clipboard.entities.singles.length || this.clipboard.entities.lines.length || this.clipboard.entities.tempos.length || this.clipboard.entities.meters.length || this.clipboard.entities.timeScales.length || this.clipboard.collections.groups.length || this.clipboard.collections.layers.length)); }
  declare private selectedIds: Set<string>;
  declare private multiPick: boolean;
  private gesture?: SelectionGesture;
  private gestureFrame = 0;
  private pan?: { pointer: number; x: number; y: number; start: number; laneStart: number };
  private direction: "left" | "up" | "right" = "up";
  private insertLane = 0;
  declare private defaultWidth: number;
  private widthSession?: { base: Project; ids: Set<string>; candidate?: Project };
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
  private readonly toolbarOwner = `chart-creation-${++chartCreationOwnerSequence}`;
  private mediaChanged = () => {
    this.narrow = this.panelMedia?.matches ?? false;
    this.leftOpen = this.stageMode === "edit" && !this.pastePlacement && !this.narrow && innerWidth >= 1280;
    this.rightOpen = this.stageMode === "edit" && !this.pastePlacement && !this.narrow;
  };
  constructor() {
    super();
    this.locale = "en";
    this.pastePlacement = undefined;
    this.patternOpen = false;
    this.patternBusy = false;
    this.patterns = [];
    this.patternName = "";
    this.selectedPattern = "one-tick-flick";
    this.patternError = "";
    this.nodeMode = "visible";
    this.collectionScope = {}; this.deletingProject = false;
    this.defaultWidth = 4;
    this.fullscreen = false;
    this.zoomX = 1;
    this.laneStart = -this.editingGutter();
    this.followPlayback = false;
    this.relativeSnap = false;
    this.canvasLoading = false;
    this.canvasFailed = false;
    this.stageMode = "edit";
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
    return clientText(this.locale, `editors.chart.${key}`);
  }
  private c(key: string) {
    return clientText(this.locale, (uiLabelPaths[key] ?? key));
  }
  private apiLocale(): HaneokaLocale {
    return (localizedFallbacks(this.locale).find(locale => ["ja", "en", "zh-TW", "zh-CN", "ko"].includes(locale)) ?? "en") as HaneokaLocale;
  }
  private get chart() {
    if (this.projectSnapshot?.revision !== this.history.revision)
      this.projectSnapshot = { revision: this.history.revision, value: this.history.value };
    return this.projectSnapshot.value;
  }
  private get nativeChart() {
    return !this.chart.meta.source || ["ss", "authored"].includes(this.chart.meta.source);
  }
  private get previewPlayer() {
    return this.querySelector<ChartSimulator>("chart-simulator");
  }
  private exportValidation() {
    if (this.warningSnapshot?.revision !== this.history.revision || this.warningSnapshot.format !== this.exportFormat)
      this.warningSnapshot = {
        revision: this.history.revision,
        format: this.exportFormat,
        value: validateExportTarget(this.chart, this.exportFormat),
      };
    return this.warningSnapshot.value;
  }
  connectedCallback() {
    const payload = readPageData<PublicSongsPageData>(this);
    if (payload?.schema === "haneoka-public-songs-page-v1") this.preparePage(payload);
    super.connectedCallback();
    void this.updateComplete.then(() => this.connectEditor());
  }
  preparePage(payload: PublicSongsPageData) {
    this.pageData = payload;
    this.previewIdentity = payload.variants[payload.server]?.identity;
  }
  protected update(changed: PropertyValues) {
    if (this.hasAttribute("data-prerendered")) {
      hydrate(this.render(), this, this.renderOptions);
      this.removeAttribute("data-prerendered");
    }
    super.update(changed);
  }
  renderStaticChrome() {
    setAppBarActions(this.toolbarOwner, this.renderAppActions(), this);
  }
  private connectEditor() {
    if (!this.isConnected) return;
    this.shortcutOverrides = readChartShortcuts();
    this.audioSettings = readEditorAudioSettings();
    this.requestUpdate();
    if (this.pageData) this.previewIdentity = this.pageData.variants[readReleaseServer()]?.identity;
    document.addEventListener("fullscreenchange", this.fullscreenChanged);
    this.panelMedia = matchMedia("(max-width: 959px)");
    this.panelMedia.addEventListener("change", this.mediaChanged);
    this.mediaChanged();
    this.appearanceObserver ??= new MutationObserver(() => this.paint());
    this.appearanceObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-seed"] });
    document.addEventListener("keydown", this.keydown);
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
    void this.run(async (signal) => {
      const suspended = ChartCreationWorkspace.suspendedDraft;
      if (suspended) {
        const draft = await suspended;
        signal.throwIfAborted();
        this.projectSnapshot = undefined;
        this.warningSnapshot = undefined;
        Object.assign(this, draft);
        this.viewProjectId = this.projectId;
        ChartCreationWorkspace.suspendedDraft = undefined;
        ChartCreationWorkspace.suspendedUnsaved = false;
        window.removeEventListener("beforeunload", ChartCreationWorkspace.protectSuspendedDraft);
        this.rebuildPreview(draft.seconds);
      }
      this.documents = await this.store.list();
      const cloudId = new URL(location.href).searchParams.get("community");
      if (cloudId && /^[0-9a-f-]{36}$/u.test(cloudId)) await this.openCommunity(cloudId, signal);
      else if (!this.audio) {
        const recent = localStorage.getItem("haneoka-chart-last-project");
        if (recent && this.documents.some(document => document.id === recent)) await this.open(recent);
      }
    }).then(() => this.openLinkedBestdoriChart());
  }
  private async openLinkedBestdoriChart() {
    if (!this.isConnected) return;
    const url = new URL(location.href), params = url.searchParams;
    const region = params.get("region") ?? "jp", songId = params.get("songId") ?? "", difficulty = params.get("difficulty") ?? "";
    if (params.get("provider") !== "bestdori" || !isBestdoriServer(region) || !/^[1-9]\d{0,8}$/.test(songId) || !["easy", "normal", "hard", "expert", "special"].includes(difficulty)) return;
    await this.updateComplete;
    const library = this.querySelector<ChartCreationLibrary>("chart-creation-library");
    if (!library) return;
    for (const key of ["provider", "region", "songId", "difficulty"]) params.delete(key);
    history.replaceState(history.state, "", url);
    if (this.narrow) this.closePanels();
    await library.show("bestdori", undefined, { region, songId, difficulty });
  }
  disconnectedCallback() {
    clearTimeout(this.autosaveTimer);
    document.removeEventListener("fullscreenchange", this.fullscreenChanged);
    this.panelMedia?.removeEventListener("change", this.mediaChanged);
    this.releasePanelFocus?.();
    this.focusedPanel = undefined;
    clearAppBarActions(this.toolbarOwner);
    document.removeEventListener("keydown", this.keydown);
    cancelAnimationFrame(this.cursorFrame);
    this.cursorFrame = 0;
    this.cursor = undefined;
    window.removeEventListener("beforeunload", this.beforeUnload);
    this.cancelGesture();
    this.cancelWidth();
    this.suspendDraft();
    this.pan = undefined;
    this.controller?.abort();
    ++this.playbackRequest; this.startingPlayback = false;
    this.preview?.dispose();
    this.preview = undefined;
    const feedback = this.audioFeedback; this.audioFeedback = undefined;
    void feedback?.dispose();
    this.audioIdentity?.controller.abort(); this.audioIdentity = undefined;
    void this.disposePreview();
    this.canvasController?.abort();
    void this.canvasTheme?.dispose();this.canvasTheme=undefined;
    this.observer?.disconnect();
    this.appearanceObserver?.disconnect();
    this.unlocale?.();
    void this.operation.then(() => this.store.close()).catch(() => {});
    void this.patternStore.close().catch(() => {});
    super.disconnectedCallback();
  }
  private statusShown = "";
  protected updated() {
    if (!this.isConnected) return;
    if (this.dirty && this.audio && !this.busy && !this.pastePlacement && !this.conflict && !this.autosaveTimer) {
      this.autosaveTimer = setTimeout(() => {
        this.autosaveTimer = undefined;
        if (this.isConnected && !this.busy && !this.gesture && !this.pastePlacement && !this.widthSession && !this.conflict) {
          const focused = document.activeElement;
          void this.run(() => this.save(true)).then(async () => {
            await this.updateComplete;
            if (focused instanceof HTMLElement && focused.isConnected && document.activeElement === document.body)
              focused.focus({ preventScroll: true });
          });
        }
      }, 2000);
    }
    if (this.status !== this.statusShown) {
      this.statusShown = this.status;
      if (this.status) snackbar(this.status);
    }
    this.paint();
    setAppBarActions(this.toolbarOwner, this.renderAppActions(), this);
    const panel = this.narrow ? this.querySelector<HTMLElement>(".chart-studio__panel:not([hidden])") : null;
    if (panel !== (this.focusedPanel ?? null)) {
      this.releasePanelFocus?.();
      this.focusedPanel = panel ?? undefined;
      this.releasePanelFocus = panel ? trapFocus(panel, { onDismiss: () => this.closePanels() }) : undefined;
    }
    const picker = this.querySelector<HTMLElementTagNameMap["md-outlined-select"]>("[data-pattern-picker]");
    if (picker) {
      const value = this.selectedPattern;
      void Promise.all([picker.updateComplete, ...[...picker.querySelectorAll("md-select-option")].map(option => option.updateComplete)]).then(() => {
        if (this.isConnected && this.patternOpen && this.selectedPattern === value && (picker.value !== value || !picker.displayText)) picker.select(value);
      });
    }
    // Material resolves newly rendered version options after its own update.
    for (const [selector, value] of [["[data-version]", String(this.activeRevision)], ["[data-project]", this.head ? this.projectId : ""]]) {
      const control = this.querySelector<HTMLElementTagNameMap["md-outlined-select"]>(selector);
      if (!control) continue;
      void control.updateComplete.then(() => {
        const current = selector === "[data-version]" ? String(this.activeRevision) : this.head ? this.projectId : "";
        if (this.isConnected && current === value && control.value !== value) control.select(value);
      });
    }
  }
  private captureDraft() {
    if (this.previewPlayer?.phase === "ready") this.seconds = this.previewPlayer.currentTime;
    return {
      history: this.history, original: this.original, source: this.source,
      projectId: this.projectId, head: this.head, activeRevision: this.activeRevision,
      audio: this.audio, dirty: this.dirty, conflict: this.conflict, revisions: this.revisions,
      previewIdentity: this.previewIdentity, collectionScope: this.collectionScope,
      selected: this.selected, selectedIds: this.selectedIds, clipboard: this.clipboard,
      seconds: this.seconds, preciseSeekSeconds: this.preciseSeekSeconds, windowStart: this.windowStart, laneStart: this.laneStart,
      zoomX: this.zoomX, secondsPerScreen: this.secondsPerScreen,
      tool: this.tool, nodeMode: this.nodeMode, defaultWidth: this.defaultWidth, critical: this.critical,
      direction: this.direction, snap: this.snap, relativeSnap: this.relativeSnap,
      insertLane: this.insertLane, multiPick: this.multiPick, brushPreset: this.brushPreset,
      followPlayback: this.followPlayback, exportFormat: this.exportFormat,
      rate: this.rate, canvasSkin: this.canvasSkin,
    };
  }
  private suspendDraft() {
    if (!this.audio) return;
    // Astro keeps modules alive across page swaps, including history traversal.
    // Wait for an in-flight save so its new revision is restored with the draft.
    const draft = this.operation.then(() => this.captureDraft());
    ChartCreationWorkspace.suspendedDraft = draft;
    ChartCreationWorkspace.suspendedUnsaved = this.dirty || this.busy;
    window.addEventListener("beforeunload", ChartCreationWorkspace.protectSuspendedDraft);
    void draft.then(value => {
      if (ChartCreationWorkspace.suspendedDraft === draft)
        ChartCreationWorkspace.suspendedUnsaved = value.dirty;
    });
  }
  private run(action: (signal: AbortSignal) => Promise<void>): Promise<void> {
    if (this.busy) return Promise.resolve();
    return this.operation = this.perform(action);
  }
  private async perform(action: (signal: AbortSignal) => Promise<void>) {
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
          `editors.chart.creation.${error instanceof Error ? error.message : "failed"}`,
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
  private async save(silent = false) {
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
    if (!silent) this.status = this.t("creation.saved");
    try { localStorage.setItem("haneoka-chart-last-project", this.projectId); } catch {}
    this.documents = await this.store.list();
    this.revisions = await this.store.versions(this.projectId);
  }
  private edit(updater: (draft: Project) => void) {
    if (this.busy || this.gesture || this.pastePlacement) return;
    this.cancelWidth();
    try {
      const draft = structuredClone(this.chart);
      updater(draft);
      this.commitProject(draft);
    } catch {
      this.error = this.t("creation.invalid_edit");
    }
  }
  private rebuildPreview(position?: number) {
    if (this.pastePlacement && this.pastePlacement.base !== this.chart) this.cancelPaste();
    if (this.viewProjectId !== this.projectId) {
      this.viewProjectId = this.projectId;
      this.preciseSeekSeconds = undefined;
      this.selectedSpeeds.clear();
      this.meterDrafts.clear();
      this.laneStart = (this.chart.laneBasis - this.laneSpan()) / 2;
    }
    this.laneStart = this.clampLaneStart(this.laneStart);
    if (this.stageMode === "preview") void this.disposePreview();
    if (this.preview && this.audio && this.transportAudio === this.audio && this.transportProject === this.projectId) {
      this.bindAudioFeedback();
      if (position !== undefined) this.preview.seek(Math.max(0, position));
      void this.ensureCanvasSkin();
      return;
    }
    ++this.playbackRequest; this.startingPlayback = false;
    this.preview?.dispose();
    this.preview = undefined;
    if (!this.audio || !this.isConnected) return;
    const url = URL.createObjectURL(this.audio.file),
      clock = new MediaClock(url, { playbackRate: this.rate, volume: this.audioSettings.bgmVolume, loop: false });
    this.transportAudio = this.audio; this.transportProject = this.projectId;
    // MediaClock loads its source during construction; restore the chosen rate after load.
    clock.rate = this.rate;
    let frame = 0,
      disposed = false,
      intent = 0,
      playingIntent = false;
    const sync = () => {
      cancelAnimationFrame(frame);
      frame = 0;
      if (disposed || !this.isConnected) return;
      this.updateTransport(clock.timeMs / 1000, clock.playing);
      this.audioFeedback?.sync(clock.timeMs / 1000, clock.advancing);
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
    this.bindAudioFeedback();
    this.preview.seek(Math.max(0, position ?? this.seconds));
    void this.ensureCanvasSkin();
  }
  private resourceIdentity(): HaneokaReleaseIdentity | undefined {
    const stored = this.chart.extensions.haneoka;
    return stored && typeof stored === "object" && !Array.isArray(stored)
      && typeof stored.server === "string" && typeof stored.releaseId === "string" && typeof stored.sourceId === "string"
      ? { schema: "haneoka-resource-release-identity-v1", server: stored.server, releaseId: stored.releaseId, sourceId: stored.sourceId }
      : this.previewIdentity?.server === readReleaseServer() ? this.previewIdentity : undefined;
  }
  private async ensureCanvasSkin(force = false) {
    if (!this.audio || !this.isConnected) return;
    const identity = this.resourceIdentity(), skin = this.canvasSkin;
    const requested=JSON.stringify([identity??readReleaseServer(),skin]);
    if(!force&&this.canvasThemeKey===requested&&(this.canvasTheme||this.canvasLoading))return;
    this.canvasController?.abort();
    const retired=this.canvasTheme;this.canvasTheme=undefined;void retired?.dispose();
    const controller=this.canvasController=new AbortController();this.canvasThemeKey=requested;this.canvasLoading=true;this.canvasFailed=false;
    const report=beginLoading(this.c("loading"),{signal:controller.signal,scope:"owner"});
    try {
      const pin=identity??(await listPublicCreationSongs({server:readReleaseServer(),locale:this.apiLocale(),limit:1,signal:controller.signal})).release;
      const theme=await loadOurNotesCreationCanvasSkin(pin,{skin,locale:this.locale,signal:controller.signal});
      if(controller!==this.canvasController||!this.isConnected){await theme.dispose();return;}
      this.canvasTheme=theme;this.previewIdentity=pin;this.canvasThemeKey=JSON.stringify([pin,skin]);
      report.finish();this.paint();
    } catch(error) {
      if(!controller.signal.aborted&&controller===this.canvasController){this.canvasFailed=true;report.fail(error);}
    } finally {
      if(controller===this.canvasController){this.canvasLoading=false;this.requestUpdate();}
    }
  }
  private flatProjection(project:Project) {
    if(this.flatChart?.project!==project){
      try {
        const native = !project.meta.source || ["ss", "authored"].includes(project.meta.source)
          ? project : { ...project, meta: { ...project.meta, source: "authored" } };
        this.flatChart={project,value:compileOurNotesCreation(native)};
      }
      catch { this.flatChart={project}; }
    }
    return this.flatChart.value;
  }
  private updateTransport(seconds: number, playing: boolean) {
    if (playing) this.preciseSeekSeconds = undefined;
    else if (this.preciseSeekSeconds !== undefined) seconds = this.preciseSeekSeconds;
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
    for (const button of this.querySelectorAll<HTMLButtonElement>("[data-play]")) {
      const active = playing || this.startingPlayback;
      button.setAttribute("aria-label", this.c(active ? "pause" : "play"));
      button.setAttribute("aria-pressed", String(active));
      button.setAttribute("aria-busy", String(this.startingPlayback));
      button.querySelector("use")?.setAttribute("href", `/icons.svg#${active ? "pause" : "play_arrow"}`);
      const label = button.querySelector("[data-play-label]");
      const text = label && [...label.childNodes].find(node => node.nodeType === Node.TEXT_NODE);
      if (text) text.textContent = this.c(active ? "pause" : "play");
    }
  }
  private async disposePreview() {
    const player = this.previewPlayer;
    if (player) {
      if (player.phase === "ready") this.seconds = player.currentTime;
      player.pause();
    }
    const audioUrl = this.previewAudioUrl, coverUrl = this.previewCoverUrl;
    this.previewPlayback = undefined;
    this.previewAudioUrl = undefined;
    this.previewCoverUrl = undefined;
    this.stageMode = "edit";
    await this.updateComplete;
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    if (coverUrl) URL.revokeObjectURL(coverUrl);
  }
  private async importLibrary(value: PublicChartImport, external: AbortSignal) {
    let accepted = false,
      cancelled = false;
    await this.run(async (signal) => {
      const controller = this.controller!;
      const abort = () => controller.abort(external.reason);
      external.addEventListener("abort", abort, { once: true });
      try {
        if (external.aborted) abort();
        signal.throwIfAborted();
        await this.save();
        signal.throwIfAborted();
        if (!value.audio) throw new Error("creation_audio_required");
        const audio = await decodeCreationAudio(value.audio, signal);
        const provider = "provider" in value ? "bestdori" : "our-notes";
        const ref: ChartMediaRef = provider === "bestdori"
          ? { kind: "server", provider, server: (value.identity as import("../lib/chart-creation/bestdori-source").BestdoriCreatorIdentity).requestedRegion, songId: String(value.metadata.musicId) }
          : { kind: "server", provider, server: (value.identity as HaneokaReleaseIdentity).server, releaseId: (value.identity as HaneokaReleaseIdentity).releaseId, songId: String(value.metadata.musicId) };
        value.project.extensions.communityMedia = { audio: ref, cover: ref, audioSha: audio.sha256 };
        signal.throwIfAborted();
        await this.disposePreview();
        signal.throwIfAborted();
        if (!this.isConnected) throw new DOMException("Disconnected", "AbortError");
        this.projectId = crypto.randomUUID();
        this.head = 0;
        this.activeRevision = 0;
        this.revisions = [];
        readAuthorCollections(value.project);
        this.collectionScope = {}; this.deletingProject = false;
        this.history.reset(value.project);
        this.original = structuredClone(value.project);
        this.source = value.source;
        this.audio = audio;
        this.previewIdentity = "provider" in value ? undefined : value.identity;
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
        if (!accepted && this.isConnected && this.audio && this.stageMode === "preview" && !this.previewPlayback) {
          this.stageMode = "edit";
          await this.updateComplete;
          this.rebuildPreview(this.seconds);
        }
      }
    });
    if (!accepted) throw cancelled ? new DOMException("Cancelled", "AbortError") : new Error("import_failed");
  }
  private showLibrary(provider: CreationLibraryProvider = "haneoka") {
    if (this.busy) return;
    if (this.narrow) this.closePanels();
    void this.updateComplete.then(() => this.querySelector<ChartCreationLibrary>("chart-creation-library")?.show(provider));
  }
  private async switchStage() {
    this.preciseSeekSeconds = undefined;
    if (this.busy || !this.audio) return;
    if (this.startingPlayback) this.pausePlayback();
    this.clearCursor();
    if (this.stageMode === "preview") {
      await this.disposePreview();
      this.rebuildPreview(this.seconds);
      return;
    }
    await this.run(async signal => {
      const stored = this.chart.extensions.haneoka;
      if (stored && typeof stored === "object" && !Array.isArray(stored)
        && typeof stored.server === "string" && typeof stored.releaseId === "string" && typeof stored.sourceId === "string")
        this.previewIdentity = {
          schema: "haneoka-resource-release-identity-v1",
          server: stored.server, releaseId: stored.releaseId, sourceId: stored.sourceId,
        };
      else if (!this.previewIdentity || this.previewIdentity.server !== readReleaseServer())
        this.previewIdentity = (await listPublicCreationSongs({
          server: readReleaseServer(), locale: this.apiLocale(), limit: 1, signal,
        })).release;
      const [draft] = await Promise.all([
        readChartCloudDraft(this.projectId),
        import("./runtime/chart-simulator"),
      ]);
      signal.throwIfAborted();
      const compiled = this.flatProjection(this.chart);
      const playback: ChartSimulatorPlayback = {
        ss: compiled?.ss ?? serializeSsForTarget(this.chart, false),
        offsetMs: this.chart.audioOffset * 1000,
        timeScaleChanges: compiled?.chart.timeScaleChanges ?? this.chart.timeScales.map(event => ({
          timeMs: this.map().tickToSeconds(event.tick) * 1000, scale: event.scale,
        })),
        releaseId: this.previewIdentity!.releaseId,
        startTime: this.seconds,
        ...(compiled?.visualProfiles ? { visualProfiles: compiled.visualProfiles } : {}),
      };
      this.preview?.dispose();
      this.preview = undefined;
      this.previewAudioUrl = URL.createObjectURL(this.audio!.file);
      this.previewCoverUrl = draft?.coverFile ? URL.createObjectURL(draft.coverFile) : undefined;
      const song = stored && typeof stored === "object" && !Array.isArray(stored) && typeof stored.songId === "string"
        ? this.pageData?.variants[this.previewIdentity!.server]?.songs[stored.songId] : undefined;
      this.previewBandId = Number(song?.bandId ?? 0);
      this.previewJacketUrl = this.previewCoverUrl ?? (typeof song?.jacketUrl === "string"
        ? pinnedPublicUrl(song.jacketUrl, this.previewIdentity!) : undefined);
      this.previewPlayback = playback;
      this.closePanels();
      this.stageMode = "preview";
      await this.updateComplete;
    });
  }
  private seekPlayback(seconds: number, exact = false) {
    this.preciseSeekSeconds = this.stageMode === "edit" && exact ? seconds : undefined;
    if (this.stageMode === "preview") this.previewPlayer?.seek(seconds);
    else this.preview?.seek(seconds);
  }
  private pausePlayback() {
    ++this.playbackRequest; this.startingPlayback = false;
    this.previewPlayer?.pause();
    this.preview?.pause();
    this.requestUpdate();
  }
  private loadAudio(file: File, example = false) {
    void this.run(async (signal) => {
      const audio = await decodeCreationAudio(file, signal);
      await this.save();
      this.preview?.dispose();
      this.audio = audio;
      this.preciseSeekSeconds = undefined;
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
        this.collectionScope = {}; this.deletingProject = false;
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
  private async openCommunity(id: string, signal: AbortSignal) {
    const requestedRevision = Number(new URL(location.href).searchParams.get("revision"));
    const result = await loadCommunityChart(id, signal, true, Number.isSafeInteger(requestedRevision) && requestedRevision > 0 ? requestedRevision : undefined);
    const response = await fetch(result.document.audioUrl, { signal, credentials: "same-origin" });
    if (!response.ok) throw new Error("audio_missing");
    const file = new File([await response.blob()], `${result.chart.title}.audio`, { type: response.headers.get("Content-Type") || "audio/wav" });
    const audio = await decodeCreationAudio(file, signal);
    await this.save(); signal.throwIfAborted(); await this.disposePreview(); signal.throwIfAborted();
    this.preview?.dispose(); this.projectId = crypto.randomUUID(); this.head = 0; this.activeRevision = 0;
    this.history.reset(result.document.project); this.original = structuredClone(result.document.project); this.source = undefined;
    this.audio = audio; this.collectionScope = {}; this.revisions = []; this.setSelection([]); this.pending = undefined;
    const publication = { audio: result.document.audio, cover: result.document.cover, summary: result.document.summary, visibility: result.document.visibility, remix: result.document.remix, audioSha: audio.sha256, ...(result.document.upstreamId ? { upstreamId: result.document.upstreamId } : {}) };
    if (result.chart.canEdit) await saveChartCloudDraft(this.projectId, { ...publication, id, version: result.chart.version, revision: result.chart.revision, ownerId: result.chart.ownerId });
    else {
      let coverFile: File | undefined;
      if (publication.cover?.kind !== "server") {
        const coverResponse = await fetch(result.document.coverUrl, { signal });
        if (!coverResponse.ok) throw new Error("audio_missing");
        const cover = await coverResponse.blob();
        const extension = cover.type.includes("jpeg") ? "jpg" : cover.type.includes("webp") ? "webp" : "png";
        coverFile = new File([cover], `cover.${extension}`, { type: cover.type });
      }
      await saveChartCloudDraft(this.projectId, { ...publication, audio: publication.audio?.kind === "server" ? publication.audio : null, cover: publication.cover?.kind === "server" ? publication.cover : null, ...(coverFile ? { coverFile } : {}), upstreamId: id });
    }
    this.dirty = true; this.windowStart = 0; this.rebuildPreview(0); await this.save();
    const url = new URL(location.href); url.searchParams.delete("community"); history.replaceState(history.state, "", url);
  }
  private async open(id: string, revision?: number) {
    const signal = this.controller!.signal;
    await this.save(); signal.throwIfAborted();
    const opened = await this.store.open(id, revision);
    const [audio, revisions] = await Promise.all([decodeCreationAudio(opened.file, signal), this.store.versions(id)]);
    if (audio.sha256 !== opened.value.audio.sha256) throw new Error("audio_hash");
    signal.throwIfAborted(); await this.disposePreview(); signal.throwIfAborted();
    if (!this.isConnected) throw new DOMException("Disconnected", "AbortError");
    this.preview?.dispose();
    this.projectId = id; this.head = opened.document.head; this.activeRevision = opened.value.revision;
    this.original = opened.document.original; this.source = opened.document.source;
    this.collectionScope = {}; this.deletingProject = false;
    this.history.reset(opened.value.chart); this.audio = audio; this.previewIdentity = undefined;
    this.setSelection([]); this.pending = undefined;
    // Viewing a historical version is clean; the first subsequent edit creates a new saved branch.
    this.dirty = false; this.windowStart = 0; this.revisions = revisions;
    this.rebuildPreview(0); this.status = this.t("restored");
  }
  private async saveCopy() {
    if (!this.audio) return;
    await this.run(async signal => {
      const id = crypto.randomUUID(), snapshot = structuredClone(this.chart), original = this.original, audio = this.audio!, source = this.source;
      snapshot.meta.title = `${snapshot.meta.title || this.t("project")} (${this.t("creation.copy")})`;
      const originalAudio = this.head ? await this.store.original(this.projectId) : undefined;
      signal.throwIfAborted();
      const document = await this.store.save(id, 0, snapshot, audio, original, source, originalAudio);
      const publication = await readChartCloudDraft(this.projectId);
      if (publication) await saveChartCloudDraft(id, { ...publication, id: undefined, version: undefined, revision: undefined, pendingSave: undefined });
      signal.throwIfAborted();
      this.projectId = id; this.head = document.head; this.activeRevision = document.head;
      this.history.reset(snapshot); this.setSelection([]);
      this.dirty = false; this.conflict = false; this.deletingProject = false;
      this.documents = await this.store.list(); this.revisions = await this.store.versions(id);
      this.status = this.t("creation.saved");
    });
  }
  private async restoreOriginal() {
    await this.run(async signal => {
      await this.save(); signal.throwIfAborted();
      const original = await this.store.original(this.projectId), audio = await decodeCreationAudio(original.file, signal);
      if (audio.sha256 !== original.audio.sha256) throw new Error("audio_hash");
      signal.throwIfAborted(); await this.disposePreview(); signal.throwIfAborted();
      this.original = original.chart; this.source = original.document.source; this.audio = audio;
      this.history.reset(original.chart); this.collectionScope = {}; this.previewIdentity = undefined;
      this.setSelection([]); this.pending = undefined; this.dirty = true;
      this.rebuildPreview(0); await this.save();
      this.status = this.t("restored");
    });
  }
  private async deleteProject() {
    await this.run(async signal => {
      await this.save(); signal.throwIfAborted();
      await this.store.delete(this.projectId, this.head);
      // The confirmed local deletion committed; finalize its UI even if Cancel arrives during disposal.
      await this.disposePreview();
      this.preview?.dispose(); this.preview = undefined; this.audio = undefined;
      const project = createEmptyProject({ source: "authored" });
      this.history.reset(project); this.original = structuredClone(project); this.source = undefined;
      this.projectId = crypto.randomUUID(); this.head = this.activeRevision = 0;
      this.collectionScope = {}; this.deletingProject = false; this.revisions = []; this.dirty = false;
      this.setSelection([]); this.pending = undefined; this.windowStart = this.seconds = 0;
      this.stageMode = "edit"; this.documents = await this.store.list(); this.rebuildPreview(0);
    });
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
      const bytes = new Uint8Array(await file.arrayBuffer()), binary = isMmws(bytes);
      const text = binary ? Array.from(bytes, byte => String.fromCharCode(byte)).join("") : new TextDecoder().decode(bytes),
        imported = importChart(binary ? bytes : text);
      signal.throwIfAborted();
      readAuthorCollections(imported.project);
      this.collectionScope = {}; this.deletingProject = false;
      this.history.reset(imported.project);
      this.original = structuredClone(imported.project);
      this.source = { name: file.name, text, ...(binary ? { encoding: "binary" as const } : {}) };
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
  private selectionNodes(project = this.chart) {
    if (this.selectionSnapshot?.project !== project)
      this.selectionSnapshot = { project, nodes: chartSelectionNodes(project) };
    const visible = this.scopeIds(project);
    return this.selectionSnapshot.nodes.filter(entry => visible.has(entry.note.id));
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
    if (!this.isConnected || this.busy || event.defaultPrevented || event.isComposing || event.repeat) return;
    const path = event.composedPath();
    if (!path.some(node => node === this || node instanceof HTMLElement && node.dataset.appBarOwner === this.toolbarOwner)) return;
    if (document.querySelector("dialog[open]")) return;
    const shortcut = matchChartShortcut(this.shortcutOverrides, event);
    if (shortcut === "save") {
      event.preventDefault();
      (document.activeElement as HTMLElement | null)?.blur();
      void this.run(() => this.save());
      return;
    }
    if (
      path
        .some(
          (node) =>
            node instanceof HTMLElement &&
            (node.matches(
              "input,textarea,select,[role=combobox],[role=slider],[role=switch],[role=option],[role=textbox]",
            ) ||
              node.matches("md-outlined-text-field,md-outlined-select,md-slider,md-checkbox,md-switch") ||
              node.isContentEditable),
        )
    )
      return;
    if ([" ", "Enter", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)
      && path.some(node => node instanceof HTMLElement && node.matches("button,a[href],[role=button],[role=radio],[role=checkbox]"))) return;
    if (this.pastePlacement) {
      const placement = this.pastePlacement;
      if (shortcut === "cancel" || shortcut === "undo") this.cancelPaste();
      else if (shortcut === "confirm") this.confirmPaste();
      else if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) {
        const direction = event.key === "ArrowUp" || event.key === "ArrowRight" ? 1 : -1;
        const time = event.key === "ArrowUp" || event.key === "ArrowDown";
        const tick = time ? Math.max(0, placement.tick + direction * (event.altKey ? 1 : Math.max(1, Math.round(this.chart.resolution * 4 / this.snap)))) : placement.tick;
        this.updatePaste(tick, placement.laneShift + (time ? 0 : direction * (event.altKey ? 0.25 : 1)));
      } else return;
      event.preventDefault();
      return;
    }
    if (this.stageMode === "preview") {
      if (shortcut === "save" || shortcut === "play") { this.executeShortcut(shortcut); event.preventDefault(); }
      else if (shortcut === "cancel") { event.preventDefault(); void this.switchStage(); }
      return;
    }
    if (this.gesture) {
      if (shortcut === "cancel") this.cancelGesture();
      event.preventDefault();
      return;
    }
    if (shortcut && this.executeShortcut(shortcut)) event.preventDefault();
  };
  private executeShortcut(command: string): boolean {
    if (command.startsWith("tool:")) {
      this.tool = command.slice(5);
      this.pending = undefined;
      this.requestUpdate();
      return true;
    }
    if (command.startsWith("grid:")) {
      this.snap = Number(command.slice(5));
      this.requestUpdate();
      return true;
    }
    switch (command) {
      case "save": void this.run(() => this.save()); break;
      case "undo": case "redo": {
        const redo = command === "redo";
        if (redo ? !this.history.canRedo : !this.history.canUndo) break;
        if (redo) this.history.redo(); else this.history.undo();
        this.pruneSelection(); this.dirty = true; this.rebuildPreview(); this.requestUpdate();
        break;
      }
      case "play": this.togglePlayback(); break;
      case "cancel": this.pending = undefined; this.setSelection([]); this.requestUpdate(); break;
      case "confirm": return false;
      case "select_all": this.setSelection(this.selectionNodes().map(item => item.note.id)); break;
      case "cut": this.cutSelection(); break;
      case "copy": this.clipboard = copyAuthorSelection(this.chart, this.selectedIds); this.requestUpdate(); break;
      case "copy_segments": this.copySegments(); break;
      case "paste": case "paste_mirrored": this.pasteSelection(command === "paste_mirrored"); break;
      case "duplicate": case "duplicate_mirrored": this.duplicateSelection(command === "duplicate_mirrored"); break;
      case "delete": this.edit(project => deleteChartSelectionGroup(project, this.selectedIds)); break;
      case "flip": this.commitProject(flipChartSelection(this.chart, this.selectedIds)); break;
      case "join": this.joinLines(); break;
      case "split": this.splitLine(); break;
      case "repeat": this.repeatNodes(); break;
      case "generate_nodes": this.generateSelectedNodes(); break;
      case "remove_nodes": this.removeSelectedNodes(); break;
      case "generate_traces": case "convert_traces": this.createLineTraces(command === "generate_traces"); break;
      case "compress_first": case "compress_last": this.compressSelection(command === "compress_first" ? "first" : "last"); break;
      case "nudge_up": case "nudge_down": this.nudgeSelection(command === "nudge_up" ? 1 : -1); break;
      case "tick_up": case "tick_down": this.nudgeSelection(command === "tick_up" ? 1 : -1, true); break;
      case "width_up": this.stepWidth(0.25); break;
      case "width_down": this.stepWidth(-0.25); break;
      case "width_up_large": this.stepWidth(1); break;
      case "width_down_large": this.stepWidth(-1); break;
      case "zoom_in": this.setVerticalZoom(this.secondsPerScreen / 2); break;
      case "zoom_out": this.setVerticalZoom(this.secondsPerScreen * 2); break;
      case "pan_up": case "pan_down":
        this.windowStart = this.clampStart(this.windowStart + (command === "pan_up" ? 1 : -1) * 0.25); this.requestUpdate(); break;
      case "pan_left": case "pan_right":
        this.laneStart = this.clampLaneStart(this.laneStart + (command === "pan_right" ? 1 : -1) * this.laneSpan() * 0.1); break;
      case "page_up": case "page_down":
        this.windowStart = this.clampStart(this.windowStart + (command === "page_up" ? 1 : -1) * this.secondsPerScreen); break;
      case "home": case "end": this.windowStart = command === "home" ? 0 : this.clampStart(this.timelineDuration() - this.secondsPerScreen); break;
      case "previous_waypoint": case "next_waypoint": this.stepWaypoint(command === "next_waypoint" ? 1 : -1); break;
      case "audio_settings": void this.showAudioSettings(); break;
      case "note_sounds": this.setAudioSetting("notes", !this.audioSettings.notes); break;
      case "metronome": this.setAudioSetting("metronome", !this.audioSettings.metronome); break;
      default: return false;
    }
    return true;
  }
  private togglePlayback() {
    if (this.stageMode === "preview") {
      void this.previewPlayer?.togglePlayback();
      return;
    }
    if (this.preview?.clock.playing || this.startingPlayback) this.pausePlayback();
    else this.startEditPlayback();
  }
  private startEditPlayback() {
    const transport = this.preview;
    if (!transport) return;
    const request = ++this.playbackRequest;
    this.startingPlayback = true; this.requestUpdate();
    void (async () => {
      try {
        try { await this.prepareAudioFeedback(); }
        catch (error) {
          if (error instanceof DOMException && error.name === "AbortError") throw error;
          if (request === this.playbackRequest) { this.audioFeedbackFailed = true; snackbar(this.t("audio.feedback_failed")); }
        }
        if (request === this.playbackRequest && this.preview === transport && this.isConnected) await transport.play();
      } catch (error) {
        if (request === this.playbackRequest && !(error instanceof DOMException && error.name === "AbortError")) this.error = this.t("audioFailed");
      } finally {
        if (request === this.playbackRequest) { this.startingPlayback = false; this.requestUpdate(); }
      }
    })();
  }
  private bindAudioFeedback() {
    if (!this.preview) return;
    if (!this.audioFeedback && !this.audioSettings.notes && !this.audioSettings.metronome) return;
    const feedback = this.audioFeedback ??= new EditorAudioFeedback(this.audioSettings);
    feedback.setSettings(this.audioSettings);
    try {
      let chart;
      if (this.audioSettings.notes) {
        if (this.feedbackChart?.project !== this.chart) {
          const chart = this.flatProjection(this.chart)?.chart ?? buildChart(parseScore(serializeSsForTarget(this.chart, false)));
          this.feedbackChart = { project: this.chart, chart };
        }
        chart = this.feedbackChart.chart;
      } else this.feedbackChart = undefined;
      feedback.bind(this.chart, this.preview.clock.audio, chart, this.resourceIdentity());
    } catch {
      feedback.bind(this.chart, this.preview.clock.audio, undefined, this.resourceIdentity());
      this.audioFeedbackFailed = true;
    }
  }
  private setAudioSetting<K extends keyof EditorAudioSettings>(key: K, value: EditorAudioSettings[K]) {
    this.audioSettings = { ...this.audioSettings, [key]: value };
    if (this.preview) this.preview.clock.volume = this.audioSettings.bgmVolume;
    this.bindAudioFeedback();
    try { writeEditorAudioSettings(this.audioSettings); }
    catch { snackbar(this.t("audio.storage_failed")); }
    if (this.startingPlayback && (key === "group" || key === "notes")) {
      ++this.playbackRequest; this.startingPlayback = false; this.startEditPlayback();
    } else if (key === "notes" || key === "metronome" || key === "group") this.unlockAudioFeedback();
    this.requestUpdate();
  }
  private unlockAudioFeedback() {
    void this.prepareAudioFeedback().catch(error => {
      if (this.isConnected && !(error instanceof DOMException && error.name === "AbortError")) {
        this.audioFeedbackFailed = true; snackbar(this.t("audio.feedback_failed"));
      }
    }).finally(() => this.requestUpdate());
  }
  private async prepareAudioFeedback() {
    if (!this.audioSettings.notes && !this.audioSettings.metronome) return;
    this.bindAudioFeedback();
    const feedback = this.audioFeedback;
    // Resume Web Audio in the control's user gesture, before resource requests.
    const unlock = feedback?.unlock();
    if (this.audioSettings.notes && !this.resourceIdentity()) {
      void unlock?.catch(() => {});
      await this.resolveAudioIdentity();
      this.bindAudioFeedback();
      await feedback?.unlock();
    } else await unlock;
    this.audioFeedbackFailed = false;
  }
  private resolveAudioIdentity(): Promise<HaneokaReleaseIdentity> {
    const identity = this.resourceIdentity();
    if (identity) return Promise.resolve(identity);
    if (this.audioIdentity) return this.audioIdentity.promise;
    const controller = new AbortController();
    const promise = listPublicCreationSongs({ server: readReleaseServer(), locale: this.apiLocale(), limit: 1, signal: controller.signal })
      .then(result => { controller.signal.throwIfAborted(); this.previewIdentity = result.release; return result.release; })
      .finally(() => { if (this.audioIdentity?.controller === controller) this.audioIdentity = undefined; });
    this.audioIdentity = { controller, promise };
    return promise;
  }
  private renderAudioSettings() {
    const volume = (key: "bgmVolume" | "noteVolume" | "metronomeVolume", label: string) => html`<label class="stack stack--tight">
      <span>${label} / ${Math.round(this.audioSettings[key] * 100)}%</span>
      <md-slider class="md3-slider" min="0" max="100" step="1" .value=${this.audioSettings[key] * 100} aria-label=${label} .ariaLabel=${label}
        @input=${(event: Event) => this.setAudioSetting(key, Number((event.target as HTMLInputElement).value) / 100)}></md-slider>
    </label>`;
    return accordion({ id: "chart-editor-audio", label: this.t("audio.title"), expanded: this.audioSettingsOpen,
      onExpandedChange: expanded => { this.audioSettingsOpen = expanded; this.requestUpdate(); }, content: html`<div class="chart-creation__form">
        ${volume("bgmVolume", this.t("audio.bgm_volume"))}
        <label class="cluster"><md-checkbox .checked=${this.audioSettings.notes} aria-label=${this.c("media.chartPlayer.noteSe")} .ariaLabel=${this.c("media.chartPlayer.noteSe")}
          @change=${(event: Event) => this.setAudioSetting("notes", (event.target as HTMLInputElement).checked)}></md-checkbox>${this.c("media.chartPlayer.noteSe")}</label>
        ${volume("noteVolume", this.t("audio.note_volume"))}
        <md-outlined-select label=${this.t("audio.sound_group")} .value=${live(String(this.audioSettings.group))} .error=${this.audioFeedbackFailed}
          @change=${(event: Event) => this.setAudioSetting("group", Number((event.target as HTMLSelectElement).value) as OurNotesNoteSeGroup)}>
          ${OUR_NOTES_NOTE_SE_GROUP_IDS.map(group => html`<md-select-option value=${String(group)} .selected=${this.audioSettings.group === group}>
            <div slot="headline">${OUR_NOTES_NOTE_SE_GROUP_NAMES[group][this.apiLocale()]}</div></md-select-option>`)}
        </md-outlined-select>
        <label class="cluster"><md-checkbox .checked=${this.audioSettings.metronome} aria-label=${this.t("audio.metronome")} .ariaLabel=${this.t("audio.metronome")}
          @change=${(event: Event) => this.setAudioSetting("metronome", (event.target as HTMLInputElement).checked)}></md-checkbox>${this.t("audio.metronome")}</label>
        ${volume("metronomeVolume", this.t("audio.metronome_volume"))}
        <button class="button button--text" type="button" ?disabled=${!this.audioFeedbackFailed}
          @click=${() => this.unlockAudioFeedback()}>${this.c("common.actions.retry")}</button>
        <button class="button button--tonal" type="button" data-play ?disabled=${this.busy || !this.audio}
          aria-label=${this.c(this.startingPlayback || this.preview?.clock.playing ? "pause" : "play")}
          @click=${() => this.togglePlayback()}>${icon(this.startingPlayback || this.preview?.clock.playing ? "pause" : "play_arrow")}
          <span data-play-label>${this.c(this.startingPlayback || this.preview?.clock.playing ? "pause" : "play")}</span></button>
      </div>` });
  }
  private async showAudioSettings() {
    this.cancelGesture(); this.cancelWidth(); this.projectTab = "project";
    this.leftOpen = true; this.audioSettingsOpen = true;
    if (this.narrow) this.rightOpen = false;
    this.requestUpdate();
    await this.updateComplete;
    this.querySelector("#chart-editor-audio-trigger")?.scrollIntoView({ block: "start" });
  }
  private renderMeters() {
    return html`<section class="stack" aria-label=${this.t("meter")}>
      <h3 class="detail-section-title">${this.t("meter")}</h3>
      <button class="button" type="button" ?disabled=${this.busy || !this.audio} @click=${() => this.edit(project => {
        const tick = Math.max(0, this.gridTick(this.map().secondsToTick(this.seconds)));
        if (project.meters.some(meter => meter.tick === tick)) return;
        const meter = meterAtTick(project.meters, tick) ?? project.meters[0]!;
        project.meters.push({ id: createProjectId("meter"), tick, numerator: meter.numerator, denominator: meter.denominator });
        project.meters.sort((a, b) => a.tick - b.tick);
      })}>${this.t("addMeter")}</button>
      ${this.chart.meters.map(meter => html`<div class="chart-creation__form">
        ${meter.tick === 0 ? html`<span class="chip">${this.t("beat")} 0</span>` : this.beatField(meter.tick, tick => this.edit(project => {
          project.meters.find(item => item.id === meter.id)!.tick = tick;
          project.meters.sort((a, b) => a.tick - b.tick);
        }))}
        <md-outlined-text-field label=${this.t("meter")} .value=${focusedValue(this.meterDrafts.get(meter.id) ?? `${meter.numerator}/${meter.denominator}`)}
          .error=${this.meterDrafts.has(meter.id)} ?disabled=${this.busy || !this.audio}
          @input=${() => { if (this.meterDrafts.delete(meter.id)) this.requestUpdate(); }}
          @change=${(event: Event) => {
            const value = (event.target as HTMLInputElement).value, match = /^\s*(\d+)\s*\/\s*(\d+)\s*$/u.exec(value);
            const numerator = Number(match?.[1]), denominator = Number(match?.[2]);
            if (!Number.isSafeInteger(numerator) || numerator < 1 || !Number.isSafeInteger(denominator) || denominator < 1
              || 2 ** Math.round(Math.log2(denominator)) !== denominator) {
              this.meterDrafts.set(meter.id, value); this.requestUpdate(); snackbar(this.t("creation.invalid_meter")); return;
            }
            this.meterDrafts.delete(meter.id);
            this.edit(project => Object.assign(project.meters.find(item => item.id === meter.id)!, { numerator, denominator }));
          }}></md-outlined-text-field>
        ${iconButton({ label: this.t("deleteMeter"), icon: "delete", disabled: this.busy || meter.tick === 0 || this.chart.meters.length === 1,
          onClick: () => this.edit(project => { project.meters = project.meters.filter(item => item.id !== meter.id); this.meterDrafts.delete(meter.id); }) })}
      </div>`)}
    </section>`;
  }
  private editingGutter(project = this.chart) { return project.laneBasis / 12; }
  private laneSpan(project = this.chart) { return (project.laneBasis + this.editingGutter(project) * 2) / this.zoomX; }
  private laneView(project = this.chart) { return { min: this.laneStart, max: this.laneStart + this.laneSpan(project) }; }
  private laneBounds(project = this.chart) {
    const padding = Math.max(this.editingGutter(project), this.defaultWidth, this.pending?.size ?? 0);
    if (this.laneBoundsSnapshot?.project !== project || this.laneBoundsSnapshot.padding !== padding)
      this.laneBoundsSnapshot = { project, padding, bounds: authoredSpanViewport(project, padding) };
    return this.laneBoundsSnapshot.bounds;
  }
  private clampLaneStart(value: number) {
    const bounds = this.laneBounds();
    return Math.max(bounds.min, Math.min(bounds.max - this.laneSpan(), value));
  }
  private setHorizontalZoom(value: number, pixel?: number) {
    if (this.gesture || this.busy) return;
    const canvas = this.querySelector<HTMLCanvasElement>(".chart-creation__editor");
    const fraction = canvas?.clientWidth ? Math.max(0, Math.min(1, (pixel ?? canvas.clientWidth / 2) / canvas.clientWidth)) : 0.5;
    const anchor = this.laneStart + fraction * this.laneSpan();
    this.zoomX = Math.max(1, Math.min(8, value));
    this.laneStart = this.clampLaneStart(anchor - fraction * this.laneSpan());
  }
  private timelineDuration() {
    if (this.timelineSnapshot?.project === this.chart && this.timelineSnapshot.audio === this.audio) return this.timelineSnapshot.duration;
    let tick = 0;
    const include = (value: number) => { tick = Math.max(tick, value); };
    this.chart.singles.forEach(note => include(note.tick));
    this.chart.lines.forEach(line => line.points.forEach(point => include(point.tick)));
    this.chart.tempos.forEach(event => include(event.tick));
    this.chart.meters.forEach(event => include(event.tick));
    this.chart.timeScales.forEach(event => include(event.tick));
    this.chart.waypoints?.forEach(point => include(point.tick));
    this.chart.markers.skill.forEach(include);
    this.chart.markers.fever.forEach(pair => pair.forEach(include));
    this.chart.markers.call.forEach(event => include(event.tick));
    const duration = Math.max(this.audio?.analysis.duration ?? 0, this.map().tickToSeconds(tick + this.chart.resolution * 8));
    this.timelineSnapshot = { project: this.chart, audio: this.audio, duration };
    return duration;
  }
  private clampStart(value: number) { return Math.max(0, value); }
  private setVerticalZoom(span: number, pixel?: number) {
    if (this.busy || this.gesture || !this.audio || this.stageMode !== "edit" || !Number.isFinite(span)) return;
    const canvas = this.querySelector<HTMLCanvasElement>(".chart-creation__editor");
    if (!canvas?.clientHeight) return;
    const height = canvas.clientHeight;
    if (pixel === undefined) {
      const selected = this.selectionNodes().find((item) => item.note.id === this.selected);
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
    if (this.gesture || this.pan) return;
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
        this.laneStart + (event.deltaY / canvas.clientWidth) * this.laneSpan(),
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
  private trackCursor(event: PointerEvent) {
    if (!event.isPrimary || this.stageMode !== "edit" || this.busy || !this.audio) return;
    this.cursor = { clientX: event.clientX, clientY: event.clientY, pointerType: event.pointerType };
    if (!this.gesture && !this.pan && !this.cursorFrame)
      this.cursorFrame = requestAnimationFrame(() => { this.cursorFrame = 0; this.paint(); });
  }
  private clearCursor() {
    cancelAnimationFrame(this.cursorFrame);
    this.cursorFrame = 0;
    this.cursor = undefined;
    const output = this.querySelector<HTMLOutputElement>("[data-cursor]");
    if (output) output.hidden = true;
    this.paint();
  }
  private leaveCursor() {
    if (!this.gesture && !this.pan) this.clearCursor();
  }
  private panMove(event: PointerEvent) {
    if (this.pastePlacement) { if (event.isPrimary) this.movePasteToClient(event); return; }
    this.trackCursor(event);
    if (this.gesture?.pointer === event.pointerId) {
      this.moveGesture(event);
      return;
    }
    if (this.pan?.pointer !== event.pointerId) return;
    const canvas = event.currentTarget as HTMLCanvasElement;
    this.laneStart = this.clampLaneStart(
      this.pan.laneStart - ((event.clientX - this.pan.x) / canvas.clientWidth) * this.laneSpan(),
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
    if (this.pastePlacement) {
      const canvas = event.currentTarget as HTMLCanvasElement;
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
      this.pastePlacement.pointer = undefined;
      return;
    }
    const captured = this.gesture?.pointer === event.pointerId || this.pan?.pointer === event.pointerId;
    if (event.type === "pointercancel" || (event.type === "lostpointercapture" && captured) || event.pointerType === "touch") this.clearCursor();
    else if (event.type === "pointerup") this.trackCursor(event);
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
    if (this.pastePlacement) {
      this.pastePlacement.pointer = event.pointerId;
      canvas.setPointerCapture(event.pointerId);
      this.movePasteToClient(event);
      return;
    }
    this.trackCursor(event);
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
    const laneSpan = this.laneSpan(chart);
    const pointerLane = viewportXToAuthoredLane(event.clientX - rect.left, rect.width, this.laneView(chart));
    const tick = Math.max(0, this.gridTick(map.secondsToTick(seconds))),
      lane = Math.round(pointerLane);
    const edgeTolerance = ((event.pointerType === "touch" ? 14 : 8) / rect.width) * laneSpan;
    if (this.tool === "node") { this.insertNodeAt(tick, pointerLane, edgeTolerance); return; }
    const selectedEdge = (item: ReturnType<typeof chartSelectionNodes>[number]) =>
      this.selectedIds.has(item.note.id) &&
      Math.min(Math.abs(pointerLane - item.lane), Math.abs(pointerLane - item.lane - item.size)) <= edgeTolerance;
    const hitNode = this.selectionNodes(chart)
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
      this.requestUpdate();
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
  private gridTick(tick: number, mode: SnapMode = "nearest") {
    return snapTick(tick, this.snap, mode, this.chart.resolution * 4);
  }
  private nudgeSelection(direction: -1 | 1, oneTick = false) {
    if (this.busy || this.gesture || !this.audio || !this.selectedIds.size) return;
    this.cancelWidth();
    try { this.commitProject(nudgeChartSelectionOnGrid(this.chart, this.selectedIds, this.selected, direction, oneTick ? this.chart.resolution * 4 : this.snap, 4)); }
    catch { this.error = this.t("creation.invalid_edit"); }
  }
  private pruneSelection() {
    const state = readAuthorCollections(this.chart);
    if ((this.collectionScope.groupId && !state.groups.some(group => group.id === this.collectionScope.groupId)) || (this.collectionScope.layerId && !state.layers.some(layer => layer.id === this.collectionScope.layerId)))
      this.collectionScope = { ...(state.groups.some(group => group.id === this.collectionScope.groupId) ? {groupId:this.collectionScope.groupId} : {}), ...(state.layers.some(layer => layer.id === this.collectionScope.layerId) ? {layerId:this.collectionScope.layerId} : {}) };
    const ids = new Set(this.selectionNodes().map((item) => item.note.id));
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
      const node = this.selectionNodes(g.base).find(
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
      if (!g.candidate || g.resizeDelta !== delta) {
        try {
          const anchor = g.kind === "resize-left" ? "right" : "left";
          g.candidate = resizeChartSelectionByDelta(g.base, g.ids, g.kind === "resize-left" ? -delta : delta, {
            anchor, grid: { step: 0.25 },
          });
          g.resizeDelta = delta;
          g.error = "";
        } catch {
          g.candidate = undefined;
          g.error = this.t("creation.invalid_edit");
        }
      }
    } else {
      const anchor = this.selectionNodes(g.base).find((item) => item.note.id === (g.resizeId ?? g.primary));
      const anchorTick = anchor?.note.tick ?? g.tick;
      const deltaTick = this.relativeSnap
        ? this.gridTick(tick - g.tick)
        : this.gridTick(anchorTick + tick - g.tick) - anchorTick;
      const laneStep = 1,
        deltaLane = this.relativeSnap
          ? Math.round((lane - g.lane) / laneStep) * laneStep
          : Math.round(((anchor?.lane ?? g.lane) + lane - g.lane) / laneStep) * laneStep - (anchor?.lane ?? g.lane);
      if (!g.candidate || deltaTick !== g.deltaTick || deltaLane !== g.deltaLane) {
        try {
          const candidate = moveChartSelection(g.base, g.ids, deltaTick, deltaLane, { placement: "overlap", grid: { step: laneStep, origin: this.relativeSnap ? 0 : -(anchor?.lane ?? g.lane) } });
          assertValidProject(candidate);
          g.candidate = candidate;
          g.deltaTick = deltaTick;
          g.deltaLane = deltaLane;
          g.error = "";
        } catch {
          g.candidate = undefined;
          g.error = this.t("creation.invalid_edit");
        }
      }
    }
    this.paint();
  }
  private cancelGesture() {
    this.cancelPaste();
    const g = this.gesture;
    if (!g) return;
    cancelAnimationFrame(this.gestureFrame);
    this.gestureFrame = 0;
    this.gesture = undefined;
    this.setSelection(g.previous, g.primary);
    this.requestUpdate();
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
    if (g.error) this.error = g.error;
    if (g.kind !== "box" && g.candidate) {
      if (!this.commitProject(g.candidate, g.mergeKey) && this.error) this.setSelection(g.previous, g.primary);
    }
    const canvas = event.currentTarget as HTMLCanvasElement;
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    this.paint();
    this.requestUpdate();
  }
  private place(tick: number, lane: number) {
    const chart = this.chart;
    if (this.tool === "node") { this.insertNodeAt(tick); return; }
    if (readAuthorCollections(chart).layers.some(layer => layer.id === this.collectionScope.layerId && !layer.visible)) {
      this.error = this.t("creation.invalid_edit"); return;
    }
    if (!authoredSpanInBounds(lane, this.defaultWidth, chart.laneBasis)) {
      this.error = this.t("creation.invalid_edit"); return;
    }
    const base = (at: number, position: number, size = this.defaultWidth): SingleNote =>
      createAuthoredNote(chart, {
        tick: at,
        lane: position,
        size,
        type: this.tool === "flick" ? "flick" : this.tool === "trace" ? "trace" : "tap",
        direction: this.tool === "flick" ? this.direction : "none",
        critical: this.critical,
        placement: "stage",
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
    const chart = this.pastePlacement?.candidate ?? this.gesture?.candidate ?? this.widthSession?.candidate ?? this.chart,
      map = this.map(),
      laneSpan = this.laneSpan(chart),
      x = (lane: number) => authoredLaneToViewportX(lane, width, this.laneView(chart)),
      w = (size: number) => (size / laneSpan) * width,
      y = (tick: number) =>
        timeToViewportY(map.tickToSeconds(tick), {
          startSeconds: this.windowStart,
          pixelsPerSecond: height / this.secondsPerScreen,
          height,
        });
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    const fullStageWidth=width*chart.laneBasis/laneSpan;
    const stageLeft = Math.max(0, x(0)), stageRight = Math.min(width, x(chart.laneBasis));
    if(this.canvasTheme){
      ctx.fillStyle=color("surface-container-high");ctx.fillRect(0,0,width,height);
      ctx.fillStyle=color("scrim");if(stageRight > stageLeft)ctx.fillRect(stageLeft,0,stageRight-stageLeft,height);
      drawChartCanvasLanePlane(ctx,{centerX:x(chart.laneBasis/2),height,laneWidth:fullStageWidth/6,styleLaneWidth:24,bandCount:6,spaceCount:3});
    } else {ctx.fillStyle=color("surface-container");ctx.fillRect(0,0,width,height);}
    ctx.strokeStyle=this.canvasTheme?.assets.palette.laneLine??color("outline-variant");ctx.lineWidth=1;
    const first = Math.max(0, Math.floor(map.secondsToBeat(this.windowStart)));
    const last = map.secondsToBeat(this.windowStart + this.secondsPerScreen);
    const drawGridLine = (beat: number, major: boolean) => {
      const at = y(beat * chart.resolution);
      ctx.globalAlpha = major ? 1 : 0.3;
      ctx.beginPath();
      ctx.moveTo(0, at);
      ctx.lineTo(width, at);
      ctx.stroke();
      if (major) {
        ctx.fillStyle = this.laneStart >= 0 && this.laneStart < chart.laneBasis ? (this.canvasTheme?.assets.palette.outsideLine ?? color("on-surface-variant")) : color("on-surface-variant");
        ctx.font = `11px ${style.getPropertyValue("--app-font").trim() || "sans-serif"}`;
        ctx.fillText(String(beat), 4, at - 14);
      }
    };
    for (let beat = first; beat <= last; beat++) drawGridLine(beat, true);
    const gridBeats = 4 / this.snap;
    for (let unit = Math.ceil(first / gridBeats); unit * gridBeats <= last; unit++) {
      const beat = unit * gridBeats;
      if (Math.abs(beat - Math.round(beat)) < 1e-8) continue;
      const at = y(beat * chart.resolution), next = y((beat + gridBeats) * chart.resolution);
      if (Math.abs(next - at) < 8) break;
      drawGridLine(beat, false);
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
    const annotations = [
      ...(chart.waypoints ?? []),
      ...chart.markers.skill.map((tick, index) => ({ tick, name: `${this.t("markers.skill")} ${index + 1}` })),
      ...chart.markers.fever.flatMap(([start, end]) => [
        { tick: start, name: `${this.t("markers.fever")} / ${this.t("markers.start")}` },
        { tick: end, name: `${this.t("markers.fever")} / ${this.t("markers.end")}` },
      ]),
      ...chart.markers.call.map(call => ({ tick: call.tick, name: this.t("markers.call") })),
    ];
    const annotationNames = new Map<number, string[]>();
    for (const point of annotations) {
      const names = annotationNames.get(point.tick) ?? [];
      names.push(point.name); annotationNames.set(point.tick, names);
    }
    const annotationGroups: { at: number; names: string[] }[] = [];
    ctx.save();
    ctx.strokeStyle = color("tertiary"); ctx.lineWidth = 1; ctx.setLineDash([6, 4]);
    for (const [tick, names] of [...annotationNames].sort((a, b) => a[0] - b[0])) {
      const at = y(tick);
      if (at < 0 || at > height) continue;
      ctx.beginPath(); ctx.moveTo(0, at); ctx.lineTo(width, at); ctx.stroke();
      const previous = annotationGroups.at(-1);
      if (previous && Math.abs(previous.at - at) < 24) previous.names.push(...names);
      else annotationGroups.push({ at, names: [...names] });
    }
    ctx.restore();
    for (const { at, names } of annotationGroups) {
      ctx.save();
      ctx.font = `${style.getPropertyValue("--md-sys-typescale-label-small-size").trim()} ${style.getPropertyValue("--app-font").trim()}`;
      let label = names.join(" / ");
      const available = Math.max(0, width - 24);
      if (ctx.measureText(label).width > available) {
        let low = 0, high = label.length;
        while (low < high) {
          const middle = Math.ceil((low + high) / 2);
          if (ctx.measureText(label.slice(0, middle) + "…").width <= available) low = middle;
          else high = middle - 1;
        }
        if (low > 0 && /[\uD800-\uDBFF]/u.test(label[low - 1]!)) low--;
        label = label.slice(0, low) + "…";
      }
      const labelWidth = ctx.measureText(label).width;
      ctx.fillStyle = color("surface-container-high"); ctx.fillRect(8, at - 24, labelWidth + 8, 20);
      ctx.fillStyle = color("on-surface"); ctx.fillText(label, 12, at - 10);
      ctx.restore();
    }
    const previewing = chart !== this.chart;
    const display = this.editingProject(chart);
    const projection=this.flatProjection(display);
    const baseNodes = previewing ? new Map(this.selectionNodes(this.chart).map(item => [item.note.id, item])) : undefined;
    const changed = new Set(previewing ? this.selectionNodes(chart).filter(item => {
      const old = baseNodes?.get(item.note.id);
      return !old || old.lane !== item.lane || old.size !== item.size || old.note.tick !== item.note.tick ||
        old.note.type !== item.note.type || old.note.direction !== item.note.direction || old.note.visible !== item.note.visible;
    }).map(item => item.note.id) : []);
    const skin=this.canvasTheme?.skin;
    const nativeY=(timeMs:number)=>timeToViewportY(timeMs/1000+chart.audioOffset,{startSeconds:this.windowStart,pixelsPerSecond:height/this.secondsPerScreen,height});
    const scale=skin?.scaleForFlatNoteBodyHeight(fullStageWidth,18)??1;
    if(skin&&projection){
      ctx.save();
      const changedNative = new Set([...changed].flatMap(id => projection.sourceMap.notesForCanonical(id)));
      const native=projection.chart, byId=new Map(native.notes.map(note=>[note.id,note]));
      for(const line of native.lines){
        ctx.globalAlpha = previewing && !line.noteIds.some(id => changedNative.has(id)) ? 0.4 : 1;
        const points=line.noteIds.map(id=>byId.get(id)).filter((note):note is ChartNote=>Boolean(note)&&note!.indexInLine!==null).sort((a,b)=>a.timeMs-b.timeMs||a.id-b.id);
        if(points.length<2)continue;
        const top=nativeY(points.at(-1)!.timeMs),lineHeight=nativeY(points[0].timeMs)-top;
        const style=createChartCanvasRibbonStyle(ctx,line.kind==="guide"?"guide":"slide",lineHeight,24,top,skin.slideLineStyle);
        for(let i=1;i<points.length;i++){
          const head=points[i-1],tail=points[i];
          const start=Math.max(head.timeMs,(this.windowStart-chart.audioOffset)*1000),end=Math.min(tail.timeMs,(this.windowStart+this.secondsPerScreen-chart.audioOffset)*1000);
          if(end<=start)continue;
          const steps=Math.max(2,Math.ceil((end-start)/25)),samples=[];
          for(let step=0;step<=steps;step++){const time=start+(end-start)*step/steps,shape=interpolateNoteLine(head,tail,time);samples.push({left:x(shape.pos/24*chart.laneBasis),right:x((shape.pos+shape.size)/24*chart.laneBasis),y:nativeY(time)})}
          drawChartCanvasRibbon(ctx,samples,style,.6);
        }
      }
      for(const note of native.notes){
        const at=nativeY(note.timeMs);if(!note.visible||at < -32 || at > height+32)continue;
        ctx.globalAlpha = previewing && !changedNative.has(note.id) ? 0.4 : 1;
        const appearance=ourNotesCreationCanvasNoteAppearance(note);
        skin.drawFlatNote(ctx,{kind:appearance.kind,direction:appearance.direction,centerX:x((note.pos+note.size/2)/24*chart.laneBasis),centerY:at,width:Math.max(.5,w(note.size/24*chart.laneBasis)),laneSpan:note.size,stageWidth:fullStageWidth,scale});
      }
      ctx.restore();
    }
    if (previewing && !projection) {
      ctx.save();
      ctx.strokeStyle = this.canvasTheme?.assets.palette.outsideLine ?? color("primary");
      ctx.lineWidth = 1.5;ctx.setLineDash([5, 5]);
      for (const line of display.lines) {
        if (!line.points.some(point => changed.has(point.id))) continue;
        ctx.beginPath();
        line.points.forEach((point, index) => {
          const shape = resolveLinePointShape(line.points, index);
          if (index) ctx.lineTo(x(shape.lane + shape.size / 2), y(point.tick));
          else ctx.moveTo(x(shape.lane + shape.size / 2), y(point.tick));
        });
        ctx.stroke();
      }
      ctx.restore();
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
    for(const line of display.lines)line.points.forEach((note,i)=>{const shape=resolveLinePointShape(line.points,i);overlay(note,shape.lane,shape.size,line.kind==="guide"?"guide":i===0?"slide-start":i===line.points.length-1?"slide-end":"slide-node")});
    for(const note of display.singles)overlay(note,note.lane,note.size);
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
    const cursorOutput = this.querySelector<HTMLOutputElement>("[data-cursor]");
    const rect = canvas.getBoundingClientRect();
    const cursorX = this.cursor ? this.cursor.clientX - rect.left : -1;
    const cursorY = this.cursor ? this.cursor.clientY - rect.top : -1;
    const showCursor = Boolean(!this.pastePlacement && this.cursor && this.stageMode === "edit" && !this.busy && this.canvasTheme &&
      cursorX >= 0 && cursorX <= width && cursorY >= 0 && cursorY <= height);
    if (cursorOutput) cursorOutput.hidden = !showCursor;
    if (showCursor) {
      const seconds = this.windowStart + (1 - cursorY / height) * this.secondsPerScreen;
      const action = this.gesture;
      const edited = action && ["move", "resize-left", "resize-right"].includes(action.kind)
        ? this.selectionNodes(chart).find(item => item.note.id === (action.resizeId ?? action.primary)) : undefined;
      const tick = edited?.note.tick ?? Math.max(0, this.gridTick(map.secondsToTick(seconds)));
      const lane = edited?.lane ?? Math.round(viewportXToAuthoredLane(cursorX, width, this.laneView(chart)));
      const cursorLane = action?.kind === "resize-right" && edited ? lane + edited.size : lane;
      const at = y(tick);
      const nodeTarget = !action && !this.widthSession && this.tool === "node" ? this.nodeTarget(tick, viewportXToAuthoredLane(cursorX, width, this.laneView(chart)), 14 / width * laneSpan) : undefined;
      if (nodeTarget) {
        ctx.save();
        ctx.strokeStyle = color("primary"); ctx.lineWidth = 2; ctx.setLineDash([4, 4]);
        ctx.strokeRect(x(nodeTarget.lane) - 2, at - 14, Math.max(4, w(nodeTarget.size)) + 4, 28);
        ctx.restore();
      }
      if (!action && !this.pan && ["tap", "flick", "trace", "hold", "guide"].includes(this.tool)) {
        const valid = authoredSpanInBounds(lane, this.defaultWidth, chart.laneBasis);
        ctx.save();
        if (valid && skin) {
          ctx.globalAlpha = 0.65;
          const kind: RenderNoteKind = this.tool === "flick" ? (this.direction === "left" ? "flick-left" : this.direction === "right" ? "flick-right" : "flick")
            : this.tool === "trace" ? "trace" : this.tool === "guide" ? "guide" : this.tool === "hold" ? "slide-start" : "tap";
          skin.drawFlatNote(ctx, { kind, direction: this.tool === "flick" ? this.direction : "none",
            centerX: x(lane + this.defaultWidth / 2), centerY: at, width: Math.max(0.5, w(this.defaultWidth)),
            laneSpan: this.defaultWidth / chart.laneBasis * 24, stageWidth: fullStageWidth, scale });
        }
        ctx.globalAlpha = 1;
        ctx.strokeStyle = valid ? (this.canvasTheme?.assets.palette.outsideLine ?? color("primary")) : color("error");
        ctx.lineWidth = 2;ctx.setLineDash([4, 4]);
        ctx.strokeRect(x(lane), at - 12, Math.max(2, w(this.defaultWidth)), 24);
        ctx.restore();
      }
      ctx.save();
      ctx.strokeStyle = this.canvasTheme?.assets.palette.outsideLine ?? color("primary");
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();ctx.moveTo(0, at);ctx.lineTo(width, at);ctx.moveTo(x(cursorLane), 0);ctx.lineTo(x(cursorLane), height);ctx.stroke();
      ctx.restore();
      if (cursorOutput) cursorOutput.textContent = `${map.tickToSeconds(tick).toFixed(3)} s / ${this.t("beat")} ${tick / chart.resolution} / ${this.t("lane")} ${Number(lane.toFixed(2))}${edited ? ` / ${this.t("width")} ${Number(edited.size.toFixed(2))}` : ""}${lane < 0 || lane > chart.laneBasis ? ` / ${this.t("creation.outside_stage")}` : ""}${action?.error ? ` / ${action.error}` : ""}`;
      const nearby = this.selectionNodes(chart).find(item => this.selectedIds.has(item.note.id) &&
        Math.abs(y(item.note.tick) - cursorY) <= 12 &&
        Math.min(Math.abs(x(item.lane) - cursorX), Math.abs(x(item.lane + item.size) - cursorX)) <= 8);
      canvas.style.cursor = this.tool === "pan" ? (this.pan ? "grabbing" : "grab") :
        this.tool === "select" && nearby ? "ew-resize" : this.tool === "node" ? nodeTarget ? "copy" : "not-allowed" : "crosshair";
      if (this.tool === "node" && cursorOutput && !nodeTarget) cursorOutput.textContent = this.t("creation.node_missing");
    } else canvas.style.cursor = this.tool === "pan" ? "grab" : "crosshair";
    if (this.pastePlacement) {
      const placement = this.pastePlacement;
      canvas.style.cursor = placement.error ? "not-allowed" : "copy";
      const ids = new Set(placement.ids);
      ctx.strokeStyle = color(placement.error ? "error" : "primary");
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 4]);
      for (const node of chartSelectionNodes(chart).filter(item => ids.has(item.note.id)))
        ctx.strokeRect(x(node.lane) - 2, y(node.note.tick) - 14, Math.max(2, w(node.size)) + 4, 28);
      ctx.setLineDash([]);
      if (cursorOutput) {
        cursorOutput.hidden = false;
        cursorOutput.textContent = placement.error || `${this.t("beat")} ${placement.tick / chart.resolution} / ${this.t("tick")} ${placement.tick}`;
      }
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
      void this.disposePreview().then(() => {
        if (!this.isConnected) return;
        this.stageMode = "edit";
        this.rebuildPreview(this.seconds);
      });
    }
  }
  private commitProject(candidate: Project, mergeKey?: string): boolean {
    if (this.busy || this.gesture || this.pastePlacement) return false;
    this.cancelWidth();
    try {
      candidate = reconcileAuthorEdit(this.chart, candidate);
      const previousIds = authorEntityIds(this.chart), state = readAuthorCollections(candidate);
      const added = new Set([...authorEntityIds(candidate)].filter(id => !previousIds.has(id)));
      if (state.groups.some(group => group.id === this.collectionScope.groupId))
        candidate = assignAuthorSelection(candidate, new Set([...added].filter(id => !state.members[id]?.groupId)), { groupId: this.collectionScope.groupId });
      if (state.layers.some(layer => layer.id === this.collectionScope.layerId))
        candidate = assignAuthorSelection(candidate, new Set([...added].filter(id => !state.members[id]?.layerId)), { layerId: this.collectionScope.layerId });
      assertValidProject(candidate); readAuthorCollections(candidate);
      assertEditedChartSpans(this.chart, candidate);
      const compiled = !candidate.meta.source || ["ss", "authored"].includes(candidate.meta.source)
        ? compileOurNotesCreation(candidate) : undefined;
      const revision = this.history.revision;
      this.history.replace(candidate, mergeKey ? { mergeKey } : {});
      this.history.endMerge();
      this.error = "";
      if (revision === this.history.revision) return false;
      this.flatChart = compiled ? { project: this.chart, value: compiled } : undefined;
      this.pruneSelection();
      this.dirty = true;
      this.status = "";
      this.rebuildPreview();
      this.requestUpdate();
      return true;
    } catch (error) {
      this.error = this.t(error instanceof AuthorNativeSpeedError ? "creation.profile_conflict" : "creation.invalid_edit");
      this.paint();
      this.requestUpdate();
      return false;
    }
  }
  private copySegments() {
    if (!this.chart.lines.some(line => line.points.filter(point => this.selectedIds.has(point.id)).length >= 2)) return;
    this.clipboard = copyAuthorSegments(this.chart, this.selectedIds);
    this.requestUpdate();
  }
  private cutSelection() {
    if (this.busy || this.gesture || !this.selectedIds.size) return;
    const clipboard = copyAuthorSelection(this.chart, this.selectedIds), candidate = structuredClone(this.chart);
    deleteChartSelectionGroup(candidate, this.selectedIds);
    if (this.commitProject(candidate)) this.clipboard = clipboard;
  }
  private pasteSelection(mirrored = false) {
    if (this.clipboard) this.beginPaste(mirrored ? mirrorAuthorClipboard(this.clipboard) : this.clipboard);
  }
  private duplicateSelection(mirrored = false) {
    if (!this.selectedIds.size || this.busy || this.gesture) return;
    const clipboard = copyAuthorSelection(this.chart, this.selectedIds);
    this.beginPaste(mirrored ? mirrorAuthorClipboard(clipboard) : clipboard);
  }
  private joinLines() {
    try {
      const result = joinNoteLines(this.chart, this.selectedIds);
      if (this.commitProject(result.project)) this.setSelection(result.ids);
    } catch (error) {
      snackbar(this.t(error instanceof Error && error.message === "connector_speed_conflict"
        ? "creation.join_speed_conflict" : "creation.invalid_edit"));
    }
  }
  private splitLine() {
    try {
      const shape = this.selectionNodes().find(item => this.selectedIds.has(item.note.id));
      const result = splitNoteLine(this.chart, this.selectedIds, shape);
      if (this.commitProject(result.project)) this.setSelection(result.ids);
    } catch { snackbar(this.t("creation.invalid_edit")); }
  }
  private beginPaste(clipboard: AuthorClipboard) {
    if (this.busy || !this.audio || this.stageMode !== "edit") return;
    this.cancelGesture();
    this.cancelWidth();
    this.pausePlayback();
    this.closePanels();
    this.clearCursor();
    const tick = Math.max(0, this.gridTick(this.map().secondsToTick(this.seconds)));
    try {
      const pasted = pasteAuthorSelection(this.chart, clipboard, tick);
      const ids = new Set(pasted.ids), nodes = chartSelectionNodes(pasted.project).filter(item => ids.has(item.note.id));
      if (!nodes.length) return;
      const left = Math.min(...nodes.map(item => item.lane));
      const width = Math.max(...nodes.map(item => item.lane + item.size)) - left;
      this.pastePlacement = { base: this.chart, clipboard, tick, laneShift: 0, left, width, ids: pasted.ids, candidate: pasted.project, error: "" };
      this.updatePaste(tick, 0);
      void this.updateComplete.then(() => {
        if (this.isConnected && this.pastePlacement) this.querySelector<HTMLElement>(".chart-creation__editor")?.focus({ preventScroll: true });
      });
    } catch { this.error = this.t("patterns.invalid_pattern"); }
  }
  private updatePaste(tick: number, laneShift: number) {
    const placement = this.pastePlacement;
    if (!placement) return;
    const previousError = placement.error;
    placement.tick = tick;
    placement.laneShift = laneShift;
    try {
      const pasted = pasteAuthorSelection(placement.base, placement.clipboard, tick, laneShift);
      placement.candidate = pasted.project;
      placement.ids = pasted.ids;
      assertEditedChartSpans(placement.base, pasted.project);
      placement.error = "";
    } catch { placement.error = this.t("patterns.outside_stage"); }
    if (previousError !== placement.error) this.requestUpdate();
    this.paint();
  }
  private movePasteToClient(point: { clientX: number; clientY: number }) {
    const placement = this.pastePlacement, canvas = this.querySelector<HTMLCanvasElement>(".chart-creation__editor");
    if (!placement || !canvas) return;
    const rect = canvas.getBoundingClientRect();
    const seconds = this.windowStart + (1 - (point.clientY - rect.top) / rect.height) * this.secondsPerScreen;
    const lane = viewportXToAuthoredLane(point.clientX - rect.left, rect.width, this.laneView());
    const tick = Math.max(0, this.gridTick(this.map().secondsToTick(seconds)));
    const shift = Math.round((lane - placement.width / 2 - placement.left) * 4) / 4;
    if (tick !== placement.tick || shift !== placement.laneShift) this.updatePaste(tick, shift);
  }
  private cancelPaste() {
    if (!this.pastePlacement) return;
    const canvas = this.querySelector<HTMLCanvasElement>(".chart-creation__editor");
    const pointer = this.pastePlacement.pointer;
    this.pastePlacement = undefined;
    if (pointer !== undefined && canvas?.hasPointerCapture(pointer)) canvas.releasePointerCapture(pointer);
    this.requestUpdate();
    this.paint();
  }
  private confirmPaste() {
    const placement = this.pastePlacement;
    if (!placement?.candidate || placement.error || placement.base !== this.chart) return;
    const candidate = placement.candidate;
    const ids = new Set(placement.ids);
    const notes = chartSelectionNodes(candidate).filter(item => ids.has(item.note.id)).map(item => item.note.id);
    this.pastePlacement = undefined;
    if (this.commitProject(candidate)) this.setSelection(notes);
    this.requestUpdate();
  }
  private compressSelection(anchor: "first" | "last") {
    if (this.busy || this.pastePlacement || this.gesture) return;
    try { this.commitProject(compressChartSelection(this.chart, this.selectedIds, anchor)); }
    catch { this.error = this.t("patterns.order_conflict"); }
  }
  private selectConnectors() {
    const lines = this.selectedConnectorIds();
    this.setSelection([...this.selectedIds, ...this.chart.lines.filter(line => lines.has(line.id)).flatMap(line => line.points.map(point => point.id))]);
  }
  private async showPatterns() {
    if (this.busy || this.stageMode !== "edit") return;
    this.cancelGesture();
    this.cancelWidth();
    this.closePanels();
    this.patternOpen = true;
    this.patternBusy = true;
    this.patternError = "";
    try { this.patterns = await this.patternStore.list(); }
    catch { this.patternError = this.t("patterns.storage_failed"); }
    finally { this.patternBusy = false; }
  }
  private async savePattern() {
    const name = this.patternName.trim();
    if (!name) { this.patternError = this.t("patterns.name_required"); return; }
    if (this.patternBusy || !this.selectedIds.size) return;
    this.patternBusy = true;
    this.patternError = "";
    try {
      const pattern: ChartPattern = { id: crypto.randomUUID(), name, updatedAt: Date.now(), clipboard: copyAuthorSelection(this.chart, this.selectedIds) };
      await this.patternStore.save(pattern);
      this.patterns = await this.patternStore.list();
      this.selectedPattern = pattern.id;
      this.patternName = "";
    } catch { this.patternError = this.t("patterns.storage_failed"); }
    finally { this.patternBusy = false; }
  }
  private async deletePattern() {
    if (this.patternBusy || this.selectedPattern === "one-tick-flick") return;
    this.patternBusy = true;
    this.patternError = "";
    try {
      await this.patternStore.delete(this.selectedPattern);
      this.patterns = await this.patternStore.list();
      this.selectedPattern = "one-tick-flick";
    } catch { this.patternError = this.t("patterns.storage_failed"); }
    finally { this.patternBusy = false; }
  }
  private async renamePattern() {
    const pattern = this.patterns.find(pattern => pattern.id === this.selectedPattern), name = this.patternName.trim();
    if (!pattern || !name || this.patternBusy) return;
    this.patternBusy = true;
    this.patternError = "";
    try {
      await this.patternStore.save({ ...pattern, name, updatedAt: Date.now() });
      this.patterns = await this.patternStore.list();
      this.patternName = "";
    } catch { this.patternError = this.t("patterns.storage_failed"); }
    finally { this.patternBusy = false; }
  }
  private async importPattern(event: Event) {
    const input = event.target as HTMLInputElement, file = input.files?.[0];
    input.value = "";
    if (!file || this.patternBusy) return;
    this.patternBusy = true;
    this.patternError = "";
    try {
      if (file.size > 4 * 1024 * 1024) throw new Error("pattern_size");
      const pattern = parseChartPattern(await file.text());
      await this.patternStore.save(pattern);
      this.patterns = await this.patternStore.list();
      this.selectedPattern = pattern.id;
      this.patternName = "";
    } catch { this.patternError = this.t("patterns.invalid_pattern"); }
    finally { this.patternBusy = false; }
  }
  private exportPattern() {
    const pattern = this.patterns.find(pattern => pattern.id === this.selectedPattern);
    if (!pattern) return;
    downloadBlob(new Blob([serializeChartPattern(pattern)], { type: "application/json" }), "chart-pattern.json");
  }
  private applyPattern() {
    let clipboard = this.patterns.find(pattern => pattern.id === this.selectedPattern)?.clipboard;
    if (this.selectedPattern === "one-tick-flick") {
      const project = createEmptyProject({ source: "authored" });
      project.laneBasis = this.chart.laneBasis;
      const points: LinePoint[] = [0, 1].map((tick, index) => ({
        id: createProjectId("pattern-note"), tick, lane: 0, size: this.defaultWidth,
        type: index ? "flick" : "tap", critical: index === 1, direction: index ? "up" : "none", visible: true,
        ease: { left: "linear", right: "linear" },
      }));
      project.lines.push({ id: createProjectId("pattern-line"), kind: "long", points });
      clipboard = copyAuthorSelection(project, new Set(points.map(point => point.id)));
    }
    if (clipboard) { this.patternOpen = false; this.beginPaste(clipboard); }
  }
  private renderPatterns() {
    if (!this.patternOpen) return nothing;
    return html`<dialog class="dialog chart-studio__patterns" aria-label=${this.t("patterns.title")}
      ${modal(() => { this.patternOpen = false; })}>
      <header class="dialog__header"><h2>${this.t("patterns.title")}</h2></header>
      <div class="dialog__body stack">
        <md-outlined-select data-pattern-picker label=${this.t("patterns.saved")} .value=${live(this.selectedPattern)}
          ?disabled=${this.patternBusy} @change=${(event: Event) => { this.selectedPattern = (event.target as HTMLSelectElement).value; }}>
          <md-select-option value="one-tick-flick" .selected=${this.selectedPattern === "one-tick-flick"}><div slot="headline">${this.t("patterns.short_flick")}</div></md-select-option>
          ${this.patterns.map(pattern => html`<md-select-option value=${pattern.id} .selected=${this.selectedPattern === pattern.id}><div slot="headline">${pattern.name}</div></md-select-option>`)}
        </md-outlined-select>
        <div class="cluster">
          <button class="button button--filled" type="button" ?disabled=${this.patternBusy || !this.audio} @click=${() => this.applyPattern()}>${this.t("patterns.apply")}</button>
          <button class="button button--text" type="button" ?disabled=${this.patternBusy || this.selectedPattern === "one-tick-flick"} @click=${() => void this.deletePattern()}>${this.t("patterns.delete")}</button>
          <button class="button button--text" type="button" ?disabled=${this.patternBusy || this.selectedPattern === "one-tick-flick"} @click=${() => this.exportPattern()}>${this.c("export")}</button>
          <button class="button button--text" type="button" ?disabled=${this.patternBusy} @click=${() => this.pick("[data-pattern-import]")}>${this.t("patterns.import")}</button>
          <input type="file" accept=".json,application/json" hidden data-pattern-import @change=${(event: Event) => void this.importPattern(event)}>
        </div>
        <md-outlined-text-field label=${this.t("patterns.name")} .value=${live(this.patternName)} maxlength="80"
          ?disabled=${this.patternBusy} .error=${this.patternError === this.t("patterns.name_required")}
          @input=${(event: Event) => { this.patternName = (event.target as HTMLInputElement).value; this.patternError = ""; }}></md-outlined-text-field>
        <button class="button button--tonal" type="button" ?disabled=${this.patternBusy || !this.audio || !this.selectedIds.size} @click=${() => void this.savePattern()}>${this.t("patterns.save_selection")}</button>
        <button class="button button--text" type="button" ?disabled=${this.patternBusy || this.selectedPattern === "one-tick-flick" || !this.patternName.trim()}
          @click=${() => void this.renamePattern()}>${this.t("patterns.rename")}</button>
        <output class="chart-studio__dialog-status" role="status">${this.patternError}</output>
      </div>
      <footer class="dialog__actions"><button class="button button--text" type="button"
        @click=${() => { this.patternOpen = false; }}>${this.c("close")}</button></footer>
    </dialog>`;
  }
  private shortcutLabel(id: string) {
    return chartShortcutBindings(this.shortcutOverrides, id).map(displayChartShortcut).join(" / ");
  }
  private shortcutCommandLabel(command: typeof chartShortcutCommands[number]) {
    return command.id.startsWith("grid:") ? command.label : this.t(command.label);
  }
  private saveShortcut(id: string, bindings: string[]) {
    const overrides = { ...this.shortcutOverrides, [id]: bindings };
    try {
      writeChartShortcuts(overrides);
      this.shortcutOverrides = overrides;
      this.recordingShortcut = undefined;
      this.shortcutError = "";
    } catch { this.shortcutError = this.t("shortcuts.storage_failed"); }
    this.requestUpdate();
  }
  private recordShortcut(event: KeyboardEvent, id: string, index: number) {
    if (this.recordingShortcut?.id !== id || this.recordingShortcut.index !== index) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape") { this.recordingShortcut = undefined; this.requestUpdate(); return; }
    const binding = shortcutForEvent(event);
    if (!binding || event.repeat) return;
    const conflict = chartShortcutCommands.find(command => command.id !== id
      && chartShortcutBindings(this.shortcutOverrides, command.id).includes(binding));
    if (conflict) {
      this.shortcutError = `${this.t("shortcuts.conflict")} / ${this.shortcutCommandLabel(conflict)}`;
      this.requestUpdate();
      return;
    }
    const bindings = [...chartShortcutBindings(this.shortcutOverrides, id)];
    bindings[index] = binding;
    this.saveShortcut(id, [...new Set(bindings)]);
  }
  private showShortcuts() {
    this.cancelGesture(); this.cancelWidth(); this.closePanels();
    this.recordingShortcut = undefined; this.shortcutError = ""; this.shortcutsOpen = true;
    this.requestUpdate();
  }
  private renderShortcuts() {
    if (!this.shortcutsOpen) return nothing;
    const recording = (id: string, index: number) => {
      this.recordingShortcut = { id, index }; this.shortcutError = ""; this.requestUpdate();
    };
    return html`<dialog class="dialog" aria-label=${this.t("shortcuts.title")}
      ${modal(() => { this.shortcutsOpen = false; this.recordingShortcut = undefined; this.requestUpdate(); })}>
      <header class="dialog__header"><h2>${this.t("shortcuts.title")}</h2><output class="chart-studio__dialog-status" role="status">${this.shortcutError}</output></header>
      <div class="dialog__body">
        <div class="stack">
          ${chartShortcutCommands.map(command => {
            const bindings = chartShortcutBindings(this.shortcutOverrides, command.id), label = this.shortcutCommandLabel(command);
            const bindingButton = (binding: string | undefined, index: number) => html`<button class="button button--tonal" type="button"
              aria-label=${`${label} / ${binding ? displayChartShortcut(binding) : this.t("shortcuts.add")}`}
              @click=${() => recording(command.id, index)} @keydown=${(event: KeyboardEvent) => this.recordShortcut(event, command.id, index)}>
              ${this.recordingShortcut?.id === command.id && this.recordingShortcut.index === index ? this.t("shortcuts.recording") : binding ? displayChartShortcut(binding) : this.t("shortcuts.add")}
            </button>`;
            return html`<div class="stack stack--tight" role="group" aria-label=${label}><span>${label}</span><div class="cluster">
              ${bindings.map((binding, index) => html`<div class="cluster">
                ${bindingButton(binding, index)}${iconButton({ label: `${this.t("shortcuts.clear")} / ${label} / ${displayChartShortcut(binding)}`, icon: "close",
                  onClick: () => this.saveShortcut(command.id, bindings.filter((_, i) => i !== index)) })}
              </div>`)}
              ${bindings.length < 4 ? bindingButton(undefined, bindings.length) : nothing}
            </div></div>`;
          })}
        </div>
      </div>
      <footer class="dialog__actions">
        <button class="button button--text" type="button" @click=${() => {
          try { writeChartShortcuts({}); this.shortcutOverrides = {}; this.recordingShortcut = undefined; this.shortcutError = ""; }
          catch { this.shortcutError = this.t("shortcuts.storage_failed"); }
          this.requestUpdate();
        }}>${this.t("shortcuts.reset")}</button>
        <button class="button button--text" type="button" @click=${() => { this.shortcutsOpen = false; this.recordingShortcut = undefined; this.requestUpdate(); }}>${this.c("close")}</button>
      </footer>
    </dialog>`;
  }
  private copyBrush() {
    if (this.busy || this.gesture || this.pan) return;
    const node = this.selectionNodes().find((item) => item.note.id === this.selected);
    if (!node) return;
    this.brushPreset = {
      type: node.note.type,
      direction: node.note.direction,
      critical: node.note.critical,
      visible: node.note.visible,
      ...("ease" in node.note ? { ease: { ...node.note.ease } } : {}),
    };
    this.setDefaultWidth(node.size);
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
    const result = generateLinePoints(project, lines, this.snap, 4);
    if (this.commitProject(result.project)) this.setSelection(result.created);
    this.requestUpdate();
  }
  private repeatNodes() {
    try {
      const result = repeatLinePattern(this.chart, this.selectedIds);
      if (this.commitProject(result.project)) this.setSelection(result.ids);
    } catch (error) { this.lineToolError(error); }
  }
  private createLineTraces(keepLines: boolean) {
    try {
      const result = lineTraces(this.chart, this.selectedConnectorIds(), this.snap, { keepLines, sample: this.lineSampler(this.chart) });
      if (this.commitProject(result.project)) this.setSelection(result.ids);
    } catch (error) { this.lineToolError(error); }
  }
  private lineToolError(error: unknown) {
    snackbar(this.t(error instanceof Error && error.message === "too_many_generated_notes"
      ? "creation.generation_limit" : "creation.invalid_edit"));
  }
  private interpolateSpeeds() {
    try { this.commitProject(interpolateChartTimeScales(this.chart, this.selectedSpeeds, this.snap)); }
    catch (error) { this.lineToolError(error); }
  }
  private jumpToWaypoint(tick: number) {
    const seconds = this.map().tickToSeconds(tick);
    this.seekPlayback(seconds, true);
    this.windowStart = this.clampStart(seconds - this.secondsPerScreen * 0.25);
    this.requestUpdate();
  }
  private stepWaypoint(direction: -1 | 1) {
    const tick = this.map().secondsToTick(this.seconds), points = [...(this.chart.waypoints ?? [])].sort((a, b) => a.tick - b.tick);
    const target = direction > 0 ? points.find(point => point.tick > tick + 0.01) : points.findLast(point => point.tick < tick - 0.01);
    if (target) this.jumpToWaypoint(target.tick);
  }
  private renderStatistics() {
    return accordion({ id: "chart-statistics", label: this.t("statistics.title"), expanded: this.statisticsOpen,
      onExpandedChange: expanded => { this.statisticsOpen = expanded; this.requestUpdate(); },
      content: html`<dl class="spec-list">${this.statisticsFacts().map(([label, value]) => html`<div><dt>${label}</dt><dd>${value}</dd></div>`)}</dl>` });
  }
  private statisticsFacts() {
    if (this.statisticsSnapshot?.project === this.chart && this.statisticsSnapshot.audio === this.audio && this.statisticsSnapshot.locale === this.locale)
      return this.statisticsSnapshot.facts;
    const chart = this.chart, points = [...chart.singles, ...chart.lines.flatMap(line => line.points)];
    const projection = this.flatProjection(chart), bpm = chart.tempos.map(event => event.bpm);
    const facts: [string, string | number][] = [
      [this.t("statistics.authored"), points.length],
      ["COMBO", projection?.chart.notes.filter(note => note.judged).length ?? "—"],
      [this.t("tap"), chart.singles.filter(note => note.type === "tap").length],
      ...(["flick", "trace"] as const).map(type => [this.t(type), points.filter(note => note.type === type).length] as [string, number]),
      [this.t("hold"), chart.lines.filter(line => line.kind === "long").length],
      [this.t("guide"), chart.lines.filter(line => line.kind === "guide").length],
      [this.t("node"), chart.lines.reduce((sum, line) => sum + line.points.length - 2, 0)],
      [this.t("creation.bpm"), Math.min(...bpm) === Math.max(...bpm) ? bpm[0]! : `${Math.min(...bpm)}–${Math.max(...bpm)}`],
      [this.t("statistics.duration"), `${(this.audio?.analysis.duration ?? 0).toFixed(2)} s`],
    ];
    this.statisticsSnapshot = { project: chart, audio: this.audio, locale: this.locale, facts };
    return facts;
  }
  private renderGameMarkers() {
    const at = () => Math.max(0, Math.round(this.map().secondsToTick(this.seconds)));
    const remove = (key: "skill" | "fever" | "call", index: number) => iconButton({
      label: this.t(`markers.delete_${key}`), icon: "delete", disabled: this.busy,
      onClick: () => this.edit(project => { project.markers[key].splice(index, 1); }),
    });
    return accordion({ id: "chart-game-markers", label: this.t("markers.title"), expanded: this.gameMarkersOpen,
      onExpandedChange: expanded => { this.gameMarkersOpen = expanded; this.requestUpdate(); }, content: html`
      <section class="stack" aria-label=${this.t("markers.skill")}>
        <h3 class="detail-section-title">${this.t("markers.skill")}</h3>
        <button class="button button--tonal" type="button" ?disabled=${this.busy || !this.audio}
          @click=${() => this.edit(project => { project.markers.skill.push(at()); })}>${this.t("markers.add_skill")}</button>
        ${this.chart.markers.skill.map((tick, index) => html`<div class="chart-creation__form">
          ${this.beatField(tick, tick => this.edit(project => { project.markers.skill[index] = tick; }))}${remove("skill", index)}
        </div>`)}
      </section>
      <section class="stack" aria-label=${this.t("markers.fever")}>
        <h3 class="detail-section-title">${this.t("markers.fever")}</h3>
        <button class="button button--tonal" type="button" ?disabled=${this.busy || !this.audio}
          @click=${() => this.edit(project => { const tick = at(); project.markers.fever.push([tick, tick + project.resolution * 4]); })}>${this.t("markers.add_fever")}</button>
        ${this.chart.markers.fever.map((pair, index) => html`<div class="chart-creation__form">
          ${([0, 1] as const).map(edge => this.field(edge ? "markers.end" : "markers.start", pair[edge] / this.chart.resolution, value => this.edit(project => {
            const tick = parseBeatTick(value, project.resolution);
            if (edge ? tick < pair[0] : tick > pair[1]) throw new RangeError("fever_order");
            project.markers.fever[index]![edge] = tick;
          })))}${remove("fever", index)}
        </div>`)}
      </section>
      <section class="stack" aria-label=${this.t("markers.call")}>
        <h3 class="detail-section-title">${this.t("markers.call")}</h3>
        <button class="button button--tonal" type="button" ?disabled=${this.busy || !this.audio}
          @click=${() => this.edit(project => { project.markers.call.push({ tick: at(), timing: [1, 1, 1, 1] }); })}>${this.t("markers.add_call")}</button>
        ${this.chart.markers.call.map((call, index) => html`<div class="chart-creation__form">
          ${this.beatField(call.tick, tick => this.edit(project => { project.markers.call[index]!.tick = tick; }))}
          ${this.field("markers.rhythm", call.timing.join(" "), value => this.edit(project => {
            const values = value.trim() ? value.trim().split(/[\s,，]+/u).map(Number) : [];
            if (values.some(value => value !== 0 && value !== 1)) throw new RangeError("call_rhythm");
            project.markers.call[index]!.timing = values;
          }))}${remove("call", index)}
        </div>`)}
      </section>` });
  }
  private renderWaypoints() {
    return html`<section class="stack" aria-label=${this.t("creation.waypoints")}>
      <h3 class="detail-section-title">${this.t("creation.waypoints")}</h3>
      <div class="chart-creation__actions">
        <button class="button button--tonal" type="button" ?disabled=${this.busy || !this.audio} @click=${() => this.edit(project => {
          const waypoints = project.waypoints ??= [];
          waypoints.push({ id: createProjectId("waypoint"), tick: Math.max(0, Math.round(this.map().secondsToTick(this.seconds))),
            name: `${this.t("creation.waypoint")} ${waypoints.length + 1}` });
          waypoints.sort((a, b) => a.tick - b.tick);
        })}>${this.t("creation.add_waypoint")}</button>
        ${([-1, 1] as const).map(direction => iconButton({ label: this.t(direction < 0 ? "creation.previous_waypoint" : "creation.next_waypoint"),
          shortcut: this.shortcutLabel(direction < 0 ? "previous_waypoint" : "next_waypoint"), icon: direction < 0 ? "arrow_downward" : "arrow_upward",
          disabled: this.busy || !this.audio || !this.chart.waypoints?.length, onClick: () => this.stepWaypoint(direction) }))}
      </div>
      ${(this.chart.waypoints ?? []).map(point => html`<div class="chart-creation__form">
        ${this.field("creation.waypoint_name", point.name, name => this.edit(project => { project.waypoints!.find(item => item.id === point.id)!.name = name; }))}
        ${this.beatField(point.tick, tick => this.edit(project => {
          project.waypoints!.find(item => item.id === point.id)!.tick = tick;
          project.waypoints!.sort((a, b) => a.tick - b.tick);
        }))}
        <div class="chart-creation__actions">
          <button class="button button--text" type="button" ?disabled=${this.busy || !this.audio}
            aria-label=${`${this.t("creation.jump_waypoint")} / ${point.name}`} @click=${() => this.jumpToWaypoint(point.tick)}>${this.t("creation.jump_waypoint")}</button>
          ${iconButton({ label: `${this.t("creation.delete_waypoint")} / ${point.name}`, icon: "delete", disabled: this.busy,
            onClick: () => this.edit(project => { project.waypoints = project.waypoints!.filter(item => item.id !== point.id); }) })}
        </div>
      </div>`)}
    </section>`;
  }
  private lineSampler(project: Project) {
    const projection = this.flatProjection(project), map = this.map();
    const nativeNotes = new Map(projection?.chart.notes.map(note => [note.id, note]));
    const lines = new Map(project.lines.map(line => {
      const ids = projection?.sourceMap.linesForCanonical(line.id);
      const native = projection?.chart.lines.find(native => ids?.includes(native.id));
      const points = native?.noteIds.map(id => nativeNotes.get(id))
        .filter((note): note is ChartNote => !!note && note.indexInLine !== null).sort((a, b) => a.timeMs - b.timeMs);
      return [line.id, points] as const;
    }));
    return (line: NoteLine, tick: number) => {
      const shape = sampleLineSpan(line, tick);
      if (!shape) return;
      const points = lines.get(line.id), at = (map.tickToSeconds(tick) - project.audioOffset) * 1000;
      const index = points?.findIndex(point => point.timeMs >= at) ?? -1;
      if (points && index >= 0) {
        const head = points[Math.max(0, index - 1)]!, tail = points[index]!;
        const resolved = head === tail || head.timeMs === tail.timeMs ? { pos: tail.pos, size: tail.size } : interpolateNoteLine(head, tail, at);
        return { lane: resolved.pos / 24 * project.laneBasis, size: resolved.size / 24 * project.laneBasis };
      }
      return shape;
    };
  }
  private nodeTarget(tick: number, lane?: number, tolerance = 0) {
    const project = this.chart, selected = this.selectedConnectorIds();
    const display = this.editingProject(project), sample = this.lineSampler(display);
    const candidates: { lineId: string; lane: number; size: number }[] = [];
    for (const line of display.lines) {
      const shape = sample(line, tick);
      if (!shape || lane === undefined && !selected.has(line.id)) continue;
      if (lane !== undefined && (lane < shape.lane - tolerance || lane > shape.lane + shape.size + tolerance)) continue;
      candidates.push({ lineId: line.id, ...shape });
    }
    return candidates.sort((a, b) => Number(selected.has(b.lineId)) - Number(selected.has(a.lineId)) ||
      (lane === undefined ? 0 : Math.abs(a.lane + a.size / 2 - lane) - Math.abs(b.lane + b.size / 2 - lane)))[0];
  }
  private insertNodeAt(tick: number, lane?: number, tolerance = 0) {
    if (this.busy || this.gesture || !this.audio) return;
    const target = this.nodeTarget(tick, lane, tolerance);
    if (!target) { snackbar(this.t("creation.node_missing")); return; }
    try {
      const result = insertLinePoint(this.chart, target.lineId, tick, { mode: this.nodeMode, shape: target });
      if (!result.created || this.commitProject(result.project)) this.setSelection([result.id]);
      this.requestUpdate();
    } catch { snackbar(this.t("creation.invalid_edit")); }
  }
  private activateNodeTool() {
    this.cancelGesture();
    this.cancelWidth();
    this.pending = undefined;
    this.tool = "node";
    this.closePanels();
    void this.updateComplete.then(() => this.querySelector<HTMLElement>(".chart-creation__editor")?.focus({ preventScroll: true }));
  }
  private renderNodeMode(value: LinePointMode, change: (mode: LinePointMode) => void, label = "creation.node_mode") {
    return html`<md-outlined-select label=${this.t(label)} .value=${live(value)}
      ?disabled=${this.busy} @change=${(event: Event) => change((event.target as HTMLSelectElement).value as LinePointMode)}>
      ${(["visible", "hidden", "auto"] as const).map(mode => html`<md-select-option value=${mode} .selected=${mode === value}>
        <div slot="headline">${this.t(`creation.node_${mode}`)}</div></md-select-option>`)}
    </md-outlined-select>`;
  }
  private changeSelectedNodeMode(mode: LinePointMode) {
    if (this.busy || this.gesture || this.pastePlacement) return;
    try { this.commitProject(setLinePointMode(this.chart, this.selectedIds, mode)); }
    catch { snackbar(this.t("creation.invalid_edit")); }
  }
  private removeSelectedNodes() {
    if (this.busy || this.gesture || !this.audio) return;
    this.cancelWidth();
    try {
      const result = removeLineControlPoints(this.chart, this.selectedIds);
      if (result.removed.length) this.commitProject(result.project);
    } catch { this.error = this.t("creation.invalid_edit"); }
  }
  private selectedConnectorIds(project = this.chart) {
    return new Set(project.lines.filter(line => line.points.some(point => this.selectedIds.has(point.id))).map(line => line.id));
  }
  private selectedLineCritical() {
    const ids = this.selectedConnectorIds();
    const values = new Set(this.chart.lines.filter(line => ids.has(line.id)).map(line =>
      line.critical === undefined ? "inherit" : line.critical ? "critical" : "normal"));
    return values.size > 1 ? "mixed" : (values.values().next().value ?? "inherit");
  }
  private setSelectedLineCritical(value: string): boolean {
    if (this.busy || this.gesture || !this.audio
      || !["inherit", "normal", "critical"].includes(value)) return false;
    const ids = this.selectedConnectorIds();
    if (!ids.size) return false;
    this.cancelWidth();
    const candidate = structuredClone(this.chart);
    for (const line of candidate.lines) if (ids.has(line.id)) {
      if (value === "inherit") delete line.critical;
      else line.critical = value === "critical";
    }
    return this.commitProject(candidate);
  }
  private changeLineCritical = async (event: Event) => {
    const field = event.target as HTMLElementTagNameMap["md-outlined-select"];
    if (!this.setSelectedLineCritical(field.value)) {
      await field.updateComplete;
      field.select(this.selectedLineCritical());
    }
  };
  private selectedLineKind() {
    const ids = this.selectedConnectorIds();
    const values = new Set(this.chart.lines.filter(line => ids.has(line.id)).map(line => line.kind));
    return values.size > 1 ? "mixed" : (values.values().next().value ?? "long");
  }
  private setSelectedLineKind(value: string): boolean {
    if (this.busy || this.gesture || !this.audio
      || (value !== "long" && value !== "guide")) return false;
    const ids = this.selectedConnectorIds();
    if (!ids.size || this.chart.lines.filter(line => ids.has(line.id)).every(line => line.kind === value)) return false;
    this.cancelWidth();
    const candidate = structuredClone(this.chart);
    for (const line of candidate.lines) if (ids.has(line.id)) line.kind = value;
    return this.commitProject(candidate);
  }
  private changeLineKind = async (event: Event) => {
    const field = event.target as HTMLElementTagNameMap["md-outlined-select"];
    if (!this.setSelectedLineKind(field.value)) {
      await field.updateComplete;
      field.select(this.selectedLineKind());
    }
  };
  private async newProject() {
    await this.run(async (signal) => {
      await this.save();
      signal.throwIfAborted();
      await this.disposePreview();
      this.preview?.dispose();
      this.preview = undefined;
      this.audio = undefined;
      const project = createEmptyProject({ source: "authored" });
      this.collectionScope = {}; this.deletingProject = false;
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
  private setDefaultWidth(value: number) {
    if (this.busy || this.gesture || this.pan) return;
    if (!Number.isFinite(value) || value < 0) {
      this.error = this.t("creation.invalid_edit");
      this.requestUpdate();
      return;
    }
    this.defaultWidth = value;
    this.widthRangeMax = Math.max(this.widthRangeMax, value);
    this.laneStart = this.clampLaneStart(this.laneStart);
    this.error = "";
  }
  private stepWidth(delta: number) {
    if (this.busy || this.gesture || this.pan || !this.audio) return;
    // A keyboard press starts a new operation after a cancelled slider gesture.
    this.widthCancelled = false;
    const item = this.selectionNodes().find(node => node.note.id === this.selected);
    if (!item) { this.setDefaultWidth(Math.max(0, this.defaultWidth + delta)); return; }
    const bounds = authoredWidthBounds(item.lane, item.size, this.chart.laneBasis, "left", item.placement);
    if (!bounds) { this.error = this.t("creation.invalid_edit"); return; }
    try { this.commitWidth(constrainLaneValue(Math.max(0, item.size + delta), bounds, { step: 0.25 })); }
    catch { this.error = this.t("creation.invalid_edit"); }
  }
  private previewWidth(value: number) {
    if (this.widthCancelled || this.busy || this.gesture || !this.selected) return;
    this.widthSession ??= { base: this.chart, ids: new Set([this.selected]) };
    try {
      this.widthSession.candidate = resizeChartSelection(
        this.widthSession.base,
        this.widthSession.ids,
        value,
        { placement: "overlap", resolveAutoLane: true },
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
    if (candidate) this.commitProject(candidate);
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
    const item = selected ? this.selectionNodes().find(entry => entry.note.id === this.selected) : undefined;
    const bounds = item ? authoredWidthBounds(item.lane, item.size, this.chart.laneBasis, "left", item.placement) : undefined;
    const limit = selected ? bounds?.max ?? this.chart.laneBasis : Infinity;
    const maximum = Math.max(value, Number.isFinite(limit) ? limit : this.chart.laneBasis, selected ? 0 : this.widthRangeMax);
    const apply = (raw: string) => {
      this.widthCancelled = false;
      const size = raw.trim() ? Number(raw) : NaN;
      if (selected) this.commitWidth(size);
      else this.setDefaultWidth(size);
    };
    return html`
      <div class="chart-studio__width" data-width-kind=${selected ? "selection" : "default"}>
        <label>
          <span>${label}</span>

        </label>
        <md-slider
          class="md3-slider"
          aria-label=${label}
          .ariaLabel=${label}
          labeled
          min="0"
          max=${maximum}
          step="0.25"
          .value=${value}
          ?disabled=${this.busy || !!this.gesture || !!this.pan || !this.audio}
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
          if (selected) this.previewWidth(size);
          else this.setDefaultWidth(size);
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
          max=${Number.isFinite(limit) ? limit : nothing}
          step="any"
          .value=${focusedValue(String(value))}
          ?disabled=${this.busy || !!this.gesture || !!this.pan || !this.audio}
          @change=${(event: Event) => apply((event.target as HTMLInputElement).value)}
          @focusout=${(event: FocusEvent) => {
          const input = event.composedPath().find(node => node instanceof HTMLInputElement);
          if (input) apply(input.value);
        }}
        ></md-outlined-text-field>
      </div>
    `;
  }
  private closePanels() {
    this.cancelWidth();
    this.leftOpen = this.rightOpen = false;
  }
  private async openGridSettings() {
    this.cancelGesture();
    this.cancelWidth();
    this.rightOpen = true;
    if (this.narrow) this.leftOpen = false;
    await this.updateComplete;
    const field = this.querySelector<HTMLElement>("[data-grid-division]");
    field?.scrollIntoView({ block: "nearest" });
    field?.focus();
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
    if (this.pastePlacement) return html`
      <span data-app-bar-keep>${iconButton({ label: this.c("cancel"), icon: "close", onClick: () => this.cancelPaste() })}</span>
      <button class="button button--filled" data-app-bar-keep type="button" ?disabled=${!!this.pastePlacement.error || !this.pastePlacement.candidate}
        @click=${() => this.confirmPaste()}>${icon("check", 20)}${this.t("patterns.place")}</button>`;
    return html`
      <span class="chart-studio__wide-actions" ?hidden=${this.stageMode === "preview"}>
        ${iconButton({ label: this.t("project"), icon: "folder_open", toggle: true, pressed: this.leftOpen, onClick: () => this.togglePanel("left") })}
        ${iconButton({
          label: this.t("undo"),
          shortcut: this.shortcutLabel("undo"),
          icon: "undo",
          disabled: this.busy || !!this.pastePlacement || !this.history.canUndo,
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
          shortcut: this.shortcutLabel("redo"),
          icon: "redo",
          disabled: this.busy || !!this.pastePlacement || !this.history.canRedo,
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
      ${this.stageMode === "edit" ? iconButton({ label: this.t("patterns.title"), icon: "widgets", disabled: this.busy, onClick: () => void this.showPatterns() }) : nothing}
      ${this.stageMode === "edit" ? iconButton({ label: this.t("shortcuts.title"), icon: "keyboard", disabled: this.busy, onClick: () => this.showShortcuts() }) : nothing}
      ${this.stageMode === "edit" ? iconButton({ label: this.t("audio.title"), icon: "volume_up", disabled: this.busy, onClick: () => void this.showAudioSettings() }) : nothing}
      ${iconButton({ label: this.t("creation.save"), shortcut: this.shortcutLabel("save"), className: "chart-studio__header-save", icon: "save", disabled: this.busy || !this.audio || !this.dirty, onClick: () => void this.run(() => this.save()) })}
      <button class="button button--text" type="button" ?disabled=${this.busy || !this.audio}
        @click=${() => void this.querySelector<ChartPublication>("chart-publication")?.show()}>
        ${icon("edit", 20)}<span>${clientText(this.locale, "community.charts.publishToCommunity")}</span>
      </button>
      <fieldset class="chart-studio__mode-toggle" data-app-bar-keep ?disabled=${this.busy || !this.audio}>
        ${segmented({
          label: `${this.t("edit")} / ${this.t("preview")}`,
          value: this.stageMode,
          options: [{ value: "edit", label: this.t("edit") }, { value: "preview", label: this.t("preview") }],
          grow: false,
          onSelect: async (value) => {
            if (this.busy || value === this.stageMode) return;
            const group = document.activeElement?.closest(".chart-studio__mode-toggle");
            await this.switchStage();
            await this.updateComplete;
            if (this.isConnected && group?.isConnected &&
              (document.activeElement === document.body || group.contains(document.activeElement)))
              group.querySelector<HTMLButtonElement>('button[aria-checked="true"]')?.focus({ preventScroll: true });
          },
        })}
      </fieldset>
    `;
  }
  private beatField(tick: number, changed: (tick: number) => void) {
    return this.field("beat", tick / this.chart.resolution, value => {
      try {
        const tick = parseBeatTick(value, this.chart.resolution);
        this.error = "";
        changed(tick);
      } catch { this.error = this.t("creation.invalid_position"); }
    });
  }
  private field(key: string, value: string | number, changed: (value: string) => void, numeric = false, step = "any") {
    return html`
      <md-outlined-text-field
        label=${this.t(key)}
        step=${numeric ? step : nothing}
        type=${numeric ? "number" : "text"}
        .value=${focusedValue(String(value))}
        ?disabled=${this.busy || !this.audio}
        @change=${(e: Event) => changed((e.currentTarget as HTMLInputElement).value)}
        @focusout=${(e: FocusEvent) => {
          const input = e.composedPath().find(node => node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement);
          if (input && input.value !== String(value)) changed(input.value);
        }}
      ></md-outlined-text-field>
    `;
  }
  render() {
    const chart = this.chart,
      selection = [...chart.singles, ...chart.lines.flatMap((l) => l.points)].find((n) => n.id === this.selected);
    const selectedShape = this.selectionNodes(chart).find(item => item.note.id === this.selected);
    const interior = selection && chart.lines.some(line => line.points.slice(1, -1).some(point => point.id === selection.id));
    const selectedUpdate = (updater: (note: SingleNote | LinePoint) => void) =>
      this.edit((p) => {
        const ids = new Set([this.selected]);
        for (const note of [...p.singles, ...p.lines.flatMap((l) => l.points)]) if (ids.has(note.id)) updater(note);
      });
    const filesPanel = html`
      <div class="chart-creation__actions">
        <a class="button button--tonal" href=${communityChartPath(readReleaseServer(), this.locale)}>${clientText(this.locale, "community.charts.title")}</a>
        <button class="button" ?disabled=${this.busy} @click=${() => void this.newProject()}>
          ${this.t("newProject")}
        </button>
        <button class="button button--tonal" ?disabled=${this.busy} @click=${() => this.showLibrary()}>
          ${this.t("serverLibrary")}
        </button>
        <button class="button button--tonal" ?disabled=${this.busy} @click=${() => this.showLibrary("bestdori")}>
          ${this.t("importGbp")}
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
              downloadBlob(await this.store.export(this.projectId, this.activeRevision || undefined), "chart-project.zip");
            })}
        >
          ${this.c("export")}
        </button>
        <button class="button" ?disabled=${this.busy} @click=${() => this.pick("[data-backup]")}>
          ${this.t("creation.open_backup")}
        </button>
        <button class="button button--tonal" ?disabled=${this.busy || !this.audio} @click=${() => void this.saveCopy()}>${this.t("creation.save_copy")}</button>
        <button class="button button--text" ?disabled=${this.busy || !this.head} @click=${() => void this.restoreOriginal()}>${this.t("creation.restore_original")}</button>
        <button class="button button--text" ?disabled=${this.busy || !this.head} @click=${() => { this.deletingProject = !this.deletingProject; }}>${this.t("creation.delete_project")}</button>
        ${this.deletingProject ? html`<dialog class="dialog" aria-label=${this.t("creation.delete_project")} ${modal(() => { if (!this.busy) this.deletingProject = false; })}>
          <header class="dialog__header"><h2>${this.t("creation.delete_project")}</h2></header><div class="dialog__body"><p>${this.t("creation.delete_project_confirm")}</p></div>
          <div class="dialog__actions"><button class="button button--text" ?disabled=${this.busy} @click=${() => { this.deletingProject = false; }}>${this.c("cancel")}</button><button class="button button--filled" ?disabled=${this.busy} @click=${() => void this.deleteProject()}>${this.t("creation.delete_project")}</button></div>
        </dialog>` : nothing}
      </div>
    `;
    const audioPanel = html`
      ${
        this.audio
          ? html`
              <div class="chart-creation__audio">
                <span>${this.audio.file.name} / ${this.audio.analysis.duration.toFixed(2)} s</span>
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
      <chart-creation-collections .locale=${this.locale} .project=${chart} .selection=${this.selectedIds} .scope=${this.collectionScope} .busy=${this.busy || !!this.gesture || !!this.widthSession || !this.audio} .forceSpeedAvailable=${this.nativeChart} .globalNoteSpeed=${DEFAULT_RENDER_SETTINGS.noteSpeed} .onOperation=${this.collectionOperation} .onScope=${this.changeCollectionScope} .onSelect=${this.selectCollectionMembers}></chart-creation-collections>
      ${
        selection
          ? html`
              <section class="chart-creation__form" aria-label=${this.t("selection")}>
                ${this.widthControl(this.selectionNodes(chart).find((item) => item.note.id === selection.id)?.size ?? selection.size, true)}
                <div class="chart-creation__actions">
                  ${([-1, 1] as const).map(direction => iconButton({
                    label: `${this.t("beat")} ${direction > 0 ? "+" : "−"} / ${this.t("snap")}`,
                    icon: direction > 0 ? "arrow_upward" : "arrow_downward",
                    disabled: this.busy || !!this.gesture || !this.audio,
                    onClick: () => this.nudgeSelection(direction),
                  }))}
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
                  ${iconButton({ label: this.t("creation.remove_nodes"), icon: "remove",
                    disabled: this.busy || !!this.gesture || !this.audio || !removableLinePointIds(chart, this.selectedIds).length,
                    onClick: () => this.removeSelectedNodes() })}
                </div>
                <button
                  class="button"
                  ?disabled=${this.busy}
                  @click=${() => {
                    this.clipboard = copyAuthorSelection(this.chart, this.selectedIds);
                    this.requestUpdate();
                  }}
                >
                  ${this.t("creation.copy")}
                </button>
                <button class="button button--text" type="button"
                  ?disabled=${this.busy || !chart.lines.some(line => line.points.filter(point => this.selectedIds.has(point.id)).length >= 2)}
                  @click=${() => this.copySegments()}>${this.t("creation.copy_segments")}</button>
                <div class="chart-creation__actions">
                  <button class="button button--text" type="button" ?disabled=${this.busy}
                    @click=${() => this.duplicateSelection()}>${this.t("creation.duplicate")}</button>
                  <button class="button button--text" type="button" ?disabled=${this.busy}
                    @click=${() => this.duplicateSelection(true)}>${this.t("creation.duplicate_mirrored")}</button>
                </div>
                <button
                  class="button"
                  ?disabled=${this.busy}
                  @click=${() => this.edit((p) => deleteChartSelectionGroup(p, this.selectedIds))}
                >
                  ${this.t("deleteSelection")}
                </button>

                ${this.beatField(selection.tick, tick => selectedUpdate(note => { note.tick = tick; }))}
                ${this.field("tick", selection.tick, value => {
                  const tick = Number(value);
                  if (value.trim() && Number.isSafeInteger(tick) && tick >= 0)
                    selectedUpdate(note => { note.tick = tick; });
                  else this.error = this.t("creation.invalid_position");
                }, true, "1")}
                <div class="chart-studio__tick-actions" role="group" aria-label=${this.t("creation.tick_nudge")}>
                  ${([-1, 1] as const).map(direction => html`
                    <button class="button button--tonal" type="button"
                      ?disabled=${this.busy || !!this.gesture || !this.audio || (direction < 0 && selection.tick === 0)}
                      @click=${() => this.nudgeSelection(direction, true)}>${direction < 0 ? "−" : "+"}1 ${this.t("tick")}</button>
                  `)}
                </div>
                ${this.selectedConnectorIds(chart).size ? html`<button class="button button--text" type="button" ?disabled=${this.busy} @click=${() => this.selectConnectors()}>${this.t("patterns.select_line")}</button>` : nothing}
                ${this.selectedConnectorIds(chart).size ? html`<button class="button button--tonal" type="button" ?disabled=${this.busy}
                  @click=${() => this.activateNodeTool()}>${icon("add", 20)}${this.t("creation.insert_node")}</button>` : nothing}
                ${this.selectedConnectorIds(chart).size ? html`<div class="chart-creation__actions">
                  <button class="button button--text" type="button" ?disabled=${this.busy || !lineJoinTargets(chart, this.selectedIds)}
                    @click=${() => this.joinLines()}>${this.t("creation.join_lines")}</button>
                  <button class="button button--text" type="button" ?disabled=${this.busy || !lineSplitTarget(chart, this.selectedIds)}
                    @click=${() => this.splitLine()}>${this.t("creation.split_line")}</button>
                </div>` : nothing}
                ${this.selectedConnectorIds(chart).size ? accordion({ id: "chart-line-tools", label: this.t("creation.line_tools"),
                  expanded: this.lineToolsOpen, onExpandedChange: expanded => { this.lineToolsOpen = expanded; this.requestUpdate(); }, content: html`<div class="chart-creation__form">
                  <button class="button button--text" type="button" ?disabled=${this.busy || !linePatternTarget(chart, this.selectedIds)}
                    @click=${() => this.repeatNodes()}>${this.t("creation.repeat_nodes")}</button>
                  <button class="button button--text" type="button" ?disabled=${this.busy}
                    @click=${() => this.createLineTraces(true)}>${this.t("creation.generate_traces")}</button>
                  <button class="button button--text" type="button" ?disabled=${this.busy}
                    @click=${() => this.createLineTraces(false)}>${this.t("creation.convert_traces")}</button>
                </div>` }) : nothing}
                <div class="chart-studio__tick-actions" role="group" aria-label=${this.t("patterns.compress")}>
                  ${(["first", "last"] as const).map(anchor => html`<button class="button button--text" type="button"
                    ?disabled=${this.busy || new Set(this.selectionNodes(chart).filter(item => this.selectedIds.has(item.note.id)).map(item => item.note.tick)).size < 2}
                    @click=${() => this.compressSelection(anchor)}>${this.t(`patterns.compress_${anchor}`)}</button>`)}
                </div>
                ${this.field(
                  "lane",
                  selectedShape?.lane ?? 0,
                  (value) =>
                    selectedUpdate((n) => {
                      n.lane = Number(value);
                      if ("ease" in n) { delete n.autoSize; delete n.resolvedLane; delete n.resolvedSize; }
                    }),
                  true,
                )}
                ${interior && selection ? this.renderNodeMode(selection.lane === "auto" ? "auto" : selection.visible ? "visible" : "hidden", mode => this.changeSelectedNodeMode(mode)) : nothing}
                ${this.selectedConnectorIds(chart).size ? html`
                  <md-outlined-select label=${this.t("creation.line_kind")}
                    .value=${live(this.selectedLineKind())}
                    ?disabled=${this.busy || !!this.gesture || !this.audio}
                    @change=${this.changeLineKind}>
                    <md-select-option value="long" .selected=${this.selectedLineKind() === "long"}><div slot="headline">${this.t("hold")}</div></md-select-option>
                    <md-select-option value="guide" .selected=${this.selectedLineKind() === "guide"}><div slot="headline">${this.t("guide")}</div></md-select-option>
                    <md-select-option value="mixed" disabled ?hidden=${this.selectedLineKind() !== "mixed"}
                      .selected=${this.selectedLineKind() === "mixed"}><div slot="headline">${this.t("collections.mixed")}</div></md-select-option>
                  </md-outlined-select>
                  <p>${this.t("creation.line_kind_hint")}</p>
                  <md-outlined-select label=${this.t("creation.line_critical")}
                    .value=${live(this.selectedLineCritical())}
                    ?disabled=${this.busy || !!this.gesture || !this.audio}
                    @change=${this.changeLineCritical}>
                    <md-select-option value="inherit" .selected=${this.selectedLineCritical() === "inherit"}><div slot="headline">${this.t("creation.line_critical_inherit")}</div></md-select-option>
                    <md-select-option value="normal" .selected=${this.selectedLineCritical() === "normal"}><div slot="headline">${this.t("creation.line_critical_normal")}</div></md-select-option>
                    <md-select-option value="critical" .selected=${this.selectedLineCritical() === "critical"}><div slot="headline">${this.t("critical")}</div></md-select-option>
                    <md-select-option value="mixed" disabled ?hidden=${this.selectedLineCritical() !== "mixed"}
                      .selected=${this.selectedLineCritical() === "mixed"}><div slot="headline">${this.t("collections.mixed")}</div></md-select-option>
                  </md-outlined-select>` : nothing}

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
                    ?disabled=${this.busy || selection.lane === "auto"}
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
            ${this.tool === "node" ? html`
              ${this.renderNodeMode(this.nodeMode, mode => { this.nodeMode = mode; }, "creation.new_node_mode")}
              <button class="button" type="button" ?disabled=${this.busy || !this.audio || !this.selectedConnectorIds().size}
                @click=${() => this.insertNodeAt(Math.max(0, this.gridTick(this.map().secondsToTick(this.seconds))))}>${this.t("creation.insert_node_here")}</button>
            ` : html`
            ${this.widthControl(this.defaultWidth)}
            ${this.field(
              "lane",
              this.insertLane,
              (value) => {
                const lane = Number(value);
                if (Number.isFinite(lane)) this.insertLane = lane;
                else this.error = this.t("creation.invalid_edit");
                this.requestUpdate();
              },
              true,
            )}
            <button
              class="button"
              ?disabled=${this.busy || !this.audio || ["select", "erase", "pan", "brush"].includes(this.tool)}
              @click=${() => this.place(Math.max(0, this.gridTick(this.map().secondsToTick(this.seconds))), this.insertLane)}
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
            `}
          </div>
        `,
      })}
    `;
    const warningsPanel = html`${(["errors", "warnings"] as const).map(kind => this.exportValidation()[kind].length
      ? html`<ul aria-label=${this.t(kind)}>${this.exportValidation()[kind].map(issue => html`
          <li>${this.t(`creation.export_${issue.code.split(".").at(-1)}`)}</li>`)}</ul>` : nothing)}`;
    const timingPanel = html`
      <section aria-label=${this.t("timing")}>
        <div class="chart-creation__actions">
          <button
            class="button"
            ?disabled=${this.busy || !this.audio}
            @click=${() =>
              this.edit((p) => {
                const tick = Math.max(0, this.gridTick(this.map().secondsToTick(this.seconds)));
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
              ${this.beatField(tempo.tick, tick => this.edit(project => {
                project.tempos.find(event => event.id === tempo.id)!.tick = tick;
                project.tempos.sort((a, b) => a.tick - b.tick);
              }))}
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
      ${this.renderMeters()}
      <section aria-label=${this.t("timeScale")}>
        <div class="chart-creation__actions">
          <button class="button button--text" type="button" ?disabled=${this.busy || !chart.timeScales.length}
            @click=${() => { this.selectedSpeeds = new Set(chart.timeScales.map(event => event.id)); this.requestUpdate(); }}>${this.t("creation.select_all_speeds")}</button>
          <button class="button button--text" type="button" ?disabled=${this.busy || chart.timeScales.filter(event => this.selectedSpeeds.has(event.id)).length < 2}
            @click=${() => this.interpolateSpeeds()}>${this.t("creation.interpolate_speeds")}</button>
        </div>
        <button
          class="button"
          ?disabled=${this.busy || !this.audio}
          @click=${() =>
            this.edit((p) => {
              const tick = Math.max(0, this.gridTick(this.map().secondsToTick(this.seconds)));
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
              <label class="cluster">
                <md-checkbox .checked=${this.selectedSpeeds.has(scale.id)} ?disabled=${this.busy}
                  @change=${(event: Event) => {
                    if ((event.target as HTMLInputElement).checked) this.selectedSpeeds.add(scale.id);
                    else this.selectedSpeeds.delete(scale.id);
                    this.requestUpdate();
                  }}></md-checkbox>${this.t("selection")} / ${scale.tick / chart.resolution}
              </label>
              ${this.beatField(scale.tick, tick => this.edit(project => {
                project.timeScales.find(event => event.id === scale.id)!.tick = tick;
                project.timeScales.sort((a, b) => a.tick - b.tick);
              }))}
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
      ${this.renderGameMarkers()}
      ${this.renderWaypoints()}
    `;
    const versionsPanel = html`
      <div class="chart-creation__form">
        <md-outlined-select
          data-project
          label=${this.t("creation.projects")}
          .value=${this.head ? this.projectId : ""}
          ?disabled=${this.busy}
          @change=${(e: Event) => {
            const id = (e.target as HTMLSelectElement).value;
            if (id) void this.run(() => this.open(id));
          }}
        >
          ${this.documents.map(
            (document) => html`
              <md-select-option value=${document.id}>
                <div slot="headline">${document.title || this.t("project")} / ${formatDate(this.locale, document.updatedAt, { time: true })}</div>
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
                  ${revision.revision} / ${formatDate(this.locale, revision.savedAt, { time: true })}
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
            .ariaLabel=${this.t("creation.zoom_x")}
            @input=${(event: Event) => this.setHorizontalZoom(Number((event.target as HTMLInputElement).value))}
          ></md-slider>
        </label>
        <button
          class="button button--text"
          ?disabled=${this.busy}
          @click=${() => {
          this.setHorizontalZoom(1);
          this.laneStart = -this.editingGutter();
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
          max=${chart.resolution * 4}
          step="1"
          data-grid-division
          .value=${live(String(this.snap))}
          ?disabled=${this.busy}
          @change=${(event: Event) => {
            const value = Number((event.target as HTMLInputElement).value);
            if (Number.isSafeInteger(value) && value >= 1 && value <= chart.resolution * 4) {
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
          ${[...new Set([...snapDivisions, ...fineSnapDivisions, this.snap])]
            .sort((a, b) => a - b)
            .map(
              (value) => html`
                <md-select-option value=${String(value)}><div slot="headline">1/${value}${this.shortcutLabel(`grid:${value}`) ? ` (${this.shortcutLabel(`grid:${value}`)})` : nothing}</div></md-select-option>
              `,
            )}
        </md-outlined-select>
        ${this.field("playbackSpeed", this.rate, value => {
          const rate = Number(value);
          if (!Number.isFinite(rate) || rate < 0.25 || rate > 4) { this.error = this.t("creation.invalid_rate"); return; }
          this.rate = rate;
          if (this.preview) this.preview.clock.rate = rate;
          this.requestUpdate();
        }, true)}
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
          ${(["project", "ss", "usc", "sus", "mmws"] as const).map(
            (value) => html`
              <md-select-option value=${value}>
                <div slot="headline">
                  ${this.t(value === "project" ? "formatProject" : value === "ss" ? "formatSs" : value === "sus" ? "formatSus" : value === "mmws" ? "formatMmws" : "formatUsc")}
                </div>
              </md-select-option>
            `,
          )}
        </md-outlined-select>
        <button
          class="button"
          ?disabled=${this.busy || !this.audio || !this.exportValidation().valid}
          @click=${() =>
            void this.run(async () => {
              await this.save();
              const chart = this.chart;
              if (this.exportFormat === "ss" && (!chart.meta.source || ["ss", "authored"].includes(chart.meta.source))) compileOurNotesCreation(chart);
              const content =
                this.exportFormat === "ss"
                  ? serializeSsForTarget(chart)
                  : this.exportFormat === "usc"
                    ? serializeUsc(chart, { wrapped: true })
                    : this.exportFormat === "sus" ? serializeSus(chart) : this.exportFormat === "mmws" ? serializeMmws(chart) : serializeProjectJson(chart);
              await downloadBlob(new Blob([content], { type: this.exportFormat === "sus" ? "text/plain" : this.exportFormat === "mmws" ? "application/octet-stream" : "application/json" }), this.exportFormat === "sus" ? "chart.sus" : this.exportFormat === "mmws" ? "chart.mmws" : `chart.${this.exportFormat}.json`);
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
      <input hidden data-chart type="file" accept=".mmws,.ccmmws,.ucmmws,.json,.sus,.ss,.usc" @change=${(e: Event) => this.importFile(e)} />
      <input hidden data-backup type="file" accept=".zip" @change=${(e: Event) => this.importFile(e, true)} />
      ${
        this.conflict
          ? html`
              <button
                class="button button--tonal"
                ?disabled=${this.busy}
                @click=${() => void this.saveCopy()}
              >
                ${this.t("creation.save_copy")}
              </button>
            `
          : nothing
      }

      ${this.renderPatterns()}
      ${this.renderShortcuts()}
      <chart-creation-library
        .pageData=${this.pageData}
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

          <div class="chart-studio__zoom-y" role="group" aria-label=${this.t("creation.zoom_y")} ?hidden=${this.stageMode !== "edit"}>
            ${iconButton({ icon: "remove", label: `${this.t("creation.zoom_y")} −`, disabled: this.busy || !this.audio || Boolean(this.gesture) || this.secondsPerScreen >= 16,
              onClick: () => this.setVerticalZoom(this.secondsPerScreen * 2) })}
            <span title=${this.t("creation.zoom_y")}>${icon("height", 18)}<output>${Number((4 / this.secondsPerScreen).toFixed(2))}×</output></span>
            ${iconButton({ icon: "add", label: `${this.t("creation.zoom_y")} +`, disabled: this.busy || !this.audio || Boolean(this.gesture) || this.secondsPerScreen <= 0.5,
              onClick: () => this.setVerticalZoom(this.secondsPerScreen / 2) })}
          </div>
          <button class="chip chart-studio__grid-preset" type="button" ?disabled=${this.busy}
            aria-label=${`${this.t("creation.custom_division")} 1/${this.snap}`}
            @click=${() => void this.openGridSettings()}>1/${this.snap}</button>
          <div class="chart-studio__tools">
            <div class="chart-creation__actions">
              ${segmented({
          label: this.t("currentTool"),
          value: this.tool,
          options: creationTools.map(value => ({
            shortcut: this.shortcutLabel(`tool:${value}`),
            value,
            label: this.t(value === "brush" ? "creation.brush" : value),
            icon: (
              {
                brush: "format_paint",
                node: "add",
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
                ${clientText(this.locale, "editors.chart.selectedCount", undefined, { count: this.selectedIds.size })}
              </output>
              ${iconButton({
          label: this.t("undo"),
          shortcut: this.shortcutLabel("undo"),
          icon: "undo",
          className: "chart-studio__history",
          disabled: this.busy || !!this.pastePlacement || !this.history.canUndo,
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
          shortcut: this.shortcutLabel("redo"),
          icon: "redo",
          className: "chart-studio__history",
          disabled: this.busy || !!this.pastePlacement || !this.history.canRedo,
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
              ?disabled=${this.busy || !this.hasClipboard || !this.audio}
              @click=${() => this.pasteSelection()}
            >
              ${this.t("creation.paste")}
            </button>
            <button class="button button--text" type="button"
              ?disabled=${this.busy || !this.hasClipboard || !this.audio}
              @click=${() => this.pasteSelection(true)}>${this.t("creation.paste_mirrored")}</button>
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
            ?hidden=${this.stageMode === "preview" || !this.leftOpen}
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
              <div ?hidden=${this.projectTab !== "project"}>${projectPanel}${audioPanel}${this.renderAudioSettings()}${this.renderStatistics()}${versionsPanel}</div>
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
              style=${this.pastePlacement || ["pan", "select", "brush"].includes(this.tool) ? "touch-action:none" : "touch-action:manipulation"}
              @pointerdown=${this.hit}
              @pointermove=${this.panMove}
              @pointerleave=${this.leaveCursor}
              @pointerup=${this.panEnd}
              @pointercancel=${this.panEnd}
              @lostpointercapture=${this.panEnd}
              @wheel=${this.wheel}
            ></canvas>
            ${this.audio && this.stageMode === "edit" && (this.canvasLoading || this.canvasFailed) ? html`<div class="chart-studio__skin-state">${this.canvasLoading ? loadingState(this.c("loading"),{local:true}) : html`<button class="button button--tonal" @click=${()=>void this.ensureCanvasSkin(true)}>${this.c("retry")}</button>`}</div>` : nothing}
            <output class="chart-studio__cursor" data-cursor aria-live="off" hidden></output>
            ${this.stageMode === "preview" && this.previewPlayback ? html`
              <chart-simulator
                .playback=${this.previewPlayback}
                audio-url=${this.previewAudioUrl!}
                chart-format="community"
                band-id=${this.previewBandId}
                server=${this.previewIdentity!.server}
                locale=${this.locale}
                label=${this.chart.meta.title || this.t("preview")}
                .mode=${"watch"}
                .introContent=${{ title: this.chart.meta.title, jacketUrl: this.previewJacketUrl }}
              ></chart-simulator>
            ` : nothing}
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
                .ariaLabel=${this.t("creation.position")}
                min="0"
                max=${Math.max(this.windowStart + this.secondsPerScreen, this.timelineDuration())}
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
            ?hidden=${this.stageMode === "preview" || !this.rightOpen}
            role=${this.narrow ? "dialog" : "complementary"}
            aria-modal=${this.narrow ? "true" : nothing}
            aria-label=${this.t("inspector")}
          >
            <header>
              <strong>
                ${this.t("inspector")}
              </strong>
              ${iconButton({ label: this.c("close"), icon: "close", onClick: () => this.togglePanel("right") })}
            </header>
            <div class="chart-studio__panel-content">
              ${
                html`
                      ${selectionPanel}${defaultsPanel}${viewControls}
                      ${this.beatField(Math.round(this.map().secondsToTick(this.seconds)), tick => {
                this.seekPlayback(this.map().tickToSeconds(tick), true);
              })}
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
        <footer class="chart-studio__transport" ?hidden=${this.stageMode !== "edit"} ?inert=${this.narrow && (this.leftOpen || this.rightOpen)}>
          <button
            class="icon-button icon-button--filled"
            type="button"
            data-play
            aria-label=${this.c(this.startingPlayback || this.preview?.clock.playing ? "pause" : "play")}
            aria-busy=${String(this.startingPlayback)}
            aria-pressed=${String(this.startingPlayback || !!this.preview?.clock.playing)}
            ?disabled=${this.busy || !this.audio}
            @click=${this.togglePlayback}
          >
            ${icon(this.startingPlayback || this.preview?.clock.playing ? "pause" : "play_arrow")}
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
            .ariaLabel=${this.t("creation.position")}
            min="0"
            max=${Math.max(this.timelineDuration(), this.seconds)}
            step="0.01"
            .value=${this.seconds}
            ?disabled=${this.busy || !this.audio}
            @input=${(event: Event) => this.seekPlayback(Number((event.target as HTMLInputElement).value), true)}
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
        <chart-publication .locale=${this.locale} .projectId=${this.projectId} .project=${chart} .audio=${this.audio}
          .onSave=${() => this.run(() => this.save())}
          .onAudio=${async (file: File, external: AbortSignal) => {
            let audio: CreationAudio | undefined;
            await this.run(async signal => {
              audio = await decodeCreationAudio(file, AbortSignal.any([signal, external]));
              await this.save(); signal.throwIfAborted(); this.preview?.dispose(); this.audio = audio; this.preciseSeekSeconds = undefined; this.dirty = true; this.rebuildPreview(0);
            });
            if (!audio) throw new Error("audio_decode"); return audio;
          }}></chart-publication>
      </div>
    `;
  }
}
if (!customElements.get("chart-creation-workspace"))
  customElements.define("chart-creation-workspace", ChartCreationWorkspace);
