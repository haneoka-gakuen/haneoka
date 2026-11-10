import type { TemplateResult } from "lit";
import type { TeamBuilder } from "../team-builder";
import { LIVE_BOOST_COSTS, liveBoostRow } from "../../lib/team-builder/engine/boosts";
import { choiceField } from "./catalog";

export function boostControl(host: TeamBuilder, value: number, change: (value: number) => void): TemplateResult {
  return choiceField({
    label: host.t("boosts", "Boosts per live"), value: String(value),
    options: LIVE_BOOST_COSTS.map(cost => ({value: String(cost), label: String(cost), disabled: !liveBoostRow(host.master!.boosts, cost)})),
    onSelect: value => change(Number(value)),
  });
}
