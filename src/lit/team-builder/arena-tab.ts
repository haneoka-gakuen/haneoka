// L3 — GEB
// Input: Current Box, release-pinned Arena schedules and user overrides.
// Output: Independent Arena draft and the second team-builder task panel.
// Pos: [Map](../L2-2.md); Arena rules, schedule lifecycle and shared tool presentation.
// Effects/Dependencies: Persists Box preferences, schedules rule transitions and cancels obsolete calculations.
import { html, nothing } from "lit";
import type { TeamBuilder } from "../team-builder";
import { arenaPeriod, arenaReleaseAt, arenaReleased, type ArenaRule } from "../../lib/team-builder/arena";
import { objectRow } from "../../lib/team-builder/data";
import { availableOnServer } from "../../lib/team-builder/song-comparison";
import type { ArenaGoal } from "../../lib/team-builder/engine/api";
import type { BoxValue } from "../../lib/team-builder/sync/box-doc";
import type { BuildSettings } from "./types";
import { DEFAULT_SETTINGS } from "./types";
import { restoreBuildSettings } from "./workspace-state";
import { songRuleFields } from "./song-rules";
import { toolLayout } from "./tool-layout";
import { sectionHeading } from "./catalog";
import {
  comboBonusControl,
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
  leagueId: number;
  automatic: boolean;
  customized: boolean;
  mode: "shared" | "individual";
  rule: ArenaRule;
  build: BuildSettings;
}
const defaults = (): ArenaDraft => ({
  leagueId: 1,
  automatic: true,
  customized: false,
  mode: "shared",
  rule: { musicType: 99, missions: [1, 1, 1] },
  build: { ...structuredClone(DEFAULT_SETTINGS), goal: "gekiso" },
});

export class ArenaController {
  draft = defaults();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private scheduleKey = "";
  private physicsKey = "";
  constructor(private readonly host: TeamBuilder) {}
  restore() {
    const saved = objectRow(this.host.view?.prefs.arena);
    const initial = defaults();
    this.draft = {
      ...initial,
      ...saved,
      customized: saved.customized === true || saved.automatic === false,
      build: restoreBuildSettings({ ...initial.build, ...objectRow(saved.build) }),
      rule: { ...initial.rule, ...objectRow(saved.rule) },
    } as ArenaDraft;
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
      criterion: this.draft.mode === "shared" ? "mean" : this.draft.build.criterion,
      gekisoPlacementMode: this.draft.mode === "shared" ? "rank" : this.draft.build.gekisoPlacementMode,
      arena: this.goal,
      songs: this.draft.build.songs.filter((song) => allowed.has(`${song.songId}:${song.difficulty}`)),
    };
  }
  update(patch: Partial<ArenaDraft>) {
    if (this.host.running && this.host.tab === "arena") this.host.cancel();
    if (patch.automatic === false && this.draft.automatic && !this.draft.customized && !patch.rule)
      patch.rule = structuredClone(this.rule);
    this.draft = { ...this.draft, ...patch };
    this.host.write([{ key: "pref.arena", value: this.draft as unknown as BoxValue }]);
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
    this.update({ leagueId, build: { ...this.draft.build, songs: [], leader: null, bindings: [] } });
  }
  selectPool() {
    this.updateBuild({
      songs: this.allowedSongIds.flatMap((id) => {
        const rows = this.host.catalog!.difficultyRows(id).filter((row) => arenaReleased(row));
        const difficulty = rows.find((r) => Number(r.difficulty) === 3) ?? rows.at(-1);
        return difficulty ? [{ songId: id, difficulty: Number(difficulty.difficulty) }] : [];
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
    clearTimeout(this.timer);
    this.scheduleKey = "";
    this.physicsKey = "";
  }
  issues() {
    return this.draft.automatic && !this.period.regulation
      ? [
          {
            field: "tb-arena-rules",
            message: this.host.t("arena.needRules", "Choose custom rules or an active league"),
          },
        ]
      : [];
  }
}

export function renderArenaTab(host: TeamBuilder) {
  const arena = host.arena,
    draft = arena.draft,
    settings = host.searchSettings,
    catalog = host.catalog!;
  const rule = arena.rule,
    period = arena.period;
  const option = (value: string | number, label: string, image?: string) => html`
    <md-select-option value=${String(value)}>
      ${
        image
          ? html`
              <img slot="start" src=${image} alt="" width="20" height="20" />
            `
          : nothing
      }
      <div slot="headline">${label}</div>
    </md-select-option>
  `;
  return toolLayout(
    host,
    html`
      <section class="surface stack" id="tb-arena-rules" data-tb-field tabindex="-1">
        ${sectionHeading({ icon: "swords", label: host.t("arena.tab", "Gekiso Arena") })}
        <div class="stack">
          <md-outlined-select
            label=${host.t("arena.server", "Server")}
            .value=${host.server}
            @change=${(e: Event) => host.switchServer((e.target as HTMLInputElement).value)}
          >
            ${["jp", "intl"].map((server) => option(server, host.t(`arena.${server}`, server.toUpperCase())))}
          </md-outlined-select>
          <md-outlined-select
            label=${host.t("arena.league", "League")}
            .value=${String(draft.leagueId)}
            @change=${(e: Event) => arena.league(Number((e.target as HTMLInputElement).value))}
          >
            ${[1, 2, 3, 4, 5].map((id) => option(id, catalog.bandName(id), catalog.bandIcon(id)))}
          </md-outlined-select>
        </div>
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
        ${songRuleFields(host, rule, patch => arena.updateRule(patch))}
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
        ${
          draft.mode === "individual"
            ? html`
                <md-outlined-select
                  label=${host.t("criterion", "Score goal")}
                  .value=${settings.criterion}
                  @change=${(e: Event) => arena.updateBuild({ criterion: (e.target as HTMLInputElement).value as BuildSettings["criterion"] })}
                >
                  ${(["mean", "max", "min"] as const).map((value) => option(value, scoreText(host, SCORE_GOALS[value].label)))}
                </md-outlined-select>
              `
            : nothing
        }
        ${playConditions(host)}
        ${
          draft.mode === "individual"
            ? placementControl(host)
            : html`
                <md-outlined-select
                  id="tb-placement"
                  label=${host.t("gekisoRank", "Placement in each range")}
                  .value=${String(settings.gekisoRank)}
                  @change=${(e: Event) => arena.updateBuild({ gekisoRank: Number((e.target as HTMLInputElement).value) })}
                >
                  ${[1, 2, 3, 4, 5].map((value) => option(value, String(value)))}
                </md-outlined-select>
              `
        }
        ${comboBonusControl(host)}${justWindowControl(host)}${gekisoSamplingAdvanced(host)}
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
