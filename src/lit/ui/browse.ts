import { html, nothing, type TemplateResult } from "lit";
import { clearAppBarActions, setAppBarActions } from "../../lib/app-bar";
import { icon } from "./icon";
import { iconButton, rovingKeydown } from "./controls";
import { tile } from "./tile";

/**
 * The browse screen.
 *
 * One layout for every filtered collection on the site. It renders:
 *   · an optional pane rail: the collection's primary axis, as artwork;
 *   · a sticky bar carrying the result count, the view and density switches,
 *     any page-specific actions, and the filter toggle with a count badge;
 *   · an optional heading naming what the rail has selected;
 *   · a row of removable chips for every applied filter;
 *   · the results;
 *   · the filter panel — a modal side sheet at every size.
 *
 * The count is a live region, so changing a filter is announced instead of
 * silently rearranging several thousand rows.
 */

/** One destination in the pane rail. */
export interface BrowseRailItem {
  value: string;
  label: string;
  image?: string;
  /** Second line: an episode count, a band, a chapter number. */
  meta?: string;
}

/**
 * The pane rail: the one axis a collection is primarily organised by, shown
 * as artwork beside the results. Chapters for a story section, bands for the
 * character and instrument rosters.
 *
 * Material's canonical layouts call this a supporting pane, and that is what
 * it is — a persistent companion to the pane it controls, not a second set of
 * top-level destinations. It is a tablist, because choosing an item switches
 * what the region beside it shows; the results region carries the id the tabs
 * point at. An axis owned by the rail is *removed* from the filter sheet, so
 * there is never a rail and a facet competing for the same choice.
 */
export interface BrowseRail {
  label: string;
  value: string;
  items: ReadonlyArray<BrowseRailItem>;
  onSelect: (value: string) => void;
}

/**
 * The heading: what the rail has selected, named. A collection of episodes is
 * unreadable without it — "42 results" says nothing about which chapter's 42.
 */
export interface BrowseHeading {
  title: string;
  /** The subject's own description, where it has one. Never UI instructions. */
  supporting?: string;
  image?: string;
}

/** The results region, which the rail's tabs control. */
const RESULTS_ID = "browse-results";
/** app-bar.ts owner id for the collection's controls. */
const BROWSE_OWNER = "browse";

/** Every screen that renders a browse must drop its controls on teardown. */
export function clearBrowseBar() {
  clearAppBarActions(BROWSE_OWNER);
}

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
  rail?: BrowseRail;
  heading?: BrowseHeading;
  applied?: unknown;
  results: unknown;
  filters?: BrowseFilters;
}

/** The rail, as a one-column collection of tiles in a tablist. */
function renderRail(rail: BrowseRail): TemplateResult {
  return html`
    <nav
      class="browse__rail"
      role="tablist"
      aria-label=${rail.label}
      aria-orientation="vertical"
      @keydown=${rovingKeydown(
        rail.items.map((item) => item.value),
        rail.value,
        rail.onSelect,
      )}
    >
      <div class="collection collection--rail">
        ${rail.items.map((item) => {
          const selected = item.value === rail.value;
          return tile({
            kind: "rail",
            title: item.label,
            subtitle: item.meta ?? null,
            label: item.label,
            image: item.image || "",
            placeholder: icon("image", 24),
            selected,
            role: "tab",
            controls: RESULTS_ID,
            tabIndex: selected ? 0 : -1,
            onOpen: () => rail.onSelect(item.value),
          });
        })}
      </div>
    </nav>
  `;
}

/**
 * The collection's own controls, for the top app bar's trailing section.
 *
 * These used to sit in a sticky bar of their own at the top of the pane,
 * directly under the app bar — two bars, one on top of the other, and the
 * second one costing 56dp of every page before a single result. Material puts
 * a screen's controls in the top app bar, so that is where they go: the count
 * first (a live region, so filtering is announced rather than silently
 * rearranging several thousand rows), then the view switch and any page
 * actions, then the filter toggle with its badge.
 */
export function browseBar(options: BrowseOptions): TemplateResult {
  const { filters } = options;
  return html`
    <p class="browse__count" role="status" aria-live="polite">
      <strong>${options.count.value === null ? "—" : options.count.value.toLocaleString()}</strong>
      <span>${options.count.label}</span>
    </p>
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
  `;
}

export function renderBrowse(options: BrowseOptions): TemplateResult {
  const { filters, rail, heading } = options;
  const open = Boolean(filters?.open);
  // The bar lives in the shell's app bar, not in the pane.
  setAppBarActions(BROWSE_OWNER, browseBar(options));
  // A rail of one is not a choice, so it is not drawn.
  const railed = Boolean(rail && rail.items.length > 1);
  const classes = ["browse", options.kind ? `browse--${options.kind}` : "", railed ? "browse--railed" : ""]
    .filter(Boolean)
    .join(" ");
  return html`
    <section class=${classes} style=${options.style || nothing}>
      ${railed && rail ? renderRail(rail) : nothing}
      <div class="browse__main">
        ${
          heading
            ? html`
                <header class="browse__heading">
                  ${
                    heading.image
                      ? html`
                          <img class="browse__heading-art" src=${heading.image} alt="" loading="lazy" />
                        `
                      : nothing
                  }
                  <div class="browse__heading-copy">
                    <h2>${heading.title}</h2>
                    ${
                      heading.supporting
                        ? html`
                            <p>${heading.supporting}</p>
                          `
                        : nothing
                    }
                  </div>
                </header>
              `
            : nothing
        }
        ${
          options.applied
            ? html`
                <div class="browse__applied">${options.applied}</div>
              `
            : nothing
        }
        <div
          class="browse__results"
          id=${RESULTS_ID}
          role=${railed ? "tabpanel" : nothing}
          style=${options.style || nothing}
        >
          ${options.results}
        </div>
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
