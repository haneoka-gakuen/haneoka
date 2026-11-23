// L3 — GEB
// Input: 来源元素、页面搜索、操作、身份及 SSR 捕获上下文。
// Output: 应用栏更新／清理接口与构建期捕获结果。
// Pos: [Map](L2-2.md)；AppShell 与工作区之间的应用栏协作。
// Effects/Dependencies: 在来源所属的壳渲染；Lit 宿主断开时释放其节点；SSR 捕获走独立上下文。
import { html, nothing, render, type ReactiveControllerHost, type TemplateResult } from "lit";
import { AsyncDirective, directive, type ElementPart } from "lit/async-directive.js";
import { icon } from "../lit/ui/icon";
import { clientText } from "../i18n/client";

const ACTIONS_SLOT = "[data-top-app-bar-actions]";
const IDENTITY_SLOT = "[data-top-app-bar-identity]";
const SEARCH_SLOT = "[data-app-bar-search]";

export interface AppBarSearchOptions {
  value: string;
  label: string;
  onInput: (value: string) => void;
  onSubmit?: (value: string) => void;
  closeLabel?: string;
  expanded?: boolean;
}

export interface StaticAppBarTemplates {
  actions: Map<string, TemplateResult>;
  identity: Map<string, TemplateResult>;
  search: Map<string, { inputId: string; content: TemplateResult; expanded: boolean }>;
  locale: string;
}
let staticAppBar: StaticAppBarTemplates | undefined;
export function captureAppBar<T>(locale: string, renderPage: () => T): { result: T; bar: StaticAppBarTemplates } {
  const previous = staticAppBar;
  const bar: StaticAppBarTemplates = { actions: new Map(), identity: new Map(), search: new Map(), locale };
  staticAppBar = bar;
  try { return { result: renderPage(), bar }; } finally { staticAppBar = previous; }
}
export const appBarOwnerKind = (owner: string) => owner.replace(/-\d+$/u, "");

export function appBarElement(source: Element): HTMLElement | null {
  if (!source.isConnected) return null;
  return source.closest("[data-shell]")?.querySelector<HTMLElement>("[data-top-app-bar]") ?? null;
}

const groups = {
  actions: { slot: ACTIONS_SLOT, attribute: "data-app-bar-owner", className: "top-app-bar__group" },
  identity: { slot: IDENTITY_SLOT, attribute: "data-app-bar-owner", className: "top-app-bar__identity-group" },
  search: { slot: ACTIONS_SLOT, attribute: "data-app-bar-search-owner", className: "top-app-bar__search-group" },
};
type Group = keyof typeof groups;
type AppBarSource = Element & Partial<ReactiveControllerHost>;

const sources = new WeakMap<Element, Map<string, HTMLElement>>();
let searchGeneration = 0;
let searchInputGeneration = 0;

function removeGroup(node: HTMLElement) {
  render(undefined, node, { isConnected: node.isConnected });
  node.remove();
}

function staticGroup(slot: HTMLElement, owner: string, attribute: string): HTMLElement | undefined {
  const candidates = [...slot.querySelectorAll<HTMLElement>(`[data-app-bar-static][${attribute}]`)];
  return candidates.find(node => node.getAttribute(attribute) === owner) ??
    candidates.find(node => node.dataset.appBarOwnerKind === appBarOwnerKind(owner));
}

function container(source: AppBarSource, owner: string, group: Group): HTMLElement | undefined {
  const { slot, attribute, className } = groups[group];
  const host = appBarElement(source)?.querySelector<HTMLElement>(slot);
  if (!host) return;
  let owned = sources.get(source);
  if (!owned) {
    const nodes = new Map<string, HTMLElement>();
    sources.set(source, nodes);
    source.addController?.({
      hostDisconnected() {
        for (const node of nodes.values()) removeGroup(node);
        nodes.clear();
      },
    });
    owned = nodes;
  }
  const key = `${group}:${owner}`;
  const current = owned.get(key);
  if (current && host.contains(current)) return current;
  if (current) removeGroup(current);

  const initial = staticGroup(host, owner, attribute);
  const node = initial ?? host.ownerDocument.createElement("div");
  if (initial) {
    node.replaceChildren();
    node.removeAttribute("data-app-bar-static");
  }
  node.setAttribute(attribute, owner);
  node.className = className;
  if (group === "search") node.dataset.appBarSearch = "true";
  owned.set(key, node);
  if (!initial) {
    if (group === "search") host.prepend(node);
    else host.append(node);
  }
  return node;
}

function clearGroup(source: Element, owner: string, group: Group) {
  const owned = sources.get(source);
  const key = `${group}:${owner}`;
  const node = owned?.get(key);
  if (owned && node) {
    owned.delete(key);
    removeGroup(node);
  } else {
    const { slot, attribute } = groups[group];
    const host = appBarElement(source)?.querySelector<HTMLElement>(slot);
    if (host) staticGroup(host, owner, attribute)?.remove();
  }
}

function renderSearch(node: HTMLElement, options: AppBarSearchOptions, forceExpanded?: boolean): void {
  const expanded = forceExpanded ?? node.dataset.searchExpanded === "true";
  node.dataset.searchExpanded = String(expanded);
  const inputId = (node.dataset.searchInputId ??= `app-bar-search-${++searchInputGeneration}`);
  const close = () => {
    const value = node.querySelector<HTMLInputElement>("input")?.value ?? options.value;
    renderSearch(node, { ...options, value }, false);
    node.querySelector<HTMLButtonElement>(".top-app-bar__search-toggle")?.focus();
  };
  render(searchContent(options, inputId, expanded, () => {
    renderSearch(node, options, true);
    queueMicrotask(() => node.querySelector<HTMLInputElement>("input")?.focus());
  }, close), node);
}

function searchContent(options: AppBarSearchOptions, inputId: string, expanded: boolean, open: () => void, close: () => void): TemplateResult {
  return html`
      <form
        class="top-app-bar__search"
        role="search"
        data-search-expanded=${expanded}
        @keydown=${(event: KeyboardEvent) => {
          if (event.key !== "Escape" || !expanded) return;
          event.preventDefault();
          event.stopPropagation();
          close();
        }}
        @submit=${(event: SubmitEvent) => {
          event.preventDefault();
          const input = (event.currentTarget as HTMLFormElement).querySelector<HTMLInputElement>("input");
          options.onSubmit?.(input?.value ?? options.value);
        }}
      >
        <button
          class="icon-button top-app-bar__search-toggle"
          type="button"
          aria-controls=${inputId}
          aria-expanded=${expanded}
          aria-keyshortcuts="/"
          aria-label=${options.label}
          @click=${open}
        >
          ${icon("search", 24)}
        </button>
        <label class="top-app-bar__search-field" for=${inputId}>
          ${icon("search", 20)}
          <span class="sr-only">${options.label}</span>
          <input
            id=${inputId}
            type="search"
            aria-keyshortcuts="/"
            .value=${options.value}
            aria-label=${options.label}
            placeholder=${options.label}
            autocomplete="off"
            @input=${(event: InputEvent) => options.onInput((event.target as HTMLInputElement).value)}
          />
        </label>
        <button
          class="icon-button top-app-bar__search-close"
          type="button"
          aria-label=${options.closeLabel ?? clientText(document.documentElement.dataset.locale || "en", "common.actions.close", "Close")}
          @click=${close}
        >
          ${icon("close", 24)}
        </button>
      </form>
    `;
}

/** Renders (or re-renders) this owner's actions into the app bar. */
export function setAppBarActions(source: AppBarSource, owner: string, content: TemplateResult, position?: "leading") {
  if (staticAppBar) {
    if (position === "leading") {
      staticAppBar.actions.delete(owner);
      staticAppBar.actions = new Map([[owner, content], ...staticAppBar.actions]);
    } else staticAppBar.actions.set(owner, content);
    return;
  }
  const node = container(source, owner, "actions");
  if (!node) return;
  if (position === "leading") {
    const player = node.parentElement?.querySelector(":scope > [data-app-bar-player]");
    if (player && player.nextElementSibling !== node) player.after(node);
  }
  render(content, node, { host: source });
}

/** Renders an entity's non-interactive identity marks between Back and title. */
export function setAppBarIdentity(source: AppBarSource, owner: string, content: TemplateResult) {
  if (staticAppBar) { staticAppBar.identity.set(owner, content); return; }
  const node = container(source, owner, "identity");
  if (node) render(content, node, { host: source });
}

/** Removes this owner's identity marks without affecting the action row. */
export function clearAppBarIdentity(source: Element, owner: string) {
  if (staticAppBar) { staticAppBar.identity.delete(owner); return; }
  clearGroup(source, owner, "identity");
}

/** Removes this owner's actions. Safe to call when nothing was rendered. */
export function clearAppBarActions(source: Element, owner: string) {
  if (staticAppBar) { staticAppBar.actions.delete(owner); return; }
  clearGroup(source, owner, "actions");
}

/**
 * Registers one contextual search surface in the title bar. On compact
 * windows only the icon is shown until it is activated; the input is never
 * rendered in page content. The returned disposer is generation-safe, so an
 * old component cannot clear a newer registration using the same owner id.
 */
/** "/" opens the page's title-bar search from anywhere outside a text field. */
function installSearchShortcut() {
  if (shortcutInstalled) return;
  shortcutInstalled = true;
  document.addEventListener("keydown", (event) => {
    if (event.key !== "/" || event.ctrlKey || event.metaKey || event.altKey || event.defaultPrevented) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest("input, textarea, select, [contenteditable=''], [contenteditable='true'], dialog[open]")) return;
    const search = document.querySelector(`${ACTIONS_SLOT} ${SEARCH_SLOT}:not([hidden])`);
    const field = search?.querySelector<HTMLInputElement>("input");
    const toggle = search?.querySelector<HTMLButtonElement>(".top-app-bar__search-toggle");
    if (!field && !toggle) return;
    event.preventDefault();
    if (field && field.offsetParent !== null) field.focus();
    else toggle?.click();
  });
}
let shortcutInstalled = false;

export function setAppBarSearch(source: AppBarSource, owner: string, options: AppBarSearchOptions): () => void {
  if (staticAppBar) {
    const bar = staticAppBar, inputId = `app-bar-search-${owner}`;
    const labels = { ...options, closeLabel: options.closeLabel ?? clientText(bar.locale, "common.actions.close", "Close") };
    bar.search.set(owner, { inputId, expanded: options.expanded ?? false,
      content: searchContent(labels, inputId, options.expanded ?? false, () => {}, () => {}) });
    return () => { bar.search.delete(owner); };
  }
  const node = container(source, owner, "search");
  if (!node) return () => {};
  installSearchShortcut();
  const generation = ++searchGeneration;
  node.dataset.appBarSearchGeneration = String(generation);
  renderSearch(node, options);
  return () => {
    if (sources.get(source)?.get(`search:${owner}`) === node && node.dataset.appBarSearchGeneration === String(generation)) {
      clearGroup(source, owner, "search");
    }
  };
}

/** Removes the current search owned by `owner`, if one exists. */
export function clearAppBarSearch(source: Element, owner: string): void {
  if (staticAppBar) { staticAppBar.search.delete(owner); return; }
  clearGroup(source, owner, "search");
}

type Controls = [owner: string, actions: TemplateResult, identity?: TemplateResult];

class AppBarControlsDirective extends AsyncDirective {
  private source?: Element;
  private controls?: Controls;
  private pending = false;

  render(..._controls: Controls) {
    return nothing;
  }

  update(part: ElementPart, controls: Controls) {
    if (this.controls && this.controls[0] !== controls[0]) this.release();
    this.source = part.element;
    this.controls = controls;
    this.schedule();
    return nothing;
  }

  protected disconnected() {
    this.release();
  }

  protected reconnected() {
    this.schedule();
  }

  private release() {
    if (!this.source || !this.controls) return;
    clearAppBarActions(this.source, this.controls[0]);
    clearAppBarIdentity(this.source, this.controls[0]);
  }

  private schedule() {
    if (this.pending) return;
    this.pending = true;
    queueMicrotask(() => {
      this.pending = false;
      if (!this.isConnected || !this.source || !this.controls) return;
      const [owner, actions, identity] = this.controls;
      setAppBarActions(this.source, owner, actions);
      if (identity) setAppBarIdentity(this.source, owner, identity);
      else clearAppBarIdentity(this.source, owner);
    });
  }
}

const controlsDirective = directive(AppBarControlsDirective);

/** Links app bar controls to the lifetime of an element in a Lit template. */
export function appBarControls(owner: string, actions: TemplateResult, identity?: TemplateResult) {
  // Lit SSR skips element directives.
  if (staticAppBar) {
    staticAppBar.actions.set(owner, actions);
    if (identity) staticAppBar.identity.set(owner, identity);
    else staticAppBar.identity.delete(owner);
  }
  return controlsDirective(owner, actions, identity);
}
