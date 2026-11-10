import { unpublishedState } from "./ui/unpublished-state";
import { SPOILER_CONTENT_EVENT } from "../lib/spoiler-content";
import { isContentListed, isContentVisible } from "../lib/content-release";
import "@lit-labs/ssr-client/lit-element-hydrate-support.js";
import { hydrateWorkspace } from "./shared/hydrate-workspace";
import { readPageData } from "../lib/page-data";
import { navigationDocumentUrl } from "../lib/document-url";
import type { WorkspaceCollectionPayload } from "../lib/workspace-page-data";
import { LitElement, html, nothing } from "lit";
import { clearAppBarActions, setAppBarActions } from "../lib/app-bar";
import { beginLoading, type LoadingReporter } from "../lib/loading-progress";
import { updateEntityHeading } from "../lib/detail-navigation";
import { parseEntitySelection } from "../lib/resource-route";
import { currentReleaseServer } from "./shared/catalog";
import { fetchCrossServerCatalogs } from "../lib/cross-server/fetch";
import { crossCatalogPresentation, type CrossCatalogPresentation } from "../lib/cross-server/presentation";
import { OFFICIAL_CATALOG_SERVERS, type OfficialCatalogServer } from "../lib/cross-server/catalog";
import { catalogServerBadge } from "./shared/server-availability";
import { segmented } from "./ui/controls";
import { errorState, loadingState } from "./ui/state";
import {
  catalogUrl,
  fetchJson,
  localizedText,
  preferredLocale,
  recordValues,
  type JsonRecord,
  uiText,
} from "./shared/catalog";

export interface HelpViewState {
  mode: "manual" | "tips";
  topic?: string;
}
export type HelpCollectionPageData = WorkspaceCollectionPayload & { helpView?: HelpViewState };

export class HelpWorkspace extends LitElement {
  static properties = {
    locale: { type: String },
    entityId: { type: String, attribute: "entity-id" },
    phase: { state: true },
    categories: { state: true },
    tips: { state: true },
    mode: { state: true },
    selectedCategory: { state: true },
    selectedTopic: { state: true },
    error: { state: true },
  };
  declare locale: string;
  declare entityId: string;
  declare phase: "loading" | "ready" | "error";
  declare categories: JsonRecord[];
  declare tips: JsonRecord[];
  declare mode: "manual" | "tips";
  declare selectedCategory: number;
  declare selectedTopic: string;
  declare error: string;
  private request?: AbortController;
  private unionHelp?: CrossCatalogPresentation;
  private unionTips?: CrossCatalogPresentation;
  private sourceServer?: string;
  private loading?: LoadingReporter;
  private initialViewApplied = false;
  constructor() {
    super();
    this.locale = "ja";
    this.entityId = "";
    this.phase = "loading";
    this.categories = [];
    this.tips = [];
    this.mode = "manual";
    this.selectedCategory = 0;
    this.selectedTopic = "";
    this.error = "";
  }
  createRenderRoot() {
    return this;
  }
  private contentAccessChanged = () => {
    this.request?.abort();
    this.request = undefined;
    this.loading?.cancel();
    this.unionHelp = undefined;
    this.unionTips = undefined;
    this.categories = [];
    this.tips = [];
    void this.load();
  };
  connectedCallback() {
    addEventListener(SPOILER_CONTENT_EVENT, this.contentAccessChanged);
    const page = readPageData<HelpCollectionPageData>(this);
    this.locale = preferredLocale(this.locale);
    if (page?.schema === "haneoka-workspace-collection-v1" && page.resource === "help")
      this.prepareCollection(page, this.locale);
    super.connectedCallback();
    if (this.hasAttribute("data-prerendered")) void this.updateComplete.then(() => this.connectHelp());
    else this.connectHelp();
  }
  protected update(changed: import("lit").PropertyValues) {
    if (this.hasAttribute("data-prerendered")) {
      hydrateWorkspace(this.render(), this, this.renderOptions);
      this.removeAttribute("data-prerendered");
    }
    super.update(changed);
  }
  private connectHelp() {
    if (!this.isConnected) return;
    const url = navigationDocumentUrl();
    const selection = parseEntitySelection(url.pathname);
    if (selection?.source === "canonical" && selection.route.kind === "help") {
      this.entityId = selection.route.id;
      this.sourceServer = selection.route.server;
    }
    this.locale = preferredLocale(this.locale);
    void Promise.all([import("@material/web/progress/circular-progress.js")]);
    const p = url.searchParams;
    this.mode = p.get("mode") === "tips" ? "tips" : "manual";
    this.selectedTopic = this.entityId || p.get("topic") || "";
    void this.load();
  }
  disconnectedCallback() {
    removeEventListener(SPOILER_CONTENT_EVENT, this.contentAccessChanged);
    this.request?.abort();
    this.request = undefined;
    this.loading?.cancel();
    clearAppBarActions("help");
    super.disconnectedCallback();
  }
  public prepareCollection(payload: HelpCollectionPageData, locale: string, _mode?: string): void {
    this.locale = locale;
    if (!this.initialViewApplied) {
      this.initialViewApplied = true;
      if (payload.helpView) {
        this.mode = payload.helpView.mode;
        this.selectedTopic = payload.helpView.topic || "";
      }
    }
    this.prepareDocument(this.collectionDocument(payload.catalogs));
    this.phase = "ready";
  }
  private collectionDocument(catalogs: WorkspaceCollectionPayload["catalogs"]): JsonRecord {
    const server = catalogs.help!.selectedServer;
    this.sourceServer = server;
    this.unionHelp = crossCatalogPresentation(catalogs.help!);
    this.unionTips = crossCatalogPresentation(catalogs["help-tips"]!);
    const categories = new Map<string, JsonRecord>();
    for (const source of [server, ...OFFICIAL_CATALOG_SERVERS.filter((value) => value !== server)])
      for (const category of recordValues((catalogs.help!.documents[source] as JsonRecord | undefined)?.categories))
        if (!categories.has(String(category.categoryId)))
          categories.set(String(category.categoryId), { ...category, subcategories: [] });
    for (const topic of this.unionHelp.items) {
      const category = categories.get(String(topic.helpCategoryId));
      if (category) (category.subcategories as JsonRecord[]).push(topic);
    }
    return {
      categories: Object.fromEntries(categories),
      loadingTips: Object.fromEntries(this.unionTips.items.map((tip) => [this.unionTips!.entries.get(tip)!.key, tip])),
    };
  }
  private prepareDocument(d: JsonRecord): JsonRecord | undefined {
    this.categories = recordValues(d.categories).sort((a, b) => Number(a.order) - Number(b.order));
    this.tips = recordValues(d.loadingTips).sort((a, b) => Number(a.tipId) - Number(b.tipId));
    // A deep-linked topic (?topic=) opens the category that contains it.
    const selected = this.topicForId(this.categories.flatMap(category => Array.isArray(category.subcategories) ? category.subcategories as JsonRecord[] : []), this.selectedTopic);
    const linked = selected
      ? this.categories.find((category) =>
          Array.isArray(category.subcategories)
            ? (category.subcategories as JsonRecord[]).some(
                (topic) => topic === selected,
              )
            : false,
        )
      : undefined;
    this.selectedCategory = Number(linked?.categoryId ?? this.categories[0]?.categoryId ?? 0);
    return linked;
  }
  private topicForId(rows: JsonRecord[], id: string): JsonRecord | undefined {
    if (!id) return undefined;
    const matches = rows.filter(row => String(row.helpSubcategoryId ?? "") === id);
    const server = this.sourceServer || currentReleaseServer();
    const own = matches.filter(row => this.unionHelp?.entries.get(row)?.perServer[server]);
    return own.length === 1 ? own[0] : matches.length === 1 ? matches[0] : undefined;
  }
  private text(v: unknown) {
    return localizedText(v, this.locale);
  }
  private async load() {
    const page = readPageData<WorkspaceCollectionPayload>(this);
    if (page?.schema === "haneoka-workspace-collection-v1" && page.resource === "help" && !this.entityId) {
      this.prepareCollection(page, this.locale);
      return;
    }
    this.request?.abort();
    this.loading?.cancel();
    const controller = new AbortController();
    const progress = beginLoading(uiText(this.locale, "common.states.loading"), {
      scope: "owner",
      signal: controller.signal,
    });
    this.request = controller;
    this.loading = progress;
    this.phase = "loading";
    this.error = "";
    try {
      let d: JsonRecord;
      const server = (this.sourceServer || currentReleaseServer()) as OfficialCatalogServer;
      if (!this.entityId && OFFICIAL_CATALOG_SERVERS.includes(server)) {
        const catalogs = await fetchCrossServerCatalogs(["help", "help-tips"], server, this.locale, {
          signal: controller.signal,
        });
        if (Object.values(catalogs.help!.sourceAvailability).every((value) => value !== "loaded"))
          throw new Error("Help catalog unavailable");
        if (controller.signal.aborted || this.request !== controller) return;
        d = this.collectionDocument(catalogs);
      } else {
        this.unionHelp = undefined;
        this.unionTips = undefined;
        d = await fetchJson<JsonRecord>(catalogUrl("help", "", server), { signal: controller.signal });
      }
      if (this.request !== controller || controller.signal.aborted) {
        progress.cancel();
        return;
      }
      const linked = this.prepareDocument(d);
      if (this.entityId) {
        const entry = this.topicForId(this.filteredEntries(), this.entityId);
        if (entry) updateEntityHeading(this, this.text(entry.title));
      }
      this.dataset.entityReady = String(Boolean(this.entityId && linked));
      this.phase = "ready";
      progress.finish();
    } catch (e) {
      if (controller.signal.aborted || this.request !== controller) {
        progress.cancel();
        return;
      }
      this.phase = "error";
      this.error = e instanceof Error ? e.message : String(e);
      progress.fail(e);
    } finally {
      if (this.request === controller && this.phase !== "error") {
        this.request = undefined;
        this.loading = undefined;
      }
    }
  }
  private sync() {
    const p = new URLSearchParams();
    if (this.mode !== "manual") p.set("mode", this.mode);
    history.replaceState(history.state, "", `${location.pathname}${p.size ? `?${p}` : ""}`);
  }
  private filteredEntries() {
    if (this.mode === "tips") return this.entityId ? this.tips : this.tips.filter((item)=>isContentListed("help-tips",item,String(item.tipId)));
    const category = this.categories.find((item) => Number(item.categoryId) === this.selectedCategory);
    const entries = Array.isArray(category?.subcategories) ? (category.subcategories as JsonRecord[]) : [];
    return this.entityId ? entries : entries.filter((item)=>isContentListed("help",item,String(item.helpSubcategoryId)));
  }
  render() {
    if (this.entityId && !isContentVisible(this.mode === "tips" ? "help-tips" : "help", this.topicForId(this.filteredEntries(), this.entityId) || {}, this.entityId))
      return unpublishedState(this.locale);
    const entries = this.filteredEntries();
    if (this.entityId) {
      clearAppBarActions("help");
      if (this.phase === "loading") return loadingState(uiText(this.locale, "common.states.loading"));
      if (this.phase === "error")
        return errorState(
          uiText(this.locale, "common.states.unavailable"),
          uiText(this.locale, "common.actions.retry"),
          () => void this.load(),
          this.error,
        );
      const entry = this.topicForId(entries, this.entityId);
      return html`
        <section class="help-workspace help-workspace--entity">
          <main class="help-entries">
            ${
              entry
                ? html`
                    <details class="help-entry" open>
                      <summary><span>${this.text(entry.title) || "—"}</span></summary>
                      <div>
                        ${this.text(entry.description)
                          .split("\n")
                          .map((line) =>
                            line
                              ? html`
                                  <p>${line}</p>
                                `
                              : html`
                                  <br />
                                `,
                          )}
                      </div>
                    </details>
                  `
                : nothing
            }
          </main>
        </section>
      `;
    }
    // The manual/tips switch is a page-level action, so it belongs in the top
    // app bar rather than floating over it.
    setAppBarActions(
      "help",
      segmented({
        label: uiText(this.locale, "common.actions.view"),
        value: this.mode,
        options: [
          { value: "manual" as const, label: uiText(this.locale, "settings.labels.manual"), icon: "menu_book" },
          { value: "tips" as const, label: uiText(this.locale, "settings.labels.loadingTips"), icon: "lightbulb" },
        ],
        onSelect: (mode) => {
          this.mode = mode;
          this.sync();
        },
      }),
    );
    return html`
      <section class="help-workspace">
        ${
          this.phase === "loading"
            ? loadingState(uiText(this.locale, "common.states.loading"))
            : this.phase === "error"
              ? errorState(
                  uiText(this.locale, "common.states.unavailable"),
                  uiText(this.locale, "common.actions.retry"),
                  () => void this.load(),
                  this.error,
                )
              : html`
                  ${
                    this.mode === "manual"
                      ? html`
                          <aside class="help-categories">
                            ${this.categories.map(
                              (category) => html`
                                <button
                                  class=${Number(category.categoryId) === this.selectedCategory ? "selected" : ""}
                                  @click=${() => (this.selectedCategory = Number(category.categoryId))}
                                >
                                  <svg class="material-icon" width="20" height="20">
                                    <use href="/icons.svg#topic"></use>
                                  </svg>
                                  <span>${this.text(category.title) || "—"}</span>
                                  <small>
                                    ${Array.isArray(category.subcategories) ? category.subcategories.length : 0}
                                  </small>
                                </button>
                              `,
                            )}
                          </aside>
                        `
                      : nothing
                  }
                  <main class="help-entries">
                    ${entries.map(
                      (item, index) => html`
                        <details
                          class="help-entry ${
                            item === this.topicForId(entries, this.selectedTopic) ? "selected" : ""
                          }"
                          ?open=${
                            item === this.topicForId(entries, this.selectedTopic) ||
                            (index === 0 && entries.length < 8)
                          }
                        >
                          <summary>
                            <span>${this.text(item.title) || "—"}</span>
                            ${(() => {
                              const entry = (this.mode === "tips" ? this.unionTips : this.unionHelp)?.entries.get(item);
                              return catalogServerBadge(entry, this.locale);
                            })()}
                            <svg class="material-icon" width="20" height="20">
                              <use href="/icons.svg#expand_more"></use>
                            </svg>
                          </summary>
                          <div>
                            ${this.text(item.description)
                              .split("\n")
                              .map((line) =>
                                line
                                  ? html`
                                      <p>${line}</p>
                                    `
                                  : html`
                                      <br />
                                    `,
                              )}
                          </div>
                        </details>
                      `,
                    )}
                  </main>
                `
        }
      </section>
    `;
  }
}
customElements.define("help-workspace", HelpWorkspace);
