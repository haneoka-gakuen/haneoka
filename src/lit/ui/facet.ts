import { LitElement, html, nothing } from "lit";
import { uiText } from "../shared/catalog";
import { orderFacetOptions } from "../../lib/facet-order";
import "@material/web/checkbox/checkbox.js";

export interface FacetOption {
  id?: string | number;
  value: string;
  label: string;
  image?: string;
  count?: number;
}
export class FilterFacet extends LitElement {
  static properties = {
    label: {},
    locale: {},
    options: { attribute: false },
    selected: { attribute: false },
    onToggle: { attribute: false },
    query: { state: true },
    limit: { state: true },
  };
  declare label: string;
  declare locale: string;
  declare options: readonly FacetOption[];
  declare selected: readonly string[];
  declare onToggle: (value: string) => void;
  declare query: string;
  declare limit: number;
  constructor() {
    super();
    this.label = "";
    this.locale = "en";
    this.options = [];
    this.selected = [];
    this.onToggle = () => {};
    this.query = "";
    this.limit = 40;
  }
  createRenderRoot() {
    return this;
  }
  render() {
    const query = this.query.normalize("NFKC").toLocaleLowerCase(this.locale);
    const options = this.options.filter((option) =>
      option.label.normalize("NFKC").toLocaleLowerCase(this.locale).includes(query),
    );
    return html`
      <details class="filter-facet" ?open=${this.selected.length > 0 || this.options.length <= 8}>
        <summary>
          <span>${this.label}</span>
          <span class="filter-facet__summary">${this.selected.length || this.options.length}</span>
        </summary>
        ${
          this.options.length > 8
            ? html`
                <input
                  class="filter-facet__search"
                  type="search"
                  .value=${this.query}
                  aria-label=${`${uiText(this.locale, "search")} · ${this.label}`}
                  placeholder=${uiText(this.locale, "search")}
                  @input=${(event: Event) => {
                    this.query = (event.target as HTMLInputElement).value;
                    this.limit = 40;
                  }}
                />
              `
            : nothing
        }
        <div class="filter-facet__options">
          ${options.slice(0, this.limit).map(
            (option) => html`
              <label class="filter-facet__option">
                <md-checkbox
                  .checked=${this.selected.includes(option.value)}
                  ?disabled=${option.count === 0 && !this.selected.includes(option.value)}
                  aria-label=${option.label}
                  @change=${() => this.onToggle(option.value)}
                ></md-checkbox>
                ${
                  option.image
                    ? html`
                        <img
                          src=${option.image}
                          alt=""
                          loading="lazy"
                          @error=${(event: Event) => {
                            (event.target as HTMLImageElement).hidden = true;
                          }}
                        />
                      `
                    : nothing
                }
                <span>${option.label}</span>
                ${
                  option.count === undefined
                    ? nothing
                    : html`
                        <small>${option.count.toLocaleString(this.locale)}</small>
                      `
                }
              </label>
            `,
          )}
        </div>
        ${
          options.length > this.limit
            ? html`
                <button
                  class="button button--text"
                  type="button"
                  @click=${() => {
                    this.limit += 80;
                  }}
                >
                  ${uiText(this.locale, "loadMore")}
                </button>
              `
            : nothing
        }
      </details>
    `;
  }
}
if (!customElements.get("filter-facet")) customElements.define("filter-facet", FilterFacet);
export const facet = (
  label: string,
  locale: string,
  options: readonly FacetOption[],
  selected: readonly string[],
  onToggle: (value: string) => void,
) => html`
  <filter-facet
    .label=${label}
    .locale=${locale}
    .options=${orderFacetOptions(options)}
    .selected=${selected}
    .onToggle=${onToggle}
  ></filter-facet>
`;
