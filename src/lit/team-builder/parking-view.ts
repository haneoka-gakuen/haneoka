// L3 — GEB
// Input: Current/saved formations, recorded growth, account bonuses and a target PT total.
// Output: Native normal-play team evaluations and exact/nearest parking plans using stable PT payouts.
// Pos: [Map](../L2-2.md); parking workspace reuses manual-team validation, formation rendering and the existing engine.
// Effects/Dependencies: Evaluates selected fixed teams on demand; local drafts and frozen plans never modify the Box.
import { html, nothing, type TemplateResult } from "lit";
import type { ManualTeam, TeamBuilder } from "../team-builder";
import { filterChip, numberField, segmented } from "../ui/controls";
import { sectionHeading } from "./catalog";
import { eventSection, songList } from "./build-tab";
import { boostControl, challengeCostControl } from "./boost-control";
import { cardScopeControl, unknownGrowthControl } from "./card-input-controls";
import { LIVE_BOOST_COSTS, liveBoostRow } from "../../lib/team-builder/engine/boosts";
import { specList } from "../ui/spec";
import { emptyState } from "../ui/state";
import { manualReady, savedFormation } from "./teams-tab";
import { teamFormation } from "./results";
import { toolLayout } from "./tool-layout";
import { parkingPlays, parkingPlan, type ParkingPlan, type ParkingPlay, type ParkingResult } from "../../lib/team-builder/parking";
import { plannerMaster } from "../../lib/team-builder/planner-data";
import type { SongRef, TeamEvaluation } from "../../lib/team-builder/engine/api";

interface Candidate {
  key: string;
  name: string;
  team: ManualTeam;
  inputs: ReturnType<TeamBuilder["manualInputs"]>;
}
interface TeamRow extends Candidate {
  evaluation: TeamEvaluation;
  bonus: number;
  lowPoints: number;
  highPoints: number;
  rankLabel: string;
  option: ParkingPlay | null;
}
class ParkingDraft {
  owner = "";
  current: number | null = null;
  target: number | null = null;
  challenge = false;
  consumption = 0;
  songId = 0;
  difficulty = 3;
  includeManual = false;
  teamIds = new Set<string>();
  submitted = false;
  running = false;
  error = "";
  revision = 0;
  prefetched = "";
  evaluations = new Map<string, TeamRow>();
  result: ParkingResult | null = null;
  rows: TeamRow[] = [];
  rowsSignature = "";
  resultInput: { current: number; target: number; songId: number; difficulty: number; challenge: boolean } | null = null;
  resultSignature = "";
}
const drafts = new WeakMap<TeamBuilder, ParkingDraft>();
const ranks = ["", "E", "D", "C", "B", "A", "S", "SS"];
function draftFor(host: TeamBuilder) {
  const owner = JSON.stringify([host.snapshot?.owner ?? "local", host.data!.identity]);
  let d = drafts.get(host);
  if (!d || owner !== d.owner) {
    d = new ParkingDraft(); d.owner = owner; d.includeManual = manualReady(host);
    const song = host.settings.songs[0] ?? (!d.includeManual ? host.view!.teams[0]?.song : null);
    d.songId = song?.songId ?? 0;
    d.difficulty = host.songDifficulties[0] ?? song?.difficulty ?? 3;
    if (!d.includeManual && host.view!.teams[0]) d.teamIds.add(host.view!.teams[0].id);
    drafts.set(host, d);
  }
  return d;
}
function selectedTeams(host: TeamBuilder, d: ParkingDraft): Candidate[] {
  const selected = [
    ...(d.includeManual ? [{ key: "manual", name: host.t("parking.currentTeam", "Current manual team"), team: host.manual }] : []),
    ...host.view!.teams.filter(team => d.teamIds.has(team.id)).map(team => ({ key: team.id, name: team.name, team: savedFormation(team) })),
  ];
  return selected.map(row => ({ ...row, inputs: host.manualInputs(row.team) }));
}
function inputKey(host: TeamBuilder, d: ParkingDraft, withTarget = true) {
  return JSON.stringify([host.snapshot?.owner, host.data!.identity, host.settings.eventId, host.settings.scope,
    host.settings.frameRate, withTarget ? d.current : null, withTarget ? d.target : null, d.challenge, d.consumption, d.songId, d.difficulty,
    host.view!.player, selectedTeams(host, d)]);
}
export function openParking(host: TeamBuilder, input: { team?: ManualTeam; eventId?: number; song?: SongRef; challenge?: boolean; consumption?: number } = {}) {
  host.cancel();
  const d = draftFor(host);
  d.includeManual = true; d.teamIds.clear(); d.result = null; d.rows = []; d.submitted = false;
  if (input.song) { d.songId = input.song.songId; d.difficulty = input.song.difficulty; }
  if (input.challenge !== undefined) d.challenge = input.challenge;
  if (input.consumption !== undefined) d.consumption = input.consumption;
  host.setTab("pt"); host.pt.parking = true;
  if (input.team) host.manual = structuredClone(input.team);
  if (input.eventId !== undefined) host.updateSettings({ eventId: input.eventId });
  host.openConditions(); host.requestUpdate();
}

export function renderParking(host: TeamBuilder, modes: TemplateResult) {
  const d = draftFor(host), t = (key: string, fallback: string) => host.t(`parking.${key}`, fallback);
  const format = (value: number) => new Intl.NumberFormat(host.locale).format(value);
  const eventId = host.settings.eventId;
  const baseEvent = eventId === null ? undefined : host.master!.events.get(eventId);
  const challengeAvailable = !!baseEvent?.challengePoints.size && host.master!.challengeMusics.some(row => row.eventId === eventId);
  if (!challengeAvailable) d.challenge = false;
  const master = plannerMaster(host.master!, eventId, d.challenge), event = eventId === null ? undefined : master.events.get(eventId);
  const songs = [...master.songs.values()].filter(song => d.challenge
    ? master.challengeMusics.some(row => row.eventId === eventId && row.liveMusicId === song.id)
    : !event?.plannerRules?.normalSongs.length || event.plannerRules.normalSongs.includes(song.id));
  if (d.songId && !songs.some(song => song.id === d.songId)) d.songId = 0;
  const difficulties = d.songId ? host.catalog!.difficultyRows(d.songId).filter(row => row.file) : [];
  if (!difficulties.some(row => Number(row.difficulty) === d.difficulty)) d.difficulty = Number(difficulties[0]?.difficulty ?? 3);
  const boosts = d.challenge ? master.challengeBoosts : LIVE_BOOST_COSTS.flatMap(cost => { const row = liveBoostRow(master.boosts, cost); return row ? [row] : []; });
  if (!boosts.some(row => row.consumed === d.consumption)) d.consumption = boosts[0]?.consumed ?? 0;
  const candidates = selectedTeams(host, d), signature = inputKey(host, d);
  const already = d.current !== null && Number.isInteger(d.current) && d.target === d.current;
  const chartKey = `${d.songId}:${d.difficulty}`;
  if (host.engine && difficulties.length && candidates.some(row => manualReady(host, row.team)) && d.prefetched !== chartKey) {
    d.prefetched = chartKey;
    host.engine.prefetchCharts([{ songId: d.songId, difficulty: d.difficulty }]);
  }
  const errors = [
    ...(d.current === null || !Number.isInteger(d.current) ? [{ field: "current", message: t("currentRequired", "Enter current PT") }] : []),
    ...(d.target === null || !Number.isInteger(d.target) ? [{ field: "target", message: t("targetMissing", "Enter target PT") }]
      : d.target < (d.current ?? 0) ? [{ field: "target", message: t("targetRequired", "Enter target PT at or above current PT") }] : []),
    ...(!already && !event ? [{ field: "event", message: t("eventRequired", "Choose an event") }] : []),
    ...(!already && (!candidates.length || candidates.some(row => !manualReady(host, row.team))) ? [{ field: "teams", message: t("needTeams", "Choose complete teams") }] : []),
    ...(!already && !difficulties.length ? [{ field: "song", message: host.t("chooseSongs", "Choose songs") }] : []),
  ];
  const teamInvalid = d.submitted && (errors.some(error => error.field === "teams") || d.resultSignature === signature && d.rows.length > 0 && !d.rows.some(row => row.option));
  const set = (update: () => void) => {
    if (d.running) host.cancel();
    d.revision++; update(); d.error = ""; host.requestUpdate();
  };
  const edit = () => {
    if (d.running) host.cancel();
    if (!d.includeManual && candidates[0]) host.manual = structuredClone(candidates[0].team);
    d.includeManual = true;
    host.buildMode = "manual"; host.setTab("build");
  };
  const field = (key: "current" | "target", label: string) => html`<div id=${`parking-${key}`} class="stack">
    ${numberField({ label, value: d[key], nullable: true, min: 0, max: 2147483647,
      invalid: d.submitted && errors.some(error => error.field === key), onInput: value => set(() => { d[key] = value; }) })}</div>`;
  const formation = (row: Candidate) => teamFormation(host, row.team.members.flatMap((member, i) => {
    if (member === null) return [];
    const m = row.inputs.members.find(input => input.cardId === member), snap = row.team.snaps[i] ?? null;
    const s = row.inputs.snaps.find(input => input.cardId === snap);
    return [{ member, snap, memberGrowth: m ? host.catalog!.resolvedGrowth("members", m, row.inputs.unknownPolicy) : null,
      snapGrowth: s ? host.catalog!.resolvedGrowth("snaps", s, row.inputs.unknownPolicy) : null }];
  }), row.team.leader, false);

  const body = html`${modes}
    <section class="surface stack">${sectionHeading({ icon: "emoji_events", label: host.t("event", "Event") })}
      <div class=${`stack${d.submitted && errors.some(error => error.field === "event") ? " pt-field--invalid" : ""}`} id="parking-event">${eventSection(host, host.settings, { rulesOnly: true })}</div></section>
    <section class="surface stack">${sectionHeading({ icon: "emoji_events", label: t("title", "Parking calculator") })}
      ${field("current", t("current", "Current PT"))}${field("target", t("target", "Target PT"))}
      ${segmented({ label: t("route", "Live type"), value: d.challenge ? "challenge" : "live", options: [
        { value: "live", label: t("solo", "Normal live (solo)") }, { value: "challenge", label: host.t("routeChallenge", "Challenge live"), disabled: !challengeAvailable },
      ], onSelect: value => set(() => { d.challenge = value === "challenge"; }) })}
      ${d.challenge ? challengeCostControl(host, d.consumption, consumption => set(() => { d.consumption = consumption; }), master.challengeBoosts)
        : boostControl(host, d.consumption, consumption => set(() => { d.consumption = consumption; }), master.boosts)}
      <div class=${`stack${d.submitted && errors.some(error => error.field === "song") ? " pt-field--invalid" : ""}`} id="parking-song">
        ${songList(host, d.songId ? [{ songId: d.songId, difficulty: d.difficulty }] : [], chosen => set(() => {
          d.songId = chosen[0]?.songId ?? 0;
          if (chosen[0]) d.difficulty = chosen[0].difficulty;
        }), true, songs.map(song => song.id), "parking-chart-selection", undefined,
          { context: `parking:${d.challenge ? "challenge" : "live"}`, songRules: null, showMissions: false })}
      </div>
      ${specList([{ label: host.t("playJudgements", "Play judgements"), value: host.t("playAp", "All Perfect") }])}
    </section>
    <section class=${`surface stack${teamInvalid ? " pt-field--invalid" : ""}`} aria-invalid=${String(teamInvalid)} id="parking-teams">${sectionHeading({ icon: "group", label: t("teams", "Available teams") })}
      ${cardScopeControl(host, host.settings, patch => host.updateSettings(patch), "manual")}
      ${unknownGrowthControl(host, host.settings.unknownPolicy, unknownPolicy => host.updateSettings({ unknownPolicy }))}
      <div class="cluster">${filterChip({ label: t("currentTeam", "Current manual team"), selected: d.includeManual, onToggle: () => set(() => { d.includeManual = !d.includeManual; }) })}
        ${host.view!.teams.map(team => filterChip({ label: team.name, selected: d.teamIds.has(team.id), onToggle: () => set(() => { if (d.teamIds.has(team.id)) d.teamIds.delete(team.id); else d.teamIds.add(team.id); }) }))}</div>
      <button class="button button--tonal" type="button" @click=${edit}>${t("editTeam", "Edit team")}</button>
      ${candidates.filter(row => manualReady(host, row.team)).map(row => html`<div class="stack"><strong>${row.name}</strong>${formation(row)}</div>`)}
    </section>`;

  const run = async () => {
    if (d.running) { host.cancel(); return; }
    d.submitted = true; d.error = "";
    if (errors.length) { host.requestUpdate(); return; }
    if (already) {
      d.result = parkingPlan(0, []); d.rows = []; d.resultSignature = signature;
      d.resultInput = { current: d.current!, target: d.target!, songId: d.songId, difficulty: d.difficulty, challenge: d.challenge };
      host.closeConditions(); host.requestUpdate(); return;
    }
    if (!host.engine) return;
    const task = host.acquireTask("parking");
    if (!task) return;
    const engine = host.engine, revision = d.revision, jobs = structuredClone(candidates), rows: TeamRow[] = [];
    d.running = true; host.requestUpdate();
    try {
      for (const job of jobs) {
        const cacheKey = JSON.stringify([d.owner, eventId, d.songId, d.difficulty, d.challenge, d.consumption, host.settings.frameRate, host.view!.player, job]);
        const cached = d.evaluations.get(cacheKey);
        if (cached) { rows.push(cached); continue; }
        const row = (await engine.evaluate({ ...job.inputs, player: structuredClone(job.inputs.player!),
          team: { members: job.team.members.map(id => `m${id}`), snaps: job.team.snaps.map(id => id === null ? null : `s${id}`), leader: `m${job.team.members[job.team.leader]}` },
          songs: [{ songId: d.songId, difficulty: d.difficulty }], play: { frameRate: host.settings.frameRate, great: 0, good: 0, bad: 0, miss: 0 },
          challengeEventId: d.challenge ? eventId : null, event: { eventId: eventId!, route: d.challenge ? "challenge" : "live", consumption: d.consumption, rewardRoom: { mode: "solo" } },
        }))[0]!;
        if (!host.ownsTask(task) || revision !== d.revision || signature !== inputKey(host, d)) return;
        const bonus = row.event!.bonusPercent;
        const choices = parkingPlays(master, eventId!, d.songId, d.challenge, d.consumption, Math.round(bonus * 100), Math.floor(row.score.min), Math.floor(row.score.max))
          .filter(play => row.score.orders.some(score => play.scoreMin <= score && score <= play.scoreMax));
        const values = [...new Set(choices.map(play => play.points))], label = [...new Set(choices.map(play => ranks[play.rank]))].join(" / ");
        const stable = !row.unsupported?.length && values.length === 1 && row.event!.points === values[0];
        const option = stable ? { ...choices[0]!, scoreMin: row.score.min, scoreMax: row.score.max, teamKey: job.key, teamName: job.name, rankLabel: label,
          cpGain: Math.min(...choices.map(play => play.cpGain)), cpGainMax: Math.max(...choices.map(play => play.cpGain)) } : null;
        const completed = { ...job, evaluation: row, bonus, lowPoints: values.length ? Math.min(...values) : row.event!.points, highPoints: values.length ? Math.max(...values) : row.event!.points, rankLabel: label, option };
        if (d.evaluations.size >= 64) d.evaluations.delete(d.evaluations.keys().next().value!);
        d.evaluations.set(cacheKey, completed); rows.push(completed);
      }
      const options = rows.flatMap(row => row.option ? [row.option] : []);
      d.rows = rows;
      d.rowsSignature = inputKey(host, d, false);
      d.result = options.length ? parkingPlan(d.target! - d.current!, options) : null;
      d.resultInput = { current: d.current!, target: d.target!, songId: d.songId, difficulty: d.difficulty, challenge: d.challenge };
      d.resultSignature = signature;
      if (!options.length) d.error = t("noStableTeams", "No selected team has stable PT per play");
      host.closeConditions();
    } catch (error) {
      if (host.ownsTask(task) && revision === d.revision && !(error instanceof DOMException && error.name === "AbortError")) d.error = host.errorReason(error);
    } finally {
      d.running = false; host.releaseTask(task); host.requestUpdate();
    }
  };
  const result = (plan: ParkingPlan, title: string) => {
    const input = d.resultInput!; let total = input.current;
    const gainMin = plan.steps.reduce((sum, step) => sum + step.count * step.play.cpGain, 0);
    const gainMax = plan.steps.reduce((sum, step) => sum + step.count * (step.play.cpGainMax ?? step.play.cpGain), 0);
    return html`<section class="surface stack">${sectionHeading({ icon: "emoji_events", label: title })}
      ${specList([
        { label: t("current", "Current PT"), value: format(input.current) }, { label: t("target", "Target PT"), value: format(input.target) },
        { label: t("finish", "Final PT"), value: format(total + plan.points) }, { label: t("difference", "Difference from target"), value: format(total + plan.points - input.target) },
        { label: t("conditions", "Conditions"), value: t(d.resultSignature === signature ? "currentConditions" : "changedConditions", d.resultSignature === signature ? "Current conditions" : "Conditions changed") },
        { label: t("song", "Song"), value: `${host.catalog!.songTitle(input.songId)} / ${host.catalog!.difficultyLabel(input.songId, input.difficulty)}` },
        { label: t("route", "Live type"), value: input.challenge ? host.t("routeChallenge", "Challenge live") : t("solo", "Normal live (solo)") },
        { label: t("plays", "Plays"), value: format(plan.plays) }, { label: t("boostsTotal", "LIVE BOOST required"), value: format(plan.steps.reduce((sum, row) => sum + row.count * row.play.boosts, 0)) },
        { label: t("cpCost", "CP required"), value: format(plan.steps.reduce((sum, row) => sum + row.count * row.play.cpCost, 0)) }, { label: t("cpGain", "CP gained"), value: gainMin === gainMax ? format(gainMin) : `${format(gainMin)} – ${format(gainMax)}` },
      ], { numeric: true })}
      ${plan.steps.length ? html`<ol class="list stack" role="list" aria-label=${title}>${plan.steps.map((step, index) => {
        total += step.count * step.play.points;
        return html`<li class="card card--outlined"><div class="card__body stack">
          <div class="row row--between row--wrap"><strong>${index + 1}. ${step.play.teamName}</strong><span class="chip">${step.play.rankLabel}</span></div>
          ${specList([
            { label: t("perPlay", "PT per play"), value: format(step.play.points) },
            { label: t("plays", "Plays"), value: format(step.count) },
            { label: t("runningTotal", "PT after plays"), value: format(total) },
          ], { numeric: true })}
        </div></li>`;
      })}</ol>` : nothing}
    </section>`;
  };
  const focus = async (field: string) => { host.openConditions(); await host.updateComplete; const target = host.querySelector(`#parking-${field}`); target?.scrollIntoView({ block: "center" }); const control = target?.querySelector<HTMLElement>("md-outlined-text-field, md-outlined-select, button"); if (control && "updateComplete" in control) await control.updateComplete; control?.focus(); };
  const rowsCurrent = d.rowsSignature === inputKey(host, d, false);
  const evaluations = d.rows.map(row => html`<section class="surface stack">${sectionHeading({ icon: "group", label: row.name })}${formation(row)}
    ${specList([
      { label: t("conditions", "Conditions"), value: t(rowsCurrent ? "currentConditions" : "changedConditions", rowsCurrent ? "Current conditions" : "Conditions changed") },
      { label: host.t("power", "Power"), value: format(row.evaluation.power) }, { label: t("normalRange", "Normal-play score range"), value: `${format(row.evaluation.score.min)} – ${format(row.evaluation.score.max)}` },
      { label: t("rank", "Score rank"), value: row.rankLabel }, { label: t("bonus", "Event PT bonus (%)"), value: `${format(row.bonus)}%` },
      { label: t("perPlay", "PT per play"), value: row.lowPoints === row.highPoints ? format(row.lowPoints) : `${format(row.lowPoints)} – ${format(row.highPoints)}` },
      { label: t("payout", "PT payout"), value: row.evaluation.unsupported?.length ? t("unsupportedTeam", "Unsupported skill") : t(row.option ? "stable" : "variable", row.option ? "All skill orders agree" : "Varies with skill order") },
    ], { numeric: true })}
  </section>`);
  const output = d.submitted && errors.length ? html`<section class="surface stack" role="alert">${errors.map(error => html`<a href=${`#parking-${error.field}`} @click=${(e: Event) => { e.preventDefault(); void focus(error.field); }}>${error.message}</a>`)}</section>`
    : html`${d.error ? html`<section class="surface" role="alert">${d.error}</section>` : nothing}
      ${d.result ? d.result.exact ? result(d.result.exact, t("exact", "Exact target")) : html`<section class="surface">${sectionHeading({ icon: "emoji_events", label: t("notExact", "Selected teams cannot reach this exact target") })}</section>${result(d.result.below, t("below", "Closest below target"))}${d.result.above ? result(d.result.above, t("above", "Closest above target")) : nothing}`
        : !d.rows.length ? html`<section class="surface">${emptyState({ title: t("normalEmpty", "No parking plan"), icon: "emoji_events" })}</section>` : nothing}
      ${evaluations}`;
  return toolLayout(host, body, html`<button class="button button--filled" type="button" @click=${() => void run()}>${d.running ? host.common("common.actions.cancel", "Cancel") : t("calculate", "Calculate parking")}</button>`, output,
    { summary: t("title", "Parking calculator"), validate: false });
}
