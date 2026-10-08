import { RenderFrameBuilder, NativeChartVisualProfilesError, type OurNotesAssetManifest } from "@haneoka/cassiopeia-plugin-our-notes";
import type { ChartPlayerExpose } from "@haneoka/cassiopeia-ui-vue/player";
import type { PlayerDriver, PlayerEvent } from "./driver.js";
import { ChartReplacementRejectedError } from "./driver.js";
import type { ChartEmbedDocument, ChartPlaybackOptions, MountChartOptions } from "./types.js";

/** Probe actual runtime implementations, including the compiled Vue prop; declarations alone are insufficient. */
export async function supportsNativeVisualProfiles(): Promise<boolean> {
  const { ChartPlayer } = await import("@haneoka/cassiopeia-ui-vue/player");
  const declaredProps: unknown = Reflect.get(ChartPlayer, "props");
  return typeof RenderFrameBuilder.prototype.setVisualProfiles === "function"
    && !!declaredProps && typeof declaredProps === "object" && Object.hasOwn(declaredProps, "visualProfiles");
}

export async function createVuePlayer(
  element: HTMLElement,
  document: ChartEmbedDocument,
  assets: OurNotesAssetManifest,
  options: ChartPlaybackOptions,
  labels: MountChartOptions["labels"],
  signal: AbortSignal,
  event: PlayerEvent,
): Promise<PlayerDriver> {
  const [{ createApp, h, shallowReactive, nextTick }, { ChartPlayer }] = await Promise.all([
    import("vue"),
    import("@haneoka/cassiopeia-ui-vue/player"),
  ]);
  signal.throwIfAborted();
  let player: ChartPlayerExpose | null = null;
  let disposed = false;
  let playError: unknown;
  let chartUpdateError: unknown;
  let chartUpdateInProgress = false;
  const frameWaiters = new Set<{ resolve(): void; reject(error: unknown): void }>();
  const rejectFrames = (error: unknown) => {
    for (const waiter of frameWaiters) waiter.reject(error);
    frameWaiters.clear();
  };
  const props = shallowReactive({ ...options, chart: document.chart, bgmOffsetMs: document.bgmOffsetMs ?? 0, visualProfiles: document.visualProfiles });
  let resolveReady!: () => void;
  let rejectReady!: (error: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const on =
    (name: string) =>
    (...args: unknown[]) => {
      if (disposed || signal.aborted) return;
      event(name, ...args);
    };
  const app = createApp({
    render: () =>
      h(ChartPlayer, {
        ...props,
        assets,
        audioUrl: document.audio ?? "",
        backgroundUrl: document.background ?? "",
        titleIntroductionEnabled: false,
        ariaLabel: labels?.player ?? "Chart player",
        pauseLabel: labels?.pause ?? "Pause",
        loadingLabel: labels?.loading ?? "Loading",
        ref: (value: unknown) => {
          player = value as ChartPlayerExpose | null;
        },
        onReady: () => {
          if (!disposed && !signal.aborted) resolveReady();
        },
        onError: (error: unknown) => {
          playError = error;
          if (chartUpdateInProgress) chartUpdateError = error;
          rejectFrames(error);
          rejectReady(error);
          on("error")(error);
        },
        onPlaying: on("playing"),
        onFrame: () => {
          if (disposed || signal.aborted) return;
          for (const waiter of frameWaiters) waiter.resolve();
          frameWaiters.clear();
        },
        "onMedia-playing": on("media-playing"),
        onTimeupdate: on("timeupdate"),
        onDuration: on("duration"),
        onJudgement: on("judgement"),
        onSkill: on("skill"),
        onFever: on("fever"),
        onCallchange: on("callchange"),
      }),
  });
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    rejectFrames(new DOMException("Chart player disposed", "AbortError"));
    signal.removeEventListener("abort", abort);
    app.unmount();
    player = null;
  };
  const abort = () => {
    rejectReady(signal.reason);
    dispose();
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    app.mount(element);
    await ready;
    signal.throwIfAborted();
  } catch (error) {
    dispose();
    throw error;
  }
  return {
    async play() {
      playError = undefined;
      await player!.play();
      if (playError !== undefined) throw playError;
    },
    pause: () => player?.pause(),
    seek: (seconds) => player!.seek(seconds),
    getPresentation: () => disposed || signal.aborted ? undefined : player?.getPresentation(),
    waitForPresentation() {
      if (disposed || signal.aborted) return Promise.reject(new DOMException("Chart player disposed", "AbortError"));
      return new Promise<void>((resolve, reject) => {
        const waiter = {
          resolve: () => { clearTimeout(timer); resolve(); },
          reject: (error: unknown) => { clearTimeout(timer); reject(error); },
        };
        const timer = setTimeout(() => {
          frameWaiters.delete(waiter);
          reject(new DOMException("Chart presentation timed out", "TimeoutError"));
        }, 5000);
        frameWaiters.add(waiter);
      });
    },
    async setChart(chart, value = {}) {
      if (disposed) throw new Error("Chart player has been disposed");
      signal.throwIfAborted();
      if (value.visualProfiles !== undefined) {
        try { new RenderFrameBuilder(chart, { visualProfiles: value.visualProfiles }); }
        catch (error) {
          if (error instanceof NativeChartVisualProfilesError) throw new ChartReplacementRejectedError(error);
          throw error;
        }
      }
      player!.pause();
      chartUpdateError = undefined;
      chartUpdateInProgress = true;
      try {
        // Vue's joint chart/profile watcher consumes one matching compilation epoch.
        Object.assign(props, { chart, visualProfiles: value.visualProfiles });
        if (value.bgmOffsetMs !== undefined) props.bgmOffsetMs = value.bgmOffsetMs;
        await nextTick();
        signal.throwIfAborted();
        if (disposed) throw new Error("Chart player has been disposed");
        if (chartUpdateError !== undefined) throw chartUpdateError;
      } finally { chartUpdateInProgress = false; }
    },
    async setOptions(value) {
      if (disposed) throw new Error("Chart player has been disposed");
      Object.assign(props, value);
      await nextTick();
    },
    dispose,
  };
}
