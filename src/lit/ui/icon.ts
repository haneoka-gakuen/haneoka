import { html, type TemplateResult } from "lit";

/**
 * Material Symbols, from the sprite built by scripts/build/icon_sprite.py.
 * That script scans the source for icon-name literals, so every name must be
 * written out at the call site and never assembled from variables.
 */
export function icon(name: string, size = 24): TemplateResult {
  return html`
    <svg class="material-icon" width=${size} height=${size} aria-hidden="true">
      <use href=${`/icons.svg#${name}`}></use>
    </svg>
  `;
}

/** The filled duotone variant the sprite emits for selected navigation. */
export function iconFilled(name: string, size = 24): TemplateResult {
  return html`
    <svg class="material-icon" width=${size} height=${size} aria-hidden="true">
      <use href=${`/icons.svg#${name}-filled`}></use>
    </svg>
  `;
}
