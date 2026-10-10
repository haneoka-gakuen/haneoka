import { html, type TemplateResult } from "lit";
import type { TeamBuilder } from "../team-builder";
import { LIVE_BOOST_COSTS, isLiveBoostCost, liveBoostRow } from "../../lib/team-builder/engine/boosts";

export function boostControl(host: TeamBuilder, value: number, change: (value: number) => void): TemplateResult {
  return html`
    <md-outlined-select
      label=${host.t("boosts", "Boosts per live")}
      .value=${String(value)}
      ?error=${!isLiveBoostCost(value)}
      @change=${(event: Event) => change(Number((event.target as HTMLInputElement).value))}
    >
      ${LIVE_BOOST_COSTS.map(
      (cost) => html`
        <md-select-option value=${String(cost)} ?disabled=${!liveBoostRow(host.master!.boosts, cost)}>
          <div slot="headline">${cost}</div>
        </md-select-option>
      `,
    )}
    </md-outlined-select>
  `;
}
