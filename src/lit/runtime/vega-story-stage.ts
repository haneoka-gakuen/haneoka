import { BESTDORI_CATALOG_VERSION } from "@haneoka/bestdori/resources";
import { LitElement, html, nothing } from "lit";
import { resolveStoryRuntimeAssets, storySourceUrl } from "../../lib/story-assets";
import { resolveLocalizedText } from "../../lib/localized-text";
import { uiText } from "../shared/catalog";
import { loadingState } from "../ui/state";
import { createVega, type AdvStory, type VegaEngine, type VegaPlayerHandle } from "@haneoka/vega/engine";
import type { StoryResolvedText } from "@haneoka/vega/runtime";
import type { CubismRuntimeAdapter } from "@haneoka/vega-plugin-cubism";
import { createCubismPlugin } from "@haneoka/vega-plugin-cubism";
import { hydrateStoryPayload } from "@haneoka/vega-plugin-haneoka";
import { createVegaRichTextPlugin } from "@haneoka/vega-plugin-richtext";
import { createThreeRendererPlugin } from "@haneoka/vega-renderer-three";
import { vegaDefaultShell } from "@haneoka/vega-shell-default";
import {
  vegaHaneokaTheme,
  createHaneokaThemeAssetsPlugin,
  createHaneokaThemeHostPlugin,
  createHaneokaStorySequencePlugin,
  HANEOKA_POST_TEXTURE_ASSETS,
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

let provision: Promise<CubismProvision> | undefined;
const CUBISM_PROVISION_URL = "/cubism-runtime/vega-cubism-web-runtime.mjs";
const cubismAdapter = (): CubismRuntimeAdapter => {
  let resolved: CubismRuntimeAdapter | undefined;
  const runtime = async () => {
    provision ??= import(
      /* @vite-ignore */ new URL(CUBISM_PROVISION_URL, document.baseURI).href
    ) as Promise<CubismProvision>;
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

type StoryTransportKey = "auto" | "storyProgress";

/** Transport copy in the locale order `ui()` indexes. */
const TRANSPORT_TEXT: Record<StoryTransportKey, readonly [string, string, string, string, string]> = {
  auto: ["オート", "Auto", "自動", "自动", "자동"],
  storyProgress: ["シナリオ進行", "Story progress", "劇情進度", "剧情进度", "이야기 진행"],
};

export class VegaStoryStage extends LitElement {
  static properties = {
    story: { attribute: false },
    server: { type: String },
    locale: { type: String },
    providerBase: { type: String, attribute: "provider-base" },
    phase: { state: true },
    issue: { state: true },
    autoMode: { state: true },
    ordinal: { state: true },
    maximum: { state: true },
    transportVisible: { state: true },
    fullscreenActive: { state: true },
  };
  declare story: RecordValue;
  declare server: string;
  declare locale: string;
  declare providerBase: string;
  declare phase: "loading" | "ready" | "error";
  declare issue: string;
  /** AUTO advance, mirrored from the player for the transport button. */
  declare autoMode: boolean;
  /** Current and last reachable story line, the slider's whole range. */
  declare ordinal: number;
  declare maximum: number;
  declare transportVisible: boolean;
  declare fullscreenActive: boolean;
  private loadedKey = "";
  private engine?: VegaEngine;
  private handle?: VegaPlayerHandle;
  private loadController?: AbortController;
  private continuousPlay = false;
  private sequenceListeners = new Set<() => void>();
  private stopCompletionObserver?: () => void;
  private completionEmitted = false;
  private transportFrame = 0;
  private scrubbing = false;
  private resumeAfterScrub = false;
  private pausedBeforeScrub = false;
  private viewportFullscreen = false;
  private fullscreenLayer?: HTMLElement;

  constructor() {
    super();
    this.story = {};
    this.server = "intl";
    this.locale = "ja";
    this.providerBase = "";
    this.phase = "loading";
    this.issue = "";
    this.autoMode = false;
    this.ordinal = 0;
    this.maximum = 0;
    this.transportVisible = false;
    this.fullscreenActive = false;
    try {
      this.continuousPlay = localStorage.getItem("haneoka:story-continuous") === "true";
    } catch {
      /* Playback remains available without persistent storage. */
    }
  }
  createRenderRoot() {
    return this;
  }
  connectedCallback() {
    super.connectedCallback();
    addEventListener("haneoka:locale-ready", this.onDocumentLocale);
    document.addEventListener("fullscreenchange", this.fullscreenChanged);
    void import("@material/web/slider/slider.js");
    this.requestUpdate();
  }
  disconnectedCallback() {
    removeEventListener("haneoka:locale-ready", this.onDocumentLocale);
    this.loadController?.abort();
    this.loadedKey = "";
    document.removeEventListener("fullscreenchange", this.fullscreenChanged);
    this.exitViewportFullscreen();
    void this.disposePlayer();
    super.disconnectedCallback();
  }
  updated() {
    if (!this.isConnected || !this.story?.storyId) return;
    const key = JSON.stringify([this.server, this.story.storyId, this.locale, this.providerBase]);
    if (key !== this.loadedKey) {
      this.loadedKey = key;
      void this.load();
    }
  }
  private onDocumentLocale = () => {
    const next = document.documentElement.dataset.locale || "";
    const known = ["ja", "en", "zh-TW", "zh-CN", "ko"];
    if (next && known.includes(next) && next !== this.locale) this.locale = next;
  };
  private async json(url: string, signal: AbortSignal) {
    const response = await fetch(url, { signal, headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return (await response.json()) as RecordValue;
  }
  private async load() {
    this.loadController?.abort();
    const controller = new AbortController();
    this.loadController = controller;
    const { signal } = controller;
    const story = this.story;
    const server = this.server;
    const locale = this.locale;
    const providerBase = this.providerBase;
    const active = () => !signal.aborted && this.isConnected && this.loadController === controller;
    const url = (resource: string, id = "") =>
      `/api/v1/servers/${encodeURIComponent(server)}/${resource}${id ? `/${encodeURIComponent(id)}` : ""}`;
    this.phase = "loading";
    this.issue = "";
    try {
      await this.disposePlayer();
      if (!active()) return;
      const assets = (story.assets as RecordValue | undefined) || {};
      const keys = (Array.isArray(assets.live2d) ? (assets.live2d as RecordValue[]) : [])
        .map((entry) => String(entry.live2dKey || ""))
        .filter(Boolean);
      const [runtime, live2d] = await Promise.all([
        providerBase ? Promise.resolve(story.runtime || {}) : this.json(url("story-runtime"), signal),
        providerBase
          ? keys.length
            ? this.json(
                `${providerBase}/live2d?projection=${encodeURIComponent(BESTDORI_CATALOG_VERSION)}&${keys.map((key) => `id=${encodeURIComponent(key)}`).join("&")}${story.sourceServer ? `&server=${encodeURIComponent(String(story.sourceServer))}` : ""}`,
                signal,
              ).then((payload) => keys.map((key) => (payload.items as RecordValue | undefined)?.[key] || {}))
            : []
          : Promise.all(keys.map((key) => this.json(url("live2d", key), signal))),
      ]);
      if (!active()) return;
      const hydrated = hydrateStoryPayload({
        ...story,
        assets: { ...assets, live2d: live2d.map((entry, index) => ({ id: keys[index], ...(entry as RecordValue) })) },
        runtime: resolveStoryRuntimeAssets(merge(runtime, story.runtime), server),
      }) as AdvStory;
      this.phase = "ready";
      await this.updateComplete;
      if (!active()) return;
      const mount = this.querySelector<HTMLElement>(".vega-story-runtime__mount");
      if (!mount) throw new Error("Vega player host is unavailable");
      const stage = this;
      const engine = createVega({
        plugins: [
          createVegaRichTextPlugin(),
          vegaPortableUiPlugin,
          vegaDefaultShell,
          createThreeRendererPlugin({ postTextureAssets: HANEOKA_POST_TEXTURE_ASSETS }),
          createCubismPlugin({ adapter: cubismAdapter() }),
          createHaneokaThemeAssetsPlugin({
            resolveSourceAsset: (path) => (/^(?:Assets|Packages)\//u.test(path) ? storySourceUrl(path, server) : ""),
          }),
          createHaneokaThemeHostPlugin(stage.themeHostAdapter()),
          createHaneokaStorySequencePlugin({
            get continuous() {
              return stage.continuousPlay;
            },
            toggleContinuous: () => {
              this.continuousPlay = !this.continuousPlay;
              try {
                localStorage.setItem("haneoka:story-continuous", String(this.continuousPlay));
              } catch {
                /* Keep the in-memory setting. */
              }
              for (const listener of this.sequenceListeners) listener();
            },
            interrupt: () => this.dispatchEvent(new CustomEvent("haneoka-story-interrupt", { bubbles: true })),
            subscribe: (listener) => {
              this.sequenceListeners.add(listener);
              return {
                dispose: () => {
                  this.sequenceListeners.delete(listener);
                },
              };
            },
          }),
          vegaHaneokaTheme,
        ],
      });
      this.engine = engine;
      signal.addEventListener(
        "abort",
        () => {
          void engine.dispose().catch(() => undefined);
        },
        { once: true },
      );
      const player = await engine.createPlayer({
        mount,
        story: hydrated,
        resolveLocalizedText: this.localizedTextResolver(locale),
        renderBackend: "vega-three-webgl2",
        theme: "haneoka",
        shell: {
          initialScreen: "game",
          projectId: `haneoka:${server}:${String(story.storyId)}`,
          settingsId: "haneoka:story-player",
          initialSettings: this.legacySettings(),
        },
      });
      if (!active()) {
        await engine.dispose();
        return;
      }
      this.handle = player;
      player.shell?.setSetting("uiLanguage", locale);
      player.shell?.resume();
      this.completionEmitted = false;
      this.startTransportLoop();
      const completion = () => {
        if (!active() || this.completionEmitted || !player.player.state.finished) return;
        this.completionEmitted = true;
        if (this.continuousPlay)
          this.dispatchEvent(
            new CustomEvent("haneoka-story-finished", {
              bubbles: true,
              detail: { storyId: String(story.storyId) },
            }),
          );
      };
      this.stopCompletionObserver = player.player.subscribePresentationObserver(completion);
      completion();
    } catch (error) {
      if (!active()) return;
      console.error(error);
      this.issue = error instanceof Error ? error.message : String(error);
      this.phase = "error";
      await this.disposePlayer();
    }
  }
  private legacySettings() {
    const defaults = { autoDelay: 0.5, bgmVolume: 1, voiceVolume: 1, seVolume: 1 };
    try {
      const value = JSON.parse(localStorage.getItem("haneoka:story-player:v1") || "null") as RecordValue | null;
      if (!value) return defaults;
      return {
        ...defaults,
        masterVolume: Number(value.volume ?? 1),
        bgmVolume: Number(value.volumeBgm ?? 1),
        bgmEnabled: value.bgmEnabled !== false,
        autoDelay: Number(value.autoPlayDelaySeconds ?? 0.5),
        instantText: Boolean(value.instantText),
        subtitlesEnabled: value.subtitlesEnabled !== false,
        textSize: Number(value.textSize ?? 1),
      };
    } catch {
      return defaults;
    }
  }
  private localizedTextResolver(locale: string) {
    return (value: unknown): StoryResolvedText => {
      const resolved = resolveLocalizedText(value, locale);
      return { text: resolved.text, lang: resolved.locale };
    };
  }

  /**
   * The port the site owns: with `externalPlaybackControls` the Haneoka theme
   * keeps its in-game menu but leaves the transport to this element, which
   * renders the shared playback footer the chart player uses.
   */
  private themeHostAdapter(): HaneokaThemeHost {
    const snapshot = (): HaneokaThemeHostSnapshot => {
      const player = this.handle?.player;
      const settings = this.handle?.shell?.snapshot().settings;
      const timeline = player?.currentSeekProgress() ?? { ratio: 0, label: "", ordinal: 0, maximum: 0 };
      return {
        autoAdvance: player?.state.autoPlay ?? false,
        autoAdvanceDisabled: !player?.state.ready,
        instantText: settings?.instantText ?? false,
        subtitlesEnabled: settings?.subtitlesEnabled ?? true,
        videoVisible: player?.state.video.visible ?? false,
        fullscreen: this.fullscreenActive,
        bgmEnabled: settings?.bgmEnabled ?? true,
        volume: settings?.masterVolume ?? 1,
        bgmVolume: settings?.bgmVolume ?? 1,
        autoPlayDelaySeconds: settings?.autoDelay ?? 0.5,
        maximumAutoPlayDelaySeconds: 30,
        textSize: settings?.textSize ?? 1,
        progress: timeline.ratio,
        progressEnabled: timeline.maximum > 0,
        progressLabel: timeline.label || undefined,
      };
    };
    return {
      externalPlaybackControls: true,
      snapshot,
      subscribe: (listener) => {
        const shell = this.handle?.shell;
        if (!shell) return { dispose() {} };
        const subscription = shell.subscribe(() => listener(snapshot()));
        return {
          dispose() {
            if (typeof subscription === "function") void subscription();
            else if ("dispose" in subscription) void subscription.dispose();
            else if ("destroy" in subscription) void subscription.destroy();
            else void subscription.close();
          },
        };
      },
      toggleAutoAdvance: () => this.handle?.player.toggleAuto(),
      setInstantText: (value) => this.handle?.shell?.setSetting("instantText", value),
      setSubtitlesEnabled: (value) => this.handle?.shell?.setSetting("subtitlesEnabled", value),
      setBgmEnabled: (value) => this.handle?.shell?.setSetting("bgmEnabled", value),
      setVolume: (value) => this.handle?.shell?.setSetting("masterVolume", value),
      setBgmVolume: (value) => this.handle?.shell?.setSetting("bgmVolume", value),
      setAutoPlayDelaySeconds: (value) => this.handle?.shell?.setSetting("autoDelay", value),
      setTextSize: (value) => this.handle?.shell?.setSetting("textSize", value),
      seekProgress: (value) => this.seekTransportRatio(value),
      skipCurrentVideo: () => this.handle?.player.skipCurrentVideo(),
      toggleFullscreen: () => void this.toggleFullscreen(),
    };
  }

  private ui(key: StoryTransportKey) {
    const index = Math.max(0, ["ja", "en", "zh-TW", "zh-CN", "ko"].indexOf(this.locale));
    return TRANSPORT_TEXT[key][index] || TRANSPORT_TEXT[key][1]!;
  }

  private startTransportLoop() {
    cancelAnimationFrame(this.transportFrame);
    const paint = () => {
      const handle = this.handle;
      if (!handle) return;
      const state = handle.player.state;
      const screen = handle.shell?.snapshot().screen ?? "game";
      const timeline = handle.player.currentSeekProgress();
      const visible = this.phase === "ready" && screen === "game" && !state.loading && state.ready;
      if (visible !== this.transportVisible) this.transportVisible = visible;
      if (state.autoPlay !== this.autoMode) this.autoMode = state.autoPlay;
      if (timeline.maximum !== this.maximum) this.maximum = timeline.maximum;
      if (!this.scrubbing && timeline.ordinal !== this.ordinal) this.ordinal = timeline.ordinal;
      this.transportFrame = requestAnimationFrame(paint);
    };
    this.transportFrame = requestAnimationFrame(paint);
  }

  private toggleAutoMode() {
    this.handle?.player.toggleAuto();
  }

  private seekTransportRatio(ratio: number) {
    const handle = this.handle;
    if (!handle) return;
    const target = handle.player.resolveSeekRatio(ratio);
    void handle.player.seekTo(target, { resume: false }).catch(() => undefined);
  }

  private previewTransportSeek(ordinal: number) {
    const handle = this.handle;
    if (!handle) return;
    const player = handle.player;
    const maximum = Math.max(1, this.maximum);
    const value = Math.max(0, Math.min(maximum, Math.round(ordinal)));
    this.scrubbing = true;
    if (!this.resumeAfterScrub) {
      this.resumeAfterScrub = player.state.playing && !player.state.paused;
      this.pausedBeforeScrub = player.state.paused;
    }
    player.pause();
    this.ordinal = value;
    this.seekTransportRatio(value / maximum);
  }

  private async commitTransportSeek(ordinal: number) {
    const handle = this.handle;
    if (!handle) return;
    const player = handle.player;
    const maximum = Math.max(1, this.maximum);
    const value = Math.max(0, Math.min(maximum, Math.round(ordinal)));
    this.scrubbing = false;
    try {
      await player.seekTo(player.resolveSeekRatio(value / maximum), { resume: false });
    } catch {
      /* A rejected target leaves the slider on the last reachable line. */
    }
    if (!handle.shell || handle.shell.snapshot().screen === "game") {
      if (!this.pausedBeforeScrub) player.resume();
      if (this.resumeAfterScrub) void player.play().catch(() => undefined);
    }
    this.resumeAfterScrub = false;
    this.pausedBeforeScrub = false;
  }

  /**
   * Native element fullscreen where WebKit allows it; on iOS Safari, which has
   * no element fullscreen at all, the detail pane expands over the viewport
   * instead (see [data-story-fullscreen] in story.css).
   */
  async toggleFullscreen() {
    if (typeof document.documentElement.requestFullscreen !== "function") {
      this.viewportFullscreen = !this.viewportFullscreen;
      if (this.viewportFullscreen) {
        this.fullscreenLayer = this.closest<HTMLElement>(".pane-layer") ?? undefined;
        this.fullscreenLayer?.setAttribute("data-story-fullscreen", "true");
      } else this.exitViewportFullscreen();
      this.syncFullscreenState();
      return;
    }
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else {
        await this.requestFullscreen();
        const orientation = screen.orientation as ScreenOrientation & {
          lock?: (mode: string) => Promise<void>;
        };
        await orientation.lock?.("landscape");
      }
    } catch {
      /* Fullscreen and orientation support depend on the host. */
    }
  }

  private exitViewportFullscreen() {
    if (!this.viewportFullscreen) return;
    this.viewportFullscreen = false;
    // The stage can already be disconnected (mode switch), so release the
    // pane captured on enter rather than searching the tree again.
    this.fullscreenLayer?.removeAttribute("data-story-fullscreen");
    this.fullscreenLayer = undefined;
    this.syncFullscreenState();
  }

  private fullscreenChanged = () => this.syncFullscreenState();

  private syncFullscreenState() {
    const active = this.viewportFullscreen || document.fullscreenElement === this;
    if (active === this.fullscreenActive) return;
    this.fullscreenActive = active;
    this.dispatchEvent(new CustomEvent("vega-story-fullscreen", { bubbles: true, detail: { active } }));
  }

  private async disposePlayer() {
    cancelAnimationFrame(this.transportFrame);
    this.stopCompletionObserver?.();
    this.stopCompletionObserver = undefined;
    const engine = this.engine;
    this.engine = undefined;
    this.handle = undefined;
    this.transportVisible = false;
    this.autoMode = false;
    this.ordinal = 0;
    this.maximum = 0;
    await engine?.dispose().catch(() => undefined);
  }
  render() {
    return html`
      <section class="vega-story-runtime">
        ${
          this.phase === "loading"
            ? html`
                ${loadingState(uiText(this.locale, "loading"))}
              `
            : ""
        }
        ${
          this.phase === "error"
            ? html`
                <div class="notice" role="alert"><p>${this.issue}</p></div>
              `
            : ""
        }
        <div class="vega-story-runtime__mount" ?hidden=${this.phase !== "ready"}></div>
        ${this.renderTransport()}
      </section>
    `;
  }
  /**
   * The shared playback footer (`.chart-runtime__controls` from catalog.css):
   * outside the letterboxed stage and always laid out, never scaled with the
   * game viewport. The lead button carries the chart player's play/pause
   * glyphs over the AUTO toggle — play while auto is off, pause while it is
   * on — and the slider scrubs the reachable-line timeline.
   */
  private renderTransport() {
    if (this.phase !== "ready") return nothing;
    const maximum = Math.max(0, this.maximum);
    return html`
      <footer class="chart-runtime__controls" ?hidden=${!this.transportVisible}>
        <button
          class="icon-button"
          type="button"
          aria-pressed=${this.autoMode}
          aria-label=${this.ui("auto")}
          .title=${this.ui("auto")}
          @click=${this.toggleAutoMode}
        >
          <svg class="material-icon" width="24" height="24">
            <use href=${`/icons.svg#${this.autoMode ? "pause" : "play_arrow"}`}></use>
          </svg>
        </button>
        <div class="chart-runtime__timeline">
          <small>${this.ordinal}</small>
          <md-slider
            class="md3-slider md3-slider--runtime"
            min="0"
            max=${maximum || 1}
            step="1"
            .value=${String(this.ordinal)}
            aria-label=${this.ui("storyProgress")}
            aria-valuetext=${`${this.ordinal} / ${maximum}`}
            ?disabled=${maximum < 1}
            @input=${(event: Event) =>
              this.previewTransportSeek(Number((event.target as HTMLElement & { value?: number }).value))}
            @change=${(event: Event) =>
              void this.commitTransportSeek(Number((event.target as HTMLElement & { value?: number }).value))}
          ></md-slider>
          <small>${maximum}</small>
        </div>
      </footer>
    `;
  }
}
if (!customElements.get("vega-story-stage")) customElements.define("vega-story-stage", VegaStoryStage);
