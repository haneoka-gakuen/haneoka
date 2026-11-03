// L3 — GEB
// Input: Existing task form, action and result templates.
// Output: Wide settings panel or narrow full-screen conditions sheet, and the first-run checklist.
// Pos: [Map](../L2-2.md); team workspace layout only.
// Effects/Dependencies: Native modal lifecycle; calculation stays with controllers.
import { html, nothing } from "lit";
import { modal } from "../ui/modal";
import { iconButton } from "../ui/controls";
import { icon } from "../ui/icon";
import type { TeamBuilder } from "../team-builder";

export function conditionSummary(host: TeamBuilder) {
  const s = host.searchSettings;
  const manual = host.tab === "teams" || host.tab === "build" && host.buildMode === "manual";
  const songs = host.tab === "song-comparison" ? host.songComparison.effectiveSettings.songs : s.songs;
  const goal = manual ? host.manualGoal() : host.goal();
  const count =
    host.tab === "song-comparison" || manual
      ? songs.length
      : goal?.kind === "power"
        ? Number(!!goal.song)
        : goal?.kind === "potential" || (goal?.kind === "event" && goal.route === "skip")
          ? 0
          : songs.length;
  const gekiso = host.tab === "song-comparison" || s.goal === "gekiso" || (s.goal === "event" && s.ptMode === "gekiso");
  if (host.tab === "arena")
    return `${host.catalog!.bandName(host.arena.bandId)} ${host.t("chartCount", "{count} charts", { count })}`;
  return [
    host.tab === "song-comparison" || manual
      ? host.t("manualTeam", "Build a team by hand")
      : s.scope === "box"
        ? host.t("scopeBox", "My cards")
        : host.t("scopeAll", "All cards, full growth"),
    host.t("chartCount", "{count} charts", { count }),
    ...(gekiso
      ? [
          host.tab === "song-comparison"
            ? `${host.t("placementRank", "Specified placement")} ${host.songComparison.settings.ranks.map(rank => rank ?? "—").join(" / ")}`
            : manual
              ? `${host.t("placementRank", "Specified placement")} ${s.gekisoRanks.join(" / ")}`
            : s.goal === "gekiso"
              ? s.gekisoPlacementMode === "opponents"
                ? host.t("placementOpponents", "Opponent scores")
                : `${host.t("placementRank", "Specified placement")} ${s.gekisoRanks.join(" / ")}`
              : `${host.t("placementRank", "Specified placement")} 1`,
          ...(host.tab !== "song-comparison" && !manual && host.hasComboSongs() ? [`CB ≥ ×${s.minComboBonus}`] : []),
        ]
      : []),
  ].join(" / ");
}
/** What is left before a first calculation: cards, then each missing condition, each with the control that fixes it. */
export function renderChecklist(host: TeamBuilder, issues = host.inputIssues()) {
  const cards = host.view ? host.view.members.size : 0;
  const cardIssue = issues.find((issue) => issue.field === "tb-cards");
  const emptyBox = !!cardIssue && host.searchSettings.scope === "box" && !cards;
  const rest = issues.filter((issue) => issue.field !== "tb-cards");
  const row = (done: boolean, index: number, title: string, supporting: string, action?: { label: string; run: () => void; primary?: boolean }) => html`
    <li class=${`list-item list-item--two-line tb-check-row${done ? " is-done" : ""}`}>
      <span class="list-item__leading tb-check-row__mark" aria-hidden="true">${done ? icon("check", 20) : index}</span>
      <span class="list-item__body">
        <strong class="list-item__headline">${title}</strong>
        <span class="list-item__supporting">${supporting}</span>
      </span>
      ${action
        ? html`<span class="list-item__trailing"><button class=${`button ${action.primary ? "button--tonal" : "button--text"}`} type="button" @click=${action.run}>${action.label}</button></span>`
        : nothing}
    </li>
  `;
  return html`
    <section class="surface tb-results tb-checklist">
      <h2 class="detail-section-title detail-section-title--h2">
        <span class="detail-section-title__icon" aria-hidden="true">${icon("checklist", 18)}</span>
        <span class="detail-section-title__label">${host.t("stepsLabel", "Steps")}</span>
      </h2>
      <ol class="list">
        ${row(
          !cardIssue,
          1,
          host.t("tabBox", "My cards"),
          cardIssue ? (emptyBox ? host.t("emptyBoxTitle", "No cards imported yet") : cardIssue.message) : host.t("stepCardsDone", "{count} cards", { count: cards }),
          emptyBox
            ? { label: host.t("importMyCards", "Import my cards"), run: () => host.imports.openBox(), primary: true }
            : cardIssue
              ? { label: host.t("adjustCardRange", "Adjust card range"), run: () => void host.focusInput("tb-cards") }
              : { label: host.t("manageCards", "Manage"), run: () => host.setTab("box") },
        )}
        ${rest.length
          ? rest.map((issue, index) =>
              row(false, index + 2, issue.message, host.t("stepRequired", "Required"), {
                label: host.t("pt.fixInput", "Edit"),
                run: async () => {
                  await host.focusInput(issue.field);
                  if (issue.field === "tb-songs" || issue.field === "tb-challenge-songs")
                    host.querySelector<HTMLButtonElement>(`#${issue.field} .tb-songs__add`)?.click();
                },
                primary: !cardIssue && index === 0,
              }),
            )
          : row(true, 2, host.t("conditionsTitle", "Conditions"), conditionSummary(host))}
        ${row(false, rest.length + 2, host.t("readyToCalculate", "Ready to calculate"), issues.length ? host.t("stepWaiting", "Complete the steps above") : host.t("stepRun", "Start from the settings"))}
      </ol>
    </section>
  `;
}

export function toolLayout(host: TeamBuilder, body: unknown, actions: unknown, results: unknown) {
  const summary = conditionSummary(host);
  const mode = host.tab === "build" ? html`<div class="tb-mode">${host.renderBuildMode()}</div>` : nothing;
  const footer = html`
    <div class="tb-operation">${actions}${host.renderCompareTray()}</div>
  `;
  return html`
    <div class=${`tb-tool${host.compactConditions ? " tb-tool--compact" : " tb-tool--desktop"}`}>
      ${
        host.compactConditions
          ? html`
              <section class="tb-condition-summary">
                ${mode}
                <button id="tb-adjust" class="tb-condition-summary__open" type="button" @click=${() => host.openConditions()}>
                  ${icon("tune", 20)}
                  <span class="tb-condition-summary__text">
                    <strong>${host.t("conditionsTitle", "Conditions")}</strong>
                    <span>${summary}</span>
                  </span>
                  ${icon("chevron_right", 20)}
                </button>
              </section>
              ${
                host.conditionsOpen
                  ? html`
                      <dialog
                        class="dialog tb-conditions"
                        data-managed-modal
                        ${modal(() => host.closeConditions())}
                        aria-labelledby="tb-conditions-title"
                      >
                        <header class="tb-conditions__header">
                          ${iconButton({ icon: "close", label: host.common("common.actions.close", "Close"), onClick: () => host.closeConditions() })}
                          <h2 id="tb-conditions-title">${host.t("conditionsTitle", "Conditions")}</h2>
                        </header>
                        <div class="tb-config-body stack">${body}</div>
                        ${footer}
                      </dialog>
                    `
                  : nothing
              }
            `
          : html`
              <aside class="tb-config" aria-label=${host.t("conditionsTitle", "Conditions")}>
                <div class="tb-config-body stack">${mode}${body}</div>
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
