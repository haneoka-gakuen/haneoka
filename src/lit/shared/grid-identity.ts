import { html, nothing, type TemplateResult } from "lit";

export type GridIdentityAdornment = TemplateResult | typeof nothing;

/**
 * The shared information contract for every content grid tile.
 *
 * Media proportions remain owned by each catalogue. Text does not: a title may
 * occupy two lines and exactly one contextual description row follows it.
 */
export function renderGridIdentity(
  title: unknown,
  description: string | null = "",
  adornment: GridIdentityAdornment = nothing,
): TemplateResult {
  return html`
    <span class="grid-tile-identity">
      <strong class="grid-tile-identity__title">${title}</strong>
      ${
        description === null
          ? nothing
          : html`
              <small class="grid-tile-identity__description">
                ${adornment}
                <span>${description || "\u00a0"}</span>
              </small>
            `
      }
    </span>
  `;
}
