// L3 — GEB
// Input: Card scope, growth policy and the owning workspace's update callbacks.
// Output: Shared card/account presets, unfilled-growth and recorded-growth requirement controls.
// Pos: [Map](../L2-2.md); identical card input controls for search, manual teams and parking.
// Effects/Dependencies: Changes only through supplied callbacks; reuses the shared Material controls.
import { html } from "lit";
import type { TeamBuilder } from "../team-builder";
import type { UnknownPolicy } from "../../lib/team-builder/engine/box";
import { segmented } from "../ui/controls";
import { choiceField } from "./catalog";
import type { BuildSettings } from "./types";

const growthOptions = (host: TeamBuilder) => [
  { value: "max" as const, label: host.t("unknownMax", "Count as max") },
  { value: "min" as const, label: host.t("unknownMin", "Count as minimum") },
];

type CardScopeSettings = Pick<BuildSettings, "scope" | "maxAccountBonuses">;
export function cardScopeLabel(host: TeamBuilder, settings: CardScopeSettings): string {
  return settings.scope === "box" ? host.t("scopeBox", "My cards")
    : settings.maxAccountBonuses ? host.t("scopeAllMax", "Max cards and account")
    : host.t("scopeAll", "All cards, full growth");
}

export function cardScopeControl(host: TeamBuilder, settings: CardScopeSettings, change: (value: CardScopeSettings) => void, mode: "search" | "manual" = "search") {
  return segmented({
    label: host.t("scope", "Cards"), value: settings.scope === "box" ? "box" : settings.maxAccountBonuses ? "max-account" : "theoretical",
    options: [
      { value: "box", label: host.t("scopeBox", "My cards") },
      { value: "theoretical", label: mode === "manual" ? host.t("manualAllCards", "All cards; unowned at max growth") : host.t("scopeAll", "All cards, full growth") },
      { value: "max-account", label: host.t("scopeAllMax", "Max cards and account") },
    ], onSelect: value => change({ scope: value === "box" ? "box" : "theoretical", maxAccountBonuses: value === "max-account" }),
  });
}

export function unknownGrowthControl(host: TeamBuilder, value: UnknownPolicy, change: (value: UnknownPolicy) => void) {
  return html`<div class="tb-field"><span class="tb-field__label">${host.t("unknownPolicy", "Growth not entered")}</span>
    ${segmented({ label: host.t("unknownPolicy", "Growth not entered"), value, options: growthOptions(host), onSelect: change })}
  </div>`;
}

export function recordedGrowthControl(host: TeamBuilder, value: UnknownPolicy | "required", change: (value: UnknownPolicy | "required") => void, disabled = false) {
  return choiceField({
    type: "select", label: host.t("unknownPolicy", "Growth not entered"), value,
    options: [{ value: "required" as const, label: host.t("farm.requireGrowth", "Complete before calculating") }, ...growthOptions(host).reverse()]
      .map(option => ({ ...option, disabled })), onSelect: change,
  });
}
