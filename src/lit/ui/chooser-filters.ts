import { html, nothing } from "lit";
import { filterChip, iconButton } from "./controls";
import "../../styles/components/chooser-filters.css";

/** Shared with the stamp maker: icon chips, labelled groups, one filter drawer. */
export function chooserGroup(label: string, content: unknown) {
  return html`<div class="chooser-facet" role="group" aria-label=${label}>
    <strong>${label}</strong><div class="chooser-filter-options">${content}</div>
  </div>`;
}
export function chooserFacet(options: {
  label: string; allLabel: string; value: string;
  options: readonly { value: string; label: string; image?: string; imageOnly?: boolean }[];
  change: (value: string) => void;
}) {
  return chooserGroup(options.label, html`
    ${filterChip({ label: options.allLabel, selected: !options.value, onToggle: () => options.change("") })}
    ${options.options.map(option => filterChip({ ...option, selected: options.value === option.value,
      onToggle: () => options.change(options.value === option.value ? "" : option.value) }))}
  `);
}
export function chooserFilters(open: boolean, content: unknown) {
  return html`<div class="chooser-filters" ?hidden=${!open}>${content}</div>`;
}
export function chooserHeader(options: {
  title: string; filterLabel: string; filtersOpen: boolean; toggleFilters: () => void;
  closeLabel: string; close: () => void; actions?: unknown;
}) {
  return html`<header class="sheet__header chooser-header"><strong>${options.title}</strong>
    <div class="sheet__actions chooser-header__actions">${options.actions ?? nothing}
      ${iconButton({ label: options.filterLabel, icon: "filter_alt", toggle: true, pressed: options.filtersOpen, onClick: options.toggleFilters })}
      ${iconButton({ label: options.closeLabel, icon: "close", onClick: options.close })}
    </div>
  </header>`;
}
