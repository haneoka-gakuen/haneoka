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

export function cardScopeControl(
  host: TeamBuilder,
  settings: BuildSettings,
  change: (value: Partial<BuildSettings>) => void,
  mode: "search" | "manual" = "search",
) {
  const manual = mode === "manual";
  const control = {
    label: host.t("scope", "Cards"),
    value: settings.scope === "box" ? "box" : settings.maxAccountBonuses ? "max-account"
      : manual && !settings.manualFullGrowth ? "recorded" : "all-max",
    options: [
      { value: "box", label: host.t("scopeBox", "My cards") },
      ...(manual ? [{ value: "recorded", label: host.t("manualAllCards", "All cards; unowned at max growth") }] : []),
      { value: "all-max", label: host.t("scopeAll", "All cards, full growth") },
      { value: "max-account", label: host.t("scopeAllMax", "Max cards and account") },
    ],
    onSelect: (value: string) => change({
      scope: value === "box" ? "box" : "theoretical",
      maxAccountBonuses: value === "max-account",
      ...(manual ? { manualFullGrowth: value === "all-max" } : {}),
    }),
  };
  return manual ? choiceField({ type: "select", ...control }) : segmented(control);
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
