// L3 — GEB
// Input: 宿主元素、故事资料／来源、locale 和挂载选项。
// Output: mountStory、播放状态及可销毁句柄。
// Pos: [Map](../../L2.md)；Vega 故事嵌入的浏览器入口。
// Effects/Dependencies: 挂载创建 DOM、加载资源／引擎并维护取消与 URL 状态；需 dispose 后再挂载。
import { createEmbedLoader, memoryDataSource } from "@haneoka/embed-core";
import { createHaneokaBranding } from "@haneoka/embed-core/branding";
import type { VegaEngine, VegaPlayerHandle } from "@haneoka/vega/web";
import { collectPlaybackUrls, resolveStoryUrls } from "./story-urls.js";
import { createPlaybackUrls } from "./playback-urls.js";
import type {
  MountStoryOptions,
  StoryEmbedEvent,
  StoryEmbedHandle,
  StoryEmbedPhase,
  StoryEmbedSnapshot,
} from "./types.js";
export type * from "./types.js";

const mounts = new WeakMap<HTMLElement, StoryEmbedHandle>();

export function mountStory(container: HTMLElement, options: MountStoryOptions): StoryEmbedHandle {
  if (!container?.ownerDocument?.defaultView) throw new TypeError("mountStory requires a browser HTMLElement");
  if (mounts.has(container)) throw new Error("Dispose the existing story before remounting this container");
  const resourceTimeoutMs = options.resourceTimeoutMs ?? 30_000;
  if (!Number.isSafeInteger(resourceTimeoutMs) || resourceTimeoutMs < 1)
    throw new RangeError("resourceTimeoutMs must be positive");
  const source = options.source ?? memoryDataSource(options.document!);
  const resolvedUrls = new Set<string>();
  const loader = createEmbedLoader({
    ...options,
    source,
    resolveResource: (key, context) => (resolvedUrls.has(key) ? key : (options.resolveResource?.(key, context) ?? key)),
  });
  // URL bookkeeping lets literal file keys resolve once, while providers can
  // request manifest-relative absolute URLs through the same transport.
  const resourceUrl = loader.resourceUrl.bind(loader);
  loader.resourceUrl = async (key, loadOptions) => {
    const url = await resourceUrl(key, loadOptions);
    resolvedUrls.add(url);
    return url;
  };
  const controller = new AbortController();
  const playbackUrls = createPlaybackUrls(loader, controller.signal, resourceTimeoutMs);
  const abort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  const stage = container.ownerDocument.createElement("div");
  stage.style.cssText = "position:relative;width:100%;height:100%;min-height:1px;overflow:hidden;";
  stage.lang = loader.locale;
  // Attribution overlays the scene without reducing its viewport.
  const brand = createHaneokaBranding(container.ownerDocument, { corner: options.brandingCorner ?? "top-left" });
  const viewport = container.ownerDocument.createElement("div");
  viewport.style.cssText = "position:absolute;inset:0;overflow:hidden;";
  stage.append(brand, viewport);
  container.append(stage);
  let phase: StoryEmbedPhase = "loading";
  let engine: VegaEngine | undefined;
  let player: VegaPlayerHandle | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let disposal: Promise<void> | undefined;
  let releasePlayer: Promise<void> | undefined;
  let boot: Promise<void>;
  const listeners = new Set<(event: StoryEmbedEvent) => void>();
  if (options.onEvent) listeners.add(options.onEvent);
  const emit = (event: StoryEmbedEvent) => {
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch (error) {
        try {
          options.onListenerError?.(error);
        } catch {
          /* Observers keep their own errors. */
        }
      }
    }
  };
  const snapshot = (): StoryEmbedSnapshot =>
    Object.freeze({
      phase,
      playing: Boolean(player?.player.state.playing && !player.player.state.paused),
      paused: player?.player.state.paused ?? true,
      finished: player?.player.state.finished ?? false,
      seeking: player?.player.state.seeking ?? false,
      commandIndex: player?.player.currentProgressIndex() ?? 0,
      commandCount: player?.player.state.commandCount ?? 0,
      progress: player?.player.currentSeekProgress().ratio ?? 0,
    });
  let lastSnapshot = "";
  const publish = () => {
    // Native shell controls and background tasks report through player state.
    if (phase === "ready" && player?.player.state.error) {
      fail(new Error(player.player.state.error));
      return;
    }
    const value = snapshot();
    const signature = JSON.stringify(value);
    if (signature !== lastSnapshot) {
      lastSnapshot = signature;
      emit({ type: "state", snapshot: value });
    }
  };
  const stopPlayer = () => {
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
    releasePlayer ??= Promise.resolve()
      .then(() => engine?.dispose())
      .then(() => {
        player = undefined;
      });
    return releasePlayer;
  };
  const fail = (error: unknown) => {
    if (phase === "disposed" || phase === "cancelled") return;
    phase = "error";
    player?.player.pause();
    publish();
    emit({ type: "error", error });
  };
  const requirePlayer = () => {
    if (phase !== "ready" || !player) throw new Error(`Story is ${phase}; await ready before playback`);
    return player.player;
  };
  const cancelBoot = () => {
    if (phase !== "loading") return;
    phase = "cancelled";
    controller.abort();
    loader.cancel();
    void stopPlayer().catch(fail);
    publish();
  };
  const handle: StoryEmbedHandle = {
    get ready() {
      return boot;
    },
    get snapshot() {
      return snapshot();
    },
    get player() {
      return player;
    },
    play() {
      const active = requirePlayer();
      active.resume();
      void active.play().then(publish, fail);
      publish();
    },
    pause() {
      requirePlayer().pause();
      publish();
    },
    next() {
      requirePlayer().requestNext();
    },
    async seek(ratio) {
      if (!Number.isFinite(ratio) || ratio < 0 || ratio > 1) throw new RangeError("seek ratio must be between 0 and 1");
      const active = requirePlayer();
      const target = active.resolveSeekRatio(ratio);
      const pending = active.seekTo(target);
      publish();
      try {
        await pending;
      } catch (error) {
        fail(error);
        throw error;
      }
      controller.signal.throwIfAborted();
      requirePlayer();
      const restored = active.currentProgressIndex();
      publish();
      emit({ type: "seek", commandIndex: restored });
      return restored;
    },
    subscribe(listener) {
      if (phase === "disposed") throw new Error("Story has been disposed");
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    cancel: cancelBoot,
    dispose() {
      if (disposal) return disposal;
      phase = "disposed";
      controller.abort();
      loader.cancel();
      options.signal?.removeEventListener("abort", abort);
      disposal = Promise.resolve().then(async () => {
        // Stop current construction, then wait for its stale-result cleanup.
        const failures: unknown[] = [];
        await stopPlayer().catch((error) => failures.push(error));
        await boot.catch(() => undefined);
        await loader.dispose().catch((error) => failures.push(error));
        playbackUrls.dispose();
        stage.remove();
        resolvedUrls.clear();
        mounts.delete(container);
        publish();
        listeners.clear();
        if (failures.length) throw new AggregateError(failures, "Story disposal failed");
      });
      return disposal;
    },
  };
  mounts.set(container, handle);
  loader.subscribe((event) => emit({ type: "load", event }));
  controller.signal.addEventListener(
    "abort",
    () => {
      if (phase === "loading") cancelBoot();
      else if (phase === "ready") void handle.dispose().catch(fail);
    },
    { once: true },
  );
  boot = Promise.resolve().then(async () => {
    let playbackPreparation: Promise<void> | undefined;
    try {
      publish();
      controller.signal.throwIfAborted();
      const story = await loader.load({ signal: controller.signal });
      if (!Array.isArray(story.commands)) throw new TypeError("Story document requires a commands array");
      playbackPreparation = playbackUrls.prepare(collectPlaybackUrls(story, controller.signal));
      void playbackPreparation.catch(() => undefined);
      const resolved = await resolveStoryUrls(story, loader, controller.signal, async (key) => {
        const url = await playbackUrls.reference(key);
        resolvedUrls.add(url);
        return url;
      });
      const [
        { createVega, createVegaPlayerState },
        { defineVegaPlugin },
        { createThreeRendererPlugin },
        { vegaPortableUiPlugin },
        { createVegaRichTextPlugin },
      ] = await Promise.all([
        import("@haneoka/vega/web"),
        import("@haneoka/vega/plugin"),
        import("@haneoka/vega-renderer-three"),
        import("@haneoka/vega-ui-portable"),
        import("@haneoka/vega-plugin-richtext"),
      ]);
      controller.signal.throwIfAborted();
      const plugins = [
        createVegaRichTextPlugin(),
        vegaPortableUiPlugin,
        createThreeRendererPlugin(options.renderer),
        defineVegaPlugin({
          manifest: {
            id: "haneoka.embed-vega.resources",
            name: "Embed resource transport",
            version: "0.1.0",
            apiVersion: 1,
            capabilities: ["resource"],
          },
          setup(context) {
            context.contribute("resource", {
              id: "embed-resources",
              name: "Embed resource transport",
              schemes: ["http", "https", "blob", "data", "embed-playback"],
              load: (url, signal) =>
                url.protocol === "embed-playback:"
                  ? playbackUrls.read(url, signal)
                  : loader.resourceBytes(url.href, {
                      signal: AbortSignal.any([signal, AbortSignal.timeout(resourceTimeoutMs)]),
                    }),
            });
          },
        }),
        ...(options.plugins ?? []),
      ];
      controller.signal.throwIfAborted();
      engine = createVega({ plugins });
      const abortEngine = () => {
        void stopPlayer().catch(fail);
      };
      controller.signal.addEventListener("abort", abortEngine, { once: true });
      const state = createVegaPlayerState();
      state.paused = true;
      player = await engine.createPlayer({
        mount: viewport,
        story: resolved,
        state,
        renderBackend: "vega-three-webgl2",
        theme: options.theme ?? "portable",
        ...(options.resolveLocalizedText ? { resolveLocalizedText: options.resolveLocalizedText } : {}),
        ...(options.shell !== undefined
          ? { shell: options.shell }
          : options.theme === "haneoka"
            ? { shell: { initialScreen: "game" } }
            : { shell: false }),
      });
      await playbackPreparation;
      controller.signal.throwIfAborted();
      // The shell fullscreens player.root. Keep both attribution and the
      // full scene area inside that root, including in native fullscreen.
      const scene = container.ownerDocument.createElement("div");
      scene.style.cssText = `${viewport.style.cssText}container-type:size;`;
      scene.append(...Array.from(player.root.childNodes));
      player.root.append(brand, scene);
      stage.append(player.root);
      viewport.remove();
      // Shell settings are reapplied together, including after UI changes.
      // Keep the story preference aligned with the embed's requested locale.
      player.shell?.setSetting("language", loader.locale);
      player.shell?.setSetting("uiLanguage", loader.locale);
      player.player.setLocale(loader.locale, { refresh: true });
      if (player.player.state.error) throw new Error(player.player.state.error);
      phase = "ready";
      timer = setInterval(publish, 100);
      publish();
    } catch (error) {
      if (controller.signal.aborted && phase !== "disposed") {
        phase = "cancelled";
        publish();
      } else {
        // Publish the originating boot error before aborting shared preparation.
        fail(error);
        controller.abort(error);
      }
      try {
        await stopPlayer();
      } finally {
        await playbackPreparation?.catch(() => undefined);
        playbackUrls.dispose();
      }
      throw error;
    }
  });
  // Hosts may observe cancellation through events without awaiting ready.
  void boot.catch(() => undefined);
  return handle;
}
