// L3 — GEB
// Input: Explicit control type, localized choices, native icons and current value.
// Output: A fixed Material select or a fixed row of segmented buttons.
// Pos: [Map](../L2-2.md); shared form rendering for the team workspace.
// Effects/Dependencies: Saves only through the supplied selection callback; no observers or local component state.
import { html, nothing } from "lit";
import { segmented, type SegmentedOptions } from "../ui/controls";

export type ChoiceFieldType = "buttons" | "select";

export function choiceField<T extends string>(options: SegmentedOptions<T> & { type: ChoiceFieldType }) {
  if (options.type === "buttons") return html`
    <div class="tb-choice stack stack--tight">
      <span class="tb-field__label">${options.label}</span>
      ${segmented(options)}
    </div>
  `;
  const selected = options.options.find(option => option.value === options.value);
  return html`
    <md-outlined-select
      label=${options.label}
      .value=${options.value}
      ?disabled=${options.options.every(option => option.disabled)}
      @change=${(event: Event) => options.onSelect((event.target as HTMLInputElement).value as T)}
    >
      ${selected?.leading ? html`<span slot="leading-icon" class="tb-game-icon">${selected.leading}</span>` : nothing}
      ${options.options.map(option => html`
        <md-select-option value=${option.value} ?disabled=${option.disabled}>
          ${option.leading ? html`<span slot="start" class="tb-game-icon">${option.leading}</span>` : nothing}
          <div slot="headline">${option.label}</div>
        </md-select-option>
      `)}
    </md-outlined-select>
  `;
}
