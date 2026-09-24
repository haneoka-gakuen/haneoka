import { html, nothing } from "lit";

/**
 * Specification list.
 *
 * A detail pane is mostly labelled facts, and facts want a grid: a label
 * column that sizes to its content and a value column that wraps. Rendering
 * them as a real <dl> means the association is in the document, not implied
 * by position — and it means every resource's facts line up with every
 * other's.
 */
export interface SpecRow {
  label: unknown;
  value: unknown;
  /** Spans both columns: long copy, a chip set, an embedded table. */
  wide?: boolean;
}

export interface SpecListOptions {
  /** Two label/value pairs per row once the pane is wide enough. */
  split?: boolean;
  /** Tabular figures for numeric value columns. */
  numeric?: boolean;
  className?: string;
}

export function specList(rows: ReadonlyArray<SpecRow | null | undefined>, options: SpecListOptions = {}) {
  const entries = rows.filter((row): row is SpecRow => Boolean(row && row.value !== "" && row.value !== undefined));
  if (!entries.length) return nothing;
  const classes = [
    "spec-list",
    options.split ? "spec-list--split" : "",
    options.numeric ? "spec-list--numeric" : "",
    options.className || "",
  ]
    .filter(Boolean)
    .join(" ");
  return html`
    <dl class=${classes}>
      ${entries.map(
        (row) => html`
          <div class=${row.wide ? "spec-list__wide" : nothing}>
            <dt>${row.label}</dt>
            <dd>${row.value}</dd>
          </div>
        `,
      )}
    </dl>
  `;
}
