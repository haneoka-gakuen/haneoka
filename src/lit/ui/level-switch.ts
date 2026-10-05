import { html, nothing } from "lit";
import "@material/web/slider/slider.js";
import "../../styles/card-detail.css";

export function renderLevelSwitch(
  label: string,
  levels: number[],
  value: number | null,
  update: (value: number) => void,
  displayValue: (value: number) => string = String,
  options: { disabled?: boolean; unknownLabel?: string; commitOnChange?: boolean } = {},
) {
  if (levels.length < 2) return nothing;
  const known = value !== null && levels.includes(value);
  const index = known ? levels.indexOf(value!) : 0;
  const contiguous = levels.every((level, index) => level === levels[0]! + index);
  const shown = known ? displayValue(value!) : options.unknownLabel ?? "Not set";
  const lower = levels[known ? Math.max(0, index - 1) : 0]!;
  const upper = levels[known ? Math.min(levels.length - 1, index + 1) : 0]!;
  const change = (event: Event) => {
    if (options.disabled) return;
    const raw = Number((event.currentTarget as HTMLElement & { value?: number }).value);
    const next = contiguous ? raw : levels[raw];
    if (Number.isSafeInteger(next) && levels.includes(next!)) update(next!);
  };
  return html`
    <div class="detail-level-switch">
      <span class="detail-level-switch__value">
        <small>${label}</small>
        <strong>${shown}</strong>
      </span>
      <button
        class="icon-button"
        ?disabled=${options.disabled || known && index === 0}
        @click=${() => { if (!options.disabled) update(lower); }}
        aria-label=${`${label} ${displayValue(lower)}`}
      >
        <svg class="material-icon" width="18" height="18"><use href="/icons.svg#remove"></use></svg>
      </button>
      <md-slider
        class="md3-slider"
        min=${contiguous ? levels[0] : 0}
        max=${contiguous ? levels.at(-1) : levels.length - 1}
        step="1"
        .value=${contiguous ? levels[index] : index}
        ?disabled=${options.disabled}
        ?labeled=${contiguous}
        @input=${options.commitOnChange ? nothing : change}
        @change=${options.commitOnChange ? change : nothing}
        aria-label=${label}
        aria-valuetext=${shown}
      ></md-slider>
      <button
        class="icon-button"
        ?disabled=${options.disabled || known && index === levels.length - 1}
        @click=${() => { if (!options.disabled) update(upper); }}
        aria-label=${`${label} ${displayValue(upper)}`}
      >
        <svg class="material-icon" width="18" height="18"><use href="/icons.svg#add"></use></svg>
      </button>
    </div>
  `;
}
