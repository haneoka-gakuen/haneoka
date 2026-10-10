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
import { activityDetails } from "./activity-details";
import type { BuildSettings, GoalKind } from "./types";
import type { TeamBuilder } from "../team-builder";

const GOALS = [
  { id: "score", icon: "music_note" },
  { id: "gekiso", icon: "local_fire_department" },
  { id: "power", icon: "bolt" },
  { id: "potential", icon: "auto_awesome" },
] as const;

function goalText(host: TeamBuilder, goal: GoalKind): string {
  switch (goal) {
    case "score":
      return host.t("goalScore", "Highest score");
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

function songList(
  host: TeamBuilder,
  songs: SongRef[],
  change: (songs: SongRef[]) => void,
  single = false,
): TemplateResult {
  const catalog = host.catalog!;
  return html`
    <div class="tb-songs">
      ${songs.map(
        (song, index) => html`
          <div class="list-item list-item--two-line tb-song">
            <span class="list-item__leading tb-song__art">
              ${tileMedia({ ...catalog.songOptions(song.songId, song.difficulty), marks: [] })}
            </span>
            <span class="list-item__body">
              <strong class="list-item__headline clamp-1">${catalog.songTitle(song.songId)}</strong>
              <span class="list-item__supporting">${catalog.difficultyLabel(song.songId, song.difficulty)}</span>
            </span>
            <span class="list-item__trailing">
              ${iconButton({ icon: "close", label: host.common("common.actions.remove", "Remove"), onClick: () => change(songs.filter((_, at) => at !== index)) })}
            </span>
          </div>
        `,
      )}
      <button
        class="button button--tonal tb-songs__add"
        type="button"
        @click=${() => {
          host.songPicker = {
            songs: [...songs],
            single,
            query: "",
            filtersOpen: false,
            bands: [],
            attributes: [],
            gekisouTypes: [],
            difficulty: 3,
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

function eventSection(host: TeamBuilder): TemplateResult {
  const s = host.settings;
  const catalog = host.catalog!;
  const events = catalog.events();
  const set = (patch: Partial<BuildSettings>) => host.updateSettings(patch);
  if (!events.length)
    return html`
      <p class="inline-message">${icon("info", 18)}${host.t("noEvents", "This server's data has no event yet.")}</p>
    `;
  const eventId = s.eventId ?? events[0]!.id;
  if (s.eventId === null) queueMicrotask(() => set({ eventId }));
  const event = events.find((row) => row.id === eventId)?.event;
  const challengeSongs = catalog.challengeSongs(eventId);
  return html`
    <md-outlined-select
      label=${host.t("event", "Event")}
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
      event?.musicId || challengeSongs.length
        ? html`
            <div class="cluster">
              ${
            event?.musicId
              ? html`
                  <button
                    class="button button--text button--small"
                    type="button"
                    @click=${() => set({ songs: [{ songId: event.musicId, difficulty: 3 }] })}
                  >
                    ${icon("music_note", 18)}${host.t("useEventSong", "Use the event song")}
                  </button>
                `
              : nothing
          }
              ${
            challengeSongs.length && (s.goal === "plan" || s.route === "challenge")
              ? html`
                  <button
                    class="button button--text button--small"
                    type="button"
                    @click=${() => set(s.goal === "plan" ? { planChallengeSongs: challengeSongs.map((row) => ({ songId: row.liveMusicId, difficulty: 3 })) } : { songs: challengeSongs.map((row) => ({ songId: row.liveMusicId, difficulty: 3 })) })}
                  >
                    ${icon("swords", 18)}${host.t("useChallengeSongs", "Use challenge songs")}
                  </button>
                `
              : nothing
          }
            </div>
          `
        : nothing
    }
  `;
}

function playSection(host: TeamBuilder): TemplateResult {
  const s = host.settings;
  const set = (patch: Partial<BuildSettings>) => host.updateSettings(patch);
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
              <div class="tb-field">
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
              </div>
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

function candidates(host: TeamBuilder): TemplateResult {
  const s = host.settings;
  const catalog = host.catalog!;
  const view = host.view!;
  const set = (patch: Partial<BuildSettings>) => host.updateSettings(patch);
  const cards = host.engineCards();
  const toggleIn = (list: number[], value: number) =>
    list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
  const required =
    [...view.members.values()].filter((row) => row.use && row.lock).length +
    [...view.snaps.values()].filter((row) => row.use && row.lock).length;
  const ownedMembers = [...view.members.values()].filter((row) => row.use).map((row) => row.cardId);
  const bands = Object.keys(catalog.data.bands)
    .map(Number)
    .filter((id) => catalog.bandName(id));
  const content = html`
    <div class="stack">
      ${segmented({
        label: host.t("scope", "Cards"),
        value: s.scope,
        options: [
          { value: "box", label: host.t("scopeBox", "My cards"), icon: "style" },
          { value: "theoretical", label: host.t("scopeAll", "All cards, full growth"), icon: "auto_awesome_motion" },
        ],
        onSelect: (scope) => set({ scope }),
      })}
      ${
        s.scope === "box"
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
      <div class="tb-field">
        <span class="tb-field__label">${host.common("catalog.fields.attribute", "Attribute")}</span>
        <div class="cluster">
          ${[1, 2, 3, 4, 5].map((id) => filterChip({ label: catalog.attributeName(id), image: catalog.attributeIcon(id) || undefined, selected: s.attributes.includes(id), onToggle: () => set({ attributes: toggleIn(s.attributes, id) }) }))}
        </div>
      </div>
      <div class="tb-field">
        <span class="tb-field__label">${host.common("catalog.fields.band", "Band")}</span>
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
        s.goal === "event" || s.goal === "plan"
          ? html`
              <md-outlined-text-field
                type="number"
                min="0"
                step="5"
                label=${host.t("minBonus", "Minimum event bonus (%)")}
                .value=${live(s.minBonus === null ? "" : String(s.minBonus))}
                @change=${(e: Event) => {
              const raw = (e.target as HTMLInputElement).value;
              set({ minBonus: raw === "" ? null : Math.max(0, Number(raw)) });
            }}
              ></md-outlined-text-field>
            `
          : nothing
      }
      <div class="row row--wrap">
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
        <md-outlined-select
          label=${host.t("timeLimit", "Time limit")}
          .value=${String(s.timeLimit ?? 0)}
          @change=${(e: Event) => {
          const v = Number((e.target as HTMLInputElement).value);
          set({ timeLimit: v || null });
        }}
        >
          ${[0, 5, 15, 60].map(
            (limit) => html`
              <md-select-option value=${String(limit)}>
                <div slot="headline">${limit ? `${limit} s` : host.t("noLimit", "Until proven")}</div>
              </md-select-option>
            `,
          )}
        </md-outlined-select>
      </div>
    </div>
  `;
  return accordion({
    id: "tb-candidates",
    className: "surface tb-accordion",
    leading: icon("tune", 20),
    label: host.t("candidates", "Cards and limits"),
    supportingText: `${host.t("candidateSummary", "{members} members · {snaps} snaps", { members: cards.members.length, snaps: cards.snaps.length })}${required ? ` · ${host.t("requiredCount", "{count} required", { count: required })}` : ""}`,
    content,
    expanded: host.expanded.has("candidates"),
    onExpandedChange: (expanded) => {
      if (expanded) host.expanded.add("candidates");
      else host.expanded.delete("candidates");
      host.requestUpdate();
    },
  });
}

export function renderBuildTab(host: TeamBuilder, showGoals = true): TemplateResult {
  const s = host.settings;
  const set = (patch: Partial<BuildSettings>) => host.updateSettings(patch);
  const cards = host.engineCards();
  const goal = host.goal();
  const missing = !cards.members.length
    ? host.t("needCards", "Add cards in My cards, or search all cards at full growth.")
    : !goal
      ? s.goal === "event" || s.goal === "plan"
        ? host.t("needEventSongs", "Choose an event and songs.")
        : host.t("needSongs", "Choose at least one song.")
      : "";
  const needsSongs =
    s.goal === "score" ||
    s.goal === "gekiso" ||
    s.goal === "plan" ||
    (s.goal === "event" && s.route !== "skip") ||
    (s.goal === "power" && s.powerSong);
  const progress = host.progress;
  return html`
    <div class="tb-build">
      <div class="tb-config stack">
        ${s.goal === "event" || s.goal === "plan" ? activityDetails(host, s.goal) : nothing}
        ${showGoals ? html`
        <section class="surface stack">
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
                  ${segmented({
                    label: host.t("criterion", "Rank by"),
                    value: s.criterion,
                    options: [
                      { value: "mean", label: host.t("criterionMean", "Average of 120 orders") },
                      { value: "min", label: host.t("criterionMin", "Worst order (stable)") },
                    ],
                    onSelect: (criterion) => set({ criterion }),
                  })}
                `
              : nothing
          }
          ${
            s.goal === "gekiso"
              ? segmented({
                  label: host.t("gekisoRank", "Placement in each range"),
                  value: String(s.gekisoRank),
                  options: [1, 2, 3, 4, 5].map((rank) => ({ value: String(rank), label: `${rank}` })),
                  onSelect: (value) => set({ gekisoRank: Number(value) }),
                })
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
        </section>
        ` : nothing}
        ${
          s.goal === "event"
            ? html`
                <section class="surface stack">
                  ${sectionHeading({ icon: "emoji_events", label: host.t("eventSetup", "Event") })}
                  ${eventSection(host)}
                  ${segmented({
                label: host.t("route", "Play"),
                value: s.route,
                options: [
                  { value: "live", label: host.t("routeLive", "Normal live"), icon: "play_arrow" },
                  { value: "challenge", label: host.t("routeChallenge", "Challenge live"), icon: "swords" },
                  { value: "skip", label: host.t("routeSkip", "Skip"), icon: "fast_forward" },
                ],
                onSelect: (route) =>
                  set({ route, measure: route !== "live" && s.measure === "challenge-points" ? "points" : s.measure }),
              })}
                  ${segmented({
                label: host.t("measure", "Maximize"),
                value: s.measure,
                options: [
                  { value: "points", label: host.t("measurePoints", "Event points") },
                  { value: "items", label: host.t("measureItems", "Shop items") },
                  ...(s.route === "live"
                    ? [{ value: "challenge-points" as const, label: host.t("measureCp", "Challenge points") }]
                    : []),
                ],
                onSelect: (measure) => set({ measure }),
              })}
                  ${
                s.route === "challenge"
                  ? html`<span class="tb-field__label">${host.t("pt.challengeCost", "CP per challenge")}</span>${segmented({
                      label: host.t("cpPerLive", "Challenge points per live"),
                      value: String(s.challengePoints),
                      options: [200, 400, 800, 1600].map((cp) => ({ value: String(cp), label: `${cp}` })),
                      onSelect: (value) => set({ challengePoints: Number(value) }),
                    })}`
                  : boostControl(host, s.boosts, (boosts) => set({ boosts }))
              }
                </section>
              `
            : nothing
        }
        ${
          s.goal === "plan"
            ? html`
                <section class="surface stack">
                  ${sectionHeading({ icon: "cycle", label: host.t("activity.budget", "Budget estimate") })}
                  ${eventSection(host)}
                  <div class="tb-number-grid">
                    <md-outlined-text-field
                      type="number"
                      min="0"
                      label=${s.planBoostsPerLive === 0 ? host.t("activity.unboostedPlays", "Normal plays at 0 boosts") : host.t("planBudget", "Boosts to spend")}
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
                  <span class="tb-field__label">${host.t("pt.challengeCost", "CP per challenge")}</span>
                  ${segmented({ label: host.t("cpPerLive", "Challenge points per live"), value: String(s.challengePoints), options: [200, 400, 800, 1600].map((cp) => ({ value: String(cp), label: `${cp}` })), onSelect: (value) => set({ challengePoints: Number(value) }) })}
                  <span class="tb-field__label">${host.t("planChallengeSongs", "Challenge songs")}</span>
                  ${songList(host, s.planChallengeSongs, (planChallengeSongs) => set({ planChallengeSongs }))}
                </section>
              `
            : nothing
        }
        ${
          needsSongs
            ? html`
                <section class="surface stack">
                  ${sectionHeading({ icon: "library_music", label: s.goal === "plan" ? host.t("planNormalSongs", "Normal-live songs") : host.t("songs", "Songs"), count: s.songs.length || undefined })}
                  ${s.goal === "power" ? songList(host, s.songs.slice(0, 1), (songs) => set({ songs }), true) : songList(host, s.songs, (songs) => set({ songs }))}
                </section>
              `
            : nothing
        }
        ${
          s.goal === "score" || s.goal === "gekiso" || s.goal === "plan" || (s.goal === "event" && s.route !== "skip")
            ? html`
                <section class="surface stack">
                  ${sectionHeading({ icon: "piano", label: host.t("play", "Play") })}${playSection(host)}
                </section>
              `
            : nothing
        }
        ${candidates(host)}
        <div class="tb-run">
          ${
            host.running
              ? html`
                  <button class="button button--tonal button--full" type="button" @click=${() => host.cancel()}>
                    ${icon("stop", 18)}${host.common("common.actions.cancel", "Cancel")}
                  </button>
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
                    ?disabled=${!!missing}
                    @click=${() => void host.run()}
                  >
                    ${icon("search", 20)}${s.goal === "plan" ? host.t("activity.estimate", "Estimate rewards") : s.goal === "event" ? host.t("activity.calculateSingle", "Find a team for one play") : host.t("findTeams", "Find teams")}
                  </button>
                `
          }
          ${
            missing
              ? html`
                  <p class="field-note">${missing}</p>
                `
              : nothing
          }
        </div>
      </div>
      <div class="tb-results-column">${renderResults(host)}</div>
    </div>
  `;
}
