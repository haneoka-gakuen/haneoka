import { songMissions } from "../../lib/catalog-filters";
import { boostControl } from "./boost-control";
/** Team search: goal, songs, play, candidates and constraints; results beside them. */
import { html, nothing, type TemplateResult } from "lit";
import { live } from "lit/directives/live.js";
import "@material/web/progress/linear-progress.js";
import type { SongRef } from "../../lib/team-builder/engine/api";
import { cardRarityName } from "../shared/rarity-icon";
import { filterChip, iconButton, rovingKeydown, segmented } from "../ui/controls";
import { accordion } from "../ui/accordion";
import { icon } from "../ui/icon";
import { tileMedia } from "../ui/tile";
import { sectionHeading } from "./catalog";
import { renderResults } from "./results";
import { SCORE_GOALS, scoreGoal, scoreText } from "./score-goal";
import type { BuildSettings, GoalKind } from "./types";
import type { TeamBuilder } from "../team-builder";
import { farmingConditions, missionSummary, parseOpponents } from "./workspace-state";
import { ptField } from "./pt-fields";

const GOALS = [
  { id: "score", icon: "music_note" },
  { id: "gekiso", icon: "local_fire_department" },
  { id: "power", icon: "bolt" },
  { id: "potential", icon: "auto_awesome" },
] as const;

export function gekisoSamplesControl(host: TeamBuilder): TemplateResult {
  return html`<md-outlined-text-field type="number" min="0" step="1" inputmode="numeric"
    label=${host.t("pt.luckSamples", "Luck samples")} .value=${String(host.settings.gekisoSeeds)}
    @change=${(e:Event)=>host.updateSettings({gekisoSeeds:Math.max(0,Math.floor(Number((e.target as HTMLInputElement).value)||0))})}></md-outlined-text-field>`;
}

export function comboBonusControl(host: TeamBuilder): TemplateResult | typeof nothing {
  if (!host.hasComboSongs()) return nothing;
  return html`<md-outlined-text-field id="tb-combo" data-tb-field type="number" min="1" step="1" inputmode="numeric"
    label=${host.t("minComboBonus", "Minimum base COMBO BONUS")} prefix-text="×"
    .value=${live(host.settings.minComboBonus === 1 ? "" : String(host.settings.minComboBonus))}
    placeholder=${host.t("unlimitedCombo", "No minimum")}
    ?error=${host.submitted && (!Number.isInteger(host.settings.minComboBonus) || host.settings.minComboBonus < 1)}
    @change=${(event: Event) => host.updateSettings({ minComboBonus: (event.target as HTMLInputElement).value === "" ? 1 : Number((event.target as HTMLInputElement).value) })}
  ></md-outlined-text-field>`;
}

function goalText(host: TeamBuilder, goal: GoalKind): string {
  switch (goal) {
    case "score":
      return host.t("goalScore", "Live score");
    case "gekiso":
      return host.t("goalGekiso", "Gekiso score");
    case "event":
      return host.t("goalEvent", "Event rewards");
    case "plan":
      return host.t("goalPlan", "Event resource plan");
    case "power":
      return host.t("goalPower", "Highest power");
    case "potential":
      return host.t("goalPotential", "Songless potential");
  }
}

export function songList(
  host: TeamBuilder,
  songs: SongRef[],
  change: (songs: SongRef[]) => void,
  single = false,
  allowedSongIds?: number[],
  fieldId = "tb-songs",
): TemplateResult {
  const catalog = host.catalog!;
  return html`
    <div class="tb-songs" id=${fieldId} data-tb-field tabindex="-1">
      <span class="tb-results__meta">${host.t("chartCount", "{count} charts", { count: songs.filter(song => (!allowedSongIds || allowedSongIds.includes(song.songId)) && catalog.difficultyRows(song.songId).some(row => Number(row.difficulty) === song.difficulty)).length })}</span>
      ${songs.length ? html`<div class="tb-songs__list" role="region" aria-label=${host.t("songs", "Songs")} tabindex="0">${songs.map(
        (song, index) => html`
          <div class="list-item list-item--two-line tb-song">
            <span class="list-item__leading tb-song__art">
              ${tileMedia({ ...catalog.songOptions(song.songId, song.difficulty), marks: [] })}
            </span>
            <span class="list-item__body">
              <strong class="list-item__headline clamp-1">${catalog.songTitle(song.songId)}</strong>
              <span class="list-item__supporting">${catalog.difficultyLabel(song.songId, song.difficulty)}${host.searchSettings.goal === "gekiso" || host.tab === "pt" && host.settings.rewardMode === "recommendation" && host.searchSettings.ptMode === "gekiso" ? ` · ${missionSummary(songMissions(catalog.song(song.songId)))}` : ""}${(allowedSongIds && !allowedSongIds.includes(song.songId)) || !catalog.difficultyRows(song.songId).some(row => Number(row.difficulty) === song.difficulty) ? ` · ${host.t("unavailable", "Unavailable")}` : ""}</span>
            </span>
            <span class="list-item__trailing">
              ${iconButton({ icon: "close", label: host.common("common.actions.remove", "Remove"), onClick: () => change(songs.filter((_, at) => at !== index)) })}
            </span>
          </div>
        `,
      )}</div>` : nothing}
      <button
        class="button button--tonal tb-songs__add"
        type="button"
        @click=${() => {
          host.songPicker = {
            songs: songs.map(song => ({ ...song })),
            context: `${host.tab}:${host.searchSettings.goal}:${single ? "single" : allowedSongIds ? "restricted" : "songs"}`,
            single,
            query: "",
            filtersOpen: false,
            bands: [],
            attributes: [],
            gekisouTypes: [],
            difficulty: 3,
            allowedSongIds,
            change,
          };
          host.requestUpdate();
        }}
      >
        ${icon("add", 18)}${songs.length ? host.t("editSongs", "Change songs") : host.t("addSongs", "Choose songs")}
      </button>
    </div>
  `;
}

export function eventSection(host: TeamBuilder, s = host.searchSettings): TemplateResult {
  const catalog = host.catalog!;
  const events = catalog.events();
  const set = (patch: Partial<BuildSettings>) => host.updateSettings(patch);
  if (!events.length)
    return html`
      <p class="inline-message">${icon("info", 18)}${host.t("noEvents", "This server's data has no event yet.")}</p>
    `;
  const eventId = s.eventId ?? events[0]!.id;
  if (s.eventId === null) queueMicrotask(() => set({ eventId }));
  const challengeSongs = catalog.challengeSongs(eventId);
  const challenge = s.goal === "plan" || (s.goal === "event" ? s.route === "challenge" : s.challengeRules);
  return html`
    <md-outlined-select
      id="tb-event" data-tb-field label=${host.t("event", "Event")}
      .value=${String(eventId)}
      @change=${(e: Event) => set({ eventId: Number((e.target as HTMLInputElement).value) })}
    >
      ${events.map(
        (row) => html`
          <md-select-option value=${String(row.id)}>
            ${
              row.serverMark
                ? html`
                    <img
                      slot="start"
                      src=${row.serverMark.image}
                      alt=${row.serverMark.label}
                      title=${row.serverMark.label}
                      width="18"
                      height="18"
                    />
                  `
                : nothing
            }
            <div slot="headline">${row.name}</div>
          </md-select-option>
        `,
      )}
    </md-outlined-select>
    ${
      challenge && challengeSongs.length
        ? html`
            <div class="cluster">
                  <button
                    class="button button--text button--small"
                    type="button"
                    @click=${() => {
                      const songs = challengeSongs.filter((row) => catalog.difficultyRows(row.liveMusicId).some((difficulty) => Number(difficulty.difficulty) === 3)).map((row) => ({ songId: row.liveMusicId, difficulty: 3 }));
                      set(s.goal === "plan" ? { planChallengeSongs: songs } : { songs: s.goal === "power" ? songs.slice(0, 1) : songs });
                    }}
                  >
                    ${icon("swords", 18)}${host.t("useChallengeSongs", "Use challenge songs")}
                  </button>
            </div>
          `
        : nothing
    }
  `;
}

export function playSummary(host: TeamBuilder, s: BuildSettings): string {
  return [host.t("play", "Play"), s.playMode === "ap" ? host.t("playAp", "All Perfect") : `GREAT ${s.great}%${s.goal === "gekiso" ? "" : ` · GOOD ${s.good}% · MISS ${s.miss}%`} · ${host.t("missEvery", "Miss every N notes")}: ${s.missEvery}`,
    ...(s.goal === "gekiso" && host.hasMission("JustCount", s.songs) ? [`JUST ${s.just}%`] : [])].join(" · ");
}

export function playSection(host: TeamBuilder, s = host.searchSettings, set = (patch: Partial<BuildSettings>) => host.updateSettings(patch)): TemplateResult {
  const slider = (label: string, key: "great" | "good" | "miss", max: number) => html`
    <div class="tb-field">
      <span class="tb-field__label">
        ${label}
        <output>${s[key]}%</output>
      </span>
      <md-slider
        class="md3-slider"
        labeled
        min="0"
        max=${max}
        step="1"
        .value=${s[key]}
        aria-label=${label}
        @change=${(e: Event) => set({ [key]: Number((e.target as HTMLInputElement).value) } as Partial<BuildSettings>)}
      ></md-slider>
    </div>
  `;
  const missEvery = html`
    <md-outlined-text-field
      class="tb-miss-every"
      type="number"
      min="0"
      step="1"
      inputmode="numeric"
      label=${host.t("missEvery", "Miss every N notes")}
      .value=${String(s.missEvery || "")}
      placeholder="0"
      @change=${(e: Event) => set({ missEvery: Math.max(0, Math.floor(Number((e.target as HTMLInputElement).value) || 0)) })}
    ></md-outlined-text-field>
  `;
  return html`
    ${segmented({
      label: host.t("play", "Play"),
      value: s.playMode,
      options: [
        { value: "ap", label: host.t("playAp", "All Perfect"), icon: "workspace_premium" },
        { value: "custom", label: host.t("playCustom", "My accuracy"), icon: "tune" },
      ],
      onSelect: (playMode) => set({ playMode }),
    })}
    ${
      s.goal === "gekiso"
        ? html`
            <div class="tb-sliders">
              ${
              s.playMode === "custom"
                ? html`
                    ${slider("GREAT", "great", 40)}${missEvery}
                  `
                : nothing
            }
              ${host.hasMission("JustCount", s.songs) ? html`<div class="tb-field">
                <span class="tb-field__label">
                  JUST
                  <output>${s.just}%</output>
                </span>
                <md-slider
                  class="md3-slider"
                  labeled
                  min="0"
                  max="100"
                  step="1"
                  .value=${s.just}
                  aria-label="JUST"
                  @change=${(e: Event) => set({ just: Number((e.target as HTMLInputElement).value) })}
                ></md-slider>
              </div>` : nothing}
            </div>
          `
        : s.playMode === "custom"
          ? html`
              <div class="tb-sliders">
                ${slider("GREAT", "great", 40)}${slider("GOOD", "good", 20)}${slider("MISS", "miss", 20)}${missEvery}
              </div>
            `
          : nothing
    }
  `;
}

export function renderCandidates(host: TeamBuilder): TemplateResult {
  const s = host.searchSettings;
  const activity = host.tab === "pt";
  const catalog = host.catalog!;
  const view = host.view!;
  const set = (patch: Partial<BuildSettings>) => host.updateSettings(patch);
  const cards = host.engineCards();
  const toggleIn = (list: number[], value: number) =>
    list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
  const fixedMembers = [...new Set([
    ...(s.scope === "box" ? [...view.members.values()].filter(row => row.use && row.lock).map(row => row.cardId) : []),
    ...s.bindings.map(([id]) => id), ...(s.leader === null ? [] : [s.leader]),
  ])];
  const fixedSnaps = [...new Set([
    ...(s.scope === "box" ? [...view.snaps.values()].filter(row => row.use && row.lock).map(row => row.cardId) : []),
    ...s.bindings.flatMap(([, id]) => id === null ? [] : [id]),
  ])];
  const required = fixedMembers.length + fixedSnaps.length;
  const ownedMembers = cards.members.map(row => row.cardId);
  const bands = Object.keys(catalog.data.bands)
    .map(Number)
    .filter((id) => catalog.bandName(id));
  const content = html`
    <div class="stack">
      <div class="tb-field">
        <span class="tb-field__label">${host.t("cardAttribute", "Card attribute")}</span>
        <div class="cluster">
          ${[1, 2, 3, 4, 5].map((id) => filterChip({ label: catalog.attributeName(id), image: catalog.attributeIcon(id) || undefined, selected: s.attributes.includes(id), onToggle: () => set({ attributes: toggleIn(s.attributes, id) }) }))}
        </div>
      </div>
      <div class="tb-field">
        <span class="tb-field__label">${host.t("memberBand", "Member band")}</span>
        <div class="cluster">
          ${bands.map((id) => filterChip({ label: catalog.bandName(id), image: catalog.bandIcon(id) || undefined, selected: s.bands.includes(id), onToggle: () => set({ bands: toggleIn(s.bands, id) }) }))}
        </div>
      </div>
      <div class="tb-field">
        <span class="tb-field__label">${host.t("minRarity", "Minimum rarity")}</span>
        ${segmented({
          label: host.t("minRarity", "Minimum rarity"),
          value: String(s.minRarity),
          grow: false,
          options: [
            { value: "0", label: host.common("common.states.all", "All") },
            ...[2, 3, 4].map((rarity) => ({ value: String(rarity), label: `${cardRarityName(rarity)}+` })),
          ],
          onSelect: (value) => set({ minRarity: Number(value) }),
        })}
      </div>
      <md-outlined-select
        label=${host.t("leader", "Leader")}
        .value=${s.leader === null ? "" : String(s.leader)}
        @change=${(e: Event) => {
          const value = (e.target as HTMLInputElement).value;
          set({ leader: value ? Number(value) : null });
        }}
      >
        <md-select-option value="">
          <div slot="headline">${host.t("leaderAuto", "Best leader (automatic)")}</div>
        </md-select-option>
        ${ownedMembers.map(
          (id) => html`
            <md-select-option value=${String(id)}>
              <div slot="headline">
                ${catalog.cardName("members", id)} · ${catalog.characterName(catalog.member(id)?.characterId ?? 0)}
              </div>
            </md-select-option>
          `,
        )}
      </md-outlined-select>
      <label class="tb-check">
        <md-checkbox
          touch-target="wrapper"
          .checked=${live(s.noSnaps)}
          @change=${(e: Event) => set({ noSnaps: (e.target as HTMLInputElement).checked })}
        ></md-checkbox>
        <span>${host.t("noSnaps", "No snaps")}</span>
      </label>
      ${
        activity
          ? html`
              ${ptField(host, "minBonus", html`<md-outlined-text-field
                type="number"
                min="0"
                step="5"
                label=${host.t("minBonus", "Minimum event bonus (%)")}
                .value=${live(s.minBonus === null ? "" : String(s.minBonus))}
                @change=${(e: Event) => {
              const raw = (e.target as HTMLInputElement).value;
              set({ minBonus: raw === "" ? null : Math.max(0, Number(raw)) });
            }}
              ></md-outlined-text-field>`)}
            `
          : nothing
      }
      ${s.bindings.length ? html`<ul class="pt-bindings">
        ${s.bindings.map(([member, snap], index) => html`<li>
          <span>${catalog.cardName("members", member)} → ${snap === null ? host.t("noSnap", "No snap") : catalog.cardName("snaps", snap)}</span>
          ${iconButton({ icon: "close", label: host.common("common.actions.remove", "Remove"), onClick: () => set({ bindings: s.bindings.filter((_, at) => at !== index) }) })}
        </li>`)}
      </ul>` : nothing}
      ${activity && s.rewardMode !== "plan" ? nothing : html`<div class="row row--wrap">
        <md-outlined-select
          label=${host.t("resultCount", "Results")}
          .value=${String(s.k)}
          @change=${(e: Event) => set({ k: Number((e.target as HTMLInputElement).value) })}
        >
          ${[1, 3, 5, 10, 15, 20].map(
            (k) => html`
              <md-select-option value=${String(k)}><div slot="headline">${k}</div></md-select-option>
            `,
          )}
        </md-outlined-select>

      </div>`}
    </div>
  `;
  return html`<section class="surface stack" id="tb-cards" data-tb-field tabindex="-1">
    ${sectionHeading({ icon: "style", label: host.t("scope", "Cards") })}
      ${segmented({
        label: host.t("scope", "Cards"),
        value: s.scope,
        options: [
          { value: "box", label: host.t("scopeBox", "My cards"), icon: "style" },
          { value: "theoretical", label: host.t("scopeAll", "All cards, full growth"), icon: "auto_awesome_motion" },
        ],
        onSelect: (scope) => set({ scope }),
      })}
      ${activity && s.rewardMode !== "plan" && s.scope === "box" ? html`<span class="tb-results__meta">${host.t("manualGrowth", "Recorded growth for owned cards; full growth for unowned cards")}</span>` : nothing}
      ${
        s.scope === "box" && (!activity || s.rewardMode === "plan")
          ? html`
              <div class="tb-field">
                <span class="tb-field__label">${host.t("unknownPolicy", "Growth not entered")}</span>
                ${segmented({
              label: host.t("unknownPolicy", "Growth not entered"),
              value: s.unknownPolicy,
              grow: false,
              options: [
                { value: "max", label: host.t("unknownMax", "Count as max") },
                { value: "min", label: host.t("unknownMin", "Count as minimum") },
              ],
              onSelect: (unknownPolicy) => set({ unknownPolicy }),
            })}
              </div>
            `
          : nothing
      }

    ${activity && s.rewardMode !== "plan" && s.scope === "box" ? html`
      <md-outlined-select label=${host.t("unknownPolicy", "Growth not entered")}
        .value=${farmingConditions(s.farming).requireGrowth ? "required" : s.unknownPolicy}
        ?disabled=${s.farming.play === "gekiso"}
        @change=${(e:Event)=> { const value = (e.target as HTMLInputElement).value;
          host.updateFarming(value === "required" ? {requireGrowth:true} : {requireGrowth:false,unknownPolicy:value as "min"|"max"}); }}>
        <md-select-option value="required"><div slot="headline">${host.t("farm.requireGrowth", "Complete before calculating")}</div></md-select-option>
        <md-select-option value="min"><div slot="headline">${host.t("unknownMin", "Count as minimum")}</div></md-select-option>
        <md-select-option value="max"><div slot="headline">${host.t("unknownMax", "Count as max")}</div></md-select-option>
      </md-outlined-select>` : nothing}
    <span class="tb-results__meta">${host.t("candidateSummary", "{members} member cards · {snaps} Snapshots", { members: cards.members.length, snaps: cards.snaps.length })}${required ? ` · ${host.t("requiredCount", "{count} fixed", { count: required })}` : ""}</span>
    ${required ? html`<div class="cluster">${fixedMembers.map(id => html`<span class="tb-chip">${catalog.cardName("members", id)}</span>`)}${fixedSnaps.map(id => html`<span class="tb-chip">${catalog.cardName("snaps", id)}</span>`)}</div>` : nothing}
    ${!view.members.size ? html`<button class="button button--text" @click=${() => host.setTab("box")}>${host.t("enterCards", "Enter cards")}</button>` : nothing}
    ${accordion({ id: "tb-candidates", className: "tb-accordion", leading: icon("tune", 20), label: host.t("candidates", "Cards and limits"),
      content: activity ? ptField(host, "constraints", content) : content,
      expanded: host.expanded.has("candidates"), onExpandedChange: expanded => { if (expanded) host.expanded.add("candidates"); else host.expanded.delete("candidates"); host.requestUpdate(); } })}
  </section>`;
}

export function renderBuildTab(host: TeamBuilder, leading?: TemplateResult): TemplateResult {
  const s = host.searchSettings;
  const challengeSongs = s.eventId === null ? [] : host.catalog!.challengeSongs(s.eventId).map((row) => row.liveMusicId);
  const challenge = s.goal === "event" ? s.route === "challenge" : (s.goal === "score" || s.goal === "power") && s.challengeRules;
  const allowedSongIds = challenge ? challengeSongs : s.goal === "event" || s.goal === "plan" ? host.catalog!.normalEventSongIds(s.eventId) : undefined;
  const set = (patch: Partial<BuildSettings>) => host.updateSettings(patch);
  const needsSongs =
    s.goal === "score" ||
    s.goal === "gekiso" ||
    s.goal === "plan" ||
    (s.goal === "event" && s.route !== "skip") ||
    (s.goal === "power" && s.powerSong);
  return html`
    <div class="tb-build">
      <div class="tb-config stack">
        ${leading ?? nothing}
        ${host.tab === "build" ? html`<section class="surface stack">
          ${sectionHeading({ icon: "flag", label: host.t("goal", "Goal") })}
          <div
            class="tb-goals"
            role="radiogroup"
            aria-label=${host.t("goal", "Goal")}
            @keydown=${rovingKeydown(
              GOALS.map(({ id }) => id as GoalKind),
              s.goal,
              (goal) => set({ goal }),
            )}
          >
            ${GOALS.map(
              ({ id, icon: name }) => html`
                <button
                  class=${`tb-goal${s.goal === id ? " is-selected" : ""}`}
                  type="button"
                  role="radio"
                  aria-checked=${String(s.goal === id)}
                  tabindex=${s.goal === id ? "0" : "-1"}
                  @click=${() => set({ goal: id })}
                >
                  <span class="tb-goal__icon">${icon(name, 20)}</span>
                  <span class="tb-goal__text"><strong>${goalText(host, id)}</strong></span>
                </button>
              `,
            )}
          </div>
          ${
            s.goal === "score" || s.goal === "gekiso"
              ? html`
                  <md-outlined-select
                          label=${host.t("criterion", "Score goal")}
                          .value=${scoreGoal(s)}
                          @change=${(e: Event) => {
                            const value = (e.target as HTMLInputElement).value as keyof typeof SCORE_GOALS;
                            set(s.goal === "gekiso" && (value === "mean" || value === "max" || value === "min") ? { criterion: value } : value === "at-least" || value === "capped" ? { scoreTarget: value, criterion: "mean" } : { scoreTarget: "none", criterion: value });
                          }}
                        >
                          ${(s.goal === "score" ? (["mean", "max", "min", "at-least", "capped"] as const) : (["mean", "max", "min"] as const)).map(
                            (value) => html`<md-select-option value=${value}><div slot="headline">${scoreText(host, SCORE_GOALS[value].label)}</div></md-select-option>`,
                          )}
                        </md-outlined-select>
                  ${
                    scoreGoal(s) === "at-least" || scoreGoal(s) === "capped"
                      ? html`<md-outlined-text-field
                          type="number"
                          min="1"
                          step="1"
                          inputmode="numeric"
                          id="tb-target-score" data-tb-field label=${host.t("targetScore", "Target score")}
                          .value=${live(s.targetScore ? String(s.targetScore) : "")}
                          @change=${(e: Event) => {
                            const value = Math.floor(Number((e.target as HTMLInputElement).value) || 0);
                            set({ targetScore: value > 0 ? value : null });
                          }}
                        ></md-outlined-text-field>`
                      : nothing
                  }
                `
              : nothing
          }
          ${
            s.goal === "gekiso"
              ? html`
                  ${comboBonusControl(host)}
                  ${gekisoSamplesControl(host)}
                  <div id="tb-placement" class="stack" tabindex="-1">
                    ${segmented({ label: host.t("placementMode", "Placement basis"), value: s.gekisoPlacementMode,
                      options: [{value:"rank",label:host.t("placementRank", "Specified placement")},{value:"opponents",label:host.t("placementOpponents", "Opponent scores")}],
                      onSelect: gekisoPlacementMode => set({ gekisoPlacementMode }) })}
                    ${s.gekisoPlacementMode === "rank" ? segmented({ label: host.t("gekisoRank", "Placement in each range"), value: String(s.gekisoRank),
                      options: [1,2,3,4,5].map(rank => ({value:String(rank),label:String(rank)})), onSelect: value => set({gekisoRank:Number(value)}) }) : html`
                      <div class="tb-number-grid">${[0,1,2].map(range => html`<div class="stack">
                        <md-outlined-text-field label=${`${host.t("gekisoRange", "Range {n}", {n:range+1})} · ${missionSummary([...new Set(s.songs.map(song => songMissions(host.catalog!.song(song.songId))[range]!))])}`}
                          .value=${live(s.gekisoOpponents[range])} ?error=${host.submitted && parseOpponents(s.gekisoOpponents).invalid[range]}
                          @change=${(event: Event) => { const next = [...s.gekisoOpponents] as BuildSettings["gekisoOpponents"]; next[range] = (event.target as HTMLInputElement).value; set({gekisoOpponents:next}); }}></md-outlined-text-field>
                        <span class="tb-results__meta">${parseOpponents(s.gekisoOpponents).ranges[range]!.length ? host.t("opponentCount", "{count} opponents", {count:parseOpponents(s.gekisoOpponents).ranges[range]!.length}) : host.t("emptyOpponentRank", "1st place (no opponents entered)")}</span>
                      </div>`)}</div>`}
                  </div>
                `
              : nothing
          }
          ${
            s.goal === "potential"
              ? segmented({
                  label: host.t("window", "Reference window"),
                  value: String(s.window),
                  options: [60, 120, 180].map((window) => ({ value: String(window), label: `${window} s` })),
                  onSelect: (value) => set({ window: Number(value) }),
                })
              : nothing
          }
          ${
            s.goal === "power"
              ? html`
                  <label class="tb-check">
                    <md-checkbox
                      touch-target="wrapper"
                      .checked=${live(s.powerSong)}
                      @change=${(e: Event) => set({ powerSong: (e.target as HTMLInputElement).checked })}
                    ></md-checkbox>
                    <span>${host.t("powerSong", "Include a song's type and tag bonus")}</span>
                  </label>
                `
              : nothing
          }
          ${
            s.goal === "score" || s.goal === "power"
              ? html`
                  <label class="tb-check">
                    <md-checkbox
                      touch-target="wrapper"
                      .checked=${live(s.challengeRules)}
                      @change=${(e: Event) => set({ challengeRules: (e.target as HTMLInputElement).checked })}
                    ></md-checkbox>
                    <span>${host.t("challengeRules", "Challenge live rules (event parameter bonus)")}</span>
                  </label>
                  ${s.challengeRules ? eventSection(host) : nothing}
                `
              : nothing
          }
          ${s.goal === "score" || s.goal === "gekiso" ? html`<details class="fold"><summary>${playSummary(host, s)}</summary>${playSection(host)}</details>` : nothing}
        </section>` : nothing}
        ${
          s.goal === "plan"
            ? html`
                <section class="surface stack">
                  ${sectionHeading({ icon: "cycle", label: host.t("planSetup", "Resource plan") })}
                  ${eventSection(host)}
                  <details class="fold"><summary>${playSummary(host, s)}</summary>${playSection(host)}</details>
                  <span class="tb-results__meta">${host.t("farm.memory", "Character / song memory bonuses")}: ${host.t("farm.included", "Included")}</span>
                  <div class="tb-number-grid">
                    <md-outlined-text-field
                      type="number"
                      min="0"
                      label=${host.t("planBudget", "Boosts to spend")}
                      .value=${live(String(s.planBudget))}
                      @change=${(e: Event) => set({ planBudget: Math.max(0, Number((e.target as HTMLInputElement).value) || 0) })}
                    ></md-outlined-text-field>
                    ${boostControl(host, s.planBoostsPerLive, (planBoostsPerLive) => set({ planBoostsPerLive }))}
                    <md-outlined-text-field
                      type="number"
                      min="0"
                      label=${host.t("planStartCp", "Challenge points now")}
                      .value=${live(String(s.planStartingCp))}
                      @change=${(e: Event) => set({ planStartingCp: Math.max(0, Number((e.target as HTMLInputElement).value) || 0) })}
                    ></md-outlined-text-field>
                  </div>
                  ${segmented({ label: host.t("cpPerLive", "Challenge points per live"), value: String(s.challengePoints), options: [200, 400, 800, 1600].map((cp) => ({ value: String(cp), label: `${cp}` })), onSelect: (value) => set({ challengePoints: Number(value) }) })}
                  <span class="tb-field__label">${host.t("planChallengeSongs", "Challenge songs")}</span>
                  ${songList(host, host.settings.planChallengeSongs, (planChallengeSongs) => set({ planChallengeSongs }), false, challengeSongs, "tb-challenge-songs")}
                </section>
              `
            : nothing
        }
        ${
          needsSongs
            ? html`
                <section class="surface stack">
                  ${sectionHeading({ icon: "library_music", label: challenge ? host.t("planChallengeSongs", "Challenge songs") : s.goal === "plan" ? host.t("planNormalSongs", "Normal-live songs") : host.t("songs", "Songs"), count: s.songs.length || undefined })}
                  ${songList(host, s.goal === "power" ? s.songs : host.settings.songs, (songs) => set({ songs }), s.goal === "power", allowedSongIds)}
                </section>
              `
            : nothing
        }
        ${renderCandidates(host)}
        ${renderBuildRun(host)}
      </div>
      <div class="tb-results-column">${renderResults(host)}</div>
    </div>
  `;
}

export function renderBuildRun(host: TeamBuilder, showTimeLimit = true): TemplateResult {
  const s = host.searchSettings, progress = host.progress;
  return html`
        <div class="tb-run">
                  ${showTimeLimit ? html`<md-outlined-select
          label=${host.t("timeLimit", "Time limit")}
          .value=${String(s.timeLimit ?? 0)}
          @change=${(e: Event) => {
          const v = Number((e.target as HTMLInputElement).value);
          host.updateSettings({ timeLimit: v || null });
        }}
        >
          ${[3, 5, 15, 60, 0].map(
            (limit) => html`
              <md-select-option value=${String(limit)}>
                <div slot="headline">${limit ? `${limit} s` : host.t("noLimit", "Until proven")}</div>
              </md-select-option>
            `,
          )}
        </md-outlined-select>` : nothing}
          ${host.submitted && host.inputIssues().length ? html`<div class="surface stack" role="alert">${host.inputIssues().map(issue => html`<button class="button button--text" @click=${() => host.focusInput(issue.field)}>${issue.message}</button>`)}</div>` : nothing}
          ${host.hasTaskResults ? html`<button class="button button--text" @click=${() => host.querySelector(".tb-results-column")?.scrollIntoView({block:"start"})}>${host.t("viewResults", "View results")}</button>` : nothing}
          ${
            host.taskKind === "build"
              ? html`
                  <button class="button button--tonal button--full" type="button" @click=${() => host.cancel()}>
                    ${icon("stop", 18)}${host.common("common.actions.cancel", "Cancel")}
                  </button>
                  <span role="status">${host.computationStatus()}</span>
                  <md-linear-progress
                    .value=${progress && progress.total ? progress.done / progress.total : 0}
                    ?indeterminate=${!progress || progress.total <= 1}
                    aria-label=${host.t("searching", "Searching teams")}
                  ></md-linear-progress>
                `
              : html`
                  <button
                    class="button button--full tb-run__button"
                    type="button"
                    ?disabled=${host.running}
                    @click=${() => void host.run()}
                  >
                    ${host.running ? host.t("sc.busy", "Another calculation is running") : html`${icon("search", 20)}${host.tab === "pt" ? s.goal === "plan" ? host.t("farm.planRun", "Calculate resource plan") : s.route === "skip" ? host.t("farm.skipRun", "Recommend skip team") : host.t("farm.run", "Recommend songs and teams") : host.t("findTeams", "Find teams")}`}
                  </button>
                `
          }
        </div>`;
}
