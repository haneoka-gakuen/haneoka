import { html, nothing, LitElement, type PropertyValues } from "lit";
import { clientText } from "../../i18n/client";
import { summarizeCatalogCosts, type CatalogCostStep } from "../../lib/catalog-cost-summary";
import { segmented } from "./controls";
import { renderLevelSwitch } from "./level-switch";
import "../../styles/upgrade-cost.css";
interface UpgradeCostOptions {
  label: string;
  from: number;
  to: number;
  items: ReadonlyArray<{ name: string; count: number; image?: string; href?: string }>;
  locale?: string;
  /** Complete authored steps for this one upgrade kind and entity. */
  steps?: ReadonlyArray<CatalogCostStep>;
  scope?: string;
  initial?: number;
}
export function upgradeCost(options: UpgradeCostOptions) {
  if (options.steps)
    return html`
      <catalog-upgrade-cost .options=${options}></catalog-upgrade-cost>
    `;
  return renderUpgradeCost(options);
}

function renderUpgradeCost(options: UpgradeCostOptions) {
  return html`
    <section class="upgrade-cost" aria-label=${options.label}>
      <header>
        <strong>${options.label}</strong>
        <span>
          ${options.from}
          <span aria-hidden="true">→</span>
          ${options.to}
        </span>
      </header>
      <ul>
        ${options.items.map(
          (item) => html`
            <li>
              ${
                item.image
                  ? html`
                      <img src=${item.image} alt="" loading="lazy" />
                    `
                  : nothing
              }
              ${
                item.href
                  ? html`
                      <a href=${item.href}>${item.name}</a>
                    `
                  : html`
                      <span>${item.name}</span>
                    `
              }
              <strong>×${item.count.toLocaleString(options.locale)}</strong>
            </li>
          `,
        )}
      </ul>
    </section>
  `;
}

class CatalogUpgradeCost extends LitElement {
  static properties = { options: { attribute: false }, mode: { state: true }, current: { state: true } };
  declare options: UpgradeCostOptions;
  declare private mode: "step" | "cumulative" | "range";
  declare private current: number;
  constructor() {
    super();
    this.mode = "step";
    this.current = 1;
  }
  createRenderRoot() {
    return this;
  }

  protected willUpdate(changed: PropertyValues) {
    const previous = changed.get("options") as UpgradeCostOptions | undefined;
    if (changed.has("options") && previous?.scope !== this.options?.scope) {
      this.mode = "step";
      this.current = this.options?.initial ?? 1;
    }
    if (this.options) this.current = Math.min(this.current, this.options.to);
  }

  protected render() {
    const options = this.options;
    if (!options) return nothing;
    const text = (key: string, fallback: string) =>
      clientText(options.locale ?? "en", `catalogCompat.costSummary.${key}`, fallback);
    const initial = options.initial ?? 1;
    const from = this.mode === "step" ? options.from : this.mode === "cumulative" ? initial : this.current;
    const summary = summarizeCatalogCosts(options.steps ?? [], from, options.to);
    const values = Array.from({ length: Math.max(1, options.to - initial + 1) }, (_, index) => index + initial);
    return html`
      <div class="card-detail-controls">
        ${segmented({
          label: text("mode", "Material calculation"),
          value: this.mode,
          options: [
            { value: "step", label: text("step", "One upgrade") },
            { value: "cumulative", label: text("cumulative", "Cumulative") },
            { value: "range", label: text("range", "Current → target") },
          ],
          onSelect: (mode) => {
            this.mode = mode;
          },
        })}
        ${
          this.mode === "range"
            ? renderLevelSwitch(
                text("current", "Current"),
                values,
                this.current,
                (value) => {
                  this.current = value;
                },
                String,
                { context: options.scope },
              )
            : nothing
        }
        ${
          summary.complete
            ? renderUpgradeCost({ ...options, from, items: summary.items })
            : html`
                <p role="status">
                  ${text("missing", "Material data is unavailable for stages: {stages}").replace(
                    "{stages}",
                    summary.missing.join(", "),
                  )}
                </p>
              `
        }
      </div>
    `;
  }
}

if (typeof customElements !== "undefined" && !customElements.get("catalog-upgrade-cost"))
  customElements.define("catalog-upgrade-cost", CatalogUpgradeCost);
