// L3 — GEB
// Input: Current Box, release-pinned Arena schedules and user overrides.
// Output: Independent Arena draft, score / section objectives and frozen reference-opponent choices.
// Pos: [Map](../L2-2.md); Arena rules, schedule lifecycle and shared tool presentation.
// Effects/Dependencies: Persists Box preferences; opponent formations stay local to the workspace. Schedules rule transitions and cancels obsolete calculations.
import { skillRoleControls } from "./skill-role-controls";
import { rangeRankControl } from "./gekiso-rank";
import { html, nothing } from "lit";
import type { TeamBuilder } from "../team-builder";
import { arenaPeriod, arenaReleaseAt, arenaReleased, type ArenaRule } from "../../lib/team-builder/arena";
import { objectRow } from "../../lib/team-builder/data";
import { availableOnServer } from "../../lib/team-builder/song-comparison";
import type { ArenaGoal, ArenaOpponent } from "../../lib/team-builder/engine/api";
import { inputChip } from "../ui/controls";
import { live } from "lit/directives/live.js";
import { accordion } from "../ui/accordion";
import { gekisoHelpButton } from "./gekiso-help";
import type { BoxValue } from "../../lib/team-builder/sync/box-doc";
import type { BuildSettings } from "./types";
import { DEFAULT_SETTINGS } from "./types";
import { restoreBuildSettings } from "./workspace-state";
import { songRuleFields, songRuleSummary } from "./song-rules";
import { toolLayout } from "./tool-layout";
import { choiceField, sectionHeading } from "./catalog";
import {
  comboBonusControl,
  missionMembersControl,
  justWindowControl,
  gekisoSamplingAdvanced,
  playConditions,
  placementControl,
  renderBuildRun,
  renderCandidates,
  songList,
} from "./build-tab";
import { renderResults } from "./results";
import { segmented } from "../ui/controls";
import { SCORE_GOALS, scoreText } from "./score-goal";
import { formatDate } from "../../lib/date-format";

interface ArenaDraft {
  objective: "score" | "sections";
  maxBaseLossPercent: number;
  leagueId: number;
  automatic: boolean;
  customized: boolean;
  mode: "shared" | "individual";
  rule: ArenaRule;
  build: BuildSettings;
}
const defaults = (): ArenaDraft => ({
  objective: "score",
  maxBaseLossPercent: 3,
  leagueId: 1,
  automatic: true,
  customized: false,
  mode: "shared",
  rule: { musicType: 99, missions: [1, 1, 1] },
  build: { ...structuredClone(DEFAULT_SETTINGS), goal: "gekiso" },
});

export class ArenaController {
  draft = defaults();
  opponents: { id: string; name: string; input: ArenaOpponent }[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private scheduleKey = "";
  private scheduleData: TeamBuilder["data"] = null;
  private scheduleInput = "";
  private physicsKey = "";
  constructor(private readonly host: TeamBuilder) {}
  restore(required: BuildSettings["required"] = { members: [], snaps: [] }) {
    const saved = objectRow(this.host.view?.prefs.arena);
    const initial = defaults();
    this.draft = {
      ...initial,
      ...saved,
      customized: saved.customized === true || saved.automatic === false,
      build: { ...restoreBuildSettings({ ...objectRow(saved.build), goal: "gekiso" }), required },
      rule: { ...initial.rule, ...objectRow(saved.rule) },
    } as ArenaDraft;
    this.draft.objective = saved.objective === "sections" ? "sections" : "score";
    this.draft.maxBaseLossPercent = typeof saved.maxBaseLossPercent === "number" ? saved.maxBaseLossPercent : 3;
    const requested = this.host.requestedArenaLeague;
    if (requested && requested !== this.draft.leagueId)
      this.draft = { ...this.draft, leagueId: requested, build: { ...this.draft.build, songs: [], leader: null, bindings: [] } };
    this.sync();
  }
  get catalog() {
    return this.host.data?.arena?.[this.host.server];
  }
  get period() {
    return arenaPeriod(this.catalog, this.draft.leagueId, Date.now());
  }
  get bandId() {
    return this.catalog?.leagues.find((row) => row.id === this.draft.leagueId)?.bandId ?? this.draft.leagueId;
  }
  get rule(): ArenaRule {
    const current = this.draft.automatic ? this.period.regulation : null;
    return current ? { musicType: current.musicType, missions: [...current.missions] } : this.draft.rule;
  }
  get goal(): ArenaGoal {
    return {
      ...this.rule,
      bandId: this.bandId,
      mode: this.draft.mode,
      server: this.host.server,
      regulationId: this.draft.automatic ? (this.period.regulation?.id ?? null) : null,
      ...(this.draft.objective === "sections" ? { objective: "sections" as const, maxBaseLoss: this.draft.maxBaseLossPercent / 100,
        opponents: this.opponents.map(opponent => opponent.input) } : {}),
    };
  }
  get allowedSongIds() {
    if (!this.host.data) return [];
    return Object.entries(this.host.data.songs)
      .filter(([id, song]) => {
        const bands = song.bandIds ?? song.bandIDs ?? [song.bandId];
        return (
          Array.isArray(bands) &&
          bands.map(Number).includes(this.bandId) &&
          arenaReleased(song) &&
          availableOnServer(this.host.data!, "songs", Number(id))
        );
      })
      .map(([id]) => Number(id));
  }
  get allowedCharts() {
    return this.allowedSongIds.flatMap((songId) =>
      this.host
        .catalog!.difficultyRows(songId)
        .filter((row) => arenaReleased(row))
        .map((row) => ({ songId, difficulty: Number(row.difficulty) })),
    );
  }
  get settings(): BuildSettings {
    const allowed = new Set(this.allowedCharts.map((song) => `${song.songId}:${song.difficulty}`));
    return {
      ...this.draft.build,
      goal: "gekiso",
      bands: [this.bandId],
      criterion: this.draft.mode === "shared" || this.draft.objective === "sections" ? "mean" : this.draft.build.criterion,
      gekisoPlacementMode: this.draft.mode === "shared" || this.draft.objective === "sections" ? "rank" : this.draft.build.gekisoPlacementMode,
      arena: this.goal,
      songs: this.draft.build.songs.filter((song) => allowed.has(`${song.songId}:${song.difficulty}`)),
    };
  }
  update(patch: Partial<ArenaDraft>) {
    if (this.host.running && this.host.tab === "arena") this.host.cancel();
    if (patch.automatic === false && this.draft.automatic && !this.draft.customized && !patch.rule)
      patch.rule = structuredClone(this.rule);
    this.draft = { ...this.draft, ...patch };
    const { required: _required, ...build } = this.draft.build;
    this.host.write([{ key: "pref.arena", value: { ...this.draft, build } as unknown as BoxValue }]);
    this.sync();
    this.host.requestUpdate();
  }
  updateBuild(patch: Partial<BuildSettings>) {
    this.update({ build: { ...this.draft.build, ...patch } });
  }
  updateRule(patch: Partial<ArenaRule>) {
    this.update({ automatic: false, customized: true, rule: { ...this.rule, ...patch } });
  }
  league(leagueId: number) {
    this.host.requestedArenaLeague = 0;
    this.opponents = [];
    this.update({ leagueId, build: { ...this.draft.build, songs: [], leader: null, bindings: [] } });
  }
  selectPool() {
    const difficulties = this.host.songDifficulties;
    this.updateBuild({
      songs: this.allowedSongIds.flatMap((id) => {
        const rows = this.host.catalog!.difficultyRows(id).filter((row) => arenaReleased(row));
        return rows.filter(row => difficulties.includes(Number(row.difficulty)))
          .map(row => ({ songId: id, difficulty: Number(row.difficulty) }));
      }),
    });
  }
  sync() {
    if (!this.host.isConnected) return;
    const physics = this.host.tab === "arena" && this.host.view ? this.host.calculationContext() : "";
    if (physics) {
      if (this.physicsKey && physics !== this.physicsKey && this.host.running) this.host.cancel();
      this.physicsKey = physics;
    }
    const period = this.period;
    const data = this.host.data;
    const input = JSON.stringify([this.host.server, this.catalog?.identity, this.draft.leagueId, period.regulation?.id, period.nextAt]);
    if (this.scheduleKey && this.scheduleData === data && this.scheduleInput === input) return;
    this.scheduleData = data;
    this.scheduleInput = input;
    const publications = data
      ? [
          ...Object.values(data.members)
            .filter((row) => row.bandId === this.bandId)
            .map((row) => row.catalogMetadata ?? {}),
          ...Object.values(data.snapshots).map((row) => row.catalogMetadata ?? {}),
          ...Object.values(data.songs),
        ]
          .flatMap((row) => [
            arenaReleaseAt(row),
            ...(Array.isArray(row.difficulty) ? row.difficulty.map((entry) => arenaReleaseAt(objectRow(entry))) : []),
          ])
          .filter((value): value is number => value !== null && value > Date.now())
      : [];
    const transitions = [...publications, ...(period.nextAt === null ? [] : [period.nextAt])];
    const nextAt = transitions.length ? Math.min(...transitions) : null;
    const key = JSON.stringify([
      this.host.server,
      this.catalog?.identity,
      this.draft.leagueId,
      period.regulation?.id,
      nextAt,
    ]);
    if (key === this.scheduleKey) return;
    this.scheduleKey = key;
    clearTimeout(this.timer);
    if (nextAt !== null)
      this.timer = setTimeout(
        () => {
          this.scheduleKey = "";
          this.sync();
          this.host.requestUpdate();
        },
        Math.min(2_147_483_647, Math.max(1, nextAt - Date.now() + 50)),
      );
  }
  dispose() {
    this.opponents = [];
    clearTimeout(this.timer);
    this.scheduleKey = "";
    this.physicsKey = "";
  }
  issues() {
    const issues = this.draft.automatic && !this.period.regulation
      ? [
          {
            field: "tb-arena-rules",
            message: this.host.t("arena.needRules", "Choose custom rules or an active league"),
          },
        ]
      : [];
    if (this.draft.objective === "sections" && (!Number.isFinite(this.draft.maxBaseLossPercent) || this.draft.maxBaseLossPercent < 0 || this.draft.maxBaseLossPercent > 100))
      issues.push({ field: "tb-section-loss", message: this.host.t("arena.sections.lossInvalid", "Enter a base score loss from 0% to 100%") });
    return issues;
  }
}

function sectionControls(host: TeamBuilder) {
  const arena = host.arena, draft = arena.draft;
  const candidates: { id: string; name: string; input: ArenaOpponent }[] = [];
  const sameBand = (ids: number[]) => ids.length === 5 && ids.every(id => host.master!.members.get(id)?.bandId === arena.bandId);
  for (const team of host.view!.teams) {
    if (!sameBand(team.members)) continue;
    const growth = host.manualInputs({ members: team.members, snaps: team.snaps, leader: Math.max(0, team.members.indexOf(team.leader ?? team.members[0]!)) }, arena.settings.scope);
    if (growth.members.length !== 5 || growth.snaps.length !== team.snaps.filter(id => id !== null).length) continue;
    candidates.push({ id: `saved:${team.id}`, name: team.name, input: { members: growth.members, snaps: growth.snaps,
      player: host.view!.player, unknownPolicy: arena.settings.scope === "theoretical" ? "max" : arena.settings.unknownPolicy,
      team: { members: team.members.map(id => `m${id}`), snaps: team.snaps.map(id => id === null ? null : `s${id}`), leader: `m${team.leader ?? team.members[0]}` },
      ranks: [...arena.settings.gekisoRanks] as [number, number, number] } });
  }
  for (const entry of host.comparison.items) {
    const { hit, input } = entry;
    if (!sameBand(hit.members.map(key => input.members.find(row => row.key === key)!.cardId))) continue;
    candidates.push({ id: `comparison:${entry.id}`, name: `${host.t("comparison", "Comparison")} ${host.comparison.items.indexOf(entry) + 1}`,
      input: { members: input.members.filter(row => hit.members.includes(row.key)), snaps: input.snaps.filter(row => hit.snaps.includes(row.key)),
        player: input.player, unknownPolicy: input.unknownPolicy, team: { members: hit.members, snaps: hit.snaps, leader: hit.members[0]! },
        ...(input.goal.kind === "gekiso" ? { accuracy: input.goal.accuracy, ranks: input.goal.ranks ?? [input.goal.rank, input.goal.rank, input.goal.rank] as [number, number, number] } : {}) } });
  }
  return html`<div class="stack" id="tb-arena-objective" data-tb-field tabindex="-1">
    <div class="row row--between"><span class="tb-field__label">${host.t("arena.sections.target", "Optimization target")}</span>${gekisoHelpButton(host, "sections")}</div>
    ${segmented({ label: host.t("arena.sections.target", "Optimization target"), value: draft.objective,
      options: [{ value: "score", label: host.t("arena.sections.score", "Total score") }, { value: "sections", label: host.t("arena.sections.priority", "GEKISO sections") }],
      onSelect: objective => arena.update({ objective }) })}
    ${draft.objective === "sections" ? html`<md-outlined-text-field id="tb-section-loss" data-tb-field type="number" min="0" max="100" step="0.5" suffix-text="%"
      ?error=${host.submitted && (!Number.isFinite(draft.maxBaseLossPercent) || draft.maxBaseLossPercent < 0 || draft.maxBaseLossPercent > 100)}
      label=${host.t("arena.sections.maxLoss", "Maximum base score loss")} .value=${live(String(draft.maxBaseLossPercent))}
      @change=${(event: Event) => arena.update({ maxBaseLossPercent: Number((event.target as HTMLInputElement).value) })}></md-outlined-text-field>
      ${accordion({id: "tb-section-opponents", expanded: host.expanded.has("section-opponents"),
        onExpandedChange: expanded => { if (expanded) host.expanded.add("section-opponents"); else host.expanded.delete("section-opponents"); host.requestUpdate(); },
        label: host.t("arena.sections.opponents", "Opponent scenarios"), metadata: String(arena.opponents.length), content: html`
        ${choiceField({ type: "select", label: host.t("arena.sections.addOpponent", "Add a reference opponent"), value: "",
          options: [{value:"",label:host.t("arena.sections.chooseOpponent", "Choose a saved or comparison team")}, ...candidates.filter(row => !arena.opponents.some(selected => selected.id === row.id)).map(row=>({value:row.id,label:row.name,disabled:arena.opponents.length>=4}))],
          onSelect: value => { const selected = candidates.find(row => row.id === value); if (selected && arena.opponents.length < 4) { host.cancel(); arena.opponents = [...arena.opponents, structuredClone(selected)]; host.requestUpdate(); } } })}
        <div class="cluster">${arena.opponents.map(row => inputChip(row.name, host.common("common.actions.remove", "Remove"), () => {
          host.cancel(); arena.opponents = arena.opponents.filter(selected => selected.id !== row.id); host.requestUpdate();
        }))}</div>` })}` : nothing}
  </div>`;
}

export function renderArenaTab(host: TeamBuilder) {
  const arena = host.arena,
    draft = arena.draft,
    settings = host.searchSettings,
    catalog = host.catalog!;
  const rule = arena.rule,
    period = arena.period;
  return toolLayout(
    host,
    html`
      <section class="surface stack" id="tb-arena-rules" data-tb-field tabindex="-1">
        ${sectionHeading({ icon: "swords", label: host.t("arena.tab", "GEKISO Arena") })}
        ${choiceField({
          type: "buttons",
          label: host.t("arena.server", "Server"), value: host.server,
          options: ["jp", "intl"].map(server => ({value: server, label: host.t(`arena.${server}`, server.toUpperCase())})),
          onSelect: server => void host.switchServer(server),
        })}
        ${choiceField({
          type: "select",
          label: host.t("arena.league", "League"), value: String(draft.leagueId),
          options: [1,2,3,4,5].map(id => ({value: String(id), label: catalog.bandName(id),
            leading: html`<img src=${catalog.bandIcon(id)} width="24" height="24" alt="" loading="lazy" />`})),
          onSelect: value => arena.league(Number(value)),
        })}
        <div class="cluster">
          <span class="chip">
            ${period.season ? host.t("arena.season", "Season {count}", { count: period.season.id }) : host.t("arena.noSeason", "No active season")}
          </span>
          ${
            period.regulation
              ? html`
                  <time datetime=${new Date(period.regulation.endAt).toISOString()}>
                    ${host.t("arena.until", "Until {time}", { time: formatDate(host.locale, period.regulation.endAt, { time: true }) })}
                  </time>
                `
              : nothing
          }
        </div>
        ${segmented({
          label: host.t("arena.rules", "Rules"),
          value: draft.automatic ? "auto" : "manual",
          options: [
            { value: "auto", label: host.t("arena.current", "Current rules") },
            { value: "manual", label: host.t("arena.custom", "Custom") },
          ],
          onSelect: (value) => arena.update({ automatic: value === "auto" }),
        })}
        ${draft.automatic ? period.regulation ? songRuleSummary(host, rule) : html`<span class="tabular">—</span>` : songRuleFields(host, rule, patch => arena.updateRule(patch))}
      </section>
      <section class="surface stack">
        ${sectionHeading({ icon: "groups", label: host.t("arena.objective", "Team objective") })}
        ${segmented({
          label: host.t("arena.objective", "Team objective"),
          value: draft.mode,
          options: [
            { value: "shared", label: host.t("arena.shared", "One team for all songs") },
            { value: "individual", label: host.t("arena.individual", "A team for each song") },
          ],
          onSelect: (mode) => arena.update({ mode }),
        })}
        ${sectionControls(host)}
        ${
          draft.mode === "individual" && draft.objective === "score"
            ? html`
                ${choiceField({
                  type: "select",
                  label: host.t("criterion", "Score goal"), value: settings.criterion,
                  options: (["mean", "max", "min"] as const).map(value => ({value, label: scoreText(host, SCORE_GOALS[value].label)})),
                  onSelect: criterion => arena.updateBuild({criterion}),
                })}
              `
            : nothing
        }
        ${playConditions(host)}
        ${
          draft.objective === "sections" ? nothing : draft.mode === "individual"
            ? placementControl(host)
            : html`
                <div id="tb-placement">
                  ${rangeRankControl(host, settings.gekisoRanks, (range, rank) => {
                    const gekisoRanks = [...settings.gekisoRanks] as BuildSettings["gekisoRanks"];
                    gekisoRanks[range] = rank;
                    arena.updateBuild({ gekisoRanks });
                  })}
                </div>
              `
        }
        ${missionMembersControl(host)}${skillRoleControls(host)}${comboBonusControl(host)}${justWindowControl(host)}${gekisoSamplingAdvanced(host)}
      </section>
      ${renderCandidates(host)}
      <section class="surface stack">
        ${sectionHeading({ icon: "library_music", label: host.t("songs", "Songs"), count: settings.songs.length || undefined })}
        <div class="cluster">
          <button class="button button--text" @click=${() => arena.selectPool()}>
            ${host.t("arena.usePool", "Select league song pool")}
          </button>
        </div>
        ${songList(host, draft.build.songs, (songs) => arena.updateBuild({ songs }), false, arena.allowedSongIds, "tb-songs", arena.allowedCharts)}
      </section>
    `,
    renderBuildRun(host),
    renderResults(host),
  );
}
