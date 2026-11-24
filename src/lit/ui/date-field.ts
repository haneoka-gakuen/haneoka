import { html, nothing } from "lit";
import { focusedValue } from "./focused-value";
import "@material/web/field/outlined-field.js";

export function dateField(options: {
  label: string;
  value: string;
  name?: string;
  min?: string;
  max?: string;
  disabled?: boolean;
  required?: boolean;
  onChange?(value: string): void;
}) {
  const focus = (event: FocusEvent, focused: boolean) => {
    (event.currentTarget as HTMLElement & { focused: boolean }).focused = focused;
  };
  return html`
    <md-outlined-field class="date-field" label=${options.label} populated ?disabled=${options.disabled} ?required=${options.required}
      @focusin=${(event: FocusEvent) => focus(event, true)} @focusout=${(event: FocusEvent) => focus(event, false)}>
      <input type="date" name=${options.name || nothing} aria-label=${options.label} .value=${focusedValue(options.value)}
        min=${options.min || nothing} max=${options.max || nothing} ?disabled=${options.disabled} ?required=${options.required}
        @change=${(event: Event) => options.onChange?.((event.currentTarget as HTMLInputElement).value)} />
    </md-outlined-field>
  `;
}
