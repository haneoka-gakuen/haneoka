import { html, nothing, type TemplateResult } from "lit";
import { icon } from "../ui/icon";

export interface ImportSourceRow {
  glyph: string;
  title: string;
  hint: string;
  onClick?: (event: Event) => void;
  href?: string;
  disabled?: boolean;
  /** Set for a row that opens in place; true while open. */
  expanded?: boolean;
  /** Rendered right after the row: a hidden input, or the opened content. */
  after?: TemplateResult | typeof nothing;
}

/** One way to bring cards in; every import surface lists these the same way. */
export function importSourceRow({ glyph, title, hint, onClick, href, disabled, expanded, after = nothing }: ImportSourceRow) {
  const body = html`
    <span class="list-item__avatar">${icon(glyph, 20)}</span>
    <span class="list-item__body">
      <span class="list-item__headline">${title}</span>
      <span class="list-item__supporting">${hint}</span>
    </span>
    <span class="list-item__trailing">${icon(href ? "open_in_new" : expanded === undefined ? "chevron_right" : expanded ? "expand_less" : "expand_more", 20)}</span>
  `;
  return html`
    <li class="import-source">
      ${href
        ? html`<a class="list-item list-item--two-line list-item--interactive" href=${href} target="_blank" rel="noopener noreferrer">${body}</a>`
        : html`<button class="list-item list-item--two-line list-item--interactive" type="button" ?disabled=${disabled}
            aria-expanded=${expanded ?? nothing} @click=${onClick}>${body}</button>`}
      ${after}
    </li>
  `;
}
