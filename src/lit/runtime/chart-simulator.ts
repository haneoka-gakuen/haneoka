import { LitElement, html, svg, nothing, type PropertyValues } from "lit";
import { clientText } from "../../i18n/client";
import { chartPath, parseResourceRoute } from "../../lib/resource-route";
import {
  chartPlaybackShareUrl,
  readChartPlaybackShare,
  matchesChartPlaybackShare,
  sameChartPlaybackIdentity,
  validChartPlaybackRange,
  chartRangeIndex,
  chartRangeStatistics,
  type ChartPlaybackIdentity,
  type ChartPlaybackShare,
  type ChartRangeIndex,
} from "../../lib/chart-playback-range";
import {
  chartOverviewPointToTime,
  sameChartOverviewGeometry,
  type ChartOverviewGeometry,
} from "../../lib/chart-overview-geometry";
import { fetchJson, uiText } from "../shared/catalog";
import { loadingState } from "../ui/state";
import { icon } from "../ui/icon";
import { accordion } from "../ui/accordion";
import { type ChartDocument } from "@haneoka/cassiopeia";
import {
  CassiopeiaRuntime,
  CASSIOPEIA_SESSION,
  createKernelPlugin,
  type CassiopeiaSessionPort,
} from "@haneoka/cassiopeia/plugin";
import {
  OUR_NOTES_RULES,
  OUR_NOTES_LIVE_QUALITIES,
  OUR_NOTES_LIVE_QUALITY_NAMES,
  OUR_NOTES_NOTE_EFFECT_SKINS,
  OUR_NOTES_NOTE_EFFECT_SKIN_NAMES,
  OUR_NOTES_NOTE_SKINS,
  OUR_NOTES_NOTE_SKIN_NAMES,
  OUR_NOTES_NOTE_SE_GROUP_IDS,
  OUR_NOTES_NOTE_SE_GROUP_NAMES,
  OUR_NOTES_STAGE_NAMES,
  DEFAULT_RENDER_SETTINGS,
  createOurNotesPlugin,
  ourNotesNoteSoundsForRelease,
  type RenderFrameBuilder,
  type RenderSettings,
  type OurNotesAssetManifest,
  type OurNotesRuntimeMediaManifest,
  type OurNotesLiveQuality,
  type OurNotesNoteSeGroup,
  type OurNotesNoteEffectSkin,
  type OurNotesNoteSkin,
} from "@haneoka/cassiopeia-plugin-our-notes";
import { THREE_RENDERER, createThreeRendererPlugin, type OurNotesRenderer } from "@haneoka/cassiopeia-renderer-three";
import { WEB_HOST, createWebHostPlugin, type MediaClock, type NoteSoundPlayer } from "@haneoka/cassiopeia-host-web";
import { countNoteKinds, drawDetailedChartOverview, loadDetailedOverviewSkin } from "./chart-overview-renderer";
import { PlaybackControlsController } from "../ui/playback-controls";
import { ViewportFullscreenController } from "./viewport-fullscreen";
import {
  chartImageFileName,
  composeChartOverviewImage,
  downloadChartOverviewImage,
  type ChartOverviewExportMeta,
} from "./chart-image-export";
import { loadingIndicator } from "../ui/loading-indicator";

/** Message paths for this view's finite control/metadata identifiers. */
const uiLabelPaths: Readonly<Record<string, string>> = {
  bpm: "catalog.analysis.fields.bpm",
  close: "common.actions.close",
  collapse: "common.actions.collapse",
  effects: "catalog.fields.effects",
  error: "common.states.error",
  expand: "common.actions.expand",
  fullscreen: "common.actions.fullscreen",
  loading: "common.states.loading",
  loop: "common.actions.loop",
  mirror: "editors.chart.labels.mirror",
  none: "common.states.none",
  notes: "editors.chart.labels.notes",
  nps: "catalog.analysis.fields.nps",
  pause: "common.actions.pause",
  play: "common.actions.play",
  playback: "media.audio.playback",
  reset: "common.actions.reset",
  settings: "navigation.settings",
  simple: "common.layout.simple",
  stage: "media.models.labels.stage",
  time: "common.fields.time",
  volume: "media.audio.volume",
  watch: "common.actions.watch",
};

type RuntimeOutput = { objectId: string | number; path: string; type: string };
type RuntimeDescriptor = {
  sourcePath?: string;
  outputs?: RuntimeOutput[];
};
type StageBackground = "auto" | "none" | "0" | "1" | "2" | "3" | "4" | "5";
type NumericRenderSetting =
  "noteSpeed" | "noteSize" | "longAlpha" | "guideAlpha" | "guidelineOpacity" | "laneOpacity" | "backgroundBrightness";
type ChartUiKey =
  | "play"
  | "pause"
  | "loop"
  | "fullscreen"
  | "settings"
  | "reset"
  | "close"
  | "playback"
  | "volume"
  | "playbackSpeed"
  | "notes"
  | "noteSpeed"
  | "noteSize"
  | "noteSkin"
  | "noteEffectSkin"
  | "liveQuality"
  | "noteSe"
  | "noteSeLoading"
  | "noteSeError"
  | "longOpacity"
  | "guideOpacity"
  | "mirror"
  | "effects"
  | "simultaneousLine"
  | "judgementLine"
  | "stage"
  | "stageBackground"
  | "songBand"
  | "noBackground"
  | "backgroundBrightness"
  | "laneOpacity"
  | "guidelineOpacity"
  | "guidelineCount"
  | "noteTap"
  | "noteFlick"
  | "noteSlide"
  | "loading"
  | "runtimeError"
  | "collapse"
  | "expand";

type NoteSoundSwap = {
  controller: AbortController;
  target: OurNotesNoteSeGroup;
  player?: NoteSoundPlayer;
};
type OverviewDrawInputs = {
  canvas: HTMLCanvasElement;
  host: HTMLElement;
  chart: ChartDocument;
  skin: Awaited<ReturnType<typeof loadDetailedOverviewSkin>>;
  height: number;
  viewportWidth: number;
  viewportHeight: number;
  dpr: number;
  epoch: number;
  mode: "simple" | "watch";
  phase: "loading" | "ready" | "error";
};
type OverviewPointer = {
  id: number;
  canvas: HTMLCanvasElement;
  host: HTMLElement;
  chart: ChartDocument;
  epoch: number;
  revision: number;
  startMs: number;
};

const SETTINGS_KEY = "haneoka:chart-player:v1";
let rangePanelSequence = 0;
const RANGE_COPY = {
  overviewSelectRange: "Select range",
  rangePlayback: "A/B loop",
  setA: "Set A",
  setB: "Set B",
  rangeA: "A (seconds)",
  rangeB: "B (seconds)",
  rangeLoop: "Loop A–B",
  clearRange: "Clear range",
  invalidRange: "Choose A before B.",
  shareTime: "Share time",
  linkCopied: "Link copied",
  copyFailed: "Could not copy link",
  shareSourceChanged: "Shared chart changed",
  shareUnavailable: "Sharing unavailable",
  playbackUnavailable: "Playback unavailable",
  rangeNotes: "Notes [A,B)",
  rangeDensity: "Notes/s",
  rangeBpm: "BPM",
} as const;
type RangeCopyKey = keyof typeof RANGE_COPY;

const logicalName = (output: RuntimeOutput) => {
  const file = output.path.split("/").pop() || "";
  const extension = file.match(/\.[^.]+$/u)?.[0] || "";
  const suffix = `--${output.type}-${String(output.objectId)}${extension}`;
  return extension && file.endsWith(suffix) ? `${file.slice(0, -suffix.length)}${extension}` : "";
};
const clamp = (value: number, minimum: number, maximum: number) => Math.max(minimum, Math.min(maximum, value));
const renderPixelRatio = (width: number, height: number) =>
  Math.max(1, Math.min(2, devicePixelRatio || 1, Math.sqrt((1920 * 1080) / Math.max(1, width * height))));

export class ChartSimulator extends LitElement {
  static properties = {
    source: { type: String },
    audioUrl: { type: String, attribute: "audio-url" },
    shareUrl: { type: String, attribute: "share-url" },
    bandId: { type: Number, attribute: "band-id" },
    label: { type: String },
    server: { type: String },
    locale: { type: String },
    phase: { state: true },
    playing: { state: true },
    mode: { state: true },
    currentTime: { state: true },
    duration: { state: true },
    loop: { state: true },
    fullscreen: { state: true },
    settingsOpen: { state: true },
    playerSettings: { state: true },
    noteSkin: { state: true },
    noteEffectSkin: { state: true },
    liveQuality: { state: true },
    noteSeGroup: { state: true },
    noteSoundSwapTarget: { state: true },
    noteSoundStatus: { state: true },
    stageBackground: { state: true },
    playbackRate: { state: true },
    volume: { state: true },
    transportCollapsed: { state: true },
    transportAutoHidden: { state: true },
    rangeA: { state: true },
    rangeB: { state: true },
    rangeLoop: { state: true },
    rangeADraft: { state: true },
    rangeBDraft: { state: true },
    rangeStatus: { state: true },
    rangeExpanded: { state: true },
    sharedPlaybackUrl: { state: true },
    overviewGeometry: { state: true },
    overviewSelecting: { state: true },
    overviewDraft: { state: true },
  };
  declare source: string;
  declare audioUrl: string;
  declare shareUrl: string;
  declare bandId: number;
  declare label: string;
  declare server: string;
  declare locale: string;
  declare phase: "loading" | "ready" | "error";
  declare playing: boolean;
  declare mode: "simple" | "watch";
  declare currentTime: number;
  declare duration: number;
  declare loop: boolean;
  declare fullscreen: boolean;
  declare settingsOpen: boolean;
  declare playerSettings: RenderSettings;
  declare noteSkin: OurNotesNoteSkin;
  declare noteEffectSkin: OurNotesNoteEffectSkin;
  declare liveQuality: OurNotesLiveQuality;
  declare noteSeGroup: OurNotesNoteSeGroup;
  declare noteSoundSwapTarget: OurNotesNoteSeGroup | undefined;
  declare noteSoundStatus: "idle" | "loading" | "error";
  declare stageBackground: StageBackground;
  declare playbackRate: number;
  declare volume: number;
  declare transportCollapsed: boolean;
  declare transportAutoHidden: boolean;
  declare rangeA: number | undefined;
  declare rangeB: number | undefined;
  declare rangeLoop: boolean;
  declare rangeADraft: string;
  declare rangeBDraft: string;
  declare rangeStatus: RangeCopyKey | undefined;
  declare rangeExpanded: boolean;
  declare sharedPlaybackUrl: string;
  declare overviewGeometry: ChartOverviewGeometry | undefined;
  declare overviewSelecting: boolean;
  declare overviewDraft: { startMs: number; currentMs: number } | undefined;
  private overviewPointer?: OverviewPointer;
  private overviewRevision = 0;
  private overviewFrame = 0;
  private overviewResizeObserver?: ResizeObserver;
  private overviewPaint?: { inputs: OverviewDrawInputs; geometry: ChartOverviewGeometry | undefined };
  private readonly rangePanelId = `chart-playback-range-${++rangePanelSequence}`;
  private playbackIdentity?: ChartPlaybackIdentity;
  private rangeIndex?: ChartRangeIndex;
  private rangeSeekPending = false;
  private rangePlaybackIntent = false;
  private pendingShare?: ChartPlaybackShare;
  private observedShareUrl = "";
  private appliedShareUrl = "";
  private pluginRuntime?: CassiopeiaRuntime;
  private runtime() {
    return (this.pluginRuntime ??= new CassiopeiaRuntime([
      createKernelPlugin(),
      createOurNotesPlugin(),
      createThreeRendererPlugin(),
      createWebHostPlugin(),
    ]));
  }
  private chart?: ChartDocument;
  private assets?: OurNotesAssetManifest;
  private renderer?: OurNotesRenderer;
  private session?: CassiopeiaSessionPort;
  private frames?: RenderFrameBuilder;
  private clock?: MediaClock;
  private noteSounds?: NoteSoundPlayer;
  private noteSoundSwap?: NoteSoundSwap;
  private stagePointer?: { x: number; y: number };
  private overviewSkin?: Awaited<ReturnType<typeof loadDetailedOverviewSkin>>;
  private resizeObserver?: ResizeObserver;
  private animationFrame = 0;
  private loadedKey = "";
  private loadAbort?: AbortController;
  private availableNoteSkins: readonly OurNotesNoteSkin[] = OUR_NOTES_NOTE_SKINS;
  private availableNoteEffectSkins: readonly OurNotesNoteEffectSkin[] = ["effect001"];
  private sourceFilesCache?: { server: string; promise: Promise<Set<string>> };
  private resumeAfterScrub = false;
  private scrubClock?: MediaClock;
  private loadEpoch = 0;
  private viewportFullscreen: ViewportFullscreenController;
  private transportVisibility = new PlaybackControlsController((snapshot) => {
    this.transportCollapsed = snapshot.collapsed;
    this.transportAutoHidden = snapshot.autoHidden;
  });

  constructor() {
    super();
    this.source = "";
    this.audioUrl = "";
    this.shareUrl = "";
    this.bandId = 1;
    this.label = "Chart";
    this.server = "intl";
    this.locale = "ja";
    this.phase = "loading";
    this.playing = false;
    this.mode = "simple";
    this.currentTime = 0;
    this.duration = 0;
    this.loop = false;
    this.fullscreen = false;
    this.settingsOpen = false;
    this.playerSettings = { ...DEFAULT_RENDER_SETTINGS };
    this.noteSkin = "skin001";
    this.noteEffectSkin = "effect001";
    // Native High quality: full effect001 prefabs and a 1.0 effect-camera scale.
    this.liveQuality = 0;
    this.noteSeGroup = 1;
    this.noteSoundSwapTarget = undefined;
    this.noteSoundStatus = "idle";
    this.stageBackground = "auto";
    this.playbackRate = 1;
    this.volume = 0.8;
    this.transportCollapsed = false;
    this.transportAutoHidden = false;
    this.rangeA = undefined;
    this.rangeB = undefined;
    this.rangeLoop = false;
    this.rangeExpanded = false;
    this.sharedPlaybackUrl = "";
    this.overviewGeometry = undefined;
    this.overviewSelecting = false;
    this.overviewDraft = undefined;
    this.rangeADraft = "";
    this.rangeBDraft = "";
    this.rangeStatus = undefined;
    this.viewportFullscreen = new ViewportFullscreenController({
      owner: this,
      onChange: (active) => {
        this.fullscreen = active || document.fullscreenElement === this;
        this.requestUpdate();
      },
    });
    this.restoreSettings();
  }
  createRenderRoot() {
    return this;
  }
  connectedCallback() {
    super.connectedCallback();
    void Promise.all([
      import("@material/web/slider/slider.js"),
      import("@material/web/progress/circular-progress.js"),
      import("@material/web/textfield/outlined-text-field.js"),
      import("@material/web/switch/switch.js"),
    ]);
    void this.load();
    document.addEventListener("fullscreenchange", this.fullscreenChanged);
    window.addEventListener("resize", this.overviewViewportResize);
  }
  disconnectedCallback() {
    this.persistSettings();
    this.clearRange();
    this.pendingShare = undefined;
    this.appliedShareUrl = "";
    this.dispose();
    this.viewportFullscreen.dispose();
    this.transportVisibility.dispose();
    document.removeEventListener("fullscreenchange", this.fullscreenChanged);
    window.removeEventListener("resize", this.overviewViewportResize);
    super.disconnectedCallback();
  }
  updated(changed: PropertyValues<this>) {
    if (changed.has("mode")) {
      this.invalidateOverview();
    }
    const key = this.playbackSourceKey();
    if (this.source && key !== this.loadedKey) void this.load();
    else if (!this.source && key !== this.loadedKey) {
      this.dispose();
      this.clearRange();
      this.loadedKey = key;
      this.phase = "loading";
    }
    const url = location.href;
    if (url !== this.observedShareUrl) {
      this.observedShareUrl = url;
      this.pendingShare = readChartPlaybackShare(new URL(url));
      this.restorePlaybackShare();
    }
    this.transportVisibility.bind(this.querySelector<HTMLElement>(".playback-controls"));
    this.transportVisibility.setFullscreen(this.fullscreen);
    this.transportVisibility.setPlaying(this.playing);
    if (this.mode === "simple" && this.phase === "ready") this.scheduleOverviewDraw();
  }

  private playbackSourceKey() {
    return `${this.server}\u0000${this.source}\u0000${this.audioUrl}`;
  }
  private mediaSeconds() {
    const value = this.clock?.audio.currentTime;
    return value !== undefined && Number.isFinite(value) ? Math.max(0, value) : 0;
  }
  private mediaDuration() {
    const duration = this.clock?.durationMs;
    return duration !== undefined && Number.isFinite(duration) && duration > 0 ? duration / 1000 : 0;
  }
  private currentRange() {
    return validChartPlaybackRange(this.rangeA, this.rangeB, this.mediaDuration());
  }
  private rangeText(key: RangeCopyKey) {
    return clientText(this.locale, `media.chartPlayer.${key}`, RANGE_COPY[key]);
  }
  private syncLoop() {
    if (this.clock) this.clock.audio.loop = this.loop && !this.rangeLoop;
  }
  private clearRange() {
    this.cancelOverviewPointer();
    this.rangeSeekPending = false;
    this.sharedPlaybackUrl = "";
    this.rangeA = undefined;
    this.rangeB = undefined;
    this.rangeADraft = "";
    this.rangeBDraft = "";
    this.rangeLoop = false;
    this.rangeStatus = undefined;
    this.syncLoop();
  }
  private setRangePoint(point: "a" | "b") {
    if (!this.mediaDuration()) return;
    const value = Math.floor(this.mediaSeconds() * 1000) / 1000;
    if (point === "a") {
      this.rangeA = value;
      this.rangeADraft = String(value);
    } else {
      this.rangeB = value;
      this.rangeBDraft = String(value);
    }
    this.rangeChanged();
  }
  private commitRangePoint(point: "a" | "b", value: string) {
    const number = value.trim() ? Number(value) : undefined;
    const parsed = number !== undefined && Number.isFinite(number) && number >= 0 ? number : undefined;
    if (point === "a") this.rangeA = parsed;
    else this.rangeB = parsed;
    this.rangeChanged();
  }
  private rangeChanged(clearStatus = true) {
    this.cancelOverviewPointer();
    if (!this.mediaDuration()) return;
    const incomplete = this.rangeA === undefined || this.rangeB === undefined;
    const invalid = !incomplete && !this.currentRange();
    if (invalid) this.rangeStatus = "invalidRange";
    else if (clearStatus || this.rangeStatus === "invalidRange") this.rangeStatus = undefined;
    if (!this.currentRange()) this.rangeLoop = false;
    this.syncLoop();
  }
  private setRangeLoop(enabled: boolean) {
    this.cancelOverviewPointer();
    const range = this.currentRange();
    this.rangeLoop = enabled && Boolean(range);
    if (this.rangeLoop) {
      this.loop = false;
      const time = this.mediaSeconds();
      if (this.clock?.playing && range && (time < range.start || time >= range.end)) this.seek(range.start);
    }
    this.syncLoop();
  }
  private repeatRange(resume = false) {
    const clock = this.clock,
      range = this.currentRange();
    if (!clock || !this.rangeLoop || !range || this.rangeSeekPending) return false;
    if (resume && (!this.rangePlaybackIntent || this.scrubClock === clock)) return false;
    const time = this.mediaSeconds();
    if (!resume && (!clock.advancing || (time >= range.start && time < range.end))) return false;
    this.rangeSeekPending = true;
    if (!this.seek(range.start)) {
      this.rangeSeekPending = false;
      this.rangeLoop = false;
      this.syncLoop();
      return false;
    }
    // A no-op seek need not emit seeked. Only an actual media seek stays pending.
    if (!clock.audio.seeking) this.rangeSeekPending = false;
    if (resume)
      void clock.play().catch(() => {
        if (this.clock === clock) {
          this.playing = false;
          this.rangePlaybackIntent = false;
          this.rangeStatus = "playbackUnavailable";
        }
      });
    return true;
  }
  private canonicalSharePage(): URL | undefined {
    const href = document.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.href;
    if (!href) return;
    const canonical = new URL(href);
    if (canonical.protocol !== "https:" || /^(?:localhost|127\.|\[::1\])/u.test(canonical.hostname)) return;
    const selected = new URL(this.shareUrl || location.href, canonical);
    const resource = parseResourceRoute(selected.pathname);
    if (resource?.kind === "songs" && resource.id && resource.server === this.server) {
      if (!this.shareUrl && resource.view !== "chart") return;
      const target = new URL(
        chartPath({ server: resource.server, locale: resource.locale, id: resource.id }),
        canonical,
      );
      for (const key of ["difficulty", "chartDifficulty"]) {
        const value = selected.searchParams.get(key);
        if (value !== null) target.searchParams.set(key, value);
      }
      return target;
    }
    // The existing Bestdori parent supplies its real detail/share route.
    if (
      this.shareUrl &&
      /\/community\/songs-bestdori\/detail\/?$/u.test(selected.pathname) &&
      selected.searchParams.has("song")
    ) {
      const target = new URL(selected.pathname, canonical);
      for (const key of ["song", "difficulty", "chartDifficulty", "chart"]) {
        const value = selected.searchParams.get(key);
        if (value !== null) target.searchParams.set(key, value);
      }
      return target;
    }
  }
  private async sharePlayback() {
    const identity = this.playbackIdentity,
      page = this.canonicalSharePage();
    if (!identity || !page || !this.mediaDuration()) {
      this.rangeStatus = "shareUnavailable";
      return;
    }
    const url = chartPlaybackShareUrl(page, identity, this.mediaSeconds(), this.currentRange(), this.rangeLoop);
    this.sharedPlaybackUrl = url.href;
    const ownsShare = () => identity === this.playbackIdentity && this.sharedPlaybackUrl === url.href;
    try {
      await navigator.clipboard.writeText(url.href);
      if (ownsShare()) this.rangeStatus = "linkCopied";
    } catch {
      if (ownsShare()) this.rangeStatus = "copyFailed";
    }
  }
  private restorePlaybackShare() {
    const shared = this.pendingShare,
      identity = this.playbackIdentity;
    if (
      !shared ||
      !identity ||
      this.phase !== "ready" ||
      !this.mediaDuration() ||
      this.appliedShareUrl === this.observedShareUrl
    )
      return;
    this.pendingShare = undefined;
    this.appliedShareUrl = this.observedShareUrl;
    if (!matchesChartPlaybackShare(shared.identity, identity)) {
      this.rangeStatus = "shareSourceChanged";
      return;
    }
    const range = shared.range
      ? validChartPlaybackRange(shared.range.start, shared.range.end, this.mediaDuration())
      : undefined;
    if (shared.range && !range) {
      this.rangeStatus = "invalidRange";
      return;
    }
    this.rangeA = range?.start;
    this.rangeB = range?.end;
    this.rangeADraft = range ? String(range.start) : "";
    this.rangeBDraft = range ? String(range.end) : "";
    this.rangeLoop = shared.loop && Boolean(range);
    if (this.rangeLoop) this.loop = false;
    this.syncLoop();
    this.rangePlaybackIntent = false;
    this.resumeAfterScrub = false;
    this.scrubClock = undefined;
    this.clock?.pause();
    this.playing = false;
    this.mode = "watch";
    if (!this.seek(Math.min(shared.time, this.mediaDuration()))) return;
    this.dispatchEvent(new CustomEvent("haneoka:chart-playback-restored", { bubbles: true, composed: true }));
  }

  private descriptorUrl(source: string) {
    return `/api/v1/servers/${encodeURIComponent(this.server)}/sources/${source
      .split("/")
      .map(encodeURIComponent)
      .join("/")}`;
  }
  private async descriptor(source: string, signal: AbortSignal) {
    return await fetchJson<RuntimeDescriptor>(this.descriptorUrl(source), { signal });
  }
  private async sourceFiles(signal: AbortSignal) {
    const server = this.server;
    if (this.sourceFilesCache?.server === server) return this.sourceFilesCache.promise;
    const promise = (async () => {
      const tree = await fetchJson<Record<string, unknown>>(
        `/api/v1/servers/${encodeURIComponent(server)}/sources/tree`,
        { signal },
      );
      const files = new Set<string>();
      const walk = (value: unknown, prefix: string) => {
        if (typeof value === "number") {
          files.add(prefix);
        } else if (value && typeof value === "object" && !Array.isArray(value)) {
          for (const [part, child] of Object.entries(value)) walk(child, prefix ? `${prefix}/${part}` : part);
        }
      };
      walk(tree, "");
      return files;
    })();
    this.sourceFilesCache = { server, promise };
    try {
      return await promise;
    } catch (error) {
      if (this.sourceFilesCache?.promise === promise) this.sourceFilesCache = undefined;
      throw error;
    }
  }
  private sourceWithName(files: Set<string>, name: string) {
    const matches = [...files].filter((path) => path.endsWith(`/${name}`));
    if (matches.length !== 1) throw new Error(`Missing or ambiguous runtime source ${name}`);
    return matches[0]!;
  }
  private output(descriptor: RuntimeDescriptor, type: string, name?: string) {
    const matches = (descriptor.outputs || []).filter(
      (entry) => entry.type === type && (!name || logicalName(entry) === name),
    );
    if (matches.length !== 1) throw new Error(`Missing ${type} ${name || ""}`);
    return `/runtime/${encodeURIComponent(this.server)}/${matches[0]!.path.replace(/^runtime\//u, "")}`;
  }
  private async runtimeAssets(signal: AbortSignal) {
    const files = await this.sourceFiles(signal);
    signal.throwIfAborted();
    const source = (name: string) => this.sourceWithName(files, name);
    const fontSource = [...files].filter((path) => path.endsWith("/VibeMOPro-Medium SDF.asset"));
    const selectedSkin = this.availableNoteSkins.includes(this.noteSkin) ? this.noteSkin : "skin001";
    this.noteSkin = selectedSkin;
    this.availableNoteEffectSkins = OUR_NOTES_NOTE_EFFECT_SKINS.filter((skin) =>
      files.has(`Assets/AddressableResources/Effect/Live/NoteEffect/${skin}/LiveNoteEffectAssetSettings.asset`),
    );
    const selectedEffectSkin = this.availableNoteEffectSkins.includes(this.noteEffectSkin)
      ? this.noteEffectSkin
      : "effect001";
    this.noteEffectSkin = selectedEffectSkin;
    const [judgement, live, combo, font] = await Promise.all([
      this.descriptor(source("JudgementAtlas.spriteatlasv2"), signal),
      this.descriptor(source("LiveAtlas.spriteatlasv2"), signal),
      this.descriptor(source("LiveComboAtlas.spriteatlasv2"), signal),
      fontSource.length === 1
        ? this.descriptor(fontSource[0]!, signal).catch(() => undefined)
        : Promise.resolve(undefined),
    ]);
    signal.throwIfAborted();
    const root = `/assets/${encodeURIComponent(this.server)}`;
    const assetUrl = (path: string) => `${root}/${path.split("/").map(encodeURIComponent).join("/")}`;
    const sprite = (descriptor: RuntimeDescriptor, name: string) => {
      if (descriptor.outputs?.some((entry) => entry.type === "Sprite")) return this.output(descriptor, "Sprite", name);
      const atlas = descriptor.sourcePath || "";
      const match = /^(.*)\/Atlas\/([^/]+)\.spriteatlasv2$/u.exec(atlas);
      const sourcePath = match ? `${match[1]}/AtlasSources/${match[2]}/${name}` : "";
      if (!sourcePath || !files.has(sourcePath)) throw new Error(`Missing Sprite ${name}`);
      return assetUrl(sourcePath);
    };
    const digits = (prefix: string) =>
      Array.from({ length: 10 }, (_, value) => sprite(combo, `${prefix}_${value}.png`));
    const byFilename = new Map<string, string[]>();
    for (const path of files) {
      const filename = path.slice(path.lastIndexOf("/") + 1);
      byFilename.set(filename, [...(byFilename.get(filename) || []), path]);
    }
    const resolveSource = (oldPath: string): string => {
      if (files.has(oldPath)) return oldPath;
      const filename = oldPath.slice(oldPath.lastIndexOf("/") + 1);
      let matches = byFilename.get(filename) || [];
      if (oldPath.includes("/NoteEffect/effect001/"))
        matches = matches.filter((path) => path.includes("/NoteEffect/effect001/"));
      else if (oldPath.includes("/NoteEffect/common/"))
        matches = matches.filter((path) => path.includes("/NoteEffect/common/"));
      else if (oldPath.includes("/Live/Prefabs/LiveGame/Effect/"))
        matches = matches.filter((path) => path.includes("/LaneEffect/effect001/"));
      if (matches.length !== 1) throw new Error(`Missing or ambiguous runtime source ${oldPath}`);
      return matches[0]!;
    };
    const runtimeUrl = (path: string) =>
      `/runtime/${encodeURIComponent(this.server)}/${path
        .replace(/^runtime\//u, "")
        .split("/")
        .map(encodeURIComponent)
        .join("/")}`;
    const nativeAsset = (path: string): string => assetUrl(resolveSource(path));
    const nativeRuntime = (path: string): string => {
      const match = /^unity-json\/(.*)\/([A-Za-z0-9_]+\.json)$/u.exec(path);
      if (!match) return runtimeUrl(path);
      const oldSource = match[1]!;
      if (files.has(oldSource)) return runtimeUrl(path);
      return runtimeUrl(`unity-json/${resolveSource(oldSource)}/${match[2]}`);
    };
    const media: OurNotesRuntimeMediaManifest = {
      noteSkin: selectedSkin,
      noteEffectSkin: selectedEffectSkin,
      noteSeGroup: this.noteSeGroup,
      // Low quality loads effect001Light only when the release ships it; the
      // native loader falls back to the base skin otherwise.
      currentQuality:
        this.liveQuality !== 2 ||
        files.has("Assets/AddressableResources/Effect/Live/NoteEffect/effect001Light/LiveNoteEffectAssetSettings.asset")
          ? this.liveQuality
          : 1,
      ...(font ? { fontAtlasTextureUrl: this.output(font, "Texture2D") } : {}),
      hud: {
        judgementImages: {
          just: sprite(judgement, "judgment_just.png"),
          perfect: sprite(judgement, "judgment_perfect.png"),
          great: sprite(judgement, "judgment_great.png"),
          good: sprite(judgement, "judgment_good.png"),
          bad: sprite(judgement, "judgment_bad.png"),
          miss: sprite(judgement, "judgment_miss.png"),
          fast: sprite(judgement, "judgment_fast.png"),
          late: sprite(judgement, "judgment_late.png"),
        },
        comboLabelUrl: sprite(combo, "SP_combo_normal.png"),
        comboDigitUrls: digits("SP_combo_normal"),
        perfectComboLabelUrl: sprite(combo, "SP_combo_perfect.png"),
        perfectComboDigitUrls: digits("SP_combo_perfect"),
        pauseIconUrl: sprite(live, "IconPause_ingame.png"),
        pauseFrameUrl: sprite(live, "FrameNormalButton_H80_ingame.png"),
        pauseShadowUrl: sprite(live, "FrameNormalButton_H80_Shadow_ingame.png"),
        lifeIconUrls: {
          normal: sprite(live, "SP_ingame_icon_life.png"),
          danger: sprite(live, "SP_ingame_icon_life_danger_0.png"),
          over: sprite(live, "SP_ingame_icon_life_over_0.png"),
        },
        rankIconUrls: Object.fromEntries(
          ["D", "C", "B", "A", "S", "SS"].map((rank) => [
            rank,
            `${root}/Assets/AddressableResources/Effect/Live/RankIcon/Texture/RankIconAtlas/scorerank_${rank.toLowerCase()}_ingame.png`,
          ]),
        ) as OurNotesRuntimeMediaManifest["hud"]["rankIconUrls"],
        rankBaseUrl: sprite(live, "SP_ingame_header_rankbase.png"),
        roundMask14Url: sprite(live, "CircleBase14px_Mask_ingame.png"),
        statusBaseUrl: sprite(live, "circle_ingame_half.png"),
        scoreStarUrl: sprite(live, "star_ingame.png"),
        whiteSpriteUrl: sprite(live, "live_game_white.png"),
      },
    };
    return this.runtime().require(OUR_NOTES_RULES).createAssets(media, {
      asset: nativeAsset,
      runtime: nativeRuntime,
    });
  }

  private async load() {
    if (!this.source) return;
    const key = this.playbackSourceKey();
    const previousIdentity = this.playbackIdentity;
    const changed = key !== this.loadedKey;
    this.dispose();
    if (changed) {
      this.clearRange();
      this.rangeExpanded = false;
      this.currentTime = 0;
      this.duration = 0;
      this.appliedShareUrl = "";
      this.pendingShare = readChartPlaybackShare(new URL(location.href));
    }
    const controller = new AbortController();
    this.loadAbort = controller;
    const { signal } = controller;
    this.loadedKey = key;
    this.phase = "loading";
    await this.updateComplete;
    try {
      signal.throwIfAborted();
      const [response, assets] = await Promise.all([
        fetch(this.source, { headers: { accept: "text/plain" }, signal }),
        this.runtimeAssets(signal),
      ]);
      if (!response.ok) throw new Error(`Chart ${response.status}`);
      const sourceBytes = await response.arrayBuffer();
      const source = new TextDecoder().decode(sourceBytes);
      signal.throwIfAborted();
      const hash = globalThis.crypto?.subtle ? await crypto.subtle.digest("SHA-256", sourceBytes) : undefined;
      signal.throwIfAborted();
      if (this.playbackSourceKey() !== key) return;
      this.playbackIdentity = hash
        ? {
            hash: Array.from(new Uint8Array(hash), (value) => value.toString(16).padStart(2, "0")).join(""),
            releaseId: response.headers.get("x-haneoka-release-id") || undefined,
            sourceId: response.headers.get("x-haneoka-source-id") || undefined,
          }
        : undefined;
      if (
        previousIdentity &&
        this.playbackIdentity &&
        !sameChartPlaybackIdentity(previousIdentity, this.playbackIdentity)
      ) {
        this.clearRange();
        this.appliedShareUrl = "";
        this.pendingShare = readChartPlaybackShare(new URL(location.href));
      }
      this.chart = this.runtime().require(OUR_NOTES_RULES).parse(source);
      this.rangeIndex = chartRangeIndex(this.chart.notes, this.chart.bpmChanges);
      this.assets = assets;
      await this.initialize(signal);
      signal.throwIfAborted();
      this.phase = "ready";
      this.restorePlaybackShare();
      await this.updateComplete;
      this.resize();
    } catch (error) {
      if (signal.aborted) return;
      console.error(error);
      this.dispose();
      this.phase = "error";
    }
  }
  private restoreSettings() {
    try {
      const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "null") as {
        render?: Partial<RenderSettings>;
        stageBackground?: StageBackground;
        playbackRate?: number;
        volume?: number;
        noteSkin?: OurNotesNoteSkin;
        noteEffectSkin?: OurNotesNoteEffectSkin;
        liveQuality?: OurNotesLiveQuality;
        noteSeGroup?: OurNotesNoteSeGroup;
      } | null;
      if (!saved) return;
      const number = (value: unknown, minimum: number, maximum: number, fallback: number) => {
        const candidate = Number(value);
        return Number.isFinite(candidate) ? clamp(candidate, minimum, maximum) : fallback;
      };
      const render = saved.render || {};
      this.playerSettings = {
        ...DEFAULT_RENDER_SETTINGS,
        noteSpeed: number(render.noteSpeed, 1, 12, DEFAULT_RENDER_SETTINGS.noteSpeed),
        noteSize: number(render.noteSize, 0.5, 1.5, DEFAULT_RENDER_SETTINGS.noteSize),
        longAlpha: number(render.longAlpha, 0.1, 1, DEFAULT_RENDER_SETTINGS.longAlpha),
        guideAlpha: number(render.guideAlpha, 0.1, 1, DEFAULT_RENDER_SETTINGS.guideAlpha),
        guidelineCount: Math.round(number(render.guidelineCount, 0, 12, DEFAULT_RENDER_SETTINGS.guidelineCount)),
        guidelineOpacity: number(render.guidelineOpacity, 0, 1, DEFAULT_RENDER_SETTINGS.guidelineOpacity),
        laneOpacity: number(render.laneOpacity, 0, 1, DEFAULT_RENDER_SETTINGS.laneOpacity),
        backgroundBrightness: number(render.backgroundBrightness, 0, 1, DEFAULT_RENDER_SETTINGS.backgroundBrightness),
        mirror: typeof render.mirror === "boolean" ? render.mirror : DEFAULT_RENDER_SETTINGS.mirror,
        effects: typeof render.effects === "boolean" ? render.effects : DEFAULT_RENDER_SETTINGS.effects,
        showSimultaneousLine:
          typeof render.showSimultaneousLine === "boolean"
            ? render.showSimultaneousLine
            : DEFAULT_RENDER_SETTINGS.showSimultaneousLine,
        showJudgementLine:
          typeof render.showJudgementLine === "boolean"
            ? render.showJudgementLine
            : DEFAULT_RENDER_SETTINGS.showJudgementLine,
      };
      if (["auto", "none", ...Object.keys(OUR_NOTES_STAGE_NAMES)].includes(String(saved.stageBackground)))
        this.stageBackground = saved.stageBackground as StageBackground;
      this.playbackRate = number(saved.playbackRate, 0.5, 2, 1);
      this.volume = number(saved.volume, 0, 1, 0.8);
      if (OUR_NOTES_NOTE_SKINS.includes(saved.noteSkin as OurNotesNoteSkin)) this.noteSkin = saved.noteSkin!;
      if (OUR_NOTES_NOTE_EFFECT_SKINS.includes(saved.noteEffectSkin as OurNotesNoteEffectSkin))
        this.noteEffectSkin = saved.noteEffectSkin!;
      if (OUR_NOTES_LIVE_QUALITIES.includes(saved.liveQuality as OurNotesLiveQuality))
        this.liveQuality = saved.liveQuality!;
      if (OUR_NOTES_NOTE_SE_GROUP_IDS.includes(saved.noteSeGroup as OurNotesNoteSeGroup))
        this.noteSeGroup = saved.noteSeGroup!;
    } catch {
      localStorage.removeItem(SETTINGS_KEY);
    }
  }
  private persistSettings() {
    try {
      localStorage.setItem(
        SETTINGS_KEY,
        JSON.stringify({
          render: this.playerSettings,
          stageBackground: this.stageBackground,
          playbackRate: this.playbackRate,
          volume: this.volume,
          noteSkin: this.noteSkin,
          noteEffectSkin: this.noteEffectSkin,
          liveQuality: this.liveQuality,
          noteSeGroup: this.noteSeGroup,
        }),
      );
    } catch {
      /* Runtime controls remain usable without storage. */
    }
  }
  private stageBackgroundUrl() {
    if (this.stageBackground === "none") return undefined;
    const band =
      this.stageBackground === "auto" ? (OUR_NOTES_STAGE_NAMES[this.bandId] ? this.bandId : 0) : this.stageBackground;
    return `/assets/${encodeURIComponent(this.server)}/Assets/AddressableResources/Band/${band}/live_stage/lightweight_background.png`;
  }
  private async applyStageBackground() {
    try {
      await this.renderer?.setBackgroundTexture(this.stageBackgroundUrl());
    } catch (error) {
      console.warn("Unable to load the selected chart background", error);
    }
    this.draw();
  }
  private setRenderOption<K extends keyof RenderSettings>(key: K, value: RenderSettings[K]) {
    this.playerSettings = { ...this.playerSettings, [key]: value };
    this.persistSettings();
    this.draw();
  }
  private setPlaybackRate(value: number) {
    this.playbackRate = clamp(Number(value) || 1, 0.5, 2);
    if (this.clock) this.clock.audio.playbackRate = this.playbackRate;
    this.persistSettings();
  }
  private setVolume(value: number) {
    this.volume = clamp(Number(value) || 0, 0, 1);
    if (this.clock) this.clock.audio.volume = this.volume;
    this.persistSettings();
  }
  private async switchNoteSeGroup(target: OurNotesNoteSeGroup) {
    if (target === this.noteSeGroup && !this.noteSoundSwap) {
      this.noteSoundStatus = "idle";
      this.noteSoundSwapTarget = undefined;
      return;
    }
    this.noteSoundSwap?.controller.abort();
    this.noteSoundSwap?.player?.dispose();
    const swap: NoteSoundSwap = { controller: new AbortController(), target };
    this.noteSoundSwap = swap;
    this.noteSoundSwapTarget = target;
    this.noteSoundStatus = "loading";
    try {
      const replacement = this.runtime()
        .require(WEB_HOST)
        .createNoteSounds(ourNotesNoteSoundsForRelease(this.server, target));
      swap.player = replacement;
      if (this.playing) await replacement.unlock();
      else await replacement.load();
      if (swap.controller.signal.aborted || this.noteSoundSwap !== swap) {
        replacement.dispose();
        return;
      }
      const previous = this.noteSounds;
      this.noteSounds = replacement;
      this.noteSeGroup = target;
      this.noteSoundSwap = undefined;
      this.noteSoundSwapTarget = undefined;
      this.noteSoundStatus = "idle";
      this.persistSettings();
      previous?.dispose();
    } catch (error) {
      swap.player?.dispose();
      if (this.noteSoundSwap !== swap) return;
      this.noteSoundSwap = undefined;
      this.noteSoundSwapTarget = undefined;
      if (swap.controller.signal.aborted) {
        this.noteSoundStatus = "idle";
        return;
      }
      this.noteSoundStatus = "error";
      console.warn("Unable to load the selected chart note sounds", error);
    }
  }
  private async setStageBackground(value: StageBackground) {
    this.stageBackground = value;
    this.persistSettings();
    await this.applyStageBackground();
  }
  private async resetSettings() {
    this.playerSettings = { ...DEFAULT_RENDER_SETTINGS };
    this.stageBackground = "auto";
    this.playbackRate = 1;
    this.volume = 0.8;
    if (this.clock) {
      this.clock.audio.playbackRate = this.playbackRate;
      this.clock.audio.volume = this.volume;
    }
    this.persistSettings();
    await this.applyStageBackground();
    this.draw();
  }
  private async initialize(signal: AbortSignal) {
    const root = this.querySelector<HTMLElement>(".chart-runtime__stage");
    const canvas = this.querySelector<HTMLCanvasElement>(".chart-runtime__canvas");
    const hud = this.querySelector<HTMLCanvasElement>(".chart-runtime__hud");
    if (!root || !canvas || !hud || !this.chart || !this.assets) return;
    const renderer = this.runtime()
      .require(THREE_RENDERER)
      .create({ canvas, hudCanvas: hud, alpha: true, antialias: true, assets: this.assets });
    this.renderer = renderer;
    await Promise.all([
      loadDetailedOverviewSkin(this.assets).then((skin) => {
        if (signal.aborted) skin.dispose();
        else this.overviewSkin = skin;
      }),
      renderer.load(),
    ]);
    signal.throwIfAborted();
    await this.applyStageBackground();
    signal.throwIfAborted();
    this.clock = this.runtime()
      .require(WEB_HOST)
      .createClock(this.audioUrl, { volume: this.volume, playbackRate: this.playbackRate, loop: false });
    this.syncLoop();
    const clock = this.clock;
    const ownsClock = () => this.clock === clock && !signal.aborted;
    const updateDuration = () => {
      if (!ownsClock() || !this.chart) return;
      this.duration = (clock.durationMs || this.chart.durationMs) / 1000;
      this.rangeChanged(false);
      this.restorePlaybackShare();
      this.requestUpdate();
    };
    clock.audio.addEventListener("loadedmetadata", updateDuration);
    clock.audio.addEventListener("durationchange", updateDuration);
    this.noteSounds = this.runtime()
      .require(WEB_HOST)
      .createNoteSounds(ourNotesNoteSoundsForRelease(this.server, this.noteSeGroup));
    void this.noteSounds.load().catch((error: unknown) => {
      if (!signal.aborted) console.warn("Unable to load chart note sounds", error);
    });
    this.attachSession();
    this.clock.audio.addEventListener("play", () => {
      if (!ownsClock()) return;
      this.rangePlaybackIntent = true;
      this.playing = true;
      if (this.rangeStatus === "playbackUnavailable") this.rangeStatus = undefined;
      this.animateFrames();
    });
    this.clock.audio.addEventListener("pause", () => {
      if (!ownsClock()) return;
      this.playing = false;
      if (!clock.audio.ended && this.scrubClock !== clock) this.rangePlaybackIntent = false;
    });
    this.clock.audio.addEventListener("timeupdate", () => {
      if (ownsClock()) this.draw();
    });
    this.clock.audio.addEventListener("seeked", () => {
      if (!ownsClock()) return;
      this.rangeSeekPending = false;
      this.draw();
    });
    this.clock.audio.addEventListener("ended", () => {
      if (!ownsClock()) return;
      if (!this.repeatRange(true)) this.playing = false;
    });
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(root);
    const overviewHost = this.querySelector<HTMLElement>(".chart-simple-overview");
    if (overviewHost) {
      this.overviewResizeObserver = new ResizeObserver(() => {
        if (ownsClock() && this.mode === "simple" && this.phase === "ready") this.scheduleOverviewDraw();
      });
      this.overviewResizeObserver.observe(overviewHost);
    }
    this.duration = (this.clock.durationMs || this.chart.durationMs) / 1000;
    this.resize();
    this.draw();
  }
  private attachSession() {
    if (!this.chart) return;
    this.session = this.runtime().require(CASSIOPEIA_SESSION).create(this.chart, { mode: "watch" });
    this.frames = this.runtime().require(OUR_NOTES_RULES).createFrameBuilder(this.chart);
    this.session.on("judgement", (event) => {
      this.frames?.addJudgement(event, this.clock?.timeMs || 0);
      this.noteSounds?.queue(event);
    });
  }
  private resize() {
    const root = this.querySelector<HTMLElement>(".chart-runtime__stage");
    if (!root || !this.renderer) return;
    const ratio = renderPixelRatio(root.clientWidth, root.clientHeight);
    this.renderer.resize(root.clientWidth, root.clientHeight, ratio);
    this.draw();
    this.drawOverview();
  }
  private overviewInputs(): OverviewDrawInputs | undefined {
    const host = this.querySelector<HTMLElement>(".chart-simple-overview");
    const canvas = this.querySelector<HTMLCanvasElement>(".chart-simple-overview canvas");
    if (!host || !canvas || !this.chart || !this.overviewSkin) return;
    return {
      host,
      canvas,
      chart: this.chart,
      skin: this.overviewSkin,
      height: Math.max(360, host.clientHeight || 720),
      viewportWidth: host.clientWidth,
      viewportHeight: host.clientHeight,
      dpr: Math.max(1, Math.min(1.5, devicePixelRatio || 1)),
      epoch: this.loadEpoch,
      mode: this.mode,
      phase: this.phase,
    };
  }
  private sameOverviewInputs(first: OverviewDrawInputs, second: OverviewDrawInputs) {
    return (
      first.canvas === second.canvas &&
      first.host === second.host &&
      first.chart === second.chart &&
      first.skin === second.skin &&
      first.height === second.height &&
      first.viewportWidth === second.viewportWidth &&
      first.viewportHeight === second.viewportHeight &&
      first.dpr === second.dpr &&
      first.epoch === second.epoch &&
      first.mode === second.mode &&
      first.phase === second.phase
    );
  }
  private scheduleOverviewDraw() {
    const inputs = this.overviewInputs();
    if (!inputs || (this.overviewPaint && this.sameOverviewInputs(this.overviewPaint.inputs, inputs))) return;
    if (this.overviewFrame) return;
    this.overviewFrame = requestAnimationFrame(() => {
      this.overviewFrame = 0;
      if (this.isConnected) this.drawOverview();
    });
  }
  private overviewViewportResize = () => {
    if (this.mode === "simple" && this.phase === "ready") this.scheduleOverviewDraw();
  };
  private invalidateOverview() {
    this.cancelOverviewPointer();
    cancelAnimationFrame(this.overviewFrame);
    this.overviewFrame = 0;
    this.overviewPaint = undefined;
    this.overviewGeometry = undefined;
    this.overviewSelecting = false;
    this.overviewRevision += 1;
  }
  private drawOverview(force = false) {
    const inputs = this.overviewInputs();
    if (!inputs) {
      this.invalidateOverview();
      return;
    }
    if (!force && this.overviewPaint && this.sameOverviewInputs(this.overviewPaint.inputs, inputs)) return;
    const previous = this.overviewGeometry;
    const previousInputs = this.overviewPaint?.inputs;
    this.overviewGeometry = undefined;
    const paint = { inputs, geometry: undefined as ChartOverviewGeometry | undefined };
    this.overviewPaint = paint;
    try {
      paint.geometry = drawDetailedChartOverview(inputs.canvas, inputs.chart, inputs.skin, inputs.height);
      const next =
        inputs.phase === "ready" && inputs.mode === "simple" && inputs.viewportWidth > 0 && inputs.viewportHeight > 0
          ? paint.geometry
          : undefined;
      if (
        !sameChartOverviewGeometry(previous, next) ||
        previousInputs?.canvas !== inputs.canvas ||
        previousInputs?.viewportWidth !== inputs.viewportWidth ||
        previousInputs?.viewportHeight !== inputs.viewportHeight
      ) {
        this.cancelOverviewPointer();
        this.overviewRevision += 1;
      }
      this.overviewGeometry = next;
    } finally {
      if (!this.overviewGeometry) this.cancelOverviewPointer();
    }
  }
  private canSelectOverview() {
    if (this.phase !== "ready" || this.mode !== "simple" || !this.overviewGeometry || !this.mediaDuration())
      return false;
    const inputs = this.overviewInputs();
    return Boolean(inputs && this.overviewPaint && this.sameOverviewInputs(this.overviewPaint.inputs, inputs));
  }
  private setOverviewSelecting(enabled: boolean) {
    this.cancelOverviewPointer();
    this.overviewSelecting = enabled && this.canSelectOverview();
  }
  private cancelOverviewPointer() {
    const pointer = this.overviewPointer;
    this.overviewPointer = undefined;
    this.overviewDraft = undefined;
    window.removeEventListener("keydown", this.overviewEscape, true);
    try {
      if (pointer?.canvas.hasPointerCapture?.(pointer.id)) {
        pointer.canvas.releasePointerCapture(pointer.id);
      }
    } catch {
      // The captured canvas may already have left the document.
    }
  }
  private overviewEscape = (event: KeyboardEvent) => {
    if (event.key === "Escape" && this.overviewPointer) {
      event.preventDefault();
      event.stopPropagation();
      this.cancelOverviewPointer();
    }
  };
  private overviewPoint(event: PointerEvent, canvas: HTMLCanvasElement, host: HTMLElement, clampPoint: boolean) {
    const geometry = this.overviewGeometry;
    if (!geometry || !this.mediaDuration()) return;
    const rect = canvas.getBoundingClientRect();
    const viewport = host.getBoundingClientRect();
    if (!host.offsetWidth || !host.offsetHeight) return;
    const scaleX = viewport.width / host.offsetWidth;
    const scaleY = viewport.height / host.offsetHeight;
    const viewportLeft = viewport.left + host.clientLeft * scaleX;
    const viewportTop = viewport.top + host.clientTop * scaleY;
    const left = Math.max(rect.left, viewportLeft);
    const top = Math.max(rect.top, viewportTop);
    const right = Math.min(rect.right, viewportLeft + host.clientWidth * scaleX);
    const bottom = Math.min(rect.bottom, viewportTop + host.clientHeight * scaleY);
    if (right <= left || bottom <= top) return;
    if (!clampPoint && (event.clientX < left || event.clientX > right || event.clientY < top || event.clientY > bottom))
      return;
    const point = chartOverviewPointToTime(
      geometry,
      rect,
      clampPoint ? clamp(event.clientX, left, right) : event.clientX,
      clampPoint ? clamp(event.clientY, top, bottom) : event.clientY,
      clampPoint ? "clamp" : "reject",
    );
    return point ? Math.min(point.timeMs, this.mediaDuration() * 1000) : undefined;
  }
  private ownsOverviewPointer(event: PointerEvent) {
    const pointer = this.overviewPointer;
    return (
      pointer &&
      pointer.id === event.pointerId &&
      pointer.canvas === event.currentTarget &&
      pointer.canvas.isConnected &&
      pointer.epoch === this.loadEpoch &&
      pointer.revision === this.overviewRevision &&
      pointer.chart === this.chart &&
      this.overviewSelecting &&
      this.canSelectOverview()
    );
  }
  private overviewPointerDown = (event: PointerEvent) => {
    if (
      !event.isPrimary ||
      event.button !== 0 ||
      this.overviewPointer ||
      !this.overviewSelecting ||
      !this.canSelectOverview()
    )
      return;
    const canvas = event.currentTarget as HTMLCanvasElement;
    const host = canvas.closest<HTMLElement>(".chart-simple-overview");
    if (!host || !this.chart) return;
    const startMs = this.overviewPoint(event, canvas, host, false);
    if (startMs === undefined) return;
    this.rangePlaybackIntent = false;
    this.resumeAfterScrub = false;
    this.scrubClock = undefined;
    this.transportVisibility.setScrubbing(false);
    this.clock?.pause();
    this.playing = this.clock?.playing ?? false;
    this.overviewPointer = {
      id: event.pointerId,
      canvas,
      host,
      chart: this.chart,
      epoch: this.loadEpoch,
      revision: this.overviewRevision,
      startMs,
    };
    this.overviewDraft = { startMs, currentMs: startMs };
    try {
      canvas.setPointerCapture(event.pointerId);
    } catch {
      this.cancelOverviewPointer();
      return;
    }
    window.addEventListener("keydown", this.overviewEscape, true);
    event.preventDefault();
  };
  private overviewPointerMove = (event: PointerEvent) => {
    if (!this.overviewPointer || this.overviewPointer.id !== event.pointerId) return;
    if (!this.ownsOverviewPointer(event) || (event.pointerType === "mouse" && (event.buttons & 1) === 0)) {
      this.cancelOverviewPointer();
      return;
    }
    const pointer = this.overviewPointer;
    const currentMs = this.overviewPoint(event, pointer.canvas, pointer.host, true);
    if (currentMs === undefined) {
      this.cancelOverviewPointer();
      return;
    }
    this.overviewDraft = { startMs: pointer.startMs, currentMs };
    event.preventDefault();
  };
  private overviewPointerUp = (event: PointerEvent) => {
    if (!this.overviewPointer || this.overviewPointer.id !== event.pointerId) return;
    const pointer = this.overviewPointer;
    const currentMs = this.ownsOverviewPointer(event)
      ? this.overviewPoint(event, pointer.canvas, pointer.host, true)
      : undefined;
    this.cancelOverviewPointer();
    if (currentMs === undefined) return;
    const range = validChartPlaybackRange(
      Math.min(pointer.startMs, currentMs) / 1000,
      Math.max(pointer.startMs, currentMs) / 1000,
      this.mediaDuration(),
    );
    if (!range) return;
    this.rangeA = range.start;
    this.rangeB = range.end;
    this.rangeADraft = String(range.start);
    this.rangeBDraft = String(range.end);
    this.rangeChanged();
    event.preventDefault();
  };
  private overviewPointerCancel = (event: PointerEvent) => {
    if (this.overviewPointer?.id === event.pointerId) this.cancelOverviewPointer();
  };
  /** Renders the simple overview and downloads it as a framed PNG. */
  async downloadOverview(meta: Omit<ChartOverviewExportMeta, "locale">) {
    const canvas = this.querySelector<HTMLCanvasElement>(".chart-simple-overview canvas");
    const chart = this.chart;
    if (!canvas || this.phase !== "ready" || !chart) return;
    this.drawOverview(true);
    const localize = (value: number) => value.toLocaleString(this.locale || undefined);
    const stats = meta.stats.map((stat) => {
      if (stat.value !== "—" || !stat.id) return stat;
      // Older releases ship song-meta without the canonical metrics; the
      // loaded chart still carries duration, BPM and density.
      if (stat.id === "time") {
        const seconds = chart.durationMs / 1000;
        return { ...stat, value: `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, "0")}` };
      }
      if (stat.id === "bpm") {
        const values = chart.bpmChanges.map((change) => change.bpm).filter((value) => value > 0);
        if (!values.length) return stat;
        const first = Math.round(values[0]!);
        const max = Math.round(Math.max(...values));
        return { ...stat, value: max !== first ? `${first}–${max}` : `${first}` };
      }
      if (stat.id === "nps" && chart.durationMs > 0) {
        const judged = chart.notes.filter((note) => note.judged && note.visible).length;
        return { ...stat, value: (judged / (chart.durationMs / 1000)).toFixed(2) };
      }
      return stat;
    });
    if (stats.length) {
      // The per-kind breakdown follows the total note count (stats[0]).
      const kinds = countNoteKinds(chart);
      stats.splice(
        1,
        0,
        { label: this.ui("noteTap"), value: localize(kinds.tap) },
        { label: this.ui("noteFlick"), value: localize(kinds.flick) },
        { label: this.ui("noteSlide"), value: localize(kinds.slide) },
      );
    }
    const payload: ChartOverviewExportMeta = { ...meta, stats, locale: this.locale };
    const blob = await composeChartOverviewImage(canvas, payload);
    if (blob) downloadChartOverviewImage(blob, chartImageFileName(payload));
  }
  private draw() {
    if (!this.renderer || !this.session || !this.frames) return;
    if (this.repeatRange()) return;
    const time = this.clock?.timeMs ?? this.currentTime * 1000;
    const snapshot = this.session.updateReusable(time);
    const effectVolume = this.volume * 0.875;
    this.noteSounds?.flush(effectVolume);
    this.noteSounds?.setLongLineActive(this.playing && snapshot.activeLongLine, effectVolume);
    this.renderer.render(this.frames.buildReusable(time, snapshot, this.playerSettings));
    this.currentTime = this.clock ? this.mediaSeconds() : Math.max(0, time / 1000);
  }
  private animateFrames = () => {
    cancelAnimationFrame(this.animationFrame);
    const frame = () => {
      this.draw();
      if (this.playing) this.animationFrame = requestAnimationFrame(frame);
    };
    this.animationFrame = requestAnimationFrame(frame);
  };
  private async toggle() {
    const clock = this.clock;
    this.resumeAfterScrub = false;
    this.scrubClock = undefined;
    if (!clock?.source) {
      this.rangeStatus = "playbackUnavailable";
      return;
    }
    if (clock.playing) {
      this.rangePlaybackIntent = false;
      clock.pause();
    } else {
      const range = this.rangeLoop ? this.currentRange() : undefined;
      const time = this.mediaSeconds();
      if (range && (time < range.start || time >= range.end)) this.seek(range.start);
      else if (this.mediaDuration() && time >= this.mediaDuration() - 0.05) this.seek(0);
      try {
        this.rangePlaybackIntent = true;
        await Promise.all([this.noteSounds?.unlock(), clock.play()]);
      } catch {
        if (clock === this.clock) {
          if (clock.playing) {
            if (this.rangeStatus === "playbackUnavailable") this.rangeStatus = undefined;
          } else if (this.rangePlaybackIntent) {
            this.rangePlaybackIntent = false;
            this.rangeStatus = "playbackUnavailable";
          }
        }
      }
    }
  }
  private seek(seconds: number) {
    if (!this.clock || !this.session || !this.frames || !Number.isFinite(seconds)) return false;
    try {
      this.clock.seek(clamp(seconds, 0, this.mediaDuration() || this.duration) * 1000);
    } catch {
      this.rangeSeekPending = false;
      this.rangeStatus = "playbackUnavailable";
      return false;
    }
    this.frames.reset();
    this.session.reset(this.clock.timeMs);
    this.currentTime = this.mediaSeconds();
    this.draw();
    return true;
  }
  private previewSeek(seconds: number) {
    const clock = this.clock;
    if (!clock) return;
    this.transportVisibility.setScrubbing(true);
    if (this.scrubClock !== clock) {
      this.resumeAfterScrub = clock.playing;
      this.scrubClock = clock;
    }
    if (clock.playing) {
      this.rangePlaybackIntent = false;
      clock.pause();
    }
    this.seek(seconds);
  }
  private async commitSeek(seconds: number) {
    const clock = this.clock;
    const resume = this.scrubClock === clock && this.resumeAfterScrub;
    this.resumeAfterScrub = false;
    this.scrubClock = undefined;
    try {
      this.seek(seconds);
      if (!resume) return;
      const range = this.rangeLoop ? this.currentRange() : undefined;
      const time = this.mediaSeconds();
      if (range && (time < range.start || time >= range.end)) this.seek(range.start);
      this.rangePlaybackIntent = true;
      await Promise.all([this.noteSounds?.unlock(), clock?.play()]);
    } catch {
      if (clock && clock === this.clock) {
        if (clock.playing) {
          if (this.rangeStatus === "playbackUnavailable") this.rangeStatus = undefined;
        } else if (this.rangePlaybackIntent) {
          this.rangePlaybackIntent = false;
          this.rangeStatus = "playbackUnavailable";
        }
      }
    } finally {
      if (clock === this.clock) this.transportVisibility.setScrubbing(false);
    }
  }
  private fullscreenChanged = () => {
    this.fullscreen = this.viewportFullscreen.isActive() || document.fullscreenElement === this;
  };
  private toggleLoop() {
    this.loop = !this.loop;
    if (this.loop) this.rangeLoop = false;
    this.syncLoop();
  }
  private collapseTransport = () => {
    this.transportVisibility.collapse();
    void this.updateComplete.then(() => this.querySelector<HTMLElement>(".chart-runtime__stage")?.focus());
  };
  private stagePointerDown = (event: PointerEvent) => {
    if (!event.isPrimary || event.button !== 0) return;
    this.stagePointer = { x: event.clientX, y: event.clientY };
  };
  private stageClick = (event: MouseEvent) => {
    const start = this.stagePointer;
    this.stagePointer = undefined;
    if (event.detail === 0 || (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) <= 8))
      this.transportVisibility.expand();
  };
  private stageKeydown = (event: KeyboardEvent) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    event.stopPropagation();
    this.transportVisibility.expand();
    if (event.key === " " && !event.repeat) void this.toggle();
    void this.updateComplete.then(() =>
      this.querySelector<HTMLElement>(".playback-controls__expanded button")?.focus(),
    );
  };
  private async toggleFullscreen() {
    // iOS WebKit has no element fullscreen API; expand the existing pane over
    // the visual viewport instead, preserving the renderer's DOM position.
    if (this.viewportFullscreen.isActive()) {
      this.viewportFullscreen.exit();
      return;
    }
    if (document.fullscreenElement) {
      await document.exitFullscreen();
      return;
    }
    if (
      typeof document.documentElement.requestFullscreen !== "function" ||
      typeof this.requestFullscreen !== "function"
    ) {
      this.viewportFullscreen.enter();
      return;
    }
    try {
      await this.requestFullscreen();
    } catch {
      if (!document.fullscreenElement) this.viewportFullscreen.enter();
    }
  }
  private dispose() {
    this.invalidateOverview();
    this.overviewResizeObserver?.disconnect();
    this.overviewResizeObserver = undefined;
    this.loadEpoch++;
    this.loadAbort?.abort();
    this.loadAbort = undefined;
    this.noteSoundSwap?.controller.abort();
    this.noteSoundSwap?.player?.dispose();
    this.noteSoundSwap = undefined;
    this.noteSoundSwapTarget = undefined;
    this.noteSoundStatus = "idle";
    this.sourceFilesCache = undefined;
    this.pluginRuntime?.dispose();
    this.pluginRuntime = undefined;
    cancelAnimationFrame(this.animationFrame);
    this.playing = false;
    this.transportVisibility.setPlaying(false);
    this.transportVisibility.setScrubbing(false);
    this.resumeAfterScrub = false;
    this.scrubClock = undefined;
    this.rangeSeekPending = false;
    this.rangePlaybackIntent = false;
    this.playbackIdentity = undefined;
    this.rangeIndex = undefined;
    this.resizeObserver?.disconnect();
    this.stagePointer = undefined;
    this.clock?.destroy();
    this.noteSounds?.dispose();
    this.overviewSkin?.dispose();
    this.renderer?.dispose();
    this.renderer = undefined;
    this.clock = undefined;
    this.noteSounds = undefined;
    this.overviewSkin = undefined;
  }
  private format(seconds: number) {
    const value = Math.max(0, Math.floor(seconds));
    return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`;
  }
  private ui(key: ChartUiKey) {
    if (key === "collapse" || key === "expand") return uiText(this.locale, uiLabelPaths[key] ?? key);
    return uiText(this.locale, `media.chartPlayer.${key}`);
  }
  private renderSettingSlider(
    key: NumericRenderSetting,
    label: string,
    minimum: number,
    maximum: number,
    step: number,
    format: (value: number) => string = (value) => value.toFixed(1),
  ) {
    const value = Number(this.playerSettings[key]);
    return html`
      <label class="chart-runtime__setting chart-runtime__setting--slider">
        <span>
          <span>${label}</span>
          <output>${format(value)}</output>
        </span>
        <md-slider
          class="md3-slider md3-slider--runtime"
          min=${minimum}
          max=${maximum}
          step=${step}
          .value=${String(value)}
          @input=${(event: Event) =>
            this.setRenderOption(key, Number((event.target as HTMLElement & { value?: number }).value))}
          aria-label=${label}
        ></md-slider>
      </label>
    `;
  }
  private renderToggle(key: "mirror" | "effects" | "showSimultaneousLine" | "showJudgementLine", label: string) {
    return html`
      <label class="chart-runtime__setting chart-runtime__setting--toggle">
        <span>${label}</span>
        <input
          type="checkbox"
          .checked=${Boolean(this.playerSettings[key])}
          @change=${(event: Event) => this.setRenderOption(key, (event.currentTarget as HTMLInputElement).checked)}
        />
      </label>
    `;
  }
  private renderRangeControls() {
    const range = this.currentRange();
    const stats = range && this.rangeIndex ? chartRangeStatistics(this.rangeIndex, range) : undefined;
    const number = new Intl.NumberFormat(this.locale, { maximumFractionDigits: 2 });
    const bpm =
      stats?.minimumBpm === undefined
        ? "—"
        : stats.minimumBpm === stats.maximumBpm
          ? number.format(stats.minimumBpm)
          : `${number.format(stats.minimumBpm)}–${number.format(stats.maximumBpm!)}`;
    return html`
      <section class="chart-runtime__range">
        ${accordion({
          id: this.rangePanelId,
          label: this.rangeText("rangePlayback"),
          expanded: this.rangeExpanded,
          onExpandedChange: (expanded) => (this.rangeExpanded = expanded),
          content: html`
            <div class="chart-runtime__settings-content">
              <md-outlined-text-field
                class="chart-runtime__setting"
                type="number"
                min="0"
                max=${this.mediaDuration()}
                step="0.01"
                label=${this.rangeText("rangeA")}
                .value=${this.rangeADraft}
                ?disabled=${!this.mediaDuration()}
                @input=${(event: Event) => {
                  this.cancelOverviewPointer();
                  this.rangeADraft = (event.currentTarget as HTMLElement & { value: string }).value;
                }}
                @change=${(event: Event) => this.commitRangePoint("a", (event.currentTarget as HTMLElement & { value: string }).value)}
              ></md-outlined-text-field>
              <md-outlined-text-field
                class="chart-runtime__setting"
                type="number"
                min="0"
                max=${this.mediaDuration()}
                step="0.01"
                label=${this.rangeText("rangeB")}
                .value=${this.rangeBDraft}
                ?disabled=${!this.mediaDuration()}
                @input=${(event: Event) => {
                  this.cancelOverviewPointer();
                  this.rangeBDraft = (event.currentTarget as HTMLElement & { value: string }).value;
                }}
                @change=${(event: Event) => this.commitRangePoint("b", (event.currentTarget as HTMLElement & { value: string }).value)}
              ></md-outlined-text-field>
              <div class="chart-runtime__range-actions">
                <button
                  class="button button--text"
                  type="button"
                  ?disabled=${!this.mediaDuration()}
                  @click=${() => this.setRangePoint("a")}
                >
                  ${this.rangeText("setA")}
                </button>
                <button
                  class="button button--text"
                  type="button"
                  ?disabled=${!this.mediaDuration()}
                  @click=${() => this.setRangePoint("b")}
                >
                  ${this.rangeText("setB")}
                </button>
                <button class="button button--text" type="button" @click=${this.clearRange}>
                  ${this.rangeText("clearRange")}
                </button>
              </div>
              <label class="chart-runtime__setting chart-runtime__setting--toggle">
                <span>${this.rangeText("rangeLoop")}</span>
                <md-switch
                  .selected=${this.rangeLoop}
                  ?disabled=${!range}
                  aria-label=${this.rangeText("rangeLoop")}
                  @change=${(event: Event) => this.setRangeLoop((event.currentTarget as HTMLElement & { selected: boolean }).selected)}
                ></md-switch>
              </label>
              ${
                stats
                  ? html`
                      <dl class="chart-runtime__range-stats">
                        <div>
                          <dt>${this.rangeText("rangeNotes")}</dt>
                          <dd>${number.format(stats.notes)}</dd>
                        </div>
                        <div>
                          <dt>${this.rangeText("rangeDensity")}</dt>
                          <dd>${number.format(stats.notesPerSecond)}</dd>
                        </div>
                        <div>
                          <dt>${this.rangeText("rangeBpm")}</dt>
                          <dd>${bpm}</dd>
                        </div>
                      </dl>
                    `
                  : nothing
              }
            </div>
          `,
        })}
      </section>
    `;
  }
  private renderRangeStatus() {
    if (!this.rangeStatus && !this.sharedPlaybackUrl) return nothing;
    return html`
      <p class="chart-runtime__range-status" role="status" aria-live="polite">
        ${this.rangeStatus ? this.rangeText(this.rangeStatus) : nothing}
        ${
          this.sharedPlaybackUrl
            ? html`
                <a class="button button--text" href=${this.sharedPlaybackUrl}>${this.rangeText("shareTime")}</a>
              `
            : nothing
        }
      </p>
    `;
  }
  private renderOverviewSelection() {
    const geometry = this.overviewGeometry;
    if (!geometry) return nothing;
    const range = this.currentRange();
    const draft = this.overviewDraft;
    const start = draft ? Math.min(draft.startMs, draft.currentMs) : range ? range.start * 1000 : undefined;
    const end = draft ? Math.max(draft.startMs, draft.currentMs) : range ? range.end * 1000 : undefined;
    if (start === undefined || end === undefined || end <= start) return nothing;
    return svg`
      <svg
        class="chart-overview-selection"
        width=${geometry.cssWidth}
        height=${geometry.cssHeight}
        viewBox=${`0 0 ${geometry.cssWidth} ${geometry.cssHeight}`}
        preserveAspectRatio="none"
        data-preview=${draft ? "true" : "false"}
        aria-hidden="true"
        focusable="false"
      >
        ${geometry.columns.map((column) => {
          const from = Math.max(start, column.startMs);
          const to = Math.min(end, column.endMs);
          if (to <= from) return nothing;
          const top = geometry.cssHeight - ((to - column.startMs) / 1000) * geometry.heightPerSecond;
          const bottom = geometry.cssHeight - ((from - column.startMs) / 1000) * geometry.heightPerSecond;
          return svg`<rect x=${column.leftCss} y=${top} width=${geometry.columnWidth} height=${bottom - top}></rect>`;
        })}
      </svg>
    `;
  }
  private renderOverviewControls() {
    if (this.phase !== "ready" || this.mode !== "simple") return nothing;
    return html`
      <div class="chart-overview-controls">
        <label class="chart-runtime__setting chart-runtime__setting--toggle">
          <span>${this.rangeText("overviewSelectRange")}</span>
          <md-switch
            .selected=${this.overviewSelecting}
            ?disabled=${!this.canSelectOverview()}
            aria-label=${this.rangeText("overviewSelectRange")}
            @change=${(event: Event) => this.setOverviewSelecting((event.currentTarget as HTMLElement & { selected: boolean }).selected)}
          ></md-switch>
        </label>
        ${this.renderRangeControls()} ${this.renderRangeStatus()}
      </div>
    `;
  }
  private renderSettingsPanel() {
    if (!this.settingsOpen) return nothing;
    const percent = (value: number) => `${Math.round(value * 100)}%`;
    return html`
      <aside class="chart-runtime__settings" role="dialog" aria-label=${this.ui("settings")}>
        <header>
          <strong>${this.ui("settings")}</strong>
          <span>
            <button class="icon-button" @click=${this.resetSettings} aria-label=${this.ui("reset")}>
              <svg class="material-icon" width="18" height="18"><use href="/icons.svg#restart_alt"></use></svg>
            </button>
            <button class="icon-button" @click=${() => (this.settingsOpen = false)} aria-label=${this.ui("close")}>
              <svg class="material-icon" width="18" height="18"><use href="/icons.svg#close"></use></svg>
            </button>
          </span>
        </header>
        <div class="chart-runtime__settings-content">
          <section>
            <h4>${this.ui("playback")}</h4>
            <label class="chart-runtime__setting chart-runtime__setting--slider">
              <span>
                <span>${this.ui("volume")}</span>
                <output>${percent(this.volume)}</output>
              </span>
              <md-slider
                class="md3-slider md3-slider--runtime"
                min="0"
                max="1"
                step="0.05"
                .value=${String(this.volume)}
                @input=${(event: Event) =>
                  this.setVolume(Number((event.target as HTMLElement & { value?: number }).value))}
                aria-label=${this.ui("volume")}
              ></md-slider>
            </label>
            <label class="chart-runtime__setting chart-runtime__setting--select">
              <span>${this.ui("playbackSpeed")}</span>
              <select
                @change=${(event: Event) => this.setPlaybackRate(Number((event.currentTarget as HTMLSelectElement).value))}
              >
                ${[0.5, 0.75, 1, 1.25, 1.5, 2].map(
                  (value) => html`
                    <option value=${value} ?selected=${this.playbackRate === value}>
                      ${value.toFixed(value % 1 ? 2 : 1)}×
                    </option>
                  `,
                )}
              </select>
            </label>
          </section>
          ${this.renderRangeControls()}
          <section>
            <h4>${this.ui("notes")}</h4>
            <label class="chart-runtime__setting chart-runtime__setting--select">
              <span>${this.ui("noteSkin")}</span>
              <select
                @change=${(event: Event) => {
                  const position = this.mediaSeconds();
                  const resume = this.clock?.playing ?? false;
                  this.noteSkin = (event.currentTarget as HTMLSelectElement).value as OurNotesNoteSkin;
                  this.persistSettings();
                  const loading = this.load();
                  const epoch = this.loadEpoch;
                  void loading.then(async () => {
                    if (this.phase !== "ready" || epoch !== this.loadEpoch) return;
                    if (!this.seek(position)) return;
                    if (resume) await this.toggle();
                  });
                }}
              >
                ${this.availableNoteSkins.map(
                  (skin) => html`
                    <option value=${skin} ?selected=${this.noteSkin === skin}>
                      ${OUR_NOTES_NOTE_SKIN_NAMES[skin][this.locale] || OUR_NOTES_NOTE_SKIN_NAMES[skin].en}
                    </option>
                  `,
                )}
              </select>
            </label>
            <label class="chart-runtime__setting chart-runtime__setting--select">
              <span>${this.ui("noteEffectSkin")}</span>
              <select
                @change=${(event: Event) => {
                  const position = this.mediaSeconds();
                  const resume = this.clock?.playing ?? false;
                  this.noteEffectSkin = (event.currentTarget as HTMLSelectElement).value as OurNotesNoteEffectSkin;
                  this.persistSettings();
                  const loading = this.load();
                  const epoch = this.loadEpoch;
                  void loading.then(async () => {
                    if (this.phase !== "ready" || epoch !== this.loadEpoch) return;
                    if (!this.seek(position)) return;
                    if (resume) await this.toggle();
                  });
                }}
              >
                ${this.availableNoteEffectSkins.map(
                  (skin) => html`
                    <option value=${skin} ?selected=${this.noteEffectSkin === skin}>
                      ${
                        OUR_NOTES_NOTE_EFFECT_SKIN_NAMES[skin][this.locale] || OUR_NOTES_NOTE_EFFECT_SKIN_NAMES[skin].en
                      }
                    </option>
                  `,
                )}
              </select>
            </label>
            <label class="chart-runtime__setting chart-runtime__setting--select">
              <span>${this.ui("liveQuality")}</span>
              <select
                @change=${(event: Event) => {
                  const position = this.mediaSeconds();
                  const resume = this.clock?.playing ?? false;
                  this.liveQuality = Number((event.currentTarget as HTMLSelectElement).value) as OurNotesLiveQuality;
                  this.persistSettings();
                  const loading = this.load();
                  const epoch = this.loadEpoch;
                  void loading.then(async () => {
                    if (this.phase !== "ready" || epoch !== this.loadEpoch) return;
                    if (!this.seek(position)) return;
                    if (resume) await this.toggle();
                  });
                }}
              >
                ${OUR_NOTES_LIVE_QUALITIES.map(
                  (quality) => html`
                    <option value=${quality} ?selected=${this.liveQuality === quality}>
                      ${OUR_NOTES_LIVE_QUALITY_NAMES[quality][this.locale] || OUR_NOTES_LIVE_QUALITY_NAMES[quality].en}
                    </option>
                  `,
                )}
              </select>
            </label>
            <label class="chart-runtime__setting chart-runtime__setting--select">
              <span>${this.ui("noteSe")}</span>
              <select
                @change=${(event: Event) =>
                  void this.switchNoteSeGroup(
                    Number((event.currentTarget as HTMLSelectElement).value) as OurNotesNoteSeGroup,
                  )}
              >
                ${OUR_NOTES_NOTE_SE_GROUP_IDS.map(
                  (group) => html`
                    <option value=${group} ?selected=${(this.noteSoundSwapTarget ?? this.noteSeGroup) === group}>
                      ${OUR_NOTES_NOTE_SE_GROUP_NAMES[group][this.locale] || OUR_NOTES_NOTE_SE_GROUP_NAMES[group].en}
                    </option>
                  `,
                )}
              </select>
            </label>
            ${
              this.noteSoundStatus === "loading"
                ? html`
                    <div class="chart-runtime__setting" role="status" aria-live="polite" aria-busy="true">
                      <span>${this.ui("noteSeLoading")}</span>
                      ${loadingIndicator({ label: this.ui("loading") })}
                    </div>
                  `
                : this.noteSoundStatus === "error"
                  ? html`
                      <div class="chart-runtime__setting" role="alert">${this.ui("noteSeError")}</div>
                    `
                  : nothing
            }
            ${this.renderSettingSlider("noteSpeed", this.ui("noteSpeed"), 1, 12, 0.1)}
            ${this.renderSettingSlider("noteSize", this.ui("noteSize"), 0.5, 1.5, 0.05, percent)}
            ${this.renderSettingSlider("longAlpha", this.ui("longOpacity"), 0.1, 1, 0.05, percent)}
            ${this.renderSettingSlider("guideAlpha", this.ui("guideOpacity"), 0.1, 1, 0.05, percent)}
            ${this.renderToggle("mirror", this.ui("mirror"))} ${this.renderToggle("effects", this.ui("effects"))}
            ${this.renderToggle("showSimultaneousLine", this.ui("simultaneousLine"))}
            ${this.renderToggle("showJudgementLine", this.ui("judgementLine"))}
          </section>
          <section>
            <h4>${this.ui("stage")}</h4>
            <label class="chart-runtime__setting chart-runtime__setting--select">
              <span>${this.ui("stageBackground")}</span>
              <select
                @change=${(event: Event) =>
                  void this.setStageBackground((event.currentTarget as HTMLSelectElement).value as StageBackground)}
              >
                <option value="auto" ?selected=${this.stageBackground === "auto"}>${this.ui("songBand")}</option>
                ${Object.entries(OUR_NOTES_STAGE_NAMES).map(
                  ([id, names]) => html`
                    <option value=${id} ?selected=${this.stageBackground === id}>
                      ${names[this.locale] || names.en}
                    </option>
                  `,
                )}
                <option value="none" ?selected=${this.stageBackground === "none"}>${this.ui("noBackground")}</option>
              </select>
            </label>
            ${this.renderSettingSlider("backgroundBrightness", this.ui("backgroundBrightness"), 0, 1, 0.05, percent)}
            ${this.renderSettingSlider("laneOpacity", this.ui("laneOpacity"), 0, 1, 0.05, percent)}
            ${this.renderSettingSlider("guidelineOpacity", this.ui("guidelineOpacity"), 0, 1, 0.05, percent)}
            <label class="chart-runtime__setting chart-runtime__setting--select">
              <span>${this.ui("guidelineCount")}</span>
              <select
                @change=${(event: Event) =>
                  this.setRenderOption("guidelineCount", Number((event.currentTarget as HTMLSelectElement).value))}
              >
                ${[0, 2, 4, 6, 12].map(
                  (value) => html`
                    <option value=${value} ?selected=${this.playerSettings.guidelineCount === value}>${value}</option>
                  `,
                )}
              </select>
            </label>
          </section>
        </div>
      </aside>
    `;
  }
  render() {
    return html`
      <section class="chart-runtime">
        ${
          this.phase === "loading"
            ? html`
                ${loadingState(this.ui("loading"))}
              `
            : this.phase === "error"
              ? html`
                  <div class="notice"><p>${this.ui("runtimeError")}</p></div>
                `
              : nothing
        }
        <div class="chart-simple-view" ?hidden=${this.phase !== "ready" || this.mode !== "simple"}>
          ${this.renderOverviewControls()}
          <div
            class="chart-simple-overview"
            data-selection-mode=${this.overviewSelecting && this.canSelectOverview() ? "true" : "false"}
          >
            <div class="chart-overview-track">
              <canvas
                aria-label=${this.label}
                @pointerdown=${this.overviewPointerDown}
                @pointermove=${this.overviewPointerMove}
                @pointerup=${this.overviewPointerUp}
                @pointercancel=${this.overviewPointerCancel}
                @lostpointercapture=${this.overviewPointerCancel}
              ></canvas>
              ${this.renderOverviewSelection()}
            </div>
          </div>
        </div>
        <div
          class="chart-runtime__stage"
          ?hidden=${this.phase !== "ready" || this.mode !== "watch"}
          role="region"
          aria-label=${this.label}
          tabindex="0"
          @pointerdown=${this.stagePointerDown}
          @click=${this.stageClick}
          @pointercancel=${() => (this.stagePointer = undefined)}
          @pointermove=${(event: PointerEvent) => {
            if (event.pointerType === "mouse") this.transportVisibility.expand();
          }}
          @keydown=${this.stageKeydown}
        >
          <canvas class="chart-runtime__canvas"></canvas>
          <canvas class="chart-runtime__hud"></canvas>
        </div>
        ${
          this.phase === "ready" && this.mode === "watch"
            ? html`
                <footer
                  class="chart-runtime__controls playback-controls"
                  data-collapsed=${this.transportCollapsed ? "true" : "false"}
                  data-auto-hidden=${this.transportAutoHidden ? "true" : "false"}
                  aria-label=${uiText(this.locale, "media.audio.morePlaybackControls")}
                >
                  <div
                    class="playback-controls__expanded"
                    ?inert=${this.transportCollapsed || this.transportAutoHidden}
                    aria-hidden=${this.transportCollapsed || this.transportAutoHidden}
                  >
                    <button
                      class="icon-button"
                      @click=${this.toggle}
                      aria-label=${this.playing ? this.ui("pause") : this.ui("play")}
                    >
                      <svg class="material-icon" width="24" height="24">
                        <use href=${this.playing ? "/icons.svg#pause" : "/icons.svg#play_arrow"}></use>
                      </svg>
                    </button>
                    <div class="chart-runtime__timeline">
                      <small>${this.format(this.currentTime)}</small>
                      <md-slider
                        class="md3-slider md3-slider--runtime"
                        min="0"
                        max=${this.duration || 1}
                        step="0.01"
                        .value=${String(this.currentTime)}
                        ?disabled=${!this.mediaDuration()}
                        aria-label=${uiText(this.locale, "common.actions.seek")}
                        @input=${(event: Event) =>
                          this.previewSeek(Number((event.target as HTMLElement & { value?: number }).value))}
                        @change=${(event: Event) =>
                          void this.commitSeek(Number((event.target as HTMLElement & { value?: number }).value))}
                      ></md-slider>
                      <small>${this.format(this.duration)}</small>
                    </div>
                    <div class="chart-runtime__actions">
                      <button
                        class="icon-button"
                        type="button"
                        ?disabled=${!this.playbackIdentity || !this.mediaDuration() || !this.canonicalSharePage()}
                        aria-label=${this.rangeText("shareTime")}
                        title=${this.rangeText("shareTime")}
                        @click=${() => void this.sharePlayback()}
                      >
                        ${icon("share", 20)}
                      </button>
                      <button
                        class="icon-button"
                        aria-pressed=${this.settingsOpen}
                        @click=${() => (this.settingsOpen = !this.settingsOpen)}
                        aria-label=${this.ui("settings")}
                      >
                        <svg class="material-icon" width="20" height="20">
                          <use href=${`/icons.svg#tune${this.settingsOpen ? "-filled" : ""}`}></use>
                        </svg>
                      </button>
                      <button
                        class="icon-button"
                        aria-pressed=${this.loop}
                        @click=${this.toggleLoop}
                        aria-label=${this.ui("loop")}
                      >
                        <svg class="material-icon" width="20" height="20">
                          <use href=${`/icons.svg#refresh${this.loop ? "-filled" : ""}`}></use>
                        </svg>
                      </button>
                      <button
                        class="icon-button"
                        @click=${this.toggleFullscreen}
                        aria-pressed=${this.fullscreen}
                        aria-label=${uiText(this.locale, this.fullscreen ? "story.labels.fullscreenExit" : "common.actions.fullscreen")}
                        title=${uiText(this.locale, this.fullscreen ? "story.labels.fullscreenExit" : "common.actions.fullscreen")}
                      >
                        ${icon(this.fullscreen ? "fullscreen_exit" : "fullscreen", 20)}
                      </button>
                      <button
                        class="icon-button"
                        type="button"
                        @click=${this.collapseTransport}
                        aria-label=${this.ui("collapse")}
                      >
                        <svg class="material-icon" width="20" height="20">
                          <use href="/icons.svg#expand_more"></use>
                        </svg>
                      </button>
                    </div>
                  </div>
                </footer>
                ${this.renderSettingsPanel()} ${this.renderRangeStatus()}
              `
            : nothing
        }
      </section>
    `;
  }
}
customElements.define("chart-simulator", ChartSimulator);
