import { html, nothing, type TemplateResult } from "lit";
import { ref } from "lit/directives/ref.js";
import { icon } from "./icon";
import "../../styles/components/accordion.css";

export interface AccordionOptions {
  /** Stable, unique within the document; supplied by the section owner. */
  id: string;
  /** Non-interactive visible label; keep actions outside the trigger. */
  label: unknown;
  expanded: boolean;
  onExpandedChange: (expanded: boolean, event: MouseEvent) => void;
  /** Always supply the content, including while collapsed, to retain its state. */
  content: unknown;
  supportingText?: unknown;
  leading?: unknown;
  /** Non-interactive supporting content, such as a count. */
  metadata?: unknown;
  headingLevel?: 1 | 2 | 3 | 4 | 5 | 6;
  /** Opt in for a named landmark when the page has few panels. */
  region?: boolean;
  disabled?: boolean;
  className?: string;
}

/** Controlled Material disclosure. Its content stays mounted across toggles. */
export function accordion(options: AccordionOptions): TemplateResult {
  const triggerId = `${options.id}-trigger`;
  const panelId = `${options.id}-panel`;
  return html`
    <section class=${`md-accordion${options.className ? ` ${options.className}` : ""}`}>
      <div
        class="md-accordion__heading"
        role=${options.headingLevel ? "heading" : nothing}
        aria-level=${options.headingLevel ?? nothing}
      >
        <button
          class="button md-accordion__trigger"
          type="button"
          id=${triggerId}
          aria-expanded=${String(options.expanded)}
          aria-controls=${panelId}
          ?disabled=${options.disabled}
          @click=${(event: MouseEvent) => {
            if (!options.disabled) options.onExpandedChange(!options.expanded, event);
          }}
        >
          ${options.leading == null ? nothing : html`<span class="md-accordion__leading" aria-hidden="true">${options.leading}</span>`}
          <span class="md-accordion__identity">
            <span class="md-accordion__label">${options.label}</span>
            ${options.supportingText == null ? nothing : html`<span class="md-accordion__supporting">${options.supportingText}</span>`}
          </span>
          ${options.metadata == null ? nothing : html`<span class="md-accordion__metadata">${options.metadata}</span>`}
          <span class="md-accordion__chevron" aria-hidden="true">${icon("expand_more")}</span>
        </button>
      </div>
      <div
        ${ref((panel) => {
          if (!panel || options.expanded) return;
          const active = (panel.getRootNode() as Document | ShadowRoot).activeElement;
          if (active && panel.contains(active)) {
            panel.parentElement?.querySelector<HTMLButtonElement>(".md-accordion__trigger")?.focus();
          }
        })}
        class="md-accordion__panel"
        id=${panelId}
        role=${options.region ? "region" : nothing}
        aria-labelledby=${triggerId}
        ?hidden=${!options.expanded}
      >${options.content}</div>
    </section>
  `;
}
