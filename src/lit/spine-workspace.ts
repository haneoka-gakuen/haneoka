import { readPageData } from "../lib/page-data";
import { navigationDocumentUrl } from "../lib/document-url";
import "../styles/model-tile.css";
import { canvasToPngBlob, downloadBlob } from "../lib/canvas-capture";
import { facet } from "./ui/facet";
import { collectionList, collectionTable, collectionView, viewSwitch, type CollectionView } from "./ui/collection-view";
import { LitElement, html, nothing } from "lit";
import { SpineStage } from "./runtime/spine-stage";
import { catalogUrl, fetchJson, preferredLocale, uiText } from "./shared/catalog";
import { clearBrowseBar, collectionSkeleton, filterGroup, renderBrowse } from "./ui/browse";
import { segmented } from "./ui/controls";
import { icon } from "./ui/icon";
import { tile } from "./ui/tile";
import { EXPANDED, matches, watchMedia } from "./ui/media";
import { LazyImages } from "./ui/lazy-images";
import { PaneFocus } from "./ui/pane";
import { errorState, loadingState } from "./ui/state";
import { entityHref, parseEntitySelection, returnStateFromLocation } from "../lib/resource-route";
import { readReleaseServer } from "../lib/release-server";
import { openDetailLocation, updateEntityHeading } from "../lib/detail-navigation";
import type { Locale } from "@haneoka/i18n";
import { loadingIndicator } from "./ui/loading-indicator";
import { StageFullscreen, StageGestures } from "./ui/stage-fullscreen";
type Value = Record<string, unknown>;

export class SpineWorkspace extends LitElement {
  static properties = {
    locale: { type: String },
    entityId: { type: String, attribute: "entity-id" },
    previewSrc: { type: String, attribute: "preview-src" },
    phase: { state: true },
    modelPhase: { state: true },
    modelError: { state: true },
    capturing: { state: true },
    captureMessage: { state: true },
    models: { state: true },
    selected: { state: true },
    detail: { state: true },
    error: { state: true },
    paused: { state: true },
    loop: { state: true },
    playbackSpeed: { state: true },
    skins: { state: true },
    skin: { state: true },
    stageFullscreen: { state: true },
    backgroundTransparent: { state: true },
    backgroundColor: { state: true },
    zoom: { state: true },
    offsetX: { state: true },
    offsetY: { state: true },
    visible: { state: true },
    query: { state: true },
    view: { state: true },
    sort: { state: true },
    order: { state: true },
    filtersOpen: { state: true },
    metaFilters: { state: true },
    familyFilter: { state: true },
    versionFilter: { state: true },
    docked: { state: true },
  };
  declare capturing: boolean;
  declare captureMessage: string;
  declare locale: string;
  declare entityId: string;
  declare previewSrc: string;
  declare phase: "loading" | "ready" | "error";
  declare modelPhase: "idle" | "loading" | "ready" | "error";
  declare modelError: string;
  declare models: Value[];
  declare selected: string;
  declare detail: Value | null;
  declare error: string;
  declare paused: boolean;
  declare loop: boolean;
  declare playbackSpeed: number;
  declare skins: string[];
  declare skin: string;
  declare stageFullscreen: boolean;
  declare backgroundTransparent: boolean;
  declare backgroundColor: string;
  declare zoom: number;
  declare offsetX: number;
  declare offsetY: number;
  declare visible: number;
  declare query: string;
  declare view: CollectionView;
  declare sort: "id" | "source" | "family" | "version";
  declare order: "asc" | "desc";
  declare filtersOpen: boolean;
  declare metaFilters: Record<string, string>;
  declare docked: boolean;
  declare familyFilter: string;
  declare versionFilter: string;
  private stage?: SpineStage;
  private disposeMedia?: () => void;
  private paneFocus = new PaneFocus();
  private lazyImages = new LazyImages();
  private generation = 0;
  private catalogRequest?: AbortController;
  private selectionRequest?: AbortController;
  private initializationTimer?: number;
  private ssrStageRemoved = false;
  private dragging = false;
  private fullscreen = new StageFullscreen((active) => (this.stageFullscreen = active));
  /** Drag to pan, wheel and two-finger pinch to zoom: always on once the model is ready. */
  private gestures = new StageGestures({
    enabled: () => this.modelPhase === "ready",
    pan: (dx, dy) => {
      this.placement = {
        ...this.placement,
        offsetX: this.placement.offsetX + dx / this.placement.scale,
        offsetY: this.placement.offsetY + dy / this.placement.scale,
      };
      this.applyPlacement(false);
    },
    zoom: (ratio, x, y) => {
      const previous = this.placement.scale;
      const scale = Math.min(4, Math.max(0.25, previous * ratio));
      this.placement = {
        scale,
        offsetX: this.placement.offsetX + x * (1 / scale - 1 / previous),
        offsetY: this.placement.offsetY + y * (1 / scale - 1 / previous),
      };
      this.applyPlacement(!this.dragging);
    },
    onDraggingChange: (dragging) => {
      this.dragging = dragging;
      this.setDragCursor();
      if (!dragging) this.applyPlacement(true);
    },
  });
  private placement = { offsetX: 0, offsetY: 0, scale: 1 };
  constructor() {
    super();
    this.capturing = false;
    this.captureMessage = "";
    this.locale = "ja";
    this.entityId = "";
    this.previewSrc = "";
    this.phase = "loading";
    this.modelPhase = "idle";
    this.modelError = "";
    this.models = [];
    this.selected = "";
    this.detail = null;
    this.error = "";
    this.paused = false;
    this.loop = true;
    this.playbackSpeed = 1;
    this.skins = [];
    this.skin = "";
    this.stageFullscreen = false;
    this.backgroundTransparent = true;
    this.backgroundColor = "#ecf0f1";
    this.zoom = 1;
    this.offsetX = 0;
    this.offsetY = 0;
    this.visible = 80;
    this.query = "";
    this.view = "grid";
    this.sort = "id";
    this.order = "asc";
    this.filtersOpen = false;
    this.metaFilters = {};
    this.docked = matches(EXPANDED);
    this.familyFilter = "";
    this.versionFilter = "";
  }
  createRenderRoot() {
    return this;
  }
  connectedCallback() {
    super.connectedCallback();
    this.fullscreen.connect();
    const selection = parseEntitySelection(navigationDocumentUrl().pathname);
    if (selection?.source === "canonical" && selection.route.kind === "spine") this.entityId = selection.route.id;
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
      this.sort = sort === "source" || sort === "family" || sort === "version" ? sort : "id";
      this.order = params.get("order") === "desc" ? "desc" : "asc";
      this.familyFilter = params.get("family") || "";
      this.versionFilter = params.get("version") || "";
      void this.loadCatalog();
    }, 0);
  }
  disconnectedCallback() {
    this.generation += 1;
    this.catalogRequest?.abort();
    this.selectionRequest?.abort();
    if (this.initializationTimer != null) window.clearTimeout(this.initializationTimer);
    this.initializationTimer = undefined;
    clearBrowseBar();
    this.lazyImages.disconnect();
    this.disposeMedia?.();
    this.paneFocus.detach();
    this.endDrag();
    this.fullscreen.disconnect();
    this.stage?.dispose();
    this.stage = undefined;
    this.modelPhase = "idle";
    super.disconnectedCallback();
  }
  private url(id = "") {
    return catalogUrl("spine", id);
  }
  private async loadCatalog() {
    const page = readPageData<{ schema: string; id: string; model: Value }>(this);
    if (page?.schema === "haneoka-model-page-v1" && page.id === this.entityId) {
      this.models = [page.model];
      this.phase = "ready";
      if (this.modelPhase !== "ready") void this.select(page.id, false, page.model);
      return;
    }
    this.catalogRequest?.abort();
    const controller = new AbortController();
    this.catalogRequest = controller;
    this.error = "";
    // The selected detail is independent of the collection index. Loading it
    // beside the catalog keeps canonical pages responsive without duplicating
    // the SpineStage lifecycle.
    if (this.selected && this.modelPhase !== "ready") void this.select(this.selected, false);
    try {
      const data = await fetchJson<Value>(this.url(), { signal: controller.signal });
      if (!this.isConnected || controller.signal.aborted || this.catalogRequest !== controller) return;
      this.models = Object.values((data.models as Record<string, Value>) || {});
      this.phase = "ready";
    } catch (error) {
      if (!this.isConnected || controller.signal.aborted || this.catalogRequest !== controller) return;
      this.phase = "error";
      this.error = error instanceof Error ? error.message : String(error);
      // A selected detail request is independent of the collection index. Do
      // not cover a ready stage, but keep an unresolved failure actionable.
    }
  }
  private modelTitle(model: Value) {
    return (
      String(model.sourcePathKey || model.id || uiText(this.locale, "spine"))
        .split("/")
        .at(-1)
        ?.replace(/_SkeletonData(?:\.asset)?$/i, "") || String(model.id)
    );
  }
  private familyName(value: unknown) {
    const family = String(value || "");
    if (family === "home-spot") return uiText(this.locale, "spinePage.families.homeSpot");
    return family || "—";
  }
  private async select(id: string, updateUrl = true, prepared?: Value) {
    if (updateUrl && id !== this.entityId) {
      openDetailLocation(
        entityHref({
          server: readReleaseServer(),
          locale: preferredLocale(this.locale) as Locale,
          kind: "spine",
          id,
          returnTo: this.entityId
            ? new URLSearchParams(location.search).get("return") || undefined
            : returnStateFromLocation(location.pathname, location.search, "spine"),
        }),
      );
      return;
    }
    const generation = ++this.generation;
    this.selectionRequest?.abort();
    const controller = new AbortController();
    this.selectionRequest = controller;
    this.dataset.entityReady = "false";
    this.selected = id;
    this.detail = null;
    this.modelError = "";
    this.captureMessage = "";
    this.modelPhase = "loading";
    this.endDrag();
    this.skins = [];
    this.skin = "";
    this.resetPlacement();
    this.stage?.dispose();
    this.stage = undefined;
    if (updateUrl) {
      const params = new URLSearchParams(location.search);
      params.set("model", id);
      history.replaceState(history.state, "", `${location.pathname}?${params}`);
    }
    try {
      const detail = prepared || (await fetchJson<Value>(this.url(id), { signal: controller.signal }));
      if (generation !== this.generation || controller.signal.aborted || !this.isConnected) return;
      this.detail = detail;
      await this.updateComplete;
      const host = this.querySelector<HTMLElement>("[data-spine-stage]");
      if (!host || generation !== this.generation || controller.signal.aborted || !this.isConnected) return;
      const stage = new SpineStage(host);
      this.stage = stage;
      await stage.load(detail, controller.signal);
      if (generation !== this.generation || controller.signal.aborted || !this.isConnected) {
        stage.dispose();
        return;
      }
      stage.setLoop(this.loop);
      stage.setPaused(this.paused);
      stage.setPlaybackRate(this.playbackSpeed);
      stage.setBackgroundColor(this.readBackgroundColor());
      const skins = stage.skins();
      this.skins = skins;
      this.skin = stage.skinName();
      stage.setTransform(this.placement);
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      if (generation === this.generation && !controller.signal.aborted && this.isConnected) {
        this.modelPhase = "ready";
        this.dataset.entityReady = "true";
      }
    } catch (error) {
      if (generation === this.generation && !controller.signal.aborted && this.isConnected) {
        console.warn("Spine model failed to load", error);
        this.modelPhase = "error";
        this.modelError =
          error instanceof Error && error.name === "TimeoutError"
            ? uiText(this.locale, "requestTimedOut")
            : uiText(this.locale, "unavailable");
      }
    }
  }
  private togglePaused() {
    this.paused = !this.paused;
    this.stage?.setPaused(this.paused);
  }
  private toggleLoop() {
    this.loop = !this.loop;
    this.stage?.setLoop(this.loop);
  }
  private readBackgroundColor(): { r: number; g: number; b: number } | null {
    const match = /^#?([0-9a-f]{6})$/i.exec(this.backgroundColor.trim());
    if (this.backgroundTransparent || !match) return null;
    const hex = match[1];
    return {
      r: parseInt(hex.slice(0, 2), 16) / 255,
      g: parseInt(hex.slice(2, 4), 16) / 255,
      b: parseInt(hex.slice(4, 6), 16) / 255,
    };
  }
  private applyBackground() {
    this.stage?.setBackgroundColor(this.readBackgroundColor());
  }
  private toggleBackground() {
    this.backgroundTransparent = !this.backgroundTransparent;
    this.applyBackground();
  }
  private applyPlacement(sync = true) {
    const applied = this.stage?.setTransform(this.placement) || this.placement;
    this.placement = { ...applied };
    if (sync) {
      this.zoom = applied.scale;
      this.offsetX = applied.offsetX;
      this.offsetY = applied.offsetY;
    }
  }
  private resetPlacement() {
    const applied = this.stage?.resetTransform() || { offsetX: 0, offsetY: 0, scale: 1 };
    this.placement = { ...applied };
    this.zoom = applied.scale;
    this.offsetX = applied.offsetX;
    this.offsetY = applied.offsetY;
  }
  private endDrag() {
    this.gestures.cancel();
  }
  private setDragCursor() {
    const canvas = this.querySelector<HTMLCanvasElement>("[data-spine-stage] canvas");
    if (canvas) canvas.style.cursor = this.modelPhase === "ready" ? (this.dragging ? "grabbing" : "grab") : "default";
  }
  private replay() {
    this.stage?.replay();
    this.paused = false;
  }
  private playAnimation(name: string) {
    if (this.stage?.play(name)) this.paused = false;
  }
  private setPlaybackSpeed(value: number) {
    this.playbackSpeed = Math.min(2, Math.max(0.25, Number.isFinite(value) ? value : 1));
    this.stage?.setPlaybackRate(this.playbackSpeed);
  }
  private setSkin(name: string) {
    if (!this.stage?.setSkin(name)) return;
    this.skin = name;
  }
  private sync() {
    const params = new URLSearchParams();
    if (this.selected) params.set("model", this.selected);
    if (this.query) params.set("q", this.query);
    if (this.view !== "grid") params.set("view", this.view);
    if (this.sort !== "id") params.set("sort", this.sort);
    if (this.order !== "asc") params.set("order", this.order);
    if (this.familyFilter) params.set("family", this.familyFilter);
    if (this.versionFilter) params.set("version", this.versionFilter);
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
  private filteredModels() {
    const needle = this.query.trim().normalize("NFKC").toLowerCase();
    const direction = this.order === "asc" ? 1 : -1;
    return this.models
      .filter((model) =>
        Object.entries(this.metaFilters).every(([key, value]) => !value || this.modelFacetValue(model, key) === value),
      )
      .filter(
        (model) =>
          (!this.familyFilter || model.family === this.familyFilter) &&
          (!this.versionFilter || model.spineVersion === this.versionFilter) &&
          (!needle ||
            `${this.modelTitle(model)} ${model.sourcePathKey || ""} ${model.family || ""} ${model.spineVersion || ""}`
              .normalize("NFKC")
              .toLowerCase()
              .includes(needle)),
      )
      .sort((left, right) => {
        let result = String(left.id || "").localeCompare(String(right.id || ""), "en", { numeric: true });
        if (this.sort === "source")
          result = this.modelTitle(left).localeCompare(this.modelTitle(right), "en", { numeric: true });
        if (this.sort === "family")
          result = String(left.family || "").localeCompare(String(right.family || ""), "en", { numeric: true });
        if (this.sort === "version")
          result = String(left.spineVersion || "").localeCompare(String(right.spineVersion || ""), "en", {
            numeric: true,
          });
        return direction * result;
      });
  }
  updated() {
    if (this.entityId && this.detail) updateEntityHeading(this, this.modelTitle(this.detail));
    this.removeSsrStageWhenOwned();
    // Collection details are modal panes; canonical entity routes are ordinary
    // page flow and must leave focus in the shell/document.
    this.paneFocus.sync(this.entityId ? null : this.querySelector<HTMLElement>("[data-overlay-pane]"), () =>
      this.closeDetail(),
    );
    // tile() defers its artwork as `data-src`; this is what promotes it.
    this.lazyImages.observe(this);
    this.setDragCursor();
    const skinSelect = this.querySelector<HTMLElement & { value: string }>("[data-spine-skin]");
    if (skinSelect && this.skin && skinSelect.value !== this.skin) skinSelect.value = this.skin;
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
    this.selectionRequest?.abort();
    this.selectionRequest = undefined;
    this.endDrag();
    this.stage?.dispose();
    this.stage = undefined;
    this.selected = "";
    this.detail = null;
    this.modelPhase = "idle";
    this.modelError = "";
    this.dataset.entityReady = "false";
    this.sync();
  }
  private retryModel() {
    if (this.phase === "error") {
      void this.loadCatalog();
      return;
    }
    if (!this.selected) return;
    void this.select(this.selected, false);
  }
  private adjacentModel(offset: number) {
    const models = this.filteredModels();
    const index = models.findIndex((model) => String(model.id) === this.selected);
    const next = models[index + offset];
    if (next) void this.select(String(next.id));
  }
  private async captureStage() {
    const stage = this.stage;
    const generation = this.generation;
    const selected = this.selected;
    if (!stage || this.modelPhase !== "ready" || this.capturing) return;
    this.capturing = true;
    this.captureMessage = "";
    try {
      const snapshot = document.createElement("canvas");
      const context = snapshot.getContext("2d");
      if (!context) throw new Error("Image capture is unavailable");
      const rendered = stage.captureSupersampled((canvas) => {
        snapshot.width = canvas.width;
        snapshot.height = canvas.height;
        context.drawImage(canvas, 0, 0);
      });
      if (!rendered) throw new Error("Canvas is not ready");
      const blob = await canvasToPngBlob(snapshot);
      if (generation !== this.generation || !this.isConnected) return;
      await downloadBlob(blob, `${selected || "stage"}.png`);
    } catch {
      if (generation === this.generation) this.captureMessage = uiText(this.locale, "captureFailed");
    } finally {
      this.capturing = false;
    }
  }
  private renderCatalogWorkspace() {
    const models = this.filteredModels();
    if (this.entityId || this.selected) {
      clearBrowseBar();
      return this.renderModelDetail();
    }
    const families = [...new Set(this.models.map((model) => String(model.family || "")).filter(Boolean))];
    const versions = [...new Set(this.models.map((model) => String(model.spineVersion || "")).filter(Boolean))];
    return html`
      ${renderBrowse({
        kind: "model",
        count: { value: this.phase === "ready" ? models.length : null, label: "" },
        modes: viewSwitch(this.locale, this.view, (view) => {
          this.view = view;
          this.sync();
        }),
        results:
          this.phase === "loading"
            ? this.view === "grid"
              ? html`${collectionSkeleton("model")}${loadingState(uiText(this.locale, "loading"))}`
              : loadingState(uiText(this.locale, "loading"))
            : this.phase === "error"
              ? errorState(
                  uiText(this.locale, "unavailable"),
                  uiText(this.locale, "retry"),
                  () => void this.loadCatalog(),
                  this.error,
                )
              : this.view === "grid"
                ? html`
                    <div class="collection collection--model">
                      ${models.map((model) => this.renderModelCard(model))}
                    </div>
                  `
                : this.view === "table"
                  ? this.renderModelList(models)
                  : this.renderSimpleList(models),
        filters: {
          label: uiText(this.locale, "filter"),
          open: this.filtersOpen,
          count:
            Number(Boolean(this.query)) +
            Number(Boolean(this.familyFilter)) +
            Number(Boolean(this.versionFilter)) +
            Object.values(this.metaFilters).filter(Boolean).length,
          closeLabel: uiText(this.locale, "close"),
          resetLabel: uiText(this.locale, "reset"),
          onOpen: () => (this.filtersOpen = true),
          onClose: () => (this.filtersOpen = false),
          onReset: () => {
            this.query = "";
            this.metaFilters = {};
            this.familyFilter = "";
            this.versionFilter = "";
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
            ${this.renderFacet(uiText(this.locale, "family"), families, this.familyFilter, (value) => (this.familyFilter = value))}
            ${this.renderFacet(uiText(this.locale, "version"), versions, this.versionFilter, (value) => (this.versionFilter = value))}
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
                        ["source", uiText(this.locale, "model")],
                        ["family", uiText(this.locale, "family")],
                        ["version", uiText(this.locale, "version")],
                      ] as const
                    ).map(
                      ([value, label]) => html`
                        <md-select-option value=${value} ?selected=${this.sort === value}>
                          <div slot="headline">${label}</div>
                        </md-select-option>
                      `,
                    )}
                  </md-outlined-select>
                  ${segmented({
                    label: uiText(this.locale, "order"),
                    value: this.order,
                    options: [
                      { value: "asc" as const, label: uiText(this.locale, "ascending"), icon: "arrow_upward" },
                      { value: "desc" as const, label: uiText(this.locale, "descending"), icon: "arrow_downward" },
                    ],
                    onSelect: (order) => {
                      this.order = order;
                      this.sync();
                    },
                    grow: true,
                  })}
                </div>
              `,
            )}
          `,
        },
      })}
    `;
  }
  private renderFacet(label: string, values: string[], selected: string, update: (value: string) => void) {
    const key = label === uiText(this.locale, "family") ? "family" : "spineVersion";
    return facet(
      label,
      this.locale,
      values.map((value) => ({
        value,
        label: key === "family" ? this.familyName(value) : value,
        count: this.models.filter((model) => String(model[key]) === value).length,
      })),
      selected ? [selected] : [],
      (value) => {
        update(selected === value ? "" : value);
        this.sync();
      },
    );
  }
  private preview(model: Value) {
    return String((model.preview as Value | undefined)?.url || "");
  }
  private previewSource(detail?: Value | null): string {
    if (this.previewSrc) return this.previewSrc;
    if (detail?.preview && typeof detail.preview === "object") {
      const preview = detail.preview as Value;
      const source = String(preview.url || preview.path || "");
      if (source) return source;
    }
    const selected = this.models.find((model) => String(model.id) === this.selected);
    return (selected && this.preview(selected)) || this.previewSrc;
  }
  private previewRatio(detail?: Value | null): string {
    const page = this.entityId ? readPageData<{ id: string; model: Value }>(this) : undefined;
    const values = [
      detail?.preview,
      this.models.find((model) => String(model.id) === this.selected)?.preview,
      page?.id === this.entityId ? page.model.preview : undefined,
    ];
    for (const value of values) {
      if (!value || typeof value !== "object") continue;
      const preview = value as Value;
      const width = Number(preview.width || preview.imageWidth || preview.naturalWidth || 0);
      const height = Number(preview.height || preview.imageHeight || preview.naturalHeight || 0);
      if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) return `${width} / ${height}`;
      const ratio = Number(preview.aspectRatio || preview.ratio || 0);
      if (Number.isFinite(ratio) && ratio > 0) return `${ratio}`;
    }
    return "";
  }
  private renderModelCard(model: Value) {
    const title = this.modelTitle(model);
    return tile({
      kind: "model",
      title,
      subtitle: this.familyName(model.family || model.spineVersion || "Spine"),
      label: title,
      image: this.preview(model),
      placeholder: icon("animation", 32),
      fit: "contain",
      onOpen: () => this.select(String(model.id)),
    });
  }
  private renderSimpleList(models: Value[]) {
    return collectionList(
      models.map((model) => ({
        id: String(model.id),
        title: this.modelTitle(model),
        subtitle: this.familyName(model.family || model.spineVersion || "Spine"),
        image: this.preview(model),
        onOpen: () => this.select(String(model.id)),
      })),
    );
  }
  private renderModelList(models: Value[]) {
    return collectionTable(
      uiText(this.locale, "table"),
      [
        uiText(this.locale, "model"),
        uiText(this.locale, "family"),
        uiText(this.locale, "version"),
        uiText(this.locale, "animations"),
      ],
      models.map((model) => [
        html`
          <button class="table-entity" type="button" @click=${() => this.select(String(model.id))}>
            ${
              this.preview(model)
                ? html`
                    <span class="table-entity__media"><img data-src=${this.preview(model)} alt="" /></span>
                  `
                : nothing
            }
            <span class="table-entity__copy">
              <strong>${this.modelTitle(model)}</strong>
              <small>${this.familyName(model.family)}</small>
            </span>
          </button>
        `,
        this.familyName(model.family),
        String(model.spineVersion || "—"),
        Number(model.animationCount || (Array.isArray(model.animations) ? model.animations.length : 0)),
      ]),
    );
  }
  private renderModelDetail() {
    const detail = this.detail;
    const page = Boolean(this.entityId);
    const animations = Array.isArray(detail?.animations) ? detail.animations : [];
    const animationName = (animation: unknown) =>
      typeof animation === "string" ? animation : String((animation as Value | undefined)?.name || "");
    const models = this.filteredModels();
    const modelIndex = models.findIndex((model) => String(model.id) === this.selected);
    const previewSrc = this.previewSource(detail);
    const previewRatio = this.previewRatio(detail);
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
                  <span>
                    <strong>${detail ? this.modelTitle(detail) : this.selected}</strong>
                    <small>
                      ${this.familyName(detail?.family || detail?.spineVersion || uiText(this.locale, "spine"))}
                    </small>
                  </span>
                  <nav class="viewer-detail__navigation" aria-label=${uiText(this.locale, "spine")}>
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
            aria-label=${detail ? this.modelTitle(detail) : uiText(this.locale, "spine")}
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
            <div
              data-spine-stage
              class="spine-stage"
              style=${this.modelPhase === "ready" ? "touch-action: none" : nothing}
              @pointerdown=${this.gestures.down}
              @pointermove=${this.gestures.move}
              @pointerup=${this.gestures.up}
              @pointercancel=${this.gestures.up}
              @lostpointercapture=${this.gestures.up}
              @wheel=${this.gestures.wheel}
            ></div>
            ${
              this.modelPhase === "loading"
                ? html`
                    <div class="viewer-state" role="status" aria-live="polite">
                      ${loadingIndicator()}
                      <span>${uiText(this.locale, "loading")}</span>
                    </div>
                  `
                : nothing
            }${
              this.modelError && this.modelPhase === "error"
                ? html`
                    <div class="viewer-state" role="alert">
                      <span>${this.modelError}</span>
                      <button class="button button--tonal" type="button" @click=${this.retryModel}>
                        ${uiText(this.locale, "retry")}
                      </button>
                    </div>
                  `
                : nothing
            }${
              detail && this.modelPhase === "ready"
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
                        @click=${this.togglePaused}
                        aria-label=${uiText(this.locale, this.paused ? "play" : "pause")}
                      >
                        <svg class="material-icon" width="22" height="22">
                          <use href=${this.paused ? "/icons.svg#play_arrow" : "/icons.svg#pause"}></use>
                        </svg>
                      </button>
                      <button
                        class="icon-button runtime-button"
                        @click=${this.replay}
                        aria-label=${uiText(this.locale, "replay")}
                      >
                        <svg class="material-icon" width="22" height="22"><use href="/icons.svg#replay"></use></svg>
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
                      <button
                        class="icon-button runtime-button"
                        aria-pressed=${this.stageFullscreen}
                        @click=${(event: Event) =>
                          void this.fullscreen.toggle(
                            (event.currentTarget as HTMLElement).closest<HTMLElement>(".viewer-stage"),
                          )}
                        aria-label=${uiText(this.locale, this.stageFullscreen ? "fullscreenExit" : "fullscreen")}
                        title=${uiText(this.locale, this.stageFullscreen ? "fullscreenExit" : "fullscreen")}
                      >
                        <svg class="material-icon" width="22" height="22">
                          <use href=${this.stageFullscreen ? "/icons.svg#fullscreen_exit" : "/icons.svg#fullscreen"}></use>
                        </svg>
                      </button>
                    </div>
                  `
                : nothing
            }
          </div>
          <aside class="viewer-detail__info" ?inert=${this.modelPhase !== "ready"}>
            ${
              this.phase === "error" && this.modelPhase === "ready"
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
              <label>
                <span>${uiText(this.locale, "loop")}</span>
                <md-switch
                  .selected=${this.loop}
                  @change=${this.toggleLoop}
                  aria-label=${uiText(this.locale, "loop")}
                ></md-switch>
              </label>
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
                    @change=${this.toggleBackground}
                    aria-label=${uiText(this.locale, "backgroundColor")}
                  ></md-switch>
                </span>
              </label>
              <label>
                <span>${uiText(this.locale, "speed")}</span>
                <md-slider
                  aria-label=${uiText(this.locale, "speed")}
                  min="0.25"
                  max="2"
                  step="0.05"
                  .value=${String(this.playbackSpeed)}
                  @input=${(event: Event) =>
                    this.setPlaybackSpeed(Number((event.target as HTMLElement & { value?: number }).value || 1))}
                ></md-slider>
              </label>
            </section>
            <section ?hidden=${!this.skins.length}>
              <h3>${uiText(this.locale, "spinePage.skins")}</h3>
              <md-outlined-select
                data-spine-skin
                class="viewer-inspector-select"
                label=${uiText(this.locale, "spinePage.skins")}
                .value=${this.skin}
                @change=${(event: Event) =>
                  this.setSkin(String((event.target as HTMLElement & { value?: string }).value || ""))}
              >
                ${this.skins.map(
                  (name) => html`
                    <md-select-option value=${name} ?selected=${this.skin === name}>
                      <div slot="headline">${name}</div>
                    </md-select-option>
                  `,
                )}
              </md-outlined-select>
            </section>
            <section class="viewer-transform-controls">
              <h3>${uiText(this.locale, "transform")}</h3>
              <label>
                <span>${uiText(this.locale, "zoom")}</span>
                <md-slider
                  aria-label=${uiText(this.locale, "zoom")}
                  min="0.25"
                  max="4"
                  step="0.01"
                  .value=${String(this.zoom)}
                  @input=${(event: Event) => {
                    this.placement = {
                      ...this.placement,
                      scale: Number((event.target as HTMLElement & { value?: number }).value || 1),
                    };
                    this.applyPlacement();
                  }}
                ></md-slider>
              </label>
              <button class="button button--text viewer-panel-button" type="button" @click=${this.resetPlacement}>
                ${uiText(this.locale, "reset")}
              </button>
            </section>
            ${
              animations.length
                ? html`
                    <section>
                      <h3>${uiText(this.locale, "animations")}</h3>
                      <md-outlined-select
                        class="viewer-inspector-select"
                        label=${uiText(this.locale, "animations")}
                        .value=${this.stage?.animationName() || ""}
                        @change=${(event: Event) =>
                          this.playAnimation(
                            animationName((event.target as HTMLElement & { value?: string }).value || ""),
                          )}
                      >
                        ${animations.map(
                          (animation) => html`
                            <md-select-option value=${animationName(animation)}>
                              <div slot="headline">${animationName(animation)}</div>
                            </md-select-option>
                          `,
                        )}
                      </md-outlined-select>
                    </section>
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
customElements.define("spine-workspace", SpineWorkspace);
