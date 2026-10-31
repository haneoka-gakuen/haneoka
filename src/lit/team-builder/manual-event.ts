// L3 — GEB
// Input: Team workspace, same-server event templates and saved manual conditions.
// Output: Manual event controls inside the existing reward settings.
// Pos: [Map](../L2-2.md); activity setup, separate from candidate filters.
// Effects/Dependencies: Saves drafts through the host; no calculation or catalogue writes.
import { html, nothing } from "lit";
import { formatList } from "../shared/catalog";
import type { TeamBuilder } from "../team-builder";
import {
  emptyManualEvent,
  manualEventTemplate,
  type ManualEventDraft,
  type BonusTier,
} from "../../lib/team-builder/manual-event";
import { teamBuilderSourceIdentity } from "../../lib/team-builder/data/source";
import { filterChip, iconButton, segmented } from "../ui/controls";
import { accordion } from "../ui/accordion";
import { farmingSettings } from "./workspace-state";

export function manualEventOptions(host: TeamBuilder) {
  return host
    .catalog!.events()
    .filter(
      (row) =>
        teamBuilderSourceIdentity(host.data!, "events", row.id).server === host.data!.identity.server &&
        manualEventTemplate(row.event, host.master!),
    );
}
export function enableManualEvent(host: TeamBuilder) {
  const options = manualEventOptions(host);
  const draft = host.settings.manualEvent ?? emptyManualEvent();
  host.updateSettings({
    manualEventEnabled: true,
    rewardMode: farmingSettings({ ...host.settings, manualEventEnabled: true }).rewardMode,
    manualEvent: { ...draft, templateId: draft.templateId ?? options[0]?.id ?? null },
  });
}
export function renderManualEvent(host: TeamBuilder) {
  const draft = host.settings.manualEvent;
  const catalog = host.catalog!,
    master = host.master!;
  const t = (key: string) => host.t("manualEvent." + key, key);
  const set = (patch: Partial<ManualEventDraft>) => {
    host.updateSettings({ manualEvent: { ...draft, ...patch } });
  };
  const event = draft.templateId === null ? undefined : master.events.get(draft.templateId);
  const template = event && manualEventTemplate(event, master);
  const tierLabel = (tier: BonusTier) => {
    const values = (tier.effects.find((row) => row.bonusType !== 2) ?? tier.effects[0]!).perRank;
    const min = Math.min(...values) / 100,
      max = Math.max(...values) / 100;
    return "+" + min + (max === min ? "" : "–" + max) + "%";
  };
  const pickups = (kind: "members" | "snaps") => {
    const profiles = template?.[kind] ?? [];
    if (!profiles.length && !draft[kind].length) return nothing;
    const characters = (id: number) =>
      formatList(catalog.characterIds(kind, id).map((id) => catalog.characterName(id)), host.locale);
    return html`
      <div class="stack">
        <button class="button button--tonal" type="button" ?disabled=${!profiles.length}
          @click=${() => {
            host.slotPicker = {target: "manual-event", kind, ids: draft[kind].map(row => row.cardId)};
            host.requestUpdate();
          }}>${t(kind)}</button>
        ${draft[kind].map(
          (row) => html`
            <div class="stack stack--tight">
              <div class="row row--start">
                <div class="detail-object row__spacer">
                  <img
                    src=${(kind === "members" ? catalog.member(row.cardId) : catalog.snap(row.cardId))?.image ?? ""}
                    alt=""
                    width="36"
                    height="36"
                    loading="lazy"
                  />
                  <span>
                    ${catalog.cardName(kind, row.cardId)}
                    <small>${characters(row.cardId)}</small>
                  </span>
                </div>
                ${iconButton({
                  icon: "close",
                  label: host.common("common.actions.remove", "Remove") + " " + catalog.cardName(kind, row.cardId),
                  onClick: () => set({ [kind]: draft[kind].filter((value) => value.cardId !== row.cardId) }),
                })}
              </div>
              <md-outlined-select
                label=${host.t("eventBonus", "Event bonus")}
                ?disabled=${!profiles.length}
                .value=${row.tier}
                @change=${(e: Event) =>
                  set({
                    [kind]: draft[kind].map((value) =>
                      value.cardId === row.cardId ? { ...value, tier: (e.target as HTMLInputElement).value } : value,
                    ),
                  })}
              >
                ${profiles.map(
                  (profile) => html`
                    <md-select-option value=${profile.key}>
                      <div slot="headline">${tierLabel(profile)}</div>
                    </md-select-option>
                  `,
                )}
              </md-outlined-select>
            </div>
          `,
        )}
      </div>
    `;
  };
  return html`
    <div id="tb-manual-rules" data-tb-field tabindex="-1">
      <md-outlined-select
        label=${t("rules")}
        .value=${String(draft.templateId ?? "")}
        @change=${(e: Event) => set({ templateId: Number((e.target as HTMLInputElement).value), members: [], snaps: [] })}
      >
        <md-select-option value="" disabled><div slot="headline">${t("chooseRules")}</div></md-select-option>
        ${manualEventOptions(host).map(
          (row) => html`
            <md-select-option value=${String(row.id)}><div slot="headline">${row.name}</div></md-select-option>
          `,
        )}
      </md-outlined-select>
    </div>
    <div class="tb-field" id="tb-manual-attribute" data-tb-field tabindex="-1">
      <span class="tb-field__label">${t("attribute")}</span>
      <div class="cluster">
        ${filterChip({ label: t("none"), selected: draft.attributes?.length === 0, onToggle: () => set({ attributes: [] }) })}
        ${[1, 2, 3, 4, 5].map((id) =>
          filterChip({
            label: catalog.attributeName(id),
            image: catalog.attributeIcon(id) || undefined,
            selected: !!draft.attributes?.includes(id),
            onToggle: () => set({ attributes: draft.attributes?.includes(id)
              ? draft.attributes.filter((value) => value !== id)
              : [...(draft.attributes ?? []), id] }),
          }),
        )}
      </div>
    </div>
    <div class="stack" id="tb-manual-targets" data-tb-field tabindex="-1">
      ${segmented({
        label: t("targets"),
        value: draft.targetKind,
        options: (["band", "character", "none"] as const).map((value) => ({ value, label: t(value) })),
        onSelect: (targetKind) => set({ targetKind, targets: [] }),
      })}
      <div class="cluster">
        ${(draft.targetKind === "none"
          ? []
          : draft.targetKind === "band"
            ? [...new Set([...master.members.values()].map((card) => card.bandId))]
            : [...master.characters.keys()]
        ).map((id) =>
          filterChip({
            label: draft.targetKind === "band" ? catalog.bandName(id) : catalog.characterName(id),
            image: draft.targetKind === "band" ? catalog.bandIcon(id) || undefined : undefined,
            selected: draft.targets.includes(id),
            onToggle: () =>
              set({
                targets: draft.targets.includes(id)
                  ? draft.targets.filter((value) => value !== id)
                  : [...draft.targets, id],
              }),
          }),
        )}
      </div>
    </div>
    <div id="tb-manual-cards" data-tb-field tabindex="-1">
      ${accordion({
        id: "tb-manual-pickups",
        label: t("pickups"),
        metadata: String(draft.members.length + draft.snaps.length),
        expanded: host.expanded.has("manual-pickups"),
        onExpandedChange: (expanded) => {
          if (expanded) host.expanded.add("manual-pickups");
          else host.expanded.delete("manual-pickups");
          host.requestUpdate();
        },
        content: html`
          <div class="stack">${pickups("members")}${pickups("snaps")}</div>
        `,
      })}
    </div>
  `;
}
