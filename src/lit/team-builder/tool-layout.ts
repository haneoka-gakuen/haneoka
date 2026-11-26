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
import { cardScopeLabel } from "./card-input-controls";
import { SCORE_GOALS, scoreGoal, scoreRankName, scoreText } from "./score-goal";

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
  if (host.tab === "build") {
    const chart = goal?.kind === "power" ? goal.song : !count ? null : songs[0];
    const chartLabel = chart && host.catalog
      ? `${host.catalog.songTitle(chart.songId)} · ${host.catalog.difficultyLabel(chart.songId, chart.difficulty)}`
      : null;
    const target = s.scoreTarget === "at-least" && s.targetRank
      ? scoreRankName(s.targetRank) : s.scoreTarget !== "none" && s.targetScore ? String(s.targetScore) : null;
    const goalLabel = manual ? scoreText(host, SCORE_GOALS.mean.label)
      : s.goal === "potential" ? host.t("goalPotential", "Songless potential")
      : s.goal === "power" ? host.t("goalPower", "Highest power")
      : [scoreText(host, SCORE_GOALS[scoreGoal(s)].label), target].filter(Boolean).join(" ");
    return [chartLabel, chartLabel && count > 1 ? `+${count - 1}` : null, goalLabel].filter(Boolean).join(" / ");
  }
  const gekiso = host.tab === "song-comparison" || s.goal === "gekiso" || (s.goal === "event" && s.ptMode === "gekiso");
  const requirements = host.tab !== "song-comparison" && !manual ? [
    ...(s.goal === "gekiso" ? ([[0, "COMBO"], [2, "JUST"], [1, "LUCK"]] as const)
      .filter(([index]) => s.minMissionMembers[index] > 0)
      .map(([index, role]) => `${host.t("missionMemberMinimum", "{role} members (minimum)", { role })} ${s.minMissionMembers[index]}`) : []),
    ...(gekiso && host.hasComboSongs() && s.minComboBonus > 1 ? [`COMBO BONUS ≥ ×${s.minComboBonus}`] : []),
    ...(gekiso && s.justWindowMs > 0 ? [`${host.t(s.justWindowMode === "partial" ? "justCoverage.title" : "justWindowTarget", "JUST window")} ${s.justWindowUnit === "percent" ? `+${s.justWindowPercent}%` : `±${s.justWindowMs} ms`}${s.justWindowMode === "partial" ? ` / ${s.justCoveragePercent ? `${s.justCoveragePercent}%` : host.t("justCoverage.oneNote", "At least one note")}` : ""}`] : []),
  ] : [];
  if (host.tab === "arena")
    return [`${host.catalog!.bandName(host.arena.bandId)} ${host.t("chartCount", "{count} charts", { count })}`, ...requirements].join(" / ");
  return [
    host.tab === "song-comparison" || manual
      ? host.t("manualTeam", "Build a team by hand")
      : cardScopeLabel(host, s),
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
          ...requirements,
        ]
      : []),
  ].join(" / ");
}
type InputIssue = ReturnType<TeamBuilder["inputIssues"]>[number];
interface StepAction {
  label: string;
  run: () => void;
  disabled?: boolean;
}

function fixAction(host: TeamBuilder, issue: InputIssue): StepAction {
  if (issue.rosterFix === "add")
    return { label: host.t("quickEntry", "Quick add"), run: () => host.openRoster(true) };
  if (issue.rosterFix === "include")
    return { label: host.t("includeOwned", "Include owned cards"), run: () => host.openRoster(false) };
  if (issue.field === "tb-cards")
    return { label: host.t("adjustCardRange", "Adjust card range"), run: () => void host.focusInput("tb-candidates-trigger") };
  const songs = issue.field === "tb-songs" || issue.field === "tb-challenge-songs";
  return {
    label: songs ? host.t("chooseSongs", "Choose songs") : host.t("pt.fixInput", "Edit"),
    run: async () => {
      await host.focusInput(issue.field);
      if (songs) host.querySelector<HTMLButtonElement>(`#${issue.field} .tb-songs__add`)?.click();
    },
  };
}

/** Each prerequisite links to the control that can satisfy it. */
export function renderChecklist(host: TeamBuilder, issues = host.inputIssues()) {
  if (!host.submitted) issues = issues.filter(issue => !issue.validation);
  const cardIssue = issues.find(issue => issue.field === "tb-cards");
  const rest = issues.filter(issue => issue !== cardIssue);
  const row = (done: boolean, index: number, title: string, supporting: string, actions: StepAction[] = [], primary = false) => html`
    <li class=${`list-item list-item--two-line tb-check-row${done ? " is-done" : ""}`}>
      <span class="list-item__leading tb-check-row__mark" aria-hidden="true">${done ? icon("check", 20) : index}</span>
      <span class="list-item__body">
        <strong class="list-item__headline">${title}</strong>
        ${supporting ? html`<span class="list-item__supporting">${supporting}</span>` : nothing}
        ${actions.length ? html`<span class="cluster tb-check-actions">${actions.map((action, i) => html`
          <button class=${`button ${primary && i === 0 ? "button--tonal" : "button--text"}`} type="button"
            ?disabled=${action.disabled} @click=${action.run}>${action.label}</button>`)}
        </span>` : nothing}
      </span>
    </li>
  `;
  const cardActions = cardIssue ? [fixAction(host, cardIssue)]
    : [{ label: host.t("manageCards", "Manage"), run: () => host.setTab("box") }];
  if (cardIssue?.rosterFix === "add") cardActions.push(
    { label: host.t("boxImport.groupSave", "Game save"), run: () => host.imports.openBox() },
    { label: host.t("boxImport.screenshots", "Screenshots or screen recording"), run: () => host.imports.openScreenshots() },
  );
  return html`
    <section class="surface tb-results tb-checklist" role=${host.submitted && issues.length ? "alert" : nothing}>
      <h2 class="detail-section-title detail-section-title--h2">
        <span class="detail-section-title__icon" aria-hidden="true">${icon("checklist", 18)}</span>
        <span class="detail-section-title__label">${host.t("stepsLabel", "Steps")}</span>
      </h2>
      <ol class="list">
        ${row(
          !cardIssue,
          1,
          cardScopeLabel(host, host.searchSettings),
          cardIssue?.message ?? host.t("eligibleCharacters", "{count}/5 eligible characters", { count: 5 }),
          cardActions,
          !!cardIssue,
        )}
        ${rest.length
          ? rest.map((issue, index) => {
              const actions = [fixAction(host, issue)];
              if (host.tab === "arena" && issue.field === "tb-songs") actions.unshift({
                label: host.t("arena.usePool", "Use league songs"), run: () => host.arena.selectPool(),
                disabled: !host.arena.allowedCharts.length || !host.songPoolDifficulties.length,
              });
              return row(false, index + 2, issue.message, issue.validation ? "" : host.t("stepRequired", "Required"), actions, !cardIssue && index === 0);
            })
          : row(true, 2, host.t("conditionsTitle", "Conditions"), conditionSummary(host))}
        ${row(false, rest.length + 2, issues.length ? host.t("fixConditions", "Adjust {count} conditions", { count: issues.length }) : host.t("readyToCalculate", "Ready to calculate"), issues.length ? "" : host.t("stepRun", "Start from the settings"))}
      </ol>
    </section>
  `;
}

export function mobilePrerequisite(host: TeamBuilder) {
  const issue = host.inputIssues().find(item => !item.validation);
  if (!issue) return null;
  const action = fixAction(host, issue);
  return html`<button class="button button--full" type="button" @click=${action.run}>${action.label}</button>`;
}

export function toolLayout(host: TeamBuilder, body: unknown, actions: unknown, results: unknown, options?: { summary?: string; validate?: boolean; mobileAction?: unknown }) {
  const settings = () => typeof body === "function" ? body() : body;
  const summary = options?.summary ?? conditionSummary(host);
  const issues = options?.validate !== false && host.submitted && (["arena", "pt", "live", "challenge"].includes(host.tab) || host.tab === "build" && host.buildMode !== "manual")
    ? host.inputIssues(host.tab === "pt" && host.searchSettings.rewardMode === "recommendation") : [];
  const mode = host.tab === "build" || (host.classicLayout && host.tab === "live")
    ? html`<div class="tb-mode">${host.renderBuildMode()}</div>` : nothing;
  const footer = (mobile = false) => html`
    <div class="tb-operation">${mobile && options?.mobileAction ? options.mobileAction : actions}${host.renderCompareTray()}</div>
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
                        <div class="tb-config-body stack">${settings()}</div>
                        ${footer()}
                      </dialog>
                    `
                  : nothing
              }
            `
          : html`
              <aside class="tb-config" aria-label=${host.t("conditionsTitle", "Conditions")}>
                <div class="tb-config-body stack">${mode}${settings()}</div>
                ${footer()}
              </aside>
            `
      }
      <div class="tb-results-column" id="tb-progress" tabindex="-1">${issues.length ? renderChecklist(host, issues) : results}</div>
      ${
        host.compactConditions && !host.conditionsOpen
          ? html`
              <div class="tb-mobile-operation">${footer(true)}</div>
            `
          : nothing
      }
    </div>
  `;
}
