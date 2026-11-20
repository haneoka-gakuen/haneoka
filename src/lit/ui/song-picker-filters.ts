import { html, nothing } from "lit";
import { chooserFacet, chooserGroup } from "./chooser-filters";
import { filterChip, inputChip, segmented } from "./controls";

type Label = (key: string, fallback: string) => string;
type Option = { value: string; label: string; image?: string };
export interface SongPickerFilters {
  category: string;
  band: string;
  attribute: string;
  gekisouTypes: readonly string[];
  gekisouMatch: "only" | "contains";
  minLevel: number | null;
  maxLevel: number | null;
  maxSeconds: number | null;
}
export const emptySongPickerFilters = (): SongPickerFilters => ({
  category: "", band: "", attribute: "", gekisouTypes: [], gekisouMatch: "only",
  minLevel: null, maxLevel: null, maxSeconds: null,
});

export function songPickerFilterGroups(options: {
  state: SongPickerFilters;
  t: Label;
  common: Label;
  bands: readonly Option[];
  categories: readonly Option[];
  attributes: readonly Option[];
  gekisou: boolean;
  duration: boolean;
  sort: unknown;
  change: (patch: Partial<SongPickerFilters>) => void;
}) {
  const { state, t, common, change } = options;
  const facet = (key: "category" | "band" | "attribute", label: string, values: readonly Option[]) =>
    values.length ? chooserFacet({
      label, value: state[key], allLabel: common("common.states.all", "All"),
      options: values, change: value => change({ [key]: value }),
    }) : nothing;
  const field = (key: "minLevel" | "maxLevel" | "maxSeconds", label: string) => html`
    <md-outlined-text-field type="number" min="1" label=${label}
      .value=${state[key] === null ? "" : String(state[key])}
      @input=${(event: Event) => {
        const raw = (event.currentTarget as HTMLInputElement).value;
        change({ [key]: raw === "" ? null : Number(raw) });
      }}></md-outlined-text-field>
  `;
  return html`
    ${facet("category", common("catalog.songs.fields.genre", "Genre"), options.categories)}
    ${facet("band", t("songBandFilter", "Song band"), options.bands)}
    ${facet("attribute", t("songAttributeFilter", "Song attribute"), options.attributes)}
    ${options.gekisou ? chooserGroup(t("gekiso", "GEKISO"), html`
      <div class="stack stack--tight">
        <div class="cluster">
          ${["Combo", "Luck", "JustCount", "Mix"].map((value, index) => {
            const selected = state.gekisouTypes.includes(value);
            return filterChip({
              label: ["COMBO", "LUCK", "JUST", common("catalog.songs.gekisou.mixed", "Mixed")][index]!,
              selected, onToggle: () => change({ gekisouTypes: selected
                ? state.gekisouTypes.filter(type => type !== value) : [...state.gekisouTypes, value] }),
            });
          })}
        </div>
        ${segmented({
          label: common("catalog.songs.gekisou.matchMode", "Match mode"),
          value: state.gekisouMatch,
          options: [
            { value: "only", label: common("catalog.songs.gekisou.only", "Only selected types") },
            { value: "contains", label: common("catalog.songs.gekisou.contains", "Contains a selected type") },
          ],
          onSelect: gekisouMatch => change({ gekisouMatch }),
        })}
      </div>
    `) : nothing}
    ${chooserGroup(t("level", "Level"), html`<div class="row">
      ${field("minLevel", t("sc.minLevel", "Minimum level"))}
      ${field("maxLevel", t("sc.maxLevel", "Maximum level"))}
    </div>`)}
    ${options.duration ? chooserGroup(common("common.fields.duration", "Duration"),
      field("maxSeconds", t("maxDuration", "Maximum chart duration (seconds)"))) : nothing}
    ${chooserGroup(common("common.actions.sort", "Sort"), options.sort)}
  `;
}

export function songPickerDifficultyFilters<T extends string | number>(options: {
  label: string;
  choices: readonly { value: T; label: string }[];
  selected: readonly T[];
  change: (selected: T[]) => void;
  allLabel?: string;
}) {
  const { selected, choices, change } = options;
  return html`<div class="cluster" role="group" aria-label=${options.label}>
    ${choices.map(({ value, label }) => filterChip({
      label, selected: selected.includes(value),
      onToggle: () => change(selected.includes(value) ? selected.filter(key => key !== value) : [...selected, value]),
    }))}
    ${options.allLabel ? filterChip({
      label: options.allLabel,
      selected: choices.every(({ value }) => selected.includes(value)),
      onToggle: () => change(choices.map(({ value }) => value)),
    }) : nothing}
  </div>`;
}

export function songPickerAppliedFilters(options: {
  items: readonly { label: string; clear: () => void }[];
  removeLabel: string;
  clearLabel: string;
  clear: () => void;
}) {
  return html`<div class="cluster tb-picker-applied">
    ${options.items.map(item => inputChip(item.label, options.removeLabel, item.clear))}
    ${options.items.length ? html`<button class="button button--text" type="button" @click=${options.clear}>${options.clearLabel}</button>` : nothing}
  </div>`;
}
