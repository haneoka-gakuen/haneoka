import { html, nothing } from "lit";
import { live } from "lit/directives/live.js";
import "@material/web/checkbox/checkbox.js";
import { tile, tileMedia, type TileOptions } from "./tile";
import { rovingKeydown } from "./controls";
import { chooserHeader, chooserFilters } from "./chooser-filters";

/** Native chooser dialog, matching the stamp selector above the app shell. */
export function selectionPane(options: {
  id: string;
  title: string;
  closeLabel: string;
  close: () => void;
  searchLabel: string;
  filterLabel: string;
  filtersOpen: boolean;
  toggleFilters: () => void;
  query: string;
  search: (value: string) => void;
  filters: unknown;
  /** Stamp-style chip groups; existing other callers may still supply fields. */
  filterLayout?: "facets" | "fields";
  kind: "member" | "support" | "song" | "system";
  items: ReadonlyArray<TileOptions & { value: string; disabled?: boolean }>;
  /** Keeps unavailable choices visible with the native disabled state. */
  disabled?: boolean;
  selected: string;
  /** Multi-select uses native checkboxes; ordinary choosers retain tab navigation. */
  selectedValues?: ReadonlySet<string>;
  select: (value: string) => void;
  countLabel: string;
  emptyLabel: string;
  /** Optional source paging for other tools. Team pickers pass the full domain. */
  moreLabel?: string;
  more?: () => void;
  preview: unknown;
}) {
  const previewId = `${options.id}-preview`;
  const selectedVisible = options.items.some((item) => item.value === options.selected);
  return html`
    <dialog
      class="selection-pane"
      aria-label=${options.title}
      @cancel=${(event: Event) => {
        event.preventDefault();
        options.close();
      }}
      @click=${(event: MouseEvent) => {
        if (event.target === event.currentTarget) options.close();
      }}
    >
      ${chooserHeader({ title: options.title, filterLabel: options.filterLabel, filtersOpen: options.filtersOpen,
        toggleFilters: options.toggleFilters, closeLabel: options.closeLabel, close: options.close })}
      ${chooserFilters(options.filtersOpen, options.filterLayout === "facets" ? options.filters : html`<div class="chooser-facet"><div class="team-builder__fields" aria-label=${options.filterLabel}>${options.filters}</div></div>`)}
      <div class="selection-pane__body">
        <md-outlined-text-field
          type="search"
          label=${options.searchLabel}
          .value=${live(options.query)}
          @input=${(event: Event) => options.search((event.currentTarget as HTMLInputElement).value)}
        ></md-outlined-text-field>
        <p role="status" class="team-builder__hint">${options.countLabel}</p>
        <div
          class=${`collection collection--${options.kind}`}
          role=${options.selectedValues ? "group" : "tablist"}
          aria-label=${options.title}
          @keydown=${options.selectedValues ? nothing : rovingKeydown(
            options.items.map((item) => item.value),
            options.selected,
            options.select,
          )}
        >
          ${options.items.map((item, index) => options.selectedValues ? html`
            <label class=${`tile tile--${item.kind ?? options.kind} selection-pane__choice${options.selectedValues.has(item.value) ? " is-selected" : ""}`} style=${item.style || nothing}>
              <span class="selection-pane__choice-media">
                ${tileMedia(item)}
                <md-checkbox class="selection-pane__choice-checkbox" touch-target="wrapper" ?disabled=${options.disabled || item.disabled} .checked=${live(options.selectedValues.has(item.value))} aria-label=${item.label}
                  @change=${() => { if (!options.disabled && !item.disabled) options.select(item.value); }}></md-checkbox>
              </span>
              <span class="tile__identity">
                <strong class="tile__title" lang=${item.titleLanguage || nothing}>${item.title}</strong>
                ${item.subtitle === undefined || item.subtitle === null ? nothing : html`<small class="tile__subtitle">${item.adornment ?? nothing}<span>${item.subtitle}</span></small>`}
              </span>
            </label>` : tile({
              ...item,
              selected: item.value === options.selected,
              role: "tab",
              controls: previewId,
              tabIndex: item.value === options.selected || (!selectedVisible && index === 0) ? 0 : -1,
              onOpen: () => options.select(item.value),
            }),
          )}
        </div>
        ${
          !options.items.length
            ? html`
                <p>${options.emptyLabel}</p>
              `
            : nothing
        }
        ${options.more ? html`<button class="button button--text" @click=${options.more}>${options.moreLabel ?? "More"}</button>` : nothing}
      </div>
      <footer class="selection-pane__footer">
        <div id=${previewId} role=${options.selectedValues ? "group" : "tabpanel"} class="team-builder__picker-preview">${options.preview}</div>
      </footer>
    </dialog>
  `;
}
