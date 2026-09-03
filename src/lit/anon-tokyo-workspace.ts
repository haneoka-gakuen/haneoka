import { LitElement, html, nothing } from "lit";
import { catalogUrl, localizedText, preferredLocale, readPath, recordValues, uiText } from "./shared/catalog";
import { renderGridIdentity } from "./shared/grid-identity";
import { OutfitStage } from "./runtime/outfit-stage";
type Value = Record<string, unknown>;
const read = readPath;
const values = recordValues;

export class AnonTokyoWorkspace extends LitElement {
  static properties = {
    locale: { type: String },
    mode: { type: String },
    phase: { state: true },
    document: { state: true },
    selectedCharacter: { state: true },
    tab: { state: true },
    selectedItem: { state: true },
    query: { state: true },
    visible: { state: true },
    filtersOpen: { state: true },
    facet: { state: true },
    outfitSelections: { state: true },
    error: { state: true },
  };
  declare locale: string;
  declare mode: string;
  declare phase: "loading" | "ready" | "error";
  declare document: Value | null;
  declare selectedCharacter: string;
  declare tab: number;
  declare selectedItem: string;
  declare query: string;
  declare visible: number;
  declare filtersOpen: boolean;
  declare facet: string;
  declare outfitSelections: Record<number, string>;
  declare error: string;
  private bands: Value[] = [];
  private outfitStage?: OutfitStage;
  private outfitRecipeKey = "";
  private outfitStageCharacter = "";
  constructor() {
    super();
    this.locale = "ja";
    this.mode = "characters";
    this.phase = "loading";
    this.document = null;
    this.selectedCharacter = "";
    this.tab = 1;
    this.selectedItem = "";
    this.query = "";
    this.visible = 80;
    this.filtersOpen = false;
    this.facet = "";
    this.outfitSelections = {};
    this.error = "";
  }
  createRenderRoot() {
    return this;
  }
  connectedCallback() {
    super.connectedCallback();
    this.locale = preferredLocale(this.locale);
    void import("@material/web/progress/circular-progress.js");
    document.querySelector(".top-app-bar")?.classList.add("has-catalog-actions");
    const params = new URLSearchParams(location.search);
    this.selectedCharacter = params.get("character") || "";
    this.selectedItem = params.get("item") || "";
    this.facet = params.get("filter") || "";
    void this.load();
  }
  disconnectedCallback() {
    document.querySelector(".top-app-bar")?.classList.remove("has-catalog-actions");
    this.outfitStage?.dispose();
    super.disconnectedCallback();
  }
  updated() {
    if (this.mode !== "outfits" || this.phase !== "ready") return;
    const host = this.querySelector<HTMLElement>("[data-outfit-runtime]");
    const recipe = this.outfitRecipe();
    const key = String(recipe?.id || "");
    if (!host || !recipe || !key || (this.outfitRecipeKey === key && this.outfitStage)) return;
    const characterKey = String(recipe.characterId || this.selectedCharacter || "");
    if (!this.outfitStage || this.outfitStageCharacter !== characterKey) {
      this.outfitStage?.dispose();
      this.outfitStage = new OutfitStage(host, this.server());
      this.outfitStageCharacter = characterKey;
    }
    this.outfitRecipeKey = key;
    host.classList.remove("ready", "failed");
    void this.outfitStage
      .load(
        Array.isArray(recipe.parts) ? (recipe.parts as Array<{ modelId?: string; order?: number }>) : [],
        String((recipe.animation as Value | undefined)?.name || "f_idle"),
        Number(recipe.scale || 1),
      )
      .then(() => host.classList.add("ready"))
      .catch(() => host.classList.add("failed"));
  }
  private server() {
    try {
      return localStorage.getItem("haneoka.release-server") || "gl-cbt";
    } catch {
      return "gl-cbt";
    }
  }
  private async load() {
    try {
      const base = catalogUrl("anon-tokyo", "", this.server());
      const requestedByMode: Record<string, string[]> = {
        outfits: ["characters", "reloading", "render-recipes", "spine-parts"],
        shop: ["shop", "player-levels"],
        goods: ["goods", "goods-categories", "currencies"],
        staff: ["staff", "staff-helpers", "staff-deliveries", "staff-deliverymen"],
        tasks: ["tasks", "task-tabs", "task-types", "task-daily", "task-achievements", "task-chapter"],
        guide: ["guide", "guide-images"],
        fever: ["fever", "fever-stages", "fever-bgm"],
      };
      const requested = requestedByMode[this.mode] || [this.mode];
      try {
        const manifestResponse = await fetch(catalogUrl("catalog", "", this.server()));
        const manifest = manifestResponse.ok ? ((await manifestResponse.json()) as Value) : {};
        const availableViews = read(manifest, "resources.anon-tokyo.views") as Value | undefined;
        if (!availableViews || requested.some((view) => !availableViews[view])) throw new Error("views unavailable");
        const responses = await Promise.all(requested.map((view) => fetch(`${base}/views/${view}`)));
        if (responses.some((response) => !response.ok)) throw new Error("views unavailable");
        const payloads = await Promise.all(responses.map((response) => response.json() as Promise<Value>));
        const byName = Object.fromEntries(requested.map((name, index) => [name, payloads[index]]));
        this.document = {
          characters: byName.characters,
          goods: { reloading: byName.reloading, items: byName.goods, categories: byName["goods-categories"] },
          progression: { playerLevels: byName["player-levels"], currencies: byName.currencies },
          spine: { renderRecipes: byName["render-recipes"], parts: byName["spine-parts"] },
          shop: { stores: byName.shop, decorations: byName.decorations },
          staffing: {
            clerks: byName.staff,
            helpers: byName["staff-helpers"],
            deliveries: byName["staff-deliveries"],
            deliverymen: byName["staff-deliverymen"],
            customers: byName.customers,
          },
          tasks: {
            main: byName.tasks,
            tabs: byName["task-tabs"],
            types: byName["task-types"],
            daily: byName["task-daily"],
            achievements: byName["task-achievements"],
            chapter: byName["task-chapter"],
          },
          guides: { steps: byName.guide, imagePages: byName["guide-images"] },
          stages: { music: byName.fever, stages: byName["fever-stages"], bgm: byName["fever-bgm"] },
        };
      } catch {
        // Older releases remain browsable until their view projections are
        // rebuilt; new releases use the much smaller screen-specific views.
        const response = await fetch(base);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        this.document = (await response.json()) as Value;
      }
      this.phase = "ready";
      if (this.mode === "outfits" && this.selectedItem) {
        const selected = values(read(this.document, "goods.reloading")).find((item) => item.id === this.selectedItem);
        if (selected) this.outfitSelections = { [Number(selected.spineType || 1)]: this.selectedItem };
      }
      if (this.mode === "fever") {
        const response = await fetch(catalogUrl("bands"));
        if (response.ok) this.bands = values(await response.json());
      }
      const first = values(this.document.characters)[0];
      if (!this.selectedCharacter && first) this.selectedCharacter = String(first.id || "");
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
      this.phase = "error";
    }
  }
  private text(value: unknown): string {
    return localizedText(value, this.locale);
  }
  private media(item: Value): string {
    for (const key of ["image", "icon", "avatar", "preview", "thumbnail"]) {
      const value = item[key];
      if (typeof value === "string") return value;
      if (value && typeof value === "object" && (value as Value).url) return String((value as Value).url);
    }
    return "";
  }
  private entityTitle(item: Value) {
    return (
      this.text(item.name) ||
      this.text(item.displayName) ||
      this.text(item.title) ||
      String(item.label || item.displayLabel || item.cueName || uiText(this.locale, "unavailable"))
    );
  }
  private selectCharacter(id: string) {
    this.selectedCharacter = id;
    this.selectedItem = "";
    this.outfitSelections = {};
    const params = new URLSearchParams(location.search);
    params.set("character", id);
    params.delete("item");
    history.replaceState(history.state, "", `${location.pathname}?${params}`);
  }
  private collection(): Value[] {
    if (this.mode === "staff")
      return [
        ...values(read(this.document, "staffing.clerks")).map((item) => ({ ...item, entityKind: "clerk" })),
        ...values(read(this.document, "staffing.helpers")).map((item) => ({ ...item, entityKind: "helper" })),
        ...values(read(this.document, "staffing.deliveries")).map((item) => ({ ...item, entityKind: "delivery" })),
        ...values(read(this.document, "staffing.deliverymen")).map((item) => ({ ...item, entityKind: "deliveryman" })),
      ].sort((left, right) =>
        String((left as Value).id || (left as Value).rawId || "").localeCompare(
          String((right as Value).id || (right as Value).rawId || ""),
          "en",
          {
            numeric: true,
          },
        ),
      );
    if (this.mode === "fever")
      return [
        ...values(read(this.document, "stages.music")).map((item) => ({ ...item, entityKind: "music" })),
        ...values(read(this.document, "stages.stages")).map((item) => ({ ...item, entityKind: "stage" })),
        ...values(read(this.document, "stages.bgm")).map((item) => ({ ...item, entityKind: "bgm" })),
      ].sort((left, right) =>
        String((left as Value).id || (left as Value).rawId || "").localeCompare(
          String((right as Value).id || (right as Value).rawId || ""),
          "en",
          {
            numeric: true,
          },
        ),
      );
    const paths: Record<string, string> = {
      characters: "characters",
      shop: "shop.stores",
      goods: "goods.items",
      decorations: "shop.decorations",
      staff: "staffing.clerks",
      customers: "staffing.customers",
      tasks: "tasks.main",
      guide: "guides.steps",
      fever: "stages.music",
    };
    return values(read(this.document, paths[this.mode] || this.mode)).sort((left, right) => {
      const order = Number(left.displayOrder ?? left.order ?? left.rawId);
      const other = Number(right.displayOrder ?? right.order ?? right.rawId);
      if (Number.isFinite(order) && Number.isFinite(other) && order !== other) return order - other;
      return String(left.id || left.rawId || "").localeCompare(String(right.id || right.rawId || ""), "en", {
        numeric: true,
        sensitivity: "base",
      });
    });
  }
  render() {
    if (this.phase === "loading")
      return html`
        <div class="catalog-state"><md-circular-progress indeterminate></md-circular-progress></div>
      `;
    if (this.phase === "error" || !this.document)
      return html`
        <div class="notice">
          <p>${this.error || uiText(this.locale, "unavailable")}</p>
          <button class="button button--tonal" @click=${this.load}>${uiText(this.locale, "retry")}</button>
        </div>
      `;
    return this.mode === "outfits" ? this.renderOutfits() : this.renderCollection();
  }
  private renderCollection() {
    if (this.mode === "shop") return this.renderShop();
    if (this.mode === "tasks") return this.renderTasks();
    if (this.mode === "guide") return this.renderGuide();
    const source = this.collection();
    const facetKey: Record<string, string> = {
      characters: "levelLimit",
      goods: "categoryId",
      decorations: "type",
      staff: "point",
      customers: "customerKind",
      fever: "bandId",
    };
    const key = facetKey[this.mode] || "";
    const facets = key ? [...new Set(source.map((item) => String(item[key] ?? "")).filter(Boolean))] : [];
    const list = source.filter((item) => !this.facet || String(item[key] ?? "") === this.facet);
    return html`
      <section class=${`page anon-collection anon-collection--${this.mode}`}>
        <div class="catalog__toolbar">
          ${
            facets.length
              ? html`
                  <button
                    class="icon-button"
                    aria-label=${uiText(this.locale, "filter")}
                    @click=${() => (this.filtersOpen = !this.filtersOpen)}
                  >
                    <svg class="material-icon" width="24" height="24"><use href="/icons.svg#filter_list"></use></svg>
                  </button>
                `
              : nothing
          }
          <span class="catalog__count">${list.length}</span>
        </div>
        <div class="anon-grid">${list.slice(0, this.visible).map((item) => this.renderCollectionItem(item))}</div>
        ${
          list.length > this.visible
            ? html`
                <div class="load-more">
                  <button class="button button--tonal" @click=${() => (this.visible += 80)}>
                    ${uiText(this.locale, "loadMore")}
                  </button>
                </div>
              `
            : nothing
        }
        ${this.filtersOpen ? this.renderFacetFilter(key, facets) : nothing}
      </section>
    `;
  }
  private renderFacetFilter(key: string, facets: string[]) {
    return html`
      <button class="sheet-scrim" @click=${() => (this.filtersOpen = false)}></button>
      <aside class="catalog__filters open">
        <div class="catalog__filter-header">
          <h2>${uiText(this.locale, "filter")}</h2>
          <button class="icon-button" @click=${() => (this.filtersOpen = false)}>
            <svg class="material-icon" width="22" height="22"><use href="/icons.svg#close"></use></svg>
          </button>
        </div>
        <div class="catalog__filter-stack">
          <span>${key}</span>
          <div class="catalog__chips">
            <button class="chip" aria-pressed=${!this.facet} @click=${() => this.setFacet("")}>
              ${uiText(this.locale, "all")}
            </button>
            ${facets.map(
              (value) => html`
                <button class="chip" aria-pressed=${this.facet === value} @click=${() => this.setFacet(value)}>
                  ${this.facetLabel(key, value)}
                </button>
              `,
            )}
          </div>
        </div>
      </aside>
    `;
  }
  private setFacet(value: string) {
    this.facet = value;
    const params = new URLSearchParams(location.search);
    value ? params.set("filter", value) : params.delete("filter");
    history.replaceState(history.state, "", `${location.pathname}${params.size ? `?${params}` : ""}`);
  }
  private currencyName(id: number) {
    const currency = values(read(this.document, "progression.currencies")).find((item) => Number(item.rawId) === id);
    return this.text(currency?.name) || uiText(this.locale, "currency");
  }
  private anonBandName(id: number) {
    return this.text(this.bands.find((band) => Number(band.bandId) === id)?.bandName) || "";
  }
  private facetLabel(key: string, value: string) {
    if (key === "categoryId") {
      const category = values(read(this.document, "goods.categories")).find((item) => String(item.rawId) === value);
      return this.text(category?.name) || this.text(category?.title) || uiText(this.locale, "category");
    }
    if (key === "bandId") return this.anonBandName(Number(value)) || uiText(this.locale, "band");
    if (key === "levelLimit") return `Lv.${value}`;
    if (key === "point") return `${value} pt`;
    return value;
  }
  private rewardText(value: unknown) {
    const source = value && typeof value === "object" ? String((value as Value).raw || "") : String(value || "");
    return source
      .split(";")
      .flatMap((entry) => {
        const [type, id, count] = entry.split(",").map(Number);
        if (!count) return [];
        return [`${type === 1 ? this.currencyName(id || 0) : uiText(this.locale, "reward")} ×${count}`];
      })
      .join("、");
  }
  private taskParameter(kind: string, value: unknown) {
    const id = Number(value || 0);
    if (kind === "goodsid") {
      const item = values(read(this.document, "goods.items")).find((entry) => Number(entry.rawId) === id);
      return this.entityTitle(item || {});
    }
    if (kind === "tagid") {
      const item = values(read(this.document, "goods.tags")).find((entry) => Number(entry.rawId) === id);
      return this.entityTitle(item || {});
    }
    if (kind === "goodstypeid") {
      const item = values(read(this.document, "goods.categories")).find((entry) => Number(entry.rawId) === id);
      return this.entityTitle(item || {});
    }
    if (kind === "decorationid") {
      const item = values(read(this.document, "shop.decorations")).find((entry) => Number(entry.rawId) === id);
      return this.entityTitle(item || {});
    }
    return String(value ?? "");
  }
  private taskTitle(entry: Value) {
    const type = values(read(this.document, "tasks.types")).find(
      (candidate) => Number(candidate.rawId) === Number(entry.taskTypeId),
    );
    const template = this.text(type?.description);
    const parameters = Array.isArray(entry.parameters) ? entry.parameters : [];
    const kinds = Array.isArray(type?.parameters) ? (type.parameters as string[]) : [];
    const offset = kinds[0] ? 0 : 1;
    return (
      this.text(entry.title) ||
      this.text(entry.description) ||
      (template
        ? template.replace(/\{(\d+)\}/gu, (_, index: string) =>
            this.taskParameter(kinds[Number(index) + offset] || "", parameters[Number(index) + offset]),
          )
        : uiText(this.locale, "task"))
    );
  }
  private renderShop() {
    const playerLevels = values(read(this.document, "progression.playerLevels"));
    const stores = values(read(this.document, "shop.stores"));
    return html`
      <section class="page anon-board">
        <section>
          <header>
            <svg class="material-icon" width="22" height="22"><use href="/icons.svg#trending_up"></use></svg>
            <h2>${uiText(this.locale, "playerLevels")}</h2>
          </header>
          <div class="anon-data-table">
            ${playerLevels.map(
              (entry) => html`
                <div>
                  <strong>Lv.${entry.level}</strong>
                  <span>EXP ${Number(entry.exp || 0).toLocaleString()}</span>
                  <span>${entry.customerCount || 0} ${uiText(this.locale, "customers")}</span>
                  <span>${this.rewardText(entry.reward)}</span>
                </div>
              `,
            )}
          </div>
        </section>
        <section>
          <header>
            <svg class="material-icon" width="22" height="22"><use href="/icons.svg#storefront"></use></svg>
            <h2>${uiText(this.locale, "expansion")}</h2>
          </header>
          <div class="anon-data-table">
            ${stores.map(
              (entry) => html`
                <div>
                  <strong>Lv.${entry.level || entry.rawId}</strong>
                  <span>${(entry.size as unknown[] | undefined)?.join(" × ") || "—"}</span>
                  <span>${entry.customerCount || 0} ${uiText(this.locale, "customers")}</span>
                  <span>
                    ${Number((entry.popularity as Value | undefined)?.shopRequirement || 0).toLocaleString()}
                    ${uiText(this.locale, "popularity")}
                  </span>
                </div>
              `,
            )}
          </div>
        </section>
      </section>
    `;
  }
  private renderTasks() {
    const main = values(read(this.document, "tasks.main"));
    const tabs = values(read(this.document, "tasks.tabs"));
    const groups = new Map<string, Value[]>();
    for (const entry of main) {
      const key = String(entry.taskTabId || entry.tabId || "");
      groups.set(key, [...(groups.get(key) || []), entry]);
    }
    const extra = [
      [uiText(this.locale, "daily"), values(read(this.document, "tasks.daily"))],
      [
        uiText(this.locale, "achievements"),
        [
          ...values(read(this.document, "tasks.achievementTasks")),
          ...values(read(this.document, "tasks.achievements")),
        ],
      ],
      [uiText(this.locale, "chapter"), values(read(this.document, "tasks.chapter"))],
    ] as const;
    const sections = [
      ...[...groups].map(([key, entries]) => ({
        title: this.text(tabs.find((tab) => String(tab.rawId) === key)?.name) || uiText(this.locale, "tasks"),
        entries,
      })),
      ...extra.filter(([, entries]) => entries.length).map(([title, entries]) => ({ title, entries })),
    ];
    return html`
      <section class="page anon-task-stack">
        ${sections.map(
          (section) => html`
            <section class="anon-task-group">
              <header>
                <svg class="material-icon" width="20" height="20"><use href="/icons.svg#fact_check"></use></svg>
                <h2>${section.title}</h2>
                <span>${section.entries.length}</span>
              </header>
              <div>
                ${section.entries.map(
                  (entry) => html`
                    <details>
                      <summary>
                        <span>${this.taskTitle(entry) || this.text(entry.name)}</span>
                        ${
                          this.rewardText(entry.reward)
                            ? html`
                                <small>${this.rewardText(entry.reward)}</small>
                              `
                            : nothing
                        }
                        <svg class="material-icon" width="20" height="20">
                          <use href="/icons.svg#expand_more"></use>
                        </svg>
                      </summary>
                      <p>${this.text(entry.description) || this.text(entry.chapterName) || ""}</p>
                    </details>
                  `,
                )}
              </div>
            </section>
          `,
        )}
      </section>
    `;
  }
  private renderGuide() {
    const groups = new Map<string, Value[]>();
    for (const entry of values(read(this.document, "guides.steps"))) {
      const key = String(entry.page || uiText(this.locale, "guide"));
      groups.set(key, [...(groups.get(key) || []), entry]);
    }
    return html`
      <section class="page anon-task-stack">
        ${[...groups].map(
          ([page, entries]) => html`
            <section class="anon-task-group">
              <header>
                <svg class="material-icon" width="20" height="20"><use href="/icons.svg#menu_book"></use></svg>
                <h2>${page}</h2>
                <span>${entries.length}</span>
              </header>
              <div>
                ${entries.map(
                  (entry) => html`
                    <details>
                      <summary>
                        <span>
                          ${this.text(entry.title) || this.text(entry.text) || uiText(this.locale, "guideStep")}
                        </span>
                        <svg class="material-icon" width="20" height="20">
                          <use href="/icons.svg#expand_more"></use>
                        </svg>
                      </summary>
                      <p>${this.text(entry.hint) || this.text(entry.text) || ""}</p>
                    </details>
                  `,
                )}
              </div>
            </section>
          `,
        )}
        ${
          values(read(this.document, "guides.imagePages")).length
            ? html`
                <section class="anon-guide-images">
                  ${values(read(this.document, "guides.imagePages")).map((entry) =>
                    this.media(entry)
                      ? html`
                          <img src=${this.media(entry)} alt=${this.entityTitle(entry)} loading="lazy" />
                        `
                      : nothing,
                  )}
                </section>
              `
            : nothing
        }
      </section>
    `;
  }
  private renderCollectionItem(item: Value) {
    const source = this.media(item);
    const icon: Record<string, string> = {
      characters: "person",
      shop: "storefront",
      goods: "shopping_bag",
      decorations: "chair",
      staff: "badge",
      customers: "groups",
      tasks: "task_alt",
      guide: "signpost",
      fever: "music_note",
    };
    const meta = (() => {
      if (this.mode === "characters") return `Lv.${item.levelLimit || 0}`;
      if (this.mode === "shop")
        return `${(item.size as unknown[] | undefined)?.join(" × ") || "—"} / ${item.customerCount || 0} ${uiText(this.locale, "customers")}`;
      if (this.mode === "goods")
        return `${item.buyItemCount || (item.purchase as Value | undefined)?.count || 0} × ${item.buyItemCost || (item.purchase as Value | undefined)?.cost || 0}`;
      if (this.mode === "decorations")
        return `${(item.size as unknown[] | undefined)?.join(" × ") || "—"} / +${Number((item.popularity as Value | undefined)?.count || 0)} ${uiText(this.locale, "popularity")}`;
      if (this.mode === "staff") return `${item.entityKind || ""} / ${item.point || 0} pt`;
      if (this.mode === "customers")
        return `${item.customerKind || uiText(this.locale, "guest")} / ${uiText(this.locale, "weight")} ${item.baseSpawnWeight || 0}`;
      if (this.mode === "fever")
        return `${item.entityKind || ""} / ${item.durationSeconds || 0}s / ${this.anonBandName(Number(item.bandId || 0))}`;
      return "";
    })();
    const description = this.text(item.description) || this.text(item.text) || "";
    return html`
      <article class="anon-card surface content-grid-tile">
        <span class=${`anon-card__media ${source ? "media-loading" : ""}`}>
          ${
            source
              ? html`
                  <img
                    src=${source}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    @load=${(event: Event) => (event.currentTarget as HTMLImageElement).classList.add("is-loaded")}
                    @error=${(event: Event) => (event.currentTarget as HTMLImageElement).classList.add("is-error")}
                  />
                `
              : html`
                  <span class="workspace-card__icon">
                    <svg class="material-icon" width="24" height="24">
                      <use href=${`/icons.svg#${icon[this.mode] || "storefront"}`}></use>
                    </svg>
                  </span>
                `
          }
        </span>
        <div class="anon-card__copy">
          ${
            this.mode === "tasks" || this.mode === "guide"
              ? html`
                  <strong>${this.entityTitle(item)}</strong>
                  ${
                    description
                      ? html`
                          <p>${description}</p>
                        `
                      : nothing
                  }
                  <small>${meta}</small>
                `
              : renderGridIdentity(this.entityTitle(item), description || meta)
          }
        </div>
        ${
          this.mode === "fever" && item.entityKind === "bgm" && (item.playableUrl || item.url)
            ? html`
                <audio src=${String(item.playableUrl || item.url)} controls preload="metadata"></audio>
              `
            : nothing
        }
      </article>
    `;
  }
  private renderOutfits() {
    const characters = values(this.document?.characters);
    const character = characters.find((item) => item.id === this.selectedCharacter) || characters[0];
    const rawId = Number(character?.rawId);
    const wearables = values(read(this.document, "goods.reloading")).filter(
      (item) =>
        item.isShow !== false &&
        (!Array.isArray(item.characterIds) ||
          !(item.characterIds as unknown[]).length ||
          (item.characterIds as unknown[]).map(Number).includes(rawId)) &&
        Number(item.spineType) === this.tab,
    );
    const selectedId = this.outfitSelections[this.tab] || "";
    const recipe = this.outfitRecipe();
    const preview = recipe?.preview as Value | undefined;
    const labels = ["", "headwear", "top", "bottom", "shoes", "set"];
    return html`
      <section class="outfit-workspace">
        <aside class="outfit-characters">
          ${characters.map(
            (item) => html`
              <button
                class=${`${this.media(item) ? "media-loading" : ""} ${item.id === character?.id ? "selected" : ""}`}
                @click=${() => this.selectCharacter(String(item.id))}
              >
                <img
                  src=${this.media(item)}
                  alt=${this.entityTitle(item)}
                  loading="lazy"
                  decoding="async"
                  @load=${(event: Event) => (event.currentTarget as HTMLImageElement).classList.add("is-loaded")}
                  @error=${(event: Event) => (event.currentTarget as HTMLImageElement).classList.add("is-error")}
                />
              </button>
            `,
          )}
        </aside>
        <div class=${`outfit-stage ${preview?.url ? "media-loading" : ""}`}>
          ${
            preview?.url
              ? html`
                  <img
                    src=${String(preview.url)}
                    alt=${this.entityTitle(character || {})}
                    decoding="async"
                    @load=${(event: Event) => (event.currentTarget as HTMLImageElement).classList.add("is-loaded")}
                    @error=${(event: Event) => (event.currentTarget as HTMLImageElement).classList.add("is-error")}
                  />
                `
              : html`
                  <div class="viewer-state"><span>${uiText(this.locale, "previewUnavailable")}</span></div>
                `
          }
          <div class="outfit-stage__runtime" data-outfit-runtime>
            <md-circular-progress indeterminate></md-circular-progress>
          </div>
        </div>
        <aside class="outfit-closet">
          <div class="outfit-tabs segmented" aria-label=${uiText(this.locale, "outfitParts")}>
            ${[1, 2, 3, 4, 5].map(
              (kind) => html`
                <button
                  aria-pressed=${this.tab === kind}
                  @click=${() => {
                    this.tab = kind;
                    this.selectedItem = "";
                  }}
                >
                  ${uiText(this.locale, labels[kind] || "set")}
                </button>
              `,
            )}
          </div>
          <div class="outfit-items">
            ${wearables.map(
              (item) => html`
                <button
                  class=${`outfit-item ${this.media(item) ? "media-loading" : ""} ${item.id === selectedId ? "selected" : ""}`}
                  @click=${() => {
                    const value = item.id === selectedId ? "" : String(item.id);
                    const next = { ...this.outfitSelections, [this.tab]: value };
                    if (value && this.tab === 5) {
                      next[2] = "";
                      next[3] = "";
                      next[4] = "";
                    } else if (value && [2, 3, 4].includes(this.tab)) next[5] = "";
                    this.outfitSelections = next;
                    this.selectedItem = value;
                  }}
                >
                  ${
                    this.media(item)
                      ? html`
                          <img
                            src=${this.media(item)}
                            alt=""
                            loading="lazy"
                            decoding="async"
                            @load=${(event: Event) => (event.currentTarget as HTMLImageElement).classList.add("is-loaded")}
                            @error=${(event: Event) => (event.currentTarget as HTMLImageElement).classList.add("is-error")}
                          />
                        `
                      : nothing
                  }
                  <span>${this.entityTitle(item)}</span>
                </button>
              `,
            )}
          </div>
        </aside>
      </section>
    `;
  }
  private outfitRecipe(): Value | undefined {
    const characters = values(this.document?.characters);
    const character = characters.find((item) => item.id === this.selectedCharacter) || characters[0];
    const rawId = Number(character?.rawId);
    const recipes = values(read(this.document, "spine.renderRecipes"));
    const base = recipes.find((item) => Number(item.characterId) === rawId && !Array.isArray(item.outfitReloadingIds));
    if (!base) return undefined;
    const selectedIds = Object.values(this.outfitSelections).filter(Boolean);
    const reloading = values(read(this.document, "goods.reloading"));
    const parts = values(read(this.document, "spine.parts"));
    const slotGroup = (modelId: unknown) => {
      const id = String(modelId || "");
      const slot = id.includes("_") ? id.slice(id.indexOf("_") + 1) : id;
      return slot.replace(/_\d+$/u, "");
    };
    const ownParts = (entry: Value) =>
      [
        ...(Array.isArray(entry.spineParent) ? entry.spineParent : []),
        ...(Array.isArray(entry.spineSpecialPartIds) ? entry.spineSpecialPartIds : []),
      ].flatMap((partId) => {
        const part = parts.find((candidate) => Number(candidate.rawId) === Number(partId));
        const stem =
          String(part?.pathName || "")
            .split("/")
            .pop()
            ?.replace(/_skeletondata(?:\.asset)?$/iu, "") || "";
        return part && stem ? [{ modelId: stem, order: Number(part.order || 0) }] : [];
      });
    let result = (Array.isArray(base.parts) ? (base.parts as Value[]) : []).map((part) => ({ ...part }));
    for (const selectedId of selectedIds) {
      const selected = reloading.find((item) => item.id === selectedId);
      if (!selected) continue;
      const own = ownParts(selected);
      const type = Number(selected.spineType || 0);
      const groups =
        type === 5
          ? new Set(["body", "waist"])
          : type === 2
            ? new Set(["body"])
            : type === 3
              ? new Set(["waist"])
              : type === 4
                ? new Set(["foot"])
                : new Set(own.map((part) => slotGroup(part.modelId)));
      result = result.filter((part) => !groups.has(slotGroup(part.modelId)));
      result.push(...own);
    }
    return {
      ...base,
      id: `${base.id || "outfit"}:${selectedIds.sort().join(",")}`,
      parts: result.sort((left, right) => Number(left.order) - Number(right.order)),
    };
  }
}
customElements.define("anon-tokyo-workspace", AnonTokyoWorkspace);
