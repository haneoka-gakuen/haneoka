import { html, nothing, type TemplateResult } from "lit";
import { icon } from "./icon";
import { iconButton } from "./controls";

/**
 * The browse screen.
 *
 * One layout for every filtered collection on the site. It renders:
 *   · a sticky bar carrying the result count, the view and density switches,
 *     any page-specific actions, and the filter toggle with a count badge;
 *   · a row of removable chips for every applied filter;
 *   · the results;
 *   · the filter panel — a modal side sheet at every size.
 *
 * The count is a live region, so changing a filter is announced instead of
 * silently rearranging several thousand rows.
 */

export interface BrowseFilters {
  label: string;
  open: boolean;
  /** Number of applied facet values; shown as a badge on the toggle. */
  count: number;
  closeLabel: string;
  resetLabel: string;
  onOpen: () => void;
  onClose: () => void;
  onReset?: () => void;
  body: unknown;
}

export interface BrowseOptions {
  /** Presentation key, used for the `.browse--{kind}` hook. */
  kind?: string;
  /** Inline custom properties for the results area (tile ratio, accents). */
  style?: string;
  count: { value: number | null; label: string };
  /** Segmented switches (view, density) and page actions, in bar order. */
  controls?: unknown;
  applied?: unknown;
  results: unknown;
  filters?: BrowseFilters;
}

export function renderBrowse(options: BrowseOptions): TemplateResult {
  const { filters } = options;
  const open = Boolean(filters?.open);
  const classes = ["browse", options.kind ? `browse--${options.kind}` : ""].filter(Boolean).join(" ");
  return html`
    <section class=${classes} style=${options.style || nothing}>
      <div class="browse__main">
        <div class="browse__bar">
          <p class="browse__count" role="status" aria-live="polite">
            <strong>${options.count.value === null ? "—" : options.count.value.toLocaleString()}</strong>
            <span>${options.count.label}</span>
          </p>
          <span class="row__spacer"></span>
          ${options.controls}
          ${
            filters
              ? iconButton({
                  label: filters.label,
                  icon: "filter_alt",
                  onClick: () => (filters.open ? filters.onClose() : filters.onOpen()),
                  pressed: filters.open,
                  toggle: true,
                  badge: filters.count,
                  className: "browse__filter-toggle",
                })
              : nothing
          }
        </div>
        ${
          options.applied
            ? html`
                <div class="browse__applied">${options.applied}</div>
              `
            : nothing
        }
        <div class="browse__results" style=${options.style || nothing}>${options.results}</div>
      </div>
      ${
        filters
          ? html`
              <aside
                class=${`browse__filters sheet sheet--side ${filters.open ? "is-open" : ""}`}
                role="dialog"
                aria-modal="true"
                aria-label=${filters.label}
                ?inert=${!filters.open}
                tabindex="-1"
              >
                <header class="sheet__header">
                  <span class="detail-section-title__icon">${icon("filter_alt", 20)}</span>
                  <span class="sheet__title"><strong>${filters.label}</strong></span>
                  <span class="sheet__actions">
                    ${
                      filters.count && filters.onReset
                        ? html`
                            <button class="button button--text" type="button" @click=${filters.onReset}>
                              ${filters.resetLabel}
                            </button>
                          `
                        : nothing
                    }
                    ${iconButton({
                      label: filters.closeLabel,
                      icon: "close",
                      onClick: filters.onClose,
                      className: "browse__filters-close",
                    })}
                  </span>
                </header>
                <div class="browse__filters-body">${filters.body}</div>
              </aside>
            `
          : nothing
      }
    </section>
    ${
      open
        ? html`
            <button
              class="scrim sheet-scrim"
              type="button"
              aria-label=${filters?.closeLabel}
              @click=${filters?.onClose}
            ></button>
          `
        : nothing
    }
  `;
}

/** A titled group of controls inside the filter panel. */
export function filterGroup(label: string, body: unknown, trailing?: unknown): TemplateResult {
  return html`
    <section class="browse__filter-group">
      <h3>${label}${trailing ?? nothing}</h3>
      ${body}
    </section>
  `;
}
