import { readPageData } from "../lib/page-data";
import { navigationDocumentUrl } from "../lib/document-url";
import { canvasToPngBlob, downloadBlob } from "../lib/canvas-capture";
import { facet } from "./ui/facet";
import { accordion } from "./ui/accordion";
import { collectionList, collectionTable, collectionView, viewSwitch, type CollectionView } from "./ui/collection-view";
import { LitElement, html, nothing } from "lit";
import { keyed } from "lit/directives/keyed.js";
import { catalogUrl, fetchJson, localizedText, preferredLocale, readPath, uiText } from "./shared/catalog";
import { clearBrowseBar, filterGroup, renderBrowse } from "./ui/browse";
import { modelTile, modelTitle, modelPreviewSources, subCharacterLabel } from "./ui/model-tile";

import { EXPANDED, matches, watchMedia } from "./ui/media";
import { LazyImages } from "./ui/lazy-images";
import { PaneFocus } from "./ui/pane";
import { errorState, loadingState } from "./ui/state";
import { entityHref, parseEntitySelection, returnStateFromLocation } from "../lib/resource-route";
import { readReleaseServer } from "../lib/release-server";
import { openDetailLocation, updateEntityHeading } from "../lib/detail-navigation";
import type { Locale } from "@haneoka/i18n";
import { viewerBufferSize } from "./runtime/viewer-resolution";
import { segmented } from "./ui/controls";
import { CUBISM_CORE_URLS, CUBISM_WEB_RUNTIME_URL } from "../lib/cubism-runtime";
import type { CubismTextureVariant } from "@haneoka/vega-plugin-cubism";

type Value = Record<string, unknown>;
type Parameter = { id: string; value: number; minimum: number; maximum: number; defaultValue: number };
type Part = { id: string; opacity: number };
type StoredPose = { name: string; parameters: Record<string, number>; parts: Record<string, number> };
type PackagingProgress = {
  stage: "manifest" | "resources" | "archive";
  completed: number;
  total?: number;
  loadedBytes: number;
};
const POSE_STORAGE_KEY = "haneoka.live2d.poses";
const CAPTURE_PIXEL_BUDGET = 4_000_000;
let live2dAccordionId = 0;
interface Viewer {
  readonly ready: boolean;
  readonly isMotionPlaying: boolean;
  readonly isMotionBusy: boolean;
  captureFrame(notify?: boolean): boolean;
  captureSupersampled(scale: number, copy: (canvas: HTMLCanvasElement) => void): boolean;
  load(options: {
    modelUrl: string;
    textureVariants?: readonly CubismTextureVariant[];
    harmonicMotion?: unknown;
    defaultMotionName?: string;
    autoIdleMotion?: boolean;
    defaultExpressionName?: string;
    signal?: AbortSignal;
  }): Promise<void>;
  setSize(width: number, height: number): void;
  setBreathEnabled(value: boolean): void;
  setEyeBlinkEnabled(value: boolean): void;
  setPaused(value: boolean): void;
  setPoseFrozen(value: boolean): void;
  setLoopMotion(name: string | null): void;
  setParameterOverrides(values: Record<string, number>): void;
  setPartOpacity(id: string, opacity: number): void;
  setBackgroundColor(color: { r: number; g: number; b: number } | null): void;
  setTransform(transform: { offsetX: number; offsetY: number; scale: number }): void;
  setLookPosition(x: number, y: number): void;
  setLookAtClientPosition(clientX: number, clientY: number, anchor?: { x: number; y: number } | null): void;
  parameters(): Parameter[];
  parts(): Part[];
  playMotion(
    name: string,
    fadeInSecondsOrOptions?: number | { oneShot?: boolean },
    options?: { oneShot?: boolean },
  ): boolean;
  finishMotionPreview(): void;
  playExpression(name: string): boolean;
  stopMotions(): void;
  destroy(): void;
}

export class Live2DWorkspace extends LitElement {
  static properties = {
    locale: { type: String },
    entityId: { type: String, attribute: "entity-id" },
    previewSrc: { type: String, attribute: "preview-src" },
    phase: { state: true },
    modelPhase: { state: true },
    modelError: { state: true },
    capturing: { state: true },
    captureMessage: { state: true },
    packaging: { state: true },
    packagingProgress: { state: true },
    packagingError: { state: true },
    models: { state: true },
    selected: { state: true },
    detail: { state: true },
    paused: { state: true },
    breath: { state: true },
    blink: { state: true },
    sway: { state: true },
    loopMotion: { state: true },
    selectedMotion: { state: true },
    dragEnabled: { state: true },
    backgroundTransparent: { state: true },
    backgroundColor: { state: true },
    error: { state: true },
    view: { state: true },
    query: { state: true },
    sort: { state: true },
    order: { state: true },
    filtersOpen: { state: true },
    metaFilters: { state: true },
    bandFilter: { state: true },
    characterFilter: { state: true },
    typeFilter: { state: true },
    parameters: { state: true },
    parameterOverrides: { state: true },
    parameterMode: { state: true },
    parametersExpanded: { state: true },
    partsExpanded: { state: true },
    parts: { state: true },
    poses: { state: true },
    poseId: { state: true },
    renamingPose: { state: true },
    poseNameDraft: { state: true },
    modelScale: { state: true },
    offsetX: { state: true },
    offsetY: { state: true },
    lookX: { state: true },
    lookY: { state: true },
    docked: { state: true },
  };
  declare capturing: boolean;
  declare captureMessage: string;
  declare packaging: boolean;
  declare locale: string;
  declare entityId: string;
  declare previewSrc: string;
  declare phase: "loading" | "ready" | "error";
  declare modelPhase: "idle" | "loading" | "ready" | "error";
  declare modelError: string;
  declare models: Value[];
  declare selected: string;
  declare detail: Value | null;
  declare paused: boolean;
  declare breath: boolean;
  declare blink: boolean;
  declare sway: boolean;
  declare loopMotion: boolean;
  declare selectedMotion: string;
  declare dragEnabled: boolean;
  declare backgroundTransparent: boolean;
  declare backgroundColor: string;
  declare error: string;
  declare view: CollectionView;
  declare query: string;
  declare sort: "id" | "title" | "type" | "character" | "band";
  declare order: "asc" | "desc";
  declare filtersOpen: boolean;
  declare metaFilters: Record<string, string>;
  declare docked: boolean;
  declare packagingProgress: PackagingProgress | null;
  declare packagingError: string;
  declare bandFilter: number;
  declare characterFilter: string;
  declare typeFilter: string;
  declare parameters: Parameter[];
  declare parameterOverrides: Record<string, number>;
  declare parameterMode: "none" | "capture" | "pose";
  declare parametersExpanded: boolean;
  declare partsExpanded: boolean;
  declare parts: Part[];
  declare poses: Record<string, StoredPose>;
  declare poseId: string;
  declare renamingPose: boolean;
  declare poseNameDraft: string;
  declare modelScale: number;
  declare offsetX: number;
  declare offsetY: number;
  declare lookX: number;
  declare lookY: number;
  private characters: Value[] = [];
  private bands: Value[] = [];
  private viewer?: Viewer;
  private resizeObserver?: ResizeObserver;
  private generation = 0;
  private catalogAbortController?: AbortController;
  private selectionAbortController?: AbortController;
  private packagingAbortController?: AbortController;
  private releasedViewers = new WeakSet<Viewer>();
  private captureUpdatedAt = 0;
  private pendingPoseCapture = false;
  private initialPartOpacities: Record<string, number> = {};
  private partOverrides: Record<string, number> = {};
  private dragging = false;
  private dragPointerId: number | null = null;
  private dragLastX = 0;
  private dragLastY = 0;
  private initializationTimer?: number;
  private ssrStageRemoved = false;
  private readonly editorId = `live2d-editor-${++live2dAccordionId}`;

  constructor() {
    super();
    this.capturing = false;
    this.captureMessage = "";
    this.packaging = false;
    this.packagingProgress = null;
    this.packagingError = "";
    this.locale = "ja";
    this.entityId = "";
    this.previewSrc = "";
    this.phase = "loading";
    this.modelPhase = "idle";
    this.modelError = "";
    this.models = [];
    this.selected = "";
    this.detail = null;
    this.paused = false;
    // Procedural breathing, blinking and pointer tracking are opt-in.
    this.breath = false;
    this.blink = false;
    this.sway = false;
    this.loopMotion = false;
    this.selectedMotion = "";
    this.dragEnabled = false;
    this.backgroundTransparent = true;
    this.backgroundColor = "#ecf0f1";
    this.error = "";
    this.view = "grid";
    this.query = "";
    this.sort = "id";
    this.order = "asc";
    this.filtersOpen = false;
    this.metaFilters = {};
    this.docked = matches(EXPANDED);
    this.bandFilter = 0;
    this.characterFilter = "";
    this.typeFilter = "";
    this.parameters = [];
    this.parameterOverrides = {};
    this.parameterMode = "none";
    this.parametersExpanded = false;
    this.partsExpanded = false;
    this.parts = [];
    this.poses = {};
    this.poseId = "";
    this.renamingPose = false;
    this.poseNameDraft = "";
    this.modelScale = 1;
    this.offsetX = 0;
    this.offsetY = 0;
    this.lookX = 0;
    this.lookY = 0;
  }
  createRenderRoot() {
    return this;
  }
  private isAbortError(error: unknown): boolean {
    return (
      (typeof DOMException !== "undefined" && error instanceof DOMException && error.name === "AbortError") ||
      (error instanceof Error && error.name === "AbortError")
    );
  }
  private isActiveSelection(generation: number, controller: AbortController, key: string): boolean {
    return (
      this.isConnected &&
      generation === this.generation &&
      this.selectionAbortController === controller &&
      !controller.signal.aborted &&
      this.selected === key
    );
  }
  private releaseViewer(viewer?: Viewer) {
    const target = viewer ?? this.viewer;
    const ownsObserver = !viewer || this.viewer === viewer;
    if (ownsObserver) {
      this.resizeObserver?.disconnect();
      this.resizeObserver = undefined;
      if (this.viewer === target) this.viewer = undefined;
    }
    if (target && !this.releasedViewers.has(target)) {
      this.releasedViewers.add(target);
      target.destroy();
    }
  }
  private abortPackaging() {
    this.packagingAbortController?.abort();
    this.packagingAbortController = undefined;
    this.packaging = false;
    this.packagingProgress = null;
    this.packagingError = "";
  }
  connectedCallback() {
    super.connectedCallback();
    const selection = parseEntitySelection(navigationDocumentUrl().pathname);
    if (selection?.source === "canonical" && selection.route.kind === "live2d") this.entityId = selection.route.id;
    this.locale = preferredLocale(this.locale);
    this.disposeMedia = watchMedia(EXPANDED, (value) => (this.docked = value));
    void Promise.all([
      import("@material/web/select/outlined-select.js"),
      import("@material/web/select/select-option.js"),
      import("@material/web/textfield/outlined-text-field.js"),
      import("@material/web/slider/slider.js"),
      import("@material/web/switch/switch.js"),
      import("@material/web/progress/circular-progress.js"),
    ]);
    if (this.initializationTimer != null) window.clearTimeout(this.initializationTimer);
    this.initializationTimer = window.setTimeout(() => {
      this.initializationTimer = undefined;
      if (!this.isConnected) return;
      const params = new URLSearchParams(location.search);
      this.selected = this.entityId || params.get("model") || "";
      this.query = params.get("q") || "";
      this.view = collectionView(params.get("view"));
      this.metaFilters = Object.fromEntries(
        ["quality", "costumeId", "subCharacter", "preview"].map((key) => [key, params.get(key) || ""]),
      );
      const sort = params.get("sort");
      this.sort = sort === "title" || sort === "type" || sort === "character" || sort === "band" ? sort : "id";
      this.order = params.get("order") === "desc" ? "desc" : "asc";
      this.bandFilter = Number(params.get("band") || 0);
      const characterParam = params.get("character") || "";
      this.characterFilter = /^\d+$/.test(characterParam) || characterParam.startsWith("key:") ? characterParam : "";
      this.typeFilter = params.get("type") || "";
      void this.loadCatalog();
    }, 0);
  }
  disconnectedCallback() {
    if (this.initializationTimer != null) {
      window.clearTimeout(this.initializationTimer);
      this.initializationTimer = undefined;
    }
    clearBrowseBar();
    this.lazyImages.disconnect();
    this.disposeMedia?.();
    this.paneFocus.detach();
    this.generation += 1;
    this.catalogAbortController?.abort();
    this.catalogAbortController = undefined;
    this.selectionAbortController?.abort();
    this.selectionAbortController = undefined;
    this.abortPackaging();
    this.endDrag();
    this.releaseViewer();
    this.loopMotion = false;
    this.selectedMotion = "";
    this.pendingPoseCapture = false;
    this.modelPhase = "idle";
    this.modelError = "";
    super.disconnectedCallback();
  }
  private disposeMedia?: () => void;
  private paneFocus = new PaneFocus();
  private lazyImages = new LazyImages();
  private text(value: unknown): string {
    return localizedText(value, this.locale);
  }
  private key(model: Value) {
    return String(model.live2dKey || model.assetId || "");
  }
  private modelTitle(model: Value) {
    return modelTitle(model, this.locale).text;
  }
  private preview(model: Value) {
    return modelPreviewSources(model)[0] || "";
  }
  private previewSource(detail?: Value | null): string {
    const selected = this.models.find((model) => this.key(model) === this.selected);
    const renderedPreview = [detail, selected]
      .flatMap((model) => (model ? [readPath(model, "preview.image"), readPath(model, "preview.runtime")] : []))
      .find((source): source is string => typeof source === "string" && Boolean(source));
    return (
      renderedPreview || this.previewSrc || (detail && this.preview(detail)) || (selected ? this.preview(selected) : "")
    );
  }
  private previewRatio(detail?: Value | null): string {
    const values = [
      detail?.preview,
      detail?.runtime && typeof detail.runtime === "object" ? (detail.runtime as Value).preview : undefined,
      this.selected ? this.models.find((model) => this.key(model) === this.selected)?.preview : undefined,
    ];
    for (const value of values) {
      if (!value || typeof value !== "object") continue;
      const preview = value as Value;
      const width = Number(preview.width || preview.imageWidth || preview.naturalWidth || 0);
      const height = Number(preview.height || preview.imageHeight || preview.naturalHeight || 0);
      if (width > 0 && height > 0) return `${width} / ${height}`;
      const ratio = Number(preview.aspectRatio || preview.ratio || 0);
      if (ratio > 0) return `${ratio}`;
    }
    return "";
  }
  private defaultMotionName(detail: Value | null, motions: Value[]): string {
    const runtime = detail?.runtime && typeof detail.runtime === "object" ? (detail.runtime as Value) : null;
    return String(
      readPath(detail || {}, "profile.defaultMotionName") ||
        readPath(detail || {}, "runtime.profile.defaultMotionName") ||
        runtime?.defaultMotionName ||
        detail?.defaultMotionName ||
        motions[0]?.name ||
        "",
    );
  }
  private harmonicMotionData(detail: Value | null): unknown {
    const runtime = detail?.runtime && typeof detail.runtime === "object" ? (detail.runtime as Value) : null;
    return (
      runtime?.harmonicMotion ??
      detail?.harmonicMotion ??
      readPath(detail || {}, "profile.harmonicMotion") ??
      readPath(runtime || {}, "profile.harmonicMotion")
    );
  }
  private url(path = "") {
    return catalogUrl("live2d", path);
  }
  private async loadCatalog() {
    const page = readPageData<{ schema: string; id: string; model: Value }>(this);
    if (page?.schema === "haneoka-model-page-v1" && page.id === this.entityId) {
      this.models = [page.model];
      this.phase = "ready";
      if (this.modelPhase !== "ready") void this.select(page.id, false, page.model);
      return;
    }
    this.catalogAbortController?.abort();
    const controller = new AbortController();
    this.catalogAbortController = controller;
    this.phase = "loading";
    this.error = "";
    // Canonical detail loading does not depend on the collection indexes. Start
    // it now so the catalog, characters, bands, and model detail can arrive in
    // parallel without creating a second viewer instance.
    if (this.selected && this.modelPhase !== "ready") void this.select(this.selected, false);
    try {
      const [value, characters, bands] = await Promise.all([
        fetchJson<Record<string, Value>>(this.url(), { signal: controller.signal }),
        fetchJson<Record<string, Value>>(catalogUrl("characters"), { signal: controller.signal }),
        fetchJson<Record<string, Value>>(catalogUrl("bands"), { signal: controller.signal }),
      ]);
      if (controller.signal.aborted || this.catalogAbortController !== controller || !this.isConnected) return;
      this.models = Object.values(value);
      this.characters = Object.values(characters);
      this.bands = Object.values(bands);
      this.phase = "ready";
    } catch (error) {
      if (controller.signal.aborted || this.catalogAbortController !== controller || !this.isConnected) return;
      this.phase = "error";
      const message = error instanceof Error ? error.message : String(error);
      this.error = message;
      // A selected detail request is independent of the collection indexes. Do
      // not replace a usable detail view, but keep an unresolved failure
      // visible through the same non-empty model error channel.
    }
  }
  private async select(key: string, updateUrl = true, prepared?: Value) {
    if (updateUrl && key !== this.entityId) {
      openDetailLocation(
        entityHref({
          server: readReleaseServer(),
          locale: preferredLocale(this.locale) as Locale,
          kind: "live2d",
          id: key,
          returnTo: this.entityId
            ? new URLSearchParams(location.search).get("return") || undefined
            : returnStateFromLocation(location.pathname, location.search, "live2d"),
        }),
      );
      return;
    }
    const generation = ++this.generation;
    this.dataset.entityReady = "false";
    this.selectionAbortController?.abort();
    const controller = new AbortController();
    this.selectionAbortController = controller;
    this.abortPackaging();
    this.endDrag();
    this.releaseViewer();
    this.selected = key;
    this.detail = null;
    this.modelPhase = "loading";
    this.modelError = "";
    this.parameters = [];
    this.parameterOverrides = {};
    this.parameterMode = "none";
    this.parametersExpanded = false;
    this.partsExpanded = false;
    this.pendingPoseCapture = false;
    this.loopMotion = false;
    this.selectedMotion = "";
    this.parts = [];
    this.initialPartOpacities = {};
    this.partOverrides = {};
    this.poses = this.readPoses(key);
    this.poseId = "";
    this.renamingPose = false;
    this.poseNameDraft = "";
    if (updateUrl) {
      const params = new URLSearchParams(location.search);
      params.set("model", key);
      history.replaceState(history.state, "", `${location.pathname}?${params}`);
    }
    try {
      const detail = prepared || (await fetchJson<Value>(this.url(key), { signal: controller.signal }));
      if (!this.isActiveSelection(generation, controller, key)) return;
      this.detail = detail;
      await this.loadViewer(detail, generation, controller, key);
    } catch (error) {
      if (!this.isActiveSelection(generation, controller, key) || this.isAbortError(error)) return;
      this.releaseViewer();
      this.modelPhase = "error";
      this.modelError = error instanceof Error ? error.message : String(error);
    }
  }
  private retryModel() {
    if (this.phase === "error") {
      void this.loadCatalog();
      return;
    }
    if (!this.selected) return;
    const key = this.selected;
    void this.select(key, false);
  }
  private async loadViewer(detail: Value, generation: number, controller: AbortController, key: string) {
    await this.updateComplete;
    if (!this.isActiveSelection(generation, controller, key)) return;
    const canvas = this.querySelector<HTMLCanvasElement>("canvas");
    if (!canvas) throw new Error("Live2D viewer canvas is unavailable");
    const source = detail.runtime && typeof detail.runtime === "object" ? (detail.runtime as Value) : detail;
    const modelUrl = String(source.model || "");
    if (!modelUrl) throw new Error(uiText(this.locale, "modelDescriptorMissing"));
    const motions = Array.isArray(detail.motions) ? (detail.motions as Value[]) : [];
    const defaultMotion = this.defaultMotionName(detail, motions);
    const defaultExpression = String(
      readPath(detail, "profile.defaultExpressionName") ||
        readPath(detail, "runtime.profile.defaultExpressionName") ||
        readPath(detail, "runtime.defaultExpressionName") ||
        detail.defaultExpressionName ||
        "",
    );
    const runtime = (await import(/* @vite-ignore */ CUBISM_WEB_RUNTIME_URL)) as unknown as {
      CubismModelViewer: new (options: {
        canvas: HTMLCanvasElement;
        onFrame?(): void;
        onContextLost?(): void;
        onContextRestored?(): void;
        onError(error: unknown): void;
      }) => Viewer;
      createCubismWebRuntimeAdapter(options: Value): { prepare(version: number, signal: AbortSignal): Promise<void> };
    };
    if (!this.isActiveSelection(generation, controller, key)) return;
    const adapter = runtime.createCubismWebRuntimeAdapter({
      runtime: CUBISM_CORE_URLS,
    });
    await adapter.prepare(3, controller.signal);
    if (!this.isActiveSelection(generation, controller, key)) return;
    let viewer: Viewer | undefined;
    try {
      viewer = new runtime.CubismModelViewer({
        canvas,
        onFrame: () => {
          if (viewer && this.isActiveSelection(generation, controller, key) && this.viewer === viewer) {
            this.handleViewerFrame(viewer, generation, controller, key);
            if (viewer.ready && this.modelPhase === "ready") this.dataset.entityReady = "true";
          }
        },
        onContextLost: () => {
          if (viewer && this.isActiveSelection(generation, controller, key) && this.viewer === viewer) {
            this.cancelPosePreview();
            viewer.setPoseFrozen(this.parameterMode === "pose");
            this.modelPhase = "loading";
          }
        },
        onContextRestored: () => {
          if (viewer && this.isActiveSelection(generation, controller, key) && this.viewer === viewer) {
            this.restoreViewerState(viewer, generation, controller, key);
            this.modelPhase = "ready";
          }
        },
        onError: (error) => {
          if (!viewer || !this.isActiveSelection(generation, controller, key) || this.viewer !== viewer) return;
          this.modelPhase = "error";
          this.modelError = error instanceof Error ? error.message : String(error);
          this.loopMotion = false;
          this.pendingPoseCapture = false;
          this.releaseViewer(viewer);
        },
      });
      if (!this.isActiveSelection(generation, controller, key)) {
        this.releaseViewer(viewer);
        return;
      }
      this.viewer = viewer;
      const resize = () => {
        if (!this.isActiveSelection(generation, controller, key) || this.viewer !== viewer) return;
        const rect = canvas.getBoundingClientRect();
        const gl = canvas.getContext("webgl2");
        if (!gl || gl.isContextLost()) return;
        const size = viewerBufferSize(rect.width, rect.height, gl);
        viewer!.setSize(size.width, size.height);
      };
      this.resizeObserver?.disconnect();
      this.resizeObserver = new ResizeObserver(resize);
      this.resizeObserver.observe(canvas);
      resize();
      await viewer!.load({
        modelUrl,
        textureVariants: Array.isArray(readPath(detail, "runtime.textureVariants"))
          ? (readPath(detail, "runtime.textureVariants") as CubismTextureVariant[])
          : undefined,
        harmonicMotion: this.harmonicMotionData(detail),
        defaultMotionName: defaultMotion || undefined,
        autoIdleMotion: false,
        defaultExpressionName: defaultExpression || undefined,
        signal: controller.signal,
      });
      if (!this.isActiveSelection(generation, controller, key) || this.viewer !== viewer) {
        this.releaseViewer(viewer);
        return;
      }
      this.parameters = viewer.parameters();
      this.parts = viewer.parts();
      this.initialPartOpacities = Object.fromEntries(this.parts.map((part) => [part.id, part.opacity]));
      this.restoreViewerState(viewer, generation, controller, key);
      if (!this.isActiveSelection(generation, controller, key) || this.viewer !== viewer) {
        this.releaseViewer(viewer);
        return;
      }
      this.modelPhase = "ready";
    } catch (error) {
      this.releaseViewer(viewer);
      throw error;
    }
  }
  private restoreViewerState(viewer: Viewer, generation: number, controller: AbortController, key: string) {
    if (!this.isActiveSelection(generation, controller, key) || this.viewer !== viewer) return;
    const poseFrozen = this.parameterMode === "pose";
    viewer.setBreathEnabled(this.breath);
    viewer.setEyeBlinkEnabled(this.blink);
    viewer.setPaused(this.paused);
    viewer.setPoseFrozen(poseFrozen);
    viewer.setParameterOverrides(poseFrozen ? this.parameterOverrides : {});
    const parts = poseFrozen
      ? this.parts.map((part) => [part.id, part.opacity] as const)
      : Object.entries(this.partOverrides);
    for (const [id, opacity] of parts) viewer.setPartOpacity(id, opacity);
    viewer.setLoopMotion(this.loopMotion && !poseFrozen ? this.selectedMotion : null);
    const match = /^#?([0-9a-f]{6})$/i.exec(this.backgroundColor.trim());
    if (this.backgroundTransparent || !match) {
      viewer.setBackgroundColor(null);
    } else {
      const hex = match[1];
      viewer.setBackgroundColor({
        r: parseInt(hex.slice(0, 2), 16) / 255,
        g: parseInt(hex.slice(2, 4), 16) / 255,
        b: parseInt(hex.slice(4, 6), 16) / 255,
      });
    }
    viewer.setTransform({ offsetX: this.offsetX, offsetY: this.offsetY, scale: this.modelScale });
    viewer.setLookPosition(this.lookX, this.lookY);
    this.parameters = viewer.parameters();
    this.parts = viewer.parts();
  }
  private setParameter(parameter: Parameter, value: number) {
    if (this.parameterMode !== "pose" || this.pendingPoseCapture) this.setParameterMode("pose");
    this.parameterOverrides = { ...this.parameterOverrides, [parameter.id]: value };
    this.viewer?.setParameterOverrides(this.parameterOverrides);
  }
  private resetParameter(parameter: Parameter) {
    this.setParameter(parameter, parameter.defaultValue);
  }
  private resetParameters() {
    this.cancelPosePreview();
    if (this.parameterMode === "pose") {
      this.viewer?.setPoseFrozen(true);
      // Pose mode restores every authored default value.
      this.parameterOverrides = Object.fromEntries(
        (this.viewer?.parameters() || this.parameters).map((parameter) => [parameter.id, parameter.defaultValue]),
      );
      this.viewer?.setParameterOverrides(this.parameterOverrides);
      return;
    }
    this.parameterOverrides = {};
    this.viewer?.setParameterOverrides({});
  }
  private setParameterMode(mode: "none" | "capture" | "pose") {
    this.cancelPosePreview();
    if (mode === "pose") this.stopMotion();
    this.parameterMode = mode;
    if (mode === "none" || mode === "capture") {
      this.parameterOverrides = {};
      this.viewer?.setParameterOverrides({});
    }
    if (mode === "pose") {
      this.parameterOverrides = Object.fromEntries(
        (this.viewer?.parameters() || this.parameters).map((parameter) => [parameter.id, parameter.value]),
      );
      this.viewer?.setParameterOverrides(this.parameterOverrides);
    }
    // Pose mode freezes every animation channel so only the sliders move the
    // model; the snapshot above is exactly what gets frozen.
    this.viewer?.setPoseFrozen(mode === "pose");
  }
  private snapshotPoseOverrides() {
    this.parameterOverrides = Object.fromEntries(
      (this.viewer?.parameters() || this.parameters).map((parameter) => [parameter.id, parameter.value]),
    );
    this.parameters = this.viewer?.parameters() || this.parameters;
    this.viewer?.setParameterOverrides(this.parameterOverrides);
  }
  private handleViewerFrame(viewer: Viewer, generation: number, controller: AbortController, key: string) {
    if (!this.isActiveSelection(generation, controller, key) || this.viewer !== viewer) return;
    // A motion started from pose mode plays out once, then the final frame is
    // re-captured as the editable pose after the motion finishes.
    if (this.pendingPoseCapture && !viewer.isMotionBusy) {
      this.pendingPoseCapture = false;
      this.snapshotPoseOverrides();
      viewer.setPoseFrozen(true);
      viewer.stopMotions();
      return;
    }
    if (this.parameterMode !== "capture") return;
    const now = performance.now();
    if (now - this.captureUpdatedAt < 240) return;
    this.captureUpdatedAt = now;
    this.parameters = viewer.parameters();
  }
  private playMotion(name: string) {
    if (this.modelPhase !== "ready" || !this.viewer) return;
    const motions = Array.isArray(this.detail?.motions) ? (this.detail.motions as Value[]) : [];
    if (!name || !motions.some((motion) => motion.name === name)) {
      this.selectedMotion = "";
      this.stopMotion();
      return;
    }
    this.selectedMotion = name;
    this.cancelPosePreview();
    this.viewer.stopMotions();
    this.viewer.setLoopMotion(this.loopMotion ? name : null);
    if (this.parameterMode === "pose") {
      // Let the clip advance so it can finish before re-freezing.
      if (this.paused) {
        this.paused = false;
        this.viewer?.setPaused(false);
      }
      this.viewer?.setPoseFrozen(false);
      this.pendingPoseCapture = true;
      // The viewer suspends its overrides for this preview. Keep the host's
      // last accepted pose so it can recover after a context interruption.
      this.viewer?.playMotion(name, { oneShot: true });
      return;
    }
    this.viewer?.playMotion(name);
  }
  private cancelPosePreview() {
    if (!this.pendingPoseCapture) return;
    this.pendingPoseCapture = false;
    this.viewer?.stopMotions();
  }
  private stopMotion() {
    this.pendingPoseCapture = false;
    if (this.parameterMode === "pose") {
      this.snapshotPoseOverrides();
      this.viewer?.setPoseFrozen(true);
    }
    this.viewer?.stopMotions();
    // The runtime clears its loop name when stopping; keep the public switch in
    // sync with that actual state.
    this.loopMotion = false;
  }
  private async importParameters(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    const generation = this.generation;
    const key = this.selected;
    const controller = this.selectionAbortController;
    try {
      const parsed = JSON.parse(await file.text()) as Value;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
      if (!controller || !this.isActiveSelection(generation, controller, key)) return;
      const source = parsed.parameters && typeof parsed.parameters === "object" ? (parsed.parameters as Value) : parsed;
      if (
        Array.isArray(source) ||
        !Object.entries(source).some(
          ([id, value]) =>
            this.parameters.some((parameter) => parameter.id === id) &&
            typeof value === "number" &&
            Number.isFinite(value),
        )
      )
        throw new Error();
      const values: Record<string, number> = {};
      // Imported poses are normalized to a complete snapshot. A sparse file
      // keeps the current value for omitted parameters instead of allowing
      // those channels to be re-evaluated by a later model update.
      for (const parameter of this.viewer?.parameters() || this.parameters) {
        const value = source[parameter.id];
        const next = typeof value === "number" && Number.isFinite(value) ? value : parameter.value;
        values[parameter.id] = Math.min(parameter.maximum, Math.max(parameter.minimum, next));
      }
      this.modelError = "";
      this.poseId = "";
      this.cancelPosePreview();
      this.stopMotion();
      this.parameterMode = "pose";
      this.parameterOverrides = values;
      this.viewer?.setPoseFrozen(true);
      this.viewer?.setParameterOverrides(values);
      const parts = parsed.parts && typeof parsed.parts === "object" ? (parsed.parts as Value) : null;
      if (parts) {
        for (const [id, raw] of Object.entries(parts)) {
          const opacity = raw;
          if (typeof opacity !== "number" || !Number.isFinite(opacity)) continue;
          this.applyPartOpacity(id, Math.min(1, Math.max(0, opacity)));
        }
      }
    } catch {
      if (!controller || !this.isActiveSelection(generation, controller, key)) return;
      this.modelError = uiText(this.locale, "invalidParameterPose");
    }
  }
  private exportParameters() {
    const values =
      this.parameterMode === "pose"
        ? this.parameterOverrides
        : Object.fromEntries(
            (this.viewer?.parameters() || this.parameters).map((parameter) => [parameter.id, parameter.value]),
          );
    const parts = Object.fromEntries((this.viewer?.parts() || this.parts).map((part) => [part.id, part.opacity]));
    const blob = new Blob(
      [JSON.stringify({ model: this.selected, mode: "pose", parameters: values, parts }, null, 2)],
      {
        type: "application/json",
      },
    );
    void downloadBlob(blob, `${this.selected || "live2d"}.pose.json`);
  }
  private applyTransform() {
    this.viewer?.setTransform({ offsetX: this.offsetX, offsetY: this.offsetY, scale: this.modelScale });
  }
  private applyLook() {
    this.viewer?.setLookPosition(this.lookX, this.lookY);
  }
  private toggle(kind: "breath" | "blink" | "sway" | "loop" | "drag" | "transparent" | "paused") {
    if (kind === "breath") {
      this.breath = !this.breath;
      this.viewer?.setBreathEnabled(this.breath);
    }
    if (kind === "blink") {
      this.blink = !this.blink;
      this.viewer?.setEyeBlinkEnabled(this.blink);
    }
    if (kind === "sway") {
      this.sway = !this.sway;
      if (!this.sway) {
        this.applyLook();
      }
    }
    if (kind === "loop") {
      if (this.loopMotion) {
        this.loopMotion = false;
        this.viewer?.setLoopMotion(null);
      } else if (this.modelPhase === "ready" && this.selectedMotion) {
        if (this.parameterMode === "pose") this.setParameterMode("none");
        this.loopMotion = true;
        this.viewer?.setLoopMotion(this.selectedMotion);
      }
    }
    if (kind === "drag") {
      this.dragEnabled = !this.dragEnabled;
      if (!this.dragEnabled) {
        this.endDrag();
      }
    }
    if (kind === "transparent") {
      this.backgroundTransparent = !this.backgroundTransparent;
      this.applyBackground();
    }
    if (kind === "paused") {
      this.paused = !this.paused;
      this.viewer?.setPaused(this.paused);
    }
  }
  private applyBackground() {
    const match = /^#?([0-9a-f]{6})$/i.exec(this.backgroundColor.trim());
    if (this.backgroundTransparent || !match) {
      this.viewer?.setBackgroundColor(null);
      return;
    }
    const hex = match[1];
    this.viewer?.setBackgroundColor({
      r: parseInt(hex.slice(0, 2), 16) / 255,
      g: parseInt(hex.slice(2, 4), 16) / 255,
      b: parseInt(hex.slice(4, 6), 16) / 255,
    });
  }
  private applyPartOpacity(id: string, opacity: number) {
    if (!this.parts.some((part) => part.id === id) || !Number.isFinite(opacity)) return;
    opacity = Math.min(1, Math.max(0, opacity));
    this.partOverrides = { ...this.partOverrides, [id]: opacity };
    this.viewer?.setPartOpacity(id, opacity);
    this.parts = this.parts.map((part) => (part.id === id ? { ...part, opacity } : part));
  }
  private togglePart(part: Part) {
    this.applyPartOpacity(part.id, part.opacity > 0.5 ? 0 : 1);
  }
  private resetParts() {
    for (const part of this.parts) {
      const opacity = this.initialPartOpacities[part.id] ?? 1;
      this.applyPartOpacity(part.id, opacity);
    }
    this.parts = this.parts.map((part) => ({ ...part, opacity: this.initialPartOpacities[part.id] ?? 1 }));
  }
  private readPoses(model: string): Record<string, StoredPose> {
    try {
      const all = JSON.parse(localStorage.getItem(POSE_STORAGE_KEY) || "{}") as Record<
        string,
        Record<string, StoredPose>
      >;
      const poses = all[model];
      return poses && typeof poses === "object" ? poses : {};
    } catch {
      return {};
    }
  }
  private writePoses() {
    try {
      const all = JSON.parse(localStorage.getItem(POSE_STORAGE_KEY) || "{}") as Record<string, unknown>;
      if (Object.keys(this.poses).length) all[this.selected] = this.poses;
      else delete all[this.selected];
      localStorage.setItem(POSE_STORAGE_KEY, JSON.stringify(all));
    } catch {
      // Storage may be unavailable; the in-memory poses keep working.
    }
  }
  private currentPoseData(): StoredPose {
    const parameters =
      this.parameterMode === "pose"
        ? this.parameterOverrides
        : Object.fromEntries(
            (this.viewer?.parameters() || this.parameters).map((parameter) => [parameter.id, parameter.value]),
          );
    const parts = Object.fromEntries((this.viewer?.parts() || this.parts).map((part) => [part.id, part.opacity]));
    return { name: "", parameters, parts };
  }
  private savePose() {
    const id = String(Date.now());
    const pose = this.currentPoseData();
    pose.name = `${uiText(this.locale, "pose")} ${Object.keys(this.poses).length + 1}`;
    this.poses = { ...this.poses, [id]: pose };
    this.poseId = id;
    this.renamingPose = false;
    this.writePoses();
  }
  private applyDefaultPose() {
    this.cancelPosePreview();
    this.stopMotion();
    this.poseId = "";
    this.renamingPose = false;
    this.parameterMode = "pose";
    const parameters = this.viewer?.parameters() || this.parameters;
    this.parameterOverrides = Object.fromEntries(parameters.map((parameter) => [parameter.id, parameter.defaultValue]));
    this.viewer?.setPoseFrozen(true);
    this.viewer?.setParameterOverrides(this.parameterOverrides);
    const parts = this.viewer?.parts() || this.parts;
    this.parts = parts.map((part) => {
      const opacity = this.initialPartOpacities[part.id] ?? 1;
      this.applyPartOpacity(part.id, opacity);
      return { ...part, opacity };
    });
  }
  private applyPose(id: string) {
    const pose = this.poses[id];
    if (!id || !pose) {
      this.applyDefaultPose();
      return;
    }
    this.cancelPosePreview();
    this.stopMotion();
    this.poseId = id;
    this.renamingPose = false;
    this.parameterMode = "pose";
    const parameters = this.viewer?.parameters() || this.parameters;
    this.parameterOverrides = Object.fromEntries(
      parameters.map((parameter) => [parameter.id, pose.parameters?.[parameter.id] ?? parameter.defaultValue]),
    );
    this.viewer?.setPoseFrozen(true);
    this.viewer?.setParameterOverrides(this.parameterOverrides);
    const parts = this.viewer?.parts() || this.parts;
    this.parts = parts.map((part) => {
      const opacity = pose.parts?.[part.id] ?? this.initialPartOpacities[part.id] ?? 1;
      this.applyPartOpacity(part.id, opacity);
      return { ...part, opacity };
    });
  }
  private deletePose() {
    if (!this.poseId) return;
    const poses = { ...this.poses };
    delete poses[this.poseId];
    this.poses = poses;
    const remaining = Object.keys(poses);
    this.applyPose(remaining[remaining.length - 1] || "");
    this.writePoses();
  }
  private commitPoseName() {
    const pose = this.poseId ? this.poses[this.poseId] : undefined;
    if (pose) {
      this.poses = { ...this.poses, [this.poseId]: { ...pose, name: this.poseNameDraft.trim() || pose.name } };
      this.writePoses();
    }
    this.renamingPose = false;
    this.poseNameDraft = "";
  }
  private beginDrag(event: PointerEvent) {
    if (this.modelPhase !== "ready" || !this.dragEnabled || !event.isPrimary || event.button !== 0) return;
    event.preventDefault();
    this.dragging = true;
    this.dragPointerId = event.pointerId;
    this.requestUpdate();
    this.dragLastX = event.clientX;
    this.dragLastY = event.clientY;
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  }
  private moveDrag(event: PointerEvent) {
    if (!this.dragging || event.pointerId !== this.dragPointerId) return;
    const canvas = event.currentTarget as HTMLElement;
    const rect = canvas.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      // Unbounded: the stage projection keeps the model centered, so dragging
      // past the canvas edge is a legitimate placement.
      this.offsetX += ((event.clientX - this.dragLastX) / rect.width) * 2;
      this.offsetY += ((event.clientY - this.dragLastY) / rect.height) * 2;
      this.applyTransform();
    }
    this.dragLastX = event.clientX;
    this.dragLastY = event.clientY;
  }
  private endDrag(event?: PointerEvent) {
    if (event && event.pointerId !== this.dragPointerId) return;
    const canvas = this.querySelector<HTMLCanvasElement>(".viewer-detail__runtime canvas");
    const pointerId = this.dragPointerId;
    this.dragging = false;
    this.dragPointerId = null;
    if (pointerId !== null && canvas?.hasPointerCapture(pointerId)) canvas.releasePointerCapture(pointerId);
    this.requestUpdate();
  }
  private zoomAtPointer(event: WheelEvent) {
    if (!this.dragEnabled || this.modelPhase !== "ready" || !Number.isFinite(event.deltaY)) return;
    event.preventDefault();
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? rect.height : 1);
    const scale = Math.min(4, Math.max(0.25, this.modelScale * Math.exp(-delta * 0.002)));
    const ratio = scale / this.modelScale;
    const x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    const y = ((event.clientY - rect.top) / rect.height) * 2 - 1;
    this.offsetX = x - (x - this.offsetX) * ratio;
    this.offsetY = y - (y - this.offsetY) * ratio;
    this.modelScale = scale;
    this.applyTransform();
  }
  private resetTransform() {
    this.endDrag();
    this.modelScale = 1;
    this.offsetX = 0;
    this.offsetY = 0;
    this.applyTransform();
  }
  private character(id: number) {
    return this.characters.find((item) => Number(item.characterId) === id);
  }
  private band(id: number) {
    return this.bands.find((item) => Number(item.bandId) === id);
  }
  private characterName(model: Value) {
    const character = this.character(Number(model.characterId || 0));
    return (
      this.text(model.characterName) ||
      this.text(character?.characterName) ||
      subCharacterLabel(String(model.characterKey || ""))
    );
  }
  private bandName(model: Value) {
    return this.text(this.band(Number(model.bandId || 0))?.bandName);
  }
  private modelType(model: Value) {
    const value = String(model.modelType || "");
    if (value === "adv") return uiText(this.locale, "story");
    if (value === "live") return uiText(this.locale, "live");
    return value || "—";
  }
  private sync() {
    const params = new URLSearchParams();
    if (this.selected) params.set("model", this.selected);
    if (this.query) params.set("q", this.query);
    if (this.view !== "grid") params.set("view", this.view);
    if (this.sort !== "id") params.set("sort", this.sort);
    if (this.order !== "asc") params.set("order", this.order);
    if (this.bandFilter) params.set("band", String(this.bandFilter));
    if (this.characterFilter) params.set("character", this.characterFilter);
    if (this.typeFilter) params.set("type", this.typeFilter);
    for (const [key, value] of Object.entries(this.metaFilters)) {
      if (value) params.set(key, value);
      else params.delete(key);
    }
    history.replaceState(history.state, "", `${location.pathname}${params.size ? `?${params}` : ""}`);
  }
  private modelFacetValue(model: Value, key: string): string {
    if (key === "preview") return (model.preview as Value | undefined)?.url ? "yes" : "no";
    if (typeof model[key] === "boolean") return model[key] ? "yes" : "no";
    return model[key] == null ? "" : String(model[key]);
  }
  private renderMetadataFilters() {
    return ["quality", "costumeId", "subCharacter", "preview"].map((key) => {
      const counts = new Map<string, number>();
      for (const model of this.models) {
        const value = this.modelFacetValue(model, key);
        if (value) counts.set(value, (counts.get(value) || 0) + 1);
      }
      if (counts.size < 2) return nothing;
      return facet(
        uiText(this.locale, key),
        this.locale,
        [...counts].map(([value, count]) => ({
          value,
          label: ["yes", "no"].includes(value) ? uiText(this.locale, value) : value,
          count,
        })),
        this.metaFilters[key] ? [this.metaFilters[key]] : [],
        (value) => {
          this.metaFilters = { ...this.metaFilters, [key]: this.metaFilters[key] === value ? "" : value };
          this.sync();
        },
      );
    });
  }
  private characterFacetItems() {
    const items = this.characters.map((item) => ({
      value: String(Number(item.characterId) || 0),
      label: this.text(item.characterName) || subCharacterLabel(String(item.characterKey || "")),
      image: String(item.faceImage || ""),
      count: this.models.filter((model) => Number(model.characterId) === Number(item.characterId)).length,
    }));
    const subs = new Map<string, number>();
    for (const model of this.models) {
      if (Number(model.characterId) > 0) continue;
      const key = String(model.characterKey || "");
      if (key) subs.set(key, (subs.get(key) || 0) + 1);
    }
    for (const [key, count] of [...subs.entries()].sort((left, right) => left[0].localeCompare(right[0]))) {
      items.push({ value: `key:${key}`, label: subCharacterLabel(key), image: "", count });
    }
    return items.filter((item) => item.count > 0);
  }
  private filteredModels() {
    const needle = this.query.trim().normalize("NFKC").toLowerCase();
    const direction = this.order === "asc" ? 1 : -1;
    return this.models
      .filter((model) =>
        Object.entries(this.metaFilters).every(([key, value]) => !value || this.modelFacetValue(model, key) === value),
      )
      .filter((model) => {
        if (this.bandFilter && Number(model.bandId) !== this.bandFilter) return false;
        if (this.characterFilter) {
          if (this.characterFilter.startsWith("key:")) {
            if (String(model.characterKey || "") !== this.characterFilter.slice(4)) return false;
          } else if (Number(model.characterId) !== Number(this.characterFilter)) return false;
        }
        if (this.typeFilter && String(model.modelType || "") !== this.typeFilter) return false;
        return (
          !needle ||
          `${this.key(model)} ${this.modelTitle(model)} ${this.characterName(model)} ${String(model.characterKey || "")} ${this.bandName(model)}`
            .normalize("NFKC")
            .toLowerCase()
            .includes(needle)
        );
      })
      .sort((left, right) => {
        let result = String(this.key(left)).localeCompare(String(this.key(right)), "en", { numeric: true });
        if (this.sort === "title")
          result = this.modelTitle(left).localeCompare(this.modelTitle(right), this.locale, { numeric: true });
        if (this.sort === "type")
          result = String(left.modelType || "").localeCompare(String(right.modelType || ""), this.locale, {
            numeric: true,
          });
        if (this.sort === "character") result = Number(left.characterId || 0) - Number(right.characterId || 0);
        if (this.sort === "band") result = Number(left.bandId || 0) - Number(right.bandId || 0);
        return direction * result;
      });
  }
  updated() {
    if (this.entityId && this.detail)
      updateEntityHeading(
        this,
        [...new Set([this.characterName(this.detail), this.modelTitle(this.detail)].filter(Boolean))].join(" · "),
      );
    this.removeSsrStageWhenOwned();
    // Collection details are modal panes; canonical entity routes are ordinary
    // page flow and must leave focus in the shell/document.
    this.paneFocus.sync(this.entityId ? null : this.querySelector<HTMLElement>("[data-overlay-pane]"), () =>
      this.closeDetail(),
    );
    // tile() defers its artwork as `data-src`; this is what promotes it.
    this.lazyImages.observe(this);
  }
  private removeSsrStageWhenOwned() {
    if (this.ssrStageRemoved || !this.entityId) return;
    const managedStage = this.querySelector<HTMLElement>(".viewer-detail--page .viewer-detail__runtime");
    const ssrStage = this.querySelector<HTMLElement>(".viewer-ssr-stage");
    if (!managedStage || !ssrStage) return;
    if (!managedStage.querySelector(".viewer-stage__preview, .viewer-stage__placeholder")) return;
    ssrStage.remove();
    this.ssrStageRemoved = true;
  }
  private closeDetail() {
    this.generation += 1;
    this.selectionAbortController?.abort();
    this.selectionAbortController = undefined;
    this.abortPackaging();
    this.endDrag();
    this.releaseViewer();
    this.loopMotion = false;
    this.selectedMotion = "";
    this.pendingPoseCapture = false;
    this.selected = "";
    this.detail = null;
    this.modelPhase = "idle";
    this.modelError = "";
    this.sync();
  }
  private adjacentModel(offset: number) {
    const models = this.filteredModels();
    const index = models.findIndex((model) => this.key(model) === this.selected);
    const next = models[index + offset];
    if (next) void this.select(this.key(next));
  }
  private async captureStage() {
    const canvas = this.querySelector<HTMLCanvasElement>(".viewer-detail__runtime canvas");
    if (!canvas || this.capturing) return;
    const generation = this.generation;
    const selected = this.selected;
    this.capturing = true;
    this.captureMessage = "";
    try {
      const width = Math.max(1, canvas.width);
      const height = Math.max(1, canvas.height);
      // The runtime scales its current drawing buffer, which may already be
      // supersampled. Count those pixels once when applying the capture budget.
      const gl = canvas.getContext("webgl2");
      if (!gl || gl.isContextLost()) throw new Error("Canvas is not ready");
      const size = viewerBufferSize(width, height, gl, CAPTURE_PIXEL_BUDGET);
      const scale = Math.min(size.width / width, size.height / height);
      const snapshot = document.createElement("canvas");
      const context = snapshot.getContext("2d");
      if (!context) throw new Error("Image capture is unavailable");
      const rendered = this.viewer?.captureSupersampled(scale, (source) => {
        snapshot.width = source.width;
        snapshot.height = source.height;
        context.drawImage(source, 0, 0);
      });
      if (rendered !== true) throw new Error("Canvas is not ready");
      const blob = await canvasToPngBlob(snapshot);
      if (generation !== this.generation || !this.isConnected) return;
      await downloadBlob(blob, `${selected || "viewer"}.png`);
    } catch {
      if (generation === this.generation && this.isConnected) {
        this.captureMessage = uiText(this.locale, "captureFailed");
      }
    } finally {
      this.capturing = false;
    }
  }
  private async downloadModelPackage() {
    const selectedKey = this.selected;
    const detail = this.detail;
    if (this.packaging || !detail || !selectedKey) return;
    const source = detail.runtime && typeof detail.runtime === "object" ? (detail.runtime as Value) : detail;
    const modelPath = String(source.model || "");
    if (!modelPath) {
      this.packagingError = uiText(this.locale, "modelDescriptorMissing");
      return;
    }
    const controller = new AbortController();
    this.packagingAbortController?.abort();
    this.packagingAbortController = controller;
    this.packaging = true;
    this.packagingProgress = { stage: "manifest", completed: 0, loadedBytes: 0 };
    this.packagingError = "";
    let exporter: typeof import("../lib/live2d-export") | undefined;
    try {
      const sourceURL = new URL(modelPath, location.href).toString();
      exporter = await import("../lib/live2d-export");
      if (controller.signal.aborted || this.packagingAbortController !== controller || this.selected !== selectedKey)
        return;
      const result = await exporter.exportLive2DModel({
        modelUrl: sourceURL,
        name: selectedKey,
        signal: controller.signal,
        onProgress: (progress) => {
          if (
            controller.signal.aborted ||
            this.packagingAbortController !== controller ||
            this.selected !== selectedKey
          )
            return;
          this.packagingProgress = { ...progress };
        },
      });
      if (controller.signal.aborted || this.packagingAbortController !== controller || this.selected !== selectedKey)
        return;
      await downloadBlob(new Blob([result.bytes as BlobPart], { type: "application/zip" }), result.fileName);
    } catch (error) {
      if (this.isAbortError(error) || controller.signal.aborted) return;
      if (this.packagingAbortController === controller) {
        this.packagingError =
          exporter && error instanceof exporter.Live2DExportError
            ? uiText(this.locale, error.messageKey)
            : error instanceof Error
              ? error.message
              : String(error);
      }
    } finally {
      if (this.packagingAbortController === controller) {
        this.packagingAbortController = undefined;
        this.packaging = false;
      }
    }
  }
  private formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    const units = ["KiB", "MiB", "GiB"];
    let value = bytes;
    let unit = "B";
    for (const next of units) {
      value /= 1024;
      unit = next;
      if (value < 1024) break;
    }
    return `${new Intl.NumberFormat(this.locale, { maximumFractionDigits: 1 }).format(value)} ${unit}`;
  }
  private packagingStatus(): string {
    const progress = this.packagingProgress;
    if (!progress) return uiText(this.locale, "loading");
    const stage =
      progress.stage === "manifest"
        ? uiText(this.locale, "details")
        : progress.stage === "resources"
          ? uiText(this.locale, "visualAssets")
          : uiText(this.locale, "downloadModel");
    const count = progress.total == null ? String(progress.completed) : `${progress.completed}/${progress.total}`;
    const bytes = progress.loadedBytes > 0 ? ` · ${this.formatBytes(progress.loadedBytes)}` : "";
    return `${uiText(this.locale, "progress")}: ${stage} ${count}${bytes}`;
  }
  private renderCatalogWorkspace() {
    const models = this.filteredModels();
    if (this.entityId || this.selected) {
      clearBrowseBar();
      return this.renderModelDetail();
    }
    const types = [...new Set(this.models.map((model) => String(model.modelType || "")).filter(Boolean))];
    return html`
      ${renderBrowse({
        kind: "model",
        count: { value: models.length, label: "" },
        modes: viewSwitch(this.locale, this.view, (view) => {
          this.view = view;
          this.sync();
        }),
        results:
          this.phase === "loading"
            ? loadingState(uiText(this.locale, "loading"))
            : this.phase === "error"
              ? errorState(
                  uiText(this.locale, "unavailable"),
                  uiText(this.locale, "retry"),
                  () => void this.loadCatalog(),
                  this.error,
                )
              : this.view === "grid"
                ? this.renderModelGrid(models)
                : this.view === "table"
                  ? this.renderModelList(models)
                  : this.renderSimpleList(models),
        filters: {
          label: uiText(this.locale, "filter"),
          open: this.filtersOpen,
          count:
            Number(Boolean(this.query)) +
            Number(Boolean(this.bandFilter)) +
            Number(Boolean(this.characterFilter)) +
            Number(Boolean(this.typeFilter)) +
            Object.values(this.metaFilters).filter(Boolean).length,
          closeLabel: uiText(this.locale, "close"),
          resetLabel: uiText(this.locale, "reset"),
          onOpen: () => (this.filtersOpen = true),
          onClose: () => (this.filtersOpen = false),
          onReset: () => {
            this.query = "";
            this.metaFilters = {};
            this.bandFilter = 0;
            this.characterFilter = "";
            this.typeFilter = "";
            this.sync();
          },
          body: html`
            <div class="field-stack">
              <md-outlined-text-field
                class="is-search"
                type="search"
                label=${uiText(this.locale, "search")}
                .value=${this.query}
                @input=${(event: Event) => {
                  this.query = String((event.target as HTMLElement & { value?: string }).value || "");
                  this.sync();
                }}
              >
                <svg slot="leading-icon" class="material-icon" width="20" height="20" aria-hidden="true">
                  <use href="/icons.svg#search"></use>
                </svg>
              </md-outlined-text-field>
            </div>
            ${this.renderModelFacets(
              uiText(this.locale, "band"),
              this.bands,
              this.bandFilter,
              (item) => Number(item.bandId),
              (item) => this.text(item.bandName),
              (item) => String(item.icon || item.logo || ""),
              (value) => (this.bandFilter = Number(value)),
            )}
            ${facet(
              uiText(this.locale, "character"),
              this.locale,
              this.characterFacetItems(),
              this.characterFilter ? [this.characterFilter] : [],
              (value) => {
                this.characterFilter = this.characterFilter === value ? "" : value;
                this.sync();
              },
            )}
            ${facet(
              uiText(this.locale, "type"),
              this.locale,
              types.map((value) => ({
                value,
                label: this.modelType({ modelType: value }),
                count: this.models.filter((model) => model.modelType === value).length,
              })),
              this.typeFilter ? [this.typeFilter] : [],
              (value) => {
                this.typeFilter = this.typeFilter === value ? "" : value;
                this.sync();
              },
            )}
            ${this.renderMetadataFilters()}
            ${filterGroup(
              uiText(this.locale, "sort"),
              html`
                <div class="field-stack">
                  <md-outlined-select
                    label=${uiText(this.locale, "sort")}
                    value=${this.sort}
                    @change=${(event: Event) => {
                      this.sort = String(
                        (event.target as HTMLElement & { value?: string }).value || "id",
                      ) as typeof this.sort;
                      this.sync();
                    }}
                  >
                    ${(
                      [
                        ["id", uiText(this.locale, "order")],
                        ["title", uiText(this.locale, "title")],
                        ["type", uiText(this.locale, "type")],
                        ["character", uiText(this.locale, "character")],
                        ["band", uiText(this.locale, "band")],
                      ] as const
                    ).map(
                      ([value, label]) => html`
                        <md-select-option value=${value} ?selected=${this.sort === value}>
                          <div slot="headline">${label}</div>
                        </md-select-option>
                      `,
                    )}
                  </md-outlined-select>
                </div>
              `,
            )}
          `,
        },
      })}
    `;
  }
  private renderModelFacets(
    label: string,
    items: Value[],
    selected: number,
    id: (item: Value) => number,
    title: (item: Value) => string,
    image: (item: Value) => string,
    update: (value: number) => void,
  ) {
    const key = label === uiText(this.locale, "band") ? "bandId" : "characterId";
    return facet(
      label,
      this.locale,
      items.map((item) => ({
        value: String(id(item)),
        label: title(item),
        image: image(item),
        count: this.models.filter((model) => Number(model[key]) === id(item)).length,
      })),
      selected ? [String(selected)] : [],
      (value) => {
        update(selected === Number(value) ? 0 : Number(value));
        this.sync();
      },
    );
  }
  private renderModelGrid(models: Value[]) {
    return html`
      <div class="collection collection--model">
        ${models.map((model) => modelTile({ model, character: this.character(Number(model.characterId || 0)), locale: this.locale, onOpen: () => this.select(this.key(model)) }))}
      </div>
    `;
  }
  private renderSimpleList(models: Value[]) {
    return collectionList(
      models.map((model) => ({
        id: this.key(model),
        title: this.modelTitle(model),
        subtitle: this.characterName(model),
        image: this.preview(model),
        onOpen: () => this.select(this.key(model)),
      })),
    );
  }
  private renderModelList(models: Value[]) {
    return collectionTable(
      uiText(this.locale, "table"),
      [
        uiText(this.locale, "model"),
        uiText(this.locale, "type"),
        uiText(this.locale, "character"),
        uiText(this.locale, "band"),
      ],
      models.map((model) => [
        html`
          <button class="table-entity" type="button" @click=${() => this.select(this.key(model))}>
            ${
              this.preview(model)
                ? html`
                    <span class="table-entity__media"><img data-src=${this.preview(model)} alt="" /></span>
                  `
                : nothing
            }
            <span class="table-entity__copy">
              <strong>${this.modelTitle(model)}</strong>
              <small>${this.characterName(model)}</small>
            </span>
          </button>
        `,
        this.modelType(model),
        this.characterName(model),
        this.bandName(model) || "—",
      ]),
    );
  }
  private renderModelDetail() {
    const detail = this.detail;
    const page = Boolean(this.entityId);
    const character = detail ? this.character(Number(detail.characterId || 0)) : undefined;
    const motions = Array.isArray(detail?.motions) ? (detail.motions as Value[]) : [];
    const expressions = Array.isArray(detail?.expressions) ? (detail.expressions as Value[]) : [];
    const previewSrc = this.previewSource(detail);
    const previewRatio = this.previewRatio(detail);
    const models = this.filteredModels();
    const modelIndex = models.findIndex((model) => this.key(model) === this.selected);
    const modelReady = this.modelPhase === "ready";
    return html`
      <aside
        class=${page ? "viewer-detail viewer-detail--page" : "viewer-detail pane-layer"}
        role=${page ? nothing : "dialog"}
        aria-modal=${page ? nothing : "true"}
        aria-label=${page ? nothing : uiText(this.locale, "model")}
        tabindex=${page ? nothing : "-1"}
        data-overlay-pane=${page ? nothing : "true"}
      >
        ${
          page
            ? nothing
            : html`
                <header>
                  <button class="icon-button" @click=${this.closeDetail} aria-label=${uiText(this.locale, "close")}>
                    <svg class="material-icon" width="24" height="24"><use href="/icons.svg#arrow_back"></use></svg>
                  </button>
                  ${
                    character?.faceImage
                      ? html`
                          <img class="viewer-detail__avatar" src=${String(character.faceImage)} alt="" />
                        `
                      : nothing
                  }
                  <span>
                    <strong>${detail ? this.modelTitle(detail) : this.selected}</strong>
                    <small>${detail ? this.characterName(detail) : ""}</small>
                  </span>
                  <nav class="viewer-detail__navigation" aria-label=${uiText(this.locale, "live2d")}>
                    <button
                      class="icon-button"
                      ?disabled=${modelIndex <= 0}
                      @click=${() => this.adjacentModel(-1)}
                      aria-label=${uiText(this.locale, "previous")}
                    >
                      <svg class="material-icon" width="20" height="20"><use href="/icons.svg#chevron_left"></use></svg>
                    </button>
                    <button class="icon-button" @click=${this.closeDetail} aria-label=${uiText(this.locale, "grid")}>
                      <svg class="material-icon" width="20" height="20"><use href="/icons.svg#grid_view"></use></svg>
                    </button>
                    <button
                      class="icon-button"
                      ?disabled=${modelIndex < 0 || modelIndex >= models.length - 1}
                      @click=${() => this.adjacentModel(1)}
                      aria-label=${uiText(this.locale, "next")}
                    >
                      <svg class="material-icon" width="20" height="20">
                        <use href="/icons.svg#chevron_right"></use>
                      </svg>
                    </button>
                  </nav>
                </header>
              `
        }
        <div class="viewer-detail__body">
          <div
            class="viewer-stage viewer-detail__runtime"
            aria-busy=${this.modelPhase === "loading"}
            aria-label=${detail ? this.modelTitle(detail) : uiText(this.locale, "live2d")}
            style=${previewRatio ? `--viewer-stage-ratio: ${previewRatio};` : nothing}
          >
            ${
              previewSrc
                ? html`
                    <img class="viewer-stage__preview" src=${previewSrc} alt="" aria-hidden="true" decoding="async" />
                  `
                : html`
                    <span class="viewer-stage__preview viewer-stage__placeholder" aria-hidden="true"></span>
                  `
            }
            ${keyed(
              this.generation,
              html`
                <canvas
                  aria-label=${uiText(this.locale, "live2d")}
                  style=${this.dragEnabled ? `touch-action: none; cursor: ${this.dragging ? "grabbing" : "grab"}` : ""}
                  @pointerdown=${this.beginDrag}
                  @pointermove=${(event: PointerEvent) => {
                    this.moveDrag(event);
                    if (!this.dragging && this.sway && this.parameterMode !== "pose") {
                      this.viewer?.setLookAtClientPosition(event.clientX, event.clientY);
                    }
                  }}
                  @pointerup=${this.endDrag}
                  @pointercancel=${this.endDrag}
                  @lostpointercapture=${this.endDrag}
                  @wheel=${this.zoomAtPointer}
                  @pointerleave=${() => {
                    if (this.sway && this.parameterMode !== "pose") this.applyLook();
                  }}
                ></canvas>
              `,
            )}
            ${
              this.modelPhase === "loading"
                ? html`
                    <div class="viewer-state" role="status" aria-live="polite">
                      <md-circular-progress indeterminate aria-hidden="true"></md-circular-progress>
                      <span>${uiText(this.locale, "loading")}</span>
                    </div>
                  `
                : nothing
            }${
              this.modelPhase === "error"
                ? html`
                    <div class="viewer-state" role="alert">
                      <span>${this.modelError || this.error}</span>
                      <button class="button button--tonal" type="button" @click=${this.retryModel}>
                        ${uiText(this.locale, "retry")}
                      </button>
                    </div>
                  `
                : nothing
            }${
              detail && modelReady
                ? html`
                    ${
                      this.captureMessage
                        ? html`
                            <p class="viewer-capture-status" role="alert">${this.captureMessage}</p>
                          `
                        : nothing
                    }
                    ${
                      this.packaging
                        ? html`
                            <p class="viewer-capture-status" role="status" aria-live="polite">
                              ${this.packagingStatus()}
                            </p>
                          `
                        : nothing
                    }
                    ${
                      this.packagingError
                        ? html`
                            <p class="viewer-capture-status" role="alert">${this.packagingError}</p>
                          `
                        : nothing
                    }
                    ${
                      this.modelError
                        ? html`
                            <p class="viewer-capture-status" role="alert">${this.modelError}</p>
                          `
                        : nothing
                    }
                    <div class="viewer-controls">
                      <button
                        class="icon-button runtime-button"
                        @click=${() => this.toggle("paused")}
                        aria-label=${uiText(this.locale, this.paused ? "play" : "pause")}
                      >
                        <svg class="material-icon" width="22" height="22">
                          <use href=${this.paused ? "/icons.svg#play_arrow" : "/icons.svg#pause"}></use>
                        </svg>
                      </button>
                      <button
                        class="icon-button runtime-button"
                        aria-pressed=${this.dragEnabled}
                        @click=${() => this.toggle("drag")}
                        aria-label=${uiText(this.locale, "drag")}
                        title=${uiText(this.locale, "drag")}
                      >
                        <svg class="material-icon" width="22" height="22">
                          <use href="/icons.svg#pan_tool"></use>
                        </svg>
                      </button>
                      <button
                        class="icon-button runtime-button"
                        ?disabled=${this.capturing || this.packaging}
                        @click=${this.captureStage}
                        aria-label=${uiText(this.locale, "screenshot")}
                      >
                        <svg class="material-icon" width="22" height="22">
                          <use href="/icons.svg#photo_camera"></use>
                        </svg>
                      </button>
                      <button
                        class="icon-button runtime-button"
                        ?disabled=${this.packaging}
                        @click=${this.downloadModelPackage}
                        aria-label=${uiText(this.locale, "downloadModel")}
                        title=${uiText(this.locale, "downloadModel")}
                      >
                        <svg class="material-icon" width="22" height="22">
                          <use href="/icons.svg#download"></use>
                        </svg>
                      </button>
                    </div>
                  `
                : nothing
            }
          </div>
          <aside class="viewer-detail__info" ?inert=${!modelReady}>
            ${
              this.phase === "error" && modelReady
                ? html`
                    <div class="viewer-metadata-status" role="alert">
                      <span>${uiText(this.locale, "metadataUnavailable")}</span>
                      <button class="button button--text" @click=${() => void this.loadCatalog()}>
                        ${uiText(this.locale, "retry")}
                      </button>
                    </div>
                  `
                : nothing
            }
            <section class="viewer-behavior-controls">
              <h3>${uiText(this.locale, "settings")}</h3>
              ${(
                [
                  ["sway", this.sway],
                  ["breath", this.breath],
                  ["blink", this.blink],
                  ["loop", this.loopMotion],
                ] as const
              ).map(
                ([key, selected]) => html`
                  <label>
                    <span>${uiText(this.locale, key)}</span>
                    <md-switch
                      .selected=${selected}
                      ?disabled=${key === "loop" && !this.selectedMotion}
                      @change=${() => this.toggle(key)}
                      aria-label=${uiText(this.locale, key)}
                    ></md-switch>
                  </label>
                `,
              )}
              <label class="viewer-background-color">
                <span>${uiText(this.locale, "backgroundColor")}</span>
                <span class="viewer-background-color__controls">
                  <input
                    type="color"
                    .value=${this.backgroundColor}
                    ?disabled=${this.backgroundTransparent}
                    aria-label=${uiText(this.locale, "backgroundColor")}
                    @input=${(event: Event) => {
                      this.backgroundColor = String((event.target as HTMLInputElement).value || "#ecf0f1");
                      this.applyBackground();
                    }}
                  />
                  <md-switch
                    .selected=${!this.backgroundTransparent}
                    @change=${() => this.toggle("transparent")}
                    aria-label=${uiText(this.locale, "backgroundColor")}
                  ></md-switch>
                </span>
              </label>
            </section>
            <section class="viewer-transform-controls">
              <h3>${uiText(this.locale, "transform")}</h3>
              <button class="button button--text" @click=${this.resetTransform}>
                ${uiText(this.locale, "resetTransform")}
              </button>
              <label>
                <span>${uiText(this.locale, "scale")}</span>
                <md-slider
                  aria-label=${uiText(this.locale, "scale")}
                  min="0.25"
                  max="4"
                  step="0.01"
                  .value=${String(this.modelScale)}
                  @input=${(event: Event) => {
                    this.modelScale = Number((event.target as HTMLElement & { value?: number }).value || 1);
                    this.applyTransform();
                  }}
                ></md-slider>
              </label>
              <label>
                <span>${uiText(this.locale, "viewerModelPositionX")}</span>
                <md-slider
                  aria-label=${uiText(this.locale, "viewerModelPositionX")}
                  min=${Math.min(-2, this.offsetX)}
                  max=${Math.max(2, this.offsetX)}
                  step="0.01"
                  .value=${this.offsetX}
                  @input=${(event: Event) => {
                    this.offsetX = Number((event.target as HTMLElement & { value?: number }).value || 0);
                    this.applyTransform();
                  }}
                ></md-slider>
              </label>
              <label>
                <span>${uiText(this.locale, "viewerModelPositionY")}</span>
                <md-slider
                  aria-label=${uiText(this.locale, "viewerModelPositionY")}
                  min=${Math.min(-2, this.offsetY)}
                  max=${Math.max(2, this.offsetY)}
                  step="0.01"
                  .value=${this.offsetY}
                  @input=${(event: Event) => {
                    this.offsetY = Number((event.target as HTMLElement & { value?: number }).value || 0);
                    this.applyTransform();
                  }}
                ></md-slider>
              </label>
            </section>
            ${
              motions.length
                ? html`
                    <section>
                      <h3>${uiText(this.locale, "motion")}</h3>
                      <div class="viewer-motion-row">
                        <md-outlined-select
                          class="viewer-inspector-select"
                          label=${uiText(this.locale, "motion")}
                          .value=${this.selectedMotion}
                          @change=${(event: Event) =>
                            this.playMotion(String((event.target as HTMLElement & { value?: string }).value || ""))}
                        >
                          ${motions.map(
                            (motion) => html`
                              <md-select-option value=${String(motion.name || "")}>
                                <div slot="headline">${String(motion.name || "")}</div>
                              </md-select-option>
                            `,
                          )}
                        </md-outlined-select>
                        <button class="button button--tonal viewer-panel-button" @click=${this.stopMotion}>
                          ${uiText(this.locale, "stop")}
                        </button>
                      </div>
                    </section>
                  `
                : nothing
            }${
              expressions.length
                ? html`
                    <section>
                      <h3>${uiText(this.locale, "expression")}</h3>
                      <md-outlined-select
                        class="viewer-inspector-select"
                        label=${uiText(this.locale, "expression")}
                        @change=${(event: Event) =>
                          this.viewer?.playExpression(
                            String((event.target as HTMLElement & { value?: string }).value || ""),
                          )}
                      >
                        ${expressions.map(
                          (expression) => html`
                            <md-select-option value=${String(expression.name || "")}>
                              <div slot="headline">${String(expression.name || "")}</div>
                            </md-select-option>
                          `,
                        )}
                      </md-outlined-select>
                    </section>
                  `
                : nothing
            }
            ${
              this.parameters.length
                ? accordion({
                    id: `${this.editorId}-parameters`,
                    className: "viewer-parameter-editor",
                    label: uiText(this.locale, "parameters"),
                    metadata: this.parameters.length,
                    headingLevel: 3,
                    expanded: this.parametersExpanded,
                    onExpandedChange: (expanded) => (this.parametersExpanded = expanded),
                    content: html`
                      <div class="viewer-parameter-content">
                        <div class="viewer-parameter-toolbar">
                          <span>${uiText(this.locale, "parameterMode")}</span>
                          <span class="viewer-parameter-actions">
                            <button
                              class="button button--tonal"
                              style="flex: 1 1 max-content"
                              @click=${() => this.querySelector<HTMLInputElement>("[data-pose-import]")?.click()}
                            >
                              ${uiText(this.locale, "importPose")}
                            </button>
                            <input
                              data-pose-import
                              aria-label=${uiText(this.locale, "importPose")}
                              type="file"
                              accept="application/json,.json"
                              @change=${this.importParameters}
                            />
                            <button
                              class="button button--tonal"
                              style="flex: 1 1 max-content"
                              @click=${this.exportParameters}
                            >
                              ${uiText(this.locale, "exportPose")}
                            </button>
                            <button
                              class="button button--text"
                              style="flex: 1 1 max-content"
                              @click=${this.resetParameters}
                            >
                              ${uiText(this.locale, "reset")}
                            </button>
                          </span>
                          ${segmented({
                            label: uiText(this.locale, "parameterMode"),
                            value: this.parameterMode,
                            options: (["none", "capture", "pose"] as const).map((value) => ({
                              value,
                              label: uiText(this.locale, value),
                            })),
                            onSelect: (mode) => this.setParameterMode(mode),
                          })}
                        </div>
                        <div class="viewer-pose-toolbar">
                          <span>${uiText(this.locale, "customPoses")}</span>
                          <div class="viewer-pose-toolbar__row">
                            ${
                              this.renamingPose
                                ? html`
                                    <input
                                      class="viewer-pose-name"
                                      type="text"
                                      .value=${this.poseNameDraft}
                                      placeholder=${this.poseId ? this.poses[this.poseId]?.name || "" : ""}
                                      @input=${(event: Event) => {
                                        this.poseNameDraft = String((event.target as HTMLInputElement).value || "");
                                      }}
                                      @keydown=${(event: KeyboardEvent) => {
                                        if (event.key === "Enter") this.commitPoseName();
                                        if (event.key === "Escape") {
                                          this.renamingPose = false;
                                          this.poseNameDraft = "";
                                        }
                                      }}
                                    />
                                    <button
                                      class="button button--tonal viewer-panel-button"
                                      @click=${this.commitPoseName}
                                    >
                                      ${uiText(this.locale, "confirm")}
                                    </button>
                                  `
                                : html`
                                    <md-outlined-select
                                      class="viewer-inspector-select"
                                      label=${uiText(this.locale, "customPoses")}
                                      .value=${this.poseId}
                                      @change=${(event: Event) =>
                                        this.applyPose(
                                          String((event.target as HTMLElement & { value?: string }).value || ""),
                                        )}
                                    >
                                      <md-select-option value="">
                                        <div slot="headline">${uiText(this.locale, "defaultPose")}</div>
                                      </md-select-option>
                                      ${Object.entries(this.poses).map(
                                        ([id, pose]) => html`
                                          <md-select-option value=${id}>
                                            <div slot="headline">${pose.name}</div>
                                          </md-select-option>
                                        `,
                                      )}
                                    </md-outlined-select>
                                    <button class="button button--tonal viewer-panel-button" @click=${this.savePose}>
                                      ${uiText(this.locale, "savePose")}
                                    </button>
                                    ${
                                      this.poseId
                                        ? html`
                                            <button
                                              class="button button--tonal viewer-panel-button"
                                              @click=${() => {
                                                this.renamingPose = true;
                                                this.poseNameDraft = this.poses[this.poseId]?.name || "";
                                              }}
                                            >
                                              ${uiText(this.locale, "rename")}
                                            </button>
                                            <button
                                              class="button button--tonal viewer-panel-button"
                                              @click=${this.deletePose}
                                            >
                                              ${uiText(this.locale, "remove")}
                                            </button>
                                          `
                                        : nothing
                                    }
                                  `
                            }
                          </div>
                        </div>
                        ${this.parameters.map(
                          (parameter) => html`
                            <label>
                              <span title=${parameter.id}>${parameter.id}</span>
                              <md-slider
                                aria-label=${parameter.id}
                                min=${String(parameter.minimum)}
                                max=${String(parameter.maximum)}
                                step=${String(Math.max((parameter.maximum - parameter.minimum) / 200, 0.001))}
                                .value=${String(this.parameterOverrides[parameter.id] ?? parameter.value)}
                                ?disabled=${this.parameterMode !== "pose"}
                                @input=${(event: Event) =>
                                  this.setParameter(
                                    parameter,
                                    Number((event.target as HTMLElement & { value?: number }).value ?? parameter.value),
                                  )}
                              ></md-slider>
                              <output>${(this.parameterOverrides[parameter.id] ?? parameter.value).toFixed(2)}</output>
                              <button
                                class="icon-button"
                                @click=${() => this.resetParameter(parameter)}
                                aria-label=${`${uiText(this.locale, "reset")} ${parameter.id}`}
                              >
                                <svg class="material-icon" width="18" height="18">
                                  <use href="/icons.svg#restart_alt"></use>
                                </svg>
                              </button>
                            </label>
                          `,
                        )}
                      </div>
                    `,
                  })
                : nothing
            }
            ${
              this.parts.length
                ? accordion({
                    id: `${this.editorId}-parts`,
                    className: "viewer-parameter-editor viewer-part-editor",
                    label: uiText(this.locale, "partsVisibility"),
                    metadata: this.parts.length,
                    headingLevel: 3,
                    expanded: this.partsExpanded,
                    onExpandedChange: (expanded) => (this.partsExpanded = expanded),
                    content: html`
                      <div class="viewer-parameter-content">
                        <div class="viewer-part-toolbar">
                          <button class="button button--text" @click=${this.resetParts}>
                            ${uiText(this.locale, "reset")}
                          </button>
                        </div>
                        ${this.parts.map(
                          (part) => html`
                            <label class="viewer-part-row">
                              <span title=${part.id}>${part.id}</span>
                              <md-switch
                                .selected=${part.opacity > 0.5}
                                @change=${() => this.togglePart(part)}
                                aria-label=${part.id}
                              ></md-switch>
                            </label>
                          `,
                        )}
                      </div>
                    `,
                  })
                : nothing
            }
          </aside>
        </div>
      </aside>
    `;
  }
  render() {
    return this.renderCatalogWorkspace();
  }
}
customElements.define("live2d-workspace", Live2DWorkspace);
