import { BESTDORI_CATALOG_VERSION } from "@haneoka/bestdori/resources";
import { LitElement, html, nothing } from "lit";
import { ref } from "lit/directives/ref.js";
import { resolveStoryRuntimeAssets, storySourceUrl } from "../../lib/story-assets";
import { resolveLocalizedText } from "../../lib/localized-text";
import { beginLoading, prepareMaterialProgress, type LoadingMetrics } from "../../lib/loading-progress";
import { clientText } from "../../i18n/client";
import { relationships as jaRelationships } from "../../../public/i18n/ja.json";
import { relationships as enRelationships } from "../../../public/i18n/en.json";
import { relationships as zhTWRelationships } from "../../../public/i18n/zh-TW.json";
import { relationships as zhCNRelationships } from "../../../public/i18n/zh-CN.json";
import { relationships as koRelationships } from "../../../public/i18n/ko.json";
import { CUBISM_CORE_URLS, CUBISM_WEB_RUNTIME_URL } from "../../lib/cubism-runtime";
import { fetchJson, uiText } from "../shared/catalog";
import { PlaybackControlsController } from "../ui/playback-controls";
import { ViewportFullscreenController } from "./viewport-fullscreen";
import "@material/web/progress/linear-progress.js";
import {
  createVega,
  createVegaPlayerState,
  type AdvStory,
  type VegaEngine,
  type VegaPlayerHandle,
} from "@haneoka/vega/engine";
import type { StoryResolvedText } from "@haneoka/vega/runtime";
import { iterateAdvCommands } from "@haneoka/vega/renderer-kit";
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
const speakerNameJoiners: Readonly<Record<string, string>> = Object.freeze({
  ja: jaRelationships.speakerNameSeparator,
  en: enRelationships.speakerNameSeparator,
  "zh-TW": zhTWRelationships.speakerNameSeparator,
  "zh-CN": zhCNRelationships.speakerNameSeparator,
  ko: koRelationships.speakerNameSeparator,
});
type CubismProvision = {
  createCubismWebRuntimeAdapter(options: RecordValue): CubismRuntimeAdapter;
};

let provision: Promise<CubismProvision> | undefined;
const cubismAdapter = (): CubismRuntimeAdapter => {
  let resolved: CubismRuntimeAdapter | undefined;
  const runtime = async () => {
    provision ??= (
      import(/* @vite-ignore */ new URL(CUBISM_WEB_RUNTIME_URL, document.baseURI).href) as Promise<CubismProvision>
    ).catch((error: unknown) => {
      provision = undefined;
      throw error;
    });
    resolved ??= (await provision).createCubismWebRuntimeAdapter({
      id: "haneoka.web-cubism-runtime",
      runtime: CUBISM_CORE_URLS,
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

type StoryTransportKey =
  "auto" | "storyProgress" | "resources" | "preparing" | "sceneIndex" | "preparationTasks" | "collapse" | "expand";

export class VegaStoryStage extends LitElement {
  static properties = {
    story: { attribute: false },
    server: { type: String },
    locale: { type: String },
    providerBase: { type: String, attribute: "provider-base" },
    phase: { state: true },
    issue: { state: true },
    transportIssue: { state: true },
    autoMode: { state: true },
    ordinal: { state: true },
    maximum: { state: true },
    transportVisible: { state: true },
    fullscreenActive: { state: true },
    transportCollapsed: { state: true },
    started: { state: true },
  };
  declare story: RecordValue;
  declare server: string;
  declare locale: string;
  declare providerBase: string;
  declare phase: "loading" | "booting" | "ready" | "error";
  declare issue: string;
  declare transportIssue: string;
  /** AUTO advance, mirrored from the player for the transport button. */
  declare autoMode: boolean;
  /** Current and last reachable story line, the slider's whole range. */
  declare ordinal: number;
  declare maximum: number;
  declare transportVisible: boolean;
  declare fullscreenActive: boolean;
  declare transportCollapsed: boolean;
  declare started: boolean;
  private loadedKey = "";
  private appliedLocale = "";
  private engine?: VegaEngine;
  private handle?: VegaPlayerHandle;
  private playerState?: ReturnType<typeof createVegaPlayerState>;
  private bootStateTimer = 0;
  private loadController?: AbortController;
  private continuousPlay = false;
  private sequenceListeners = new Set<() => void>();
  private stopCompletionObserver?: () => void;
  private stopSpeakerLocaleObserver?: () => void;
  private completionEmitted = false;
  private transportFrame = 0;
  private scrubbing = false;
  private resumeAfterScrub = false;
  private transportSeekRevision = 0;
  private failedSeek?: { ordinal: number; resume: boolean };
  private viewportFullscreen: ViewportFullscreenController;
  private transportVisibility = new PlaybackControlsController((snapshot) => {
    this.transportCollapsed = snapshot.collapsed;
  });

  constructor() {
    super();
    this.story = {};
    this.server = "intl";
    this.locale = "ja";
    this.providerBase = "";
    this.phase = "loading";
    this.issue = "";
    this.transportIssue = "";
    this.autoMode = false;
    this.ordinal = 0;
    this.maximum = 0;
    this.transportVisible = false;
    this.fullscreenActive = false;
    this.transportCollapsed = false;
    this.started = false;
    this.viewportFullscreen = new ViewportFullscreenController({
      owner: this,
      onChange: () => this.syncFullscreenState(),
    });
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
    this.viewportFullscreen.dispose();
    this.transportVisibility.dispose();
    if (document.fullscreenElement === this && typeof document.exitFullscreen === "function") {
      void document.exitFullscreen().catch(() => undefined);
    }
    void this.disposePlayer().catch((error) => console.error("[vega-story] disconnected cleanup failed", error));
    super.disconnectedCallback();
  }
  updated() {
    this.transportVisibility.bind(this.querySelector<HTMLElement>(".playback-controls"));
    // Story controls occupy their own layout row. Explicit expansion persists
    // during fullscreen playback until the user collapses it from the menu.
    if (!this.isConnected || !this.story?.storyId) return;
    // The story/runtime and Live2D resource URLs do not vary by UI locale.
    // Keep one player alive when only the shell language changes; the resolver
    // below reads `this.locale` at call time for the core's locale fallback.
    const key = JSON.stringify([this.server, this.story.storyId, this.providerBase]);
    if (key !== this.loadedKey) {
      this.loadedKey = key;
      void this.load();
    } else if (this.handle && this.appliedLocale !== this.locale) {
      this.refreshPlayerLocale();
    }
  }
  private onDocumentLocale = () => {
    const next = document.documentElement.dataset.locale || "";
    const known = ["ja", "en", "zh-TW", "zh-CN", "ko"];
    if (next && known.includes(next) && next !== this.locale) this.locale = next;
  };
  private async load() {
    const continuePlayback = this.continuousPlay && this.started && this.handle?.player.state.finished;
    this.started = false;
    this.loadController?.abort();
    const controller = new AbortController();
    this.loadController = controller;
    const { signal } = controller;
    const story = this.story;
    const server = this.server;
    const providerBase = this.providerBase;
    const active = () => !signal.aborted && this.isConnected && this.loadController === controller;
    const url = (resource: string, id = "") =>
      `/api/v1/servers/${encodeURIComponent(server)}/${resource}${id ? `/${encodeURIComponent(id)}` : ""}`;
    let loadingReporter = beginLoading(uiText(this.locale, "loading"), { signal });
    let hadCountedProgress = false;
    loadingReporter.update({ stageLabel: this.ui("resources") });
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
        providerBase ? Promise.resolve(story.runtime || {}) : fetchJson<RecordValue>(url("story-runtime"), { signal }),
        providerBase
          ? keys.length
            ? fetchJson<RecordValue>(
                `${providerBase}/live2d?projection=${encodeURIComponent(BESTDORI_CATALOG_VERSION)}&${keys.map((key) => `id=${encodeURIComponent(key)}`).join("&")}${story.sourceServer ? `&server=${encodeURIComponent(String(story.sourceServer))}` : ""}`,
                { signal },
              ).then((payload) => keys.map((key) => (payload.items as RecordValue | undefined)?.[key] || {}))
            : []
          : Promise.all(keys.map((key) => fetchJson<RecordValue>(url("live2d", key), { signal }))),
      ]);
      if (!active()) return;
      const resolvedRuntime = resolveStoryRuntimeAssets(merge(runtime, story.runtime), server);
      if (matchMedia("(pointer: coarse)").matches) {
        // Bound speculative residency; the renderer still protects every visible actor.
        Object.assign(resolvedRuntime, {
          characterPreloadInitialCount: 2,
          characterPreloadCacheMax: 4,
          textureCacheMegabytes: 128,
        });
      }
      const hydrated = hydrateStoryPayload({
        ...story,
        assets: { ...assets, live2d: live2d.map((entry, index) => ({ id: keys[index], ...(entry as RecordValue) })) },
        runtime: resolvedRuntime,
      }) as AdvStory;
      const preparationPlan: Array<{
        index: number;
        category: "Voice" | "Se";
        sound: NonNullable<NonNullable<AdvStory["commands"]>[number]["se"]>;
      }> = [];
      for (const [index, root] of (hydrated.commands ?? []).entries()) {
        for (const command of iterateAdvCommands([root])) {
          for (const sound of command.voices ?? []) preparationPlan.push({ index, category: "Voice", sound });
          for (const sound of [command.se, command.chatSound]) {
            if (sound?.playableUrl) preparationPlan.push({ index, category: "Se", sound });
          }
        }
      }
      if (hydrated.runtime) {
        Object.assign(hydrated.runtime, { audio: { ...hydrated.runtime.audio, preparationPlan } });
      }
      this.phase = "booting";
      this.playerState = createVegaPlayerState();
      this.playerState.paused = true;
      loadingReporter.update({ stageLabel: this.bootStageLabel() });
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
          void engine.dispose().catch((error) => console.error("[vega-story] aborted boot cleanup failed", error));
        },
        { once: true },
      );
      const playerState = this.playerState;
      if (!playerState) throw new Error("Vega player state is unavailable");
      const updateBootProgress = () => {
        const { done, total, determinate, stageLabel } = this.bootProgress();
        // A new CPU-only phase has no resource denominator. Retire the old
        // reporter so its completed counters cannot leave a false 100%.
        if (!determinate && hadCountedProgress) {
          loadingReporter.cancel();
          loadingReporter = beginLoading(uiText(this.locale, "loading"), { signal });
        }
        hadCountedProgress = determinate;
        const metrics: LoadingMetrics = {
          stageLabel,
          countLabel: this.ui("preparationTasks"),
          processedTasks: done,
          ...(determinate ? { totalTasks: total } : {}),
        };
        loadingReporter.update(metrics);
      };
      this.startBootStateObserver(playerState, active, updateBootProgress);
      const player = await engine.createPlayer({
        mount,
        story: hydrated,
        state: playerState,
        resolveLocalizedText: this.localizedTextResolver(),
        displayNameJoiner: this.speakerNameJoiner(),
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
        await engine.dispose().catch((error) => console.error("[vega-story] stale boot cleanup failed", error));
        return;
      }
      this.stopBootStateObserver();
      this.handle = player;
      player.player.runtime.displayNameJoiner = this.speakerNameJoiner();
      const speakerLocaleSubscription = player.shell?.subscribe(({ settings }) => {
        const separator = this.speakerNameJoiner(settings.uiLanguage === "auto" ? this.locale : settings.uiLanguage);
        if (player.player.runtime.displayNameJoiner === separator) return;
        player.player.runtime.displayNameJoiner = separator;
        player.player.setLocale(settings.language, { refresh: true });
      });
      this.stopSpeakerLocaleObserver = speakerLocaleSubscription
        ? () => {
            if (typeof speakerLocaleSubscription === "function") void speakerLocaleSubscription();
            else if ("dispose" in speakerLocaleSubscription) void speakerLocaleSubscription.dispose();
            else if ("destroy" in speakerLocaleSubscription) void speakerLocaleSubscription.destroy();
            else void speakerLocaleSubscription.close();
          }
        : undefined;
      player.shell?.setSetting("uiLanguage", this.locale);
      player.player.setLocale(this.locale, { refresh: true });
      this.appliedLocale = this.locale;
      loadingReporter.finish();
      this.phase = "ready";
      if (continuePlayback) this.startPlayback();
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
      if (!active()) {
        if (!(error instanceof Error && error.name === "AbortError"))
          console.error("[vega-story] superseded boot failed", error);
        return;
      }
      console.error(error);
      this.issue = error instanceof Error ? error.message : String(error);
      loadingReporter.fail(error);
      this.phase = "error";
      await this.disposePlayer().catch((error) => console.error("[vega-story] failed boot cleanup failed", error));
    }
  }

  private refreshPlayerLocale() {
    const player = this.handle;
    if (!player) return;
    player.player.runtime.displayNameJoiner = this.speakerNameJoiner();
    player.shell?.setSetting("uiLanguage", this.locale);
    player.player.setLocale(this.locale, { refresh: true });
    this.appliedLocale = this.locale;
    this.requestUpdate();
  }
  private speakerNameJoiner(locale = this.locale): string {
    // Display punctuation follows the UI even when dialogue falls back to
    // another content language. Keep the authored target delimiter intact.
    return speakerNameJoiners[locale] ?? enRelationships.speakerNameSeparator;
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
  private localizedTextResolver() {
    const sourceLocales: Record<string, string> = { jp: "ja", en: "en", tw: "zh-TW", cn: "zh-CN", kr: "ko" };
    const sourceLocale = this.providerBase
      ? (typeof this.story.sourceLocale === "string" ? this.story.sourceLocale.trim() : "") ||
        sourceLocales[String(this.story.sourceServer || "").toLowerCase()]
      : undefined;
    return (value: unknown): StoryResolvedText => {
      const resolved = resolveLocalizedText(value, this.locale, sourceLocale);
      return { text: resolved.text, lang: resolved.locale };
    };
  }

  private startBootStateObserver(
    state: ReturnType<typeof createVegaPlayerState>,
    active: () => boolean,
    updateProgress: () => void,
  ) {
    this.stopBootStateObserver();
    this.playerState = state;
    const update = () => {
      if (!active() || this.phase !== "booting" || this.playerState !== state) {
        this.bootStateTimer = 0;
        return;
      }
      // The state object is created by this host and passed through the public
      // engine option; this observes owned preload state, not engine internals.
      this.requestUpdate();
      updateProgress();
      this.bootStateTimer = window.setTimeout(update, 100);
    };
    this.bootStateTimer = window.setTimeout(update, 0);
  }

  private stopBootStateObserver() {
    if (this.bootStateTimer) window.clearTimeout(this.bootStateTimer);
    this.bootStateTimer = 0;
  }

  private bootLoadingLabel() {
    return [uiText(this.locale, "loading"), this.bootStageLabel()].filter(Boolean).join(" · ");
  }

  private bootProgress() {
    const preload = this.playerState?.preload;
    const rawDone = Number(preload?.done);
    const rawTotal = Number(preload?.total);
    const done = Number.isFinite(rawDone) && rawDone >= 0 ? Math.floor(rawDone) : 0;
    const total = Number.isFinite(rawTotal) && rawTotal > 0 ? Math.floor(rawTotal) : 0;
    const stage = String(preload?.label || "").trim();
    const stageLabel = stage === "scene index" ? this.ui("sceneIndex") : stage ? this.ui("resources") : "";
    return {
      done,
      total,
      determinate: total > 0 && done <= total,
      stageLabel: [this.ui("preparing"), stageLabel].filter(Boolean).join(" · "),
    };
  }

  private bootStageLabel() {
    const { done, total, stageLabel } = this.bootProgress();
    const count =
      total > 0
        ? `${done}/${total} ${this.ui("preparationTasks")}`
        : done > 0
          ? `${done} ${this.ui("preparationTasks")}`
          : "";
    return [stageLabel, count].filter(Boolean).join(" · ");
  }

  /**
   * The port the site owns: with `externalPlaybackControls` the Haneoka theme
   * keeps its in-game menu but leaves the transport to this element, which
   * renders the shared playback footer the chart player uses.
   */
  private themeHostAdapter(): HaneokaThemeHost {
    const snapshot = (): HaneokaThemeHostSnapshot => {
      const player = this.handle?.player;
      const shell = this.handle?.shell;
      const settings = shell?.currentSettings ?? shell?.snapshot().settings;
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
        playbackControlsVisible: this.transportVisible && !this.transportCollapsed,
      };
    };
    return {
      externalPlaybackControls: true,
      setPlaybackControlsVisible: (visible) => {
        if (visible) this.transportVisibility.expand();
        else this.transportVisibility.collapse();
      },
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
      toggleAutoAdvance: () => {
        if (!this.started) this.startPlayback();
        this.handle?.player.toggleAuto();
      },
      setInstantText: (value) => this.handle?.shell?.setSetting("instantText", value),
      setSubtitlesEnabled: (value) => this.handle?.shell?.setSetting("subtitlesEnabled", value),
      setBgmEnabled: (value) => this.handle?.shell?.setSetting("bgmEnabled", value),
      setVolume: (value) => this.handle?.shell?.setSetting("masterVolume", value),
      setBgmVolume: (value) => this.handle?.shell?.setSetting("bgmVolume", value),
      setAutoPlayDelaySeconds: (value) => this.handle?.shell?.setSetting("autoDelay", value),
      setTextSize: (value) => this.handle?.shell?.setSetting("textSize", value),
      seekProgress: (value) => void this.commitTransportSeek(value * this.maximum),
      skipCurrentVideo: () => this.handle?.player.skipCurrentVideo(),
      toggleFullscreen: () => void this.toggleFullscreen(),
    };
  }

  private ui(key: StoryTransportKey) {
    if (key === "collapse" || key === "expand") return uiText(this.locale, key);
    return clientText(this.locale, `story.${key}`, key);
  }

  private collapseTransport = () => {
    this.transportVisibility.collapse();
    void this.updateComplete.then(() => this.querySelector<HTMLElement>(".haneoka-menu-entry")?.focus());
  };

  private startTransportLoop() {
    cancelAnimationFrame(this.transportFrame);
    const paint = () => {
      const handle = this.handle;
      if (!handle) return;
      const state = handle.player.state;
      if (state.ready) {
        const sounds = handle.player.SoundManager as typeof handle.player.SoundManager & {
          prepareForCommand?(index: number): void;
        };
        sounds.prepareForCommand?.(state.commandIndex);
      }
      if (state.playing && !this.started) this.started = true;
      const shell = handle.shell;
      const screen = shell?.currentScreen ?? shell?.snapshot().screen ?? "game";
      const timeline = handle.player.currentSeekProgress();
      const visible = this.phase === "ready" && screen === "game" && !state.loading && state.ready;
      this.transportVisibility.setPlaying(Boolean(state.playing && !state.paused));
      if (visible !== this.transportVisible) this.transportVisible = visible;
      if (state.autoPlay !== this.autoMode) this.autoMode = state.autoPlay;
      if (timeline.maximum !== this.maximum) this.maximum = timeline.maximum;
      if (!this.scrubbing && timeline.ordinal !== this.ordinal) this.ordinal = timeline.ordinal;
      this.transportFrame = requestAnimationFrame(paint);
    };
    this.transportFrame = requestAnimationFrame(paint);
  }

  private startPlayback = () => {
    if (!this.handle || this.phase !== "ready") return;
    this.started = true;
    this.handle.shell?.resume();
  };

  private toggleAutoMode() {
    if (!this.started) {
      this.startPlayback();
      return;
    }
    if (this.handle && !this.handle.player.state.playing) this.handle.shell?.resume();
    this.handle?.player.toggleAuto();
  }

  private seekTransportRatio(ratio: number) {
    const handle = this.handle;
    if (!handle) return;
    try {
      const target = handle.player.resolveSeekRatio(ratio);
      // A rejected seek degrades to a no-op: playback never surfaces an error
      // panel mid-episode, the transport simply keeps its previous position.
      void handle.player.seekTo(target, { resume: false }).catch((error) => {
        console.warn("[vega-story] seek failed; keeping the current position", error);
      });
    } catch (error) {
      console.warn("[vega-story] seek rejected; keeping the current position", error);
    }
  }

  private previewTransportSeek(ordinal: number) {
    const handle = this.handle;
    if (!handle) return;
    this.transportSeekRevision++;
    const player = handle.player;
    const maximum = Math.max(1, this.maximum);
    const value = Math.max(0, Math.min(maximum, Math.round(ordinal)));
    const wasScrubbing = this.scrubbing;
    this.scrubbing = true;
    this.transportVisibility.setScrubbing(true);
    if (!wasScrubbing) {
      this.resumeAfterScrub = player.state.playing && !player.state.paused;
    }
    player.pause();
    this.ordinal = value;
    this.seekTransportRatio(value / maximum);
  }

  private async commitTransportSeek(ordinal: number) {
    const handle = this.handle;
    if (!handle) return;
    const player = handle.player;
    const revision = ++this.transportSeekRevision;
    this.transportIssue = "";
    this.failedSeek = undefined;
    // A change-only interaction has the same ownership as a pointer preview.
    if (!this.scrubbing) {
      this.resumeAfterScrub = player.state.playing && !player.state.paused;
      this.scrubbing = true;
      this.transportVisibility.setScrubbing(true);
      player.pause();
    }
    const maximum = Math.max(1, this.maximum);
    const value = Math.max(0, Math.min(maximum, Math.round(ordinal)));
    try {
      await player.seekTo(player.resolveSeekRatio(value / maximum), { resume: false });
      if (this.handle !== handle || !this.isConnected || revision !== this.transportSeekRevision) return;
    } catch (error) {
      if (this.handle !== handle || !this.isConnected || revision !== this.transportSeekRevision) return;
      // Core restores the previous checkpoint after a failed target. Keep its
      // canvas mounted and offer a retry of the requested line and play intent.
      this.transportIssue = error instanceof Error ? error.message : String(error);
      this.failedSeek = { ordinal: value, resume: this.resumeAfterScrub };
      this.resumeAfterScrub = false;
    }
    if (this.resumeAfterScrub && player.state.ready && (!handle.shell || handle.shell.snapshot().screen === "game")) {
      player.resume();
      void player.play().catch(() => undefined);
    }
    this.resumeAfterScrub = false;
    this.scrubbing = false;
    this.transportVisibility.setScrubbing(false);
  }

  private retryTransportSeek = () => {
    const failed = this.failedSeek;
    const player = this.handle?.player;
    if (!failed || !player) return;
    this.scrubbing = true;
    this.resumeAfterScrub = failed.resume;
    this.transportVisibility.setScrubbing(true);
    player.pause();
    void this.commitTransportSeek(failed.ordinal);
  };

  /**
   * Native element fullscreen where WebKit allows it; on iOS Safari, which has
   * no element fullscreen at all, the detail pane expands over the viewport
   * instead (see [data-story-fullscreen] in story.css).
   */
  async toggleFullscreen(): Promise<boolean> {
    if (this.viewportFullscreen.isActive()) return this.viewportFullscreen.exit();
    if (document.fullscreenElement) return this.exitNativeFullscreen();

    if (
      typeof document.documentElement.requestFullscreen !== "function" ||
      typeof this.requestFullscreen !== "function"
    ) {
      return this.viewportFullscreen.enter();
    }

    try {
      await this.requestFullscreen();
    } catch {
      // Some WebKit/embedded hosts expose the method but reject the element.
      // Only enter the pane fallback when native fullscreen is truly absent.
      if (!document.fullscreenElement) return this.viewportFullscreen.enter();
      return this.syncFullscreenState();
    }

    // Orientation is a hint. A failure here must not undo a native fullscreen
    // session that the browser has already granted.
    try {
      const orientation = globalThis.screen?.orientation as
        (ScreenOrientation & { lock?: (mode: string) => Promise<void> }) | undefined;
      await orientation?.lock?.("landscape");
    } catch {
      /* Native fullscreen remains usable when the host declines the hint. */
    }
    return this.syncFullscreenState();
  }

  private async exitNativeFullscreen(): Promise<boolean> {
    if (typeof document.exitFullscreen !== "function") {
      this.syncFullscreenState();
      return true;
    }
    try {
      await document.exitFullscreen();
    } catch {
      // The browser still owns the native fullscreen session. Report that
      // state to callers so the exit control remains actionable.
      this.syncFullscreenState();
      return true;
    }
    return this.syncFullscreenState();
  }

  private fullscreenChanged = () => this.syncFullscreenState();

  private syncFullscreenState(): boolean {
    const active = this.viewportFullscreen.isActive() || document.fullscreenElement === this;
    if (active === this.fullscreenActive) return active;
    this.fullscreenActive = active;
    this.dispatchEvent(new CustomEvent("vega-story-fullscreen", { bubbles: true, detail: { active } }));
    return active;
  }

  private async disposePlayer() {
    this.transportSeekRevision++;
    this.scrubbing = false;
    this.resumeAfterScrub = false;
    this.failedSeek = undefined;
    this.transportIssue = "";
    cancelAnimationFrame(this.transportFrame);
    this.stopBootStateObserver();
    this.stopCompletionObserver?.();
    this.stopCompletionObserver = undefined;
    this.stopSpeakerLocaleObserver?.();
    this.stopSpeakerLocaleObserver = undefined;
    const engine = this.engine;
    const handle = this.handle;
    this.engine = undefined;
    this.handle = undefined;
    this.transportVisible = false;
    this.autoMode = false;
    this.transportVisibility.setPlaying(false);
    this.transportVisibility.setScrubbing(false);
    this.ordinal = 0;
    this.maximum = 0;
    this.playerState = undefined;
    this.appliedLocale = "";
    // Engine finalizers dispose UI before the player. Start the player's
    // idempotent teardown independently so a slow UI/plugin finalizer cannot
    // retain episode file leases, decoded audio or model resources.
    const playerDisposal = Promise.resolve().then(() => handle?.player.dispose({ releaseTextures: true }));
    const engineDisposal = Promise.resolve().then(() => engine?.dispose());
    const results = await Promise.allSettled([playerDisposal, engineDisposal]);
    const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
    if (errors.length) throw new AggregateError(errors, "Failed to dispose Vega story player");
  }

  private retryPlayer = () => {
    if (!this.isConnected) return;
    void this.load();
  };

  render() {
    const { done, total, determinate } = this.bootProgress();
    const loadingLabel = this.bootLoadingLabel();
    return html`
      <section
        class="vega-story-runtime"
        data-phase=${this.phase}
        aria-busy=${this.phase === "loading" || this.phase === "booting" ? "true" : "false"}
      >
        ${
          this.phase === "loading" || this.phase === "booting"
            ? html`
                <div class="vega-story-runtime__loading">
                  <div class="state">
                    <md-linear-progress
                      style="inline-size: 100%"
                      ${ref(prepareMaterialProgress)}
                      ?indeterminate=${!determinate}
                      value=${determinate ? done / total : nothing}
                      aria-label=${loadingLabel}
                      aria-valuetext=${loadingLabel}
                    ></md-linear-progress>
                    <span class="state__body" role="status">${loadingLabel}</span>
                  </div>
                </div>
              `
            : ""
        }
        ${
          this.phase === "error"
            ? html`
                <div class="vega-story-runtime__error">
                  <div class="notice" role="alert">
                    <p>${this.issue}</p>
                    <button class="button button--tonal" type="button" @click=${this.retryPlayer}>
                      ${uiText(this.locale, "retry")}
                    </button>
                  </div>
                </div>
              `
            : ""
        }
        <div
          class="vega-story-runtime__mount"
          aria-busy=${this.phase === "loading" || this.phase === "booting" ? "true" : "false"}
          @click=${(event: MouseEvent) => {
            if (!this.started && !(event.target as Element)?.closest("button, input, select, a, [role=button]"))
              this.startPlayback();
          }}
        ></div>
        ${
          this.phase === "ready" && !this.started
            ? html`
                <div class="vega-story-runtime__start">
                  <button class="button button--tonal" type="button" @click=${this.startPlayback}>
                    <svg class="material-icon" width="24" height="24" aria-hidden="true">
                      <use href="/icons.svg#play_arrow"></use>
                    </svg>
                    ${uiText(this.locale, "play")}
                  </button>
                </div>
              `
            : nothing
        }
        ${this.renderTransport()}
        ${
          this.phase === "ready" && this.transportIssue
            ? html`
                <div class="vega-story-runtime__transport-error" role="alert">
                  <p>${this.transportIssue}</p>
                  <button class="button button--tonal" type="button" @click=${this.retryTransportSeek}>
                    ${uiText(this.locale, "retry")}
                  </button>
                </div>
              `
            : nothing
        }
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
      <footer
        class="chart-runtime__controls playback-controls"
        ?hidden=${!this.transportVisible || this.transportCollapsed}
        data-collapsed=${this.transportCollapsed ? "true" : "false"}
        aria-label=${uiText(this.locale, "morePlaybackControls")}
      >
        <div
          class="playback-controls__expanded"
          ?inert=${this.transportCollapsed}
          aria-hidden=${this.transportCollapsed}
        >
          <button
            class="icon-button"
            type="button"
            aria-pressed=${this.started ? this.autoMode : nothing}
            aria-label=${this.started ? this.ui("auto") : uiText(this.locale, "play")}
            .title=${this.started ? this.ui("auto") : uiText(this.locale, "play")}
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
              .value=${this.ordinal}
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
          <div class="chart-runtime__actions">
            <button
              class="icon-button"
              type="button"
              aria-pressed=${this.fullscreenActive}
              aria-label=${uiText(this.locale, this.fullscreenActive ? "fullscreenExit" : "fullscreen")}
              title=${uiText(this.locale, this.fullscreenActive ? "fullscreenExit" : "fullscreen")}
              @click=${() => void this.toggleFullscreen()}
            >
              <svg class="material-icon" width="20" height="20">
                <use href=${`/icons.svg#${this.fullscreenActive ? "fullscreen_exit" : "fullscreen"}`}></use>
              </svg>
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
    `;
  }
}
if (!customElements.get("vega-story-stage")) customElements.define("vega-story-stage", VegaStoryStage);
