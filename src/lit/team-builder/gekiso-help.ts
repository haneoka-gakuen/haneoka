// L3 — GEB
// Input: The active team-builder locale, scoring controls and release timing rows.
// Output: Shared GEKISO help buttons and an accessible help dialog.
// Pos: [Map](../L2-2.md); explanations and examples beside GEKISO conditions.
// Effects/Dependencies: Keeps the current help topic per workspace and uses the shared modal lifecycle.
import { html, nothing } from "lit";
import type { TeamBuilder } from "../team-builder";
import { icon } from "../ui/icon";
import { modal, isBackdropClick, backdropPress } from "../ui/modal";
import { justBaseWindow } from "./workspace-state";

type Topic = "members" | "combo" | "just" | "luck" | "placements" | "sections" | "accuracy";
const topics = new WeakMap<TeamBuilder, Topic>();
export function gekisoHelpButton(host: TeamBuilder, topic: Topic) {
  return html`
    <button
      class="icon-button"
      type="button"
      aria-label=${host.t("gekisoHelp.open", "Help: {topic}", { topic: host.t(`gekisoHelp.${topic}Title`, topic) })}
      @click=${() => {
      topics.set(host, topic);
      host.requestUpdate();
    }}
    >
      ${icon("help", 20)}
    </button>
  `;
}
export function renderGekisoHelp(host: TeamBuilder) {
  const topic = topics.get(host);
  if (!topic) return nothing;
  const close = () => {
    topics.delete(host);
    host.requestUpdate();
  };
  const base = justBaseWindow(host.data ?? null);
  const values = { base: base ?? "—", expanded: base === null ? "—" : base * 11 };
  return html`
    <dialog
      class="dialog"
      aria-labelledby="tb-gekiso-help-title"
      ${modal(close)}
      @pointerdown=${backdropPress}
      @click=${(event: MouseEvent) => {
        if (isBackdropClick(event)) close();
      }}
    >
      <header class="dialog__header">
        <h2 id="tb-gekiso-help-title">${host.t(`gekisoHelp.${topic}Title`, topic)}</h2>
      </header>
      <div class="dialog__body stack">
        <p>${host.t(`gekisoHelp.${topic}Body`, "", values)}</p>
        <p>${host.t(`gekisoHelp.${topic}Example`, "", values)}</p>
        ${
        topic === "members" && [...(host.master?.gekisoSkills.values() ?? [])].some((skill) => skill.missionType === 4)
          ? html`
              <p>${host.t("gekisoHelp.membersAll", "ALL members count toward each type.")}</p>
            `
          : nothing
      }
      </div>
      <footer class="dialog__actions">
        <button class="button button--text" type="button" @click=${close}>
          ${host.common("common.actions.close", "Close")}
        </button>
      </footer>
    </dialog>
  `;
}
