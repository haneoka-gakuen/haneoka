import type { TemplateResult } from "lit";
import type { TeamBuilder } from "../team-builder";
import { LIVE_BOOST_COSTS, liveBoostRow } from "../../lib/team-builder/engine/boosts";
import { choiceField } from "./catalog";
import type { BoostRow } from "../../lib/team-builder/engine/master";

export function boostControl(host: TeamBuilder, value: number, change: (value: number) => void, rows: readonly BoostRow[] = host.settlementMaster!.boosts): TemplateResult {
  return choiceField({
    type: "select",
    label: host.t("boosts", "Boosts per live"), value: String(value),
    options: LIVE_BOOST_COSTS.map(cost => ({value: String(cost), label: String(cost), disabled: !liveBoostRow(rows, cost)})),
    onSelect: value => change(Number(value)),
  });
}

export function challengeCostControl(host: TeamBuilder, value: number, change: (value: number) => void, rows: readonly BoostRow[] = host.settlementMaster!.challengeBoosts): TemplateResult {
  return choiceField({
    type: "buttons", label: host.t("cpPerLive", "CP per live"), value: String(value),
    options: rows.filter(row => row.consumed > 0).map(row => ({ value: String(row.consumed), label: `${row.consumed} CP` })),
    onSelect: value => change(Number(value)),
  });
}
