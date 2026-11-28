// L3 — GEB
// Input: A hosted Vega player, the site's control labels and scoped presentation assets.
// Output: The site's story transport and render settings inside the standalone Haneoka theme.
// Pos: [Map](L2-2.md)；官网剧情嵌入的共享控件接入。
// Effects/Dependencies: Mounts and disposes controls, subscribes to render preferences and handles fullscreen.
import { html, nothing, render } from "lit";
import { createDefaultShellPlugin } from "@haneoka/vega-shell-default";
import { createHaneokaThemeHostPlugin, type HaneokaThemeHostSnapshot } from "@haneoka/vega-theme-haneoka";
import { renderStoryTransport, type StoryTransportOptions } from "../shared/story-transport";
import { RenderQualitySettings } from "../ui/render-quality-settings";
import { applyRenderQuality, observeRenderQuality } from "../../lib/render-quality";
import type { VegaPlayerHandle } from "@haneoka/vega/web";
import type { StoryEmbedPresentation } from "../../../packages/embed-vega/src/types";

type Labels = StoryTransportOptions["labels"] & { rendering: Record<string, string> };
const SVG = "http://www.w3.org/2000/svg";
let sequence = 0;

export function hostedStoryPresentation(css: string, symbols: string, messages: Record<string, Labels>): StoryEmbedPresentation {
  return (frame, viewport, locale) => {
    frame.classList.add("haneoka-story-embed");
    frame.dataset.seed = "haneoka";
    viewport.style.position = "relative";
    viewport.style.inset = "auto";
    const doc = frame.ownerDocument, view = doc.defaultView!;
    const prefix = `haneoka-embed-story-${++sequence}-`;
    const iconHref = (name: string) => `#${prefix}${name}`;
    const style = doc.createElement("style");
    style.textContent = css;
    const sprite = doc.createElementNS(SVG, "svg");
    sprite.setAttribute("aria-hidden", "true");
    sprite.style.cssText = "position:absolute;width:0;height:0;overflow:hidden;";
    const parsed = new DOMParser().parseFromString(`<svg xmlns="${SVG}">${symbols}</svg>`, "image/svg+xml");
    for (const source of parsed.documentElement.children) {
      const symbol = doc.importNode(source, true);
      symbol.id = prefix + symbol.id;
      sprite.append(symbol);
    }
    const controls = doc.createElement("div");
    controls.className = "haneoka-story-embed__controls";
    frame.append(style, sprite, controls);
    let handle: VegaPlayerHandle | undefined, started = false, collapsed = false;
    let seekRevision = 0, seekOrdinal: number | undefined, resumeAfterSeek = false;
    let lastRender = "";
    const listeners = new Set<(state: HaneokaThemeHostSnapshot) => void>();
    const setting = () => handle?.shell?.currentSettings ?? handle?.shell?.snapshot().settings;
    const activeLocale = () => setting()?.uiLanguage ?? locale;
    const labels = () => messages[activeLocale()] ?? messages[locale] ?? messages.en!;
    const fullscreen = () => doc.fullscreenElement === frame || frame.hasAttribute("data-app-fullscreen");
    const progress = () => handle?.player.currentSeekProgress() ?? { ordinal: 0, maximum: 0, ratio: 0, label: "" };
    const snapshot = (): HaneokaThemeHostSnapshot => {
      const player = handle?.player, settings = setting(), timeline = progress();
      return {
        autoAdvance: player?.state.autoPlay ?? false, autoAdvanceDisabled: !player?.state.ready,
        instantText: settings?.instantText ?? false, subtitlesEnabled: settings?.subtitlesEnabled ?? true,
        videoVisible: player?.state.video.visible ?? false, fullscreen: fullscreen(),
        bgmEnabled: settings?.bgmEnabled ?? true, volume: settings?.masterVolume ?? 1, bgmVolume: settings?.bgmVolume ?? 1,
        autoPlayDelaySeconds: settings?.autoDelay ?? 0.5, maximumAutoPlayDelaySeconds: 30, textSize: settings?.textSize ?? 1,
        progress: timeline.ratio, progressEnabled: timeline.maximum > 0, progressLabel: timeline.label || undefined,
        playbackControlsVisible: !collapsed,
      };
    };
    const media = view.matchMedia("(prefers-color-scheme: dark)");
    const applyTheme = () => {
      const theme = doc.documentElement.dataset.theme;
      frame.dataset.theme = theme === "light" || theme === "dark" ? theme : media.matches ? "dark" : "light";
    };
    const toggleFullscreen = async () => {
      if (doc.fullscreenElement === frame) await doc.exitFullscreen();
      else if (frame.hasAttribute("data-app-fullscreen")) frame.removeAttribute("data-app-fullscreen");
      else {
        try {
          if (frame.requestFullscreen) await frame.requestFullscreen();
          else frame.setAttribute("data-app-fullscreen", "");
        } catch {
          frame.setAttribute("data-app-fullscreen", "");
        }
      }
      update();
    };
    const start = () => {
      if (!handle) return;
      started = true;
      handle.shell?.resume();
      update();
    };
    const seek = async (ordinal: number, commit: boolean) => {
      const player = handle?.player;
      if (!player) return;
      const revision = ++seekRevision;
      if (seekOrdinal === undefined) resumeAfterSeek = player.state.playing && !player.state.paused;
      seekOrdinal = ordinal;
      player.pause();
      update();
      try {
        await player.seekTo(player.resolveSeekRatio(ordinal / Math.max(1, progress().maximum)), { resume: false });
        if (commit && revision === seekRevision && handle) player.holdRestoredDialogue();
      } catch (error) {
        console.warn("[embed-vega] story seek failed", error);
      } finally {
        if (commit && revision === seekRevision && handle) {
          if (resumeAfterSeek) player.resume();
          seekOrdinal = undefined;
          update();
        }
      }
    };
    const update = () => {
      const player = handle?.player;
      if (!player) return;
      if (player.state.playing) started = true;
      const state = snapshot(), timeline = progress(), text = labels();
      const ordinal = seekOrdinal ?? timeline.ordinal;
      const screen = handle?.shell?.currentScreen ?? handle?.shell?.snapshot().screen ?? "game";
      const visible = screen === "game" && player.state.ready && !player.state.loading;
      const signature = JSON.stringify([state, started, player.state.finished, visible, ordinal, timeline.maximum, activeLocale()]);
      if (signature === lastRender) return;
      lastRender = signature;
      render(renderStoryTransport({
        visible, collapsed, started, completed: player.state.finished, auto: state.autoAdvance,
        fullscreen: state.fullscreen, ordinal, maximum: timeline.maximum, labels: text, iconHref,
        onPlay: () => {
          if (player.state.finished) void handle?.shell?.start();
          else if (!started) start();
          else {
            if (!player.state.playing) handle?.shell?.resume();
            player.toggleAuto();
          }
        },
        onPreviewSeek: (value) => void seek(value, false),
        onSeek: (value) => void seek(value, true),
        onFullscreen: () => void toggleFullscreen(),
        onCollapse: () => { collapsed = true; update(); frame.querySelector<HTMLElement>(".haneoka-menu-entry")?.focus(); },
      }), controls);
      render(!started ? html`
        <button class="button button--tonal" type="button" @click=${start}>
          <svg class="material-icon" width="24" height="24" aria-hidden="true"><use href=${iconHref("play_arrow")}></use></svg>
          ${text.play}
        </button>
      ` : nothing, starter);
      for (const listener of listeners) listener(state);
    };
    const starter = doc.createElement("div");
    starter.className = "vega-story-runtime__start";
    frame.append(starter);
    return {
      plugins: [
        createDefaultShellPlugin({
          displaySettings(host) {
            const settings = doc.createElement("render-quality-settings") as RenderQualitySettings;
            settings.story = true;
            settings.locale = host.closest<HTMLElement>(".vega-shell")?.lang || locale;
            settings.labels = messages[settings.locale]?.rendering ?? labels().rendering;
            host.append(settings);
            return () => settings.remove();
          },
        }),
        createHaneokaThemeHostPlugin({
          externalPlaybackControls: true,
          setPlaybackControlsVisible: (visible) => { collapsed = !visible; update(); },
          snapshot,
          subscribe(listener) {
            listeners.add(listener);
            return { dispose: () => { listeners.delete(listener); } };
          },
          toggleAutoAdvance() { if (!started) start(); handle?.player.toggleAuto(); update(); },
          setInstantText: (value) => handle?.shell?.setSetting("instantText", value),
          setSubtitlesEnabled: (value) => handle?.shell?.setSetting("subtitlesEnabled", value),
          setBgmEnabled: (value) => handle?.shell?.setSetting("bgmEnabled", value),
          setVolume: (value) => handle?.shell?.setSetting("masterVolume", value),
          setBgmVolume: (value) => handle?.shell?.setSetting("bgmVolume", value),
          setAutoPlayDelaySeconds: (value) => handle?.shell?.setSetting("autoDelay", value),
          setTextSize: (value) => handle?.shell?.setSetting("textSize", value),
          seekProgress: (value) => void seek(Math.round(value * progress().maximum), true),
          skipCurrentVideo: () => handle?.player.skipCurrentVideo(),
          toggleFullscreen,
        }),
      ],
      mount(player) {
        handle = player;
        const themeObserver = new MutationObserver(applyTheme);
        themeObserver.observe(doc.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
        media.addEventListener("change", applyTheme);
        doc.addEventListener("fullscreenchange", update);
        applyTheme();
        const stopQuality = observeRenderQuality((quality) => applyRenderQuality(player.player.SceneRoot, quality));
        update();
        return {
          update,
          dispose() {
            stopQuality();
            themeObserver.disconnect();
            media.removeEventListener("change", applyTheme);
            doc.removeEventListener("fullscreenchange", update);
            listeners.clear();
            handle = undefined;
            if (doc.fullscreenElement === frame) void doc.exitFullscreen().catch(() => undefined);
          },
        };
      },
    };
  };
}
