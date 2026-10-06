import { LitElement, html, nothing } from "lit";
import { fetchJson, uiText } from "../shared/catalog";
import { loadingState } from "../ui/state";
import { icon } from "../ui/icon";
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

const SETTINGS_KEY = "haneoka:chart-player:v1";

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
  };
  declare source: string;
  declare audioUrl: string;
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
  private viewportFullscreen: ViewportFullscreenController;
  private transportVisibility = new PlaybackControlsController((snapshot) => {
    this.transportCollapsed = snapshot.collapsed;
    this.transportAutoHidden = snapshot.autoHidden;
  });

  constructor() {
    super();
    this.source = "";
    this.audioUrl = "";
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
    void Promise.all([import("@material/web/slider/slider.js"), import("@material/web/progress/circular-progress.js")]);
    void this.load();
    document.addEventListener("fullscreenchange", this.fullscreenChanged);
  }
  disconnectedCallback() {
    this.persistSettings();
    this.dispose();
    this.viewportFullscreen.dispose();
    this.transportVisibility.dispose();
    document.removeEventListener("fullscreenchange", this.fullscreenChanged);
    super.disconnectedCallback();
  }
  updated() {
    const key = `${this.server}:${this.source}`;
    if (this.source && key !== this.loadedKey) void this.load();
    this.transportVisibility.bind(this.querySelector<HTMLElement>(".playback-controls"));
    this.transportVisibility.setFullscreen(this.fullscreen);
    this.transportVisibility.setPlaying(this.playing);
    if (this.mode === "simple") requestAnimationFrame(() => this.drawOverview());
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
    this.dispose();
    const controller = new AbortController();
    this.loadAbort = controller;
    const { signal } = controller;
    this.loadedKey = `${this.server}:${this.source}`;
    this.phase = "loading";
    await this.updateComplete;
    try {
      signal.throwIfAborted();
      const [response, assets] = await Promise.all([
        fetch(this.source, { headers: { accept: "text/plain" }, signal }),
        this.runtimeAssets(signal),
      ]);
      if (!response.ok) throw new Error(`Chart ${response.status}`);
      const source = await response.text();
      signal.throwIfAborted();
      this.chart = this.runtime().require(OUR_NOTES_RULES).parse(source);
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
      .createNoteSounds(ourNotesNoteSoundsForRelease(this.server, this.noteSeGroup));
    void this.noteSounds.load().catch((error: unknown) => {
      if (!signal.aborted) console.warn("Unable to load chart note sounds", error);
    });
    this.attachSession();
    this.clock.audio.addEventListener("play", () => {
      this.playing = true;
      this.animateFrames();
    });
    this.clock.audio.addEventListener("pause", () => (this.playing = false));
    this.clock.audio.addEventListener("ended", () => (this.playing = false));
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(root);
    this.duration = Math.max(this.clock.durationMs, this.chart.durationMs) / 1000;
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
    const time = this.clock?.timeMs || this.currentTime * 1000;
    const snapshot = this.session.updateReusable(time);
    const effectVolume = this.volume * 0.875;
    this.noteSounds?.flush(effectVolume);
    this.noteSounds?.setLongLineActive(this.playing && snapshot.activeLongLine, effectVolume);
    this.renderer.render(this.frames.buildReusable(time, snapshot, this.playerSettings));
    this.currentTime = time / 1000;
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
    if (this.playing) this.clock.pause();
    else {
      if (this.duration && this.currentTime >= this.duration - 0.05) this.seek(0);
      await Promise.all([this.noteSounds?.unlock(), this.clock.play()]);
    }
  }
  private seek(seconds: number) {
    if (!this.clock || !this.session || !this.frames) return;
    this.clock.seek(seconds * 1000);
    this.frames.reset();
    this.session.reset(this.clock.timeMs);
    this.currentTime = seconds;
    this.draw();
  }
  private previewSeek(seconds: number) {
    this.transportVisibility.setScrubbing(true);
    if (this.playing) {
      this.resumeAfterScrub = true;
      this.clock?.pause();
    }
    this.seek(seconds);
  }
  private async commitSeek(seconds: number) {
    try {
      this.seek(seconds);
      if (!this.resumeAfterScrub) return;
      this.resumeAfterScrub = false;
      await Promise.all([this.noteSounds?.unlock(), this.clock?.play()]);
    } finally {
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
    if (key === "collapse" || key === "expand") return uiText(this.locale, key);
    return uiText(this.locale, `chartPlayer.${key}`);
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
        <div class="chart-simple-overview" ?hidden=${this.phase !== "ready" || this.mode !== "simple"}>
          <canvas aria-label=${this.label}></canvas>
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
                  aria-label=${uiText(this.locale, "morePlaybackControls")}
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
                        aria-label=${uiText(this.locale, "seek")}
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
                        aria-label=${uiText(this.locale, this.fullscreen ? "fullscreenExit" : "fullscreen")}
                        title=${uiText(this.locale, this.fullscreen ? "fullscreenExit" : "fullscreen")}
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
