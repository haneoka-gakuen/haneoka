import { rangeRankControl } from "./gekiso-rank";
/** Saved teams, a manual formation and its evaluation across songs, with swap suggestions. */
import { html, nothing, type TemplateResult } from "lit";
import { live } from "lit/directives/live.js";
import { cache } from "lit/directives/cache.js";
import type { EngineHit } from "../../lib/team-builder/engine/api";
import { cardIdOf, engineInputs, type SavedTeam } from "../../lib/team-builder/sync/box-view";
import { iconButton } from "../ui/controls";
import { icon } from "../ui/icon";
import { tileMedia } from "../ui/tile";
import { specList } from "../ui/spec";
import { sectionHeading } from "./catalog";
import { songRulesControl } from "./song-rules";
import { renderResultDetails, resultSong, saveTeam, teamFormation } from "./results";
import { accordion } from "../ui/accordion";
import { attachManualResults, clearManualOrders, manualOrderScore, manualResultHit, manualResultRequest, manualResultSettings, snapshotManualResults } from "./manual-results";
import { resultRequest } from "./score-goal";
import { renderSongComparison } from "./song-comparison-view";
import { toolLayout } from "./tool-layout";
import { eventSection, gekisoSamplingAdvanced, justWindowControl, playConditions, songList } from "./build-tab";
import { segmented } from "../ui/controls";
import { clock } from "../../lib/team-builder/engine/execution";
import { compareHits } from "../../lib/team-builder/engine/merge";
import type { TeamBuilder } from "../team-builder";

const format = (host: TeamBuilder, value: number, digits = 0) =>
  new Intl.NumberFormat(host.locale, { maximumFractionDigits: digits }).format(value);
export function manualReady(host: TeamBuilder) {
  const inputs = host.manualInputs();
  return (
    host.manual.members.every((id) => id !== null) &&
    inputs.members.length === 5 &&
    inputs.snaps.length === host.manual.snaps.filter((id) => id !== null).length &&
    new Set(host.manual.members.map((id) => host.catalog!.member(id!)?.characterId)).size === 5
  );
}
function teamSpec(host: TeamBuilder, team = host.manual) {
  const { members, snaps, leader } = team;
  return {
    members: members.map((id) => `m${id}`),
    snaps: snaps.map((id) => (id === null ? null : `s${id}`)),
    leader: `m${members[leader]}`,
  };
}
function manualSamplingReady(host: TeamBuilder): boolean {
  const goal = host.manualGoal();
  if (goal.kind !== "gekiso") return true;
  const invalidSamples = !Number.isInteger(goal.seeds) || goal.seeds < 0;
  const window = host.hasMission("JustCount", goal.songs) ? host.searchSettings.justWindowMs : 0;
  if (!invalidSamples && Number.isInteger(window) && window >= 0) return true;
  host.submitted = true;
  host.error = invalidSamples ? host.t("pt.invalidSamples", "Enter zero or a positive integer")
    : host.t("invalidCombo", "Enter a positive integer");
  host.requestUpdate();
  void host.focusInput(invalidSamples ? "tb-luck-samples" : "tb-just-window");
  return false;
}
/** Evaluates the manual team; a stale baseline is evaluated again under the same conditions. */
export async function evaluate(host: TeamBuilder) {
  if (!manualReady(host) || !host.engine || !host.manualGoal().songs.length || host.running) return;
  if (!manualSamplingReady(host)) return;
  const task = host.acquireTask("evaluation");
  if (!task) return;
  const context = host.manualContext();
  host.activeManualContext = context;
  host.manualBusy = true;
  host.requestUpdate();
  const goal = host.manualGoal();
  const conditions = host.manualConditions();
  const settings = manualResultSettings(host, goal);
  const run = async (team: typeof host.manual, previous?: NonNullable<typeof host.manualResults>) => {
    const input = manualResultRequest(host, team, goal);
    const rows = await host.engine!.evaluate({
      members: input.members,
      snaps: input.snaps,
      player: input.player,
      unknownPolicy: input.unknownPolicy,
      songRules: input.songRules,
      team: teamSpec(host, team),
      songs: goal.songs,
      play: goal.kind === "score" ? goal.play : { great: 0, good: 0, bad: 0, miss: 0 },
      ...(goal.kind === "gekiso" ? { gekiso: { accuracy: goal.accuracy, rank: goal.rank, ranks: goal.ranks, seeds: goal.seeds, minJustWindowMs: goal.minJustWindowMs } } : {}),
      challengeEventId: goal.kind === "score" ? goal.challengeEventId : null,
      event: null,
    });
    return attachManualResults(host, rows, team, input, settings, previous);
  };
  try {
    const results = await run(host.manual);
    const baseline = host.manualBaseline;
    const baselineResults =
      baseline && baseline.conditions !== conditions && !host.manualPin ? await run(baseline.team, baseline.results) : null;
    if (host.ownsTask(task) && context === host.manualContext()) {
      host.manualResultsFor = context;
      host.manualResults = results;
      if (host.manualPin) host.manualBaseline = { team: structuredClone(host.manual), results: snapshotManualResults(results), conditions };
      else if (baseline && baselineResults && host.manualBaseline === baseline) host.manualBaseline = { ...baseline, results: baselineResults, conditions };
      host.manualPin = false;
    }
  } catch (error) {
    if (host.ownsTask(task) && !(error instanceof DOMException && error.name === "AbortError"))
      host.error = host.errorReason(error);
  } finally {
    if (host.ownsTask(task)) {
      host.manualBusy = false;
      host.activeManualContext = "";
    }
    host.releaseTask(task);
    host.requestUpdate();
  }
}
/** The difference from the baseline, signed and coloured. */
function delta(host: TeamBuilder, value: number | undefined, base: number | undefined) {
  if (value === undefined || base === undefined) return nothing;
  const change = value - base;
  return html`
    <small class="tb-delta" data-sign=${change > 0 ? "up" : change < 0 ? "down" : "same"}>
      ${change > 0 ? "+" : change < 0 ? "−" : "±"}${format(host, Math.abs(change))}
    </small>
  `;
}
/** The pinned formation as faces, with the action that pins or clears it. */
function baselineBar(host: TeamBuilder, ready: boolean) {
  const baseline = host.manualBaseline;
  const catalog = host.catalog!;
  const pin = () => {
    host.manualBaseline = {
      team: structuredClone(host.manual),
      results: snapshotManualResults(host.manualResults!),
      conditions: host.manualConditions(),
    };
    host.manualPin = false;
    host.requestUpdate();
  };
  const { members, snaps, leader } = baseline?.team ?? { members: [null, null, null, null, null], snaps: [null, null, null, null, null], leader: 2 };
  const order = [0, 1, 2, 3, 4].filter((index) => index !== leader);
  order.splice(2, 0, leader);
  return html`
    <div class="tb-baseline cluster">
      <span class="tb-baseline__label">${host.t("baseline", "Baseline")}</span>
      <span class="tb-baseline__faces">
        ${order.map((index) => {
          const card = members[index] === null ? undefined : catalog.member(members[index]!);
          const snap = snaps[index] === null ? undefined : catalog.snap(snaps[index]!);
          return html`
            <span class="tb-baseline__slot" title=${card ? catalog.characterName(card.characterId) : ""}>
              ${card ? html`<img src=${card.image || catalog.characterFace(card.characterId)} alt="" width="32" height="32" loading="lazy" decoding="async" />` : nothing}
              ${snap ? html`<img class="tb-baseline__snap" src=${snap.image} alt="" width="20" height="20" loading="lazy" decoding="async" />` : nothing}
            </span>
          `;
        })}
      </span>
      <button class="icon-button" type="button" ?disabled=${!ready || host.running || host.manualBusy}
        aria-label=${host.t(baseline ? "replaceBaseline" : "pinBaseline", baseline ? "Update baseline" : "Set as baseline")}
        title=${host.t(baseline ? "replaceBaseline" : "pinBaseline", baseline ? "Update baseline" : "Set as baseline")}
        @click=${pin}>${icon("push_pin", 20)}</button>
      ${iconButton({ icon: "close", label: host.t("clearBaseline", "Clear baseline"), size: 18, disabled: !baseline, onClick: () => { host.manualBaseline = null; host.manualPin = false; host.requestUpdate(); } })}
    </div>
  `;
}
/** Best cards for one slot with the other four fixed (exact constrained search). */
async function suggest(host: TeamBuilder, slot: number) {
  const base = host.request(host.manualGoal());
  if (!base || !host.engine || !manualReady(host) || host.running) return;
  if (!manualSamplingReady(host)) return;
  const task = host.acquireTask("suggestion");
  if (!task) return;
  const context = host.manualSuggestionContext();
  host.activeManualContext = context;
  host.manualSuggesting = slot;
  host.manualSuggestions = null;
  host.requestUpdate();
  const { members, snaps, leader } = host.manual;
  const others = members.flatMap((id, index) =>
    index === slot || id === null ? [] : [{ member: id, snap: snaps[index] ?? null, leader: index === leader }],
  );
  const selected = host.manualInputs();
  const owned = engineInputs(host.view!, true);
  const ownedMembers = new Map(owned.members.map((row) => [row.key, row]));
  const ownedSnaps = new Map(owned.snaps.map((row) => [row.key, row]));
  const memberInputs = [
    ...new Map(
      [...base.members.map((row) => ownedMembers.get(row.key) ?? row), ...selected.members].map((row) => [
        row.key,
        row,
      ]),
    ).values(),
  ];
  const snapInputs = [
    ...new Map(
      [...base.snaps.map((row) => ownedSnaps.get(row.key) ?? row), ...selected.snaps].map((row) => [row.key, row]),
    ).values(),
  ];
  const constraints = {
    requiredMembers: others.map((row) => `m${row.member}`),
    leader: slot === leader ? null : `m${members[leader]}`,
    bindings: others.map((row): [string, string | null] => [
      `m${row.member}`,
      row.snap === null ? null : `s${row.snap}`,
    ]),
    excludedMembers: [`m${members[slot]}`],
    requiredSnaps: [],
    excludedSnaps: [],
    noSnaps: false,
    minBonusPercent: null,
  };
  const request = {
    ...base,
    members: memberInputs,
    snaps: snapInputs,
    unknownPolicy: host.settings.unknownPolicy,
    constraints,
    k: 3,
    deadline: base.timeLimitMs === null ? Infinity : clock() + base.timeLimitMs,
  };
  try {
    let hits: EngineHit[] = [];
    const leaders =
      slot === leader
        ? memberInputs.filter((row) => !members.includes(row.cardId)).map((row) => row.key)
        : [constraints.leader];
    for (const candidate of leaders) {
      if (!host.ownsTask(task) || context !== host.manualSuggestionContext() || clock() >= request.deadline) break;
      const result = await host.engine.run({ ...request, constraints: { ...constraints, leader: candidate } });
      if (result.error) throw new Error(result.error);
      hits.push(...result.overall);
    }
    if (host.ownsTask(task) && context === host.manualSuggestionContext()) {
      const seen = new Set<string>();
      hits = hits.sort(compareHits).filter((hit) => {
        const member = hit.members.find((key) => !others.some((row) => key === `m${row.member}`))!;
        if (seen.has(member)) return false;
        seen.add(member);
        return true;
      });
      host.manualSuggestionsFor = context;
      host.manualSuggestions = { slot, hits: hits.slice(0, 3) };
    }
  } catch (error) {
    if (host.ownsTask(task) && !(error instanceof DOMException && error.name === "AbortError"))
      host.error = host.errorReason(error);
  } finally {
    if (host.ownsTask(task)) {
      host.manualSuggesting = -1;
      host.activeManualContext = "";
    }
    host.releaseTask(task);
    host.requestUpdate();
  }
}


function savedFormation(team: SavedTeam) {
  const leader = team.leader === null ? 0 : team.members.indexOf(team.leader);
  return { members: [...team.members], snaps: [...team.snaps], leader: leader < 0 ? 0 : leader };
}
export function renderTeamsTab(host: TeamBuilder): TemplateResult {
  return renderTeamWorkspace(host, "teams");
}
export function renderSongComparisonTab(host: TeamBuilder): TemplateResult {
  return renderTeamWorkspace(host, "comparison");
}
export function renderManualTeamTab(host: TeamBuilder): TemplateResult {
  return renderTeamWorkspace(host, "manual");
}
function renderTeamWorkspace(host: TeamBuilder, mode: "teams" | "manual" | "comparison"): TemplateResult {
  const comparison = mode === "comparison";
  const catalog = host.catalog!;
  const view = host.view!;
  const visualOrder = [0, 1, 2, 3, 4].filter((index) => index !== host.manual.leader);
  visualOrder.splice(2, 0, host.manual.leader);
  const characters = host.manual.members.map((id) => (id === null ? null : (catalog.member(id)?.characterId ?? null)));
  const duplicate = characters.some((id, index) => id !== null && characters.indexOf(id) !== index);
  const context = host.manualContext();
  const results = host.manualResultsFor === context ? host.manualResults : null;
  const rows = host.manualGoal().songs.map((song) => ({ song,
    row: results?.find((result) => result.song.songId === song.songId && result.song.difficulty === song.difficulty) ?? null }));
  const baseline = host.manualBaseline && host.manualBaseline.conditions === host.manualConditions() ? host.manualBaseline : null;
  const baseOf = (song: { songId: number; difficulty: number }) =>
    baseline?.results.find((row) => row.song.songId === song.songId && row.song.difficulty === song.difficulty);
  const suggestions = host.manualSuggestions && host.manualSuggestionsFor === host.manualSuggestionContext() ? host.manualSuggestions : null;
  const suggesting = host.manualSuggesting;
  const calculating = host.taskKind === "evaluation" || host.taskKind === "suggestion";
  const showSkipScore = host.settings.manualScoreMode !== "gekiso";
  const editor = html`
    <section id="sc-formation" data-sc-field class="surface stack">
      <div class="row row--between row--wrap">
        ${sectionHeading({ icon: "edit_square", label: host.t("manualTeam", "Build a team by hand") })}
        <div class="cluster">
          ${
            !comparison
              ? html`
                  <button
                    class="button button--text"
                    type="button"
                    ?disabled=${!manualReady(host)}
                    @click=${() => { host.songComparison.update({songRules: host.songRules(host.manualGoal())}); host.openSongComparison(); }}
                  >
                    ${host.t("sc.useTeam", "Compare songs with this team")}
                  </button>
                `
              : nothing
          }
          <button
            class="button button--text button--small"
            type="button"
            ?disabled=${!manualReady(host)}
            @click=${() => saveTeam(host, [host.manual.members[host.manual.leader]!, ...(host.manual.members.filter((_, index) => index !== host.manual.leader) as number[])], [host.manual.snaps[host.manual.leader] ?? null, ...host.manual.snaps.filter((_, index) => index !== host.manual.leader)], (comparison ? host.songComparison.settings.songs[0] : host.settings.songs[0]) ?? null)}
          >
            ${icon("bookmark_add", 18)}${host.t("saveTeam", "Save team")}
          </button>
          <button
            class="button button--text button--small"
            type="button"
            @click=${() => {
              clearManualOrders(host);
              host.manual = {
                members: [null, null, null, null, null],
                snaps: [null, null, null, null, null],
                leader: 2,
              };
              host.manualResults = null;
              host.manualSuggestions = null;
              host.requestUpdate();
            }}
          >
            ${host.common("common.actions.clear", "Clear")}
          </button>
        </div>
      </div>
      ${
        comparison && view.teams.length
          ? html`
              <md-outlined-select
                label=${host.t("sc.chooseTeam", "Use a saved team")}
                .value=${""}
                @change=${(event: Event) => {
                  const team = view.teams.find((team) => team.id === (event.target as HTMLSelectElement).value);
                  if (team) {
                    host.manualSuggestions = null;
                    host.openSongComparison(savedFormation(team));
                  }
                  (event.target as HTMLSelectElement).value = "";
                }}
              >
                <md-select-option value="">
                  <div slot="headline">${host.t("sc.select", "Choose")}</div>
                </md-select-option>
                ${view.teams.map(
                  (team) => html`
                    <md-select-option .value=${team.id}><div slot="headline">${team.name}</div></md-select-option>
                  `,
                )}
              </md-outlined-select>
            `
          : nothing
      }
      ${
        !comparison
          ? html`
              ${segmented({
                label: host.t("scope", "Cards"),
                value: host.settings.scope,
                options: [
                  { value: "box", label: host.t("scopeBox", "My cards") },
                  { value: "theoretical", label: host.t("manualAllCards", "All cards; unowned at max growth") },
                ],
                onSelect: (scope) => host.updateSettings({ scope }),
              })}
              <span class="tb-results__meta">${host.t("manualGrowth", "Owned cards: recorded growth")}</span>
            `
          : nothing
      }
      <ol class="tb-formation tb-formation--edit" aria-label=${host.t("formation", "Formation")}>
        ${visualOrder.map((slot) => {
          const member = host.manual.members[slot];
          const snap = host.manual.snaps[slot];
          const memberOptions = member !== null && member !== undefined ? catalog.cardOptions("members", member) : null;
          const snapOptions = snap !== null && snap !== undefined ? catalog.cardOptions("snaps", snap) : null;
          const leader = slot === host.manual.leader;
          return html`
            <li id=${`sc-slot-${slot}`} data-sc-field tabindex="-1" class=${`tb-slot${leader ? " is-leader" : ""}`}>
              <button
                class="tb-slot__member"
                type="button"
                @click=${() => {
                  host.slotPicker = { slot, kind: "members" };
                  host.requestUpdate();
                }}
                aria-label=${memberOptions ? `${host.t("pickMember", "Choose a member")}: ${memberOptions.label}` : host.t("pickMember", "Choose a member")}
              >
                ${
                  memberOptions
                    ? tileMedia(memberOptions)
                    : html`
                        <span class="tb-slot__empty">${icon("person_add", 24)}</span>
                      `
                }
              </button>
              <button
                class="tb-slot__snap"
                type="button"
                @click=${() => {
                  host.slotPicker = { slot, kind: "snaps" };
                  host.requestUpdate();
                }}
                aria-label=${snapOptions ? `${host.t("pickSnap", "Choose a snap")}: ${snapOptions.label}` : host.t("pickSnap", "Choose a snap")}
              >
                ${
                  snapOptions
                    ? tileMedia(snapOptions)
                    : html`
                        <span class="tb-slot__empty">${icon("add_photo_alternate", 20)}</span>
                      `
                }
              </button>
              <span class="tb-slot__tools">
                <button
                  class=${`chip tb-slot__leader${leader ? " is-selected" : ""}`}
                  type="button"
                  aria-pressed=${String(leader)}
                  ?disabled=${member === null}
                  @click=${() => {
                    host.manual = { ...host.manual, leader: slot };
                    host.manualResults = null;
                    host.requestUpdate();
                  }}
                >
                  ${icon(leader ? "star" : "star_outline", 18)}<span class="chip__label">${host.t("leader", "Leader")}</span>
                </button>
                ${
                  !comparison
                    ? html`<button
                        class="button button--text button--small tb-slot__suggest"
                        type="button"
                        title=${host.t("suggestSlot", "Best card for this slot")}
                        ?disabled=${host.running || !manualReady(host) || suggesting >= 0 || !host.manualGoal().songs.length}
                        @click=${() => void suggest(host, slot)}
                      >
                        ${icon("auto_fix_high", 18)}<span>${host.t("suggestShort", "Suggest")}</span>
                      </button>`
                    : nothing
                }
            </li>
          `;
        })}
      </ol>
      ${
        !comparison && duplicate
          ? html`
              <p class="field-note field-note--error">
                ${host.t("duplicateCharacter", "Each character can appear once.")}
              </p>
            `
          : nothing
      }
      ${
        !comparison && suggestions
          ? html`
              <div class="stack tb-suggest">
                <strong class="tb-subtitle">${host.t("suggestions", "Best replacements")}</strong>
                ${
                  suggestions.hits.length
                    ? suggestions.hits.map((hit) => {
                        const slotMember = hit.members.find((key) => !host.manual.members.includes(cardIdOf(key)));
                        const index = slotMember ? hit.members.indexOf(slotMember) : -1;
                        const snapKey = index >= 0 ? hit.snaps[index] : null;
                        if (!slotMember) return nothing;
                        return html`
                          <div class="list-item list-item--two-line">
                            <span class="list-item__leading tb-suggest__art">
                              ${tileMedia(catalog.cardOptions("members", cardIdOf(slotMember))!)}
                            </span>
                            <span class="list-item__body">
                              <strong class="list-item__headline">
                                ${catalog.cardName("members", cardIdOf(slotMember))}
                              </strong>
                              <span class="list-item__supporting">
                                ${snapKey ? catalog.cardName("snaps", cardIdOf(snapKey)) : host.t("noSnap", "No snap")}
                                / ${host.t("power", "Power")}
                                ${format(host, hit.power)}${hit.score ? ` / ${format(host, hit.score.mean)}` : ""}${hit.event ? ` / ${format(host, hit.event.mean, 1)} pt` : ""}
                              </span>
                            </span>
                            <span class="list-item__trailing">
                              <button
                                class="button button--tonal button--small"
                                type="button"
                                @click=${() => {
                                  const members = [...host.manual.members];
                                  const snaps = [...host.manual.snaps];
                                  members[suggestions!.slot] = cardIdOf(slotMember);
                                  snaps[suggestions!.slot] = snapKey ? cardIdOf(snapKey) : null;
                                  host.manual = { ...host.manual, members, snaps };
                                  host.manualSuggestions = null;
                                  host.manualResults = null;
                                  host.requestUpdate();
                                }}
                              >
                                ${host.t("apply", "Apply")}
                              </button>
                            </span>
                          </div>
                        `;
                      })
                    : html`
                        <p class="card__supporting">${host.t("noSuggestion", "No better card found.")}</p>
                      `
                }
              </div>
            `
          : nothing
      }
    </section>
  `;
  if (mode === "manual")
    return html`
      <div class="tb-teams stack stack--loose">
        ${toolLayout(
          host,
          html`
            <section class="surface stack">
              ${sectionHeading({ icon: "flag", label: host.t("goal", "Goal") })}
              ${segmented({
              label: host.t("goal", "Goal"),
              value: host.settings.manualScoreMode,
              options: [
                { value: "score", label: host.t("goalScore", "Live score") },
                { value: "gekiso", label: host.t("goalGekiso", "GEKISO score") },
              ],
              onSelect: (manualScoreMode) => host.updateSettings({ manualScoreMode }),
            })}
            </section>
            <section class="surface stack">
              ${sectionHeading({ icon: "library_music", label: host.t("songs", "Songs"), count: host.manualGoal().songs.length || undefined })}
              ${songList(
              host,
              host.settings.songs,
              (songs) => host.updateSettings({ songs }),
              false,
              showSkipScore && host.settings.challengeRules && host.settings.eventId !== null
                ? catalog.challengeSongs(host.settings.eventId).map((row) => row.liveMusicId)
                : undefined,
            )}
              ${songRulesControl(host)}
            </section>
            <section class="surface stack">
              ${sectionHeading({ icon: "piano", label: host.t("farm.conditions", "Play and account conditions") })}
              ${playConditions(host, { ...host.searchSettings, goal: showSkipScore ? "score" : "gekiso" })}
              ${showSkipScore ? nothing : justWindowControl(host)}
              ${
              showSkipScore
                ? html`
                    <label class="tb-check">
                      <md-checkbox
                        touch-target="wrapper"
                        .checked=${live(host.settings.challengeRules)}
                        @change=${(event: Event) => host.updateSettings({ challengeRules: (event.target as HTMLInputElement).checked })}
                      ></md-checkbox>
                      <span>${host.t("challengeRules", "Challenge live rules (event parameter bonus)")}</span>
                    </label>
                    ${host.settings.challengeRules ? eventSection(host, { ...host.settings, goal: "score" }) : nothing}
                  `
                : html`
                    ${rangeRankControl(host, host.settings.gekisoRanks, (range, rank) => {
                      const gekisoRanks = [...host.settings.gekisoRanks] as typeof host.settings.gekisoRanks;
                      gekisoRanks[range] = rank;
                      host.updateSettings({ gekisoRanks });
                    })}
                    ${gekisoSamplingAdvanced(host)}
                  `
            }
              <span class="tb-field__label">${host.t("unknownPolicy", "Growth not entered")}</span>
              ${segmented({
              label: host.t("unknownPolicy", "Growth not entered"),
              value: host.settings.unknownPolicy,
              options: [
                { value: "max", label: host.t("unknownMax", "Count as max") },
                { value: "min", label: host.t("unknownMin", "Count as minimum") },
              ],
              onSelect: (unknownPolicy) => host.updateSettings({ unknownPolicy }),
            })}
            </section>
          `,
          html`
            <div class="tb-run">
              <button
                class="button tb-run__button"
                type="button"
                ?disabled=${!calculating && (!manualReady(host) || duplicate || !host.manualGoal().songs.length || host.running || (showSkipScore && host.settings.challengeRules && host.settings.eventId === null))}
                @click=${() => (calculating ? host.cancel() : void evaluate(host))}
              >
                ${calculating ? icon("close", 18) : icon("calculate", 18)}${calculating ? host.common("common.actions.cancel", "Cancel") : host.t("evaluateTeam", "Evaluate on the chosen songs")}
              </button>
              <div class="tb-manual__progress">
                ${
                calculating
                  ? html`
                      <md-linear-progress
                        indeterminate
                        aria-label=${host.t("evaluating", "Evaluating")}
                      ></md-linear-progress>
                    `
                  : nothing
              }
              </div>
            </div>
          `,
          html`
            <div class="stack stack--flex stack--loose">
              ${editor}
              <section class="surface stack stack--flex tb-manual__scores">
                <div class="row row--between row--wrap">
                  ${sectionHeading({ icon: "query_stats", label: showSkipScore ? host.t("goalScore", "Live score") : host.t("goalGekiso", "GEKISO score"), count: rows.length || undefined })}
                  ${baselineBar(host, !!results && manualReady(host))}
                </div>
                <div class="stack stack--flex stack--loose">
                  ${rows.map(({ song, row }) => {
                    const hit = row ? manualResultHit(row) : null;
                    const key = `manual:${song.songId}:${song.difficulty}`;
                    const expanded = host.expanded.has(key);
                    const base = baseOf(song);
                    const reference = hit ? host.comparison.idFor(host, hit) : null;
                    const compared = !!reference && host.comparison.items.some((item) => item.id === reference);
                    return html`
                      <article class="card card--outlined tb-hit">
                        ${resultSong(host, song, (hit ? resultRequest(host, hit)?.songRules : host.songRules(host.manualGoal())) ?? null)}
                        <div class="card__body stack stack--flex">
                          <div class="tb-manual__metrics">${specList([
                            { label: host.t("expectedScore", "Average score"), value: row ? html`${format(host, row.score.mean)} ${delta(host, row.score.mean, base?.score.mean)}` : "—" },
                            { label: host.t("selectedOrderScore", "Selected-order score"), value: row ? html`${format(host, manualOrderScore(row)!)} ${delta(host, manualOrderScore(row), base ? manualOrderScore(base) : undefined)}` : "—" },
                            { label: host.t("power", "Power"), value: row ? html`${format(host, row.power)} ${delta(host, row.power, base?.power)}` : "—" },
                            { label: host.t("scoreRange", "Range"), value: row ? `${format(host, row.score.min)} – ${format(host, row.score.max)}` : "—" },
                          ], { numeric: true })}</div>
                          ${row && hit ? html`
                            <div class="cluster">
                              <button class="button button--tonal" type="button" ?disabled=${host.running}
                                @click=${() => host.teamGrowth.openManual(row)}>${host.t("tg.title", "Team growth comparison")}</button>
                              <button class="button button--text" type="button" aria-pressed=${compared}
                                @click=${() => host.comparison.toggle(host, hit)}>${host.t(compared ? "comparisonAdded" : "addComparison", compared ? "Added to comparison" : "Add to comparison")}</button>
                            </div>
                            ${accordion({
                              id: `tb-${key.replaceAll(":", "-")}`,
                              label: host.t("moreDetail", "Details"),
                              expanded,
                              onExpandedChange: (open) => {
                                if (open) host.expanded.add(key); else host.expanded.delete(key);
                                host.requestUpdate();
                              },
                              content: cache(expanded ? renderResultDetails(host, hit) : nothing),
                            })}
                          ` : nothing}
                        </div>
                      </article>
                    `;
                  })}
                </div>
              </section>
            </div>
          `,
        )}

      </div>
    `;
  if (comparison)
    return html`
      <div class="tb-teams stack stack--loose">${renderSongComparison(host, editor)}</div>
    `;
  return html`
    <div class="tb-teams stack stack--loose">
      ${comparison ? renderSongComparison(host) : nothing}
      ${
        mode === "teams"
          ? html`
              <section class="surface stack">
                <div class="row row--between row--wrap">
                  ${sectionHeading({ icon: "bookmarks", label: host.t("savedTeams", "Saved teams"), count: view.teams.length || undefined })}
                  <button
                    class="button button--tonal"
                    type="button"
                    @click=${() => {
                      host.buildMode = "manual";
                      host.setTab("build");
                    }}
                  >
                    ${icon("add", 18)}${host.t("manualTeam", "Build a team by hand")}
                  </button>
                </div>
                ${
                  view.teams.length
                    ? html`
                        <div class="tb-saved">
                          ${view.teams.map(
                            (team) => html`
                              <article class="card card--outlined tb-saved__team">
                                <div class="tb-saved__head">
                                  <md-outlined-text-field
                                    class="tb-saved__name"
                                    label=${host.t("teamName", "Name")}
                                    .value=${live(team.name)}
                                    @change=${(e: Event) => host.write([{ key: `team.${team.id}`, value: { ...team, name: (e.target as HTMLInputElement).value.slice(0, 80) } }])}
                                  ></md-outlined-text-field>
                                  ${iconButton({
                                    icon: "delete",
                                    label: host.t("delete", "Delete"),
                                    onClick: () => {
                                      host.write([{ key: `team.${team.id}`, value: null }]);
                                      host.notice = host.t("deletedTeam", "Team deleted");
                                      host.requestUpdate();
                                    },
                                  })}
                                </div>
                                ${teamFormation(host, team.members.map((member, index) => ({
                                  member,
                                  snap: team.snaps[index] ?? null,
                                })), team.leader === null ? -1 : team.members.indexOf(team.leader))}
                                ${
                                  team.song
                                    ? html`
                                        <span class="tb-saved__song">
                                          ${icon("music_note", 18)}${catalog.songTitle(team.song.songId)}
                                          <small>${catalog.difficultyLabel(team.song.songId, team.song.difficulty)}</small>
                                        </span>
                                      `
                                    : nothing
                                }
                                <div class="tb-saved__actions">
                                  <button
                                    class="button button--tonal"
                                    type="button"
                                    @click=${() => {
                                      clearManualOrders(host);
                                      host.buildMode = "manual";
                                      host.setTab("build");
                                      host.manual = savedFormation(team);
                                      host.manualResults = null;
                                      host.manualSuggestions = null;
                                      if (
                                        team.song &&
                                        !host.settings.songs.some(
                                          (song) =>
                                            song.songId === team.song!.songId &&
                                            song.difficulty === team.song!.difficulty,
                                        )
                                      )
                                        host.updateSettings({ songs: [...host.settings.songs, team.song] });
                                      host.requestUpdate();
                                    }}
                                  >
                                    ${icon("edit", 18)}${host.t("loadTeam", "Open in the editor")}
                                  </button>
                                  <button
                                    class="button button--text"
                                    type="button"
                                    @click=${() => {
                                      host.manualSuggestions = null;
                                      host.openSongComparison(savedFormation(team));
                                    }}
                                  >
                                    ${host.t("sc.useTeam", "Compare songs with this team")}
                                  </button>
                                </div>
                              </article>
                            `,
                          )}
                        </div>
                      `
                    : html`
                        <div class="state"><span class="state__icon">${icon("bookmarks", 40)}</span><p class="state__title">${host.t("noSavedTeamsShort", "No saved teams")}</p></div>
                      `
                }
              </section>
            `
          : nothing
      }

    </div>
  `;
}
