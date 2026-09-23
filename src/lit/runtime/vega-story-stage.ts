import { LitElement, html } from "lit";
import { uiText } from "../shared/catalog";
import { loadingState } from "../ui/state";
import { createVega, type AdvStory, type VegaEngine } from "@haneoka/vega/engine";
import type { StoryResolvedText } from "@haneoka/vega/runtime";
import type { CubismRuntimeAdapter } from "@haneoka/vega-plugin-cubism";
import { createCubismPlugin } from "@haneoka/vega-plugin-cubism";
import { hydrateStoryPayload } from "@haneoka/vega-plugin-haneoka";
import { createVegaRichTextPlugin } from "@haneoka/vega-plugin-richtext";
import { createThreeRendererPlugin } from "@haneoka/vega-renderer-three";
import { vegaDefaultShell } from "@haneoka/vega-shell-default";
import { vegaHaneokaTheme, HANEOKA_POST_TEXTURE_ASSETS } from "@haneoka/vega-theme-haneoka";
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
  };
  declare story: RecordValue;
  declare server: string;
  declare locale: string;
  declare providerBase: string;
  declare phase: "loading" | "ready" | "error";
  declare issue: string;
  private loadedKey = "";
  private engine?: VegaEngine;
  private loadController?: AbortController;

  constructor() {
    super();
    this.story = {};
    this.server = "intl";
    this.locale = "ja";
    this.providerBase = "";
    this.phase = "loading";
    this.issue = "";
  }
  createRenderRoot() {
    return this;
  }
  connectedCallback() {
    super.connectedCallback();
    this.requestUpdate();
  }
  disconnectedCallback() {
    this.loadController?.abort();
    this.loadedKey = "";
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
                `${providerBase}/live2d?${keys.map((key) => `id=${encodeURIComponent(key)}`).join("&")}`,
                signal,
              ).then((payload) => keys.map((key) => (payload.items as RecordValue | undefined)?.[key] || {}))
            : []
          : Promise.all(keys.map((key) => this.json(url("live2d", key), signal))),
      ]);
      if (!active()) return;
      const hydrated = hydrateStoryPayload({
        ...story,
        assets: { ...assets, live2d: live2d.map((entry, index) => ({ id: keys[index], ...(entry as RecordValue) })) },
        runtime: merge(runtime, story.runtime),
      }) as AdvStory;
      this.phase = "ready";
      await this.updateComplete;
      if (!active()) return;
      const mount = this.querySelector<HTMLElement>(".vega-story-runtime__mount");
      if (!mount) throw new Error("Vega player host is unavailable");
      const engine = createVega({
        plugins: [
          createVegaRichTextPlugin(),
          vegaPortableUiPlugin,
          vegaDefaultShell,
          createThreeRendererPlugin({ postTextureAssets: HANEOKA_POST_TEXTURE_ASSETS }),
          createCubismPlugin({ adapter: cubismAdapter() }),
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
      player.shell?.setSetting("uiLanguage", locale);
      player.shell?.resume();
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
    const languages = ["ja", "en", "zh-TW", "zh-CN", "ko"];
    const index = Math.max(0, languages.indexOf(locale));
    const resolve = (value: unknown): StoryResolvedText => {
      if (Array.isArray(value)) {
        for (const candidate of new Set([index, 0, ...value.map((_, ordinal) => ordinal)])) {
          const resolved = resolve(value[candidate]);
          if (resolved.text.trim()) return { text: resolved.text, lang: languages[candidate] || locale };
        }
        return { text: "" };
      }
      if (value && typeof value === "object") {
        const record = value as RecordValue;
        if (Array.isArray(record.values)) return resolve(record.values);
        for (const language of new Set([locale, ...languages])) {
          const candidate = record[language];
          if (typeof candidate === "string" && candidate.trim()) return { text: candidate, lang: language };
        }
        return resolve(record.text ?? record.value ?? "");
      }
      return { text: value == null ? "" : String(value), lang: locale };
    };
    return resolve;
  }
  private async disposePlayer() {
    const engine = this.engine;
    this.engine = undefined;
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
      </section>
    `;
  }
}
if (!customElements.get("vega-story-stage")) customElements.define("vega-story-stage", VegaStoryStage);
