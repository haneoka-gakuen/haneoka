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
import { render, type TemplateResult } from "lit";

const SLOT = "[data-top-app-bar-actions]";

const slot = () => document.querySelector<HTMLElement>(SLOT);

function container(owner: string, create: boolean): HTMLElement | null {
  const host = slot();
  if (!host) return null;
  const existing = host.querySelector<HTMLElement>(`[data-app-bar-owner="${owner}"]`);
  if (existing || !create) return existing;
  const node = document.createElement("div");
  node.dataset.appBarOwner = owner;
  node.className = "top-app-bar__group";
  host.append(node);
  return node;
}

/** Renders (or re-renders) this owner's actions into the app bar. */
export function setAppBarActions(owner: string, content: TemplateResult) {
  const node = container(owner, true);
  if (node) render(content, node);
}

/** Removes this owner's actions. Safe to call when nothing was rendered. */
export function clearAppBarActions(owner: string) {
  const node = container(owner, false);
  if (!node) return;
  render(undefined, node);
  node.remove();
}
