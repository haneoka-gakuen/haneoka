import { LitElement, html, nothing } from "lit";
import {
  ChartSession,
  MediaClock,
  NoteSoundPlayer,
  OurNotesInput,
  OurNotesRenderer,
  RenderFrameBuilder,
  type ChartDocument,
  type RenderSettings,
} from "@haneoka/chart";
import {
  OUR_NOTES_RUNTIME_SOURCES,
  ourNotesAssetManifestForRelease,
  type OurNotesAssetManifest,
  type OurNotesRuntimeMediaManifest,
} from "@haneoka/chart/assets";
import { drawDetailedChartOverview, loadDetailedOverviewSkin } from "./chart-overview-renderer";

type RuntimeOutput = { objectId: string | number; path: string; type: string };
type RuntimeDescriptor = { sourcePath?: string; outputs?: RuntimeOutput[] };

const logicalName = (output: RuntimeOutput) => {
  const file = output.path.split("/").pop() || "";
  const extension = file.match(/\.[^.]+$/u)?.[0] || "";
  const suffix = `--${output.type}-${String(output.objectId)}${extension}`;
  return extension && file.endsWith(suffix) ? `${file.slice(0, -suffix.length)}${extension}` : "";
};
const renderPixelRatio = (width: number, height: number) =>
  Math.max(1, Math.min(2, devicePixelRatio || 1, Math.sqrt((1920 * 1080) / Math.max(1, width * height))));

export class ChartSimulator extends LitElement {
  static properties = {
    source: { type: String },
    audioUrl: { type: String, attribute: "audio-url" },
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
  };
  declare source: string;
  declare audioUrl: string;
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
  private chart?: ChartDocument;
  private assets?: OurNotesAssetManifest;
  private renderer?: OurNotesRenderer;
  private session?: ChartSession;
  private frames?: RenderFrameBuilder;
  private clock?: MediaClock;
  private noteSounds?: NoteSoundPlayer;
  private input?: OurNotesInput;
  private overviewSkin?: Awaited<ReturnType<typeof loadDetailedOverviewSkin>>;
  private resizeObserver?: ResizeObserver;
  private animationFrame = 0;
  private loadedKey = "";
  private resumeAfterScrub = false;

  constructor() {
    super();
    this.source = "";
    this.audioUrl = "";
    this.label = "Chart";
    this.server = "gl-cbt";
    this.locale = "ja";
    this.phase = "loading";
    this.playing = false;
    this.mode = "simple";
    this.currentTime = 0;
    this.duration = 0;
    this.loop = false;
    this.fullscreen = false;
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
  private output(descriptor: RuntimeDescriptor, type: string, name?: string) {
    const matches = (descriptor.outputs || []).filter(
      (entry) => entry.type === type && (!name || logicalName(entry) === name),
    );
    if (matches.length !== 1) throw new Error(`Missing ${type} ${name || ""}`);
    return `/runtime/${encodeURIComponent(this.server)}/${matches[0]!.path.replace(/^runtime\//u, "")}`;
  }
  private async runtimeAssets() {
    const [note, judgement, live, combo, font] = await Promise.all([
      this.descriptor(OUR_NOTES_RUNTIME_SOURCES.noteAtlas),
      this.descriptor(OUR_NOTES_RUNTIME_SOURCES.judgementAtlas),
      this.descriptor(OUR_NOTES_RUNTIME_SOURCES.liveAtlas),
      this.descriptor(OUR_NOTES_RUNTIME_SOURCES.comboAtlas),
      this.descriptor(OUR_NOTES_RUNTIME_SOURCES.font).catch(() => undefined),
    ]);
    const sprite = (descriptor: RuntimeDescriptor, name: string) => this.output(descriptor, "Sprite", name);
    const digits = (prefix: string) =>
      Array.from({ length: 10 }, (_, value) => sprite(combo, `${prefix}_${value}.png`));
    const root = `/assets/${encodeURIComponent(this.server)}`;
    const media: OurNotesRuntimeMediaManifest = {
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
    return ourNotesAssetManifestForRelease(this.server, media);
  }

  private async load() {
    if (!this.source) return;
    this.dispose();
    this.loadedKey = `${this.server}:${this.source}`;
    this.phase = "loading";
    await this.updateComplete;
    try {
      const [response, parser, assets] = await Promise.all([
        fetch(this.source, { headers: { accept: "text/plain" } }),
        import("@haneoka/chart/parser"),
        this.runtimeAssets(),
      ]);
      if (!response.ok) throw new Error(`Chart ${response.status}`);
      this.chart = parser.buildChart(parser.parseScore(await response.text()));
      this.assets = assets;
      this.phase = "ready";
      await this.updateComplete;
      await this.initialize();
    } catch (error) {
      console.error(error);
      this.phase = "error";
    }
  }
  private settings(): Partial<RenderSettings> {
    return {
      noteSpeed: 5,
      noteSize: 1,
      longAlpha: 1,
      guideAlpha: 0.7,
      mirror: false,
      effects: true,
      graphicsQuality: 1,
      guidelineCount: 6,
      guidelineOpacity: 0.4,
      laneOpacity: 0.8,
      backgroundBrightness: 0.7,
    };
  }
  private async initialize() {
    const root = this.querySelector<HTMLElement>(".chart-runtime__stage");
    const canvas = this.querySelector<HTMLCanvasElement>(".chart-runtime__canvas");
    const hud = this.querySelector<HTMLCanvasElement>(".chart-runtime__hud");
    if (!root || !canvas || !hud || !this.chart || !this.assets) return;
    this.renderer = new OurNotesRenderer({ canvas, hudCanvas: hud, alpha: true, antialias: true, assets: this.assets });
    [this.overviewSkin] = await Promise.all([loadDetailedOverviewSkin(this.assets), this.renderer.load()]);
    await this.renderer.setBackgroundTexture(
      `/assets/${encodeURIComponent(this.server)}/Assets/AddressableResources/Band/1/live_stage/lightweight_background.png`,
    );
    this.clock = new MediaClock(this.audioUrl, { volume: 0.8, playbackRate: 1, loop: false });
    this.clock.audio.loop = this.loop;
    this.noteSounds = new NoteSoundPlayer(this.assets.noteSounds);
    void this.noteSounds.load();
    this.attachSession();
    this.input = new OurNotesInput(
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
        flickDistanceCm: 0.1,
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
    this.session = new ChartSession(this.chart, { mode: "watch" });
    this.frames = new RenderFrameBuilder(this.chart);
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
    this.noteSounds?.flush(0.7);
    this.noteSounds?.setLongLineActive(this.playing && snapshot.activeLongLine, 0.7);
    this.renderer.render(this.frames.buildReusable(time, snapshot, this.settings()));
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
    cancelAnimationFrame(this.animationFrame);
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
  private ui(key: "play" | "pause" | "watch" | "loop" | "fullscreen") {
    const copy = {
      play: ["プレイ", "Play", "遊玩", "游玩", "플레이"],
      pause: ["一時停止", "Pause", "暫停", "暂停", "일시 정지"],
      watch: ["観賞", "Watch", "觀看", "观看", "감상"],
      loop: ["ループ", "Loop", "循環", "循环", "반복"],
      fullscreen: ["全画面", "Fullscreen", "全螢幕", "全屏", "전체 화면"],
    } as const;
    const index = Math.max(0, ["ja", "en", "zh-TW", "zh-CN", "ko"].indexOf(this.locale));
    return copy[key][index] || copy[key][1];
  }
  render() {
    return html`
      <section class="chart-runtime">
        ${
          this.phase === "loading"
            ? html`
                <div class="catalog-state"><md-circular-progress indeterminate></md-circular-progress></div>
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
                      <use href=${`/icons.svg#${this.fullscreen ? "fullscreen_exit-filled" : "fullscreen"}`}></use>
                    </svg>
                  </button>
                </footer>
              `
            : nothing
        }
      </section>
    `;
  }
}
customElements.define("chart-simulator", ChartSimulator);
