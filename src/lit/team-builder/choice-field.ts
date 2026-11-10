// L3 — GEB
// Input: Localized choices, native icons, current value and available settings width.
// Output: One row of segmented buttons when it fits, otherwise a Material select.
// Pos: [Map](../L2-2.md); shared short-option control for the team workspace.
// Effects/Dependencies: Observes only control dimensions; preserves selection and releases observers on disconnect.
import { LitElement, html, nothing } from "lit";
import { segmented, type SegmentedOptions } from "../ui/controls";
import "@material/web/select/outlined-select.js";
import "@material/web/select/select-option.js";

type Choices = SegmentedOptions<string> & { primary?: boolean };

class TeamChoiceField extends LitElement {
  static properties = { choices: { attribute: false }, dropdown: { state: true } };
  declare choices: Choices;
  declare private dropdown: boolean;
  private observer?: ResizeObserver;
  constructor() {
    super();
    this.choices = { label: "", value: "", options: [], onSelect: () => {} };
    this.dropdown = true;
  }
  createRenderRoot() { return this; }
  connectedCallback() {
    super.connectedCallback();
    this.observer = new ResizeObserver(() => this.measure());
    this.observer.observe(this);
    this.requestUpdate();
  }
  disconnectedCallback() {
    this.observer?.disconnect();
    super.disconnectedCallback();
  }
  protected updated() {
    const row = this.querySelector<HTMLElement>(".tb-choice__measure .segmented");
    if (row) this.observer?.observe(row);
    this.measure();
  }
  private measure() {
    if (!this.isConnected || !this.clientWidth) return;
    const row = this.querySelector<HTMLElement>(".tb-choice__measure .segmented");
    if (!row) return;
    const widths = [...row.children].map(element => element.getBoundingClientRect().width);
    if (!widths.length) return;
    if (this.choices.primary) widths[0] = Math.max(...widths) * 1.1;
    this.style.setProperty("--tb-choice-primary-width", `${widths[0]}px`);
    const required = widths.reduce((sum, width) => sum + width, 0) + (widths.length - 1) * parseFloat(getComputedStyle(row).columnGap);
    const dropdown = required > this.clientWidth + 0.5;
    if (dropdown === this.dropdown) return;
    const focused = this.contains(document.activeElement);
    this.dropdown = dropdown;
    if (focused) void this.updateComplete.then(() => {
      this.querySelector<HTMLElement>('md-outlined-select, .tb-choice__visible [aria-checked="true"]')?.focus({ preventScroll: true });
    });
  }
  render() {
    const options = this.choices;
    const selected = options.options.find(option => option.value === options.value);
    return html`
      <div class=${`tb-choice stack stack--tight${options.primary ? " tb-choice--primary" : ""}`}>
        <span class="tb-field__label">${options.label}</span>
        <div class="tb-choice__visible">
          ${this.dropdown ? html`
            <md-outlined-select
              aria-label=${options.label}
              .value=${options.value}
              ?disabled=${options.options.every(option => option.disabled)}
              @change=${(event: Event) => options.onSelect((event.target as HTMLInputElement).value)}
            >
              ${selected?.leading ? html`<span slot="leading-icon" class="tb-game-icon">${selected.leading}</span>` : nothing}
              ${options.options.map(option => html`
                <md-select-option value=${option.value} ?disabled=${option.disabled}>
                  ${option.leading ? html`<span slot="start" class="tb-game-icon">${option.leading}</span>` : nothing}
                  <div slot="headline">${option.label}</div>
                </md-select-option>
              `)}
            </md-outlined-select>
          ` : segmented(options)}
        </div>
        <div class="tb-choice__measure" aria-hidden="true" inert>${segmented(options)}</div>
      </div>
    `;
  }
}

if (!customElements.get("team-choice-field")) customElements.define("team-choice-field", TeamChoiceField);

export function choiceField<T extends string>(options: SegmentedOptions<T> & { primary?: boolean }) {
  return html`<team-choice-field .choices=${options}></team-choice-field>`;
}
