import { createEmbedLoader, httpDataSource } from "@haneoka/embed-core";
import type { EmbedLoaderOptions } from "@haneoka/embed-core";
import type { AdvStory } from "@haneoka/vega/engine";
import type { CubismEmbedOptions } from "./haneoka.js";

/** The default chat template keeps its images beside `ChatLINE`, while its icons stay inside it. */
const chatTemplateAsset = (path: string) =>
  path.replace(/(\/Adv\/Chat\/Data\/_template\/data)\/ChatLINE\/(back|chatwindow_image|lock|stamp)\.png$/u, "$1/$2.png");
import type { MountStoryOptions, StoryEmbedEvent, StoryEmbedHandle, StoryEmbedSnapshot } from "./types.js";

export type HaneokaStoryStage = "manifest" | "modules" | "runtime" | "data" | "resources" | "ready";
export type HaneokaStoryEvent =
  StoryEmbedEvent | { readonly type: "stage"; readonly stage: HaneokaStoryStage; readonly release?: string };
export interface HaneokaStoryOptions extends Pick<
  EmbedLoaderOptions<AdvStory>,
  "fetcher" | "headers" | "credentials" | "maxBytes" | "onListenerError"
> {
  readonly id: string;
  readonly server?: string;
  readonly locale?: string;
  readonly signal?: AbortSignal;
  readonly manifestUrl?: string;
  readonly apiBase?: string;
  readonly runtime?: CubismEmbedOptions;
  readonly playerOptions?: Omit<
    MountStoryOptions,
    | "source"
    | "document"
    | "server"
    | "locale"
    | "signal"
    | "onEvent"
    | "fetcher"
    | "headers"
    | "credentials"
    | "maxBytes"
  >;
  readonly onEvent?: (event: HaneokaStoryEvent) => void;
}
export interface HaneokaStoryHandle extends Omit<StoryEmbedHandle, "subscribe"> {
  readonly stage: HaneokaStoryStage;
  readonly release: string | undefined;
  subscribe(listener: (event: HaneokaStoryEvent) => void): () => void;
}
interface Manifest {
  schemaVersion: number;
  release: string;
  modules: Record<string, string>;
  runtimes?: { cubism?: string };
  files: Record<string, { bytes: number; sha256: string }>;
}
interface RuntimeDescriptor {
  schemaVersion: number;
  runtimeId: string;
  module: { url: string; bytes: number; sha256: string };
  core: {
    cubismCoreUrl: { url: string; bytes: number; sha256: string };
    cubism2CoreUrl: { url: string; bytes: number; sha256: string };
    motionSyncCoreUrl: { url: string; bytes: number; sha256: string };
  };
}
const mounts = new WeakMap<HTMLElement, HaneokaStoryHandle>();
function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/** Select one SDK epoch and assemble the first-party story player. */
export function mountHaneokaStory(container: HTMLElement, options: HaneokaStoryOptions): HaneokaStoryHandle {
  if (!container?.ownerDocument?.defaultView) throw new TypeError("A browser HTMLElement is required");
  if (typeof options.id !== "string" || !options.id.trim()) throw new TypeError("id is required");
  if (mounts.has(container)) throw new Error("Dispose the existing Haneoka story first");
  const controller = new AbortController();
  const externalAbort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", externalAbort, { once: true });
  if (options.signal?.aborted) externalAbort();
  const manifestUrl = new URL(options.manifestUrl ?? "https://haneoka.org/embed/manifest.json");
  const fetcher = (request: Request) => {
    const url = new URL(request.url);
    const outgoing =
      url.origin === manifestUrl.origin || url.origin === "https://haneoka.org"
        ? new Request(request, { referrerPolicy: "no-referrer" })
        : request;
    return options.fetcher ? options.fetcher(outgoing) : globalThis.fetch(outgoing);
  };
  const loader = createEmbedLoader<Manifest>({
    source: httpDataSource<Manifest>({ url: manifestUrl }),
    fetcher,
    ...(options.headers === undefined ? {} : { headers: options.headers }),
    ...(options.credentials === undefined ? {} : { credentials: options.credentials }),
    maxBytes: options.maxBytes ?? 64 * 1024 * 1024,
  });
  const listeners = new Set<(event: HaneokaStoryEvent) => void>();
  if (options.onEvent) listeners.add(options.onEvent);
  let stage: HaneokaStoryStage = "manifest";
  let release: string | undefined;
  let phase: StoryEmbedSnapshot["phase"] = "loading";
  let child: StoryEmbedHandle | undefined;
  let boot: Promise<void>;
  let disposal: Promise<void> | undefined;
  const emit = (event: HaneokaStoryEvent) => {
    for (const fn of [...listeners]) {
      try {
        fn(event);
      } catch (error) {
        try {
          options.onListenerError?.(error);
        } catch {}
      }
    }
  };
  const snapshot = (): StoryEmbedSnapshot => ({
    ...(child?.snapshot ?? {
      playing: false,
      paused: true,
      finished: false,
      seeking: false,
      commandIndex: 0,
      commandCount: 0,
      progress: 0,
    }),
    phase,
  });
  const change = (value: HaneokaStoryStage) => {
    stage = value;
    emit({ type: "stage", stage, ...(release ? { release } : {}) });
  };
  const active = () => {
    if (phase !== "ready" || !child) throw new Error(`Story is ${phase}; await ready`);
    return child;
  };
  const handle: HaneokaStoryHandle = {
    get ready() {
      return boot;
    },
    get snapshot() {
      return snapshot();
    },
    get player() {
      return child?.player;
    },
    get stage() {
      return stage;
    },
    get release() {
      return release;
    },
    play: () => active().play(),
    pause: () => active().pause(),
    next: () => active().next(),
    seek: (value) => active().seek(value),
    subscribe(fn) {
      if (phase === "disposed") throw new Error("Story is disposed");
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    cancel() {
      if (phase !== "loading") return;
      phase = "cancelled";
      controller.abort();
      loader.cancel();
      child?.cancel();
      emit({ type: "state", snapshot: snapshot() });
    },
    dispose() {
      if (disposal) return disposal;
      phase = "disposed";
      controller.abort();
      loader.cancel();
      options.signal?.removeEventListener("abort", externalAbort);
      disposal = (async () => {
        const errors: unknown[] = [];
        await boot.catch(() => undefined);
        await child?.dispose().catch((error) => errors.push(error));
        await loader.dispose().catch((error) => errors.push(error));
        if (mounts.get(container) === handle) mounts.delete(container);
        emit({ type: "state", snapshot: snapshot() });
        listeners.clear();
        if (errors.length) throw new AggregateError(errors, "Haneoka story disposal failed");
      })();
      return disposal;
    },
  };
  mounts.set(container, handle);
  loader.subscribe((event) => emit({ type: "load", event }));
  controller.signal.addEventListener(
    "abort",
    () => {
      if (phase === "loading") handle.cancel();
      else if (phase === "ready") void handle.dispose().catch((error) => emit({ type: "error", error }));
    },
    { once: true },
  );
  boot = Promise.resolve().then(async () => {
    try {
      controller.signal.throwIfAborted();
      change("manifest");
      const manifest = await loader.load({ signal: controller.signal });
      if (manifest.schemaVersion !== 1 || !/^r-[a-f0-9]{16}$/u.test(manifest.release))
        throw new TypeError("Invalid SDK manifest");
      release = manifest.release;
      // The publisher stores the same manifest at /embed/ and /embed/r-*.
      // Its module and runtime targets are relative to the distribution root.
      const manifestDirectory = new URL("./", manifestUrl);
      const distributionBase = manifestDirectory.pathname.endsWith(`/${release}/`)
        ? new URL("../", manifestDirectory)
        : manifestDirectory;
      const pinned = (name: string) => {
        const target = manifest.modules?.[name];
        if (target !== `./${release}/${name}.js`) throw new TypeError(`Mixed SDK epoch: ${name}`);
        return new URL(target, distributionBase).href;
      };
      const urls = ["core", "vega", "vega-theme"].map(pinned);
      change("modules");
      const [core, sdk, theme] = await abortable(
        Promise.all(urls.map((url) => import(/* @vite-ignore */ url))),
        controller.signal,
      );
      if (
        typeof core.createEmbedLoader !== "function" ||
        typeof sdk.mountStory !== "function" ||
        typeof sdk.haneokaStorySource !== "function" ||
        typeof sdk.haneokaSourceAssetUrl !== "function" ||
        typeof sdk.cubismStoryPlugin !== "function" ||
        !Array.isArray(theme.haneokaStoryPlugins) ||
        typeof theme.createHaneokaThemeAssetsPlugin !== "function"
      )
        throw new TypeError("Incompatible SDK module contract");
      let runtime = options.runtime;
      if (!runtime) {
        change("runtime");
        const target = manifest.runtimes?.cubism;
        if (target !== `./${release}/runtime.json`)
          throw new TypeError("SDK epoch has no pinned Cubism runtime descriptor");
        const expected = manifest.files?.["runtime.json"];
        if (!expected || !Number.isSafeInteger(expected.bytes) || !/^[a-f0-9]{64}$/u.test(expected.sha256))
          throw new TypeError("Invalid runtime descriptor metadata");
        const bytes = await loader.resourceBytes(new URL(target, distributionBase).href, { signal: controller.signal });
        const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer))]
          .map((x) => x.toString(16).padStart(2, "0"))
          .join("");
        if (bytes.length !== expected.bytes || hash !== expected.sha256)
          throw new TypeError("Runtime descriptor integrity mismatch");
        const descriptor = JSON.parse(new TextDecoder().decode(bytes)) as RuntimeDescriptor;
        if (descriptor.schemaVersion !== 1 || !descriptor.runtimeId)
          throw new TypeError("Invalid Cubism runtime descriptor");
        const runtimeUrl = (file: RuntimeDescriptor["module"]) => {
          if (!file || !Number.isSafeInteger(file.bytes) || !/^[a-f0-9]{64}$/u.test(file.sha256))
            throw new TypeError("Invalid runtime file metadata");
          const url = new URL(file.url, manifestUrl);
          if (url.origin !== manifestUrl.origin || !/^\/(?:Core|cubism-runtime)\//u.test(url.pathname))
            throw new TypeError("Runtime file escapes deployment origin");
          url.searchParams.set("v", file.sha256);
          return url.href;
        };
        runtime = {
          moduleUrl: runtimeUrl(descriptor.module),
          runtime: {
            cubismCoreUrl: runtimeUrl(descriptor.core.cubismCoreUrl),
            cubism2CoreUrl: runtimeUrl(descriptor.core.cubism2CoreUrl),
            motionSyncCoreUrl: runtimeUrl(descriptor.core.motionSyncCoreUrl),
          },
        };
      }
      controller.signal.throwIfAborted();
      change("data");
      const playerOptions = options.playerOptions ?? {};
      const server = options.server ?? "intl";
      const source = sdk.haneokaStorySource({
        id: options.id,
        ...(options.apiBase ? { apiBase: options.apiBase } : {}),
      });
      const sourceAssets = theme.createHaneokaThemeAssetsPlugin({
        resolveSourceAsset: (path: string) =>
          /^(?:Assets|Packages)\//u.test(path)
            ? sdk.haneokaSourceAssetUrl(chatTemplateAsset(path), source.assetsBase, server)
            : /^(?:https?:\/\/|blob:|data:|\/)/iu.test(path)
              ? new URL(path, source.assetsBase).href
              : "",
      });
      // Both current and legacy host adapters retain ownership of custom assets.
      const assetPlugins = playerOptions.plugins?.some(
        (plugin) => plugin.manifest.id === sourceAssets.manifest.id || plugin.manifest.id === "haneoka.theme-host",
      )
        ? []
        : [sourceAssets];
      child = sdk.mountStory(container, {
        ...playerOptions,
        source,
        server,
        locale: options.locale ?? "ja",
        theme: playerOptions.theme ?? "haneoka",
        plugins: [
          ...theme.haneokaStoryPlugins,
          ...assetPlugins,
          sdk.cubismStoryPlugin(runtime),
          ...(playerOptions.plugins ?? []),
        ],
        fetcher,
        ...(options.headers === undefined ? {} : { headers: options.headers }),
        ...(options.credentials === undefined ? {} : { credentials: options.credentials }),
        maxBytes: options.maxBytes ?? 64 * 1024 * 1024,
        signal: controller.signal,
        onEvent(event: StoryEmbedEvent) {
          if (event.type === "load" && event.event.type === "ready" && event.event.key === "$data") change("resources");
          if (phase !== "disposed" && phase !== "cancelled") {
            if (event.type === "error" || (event.type === "state" && event.snapshot.phase === "error")) phase = "error";
          }
          // Child readiness precedes this bootstrap's ready transition.
          emit(event.type === "state" ? { ...event, snapshot: { ...event.snapshot, phase } } : event);
        },
      }) as StoryEmbedHandle;
      await child.ready;
      controller.signal.throwIfAborted();
      phase = "ready";
      change("ready");
      emit({ type: "state", snapshot: snapshot() });
    } catch (error) {
      if (phase !== "disposed") {
        phase = controller.signal.aborted ? "cancelled" : "error";
        emit({ type: "error", error });
      }
      controller.abort(error);
      const cleanupErrors: unknown[] = [];
      await child?.dispose().catch((cause) => cleanupErrors.push(cause));
      await loader.dispose().catch((cause) => cleanupErrors.push(cause));
      if (mounts.get(container) === handle) mounts.delete(container);
      if (cleanupErrors.length)
        throw new AggregateError([error, ...cleanupErrors], "Haneoka story bootstrap and cleanup failed", {
          cause: error,
        });
      throw error;
    }
  });
  void boot.catch(() => undefined);
  return handle;
}
