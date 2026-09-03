import { LitElement, html, nothing } from "lit";
import { catalogUrl, fetchJson, localizedText, preferredLocale, readPath, uiText } from "./shared/catalog";
import { renderGridIdentity } from "./shared/grid-identity";

type Value = Record<string, unknown>;
type Parameter = { id: string; value: number; minimum: number; maximum: number; defaultValue: number };
interface Viewer {
  readonly ready: boolean;
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
  };
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
  declare view: "grid" | "list";
  declare query: string;
  declare sort: "id" | "title" | "type" | "character" | "band";
  declare order: "asc" | "desc";
  declare filtersOpen: boolean;
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
    this.locale = "ja";
    this.phase = "loading";
    this.models = [];
    this.selected = "";
    this.detail = null;
    this.paused = false;
    this.breath = true;
    this.blink = true;
    this.sway = true;
    this.backgroundVisible = true;
    this.error = "";
    this.view = "grid";
    this.query = "";
    this.sort = "id";
    this.order = "asc";
    this.filtersOpen = false;
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
      this.view = params.get("view") === "list" ? "list" : "grid";
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
    this.generation += 1;
    this.resizeObserver?.disconnect();
    this.viewer?.destroy();
    super.disconnectedCallback();
  }
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
    history.replaceState(history.state, "", `${location.pathname}${params.size ? `?${params}` : ""}`);
  }
  private filteredModels() {
    const needle = this.query.trim().normalize("NFKC").toLowerCase();
    const direction = this.order === "asc" ? 1 : -1;
    return this.models
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
  private captureStage() {
    const canvas = this.querySelector<HTMLCanvasElement>(".viewer-detail__runtime canvas");
    canvas?.toBlob((blob) => {
      if (!blob) return;
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = `${this.selected || "live2d"}.png`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 0);
    });
  }
  private renderCatalogWorkspace() {
    const models = this.filteredModels();
    if (this.selected) return this.renderModelDetail();
    const types = [...new Set(this.models.map((model) => String(model.modelType || "")).filter(Boolean))];
    const setView = (view: "grid" | "list") => {
      this.view = view;
      this.sync();
    };
    return html`
      <section class="catalog model-catalog">
        <div class="catalog__toolbar">
          <span class="catalog__count">${models.length}</span>
          <div class="catalog__view">
            <button
              aria-label=${uiText(this.locale, "grid")}
              aria-pressed=${this.view === "grid"}
              @click=${() => setView("grid")}
            >
              <svg class="material-icon" width="20" height="20">
                <use href=${`/icons.svg#grid_view${this.view === "grid" ? "-filled" : ""}`}></use>
              </svg>
            </button>
            <button
              aria-label=${uiText(this.locale, "list")}
              aria-pressed=${this.view === "list"}
              @click=${() => setView("list")}
            >
              <svg class="material-icon" width="20" height="20">
                <use href=${`/icons.svg#view_list${this.view === "list" ? "-filled" : ""}`}></use>
              </svg>
            </button>
          </div>
          <button
            class="icon-button catalog__filter-toggle"
            @click=${() => (this.filtersOpen = !this.filtersOpen)}
            aria-label=${uiText(this.locale, "filter")}
          >
            <svg class="material-icon" width="24" height="24">
              <use href=${`/icons.svg#filter_alt${this.filtersOpen ? "-filled" : ""}`}></use>
            </svg>
          </button>
        </div>
        <aside
          class=${`catalog__filters ${this.filtersOpen ? "open" : ""}`}
          aria-hidden=${String(!this.filtersOpen)}
          ?inert=${!this.filtersOpen}
        >
          <div class="catalog__filter-header">
            <h2>${uiText(this.locale, "filter")}</h2>
            <button
              class="button button--text"
              @click=${() => {
                this.query = "";
                this.bandFilter = 0;
                this.characterFilter = 0;
                this.typeFilter = "";
                this.sync();
              }}
            >
              ${uiText(this.locale, "reset")}
            </button>
          </div>
          <div class="catalog__filter-stack">
            <md-outlined-text-field
              type="search"
              label=${uiText(this.locale, "search")}
              .value=${this.query}
              @input=${(event: Event) => {
                this.query = String((event.target as HTMLElement & { value?: string }).value || "");
                this.sync();
              }}
            >
              <svg slot="leading-icon" class="material-icon" width="20" height="20">
                <use href="/icons.svg#search"></use>
              </svg>
            </md-outlined-text-field>
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
            <fieldset class="catalog__filter-group">
              <legend>${uiText(this.locale, "type")}</legend>
              <div class="catalog__chips">
                ${types.map(
                  (type) => html`
                    <button
                      class="chip"
                      aria-pressed=${this.typeFilter === type}
                      @click=${() => {
                        this.typeFilter = this.typeFilter === type ? "" : type;
                        this.sync();
                      }}
                    >
                      ${this.modelType({ modelType: type })}
                    </button>
                  `,
                )}
              </div>
            </fieldset>
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
        </aside>
        <div class="catalog__content">
          ${
            this.phase === "loading"
              ? html`
                  <div class="catalog-state"><md-circular-progress indeterminate></md-circular-progress></div>
                `
              : this.phase === "error"
                ? html`
                    <div class="catalog-state">${this.error}</div>
                  `
                : this.view === "grid"
                  ? this.renderModelGrid(models)
                  : this.renderModelList(models)
          }
        </div>
        ${
          this.filtersOpen
            ? html`
                <button class="sheet-scrim" @click=${() => (this.filtersOpen = false)}></button>
              `
            : nothing
        }
      </section>
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
    return html`
      <fieldset class="catalog__filter-group">
        <legend>${label}</legend>
        <div class="catalog__chips">
          ${items.map(
            (item) => html`
              <button
                class="chip"
                aria-pressed=${selected === id(item)}
                @click=${() => {
                  update(selected === id(item) ? 0 : id(item));
                  this.sync();
                }}
              >
                ${
                  image(item)
                    ? html`
                        <img src=${image(item)} alt="" />
                      `
                    : nothing
                }${title(item)}
              </button>
            `,
          )}
        </div>
      </fieldset>
    `;
  }
  private renderModelGrid(models: Value[]) {
    return html`
      <div class="model-grid">
        ${models.map((model) => {
          const character = this.character(Number(model.characterId || 0));
          return html`
            <button class="model-card content-grid-tile" @click=${() => this.select(this.key(model))}>
              <span class=${`model-card__media ${this.preview(model) ? "media-loading" : ""}`}>
                ${
                  this.preview(model)
                    ? html`
                        <img
                          src=${this.preview(model)}
                          alt=""
                          loading="lazy"
                          @load=${(event: Event) => (event.currentTarget as HTMLImageElement).classList.add("is-loaded")}
                        />
                      `
                    : html`
                        <svg class="material-icon" width="32" height="32"><use href="/icons.svg#animation"></use></svg>
                      `
                }
              </span>
              <span class="model-card__copy">
                ${renderGridIdentity(
                  this.modelTitle(model),
                  this.characterName(model),
                  character?.faceImage
                    ? html`
                        <img src=${String(character.faceImage)} alt="" />
                      `
                    : nothing,
                )}
              </span>
            </button>
          `;
        })}
      </div>
    `;
  }
  private renderModelList(models: Value[]) {
    return html`
      <div class="model-list">
        <header>
          <span>${uiText(this.locale, "model")}</span>
          <span>${uiText(this.locale, "type")}</span>
          <span>${uiText(this.locale, "character")}</span>
          <span>${uiText(this.locale, "band")}</span>
        </header>
        ${models.map((model) => {
          const character = this.character(Number(model.characterId || 0));
          return html`
            <button class="model-list__row" @click=${() => this.select(this.key(model))}>
              <span class="model-list__primary">
                ${
                  this.preview(model)
                    ? html`
                        <img src=${this.preview(model)} alt="" loading="lazy" />
                      `
                    : nothing
                }
                <strong>${this.modelTitle(model)}</strong>
              </span>
              <span>${this.modelType(model)}</span>
              <span class="model-list__entity">
                ${
                  character?.faceImage
                    ? html`
                        <img src=${String(character.faceImage)} alt="" />
                      `
                    : nothing
                }${this.characterName(model)}
              </span>
              <span>${this.bandName(model) || "—"}</span>
            </button>
          `;
        })}
      </div>
    `;
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
      <aside class="viewer-detail">
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
            <dl class="detail-list">
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
