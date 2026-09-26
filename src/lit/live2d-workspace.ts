import { canvasToPngBlob, downloadBlob } from "../lib/canvas-capture";
import { facet } from "./ui/facet";
import { collectionList, collectionTable, collectionView, viewSwitch, type CollectionView } from "./ui/collection-view";
import { LitElement, html, nothing } from "lit";
import { catalogUrl, fetchJson, localizedText, preferredLocale, readPath, uiText } from "./shared/catalog";
import { clearBrowseBar, filterGroup, renderBrowse } from "./ui/browse";
import { modelTile, modelTitle, modelPreviewSources, subCharacterLabel } from "./ui/model-tile";

import { EXPANDED, matches, watchMedia } from "./ui/media";
import { LazyImages } from "./ui/lazy-images";
import { PaneFocus } from "./ui/pane";
import { errorState, loadingState } from "./ui/state";

type Value = Record<string, unknown>;
type Parameter = { id: string; value: number; minimum: number; maximum: number; defaultValue: number };
type Part = { id: string; opacity: number };
type StoredPose = { name: string; parameters: Record<string, number>; parts: Record<string, number> };
const POSE_STORAGE_KEY = "haneoka.live2d.poses";
interface Viewer {
  readonly ready: boolean;
  readonly isMotionPlaying: boolean;
  readonly isMotionBusy: boolean;
  captureFrame(notify?: boolean): boolean;
  captureSupersampled(scale: number, copy: (canvas: HTMLCanvasElement) => void): boolean;
  load(options: {
    modelUrl: string;
    harmonicMotion?: unknown;
    defaultMotionName?: string;
    defaultExpressionName?: string;
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
  playMotion(name: string): boolean;
  playExpression(name: string): boolean;
  stopMotions(): void;
  destroy(): void;
}

export class Live2DWorkspace extends LitElement {
  static properties = {
    locale: { type: String },
    phase: { state: true },
    capturing: { state: true },
    captureMessage: { state: true },
    models: { state: true },
    selected: { state: true },
    detail: { state: true },
    paused: { state: true },
    breath: { state: true },
    blink: { state: true },
    sway: { state: true },
    loopMotion: { state: true },
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
  declare locale: string;
  declare phase: "loading" | "ready" | "error";
  declare models: Value[];
  declare selected: string;
  declare detail: Value | null;
  declare paused: boolean;
  declare breath: boolean;
  declare blink: boolean;
  declare sway: boolean;
  declare loopMotion: boolean;
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
  declare bandFilter: number;
  declare characterFilter: string;
  declare typeFilter: string;
  declare parameters: Parameter[];
  declare parameterOverrides: Record<string, number>;
  declare parameterMode: "none" | "capture" | "pose";
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
  private captureUpdatedAt = 0;
  private pendingPoseCapture = false;
  private initialPartOpacities: Record<string, number> = {};
  private dragging = false;
  private dragLastX = 0;
  private dragLastY = 0;

  constructor() {
    super();
    this.capturing = false;
    this.captureMessage = "";
    this.locale = "ja";
    this.phase = "loading";
    this.models = [];
    this.selected = "";
    this.detail = null;
    this.paused = false;
    this.breath = true;
    this.blink = true;
    this.sway = false;
    this.loopMotion = false;
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
  connectedCallback() {
    super.connectedCallback();
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
    window.setTimeout(() => {
      const params = new URLSearchParams(location.search);
      this.selected = params.get("model") || "";
      this.query = params.get("q") || "";
      this.view = collectionView(params.get("view"));
      this.metaFilters = Object.fromEntries(
        ["quality", "costumeId", "subCharacter", "preview"].map((key) => [key, params.get(key) || ""]),
      );
      this.sort = (
        ["id", "title", "type", "character", "band"].includes(params.get("sort") || "") ? params.get("sort") : "id"
      ) as typeof this.sort;
      this.order = params.get("order") === "desc" ? "desc" : "asc";
      this.bandFilter = Number(params.get("band") || 0);
      const characterParam = params.get("character") || "";
      this.characterFilter = /^\d+$/.test(characterParam) || characterParam.startsWith("key:") ? characterParam : "";
      this.typeFilter = params.get("type") || "";
      void this.loadCatalog();
    }, 0);
  }
  disconnectedCallback() {
    clearBrowseBar();
    this.lazyImages.disconnect();
    this.disposeMedia?.();
    this.paneFocus.detach();
    this.generation += 1;
    this.resizeObserver?.disconnect();
    this.viewer?.destroy();
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
  private url(path = "") {
    return catalogUrl("live2d", path);
  }
  private async loadCatalog() {
    this.phase = "loading";
    this.error = "";
    try {
      const [value, characters, bands] = await Promise.all([
        fetchJson<Record<string, Value>>(this.url()),
        fetchJson<Record<string, Value>>(catalogUrl("characters")),
        fetchJson<Record<string, Value>>(catalogUrl("bands")),
      ]);
      this.models = Object.values(value);
      this.characters = Object.values(characters);
      this.bands = Object.values(bands);
      this.phase = "ready";
      if (this.selected) void this.select(this.selected, false);
    } catch (error) {
      this.phase = "error";
      this.error = error instanceof Error ? error.message : String(error);
    }
  }
  private async select(key: string, updateUrl = true) {
    const generation = ++this.generation;
    this.selected = key;
    this.detail = null;
    this.parameters = [];
    this.parameterOverrides = {};
    this.parameterMode = "none";
    this.pendingPoseCapture = false;
    this.parts = [];
    this.initialPartOpacities = {};
    this.poses = this.readPoses(key);
    this.poseId = "";
    this.renamingPose = false;
    this.poseNameDraft = "";
    this.error = "";
    if (updateUrl) {
      const params = new URLSearchParams(location.search);
      params.set("model", key);
      history.replaceState(history.state, "", `${location.pathname}?${params}`);
    }
    try {
      const detail = await fetchJson<Value>(this.url(key));
      if (generation !== this.generation) return;
      this.detail = detail;
      await this.loadViewer(detail, generation);
    } catch (error) {
      if (generation === this.generation) this.error = error instanceof Error ? error.message : String(error);
    }
  }
  private async loadViewer(detail: Value, generation: number) {
    await this.updateComplete;
    const canvas = this.querySelector<HTMLCanvasElement>("canvas");
    if (!canvas) return;
    this.viewer?.destroy();
    const runtimeUrl = "/cubism-runtime/vega-cubism-web-runtime.mjs";
    const runtime = (await import(/* @vite-ignore */ runtimeUrl)) as unknown as {
      CubismModelViewer: new (options: {
        canvas: HTMLCanvasElement;
        onFrame?(): void;
        onError(error: unknown): void;
      }) => Viewer;
      createCubismWebRuntimeAdapter(options: Value): { prepare(version: number, signal: AbortSignal): Promise<void> };
    };
    const adapter = runtime.createCubismWebRuntimeAdapter({
      runtime: {
        cubismCoreUrl: "/Core/live2dcubismcore.js",
        cubism2CoreUrl: "/Core/live2d.min.js",
        motionSyncCoreUrl: "/Core/CRI/live2dcubismmotionsynccore.min.js",
      },
    });
    await adapter.prepare(3, new AbortController().signal);
    if (generation !== this.generation) return;
    let viewer!: Viewer;
    viewer = new runtime.CubismModelViewer({
      canvas,
      onFrame: () => this.handleViewerFrame(viewer),
      onError: (error) => {
        this.error = error instanceof Error ? error.message : String(error);
      },
    });
    this.viewer = viewer;
    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      // A CSS-pixel buffer matches the game's own stage sharpness; the device's
      // physical resolution makes the model look oversampled here.
      viewer.setSize(Math.max(1, Math.round(rect.width)), Math.max(1, Math.round(rect.height)));
    };
    this.resizeObserver?.disconnect();
    this.resizeObserver = new ResizeObserver(resize);
    this.resizeObserver.observe(canvas);
    resize();
    const source = detail.runtime && typeof detail.runtime === "object" ? (detail.runtime as Value) : detail;
    const modelUrl = String(source.model || "");
    if (!modelUrl) throw new Error("Live2D model descriptor is missing");
    const motions = Array.isArray(detail.motions) ? (detail.motions as Value[]) : [];
    const defaultMotion = String(
      readPath(detail, "profile.defaultMotionName") || detail.defaultMotionName || motions[0]?.name || "",
    );
    const defaultExpression = String(
      readPath(detail, "profile.defaultExpressionName") || detail.defaultExpressionName || "",
    );
    await viewer.load({
      modelUrl,
      harmonicMotion: source.harmonicMotion || detail.harmonicMotion,
      defaultMotionName: defaultMotion || undefined,
      defaultExpressionName: defaultExpression || undefined,
    });
    viewer.setBreathEnabled(this.breath);
    viewer.setEyeBlinkEnabled(this.blink);
    viewer.setPaused(this.paused);
    viewer.setPoseFrozen(this.parameterMode === "pose");
    // Motions are one-shot like the reference tool; looping idle playback is an
    // explicit switch so breath/blink toggles keep full control at rest.
    viewer.setLoopMotion(this.loopMotion && defaultMotion ? defaultMotion : null);
    this.parameters = viewer.parameters();
    this.parts = viewer.parts();
    this.initialPartOpacities = Object.fromEntries(this.parts.map((part) => [part.id, part.opacity]));
    this.applyBackground();
    viewer.setTransform({ offsetX: this.offsetX, offsetY: this.offsetY, scale: this.modelScale });
    viewer.setLookPosition(this.lookX, this.lookY);
  }
  private setParameter(parameter: Parameter, value: number) {
    if (this.parameterMode !== "pose") this.setParameterMode("pose");
    this.parameterOverrides = { ...this.parameterOverrides, [parameter.id]: value };
    this.viewer?.setParameterOverrides(this.parameterOverrides);
  }
  private resetParameter(parameter: Parameter) {
    this.setParameter(parameter, parameter.defaultValue);
  }
  private resetParameters() {
    if (this.parameterMode === "pose") {
      // Yatta-style reset: pose mode writes each authored default value.
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
  private handleViewerFrame(viewer: Viewer) {
    // A motion started from pose mode plays out once, then the final frame is
    // re-captured as the editable pose ("adjustments apply after the motion
    // finishes", matching the reference tool).
    if (this.pendingPoseCapture && !viewer.isMotionBusy) {
      this.pendingPoseCapture = false;
      this.snapshotPoseOverrides();
      viewer.setPoseFrozen(true);
      return;
    }
    if (this.parameterMode !== "capture") return;
    const now = performance.now();
    if (now - this.captureUpdatedAt < 240) return;
    this.captureUpdatedAt = now;
    this.parameters = viewer.parameters();
  }
  private playMotion(name: string) {
    if (!name) return;
    if (this.parameterMode === "pose") {
      // Let the clip advance so it can finish before re-freezing.
      if (this.paused) {
        this.paused = false;
        this.viewer?.setPaused(false);
      }
      this.viewer?.setPoseFrozen(false);
      this.pendingPoseCapture = true;
    }
    this.viewer?.playMotion(name);
  }
  private stopMotion() {
    this.pendingPoseCapture = false;
    if (this.parameterMode === "pose") {
      this.snapshotPoseOverrides();
      this.viewer?.setPoseFrozen(true);
    }
    this.viewer?.stopMotions();
  }
  private async importParameters(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text()) as Value;
      const source = parsed.parameters && typeof parsed.parameters === "object" ? (parsed.parameters as Value) : parsed;
      const known = new Map(this.parameters.map((parameter) => [parameter.id, parameter]));
      const values: Record<string, number> = {};
      for (const [id, raw] of Object.entries(source)) {
        const parameter = known.get(id);
        const value = Number(raw);
        if (!parameter || !Number.isFinite(value)) continue;
        values[id] = Math.min(parameter.maximum, Math.max(parameter.minimum, value));
      }
      this.parameterMode = "pose";
      this.parameterOverrides = values;
      this.viewer?.setPoseFrozen(true);
      this.viewer?.setParameterOverrides(values);
      const parts = parsed.parts && typeof parsed.parts === "object" ? (parsed.parts as Value) : null;
      if (parts) {
        for (const [id, raw] of Object.entries(parts)) {
          const opacity = Number(raw);
          if (!Number.isFinite(opacity)) continue;
          this.applyPartOpacity(id, Math.min(1, Math.max(0, opacity)));
        }
      }
    } catch {
      this.error = "Invalid Live2D parameter pose";
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
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `${this.selected || "live2d"}.pose.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 0);
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
      if (!this.sway) this.applyLook();
    }
    if (kind === "loop") {
      this.loopMotion = !this.loopMotion;
      const detail = this.detail;
      const motions = Array.isArray(detail?.motions) ? (detail?.motions as Value[]) : [];
      const defaultMotion = String(
        readPath(detail || {}, "profile.defaultMotionName") || detail?.defaultMotionName || motions[0]?.name || "",
      );
      this.viewer?.setLoopMotion(this.loopMotion && defaultMotion ? defaultMotion : null);
    }
    if (kind === "drag") {
      this.dragEnabled = !this.dragEnabled;
      if (!this.dragEnabled) {
        // The reference tool restores the fitted placement when dragging stops.
        this.dragging = false;
        this.offsetX = 0;
        this.offsetY = 0;
        this.applyTransform();
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
    this.viewer?.setPartOpacity(id, opacity);
    this.parts = this.parts.map((part) => (part.id === id ? { ...part, opacity } : part));
  }
  private togglePart(part: Part) {
    this.applyPartOpacity(part.id, part.opacity > 0.5 ? 0 : 1);
  }
  private resetParts() {
    for (const part of this.parts) {
      const opacity = this.initialPartOpacities[part.id] ?? 1;
      this.viewer?.setPartOpacity(part.id, opacity);
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
  private applyPose(id: string) {
    const pose = this.poses[id];
    if (!pose) return;
    this.poseId = id;
    this.renamingPose = false;
    this.parameterMode = "pose";
    this.parameterOverrides = { ...pose.parameters };
    this.viewer?.setPoseFrozen(true);
    this.viewer?.setParameterOverrides(this.parameterOverrides);
    for (const [partId, opacity] of Object.entries(pose.parts || {})) {
      this.viewer?.setPartOpacity(partId, opacity);
    }
    this.parts = (this.viewer?.parts() || this.parts).map((part) => ({
      ...part,
      opacity: pose.parts?.[part.id] ?? part.opacity,
    }));
  }
  private deletePose() {
    if (!this.poseId) return;
    const poses = { ...this.poses };
    delete poses[this.poseId];
    this.poses = poses;
    const remaining = Object.keys(poses);
    this.poseId = remaining[remaining.length - 1] || "";
    this.renamingPose = false;
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
    if (!this.dragEnabled || event.button !== 0) return;
    this.dragging = true;
    this.dragLastX = event.clientX;
    this.dragLastY = event.clientY;
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  }
  private moveDrag(event: PointerEvent) {
    if (!this.dragging) return;
    const canvas = event.currentTarget as HTMLElement;
    const rect = canvas.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      this.offsetX = Math.min(1, Math.max(-1, this.offsetX + ((event.clientX - this.dragLastX) / rect.width) * 2));
      this.offsetY = Math.min(1, Math.max(-1, this.offsetY - ((event.clientY - this.dragLastY) / rect.height) * 2));
      this.applyTransform();
    }
    this.dragLastX = event.clientX;
    this.dragLastY = event.clientY;
  }
  private endDrag() {
    this.dragging = false;
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
    // The model viewer is a modal pane: focus belongs inside it.
    this.paneFocus.sync(this.querySelector<HTMLElement>("[data-overlay-pane]"), () => this.closeDetail());
    // tile() defers its artwork as `data-src`; this is what promotes it.
    this.lazyImages.observe(this);
  }
  private closeDetail() {
    this.generation += 1;
    this.viewer?.destroy();
    this.viewer = undefined;
    this.selected = "";
    this.detail = null;
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
    this.capturing = true;
    this.captureMessage = "";
    try {
      // Render into a 4x (8x on narrow stages) buffer like the reference tool,
      // then copy synchronously before the drawing buffer is restored.
      const rect = canvas.getBoundingClientRect();
      const scale = rect.width < 500 ? 8 : 4;
      const snapshot = document.createElement("canvas");
      const context = snapshot.getContext("2d");
      if (!context) throw new Error("Image capture is unavailable");
      const rendered = this.viewer?.captureSupersampled(scale, (source) => {
        snapshot.width = source.width;
        snapshot.height = source.height;
        context.drawImage(source, 0, 0);
      });
      if (rendered !== true) throw new Error("Canvas is not ready");
      await downloadBlob(await canvasToPngBlob(snapshot), `${this.selected || "viewer"}.png`);
    } catch {
      this.captureMessage = uiText(this.locale, "captureFailed");
    } finally {
      this.capturing = false;
    }
  }
  private renderCatalogWorkspace() {
    const models = this.filteredModels();
    if (this.selected) {
      clearBrowseBar();
      return this.renderModelDetail();
    }
    const types = [...new Set(this.models.map((model) => String(model.modelType || "")).filter(Boolean))];
    return html`
      ${renderBrowse({
        kind: "model",
        count: { value: models.length, label: "" },
        controls: viewSwitch(this.locale, this.view, (view) => {
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
    const character = detail ? this.character(Number(detail.characterId || 0)) : undefined;
    const band = detail ? this.band(Number(detail.bandId || 0)) : undefined;
    const motions = Array.isArray(detail?.motions) ? (detail.motions as Value[]) : [];
    const expressions = Array.isArray(detail?.expressions) ? (detail.expressions as Value[]) : [];
    const models = this.filteredModels();
    const modelIndex = models.findIndex((model) => this.key(model) === this.selected);
    return html`
      <aside
        class="viewer-detail pane-layer"
        role="dialog"
        aria-modal="true"
        aria-label=${uiText(this.locale, "model")}
        tabindex="-1"
        data-overlay-pane
      >
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
          <nav class="viewer-detail__navigation" aria-label="Live2D">
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
              <svg class="material-icon" width="20" height="20"><use href="/icons.svg#chevron_right"></use></svg>
            </button>
          </nav>
        </header>
        <div class="viewer-detail__body">
          <div class="viewer-stage viewer-detail__runtime">
            <canvas
              aria-label="Live2D"
              style=${this.dragEnabled ? "touch-action: none" : ""}
              @pointerdown=${this.beginDrag}
              @pointermove=${(event: PointerEvent) => {
                this.moveDrag(event);
                if (this.sway && this.parameterMode !== "pose")
                  this.viewer?.setLookAtClientPosition(event.clientX, event.clientY);
              }}
              @pointerup=${this.endDrag}
              @pointercancel=${this.endDrag}
              @pointerleave=${() => {
                if (this.sway && this.parameterMode !== "pose") this.viewer?.setLookPosition(0, 0);
              }}
            ></canvas>
            ${
              !detail && !this.error
                ? html`
                    <div class="viewer-state"><md-circular-progress indeterminate></md-circular-progress></div>
                  `
                : nothing
            }${
              this.error
                ? html`
                    <div class="viewer-state"><span>${this.error}</span></div>
                  `
                : nothing
            }${
              detail
                ? html`
                    ${
                      this.captureMessage
                        ? html`
                            <p class="viewer-capture-status" role="alert">${this.captureMessage}</p>
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
                        ?disabled=${this.capturing}
                        @click=${this.captureStage}
                        aria-label=${uiText(this.locale, "screenshot")}
                      >
                        <svg class="material-icon" width="22" height="22">
                          <use href="/icons.svg#photo_camera"></use>
                        </svg>
                      </button>
                    </div>
                  `
                : nothing
            }
          </div>
          <aside class="viewer-detail__info">
            <h2>${(detail && this.characterName(detail)) || "Live2D"}</h2>
            <dl class="spec-list">
              <div>
                <dt>${uiText(this.locale, "motion")}</dt>
                <dd>${motions.length}</dd>
              </div>
              <div>
                <dt>${uiText(this.locale, "expression")}</dt>
                <dd>${expressions.length}</dd>
              </div>
              <div>
                <dt>${uiText(this.locale, "type")}</dt>
                <dd>${detail ? this.modelType(detail) : "—"}</dd>
              </div>
              <div>
                <dt>${uiText(this.locale, "band")}</dt>
                <dd>${this.text(band?.bandName) || "—"}</dd>
              </div>
            </dl>
            <section class="viewer-behavior-controls">
              <h3>${uiText(this.locale, "settings")}</h3>
              ${(
                [
                  ["sway", this.sway],
                  ["breath", this.breath],
                  ["blink", this.blink],
                  ["loop", this.loopMotion],
                  ["drag", this.dragEnabled],
                ] as const
              ).map(
                ([key, selected]) => html`
                  <label>
                    <span>${uiText(this.locale, key)}</span>
                    <md-switch
                      .selected=${selected}
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
                    aria-label=${uiText(this.locale, "backgroundColor")}
                    @input=${(event: Event) => {
                      this.backgroundColor = String((event.target as HTMLInputElement).value || "#ecf0f1");
                      this.applyBackground();
                    }}
                  />
                  <md-switch
                    .selected=${this.backgroundTransparent}
                    @change=${() => this.toggle("transparent")}
                    aria-label=${uiText(this.locale, "transparent")}
                  ></md-switch>
                </span>
              </label>
            </section>
            <section class="viewer-transform-controls">
              <h3>${uiText(this.locale, "transform")}</h3>
              <label>
                <span>${uiText(this.locale, "scale")}</span>
                <md-slider
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
                <span>${uiText(this.locale, "horizontal")}</span>
                <md-slider
                  min="-1"
                  max="1"
                  step="0.01"
                  .value=${String(this.offsetX)}
                  @input=${(event: Event) => {
                    this.offsetX = Number((event.target as HTMLElement & { value?: number }).value || 0);
                    this.applyTransform();
                  }}
                ></md-slider>
              </label>
              <label>
                <span>${uiText(this.locale, "vertical")}</span>
                <md-slider
                  min="-1"
                  max="1"
                  step="0.01"
                  .value=${String(this.offsetY)}
                  @input=${(event: Event) => {
                    this.offsetY = Number((event.target as HTMLElement & { value?: number }).value || 0);
                    this.applyTransform();
                  }}
                ></md-slider>
              </label>
              <label>
                <span>Look X</span>
                <md-slider
                  min="-1"
                  max="1"
                  step="0.01"
                  .value=${String(this.lookX)}
                  @input=${(event: Event) => {
                    this.lookX = Number((event.target as HTMLElement & { value?: number }).value || 0);
                    this.applyLook();
                  }}
                ></md-slider>
              </label>
              <label>
                <span>Look Y</span>
                <md-slider
                  min="-1"
                  max="1"
                  step="0.01"
                  .value=${String(this.lookY)}
                  @input=${(event: Event) => {
                    this.lookY = Number((event.target as HTMLElement & { value?: number }).value || 0);
                    this.applyLook();
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
                        <button
                          class="icon-button runtime-button"
                          @click=${this.stopMotion}
                          aria-label=${uiText(this.locale, "stop")}
                          title=${uiText(this.locale, "stop")}
                        >
                          <svg class="material-icon" width="22" height="22">
                            <use href="/icons.svg#close"></use>
                          </svg>
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
                ? html`
                    <details class="viewer-parameter-editor">
                      <summary>
                        <span>${uiText(this.locale, "parameters")}</span>
                        <small>${this.parameters.length}</small>
                      </summary>
                      <div>
                        <div class="viewer-parameter-toolbar">
                          <span>${uiText(this.locale, "parameterMode")}</span>
                          <div class="segmented" aria-label=${uiText(this.locale, "parameterMode")}>
                            ${(["none", "capture", "pose"] as const).map(
                              (mode) => html`
                                <button
                                  aria-pressed=${this.parameterMode === mode}
                                  @click=${() => this.setParameterMode(mode)}
                                >
                                  ${uiText(this.locale, mode)}
                                </button>
                              `,
                            )}
                          </div>
                          <span class="viewer-parameter-actions">
                            <label class="button button--tonal">
                              ${uiText(this.locale, "import")}
                              <input type="file" accept="application/json,.json" @change=${this.importParameters} />
                            </label>
                            <button class="button button--tonal" @click=${this.exportParameters}>
                              ${uiText(this.locale, "export")}
                            </button>
                            <button class="button button--text" @click=${this.resetParameters}>
                              ${uiText(this.locale, "reset")}
                            </button>
                          </span>
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
                                        this.poseNameDraft = String(
                                          (event.target as HTMLInputElement).value || "",
                                        );
                                      }}
                                      @keydown=${(event: KeyboardEvent) => {
                                        if (event.key === "Enter") this.commitPoseName();
                                        if (event.key === "Escape") {
                                          this.renamingPose = false;
                                          this.poseNameDraft = "";
                                        }
                                      }}
                                    />
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
                                  `
                            }
                            <button
                              class="icon-button runtime-button"
                              @click=${this.savePose}
                              aria-label=${uiText(this.locale, "savePose")}
                              title=${uiText(this.locale, "savePose")}
                            >
                              <svg class="material-icon" width="20" height="20">
                                <use href="/icons.svg#add"></use>
                              </svg>
                            </button>
                            ${
                              this.poseId && !this.renamingPose
                                ? html`
                                    <button
                                      class="icon-button runtime-button"
                                      @click=${() => {
                                        this.renamingPose = true;
                                        this.poseNameDraft = this.poses[this.poseId]?.name || "";
                                      }}
                                      aria-label=${uiText(this.locale, "rename")}
                                      title=${uiText(this.locale, "rename")}
                                    >
                                      <svg class="material-icon" width="20" height="20">
                                        <use href="/icons.svg#edit"></use>
                                      </svg>
                                    </button>
                                    <button
                                      class="icon-button runtime-button"
                                      @click=${this.deletePose}
                                      aria-label=${uiText(this.locale, "remove")}
                                      title=${uiText(this.locale, "remove")}
                                    >
                                      <svg class="material-icon" width="20" height="20">
                                        <use href="/icons.svg#remove"></use>
                                      </svg>
                                    </button>
                                  `
                                : nothing
                            }
                            ${
                              this.renamingPose
                                ? html`
                                    <button
                                      class="icon-button runtime-button"
                                      @click=${this.commitPoseName}
                                      aria-label=${uiText(this.locale, "rename")}
                                      title=${uiText(this.locale, "rename")}
                                    >
                                      <svg class="material-icon" width="20" height="20">
                                        <use href="/icons.svg#check"></use>
                                      </svg>
                                    </button>
                                  `
                                : nothing
                            }
                          </div>
                        </div>
                        ${this.parameters.map(
                          (parameter) => html`
                            <label>
                              <span title=${parameter.id}>${parameter.id}</span>
                              <md-slider
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
                    </details>
                  `
                : nothing
            }
            ${
              this.parts.length
                ? html`
                    <details class="viewer-parameter-editor viewer-part-editor">
                      <summary>
                        <span>${uiText(this.locale, "partsVisibility")}</span>
                        <small>${this.parts.length}</small>
                      </summary>
                      <div>
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
                    </details>
                  `
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
