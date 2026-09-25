import { LitElement, html, nothing } from "lit";
import { clearAppBarActions, setAppBarActions } from "../lib/app-bar";
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

export class HelpWorkspace extends LitElement {
  static properties = {
    locale: { type: String },
    phase: { state: true },
    categories: { state: true },
    tips: { state: true },
    mode: { state: true },
    selectedCategory: { state: true },
    selectedTopic: { state: true },
    error: { state: true },
  };
  declare locale: string;
  declare phase: "loading" | "ready" | "error";
  declare categories: JsonRecord[];
  declare tips: JsonRecord[];
  declare mode: "manual" | "tips";
  declare selectedCategory: number;
  declare selectedTopic: string;
  declare error: string;
  constructor() {
    super();
    this.locale = "ja";
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
  connectedCallback() {
    super.connectedCallback();
    this.locale = preferredLocale(this.locale);
    void Promise.all([import("@material/web/progress/circular-progress.js")]);
    const p = new URLSearchParams(location.search);
    this.mode = p.get("mode") === "tips" ? "tips" : "manual";
    this.selectedTopic = p.get("topic") || "";
    void this.load();
  }
  disconnectedCallback() {
    clearAppBarActions("help");
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
      // A deep-linked topic (?topic=) opens the category that contains it.
      const linked = this.selectedTopic
        ? this.categories.find((category) =>
            Array.isArray(category.subcategories)
              ? (category.subcategories as JsonRecord[]).some(
                  (topic) => String(topic.helpSubcategoryId ?? "") === this.selectedTopic,
                )
              : false,
          )
        : undefined;
      this.selectedCategory = Number(
        linked?.categoryId ?? this.categories[0]?.categoryId ?? 0,
      );
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
    // The manual/tips switch is a page-level action, so it belongs in the top
    // app bar rather than floating over it.
    setAppBarActions(
      "help",
      segmented({
        label: uiText(this.locale, "view"),
        value: this.mode,
        options: [
          { value: "manual" as const, label: uiText(this.locale, "manual"), icon: "menu_book" },
          { value: "tips" as const, label: uiText(this.locale, "loadingTips"), icon: "lightbulb" },
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
            ? loadingState(uiText(this.locale, "loading"))
            : this.phase === "error"
              ? errorState(
                  uiText(this.locale, "unavailable"),
                  uiText(this.locale, "retry"),
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
                          class="help-entry ${String(item.helpSubcategoryId ?? "") === this.selectedTopic
                            ? "selected"
                            : ""}"
                          ?open=${String(item.helpSubcategoryId ?? "") === this.selectedTopic ||
                          (index === 0 && entries.length < 8)}
                        >
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
