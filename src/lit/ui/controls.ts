import { html, nothing, type TemplateResult } from "lit";
import { icon } from "./icon";
import { rarityIcon } from "../shared/rarity-icon";
import { focusedValue } from "./focused-value";

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
  shortcut?: string;
  icon: string;
  onClick: (event: MouseEvent) => void;
  variant?: "standard" | "filled" | "tonal" | "outlined";
  pressed?: boolean;
  toggle?: boolean;
  disabled?: boolean;
  size?: number;
  badge?: number;
  className?: string;
  content?: TemplateResult;
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
      title=${options.shortcut ? `${options.label} (${options.shortcut})` : options.label}
      aria-pressed=${options.pressed === undefined ? nothing : String(options.pressed)}
      ?disabled=${options.disabled}
      @click=${options.onClick}
    >
      ${options.content ?? icon(options.icon, options.size ?? 24)}
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

type NumberFieldOptions = {
  label: string;
  ariaLabel?: string;
  min?: number;
  max?: number;
  step?: number | "any";
  suffix?: string;
  disabled?: boolean;
  commitOnChange?: boolean;
  invalid?: boolean;
} & ({ value: number; nullable?: false; onInput(value: number): void } |
  { value: number | null; nullable: true; onInput(value: number | null): void });

/** Material numeric input with a focus-local draft and optional empty value. */
export function numberField(options: NumberFieldOptions): TemplateResult {
  const update = (event: Event, commit: boolean) => {
    const control = event.currentTarget as HTMLElement & { value: string };
    if (!commit && options.commitOnChange) return;
    if (!control.value.trim()) {
      if (options.nullable) options.onInput(null);
      else if (commit) control.value = String(options.value);
      return;
    }
    const parsed = Number(control.value);
    if (!Number.isFinite(parsed)) return;
    const value = Math.min(options.max ?? Infinity, Math.max(options.min ?? -Infinity, parsed));
    options.onInput(value);
    if (commit || value !== parsed) control.value = String(value);
  };
  return html`
    <md-outlined-text-field class="number-field" type="number" label=${options.label} aria-label=${options.ariaLabel ?? options.label}
      min=${options.min ?? nothing} max=${options.max ?? nothing} step=${options.step ?? 1}
      suffix-text=${options.suffix ?? nothing} inputmode=${options.step === 1 || options.step === undefined ? "numeric" : "decimal"}
      .value=${focusedValue(options.value === null ? "" : String(options.value))}
      ?disabled=${options.disabled}
      ?error=${options.invalid} aria-invalid=${options.invalid ? "true" : nothing}
      @input=${(event: Event) => update(event, false)} @change=${(event: Event) => update(event, true)}>
    </md-outlined-text-field>
  `;
}

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
  shortcut?: string;
  icon?: string;
  leading?: TemplateResult;
  disabled?: boolean;
}

/**
 * Arrow-key navigation for a single-select composite (radiogroup, tablist).
 *
 * ARIA requires these to be one tab stop with arrow keys moving between the
 * options — a row of buttons each taking their own tab stop is a different
 * widget, and that is what the site had. Returns a keydown handler for the
 * container; the selected option keeps tabindex="0" and the rest -1.
 */
export function rovingKeydown<T>(values: ReadonlyArray<T>, current: T, onSelect: (value: T) => void, focusOptions?: FocusOptions) {
  return (event: KeyboardEvent) => {
    const step: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
    const index = Math.max(0, values.indexOf(current));
    let next =
      event.key in step
        ? (index + step[event.key] + values.length) % values.length
        : event.key === "Home"
          ? 0
          : event.key === "End"
            ? values.length - 1
            : -1;
    if (next < 0 || !values.length) return;
    event.preventDefault();
    const container = event.currentTarget as HTMLElement;
    const controls = container.querySelectorAll<HTMLElement>('[role="tab"], [role="radio"], [role="checkbox"]');
    const direction = step[event.key] ?? (event.key === "End" ? -1 : 1);
    let skipped = 0;
    while (controls[next]?.matches(":disabled, [aria-disabled=true]") && skipped < values.length) {
      next = (next + direction + values.length) % values.length;
      skipped++;
    }
    if (skipped === values.length || next === index && values[index] === current) return;
    onSelect(values[next]);
    // The container re-renders on selection; move focus once it has.
    requestAnimationFrame(() =>
      container.querySelectorAll<HTMLElement>('[role="tab"], [role="radio"], [role="checkbox"]')[next]?.focus(focusOptions),
    );
  };
}

export interface SegmentedOptions<T extends string> {
  label: string;
  value: T;
  options: ReadonlyArray<SegmentOption<T>>;
  onSelect: (value: T) => void;
  /** Icon-only segments keep their label in the accessibility tree. */
  iconOnly?: boolean;
  /** Show each option's primary binding beside its icon. */
  showShortcuts?: boolean;
  /** Text segments fill available space by default; false opts into a compact group. */
  grow?: boolean;
}

/**
 * Single-select segmented button. Material models this as a radio group, so
 * that is what it renders — not a row of bare <button>s with aria-pressed,
 * which is what the catalog view switch used to be.
 */
export function segmented<T extends string>(options: SegmentedOptions<T>): TemplateResult {
  const tabStop = options.options.find((option) => option.value === options.value) ?? options.options[0];
  const classes = ["segmented", options.iconOnly ? "segmented--icon" : "", options.grow === false ? "segmented--compact" : options.grow ? "segmented--grow" : ""]
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
        (value) => {
          if (!options.options.find((option) => option.value === value)?.disabled) options.onSelect(value);
        },
      )}
    >
      ${options.options.map(
        (option) => html`
          <button
            type="button"
            role="radio"
            aria-checked=${String(option.value === options.value)}
            aria-label=${options.iconOnly ? option.label : nothing}
            title=${option.shortcut ? `${option.label} (${option.shortcut})` : options.iconOnly ? option.label : nothing}
            tabindex=${option === tabStop ? "0" : "-1"}
            ?disabled=${option.disabled}
            @click=${() => options.onSelect(option.value)}
          >
            ${option.leading ?? (option.icon ? icon(option.icon, 20) : nothing)}
            ${
              options.iconOnly
                ? nothing
                : html`
                    <span>${option.label}</span>
                  `
            }
            ${options.showShortcuts && option.shortcut ? html`<kbd>${option.shortcut.split(" / ")[0]}</kbd>` : nothing}
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
  imageOnly?: boolean;
  count?: number;
}

/** Material filter chip; native emblems can replace the visible label. */
export function filterChip(options: FilterChipOptions): TemplateResult {
  return html`
    <button
      class=${options.imageOnly ? "chip chip--rarity" : "chip"}
      type="button"
      role="checkbox"
      aria-checked=${String(options.selected)}
      aria-label=${options.imageOnly ? options.label : nothing}
      title=${options.imageOnly ? options.label : nothing}
      @click=${options.onToggle}
    >
      ${
        options.selected
          ? icon("check", 18)
          : options.image && !options.imageOnly
            ? html`
                <span class="chip__avatar"><img src=${options.image} alt="" loading="lazy" decoding="async" /></span>
              `
            : nothing
      }
      <span class="chip__label">
        ${options.imageOnly ? rarityIcon(options.image || "", options.label) : options.label}
      </span>
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
export function inputChip(
  label: string,
  removeLabel: string,
  onRemove: () => void,
  content: unknown = label,
): TemplateResult {
  return html`
    <button class="chip chip--input" type="button" @click=${onRemove} aria-label=${`${removeLabel}: ${label}`}>
      <span class="chip__label">${content}</span>
      <span class="chip__remove">${icon("close", 18)}</span>
    </button>
  `;
}
