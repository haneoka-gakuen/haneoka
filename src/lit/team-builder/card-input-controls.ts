// L3 — GEB
// Input: Card scope, growth policy and the owning workspace's update callbacks.
// Output: Shared scope, unfilled-growth and recorded-growth requirement controls.
// Pos: [Map](../L2-2.md); identical card input controls for search, manual teams and parking.
// Effects/Dependencies: Changes only through supplied callbacks; reuses the shared Material controls.
import { html } from "lit";
import type { TeamBuilder } from "../team-builder";
import type { UnknownPolicy } from "../../lib/team-builder/engine/box";
import { segmented } from "../ui/controls";
import { choiceField } from "./catalog";
import { icon } from "../ui/icon";

const growthOptions = (host: TeamBuilder) => [
  { value: "max" as const, label: host.t("unknownMax", "Count as max") },
  { value: "min" as const, label: host.t("unknownMin", "Count as minimum") },
];

export function cardScopeControl(host: TeamBuilder, value: "box" | "theoretical", change: (value: "box" | "theoretical") => void, mode: "search" | "manual" = "search") {
  return segmented({
    label: host.t("scope", "Cards"), value,
    options: [
      { value: "box", label: host.t("scopeBox", "My cards"), ...(mode === "search" ? { leading: icon("style", 20) } : {}) },
      { value: "theoretical", label: mode === "manual" ? host.t("manualAllCards", "All cards; unowned at max growth") : host.t("scopeAll", "All cards, full growth"), ...(mode === "search" ? { leading: icon("auto_awesome_motion", 20) } : {}) },
    ], onSelect: change,
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
