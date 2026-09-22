import { LitElement, html, nothing } from "lit";
import { SpineStage } from "./runtime/spine-stage";
import { catalogUrl, fetchJson, preferredLocale, uiText } from "./shared/catalog";
import { clearBrowseBar, filterGroup, renderBrowse } from "./ui/browse";
import { segmented } from "./ui/controls";
import { icon } from "./ui/icon";
import { tile } from "./ui/tile";
import { EXPANDED, matches, watchMedia } from "./ui/media";
import { LazyImages } from "./ui/lazy-images";
import { PaneFocus } from "./ui/pane";
import { errorState, loadingState } from "./ui/state";
type Value = Record<string, unknown>;

export class SpineWorkspace extends LitElement {
  static properties = {
    locale: { type: String },
    phase: { state: true },
    models: { state: true },
    selected: { state: true },
    detail: { state: true },
    error: { state: true },
    paused: { state: true },
    loop: { state: true },
    visible: { state: true },
    query: { state: true },
    view: { state: true },
    sort: { state: true },
    order: { state: true },
    filtersOpen: { state: true },
    familyFilter: { state: true },
    versionFilter: { state: true },
    docked: { state: true },
  };
  declare locale: string;
  declare phase: "loading" | "ready" | "error";
  declare models: Value[];
  declare selected: string;
  declare detail: Value | null;
  declare error: string;
  declare paused: boolean;
  declare loop: boolean;
  declare visible: number;
  declare query: string;
  declare view: "grid" | "list";
  declare sort: "id" | "source" | "family" | "version";
  declare order: "asc" | "desc";
  declare filtersOpen: boolean;
  declare docked: boolean;
  declare familyFilter: string;
  declare versionFilter: string;
  private stage?: SpineStage;
  private disposeMedia?: () => void;
  private paneFocus = new PaneFocus();
  private lazyImages = new LazyImages();
  private generation = 0;
  constructor() {
    super();
    this.locale = "ja";
    this.phase = "loading";
    this.models = [];
    this.selected = "";
    this.detail = null;
    this.error = "";
    this.paused = false;
    this.loop = true;
    this.visible = 80;
    this.query = "";
    this.view = "grid";
    this.sort = "id";
    this.order = "asc";
    this.filtersOpen = false;
    this.docked = matches(EXPANDED);
    this.familyFilter = "";
    this.versionFilter = "";
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
      import("@material/web/progress/circular-progress.js"),
    ]);
    window.setTimeout(() => {
      const params = new URLSearchParams(location.search);
      this.selected = params.get("model") || "";
      this.query = params.get("q") || "";
      this.view = params.get("view") === "list" ? "list" : "grid";
      this.sort = (
        ["id", "source", "family", "version"].includes(params.get("sort") || "") ? params.get("sort") : "id"
      ) as typeof this.sort;
      this.order = params.get("order") === "desc" ? "desc" : "asc";
      this.familyFilter = params.get("family") || "";
      this.versionFilter = params.get("version") || "";
      void this.loadCatalog();
    }, 0);
  }
  disconnectedCallback() {
    clearBrowseBar();
    this.lazyImages.disconnect();
    this.disposeMedia?.();
    this.paneFocus.detach();
    this.stage?.dispose();
    super.disconnectedCallback();
  }
  private url(id = "") {
    return catalogUrl("spine", id);
  }
  private async loadCatalog() {
    try {
      const data = await fetchJson<Value>(this.url());
      this.models = Object.values((data.models as Record<string, Value>) || {});
      this.phase = "ready";
      if (this.selected) void this.select(this.selected, false);
    } catch (error) {
      this.phase = "error";
      this.error = error instanceof Error ? error.message : String(error);
    }
  }
  private modelTitle(model: Value) {
    return (
      String(model.sourcePathKey || model.id || "Spine")
        .split("/")
        .at(-1)
        ?.replace(/_SkeletonData(?:\.asset)?$/i, "") || String(model.id)
    );
  }
  private familyName(value: unknown) {
    const family = String(value || "");
    if (family === "home-spot")
      return this.locale === "ja"
        ? "ホーム画面"
        : this.locale === "ko"
          ? "홈 화면"
          : this.locale === "en"
            ? "Home spot"
            : "首页看板";
    return family || "—";
  }
  private async select(id: string, updateUrl = true) {
    const generation = ++this.generation;
    this.selected = id;
    this.detail = null;
    this.error = "";
    this.stage?.dispose();
    if (updateUrl) {
      const params = new URLSearchParams(location.search);
      params.set("model", id);
      history.replaceState(history.state, "", `${location.pathname}?${params}`);
    }
    try {
      const detail = await fetchJson<Value>(this.url(id));
      if (generation !== this.generation) return;
      this.detail = detail;
      await this.updateComplete;
      const host = this.querySelector<HTMLElement>("[data-spine-stage]");
      if (!host) return;
      this.stage = new SpineStage(host);
      await this.stage.load(detail);
    } catch (error) {
      if (generation === this.generation) this.error = error instanceof Error ? error.message : String(error);
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
  private sync() {
    const params = new URLSearchParams();
    if (this.selected) params.set("model", this.selected);
    if (this.query) params.set("q", this.query);
    if (this.view !== "grid") params.set("view", this.view);
    if (this.sort !== "id") params.set("sort", this.sort);
    if (this.order !== "asc") params.set("order", this.order);
    if (this.familyFilter) params.set("family", this.familyFilter);
    if (this.versionFilter) params.set("version", this.versionFilter);
    history.replaceState(history.state, "", `${location.pathname}${params.size ? `?${params}` : ""}`);
  }
  private filteredModels() {
    const needle = this.query.trim().normalize("NFKC").toLowerCase();
    const direction = this.order === "asc" ? 1 : -1;
    return this.models
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
    // The model viewer is a modal pane: focus belongs inside it.
    this.paneFocus.sync(this.querySelector<HTMLElement>("[data-overlay-pane]"), () => this.closeDetail());
    // tile() defers its artwork as `data-src`; this is what promotes it.
    this.lazyImages.observe(this);
  }
  private closeDetail() {
    this.stage?.dispose();
    this.stage = undefined;
    this.selected = "";
    this.detail = null;
    this.sync();
  }
  private adjacentModel(offset: number) {
    const models = this.filteredModels();
    const index = models.findIndex((model) => String(model.id) === this.selected);
    const next = models[index + offset];
    if (next) void this.select(String(next.id));
  }
  private captureStage() {
    const canvas = this.querySelector<HTMLCanvasElement>(".viewer-detail__runtime canvas");
    canvas?.toBlob((blob) => {
      if (!blob) return;
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = `${this.selected || "spine"}.png`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 0);
    });
  }
  private renderCatalogWorkspace() {
    const models = this.filteredModels();
    if (this.selected) return this.renderModelDetail();
    const families = [...new Set(this.models.map((model) => String(model.family || "")).filter(Boolean))].sort((a, b) =>
      a.localeCompare(b, "en", { numeric: true }),
    );
    const versions = [...new Set(this.models.map((model) => String(model.spineVersion || "")).filter(Boolean))].sort(
      (a, b) => a.localeCompare(b, "en", { numeric: true }),
    );
    return html`
      ${renderBrowse({
        kind: "model",
        count: { value: models.length, label: "" },
        controls: segmented({
          label: uiText(this.locale, "view"),
          value: this.view,
          options: [
            { value: "grid" as const, label: uiText(this.locale, "grid"), icon: "grid_view" },
            { value: "list" as const, label: uiText(this.locale, "list"), icon: "view_list" },
          ],
          onSelect: (view) => {
            this.view = view;
            this.sync();
          },
          iconOnly: true,
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
                ? html`
                    <div class="collection collection--model">${models.map((model) => this.renderModelCard(model))}</div>
                  `
                : this.renderModelList(models),
        filters: {
          label: uiText(this.locale, "filter"),
          open: this.filtersOpen,
          count: Number(Boolean(this.query)) + Number(Boolean(this.familyFilter)) + Number(Boolean(this.versionFilter)),
          closeLabel: uiText(this.locale, "close"),
          resetLabel: uiText(this.locale, "reset"),
          onOpen: () => (this.filtersOpen = true),
          onClose: () => (this.filtersOpen = false),
          onReset: () => {
            this.query = "";
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
    return html`
      <fieldset class="browse__filter-group">
        <legend>${label}</legend>
        <div class="chip-set">
          ${values.map(
            (value) => html`
              <button
                class="chip"
                aria-pressed=${selected === value}
                @click=${() => {
                  update(selected === value ? "" : value);
                  this.sync();
                }}
              >
                ${value}
              </button>
            `,
          )}
        </div>
      </fieldset>
    `;
  }
  private preview(model: Value) {
    return String((model.preview as Value | undefined)?.url || "");
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
  private renderModelList(models: Value[]) {
    return html`
      <div class="table-scroll" role="region" tabindex="0" aria-label=${uiText(this.locale, "list")} data-scroll-region>
        <div class="model-list spine-model-list">
          <header>
            <span>${uiText(this.locale, "model")}</span>
            <span>${uiText(this.locale, "family")}</span>
            <span>${uiText(this.locale, "version")}</span>
            <span>${uiText(this.locale, "animations")}</span>
          </header>
          ${models.map(
            (model) => html`
              <button class="model-list__row" @click=${() => this.select(String(model.id))}>
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
                <span>${this.familyName(model.family)}</span>
                <span>${String(model.spineVersion || "—")}</span>
                <span>
                  ${Number(model.animationCount || (Array.isArray(model.animations) ? model.animations.length : 0))}
                </span>
              </button>
            `,
          )}
        </div>
      </div>
    `;
  }
  private renderModelDetail() {
    const detail = this.detail;
    const animations = Array.isArray(detail?.animations) ? detail.animations : [];
    const animationName = (animation: unknown) =>
      typeof animation === "string" ? animation : String((animation as Value | undefined)?.name || "");
    const models = this.filteredModels();
    const modelIndex = models.findIndex((model) => String(model.id) === this.selected);
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
          <span>
            <strong>${detail ? this.modelTitle(detail) : this.selected}</strong>
            <small>${this.familyName(detail?.family || detail?.spineVersion || "Spine")}</small>
          </span>
          <nav class="viewer-detail__navigation" aria-label="Spine">
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
            <div data-spine-stage class="spine-stage"></div>
            ${
              !detail && !this.error
                ? html`
                    <div class="viewer-state"><md-circular-progress indeterminate></md-circular-progress></div>
                  `
                : nothing
            }${
              this.error
                ? html`
                    <div class="viewer-state">${this.error}</div>
                  `
                : nothing
            }${
              detail
                ? html`
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
                        @click=${() => this.stage?.replay()}
                        aria-label=${uiText(this.locale, "replay")}
                      >
                        <svg class="material-icon" width="22" height="22"><use href="/icons.svg#replay"></use></svg>
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
                      <button class="chip runtime-chip" aria-pressed=${this.loop} @click=${this.toggleLoop}>
                        ${uiText(this.locale, "loop")}
                      </button>
                    </div>
                  `
                : nothing
            }
          </div>
          <aside class="viewer-detail__info">
            <h2>${detail ? this.modelTitle(detail) : "Spine"}</h2>
            <dl class="spec-list">
              <div>
                <dt>${uiText(this.locale, "family")}</dt>
                <dd>${this.familyName(detail?.family)}</dd>
              </div>
              <div>
                <dt>${uiText(this.locale, "version")}</dt>
                <dd>${String(detail?.spineVersion || "—")}</dd>
              </div>
              <div>
                <dt>${uiText(this.locale, "animations")}</dt>
                <dd>${Number(detail?.animationCount || animations.length)}</dd>
              </div>
            </dl>
            ${
              animations.length
                ? html`
                    <section>
                      <h3>${uiText(this.locale, "animations")}</h3>
                      <md-outlined-select
                        class="viewer-inspector-select"
                        label=${uiText(this.locale, "animations")}
                        @change=${(event: Event) =>
                          this.stage?.play(
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
