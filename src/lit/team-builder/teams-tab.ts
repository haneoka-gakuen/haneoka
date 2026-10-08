import { matchesCardFilters, renderCardFilters } from "./card-filters";
/** Saved teams, a manual formation and its evaluation across songs, with swap suggestions. */
import { html, nothing, type TemplateResult } from "lit";
import { live } from "lit/directives/live.js";
import type { EngineHit } from "../../lib/team-builder/engine/api";
import { cardIdOf } from "../../lib/team-builder/sync/box-view";
import { iconButton } from "../ui/controls";
import { icon } from "../ui/icon";
import { selectionPane } from "../ui/selection-pane";
import { tileMedia } from "../ui/tile";
import { sectionHeading } from "./catalog";
import { saveTeam } from "./results";
import type { TeamBuilder } from "../team-builder";

const format = (host: TeamBuilder, value: number, digits = 0) =>
  new Intl.NumberFormat(host.locale, { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(value);
let suggestions: { slot: number; hits: EngineHit[] } | null = null;
let suggesting = -1;


function manualReady(host: TeamBuilder) {
  return host.manual.members.every((id) => id !== null) && new Set(host.manual.members.map((id) => host.catalog!.member(id!)?.characterId)).size === 5;
}
function teamSpec(host: TeamBuilder) {
  const { members, snaps, leader } = host.manual;
  return { members: members.map((id) => `m${id}`), snaps: snaps.map((id) => (id === null ? null : `s${id}`)), leader: `m${members[leader]}` };
}
/** Engine inputs that always contain the manual team's own cards. */
function inputs(host: TeamBuilder) {
  const request = host.request() ?? { members: [], snaps: [], player: host.view!.player, unknownPolicy: host.settings.unknownPolicy };
  const members = [...request.members];
  const snaps = [...request.snaps];
  for (const id of host.manual.members) if (id !== null && !members.some((row) => row.cardId === id)) {
    const owned = host.view!.members.get(id);
    members.push({ key: `m${id}`, cardId: id, level: owned?.level ?? null, awake: owned?.awake ?? null, rank: owned?.rank ?? null, liveSkillLevel: owned?.skill ?? null, gekisoSkillLevel: owned?.gekisoSkill ?? null });
  }
  for (const id of host.manual.snaps) if (id !== null && !snaps.some((row) => row.cardId === id)) {
    const owned = host.view!.snaps.get(id);
    snaps.push({ key: `s${id}`, cardId: id, level: owned?.level ?? null, rank: owned?.rank ?? null });
  }
  return { members, snaps, player: request.player, unknownPolicy: request.unknownPolicy };
}
async function evaluate(host: TeamBuilder) {
  if (!manualReady(host) || !host.engine || !host.settings.songs.length) return;
  host.manualBusy = true;
  host.requestUpdate();
  const s = host.settings;
  try {
    host.manualResults = await host.engine.evaluate({
      ...inputs(host),
      team: teamSpec(host),
      songs: s.songs,
      play: s.playMode === "ap" ? { great: 0, good: 0, bad: 0, miss: 0 } : { great: s.great / 100, good: s.good / 100, bad: 0, miss: s.miss / 100 },
      challengeEventId: s.challengeRules ? s.eventId : null,
      event: s.eventId !== null && (s.goal === "event" || s.goal === "plan") && s.route !== "skip" ? { eventId: s.eventId, route: s.route === "challenge" ? "challenge" : "live", consumption: s.route === "challenge" ? s.challengePoints : s.boosts } : null,
    });
  } catch (error) {
    host.error = String(error);
  } finally {
    host.manualBusy = false;
    host.requestUpdate();
  }
}
/** Best cards for one slot with the other four fixed (exact constrained search). */
async function suggest(host: TeamBuilder, slot: number) {
  const base = host.request();
  if (!base || !host.engine || !manualReady(host)) return;
  suggesting = slot;
  host.requestUpdate();
  const { members, snaps, leader } = host.manual;
  const others = members.flatMap((id, index) => (index === slot || id === null ? [] : [{ member: id, snap: snaps[index] ?? null, leader: index === leader }]));
  const extra = inputs(host);
  try {
    const result = await host.engine.run({
      ...base,
      members: extra.members,
      snaps: extra.snaps,
      k: 3,
      constraints: {
        ...base.constraints,
        requiredMembers: others.map((row) => `m${row.member}`),
        leader: slot === leader ? null : `m${members[leader]}`,
        bindings: others.map((row) => [`m${row.member}`, row.snap === null ? null : `s${row.snap}`]),
        excludedMembers: [`m${members[slot]}`].filter(() => false),
      },
    });
    suggestions = { slot, hits: result.overall.slice(0, 3) };
  } catch (error) {
    host.error = String(error);
  } finally {
    suggesting = -1;
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
    host.slotFilters = { ...host.slotFilters, query: "", bands: [], characters: [], attributes: [], rarities: [], facets: {} };
    host.slotFiltersOpen = false;
    host.requestUpdate();
  };
  const filters = { ...host.slotFilters, kind };
  const set = (patch: Partial<typeof filters>) => {host.slotFilters = {...filters,...patch};host.requestUpdate();};
  const theoretical = host.settings.scope === "theoretical";
  const owned = kind === "members" ? host.view!.members : host.view!.snaps;
  const ids = (theoretical ? Object.keys(kind === "members" ? catalog.data.members : catalog.data.snapshots).map(Number) : [...owned.keys()])
    .filter((id) => matchesCardFilters(host, kind, id, filters))
    .sort((a, b) => b - a);
  const current = kind === "members" ? host.manual.members[picker.slot] : host.manual.snaps[picker.slot];
  return selectionPane({
    id: "tb-slot-picker",
    title: kind === "members" ? host.t("pickMember", "Choose a member") : host.t("pickSnap", "Choose a snap"),
    closeLabel: host.common("close", "Close"),
    close,
    searchLabel: host.common("search", "Search"),
    filterLabel: host.t("filters", "Filters"),
    filtersOpen: host.slotFiltersOpen,
    toggleFilters: () => {host.slotFiltersOpen = !host.slotFiltersOpen;host.requestUpdate();},
    query: filters.query,
    search: (value) => set({query:value}),
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
      suggestions = null;
      close();
    },
    countLabel: host.t("cardCount", "{count} cards", { count: ids.length }),
    emptyLabel: host.t("noMatches", "No cards match"),
    preview: kind === "snaps"
      ? html`<button class="button button--text" type="button" @click=${() => {
          const snaps = [...host.manual.snaps];
          snaps[picker.slot] = null;
          host.manual = { ...host.manual, snaps };
          host.manualResults = null;
          close();
        }}>${icon("hide_image", 18)}${host.t("noSnap", "No snap")}</button>`
      : html``,
  });
}

export function renderTeamsTab(host: TeamBuilder): TemplateResult {
  const catalog = host.catalog!;
  const view = host.view!;
  const order = [1, 2, 0, 3, 4].map((index) => (index === 0 ? host.manual.leader : index <= host.manual.leader ? index - 1 : index));
  const visualOrder = [0, 1, 2, 3, 4].filter((index) => index !== host.manual.leader);
  visualOrder.splice(2, 0, host.manual.leader);
  void order;
  const characters = host.manual.members.map((id) => (id === null ? null : catalog.member(id)?.characterId ?? null));
  const duplicate = characters.some((id, index) => id !== null && characters.indexOf(id) !== index);
  const results = host.manualResults;
  return html`
    <div class="tb-teams stack stack--loose">
      <section class="surface stack">
        <div class="row row--between row--wrap">
          ${sectionHeading({ icon: "edit_square", label: host.t("manualTeam", "Build a team by hand") })}
          <div class="cluster">
            <button class="button button--text button--small" type="button" ?disabled=${!manualReady(host)}
              @click=${() => saveTeam(host, [host.manual.members[host.manual.leader]!, ...host.manual.members.filter((_, index) => index !== host.manual.leader) as number[]], [host.manual.snaps[host.manual.leader] ?? null, ...host.manual.snaps.filter((_, index) => index !== host.manual.leader)], host.settings.songs[0] ?? null)}>
              ${icon("bookmark_add", 18)}${host.t("saveTeam", "Save team")}</button>
            <button class="button button--text button--small" type="button" @click=${() => { host.manual = { members: [null, null, null, null, null], snaps: [null, null, null, null, null], leader: 2 }; host.manualResults = null; suggestions = null; host.requestUpdate(); }}>${host.common("clear", "Clear")}</button>
          </div>
        </div>
        <ol class="tb-formation tb-formation--edit">
          ${visualOrder.map((slot) => {
            const member = host.manual.members[slot];
            const snap = host.manual.snaps[slot];
            const memberOptions = member !== null && member !== undefined ? catalog.cardOptions("members", member) : null;
            const snapOptions = snap !== null && snap !== undefined ? catalog.cardOptions("snaps", snap) : null;
            const leader = slot === host.manual.leader;
            return html`
              <li class=${`tb-slot${leader ? " is-leader" : ""}`}>
                <button class="tb-slot__member" type="button" @click=${() => { host.slotPicker = { slot, kind: "members" }; host.requestUpdate(); }}
                  aria-label=${memberOptions ? `${host.t("pickMember", "Choose a member")}: ${memberOptions.label}` : host.t("pickMember", "Choose a member")}>
                  ${memberOptions ? tileMedia(memberOptions) : html`<span class="tb-slot__empty">${icon("person_add", 24)}</span>`}
                </button>
                <button class="tb-slot__snap" type="button" @click=${() => { host.slotPicker = { slot, kind: "snaps" }; host.requestUpdate(); }}
                  aria-label=${snapOptions ? `${host.t("pickSnap", "Choose a snap")}: ${snapOptions.label}` : host.t("pickSnap", "Choose a snap")}>
                  ${snapOptions ? tileMedia(snapOptions) : html`<span class="tb-slot__empty">${icon("add_photo_alternate", 20)}</span>`}
                </button>
                <span class="row row--wrap tb-slot__tools">
                  ${leader
                    ? html`<span class="badge badge--primary">${host.t("leader", "Leader")}</span>`
                    : html`<button class="button button--text button--small" type="button" ?disabled=${member === null} @click=${() => { host.manual = { ...host.manual, leader: slot }; host.manualResults = null; host.requestUpdate(); }}>${host.t("makeLeader", "Leader")}</button>`}
                  ${iconButton({ icon: "auto_fix_high", label: host.t("suggestSlot", "Best card for this slot"), size: 18, disabled: !manualReady(host) || suggesting >= 0 || !host.request(), onClick: () => void suggest(host, slot) })}
                </span>
              </li>
            `;
          })}
        </ol>
        ${duplicate ? html`<p class="field-note field-note--error">${host.t("duplicateCharacter", "Each character can appear once.")}</p>` : nothing}
        ${suggesting >= 0 ? html`<md-linear-progress indeterminate aria-label=${host.t("searching", "Searching teams")}></md-linear-progress>` : nothing}
        ${suggestions
          ? html`<div class="stack tb-suggest">
              <strong class="tb-subtitle">${host.t("suggestions", "Best replacements")}</strong>
              ${suggestions.hits.length
                ? suggestions.hits.map((hit) => {
                    const slotMember = hit.members.find((key) => !host.manual.members.includes(cardIdOf(key)));
                    const index = slotMember ? hit.members.indexOf(slotMember) : -1;
                    const snapKey = index >= 0 ? hit.snaps[index] : null;
                    if (!slotMember) return nothing;
                    return html`<div class="list-item list-item--two-line">
                      <span class="list-item__leading tb-suggest__art">${tileMedia(catalog.cardOptions("members", cardIdOf(slotMember))!)}</span>
                      <span class="list-item__body"><strong class="list-item__headline">${catalog.cardName("members", cardIdOf(slotMember))}</strong>
                        <span class="list-item__supporting">${snapKey ? catalog.cardName("snaps", cardIdOf(snapKey)) : host.t("noSnap", "No snap")} · ${host.t("power", "Power")} ${format(host, hit.power)}${hit.score ? ` · ${format(host, hit.score.mean)}` : ""}${hit.event ? ` · ${format(host, hit.event.mean, 1)} pt` : ""}</span></span>
                      <span class="list-item__trailing"><button class="button button--tonal button--small" type="button" @click=${() => {
                        const members = [...host.manual.members];
                        const snaps = [...host.manual.snaps];
                        members[suggestions!.slot] = cardIdOf(slotMember);
                        snaps[suggestions!.slot] = snapKey ? cardIdOf(snapKey) : null;
                        host.manual = { ...host.manual, members, snaps };
                        suggestions = null;
                        host.manualResults = null;
                        host.requestUpdate();
                      }}>${host.t("apply", "Apply")}</button></span></div>`;
                  })
                : html`<p class="card__supporting">${host.t("noSuggestion", "No better card found.")}</p>`}
            </div>`
          : nothing}
        <div class="row row--wrap">
          <button class="button" type="button" ?disabled=${!manualReady(host) || duplicate || !host.settings.songs.length || host.manualBusy} @click=${() => void evaluate(host)}>
            ${icon("calculate", 18)}${host.t("evaluateTeam", "Evaluate on the chosen songs")}</button>
          <span class="field-note">${host.settings.songs.length ? host.t("evaluateSongs", "{count} songs from Build", { count: host.settings.songs.length }) : host.t("needSongs", "Choose at least one song.")}</span>
        </div>
        ${host.manualBusy ? html`<md-linear-progress indeterminate aria-label=${host.t("evaluating", "Evaluating")}></md-linear-progress>` : nothing}
        ${results
          ? html`<div class="scroll-x"><table class="table tb-eval">
              <thead><tr><th>${host.t("song", "Song")}</th><th>${host.t("power", "Power")}</th><th>${host.t("expectedScore", "Expected score")}</th><th>${host.t("scoreRange", "Range")}</th><th>${host.t("skipScore", "Skip score")}</th>${results.some((row) => row.event) ? html`<th>${host.t("pointsPerPlay", "Event points per play")}</th><th>${host.t("itemsPerPlay", "Items per play")}</th>` : nothing}</tr></thead>
              <tbody>${[...results].sort((a, b) => b.score.mean - a.score.mean).map((row) => html`<tr>
                <th scope="row">${catalog.songTitle(row.song.songId)} <small>${catalog.difficultyLabel(row.song.songId, row.song.difficulty)}</small></th>
                <td class="tabular">${format(host, row.power)}</td><td class="tabular">${format(host, row.score.mean)}</td>
                <td class="tabular">${format(host, row.score.min)} – ${format(host, row.score.max)}</td><td class="tabular">${format(host, row.skipScore)}</td>
                ${row.event ? html`<td class="tabular">${format(host, row.event.points, 1)} (+${format(host, row.event.bonusPercent)}%)</td><td class="tabular">${format(host, row.event.items, 1)}</td>` : results.some((item) => item.event) ? html`<td></td><td></td>` : nothing}
              </tr>`)}</tbody></table></div>`
          : nothing}
      </section>
      <section class="surface stack">
        ${sectionHeading({ icon: "bookmarks", label: host.t("savedTeams", "Saved teams"), count: view.teams.length || undefined })}
        ${view.teams.length
          ? html`<div class="tb-saved">${view.teams.map((team) => html`
              <article class="card card--outlined tb-saved__team">
                <div class="row row--wrap">
                  <md-outlined-text-field class="tb-saved__name" label=${host.t("teamName", "Name")} .value=${live(team.name)}
                    @change=${(e: Event) => host.write([{ key: `team.${team.id}`, value: { ...team, name: (e.target as HTMLInputElement).value.slice(0, 80) } }])}></md-outlined-text-field>
                  <span class="row__spacer"></span>
                  ${iconButton({ icon: "edit", label: host.t("loadTeam", "Open in the editor"), onClick: () => {
                    const members = [team.members[1] ?? null, team.members[2] ?? null, team.members[0] ?? null, team.members[3] ?? null, team.members[4] ?? null];
                    const snaps = [team.snaps[1] ?? null, team.snaps[2] ?? null, team.snaps[0] ?? null, team.snaps[3] ?? null, team.snaps[4] ?? null];
                    host.manual = { members, snaps, leader: 2 };
                    host.manualResults = null;
                    suggestions = null;
                    if (team.song && !host.settings.songs.some((song) => song.songId === team.song!.songId)) host.updateSettings({ songs: [...host.settings.songs, team.song] });
                    host.requestUpdate();
                    window.scrollTo({ top: 0, behavior: "smooth" });
                  } })}
                  ${iconButton({ icon: "delete", label: host.common("delete", "Delete"), onClick: () => {
                    host.write([{ key: `team.${team.id}`, value: null }]);
                    host.notice = host.t("deletedTeam", "Team deleted");
                    host.requestUpdate();
                  } })}
                </div>
                <div class="tb-saved__cards">
                  ${team.members.map((id, index) => {
                    const options = catalog.cardOptions("members", id);
                    return options ? html`<span class=${`tb-saved__card${index === 0 ? " is-leader" : ""}`} title=${options.label}>${tileMedia({ ...options, marks: [] })}</span>` : nothing;
                  })}
                </div>
                ${team.song ? html`<span class="card__supporting">${catalog.songTitle(team.song.songId)} ${catalog.difficultyLabel(team.song.songId, team.song.difficulty)}</span>` : nothing}
              </article>`)}</div>`
          : html`<p class="card__supporting">${host.t("noSavedTeamsShort", "No saved teams")}</p>`}
      </section>
      ${slotPicker(host)}
    </div>
  `;
}
