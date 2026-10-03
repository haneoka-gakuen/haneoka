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
}

let searchGeneration = 0;
let searchInputGeneration = 0;

const slot = () => document.querySelector<HTMLElement>(SLOT);

function container(owner: string, create: boolean): HTMLElement | null {
  const host = slot();
  if (!host) return null;
  const existing = host.querySelector<HTMLElement>(`[data-app-bar-owner="${owner}"]`);
  if (existing || !create) return existing ?? null;
  const node = document.createElement("div");
  node.dataset.appBarOwner = owner;
  node.className = "top-app-bar__group";
  host.append(node);
  return node;
}

function identityContainer(owner: string, create: boolean): HTMLElement | null {
  const host = document.querySelector<HTMLElement>(IDENTITY_SLOT);
  if (!host) return null;
  const existing = host.querySelector<HTMLElement>(`[data-app-bar-owner="${owner}"]`);
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
  const existing = [...host.querySelectorAll<HTMLElement>(SEARCH_SLOT)].find(
    (node) => node.dataset.appBarSearchOwner === owner,
  );
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
  render(
    html`
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
          aria-label=${options.label}
          @click=${() => {
            renderSearch(node, options, true);
            queueMicrotask(() => node.querySelector<HTMLInputElement>("input")?.focus());
          }}
        >
          ${icon("search", 24)}
        </button>
        <label class="top-app-bar__search-field" for=${inputId}>
          ${icon("search", 20)}
          <span class="sr-only">${options.label}</span>
          <input
            id=${inputId}
            type="search"
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
          aria-label=${options.closeLabel ?? clientText(document.documentElement.dataset.locale || "en", "close", "Close")}
          @click=${close}
        >
          ${icon("close", 24)}
        </button>
      </form>
    `,
    node,
  );
}

/** Renders (or re-renders) this owner's actions into the app bar. */
export function setAppBarActions(owner: string, content: TemplateResult, context?: object) {
  const node = container(owner, true);
  if (node) render(content, node, { host: context });
}

/** Renders an entity's non-interactive identity marks between Back and title. */
export function setAppBarIdentity(owner: string, content: TemplateResult, context?: object) {
  const node = identityContainer(owner, true);
  if (node) render(content, node, { host: context });
}

/** Removes this owner's identity marks without affecting the action row. */
export function clearAppBarIdentity(owner: string) {
  const node = identityContainer(owner, false);
  if (!node) return;
  render(undefined, node);
  node.remove();
}

/** Removes this owner's actions. Safe to call when nothing was rendered. */
export function clearAppBarActions(owner: string) {
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
export function setAppBarSearch(owner: string, options: AppBarSearchOptions): () => void {
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
  searchContainer(owner, false)?.remove();
}
