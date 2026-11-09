import { gekisoHelpButton } from "./gekiso-help";
import { rangeRankControl } from "./gekiso-rank";
import { farmingMode, justBaseWindow } from "./workspace-state";
import { enableManualEvent, renderManualEvent } from "./manual-event";
import { toolLayout } from "./tool-layout";
import { songMissions } from "../../lib/catalog-filters";
import { multiSongControl, songRulesControl } from "./song-rules";
import { arenaSongView } from "../../lib/team-builder/arena";
import { boostControl } from "./boost-control";
/** Team search: goal, songs, play, candidates and constraints; results beside them. */
import { html, nothing, type TemplateResult } from "lit";
import { live } from "lit/directives/live.js";
import "@material/web/progress/linear-progress.js";
import type { SongRef } from "../../lib/team-builder/engine/api";
import { cardRarityName } from "../shared/rarity-icon";
import { filterChip, iconButton, inputChip, rovingKeydown, segmented } from "../ui/controls";
import { selectionPane } from "../ui/selection-pane";
import { matchesCardFilters, renderCardFilters } from "./card-filters";
import { accordion } from "../ui/accordion";
import { icon } from "../ui/icon";
import { tileMedia } from "../ui/tile";
import { sectionHeading } from "./catalog";
import { renderResults } from "./results";
import { renderScoreGoal, scoreGoal } from "./score-goal";
import { CUSTOM_ACCURACY, type BuildSettings, type GoalKind, type LuckSamplingMode } from "./types";
import type { TeamBuilder } from "../team-builder";
import { farmingConditions, missionSummary, parseOpponents } from "./workspace-state";
import { ptField, ptFieldInvalid } from "./pt-fields";
import { MAX_GEKISO_COUNT, validGekisoCount } from "../../lib/team-builder/constraint-feasibility";

const GOALS = [
  { id: "score", icon: "music_note" },
  { id: "gekiso", icon: "local_fire_department" },
  { id: "power", icon: "bolt" },
  { id: "potential", icon: "auto_awesome" },
] as const;

export function gekisoSamplesControl(host: TeamBuilder, context: "score" | "rewards" = "score"): TemplateResult {
  const draft = host.tab === "arena" ? host.arena.draft.build : host.settings;
  const mode = context === "rewards" ? draft.ptSamplingMode : draft.gekisoSamplingMode;
  const samples = context === "rewards" ? draft.ptLuckSamples : draft.gekisoSeeds;
  const expected = context === "score" && mode === "auto";
  return html`
    <div class="stack">
      <div class="row row--between">
        <span class="tb-field__label">${host.t("pt.luckSampling", "LUCK calculation")}</span>
        ${gekisoHelpButton(host, "luck")}
      </div>
      ${segmented({
      label: host.t("pt.luckSampling", "LUCK calculation"),
      value: context === "score" ? (expected ? "auto" : "manual") : mode,
      options: [
        {
          value: "auto",
          label:
            context === "score"
              ? host.t("luckExpectation", "Probability expectation")
              : host.t("luckAutomaticSamples", "Automatic ({count} runs)", { count: 32 }),
        },
        { value: "manual", label: host.t("luckSimulation", "Random simulations") },
      ],
      onSelect: (value) =>
        host.updateSettings(
          context === "rewards"
            ? { ptSamplingMode: value as LuckSamplingMode }
            : {
                gekisoSamplingMode: value as LuckSamplingMode,
                ...(value === "manual" && samples <= 0 ? { gekisoSeeds: 32 } : {}),
              },
        ),
    })}
      ${
      mode === "manual" && !expected
        ? html`
            <md-outlined-text-field
              id="tb-luck-samples"
              data-tb-field
              type="number"
              min="1"
              max=${String(MAX_GEKISO_COUNT)}
              step="1"
              inputmode="numeric"
              label=${host.t("luckSimulationCount", "Simulation runs")}
              .value=${live(String(samples))}
              ?error=${host.submitted && !validGekisoCount(samples, 1)}
              @change=${(event: Event) =>
          host.updateSettings(
            context === "rewards"
              ? { ptLuckSamples: Number((event.target as HTMLInputElement).value) }
              : { gekisoSeeds: Number((event.target as HTMLInputElement).value) },
          )}
            ></md-outlined-text-field>
          `
        : nothing
    }
    </div>
  `;
}

export function missionMembersControl(host: TeamBuilder): TemplateResult {
  const s = host.searchSettings;
  const limits = host.constraintLimits();
  const total = s.minMissionMembers.reduce((sum, count) => sum + count, 0);
  const set = (index: number, value: number) => {
    const counts = [...s.minMissionMembers] as BuildSettings["minMissionMembers"];
    counts[index] = value;
    host.updateSettings({ minMissionMembers: counts });
  };
  return html`<div class="stack" id="tb-mission-members" data-tb-field tabindex="-1">
    <div class="row row--between">
      <span class="tb-field__label">${host.t("missionMembers", "GEKISO skill members")}</span>
      <span class="tb-results__meta tabular" role="status" aria-label=${host.t("missionMemberTotal", "Minimums set: {count} / 5", { count: total })}>${total} / 5</span>
      ${gekisoHelpButton(host, "members")}
    </div>
    ${([[0, "COMBO"], [2, "JUST"], [1, "LUCK"]] as const).map(([index, role]) => {
      const label = host.t("missionMemberMinimum", "{role} members (minimum)", { role });
      return html`<div class="stack stack--tight">
        <div class="row row--between">
          <span class="tb-field__label">${label}</span>
          <span class="cluster"><span class="tb-results__meta tabular">${host.t("constraintUpperBound", "Upper limit: {value}", { value: limits?.members[index] == null ? "—" : Math.min(limits.members[index]!, 5 - total + s.minMissionMembers[index]) })}</span><button class="button button--text" type="button" data-tb-role-reset ?disabled=${s.minMissionMembers[index] === 0}
            aria-label=${`${label} / ${host.t("unlimitedCombo", "No minimum")}`} @click=${() => set(index, 0)}>${host.t("unlimitedCombo", "No minimum")}</button>
          </span>
        </div>
        ${segmented({
          label,
          value: s.minMissionMembers[index] ? String(s.minMissionMembers[index]) : "",
          options: [1, 2, 3, 4, 5].map(value => ({ value: String(value), label: String(value),
            disabled: value > Math.min(limits?.members[index] ?? 5, 5 - total + s.minMissionMembers[index]) })),
          onSelect: value => set(index, Number(value)),
        })}
      </div>`;
    })}
  </div>`;
}

export function gekisoSamplingAdvanced(host: TeamBuilder): TemplateResult | typeof nothing {
  const s = host.searchSettings;
  return s.gekisoSamplingMode === "manual" || host.hasMission("Luck", s.songs) ? gekisoSamplesControl(host) : nothing;
}

export function comboBonusControl(host: TeamBuilder): TemplateResult | typeof nothing {
  if (!host.hasComboSongs()) return nothing;
  const s = host.searchSettings;
  const limit = host.constraintLimits()?.combo;
  return html`
    <div class="row">
      <md-outlined-text-field
        class="row__spacer"
        id="tb-combo"
        data-tb-field
        type="number"
        min="1"
        max=${String(MAX_GEKISO_COUNT)}
        step="1"
        inputmode="numeric"
        label=${host.t("openingComboMinimum", "Opening COMBO BONUS minimum")}
        prefix-text="×"
        .value=${live(s.minComboBonus === 1 ? "" : String(s.minComboBonus))}
        placeholder=${host.t("unlimitedCombo", "No minimum")}
        supporting-text=${host.t("constraintUpperBound", "Upper limit: {value}", { value: limit == null ? "—" : `×${limit}` })}
        ?error=${host.submitted && host.inputIssues().some((issue) => issue.field === "tb-combo" || issue.fields?.includes("tb-combo"))}
        @change=${(event: Event) => host.updateSettings({ minComboBonus: (event.target as HTMLInputElement).value === "" ? 1 : Number((event.target as HTMLInputElement).value) })}
      ></md-outlined-text-field>
      ${gekisoHelpButton(host, "combo")}
    </div>
  `;
}

export function justWindowControl(host: TeamBuilder): TemplateResult | typeof nothing {
  const s = host.searchSettings;
  if (!host.hasMission("JustCount", s.songs)) return nothing;
  const percent = s.justWindowUnit === "percent";
  const value = percent ? s.justWindowPercent : s.justWindowMs;
  const limit = host.constraintLimits()?.justMs;
  const base = justBaseWindow(host.data);
  const upper = limit == null ? "—" : percent && base ? `+${Math.floor((limit / base - 1) * 100)}%` : `±${limit} ms`;
  return html`
    <div class="stack">
      <div class="row row--between">
        <span class="tb-field__label">${host.t("justWindowTarget", "JUST window minimum")}</span>
        ${gekisoHelpButton(host, "just")}
      </div>
      ${segmented({
      label: host.t("justWindowUnit", "JUST window unit"),
      value: s.justWindowUnit,
      options: [
        { value: "percent", label: "+%" },
        { value: "ms", label: "±ms" },
      ],
      onSelect: (unit) => {
        const base = justBaseWindow(host.data ?? null);
        host.updateSettings({
          justWindowUnit: unit as BuildSettings["justWindowUnit"],
          ...(unit === "ms"
            ? { justWindowMs: s.justWindowMs }
            : base && s.justWindowMs > 0
              ? { justWindowPercent: Math.max(0, (s.justWindowMs / base - 1) * 100) }
              : { justWindowPercent: 0 }),
        });
      },
    })}
      <md-outlined-text-field
        id="tb-just-window"
        data-tb-field
        type="number"
        min="0"
        max=${String(MAX_GEKISO_COUNT)}
        step=${percent ? "100" : "0.1"}
        inputmode="numeric"
        label=${percent ? host.t("justWindowPercent", "JUST window increase (minimum)") : host.t("justWindow", "Ideal JUST tap window")}
        prefix-text=${percent ? "+" : "±"}
        suffix-text=${percent ? "%" : "ms"}
        .value=${live(value === 0 ? "" : String(value))}
        placeholder=${host.t("unlimitedCombo", "No minimum")}
        supporting-text=${host.t("constraintUpperBound", "Upper limit: {value}", { value: upper })}
        ?error=${host.submitted && host.inputIssues().some((issue) => issue.field === "tb-just-window" || issue.fields?.includes("tb-just-window"))}
        @change=${(event: Event) =>
        host.updateSettings(
          percent
            ? { justWindowPercent: Number((event.target as HTMLInputElement).value) }
            : { justWindowMs: Number((event.target as HTMLInputElement).value) },
        )}
      ></md-outlined-text-field>
    </div>
  `;
}

export function placementControl(host: TeamBuilder): TemplateResult {
  const s = host.searchSettings;
  const set = (patch: Partial<BuildSettings>) => host.updateSettings(patch);
  const missions = (song: SongRef) => {
    const row = host.catalog!.song(song.songId);
    return songMissions(s.arena ? arenaSongView(row, s.arena) : row);
  };
  return html`
    <div id="tb-placement" class="stack" tabindex="-1">
      <div class="row row--between"><span class="tb-field__label">${host.t("gekisoPlacements", "Scoring placements")}</span>${gekisoHelpButton(host, "placements")}</div>
      ${segmented({
    label: host.t("placementMode", "Placement basis"),
    value: s.gekisoPlacementMode,
    options: [
      { value: "rank", label: host.t("placementRank", "Specified placement") },
      { value: "opponents", label: host.t("placementOpponents", "Opponent scores") },
    ],
    onSelect: (gekisoPlacementMode) => set({ gekisoPlacementMode }),
  })}
      ${
    s.gekisoPlacementMode === "rank"
      ? rangeRankControl(host, s.gekisoRanks, (range, rank) => {
          const gekisoRanks = [...s.gekisoRanks] as BuildSettings["gekisoRanks"];
          gekisoRanks[range] = rank;
          set({ gekisoRanks });
        })
      : html`
          <div class="tb-number-grid">
            ${[0, 1, 2].map(
              (range) => html`
                <div class="stack">
                  <md-outlined-text-field
                    label=${`${host.t("gekisoRange", "Range {n}", { n: range + 1 })} ${missionSummary([...new Set(s.songs.map((song) => missions(song)[range]!))])}`}
                    .value=${live(s.gekisoOpponents[range])}
                    ?error=${host.submitted && parseOpponents(s.gekisoOpponents).invalid[range]}
                    @change=${(event: Event) => {
                      const next = [...s.gekisoOpponents] as BuildSettings["gekisoOpponents"];
                      next[range] = (event.target as HTMLInputElement).value;
                      set({ gekisoOpponents: next });
                    }}
                  ></md-outlined-text-field>
                  <span class="tb-results__meta">
                    ${parseOpponents(s.gekisoOpponents).ranges[range]!.length ? host.t("opponentCount", "{count} opponents", { count: parseOpponents(s.gekisoOpponents).ranges[range]!.length }) : host.t("emptyOpponentRank", "1st place (no opponents entered)")}
                  </span>
                </div>
              `,
            )}
          </div>
        `
  }
    </div>
  `;
}

function goalText(host: TeamBuilder, goal: GoalKind): string {
  switch (goal) {
    case "score":
      return host.t("goalScore", "Live score");
    case "gekiso":
      return host.t("goalGekiso", "GEKISO score");
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
  allowedCharts?: readonly SongRef[],
): TemplateResult {
  const catalog = host.catalog!;
  const available = (song: SongRef) =>
    (!allowedSongIds || allowedSongIds.includes(song.songId)) &&
    (!allowedCharts || allowedCharts.some((ref) => ref.songId === song.songId && ref.difficulty === song.difficulty)) &&
    catalog.difficultyRows(song.songId).some((row) => Number(row.difficulty) === song.difficulty);
  return html`
    <div class="tb-songs" id=${fieldId} data-tb-field tabindex="-1">
      <div class="row row--between tb-input-summary">
        <span class="tb-results__meta">
          ${host.t("chartCount", "{count} charts", { count: songs.filter(available).length })}
        </span>
        <button
          class="button button--tonal tb-songs__add"
          type="button"
          @click=${() => {
            host.songPicker = {
              songs: songs.map((song) => ({ ...song })),
              context: `${host.tab}:${host.searchSettings.goal}:${single ? "single" : allowedSongIds ? "restricted" : "songs"}${host.tab === "arena" ? `:${host.arena.draft.leagueId}` : ""}`,
              single,
              query: "",
              filtersOpen: false,
              bands: [],
              attributes: [],
              gekisouTypes: [],
              difficulty: 3,
              allowedSongIds,
              allowedCharts: allowedCharts ? [...allowedCharts] : undefined,
              songRules: host.tab === "arena" ? host.arena.rule : host.songRules(),
              change,
            };
            host.requestUpdate();
          }}
        >
          ${icon("add", 18)}${songs.length ? host.t("editSongs", "Change songs") : host.t("addSongs", "Choose songs")}
        </button>
      </div>
      ${
        songs.length
          ? html`
              <div class="tb-songs__list" role="region" aria-label=${host.t("songs", "Songs")} tabindex="0">
                ${songs.map(
                  (song, index) => html`
                    <div class="list-item list-item--two-line tb-song">
                      <span class="list-item__leading tb-song__art">
                        ${tileMedia({ ...catalog.songOptions(song.songId, song.difficulty), marks: [] })}
                      </span>
                      <span class="list-item__body">
                        <strong class="list-item__headline clamp-1">${catalog.songTitle(song.songId)}</strong>
                        <span class="list-item__supporting">
                          ${catalog.difficultyLabel(song.songId, song.difficulty)}${(host.tab !== "arena" && host.searchSettings.goal === "gekiso") || (host.tab === "pt" && host.settings.rewardMode === "recommendation" && host.searchSettings.ptMode === "gekiso") ? ` / ${missionSummary(songMissions(host.songRules() ? arenaSongView(catalog.song(song.songId), host.songRules()!) : catalog.song(song.songId)))}` : ""}${!available(song) ? ` / ${host.t("unavailable", "Unavailable")}` : ""}
                        </span>
                      </span>
                      <span class="list-item__trailing">
                        ${iconButton({ icon: "close", label: host.common("common.actions.remove", "Remove"), onClick: () => change(songs.filter((_, at) => at !== index)) })}
                      </span>
                    </div>
                  `,
                )}
              </div>
            `
          : nothing
      }
    </div>
  `;
}

export function eventSection(host: TeamBuilder, s = host.searchSettings): TemplateResult {
  const catalog = host.catalog!;
  const events = catalog.events();
  const set = (patch: Partial<BuildSettings>) => host.updateSettings(patch);
  const manualAllowed = host.tab === "pt" && s.goal !== "plan";
  const manual = manualAllowed && s.manualEventEnabled;
  if (!events.length && !manualAllowed)
    return html`
      <p class="inline-message">${icon("info", 18)}${host.t("noEvents", "This server's data has no event yet.")}</p>
    `;
  const eventId = host.settings.eventId ?? events[0]?.id ?? null;
  if (host.settings.eventId === null && eventId !== null && !manual) queueMicrotask(() => set({ eventId }));
  const challengeSongs = catalog.challengeSongs(eventId);
  const challenge = s.goal === "plan" || (s.goal === "event" ? s.route === "challenge" : s.challengeRules);
  return html`
    <md-outlined-select
      id="tb-event"
      data-tb-field
      label=${host.t("event", "Event")}
      .value=${manual ? "manual" : String(eventId ?? "")}
      @change=${(e: Event) => {
        const value = (e.target as HTMLInputElement).value;
        if (value === "manual") enableManualEvent(host);
        else set({ eventId: Number(value), manualEventEnabled: false, rewardMode: s.goal === "plan" ? "plan" : farmingMode(host.settings.farming) });
      }}
    >
      ${!events.length ? html`<md-select-option value="" disabled><div slot="headline">${host.t("manualEvent.choose", "Choose an event")}</div></md-select-option>` : nothing}
      ${manualAllowed ? html`<md-select-option value="manual"><div slot="headline">${host.t("manualEvent.manual", "Manual setup")}</div></md-select-option>` : nothing}
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
    ${manual ? renderManualEvent(host) : nothing}
    ${
      !manual && challenge && challengeSongs.length
        ? html`
            <div class="cluster">
              <button
                class="button button--text button--small"
                type="button"
                @click=${() => {
                  const songs = challengeSongs
                    .filter((row) =>
                      catalog.difficultyRows(row.liveMusicId).some((difficulty) => Number(difficulty.difficulty) === 3),
                    )
                    .map((row) => ({ songId: row.liveMusicId, difficulty: 3 }));
                  set(
                    s.goal === "plan"
                      ? { planChallengeSongs: songs }
                      : { songs: s.goal === "power" ? songs.slice(0, 1) : songs },
                  );
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

export function playConditions(host: TeamBuilder, s = host.searchSettings): TemplateResult {
  const key = `play-${host.tab}-${host.tab === "build" ? host.buildMode : s.goal}`;
  return accordion({
    id: `tb-${key}`,
    label: host.t("playJudgements", "Play judgements"),
    supportingText: s.playMode === "ap" ? host.t("playAp", "All Perfect") : host.t("playCustom", "Custom"),
    leading: icon("piano", 20),
    expanded: host.expanded.has(key),
    onExpandedChange: (expanded) => {
      if (expanded) host.expanded.add(key);
      else host.expanded.delete(key);
      host.requestUpdate();
    },
    content: html`
      <div class="stack">${playSection(host, s)}</div>
    `,
  });
}

export function playSection(
  host: TeamBuilder,
  s = host.searchSettings,
  set = (patch: Partial<BuildSettings>) => host.updateSettings(patch),
): TemplateResult {
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
      label: host.t("playJudgements", "Play judgements"),
      value: s.playMode,
      options: [
        { value: "ap", label: host.t("playAp", "All Perfect"), icon: "workspace_premium" },
        { value: "custom", label: host.t("playCustom", "My accuracy"), icon: "tune", disabled: !CUSTOM_ACCURACY },
      ],
      onSelect: (playMode) => set({ playMode }),
    })}
    ${s.goal === "score" ? html`<div class="tb-field">
      <span class="tb-field__label">${host.t("frameRate", "Game frame rate (FPS)")}</span>
      ${segmented({
        label: host.t("frameRate", "Game frame rate (FPS)"),
        value: String(s.frameRate),
        options: [30, 60, 90, 120].map(value => ({ value: String(value), label: String(value) })),
        onSelect: value => set({ frameRate: Number(value) as BuildSettings["frameRate"] }),
      })}
    </div>` : nothing}
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
              ${
                host.hasMission("JustCount", s.songs)
                  ? html`
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
                    `
                  : nothing
              }
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
  const fixedMembers = [
    ...new Set([
      ...(s.scope === "box"
        ? [...view.members.values()].filter((row) => row.use && row.lock).map((row) => row.cardId)
        : []),
      ...s.bindings.map(([id]) => id),
      ...(s.leader === null ? [] : [s.leader]),
      ...s.required.members,
    ]),
  ];
  const fixedSnaps = [
    ...new Set([
      ...(s.scope === "box"
        ? [...view.snaps.values()].filter((row) => row.use && row.lock).map((row) => row.cardId)
        : []),
      ...s.bindings.flatMap(([, id]) => (id === null ? [] : [id])),
      ...s.required.snaps,
    ]),
  ];
  const required = fixedMembers.length + fixedSnaps.length;
  const addRequired = (kind: "members" | "snaps") => html`
    <div class="tb-field">
      <span class="tb-field__label">${host.t(kind === "members" ? "requiredMembers" : "requiredSnaps", kind === "members" ? "Required members" : "Required snaps")}</span>
      <div class="cluster">
        <button class="button button--text button--small" type="button" @click=${() => { host.requiredPicker = kind; host.requestUpdate(); }}>
          ${icon("add", 18)}${host.t("add", "Add card")}
        </button>
      </div>
    </div>
  `;
  const fixedChip = (kind: "members" | "snaps", id: number) =>
    s.required[kind].includes(id)
      ? inputChip(catalog.cardName(kind, id), host.common("common.actions.remove", "Remove"), () =>
          set({ required: { ...s.required, [kind]: s.required[kind].filter((item) => item !== id) } }),
        )
      : html`<span class="tb-chip">${catalog.cardName(kind, id)}</span>`;
  const ownedMembers = cards.members.map((row) => row.cardId);
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
      ${
        host.tab !== "arena"
          ? html`
              <div class="tb-field">
        <span class="tb-field__label">${host.t("memberBand", "Member band")}</span>
        <div class="cluster">
          ${bands.map((id) => filterChip({ label: catalog.bandName(id), image: catalog.bandIcon(id) || undefined, selected: s.bands.includes(id), onToggle: () => set({ bands: toggleIn(s.bands, id) }) }))}
        </div>
      </div>
            `
          : nothing
      }
      <div class="tb-field">
        <span class="tb-field__label">${host.t("minRarity", "Minimum rarity")}</span>
        ${segmented({
          label: host.t("minRarity", "Minimum rarity"),
          value: String(s.minRarity),
          options: [
            { value: "0", label: host.common("common.states.all", "All") },
            ...[2, 3, 4].map((rarity) => ({ value: String(rarity), label: `${cardRarityName(rarity)}+` })),
          ],
          onSelect: (value) => set({ minRarity: Number(value) }),
        })}
      </div>
      ${addRequired("members")}${s.noSnaps ? nothing : addRequired("snaps")}
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
                ${catalog.cardName("members", id)} / ${catalog.characterName(catalog.member(id)?.characterId ?? 0)}
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
              ${ptField(
                host,
                "minBonus",
                html`
                  <md-outlined-text-field
                    type="number"
                    min="0"
                    supporting-text=${host.t("constraintUpperBound", "Upper limit: {value}", { value: host.constraintLimits()?.eventBonus == null ? "—" : `${host.constraintLimits()!.eventBonus}%` })}
                    step="5"
                    .error=${ptFieldInvalid(host, "minBonus")}
                    label=${host.t("minBonus", "Minimum event bonus (%)")}
                    .value=${live(s.minBonus === null ? "" : String(s.minBonus))}
                    @change=${(e: Event) => {
                      const raw = (e.target as HTMLInputElement).value;
                      set({ minBonus: raw === "" ? null : Number(raw) });
                    }}
                  ></md-outlined-text-field>
                `,
              )}
            `
          : nothing
      }
      ${
        s.bindings.length
          ? html`
              <ul class="pt-bindings">
                ${s.bindings.map(
                  ([member, snap], index) => html`
                    <li>
                      <span>
                        ${catalog.cardName("members", member)} →
                        ${snap === null ? host.t("noSnap", "No snap") : catalog.cardName("snaps", snap)}
                      </span>
                      ${iconButton({ icon: "close", label: host.common("common.actions.remove", "Remove"), onClick: () => set({ bindings: s.bindings.filter((_, at) => at !== index) }) })}
                    </li>
                  `,
                )}
              </ul>
            `
          : nothing
      }
      ${
        activity && s.rewardMode !== "plan"
          ? nothing
          : html`
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
              </div>
            `
      }
    </div>
  `;
  return html`
    <section class="surface stack" id="tb-cards" data-tb-field tabindex="-1">
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
      ${
        activity && s.rewardMode !== "plan" && s.scope === "box"
          ? html`
              <span class="tb-results__meta">
                ${host.t("manualGrowth", "Recorded growth for owned cards; full growth for unowned cards")}
              </span>
            `
          : nothing
      }
      ${
        s.scope === "box" && (!activity || s.rewardMode === "plan")
          ? html`
              <div class="tb-field">
                <span class="tb-field__label">${host.t("unknownPolicy", "Growth not entered")}</span>
                ${segmented({
                  label: host.t("unknownPolicy", "Growth not entered"),
                  value: s.unknownPolicy,
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
      ${
        activity && s.rewardMode !== "plan" && s.scope === "box"
          ? html`
              <md-outlined-select
                label=${host.t("unknownPolicy", "Growth not entered")}
                .value=${farmingConditions(s.farming).requireGrowth ? "required" : s.unknownPolicy}
                ?disabled=${s.farming.play === "gekiso"}
                @change=${(e: Event) => {
                  const value = (e.target as HTMLInputElement).value;
                  host.updateFarming(
                    value === "required"
                      ? { requireGrowth: true }
                      : { requireGrowth: false, unknownPolicy: value as "min" | "max" },
                  );
                }}
              >
                <md-select-option value="required">
                  <div slot="headline">${host.t("farm.requireGrowth", "Complete before calculating")}</div>
                </md-select-option>
                <md-select-option value="min">
                  <div slot="headline">${host.t("unknownMin", "Count as minimum")}</div>
                </md-select-option>
                <md-select-option value="max">
                  <div slot="headline">${host.t("unknownMax", "Count as max")}</div>
                </md-select-option>
              </md-outlined-select>
            `
          : nothing
      }
      <div class="row row--between tb-input-summary">
        <span class="tb-results__meta">
          ${host.t("candidateSummary", "{members} member cards / {snaps} Snapshots", { members: cards.members.length, snaps: cards.snaps.length })}${required ? ` / ${host.t("requiredCount", "{count} fixed", { count: required })}` : ""}
        </span>
        ${
          !view.members.size
            ? html`
                <button class="button button--tonal" @click=${() => host.setTab("box")}>
                  ${host.t("enterCards", "Enter cards")}
                </button>
              `
            : nothing
        }
      </div>
      ${
        required
          ? html`
              <div class="cluster">
                ${fixedMembers.map((id) => fixedChip("members", id))}${fixedSnaps.map((id) => fixedChip("snaps", id))}
              </div>
            `
          : nothing
      }
      ${accordion({
        id: "tb-candidates",
        className: "tb-accordion",
        leading: icon("tune", 20),
        label: host.t("candidates", "Cards and limits"),
        content: activity ? ptField(host, "constraints", content) : content,
        expanded: host.expanded.has("candidates"),
        onExpandedChange: (expanded) => {
          if (expanded) host.expanded.add("candidates");
          else host.expanded.delete("candidates");
          host.requestUpdate();
        },
      })}
    </section>
    ${requiredPicker(host)}
  `;
}

/** Adds and removes this search's required cards; the pane stays open for several. */
function requiredPicker(host: TeamBuilder): TemplateResult | typeof nothing {
  const kind = host.requiredPicker;
  if (!kind) return nothing;
  const catalog = host.catalog!;
  const s = host.searchSettings;
  const close = () => {
    host.requiredPicker = null;
    host.slotFilters = { ...host.slotFilters, query: "", bands: [], characters: [], attributes: [], rarities: [], facets: {} };
    host.slotFiltersOpen = false;
    host.requestUpdate();
  };
  const filters = { ...host.slotFilters, kind };
  const setFilters = (patch: Partial<typeof filters>) => {
    host.slotFilters = { ...filters, ...patch };
    host.requestUpdate();
  };
  const owned = kind === "members" ? host.view!.members : host.view!.snaps;
  const ids = (s.scope === "theoretical" ? Object.keys(kind === "members" ? catalog.data.members : catalog.data.snapshots).map(Number) : [...owned.keys()])
    .filter((id) => matchesCardFilters(host, kind, id, filters))
    .sort((a, b) => b - a);
  return selectionPane({
    id: "tb-required-picker",
    title: host.t(kind === "members" ? "requiredMembers" : "requiredSnaps", kind === "members" ? "Required members" : "Required snaps"),
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
    search: (value) => setFilters({ query: value }),
    filterLayout: "facets",
    filters: renderCardFilters(host, filters, setFilters),
    kind: kind === "members" ? "member" : "support",
    items: ids.map((id) => ({ ...catalog.cardOptions(kind, id)!, value: String(id) })),
    selected: "",
    selectedValues: new Set(s.required[kind].map(String)),
    select: (value) => {
      const id = Number(value);
      const required = host.searchSettings.required;
      const list = required[kind].includes(id) ? required[kind].filter((item) => item !== id) : [...required[kind], id];
      host.updateSettings({ required: { ...required, [kind]: list } });
    },
    countLabel: host.t("cardCount", "{count} cards", { count: ids.length }),
    emptyLabel: host.t("noMatches", "No cards match"),
    preview: html``,
  });
}

export function renderBuildTab(host: TeamBuilder, leading?: TemplateResult): TemplateResult {
  const s = host.searchSettings;
  const challengeSongs =
    s.eventId === null ? [] : host.catalog!.challengeSongs(s.eventId).map((row) => row.liveMusicId);
  const challenge =
    s.goal === "event" ? s.route === "challenge" : (s.goal === "score" || s.goal === "power") && s.challengeRules;
  const allowedSongIds = challenge
    ? challengeSongs
    : s.goal === "event" || s.goal === "plan"
      ? host.catalog!.normalEventSongIds(s.manualEventEnabled ? null : s.eventId)
      : undefined;
  const set = (patch: Partial<BuildSettings>) => host.updateSettings(patch);
  const needsSongs =
    s.goal === "score" ||
    s.goal === "gekiso" ||
    s.goal === "plan" ||
    (s.goal === "event" && s.route !== "skip") ||
    (s.goal === "power" && s.powerSong);
  return toolLayout(
    host,
    () => html`
      ${leading ?? nothing}
      ${
        host.tab === "build"
          ? html`
              <section class="surface stack">
                ${sectionHeading({ icon: "flag", label: host.t("goal", "Goal") })}
                <div
                  class="cluster tb-goals"
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
                        class="chip"
                        type="button"
                        role="radio"
                        aria-checked=${String(s.goal === id)}
                        tabindex=${s.goal === id ? "0" : "-1"}
                        @click=${() => set({ goal: id })}
                      >
                        ${icon(s.goal === id ? "check" : name, 18)}<span class="chip__label">${goalText(host, id)}</span>
                      </button>
                    `,
                  )}
                </div>
                ${
                  s.goal === "score" || s.goal === "gekiso"
                    ? html`
                        ${renderScoreGoal(host, s, set)}
                        ${
                          scoreGoal(s) === "at-least" || scoreGoal(s) === "capped"
                            ? html`
                                <md-outlined-text-field
                                  type="number"
                                  min="1"
                                  step="1"
                                  inputmode="numeric"
                                  id="tb-target-score"
                                  data-tb-field
                                  label=${host.t("targetScore", "Target score")}
                                  .value=${live(s.targetScore ? String(s.targetScore) : "")}
                                  @change=${(e: Event) => {
                                    const value = Math.floor(Number((e.target as HTMLInputElement).value) || 0);
                                    set({ targetScore: value > 0 ? value : null });
                                  }}
                                ></md-outlined-text-field>
                              `
                            : nothing
                        }
                      `
                    : nothing
                }
                ${
                  s.goal === "gekiso"
                    ? html`
                        ${missionMembersControl(host)} ${comboBonusControl(host)} ${justWindowControl(host)} ${placementControl(host)}
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
                ${s.goal === "score" || s.goal === "gekiso" ? playConditions(host, s) : nothing}
                ${s.goal === "gekiso" ? gekisoSamplingAdvanced(host) : nothing}
              </section>
            `
          : nothing
      }
      ${
        s.goal === "plan"
          ? html`
              <section class="surface stack">
                ${sectionHeading({ icon: "cycle", label: host.t("planSetup", "Resource plan") })} ${eventSection(host)}
                ${playConditions(host, s)}
                <span class="tb-results__meta">
                  ${host.t("farm.memory", "Character / song memory bonuses")}: ${host.t("farm.included", "Included")}
                </span>
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
      ${renderCandidates(host)}
      ${
        needsSongs
          ? html`
              <section class="surface stack">
                ${sectionHeading({ icon: "library_music", label: challenge ? host.t("planChallengeSongs", "Challenge songs") : s.goal === "plan" ? host.t("planNormalSongs", "Normal-live songs") : host.t("songs", "Songs"), count: s.songs.length || undefined })}
                ${songList(host, s.goal === "power" ? s.songs : host.settings.songs, (songs) => set({ songs }), s.goal === "power", allowedSongIds)}
                ${multiSongControl(host)}
              ${songRulesControl(host)}
              </section>
            `
          : nothing
      }
    `,
    renderBuildRun(host),
    renderResults(host),
  );
}

export function renderBuildRun(host: TeamBuilder, showTimeLimit = true): TemplateResult {
  const s = host.searchSettings,
    progress = host.progress;
  const resumable = !host.stale && !!host.results && host.results.results.some((result) => !result.proven);
  return html`
    <div class="tb-run">
      ${
        showTimeLimit
          ? html`
              <md-outlined-select
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
                      <div slot="headline">
                        ${limit ? host.t("secondsShort", "{count} s", { count: limit }) : host.t("noLimit", "Until proven")}
                      </div>
                    </md-select-option>
                  `,
                )}
              </md-outlined-select>
            `
          : nothing
      }
      ${
        host.hasTaskResults
          ? html`
              <button
                class="button button--text tb-run__results"
                @click=${() => host.querySelector(".tb-results-column")?.scrollIntoView({ block: "start" })}
              >
                ${host.t("viewResults", "View results")}
              </button>
            `
          : nothing
      }
      ${
        host.taskKind === "build"
          ? html`
              <button
                class="button button--tonal button--full tb-run__button"
                type="button"
                @click=${() => host.cancel()}
              >
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
                @click=${() => void host.run(resumable)}
              >
                ${
                  host.running
                    ? host.t("sc.busy", "Another calculation is running")
                    : host.submitted && host.inputIssues().length
                      ? host.t("fixConditions", "Adjust {count} conditions", { count: host.inputIssues().length })
                    : resumable
                      ? host.t("continueOptimal", "Continue verifying optimality")
                      : host.stale
                        ? host.t("rerun", "Search again")
                        : html`
                            ${icon("search", 20)}${host.tab === "pt" ? (s.goal === "plan" ? host.t("farm.planRun", "Calculate resource plan") : s.route === "skip" ? host.t("farm.skipRun", "Recommend skip team") : host.t("farm.run", "Recommend songs and teams")) : host.t("findTeams", "Find teams")}
                          `
                }
              </button>
            `
      }
    </div>
  `;
}
