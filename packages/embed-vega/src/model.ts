// L3 — GEB
// Input: 宿主元素、Cubism 3 模型 URL 与可选着色器参数。
// Output: 可控制并销毁的 Live2D 播放器。
// Pos: [Map](../../L2.md)；独立模型嵌入入口。
// Effects/Dependencies: 读取模型和 runtime，创建 WebGL2 画布并管理对象 URL。
import { createEmbedLoader, memoryDataSource, type EmbedLoaderOptions } from "@haneoka/embed-core";
import { resolveHostedCubismRuntime, type HostedManifest } from "./hosted-runtime.js";
import type { CubismEmbedOptions } from "./haneoka.js";
import { createModelAssets } from "./model-assets.js";
import { createModelShaderPasses, loadModelShaders, type ModelShaderOptions } from "./model-shaders.js";

export interface ModelPlayerOptions
  extends
    ModelShaderOptions,
    Pick<EmbedLoaderOptions<unknown>, "assetsBase" | "fetcher" | "maxBytes" | "resources" | "resolveResource"> {
  /** ZIP or standard Cubism 3 model descriptor URL, relative to the host page. */
  readonly src: string | URL;
  readonly runtime?: CubismEmbedOptions;
  readonly runtimeManifestUrl?: string | URL;
  readonly signal?: AbortSignal;
  readonly motion?: string;
  readonly expression?: string;
  readonly onError?: (error: unknown) => void;
}

export interface ModelPlayerHandle {
  readonly canvas: HTMLCanvasElement;
  readonly motions: readonly string[];
  readonly expressions: readonly string[];
  playMotion(name: string): boolean;
  playExpression(name: string): boolean;
  setPaused(paused: boolean): void;
  dispose(): void;
}

interface RuntimeViewer {
  readonly ready: boolean;
  load(options: {
    modelUrl: string;
    defaultMotionName?: string;
    defaultExpressionName?: string;
    signal: AbortSignal;
  }): Promise<void>;
  playMotion(name: string): boolean;
  playExpression(name: string): boolean;
  setPaused(paused: boolean): void;
  setSize(width: number, height: number): void;
  renderNow(): void;
  destroy(): void;
}

interface CubismViewerModule {
  createCubismWebRuntimeAdapter(options: { runtime: CubismEmbedOptions["runtime"] }): {
    prepare(version: number, signal: AbortSignal): Promise<void>;
  };
  CubismModelViewer: new (options: {
    canvas: HTMLCanvasElement;
    onFrame: () => void;
    onContextLost: () => void;
    onContextRestored: () => void;
    onError: (error: unknown) => void;
  }) => RuntimeViewer;
}

export async function loadModelRuntime(
  manifestInput: string | URL | undefined,
  read: (url: string) => Promise<Uint8Array>,
): Promise<CubismEmbedOptions> {
  const url = new URL(manifestInput ?? "https://haneoka.org/embed/manifest.json", globalThis.location?.href);
  const manifest = JSON.parse(new TextDecoder().decode(await read(url.href))) as HostedManifest;
  return resolveHostedCubismRuntime(manifest, url, read);
}

async function create(container: HTMLElement, options: ModelPlayerOptions): Promise<ModelPlayerHandle> {
  const document = container?.ownerDocument;
  const view = document?.defaultView;
  if (!view) throw new TypeError("A browser HTMLElement is required");
  const source = new URL(options.src, document.baseURI);
  const assets = createModelAssets();
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
  const loader = createEmbedLoader({
    assetsBase: new URL(".", source.protocol === "blob:" ? document.baseURI : source).href,
    ...options,
    source: memoryDataSource(null),
  });
  const read = (url: string, consumer = signal) =>
    loader.resourceBytes(url, { signal: AbortSignal.any([consumer, AbortSignal.timeout(30_000)]) });
  const ownCanvas = !(container instanceof view.HTMLCanvasElement);
  const canvas = ownCanvas ? document.createElement("canvas") : (container as HTMLCanvasElement);
  let observer: ResizeObserver | undefined;
  let viewer: RuntimeViewer | undefined;
  let passes: ReturnType<typeof createModelShaderPasses> | undefined;
  const dispose = () => {
    if (controller.signal.aborted) return;
    controller.abort();
    signal.removeEventListener("abort", dispose);
    observer?.disconnect();
    passes?.dispose();
    viewer?.destroy();
    assets.dispose();
    if (ownCanvas) canvas.remove();
    void loader.dispose();
  };
  signal.addEventListener("abort", dispose, { once: true });
  try {
    signal.throwIfAborted();
    const [model, runtimeOptions, shaders] = await Promise.all([
      assets.load(source.href, read, signal, (reference, base) =>
        loader.resourceUrl(new URL(reference, base).href, { signal }),
      ),
      options.runtime ?? loadModelRuntime(options.runtimeManifestUrl, (url) => read(url)),
      loadModelShaders(options, document.baseURI, (url) => read(url)),
    ]);
    signal.throwIfAborted();
    const runtime: CubismViewerModule = await import(/* @vite-ignore */ runtimeOptions.moduleUrl);
    const adapter = runtime.createCubismWebRuntimeAdapter({ runtime: runtimeOptions.runtime });
    await adapter.prepare(3, signal);
    signal.throwIfAborted();
    if (ownCanvas) {
      canvas.style.cssText = "display:block;width:100%;height:100%;";
      container.append(canvas);
    }
    const gl = canvas.getContext("webgl2", { alpha: true, antialias: true, depth: false, stencil: false });
    if (!gl) throw new Error("The Live2D model viewer requires WebGL2");
    const draw = () => passes?.draw();
    viewer = new runtime.CubismModelViewer({
      canvas,
      onFrame: draw,
      onContextLost: () => {
        passes?.dispose();
        passes = undefined;
      },
      onContextRestored: () => {
        resize();
        if (shaders.length) {
          passes = createModelShaderPasses(gl, shaders);
          viewer?.renderNow();
        }
      },
      onError: (error) => options.onError?.(error),
    });
    if (shaders.length) passes = createModelShaderPasses(gl, shaders);
    const active = viewer;
    const resize = () => {
      if (gl.isContextLost()) return;
      const box = canvas.getBoundingClientRect();
      const limit = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
      const scale = Math.min(view.devicePixelRatio, limit / Math.max(1, box.width, box.height));
      active.setSize(Math.max(1, Math.round(box.width * scale)), Math.max(1, Math.round(box.height * scale)));
      if (passes && active.ready) active.renderNow();
    };
    observer = new ResizeObserver(resize);
    observer.observe(canvas);
    resize();
    await active.load({
      modelUrl: model.url,
      ...(options.motion ? { defaultMotionName: options.motion } : {}),
      ...(options.expression ? { defaultExpressionName: options.expression } : {}),
      signal,
    });
    signal.throwIfAborted();
    if (!active.ready) throw new Error("The Live2D model did not become ready");
    if (passes) active.renderNow();
    return {
      canvas,
      motions: model.motions,
      expressions: model.expressions,
      playMotion(name) {
        if (signal.aborted || !model.motions.includes(name)) return false;
        active.playMotion(name);
        return true;
      },
      playExpression(name) {
        if (signal.aborted || !model.expressions.includes(name)) return false;
        active.playExpression(name);
        return true;
      },
      setPaused: (paused) => active.setPaused(paused),
      dispose,
    };
  } catch (error) {
    dispose();
    throw error;
  }
}

export const ModelPlayer = { create };
