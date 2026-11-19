// L3 — GEB
// Input: 横向标签栏模板、界面语言与可选的外层布局样式。
// Output: 保留原导航与键盘行为的标签栏，溢出时显示翻页按钮。
// Pos: [Map](L2-2.md)；工作区和社区共用标签栏。
// Effects/Dependencies: 连接期间观察标签宽度、选择状态与滚动位置。
import { LitElement, html, noChange, type TemplateResult } from "lit";
import { AsyncDirective } from "lit/async-directive.js";
import { directive, type ElementPart } from "lit/directive.js";
import { clientText } from "../../i18n/client";
import { iconButton, rovingKeydown } from "./controls";

class TabOverflow extends AsyncDirective {
  private wrapper?: HTMLElement;
  private stop?: () => void;

  render() { return noChange; }

  update({ element }: ElementPart) {
    this.wrapper = element as HTMLElement;
    if (!this.stop) this.connect();
    return noChange;
  }

  protected disconnected() {
    this.stop?.();
    this.stop = undefined;
  }

  protected reconnected() { this.connect(); }

  private connect() {
    queueMicrotask(() => {
      const wrapper = this.wrapper;
      if (!wrapper?.isConnected || !this.isConnected || this.stop) return;
      const strip = wrapper.querySelector<HTMLElement>(":scope > nav")!;
      const previous = wrapper.querySelector<HTMLButtonElement>(".tab-scroll__previous")!;
      const next = wrapper.querySelector<HTMLButtonElement>(".tab-scroll__next")!;
      const selected = () => strip.querySelector<HTMLElement>('[aria-selected="true"], [aria-current]:not([aria-current="false"])');
      const measureEdges = () => {
        previous.setAttribute("aria-disabled", String(strip.scrollLeft <= 1));
        next.setAttribute("aria-disabled", String(strip.scrollLeft >= strip.scrollWidth - strip.clientWidth - 1));
      };
      const reveal = (tab: HTMLElement | null) => {
        if (!tab || !wrapper.hasAttribute("data-overflow")) return;
        const outer = strip.getBoundingClientRect();
        const inner = tab.getBoundingClientRect();
        if (inner.left < outer.left) strip.scrollBy({ left: inner.left - outer.left });
        else if (inner.right > outer.right) strip.scrollBy({ left: inner.right - outer.right });
      };
      const measure = () => {
        const width = wrapper.clientWidth;
        const overflow = width > 0 && strip.scrollWidth > width + 1 &&
          /^(auto|scroll)$/u.test(getComputedStyle(strip).overflowX);
        wrapper.toggleAttribute("data-overflow", overflow);
        if (overflow) {
          reveal(selected());
          measureEdges();
        }
      };
      const resize = new ResizeObserver(measure);
      const observeSizes = () => {
        resize.disconnect();
        resize.observe(wrapper);
        resize.observe(strip);
        for (const tab of strip.children) resize.observe(tab);
      };
      const mutation = new MutationObserver((records) => {
        if (records.some((record) => record.type === "childList" && record.target === strip)) observeSizes();
        measure();
      });
      observeSizes();
      mutation.observe(strip, { subtree: true, attributes: true, attributeFilter: ["aria-selected", "aria-current"], childList: true });
      const focus = (event: FocusEvent) => reveal((event.target as HTMLElement).closest('[role="tab"], .tab'));
      strip.addEventListener("scroll", measureEdges, { passive: true });
      strip.addEventListener("focusin", focus);
      this.stop = () => {
        resize.disconnect();
        mutation.disconnect();
        strip.removeEventListener("scroll", measureEdges);
        strip.removeEventListener("focusin", focus);
      };
    });
  }
}

const tabOverflow = directive(TabOverflow);

export function scrollableTabBar(locale: string, strip: TemplateResult, className = "") {
  const page = (event: MouseEvent, direction: number) => {
    const button = event.currentTarget as HTMLButtonElement;
    if (button.getAttribute("aria-disabled") === "true") return;
    const nav = button.parentElement!.querySelector<HTMLElement>(":scope > nav")!;
    nav.scrollBy({ left: direction * nav.clientWidth * 0.8,
      behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  };
  return html`
    <div class=${className ? `tab-scroll ${className}` : "tab-scroll"} ${tabOverflow()}>
      ${iconButton({ icon: "chevron_left", label: clientText(locale, "common.actions.previous", "Previous"),
        className: "tab-scroll__previous", onClick: (event) => page(event, -1) })}
      ${strip}
      ${iconButton({ icon: "chevron_right", label: clientText(locale, "common.actions.next", "Next"),
        className: "tab-scroll__next", onClick: (event) => page(event, 1) })}
    </div>
  `;
}

interface TabItem {
  id: string;
  label: string;
}

class ScrollableTabs extends LitElement {
  static properties = {
    items: { attribute: false },
    value: {},
    label: {},
    locale: {},
    onSelect: { attribute: false },
  };
  declare items: readonly TabItem[];
  declare value: string;
  declare label: string;
  declare locale: string;
  declare onSelect: (value: string) => void;

  constructor() {
    super();
    this.items = [];
    this.value = "";
    this.label = "";
    this.locale = "en";
    this.onSelect = () => {};
  }

  createRenderRoot() { return this; }

  render() {
    return scrollableTabBar(this.locale, html`
      <nav class="tabs tabs--secondary" role="tablist" aria-label=${this.label}
        @keydown=${rovingKeydown(this.items.map((item) => item.id), this.value, this.onSelect, { preventScroll: true })}>
        ${this.items.map((item) => html`<button class="tab" type="button" role="tab"
          aria-selected=${String(this.value === item.id)} tabindex=${this.value === item.id ? "0" : "-1"}
          title=${item.label} @click=${() => this.onSelect(item.id)}>
          <span class="clamp-1">${item.label}</span><span class="tab__indicator"></span>
        </button>`)}
      </nav>
    `);
  }
}

if (typeof customElements !== "undefined" && !customElements.get("scrollable-tabs"))
  customElements.define("scrollable-tabs", ScrollableTabs);
