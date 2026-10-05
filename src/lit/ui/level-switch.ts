import { html, nothing } from "lit";
import { ref } from "lit/directives/ref.js";
import "@material/web/slider/slider.js";
import "../../styles/card-detail.css";

type LevelControl = HTMLElement & { value: number; valueLabel: string; ariaValueText: string };
interface LevelDraft {
  committed: number | null;
  domain: string;
  context: unknown;
  label: string;
  commitOnChange: boolean;
  value?: number;
}
// A draft belongs to the rendered control, never to inventory or a render closure.
const levelDrafts = new WeakMap<LevelControl, LevelDraft>();

export function renderLevelSwitch(
  label: string,
  levels: number[],
  value: number | null,
  update: (value: number) => void,
  displayValue: (value: number) => string = String,
  options: {
    disabled?: boolean;
    unknownLabel?: string;
    commitOnChange?: boolean;
    /** Stable editing scope; replacing it discards an uncommitted preview. */
    context?: unknown;
  } = {},
) {
  if (levels.length < 2) return nothing;
  const known = value !== null && levels.includes(value);
  const index = known ? levels.indexOf(value!) : 0;
  const contiguous = levels.every((level, index) => level === levels[0]! + index);
  const shown = known ? displayValue(value!) : options.unknownLabel ?? "Not set";
  const lower = levels[known ? Math.max(0, index - 1) : 0]!;
  const upper = levels[known ? Math.min(levels.length - 1, index + 1) : 0]!;
  const domain = levels.join(",");
  const paint = (control: LevelControl, draft?: number) => {
    const current = draft ?? value;
    const currentKnown = current !== null && levels.includes(current);
    const currentIndex = currentKnown ? levels.indexOf(current!) : 0;
    const text = currentKnown ? displayValue(current!) : shown;
    control.value = contiguous ? levels[currentIndex]! : currentIndex;
    control.valueLabel = text;
    control.ariaValueText = text;
    const readout = control.closest(".detail-level-switch")?.querySelector<HTMLElement>(".detail-level-switch__value strong");
    if (readout) readout.textContent = text;
  };
  const sync = (control: LevelControl) => {
    let state = levelDrafts.get(control);
    if (!state || state.committed !== value || state.domain !== domain ||
      state.context !== options.context || state.label !== label || state.commitOnChange !== Boolean(options.commitOnChange)) {
      state = { committed: value, domain, context: options.context, label, commitOnChange: Boolean(options.commitOnChange) };
      levelDrafts.set(control, state);
    }
    if (options.disabled) state.value = undefined;
    paint(control, state.value);
    return state;
  };
  const cancel = (event: Event) => {
    const control = event.currentTarget as LevelControl;
    const state = levelDrafts.get(control);
    if (state) state.value = undefined;
    paint(control);
  };
  const preview = (event: Event) => {
    const control = event.currentTarget as LevelControl;
    if (options.disabled) { cancel(event); return; }
    const raw = Number(control.value), next = contiguous ? raw : levels[raw];
    if (!Number.isSafeInteger(next) || !levels.includes(next!)) { cancel(event); return; }
    const state = levelDrafts.get(control) ?? sync(control);
    state.value = options.commitOnChange ? next : undefined;
    paint(control, next);
    if (!options.commitOnChange) update(next!);
  };
  const commit = (event: Event) => {
    const control = event.currentTarget as LevelControl;
    const state = levelDrafts.get(control), next = state?.value;
    if (options.disabled || next === undefined) { cancel(event); return; }
    state!.value = undefined;
    update(next);
  };
  const step = (event: Event, next: number) => {
    if (options.disabled) return;
    const control = (event.currentTarget as HTMLElement).closest(".detail-level-switch")?.querySelector<LevelControl>("md-slider");
    if (control) { const state = levelDrafts.get(control); if (state) state.value = undefined; }
    update(next);
  };
  return html`
    <div class="detail-level-switch">
      <span class="detail-level-switch__value">
        <small>${label}</small>
        <strong></strong>
      </span>
      <button
        class="icon-button"
        ?disabled=${options.disabled || known && index === 0}
        @click=${(event: Event) => step(event, lower)}
        aria-label=${`${label} ${displayValue(lower)}`}
      >
        <svg class="material-icon" width="18" height="18"><use href="/icons.svg#remove"></use></svg>
      </button>
      <md-slider
        class="md3-slider"
        min=${contiguous ? levels[0] : 0}
        max=${contiguous ? levels.at(-1) : levels.length - 1}
        step="1"
        ?disabled=${options.disabled}
        labeled
        @input=${preview}
        @change=${options.commitOnChange ? commit : nothing}
        @pointercancel=${cancel}
        @keydown=${(event: KeyboardEvent) => {
          if (event.key === "Escape" && levelDrafts.get(event.currentTarget as LevelControl)?.value !== undefined) {
            event.preventDefault(); event.stopPropagation(); cancel(event);
          }
        }}
        aria-label=${label}
        ${ref(element => { if (element) sync(element as LevelControl); })}
      ></md-slider>
      <button
        class="icon-button"
        ?disabled=${options.disabled || known && index === levels.length - 1}
        @click=${(event: Event) => step(event, upper)}
        aria-label=${`${label} ${displayValue(upper)}`}
      >
        <svg class="material-icon" width="18" height="18"><use href="/icons.svg#add"></use></svg>
      </button>
    </div>
  `;
}
