import { saveCanvasFrame } from "../lib/canvas-capture";
import { facet } from "./ui/facet";
import { collectionList, collectionTable, collectionView, viewSwitch, type CollectionView } from "./ui/collection-view";
import { LitElement, html, nothing } from "lit";
import { catalogUrl, fetchJson, localizedText, preferredLocale, readPath, uiText } from "./shared/catalog";
import { clearBrowseBar, filterGroup, renderBrowse } from "./ui/browse";
import { icon } from "./ui/icon";
import { tile } from "./ui/tile";

import { EXPANDED, matches, watchMedia } from "./ui/media";
import { LazyImages } from "./ui/lazy-images";
import { PaneFocus } from "./ui/pane";
import { errorState, loadingState } from "./ui/state";

type Value = Record<string, unknown>;
type Parameter = { id: string; value: number; minimum: number; maximum: number; defaultValue: number };
interface Viewer {
  readonly ready: boolean;
  captureFrame(notify?: boolean): boolean;
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
  setLoopMotion(name: string | null): void;
  setParameterOverrides(values: Record<string, number>): void;
  setTransform(transform: { offsetX: number; offsetY: number; scale: number }): void;
  setLookPosition(x: number, y: number): void;
  setLookAtClientPosition(clientX: number, clientY: number, anchor?: { x: number; y: number } | null): void;
  parameters(): Parameter[];
  playMotion(name: string): boolean;
  playExpression(name: string): boolean;
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
    backgroundVisible: { state: true },
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
  declare backgroundVisible: boolean;
  declare error: string;
  declare view: CollectionView;
  declare query: string;
  declare sort: "id" | "title" | "type" | "character" | "band";
  declare order: "asc" | "desc";
  declare filtersOpen: boolean;
  declare metaFilters: Record<string, string>;
  declare docked: boolean;
  declare bandFilter: number;
  declare characterFilter: number;
  declare typeFilter: string;
  declare parameters: Parameter[];
  declare parameterOverrides: Record<string, number>;
  declare parameterMode: "none" | "capture" | "pose";
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
    this.backgroundVisible = true;
    this.error = "";
    this.view = "grid";
    this.query = "";
    this.sort = "id";
    this.order = "asc";
    this.filtersOpen = false;
    this.metaFilters = {};
    this.docked = matches(EXPANDED);
    this.bandFilter = 0;
    this.characterFilter = 0;
    this.typeFilter = "";
    this.parameters = [];
    this.parameterOverrides = {};
    this.parameterMode = "none";
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
      this.characterFilter = Number(params.get("character") || 0);
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
    return this.text(model.title) || this.text(model.characterName) || String(model.live2dName || this.key(model));
  }
  private preview(model: Value) {
    return String(readPath(model, "preview.image") || readPath(model, "preview.runtime") || "");
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
      onFrame: () => this.captureAnimatedParameters(viewer),
      onError: (error) => {
        this.error = error instanceof Error ? error.message : String(error);
      },
    });
    this.viewer = viewer;
    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const ratio = Math.min(devicePixelRatio || 1, 2);
      viewer.setSize(Math.max(1, Math.round(rect.width * ratio)), Math.max(1, Math.round(rect.height * ratio)));
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
    viewer.setLoopMotion(detail.modelType === "live" && defaultMotion ? defaultMotion : null);
    this.parameters = viewer.parameters();
    viewer.setTransform({ offsetX: this.offsetX, offsetY: this.offsetY, scale: this.modelScale });
    viewer.setLookPosition(this.lookX, this.lookY);
  }
  private setParameter(parameter: Parameter, value: number) {
    if (this.parameterMode !== "pose") this.parameterMode = "pose";
    this.parameterOverrides = { ...this.parameterOverrides, [parameter.id]: value };
    this.viewer?.setParameterOverrides(this.parameterOverrides);
  }
  private resetParameter(parameter: Parameter) {
    this.setParameter(parameter, parameter.defaultValue);
  }
  private resetParameters() {
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
  }
  private captureAnimatedParameters(viewer: Viewer) {
    if (this.parameterMode !== "capture") return;
    const now = performance.now();
    if (now - this.captureUpdatedAt < 240) return;
    this.captureUpdatedAt = now;
    this.parameters = viewer.parameters();
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
      this.viewer?.setParameterOverrides(values);
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
    const blob = new Blob([JSON.stringify({ model: this.selected, mode: "pose", parameters: values }, null, 2)], {
      type: "application/json",
    });
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
  private toggle(kind: "breath" | "blink" | "sway" | "background" | "paused") {
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
    if (kind === "background") this.backgroundVisible = !this.backgroundVisible;
    if (kind === "paused") {
      this.paused = !this.paused;
      this.viewer?.setPaused(this.paused);
    }
  }
  private character(id: number) {
    return this.characters.find((item) => Number(item.characterId) === id);
  }
  private band(id: number) {
    return this.bands.find((item) => Number(item.bandId) === id);
  }
  private characterName(model: Value) {
    const character = this.character(Number(model.characterId || 0));
    return this.text(model.characterName) || this.text(character?.characterName) || String(model.characterKey || "");
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
    if (this.characterFilter) params.set("character", String(this.characterFilter));
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
  private filteredModels() {
    const needle = this.query.trim().normalize("NFKC").toLowerCase();
    const direction = this.order === "asc" ? 1 : -1;
    return this.models
      .filter((model) =>
        Object.entries(this.metaFilters).every(([key, value]) => !value || this.modelFacetValue(model, key) === value),
      )
      .filter((model) => {
        if (this.bandFilter && Number(model.bandId) !== this.bandFilter) return false;
        if (this.characterFilter && Number(model.characterId) !== this.characterFilter) return false;
        if (this.typeFilter && String(model.modelType || "") !== this.typeFilter) return false;
        return (
          !needle ||
          `${this.key(model)} ${this.modelTitle(model)} ${this.characterName(model)} ${this.bandName(model)}`
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
      await saveCanvasFrame(
        canvas,
        `${this.selected || "viewer"}.png`,
        () => this.viewer?.captureFrame(false) ?? false,
      );
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
            this.characterFilter = 0;
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
            ${this.renderModelFacets(
              uiText(this.locale, "character"),
              this.characters,
              this.characterFilter,
              (item) => Number(item.characterId),
              (item) => this.text(item.characterName),
              (item) => String(item.faceImage || ""),
              (value) => (this.characterFilter = Number(value)),
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
        ${models.map((model) => {
          const character = this.character(Number(model.characterId || 0));
          const title = this.modelTitle(model);
          return tile({
            kind: "model",
            title,
            subtitle: this.characterName(model),
            adornment: character?.faceImage
              ? html`
                  <img src=${String(character.faceImage)} alt="" width="16" height="16" loading="lazy" />
                `
              : undefined,
            label: title,
            image: this.preview(model),
            placeholder: icon("animation", 32),
            fit: "contain",
            onOpen: () => this.select(this.key(model)),
          });
        })}
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
          <div class=${`viewer-stage viewer-detail__runtime ${this.backgroundVisible ? "" : "background-hidden"}`}>
            <canvas
              aria-label="Live2D"
              @pointermove=${(event: PointerEvent) => {
                if (this.sway) this.viewer?.setLookAtClientPosition(event.clientX, event.clientY);
              }}
              @pointerleave=${() => {
                if (this.sway) this.viewer?.setLookPosition(0, 0);
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
            <h2>${this.text(detail?.characterName) || this.text(character?.characterName) || "Live2D"}</h2>
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
                  ["background", this.backgroundVisible],
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
            </section>
            <section class="viewer-transform-controls">
              <h3>${uiText(this.locale, "transform")}</h3>
              <label>
                <span>${uiText(this.locale, "scale")}</span>
                <md-slider
                  min="0.5"
                  max="1.8"
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
                      <md-outlined-select
                        class="viewer-inspector-select"
                        label=${uiText(this.locale, "motion")}
                        @change=${(event: Event) =>
                          this.viewer?.playMotion(
                            String((event.target as HTMLElement & { value?: string }).value || ""),
                          )}
                      >
                        ${motions.map(
                          (motion) => html`
                            <md-select-option value=${String(motion.name || "")}>
                              <div slot="headline">${String(motion.name || "")}</div>
                            </md-select-option>
                          `,
                        )}
                      </md-outlined-select>
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
