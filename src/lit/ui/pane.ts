import { html, nothing, type TemplateResult } from "lit";
import { trapFocus } from "../../lib/overlay";
import { iconButton } from "./controls";

/**
 * Detail pane.
 *
 * Material's list-detail layout: on medium and expanded windows the detail is
 * a side sheet docked to the trailing edge of the content pane; on compact it
 * is a full-screen dialog. Both are modal, both are labelled by their own
 * heading, both trap focus and close on Escape — enforced here rather than
 * re-implemented per resource.
 */

export interface PaneOptions {
  /** Heading. `title` is the entity, `subtitle` its supporting line. */
  title: unknown;
  subtitle?: unknown;
  /** Presentation hook: `.sheet--detail-{kind}`. */
  kind?: string;
  open: boolean;
  compact: boolean;
  backLabel: string;
  onClose: () => void;
  /** Leading emblem (rarity, attribute, band). */
  leading?: unknown;
  /** Trailing header actions. */
  actions?: unknown;
  body: unknown;
  footer?: unknown;
  /** id used for aria-labelledby wiring. */
  id?: string;
  style?: string;
}

export function renderPane(options: PaneOptions): TemplateResult {
  const headingId = `${options.id || "detail"}-title`;
  const classes = [
    "sheet",
    options.compact ? "sheet--full" : "sheet--side sheet--detail",
    options.kind ? `sheet--detail-${options.kind}` : "",
    options.open ? "is-open" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return html`
    <aside
      class=${classes}
      role="dialog"
      aria-modal="true"
      aria-labelledby=${headingId}
      ?inert=${!options.open}
      tabindex="-1"
      data-detail-pane
      style=${options.style || nothing}
    >
      <header class="sheet__header">
        ${iconButton({
          label: options.backLabel,
          icon: options.compact ? "arrow_back" : "close",
          onClick: options.onClose,
        })}
        <span class="sheet__title" id=${headingId}>
          <strong>${options.title}</strong>
          ${
            options.subtitle
              ? html`
                  <small>${options.subtitle}</small>
                `
              : nothing
          }
        </span>
        <span class="sheet__actions">${options.leading ?? nothing}${options.actions ?? nothing}</span>
      </header>
      <div class="sheet__body">${options.body}</div>
      ${
        options.footer
          ? html`
              <footer class="sheet__footer">${options.footer}</footer>
            `
          : nothing
      }
    </aside>
    ${
      options.open && !options.compact
        ? html`
            <button
              class="scrim sheet-scrim"
              type="button"
              aria-label=${options.backLabel}
              @click=${options.onClose}
            ></button>
          `
        : nothing
    }
  `;
}

/**
 * Keeps focus inside whichever overlay is currently open.
 * A component owns one of these and calls sync() from updated().
 */
export class PaneFocus {
  private release?: () => void;
  private current?: HTMLElement;

  /** Attach to `root` (or detach when it is null / closed). */
  sync(root: HTMLElement | null, onDismiss: () => void) {
    if (!root) {
      this.detach();
      return;
    }
    if (this.current === root) return;
    this.detach();
    this.current = root;
    this.release = trapFocus(root, { onDismiss });
  }

  detach() {
    this.release?.();
    this.release = undefined;
    this.current = undefined;
  }
}

/**
 * Section heading inside a pane, with an emblem and an optional count.
 * `emblem` is an already-rendered 20dp icon, because the sprite builder only
 * sees icon names written as literals at the call site.
 */
export function paneSection(
  label: unknown,
  emblem: unknown,
  body: unknown,
  count?: number,
  level: 2 | 3 = 2,
): TemplateResult {
  const heading = html`
    <span class="detail-section-title__icon">${emblem}</span>
    <span class="detail-section-title__label">${label}</span>
    ${
      count === undefined
        ? nothing
        : html`
            <span class="detail-section-title__count">${count}</span>
          `
    }
  `;
  return html`
    <section class="detail-section">
      ${
        level === 2
          ? html`
              <h2 class="detail-section-title detail-section-title--h2">${heading}</h2>
            `
          : html`
              <h3 class="detail-section-title">${heading}</h3>
            `
      }
      ${body}
    </section>
  `;
}
