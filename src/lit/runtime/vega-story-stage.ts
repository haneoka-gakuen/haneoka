import { LitElement, html } from "lit";
import { createVega, type AdvStory, type VegaEngine, type VegaPlayerHandle } from "@haneoka/vega/engine";
import { configureStoryRuntime, type StoryMessageKey } from "@haneoka/vega/runtime";
import type { CubismRuntimeAdapter } from "@haneoka/vega-plugin-cubism";
import { createCubismPlugin } from "@haneoka/vega-plugin-cubism";
import { hydrateStoryPayload } from "@haneoka/vega-plugin-haneoka";
import { createVegaRichTextPlugin } from "@haneoka/vega-plugin-richtext";
import { createThreeRendererPlugin } from "@haneoka/vega-renderer-three";
import { defineVegaPlugin } from "@haneoka/vega/plugin";
import {
  createHaneokaThemeHostPlugin,
  vegaHaneokaTheme,
  type HaneokaThemeHost,
  type HaneokaThemeHostSnapshot,
} from "@haneoka/vega-theme-haneoka";
import { vegaPortableUiPlugin } from "@haneoka/vega-ui-portable";

type RecordValue = Record<string, unknown>;
type CubismProvision = {
  createCubismWebRuntimeAdapter(options: RecordValue): CubismRuntimeAdapter;
};

const runtimeUrls = {
  cubismCoreUrl: "/Core/live2dcubismcore.js",
  cubism2CoreUrl: "/Core/live2d.min.js",
  motionSyncCoreUrl: "/Core/CRI/live2dcubismmotionsynccore.min.js",
};

// The Haneoka theme declares the default shell package as a dependency because
// its control strip shares the shell controller service.  Installing the real
// package also mounts its title/menu overlay, which is deliberately not part of
// the embedded story player.  This compatibility plugin satisfies that package
// dependency; Vega still creates the controller requested by Haneoka's own
// controls, but there is no second shell UI to cover the scene.
const embeddedShellCompatibility = defineVegaPlugin({
  manifest: {
    id: "haneoka.vega-shell-default",
    name: "Haneoka embedded shell compatibility",
    version: "0.1.0",
    apiVersion: 1,
    description: "Provides the default-shell dependency without mounting standalone shell UI",
  },
  setup() {},
});

let provision: Promise<CubismProvision> | undefined;
const CUBISM_PROVISION_URL = "/cubism-runtime/vega-cubism-web-runtime.mjs";
const cubismAdapter = (): CubismRuntimeAdapter => {
  let resolved: CubismRuntimeAdapter | undefined;
  const runtime = async () => {
    provision ??= import(/* @vite-ignore */ CUBISM_PROVISION_URL) as Promise<CubismProvision>;
    resolved ??= (await provision).createCubismWebRuntimeAdapter({
      id: "haneoka.web-cubism-runtime",
      runtime: runtimeUrls,
    });
    return resolved;
  };
  return {
    id: "haneoka.web-cubism-runtime",
    async prepare(version, signal) {
      await (await runtime()).prepare?.(version, signal);
    },
    async create(context) {
      return (await runtime()).create(context);
    },
    async createForRenderer(context) {
      const adapter = await runtime();
      if (!adapter.createForRenderer) throw new Error("Cubism renderer adapter is unavailable");
      return adapter.createForRenderer(context);
    },
    async disposeRendererModel(model, context) {
      const adapter = await runtime();
      if (adapter.disposeRendererModel) await adapter.disposeRendererModel(model, context);
    },
    getMouthParameterProfile(context) {
      return resolved?.getMouthParameterProfile?.(context) ?? null;
    },
    applyLipSync(context) {
      if (!resolved?.applyLipSync) throw new Error("Cubism lip sync is unavailable");
      resolved.applyLipSync(context);
    },
  };
};

const merge = (base: unknown, authored: unknown): RecordValue => {
  const left = base && typeof base === "object" && !Array.isArray(base) ? (base as RecordValue) : {};
  const right = authored && typeof authored === "object" && !Array.isArray(authored) ? (authored as RecordValue) : {};
  const result: RecordValue = { ...left };
  for (const [key, value] of Object.entries(right))
    result[key] =
      value && typeof value === "object" && !Array.isArray(value) && left[key] && typeof left[key] === "object"
        ? merge(left[key], value)
        : value;
  return result;
};

export class VegaStoryStage extends LitElement {
  static properties = {
    story: { attribute: false },
    server: { type: String },
    locale: { type: String },
    providerBase: { type: String, attribute: "provider-base" },
    phase: { state: true },
    issue: { state: true },
    commandIndex: { state: true },
    commandCount: { state: true },
    playing: { state: true },
    autoPlay: { state: true },
    settingsOpen: { state: true },
    volume: { state: true },
    bgmVolume: { state: true },
    bgmEnabled: { state: true },
    autoPlayDelaySeconds: { state: true },
    instantText: { state: true },
    subtitles: { state: true },
    textSize: { state: true },
    controlsVisible: { state: true },
  };
  declare story: RecordValue;
  declare server: string;
  declare locale: string;
  declare providerBase: string;
  declare phase: "loading" | "ready" | "error";
  declare issue: string;
  declare commandIndex: number;
  declare commandCount: number;
  declare playing: boolean;
  declare autoPlay: boolean;
  declare settingsOpen: boolean;
  declare volume: number;
  declare bgmVolume: number;
  declare bgmEnabled: boolean;
  declare autoPlayDelaySeconds: number;
  declare instantText: boolean;
  declare subtitles: boolean;
  declare textSize: number;
  declare controlsVisible: boolean;
  private loadedStory = "";
  private engine?: VegaEngine;
  private player?: VegaPlayerHandle;
  private hydrated?: AdvStory;
  private stateFrame = 0;
  private started = false;
  private restarting = false;
  private controlsTimer = 0;
  private hostListeners = new Set<(snapshot: HaneokaThemeHostSnapshot) => void>();

  constructor() {
    super();
    this.story = {};
    this.server = "gl-cbt";
    this.locale = "ja";
    this.providerBase = "";
    this.phase = "loading";
    this.issue = "";
    this.commandIndex = 0;
    this.commandCount = 0;
    this.playing = false;
    this.autoPlay = false;
    this.settingsOpen = false;
    this.volume = 1;
    this.bgmVolume = 1;
    this.bgmEnabled = true;
    this.autoPlayDelaySeconds = 0.5;
    this.instantText = false;
    this.subtitles = true;
    this.textSize = 1;
    this.controlsVisible = true;
    this.restoreSettings();
  }
  createRenderRoot() {
    return this;
  }
  connectedCallback() {
    super.connectedCallback();
    void Promise.all([
      import("@material/web/slider/slider.js"),
      import("@material/web/switch/switch.js"),
      import("@material/web/progress/circular-progress.js"),
    ]);
    void this.load();
  }
  disconnectedCallback() {
    cancelAnimationFrame(this.stateFrame);
    clearTimeout(this.controlsTimer);
    this.persistSettings();
    void this.disposePlayer();
    super.disconnectedCallback();
  }
  updated() {
    const id = String(this.story?.storyId || "");
    if (id && id !== this.loadedStory) void this.load();
  }
  private url(resource: string, id = "") {
    return `/api/v1/servers/${encodeURIComponent(this.server)}/${resource}${id ? `/${encodeURIComponent(id)}` : ""}`;
  }
  private async json(url: string) {
    const response = await fetch(url, { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return (await response.json()) as RecordValue;
  }
  private ui(
    key:
      | "play"
      | "pause"
      | "progress"
      | "settings"
      | "fullscreen"
      | "volume"
      | "bgm"
      | "bgmEnabled"
      | "autoPlayDelay"
      | "instantText"
      | "subtitles"
      | "textSize"
      | "playback",
  ) {
    const copy = {
      play: ["再生", "Play", "播放", "播放", "재생"],
      pause: ["一時停止", "Pause", "暫停", "暂停", "일시 정지"],
      progress: ["進行", "Progress", "進度", "进度", "진행"],
      settings: ["設定", "Settings", "設定", "设置", "설정"],
      fullscreen: ["全画面", "Fullscreen", "全螢幕", "全屏", "전체 화면"],
      volume: ["音量", "Volume", "音量", "音量", "음량"],
      bgm: ["BGM", "BGM", "BGM", "BGM", "BGM"],
      bgmEnabled: ["BGMを有効にする", "Enable BGM", "啟用 BGM", "启用 BGM", "BGM 사용"],
      autoPlayDelay: ["オート待ち時間", "Auto-play delay", "自動播放延遲", "自动播放延迟", "자동 재생 지연"],
      instantText: ["テキスト即時表示", "Instant text", "即時顯示文字", "即时显示文字", "텍스트 즉시 표시"],
      subtitles: ["字幕", "Subtitles", "字幕", "字幕", "자막"],
      textSize: ["文字サイズ", "Text size", "文字大小", "文字大小", "글자 크기"],
      playback: ["再生操作", "Playback", "播放控制", "播放控制", "재생"],
    } as const;
    const index = Math.max(0, ["ja", "en", "zh-TW", "zh-CN", "ko"].indexOf(this.locale));
    return copy[key][index] || copy[key][1];
  }
  private restoreSettings() {
    try {
      const value = JSON.parse(localStorage.getItem("haneoka:story-player:v1") || "null") as RecordValue | null;
      if (!value) return;
      const clamp = (candidate: unknown, min: number, max: number, fallback: number) => {
        const number = Number(candidate);
        return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
      };
      this.volume = clamp(value.volume, 0, 1, 1);
      this.bgmVolume = clamp(value.volumeBgm, 0, 1, 1);
      this.bgmEnabled = typeof value.bgmEnabled === "boolean" ? value.bgmEnabled : true;
      this.autoPlayDelaySeconds = Math.round(clamp(value.autoPlayDelaySeconds, 0, 5, 0.5) * 2) / 2;
      this.instantText = Boolean(value.instantText);
      this.subtitles = typeof value.subtitlesEnabled === "boolean" ? value.subtitlesEnabled : true;
      this.textSize = clamp(value.textSize, 0.5, 2, 1);
    } catch {
      localStorage.removeItem("haneoka:story-player:v1");
    }
  }
  private persistSettings() {
    try {
      localStorage.setItem(
        "haneoka:story-player:v1",
        JSON.stringify({
          volume: this.volume,
          volumeBgm: this.bgmVolume,
          bgmEnabled: this.bgmEnabled,
          autoPlayDelaySeconds: this.autoPlayDelaySeconds,
          instantText: this.instantText,
          textSize: this.textSize,
          subtitlesEnabled: this.subtitles,
        }),
      );
    } catch {
      /* Runtime controls stay usable without storage. */
    }
  }
  private async load() {
    const id = String(this.story?.storyId || "");
    if (!id) return;
    this.loadedStory = id;
    this.phase = "loading";
    await this.updateComplete;
    try {
      const assets = (this.story.assets as RecordValue | undefined) || {};
      const keys = (Array.isArray(assets.live2d) ? (assets.live2d as RecordValue[]) : [])
        .map((entry) => String(entry.live2dKey || ""))
        .filter(Boolean);
      const [runtime, live2d] = this.providerBase
        ? await Promise.all([
            Promise.resolve((this.story.runtime as RecordValue | undefined) || {}),
            keys.length
              ? this.json(
                  `${this.providerBase}/live2d?${keys.map((key) => `id=${encodeURIComponent(key)}`).join("&")}`,
                ).then((payload) =>
                  keys.map(
                    (key) => ((payload.items as RecordValue | undefined)?.[key] as RecordValue | undefined) || {},
                  ),
                )
              : Promise.resolve([]),
          ])
        : await Promise.all([
            this.json(this.url("story-runtime")),
            Promise.all(keys.map((key) => this.json(this.url("live2d", key)))),
          ]);
      this.hydrated = hydrateStoryPayload({
        ...this.story,
        assets: { ...assets, live2d: live2d.map((entry, index) => ({ id: keys[index], ...entry })) },
        runtime: merge(runtime, this.story.runtime),
      }) as AdvStory;
      this.phase = "ready";
      await this.updateComplete;
      let lastError: unknown;
      const attempts = this.providerBase ? 3 : 1;
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        try {
          await this.createPlayer();
          lastError = undefined;
          break;
        } catch (error) {
          lastError = error;
          await this.disposePlayer();
          if (attempt + 1 < attempts) await new Promise((resolve) => window.setTimeout(resolve, 450 * (attempt + 1)));
        }
      }
      if (lastError) throw lastError;
    } catch (error) {
      console.error(error);
      this.issue = error instanceof Error ? error.message : String(error);
      this.phase = "error";
    }
  }
  private async createPlayer() {
    const mount = this.querySelector<HTMLElement>(".vega-story-runtime__mount");
    if (!mount || !this.hydrated) throw new Error("Vega player host is unavailable");
    const locales = ["ja", "en", "zh-TW", "zh-CN", "ko"];
    const index = Math.max(0, locales.indexOf(this.locale));
    const localize = (value: unknown): string => {
      if (Array.isArray(value)) return localize(value[index] ?? value[0]);
      if (value && typeof value === "object") {
        const values = (value as { values?: unknown[] }).values;
        return values
          ? localize(values)
          : Object.values(value as RecordValue)
              .map(localize)
              .find(Boolean) || "";
      }
      return value == null ? "" : String(value);
    };
    const messages: Partial<Record<StoryMessageKey, string[]>> = {
      play: ["再生", "Play", "播放", "播放", "재생"],
      replay: ["もう一度", "Replay", "重播", "重播", "다시 재생"],
      autoplay: ["オート", "Auto", "自動播放", "自动播放", "자동 재생"],
      settings: ["設定", "Settings", "設定", "设置", "설정"],
    };
    configureStoryRuntime({
      localize,
      resolveLocalized: (value) => ({ text: localize(value), lang: this.locale }),
      message: (key) => messages[key]?.[index] || key,
    });
    await this.disposePlayer();
    const engine = createVega({
      plugins: [
        createVegaRichTextPlugin(),
        vegaPortableUiPlugin,
        embeddedShellCompatibility,
        createThreeRendererPlugin(),
        createCubismPlugin({ adapter: cubismAdapter() }),
        vegaHaneokaTheme,
        createHaneokaThemeHostPlugin(this.themeHost()),
      ],
    });
    this.engine = engine;
    this.player = await engine.createPlayer({
      mount,
      story: this.hydrated,
      renderBackend: "vega-three-webgl2",
      theme: "haneoka",
    });
    this.player.player.SoundManager.setMasterVolume(this.volume);
    this.player.player.SoundManager.setUserCategoryVolume("Bgm", this.bgmEnabled ? this.bgmVolume : 0);
    this.player.player.state.instantText = this.instantText;
    this.player.player.setSubtitlesEnabled(this.subtitles);
    this.player.player.setAutoPlayInterval(Math.round(this.autoPlayDelaySeconds * 2));
    this.started = true;
    this.observeState();
    void this.player.player.play();
  }
  private themeSnapshot(): HaneokaThemeHostSnapshot {
    return {
      autoAdvance: this.autoPlay,
      autoAdvanceDisabled: false,
      instantText: this.instantText,
      subtitlesEnabled: this.subtitles,
      videoVisible: false,
      fullscreen: Boolean(document.fullscreenElement),
      bgmEnabled: this.bgmEnabled,
      volume: this.volume,
      bgmVolume: this.bgmVolume,
      autoPlayDelaySeconds: this.autoPlayDelaySeconds,
      maximumAutoPlayDelaySeconds: 5,
      textSize: this.textSize,
      progress: this.commandCount ? this.commandIndex / Math.max(1, this.commandCount - 1) : 0,
      progressEnabled: this.commandCount > 0,
      progressLabel: `${this.commandIndex + 1} / ${this.commandCount}`,
    };
  }
  private themeHost(): HaneokaThemeHost {
    return {
      externalPlaybackControls: true,
      snapshot: () => this.themeSnapshot(),
      subscribe: (listener) => {
        this.hostListeners.add(listener);
        listener(this.themeSnapshot());
        return () => {
          this.hostListeners.delete(listener);
        };
      },
      toggleAutoAdvance: () => this.toggleAuto(),
      setInstantText: (value) => {
        this.instantText = value;
        if (this.player) this.player.player.state.instantText = value;
        this.persistSettings();
      },
      setSubtitlesEnabled: (value) => {
        this.subtitles = value;
        this.player?.player.setSubtitlesEnabled(value);
        this.persistSettings();
      },
      setBgmEnabled: (value) => {
        this.bgmEnabled = value;
        this.player?.player.SoundManager.setUserCategoryVolume("Bgm", value ? this.bgmVolume : 0);
        this.persistSettings();
      },
      setVolume: (value) => {
        this.volume = value;
        this.player?.player.SoundManager.setMasterVolume(value);
        this.persistSettings();
      },
      setBgmVolume: (value) => {
        this.bgmVolume = value;
        this.player?.player.SoundManager.setUserCategoryVolume("Bgm", this.bgmEnabled ? value : 0);
        this.persistSettings();
      },
      setAutoPlayDelaySeconds: (value) => {
        this.autoPlayDelaySeconds = value;
        this.player?.player.setAutoPlayInterval(Math.round(value * 2));
        this.persistSettings();
      },
      setTextSize: (value) => {
        this.textSize = value;
        this.persistSettings();
      },
      seekProgress: (value) => void this.seek(value),
      skipCurrentVideo: () => undefined,
      toggleFullscreen: async () => {
        if (document.fullscreenElement) await document.exitFullscreen();
        else await this.requestFullscreen();
      },
      openTextView: () => this.dispatchEvent(new CustomEvent("open-text", { bubbles: true, composed: true })),
    };
  }
  private async disposePlayer() {
    await this.player?.dispose().catch(() => undefined);
    await this.engine?.dispose().catch(() => undefined);
    this.player = undefined;
    this.engine = undefined;
  }
  private observeState() {
    cancelAnimationFrame(this.stateFrame);
    const update = () => {
      const state = this.player?.player.state;
      if (state) {
        this.commandIndex = state.commandIndex;
        this.commandCount = state.commandCount;
        const nextPlaying = state.autoPlay;
        if (this.playing !== nextPlaying) {
          this.playing = nextPlaying;
          this.showControls();
        }
        this.autoPlay = state.autoPlay;
        const snapshot = this.themeSnapshot();
        for (const listener of this.hostListeners) listener(snapshot);
      }
      this.stateFrame = requestAnimationFrame(update);
    };
    this.stateFrame = requestAnimationFrame(update);
  }
  private async primaryAction() {
    const player = this.player;
    const runtime = player?.player;
    if (!player || !runtime) return;
    if (runtime.state.finished) return this.restart();
    if (!this.started) {
      if (!runtime.state.autoPlay) runtime.toggleAuto();
      void runtime.play();
      this.started = true;
    } else runtime.toggleAuto();
  }
  private async restart() {
    if (this.restarting) return;
    this.restarting = true;
    try {
      await this.createPlayer();
      const runtime = this.player?.player;
      if (!runtime) return;
      if (!runtime.state.autoPlay) runtime.toggleAuto();
      void runtime.play();
      this.started = true;
    } finally {
      this.restarting = false;
    }
  }
  private toggleAuto() {
    const runtime = this.player?.player;
    if (!runtime) return;
    runtime.toggleAuto();
    if (!this.started) {
      this.started = true;
      void runtime.play();
    }
  }
  private showControls = () => {
    clearTimeout(this.controlsTimer);
    this.controlsVisible = true;
    if (!this.settingsOpen) this.controlsTimer = window.setTimeout(() => (this.controlsVisible = false), 2400);
  };
  private async seek(ratio: number) {
    const player = this.player;
    const runtime = player?.player;
    if (!player || !runtime || !this.commandCount) return;
    const target = Math.round(Math.max(0, Math.min(1, ratio)) * Math.max(0, this.commandCount - 1));
    if (target < this.commandIndex) {
      await this.createPlayer();
      this.started = true;
      void this.player?.player.play();
    }
    await this.player?.player.seekForwardTo(target);
  }
  render() {
    return html`
      <section
        class=${`vega-story-runtime ${this.controlsVisible || this.settingsOpen ? "controls-visible" : "controls-hidden"}`}
        @pointermove=${this.showControls}
        @pointerdown=${this.showControls}
        @focusin=${this.showControls}
      >
        ${
          this.phase === "loading"
            ? html`
                <div class="catalog-state"><md-circular-progress indeterminate></md-circular-progress></div>
              `
            : ""
        }
        ${
          this.phase === "error"
            ? html`
                <div class="notice"><p>${this.issue}</p></div>
              `
            : ""
        }
        <div class="vega-story-runtime__mount" ?hidden=${this.phase !== "ready"}></div>
        ${
          this.phase === "ready"
            ? html`
                <footer class="vega-story-runtime__controls">
                  <button
                    class="icon-button"
                    @click=${this.primaryAction}
                    aria-label=${this.playing ? this.ui("pause") : this.ui("play")}
                  >
                    <svg class="material-icon" width="24" height="24">
                      <use href=${this.playing ? "/icons.svg#pause" : "/icons.svg#play_arrow"}></use>
                    </svg>
                  </button>
                  <small>${this.commandIndex + 1}</small>
                  <md-slider
                    class="md3-slider md3-slider--runtime"
                    min="0"
                    max="1"
                    step="0.001"
                    .value=${String(this.commandCount ? this.commandIndex / Math.max(1, this.commandCount - 1) : 0)}
                    @change=${(event: Event) =>
                      this.seek(Number((event.target as HTMLElement & { value?: number }).value))}
                    aria-label=${this.ui("progress")}
                  ></md-slider>
                  <small>${this.commandCount}</small>
                  <button
                    class="icon-button"
                    aria-pressed=${this.settingsOpen}
                    @click=${() => {
                      this.settingsOpen = !this.settingsOpen;
                      this.showControls();
                    }}
                    aria-label=${this.ui("settings")}
                  >
                    <svg class="material-icon" width="20" height="20">
                      <use href=${`/icons.svg#tune${this.settingsOpen ? "-filled" : ""}`}></use>
                    </svg>
                  </button>
                  <button
                    class="icon-button"
                    @click=${async () =>
                      document.fullscreenElement ? document.exitFullscreen() : this.requestFullscreen()}
                    aria-label=${this.ui("fullscreen")}
                  >
                    <svg class="material-icon" width="20" height="20"><use href="/icons.svg#fullscreen"></use></svg>
                  </button>
                </footer>
                ${
                  this.settingsOpen
                    ? html`
                        <aside class="vega-story-runtime__settings">
                          <header>
                            <strong>${this.ui("playback")}</strong>
                            <button class="icon-button" @click=${() => (this.settingsOpen = false)} aria-label="Close">
                              <svg class="material-icon" width="18" height="18">
                                <use href="/icons.svg#close"></use>
                              </svg>
                            </button>
                          </header>
                          <label>
                            <span>${this.ui("volume")}</span>
                            <md-slider
                              class="md3-slider md3-slider--runtime"
                              min="0"
                              max="1"
                              step="0.05"
                              .value=${String(this.volume)}
                              @input=${(event: Event) =>
                                this.themeHost().setVolume(
                                  Number((event.target as HTMLElement & { value?: number }).value),
                                )}
                            ></md-slider>
                          </label>
                          <label>
                            <span>${this.ui("bgm")}</span>
                            <md-slider
                              class="md3-slider md3-slider--runtime"
                              min="0"
                              max="1"
                              step="0.05"
                              .value=${String(this.bgmVolume)}
                              @input=${(event: Event) =>
                                this.themeHost().setBgmVolume(
                                  Number((event.target as HTMLElement & { value?: number }).value),
                                )}
                            ></md-slider>
                          </label>
                          <label class="vega-story-runtime__toggle">
                            <span>${this.ui("bgmEnabled")}</span>
                            <md-switch
                              .selected=${this.bgmEnabled}
                              @change=${(event: Event) =>
                                this.themeHost().setBgmEnabled(
                                  Boolean((event.target as HTMLElement & { selected?: boolean }).selected),
                                )}
                            ></md-switch>
                          </label>
                          <label>
                            <span>${this.ui("autoPlayDelay")}</span>
                            <md-slider
                              class="md3-slider md3-slider--runtime"
                              min="0"
                              max="5"
                              step="0.5"
                              .value=${String(this.autoPlayDelaySeconds)}
                              @input=${(event: Event) =>
                                this.themeHost().setAutoPlayDelaySeconds(
                                  Number((event.target as HTMLElement & { value?: number }).value),
                                )}
                            ></md-slider>
                          </label>
                          <label class="vega-story-runtime__toggle">
                            <span>${this.ui("instantText")}</span>
                            <md-switch
                              .selected=${this.instantText}
                              @change=${(event: Event) =>
                                this.themeHost().setInstantText(
                                  Boolean((event.target as HTMLElement & { selected?: boolean }).selected),
                                )}
                            ></md-switch>
                          </label>
                          <label class="vega-story-runtime__toggle">
                            <span>${this.ui("subtitles")}</span>
                            <md-switch
                              .selected=${this.subtitles}
                              @change=${(event: Event) =>
                                this.themeHost().setSubtitlesEnabled(
                                  Boolean((event.target as HTMLElement & { selected?: boolean }).selected),
                                )}
                            ></md-switch>
                          </label>
                          <label>
                            <span>${this.ui("textSize")}</span>
                            <md-slider
                              class="md3-slider md3-slider--runtime"
                              min="0.75"
                              max="1.5"
                              step="0.05"
                              .value=${String(this.textSize)}
                              @input=${(event: Event) =>
                                this.themeHost().setTextSize(
                                  Number((event.target as HTMLElement & { value?: number }).value),
                                )}
                            ></md-slider>
                          </label>
                        </aside>
                      `
                    : ""
                }
              `
            : ""
        }
      </section>
    `;
  }
}
customElements.define("vega-story-stage", VegaStoryStage);
