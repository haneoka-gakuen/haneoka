import { LitElement, html, nothing } from "lit";
import { uiText } from "../shared/catalog";
import { loadingState } from "../ui/state";
import { type ChartDocument } from "@haneoka/cassiopeia";
import {
  CassiopeiaRuntime,
  CASSIOPEIA_SESSION,
  createKernelPlugin,
  type CassiopeiaSessionPort,
} from "@haneoka/cassiopeia/plugin";
import {
  OUR_NOTES_RULES,
  OUR_NOTES_NOTE_SKINS,
  OUR_NOTES_NOTE_SKIN_NAMES,
  DEFAULT_RENDER_SETTINGS,
  createOurNotesPlugin,
  type RenderFrameBuilder,
  type RenderSettings,
  type OurNotesAssetManifest,
  type OurNotesRuntimeMediaManifest,
  type OurNotesNoteSkin,
} from "@haneoka/cassiopeia-plugin-our-notes";
import { THREE_RENDERER, createThreeRendererPlugin, type OurNotesRenderer } from "@haneoka/cassiopeia-renderer-three";
import {
  WEB_HOST,
  createWebHostPlugin,
  type MediaClock,
  type NoteSoundPlayer,
  type OurNotesInput,
} from "@haneoka/cassiopeia-host-web";
import { drawDetailedChartOverview, loadDetailedOverviewSkin } from "./chart-overview-renderer";

type RuntimeOutput = { objectId: string | number; path: string; type: string };
type RuntimeDescriptor = {
  sourcePath?: string;
  outputs?: RuntimeOutput[];
  runtimeObjects?: Array<{ pathId: string | number; path: string; type: string }>;
};
type StageBackground = "auto" | "none" | "1" | "2";
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
  | "guidelineCount";

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
    stageBackground: { state: true },
    playbackRate: { state: true },
    volume: { state: true },
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
  declare stageBackground: StageBackground;
  declare playbackRate: number;
  declare volume: number;
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
  private input?: OurNotesInput;
  private overviewSkin?: Awaited<ReturnType<typeof loadDetailedOverviewSkin>>;
  private resizeObserver?: ResizeObserver;
  private animationFrame = 0;
  private loadedKey = "";
  private availableNoteSkins: readonly OurNotesNoteSkin[] = ["skin001"];
  private resumeAfterScrub = false;

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
    this.stageBackground = "auto";
    this.playbackRate = 1;
    this.volume = 0.8;
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
    document.removeEventListener("fullscreenchange", this.fullscreenChanged);
    super.disconnectedCallback();
  }
  updated() {
    const key = `${this.server}:${this.source}`;
    if (this.source && key !== this.loadedKey) void this.load();
    if (this.mode === "simple") requestAnimationFrame(() => this.drawOverview());
  }

  private descriptorUrl(source: string) {
    return `/api/v1/servers/${encodeURIComponent(this.server)}/sources/${source
      .split("/")
      .map(encodeURIComponent)
      .join("/")}`;
  }
  private async descriptor(source: string) {
    const response = await fetch(this.descriptorUrl(source));
    if (!response.ok) throw new Error(`Runtime source ${response.status}`);
    return (await response.json()) as RuntimeDescriptor;
  }
  private async sourceFiles() {
    const response = await fetch(`/api/v1/servers/${encodeURIComponent(this.server)}/sources/tree`);
    if (!response.ok) throw new Error(`Runtime source tree ${response.status}`);
    const tree = (await response.json()) as Record<string, unknown>;
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
  private async runtimeAssets() {
    const files = await this.sourceFiles();
    const source = (name: string) => this.sourceWithName(files, name);
    const fontSource = [...files].filter((path) => path.endsWith("/VibeMOPro-Medium SDF.asset"));
    this.availableNoteSkins = OUR_NOTES_NOTE_SKINS.filter((skin) =>
      files.has(`Assets/AddressableResources/Live/Note/${skin}/${skin}.spriteatlasv2`),
    );
    const selectedSkin = this.availableNoteSkins.includes(this.noteSkin) ? this.noteSkin : "skin001";
    this.noteSkin = selectedSkin;
    const noteSkinSource = `Assets/AddressableResources/Live/Note/${selectedSkin}/LiveNoteSkinAsset.asset`;
    const [note, judgement, live, combo, font, noteSkin] = await Promise.all([
      this.descriptor(source(`${selectedSkin}.spriteatlasv2`)),
      this.descriptor(source("JudgementAtlas.spriteatlasv2")),
      this.descriptor(source("LiveAtlas.spriteatlasv2")),
      this.descriptor(source("LiveComboAtlas.spriteatlasv2")),
      fontSource.length === 1 ? this.descriptor(fontSource[0]!).catch(() => undefined) : Promise.resolve(undefined),
      files.has(noteSkinSource) ? this.descriptor(noteSkinSource) : Promise.resolve(undefined),
    ]);
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
      let filename = oldPath.slice(oldPath.lastIndexOf("/") + 1);
      if (filename === "note_excellent.prefab") filename = "note_just.prefab";
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
    const noteObjectPaths = new Map(
      (noteSkin?.runtimeObjects || [])
        .filter((entry) => entry.type === "Sprite")
        .map((entry) => [String(entry.pathId), entry.path]),
    );
    const noteSprites = new Map<string, { image: string; metadata: string }>();
    for (const output of noteSkin?.outputs || []) {
      if (output.type !== "Sprite") continue;
      const metadata = noteObjectPaths.get(String(output.objectId));
      if (metadata) noteSprites.set(logicalName(output), { image: output.path, metadata });
    }
    const runtimeUrl = (path: string) =>
      `/runtime/${encodeURIComponent(this.server)}/${path
        .replace(/^runtime\//u, "")
        .split("/")
        .map(encodeURIComponent)
        .join("/")}`;
    const nativeAsset = (path: string): string => {
      if (path.endsWith("/slideline_purple2.png") && noteSprites.has("notes_slide_side_0.png"))
        return runtimeUrl(noteSprites.get("notes_slide_side_0.png")!.image);
      return assetUrl(resolveSource(path));
    };
    const nativeRuntime = (path: string): string => {
      const match = /^unity-json\/(.*)\/([A-Za-z0-9_]+\.json)$/u.exec(path);
      if (!match) return runtimeUrl(path);
      const oldSource = match[1]!;
      if (files.has(oldSource)) return runtimeUrl(path);
      if (
        match[2] === "Sprite.json" &&
        oldSource.startsWith(`Assets/AddressableResources/Live/Note/${selectedSkin}/`)
      ) {
        const name = oldSource.slice(oldSource.lastIndexOf("/") + 1);
        const metadata = noteSprites.get(name)?.metadata;
        if (!metadata) throw new Error(`Missing note sprite metadata ${name}`);
        return runtimeUrl(metadata);
      }
      return runtimeUrl(`unity-json/${resolveSource(oldSource)}/${match[2]}`);
    };
    const media: OurNotesRuntimeMediaManifest = {
      noteSkin: selectedSkin,
      noteAtlasTextureUrl: this.output(note, "Texture2D"),
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
    this.loadedKey = `${this.server}:${this.source}`;
    this.phase = "loading";
    await this.updateComplete;
    try {
      const [response, assets] = await Promise.all([
        fetch(this.source, { headers: { accept: "text/plain" } }),
        this.runtimeAssets(),
      ]);
      if (!response.ok) throw new Error(`Chart ${response.status}`);
      this.chart = this.runtime()
        .require(OUR_NOTES_RULES)
        .parse(await response.text());
      this.assets = assets;
      this.phase = "ready";
      await this.updateComplete;
      await this.initialize();
    } catch (error) {
      console.error(error);
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
      if (["auto", "none", "1", "2"].includes(String(saved.stageBackground)))
        this.stageBackground = saved.stageBackground as StageBackground;
      this.playbackRate = number(saved.playbackRate, 0.5, 2, 1);
      this.volume = number(saved.volume, 0, 1, 0.8);
      if (OUR_NOTES_NOTE_SKINS.includes(saved.noteSkin as OurNotesNoteSkin)) this.noteSkin = saved.noteSkin!;
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
        }),
      );
    } catch {
      /* Runtime controls remain usable without storage. */
    }
  }
  private stageBackgroundUrl() {
    if (this.stageBackground === "none") return undefined;
    const band = this.stageBackground === "auto" ? Math.max(1, Number(this.bandId) || 1) : this.stageBackground;
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
  private async initialize() {
    const root = this.querySelector<HTMLElement>(".chart-runtime__stage");
    const canvas = this.querySelector<HTMLCanvasElement>(".chart-runtime__canvas");
    const hud = this.querySelector<HTMLCanvasElement>(".chart-runtime__hud");
    if (!root || !canvas || !hud || !this.chart || !this.assets) return;
    this.renderer = this.runtime()
      .require(THREE_RENDERER)
      .create({ canvas, hudCanvas: hud, alpha: true, antialias: true, assets: this.assets });
    [this.overviewSkin] = await Promise.all([loadDetailedOverviewSkin(this.assets), this.renderer.load()]);
    await this.applyStageBackground();
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
    this.noteSounds = this.runtime().require(WEB_HOST).createNoteSounds(this.assets.noteSounds);
    void this.noteSounds.load();
    this.attachSession();
    this.input = this.runtime()
      .require(WEB_HOST)
      .createInput(
        root,
        {
          tap: () => undefined,
          move: () => undefined,
          release: (point) => this.session?.release(point.lane, point.timeMs, point.pointerId),
          flick: () => undefined,
          cancel: (pointerId) => this.session?.cancel(pointerId),
        },
        {
          now: () => this.clock?.timeMs || 0,
          laneAtClientPoint: (x, y) => this.renderer?.clientPointToLane(x, y) ?? 12,
          screenDpi: 96,
          flickDistanceCm: 0.2,
        },
      );
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
    if (this.playing) {
      this.resumeAfterScrub = true;
      this.clock?.pause();
    }
    this.seek(seconds);
  }
  private async commitSeek(seconds: number) {
    this.seek(seconds);
    if (!this.resumeAfterScrub) return;
    this.resumeAfterScrub = false;
    await Promise.all([this.noteSounds?.unlock(), this.clock?.play()]);
  }
  private fullscreenChanged = () => (this.fullscreen = document.fullscreenElement === this);
  private toggleLoop() {
    this.loop = !this.loop;
    if (this.clock) this.clock.audio.loop = this.loop;
  }
  private async toggleFullscreen() {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await this.requestFullscreen();
  }
  private dispose() {
    this.pluginRuntime?.dispose();
    this.pluginRuntime = undefined;
    cancelAnimationFrame(this.animationFrame);
    this.playing = false;
    this.resumeAfterScrub = false;
    this.resizeObserver?.disconnect();
    this.input?.destroy();
    this.clock?.destroy();
    this.noteSounds?.dispose();
    this.overviewSkin?.dispose();
    this.renderer?.dispose();
    this.renderer = undefined;
    this.clock = undefined;
    this.input = undefined;
    this.noteSounds = undefined;
    this.overviewSkin = undefined;
  }
  private format(seconds: number) {
    const value = Math.max(0, Math.floor(seconds));
    return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`;
  }
  private ui(key: ChartUiKey) {
    const copy = {
      play: ["プレイ", "Play", "遊玩", "游玩", "플레이"],
      pause: ["一時停止", "Pause", "暫停", "暂停", "일시 정지"],
      loop: ["ループ", "Loop", "循環", "循环", "반복"],
      fullscreen: ["全画面", "Fullscreen", "全螢幕", "全屏", "전체 화면"],
      settings: ["ライブ設定", "Live settings", "LIVE 設定", "LIVE 设置", "라이브 설정"],
      reset: ["リセット", "Reset", "重設", "重置", "초기화"],
      close: ["閉じる", "Close", "關閉", "关闭", "닫기"],
      playback: ["再生", "Playback", "播放", "播放", "재생"],
      volume: ["音量", "Volume", "音量", "音量", "볼륨"],
      playbackSpeed: ["再生速度", "Playback speed", "播放速度", "播放速度", "재생 속도"],
      notes: ["ノーツ", "Notes", "音符", "音符", "노트"],
      noteSpeed: ["ノーツ速度", "Note speed", "音符速度", "音符速度", "노트 속도"],
      noteSize: ["ノーツ幅", "Note width", "音符寬度", "音符宽度", "노트 너비"],
      noteSkin: ["ノーツデザイン", "Note design", "音符樣式", "音符样式", "노트 디자인"],
      longOpacity: ["ロング透明度", "Long-note opacity", "長條透明度", "长条透明度", "롱 노트 투명도"],
      guideOpacity: ["ガイド透明度", "Guide-note opacity", "引導音符透明度", "引导音符透明度", "가이드 노트 투명도"],
      mirror: ["ミラー", "Mirror", "鏡像", "镜像", "미러"],
      effects: ["エフェクト", "Effects", "特效", "特效", "이펙트"],
      simultaneousLine: ["同時ライン", "Simultaneous line", "同時線", "同时线", "동시 라인"],
      judgementLine: ["判定ライン", "Judgement line", "判定線", "判定线", "판정선"],
      stage: ["ステージ", "Stage", "舞台", "舞台", "스테이지"],
      stageBackground: ["ステージ背景", "Stage background", "舞台背景", "舞台背景", "스테이지 배경"],
      songBand: ["楽曲のバンド", "Song band", "歌曲樂隊", "歌曲乐队", "곡 밴드"],
      noBackground: ["背景なし", "No background", "無背景", "无背景", "배경 없음"],
      backgroundBrightness: ["背景の明るさ", "Background brightness", "背景亮度", "背景亮度", "배경 밝기"],
      laneOpacity: ["レーン透明度", "Lane opacity", "軌道透明度", "轨道透明度", "레인 투명도"],
      guidelineOpacity: [
        "ガイドライン透明度",
        "Guideline opacity",
        "分隔線透明度",
        "分隔线透明度",
        "가이드라인 투명도",
      ],
      guidelineCount: ["ガイドライン数", "Guideline count", "分隔線數量", "分隔线数量", "가이드라인 수"],
    } as const;
    const index = Math.max(0, ["ja", "en", "zh-TW", "zh-CN", "ko"].indexOf(this.locale));
    return copy[key][index] || copy[key][1];
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
                <option value="1" ?selected=${this.stageBackground === "1"}>MyGO!!!!!</option>
                <option value="2" ?selected=${this.stageBackground === "2"}>Ave Mujica</option>
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
                ${loadingState(uiText(this.locale, "loading"))}
              `
            : this.phase === "error"
              ? html`
                  <div class="notice"><p>Unable to load the Our Notes chart runtime.</p></div>
                `
              : nothing
        }
        <div class="chart-simple-overview" ?hidden=${this.phase !== "ready" || this.mode !== "simple"}>
          <canvas aria-label=${this.label}></canvas>
        </div>
        <div class="chart-runtime__stage" ?hidden=${this.phase !== "ready" || this.mode !== "watch"}>
          <canvas class="chart-runtime__canvas"></canvas>
          <canvas class="chart-runtime__hud"></canvas>
        </div>
        ${
          this.phase === "ready" && this.mode === "watch"
            ? html`
                <footer class="chart-runtime__controls">
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
                    <button class="icon-button" @click=${this.toggleFullscreen} aria-label=${this.ui("fullscreen")}>
                      <svg class="material-icon" width="20" height="20">
                        <use href="/icons.svg#fullscreen"></use>
                      </svg>
                    </button>
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
