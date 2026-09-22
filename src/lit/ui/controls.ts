import { html, nothing, type TemplateResult } from "lit";
import { icon } from "./icon";

/**
 * Control renderers.
 *
 * These exist so a toggle, a segmented switch or a filter chip is built the
 * same way in all fourteen workspaces — including the ARIA that is easy to
 * forget by hand. Every segmented group gets role="group"; every toggle gets
 * aria-pressed; every icon-only control gets a label.
 */

export interface IconButtonOptions {
  label: string;
  icon: string;
  onClick: (event: MouseEvent) => void;
  variant?: "standard" | "filled" | "tonal" | "outlined";
  pressed?: boolean;
  toggle?: boolean;
  disabled?: boolean;
  size?: number;
  badge?: number;
  className?: string;
}

export function iconButton(options: IconButtonOptions): TemplateResult {
  const classes = [
    "icon-button",
    options.variant && options.variant !== "standard" ? `icon-button--${options.variant}` : "",
    options.toggle ? "icon-button--toggle" : "",
    options.className || "",
  ]
    .filter(Boolean)
    .join(" ");
  const button = html`
    <button
      class=${classes}
      type="button"
      aria-label=${options.label}
      title=${options.label}
      aria-pressed=${options.pressed === undefined ? nothing : String(options.pressed)}
      ?disabled=${options.disabled}
      @click=${options.onClick}
    >
      ${icon(options.icon, options.size ?? 24)}
    </button>
  `;
  // A badge must not be a sibling in a flex row — it belongs on the control.
  return options.badge
    ? html`
        <span class="badge-anchor">
          ${button}
          <span class="badge" aria-hidden="true">${options.badge > 99 ? "99+" : options.badge}</span>
        </span>
      `
    : button;
}

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
  icon?: string;
}

/**
 * Arrow-key navigation for a single-select composite (radiogroup, tablist).
 *
 * ARIA requires these to be one tab stop with arrow keys moving between the
 * options — a row of buttons each taking their own tab stop is a different
 * widget, and that is what the site had. Returns a keydown handler for the
 * container; the selected option keeps tabindex="0" and the rest -1.
 */
export function rovingKeydown<T>(values: ReadonlyArray<T>, current: T, onSelect: (value: T) => void) {
  return (event: KeyboardEvent) => {
    const step: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
    const index = Math.max(0, values.indexOf(current));
    const next =
      event.key in step
        ? (index + step[event.key] + values.length) % values.length
        : event.key === "Home"
          ? 0
          : event.key === "End"
            ? values.length - 1
            : -1;
    if (next < 0 || next === index) return;
    event.preventDefault();
    const container = event.currentTarget as HTMLElement;
    onSelect(values[next]);
    // The container re-renders on selection; move focus once it has.
    requestAnimationFrame(() => container.querySelectorAll<HTMLElement>("[role]")[next]?.focus());
  };
}

export interface SegmentedOptions<T extends string> {
  label: string;
  value: T;
  options: ReadonlyArray<SegmentOption<T>>;
  onSelect: (value: T) => void;
  /** Icon-only segments keep their label in the accessibility tree. */
  iconOnly?: boolean;
  grow?: boolean;
}

/**
 * Single-select segmented button. Material models this as a radio group, so
 * that is what it renders — not a row of bare <button>s with aria-pressed,
 * which is what the catalog view switch used to be.
 */
export function segmented<T extends string>(options: SegmentedOptions<T>): TemplateResult {
  const classes = ["segmented", options.iconOnly ? "segmented--icon" : "", options.grow ? "segmented--grow" : ""]
    .filter(Boolean)
    .join(" ");
  return html`
    <div
      class=${classes}
      role="radiogroup"
      aria-label=${options.label}
      @keydown=${rovingKeydown(
        options.options.map((option) => option.value),
        options.value,
        options.onSelect,
      )}
    >
      ${options.options.map(
        (option) => html`
          <button
            type="button"
            role="radio"
            aria-checked=${String(option.value === options.value)}
            aria-label=${options.iconOnly ? option.label : nothing}
            title=${options.iconOnly ? option.label : nothing}
            tabindex=${option.value === options.value ? "0" : "-1"}
            @click=${() => options.onSelect(option.value)}
          >
            ${option.icon ? icon(option.icon, 20) : nothing}
            ${
              options.iconOnly
                ? nothing
                : html`
                    <span>${option.label}</span>
                  `
            }
          </button>
        `,
      )}
    </div>
  `;
}

export interface FilterChipOptions {
  label: string;
  selected: boolean;
  onToggle: () => void;
  /** 24dp leading avatar: band logo, character portrait, rarity mark. */
  image?: string;
  count?: number;
}

/**
 * Material filter chip. The label is always rendered — an avatar is a
 * *leading element*, not a replacement for the name of the thing.
 */
export function filterChip(options: FilterChipOptions): TemplateResult {
  return html`
    <button
      class="chip"
      type="button"
      role="checkbox"
      aria-checked=${String(options.selected)}
      @click=${options.onToggle}
    >
      ${
        options.selected
          ? icon("check", 18)
          : options.image
            ? html`
                <span class="chip__avatar"><img src=${options.image} alt="" loading="lazy" decoding="async" /></span>
              `
            : nothing
      }
      <span class="chip__label">${options.label}</span>
      ${
        options.count === undefined
          ? nothing
          : html`
              <span class="chip__count">${options.count}</span>
            `
      }
    </button>
  `;
}

/** Removable chip for the applied-filter row. */
export function inputChip(label: string, removeLabel: string, onRemove: () => void): TemplateResult {
  return html`
    <button class="chip chip--input" type="button" @click=${onRemove} aria-label=${`${removeLabel}: ${label}`}>
      <span class="chip__label">${label}</span>
      <span class="chip__remove">${icon("close", 18)}</span>
    </button>
  `;
}
