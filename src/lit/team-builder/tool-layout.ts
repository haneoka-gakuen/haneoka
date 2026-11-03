// L3 — GEB
// Input: Existing task form, action and result templates.
// Output: Desktop settings column or immediate-save mobile conditions dialog.
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
/** What is left before a first search: cards, songs, then the search itself. */
function teamSteps(host: TeamBuilder) {
  if (host.tab !== "build" || host.buildMode === "manual" || host.results) return nothing;
  const issues = new Set(host.inputIssues().map((issue) => issue.field));
  const cards = host.view?.members.size ?? 0;
  const cardsDone = !issues.has("tb-cards");
  const songsDone = !issues.has("tb-songs");
  const step = (index: number, done: boolean, active: boolean, label: string, onClick: () => void) => html`
    <li class=${`tb-step${done ? " is-done" : ""}${active ? " is-active" : ""}`}>
      <button type="button" @click=${onClick} ?disabled=${!done && !active} aria-current=${active ? "step" : nothing}>
        <span class="tb-step__mark">${done ? icon("check", 18) : index}</span>
        <span class="tb-step__label">${label}</span>
      </button>
    </li>
  `;
  return html`
    <ol class="tb-steps" aria-label=${host.t("stepsLabel", "Steps")}>
      ${step(1, cardsDone, !cardsDone, cards ? host.t("stepCardsDone", "{count} cards", { count: cards }) : host.t("stepCards", "Import cards"),
        () => host.imports.openBox())}
      ${step(2, songsDone, cardsDone && !songsDone, songsDone ? host.t("chartCount", "{count} charts", { count: host.searchSettings.songs.length }) : host.t("stepSongs", "Choose songs"),
        () => void host.focusInput("tb-songs"))}
      ${step(3, false, cardsDone && songsDone, host.t("findTeams", "Find teams"), () => void host.run())}
    </ol>
  `;
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
      <div class="tb-results-column" id="tb-progress" tabindex="-1">${teamSteps(host)}${results}</div>
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
