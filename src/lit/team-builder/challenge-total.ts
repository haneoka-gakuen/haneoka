// L3 — GEB
// Input: Event rules, regional leaderboard metadata, selected difficulties and the current engine request.
// Output: Search progress and best qualifying chart per event song, or one shared team's mean scores.
// Pos: [Map](../L2-2.md); totals within the challenge ranking task.
// Effects/Dependencies: Reads the regional archive; runs the normal Worker and saves device checkpoints.
import { html, nothing } from "lit";
import type { TeamBuilder } from "../team-builder";
import { releaseSongTotal } from "../../lib/event-challenge-route";
import type { TrackedEventDto } from "../../lib/game-records";
import { gameAccountRegion } from "../shared/game-records";
import { songPickerDifficultyFilters } from "../ui/song-picker-filters";
import { fetchJson } from "../shared/catalog";
import type { EngineResponse, SongRef } from "../../lib/team-builder/engine/api";
import { clock, singleSongRequest } from "../../lib/team-builder/engine/execution";
import { countChart, countChallengeSongs, loadChallengeTotal, saveChallengeTotal,
  type ChallengeTotalResult } from "../../lib/team-builder/challenge-total";
import { choiceField, sectionHeading } from "./catalog";
import { cardScopeLabel } from "./card-input-controls";
import { stoppedSearchLabel } from "./score-goal";
import { saveTeam, teamFormation } from "./results";
import { cardIdOf } from "../../lib/team-builder/sync/box-view";

const difficultyNames = ["EASY", "NORMAL", "HARD", "EXPERT", "SPECIAL"];

export class ChallengeTotal {
  private archives = new Map<string, TrackedEventDto[]>();
  private releaseFlags = new Map<string, boolean | undefined>();
  private scope = "";
  private restoring?: Promise<void>;
  private runOwner?: { token: symbol; context: string; scope: string; cardScope: string; engine: NonNullable<TeamBuilder["engine"]> };
  private record?: ChallengeTotalResult;
  get result() { return this.scope === this.key() ? this.record : undefined; }
  storageError = false;
  constructor(private readonly host: TeamBuilder) {}

  get region() {
    return this.host.challenge.region ?? gameAccountRegion(this.host.server, this.host.locale, this.host.gameAccount?.uid);
  }
  rankedEvent(event: number) {
    return this.archives.get(this.region)?.find(row => Number(row.id) === event);
  }
  enabled(event: number | null) {
    if (event === null) return false;
    const flag = this.host.data?.events[String(event)]?.totalMusicRankingEnabled;
    return this.rankedEvent(event)?.totalRankingEnabled ??
      releaseSongTotal(this.host.server, event, flag) ?? this.releaseFlags.get(this.releaseKey(event));
  }
  private releaseKey(event: number) {
    return JSON.stringify([this.host.data?.identity, event]);
  }
  get selected() {
    return this.host.settings.challengeTotal === true && this.enabled(this.host.settings.eventId) === true;
  }
  get shared() { return this.host.settings.challengeShared === true; }
  get difficulties() { return this.host.settings.challengeDifficulties ?? this.host.songDifficulties; }
  pool(event: number | null) {
    if (event === null) return [];
    const tracks = this.host.catalog!.challengeSongs(event);
    const ids = new Set(tracks.map(track => track.liveMusicId));
    for (const track of this.rankedEvent(event)?.challenges ?? []) ids.add(Number(track.musicId));
    return [...ids].map(id => {
      // A regional entry alone cannot establish the release-specific scoring rules for a chart.
      const source = this.host.data?.crossServer?.owners.songs?.[String(id)] ?? this.host.data?.identity.server;
      const rows = source === this.host.server && tracks.some(track => track.liveMusicId === id) && this.host.catalog!.songVisible(id)
        ? this.host.catalog!.difficultyRows(id) : [];
      return { id, available: rows.map(row => Number(row.difficulty)) };
    });
  }
  charts(event: number | null): SongRef[] {
    return this.pool(event).flatMap(song => song.available.filter(d => this.difficulties.includes(d))
      .map(difficulty => ({ songId: song.id, difficulty })));
  }

  private key() {
    const h = this.host;
    return h.tab === "challenge" && h.snapshot && this.selected
      ? JSON.stringify([h.server, h.snapshot.owner, h.gameAccount?.id, h.data?.identity.releaseId,
        this.region, h.settings.eventId, this.shared]) : "";
  }
  private context() {
    return JSON.stringify([this.host.calculationContext(), this.pool(this.host.settings.eventId), this.difficulties]);
  }
  get stale() {
    const result = this.result;
    return !!result && (result.context !== this.context() ||
      !!result.conditions && result.conditions.scope !== this.host.searchSettings.scope);
  }

  sync() {
    const h = this.host;
    if (h.tab === "challenge" && h.snapshot && h.data) {
      const region = this.region;
      if (!this.archives.has(region)) {
        this.archives.set(region, []);
        void fetchJson<{ events: TrackedEventDto[] }>(`/api/v1/game/records/${region}/events/archive`)
          .then(({ events }) => {
            this.archives.set(region, events);
            if (h.isConnected && h.tab === "challenge" && this.region === region) h.challenge.applyRoute();
          })
          .catch(() => { /* A release's board rules also apply before a regional record is captured. */ });
      }
      const event = h.settings.eventId;
      if (event !== null && this.enabled(event) === undefined && !this.releaseFlags.has(this.releaseKey(event))) {
        const key = this.releaseKey(event), identity = h.data.identity;
        this.releaseFlags.set(key, undefined);
        void fetch(`/api/v1/servers/${h.server}/events/${event}?release=${encodeURIComponent(identity.releaseId)}`)
          .then(async response => {
            if (!response.ok || response.headers.get("x-haneoka-release-id") !== identity.releaseId ||
              response.headers.get("x-haneoka-source-id") !== identity.sourceId) return;
            const row = await response.json() as { totalMusicRankingEnabled?: boolean };
            if (typeof row.totalMusicRankingEnabled === "boolean") {
              this.releaseFlags.set(key, row.totalMusicRankingEnabled);
              h.requestUpdate();
            }
          }).catch(() => {});
      }
    }
    const key = this.key();
    if (key !== this.scope) {
      this.stop();
      this.scope = key;
      this.record = undefined;
      this.storageError = false;
      const restoring = key ? loadChallengeTotal(key).then(saved => {
        if (this.restoring === restoring) this.record = saved;
      }).catch(() => { if (this.restoring === restoring) this.storageError = true; }).finally(() => h.requestUpdate()) : undefined;
      this.restoring = restoring;
      h.requestUpdate();
    } else if (this.runOwner && (this.runOwner.context !== this.context() || this.runOwner.cardScope !== h.searchSettings.scope)) this.stop();
  }

  get resumable() {
    return !!this.result && !this.stale && this.result.songs.some(song => song.charts.some(row => !row.proven));
  }
  get budgetSeconds() {
    const saved = this.result?.budgetSeconds;
    return !this.stale && saved !== undefined ? saved : this.host.searchSettings.timeLimit;
  }
  get runningProgress() {
    if (!this.runOwner || this.stale) return null;
    const charts = this.result?.songs.flatMap(song => song.charts) ?? [];
    return charts.length ? { done: charts.filter(row => row.proven).length, total: charts.length } : null;
  }
  dispose() {
    this.stop();
    this.scope = "";
    this.record = undefined;
    this.restoring = undefined;
  }
  stop() {
    const owner = this.runOwner;
    if (!owner) return;
    this.runOwner = undefined;
    if (this.record?.context === owner.context) {
      this.record.stopped = true;
      this.record.stopReason = "cancelled";
      void this.save(owner.scope, this.record);
    }
    if (this.host.ownsTask(owner.token)) {
      owner.engine.cancel();
      this.host.releaseTask(owner.token);
    }
  }

  private async save(scope: string, record: ChallengeTotalResult) {
    try { await saveChallengeTotal(scope, record); }
    catch {
      if (this.scope === scope && this.record === record) {
        this.storageError = true;
        this.host.requestUpdate();
      }
    }
  }

  async run(mode: boolean | "extend" = false) {
    const h = this.host, engine = h.engine, request = h.request();
    if (!engine || request?.goal.kind !== "score" || !this.selected) return;
    const token = h.acquireTask("challenge-total");
    if (!token) return;
    const goal = request.goal, scope = this.key(), context = this.context(), shared = this.shared;
    const owner = this.runOwner = { token, context, scope, engine, cardScope: h.searchSettings.scope };
    const active = () => this.runOwner === owner && h.ownsTask(token) && h.engine === engine &&
      this.key() === scope && h.searchSettings.scope === owner.cardScope && this.context() === context;
    try {
      await this.restoring;
      if (!active()) return;
      const continuing = this.resumable;
      const result: ChallengeTotalResult = this.record = continuing ? this.result! : {
        context, shared, sharedKey: null,
        songs: this.pool(h.settings.eventId).map(song => ({ id: song.id,
          charts: goal.songs.filter(row => row.songId === song.id).map(row => ({ ...row, proven: false })) })),
      };
      const settings = h.searchSettings;
      const conditions = result.conditions ??= {
        scope: settings.scope, maxAccountBonuses: settings.maxAccountBonuses, difficulties: [...this.difficulties],
        playMode: settings.playMode, unknownPolicy: request.unknownPolicy, cards: {},
      };
      const inputs = new Map([...request.members, ...request.snaps].map(row => [row.key, row]));
      result.stopped = false;
      delete result.stopReason;
      if (mode === false || result.budgetSeconds === undefined)
        result.budgetSeconds = request.timeLimitMs === null ? null : request.timeLimitMs / 1000;
      h.calculationSubmitted();
      const deadline = mode === true || result.budgetSeconds === null ? Infinity : clock() + result.budgetSeconds * 1000;
      const charts = result.songs.flatMap(song => song.charts);
      const groups = shared ? [charts] : charts.filter(row => !row.proven).map(chart => [chart]);
      for (const group of groups) {
        if (!active() || !group.length || group.every(chart => chart.proven) || clock() >= deadline) break;
        const first = group[0]!;
        let savedKey = first.seed?.key ?? -Infinity;
        let groupOpen = true;
        const accept = (response: EngineResponse) => {
          if (!groupOpen || !active()) return;
          const part = response.results[0], hit = part?.hits[0];
          if (!part) return;
          if (shared && hit && result.sharedKey !== null && hit.key < result.sharedKey) return;
          if (shared && hit) result.sharedKey = hit.key;
          if (part.proven) delete first.seed;
          else if (hit && hit.key >= savedKey) first.seed = hit;
          const scores = shared && group.length > 1 ? hit?.aggregate?.songs ?? [] : hit ? [hit] : [];
          for (const chart of group) {
            const score = scores.find(row => row.song?.songId === chart.songId && row.song.difficulty === chart.difficulty);
            if (score) for (const key of [...score.members, ...score.snaps]) {
              if (key) conditions.cards[key] = inputs.get(key)!;
            }
            countChart(chart, score, part.proven, shared);
            chart.error = response.error;
          }
          if (hit && hit.key > savedKey) {
            savedKey = hit.key;
            void this.save(scope, result);
          }
          h.requestUpdate();
        };
        try {
          const response = await engine.run(singleSongRequest({ ...request, deadline, k: 1, seeds: first.seed ? [first.seed] : [],
            goal: { ...goal, songs: group.map(({ songId, difficulty }) => ({ songId, difficulty })) } }),
            undefined, snapshot => accept(snapshot.response));
          accept(response);
          if (active() && response.stopReason === "budget") result.stopReason = "budget";
        } catch (error) {
          if (active()) for (const chart of group) chart.error = h.errorReason(error);
        }
        groupOpen = false;
        if (!active()) break;
        await this.save(scope, result);
        h.requestUpdate();
      }
      if (active() && result.songs.some(song => song.charts.some(chart => !chart.proven)) &&
        (result.stopReason === "budget" || clock() >= deadline)) {
        result.stopped = true;
        result.stopReason = "budget";
        await this.save(scope, result);
      }
    } finally {
      if (this.runOwner === owner) this.runOwner = undefined;
      h.releaseTask(token);
    }
  }
}

export function totalControls(host: TeamBuilder) {
  const { total } = host.challenge;
  const levels = [...new Set(total.pool(host.settings.eventId).flatMap(row => row.available))].sort((a,b) => a-b);
  return html`
    <div class="stack stack--tight"><span class="tb-field__label">${host.t("difficulty", "Difficulty")}</span>
      ${songPickerDifficultyFilters({ label: host.t("difficulty", "Difficulty"),
        choices: levels.map(value => ({ value, label: difficultyNames[value]! })),
        selected: total.difficulties, change: values => host.updateSettings({ challengeDifficulties: values.sort((a, b) => a - b) }),
        allLabel: host.t("allChartDifficulties", "All difficulties") })}
    </div>
    ${choiceField({type:"select", label:host.t("challenge.teamMode", "Team selection"),
      value:total.shared ? "shared" : "individual", options:[
        {value:"individual", label:host.t("challenge.individual","Best single play per song")},
        {value:"shared", label:host.t("challenge.shared","One team · highest mean across selected charts")}],
      onSelect:value => host.updateSettings({challengeShared: value === "shared"})})}`;
}

export function totalResults(host: TeamBuilder) {
  const { total } = host.challenge;
  const pool = total.pool(host.settings.eventId);
  const state: ChallengeTotalResult = total.result ?? { context: "", shared: total.shared, sharedKey: null,
    songs: pool.map(song => ({ id: song.id, charts: total.charts(host.settings.eventId)
      .filter(chart => chart.songId === song.id).map(chart => ({ ...chart, proven: false })) })) };
  const counted = countChallengeSongs(state);
  const stale = total.stale;
  const fmt = (score: number) => new Intl.NumberFormat(host.locale, { maximumFractionDigits: 2 }).format(score);
  const complete = host.t("challenge.verified", "Verified for the selected search");
  const candidate = host.t("challenge.candidate", "Candidate");
  const t = (k: string, label: string) => host.t("challenge." + k, label);
  const original = state.conditions;
  const growth = (kind: "members" | "snaps", key: string) => {
    const input = original?.cards[key];
    return original && input ? host.catalog!.resolvedGrowth(kind, input, original.unknownPolicy) : null;
  };
  return html`<section class="surface stack" data-challenge-total-results>
    ${sectionHeading({ icon:"emoji_events", label:t("estimated","Estimated song total") })}
    <div class="cluster">
      <strong>${counted.covered === counted.songs.length && counted.covered ? t("current","Current total") : t("subtotal","Subtotal")}
        · ${fmt(counted.total)}</strong>
      <span>${host.t("challenge.covered","{done}/{total} songs with a score",{ done:counted.covered,total:counted.songs.length })}</span>
      ${total.result?.stopped && !stale && !counted.complete ? html`<span>${state.stopReason
        ? stoppedSearchLabel(host, state.stopReason, counted.covered > 0) : t("paused", "Paused")}</span>` : nothing}
      ${stale ? html`<span>${host.t("recomputeNeeded","Recalculation needed")}</span>` : counted.complete ? html`<span>${host.t("search.optimal", "Optimal within the selected search")}</span>` : nothing}
    </div>
    ${stale && original ? html`<span>${[
      cardScopeLabel(host, original), original.difficulties.map(d => difficultyNames[d]).join(" / "),
      original.playMode === "ap" ? host.t("playAp", "All Perfect") : host.t("playCustom", "Custom"),
    ].join(" · ")}</span>` : nothing}
    ${state.shared ? html`<span>${t("shared","One team · highest mean across selected charts")}${state.sharedKey !== null ? " · " + fmt(state.sharedKey) : ""}</span>` : nothing}
    ${counted.songs.map(song => {
      const best = song.best, value = best?.candidate;
      const status = stale ? host.t("recomputeNeeded", "Recalculation needed") : !song.charts.length ? t("missing","No selected chart available")
        : song.charts.some(row => row.error) ? t("failed","Chart search failed")
        : song.complete ? value ? complete : t("empty","No eligible team")
        : value ? candidate : host.t("challenge.pending","Pending");
      return html`<section class="stack stack--tight" data-song-id=${song.id}>
        <h3>${host.catalog!.songTitle(song.id) || "#" + song.id}</h3>
        <div class="cluster">${best ? html`<span>${host.catalog!.difficultyLabel(song.id, best.difficulty)}</span><strong>${fmt(value!.score)}</strong>` : nothing}
          <span>${status}</span>
          <span>${host.t("provenChartProgress","Charts proven {done}/{total}",{done:song.proven,total:song.charts.length})}</span>
        </div>
        ${value ? teamFormation(host, value.members.map((member,index) => {
          const snap = value.snaps[index];
          return { member: cardIdOf(member), memberGrowth: growth("members", member),
            snap: snap ? cardIdOf(snap) : null, snapGrowth: snap ? growth("snaps", snap) : null };
        }), 0, false) : nothing}
        ${best && value ? html`<div class="cluster"><button type="button" class="button button--tonal" data-tb-save-team
          ?disabled=${stale} @click=${() => saveTeam(host, value.members.map(cardIdOf),
            value.snaps.map(snap => snap ? cardIdOf(snap) : null), { songId: best.songId, difficulty: best.difficulty })}>
          ${host.t("saveTeam", "Save team")}</button></div>` : nothing}
      </section>`;
    })}
    ${total.storageError ? html`<span role="status">${host.t("pt.storageError","Progress could not be saved on this device")}</span>` : nothing}
  </section>`;
}
