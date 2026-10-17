// L3 — GEB
// Input: 页面搜索、操作、身份和返回状态及 SSR 捕获上下文。
// Output: 应用栏更新／清理接口与构建期捕获结果。
// Pos: [Map](L2-2.md)；AppShell 与工作区之间的应用栏协作。
// Effects/Dependencies: 维护模块状态；浏览器可操作 DOM／事件，SSR 捕获走独立上下文。
/**
 * Top app bar action slot.
 *
 * Material puts a page's own actions in the top app bar's trailing section.
 * Components used to fake that by positioning their toolbar `fixed; top: 0`
 * over the shell, which overlapped the page title whenever the two competed
 * for the same pixels and left stray controls floating during navigation.
 *
 * Instead the shell exposes one real slot ([data-top-app-bar-actions]) and a
 * component renders a Lit template into it, keyed by an owner id so two
 * components can never fight over it and a disconnecting component always
 * removes exactly its own markup.
 */
import { html, render, type TemplateResult } from "lit";
import { icon } from "../lit/ui/icon";
import { clientText } from "../i18n/client";

const SLOT = "[data-top-app-bar-actions]";
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
const ownerKind = (owner: string) => owner.replace(/-\d+$/u, "");
function adoptStaticBar(host: HTMLElement, owner: string, attribute: string, create: boolean): HTMLElement | null {
  const existing = host.querySelector<HTMLElement>(`[${attribute}="${owner}"]`) ||
    (create ? [...host.querySelectorAll<HTMLElement>(`[data-app-bar-static][${attribute}]`)].find(node => node.dataset.appBarOwnerKind === ownerKind(owner)) : null);
  if (!existing) return null;
  if (create && existing.hasAttribute("data-app-bar-static")) {
    existing.replaceChildren();
    existing.removeAttribute("data-app-bar-static");
    existing.setAttribute(attribute, owner);
  }
  return existing;
}

let searchGeneration = 0;
let searchInputGeneration = 0;

const slot = () => typeof document === "undefined" ? null : document.querySelector<HTMLElement>(SLOT);

function container(owner: string, create: boolean): HTMLElement | null {
  const host = slot();
  if (!host) return null;
  const existing = adoptStaticBar(host, owner, "data-app-bar-owner", create);
  if (existing || !create) return existing ?? null;
  const node = document.createElement("div");
  node.dataset.appBarOwner = owner;
  node.className = "top-app-bar__group";
  host.append(node);
  return node;
}

function identityContainer(owner: string, create: boolean): HTMLElement | null {
  const host = typeof document === "undefined" ? null : document.querySelector<HTMLElement>(IDENTITY_SLOT);
  if (!host) return null;
  const existing = adoptStaticBar(host, owner, "data-app-bar-owner", create);
  if (existing || !create) return existing ?? null;
  const node = document.createElement("div");
  node.dataset.appBarOwner = owner;
  node.className = "top-app-bar__identity-group";
  host.append(node);
  return node;
}

function searchContainer(owner: string, create: boolean): HTMLElement | null {
  const host = slot();
  if (!host) return null;
  const existing = adoptStaticBar(host, owner, "data-app-bar-search-owner", create);
  if (existing || !create) return existing ?? null;
  const node = document.createElement("div");
  node.dataset.appBarSearch = "true";
  node.dataset.appBarSearchOwner = owner;
  node.className = "top-app-bar__search-group";
  host.prepend(node);
  return node;
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
export function setAppBarActions(owner: string, content: TemplateResult, context?: object) {
  if (staticAppBar) { staticAppBar.actions.set(owner, content); return; }
  const node = container(owner, true);
  if (node) render(content, node, { host: context });
}

/** Renders an entity's non-interactive identity marks between Back and title. */
export function setAppBarIdentity(owner: string, content: TemplateResult, context?: object) {
  if (staticAppBar) { staticAppBar.identity.set(owner, content); return; }
  const node = identityContainer(owner, true);
  if (node) render(content, node, { host: context });
}

/** Removes this owner's identity marks without affecting the action row. */
export function clearAppBarIdentity(owner: string) {
  if (staticAppBar) { staticAppBar.identity.delete(owner); return; }
  const node = identityContainer(owner, false);
  if (!node) return;
  render(undefined, node);
  node.remove();
}

/** Removes this owner's actions. Safe to call when nothing was rendered. */
export function clearAppBarActions(owner: string) {
  if (staticAppBar) { staticAppBar.actions.delete(owner); return; }
  const node = container(owner, false);
  if (!node) return;
  render(undefined, node);
  node.remove();
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
    const field = slot()?.querySelector<HTMLInputElement>(`${SEARCH_SLOT} input`);
    const toggle = slot()?.querySelector<HTMLButtonElement>(`${SEARCH_SLOT} .top-app-bar__search-toggle`);
    if (!field && !toggle) return;
    event.preventDefault();
    if (field && field.offsetParent !== null) field.focus();
    else toggle?.click();
  });
}
let shortcutInstalled = false;

export function setAppBarSearch(owner: string, options: AppBarSearchOptions): () => void {
  if (staticAppBar) {
    const bar = staticAppBar, inputId = `app-bar-search-${++searchInputGeneration}`;
    const labels = { ...options, closeLabel: options.closeLabel ?? clientText(bar.locale, "common.actions.close", "Close") };
    bar.search.set(owner, { inputId, expanded: options.expanded ?? false,
      content: searchContent(labels, inputId, options.expanded ?? false, () => {}, () => {}) });
    return () => { bar.search.delete(owner); };
  }
  installSearchShortcut();
  const node = searchContainer(owner, true);
  const generation = ++searchGeneration;
  if (node) {
    node.dataset.appBarSearchGeneration = String(generation);
    renderSearch(node, options);
  }
  return () => {
    const current = searchContainer(owner, false);
    if (current?.dataset.appBarSearchGeneration !== String(generation)) return;
    current.remove();
  };
}

/** Removes the current search owned by `owner`, if one exists. */
export function clearAppBarSearch(owner: string): void {
  if (staticAppBar) { staticAppBar.search.delete(owner); return; }
  searchContainer(owner, false)?.remove();
}
