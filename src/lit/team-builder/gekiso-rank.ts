import { html } from "lit";
import { segmented } from "../ui/controls";
import type { TeamBuilder } from "../team-builder";

export function rangeRankControl(
  host: TeamBuilder,
  ranks: readonly (number | null)[],
  change: (range: number, rank: number) => void,
  players = 5,
) {
  return html`<div class="stack" role="group" aria-label=${host.t("gekisoRank", "Placement in each range")}>
    ${[0, 1, 2].map(range => html`<div class="stack stack--tight">
      <span class="tb-field__label">${host.t("gekisoRange", "Range {n}", { n: range + 1 })}</span>
      ${segmented({
        label: `${host.t("gekisoRange", "Range {n}", { n: range + 1 })} / ${host.t("placementRank", "Specified placement")}`,
        value: ranks[range] == null ? "" : String(ranks[range]),
        options: Array.from({ length: players }, (_, index) => ({ value: String(index + 1), label: String(index + 1) })),
        onSelect: value => change(range, Number(value)),
      })}
    </div>`)}
  </div>`;
}
