import { matchesCardFilters, renderCardFilters } from "./card-filters";
/** Saved teams, a manual formation and its evaluation across songs, with swap suggestions. */
import { html, nothing, type TemplateResult } from "lit";
import { live } from "lit/directives/live.js";
import type { EngineHit } from "../../lib/team-builder/engine/api";
import { cardIdOf, engineInputs, type SavedTeam } from "../../lib/team-builder/sync/box-view";
import { iconButton } from "../ui/controls";
import { icon } from "../ui/icon";
import { selectionPane } from "../ui/selection-pane";
import { tileMedia } from "../ui/tile";
import { specList } from "../ui/spec";
import { sectionHeading } from "./catalog";
import { saveTeam } from "./results";
import { renderSongComparison } from "./song-comparison-view";
import { eventSection, gekisoSamplesControl, playConditions, songList } from "./build-tab";
import { segmented } from "../ui/controls";
import { clock } from "../../lib/team-builder/engine/execution";
import { compareHits } from "../../lib/team-builder/engine/merge";
import type { TeamBuilder } from "../team-builder";

const format = (host: TeamBuilder, value: number, digits = 0) =>
  new Intl.NumberFormat(host.locale, { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(value);
function manualReady(host: TeamBuilder) {
  const inputs = host.manualInputs();
  return (
    host.manual.members.every((id) => id !== null) &&
    inputs.members.length === 5 &&
    inputs.snaps.length === host.manual.snaps.filter((id) => id !== null).length &&
    new Set(host.manual.members.map((id) => host.catalog!.member(id!)?.characterId)).size === 5
  );
}
function teamSpec(host: TeamBuilder) {
  const { members, snaps, leader } = host.manual;
  return {
    members: members.map((id) => `m${id}`),
    snaps: snaps.map((id) => (id === null ? null : `s${id}`)),
    leader: `m${members[leader]}`,
  };
}
async function evaluate(host: TeamBuilder) {
  if (!manualReady(host) || !host.engine || !host.manualGoal().songs.length || host.running) return;
  const task = host.acquireTask("evaluation");
  if (!task) return;
  const context = host.manualContext();
  host.activeManualContext = context;
  host.manualBusy = true;
  host.requestUpdate();
  const goal = host.manualGoal();
  try {
    const results = await host.engine.evaluate({
      ...host.manualInputs(),
      player: host.view!.player,
      team: teamSpec(host),
      songs: goal.songs,
      play: goal.kind === "score" ? goal.play : { great: 0, good: 0, bad: 0, miss: 0 },
      ...(goal.kind === "gekiso" ? { gekiso: { accuracy: goal.accuracy, rank: goal.rank, seeds: goal.seeds } } : {}),
      challengeEventId: goal.kind === "score" ? goal.challengeEventId : null,
      event: null,
    });
    if (host.ownsTask(task) && context === host.manualContext()) {
      host.manualResultsFor = context;
      host.manualResults = results;
    }
  } catch (error) {
    if (host.ownsTask(task) && !(error instanceof DOMException && error.name === "AbortError"))
      host.error = String(error);
  } finally {
    if (host.ownsTask(task)) {
      host.manualBusy = false;
      host.activeManualContext = "";
    }
    host.releaseTask(task);
    host.requestUpdate();
  }
}
/** Best cards for one slot with the other four fixed (exact constrained search). */
async function suggest(host: TeamBuilder, slot: number) {
  const base = host.request(host.manualGoal());
  if (!base || !host.engine || !manualReady(host) || host.running) return;
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
      host.error = String(error);
  } finally {
    if (host.ownsTask(task)) {
      host.manualSuggesting = -1;
      host.activeManualContext = "";
    }
    host.releaseTask(task);
    host.requestUpdate();
  }
}

function slotPicker(host: TeamBuilder): TemplateResult | typeof nothing {
  const picker = host.slotPicker;
  if (!picker) return nothing;
  const catalog = host.catalog!;
  const kind = picker.kind;
  const close = () => {
    host.slotPicker = null;
    host.slotFilters = {
      ...host.slotFilters,
      query: "",
      bands: [],
      characters: [],
      attributes: [],
      rarities: [],
      facets: {},
    };
    host.slotFiltersOpen = false;
    host.requestUpdate();
  };
  const filters = { ...host.slotFilters, kind };
  const set = (patch: Partial<typeof filters>) => {
    host.slotFilters = { ...filters, ...patch };
    host.requestUpdate();
  };
  const theoretical = host.tab !== "song-comparison" && host.settings.scope === "theoretical";
  const owned = kind === "members" ? host.view!.members : host.view!.snaps;
  const ids = (
    theoretical
      ? Object.keys(kind === "members" ? catalog.data.members : catalog.data.snapshots).map(Number)
      : [...owned.keys()]
  )
    .filter((id) => matchesCardFilters(host, kind, id, filters))
    .sort((a, b) => b - a);
  const current = kind === "members" ? host.manual.members[picker.slot] : host.manual.snaps[picker.slot];
  return selectionPane({
    id: "tb-slot-picker",
    title: kind === "members" ? host.t("pickMember", "Choose a member") : host.t("pickSnap", "Choose a snap"),
    closeLabel: host.common("common.actions.close", "Close"),
    close,
    searchLabel: host.common("common.actions.search", "Search"),
    filterLabel: host.t("filters", "Filters"),
    filtersOpen: host.slotFiltersOpen,
    toggleFilters: () => {
      host.slotFiltersOpen = !host.slotFiltersOpen;
      host.requestUpdate();
    },
    query: filters.query,
    search: (value) => set({ query: value }),
    filterLayout: "facets",
    filters: renderCardFilters(host, filters, set),
    kind: kind === "members" ? "member" : "support",
    items: ids.map((id) => ({ ...catalog.cardOptions(kind, id)!, value: String(id) })),
    selected: current === null || current === undefined ? "" : String(current),
    select: (value) => {
      const id = Number(value);
      const list = kind === "members" ? [...host.manual.members] : [...host.manual.snaps];
      // A card can sit in one slot only; picking it again moves it.
      for (let index = 0; index < list.length; index++) if (list[index] === id) list[index] = null;
      list[picker.slot] = id;
      host.manual = kind === "members" ? { ...host.manual, members: list } : { ...host.manual, snaps: list };
      host.manualResults = null;
      host.manualSuggestions = null;
      close();
    },
    countLabel: host.t("cardCount", "{count} cards", { count: ids.length }),
    emptyLabel: host.t("noMatches", "No cards match"),
    preview:
      kind === "snaps"
        ? html`
            <button
              class="button button--text"
              type="button"
              @click=${() => {
                const snaps = [...host.manual.snaps];
                snaps[picker.slot] = null;
                host.manual = { ...host.manual, snaps };
                host.manualResults = null;
                close();
              }}
            >
              ${icon("hide_image", 18)}${host.t("noSnap", "No snap")}
            </button>
          `
        : html``,
  });
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
  const rows = results
    ? [...results].sort((a, b) => b.score.mean - a.score.mean).map((row) => ({ song: row.song, row }))
    : host.manualGoal().songs.map((song) => ({ song, row: null }));
  const suggestions = host.manualSuggestionsFor === host.manualSuggestionContext() ? host.manualSuggestions : null;
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
                    @click=${() => host.openSongComparison()}
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
              <span class="row row--wrap tb-slot__tools">
                ${iconButton({
                  icon: "star",
                  label: leader ? host.t("leader", "Leader") : host.t("makeLeader", "Leader"),
                  toggle: true,
                  pressed: leader,
                  disabled: member === null,
                  onClick: () => {
                    host.manual = { ...host.manual, leader: slot };
                    host.manualResults = null;
                    host.requestUpdate();
                  },
                })}
                ${!comparison ? iconButton({ icon: "auto_fix_high", label: host.t("suggestSlot", "Best card for this slot"), size: 18, disabled: host.running || !manualReady(host) || suggesting >= 0 || !host.manualGoal().songs.length, onClick: () => void suggest(host, slot) }) : nothing}
              </span>
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
                                · ${host.t("power", "Power")}
                                ${format(host, hit.power)}${hit.score ? ` · ${format(host, hit.score.mean)}` : ""}${hit.event ? ` · ${format(host, hit.event.mean, 1)} pt` : ""}
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
  if (comparison)
    return html`
      ${renderSongComparison(host, editor)}${slotPicker(host)}
    `;
  return html`
    <div class="tb-teams stack stack--loose">
      ${
        mode !== "teams"
          ? html`
              <div class=${comparison ? "stack" : "tb-build tb-manual"}>
                <div class="tb-results-column stack">${editor}</div>
                ${
                  !comparison
                    ? html`
                        <aside class="tb-config stack">
                          <section class="surface stack">
                            ${sectionHeading({ icon: "flag", label: host.t("goal", "Goal") })}
                            ${segmented({
                              label: host.t("goal", "Goal"),
                              value: host.settings.manualScoreMode,
                              options: [
                                { value: "score", label: host.t("goalScore", "Live score") },
                                { value: "gekiso", label: host.t("goalGekiso", "Gekiso score") },
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
                          </section>
                          <section class="surface stack">
                            ${sectionHeading({ icon: "piano", label: host.t("farm.conditions", "Play and account conditions") })}
                            ${playConditions(host, { ...host.searchSettings, goal: showSkipScore ? "score" : "gekiso" })}
                            ${
                              showSkipScore
                                ? html`
                                    <label class="tb-check">
                                      <md-checkbox
                                        touch-target="wrapper"
                                        .checked=${live(host.settings.challengeRules)}
                                        @change=${(event: Event) => host.updateSettings({ challengeRules: (event.target as HTMLInputElement).checked })}
                                      ></md-checkbox>
                                      <span>
                                        ${host.t("challengeRules", "Challenge live rules (event parameter bonus)")}
                                      </span>
                                    </label>
                                    ${host.settings.challengeRules ? eventSection(host, { ...host.settings, goal: "score" }) : nothing}
                                  `
                                : html`
                                    ${segmented({
                                      label: host.t("gekisoRank", "Placement in each range"),
                                      value: String(host.settings.gekisoRank),
                                      options: [1, 2, 3, 4, 5].map((rank) => ({
                                        value: String(rank),
                                        label: String(rank),
                                      })),
                                      onSelect: (value) => host.updateSettings({ gekisoRank: Number(value) }),
                                    })}
                                    ${gekisoSamplesControl(host)}
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
                          </section>
                        </aside>
                      `
                    : nothing
                }
                ${
                  !comparison
                    ? html`
                        <section class="surface stack tb-manual__scores">
                          ${sectionHeading({ icon: "query_stats", label: showSkipScore ? host.t("goalScore", "Live score") : host.t("goalGekiso", "Gekiso score"), count: rows.length || undefined })}
                          <ul class="tb-eval-mobile">
                            ${rows.map(
                              ({ song, row }) => html`
                                <li class="card card--outlined">
                                  <div class="card__body stack">
                                    <div>
                                      <strong>${catalog.songTitle(song.songId)}</strong>
                                      <div class="card__supporting">
                                        ${catalog.difficultyLabel(song.songId, song.difficulty)}
                                      </div>
                                    </div>
                                    ${specList(
                                      [
                                        { label: host.t("power", "Power"), value: row ? format(host, row.power) : "—" },
                                        {
                                          label: host.t("expectedScore", "Expected score"),
                                          value: row ? format(host, row.score.mean) : "—",
                                        },
                                        {
                                          label: host.t("scoreRange", "Range"),
                                          value: row
                                            ? `${format(host, row.score.min)} – ${format(host, row.score.max)}`
                                            : "—",
                                        },
                                        showSkipScore
                                          ? {
                                              label: host.t("skipScore", "Skip score"),
                                              value: row ? format(host, row.skipScore) : "—",
                                            }
                                          : null,
                                      ],
                                      { numeric: true },
                                    )}
                                  </div>
                                </li>
                              `,
                            )}
                          </ul>
                          <div
                            class="table-scroll tb-eval-desktop"
                            role="region"
                            tabindex="0"
                            aria-label=${showSkipScore ? host.t("goalScore", "Live score") : host.t("goalGekiso", "Gekiso score")}
                          >
                            <table class="data-table tb-eval">
                              <thead>
                                <tr>
                                  <th scope="col">${host.t("song", "Song")}</th>
                                  <th scope="col" class="is-numeric">${host.t("power", "Power")}</th>
                                  <th scope="col" class="is-numeric">${host.t("expectedScore", "Expected score")}</th>
                                  <th scope="col" class="is-numeric">${host.t("scoreRange", "Range")}</th>
                                  ${
                                    showSkipScore
                                      ? html`
                                          <th scope="col" class="is-numeric">${host.t("skipScore", "Skip score")}</th>
                                        `
                                      : nothing
                                  }
                                </tr>
                              </thead>
                              <tbody>
                                ${rows.map(
                                  ({ song, row }) => html`
                                    <tr>
                                      <th scope="row">
                                        ${catalog.songTitle(song.songId)}
                                        <small>${catalog.difficultyLabel(song.songId, song.difficulty)}</small>
                                      </th>
                                      <td class="is-numeric">${row ? format(host, row.power) : "—"}</td>
                                      <td class="is-numeric">${row ? format(host, row.score.mean) : "—"}</td>
                                      <td class="is-numeric">
                                        ${row ? `${format(host, row.score.min)} – ${format(host, row.score.max)}` : "—"}
                                      </td>
                                      ${
                                        showSkipScore
                                          ? html`
                                              <td class="is-numeric">${row ? format(host, row.skipScore) : "—"}</td>
                                            `
                                          : nothing
                                      }
                                    </tr>
                                  `,
                                )}
                              </tbody>
                            </table>
                          </div>
                        </section>
                      `
                    : nothing
                }
              </div>
            `
          : nothing
      }
      ${comparison ? renderSongComparison(host) : nothing}
      ${
        mode === "teams"
          ? html`
              <section class="surface stack">
                ${sectionHeading({ icon: "bookmarks", label: host.t("savedTeams", "Saved teams"), count: view.teams.length || undefined })}
                <button
                  class="button button--tonal"
                  @click=${() => {
                    host.buildMode = "manual";
                    host.setTab("build");
                  }}
                >
                  ${host.t("manualTeam", "Build a team by hand")}
                </button>
                ${
                  view.teams.length
                    ? html`
                        <div class="tb-saved">
                          ${view.teams.map(
                            (team) => html`
                              <article class="card card--outlined tb-saved__team">
                                <div class="row row--wrap">
                                  <md-outlined-text-field
                                    class="tb-saved__name"
                                    label=${host.t("teamName", "Name")}
                                    .value=${live(team.name)}
                                    @change=${(e: Event) => host.write([{ key: `team.${team.id}`, value: { ...team, name: (e.target as HTMLInputElement).value.slice(0, 80) } }])}
                                  ></md-outlined-text-field>
                                  <span class="row__spacer"></span>
                                  ${iconButton({
                                    icon: "edit",
                                    label: host.t("loadTeam", "Open in the editor"),
                                    onClick: () => {
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
                                      window.scrollTo({ top: 0, behavior: "smooth" });
                                    },
                                  })}
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
                                <div class="tb-saved__cards">
                                  ${team.members.map((id) => {
                                    const options = catalog.cardOptions("members", id);
                                    return options
                                      ? html`
                                          <span
                                            class=${`tb-saved__card${team.leader === id ? " is-leader" : ""}`}
                                            title=${options.label}
                                          >
                                            ${tileMedia({ ...options, marks: [] })}
                                          </span>
                                        `
                                      : nothing;
                                  })}
                                </div>
                                ${
                                  team.song
                                    ? html`
                                        <span class="card__supporting">
                                          ${catalog.songTitle(team.song.songId)}
                                          ${catalog.difficultyLabel(team.song.songId, team.song.difficulty)}
                                        </span>
                                      `
                                    : nothing
                                }
                              </article>
                            `,
                          )}
                        </div>
                      `
                    : html`
                        <p class="card__supporting">${host.t("noSavedTeamsShort", "No saved teams")}</p>
                      `
                }
              </section>
            `
          : nothing
      }
      ${slotPicker(host)}
    </div>
  `;
}
