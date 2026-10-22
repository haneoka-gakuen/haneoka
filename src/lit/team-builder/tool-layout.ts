// L3 — GEB
// Input: Existing task form, action and result templates.
// Output: Desktop settings column or immediate-save mobile conditions dialog.
// Pos: [Map](../L2-2.md); team workspace layout only.
// Effects/Dependencies: Native modal lifecycle; calculation stays with controllers.
import { html, nothing } from "lit";
import { modal } from "../ui/modal";
import { iconButton } from "../ui/controls";
import type { TeamBuilder } from "../team-builder";

export function conditionSummary(host: TeamBuilder) {
  const s = host.searchSettings;
  const songs = host.tab === "song-comparison" ? host.songComparison.effectiveSettings.songs : s.songs;
  const goal = host.goal();
  const count =
    host.tab === "song-comparison"
      ? songs.length
      : goal?.kind === "power"
        ? Number(!!goal.song)
        : goal?.kind === "potential" || (goal?.kind === "event" && goal.route === "skip")
          ? 0
          : songs.length;
  const gekiso = host.tab === "song-comparison" || s.goal === "gekiso" || (s.goal === "event" && s.ptMode === "gekiso");
  return [
    host.tab === "song-comparison"
      ? host.t("manualTeam", "Build a team by hand")
      : s.scope === "box"
        ? host.t("scopeBox", "My cards")
        : host.t("scopeAll", "All cards, full growth"),
    host.t("chartCount", "{count} charts", { count }),
    ...(gekiso
      ? [
          host.tab === "song-comparison"
            ? `${host.t("placementRank", "Specified placement")} ${host.songComparison.settings.rank ?? "—"}`
            : s.goal === "gekiso"
              ? s.gekisoPlacementMode === "opponents"
                ? host.t("placementOpponents", "Opponent scores")
                : `${host.t("placementRank", "Specified placement")} ${s.gekisoRank}`
              : `${host.t("placementRank", "Specified placement")} 1`,
          ...(host.tab !== "song-comparison" && host.hasComboSongs() ? [`CB ≥ ×${s.minComboBonus}`] : []),
        ]
      : []),
  ].join(" · ");
}
export function toolLayout(host: TeamBuilder, body: unknown, actions: unknown, results: unknown) {
  const summary = conditionSummary(host);
  const footer = html`
    <div class="tb-operation">${actions}${host.renderCompareTray()}</div>
  `;
  return html`
    <div class=${`tb-build tb-tool${host.compactConditions ? " tb-tool--compact" : " tb-tool--desktop"}`}>
      ${
        host.compactConditions
          ? html`
              <section class="surface tb-condition-summary">
                <span>${summary}</span>
                <button id="tb-adjust" class="button button--text" @click=${() => host.openConditions()}>
                  ${host.t("adjustConditions", "Adjust conditions")}
                </button>
              </section>
              ${
                host.conditionsOpen
                  ? html`
                      <dialog
                        class="dialog tb-conditions"
                        data-managed-modal
                        ${modal(() => host.closeConditions())}
                        aria-label=${host.t("adjustConditions", "Adjust conditions")}
                      >
                        <header class="row row--between">
                          <strong>${host.t("adjustConditions", "Adjust conditions")}</strong>
                          ${iconButton({ icon: "close", label: host.common("common.actions.close", "Close"), onClick: () => host.closeConditions() })}
                        </header>
                        <div class="tb-config-body stack">${body}</div>
                        ${footer}
                      </dialog>
                    `
                  : nothing
              }
            `
          : html`
              <aside class="tb-config">
                <div class="tb-config-body stack">${body}</div>
                ${footer}
              </aside>
            `
      }
      <div class="tb-results-column" id="tb-progress" tabindex="-1">${results}</div>
      ${
        host.compactConditions && !host.conditionsOpen
          ? html`
              <div class="tb-mobile-operation">${footer}</div>
            `
          : nothing
      }
    </div>
  `;
}
