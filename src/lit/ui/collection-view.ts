import { html, nothing } from "lit";
import { uiText } from "../shared/catalog";
import { segmented } from "./controls";
import { icon } from "./icon";
import { nextImageCandidate } from "./lazy-images";

export type CollectionView = "grid" | "list" | "table";
export const collectionView = (value: string | null): CollectionView =>
  value === "list" || value === "table" ? value : "grid";
export const viewSwitch = (locale: string, value: CollectionView, onSelect: (view: CollectionView) => void) =>
  segmented({
    label: uiText(locale, "view"),
    value,
    onSelect,
    iconOnly: true,
    options: [
      { value: "grid", label: uiText(locale, "grid"), icon: "grid_view" },
      { value: "list", label: uiText(locale, "list"), icon: "table_rows" },
      { value: "table", label: uiText(locale, "table"), icon: "view_list" },
    ],
  });
export interface CollectionListEntry {
  id: string;
  title: unknown;
  titleLanguage?: string;
  subtitle: unknown;
  image?: string;
  media?: unknown;
  trailing?: unknown;
  onOpen(): void;
}
export function collectionList(entries: readonly CollectionListEntry[]) {
  return html`
    <ul class="list collection-list">
      ${entries.map(
        (entry) => html`
          <li>
            <button class="list-item list-item--two-line list-item--interactive" type="button" data-open-item=${entry.id} @click=${entry.onOpen}>
              <span class="list-item__leading">
                ${
                  entry.media ??
                  (entry.image
                    ? html`
                        <img data-src=${entry.image} alt="" decoding="async" @error=${nextImageCandidate} />
                      `
                    : icon("image", 24))
                }
              </span>
              <span class="list-item__body">
                <strong class="list-item__headline" lang=${entry.titleLanguage || nothing}>${entry.title}</strong>
                <span class="list-item__supporting">${entry.subtitle || "—"}</span>
              </span>
              <span class="list-item__trailing">${entry.trailing ?? nothing}${icon("chevron_right", 20)}</span>
            </button>
          </li>
        `,
      )}
    </ul>
  `;
}
export function collectionTable(label: string, headers: readonly unknown[], rows: readonly (readonly unknown[])[]) {
  return html`
    <div class="table-scroll" role="region" aria-label=${label} tabindex="0" data-scroll-region>
      <table class="data-table">
        <thead>
          <tr>
            ${headers.map(
              (header, index) => html`
                <th scope="col" class=${index === 0 ? "is-sticky" : ""}>${header}</th>
              `,
            )}
          </tr>
        </thead>
        <tbody>
          ${rows.map(
            (row) => html`
              <tr>
                ${row.map((cell, index) =>
                  index === 0
                    ? html`
                        <th scope="row" class="is-sticky">${cell}</th>
                      `
                    : html`
                        <td>${cell}</td>
                      `,
                )}
              </tr>
            `,
          )}
        </tbody>
      </table>
    </div>
  `;
}
