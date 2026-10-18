import { LitElement, html, type PropertyValues } from "lit";
import { iconButton, rovingKeydown } from "./controls";

interface TabItem {
  id: string;
  label: string;
}

class ScrollableTabs extends LitElement {
  static properties = {
    items: { attribute: false },
    value: {},
    label: {},
    previousLabel: { attribute: false },
    nextLabel: { attribute: false },
    onSelect: { attribute: false },
    overflow: { state: true },
    atStart: { state: true },
    atEnd: { state: true },
  };
  declare items: readonly TabItem[];
  declare value: string;
  declare label: string;
  declare previousLabel: string;
  declare nextLabel: string;
  declare onSelect: (value: string) => void;
  declare private overflow: boolean;
  declare private atStart: boolean;
  declare private atEnd: boolean;
  private resize?: ResizeObserver;

  constructor() {
    super();
    this.items = [];
    this.value = "";
    this.label = "";
    this.previousLabel = "";
    this.nextLabel = "";
    this.onSelect = () => {};
    this.overflow = false;
    this.atStart = true;
    this.atEnd = true;
  }

  createRenderRoot() { return this; }

  connectedCallback() {
    super.connectedCallback();
    this.resize = new ResizeObserver(() => {
      this.measure();
      this.reveal(this.querySelector<HTMLElement>('[aria-selected="true"]'));
    });
    this.resize.observe(this);
  }

  disconnectedCallback() {
    this.resize?.disconnect();
    super.disconnectedCallback();
  }

  protected updated(changed: PropertyValues) {
    this.measure();
    if (changed.has("items") || changed.has("overflow")) {
      this.resize?.disconnect();
      this.resize?.observe(this);
      for (const tab of this.querySelectorAll<HTMLElement>('[role="tablist"], [role="tab"]'))
        this.resize?.observe(tab);
    }
    if (changed.has("value") || changed.has("items") || changed.has("overflow"))
      this.reveal(this.querySelector<HTMLElement>('[aria-selected="true"]'));
  }

  private measure() {
    const strip = this.querySelector<HTMLElement>('[role="tablist"]');
    if (!strip) return;
    this.overflow = strip.scrollWidth > this.clientWidth + 1;
    this.atStart = strip.scrollLeft <= 1;
    this.atEnd = strip.scrollLeft >= strip.scrollWidth - strip.clientWidth - 1;
  }

  private reveal(tab: HTMLElement | null) {
    const strip = this.querySelector<HTMLElement>('[role="tablist"]');
    if (!strip || !tab) return;
    const outer = strip.getBoundingClientRect();
    const inner = tab.getBoundingClientRect();
    const delta = inner.left < outer.left ? inner.left - outer.left : inner.right > outer.right ? inner.right - outer.right : 0;
    if (delta) strip.scrollBy({ left: delta });
  }

  private page(direction: number) {
    const strip = this.querySelector<HTMLElement>('[role="tablist"]');
    if (strip) strip.scrollBy({ left: direction * strip.clientWidth * 0.8 });
  }

  render() {
    return html`
      ${this.overflow ? iconButton({ icon: "chevron_left", label: this.previousLabel, disabled: this.atStart, onClick: () => this.page(-1) }) : null}
      <nav class="tabs tabs--secondary" role="tablist" aria-label=${this.label}
        @scroll=${() => this.measure()}
        @focusin=${(event: FocusEvent) => {
          const tab = (event.target as HTMLElement).closest<HTMLElement>('[role="tab"]');
          requestAnimationFrame(() => this.reveal(tab));
        }}
        @keydown=${rovingKeydown(this.items.map((item) => item.id), this.value, this.onSelect, { preventScroll: true })}>
        ${this.items.map((item) => html`<button class="tab" type="button" role="tab"
          aria-selected=${String(this.value === item.id)} tabindex=${this.value === item.id ? "0" : "-1"}
          title=${item.label} @click=${() => this.onSelect(item.id)}>
          <span class="clamp-1">${item.label}</span><span class="tab__indicator"></span>
        </button>`)}
      </nav>
      ${this.overflow ? iconButton({ icon: "chevron_right", label: this.nextLabel, disabled: this.atEnd, onClick: () => this.page(1) }) : null}
    `;
  }
}

if (typeof customElements !== "undefined" && !customElements.get("scrollable-tabs"))
  customElements.define("scrollable-tabs", ScrollableTabs);
