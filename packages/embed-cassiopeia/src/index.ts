import { createEmbedLoader, memoryDataSource } from "@haneoka/embed-core";
import { resolveChartAssets, resolveNativeResourceUrl } from "./resources.js";
import { createChartHost } from "./host.js";
import { publicResourceRequest } from "./public-resources.js";
import type { PlayerDriver } from "./driver.js";
import { ChartReplacementRejectedError } from "./driver.js";
import type {
  ChartEmbedDocument,
  ChartEmbedEvent,
  ChartEmbedHandle,
  ChartEmbedPhase,
  ChartPlaybackOptions,
  MountChartOptions,
} from "./types.js";
export type * from "./types.js";

const mounts = new WeakMap<HTMLElement, ChartEmbedHandle>();

export function mountChart(container: HTMLElement, options: MountChartOptions): ChartEmbedHandle {
  if (!container?.ownerDocument?.defaultView) throw new TypeError("mountChart requires a browser HTMLElement");
  if (mounts.has(container)) throw new Error("Dispose the existing chart before remounting this container");
  if (Boolean(options.source) === Boolean(options.document))
    throw new TypeError("Provide exactly one source or document");
  const timeout = options.loadTimeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeout) || timeout < 1) throw new RangeError("loadTimeoutMs must be a positive integer");
  const controller = new AbortController();
  const loader = createEmbedLoader({
    ...options,
    source: options.source ?? memoryDataSource(options.document!),
    fetcher: (request) => {
      const outgoing = publicResourceRequest(request);
      return options.fetcher ? options.fetcher(outgoing) : globalThis.fetch(outgoing);
    },
  });
  const host = createChartHost(container, loader.locale);
  const element = host.viewport;
  let phase: ChartEmbedPhase = "loading";
  let playing = false;
  let time = 0;
  let duration = 0;
  let driver: PlayerDriver | undefined;
  let document: ChartEmbedDocument;
  let backgroundResource: string | undefined;
  let skin = { ...options.skin };
  let playback: ChartPlaybackOptions = {
    mode: options.mode ?? "watch",
    settings: options.settings ?? {},
    volume: options.volume ?? 0.8,
    rate: options.rate ?? 1,
    loop: options.loop ?? false,
    noteSoundEnabled: options.noteSoundEnabled ?? true,
    noteSoundVolume: options.noteSoundVolume ?? 0.7,
  };
  let disposal: Promise<void> | undefined;
  let boot: Promise<void>;
  let child: AbortController | undefined;
  let driverEpoch = 0;
  let chartUpdating = false;
  let mutations: Promise<void> = Promise.resolve();
  const enqueueMutation = (action: () => Promise<void>) => {
    const pending = mutations.catch(() => {}).then(() => {
      controller.signal.throwIfAborted();
      return action();
    });
    mutations = pending;
    return pending;
  };
  const listeners = new Set<(event: ChartEmbedEvent) => void>();
  if (options.onEvent) listeners.add(options.onEvent);
  const emit = (event: ChartEmbedEvent) => {
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch (error) {
        try {
          options.onListenerError?.(error);
        } catch {
          /* Observers own their errors. */
        }
      }
    }
  };
  const snapshot = () => Object.freeze({ phase, playing, time, duration });
  const publish = () => emit({ type: "state", snapshot: snapshot() });
  const playerEvent = (name: string, ...args: unknown[]) => {
    if (controller.signal.aborted) return;
    if (name === "playing") playing = Boolean(args[0]);
    if (name === "timeupdate") time = Math.max(0, Number(args[0]));
    if (name === "duration") duration = Number(args[0]);
    if (name === "error") {
      emit({ type: "error", error: args[0] });
      return;
    }
    emit({ type: "player", name, args });
    if (name === "playing" || name === "timeupdate" || name === "duration") publish();
  };
  const required = () => {
    if (phase !== "ready" || !driver) throw new Error(`Chart is ${phase}; await ready before playback`);
    return driver;
  };
  const failure = (error: unknown) => {
    if (controller.signal.aborted) return;
    ++driverEpoch;
    phase = "error";
    playing = false;
    driver?.dispose();
    driver = undefined;
    publish();
    emit({ type: "error", error });
  };
  const abortReason = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", abortReason, { once: true });
  if (options.signal?.aborted) abortReason();
  const construct = async () => {
    const construction = new AbortController();
    child = construction;
    const deadline = new AbortController();
    const timer = setTimeout(
      () => deadline.abort(new DOMException("Chart loading timed out", "TimeoutError")),
      timeout,
    );
    const signal = AbortSignal.any([controller.signal, construction.signal, deadline.signal]);
    const pending = (async () => {
      const nativeUrls = new Set<string>();
      const releaseNativeUrls = () => {
        for (const url of nativeUrls) URL.revokeObjectURL(url);
        nativeUrls.clear();
      };
      try {
        let candidate: PlayerDriver;
        if (options.rendererAdapter) {
          const { createAuthoredPlayer } = await import("./authored-player.js");
          signal.throwIfAborted();
          candidate = await createAuthoredPlayer(
            element,
            document,
            loader,
            { ...options, ...playback },
            signal,
            playerEvent,
          );
        } else {
          const assets = options.theme ? await options.theme({ loader, signal, skin }) : document.assets;
          if (!assets)
            throw new TypeError(
              "Default player requires document.assets or theme; authored art can use rendererAdapter",
            );
          const resolved = await resolveChartAssets(assets, loader, signal, nativeUrls);
          const background = backgroundResource
            ? await resolveNativeResourceUrl(backgroundResource, loader, signal, nativeUrls)
            : undefined;
          const { createVuePlayer } = await import("./vue-player.js");
          signal.throwIfAborted();
          candidate = await createVuePlayer(
            element,
            { ...document, ...(background === undefined ? {} : { background }) },
            resolved,
            playback,
            options.labels,
            signal,
            playerEvent,
          );
        }
        if (signal.aborted) {
          candidate.dispose();
          signal.throwIfAborted();
        }
        return {
          ...candidate,
          dispose() {
            try {
              candidate.dispose();
            } finally {
              releaseNativeUrls();
            }
          },
        };
      } catch (error) {
        construction.abort(error);
        releaseNativeUrls();
        throw error;
      }
    })();
    // A custom factory that ignores abort is cleaned up when it eventually returns.
    // The public ready/dispose operation never waits indefinitely for that factory.
    let rejectAbort: () => void = () => {};
    const aborted = new Promise<never>((_, reject) => {
      rejectAbort = () => reject(signal.reason);
      signal.addEventListener("abort", rejectAbort, { once: true });
      if (signal.aborted) rejectAbort();
    });
    try {
      return await Promise.race([pending, aborted]);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", rejectAbort);
    }
  };
  const stop = () => {
    ++driverEpoch;
    host.restoreBrand();
    child?.abort();
    driver?.dispose();
    driver = undefined;
    playing = false;
    loader.cancel();
  };
  const handle: ChartEmbedHandle = {
    get ready() {
      return boot;
    },
    get snapshot() {
      return snapshot();
    },
    async play() {
      if (chartUpdating) throw new Error("Await chart replacement before playback");
      await required().play();
    },
    pause() {
      required().pause();
      playing = false;
      publish();
    },
    seek(seconds) {
      if (!Number.isFinite(seconds) || seconds < 0) throw new RangeError("seek requires nonnegative seconds");
      const target = duration > 0 ? Math.min(seconds, duration) : seconds;
      required().seek(target);
      time = target;
      publish();
    },
    async setOptions(value) {
      const active = required();
      playback = {
        ...playback,
        ...value,
        ...(value.settings ? { settings: { ...playback.settings, ...value.settings } } : {}),
      };
      await active.setOptions(playback);
    },
    ...(!options.rendererAdapter ? {
      getPresentation: () => phase === "ready" && !chartUpdating && !controller.signal.aborted
        ? driver?.getPresentation?.() : undefined,
      async setChart(chart, value = {}) {
        required();
        if (!Array.isArray(chart?.notes) || !Array.isArray(chart.lines) || !Number.isFinite(chart.durationMs) || chart.durationMs < 0)
          throw new TypeError("Chart document requires notes, lines and a nonnegative durationMs");
        if (value.bgmOffsetMs !== undefined && !Number.isFinite(value.bgmOffsetMs))
          throw new RangeError("bgmOffsetMs requires finite milliseconds");
        return enqueueMutation(async () => {
          const active = required(), epoch = driverEpoch, position = time;
          const profileOnly = chart === document.chart && (value.bgmOffsetMs === undefined || value.bgmOffsetMs === (document.bgmOffsetMs ?? 0));
          if (!active.setChart) throw new Error("This player does not support chart replacement");
          active.pause();
          playing = false;
          if (profileOnly && value.visualProfiles === document.visualProfiles) { publish(); return; }
          chartUpdating = true;
          publish();
          try {
            await active.setChart(chart, value);
            controller.signal.throwIfAborted();
            if (driver !== active || driverEpoch !== epoch) throw new DOMException("Chart player changed", "AbortError");
            active.pause();
            const target = Math.min(position, Math.max(0, duration));
            const rendered = active.waitForPresentation?.();
            void rendered?.catch(() => {});
            if (!profileOnly) active.seek(target);
            await rendered;
            controller.signal.throwIfAborted();
            if (driver !== active || driverEpoch !== epoch) throw new DOMException("Chart player changed", "AbortError");
            const { visualProfiles: _previousProfiles, ...retained } = document;
            document = { ...retained, chart, ...(value.bgmOffsetMs === undefined ? {} : { bgmOffsetMs: value.bgmOffsetMs }),
              ...(value.visualProfiles === undefined ? {} : { visualProfiles: value.visualProfiles }) };
            time = target;
            playing = false;
          } catch (error) {
            if (!(error instanceof ChartReplacementRejectedError) && driver === active && driverEpoch === epoch) failure(error);
            throw error;
          } finally {
            chartUpdating = false;
            if (phase === "ready" && driver === active && driverEpoch === epoch) publish();
          }
        });
      },
    } satisfies Pick<ChartEmbedHandle, "getPresentation" | "setChart"> : {}),
    async setSkin(value) {
      required();
      if (!options.theme || options.rendererAdapter) throw new Error("setSkin requires a default-player theme factory");
      return enqueueMutation(async () => {
        required();
        const position = time;
        driver!.pause();
        stop();
        const epoch = driverEpoch;
        skin = { ...skin, ...value };
        phase = "loading";
        publish();
        try {
          const candidate = await construct();
          if (controller.signal.aborted || driverEpoch !== epoch) {
            candidate.dispose();
            controller.signal.throwIfAborted();
            throw new DOMException("Chart player changed", "AbortError");
          }
          driver = candidate;
          const target = duration > 0 ? Math.min(position, duration) : position;
          const rendered = driver.waitForPresentation?.();
          void rendered?.catch(() => {});
          driver.seek(target);
          await rendered;
          controller.signal.throwIfAborted();
          if (driver !== candidate || driverEpoch !== epoch) throw new DOMException("Chart player changed", "AbortError");
          phase = "ready";
          time = target;
          publish();
        } catch (error) {
          failure(error);
          throw error;
        }
      });
    },
    subscribe(listener) {
      if (phase === "disposed") throw new Error("Chart has been disposed");
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    cancel() {
      if (phase === "disposed" || phase === "cancelled") return;
      phase = "cancelled";
      controller.abort();
      stop();
      publish();
    },
    dispose() {
      if (disposal) return disposal;
      phase = "disposed";
      controller.abort();
      options.signal?.removeEventListener("abort", abortReason);
      disposal = Promise.resolve().then(async () => {
        const errors: unknown[] = [];
        try {
          stop();
        } catch (error) {
          errors.push(error);
        }
        await loader.dispose().catch((error) => errors.push(error));
        host.dispose();
        mounts.delete(container);
        publish();
        listeners.clear();
        if (errors.length) throw new AggregateError(errors, "Chart disposal failed");
      });
      return disposal;
    },
  };
  mounts.set(container, handle);
  loader.subscribe((event) => {
    if (phase !== "disposed") emit({ type: "load", event });
  });
  controller.signal.addEventListener(
    "abort",
    () => {
      if (phase === "loading" || phase === "ready" || phase === "error") handle.cancel();
    },
    { once: true },
  );
  if (controller.signal.aborted) handle.cancel();
  boot = Promise.resolve().then(async () => {
    try {
      controller.signal.throwIfAborted();
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(timeout)]);
      document = await loader.load({ signal });
      if (options.rendererAdapter && document.visualProfiles !== undefined)
        throw new Error("Visual profiles require the native player");
      if (
        !Array.isArray(document.chart?.notes) ||
        !Array.isArray(document.chart.lines) ||
        !Number.isFinite(document.chart.durationMs)
      )
        throw new TypeError("Chart document requires notes, lines and durationMs");
      backgroundResource = document.background;
      const [audio, background] = await Promise.all([
        document.audio ? loader.resourceUrl(document.audio, { signal }) : undefined,
        document.background ? loader.resourceUrl(document.background, { signal }) : undefined,
      ]);
      document = {
        ...document,
        ...(audio === undefined ? {} : { audio }),
        ...(background === undefined ? {} : { background }),
      };
      driver = await construct();
      controller.signal.throwIfAborted();
      phase = "ready";
      publish();
    } catch (error) {
      failure(error);
      throw error;
    }
  });
  // Disposal/cancellation remains safe even if the consumer never awaits ready.
  void boot.catch(() => {});
  return handle;
}
