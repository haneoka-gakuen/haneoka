import { PreparedResource } from "@haneoka/cassiopeia-host-web";
import { LitElement, html, nothing } from "lit";
import { NoColorSpace, TextureLoader, type Texture } from "three";
import { fetchJson, uiText } from "../shared/catalog";
import { loadingState } from "../ui/state";
import { icon } from "../ui/icon";
import { type ChartDocument, type WatchVisualReplayContract, type SessionOptions } from "@haneoka/cassiopeia";
import { BESTDORI_CATALOG_VERSION } from "@haneoka/bestdori/resources";
import {
  CassiopeiaRuntime,
  CASSIOPEIA_SESSION,
  createKernelPlugin,
  type CassiopeiaSessionPort,
} from "@haneoka/cassiopeia/plugin";
import {
  OUR_NOTES_RULES,
  createOurNotesSessionOptions,
  createOurNotesAutomaticPolicy,
  OUR_NOTES_CHART_UI_PROFILE,
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
  OUR_NOTES_LIGHTWEIGHT_BACKGROUND,
  buildOurNotesLightweightBackground,
  NativeIntroPlayback,
  TitleIntroductionPresentation,
  createOurNotesTitleIntroductionContent,
  OurNotesGekisouPlan,
  OurNotesGekisouOverlayProjector,
  OurNotesGekisouEntryProjector,
  OurNotesGekisouStageProjector,
  OUR_NOTES_GEKISOU_STAGE_PROFILE_URL,
  type OurNotesGekisouEffectProfile,
  type OurNotesGekisouEffectMode,
  type OurNotesGekisouEntryInput,
  OUR_NOTES_GEKISOU_VIEW_SETTINGS,
  unityStringHash,
  parseHudComboAtlasGeometry,
  parseHudSpriteGeometry,
  createOurNotesPlugin,
  ourNotesNoteSoundsForRelease,
  type RenderFrameBuilder,
  type TitleIntroductionContent,
  type RenderSettings,
  type OurNotesAssetManifest,
  type OurNotesRuntimeMediaManifest,
  type OurNotesLiveQuality,
  type OurNotesNoteSeGroup,
  type OurNotesNoteEffectSkin,
  type OurNotesNoteSkin,
} from "@haneoka/cassiopeia-plugin-our-notes";
import {
  NativeIntroAssembly,
  NativeIntroSourceIndex,
  ChartGpuTimerProbe,
  ChartPerfProbe,
  THREE_RENDERER,
  createThreeRendererPlugin,
  loadBackgroundPixels,
  backgroundPixelsCanvas,
  type NativeIntroObjectRecord,
  type NativeIntroBindingSink,
  type OurNotesRenderer,
} from "@haneoka/cassiopeia-renderer-three";
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
import { applyRenderQuality, observeRenderQuality, readRenderQuality, writeRenderQuality, DEFAULT_RENDER_QUALITY } from "../../lib/render-quality";
import "../ui/render-quality-settings";

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

type RuntimeOutput = { objectId: string | number; path: string; type: string; serializedFile?: string };
type RuntimeDescriptor = {
  sourcePath?: string;
  serializedFile?: string;
  runtimeProjectionPolicy?: string;
  preloadObjectReferences?: Array<{ serializedFile: string; pathId: string }>;
  outputs?: RuntimeOutput[];
  runtimeObjects?: Array<{ type: string; path: string }>;
};
type StageBackground = "auto" | "none" | "0" | "1" | "2" | "3" | "4" | "5";
type NumericRenderSetting =
  "noteSpeed" | "noteSize" | "longAlpha" | "guideAlpha" | "guidelineOpacity" | "laneOpacity" | "backgroundBrightness";
type ChartUiKey =
  | "liveMode"
  | "normalLive"
  | "gekisouLive"
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
  | "continuationEffects"
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

const SETTINGS_KEY = "haneoka:chart-player:v1";
let rustWatchFactory: Promise<(chart: ChartDocument, options?: SessionOptions) => CassiopeiaSessionPort> | undefined;
function loadRustWatchSessionFactory() {
  return (rustWatchFactory ??= Promise.all([
    import("@haneoka/cassiopeia/wasm"),
    import("@haneoka/cassiopeia/wasm-session"),
  ]).then(async ([wasm, adapter]) => {
    await wasm.default();
    return adapter.createWasmWatchSessionFactory(wasm);
  }).catch(error => { rustWatchFactory = undefined; throw error; }));
}


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
  private stopRenderQuality?: () => void;
  static properties = {
    source: { type: String },
    audioUrl: { type: String, attribute: "audio-url" },
    chartFormat: { type: String, attribute: "chart-format" },
    offsetMs: { type: Number, attribute: "offset-ms" },
    bandId: { type: Number, attribute: "band-id" },
    introCharacterId: { type: Number, attribute: "intro-character-id" },
    introContent: { attribute: false },
    gekisouMissionTypes: { attribute: false },
    liveMode: { type: String, attribute: "live-mode" },
    gekisouEffectMode: { type: Number, attribute: "gekisou-effect-mode" },
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
  };
  declare source: string;
  declare audioUrl: string;
  /** "sus" reads a Project Sekai score through its Cassiopeia plugin. */
  declare chartFormat: string;
  /** Where the chart starts in the audio. */
  declare offsetMs: number;
  declare bandId: number;
  /** Explicit live-start Leader identity supplied by the owning page/session. */
  declare introCharacterId?: number;
  declare introContent?: TitleIntroductionContent;
  declare gekisouMissionTypes?: readonly number[];
  declare liveMode: "normal" | "gekisou";
  declare gekisouEffectMode?: OurNotesGekisouEffectMode;
  private gekisouPlan?: OurNotesGekisouPlan;
  private gekisouStage?: OurNotesGekisouStageProjector;
  private gekisouStageSource?: OurNotesGekisouEffectProfile;
  private gekisouStageResources?: PreparedResource<OurNotesGekisouEffectProfile>;
  private liveModeRevision = 0;
  private readonly gekisouStageSeed = new Uint32Array(1);
  private gekisouIntroIcons?: Readonly<Record<"combo" | "luck" | "just", string>>;
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
  private pluginRuntime?: CassiopeiaRuntime;
  private watchSessionFactory?: (chart: ChartDocument, options?: SessionOptions) => CassiopeiaSessionPort;
  private runtime() {
    return (this.pluginRuntime ??= new CassiopeiaRuntime([
      createKernelPlugin({ createSession: (chart, options) => {
        if (!this.watchSessionFactory) throw new Error("Watch runtime is not loaded");
        return this.watchSessionFactory(chart, options);
      } }),
      createOurNotesPlugin(),
      createThreeRendererPlugin(),
      createWebHostPlugin(),
    ]));
  }
  private chart?: ChartDocument;
  private assets?: OurNotesAssetManifest;
  private renderer?: OurNotesRenderer;
  private intro?: NativeIntroPlayback;
  private introScene?: NativeIntroAssembly;
  private introTitle?: TitleIntroductionPresentation;
  private introDifficultyIconUrl?: string;
  private introTextures: Texture[] = [];
  private introAudioContext?: AudioContext;
  private introCategoryGains = { cheer: 0, voice: 0 };
  private introAudioBuffers = new Map<
    "cheer" | "voice",
    { buffer: AudioBuffer; loopStart?: number; loopEnd?: number }
  >();
  private introAudioSources = new Map<
    "cheer" | "voice",
    {
      source: AudioBufferSourceNode;
      gain: GainNode;
      started: number;
      offset: number;
      fade?: { start: number; end: number };
    }
  >();
  private introAudioPaused = new Map<"cheer" | "voice", number>();
  private introCheerStarted = false;
  private introSoundFadeStart?: number;
  private introMusicStarting = false;
  private introMusicHandoffComplete = false;
  private introRoleValues = new Map<string, Map<string, number>>();
  private session?: CassiopeiaSessionPort;
  private frames?: RenderFrameBuilder;
  private readonly gekisouOverlayProjector = new OurNotesGekisouOverlayProjector();
  private readonly gekisouEntryProjector = new OurNotesGekisouEntryProjector();
  private readonly gekisouOverlayContext = {
    width: 1,
    height: 1,
    worldToClip: new Float64Array(16),
    ...OUR_NOTES_GEKISOU_VIEW_SETTINGS,
  };
  private chartPerfEnabled = false;
  private chartPerfProbe?: ChartPerfProbe;
  private chartGpuProbe?: ChartGpuTimerProbe;
  private chartGpuDiagnosticMs = 0;
  private chartPerfWindowStartMs?: number;
  private chartPerfWindowStartedAt?: number;
  private chartPerfWindowPlayingOnly = true;
  private clock?: MediaClock;
  private noteSounds?: NoteSoundPlayer;
  private noteSoundSwap?: NoteSoundSwap;
  private overviewSkin?: Awaited<ReturnType<typeof loadDetailedOverviewSkin>>;
  private resizeObserver?: ResizeObserver;
  private animationFrame = 0;
  private loadedKey = "";
  private loadAbort?: AbortController;
  private watchReplaySource?: {
    sourceKey: string;
    sourceUrl: string;
    audioUrl: string;
    originSeconds: number;
    inputOffsetMs: number;
    clock: MediaClock;
    chart: ChartDocument;
    signal: AbortSignal;
    musicStarted: boolean;
  };
  private watchReplayTicks?: {
    sourceKey: string;
    rate: number;
    originSeconds: number;
    inputOffsetMs: number;
    durationMs: number;
    tickTimesMs: readonly number[];
  };
  private availableNoteSkins: readonly OurNotesNoteSkin[] = OUR_NOTES_NOTE_SKINS;
  private availableNoteEffectSkins: readonly OurNotesNoteEffectSkin[] = ["effect001"];
  private sourceFilesCache?: { key: string; promise: Promise<Set<string>> };
  private resumeAfterScrub = false;
  private viewportFullscreen: ViewportFullscreenController;
  private transportVisibility = new PlaybackControlsController((snapshot) => {
    this.transportCollapsed = snapshot.collapsed;
    this.transportAutoHidden = snapshot.autoHidden;
  });

  constructor() {
    super();
    this.source = "";
    this.audioUrl = "";
    this.chartFormat = "";
    this.offsetMs = 0;
    this.bandId = 1;
    this.label = "Chart";
    this.server = "intl";
    this.locale = "ja";
    this.phase = "loading";
    this.playing = false;
    this.mode = "simple";
    this.liveMode = "normal";
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
    this.stopRenderQuality = observeRenderQuality((settings) => {
      applyRenderQuality(this.renderer, settings);
      this.draw();
    });
    this.chartPerfEnabled = new URLSearchParams(window.location.search).get("chartPerf") === "1";
    void Promise.all([import("@material/web/slider/slider.js"), import("@material/web/progress/circular-progress.js")]);
    void this.load();
    document.addEventListener("fullscreenchange", this.fullscreenChanged);
  }
  disconnectedCallback() {
    this.stopRenderQuality?.();
    this.persistSettings();
    this.dispose();
    this.viewportFullscreen.dispose();
    this.transportVisibility.dispose();
    document.removeEventListener("fullscreenchange", this.fullscreenChanged);
    super.disconnectedCallback();
  }
  updated(changed: Map<PropertyKey, unknown>) {
    const key = `${this.server}:${this.source}`;
    if (this.source && key !== this.loadedKey) void this.load();
    if (changed.has("liveMode") && this.phase === "ready") this.setLiveMode(this.liveMode);
    if (changed.has("gekisouEffectMode")) {
      this.renderer?.invalidateEffectFrame();
      this.draw();
    }
    this.transportVisibility.bind(this.querySelector<HTMLElement>(".playback-controls"));
    this.transportVisibility.setFullscreen(this.fullscreen);
    this.transportVisibility.setPlaying(this.playing);
    if (this.mode === "simple") requestAnimationFrame(() => this.drawOverview());
  }

  private sourceRelease(): string | undefined {
    const release = new URL(this.source, window.location.href).searchParams.get("release") ?? undefined;
    if (release && !/^r-[a-f0-9]{20}$/u.test(release)) throw new Error("Invalid chart release pin");
    return release;
  }
  private pinResourceUrl(path: string): string {
    const release = this.sourceRelease();
    if (!release || !path) return path;
    const url = new URL(path, window.location.href);
    const sourceOrigin = new URL(this.source, window.location.href).origin;
    if (url.origin !== window.location.origin && url.origin !== sourceOrigin) return path;
    // Global archives are content-addressed and already immutable.
    if (/^\/objects\/unity\/[a-f0-9]{64}\.jsonl\.gz$/u.test(url.pathname)) return path;
    const server = encodeURIComponent(this.server);
    const scoped = /^\/(?:assets|runtime|objects)\//u.test(url.pathname) || url.pathname.startsWith("/api/v1/servers/");
    if (!scoped) return path;
    if (
      !url.pathname.startsWith(`/assets/${server}/`) &&
      !url.pathname.startsWith(`/runtime/${server}/`) &&
      !url.pathname.startsWith(`/objects/${server}/`) &&
      !url.pathname.startsWith(`/api/v1/servers/${server}/`)
    ) {
      throw new Error("Chart resource server differs from source pin");
    }
    url.searchParams.set("release", release);
    return url.origin === window.location.origin ? url.pathname + url.search + url.hash : url.href;
  }
  private pinResourceValue<T>(value: T): T {
    if (typeof value === "string") return this.pinResourceUrl(value) as T;
    if (Array.isArray(value)) return value.map((item) => this.pinResourceValue(item)) as T;
    if (value && typeof value === "object")
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.pinResourceValue(item)])) as T;
    return value;
  }

  private descriptorUrl(source: string) {
    return this.pinResourceUrl(
      `/api/v1/servers/${encodeURIComponent(this.server)}/sources/${source
        .split("/")
        .map(encodeURIComponent)
        .join("/")}`,
    );
  }
  private async descriptor(source: string, signal: AbortSignal) {
    return await fetchJson<RuntimeDescriptor>(this.descriptorUrl(source), { signal });
  }
  private async sourceFiles(signal: AbortSignal) {
    const server = this.server;
    const key = `${new URL(this.source, window.location.href).origin}:${server}:${this.sourceRelease() ?? "current"}`;
    if (this.sourceFilesCache?.key === key) return this.sourceFilesCache.promise;
    const promise = (async () => {
      const tree = await fetchJson<Record<string, unknown>>(
        this.pinResourceUrl(`/api/v1/servers/${encodeURIComponent(server)}/sources/tree`),
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
    this.sourceFilesCache = { key, promise };
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
    return this.pinResourceUrl(
      `/runtime/${encodeURIComponent(this.server)}/${matches[0]!.path.replace(/^runtime\//u, "")}`,
    );
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
    const assetUrl = (path: string) =>
      this.pinResourceUrl(`${root}/${path.split("/").map(encodeURIComponent).join("/")}`);
    const sprite = (descriptor: RuntimeDescriptor, name: string) => {
      if (descriptor.outputs?.some((entry) => entry.type === "Sprite")) return this.output(descriptor, "Sprite", name);
      const atlas = descriptor.sourcePath || "";
      const match = /^(.*)\/Atlas\/([^/]+)\.spriteatlasv2$/u.exec(atlas);
      const sourcePath = match ? `${match[1]}/AtlasSources/${match[2]}/${name}` : "";
      if (!sourcePath || !files.has(sourcePath)) throw new Error(`Missing Sprite ${name}`);
      return assetUrl(sourcePath);
    };
    const difficulty = this.introContent?.difficulty?.toLowerCase();
    const difficultySprite = difficulty
      ? `Difficulty_${difficulty === "expert" ? "easy_expert" : difficulty}.png`
      : undefined;
    this.introDifficultyIconUrl = difficultySprite && live.outputs?.some(
      (entry) => entry.type === "Sprite" && logicalName(entry) === difficultySprite,
    ) ? sprite(live, difficultySprite) : undefined;
    this.gekisouIntroIcons = this.gekisouMissionTypes?.length
      ? {
          combo: sprite(live, "Icon_gekisou_combo.png"),
          luck: sprite(live, "Icon_gekisou_luck.png"),
          just: sprite(live, "Icon_gekisou_just.png"),
        }
      : undefined;
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
      this.pinResourceUrl(
        `/runtime/${encodeURIComponent(this.server)}/${path
          .replace(/^runtime\//u, "")
          .split("/")
          .map(encodeURIComponent)
          .join("/")}`,
      );
    const nativeAsset = (path: string): string => assetUrl(resolveSource(path));
    const nativeRuntime = (path: string): string => {
      const match = /^unity-json\/(.*)\/([A-Za-z0-9_]+\.json)$/u.exec(path);
      if (!match) return runtimeUrl(path);
      const oldSource = match[1]!;
      if (files.has(oldSource)) return runtimeUrl(path);
      return runtimeUrl(`unity-json/${resolveSource(oldSource)}/${match[2]}`);
    };
    // Optional native three-tier sprites are resolved from the active source pin.
    // Older releases retain their existing combined-digit HUD contract.
    const comboTiers = await (async () => {
      const [normal, fullCombo, allPerfect, fcGlow, apGlow] = await Promise.all([
        this.descriptor(source("LiveComboNAtlas.spriteatlasv2"), signal),
        this.descriptor(source("LiveComboFCAtlas.spriteatlasv2"), signal),
        this.descriptor(source("LiveComboAPAtlas.spriteatlasv2"), signal),
        this.descriptor(source("SP_combo_fc_glow.png"), signal),
        this.descriptor(source("SP_combo_ap_glow.png"), signal),
      ]);
      const projection = async (descriptor: RuntimeDescriptor, type: string) => {
        const candidates = descriptor.runtimeObjects?.filter((entry) => entry.type === type) ?? [];
        if (candidates.length !== 1 || !candidates[0]!.path.startsWith("runtime/unity-json/"))
          throw new Error(`Missing native combo ${type} geometry`);
        const path = candidates[0]!.path.replace(/^runtime\//u, "");
        return fetchJson<unknown>(this.pinResourceUrl(`/runtime/${encodeURIComponent(this.server)}/${path}`), {
          signal,
        });
      };
      const [normalGeometry, fullComboGeometry, allPerfectGeometry, fcGlowGeometry, apGlowGeometry] = await Promise.all(
        [
          projection(normal, "SpriteAtlas").then(parseHudComboAtlasGeometry),
          projection(fullCombo, "SpriteAtlas").then(parseHudComboAtlasGeometry),
          projection(allPerfect, "SpriteAtlas").then(parseHudComboAtlasGeometry),
          projection(fcGlow, "Sprite").then(parseHudSpriteGeometry),
          projection(apGlow, "Sprite").then(parseHudSpriteGeometry),
        ],
      );
      signal.throwIfAborted();
      const requiredGeometry = (geometry: ReturnType<typeof parseHudComboAtlasGeometry>, name: string) => {
        const sprite = geometry[name];
        if (!sprite) throw new Error(`Missing native combo Sprite geometry ${name}`);
        return sprite;
      };
      const tier = (
        atlas: RuntimeDescriptor,
        prefix: string,
        geometry: ReturnType<typeof parseHudComboAtlasGeometry>,
        glow?: RuntimeDescriptor,
        glowGeometry?: ReturnType<typeof parseHudSpriteGeometry>,
      ) => ({
        labelUrl: sprite(atlas, `${prefix}_title.png`),
        baseDigitUrls: Array.from({ length: 10 }, (_, digit) => sprite(atlas, `${prefix}_${digit}_base.png`)),
        fillDigitUrls: Array.from({ length: 10 }, (_, digit) => sprite(atlas, `${prefix}_${digit}_fill.png`)),
        ...(glow ? { glowUrl: this.output(glow, "Sprite") } : {}),
        geometry: {
          label: requiredGeometry(geometry, `${prefix}_title`),
          baseDigits: Array.from({ length: 10 }, (_, digit) => requiredGeometry(geometry, `${prefix}_${digit}_base`)),
          fillDigits: Array.from({ length: 10 }, (_, digit) => requiredGeometry(geometry, `${prefix}_${digit}_fill`)),
          ...(glowGeometry ? { glow: glowGeometry } : {}),
        },
      });
      return {
        normal: tier(normal, "SP_combo_n", normalGeometry),
        fullCombo: tier(fullCombo, "SP_combo_fc", fullComboGeometry, fcGlow, fcGlowGeometry),
        allPerfect: tier(allPerfect, "SP_combo_ap", allPerfectGeometry, apGlow, apGlowGeometry),
      };
    })().catch(() => undefined);
    signal.throwIfAborted();
    const media: OurNotesRuntimeMediaManifest = {
      gekisouLaneAvailable: files.has("Assets/AddressableResources/Effect/Live/LaneEffect/effect001/lane_tap_excellenet_view.prefab"),
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
        ...(comboTiers ? { comboTiers } : {}),
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
            assetUrl(
              `Assets/AddressableResources/Effect/Live/RankIcon/Texture/RankIconAtlas/scorerank_${rank.toLowerCase()}_ingame.png`,
            ),
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

  private async sekaiChart(source: string): Promise<ChartDocument> {
    const { convertSekaiSus } = await import("@haneoka/cassiopeia-plugin-sekai");
    const { chart } = convertSekaiSus(source, { bgmOffsetMs: this.offsetMs });
    const shift = <T extends { timeMs: number }>(rows: T[]) => rows.forEach((row) => (row.timeMs += this.offsetMs));
    shift(chart.notes);
    shift(chart.bpmChanges);
    shift(chart.signatureChanges);
    shift(chart.timeScaleChanges);
    chart.durationMs += this.offsetMs;
    return chart;
  }
  private async load() {
    if (!this.source) return;
    this.dispose();
    const controller = new AbortController();
    this.loadAbort = controller;
    const { signal } = controller;
    this.loadedKey = `${this.server}:${this.source}`;
    this.phase = "loading";
    await this.updateComplete;
    try {
      signal.throwIfAborted();
      const sourceUrl = new URL(this.source, window.location.href);
      if (
        /^\/api\/v1\/garupa\/bestdori\/(?:jp|en|tw|cn|kr)\/charts\/\d+\/(?:easy|normal|hard|expert|special)$/.test(
          sourceUrl.pathname,
        )
      )
        sourceUrl.searchParams.set("projection", BESTDORI_CATALOG_VERSION);
      const [response, assets] = await Promise.all([
        fetch(sourceUrl, { headers: { accept: "text/plain" }, signal }),
        this.runtimeAssets(signal),
      ]);
      if (!response.ok) throw new Error(`Chart ${response.status}`);
      const source = await response.text();
      signal.throwIfAborted();
      this.chart =
        this.chartFormat === "sus"
          ? await this.sekaiChart(source)
          : this.runtime().require(OUR_NOTES_RULES).parse(source);
      if (this.liveMode === "gekisou" && this.gekisouMissionTypes?.length && !assets.particles.laneEffects.gekisou)
        throw new Error("Original Gekisou lane source unavailable");
      this.gekisouPlan =
        this.liveMode === "gekisou" && this.chartFormat === "" && this.gekisouMissionTypes?.length
          ? new OurNotesGekisouPlan(this.chart, { enabled: true, missionTypes: this.gekisouMissionTypes })
          : undefined;
      this.assets = assets;
      await this.initialize(signal);
      signal.throwIfAborted();
      this.phase = "ready";
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
      const guidelineCount = Math.round(number(render.guidelineCount, 0, 12, DEFAULT_RENDER_SETTINGS.guidelineCount));
      this.playerSettings = {
        ...DEFAULT_RENDER_SETTINGS,
        noteSpeed: number(render.noteSpeed, 1, 12, DEFAULT_RENDER_SETTINGS.noteSpeed),
        noteSize: number(render.noteSize, 0.5, 1.5, DEFAULT_RENDER_SETTINGS.noteSize),
        longAlpha: number(render.longAlpha, 0.1, 1, DEFAULT_RENDER_SETTINGS.longAlpha),
        guideAlpha: number(render.guideAlpha, 0.1, 1, DEFAULT_RENDER_SETTINGS.guideAlpha),
        guidelineCount:
          OUR_NOTES_CHART_UI_PROFILE.guidelineCounts.find((count) => count === guidelineCount) ??
          OUR_NOTES_CHART_UI_PROFILE.guidelineCountDefault,
        guidelineOpacity: number(render.guidelineOpacity, 0, 1, DEFAULT_RENDER_SETTINGS.guidelineOpacity),
        laneOpacity: number(render.laneOpacity, 0, 1, DEFAULT_RENDER_SETTINGS.laneOpacity),
        backgroundBrightness: number(render.backgroundBrightness, 0, 1, DEFAULT_RENDER_SETTINGS.backgroundBrightness),
        mirror: typeof render.mirror === "boolean" ? render.mirror : DEFAULT_RENDER_SETTINGS.mirror,
        effects: typeof render.effects === "boolean" ? render.effects : DEFAULT_RENDER_SETTINGS.effects,
        showSimultaneousLine:
          typeof render.showSimultaneousLine === "boolean"
            ? render.showSimultaneousLine
            : DEFAULT_RENDER_SETTINGS.showSimultaneousLine,
        continuationEffectDisplay:
          typeof render.continuationEffectDisplay === "boolean" ? render.continuationEffectDisplay : true,
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
  private backgroundRevision = 0;
  private stageBackgroundUrl() {
    if (this.stageBackground === "none") return undefined;
    const band =
      this.stageBackground === "auto" ? (OUR_NOTES_STAGE_NAMES[this.bandId] ? this.bandId : 0) : this.stageBackground;
    return this.pinResourceUrl(
      `/assets/${encodeURIComponent(this.server)}/Assets/AddressableResources/Band/${band}/live_stage/lightweight_background.png`,
    );
  }
  private async applyStageBackground() {
    const revision = ++this.backgroundRevision;
    try {
      const stageUrl = this.stageBackgroundUrl();
      if (!stageUrl) {
        this.renderer?.setBackgroundCanvas(undefined);
      } else {
        const jacketUrl = this.introContent?.jacketUrl;
        const [stage, jacket, baseWhite] = await Promise.all([
          loadBackgroundPixels(stageUrl),
          jacketUrl ? loadBackgroundPixels(this.pinResourceUrl(jacketUrl)) : undefined,
          loadBackgroundPixels(
            this.pinResourceUrl(OUR_NOTES_LIGHTWEIGHT_BACKGROUND.baseWhitePath.replace("{server}", this.server)),
          ),
        ]);
        if (revision !== this.backgroundRevision) return;
        const composite = buildOurNotesLightweightBackground({ stage, jacket, baseWhite });
        this.renderer?.setBackgroundCanvas(backgroundPixelsCanvas(composite), 0);
      }
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
    this.watchReplayTicks = undefined;
    if (this.clock) this.clock.audio.playbackRate = this.playbackRate;
    this.intro?.setRate(this.playbackRate, performance.now());
    this.persistSettings();
  }
  private setVolume(value: number) {
    this.volume = clamp(Number(value) || 0, 0, 1);
    if (this.clock) this.clock.audio.volume = this.volume;
    this.updateNativeIntroVolume();
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
        .createNoteSounds(this.pinResourceValue(ourNotesNoteSoundsForRelease(this.server, target)));
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
    writeRenderQuality(DEFAULT_RENDER_QUALITY);
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
    const factory = await loadRustWatchSessionFactory();
    signal.throwIfAborted();
    this.watchSessionFactory = factory;
    const renderer = this.runtime()
      .require(THREE_RENDERER)
      .create({
        canvas,
        hudCanvas: hud,
        alpha: true,
        antialias: false,
        assets: this.assets,
        ...(this.gekisouMissionTypes?.some((mission) => mission > 0) &&
        this.chartFormat === "" && this.assets.particles.laneEffects.gekisou
          ? {
              overlayTextures: {
                ...this.gekisouOverlayProjector.textures((path) => this.profileResourceUrl(path)),
                ...this.gekisouEntryProjector.textures((path) => this.profileResourceUrl(path)),
              },
              overlayFonts: {
                "gekisou-entry-vibe": this.gekisouEntryProjector.font((path) => this.profileResourceUrl(path)),
              },
            }
          : {}),
      });
    this.renderer = renderer;
    applyRenderQuality(renderer, readRenderQuality());
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
    if (this.gekisouPlan) await this.prepareGekisouStage(signal);
    signal.throwIfAborted();
    this.clock = this.runtime().require(WEB_HOST).createClock(this.pinResourceUrl(this.audioUrl), {
      volume: this.volume,
      playbackRate: this.playbackRate,
      loop: false,
    });
    this.clock.audio.loop = this.loop;
    const clock = this.clock;
    const updateDuration = () => {
      if (this.clock !== clock || !this.chart) return;
      this.duration = Math.max(clock.durationMs, this.chart.durationMs) / 1000;
    };
    clock.audio.addEventListener("loadedmetadata", updateDuration);
    clock.audio.addEventListener("durationchange", updateDuration);
    this.noteSounds = this.runtime()
      .require(WEB_HOST)
      .createNoteSounds(this.pinResourceValue(ourNotesNoteSoundsForRelease(this.server, this.noteSeGroup)));
    void this.noteSounds.load().catch((error: unknown) => {
      if (!signal.aborted) console.warn("Unable to load chart note sounds", error);
    });
    this.attachSession();
    if (this.hasNativeIntroSource()) await this.loadNativeIntro(signal, renderer);
    signal.throwIfAborted();
    const introContext = this.introAudioContext;
    const ownsClock = () => this.clock === clock && !signal.aborted && this.introAudioContext === introContext;
    clock.audio.addEventListener("play", () => {
      if (!ownsClock()) return;
      if (this.watchReplaySource?.clock === clock) this.watchReplaySource.musicStarted = true;
      this.playing = true;
      void introContext?.resume();
      this.animateFrames();
    });
    clock.audio.addEventListener("pause", () => {
      if (!ownsClock()) return;
      this.playing = false;
      void introContext?.suspend();
    });
    clock.audio.addEventListener("ended", () => {
      if (!ownsClock()) return;
      this.playing = false;
      this.session?.finish(clock.timeMs);
      this.draw();
    });
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(root);
    this.duration = Math.max(this.clock.durationMs, this.chart.durationMs) / 1000;
    this.resize();
    this.draw();
  }
  private hasNativeIntroSource(): boolean {
    if (this.chartFormat !== "" || !this.sourceRelease()) return false;
    const path = decodeURIComponent(new URL(this.source, window.location.href).pathname);
    return (
      path.startsWith(`/assets/${this.server}/Assets/AddressableResources/Live/MusicScore/`) && path.endsWith(".bytes")
    );
  }

  private profileResourceUrl(path: string): string {
    const [kind, ...segments] = path.split("/");
    return this.pinResourceUrl(`/${kind}/${encodeURIComponent(this.server)}/${segments.map(encodeURIComponent).join("/")}`);
  }
  private async loadNativeIntro(signal: AbortSignal, renderer: OurNotesRenderer) {
    const files = await this.sourceFiles(signal);
    const band = files.has(
      `Assets/AddressableResources/Band/${this.bandId}/timeline/live_start_playable_timeline.prefab`,
    )
      ? this.bandId
      : 0;
    const prefix = `Assets/AddressableResources/Band/${band}/timeline/`;
    const names = [
      "live_start_playable_timeline.prefab",
      "live_start_timeline_asset.playable",
      "white_line_center.mat",
      "white_line.mat",
      "white_star.mat",
      "white_line_antialiasing.png",
      "ef_star_icon.png",
      "white_square.png",
      "live_game_white.png",
      "UILiveStartCanvas_hide.anim",
      "UILiveStartCanvas_show.anim",
      "live_game_view_in.anim",
      "live_game_view_init.anim",
      "camera_track.anim",
      "moving_light_root.anim",
      "live_background_view.anim",
      "live_game_lane_effect_in.anim",
      "live_game_lane_effect_init.anim",
    ];
    const paths = names
      .map((name) => `${prefix}${name}`)
      .concat([
        "Assets/AddressableResources/Scene/Live.unity",
        "Assets/AddressableResources/Live/Images/NonAtlas/LiveStartAnim/lane_mesh.fbx",
        "Assets/AddressableResources/Live/Materials/LiveStartAnim/white_line.mat",
        "Assets/AddressableResources/Live/Materials/LiveStartAnim/white_star.mat",
      ]);
    if (!files.has(paths[0]!)) return;
    const directorDescriptor = await this.descriptor(paths[0]!, signal);
    // Pinned releases before the original intro data contract retain their existing transport lifecycle.
    if (directorDescriptor.runtimeProjectionPolicy !== "live-intro-data-v4") return;
    const descriptors = [
      directorDescriptor,
      ...(await Promise.all(
        paths.slice(1).map((path) => {
          if (!files.has(path)) throw new Error(`Original intro source unavailable: ${path}`);
          return this.descriptor(path, signal);
        }),
      )),
    ];
    signal.throwIfAborted();
    const preloads = new Map<string, Set<string>>(),
      outputs = new Map<string, RuntimeOutput>();
    for (const descriptor of descriptors) {
      if (!descriptor.serializedFile) throw new Error("Intro source serialized-file identity missing");
      for (const reference of descriptor.preloadObjectReferences ?? []) {
        if (reference.serializedFile === descriptor.serializedFile) continue;
        const key = `${descriptor.serializedFile}:${reference.pathId}`;
        let candidates = preloads.get(key);
        if (!candidates) preloads.set(key, (candidates = new Set()));
        candidates.add(reference.serializedFile);
      }
      for (const output of descriptor.outputs ?? [])
        if (output.type === "Texture2D") {
          if (!output.serializedFile || typeof output.objectId !== "string")
            throw new Error("Intro texture output identity missing");
          const key = `${output.serializedFile}:${output.objectId}`,
            previous = outputs.get(key);
          if (previous && previous.path !== output.path) throw new Error("Intro texture output identity is ambiguous");
          outputs.set(key, output);
        }
    }
    const projections = descriptors.flatMap((d) => d.runtimeObjects ?? []);
    if (!projections.length) throw new Error("Original intro data projections unavailable");
    const records = await Promise.all(
      projections.map((entry) => {
        if (!entry.path.startsWith("runtime/unity-json/"))
          throw new Error("Intro record is outside original data projection");
        const url = this.pinResourceUrl(
          `/runtime/${encodeURIComponent(this.server)}/${entry.path.slice("runtime/".length).split("/").map(encodeURIComponent).join("/")}`,
        );
        return fetchJson<NativeIntroObjectRecord>(url, { signal });
      }),
    );
    const unique = new Map<string, NativeIntroObjectRecord>();
    for (const record of records) {
      const key = `${record.serializedFile}:${record.pathId}`;
      const previous = unique.get(key);
      if (previous && JSON.stringify(previous) !== JSON.stringify(record))
        throw new Error("Intro original records disagree");
      unique.set(key, record);
    }
    const directorFile = descriptors[0]!.serializedFile;
    const directors = [...unique.values()].filter(
      (r) => r.type === "PlayableDirector" && r.serializedFile === directorFile,
    );
    if (directors.length !== 1) throw new Error("Original intro director identity is ambiguous");
    const liveDescriptor = descriptors.find((d) => d.sourcePath === "Assets/AddressableResources/Scene/Live.unity");
    if (!liveDescriptor || liveDescriptor.runtimeProjectionPolicy !== "live-tap-fade-data-v1")
      throw new Error("Original tap-area fade source data unavailable");
    const laneOwners = [...unique.values()].filter(
      (record) =>
        record.serializedFile === liveDescriptor.serializedFile &&
        record.type === "MonoBehaviour" &&
        "_tapAreaFadeInDuration" in record.data,
    );
    if (laneOwners.length !== 1) throw new Error("Original tap-area fade owner is ambiguous");
    const identityIndex = new NativeIntroSourceIndex([...unique.values()], signal, preloads);
    const laneOwner = laneOwners[0]!;
    const laneObject = identityIndex.resolve(laneOwner.data.m_GameObject, laneOwner);
    const alphaOwner = identityIndex.resolve(laneOwner.data._tapAreaAlphaController, laneOwner);
    const tapRenderer = identityIndex.resolve(laneOwner.data._tapAreaSpriteRenderer, laneOwner);
    const alphaRenderers = alphaOwner.data._renderers;
    if (
      laneObject.type !== "GameObject" ||
      laneObject.data.m_Name !== "LiveGameLane" ||
      alphaOwner.type !== "MonoBehaviour" ||
      tapRenderer.type !== "SpriteRenderer" ||
      alphaOwner.data._baseAlpha !== 1 ||
      alphaOwner.data._animationAlpha !== 1 ||
      !Array.isArray(alphaRenderers) ||
      alphaRenderers.length !== 1 ||
      identityIndex.referenceKey(alphaRenderers[0], alphaOwner) !==
        `${tapRenderer.serializedFile}:${tapRenderer.pathId}`
    )
      throw new Error("Unsupported original tap-area alpha owner graph");
    const fadeDuration = laneOwner.data._tapAreaFadeInDuration,
      fadeEase = laneOwner.data._tapAreaFadeInEase;
    if (typeof fadeDuration !== "number" || typeof fadeEase !== "number")
      throw new Error("Invalid original tap-area fade parameters");
    renderer.configureNativeIntroTapFade(fadeDuration, fadeEase);
    const loader = new TextureLoader(),
      loaded = new Map<string, Promise<{ texture: Texture; width: number; height: number }>>();
    const role = (name: string): NativeIntroBindingSink => ({
      set: (_target, path, attribute, component, value, type) => {
        let state = this.introRoleValues.get(name);
        if (!state) this.introRoleValues.set(name, (state = new Map()));
        state.set(`${path}:${type}:${attribute}:${component}`, value);
        if (name === "UILiveStartCanvasTrack") {
          const paths = [
            "",
            "base",
            "UISafeArea",
            "UISafeArea/ContentArea/center_bottom",
            "UISafeArea/ContentArea/left_top",
            "UISafeArea/ContentArea/right_top",
            "UISafeArea/ContentArea/simple_music_jacket_panel",
          ];
          if (
            type !== 225 ||
            attribute !== unityStringHash("m_Alpha") ||
            component !== 0 ||
            !paths.some((name) => (name ? unityStringHash(name) : 0) === path)
          )
            throw new Error("Unsupported original intro CanvasGroup role binding");
        } else if (name === "LiveGameViewTrack") {
          if (path !== unityStringHash("LiveGameLane") || type !== 1 || attribute !== unityStringHash("m_IsActive"))
            throw new Error("Unsupported original GameView intro role binding");
          renderer.setNativeIntroLaneVisible(value >= 0.5);
        } else if (name === "LightWeightBackgroundStageTrack") {
          if (path !== 0 || type !== 4 || attribute !== 3 || component > 2)
            throw new Error("Unsupported original lightweight intro role binding");
          renderer.setNativeIntroBackgroundScale([
            state.get("0:4:3:0") ?? 1,
            state.get("0:4:3:1") ?? 1,
            state.get("0:4:3:2") ?? 1,
          ]);
        }
        // Normal Web chart uses LightWeight: the camera/background/light roles retain their
        // original evaluated state while their 3D background owner is inactive.
      },
    });
    const runtimeTracks = new Map(
      [
        "UILiveStartCanvasTrack",
        "LiveGameViewTrack",
        "LightWeightBackgroundStageTrack",
        "LiveCamerasTrack",
        "LiveBackgroundViewTrack",
        "MovingLightTrack",
      ].map((name) => [name, role(name)]),
    );
    try {
      const scene = await NativeIntroAssembly.load({
        records: [...unique.values()],
        director: directors[0]!,
        signal,
        externalPreloads: preloads,
        runtimeTracks,
        nextLifecycleSeed: () => crypto.getRandomValues(new Uint32Array(1))[0]!,
        notifyVoice: () => this.playNativeIntroSound("voice"),
        texture: (pointer, owner) => {
          const key = identityIndex.referenceKey(pointer, owner);
          let promise = loaded.get(key);
          if (!promise) {
            const output = outputs.get(key);
            if (!output) throw new Error(`Original intro texture unavailable: ${key}`);
            const url = output.path.startsWith("assets/")
              ? `/assets/${encodeURIComponent(this.server)}/${output.path.slice("assets/".length).split("/").map(encodeURIComponent).join("/")}`
              : `/runtime/${encodeURIComponent(this.server)}/${output.path.slice("runtime/".length).split("/").map(encodeURIComponent).join("/")}`;
            promise = loader.loadAsync(this.pinResourceUrl(url)).then((texture) => {
              if (signal.aborted) {
                texture.dispose();
                signal.throwIfAborted();
              }
              texture.colorSpace = NoColorSpace;
              this.introTextures.push(texture);
              const image = texture.image as { width: number; height: number };
              return { texture, width: image.width, height: image.height };
            });
            loaded.set(key, promise);
          }
          return promise;
        },
      });
      signal.throwIfAborted();
      this.introScene = scene;
      this.intro = new NativeIntroPlayback(scene.timeline.duration);
      this.intro.setRate(this.playbackRate, performance.now());
      this.configureNativeIntroTitle();
      renderer.attachNativeIntro(scene);
      await this.loadNativeIntroAudio(signal);
    } finally {
      identityIndex.dispose();
    }
  }

  private configureNativeIntroTitle() {
    this.introTitle = new TitleIntroductionPresentation({
      content: createOurNotesTitleIntroductionContent(
        {
          ...this.introContent,
          gekisou: undefined,
          title: this.introContent?.title ?? this.label,
          artist: this.introContent?.artist ?? "",
          difficultyIconUrl: this.introContent?.difficultyIconUrl ?? this.introDifficultyIconUrl,
          highScore: this.introContent?.highScore ?? 0,
          jacketUrl: this.introContent?.jacketUrl ? this.pinResourceUrl(this.introContent.jacketUrl) : undefined,
          ...(this.gekisouPlan && this.introContent?.gekisou
            ? {
                gekisou: {
                  ...this.introContent.gekisou,
                  missions: this.introContent.gekisou.missions?.map((mission) => ({
                    ...mission,
                    ...(mission.kind && this.gekisouIntroIcons
                      ? { iconUrl: this.gekisouIntroIcons[mission.kind] }
                      : {}),
                  })),
                },
              }
            : {}),
        },
        {
          isGekisouEnabled: Boolean(this.gekisouPlan),
          isLightweightMode: false,
        },
      ),
    });
  }

  private async setLiveMode(mode: "normal" | "gekisou") {
    const revision = ++this.liveModeRevision;
    const renderer = this.renderer,
      clock = this.clock,
      signal = this.loadAbort?.signal;
    if (
      !this.chart ||
      !clock ||
      !renderer ||
      !signal ||
      signal.aborted ||
      (mode === this.liveMode && (mode === "gekisou") === Boolean(this.gekisouPlan))
    )
      return;
    const configuration = this.gekisouMissionTypes;
    if (
      mode === "gekisou" &&
      (!configuration?.length || this.chartFormat !== "" || !this.assets?.particles.laneEffects.gekisou)
    )
      return;
    const plan =
      mode === "gekisou"
        ? new OurNotesGekisouPlan(this.chart, { enabled: true, missionTypes: configuration! })
        : undefined;
    if (plan) {
      try {
        await this.prepareGekisouStage(signal);
      } catch (error) {
        if (!signal.aborted && revision === this.liveModeRevision) console.error(error);
        return;
      }
    }
    if (signal.aborted || revision !== this.liveModeRevision || renderer !== this.renderer || clock !== this.clock)
      return;
    const position = clock.timeMs / 1000;
    const replaySource = this.watchReplaySource,
      replayTicks = this.watchReplayTicks;
    this.liveMode = mode;
    this.gekisouPlan = plan;
    this.configureGekisouStage();
    this.attachSession();
    this.watchReplaySource = replaySource;
    this.watchReplayTicks = replayTicks;
    this.configureNativeIntroTitle();
    if (this.intro && this.intro.phase !== "complete") this.draw();
    else this.seek(position);
  }

  private configureGekisouStage(): void {
    this.gekisouStage =
      this.gekisouPlan && this.gekisouStageSource
        ? new OurNotesGekisouStageProjector(
            this.gekisouStageSource,
            this.gekisouPlan.ranges,
            () => crypto.getRandomValues(this.gekisouStageSeed)[0]!,
          )
        : undefined;
  }

  private async prepareGekisouStage(signal: AbortSignal): Promise<void> {
    const renderer = this.renderer!;
    const resource = this.gekisouStageResources ??= new PreparedResource(async (owner) => {
      const response = await fetch(OUR_NOTES_GEKISOU_STAGE_PROFILE_URL, { signal: owner });
      if (!response.ok) throw new Error(`Gekisou Source profile ${response.status}`);
      const source = await response.json() as OurNotesGekisouEffectProfile;
      owner.throwIfAborted();
      const projector = new OurNotesGekisouStageProjector(source, [],
        () => crypto.getRandomValues(this.gekisouStageSeed)[0]!);
      await renderer.loadOverlayTextures(projector.textures((path) => this.profileResourceUrl(path)));
      owner.throwIfAborted();
      return source;
    });
    const source = await resource.load(signal);
    signal.throwIfAborted();
    if (renderer !== this.renderer) return;
    this.gekisouStageSource = source;
    this.configureGekisouStage();
  }

  private applyGekisouStage(frame: ReturnType<RenderFrameBuilder["buildReusable"]>, sampledTimeMs: number): void {
    if (!this.gekisouStage || !this.gekisouPlan) return;
    frame.overlays = [
      ...(frame.overlays ?? []),
      ...this.gekisouStage.project(
        {
          timeMs: sampledTimeMs,
          ...(this.gekisouEffectMode !== undefined ? { mode: this.gekisouEffectMode } : {}),
        },
        this.gekisouOverlayContext,
      ),
    ];
  }

  private async loadNativeIntroAudio(signal: AbortSignal) {
    type Sound = {
      playableUrl?: string;
      missing?: boolean;
      category?: number;
      loopInfo?: { isLoop?: boolean; loopStartSample?: number; loopEndSample?: number };
      sampleRate?: number;
    };
    const options = await fetchJson<{
      liveSe?: Array<{ liveSeType: number; sound?: Sound }>;
      defaults?: Array<{ optionItemType: number; valueString: string }>;
    }>(this.pinResourceUrl(`/api/v1/servers/${encodeURIComponent(this.server)}/options`), { signal });
    const cheer = options.liveSe?.filter((row) => row.liveSeType === 9);
    if (cheer && cheer.length !== 1) throw new Error("Original StartCheer sound route is ambiguous");
    const optionValue = (type: number) => {
      const values = new Set(
        options.defaults?.filter((row) => row.optionItemType === type).map((row) => row.valueString),
      );
      if (values.size !== 1)
        throw new Error(`Original intro category default is unavailable or differs by preset: ${type}`);
      return values.values().next().value!;
    };
    const categoryGain = (volume: number, mute: number) => {
      const rawMute = optionValue(mute);
      if (rawMute !== "TRUE" && rawMute !== "FALSE") throw new Error("Original intro category mute default is invalid");
      const value = Number(optionValue(volume));
      if (!Number.isFinite(value) || value < 0 || value > 100)
        throw new Error("Original intro category volume default is invalid");
      return rawMute === "TRUE" ? 0 : value / 100;
    };
    // AppConfig live buses: Se412/416, Voice413/417. Each SoundManager play has gain1.
    this.introCategoryGains = { cheer: categoryGain(412, 416), voice: categoryGain(413, 417) };
    const context = new AudioContext();
    this.introAudioContext = context;
    const load = async (kind: "cheer" | "voice", sound: Sound | undefined) => {
      if (!sound || sound.missing || !sound.playableUrl) return;
      if (sound.category !== (kind === "cheer" ? 1 : 2))
        throw new Error("Original intro sound category differs from its owner");
      const response = await fetch(this.pinResourceUrl(sound.playableUrl), { signal });
      if (!response.ok) throw new Error(`Intro ${kind} audio resource failed: ${response.status}`);
      const buffer = await context.decodeAudioData(await response.arrayBuffer());
      signal.throwIfAborted();
      const loop = sound.loopInfo;
      if (
        loop?.isLoop &&
        (!sound.sampleRate ||
          !Number.isFinite(loop.loopStartSample) ||
          !Number.isFinite(loop.loopEndSample) ||
          loop.loopStartSample! < 0 ||
          loop.loopEndSample! <= loop.loopStartSample!)
      )
        throw new Error("Original intro loop interval missing");
      this.introAudioBuffers.set(kind, {
        buffer,
        loopStart: loop?.isLoop ? loop.loopStartSample! / sound.sampleRate! : undefined,
        loopEnd: loop?.isLoop ? loop.loopEndSample! / sound.sampleRate! : undefined,
      });
    };
    await load("cheer", cheer?.[0]?.sound);
    if (this.introCharacterId !== undefined) {
      if (!Number.isSafeInteger(this.introCharacterId) || this.introCharacterId <= 0)
        throw new Error("Intro Leader identity is invalid");
      const voices = await fetchJson<{
        entries: Record<
          string,
          { masterType?: number; characterIds?: number[]; unlockCharacterRank?: number; sound?: Sound }
        >;
      }>(this.pinResourceUrl(`/api/v1/servers/${encodeURIComponent(this.server)}/voices`), { signal });
      const entries = Object.entries(voices.entries).filter(
        ([key, entry]) =>
          key.startsWith("live-start:") &&
          entry.masterType === 7 &&
          entry.characterIds?.length === 1 &&
          entry.characterIds[0] === this.introCharacterId &&
          entry.unlockCharacterRank === 0,
      );
      if (entries.length !== 1) throw new Error("Intro Leader base start-voice route is unavailable or ambiguous");
      await load("voice", entries[0]![1].sound);
    }
  }
  private playNativeIntroSound(kind: "cheer" | "voice") {
    const context = this.introAudioContext,
      data = this.introAudioBuffers.get(kind);
    if (!context || context.state !== "running" || !data) return;
    const previous = this.introAudioSources.get(kind);
    if (previous) {
      previous.source.stop();
      previous.source.disconnect();
      previous.gain.disconnect();
    }
    const source = context.createBufferSource(),
      gain = context.createGain();
    source.buffer = data.buffer;
    if (data.loopStart !== undefined && data.loopEnd !== undefined) {
      source.loop = true;
      source.loopStart = data.loopStart;
      source.loopEnd = data.loopEnd;
    }
    const offset = this.introAudioPaused.get(kind) ?? 0;
    this.introAudioPaused.delete(kind);
    gain.gain.value = this.volume * this.introCategoryGains[kind];
    source.connect(gain);
    gain.connect(context.destination);
    this.introAudioSources.set(kind, { source, gain, started: context.currentTime, offset });
    source.onended = () => {
      if (this.introAudioSources.get(kind)?.source === source) this.introAudioSources.delete(kind);
      source.disconnect();
      gain.disconnect();
    };
    source.start(0, offset);
  }
  private pauseNativeIntroAudio() {
    const context = this.introAudioContext;
    if (!context) return;
    for (const [kind, entry] of this.introAudioSources) {
      const data = this.introAudioBuffers.get(kind)!;
      let offset = entry.offset + context.currentTime - entry.started;
      if (data.loopEnd !== undefined && data.loopStart !== undefined && offset >= data.loopEnd)
        offset = data.loopStart + ((offset - data.loopStart) % (data.loopEnd - data.loopStart));
      this.introAudioPaused.set(kind, offset);
      entry.source.stop();
      entry.source.disconnect();
      entry.gain.disconnect();
    }
    this.introAudioSources.clear();
  }
  private stopNativeIntroAudio() {
    for (const { source, gain } of this.introAudioSources.values()) {
      source.stop();
      source.disconnect();
      gain.disconnect();
    }
    this.introAudioSources.clear();
    this.introAudioPaused.clear();
  }
  private updateNativeIntroVolume() {
    const context = this.introAudioContext;
    if (!context) return;
    for (const [kind, entry] of this.introAudioSources) {
      const base = this.volume * this.introCategoryGains[kind],
        now = context.currentTime;
      entry.gain.gain.cancelScheduledValues(now);
      if (entry.fade) {
        const remaining = clamp((entry.fade.end - now) / (entry.fade.end - entry.fade.start), 0, 1);
        entry.gain.gain.setValueAtTime(base * remaining, now);
        if (remaining > 0) entry.gain.gain.linearRampToValueAtTime(0, entry.fade.end);
      } else entry.gain.gain.setValueAtTime(base, now);
    }
  }
  private fadeNativeIntroCheer() {
    const context = this.introAudioContext,
      entry = this.introAudioSources.get("cheer");
    if (!context || !entry) return;
    entry.fade = { start: context.currentTime, end: context.currentTime + 1 };
    this.updateNativeIntroVolume();
    entry.source.stop(entry.fade.end);
  }

  private attachSession() {
    if (!this.chart) return;
    const options = createOurNotesSessionOptions({
      mode: "watch", judgementOffsetMs: 0,
      automaticPolicy: createOurNotesAutomaticPolicy(this.gekisouPlan),
    });
    const next = this.runtime().require(CASSIOPEIA_SESSION).create(this.chart, options);
    this.session?.dispose?.();
    this.session = next;
    this.frames = this.runtime()
      .require(OUR_NOTES_RULES)
      .createFrameBuilder(this.chart, this.gekisouPlan ? { gekisou: this.gekisouPlan } : undefined);
    this.frames.configureGekisouPresentation(
      this.gekisouPlan
        ? { projector: this.gekisouOverlayProjector, context: this.gekisouOverlayContext }
        : undefined,
    );
    const session = this.session,
      frames = this.frames,
      clock = this.clock,
      signal = this.loadAbort?.signal;
    this.watchReplaySource = undefined;
    this.watchReplayTicks = undefined;
    // The current native score host has no input-offset or post-music lead adapter.
    // Admit its explicit zero-offset source; converted/custom transports retain their own reset lifecycle.
    if (
      clock &&
      signal &&
      !signal.aborted &&
      this.hasNativeIntroSource() &&
      this.offsetMs === 0 &&
      clock.audio.currentTime === 0
    ) {
      const sourceUrl = new URL(this.source, window.location.href).href;
      const audioUrl = new URL(clock.source, window.location.href).href;
      const sourceKey = JSON.stringify({
        epoch: crypto.randomUUID(),
        server: this.server,
        sourceUrl,
        audioUrl,
        release: this.sourceRelease(),
        chartFormat: this.chartFormat,
        offsetMs: this.offsetMs,
      });
      this.watchReplaySource = {
        sourceKey,
        sourceUrl,
        audioUrl,
        clock,
        chart: this.chart,
        signal,
        originSeconds: clock.audio.currentTime,
        inputOffsetMs: options.judgementOffsetMs ?? 0,
        musicStarted: false,
      };
    }
    session.on("judgement", (event) => {
      if (
        this.session !== session ||
        this.frames !== frames ||
        this.clock !== clock ||
        this.loadAbort?.signal !== signal ||
        signal?.aborted
      )
        return;
      frames.addJudgement(event, clock?.timeMs || 0, session.snapshot().feverSection?.index);
      this.noteSounds?.queue(event);
    });
  }
  private resize() {
    const root = this.querySelector<HTMLElement>(".chart-runtime__stage");
    if (!root || !this.renderer) return;
    const ratio = renderPixelRatio(root.clientWidth, root.clientHeight);
    root.style.setProperty("--chart-hud-scale", String(Math.min(root.clientWidth / 1920, root.clientHeight / 1080)));
    this.renderer.resize(root.clientWidth, root.clientHeight, ratio);
    this.gekisouOverlayContext.width = Math.max(1, root.clientWidth);
    this.gekisouOverlayContext.height = Math.max(1, root.clientHeight);
    this.draw();
    this.drawOverview();
  }
  private drawOverview() {
    const host = this.querySelector<HTMLElement>(".chart-simple-overview");
    const canvas = this.querySelector<HTMLCanvasElement>(".chart-simple-overview canvas");
    if (!host || !canvas || !this.chart || !this.overviewSkin) return;
    drawDetailedChartOverview(canvas, this.chart, this.overviewSkin, host.clientHeight || 720);
  }
  /** Renders the simple overview and downloads it as a framed PNG. */
  async downloadOverview(meta: Omit<ChartOverviewExportMeta, "locale">) {
    const canvas = this.querySelector<HTMLCanvasElement>(".chart-simple-overview canvas");
    const chart = this.chart;
    if (!canvas || this.phase !== "ready" || !chart) return;
    this.drawOverview();
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
    this.renderer.copyStageWorldToClip(this.gekisouOverlayContext.worldToClip);
    const introTime = this.intro?.sample(performance.now());
    if (this.intro && introTime !== undefined) {
      this.renderer.sampleNativeIntro(introTime);
      if (!this.introCheerStarted && this.intro.phase === "playing" && introTime >= 1) {
        this.introCheerStarted = true;
        this.playNativeIntroSound("cheer");
      }
      if (
        this.intro.phase === "complete" &&
        this.playing &&
        this.clock?.audio.paused &&
        !this.introMusicHandoffComplete &&
        !this.introMusicStarting
      ) {
        if (this.introSoundFadeStart === undefined) {
          this.introSoundFadeStart = performance.now();
          this.fadeNativeIntroCheer();
        }
        const clock = this.clock;
        this.introMusicHandoffComplete = true;
        this.introMusicStarting = true;
        void clock
          .play()
          .catch((error) => {
            if (this.clock === clock) {
              this.playing = false;
              console.warn("Unable to start chart music", error);
            }
          })
          .finally(() => {
            if (this.clock === clock) this.introMusicStarting = false;
          });
      }
    }
    const time = this.intro && this.intro.phase !== "complete" ? 0 : this.clock?.timeMs || this.currentTime * 1000;
    const probe = this.chartPerfEnabled ? (this.chartPerfProbe ??= new ChartPerfProbe()) : undefined;
    const started = probe ? performance.now() : 0;
    if (probe) {
      this.chartPerfWindowStartMs ??= time;
      this.chartPerfWindowStartedAt ??= started;
      this.chartPerfWindowPlayingOnly &&= this.playing;
    }
    const snapshot = this.session.updateReusable(time);
    const sessionFinished = probe ? performance.now() : 0;
    const effectVolume = this.volume * 0.875;
    this.noteSounds?.flush(effectVolume);
    this.noteSounds?.setLongLineActive(this.playing && snapshot.activeLongLine, effectVolume);
    if (probe) {
      const buildStarted = performance.now();
      const frame = this.frames.buildReusable(time, snapshot, this.playerSettings);
      const buildFinished = performance.now();
      const context = this.renderer.renderer.getContext();
      const gpu = "beginQuery" in context ? (this.chartGpuProbe ??= new ChartGpuTimerProbe(context)) : undefined;
      const ticket = gpu?.beginFrame(time, this.playing);
      const renderStarted = performance.now();
      let renderedAt: number;
      try {
        this.applyNativeIntroTitle(frame, introTime);
        this.applyGekisouStage(frame, snapshot.watchVisualState?.sampledTimeMs ?? time);
        this.renderer.render(frame);
        renderedAt = performance.now();
      } finally {
        gpu?.endFrame(ticket);
      }
      const queryEndedAt = performance.now();
      const stats = this.renderer.stats;
      gpu?.tagFrame(ticket, stats);
      this.chartGpuDiagnosticMs += renderStarted - buildFinished + queryEndedAt - renderedAt;
      probe.record(
        sessionFinished - started,
        buildFinished - buildStarted,
        renderedAt - renderStarted,
        renderedAt - started,
        stats,
      );
      const summary = probe.takeSummary(renderedAt);
      if (summary) {
        const gpuSummaryStartedAt = performance.now();
        const gpuSummary = gpu?.takeSummary() ?? {
          supported: false,
          sampleCount: 0,
          reason: "webgl2-unavailable",
        };
        this.chartGpuDiagnosticMs += performance.now() - gpuSummaryStartedAt;
        const detail = {
          ...summary,
          renderSubmitMs: summary.renderMs,
          gpu: gpuSummary,
          gpuQueryOverheadWindowMs: this.chartGpuDiagnosticMs,
          chartTimeMs: time,
          chartWindowMs: {
            start: this.chartPerfWindowStartMs ?? time,
            end: time,
          },
          sampleWindowMs: renderedAt - (this.chartPerfWindowStartedAt ?? started),
          playingOnly: this.chartPerfWindowPlayingOnly,
          server: this.server,
          source: this.source,
          quality: this.liveQuality,
          noteEffectSkin: this.noteEffectSkin,
          effects: this.playerSettings.effects,
        };
        this.dispatchEvent(
          new CustomEvent("chart-perf", {
            detail,
            bubbles: true,
            composed: true,
          }),
        );
        console.debug("[chart-perf]", detail);
        this.chartGpuDiagnosticMs = 0;
        this.chartPerfWindowStartMs = undefined;
        this.chartPerfWindowStartedAt = undefined;
        this.chartPerfWindowPlayingOnly = true;
      }
    } else {
      const frame = this.frames.buildReusable(time, snapshot, this.playerSettings);
      this.applyNativeIntroTitle(frame, introTime);
      this.applyGekisouStage(frame, snapshot.watchVisualState?.sampledTimeMs ?? time);
      this.renderer.render(frame);
    }
    this.currentTime = time / 1000;
  }
  private applyNativeIntroTitle(frame: ReturnType<RenderFrameBuilder["buildReusable"]>, seconds?: number) {
    frame.overlayTexts = undefined;
    if (this.intro?.phase === "complete") {
      if (frame.hud) frame.hud.titleIntroduction = undefined;
      return;
    }
    if (!this.introTitle || seconds === undefined) return;
    const title = this.introTitle.atElapsed(seconds * 1000);
    frame.hud ??= {};
    const values = this.introRoleValues.get("UILiveStartCanvasTrack");
    const alpha = (path: string) =>
      clamp(values?.get(`${path ? unityStringHash(path) : 0}:225:${unityStringHash("m_Alpha")}:0`) ?? 1, 0, 1);
    const rootAlpha = alpha(""),
      safeAlpha = rootAlpha * alpha("UISafeArea");
    const centerAlpha = safeAlpha * alpha("UISafeArea/ContentArea/center_bottom");
    frame.hud.titleIntroduction = {
      ...title.content,
      alpha: rootAlpha,
      rootAlpha,
      centerAlpha,
      simpleAlpha: safeAlpha * alpha("UISafeArea/ContentArea/simple_music_jacket_panel"),
      leftAlpha: safeAlpha * alpha("UISafeArea/ContentArea/left_top"),
      rightAlpha: safeAlpha * alpha("UISafeArea/ContentArea/right_top"),
      contentAlpha: centerAlpha,
    };
    if (this.gekisouPlan && values) {
      const entry = this.gekisouEntryProjector.project({
        enabled: true,
        missionTypes: this.gekisouMissionTypes ?? [],
        locale: this.locale as OurNotesGekisouEntryInput["locale"],
        bindings: values,
      }, this.gekisouOverlayContext);
      frame.overlays = [...(frame.overlays ?? []), ...entry.sprites];
      frame.overlayTexts = entry.texts;
      frame.hud.titleIntroduction.gekisou = undefined;
    }
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
    if (!this.clock) return;
    if (this.intro && this.intro.phase !== "complete") {
      const intro = this.intro,
        clock = this.clock;
      if (this.playing) {
        this.intro.pause(performance.now());
        this.playing = false;
        this.pauseNativeIntroAudio();
        this.draw();
      } else {
        await Promise.all([this.noteSounds?.unlock(), this.introAudioContext?.resume()]);
        if (this.intro !== intro || this.clock !== clock || this.loadAbort?.signal.aborted) return;
        this.intro.start(performance.now());
        this.playing = true;
        for (const kind of this.introAudioPaused.keys()) this.playNativeIntroSound(kind);
        this.animateFrames();
      }
      return;
    }
    if (this.playing) {
      this.playing = false;
      this.clock.pause();
      this.draw();
    } else {
      if (this.duration && this.currentTime >= this.duration - 0.05) this.seek(0);
      await this.playSourceClock();
    }
  }
  private async playSourceClock(): Promise<boolean> {
    const clock = this.clock,
      signal = this.loadAbort?.signal,
      sounds = this.noteSounds;
    if (!clock || !signal || signal.aborted) return false;
    try {
      await Promise.all([sounds?.unlock(), clock.play()]);
    } catch (error) {
      const cancelled = signal.aborted || this.clock !== clock || this.loadAbort?.signal !== signal;
      if (cancelled && error instanceof DOMException && error.name === "AbortError") return false;
      throw error;
    }
    return this.clock === clock && this.loadAbort?.signal === signal && !signal.aborted;
  }
  private watchReplayContract(targetMs: number, previousMs: number): WatchVisualReplayContract | undefined {
    const source = this.watchReplaySource;
    if (
      !source ||
      source.signal.aborted ||
      this.loadAbort?.signal !== source.signal ||
      this.clock !== source.clock ||
      this.chart !== source.chart ||
      this.offsetMs !== 0 ||
      !this.hasNativeIntroSource() ||
      new URL(this.source, window.location.href).href !== source.sourceUrl ||
      new URL(source.clock.source, window.location.href).href !== source.audioUrl
    ) {
      this.watchReplayTicks = undefined;
      return undefined;
    }
    const rate = source.clock.audio.playbackRate,
      mediaEndMs = source.clock.durationMs;
    const durationMs = Math.max(mediaEndMs, source.chart.durationMs, targetMs);
    if (
      !Number.isFinite(mediaEndMs) ||
      mediaEndMs <= 0 ||
      !Number.isFinite(source.chart.durationMs) ||
      !Number.isFinite(targetMs) ||
      !Number.isFinite(durationMs) ||
      !Number.isSafeInteger(Math.trunc(durationMs))
    ) {
      this.watchReplayTicks = undefined;
      return undefined;
    }
    if (!Number.isFinite(rate) || rate <= 0) throw new TypeError("Watch replay clock rate must be finite and positive");
    const stepSeconds = (1 / 60) * rate;
    let cache = this.watchReplayTicks;
    if (
      !cache ||
      cache.sourceKey !== source.sourceKey ||
      cache.rate !== rate ||
      cache.originSeconds !== source.originSeconds ||
      cache.inputOffsetMs !== source.inputOffsetMs ||
      cache.durationMs !== durationMs
    ) {
      const ticks: number[] = [];
      let seconds = source.originSeconds;
      for (;;) {
        const next = seconds + stepSeconds;
        if (!Number.isFinite(next) || next <= seconds) throw new TypeError("Watch replay clock cannot advance");
        const tick = Math.trunc(next * 1000);
        if (tick > durationMs) break;
        if (!Number.isSafeInteger(tick)) throw new TypeError("Watch replay clock tick exceeds integer time");
        ticks.push(tick);
        seconds = next;
      }
      cache = {
        sourceKey: source.sourceKey,
        rate,
        originSeconds: source.originSeconds,
        inputOffsetMs: source.inputOffsetMs,
        durationMs,
        tickTimesMs: Object.freeze(ticks),
      };
      this.watchReplayTicks = cache;
    }
    if (
      source.signal.aborted ||
      this.clock !== source.clock ||
      this.loadAbort?.signal !== source.signal ||
      source.clock.audio.playbackRate !== rate
    )
      return undefined;
    const fresh =
      targetMs < Math.floor(mediaEndMs) && (targetMs < previousMs || (!source.musicStarted && previousMs <= 0));
    return {
      sourceKey: source.sourceKey,
      clockMode: fresh ? "fresh-reference" : "canonical-rebuild",
      originSeconds: source.originSeconds,
      stepSeconds,
      inputOffsetMs: source.inputOffsetMs,
      tickTimesMs: cache.tickTimesMs,
    };
  }
  private seek(seconds: number) {
    if (!this.clock || !this.session || !this.frames) return;
    const clock = this.clock,
      session = this.session,
      frames = this.frames,
      signal = this.loadAbort?.signal;
    if (this.intro) this.introMusicHandoffComplete = true;
    this.intro?.bypass();
    this.renderer?.sampleNativeIntro(this.intro?.durationSeconds ?? 0, true);
    this.stopNativeIntroAudio();
    const previous = session.snapshot();
    const previousMs = previous.watchVisualState?.sampledTimeMs ?? previous.timeMs;
    clock.seek(seconds * 1000);
    const targetMs = clock.timeMs,
      replay = this.watchReplayContract(targetMs, previousMs);
    if (
      this.clock !== clock ||
      this.session !== session ||
      this.frames !== frames ||
      this.loadAbort?.signal !== signal ||
      signal?.aborted
    )
      return;
    this.renderer?.invalidateEffectFrame();
    session.reset(targetMs, replay);
    frames.resetWatch(targetMs, replay, session.getWatchHistory?.());
    this.currentTime = targetMs / 1000;
    this.draw();
  }
  private previewSeek(seconds: number) {
    this.transportVisibility.setScrubbing(true);
    if (this.playing) {
      this.resumeAfterScrub = true;
      if (this.intro && this.intro.phase !== "complete") {
        this.intro.pause(performance.now());
        this.playing = false;
      }
      this.clock?.pause();
    }
    this.seek(seconds);
  }
  private async commitSeek(seconds: number) {
    const clock = this.clock,
      signal = this.loadAbort?.signal;
    try {
      this.seek(seconds);
      if (!this.resumeAfterScrub) return;
      this.resumeAfterScrub = false;
      await this.playSourceClock();
    } finally {
      if (this.clock === clock && this.loadAbort?.signal === signal && !signal?.aborted)
        this.transportVisibility.setScrubbing(false);
    }
  }
  private fullscreenChanged = () => {
    this.fullscreen = this.viewportFullscreen.isActive() || document.fullscreenElement === this;
  };
  private toggleLoop() {
    this.loop = !this.loop;
    if (this.clock) this.clock.audio.loop = this.loop;
  }
  private collapseTransport = () => {
    this.transportVisibility.collapse();
    void this.updateComplete.then(() => this.querySelector<HTMLElement>(".chart-runtime__stage")?.focus());
  };
  private pauseFromStage = () => {
    if (this.playing) void this.toggle();
    this.transportVisibility.expand();
  };
  private stageKeydown = (event: KeyboardEvent) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    event.stopPropagation();
    if (event.repeat) return;
    if (event.key === "Enter" || this.playing) this.pauseFromStage();
    else void this.toggle();
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
    ++this.liveModeRevision;
    this.gekisouStage = undefined;
    this.gekisouStageSource = undefined;
    this.gekisouStageResources?.dispose();
    this.gekisouStageResources = undefined;
    // Queries are owned by this renderer's context and must close before it.
    this.chartGpuProbe?.dispose();
    this.chartGpuProbe = undefined;
    this.chartGpuDiagnosticMs = 0;
    this.loadAbort?.abort();
    this.loadAbort = undefined;
    this.watchReplaySource = undefined;
    this.watchReplayTicks = undefined;
    this.noteSoundSwap?.controller.abort();
    this.noteSoundSwap?.player?.dispose();
    this.noteSoundSwap = undefined;
    this.noteSoundSwapTarget = undefined;
    this.noteSoundStatus = "idle";
    this.sourceFilesCache = undefined;
    this.session?.dispose?.();
    this.session = undefined;
    this.watchSessionFactory = undefined;
    this.pluginRuntime?.dispose();
    this.pluginRuntime = undefined;
    cancelAnimationFrame(this.animationFrame);
    this.playing = false;
    this.transportVisibility.setPlaying(false);
    this.transportVisibility.setScrubbing(false);
    this.resumeAfterScrub = false;
    this.resizeObserver?.disconnect();
    this.clock?.destroy();
    this.noteSounds?.dispose();
    this.overviewSkin?.dispose();
    this.introScene?.dispose();
    this.introScene = undefined;
    this.intro = undefined;
    this.introTitle = undefined;
    for (const texture of this.introTextures) texture.dispose();
    this.introTextures.length = 0;
    this.stopNativeIntroAudio();
    void this.introAudioContext?.close();
    this.introAudioContext = undefined;
    this.introAudioBuffers.clear();
    this.introCategoryGains = { cheer: 0, voice: 0 };
    this.introMusicStarting = false;
    this.introMusicHandoffComplete = false;
    this.introCheerStarted = false;
    this.introSoundFadeStart = undefined;
    this.introRoleValues.clear();
    this.renderer?.dispose();
    this.renderer = undefined;
    this.chartPerfProbe = undefined;
    this.chartPerfWindowStartMs = undefined;
    this.chartPerfWindowStartedAt = undefined;
    this.chartPerfWindowPlayingOnly = true;
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
  private renderToggle(
    key: "mirror" | "effects" | "showSimultaneousLine" | "showJudgementLine" | "continuationEffectDisplay",
    label: string,
  ) {
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
          <render-quality-settings .locale=${this.locale}></render-quality-settings>
          <section>
            <h4>${this.ui("playback")}</h4>
            ${
              this.chartFormat === "" && this.assets?.particles.laneEffects.gekisou && this.gekisouMissionTypes?.some((mission) => mission > 0)
                ? html`
                    <label class="chart-runtime__setting chart-runtime__setting--select">
                      <span>${this.ui("liveMode")}</span>
                      <select
                        @change=${async (event: Event) => {
                          const select = event.currentTarget as HTMLSelectElement;
                          await this.setLiveMode(select.value as "normal" | "gekisou");
                          if (select.isConnected) select.value = this.liveMode;
                        }}
                      >
                        <option value="normal" ?selected=${this.liveMode === "normal"}>${this.ui("normalLive")}</option>
                        <option value="gekisou" ?selected=${this.liveMode === "gekisou"}>
                          ${this.ui("gekisouLive")}
                        </option>
                      </select>
                    </label>
                  `
                : nothing
            }
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
          <section>
            <h4>${this.ui("notes")}</h4>
            <label class="chart-runtime__setting chart-runtime__setting--select">
              <span>${this.ui("noteSkin")}</span>
              <select
                @change=${(event: Event) => {
                  const position = this.currentTime;
                  const resume = this.playing;
                  this.noteSkin = (event.currentTarget as HTMLSelectElement).value as OurNotesNoteSkin;
                  this.persistSettings();
                  void this.load().then(async () => {
                    if (this.phase !== "ready") return;
                    this.seek(position);
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
                  const position = this.currentTime;
                  const resume = this.playing;
                  this.noteEffectSkin = (event.currentTarget as HTMLSelectElement).value as OurNotesNoteEffectSkin;
                  this.persistSettings();
                  void this.load().then(async () => {
                    if (this.phase !== "ready") return;
                    this.seek(position);
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
                  const position = this.currentTime;
                  const resume = this.playing;
                  this.liveQuality = Number((event.currentTarget as HTMLSelectElement).value) as OurNotesLiveQuality;
                  this.persistSettings();
                  void this.load().then(async () => {
                    if (this.phase !== "ready") return;
                    this.seek(position);
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
            ${this.renderToggle("continuationEffectDisplay", this.ui("continuationEffects"))}
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
                ${OUR_NOTES_CHART_UI_PROFILE.guidelineCounts.map(
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
        <div class="chart-simple-overview" ?hidden=${this.phase !== "ready" || this.mode !== "simple"}>
          <canvas aria-label=${this.label}></canvas>
        </div>
        <div
          class="chart-runtime__stage"
          ?hidden=${this.phase !== "ready" || this.mode !== "watch"}
          role="region"
          aria-label=${this.label}
          tabindex="0"
          @keydown=${this.stageKeydown}
        >
          <canvas class="chart-runtime__canvas"></canvas>
          <canvas class="chart-runtime__hud"></canvas>
          <button
            class="chart-runtime__pause-hit"
            type="button"
            aria-label=${this.ui("pause")}
            @keydown=${(event: KeyboardEvent) => event.stopPropagation()}
            @click=${this.pauseFromStage}
          ></button>
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
                        aria-label=${uiText(this.locale, this.fullscreen ? "common.actions.fullscreenExit" : "common.actions.fullscreen")}
                        title=${uiText(this.locale, this.fullscreen ? "common.actions.fullscreenExit" : "common.actions.fullscreen")}
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
                ${this.renderSettingsPanel()}
              `
            : nothing
        }
      </section>
    `;
  }
}
customElements.define("chart-simulator", ChartSimulator);
