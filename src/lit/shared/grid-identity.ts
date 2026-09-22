import { html, nothing, type TemplateResult } from "lit";

export type GridIdentityAdornment = TemplateResult | typeof nothing;

/**
 * The text half of a collection tile: a title of at most two lines, then
 * exactly one contextual line under it.
 *
 * Media proportions stay owned by each resource; text does not. Passing
 * `null` as the description drops the second line entirely; passing `""`
 * keeps its height, so a grid of tiles holds its baseline whether or not
 * every entry has a subtitle.
 *
 * This renders the same classes as `ui/tile.ts` so there is one vocabulary
 * (and one set of rules) for tile text across the site.
 */
export function renderGridIdentity(
  title: unknown,
  description: string | null = "",
  adornment: GridIdentityAdornment = nothing,
): TemplateResult {
  return html`
    <span class="tile__identity">
      <strong class="tile__title">${title}</strong>
      ${
        description === null
          ? nothing
          : html`
              <small class="tile__subtitle">
                ${adornment}
                <span>${description || "\u00a0"}</span>
              </small>
            `
      }
    </span>
  `;
}
