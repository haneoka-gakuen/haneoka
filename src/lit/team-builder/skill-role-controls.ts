// L3 — GEB
// Input: Current pair-aware role bounds and workspace setter.
// Output: Member/Snapshot role grid and a pending min/max editor.
// Pos: [Map](../L2-2.md); shared native skill-role constraints.
// Effects/Dependencies: Applies role edits to existing preferences; cancel preserves the previous values.
import { html, nothing } from "lit";
import type { TeamBuilder } from "../team-builder";
import { SKILL_ROLES, hasSkillRoleLimits, type SkillRole } from "../../lib/team-builder/skill-roles";
import { accordion } from "../ui/accordion";
import { iconButton, segmented } from "../ui/controls";
import { modal } from "../ui/modal";
export interface SkillRoleEdit {
  kind: "member" | "snap";
  role: SkillRole;
  range: [number, number];
}
export function skillRoleControls(host: TeamBuilder) {
  const limits = host.searchSettings.skillRoles,
    t = (key: string) => host.t(`skillRoles.${key}`, key);
  const active = Object.values(limits)
    .flatMap((group) => Object.values(group))
    .filter(([min, max]) => min > 0 || max < 5).length;
  return accordion({
    id: "tb-skill-roles",
    label: t("title"),
    expanded: host.expanded.has("skill-roles"),
    metadata: hasSkillRoleLimits(limits) ? String(active) : undefined,
    onExpandedChange: (open) => {
      if (open) host.expanded.add("skill-roles");
      else host.expanded.delete("skill-roles");
      host.requestUpdate();
    },
    content: html`
      <div class="tb-role-grid" role="table" aria-label=${t("title")}>
        <div class="tb-role-grid__row" role="row">
          <span role="columnheader"></span>
          ${SKILL_ROLES.map((role) => html`<span class="tb-role-grid__head" role="columnheader">${t(role)}</span>`)}
        </div>
        ${(["member", "snap"] as const).map(
          (kind) => html`
            <div class="tb-role-grid__row" role="row">
              <span class="tb-role-grid__kind" role="rowheader">${t(kind)}</span>
              ${SKILL_ROLES.map((role) => {
                const [min, max] = limits[kind][role],
                  limited = min > 0 || max < 5,
                  value = limited ? (min === max ? String(min) : `${min}–${max}`) : t("unlimited");
                return html`
                  <span role="cell">
                    <button
                      class="tb-role-cell"
                      type="button"
                      aria-haspopup="dialog"
                      aria-pressed=${String(limited)}
                      aria-label=${`${t(kind)} ${t(role)}: ${value}`}
                      @click=${() => {
                        host.skillRoleEditor = { kind, role, range: [min, max] };
                        host.requestUpdate();
                      }}
                    >
                      ${value}
                    </button>
                  </span>
                `;
              })}
            </div>
          `,
        )}
      </div>
    `,
  });
}
export function renderSkillRoleEditor(host: TeamBuilder) {
  const edit = host.skillRoleEditor;
  if (!edit) return nothing;
  const t = (key: string) => host.t(`skillRoles.${key}`, key),
    close = () => {
      host.skillRoleEditor = null;
      host.requestUpdate();
    };
  const values = ["0", "1", "2", "3", "4", "5"] as const;
  return html`
    <dialog class="dialog tb-role-dialog" data-managed-modal ${modal(close)} aria-labelledby="tb-role-dialog-title">
      <header class="tb-analysis-header">
        <hgroup>
          <h2 id="tb-role-dialog-title">${t(edit.role)}</h2>
          <p>${t(edit.kind)}</p>
        </hgroup>
        ${iconButton({ icon: "close", label: host.common("common.actions.close", "Close"), onClick: close })}
      </header>
      <div class="dialog__body tb-analysis-body">
        ${([0, 1] as const).map(
          (index) => html`
            <div class="tb-analysis-field">
              <span class="tb-field__label">${t(index ? "max" : "min")}</span>
              ${segmented({
                label: t(index ? "max" : "min"),
                value: String(edit.range[index]) as (typeof values)[number],
                options: values.map((value) => ({ value, label: value })),
                onSelect: (value) => {
                  edit.range[index] = Number(value);
                  if (edit.range[0] > edit.range[1]) edit.range[1 - index] = Number(value);
                  host.requestUpdate();
                },
              })}
            </div>
          `,
        )}
      </div>
      <footer class="dialog__actions tb-role-dialog__actions">
        <button
          class="button button--text"
          type="button"
          ?disabled=${edit.range[0] === 0 && edit.range[1] === 5}
          @click=${() => {
            edit.range = [0, 5];
            host.requestUpdate();
          }}
        >
          ${t("unlimited")}
        </button>
        <button class="button button--text" type="button" @click=${close}>
          ${host.common("common.actions.cancel", "Cancel")}
        </button>
        <button
          class="button button--filled"
          type="button"
          @click=${() => {
            const limits = structuredClone(host.searchSettings.skillRoles);
            limits[edit.kind][edit.role] = [...edit.range];
            host.updateSettings({ skillRoles: limits });
            close();
          }}
        >
          ${t("apply")}
        </button>
      </footer>
    </dialog>
  `;
}
