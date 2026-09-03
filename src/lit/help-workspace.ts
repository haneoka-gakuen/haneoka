import { LitElement, html, nothing } from "lit";
import {
  catalogUrl,
  fetchJson,
  localizedText,
  preferredLocale,
  recordValues,
  type JsonRecord,
  uiText,
} from "./shared/catalog";

export class HelpWorkspace extends LitElement {
  static properties = {
    locale: { type: String },
    phase: { state: true },
    categories: { state: true },
    tips: { state: true },
    mode: { state: true },
    selectedCategory: { state: true },
    error: { state: true },
  };
  declare locale: string;
  declare phase: "loading" | "ready" | "error";
  declare categories: JsonRecord[];
  declare tips: JsonRecord[];
  declare mode: "manual" | "tips";
  declare selectedCategory: number;
  declare error: string;
  constructor() {
    super();
    this.locale = "ja";
    this.phase = "loading";
    this.categories = [];
    this.tips = [];
    this.mode = "manual";
    this.selectedCategory = 0;
    this.error = "";
  }
  createRenderRoot() {
    return this;
  }
  connectedCallback() {
    super.connectedCallback();
    this.locale = preferredLocale(this.locale);
    void Promise.all([import("@material/web/progress/circular-progress.js")]);
    document.querySelector(".top-app-bar")?.classList.add("has-help-actions");
    const p = new URLSearchParams(location.search);
    this.mode = p.get("mode") === "tips" ? "tips" : "manual";
    void this.load();
  }
  disconnectedCallback() {
    document.querySelector(".top-app-bar")?.classList.remove("has-help-actions");
    super.disconnectedCallback();
  }
  private text(v: unknown) {
    return localizedText(v, this.locale);
  }
  private async load() {
    try {
      const d = await fetchJson<JsonRecord>(catalogUrl("help"));
      this.categories = recordValues(d.categories).sort((a, b) => Number(a.order) - Number(b.order));
      this.tips = recordValues(d.loadingTips).sort((a, b) => Number(a.tipId) - Number(b.tipId));
      this.selectedCategory = Number(this.categories[0]?.categoryId || 0);
      this.phase = "ready";
    } catch (e) {
      this.phase = "error";
      this.error = e instanceof Error ? e.message : String(e);
    }
  }
  private sync() {
    const p = new URLSearchParams();
    if (this.mode !== "manual") p.set("mode", this.mode);
    history.replaceState(history.state, "", `${location.pathname}${p.size ? `?${p}` : ""}`);
  }
  private filteredEntries() {
    if (this.mode === "tips") return this.tips;
    const category = this.categories.find((item) => Number(item.categoryId) === this.selectedCategory);
    return Array.isArray(category?.subcategories) ? (category.subcategories as JsonRecord[]) : [];
  }
  render() {
    const entries = this.filteredEntries();
    return html`
      <section class="help-workspace">
        <div class="help-top-actions">
          <div class="catalog__view">
            <button
              aria-label=${uiText(this.locale, "manual")}
              aria-pressed=${this.mode === "manual"}
              @click=${() => {
                this.mode = "manual";
                this.sync();
              }}
            >
              <svg class="material-icon" width="20" height="20">
                <use href=${`/icons.svg#menu_book${this.mode === "manual" ? "-filled" : ""}`}></use>
              </svg>
            </button>
            <button
              aria-label=${uiText(this.locale, "loadingTips")}
              aria-pressed=${this.mode === "tips"}
              @click=${() => {
                this.mode = "tips";
                this.sync();
              }}
            >
              <svg class="material-icon" width="20" height="20">
                <use href=${`/icons.svg#lightbulb${this.mode === "tips" ? "-filled" : ""}`}></use>
              </svg>
            </button>
          </div>
        </div>
        ${
          this.phase === "loading"
            ? html`
                <div class="catalog-state"><md-circular-progress indeterminate></md-circular-progress></div>
              `
            : this.phase === "error"
              ? html`
                  <div class="notice"><p>${this.error}</p></div>
                `
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
                        <details class="help-entry" ?open=${index === 0 && entries.length < 8}>
                          <summary>
                            <span>${this.text(item.title) || "—"}</span>
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
