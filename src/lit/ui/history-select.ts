import "@material/web/select/outlined-select.js";
import "@material/web/select/select-option.js";
import type { MdOutlinedSelect } from "@material/web/select/outlined-select.js";
import { html, type TemplateResult } from "lit";

export interface HistorySelectOption {
  value: string;
  label: string;
}

export function historySelect(
  label: string,
  value: string,
  options: readonly HistorySelectOption[],
  onChange: (value: string) => void,
  settings: { disabled?: boolean } = {},
): TemplateResult {
  return html`<md-outlined-select
    label=${label}
    .value=${value}
    ?disabled=${settings.disabled}
    @change=${(event: Event) =>
      onChange((event.currentTarget as MdOutlinedSelect).value)}
  >
    ${options.map(
      (option) => html`<md-select-option
        .value=${option.value}
        .selected=${option.value === value}
      >
        <div slot="headline">${option.label}</div>
      </md-select-option>`,
    )}
  </md-outlined-select>`;
}
