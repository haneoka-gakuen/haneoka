import { renderAnonTokyoDetails } from "./shared/anon-tokyo-detail";
import { LitElement, html, nothing } from "lit";
import { facet as renderFacet } from "./ui/facet";
import { clearBrowseBar, renderBrowse } from "./ui/browse";
import { inputChip, segmented } from "./ui/controls";
import { collectionView, viewSwitch, collectionList, collectionTable, type CollectionView } from "./ui/collection-view";
import { tile } from "./ui/tile";
import { LazyImages, nextImageCandidate } from "./ui/lazy-images";
import { PaneFocus, renderPane } from "./ui/pane";
import { detailLayout } from "./ui/detail-layout";
import "./ui/image-gallery";
import { icon } from "./ui/icon";
import { emptyState, errorState, loadingState, noticeState } from "./ui/state";
import {
  catalogUrl,
  currentReleaseServer,
  formatList,
  localizedText,
  preferredLocale,
  readPath,
  recordValues,
  uiText,
} from "./shared/catalog";
import { resolveLocalizedText } from "../lib/localized-text";
import { openDetailLocation, closeDetailLocation, observeDetailLocation } from "../lib/detail-navigation";
import { writeReleaseServer } from "../lib/release-server";
import { OutfitStage } from "./runtime/outfit-stage";
type Value = Record<string, unknown>;
const read = readPath;
const values = recordValues;
const referenceDocuments = new Map<string, Promise<Value>>();
const MODE_GROUPS: Record<string, readonly (readonly [string, string])[]> = {
  characters: [["characters", "characters"]],
  shop: [
    ["shop.stores", "storeLevels"],
    ["progression.playerLevels", "playerLevels"],
  ],
  goods: [["goods.items", "goods"]],
  decorations: [["shop.decorations", "decorations"]],
  staff: [
    ["staffing.clerks", "clerks"],
    ["staffing.helpers", "helpers"],
    ["staffing.deliveries", "deliveries"],
    ["staffing.deliverymen", "deliveries"],
  ],
  customers: [["staffing.customers", "customers"]],
  tasks: [
    ["tasks.main", "mainTasks"],
    ["tasks.daily", "dailyTasks"],
    ["tasks.achievementTasks", "achievements"],
    ["tasks.achievements", "achievements"],
    ["tasks.chapter", "chapter"],
  ],
  guide: [
    ["guides.steps", "guide"],
    ["guides.imagePages", "page"],
  ],
  fever: [
    ["stages.music", "music"],
    ["stages.stages", "stages"],
    ["stages.bgm", "music"],
  ],
};
const FIELD_ALIASES: Record<string, string> = {
  entityGroup: "category",
  categoryId: "category",
  bandId: "band",
  taskTabId: "taskTabs",
  levelLimit: "unlockLevel",
};

export class AnonTokyoWorkspace extends LitElement {
  static properties = {
    locale: { type: String },
    mode: { type: String },
    labels: { type: String },
    phase: { state: true },
    document: { state: true },
    selectedCharacter: { state: true },
    tab: { state: true },
    selectedItem: { state: true },
    query: { state: true },
    visible: { state: true },
    filtersOpen: { state: true },
    facets: { state: true },
    view: { state: true },
    outfitSelections: { state: true },
    error: { state: true },
    outfitError: { state: true },
  };
  declare locale: string;
  declare mode: string;
  declare labels: string;
  declare phase: "loading" | "ready" | "error";
  declare document: Value | null;
  declare selectedCharacter: string;
  declare tab: number;
  declare selectedItem: string;
  declare query: string;
  declare visible: number;
  declare filtersOpen: boolean;
  declare facets: Record<string, string[]>;
  declare view: CollectionView;
  declare outfitSelections: Record<number, string>;
  declare error: string;
  declare outfitError: string;
  private bands: Value[] = [];
  private referenceData?: Value;
  private copies: Record<string, Record<string, string>> = {};
  private outfitStage?: OutfitStage;
  private outfitRecipeKey = "";
  private outfitStageCharacter = "";
  private lazyImages = new LazyImages();
  private paneFocus = new PaneFocus();
  private releaseLocation?: () => void;
  private onLocale = () => {
    this.locale = preferredLocale();
  };
  constructor() {
    super();
    this.locale = "ja";
    this.mode = "characters";
    this.labels = "{}";
    this.phase = "loading";
    this.document = null;
    this.selectedCharacter = "";
    this.tab = 1;
    this.selectedItem = "";
    this.query = "";
    this.visible = 80;
    this.filtersOpen = false;
    this.facets = {};
    this.view = "grid";
    this.outfitSelections = {};
    this.error = "";
    this.outfitError = "";
  }
  createRenderRoot() {
    return this;
  }
  connectedCallback() {
    super.connectedCallback();
    this.locale = preferredLocale(this.locale);
    this.copies = JSON.parse(this.labels || "{}");
    this.releaseLocation = observeDetailLocation(this.restoreLocation, this);
    addEventListener("haneoka:locale-ready", this.onLocale);
    void import("@material/web/textfield/outlined-text-field.js");
    void import("@material/web/progress/circular-progress.js");
    this.restoreLocation();
    void this.load();
  }
  disconnectedCallback() {
    clearBrowseBar();
    this.releaseLocation?.();
    this.paneFocus.detach();
    this.lazyImages.disconnect();
    this.outfitStage?.dispose();
    removeEventListener("haneoka:locale-ready", this.onLocale);
    super.disconnectedCallback();
  }
  private restoreLocation = () => {
    const params = new URLSearchParams(location.search);
    this.selectedCharacter = params.get("character") || "";
    this.selectedItem = params.get("item") || "";
    this.query = params.get("q") || "";
    this.view = collectionView(params.get("view"));
    this.facets = Object.fromEntries(
      [...params.keys()].filter((key) => key.startsWith("filter.")).map((key) => [key.slice(7), params.getAll(key)]),
    );
  };
  private sync() {
    const params = new URLSearchParams(location.search);
    for (const key of [...params.keys()]) if (key.startsWith("filter.")) params.delete(key);
    for (const [key, choices] of Object.entries(this.facets))
      for (const choice of choices) params.append(`filter.${key}`, choice);
    this.query ? params.set("q", this.query) : params.delete("q");
    this.view !== "grid" ? params.set("view", this.view) : params.delete("view");
    history.replaceState(history.state, "", `${location.pathname}${params.size ? `?${params}` : ""}`);
  }
  private async loadReferenceData() {
    const server = this.server();
    let request = referenceDocuments.get(server);
    if (!request) {
      request = fetch(catalogUrl("anon-tokyo", "", server)).then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json() as Promise<Value>;
      });
      referenceDocuments.set(server, request);
      request.catch(() => referenceDocuments.delete(server));
    }
    try {
      const data = await request;
      if (this.isConnected && this.server() === server) {
        this.referenceData = data;
        this.requestUpdate();
      }
    } catch {
      /* The collection payload still provides the primary details. */
    }
  }
  private openItem(item: Value) {
    void this.loadReferenceData();
    this.selectedItem = String(item.id);
    const params = new URLSearchParams(location.search);
    params.set("item", this.selectedItem);
    openDetailLocation(`${location.pathname}?${params}`);
  }
  private closeItem() {
    const params = new URLSearchParams(location.search);
    params.delete("item");
    closeDetailLocation(`${location.pathname}${params.size ? `?${params}` : ""}`);
  }
  updated() {
    this.lazyImages.observe(this);
    this.paneFocus.sync(this.querySelector<HTMLElement>("[data-detail-pane]"), () => this.closeItem());
    if (this.mode !== "outfits" || this.phase !== "ready") return;
    const host = this.querySelector<HTMLElement>("[data-outfit-runtime]");
    const recipe = this.outfitRecipe();
    const key = String(recipe?.id || "");
    if (!host || !recipe || !key || this.outfitRecipeKey === key) return;
    const characterKey = String(recipe.characterId || this.selectedCharacter);
    if (!this.outfitStage || this.outfitStageCharacter !== characterKey) {
      this.outfitStage?.dispose();
      this.outfitStage = new OutfitStage(host, this.server());
      this.outfitStageCharacter = characterKey;
    }
    this.outfitRecipeKey = key;
    this.outfitError = "";
    host.classList.remove("ready", "failed");
    void this.outfitStage
      .load(
        Array.isArray(recipe.parts) ? (recipe.parts as Array<{ modelId?: string; order?: number }>) : [],
        String((recipe.animation as Value | undefined)?.name || "f_idle"),
        Number(recipe.scale || 1),
      )
      .then(() => {
        if (this.outfitRecipeKey === key) host.classList.add("ready");
      })
      .catch((error) => {
        if (this.outfitRecipeKey === key) {
          host.classList.add("failed");
          this.outfitError = error instanceof Error ? error.message : String(error);
        }
      });
  }
  private server() {
    return currentReleaseServer();
  }
  private async load() {
    this.phase = "loading";
    this.error = "";
    this.referenceData = undefined;
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
      if (this.mode === "tasks") await this.loadReferenceData();
      this.phase = "ready";
      if (this.selectedItem && this.mode !== "outfits") void this.loadReferenceData();
      if (this.mode === "outfits" && this.selectedItem) {
        const selected = values(read(this.document, "goods.reloading")).find((item) => item.id === this.selectedItem);
        if (selected) {
          this.tab = Number(selected.spineType || 1);
          this.outfitSelections = { [this.tab]: this.selectedItem };
        }
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
  private label(key: string) {
    const value = this.copies[this.locale]?.[key] || this.copies.en?.[key];
    if (value) return value;
    const common = uiText(this.locale, key);
    return common !== key
      ? common
      : key.replace(/([a-z])([A-Z])/gu, "$1 $2").replace(/^./u, (letter) => letter.toUpperCase());
  }
  private text(value: unknown) {
    return localizedText(value, this.locale);
  }
  private titleValue(item: Value) {
    return resolveLocalizedText(item.name || item.displayName || item.title || item.text, this.locale);
  }
  private entityTitle(item: Value): string {
    if (this.mode === "tasks" && item.taskTypeId) return this.taskTitle(item);
    const named = this.titleValue(item).text;
    if (this.mode === "guide" && !named)
      return `${this.label(item.pageIndex == null ? "guideStep" : "page")} ${Number(item.pageIndex ?? item.rawId ?? 0) + 1}`;
    if (this.mode === "fever" && item.cueName && !named) return this.label("backgroundMusic");
    if (named && !/^(?:normal|helper|deliveryman|customer):\d+$/u.test(named)) return named;
    if (this.mode === "customers" && item.customerKind) return this.label(String(item.customerKind));
    if (this.mode === "staff" && item.nameKey && this.copies[this.locale]?.[String(item.nameKey)])
      return this.label(String(item.nameKey));
    if (this.mode === "fever" && item.bandId)
      return `${this.anonBandName(Number(item.bandId))} · ${this.label(String(item.entityGroup || "stages"))}`;
    if (item.level != null) return `${this.label(String(item.entityGroup || "level"))} · Lv.${item.level}`;
    return this.label(String(item.entityGroup || this.mode));
  }
  private media(item: Value): string {
    for (const key of ["image", "icon", "avatar", "preview", "thumbnail"]) {
      const value = item[key];
      if (typeof value === "string" && /^(?:https?:|\/|data:)/u.test(value)) return value;
      if (value && typeof value === "object") {
        const data = value as Value;
        const variants = data.variants as Value | undefined;
        const language = this.locale === "zh-CN" ? "zh-Hans" : this.locale === "zh-TW" ? "zh-Hant" : this.locale;
        const variant = variants?.[language] as Value | undefined;
        const url = String(variant?.url || data.url || "");
        if (url) return url;
      }
    }
    return "";
  }
  private collection(): Value[] {
    return (MODE_GROUPS[this.mode] || [])
      .flatMap(([path, entityGroup]) =>
        values(read(this.document, path)).map((item): Value => ({ ...item, entityGroup })),
      )
      .sort(
        (a, b) =>
          Number(a.rawId ?? Number.MAX_SAFE_INTEGER) - Number(b.rawId ?? Number.MAX_SAFE_INTEGER) ||
          String(a.id).localeCompare(String(b.id), "en", { numeric: true }),
      );
  }
  private subtitle(item: Value): string {
    if (this.mode === "characters")
      return Number(item.levelLimit) > 0
        ? `${this.label("unlockLevel")} · Lv.${item.levelLimit}`
        : this.label("noLevelRequirement");
    if (this.mode === "goods")
      return `${this.label("unitCost")} ${Number(read(item, "purchase.cost") || 0).toLocaleString(this.locale)} · ${this.label("quantity")} ${Number(read(item, "purchase.count") || 0).toLocaleString(this.locale)}`;
    if (this.mode === "decorations")
      return `${(item.size as number[] | undefined)?.join(" × ") || "—"} · ${this.label("popularity")} +${Number(read(item, "popularity.count") || 0)}`;
    if (this.mode === "shop")
      return `${this.label("customerCapacity")} ${item.customerCount ?? "—"} · ${item.exp != null ? `EXP ${item.exp}` : `${this.label("roomSize")} ${(item.size as number[] | undefined)?.join(" × ") || "—"}`}`;
    if (this.mode === "tasks") return this.rewardText(item.reward) || this.label(String(item.entityGroup || "tasks"));
    if (this.mode === "staff")
      return `${this.label(String(item.entityGroup || "staff"))}${item.point != null ? ` · ${item.point} ${this.label("point")}` : ""}`;
    if (this.mode === "customers")
      return `${this.label(String(item.customerKind || "customers"))} · Lv.${read(item, "values.customerLv") || item.level || 1}`;
    if (this.mode === "guide")
      return item.pageIndex != null ? `${this.label("page")} ${Number(item.pageIndex) + 1}` : this.label("guide");
    if (this.mode === "fever")
      return [
        this.label(String(item.entityGroup)),
        this.anonBandName(Number(item.bandId)),
        item.durationSeconds != null ? `${item.durationSeconds}s` : "",
      ]
        .filter(Boolean)
        .join(" · ");
    return this.text(item.description) || `#${item.rawId}`;
  }
  render() {
    if (this.phase === "loading") return loadingState(uiText(this.locale, "loading"));
    if (this.phase === "error" || !this.document)
      return errorState(
        uiText(this.locale, "unavailable"),
        uiText(this.locale, "retry"),
        () => void this.load(),
        this.error,
      );
    if (
      this.document.available === false ||
      (this.mode === "outfits" ? !values(this.document.characters).length : !this.collection().length)
    ) {
      clearBrowseBar();
      return html`
        <section class="page">
          ${noticeState({
            title: this.label("availabilityTitle"),
            body: this.label("unavailable"),
            icon: "inventory_2",
            action: html`
              <button
                class="button button--tonal"
                @click=${() => {
                  writeReleaseServer("intl-cbt");
                  void this.load();
                }}
              >
                ${uiText(this.locale, "settingsGlobalCbt") === "settingsGlobalCbt" ? this.label("viewCbt") : uiText(this.locale, "settingsGlobalCbt")}
              </button>
            `,
          })}
        </section>
      `;
    }
    return this.mode === "outfits" ? this.renderOutfits() : this.renderCollection();
  }
  private renderCollection() {
    const source = this.collection();
    const keys = [
      "entityGroup",
      "categoryId",
      "type",
      "subType",
      "customerKind",
      "bandId",
      "taskTabId",
      "levelLimit",
      "rarity",
      "isShow",
    ];
    const filters = keys.flatMap((key) => {
      const choices = [...new Set(source.flatMap((item) => (item[key] == null ? [] : [String(item[key])])))];
      return choices.length > 1 ? [{ key, choices }] : [];
    });
    const needle = this.query.trim().normalize("NFKC").toLocaleLowerCase(this.locale);
    const filtered = source.filter(
      (item) =>
        (!needle ||
          `${this.entityTitle(item)} ${this.subtitle(item)} ${item.rawId}`
            .normalize("NFKC")
            .toLocaleLowerCase(this.locale)
            .includes(needle)) &&
        Object.entries(this.facets).every(([key, values]) => !values.length || values.includes(String(item[key]))),
    );
    const shown = filtered.slice(0, this.visible);
    const title = (item: Value) => html`
      <span lang=${this.titleValue(item).locale}>${this.entityTitle(item)}</span>
    `;
    const collection =
      this.view === "grid"
        ? html`
            <div class="collection collection--anon">
              ${shown.map((item) => tile({ kind: "anon", title: title(item), subtitle: this.subtitle(item), label: this.entityTitle(item), image: this.media(item), fit: "contain", onOpen: () => this.openItem(item), onImageError: nextImageCandidate, placeholder: icon(this.mode === "fever" ? "music_note" : this.mode === "characters" ? "person" : "inventory_2", 32) }))}
            </div>
          `
        : this.view === "list"
          ? collectionList(
              shown.map((item) => ({
                id: String(item.id),
                title: title(item),
                subtitle: this.subtitle(item),
                image: this.media(item),
                onOpen: () => this.openItem(item),
              })),
            )
          : collectionTable(
              this.label(this.mode),
              ["ID", this.label("name"), this.label("details"), this.label("category")],
              shown.map((item) => [
                item.rawId,
                html`
                  <button class="anon-table-title" @click=${() => this.openItem(item)}>
                    ${
                      this.media(item)
                        ? html`
                            <img src=${this.media(item)} alt="" loading="lazy" />
                          `
                        : nothing
                    }${title(item)}
                  </button>
                `,
                this.subtitle(item),
                this.label(String(item.entityGroup)),
              ]),
            );
    const selected = source.find((item) => String(item.id) === this.selectedItem);
    return html`
      ${renderBrowse({
        kind: "anon",
        count: { value: filtered.length, label: source.length === filtered.length ? "" : `/ ${source.length}` },
        controls: viewSwitch(this.locale, this.view, (view) => {
          this.view = view;
          this.sync();
        }),
        applied: Object.entries(this.facets).flatMap(([key, values]) =>
          values.map((value) =>
            inputChip(
              `${this.label(FIELD_ALIASES[key] || key)}: ${this.facetValue(key, value)}`,
              uiText(this.locale, "remove"),
              () => this.toggleFacet(key, value),
            ),
          ),
        ),
        results: html`
          ${filtered.length ? collection : emptyState({ title: uiText(this.locale, "empty"), icon: "search_off" })}${
            shown.length < filtered.length
              ? html`
                  <div class="load-more">
                    <button class="button button--tonal" @click=${() => (this.visible += 80)}>
                      ${uiText(this.locale, "loadMore")}
                    </button>
                  </div>
                `
              : nothing
          }
        `,
        filters: {
          label: uiText(this.locale, "filter"),
          open: this.filtersOpen,
          count:
            Object.values(this.facets).reduce((sum, values) => sum + values.length, 0) + Number(Boolean(this.query)),
          closeLabel: uiText(this.locale, "close"),
          resetLabel: uiText(this.locale, "reset"),
          onOpen: () => (this.filtersOpen = true),
          onClose: () => (this.filtersOpen = false),
          onReset: () => {
            this.query = "";
            this.facets = {};
            this.visible = 80;
            this.sync();
          },
          body: html`
            <md-outlined-text-field
              type="search"
              label=${uiText(this.locale, "search")}
              .value=${this.query}
              @input=${(event: Event) => {
                this.query = (event.target as HTMLInputElement).value;
                this.visible = 80;
                this.sync();
              }}
            ></md-outlined-text-field>
            ${filters.map(({ key, choices }) =>
              renderFacet(
                this.label(FIELD_ALIASES[key] || key),
                this.locale,
                choices.map((value) => ({
                  value,
                  label: this.facetValue(key, value),
                  count: source.filter((item) => String(item[key]) === value).length,
                })),
                this.facets[key] || [],
                (value) => this.toggleFacet(key, value),
              ),
            )}
          `,
        },
      })}${selected ? this.renderDetail(selected) : nothing}
    `;
  }
  private toggleFacet(key: string, value: string) {
    const next = this.facets[key] || [];
    this.facets = {
      ...this.facets,
      [key]: next.includes(value) ? next.filter((item) => item !== value) : [...next, value],
    };
    this.visible = 80;
    this.sync();
  }
  private facetValue(key: string, value: string) {
    if (key === "entityGroup") return this.label(value);
    if (key === "categoryId")
      return (
        this.entityTitle(
          values(read(this.document, "goods.categories")).find((item) => String(item.rawId) === value) || {},
        ) || value
      );
    if (key === "bandId") return this.anonBandName(Number(value)) || value;
    if (key === "taskTabId")
      return (
        this.text(values(read(this.document, "tasks.tabs")).find((item) => String(item.rawId) === value)?.name) || value
      );
    if (value === "true" || value === "false") return this.label(value === "true" ? "yes" : "no");
    return value;
  }
  private renderDetail(item: Value) {
    const image = this.media(item);
    const audio = String(item.playableUrl || "");
    return renderPane({
      title: this.entityTitle(item),
      titleLanguage: this.titleValue(item).locale,
      subtitle: this.subtitle(item),
      kind: "anon",
      style: this.mode === "guide" ? "" : "--detail-media-size:220px",
      open: true,
      backLabel: uiText(this.locale, "close"),
      onClose: () => this.closeItem(),
      body: detailLayout(
        image
          ? html`
              <image-gallery
                .images=${[{ id: "image", source: image, label: this.entityTitle(item) }]}
                locale=${this.locale}
                title=${this.entityTitle(item)}
              ></image-gallery>
            `
          : nothing,
        html`
          <section class="detail-section">
            ${renderAnonTokyoDetails({ item, data: this.referenceData || this.document || {}, locale: this.locale, mode: this.mode, label: (key) => this.label(key), text: (value) => this.text(value), media: (value) => this.media(value), title: (value) => this.entityTitle(value), taskTitle: (value) => this.taskTitle(value) })}${
              audio
                ? html`
                    <audio controls preload="none" src=${audio}></audio>
                  `
                : nothing
            }
          </section>
        `,
      ),
    });
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
  private renderOutfits() {
    clearBrowseBar();
    const characters = values(this.document?.characters).sort((a, b) => Number(a.rawId) - Number(b.rawId));
    const character = characters.find((item) => item.id === this.selectedCharacter) || characters[0];
    const rawId = Number(character?.rawId);
    const wearables = values(read(this.document, "goods.reloading"))
      .filter(
        (item) =>
          (!Array.isArray(item.characterIds) ||
            !item.characterIds.length ||
            item.characterIds.map(Number).includes(rawId)) &&
          Number(item.spineType) === this.tab,
      )
      .sort((a, b) => Number(a.rawId) - Number(b.rawId));
    const recipe = this.outfitRecipe();
    const preview = recipe?.preview as Value | undefined;
    const selectedId = this.outfitSelections[this.tab] || "";
    const labels = ["", "headwear", "top", "bottom", "shoes", "set"];
    return html`
      <section class="outfit-workspace">
        <div class="outfit-characters" role="group" aria-label=${uiText(this.locale, "characters")}>
          ${characters.map(
            (item) => html`
              <button
                type="button"
                aria-pressed=${character?.id === item.id}
                aria-label=${this.entityTitle(item)}
                title=${this.entityTitle(item)}
                @click=${() => this.selectCharacter(String(item.id))}
              >
                ${
                  this.media(item)
                    ? html`
                        <img src=${this.media(item)} alt="" loading="lazy" />
                      `
                    : icon("person", 24)
                }
                <span>${this.entityTitle(item)}</span>
              </button>
            `,
          )}
        </div>
        <section class="outfit-preview" aria-label=${this.label("preview")}>
          <div class="outfit-stage">
            ${
              preview?.url
                ? html`
                    <img src=${String(preview.url)} alt=${this.entityTitle(character || {})} />
                  `
                : nothing
            }
            <div class="outfit-stage__runtime" data-outfit-runtime></div>
            ${!recipe ? emptyState({ title: this.label("previewMissing"), icon: "person" }) : nothing}
          </div>
          <div class="outfit-preview__caption">
            <strong>${this.entityTitle(character || {})}</strong>
            <button
              class="button button--tonal"
              @click=${() => {
                this.outfitSelections = {};
                this.selectedItem = "";
              }}
            >
              ${this.label("defaultOutfit")}
            </button>
          </div>
          ${
            this.outfitError
              ? errorState(this.label("modelUnavailable"), uiText(this.locale, "retry"), () => {
                  this.outfitRecipeKey = "";
                  this.requestUpdate();
                })
              : nothing
          }
        </section>
        <section class="outfit-closet">
          <div class="outfit-tabs">
            ${segmented({ label: uiText(this.locale, "outfitParts"), value: String(this.tab), options: [1, 2, 3, 4, 5].map((kind) => ({ value: String(kind), label: uiText(this.locale, labels[kind]!) })), onSelect: (value) => (this.tab = Number(value)) })}
          </div>
          <div class="collection collection--outfit">
            ${wearables.map((item) =>
              tile({
                title: this.entityTitle(item),
                titleLanguage: this.titleValue(item).locale,
                subtitle: `${this.label("rarity")} ${item.rarity || "—"} · ${this.label("popularity")} ${item.popularity || 0}`,
                label: this.entityTitle(item),
                image: this.media(item),
                fit: "contain",
                selected: selectedId === item.id,
                kind: "outfit",
                onOpen: () => {
                  const value = item.id === selectedId ? "" : String(item.id);
                  const next = { ...this.outfitSelections, [this.tab]: value };
                  if (value && this.tab === 5) {
                    next[2] = "";
                    next[3] = "";
                    next[4] = "";
                  } else if (value && [2, 3, 4].includes(this.tab)) next[5] = "";
                  this.outfitSelections = next;
                  this.selectedItem = value;
                },
                onImageError: nextImageCandidate,
              }),
            )}
          </div>
        </section>
      </section>
    `;
  }
  private currencyName(id: number) {
    const currency = values(read(this.referenceData || this.document, "progression.currencies")).find(
      (item) => Number(item.rawId) === id,
    );
    return this.text(currency?.name) || uiText(this.locale, "currency");
  }
  private anonBandName(id: number) {
    return this.text(this.bands.find((band) => Number(band.bandId) === id)?.bandName) || "";
  }
  private rewardText(value: unknown) {
    const source = value && typeof value === "object" ? String((value as Value).raw || "") : String(value || "");
    return formatList(
      source.split(";").flatMap((entry) => {
        const [type, id, count] = entry.split(",").map(Number);
        if (!count) return [];
        return [`${type === 1 ? this.currencyName(id || 0) : uiText(this.locale, "reward")} ×${count}`];
      }),
      this.locale,
      "unit",
    );
  }
  private taskParameter(kind: string, value: unknown): string {
    const id = Number(value || 0);
    const paths: Record<string, string> = {
      goodsid: "goods.items",
      tagid: "goods.tags",
      goodstypeid: "goods.categories",
      decorationid: "shop.decorations",
      characterid: "characters",
      clerkid: "staffing.clerks",
      subtypeid: "shop.subTypes",
      suitid: "themes",
    };
    const path = paths[kind];
    if (path) {
      const entry = values(read(this.referenceData || this.document, path)).find((entry) => Number(entry.rawId) === id);
      return entry
        ? this.text(entry.name || entry.title) || this.label("unavailableObject")
        : this.label("unavailableObject");
    }
    if (kind === "time") {
      const seconds = Math.max(0, Number(value) || 0);
      return new Intl.NumberFormat(this.locale, { style: "unit", unit: "second", unitDisplay: "short" }).format(
        seconds,
      );
    }
    return String(value ?? "");
  }
  private taskTitle(entry: Value): string {
    if (!entry.taskTypeId) {
      const main = values(read(this.referenceData || this.document, "tasks.main")).find(
        (item) => Number(item.rawId) === Number(entry.rawId),
      );
      if (main?.taskTypeId) return this.taskTitle(main);
    }
    const type = values(read(this.referenceData || this.document, "tasks.types")).find(
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
