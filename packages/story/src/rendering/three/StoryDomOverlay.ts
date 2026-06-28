import type { AdvFrameEntry, AdvVideoEntry } from "../../types/AdvRuntime";
import { computeAdvFrameBandLayout } from "./AdvFrameLayout";
import { AdvRainFrameRenderer } from "./AdvRainFrameRenderer";
import { videoAbortError, waitForVideo } from "./AdvVideoWait";

interface FrameDomEntry {
  readonly root: HTMLDivElement;
  readonly image: HTMLImageElement | null;
  readonly topBand: HTMLDivElement | null;
  readonly bottomBand: HTMLDivElement | null;
  readonly rain: AdvRainFrameRenderer | null;
  readonly frame: AdvFrameEntry;
  slide: number;
}

function absoluteLayer(zIndex: number): HTMLDivElement {
  const element = document.createElement("div");
  Object.assign(element.style, {
    position: "absolute",
    inset: "0",
    zIndex: String(zIndex),
    pointerEvents: "none",
    overflow: "hidden",
  });
  return element;
}

function imageLayer(): HTMLImageElement {
  const image = document.createElement("img");
  image.decoding = "async";
  image.draggable = false;
  Object.assign(image.style, {
    width: "100%",
    height: "100%",
    display: "block",
    objectFit: "cover",
    userSelect: "none",
  });
  return image;
}

function frameTexture(frame: AdvFrameEntry): string {
  if (frame.texture) return frame.texture;
  const textures = Object.values(frame.textures || {}).filter(Boolean);
  return String(textures[0] || frame.elements?.[0]?.texture || frame.edges?.[0]?.texture || "");
}

function frameKind(frame: AdvFrameEntry): string {
  return String(frame.type || frame.name || frame.source || "").toLowerCase();
}

/** DOM-only Unity canvas layers rendered after the camera target. */
export class StoryDomOverlay {
  readonly root = absoluteLayer(20);
  readonly stillLayer = absoluteLayer(30);
  readonly videoLayer = absoluteLayer(28);
  readonly effectLayer = absoluteLayer(40);
  readonly frameLayer = absoluteLayer(50);
  // UIAdvWidget's FrontCanvas (sorting order 304) child order starts with
  // FlashView and RuleTransition, then LocationView, curtains and safe-area UI.
  // These internal values preserve that first pair's order; StoryPlayerFull's
  // canvas-host stacking context keeps the whole root below the sibling DOM
  // implementation of the later FrontCanvas UI children.
  readonly flashLayer = absoluteLayer(55);
  readonly coverLayer = absoluteLayer(56);
  readonly ruleTransitionLayer = absoluteLayer(60);

  private readonly stillBackground = absoluteLayer(0);
  private readonly stillImage = imageLayer();
  private readonly stillShade = absoluteLayer(2);
  private readonly frames = new Map<string, FrameDomEntry>();
  private video: HTMLVideoElement | null = null;
  private videoLoadController: AbortController | null = null;
  private readonly videoWaiters = new Set<() => void>();
  private destroyed = false;
  private readonly mount: HTMLElement;
  private viewportX = 0;
  private viewportY = 0;
  private viewportWidth = 1;
  private viewportHeight = 1;
  private offsetX = 0;
  private offsetY = 0;

  constructor(mount: HTMLElement) {
    this.mount = mount;
    this.root.className = "adv-three-overlay";
    // The canvas host already supplies the Unity Canvas-order stacking
    // boundary. Keeping these two wrappers out of the stacking-context chain
    // lets an additive frame blend against the Three canvas instead of an
    // isolated transparent group.
    this.root.style.zIndex = "auto";
    this.frameLayer.style.zIndex = "auto";
    this.stillBackground.style.background = "#000000";
    this.stillBackground.style.opacity = "0";
    // AdvStillView renders its background behind the Still sprite and its
    // shade overlay in front.  A plain in-flow <img> is painted underneath a
    // positioned z-index:0 sibling, which made an opaque Still background
    // cover the authored sprite entirely.
    Object.assign(this.stillImage.style, {
      position: "absolute",
      inset: "0",
      zIndex: "1",
    });
    this.stillImage.style.opacity = "0";
    this.stillShade.style.background = "#000000";
    this.stillShade.style.opacity = "0";
    this.stillLayer.append(this.stillBackground, this.stillImage, this.stillShade);
    this.coverLayer.style.opacity = "0";
    this.coverLayer.style.visibility = "hidden";
    this.flashLayer.style.opacity = "0";
    this.flashLayer.style.visibility = "hidden";
    this.root.append(
      this.videoLayer,
      this.stillLayer,
      this.effectLayer,
      this.frameLayer,
      this.flashLayer,
      this.coverLayer,
      this.ruleTransitionLayer,
    );
    const position = getComputedStyle(this.mount).position;
    if (position === "static") this.mount.style.position = "relative";
    this.mount.appendChild(this.root);
  }

  setStill(source: string, alpha: number): void {
    if (source && this.stillImage.src !== new URL(source, location.href).href) this.stillImage.src = source;
    if (!source) this.stillImage.removeAttribute("src");
    this.setStillAlpha(source ? alpha : 0);
  }

  setStillAlpha(alpha: number): void {
    this.stillImage.style.opacity = String(clamp(alpha));
  }

  get stillAlpha(): number {
    return clamp(this.stillImage.style.opacity);
  }

  setStillViewAlpha(backgroundAlpha: number, overlayAlpha: number): void {
    this.stillBackground.style.opacity = String(clamp(backgroundAlpha));
    this.stillShade.style.opacity = String(clamp(overlayAlpha));
  }

  get stillBackgroundAlpha(): number {
    return clamp(this.stillBackground.style.opacity);
  }

  get stillOverlayAlpha(): number {
    return clamp(this.stillShade.style.opacity);
  }

  setStillAnimationIndex(index: number): void {
    this.stillImage.dataset.advAnimationIndex = String(Math.max(0, Math.trunc(Number(index) || 0)));
  }

  get stillAnimationIndex(): number {
    return Math.max(0, Math.trunc(Number(this.stillImage.dataset.advAnimationIndex) || 0));
  }

  setCover(color: string, opacity: number): void {
    const alpha = clamp(opacity);
    this.coverLayer.style.background = color || "#000000";
    this.coverLayer.style.opacity = String(alpha);
    // Mobile Safari occasionally keeps a transparent composited layer painted
    // over WebGL after rapid white no-wait transitions. Removing the fully
    // transparent layer from painting makes the terminal state unambiguous.
    this.coverLayer.style.visibility = alpha > 0 ? "visible" : "hidden";
  }

  setFlash(opacity: number): void {
    const alpha = clamp(opacity);
    this.flashLayer.style.background = "#ffffff";
    this.flashLayer.style.opacity = String(alpha);
    this.flashLayer.style.visibility = alpha > 0 ? "visible" : "hidden";
  }

  async setFrame(key: string, frame: AdvFrameEntry, alpha: number): Promise<void> {
    this.clearFrame(key);
    const root = absoluteLayer(50);
    const texture = frameTexture(frame);
    const kind = frameKind(frame);
    let image: HTMLImageElement | null = null;
    let topBand: HTMLDivElement | null = null;
    let bottomBand: HTMLDivElement | null = null;
    let rain: AdvRainFrameRenderer | null = null;
    if (kind.includes("rain")) {
      rain = new AdvRainFrameRenderer(frame);
      // This root is the final compositing group against the Three canvas.
      // Mobile/Particles/Additive is Blend SrcAlpha One, so source black must
      // contribute zero even while the Frame CanvasGroup is fading.
      root.style.mixBlendMode = "plus-lighter";
      root.appendChild(rain.element);
    } else if (kind.includes("letterbox") || kind.includes("cinema")) {
      topBand = absoluteLayer(0);
      bottomBand = absoluteLayer(0);
      root.append(topBand, bottomBand);
    } else if (kind.includes("pillarbox")) {
      const left = absoluteLayer(0);
      const right = absoluteLayer(0);
      Object.assign(left.style, { inset: "0 auto 0 0", width: "10%", background: "#000" });
      Object.assign(right.style, { inset: "0 0 0 auto", width: "10%", background: "#000" });
      root.append(left, right);
    } else if (texture) {
      image = imageLayer();
      image.src = texture;
      root.appendChild(image);
    } else {
      root.style.background = String(frame.color || "#000000");
    }
    root.style.opacity = String(rain ? 0 : clamp(alpha));
    this.frameLayer.appendChild(root);
    const entry = { root, image, topBand, bottomBand, rain, frame, slide: 0 };
    this.frames.set(key, entry);
    this.layoutFrame(entry);
    await rain?.ready;
    if (rain && this.frames.get(key) === entry) root.style.opacity = String(clamp(alpha));
  }

  setFrameOpacity(key: string, alpha: number, slide = 0): void {
    const entry = this.frames.get(key);
    if (!entry) return;
    entry.slide = Number.isFinite(slide) ? slide : 0;
    entry.root.style.opacity = String(clamp(alpha));
    this.layoutFrame(entry);
  }

  clearFrame(key?: string): void {
    if (key) {
      const entry = this.frames.get(key);
      entry?.rain?.destroy();
      entry?.root.remove();
      this.frames.delete(key);
      return;
    }
    for (const entry of this.frames.values()) {
      entry.rain?.destroy();
      entry.root.remove();
    }
    this.frames.clear();
  }

  setEffect(source: string, enabled: boolean): void {
    this.effectLayer.replaceChildren();
    if (!enabled) return;
    const layer = absoluteLayer(0);
    layer.className = "adv-three-command-effect";
    if (source) layer.style.backgroundImage = `url(${JSON.stringify(source).slice(1, -1)})`;
    Object.assign(layer.style, {
      backgroundPosition: "center",
      backgroundRepeat: "no-repeat",
      backgroundSize: "cover",
      mixBlendMode: "screen",
      opacity: "0.7",
    });
    this.effectLayer.appendChild(layer);
  }

  async showVideo(info: AdvVideoEntry | string, playbackRate: number, signal?: AbortSignal): Promise<HTMLVideoElement> {
    if (this.destroyed) throw videoAbortError("Story overlay was destroyed");
    this.clearVideo();
    const loadController = new AbortController();
    const abortLoad = () => loadController.abort();
    if (signal?.aborted) loadController.abort();
    else signal?.addEventListener("abort", abortLoad, { once: true });
    this.videoLoadController = loadController;
    const source = typeof info === "string" ? info : String(info.playableUrl || info.src || info.url || "");
    const video = document.createElement("video");
    video.src = source;
    video.playsInline = true;
    video.preload = "auto";
    video.autoplay = false;
    video.controls = false;
    video.playbackRate = Math.max(0.1, Number(playbackRate) || 1);
    Object.assign(video.style, {
      width: "100%",
      height: "100%",
      display: "block",
      objectFit: "cover",
    });
    this.video = video;
    this.videoLayer.style.opacity = "0";
    this.videoLayer.appendChild(video);
    try {
      await waitForVideo(video, "loadeddata", loadController.signal);
      if (this.destroyed || this.video !== video || loadController.signal.aborted) {
        throw videoAbortError("Video load was cancelled");
      }
      await video.play();
      if (this.destroyed || this.video !== video || loadController.signal.aborted) {
        throw videoAbortError("Video playback was cancelled");
      }
      return video;
    } catch (error) {
      // Decode failure, autoplay rejection and lifecycle cancellation must all
      // unload the element instead of leaving a hidden media decoder.
      if (this.video === video) this.clearVideo();
      throw error;
    } finally {
      signal?.removeEventListener("abort", abortLoad);
      if (this.videoLoadController === loadController) this.videoLoadController = null;
    }
  }

  setVideoAlpha(alpha: number): void {
    this.videoLayer.style.opacity = String(clamp(alpha));
  }

  get videoElement(): HTMLVideoElement | null {
    return this.video;
  }

  waitVideoEnded(signal?: AbortSignal): Promise<void> {
    const video = this.video;
    if (!video || video.ended || this.destroyed || signal?.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      let settled = false;
      const done = (): void => {
        if (settled) return;
        settled = true;
        video.removeEventListener("ended", done);
        video.removeEventListener("error", done);
        signal?.removeEventListener("abort", done);
        this.videoWaiters.delete(done);
        resolve();
      };
      this.videoWaiters.add(done);
      video.addEventListener("ended", done, { once: true });
      // A decode/network failure stops media playback without dispatching
      // `ended`. Treat it as a terminal media state so an AdvVideo command
      // cannot leave the story scheduler waiting forever.
      video.addEventListener("error", done, { once: true });
      signal?.addEventListener("abort", done, { once: true });
      if (this.destroyed || this.video !== video || signal?.aborted) done();
    });
  }

  clearVideo(): void {
    this.videoLoadController?.abort();
    this.videoLoadController = null;
    for (const settle of [...this.videoWaiters]) settle();
    if (this.video) {
      this.video.pause();
      this.video.removeAttribute("src");
      this.video.load();
    }
    this.video = null;
    this.videoLayer.replaceChildren();
    this.videoLayer.style.opacity = "0";
  }

  setOffset(x: number, y: number): void {
    this.offsetX = Number.isFinite(x) ? x : 0;
    this.offsetY = Number.isFinite(y) ? y : 0;
    this.layoutRoot();
  }

  setStillOffset(x: number, y: number): void {
    const offsetX = Number.isFinite(x) ? x : 0;
    const offsetY = Number.isFinite(y) ? y : 0;
    this.stillLayer.style.transform = `translate3d(${offsetX}px, ${offsetY}px, 0)`;
  }

  setViewport(x: number, y: number, width: number, height: number): void {
    this.viewportX = Number.isFinite(x) ? x : 0;
    this.viewportY = Number.isFinite(y) ? y : 0;
    this.viewportWidth = Math.max(0, width);
    this.viewportHeight = Math.max(0, height);
    Object.assign(this.root.style, {
      inset: "auto",
      width: `${width}px`,
      height: `${height}px`,
    });
    this.layoutRoot();
    for (const entry of this.frames.values()) this.layoutFrame(entry);
  }

  private layoutRoot(): void {
    // A transform would isolate descendants' blend modes. Apply UI shake via
    // layout coordinates so rain remains in the Three canvas' blend group.
    this.root.style.removeProperty("transform");
    this.root.style.left = `${this.viewportX + this.offsetX}px`;
    this.root.style.top = `${this.viewportY + this.offsetY}px`;
  }

  private layoutFrame(entry: FrameDomEntry): void {
    entry.rain?.setViewport(this.viewportWidth, this.viewportHeight);
    if (!entry.topBand || !entry.bottomBand) return;
    const layout = computeAdvFrameBandLayout(entry.frame, this.viewportWidth, entry.slide);
    Object.assign(entry.topBand.style, {
      inset: "0 0 auto",
      height: `${layout.bandHeight}px`,
      background: layout.color,
      transform: `translate3d(0, ${layout.topOffset}px, 0)`,
    });
    Object.assign(entry.bottomBand.style, {
      inset: "auto 0 0",
      height: `${layout.bandHeight}px`,
      background: layout.color,
      transform: `translate3d(0, ${layout.bottomOffset}px, 0)`,
    });
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.clearVideo();
    this.clearFrame();
    this.root.remove();
  }
}

function clamp(value: unknown): number {
  const numeric = Number(value);
  return Math.max(0, Math.min(1, Number.isFinite(numeric) ? numeric : 0));
}
